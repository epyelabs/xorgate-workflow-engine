import { z } from 'zod';
import { requireInput } from '../../engine/helpers';
import { loadAnthropic } from '../../engine/anthropic';
import { encodeRgbaToJpeg } from '../../engine/media';
import type {
  ConditionPayload,
  EngineEmit,
  EngineInChannel,
  EngineRunCtx,
  FramePayload,
  VlmPayload,
} from '../types';
import { defineNode } from '../types';

// model.vlm (M5, architecture §6): frames in, condition + json:vlm out, calling
// Claude directly through the Anthropic TypeScript SDK — no serving infra.
// Sampled frames go as base64 image content blocks with the node's prompt; the
// boolean verdict is enforced with structured outputs (output_config.format
// with a JSON schema), so downstream logic gets clean values, never parsed
// prose. Guardrails are baked into config: low-fps sampling (vision tokens
// scale with fps) and frame downscaling before encoding (vision tokens scale
// with resolution). The API key comes through the secrets seam (logical name
// "anthropic-api-key"); the HTTP layer is ctx.http, so the smoke script runs
// the real SDK request path against a mocked Messages API, offline.

const VLM_MODELS = ['claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-4-8'] as const;

const configSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe('What to check on each frame, phrased as a yes/no question (e.g. "Is the driver looking away from the road?")'),
  model: z
    .enum(VLM_MODELS)
    .default('claude-sonnet-5')
    .describe('Claude vision model (haiku: cheap higher-fps sampling; opus: hardest scenes)'),
  maxFps: z
    .number()
    .positive()
    .max(2)
    .default(0.5)
    .describe('Frames analyzed per second (keep low: cost scales with frame rate)'),
  maxWidth: z
    .number()
    .int()
    .min(160)
    .max(768)
    .default(512)
    .describe('Frames are downscaled to this width before analysis (cost scales with resolution)'),
  minConfidence: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe('Condition is true only when the verdict confidence reaches this value'),
});

export const def = defineNode({
  type: 'model.vlm',
  version: 1,
  group: 'model',
  label: 'VLM Analysis',
  description: 'Asks a Claude vision model a yes/no question about sampled frames.',
  ui: { icon: 'sparkles', editor: 'prompt' },
  inputs: [{ id: 'frames', label: 'Frames', channel: 'frames', cardinality: 'one', required: true }],
  outputs: [
    { id: 'condition', label: 'Condition', channel: 'condition', cardinality: 'many', required: false },
    { id: 'analysis', label: 'Analysis', channel: 'json', tag: 'vlm', cardinality: 'many', required: false },
  ],
  config: configSchema,
  requires: [],
  runtime: { target: 'media' },
});

const SYSTEM_PROMPT =
  'You analyze single video frames for an automated monitoring workflow. ' +
  'Answer the question about the frame you are given. Base the verdict only on what is visible. ' +
  'Set verdict=true only when the condition in the question is clearly met; report your confidence from 0 to 1 ' +
  'and give a one-sentence reason.';

// Structured-output schema for the verdict (no numeric range constraints:
// unsupported in structured outputs; confidence is clamped in code).
const VERDICT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'boolean', description: 'True only when the condition in the question is clearly met' },
    confidence: { type: 'number', description: 'Confidence in the verdict, 0 to 1' },
    reason: { type: 'string', description: 'One-sentence justification' },
  },
  required: ['verdict', 'confidence', 'reason'],
  additionalProperties: false,
} as const;

const verdictSchema = z.object({
  verdict: z.boolean(),
  confidence: z.number(),
  reason: z.string(),
});

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 1;
const MAX_OUTPUT_TOKENS = 512;
const JPEG_QUALITY = 80;

