import type { WorkflowDefinition } from '../schemas/workflows';
import { coreCatalog } from '../catalog/index';
import type { Catalog } from '../catalog/pack';
import type {
  EngineArtifactSink,
  EngineEventRecord,
  EngineInChannel,
  EngineMessage,
  EngineMode,
  EngineProgressSink,
  EngineRunCtx,
  EngineSecretReader,
  EngineSourceBinding,
  EngineSourceReader,
  NodeTypeDef,
} from '../catalog/types';
import { resolvePort } from '../validate';
import { BoundedChannel } from './channel';
import type { ChannelPolicy } from './channel';
import type { MessageLevel } from './log';
import { createRedactor } from './redact';

/**
 * The streaming graph engine core (architecture.md §4.1). One process per run:
 * every node's executor starts concurrently and every edge is an in-process
 * channel. The channel policy depends on the run mode and the edge's channel:
 *
 * - `live`: frames edges drop oldest (latest wins), every other edge blocks
 *   at `channelCapacity` (default 32).
 * - `batch` / `simulation` (0.5.1, `channelMode: 'elastic'`, the default):
 *   `frames` and `video` edges block at `channelCapacity`; every other edge is
 *   unbounded, so a producer never waits on a consumer. The source already
 *   holds its whole window in memory, so bounding those edges only paced the
 *   graph, and it deadlocked fan-out graphs whose merge waited on a silent
 *   branch (a connector with no answer, a lookup cap).
 * - `channelMode: 'bounded'` restores the pre-0.5.1 batch behaviour (every
 *   non-live edge blocks), for backpressure tests.
 *
 * A stall detector (`stallMs`, default 30 s) fails a run whose running nodes
 * are all parked on channel operations with no progress for that long, and
 * names who waits on whom. A deadline or a stall marks still-running nodes
 * `cancelled` (with the reason) rather than `skipped`.
 *
 * Storage-free by design: sources read through the EngineSourceReader seam,
 * outputs collect through ctx callbacks, and the deploy target (Lambda handler,
 * Fargate main, test script) turns the returned outcome into S3 artifacts.
 *
 * Failure semantics match the PoC runner: a throwing executor fails its step,
 * every reachable descendant is skipped, independent branches run to
 * completion, and the run is failed with the first failure's node id.
 */

export const DEFAULT_CHANNEL_CAPACITY = 32;
/** No channel progress for this long, with every running node parked on a channel, fails the run. */
export const DEFAULT_STALL_MS = 30_000;
/** How often the stall detector samples the graph (shorter when `stallMs` is shorter). */
export const STALL_CHECK_INTERVAL_MS = 2_000;

/** Per-edge channel statistics, reported in the debug log and on the in-memory outcome. */
export interface EngineChannelStat {
  edgeId: string;
  source: string;
  target: string;
  channel: string;
  policy: ChannelPolicy;
  /** Infinity for `unbounded` edges. */
  capacity: number;
  maxDepth: number;
}

export interface EngineGraphSpec {
  runId: string;
  mode: EngineMode;
  deviceId: string | null;
  window: { fromMs: number; toMs: number } | null;
  /** schemaVersion 2 definition; callers upgrade v1 first (workflows/compat.ts). */
  definition: WorkflowDefinition;
  /** nodeId -> manifest input binding (source nodes). */
  bindings: Record<string, EngineSourceBinding>;
}

