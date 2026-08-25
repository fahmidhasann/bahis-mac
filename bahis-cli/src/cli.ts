#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { login } from './auth.js';
import { loadConfig } from './config.js';
import { JournalDatabase } from './database.js';
import { BahisService } from './service.js';
import { patientInputSchema } from './schemas.js';
import { ZodError } from 'zod';
import { CLI_VERSION } from './constants.js';
import { safeError, sha256 } from './util.js';
import type { BatchResult } from './types.js';

/**
 * The shell launchers this CLI used to ship with (cli.sh, bahis.cmd) both defaulted production
 * writes on, and npm's generated bin shim sets no environment at all. Keeping the default here
 * preserves that behaviour on every platform from one place. Set the variable explicitly to
 * anything other than "1" to put the gate back in the way.
 */
process.env.BAHIS_ALLOW_PRODUCTION_WRITES ??= process.env.BAHIS_MCP_ALLOW_PRODUCTION_WRITES ?? '1';

/**
 * Exit codes are the CLI's real interface for an agent driving it: branch on the code, read stdout
 * only for detail. 2 is deliberately distinct from 1 - it means the write reached the server but
 * not every record came back verified, which is the one case worth retrying rather than rewriting.
 */
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_PARTIAL = 2;

const USAGE = `bahis - BAHIS Patient Registry command line

Usage: bahis <command> [options]

Commands:
  login      -u <username> -p <password>   Sign in and refresh the stored token
  status                                   Connectivity, auth and form-compatibility gates
  context    [--species a,b]               Valid unions, villages, species, signs, diagnoses
  summary    [--limit 200] [--order oldest|newest]
  validate   --file <path>                 Run every submit check locally; write nothing
  submit     --file <path> [--request-id X]
  verify     <batchId>
  retry      <batchId>
  batches    [--limit 20]                  Recent batch history from the journal

Options:
  --file <path>    JSON array of patient records; use - to read stdin
  --request-id X   Batch id. Defaults to a hash of the records, making a rerun idempotent
  --json           Accepted for symmetry; stdout is always JSON
  -h, --help

Exit codes: 0 success, 1 error (nothing written), 2 batch partially verified (retryable)`;

function emit(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(command: string, error: unknown): never {
    process.stderr.write(`${JSON.stringify({ error: safeError(error), command })}\n`);
    process.exit(EXIT_ERROR);
}

function readRecords(file: string | undefined): unknown[] {
    if (!file) throw new Error('--file is required (use - to read JSON from stdin).');
    const raw = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`${file === '-' ? 'stdin' : file} is not valid JSON: ${safeError(error)}`);
    }
    // Accept either a bare array or the MCP-shaped { records: [...] } so payloads are interchangeable.
    const records =
        Array.isArray(parsed) ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { records?: unknown }).records)
          ? (parsed as { records: unknown[] }).records
          : undefined;
    if (!records) throw new Error('Expected a JSON array of patient records, or an object with a "records" array.');
    if (records.length === 0) throw new Error('No records to submit.');
    return records;
}

/**
 * A content-derived default request id makes rerunning the same file a no-op instead of a
 * duplicate batch: identical records resolve to the same id, so the journal recognises the batch
 * and the deterministic UUIDs mean the server dedupes anything already accepted.
 */
function resolveRequestId(explicit: string | undefined, records: unknown[]): string {
    if (explicit) return explicit;
    return `bahis-cli-${sha256(JSON.stringify(records)).slice(0, 16)}`;
}

/**
 * Parse each record separately so a schema failure names the record index and the exact field.
 * Zod's own message is a multi-line JSON blob that safeError would truncate mid-structure, which
 * is useless to an agent trying to fix its own payload.
 */
function parseRecords(records: unknown[]) {
    return records.map((record, index) => {
        try {
            return patientInputSchema.parse(record);
        } catch (error) {
            if (error instanceof ZodError) {
                const issues = error.issues
                    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
                    .join('; ');
                throw new Error(`record ${index} is invalid - ${issues}`);
            }
            throw error;
        }
    });
}

function batchExit(result: BatchResult): number {
    return result.verified === result.requested ? EXIT_OK : EXIT_PARTIAL;
}

function positiveInt(value: string | undefined, fallback: number, flag: string): number {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer.`);
    return parsed;
}

async function main(): Promise<void> {
    const { values, positionals } = parseArgs({
        args: process.argv.slice(2),
        allowPositionals: true,
        options: {
            username: { type: 'string', short: 'u' },
            password: { type: 'string', short: 'p' },
            file: { type: 'string', short: 'f' },
            'request-id': { type: 'string' },
            species: { type: 'string' },
            limit: { type: 'string' },
            order: { type: 'string' },
            json: { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h', default: false },
        },
    });

    const command = positionals[0];
    if (!command || values.help) {
        process.stdout.write(`${USAGE}\n`);
        process.exit(command ? EXIT_OK : EXIT_ERROR);
    }

    const config = loadConfig();
    const service = new BahisService(config);

    switch (command) {
        case 'login': {
            const { username, password } = values;
            if (!username || !password) throw new Error('login requires -u <username> and -p <password>.');
            emit(await login(config, username, password, CLI_VERSION));
            return;
        }

        case 'status': {
            const status = await service.status();
            emit(status);
            const ready =
                status.databaseFound && status.authenticated && status.serverReachable && status.formCompatible;
            process.exit(ready ? EXIT_OK : EXIT_ERROR);
            return;
        }

        case 'context': {
            const species = values.species?.split(',').map((value) => value.trim()).filter(Boolean);
            emit(await service.patientContext(species?.length ? species : undefined));
            return;
        }

        case 'summary': {
            const order = values.order ?? 'oldest';
            if (order !== 'oldest' && order !== 'newest') throw new Error('--order must be oldest or newest.');
            emit(await service.recentPatientSummary(positiveInt(values.limit, 200, '--limit'), order));
            return;
        }

        case 'validate': {
            const records = readRecords(values.file);
            const result = await service.validatePatientBatch({
                requestId: resolveRequestId(values['request-id'], records),
                records: parseRecords(records),
            });
            emit(result);
            process.exit(result.invalid === 0 ? EXIT_OK : EXIT_ERROR);
            return;
        }

        case 'submit': {
            const records = readRecords(values.file);
            const result = await service.submitPatientBatch({
                requestId: resolveRequestId(values['request-id'], records),
                records: parseRecords(records),
            });
            emit(result);
            process.exit(batchExit(result));
            return;
        }

        case 'verify':
        case 'retry': {
            const batchId = positionals[1];
            if (!batchId) throw new Error(`${command} requires a batchId.`);
            const result =
                command === 'verify' ? await service.verifyPatientBatch(batchId) : await service.retryPatientBatch(batchId);
            emit(result);
            process.exit(batchExit(result));
            return;
        }

        case 'batches': {
            const journal = new JournalDatabase(config.journalPath);
            try {
                emit(journal.listBatches(positiveInt(values.limit, 20, '--limit')));
            } finally {
                journal.close();
            }
            return;
        }

        default:
            throw new Error(`Unknown command "${command}". Run bahis --help.`);
    }
}

try {
    await main();
} catch (error) {
    fail(process.argv[2] ?? 'bahis', error);
}
