import { z } from 'zod';
import { mergeByTs, requireInput, resolveSignal } from '../../engine/helpers';
import type { EngineInChannel, EngineRunCtx, TelemetryPayload } from '../types';
import { defineNode } from '../types';

// Compares a telemetry signal against a field on ts-aligned json records, e.g.
// gps speed vs json:speed_limit from the Google Roads connector (scenario 2).

const configSchema = z.object({
  signal: z
    .string()
    .min(1)
    .optional()
    .describe('Telemetry signal to compare (default: the only signal on the input)'),
  operator: z.enum(['gt', 'gte', 'lt', 'lte']).default('gt'),
  field: z.string().min(1).default('value').describe('Field on the reference record to compare against'),
  margin: z
    .number()
    .min(0)
    .default(0)
    .describe('Slack added to the reference value before comparing'),
});

export const def = defineNode({
  type: 'logic.comparator',
  version: 1,
  group: 'logic',
  label: 'Comparator',
  description: 'Compares a telemetry signal against a field on time-aligned records.',
  ui: { icon: 'scale' },
  inputs: [
    { id: 'signal', label: 'Telemetry', channel: 'telemetry', cardinality: 'one', required: true },
    { id: 'reference', label: 'Reference', channel: 'json', cardinality: 'one', required: true },
  ],
  outputs: [
    { id: 'condition', label: 'Condition', channel: 'condition', cardinality: 'many', required: false },
  ],
  config: configSchema,
  requires: [],
  runtime: { target: 'any' },
});

function test(op: 'gt' | 'gte' | 'lt' | 'lte', v: number, bound: number): boolean {
  return op === 'gt' ? v > bound : op === 'gte' ? v >= bound : op === 'lt' ? v < bound : v <= bound;
}

// Reference records hold (latest ts <= sample ts wins); telemetry samples seen
// before any reference record are skipped rather than compared against nothing.
export const executor = async function* logicComparator(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
) {
  const cfg = configSchema.parse(config);
  const signalInput = requireInput(inputs, 'signal');
  const referenceInput = requireInput(inputs, 'reference');
  let reference: number | null = null;
  let referenceMeta: Record<string, unknown> | null = null;
  let compared = 0;
  let trueCount = 0;
  let skipped = 0;
  // Reference first: mergeByTs breaks ts ties by input order, so a record
  // stamped at the same ts as a sample applies to that sample.
  for await (const { input, msg } of mergeByTs([referenceInput, signalInput])) {
    if (input === referenceInput) {
      const record = msg.payload as Record<string, unknown>;
      const value = record?.[cfg.field];
      if (typeof value === 'number') {
        reference = value;
        referenceMeta = record;
      }
      continue;
    }
    const payload = msg.payload as TelemetryPayload;
    const key = resolveSignal(cfg.signal, payload.signals, def.label);
    if (key === null) continue;
    if (reference === null) {
      skipped += 1;
      continue;
    }
    const observed = payload.signals[key];
    const bound = reference + cfg.margin;
    const value = test(cfg.operator, observed, bound);
    compared += 1;
    if (value) trueCount += 1;
    yield {
      ch: 'condition' as const,
      ts: msg.ts,
      payload: {
        value,
        meta: {
          signal: key,
          observed,
          operator: cfg.operator,
          reference,
          margin: cfg.margin,
          record: referenceMeta,
        },
      },
    };
  }
  ctx.setSummary(`true on ${trueCount}/${compared} samples (${skipped} before first reference)`);
};
