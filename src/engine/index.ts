import type { WorkflowDefinition } from '../schemas/workflows';
import { getExecutor, getNodeType } from '../catalog/index';
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

/**
 * The streaming graph engine core (architecture.md §4.1). One process per run:
 * every node's executor starts concurrently, edges are bounded in-process
 * channels (default depth 32), and a batch source therefore reads no faster
 * than its slowest consumer. In live mode, frames channels switch to
 * drop-oldest (latest wins) while telemetry/condition channels keep blocking.
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
  channelCapacity?: number;
  /** Wall-clock budget; on expiry everything is cancelled and the run fails. */
  deadlineMs?: number;
  log?: (message: string) => void;
}

export interface EngineStep {
  seq: number;
  nodeId: string;
  label: string;
  status: 'ok' | 'failed' | 'skipped';
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
}

interface NodeState {
  status: 'running' | 'ok' | 'failed' | 'skipped';
  aborted: boolean;
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
  const log = deps.log ?? ((m: string) => console.log(`engine[${spec.runId}]: ${m}`));
  const capacity = deps.channelCapacity ?? DEFAULT_CHANNEL_CAPACITY;

  // Pre-flight structural guards (published definitions already pass these;
  // fail like the PoC runner did, with no steps).
  const typeByNode = new Map<string, NodeTypeDef>();
  for (const node of def.nodes) {
    const typeDef = getNodeType(node.type);
    if (!typeDef) return failedOutcome(spec, node.id, `Unknown node type "${node.type}"`);
    typeByNode.set(node.id, typeDef);
  }
  const order = topoSort(def);
  if (!order) return failedOutcome(spec, null, 'Workflow graph contains a cycle');

  const nodesById = new Map(def.nodes.map((n) => [n.id, n]));
  const orderIndex = new Map(order.map((id, i) => [id, i]));

  // Wire one bounded channel per edge. Live-mode frames edges drop oldest.
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
    const policy = spec.mode === 'live' && out.port.channel === 'frames' ? 'drop-oldest' : 'block';
    const channel = new BoundedChannel<EngineMessage>(capacity, policy);
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
      { status: 'running', aborted: false, error: null, summary: null, emitted: 0, durationMs: 0 },
    ]),
  );
  const events: EngineEventRecord[] = [];
  const captures: Record<string, unknown[]> = {};
  let messagesTotal = 0;
  let firstFailure: { nodeId: string; error: string } | null = null;
  let timedOut = false;

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
    if (msg.ch === 'json' && deps.progress?.record) {
      deps.progress.record({ nodeId, port: portId, tag: msg.tag, ts: msg.ts, seq: msg.seq, payload: msg.payload });
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
    try {
      const parsedConfig = typeDef.config.safeParse(node.data.config ?? {});
      if (!parsedConfig.success) {
        const issue = parsedConfig.error.issues[0];
        const at = issue?.path.length ? ` at "${issue.path.join('.')}"` : '';
        throw new Error(`Invalid config${at}: ${issue?.message ?? 'parse failed'}`);
      }
      const executor = getExecutor(node.type);
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
        emitEvent: (event) => {
          if (!state.aborted) {
            events.push(event);
            deps.progress?.event(event);
          }
        },
        captureRecord: (record) => {
          if (!state.aborted) (captures[nodeId] ??= []).push(record);
        },
        setSummary: (summary) => {
          state.summary = summary;
        },
        secrets: deps.secrets ?? null,
        http: deps.httpFetch ?? fetch,
        log: (message) => log(`${nodeId}: ${message}`),
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
      state.status = state.aborted ? 'skipped' : 'ok';
    } catch (err) {
      if (state.aborted) {
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
      deps.progress?.step(stepFor(nodeId));
    }
  };

  let deadlineTimer: NodeJS.Timeout | undefined;
  if (deps.deadlineMs !== undefined) {
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      for (const node of def.nodes) {
        const state = states.get(node.id)!;
        if (state.status === 'running') state.aborted = true;
        cancelNodeChannels(node.id);
      }
      log(`deadline of ${deps.deadlineMs}ms exceeded; cancelling all nodes`);
    }, deps.deadlineMs);
  }

  try {
    await Promise.all(def.nodes.map((n) => runNode(n.id)));
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }

  const steps: EngineStep[] = order.map((nodeId) => stepFor(nodeId));

  const okSteps = steps.filter((s) => s.status === 'ok').length;
  const failed = firstFailure as { nodeId: string; error: string } | null;
  return {
    status: failed || timedOut ? 'failed' : 'succeeded',
    error: failed ? failed.error : timedOut ? 'Run exceeded its max runtime' : null,
    failedNodeId: failed ? failed.nodeId : null,
    steps,
    events,
    captures,
    metrics: { nodes: def.nodes.length, okSteps, events: events.length, messages: messagesTotal },
  };
}
