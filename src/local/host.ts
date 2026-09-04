import * as path from 'node:path';
import type { EngineProgressSink } from '../catalog/types';
import type { EngineBoundRun, EngineHost, EngineHostBindArgs } from '../host';
import { localizeBindings } from './bindings';
import { emitVisualizationVideos } from './emit-video';
import {
  defaultLocalLog,
  defaultModelDirs,
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
  /** Fetch a model the graph names from the registry when it is not on disk. Not available in this release. */
  pull?: boolean;
  /** Registry URL (`XWE_MODEL_REGISTRY`). Not available in this release. */
  registryUrl?: string;
}

export interface LocalHostOptions {
  /** Model registry roots searched first, in order, before the defaults. */
  modelDirs?: string[];
  /** Artifact root; the run writes `<outDir>/<runId>/`. Default `out`. */
  outDir?: string;
  /** Logical name to value; wins over `XORGATE_SECRET_*` in the environment. */
  secrets?: Record<string, string>;
  /** A progress sink for every run (for example `ndjsonProgress(...)`). */
  progress?: EngineProgressSink;
  /** Resolves relative paths (inputs, model roots, outDir). Default: cwd. */
  baseDir?: string;
  /** Registry pull settings; accepted now, implemented with the registry. */
  models?: LocalHostModelsOptions;
  /** Environment for secrets and `FFMPEG_PATH`. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Diagnostic lines (model resolution, video muxing). Default: stderr, `[xwe]` prefixed. */
  log?: (message: string) => void;
}

export interface LocalHost extends EngineHost {
  /** The full model search chain: explicit dirs, then the defaults. */
  readonly modelDirs: string[];
  readonly outDir: string;
  readonly baseDir: string;
}

export function localHost(opts: LocalHostOptions = {}): LocalHost {
  const baseDir = opts.baseDir ?? process.cwd();
  const abs = (p: string): string => (path.isAbsolute(p) ? p : path.join(baseDir, p));
  const env = opts.env ?? process.env;
  const log = opts.log ?? defaultLocalLog;
  const modelDirs = [...(opts.modelDirs ?? []).map(abs), ...defaultModelDirs(baseDir)];
  const outDir = abs(opts.outDir ?? 'out');
  if (opts.models?.pull) {
    throw new Error(
      'localHost({ models: { pull: true } }): registry pulls are not available in this release; put the model under a --models-dir root or ~/.xorgate/models',
    );
  }

  return {
    modelDirs,
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
        sources: localSources({ modelDirs, baseDir, log }),
        artifacts: localArtifactSink(runDir),
        secrets: localSecretReader({ env, secretsFile: opts.secrets }),
        ...(opts.progress ? { progress: opts.progress } : {}),
        writeArtifacts: (outcome, formats) => writeLocalRunArtifacts(runDir, args.runId, outcome, formats),
        ...(args.emitVideo
          ? {
              afterSuccess: async () => {
                await emitVisualizationVideos({ runDir, definition: args.manifest.definition, log });
              },
            }
          : {}),
      };
    },
  };
}
