export interface DownloadIssue {
    key: string;
    reason: string;
}

export interface DownloadBatchResult<R> {
    completed: R[];
    warnings: DownloadIssue[];
    failures: DownloadIssue[];
}

interface DownloadBatchOptions<T, R> {
    items: T[];
    keyOf: (item: T) => string;
    optionalKeys?: ReadonlySet<string>;
    download: (item: T) => Promise<R>;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Await every download and classify optional failures without hiding them. */
export async function runDownloadBatch<T, R>({
    items,
    keyOf,
    optionalKeys = new Set(),
    download,
}: DownloadBatchOptions<T, R>): Promise<DownloadBatchResult<R>> {
    const settled = await Promise.allSettled(items.map(download));
    const result: DownloadBatchResult<R> = { completed: [], warnings: [], failures: [] };

    settled.forEach((outcome, index) => {
        if (outcome.status === 'fulfilled') {
            result.completed.push(outcome.value);
            return;
        }
        const issue = { key: keyOf(items[index]), reason: errorMessage(outcome.reason) };
        (optionalKeys.has(issue.key) ? result.warnings : result.failures).push(issue);
    });

    return result;
}
