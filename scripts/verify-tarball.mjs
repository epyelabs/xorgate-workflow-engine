#!/usr/bin/env node
/**
 * The honest packaging check: test what would be PUBLISHED, not the source
 * tree. `npm pack` into a temp dir, assert the file list, then install the
 * tarball into two fresh projects (a default install and `--omit=optional`)
 * and run the overspeed golden through `npx xwe`, through `import` (ESM) and
 * through `require` (CJS). Prints the three sizes the docs quote.
 *
 *   npm run verify:tarball
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'xwe-pack-'));
let failures = 0;

const fail = (m) => { console.error(`FAIL  ${m}`); failures++; };
const pass = (m) => console.log(`ok    ${m}`);
const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const kb = (bytes) => `${(bytes / 1024).toFixed(0)} kB`;

function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += dirSize(full);
    else total += statSync(full).size;
  }
  return total;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const CLOUD_RE = /node_modules[\\/](@aws-sdk|aws-sdk|aws-lambda|@google-cloud|@azure)[\\/]/;
const PINNED_EVENT_AT = '2026-08-12T23:56:01.289Z';

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.error) throw res.error;
  return res;
}

function installProject(name, tarball, extraArgs) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, private: true, type: 'module' }, null, 2));
  const res = run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', ...extraArgs, tarball], { cwd: dir });
  if (res.status !== 0) throw new Error(`npm install in ${name} failed:\n${res.stderr}`);
  return dir;
}

const LIB_SCRIPT = (imports, tail) => `${imports}
const engine = createEngine({ host: localHost({ outDir: 'out' }) });
const ok = await engine.run({ template: 'overspeed.json', inputs: { telemetry: 'window.csv' }, runId: 'lib' });
const failed = await engine.run({ template: 'overspeed.json', inputs: { telemetry: 'missing.csv' }, runId: 'lib-fail' });
let usage = null;
try { await engine.run({ template: 'overspeed.json', inputs: {} }); } catch (e) { usage = { isUsage: e instanceof XweUsageError, exitCode: e.exitCode }; }
let stub = '';
try { await runConformance({}); } catch (e) { stub = e.message; }
console.log(JSON.stringify({ status: ok.result.status, events: ok.result.events.length, at: ok.result.events[0]?.occurredAt, valid: validateDefinition(JSON.parse(readFileSync('overspeed.json', 'utf8'))).ok, inputs: inspectTemplate(JSON.parse(readFileSync('overspeed.json', 'utf8'))).inputs.map((i) => i.key), failedStatus: failed.result.status, usage, stub }));
${tail}`;

const ESM_SCRIPT = LIB_SCRIPT(`import { readFileSync } from 'node:fs';
import { createEngine, XweUsageError, validateDefinition, inspectTemplate } from '@xorgate/workflow-engine';
import { localHost } from '@xorgate/workflow-engine/local';
import { runConformance } from '@xorgate/workflow-engine/testing';`, '');
const CJS_SCRIPT = `const { readFileSync } = require('node:fs');
const { createEngine, XweUsageError, validateDefinition, inspectTemplate } = require('@xorgate/workflow-engine');
const { localHost } = require('@xorgate/workflow-engine/local');
const { runConformance } = require('@xorgate/workflow-engine/testing');
(async () => {
${LIB_SCRIPT('', '')}
})().catch((e) => { console.error(e); process.exit(9); });`;

function checkLibrary(dir, fmt) {
  const file = join(dir, fmt === 'esm' ? 'lib.mjs' : 'lib.cjs');
  writeFileSync(file, fmt === 'esm' ? ESM_SCRIPT : CJS_SCRIPT);
  const res = run(process.execPath, [file], { cwd: dir });
  let out = null;
  try { out = JSON.parse(res.stdout.trim().split('\n').at(-1)); } catch { /* below */ }
  if (res.status !== 0 || !out) return fail(`${fmt} library script in ${dir}: ${res.stderr.trim().split('\n').slice(-3).join(' | ')}`);
  const good =
    out.status === 'succeeded' && out.events === 1 && out.at === PINNED_EVENT_AT && out.valid === true &&
    JSON.stringify(out.inputs) === '["telemetry"]' && out.failedStatus === 'failed' &&
    out.usage?.isUsage === true && out.usage?.exitCode === 2 && out.stub === 'runConformance is not implemented until M5';
  if (good) pass(`${fmt}: createEngine + localHost ran overspeed (1 event at ${PINNED_EVENT_AT}); failed run resolves; usage rejects with exitCode 2; ./testing stub present`);
  else fail(`${fmt}: unexpected library result ${JSON.stringify(out)}`);
}

