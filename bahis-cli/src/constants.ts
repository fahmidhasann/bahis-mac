import type { SpeciesType } from './types.js';

export const SERVER_NAME = 'bahis-patient-registry';
export const CLI_VERSION = '1.0.0';

export const PATIENT_REGISTRY_FORM_UID = 'ajAsiLXLghXg2c2BXFMQbV';
export const SUPPORTED_REQUIRED_CONTRACT_SHA256 = 'd840ad9d7310b8c7cb17f54e3d62c3156a3fe7f2430afb5103f12a940412c6d8';
export const UUID_NAMESPACE = '7fd9bd30-2f4a-5a7d-ae9c-a77e4b82931e';

export const DEFAULT_BAHIS_SERVER_URL = 'https://bman.dls.gov.bd';
export const DEFAULT_KOBO_KF_API_URL = 'https://bf.dls.gov.bd/api/v2/';
export const DEFAULT_KOBO_KC_API_URL = 'https://bcat.dls.gov.bd/api/v1/';

export const PRODUCTION_HOSTS = new Set(['bman.dls.gov.bd', 'bf.dls.gov.bd', 'bcat.dls.gov.bd']);
/**
 * Upper bound on herd_flock_size, mirroring the form's own constraint:
 *   . > 0 and ((species_type = 'mammal' and . < 1000) or (species_type = 'bird' and . < 1000001))
 *
 * Enforced locally so an oversized herd fails before upload instead of being rejected by the
 * server after the write. Keep in step with SUPPORTED_REQUIRED_CONTRACT_SHA256: if that hash
 * changes because this bind changed, these numbers move with it.
 */
export const MAX_HERD_SIZE: Record<SpeciesType, number> = { mammal: 999, bird: 1_000_000 };

export const MAX_BATCH_SIZE = 50;
export const UPLOAD_CONCURRENCY = 3;
export const MAX_UPLOAD_ATTEMPTS = 3;
export const VERIFY_POLL_INTERVAL_MS = 2_000;
export const VERIFY_TIMEOUT_MS = 60_000;

export const COMPARED_FIELD_PATHS = [
    'basic_info/date',
    'basic_info/division',
    'basic_info/district',
    'basic_info/upazila',
    'basic_info/union',
    'basic_info/village',
    'basic_info/owner',
    'patient_info/species_type',
    'patient_info/species',
    'patient_info/patient_type',
    'patient_info/species_rearing_purpose',
    'patient_info/herd_flock_size',
    'patient_info/sick_number',
    'patient_info/dead_number',
    'patient_info/clinical_signs',
    'diagnosis_treatment/tentative_diagnosis',
    'diagnosis_treatment/ab1/product1_type',
    'diagnosis_treatment/gov1/gov_product1_type',
] as const;

/**
 * Choices every generated record must carry, keyed by species type.
 *
 * Tape Worm exists only for the eight mammal species; birds carry Worm Infestation
 * instead, which is the closest equivalent the taxonomy offers.
 */
export const MANDATORY_WEIGHT_LOSS_SIGN: Record<SpeciesType, string> = { mammal: '79', bird: '279' };
export const MANDATORY_WORM_DIAGNOSIS: Record<SpeciesType, string> = { mammal: '55', bird: '60' };

export const MULTI_SELECT_PATHS = new Set<string>([
    'patient_info/clinical_signs',
    'diagnosis_treatment/tentative_diagnosis',
]);

export const INTEGER_PATHS = new Set<string>([
    'patient_info/herd_flock_size',
    'patient_info/sick_number',
    'patient_info/dead_number',
]);
