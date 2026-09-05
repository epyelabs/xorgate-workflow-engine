import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { EngineArtifactSink } from '../catalog/types';
import { createEngine, XweUsageError, type EngineRunOptions, type EngineRunResult } from '../create-engine';
import { scrubSecretEnv } from '../engine/child-env';
import type { EngineResult } from '../engine/manifest';
import { ffmpegPath } from '../engine/media';
import type { EngineBoundRun, EngineHost, EngineHostBindArgs } from '../host';
import { resolveFfmpeg } from '../local/target';

/**
 * The conformance kit (library.mdx "Proving a host"): the engine's four golden
 * expectations, run through `createEngine` against any host. A host is
 * correct when it produces the same outcomes as the reference host on the
 * same inputs; the kit asserts outcomes, not bytes, with the same tolerances
 * the repository's own golden suite uses.
 *
 * What the host must provide: the fixtures directory's files as inputs (the
 * kit binds them by path, so a remote host's `bind` must be able to reach
 * them), the `detection/yolov8n` model for the two video cases (the local
 * host: `modelDirs: ["<fixturesDir>/models"]`), and ffmpeg on the machine
 * for decoding (the kit also uses it to decode the muxed MP4 back).
 */

export const CONFORMANCE_CASE_NAMES = ['overspeed', 'detection', 'visualization', 'missing-input'] as const;
export type ConformanceCaseName = (typeof CONFORMANCE_CASE_NAMES)[number];

/** The pinned expectations, identical to scripts/golden-test.mjs. */
export const CONFORMANCE_EXPECTATIONS = {
  /** First rising edge of the overspeed window in fixtures/telemetry/window.csv. */
  overspeedAt: '2026-08-12T23:56:01.289Z',
  overspeedKph: 77.72,
  overspeedKphTolerance: 0.5,
  /** drive.mp4 sampled at 2 fps. */
  frames: 50,
  fps: 2,
  /** yolov8n over those frames on the first laptop; the tolerance absorbs float variance across hosts. */
  detections: 81,
  detectionTolerance: 15,
} as const;

export interface ConformanceOptions {
  host: EngineHost;
  /** The engine's golden fixtures directory (templates, telemetry, video, models). */
  fixturesDir: string;
  /** Which cases to run; default all four, in this order. */
  cases?: ReadonlyArray<ConformanceCaseName>;
  /** Run ids are `<prefix>-<case>`; default `conformance-<epoch>` so repeated runs never collide. */
  runIdPrefix?: string;
  /** Wall-clock budget per case; default 10 minutes. */
  deadlineMs?: number;
  /** One line per case as it finishes. */
  log?: (line: string) => void;
}

export interface ConformanceCase {
  name: ConformanceCaseName;
  ok: boolean;
  /** What was observed, in the golden suite's words; on failure, what was wrong. */
  detail: string;
  runId: string;
  /** Where the host put the run's artifacts, when the run got that far. */
  runDir?: string;
  durationMs: number;
}

export interface ConformanceReport {
  ok: boolean;
  cases: ConformanceCase[];
  fixturesDir: string;
}

// --- host instrumentation -----------------------------------------------------

interface HostSpy {
  /** Frames the host's artifact sink accepted. */
  frames: number;
  /** The host had an artifact sink at all. */
  hasArtifacts: boolean;
  /** The host's `writeArtifacts` returned this result. */
  written: EngineResult | null;
  hasAfterSuccess: boolean;
}

/** The host with its sink and writer observed, so outcomes can be asserted without touching its storage. */
function observeHost(host: EngineHost): { host: EngineHost; spy: HostSpy } {
  const spy: HostSpy = { frames: 0, hasArtifacts: false, written: null, hasAfterSuccess: false };
  const wrapped: EngineHost = {
    async bind(args: EngineHostBindArgs): Promise<EngineBoundRun> {
      const bound = await host.bind(args);
      spy.hasArtifacts = bound.artifacts !== undefined;
      spy.hasAfterSuccess = typeof bound.afterSuccess === 'function';
      const artifacts: EngineArtifactSink | undefined = bound.artifacts
        ? {
            putFrame: async (nodeId, seq, jpeg) => {
              const key = await bound.artifacts!.putFrame(nodeId, seq, jpeg);
              spy.frames += 1;
              return key;
            },
          }
        : undefined;
      return {
        ...bound,
        ...(artifacts ? { artifacts } : {}),
        writeArtifacts: async (outcome, formats) => {
          const result = await bound.writeArtifacts(outcome, formats);
          spy.written = result;
          return result;
        },
      };
    },
  };
  return { host: wrapped, spy };
}

