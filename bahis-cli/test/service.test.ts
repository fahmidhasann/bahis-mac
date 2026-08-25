import test from 'node:test';
import assert from 'node:assert/strict';
import { assertHerdSize, assertMandatoryChoices } from '../src/service.js';
import { MAX_HERD_SIZE } from '../src/constants.js';
import type { TaxonomyContext } from '../src/taxonomy.js';
import type { PatientInput } from '../src/types.js';

/** Mirrors the real taxonomy: Tape Worm (55) is mammal-only, birds carry Worm Infestation (60). */
const taxonomies: TaxonomyContext = {
    species: [
        { id: 'cattle', label: 'Cattle', speciesType: 'mammal' },
        { id: 'chicken', label: 'Chicken', speciesType: 'bird' },
        { id: 'parrot', label: 'Parrot', speciesType: 'bird' },
    ],
    clinicalSigns: [
        { id: '79', label: 'Weight loss', speciesType: 'mammal' },
        { id: '26', label: 'Fever', speciesType: 'mammal' },
        { id: '279', label: 'Weight loss', speciesType: 'bird' },
        { id: '28', label: 'Ruffled feathers', speciesType: 'bird' },
    ],
    tentativeDiagnoses: [
        { id: '55', label: 'Tape Worm', species: 'cattle' },
        { id: '21', label: 'Ephemeral Fever', species: 'cattle' },
        { id: '60', label: 'Worm Infestation', species: 'chicken' },
        { id: '46', label: 'Newcastle Disease', species: 'chicken' },
    ],
};

const mammal: PatientInput = {
    ownerName: 'Abdul Malek',
    unionId: '40',
    villageId: '50',
    species: 'cattle',
    patientType: 'herd',
    purpose: 'milk',
    herdSize: 5,
    sickCount: 1,
    deadCount: 0,
    clinicalSignIds: ['79'],
    tentativeDiagnosisIds: ['55'],
};

const bird: PatientInput = {
    ...mammal,
    species: 'chicken',
    patientType: 'flock',
    purpose: 'egg',
    clinicalSignIds: ['279'],
    tentativeDiagnosisIds: ['60'],
};

test('accepts a mammal carrying weight loss and Tape Worm', () => {
    assert.doesNotThrow(() => assertMandatoryChoices(mammal, 'mammal', taxonomies));
});

test('accepts a bird carrying weight loss and Worm Infestation', () => {
    assert.doesNotThrow(() => assertMandatoryChoices(bird, 'bird', taxonomies));
});

test('allows additional signs and diagnoses alongside the mandatory ones', () => {
    assert.doesNotThrow(() =>
        assertMandatoryChoices(
            { ...mammal, clinicalSignIds: ['26', '79'], tentativeDiagnosisIds: ['21', '55'] },
            'mammal',
            taxonomies,
        ),
    );
});

test('rejects a record missing the mandatory weight-loss sign', () => {
    assert.throws(
        () => assertMandatoryChoices({ ...mammal, clinicalSignIds: ['26'] }, 'mammal', taxonomies),
        /Clinical sign 79 \(weight loss\) is mandatory for mammal records/,
    );
    assert.throws(
        () => assertMandatoryChoices({ ...bird, clinicalSignIds: ['28'] }, 'bird', taxonomies),
        /Clinical sign 279 \(weight loss\) is mandatory for bird records/,
    );
});

test('rejects a record missing the mandatory worm diagnosis', () => {
    assert.throws(
        () => assertMandatoryChoices({ ...mammal, tentativeDiagnosisIds: ['21'] }, 'mammal', taxonomies),
        /Tentative diagnosis 55 \(worm\) is mandatory for mammal records/,
    );
    assert.throws(
        () => assertMandatoryChoices({ ...bird, tentativeDiagnosisIds: ['46'] }, 'bird', taxonomies),
        /Tentative diagnosis 60 \(worm\) is mandatory for bird records/,
    );
});

test('rejects the bird weight-loss sign on a mammal record and vice versa', () => {
    assert.throws(
        () => assertMandatoryChoices({ ...mammal, clinicalSignIds: ['279'] }, 'mammal', taxonomies),
        /Clinical sign 279 is not valid for species type mammal/,
    );
    assert.throws(
        () => assertMandatoryChoices({ ...bird, clinicalSignIds: ['79'] }, 'bird', taxonomies),
        /Clinical sign 79 is not valid for species type bird/,
    );
});

test('rejects Tape Worm on a bird, which has no such diagnosis', () => {
    assert.throws(
        () => assertMandatoryChoices({ ...bird, tentativeDiagnosisIds: ['55'] }, 'bird', taxonomies),
        /Tentative diagnosis 60 is not valid for species chicken|Tentative diagnosis 55 is not valid for species chicken/,
    );
});

test('fails loudly for a species whose taxonomy lacks the mandatory diagnosis', () => {
    // parrot has no diagnoses at all; the rule must surface that rather than skip silently.
    assert.throws(
        () => assertMandatoryChoices({ ...bird, species: 'parrot' }, 'bird', taxonomies),
        /Tentative diagnosis 60 is not valid for species parrot/,
    );
});

test('a mammal herd at the form ceiling is accepted and one over it is rejected', () => {
    assert.doesNotThrow(() => assertHerdSize(999, 'mammal'));
    assert.throws(() => assertHerdSize(1000, 'mammal'), /cannot exceed 999 for mammal/);
});

test('birds carry the much larger flock ceiling the form allows', () => {
    assert.doesNotThrow(() => assertHerdSize(1_000_000, 'bird'));
    assert.throws(() => assertHerdSize(1_000_001, 'bird'), /cannot exceed 1000000 for bird/);
});

test('the herd ceilings match the constraint the pinned form contract covers', () => {
    // Form bind: . > 0 and ((species_type = 'mammal' and . < 1000) or (species_type = 'bird' and . < 1000001))
    assert.equal(MAX_HERD_SIZE.mammal, 1000 - 1);
    assert.equal(MAX_HERD_SIZE.bird, 1000001 - 1);
});
