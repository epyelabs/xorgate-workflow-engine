import type { DetectionBox, FramePayload } from '../catalog/types';
import type { ModelManifest } from '../models/registry';

/**
 * Pure pre/post-processing for the in-process ONNX model backend
 * (open_questions.md Q1): letterboxing, tensor packing, the YOLOv8 head
 * decode, and greedy NMS, all parameterized by the registry manifest instead
 * of per-model code. Pure functions so the smoke script unit-tests them
 * against synthetic tensors (the export CI's parity fixtures assert against
 * the same entry points later).
 *
 * Also hosts the minimal RGBA drawing used by output.visualization (box
 * outlines + a 5x7 bitmap-font label). Pure JS on raw buffers; no canvas or
 * native image dependency.
 */

// --- Letterbox / tensor packing -------------------------------------------------

export interface LetterboxTensor {
  /** CHW float tensor, normalized per the manifest. */
  data: Float32Array;
  scale: number;
  padX: number;
  padY: number;
}

/**
 * Resizes (bilinear) the RGBA frame onto a padded canvas of the model's input
 * size and packs it as normalized CHW floats. Matches the cv-runner's
 * letterbox semantics (aspect-preserving scale, centered pad).
 */
export function letterboxToTensor(
  frame: Pick<FramePayload, 'image' | 'width' | 'height'>,
  input: ModelManifest['input'],
): LetterboxTensor {
  const { width: W, height: H } = input;
  const { image, width: w, height: h } = frame;
  const letterbox = input.letterbox.enabled;
  const scale = letterbox ? Math.min(W / w, H / h) : NaN;
  const nw = letterbox ? Math.round(w * scale) : W;
  const nh = letterbox ? Math.round(h * scale) : H;
  const padX = Math.floor((W - nw) / 2);
  const padY = Math.floor((H - nh) / 2);

  const { scale: norm, mean, std } = input.normalize;
  const pad = input.letterbox.padValue * norm;
  const data = new Float32Array(3 * W * H);
  const plane = W * H;
  if (padX > 0 || padY > 0) {
    for (let c = 0; c < 3; c++) {
      const padded = mean && std ? (pad - mean[c]) / std[c] : pad;
      data.fill(padded, c * plane, (c + 1) * plane);
    }
  }

  const sxScale = letterbox ? 1 / scale : w / W;
  const syScale = letterbox ? 1 / scale : h / H;
  for (let ty = padY; ty < padY + nh; ty++) {
    // Half-pixel-centered bilinear sampling (cv2 INTER_LINEAR convention).
    const sy = Math.min(Math.max((ty - padY + 0.5) * syScale - 0.5, 0), h - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(y0 + 1, h - 1);
    const fy = sy - y0;
    for (let tx = padX; tx < padX + nw; tx++) {
      const sx = Math.min(Math.max((tx - padX + 0.5) * sxScale - 0.5, 0), w - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(x0 + 1, w - 1);
      const fx = sx - x0;
      const i00 = (y0 * w + x0) * 4;
      const i01 = (y0 * w + x1) * 4;
      const i10 = (y1 * w + x0) * 4;
      const i11 = (y1 * w + x1) * 4;
      const out = ty * W + tx;
      for (let c = 0; c < 3; c++) {
        const top = image[i00 + c] * (1 - fx) + image[i01 + c] * fx;
        const bottom = image[i10 + c] * (1 - fx) + image[i11 + c] * fx;
        let v = (top * (1 - fy) + bottom * fy) * norm;
        if (mean && std) v = (v - mean[c]) / std[c];
        data[c * plane + out] = v;
      }
    }
  }
  return { data, scale: letterbox ? scale : 1, padX, padY };
}

// --- YOLOv8 head decode + NMS ----------------------------------------------------

export interface YoloPostprocessOpts {
  classNames: string[];
  minConfidence: number;
  iouThreshold: number;
  /** Keep only these class names (undefined = all). */
  classFilter?: Set<string>;
  /** Letterbox mapping back to source pixels. */
  scale: number;
  padX: number;
  padY: number;
  sourceWidth: number;
  sourceHeight: number;
}

interface Candidate {
  cls: number;
  confidence: number;
  xyxy: [number, number, number, number];
}

function iouXyxy(a: [number, number, number, number], b: [number, number, number, number]): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

/** Greedy per-class NMS; returns survivors ordered by confidence. */
export function nmsPerClass(candidates: Candidate[], iouThreshold: number): Candidate[] {
  const kept: Candidate[] = [];
  const byClass = new Map<number, Candidate[]>();
  for (const c of candidates) {
    (byClass.get(c.cls) ?? byClass.set(c.cls, []).get(c.cls)!).push(c);
  }
  for (const group of byClass.values()) {
    group.sort((a, b) => b.confidence - a.confidence);
    const suppressed = new Array<boolean>(group.length).fill(false);
    for (let i = 0; i < group.length; i++) {
      if (suppressed[i]) continue;
      kept.push(group[i]);
      for (let j = i + 1; j < group.length; j++) {
        if (!suppressed[j] && iouXyxy(group[i].xyxy, group[j].xyxy) > iouThreshold) {
          suppressed[j] = true;
        }
      }
    }
  }
  return kept.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Decodes a YOLOv8 detection head: `output` with dims (1, 4 + numClasses, N)
 * where rows are [cx, cy, w, h, class scores...] in letterboxed input pixels.
 * Returns boxes mapped back to source pixels, confidence-filtered,
 * class-filtered, and NMS'd.
 */
export function postprocessYoloV8(
  output: Float32Array,
  dims: readonly number[],
  opts: YoloPostprocessOpts,
): DetectionBox[] {
  if (dims.length !== 3 || dims[0] !== 1) {
    throw new Error(`unexpected detection output shape [${dims.join(', ')}]`);
  }
  const channels = dims[1];
  const anchors = dims[2];
  const numClasses = channels - 4;
  if (numClasses < 1) throw new Error(`detection output has no class channels ([${dims.join(', ')}])`);
  const at = (c: number, j: number): number => output[c * anchors + j];

  const candidates: Candidate[] = [];
  for (let j = 0; j < anchors; j++) {
    let best = 0;
    let bestScore = -Infinity;
    for (let c = 0; c < numClasses; c++) {
      const s = at(4 + c, j);
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    if (bestScore < opts.minConfidence) continue;
    const name = opts.classNames[best] ?? `class_${best}`;
    if (opts.classFilter && !opts.classFilter.has(name)) continue;
    const cx = at(0, j);
    const cy = at(1, j);
    const bw = at(2, j);
    const bh = at(3, j);
    // Letterboxed input pixels -> source pixels, clamped to the frame.
    const x1 = Math.min(Math.max((cx - bw / 2 - opts.padX) / opts.scale, 0), opts.sourceWidth - 1);
    const y1 = Math.min(Math.max((cy - bh / 2 - opts.padY) / opts.scale, 0), opts.sourceHeight - 1);
    const x2 = Math.min(Math.max((cx + bw / 2 - opts.padX) / opts.scale, x1 + 1), opts.sourceWidth);
    const y2 = Math.min(Math.max((cy + bh / 2 - opts.padY) / opts.scale, y1 + 1), opts.sourceHeight);
    candidates.push({ cls: best, confidence: bestScore, xyxy: [x1, y1, x2, y2] });
  }

  return nmsPerClass(candidates, opts.iouThreshold).map((c) => ({
    cls: opts.classNames[c.cls] ?? `class_${c.cls}`,
    confidence: Number(c.confidence.toFixed(4)),
    xyxy: c.xyxy.map((v) => Number(v.toFixed(1))) as [number, number, number, number],
  }));
}

// --- RGBA drawing (output.visualization) -----------------------------------------

const PALETTE: Array<[number, number, number]> = [
  [230, 57, 70],
  [46, 204, 113],
  [52, 152, 219],
  [241, 196, 15],
  [155, 89, 182],
  [26, 188, 156],
  [231, 126, 34],
  [236, 240, 241],
];

export function classColor(cls: string): [number, number, number] {
  let hash = 0;
  for (let i = 0; i < cls.length; i++) hash = (hash * 31 + cls.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

function setPx(img: Buffer, w: number, h: number, x: number, y: number, rgb: [number, number, number]): void {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 4;
  img[i] = rgb[0];
  img[i + 1] = rgb[1];
  img[i + 2] = rgb[2];
  img[i + 3] = 255;
}

export function fillRect(
  img: Buffer,
  w: number,
  h: number,
  x: number,
  y: number,
  rw: number,
  rh: number,
  rgb: [number, number, number],
): void {
  for (let yy = y; yy < y + rh; yy++) {
    for (let xx = x; xx < x + rw; xx++) setPx(img, w, h, xx, yy, rgb);
  }
}

export function drawRectOutline(
  img: Buffer,
  w: number,
  h: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rgb: [number, number, number],
  thickness = 2,
): void {
  fillRect(img, w, h, x1, y1, x2 - x1, thickness, rgb);
  fillRect(img, w, h, x1, y2 - thickness, x2 - x1, thickness, rgb);
  fillRect(img, w, h, x1, y1, thickness, y2 - y1, rgb);
  fillRect(img, w, h, x2 - thickness, y1, thickness, y2 - y1, rgb);
}

// 5x7 bitmap font (rows of 5-bit masks, MSB = leftmost pixel). Enough for
// class labels + confidence: A-Z, 0-9, space, dot, percent, dash.
const FONT: Record<string, number[]> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 0x0c, 0x0c],
  '%': [0x19, 0x1a, 0x02, 0x04, 0x08, 0x0b, 0x13],
  '-': [0, 0, 0, 0x0e, 0, 0, 0],
};

export function drawText(
  img: Buffer,
  w: number,
  h: number,
  x: number,
  y: number,
  text: string,
  rgb: [number, number, number],
  pixelScale = 1,
): void {
  let cx = x;
  for (const raw of text.toUpperCase()) {
    const glyph = FONT[raw] ?? FONT['-'];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if ((glyph[row] >> (4 - col)) & 1) {
          fillRect(img, w, h, cx + col * pixelScale, y + row * pixelScale, pixelScale, pixelScale, rgb);
        }
      }
    }
    cx += 6 * pixelScale;
  }
}

export type OverlayKind = 'boxes' | 'labels' | 'confidence' | 'depth_map' | 'masks';

// --- Depth (M4) -------------------------------------------------------------------
// The depth model emits one relative inverse-depth map per frame. Raw floats
// stay inside the executor; everything downstream works on a per-frame
// normalized uint8 map (255 = nearest). Helpers here are pure so the smoke
// script asserts them against synthetic maps, and the export CI's parity
// fixtures can target the same entry points.

export interface NormalizedDepthMap {
  width: number;
  height: number;
  /** width*height uint8, per-frame normalized inverse depth (255 = nearest). */
  values: Uint8Array;
  /** Raw model-output range before normalization. */
  min: number;
  max: number;
}

/** Per-frame min/max normalization of a raw depth model output. */
export function normalizeDepthMap(raw: Float32Array, width: number, height: number): NormalizedDepthMap {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  const values = new Uint8Array(width * height);
  if (range > 0) {
    for (let i = 0; i < raw.length; i++) values[i] = Math.round(((raw[i] - min) / range) * 255);
  }
  return { width, height, values, min, max };
}

/**
 * Frame depth stats: `min`/`max` are the RAW model-output range (the scene's
 * relative scale); `mean`/`median` are in normalized 0..1 inverse-depth space.
 */
export function depthMapStats(map: NormalizedDepthMap): { min: number; max: number; mean: number; median: number } {
  let sum = 0;
  const hist = new Uint32Array(256);
  for (let i = 0; i < map.values.length; i++) {
    sum += map.values[i];
    hist[map.values[i]] += 1;
  }
  const half = map.values.length / 2;
  let acc = 0;
  let median = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= half) {
      median = v;
      break;
    }
  }
  return {
    min: Number(map.min.toFixed(4)),
    max: Number(map.max.toFixed(4)),
    mean: map.values.length > 0 ? Number((sum / map.values.length / 255).toFixed(4)) : 0,
    median: Number((median / 255).toFixed(4)),
  };
}

