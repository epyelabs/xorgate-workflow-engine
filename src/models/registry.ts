import { z } from 'zod';

/**
 * Model registry contracts (architecture.md §6). The registry is an S3 PREFIX
 * on the existing core bucket, not a separate bucket (one bucket to grant, the
 * data is small, and lifecycle needs match; recorded as an M2 session 2
 * decision):
 *
 *   models/<family>/<name>/<version>/model.onnx
 *   models/<family>/<name>/<version>/manifest.json   (this module's schema)
 *
 * `family` matches NodeTypeDef.runtime.modelRef.family ("detection", "depth");
 * `name` is what node config carries ("yolov8n"); `version` is a positive
 * integer directory, highest wins when a consumer asks for "latest".
 *
 * The manifest turns pre/post-processing into DATA (open_questions.md Q1): the
 * TS engine reads input geometry, normalization, class names, and NMS
 * parameters from here instead of hard-coding them per model. The export CI
 * (model-export/) is the only writer.
 */

export const MODEL_REGISTRY_PREFIX = 'models/';

export const MODEL_FAMILIES = ['detection', 'depth', 'segmentation'] as const;

export const modelFileIntegritySchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex characters'),
  sizeBytes: z.number().int().nonnegative(),
});

export const modelManifestSchema = z.object({
  manifestVersion: z.literal(1),
  family: z.enum(MODEL_FAMILIES),
  name: z.string().min(1), // e.g. "yolov8n"; node config references this
  version: z.number().int().positive(),
  label: z.string().min(1).optional(), // human name for pickers
  backend: z.enum(['cpu-onnx', 'gpu-endpoint']),
  input: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    layout: z.literal('nchw').default('nchw'),
    colorSpace: z.literal('rgb').default('rgb'),
    normalize: z
      .object({
        // pixel -> pixel * scale (then (x - mean) / std per channel when set)
        scale: z.number().positive().default(1 / 255),
        mean: z.tuple([z.number(), z.number(), z.number()]).optional(),
        std: z.tuple([z.number(), z.number(), z.number()]).optional(),
      })
      .default({}),
    letterbox: z
      .object({
        enabled: z.boolean().default(true),
        padValue: z.number().int().min(0).max(255).default(114),
      })
      .default({}),
  }),
  classNames: z.array(z.string().min(1)).default([]),
  postprocess: z.object({
    // yolov8: output (1, 4 + numClasses, N) = [cx,cy,w,h, class scores]
    // yolov8-seg: detection head (1, 4 + numClasses + 32, N) + proto (1, 32, mh, mw)
    // depth-anything: single map output (1, H, W) of relative inverse depth
    // (M4 additions are ADDITIVE enum values: every pre-M4 manifest still parses)
    kind: z.enum(['yolov8', 'rtdetr', 'yolov8-seg', 'depth-anything']),
    nmsIouThreshold: z.number().min(0).max(1).default(0.45),
    // yolov8-seg only: sigmoid cutoff when binarizing instance masks.
    maskThreshold: z.number().min(0).max(1).default(0.5),
  }),
  quantization: z.enum(['fp32', 'fp16', 'int8']).optional(),
  // Additive (distribution M3): per-file integrity, keyed by the file's name
  // next to the manifest ("model.onnx"). Verified on pull and by
  // `xwe models check`; a manifest without it still parses and is pulled with
  // a warning instead of a verification. Never required.
  files: z.record(z.string().min(1), modelFileIntegritySchema).optional(),
});
export type ModelManifest = z.infer<typeof modelManifestSchema>;
export type ModelFileIntegrity = z.infer<typeof modelFileIntegritySchema>;

export function modelVersionPrefix(family: string, name: string, version: number): string {
  return `${MODEL_REGISTRY_PREFIX}${family}/${name}/${version}/`;
}
export function modelNamePrefix(family: string, name: string): string {
  return `${MODEL_REGISTRY_PREFIX}${family}/${name}/`;
}
export function modelOnnxKey(family: string, name: string, version: number): string {
  return `${modelVersionPrefix(family, name, version)}model.onnx`;
}
export function modelManifestKey(family: string, name: string, version: number): string {
  return `${modelVersionPrefix(family, name, version)}manifest.json`;
}
