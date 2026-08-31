import { z } from 'zod';
import { inputsForPort, mergeByTs } from '../../engine/helpers';
import type { EngineInChannel, EngineRunCtx, TelemetryPayload } from '../types';
import { defineNode } from '../types';

// Joins several telemetry streams onto a common clock (the upgrade target for
// the PoC processor.sensor_fusion node).

const configSchema = z.object({
  toleranceMs: z
    .number()
    .int()
    .positive()
    .default(200)
    .describe('Samples within this window are merged onto one tick'),
});

export const def = defineNode({
  type: 'telemetry.time_align',
  version: 1,
  group: 'telemetry',
  label: 'Time Align',
  description: 'Aligns and merges multiple telemetry streams on a common clock.',
  ui: { icon: 'align-horizontal-justify-center' },
  inputs: [
    { id: 'telemetry', label: 'Telemetry', channel: 'telemetry', cardinality: 'many', required: true },
  ],
  outputs: [
    { id: 'telemetry', label: 'Telemetry', channel: 'telemetry', cardinality: 'many', required: false },
  ],
  config: configSchema,
  requires: [],
  runtime: { target: 'any' },
});

// K-way merge by ts, then group: a sample within toleranceMs of the open
// group's first ts merges into it (later values win per signal); anything
// farther flushes the group and opens a new one at its own ts.
export const executor = async function* telemetryTimeAlign(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
) {
  const cfg = configSchema.parse(config);
  const connections = inputsForPort(inputs, 'telemetry');
  let group: { ts: number; signals: Record<string, number> } | null = null;
  let emitted = 0;
  for await (const { msg } of mergeByTs(connections)) {
    if (msg.ch !== 'telemetry') continue;
    const payload = msg.payload as TelemetryPayload;
    if (group && msg.ts - group.ts <= cfg.toleranceMs) {
      Object.assign(group.signals, payload.signals);
      continue;
    }
    if (group) {
      emitted += 1;
      yield { ch: 'telemetry' as const, ts: group.ts, payload: { signals: group.signals } };
    }
    group = { ts: msg.ts, signals: { ...payload.signals } };
  }
  if (group) {
    emitted += 1;
    yield { ch: 'telemetry' as const, ts: group.ts, payload: { signals: group.signals } };
  }
  ctx.setSummary(`aligned ${connections.length} streams into ${emitted} ticks`);
};