/** Nearest-neighbor RGBA downscale to maxWidth (no-op when already narrower). */
function downscaleRgba(
  frame: FramePayload,
  maxWidth: number,
): { data: Buffer; width: number; height: number } {
  if (frame.width <= maxWidth) {
    return { data: frame.image, width: frame.width, height: frame.height };
  }
  const outW = maxWidth;
  const outH = Math.max(2, Math.round((frame.height * maxWidth) / frame.width / 2) * 2);
  const out = Buffer.alloc(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const srcY = Math.min(frame.height - 1, Math.floor((y * frame.height) / outH));
    for (let x = 0; x < outW; x++) {
      const srcX = Math.min(frame.width - 1, Math.floor((x * frame.width) / outW));
      const src = (srcY * frame.width + srcX) * 4;
      const dst = (y * outW + x) * 4;
      out[dst] = frame.image[src];
      out[dst + 1] = frame.image[src + 1];
      out[dst + 2] = frame.image[src + 2];
      out[dst + 3] = 255;
    }
  }
  return { data: out, width: outW, height: outH };
}

export const executor = async function* modelVlm(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
): AsyncIterable<EngineEmit> {
  const cfg = configSchema.parse(config);
  if (!ctx.secrets) {
    throw new Error('This engine target has no secret access; model.vlm needs the ANTHROPIC_API_KEY secret');
  }
  const apiKey = await ctx.secrets.getSecret('anthropic-api-key');
  const client = loadAnthropic({
    apiKey,
    fetch: ctx.http,
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  });

  const minIntervalMs = 1000 / cfg.maxFps;
  let lastSampledTs = -Infinity;
  let frames = 0;
  let sampled = 0;
  let trueCount = 0;
  let apiMs = 0;

  for await (const msg of requireInput(inputs, 'frames').messages) {
    if (msg.ch !== 'frames') continue;
    const frame = msg.payload as FramePayload;
    frames += 1;
    if (frame.ts - lastSampledTs < minIntervalMs) continue; // fps guardrail
    lastSampledTs = frame.ts;
    sampled += 1;

    const scaled = downscaleRgba(frame, cfg.maxWidth);
    const jpegBase64 = encodeRgbaToJpeg(scaled.data, scaled.width, scaled.height, JPEG_QUALITY).toString('base64');

    const t0 = Date.now();
    let result: VlmPayload;
    try {
      const res = await client.messages.create({
        model: cfg.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        thinking: { type: 'disabled' },
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegBase64 } },
              { type: 'text', text: cfg.prompt },
            ],
          },
        ],
        output_config: { format: { type: 'json_schema', schema: VERDICT_JSON_SCHEMA } },
      });
      if (res.stop_reason === 'refusal') {
        // A safety decline is a per-frame outcome, not a node failure.
        result = { ts: msg.ts, frameSeq: frame.seq, verdict: false, confidence: 0, reason: 'Model declined to analyze this frame', model: cfg.model };
      } else {
        const text = res.content.find((b) => b.type === 'text')?.text;
        if (!text) throw new Error(`Claude returned no text block (stop_reason ${res.stop_reason ?? 'null'})`);
        const parsed = verdictSchema.safeParse(JSON.parse(text));
        if (!parsed.success) throw new Error(`Verdict did not match the structured-output schema: ${text.slice(0, 200)}`);
        result = {
          ts: msg.ts,
          frameSeq: frame.seq,
          verdict: parsed.data.verdict,
          confidence: Math.min(1, Math.max(0, parsed.data.confidence)),
          reason: parsed.data.reason,
          model: cfg.model,
        };
      }
    } catch (err) {
      throw new Error(`Claude API call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    apiMs += Date.now() - t0;
    if (result.verdict) trueCount += 1;

    const condition: ConditionPayload = {
      value: result.verdict && result.confidence >= cfg.minConfidence,
      meta: {
        prompt: cfg.prompt,
        model: cfg.model,
        verdict: result.verdict,
        confidence: result.confidence,
        reason: result.reason,
        frameSeq: frame.seq,
      },
    };
    yield { ch: 'condition' as const, port: 'condition', ts: msg.ts, payload: condition };
    yield { ch: 'json' as const, port: 'analysis', tag: 'vlm', ts: msg.ts, payload: result };
  }

  const avg = sampled > 0 ? Math.round(apiMs / sampled) : 0;
  ctx.setSummary(
    `verdict true on ${trueCount}/${sampled} analyzed frame(s) of ${frames} (${cfg.model}, ~${avg} ms/frame)`,
  );
};
