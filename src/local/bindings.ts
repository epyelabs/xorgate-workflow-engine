import type { EngineSourceBinding } from '../catalog/types';

/**
 * The `path` alias (local host only, additive): a hand-written local manifest
 * may say `path` where the platform's binding kinds say `s3Key`. The source
 * executors are shared with the platform and parse `s3Key`, so the alias is
 * folded here, before the manifest reaches the engine; the platform's shell
 * never sees it. `video_local` already carries `path` as its own field and is
 * left alone.
 */

const S3KEY_KINDS = new Set(['telemetry_csv', 'telemetry_materialized', 'video_file']);

function aliasPath<T extends Record<string, unknown>>(obj: T): T {
  if (typeof obj.path !== 'string' || obj.s3Key !== undefined) return obj;
  const { path, ...rest } = obj;
  return { ...rest, s3Key: path } as unknown as T;
}

export function localizeBinding(binding: EngineSourceBinding): EngineSourceBinding {
  let out = binding;
  if (S3KEY_KINDS.has(binding.kind)) out = aliasPath(out);
  if (binding.kind === 'device_session' && Array.isArray(binding.segments)) {
    out = {
      ...out,
      segments: (binding.segments as unknown[]).map((seg) =>
        seg && typeof seg === 'object' ? aliasPath(seg as Record<string, unknown>) : seg,
      ),
    };
  }
  return out;
}

export function localizeBindings(
  bindings: Record<string, EngineSourceBinding>,
): Record<string, EngineSourceBinding> {
  return Object.fromEntries(Object.entries(bindings).map(([id, b]) => [id, localizeBinding(b)]));
}
