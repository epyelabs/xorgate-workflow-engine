import type {
  EngineArtifactSink,
  EngineProgressSink,
  EngineSecretReader,
  EngineSourceBinding,
  EngineSourceReader,
} from './catalog/types';
import type { Catalog } from './catalog/pack';
import type { EngineRunOutcome } from './engine/index';
import type { EngineResult, RunManifest } from './engine/manifest';

/**
 * What `createEngine` needs from a host. The four seams are the engine's
 * contract; a host adds where a run's artifact tree lives and how the outcome
 * is persisted, because `engine.run` promises a parsed `result.json` back.
 * `localHost` (./local) is the reference implementation; a service with its
 * own storage either implements this or calls `runGraph` directly.
 */

export interface EngineHostBindArgs {
  runId: string;
  /** The v2 run manifest this run executes (definition already upgraded). */
  manifest: RunManifest;
  /** nodeId -> manifest binding, as written in the manifest. */
  bindings: Record<string, EngineSourceBinding>;
  /** `engine.run({ emitVideo })`; the local host muxes frames in afterSuccess. */
  emitVideo: boolean;
  /** The catalog the run executes against (core plus any packs); absent means core. */
  catalog?: Catalog;
}

export interface EngineBoundRun {
  /** Where this run's artifacts land; a path for the local host. */
  runDir: string;
  sources: EngineSourceReader;
  artifacts?: EngineArtifactSink;
  secrets?: EngineSecretReader;
  progress?: EngineProgressSink;
  /** HTTP layer for connector executors (default: global fetch). */
  httpFetch?: typeof fetch;
  /** Bindings the host rewrote (the local host folds its `path` alias here). */
  bindings?: Record<string, EngineSourceBinding>;
  /** Persist the outcome, `result.json` last; return the parsed result. */
  writeArtifacts(
    outcome: EngineRunOutcome,
    formats: Record<string, 'jsonl' | 'json'>,
  ): EngineResult | Promise<EngineResult>;
  /** Runs after a successful run when `emitVideo` was asked for. */
  afterSuccess?(): Promise<void>;
}

export interface EngineHost {
  /** Called once per `engine.run`, before anything executes. */
  bind(args: EngineHostBindArgs): EngineBoundRun | Promise<EngineBoundRun>;
}
