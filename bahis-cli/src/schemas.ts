import { z } from 'zod';
import { MAX_BATCH_SIZE } from './constants.js';

const identifier = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/);
const taxonomyId = z.string().trim().min(1).max(80).refine((value) => value !== 'other', {
    message: 'The conditional "other" option is not supported without its required explanation field.',
});
const calendarDate = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => {
        const [year, month, day] = value.split('-').map(Number);
        const date = new Date(Date.UTC(year, month - 1, day));
        return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
    }, 'visitDate must be a real calendar date.');

const placeholderOwnerName = /\b(?:synthetic|dummy|sample|placeholder|unknown|test|fake|example|demo|mock|training|trial)\b/i;
const numberedOwnerName = /^owner(?:\s*[-#]?\s*\d+)?$/i;
const ownerNumberLabel = /(?:\bowner\b.*\d|\d.*\bowner\b)/i;

export const patientInputSchema = z.object({
    ownerName: z
        .string()
        .trim()
        .min(1)
        .max(150)
        .refine(
            (value) =>
                !placeholderOwnerName.test(value) && !numberedOwnerName.test(value) && !ownerNumberLabel.test(value),
            {
            message: 'ownerName must be a natural-looking fictional Bengali name, not a placeholder.',
            },
        ),
    visitDate: calendarDate.optional(),
    unionId: z.string().regex(/^\d+$/),
    villageId: z.string().regex(/^\d+$/),
    species: taxonomyId,
    patientType: z.enum(['household', 'herd', 'flock']),
    purpose: z.enum(['milk', 'meat', 'egg', 'working', 'hobby', 'fibre', 'multi']),
    herdSize: z.number().int().min(1),
    sickCount: z.number().int().min(0),
    deadCount: z.number().int().min(0),
    clinicalSignIds: z.array(taxonomyId).min(1).max(20),
    tentativeDiagnosisIds: z.array(taxonomyId).min(1).max(20),
});

export const submitBatchInputSchema = z.object({
    requestId: identifier,
    records: z.array(patientInputSchema).min(1).max(MAX_BATCH_SIZE),
});

export const contextInputSchema = z.object({
    species: z.array(taxonomyId).max(20).optional(),
});

export const recentSummaryInputSchema = z.object({
    limit: z.number().int().min(1).max(500).default(200),
    order: z.enum(['oldest', 'newest']).default('oldest'),
});

export const batchIdInputSchema = z.object({ batchId: identifier });

export const statusOutputSchema = z.object({
    databaseFound: z.boolean(),
    authenticated: z.boolean(),
    productionWritesEnabled: z.boolean(),
    serverReachable: z.boolean(),
    formCompatible: z.boolean(),
    semanticChoiceValidation: z.boolean(),
    formUid: z.string(),
    region: z
        .object({
            division: z.object({ id: z.number(), title: z.string() }),
            district: z.object({ id: z.number(), title: z.string() }),
            upazila: z.object({ id: z.number(), title: z.string() }),
        })
        .optional(),
    pendingDrafts: z.number(),
    warnings: z.array(z.string()),
});

const recordResultSchema = z.object({
    index: z.number(),
    uuid: z.string(),
    uploadStatus: z.enum(['draft', 'accepted', 'verified', 'failed']),
    verificationStatus: z.enum(['not_checked', 'matched', 'missing', 'mismatched']),
    mismatchFields: z.array(z.string()).optional(),
    error: z.string().optional(),
});

export const batchOutputSchema = z.object({
    batchId: z.string(),
    requested: z.number(),
    accepted: z.number(),
    verified: z.number(),
    failed: z.number(),
    records: z.array(recordResultSchema),
});

const choiceSchema = z.object({ id: z.string(), label: z.string() });
export const patientContextOutputSchema = z.object({
    formUid: z.string(),
    contractHash: z.string(),
    region: z.object({
        division: z.object({ id: z.number(), title: z.string() }),
        district: z.object({ id: z.number(), title: z.string() }),
        upazila: z.object({ id: z.number(), title: z.string() }),
    }),
    locations: z.array(choiceSchema.extend({ villages: z.array(choiceSchema) })),
    species: z.array(choiceSchema.extend({ speciesType: z.enum(['mammal', 'bird']) })),
    clinicalSigns: z.array(choiceSchema),
    tentativeDiagnoses: z.array(choiceSchema),
    rules: z.array(z.string()),
});

const countedChoiceSchema = z.object({ id: z.string(), count: z.number().int().nonnegative() });
const numericSummarySchema = z.object({
    min: z.number().int().nonnegative(),
    median: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
});

export const recentSummaryOutputSchema = z.object({
    requestedLimit: z.number().int().positive(),
    order: z.enum(['oldest', 'newest']),
    oldestDate: z.string().optional(),
    newestDate: z.string().optional(),
    scannedRecordCount: z.number().int().nonnegative(),
    usableRecordCount: z.number().int().nonnegative(),
    skippedRecordCount: z.number().int().nonnegative(),
    speciesProfiles: z.array(
        z.object({
            species: z.string(),
            count: z.number().int().positive(),
            patientTypes: z.array(countedChoiceSchema),
            purposes: z.array(countedChoiceSchema),
            herdSize: numericSummarySchema,
            sickCount: numericSummarySchema,
            deadCount: numericSummarySchema,
            clinicalSigns: z.array(countedChoiceSchema),
            tentativeDiagnoses: z.array(countedChoiceSchema),
        }),
    ),
    locationPatterns: z.array(
        z.object({
            unionId: z.string(),
            villageId: z.string(),
            count: z.number().int().positive(),
        }),
    ),
    clinicalPatterns: z.array(
        z.object({
            species: z.string(),
            patientType: z.enum(['household', 'herd', 'flock']),
            purpose: z.enum(['milk', 'meat', 'egg', 'working', 'hobby', 'fibre', 'multi']),
            clinicalSignIds: z.array(z.string()),
            tentativeDiagnosisIds: z.array(z.string()),
            count: z.number().int().positive(),
        }),
    ),
});
