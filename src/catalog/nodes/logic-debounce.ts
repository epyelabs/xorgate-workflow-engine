import { z } from 'zod';
import { requireInput } from '../../engine/helpers';
import type { ConditionPayload, EngineInChannel, EngineRunCtx } from '../types';
import { defineNode } from '../types';

const configSchema = z.object({
  minDurationMs: z
    .number()
    .int()
    .min(0)
    .default(2000)
    .describe('Input must stay true this long before the output turns true'),
  cooldownMs: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('After the output clears, stay false at least this long'),
});

export const def = defineNode({
  type: 'logic.debounce',
  version: 1,
  group: 'logic',
  label: 'Debounce',
  description: 'Suppresses condition flicker: sustained-true to pass, cooldown between firings.',
  ui: { icon: 'timer-reset' },
  inputs: [
    { id: 'condition', label: 'Condition', channel: 'condition', cardinality: 'one', required: true },
  ],
  outputs: [
    { id: 'condition', label: 'Condition', channel: 'condition', cardinality: 'many', required: false },
  ],
  config: configSchema,
  requires: [],
  runtime: { target: 'any' },
});

// Message-timestamp driven (batch replays behave identically to live): the
// input must hold true for minDurationMs before the output turns true; once
// the output clears, it stays false for cooldownMs regardless of the input.
export const executor = async function* logicDebounce(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
) {
  const cfg = configSchema.parse(config);
  let trueSince: number | null = null;
  let output = false;
  let cooldownUntil = -Infinity;
  let firings = 0;
  let emitted = 0;
  for await (const msg of requireInput(inputs, 'condition').messages) {
    if (msg.ch !== 'condition') continue;
    const payload = msg.payload as ConditionPayload;
    const raw = Boolean(payload.value);
    if (raw) {
      trueSince ??= msg.ts;
    } else {
      trueSince = null;
    }
    const wasOutput = output;
    if (output) {
      if (!raw) {
        output = false;
        cooldownUntil = msg.ts + cfg.cooldownMs;
      }
    } else if (
      raw &&
      trueSince !== null &&
      msg.ts - trueSince >= cfg.minDurationMs &&
      msg.ts >= cooldownUntil
    ) {
      output = true;
    }
    if (output && !wasOutput) firings += 1;
    emitted += 1;
    yield {
      ch: 'condition' as const,
      ts: msg.ts,
      payload: { value: output, meta: payload.meta },
    };
  }
  ctx.setSummary(`passed ${firings} sustained firing(s) over ${emitted} messages`);
};
