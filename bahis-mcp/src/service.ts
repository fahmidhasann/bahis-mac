import fs from 'node:fs';
import {
    MANDATORY_WEIGHT_LOSS_SIGN,
    MANDATORY_WORM_DIAGNOSIS,
    MAX_HERD_SIZE,
    PATIENT_REGISTRY_FORM_UID,
    UPLOAD_CONCURRENCY,
    VERIFY_POLL_INTERVAL_MS,
    VERIFY_TIMEOUT_MS,
} from './constants.js';
import { assertWritesAllowed, type Config } from './config.js';
import { BahisDatabase, JournalDatabase } from './database.js';
import { KoboClient } from './kobo.js';
import { loadTaxonomies, type TaxonomyContext } from './taxonomy.js';
import type {
    BatchResult,
    JournalRecord,
    PatientContext,
    PatientInput,
    PreparedRecord,
    RecentPatientSummary,
    RecordResult,
    SampleOrder,
    SpeciesType,
    StatusResult,
    SubmitBatchInput,
} from './types.js';
import {
    assertCompatibleForm,
    assertSemanticChoices,
    formContractWarning,
    requiredContractHash,
    buildPatientRecord,
    mismatchFields,
    SemanticChoiceError,
} from './xform.js';
import { deterministicUuid, log, mapConcurrent, safeError, sha256, sleep as defaultSleep, todayInDhaka } from './util.js';
import { summarizeRecentPatients } from './summary.js';

export interface ValidationRecordResult {
    index: number;
    uuid?: string;
    valid: boolean;
    error?: string;
}

export interface ValidationResult {
    batchId: string;
    requested: number;
    valid: number;
    invalid: number;
    records: ValidationRecordResult[];
}

export interface ServiceApi {
    status(): Promise<StatusResult>;
    patientContext(species?: string[]): Promise<PatientContext>;
    recentPatientSummary(limit?: number, order?: SampleOrder): Promise<RecentPatientSummary>;
    submitPatientBatch(input: SubmitBatchInput): Promise<BatchResult>;
    verifyPatientBatch(batchId: string): Promise<BatchResult>;
    retryPatientBatch(batchId: string): Promise<BatchResult>;
}

interface Dependencies {
    fetchImpl?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => Date;
}

/**
 * Enforce the choices every generated record must carry.
 *
 * The taxonomy checks run over the mandatory ID as well as the supplied ones, so a species whose
 * taxonomy lacks the required choice fails loudly instead of silently skipping the rule. Extra
 * signs and diagnoses stay allowed: these are minimums, not an exclusive set.
 */
export function assertMandatoryChoices(
    input: PatientInput,
    speciesType: SpeciesType,
    taxonomies: TaxonomyContext,
): void {
    const mandatorySign = MANDATORY_WEIGHT_LOSS_SIGN[speciesType];
    const mandatoryDiagnosis = MANDATORY_WORM_DIAGNOSIS[speciesType];
    for (const id of new Set([mandatorySign, ...input.clinicalSignIds])) {
        if (!taxonomies.clinicalSigns.some((choice) => choice.id === id && choice.speciesType === speciesType)) {
            throw new Error(`Clinical sign ${id} is not valid for species type ${speciesType}.`);
        }
    }
    for (const id of new Set([mandatoryDiagnosis, ...input.tentativeDiagnosisIds])) {
        if (!taxonomies.tentativeDiagnoses.some((choice) => choice.id === id && choice.species === input.species)) {
            throw new Error(`Tentative diagnosis ${id} is not valid for species ${input.species}.`);
        }
    }
    if (!input.clinicalSignIds.includes(mandatorySign)) {
        throw new Error(`Clinical sign ${mandatorySign} (weight loss) is mandatory for ${speciesType} records.`);
    }
    if (!input.tentativeDiagnosisIds.includes(mandatoryDiagnosis)) {
        throw new Error(`Tentative diagnosis ${mandatoryDiagnosis} (worm) is mandatory for ${speciesType} records.`);
    }
}

