import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceApi } from './service.js';
import {
    batchIdInputSchema,
    batchOutputSchema,
    contextInputSchema,
    patientContextOutputSchema,
    recentSummaryInputSchema,
    recentSummaryOutputSchema,
    statusOutputSchema,
    submitBatchInputSchema,
} from './schemas.js';
import { SERVER_NAME, SERVER_VERSION } from './constants.js';
import { safeError } from './util.js';

function success(value: object, summary: string): CallToolResult {
    return {
        content: [{ type: 'text', text: summary }],
        structuredContent: value as Record<string, unknown>,
    };
}

function failure(error: unknown): CallToolResult {
    return { content: [{ type: 'text', text: safeError(error) }], isError: true };
}

export function createBahisServer(service: ServiceApi): McpServer {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

    server.registerTool(
        'bahis_status',
        {
            title: 'BAHIS MCP Status',
            description:
                'Check the local BAHIS database, signed-in token, Patient Registry form compatibility, semantic dropdown validation capability, production write setting, connectivity, region and pending draft count. Never returns credentials.',
            inputSchema: {},
            outputSchema: statusOutputSchema.shape,
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        async () => {
            try {
                const result = await service.status();
                return success(result, `BAHIS status checked. ${result.warnings.length} warning(s).`);
            } catch (error) {
                return failure(error);
            }
        },
    );

    server.registerTool(
        'bahis_patient_registry_recent_summary',
        {
            title: 'Recent Patient Registry Summary',
            description:
                'Summarize Patient Registry patterns for synthetic data generation without returning owner names, mobile numbers, UUIDs, dates or raw XML. Defaults to the 200 oldest usable records, which were entered by humans and read as the most natural templates. Pass order: "newest" to sample recent records instead.',
            inputSchema: recentSummaryInputSchema.shape,
            outputSchema: recentSummaryOutputSchema.shape,
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async (args) => {
            try {
                const { limit, order } = recentSummaryInputSchema.parse(args);
                const result = await service.recentPatientSummary(limit, order);
                return success(
                    result,
                    `Summarized ${result.usableRecordCount}/${result.scannedRecordCount} ${order} Patient Registry records${
                        result.oldestDate && result.newestDate ? ` (${result.oldestDate} to ${result.newestDate})` : ''
                    }.`,
                );
            } catch (error) {
                return failure(error);
            }
        },
    );

    server.registerTool(
        'bahis_patient_registry_context',
        {
            title: 'Patient Registry Generation Context',
            description:
                'Load the current required Patient Registry rules and valid location, species, clinical-sign and diagnosis IDs. Call this before generating a synthetic batch. Optionally filter clinical context by species.',
            inputSchema: contextInputSchema.shape,
            outputSchema: patientContextOutputSchema.shape,
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async (args) => {
            try {
                const input = contextInputSchema.parse(args);
                const result = await service.patientContext(input.species);
                return success(
                    result,
                    `Loaded Patient Registry context for ${result.species.length} species and ${result.locations.length} unions.`,
                );
            } catch (error) {
                return failure(error);
            }
        },
    );

    server.registerTool(
        'bahis_submit_patient_batch',
        {
            title: 'Submit Patient Registry Batch',
            description:
                'Validate, stage, upload and verify 1-50 synthetic Patient Registry entries. Generate records from bahis_patient_registry_context first. requestId makes retries idempotent: reuse it only with identical records.',
            inputSchema: submitBatchInputSchema.shape,
            outputSchema: batchOutputSchema.shape,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        async (args) => {
            try {
                const input = submitBatchInputSchema.parse(args);
                const result = await service.submitPatientBatch(input);
                return success(
                    result,
                    `Batch ${result.batchId}: ${result.verified}/${result.requested} verified, ${result.failed} failed.`,
                );
            } catch (error) {
                return failure(error);
            }
        },
    );

    server.registerTool(
        'bahis_verify_patient_batch',
        {
            title: 'Verify Patient Registry Batch',
            description:
                'Retrieve every UUID in a previous MCP batch from Kobo, validate current dropdown semantics, compare required-field hashes, and reconcile verified records into the local Patient Registry list.',
            inputSchema: batchIdInputSchema.shape,
            outputSchema: batchOutputSchema.shape,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        async (args) => {
            try {
                const { batchId } = batchIdInputSchema.parse(args);
                const result = await service.verifyPatientBatch(batchId);
                return success(
                    result,
                    `Batch ${result.batchId}: ${result.verified}/${result.requested} verified, ${result.failed} failed.`,
                );
            } catch (error) {
                return failure(error);
            }
        },
    );

    server.registerTool(
        'bahis_retry_patient_batch',
        {
            title: 'Retry Patient Registry Batch',
            description:
                'Retry only failed or unverified records from an MCP batch, preserving their original deterministic UUIDs and verifying required fields after upload.',
            inputSchema: batchIdInputSchema.shape,
            outputSchema: batchOutputSchema.shape,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        async (args) => {
            try {
                const { batchId } = batchIdInputSchema.parse(args);
                const result = await service.retryPatientBatch(batchId);
                return success(
                    result,
                    `Batch ${result.batchId}: ${result.verified}/${result.requested} verified, ${result.failed} failed.`,
                );
            } catch (error) {
                return failure(error);
            }
        },
    );

    return server;
}
