import { z } from 'zod';
import { requireInput, telemetrySamples } from '../../engine/helpers';
import type { EngineInChannel, EngineRunCtx } from '../types';
import { defineNode } from '../types';

const configSchema = z.object({
  signal: z.string().min(1).optional().describe('Signal to smooth (default: all signals)'),
  alpha: z.number().gt(0).lte(1).default(0.3).describe('Smoothing factor; higher follows the input faster'),
});

export const def = defineNode({
  type: 'telemetry.ema',
  version: 1,
  group: 'telemetry',
  label: 'EMA Smoothing',
  description: 'Exponential moving average over one or all signals.',
  ui: { icon: 'trending-up' },
  inputs: [
    { id: 'telemetry', label: 'Telemetry', channel: 'telemetry', cardinality: 'one', required: true },
  ],
  outputs: [
    { id: 'telemetry', label: 'Telemetry', channel: 'telemetry', cardinality: 'many', required: false },
  ],
  config: configSchema,
  requires: [],
  runtime: { target: 'any' },
});

export const executor = async function* telemetryEma(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
) {
  const cfg = configSchema.parse(config);
  const state = new Map<string, number>(); // signal -> running EMA
  let count = 0;
  for await (const sample of telemetrySamples(requireInput(inputs, 'telemetry'))) {
    const signals = { ...sample.signals };
    for (const [key, value] of Object.entries(signals)) {
      if (cfg.signal && key !== cfg.signal) continue;
      const prev = state.get(key);
      const next = prev === undefined ? value : cfg.alpha * value + (1 - cfg.alpha) * prev;
      state.set(key, next);
      signals[key] = next;
    }
    count += 1;
    yield { ch: 'telemetry' as const, ts: sample.ts, payload: { signals } };
  }
  ctx.setSummary(`smoothed ${count} samples (${cfg.signal ?? 'all signals'}, alpha ${cfg.alpha})`);
};