export interface EngineRunDeps {
  sources: EngineSourceReader;
  /** Binary-artifact sink (visualization JPEGs); omit on media-less targets. */
  artifacts?: EngineArtifactSink;
  /** Secret access for connector executors; omit on targets without it. */
  secrets?: EngineSecretReader;
  /** HTTP layer for connector executors (default: global fetch). */
  httpFetch?: typeof fetch;
  /**
   * Live progress sink (M3 simulator). The core reports step completions,
   * events, and json-channel messages as they happen; the target owns the
   * transport (IoT topics) and run-status transitions.
   */
  progress?: EngineProgressSink;
  /** Capacity of every bounded channel (default 32). */
  channelCapacity?: number;
  /**
   * Channel policy for `batch` and `simulation` runs (0.5.1). `elastic`
   * (default): non-frames/video edges are unbounded, frames and video edges
   * block at `channelCapacity`. `bounded`: every edge blocks at
   * `channelCapacity`, the pre-0.5.1 behaviour. `live` runs ignore it.
   */
  channelMode?: 'elastic' | 'bounded';
  /**
   * Stall detector (0.5.1): when no channel has moved for this long and every
   * still-running node is parked on a channel (taking from an empty one or
   * pushing to a full one), the run fails with an error naming the waits.
   * Default 30000; 0 disables it.
   */
  stallMs?: number;
  /** Wall-clock budget; on expiry everything is cancelled and the run fails. */
  deadlineMs?: number;
  /**
   * Diagnostics with their level: `info` for executors' `ctx.log` lines and
   * the deadline notice, `debug` for the engine's own trace (graph wiring,
   * per-node timings). A one-argument function still works; it sees `info`
   * and `debug` alike. Every message is scrubbed of secret values first.
   */
  log?: (message: string, level: MessageLevel) => void;
  /** The node registry to run against (default: the core catalog). */
  catalog?: Catalog;
  /**
   * Values known to be secret before the run starts (0.5.0: webhook signing
   * secrets), scrubbed like values read through the secrets seam.
   */
  redact?: string[];
}

export interface EngineStep {
  seq: number;
  nodeId: string;
  label: string;
  /** `cancelled` (0.5.1): still running when the deadline or the stall detector stopped the run. */
  status: 'ok' | 'failed' | 'skipped' | 'cancelled';
  output: string;
  durationMs: number;
}

export interface EngineRunOutcome {
  status: 'succeeded' | 'failed';
  error: string | null;
  failedNodeId: string | null;
  steps: EngineStep[];
  events: EngineEventRecord[];
  /** nodeId -> records collected via ctx.captureRecord (output.data_capture). */
  captures: Record<string, unknown[]>;
  metrics: { nodes: number; okSteps: number; events: number; messages: number };
  /**
   * Per-edge channel statistics (0.5.1). In memory only: `result.json` does
   * not carry them (buildEngineResult picks its fields).
   */
  channels?: EngineChannelStat[];
}

interface NodeState {
  status: 'running' | 'ok' | 'failed' | 'skipped' | 'cancelled';
  aborted: boolean;
  /** Set when the deadline or the stall detector stopped this node while it ran. */
  cancelReason: string | null;
  error: string | null;
  summary: string | null;
  emitted: number;
  durationMs: number;
}

// Kahn topological sort; null on a cycle.
function topoSort(def: WorkflowDefinition): string[] | null {
  const indegree = new Map<string, number>(def.nodes.map((n) => [n.id, 0]));
  const adjacency = new Map<string, string[]>(def.nodes.map((n) => [n.id, []]));
  for (const e of def.edges) {
    if (!indegree.has(e.target) || !adjacency.has(e.source)) continue;
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
    adjacency.get(e.source)!.push(e.target);
  }
  const queue = def.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  return order.length === def.nodes.length ? order : null;
}

function descendantsOf(def: WorkflowDefinition, from: string): Set<string> {
  const out = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const e of def.edges) {
      if (e.source === id && !out.has(e.target)) {
        out.add(e.target);
        stack.push(e.target);
      }
    }
  }
  return out;
}

function failedOutcome(spec: EngineGraphSpec, failedNodeId: string | null, error: string): EngineRunOutcome {
  return {
    status: 'failed',
    error,
    failedNodeId,
    steps: [],
    events: [],
    captures: {},
    metrics: { nodes: spec.definition.nodes.length, okSteps: 0, events: 0, messages: 0 },
  };
}

