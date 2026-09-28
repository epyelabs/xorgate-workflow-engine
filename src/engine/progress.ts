import { z } from 'zod';
import type {
  EngineArtifactSink,
  EngineEventRecord,
  EngineProgressSink,
  EngineProgressStep,
} from '../catalog/types';
import { decodeJpegToRgba, encodeRgbaToJpeg } from './media';

/**
 * Live-progress plane for simulation runs (architecture §5, M3). The engine
 * core reports through the EngineProgressSink seam; this module owns the wire
 * contract: topic names under wf/sim/<orgId>/<runId>/ and the JSON payload
 * schemas the frontend subscribes to over the existing Cognito-authed IoT WSS.
 *
 * Topics (topicPrefix = "wf/sim/<orgId>/<runId>"):
 *   <prefix>/status             simStatusPayloadSchema; published by the TARGET
 *                               on start and after the run (the core never owns
 *                               run lifecycle)
 *   <prefix>/steps              simStepPayloadSchema; one message per completed
 *                               node, as it completes
 *   <prefix>/events             simEventPayloadSchema; one message per emitted
 *                               event
 *   <prefix>/records/<nodeId>   simRecordPayloadSchema; json-channel messages
 *                               leaving <nodeId> (detections, speed limits) for
 *                               the client-side overlay (open question Q2)
 *   <prefix>/preview/<nodeId>   simPreviewPayloadSchema; downscaled base64
 *                               JPEGs teed off the visualization artifact sink
 *                               (the fallback/preview plane of Q2)
 *
 * Delivery is best-effort QoS 0: messages may drop, and every payload also
 * lands durably in S3 (steps/events via result.json, frames via the artifact
 * sink), so the FE treats topics as a live view, not the source of truth.
 */

export function simTopicPrefix(orgId: string, runId: string): string {
  return `wf/sim/${orgId}/${runId}`;
}

/**
 * Production twin of simTopicPrefix (M6): triggered runs publish the SAME
 * topic/payload contract under wf/run/<orgId>/<runId>, so the run-detail page
 * subscribes with the same machinery the simulator panel uses. The prefixes
 * stay distinct so IoT policy scoping can diverge later (per-org hardening).
 */
export function runTopicPrefix(orgId: string, runId: string): string {
  return `wf/run/${orgId}/${runId}`;
}

const isoAt = z.object({ at: z.string().min(1) });

export const simStatusPayloadSchema = isoAt.extend({
  runId: z.string().min(1),
  status: z.enum(['running', 'succeeded', 'failed']),
  error: z.string().nullable(),
  failedNodeId: z.string().nullable(),
});
export type SimStatusPayload = z.infer<typeof simStatusPayloadSchema>;

export const simStepPayloadSchema = isoAt.extend({
  runId: z.string().min(1),
  step: z.object({
    seq: z.number().int().min(0),
    nodeId: z.string().min(1),
    label: z.string(),
    status: z.enum(['ok', 'failed', 'skipped']),
    output: z.string(),
    durationMs: z.number().min(0),
  }),
});
export type SimStepPayload = z.infer<typeof simStepPayloadSchema>;

export const simEventPayloadSchema = isoAt.extend({
  runId: z.string().min(1),
  event: z.object({
    nodeId: z.string().optional(), // 0.5.0+
    kind: z.string(),
    occurredAt: z.string(),
    confidence: z.number(),
    payloadSummary: z.string(),
    payload: z.unknown().optional(),
  }),
});
export type SimEventPayload = z.infer<typeof simEventPayloadSchema>;

export const simRecordPayloadSchema = isoAt.extend({
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  port: z.string().min(1),
  tag: z.string().optional(),
  ts: z.number(),
  seq: z.number().int().min(0),
  payload: z.unknown(),
});
export type SimRecordPayload = z.infer<typeof simRecordPayloadSchema>;

export const simPreviewPayloadSchema = isoAt.extend({
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  frameSeq: z.number().int().min(0),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  jpegBase64: z.string().min(1),
});
export type SimPreviewPayload = z.infer<typeof simPreviewPayloadSchema>;

// IoT's message cap is 128 KB; stay comfortably under it after the JSON
// envelope. Records past the cap are dropped (they remain in the S3 records
// artifact); previews are downscaled first and dropped only if still too big.
const MAX_RECORD_PAYLOAD_BYTES = 100_000;
const MAX_PREVIEW_BASE64_BYTES = 110_000;
const PREVIEW_MAX_WIDTH = 480;
const PREVIEW_JPEG_QUALITY = 60;
// Per-node pacing so a chatty node cannot flood the WSS plane.
const MIN_RECORD_INTERVAL_MS = 100; // <= 10 records/s per node
const MIN_PREVIEW_INTERVAL_MS = 500; // <= 2 previews/s per node

/** Transport seam: deployed targets publish to IoT; tests capture in memory. */
export type ProgressTransport = (topic: string, payload: string) => Promise<void>;

/**
 * The EngineProgressSink implementation both deployed targets use. Publishes
 * are serialized on an internal chain (per-topic ordering) and errors are
 * swallowed after logging: progress must never fail or slow a run. Call
 * flush() after the run to await the tail.
 */
export class IotRunProgress implements EngineProgressSink {
  private chain: Promise<void> = Promise.resolve();
  private readonly lastRecordAt = new Map<string, number>();
  private readonly lastPreviewAt = new Map<string, number>();
  private dropped = 0;

  constructor(
    private readonly opts: {
      runId: string;
      topicPrefix: string;
      publish: ProgressTransport;
      log?: (message: string) => void;
    },
  ) {}

  private log(message: string): void {
    (this.opts.log ?? console.log)(`progress[${this.opts.runId}]: ${message}`);
  }

