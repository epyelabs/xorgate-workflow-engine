import type {
  EngineInChannel,
  EngineMessage,
  TelemetryPayload,
  TelemetrySample,
} from '../catalog/types';

/**
 * Shared iteration helpers for node executors. This module may import only
 * catalog/types (node modules import it; the registry imports the node
 * modules; the engine core imports the registry).
 */

/** The single connection on input port `port`; throws when absent. */
export function requireInput(inputs: EngineInChannel[], port: string): EngineInChannel {
  const input = inputs.find((i) => i.port === port);
  if (!input) throw new Error(`Required input "${port}" is not connected`);
  return input;
}

/** All connections on input port `port` (cardinality "many" ports). */
export function inputsForPort(inputs: EngineInChannel[], port: string): EngineInChannel[] {
  return inputs.filter((i) => i.port === port);
}

/** Telemetry samples off one connection (non-telemetry messages are skipped). */
export async function* telemetrySamples(input: EngineInChannel): AsyncIterable<TelemetrySample> {
  for await (const msg of input.messages) {
    if (msg.ch !== 'telemetry') continue;
    const payload = msg.payload as TelemetryPayload;
    if (!payload || typeof payload.signals !== 'object') continue;
    yield { ts: msg.ts, signals: payload.signals };
  }
}

export interface MergedMessage {
  /** Index into the `inputs` array the message arrived on. */
  index: number;
  input: EngineInChannel;
  msg: EngineMessage;
}

/**
 * K-way merge of several connections, ordered by message `ts` (ties resolve by
 * input order). Assumes each connection is individually ts-ordered, which every
 * batch executor in this engine preserves. Pulls lazily, one message ahead per
 * input, so bounded-channel backpressure still applies.
 */
export async function* mergeByTs(inputs: EngineInChannel[]): AsyncIterable<MergedMessage> {
  const iterators = inputs.map((input) => input.messages[Symbol.asyncIterator]());
  const heads: Array<EngineMessage | null> = await Promise.all(
    iterators.map(async (it) => {
      const r = await it.next();
      return r.done ? null : r.value;
    }),
  );
  for (;;) {
    let best = -1;
    for (let i = 0; i < heads.length; i++) {
      const head = heads[i];
      if (head && (best === -1 || head.ts < heads[best]!.ts)) best = i;
    }
    if (best === -1) return;
    const msg = heads[best]!;
    const r = await iterators[best].next();
    heads[best] = r.done ? null : r.value;
    yield { index: best, input: inputs[best], msg };
  }
}

/**
 * Resolves the signal an executor should operate on: the configured one, else
 * the sample's only signal. Throws on ambiguity so misconfiguration fails the
 * node instead of silently picking a signal.
 */
export function resolveSignal(
  configured: string | undefined,
  signals: Record<string, number>,
  nodeLabel: string,
): string | null {
  if (configured) return configured in signals ? configured : null;
  const keys = Object.keys(signals);
  if (keys.length === 1) return keys[0];
  if (keys.length === 0) return null;
  throw new Error(
    `${nodeLabel}: input carries ${keys.length} signals (${keys.join(', ')}); set "signal" in the node config`,
  );
}
