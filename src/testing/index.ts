/**
 * `@xorgate/workflow-engine/testing`: the conformance kit. Runs the engine's
 * four golden expectations through `createEngine` against any host, so a
 * host over object storage, a vault and a message bus can prove it produces
 * the outcomes the reference host produces.
 */
export { runConformance, CONFORMANCE_CASE_NAMES, CONFORMANCE_EXPECTATIONS } from './conformance';
export type { ConformanceCase, ConformanceCaseName, ConformanceOptions, ConformanceReport } from './conformance';