export async function runGraph(spec: EngineGraphSpec, deps: EngineRunDeps): Promise<EngineRunOutcome> {
  const def = spec.definition;
  // Secret hygiene: values read through the secrets seam are scrubbed from
  // every string that leaves this function (summaries, errors, events,
  // captures, progress messages, log lines). See ./redact.ts.
  const redactor = createRedactor(deps.redact ?? []);
  const rawLog = deps.log ?? ((m: string) => console.log(`engine[${spec.runId}]: ${m}`));
  const log = (m: string, level: MessageLevel = 'info'): void => rawLog(redactor.text(m), level);
  const secrets = deps.secrets ? redactor.wrapSecrets(deps.secrets) : undefined;
  const progress = deps.progress ? redactor.wrapProgress(deps.progress) : undefined;
  const capacity = deps.channelCapacity ?? DEFAULT_CHANNEL_CAPACITY;
  const channelMode = deps.channelMode ?? 'elastic';
  const stallMs = deps.stallMs ?? DEFAULT_STALL_MS;
  const catalog = deps.catalog ?? coreCatalog;

  // Pre-flight structural guards (published definitions already pass these;
  // fail like the PoC runner did, with no steps).
  const typeByNode = new Map<string, NodeTypeDef>();
  for (const node of def.nodes) {
    const typeDef = catalog.getNodeType(node.type);
    if (!typeDef) return failedOutcome(spec, node.id, `Unknown node type "${node.type}"`);
    typeByNode.set(node.id, typeDef);
  }
  const order = topoSort(def);
  if (!order) return failedOutcome(spec, null, 'Workflow graph contains a cycle');
  log(`graph: ${def.nodes.length} node(s), ${def.edges.length} edge(s), order ${order.join(' -> ')}`, 'debug');

  const nodesById = new Map(def.nodes.map((n) => [n.id, n]));
  const orderIndex = new Map(order.map((id, i) => [id, i]));

  // Wire one channel per edge; the policy follows the mode and channel type
  // (see the module comment).
  const policyFor = (channelType: string): ChannelPolicy => {
    if (spec.mode === 'live') return channelType === 'frames' ? 'drop-oldest' : 'block';
    if (channelMode === 'bounded') return 'block';
    return channelType === 'frames' || channelType === 'video' ? 'block' : 'unbounded';
  };
  const edgeChannels: Array<{
    edgeId: string;
    source: string;
    target: string;
    targetPort: string;
    channelType: string;
    channel: BoundedChannel<EngineMessage>;
  }> = [];
  const inChannelsByNode = new Map<string, Array<EngineInChannel & { channel: BoundedChannel<EngineMessage> }>>();
  const outChannelsByNode = new Map<string, Map<string, BoundedChannel<EngineMessage>[]>>();
  for (const node of def.nodes) {
    inChannelsByNode.set(node.id, []);
    outChannelsByNode.set(node.id, new Map());
  }
  for (const edge of def.edges) {
    const sourceDef = typeByNode.get(edge.source);
    const targetDef = typeByNode.get(edge.target);
    if (!sourceDef || !targetDef) {
      return failedOutcome(spec, null, `Edge "${edge.id}" references a missing node`);
    }
    const out = resolvePort(sourceDef.outputs, edge.sourceHandle);
    if (!out.port) {
      return failedOutcome(spec, edge.source, `Edge "${edge.id}": cannot resolve source port`);
    }
    const inp = resolvePort(targetDef.inputs, edge.targetHandle, out.port);
    if (!inp.port) {
      return failedOutcome(spec, edge.target, `Edge "${edge.id}": cannot resolve target port`);
    }
    const policy = policyFor(out.port.channel);
    const channel = new BoundedChannel<EngineMessage>(policy === 'unbounded' ? Infinity : capacity, policy);
    edgeChannels.push({
      edgeId: edge.id,
      source: edge.source,
      target: edge.target,
      targetPort: inp.port.id,
      channelType: out.port.channel,
      channel,
    });
    const outs = outChannelsByNode.get(edge.source)!;
    (outs.get(out.port.id) ?? outs.set(out.port.id, []).get(out.port.id)!).push(channel);
    inChannelsByNode.get(edge.target)!.push({
      port: inp.port.id,
      from: { nodeId: edge.source, port: out.port.id },
      messages: channel,
      channel,
    });
  }

  const states = new Map<string, NodeState>(
    def.nodes.map((n) => [
      n.id,
      { status: 'running', aborted: false, cancelReason: null, error: null, summary: null, emitted: 0, durationMs: 0 },
    ]),
  );
  const events: EngineEventRecord[] = [];
  const captures: Record<string, unknown[]> = {};
  let messagesTotal = 0;
  let firstFailure: { nodeId: string; error: string } | null = null;
  let timedOut = false;
  let stalledError: string | null = null;
  if (edgeChannels.length > 0) {
    const counts = new Map<string, number>();
    for (const e of edgeChannels) {
      const key = e.channel.policy === 'unbounded' ? 'unbounded' : `${e.channel.policy}@${capacity}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    log(
      `channels (${spec.mode}${spec.mode === 'live' ? '' : `, ${channelMode}`}): ` +
        [...counts].map(([k, n]) => `${n} ${k}`).join(', '),
      'debug',
    );
  }

  // One step row per node, used both for live progress (on node completion)
  // and the final outcome, so the two can never disagree.
  const stepFor = (nodeId: string): EngineStep => {
    const node = nodesById.get(nodeId)!;
    const state = states.get(nodeId)!;
    const status = state.status === 'running' ? 'skipped' : state.status;
    const output =
      status === 'failed'
        ? state.error ?? 'failed'
        : status === 'skipped'
          ? 'skipped (upstream failure)'
          : status === 'cancelled'
            ? `cancelled: ${state.cancelReason ?? 'run stopped'}` +
              (state.emitted > 0 ? ` (after ${state.emitted} message(s))` : '')
            : state.summary ?? `${state.emitted} message(s)`;
    return {
      seq: orderIndex.get(nodeId) ?? 0,
      nodeId,
      label: node.data.label,
      status,
      output,
      durationMs: state.durationMs,
    };
  };

  const cancelNodeChannels = (nodeId: string): void => {
    for (const input of inChannelsByNode.get(nodeId) ?? []) input.channel.cancel();
    for (const channels of outChannelsByNode.get(nodeId)?.values() ?? []) {
      for (const c of channels) c.cancel();
    }
  };

  // Skip the failed node's reachable descendants: flag them and cancel every
  // channel into them, so producers on other branches never block on a
  // consumer that will not read again.
  const skipDescendants = (failedNodeId: string): void => {
    for (const id of descendantsOf(def, failedNodeId)) {
      const state = states.get(id)!;
      if (state.status !== 'running') continue;
      state.aborted = true;
      for (const input of inChannelsByNode.get(id) ?? []) input.channel.cancel();
    }
  };

  // Route one yielded message: resolve the output port, stamp defaults, push to
  // every subscriber channel (awaiting all pushes = backpressure).
  const routeMessage = async (nodeId: string, typeDef: NodeTypeDef, msg: EngineMessage): Promise<void> => {
    let portId = msg.port;
    if (!portId) {
      if (typeDef.outputs.length === 1) portId = typeDef.outputs[0].id;
      else {
        const matching = typeDef.outputs.filter(
          (p) => p.channel === msg.ch && (msg.tag === undefined || p.tag === msg.tag),
        );
        if (matching.length !== 1) {
          throw new Error(
            `emitted a ${msg.ch} message without a port, and the port is ambiguous on "${typeDef.type}"`,
          );
        }
        portId = matching[0].id;
      }
    }
    const portDef = typeDef.outputs.find((p) => p.id === portId);
    if (!portDef) throw new Error(`emitted on unknown output port "${portId}"`);
    if (msg.tag === undefined && portDef.tag !== undefined) msg.tag = portDef.tag;
    // Tee json-channel messages (detections, speed limits) to the progress
    // sink so the simulator's client-side overlay gets them live. Fire-and-
    // forget: the sink queues internally and must never slow the graph.
    if (msg.ch === 'json' && progress?.record) {
      progress.record({ nodeId, port: portId, tag: msg.tag, ts: msg.ts, seq: msg.seq, payload: msg.payload });
    }
    const channels = outChannelsByNode.get(nodeId)?.get(portId);
    if (!channels || channels.length === 0) return; // unconnected output: drop
    await Promise.all(channels.map((c) => c.push(msg)));
  };

  const runNode = async (nodeId: string): Promise<void> => {
    const node = nodesById.get(nodeId)!;
    const typeDef = typeByNode.get(nodeId)!;
    const state = states.get(nodeId)!;
    const inputs = inChannelsByNode.get(nodeId)!;
    const started = Date.now();
    let seq = 0;
    let recordSeq = 0;
    try {
      const parsedConfig = typeDef.config.safeParse(node.data.config ?? {});
      if (!parsedConfig.success) {
        const issue = parsedConfig.error.issues[0];
        const at = issue?.path.length ? ` at "${issue.path.join('.')}"` : '';
        throw new Error(`Invalid config${at}: ${issue?.message ?? 'parse failed'}`);
      }
      const executor = catalog.getExecutor(node.type);
      if (!executor) throw new Error(`No executor registered for "${node.type}"`);

      const ctx: EngineRunCtx = {
        runId: spec.runId,
        mode: spec.mode,
        deviceId: spec.deviceId,
        window: spec.window,
        nodeId,
        binding: spec.bindings[nodeId] ?? null,
        sources: deps.sources,
        artifacts: deps.artifacts ?? null,
        emitEvent: (input) => {
          if (!state.aborted) {
            const event: EngineEventRecord = { ...input, nodeId };
            events.push(event);
            progress?.event(event);
          }
        },
        captureRecord: (record) => {
          if (!state.aborted) (captures[nodeId] ??= []).push(record);
        },
        setSummary: (summary) => {
          state.summary = summary;
        },
        secrets: secrets ?? null,
        http: deps.httpFetch ?? fetch,
        log: (message, level = 'info') => log(`${nodeId}: ${message}`, level),
        emitRecord: (rec) => {
          if (state.aborted || !progress?.record) return;
          progress.record({ nodeId, port: rec.port, tag: rec.tag, ts: rec.ts, seq: recordSeq++, payload: rec.payload });
        },
      };

      const iterator = executor(inputs, parsedConfig.data, ctx)[Symbol.asyncIterator]();
      for (;;) {
        if (state.aborted) {
          await iterator.return?.(undefined);
          break;
        }
        const result = await iterator.next();
        if (result.done) break;
        if (state.aborted) {
          await iterator.return?.(undefined);
          break;
        }
        const msg: EngineMessage = { ...result.value, seq: seq++ };
        state.emitted += 1;
        messagesTotal += 1;
        await routeMessage(nodeId, typeDef, msg);
      }
      state.status = state.cancelReason !== null ? 'cancelled' : state.aborted ? 'skipped' : 'ok';
    } catch (err) {
      if (state.cancelReason !== null) {
        state.status = 'cancelled';
      } else if (state.aborted) {
        state.status = 'skipped';
      } else {
        state.status = 'failed';
        state.error = err instanceof Error ? err.message : String(err);
        if (!firstFailure) firstFailure = { nodeId, error: state.error };
        skipDescendants(nodeId);
      }
    } finally {
      state.durationMs = Date.now() - started;
      // Unblock both sides: unread inputs would otherwise stall their
      // producers; consumers must see this node's outputs end.
      for (const input of inputs) input.channel.cancel();
      for (const channels of outChannelsByNode.get(nodeId)?.values() ?? []) {
        for (const c of channels) c.close();
      }
      log(`${nodeId}: ${state.status} in ${state.durationMs} ms, ${state.emitted} message(s)`, 'debug');
      progress?.step(stepFor(nodeId));
    }
  };

  // Wait state, read off the channels: a node parked in take() on an empty
  // channel waits on that edge's producer; a node parked in push() on a full
  // channel is blocked on that edge's consumer. A running node with neither
  // is busy in its own await (I/O, a model, a child process, a timer).
  // Each entry is the wait without its subject ("waiting on roads (0 queued)").
  const waitsByNode = (): Map<string, string[]> => {
    const waits = new Map<string, string[]>();
    const add = (nodeId: string, text: string): void => {
      (waits.get(nodeId) ?? waits.set(nodeId, []).get(nodeId)!).push(text);
    };
    for (const e of edgeChannels) {
      const c = e.channel;
      if (c.isClosed) continue;
      // Name the port only when the target has several edges from this source.
      const twin = edgeChannels.some((o) => o !== e && o.source === e.source && o.target === e.target);
      const from = twin ? `${e.source} (into ${e.targetPort})` : e.source;
      if (c.waitingTakers > 0) add(e.target, `waiting on ${from} (${c.depth} queued)`);
      if (c.waitingPutters > 0) {
        const cap = c.policy === 'unbounded' ? '' : `/${c.capacity}`;
        add(e.source, `blocked pushing to ${e.target} (${c.depth}${cap})`);
      }
    }
    return waits;
  };

  // Stop every still-running node: the deadline and the stall detector share
  // this. Nodes already skipped by an upstream failure stay skipped.
  const stopAll = (reasonFor: (nodeId: string, waits: string[] | undefined) => string): void => {
    const waits = waitsByNode();
    for (const node of def.nodes) {
      const state = states.get(node.id)!;
      if (state.status === 'running' && !state.aborted) {
        state.cancelReason = reasonFor(node.id, waits.get(node.id));
        state.aborted = true;
      }
    }
    for (const node of def.nodes) cancelNodeChannels(node.id);
  };

  let deadlineTimer: NodeJS.Timeout | undefined;
  if (deps.deadlineMs !== undefined) {
    deadlineTimer = setTimeout(() => {
      if (stalledError !== null) return;
      timedOut = true;
      stopAll(
        (_id, waits) =>
          `run exceeded its max runtime (${deps.deadlineMs} ms) while ${waits ? waits.join('; ') : 'busy'}`,
      );
      log(`deadline of ${deps.deadlineMs}ms exceeded; cancelling all nodes`);
    }, deps.deadlineMs);
  }

  // The stall detector: sample every few seconds; progress is any channel
  // operation, routed message, or node completion.
  let stallTimer: NodeJS.Timeout | undefined;
  if (stallMs > 0 && Number.isFinite(stallMs)) {
    let lastMark = -1;
    let lastProgressAt = Date.now();
    const checkEvery = Math.min(STALL_CHECK_INTERVAL_MS, Math.max(10, Math.floor(stallMs / 4)));
    // Deliberately not unref'd: a graph parked on promises alone would let
    // the process exit with no result; the detector keeps it alive to fail it.
    stallTimer = setInterval(() => {
      if (timedOut || stalledError !== null) return;
      let mark = messagesTotal;
      for (const e of edgeChannels) mark += e.channel.ops;
      for (const st of states.values()) if (st.status !== 'running') mark += 1;
      const now = Date.now();
      if (mark !== lastMark) {
        lastMark = mark;
        lastProgressAt = now;
        return;
      }
      if (now - lastProgressAt < stallMs) return;
      const running = order.filter((id) => {
        const st = states.get(id)!;
        return st.status === 'running' && !st.aborted;
      });
      if (running.length === 0) return;
      const waits = waitsByNode();
      if (!running.every((id) => (waits.get(id)?.length ?? 0) > 0)) return;
      const described = running.flatMap((id) => waits.get(id)!.map((w) => `${id} ${w}`));
      stalledError = `Graph stalled: ${described.join('; ')} (no progress for ${Math.round((now - lastProgressAt) / 1000)} s)`;
      log(stalledError);
      stopAll((_id, own) => `graph stalled while ${(own ?? ['busy']).join('; ')}`);
    }, checkEvery);
  }

  try {
    await Promise.all(def.nodes.map((n) => runNode(n.id)));
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (stallTimer !== undefined) clearInterval(stallTimer);
  }

  const channelStats: EngineChannelStat[] = edgeChannels.map((e) => ({
    edgeId: e.edgeId,
    source: e.source,
    target: e.target,
    channel: e.channelType,
    policy: e.channel.policy,
    capacity: e.channel.capacity,
    maxDepth: e.channel.maxDepth,
  }));
  for (const c of channelStats) {
    log(
      `channel ${c.edgeId} ${c.source} -> ${c.target} (${c.channel}, ${c.policy}${c.policy === 'unbounded' ? '' : `@${c.capacity}`}): maxDepth ${c.maxDepth}`,
      'debug',
    );
  }

  const steps: EngineStep[] = order.map((nodeId) => stepFor(nodeId));

  const okSteps = steps.filter((s) => s.status === 'ok').length;
  const failed = firstFailure as { nodeId: string; error: string } | null;
  const outcome: EngineRunOutcome = redactor.deep({
    status: failed || timedOut || stalledError !== null ? 'failed' : 'succeeded',
    error: failed ? failed.error : stalledError ?? (timedOut ? 'Run exceeded its max runtime' : null),
    failedNodeId: failed ? failed.nodeId : null,
    steps,
    events,
    captures,
    metrics: { nodes: def.nodes.length, okSteps, events: events.length, messages: messagesTotal },
  });
  // Numbers only (Infinity survives); kept out of the redactor's deep copy.
  outcome.channels = channelStats;
  return outcome;
}
