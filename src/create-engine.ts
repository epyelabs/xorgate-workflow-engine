import { readFileSync } from 'node:fs';
import { coreCatalog, corePacks } from './catalog/index';
import { createCatalog, type Catalog, type NodePack } from './catalog/pack';
import type { EngineSecretReader, EngineSourceBinding } from './catalog/types';
import { runGraph, type EngineRunOutcome } from './engine/index';
import { createLogger, isLogLevel, LOG_LEVELS, type LogLevel, type LogSink } from './engine/log';
import { createRedactor } from './engine/redact';
import { runManifestSchema, type EngineResult, type RunManifest } from './engine/manifest';
import { upgradeDefinition } from './compat';
import type { EngineHost } from './host';
import { buildLocalManifest, loadDefinition, parseTemplate } from './local/manifest-builder';
import { captureFormatsOf } from './local/capture-formats';
import { objectProgress, teeProgress, type EngineProgressMessage } from './local/target';
import {
  localWebhookSink,
  resolveWebhookBindings,
  webhookEnvVar,
  webhookRefsOf,
  type EngineWebhookOptions,
  type LocalWebhookSink,
} from './local/webhooks';
import {
  FunctionLoadError,
  FunctionProcess,
  joinTrace,
  type FunctionEvent,
  type FunctionLanguage,
} from './engine/function-runtime';
import { resolveFunctionCode, type FunctionConfig } from './catalog/nodes/function-common';

/**
 * The high-level library entry: files (or objects) in, an artifact tree out,
 * through whatever host is given. `xwe run` is this function plus argument
 * parsing; the two share one code path by construction.
 */

/**
 * Thrown (as a rejection) for errors that prevented anything from running: a
 * template that does not parse, an input key that binds no source, a missing
 * file. The CLI maps it to exit code 2. A run that started and failed is not
 * an error: it resolves with `result.status === "failed"`.
 */
export type { EngineWebhookOptions } from './local/webhooks';

export class XweUsageError extends Error {
  readonly exitCode = 2;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'XweUsageError';
  }
}

export interface CreateEngineOptions {
  host: EngineHost;
  /**
   * The catalog to run against, from `createCatalog([...corePacks, ...])`.
   * Default: the core catalog. Exclusive with `packs`.
   */
  catalog?: Catalog;
  /** Shorthand for `createCatalog([...corePacks, ...packs])`: the core plus these. */
  packs?: ReadonlyArray<NodePack>;
  /**
   * Engine diagnostics. A level (`silent` | `error` | `info` | `debug`)
   * writes `[engine] ...` lines on stderr up to that level; a function
   * receives every message with its level and filters itself. A
   * one-argument callback still works. Default: silent.
   */
  log?: LogLevel | LogSink;
}

export interface EngineRunOptions {
  /** A template path, or a parsed template (bare definition or API snapshot). */
  template?: string | Record<string, unknown>;
  /** A run manifest path, or a parsed run manifest. Exclusive with `template`. */
  manifest?: string | Record<string, unknown>;
  /** Source bindings by key (`video`, `telemetry`, or a node id) to a file path. */
  inputs?: Record<string, string>;
  /** Default `local-<epoch ms>`; also the output directory name. */
  runId?: string;
  /** ISO-8601 run window; file bindings carry their own timestamps. */
  window?: { from: string; to: string } | null;
  /** Logical name to value; wins over the host's secrets and the environment. */
  secrets?: Record<string, string>;
  /** After a successful run, mux each visualization node's frames into an MP4. */
  emitVideo?: boolean;
  /** Receives the same messages `--progress json` prints, as objects. */
  progress?: (message: EngineProgressMessage) => void;
  /** Wall-clock budget; on expiry everything is cancelled and the run fails. */
  deadlineMs?: number;
  /**
   * Local webhook delivery (0.5.0): binds the `webhook` names on the graph's
   * `output.event` nodes to URLs (and optional `whsec_` signing secrets).
   * `XWE_WEBHOOK_<NAME>` / `XWE_WEBHOOK_SECRET_<NAME>` in `env` (default
   * `process.env`) fill names the options leave unbound. Best-effort: one
   * POST per event, no retry. Unbound names are logged once and skipped.
   */
  webhooks?: EngineWebhookOptions;
}

