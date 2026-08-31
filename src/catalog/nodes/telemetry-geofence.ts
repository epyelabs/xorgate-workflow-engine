import { z } from 'zod';
import { requireInput, telemetrySamples } from '../../engine/helpers';
import type { EngineInChannel, EngineRunCtx } from '../types';
import { defineNode } from '../types';

// Position -> condition: true while the device is inside (or outside) a
// polygon. New catalog node in M4 (sanctioned addition; catalogVersion
// changes). The polygon is ordinary config data; ui.editor "geofence" is the
// rich-editor escape hatch the FE can upgrade to a map editor later (it
// renders a JSON-editable stub today).

const pointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const configSchema = z.object({
  polygon: z
    .array(pointSchema)
    .min(3)
    .describe('Fence vertices in order ({ lat, lng }); the ring closes itself'),
  mode: z
    .enum(['inside', 'outside'])
    .default('inside')
    .describe('When the condition is true: inside the fence or outside it'),
  latSignal: z.string().min(1).default('gps.latitude').describe('Latitude signal name'),
  lngSignal: z.string().min(1).default('gps.longitude').describe('Longitude signal name'),
});

export const def = defineNode({
  type: 'telemetry.geofence',
  version: 1,
  group: 'telemetry',
  label: 'Geofence',
  description: 'Tests positions against a polygon fence and emits a condition.',
  ui: { icon: 'map-pin', editor: 'geofence' },
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

/**
 * Ray casting on the lat/lng plane. Fences are local-scale (meters to a few
 * km), so planar treatment is fine; edges crossing the antimeridian are not
 * supported.
 */
export function pointInPolygon(
  lat: number,
  lng: number,
  polygon: Array<{ lat: number; lng: number }>,
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses =
      a.lat > lat !== b.lat > lat &&
      lng < ((b.lng - a.lng) * (lat - a.lat)) / (b.lat - a.lat) + a.lng;
    if (crosses) inside = !inside;
  }
  return inside;
}

// Samples missing either position signal are skipped (counted in the step
// summary), not treated as "outside": a GPS dropout must not fire an exit.
export const executor = async function* telemetryGeofence(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
) {
  const cfg = configSchema.parse(config);
  let emitted = 0;
  let trueCount = 0;
  let skipped = 0;
  for await (const sample of telemetrySamples(requireInput(inputs, 'telemetry'))) {
    const lat = sample.signals[cfg.latSignal];
    const lng = sample.signals[cfg.lngSignal];
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      skipped += 1;
      continue;
    }
    const inside = pointInPolygon(lat, lng, cfg.polygon);
    const value = cfg.mode === 'inside' ? inside : !inside;
    emitted += 1;
    if (value) trueCount += 1;
    yield {
      ch: 'condition' as const,
      ts: sample.ts,
      payload: {
        value,
        meta: { mode: cfg.mode, inside, position: { lat, lng }, vertices: cfg.polygon.length },
      },
    };
  }
  ctx.setSummary(
    `${cfg.mode} fence true on ${trueCount}/${emitted} sample(s)` +
      (skipped > 0 ? `, ${skipped} without a position skipped` : ''),
  );
};
