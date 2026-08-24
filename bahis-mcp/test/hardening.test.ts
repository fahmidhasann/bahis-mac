import assert from 'node:assert/strict';
import test from 'node:test';
import { patientInputSchema } from '../src/schemas.js';
import { mapConcurrent, safeError } from '../src/util.js';

const patient = {
    ownerName: 'Abdul Malek',
    unionId: '1',
    villageId: '2',
    species: 'cattle',
    patientType: 'herd' as const,
    purpose: 'milk' as const,
    herdSize: 5,
    sickCount: 1,
    deadCount: 0,
    clinicalSignIds: ['fever'],
    tentativeDiagnosisIds: ['fmd'],
};

test('visitDate rejects impossible calendar dates', () => {
    assert.equal(patientInputSchema.safeParse({ ...patient, visitDate: '2026-02-30' }).success, false);
    assert.equal(patientInputSchema.safeParse({ ...patient, visitDate: '2026-02-28' }).success, true);
});

test('ownerName rejects placeholders and accepts natural-looking Bengali names', () => {
    for (const ownerName of [
        'Synthetic Owner 01',
        'Dummy Owner',
        'Test User',
        'Sample',
        'Placeholder Patient',
        'Unknown',
        'Owner 12',
        'Fake Owner',
        'Example Owner',
        'Demo Owner',
        'Owner 12 Rahim',
        'Rahim Owner #12',
    ]) {
        assert.equal(patientInputSchema.safeParse({ ...patient, ownerName }).success, false, ownerName);
    }
    for (const ownerName of ['Abdul Malek', 'Rokeya Begum', 'Md. Sohel Rana', 'Taohid']) {
        assert.equal(patientInputSchema.safeParse({ ...patient, ownerName }).success, true, ownerName);
    }
});

test('safeError redacts common authorization and query secrets', () => {
    const redacted = safeError(
        new Error('Bearer abc TOKEN xyz https://example.test/?token=one&access_token=two&password=three'),
    );
    assert.equal(redacted.includes('abc'), false);
    assert.equal(redacted.includes('xyz'), false);
    assert.equal(redacted.includes('one'), false);
    assert.equal(redacted.includes('two'), false);
    assert.equal(redacted.includes('three'), false);
    for (const assignment of ['token=one', 'access_token=two', 'password=three']) {
        assert.match(safeError(new Error(assignment)), /=\[REDACTED\]$/);
    }
});

test('mapConcurrent rejects invalid limits', async () => {
    await assert.rejects(mapConcurrent([1], 0, async (value) => value), /positive safe integer/);
    await assert.rejects(mapConcurrent([1], 1.5, async (value) => value), /positive safe integer/);
});
