import { z } from 'zod';
import { requireInput } from '../../engine/helpers';
import { loadOrt } from '../../engine/ort';
import { letterboxToTensor, postprocessYoloV8Seg } from '../../engine/vision';
import type {
  EngineEmit,
  EngineInChannel,
  EngineRunCtx,
  FramePayload,
  SegmentsPayload,
} from '../types';
import { defineNode } from '../types';

// Emits json:segments records, one message per frame (empty instance lists
// included, so downstream consumers stay ts-aligned with the frame stream).
// Instance masks are decoded from the YOLOv8-seg prototype head, binarized at
// proto resolution, cropped to their box, and bit-packed, so a record stays a
// few hundred bytes per instance. Rendering happens downstream in
// output.visualization's `masks` overlay (M4 catalog addition).

const configSchema = z.object({
  model: z.string().min(1).default('yolov8n-seg').describe('Segmentation model (from the model registry)'),
  minConfidence: z.number().min(0).max(1).default(0.4).describe('Discard instances below this score'),
  classes: z
    .array(z.string().min(1))
    .optional()
    .describe('Keep only these class names (default: all)'),
});

export const def = defineNode({
  type: 'model.segmentation',
  version: 1,
  group: 'model',
  label: 'Segmentation',
  description: 'Runs instance segmentation over frames and emits per-object masks.',
  ui: { icon: 'shapes' },
  inputs: [{ id: 'frames', label: 'Frames', channel: 'frames', cardinality: 'one', required: true }],
  outputs: [
    {
      id: 'segments',
      label: 'Segments',
      channel: 'json',
      tag: 'segments',
      cardinality: 'many',
      required: false,
    },
  ],
  config: configSchema,
  requires: [],
  runtime: { target: 'media', modelRef: { family: 'segmentation' } },
});

export const executor = async function* modelSegmentation(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
): AsyncIterable<EngineEmit> {
  const cfg = configSchema.parse(config);
  if (!ctx.sources.fetchModel) {
    throw new Error('This engine target cannot load registry models (no media support)');
  }
  const { manifest, modelPath } = await ctx.sources.fetchModel({
    family: 'segmentation',
    name: cfg.model,
  });
  if (manifest.backend !== 'cpu-onnx') {
    throw new Error(`Model backend "${manifest.backend}" is not supported yet (cpu-onnx only)`);
  }
  if (manifest.postprocess.kind !== 'yolov8-seg') {
    throw new Error(`Post-processing "${manifest.postprocess.kind}" is not a segmentation decoder`);
  }

  const ort = loadOrt();
  const session = await ort.InferenceSession.create(modelPath);
  const inputName = session.inputNames[0];
  const classFilter = cfg.classes && cfg.classes.length > 0 ? new Set(cfg.classes) : undefined;

  let frames = 0;
  let totalInstances = 0;
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
    // YOLOv8-seg exports two outputs: the detection head (1, 4+nc+32, N) and
    // the prototype masks (1, 32, mh, mw); identify them by rank, not name.
    const tensors = Object.values(outputs);
    const head = tensors.find((t) => t.dims.length === 3);
    const proto = tensors.find((t) => t.dims.length === 4);
    if (!head || !proto) {
      throw new Error(
        `expected detection head + proto outputs, got shapes ${tensors.map((t) => `[${t.dims.join(',')}]`).join(' ')}`,
      );
    }
    const instances = postprocessYoloV8Seg(head.data, head.dims, proto.data, proto.dims, {
      classNames: manifest.classNames,
      minConfidence: cfg.minConfidence,
      iouThreshold: manifest.postprocess.nmsIouThreshold,
      maskThreshold: manifest.postprocess.maskThreshold,
      classFilter,
      scale,
      padX,
      padY,
      sourceWidth: frame.width,
      sourceHeight: frame.height,
      inputWidth: manifest.input.width,
      inputHeight: manifest.input.height,
    });
    frames += 1;
    totalInstances += instances.length;
    const payload: SegmentsPayload = {
      ts: msg.ts,
      frameSeq: frame.seq,
      width: frame.width,
      height: frame.height,
      instances: instances.map((inst) => ({
        cls: inst.cls,
        confidence: inst.confidence,
        xyxy: inst.xyxy,
        mask: {
          width: inst.maskWidth,
          height: inst.maskHeight,
          encoding: 'bitpack' as const,
          data: inst.maskBits.toString('base64'),
        },
      })),
    };
    yield { ch: 'json' as const, tag: 'segments', ts: msg.ts, payload };
  }
  const avg = frames > 0 ? Math.round(inferMs / frames) : 0;
  ctx.setSummary(
    `${totalInstances} instance(s) over ${frames} frame(s) (${manifest.name} v${manifest.version}, ~${avg} ms/frame)`,
  );
};
