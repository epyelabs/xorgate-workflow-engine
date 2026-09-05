import { lazyRequire } from './lazy-require';

/**
 * Lazy access to onnxruntime-node, shared by the model executors. The module
 * is a native dependency present only on media-capable targets (the
 * engine-runner image and dev machines); it is marked external in every Lambda
 * bundling preset and required lazily HERE, at executor run time, so importing
 * the catalog (registry, publish validation, serialized catalog) never touches
 * it.
 */

export interface OrtTensor {
  data: Float32Array;
  dims: readonly number[];
}
export interface OrtValueMetadata {
  name: string;
  shape?: ReadonlyArray<number | string>;
}
export interface OrtSession {
  inputNames: string[];
  outputNames: string[];
  /** Present on onnxruntime-node >= 1.21; `xwe models check` prints it when there. */
  inputMetadata?: ReadonlyArray<OrtValueMetadata>;
  outputMetadata?: ReadonlyArray<OrtValueMetadata>;
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void>;
}
export interface OrtModule {
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
  InferenceSession: { create(path: string): Promise<OrtSession> };
}

export function loadOrt(): OrtModule {
  try {
    return lazyRequire<OrtModule>('onnxruntime-node');
  } catch {
    throw new Error(
      'onnxruntime-node is not installed on this host; model nodes need it (npm install onnxruntime-node, or a default install without --omit=optional)',
    );
  }
}
