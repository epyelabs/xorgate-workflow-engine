import { z } from 'zod';
import { inputsForPort, mergeByTs } from '../../engine/helpers';
import type { ConditionPayload, EngineInChannel, EngineRunCtx } from '../types';
import { defineNode } from '../types';

const configSchema = z.object({
  op: z.enum(['and', 'or', 'not']).default('and'),
});

export const def = defineNode({
  type: 'logic.boolean',
  version: 1,
  group: 'logic',
  label: 'Boolean Combine',
  description: 'Combines several conditions with AND / OR / NOT.',
  ui: { icon: 'git-merge' },
  inputs: [
    { id: 'conditions', label: 'Conditions', channel: 'condition', cardinality: 'many', required: true },
  ],
  outputs: [
    { id: 'condition', label: 'Condition', channel: 'condition', cardinality: 'many', required: false },
  ],
  config: configSchema,
  requires: [],
  runtime: { target: 'any' },
});

// Inputs are merged by ts; each connection holds its latest value (false until
// first seen) and every incoming message emits the recombined result at its ts.
// NOT expects exactly one input and negates message-for-message.
export const executor = async function* logicBoolean(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
) {
  const cfg = configSchema.parse(config);
  const connections = inputsForPort(inputs, 'conditions');
  if (cfg.op === 'not' && connections.length !== 1) {
    throw new Error(`NOT takes exactly one input (got ${connections.length})`);
  }
  const held = connections.map(() => false);
  let emitted = 0;
  let trueCount = 0;
  for await (const { index, msg } of mergeByTs(connections)) {
    if (msg.ch !== 'condition') continue;
    const payload = msg.payload as ConditionPayload;
    held[index] = Boolean(payload.value);
    const value =
      cfg.op === 'not' ? !held[0] : cfg.op === 'and' ? held.every(Boolean) : held.some(Boolean);
    emitted += 1;
    if (value) trueCount += 1;
    yield {
      ch: 'condition' as const,
      ts: msg.ts,
      payload: { value, meta: { op: cfg.op, inputs: [...held], last: payload.meta } },
    };
  }
  ctx.setSummary(`${cfg.op} over ${connections.length} inputs, true on ${trueCount}/${emitted}`);
};
