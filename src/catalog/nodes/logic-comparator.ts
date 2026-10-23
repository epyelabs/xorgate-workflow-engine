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
  maxReferenceAgeMs: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'A held reference older than this (sample ts minus record ts) is stale: the sample is compared against ' +
        'fallbackReference, or skipped without one. Default: a reference holds until the next record.',
    ),
  fallbackReference: z
    .number()
    .optional()
    .describe(
      'Reference value used when there is no usable record: before the first one, after a record whose field is ' +
        'null (e.g. a connector no-answer), or past maxReferenceAgeMs. Default: such samples are skipped.',
    ),
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

// Reference records hold (latest ts <= sample ts wins). A record whose field
// is null clears the held reference (a connector's no-answer record); a record
// without the field, or with a non-numeric one, is ignored as before. Samples
// with no usable reference (none yet, cleared, or older than
// maxReferenceAgeMs) are compared against fallbackReference when set, and
// skipped otherwise.
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
  let referenceTs: number | null = null;
  let compared = 0;
  let trueCount = 0;
  let skipped = 0;
  let viaFallback = 0;
  let stale = 0;
  // Reference first: mergeByTs breaks ts ties by input order, so a record
  // stamped at the same ts as a sample applies to that sample.
  for await (const { input, msg } of mergeByTs([referenceInput, signalInput])) {
    if (input === referenceInput) {
      const record = msg.payload as Record<string, unknown>;
      const value = record?.[cfg.field];
      if (typeof value === 'number') {
        reference = value;
        referenceMeta = record;
        referenceTs = msg.ts;
      } else if (value === null) {
        reference = null;
        referenceMeta = record;
        referenceTs = msg.ts;
      }
      continue;
    }
    const payload = msg.payload as TelemetryPayload;
    const key = resolveSignal(cfg.signal, payload.signals, def.label);
    if (key === null) continue;
    const referenceAgeMs = referenceTs === null ? null : msg.ts - referenceTs;
    const isStale =
      reference !== null &&
      cfg.maxReferenceAgeMs !== undefined &&
      referenceAgeMs !== null &&
      referenceAgeMs > cfg.maxReferenceAgeMs;
    if (isStale) stale += 1;
    let used: number;
    let referenceSource: 'record' | 'fallback';
    if (reference !== null && !isStale) {
      used = reference;
      referenceSource = 'record';
    } else if (cfg.fallbackReference !== undefined) {
      used = cfg.fallbackReference;
      referenceSource = 'fallback';
      viaFallback += 1;
    } else {
      skipped += 1;
      continue;
    }
    const observed = payload.signals[key];
    const bound = used + cfg.margin;
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
          reference: used,
          margin: cfg.margin,
          record: referenceMeta,
          referenceSource,
          referenceAgeMs,
        },
      },
    };
  }
  ctx.setSummary(
    `true on ${trueCount}/${compared} samples (${skipped} ${
      cfg.maxReferenceAgeMs !== undefined || cfg.fallbackReference !== undefined ? 'without a usable reference' : 'before first reference'
    })` +
      (viaFallback > 0 ? `, ${viaFallback} against fallback ${cfg.fallbackReference}` : '') +
      (stale > 0 ? `, ${stale} with a stale reference` : ''),
  );
};
