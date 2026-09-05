import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { displayUrl } from '../engine/redact';
import { modelManifestSchema, type ModelManifest } from '../models/registry';
import { formatModelRef, type ModelRef } from './model-ref';

/**
 * The registry over HTTP(S): the same `<family>/<name>/<version>/` layout a
 * directory has, plus `index.json` (an array of manifests) at the root. Any
 * static file server in that layout is a registry; `file:` URLs are accepted
 * too so tests and air-gapped mirrors need no server at all.
 */

export const DEFAULT_MODEL_REGISTRY = 'https://models.xorgate.io';

/**
 * Registry URL from the environment (`XWE_MODEL_REGISTRY`), else the public
 * one. A URL carrying credentials (`https://user:token@host`) is refused with
 * a message that names the variable, not the value: the client's HTTP layer
 * cannot use them, and its own error would echo them into logs.
 */
export function registryUrlFrom(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.XWE_MODEL_REGISTRY;
  const url = configured && configured.trim() !== '' ? configured.trim() : DEFAULT_MODEL_REGISTRY;
  if (urlHasCredentials(url)) {
    throw new Error(
      'XWE_MODEL_REGISTRY must not carry credentials (user:password@host); point it at a registry or mirror that needs none',
    );
  }
  return url;
}

function urlHasCredentials(url: string): boolean {
  try {
    const u = new URL(url);
    return u.username !== '' || u.password !== '';
  } catch {
    return false;
  }
}

export class RegistryHttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`HTTP ${status} for ${displayUrl(url)}`);
    this.name = 'RegistryHttpError';
  }
}

export function registryObjectUrl(registryUrl: string, ...segments: string[]): string {
  const base = registryUrl.replace(/\/+$/, '');
  return `${base}/${segments.join('/')}`;
}

function fileUrlToPath(url: string): string {
  return fileURLToPath(url);
}

