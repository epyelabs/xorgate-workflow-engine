import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { displayUrl } from '../engine/redact';
import { modelManifestSchema, type ModelManifest } from '../models/registry';
import { formatModelRef, parseModelName, type ModelRef } from './model-ref';
import { displayPath } from './paths';
import { pullModel } from './registry-client';

/**
 * The local host's model resolver chain (models.mdx "Where a model comes
 * from"): explicit directories, then the cache, then, only when pulls are
 * enabled, the registry. Each resolver answers one question, "do you have
 * this model?", and the chain takes the first yes. `fetchModel` on the seam
 * is unchanged; this is what sits behind it on the local host.
 */

export interface ResolvedModel {
  ref: Required<ModelRef>;
  manifest: ModelManifest;
  /** `<root>/<family>/<name>/<version>` */
  dir: string;
  modelPath: string;
  /** The root directory the model was found under. */
  root: string;
  /** Which resolver answered. */
  via: 'dir' | 'cache' | 'registry';
}

export interface ModelResolveContext {
  /** Diagnostic lines (pull warnings). */
  log: (message: string) => void;
}

export interface ModelResolver {
  readonly kind: 'dir' | 'cache' | 'registry';
  /** The roots this resolver searches (directories) or the registry URL, for messages. */
  describe(cwd: string): string[];
  resolve(ref: ModelRef, ctx: ModelResolveContext): Promise<ResolvedModel | null>;
}

/** Highest complete version under `<root>/<family>/<name>/`, or the pinned one. */
export function findModelInRoot(root: string, ref: ModelRef, via: ResolvedModel['via']): ResolvedModel | null {
  const nameDir = path.join(root, ref.family, ref.name);
  if (!existsSync(nameDir)) return null;
  const versions = readdirSync(nameDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
    .map((e) => Number(e.name))
    .filter((v) => ref.version === undefined || v === ref.version)
    .sort((a, b) => b - a);
  for (const version of versions) {
    const dir = path.join(nameDir, String(version));
    const manifestPath = path.join(dir, 'manifest.json');
    const modelPath = path.join(dir, 'model.onnx');
    if (!existsSync(manifestPath) || !existsSync(modelPath)) continue;
    const manifest = modelManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
    return { ref: { family: ref.family, name: ref.name, version }, manifest, dir, modelPath, root, via };
  }
  return null;
}

/** Explicit roots (`--models-dir`, `localHost({ modelDirs })`), searched in order. */
export function dirResolver(dirs: string[]): ModelResolver {
  return {
    kind: 'dir',
    describe: (cwd) => dirs.map((d) => displayPath(d, cwd)),
    async resolve(ref) {
      for (const dir of dirs) {
        const hit = findModelInRoot(dir, ref, 'dir');
        if (hit) return hit;
      }
      return null;
    },
  };
}

/** The cache root (`XWE_MODELS_DIR`, default `~/.xorgate/models`). */
export function cacheResolver(cacheDir: string): ModelResolver {
  return {
    kind: 'cache',
    describe: (cwd) => [displayPath(cacheDir, cwd)],
    async resolve(ref) {
      return findModelInRoot(cacheDir, ref, 'cache');
    },
  };
}

/** The registry: pulls into the cache, then answers from there. Only in the chain when pulls are enabled. */
export function httpResolver(registryUrl: string, cacheDir: string): ModelResolver {
  return {
    kind: 'registry',
    describe: () => [registryUrl],
    async resolve(ref, ctx) {
      const pulled = await pullModel({ registryUrl, cacheDir, ref, log: ctx.log });
      if (!pulled.alreadyCached) {
        ctx.log(
          `pulled ${formatModelRef(pulled.ref)} from ${displayUrl(registryUrl)} -> ${pulled.dir} (model.onnx ${formatBytes(pulled.sizeBytes)}, ${pulled.integrity === 'verified' ? 'sha256 verified' : 'no checksum in manifest'})`,
        );
      }
      return {
        ref: pulled.ref,
        manifest: pulled.manifest,
        dir: pulled.dir,
        modelPath: pulled.modelPath,
        root: cacheDir,
        via: 'registry',
      };
    },
  };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${bytes} B`;
}

export class ModelNotFoundError extends Error {
  constructor(
    readonly ref: ModelRef,
    readonly searched: string[],
    readonly registryUrl: string | null,
  ) {
    super(ModelNotFoundError.message(ref, searched, registryUrl));
    this.name = 'ModelNotFoundError';
  }

  /**
   * Exactly the text models.mdx shows after `run failed at node <id>: `:
   *
   *   model detection/yolov8n not found under ./models, ~/.xorgate/models
   *     (run `xwe models pull detection/yolov8n`, or pass --pull)
   */
  static message(ref: ModelRef, searched: string[], registryUrl: string | null): string {
    const spec = formatModelRef(ref);
    const roots = searched.length > 0 ? searched.join(', ') : '(no model roots)';
    if (registryUrl === null) {
      return `model ${spec} not found under ${roots}\n  (run \`xwe models pull ${spec}\`, or pass --pull)`;
    }
    return `model ${spec} not found under ${roots} or in the registry ${displayUrl(registryUrl)}\n  (see \`xwe models list\`)`;
  }
}

