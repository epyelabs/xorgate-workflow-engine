import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { displayUrl } from '../engine/redact';
import { checkModelDir, formatModelCheckLine } from '../local/check-model';
import { formatModelRef, parseModelSpec } from '../local/model-ref';
import { createModelChain, formatBytes, ModelNotFoundError, type ModelChain } from '../local/models';
import { displayPath, modelCacheDir } from '../local/paths';
import {
  fetchRegistryIndex,
  ModelIntegrityError,
  ModelNotInRegistryError,
  pullModel,
  RegistryHttpError,
  registryUrlFrom,
} from '../local/registry-client';

/**
 * `xwe models list | pull | path | check` (models.mdx "xwe models", "Check
 * the directory"). Exit codes follow the CLI's: 0 ok, 1 the operation failed
 * (checksum mismatch, model not found, check failed), 2 usage.
 */

export const MODELS_USAGE = `usage:
  xwe models list                                  the registry index, marking what is cached
  xwe models pull <family>/<name>[@<version>]      download into the cache, checksum verified
  xwe models path <family>/<name>[@<version>]      what a run would load, and from which root
  xwe models check <dir>                           validate a model directory (manifest, model, session, output)

options:
  --models-dir <dir>     extra registry root(s), searched before the cache (list, path)
  --force                pull again even when the version is cached (pull)
  --no-fill              do not write files.sha256/sizeBytes into manifest.json (check)

environment:
  XWE_MODEL_REGISTRY     registry URL (default https://models.xorgate.io)
  XWE_MODELS_DIR         cache root (default ~/.xorgate/models)`;

export class ModelsUsageError extends Error {
  readonly exitCode = 2;
}

function usage(message: string): never {
  throw new ModelsUsageError(`${message}\n${MODELS_USAGE}`);
}