/**
 * Enforce the form's herd_flock_size ceiling before upload.
 *
 * Exported alongside assertMandatoryChoices so the rule is testable on its own - the ceiling comes
 * from a form constraint that DLS has changed once already, and a silent drift here means records
 * that build cleanly and are then rejected by the server.
 */
export function assertHerdSize(herdSize: number, speciesType: SpeciesType): void {
    const limit = MAX_HERD_SIZE[speciesType];
    if (herdSize > limit) {
        throw new Error(`herdSize cannot exceed ${limit} for ${speciesType} records.`);
    }
}

export class BahisService implements ServiceApi {
    private readonly fetchImpl: typeof fetch;
    private readonly sleepImpl: (milliseconds: number) => Promise<void>;
    private readonly now: () => Date;

    constructor(
        private readonly config: Config,
        dependencies: Dependencies = {},
    ) {
        this.fetchImpl = dependencies.fetchImpl ?? fetch;
        this.sleepImpl = dependencies.sleep ?? defaultSleep;
        this.now = dependencies.now ?? (() => new Date());
    }

    private client(token: string): KoboClient {
        return new KoboClient(this.config, token, this.fetchImpl, this.sleepImpl);
    }

    async status(): Promise<StatusResult> {
        const warnings: string[] = [];
        if (!fs.existsSync(this.config.dbPath)) {
            return {
                databaseFound: false,
                authenticated: false,
                productionWritesEnabled: this.config.allowProductionWrites,
                serverReachable: false,
                formCompatible: false,
                semanticChoiceValidation: true,
                formUid: PATIENT_REGISTRY_FORM_UID,
                pendingDrafts: 0,
                warnings: ['BAHIS database not found. Open BAHIS and sign in once.'],
            };
        }
        const database = new BahisDatabase(this.config.dbPath, true);
        try {
            const token = database.getToken();
            // A stale cache cannot corrupt a submission - records are built from the live form - so
            // it is a warning. formCompatible answers the question that actually gates a write:
            // does the form on the server still match the contract this build was reviewed against?
            const staleForm = formContractWarning(database.getFormXml(), 'cached');
            if (staleForm) warnings.push(staleForm);
            let formCompatible = false;
            let serverReachable = false;
            if (token) {
                try {
                    serverReachable = await this.client(token).health();
                    if (!serverReachable) warnings.push('Kobo did not accept the current token.');
                } catch (error) {
                    warnings.push(`Kobo health check failed: ${safeError(error)}`);
                }
                try {
                    assertCompatibleForm(await this.client(token).fetchCurrentFormDefinition());
                    formCompatible = true;
                } catch (error) {
                    warnings.push(safeError(error));
                }
            } else {
                warnings.push('No BAHIS token is available. Run `bahis login`, or open BAHIS and sign in once.');
            }
            if (!this.config.allowProductionWrites) warnings.push('Production writes are disabled by configuration.');
            return {
                databaseFound: true,
                authenticated: Boolean(token),
                productionWritesEnabled: this.config.allowProductionWrites,
                serverReachable,
                formCompatible,
                semanticChoiceValidation: true,
                formUid: PATIENT_REGISTRY_FORM_UID,
                region: database.getUserRegion(),
                pendingDrafts: database.pendingDraftCount(),
                warnings,
            };
        } finally {
            database.close();
        }
    }

