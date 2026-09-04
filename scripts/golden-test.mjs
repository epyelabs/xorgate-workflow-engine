#!/usr/bin/env node
// The repo's regression gate: the overspeed and perimeter golden runs over
// the fixtures, driven through the real CLI, plus the library surface
// (createEngine + localHost in ESM and CJS), the local `path` alias and
// `xwe doctor`. Run `npm run build` first (`npm test` does).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = mkdtempSync(join(tmpdir(), 'xwe-golden-'));

let failed = false;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

function xwe(args) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [join(root, 'dist/cjs/cli/index.js'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  return { ...res, seconds: (Date.now() - started) / 1000 };
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// --- validate ---------------------------------------------------------------
{
  const res = xwe(['validate', 'fixtures/templates/overspeed.json']);
  check('validate overspeed exits 0', res.status === 0, res.stderr.trim());
  check(
    'validate lists the telemetry input',
    res.stdout.includes('--input telemetry='),
  );
}

// --- golden 1: overspeed (hermetic, telemetry-only) -------------------------
{
  const res = xwe([
    'run',
    'fixtures/templates/overspeed.json',
    '--input', 'telemetry=fixtures/telemetry/window.csv',
    '--out', outRoot,
    '--run-id', 'golden-overspeed',
  ]);
  check('overspeed run exits 0', res.status === 0, res.stderr.split('\n').at(-2) ?? '');
  console.log(`     (overspeed wall time: ${res.seconds.toFixed(1)}s)`);

  const runDir = join(outRoot, 'golden-overspeed');
  const result = readJson(join(runDir, 'result.json'));
  check('result: succeeded, v2', result.status === 'succeeded' && result.resultVersion === 2 && result.engineVersion === 2);
  check(
    'result: 4 ok steps n1..n4 in order',
    result.steps.length === 4 &&
      result.steps.every((s) => s.status === 'ok') &&
      result.steps.map((s) => s.nodeId).join(',') === 'n1,n2,n3,n4',
  );
  check('step n1 read 150 samples', /^150 samples/.test(result.steps[0].output), result.steps[0].output);
  check('step n3 true on 149/149', /true on 149\/149/.test(result.steps[2].output), result.steps[2].output);
  check(
    'exactly 1 overspeed event',
    result.events.length === 1 && result.events[0].kind === 'overspeed',
  );
  check(
    'event pinned: first rising edge of the window',
    result.events[0].occurredAt === '2026-08-12T23:56:01.289Z',
    result.events[0].occurredAt,
  );
  const observed = result.events[0].payload?.observed;
  check('event observed speed ~77.7 km/h', typeof observed === 'number' && Math.abs(observed - 77.72) < 0.5, String(observed));
  const eventsLines = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n');
  check('events.jsonl has 1 line; result points at it', eventsLines.length === 1 && result.artifacts.eventsKey !== null);
}

// --- golden 2: perimeter (video -> yolov8n) ---------------------------------
{
  const res = xwe([
    'run',
    'fixtures/templates/perimeter-person-detect.json',
    '--input', 'video=fixtures/video/drive.mp4',
    '--out', outRoot,
    '--run-id', 'golden-perimeter',
  ]);
  check('perimeter run exits 0', res.status === 0, res.stderr.split('\n').at(-2) ?? '');
  console.log(`     (perimeter wall time: ${res.seconds.toFixed(1)}s)`);

  const result = readJson(join(outRoot, 'golden-perimeter', 'result.json'));
  check('result: succeeded, 5 ok steps', result.status === 'succeeded' && result.steps.length === 5 && result.steps.every((s) => s.status === 'ok'));
  const decode = result.steps.find((s) => s.nodeId === 'n2');
  check('decoded 50 frames at 2 fps', /^50 frame\(s\) sampled at 2 fps/.test(decode?.output ?? ''), decode?.output);
  const detect = result.steps.find((s) => s.nodeId === 'n3');
  const m = (detect?.output ?? '').match(/^(\d+) detection\(s\) over 50 frame\(s\)/);
  // Pinned from the first laptop run (81); tolerance absorbs onnx float
  // variance across hosts (arch §10: assert counts, not bytes).
  const count = m ? Number(m[1]) : NaN;
  check('detection count 81 ± 15', Number.isFinite(count) && Math.abs(count - 81) <= 15, detect?.output);
  check('no person event on highway footage', result.events.length === 0);
}

// --- golden 3: visualization + --emit-video (M4) ----------------------------
{
  const res = xwe([
    'run',
    'fixtures/templates/perimeter-visualize.json',
    '--input', 'video=fixtures/video/drive.mp4',
    '--out', outRoot,
    '--run-id', 'golden-viz',
    '--emit-video',
  ]);
  check('visualize run exits 0', res.status === 0, res.stderr.split('\n').at(-2) ?? '');
  console.log(`     (visualize wall time: ${res.seconds.toFixed(1)}s)`);

  const result = readJson(join(outRoot, 'golden-viz', 'result.json'));
  check('result: succeeded, 6 ok steps', result.status === 'succeeded' && result.steps.length === 6 && result.steps.every((s) => s.status === 'ok'));
  const viz = result.steps.find((s) => s.nodeId === 'viz');
  check('viz annotated 50 frames', /^50 annotated frame\(s\)/.test(viz?.output ?? ''), viz?.output);

  const mp4 = join(outRoot, 'golden-viz', 'video', 'viz.mp4');
  check('video/viz.mp4 emitted', existsSync(mp4));
  // Decode it back: 50 frames at 2 fps (container metadata, not bytes).
  const { createRequire } = await import('node:module');
  const ffmpeg = createRequire(import.meta.url)('ffmpeg-static');
  const probe = spawnSync(ffmpeg, ['-i', mp4, '-map', '0:v', '-f', 'null', '-'], { encoding: 'utf8' });
  const frames = [...probe.stderr.matchAll(/frame=\s*(\d+)/g)].at(-1)?.[1];
  check('muxed mp4 decodes to 50 frames', frames === '50', `frame=${frames}`);
  check('muxed mp4 is 2 fps h264', /Video: h264/.test(probe.stderr) && / 2 fps/.test(probe.stderr));
}

// --- failure path: exit 1 names the failing node ----------------------------
{
  const res = xwe([
    'run',
    'fixtures/templates/overspeed.json',
    '--input', 'telemetry=fixtures/telemetry/does-not-exist.csv',
    '--out', outRoot,
    '--run-id', 'golden-fail',
  ]);
  check('missing input file exits 1', res.status === 1);
  check('failure names node n1', res.stderr.includes('failed at node n1'), res.stderr.trim().split('\n').at(-1));
  check(
    'failed run still lands result.json',
    existsSync(join(outRoot, 'golden-fail', 'result.json')) &&
      readJson(join(outRoot, 'golden-fail', 'result.json')).status === 'failed',
  );
}

// --- usage errors exit 2 and run nothing ----------------------------------
{
  const res = xwe(['run', 'fixtures/templates/overspeed.json', '--input', 'bogus=x.csv', '--out', outRoot, '--run-id', 'golden-usage']);
  check('unbindable input key exits 2', res.status === 2, res.stderr.trim());
  check('usage error runs nothing', !existsSync(join(outRoot, 'golden-usage')));
  const missing = xwe(['run', 'does-not-exist.json', '--out', outRoot]);
  check('missing template file exits 2', missing.status === 2, missing.stderr.trim());
}

// --- `path` alias in a hand-written local manifest (local host only) -------
{
  const manifest = readJson(join(root, 'fixtures/manifests/overspeed.manifest.json'));
  manifest.runId = 'golden-path-alias';
  manifest.inputs[0].binding = { kind: 'telemetry_csv', path: 'fixtures/telemetry/window.csv', metrics: manifest.inputs[0].binding.metrics };
  const file = join(outRoot, 'path-alias.manifest.json');
  writeFileSync(file, JSON.stringify(manifest));
  const res = xwe(['run', '--manifest', file, '--out', outRoot]);
  check('manifest with `path` instead of `s3Key` exits 0', res.status === 0, res.stderr.split('\n').at(-2) ?? '');
  const result = readJson(join(outRoot, 'golden-path-alias', 'result.json'));
  check('path alias: same overspeed event', result.status === 'succeeded' && result.events.length === 1 && result.events[0].occurredAt === '2026-08-12T23:56:01.289Z');
}

// --- the library: createEngine + localHost, ESM and CJS --------------------
const LIB_BODY = (imports) => `
  ${imports}
  const msgs = [];
  const engine = createEngine({ host: localHost({ outDir: ${JSON.stringify(outRoot)}, baseDir: ${JSON.stringify(root)} }) });
  const ok = await engine.run({ template: 'fixtures/templates/overspeed.json', inputs: { telemetry: 'fixtures/telemetry/window.csv' }, runId: 'golden-lib-' + FMT, progress: (m) => msgs.push(m.t) });
  const failed = await engine.run({ template: 'fixtures/templates/overspeed.json', inputs: { telemetry: 'missing.csv' }, runId: 'golden-lib-fail-' + FMT });
  let usage = null;
  try { await engine.run({ template: 'fixtures/templates/overspeed.json', inputs: {} }); } catch (e) { usage = { isUsage: e instanceof XweUsageError, exitCode: e.exitCode, message: e.message }; }
  console.log(JSON.stringify({
    status: ok.result.status, events: ok.result.events.length, occurredAt: ok.result.events[0]?.occurredAt, runDir: ok.runDir, outcomeSteps: ok.outcome.steps.length, msgs,
    failedStatus: failed.result.status, failedNode: failed.result.failedNodeId, failedRunDir: failed.runDir, usage,
  }));
`;
for (const [fmt, argv, imports] of [
  ['esm', ['--input-type=module', '-e'], `const FMT = 'esm';
   import { createEngine, XweUsageError } from ${JSON.stringify(join(root, 'dist/esm/index.js'))};
   import { localHost } from ${JSON.stringify(join(root, 'dist/esm/local/index.js'))};`],
  ['cjs', ['-e'], `const FMT = 'cjs';
   const { createEngine, XweUsageError } = require(${JSON.stringify(join(root, 'dist/cjs/index.js'))});
   const { localHost } = require(${JSON.stringify(join(root, 'dist/cjs/local/index.js'))});
   (async () => {`],
]) {
  const body = fmt === 'cjs' ? `${LIB_BODY(imports)}\n})().catch((e) => { console.error(e); process.exit(9); });` : LIB_BODY(imports);
  const res = spawnSync(process.execPath, [...argv, body], { cwd: root, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(res.stdout.trim().split('\n').at(-1)); } catch { /* reported below */ }
  check(`library (${fmt}) script runs`, res.status === 0 && out !== null, res.stderr.trim().split('\n').at(-1) ?? '');
  check(`library (${fmt}): run resolves { result, runDir, outcome } with the overspeed event`,
    out?.status === 'succeeded' && out?.events === 1 && out?.occurredAt === '2026-08-12T23:56:01.289Z' && out?.outcomeSteps === 4 && out?.runDir === join(outRoot, 'golden-lib-' + fmt));
  check(`library (${fmt}): progress callback saw status/step/event messages`,
    Array.isArray(out?.msgs) && out.msgs[0] === 'status' && out.msgs.at(-1) === 'status' && out.msgs.includes('step') && out.msgs.includes('event'), String(out?.msgs));
  check(`library (${fmt}): a failed run resolves with result.json written`,
    out?.failedStatus === 'failed' && out?.failedNode === 'n1' && existsSync(join(outRoot, 'golden-lib-fail-' + fmt, 'result.json')));
  check(`library (${fmt}): a usage error rejects with XweUsageError exitCode 2`,
    out?.usage?.isUsage === true && out?.usage?.exitCode === 2, out?.usage?.message);
}

// --- doctor -------------------------------------------------------------------
{
  const res = xwe(['doctor']);
  const lines = res.stdout.trim().split('\n');
  check('doctor exits 0 on this machine', res.status === 0, res.stdout.trim());
  check('doctor header names the package version, node, platform', /^xwe \S+ \(node \d+\.\d+\.\d+, \w+ \w+\)$/.test(lines[0] ?? ''), lines[0]);
  check('doctor lists ffmpeg, onnxruntime-node, vlm providers, models, registry, catalog in order',
    ['ffmpeg', 'onnxruntime-node', 'vlm providers', 'models', 'registry', 'catalog'].every((label, i, all) => {
      const idx = lines.findIndex((l) => l.startsWith(`  ${label.padEnd(18)}`));
      const prev = i === 0 ? 0 : lines.findIndex((l) => l.startsWith(`  ${all[i - 1].padEnd(18)}`));
      return idx > 0 && idx > prev;
    }), lines.slice(1).join(' | '));
  check('doctor catalog line carries the frozen core hash', lines.some((l) => l === '  catalog           26 nodes, core e481243f5ffe4678, no packs'));
  check('doctor registry line is "not configured" until the registry ships', lines.some((l) => l === '  registry          not configured'));
}

if (!failed) rmSync(outRoot, { recursive: true, force: true });
else console.error(`artifacts kept for inspection: ${outRoot}`);
process.exit(failed ? 1 : 0);