// --- helpers -------------------------------------------------------------------

const stepsOk = (result: EngineResult, n: number): boolean =>
  result.steps.length === n && result.steps.every((s) => s.status === 'ok');
const step = (result: EngineResult, nodeId: string): string =>
  result.steps.find((s) => s.nodeId === nodeId)?.output ?? '(no step)';
const within = (value: number, target: number, tolerance: number): boolean =>
  Number.isFinite(value) && Math.abs(value - target) <= tolerance;

function failure(result: EngineResult): string {
  return `status ${result.status}${result.failedNodeId ? ` at ${result.failedNodeId}` : ''}${result.error ? `: ${result.error}` : ''}`;
}

/** Decode an MP4 with ffmpeg and count its video frames (container metadata, not bytes). */
async function probeMp4(file: string): Promise<{ frames: number; h264: boolean; fps: number | null; error?: string }> {
  resolveFfmpeg();
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-i', file, '-map', '0:v', '-f', 'null', '-'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: scrubSecretEnv(),
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-16384);
    });
    child.on('error', (err) => resolve({ frames: -1, h264: false, fps: null, error: err.message }));
    child.on('close', () => {
      const frames = [...stderr.matchAll(/frame=\s*(\d+)/g)].at(-1)?.[1];
      const fps = stderr.match(/ (\d+(?:\.\d+)?) fps/)?.[1];
      resolve({ frames: frames === undefined ? -1 : Number(frames), h264: /Video: h264/.test(stderr), fps: fps ? Number(fps) : null });
    });
  });
}

function isLocalDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// --- the cases ---------------------------------------------------------------------

interface CaseContext {
  fixturesDir: string;
  runId: string;
  deadlineMs: number;
  run(options: EngineRunOptions): Promise<EngineRunResult>;
  spy: HostSpy;
}

type CaseFn = (ctx: CaseContext) => Promise<{ ok: boolean; detail: string; runDir?: string }>;

const E = CONFORMANCE_EXPECTATIONS;

const overspeed: CaseFn = async (ctx) => {
  const { result, runDir } = await ctx.run({
    template: path.join(ctx.fixturesDir, 'templates/overspeed.json'),
    inputs: { telemetry: path.join(ctx.fixturesDir, 'telemetry/window.csv') },
    runId: ctx.runId,
    deadlineMs: ctx.deadlineMs,
  });
  if (result.status !== 'succeeded') return { ok: false, detail: failure(result), runDir };
  const problems: string[] = [];
  if (!stepsOk(result, 4) || result.steps.map((s) => s.nodeId).join(',') !== 'n1,n2,n3,n4') {
    problems.push(`expected 4 ok steps n1..n4, got ${result.steps.map((s) => `${s.nodeId}:${s.status}`).join(',')}`);
  }
  if (!/^150 samples/.test(step(result, 'n1'))) problems.push(`n1: expected 150 samples, got "${step(result, 'n1')}"`);
  if (!/true on 149\/149/.test(step(result, 'n3'))) problems.push(`n3: expected true on 149/149, got "${step(result, 'n3')}"`);
  const event = result.events[0];
  if (result.events.length !== 1 || event?.kind !== 'overspeed') {
    problems.push(`expected exactly 1 overspeed event, got ${result.events.length} (${result.events.map((e) => e.kind).join(',')})`);
  } else {
    if (event.occurredAt !== E.overspeedAt) problems.push(`event at ${event.occurredAt}, expected ${E.overspeedAt}`);
    const observed = (event.payload as { observed?: unknown } | undefined)?.observed;
    if (typeof observed !== 'number' || !within(observed, E.overspeedKph, E.overspeedKphTolerance)) {
      problems.push(`observed speed ${String(observed)}, expected ${E.overspeedKph} ± ${E.overspeedKphTolerance}`);
    }
  }
  if (result.artifacts.eventsKey === null) problems.push('result.artifacts.eventsKey is null (events were not persisted)');
  if (problems.length > 0) return { ok: false, detail: problems.join('; '), runDir };
  const observed = (event!.payload as { observed: number }).observed;
  return { ok: true, detail: `1 overspeed event at ${event!.occurredAt}, observed ${observed.toFixed(1)} km/h, 4 ok steps`, runDir };
};

