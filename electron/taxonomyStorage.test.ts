import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeTaxonomyCsv } from './taxonomyStorage.ts';

test('creates missing taxonomy directories before writing a CSV', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'bahis-taxonomy-'));
    try {
        const filePath = writeTaxonomyCsv(userDataPath, 'taxonomies/species.csv', 'name,label\ncattle,Cattle');

        assert.equal(existsSync(filePath), true);
        assert.equal(readFileSync(filePath, 'utf-8'), 'name,label\ncattle,Cattle');
    } finally {
        rmSync(userDataPath, { recursive: true, force: true });
    }
});

test('rejects taxonomy paths outside the user-data directory', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'bahis-taxonomy-'));
    try {
        assert.throws(() => writeTaxonomyCsv(userDataPath, '../outside.csv', 'unsafe'), /Invalid taxonomy file path/);
    } finally {
        rmSync(userDataPath, { recursive: true, force: true });
    }
});
