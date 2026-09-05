import { createHash } from 'node:crypto';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { DEFINITION_SCHEMA_VERSION, POC_TYPE_ALIASES } from '../compat';
import type { CapabilityRule, NodeConstraint, NodeGroup, NodeTypeDef, PortDef } from './types';
import { NODE_GROUPS } from './types';

/**
 * The GET /workflow-catalog wire format. This is the contract the FE palette,
 * config forms, and edge validation consume; publish validation on the backend
 * is derived from the same defs, so the two cannot drift.
 *
 * This module is pure: it turns defs into the payload and never touches the
 * registry. `buildCatalogPayload()` (./index) applies it to the core catalog;
 * `Catalog.payload()` (./pack) to any catalog instance.
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

/**
 * One registered pack as the payload reports it (distribution M4, additive).
 * `hash` is the `catalogVersion` a catalog holding only this pack would have,
 * so the `core` entry equals the frozen core hash whenever every core pack is
 * registered, whatever else is.
 */
export interface CatalogPackInfo {
  name: string;
  version: string;
  hash: string;
}

export interface WorkflowCatalogPayload {
  /** Content hash of every registered node definition, in order; doubles as the ETag. */
  catalogVersion: string;
  /** definition.schemaVersion this catalog authors (2). */
  schemaVersion: number;
  /** PoC v1 node type -> catalog type (upgradeDefinition's type mapping). */
  aliases: Record<string, string>;
  nodes: SerializedNodeTypeDef[];
  /**
   * The packs behind `nodes`, in registration order; the core packs collapse
   * into one `core` entry. Additive: `catalogVersion` is computed over the
   * fields above it and does not cover this list.
   */
  packs: CatalogPackInfo[];
}

// zodToJsonSchema's generic blows the instantiation depth on an opaque
// ZodTypeAny; call it through a plainly-typed alias instead.
const toJsonSchema = zodToJsonSchema as (
  schema: unknown,
  options?: { $refStrategy?: 'none' },
) => Record<string, unknown>;

export function serializeNode(def: NodeTypeDef): SerializedNodeTypeDef {
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

const groupOrder = new Map<NodeGroup, number>(NODE_GROUPS.map((g, i) => [g, i]));

/** Payload order: by group (NODE_GROUPS order), then by label. */
function sortSerialized(nodes: SerializedNodeTypeDef[]): SerializedNodeTypeDef[] {
  return [...nodes].sort(
    (a, b) =>
      (groupOrder.get(a.group)! - groupOrder.get(b.group)!) || a.label.localeCompare(b.label),
  );
}

/** The hashed body: schema version, aliases and the sorted nodes. `packs` is outside it. */
function hashOf(nodes: SerializedNodeTypeDef[]): string {
  const body = { schemaVersion: DEFINITION_SCHEMA_VERSION, aliases: POC_TYPE_ALIASES, nodes };
  return createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
}

/** A named set of defs to report as one `packs[]` entry. */
export interface PayloadPackGroup {
  name: string;
  version: string;
  defs: NodeTypeDef[];
}

/** The payload for a list of pack groups; the hash of everything, plus one hash per group. */
export function buildPayloadFor(groups: PayloadPackGroup[]): WorkflowCatalogPayload {
  const serialized = groups.map((g) => ({ ...g, nodes: sortSerialized(g.defs.map(serializeNode)) }));
  const packs: CatalogPackInfo[] = serialized.map((g) => ({ name: g.name, version: g.version, hash: hashOf(g.nodes) }));
  const nodes = sortSerialized(serialized.flatMap((g) => g.nodes));
  return {
    catalogVersion: hashOf(nodes),
    schemaVersion: DEFINITION_SCHEMA_VERSION,
    aliases: POC_TYPE_ALIASES,
    nodes,
    packs,
  };
}