const detection: CaseFn = async (ctx) => {
  const { result, runDir } = await ctx.run({
    template: path.join(ctx.fixturesDir, 'templates/perimeter-person-detect.json'),
    inputs: { video: path.join(ctx.fixturesDir, 'video/drive.mp4') },
    runId: ctx.runId,
    deadlineMs: ctx.deadlineMs,
  });
  if (result.status !== 'succeeded') return { ok: false, detail: failure(result), runDir };
  const problems: string[] = [];
  if (!stepsOk(result, 5)) problems.push(`expected 5 ok steps, got ${result.steps.map((s) => `${s.nodeId}:${s.status}`).join(',')}`);
  const decode = step(result, 'n2');
  if (!new RegExp(`^${E.frames} frame\\(s\\) sampled at ${E.fps} fps`).test(decode)) problems.push(`n2: expected ${E.frames} frames at ${E.fps} fps, got "${decode}"`);
  const detect = step(result, 'n3');
  const m = detect.match(/^(\d+) detection\(s\) over (\d+) frame\(s\)/);
  const count = m ? Number(m[1]) : NaN;
  if (!m || Number(m[2]) !== E.frames || !within(count, E.detections, E.detectionTolerance)) {
    problems.push(`n3: expected ${E.detections} ± ${E.detectionTolerance} detections over ${E.frames} frames, got "${detect}"`);
  }
  if (result.events.length !== 0) problems.push(`expected no person event on highway footage, got ${result.events.length}`);
  if (problems.length > 0) return { ok: false, detail: problems.join('; '), runDir };
  return { ok: true, detail: `${E.frames} frames, ${count} detections (${E.detections} ± ${E.detectionTolerance}), 0 events`, runDir };
};

const visualization: CaseFn = async (ctx) => {
  const { result, runDir } = await ctx.run({
    template: path.join(ctx.fixturesDir, 'templates/perimeter-visualize.json'),
    inputs: { video: path.join(ctx.fixturesDir, 'video/drive.mp4') },
    runId: ctx.runId,
    emitVideo: true,
    deadlineMs: ctx.deadlineMs,
  });
  if (result.status !== 'succeeded') return { ok: false, detail: failure(result), runDir };
  const problems: string[] = [];
  if (!stepsOk(result, 6)) problems.push(`expected 6 ok steps, got ${result.steps.map((s) => `${s.nodeId}:${s.status}`).join(',')}`);
  const viz = step(result, 'viz');
  if (!new RegExp(`^${E.frames} annotated frame\\(s\\)`).test(viz)) problems.push(`viz: expected ${E.frames} annotated frames, got "${viz}"`);
  if (!ctx.spy.hasArtifacts) problems.push('the host bound no artifact sink; visualization frames had nowhere to go');
  else if (ctx.spy.frames !== E.frames) problems.push(`${ctx.spy.frames} frames reached the artifact sink, expected ${E.frames}`);
  // The muxed MP4 is a local-host feature (afterSuccess); a host that writes a
  // directory is expected to have produced it, a remote locator is not checked.
  const mp4 = path.join(runDir, 'video', 'viz.mp4');
  let mp4Detail: string;
  if (existsSync(mp4)) {
    const probe = await probeMp4(mp4);
    if (probe.error) problems.push(`could not decode video/viz.mp4 with ffmpeg: ${probe.error}`);
    else if (probe.frames !== E.frames || !probe.h264 || probe.fps !== E.fps) {
      problems.push(`video/viz.mp4 decodes to ${probe.frames} frame(s), ${probe.h264 ? 'h264' : 'not h264'}, ${probe.fps ?? '?'} fps; expected ${E.frames} h264 frames at ${E.fps} fps`);
    }
    mp4Detail = `video/viz.mp4 decodes to ${probe.frames} h264 frames at ${probe.fps ?? '?'} fps`;
  } else if (isLocalDir(runDir) && ctx.spy.hasAfterSuccess) {
    problems.push(`expected ${mp4} (the host has afterSuccess and writes a local directory)`);
    mp4Detail = 'no video/viz.mp4';
  } else {
    mp4Detail = 'MP4 check not applicable (runDir is not a local directory the host muxes into)';
  }
  if (problems.length > 0) return { ok: false, detail: problems.join('; '), runDir };
  return { ok: true, detail: `${E.frames} annotated frames, ${ctx.spy.frames} reached the artifact sink, ${mp4Detail}`, runDir };
};

