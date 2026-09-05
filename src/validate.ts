import type { WorkflowDefinition } from './schemas/workflows';
import { coreCatalog } from './catalog/index';
import { isCoreNamespace, namespaceOf, type Catalog } from './catalog/pack';
import type { NodeTypeDef, PortDef } from './catalog/types';
import { channelLabel, channelsCompatible } from './catalog/types';
import { DEFINITION_SCHEMA_VERSION, upgradeDefinition } from './compat';

/**
 * Publish-time validation (architecture.md §3.4). Draft saves stay permissive
 * (shape-valid only, schemas/workflows.ts); publish is strict: known types,
 * config parses, required ports connected, edges channel-valid, DAG, at least
 * one source and one output. Runs on the upgraded (v2) view of the definition;
 * the stored row is not rewritten. `catalog` is the node registry to validate
 * against (default: the core catalog; a host with packs passes its own).
 */

export interface ValidationIssue {
  code:
    | 'UNSUPPORTED_SCHEMA_VERSION'
    | 'EMPTY_DEFINITION'
    | 'DUPLICATE_NODE_ID'
    | 'UNKNOWN_NODE_TYPE'
    | 'INVALID_CONFIG'
    | 'BAD_EDGE'
    | 'UNKNOWN_PORT'
    | 'AMBIGUOUS_PORT'
    | 'CHANNEL_MISMATCH'
    | 'TOO_MANY_EDGES'
    | 'MISSING_INPUT'
    | 'CONSTRAINT_UNSATISFIED'
    | 'CYCLE'
    | 'NO_SOURCE'
    | 'NO_OUTPUT';
  message: string;
  nodeId?: string;
  edgeId?: string;
  portId?: string;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  /** The upgraded (v2) definition that was validated. */
  definition: WorkflowDefinition;
}

// Explicit handle wins; otherwise infer: a single port, or (for inputs) the
// single port channel-compatible with the resolved source port. v1-upgraded
// edges have null handles, so inference is what keeps them publishable.
// Exported for the engine core, which wires channels with the same rules.
export function resolvePort(
  ports: PortDef[],
  handle: string | null | undefined,
  compatibleWith?: PortDef,
): { port?: PortDef; error?: 'UNKNOWN_PORT' | 'AMBIGUOUS_PORT' } {
  if (handle) {
    const port = ports.find((p) => p.id === handle);
    return port ? { port } : { error: 'UNKNOWN_PORT' };
  }
  if (ports.length === 1) return { port: ports[0] };
  if (compatibleWith) {
    const candidates = ports.filter((p) => channelsCompatible(compatibleWith, p));
    if (candidates.length === 1) return { port: candidates[0] };
  }
  return ports.length === 0 ? { error: 'UNKNOWN_PORT' } : { error: 'AMBIGUOUS_PORT' };
}

/** An unknown type outside the core namespaces looks like a pack's node; say so. */
export function unknownNodeTypeMessage(type: string): string {
  const namespace = namespaceOf(type);
  if (!type.includes('.') || isCoreNamespace(namespace)) return `Unknown node type "${type}"`;
  return (
    `Unknown node type "${type}": namespace "${namespace}" is not in the core catalog; ` +
    `register its pack (--pack <module>, or createEngine({ packs }))`
  );
}

