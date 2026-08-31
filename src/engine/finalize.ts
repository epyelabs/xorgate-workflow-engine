import { ENGINE_VERSION, type EngineResult } from './manifest';

/**
 * Pure row-mapping for the v2 finalize path (workflow-run-finalize.ts). Kept
 * DB-free so the headless smoke script can assert the mapping against a
 * synthetic result.json; the handler owns the drizzle calls and idempotency.
 */

export interface V2StepRow {
  runId: string;
  seq: number;
  nodeId: string;
  label: string;
  status: 'ok' | 'failed' | 'skipped';
  output: string;
  durationMs: number;
}

export function v2StepRows(runId: string, result: EngineResult): V2StepRow[] {
  return result.steps.map((s) => ({
    runId,
    seq: s.seq,
    nodeId: s.nodeId,
    label: s.label,
    status: s.status,
    output: s.output,
    durationMs: Math.round(s.durationMs),
  }));
}

export interface V2EventRow {
  runId: string;
  deviceId: string | null; // null on device-less simulation runs (migration 0015)
  kind: string;
  occurredAt: Date;
  confidence: number;
  clip: boolean;
  clipS3Key: string | null;
  payloadSummary: string;
  payload: unknown;
}

export function v2EventRows(
  run: { id: string; deviceId: string | null },
  result: EngineResult,
): V2EventRow[] {
  return result.events.map((e) => ({
    runId: run.id,
    deviceId: run.deviceId,
    kind: e.kind,
    occurredAt: new Date(e.occurredAt),
    confidence: e.confidence,
    clip: Boolean(e.clipKey),
    clipS3Key: e.clipKey ?? null,
    payloadSummary: e.payloadSummary,
    payload: e.payload ?? null,
  }));
}

export interface V2RunUpdate {
  status: 'succeeded' | 'failed';
  endedAt: Date;
  durationMs: number;
  metrics: Record<string, number | string>;
  eventCount: number;
  error: string | null;
  failedNodeId: string | null;
  engineVersion: number;
  artifacts: EngineResult['artifacts'];
}

export function v2RunUpdate(result: EngineResult, startedAt: Date, now: Date): V2RunUpdate {
  return {
    status: result.status,
    endedAt: now,
    durationMs: now.getTime() - startedAt.getTime(),
    metrics: result.metrics,
    eventCount: result.events.length,
    error: result.error,
    failedNodeId: result.failedNodeId,
    engineVersion: ENGINE_VERSION,
    artifacts: result.artifacts,
  };
}