export interface EngineRunResult {
  /** The parsed `result.json`. */
  result: EngineResult;
  /** The directory (or locator) the artifact tree was written to. */
  runDir: string;
  /** The engine's in-memory outcome: steps, events, captured records. */
  outcome: EngineRunOutcome;
}

/** One event for `engine.testFunction`: what a producer would have put on the wire. */
export interface FunctionTestEvent {
  /** The producer's tag (`detections`, `result`, ...). Default `event`. */
  tag?: string;
  /** Epoch milliseconds. Default: now. */
  ts?: number;
  seq?: number;
  payload: unknown;
}

export interface TestFunctionOptions {
  /** A template path, or a parsed template (bare definition or API snapshot). */
  template: string | Record<string, unknown>;
  /** The function node to test. */
  nodeId: string;
  /** The event: a path to a JSON file, or the object. */
  event: string | FunctionTestEvent;
  /** A published snapshot to run instead of the working copy (`--version n`). */
  version?: number;
  /** What `context.runId` says. Default `test-<epoch ms>`. */
  runId?: string;
}

export interface FunctionTestResult {
  /** The handler returned (or dropped the event) within `timeoutMs`. */
  ok: boolean;
  /** The return value; `null` when the handler dropped the event. Absent on failure. */
  result?: unknown;
  /** The error and its trace (one frame per line) when the handler threw, timed out or failed to load. */
  error?: string;
  /** Every `context.log` line of the invocation, in order. */
  logs: string[];
  durationMs: number;
  functionVersion: '$LATEST' | number;
  nodeId: string;
  /** `function.javascript` or `function.python`. */
  type: string;
  language: FunctionLanguage;
  /** What ran it: `node 20.20.2`, `python 3.11.2`; empty when the code failed to load. */
  runtime: string;
}

export interface Engine {
  readonly host: EngineHost;
  /** The catalog every run of this engine validates and executes against. */
  readonly catalog: Catalog;
  run(options: EngineRunOptions): Promise<EngineRunResult>;
  /**
   * Runs one event through a function node in the same sandboxed runtime a
   * run would use (`xwe function test`). Resolves for a handler that threw
   * or timed out (`ok: false`); rejects with `XweUsageError` when the
   * template, the node id, the version or the event is wrong and nothing ran.
   */
  testFunction(options: TestFunctionOptions): Promise<FunctionTestResult>;
}

const FUNCTION_TYPES: Record<string, FunctionLanguage> = {
  'function.javascript': 'javascript',
  'function.python': 'python',
};

function readTestEvent(event: TestFunctionOptions['event']): FunctionEvent {
  const raw = typeof event === 'string' ? readJsonFile(event, 'event') : event;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new XweUsageError('event must be a JSON object: { "tag"?, "ts"?, "seq"?, "payload" }');
  }
  const obj = raw as Record<string, unknown>;
  if (!('payload' in obj)) throw new XweUsageError('event needs a "payload" (the record the handler receives)');
  if (obj.tag !== undefined && typeof obj.tag !== 'string') throw new XweUsageError('event.tag must be a string');
  if (obj.ts !== undefined && typeof obj.ts !== 'number') throw new XweUsageError('event.ts must be epoch milliseconds');
  if (obj.seq !== undefined && typeof obj.seq !== 'number') throw new XweUsageError('event.seq must be a number');
  return {
    tag: (obj.tag as string | undefined) ?? 'event',
    ts: (obj.ts as number | undefined) ?? Date.now(),
    seq: (obj.seq as number | undefined) ?? 0,
    payload: obj.payload,
  };
}

