export interface SubmissionSyncForm {
    uid: string;
    name: string;
}

export interface SubmissionPage<T> {
    records: T[];
    next?: string;
}

export interface FormSubmissionSyncResult {
    formUid: string;
    received: number;
    pages: number;
}

export interface SubmissionSyncPassesResult {
    full: FormSubmissionSyncResult[];
    recent: FormSubmissionSyncResult[];
}

export const RECENT_SUBMISSION_LOOKBACK_DAYS = 2;
export const RECENT_CATCH_UP_DELAYS_MS = [0, 2_000, 5_000] as const;

interface SubmissionDataUrlOptions {
    baseUrl: string;
    formUid: string;
    limit: number;
    start?: number;
    submittedSince?: string;
}

/** Build one Kobo data URL without duplicating pagination or query details in callers. */
export function buildSubmissionDataUrl({
    baseUrl,
    formUid,
    limit,
    start = 0,
    submittedSince,
}: SubmissionDataUrlOptions): string {
    const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const url = new URL(`assets/${encodeURIComponent(formUid)}/data/`, normalizedBaseUrl);
    url.searchParams.set('format', 'xml');
    url.searchParams.set('start', String(start));
    url.searchParams.set('limit', String(limit));
    if (submittedSince) {
        url.searchParams.set('query', JSON.stringify({ _submission_time: { $gte: submittedSince } }));
    }
    return url.toString();
}

export function recentSubmissionBoundary(now = new Date()): string {
    const boundary = new Date(now);
    boundary.setUTCDate(boundary.getUTCDate() - (RECENT_SUBMISSION_LOOKBACK_DAYS - 1));
    boundary.setUTCHours(0, 0, 0, 0);
    return boundary.toISOString();
}

interface ReconcileFormOptions<T> {
    form: SubmissionSyncForm;
    initialUrl: string;
    fetchPage: (url: string) => Promise<SubmissionPage<T>>;
    upsertPage: (records: T[], form: SubmissionSyncForm) => void;
}

/**
 * Consume one server-provided pagination chain. A failed page rejects the
 * whole form sync. Already-written pages are safe because callers upsert by UUID,
 * and the next run starts a fresh full reconciliation from page one.
 */
export async function reconcileFormSubmissions<T>({
    form,
    initialUrl,
    fetchPage,
    upsertPage,
}: ReconcileFormOptions<T>): Promise<FormSubmissionSyncResult> {
    let nextUrl: string | undefined = initialUrl;
    let received = 0;
    let pages = 0;
    const visitedUrls = new Set<string>();

    while (nextUrl) {
        if (visitedUrls.has(nextUrl)) {
            throw new Error(`Submission pagination cycle detected for form ${form.uid}`);
        }
        visitedUrls.add(nextUrl);

        const page = await fetchPage(nextUrl);
        upsertPage(page.records, form);
        received += page.records.length;
        pages += 1;
        nextUrl = page.next;
    }

    return { formUid: form.uid, received, pages };
}

interface ReconcileAllOptions<T> {
    forms: SubmissionSyncForm[];
    buildInitialUrl: (form: SubmissionSyncForm) => string;
    fetchPage: (url: string) => Promise<SubmissionPage<T>>;
    upsertPage: (records: T[], form: SubmissionSyncForm) => void;
}

interface ReconcileSubmissionPassesOptions<T> {
    forms: SubmissionSyncForm[];
    buildFullInitialUrl: (form: SubmissionSyncForm) => string;
    buildRecentInitialUrl: (form: SubmissionSyncForm) => string;
    fetchPage: (url: string) => Promise<SubmissionPage<T>>;
    upsertPage: (records: T[], form: SubmissionSyncForm) => void;
    recentRetryDelaysMs?: readonly number[];
    sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Forms are reconciled independently. No form can advance or otherwise affect
 * another form's remote query boundary.
 */
export async function reconcileAllFormSubmissions<T>({
    forms,
    buildInitialUrl,
    fetchPage,
    upsertPage,
}: ReconcileAllOptions<T>): Promise<FormSubmissionSyncResult[]> {
    const results: FormSubmissionSyncResult[] = [];
    for (const form of forms) {
        results.push(
            await reconcileFormSubmissions({
                form,
                initialUrl: buildInitialUrl(form),
                fetchPage,
                upsertPage,
            }),
        );
    }
    return results;
}

/**
 * Run a complete reconciliation, then a recent filtered catch-up. Kobo can
 * expose a new UUID to filtered queries before its unfiltered list index is
 * updated, so the second pass closes that eventual-consistency gap.
 */
export async function reconcileSubmissionPasses<T>({
    forms,
    buildFullInitialUrl,
    buildRecentInitialUrl,
    fetchPage,
    upsertPage,
    recentRetryDelaysMs = RECENT_CATCH_UP_DELAYS_MS,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}: ReconcileSubmissionPassesOptions<T>): Promise<SubmissionSyncPassesResult> {
    const full = await reconcileAllFormSubmissions({
        forms,
        buildInitialUrl: buildFullInitialUrl,
        fetchPage,
        upsertPage,
    });
    if (recentRetryDelaysMs.length === 0) throw new Error('At least one recent catch-up attempt is required');
    let recent: FormSubmissionSyncResult[] | undefined;
    let lastError: unknown;
    for (const delay of recentRetryDelaysMs) {
        if (!Number.isFinite(delay) || delay < 0) throw new Error('Recent catch-up delays must be non-negative');
        if (delay > 0) await sleep(delay);
        try {
            recent = await reconcileAllFormSubmissions({
                forms,
                buildInitialUrl: buildRecentInitialUrl,
                fetchPage,
                upsertPage,
            });
            lastError = undefined;
        } catch (error) {
            lastError = error;
        }
    }
    if (!recent) throw lastError;
    return { full, recent };
}
