import type { EngineProgressSink, EngineSecretReader } from '../catalog/types';

/**
 * Secret hygiene for everything a run writes: any value an executor obtained
 * through the secrets seam is replaced with `[redacted]` in step summaries,
 * failure messages, events, captured records, progress messages and log
 * lines before they leave `runGraph`. Executors stay free to build URLs and
 * error strings with the key in them (a provider's URL scheme, a rejected
 * key echoed in a response body); the outcome the host persists never
 * carries it. The URL-encoded form of a value is scrubbed too, since
 * connectors put keys in query strings. Values shorter than
 * `MIN_SECRET_LENGTH` are not scrubbed (a one-letter "secret" would blank
 * ordinary text); real keys are far longer.
 *
 * A redactor with no recorded value is a no-op: graphs without connector or
 * VLM nodes pay nothing.
 */

export const REDACTED = '[redacted]';
export const MIN_SECRET_LENGTH = 6;

export interface Redactor {
  /** Register a value to scrub (idempotent; short values are ignored). */
  add(value: string): void;
  /** Number of registered patterns. */
  readonly size: number;
  /** Scrub one string. */
  text(input: string): string;
  /** Scrub every string inside a JSON-like value (arrays, plain objects); other values pass through. */
  deep<T>(value: T): T;
  /** A secrets seam whose answers are recorded here before they reach an executor. */
  wrapSecrets(reader: EngineSecretReader): EngineSecretReader;
  /** A progress sink that sees scrubbed messages (previews pass through untouched). */
  wrapProgress(sink: EngineProgressSink): EngineProgressSink;
}

export function createRedactor(initial: Iterable<string> = []): Redactor {
  // Longest first so a value that contains another is replaced whole.
  let patterns: string[] = [];
  const known = new Set<string>();

  const add = (value: string): void => {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) return;
    const forms = [value];
    const encoded = encodeURIComponent(value);
    if (encoded !== value) forms.push(encoded);
    let changed = false;
    for (const form of forms) {
      if (known.has(form)) continue;
      known.add(form);
      changed = true;
    }
    if (changed) patterns = [...known].sort((a, b) => b.length - a.length);
  };
  for (const v of initial) add(v);

  const text = (input: string): string => {
    if (patterns.length === 0 || typeof input !== 'string') return input;
    let out = input;
    for (const p of patterns) if (out.includes(p)) out = out.split(p).join(REDACTED);
    return out;
  };

  const deep = <T>(value: T): T => {
    if (patterns.length === 0) return value;
    return walk(value) as T;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !ArrayBuffer.isView(value)) {
      const proto = Object.getPrototypeOf(value);
      if (proto === Object.prototype || proto === null) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v);
        return out;
      }
    }
    return value;
  };

  return {
    add,
    get size() {
      return patterns.length;
    },
    text,
    deep,
    wrapSecrets(reader) {
      return {
        async getSecret(logicalName: string): Promise<string> {
          const value = await reader.getSecret(logicalName);
          add(value);
          return value;
        },
      };
    },
    wrapProgress(sink) {
      return {
        runStatus: (update) => sink.runStatus(deep(update)),
        step: (step) => sink.step(deep(step)),
        event: (event) => sink.event(deep(event)),
        ...(sink.record ? { record: (rec) => sink.record!(deep(rec)) } : {}),
        ...(sink.preview ? { preview: (nodeId, seq, jpeg) => sink.preview!(nodeId, seq, jpeg) } : {}),
      };
    },
  };
}

/** `https://user:token@host/path` -> `https://host/path`: registry URLs may carry credentials; logs must not. */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
      return u.toString().replace(/\/$/, url.endsWith('/') ? '/' : '');
    }
  } catch {
    // not a URL (a file path, a mirror directory): print as is
  }
  return url;
}
