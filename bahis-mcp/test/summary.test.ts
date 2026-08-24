import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaxonomyContext } from '../src/taxonomy.js';
import { summarizeRecentPatients } from '../src/summary.js';

const taxonomies: TaxonomyContext = {
    species: [
        { id: 'cattle', label: 'Cattle', speciesType: 'mammal' },
        { id: 'chicken', label: 'Chicken', speciesType: 'bird' },
    ],
    clinicalSigns: [
        { id: '26', label: 'Fever', speciesType: 'mammal' },
        { id: '28', label: 'Ruffled feathers', speciesType: 'bird' },
    ],
    tentativeDiagnoses: [
        { id: '21', label: 'Ephemeral Fever', species: 'cattle' },
        { id: '46', label: 'Newcastle Disease', species: 'chicken' },
    ],
};

// Production writes the union *id* into basic_info/union and the village *label* into
// basic_info/village (see xform.ts patientChoiceValues), so the fixture is shaped that way.
// A label-shaped union fixture hides the resolution path that real rows take.
const locations = [
    { id: '30267218', label: 'ASHULIA', villages: [{ id: '30267218050', label: 'AUKPARA' }] },
    {
        id: '30267272',
        label: 'PATHALIA',
        villages: [
            { id: '30267272434', label: 'GARUA' },
            { id: '30267272457', label: 'GHUGHUDIA' },
        ],
    },
    { id: '30267215', label: 'AMIN BAZAR', villages: [{ id: '30267215999', label: 'AMIN BAZAR' }] },
    {
        // The live taxonomy really does list several identically-named villages under SAVAR.
        id: '30267278',
        label: 'SAVAR',
        villages: [
            { id: '30267278235', label: 'SAVAR' },
            { id: '30267278312', label: 'SAVAR' },
        ],
    },
];

function xml({
    species = 'cattle',
    patientType = 'herd',
    purpose = 'milk',
    herd = 5,
    sick = 1,
    dead = 0,
    signs = '26',
    diagnosis = '21',
    union = '30267218',
    village = 'AUKPARA',
    date = '2026-08-09',
}: Partial<{
    species: string;
    patientType: string;
    purpose: string;
    herd: number;
    sick: number;
    dead: number;
    signs: string;
    diagnosis: string;
    union: string;
    village: string;
    date: string;
}> = {}): string {
    return `<ajAsiLXLghXg2c2BXFMQbV>
      <basic_info><date>${date}</date><union>${union}</union><village>${village}</village><owner>Private Person</owner><mobile>01700000000</mobile></basic_info>
      <patient_info><species>${species}</species><patient_type>${patientType}</patient_type><species_rearing_purpose>${purpose}</species_rearing_purpose><herd_flock_size>${herd}</herd_flock_size><sick_number>${sick}</sick_number><dead_number>${dead}</dead_number><clinical_signs>${signs}</clinical_signs></patient_info>
      <diagnosis_treatment><tentative_diagnosis>${diagnosis}</tentative_diagnosis></diagnosis_treatment>
      <meta><instanceID>uuid:private-uuid</instanceID></meta>
    </ajAsiLXLghXg2c2BXFMQbV>`;
}

test('summarizes valid recent records and suppresses malformed or stale records', () => {
    const summary = summarizeRecentPatients(
        [
            xml(),
            xml({ herd: 7, sick: 2 }),
            xml({ herd: 6, sick: 1 }),
            xml({ herd: 8, sick: 2 }),
            xml({ herd: 9, sick: 3 }),
            xml({
                species: 'chicken',
                patientType: 'flock',
                purpose: 'egg',
                herd: 20,
                sick: 3,
                signs: '28',
                diagnosis: '46',
                union: '30267278',
                village: 'SAVAR',
            }),
            xml({ diagnosis: 'stale-diagnosis' }),
            '<not-patient-registry/>',
        ],
        200,
        taxonomies,
        locations,
    );

    assert.equal(summary.requestedLimit, 200);
    assert.equal(summary.scannedRecordCount, 8);
    assert.equal(summary.usableRecordCount, 6);
    assert.equal(summary.skippedRecordCount, 2);
    assert.deepEqual(summary.speciesProfiles[0], {
        species: 'cattle',
        count: 5,
        patientTypes: [{ id: 'herd', count: 5 }],
        purposes: [{ id: 'milk', count: 5 }],
        herdSize: { min: 5, median: 7, max: 9 },
        sickCount: { min: 1, median: 2, max: 3 },
        deadCount: { min: 0, median: 0, max: 0 },
        clinicalSigns: [{ id: '26', count: 5 }],
        tentativeDiagnoses: [{ id: '21', count: 5 }],
    });
    assert.equal(summary.speciesProfiles.some(({ species }) => species === 'chicken'), false);
    assert.deepEqual(summary.locationPatterns, [
        { unionId: '30267218', villageId: '30267218050', count: 5 },
    ]);
    assert.deepEqual(summary.clinicalPatterns, [
        {
            species: 'cattle',
            patientType: 'herd',
            purpose: 'milk',
            clinicalSignIds: ['26'],
            tentativeDiagnosisIds: ['21'],
            count: 5,
        },
    ]);

    const serialized = JSON.stringify(summary);
    for (const sensitive of ['Private Person', '01700000000', 'private-uuid', 'ownerName', 'mobile', 'rawXml', 'uuid']) {
        assert.equal(serialized.includes(sensitive), false, sensitive);
    }
});

