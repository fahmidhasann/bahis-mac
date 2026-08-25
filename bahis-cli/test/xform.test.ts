import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { Element as XmlElement } from '@xmldom/xmldom';
import { deterministicUuid } from '../src/util.js';
import {
    assertSemanticChoices,
    denamespacedXml,
    fieldHashesFromXml,
    mismatchFields,
    patientChoiceValues,
} from '../src/xform.js';
import type { TaxonomyContext } from '../src/taxonomy.js';
import type { LocationChoice, PatientInput, ResolvedLocation } from '../src/types.js';

const xml = (signs: string, herd = '01') => `
<ajAsiLXLghXg2c2BXFMQbV>
  <basic_info><date>2026-08-09</date><division>DHAKA</division><district>DHAKA</district><upazila>SAVAR</upazila><union>40</union><village>AUKPARA</village><owner>A &amp; B</owner></basic_info>
  <patient_info><species_type>mammal</species_type><species>cattle</species><patient_type>herd</patient_type><species_rearing_purpose>milk</species_rearing_purpose><herd_flock_size>${herd}</herd_flock_size><sick_number>1</sick_number><dead_number>0</dead_number><clinical_signs>${signs}</clinical_signs></patient_info>
  <diagnosis_treatment><tentative_diagnosis>8 2</tentative_diagnosis><ab1><product1_type>2</product1_type></ab1><gov1><gov_product1_type>2</gov_product1_type></gov1></diagnosis_treatment>
</ajAsiLXLghXg2c2BXFMQbV>`;

const taxonomies: TaxonomyContext = {
    species: [
        { id: 'cattle', label: 'Cattle', speciesType: 'mammal' },
        { id: 'chicken', label: 'Chicken', speciesType: 'bird' },
    ],
    clinicalSigns: [
        { id: '1', label: 'Fever', speciesType: 'mammal' },
        { id: '2', label: 'Cough', speciesType: 'mammal' },
        { id: '3', label: 'Ruffled feathers', speciesType: 'bird' },
    ],
    tentativeDiagnoses: [
        { id: '2', label: 'Anthrax', species: 'cattle' },
        { id: '8', label: 'Babesiosis', species: 'cattle' },
        { id: '9', label: 'Newcastle Disease', species: 'chicken' },
    ],
};

const locations: LocationChoice[] = [
    { id: '40', label: 'ASHULIA', villages: [{ id: '50', label: 'AUKPARA' }] },
];

