import { DOMParser } from '@xmldom/xmldom';
import type { Element as XmlElement, Node as XmlNode } from '@xmldom/xmldom';
import { PATIENT_REGISTRY_FORM_UID } from './constants.js';
import type { TaxonomyContext } from './taxonomy.js';
import type {
    CountedChoice,
    LocationChoice,
    NumericSummary,
    PatientType,
    Purpose,
    RecentClinicalPattern,
    RecentPatientSummary,
    RecentSpeciesProfile,
    SampleOrder,
} from './types.js';

interface ParsedPatientRecord {
    species: string;
    patientType: PatientType;
    purpose: Purpose;
    herdSize: number;
    sickCount: number;
    deadCount: number;
    clinicalSignIds: string[];
    tentativeDiagnosisIds: string[];
    /** `basic_info/union` holds the union *id* in production, and a bare label in a few older rows. */
    unionRef: string;
    /** `basic_info/village` is genuinely a label, and is free-text human entry. */
    villageLabel: string;
    visitDate?: string;
}

interface SpeciesAccumulator {
    count: number;
    patientTypes: Map<string, number>;
    purposes: Map<string, number>;
    herdSizes: number[];
    sickCounts: number[];
    deadCounts: number[];
    clinicalSigns: Map<string, number>;
    tentativeDiagnoses: Map<string, number>;
}

const PATIENT_TYPES = new Set<PatientType>(['household', 'herd', 'flock']);
const PURPOSES = new Set<Purpose>(['milk', 'meat', 'egg', 'working', 'hobby', 'fibre', 'multi']);
const MIN_AGGREGATE_COHORT = 5;

function elements(node: XmlNode): XmlElement[] {
    return Array.from(node.childNodes).filter((child): child is XmlElement => child.nodeType === 1);
}

function localName(element: XmlElement): string {
    return element.localName || element.nodeName.replace(/^.*:/, '');
}

function submissionRoot(xml: string): XmlElement | undefined {
    const document = new DOMParser().parseFromString(xml, 'application/xml');
    let root: XmlElement | undefined = document.documentElement ?? undefined;
    if (!root || localName(root) === 'parsererror') return undefined;
    if (localName(root) === 'root') {
        const results = elements(root).find((element) => localName(element) === 'results');
        root = results ? elements(results)[0] : undefined;
    }
    return root && localName(root) === PATIENT_REGISTRY_FORM_UID ? root : undefined;
}

function valueAt(root: XmlElement, path: string): string | undefined {
    let current = root;
    for (const segment of path.split('/')) {
        const next = elements(current).find((child) => localName(child) === segment);
        if (!next) return undefined;
        current = next;
    }
    const value = current.textContent?.trim();
    return value ? value : undefined;
}

function integerAt(root: XmlElement, path: string): number | undefined {
    const value = valueAt(root, path);
    if (!value || !/^\d+$/.test(value)) return undefined;
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : undefined;
}

function idsAt(root: XmlElement, path: string): string[] {
    return [...new Set((valueAt(root, path) ?? '').split(/\s+/).filter(Boolean))].sort();
}

function parseRecord(xml: string, taxonomies: TaxonomyContext): ParsedPatientRecord | undefined {
    const root = submissionRoot(xml);
    if (!root) return undefined;
    const species = valueAt(root, 'patient_info/species');
    const patientType = valueAt(root, 'patient_info/patient_type') as PatientType | undefined;
    const purpose = valueAt(root, 'patient_info/species_rearing_purpose') as Purpose | undefined;
    const herdSize = integerAt(root, 'patient_info/herd_flock_size');
    const sickCount = integerAt(root, 'patient_info/sick_number');
    const deadCount = integerAt(root, 'patient_info/dead_number');
    const unionRef = valueAt(root, 'basic_info/union');
    const villageLabel = valueAt(root, 'basic_info/village');
    if (
        !species ||
        !patientType ||
        !purpose ||
        herdSize === undefined ||
        sickCount === undefined ||
        deadCount === undefined ||
        !unionRef ||
        !villageLabel ||
        !PATIENT_TYPES.has(patientType) ||
        !PURPOSES.has(purpose)
    ) {
        return undefined;
    }
    const speciesChoice = taxonomies.species.find((choice) => choice.id === species);
    if (!speciesChoice || herdSize < 1 || sickCount > herdSize || deadCount > herdSize - sickCount) return undefined;
    if (speciesChoice.speciesType === 'bird' && patientType === 'herd') return undefined;
    if (speciesChoice.speciesType === 'mammal' && patientType === 'flock') return undefined;
    if (purpose === 'egg' && speciesChoice.speciesType !== 'bird') return undefined;
    if (['milk', 'working', 'fibre'].includes(purpose) && speciesChoice.speciesType !== 'mammal') return undefined;
    const clinicalSignIds = idsAt(root, 'patient_info/clinical_signs');
    const tentativeDiagnosisIds = idsAt(root, 'diagnosis_treatment/tentative_diagnosis');
    if (!clinicalSignIds.length || !tentativeDiagnosisIds.length) return undefined;
    if (
        clinicalSignIds.some(
            (id) => !taxonomies.clinicalSigns.some((choice) => choice.id === id && choice.speciesType === speciesChoice.speciesType),
        ) ||
        tentativeDiagnosisIds.some(
            (id) => !taxonomies.tentativeDiagnoses.some((choice) => choice.id === id && choice.species === species),
        )
    ) {
        return undefined;
    }
    return {
        species,
        patientType,
        purpose,
        herdSize,
        sickCount,
        deadCount,
        clinicalSignIds,
        tentativeDiagnosisIds,
        unionRef,
        villageLabel,
        visitDate: valueAt(root, 'basic_info/date'),
    };
}

