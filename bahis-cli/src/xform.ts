import { createHash } from 'node:crypto';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { Document as XmlDocument, Element as XmlElement, Node as XmlNode } from '@xmldom/xmldom';
import {
    COMPARED_FIELD_PATHS,
    INTEGER_PATHS,
    MULTI_SELECT_PATHS,
    PATIENT_REGISTRY_FORM_UID,
    SUPPORTED_REQUIRED_CONTRACT_SHA256,
} from './constants.js';
import type { LocationChoice, PatientInput, PreparedRecord, RegionContext, ResolvedLocation } from './types.js';
import type { TaxonomyContext } from './taxonomy.js';
import { dhakaTimestamp, sha256, todayInDhaka } from './util.js';

function elements(node: XmlNode): XmlElement[] {
    return Array.from(node.childNodes).filter((child): child is XmlElement => child.nodeType === 1);
}

function localName(element: XmlElement): string {
    return element.localName || element.nodeName.replace(/^.*:/, '');
}

function allElements(node: XmlDocument | XmlElement): XmlElement[] {
    return Array.from(node.getElementsByTagName('*'));
}

function findPath(root: XmlElement, path: string): XmlElement {
    let current = root;
    for (const segment of path.split('/')) {
        const next = elements(current).find((child) => localName(child) === segment);
        if (!next) throw new Error(`The Patient Registry XForm is missing ${path}.`);
        current = next;
    }
    return current;
}

function setPath(root: XmlElement, path: string, value: string): void {
    const element = findPath(root, path);
    while (element.firstChild) element.removeChild(element.firstChild);
    const ownerDocument = element.ownerDocument;
    if (!ownerDocument) throw new Error(`The XForm element ${path} has no owner document.`);
    if (value !== '') element.appendChild(ownerDocument.createTextNode(value));
}

function primaryInstanceRoot(document: XmlDocument): XmlElement {
    const model = allElements(document).find((element) => localName(element) === 'model');
    if (!model) throw new Error('The XForm model element was not found.');
    const instance = elements(model).find((element) => localName(element) === 'instance' && !element.getAttribute('id'));
    if (!instance) throw new Error('The primary XForm instance was not found.');
    const root = elements(instance)[0];
    if (!root || localName(root) !== PATIENT_REGISTRY_FORM_UID) {
        throw new Error('The primary XForm instance does not match the Patient Registry form UID.');
    }
    return root;
}

function submissionRoot(document: XmlDocument): XmlElement {
    let root = document.documentElement;
    if (!root) throw new Error('The XML document has no root element.');
    if (localName(root) === 'root') {
        const results = elements(root).find((element) => localName(element) === 'results');
        const submission = results ? elements(results)[0] : undefined;
        if (!submission) throw new Error('Kobo returned no submission XML.');
        root = submission;
    }
    return root;
}

function removeTemplateNodes(root: XmlElement): void {
    for (const child of [...elements(root)]) {
        const isTemplate = Array.from(child.attributes).some(
            (attribute) => (attribute.localName || attribute.name.replace(/^.*:/, '')) === 'template',
        );
        if (isTemplate) root.removeChild(child);
        else removeTemplateNodes(child);
    }
}

/**
 * Rebuild a subtree in no namespace.
 *
 * The primary instance root inherits the XForms default namespace from the form's
 * `<h:html xmlns="http://www.w3.org/2002/xforms">`, and the serializer then writes an
 * explicit `xmlns` onto every submission. Enketo emits its instance root in no
 * namespace, so matching that keeps our records identical in shape to human ones.
 */
function denamespaceInto(source: XmlElement, ownerDocument: XmlDocument): XmlElement {
    const copy = ownerDocument.createElement(localName(source));
    for (const attribute of Array.from(source.attributes)) {
        const name = attribute.name;
        if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
        copy.setAttribute(localName(attribute as unknown as XmlElement), attribute.value);
    }
    for (const child of Array.from(source.childNodes)) {
        if (child.nodeType === 1) copy.appendChild(denamespaceInto(child as XmlElement, ownerDocument));
        else if (child.nodeType === 3) copy.appendChild(ownerDocument.createTextNode(child.nodeValue ?? ''));
    }
    return copy;
}

/** Serialize a submission instance so it carries no namespace declaration at all. */
export function denamespacedXml(source: XmlElement): string {
    const ownerDocument = source.ownerDocument;
    if (!ownerDocument) throw new Error('The XForm instance root has no owner document.');
    return new XMLSerializer().serializeToString(denamespaceInto(source, ownerDocument));
}

