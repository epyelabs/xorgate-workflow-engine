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
