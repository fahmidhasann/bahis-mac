import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { collectInvalidUnionAudit, writeDropdownAudit } from '../src/dropdown-audit.js';
import { PATIENT_REGISTRY_FORM_UID } from '../src/constants.js';

function createFixture(): { directory: string; dbPath: string; journalPath: string } {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bahis-dropdown-audit-'));
    const dbPath = path.join(directory, 'bahis3.db');
    const journalPath = path.join(directory, 'bahis-mcp.db');
    const bahis = new Database(dbPath);
    bahis.exec(`
        CREATE TABLE users (upazila INTEGER);
        CREATE TABLE administrativeregion (id INTEGER PRIMARY KEY, title TEXT, parent_administrative_region INTEGER, administrative_region_level INTEGER);
        CREATE TABLE formcloudsubmission (uuid TEXT PRIMARY KEY, form_uid TEXT, xml TEXT);
        INSERT INTO users VALUES (30);
        INSERT INTO administrativeregion VALUES (30, 'SAVAR', NULL, 3), (40, 'ASHULIA', 30, 4);
    `);
    const xml = (union: string) => `<form><basic_info><union>${union}</union></basic_info></form>`;
    bahis.prepare('INSERT INTO formcloudsubmission VALUES (?, ?, ?)').run('uuid:invalid', PATIENT_REGISTRY_FORM_UID, xml('ASHULIA'));
    bahis.prepare('INSERT INTO formcloudsubmission VALUES (?, ?, ?)').run('uuid:valid', PATIENT_REGISTRY_FORM_UID, xml('40'));
    bahis.close();

    const journal = new Database(journalPath);
    journal.exec(`
        CREATE TABLE batch_record (batch_id TEXT, record_index INTEGER, uuid TEXT, status TEXT);
        INSERT INTO batch_record VALUES ('batch-1', 0, 'invalid', 'verified'), ('batch-1', 1, 'valid', 'verified');
    `);
    journal.close();
    return { directory, dbPath, journalPath };
}

test('audit reports MCP records that saved a Union label and writes no patient data', () => {
    const { directory, dbPath, journalPath } = createFixture();
    try {
        const audit = collectInvalidUnionAudit(dbPath, journalPath);
        assert.deepEqual(audit, [
            { batchId: 'batch-1', recordIndex: 0, uuid: 'invalid', status: 'verified', invalidField: 'union' },
        ]);

        const output = path.join(directory, 'dropdown-audit.csv');
        writeDropdownAudit(output, audit);
        assert.equal(
            fs.readFileSync(output, 'utf8'),
            'batch_id,record_index,uuid,status,invalid_field\n"batch-1","0","invalid","verified","union"\n',
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
