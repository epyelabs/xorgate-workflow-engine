import type { EngineHost } from '../host';

/**
 * `@xorgate/workflow-engine/testing`: the conformance kit. The entry point
 * exists so hosts can wire it up; the runner itself ships with the
 * production-hardening milestone.
 */

export interface ConformanceOptions {
  host: EngineHost;
  /** The engine's golden fixtures directory (templates, telemetry, video, models). */
  fixturesDir: string;
}

export interface ConformanceCase {
  name: 'overspeed' | 'detection' | 'visualization' | 'missing-input';
  ok: boolean;
  detail: string;
}

export interface ConformanceReport {
  ok: boolean;
  cases: ConformanceCase[];
}

export async function runConformance(_options: ConformanceOptions): Promise<ConformanceReport> {
  throw new Error('runConformance is not implemented until M5');
}
