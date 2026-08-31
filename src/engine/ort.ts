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
export interface OrtSession {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
}
export interface OrtModule {
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
  InferenceSession: { create(path: string): Promise<OrtSession> };
}

export function loadOrt(): OrtModule {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('onnxruntime-node') as OrtModule;
  } catch {
    throw new Error(
      'onnxruntime-node is not available on this engine target; model nodes need the media (Fargate) engine',
    );
  }
}
