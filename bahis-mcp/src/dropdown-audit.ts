import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import type { Element as XmlElement, Node as XmlNode } from '@xmldom/xmldom';
import { loadConfig } from './config.js';
import { PATIENT_REGISTRY_FORM_UID } from './constants.js';

/**
 * The audit intentionally contains no form values.  It is limited to enough
 * metadata to identify and remediate records outside this tool.
 */
export interface DropdownAuditRow {
    batchId: string;
    recordIndex: number;
    uuid: string;
    status: string;
    invalidField: 'union';
}

interface JournalRow {
    batch_id: string;
    record_index: number;
    uuid: string;
    status: string;
}

interface SubmissionRow {
    xml: string;
}

interface UserRow {
    upazila: number;
}

function childElement(element: XmlElement, name: string): XmlElement | undefined {
    return Array.from(element.childNodes).find(
        (child): child is XmlElement => child.nodeType === 1 && (child.localName || child.nodeName) === name,
    );
}

function valueAt(xml: string, segments: string[]): string {
    const errors: string[] = [];
    const document = new DOMParser({
        onError: (level, message) => {
            if (level !== 'warning') errors.push(message);
        },
    }).parseFromString(xml, 'application/xml');
    if (errors.length > 0 || !document.documentElement) throw new Error('Unable to parse a stored submission XML document.');

    let current = document.documentElement;
    if ((current.localName || current.nodeName) === 'root') {
        const results = childElement(current, 'results');
        const submission = results
            ? Array.from(results.childNodes).find((child: XmlNode): child is XmlElement => child.nodeType === 1)
            : undefined;
        if (!submission) throw new Error('Stored submission XML does not include a result document.');
        current = submission;
    }
    for (const segment of segments) {
        const next = childElement(current, segment);
        if (!next) throw new Error(`Stored submission XML is missing ${segments.join('/')}.`);
        current = next;
    }
    return (current.textContent ?? '').trim();
}

function csvCell(value: string | number): string {
    return `"${String(value).replaceAll('"', '""')}"`;
}

function csv(rows: DropdownAuditRow[]): string {
    const header = 'batch_id,record_index,uuid,status,invalid_field';
    const body = rows.map((row) =>
        [row.batchId, row.recordIndex, row.uuid, row.status, row.invalidField].map(csvCell).join(','),
    );
    return `${[header, ...body].join('\n')}\n`;
}

/**
 * Opens both BAHIS databases in SQLite read-only mode and reports MCP journal
 * records whose stored union value is not a numeric Union ID for the current
 * signed-in upazila.  No database tables or submissions are changed.
 */
export function collectInvalidUnionAudit(dbPath: string, journalPath: string): DropdownAuditRow[] {
    const bahis = new Database(dbPath, { readonly: true, fileMustExist: true });
    const journal = new Database(journalPath, { readonly: true, fileMustExist: true });
    try {
        const user = bahis.prepare('SELECT upazila FROM users LIMIT 1').get() as UserRow | undefined;
        if (!user?.upazila) throw new Error('No signed-in BAHIS user with an assigned upazila was found.');

        const records = journal
            .prepare('SELECT batch_id, record_index, uuid, status FROM batch_record ORDER BY batch_id, record_index')
            .all() as JournalRow[];
        const submission = bahis.prepare(
            'SELECT xml FROM formcloudsubmission WHERE uuid = ? AND form_uid = ? LIMIT 1',
        );
        const validUnion = bahis.prepare(
            `SELECT 1 FROM administrativeregion
             WHERE id = ? AND parent_administrative_region = ? AND administrative_region_level = 4
             LIMIT 1`,
        );

        const audit: DropdownAuditRow[] = [];
        for (const record of records) {
            const normalizedUuid = record.uuid.replace(/^uuid:/, '');
            const stored = submission.get(`uuid:${normalizedUuid}`, PATIENT_REGISTRY_FORM_UID) as SubmissionRow | undefined;
            if (!stored) continue;

            const unionValue = valueAt(stored.xml, ['basic_info', 'union']);
            const isNumericId = /^\d+$/.test(unionValue);
            const exists = isNumericId && Boolean(validUnion.get(unionValue, user.upazila));
            if (!exists) {
                audit.push({
                    batchId: record.batch_id,
                    recordIndex: record.record_index,
                    uuid: normalizedUuid,
                    status: record.status,
                    invalidField: 'union',
                });
            }
        }
        return audit;
    } finally {
        journal.close();
        bahis.close();
    }
}

export function writeDropdownAudit(outputPath: string, rows: DropdownAuditRow[]): void {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, csv(rows), { encoding: 'utf8', mode: 0o600 });
}

function option(arguments_: string[], name: string): string | undefined {
    const index = arguments_.indexOf(name);
    return index === -1 ? undefined : arguments_[index + 1];
}

function usage(): string {
    return 'Usage: tsx src/dropdown-audit.ts --output <csv-path> [--db <bahis3.db>] [--journal <bahis-mcp.db>]';
}

function main(): void {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        process.stdout.write(`${usage()}\n`);
        return;
    }
    const config = loadConfig();
    const output = option(args, '--output');
    if (!output) throw new Error(`${usage()}\n--output is required to prevent writing an audit to an unintended location.`);
    const dbPath = path.resolve(option(args, '--db') ?? config.dbPath);
    const journalPath = path.resolve(option(args, '--journal') ?? config.journalPath);
    const outputPath = path.resolve(output);
    const rows = collectInvalidUnionAudit(dbPath, journalPath);
    writeDropdownAudit(outputPath, rows);
    process.stdout.write(`Wrote ${rows.length} invalid dropdown audit rows to ${outputPath}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
