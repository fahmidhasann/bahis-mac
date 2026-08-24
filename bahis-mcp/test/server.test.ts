import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBahisServer } from '../src/server.js';
import type { ServiceApi } from '../src/service.js';
import type { BatchResult, PatientContext, RecentPatientSummary, StatusResult, SubmitBatchInput } from '../src/types.js';

const status: StatusResult = {
    databaseFound: true,
    authenticated: true,
    productionWritesEnabled: true,
    serverReachable: true,
    formCompatible: true,
    semanticChoiceValidation: true,
    formUid: 'ajAsiLXLghXg2c2BXFMQbV',
    region: {
        division: { id: 1, title: 'DHAKA' },
        district: { id: 2, title: 'DHAKA' },
        upazila: { id: 3, title: 'SAVAR' },
    },
    pendingDrafts: 0,
    warnings: [],
};

const emptyBatch = (batchId: string): BatchResult => ({
    batchId,
    requested: 0,
    accepted: 0,
    verified: 0,
    failed: 0,
    records: [],
});

const context: PatientContext = {
    formUid: status.formUid,
    contractHash: 'hash',
    region: status.region!,
    locations: [],
    species: [],
    clinicalSigns: [],
    tentativeDiagnoses: [],
    rules: [],
};

const recentSummary: RecentPatientSummary = {
    requestedLimit: 200,
    order: 'oldest',
    oldestDate: '2025-01-27',
    newestDate: '2025-03-12',
    scannedRecordCount: 0,
    usableRecordCount: 0,
    skippedRecordCount: 0,
    speciesProfiles: [],
    locationPatterns: [],
    clinicalPatterns: [],
};

/** Records what the server forwarded, so the default and explicit order can be asserted. */
const summaryCalls: Array<{ limit?: number; order?: string }> = [];

const service: ServiceApi = {
    async status() {
        return status;
    },
    async patientContext() {
        return context;
    },
    async recentPatientSummary(limit, order) {
        summaryCalls.push({ limit, order });
        return recentSummary;
    },
    async submitPatientBatch(input: SubmitBatchInput) {
        return emptyBatch(input.requestId);
    },
    async verifyPatientBatch(batchId: string) {
        return emptyBatch(batchId);
    },
    async retryPatientBatch(batchId: string) {
        return emptyBatch(batchId);
    },
};

test('lists the six narrow BAHIS tools and calls status through MCP', async () => {
    const server = createBahisServer(service);
    const client = new Client({ name: 'bahis-mcp-test', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const listed = await client.listTools();
    assert.deepEqual(
        listed.tools.map((tool) => tool.name).sort(),
        [
            'bahis_patient_registry_context',
            'bahis_patient_registry_recent_summary',
            'bahis_retry_patient_batch',
            'bahis_status',
            'bahis_submit_patient_batch',
            'bahis_verify_patient_batch',
        ],
    );
    const result = await client.callTool({ name: 'bahis_status', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, status);

    const summaryResult = await client.callTool({ name: 'bahis_patient_registry_recent_summary', arguments: {} });
    assert.equal(summaryResult.isError, undefined);
    assert.deepEqual(summaryResult.structuredContent, recentSummary);
    // No arguments must reach the service as the oldest window, which is the requested default.
    assert.deepEqual(summaryCalls.at(-1), { limit: 200, order: 'oldest' });

    await client.callTool({
        name: 'bahis_patient_registry_recent_summary',
        arguments: { limit: 50, order: 'newest' },
    });
    assert.deepEqual(summaryCalls.at(-1), { limit: 50, order: 'newest' });

    await client.close();
    await server.close();
});

test('MCP input validation rejects an empty submission batch', async () => {
    const server = createBahisServer(service);
    const client = new Client({ name: 'bahis-mcp-test', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const result = await client.callTool({
        name: 'bahis_submit_patient_batch',
        arguments: { requestId: 'empty-batch', records: [] },
    });
    assert.equal(result.isError, true);
    await client.close();
    await server.close();
});
