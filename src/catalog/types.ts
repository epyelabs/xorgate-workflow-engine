import { z } from 'zod';
import type { ModelManifest } from '../models/registry';

/**
 * NodeTypeDef: the declarative half of a catalog node type (architecture.md §3.2,
 * the authoritative contract). One module per node type under ./nodes colocates
 * this def with its executor (stubbed until M2's engine core). Everything else —
 * the served catalog, publish validation, edge typing, capability computation,
 * dispatch routing — derives from these defs.
 */

// --- Channels (architecture.md §3.3) -----------------------------------------
// `json` ports additionally carry a `tag` ("detections", "depth", ...). An edge
// is valid iff base channels match and, when the input port declares a tag, the
// tags match; an untagged json input accepts any json:<tag>.
export const CHANNELS = ['video', 'frames', 'telemetry', 'json', 'condition', 'event'] as const;
export type Channel = (typeof CHANNELS)[number];

export const portDefSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    channel: z.enum(CHANNELS),
    // json channels only; on outputs the tag is what the port produces, on
    // inputs it is what the port accepts (absent = any json tag).
    tag: z.string().min(1).optional(),
    cardinality: z.enum(['one', 'many']),
    required: z.boolean(),
  })
  .refine((p) => p.tag === undefined || p.channel === 'json', {
    message: 'tag is only valid on json ports',
  });
export type PortDef = z.infer<typeof portDefSchema>;

/** True iff an edge from `out` may enter `inp` (channel + json-tag rules). */
export function channelsCompatible(out: PortDef, inp: PortDef): boolean {
  if (out.channel !== inp.channel) return false;
  if (inp.channel === 'json' && inp.tag !== undefined) return out.tag === inp.tag;
  return true;
}

/** Wire label for a port's channel, e.g. "json:detections". */
export function channelLabel(port: PortDef): string {
  return port.channel === 'json' && port.tag ? `json:${port.tag}` : port.channel;
}

// --- Capability rules ---------------------------------------------------------
// { token } contributes a fixed token; { tokenTemplate } substitutes a config
// value ("metric:{config.metric}"). When the referenced config value is a string
// array, one token is emitted per element (e.g. telemetry_history metrics).
export const capabilityRuleSchema = z.union([
  z.object({ token: z.string().min(1) }),
  z.object({
    tokenTemplate: z
      .string()
      .regex(/^[^{}]*\{config\.[a-zA-Z0-9_.]+\}[^{}]*$/, 'exactly one {config.<path>} placeholder'),
  }),
]);
export type CapabilityRule = z.infer<typeof capabilityRuleSchema>;

// --- NodeTypeDef ----------------------------------------------------------------
export const NODE_GROUPS = [
  'source',
  'video',
  'telemetry',
  'model',
  'logic',
  'output',
  // Reserved for the user-code nodes (function.javascript, function.python);
  // empty until they ship. Renamed from `custom` in distribution M4.
  'function',
] as const;
export type NodeGroup = (typeof NODE_GROUPS)[number];

// Cross-port publish constraints that single-port `required` flags cannot
// express (e.g. visualization: at least one of its overlay inputs connected).
export const nodeConstraintSchema = z.object({
  kind: z.literal('atLeastOneOf'),
  ports: z.array(z.string().min(1)).min(2), // input port ids
});
export type NodeConstraint = z.infer<typeof nodeConstraintSchema>;

// A live zod schema, recognized by shape rather than by `instanceof`: a node
// pack loaded into a CommonJS process from an ES module (or the reverse)
// carries the other build of zod, whose classes are distinct objects. Every
// consumer of `def.config` only ever calls `safeParse`/`parse` or walks `_def`
// (zod-to-json-schema), so the shape is the contract.
function isZodSchema(v: unknown): v is z.ZodTypeAny {
  if (v instanceof z.ZodType) return true;
  const candidate = v as { safeParse?: unknown; parse?: unknown; _def?: unknown } | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.safeParse === 'function' &&
    typeof candidate.parse === 'function' &&
    typeof candidate._def === 'object'
  );
}

