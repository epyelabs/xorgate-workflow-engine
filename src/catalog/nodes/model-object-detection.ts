import { z } from 'zod';
import { requireInput } from '../../engine/helpers';
import { loadOrt } from '../../engine/ort';
import { letterboxToTensor, postprocessYoloV8 } from '../../engine/vision';
import type {
  DetectionsPayload,
  EngineEmit,
  EngineInChannel,
  EngineRunCtx,
  FramePayload,
} from '../types';
import { defineNode } from '../types';

// Emits json:detections records ({ ts, frameSeq, boxes: [{ cls, confidence,
// xyxy }] }), one message per frame (empty box lists included, so downstream
// consumers stay ts-aligned with the frame stream). The model name resolves
// against the S3 model registry; input size, normalization, class names, and
// NMS parameters come from the registry manifest, not code.

const configSchema = z.object({
  model: z.string().min(1).default('yolov8n').describe('Detection model (from the model registry)'),
  minConfidence: z.number().min(0).max(1).default(0.4).describe('Discard detections below this score'),
  classes: z
    .array(z.string().min(1))
    .optional()
    .describe('Keep only these class names (default: all)'),
});

export const def = defineNode({
  type: 'model.object_detection',
  version: 1,
  group: 'model',
  label: 'Object Detection',
  description: 'Runs a detector over frames and emits bounding boxes.',
  ui: { icon: 'scan-eye' },
  inputs: [{ id: 'frames', label: 'Frames', channel: 'frames', cardinality: 'one', required: true }],
  outputs: [
    {
      id: 'detections',
      label: 'Detections',
      channel: 'json',
      tag: 'detections',
      cardinality: 'many',
      required: false,
    },
  ],
  config: configSchema,
  requires: [],
  runtime: { target: 'media', modelRef: { family: 'detection' } },
});

export const executor = async function* modelObjectDetection(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
): AsyncIterable<EngineEmit> {
  const cfg = configSchema.parse(config);
  if (!ctx.sources.fetchModel) {
    throw new Error('This engine target cannot load registry models (no media support)');
  }
  const { manifest, modelPath } = await ctx.sources.fetchModel({
    family: 'detection',
    name: cfg.model,
  });
  if (manifest.backend !== 'cpu-onnx') {
    throw new Error(`Model backend "${manifest.backend}" is not supported yet (cpu-onnx only)`);
  }
  if (manifest.postprocess.kind !== 'yolov8') {
    throw new Error(`Post-processing "${manifest.postprocess.kind}" is not implemented yet`);
  }

  const ort = loadOrt();
  const session = await ort.InferenceSession.create(modelPath);
  const inputName = session.inputNames[0];
  const classFilter = cfg.classes && cfg.classes.length > 0 ? new Set(cfg.classes) : undefined;

  let frames = 0;
  let totalBoxes = 0;
  let inferMs = 0;
  for await (const msg of requireInput(inputs, 'frames').messages) {
    if (msg.ch !== 'frames') continue;
    const frame = msg.payload as FramePayload;
    const { data, scale, padX, padY } = letterboxToTensor(frame, manifest.input);
    const t0 = Date.now();
    const outputs = await session.run({
      [inputName]: new ort.Tensor('float32', data, [1, 3, manifest.input.height, manifest.input.width]),
    });
    inferMs += Date.now() - t0;
    const output = outputs[Object.keys(outputs)[0]];
    const boxes = postprocessYoloV8(output.data, output.dims, {
      classNames: manifest.classNames,
      minConfidence: cfg.minConfidence,
      iouThreshold: manifest.postprocess.nmsIouThreshold,
      classFilter,
      scale,
      padX,
      padY,
      sourceWidth: frame.width,
      sourceHeight: frame.height,
    });
    frames += 1;
    totalBoxes += boxes.length;
    const payload: DetectionsPayload = {
      ts: msg.ts,
      frameSeq: frame.seq,
      width: frame.width,
      height: frame.height,
      boxes,
    };
    yield { ch: 'json' as const, tag: 'detections', ts: msg.ts, payload };
  }
  const avg = frames > 0 ? Math.round(inferMs / frames) : 0;
  ctx.setSummary(
    `${totalBoxes} detection(s) over ${frames} frame(s) (${manifest.name} v${manifest.version}, ~${avg} ms/frame)`,
  );
};
