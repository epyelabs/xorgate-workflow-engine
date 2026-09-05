/**
 * Model references as the CLI, node config and the resolvers spell them:
 *
 *   <family>/<name>          newest version
 *   <family>/<name>@<n>      pinned version
 *
 * Node config carries only `<name>[@<n>]`; the executor supplies the family
 * through the `fetchModel` seam (its signature is frozen), so the pin rides
 * inside the `name` string and is split here.
 */

export interface ModelRef {
  family: string;
  name: string;
  /** Pinned version, or undefined for "newest available". */
  version?: number;
}

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parseVersionSuffix(raw: string, what: string): { base: string; version?: number } {
  const at = raw.lastIndexOf('@');
  if (at === -1) return { base: raw };
  const base = raw.slice(0, at);
  const versionText = raw.slice(at + 1);
  if (!/^\d+$/.test(versionText) || Number(versionText) < 1) {
    throw new Error(`${what} "${raw}": the version after "@" must be a positive integer`);
  }
  return { base, version: Number(versionText) };
}

/** `name[@version]` as node config carries it, with the family the node asked for. */
export function parseModelName(family: string, rawName: string): ModelRef {
  const { base, version } = parseVersionSuffix(rawName.trim(), 'model');
  if (!SEGMENT_RE.test(base)) throw new Error(`model "${rawName}": not a valid model name`);
  if (!SEGMENT_RE.test(family)) throw new Error(`model family "${family}" is not valid`);
  return version === undefined ? { family, name: base } : { family, name: base, version };
}

/** `<family>/<name>[@version]` as the CLI takes it. */
export function parseModelSpec(spec: string): ModelRef {
  const trimmed = spec.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1 || trimmed.indexOf('/', slash + 1) !== -1) {
    throw new Error(`model "${spec}": expected <family>/<name>[@<version>], for example detection/yolov8n@1`);
  }
  return parseModelName(trimmed.slice(0, slash), trimmed.slice(slash + 1));
}

/** `detection/yolov8n` or `detection/yolov8n@1`. */
export function formatModelRef(ref: ModelRef): string {
  return ref.version === undefined ? `${ref.family}/${ref.name}` : `${ref.family}/${ref.name}@${ref.version}`;
}
