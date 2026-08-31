import { z } from 'zod';
import { requireInput, telemetrySamples } from '../../engine/helpers';
import type { EngineInChannel, EngineRunCtx } from '../types';
import { defineNode } from '../types';

const configSchema = z.object({
  intervalSeconds: z.number().positive().default(1).describe('Output sample interval'),
  method: z.enum(['linear', 'hold', 'nearest']).default('linear'),
});

export const def = defineNode({
  type: 'telemetry.resample',
  version: 1,
  group: 'telemetry',
  label: 'Resample',
  description: 'Resamples the telemetry stream onto a fixed interval.',
  ui: { icon: 'timer' },
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

type Obs = { ts: number; value: number };

function valueAt(gridTs: number, prev: Obs, next: Obs, method: 'linear' | 'hold' | 'nearest'): number {
  if (method === 'hold' || next.ts === prev.ts) return prev.value;
  if (method === 'nearest') return gridTs - prev.ts <= next.ts - gridTs ? prev.value : next.value;
  const f = (gridTs - prev.ts) / (next.ts - prev.ts);
  return prev.value + f * (next.value - prev.value);
}

// Emits samples on a fixed grid aligned to the interval, covering [first, last]
// observation. Each signal is tracked independently (streams with interleaved
// sparse signals resample per signal); a grid tick is emitted once every
// pending signal spanning it is resolvable.
export const executor = async function* telemetryResample(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
) {
  const cfg = configSchema.parse(config);
  const intervalMs = cfg.intervalSeconds * 1000;
  const lastObs = new Map<string, Obs>();
  let gridTs: number | null = null; // next grid tick to emit
  let emitted = 0;

  for await (const sample of telemetrySamples(requireInput(inputs, 'telemetry'))) {
    if (gridTs === null) gridTs = Math.ceil(sample.ts / intervalMs) * intervalMs;
    // Emit every grid tick the incoming sample has just crossed.
    while (gridTs <= sample.ts) {
      const signals: Record<string, number> = {};
      for (const [key, prev] of lastObs) {
        if (prev.ts > gridTs) continue;
        const nextValue = sample.signals[key];
        const next: Obs = typeof nextValue === 'number' ? { ts: sample.ts, value: nextValue } : prev;
        signals[key] = valueAt(gridTs, prev, next, cfg.method);
      }
      // First tick may precede any observation; emit only when data exists.
      if (Object.keys(signals).length > 0) {
        emitted += 1;
        yield { ch: 'telemetry' as const, ts: gridTs, payload: { signals } };
      }
      gridTs += intervalMs;
    }
    for (const [key, value] of Object.entries(sample.signals)) {
      lastObs.set(key, { ts: sample.ts, value });
    }
  }
  ctx.setSummary(`${emitted} samples at ${cfg.intervalSeconds}s (${cfg.method})`);
};