// Declarative fields, zod-validated at registry build time. `config` is a live
// zod schema and is validated structurally (see isZodSchema) rather than by shape.
export const nodeTypeDefSchema = z.object({
  type: z.string().regex(/^[a-z0-9_]+\.[a-z0-9_]+$/, 'namespaced lowercase type id'),
  version: z.number().int().positive(),
  group: z.enum(NODE_GROUPS),
  label: z.string().min(1),
  description: z.string().min(1),
  ui: z.object({
    icon: z.string().min(1), // lucide icon name (kebab-case)
    // `code` is the function-node editor (distribution M7); additive.
    editor: z.enum(['prompt', 'geofence', 'expression', 'code']).optional(),
  }),
  inputs: z.array(portDefSchema),
  outputs: z.array(portDefSchema),
  config: z.custom<z.ZodTypeAny>(isZodSchema, 'config must be a zod schema'),
  requires: z.array(capabilityRuleSchema),
  runtime: z.object({
    target: z.enum(['any', 'media']), // "media" forces the Fargate engine
    gpuPreferred: z.boolean().optional(), // routes model backend, not engine
    modelRef: z.object({ family: z.string().min(1) }).optional(),
  }),
  constraints: z.array(nodeConstraintSchema).optional(),
});
export type NodeTypeDef = z.infer<typeof nodeTypeDefSchema>;

/** Identity helper so node modules get inference + a build-time parse. */
export function defineNode(def: NodeTypeDef): NodeTypeDef {
  return def;
}

// --- Executor contract (architecture.md §4.1, refined in M2) -------------------
// Executors are async generators wired together by the engine core
// (src/workflows/engine/). Each yielded message is routed to the bounded
// channels of every edge leaving the resolved output port; awaiting the yield
// is what gives batch sources natural backpressure.

export type EngineMode = 'batch' | 'live' | 'simulation';

/** One message on a channel. `ts` is epoch milliseconds. */
export interface EngineMessage {
  ch: Channel;
  /** json channels only: the tag the payload carries (e.g. "detections"). */
  tag?: string;
  /**
   * Output port the message leaves on. May be omitted when the node has exactly
   * one output port (or a single port whose channel matches `ch`).
   */
  port?: string;
  ts: number;
  /** Per-node monotonic sequence, stamped by the engine. */
  seq: number;
  payload: unknown;
}

/** What executors yield: `seq` is optional and overwritten by the engine. */
export type EngineEmit = Omit<EngineMessage, 'seq'> & { seq?: number };

// Payload contracts per channel (json payloads are tag-specific).
export interface TelemetryPayload {
  signals: Record<string, number>;
}
export interface ConditionPayload {
  value: boolean;
  /** Which signal/comparison produced this value, for event payloads. */
  meta?: Record<string, unknown>;
}
/**
 * `video` channel payload: a reference to media the TARGET has already made
 * local (source.video resolves its binding through ctx.sources.fetchVideo).
 * `startedAtMs` anchors frame timestamps to wall-clock time.
 */
export interface VideoPayload {
  path: string;
  startedAtMs: number;
  /** On-device session this segment belongs to (`device_session` bindings). */
  sessionId?: string | null;
  /** Segment index within that session; null when the source isn't segmented. */
  segmentSeq?: number | null;
  /**
   * How much wall-clock time this media is allowed to cover. For a session
   * segment it is the EFFECTIVE duration (the next segment's startTs delta),
   * so a decoder must not emit frames past `startedAtMs + durationMs` — an
   * fstat-inflated duration would otherwise overlap the next segment's anchor.
   * Absent = decode everything the file contains.
   */
  durationMs?: number;
  /**
   * True when the target may delete `path` once this media has been fully
   * decoded (via ctx.sources.releaseVideo). Set for session segments, where a
   * long run would otherwise accumulate GBs of fetched .mp4s on the task disk;
   * never set for caller-owned files (uploads, local test fixtures).
   */
  releasable?: boolean;
  /**
   * M5 live plane: when set, `path` is a placeholder and the video is a live
   * frame stream the target exposes through ctx.sources.openLiveFrames
   * (webcam-over-MQTT today). video.decode_sample becomes a sampling
   * pass-through for these (M1 decision 10): frames arrive pre-encoded as
   * JPEGs from the browser, so no ffmpeg decode is spawned. In-process
   * contract only; never serialized.
   */
  live?: LiveVideoRef;
}
export interface LiveVideoRef {
  /** The SOURCE node id; the target derives the ingest topic from it. */
  nodeId: string;
  /** Hard stop for the live stream; the run then drains and succeeds. */
  maxDurationMs: number;
  /** No frames for this long ends the stream cleanly (browser went away). */
  idleTimeoutMs: number;
}
/** One live ingest frame as delivered by the target's transport. */
export interface LiveIngestFrame {
  seq: number;
  ts: number;
  jpeg: Buffer;
}
/**
 * `frames` channel payload (M2 session 2). `image` is a SHARED raw RGBA buffer
 * (zero serialization between nodes, architecture §4.1) — consumers must copy
 * before mutating. `seq` is the decoder frame index within the source stream
 * (distinct from the engine's per-node message seq) so detections, evidence,
 * and visualization artifacts can reference the same frame.
 */
