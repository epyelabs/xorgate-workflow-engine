import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { installedVersion } from '../engine/lazy-require';
import { loadOrt, type OrtSession, type OrtTensor } from '../engine/ort';
import { letterboxToTensor } from '../engine/vision';
import { modelManifestSchema, type ModelManifest } from '../models/registry';
import { formatBytes } from './models';
import { sha256OfFile } from './registry-client';

/**
 * `xwe models check <dir>` and `checkModelDir(dir)` (models.mdx "Check the
 * directory"): the same validation a publish step runs before a model goes
 * into a registry. Four stages, each one line:
 *
 *   manifest   ok   detection/acme-forklift v1, yolov8, 2 classes, 640x640 nchw rgb
 *   model      ok   model.onnx 11.6 MB, sha256 verified
 *   session    ok   onnxruntime-node 1.19.2, input "images" [1,3,640,640]
 *   output     ok   "output0" [1,6,8400] matches yolov8 with 2 classes (4 + 2)
 *
 * The output stage runs one blank letterboxed frame through the session and
 * asserts the tensor layout the manifest's `postprocess.kind` implies, so a
 * class-count mismatch surfaces here with both numbers instead of as a
 * garbled detection list mid-run. When the manifest lacks `files`, the
 * checksum and size are filled in (unless `fill: false`), which makes a
 * hand-written manifest registry-ready.
 */

export type ModelCheckStage = 'manifest' | 'model' | 'session' | 'output';

export interface ModelCheckLine {
  stage: ModelCheckStage;
  ok: boolean;
  text: string;
}

export interface ModelCheckReport {
  ok: boolean;
  /** One entry per failed stage, in order; empty when ok. */
  problems: string[];
  /** All four stages (later stages are skipped after a failure and report why). */
  lines: ModelCheckLine[];
  manifest?: ModelManifest;
  /** True when `files` was written into manifest.json by this check. */
  manifestUpdated: boolean;
}

export interface CheckModelDirOptions {
  /** Write `files.sha256`/`sizeBytes` into manifest.json when absent. Default true. */
  fill?: boolean;
}

/** Fixed-width rendering: `<stage padded to 11><ok|fail padded to 5><text>`. */
export function formatModelCheckLine(line: ModelCheckLine): string {
  return `${line.stage.padEnd(11)}${(line.ok ? 'ok' : 'fail').padEnd(5)}${line.text}`;
}

const YOLO_SEG_MASK_COEFFS = 32;

function dimsText(dims: ReadonlyArray<number | string>): string {
  return `[${dims.join(',')}]`;
}

function blankFrame(width: number, height: number): { image: Buffer; width: number; height: number } {
  // Mid-grey RGBA, 4:3, so a square model input is letterboxed on two sides.
  const image = Buffer.alloc(width * height * 4, 114);
  for (let i = 3; i < image.length; i += 4) image[i] = 255;
  return { image, width, height };
}