const missingInput: CaseFn = async (ctx) => {
  let outcome: EngineRunResult;
  try {
    outcome = await ctx.run({
      template: path.join(ctx.fixturesDir, 'templates/overspeed.json'),
      inputs: { telemetry: path.join(ctx.fixturesDir, 'telemetry/does-not-exist.csv') },
      runId: ctx.runId,
      deadlineMs: ctx.deadlineMs,
    });
  } catch (err) {
    return { ok: false, detail: `the run rejected instead of resolving with a failed result: ${err instanceof Error ? err.message : String(err)}` };
  }
  const { result, runDir } = outcome;
  const problems: string[] = [];
  if (result.status !== 'failed') problems.push(`expected status failed, got ${result.status}`);
  if (result.failedNodeId !== 'n1') problems.push(`expected failedNodeId n1, got ${String(result.failedNodeId)}`);
  if (!ctx.spy.written) problems.push('the host never wrote the outcome (writeArtifacts was not called)');
  else if (ctx.spy.written.status !== 'failed') problems.push(`the host wrote status ${ctx.spy.written.status}, expected failed`);
  const onDisk = path.join(runDir, 'result.json');
  let where = 'result.json written by the host';
  if (existsSync(onDisk)) {
    try {
      const parsed = JSON.parse(readFileSync(onDisk, 'utf8')) as { status?: string; failedNodeId?: string | null };
      if (parsed.status !== 'failed' || parsed.failedNodeId !== 'n1') problems.push(`result.json on disk says ${parsed.status} at ${String(parsed.failedNodeId)}`);
      where = 'result.json on disk';
    } catch (err) {
      problems.push(`result.json on disk does not parse: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (problems.length > 0) return { ok: false, detail: problems.join('; '), runDir };
  return { ok: true, detail: `failed at n1 (${result.error ?? 'no error text'}), ${where} with status failed`, runDir };
};

const CASES: Record<ConformanceCaseName, CaseFn> = { overspeed, detection, visualization, 'missing-input': missingInput };

// --- entry ---------------------------------------------------------------------------

export async function runConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  if (!options || typeof options !== 'object') {
    throw new XweUsageError('runConformance needs { host, fixturesDir }');
  }
  if (!options.host || typeof options.host.bind !== 'function') {
    throw new XweUsageError('runConformance needs a host: runConformance({ host: localHost({ ... }), fixturesDir })');
  }
  if (typeof options.fixturesDir !== 'string' || options.fixturesDir === '') {
    throw new XweUsageError('runConformance needs fixturesDir: the engine repository\'s fixtures/ directory');
  }
  const fixturesDir = path.resolve(options.fixturesDir);
  for (const required of ['templates/overspeed.json', 'templates/perimeter-person-detect.json', 'templates/perimeter-visualize.json', 'telemetry/window.csv']) {
    if (!existsSync(path.join(fixturesDir, required))) {
      throw new XweUsageError(`runConformance: ${path.join(fixturesDir, required)} is missing; fixturesDir must be the engine repository's fixtures/ directory`);
    }
  }
  const names = options.cases ?? CONFORMANCE_CASE_NAMES;
  for (const name of names) {
    if (!(name in CASES)) throw new XweUsageError(`runConformance: unknown case "${String(name)}" (cases: ${CONFORMANCE_CASE_NAMES.join(', ')})`);
  }
  const prefix = options.runIdPrefix ?? `conformance-${Date.now().toString(36)}`;
  const deadlineMs = options.deadlineMs ?? 10 * 60_000;
  const videoMissing = existsSync(path.join(fixturesDir, 'video/drive.mp4'))
    ? null
    : `${path.join(fixturesDir, 'video/drive.mp4')} is missing (in the engine repository: npm run fixtures:pull)`;

  const cases: ConformanceCase[] = [];
  for (const name of names) {
    const started = Date.now();
    const runId = `${prefix}-${name}`;
    let outcome: { ok: boolean; detail: string; runDir?: string };
    if (videoMissing && (name === 'detection' || name === 'visualization')) {
      outcome = { ok: false, detail: videoMissing };
    } else {
      const { host, spy } = observeHost(options.host);
      const engine = createEngine({ host });
      try {
        outcome = await CASES[name]({ fixturesDir, runId, deadlineMs, run: (o) => engine.run(o), spy });
      } catch (err) {
        outcome = { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    }
    const entry: ConformanceCase = { name, ...outcome, runId, durationMs: Date.now() - started };
    cases.push(entry);
    options.log?.(`${entry.ok ? 'ok  ' : 'FAIL'} ${name.padEnd(14)} ${entry.detail} (${(entry.durationMs / 1000).toFixed(1)}s)`);
  }
  return { ok: cases.every((c) => c.ok), cases, fixturesDir };
}