export interface FramePayload {
  seq: number;
  ts: number;
  image: Buffer;
  width: number;
  height: number;
  format: 'rgba';
}
/** json:detections payload: one message per frame, boxes in original pixels. */
export interface DetectionBox {
  cls: string;
  confidence: number;
  /** [x1, y1, x2, y2] in source-frame pixels. */
  xyxy: [number, number, number, number];
}
export interface DetectionsPayload {
  ts: number;
  frameSeq: number;
  width: number;
  height: number;
  boxes: DetectionBox[];
}
/**
 * json:depth payload (M4): one message per frame. The full-resolution float map
 * never leaves the depth executor; the payload embeds a DOWNSAMPLED uint8 map
 * (base64, <= DEPTH_MAP_MAX_WIDTH wide) so records stay JSON-friendly on every
 * plane that serializes them (data capture, IoT records topic) while still
 * carrying enough signal for visualization blending and per-box statistics.
 * Values are per-frame normalized inverse depth: 255/1.0 = nearest. `boxes` is
 * present when a json:detections input is wired into the depth node; per-box
 * `proximity` (median normalized inverse depth inside the box, 0..1, higher =
 * closer) is the distance-from-depth-plus-bbox derivation.
 */
export interface DepthMapEmbed {
  width: number;
  height: number;
  /** Raw min/max of the model output before normalization (per frame). */
  min: number;
  max: number;
  encoding: 'u8';
  /** base64 of width*height uint8 normalized inverse-depth values. */
  data: string;
}
export interface DepthBox extends DetectionBox {
  /** Median normalized inverse depth inside the box (0..1, higher = closer). */
  proximity: number;
}
export interface DepthPayload {
  ts: number;
  frameSeq: number;
  width: number;
  height: number;
  stats: { min: number; max: number; mean: number; median: number };
  map: DepthMapEmbed;
  boxes?: DepthBox[];
}
/**
 * json:segments payload (M4): one message per frame, empty `instances`
 * included. Each instance mask is binarized at the model's proto resolution,
 * cropped to the box, and packed 1 bit per pixel (row-major, MSB first) so a
 * typical instance is a few hundred base64 bytes.
 */
export interface SegmentInstance {
  cls: string;
  confidence: number;
  /** [x1, y1, x2, y2] in source-frame pixels. */
  xyxy: [number, number, number, number];
  mask: {
    /** Mask grid size (the box region sampled at proto resolution). */
    width: number;
    height: number;
    encoding: 'bitpack';
    /** base64 of ceil(width*height/8) bytes, row-major, MSB = leftmost. */
    data: string;
  };
}
export interface SegmentsPayload {
  ts: number;
  frameSeq: number;
  width: number;
  height: number;
  instances: SegmentInstance[];
}
/**
 * json:vlm payload (M5): one message per SAMPLED frame (model.vlm samples well
 * below the frame rate; vision tokens scale with fps and resolution). The
 * verdict is enforced with Claude structured outputs, so `verdict` /
 * `confidence` / `reason` are clean values, never parsed prose.
 */