function usage(err: unknown): never {
  if (err instanceof XweUsageError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  throw new XweUsageError(message, { cause: err });
}

function readJsonFile(file: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new XweUsageError(`${what} ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new XweUsageError(`${what} ${file} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** template | manifest -> a v2 run manifest; every failure is a usage error. `catalog` defaults to core. */
export function resolveRunManifest(options: EngineRunOptions, catalog: Catalog = coreCatalog): RunManifest {
  if (options.template !== undefined && options.manifest !== undefined) {
    throw new XweUsageError('run takes a template or a manifest, not both');
  }
  if (options.manifest !== undefined) {
    const raw =
      typeof options.manifest === 'string'
        ? readJsonFile(options.manifest, 'manifest')
        : options.manifest;
    const parsed = runManifestSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new XweUsageError(
        `manifest is not a v2 run manifest: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'parse failed'}`,
      );
    }
    return { ...parsed.data, definition: upgradeDefinition(parsed.data.definition) };
  }
  if (options.template !== undefined) {
    try {
      const definition =
        typeof options.template === 'string'
          ? loadDefinition(options.template)
          : parseTemplate(options.template);
      return buildLocalManifest({
        definition,
        inputs: options.inputs ?? {},
        runId: options.runId ?? `local-${Date.now()}`,
        window: options.window ?? null,
        catalog,
      });
    } catch (err) {
      return usage(err);
    }
  }
  throw new XweUsageError('run needs a template or a manifest');
}

/** Run-level `secrets` win over the host's reader; without a host reader they are all there is. */
function withSecretOverrides(
  inner: EngineSecretReader | undefined,
  overrides: Record<string, string> | undefined,
): EngineSecretReader | undefined {
  if (!overrides || Object.keys(overrides).length === 0) return inner;
  return {
    async getSecret(logicalName: string): Promise<string> {
      const value = overrides[logicalName];
      if (value) return value;
      if (inner) return inner.getSecret(logicalName);
      throw new Error(`Secret "${logicalName}" is not configured: pass it in run({ secrets })`);
    },
  };
}

/**
 * The run's webhook sink, or null when the graph names no webhook. Throws a
 * usage error (naming the webhook, never the value) on a URL or secret that
 * breaks the policy; logs each unbound name once.
 */
function bindWebhooks(
  manifest: RunManifest,
  runId: string,
  options: EngineWebhookOptions | undefined,
  log: (message: string) => void,
): { sink: LocalWebhookSink; secrets: string[] } | null {
  const refs = webhookRefsOf(manifest.definition);
  if (refs.length === 0) return null;
  let resolved;
  try {
    resolved = resolveWebhookBindings(refs, options ?? {});
  } catch (err) {
    return usage(err);
  }
  for (const ref of resolved.unbound) {
    log(
      `warning: webhook "${ref.name}" (node ${ref.nodeIds.join(', ')}) is not bound; its events are not delivered (--webhook ${ref.name}=<url> or ${webhookEnvVar(ref.name)})`,
    );
  }
  if (resolved.bound.length === 0) return null;
  const routes = new Map<string, string>();
  for (const ref of refs) for (const id of ref.nodeIds) routes.set(id, ref.name);
  for (const b of resolved.bound) {
    log(`webhook "${b.name}" -> ${new URL(b.url).origin} (${b.secret ? 'signed' : 'unsigned'}, best-effort)`);
  }
  return {
    sink: localWebhookSink({
      routes,
      bindings: new Map(resolved.bound.map((b) => [b.name, b])),
      runId,
      deviceId: manifest.deviceId,
      ...(options?.fetch ? { fetch: options.fetch } : {}),
      ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      log,
    }),
    secrets: resolved.bound.flatMap((b) => (b.secret ? [b.secret] : [])),
  };
}

export function createEngine(options: CreateEngineOptions): Engine {
  if (!options || !options.host || typeof options.host.bind !== 'function') {
    throw new XweUsageError('createEngine needs a host: createEngine({ host: localHost({ ... }) })');
  }
  if (options.catalog !== undefined && options.packs !== undefined) {
    throw new XweUsageError('createEngine takes a catalog or packs, not both');
  }
  if (options.catalog !== undefined && typeof options.catalog.getNodeType !== 'function') {
    throw new XweUsageError('createEngine: catalog must come from createCatalog([...corePacks, ...])');
  }
  if (options.packs !== undefined && !Array.isArray(options.packs)) {
    throw new XweUsageError('createEngine: packs must be an array of node packs');
  }
  // createCatalog throws (naming the node) on a malformed pack; that is a
  // programming error in the pack, not a usage error, so it propagates as is.
  const catalog =
    options.catalog ?? (options.packs ? createCatalog([...corePacks, ...options.packs]) : coreCatalog);
  const host = options.host;
  if (options.log !== undefined && typeof options.log !== 'function' && !isLogLevel(options.log)) {
    throw new XweUsageError(`createEngine: log must be a function or one of ${LOG_LEVELS.join(', ')}`);
  }
  const logger = createLogger(options.log ?? 'silent', (line) => process.stderr.write(`[engine] ${line}\n`));

  return {
    host,
    catalog,
    async run(runOptions: EngineRunOptions): Promise<EngineRunResult> {
      const startedAt = Date.now();
      const manifest = resolveRunManifest(runOptions, catalog);
      const runId = runOptions.runId ?? manifest.runId;
      logger.debug(
        `run ${runId}: ${manifest.definition.nodes.length} node(s), bindings ${manifest.inputs.map((i) => `${i.nodeId}=${i.binding.kind}`).join(', ') || 'none'}`,
      );
      const formats = captureFormatsOf(manifest.definition);
      const rawBindings: Record<string, EngineSourceBinding> = Object.fromEntries(
        manifest.inputs.map((i) => [i.nodeId, i.binding]),
      );
      // Before bind: a bad webhook URL or secret is a usage error and nothing runs.
      const webhookSink = bindWebhooks(manifest, runId, runOptions.webhooks, (m) => logger.info(m));
      const bound = await host.bind({
        runId,
        manifest,
        bindings: rawBindings,
        emitVideo: runOptions.emitVideo === true,
        catalog,
      });
      const progress = teeProgress(
        bound.progress,
        runOptions.progress ? objectProgress(runOptions.progress) : undefined,
        webhookSink?.sink,
      );
      logger.debug(`run ${runId}: artifacts -> ${bound.runDir}`);
      const secrets = withSecretOverrides(bound.secrets, runOptions.secrets);
      const deadlineMs =
        runOptions.deadlineMs ??
        (manifest.limits.maxRuntimeSeconds ? manifest.limits.maxRuntimeSeconds * 1000 : undefined);

      progress?.runStatus({ status: 'running' });
      let outcome: EngineRunOutcome;
      try {
        outcome = await runGraph(
          {
            runId,
            mode: manifest.mode,
            deviceId: manifest.deviceId,
            window: manifest.window
              ? { fromMs: Date.parse(manifest.window.from), toMs: Date.parse(manifest.window.to) }
              : null,
            definition: manifest.definition,
            bindings: bound.bindings ?? rawBindings,
          },
          {
            sources: bound.sources,
            ...(bound.artifacts ? { artifacts: bound.artifacts } : {}),
            ...(secrets ? { secrets } : {}),
            ...(bound.httpFetch ? { httpFetch: bound.httpFetch } : {}),
            ...(progress ? { progress } : {}),
            ...(deadlineMs ? { deadlineMs } : {}),
            ...(webhookSink && webhookSink.secrets.length > 0 ? { redact: webhookSink.secrets } : {}),
            log: logger.sink,
            catalog,
          },
        );
      } catch (err) {
        // Engine-level crash: still land a result.json, like every target does.
        // Run-level secret values are the only ones known here; scrub them.
        const redactor = createRedactor([...Object.values(runOptions.secrets ?? {}), ...(webhookSink?.secrets ?? [])]);
        outcome = {
          status: 'failed',
          error: redactor.text(err instanceof Error ? err.message : String(err)),
          failedNodeId: null,
          steps: [],
          events: [],
          captures: {},
          metrics: { nodes: manifest.definition.nodes.length, okSteps: 0, events: 0, messages: 0 },
        };
      }

      const result = await bound.writeArtifacts(outcome, formats);
      // Local webhook POSTs are fire-and-forget during the run; settle them
      // before the run resolves so a CLI exit does not cut them off.
      if (webhookSink) await webhookSink.sink.flush();
      if (runOptions.emitVideo && outcome.status === 'succeeded' && bound.afterSuccess) {
        await bound.afterSuccess();
      }
      progress?.runStatus({
        status: outcome.status,
        error: outcome.error,
        failedNodeId: outcome.failedNodeId,
      });
      logger.debug(`run ${runId}: ${outcome.status} in ${Date.now() - startedAt} ms`);
      return { result, runDir: bound.runDir, outcome };
    },
    async testFunction(options: TestFunctionOptions): Promise<FunctionTestResult> {
      if (!options || typeof options.nodeId !== 'string' || !options.nodeId) {
        throw new XweUsageError('testFunction needs a nodeId');
      }
      if (options.template === undefined) throw new XweUsageError('testFunction needs a template');
      if (options.event === undefined) throw new XweUsageError('testFunction needs an event (--event <file>)');
      let definition;
      try {
        definition =
          typeof options.template === 'string' ? loadDefinition(options.template) : parseTemplate(options.template);
      } catch (err) {
        return usage(err);
      }
      const node = definition.nodes.find((n) => n.id === options.nodeId);
      if (!node) {
        const ids = definition.nodes.map((n) => n.id).join(', ');
        throw new XweUsageError(`node "${options.nodeId}" is not in the template (nodes: ${ids || 'none'})`);
      }
      const language = FUNCTION_TYPES[node.type];
      if (!language) {
        throw new XweUsageError(
          `node "${node.id}" is a ${node.type}, not a function node (function.javascript | function.python)`,
        );
      }
      const typeDef = catalog.getNodeType(node.type);
      if (!typeDef) throw new XweUsageError(`this engine's catalog has no ${node.type} (core/function pack missing)`);
      const parsedConfig = typeDef.config.safeParse(node.data.config ?? {});
      if (!parsedConfig.success) {
        const issue = parsedConfig.error.issues[0];
        const at = issue?.path.length ? ` at "${issue.path.join('.')}"` : '';
        throw new XweUsageError(`node "${node.id}": invalid config${at}: ${issue?.message ?? 'parse failed'}`);
      }
      const cfg = parsedConfig.data as FunctionConfig;
      if (options.version !== undefined && (!Number.isInteger(options.version) || options.version <= 0)) {
        throw new XweUsageError('version must be a positive integer');
      }
      let resolved;
      try {
        resolved = resolveFunctionCode(cfg, options.version);
      } catch (err) {
        return usage(err);
      }
      const event = readTestEvent(options.event);
      const runId = options.runId ?? `test-${Date.now()}`;
      const logs: string[] = [];
      const proc = new FunctionProcess({
        language,
        code: resolved.code,
        handler: resolved.handler,
        functionVersion: resolved.functionVersion,
        nodeId: node.id,
        runId,
        timeoutMs: cfg.timeoutMs,
        memoryMb: cfg.memoryMb,
        onLog: (line) => logs.push(line),
      });
      const base = { logs, functionVersion: resolved.functionVersion, nodeId: node.id, type: node.type, language };
      logger.debug(`test ${runId}: ${node.type} ${node.id} (${resolved.label}, timeout ${cfg.timeoutMs} ms, ${cfg.memoryMb} MB)`);
      try {
        await proc.start();
      } catch (err) {
        if (err instanceof FunctionLoadError) {
          return { ...base, ok: false, error: err.message, durationMs: 0, runtime: '' };
        }
        // The runner could not start at all (python3 missing): nothing ran.
        throw new XweUsageError(err instanceof Error ? err.message : String(err), { cause: err });
      }
      try {
        const r = await proc.invoke(event);
        if (r.ok) return { ...base, ok: true, result: r.value, durationMs: r.durationMs, runtime: proc.runtime };
        return { ...base, ok: false, error: joinTrace(r.error, r.stack), durationMs: r.durationMs, runtime: proc.runtime };
      } finally {
        await proc.close();
      }
    },
  };
}
