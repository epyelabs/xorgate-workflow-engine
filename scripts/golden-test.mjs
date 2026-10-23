#!/usr/bin/env node
// The repo's regression gate: the overspeed and perimeter golden runs over
// the fixtures, driven through the real CLI, plus the library surface
// (createEngine + localHost in ESM and CJS), the local `path` alias,
// `xwe doctor`, models, packs, the conformance kit, secret hygiene, log
// levels and the code function nodes. Run `npm run build` first (`npm test` does).
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, existsSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = mkdtempSync(join(tmpdir(), 'xwe-golden-'));

let failed = false;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

function xwe(args, env = {}) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [join(root, 'dist/cjs/cli/index.js'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, XWE_MODELS_DIR: join(outRoot, 'empty-cache'), ...env },
  });
  return { ...res, seconds: (Date.now() - started) / 1000 };
}
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const MODELS_DIR = ['--models-dir', 'fixtures/models'];

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
    ...MODELS_DIR,
    '--out', outRoot,
    '--run-id', 'golden-perimeter',
  ]);
  check('perimeter run exits 0', res.status === 0, res.stderr.split('\n').at(-2) ?? '');
  console.log(`     (perimeter wall time: ${res.seconds.toFixed(1)}s)`);

  const result = readJson(join(outRoot, 'golden-perimeter', 'result.json'));
  check('result: succeeded, 5 ok steps', result.status === 'succeeded' && result.steps.length === 5 && result.steps.every((s) => s.status === 'ok'));
  const decode = result.steps.find((s) => s.nodeId === 'n2');
  check('decoded 50 frames at 2 fps', /^50 frame\(s\) sampled at 2 fps/.test(decode?.output ?? ''), decode?.output);
  check('model log line names the version and a cwd-relative path', res.stderr.includes('[xwe] model detection/yolov8n v1 <- fixtures/models/detection/yolov8n/1/model.onnx'), res.stderr.split('\n').find((l) => l.startsWith('[xwe] model')));
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
    ...MODELS_DIR,
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
  check('doctor catalog line carries the current core hash', lines.some((l) => l === '  catalog           28 nodes, core 51116ae4e9dd8ba4, no packs'));
  check('doctor registry line names the registry URL and its reachability', lines.some((l) => /^ {2}registry {10}https:\/\/models\.xorgate\.io \((index: \d+ models?|unreachable: .+|index\.json: HTTP \d+)\)$/.test(l)), lines.find((l) => l.startsWith('  registry')));
  check('doctor models lines are the explicit root and the cache only (no ./fixtures/models by default)', !lines.some((l) => l.includes('./fixtures/models')) && lines.some((l) => l.startsWith('  models            ') && l.includes('empty-cache')), lines.filter((l) => /^ {2}(models| {6})/.test(l)).join(' | '));
}

// --- models: the registry mirror, pull, verify, --pull, path, list ------------
// A static server over a mirror built by scripts/registry-sync.mjs stands in
// for https://models.xorgate.io (the acceptance runs the same against `npx serve`).
// It runs as a separate process: spawnSync below blocks this process's event loop.
function serveDir(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts/serve-static.mjs'), dir, '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const m = buf.match(/^listening (http:\/\/[^\s]+)/m);
      if (m) resolve({ server: child, url: m[1] });
    });
    child.on('exit', (code) => reject(new Error(`serve-static exited early with ${code}`)));
    setTimeout(() => reject(new Error('serve-static did not start in 5s')), 5000).unref();
  });
}

