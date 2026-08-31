import { z } from 'zod';
import { inputsForPort, mergeByTs } from '../../engine/helpers';
import type { EngineEmit, EngineInChannel, EngineRunCtx } from '../types';
import { defineNode } from '../types';

// "Data Capture" (open_questions.md Q3): captures whatever records flow in as a
// downloadable artifact (outputs/<nodeId>/records.jsonl in the v2 S3 layout).

const configSchema = z.object({
  format: z.enum(['jsonl', 'json']).default('jsonl'),
});

export const def = defineNode({
  type: 'output.data_capture',
  version: 1,
  group: 'output',
  label: 'Data Capture',
  description: 'Captures incoming records as a downloadable artifact.',
  ui: { icon: 'database' },
  inputs: [
    { id: 'records', label: 'Records', channel: 'json', cardinality: 'many', required: true },
  ],
  outputs: [],
  config: configSchema,
  requires: [],
  runtime: { target: 'any' },
});

// Each captured line is { ts, tag, record } so multi-input captures stay
// distinguishable; the engine target writes them to records.jsonl (or a
// records.json array when format=json).
export const executor = async function* outputDataCapture(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
): AsyncIterable<EngineEmit> {
  configSchema.parse(config); // format is consumed by the artifact writer
  let count = 0;
  for await (const { msg } of mergeByTs(inputsForPort(inputs, 'records'))) {
    if (msg.ch !== 'json') continue;
    count += 1;
    ctx.captureRecord({ ts: msg.ts, tag: msg.tag ?? null, record: msg.payload });
  }
  ctx.setSummary(`captured ${count} record(s)`);
};
