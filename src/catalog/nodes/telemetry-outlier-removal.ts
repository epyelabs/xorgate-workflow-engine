import { z } from 'zod';
import { requireInput, telemetrySamples } from '../../engine/helpers';
import type { EngineInChannel, EngineRunCtx, TelemetrySample } from '../types';
import { defineNode } from '../types';

const configSchema = z.object({
  signal: z.string().min(1).optional().describe('Signal to clean (default: all signals)'),
  method: z.enum(['zscore', 'iqr']).default('zscore'),
  threshold: z
    .number()
    .positive()
    .default(3)
    .describe('z-score bound (zscore) or IQR multiplier (iqr)'),
});

export const def = defineNode({
  type: 'telemetry.outlier_removal',
  version: 1,
  group: 'telemetry',
  label: 'Outlier Removal',
  description: 'Drops statistical outliers from a signal.',
  ui: { icon: 'filter' },
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

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function keepBounds(values: number[], method: 'zscore' | 'iqr', threshold: number): [number, number] {
  if (method === 'zscore') {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const std = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
    if (std === 0) return [-Infinity, Infinity];
    return [mean - threshold * std, mean + threshold * std];
  }
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  return [q1 - threshold * iqr, q3 + threshold * iqr];
}

// Whole-series statistics need the full input, so this node buffers before
// emitting (fine for telemetry-scale batch data; downstream simply waits).
// An offending value is removed from its sample; a sample left with no signals
// is dropped entirely.
export const executor = async function* telemetryOutlierRemoval(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
) {
  const cfg = configSchema.parse(config);
  const samples: TelemetrySample[] = [];
  for await (const sample of telemetrySamples(requireInput(inputs, 'telemetry'))) {
    samples.push(sample);
  }

  const bounds = new Map<string, [number, number]>();
  const bySignal = new Map<string, number[]>();
  for (const sample of samples) {
    for (const [key, value] of Object.entries(sample.signals)) {
      if (cfg.signal && key !== cfg.signal) continue;
      (bySignal.get(key) ?? bySignal.set(key, []).get(key)!).push(value);
    }
  }
  for (const [key, values] of bySignal) {
    if (values.length >= 4) bounds.set(key, keepBounds(values, cfg.method, cfg.threshold));
  }

  let dropped = 0;
  for (const sample of samples) {
    const signals: Record<string, number> = {};
    for (const [key, value] of Object.entries(sample.signals)) {
      const bound = bounds.get(key);
      if (bound && (value < bound[0] || value > bound[1])) {
        dropped += 1;
        continue;
      }
      signals[key] = value;
    }
    if (Object.keys(signals).length === 0) continue;
    yield { ch: 'telemetry' as const, ts: sample.ts, payload: { signals } };
  }
  ctx.setSummary(`dropped ${dropped} outliers (${cfg.method}, ${samples.length} samples)`);
};
