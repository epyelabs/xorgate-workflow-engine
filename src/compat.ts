import type { WorkflowDefinition, WorkflowNode } from './schemas/workflows';
import { workflowDefinitionSchema } from './schemas/workflows';

/**
 * Definition schema versioning (architecture.md §8). v1 is the PoC shape
 * (free-form node types, no schemaVersion field); v2 is the catalog world.
 * upgradeDefinition is PURE: applied on template read and on version restore,
 * never rewriting stored published rows in place. The dispatcher keeps routing
 * v1 definitions to the old runner until M6.
 */

export const DEFINITION_SCHEMA_VERSION = 2;

type ConfigUpgrade = (config: Record<string, unknown>) => Record<string, unknown>;

function num(config: Record<string, unknown>, key: string, fallback: number): number {
  const v = config[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function str(config: Record<string, unknown>, key: string, fallback: string): string {
  const v = config[key];
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

const V1_OPERATORS: Record<string, 'gt' | 'gte' | 'lt' | 'lte'> = {
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
};

const V1_DETECTION_MODELS: Record<string, string> = {
  'yolo-n': 'yolov8n',
  'yolo-s': 'yolov8s',
  rtdetr: 'rtdetr',
};

// PoC type -> { catalog type, config preset }. Where a v1 node folded several
// concerns into one (speed_from_gps's smoothing, composite_rule's minSpeed),
// the extra knobs are dropped; users re-add them as explicit nodes.
const V1_NODE_UPGRADERS: Record<string, { type: string; config: ConfigUpgrade }> = {
  // source.video survives as-is in v2 (the abstract Video input; concrete
  // feeds are attach/simulation bindings), so it needs no upgrader.
  'source.gps': {
    type: 'source.telemetry',
    config: () => ({ metrics: ['gps.latitude', 'gps.longitude', 'gps.speed'] }),
  },
  'source.imu': {
    type: 'source.telemetry',
    config: () => ({ metrics: ['imu.accel_x', 'imu.accel_y', 'imu.accel_z'] }),
  },
  'source.telemetry': {
    type: 'source.telemetry',
    config: (c) => ({ metrics: [str(c, 'metric', 'lte.rssi')] }),
  },
  'processor.decode_sample': {
    type: 'video.decode_sample',
    config: (c) => ({ fps: num(c, 'fps', 2) }),
  },
  'processor.object_detection': {
    type: 'model.object_detection',
    config: (c) => ({
      model: V1_DETECTION_MODELS[str(c, 'model', 'yolo-n')] ?? 'yolov8n',
      minConfidence: num(c, 'minConfidence', 0.4),
    }),
  },
  'processor.speed_from_gps': {
    type: 'telemetry.derivative',
    config: () => ({ mode: 'speed_from_position', outputSignal: 'speed_kph' }),
  },
  'processor.speed_limit_check': {
    type: 'logic.threshold',
    config: (c) => ({ signal: 'speed_kph', operator: 'gt', value: num(c, 'limitKph', 80) }),
  },
  'processor.imu_decel': {
    type: 'telemetry.ema',
    config: (c) => {
      const axis = str(c, 'axis', 'x');
      return { signal: `imu.accel_${['x', 'y', 'z'].includes(axis) ? axis : 'x'}`, alpha: 0.3 };
    },
  },
  'processor.sensor_fusion': {
    type: 'telemetry.time_align',
    config: (c) => ({ toleranceMs: num(c, 'syncMs', 200) }),
  },
  'logic.threshold': {
    type: 'logic.threshold',
    config: (c) => ({
      operator: V1_OPERATORS[str(c, 'operator', '<=')] ?? 'lte',
      value: num(c, 'value', 0),
    }),
  },
  'logic.composite_rule': {
    type: 'logic.boolean',
    config: (c) => ({ op: str(c, 'combine', 'all') === 'any' ? 'or' : 'and' }),
  },
  'output.event': {
    type: 'output.event',
    config: (c) => ({
      kind: str(c, 'kind', 'detection'),
      attachClip: str(c, 'clip', 'yes') !== 'no',
    }),
  },
  // "removed/absorbed" per architecture.md §8: an alert is an event of kind
  // "alert", so terminal alert nodes keep their place in the graph.
  'output.alert': {
    type: 'output.event',
    config: () => ({ kind: 'alert', attachClip: false }),
  },
};

/** PoC type -> catalog type, served in the catalog payload for FE awareness. */
export const POC_TYPE_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(V1_NODE_UPGRADERS).map(([from, { type }]) => [from, type]),
);

/**
 * Pure v1 -> v2 upgrade. Node types and configs are mapped onto catalog
 * equivalents; ids, positions, labels, and edges are preserved. Unknown v1
 * types pass through untouched (publish validation reports them). v2 (or
 * newer) definitions are returned as-is.
 */
export function upgradeDefinition(def: WorkflowDefinition): WorkflowDefinition {
  if ((def.schemaVersion ?? 1) >= DEFINITION_SCHEMA_VERSION) return def;
  const nodes = def.nodes.map((node): WorkflowNode => {
    const upgrader = V1_NODE_UPGRADERS[node.type];
    if (!upgrader) return node;
    return {
      ...node,
      type: upgrader.type,
      data: { ...node.data, config: upgrader.config(node.data.config ?? {}) },
    };
  });
  return { schemaVersion: DEFINITION_SCHEMA_VERSION, nodes, edges: def.edges };
}

/**
 * Read-path guard for stored jsonb: shape-parse, upgrade when it is a valid
 * definition, otherwise return the value untouched.
 */
export function upgradeDefinitionSafe(raw: unknown): unknown {
  const parsed = workflowDefinitionSchema.safeParse(raw);
  return parsed.success ? upgradeDefinition(parsed.data) : raw;
}
