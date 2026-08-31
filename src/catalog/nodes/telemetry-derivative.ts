import { z } from 'zod';
import { requireInput, telemetrySamples } from '../../engine/helpers';
import type { EngineInChannel, EngineRunCtx } from '../types';
import { defineNode } from '../types';

// Two modes: plain d/dt of a signal, and speed-from-position (haversine over
// gps.latitude/gps.longitude), which is the upgrade target for the PoC
// processor.speed_from_gps node.

const configSchema = z
  .object({
    mode: z
      .enum(['rate', 'speed_from_position'])
      .default('rate')
      .describe('rate: d/dt of a signal; speed_from_position: km/h from gps.latitude/longitude'),
    signal: z.string().min(1).optional().describe('Input signal (rate mode only)'),
    outputSignal: z
      .string()
      .min(1)
      .optional()
      .describe('Name of the emitted signal (default: <signal>.rate or speed_kph)'),
  })
  .refine((c) => c.mode !== 'rate' || !!c.signal, {
    message: 'signal is required in rate mode',
    path: ['signal'],
  });

export const def = defineNode({
  type: 'telemetry.derivative',
  version: 1,
  group: 'telemetry',
  label: 'Derivative',
  description: 'Rate of change of a signal, or ground speed derived from GPS positions.',
  ui: { icon: 'gauge' },
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

const EARTH_RADIUS_M = 6_371_000;

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// Incoming signals pass through; the derived signal is added once two usable
// samples have been seen (the first sample has no rate).
export const executor = async function* telemetryDerivative(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
) {
  const cfg = configSchema.parse(config);
  const outKey =
    cfg.outputSignal ?? (cfg.mode === 'rate' ? `${cfg.signal}.rate` : 'speed_kph');
  let prevTs: number | null = null;
  let prevValue: number | null = null;
  let prevLat: number | null = null;
  let prevLon: number | null = null;
  let derived = 0;
  for await (const sample of telemetrySamples(requireInput(inputs, 'telemetry'))) {
    const signals = { ...sample.signals };
    if (cfg.mode === 'rate') {
      const value = signals[cfg.signal!];
      if (typeof value === 'number') {
        if (prevTs !== null && prevValue !== null && sample.ts > prevTs) {
          signals[outKey] = (value - prevValue) / ((sample.ts - prevTs) / 1000);
          derived += 1;
        }
        prevTs = sample.ts;
        prevValue = value;
      }
    } else {
      // Devices emit `gps.lat`/`gps.lon` (see device collectors/gps.ts); the
      // long names predate that and survive in older demo templates/CSV
      // uploads — accept both (Phase 6.10; the mismatch made this node derive
      // all-zeros against real device history).
      const lat = signals['gps.latitude'] ?? signals['gps.lat'];
      const lon = signals['gps.longitude'] ?? signals['gps.lon'];
      if (typeof lat === 'number' && typeof lon === 'number') {
        if (prevTs !== null && prevLat !== null && prevLon !== null && sample.ts > prevTs) {
          const meters = haversineMeters(prevLat, prevLon, lat, lon);
          signals[outKey] = (meters / ((sample.ts - prevTs) / 1000)) * 3.6;
          derived += 1;
        }
        prevTs = sample.ts;
        prevLat = lat;
        prevLon = lon;
      }
    }
    yield { ch: 'telemetry' as const, ts: sample.ts, payload: { signals } };
  }
  ctx.setSummary(`derived ${derived} ${outKey} values (${cfg.mode})`);
};
