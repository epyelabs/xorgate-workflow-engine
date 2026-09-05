import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type {
  EngineArtifactSink,
  EngineEventRecord,
  EngineProgressSink,
  EngineProgressStep,
  EngineSecretReader,
  EngineSourceReader,
} from '../catalog/types';
import type { ModelManifest } from '../models/registry';
import type { EngineRunOutcome } from '../engine/index';
import { scrubSecretEnv } from '../engine/child-env';
import { buildEngineResult, type EngineResult } from '../engine/manifest';
import { lazyRequire } from '../engine/lazy-require';
import { parseModelName } from './model-ref';
import { createModelChain, type ModelChain } from './models';
import { displayPath, modelCacheDir } from './paths';
import { registryUrlFrom } from './registry-client';

/**
 * LocalTargetIO (portable-engine M3): the filesystem shell around the
 * storage-free engine core. The deployed targets' S3/Secrets Manager/IoT
 * wiring lives in core-service's engine/target.ts (deliberately left behind);
 * this module is its local mirror:
 *
 * - sources read local files (video paths pass straight through via the
 *   in-core `video_local` binding; `telemetry_csv`/`telemetry_materialized`
 *   bindings resolve their `s3Key` as a LOCAL PATH through fetchText;
 *   models resolve from a local mirror of the S3 registry layout)
 * - artifacts land under out/<runId>/ mirroring the S3 run-prefix key layout
 *   exactly (events.jsonl, outputs/<nodeId>/records.*, frames/<nodeId>/<seq>.jpg,
 *   result.json LAST)
 * - secrets come from env (XORGATE_SECRET_*) or a --secrets JSON file
 * - progress is NDJSON on stdout when asked for
 */

/** The local host's default diagnostic line: stderr, `[xwe]` prefixed. */
export const defaultLocalLog = (msg: string): void => {
  console.error(`[xwe] ${msg}`);
};

// ---------------------------------------------------------------------------
// Sources

export interface LocalSourceOptions {
  /**
   * Model registry roots, searched in order for <family>/<name>/<version>/.
   * Ignored when `models` (a resolver chain) is given.
   */
  modelDirs: string[];
  /** Resolves paths in bindings/refs that are not absolute. Default: cwd. */
  baseDir?: string;
  /** Diagnostic lines (model resolution). Default: stderr, `[xwe]` prefixed. */
  log?: (message: string) => void;
  /** The resolver chain (explicit roots, cache, registry); built from `modelDirs` alone when absent. */
  models?: ModelChain;
}

/**
 * Default model search path: the cache only (`XWE_MODELS_DIR`, else
 * `~/.xorgate/models`). `./fixtures/models` left the default chain with the
 * registry client; a checkout passes `--models-dir fixtures/models`.
 */
export function defaultModelDirs(baseDir = process.cwd(), env: NodeJS.ProcessEnv = process.env): string[] {
  return [modelCacheDir(env, baseDir)];
}

export function localSources(opts: LocalSourceOptions): EngineSourceReader {
  const baseDir = opts.baseDir ?? process.cwd();
  const log = opts.log ?? defaultLocalLog;
  const abs = (p: string): string => (path.isAbsolute(p) ? p : path.join(baseDir, p));
  const chain =
    opts.models ??
    createModelChain({
      modelDirs: opts.modelDirs.map(abs),
      cacheDir: modelCacheDir(process.env, baseDir),
      registryUrl: registryUrlFrom(process.env),
      pull: false,
      cwd: baseDir,
      log,
    });
  const modelCache = new Map<string, Promise<{ manifest: ModelManifest; modelPath: string }>>();
  return {
    async readTelemetryWindow() {
      throw new Error(
        'Device telemetry history is not available on the local target; bind the telemetry source to a CSV/JSONL file or inline samples',
      );
    },
    async fetchText({ key }) {
      // Cloud bindings carry S3 keys here; locally the same field is a path.
      return readFile(abs(key), 'utf8');
    },
    async fetchVideo({ key }) {
      // video_local bindings never reach this (in-core path passthrough);
      // an s3-shaped binding (video_file/device_session) resolves as a path.
      const p = abs(key);
      if (!existsSync(p)) throw new Error(`Video input not found: ${p}`);
      return { path: p };
    },
    // No releaseVideo: never delete caller-owned local files.
    fetchModel({ family, name }) {
      const cacheKey = `${family}/${name}`;
      let entry = modelCache.get(cacheKey);
      if (!entry) {
        entry = chain.resolve(parseModelName(family, name)).then((resolved) => {
          log(
            `model ${resolved.ref.family}/${resolved.ref.name} v${resolved.ref.version} <- ${displayPath(resolved.modelPath, baseDir, { bare: true })}`,
          );
          return { manifest: resolved.manifest, modelPath: resolved.modelPath };
        });
        modelCache.set(cacheKey, entry);
      }
      return entry;
    },
  };
}

// ---------------------------------------------------------------------------
// Artifacts

/** Frames sink writing out/<runId>/frames/<nodeId>/<seq>.jpg. */
export function localArtifactSink(runDir: string): EngineArtifactSink {
  return {
    async putFrame(nodeId: string, frameSeq: number, jpeg: Buffer): Promise<string> {
      const file = path.join(runDir, 'frames', nodeId, `${frameSeq}.jpg`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, jpeg);
      return file;
    },
  };
}

/**
 * Local mirror of the cloud target's writeRunArtifacts: events.jsonl and
 * outputs/<nodeId>/records.* first, result.json LAST (same durability
 * ordering, same key layout under out/<runId>/).
 */
