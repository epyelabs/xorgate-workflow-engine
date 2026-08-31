#!/usr/bin/env node
// The repo's regression gate (M3): the overspeed and perimeter golden runs
// over the M2 fixtures, driven through the real CLI. Run `npm run build` first
// (`npm test` does).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
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
  const res = spawnSync(process.execPath, [join(root, 'dist/cli/index.js'), ...args], {
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

if (!failed) rmSync(outRoot, { recursive: true, force: true });
else console.error(`artifacts kept for inspection: ${outRoot}`);
process.exit(failed ? 1 : 0);
