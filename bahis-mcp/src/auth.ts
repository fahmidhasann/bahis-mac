import type { Config } from './config.js';
import { BahisDatabase } from './database.js';

export interface LoginResult {
    username: string;
    name: string | null;
    upazila: number;
    tokenChanged: boolean;
}

interface AuthResponse {
    token?: string;
    upazila?: number;
    user?: { username?: string; name?: string };
}

/**
 * Sign in against BAHIS and refresh the locally stored token.
 *
 * Mirrors the desktop app's signIn (electron/main.ts) exactly: the same endpoint, the same
 * multipart body including bahis_desk_version, and the same users-table columns. That matters
 * because the app and this CLI share one SQLite file - a row written here has to be one the app
 * would accept on its next launch.
 *
 * This refreshes an expired token without opening the app. It cannot bootstrap a fresh machine:
 * the database must already exist, and patient submission additionally needs the reference data
 * (administrativeregion, taxonomy, form) that only the app's own sync populates.
 */
export async function login(
    config: Config,
    username: string,
    password: string,
    appVersion: string,
    fetchImpl: typeof fetch = fetch,
): Promise<LoginResult> {
    const body = new FormData();
    body.append('username', username);
    body.append('password', password);
    body.append('bahis_desk_version', appVersion);

    const response = await fetchImpl(new URL('/api/auth/', config.bahisServerUrl), {
        method: 'POST',
        body,
        headers: { Accept: 'application/json' },
    });
    if (response.status === 401 || response.status === 403) {
        throw new Error('BAHIS rejected those credentials.');
    }
    if (!response.ok) {
        throw new Error(`BAHIS sign-in returned HTTP ${response.status}.`);
    }

    const payload = (await response.json()) as AuthResponse;
    if (payload.user?.username !== username) {
        throw new Error('BAHIS returned a different user than the one requested.');
    }
    if (!payload.token) throw new Error('BAHIS sign-in returned no token.');
    if (typeof payload.upazila !== 'number') {
        throw new Error('BAHIS sign-in returned no upazila; this account cannot submit patient records.');
    }

    const database = new BahisDatabase(config.dbPath);
    try {
        const previousToken = database.getToken();
        database.upsertUser({
            username,
            password,
            name: payload.user?.name ?? null,
            token: payload.token,
            upazila: payload.upazila,
        });
        return {
            username,
            name: payload.user?.name ?? null,
            upazila: payload.upazila,
            tokenChanged: previousToken !== payload.token,
        };
    } finally {
        database.close();
    }
}