/** Nearest-neighbor downsample of a normalized map to at most `maxWidth` wide. */
export function downsampleDepthMap(map: NormalizedDepthMap, maxWidth: number): NormalizedDepthMap {
  if (map.width <= maxWidth) return map;
  const outW = maxWidth;
  const outH = Math.max(1, Math.round((map.height * maxWidth) / map.width));
  const values = new Uint8Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(map.height - 1, Math.floor((y * map.height) / outH));
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(map.width - 1, Math.floor((x * map.width) / outW));
      values[y * outW + x] = map.values[sy * map.width + sx];
    }
  }
  return { width: outW, height: outH, values, min: map.min, max: map.max };
}

/**
 * Median normalized inverse depth inside a source-pixel box (0..1, higher =
 * closer). The map spans the whole frame (stretched), so box coordinates map
 * proportionally onto the grid.
 */
export function medianDepthInBox(
  map: NormalizedDepthMap,
  xyxy: [number, number, number, number],
  sourceWidth: number,
  sourceHeight: number,
): number {
  const x1 = Math.max(0, Math.floor((xyxy[0] / sourceWidth) * map.width));
  const y1 = Math.max(0, Math.floor((xyxy[1] / sourceHeight) * map.height));
  const x2 = Math.min(map.width, Math.ceil((xyxy[2] / sourceWidth) * map.width));
  const y2 = Math.min(map.height, Math.ceil((xyxy[3] / sourceHeight) * map.height));
  const hist = new Uint32Array(256);
  let count = 0;
  for (let y = y1; y < Math.max(y2, y1 + 1); y++) {
    for (let x = x1; x < Math.max(x2, x1 + 1); x++) {
      if (x >= map.width || y >= map.height) continue;
      hist[map.values[y * map.width + x]] += 1;
      count += 1;
    }
  }
  if (count === 0) return 0;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= count / 2) return Number((v / 255).toFixed(4));
  }
  return 1;
}