function checkOutputShape(
  manifest: ModelManifest,
  outputs: Array<{ name: string; tensor: OrtTensor }>,
): { ok: boolean; text: string } {
  const kind = manifest.postprocess.kind;
  const classes = manifest.classNames.length;
  const shapes = outputs.map((o) => `"${o.name}" ${dimsText(o.tensor.dims)}`).join(', ');
  if (kind === 'yolov8') {
    const head = outputs.find((o) => o.tensor.dims.length === 3);
    if (!head) return { ok: false, text: `expected one rank-3 detection head for yolov8, got ${shapes}` };
    const rows = head.tensor.dims[1];
    const expected = 4 + classes;
    if (head.tensor.dims[0] !== 1 || rows !== expected) {
      const impliedClasses = rows - 4;
      return {
        ok: false,
        text:
          `"${head.name}" ${dimsText(head.tensor.dims)} does not match yolov8 with ${classes} classes: ` +
          `expected 4 + ${classes} = ${expected} rows, got ${rows}` +
          (impliedClasses > 0 ? ` (a model with ${impliedClasses} classes?)` : ''),
      };
    }
    return {
      ok: true,
      text: `"${head.name}" ${dimsText(head.tensor.dims)} matches yolov8 with ${classes} classes (4 + ${classes})`,
    };
  }
  if (kind === 'yolov8-seg') {
    const head = outputs.find((o) => o.tensor.dims.length === 3);
    const proto = outputs.find((o) => o.tensor.dims.length === 4);
    if (!head || !proto) {
      return { ok: false, text: `expected a rank-3 detection head and a rank-4 prototype tensor for yolov8-seg, got ${shapes}` };
    }
    const rows = head.tensor.dims[1];
    const expected = 4 + classes + YOLO_SEG_MASK_COEFFS;
    if (rows !== expected || proto.tensor.dims[1] !== YOLO_SEG_MASK_COEFFS) {
      return {
        ok: false,
        text:
          `"${head.name}" ${dimsText(head.tensor.dims)} + "${proto.name}" ${dimsText(proto.tensor.dims)} do not match yolov8-seg with ${classes} classes: ` +
          `expected 4 + ${classes} + ${YOLO_SEG_MASK_COEFFS} = ${expected} rows and ${YOLO_SEG_MASK_COEFFS} prototypes, got ${rows} rows and ${proto.tensor.dims[1]} prototypes`,
      };
    }
    return {
      ok: true,
      text: `"${head.name}" ${dimsText(head.tensor.dims)} + "${proto.name}" ${dimsText(proto.tensor.dims)} match yolov8-seg with ${classes} classes (4 + ${classes} + ${YOLO_SEG_MASK_COEFFS})`,
    };
  }
  if (kind === 'depth-anything' || kind === 'depth-anything-metric') {
    const map = outputs[0];
    const dims = map.tensor.dims;
    const leading = dims.slice(0, -2);
    const mh = dims[dims.length - 2];
    const mw = dims[dims.length - 1];
    if (dims.length < 3 || leading.some((d) => d !== 1) || !(mh > 0 && mw > 0)) {
      return { ok: false, text: `"${map.name}" ${dimsText(dims)} does not match ${kind}: expected one map [1,H,W]` };
    }
    return { ok: true, text: `"${map.name}" ${dimsText(dims)} matches ${kind} (one ${mw}x${mh} map)` };
  }
  return { ok: false, text: `postprocess.kind "${kind}" has no decoder in this engine (${shapes})` };
}