{
  const mirror = join(outRoot, 'registry-mirror');
  const sync = spawnSync(process.execPath, [join(root, 'scripts/registry-sync.mjs'), 'fixtures/models', mirror], { cwd: root, encoding: 'utf8' });
  check('registry-sync builds a mirror with index.json', sync.status === 0 && existsSync(join(mirror, 'index.json')) && existsSync(join(mirror, 'detection/yolov8n/1/model.onnx')), sync.stderr.trim() || sync.stdout.trim().split('\n').at(-1));
  const index = readJson(join(mirror, 'index.json'));
  const fixtureSha = sha256(join(root, 'fixtures/models/detection/yolov8n/1/model.onnx'));
  check('index.json is an array of manifests carrying files.sha256', Array.isArray(index) && index.length === 1 && index[0].name === 'yolov8n' && index[0].files?.['model.onnx']?.sha256 === fixtureSha, JSON.stringify(index[0]?.files));

  const { server, url } = await serveDir(mirror);
  const cache = join(outRoot, 'cache');
  const env = { XWE_MODEL_REGISTRY: url, XWE_MODELS_DIR: cache };
  try {
    let res = xwe(['models', 'list'], env);
    check('models list reads the mirror index (nothing cached yet)', res.status === 0 && res.stdout.includes(`registry ${url} (1 model)`) && /detection\/yolov8n@1 +yolov8n +12\.3 MB$/m.test(res.stdout) && !res.stdout.includes('cached'), res.stdout.trim() || res.stderr.trim());

    res = xwe(['models', 'pull', 'detection/yolov8n'], env);
    check('models pull downloads into the cache and verifies sha256', res.status === 0 && res.stdout.trim() === `pulled detection/yolov8n@1 -> ${cache}/detection/yolov8n/1 (model.onnx 12.3 MB, sha256 verified)`, res.stdout.trim() || res.stderr.trim());
    check('pulled files are byte-identical to the fixture', existsSync(join(cache, 'detection/yolov8n/1/manifest.json')) && sha256(join(cache, 'detection/yolov8n/1/model.onnx')) === fixtureSha);

    res = xwe(['models', 'list'], env);
    check('models list marks the pulled model as cached', res.status === 0 && new RegExp(`detection/yolov8n@1 .*cached \\(${cache.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`).test(res.stdout), res.stdout.trim());

    res = xwe(['models', 'pull', 'detection/yolov8n@1'], env);
    check('models pull of a cached version downloads nothing', res.status === 0 && res.stdout.startsWith('detection/yolov8n@1 already in '), res.stdout.trim());

    res = xwe(['models', 'path', 'detection/yolov8n'], env);
    check('models path prints the cached file and the root', res.status === 0 && res.stdout.split('\n')[0] === join(cache, 'detection/yolov8n/1/model.onnx') && res.stdout.includes('detection/yolov8n v1, from the cache'), res.stdout.trim());

    res = xwe(['models', 'pull', 'detection/nope'], env);
    check('models pull of an unknown model exits 1 and names the registry', res.status === 1 && res.stderr.includes('model detection/nope is not in the registry'), res.stderr.trim());

    // A corrupted mirror: one flipped byte must be caught and nothing kept.
    const bad = join(outRoot, 'registry-bad');
    cpSync(mirror, bad, { recursive: true });
    const onnx = join(bad, 'detection/yolov8n/1/model.onnx');
    const bytes = readFileSync(onnx);
    bytes[1000] ^= 0xff;
    writeFileSync(onnx, bytes);
    const { server: badServer, url: badUrl } = await serveDir(bad);
    const cache2 = join(outRoot, 'cache-bad');
    try {
      res = xwe(['models', 'pull', 'detection/yolov8n'], { XWE_MODEL_REGISTRY: badUrl, XWE_MODELS_DIR: cache2 });
      check('a sha256 mismatch exits 1 and names the model', res.status === 1 && /^xwe: detection\/yolov8n@1: model\.onnx sha256 mismatch .*; nothing kept$/m.test(res.stderr), res.stderr.trim());
      check('a sha256 mismatch keeps no file in the cache', !existsSync(join(cache2, 'detection/yolov8n/1/model.onnx')) && !existsSync(join(cache2, 'detection/yolov8n/1/manifest.json')) && (!existsSync(join(cache2, 'detection/yolov8n/1')) || readdirSync(join(cache2, 'detection/yolov8n/1')).length === 0));
    } finally {
      badServer.kill();
    }

    // --pull on a run with an empty cache: the registry is the third link.
    const cache3 = join(outRoot, 'cache-pull');
    res = xwe(['run', 'fixtures/templates/perimeter-person-detect.json', '--input', 'video=fixtures/video/drive.mp4', '--out', outRoot, '--run-id', 'golden-pull', '--pull'], { XWE_MODEL_REGISTRY: url, XWE_MODELS_DIR: cache3 });
    check('run --pull fetches the missing model and succeeds', res.status === 0 && res.stderr.includes(`[xwe] pulled detection/yolov8n@1 from ${url}`) && res.stderr.includes('sha256 verified'), res.stderr.trim().split('\n').slice(-3).join(' | '));
    const pulledResult = readJson(join(outRoot, 'golden-pull', 'result.json'));
    const pulledDetect = pulledResult.steps.find((s) => s.nodeId === 'n3');
    check('run --pull: same detections from the pulled model', /^\d+ detection\(s\) over 50 frame\(s\) \(yolov8n v1/.test(pulledDetect?.output ?? '') && Math.abs(Number(pulledDetect.output.match(/^(\d+)/)[1]) - 81) <= 15, pulledDetect?.output);

    res = xwe(['run', 'fixtures/templates/perimeter-person-detect.json', '--input', 'video=fixtures/video/drive.mp4', '--out', outRoot, '--run-id', 'golden-pull-env'], { XWE_MODEL_REGISTRY: url, XWE_MODELS_DIR: cache3, XWE_MODELS_PULL: '1' });
    check('XWE_MODELS_PULL=1 with a warm cache runs without pulling again', res.status === 0 && !res.stderr.includes('pulled ') && res.stderr.includes(`[xwe] model detection/yolov8n v1 <- ${join(cache3, 'detection/yolov8n/1/model.onnx')}`), res.stderr.trim().split('\n')[0]);

    // No pull, empty cache: the documented two-line error, exit 1, result.json written.
    const cache4 = join(outRoot, 'cache-empty');
    res = xwe(['run', 'fixtures/templates/perimeter-person-detect.json', '--input', 'video=fixtures/video/drive.mp4', '--models-dir', './models-missing', '--out', outRoot, '--run-id', 'golden-nomodel'], { XWE_MODEL_REGISTRY: url, XWE_MODELS_DIR: cache4 });
    check('a model in no root fails the step with the documented text', res.status === 1 && res.stderr.includes(`xwe: run failed at node n3: model detection/yolov8n not found under ./models-missing, ${cache4}\n  (run \`xwe models pull detection/yolov8n\`, or pass --pull)`), res.stderr.trim().split('\n').slice(-2).join(' | '));
    check('a model miss still lands result.json with the failing node', readJson(join(outRoot, 'golden-nomodel', 'result.json')).failedNodeId === 'n3');

    // doctor against the mirror
    res = xwe(['doctor'], env);
    check('doctor reports the registry index size when reachable', res.stdout.includes(`  registry          ${url} (index: 1 model)`), res.stdout.split('\n').find((l) => l.startsWith('  registry')));
  } finally {
    server.kill();
  }
}

// --- models check + bring-your-own model (acme-test) --------------------------
{
  const own = join(outRoot, 'own-models');
  const dir = join(own, 'detection/acme-test/1');
  mkdirSync(dir, { recursive: true });
  cpSync(join(root, 'fixtures/models/detection/yolov8n/1/model.onnx'), join(dir, 'model.onnx'));
  const manifest = readJson(join(root, 'fixtures/models/detection/yolov8n/1/manifest.json'));
  delete manifest.files;
  manifest.name = 'acme-test';
  manifest.label = 'Acme test detector';
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  let res = xwe(['models', 'check', dir]);
  const lines = res.stdout.trim().split('\n');
  check('models check exits 0 with four ok lines', res.status === 0 && lines.length === 4 && lines.every((l) => /^(manifest|model|session|output) {2,}ok {3}/.test(l)), res.stdout.trim() || res.stderr.trim());
  check('check line 1: identity, kind, classes, geometry', lines[0] === 'manifest   ok   detection/acme-test v1, yolov8, 80 classes, 640x640 nchw rgb', lines[0]);
  check('check line 2: sha256 recorded when the manifest lacked files', lines[1] === 'model      ok   model.onnx 12.3 MB, sha256 recorded in manifest.json', lines[1]);
  check('check line 3: session with the input tensor', /^session {4}ok {3}onnxruntime-node \d+\.\d+\.\d+, input "images" \[1,3,640,640\]$/.test(lines[2]), lines[2]);
  check('check line 4: output shape matches yolov8 with 80 classes', lines[3] === 'output     ok   "output0" [1,84,8400] matches yolov8 with 80 classes (4 + 80)', lines[3]);
  const filled = readJson(join(dir, 'manifest.json'));
  check('check filled files.sha256 and sizeBytes into manifest.json', filled.files?.['model.onnx']?.sha256 === sha256(join(dir, 'model.onnx')) && filled.files['model.onnx'].sizeBytes === 12851122, JSON.stringify(filled.files));
  res = xwe(['models', 'check', dir]);
  check('a second check verifies the recorded sha256', res.status === 0 && res.stdout.split('\n')[1] === 'model      ok   model.onnx 12.3 MB, sha256 verified', res.stdout.split('\n')[1]);

  // A wrong class list fails the output stage with both numbers.
  const wrong = join(outRoot, 'own-models-wrong/detection/acme-two/1');
  mkdirSync(wrong, { recursive: true });
  cpSync(join(dir, 'model.onnx'), join(wrong, 'model.onnx'));
  writeFileSync(join(wrong, 'manifest.json'), JSON.stringify({ ...filled, name: 'acme-two', classNames: ['forklift', 'pallet'] }, null, 2));
  res = xwe(['models', 'check', wrong]);
  check('a class-count mismatch fails the output line with both numbers', res.status === 1 && res.stdout.includes('output     fail "output0" [1,84,8400] does not match yolov8 with 2 classes: expected 4 + 2 = 6 rows, got 84 (a model with 80 classes?)'), res.stdout.trim().split('\n').at(-1));

  // The bring-your-own golden: the perimeter template naming acme-test.
  const template = readJson(join(root, 'fixtures/templates/perimeter-person-detect.json'));
  for (const n of template.nodes) if (n.type === 'model.object_detection') n.data.config.model = 'acme-test';
  const templateFile = join(outRoot, 'perimeter-acme.json');
  writeFileSync(templateFile, JSON.stringify(template));
  res = xwe(['run', templateFile, '--input', 'video=fixtures/video/drive.mp4', '--models-dir', own, '--out', outRoot, '--run-id', 'golden-acme']);
  check('bring-your-own run exits 0', res.status === 0, res.stderr.split('\n').at(-2) ?? '');
  const result = readJson(join(outRoot, 'golden-acme', 'result.json'));
  const detect = result.steps.find((s) => s.nodeId === 'n3');
  const m = (detect?.output ?? '').match(/^(\d+) detection\(s\) over 50 frame\(s\) \(acme-test v1, ~\d+ ms\/frame\)$/);
  check('bring-your-own: 81 ± 15 detections and the summary names acme-test v1', m !== null && Math.abs(Number(m[1]) - 81) <= 15, detect?.output);
  check('bring-your-own: the log line names the explicit root', res.stderr.includes(`[xwe] model detection/acme-test v1 <- ${join(own, 'detection/acme-test/1/model.onnx')}`), res.stderr.split('\n')[0]);

  // Pinned to a version that does not exist under the root: the miss names the pin.
  for (const n of template.nodes) if (n.type === 'model.object_detection') n.data.config.model = 'acme-test@2';
  writeFileSync(templateFile, JSON.stringify(template));
  res = xwe(['run', templateFile, '--input', 'video=fixtures/video/drive.mp4', '--models-dir', own, '--out', outRoot, '--run-id', 'golden-acme-pin']);
  check('a pinned version that is absent fails naming the pin', res.status === 1 && res.stderr.includes('model detection/acme-test@2 not found under') && res.stderr.includes('(run `xwe models pull detection/acme-test@2`, or pass --pull)'), res.stderr.trim().split('\n').slice(-2).join(' | '));

  // checkModelDir from the library (ESM), fill off.
  const lib = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { checkModelDir } from ${JSON.stringify(join(root, 'dist/esm/local/index.js'))};
    const report = await checkModelDir(${JSON.stringify(dir)}, { fill: false });
    console.log(JSON.stringify({ ok: report.ok, problems: report.problems, stages: report.lines.map((l) => l.stage), name: report.manifest?.name }));
  `], { cwd: root, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(lib.stdout.trim().split('\n').at(-1)); } catch { /* below */ }
  check('checkModelDir (esm) returns { ok, problems } for the acme-test directory', out?.ok === true && Array.isArray(out.problems) && out.problems.length === 0 && out.stages.join(',') === 'manifest,model,session,output' && out.name === 'acme-test', lib.stderr.trim().split('\n').at(-1) || JSON.stringify(out));
}

// --- node packs: the example pack through --pack, the library and the payload --
// examples/packs/acme-scale is the `acme.scale` node from extending.mdx; the
// scaled overspeed graph multiplies the derived speed by 0.05, so the
// threshold that fires once on the plain overspeed graph never fires.
{
  const PACK = ['--pack', './examples/packs/acme-scale'];
  const scaled = 'examples/packs/acme-scale/overspeed-scaled.json';
  const packLine = '[xwe] pack @acme/xwe-nodes-scale v1.0.0 (1 node) <- ./examples/packs/acme-scale/index.js';
  const pkgVersion = readJson(join(root, 'package.json')).version;

  let res = xwe(['validate', 'fixtures/templates/overspeed.json', ...PACK]);
  check('validate --pack ./examples/packs/acme-scale exits 0 on a core-only template', res.status === 0 && res.stdout.startsWith('OK: 4 nodes, 3 edges'), res.stdout.trim() || res.stderr.trim());
  check('the pack line names the pack, version, node count and the resolved file', res.stderr.trim() === packLine, res.stderr.trim());
  res = xwe(['validate', scaled, ...PACK]);
  check('validate --pack accepts the template that uses acme.scale', res.status === 0 && res.stdout.startsWith('OK: 5 nodes, 4 edges') && res.stdout.includes('--input telemetry='), res.stdout.trim() || res.stderr.trim());
  res = xwe(['validate', scaled]);
  check('validate without the pack exits 1 naming the unknown type and its namespace', res.status === 1 && res.stderr.includes('UNKNOWN_NODE_TYPE [n2b]: Unknown node type "acme.scale": namespace "acme" is not in the core catalog; register its pack (--pack <module>, or createEngine({ packs }))'), res.stderr.trim().split('\n')[1]);
  res = xwe(['validate', scaled, '--pack', './does-not-exist']);
  check('--pack of a module that does not resolve exits 2', res.status === 2 && res.stderr.startsWith('xwe: --pack ./does-not-exist: cannot resolve it from'), res.stderr.trim());
  res = xwe(['validate', scaled, ...PACK, ...PACK]);
  check('the same pack twice exits 2 naming the pack', res.status === 2 && res.stderr.includes('pack "@acme/xwe-nodes-scale" is registered twice'), res.stderr.trim().split('\n').at(-1));

  // A second pack as a CommonJS file next to the workspace (`--pack ./local-pack.cjs`).
  const localPack = join(outRoot, 'local-pack.cjs');
  writeFileSync(localPack, `
    const { defineNode, requireInput, telemetrySamples } = require(${JSON.stringify(join(root, 'dist/cjs/index.js'))});
    const { z } = require(${JSON.stringify(join(root, 'node_modules/zod'))});
    const def = defineNode({ type: 'acme.passthrough', version: 1, group: 'telemetry', label: 'Passthrough', description: 'Forwards telemetry unchanged.', ui: { icon: 'arrow-right' },
      inputs: [{ id: 'telemetry', label: 'Telemetry', channel: 'telemetry', cardinality: 'one', required: true }],
      outputs: [{ id: 'telemetry', label: 'Telemetry', channel: 'telemetry', cardinality: 'many', required: false }],
      config: z.object({}), requires: [], runtime: { target: 'any' } });
    async function* executor(inputs, config, ctx) { let n = 0; for await (const s of telemetrySamples(requireInput(inputs, 'telemetry'))) { n++; yield { ch: 'telemetry', ts: s.ts, payload: { signals: s.signals } }; } ctx.setSummary('forwarded ' + n + ' samples'); }
    module.exports = { name: 'local-pack', version: '0.0.1', nodes: [{ def, executor }] };
  `);
  res = xwe(['validate', scaled, ...PACK, '--pack', localPack]);
  check('two packs load in order (an ES module directory and a CommonJS file)', res.status === 0 && res.stderr.trim().split('\n')[0] === packLine && res.stderr.includes(`[xwe] pack local-pack v0.0.1 (1 node) <- ${realpathSync(localPack)}`), res.stderr.trim());
  writeFileSync(join(outRoot, 'core-ns-pack.cjs'), `module.exports = { name: 'bad', version: '1', nodes: [{ def: { ...require(${JSON.stringify(localPack)}).nodes[0].def, type: 'telemetry.passthrough' }, executor: async function* () {} }] };`);
  res = xwe(['validate', scaled, '--pack', join(outRoot, 'core-ns-pack.cjs')]);
  check('a pack node in a core namespace exits 2 naming the node and the namespace', res.status === 2 && res.stderr.includes('Pack "bad": node type "telemetry.passthrough" uses the core namespace "telemetry"'), res.stderr.trim().split('\n').at(-1));
  writeFileSync(join(outRoot, 'no-pack.cjs'), 'module.exports = { hello: 1 };');
  res = xwe(['validate', scaled, '--pack', join(outRoot, 'no-pack.cjs')]);
  check('a module that exports no pack exits 2 saying what a pack export looks like', res.status === 2 && res.stderr.includes('exports no pack (export `pack`, or a default export, shaped { name, version, nodes })'), res.stderr.trim());

  // run: the scaled signal flips the threshold outcome.
  res = xwe(['run', scaled, ...PACK, '--input', 'telemetry=fixtures/telemetry/window.csv', '--out', outRoot, '--run-id', 'golden-pack']);
  check('run --pack over the scaled overspeed graph exits 0', res.status === 0 && res.stderr.trim().split('\n')[0] === packLine, res.stderr.trim().split('\n').at(-1));
  const packResult = readJson(join(outRoot, 'golden-pack', 'result.json'));
  const scaleStep = packResult.steps.find((s) => s.nodeId === 'n2b');
  check('acme.scale ran as step n2b with its documented summary', scaleStep?.status === 'ok' && scaleStep.output === 'scaled 150 samples (speed_kph × 0.05)', scaleStep?.output);
  const gate = packResult.steps.find((s) => s.nodeId === 'n3');
  check('the scaled signal flips the threshold: true on 0/149 and 0 events (149/149 and 1 event unscaled)', packResult.status === 'succeeded' && /^true on 0\/149 samples/.test(gate?.output ?? '') && packResult.events.length === 0, `${gate?.output} | events: ${packResult.events.length}`);
  res = xwe(['run', scaled, '--input', 'telemetry=fixtures/telemetry/window.csv', '--out', outRoot, '--run-id', 'golden-pack-missing']);
  check('run without the pack is a usage error (exit 2) that runs nothing', res.status === 2 && res.stderr.includes('UNKNOWN_NODE_TYPE at n2b: Unknown node type "acme.scale"') && !existsSync(join(outRoot, 'golden-pack-missing')), res.stderr.trim());

  // The library: createCatalog, the payload's packs[], createEngine({ packs | catalog }), the rules.
  const PACK_LIB = (imports) => `
    ${imports}
    const catalog = createCatalog([...corePacks, pack]);
    const core = buildCatalogPayload();
    const withPack = buildCatalogPayload(catalog);
    const tpl = JSON.parse(readFileSync(${JSON.stringify(join(root, scaled))}, 'utf8'));
    const engine = createEngine({ host: localHost({ outDir: ${JSON.stringify(outRoot)}, baseDir: ${JSON.stringify(root)} }), packs: [pack] });
    const run = await engine.run({ template: tpl, inputs: { telemetry: 'fixtures/telemetry/window.csv' }, runId: 'golden-pack-lib-' + FMT });
    const viaCatalog = await createEngine({ host: localHost({ outDir: ${JSON.stringify(outRoot)}, baseDir: ${JSON.stringify(root)} }), catalog }).run({ template: tpl, inputs: { telemetry: 'fixtures/telemetry/window.csv' }, runId: 'golden-pack-lib-catalog-' + FMT });
    const errors = {};
    try { createEngine({ host: localHost(), catalog, packs: [pack] }); } catch (e) { errors.both = e instanceof XweUsageError && e.message; }
    try { createCatalog([...corePacks, { name: 'x', version: '1', nodes: [{ def: { ...pack.nodes[0].def, type: 'model.scale' }, executor: pack.nodes[0].executor }] }]); } catch (e) { errors.namespace = e.message; }
    try { createCatalog([...corePacks, pack, { name: 'y', version: '1', nodes: pack.nodes }]); } catch (e) { errors.duplicate = e.message; }
    try { createCatalog([{ name: 'z', version: '1', nodes: [{ def: { ...pack.nodes[0].def, type: 'acme.untagged', outputs: [{ id: 'o', label: 'O', channel: 'json', cardinality: 'many', required: false }] }, executor: pack.nodes[0].executor }] }]); } catch (e) { errors.tag = e.message; }
    const minusModel = createCatalog(corePacks.filter((p) => p.name !== 'core/model'));
    console.log(JSON.stringify({
      coreVersion: core.catalogVersion, corePacks: core.packs, coreNodes: core.nodes.length,
      packs: withPack.packs, version: withPack.catalogVersion, nodes: withPack.nodes.length, cached: buildCatalogPayload(catalog) === withPack,
      corePackNames: corePacks.map((p) => p.name), enginePacks: engine.catalog.packs.length,
      validateCore: validateDefinition(tpl).issues.map((i) => i.code), validatePack: validateDefinition(tpl, catalog).ok, inspectKey: inspectTemplate(tpl, catalog).inputs[0].key,
      run: { status: run.result.status, events: run.result.events.length, scale: run.result.steps.find((s) => s.nodeId === 'n2b')?.output, gate: run.result.steps.find((s) => s.nodeId === 'n3')?.output },
      viaCatalog: viaCatalog.result.status, errors,
      minusModel: { nodes: minusModel.listNodeTypes().length, packs: minusModel.payload().packs, hasDetection: minusModel.getNodeType('model.object_detection') !== undefined },
    }));
  `;
  for (const [fmt, argv, imports] of [
    ['esm', ['--input-type=module', '-e'], `const FMT = 'esm';
     import { readFileSync } from 'node:fs';
     import { createEngine, createCatalog, corePacks, buildCatalogPayload, validateDefinition, inspectTemplate, XweUsageError } from ${JSON.stringify(join(root, 'dist/esm/index.js'))};
     import { localHost } from ${JSON.stringify(join(root, 'dist/esm/local/index.js'))};
     import { pack } from ${JSON.stringify(join(root, 'examples/packs/acme-scale/index.js'))};`],
    ['cjs', ['-e'], `const FMT = 'cjs';
     const { readFileSync } = require('node:fs');
     const { createEngine, createCatalog, corePacks, buildCatalogPayload, validateDefinition, inspectTemplate, XweUsageError } = require(${JSON.stringify(join(root, 'dist/cjs/index.js'))});
     const { localHost } = require(${JSON.stringify(join(root, 'dist/cjs/local/index.js'))});
     const { pack } = require(${JSON.stringify(join(root, 'examples/packs/acme-scale/index.js'))});
     (async () => {`],
  ]) {
    const body = fmt === 'cjs' ? `${PACK_LIB(imports)}\n})().catch((e) => { console.error(e); process.exit(9); });` : PACK_LIB(imports);
    const lib = spawnSync(process.execPath, [...argv, body], { cwd: root, encoding: 'utf8' });
    let out = null;
    try { out = JSON.parse(lib.stdout.trim().split('\n').at(-1)); } catch { /* reported below */ }
    check(`packs (${fmt}) library script runs`, lib.status === 0 && out !== null, lib.stderr.trim().split('\n').slice(-3).join(' | '));
    // 0.5.1: the core hash moved on purpose (connector.third_party / logic.comparator fields).
    check(`packs (${fmt}): the core payload is the current one: 51116ae4e9dd8ba4, 28 nodes, one core pack entry with that hash`,
      out?.coreVersion === '51116ae4e9dd8ba4' && out?.coreNodes === 28 && JSON.stringify(out?.corePacks) === JSON.stringify([{ name: 'core', version: pkgVersion, hash: '51116ae4e9dd8ba4' }]), JSON.stringify(out?.corePacks));
    check(`packs (${fmt}): corePacks are the eight core namespaces in registry order, core/function last`,
      JSON.stringify(out?.corePackNames) === JSON.stringify(['core/source', 'core/connector', 'core/video', 'core/telemetry', 'core/model', 'core/logic', 'core/output', 'core/function']), String(out?.corePackNames));
    check(`packs (${fmt}): with the pack, packs[] has two entries, the core hash is unchanged and catalogVersion differs`,
      out?.packs?.length === 2 && out.packs[0].name === 'core' && out.packs[0].hash === '51116ae4e9dd8ba4' && out.packs[1].name === '@acme/xwe-nodes-scale' && out.packs[1].version === '1.0.0' && /^[0-9a-f]{16}$/.test(out.packs[1].hash) && out.version !== '51116ae4e9dd8ba4' && out.nodes === 29 && out.cached === true,
      `${JSON.stringify(out?.packs)} catalogVersion=${out?.version}`);
    check(`packs (${fmt}): validateDefinition reports the unknown type against core and passes against the pack catalog; inspectTemplate takes the catalog`,
      out?.validateCore?.includes('UNKNOWN_NODE_TYPE') && out?.validatePack === true && out?.inspectKey === 'telemetry', JSON.stringify([out?.validateCore, out?.validatePack, out?.inspectKey]));
    check(`packs (${fmt}): createEngine({ packs }) runs the scaled graph to 0 events; engine.catalog carries 9 packs`,
      out?.run?.status === 'succeeded' && out.run.events === 0 && out.run.scale === 'scaled 150 samples (speed_kph × 0.05)' && /^true on 0\/149/.test(out.run.gate ?? '') && out?.enginePacks === 9, JSON.stringify(out?.run));
    check(`packs (${fmt}): createEngine({ catalog }) runs it too`, out?.viaCatalog === 'succeeded', out?.viaCatalog);
    check(`packs (${fmt}): catalog and packs together is a usage error; a core namespace, a duplicate type and an untagged json output throw naming the node`,
      out?.errors?.both === 'createEngine takes a catalog or packs, not both' && out?.errors?.namespace?.includes('node type "model.scale" uses the core namespace "model"') && out?.errors?.duplicate?.includes('Duplicate catalog node type "acme.scale" (in pack "@acme/xwe-nodes-scale" and pack "y")') && out?.errors?.tag === 'json output "o" on "acme.untagged" must declare a tag', JSON.stringify(out?.errors));
    check(`packs (${fmt}): core minus core/model composes 24 nodes with a different core hash and no detection node`,
      out?.minusModel?.nodes === 24 && out.minusModel.hasDetection === false && out.minusModel.packs?.length === 1 && out.minusModel.packs[0].name === 'core' && out.minusModel.packs[0].hash !== '51116ae4e9dd8ba4', JSON.stringify(out?.minusModel));
  }
}

// --- the conformance kit (./testing): the four golden expectations through createEngine --
// `runConformance` against localHost in both module formats; a host missing the
// model and artifact seams fails the two media cases and nothing else; bad
// options reject with XweUsageError before anything runs.
const CONF_BODY = (imports) => `
  ${imports}
  const hostOpts = { modelDirs: ['fixtures/models'], outDir: ${JSON.stringify(outRoot)}, baseDir: ${JSON.stringify(root)} };
  const report = await runConformance({ host: localHost(hostOpts), fixturesDir: ${JSON.stringify(join(root, 'fixtures'))}, runIdPrefix: 'golden-conformance-' + FMT, log: (l) => console.error(l) });
  const local = localHost(hostOpts);
  const seamless = { bind: async (a) => { const b = await local.bind(a); const { artifacts, ...rest } = b; const { fetchModel, ...sources } = b.sources; return { ...rest, sources }; } };
  const bad = await runConformance({ host: seamless, fixturesDir: 'fixtures', runIdPrefix: 'golden-conformance-bad-' + FMT, cases: ['overspeed', 'detection'] });
  let usage = null; try { await runConformance({ fixturesDir: 'fixtures' }); } catch (e) { usage = { name: e.name, exitCode: e.exitCode }; }
  let missingDir = null; try { await runConformance({ host: local, fixturesDir: ${JSON.stringify(join(outRoot, 'nowhere'))} }); } catch (e) { missingDir = e.message; }
  console.log(JSON.stringify({ ok: report.ok, names: CONFORMANCE_CASE_NAMES, cases: report.cases.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail, runDir: c.runDir, durationMs: c.durationMs })), badOk: bad.ok, bad: bad.cases.map((c) => [c.name, c.ok, c.detail]), usage, missingDir }));
