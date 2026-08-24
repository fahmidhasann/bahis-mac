import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildSubmissionDataUrl,
    recentSubmissionBoundary,
    reconcileAllFormSubmissions,
    reconcileFormSubmissions,
    reconcileSubmissionPasses,
} from './submissionSyncCore.ts';
import type { SubmissionPage } from './submissionSyncCore.ts';

interface RecordData {
    uuid: string;
    value: string;
}

test('each form starts a full, isolated reconciliation', async () => {
    const requested: string[] = [];
    const ownership: string[] = [];

    await reconcileAllFormSubmissions<RecordData>({
        forms: [
            { uid: 'form-a', name: 'A' },
            { uid: 'form-b', name: 'B' },
        ],
        buildInitialUrl: (form) => `https://example.test/${form.uid}?start=0&limit=500`,
        fetchPage: async (url) => {
            requested.push(url);
            return { records: [] };
        },
        upsertPage: (_records, form) => ownership.push(form.uid),
    });

    assert.deepEqual(requested, [
        'https://example.test/form-a?start=0&limit=500',
        'https://example.test/form-b?start=0&limit=500',
    ]);
    assert.deepEqual(ownership, ['form-a', 'form-b']);
});

test('a late-visible older UUID is recovered on the next full reconciliation', async () => {
    const local = new Map<string, RecordData>();
    let remote: RecordData[] = [{ uuid: 'newer', value: 'first' }];

    const run = () =>
        reconcileFormSubmissions({
            form: { uid: 'patient-registry', name: 'Patient Registry' },
            initialUrl: 'page-1',
            fetchPage: async (): Promise<SubmissionPage<RecordData>> => ({ records: remote }),
            upsertPage: (records) => records.forEach((record) => local.set(record.uuid, record)),
        });

    await run();
    remote = [
        { uuid: 'late-older', value: 'became visible late' },
        { uuid: 'newer', value: 'updated' },
    ];
    await run();

    assert.equal(local.get('late-older')?.value, 'became visible late');
    assert.equal(local.get('newer')?.value, 'updated');
});

test('a paging race skipped by offsets is recovered by the next full pass', async () => {
    const local = new Map<string, RecordData>();
    let remote = [
        { uuid: 'a', value: 'a' },
        { uuid: 'b', value: 'b' },
    ];
    let injectDuringFirstRun = true;
    let totalAtRunStart = remote.length;

    const run = () =>
        reconcileFormSubmissions<RecordData>({
            form: { uid: 'patient-registry', name: 'Patient Registry' },
            initialUrl: 'page-0',
            fetchPage: async (url) => {
                const offset = Number(url.split('-')[1]);
                if (offset === 0) totalAtRunStart = remote.length;
                const record = remote[offset];
                if (offset === 0 && injectDuringFirstRun) {
                    injectDuringFirstRun = false;
                    remote = [{ uuid: 'new', value: 'new' }, ...remote];
                }
                return {
                    records: record ? [record] : [],
                    next: offset + 1 < totalAtRunStart ? `page-${offset + 1}` : undefined,
                };
            },
            upsertPage: (records) => records.forEach((record) => local.set(record.uuid, record)),
        });

    await run();
    assert.equal(local.has('b'), false);
    await run();
    assert.deepEqual([...local.keys()].sort(), ['a', 'b', 'new']);
});

test('follows every server next link and UUID upserts absorb duplicates', async () => {
    const local = new Map<string, RecordData>();
    const pages = new Map<string, SubmissionPage<RecordData>>([
        ['page-1', { records: [{ uuid: 'same', value: 'old' }], next: 'page-2' }],
        [
            'page-2',
            {
                records: [
                    { uuid: 'same', value: 'new' },
                    { uuid: 'second', value: 'two' },
                ],
            },
        ],
    ]);

    const result = await reconcileFormSubmissions({
        form: { uid: 'form-a', name: 'A' },
        initialUrl: 'page-1',
        fetchPage: async (url) => pages.get(url)!,
        upsertPage: (records) => records.forEach((record) => local.set(record.uuid, record)),
    });

    assert.deepEqual(result, { formUid: 'form-a', received: 3, pages: 2 });
    assert.equal(local.get('same')?.value, 'new');
    assert.equal(local.size, 2);
});

