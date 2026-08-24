import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { PATIENT_REGISTRY_FORM_UID } from './constants.js';
import type {
    JournalRecord,
    LocationChoice,
    PreparedRecord,
    RecordStatus,
    RegionContext,
    ResolvedLocation,
    SampleOrder,
} from './types.js';

export interface BatchSummary {
    id: string;
    status: string;
    created_at: string;
    updated_at: string;
    records: number;
    verified: number;
    failed: number;
}

interface UserRow {
    token: string;
    upazila: number;
}

interface RegionRow {
    id: number;
    title: string;
    parent_administrative_region: number | null;
    administrative_region_level: number;
}

export class BahisDatabase {
    readonly path: string;
    private readonly db: Database.Database;

    constructor(databasePath: string, readonly = false) {
        this.path = databasePath;
        this.db = new Database(databasePath, { readonly, fileMustExist: true, timeout: 5_000 });
        this.db.pragma('busy_timeout = 5000');
    }

    close(): void {
        this.db.close();
    }

    getToken(): string | undefined {
        return (this.db.prepare('SELECT token FROM users LIMIT 1').get() as { token?: string } | undefined)?.token;
    }

    /**
     * Refresh the signed-in user row after a CLI login.
     *
     * Column order mirrors the desktop app's createUserInLocalDatabase (electron/localDB.ts) so a
     * row written here is indistinguishable from one the app wrote. The table is keyed by username,
     * so signing in as a different user replaces the row rather than adding a second one - the app
     * assumes a single user (`SELECT ... FROM users LIMIT 1`) throughout.
     */
    upsertUser(user: { username: string; password: string; name: string | null; token: string; upazila: number }): void {
        this.db.transaction(() => {
            this.db.prepare('DELETE FROM users WHERE username <> ?').run(user.username);
            this.db
                .prepare(
                    `INSERT INTO users (username, password, name, token, upazila, last_login)
                     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                     ON CONFLICT(username) DO UPDATE SET
                        password = excluded.password,
                        name = excluded.name,
                        token = excluded.token,
                        upazila = excluded.upazila,
                        last_login = CURRENT_TIMESTAMP`,
                )
                .run(user.username, user.password, user.name, user.token, user.upazila);
        })();
    }

    getUserRegion(): RegionContext {
        const user = this.db.prepare('SELECT token, upazila FROM users LIMIT 1').get() as UserRow | undefined;
        if (!user?.upazila) throw new Error('No signed-in BAHIS user with an assigned upazila was found.');

        const getRegion = this.db.prepare(
            'SELECT id, title, parent_administrative_region, administrative_region_level FROM administrativeregion WHERE id = ?',
        );
        const regions = new Map<number, RegionRow>();
        const visited = new Set<number>();
        let current = getRegion.get(user.upazila) as RegionRow | undefined;
        while (current) {
            if (visited.has(current.id)) break;
            visited.add(current.id);
            regions.set(current.administrative_region_level, current);
            if (!current.parent_administrative_region) break;
            current = getRegion.get(current.parent_administrative_region) as RegionRow | undefined;
        }
        const division = regions.get(1);
        const district = regions.get(2);
        const upazila = regions.get(3);
        if (!division || !district || !upazila) throw new Error('The signed-in user administrative-region chain is incomplete.');
        return {
            division: { id: division.id, title: division.title },
            district: { id: district.id, title: district.title },
            upazila: { id: upazila.id, title: upazila.title },
        };
    }

    getLocations(): LocationChoice[] {
        const region = this.getUserRegion();
        const unions = this.db
            .prepare(
                `SELECT id, title FROM administrativeregion
                 WHERE parent_administrative_region = ? AND administrative_region_level = 4
                 ORDER BY title`,
            )
            .all(region.upazila.id) as Array<{ id: number; title: string }>;
        const villagesStatement = this.db.prepare(
            `SELECT id, title FROM administrativeregion
             WHERE parent_administrative_region = ? AND administrative_region_level = 5
             ORDER BY title`,
        );
        return unions.map((union) => ({
            id: String(union.id),
            label: union.title,
            villages: (villagesStatement.all(union.id) as Array<{ id: number; title: string }>).map((village) => ({
                id: String(village.id),
                label: village.title,
            })),
        }));
    }

