import { z } from 'zod';
import { mergeByTs, requireInput } from '../../engine/helpers';
import { encodeRgbaToJpeg } from '../../engine/media';
import { loadOrt } from '../../engine/ort';
import {
  depthMapStats,
  downsampleDepthMap,
  invertMetres,
  medianDepthInBox,
  medianMetresInBox,
  metresStats,
  normalizeDepthMap,
  renderDepthColormap,
  letterboxToTensor,
} from '../../engine/vision';
import type {
  DepthBox,
  DepthPayload,
  DetectionsPayload,
  EngineEmit,
  EngineInChannel,
  EngineRunCtx,
  FramePayload,
} from '../types';
import { defineNode } from '../types';

// Emits json:depth records: per-frame depth statistics, a downsampled embedded
// map (JSON-friendly on every serialized plane), and, when a json:detections
// input is wired in, per-box `proximity` (median normalized inverse depth
// inside the box, higher = closer): the distance-from-depth-plus-bbox
// derivation for fusion graphs (scenario 3). Backend-selectable per
// architecture.md §6: CPU ONNX (relative depth) by default, GPU endpoint
// (metric depth) when demanded. Ports do not change between backends.
//
// A metric model (postprocess kind depth-anything-metric, e.g.
// depth-anything-v2-metric-outdoor-small) outputs metres. The map is inverted
// before normalization so proximity, the colormap and the proximity gate keep
// their "higher = closer" meaning, and each box ADDITIVELY gains `distanceM`
// (median metres over the box's central region) plus a frame `metres` range.
//
// When the target has an artifact sink (media engine), each frame's colormap
// render is written to frames/<nodeId>/<seq>.jpg; on simulation runs the
// artifact-sink tee forwards it to the preview/<nodeId> topic, which is the
// engine-rendered depth-map preview path (M4).

const configSchema = z.object({
  backend: z
    .enum(['cpu-onnx', 'gpu-endpoint'])
    .default('cpu-onnx')
    .describe('cpu-onnx: relative depth in-process; gpu-endpoint: metric depth (Depth Pro)'),
  model: z.string().min(1).default('depth-anything-v2-small').describe('Depth model (from the model registry)'),
  renderPreview: z
    .boolean()
    .default(true)
    .describe('Render colormapped depth frames for preview and review'),
  distanceScale: z
    .number()
    .positive()
    .max(10)
    .default(1)
    .describe('Metric models only: multiplies every distance. Calibrate per camera: a known distance divided by the reported one'),
});

export const def = defineNode({
  type: 'model.depth',
  version: 1,
  group: 'model',
  label: 'Depth Estimation',
  description: 'Estimates per-frame depth for distance reasoning and depth-map visualization.',
  ui: { icon: 'layers' },
  inputs: [
    { id: 'frames', label: 'Frames', channel: 'frames', cardinality: 'one', required: true },
    // ADDITIVE (M4): optional detections input for per-box proximity.
    {
      id: 'detections',
      label: 'Detections',
      channel: 'json',
      tag: 'detections',
      cardinality: 'one',
      required: false,
    },
  ],
  outputs: [
    { id: 'depth', label: 'Depth', channel: 'json', tag: 'depth', cardinality: 'many', required: false },
  ],
  config: configSchema,
  requires: [],
  runtime: { target: 'media', gpuPreferred: false, modelRef: { family: 'depth' } },
});

function scaleMetres(m: { min: number; median: number; max: number }, scale: number) {
  const s = (v: number) => Number((v * scale).toFixed(2));
  return { min: s(m.min), median: s(m.median), max: s(m.max) };
}

// Embedded-map budget: 160 wide keeps a jsonl record around 30 KB (base64)
// while a box spanning a tenth of the frame still covers hundreds of cells.
const EMBED_MAP_MAX_WIDTH = 160;

