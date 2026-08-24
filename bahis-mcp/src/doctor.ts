import { loadConfig } from './config.js';
import { BahisService } from './service.js';
import { safeError } from './util.js';

try {
    const status = await new BahisService(loadConfig()).status();
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    if (!status.databaseFound || !status.authenticated || !status.serverReachable || !status.formCompatible) {
        process.exitCode = 1;
    }
} catch (error) {
    process.stderr.write(`${safeError(error)}\n`);
    process.exitCode = 1;
}
