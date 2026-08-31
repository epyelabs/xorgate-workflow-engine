import { z } from 'zod';
import { mergeByTs, requireInput } from '../../engine/helpers';
import { encodeRgbaToJpeg } from '../../engine/media';
import {
  blendDepthOverlay,
  drawDetections,
  drawSegments,
  type NormalizedDepthMap,
  type OverlayKind,
  type SegInstanceRaw,
} from '../../engine/vision';
import type {
  DepthPayload,
  DetectionBox,
  DetectionsPayload,
  EngineEmit,
  EngineInChannel,
  EngineRunCtx,
  FramePayload,
  SegmentsPayload,
} from '../types';
import { defineNode } from '../types';

// Overlay-annotated video preview (architecture.md §3.3's derived-rule example):
// requires frames plus at least one overlay input, expressed as the port
// signature + an atLeastOneOf constraint. The FE filters the overlay
// multi-select by which tagged inputs are connected. M4 additions (all
// additive): the segments input, the `masks` overlay, and real depth_map
// blending from the embedded map in json:depth records.

const configSchema = z.object({
  overlays: z
    .array(z.enum(['boxes', 'labels', 'confidence', 'depth_map', 'masks']))
    .default(['boxes', 'labels'])
    .describe('Overlay layers to render (options depend on connected inputs)'),
});

export const def = defineNode({
  type: 'output.visualization',
  version: 1,
  group: 'output',
  label: 'Video Visualization',
  description: 'Renders detection / segmentation / depth overlays on the video for preview and review.',
  ui: { icon: 'monitor-play' },
  inputs: [
    { id: 'frames', label: 'Frames', channel: 'frames', cardinality: 'one', required: true },
    {
      id: 'detections',
      label: 'Detections',
      channel: 'json',
      tag: 'detections',
      cardinality: 'one',
      required: false,
    },
    { id: 'depth', label: 'Depth', channel: 'json', tag: 'depth', cardinality: 'one', required: false },
    {
      id: 'segments',
      label: 'Segments',
      channel: 'json',
      tag: 'segments',
      cardinality: 'one',
      required: false,
    },
  ],
  outputs: [],
  config: configSchema,
  requires: [],
  runtime: { target: 'media' },
  constraints: [{ kind: 'atLeastOneOf', ports: ['detections', 'depth', 'segments'] }],
});

function decodeEmbeddedMap(depth: DepthPayload): NormalizedDepthMap {
  return {
    width: depth.map.width,
    height: depth.map.height,
    values: new Uint8Array(Buffer.from(depth.map.data, 'base64')),
    min: depth.map.min,
    max: depth.map.max,
  };
}

function toSegInstances(payload: SegmentsPayload): SegInstanceRaw[] {
  return payload.instances.map((inst) => ({
    cls: inst.cls,
    confidence: inst.confidence,
    xyxy: inst.xyxy,
    maskWidth: inst.mask.width,
    maskHeight: inst.mask.height,
    maskBits: Buffer.from(inst.mask.data, 'base64'),
  }));
}

// Overlay records pair with frames by EXACT ts: every producer stamps its
// output with the frame ts, and mergeByTs resolves ties in input order, so
// json inputs are listed before the frames input and a frame's records always
// arrive first. Draw order: depth blend (bottom), masks, boxes/labels (top).
export const executor = async function* outputVisualization(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
): AsyncIterable<EngineEmit> {
  const cfg = configSchema.parse(config);
  if (!ctx.artifacts) {
    throw new Error('This engine target has no artifact sink for visualization frames');
  }
  const framesInput = requireInput(inputs, 'frames');
  const detectionsInput = inputs.find((i) => i.port === 'detections');
  const depthInput = inputs.find((i) => i.port === 'depth');
  const segmentsInput = inputs.find((i) => i.port === 'segments');

  const overlays = new Set<OverlayKind>(cfg.overlays);
  if (overlays.has('depth_map') && !depthInput) {
    ctx.log('depth_map overlay needs a connected Depth input; skipping that layer');
    overlays.delete('depth_map');
  }
  if (overlays.has('masks') && !segmentsInput) {
    ctx.log('masks overlay needs a connected Segments input; skipping that layer');
    overlays.delete('masks');
  }
  const boxOverlays = new Set<OverlayKind>(
    [...overlays].filter((o) => o === 'boxes' || o === 'labels' || o === 'confidence'),
  );

  const boxesByTs = new Map<number, DetectionBox[]>();
  const depthByTs = new Map<number, DepthPayload>();
  const segmentsByTs = new Map<number, SegmentsPayload>();

  const jsonInputs = [detectionsInput, depthInput, segmentsInput].filter(
    (i): i is EngineInChannel => i !== undefined,
  );
  const merged = mergeByTs([...jsonInputs, framesInput]);
  let rendered = 0;
  for await (const { input, msg } of merged) {
    if (input !== framesInput) {
      if (msg.ch !== 'json') continue;
      if (input === detectionsInput) boxesByTs.set(msg.ts, (msg.payload as DetectionsPayload).boxes ?? []);
      else if (input === depthInput) depthByTs.set(msg.ts, msg.payload as DepthPayload);
      else segmentsByTs.set(msg.ts, msg.payload as SegmentsPayload);
      continue;
    }
    if (msg.ch !== 'frames') continue;
    const frame = msg.payload as FramePayload;
    const canvas = Buffer.from(frame.image); // shared buffer: copy before drawing

    const depth = depthByTs.get(msg.ts);
    depthByTs.delete(msg.ts);
    if (depth && overlays.has('depth_map')) {
      blendDepthOverlay(canvas, frame.width, frame.height, decodeEmbeddedMap(depth));
    }
    const segments = segmentsByTs.get(msg.ts);
    segmentsByTs.delete(msg.ts);
    if (segments && overlays.has('masks')) {
      drawSegments(canvas, frame.width, frame.height, toSegInstances(segments), overlays.has('labels'));
    }
    const boxes = boxesByTs.get(msg.ts) ?? [];
    boxesByTs.delete(msg.ts);
    if (detectionsInput && boxOverlays.size > 0) {
      drawDetections(canvas, frame.width, frame.height, boxes, boxOverlays);
    }

    const jpegBuf = encodeRgbaToJpeg(canvas, frame.width, frame.height, 80);
    await ctx.artifacts.putFrame(ctx.nodeId, frame.seq, jpegBuf);
    rendered += 1;
  }
  ctx.setSummary(`${rendered} annotated frame(s)`);
};