test('applies the requested limit to usable records, not to scanned rows', () => {
    // The oldest rows in the real registry carry an empty tentative_diagnosis and are unusable.
    // They must not consume window slots, or an oldest-N request would summarize almost nothing.
    const unusable = Array.from({ length: 10 }, () => xml({ diagnosis: '' }));
    const summary = summarizeRecentPatients(
        [...unusable, ...Array.from({ length: 8 }, () => xml())],
        5,
        taxonomies,
        locations,
        'oldest',
    );

    assert.equal(summary.order, 'oldest');
    assert.equal(summary.scannedRecordCount, 18);
    assert.equal(summary.usableRecordCount, 5);
    assert.equal(summary.skippedRecordCount, 13);
    assert.equal(summary.speciesProfiles[0].count, 5);
});

test('reports the visit-date span of the summarized window', () => {
    const summary = summarizeRecentPatients(
        [
            xml({ date: '2025-01-27' }),
            xml({ date: '2025-02-10' }),
            xml({ date: '2025-03-12' }),
            xml({ date: '2025-02-28' }),
            xml({ date: '2025-02-02' }),
        ],
        200,
        taxonomies,
        locations,
        'oldest',
    );

    assert.equal(summary.oldestDate, '2025-01-27');
    assert.equal(summary.newestDate, '2025-03-12');
});

test('defaults to newest ordering when no order is given', () => {
    const summary = summarizeRecentPatients([xml()], 200, taxonomies, locations);
    assert.equal(summary.order, 'newest');
});

function patternsFor(villages: string[], union: string) {
    return summarizeRecentPatients(
        villages.map((village) => xml({ union, village })),
        200,
        taxonomies,
        locations,
    ).locationPatterns;
}

test('resolves the union by id, which is what production writes into basic_info/union', () => {
    assert.deepEqual(patternsFor(Array(5).fill('AUKPARA'), '30267218'), [
        { unionId: '30267218', villageId: '30267218050', count: 5 },
    ]);
});

test('still resolves the older rows that carry a union label instead of an id', () => {
    assert.deepEqual(patternsFor(Array(5).fill('AUKPARA'), 'ASHULIA'), [
        { unionId: '30267218', villageId: '30267218050', count: 5 },
    ]);
});

test('folds case, spacing and punctuation in free-text village labels', () => {
    // Every one of these appears in the live registry for the single AMIN BAZAR village.
    assert.deepEqual(
        patternsFor(['AMIN BAZAR', 'amin bazar', 'aminbazar', 'Amin-Bazar', 'amin  bazar'], '30267215'),
        [{ unionId: '30267215', villageId: '30267215999', count: 5 }],
    );
});

test('absorbs single-character transliteration variants of a village label', () => {
    // 'gerua' for GARUA is the single largest such variant in the live registry.
    assert.deepEqual(patternsFor(['GARUA', 'garua', 'Garua', 'gerua', ' gerua '], '30267272'), [
        { unionId: '30267272', villageId: '30267272434', count: 5 },
    ]);
});

test('leaves a village label that is more than one edit away unresolved', () => {
    // 'ganda' is two edits from GARUA and is a different place; guessing would invent a location.
    assert.deepEqual(patternsFor(Array(5).fill('ganda'), '30267272'), []);
});

test('leaves a village label that matches several villages unresolved', () => {
    // SAVAR lists multiple identically-named villages, so the id is genuinely ambiguous.
    assert.deepEqual(patternsFor(Array(5).fill('SAVAR'), '30267278'), []);
});

test('leaves a village absent from the taxonomy unresolved', () => {
    assert.deepEqual(patternsFor(Array(5).fill('sadhapur'), '30267222'), []);
});

test('keeps the minimum-cohort threshold gating location patterns', () => {
    assert.deepEqual(patternsFor(Array(4).fill('AUKPARA'), '30267218'), []);
    assert.equal(patternsFor(Array(5).fill('AUKPARA'), '30267218').length, 1);
});
