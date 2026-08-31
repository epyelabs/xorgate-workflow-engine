import { z } from 'zod';
import type { EngineInChannel, EngineRunCtx, TelemetrySample } from '../types';
import { defineNode } from '../types';

// Abstract telemetry input. The named metric keys become signals on the
// telemetry channel and drive the metric:<key> capability tokens checked at
// attach time; the CONCRETE feed (stored device history window, CSV replay,
// live stream) is a binding chosen at attach or simulation time.

const configSchema = z.object({
  metrics: z
    .array(z.string().min(1))
    .min(1)
    .describe('Signal keys this source provides, e.g. gps.speed, imu.accel_x'),
});

export const def = defineNode({
  type: 'source.telemetry',
  version: 1,
  group: 'source',
  label: 'Telemetry',
  description:
    'Telemetry input. The concrete feed (device history, CSV replay, live stream) is bound at attach or simulation time.',
  ui: { icon: 'radio' },
  inputs: [],
  outputs: [
    { id: 'telemetry', label: 'Telemetry', channel: 'telemetry', cardinality: 'many', required: false },
  ],
  config: configSchema,
  requires: [{ tokenTemplate: 'metric:{config.metrics}' }],
  runtime: { target: 'any' },
});

// Binding kinds this source accepts (EngineSourceBinding is deliberately loose;
// the union lives here, with the executor). No binding defaults to a history
// read over the run window. telemetry_csv (M3): an uploaded CSV fetched through
// the fetchText seam and parsed executor-side, so manifests stay small and the
// same binding works on both engine targets.
const bindingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('telemetry_history'),
    metrics: z.array(z.string().min(1)).min(1).optional(), // default: config.metrics
    window: z.object({ from: z.string().min(1), to: z.string().min(1) }).optional(), // default: run window
  }),
  z.object({
    kind: z.literal('telemetry_inline'),
    samples: z.array(z.object({ ts: z.number(), signals: z.record(z.string(), z.number()) })),
  }),
  z.object({
    kind: z.literal('telemetry_csv'),
    s3Key: z.string().min(1),
    bucket: z.string().min(1).optional(), // default: the run's output bucket
    metrics: z.array(z.string().min(1)).min(1).optional(), // default: every numeric column
  }),
  // M4 (container telemetry seam): the DISPATCHER pre-read a history window
  // and wrote it to inputs/<nodeId>/records.jsonl under the run prefix; the
  // executor fetches it through the same fetchText seam CSV uses. This is how
  // fusion graphs get device history on the DB-less Fargate target.
  z.object({
    kind: z.literal('telemetry_materialized'),
    s3Key: z.string().min(1),
    bucket: z.string().min(1).optional(), // default: the run's output bucket
  }),
]);

// CSV format (FROZEN for the M3 uploads): a header row with a `ts` column
// (epoch ms or ISO-8601) plus one column per signal; every other cell must be
// numeric (non-numeric cells are skipped). Plain commas only, no quoting.
const MAX_CSV_ROWS = 200_000;

export function parseTelemetryCsv(
  text: string,
  metricsFilter?: string[],
): { samples: TelemetrySample[]; skippedCells: number } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('CSV needs a header row and at least one data row');
  const header = lines[0].split(',').map((h) => h.trim());
  const tsIndex = header.findIndex((h) => h === 'ts');
  if (tsIndex === -1) throw new Error('CSV header must include a "ts" column');
  const wanted = metricsFilter ? new Set(metricsFilter) : null;
  const signalColumns = header
    .map((name, index) => ({ name, index }))
    .filter((c) => c.index !== tsIndex && c.name.length > 0 && (!wanted || wanted.has(c.name)));
  if (signalColumns.length === 0) throw new Error('CSV has no signal columns (after the metrics filter)');
  if (lines.length - 1 > MAX_CSV_ROWS) {
    throw new Error(`CSV has ${lines.length - 1} rows; the limit is ${MAX_CSV_ROWS}`);
  }
  const samples: TelemetrySample[] = [];
  let skippedCells = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const rawTs = (cells[tsIndex] ?? '').trim();
    const asNumber = Number(rawTs);
    const ts = rawTs !== '' && Number.isFinite(asNumber) ? asNumber : Date.parse(rawTs);
    if (!Number.isFinite(ts)) throw new Error(`CSV row ${i + 1}: unparseable ts "${rawTs}"`);
    const signals: Record<string, number> = {};
    for (const col of signalColumns) {
      const raw = (cells[col.index] ?? '').trim();
      if (raw === '') continue;
      const value = Number(raw);
      if (Number.isFinite(value)) signals[col.name] = value;
      else skippedCells += 1;
    }
    if (Object.keys(signals).length > 0) samples.push({ ts, signals });
  }
  samples.sort((a, b) => a.ts - b.ts);
  return { samples, skippedCells };
}

