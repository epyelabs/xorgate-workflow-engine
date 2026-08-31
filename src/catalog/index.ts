import type { NodeExecutor, NodeTypeDef } from './types';
import { nodeTypeDefSchema } from './types';

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
 * (architecture.md §3). Defs are validated once at module load; a broken def
 * fails cold start loudly rather than serving a bad catalog.
 */

export interface CatalogEntry {
  def: NodeTypeDef;
  executor: NodeExecutor;
}

const MODULES: Array<{ def: NodeTypeDef; executor: NodeExecutor }> = [
  sourceVideo,
  sourceTelemetry,
  connectorThirdParty,
  videoDecodeSample,
  videoScale,
  telemetryKalman,
  telemetryEma,
  telemetryDerivative,
  telemetryWindowAggregate,
  telemetryResample,
  telemetryTimeAlign,
  telemetryOutlierRemoval,
  telemetryGeofence,
  modelObjectDetection,
  modelSegmentation,
  modelDepth,
  modelVlm,
  logicThreshold,
  logicComparator,
  logicBoolean,
  logicDebounce,
  logicDetectionGate,
  logicProximityGate,
  outputDataCapture,
  outputEvent,
  outputVisualization,
];

function buildRegistry(): Map<string, CatalogEntry> {
  const map = new Map<string, CatalogEntry>();
  for (const mod of MODULES) {
    const parsed = nodeTypeDefSchema.safeParse(mod.def);
    if (!parsed.success) {
      throw new Error(
        `Invalid NodeTypeDef "${mod.def?.type}": ${parsed.error.issues[0]?.message ?? 'parse failed'}`,
      );
    }
    const def = mod.def;
    if (map.has(def.type)) throw new Error(`Duplicate catalog node type "${def.type}"`);
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
    map.set(def.type, { def, executor: mod.executor });
  }
  return map;
}

const registry = buildRegistry();

export function getNodeType(type: string): NodeTypeDef | undefined {
  return registry.get(type)?.def;
}

export function getExecutor(type: string): NodeExecutor | undefined {
  return registry.get(type)?.executor;
}

export function listNodeTypes(): NodeTypeDef[] {
  return [...registry.values()].map((e) => e.def);
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
