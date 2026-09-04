import { lazyRequire } from './lazy-require';

/**
 * Lazy access to the Anthropic TypeScript SDK, used by the model.vlm executor
 * (architecture §6: the VLM node calls the Claude API directly, no serving
 * infra). Mirrors ort.ts: the package is marked external in every Lambda
 * bundling preset and required lazily HERE at executor run time, so importing
 * the catalog never touches it; only the media (Fargate) target — which ships
 * full node_modules — can actually run the executor.
 *
 * The HTTP layer is injectable: the client is constructed with ctx.http as its
 * fetch, so the smoke script runs the REAL SDK request path against a mocked
 * Messages API response, fully offline.
 */

/** The slice of the SDK response the VLM executor consumes. */
export interface AnthropicMessageResult {
  content: Array<{ type: string; text?: string }>;
  stop_reason: string | null;
}
export interface AnthropicClientLike {
  messages: {
    create(params: Record<string, unknown>): Promise<AnthropicMessageResult>;
  };
}

export function loadAnthropic(opts: {
  apiKey: string;
  fetch: typeof fetch;
  timeoutMs: number;
  maxRetries: number;
}): AnthropicClientLike {
  let mod: Record<string, unknown>;
  try {
    mod = lazyRequire<Record<string, unknown>>('@anthropic-ai/sdk');
  } catch {
    throw new Error(
      '@anthropic-ai/sdk is not installed on this host; model.vlm needs it (npm install @anthropic-ai/sdk, or a default install without --omit=optional)',
    );
  }
  const Ctor = (mod.Anthropic ?? mod.default ?? mod) as new (o: Record<string, unknown>) => AnthropicClientLike;
  return new Ctor({
    apiKey: opts.apiKey,
    fetch: opts.fetch,
    timeout: opts.timeoutMs,
    maxRetries: opts.maxRetries,
  });
}
