import { z } from 'zod';
import { requireInput, resolveSignal, telemetrySamples } from '../../engine/helpers';
import type { EngineInChannel, EngineRunCtx } from '../types';
import { defineNode } from '../types';

const configSchema = z.object({
  signal: z
    .string()
    .min(1)
    .optional()
    .describe('Signal to test (default: the only signal on the input)'),
  operator: z.enum(['gt', 'gte', 'lt', 'lte']).default('gt'),
  value: z.number().default(0).describe('Bound to compare against'),
  hysteresis: z
    .number()
    .min(0)
    .optional()
    .describe('Release margin: the condition clears only past value -/+ hysteresis'),
  minDurationMs: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Signal must stay beyond the bound this long before the condition turns true'),
});

export const def = defineNode({
  type: 'logic.threshold',
  version: 1,
  group: 'logic',
  label: 'Threshold',
  description: 'True while a signal is beyond a configured bound.',
  ui: { icon: 'sliders-horizontal' },
  inputs: [
    { id: 'telemetry', label: 'Telemetry', channel: 'telemetry', cardinality: 'one', required: true },
  ],
  outputs: [
    { id: 'condition', label: 'Condition', channel: 'condition', cardinality: 'many', required: false },
  ],
  config: configSchema,
  requires: [],
  runtime: { target: 'any' },
});

type Op = 'gt' | 'gte' | 'lt' | 'lte';

function test(op: Op, v: number, bound: number): boolean {
  return op === 'gt' ? v > bound : op === 'gte' ? v >= bound : op === 'lt' ? v < bound : v <= bound;
}

// One condition message per input sample carrying the tested signal. Hysteresis
// moves the release bound past the trigger bound; minDurationMs requires the
// raw condition to hold that long before the output turns true.
export const executor = async function* logicThreshold(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
) {
  const cfg = configSchema.parse(config);
  const releaseBound =
    cfg.hysteresis === undefined
      ? cfg.value
      : cfg.operator === 'gt' || cfg.operator === 'gte'
        ? cfg.value - cfg.hysteresis
        : cfg.value + cfg.hysteresis;
  let active = false; // hysteresis state
  let pendingSince: number | null = null; // minDurationMs state
  let trueCount = 0;
  let total = 0;
  for await (const sample of telemetrySamples(requireInput(inputs, 'telemetry'))) {
    const key = resolveSignal(cfg.signal, sample.signals, def.label);
    if (key === null) continue;
    const observed = sample.signals[key];
    // Raw state with hysteresis: trigger past `value`, release past the bound.
    const raw: boolean = active
      ? !test(invert(cfg.operator), observed, releaseBound)
      : test(cfg.operator, observed, cfg.value);
    active = raw;
    let value = raw;
    if (cfg.minDurationMs !== undefined && cfg.minDurationMs > 0) {
      if (raw) {
        pendingSince ??= sample.ts;
        value = sample.ts - pendingSince >= cfg.minDurationMs;
      } else {
        pendingSince = null;
        value = false;
      }
    }
    total += 1;
    if (value) trueCount += 1;
    yield {
      ch: 'condition' as const,
      ts: sample.ts,
      payload: {
        value,
        meta: { signal: key, observed, operator: cfg.operator, threshold: cfg.value },
      },
    };
  }
  ctx.setSummary(`true on ${trueCount}/${total} samples (${cfg.operator} ${cfg.value})`);
};

// The release comparison is the trigger comparison inverted (strictness keeps
// the boundary in the active state).
function invert(op: Op): Op {
  return op === 'gt' ? 'lte' : op === 'gte' ? 'lt' : op === 'lt' ? 'gte' : 'gt';
}
