import os from 'node:os';
import path from 'node:path';
import {
    DEFAULT_BAHIS_SERVER_URL,
    DEFAULT_KOBO_KC_API_URL,
    DEFAULT_KOBO_KF_API_URL,
    PRODUCTION_HOSTS,
} from './constants.js';

export interface Config {
    dbPath: string;
    journalPath: string;
    bahisServerUrl: string;
    koboKfApiUrl: string;
    koboKcApiUrl: string;
    allowProductionWrites: boolean;
}

function defaultDatabasePath(): string {
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'bahis', 'bahis3.db');
    }
    if (process.platform === 'win32') {
        return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'bahis', 'bahis3.db');
    }
    return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'bahis', 'bahis3.db');
}

function asDirectoryUrl(value: string): string {
    const url = new URL(value);
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.toString();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const dbPath = path.resolve(env.BAHIS_DB_PATH ?? defaultDatabasePath());
    return {
        dbPath,
        journalPath: path.resolve(env.BAHIS_MCP_JOURNAL_PATH ?? path.join(path.dirname(dbPath), 'bahis-mcp.db')),
        bahisServerUrl: new URL(env.BAHIS_SERVER_URL ?? DEFAULT_BAHIS_SERVER_URL).origin,
        koboKfApiUrl: asDirectoryUrl(env.BAHIS_KOBO_KF_API_URL ?? DEFAULT_KOBO_KF_API_URL),
        koboKcApiUrl: asDirectoryUrl(env.BAHIS_KOBO_KC_API_URL ?? DEFAULT_KOBO_KC_API_URL),
        allowProductionWrites: env.BAHIS_MCP_ALLOW_PRODUCTION_WRITES === '1',
    };
}

export function isProductionConfig(config: Config): boolean {
    return [config.bahisServerUrl, config.koboKfApiUrl, config.koboKcApiUrl].some((value) =>
        PRODUCTION_HOSTS.has(new URL(value).hostname.replace(/\.$/, '')),
    );
}

export function assertWritesAllowed(config: Config): void {
    if (isProductionConfig(config) && !config.allowProductionWrites) {
        throw new Error(
            'Production writes are disabled. Set BAHIS_MCP_ALLOW_PRODUCTION_WRITES=1 once you have confirmed authorization.',
        );
    }
}