test('deterministic UUIDs are stable and version 5', () => {
    const first = deterministicUuid('batch:0');
    assert.equal(first, deterministicUuid('batch:0'));
    assert.notEqual(first, deterministicUuid('batch:1'));
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('required-field comparison normalizes integer and multi-select ordering', () => {
    const expected = fieldHashesFromXml(xml('2 1'));
    assert.deepEqual(mismatchFields(expected, xml('1 2', '1')), []);
    assert.deepEqual(mismatchFields(expected, xml('1 3')), ['patient_info/clinical_signs']);
});

test('choice serialization uses the union ID and village label', () => {
    const patient: PatientInput = {
        ownerName: 'Abdul Malek',
        unionId: '40',
        villageId: '50',
        species: 'cattle',
        patientType: 'herd',
        purpose: 'milk',
        herdSize: 2,
        sickCount: 1,
        deadCount: 0,
        clinicalSignIds: ['2', '1', '2'],
        tentativeDiagnosisIds: ['8', '2', '8'],
    };
    const location: ResolvedLocation = {
        union: { id: '40', label: 'ASHULIA' },
        village: { id: '50', label: 'AUKPARA' },
    };
    assert.deepEqual(patientChoiceValues(patient, 'mammal', location), {
        'basic_info/union': '40',
        'basic_info/village': 'AUKPARA',
        'patient_info/species_type': 'mammal',
        'patient_info/species': 'cattle',
        'patient_info/patient_type': 'herd',
        'patient_info/species_rearing_purpose': 'milk',
        'patient_info/clinical_signs': '2 1',
        'diagnosis_treatment/tentative_diagnosis': '8 2',
    });
});

test('semantic choice validation accepts valid IDs and rejects labels or incompatible taxonomy IDs', () => {
    assert.doesNotThrow(() => assertSemanticChoices(xml('2 1'), taxonomies, locations));
    assert.throws(
        () => assertSemanticChoices(xml('2 1').replace('<union>40</union>', '<union>ASHULIA</union>'), taxonomies, locations),
        /basic_info\/union/,
    );
    assert.throws(
        () => assertSemanticChoices(xml('2 1').replace('<species>cattle</species>', '<species>unknown</species>'), taxonomies, locations),
        /patient_info\/species/,
    );
    assert.throws(() => assertSemanticChoices(xml('3'), taxonomies, locations), /patient_info\/clinical_signs/);
    assert.throws(
        () =>
            assertSemanticChoices(
                xml('2 1').replace('<tentative_diagnosis>8 2</tentative_diagnosis>', '<tentative_diagnosis>9</tentative_diagnosis>'),
                taxonomies,
                locations,
            ),
        /diagnosis_treatment\/tentative_diagnosis/,
    );
});

/**
 * A minimal stand-in for the real form: the XForms default namespace lives on the
 * outer element, exactly as it does on `<h:html>` in the deployed Patient Registry
 * form, so a cloned instance root inherits it the same way.
 */
const namespacedInstanceRoot = () => {
    const form = `<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml" xmlns:orx="http://openrosa.org/xforms">
        <h:head><model><instance>
            <ajAsiLXLghXg2c2BXFMQbV id="ajAsiLXLghXg2c2BXFMQbV" orx:version="1">
                <basic_info><owner>A &amp; B</owner></basic_info>
                <start>2026-08-09T17:48:00.000+06:00</start>
                <meta><instanceID/></meta>
            </ajAsiLXLghXg2c2BXFMQbV>
        </instance></model></h:head>
    </h:html>`;
    const document = new DOMParser().parseFromString(form, 'application/xml');
    const root = document.getElementsByTagName('ajAsiLXLghXg2c2BXFMQbV')[0];
    return root.cloneNode(true) as XmlElement;
};

test('a cloned instance root inherits the XForms default namespace', () => {
    // Guards the premise of the next test: without denamespacing, this is what we serialize.
    const inherited = new XMLSerializer().serializeToString(namespacedInstanceRoot());

    assert.match(inherited, /xmlns="http:\/\/www\.w3\.org\/2002\/xforms"/);
});

test('submission XML is serialized in no namespace so the desktop app can read it', () => {
    const serialized = denamespacedXml(namespacedInstanceRoot());

    // The BAHIS sync parser resolved meta/instanceID with an unprefixed XPath, which
    // matches only namespace-free elements. Any xmlns here made records invisible.
    assert.ok(!serialized.includes('xmlns'), `expected no namespace declaration, got: ${serialized}`);

    const reparsed = new DOMParser().parseFromString(serialized, 'application/xml');
    assert.equal(reparsed.documentElement.namespaceURI, null);
    assert.equal(reparsed.documentElement.nodeName, 'ajAsiLXLghXg2c2BXFMQbV');
});

test('denamespacing preserves attributes, nesting and entity-escaped text', () => {
    const serialized = denamespacedXml(namespacedInstanceRoot());
    const root = new DOMParser().parseFromString(serialized, 'application/xml').documentElement;

    assert.equal(root.getAttribute('id'), 'ajAsiLXLghXg2c2BXFMQbV');
    assert.equal(root.getAttribute('version'), '1'); // prefix dropped, value kept
    assert.equal(root.getElementsByTagName('owner')[0].textContent, 'A & B');
    assert.equal(root.getElementsByTagName('start')[0].textContent, '2026-08-09T17:48:00.000+06:00');
    assert.equal(root.getElementsByTagName('instanceID').length, 1);
});