export function validateDefinitionForPublish(
  raw: WorkflowDefinition,
  catalog: Catalog = coreCatalog,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const version = raw.schemaVersion ?? 1;
  if (version > DEFINITION_SCHEMA_VERSION) {
    return {
      issues: [
        {
          code: 'UNSUPPORTED_SCHEMA_VERSION',
          message: `definition.schemaVersion ${version} is newer than this backend supports (${DEFINITION_SCHEMA_VERSION})`,
        },
      ],
      definition: raw,
    };
  }
  const def = upgradeDefinition(raw);

  if (def.nodes.length === 0) {
    return {
      issues: [{ code: 'EMPTY_DEFINITION', message: 'The workflow has no nodes' }],
      definition: def,
    };
  }

  // Nodes: unique ids, known types, parseable config.
  const nodeById = new Map<string, (typeof def.nodes)[number]>();
  const typeByNode = new Map<string, NodeTypeDef>();
  for (const node of def.nodes) {
    if (nodeById.has(node.id)) {
      issues.push({
        code: 'DUPLICATE_NODE_ID',
        nodeId: node.id,
        message: `Duplicate node id "${node.id}"`,
      });
      continue;
    }
    nodeById.set(node.id, node);
    const typeDef = catalog.getNodeType(node.type);
    if (!typeDef) {
      issues.push({
        code: 'UNKNOWN_NODE_TYPE',
        nodeId: node.id,
        message: unknownNodeTypeMessage(node.type),
      });
      continue;
    }
    typeByNode.set(node.id, typeDef);
    const parsed = typeDef.config.safeParse(node.data.config ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const at = issue?.path.length ? ` at "${issue.path.join('.')}"` : '';
      issues.push({
        code: 'INVALID_CONFIG',
        nodeId: node.id,
        message: `Invalid config for ${typeDef.label}${at}: ${issue?.message ?? 'parse failed'}`,
      });
    }
  }

  // Edges: endpoints exist, ports resolve, channels match, cardinality holds.
  const incomingByPort = new Map<string, number>(); // "<nodeId>:<portId>" -> edge count
  const validEdges: Array<{ source: string; target: string }> = [];
  for (const edge of def.edges) {
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);
    if (!sourceNode || !targetNode || edge.source === edge.target) {
      issues.push({
        code: 'BAD_EDGE',
        edgeId: edge.id,
        message: `Edge "${edge.id}" does not connect two distinct existing nodes`,
      });
      continue;
    }
    const sourceDef = typeByNode.get(edge.source);
    const targetDef = typeByNode.get(edge.target);
    // Unknown node types were already reported; skip their edges quietly.
    if (!sourceDef || !targetDef) continue;

    const out = resolvePort(sourceDef.outputs, edge.sourceHandle);
    if (!out.port) {
      issues.push({
        code: out.error!,
        edgeId: edge.id,
        nodeId: edge.source,
        portId: edge.sourceHandle ?? undefined,
        message:
          out.error === 'UNKNOWN_PORT'
            ? `Edge "${edge.id}": ${sourceDef.label} has no output port "${edge.sourceHandle ?? ''}"`
            : `Edge "${edge.id}": specify which ${sourceDef.label} output to connect`,
      });
      continue;
    }
    const inp = resolvePort(targetDef.inputs, edge.targetHandle, out.port);
    if (!inp.port) {
      issues.push({
        code: inp.error!,
        edgeId: edge.id,
        nodeId: edge.target,
        portId: edge.targetHandle ?? undefined,
        message:
          inp.error === 'UNKNOWN_PORT'
            ? `Edge "${edge.id}": ${targetDef.label} has no matching input port`
            : `Edge "${edge.id}": specify which ${targetDef.label} input to connect`,
      });
      continue;
    }
    if (!channelsCompatible(out.port, inp.port)) {
      issues.push({
        code: 'CHANNEL_MISMATCH',
        edgeId: edge.id,
        message: `Edge "${edge.id}": ${sourceDef.label} emits ${channelLabel(out.port)} but ${targetDef.label} "${inp.port.label}" accepts ${channelLabel(inp.port)}`,
      });
      continue;
    }
    const key = `${edge.target}:${inp.port.id}`;
    const count = (incomingByPort.get(key) ?? 0) + 1;
    incomingByPort.set(key, count);
    if (inp.port.cardinality === 'one' && count > 1) {
      issues.push({
        code: 'TOO_MANY_EDGES',
        edgeId: edge.id,
        nodeId: edge.target,
        portId: inp.port.id,
        message: `${targetDef.label} "${inp.port.label}" accepts a single connection`,
      });
      continue;
    }
    validEdges.push({ source: edge.source, target: edge.target });
  }

  // Required inputs + cross-port constraints (on known-type nodes only).
  for (const [nodeId, typeDef] of typeByNode) {
    for (const port of typeDef.inputs) {
      if (port.required && !incomingByPort.has(`${nodeId}:${port.id}`)) {
        issues.push({
          code: 'MISSING_INPUT',
          nodeId,
          portId: port.id,
          message: `${typeDef.label} input "${port.label}" must be connected`,
        });
      }
    }
    for (const constraint of typeDef.constraints ?? []) {
      if (!constraint.ports.some((portId) => incomingByPort.has(`${nodeId}:${portId}`))) {
        const labels = constraint.ports
          .map((portId) => typeDef.inputs.find((p) => p.id === portId)?.label ?? portId)
          .join(', ');
        issues.push({
          code: 'CONSTRAINT_UNSATISFIED',
          nodeId,
          message: `${typeDef.label} needs at least one of these inputs connected: ${labels}`,
        });
      }
    }
  }

  // DAG check (Kahn) over the structurally valid edges.
  const indegree = new Map<string, number>([...nodeById.keys()].map((id) => [id, 0]));
  const adjacency = new Map<string, string[]>();
  for (const { source, target } of validEdges) {
    indegree.set(target, (indegree.get(target) ?? 0) + 1);
    (adjacency.get(source) ?? adjacency.set(source, []).get(source)!).push(target);
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited++;
    for (const next of adjacency.get(id) ?? []) {
      const d = indegree.get(next)! - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (visited < nodeById.size) {
    issues.push({ code: 'CYCLE', message: 'The workflow graph contains a cycle' });
  }

  // Graph-level shape: at least one source and one output node.
  const groups = new Set([...typeByNode.values()].map((d) => d.group));
  if (!groups.has('source')) {
    issues.push({ code: 'NO_SOURCE', message: 'The workflow needs at least one source node' });
  }
  if (!groups.has('output')) {
    issues.push({ code: 'NO_OUTPUT', message: 'The workflow needs at least one output node' });
  }

  return { issues, definition: def };
}