`;
for (const [fmt, argv, imports] of [
  ['esm', ['--input-type=module', '-e'], `const FMT = 'esm';
   import { runConformance, CONFORMANCE_CASE_NAMES } from ${JSON.stringify(join(root, 'dist/esm/testing/index.js'))};
   import { localHost } from ${JSON.stringify(join(root, 'dist/esm/local/index.js'))};`],
  ['cjs', ['-e'], `const FMT = 'cjs';
   const { runConformance, CONFORMANCE_CASE_NAMES } = require(${JSON.stringify(join(root, 'dist/cjs/testing/index.js'))});
   const { localHost } = require(${JSON.stringify(join(root, 'dist/cjs/local/index.js'))});
   (async () => {`],
]) {
  const body = fmt === 'cjs' ? `${CONF_BODY(imports)}\n})().catch((e) => { console.error(e); process.exit(9); });` : CONF_BODY(imports);
  const started = Date.now();
  const res = spawnSync(process.execPath, [...argv, body], { cwd: root, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(res.stdout.trim().split('\n').at(-1)); } catch { /* reported below */ }
  console.log(`     (conformance ${fmt} wall time: ${((Date.now() - started) / 1000).toFixed(1)}s)`);
  check(`conformance (${fmt}) script runs`, res.status === 0 && out !== null, res.stderr.trim().split('\n').slice(-3).join(' | '));
  const byName = Object.fromEntries((out?.cases ?? []).map((c) => [c.name, c]));
  check(`conformance (${fmt}): runConformance against localHost reports ok with the four cases in order`,
    out?.ok === true && JSON.stringify(out?.names) === JSON.stringify(['overspeed', 'detection', 'visualization', 'missing-input']) && out?.cases?.map((c) => c.name).join(',') === 'overspeed,detection,visualization,missing-input' && out.cases.every((c) => c.ok === true), JSON.stringify(out?.cases?.map((c) => [c.name, c.ok])));
  check(`conformance (${fmt}): overspeed = 1 event at the pinned timestamp, in the host's run directory`,
    byName.overspeed?.detail === '1 overspeed event at 2026-08-12T23:56:01.289Z, observed 77.7 km/h, 4 ok steps' && byName.overspeed?.runDir === join(outRoot, `golden-conformance-${fmt}-overspeed`), byName.overspeed?.detail);
  check(`conformance (${fmt}): detection = 50 frames, 81 ± 15 detections`, /^50 frames, \d+ detections \(81 ± 15\), 0 events$/.test(byName.detection?.detail ?? ''), byName.detection?.detail);
  check(`conformance (${fmt}): visualization = 50 annotated frames to the sink and an MP4 that decodes to 50 frames`,
    byName.visualization?.detail === '50 annotated frames, 50 reached the artifact sink, video/viz.mp4 decodes to 50 h264 frames at 2 fps', byName.visualization?.detail);
  check(`conformance (${fmt}): missing-input = failed at n1 with result.json written`,
    /^failed at n1 \(ENOENT: .*does-not-exist\.csv'\), result\.json on disk with status failed$/.test(byName['missing-input']?.detail ?? ''), byName['missing-input']?.detail);
  check(`conformance (${fmt}): a host without fetchModel and artifacts fails only the media case, naming the seam`,
    out?.badOk === false && JSON.stringify(out?.bad?.map((c) => [c[0], c[1]])) === JSON.stringify([['overspeed', true], ['detection', false]]) && out.bad[1][2] === 'status failed at n3: This engine target cannot load registry models (no media support)', JSON.stringify(out?.bad));
  check(`conformance (${fmt}): no host, or a fixtures directory without the templates, rejects with XweUsageError (exit code 2)`,
    out?.usage?.name === 'XweUsageError' && out?.usage?.exitCode === 2 && /nowhere\/templates\/overspeed\.json is missing/.test(out?.missingDir ?? ''), `${JSON.stringify(out?.usage)} ${out?.missingDir}`);
}

// --- secret hygiene: a fake XORGATE_SECRET_* appears in no artifact and no output line --
// The OSM connector template with httpFetch mocked (five samples: Overpass
// etiquette throttles lookups to ~1/s), then two providers that put the key
// into a failure (a 401 body echoing the request URL; an HTTP layer whose
// error carries the URL and the key): every artifact, NDJSON line and stderr
// line must be free of the value, and the failures must carry `[redacted]`.
{
  const FAKE = 'sk-fake-LEAK-0123456789abcdef';
  const hygRoot = join(outRoot, 'hygiene');
  mkdirSync(hygRoot, { recursive: true });
  const shortCsv = join(hygRoot, 'window-5.csv');
  writeFileSync(shortCsv, readFileSync(join(root, 'fixtures/telemetry/window.csv'), 'utf8').split('\n').slice(0, 6).join('\n') + '\n');
  const script = `
    import { readFileSync } from 'node:fs';
    import { createEngine } from ${JSON.stringify(join(root, 'dist/esm/index.js'))};
    import { localHost, ndjsonProgress } from ${JSON.stringify(join(root, 'dist/esm/local/index.js'))};
    const FAKE = process.env.XORGATE_SECRET_HERE_API_KEY;
    const osm = JSON.parse(readFileSync(${JSON.stringify(join(root, 'fixtures/templates/overspeed-osm.json'))}, 'utf8'));
    const here = structuredClone(osm);
    for (const n of here.nodes) if (n.type === 'connector.third_party') n.data.config.provider = 'here';
    const mocks = {
      osm: async () => new Response(JSON.stringify({ elements: [{ tags: { maxspeed: '60' } }] }), { status: 200 }),
      'here-401': async (url) => new Response(JSON.stringify({ error: 'invalid apikey', request: String(url) }), { status: 401 }),
      'here-throw': async (url) => { throw new Error('connect failed for ' + String(url) + ' (key ' + FAKE + ')'); },
    };
    const results = {};
    for (const [mode, mock] of Object.entries(mocks)) {
      const local = localHost({ outDir: ${JSON.stringify(hygRoot)}, baseDir: ${JSON.stringify(root)}, progress: ndjsonProgress((l) => console.log(l)) });
      const host = { bind: async (a) => ({ ...(await local.bind(a)), httpFetch: mock }) };
      const run = await createEngine({ host, log: 'debug' }).run({ template: mode === 'osm' ? osm : here, inputs: { telemetry: ${JSON.stringify(shortCsv)} }, runId: 'golden-hygiene-' + mode });
      results[mode] = { status: run.result.status, error: run.result.error, roads: run.result.steps.find((s) => s.nodeId === 'roads')?.output, records: run.result.artifacts.outputs.cap?.count ?? 0 };
    }
    console.log('RESULT ' + JSON.stringify(results));
  `;
  const started = Date.now();
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', env: { ...process.env, XORGATE_SECRET_HERE_API_KEY: FAKE, XORGATE_SECRET_GOOGLE_ROADS_API_KEY: `${FAKE}-google` } });
  console.log(`     (hygiene wall time: ${((Date.now() - started) / 1000).toFixed(1)}s)`);
  let hyg = null;
  try { hyg = JSON.parse(res.stdout.split('\n').find((l) => l.startsWith('RESULT ')).slice(7)); } catch { /* reported below */ }
  check('hygiene: the OSM connector template runs with httpFetch mocked and a fake XORGATE_SECRET_* in the environment', res.status === 0 && hyg?.osm?.status === 'succeeded' && /^5 speed-limit record\(s\) via osm, 5 lookup\(s\)$/.test(hyg.osm.roads ?? '') && hyg.osm.records === 5, hyg ? JSON.stringify(hyg.osm) : res.stderr.trim().split('\n').slice(-3).join(' | '));
  check('hygiene: a provider that echoes the request URL in a 401 body fails the step with the key redacted', hyg?.['here-401']?.status === 'failed' && hyg['here-401'].error.startsWith('HERE rejected the API key (HTTP 401)') && hyg['here-401'].error.includes('apikey=[redacted]') && !hyg['here-401'].error.includes(FAKE), hyg?.['here-401']?.error);
  check('hygiene: an HTTP layer whose error carries the URL and the key is redacted too (both forms)', hyg?.['here-throw']?.status === 'failed' && hyg['here-throw'].error.includes('apikey=[redacted]') && hyg['here-throw'].error.includes('(key [redacted])') && !hyg['here-throw'].error.includes(FAKE), hyg?.['here-throw']?.error);
  const artifactFiles = [];
  (function walk(dir) { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(json|jsonl|csv|txt)$/.test(e.name)) artifactFiles.push(p); } })(hygRoot);
  const leaks = artifactFiles.filter((f) => readFileSync(f, 'utf8').includes(FAKE));
  check('hygiene: the fake secret appears in no artifact (result.json, events.jsonl, outputs/**) of the three runs', leaks.length === 0 && artifactFiles.filter((f) => f.endsWith('result.json')).length === 3, leaks.join(', ') || `${artifactFiles.length} files scanned`);
  check('hygiene: the fake secret appears in no stdout (NDJSON) or stderr line; the redacted text does', !res.stdout.includes(FAKE) && !res.stderr.includes(FAKE) && res.stdout.includes('"t":"status"') && res.stdout.includes('apikey=[redacted]') && res.stderr.includes('[engine] run golden-hygiene-osm:'), `${res.stdout.split('\n').length} stdout lines, ${res.stderr.split('\n').length} stderr lines`);
  console.log(`     (grep -R "${FAKE}" ${hygRoot} -> ${leaks.length === 0 ? 'no leak' : 'LEAK'})`);

  // The CLI with the same fake secret in its environment.
  const env = { XORGATE_SECRET_HERE_API_KEY: FAKE };
  let r = xwe(['run', 'fixtures/templates/overspeed.json', '--input', 'telemetry=fixtures/telemetry/window.csv', '--out', hygRoot, '--run-id', 'golden-hygiene-cli', '--progress', 'json', '--log-level', 'debug'], env);
  check('hygiene (cli): a run with the fake secret in the environment prints it nowhere (NDJSON, debug stderr, artifacts)', r.status === 0 && !r.stdout.includes(FAKE) && !r.stderr.includes(FAKE) && r.stdout.includes('"t":"event"') && !readFileSync(join(hygRoot, 'golden-hygiene-cli/result.json'), 'utf8').includes(FAKE), r.stderr.trim().split('\n').at(-1));

  // Child processes: an ffmpeg wrapper dumps its environment before running the real one.
  const ffmpegStatic = createRequire(import.meta.url)('ffmpeg-static');
  const probe = join(hygRoot, 'ffmpeg-probe.sh');
  const dump = join(hygRoot, 'ffmpeg-env.txt');
  writeFileSync(probe, `#!/bin/sh\nenv >> "$XWE_TEST_ENV_DUMP"\nexec ${JSON.stringify(ffmpegStatic)} "$@"\n`, { mode: 0o755 });
  r = xwe(['run', 'fixtures/templates/perimeter-visualize.json', '--input', 'video=fixtures/video/drive.mp4', ...MODELS_DIR, '--out', hygRoot, '--run-id', 'golden-hygiene-ffmpeg', '--emit-video'], { ...env, FFMPEG_PATH: probe, XWE_TEST_ENV_DUMP: dump });
  const dumped = existsSync(dump) ? readFileSync(dump, 'utf8') : '';
  const spawns = (dumped.match(/^XWE_TEST_ENV_DUMP=/gm) ?? []).length;
  check('hygiene (cli): every ffmpeg child (decode, mux) inherits PATH but no XORGATE_SECRET_* variable', r.status === 0 && spawns >= 2 && (dumped.match(/^PATH=/gm) ?? []).length === spawns && !dumped.includes('XORGATE_SECRET_') && !dumped.includes(FAKE) && existsSync(join(hygRoot, 'golden-hygiene-ffmpeg/video/viz.mp4')), `${spawns} ffmpeg spawn(s) captured; ${r.stderr.trim().split('\n').at(-1)}`);

  // --secrets files: errors name the file, never its contents.
  const badSecrets = join(hygRoot, 'secrets-bad.json');
  writeFileSync(badSecrets, `{ "here-api-key": "${FAKE}" `);
  r = xwe(['run', 'fixtures/templates/overspeed.json', '--input', 'telemetry=fixtures/telemetry/window.csv', '--out', hygRoot, '--run-id', 'golden-hygiene-badsecrets', '--secrets', badSecrets]);
  check('hygiene (cli): a --secrets file that is not JSON exits 2 naming the file, not its contents, and runs nothing', r.status === 2 && r.stderr.trim() === `xwe: --secrets ${badSecrets}: not valid JSON (expected { "<logical-name>": "<value>" })` && !existsSync(join(hygRoot, 'golden-hygiene-badsecrets')), r.stderr.trim());
  writeFileSync(join(hygRoot, 'secrets-arr.json'), '["x"]');
  r = xwe(['run', 'fixtures/templates/overspeed.json', '--input', 'telemetry=fixtures/telemetry/window.csv', '--out', hygRoot, '--secrets', join(hygRoot, 'secrets-arr.json')]);
  check('hygiene (cli): a --secrets file that is not an object of strings exits 2', r.status === 2 && r.stderr.includes('expected a JSON object of { "<logical-name>": "<value>" }'), r.stderr.trim());
  writeFileSync(join(hygRoot, 'secrets-num.json'), `{ "here-api-key": 5 }`);
  r = xwe(['run', 'fixtures/templates/overspeed.json', '--input', 'telemetry=fixtures/telemetry/window.csv', '--out', hygRoot, '--secrets', join(hygRoot, 'secrets-num.json')]);
  check('hygiene (cli): a non-string secret value exits 2 naming the logical name only', r.status === 2 && r.stderr.includes('the value of "here-api-key" must be a string') && !r.stderr.includes('5 }'), r.stderr.trim());
  r = xwe(['run', 'fixtures/templates/overspeed.json', '--input', 'telemetry=fixtures/telemetry/window.csv', '--out', hygRoot, '--secrets', join(hygRoot, 'secrets-missing.json')]);
  check('hygiene (cli): a missing --secrets file exits 2 with the errno, not a stack', r.status === 2 && r.stderr.trim() === `xwe: --secrets ${join(hygRoot, 'secrets-missing.json')}: cannot read it (ENOENT)`, r.stderr.trim());
  writeFileSync(join(hygRoot, 'secrets-ok.json'), JSON.stringify({ 'here-api-key': FAKE }));
  r = xwe(['run', 'fixtures/templates/overspeed.json', '--input', 'telemetry=fixtures/telemetry/window.csv', '--out', hygRoot, '--run-id', 'golden-hygiene-secretsfile', '--secrets', join(hygRoot, 'secrets-ok.json'), '--log-level', 'debug']);
  check('hygiene (cli): a valid --secrets file runs the graph and its values print nowhere', r.status === 0 && !r.stderr.includes(FAKE) && !readFileSync(join(hygRoot, 'golden-hygiene-secretsfile/result.json'), 'utf8').includes(FAKE), r.stderr.trim().split('\n').at(-1));

  // A registry URL carrying credentials is refused by name; the value is never printed.
  const credEnv = { XWE_MODEL_REGISTRY: 'https://user:tok-SECRET-VALUE@127.0.0.1:9/' };
  r = xwe(['models', 'list'], credEnv);
  check('hygiene (cli): XWE_MODEL_REGISTRY with credentials is refused naming the variable, never the value', r.status === 2 && r.stderr.trim() === 'xwe: XWE_MODEL_REGISTRY must not carry credentials (user:password@host); point it at a registry or mirror that needs none' && !r.stdout.includes('tok-SECRET-VALUE'), r.stderr.trim());
  r = xwe(['doctor'], credEnv);
  check('hygiene (cli): doctor reports a credentialed registry URL as not usable without printing it', r.stdout.includes('  registry          not usable: XWE_MODEL_REGISTRY must not carry credentials') && !r.stdout.includes('tok-SECRET-VALUE'), r.stdout.split('\n').find((l) => l.startsWith('  registry')));
}