/** Fetches one registry object as a byte stream; 404 and friends throw RegistryHttpError. */
async function openObject(url: string, timeoutMs: number): Promise<{ body: Readable; sizeBytes: number | null }> {
  if (url.startsWith('file:')) {
    const p = fileUrlToPath(url);
    if (!existsSync(p) || !statSync(p).isFile()) throw new RegistryHttpError(url, 404);
    return { body: createReadStream(p), sizeBytes: statSync(p).size };
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new RegistryHttpError(url, res.status);
  if (!res.body) throw new Error(`empty response body for ${url}`);
  const len = res.headers.get('content-length');
  return {
    body: Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
    sizeBytes: len && /^\d+$/.test(len) ? Number(len) : null,
  };
}

export async function fetchRegistryText(url: string, timeoutMs = 15_000): Promise<string> {
  if (url.startsWith('file:')) {
    const p = fileUrlToPath(url);
    if (!existsSync(p) || !statSync(p).isFile()) throw new RegistryHttpError(url, 404);
    return readFile(p, 'utf8');
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new RegistryHttpError(url, res.status);
  return res.text();
}

/** `index.json`: every manifest the registry serves. Entries that fail to parse are reported, not dropped silently. */
export async function fetchRegistryIndex(
  registryUrl: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ models: ModelManifest[]; invalid: number }> {
  const url = registryObjectUrl(registryUrl, 'index.json');
  const raw = JSON.parse(await fetchRegistryText(url, opts.timeoutMs)) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${url} is not an array of manifests`);
  const models: ModelManifest[] = [];
  let invalid = 0;
  for (const entry of raw) {
    const parsed = modelManifestSchema.safeParse(entry);
    if (parsed.success) models.push(parsed.data);
    else invalid++;
  }
  models.sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name) || a.version - b.version);
  return { models, invalid };
}

/** The newest version of `family/name` the index lists, or null. */
export function newestInIndex(index: ModelManifest[], ref: ModelRef): ModelManifest | null {
  let best: ModelManifest | null = null;
  for (const m of index) {
    if (m.family !== ref.family || m.name !== ref.name) continue;
    if (ref.version !== undefined && m.version !== ref.version) continue;
    if (!best || m.version > best.version) best = m;
  }
  return best;
}

export function sha256OfFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export interface PullOptions {
  registryUrl: string;
  cacheDir: string;
  ref: ModelRef;
  /** Diagnostic lines (warnings). Default: none. */
  log?: (message: string) => void;
  /** Re-download even when the version is already cached. */
  force?: boolean;
  timeoutMs?: number;
}

export interface PullResult {
  ref: Required<ModelRef>;
  manifest: ModelManifest;
  /** `<cacheDir>/<family>/<name>/<version>` */
  dir: string;
  modelPath: string;
  sizeBytes: number;
  /** `verified` when the manifest declared a sha256 and it matched; `unverified` when it declared none. */
  integrity: 'verified' | 'unverified';
  /** True when nothing was downloaded because the version was already complete in the cache. */
  alreadyCached: boolean;
}

export class ModelIntegrityError extends Error {
  constructor(
    readonly ref: Required<ModelRef>,
    readonly file: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `${formatModelRef(ref)}: ${file} sha256 mismatch (manifest ${expected.slice(0, 12)}…, downloaded ${actual.slice(0, 12)}…); nothing kept`,
    );
    this.name = 'ModelIntegrityError';
  }
}

export class ModelNotInRegistryError extends Error {
  constructor(
    readonly ref: ModelRef,
    readonly registryUrl: string,
  ) {
    super(`model ${formatModelRef(ref)} is not in the registry ${displayUrl(registryUrl)} (see \`xwe models list\`)`);
    this.name = 'ModelNotInRegistryError';
  }
}

function versionComplete(dir: string): boolean {
  return existsSync(path.join(dir, 'manifest.json')) && existsSync(path.join(dir, 'model.onnx'));
}

/**
 * Downloads `manifest.json` and `model.onnx` for one model version into the
 * cache, verifying the manifest's `files["model.onnx"].sha256` (and
 * `sizeBytes`) as the bytes arrive. A mismatch deletes the download and
 * throws ModelIntegrityError; the cache never holds a half-written version
 * because `manifest.json` is written last and the model lands under a
 * temporary name until verified.
 */
export async function pullModel(opts: PullOptions): Promise<PullResult> {
  const { registryUrl, cacheDir, ref } = opts;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const log = opts.log ?? (() => {});

  // Which version: the pin, else the newest the index lists.
  let manifest: ModelManifest;
  if (ref.version !== undefined) {
    const url = registryObjectUrl(registryUrl, ref.family, ref.name, String(ref.version), 'manifest.json');
    let text: string;
    try {
      text = await fetchRegistryText(url, timeoutMs);
    } catch (err) {
      if (err instanceof RegistryHttpError && err.status === 404) throw new ModelNotInRegistryError(ref, registryUrl);
      throw err;
    }
    manifest = modelManifestSchema.parse(JSON.parse(text));
  } else {
    const { models } = await fetchRegistryIndex(registryUrl, { timeoutMs });
    const newest = newestInIndex(models, ref);
    if (!newest) throw new ModelNotInRegistryError(ref, registryUrl);
    // The index is a listing; the version directory's own manifest is authoritative.
    const url = registryObjectUrl(registryUrl, newest.family, newest.name, String(newest.version), 'manifest.json');
    manifest = modelManifestSchema.parse(JSON.parse(await fetchRegistryText(url, timeoutMs)));
  }
  if (manifest.family !== ref.family || manifest.name !== ref.name) {
    throw new Error(
      `registry ${displayUrl(registryUrl)} served a manifest for ${manifest.family}/${manifest.name} where ${formatModelRef(ref)} was expected`,
    );
  }
  const pinned: Required<ModelRef> = { family: manifest.family, name: manifest.name, version: manifest.version };
  const dir = path.join(cacheDir, pinned.family, pinned.name, String(pinned.version));
  const modelPath = path.join(dir, 'model.onnx');

  if (!opts.force && versionComplete(dir)) {
    const expected = manifest.files?.['model.onnx'];
    return {
      ref: pinned,
      manifest: modelManifestSchema.parse(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))),
      dir,
      modelPath,
      sizeBytes: statSync(modelPath).size,
      integrity: expected ? 'verified' : 'unverified',
      alreadyCached: true,
    };
  }

  mkdirSync(dir, { recursive: true });
  const partPath = path.join(dir, `model.onnx.part-${process.pid}`);
  const expected = manifest.files?.['model.onnx'];
  if (!expected) {
    log(`warning: ${formatModelRef(pinned)}: the manifest declares no files["model.onnx"].sha256; the download is not verified`);
  }
  const modelUrl = registryObjectUrl(registryUrl, pinned.family, pinned.name, String(pinned.version), 'model.onnx');
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    const { body } = await openObject(modelUrl, timeoutMs);
    await pipeline(
      body,
      async function* (source) {
        for await (const chunk of source) {
          const buf = chunk as Buffer;
          hash.update(buf);
          bytes += buf.length;
          yield buf;
        }
      },
      createWriteStream(partPath),
    );
  } catch (err) {
    rmSync(partPath, { force: true });
    if (err instanceof RegistryHttpError && err.status === 404) throw new ModelNotInRegistryError(pinned, registryUrl);
    throw err;
  }
  const actual = hash.digest('hex');
  if (expected) {
    if (actual !== expected.sha256) {
      rmSync(partPath, { force: true });
      throw new ModelIntegrityError(pinned, 'model.onnx', expected.sha256, actual);
    }
    if (bytes !== expected.sizeBytes) {
      rmSync(partPath, { force: true });
      throw new Error(
        `${formatModelRef(pinned)}: model.onnx is ${bytes} bytes, the manifest declares ${expected.sizeBytes}; nothing kept`,
      );
    }
  }
  renameSync(partPath, modelPath);
  // manifest.json last: a version is complete only when both files exist.
  const manifestPath = path.join(dir, 'manifest.json');
  const manifestTmp = `${manifestPath}.part-${process.pid}`;
  writeFileSync(manifestTmp, JSON.stringify(manifest, null, 2) + '\n');
  renameSync(manifestTmp, manifestPath);
  return {
    ref: pinned,
    manifest,
    dir,
    modelPath,
    sizeBytes: bytes,
    integrity: expected ? 'verified' : 'unverified',
    alreadyCached: false,
  };
}