/**
 * Materialized-history format (M4, written by the dispatcher): one
 * `{ ts, signals }` JSON object per line, ts-ordered epoch ms. Bad lines fail
 * the node: the writer is first-party, so a parse error means a real bug.
 */
export function parseTelemetryJsonl(text: string): TelemetrySample[] {
  const samples: TelemetrySample[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`materialized telemetry line ${i + 1} is not JSON`);
    }
    const sample = row as TelemetrySample;
    if (typeof sample?.ts !== 'number' || typeof sample?.signals !== 'object' || sample.signals === null) {
      throw new Error(`materialized telemetry line ${i + 1} is not a { ts, signals } sample`);
    }
    samples.push({ ts: sample.ts, signals: sample.signals });
  }
  samples.sort((a, b) => a.ts - b.ts);
  return samples;
}

async function readSamples(
  cfg: z.infer<typeof configSchema>,
  ctx: EngineRunCtx,
): Promise<{ samples: TelemetrySample[]; feed: string }> {
  const parsed = bindingSchema.safeParse(ctx.binding ?? { kind: 'telemetry_history' });
  if (!parsed.success) {
    throw new Error(`Unsupported telemetry binding "${String(ctx.binding?.kind)}"`);
  }
  const binding = parsed.data;
  switch (binding.kind) {
    case 'telemetry_inline':
      return { samples: [...binding.samples].sort((a, b) => a.ts - b.ts), feed: 'inline' };
    case 'telemetry_csv': {
      if (!ctx.sources.fetchText) {
        throw new Error('This engine target cannot fetch CSV inputs (no fetchText seam)');
      }
      const text = await ctx.sources.fetchText({ bucket: binding.bucket ?? null, key: binding.s3Key });
      const { samples, skippedCells } = parseTelemetryCsv(text, binding.metrics);
      if (skippedCells > 0) ctx.log(`CSV: skipped ${skippedCells} non-numeric cell(s)`);
      return { samples, feed: 'csv' };
    }
    case 'telemetry_materialized': {
      if (!ctx.sources.fetchText) {
        throw new Error('This engine target cannot fetch materialized inputs (no fetchText seam)');
      }
      const text = await ctx.sources.fetchText({ bucket: binding.bucket ?? null, key: binding.s3Key });
      return { samples: parseTelemetryJsonl(text), feed: 'materialized history' };
    }
    case 'telemetry_history': {
      const metrics = binding.metrics ?? cfg.metrics;
      const window = binding.window
        ? { fromMs: Date.parse(binding.window.from), toMs: Date.parse(binding.window.to) }
        : ctx.window;
      if (!ctx.deviceId) throw new Error('History telemetry needs a device on the run');
      if (!window || Number.isNaN(window.fromMs) || Number.isNaN(window.toMs)) {
        throw new Error('History telemetry needs a data window on the run or binding');
      }
      const samples = await ctx.sources.readTelemetryWindow({ deviceId: ctx.deviceId, metrics, window });
      return { samples, feed: 'history' };
    }
  }
}

export const executor = async function* sourceTelemetry(
  _inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
) {
  const cfg = configSchema.parse(config);
  const { samples, feed } = await readSamples(cfg, ctx);
  ctx.setSummary(`${samples.length} samples (${feed}: ${cfg.metrics.join(', ')})`);
  for (const sample of samples) {
    yield { ch: 'telemetry' as const, ts: sample.ts, payload: { signals: sample.signals } };
  }
};