    async patientContext(speciesFilter?: string[]): Promise<PatientContext> {
        const database = new BahisDatabase(this.config.dbPath, true);
        try {
            const formXml = database.getFormXml();
            const contractHash = requiredContractHash(formXml);
            const taxonomies = loadTaxonomies(database);
            const selected = speciesFilter?.length ? new Set(speciesFilter) : undefined;
            if (selected) {
                for (const species of selected) {
                    if (!taxonomies.species.some((choice) => choice.id === species)) {
                        throw new Error(`Unknown species ${species}.`);
                    }
                }
            }
            const speciesTypes = new Set(
                taxonomies.species.filter((choice) => !selected || selected.has(choice.id)).map((choice) => choice.speciesType),
            );
            return {
                formUid: PATIENT_REGISTRY_FORM_UID,
                contractHash,
                region: database.getUserRegion(),
                locations: database.getLocations(),
                species: taxonomies.species.filter((choice) => !selected || selected.has(choice.id)),
                clinicalSigns: taxonomies.clinicalSigns
                    .filter((choice) => speciesTypes.has(choice.speciesType))
                    .map(({ id, label }) => ({ id, label })),
                tentativeDiagnoses: taxonomies.tentativeDiagnoses
                    .filter((choice) => !selected || selected.has(choice.species))
                    .map(({ id, label }) => ({ id, label })),
                rules: [
                    'Use only returned IDs, never display labels, in a submission.',
                    'Bird records may use household or flock; mammal records may use household or herd.',
                    'Egg is bird-only. Milk, working and fibre are mammal-only.',
                    'sickCount must not exceed herdSize; deadCount must not exceed herdSize - sickCount.',
                    'Choose clinically plausible signs and diagnoses for the selected species.',
                    `Always include clinical sign ${MANDATORY_WEIGHT_LOSS_SIGN.mammal} (weight loss) on mammal records and ${MANDATORY_WEIGHT_LOSS_SIGN.bird} on bird records, alongside any other plausible signs.`,
                    `Always include tentative diagnosis ${MANDATORY_WORM_DIAGNOSIS.mammal} (Tape Worm) on mammal records and ${MANDATORY_WORM_DIAGNOSIS.bird} (Worm Infestation) on bird records, alongside any other plausible diagnoses.`,
                    'Do not use an Other choice; its explanation field is intentionally outside this minimal workflow.',
                    'Use unique, natural-looking fictional Bengali owner names in Latin script. Never use synthetic, dummy, test, sample, placeholder or numbered owner labels.',
                    'Use only union and village IDs returned by this context. Never invent a location.',
                    'Use the recent Patient Registry summary only as a weighting signal; the current context and validation rules always win.',
                ],
            };
        } finally {
            database.close();
        }
    }

    async recentPatientSummary(limit = 200, order: SampleOrder = 'oldest'): Promise<RecentPatientSummary> {
        const database = new BahisDatabase(this.config.dbPath, true);
        try {
            const staleForm = formContractWarning(database.getFormXml(), 'cached');
            if (staleForm) log('stale_cached_form', { error: staleForm });
            const taxonomies = loadTaxonomies(database);
            return summarizeRecentPatients(
                database.getRecentPatientSubmissionXml(limit, order),
                limit,
                taxonomies,
                database.getLocations(),
                order,
            );
        } finally {
            database.close();
        }
    }

    private validatePatient(input: PatientInput, taxonomies: TaxonomyContext, database: BahisDatabase): 'mammal' | 'bird' {
        const species = taxonomies.species.find((choice) => choice.id === input.species);
        if (!species) throw new Error(`Unknown species ${input.species}.`);
        if (species.speciesType === 'bird' && input.patientType === 'herd') throw new Error('Bird records cannot use patientType herd.');
        if (species.speciesType === 'mammal' && input.patientType === 'flock') {
            throw new Error('Mammal records cannot use patientType flock.');
        }
        if (input.purpose === 'egg' && species.speciesType !== 'bird') throw new Error('Purpose egg is only valid for birds.');
        if (['milk', 'working', 'fibre'].includes(input.purpose) && species.speciesType !== 'mammal') {
            throw new Error(`Purpose ${input.purpose} is only valid for mammals.`);
        }
        assertHerdSize(input.herdSize, species.speciesType);
        if (input.sickCount > input.herdSize) throw new Error('sickCount cannot exceed herdSize.');
        if (input.deadCount > input.herdSize - input.sickCount) {
            throw new Error('deadCount cannot exceed herdSize - sickCount.');
        }
        const visitDate = input.visitDate ?? todayInDhaka(this.now());
        if (visitDate > todayInDhaka(this.now())) throw new Error('visitDate cannot be in the future.');
        assertMandatoryChoices(input, species.speciesType, taxonomies);
        database.resolveLocation(input.unionId, input.villageId);
        return species.speciesType;
    }