test('a later page failure rejects and a retry starts from page one', async () => {
    const requested: string[] = [];
    let failSecondPage = true;
    const local = new Map<string, RecordData>();

    const run = () =>
        reconcileFormSubmissions<RecordData>({
            form: { uid: 'form-a', name: 'A' },
            initialUrl: 'page-1',
            fetchPage: async (url) => {
                requested.push(url);
                if (url === 'page-2' && failSecondPage) throw new Error('page two unavailable');
                if (url === 'page-1') return { records: [{ uuid: 'one', value: 'one' }], next: 'page-2' };
                return { records: [{ uuid: 'two', value: 'two' }] };
            },
            upsertPage: (records) => records.forEach((record) => local.set(record.uuid, record)),
        });

    await assert.rejects(run(), /page two unavailable/);
    failSecondPage = false;
    await run();

    assert.deepEqual(requested, ['page-1', 'page-2', 'page-1', 'page-2']);
    assert.deepEqual([...local.keys()], ['one', 'two']);
});

test('detects a repeated next URL instead of looping forever', async () => {
    await assert.rejects(
        reconcileFormSubmissions({
            form: { uid: 'form-a', name: 'A' },
            initialUrl: 'page-1',
            fetchPage: async () => ({ records: [], next: 'page-1' }),
            upsertPage: () => undefined,
        }),
        /pagination cycle/,
    );
});

test('recent submission URL uses a stable UTC boundary and Kobo query', () => {
    const boundary = recentSubmissionBoundary(new Date('2026-08-09T12:00:00.000Z'));
    const url = new URL(
        buildSubmissionDataUrl({
            baseUrl: 'https://kf.example.test/api/v2/',
            formUid: 'patient registry',
            limit: 500,
            submittedSince: boundary,
        }),
    );

    assert.equal(boundary, '2026-08-08T00:00:00.000Z');
    assert.equal(url.pathname, '/api/v2/assets/patient%20registry/data/');
    assert.equal(url.searchParams.get('format'), 'xml');
    assert.equal(url.searchParams.get('start'), '0');
    assert.equal(url.searchParams.get('limit'), '500');
    assert.deepEqual(JSON.parse(url.searchParams.get('query') ?? '{}'), {
        _submission_time: { $gte: boundary },
    });
});

test('submission URL preserves a custom API base path without a trailing slash', () => {
    const url = new URL(
        buildSubmissionDataUrl({
            baseUrl: 'https://kf.example.test/custom/api/v2',
            formUid: 'patient-registry',
            limit: 500,
        }),
    );

    assert.equal(url.pathname, '/custom/api/v2/assets/patient-registry/data/');
});

test('recent catch-up recovers a UUID missing from the unfiltered index', async () => {
    const local = new Map<string, RecordData>();
    const requested: string[] = [];

    const result = await reconcileSubmissionPasses<RecordData>({
        forms: [{ uid: 'patient-registry', name: 'Patient Registry' }],
        buildFullInitialUrl: () => 'full-page',
        buildRecentInitialUrl: () => 'recent-page',
        fetchPage: async (url) => {
            requested.push(url);
            if (url === 'full-page') return { records: [{ uuid: 'older', value: 'older' }] };
            return { records: [{ uuid: 'late-indexed', value: 'new' }] };
        },
        upsertPage: (records) => records.forEach((record) => local.set(record.uuid, record)),
        recentRetryDelaysMs: [0],
    });

    assert.deepEqual(requested, ['full-page', 'recent-page']);
    assert.deepEqual([...local.keys()], ['older', 'late-indexed']);
    assert.deepEqual(result, {
        full: [{ formUid: 'patient-registry', received: 1, pages: 1 }],
        recent: [{ formUid: 'patient-registry', received: 1, pages: 1 }],
    });
});

test('recent catch-up retries with bounded delays and keeps the latest successful pass', async () => {
    const requested: string[] = [];
    const delays: number[] = [];
    let recentAttempt = 0;

    const result = await reconcileSubmissionPasses<RecordData>({
        forms: [{ uid: 'patient-registry', name: 'Patient Registry' }],
        buildFullInitialUrl: () => 'full-page',
        buildRecentInitialUrl: () => 'recent-page',
        fetchPage: async (url) => {
            requested.push(url);
            if (url === 'full-page') return { records: [] };
            recentAttempt += 1;
            if (recentAttempt === 1) throw new Error('recent index is not ready');
            return { records: [{ uuid: 'visible-now', value: `attempt-${recentAttempt}` }] };
        },
        upsertPage: () => undefined,
        recentRetryDelaysMs: [0, 2_000, 5_000],
        sleep: async (milliseconds) => {
            delays.push(milliseconds);
        },
    });

    assert.deepEqual(requested, ['full-page', 'recent-page', 'recent-page', 'recent-page']);
    assert.deepEqual(delays, [2_000, 5_000]);
    assert.deepEqual(result.recent, [{ formUid: 'patient-registry', received: 1, pages: 1 }]);
});
