export interface SyncEventSource {
    on(channel: string, listener: () => void): void;
    removeListener(channel: string, listener: () => void): void;
}

export function subscribeToSubmissionSync(source: SyncEventSource, reload: () => void): () => void {
    source.on('form-submissions-synced', reload);
    return () => source.removeListener('form-submissions-synced', reload);
}