    /**
     * Run every check submitPatientBatch runs, without writing anything.
     *
     * This deliberately walks the same prepare loop as submitPatientBatch - remote form contract,
     * business rules, location resolution, XML build, semantic choices - so a batch that validates
     * here cannot be rejected by submit for a content reason. Nothing is journalled, staged or
     * uploaded, so it is safe to run against production before spending a real write.
     */
    async validatePatientBatch(input: SubmitBatchInput): Promise<ValidationResult> {
        const database = new BahisDatabase(this.config.dbPath, true);
        try {
            const token = database.getToken();
            if (!token) throw new Error('No BAHIS token is available. Run `bahis login` or open BAHIS and sign in once.');
            const remoteFormXml = await this.client(token).fetchCurrentFormDefinition();
            assertCompatibleForm(remoteFormXml);
            const staleForm = formContractWarning(database.getFormXml(), 'cached');
            if (staleForm) log('stale_cached_form', { error: staleForm });
            const region = database.getUserRegion();
            const taxonomies = loadTaxonomies(database);
            const locations = database.getLocations();
            const records = input.records.map((record, index) => {
                try {
                    const speciesType = this.validatePatient(record, taxonomies, database);
                    const location = database.resolveLocation(record.unionId, record.villageId);
                    const uuid = deterministicUuid(`${input.requestId}:${index}`);
                    const built = buildPatientRecord(
                        remoteFormXml,
                        record,
                        speciesType,
                        region,
                        location,
                        uuid,
                        index,
                        this.now(),
                    );
                    assertSemanticChoices(built.xml, taxonomies, locations);
                    return { index, uuid, valid: true as const };
                } catch (error) {
                    return { index, valid: false as const, error: safeError(error) };
                }
            });
            return {
                batchId: input.requestId,
                requested: records.length,
                valid: records.filter((record) => record.valid).length,
                invalid: records.filter((record) => !record.valid).length,
                records,
            };
        } finally {
            database.close();
        }
    }

    async submitPatientBatch(input: SubmitBatchInput): Promise<BatchResult> {
        assertWritesAllowed(this.config);
        const database = new BahisDatabase(this.config.dbPath);
        const journal = new JournalDatabase(this.config.journalPath);
        try {
            const token = database.getToken();
            if (!token) throw new Error('No BAHIS token is available. Open BAHIS and sign in once.');
            const remoteFormXml = await this.client(token).fetchCurrentFormDefinition();
            assertCompatibleForm(remoteFormXml);
            const staleForm = formContractWarning(database.getFormXml(), 'cached');
            if (staleForm) log('stale_cached_form', { error: staleForm });
            const region = database.getUserRegion();
            const taxonomies = loadTaxonomies(database);
            const locations = database.getLocations();
            const prepared = input.records.map((record, index) => {
                const speciesType = this.validatePatient(record, taxonomies, database);
                const location = database.resolveLocation(record.unionId, record.villageId);
                const uuid = deterministicUuid(`${input.requestId}:${index}`);
                const result = buildPatientRecord(remoteFormXml, record, speciesType, region, location, uuid, index, this.now());
                assertSemanticChoices(result.xml, taxonomies, locations);
                return result;
            });
            const requestHash = sha256(JSON.stringify(input));
            journal.ensureBatch(input.requestId, requestHash, prepared);
            const existing = new Map(journal.getBatch(input.requestId).map((record) => [record.recordIndex, record]));
            database.stageRecords(prepared.filter((record) => existing.get(record.index)?.status !== 'verified'));
            const client = this.client(token);
            const results = await mapConcurrent(prepared, UPLOAD_CONCURRENCY, async (record) => {
                const prior = existing.get(record.index);
                if (prior?.status === 'verified') return this.resultFromJournal(prior);
                return this.uploadAndVerify(input.requestId, record, client, database, journal, taxonomies, locations);
            });
            return this.toBatchResult(input.requestId, results);
        } finally {
            journal.close();
            database.close();
        }
    }

