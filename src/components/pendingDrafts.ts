export interface LocalDbSource {
    invoke(channel: string, query: string): Promise<unknown>;
}

/**
 * Count submissions saved locally but not yet uploaded.
 *
 * `get-local-db` resolves to an array of rows, and SQLite names an unaliased
 * aggregate column `count(*)`, so both the alias and the row index matter here.
 * Reading this wrong silently yields 0, which disables the callers' guards
 * against wiping un-uploaded work.
 */
export async function countPendingDrafts(source: LocalDbSource): Promise<number> {
    const rows = (await source.invoke('get-local-db', 'select count(*) as count from formlocaldraft')) as
        | { count?: number }[]
        | undefined;
    const count = rows?.[0]?.count;
    return typeof count === 'number' && Number.isFinite(count) ? count : 0;
}

export function pendingDraftsMessage(count: number): string {
    const submissions = count === 1 ? '1 submission' : `${count} submissions`;
    return `${submissions} not yet uploaded. Please Sync Data first, or they will be lost.`;
}
