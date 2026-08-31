import { createHash } from 'node:crypto';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { DEFINITION_SCHEMA_VERSION, POC_TYPE_ALIASES } from '../compat';
import { listNodeTypes } from './index';
import type { CapabilityRule, NodeConstraint, NodeGroup, NodeTypeDef, PortDef } from './types';
import { NODE_GROUPS } from './types';

/**
 * The GET /workflow-catalog wire format. This is the contract the FE palette,
 * config forms, and edge validation consume; publish validation on the backend
 * is derived from the same defs, so the two cannot drift.
 */

export interface SerializedNodeTypeDef {
  type: string;
  version: number;
  group: NodeGroup;
  label: string;
  description: string;
  ui: NodeTypeDef['ui'];
  inputs: PortDef[];
  outputs: PortDef[];
  /** JSON Schema (draft-07) for the node config, from the server-side zod. */
  configSchema: Record<string, unknown>;
  /** Config produced by parsing {} (all defaults); {} when config has required fields. */
  configDefaults: Record<string, unknown>;
  requires: CapabilityRule[];
  runtime: NodeTypeDef['runtime'];
  constraints?: NodeConstraint[];
}

export interface WorkflowCatalogPayload {
  /** Content hash of the payload; doubles as the ETag. */
  catalogVersion: string;
  /** definition.schemaVersion this catalog authors (2). */
  schemaVersion: number;
  /** PoC v1 node type -> catalog type (upgradeDefinition's type mapping). */
  aliases: Record<string, string>;
  nodes: SerializedNodeTypeDef[];
}

// zodToJsonSchema's generic blows the instantiation depth on an opaque
// ZodTypeAny; call it through a plainly-typed alias instead.
const toJsonSchema = zodToJsonSchema as (
  schema: unknown,
  options?: { $refStrategy?: 'none' },
) => Record<string, unknown>;

function serializeNode(def: NodeTypeDef): SerializedNodeTypeDef {
  const configSchema = toJsonSchema(def.config, { $refStrategy: 'none' });
  delete configSchema.$schema;
  const defaults = def.config.safeParse({});
  return {
    type: def.type,
    version: def.version,
    group: def.group,
    label: def.label,
    description: def.description,
    ui: def.ui,
    inputs: def.inputs,
    outputs: def.outputs,
    configSchema,
    configDefaults: defaults.success ? (defaults.data as Record<string, unknown>) : {},
    requires: def.requires,
    runtime: def.runtime,
    ...(def.constraints ? { constraints: def.constraints } : {}),
  };
}

let cached: WorkflowCatalogPayload | undefined;

export function buildCatalogPayload(): WorkflowCatalogPayload {
  if (cached) return cached;
  const groupOrder = new Map(NODE_GROUPS.map((g, i) => [g, i]));
  const nodes = listNodeTypes()
    .map(serializeNode)
    .sort(
      (a, b) =>
        (groupOrder.get(a.group)! - groupOrder.get(b.group)!) || a.label.localeCompare(b.label),
    );
  const body = { schemaVersion: DEFINITION_SCHEMA_VERSION, aliases: POC_TYPE_ALIASES, nodes };
  const catalogVersion = createHash('sha256')
    .update(JSON.stringify(body))
    .digest('hex')
    .slice(0, 16);
  cached = { catalogVersion, ...body };
  return cached;
}