  private enqueue(topic: string, payload: unknown): void {
    const body = JSON.stringify(payload);
    this.chain = this.chain
      .then(() => this.opts.publish(topic, body))
      .catch((err) => {
        this.dropped += 1;
        this.log(`publish to ${topic} failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  runStatus(update: { status: 'running' | 'succeeded' | 'failed'; error?: string | null; failedNodeId?: string | null }): void {
    const payload: SimStatusPayload = {
      runId: this.opts.runId,
      status: update.status,
      error: update.error ?? null,
      failedNodeId: update.failedNodeId ?? null,
      at: new Date().toISOString(),
    };
    this.enqueue(`${this.opts.topicPrefix}/status`, payload);
  }

  step(step: EngineProgressStep): void {
    const payload: SimStepPayload = { runId: this.opts.runId, step, at: new Date().toISOString() };
    this.enqueue(`${this.opts.topicPrefix}/steps`, payload);
  }

  event(event: EngineEventRecord): void {
    const payload: SimEventPayload = {
      runId: this.opts.runId,
      event: {
        nodeId: event.nodeId,
        kind: event.kind,
        occurredAt: event.occurredAt,
        confidence: event.confidence,
        payloadSummary: event.payloadSummary,
        ...(event.payload !== undefined ? { payload: event.payload } : {}),
      },
      at: new Date().toISOString(),
    };
    this.enqueue(`${this.opts.topicPrefix}/events`, payload);
  }

  record(rec: { nodeId: string; port: string; tag?: string; ts: number; seq: number; payload: unknown }): void {
    const now = Date.now();
    const last = this.lastRecordAt.get(rec.nodeId) ?? -Infinity;
    if (now - last < MIN_RECORD_INTERVAL_MS) {
      this.dropped += 1;
      return;
    }
    const payload: SimRecordPayload = {
      runId: this.opts.runId,
      nodeId: rec.nodeId,
      port: rec.port,
      ...(rec.tag !== undefined ? { tag: rec.tag } : {}),
      ts: rec.ts,
      seq: rec.seq,
      payload: rec.payload,
      at: new Date().toISOString(),
    };
    const body = JSON.stringify(payload);
    if (body.length > MAX_RECORD_PAYLOAD_BYTES) {
      this.dropped += 1;
      return;
    }
    this.lastRecordAt.set(rec.nodeId, now);
    this.chain = this.chain
      .then(() => this.opts.publish(`${this.opts.topicPrefix}/records/${rec.nodeId}`, body))
      .catch((err) => {
        this.dropped += 1;
        this.log(`records publish failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  preview(nodeId: string, frameSeq: number, jpegBuf: Buffer): void {
    const now = Date.now();
    const last = this.lastPreviewAt.get(nodeId) ?? -Infinity;
    if (now - last < MIN_PREVIEW_INTERVAL_MS) return; // pacing, not an error
    let downscaled: { jpeg: Buffer; width: number; height: number };
    try {
      downscaled = downscaleJpeg(jpegBuf, PREVIEW_MAX_WIDTH, PREVIEW_JPEG_QUALITY);
    } catch (err) {
      this.log(`preview downscale failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const jpegBase64 = downscaled.jpeg.toString('base64');
    if (jpegBase64.length > MAX_PREVIEW_BASE64_BYTES) {
      this.dropped += 1;
      return;
    }
    this.lastPreviewAt.set(nodeId, now);
    const payload: SimPreviewPayload = {
      runId: this.opts.runId,
      nodeId,
      frameSeq,
      width: downscaled.width,
      height: downscaled.height,
      jpegBase64,
      at: new Date().toISOString(),
    };
    this.enqueue(`${this.opts.topicPrefix}/preview/${nodeId}`, payload);
  }

  /** Awaits the publish chain; logs how many messages were dropped/paced out. */
  async flush(): Promise<void> {
    await this.chain;
    if (this.dropped > 0) this.log(`${this.dropped} progress message(s) dropped (pacing/size/errors)`);
  }
}

/**
 * Wraps a target's artifact sink so every visualization JPEG also feeds the
 * preview topic. The inner write is authoritative; preview is best-effort.
 */
export function teeArtifactSink(inner: EngineArtifactSink, progress: IotRunProgress): EngineArtifactSink {
  return {
    async putFrame(nodeId, frameSeq, jpegBuf) {
      const key = await inner.putFrame(nodeId, frameSeq, jpegBuf);
      progress.preview(nodeId, frameSeq, jpegBuf);
      return key;
    },
  };
}

/** Nearest-neighbor RGBA downscale + re-encode; passthrough when small enough. */
function downscaleJpeg(jpegBuf: Buffer, maxWidth: number, quality: number): { jpeg: Buffer; width: number; height: number } {
  const { width, height, data } = decodeJpegToRgba(jpegBuf);
  if (width <= maxWidth) {
    return { jpeg: encodeRgbaToJpeg(data, width, height, quality), width, height };
  }
  const outW = maxWidth;
  const outH = Math.max(2, Math.round((height * maxWidth) / width / 2) * 2);
  const out = Buffer.alloc(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const srcY = Math.min(height - 1, Math.floor((y * height) / outH));
    for (let x = 0; x < outW; x++) {
      const srcX = Math.min(width - 1, Math.floor((x * width) / outW));
      const src = (srcY * width + srcX) * 4;
      const dst = (y * outW + x) * 4;
      out[dst] = data[src];
      out[dst + 1] = data[src + 1];
      out[dst + 2] = data[src + 2];
      out[dst + 3] = 255;
    }
  }
  return { jpeg: encodeRgbaToJpeg(out, outW, outH, quality), width: outW, height: outH };
}