function increment(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
}

function counted(map: Map<string, number>, limit?: number): CountedChoice[] {
    return [...map.entries()]
        .map(([id, count]) => ({ id, count }))
        .sort((left, right) => right.count - left.count || left.id.localeCompare(right.id))
        .slice(0, limit);
}

function numericSummary(values: number[]): NumericSummary {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const median =
        sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
    return { min: sorted[0], median, max: sorted[sorted.length - 1] };
}

function normalizedLabel(value: string): string {
    return value.trim().replace(/\s+/g, ' ').toLocaleUpperCase('en-US');
}

/** Case/space/punctuation-folded form, so `AMIN BAZAR`, `amin-bazar` and `aminbazar` collapse together. */
function foldedLabel(value: string): string {
    return value.replace(/[^\p{L}\p{N}]/gu, '').toLocaleUpperCase('en-US');
}

/**
 * Levenshtein distance, abandoned as soon as every cell in a row exceeds `max`.
 * Village labels are short, so the full matrix would be cheap anyway; the cap just keeps the
 * per-record cost flat as unions grow (PATHALIA already carries 33 villages).
 */
function editDistanceWithin(left: string, right: string, max: number): number | undefined {
    if (Math.abs(left.length - right.length) > max) return undefined;
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i += 1) {
        const current = [i, ...new Array<number>(right.length).fill(0)];
        for (let j = 1; j <= right.length; j += 1) {
            current[j] = Math.min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
            );
        }
        if (Math.min(...current) > max) return undefined;
        previous = current;
    }
    return previous[right.length] <= max ? previous[right.length] : undefined;
}

/**
 * Resolve `basic_info/union`, which carries a union **id** in production — `xform.ts` writes
 * `location.union.id`. A small tail of older rows carries a label instead, so the label path
 * stays as a fallback. An ambiguous label resolves to nothing.
 */
function resolveUnion(unionRef: string, locations: LocationChoice[]): LocationChoice | undefined {
    const byId = locations.find((union) => union.id === unionRef);
    if (byId) return byId;
    const byLabel = locations.filter((union) => normalizedLabel(union.label) === normalizedLabel(unionRef));
    return byLabel.length === 1 ? byLabel[0] : undefined;
}

/**
 * Resolve a free-text village label within one union, widening in three steps:
 * exact (modulo case/whitespace) -> punctuation-folded -> a single-character edit.
 *
 * Every step requires exactly one candidate. That uniqueness rule is what makes the fuzzy step
 * safe: SAVAR lists four identically-named villages, and those must stay unresolved rather than
 * be attributed to an arbitrary one of them. Widening stops at distance 1 deliberately — in the
 * live registry every distance-1 hit is a transliteration variant (`gerua`/`GARUA`,
 * `dhamsona`/`DHAMSANA`, `amin baazar`/`AMIN BAZAR`), whereas distance 2 begins merging
 * genuinely different villages (`ganda` is not `GARUA`). Unmatched values are dropped, never
 * guessed — most of them name places absent from the taxonomy altogether.
 */
function resolveVillage(villageLabel: string, union: LocationChoice): { id: string; label: string } | undefined {
    const exact = union.villages.filter((village) => normalizedLabel(village.label) === normalizedLabel(villageLabel));
    if (exact.length) return exact.length === 1 ? exact[0] : undefined;

    const target = foldedLabel(villageLabel);
    if (!target) return undefined;
    const folded = union.villages.filter((village) => foldedLabel(village.label) === target);
    if (folded.length) return folded.length === 1 ? folded[0] : undefined;

    const near = union.villages.filter(
        (village) => editDistanceWithin(target, foldedLabel(village.label), 1) !== undefined,
    );
    return near.length === 1 ? near[0] : undefined;
}

