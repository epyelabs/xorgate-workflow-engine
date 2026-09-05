import * as path from 'node:path';
import type { EngineProgressSink } from '../catalog/types';
import type { EngineBoundRun, EngineHost, EngineHostBindArgs } from '../host';
import { localizeBindings } from './bindings';
import { emitVisualizationVideos } from './emit-video';
import { createModelChain, type ModelChain } from './models';
import { envPullEnabled, modelCacheDir } from './paths';
import { registryUrlFrom } from './registry-client';
import {
  defaultLocalLog,
  localArtifactSink,
  localSecretReader,
  localSources,
  resolveFfmpeg,
  writeLocalRunArtifacts,
} from './target';

/**
 * The file host: paths in, `out/<runId>/` out. Composes localSources,
 * localArtifactSink, localSecretReader and (when given) a progress sink into
 * the host `createEngine` drives. `xwe run` uses exactly this.
 */

export interface LocalHostModelsOptions {
  /**
   * Fetch a model the graph names from the registry into the cache when it
   * is not on disk. Default: `XWE_MODELS_PULL=1` in the environment, else off.
   */
  pull?: boolean;
  /** Registry URL. Default: `XWE_MODEL_REGISTRY`, else the public registry. */
  registryUrl?: string;
  /** The cache root. Default: `XWE_MODELS_DIR`, else `~/.xorgate/models`. */
  cacheDir?: string;
}

export interface LocalHostOptions {
  /** Model registry roots searched first, in order, before the cache. */
  modelDirs?: string[];
  /** Artifact root; the run writes `<outDir>/<runId>/`. Default `out`. */
  outDir?: string;
  /** Logical name to value; wins over `XORGATE_SECRET_*` in the environment. */
  secrets?: Record<string, string>;
  /** A progress sink for every run (for example `ndjsonProgress(...)`). */
  progress?: EngineProgressSink;
  /** Resolves relative paths (inputs, model roots, outDir). Default: cwd. */
  baseDir?: string;
  /** Registry pull settings (see LocalHostModelsOptions). */
  models?: LocalHostModelsOptions;
  /** Environment for secrets, `FFMPEG_PATH` and the `XWE_*` variables. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Diagnostic lines (model resolution, video muxing). Default: stderr, `[xwe]` prefixed. */
  log?: (message: string) => void;
}

export interface LocalHost extends EngineHost {
  /** The full directory search chain: explicit dirs, then the cache. */
  readonly modelDirs: string[];
  /** The resolver chain runs use (explicit dirs, cache, registry when pulling). */
  readonly models: ModelChain;
  readonly outDir: string;
  readonly baseDir: string;
}

export function localHost(opts: LocalHostOptions = {}): LocalHost {
  const baseDir = opts.baseDir ?? process.cwd();
  const abs = (p: string): string => (path.isAbsolute(p) ? p : path.join(baseDir, p));
  const env = opts.env ?? process.env;
  const log = opts.log ?? defaultLocalLog;
  const explicitDirs = (opts.modelDirs ?? []).map(abs);
  const cacheDir = opts.models?.cacheDir ? abs(opts.models.cacheDir) : modelCacheDir(env, baseDir);
  const models = createModelChain({
    modelDirs: explicitDirs,
    cacheDir,
    registryUrl: opts.models?.registryUrl ?? registryUrlFrom(env),
    pull: opts.models?.pull ?? envPullEnabled(env),
    cwd: baseDir,
    log,
  });
  const outDir = abs(opts.outDir ?? 'out');

  return {
    modelDirs: models.roots,
    models,
    outDir,
    baseDir,
    bind(args: EngineHostBindArgs): EngineBoundRun {
      const runDir = path.join(outDir, args.runId);
      // Locates ffmpeg-static on dev machines (sets FFMPEG_PATH); media.ts
      // spawns `ffmpeg` from PATH otherwise. Nothing to do when absent: video
      // nodes then fail their step naming ffmpeg.
      resolveFfmpeg(env);
      return {
        runDir,
        bindings: localizeBindings(args.bindings),
        sources: localSources({ modelDirs: models.roots, baseDir, log, models }),
        artifacts: localArtifactSink(runDir),
        secrets: localSecretReader({ env, secretsFile: opts.secrets }),
        ...(opts.progress ? { progress: opts.progress } : {}),
        writeArtifacts: (outcome, formats) => writeLocalRunArtifacts(runDir, args.runId, outcome, formats),
        ...(args.emitVideo
          ? {
              afterSuccess: async () => {
                await emitVisualizationVideos({
                  runDir,
                  definition: args.manifest.definition,
                  log,
                  ...(args.catalog ? { catalog: args.catalog } : {}),
                });
              },
            }
          : {}),
      };
    },
  };
}
