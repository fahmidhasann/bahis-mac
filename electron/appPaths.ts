import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// Keep the macOS database location stable even though the packaged product
// name is capitalised as "BAHIS".
if (process.platform === 'darwin') {
    app.setPath('userData', path.join(app.getPath('appData'), 'bahis'));
}

export const USER_DATA_PATH = app.getPath('userData');
mkdirSync(USER_DATA_PATH, { recursive: true });

export const LOG_FILE_PATH = path.join(USER_DATA_PATH, 'electron-debug.log');