    resolveLocation(unionId: string, villageId: string): ResolvedLocation {
        const region = this.getUserRegion();
        const union = this.db
            .prepare(
                `SELECT id, title FROM administrativeregion
                 WHERE id = ? AND parent_administrative_region = ? AND administrative_region_level = 4`,
            )
            .get(unionId, region.upazila.id) as { id: number; title: string } | undefined;
        if (!union) throw new Error(`Union ${unionId} is not valid for ${region.upazila.title}.`);
        const village = this.db
            .prepare(
                `SELECT id, title FROM administrativeregion
                 WHERE id = ? AND parent_administrative_region = ? AND administrative_region_level = 5`,
            )
            .get(villageId, union.id) as { id: number; title: string } | undefined;
        if (!village) throw new Error(`Village ${villageId} is not valid for union ${union.title}.`);
        return {
            union: { id: String(union.id), label: union.title },
            village: { id: String(village.id), label: village.title },
        };
    }

    getFormXml(): string {
        const row = this.db.prepare('SELECT xml FROM form WHERE uid = ?').get(PATIENT_REGISTRY_FORM_UID) as
            | { xml: string }
            | undefined;
        if (!row?.xml) throw new Error('The Patient Registry form is missing. Open BAHIS and run Update Modules.');
        return row.xml;
    }

    getTaxonomyPath(slug: string): string {
        const row = this.db.prepare('SELECT csv_file FROM taxonomy WHERE slug = ?').get(slug) as
            | { csv_file: string }
            | undefined;
        if (!row?.csv_file) throw new Error(`Required taxonomy ${slug} is missing. Open BAHIS and run Update Modules.`);
        const appDirectory = path.dirname(this.path);
        const resolved = path.resolve(appDirectory, row.csv_file);
        if (resolved !== appDirectory && !resolved.startsWith(`${appDirectory}${path.sep}`)) {
            throw new Error(`Taxonomy ${slug} resolves outside the BAHIS data directory.`);
        }
        if (!fs.existsSync(resolved)) throw new Error(`Taxonomy file for ${slug} was not found.`);
        return resolved;
    }

    pendingDraftCount(): number {
        const row = this.db.prepare('SELECT COUNT(*) AS count FROM formlocaldraft').get() as { count: number };
        return row.count;
    }

    /**
     * Read Patient Registry submissions from one end of the history.
     *
     * `newest` orders by sync time, which is what the local list shows. `oldest` orders by the
     * visit date carried inside the XML instead: `created_at` is the local sync timestamp and
     * disagrees with the visit date often enough to reorder the tail of the history. The oldest
     * end has no LIMIT because the usable-record filter lives in summary.ts, and the oldest
     * several hundred rows are unusable there (empty tentative_diagnosis) — limiting here would
     * starve the window.
     */
    getRecentPatientSubmissionXml(limit: number, order: SampleOrder = 'newest'): string[] {
        const statement =
            order === 'oldest'
                ? this.db.prepare(
                      `SELECT xml FROM formcloudsubmission
                       WHERE form_uid = ?
                       ORDER BY substr(xml, instr(xml, '<date>') + 6, 10) ASC, rowid ASC`,
                  )
                : this.db.prepare(
                      `SELECT xml FROM formcloudsubmission
                       WHERE form_uid = ?
                       ORDER BY created_at DESC, rowid DESC
                       LIMIT ?`,
                  );
        const rows = (
            order === 'oldest'
                ? statement.all(PATIENT_REGISTRY_FORM_UID)
                : statement.all(PATIENT_REGISTRY_FORM_UID, limit)
        ) as Array<{ xml: string }>;
        return rows.map((row) => row.xml);
    }

    stageRecords(records: PreparedRecord[]): void {
        const statement = this.db.prepare(
            `INSERT INTO formlocaldraft (uuid, form_uid, xml)
             VALUES (?, ?, ?)
             ON CONFLICT(uuid) DO UPDATE SET form_uid = excluded.form_uid, xml = excluded.xml`,
        );
        this.db.transaction(() => {
            for (const record of records) statement.run(`uuid:${record.uuid}`, PATIENT_REGISTRY_FORM_UID, record.xml);
        })();
    }

    getDraftXml(uuid: string): string | undefined {
        const row = this.db.prepare('SELECT xml FROM formlocaldraft WHERE uuid = ?').get(`uuid:${uuid}`) as
            | { xml: string }
            | undefined;
        return row?.xml;
    }

    completeRecord(uuid: string, canonicalServerXml: string): void {
        const upsert = this.db.prepare(
            `INSERT INTO formcloudsubmission (uuid, form_uid, xml)
             VALUES (?, ?, ?)
             ON CONFLICT(uuid) DO UPDATE SET form_uid = excluded.form_uid, xml = excluded.xml`,
        );
        const deleteDraft = this.db.prepare('DELETE FROM formlocaldraft WHERE uuid = ?');
        this.db.transaction(() => {
            upsert.run(`uuid:${uuid}`, PATIENT_REGISTRY_FORM_UID, canonicalServerXml);
            deleteDraft.run(`uuid:${uuid}`);
        })();
    }
}

