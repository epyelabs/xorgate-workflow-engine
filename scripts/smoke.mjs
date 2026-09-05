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
    try { await testing.runConformance({}); } catch (e) { stub = e.name + ':' + e.exitCode; }
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
check('esm testing.runConformance without a host rejects with XweUsageError (exit code 2), running nothing', esm?.stub === 'XweUsageError:2', esm?.stub);
check('cjs testing exports CONFORMANCE_CASE_NAMES (four cases) and CONFORMANCE_EXPECTATIONS (the pinned values)', JSON.stringify(cjsTesting.CONFORMANCE_CASE_NAMES) === JSON.stringify(['overspeed', 'detection', 'visualization', 'missing-input']) && cjsTesting.CONFORMANCE_EXPECTATIONS.overspeedAt === '2026-08-12T23:56:01.289Z' && cjsTesting.CONFORMANCE_EXPECTATIONS.detections === 81 && cjsTesting.CONFORMANCE_EXPECTATIONS.frames === 50, JSON.stringify(cjsTesting.CONFORMANCE_EXPECTATIONS));
// 2b. Secret hygiene and log levels (M5): the exports, the env scrub and the redactor's reach.
check('root exports LOG_LEVELS, scrubSecretEnv, SECRET_ENV_PREFIX and REDACTED', JSON.stringify(cjsRoot.LOG_LEVELS) === JSON.stringify(['silent', 'error', 'info', 'debug']) && typeof cjsRoot.scrubSecretEnv === 'function' && cjsRoot.SECRET_ENV_PREFIX === 'XORGATE_SECRET_' && cjsRoot.REDACTED === '[redacted]');
check('scrubSecretEnv drops every XORGATE_SECRET_* entry and keeps the rest', JSON.stringify(cjsRoot.scrubSecretEnv({ PATH: '/bin', XORGATE_SECRET_A: 'x', XORGATE_SECRET_B_C: 'y', FFMPEG_PATH: '/f' })) === JSON.stringify({ PATH: '/bin', FFMPEG_PATH: '/f' }));
{
  // runGraph scrubs a value read through the secrets seam from the outcome and every progress message.
  const FAKE = 'sk-smoke-LEAK-0123456789';
  const def = { schemaVersion: 2, nodes: [
    { id: 'src', type: 'source.telemetry', position: { x: 0, y: 0 }, data: { label: 'T', config: { metrics: ['gps.latitude', 'gps.longitude'] } } },
    { id: 'roads', type: 'connector.third_party', position: { x: 0, y: 0 }, data: { label: 'C', config: { provider: 'here', maxLookupsPerRun: 1 } } },
  ], edges: [{ id: 'e', source: 'src', target: 'roads', sourceHandle: 'telemetry', targetHandle: 'positions' }] };
  const msgs = [];
  const outcome = await cjsRoot.runGraph(
    { runId: 'smoke-redact', mode: 'batch', deviceId: null, window: null, definition: def, bindings: { src: { kind: 'telemetry_inline', samples: [{ ts: 1, signals: { 'gps.latitude': 43.6, 'gps.longitude': -79.5 } }] } } },
    { sources: {}, secrets: { getSecret: async () => FAKE }, httpFetch: async (url) => { throw new Error(`refused ${url} (key ${FAKE})`); }, progress: { runStatus: (m) => msgs.push(m), step: (m) => msgs.push(m), event: (m) => msgs.push(m), record: (m) => msgs.push(m) }, log: (m) => msgs.push({ log: m }) },
  );
  const everything = JSON.stringify({ outcome, msgs });
  check('runGraph redacts a secret read through the seam from the outcome, the progress messages and the log', outcome.status === 'failed' && outcome.failedNodeId === 'roads' && !everything.includes(FAKE) && everything.includes('[redacted]') && outcome.error.includes('apikey=[redacted]') && outcome.error.includes('(key [redacted])'), outcome.error);
}

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

// 4c. Node packs (M4): the payload's additive `packs[]`, the seven core packs,
// the `function` group, the `code` editor and the open `family`.
{
  check('root exports createCatalog, corePacks, coreCatalog, CORE_NAMESPACES and the executor helpers', typeof cjsRoot.createCatalog === 'function' && Array.isArray(cjsRoot.corePacks) && typeof cjsRoot.coreCatalog?.getNodeType === 'function' && Array.isArray(cjsRoot.CORE_NAMESPACES) && ['requireInput', 'inputsForPort', 'telemetrySamples', 'mergeByTs', 'resolveSignal'].every((n) => typeof cjsRoot[n] === 'function'));
  check('corePacks are seven packs totalling 26 nodes', cjsRoot.corePacks.length === 7 && cjsRoot.corePacks.reduce((n, p) => n + p.nodes.length, 0) === 26, cjsRoot.corePacks.map((p) => `${p.name}:${p.nodes.length}`).join(' '));
  check('payload.packs is one core entry whose hash is catalogVersion (no packs registered)', Array.isArray(payload.packs) && payload.packs.length === 1 && payload.packs[0].name === 'core' && payload.packs[0].hash === payload.catalogVersion && payload.packs[0].version === JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, JSON.stringify(payload.packs));
  check('catalogVersion is the frozen core hash e481243f5ffe4678', payload.catalogVersion === 'e481243f5ffe4678', payload.catalogVersion);
  check('NODE_GROUPS names `function` (not `custom`) as the seventh group', cjsRoot.NODE_GROUPS.length === 7 && cjsRoot.NODE_GROUPS[6] === 'function' && !cjsRoot.NODE_GROUPS.includes('custom'), cjsRoot.NODE_GROUPS.join(','));
  check('CORE_NAMESPACES are the seven core namespaces plus function', cjsRoot.CORE_NAMESPACES.join(',') === 'source,video,telemetry,model,logic,output,connector,function', cjsRoot.CORE_NAMESPACES.join(','));
  const sample = cjsRoot.getNodeType('telemetry.ema');
  check('nodeTypeDefSchema accepts ui.editor "code" (additive) and rejects an unknown editor', cjsRoot.nodeTypeDefSchema.safeParse({ ...sample, ui: { ...sample.ui, editor: 'code' } }).success && !cjsRoot.nodeTypeDefSchema.safeParse({ ...sample, ui: { ...sample.ui, editor: 'nope' } }).success);
  const base = JSON.parse(readFileSync(join(root, 'fixtures/models/detection/yolov8n/1/manifest.json'), 'utf8'));
  check('model manifest `family` is an open string (a pack family parses; empty is refused); MODEL_FAMILIES keeps the three documented values', cjsRoot.modelManifestSchema.safeParse({ ...base, family: 'classification' }).success && !cjsRoot.modelManifestSchema.safeParse({ ...base, family: '' }).success && cjsRoot.MODEL_FAMILIES.join(',') === 'detection,depth,segmentation');
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
