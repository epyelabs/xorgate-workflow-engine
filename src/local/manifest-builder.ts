import { readFileSync } from 'node:fs';
import type { WorkflowDefinition } from '../schemas/workflows';
import { workflowDefinitionSchema } from '../schemas/workflows';
import { upgradeDefinition } from '../compat';
import { validateDefinitionForPublish, type ValidationIssue } from '../validate';
import { getNodeType, capabilityTokensForNode } from '../catalog/index';
import { runManifestSchema, runPrefix, type RunManifest } from '../engine/manifest';
import type { EngineSourceBinding } from '../catalog/types';

/**
 * The local equivalent of the cloud dispatcher: template + `--input name=path`
 * pairs -> a v2 run manifest. Bindings reuse the EXISTING kinds so the copied
 * executors stay verbatim:
 *
 * - source.video  -> `video_local` { path } (in-core local-file support)
 * - source.telemetry -> `telemetry_csv` { s3Key: <path> } for .csv, or
 *   `telemetry_materialized` { s3Key: <path> } for .jsonl ({ts,signals} lines);
 *   the local fetchText seam resolves s3Key as a local path.
 */

/** A template file: a bare definition, or an API snapshot wrapping one. */
export function loadDefinition(templatePath: string): WorkflowDefinition {
  const raw = JSON.parse(readFileSync(templatePath, 'utf8')) as Record<string, unknown>;
  const candidate = (raw.definition ?? raw) as unknown;
  const parsed = workflowDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `${templatePath} is not a workflow definition: ${parsed.error.issues[0]?.message ?? 'parse failed'}`,
    );
  }
  return upgradeDefinition(parsed.data);
}

export interface TemplateInfo {
  definition: WorkflowDefinition;
  issues: ValidationIssue[];
  /** Source nodes that accept a run-manifest input binding. */
  sources: Array<{ nodeId: string; type: string; label: string; inputKey: string }>;
  /** Capability tokens across the graph (secret:*, media, ...). */
  requires: string[];
}

/** `--input` shorthand per source type: video=..., telemetry=... */
const INPUT_KEY_BY_TYPE: Record<string, string> = {
  'source.video': 'video',
  'source.telemetry': 'telemetry',
};

export function inspectTemplate(definition: WorkflowDefinition): TemplateInfo {
  const { issues } = validateDefinitionForPublish(definition);
  const sources: TemplateInfo['sources'] = [];
  const requires = new Set<string>();
  const shorthandCounts = new Map<string, number>();
  for (const node of definition.nodes) {
    const def = getNodeType(node.type);
    if (!def) continue;
    for (const token of capabilityTokensForNode(def, node.data.config ?? {})) requires.add(token);
    // Bindable sources are the true feed nodes: source-group with no input
    // ports. (connector.third_party is group "source" but is fed by an edge,
    // not a manifest binding.)
    if (def.group === 'source' && def.inputs.length === 0) {
      const key = INPUT_KEY_BY_TYPE[node.type] ?? node.id;
      shorthandCounts.set(key, (shorthandCounts.get(key) ?? 0) + 1);
      sources.push({ nodeId: node.id, type: node.type, label: node.data.label ?? node.id, inputKey: key });
    }
  }
  // Two sources of one type: the shorthand is ambiguous, fall back to node ids.
  for (const s of sources) {
    if ((shorthandCounts.get(s.inputKey) ?? 0) > 1) s.inputKey = s.nodeId;
  }
  return { definition, issues, sources, requires: [...requires].sort() };
}

function bindingFor(nodeType: string, filePath: string): EngineSourceBinding {
  if (nodeType === 'source.video') {
    return { kind: 'video_local', path: filePath };
  }
  if (nodeType === 'source.telemetry') {
    return /\.jsonl$/i.test(filePath)
      ? { kind: 'telemetry_materialized', s3Key: filePath }
      : { kind: 'telemetry_csv', s3Key: filePath };
  }
  throw new Error(`No local binding rule for source type "${nodeType}"`);
}

export interface BuildManifestArgs {
  definition: WorkflowDefinition;
  /** `--input key=path` pairs; key = shorthand (video/telemetry) or nodeId. */
  inputs: Record<string, string>;
  runId: string;
  window?: { from: string; to: string } | null;
}

export function buildLocalManifest(args: BuildManifestArgs): RunManifest {
  const info = inspectTemplate(args.definition);
  if (info.issues.length > 0) {
    const first = info.issues[0];
    throw new Error(
      `Template does not validate (${info.issues.length} issue(s)); first: ` +
        `${first.code}${first.nodeId ? ` at ${first.nodeId}` : ''}: ${first.message}`,
    );
  }
  const unmatched = new Set(Object.keys(args.inputs));
  const inputs: RunManifest['inputs'] = [];
  const missing: string[] = [];
  for (const source of info.sources) {
    const filePath = args.inputs[source.inputKey] ?? args.inputs[source.nodeId];
    if (filePath === undefined) {
      missing.push(`${source.inputKey} (${source.type} "${source.label}")`);
      continue;
    }
    unmatched.delete(source.inputKey);
    unmatched.delete(source.nodeId);
    inputs.push({ nodeId: source.nodeId, binding: bindingFor(source.type, filePath) });
  }
  if (missing.length > 0) {
    throw new Error(`Missing --input for: ${missing.join(', ')}`);
  }
  if (unmatched.size > 0) {
    throw new Error(
      `--input key(s) match no source node: ${[...unmatched].join(', ')} ` +
        `(expected: ${info.sources.map((s) => s.inputKey).join(', ') || 'none — this graph has no sources'})`,
    );
  }
  return runManifestSchema.parse({
    manifestVersion: 2,
    runId: args.runId,
    mode: 'batch',
    deviceId: null,
    window: args.window ?? null,
    definition: args.definition,
    inputs,
    output: { bucket: 'local', prefix: runPrefix(args.runId) },
    limits: {},
  });
}
