#!/usr/bin/env node
// The repo's regression gate: the overspeed and perimeter golden runs over
// the fixtures, driven through the real CLI, plus the library surface
// (createEngine + localHost in ESM and CJS), the local `path` alias and
// `xwe doctor`. Run `npm run build` first (`npm test` does).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  check('doctor catalog line carries the frozen core hash', lines.some((l) => l === '  catalog           26 nodes, core e481243f5ffe4678, no packs'));
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
    check(`packs (${fmt}): the core payload is unchanged: e481243f5ffe4678, 26 nodes, one core pack entry with that hash`,
      out?.coreVersion === 'e481243f5ffe4678' && out?.coreNodes === 26 && JSON.stringify(out?.corePacks) === JSON.stringify([{ name: 'core', version: pkgVersion, hash: 'e481243f5ffe4678' }]), JSON.stringify(out?.corePacks));
    check(`packs (${fmt}): corePacks are the seven core namespaces in registry order`,
      JSON.stringify(out?.corePackNames) === JSON.stringify(['core/source', 'core/connector', 'core/video', 'core/telemetry', 'core/model', 'core/logic', 'core/output']), String(out?.corePackNames));
    check(`packs (${fmt}): with the pack, packs[] has two entries, the core hash is unchanged and catalogVersion differs`,
      out?.packs?.length === 2 && out.packs[0].name === 'core' && out.packs[0].hash === 'e481243f5ffe4678' && out.packs[1].name === '@acme/xwe-nodes-scale' && out.packs[1].version === '1.0.0' && /^[0-9a-f]{16}$/.test(out.packs[1].hash) && out.version !== 'e481243f5ffe4678' && out.nodes === 27 && out.cached === true,
      `${JSON.stringify(out?.packs)} catalogVersion=${out?.version}`);
    check(`packs (${fmt}): validateDefinition reports the unknown type against core and passes against the pack catalog; inspectTemplate takes the catalog`,
      out?.validateCore?.includes('UNKNOWN_NODE_TYPE') && out?.validatePack === true && out?.inspectKey === 'telemetry', JSON.stringify([out?.validateCore, out?.validatePack, out?.inspectKey]));
    check(`packs (${fmt}): createEngine({ packs }) runs the scaled graph to 0 events; engine.catalog carries 8 packs`,
      out?.run?.status === 'succeeded' && out.run.events === 0 && out.run.scale === 'scaled 150 samples (speed_kph × 0.05)' && /^true on 0\/149/.test(out.run.gate ?? '') && out?.enginePacks === 8, JSON.stringify(out?.run));
    check(`packs (${fmt}): createEngine({ catalog }) runs it too`, out?.viaCatalog === 'succeeded', out?.viaCatalog);
    check(`packs (${fmt}): catalog and packs together is a usage error; a core namespace, a duplicate type and an untagged json output throw naming the node`,
      out?.errors?.both === 'createEngine takes a catalog or packs, not both' && out?.errors?.namespace?.includes('node type "model.scale" uses the core namespace "model"') && out?.errors?.duplicate?.includes('Duplicate catalog node type "acme.scale" (in pack "@acme/xwe-nodes-scale" and pack "y")') && out?.errors?.tag === 'json output "o" on "acme.untagged" must declare a tag', JSON.stringify(out?.errors));
    check(`packs (${fmt}): core minus core/model composes 22 nodes with a different core hash and no detection node`,
      out?.minusModel?.nodes === 22 && out.minusModel.hasDetection === false && out.minusModel.packs?.length === 1 && out.minusModel.packs[0].name === 'core' && out.minusModel.packs[0].hash !== 'e481243f5ffe4678', JSON.stringify(out?.minusModel));
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

if (!failed) rmSync(outRoot, { recursive: true, force: true });
else console.error(`artifacts kept for inspection: ${outRoot}`);
process.exit(failed ? 1 : 0);