// --- HERE trace mode (0.5.1) in default batch mode: no channel overrides ------
// fixtures/templates/overspeed-here-trace.json through createEngine + localHost
// with only httpFetch mocked: the recorded intersection answer over its
// 15-sample trace, then a 30-minute drive (1800 samples, far past the 32-slot
// channel capacity) whose trace node buffers the whole input while the
// comparator reads the same source. Elastic batch channels (the default) let
// it finish; `channelMode: 'bounded'` stalls it, which is the contrast that
// shows the default is doing the work.
{
  const traceRoot = join(outRoot, 'here-trace');
  mkdirSync(traceRoot, { recursive: true });
  const driveCsv = join(traceRoot, 'drive-1800.csv');
  const t0 = 1792269400000;
  writeFileSync(driveCsv, 'ts,gps.lat,gps.lon,gps.speed,gps.heading\n' + Array.from({ length: 1800 }, (_, i) => `${t0 + i * 1000},${(43.65 + i * 0.0002).toFixed(6)},-79.500000,60.0,0.0`).join('\n') + '\n');
  const script = `
    import { readFileSync } from 'node:fs';
    import { createEngine } from ${JSON.stringify(join(root, 'dist/esm/index.js'))};
    import { localHost } from ${JSON.stringify(join(root, 'dist/esm/local/index.js'))};
    const template = JSON.parse(readFileSync(${JSON.stringify(join(root, 'fixtures/templates/overspeed-here-trace.json'))}, 'utf8'));
    const recorded = readFileSync(${JSON.stringify(join(root, 'fixtures/connector/here-routematch-intersection.json'))}, 'utf8');
    // Answers every trace point on one 40 km/h link per chunk.
    let chunk = 0;
    const synthetic = async (url, init) => {
      const [, ...rows] = String(init.body).trim().split('\\n');
      const linkId = '+golden' + chunk++;
      const waypoint = rows.map((r) => ({ linkId, routeLinkSeqNrMatched: 0, timestamp: Date.parse(r.split(',')[2]), confidenceValue: 0.9 }));
      return new Response(JSON.stringify({ response: { route: [{ waypoint, leg: [{ link: [{ linkId, attributes: { SPEED_LIMITS_FCN: [{ FROM_REF_SPEED_LIMIT: '40', TO_REF_SPEED_LIMIT: '40', UNIT: 'K' }] } }] }] }] } }), { status: 200 });
    };
    const runs = {
      intersection: { csv: ${JSON.stringify(join(root, 'fixtures/telemetry/intersection-trace.csv'))}, http: async () => new Response(recorded, { status: 200 }), opts: {} },
      drive: { csv: ${JSON.stringify(driveCsv)}, http: synthetic, opts: {} },
      bounded: { csv: ${JSON.stringify(driveCsv)}, http: synthetic, opts: { channelMode: 'bounded', stallMs: 2000 } },
    };
    const results = {};
    for (const [name, r] of Object.entries(runs)) {
      chunk = 0;
      const local = localHost({ outDir: ${JSON.stringify(traceRoot)}, baseDir: ${JSON.stringify(root)} });
      const host = { bind: async (a) => ({ ...(await local.bind(a)), httpFetch: r.http }) };
      const started = Date.now();
      const run = await createEngine({ host }).run({ template, inputs: { telemetry: r.csv }, runId: 'golden-here-trace-' + name, ...r.opts });
      const step = (id) => run.result.steps.find((s) => s.nodeId === id);
      results[name] = { status: run.result.status, error: run.result.error, roads: step('roads')?.output, cmp: step('cmp')?.output, statuses: run.result.steps.map((s) => s.status), records: run.result.artifacts.outputs.cap?.count ?? 0, events: run.result.events.length, kinds: [...new Set(run.result.events.map((e) => e.kind))], ms: Date.now() - started };
    }
    console.log('RESULT ' + JSON.stringify(results));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', env: { ...process.env, XORGATE_SECRET_HERE_API_KEY: 'hk-golden-trace-0123456789' } });
  let tr = null;
  try { tr = JSON.parse(res.stdout.split('\n').find((l) => l.startsWith('RESULT ')).slice(7)); } catch { /* reported below */ }
  const why = (r) => (r ? JSON.stringify(r) : res.stderr.trim().split('\n').slice(-3).join(' | '));
  console.log(`     (here trace wall time: intersection ${tr?.intersection?.ms} ms, drive ${tr?.drive?.ms} ms, bounded ${tr?.bounded?.ms} ms)`);
  check('here trace (default batch): the intersection template run succeeds, 15 records from 1 request, all 15 points matched, no event', res.status === 0 && tr?.intersection?.status === 'succeeded' && tr.intersection.records === 15 && tr.intersection.events === 0 && /^15 speed-limit record\(s\) via here \(trace\), 1 lookup\(s\), 15\/15 trace point\(s\) matched in 1 chunk\(s\)$/.test(tr.intersection.roads ?? '') && /^true on 0\/15 samples/.test(tr.intersection.cmp ?? ''), why(tr?.intersection));
  check('here trace (default batch): a 1800-sample drive buffers past the channel capacity without a stall, 2 chunk requests, 1800 records, overspeed against the matched 40', tr?.drive?.status === 'succeeded' && tr.drive.statuses.every((s) => s === 'ok') && tr.drive.records === 1800 && /^1800 speed-limit record\(s\) via here \(trace\), 2 lookup\(s\), 1800\/1800 trace point\(s\) matched in 2 chunk\(s\)$/.test(tr.drive.roads ?? '') && /^true on 1800\/1800 samples/.test(tr.drive.cmp ?? '') && tr.drive.events >= 1 && tr.drive.kinds.join() === 'overspeed', why(tr?.drive));
  check("here trace (contrast): the same drive under channelMode 'bounded' fails as a stall", tr?.bounded?.status === 'failed' && /stall/i.test(tr.bounded.error ?? ''), why(tr?.bounded));
}

// --- HERE Routing provider (0.5.2) in default batch mode ----------------------
// fixtures/templates/overspeed-here-routing.json through createEngine +
// localHost with only httpFetch mocked: the REAL Routing v8 answer captured on
// the owner's self-serve account (Royal York Rd, 2026-10-23) over the 30-sample
// drive along it, then the 30-minute drive (1800 samples) answered by a
// synthetic route through each request's waypoints at 40 km/h.
{
  const routeRoot = join(outRoot, 'here-routing');
  mkdirSync(routeRoot, { recursive: true });
  const driveCsv = join(routeRoot, 'drive-1800.csv');
  const t0 = 1792269400000;
  writeFileSync(driveCsv, 'ts,gps.lat,gps.lon,gps.speed,gps.heading\n' + Array.from({ length: 1800 }, (_, i) => `${t0 + i * 1000},${(43.65 + i * 0.0002).toFixed(6)},-79.500000,60.0,0.0`).join('\n') + '\n');
  const script = `
    import { readFileSync } from 'node:fs';
    import { createEngine } from ${JSON.stringify(join(root, 'dist/esm/index.js'))};
    import { localHost } from ${JSON.stringify(join(root, 'dist/esm/local/index.js'))};
    const template = JSON.parse(readFileSync(${JSON.stringify(join(root, 'fixtures/templates/overspeed-here-routing.json'))}, 'utf8'));
    const recorded = readFileSync(${JSON.stringify(join(root, 'fixtures/connector/here-routes-royal-york.json'))}, 'utf8');
    const T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const u = (v) => { let o = ''; while (v >= 32) { o += T[(v % 32) + 32]; v = Math.floor(v / 32); } return o + T[v]; };
    const sg = (v) => u(v < 0 ? -2 * v - 1 : 2 * v);
    const encode = (pts) => { let o = u(1) + u(6), pl = 0, pn = 0; for (const p of pts) { const a = Math.round(p[0] * 1e6), b = Math.round(p[1] * 1e6); o += sg(a - pl) + sg(b - pn); pl = a; pn = b; } return o; };
    const urls = [];
    // A route through the request's waypoints, one 40 km/h span.
    const synthetic = async (url) => {
      urls.push(String(url));
      const q = String(url).split('?')[1].split('&');
      // origin, the vias, destination: the order buildHereRoutingRequest writes them.
      const pts = q.filter((x) => /^(origin|via|destination)=/.test(x)).map((x) => x.split('=')[1].split('!')[0].split(',').map(Number));
      return new Response(JSON.stringify({ routes: [{ sections: [{ polyline: encode(pts), spans: [{ offset: 0, speedLimit: 40 / 3.6, names: [{ value: 'Golden Ave' }], topologySegmentId: '+here:cm:segment:1' }] }] }] }), { status: 200 });
    };
    const runs = {
      royalYork: { csv: ${JSON.stringify(join(root, 'fixtures/telemetry/royal-york-drive.csv'))}, http: async (url) => { urls.push(String(url)); return new Response(recorded, { status: 200 }); }, template },
      // Paced at 100/s instead of the default 5/s so 38 requests take well under a second.
      drive: { csv: ${JSON.stringify(driveCsv)}, http: synthetic, template: { ...template, nodes: template.nodes.map((n) => (n.id === 'roads' ? { ...n, data: { ...n.data, config: { ...n.data.config, maxRequestsPerSecond: 100 } } } : n)) } },
    };
    const results = {};
    for (const [name, r] of Object.entries(runs)) {
      urls.length = 0;
      const local = localHost({ outDir: ${JSON.stringify(routeRoot)}, baseDir: ${JSON.stringify(root)} });
      const host = { bind: async (a) => ({ ...(await local.bind(a)), httpFetch: r.http }) };
      const started = Date.now();
      const run = await createEngine({ host }).run({ template: r.template, inputs: { telemetry: r.csv }, runId: 'golden-here-routing-' + name });
      const step = (id) => run.result.steps.find((s) => s.nodeId === id);
      results[name] = { status: run.result.status, error: run.result.error, roads: step('roads')?.output, statuses: run.result.steps.map((s) => s.status), records: run.result.artifacts.outputs.cap?.count ?? 0, events: run.result.events.length, kinds: [...new Set(run.result.events.map((e) => e.kind))], requests: urls.length, keyInUrl: urls.every((x) => x.endsWith('apikey=hk-golden-routing-0123456789')), ms: Date.now() - started };
    }
    console.log('RESULT ' + JSON.stringify(results));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', env: { ...process.env, XORGATE_SECRET_HERE_API_KEY: 'hk-golden-routing-0123456789' } });
  let tr = null;
  try { tr = JSON.parse(res.stdout.split('\n').find((l) => l.startsWith('RESULT ')).slice(7)); } catch { /* reported below */ }
  const why = (r) => (r ? JSON.stringify(r) : res.stderr.trim().split('\n').slice(-3).join(' | '));
  console.log(`     (here_routing wall time: royal york ${tr?.royalYork?.ms} ms, drive ${tr?.drive?.ms} ms)`);
  check('here_routing (default batch, real Routing v8 answer): Royal York template run succeeds, 1 request with the here-api-key secret, 30 records (21 at 50, 9 null-limit), one overspeed event', res.status === 0 && tr?.royalYork?.status === 'succeeded' && tr.royalYork.requests === 1 && tr.royalYork.keyInUrl && tr.royalYork.records === 30 && tr.royalYork.events === 1 && tr.royalYork.kinds.join() === 'overspeed' && /^21 speed-limit record\(s\) via here_routing \(trace\), 1 lookup\(s\), 9 null record\(s\), 9 without coverage, 30 sample\(s\) matched, 0 unmatched, 9 with a null limit, 1 chunk\(s\)$/.test(tr.royalYork.roads ?? ''), why(tr?.royalYork));
  check('here_routing (default batch): an 1800-sample drive (22 m spacing) takes 38 route requests of <= 50 waypoints, 1800 matched records, overspeed against the routed 40', tr?.drive?.status === 'succeeded' && tr.drive.statuses.every((s) => s === 'ok') && tr.drive.requests === 38 && tr.drive.records === 1800 && /^1800 speed-limit record\(s\) via here_routing \(trace\), 38 lookup\(s\), 1800 sample\(s\) matched, 0 unmatched, 0 with a null limit, 38 chunk\(s\)$/.test(tr.drive.roads ?? '') && tr.drive.events >= 1 && tr.drive.kinds.join() === 'overspeed', why(tr?.drive));
}

