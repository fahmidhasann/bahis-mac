import assert from 'node:assert/strict';
import test from 'node:test';
import { countPendingDrafts, pendingDraftsMessage } from './pendingDrafts.ts';

const source = (result: unknown) => ({
    queries: [] as string[],
    async invoke(_channel: string, query: string) {
        this.queries.push(query);
        return result;
    },
});

test('the draft count query aliases the aggregate column', async () => {
    const db = source([{ count: 0 }]);
    await countPendingDrafts(db);

    // Without the alias the column is named "count(*)" and every read yields undefined.
    assert.match(db.queries[0], /count\(\*\) as count/);
});

test('the count is read from the first row of the result array', async () => {
    assert.equal(await countPendingDrafts(source([{ count: 7 }])), 7);
    assert.equal(await countPendingDrafts(source([{ count: 0 }])), 0);
});

test('a result shaped like the old buggy read does not silently become zero drafts', async () => {
    // The previous code did `response?.count` on an array, which is always undefined.
    const rows = [{ count: 3 }];
    assert.equal((rows as unknown as { count?: number }).count, undefined);
    assert.equal(await countPendingDrafts(source(rows)), 3);
});

test('unreadable results fall back to zero so callers must handle rejection separately', async () => {
    assert.equal(await countPendingDrafts(source([])), 0);
    assert.equal(await countPendingDrafts(source(undefined)), 0);
    assert.equal(await countPendingDrafts(source([{}])), 0);
});

test('the warning names the count and tells the user what to do', () => {
    assert.equal(pendingDraftsMessage(1), '1 submission not yet uploaded. Please Sync Data first, or they will be lost.');
    assert.match(pendingDraftsMessage(12), /^12 submissions not yet uploaded\./);
});
