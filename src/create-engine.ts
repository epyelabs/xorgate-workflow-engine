import { readFileSync } from 'node:fs';
import { coreCatalog, corePacks } from './catalog/index';
import { createCatalog, type Catalog, type NodePack } from './catalog/pack';
import type { EngineSecretReader, EngineSourceBinding } from './catalog/types';
import { runGraph, type EngineRunOutcome } from './engine/index';
import { runManifestSchema, type EngineResult, type RunManifest } from './engine/manifest';
import { upgradeDefinition } from './compat';
import type { EngineHost } from './host';
import { buildLocalManifest, loadDefinition, parseTemplate } from './local/manifest-builder';
import { captureFormatsOf } from './local/capture-formats';
import { objectProgress, teeProgress, type EngineProgressMessage } from './local/target';

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
  /** Engine diagnostics (`[engine] ...` on the CLI). Default: silent. */
  log?: (message: string) => void;
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
}

export interface EngineRunResult {
  /** The parsed `result.json`. */
  result: EngineResult;
  /** The directory (or locator) the artifact tree was written to. */
  runDir: string;
  /** The engine's in-memory outcome: steps, events, captured records. */
  outcome: EngineRunOutcome;
}

export interface Engine {
  readonly host: EngineHost;
  /** The catalog every run of this engine validates and executes against. */
  readonly catalog: Catalog;
  run(options: EngineRunOptions): Promise<EngineRunResult>;
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
  const log = options.log ?? (() => {});

  return {
    host,
    catalog,
    async run(runOptions: EngineRunOptions): Promise<EngineRunResult> {
      const manifest = resolveRunManifest(runOptions, catalog);
      const runId = runOptions.runId ?? manifest.runId;
      const formats = captureFormatsOf(manifest.definition);
      const rawBindings: Record<string, EngineSourceBinding> = Object.fromEntries(
        manifest.inputs.map((i) => [i.nodeId, i.binding]),
      );
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
      );
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
            log,
            catalog,
          },
        );
      } catch (err) {
        // Engine-level crash: still land a result.json, like every target does.
        outcome = {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          failedNodeId: null,
          steps: [],
          events: [],
          captures: {},
          metrics: { nodes: manifest.definition.nodes.length, okSteps: 0, events: 0, messages: 0 },
        };
      }

      const result = await bound.writeArtifacts(outcome, formats);
      if (runOptions.emitVideo && outcome.status === 'succeeded' && bound.afterSuccess) {
        await bound.afterSuccess();
      }
      progress?.runStatus({
        status: outcome.status,
        error: outcome.error,
        failedNodeId: outcome.failedNodeId,
      });
      return { result, runDir: bound.runDir, outcome };
    },
  };
}