export async function checkModelDir(dir: string, opts: CheckModelDirOptions = {}): Promise<ModelCheckReport> {
  const fill = opts.fill ?? true;
  const lines: ModelCheckLine[] = [];
  const problems: string[] = [];
  let manifestUpdated = false;
  const push = (stage: ModelCheckStage, ok: boolean, text: string): void => {
    lines.push({ stage, ok, text });
    if (!ok) problems.push(`${stage}: ${text}`);
  };
  const skipRest = (from: ModelCheckStage, reason: string): ModelCheckReport => {
    const order: ModelCheckStage[] = ['manifest', 'model', 'session', 'output'];
    for (const stage of order.slice(order.indexOf(from))) {
      lines.push({ stage, ok: false, text: reason });
    }
    return { ok: false, problems, lines, manifestUpdated };
  };

  // manifest
  const manifestPath = path.join(dir, 'manifest.json');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    push('manifest', false, `${dir} is not a directory`);
    return skipRest('model', 'skipped');
  }
  if (!existsSync(manifestPath)) {
    push('manifest', false, `manifest.json not found in ${dir}`);
    return skipRest('model', 'skipped');
  }
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    push('manifest', false, `manifest.json is not JSON: ${err instanceof Error ? err.message : String(err)}`);
    return skipRest('model', 'skipped');
  }
  const parsed = modelManifestSchema.safeParse(rawManifest);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    push('manifest', false, `manifest.json: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    return skipRest('model', 'skipped');
  }
  const manifest = parsed.data;
  const classesText =
    manifest.classNames.length === 0 ? 'no class names' : `${manifest.classNames.length} classes`;
  push(
    'manifest',
    true,
    `${manifest.family}/${manifest.name} v${manifest.version}, ${manifest.postprocess.kind}, ${classesText}, ${manifest.input.width}x${manifest.input.height} ${manifest.input.layout} ${manifest.input.colorSpace}`,
  );

  // model
  const modelPath = path.join(dir, 'model.onnx');
  if (!existsSync(modelPath)) {
    push('model', false, `model.onnx not found in ${dir}`);
    return { ...skipRest('session', 'skipped'), manifest };
  }
  const sizeBytes = statSync(modelPath).size;
  const sha256 = sha256OfFile(modelPath);
  const declared = manifest.files?.['model.onnx'];
  if (declared) {
    if (declared.sha256 !== sha256) {
      push(
        'model',
        false,
        `model.onnx ${formatBytes(sizeBytes)}, sha256 mismatch (manifest ${declared.sha256.slice(0, 12)}…, file ${sha256.slice(0, 12)}…)`,
      );
      return { ...skipRest('session', 'skipped'), manifest };
    }
    if (declared.sizeBytes !== sizeBytes) {
      push('model', false, `model.onnx is ${sizeBytes} bytes, the manifest declares ${declared.sizeBytes}`);
      return { ...skipRest('session', 'skipped'), manifest };
    }
    push('model', true, `model.onnx ${formatBytes(sizeBytes)}, sha256 verified`);
  } else if (fill) {
    const updated = { ...(rawManifest as Record<string, unknown>), files: { ...(manifest.files ?? {}), 'model.onnx': { sha256, sizeBytes } } };
    writeFileSync(manifestPath, JSON.stringify(updated, null, 2) + '\n');
    manifest.files = { ...(manifest.files ?? {}), 'model.onnx': { sha256, sizeBytes } };
    manifestUpdated = true;
    push('model', true, `model.onnx ${formatBytes(sizeBytes)}, sha256 recorded in manifest.json`);
  } else {
    push('model', true, `model.onnx ${formatBytes(sizeBytes)}, no sha256 in manifest (not verified)`);
  }

  // session
  let session: OrtSession;
  let ortVersion: string;
  try {
    const ort = loadOrt();
    ortVersion = installedVersion('onnxruntime-node') ?? 'unknown version';
    session = await ort.InferenceSession.create(modelPath);
  } catch (err) {
    push('session', false, err instanceof Error ? err.message : String(err));
    return { ...skipRest('output', 'skipped'), manifest, manifestUpdated };
  }
  const inputName = session.inputNames[0];
  const inputShape =
    session.inputMetadata?.find((m) => m.name === inputName)?.shape ??
    [1, 3, manifest.input.height, manifest.input.width];
  push('session', true, `onnxruntime-node ${ortVersion}, input "${inputName}" ${dimsText(inputShape)}`);

  // output: one blank letterboxed frame
  try {
    const ort = loadOrt();
    const frame = blankFrame(640, 480);
    const { data } = letterboxToTensor(frame, manifest.input);
    const feeds = {
      [inputName]: new ort.Tensor('float32', data, [1, 3, manifest.input.height, manifest.input.width]),
    };
    const result = await session.run(feeds);
    const outputs = session.outputNames
      .filter((name) => result[name] !== undefined)
      .map((name) => ({ name, tensor: result[name] }));
    if (outputs.length === 0) {
      push('output', false, 'the session produced no outputs');
    } else {
      const verdict = checkOutputShape(manifest, outputs);
      push('output', verdict.ok, verdict.text);
    }
  } catch (err) {
    push('output', false, `inference failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await session.release?.();
  }

  return { ok: problems.length === 0, problems, lines, manifest, manifestUpdated };
}
