// acme.scale: the node from the docs page "Extending the catalog", as an ES
// module. A definition (`def`) and an executor, exactly like a core node.
import { z } from 'zod';
import { defineNode, requireInput, telemetrySamples } from '@xorgate/workflow-engine';

const configSchema = z.object({
  signal: z.string().min(1).describe('Signal to scale'),
  factor: z.number().default(1).describe('Multiplier'),
});

export const def = defineNode({
  type: 'acme.scale',
  version: 1,
  group: 'telemetry',
  label: 'Scale',
  description: 'Multiplies one signal by a constant.',
  ui: { icon: 'move-diagonal' },
  inputs: [{ id: 'telemetry', label: 'Telemetry', channel: 'telemetry', cardinality: 'one', required: true }],
  outputs: [{ id: 'telemetry', label: 'Telemetry', channel: 'telemetry', cardinality: 'many', required: false }],
  config: configSchema,
  requires: [],
  runtime: { target: 'any' },
});

export const executor = async function* scale(inputs, config, ctx) {
  const cfg = configSchema.parse(config);
  let count = 0;
  for await (const sample of telemetrySamples(requireInput(inputs, 'telemetry'))) {
    const signals = { ...sample.signals };
    if (cfg.signal in signals) signals[cfg.signal] *= cfg.factor;
    count += 1;
    yield { ch: 'telemetry', ts: sample.ts, payload: { signals } };
  }
  ctx.setSummary(`scaled ${count} samples (${cfg.signal} × ${cfg.factor})`);
};