function calculatedLiteral(document: XmlDocument, suffix: string): string {
    const bind = allElements(document).find(
        (element) => localName(element) === 'bind' && element.getAttribute('nodeset')?.endsWith(suffix),
    );
    const calculate = bind?.getAttribute('calculate')?.trim() ?? '';
    const match = calculate.match(/^['"](.*)['"]$/);
    if (!match) throw new Error(`The XForm calculation for ${suffix} is missing or unsupported.`);
    return match[1];
}

export function requiredContractHash(formXml: string): string {
    const document = new DOMParser().parseFromString(formXml, 'application/xml');
    const contract = allElements(document)
        .filter((element) => localName(element) === 'bind' && element.getAttribute('required') === 'true()')
        .map((element) => {
            const result: Record<string, string> = {};
            for (const key of ['constraint', 'nodeset', 'readonly', 'relevant', 'required', 'type']) {
                const value = element.getAttribute(key);
                if (value !== null && value !== '') result[key] = value.trim();
            }
            return result;
        })
        .sort((left, right) => left.nodeset.localeCompare(right.nodeset));
    return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

export function assertCompatibleForm(formXml: string): string {
    const hash = requiredContractHash(formXml);
    if (hash !== SUPPORTED_REQUIRED_CONTRACT_SHA256) {
        throw new Error(
            `Patient Registry required fields or constraints changed (contract ${hash}). Update the CLI before submitting.`,
        );
    }
    return hash;
}

/**
 * Report a stale cached form without blocking on it.
 *
 * Submission XML is always built from the form fetched live from Kobo, so a cached copy that has
 * fallen behind the server cannot corrupt a submission - it only means the desktop app is showing
 * an older version of the form and should sync. That is a warning, not a reason to refuse a write.
 */
export function formContractWarning(formXml: string, label: string): string | undefined {
    const hash = requiredContractHash(formXml);
    if (hash === SUPPORTED_REQUIRED_CONTRACT_SHA256) return undefined;
    return `The ${label} Patient Registry form is out of date (contract ${hash}). Open BAHIS and sync to refresh it.`;
}

function normalizedValue(path: string, value: string): string {
    const trimmed = value.trim().replace(/\s+/g, ' ');
    if (MULTI_SELECT_PATHS.has(path)) return trimmed.split(' ').filter(Boolean).sort().join(' ');
    if (INTEGER_PATHS.has(path) && /^-?\d+$/.test(trimmed)) return String(Number(trimmed));
    return trimmed;
}

export function fieldHashesFromXml(xml: string): Record<string, string> {
    const document = new DOMParser().parseFromString(xml, 'application/xml');
    const root = submissionRoot(document);
    const hashes: Record<string, string> = {};
    for (const path of COMPARED_FIELD_PATHS) {
        hashes[path] = sha256(normalizedValue(path, findPath(root, path).textContent ?? ''));
    }
    return hashes;
}

function valueAt(root: XmlElement, path: string): string {
    return normalizedValue(path, findPath(root, path).textContent ?? '');
}

function choiceValues(value: string): string[] {
    return value.split(' ').filter(Boolean);
}

export class SemanticChoiceError extends Error {
    constructor(
        readonly path: string,
        value: string,
    ) {
        super(`Patient Registry XML has invalid ${path} choice ${value || '(empty)'}.`);
    }
}

function assertChoice(condition: boolean, path: string, value: string): void {
    if (!condition) throw new SemanticChoiceError(path, value);
}

export function assertSemanticChoices(
    xml: string,
    taxonomies: TaxonomyContext,
    locations: LocationChoice[],
): void {
    const document = new DOMParser().parseFromString(xml, 'application/xml');
    const root = submissionRoot(document);
    const unionId = valueAt(root, 'basic_info/union');
    const villageLabel = valueAt(root, 'basic_info/village');
    const location = locations.find((choice) => choice.id === unionId);
    assertChoice(Boolean(location), 'basic_info/union', unionId);
    assertChoice(
        Boolean(location?.villages.some((choice) => choice.label === villageLabel)),
        'basic_info/village',
        villageLabel,
    );

    const speciesType = valueAt(root, 'patient_info/species_type');
    const speciesId = valueAt(root, 'patient_info/species');
    const species = taxonomies.species.find((choice) => choice.id === speciesId);
    assertChoice(Boolean(species), 'patient_info/species', speciesId);
    assertChoice(species?.speciesType === speciesType, 'patient_info/species_type', speciesType);

    const patientType = valueAt(root, 'patient_info/patient_type');
    assertChoice(
        patientType === 'household' ||
            (speciesType === 'mammal' && patientType === 'herd') ||
            (speciesType === 'bird' && patientType === 'flock'),
        'patient_info/patient_type',
        patientType,
    );
    const purpose = valueAt(root, 'patient_info/species_rearing_purpose');
    assertChoice(
        ['meat', 'hobby', 'multi'].includes(purpose) ||
            (speciesType === 'bird' && purpose === 'egg') ||
            (speciesType === 'mammal' && ['milk', 'working', 'fibre'].includes(purpose)),
        'patient_info/species_rearing_purpose',
        purpose,
    );

    const clinicalSignIds = choiceValues(valueAt(root, 'patient_info/clinical_signs'));
    assertChoice(clinicalSignIds.length > 0, 'patient_info/clinical_signs', '');
    for (const id of clinicalSignIds) {
        assertChoice(
            taxonomies.clinicalSigns.some((choice) => choice.id === id && choice.speciesType === speciesType),
            'patient_info/clinical_signs',
            id,
        );
    }
    const tentativeDiagnosisIds = choiceValues(valueAt(root, 'diagnosis_treatment/tentative_diagnosis'));
    assertChoice(tentativeDiagnosisIds.length > 0, 'diagnosis_treatment/tentative_diagnosis', '');
    for (const id of tentativeDiagnosisIds) {
        assertChoice(
            taxonomies.tentativeDiagnoses.some((choice) => choice.id === id && choice.species === speciesId),
            'diagnosis_treatment/tentative_diagnosis',
            id,
        );
    }
}

export function patientChoiceValues(
    input: PatientInput,
    speciesType: 'mammal' | 'bird',
    location: ResolvedLocation,
): Record<string, string> {
    return {
        'basic_info/union': location.union.id,
        'basic_info/village': location.village.label,
        'patient_info/species_type': speciesType,
        'patient_info/species': input.species,
        'patient_info/patient_type': input.patientType,
        'patient_info/species_rearing_purpose': input.purpose,
        'patient_info/clinical_signs': [...new Set(input.clinicalSignIds)].join(' '),
        'diagnosis_treatment/tentative_diagnosis': [...new Set(input.tentativeDiagnosisIds)].join(' '),
    };
}

export function mismatchFields(expected: Record<string, string>, actualXml: string): string[] {
    const actual = fieldHashesFromXml(actualXml);
    return Object.keys(expected).filter((path) => expected[path] !== actual[path]);
}

export function buildPatientRecord(
    formXml: string,
    input: PatientInput,
    speciesType: 'mammal' | 'bird',
    region: RegionContext,
    location: ResolvedLocation,
    uuid: string,
    index: number,
    now = new Date(),
): PreparedRecord {
    assertCompatibleForm(formXml);
    const document = new DOMParser().parseFromString(formXml, 'application/xml');
    const root = primaryInstanceRoot(document).cloneNode(true) as XmlElement;
    removeTemplateNodes(root);

    const visitDate = input.visitDate ?? todayInDhaka(now);
    const timestamp = dhakaTimestamp(now);
    setPath(root, 'formhub/uuid', calculatedLiteral(document, '/formhub/uuid'));
    setPath(root, 'start', timestamp);
    setPath(root, 'end', timestamp);
    setPath(root, 'basic_info/date', visitDate);
    setPath(root, 'basic_info/division', region.division.title);
    setPath(root, 'basic_info/district', region.district.title);
    setPath(root, 'basic_info/upazila', region.upazila.title);
    const choices = patientChoiceValues(input, speciesType, location);
    setPath(root, 'basic_info/union', choices['basic_info/union']);
    setPath(root, 'basic_info/village', choices['basic_info/village']);
    setPath(root, 'basic_info/owner', input.ownerName);
    setPath(root, 'patient_info/species_type', choices['patient_info/species_type']);
    setPath(root, 'patient_info/species', choices['patient_info/species']);
    setPath(root, 'patient_info/patient_type', choices['patient_info/patient_type']);
    setPath(root, 'patient_info/species_rearing_purpose', choices['patient_info/species_rearing_purpose']);
    setPath(root, 'patient_info/herd_flock_size', String(input.herdSize));
    setPath(root, 'patient_info/sick_number', String(input.sickCount));
    setPath(root, 'patient_info/dead_number', String(input.deadCount));
    setPath(root, 'patient_info/clinical_signs', choices['patient_info/clinical_signs']);
    setPath(root, 'diagnosis_treatment/tentative_diagnosis', choices['diagnosis_treatment/tentative_diagnosis']);
    setPath(root, 'diagnosis_treatment/ab1/product1_type', '2');
    setPath(root, 'diagnosis_treatment/gov1/gov_product1_type', '2');
    setPath(root, '__version__', calculatedLiteral(document, '/__version__'));
    setPath(root, 'meta/instanceID', `uuid:${uuid}`);

    const xml = denamespacedXml(root);
    return { index, uuid, xml, fieldHashes: fieldHashesFromXml(xml) };
}
