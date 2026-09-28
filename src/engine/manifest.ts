import { z } from 'zod';
import { workflowDefinitionSchema } from '../schemas/workflows';
import type { EngineRunOutcome } from './index';

/**
 * v2 run-spec manifest and result contracts (architecture.md §4.1). The
 * manifest is the ONLY input a deployed engine target receives; result.json is
 * the ONLY status output (the finalize Lambda persists it, session 2). Both are
 * versioned so the finalize path can keep ingesting v1 cv-runner results.
 *
 * S3 layout under workflows/v2/runs/<runId>/:
 *   manifest.json                    engine input (this schema)
 *   events.jsonl                     one EngineEventRecord per line
 *   outputs/<nodeId>/records.jsonl   Data Capture records (records.json when format=json)
 *   frames/<nodeId>/<seq>.jpg        session 2 (media graphs)
 *   artifacts/<nodeId>/...           session 2
 *   result.json                      this module's engineResultSchema
 */

export const ENGINE_VERSION = 2;

export const V2_RUN_PREFIX = 'workflows/v2/runs/';

export function runPrefix(runId: string): string {
  return `${V2_RUN_PREFIX}${runId}/`;
}
export function manifestKey(runId: string): string {
  return `${runPrefix(runId)}manifest.json`;
}
export function resultKey(runId: string): string {
  return `${runPrefix(runId)}result.json`;
}
export function eventsKey(runId: string): string {
  return `${runPrefix(runId)}events.jsonl`;
}
export function recordsKey(runId: string, nodeId: string, format: 'jsonl' | 'json'): string {
  return `${runPrefix(runId)}outputs/${nodeId}/records.${format}`;
}
export function frameKey(runId: string, nodeId: string, frameSeq: number): string {
  return `${runPrefix(runId)}frames/${nodeId}/${frameSeq}.jpg`;
}
/** Dispatcher-materialized source inputs (M4 telemetry seam). */
export function inputRecordsKey(runId: string, nodeId: string): string {
  return `${runPrefix(runId)}inputs/${nodeId}/records.jsonl`;
}

// Source bindings stay opaque here; each source executor zod-parses its own
// kinds (catalog/types.ts, EngineSourceBinding). New kinds never touch this.
const sourceBindingSchema = z.object({ kind: z.string().min(1) }).passthrough();

export const runManifestSchema = z.object({
  manifestVersion: z.literal(2),
  runId: z.string().min(1),
  mode: z.enum(['batch', 'live', 'simulation']),
  deviceId: z.string().nullable().default(null),
  // The run's data window (from trigger context); sources default to it.
  window: z.object({ from: z.string().min(1), to: z.string().min(1) }).nullable().default(null),
  // schemaVersion 2 definition (callers upgrade v1 before writing the manifest).
  definition: workflowDefinitionSchema,
  inputs: z.array(z.object({ nodeId: z.string().min(1), binding: sourceBindingSchema })).default([]),
  output: z.object({
    bucket: z.string().min(1),
    prefix: z.string().min(1), // runPrefix(runId)
  }),
  // ADDITIVE (M7, optional; absent on every pre-M7 manifest): the org that
  // owns the run, used by the secrets seam to resolve per-org credentials
  // (xorgate/orgs/<orgId>/<provider>) ahead of the platform secrets. Absent =
  // platform-only resolution, exactly the pre-M7 behavior. Deliberately an
  // explicit field: production manifests already embed the org id in
  // progress.topicPrefix, but the seam must not parse topics.
  orgId: z.string().min(1).optional(),
  // ADDITIVE (M3, optional; absent on every pre-M3 manifest): when present the
  // target publishes live progress to IoT topics under topicPrefix
  // (wf/sim/<orgId>/<runId>). Absent = silent run, exactly the M2 behavior.
  progress: z
    .object({
      channel: z.literal('iot'),
      topicPrefix: z.string().min(1),
    })
    .optional(),
  limits: z.object({ maxRuntimeSeconds: z.number().positive().optional() }).default({}),
});
export type RunManifest = z.infer<typeof runManifestSchema>;

export const engineStepSchema = z.object({
  seq: z.number().int().min(0),
  nodeId: z.string(),
  label: z.string(),
  status: z.enum(['ok', 'failed', 'skipped']),
  output: z.string().default(''),
  durationMs: z.number().min(0).default(0),
});

export const engineEventSchema = z.object({
  // Written by 0.5.0+; optional on read so an older result.json still parses.
  nodeId: z.string().optional(),
  kind: z.string(),
  occurredAt: z.string(),
  confidence: z.number().default(1),
  payloadSummary: z.string().default(''),
  payload: z.unknown().optional(),
  clipKey: z.string().nullish(), // session 2 (video evidence clips)
});

export const engineResultSchema = z.object({
  resultVersion: z.literal(2),
  engineVersion: z.literal(ENGINE_VERSION),
  runId: z.string(),
  status: z.enum(['succeeded', 'failed']),
  error: z.string().nullable(),
  failedNodeId: z.string().nullable(),
  steps: z.array(engineStepSchema),
  events: z.array(engineEventSchema),
  metrics: z.record(z.string(), z.union([z.number(), z.string()])),
  artifacts: z.object({
    eventsKey: z.string().nullable(),
    outputs: z.record(
      z.string(), // nodeId
      z.object({
        recordsKey: z.string(),
        count: z.number().int().min(0),
        format: z.enum(['jsonl', 'json']),
      }),
    ),
  }),
});
export type EngineResult = z.infer<typeof engineResultSchema>;

/**
 * Assembles result.json from a run outcome. `captureFormats` carries each Data
 * Capture node's configured format so the artifact keys match what the target
 * actually wrote.
 */
export function buildEngineResult(
  runId: string,
  outcome: EngineRunOutcome,
  captureFormats: Record<string, 'jsonl' | 'json'> = {},
): EngineResult {
  const outputs: EngineResult['artifacts']['outputs'] = {};
  for (const [nodeId, records] of Object.entries(outcome.captures)) {
    const format = captureFormats[nodeId] ?? 'jsonl';
    outputs[nodeId] = {
      recordsKey: recordsKey(runId, nodeId, format),
      count: records.length,
      format,
    };
  }
  return {
    resultVersion: 2,
    engineVersion: ENGINE_VERSION,
    runId,
    status: outcome.status,
    error: outcome.error,
    failedNodeId: outcome.failedNodeId,
    steps: outcome.steps,
    events: outcome.events.map((e) => ({ ...e, clipKey: null })),
    metrics: outcome.metrics,
    artifacts: {
      eventsKey: outcome.events.length > 0 ? eventsKey(runId) : null,
      outputs,
    },
  };
}
