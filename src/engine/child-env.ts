/**
 * The environment a child process (ffmpeg today; the function runtime later)
 * inherits: the parent's, minus every `XORGATE_SECRET_*` entry and every
 * `XWE_WEBHOOK_*` entry (webhook URLs and their signing secrets, 0.5.0).
 * Secrets reach executors only through the secrets seam; a spawned binary
 * never needs them and must never see them.
 */

export const SECRET_ENV_PREFIX = 'XORGATE_SECRET_';
/** `XWE_WEBHOOK_<NAME>` (a URL) and `XWE_WEBHOOK_SECRET_<NAME>` (its signing secret). */
export const WEBHOOK_ENV_PREFIX = 'XWE_WEBHOOK_';

export function scrubSecretEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(SECRET_ENV_PREFIX) || key.startsWith(WEBHOOK_ENV_PREFIX)) continue;
    out[key] = value;
  }
  return out;
}