function checkCli(dir) {
  const v = run('npx', ['--no-install', 'xwe', 'validate', 'overspeed.json'], { cwd: dir });
  if (v.status === 0 && v.stdout.includes('--input telemetry=')) pass('npx xwe validate exits 0 and lists the telemetry input');
  else fail(`npx xwe validate: exit ${v.status} ${v.stderr.trim()}`);
  const r = run('npx', ['--no-install', 'xwe', 'run', 'overspeed.json', '--input', 'telemetry=window.csv', '--out', 'out', '--run-id', 'cli'], { cwd: dir });
  const resultFile = join(dir, 'out', 'cli', 'result.json');
  if (r.status === 0 && existsSync(resultFile)) {
    const result = JSON.parse(readFileSync(resultFile, 'utf8'));
    if (result.status === 'succeeded' && result.events.length === 1 && result.events[0].occurredAt === PINNED_EVENT_AT) pass(`npx xwe run overspeed: exit 0, 1 event at ${PINNED_EVENT_AT}`);
    else fail(`npx xwe run overspeed: unexpected result ${JSON.stringify(result.events)}`);
  } else fail(`npx xwe run: exit ${r.status} ${r.stderr.trim().split('\n').at(-1)}`);
  const d = run('npx', ['--no-install', 'xwe', 'doctor'], { cwd: dir });
  const lines = d.stdout.trim().split('\n');
  if (/^xwe \S+ \(node /.test(lines[0] ?? '') && lines.some((l) => l.includes('core e481243f5ffe4678'))) pass(`npx xwe doctor prints (exit ${d.status}):\n      ${lines.join('\n      ')}`);
  else fail(`npx xwe doctor: exit ${d.status}\n${d.stdout}${d.stderr}`);
}

try {
  // 1. Pack (prepack builds).
  const packOutput = execFileSync('npm', ['pack', '--json', '--pack-destination', work], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const jsonStart = packOutput.indexOf('[');
  if (jsonStart === -1) throw new Error(`npm pack printed no JSON:\n${packOutput}`);
  const packed = JSON.parse(packOutput.slice(jsonStart))[0];
  const tarball = join(work, packed.filename);
  const files = packed.files.map((f) => f.path);

  // 2. The file list: dist, README, LICENSE, CHANGELOG, package.json and nothing else.
  const forbidden = files.filter((p) => /^(fixtures|scripts|src|tools|out|docs|examples)\//.test(p) || p === 'Dockerfile' || /\.(onnx|mp4|ts)$/.test(p) && !/\.d\.ts$/.test(p));
  if (forbidden.length === 0) pass(`tarball has no fixtures/, scripts/, src/, tools/, Dockerfile, models or video (${files.length} files)`);
  else forbidden.forEach((p) => fail(`tarball contains ${p}`));
  for (const entry of ['dist/esm/index.js', 'dist/cjs/index.js', 'dist/esm/local/index.js', 'dist/cjs/local/index.js', 'dist/esm/testing/index.js', 'dist/cjs/testing/index.js', 'dist/cjs/cli/index.js', 'dist/esm/index.d.ts', 'dist/cjs/index.d.ts', 'LICENSE', 'README.md', 'CHANGELOG.md']) {
    if (files.includes(entry)) pass(`${entry} is in the tarball`);
    else fail(`${entry} is advertised but not in the tarball`);
  }

  // 3. Unpack and inspect the ESM output: finalized, no placeholder, every relative import has an extension.
  execFileSync('tar', ['-xzf', tarball, '-C', work]);
  const pkgDir = join(work, 'package');
  const esmProblems = [];
  for (const file of walk(join(pkgDir, 'dist/esm'))) {
    if (!file.endsWith('.js')) continue;
    const src = readFileSync(file, 'utf8');
    if (src.includes('__XWE_ESM_MODULE_URL__')) esmProblems.push(`${file}: placeholder survived`);
    for (const m of src.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
      if (!/\.(m?js|json)$/.test(m[1])) esmProblems.push(`${file}: extensionless import ${m[1]}`);
    }
  }
  if (esmProblems.length === 0) pass('dist/esm is finalized (import.meta.url in place, every relative import has an extension)');
  else esmProblems.forEach(fail);

  // 4. Fresh project, default install: CLI, ESM, CJS, doctor, sizes, no cloud SDK.
  const fixtures = [['fixtures/templates/overspeed.json', 'overspeed.json'], ['fixtures/telemetry/window.csv', 'window.csv']];
  const full = installProject('xwe-consumer-default', tarball, []);
  for (const [from, to] of fixtures) cpSync(join(root, from), join(full, to));
  const fullSize = dirSize(join(full, 'node_modules'));
  const cloud = [...walk(join(full, 'node_modules'))].filter((f) => CLOUD_RE.test(f));
  if (cloud.length === 0) pass('installed tree contains no cloud-provider SDK');
  else fail(`cloud-provider SDK in the installed tree: ${cloud.slice(0, 3).join(', ')}`);
  const optionalPresent = existsSync(join(full, 'node_modules/onnxruntime-node')) && existsSync(join(full, 'node_modules/@anthropic-ai/sdk'));
  if (optionalPresent) pass('default install includes both optional dependencies');
  else fail('default install is missing an optional dependency');
  checkCli(full);
  checkLibrary(full, 'esm');
  checkLibrary(full, 'cjs');

  // 5. Fresh project, --omit=optional: the lean install still runs telemetry graphs in both formats.
  const lean = installProject('xwe-consumer-lean', tarball, ['--omit=optional']);
  for (const [from, to] of fixtures) cpSync(join(root, from), join(lean, to));
  const leanSize = dirSize(join(lean, 'node_modules'));
  if (!existsSync(join(lean, 'node_modules/onnxruntime-node'))) pass('--omit=optional install has no onnxruntime-node');
  else fail('--omit=optional install still has onnxruntime-node');
  checkLibrary(lean, 'esm');
  checkLibrary(lean, 'cjs');
  const leanCli = run('npx', ['--no-install', 'xwe', 'run', 'overspeed.json', '--input', 'telemetry=window.csv', '--out', 'out', '--run-id', 'lean'], { cwd: lean });
  if (leanCli.status === 0) pass('--omit=optional: npx xwe run overspeed exits 0');
  else fail(`--omit=optional: npx xwe run exit ${leanCli.status} ${leanCli.stderr.trim().split('\n').at(-1)}`);

  console.log('');
  console.log('sizes');
  console.log(`  npm tarball                              ${kb(packed.size)} packed, ${mb(packed.unpackedSize)} unpacked, ${packed.entryCount} files (${packed.filename})`);
  console.log(`  node_modules after --omit=optional       ${mb(leanSize)}`);
  console.log(`  node_modules after a default install     ${mb(fullSize)}`);
  for (const dep of ['onnxruntime-node', '@anthropic-ai/sdk']) {
    const d = join(full, 'node_modules', dep);
    if (existsSync(d)) console.log(`    of which ${dep.padEnd(20)} ${mb(dirSize(d))}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\ntarball ok');