export function writeLocalRunArtifacts(
  runDir: string,
  runId: string,
  outcome: EngineRunOutcome,
  formats: Record<string, 'jsonl' | 'json'> = {},
): EngineResult {
  mkdirSync(runDir, { recursive: true });
  if (outcome.events.length > 0) {
    writeFileSync(
      path.join(runDir, 'events.jsonl'),
      outcome.events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
  }
  for (const [nodeId, records] of Object.entries(outcome.captures)) {
    const format = formats[nodeId] ?? 'jsonl';
    const file = path.join(runDir, 'outputs', nodeId, `records.${format}`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      format === 'json'
        ? JSON.stringify(records)
        : records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
  }
  const result = buildEngineResult(runId, outcome, formats);
  writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

// ---------------------------------------------------------------------------
// Secrets

const SECRET_ENV_PREFIX = 'XORGATE_SECRET_';

/** anthropic-api-key -> XORGATE_SECRET_ANTHROPIC_API_KEY */
export function secretEnvVar(logicalName: string): string {
  return SECRET_ENV_PREFIX + logicalName.replace(/-/g, '_').toUpperCase();
}

/**
 * Local secrets seam: a --secrets JSON file ({ "<logical-name>": "<value>" })
 * wins over env (XORGATE_SECRET_*). Never bundled, never required for graphs
 * without connector/VLM nodes.
 */
export function localSecretReader(deps: {
  env: Record<string, string | undefined>;
  secretsFile?: Record<string, string>;
}): EngineSecretReader {
  return {
    async getSecret(logicalName: string): Promise<string> {
      const fromFile = deps.secretsFile?.[logicalName];
      if (fromFile) return fromFile;
      const envVar = secretEnvVar(logicalName);
      const fromEnv = deps.env[envVar];
      if (fromEnv) return fromEnv;
      throw new Error(
        `Secret "${logicalName}" is not configured: set ${envVar} or add it to the --secrets file`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Progress (NDJSON on stdout)

/**
 * One progress message as `--progress json` prints it: the seam's payload
 * plus `t` (which method fired) and `at` (ISO timestamp). The message set is
 * the engine's, frozen; a platform shell publishes the same objects over its
 * own transport.
 */
export type EngineProgressStatusUpdate = Parameters<EngineProgressSink['runStatus']>[0];
export type EngineProgressRecord = Parameters<NonNullable<EngineProgressSink['record']>>[0];
export type EngineProgressMessage =
  | ({ at: string; t: 'status' } & EngineProgressStatusUpdate)
  | ({ at: string; t: 'step' } & EngineProgressStep)
  | ({ at: string; t: 'event' } & EngineEventRecord)
  | ({ at: string; t: 'record' } & EngineProgressRecord);

/**
 * EngineProgressSink handing each message to a callback as an object, in the
 * exact shape ndjsonProgress serializes (`at` first, then `t`, then the
 * payload). `engine.run({ progress })` is built on this.
 */
export function objectProgress(emit: (message: EngineProgressMessage) => void): EngineProgressSink {
  const at = (): string => new Date().toISOString();
  return {
    runStatus(update) {
      emit({ at: at(), t: 'status', ...update });
    },
    step(step) {
      emit({ at: at(), t: 'step', ...step });
    },
    event(event) {
      emit({ at: at(), t: 'event', ...event });
    },
    record(rec) {
      emit({ at: at(), t: 'record', ...rec });
    },
  };
}

/**
 * EngineProgressSink emitting one JSON object per line on the given stream:
 * { at: ISO, t: "status"|"step"|"event"|"record", ... }. Same messages the
 * cloud publishes to IoT topics (progress.ts payloads), different transport.
 */
export function ndjsonProgress(write: (line: string) => void): EngineProgressSink {
  return objectProgress((message) => write(JSON.stringify(message)));
}

/** Fan one run's progress out to every sink given; undefined when none. */
export function teeProgress(
  ...sinks: Array<EngineProgressSink | undefined>
): EngineProgressSink | undefined {
  const live = sinks.filter((s): s is EngineProgressSink => s !== undefined);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  return {
    runStatus(update) {
      for (const s of live) s.runStatus(update);
    },
    step(step) {
      for (const s of live) s.step(step);
    },
    event(event) {
      for (const s of live) s.event(event);
    },
    record(rec) {
      for (const s of live) s.record?.(rec);
    },
    preview(nodeId, frameSeq, jpeg) {
      for (const s of live) s.preview?.(nodeId, frameSeq, jpeg);
    },
  };
}

// ---------------------------------------------------------------------------
// ffmpeg

/**
 * media.ts spawns `ffmpeg` from PATH unless FFMPEG_PATH points elsewhere
 * (identical to the cloud container, which apt-installs it). Locally: honor
 * FFMPEG_PATH, else PATH, else fall back to an installed ffmpeg-static.
 * Returns the resolved path (and sets FFMPEG_PATH), or null when no ffmpeg
 * exists — media graphs then fail with a clear error.
 */
export function resolveFfmpeg(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.FFMPEG_PATH) return env.FFMPEG_PATH;
  const onPath = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', env: scrubSecretEnv(env) });
  if (!onPath.error && onPath.status === 0) return 'ffmpeg';
  try {
    const ffmpegStatic = lazyRequire<string | null>('ffmpeg-static');
    if (ffmpegStatic) {
      env.FFMPEG_PATH = ffmpegStatic;
      return ffmpegStatic;
    }
  } catch {
    // ffmpeg-static not installed; fall through
  }
  return null;
}
