import { homedir } from 'node:os';
import * as path from 'node:path';

/**
 * Path presentation shared by the CLI and the local host's diagnostics: a
 * path under the working directory prints as `./x` (or `x` when asked bare),
 * one under the home directory as `~/x`, anything else absolute.
 */
export function displayPath(p: string, cwd: string = process.cwd(), opts: { bare?: boolean } = {}): string {
  const rel = path.relative(cwd, p);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return opts.bare ? rel : `./${rel}`;
  const home = homedir();
  if (p === home) return '~';
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/** The model cache root: `XWE_MODELS_DIR`, else `~/.xorgate/models`. */
export function modelCacheDir(env: NodeJS.ProcessEnv = process.env, baseDir: string = process.cwd()): string {
  const configured = env.XWE_MODELS_DIR;
  if (configured && configured.trim() !== '') {
    return path.isAbsolute(configured) ? configured : path.join(baseDir, configured);
  }
  return path.join(homedir(), '.xorgate', 'models');
}

/** `XWE_MODELS_PULL=1` (or `true`, `yes`, `on`) turns registry pulls on for runs. */
export function envPullEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.XWE_MODELS_PULL ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