// --- --log-level on the CLI and createEngine({ log }) in the library ------------
{
  const args = ['run', 'fixtures/templates/overspeed.json', '--input', 'telemetry=fixtures/telemetry/window.csv', '--out', outRoot];
  const failing = ['run', 'fixtures/templates/overspeed.json', '--input', 'telemetry=missing.csv', '--out', outRoot];
  let r = xwe([...args, '--run-id', 'golden-log-silent', '--log-level', 'silent']);
  check('--log-level silent: a successful run prints nothing on stderr, exits 0, writes result.json', r.status === 0 && r.stderr === '' && r.stdout === '' && existsSync(join(outRoot, 'golden-log-silent/result.json')), r.stderr.trim());
  r = xwe([...failing, '--run-id', 'golden-log-silent-fail', '--log-level=silent']);
  check('--log-level=silent: a failed run prints nothing and still exits 1 with result.json written', r.status === 1 && r.stderr === '' && readJson(join(outRoot, 'golden-log-silent-fail/result.json')).status === 'failed', r.stderr.trim());
  r = xwe([...args, '--run-id', 'golden-log-error', '--log-level', 'error']);
  check('--log-level error: a successful run prints nothing', r.status === 0 && r.stderr === '', r.stderr.trim());
  r = xwe([...failing, '--run-id', 'golden-log-error-fail', '--log-level', 'error']);
  check('--log-level error: a failed run prints only the xwe: failure line', r.status === 1 && r.stderr.trim().split('\n').length === 1 && r.stderr.startsWith('xwe: run failed at node n1: ENOENT'), r.stderr.trim());
  r = xwe([...args, '--run-id', 'golden-log-info']);
  check('the default level (info) prints the run line, the step rows and the event count, and no engine trace', r.status === 0 && /^\[xwe\] succeeded in \d+\.\ds -> /.test(r.stderr) && r.stderr.includes('  ok      n1           150 samples') && r.stderr.trim().endsWith('events: 1') && !r.stderr.includes('[engine]'), r.stderr.trim().split('\n')[0]);
  r = xwe([...args, '--run-id', 'golden-log-debug', '--log-level', 'debug']);
  check('--log-level debug adds the [engine] trace: bindings, graph order, per-node timings, the run total', r.status === 0 && r.stderr.includes('[engine] run golden-log-debug: 4 node(s), bindings n1=telemetry_csv') && r.stderr.includes(`[engine] run golden-log-debug: artifacts -> ${join(outRoot, 'golden-log-debug')}`) && r.stderr.includes('[engine] graph: 4 node(s), 3 edge(s), order n1 -> n2 -> n3 -> n4') && /\[engine\] n3: ok in \d+ ms, 149 message\(s\)/.test(r.stderr) && /\[engine\] run golden-log-debug: succeeded in \d+ ms/.test(r.stderr) && r.stderr.includes('  events: 1'), r.stderr.trim().split('\n').slice(0, 3).join(' | '));
  r = xwe([...args, '--run-id', 'golden-log-ndjson', '--progress', 'json', '--log-level', 'debug']);
  check('--log-level never touches stdout: --progress json stays pure NDJSON at debug', r.status === 0 && r.stdout.trim().split('\n').every((l) => l.startsWith('{"at":') && typeof JSON.parse(l).t === 'string') && r.stderr.includes('[engine] graph:'), r.stdout.split('\n')[0]);
  r = xwe([...args, '--log-level', 'loud']);
  check('an unknown --log-level exits 2 naming the four levels', r.status === 2 && r.stderr.trim() === 'xwe: --log-level must be one of silent, error, info, debug, got "loud"', r.stderr.trim());
  r = xwe(['validate', 'examples/packs/acme-scale/overspeed-scaled.json', '--log-level', 'silent']);
  check('--log-level applies to every command: a silent invalid validate prints nothing and exits 1', r.status === 1 && r.stderr === '' && r.stdout === '', r.stderr.trim());
  r = xwe(['--log-level', 'silent', 'validate', 'fixtures/templates/overspeed.json']);
  check('--log-level may come before the command; validate keeps its stdout report', r.status === 0 && r.stdout.startsWith('OK: 4 nodes, 3 edges'), r.stdout.trim().split('\n')[0]);
  r = xwe(['doctor', '--log-level', 'silent']);
  check('doctor keeps its stdout report under --log-level silent', /^xwe \S+ \(node /.test(r.stdout), r.stdout.split('\n')[0]);

  const lib = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createEngine, XweUsageError, LOG_LEVELS } from ${JSON.stringify(join(root, 'dist/esm/index.js'))};
    import { localHost } from ${JSON.stringify(join(root, 'dist/esm/local/index.js'))};
    const host = localHost({ outDir: ${JSON.stringify(outRoot)}, baseDir: ${JSON.stringify(root)}, log: () => {} });
    const run = (engine, id) => engine.run({ template: 'fixtures/templates/overspeed.json', inputs: { telemetry: 'fixtures/telemetry/window.csv' }, runId: id });
    const seen = [];
    await run(createEngine({ host, log: (m, level) => seen.push(level + ' ' + m) }), 'golden-log-lib-fn');
    await run(createEngine({ host, log: 'debug' }), 'golden-log-lib-debug');
    await run(createEngine({ host, log: 'error' }), 'golden-log-lib-error');
    await run(createEngine({ host }), 'golden-log-lib-default');
    let bad = null; try { createEngine({ host, log: 'loud' }); } catch (e) { bad = e instanceof XweUsageError && e.message; }
    console.log(JSON.stringify({ seen, bad, levels: LOG_LEVELS }));
  `], { cwd: root, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(lib.stdout.trim().split('\n').at(-1)); } catch { /* below */ }
  check('createEngine({ log: fn }) receives every engine message with its level (debug trace included)', lib.status === 0 && Array.isArray(out?.seen) && out.seen.includes('debug graph: 4 node(s), 3 edge(s), order n1 -> n2 -> n3 -> n4') && out.seen.some((l) => /^debug n1: ok in \d+ ms, 150 message\(s\)$/.test(l)) && out.seen.every((l) => /^(debug|info|error) /.test(l)), lib.stderr.trim().split('\n').at(-1) || JSON.stringify(out?.seen?.slice(0, 2)));
  check('createEngine({ log: "debug" }) writes [engine] lines on stderr; "error" and the silent default write nothing', lib.stderr.includes('[engine] run golden-log-lib-debug: 4 node(s), bindings n1=telemetry_csv') && lib.stderr.includes('[engine] graph:') && !lib.stderr.includes('golden-log-lib-error') && !lib.stderr.includes('golden-log-lib-default') && !lib.stderr.includes('golden-log-lib-fn'), lib.stderr.trim().split('\n').slice(0, 2).join(' | '));
  check('createEngine({ log: "loud" }) is a usage error naming the levels; LOG_LEVELS is exported', out?.bad === 'createEngine: log must be a function or one of silent, error, info, debug' && JSON.stringify(out?.levels) === JSON.stringify(['silent', 'error', 'info', 'debug']), String(out?.bad));
}

// --- code function nodes (M7): both runners through the CLI, the library and the progress stream --
// The docs' forklift-summary handler with "car" in place of "forklift" (the
// golden footage is a highway; yolov8n has no forklift class), over the
// perimeter detector, feeding a capture node; the raw detections are captured
// next to it so the expected summaries are computed from the same run.
{
  const fnRoot = join(outRoot, 'functions');
  mkdirSync(fnRoot, { recursive: true });
  const detNodes = readJson(join(root, 'fixtures/templates/perimeter-person-detect.json')).nodes.filter((n) => ['n1', 'n2', 'n3'].includes(n.id));
  const node = (id, type, label, config) => ({ id, type, data: { label, config }, position: { x: 0, y: 0 } });
  const edge = (id, source, target) => ({ id, source, target });
  const summaryJs = readFileSync(join(root, 'examples/functions/forklift-summary.js'), 'utf8').replace('"forklift"', '"car"');
  const summaryPy = readFileSync(join(root, 'examples/functions/forklift-summary.py'), 'utf8').replace('"forklift"', '"car"');
  const fnNode = (type, config, id = 'fn') => node(id, type, 'Function', config);
  const detectionGraph = (fnNodes, extraNodes = [], extraEdges = []) => ({
    schemaVersion: 2,
    nodes: [...detNodes, ...fnNodes, node('cap', 'output.data_capture', 'Summaries', {}), node('raw', 'output.data_capture', 'Raw', {}), ...extraNodes],
    edges: [edge('e1', 'n1', 'n2'), edge('e2', 'n2', 'n3'), edge('e3', 'n3', 'fn'), edge('e4', 'fn', 'cap'), edge('e7', 'n3', 'raw'), ...extraEdges],
  });
  const write = (name, tpl) => { const p = join(fnRoot, name); writeFileSync(p, JSON.stringify(tpl, null, 2)); return p; };
  const runFn = (tpl, id, extra = [], env = {}) => xwe(['run', tpl, '--input', 'video=fixtures/video/drive.mp4', ...MODELS_DIR, '--out', fnRoot, '--run-id', id, ...extra], env);
  const records = (id, nodeId) => readFileSync(join(fnRoot, id, 'outputs', nodeId, 'records.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const stepOf = (result, nodeId) => result.steps.find((s) => s.nodeId === nodeId);
  const width = (b) => b.xyxy[2] - b.xyxy[0];
  const expectedSummaries = (raw) => raw.map((r) => {
    const cars = r.record.boxes.filter((b) => b.cls === 'car');
    if (cars.length === 0) return null;
    const widest = cars.reduce((a, b) => (width(b) > width(a) ? b : a));
    return { ts: r.ts, tag: 'result', record: { frameSeq: r.record.frameSeq, count: cars.length, widestPx: Math.round(width(widest)), confidence: widest.confidence } };
  }).filter(Boolean);
  const EVENT = join(root, 'examples/functions/event.json');
  const summaryRe = /^(\d+) invocation\(s\), (\d+) result\(s\), (\d+) dropped(?:, (\d+) log line\(s\))? \((\$LATEST|v\d+), (javascript|python), ~(\d+) ms\)$/;

  // 1. The JS summary function over the detector, feeding a capture node.
  let r = runFn(write('summary-js.json', detectionGraph([fnNode('function.javascript', { handler: 'handler', timeoutMs: 1000, memoryMb: 128, code: summaryJs, versions: [], deployedVersion: null })])), 'fn-js');
  check('function (js): the car-summary function over the perimeter detector, feeding a capture node, exits 0', r.status === 0, r.stderr.trim().split('\n').at(-1));
  console.log(`     (function js wall time: ${r.seconds.toFixed(1)}s)`);
  const jsResult = readJson(join(fnRoot, 'fn-js/result.json'));
  const raw = records('fn-js', 'raw');
  const expected = expectedSummaries(raw);
  const got = records('fn-js', 'cap');
  check('function (js): the capture holds one summary per frame with a car, tagged result with the event ts, equal to the summaries computed from the raw detections', got.length === expected.length && got.length >= 10 && got.length < 50 && got.every((g, i) => JSON.stringify(g) === JSON.stringify(expected[i])), `${got.length} record(s) vs ${expected.length} expected; first ${JSON.stringify(got[0])}`);
  let m = stepOf(jsResult, 'fn').output.match(summaryRe);
  check('function (js): the step summary is "N invocation(s), M result(s), K dropped ($LATEST, javascript, ~X ms)" with N = 50 frames and M = the captured records', m && m[1] === '50' && Number(m[2]) === got.length && Number(m[2]) + Number(m[3]) === 50 && m[4] === undefined && m[5] === '$LATEST' && m[6] === 'javascript', stepOf(jsResult, 'fn').output);
  check('function (js): all 6 steps ok, the capture step counts the records', jsResult.status === 'succeeded' && jsResult.steps.length === 6 && jsResult.steps.every((s) => s.status === 'ok') && stepOf(jsResult, 'cap').output === `captured ${got.length} record(s)`, stepOf(jsResult, 'cap')?.output);

  // 2. The Python twin: the same records (widestPx may differ by one: Python rounds half to even).
  r = runFn(write('summary-py.json', detectionGraph([fnNode('function.python', { handler: 'handler', timeoutMs: 1000, memoryMb: 128, code: summaryPy, versions: [], deployedVersion: null })])), 'fn-py');
  check('function (python): the same function in Python exits 0', r.status === 0, r.stderr.trim().split('\n').at(-1));
  const pyResult = readJson(join(fnRoot, 'fn-py/result.json'));
  const gotPy = records('fn-py', 'cap');
  const expectedPy = expectedSummaries(records('fn-py', 'raw'));
  // Frame timestamps are anchored to each run's wall clock, so the Python run is compared against its own raw capture.
  check('function (python): the capture holds the summaries computed from that run\'s raw detections (widestPx within 1: Python rounds half to even), the same frames as the JavaScript run', gotPy.length === expectedPy.length && gotPy.length === got.length && gotPy.every((g, i) => g.ts === expectedPy[i].ts && g.tag === 'result' && g.record.frameSeq === expectedPy[i].record.frameSeq && g.record.frameSeq === got[i].record.frameSeq && g.record.count === expectedPy[i].record.count && g.record.confidence === expectedPy[i].record.confidence && Math.abs(g.record.widestPx - expectedPy[i].record.widestPx) <= 1), `${gotPy.length} vs ${expectedPy.length}; first ${JSON.stringify(gotPy[0])}`);
  m = stepOf(pyResult, 'fn').output.match(summaryRe);
  check('function (python): the step summary says python', m && m[1] === '50' && Number(m[2]) === gotPy.length && m[5] === '$LATEST' && m[6] === 'python', stepOf(pyResult, 'fn').output);

  // 3. Chained functions with module state: fn2 keeps a running maximum, logs each new one.
  const runningMax = `// fn2: keep a running maximum across frames and emit only when it grows
let best = 0
async function handler(event, context) {
  if (event.payload.count <= best) return null
  best = event.payload.count
  context.log("new maximum", best, "at frame", event.payload.frameSeq)
  return { frameSeq: event.payload.frameSeq, maxCount: best }
}
`;
  r = runFn(write('chain.json', detectionGraph(
    [fnNode('function.javascript', { code: summaryJs })],
    [fnNode('function.javascript', { code: runningMax }, 'fn2'), node('cap2', 'output.data_capture', 'Maxima', {})],
    [edge('e5', 'fn', 'fn2'), edge('e6', 'fn2', 'cap2')],
  )), 'fn-chain', ['--progress', 'json', '--log-level', 'debug']);
  check('function (chain): two chained functions exit 0', r.status === 0, r.stderr.trim().split('\n').at(-1));
  const chainResult = readJson(join(fnRoot, 'fn-chain/result.json'));
  const maxima = records('fn-chain', 'cap2');
  const counts = got.map((g) => g.record.count);
  const expectedMaxima = counts.reduce((acc, c, i) => { if (c > (acc.at(-1)?.maxCount ?? 0)) acc.push({ frameSeq: got[i].record.frameSeq, maxCount: c }); return acc; }, []);
  check('function (chain): fn2 sees event.tag "result" and fn\'s return value as the payload; module state survives across invocations: the maxima are strictly increasing and match the summaries', maxima.length === expectedMaxima.length && maxima.length >= 2 && maxima.every((x, i) => JSON.stringify(x.record) === JSON.stringify(expectedMaxima[i])), JSON.stringify(maxima.map((x) => x.record)));
  m = stepOf(chainResult, 'fn2').output.match(summaryRe);
  check('function (chain): fn2\'s summary counts its invocations (fn\'s results), its results, the dropped ones and its log lines', m && Number(m[1]) === got.length && Number(m[2]) === maxima.length && Number(m[3]) === got.length - maxima.length && Number(m[4]) === maxima.length, stepOf(chainResult, 'fn2').output);
  const ndjson = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  const logRecords = ndjson.filter((x) => x.t === 'record' && x.nodeId === 'fn2' && x.tag === 'log');
  check('function (chain): each context.log line is a `record` progress message tagged log on the pseudo-port log, payload { line, invocation }, in order', logRecords.length === maxima.length && logRecords.every((x, i) => x.port === 'log' && x.payload.line === `new maximum ${maxima[i].record.maxCount} at frame ${maxima[i].record.frameSeq}` && Number.isInteger(x.payload.invocation) && x.seq === i && x.ts === maxima[i].ts), JSON.stringify(logRecords[0]));
  check('function (chain): fn\'s results tee to the progress stream as records tagged result on port result', ndjson.filter((x) => x.t === 'record' && x.nodeId === 'fn' && x.tag === 'result' && x.port === 'result').length === got.length);
  check('function (chain): --log-level debug shows the runner start and each log line on stderr', /\[engine\] fn: javascript function runner started \(node \d+\.\d+\.\d+, \$LATEST\)/.test(r.stderr) && r.stderr.includes(`[engine] fn2: log: new maximum ${maxima[0].record.maxCount} at frame ${maxima[0].record.frameSeq}`), r.stderr.split('\n').find((l) => l.includes('runner started')));

  // 4. A throwing handler fails the step with the trace and the invocation's log lines; downstream is skipped; result.json is written.
  const boom = 'async function handler(event, context) {\n  context.log("about to fail on frame", event.payload.frameSeq)\n  const forklifts = event.payload.nope.filter((b) => b.cls === "forklift")\n  return forklifts.length\n}';
  r = runFn(write('throws-js.json', detectionGraph([fnNode('function.javascript', { code: boom })])), 'fn-throws-js');
  const throwsJs = readJson(join(fnRoot, 'fn-throws-js/result.json'));
  check('function (throws, js): exit 1 naming the node and the error', r.status === 1 && r.stderr.includes("xwe: run failed at node fn: invocation 1 failed: TypeError: Cannot read properties of undefined (reading 'filter')"), r.stderr.trim().split('\n').at(-1));
  check('function (throws, js): the step output is the error, the trace inside index.js, and the invocation\'s log lines', stepOf(throwsJs, 'fn').status === 'failed' && stepOf(throwsJs, 'fn').output === "invocation 1 failed: TypeError: Cannot read properties of undefined (reading 'filter')\n    at handler (index.js:3:40)\nlogs:\n  about to fail on frame 0", JSON.stringify(stepOf(throwsJs, 'fn').output));
  check('function (throws, js): result.json is written, failed at fn; the capture downstream is skipped, the raw capture on the other branch completes', throwsJs.status === 'failed' && throwsJs.failedNodeId === 'fn' && stepOf(throwsJs, 'cap').status === 'skipped' && stepOf(throwsJs, 'cap').output === 'skipped (upstream failure)' && stepOf(throwsJs, 'raw').status === 'ok' && stepOf(throwsJs, 'raw').output === 'captured 50 record(s)', JSON.stringify(throwsJs.steps.map((s) => `${s.nodeId}:${s.status}`)));
  r = runFn(write('throws-py.json', detectionGraph([fnNode('function.python', { code: 'def handler(event, context):\n    context.log("about to fail on frame", event["payload"]["frameSeq"])\n    return event["payload"]["nope"]["x"]' })])), 'fn-throws-py');
  const throwsPy = readJson(join(fnRoot, 'fn-throws-py/result.json'));
  check('function (throws, python): exit 1; the step output is the exception, the frame inside handler.py, and the log line; result.json written', r.status === 1 && throwsPy.status === 'failed' && throwsPy.failedNodeId === 'fn' && stepOf(throwsPy, 'fn').output === "invocation 1 failed: KeyError: 'nope'\n    at handler (handler.py:3)\nlogs:\n  about to fail on frame 0" && stepOf(throwsPy, 'cap').status === 'skipped', JSON.stringify(stepOf(throwsPy, 'fn')?.output));

  // 5. A timeout kills the process and fails the step within timeoutMs + 500 ms of the event.
  for (const [lang, code] of [['javascript', 'function handler() { while (true) {} }'], ['python', 'def handler(event, context):\n    while True:\n        pass']]) {
    r = runFn(write(`timeout-${lang}.json`, detectionGraph([fnNode(`function.${lang}`, { timeoutMs: 500, code })])), `fn-timeout-${lang}`, ['--progress', 'json', '--log-level', 'debug']);
    const result = readJson(join(fnRoot, `fn-timeout-${lang}/result.json`));
    const msgs = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const firstDetection = msgs.find((x) => x.t === 'record' && x.nodeId === 'n3' && x.seq === 0);
    const fnStep = msgs.find((x) => x.t === 'step' && x.nodeId === 'fn');
    const elapsed = firstDetection && fnStep ? Date.parse(fnStep.at) - Date.parse(firstDetection.at) : NaN;
    check(`function (timeout, ${lang}): exit 1, the step says "invocation 1 timed out after 500 ms (the function process was killed)", result.json written`, r.status === 1 && result.status === 'failed' && result.failedNodeId === 'fn' && stepOf(result, 'fn').output === 'invocation 1 timed out after 500 ms (the function process was killed)' && stepOf(result, 'cap').status === 'skipped', JSON.stringify(stepOf(result, 'fn')?.output));
    // The deadline itself: from the event reaching the runner to the failure (the debug trace carries it).
    // The wall-clock distance from the first detection to the failed step also includes spawning the
    // runner (slow on a bind mount inside a container), so it only gets a loose bound.
    const enforced = Number(r.stderr.match(/\[engine\] fn: invocation 1 failed after (\d+) ms: timed out after 500 ms/)?.[1]);
    check(`function (timeout, ${lang}): the deadline was enforced within timeoutMs + 500 ms of the event (${enforced} ms); the step failed ${elapsed} ms after the first detection`, Number.isFinite(enforced) && enforced <= 1000 && Number.isFinite(elapsed) && elapsed <= 2500, `${enforced} ms enforced, ${elapsed} ms wall clock`);
  }

  // 6. The sandbox: module, file system and network attempts fail as permission errors (through `xwe function test`).
  const testCase = (name, type, code, extra = [], env = {}) => {
    const tpl = write(`${name}.json`, { schemaVersion: 2, nodes: [fnNode(type, { code })], edges: [] });
    return xwe(['function', 'test', tpl, 'fn', '--event', EVENT, ...extra], env);
  };
  const denial = (name, type, code, expectFirstLine) => {
    const res = testCase(name, type, code);
    const lines = res.stdout.split('\n');
    check(`function (sandbox, ${type.split('.')[1]}): ${name} fails as a permission error (exit 1)`, res.status === 1 && lines[0].startsWith(`failed  fn           ${type}  $LATEST  `) && lines[1] === expectFirstLine, lines.slice(0, 3).join(' | ') || res.stderr.trim());
  };
  denial('require-fs', 'function.javascript', 'function handler() { return require("fs").readFileSync("/etc/hosts", "utf8") }', 'error: Error: require("fs") is not available in a code function: no module access, no file system, no network (ERR_ACCESS_DENIED)');
  denial('import-net', 'function.javascript', 'async function handler() { const net = await import("node:net"); return typeof net }', 'error: Error: import() is not available in a code function: no module access (ERR_ACCESS_DENIED)');
  denial('fetch', 'function.javascript', 'async function handler() { return await fetch("http://127.0.0.1:9/") }', 'error: Error: fetch() is not available in a code function: no module access, no file system, no network (ERR_ACCESS_DENIED)');
  denial('eval', 'function.javascript', 'function handler() { return new Function("return process")() }', 'error: EvalError: eval() and the Function constructor are not available in a code function (ERR_ACCESS_DENIED)');
  denial('open', 'function.python', 'def handler(event, context):\n    return open("/etc/hosts").read()', "error: PermissionError: open('/etc/hosts') is not available in a code function: no module access beyond the standard library, no file system, no network (ERR_ACCESS_DENIED)");
  denial('socket', 'function.python', 'def handler(event, context):\n    import socket\n    return str(socket)', 'error: PermissionError: import socket is not available in a code function: no module access beyond the standard library, no file system, no network (ERR_ACCESS_DENIED)');
  denial('subprocess', 'function.python', 'def handler(event, context):\n    import subprocess\n    return subprocess.run(["id"])', 'error: PermissionError: import subprocess is not available in a code function: no module access beyond the standard library, no file system, no network (ERR_ACCESS_DENIED)');
  denial('os', 'function.python', 'def handler(event, context):\n    import os\n    return dict(os.environ)', 'error: PermissionError: import os is not available in a code function: no module access beyond the standard library, no file system, no network (ERR_ACCESS_DENIED)');
  // The standard library that is allowed still works, and print() becomes a log line.
  let res = testCase('stdlib', 'function.python', 'import json, math, statistics, re, datetime\ndef handler(event, context):\n    print("widths", [b["xyxy"][2] - b["xyxy"][0] for b in event["payload"]["boxes"]])\n    return {"mean": statistics.mean([b["confidence"] for b in event["payload"]["boxes"]]), "sqrt": math.sqrt(16), "iso": datetime.datetime.fromtimestamp(event["ts"] / 1000, datetime.timezone.utc).isoformat()}');
  check('function (sandbox, python): json, math, statistics, re and datetime import; print() is a log line', res.status === 0 && res.stdout === 'ok      fn           function.python  $LATEST  0 ms\nresult: {"mean":0.79,"sqrt":4,"iso":"2026-08-12T23:56:31.867000+00:00"}\nlogs:\n  widths [212, 120]\n'.replace('  0 ms', `  ${res.stdout.match(/\$LATEST  (\d+) ms/)?.[1] ?? '?'} ms`), res.stdout || res.stderr);

  // 7. XORGATE_SECRET_* is invisible inside the handler: no `process` at all in JavaScript;
  // the Python interpreter is spawned with an allowlisted environment (proven with a
  // python3 wrapper on PATH that records what it was given).
  const SECRET_ENV = { XORGATE_SECRET_HERE_API_KEY: 'hk-function-LEAK-0123456789', XORGATE_SECRET_X: 'x-LEAK-0123456789' };
  res = testCase('no-process', 'function.javascript', 'function handler(event, context) { return { process: typeof process, env: typeof globalThis.process, keys: Object.getOwnPropertyNames(globalThis).sort() } }', [], SECRET_ENV);
  const noProcess = JSON.parse(res.stdout.split('\n')[1]?.replace(/^result: /, '') ?? 'null');
  check('function (secrets, js): the handler has no `process` and no environment; its globals are the language built-ins plus timers, console, require/fetch stubs', res.status === 0 && noProcess?.process === 'undefined' && noProcess.env === 'undefined' && !noProcess.keys.includes('process') && !noProcess.keys.includes('Buffer') && ['JSON', 'Math', 'Promise', 'setTimeout', 'console', 'require', 'fetch', 'structuredClone'].every((k) => noProcess.keys.includes(k)) && !res.stdout.includes('LEAK'), JSON.stringify(noProcess?.keys?.filter((k) => /^[a-z]/.test(k))));
  const binDir = join(fnRoot, 'bin');
  mkdirSync(binDir, { recursive: true });
  const realPython = spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout.trim();
  const envDump = join(fnRoot, 'python-env.json');
  writeFileSync(join(binDir, 'python3'), `#!/bin/sh\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.env))' ${JSON.stringify(envDump)}\nexec ${JSON.stringify(realPython)} "$@"\n`, { mode: 0o755 });
  res = testCase('python-env', 'function.python', 'def handler(event, context):\n    return {"ok": True, "version": context.functionVersion, "node": context.nodeId, "remaining": context.remainingTimeMs() > 0}', [], { ...SECRET_ENV, XWE_GOLDEN_PARENT_ONLY: 'parent-only-0123456789', PATH: `${binDir}:${process.env.PATH}` });
  const seenEnv = existsSync(envDump) ? JSON.parse(readFileSync(envDump, 'utf8')) : null;
  // The wrapper's shell adds its own variables (PWD, SHLVL, _, and macOS's __CF_USER_TEXT_ENCODING); everything else must be the allowlist.
  const SHELL_ADDED = ['_', 'PWD', 'SHLVL', 'OLDPWD', '__CF_USER_TEXT_ENCODING'];
  check('function (secrets, python): python3 comes from PATH and is spawned with the allowlisted environment: PATH present, no XORGATE_SECRET_*, none of the parent\'s other variables', res.status === 0 && res.stdout.includes('result: {"ok":true,"version":"$LATEST","node":"fn","remaining":true}') && seenEnv !== null && typeof seenEnv.PATH === 'string' && !Object.keys(seenEnv).some((k) => k.startsWith('XORGATE_SECRET_')) && seenEnv.XWE_GOLDEN_PARENT_ONLY === undefined && !JSON.stringify(seenEnv).includes('LEAK') && !JSON.stringify(seenEnv).includes('parent-only') && Object.keys(seenEnv).every((k) => ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'PATHEXT', 'COMSPEC', ...SHELL_ADDED].includes(k)), `${res.stdout.split('\n')[1]} env keys: ${seenEnv ? Object.keys(seenEnv).join(',') : 'no dump'}`);
  // A missing python3 fails the step naming it; result.json is still written.
  r = runFn(write('nopython.json', detectionGraph([fnNode('function.python', { code: summaryPy })])), 'fn-nopython', [], { PATH: join(fnRoot, 'empty-bin') });
  const noPython = readJson(join(fnRoot, 'fn-nopython/result.json'));
  check('function (python): without python3 on PATH the step fails naming it (exit 1, result.json written)', r.status === 1 && noPython.failedNodeId === 'fn' && stepOf(noPython, 'fn').output === 'python3 was not found on PATH; function.python nodes need it (xwe doctor reports it)', stepOf(noPython, 'fn')?.output);

  // 8. Code that does not load fails the step at the first event (result.json written); `function test` reports it with exit 1.
  r = runFn(write('syntax.json', detectionGraph([fnNode('function.javascript', { code: 'function handler( {' })])), 'fn-syntax');
  const syntax = readJson(join(fnRoot, 'fn-syntax/result.json'));
  check('function (load failure): a syntax error fails the step naming the line, result.json written', r.status === 1 && syntax.failedNodeId === 'fn' && stepOf(syntax, 'fn').output === "SyntaxError: Unexpected end of input (index.js:1)", JSON.stringify(stepOf(syntax, 'fn')?.output));
  res = testCase('no-handler', 'function.javascript', 'const x = 1');
  check('function test: code without the handler exits 1 saying what to define', res.status === 1 && res.stdout.split('\n')[1] === 'error: Error: handler "handler" is not a function in the code (define `async function handler(event, context)`)', res.stdout.split('\n')[1]);
  res = testCase('py-syntax', 'function.python', 'def handler(:\n    pass');
  check('function test (python): a syntax error exits 1 naming the line', res.status === 1 && res.stdout.split('\n')[1] === 'error: SyntaxError: invalid syntax (handler.py:1)', res.stdout.split('\n')[1]);

  // 9. `xwe function test` on the docs' example, both languages; the usage errors exit 2.
  for (const [tpl, lang] of [['examples/functions/forklift-summary.json', 'javascript'], ['examples/functions/forklift-summary-python.json', 'python']]) {
    res = xwe(['function', 'test', tpl, 'fn', '--event', 'examples/functions/event.json']);
    check(`function test (${lang}): the docs' forklift-summary example prints the report and exits 0`, res.status === 0 && new RegExp(`^ok      fn           function\\.${lang}  \\$LATEST  \\d+ ms\\nresult: \\{"frameSeq":3,"count":1,"widestPx":212,"confidence":0\\.81\\}\\nlogs: none\\n$`).test(res.stdout) && res.stderr === '', JSON.stringify(res.stdout));
  }
  res = xwe(['function', 'test', 'examples/functions/forklift-summary.json', 'fn', '--event', 'examples/functions/event.json', '--log-level', 'silent']);
  check('function test keeps its stdout report under --log-level silent', res.status === 0 && res.stdout.startsWith('ok      fn'), res.stdout.split('\n')[0]);
  res = xwe(['function', 'test', 'examples/functions/forklift-summary.json', 'nope', '--event', 'examples/functions/event.json']);
  check('function test: an unknown node id exits 2 listing the nodes', res.status === 2 && res.stderr.trim() === 'xwe: node "nope" is not in the template (nodes: src, dec, det, fn, cap)' && res.stdout === '', res.stderr.trim());
  res = xwe(['function', 'test', 'examples/functions/forklift-summary.json', 'det', '--event', 'examples/functions/event.json']);
  check('function test: a node that is not a function exits 2', res.status === 2 && res.stderr.trim() === 'xwe: node "det" is a model.object_detection, not a function node (function.javascript | function.python)', res.stderr.trim());
  res = xwe(['function', 'test', 'examples/functions/forklift-summary.json', 'fn', '--event', join(fnRoot, 'missing.json')]);
  check('function test: a missing event file exits 2', res.status === 2 && res.stderr.startsWith(`xwe: event ${join(fnRoot, 'missing.json')}: ENOENT`), res.stderr.trim());
  res = xwe(['function', 'test', 'examples/functions/forklift-summary.json', 'fn', '--event', 'examples/functions/event.json', '--version', '2']);
  check('function test: --version of an unpublished snapshot exits 2', res.status === 2 && res.stderr.trim() === "xwe: version 2 is not in the node's versions (none published)", res.stderr.trim());
  res = xwe(['function', 'test', 'examples/functions/forklift-summary.json', 'fn']);
  check('function test without --event exits 2', res.status === 2 && res.stderr.trim() === 'xwe: function test needs --event <file>', res.stderr.trim());
  writeFileSync(join(fnRoot, 'bad-event.json'), '{"tag":"x"}');
  res = xwe(['function', 'test', 'examples/functions/forklift-summary.json', 'fn', '--event', join(fnRoot, 'bad-event.json')]);
  check('function test: an event without a payload exits 2', res.status === 2 && res.stderr.trim() === 'xwe: event needs a "payload" (the record the handler receives)', res.stderr.trim());

  // 10. Versions: deployedVersion runs the snapshot (the summary says vN); --version picks one; the working copy is $LATEST.
  const versioned = {
    code: 'function handler(event, context) { return { v: context.functionVersion, from: "latest" } }',
    versions: [
      { version: 2, code: 'function handler(event, context) { return { v: context.functionVersion, from: "v2" } }', handler: 'handler', publishedAt: '2026-09-05T00:00:00Z' },
      { version: 1, code: 'function run(event, context) { return { v: context.functionVersion, from: "v1" } }', handler: 'run', publishedAt: '2026-09-04T00:00:00Z', description: 'first' },
    ],
    deployedVersion: 2,
  };
  const versionedTpl = write('versioned.json', { schemaVersion: 2, nodes: [fnNode('function.javascript', versioned)], edges: [] });
  res = xwe(['function', 'test', versionedTpl, 'fn', '--event', EVENT]);
  check('function test: deployedVersion 2 runs the snapshot: the report says v2 and context.functionVersion is 2', res.status === 0 && /^ok      fn           function\.javascript  v2  \d+ ms\nresult: \{"v":2,"from":"v2"\}\nlogs: none\n$/.test(res.stdout), JSON.stringify(res.stdout));
  res = xwe(['function', 'test', versionedTpl, 'fn', '--event', EVENT, '--version', '1']);
  check('function test: --version 1 runs that snapshot with its own handler name', res.status === 0 && res.stdout.includes('  v1  ') && res.stdout.includes('result: {"v":1,"from":"v1"}'), JSON.stringify(res.stdout));
  const latestTpl = write('versioned-latest.json', { schemaVersion: 2, nodes: [fnNode('function.javascript', { ...versioned, deployedVersion: 3 })], edges: [] });
  res = xwe(['function', 'test', latestTpl, 'fn', '--event', EVENT]);
  check('function test: a deployedVersion that is not published falls back to the working copy ($LATEST)', res.status === 0 && res.stdout.includes('  $LATEST  ') && res.stdout.includes('result: {"v":"$LATEST","from":"latest"}'), JSON.stringify(res.stdout));
  r = runFn(write('versioned-run.json', detectionGraph([fnNode('function.javascript', versioned)])), 'fn-versioned');
  const versionedResult = readJson(join(fnRoot, 'fn-versioned/result.json'));
  check('function (run): a template exported with deployedVersion 2 runs version 2 under xwe: the step summary says v2 and every record carries v: 2', r.status === 0 && /^50 invocation\(s\), 50 result\(s\), 0 dropped \(v2, javascript, ~\d+ ms\)$/.test(stepOf(versionedResult, 'fn').output) && records('fn-versioned', 'cap').every((x) => x.record.v === 2 && x.record.from === 'v2'), stepOf(versionedResult, 'fn')?.output);

  // 11. The library: engine.testFunction in ESM and CJS, and a run reading function log records through engine.run({ progress }).
  const LIB = (imports) => `
    ${imports}
    const template = JSON.parse(readFileSync(${JSON.stringify(join(root, 'examples/functions/forklift-summary.json'))}, 'utf8'));
    const engine = createEngine({ host: localHost({ modelDirs: ['fixtures/models'], outDir: ${JSON.stringify(fnRoot)}, baseDir: ${JSON.stringify(root)}, log: () => {} }) });
    const event = JSON.parse(readFileSync(${JSON.stringify(EVENT)}, 'utf8'));
    const test = await engine.testFunction({ template, nodeId: 'fn', event });
    const dropped = await engine.testFunction({ template, nodeId: 'fn', event: { ...event, payload: { ...event.payload, boxes: [] } } });
    const pyTemplate = JSON.parse(readFileSync(${JSON.stringify(join(root, 'examples/functions/forklift-summary-python.json'))}, 'utf8'));
    const py = await engine.testFunction({ template: pyTemplate, nodeId: 'fn', event: ${JSON.stringify(EVENT)} });
    const boom = await engine.testFunction({ template: { ...template, nodes: template.nodes.map((n) => n.id === 'fn' ? { ...n, data: { ...n.data, config: { ...n.data.config, code: 'async function handler(event, context) {\\n  context.log("frame", event.payload.frameSeq)\\n  return event.payload.nope.filter(Boolean)\\n}' } } } : n) }, nodeId: 'fn', event });
    let usage = null; try { await engine.testFunction({ template, nodeId: 'det', event }); } catch (e) { usage = { name: e.name, exitCode: e.exitCode, message: e.message }; }
    const logs = [];
    const run = await engine.run({ template: JSON.parse(readFileSync(${JSON.stringify(join(fnRoot, 'chain.json'))}, 'utf8')), inputs: { video: 'fixtures/video/drive.mp4' }, runId: 'fn-lib-' + FMT, progress: (m) => { if (m.t === 'record' && m.tag === 'log') logs.push('[' + m.nodeId + '] ' + m.payload.line); } });
    console.log(JSON.stringify({ test, dropped: { ok: dropped.ok, result: dropped.result }, py: { ok: py.ok, result: py.result, language: py.language, runtime: py.runtime }, boom: { ok: boom.ok, error: boom.error, logs: boom.logs }, usage, run: { status: run.result.status, captures: run.outcome.captures.cap.length, maxima: run.outcome.captures.cap2.length, fn2: run.result.steps.find((s) => s.nodeId === 'fn2').output }, logs }));
  `;
  for (const [fmt, argv, imports] of [
    ['esm', ['--input-type=module', '-e'], `const FMT = 'esm';
     import { readFileSync } from 'node:fs';
     import { createEngine } from ${JSON.stringify(join(root, 'dist/esm/index.js'))};
     import { localHost } from ${JSON.stringify(join(root, 'dist/esm/local/index.js'))};`],
    ['cjs', ['-e'], `const FMT = 'cjs';
     const { readFileSync } = require('node:fs');
     const { createEngine } = require(${JSON.stringify(join(root, 'dist/cjs/index.js'))});
     const { localHost } = require(${JSON.stringify(join(root, 'dist/cjs/local/index.js'))});
     (async () => {`],
  ]) {
    const body = fmt === 'cjs' ? `${LIB(imports)}\n})().catch((e) => { console.error(e); process.exit(9); });` : LIB(imports);
    const lib = spawnSync(process.execPath, [...argv, body], { cwd: root, encoding: 'utf8', env: { ...process.env, XWE_MODELS_DIR: join(outRoot, 'empty-cache') } });
    let out = null;
    try { out = JSON.parse(lib.stdout.trim().split('\n').at(-1)); } catch { /* reported below */ }
    check(`functions (${fmt}) library script runs`, lib.status === 0 && out !== null, lib.stderr.trim().split('\n').slice(-3).join(' | '));
    check(`functions (${fmt}): engine.testFunction resolves { ok, result, logs, durationMs, functionVersion } for the docs' event`, out?.test?.ok === true && JSON.stringify(out.test.result) === '{"frameSeq":3,"count":1,"widestPx":212,"confidence":0.81}' && Array.isArray(out.test.logs) && out.test.logs.length === 0 && typeof out.test.durationMs === 'number' && out.test.functionVersion === '$LATEST' && out.test.type === 'function.javascript' && out.test.language === 'javascript' && /^node \d+/.test(out.test.runtime) && out.test.error === undefined, JSON.stringify(out?.test));
    check(`functions (${fmt}): a dropped event resolves ok with result null; the Python twin resolves the same result under python`, out?.dropped?.ok === true && out.dropped.result === null && out?.py?.ok === true && JSON.stringify(out.py.result) === '{"frameSeq":3,"count":1,"widestPx":212,"confidence":0.81}' && out.py.language === 'python' && /^python 3\./.test(out.py.runtime), JSON.stringify([out?.dropped, out?.py]));
    check(`functions (${fmt}): a throwing handler resolves ok false with the error, the trace and the logs; a non-function node rejects with XweUsageError (exit code 2)`, out?.boom?.ok === false && out.boom.error === "TypeError: Cannot read properties of undefined (reading 'filter')\n    at handler (index.js:3:29)" && JSON.stringify(out.boom.logs) === '["frame 3"]' && out?.usage?.name === 'XweUsageError' && out.usage.exitCode === 2 && out.usage.message.includes('not a function node'), JSON.stringify([out?.boom, out?.usage]));
    check(`functions (${fmt}): engine.run over the chained graph succeeds and hands function log lines to progress as record messages tagged log`, out?.run?.status === 'succeeded' && out.run.captures === got.length && out.run.maxima === maxima.length && out.logs.length === maxima.length && out.logs[0] === `[fn2] new maximum ${maxima[0].record.maxCount} at frame ${maxima[0].record.frameSeq}`, JSON.stringify(out?.run));
  }

  // 12. doctor reports python3.
  res = xwe(['doctor']);
  check('doctor reports python3 with its path and version', res.stdout.split('\n').some((l) => /^  python3 {11}\S+python3 \(3\.\d+\.\d+\)$/.test(l)), res.stdout.split('\n').find((l) => l.startsWith('  python3')));
  res = xwe(['doctor'], { PATH: join(fnRoot, 'empty-bin') });
  check('doctor without python3 on PATH says so and does not fail the check', res.stdout.includes('  python3           not found on PATH; function.python nodes will fail (install python3)'), res.stdout.split('\n').find((l) => l.startsWith('  python3')));
}

