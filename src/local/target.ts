import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type {
  EngineArtifactSink,
  EngineProgressSink,
  EngineSecretReader,
  EngineSourceReader,
} from '../catalog/types';
import type { ModelManifest } from '../models/registry';
import { modelManifestSchema } from '../models/registry';
import type { EngineRunOutcome } from '../engine/index';
import { buildEngineResult, type EngineResult } from '../engine/manifest';

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

const log = (msg: string): void => {
  console.error(`[xwe] ${msg}`);
};

// ---------------------------------------------------------------------------
// Sources

export interface LocalSourceOptions {
  /** Model registry roots, searched in order for <family>/<name>/<version>/. */
  modelDirs: string[];
  /** Resolves paths in bindings/refs that are not absolute. Default: cwd. */
  baseDir?: string;
}

/** Default model search path: ./fixtures/models, then ~/.xorgate/models. */
export function defaultModelDirs(baseDir = process.cwd()): string[] {
  return [path.join(baseDir, 'fixtures', 'models'), path.join(homedir(), '.xorgate', 'models')];
}

function resolveLocalModel(
  modelDirs: string[],
  family: string,
  name: string,
): { manifest: ModelManifest; modelPath: string } {
  for (const dir of modelDirs) {
    const nameDir = path.join(dir, family, name);
    if (!existsSync(nameDir)) continue;
    const versions = readdirSync(nameDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => Number(e.name))
      .sort((a, b) => b - a);
    for (const version of versions) {
      const versionDir = path.join(nameDir, String(version));
      const manifestPath = path.join(versionDir, 'manifest.json');
      const modelPath = path.join(versionDir, 'model.onnx');
      if (!existsSync(manifestPath) || !existsSync(modelPath)) continue;
      const manifest = modelManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
      return { manifest, modelPath };
    }
  }
  throw new Error(
    `Model ${family}/${name} not found under: ${modelDirs.join(', ')} ` +
      `(expected <dir>/${family}/${name}/<version>/{manifest.json,model.onnx}, the registry layout)`,
  );
}

export function localSources(opts: LocalSourceOptions): EngineSourceReader {
  const baseDir = opts.baseDir ?? process.cwd();
  const abs = (p: string): string => (path.isAbsolute(p) ? p : path.join(baseDir, p));
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
        entry = Promise.resolve().then(() => {
          const resolved = resolveLocalModel(opts.modelDirs.map(abs), family, name);
          log(`model ${family}/${name} v${resolved.manifest.version} <- ${resolved.modelPath}`);
          return resolved;
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
 * EngineProgressSink emitting one JSON object per line on the given stream:
 * { t: "status"|"step"|"event"|"record", at: ISO, ... }. Same messages the
 * cloud publishes to IoT topics (progress.ts payloads), different transport.
 */
export function ndjsonProgress(write: (line: string) => void): EngineProgressSink {
  const emit = (obj: Record<string, unknown>): void => {
    write(JSON.stringify({ at: new Date().toISOString(), ...obj }));
  };
  return {
    runStatus(update) {
      emit({ t: 'status', ...update });
    },
    step(step) {
      emit({ t: 'step', ...step });
    },
    event(event) {
      emit({ t: 'event', ...event });
    },
    record(rec) {
      emit({ t: 'record', ...rec });
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
  const onPath = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (!onPath.error && onPath.status === 0) return 'ffmpeg';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffmpegStatic = require('ffmpeg-static') as string | null;
    if (ffmpegStatic) {
      env.FFMPEG_PATH = ffmpegStatic;
      return ffmpegStatic;
    }
  } catch {
    // ffmpeg-static not installed; fall through
  }
  return null;
}
