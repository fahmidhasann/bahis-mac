import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createBahisServer } from './server.js';
import { BahisService } from './service.js';
import { log, safeError } from './util.js';

const config = loadConfig();
const server = createBahisServer(new BahisService(config));

function fatal(event: string, error: unknown): never {
    log(event, { error: safeError(error) });
    process.exit(1);
}

process.on('uncaughtException', (error) => fatal('uncaught_exception', error));
process.on('unhandledRejection', (error) => fatal('unhandled_rejection', error));

await server.connect(new StdioServerTransport());
log('server_started', { databaseConfigured: Boolean(config.dbPath), productionWritesEnabled: config.allowProductionWrites });
