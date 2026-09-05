import type { NodeExecutor, NodeTypeDef } from './types';
import { nodeTypeDefSchema } from './types';
import { buildPayloadFor, type PayloadPackGroup, type WorkflowCatalogPayload } from './serialize';

/**
 * Node packs and catalog instances (distribution design §3c, docs
 * workflows/extending). A pack is a versioned list of `{ def, executor }`
 * modules; a catalog is the validated registry built from a list of packs.
 * The core nodes are themselves packs (./index `corePacks`), so a host can
 * compose the engine without the pieces it cannot run, and a third-party pack
 * is registered next to them with no override of anything core.
 */

/** Namespaces (the part of `type` before the dot) only the core catalog may use. */
export const CORE_NAMESPACES = [
  'source',
  'video',
  'telemetry',
  'model',
  'logic',
  'output',
  'connector',
  'function',
] as const;

/** One node as a pack lists it: a def and its executor (a node module's exports). */
export interface NodePackNode {
  def: NodeTypeDef;
  executor: NodeExecutor;
}

export interface NodePack {
  /** The npm package name for a published pack; any non-empty string otherwise. */
  name: string;
  version: string;
  nodes: ReadonlyArray<NodePackNode>;
}

export interface CatalogEntry {
  def: NodeTypeDef;
  executor: NodeExecutor;
  /** The pack that registered the node. */
  pack: NodePack;
}

export interface Catalog {
  /** The packs this catalog was built from, in registration order. */
  readonly packs: ReadonlyArray<NodePack>;
  getNodeType(type: string): NodeTypeDef | undefined;
  getExecutor(type: string): NodeExecutor | undefined;
  getEntry(type: string): CatalogEntry | undefined;
  /** Every registered def, in registration order. */
  listNodeTypes(): NodeTypeDef[];
  /** The serialized catalog (cached); `catalogVersion` hashes every def, `packs[]` says which packs. */
  payload(): WorkflowCatalogPayload;
}

// Core packs are recognized by identity, not by name, so no third-party pack
// can claim a core namespace by calling itself "core/...". Only ./index marks.
const coreMarks = new WeakSet<NodePack>();

/** @internal Marks a pack as core (may use the core namespaces, collapses into the `core` payload entry). */
export function markCorePack<T extends NodePack>(pack: T): T {
  coreMarks.add(pack);
  return pack;
}

export function isCorePack(pack: NodePack): boolean {
  return coreMarks.has(pack);
}

export function namespaceOf(type: string): string {
  const dot = type.indexOf('.');
  return dot === -1 ? type : type.slice(0, dot);
}

export function isCoreNamespace(namespace: string): boolean {
  return (CORE_NAMESPACES as ReadonlyArray<string>).includes(namespace);
}

function describePack(pack: NodePack, index: number): string {
  return typeof pack?.name === 'string' && pack.name ? `pack "${pack.name}"` : `pack #${index + 1}`;
}

function assertPackShape(pack: NodePack, index: number): void {
  const label = describePack(pack, index);
  if (!pack || typeof pack !== 'object') {
    throw new Error(`createCatalog: ${label} is not a NodePack ({ name, version, nodes })`);
  }
  if (typeof pack.name !== 'string' || pack.name.length === 0) {
    throw new Error(`createCatalog: ${label} needs a non-empty string \`name\``);
  }
  if (typeof pack.version !== 'string' || pack.version.length === 0) {
    throw new Error(`createCatalog: ${label} needs a non-empty string \`version\``);
  }
  if (!Array.isArray(pack.nodes)) {
    throw new Error(`createCatalog: ${label} needs a \`nodes\` array of { def, executor }`);
  }
  pack.nodes.forEach((node, i) => {
    if (!node || typeof node !== 'object' || !node.def || typeof node.def !== 'object') {
      throw new Error(`createCatalog: ${label} node #${i + 1} has no \`def\``);
    }
    if (typeof node.executor !== 'function') {
      throw new Error(`createCatalog: ${label} node "${String(node.def.type)}" has no \`executor\` function`);
    }
  });
}

