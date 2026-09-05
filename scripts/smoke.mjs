#!/usr/bin/env node
// Smoke: the built package loads in both module formats, the three entry
// points export what the docs promise, importing them touches no native
// module, the catalog is whole (hash printed), and nothing cloud-provider
// specific is in the dependency tree. Run after `npm run build`.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failed = false;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

const NATIVE_RE = /node_modules[\\/](onnxruntime-node|@anthropic-ai)[\\/]/;

// 1. CJS entry points load and export the documented surface.
const cjsRoot = require(join(root, 'dist/cjs/index.js'));
const cjsLocal = require(join(root, 'dist/cjs/local/index.js'));
const cjsTesting = require(join(root, 'dist/cjs/testing/index.js'));
for (const name of ['createEngine', 'runGraph', 'validateDefinition', 'inspectTemplate', 'upgradeDefinition', 'listNodeTypes', 'buildCatalogPayload', 'defineNode', 'XweUsageError']) {
  check(`cjs root exports ${name}`, typeof cjsRoot[name] === 'function');
}
for (const name of ['localHost', 'localSources', 'localArtifactSink', 'localSecretReader', 'ndjsonProgress', 'writeRunArtifacts', 'buildResult', 'emitVideo']) {
  check(`cjs local exports ${name}`, typeof cjsLocal[name] === 'function');
}
check('cjs testing exports runConformance', typeof cjsTesting.runConformance === 'function');
check(
  'cjs: importing the three entry points loads no native module',
  !Object.keys(require.cache).some((k) => NATIVE_RE.test(k)),
);

// 2. The same through ESM, in a child so the import graph is fresh.
const esmProbe = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `
    import { createRequire } from 'node:module';
    const root = await import(${JSON.stringify(join(root, 'dist/esm/index.js'))});
    const local = await import(${JSON.stringify(join(root, 'dist/esm/local/index.js'))});
    const testing = await import(${JSON.stringify(join(root, 'dist/esm/testing/index.js'))});
    const native = Object.keys(createRequire(import.meta.url).cache).some((k) => ${NATIVE_RE.toString()}.test(k));
    let stub = '';
    try { await testing.runConformance({}); } catch (e) { stub = e.message; }
    console.log(JSON.stringify({
      root: ['createEngine', 'runGraph', 'validateDefinition', 'inspectTemplate'].every((n) => typeof root[n] === 'function'),
      local: ['localHost', 'writeRunArtifacts', 'emitVideo'].every((n) => typeof local[n] === 'function'),
      native, stub,
    }));
    `,
  ],
  { encoding: 'utf8' },
);
let esm = null;
try {
  esm = JSON.parse(esmProbe.stdout.trim().split('\n').at(-1));
} catch {
  // reported below
}
check('esm entry points load', esm !== null, esmProbe.stderr.trim().split('\n').at(-1) ?? '');
check('esm root exports createEngine/runGraph/validateDefinition/inspectTemplate', esm?.root === true);
check('esm local exports localHost/writeRunArtifacts/emitVideo', esm?.local === true);
check('esm: importing the three entry points loads no native module', esm?.native === false);
check('esm testing.runConformance is the M5 stub', esm?.stub === 'runConformance is not implemented until M5', esm?.stub);

// 3. Catalog registry loads with all 26 node defs; payload hash printed.
const nodeTypes = cjsRoot.listNodeTypes();
check('catalog has 26 node defs', nodeTypes.length === 26, `found ${nodeTypes.length}`);
const payload = cjsRoot.buildCatalogPayload();
check(
  'catalog payload builds',
  typeof payload.catalogVersion === 'string' && payload.nodes.length === 26,
  `catalogVersion=${payload.catalogVersion} schemaVersion=${payload.schemaVersion}`,
);

// 4. Every fixture model manifest still parses (manifest v1 stays frozen).
{
  const manifests = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === 'manifest.json') manifests.push(p);
    }
  })(join(root, 'fixtures/models'));
  const bad = manifests.filter((p) => !cjsRoot.modelManifestSchema.safeParse(JSON.parse(readFileSync(p, 'utf8'))).success);
  check(`fixture model manifests parse (${manifests.length})`, manifests.length > 0 && bad.length === 0, bad.join(', '));
}

// 4b. Manifest v1 stays frozen with the additive `files` block (M3): a manifest
// without it parses, one with it parses and keeps it, a malformed one is refused.
{
  const base = JSON.parse(readFileSync(join(root, 'fixtures/models/detection/yolov8n/1/manifest.json'), 'utf8'));
  const { files: _drop, ...without } = base;
  const withFiles = { ...without, files: { 'model.onnx': { sha256: 'a'.repeat(64), sizeBytes: 12851122 } } };
  const noFiles = cjsRoot.modelManifestSchema.safeParse(without);
  const yesFiles = cjsRoot.modelManifestSchema.safeParse(withFiles);
  const badSha = cjsRoot.modelManifestSchema.safeParse({ ...without, files: { 'model.onnx': { sha256: 'nope', sizeBytes: 1 } } });
  const badSize = cjsRoot.modelManifestSchema.safeParse({ ...without, files: { 'model.onnx': { sha256: 'a'.repeat(64), sizeBytes: -1 } } });
  check('model manifest without `files` still parses (v1 frozen)', noFiles.success && noFiles.data.files === undefined);
  check('model manifest with `files` parses and keeps sha256/sizeBytes', yesFiles.success && yesFiles.data.files['model.onnx'].sha256 === 'a'.repeat(64) && yesFiles.data.files['model.onnx'].sizeBytes === 12851122);
  check('model manifest `files` rejects a malformed sha256 or a negative size', !badSha.success && !badSize.success);
  check('root exports modelFileIntegritySchema', typeof cjsRoot.modelFileIntegritySchema?.safeParse === 'function');
  check('cjs local exports the model chain, registry client and checkModelDir', ['createModelChain', 'dirResolver', 'cacheResolver', 'httpResolver', 'pullModel', 'fetchRegistryIndex', 'checkModelDir', 'parseModelSpec'].every((n) => typeof cjsLocal[n] === 'function'));
}

// 5. No cloud-provider packages anywhere: package.json, lockfile, and the src/ tree.
const AWS_RE = /@aws-sdk|aws-lambda/;
for (const f of ['package.json', 'package-lock.json']) {
  check(`${f} has no AWS packages`, !AWS_RE.test(readFileSync(join(root, f), 'utf8')));
}
const hits = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (AWS_RE.test(readFileSync(p, 'utf8'))) hits.push(p);
  }
})(join(root, 'src'));
check('src/ has no AWS references', hits.length === 0, hits.join(', '));

process.exit(failed ? 1 : 0);
