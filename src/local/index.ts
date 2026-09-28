/**
 * `@xorgate/workflow-engine/local`: the file host and its parts. Nothing here
 * loads a native module at import; ffmpeg is spawned at run time by video
 * nodes and by emitVideo.
 */
export { localHost } from './host';
export type { LocalHost, LocalHostOptions, LocalHostModelsOptions } from './host';
export {
  defaultModelDirs,
  localArtifactSink,
  localSecretReader,
  localSources,
  ndjsonProgress,
  objectProgress,
  teeProgress,
  resolveFfmpeg,
  secretEnvVar,
  writeLocalRunArtifacts,
  writeLocalRunArtifacts as writeRunArtifacts,
} from './target';
export type { EngineProgressMessage, LocalSourceOptions } from './target';
export { buildEngineResult as buildResult } from '../engine/manifest';
export { emitVisualizationVideos, emitVisualizationVideos as emitVideo, visualizationFps } from './emit-video';
export type { EmittedVideo } from './emit-video';
export { buildLocalManifest, loadDefinition, parseTemplate } from './manifest-builder';
export type { BuildManifestArgs } from './manifest-builder';
export { localizeBinding, localizeBindings } from './bindings';
export { captureFormatsOf } from './capture-formats';

// Models: the resolver chain, the registry client and the directory check.
export {
  cacheResolver,
  createModelChain,
  dirResolver,
  findModelInRoot,
  httpResolver,
  ModelNotFoundError,
} from './models';
export type { ModelChain, ModelChainOptions, ModelResolver, ModelResolveContext, ResolvedModel } from './models';
export { formatModelRef, parseModelName, parseModelSpec } from './model-ref';
export type { ModelRef } from './model-ref';
export {
  DEFAULT_MODEL_REGISTRY,
  fetchRegistryIndex,
  ModelIntegrityError,
  ModelNotInRegistryError,
  pullModel,
  registryUrlFrom,
} from './registry-client';
export type { PullOptions, PullResult } from './registry-client';
export { checkModelDir, formatModelCheckLine } from './check-model';
export type { CheckModelDirOptions, ModelCheckLine, ModelCheckReport, ModelCheckStage } from './check-model';
export { displayPath, modelCacheDir } from './paths';

// Local webhook delivery (0.5.0): the sink `engine.run({ webhooks })` uses and
// the Standard Webhooks signing it shares with the platform.
export {
  generateWebhookSecret,
  localWebhookSink,
  resolveWebhookBindings,
  signWebhookPayload,
  uuidv7,
  WEBHOOK_API_VERSION,
  webhookEnvVar,
  webhookHeaders,
  webhookRefsOf,
  webhookSecretEnvVar,
  webhookSecretKey,
  webhookUrlProblem,
  workflowEventEnvelope,
} from './webhooks';
export type {
  EngineWebhookOptions,
  LocalWebhookSink,
  WebhookBinding,
  WebhookRef,
  WorkflowEventEnvelope,
} from './webhooks';
