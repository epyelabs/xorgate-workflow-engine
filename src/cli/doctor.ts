import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { buildCatalogPayload } from '../catalog/index';
import { scrubSecretEnv } from '../engine/child-env';
import { canResolve, installedVersion, lazyRequire, ownPackageVersion } from '../engine/lazy-require';
import { displayUrl } from '../engine/redact';
import { displayPath } from '../local/paths';
import { fetchRegistryIndex, registryUrlFrom, RegistryHttpError } from '../local/registry-client';
import { defaultModelDirs, resolveFfmpeg } from '../local/target';

/**
 * `xwe doctor`: everything a run depends on, one line each, the fix on the
 * same line when something is absent. Exits non-zero when a required piece
 * (ffmpeg, the ONNX Runtime binding) is missing. The registry line reports
 * reachability but never fails the check: a run needs the registry only when
 * it pulls.
 */

export interface DoctorReport {
  lines: string[];
  ok: boolean;
}

const PAD = 18;
const row = (label: string, text: string): string => `  ${label.padEnd(PAD)}${text}`;

function ffmpegLine(env: NodeJS.ProcessEnv): { text: string; ok: boolean } {
  const resolved = resolveFfmpeg(env);
  if (!resolved) return { text: 'not found; set FFMPEG_PATH or install it', ok: false };
  let file = resolved;
  if (resolved === 'ffmpeg') {
    const which = spawnSync('which', ['ffmpeg'], { encoding: 'utf8', env: scrubSecretEnv(env) });
    if (which.status === 0 && which.stdout.trim()) file = which.stdout.trim();
  }
  const probe = spawnSync(resolved, ['-version'], { encoding: 'utf8', env: scrubSecretEnv(env) });
  if (probe.error || probe.status !== 0) {
    return { text: `${file} (does not run: ${probe.error?.message ?? `exit ${probe.status}`})`, ok: false };
  }
  const version = probe.stdout.match(/^ffmpeg version (\S+)/)?.[1] ?? 'unknown version';
  return { text: `${file} (${version})`, ok: true };
}

function ortLine(): { text: string; ok: boolean } {
  const version = installedVersion('onnxruntime-node');
  if (!version) {
    return { text: 'not installed; npm install onnxruntime-node (model nodes will fail)', ok: false };
  }
  try {
    const ort = lazyRequire<{ listSupportedBackends?: () => Array<{ name: string }> }>('onnxruntime-node');
    const backends = ort.listSupportedBackends?.() ?? [];
    const cpu = backends.some((b) => b.name === 'cpu');
    return cpu
      ? { text: `${version}, cpu binding loaded`, ok: true }
      : { text: `${version}, installed but no cpu binding for this platform`, ok: false };
  } catch (err) {
    return { text: `${version}, binding failed to load: ${err instanceof Error ? err.message : String(err)}`, ok: false };
  }
}

function vlmLine(): string {
  const clients = ['@anthropic-ai/sdk'].filter((pkg) => canResolve(pkg));
  if (clients.length === 0) return 'none installed; npm install @anthropic-ai/sdk for model.vlm';
  return `${clients.length} client${clients.length === 1 ? '' : 's'} installed`;
}

/** `<family>/<name>@<version>` for every complete model under a registry root. */
export function listModelsUnder(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  for (const family of readdirSync(root, { withFileTypes: true })) {
    if (!family.isDirectory()) continue;
    const familyDir = path.join(root, family.name);
    for (const name of readdirSync(familyDir, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const nameDir = path.join(familyDir, name.name);
      const versions = readdirSync(nameDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
        .map((e) => Number(e.name))
        .sort((a, b) => a - b);
      for (const v of versions) {
        const dir = path.join(nameDir, String(v));
        if (existsSync(path.join(dir, 'manifest.json')) && existsSync(path.join(dir, 'model.onnx'))) {
          out.push(`${family.name}/${name.name}@${v}`);
        }
      }
    }
  }
  return out;
}

function modelsLines(roots: string[], cwd: string): string[] {
  return roots.map((root, i) => {
    const label = i === 0 ? 'models' : '';
    if (!existsSync(root)) return row(label, `${displayPath(root, cwd)} (not present)`);
    const models = listModelsUnder(root);
    const summary =
      models.length === 0 ? 'empty' : `${models.length} cached: ${models.join(', ')}`;
    return row(label, `${displayPath(root, cwd)} (${summary})`);
  });
}

/** `https://models.xorgate.io (index: 4 models)`, or the reason it could not be read. */
async function registryLine(env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  let registry: string;
  try {
    registry = registryUrlFrom(env);
  } catch (err) {
    return `not usable: ${err instanceof Error ? err.message : String(err)}`;
  }
  const url = displayUrl(registry);
  try {
    const { models, invalid } = await fetchRegistryIndex(registry, { timeoutMs });
    const extra = invalid > 0 ? `, ${invalid} unparseable` : '';
    return `${url} (index: ${models.length} model${models.length === 1 ? '' : 's'}${extra})`;
  } catch (err) {
    if (err instanceof RegistryHttpError) return `${url} (index.json: HTTP ${err.status})`;
    const cause = err instanceof Error ? ((err as { cause?: { code?: string } }).cause?.code ?? err.message) : String(err);
    return `${url} (unreachable: ${cause})`;
  }
}

export async function doctorReport(
  opts: { modelDirs?: string[]; env?: NodeJS.ProcessEnv; cwd?: string; registryTimeoutMs?: number } = {},
): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const lines: string[] = [];
  let ok = true;

  lines.push(`xwe ${ownPackageVersion()} (node ${process.versions.node}, ${process.platform} ${process.arch})`);

  const ffmpeg = ffmpegLine(env);
  ok &&= ffmpeg.ok;
  lines.push(row('ffmpeg', ffmpeg.text));

  const ort = ortLine();
  ok &&= ort.ok;
  lines.push(row('onnxruntime-node', ort.text));

  lines.push(row('vlm providers', vlmLine()));

  const explicit = (opts.modelDirs ?? []).map((d) => (path.isAbsolute(d) ? d : path.join(cwd, d)));
  lines.push(...modelsLines([...explicit, ...defaultModelDirs(cwd, env)], cwd));

  lines.push(row('registry', await registryLine(env, opts.registryTimeoutMs ?? 5_000)));

  const payload = buildCatalogPayload();
  lines.push(row('catalog', `${payload.nodes.length} nodes, core ${payload.catalogVersion}, no packs`));

  return { lines, ok };
}