// Turbo-like colormap anchors (dark blue -> cyan -> green -> yellow -> red),
// linearly interpolated. Near (high values) renders hot, far renders cool.
const DEPTH_COLORMAP: Array<[number, number, number]> = [
  [48, 18, 59],
  [70, 107, 227],
  [40, 187, 236],
  [31, 233, 161],
  [166, 253, 76],
  [249, 189, 38],
  [244, 84, 12],
  [122, 4, 3],
];

export function depthColor(value255: number): [number, number, number] {
  const pos = (value255 / 255) * (DEPTH_COLORMAP.length - 1);
  const lo = Math.min(DEPTH_COLORMAP.length - 2, Math.floor(pos));
  const f = pos - lo;
  const a = DEPTH_COLORMAP[lo];
  const b = DEPTH_COLORMAP[lo + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/** Renders a normalized map as an RGBA colormap image of the given size. */
export function renderDepthColormap(map: NormalizedDepthMap, outWidth: number, outHeight: number): Buffer {
  const out = Buffer.alloc(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y++) {
    const sy = Math.min(map.height - 1, Math.floor((y * map.height) / outHeight));
    for (let x = 0; x < outWidth; x++) {
      const sx = Math.min(map.width - 1, Math.floor((x * map.width) / outWidth));
      const [r, g, b] = depthColor(map.values[sy * map.width + sx]);
      const i = (y * outWidth + x) * 4;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Blends the depth colormap over an RGBA frame in place (depth_map overlay). */
export function blendDepthOverlay(
  img: Buffer,
  width: number,
  height: number,
  map: NormalizedDepthMap,
  alpha = 0.45,
): void {
  for (let y = 0; y < height; y++) {
    const sy = Math.min(map.height - 1, Math.floor((y * map.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(map.width - 1, Math.floor((x * map.width) / width));
      const [r, g, b] = depthColor(map.values[sy * map.width + sx]);
      const i = (y * width + x) * 4;
      img[i] = Math.round(img[i] * (1 - alpha) + r * alpha);
      img[i + 1] = Math.round(img[i + 1] * (1 - alpha) + g * alpha);
      img[i + 2] = Math.round(img[i + 2] * (1 - alpha) + b * alpha);
    }
  }
}

// --- YOLOv8-seg decode (M4) ---------------------------------------------------------

/** One decoded instance; the mask grid is the box region at proto resolution. */
export interface SegInstanceRaw {
  cls: string;
  confidence: number;
  /** Source-frame pixels. */
  xyxy: [number, number, number, number];
  maskWidth: number;
  maskHeight: number;
  /** Bit-packed mask, row-major, MSB = leftmost pixel. */
  maskBits: Buffer;
}

export function packBits(flags: Uint8Array): Buffer {
  const out = Buffer.alloc(Math.ceil(flags.length / 8));
  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) out[i >> 3] |= 0x80 >> (i & 7);
  }
  return out;
}

export function unpackBit(bits: Buffer, index: number): boolean {
  return ((bits[index >> 3] >> (7 - (index & 7))) & 1) === 1;
}

export interface YoloSegPostprocessOpts extends YoloPostprocessOpts {
  /** Model input size (letterboxed), for proto-grid mapping. */
  inputWidth: number;
  inputHeight: number;
  maskThreshold: number;
}

/**
 * Decodes a YOLOv8-seg pair: detection head (1, 4 + numClasses + protoCount, N)
 * plus prototype masks (1, protoCount, ph, pw). Boxes decode exactly like
 * postprocessYoloV8; each NMS survivor's mask is sigmoid(coeffs x proto)
 * cropped to its box at proto resolution and binarized at maskThreshold.
 */
export function postprocessYoloV8Seg(
  output: Float32Array,
  dims: readonly number[],
  proto: Float32Array,
  protoDims: readonly number[],
  opts: YoloSegPostprocessOpts,
): SegInstanceRaw[] {
  if (dims.length !== 3 || dims[0] !== 1) {
    throw new Error(`unexpected segmentation output shape [${dims.join(', ')}]`);
  }
  if (protoDims.length !== 4 || protoDims[0] !== 1) {
    throw new Error(`unexpected proto output shape [${protoDims.join(', ')}]`);
  }
  const channels = dims[1];
  const anchors = dims[2];
  const protoCount = protoDims[1];
  const ph = protoDims[2];
  const pw = protoDims[3];
  const numClasses = channels - 4 - protoCount;
  if (numClasses < 1) {
    throw new Error(
      `segmentation head has ${channels} channels for ${protoCount} protos; no class channels remain`,
    );
  }
  const at = (c: number, j: number): number => output[c * anchors + j];

  interface SegCandidate {
    cls: number;
    confidence: number;
    xyxy: [number, number, number, number]; // letterboxed input pixels
    anchor: number;
  }
  const candidates: SegCandidate[] = [];
  for (let j = 0; j < anchors; j++) {
    let best = 0;
    let bestScore = -Infinity;
    for (let c = 0; c < numClasses; c++) {
      const s = at(4 + c, j);
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    if (bestScore < opts.minConfidence) continue;
    const name = opts.classNames[best] ?? `class_${best}`;
    if (opts.classFilter && !opts.classFilter.has(name)) continue;
    const cx = at(0, j);
    const cy = at(1, j);
    const bw = at(2, j);
    const bh = at(3, j);
    candidates.push({
      cls: best,
      confidence: bestScore,
      xyxy: [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2],
      anchor: j,
    });
  }
  const kept = nmsPerClass(candidates, opts.iouThreshold) as unknown as SegCandidate[];

  const instances: SegInstanceRaw[] = [];
  for (const c of kept) {
    // Proto-grid crop of the letterboxed box.
    const px1 = Math.max(0, Math.floor((c.xyxy[0] / opts.inputWidth) * pw));
    const py1 = Math.max(0, Math.floor((c.xyxy[1] / opts.inputHeight) * ph));
    const px2 = Math.min(pw, Math.ceil((c.xyxy[2] / opts.inputWidth) * pw));
    const py2 = Math.min(ph, Math.ceil((c.xyxy[3] / opts.inputHeight) * ph));
    const mw = Math.max(1, px2 - px1);
    const mh = Math.max(1, py2 - py1);
    const flags = new Uint8Array(mw * mh);
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        const gy = Math.min(ph - 1, py1 + y);
        const gx = Math.min(pw - 1, px1 + x);
        let logit = 0;
        for (let k = 0; k < protoCount; k++) {
          logit += at(4 + numClasses + k, c.anchor) * proto[(k * ph + gy) * pw + gx];
        }
        const prob = 1 / (1 + Math.exp(-logit));
        if (prob > opts.maskThreshold) flags[y * mw + x] = 1;
      }
    }
    // Letterboxed input pixels -> source pixels, clamped (same as detection).
    const x1 = Math.min(Math.max((c.xyxy[0] - opts.padX) / opts.scale, 0), opts.sourceWidth - 1);
    const y1 = Math.min(Math.max((c.xyxy[1] - opts.padY) / opts.scale, 0), opts.sourceHeight - 1);
    const x2 = Math.min(Math.max((c.xyxy[2] - opts.padX) / opts.scale, x1 + 1), opts.sourceWidth);
    const y2 = Math.min(Math.max((c.xyxy[3] - opts.padY) / opts.scale, y1 + 1), opts.sourceHeight);
    instances.push({
      cls: opts.classNames[c.cls] ?? `class_${c.cls}`,
      confidence: Number(c.confidence.toFixed(4)),
      xyxy: [x1, y1, x2, y2].map((v) => Number(v.toFixed(1))) as [number, number, number, number],
      maskWidth: mw,
      maskHeight: mh,
      maskBits: packBits(flags),
    });
  }
  return instances;
}

/**
 * Blends instance masks (class-colored) over an RGBA frame in place, plus a
 * thin box outline and optional labels. Mask grids sample nearest by relative
 * position within each instance's box.
 */
export function drawSegments(
  img: Buffer,
  width: number,
  height: number,
  instances: SegInstanceRaw[],
  withLabels: boolean,
  alpha = 0.45,
): void {
  const pixelScale = width >= 960 ? 2 : 1;
  for (const inst of instances) {
    const color = classColor(inst.cls);
    const [x1, y1, x2, y2] = inst.xyxy;
    const bw = Math.max(1, x2 - x1);
    const bh = Math.max(1, y2 - y1);
    for (let y = Math.max(0, Math.floor(y1)); y < Math.min(height, Math.ceil(y2)); y++) {
      const my = Math.min(inst.maskHeight - 1, Math.floor(((y - y1) / bh) * inst.maskHeight));
      for (let x = Math.max(0, Math.floor(x1)); x < Math.min(width, Math.ceil(x2)); x++) {
        const mx = Math.min(inst.maskWidth - 1, Math.floor(((x - x1) / bw) * inst.maskWidth));
        if (!unpackBit(inst.maskBits, my * inst.maskWidth + mx)) continue;
        const i = (y * width + x) * 4;
        img[i] = Math.round(img[i] * (1 - alpha) + color[0] * alpha);
        img[i + 1] = Math.round(img[i + 1] * (1 - alpha) + color[1] * alpha);
        img[i + 2] = Math.round(img[i + 2] * (1 - alpha) + color[2] * alpha);
      }
    }
    drawRectOutline(img, width, height, Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2), color, 1);
    if (withLabels) {
      const text = `${inst.cls} ${Math.round(inst.confidence * 100)}%`;
      const tw = text.length * 6 * pixelScale + 2;
      const th = 7 * pixelScale + 4;
      const ty = y1 - th >= 0 ? Math.round(y1 - th) : Math.round(y1 + 2);
      fillRect(img, width, height, Math.round(x1), ty, tw, th, color);
      drawText(img, width, height, Math.round(x1) + 2, ty + 2, text, [0, 0, 0], pixelScale);
    }
  }
}

/** Draws detection overlays in place (callers pass a COPY of the shared frame). */
export function drawDetections(
  img: Buffer,
  width: number,
  height: number,
  boxes: DetectionBox[],
  overlays: ReadonlySet<OverlayKind>,
): void {
  const pixelScale = width >= 960 ? 2 : 1;
  for (const box of boxes) {
    const color = classColor(box.cls);
    const [x1, y1, x2, y2] = box.xyxy.map(Math.round);
    if (overlays.has('boxes')) drawRectOutline(img, width, height, x1, y1, x2, y2, color, 2);
    const parts: string[] = [];
    if (overlays.has('labels')) parts.push(box.cls);
    if (overlays.has('confidence')) parts.push(`${Math.round(box.confidence * 100)}%`);
    if (parts.length > 0) {
      const text = parts.join(' ');
      const tw = text.length * 6 * pixelScale + 2;
      const th = 7 * pixelScale + 4;
      const ty = y1 - th >= 0 ? y1 - th : y1 + 2;
      fillRect(img, width, height, x1, ty, tw, th, color);
      drawText(img, width, height, x1 + 2, ty + 2, text, [0, 0, 0], pixelScale);
    }
  }
}
