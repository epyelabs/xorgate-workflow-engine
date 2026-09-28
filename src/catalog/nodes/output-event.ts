import { z } from 'zod';
import { requireInput } from '../../engine/helpers';
import type { ConditionPayload, EngineEmit, EngineInChannel, EngineRunCtx } from '../types';
import { defineNode } from '../types';

// Collects a workflow event on each rising edge of the input condition; the
// finalize path persists them as workflow_events rows. The engine stamps each
// event with this node's id; `webhook` names the endpoint the platform (or
// `xwe run --webhook <name>=<url>` locally) delivers it to. The executor never
// reads `webhook`: delivery is the host's job.

const configSchema = z.object({
  kind: z.string().min(1).default('detection').describe('Event kind, e.g. harsh_brake'),
  attachClip: z.boolean().default(false).describe('Attach an evidence clip when video is in the graph'),
  cooldownSeconds: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Minimum spacing between emitted events'),
  webhook: z
    .string()
    .min(1)
    .optional()
    .describe('Endpoint name to deliver each event to (bound per org on the platform, or with --webhook locally)'),
});

export const def = defineNode({
  type: 'output.event',
  version: 1,
  group: 'output',
  label: 'Emit Event',
  description: 'Publishes a detection event when the input condition turns true.',
  ui: { icon: 'zap' },
  inputs: [
    { id: 'condition', label: 'Condition', channel: 'condition', cardinality: 'one', required: true },
  ],
  outputs: [],
  config: configSchema,
  requires: [],
  runtime: { target: 'any' },
});

export const executor = async function* outputEvent(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
): AsyncIterable<EngineEmit> {
  const cfg = configSchema.parse(config);
  let prev = false;
  let lastEmittedTs = -Infinity;
  let count = 0;
  for await (const msg of requireInput(inputs, 'condition').messages) {
    if (msg.ch !== 'condition') continue;
    const payload = msg.payload as ConditionPayload;
    const value = Boolean(payload.value);
    const rising = value && !prev;
    prev = value;
    if (!rising) continue;
    if (msg.ts - lastEmittedTs < cfg.cooldownSeconds * 1000) continue;
    lastEmittedTs = msg.ts;
    count += 1;
    const observed = payload.meta?.observed;
    ctx.emitEvent({
      kind: cfg.kind,
      occurredAt: new Date(msg.ts).toISOString(),
      confidence: 1,
      payloadSummary:
        typeof observed === 'number'
          ? `${cfg.kind} · observed ${Number(observed.toFixed(3))}`
          : cfg.kind,
      payload: payload.meta ?? null,
    });
  }
  ctx.setSummary(`emitted ${count} event(s)`);
};
