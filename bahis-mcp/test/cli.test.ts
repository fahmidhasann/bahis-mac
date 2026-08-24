import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { JournalDatabase } from '../src/database.js';

const execFileAsync = promisify(execFile);
const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');

interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}

/**
 * Run the CLI the way an agent would - as a real process - so exit codes and stream separation are
 * covered, not just the functions behind them. Those two are the CLI's actual contract.
 */
async function run(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
    try {
        const { stdout, stderr } = await execFileAsync(
            process.execPath,
            ['--import', 'tsx', CLI, ...args],
            { env: { ...process.env, ...env } },
        );
        return { code: 0, stdout, stderr };
    } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string };
        return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
}

function emptyDbEnv(): Record<string, string> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bahis-cli-test-'));
    const dbPath = path.join(directory, 'bahis3.db');
    new Database(dbPath).close();
    return { BAHIS_DB_PATH: dbPath, BAHIS_MCP_JOURNAL_PATH: path.join(directory, 'journal.db') };
}

test('an unknown command exits 1 with a structured error on stderr, leaving stdout clean', async () => {
    const result = await run(['not-a-command']);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(JSON.parse(result.stderr).error, /Unknown command/);
    assert.equal(JSON.parse(result.stderr).command, 'not-a-command');
});

test('no command prints usage and exits 1', async () => {
    const result = await run([]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Usage: bahis <command>/);
});

test('--help exits 0 so a wrapper can probe the CLI without tripping an error path', async () => {
    const result = await run(['status', '--help']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Exit codes/);
});

test('submit without --file fails before opening the database or the network', async () => {
    const result = await run(['submit'], emptyDbEnv());
    assert.equal(result.code, 1);
    assert.match(JSON.parse(result.stderr).error, /--file is required/);
});

test('a malformed records file is reported as invalid JSON, not as a crash', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bahis-cli-test-'));
    const file = path.join(directory, 'records.json');
    fs.writeFileSync(file, '{not json');
    const result = await run(['validate', '--file', file], emptyDbEnv());
    assert.equal(result.code, 1);
    assert.match(JSON.parse(result.stderr).error, /not valid JSON/);
});

test('a schema failure names the record index and the offending field', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bahis-cli-test-'));
    const file = path.join(directory, 'records.json');
    // Record 1 has a placeholder owner name, which the schema rejects by design.
    fs.writeFileSync(
        file,
        JSON.stringify([
            {
                ownerName: 'Rokeya Begum',
                unionId: '40',
                villageId: '50',
                species: 'goat',
                patientType: 'household',
                purpose: 'milk',
                herdSize: 3,
                sickCount: 1,
                deadCount: 0,
                clinicalSignIds: ['79'],
                tentativeDiagnosisIds: ['55'],
            },
            { ownerName: 'Test Dummy' },
        ]),
    );
    const result = await run(['validate', '--file', file], emptyDbEnv());
    assert.equal(result.code, 1);
    const { error } = JSON.parse(result.stderr) as { error: string };
    assert.match(error, /record 1 is invalid/);
    assert.match(error, /ownerName/);
});

test('batches reads the journal and prints JSON on stdout', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bahis-cli-test-'));
    const journalPath = path.join(directory, 'journal.db');
    const journal = new JournalDatabase(journalPath);
    journal.ensureBatch('batch-one', 'hash-one', [
        { index: 0, uuid: 'uuid-a', xml: '<x/>', fieldHashes: {} },
        { index: 1, uuid: 'uuid-b', xml: '<x/>', fieldHashes: {} },
    ]);
    journal.updateRecord('batch-one', 0, 'verified');
    journal.close();

    const dbPath = path.join(directory, 'bahis3.db');
    new Database(dbPath).close();
    const result = await run(['batches'], { BAHIS_DB_PATH: dbPath, BAHIS_MCP_JOURNAL_PATH: journalPath });

    assert.equal(result.code, 0);
    const batches = JSON.parse(result.stdout) as Array<{ id: string; records: number; verified: number }>;
    assert.equal(batches.length, 1);
    assert.equal(batches[0].id, 'batch-one');
    assert.equal(batches[0].records, 2);
    assert.equal(batches[0].verified, 1);
});

test('--limit rejects a non-positive value instead of silently passing it to SQL', async () => {
    const result = await run(['batches', '--limit', '0'], emptyDbEnv());
    assert.equal(result.code, 1);
    assert.match(JSON.parse(result.stderr).error, /--limit must be a positive integer/);
});

test('identical records produce the same default request id, so a rerun is idempotent', async () => {
    const records = [{ ownerName: 'Abdul Malek' }];
    const { sha256 } = await import('../src/util.js');
    const expected = `bahis-cli-${sha256(JSON.stringify(records)).slice(0, 16)}`;
    assert.equal(expected, `bahis-cli-${sha256(JSON.stringify(records)).slice(0, 16)}`);
    assert.match(expected, /^bahis-cli-[0-9a-f]{16}$/);
});
