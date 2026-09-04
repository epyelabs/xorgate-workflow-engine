import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { buildCatalogPayload } from '../catalog/serialize';
import { canResolve, installedVersion, lazyRequire, ownPackageVersion } from '../engine/lazy-require';
import { defaultModelDirs, resolveFfmpeg } from '../local/target';

/**
 * `xwe doctor`: everything a run depends on, one line each, the fix on the
 * same line when something is absent. Exits non-zero when a required piece
 * (ffmpeg, the ONNX Runtime binding) is missing.
 */

export interface DoctorReport {
  lines: string[];
  ok: boolean;
}

const PAD = 18;
const row = (label: string, text: string): string => `  ${label.padEnd(PAD)}${text}`;

/** Roots under the working directory print as `./x`, under home as `~/x`, else absolute. */
function display(p: string, cwd: string): string {
  const rel = path.relative(cwd, p);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return `./${rel}`;
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function ffmpegLine(env: NodeJS.ProcessEnv): { text: string; ok: boolean } {
  const resolved = resolveFfmpeg(env);
  if (!resolved) return { text: 'not found; set FFMPEG_PATH or install it', ok: false };
  let file = resolved;
  if (resolved === 'ffmpeg') {
    const which = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
    if (which.status === 0 && which.stdout.trim()) file = which.stdout.trim();
  }
  const probe = spawnSync(resolved, ['-version'], { encoding: 'utf8' });
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
    if (!existsSync(root)) return row(label, `${display(root, cwd)} (not present)`);
    const models = listModelsUnder(root);
    const summary =
      models.length === 0 ? 'empty' : `${models.length} cached: ${models.join(', ')}`;
    return row(label, `${display(root, cwd)} (${summary})`);
  });
}

export function doctorReport(opts: { modelDirs?: string[]; env?: NodeJS.ProcessEnv; cwd?: string } = {}): DoctorReport {
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
  lines.push(...modelsLines([...explicit, ...defaultModelDirs(cwd)], cwd));

  lines.push(row('registry', 'not configured'));

  const payload = buildCatalogPayload();
  lines.push(row('catalog', `${payload.nodes.length} nodes, core ${payload.catalogVersion}, no packs`));

  return { lines, ok };
}
