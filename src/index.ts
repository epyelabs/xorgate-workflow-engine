/**
 * `@xorgate/workflow-engine`: the engine core, the catalog, every schema and
 * seam type. Importing this loads no native module; ONNX Runtime and the VLM
 * provider client are required lazily by the executors that use them.
 * Everything not re-exported here (or from ./local and ./testing) is
 * internal; deep imports are not supported.
 */

// High level
export { createEngine, XweUsageError, resolveRunManifest } from './create-engine';
export type {
  CreateEngineOptions,
  Engine,
  EngineRunOptions,
  EngineRunResult,
  FunctionTestEvent,
  FunctionTestResult,
  TestFunctionOptions,
} from './create-engine';
// Code function nodes (distribution M7): the environment their runners get and the version rule.
export { functionChildEnv, functionSpawnSpec, nodePermissionFlag } from './engine/function-runtime';
export type { FunctionLanguage } from './engine/function-runtime';
export { resolveFunctionCode, FUNCTION_CODE_MAX_BYTES } from './catalog/nodes/function-common';
export type { FunctionConfig, FunctionVersionSnapshot, ResolvedFunctionCode } from './catalog/nodes/function-common';
export type { EngineHost, EngineHostBindArgs, EngineBoundRun } from './host';
export type { LogLevel, LogSink, MessageLevel } from './engine/log';
export { LOG_LEVELS } from './engine/log';
// Secret hygiene: the environment a child process may inherit (no XORGATE_SECRET_*).
export { scrubSecretEnv, SECRET_ENV_PREFIX } from './engine/child-env';
export { REDACTED } from './engine/redact';

// Low level: the core and its seams
export { runGraph, DEFAULT_CHANNEL_CAPACITY } from './engine/index';
export type { EngineGraphSpec, EngineRunDeps, EngineRunOutcome, EngineStep } from './engine/index';
export type {
  Channel,
  CapabilityRule,
  ConditionPayload,
  DepthBox,
  DepthMapEmbed,
  DepthPayload,
  DetectionBox,
  DetectionsPayload,
  EngineArtifactSink,
  EngineEmit,
  EngineEventRecord,
  EngineInChannel,
  EngineMessage,
  EngineMode,
  EngineProgressSink,
  EngineProgressStep,
  EngineRunCtx,
  EngineSecretReader,
  EngineSourceBinding,
  EngineSourceReader,
  FramePayload,
  LiveIngestFrame,
  LiveVideoRef,
  NodeConstraint,
  NodeExecutor,
  NodeGroup,
  NodeTypeDef,
  PortDef,
  SegmentInstance,
  SegmentsPayload,
  TelemetryPayload,
  TelemetrySample,
  VideoPayload,
  VlmPayload,
} from './catalog/types';
export {
  CHANNELS,
  NODE_GROUPS,
  channelLabel,
  channelsCompatible,
  defineNode,
  nodeTypeDefSchema,
  portDefSchema,
} from './catalog/types';

// Templates
export { validateDefinition, inspectTemplate } from './template';
export type {
  InspectTemplateResult,
  TemplateInput,
  ValidateDefinitionIssue,
  ValidateDefinitionResult,
} from './template';
export { upgradeDefinition, upgradeDefinitionSafe, DEFINITION_SCHEMA_VERSION, POC_TYPE_ALIASES } from './compat';
export { validateDefinitionForPublish, unknownNodeTypeMessage } from './validate';
export type { ValidationIssue, ValidationResult } from './validate';

// The catalog: the core registry, node packs and catalog instances
export {
  buildCatalogPayload,
  capabilityTokensForNode,
  coreCatalog,
  corePacks,
  getExecutor,
  getNodeType,
  listNodeTypes,
} from './catalog/index';
export { CORE_NAMESPACES, createCatalog, isCorePack } from './catalog/pack';
export type { Catalog, CatalogEntry, NodePack, NodePackNode } from './catalog/pack';
export type { CatalogPackInfo, SerializedNodeTypeDef, WorkflowCatalogPayload } from './catalog/serialize';

// Executor helpers for nodes written outside this package (extending.mdx)
export { inputsForPort, mergeByTs, requireInput, resolveSignal, telemetrySamples } from './engine/helpers';
export type { MergedMessage } from './engine/helpers';

// Schemas: the frozen contracts
export { workflowDefinitionSchema, workflowEdgeSchema, workflowNodeSchema } from './schemas/workflows';
export type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from './schemas/workflows';
export {
  ENGINE_VERSION,
  buildEngineResult,
  engineEventSchema,
  engineResultSchema,
  engineStepSchema,
  runManifestSchema,
  runPrefix,
} from './engine/manifest';
export type { EngineResult, RunManifest } from './engine/manifest';
export { MODEL_FAMILIES, modelFileIntegritySchema, modelManifestSchema } from './models/registry';
export type { ModelFileIntegrity, ModelManifest } from './models/registry';
export {
  simEventPayloadSchema,
  simRecordPayloadSchema,
  simStatusPayloadSchema,
  simStepPayloadSchema,
} from './engine/progress';
export type { SimEventPayload, SimRecordPayload, SimStatusPayload, SimStepPayload } from './engine/progress';

// The platform shell and any other remote host (0.3.0): the reference
// progress transport and its topic layout, the artifact key helpers behind
// the artifact tree, the capture-format rule, and the connector request
// builders. All additive; nothing here loads a native module or a cloud SDK.
export { IotRunProgress, runTopicPrefix, simPreviewPayloadSchema, simTopicPrefix, teeArtifactSink } from './engine/progress';
export type { ProgressTransport, SimPreviewPayload } from './engine/progress';
export {
  V2_RUN_PREFIX,
  eventsKey,
  frameKey,
  inputRecordsKey,
  manifestKey,
  recordsKey,
  resultKey,
} from './engine/manifest';
export { captureFormatsOf } from './local/capture-formats';
export {
  buildGoogleRoadsUrl,
  buildHereRequest,
  buildOverpassRequest,
  parseGoogleRoadsResponse,
  parseHereResponse,
  parseMaxspeedTag,
  parseOverpassResponse,
} from './catalog/nodes/connector-third-party';
export type {
  HereRouteMatchResponse,
  OverpassResponse,
  RoadsResponse,
  SpeedLimitLookup,
  SpeedLimitProvider,
} from './catalog/nodes/connector-third-party';
