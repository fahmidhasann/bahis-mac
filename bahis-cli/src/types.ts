export type SpeciesType = 'mammal' | 'bird';

/** Which end of the registry history a summary samples from. */
export type SampleOrder = 'oldest' | 'newest';
export type PatientType = 'household' | 'herd' | 'flock';
export type Purpose = 'milk' | 'meat' | 'egg' | 'working' | 'hobby' | 'fibre' | 'multi';
export type RecordStatus = 'draft' | 'accepted' | 'verified' | 'failed';

export interface PatientInput {
    ownerName: string;
    visitDate?: string;
    unionId: string;
    villageId: string;
    species: string;
    patientType: PatientType;
    purpose: Purpose;
    herdSize: number;
    sickCount: number;
    deadCount: number;
    clinicalSignIds: string[];
    tentativeDiagnosisIds: string[];
}

export interface SubmitBatchInput {
    requestId: string;
    records: PatientInput[];
}

export interface RegionContext {
    division: { id: number; title: string };
    district: { id: number; title: string };
    upazila: { id: number; title: string };
}

export interface LocationChoice {
    id: string;
    label: string;
    villages: Array<{ id: string; label: string }>;
}

export interface ResolvedLocation {
    union: { id: string; label: string };
    village: { id: string; label: string };
}

export interface SpeciesChoice {
    id: string;
    label: string;
    speciesType: SpeciesType;
}

export interface TaxonomyChoice {
    id: string;
    label: string;
}

export interface PatientContext {
    formUid: string;
    contractHash: string;
    region: RegionContext;
    locations: LocationChoice[];
    species: SpeciesChoice[];
    clinicalSigns: TaxonomyChoice[];
    tentativeDiagnoses: TaxonomyChoice[];
    rules: string[];
}

export interface CountedChoice {
    id: string;
    count: number;
}

export interface NumericSummary {
    min: number;
    median: number;
    max: number;
}

export interface RecentSpeciesProfile {
    species: string;
    count: number;
    patientTypes: CountedChoice[];
    purposes: CountedChoice[];
    herdSize: NumericSummary;
    sickCount: NumericSummary;
    deadCount: NumericSummary;
    clinicalSigns: CountedChoice[];
    tentativeDiagnoses: CountedChoice[];
}

export interface RecentLocationPattern {
    unionId: string;
    villageId: string;
    count: number;
}

export interface RecentClinicalPattern {
    species: string;
    patientType: PatientType;
    purpose: Purpose;
    clinicalSignIds: string[];
    tentativeDiagnosisIds: string[];
    count: number;
}

export interface RecentPatientSummary {
    requestedLimit: number;
    order: SampleOrder;
    oldestDate?: string;
    newestDate?: string;
    scannedRecordCount: number;
    usableRecordCount: number;
    skippedRecordCount: number;
    speciesProfiles: RecentSpeciesProfile[];
    locationPatterns: RecentLocationPattern[];
    clinicalPatterns: RecentClinicalPattern[];
}

export interface PreparedRecord {
    index: number;
    uuid: string;
    xml: string;
    fieldHashes: Record<string, string>;
}

export interface RecordResult {
    index: number;
    uuid: string;
    uploadStatus: RecordStatus;
    verificationStatus: 'not_checked' | 'matched' | 'missing' | 'mismatched';
    mismatchFields?: string[];
    error?: string;
}

export interface BatchResult {
    batchId: string;
    requested: number;
    accepted: number;
    verified: number;
    failed: number;
    records: RecordResult[];
}

export interface StatusResult {
    databaseFound: boolean;
    authenticated: boolean;
    productionWritesEnabled: boolean;
    serverReachable: boolean;
    formCompatible: boolean;
    semanticChoiceValidation: boolean;
    formUid: string;
    region?: RegionContext;
    pendingDrafts: number;
    warnings: string[];
}

export interface JournalRecord {
    batchId: string;
    recordIndex: number;
    uuid: string;
    status: RecordStatus;
    fieldHashes: Record<string, string>;
    mismatchFields: string[];
    error?: string;
}