export const executor = async function* modelDepth(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
): AsyncIterable<EngineEmit> {
  const cfg = configSchema.parse(config);
  if (cfg.backend !== 'cpu-onnx') {
    throw new Error(`Depth backend "${cfg.backend}" is not available yet (cpu-onnx only)`);
  }
  if (!ctx.sources.fetchModel) {
    throw new Error('This engine target cannot load registry models (no media support)');
  }
  const { manifest, modelPath } = await ctx.sources.fetchModel({ family: 'depth', name: cfg.model });
  if (manifest.backend !== 'cpu-onnx') {
    throw new Error(`Model backend "${manifest.backend}" is not supported yet (cpu-onnx only)`);
  }
  const kind = manifest.postprocess.kind;
  if (kind !== 'depth-anything' && kind !== 'depth-anything-metric') {
    throw new Error(`Post-processing "${kind}" is not a depth decoder`);
  }
  const metric = kind === 'depth-anything-metric';

  const ort = loadOrt();
  const session = await ort.InferenceSession.create(modelPath);
  const inputName = session.inputNames[0];

  const framesInput = requireInput(inputs, 'frames');
  const detectionsInput = inputs.find((i) => i.port === 'detections');

  // Detections pair with frames by exact ts; mergeByTs with detections first
  // resolves ties detections-before-frame (same trick as output.visualization).
  const boxesByTs = new Map<number, DetectionsPayload['boxes']>();
  const merged = detectionsInput ? mergeByTs([detectionsInput, framesInput]) : mergeByTs([framesInput]);

  let frames = 0;
  let inferMs = 0;
  for await (const { input, msg } of merged) {
    if (input === detectionsInput) {
      if (msg.ch !== 'json') continue;
      const det = msg.payload as DetectionsPayload;
      boxesByTs.set(msg.ts, det.boxes ?? []);
      continue;
    }
    if (msg.ch !== 'frames') continue;
    const frame = msg.payload as FramePayload;
    const { data } = letterboxToTensor(frame, manifest.input);
    const t0 = Date.now();
    const outputs = await session.run({
      [inputName]: new ort.Tensor('float32', data, [1, 3, manifest.input.height, manifest.input.width]),
    });
    inferMs += Date.now() - t0;
    const output = outputs[Object.keys(outputs)[0]];
    // Accept (1, H, W) or (1, 1, H, W) map layouts.
    const dims = output.dims;
    const mh = dims[dims.length - 2];
    const mw = dims[dims.length - 1];
    if (!Number.isInteger(mh) || !Number.isInteger(mw) || mh * mw !== output.data.length) {
      throw new Error(`unexpected depth output shape [${dims.join(', ')}]`);
    }
    const raw = output.data as Float32Array;
    const map = normalizeDepthMap(metric ? invertMetres(raw) : raw, mw, mh);
    const stats = depthMapStats(map);
    const embed = downsampleDepthMap(map, EMBED_MAP_MAX_WIDTH);

    let boxes: DepthBox[] | undefined;
    if (detectionsInput) {
      const detBoxes = boxesByTs.get(msg.ts) ?? [];
      boxesByTs.delete(msg.ts);
      boxes = detBoxes.map((b) => ({
        ...b,
        proximity: medianDepthInBox(map, b.xyxy, frame.width, frame.height),
        ...(metric
          ? { distanceM: Number((medianMetresInBox(raw, mw, mh, b.xyxy, frame.width, frame.height) * cfg.distanceScale).toFixed(2)) }
          : {}),
      }));
    }

    if (cfg.renderPreview && ctx.artifacts) {
      const rendered = renderDepthColormap(map, frame.width, frame.height);
      await ctx.artifacts.putFrame(ctx.nodeId, frame.seq, encodeRgbaToJpeg(rendered, frame.width, frame.height, 80));
    }

    frames += 1;
    const payload: DepthPayload = {
      ts: msg.ts,
      frameSeq: frame.seq,
      width: frame.width,
      height: frame.height,
      stats,
      map: {
        width: embed.width,
        height: embed.height,
        min: embed.min,
        max: embed.max,
        encoding: 'u8',
        data: Buffer.from(embed.values).toString('base64'),
      },
      ...(boxes !== undefined ? { boxes } : {}),
      ...(metric ? { metres: scaleMetres(metresStats(raw), cfg.distanceScale) } : {}),
    };
    yield { ch: 'json' as const, tag: 'depth', ts: msg.ts, payload };
  }
  const avg = frames > 0 ? Math.round(inferMs / frames) : 0;
  ctx.setSummary(
    `depth over ${frames} frame(s) (${manifest.name} v${manifest.version}${metric ? ', metric' : ''}, ~${avg} ms/frame)`,
  );
};
