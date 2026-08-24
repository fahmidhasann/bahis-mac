import assert from 'node:assert/strict';
import test from 'node:test';
import { subscribeToSubmissionSync } from './submissionSyncRefresh.ts';

test('sync completion reloads once and cleanup removes the listener', () => {
    let listener: (() => void) | undefined;
    let reloads = 0;
    const source = {
        on: (_channel: string, callback: () => void) => {
            listener = callback;
        },
        removeListener: (_channel: string, callback: () => void) => {
            if (listener === callback) listener = undefined;
        },
    };

    const cleanup = subscribeToSubmissionSync(source, () => {
        reloads += 1;
    });
    listener?.();
    cleanup();
    listener?.();

    assert.equal(reloads, 1);
});