/** The def-level rules every node passes before it is registered (the same for core and packs). */
function validateDef(def: NodeTypeDef, pack: NodePack): void {
  const parsed = nodeTypeDefSchema.safeParse(def);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue?.path.length ? ` at "${issue.path.join('.')}"` : '';
    throw new Error(
      `Invalid NodeTypeDef "${def?.type}" in pack "${pack.name}"${at}: ${issue?.message ?? 'parse failed'}`,
    );
  }
  const namespace = namespaceOf(def.type);
  if (!isCorePack(pack) && isCoreNamespace(namespace)) {
    throw new Error(
      `Pack "${pack.name}": node type "${def.type}" uses the core namespace "${namespace}"; ` +
        `a pack picks its own namespace (reserved: ${CORE_NAMESPACES.join(', ')})`,
    );
  }
  // Port ids are unique per direction (edge handles are direction-scoped in
  // react-flow, so an input and an output may share an id, e.g. telemetry
  // pass-through nodes). json outputs must say what they produce.
  for (const ports of [def.inputs, def.outputs]) {
    const ids = new Set<string>();
    for (const port of ports) {
      if (ids.has(port.id)) throw new Error(`Duplicate port id "${port.id}" on "${def.type}"`);
      ids.add(port.id);
    }
  }
  for (const port of def.outputs) {
    if (port.channel === 'json' && !port.tag) {
      throw new Error(`json output "${port.id}" on "${def.type}" must declare a tag`);
    }
  }
  for (const constraint of def.constraints ?? []) {
    for (const portId of constraint.ports) {
      if (!def.inputs.some((p) => p.id === portId)) {
        throw new Error(`Constraint on "${def.type}" references unknown input port "${portId}"`);
      }
    }
  }
}

/**
 * Builds a catalog from packs, validating every definition the way the core
 * is validated. Throws, naming the offending node, on a malformed def, a
 * duplicate `type` (across packs too: no overrides), a duplicate port id
 * within one direction, a `json` output without a tag, or a non-core pack
 * using a core namespace.
 */
export function createCatalog(packs: ReadonlyArray<NodePack>): Catalog {
  if (!Array.isArray(packs)) throw new Error('createCatalog takes an array of packs');
  const registry = new Map<string, CatalogEntry>();
  const seenNames = new Map<string, number>();
  packs.forEach((pack, index) => {
    assertPackShape(pack, index);
    const previous = seenNames.get(pack.name);
    if (previous !== undefined) {
      throw new Error(`createCatalog: pack "${pack.name}" is registered twice (positions ${previous + 1} and ${index + 1})`);
    }
    seenNames.set(pack.name, index);
    for (const node of pack.nodes) {
      validateDef(node.def, pack);
      const existing = registry.get(node.def.type);
      if (existing) {
        throw new Error(
          `Duplicate catalog node type "${node.def.type}" (in pack "${existing.pack.name}" and pack "${pack.name}"); ` +
            'a pack cannot replace or override a node',
        );
      }
      registry.set(node.def.type, { def: node.def, executor: node.executor, pack });
    }
  });
  const frozenPacks: ReadonlyArray<NodePack> = Object.freeze([...packs]);

  let cachedPayload: WorkflowCatalogPayload | undefined;
  function payload(): WorkflowCatalogPayload {
    if (cachedPayload) return cachedPayload;
    // The core packs collapse into one `core` entry at the position of the
    // first core pack; every other pack is its own entry.
    const groups: PayloadPackGroup[] = [];
    let core: PayloadPackGroup | undefined;
    for (const pack of frozenPacks) {
      if (isCorePack(pack)) {
        if (!core) {
          core = { name: 'core', version: pack.version, defs: [] };
          groups.push(core);
        }
        core.defs.push(...pack.nodes.map((n) => n.def));
      } else {
        groups.push({ name: pack.name, version: pack.version, defs: pack.nodes.map((n) => n.def) });
      }
    }
    cachedPayload = buildPayloadFor(groups);
    return cachedPayload;
  }

  return {
    packs: frozenPacks,
    getNodeType: (type) => registry.get(type)?.def,
    getExecutor: (type) => registry.get(type)?.executor,
    getEntry: (type) => registry.get(type),
    listNodeTypes: () => [...registry.values()].map((e) => e.def),
    payload,
  };
}
