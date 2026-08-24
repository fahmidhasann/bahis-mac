import assert from 'node:assert/strict';
import test from 'node:test';
import { runDownloadBatch } from './downloadBatch.ts';

test('download batch does not complete until every item finishes', async () => {
    let releaseSlow: (() => void) | undefined;
    let completed = false;
    const slow = new Promise<void>((resolve) => {
        releaseSlow = resolve;
    });

    const pending = runDownloadBatch({
        items: ['fast', 'slow'],
        keyOf: (item) => item,
        download: async (item) => {
            if (item === 'slow') await slow;
            return item;
        },
    }).then((result) => {
        completed = true;
        return result;
    });

    await Promise.resolve();
    assert.equal(completed, false);
    releaseSlow?.();
    const result = await pending;
    assert.deepEqual(result.completed.sort(), ['fast', 'slow']);
});

test('optional medicinesv2 failure is visible as a warning while required failures remain fatal', async () => {
    const result = await runDownloadBatch({
        items: ['species', 'medicinesv2', 'diseases'],
        keyOf: (item) => item,
        optionalKeys: new Set(['medicinesv2']),
        download: async (item) => {
            if (item === 'medicinesv2') throw new Error('404');
            if (item === 'diseases') throw new Error('503');
            return item;
        },
    });

    assert.deepEqual(result.completed, ['species']);
    assert.deepEqual(result.warnings, [{ key: 'medicinesv2', reason: '404' }]);
    assert.deepEqual(result.failures, [{ key: 'diseases', reason: '503' }]);
});