export interface ModelChainOptions {
  /** Explicit roots, searched first, in order. */
  modelDirs: string[];
  /** The cache root; searched second, and where pulls land. */
  cacheDir: string;
  /** Registry pulls; the third link only when `pull` is true. */
  registryUrl: string;
  pull: boolean;
  /** Used to present roots in messages. Default: cwd. */
  cwd?: string;
  log?: (message: string) => void;
}

export interface ModelChain {
  readonly resolvers: ModelResolver[];
  /** Every directory root in order (explicit, then the cache). */
  readonly roots: string[];
  readonly cacheDir: string;
  readonly registryUrl: string;
  readonly pull: boolean;
  /** First hit along the chain; throws ModelNotFoundError with the documented text. */
  resolve(ref: ModelRef): Promise<ResolvedModel>;
  /** The `fetchModel` seam over this chain (`name` may carry `@version`). */
  fetchModel(args: { family: string; name: string }): Promise<{ manifest: ModelManifest; modelPath: string }>;
  /** Where the directory roots would find the model, without pulling; null on a miss. */
  locate(ref: ModelRef): ResolvedModel | null;
}

export function createModelChain(opts: ModelChainOptions): ModelChain {
  const cwd = opts.cwd ?? process.cwd();
  const log = opts.log ?? (() => {});
  const roots = [...opts.modelDirs, opts.cacheDir];
  const resolvers: ModelResolver[] = [dirResolver(opts.modelDirs), cacheResolver(opts.cacheDir)];
  if (opts.pull) resolvers.push(httpResolver(opts.registryUrl, opts.cacheDir));
  const ctx: ModelResolveContext = { log };

  const chain: ModelChain = {
    resolvers,
    roots,
    cacheDir: opts.cacheDir,
    registryUrl: opts.registryUrl,
    pull: opts.pull,
    async resolve(ref) {
      for (const resolver of resolvers) {
        const hit = await resolver.resolve(ref, ctx);
        if (hit) return hit;
      }
      throw new ModelNotFoundError(
        ref,
        roots.map((r) => displayPath(r, cwd)),
        opts.pull ? opts.registryUrl : null,
      );
    },
    async fetchModel({ family, name }) {
      const resolved = await chain.resolve(parseModelName(family, name));
      return { manifest: resolved.manifest, modelPath: resolved.modelPath };
    },
    locate(ref) {
      for (const root of roots) {
        const hit = findModelInRoot(root, ref, root === opts.cacheDir ? 'cache' : 'dir');
        if (hit) return hit;
      }
      return null;
    },
  };
  return chain;
}