export interface VlmPayload {
  ts: number;
  frameSeq: number;
  verdict: boolean;
  /** Model self-reported confidence in the verdict, clamped to 0..1. */
  confidence: number;
  reason: string;
  model: string;
}

/** One input connection: `port` is this node's input port id; one entry per edge. */
export interface EngineInChannel {
  port: string;
  from: { nodeId: string; port: string };
  messages: AsyncIterable<EngineMessage>;
}

/** A grouped telemetry sample as read from a source feed. */
export interface TelemetrySample {
  ts: number; // epoch ms
  signals: Record<string, number>;
}

/**
 * Data-access seam for source and model nodes. The engine core is storage-free;
 * each deploy target supplies an implementation (the Lambda target reads
 * telemetry_readings via drizzle, the Fargate target downloads S3 media/models,
 * tests read from memory/local files, CSV lands in M3).
 *
 * The media methods are optional: a target that does not supply them cannot
 * run the executors that need them (source.video, model.*), which fail with a
 * clear error instead of misbehaving. Conversely the Fargate target supplies
 * NO telemetry reader (its task role has no DB access): a media graph that
 * needs device telemetry history fails that source explicitly.
 */
export interface EngineSourceReader {
  readTelemetryWindow(query: {
    deviceId: string;
    metrics: string[];
    window: { fromMs: number; toMs: number };
  }): Promise<TelemetrySample[]>;
  /** Fetches a video object to local disk (Fargate target: S3 download). */
  fetchVideo?(ref: { bucket: string | null; key: string }): Promise<{ path: string }>;
  /**
   * Frees a file `fetchVideo` wrote, once its consumer is done with it. Only
   * called for payloads flagged `releasable` (session segments). Optional: a
   * target without it simply keeps every fetched file until the task exits,
   * which is the pre-Phase-W behavior.
   */
  releaseVideo?(path: string): Promise<void>;
  /**
   * Fetches a small text object (telemetry CSV uploads, M3). Both deployed
   * targets implement it with S3 GetObject; tests read from memory.
   */
  fetchText?(ref: { bucket: string | null; key: string }): Promise<string>;
  /**
   * Resolves a registry model to a validated manifest plus a local model.onnx
   * (src/workflows/models/). Targets cache per (family, name).
   */
  fetchModel?(ref: {
    family: string;
    name: string;
  }): Promise<{ manifest: ModelManifest; modelPath: string }>;
  /**
   * Opens the live ingest frame stream for a source node (M5 webcam-over-MQTT).
   * The container target subscribes to the run's ingest topic
   * (<topicPrefix>/ingest/<nodeId>); tests inject synthetic frames. The
   * iterable ends cleanly on an explicit end message, maxDurationMs, or
   * idleTimeoutMs without frames. Absent on targets without a live plane.
   */
  openLiveFrames?(ref: {
    nodeId: string;
    maxDurationMs: number;
    idleTimeoutMs: number;
  }): AsyncIterable<LiveIngestFrame>;
}

/**
 * Artifact sink for executors that produce binary outputs (annotated
 * visualization JPEGs today; depth maps / clips later). Supplied by the deploy
 * target (S3 under the run prefix; a temp dir in tests); absent on targets
 * with no media support.
 */
export interface EngineArtifactSink {
  /** Writes frames/<nodeId>/<frameSeq>.jpg; returns the key/path written. */
  putFrame(nodeId: string, frameSeq: number, jpeg: Buffer): Promise<string>;
}

/**
 * Secret-access seam for executors that call third-party APIs (the Roads
 * connector). Names are LOGICAL ("google-roads-api-key"); each deploy target
 * maps them to physical Secrets Manager names via its own env and caches the
 * values for the container/task lifetime. Absent (null on ctx) when a target
 * has no secret access.
 */
export interface EngineSecretReader {
  getSecret(logicalName: string): Promise<string>;
}

