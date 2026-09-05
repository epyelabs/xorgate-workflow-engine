import type { NodeTypeDef } from './types';
import { createCatalog, markCorePack, type Catalog, type NodePack, type NodePackNode } from './pack';
import type { WorkflowCatalogPayload } from './serialize';
import { ownPackageVersion } from '../engine/lazy-require';

import * as connectorThirdParty from './nodes/connector-third-party';
import * as logicBoolean from './nodes/logic-boolean';
import * as logicComparator from './nodes/logic-comparator';
import * as logicDebounce from './nodes/logic-debounce';
import * as logicDetectionGate from './nodes/logic-detection-gate';
import * as logicProximityGate from './nodes/logic-proximity-gate';
import * as logicThreshold from './nodes/logic-threshold';
import * as modelDepth from './nodes/model-depth';
import * as modelObjectDetection from './nodes/model-object-detection';
import * as modelSegmentation from './nodes/model-segmentation';
import * as modelVlm from './nodes/model-vlm';
import * as outputDataCapture from './nodes/output-data-capture';
import * as outputEvent from './nodes/output-event';
import * as outputVisualization from './nodes/output-visualization';
import * as sourceTelemetry from './nodes/source-telemetry';
import * as sourceVideo from './nodes/source-video';
import * as telemetryDerivative from './nodes/telemetry-derivative';
import * as telemetryEma from './nodes/telemetry-ema';
import * as telemetryGeofence from './nodes/telemetry-geofence';
import * as telemetryKalman from './nodes/telemetry-kalman';
import * as telemetryOutlierRemoval from './nodes/telemetry-outlier-removal';
import * as telemetryResample from './nodes/telemetry-resample';
import * as telemetryTimeAlign from './nodes/telemetry-time-align';
import * as telemetryWindowAggregate from './nodes/telemetry-window-aggregate';
import * as videoDecodeSample from './nodes/video-decode-sample';
import * as videoScale from './nodes/video-scale';

/**
 * The node catalog registry: the single source of truth for node types
 * (architecture.md §3). The core nodes are seven packs, one per namespace,
 * built into `coreCatalog` at module load; a broken def fails cold start
 * loudly rather than serving a bad catalog. The module-level functions below
 * are the core catalog's, for the callers that never compose packs; every
 * engine entry point also takes a catalog instance (./pack `createCatalog`).
 */

export type { CatalogEntry } from './pack';

const CORE_VERSION = ownPackageVersion();

function corePack(namespace: string, nodes: NodePackNode[]): NodePack {
  return markCorePack(Object.freeze({ name: `core/${namespace}`, version: CORE_VERSION, nodes: Object.freeze(nodes) }));
}

/**
 * The seven core packs, one per core namespace, in the registry's historical
 * order (so `listNodeTypes()` lists the 26 nodes as it always has). Compose a
 * subset with `createCatalog` for a host that cannot run a group, for example
 * every pack but `core/model` on a target without ONNX Runtime.
 */
export const corePacks: ReadonlyArray<NodePack> = Object.freeze([
  corePack('source', [sourceVideo, sourceTelemetry]),
  corePack('connector', [connectorThirdParty]),
  corePack('video', [videoDecodeSample, videoScale]),
  corePack('telemetry', [
    telemetryKalman,
    telemetryEma,
    telemetryDerivative,
    telemetryWindowAggregate,
    telemetryResample,
    telemetryTimeAlign,
    telemetryOutlierRemoval,
    telemetryGeofence,
  ]),
  corePack('model', [modelObjectDetection, modelSegmentation, modelDepth, modelVlm]),
  corePack('logic', [
    logicThreshold,
    logicComparator,
    logicBoolean,
    logicDebounce,
    logicDetectionGate,
    logicProximityGate,
  ]),
  corePack('output', [outputDataCapture, outputEvent, outputVisualization]),
]);

/** The catalog of exactly the core packs; what every entry point defaults to. */
export const coreCatalog: Catalog = createCatalog(corePacks);

export function getNodeType(type: string): NodeTypeDef | undefined {
  return coreCatalog.getNodeType(type);
}

export function getExecutor(type: string): ReturnType<Catalog['getExecutor']> {
  return coreCatalog.getExecutor(type);
}

export function listNodeTypes(): NodeTypeDef[] {
  return coreCatalog.listNodeTypes();
}

/** The serialized catalog payload of `catalog` (default: the core catalog). Cached per catalog. */
export function buildCatalogPayload(catalog: Catalog = coreCatalog): WorkflowCatalogPayload {
  return catalog.payload();
}

/**
 * Capability tokens a node instance requires, resolved against its config
 * (parsed config preferred so defaults apply). tokenTemplate rules substitute
 * the referenced config value; string arrays emit one token per element.
 */
export function capabilityTokensForNode(
  def: NodeTypeDef,
  config: Record<string, unknown>,
): string[] {
  const parsed = def.config.safeParse(config);
  const effective: Record<string, unknown> = parsed.success
    ? (parsed.data as Record<string, unknown>)
    : config;
  const tokens: string[] = [];
  for (const rule of def.requires) {
    if ('token' in rule) {
      tokens.push(rule.token);
      continue;
    }
    const match = rule.tokenTemplate.match(/^(.*)\{config\.([a-zA-Z0-9_.]+)\}(.*)$/);
    if (!match) continue;
    const [, prefix, path, suffix] = match;
    const value = path
      .split('.')
      .reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), effective);
    for (const v of Array.isArray(value) ? value : [value]) {
      if (typeof v === 'string' && v.trim()) tokens.push(`${prefix}${v.trim()}${suffix}`);
    }
  }
  return tokens;
}
