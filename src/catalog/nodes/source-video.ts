import { z } from 'zod';
import type { EngineEmit, EngineInChannel, EngineRunCtx, VideoPayload } from '../types';
import { defineNode } from '../types';

// Abstract video input. The template only declares "this workflow consumes
// video"; the CONCRETE feed (uploaded file, on-device session, live stream, or
// webcam) is a binding chosen when the workflow is attached to a device or when
// a simulation is started, never on the template.
export const def = defineNode({
  type: 'source.video',
  version: 1,
  group: 'source',
  label: 'Video',
  description:
    'Video input. The concrete feed (file, on-device session, live stream, webcam) is bound at attach or simulation time.',
  ui: { icon: 'video' },
  inputs: [],
  outputs: [{ id: 'video', label: 'Video', channel: 'video', cardinality: 'many', required: false }],
  config: z.object({
    streamKey: z
      .string()
      .min(1)
      .optional()
      .describe('Restrict device bindings to this camera stream (default: any)'),
  }),
  requires: [{ token: 'video' }],
  runtime: { target: 'any' },
});

// Binding kinds this source accepts (executor-owned union, session 1 pattern).
// Batch kinds resolve to an object the target fetches to local disk through
// ctx.sources.fetchVideo; `device_session` is the multi-segment case (one
// fetch + one emit per segment) and `video_local` short-circuits to a path
// already on disk (tests, and the M3 simulator's warm-session cache).
// The cloud recorder's `recording` kind was deleted outright with the recorder
// (destroy-kvs-recorder Phase W, decision K — no compatibility window).
// `webcam` (M5) is the live plane: the browser publishes sampled JPEG frames
// to the run's ingest topic and the target exposes them through
// ctx.sources.openLiveFrames;
// this executor emits a live VideoPayload that video.decode_sample consumes as
// a sampling pass-through. `device_live` (device-side frame publish, symmetric
// with webcam) remains reserved and throws.
const WEBCAM_DEFAULT_MAX_DURATION_SECONDS = 300;
const WEBCAM_IDLE_TIMEOUT_SECONDS = 60;
const bindingSchema = z.discriminatedUnion('kind', [
  // An on-device recording session: N ~60 s segments, each standalone-playable
  // H.264 starting on a keyframe. The executor yields ONE VideoPayload per
  // segment, anchored at that segment's own startTs — video.decode_sample
  // already loops over multiple video messages and timestamps frames off the
  // message's startedAtMs, so per-segment re-anchoring costs nothing, bounds
  // drift to a single segment instead of accumulating, and makes gaps free
  // (the next segment simply re-anchors). destroy-kvs-recorder README §9.
  //
  // `segment_uploaded` runs use this same kind with a one-element `segments`.
  z.object({
    kind: z.literal('device_session'),
    sessionId: z.string().min(1),
    streamKey: z.string().min(1).optional(),
    bucket: z.string().min(1).optional(), // default: the run's output bucket
    // ntp | rtc | unsynced — logged so a desynced correlation is visible in
    // the step output rather than silently wrong (README §9 risk 3).
    timeSource: z.string().min(1).optional(),
    segments: z
      .array(
        z.object({
          s3Key: z.string().min(1),
          startTs: z.number(), // epoch ms
          durationMs: z.number().nonnegative(),
          // Next-segment delta when contiguous, else durationMs. Clamps frame
          // emission so an fstat-inflated durationMs cannot push frames past
          // the next segment's startTs (README §9 risk 8).
          effectiveDurationMs: z.number().nonnegative().optional(),
          seq: z.number().optional(),
        }),
      )
      .min(1),
  }),
  z.object({
    kind: z.literal('video_file'), // uploaded file (M3 presigned upload)
    s3Key: z.string().min(1),
    bucket: z.string().min(1).optional(),
    startedAt: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('video_local'), // tests / already-local media
    path: z.string().min(1),
    startedAt: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal('device_live') }).passthrough(), // reserved (M5 stretch not taken)
  z.object({
    kind: z.literal('webcam'),
    maxDurationSeconds: z.number().positive().max(1800).optional(),
  }),
]);

function parseMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export const executor = async function* sourceVideo(
  _inputs: EngineInChannel[],
  _config: unknown,
  ctx: EngineRunCtx,
): AsyncIterable<EngineEmit> {
  if (!ctx.binding) throw new Error('Video source has no input binding on this run');
  const parsed = bindingSchema.safeParse(ctx.binding);
  if (!parsed.success) {
    throw new Error(`Unsupported video binding "${String(ctx.binding.kind)}"`);
  }
  const binding = parsed.data;
  if (binding.kind === 'device_live') {
    throw new Error('Live device streams are not available yet (device-side frame publish is not enabled)');
  }
  if (binding.kind === 'webcam') {
    if (!ctx.sources.openLiveFrames) {
      throw new Error('This engine target has no live ingest support (webcam bindings need the media engine)');
    }
    const maxDurationMs = (binding.maxDurationSeconds ?? WEBCAM_DEFAULT_MAX_DURATION_SECONDS) * 1000;
    const anchor = Date.now(); // live frames carry their own browser-stamped ts
    ctx.setSummary(`live webcam ingest (max ${Math.round(maxDurationMs / 1000)}s)`);
    const payload: VideoPayload = {
      path: `live:${ctx.nodeId}`,
      startedAtMs: anchor,
      live: {
        nodeId: ctx.nodeId,
        maxDurationMs,
        idleTimeoutMs: WEBCAM_IDLE_TIMEOUT_SECONDS * 1000,
      },
    };
    yield { ch: 'video' as const, ts: anchor, payload };
    return;
  }

  if (binding.kind === 'device_session') {
    if (!ctx.sources.fetchVideo) {
      throw new Error('This engine target cannot fetch video inputs (no media support)');
    }
    // Already ordered by startTs upstream (services/media-session-input.ts);
    // sorted again here so a hand-written manifest can't desync the clock.
    const segments = [...binding.segments].sort((a, b) => a.startTs - b.startTs);
    const total = segments.length;
    const label = binding.streamKey ? `${binding.streamKey} (${binding.sessionId})` : binding.sessionId;
    if (binding.timeSource && binding.timeSource !== 'ntp') {
      ctx.log(
        `session clock is "${binding.timeSource}" (not ntp) — frame wall-clock, and any telemetry correlation against it, may be skewed`,
      );
    }
    // The step summary is rewritten after EVERY segment, so a run killed by
    // the engine deadline still reports exactly how far it got (README §9
    // risk 7 — "mark truncation loudly"). Such a run is `failed` with
    // "Run exceeded its max runtime", so a partial pass can never read as
    // complete; this line says where it stopped.
    ctx.setSummary(`session ${label} · 0/${total} segments`);
    let done = 0;
    for (const seg of segments) {
      const { path } = await ctx.sources.fetchVideo({
        bucket: binding.bucket ?? null,
        key: seg.s3Key,
      });
      const payload: VideoPayload = {
        path,
        startedAtMs: seg.startTs, // per-segment anchor: drift never accumulates
        sessionId: binding.sessionId,
        segmentSeq: seg.seq ?? null,
        // Frames past this are the NEXT segment's territory.
        durationMs: seg.effectiveDurationMs ?? seg.durationMs,
        releasable: true, // the decoder may delete `path` once decoded
      };
      yield { ch: 'video' as const, ts: seg.startTs, payload };
      done += 1;
      ctx.setSummary(
        `session ${label} · ${done}/${total} segments · through ${new Date(
          seg.startTs + (seg.effectiveDurationMs ?? seg.durationMs),
        ).toISOString()}`,
      );
    }
    return;
  }

  let path: string;
  let startedAtMs: number | null;
  let label: string;
  if (binding.kind === 'video_local') {
    path = binding.path;
    startedAtMs = parseMs(binding.startedAt);
    label = binding.path;
  } else {
    if (!ctx.sources.fetchVideo) {
      throw new Error('This engine target cannot fetch video inputs (no media support)');
    }
    ({ path } = await ctx.sources.fetchVideo({
      bucket: binding.bucket ?? null,
      key: binding.s3Key,
    }));
    startedAtMs = parseMs(binding.startedAt);
    label = binding.s3Key;
  }

  // Wall-clock anchor for frame timestamps: media start when known, else the
  // run window, else "now" (relative-only media such as uploaded files).
  const anchor = startedAtMs ?? ctx.window?.fromMs ?? Date.now();
  ctx.setSummary(`video ${label} (${binding.kind})`);
  const payload: VideoPayload = {
    path,
    startedAtMs: anchor,
  };
  yield { ch: 'video' as const, ts: anchor, payload };
};