function resolveLocationIds(
    record: ParsedPatientRecord,
    locations: LocationChoice[],
): { unionId: string; villageId: string } | undefined {
    const union = resolveUnion(record.unionRef, locations);
    if (!union) return undefined;
    const village = resolveVillage(record.villageLabel, union);
    return village ? { unionId: union.id, villageId: village.id } : undefined;
}

export function summarizeRecentPatients(
    xmlRows: string[],
    requestedLimit: number,
    taxonomies: TaxonomyContext,
    locations: LocationChoice[],
    order: SampleOrder = 'newest',
): RecentPatientSummary {
    // Filter first, then take the window. The caller orders the rows; the unusable ones
    // (notably the oldest records, whose tentative_diagnosis is empty) must not consume window
    // slots or an oldest-N request would return far fewer than N records.
    const usable = xmlRows
        .map((xml) => parseRecord(xml, taxonomies))
        .filter((record): record is ParsedPatientRecord => Boolean(record));
    const records = usable.slice(0, requestedLimit);
    const visitDates = records.map((record) => record.visitDate).filter((date): date is string => Boolean(date)).sort();
    const species = new Map<string, SpeciesAccumulator>();
    const locationCounts = new Map<string, number>();
    const clinicalCounts = new Map<string, { pattern: Omit<RecentClinicalPattern, 'count'>; count: number }>();

    for (const record of records) {
        const accumulator: SpeciesAccumulator = species.get(record.species) ?? {
            count: 0,
            patientTypes: new Map(),
            purposes: new Map(),
            herdSizes: [],
            sickCounts: [],
            deadCounts: [],
            clinicalSigns: new Map(),
            tentativeDiagnoses: new Map(),
        };
        accumulator.count += 1;
        increment(accumulator.patientTypes, record.patientType);
        increment(accumulator.purposes, record.purpose);
        accumulator.herdSizes.push(record.herdSize);
        accumulator.sickCounts.push(record.sickCount);
        accumulator.deadCounts.push(record.deadCount);
        for (const id of record.clinicalSignIds) increment(accumulator.clinicalSigns, id);
        for (const id of record.tentativeDiagnosisIds) increment(accumulator.tentativeDiagnoses, id);
        species.set(record.species, accumulator);

        const location = resolveLocationIds(record, locations);
        if (location) increment(locationCounts, `${location.unionId}\u0000${location.villageId}`);

        const clinicalKey = [
            record.species,
            record.patientType,
            record.purpose,
            record.clinicalSignIds.join(','),
            record.tentativeDiagnosisIds.join(','),
        ].join('\u0000');
        const existing = clinicalCounts.get(clinicalKey);
        if (existing) existing.count += 1;
        else {
            clinicalCounts.set(clinicalKey, {
                pattern: {
                    species: record.species,
                    patientType: record.patientType,
                    purpose: record.purpose,
                    clinicalSignIds: record.clinicalSignIds,
                    tentativeDiagnosisIds: record.tentativeDiagnosisIds,
                },
                count: 1,
            });
        }
    }

    const speciesProfiles: RecentSpeciesProfile[] = [...species.entries()]
        .filter(([, value]) => value.count >= MIN_AGGREGATE_COHORT)
        .map(([speciesId, value]) => ({
            species: speciesId,
            count: value.count,
            patientTypes: counted(value.patientTypes),
            purposes: counted(value.purposes),
            herdSize: numericSummary(value.herdSizes),
            sickCount: numericSummary(value.sickCounts),
            deadCount: numericSummary(value.deadCounts),
            clinicalSigns: counted(value.clinicalSigns, 8),
            tentativeDiagnoses: counted(value.tentativeDiagnoses, 8),
        }))
        .sort((left, right) => right.count - left.count || left.species.localeCompare(right.species));

    return {
        requestedLimit,
        order,
        oldestDate: visitDates[0],
        newestDate: visitDates[visitDates.length - 1],
        scannedRecordCount: xmlRows.length,
        usableRecordCount: records.length,
        skippedRecordCount: xmlRows.length - records.length,
        speciesProfiles,
        locationPatterns: counted(locationCounts)
            .filter(({ count }) => count >= MIN_AGGREGATE_COHORT)
            .slice(0, 20)
            .map(({ id, count }) => {
                const [unionId, villageId] = id.split('\u0000');
                return { unionId, villageId, count };
            }),
        clinicalPatterns: [...clinicalCounts.values()]
            .filter(({ count }) => count >= MIN_AGGREGATE_COHORT)
            .map(({ pattern, count }) => ({ ...pattern, count }))
            .sort((left, right) => right.count - left.count || left.species.localeCompare(right.species))
            .slice(0, 25),
    };
}
