import { z } from 'zod';
import { requireInput } from '../../engine/helpers';
import type { DepthPayload, EngineInChannel, EngineRunCtx } from '../types';
import { defineNode } from '../types';

// The depth -> condition bridge (M4): scenario 3's "vehicle ahead within
// distance" leg is detection + depth (per-box proximity) -> proximity_gate ->
// boolean fusion. Consumes json:depth records from a model.depth node whose
// detections input is wired (records then carry per-box `proximity`, the
// median normalized inverse depth inside each box: 0..1, higher = closer).
// Emits one condition per depth record (recordless/box-less frames emit
// false), so downstream boolean/debounce/event stay ts-aligned with frames.
//
// CPU depth is RELATIVE (per-frame normalized), so minProximity is a relative
// closeness threshold, not meters; metric depth arrives with the GPU backend.

const configSchema = z.object({
  classes: z
    .array(z.string().min(1))
    .default([])
    .describe('Detection classes that count (empty = any class)'),
  minConfidence: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe('Boxes below this detection confidence are ignored'),
  minProximity: z
    .number()
    .min(0)
    .max(1)
    .default(0.6)
    .describe('Condition turns true when a matching object is at least this close (0..1, relative)'),
  minCount: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe('How many matching objects must be that close'),
});

export const def = defineNode({
  type: 'logic.proximity_gate',
  version: 1,
  group: 'logic',
  label: 'Proximity Gate',
  description: 'Turns depth-augmented detections into a condition: true while an object is close enough.',
  ui: { icon: 'ruler' },
  inputs: [
    { id: 'depth', label: 'Depth', channel: 'json', tag: 'depth', cardinality: 'one', required: true },
  ],
  outputs: [
    { id: 'condition', label: 'Condition', channel: 'condition', cardinality: 'many', required: false },
  ],
  config: configSchema,
  requires: [],
  runtime: { target: 'any' },
});

// Event payloads come from condition meta (output.event sets payload = meta).
const MAX_META_BOXES = 20;

export const executor = async function* logicProximityGate(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
) {
  const cfg = configSchema.parse(config);
  const classFilter = new Set(cfg.classes);
  let frames = 0;
  let trueFrames = 0;
  for await (const msg of requireInput(inputs, 'depth').messages) {
    if (msg.ch !== 'json') continue;
    const depth = msg.payload as DepthPayload;
    if (depth.boxes === undefined) {
      // Depth records without boxes mean the upstream depth node has no
      // detections input; the gate would silently never fire. Fail loudly.
      throw new Error(
        'Proximity Gate needs per-box proximity: wire a Detections input into the upstream Depth Estimation node',
      );
    }
    const boxes = Array.isArray(depth.boxes) ? depth.boxes : [];
    const matched = boxes.filter(
      (b) =>
        b.confidence >= cfg.minConfidence &&
        (classFilter.size === 0 || classFilter.has(b.cls)) &&
        b.proximity >= cfg.minProximity,
    );
    const value = matched.length >= cfg.minCount;
    frames += 1;
    if (value) trueFrames += 1;
    const nearest = boxes.reduce<{ cls: string; proximity: number } | null>(
      (acc, b) => (acc === null || b.proximity > acc.proximity ? { cls: b.cls, proximity: b.proximity } : acc),
      null,
    );
    yield {
      ch: 'condition' as const,
      ts: msg.ts,
      payload: {
        value,
        meta: {
          observed: matched.length,
          minCount: cfg.minCount,
          minProximity: cfg.minProximity,
          classes: cfg.classes,
          frameSeq: depth.frameSeq,
          nearest,
          boxes: matched.slice(0, MAX_META_BOXES).map(({ cls, confidence, xyxy, proximity }) => ({
            cls,
            confidence,
            xyxy,
            proximity,
          })),
        },
      },
    };
  }
  ctx.setSummary(`true on ${trueFrames}/${frames} depth frame(s)`);
};
