import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

/** Write a taxonomy CSV below Electron's user-data directory. */
export function writeTaxonomyCsv(userDataPath: string, csvFileStub: string, contents: string): string {
    const rootPath = resolve(userDataPath);
    const filePath = resolve(rootPath, csvFileStub);

    if (filePath === rootPath || !filePath.startsWith(`${rootPath}${sep}`)) {
        throw new Error(`Invalid taxonomy file path: ${csvFileStub}`);
    }

    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents, 'utf-8');
    return filePath;
}
