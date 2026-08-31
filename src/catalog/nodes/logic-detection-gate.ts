import { z } from 'zod';
import { requireInput } from '../../engine/helpers';
import type { DetectionsPayload, EngineInChannel, EngineRunCtx } from '../types';
import { defineNode } from '../types';

// The detections -> condition bridge (M3; closes M2 gap 9): scenario 1's
// events leg is video -> decode -> detection -> detection_gate -> emit event.
// Emits one condition message per detections message (empty-box messages
// included), so downstream debounce/event nodes stay ts-aligned with the
// frame stream and rising-edge detection in output.event works unchanged.
//
// Adding this node CHANGED catalogVersion (the one sanctioned M3 catalog
// change); the FE renders from the served catalog, so no FE code change is
// required beyond redeploy-together.

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
    .describe('Detections below this confidence are ignored'),
  minCount: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe('Condition turns true when at least this many detections match'),
});

export const def = defineNode({
  type: 'logic.detection_gate',
  version: 1,
  group: 'logic',
  label: 'Detection Gate',
  description: 'Turns a detection stream into a condition: true while enough matching objects are detected.',
  ui: { icon: 'filter' },
  inputs: [
    {
      id: 'detections',
      label: 'Detections',
      channel: 'json',
      tag: 'detections',
      cardinality: 'one',
      required: true,
    },
  ],
  outputs: [
    { id: 'condition', label: 'Condition', channel: 'condition', cardinality: 'many', required: false },
  ],
  config: configSchema,
  requires: [],
  runtime: { target: 'any' },
});

// Event payloads come from condition meta (output.event sets payload = meta),
// so meta carries the matching boxes (capped) for review/overlay use.
const MAX_META_BOXES = 20;

export const executor = async function* logicDetectionGate(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
) {
  const cfg = configSchema.parse(config);
  const classFilter = new Set(cfg.classes);
  let frames = 0;
  let trueFrames = 0;
  for await (const msg of requireInput(inputs, 'detections').messages) {
    if (msg.ch !== 'json') continue;
    const det = msg.payload as DetectionsPayload;
    const boxes = Array.isArray(det.boxes) ? det.boxes : [];
    const matched = boxes.filter(
      (b) =>
        b.confidence >= cfg.minConfidence && (classFilter.size === 0 || classFilter.has(b.cls)),
    );
    const value = matched.length >= cfg.minCount;
    frames += 1;
    if (value) trueFrames += 1;
    yield {
      ch: 'condition' as const,
      ts: msg.ts,
      payload: {
        value,
        meta: {
          observed: matched.length,
          minCount: cfg.minCount,
          minConfidence: cfg.minConfidence,
          classes: cfg.classes,
          frameSeq: det.frameSeq,
          boxes: matched.slice(0, MAX_META_BOXES),
        },
      },
    };
  }
  ctx.setSummary(`true on ${trueFrames}/${frames} detection frame(s)`);
};
