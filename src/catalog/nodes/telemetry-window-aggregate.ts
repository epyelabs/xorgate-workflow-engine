import { z } from 'zod';
import { requireInput, telemetrySamples } from '../../engine/helpers';
import type { EngineInChannel, EngineRunCtx } from '../types';
import { defineNode } from '../types';

const configSchema = z.object({
  windowSeconds: z.number().positive().default(60).describe('Sliding window length'),
  fn: z.enum(['mean', 'min', 'max', 'sum', 'count', 'stddev']).default('mean'),
  signal: z.string().min(1).optional().describe('Signal to aggregate (default: all signals)'),
});

export const def = defineNode({
  type: 'telemetry.window_aggregate',
  version: 1,
  group: 'telemetry',
  label: 'Window Aggregate',
  description: 'Aggregates a signal over a sliding time window.',
  ui: { icon: 'sigma' },
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

type Fn = z.infer<typeof configSchema>['fn'];

function aggregate(values: number[], fn: Fn): number {
  switch (fn) {
    case 'count':
      return values.length;
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    case 'mean':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'stddev': {
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
    }
  }
}

// Emits one sample per incoming sample; the aggregated signal keeps its name
// (the stream stays e.g. "gps.speed", now windowed), unconfigured signals pass
// through untouched when `signal` is set.
export const executor = async function* telemetryWindowAggregate(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
) {
  const cfg = configSchema.parse(config);
  const windowMs = cfg.windowSeconds * 1000;
  const buffers = new Map<string, Array<{ ts: number; value: number }>>();
  let count = 0;
  for await (const sample of telemetrySamples(requireInput(inputs, 'telemetry'))) {
    const signals = { ...sample.signals };
    for (const [key, value] of Object.entries(sample.signals)) {
      if (cfg.signal && key !== cfg.signal) continue;
      const buffer = buffers.get(key) ?? buffers.set(key, []).get(key)!;
      buffer.push({ ts: sample.ts, value });
      while (buffer.length > 0 && buffer[0].ts < sample.ts - windowMs) buffer.shift();
      signals[key] = aggregate(buffer.map((p) => p.value), cfg.fn);
    }
    count += 1;
    yield { ch: 'telemetry' as const, ts: sample.ts, payload: { signals } };
  }
  ctx.setSummary(`${cfg.fn} over ${cfg.windowSeconds}s, ${count} samples`);
};
