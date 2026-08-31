import { z } from 'zod';
import { requireInput, telemetrySamples } from '../../engine/helpers';
import type { EngineInChannel, EngineRunCtx } from '../types';
import { defineNode } from '../types';

const configSchema = z.object({
  signal: z.string().min(1).describe('Signal to filter, e.g. gps.speed'),
  processNoise: z.number().positive().default(0.01),
  measurementNoise: z.number().positive().default(1),
});

export const def = defineNode({
  type: 'telemetry.kalman',
  version: 1,
  group: 'telemetry',
  label: 'Kalman Filter',
  description: 'Smooths a noisy signal with a 1D Kalman filter.',
  ui: { icon: 'audio-waveform' },
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

// Scalar Kalman: constant-state model, filtered value replaces the configured
// signal, other signals pass through untouched.
export const executor = async function* telemetryKalman(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
) {
  const cfg = configSchema.parse(config);
  let estimate: number | null = null;
  let variance = 1;
  let count = 0;
  for await (const sample of telemetrySamples(requireInput(inputs, 'telemetry'))) {
    const signals = { ...sample.signals };
    const measured = signals[cfg.signal];
    if (typeof measured === 'number') {
      if (estimate === null) {
        estimate = measured;
      } else {
        variance += cfg.processNoise;
        const gain = variance / (variance + cfg.measurementNoise);
        estimate += gain * (measured - estimate);
        variance *= 1 - gain;
      }
      signals[cfg.signal] = estimate;
      count += 1;
    }
    yield { ch: 'telemetry' as const, ts: sample.ts, payload: { signals } };
  }
  ctx.setSummary(`filtered ${count} samples (${cfg.signal})`);
};