/**
 * Progress sink (M3 simulator, architecture §5). Supplied by the deploy target
 * when the run manifest carries a `progress` block; the engine core calls
 * `step`/`event` as they happen and json-channel messages tee through
 * `record`. All methods are fire-and-forget: implementations queue internally,
 * never throw into the engine, and the target flushes after the run. `preview`
 * is called by the target-side artifact-sink tee, not by the core.
 */
export interface EngineProgressStep {
  seq: number;
  nodeId: string;
  label: string;
  status: 'ok' | 'failed' | 'skipped';
  output: string;
  durationMs: number;
}
export interface EngineProgressSink {
  runStatus(update: {
    status: 'running' | 'succeeded' | 'failed';
    error?: string | null;
    failedNodeId?: string | null;
  }): void;
  step(step: EngineProgressStep): void;
  event(event: EngineEventRecord): void;
  /** A json-channel message leaving `nodeId` (detections, speed limits, ...). */
  record?(rec: { nodeId: string; port: string; tag?: string; ts: number; seq: number; payload: unknown }): void;
  /** Downscaled preview JPEG for a node (fed by the artifact-sink tee). */
  preview?(nodeId: string, frameSeq: number, jpeg: Buffer): void;
}

/**
 * A source node's input binding from the run manifest. Deliberately loose here:
 * each source executor owns (and zod-parses) its binding kinds, so new kinds
 * never touch this contract. source.telemetry accepts `telemetry_history`
 * (metrics/window, defaulted from config and the run window), and
 * `telemetry_inline` ({ samples }) for tests; `telemetry_csv` arrives in M3.
 */
export type EngineSourceBinding = { kind: string } & Record<string, unknown>;

/** An event record collected by output.event, persisted by the finalize path. */
export interface EngineEventRecord {
  kind: string;
  occurredAt: string; // ISO-8601
  confidence: number;
  payloadSummary: string;
  payload?: unknown;
}

/**
 * Per-node run context. Constructed by the engine core; the collector callbacks
 * feed the run outcome (events.jsonl, outputs/<nodeId>/records.jsonl, step
 * summaries) without giving executors any storage access.
 */
export interface EngineRunCtx {
  runId: string;
  mode: EngineMode;
  deviceId: string | null;
  /** The run's data window (epoch ms), when the trigger context provides one. */
  window: { fromMs: number; toMs: number } | null;
  /** The executing node's instance id. */
  nodeId: string;
  /** Manifest input binding for this node (source nodes), if any. */
  binding: EngineSourceBinding | null;
  sources: EngineSourceReader;
  /** Binary-artifact sink; null on targets without media support. */
  artifacts: EngineArtifactSink | null;
  /** Secret access; null on targets without it (connector nodes then fail). */
  secrets: EngineSecretReader | null;
  /** HTTP layer for connector executors; injectable so tests run offline. */
  http: typeof fetch;
  /** Collect an event (output.event). */
  emitEvent(event: EngineEventRecord): void;
  /** Collect a captured record (output.data_capture). */
  captureRecord(record: unknown): void;
  /** Human one-liner for the node's step row (last call wins). */
  setSummary(summary: string): void;
  /** A diagnostic line; `level` (additive, distribution M7) defaults to `info`. */
  log(message: string, level?: 'info' | 'debug'): void;
  /**
   * Tees a json record to the progress sink without emitting it on an output
   * port (additive, distribution M7): function nodes report their log lines
   * this way, as `record` messages on the pseudo-port `log`, tagged `log`,
   * with `{ line, invocation }` as the payload. Absent on engines older than
   * 0.2.0; a node checks before calling.
   */
  emitRecord?(rec: { port: string; tag: string; ts: number; payload: unknown }): void;
}

/**
 * One executor per node type, colocated with its def. `config` arrives already
 * parsed through the def's zod schema (defaults applied); executors re-parse
 * with their local schema constant to regain the inferred type.
 */
export type NodeExecutor = (
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
) => AsyncIterable<EngineEmit>;

/** Throwing placeholder for node types this engine build does not execute yet. */
export function stubExecutor(type: string): NodeExecutor {
  return async function* stub(): AsyncIterable<EngineEmit> {
    throw new Error(`Executor for "${type}" is not implemented in this engine build`);
  };
}