    async verifyPatientBatch(batchId: string): Promise<BatchResult> {
        const database = new BahisDatabase(this.config.dbPath);
        const journal = new JournalDatabase(this.config.journalPath);
        try {
            const token = database.getToken();
            if (!token) throw new Error('No BAHIS token is available. Open BAHIS and sign in once.');
            const client = this.client(token);
            const taxonomies = loadTaxonomies(database);
            const locations = database.getLocations();
            const records = journal.getBatch(batchId);
            const results = await mapConcurrent(records, UPLOAD_CONCURRENCY, async (record) => {
                if (record.status === 'verified') return this.resultFromJournal(record);
                return this.verifyJournalRecord(record, client, database, journal, false, taxonomies, locations);
            });
            return this.toBatchResult(batchId, results);
        } finally {
            journal.close();
            database.close();
        }
    }

    async retryPatientBatch(batchId: string): Promise<BatchResult> {
        assertWritesAllowed(this.config);
        const database = new BahisDatabase(this.config.dbPath);
        const journal = new JournalDatabase(this.config.journalPath);
        try {
            const token = database.getToken();
            if (!token) throw new Error('No BAHIS token is available. Open BAHIS and sign in once.');
            const client = this.client(token);
            const taxonomies = loadTaxonomies(database);
            const locations = database.getLocations();
            const records = journal.getBatch(batchId);
            const draftXml = new Map<string, string>();
            for (const record of records) {
                if (record.status === 'verified') continue;
                const xml = database.getDraftXml(record.uuid);
                if (!xml) continue;
                assertSemanticChoices(xml, taxonomies, locations);
                draftXml.set(record.uuid, xml);
            }
            const results = await mapConcurrent(records, UPLOAD_CONCURRENCY, async (record) => {
                if (record.status === 'verified') return this.resultFromJournal(record);
                if (record.status === 'accepted') {
                    const verification = await this.verifyJournalRecord(
                        record,
                        client,
                        database,
                        journal,
                        false,
                        taxonomies,
                        locations,
                    );
                    if (verification.verificationStatus === 'matched') return verification;
                }
                const xml = draftXml.get(record.uuid);
                if (!xml) {
                    return this.verifyJournalRecord(record, client, database, journal, false, taxonomies, locations);
                }
                const prepared: PreparedRecord = {
                    index: record.recordIndex,
                    uuid: record.uuid,
                    xml,
                    fieldHashes: record.fieldHashes,
                };
                assertSemanticChoices(prepared.xml, taxonomies, locations);
                return this.uploadAndVerify(batchId, prepared, client, database, journal, taxonomies, locations);
            });
            return this.toBatchResult(batchId, results);
        } finally {
            journal.close();
            database.close();
        }
    }

    private async uploadAndVerify(
        batchId: string,
        record: PreparedRecord,
        client: KoboClient,
        database: BahisDatabase,
        journal: JournalDatabase,
        taxonomies: TaxonomyContext,
        locations: ReturnType<BahisDatabase['getLocations']>,
    ): Promise<RecordResult> {
        try {
            await client.upload(record.xml);
            journal.updateRecord(batchId, record.index, 'accepted');
            return await this.verifyPreparedRecord(
                batchId,
                record,
                client,
                database,
                journal,
                true,
                'accepted',
                taxonomies,
                locations,
            );
        } catch (error) {
            const message = safeError(error);
            journal.updateRecord(batchId, record.index, 'failed', [], message);
            return {
                index: record.index,
                uuid: record.uuid,
                uploadStatus: 'failed',
                verificationStatus: 'not_checked',
                error: message,
            };
        }
    }

