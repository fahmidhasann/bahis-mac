import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BahisDatabase, JournalDatabase } from '../src/database.js';

function fixture(): { directory: string; dbPath: string } {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bahis-mcp-test-'));
    const dbPath = path.join(directory, 'bahis3.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE users (token TEXT, upazila INTEGER);
      CREATE TABLE administrativeregion (id INTEGER PRIMARY KEY, title TEXT, parent_administrative_region INTEGER, administrative_region_level INTEGER);
      CREATE TABLE form (uid TEXT PRIMARY KEY, xml TEXT);
      CREATE TABLE taxonomy (slug TEXT PRIMARY KEY, csv_file TEXT);
      CREATE TABLE formlocaldraft (uuid TEXT PRIMARY KEY, form_uid TEXT, xml TEXT);
      CREATE TABLE formcloudsubmission (uuid TEXT PRIMARY KEY, form_uid TEXT, xml TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO users VALUES ('secret-token', 30);
      INSERT INTO administrativeregion VALUES (1, 'DHAKA', NULL, 1), (2, 'DHAKA', 1, 2), (30, 'SAVAR', 2, 3), (40, 'ASHULIA', 30, 4), (50, 'AUKPARA', 40, 5);
      INSERT INTO form VALUES ('ajAsiLXLghXg2c2BXFMQbV', '<xml/>');
    `);
    db.close();
    return { directory, dbPath };
}

test('resolves the signed-in region and validates the union/village parent chain', () => {
    const { directory, dbPath } = fixture();
    try {
        const repository = new BahisDatabase(dbPath, true);
        assert.equal(repository.getUserRegion().upazila.title, 'SAVAR');
        assert.deepEqual(repository.resolveLocation('40', '50'), {
            union: { id: '40', label: 'ASHULIA' },
            village: { id: '50', label: 'AUKPARA' },
        });
        assert.throws(() => repository.resolveLocation('40 OR 1=1', '50'), /not valid/);
        repository.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function submission(date: string): string {
    return `<ajAsiLXLghXg2c2BXFMQbV><basic_info><date>${date}</date></basic_info></ajAsiLXLghXg2c2BXFMQbV>`;
}

test('reads the newest Patient Registry submissions with rowid as the tie-breaker', () => {
    const { directory, dbPath } = fixture();
    try {
        const db = new Database(dbPath);
        const insert = db.prepare('INSERT INTO formcloudsubmission (uuid, form_uid, xml, created_at) VALUES (?, ?, ?, ?)');
        insert.run('one', 'ajAsiLXLghXg2c2BXFMQbV', '<one/>', '2026-08-08 10:00:00');
        insert.run('two', 'ajAsiLXLghXg2c2BXFMQbV', '<two/>', '2026-08-09 10:00:00');
        insert.run('three', 'ajAsiLXLghXg2c2BXFMQbV', '<three/>', '2026-08-09 10:00:00');
        insert.run('other', 'another-form', '<other/>', '2026-08-10 10:00:00');
        db.close();

        const repository = new BahisDatabase(dbPath, true);
        assert.deepEqual(repository.getRecentPatientSubmissionXml(2, 'newest'), ['<three/>', '<two/>']);
        repository.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('orders oldest-first by the visit date in the XML, not by sync time', () => {
    const { directory, dbPath } = fixture();
    try {
        const db = new Database(dbPath);
        const insert = db.prepare('INSERT INTO formcloudsubmission (uuid, form_uid, xml, created_at) VALUES (?, ?, ?, ?)');
        // created_at deliberately disagrees with the visit date: the oldest visit synced last.
        insert.run('recent-visit', 'ajAsiLXLghXg2c2BXFMQbV', submission('2026-01-15'), '2026-08-01 10:00:00');
        insert.run('oldest-visit', 'ajAsiLXLghXg2c2BXFMQbV', submission('2024-12-03'), '2026-08-09 10:00:00');
        insert.run('middle-visit', 'ajAsiLXLghXg2c2BXFMQbV', submission('2025-02-20'), '2026-08-05 10:00:00');
        insert.run('other', 'another-form', submission('2020-01-01'), '2026-08-10 10:00:00');
        db.close();

        const repository = new BahisDatabase(dbPath, true);
        assert.deepEqual(repository.getRecentPatientSubmissionXml(200, 'oldest'), [
            submission('2024-12-03'),
            submission('2025-02-20'),
            submission('2026-01-15'),
        ]);
        repository.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('returns every oldest-ordered row so the usable-record filter can pick the window', () => {
    const { directory, dbPath } = fixture();
    try {
        const db = new Database(dbPath);
        const insert = db.prepare('INSERT INTO formcloudsubmission (uuid, form_uid, xml, created_at) VALUES (?, ?, ?, ?)');
        for (let index = 0; index < 25; index += 1) {
            insert.run(`row-${index}`, 'ajAsiLXLghXg2c2BXFMQbV', submission('2025-03-01'), '2026-08-01 10:00:00');
        }
        db.close();

        const repository = new BahisDatabase(dbPath, true);
        // The limit is applied after filtering in summary.ts, so the query must not truncate here.
        assert.equal(repository.getRecentPatientSubmissionXml(5, 'oldest').length, 25);
        assert.equal(repository.getRecentPatientSubmissionXml(5, 'newest').length, 5);
        repository.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('journal rejects requestId reuse with different content', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bahis-mcp-journal-'));
    try {
        const journal = new JournalDatabase(path.join(directory, 'journal.db'));
        const record = { index: 0, uuid: '00000000-0000-5000-8000-000000000000', xml: '<x/>', fieldHashes: { x: 'a' } };
        journal.ensureBatch('batch', 'hash-one', [record]);
        assert.throws(() => journal.ensureBatch('batch', 'hash-two', [record]), /different record data/);
        journal.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('journal normalizes a nullable database error to an omitted result field', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bahis-mcp-journal-'));
    try {
        const journal = new JournalDatabase(path.join(directory, 'journal.db'));
        const record = { index: 0, uuid: '00000000-0000-5000-8000-000000000001', xml: '<x/>', fieldHashes: { x: 'a' } };
        journal.ensureBatch('batch-null-error', 'hash', [record]);
        assert.equal(journal.getBatch('batch-null-error')[0].error, undefined);
        journal.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
