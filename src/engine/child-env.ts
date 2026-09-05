/**
 * The environment a child process (ffmpeg today; the function runtime later)
 * inherits: the parent's, minus every `XORGATE_SECRET_*` entry. Secrets reach
 * executors only through the secrets seam; a spawned binary never needs them
 * and must never see them.
 */

export const SECRET_ENV_PREFIX = 'XORGATE_SECRET_';

export function scrubSecretEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(SECRET_ENV_PREFIX)) continue;
    out[key] = value;
  }
  return out;
}