export class JournalDatabase {
    private readonly db: Database.Database;

    constructor(journalPath: string) {
        fs.mkdirSync(path.dirname(journalPath), { recursive: true });
        this.db = new Database(journalPath, { timeout: 5_000 });
        this.db.pragma('busy_timeout = 5000');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS batch (
                id TEXT PRIMARY KEY,
                request_hash TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS batch_record (
                batch_id TEXT NOT NULL,
                record_index INTEGER NOT NULL,
                uuid TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL,
                field_hashes_json TEXT NOT NULL,
                mismatch_fields_json TEXT NOT NULL DEFAULT '[]',
                error TEXT,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (batch_id, record_index),
                FOREIGN KEY (batch_id) REFERENCES batch(id)
            );
        `);
    }

    close(): void {
        this.db.close();
    }

    ensureBatch(batchId: string, requestHash: string, records: PreparedRecord[]): void {
        const existing = this.db.prepare('SELECT request_hash FROM batch WHERE id = ?').get(batchId) as
            | { request_hash: string }
            | undefined;
        if (existing && existing.request_hash !== requestHash) {
            throw new Error(`requestId ${batchId} was already used with different record data.`);
        }
        const insertBatch = this.db.prepare(
            `INSERT INTO batch (id, request_hash, status) VALUES (?, ?, 'draft')
             ON CONFLICT(id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
        );
        const insertRecord = this.db.prepare(
            `INSERT INTO batch_record (batch_id, record_index, uuid, status, field_hashes_json)
             VALUES (?, ?, ?, 'draft', ?)
             ON CONFLICT(batch_id, record_index) DO NOTHING`,
        );
        this.db.transaction(() => {
            insertBatch.run(batchId, requestHash);
            for (const record of records) {
                insertRecord.run(batchId, record.index, record.uuid, JSON.stringify(record.fieldHashes));
            }
        })();
    }

    listBatches(limit = 20): BatchSummary[] {
        return this.db
            .prepare(
                `SELECT b.id, b.status, b.created_at, b.updated_at,
                        COUNT(r.record_index) AS records,
                        SUM(CASE WHEN r.status = 'verified' THEN 1 ELSE 0 END) AS verified,
                        SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed
                 FROM batch b LEFT JOIN batch_record r ON r.batch_id = b.id
                 GROUP BY b.id ORDER BY b.created_at DESC LIMIT ?`,
            )
            .all(limit) as BatchSummary[];
    }

    getBatch(batchId: string): JournalRecord[] {
        const rows = this.db
            .prepare(
                `SELECT batch_id, record_index, uuid, status, field_hashes_json, mismatch_fields_json, error
                 FROM batch_record WHERE batch_id = ? ORDER BY record_index`,
            )
            .all(batchId) as Array<{
            batch_id: string;
            record_index: number;
            uuid: string;
            status: RecordStatus;
            field_hashes_json: string;
            mismatch_fields_json: string;
            error: string | null;
        }>;
        if (rows.length === 0) throw new Error(`Unknown batchId ${batchId}.`);
        return rows.map((row) => ({
            batchId: row.batch_id,
            recordIndex: row.record_index,
            uuid: row.uuid,
            status: row.status,
            fieldHashes: JSON.parse(row.field_hashes_json) as Record<string, string>,
            mismatchFields: JSON.parse(row.mismatch_fields_json) as string[],
            error: row.error ?? undefined,
        }));
    }

    updateRecord(batchId: string, index: number, status: RecordStatus, mismatchFields: string[] = [], error?: string): void {
        const update = this.db
            .prepare(
                `UPDATE batch_record
                 SET status = ?, mismatch_fields_json = ?, error = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE batch_id = ? AND record_index = ?`,
            )
            .run(status, JSON.stringify(mismatchFields), error ?? null, batchId, index);
        if (update.changes !== 1) throw new Error(`Unknown batch record ${batchId}:${index}.`);
        const aggregate = this.db
            .prepare(
                `SELECT COUNT(*) AS total,
                        SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified,
                        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
                 FROM batch_record WHERE batch_id = ?`,
            )
            .get(batchId) as { total: number; verified: number; failed: number };
        const batchStatus =
            aggregate.verified === aggregate.total
                ? 'verified'
                : aggregate.failed === aggregate.total
                  ? 'failed'
                  : aggregate.failed > 0
                    ? 'partial'
                    : 'processing';
        this.db.prepare('UPDATE batch SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(batchStatus, batchId);
    }
}