    private async verifyPreparedRecord(
        batchId: string,
        record: PreparedRecord,
        client: KoboClient,
        database: BahisDatabase,
        journal: JournalDatabase,
        poll: boolean,
        missingStatus: 'draft' | 'accepted' | 'failed',
        taxonomies: TaxonomyContext,
        locations: ReturnType<BahisDatabase['getLocations']>,
    ): Promise<RecordResult> {
        const maxPolls = poll ? Math.max(1, Math.ceil(VERIFY_TIMEOUT_MS / VERIFY_POLL_INTERVAL_MS)) : 1;
        let lastError: string | undefined;
        for (let attempt = 0; attempt < maxPolls; attempt += 1) {
            let serverXml: string | undefined;
            try {
                serverXml = await client.fetchSubmissionXml(record.uuid);
                lastError = undefined;
            } catch (error) {
                lastError = safeError(error);
            }
            if (serverXml) {
                try {
                    assertSemanticChoices(serverXml, taxonomies, locations);
                } catch (error) {
                    const message = safeError(error);
                    const mismatchField = error instanceof SemanticChoiceError ? error.path : 'semantic_choices';
                    journal.updateRecord(batchId, record.index, 'failed', [mismatchField], message);
                    return {
                        index: record.index,
                        uuid: record.uuid,
                        uploadStatus: 'failed',
                        verificationStatus: 'mismatched',
                        mismatchFields: [mismatchField],
                        error: message,
                    };
                }
                const mismatches = mismatchFields(record.fieldHashes, serverXml);
                if (mismatches.length === 0) {
                    database.completeRecord(record.uuid, serverXml);
                    journal.updateRecord(batchId, record.index, 'verified');
                    return {
                        index: record.index,
                        uuid: record.uuid,
                        uploadStatus: 'verified',
                        verificationStatus: 'matched',
                    };
                }
                journal.updateRecord(batchId, record.index, 'failed', mismatches, 'Required fields differ on Kobo.');
                return {
                    index: record.index,
                    uuid: record.uuid,
                    uploadStatus: 'failed',
                    verificationStatus: 'mismatched',
                    mismatchFields: mismatches,
                    error: 'Required fields differ on Kobo.',
                };
            }
            if (attempt + 1 < maxPolls) await this.sleepImpl(VERIFY_POLL_INTERVAL_MS);
        }
        const error = lastError
            ? `Kobo verification failed: ${lastError}`
            : poll
              ? 'Submission was not visible on Kobo before timeout.'
              : 'Submission is not currently visible on Kobo.';
        journal.updateRecord(batchId, record.index, missingStatus, [], error);
        return {
            index: record.index,
            uuid: record.uuid,
            uploadStatus: missingStatus,
            verificationStatus: 'missing',
            error,
        };
    }

    private async verifyJournalRecord(
        record: JournalRecord,
        client: KoboClient,
        database: BahisDatabase,
        journal: JournalDatabase,
        poll: boolean,
        taxonomies: TaxonomyContext,
        locations: ReturnType<BahisDatabase['getLocations']>,
    ): Promise<RecordResult> {
        return this.verifyPreparedRecord(
            record.batchId,
            { index: record.recordIndex, uuid: record.uuid, xml: '', fieldHashes: record.fieldHashes },
            client,
            database,
            journal,
            poll,
            record.status === 'accepted' ? 'accepted' : record.status === 'draft' ? 'draft' : 'failed',
            taxonomies,
            locations,
        );
    }

    private resultFromJournal(record: JournalRecord): RecordResult {
        return {
            index: record.recordIndex,
            uuid: record.uuid,
            uploadStatus: record.status,
            verificationStatus:
                record.status === 'verified' ? 'matched' : record.mismatchFields.length ? 'mismatched' : 'not_checked',
            mismatchFields: record.mismatchFields.length ? record.mismatchFields : undefined,
            error: record.error,
        };
    }

    private toBatchResult(batchId: string, records: RecordResult[]): BatchResult {
        return {
            batchId,
            requested: records.length,
            accepted: records.filter((record) => record.uploadStatus === 'accepted' || record.uploadStatus === 'verified').length,
            verified: records.filter((record) => record.uploadStatus === 'verified').length,
            failed: records.filter((record) => record.uploadStatus === 'failed').length,
            records: records.sort((left, right) => left.index - right.index),
        };
    }
}