interface ModelsContext {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

function chainFor(modelDirs: string[], ctx: ModelsContext, pull: boolean): ModelChain {
  const abs = (p: string): string => (path.isAbsolute(p) ? p : path.join(ctx.cwd, p));
  return createModelChain({
    modelDirs: modelDirs.map(abs),
    cacheDir: modelCacheDir(ctx.env, ctx.cwd),
    registryUrl: registryUrlFrom(ctx.env),
    pull,
    cwd: ctx.cwd,
    log: (m) => ctx.stderr(`[xwe] ${m}`),
  });
}

function registryFailure(err: unknown, registry: string): string {
  const registryUrl = displayUrl(registry);
  if (err instanceof RegistryHttpError) return `registry ${registryUrl}: ${err.message}`;
  if (err instanceof Error) {
    const code = (err as { cause?: { code?: string } }).cause?.code;
    return `registry ${registryUrl} is unreachable: ${code ?? err.message}`;
  }
  return `registry ${registryUrl}: ${String(err)}`;
}

async function cmdList(modelDirs: string[], ctx: ModelsContext): Promise<number> {
  const chain = chainFor(modelDirs, ctx, false);
  let index;
  try {
    index = await fetchRegistryIndex(chain.registryUrl);
  } catch (err) {
    ctx.stderr(`xwe: ${registryFailure(err, chain.registryUrl)}`);
    return 1;
  }
  const { models, invalid } = index;
  ctx.stdout(
    `registry ${displayUrl(chain.registryUrl)} (${models.length} model${models.length === 1 ? '' : 's'}${invalid > 0 ? `, ${invalid} unparseable entr${invalid === 1 ? 'y' : 'ies'} skipped` : ''})`,
  );
  const rows = models.map((m) => {
    const spec = `${m.family}/${m.name}@${m.version}`;
    const local = chain.locate({ family: m.family, name: m.name, version: m.version });
    const size = m.files?.['model.onnx'] ? formatBytes(m.files['model.onnx'].sizeBytes) : '';
    const where = local ? `cached (${displayPath(local.root, ctx.cwd)})` : '';
    return { spec, label: m.label ?? '', size, where };
  });
  const w1 = Math.max(5, ...rows.map((r) => r.spec.length));
  const w2 = Math.max(5, ...rows.map((r) => r.label.length));
  const w3 = Math.max(4, ...rows.map((r) => r.size.length));
  for (const r of rows) {
    ctx.stdout(`  ${r.spec.padEnd(w1)}  ${r.label.padEnd(w2)}  ${r.size.padStart(w3)}  ${r.where}`.trimEnd());
  }
  return 0;
}

async function cmdPull(spec: string | undefined, force: boolean, ctx: ModelsContext): Promise<number> {
  if (!spec) usage('pull needs <family>/<name>[@<version>]');
  let ref;
  try {
    ref = parseModelSpec(spec);
  } catch (err) {
    usage(err instanceof Error ? err.message : String(err));
  }
  const registryUrl = registryUrlFrom(ctx.env);
  const cacheDir = modelCacheDir(ctx.env, ctx.cwd);
  try {
    const pulled = await pullModel({ registryUrl, cacheDir, ref, force, log: (m) => ctx.stderr(`[xwe] ${m}`) });
    const dir = displayPath(pulled.dir, ctx.cwd);
    if (pulled.alreadyCached) {
      ctx.stdout(`${formatModelRef(pulled.ref)} already in ${dir} (model.onnx ${formatBytes(pulled.sizeBytes)})`);
    } else {
      const integrity = pulled.integrity === 'verified' ? 'sha256 verified' : 'no checksum in manifest, not verified';
      ctx.stdout(`pulled ${formatModelRef(pulled.ref)} -> ${dir} (model.onnx ${formatBytes(pulled.sizeBytes)}, ${integrity})`);
    }
    return 0;
  } catch (err) {
    if (err instanceof ModelIntegrityError || err instanceof ModelNotInRegistryError) {
      ctx.stderr(`xwe: ${err.message}`);
      return 1;
    }
    ctx.stderr(`xwe: ${registryFailure(err, registryUrl)}`);
    return 1;
  }
}

async function cmdPath(spec: string | undefined, modelDirs: string[], ctx: ModelsContext): Promise<number> {
  if (!spec) usage('path needs <family>/<name>[@<version>]');
  let ref;
  try {
    ref = parseModelSpec(spec);
  } catch (err) {
    usage(err instanceof Error ? err.message : String(err));
  }
  const chain = chainFor(modelDirs, ctx, false);
  const hit = chain.locate(ref);
  if (!hit) {
    ctx.stderr(`xwe: ${ModelNotFoundError.message(ref, chain.roots.map((r) => displayPath(r, ctx.cwd)), null)}`);
    return 1;
  }
  ctx.stdout(hit.modelPath);
  const from = hit.via === 'cache' ? `the cache (${displayPath(hit.root, ctx.cwd)})` : `--models-dir ${displayPath(hit.root, ctx.cwd)}`;
  ctx.stdout(`  ${hit.ref.family}/${hit.ref.name} v${hit.ref.version}, from ${from}`);
  return 0;
}

async function cmdCheck(dir: string | undefined, fill: boolean, ctx: ModelsContext): Promise<number> {
  if (!dir) usage('check needs a model directory (<root>/<family>/<name>/<version>)');
  const report = await checkModelDir(path.isAbsolute(dir) ? dir : path.join(ctx.cwd, dir), { fill });
  for (const line of report.lines) ctx.stdout(formatModelCheckLine(line));
  return report.ok ? 0 : 1;
}

export async function runModelsCommand(argv: string[], ctx: Partial<ModelsContext> = {}): Promise<number> {
  const full: ModelsContext = {
    env: ctx.env ?? process.env,
    cwd: ctx.cwd ?? process.cwd(),
    stdout: ctx.stdout ?? ((line) => console.log(line)),
    stderr: ctx.stderr ?? ((line) => console.error(line)),
  };
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === '--help' || sub === 'help') {
    full.stdout(MODELS_USAGE);
    return sub === undefined ? 2 : 0;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      'models-dir': { type: 'string', multiple: true },
      force: { type: 'boolean' },
      'no-fill': { type: 'boolean' },
    },
  });
  const modelDirs = values['models-dir'] ?? [];
  switch (sub) {
    case 'list':
      return cmdList(modelDirs, full);
    case 'pull':
      return cmdPull(positionals[0], values.force === true, full);
    case 'path':
      return cmdPath(positionals[0], modelDirs, full);
    case 'check':
      return cmdCheck(positionals[0], values['no-fill'] !== true, full);
    default:
      usage(`unknown models subcommand "${sub}"`);
  }
}