// --- webhooks (0.5.0): output.event's `webhook` name, bound locally ----------
// A loopback listener (127.0.0.1, never a public receiver) stands in for the
// endpoint. The CLI runs async here: spawnSync would block the listener.
{
  const whRoot = join(outRoot, 'webhooks');
  mkdirSync(whRoot, { recursive: true });
  const TPL = 'fixtures/templates/overspeed-webhook.json';
  const SECRET = 'whsec_' + Buffer.from('golden-webhook-key-0123456789abcdef').toString('base64');
  const received = [];
  let status = 204;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { received.push({ headers: req.headers, body }); res.writeHead(status).end(); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/hook`;
  const xweAsync = (args, env = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, 'dist/cjs/cli/index.js'), ...args], { cwd: root, env: { ...process.env, XWE_MODELS_DIR: join(outRoot, 'empty-cache'), ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
  const verify = (h, body, secret) => {
    const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
    const expected = createHmac('sha256', key).update(`${h['webhook-id']}.${h['webhook-timestamp']}.${body}`).digest('base64');
    return (h['webhook-signature'] ?? '').split(' ').includes(`v1,${expected}`);
  };
  const baseRun = ['run', TPL, '--input', 'telemetry=fixtures/telemetry/window.csv', '--out', whRoot];

  let r = xwe(['validate', TPL]);
  check('webhooks: validate lists both names unbound, exit 0', r.status === 0 && /^ {2}dispatch {3}unbound .*node n4$/m.test(r.stdout) && /^ {2}audit {6}unbound .*node n5$/m.test(r.stdout), r.stdout.trim().split('\n').slice(-3).join(' | '));
  r = xwe(['validate', TPL, '--webhook', 'dispatch=https://hooks.example.test/x'], { XWE_WEBHOOK_AUDIT: 'https://audit.example.test/y' });
  check('webhooks: validate shows a flag binding and an env binding with their origins', r.status === 0 && r.stdout.includes('dispatch   bound -> https://hooks.example.test (unsigned, flag/file)') && r.stdout.includes('audit      bound -> https://audit.example.test (unsigned, XWE_WEBHOOK_AUDIT)'), r.stdout.trim().split('\n').slice(-2).join(' | '));
  r = xwe(['validate', 'fixtures/templates/overspeed.json']);
  check('webhooks: a template without webhook names says "webhooks: none"', r.status === 0 && r.stdout.includes('webhooks: none'));

  r = await xweAsync([...baseRun, '--run-id', 'golden-webhook', '--webhook', `dispatch=${url}`, '--webhook-secret', `dispatch=${SECRET}`, '--allow-insecure-webhooks', '--progress', 'json', '--log-level', 'debug']);
  const posted = received.map((x) => ({ ...x, json: JSON.parse(x.body) }));
  check('webhooks: the run succeeds and POSTs exactly one event (n4 is bound, n5 is not)', r.status === 0 && posted.length === 1, `${posted.length} POST(s); ${r.stderr.trim().split('\n').at(-1)}`);
  const p0 = posted[0];
  check('webhooks: the POST carries Standard Webhooks headers whose v1 signature verifies with the secret', p0 && verify(p0.headers, p0.body, SECRET) && p0.headers['webhook-id'] === p0.json.id && /^\d{10}$/.test(p0.headers['webhook-timestamp']) && p0.headers['x-xorgate-event'] === 'workflow.event' && p0.headers['content-type'] === 'application/json', JSON.stringify(p0?.headers));
  check('webhooks: the body is the platform envelope with data.nodeId n4 and run.trigger local', p0?.json.type === 'workflow.event' && p0.json.apiVersion === '2026-09-27' && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(p0.json.id) && p0.json.organizationId === null && p0.json.data.nodeId === 'n4' && p0.json.data.kind === 'overspeed' && p0.json.data.occurredAt === '2026-08-12T23:56:01.289Z' && p0.json.data.run.id === 'golden-webhook' && p0.json.data.run.trigger === 'local', p0?.body);
  check('webhooks: the unbound name warns once on stderr', (r.stderr.match(/webhook "audit" \(node n5\) is not bound/g) ?? []).length === 1, r.stderr.trim().split('\n').slice(0, 3).join(' | '));
  const runDir = join(whRoot, 'golden-webhook');
  const evLines = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const res = readJson(join(runDir, 'result.json'));
  check('webhooks: events.jsonl, result.json and NDJSON event messages carry nodeId', evLines.map((e) => e.nodeId).join(',') === 'n4,n5' && res.events.map((e) => e.nodeId).join(',') === 'n4,n5' && r.stdout.split('\n').filter((l) => l.includes('"t":"event"')).every((l) => /"nodeId":"n[45]"/.test(l)), evLines.map((e) => e.nodeId).join(','));
  const { engineResultSchema } = createRequire(import.meta.url)(join(root, 'dist/cjs/index.js'));
  const legacy = { ...res, events: res.events.map(({ nodeId: _n, ...e }) => e) };
  check('webhooks: a 0.4.0-shaped result.json (events without nodeId) still parses', engineResultSchema.safeParse(legacy).success && engineResultSchema.safeParse(res).success);
  const artifacts = readdirSync(runDir).map((f) => join(runDir, f)).filter((f) => statSync(f).isFile());
  const b64 = SECRET.slice('whsec_'.length);
  check('webhooks: the signing secret appears in no stdout, stderr or artifact', ![r.stdout, r.stderr, ...artifacts.map((f) => readFileSync(f, 'utf8'))].some((t) => t.includes(SECRET) || t.includes(b64)), `${artifacts.length} artifact(s) scanned`);

  received.length = 0;
  writeFileSync(join(whRoot, 'hooks.json'), JSON.stringify({ dispatch: { url: 'http://127.0.0.1:9/file-loses' , secret: SECRET }, audit: { url } }));
  r = await xweAsync([...baseRun, '--run-id', 'golden-webhook-file', '--webhooks', join(whRoot, 'hooks.json'), '--webhook', `dispatch=${url}`, '--allow-insecure-webhooks'], { XWE_WEBHOOK_DISPATCH: 'http://127.0.0.1:9/env-loses' });
  check('webhooks: --webhook beats --webhooks beats env; the file binds audit and signs dispatch', r.status === 0 && received.length === 2 && received.every((x) => x.headers['webhook-signature'] ? verify(x.headers, x.body, SECRET) : JSON.parse(x.body).data.nodeId === 'n5') && received.map((x) => JSON.parse(x.body).data.nodeId).sort().join(',') === 'n4,n5', `${received.length} POST(s); ${r.stderr.trim().split('\n').at(-1)}`);

  received.length = 0;
  status = 500;
  r = await xweAsync([...baseRun, '--run-id', 'golden-webhook-500', '--allow-insecure-webhooks'], { XWE_WEBHOOK_DISPATCH: url, XWE_WEBHOOK_SECRET_DISPATCH: SECRET });
  check('webhooks: env binds and signs; a 500 is logged, not retried, and the run still succeeds', r.status === 0 && received.length === 1 && verify(received[0].headers, received[0].body, SECRET) && r.stderr.includes('HTTP 500') && r.stderr.includes('does not retry'), r.stderr.trim().split('\n').find((l) => l.includes('dispatch')));
  status = 204;

  r = await xweAsync([...baseRun, '--run-id', 'golden-webhook-http', '--webhook', `dispatch=${url}`]);
  check('webhooks: an http URL without --allow-insecure-webhooks exits 2 and runs nothing', r.status === 2 && r.stderr.includes('webhook "dispatch": the URL must be https:') && !existsSync(join(whRoot, 'golden-webhook-http')), r.stderr.trim());
  r = await xweAsync([...baseRun, '--run-id', 'golden-webhook-userinfo', '--webhook', 'dispatch=https://u:p@hooks.example.test/']);
  check('webhooks: a URL with user-info exits 2 without echoing it', r.status === 2 && r.stderr.includes('must not carry user-info') && !r.stderr.includes('u:p@'), r.stderr.trim());
  r = await xweAsync([...baseRun, '--run-id', 'golden-webhook-badsecret', '--webhook', `dispatch=${url}`, '--allow-insecure-webhooks', '--webhook-secret', 'dispatch=not-a-whsec-LEAKME']);
  check('webhooks: a secret that is not whsec_<base64> exits 2 naming the webhook, never the value', r.status === 2 && r.stderr.includes('webhook "dispatch": the secret must be a Standard Webhooks secret') && !r.stderr.includes('LEAKME'), r.stderr.trim());
  server.close();
}

if (!failed) rmSync(outRoot, { recursive: true, force: true });
else console.error(`artifacts kept for inspection: ${outRoot}`);
process.exit(failed ? 1 : 0);
