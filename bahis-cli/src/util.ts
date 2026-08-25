import { createHash } from 'node:crypto';
import { UUID_NAMESPACE } from './constants.js';

export function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

export function safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message
        .replace(/TOKEN\s+[^\s]+/gi, 'TOKEN [REDACTED]')
        .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
        .replace(/(^|[?&\s])((?:access_token|token|password)=)[^&\s]+/gi, '$1$2[REDACTED]')
        .replace(/password=[^&\s]+/gi, 'password=[REDACTED]')
        .slice(0, 600);
}

export function log(event: string, details: Record<string, unknown> = {}): void {
    const allowed: Record<string, unknown> = {};
    if (typeof details.databaseConfigured === 'boolean') allowed.databaseConfigured = details.databaseConfigured;
    if (typeof details.productionWritesEnabled === 'boolean') {
        allowed.productionWritesEnabled = details.productionWritesEnabled;
    }
    if (typeof details.error === 'string') allowed.error = safeError(details.error);
    process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...allowed })}\n`);
}

export function todayInDhaka(now = new Date()): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Dhaka',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(now);
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
}

export function dhakaTimestamp(now = new Date()): string {
    const shifted = new Date(now.getTime() + 6 * 60 * 60 * 1000);
    return shifted.toISOString().replace('Z', '+06:00');
}

function uuidBytes(uuid: string): Buffer {
    const hex = uuid.replace(/-/g, '');
    if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('Invalid UUID namespace');
    return Buffer.from(hex, 'hex');
}

export function deterministicUuid(name: string, namespace = UUID_NAMESPACE): string {
    const digest = createHash('sha1').update(uuidBytes(namespace)).update(name, 'utf8').digest().subarray(0, 16);
    digest[6] = (digest[6] & 0x0f) | 0x50;
    digest[8] = (digest[8] & 0x3f) | 0x80;
    const hex = digest.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function mapConcurrent<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Concurrency limit must be a positive safe integer.');
    const results = new Array<R>(items.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await worker(items[index]);
        }
    });
    await Promise.all(runners);
    return results;
}

export const sleep = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));
