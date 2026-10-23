#!/usr/bin/env node
// Smoke: the built package loads in both module formats, the three entry
// points export what the docs promise, importing them touches no native
// module, the catalog is whole (hash printed), and nothing cloud-provider
// specific is in the dependency tree. Run after `npm run build`.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
for (const name of ['createEngine', 'runGraph', 'validateDefinition', 'inspectTemplate', 'upgradeDefinition', 'listNodeTypes', 'buildCatalogPayload', 'defineNode', 'XweUsageError', 'IotRunProgress', 'teeArtifactSink', 'simTopicPrefix', 'runTopicPrefix', 'manifestKey', 'resultKey', 'eventsKey', 'recordsKey', 'frameKey', 'inputRecordsKey', 'captureFormatsOf', 'buildGoogleRoadsUrl', 'parseGoogleRoadsResponse', 'buildHereRequest', 'parseHereResponse', 'buildOverpassRequest', 'parseOverpassResponse', 'parseMaxspeedTag']) {
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
      root: ['createEngine', 'runGraph', 'validateDefinition', 'inspectTemplate', 'IotRunProgress', 'manifestKey', 'captureFormatsOf', 'buildHereRequest'].every((n) => typeof root[n] === 'function') && typeof root.simPreviewPayloadSchema?.safeParse === 'function' && root.V2_RUN_PREFIX === 'workflows/v2/runs/',
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
check('esm root exports createEngine/runGraph/validateDefinition/inspectTemplate and the 0.3.0 platform-shell names', esm?.root === true);
check('esm local exports localHost/writeRunArtifacts/emitVideo', esm?.local === true);
check('esm: importing the three entry points loads no native module', esm?.native === false);
check('esm testing.runConformance without a host rejects with XweUsageError (exit code 2), running nothing', esm?.stub === 'XweUsageError:2', esm?.stub);
check('cjs testing exports CONFORMANCE_CASE_NAMES (four cases) and CONFORMANCE_EXPECTATIONS (the pinned values)', JSON.stringify(cjsTesting.CONFORMANCE_CASE_NAMES) === JSON.stringify(['overspeed', 'detection', 'visualization', 'missing-input']) && cjsTesting.CONFORMANCE_EXPECTATIONS.overspeedAt === '2026-08-12T23:56:01.289Z' && cjsTesting.CONFORMANCE_EXPECTATIONS.detections === 81 && cjsTesting.CONFORMANCE_EXPECTATIONS.frames === 50, JSON.stringify(cjsTesting.CONFORMANCE_EXPECTATIONS));
// 2b. Secret hygiene and log levels (M5): the exports, the env scrub and the redactor's reach.
check('root exports LOG_LEVELS, scrubSecretEnv, SECRET_ENV_PREFIX and REDACTED', JSON.stringify(cjsRoot.LOG_LEVELS) === JSON.stringify(['silent', 'error', 'info', 'debug']) && typeof cjsRoot.scrubSecretEnv === 'function' && cjsRoot.SECRET_ENV_PREFIX === 'XORGATE_SECRET_' && cjsRoot.REDACTED === '[redacted]');
check('scrubSecretEnv drops every XWE_WEBHOOK_* entry (URLs and secrets, 0.5.0) too', JSON.stringify(cjsRoot.scrubSecretEnv({ PATH: '/bin', XWE_WEBHOOK_DISPATCH: 'https://x', XWE_WEBHOOK_SECRET_DISPATCH: 'whsec_x', XWE_MODELS_DIR: '/m' })) === JSON.stringify({ PATH: '/bin', XWE_MODELS_DIR: '/m' }) && cjsRoot.WEBHOOK_ENV_PREFIX === 'XWE_WEBHOOK_');
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

// 2c. Webhooks (0.5.0): the ./local surface, the shared signing vector (the
// platform's core-service unit test pins the same one), and nodeId being
// optional on read so a 0.4.0 result.json still parses.
{
  const names = ['localWebhookSink', 'resolveWebhookBindings', 'signWebhookPayload', 'webhookHeaders', 'webhookRefsOf', 'webhookSecretKey', 'webhookUrlProblem', 'workflowEventEnvelope', 'generateWebhookSecret', 'uuidv7', 'webhookEnvVar', 'webhookSecretEnvVar'];
  check('cjs local exports the webhook helpers', names.every((n) => typeof cjsLocal[n] === 'function') && cjsLocal.WEBHOOK_API_VERSION === '2026-09-27', names.filter((n) => typeof cjsLocal[n] !== 'function').join(','));
  // Computed independently with the `standardwebhooks` npm package (Webhook#sign).
  const V = {
    secret: 'whsec_eG9yZ2F0ZS13ZWJob29rcy1zaGFyZWQtdmVjdG9yLTMyYg==',
    id: '01928f3e-5c2a-7b4d-8e9f-0a1b2c3d4e5f',
    ts: 1790000000,
    body: '{"id":"01928f3e-5c2a-7b4d-8e9f-0a1b2c3d4e5f","type":"ping","apiVersion":"2026-09-27","data":{"message":"hello"}}',
    sig: 'v1,eunRXoEGTAdBvdruPkA9OUvMYGdgpA+cG8cpxQnFfVM=',
  };
  check('signWebhookPayload matches the shared Standard Webhooks vector', cjsLocal.signWebhookPayload({ id: V.id, timestamp: V.ts, body: V.body, secrets: [V.secret] }) === V.sig);
  const two = cjsLocal.signWebhookPayload({ id: V.id, timestamp: V.ts, body: V.body, secrets: [V.secret, cjsLocal.generateWebhookSecret()] }).split(' ');
  check('two secrets give two space-separated v1 signatures, the first the vector', two.length === 2 && two[0] === V.sig && two[1].startsWith('v1,'));
  check('generateWebhookSecret is whsec_ + standard base64 of 32 bytes', /^whsec_[A-Za-z0-9+/]{43}=$/.test(cjsLocal.generateWebhookSecret()) && cjsLocal.webhookSecretKey(cjsLocal.generateWebhookSecret()).length === 32);
  let refused = '';
  try { cjsLocal.webhookSecretKey('plain-LEAKME'); } catch (e) { refused = e.message; }
  check('webhookSecretKey refuses a non-whsec secret without quoting it', refused.includes('whsec_') && !refused.includes('LEAKME'), refused);
  check('webhookUrlProblem: https ok, http only with allowInsecure, user-info refused', cjsLocal.webhookUrlProblem('https://h.test/x') === null && cjsLocal.webhookUrlProblem('http://127.0.0.1:1/') !== null && cjsLocal.webhookUrlProblem('http://127.0.0.1:1/', { allowInsecure: true }) === null && cjsLocal.webhookUrlProblem('https://a:b@h.test/') !== null && cjsLocal.webhookUrlProblem('ftp://h.test/') !== null);
  check('uuidv7 is a version-7 RFC 9562 id', /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(cjsLocal.uuidv7()));
  const old = { kind: 'overspeed', occurredAt: '2026-08-12T23:56:01.289Z', confidence: 1, payloadSummary: 'overspeed', clipKey: null };
  check('engineEventSchema parses a 0.4.0 event (no nodeId) and keeps a 0.5.0 nodeId', cjsRoot.engineEventSchema.safeParse(old).success && cjsRoot.engineEventSchema.parse({ ...old, nodeId: 'n4' }).nodeId === 'n4');
}

// 3. Catalog registry loads with all 28 node defs; payload hash printed.
const nodeTypes = cjsRoot.listNodeTypes();
check('catalog has 28 node defs', nodeTypes.length === 28, `found ${nodeTypes.length}`);
const payload = cjsRoot.buildCatalogPayload();
check(
  'catalog payload builds',
  typeof payload.catalogVersion === 'string' && payload.nodes.length === 28,
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
  check('corePacks are eight packs totalling 28 nodes, core/function last with the two function nodes', cjsRoot.corePacks.length === 8 && cjsRoot.corePacks.reduce((n, p) => n + p.nodes.length, 0) === 28 && cjsRoot.corePacks[7].name === 'core/function' && cjsRoot.corePacks[7].nodes.map((n) => n.def.type).join(',') === 'function.javascript,function.python', cjsRoot.corePacks.map((p) => `${p.name}:${p.nodes.length}`).join(' '));
  check('payload.packs is one core entry whose hash is catalogVersion (no packs registered)', Array.isArray(payload.packs) && payload.packs.length === 1 && payload.packs[0].name === 'core' && payload.packs[0].hash === payload.catalogVersion && payload.packs[0].version === JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, JSON.stringify(payload.packs));
  // The core hash moves on purpose on minors (docs/compatibility.md): 0.2.0 added the two
  // function nodes (08c8c39436928e5e); 0.4.0 added output.visualization's `distance`
  // overlay, model.depth's distanceScale and proximity_gate's maxDistanceM (2b2a3c052696cf1e);
  // 0.5.0 added output.event's `webhook` (f8861576c807e382); unreleased: connector.third_party's
  // rate policy / no-answer / trace fields and logic.comparator's maxReferenceAgeMs /
  // fallbackReference (current hash below). Without core/function the 26 older defs hash to the
  // second value below (0.5.0: 184300277358e824; 0.4.0: ab458ea46642308b; 0.1.0-0.3.0: e481243f5ffe4678).
  check('catalogVersion is the current core hash 4b1a1732646c0e0d', payload.catalogVersion === '4b1a1732646c0e0d', payload.catalogVersion);
  const withoutFunctions = cjsRoot.buildCatalogPayload(cjsRoot.createCatalog(cjsRoot.corePacks.filter((p) => p.name !== 'core/function')));
  check('without core/function the 26 non-function defs hash to 3759a3cca37524e3', withoutFunctions.nodes.length === 26 && withoutFunctions.catalogVersion === '3759a3cca37524e3', withoutFunctions.catalogVersion);
  const oe = payload.nodes.find((n) => n.type === 'output.event');
  check('output.event config gains an optional flat string `webhook` (0.5.0)', oe?.configSchema?.properties?.webhook?.type === 'string' && !(oe.configSchema.required ?? []).includes('webhook') && oe.configDefaults?.webhook === undefined, JSON.stringify(oe?.configSchema?.properties?.webhook));
  // 0.4.0 metric depth: the pure helpers behind distanceM and the distance label.
  {
    const vision = require(join(root, 'dist/cjs/engine/vision.js'));
    const inv = vision.invertMetres(new Float32Array([2, 4, 0]));
    check('invertMetres: 1/d with a 0.1 m floor (higher = closer, like the relative model)', inv[0] === 0.5 && inv[1] === 0.25 && Math.abs(inv[2] - 10) < 1e-5, Array.from(inv).join(','));
    // 10x10 map at 100x100 source px: background 40 m, an object at 6 m in x 20..80, y 30..90.
    const raw = new Float32Array(100).fill(40);
    for (let y = 3; y < 9; y++) for (let x = 2; x < 8; x++) raw[y * 10 + x] = 6;
    check('medianMetresInBox reads the box\'s central half (object 6 m, background 40 m)', vision.medianMetresInBox(raw, 10, 10, [0, 10, 100, 100], 100, 100) === 6, String(vision.medianMetresInBox(raw, 10, 10, [0, 10, 100, 100], 100, 100)));
    check('formatDistance: one decimal under 10 m, whole metres above', vision.formatDistance(5.24) === '5.2 M' && vision.formatDistance(13.6) === '14 M', `${vision.formatDistance(5.24)} / ${vision.formatDistance(13.6)}`);
    const viz = cjsRoot.coreCatalog.getNodeType('output.visualization');
    check('output.visualization accepts the distance overlay', viz.config.safeParse({ overlays: ['boxes', 'labels', 'distance'] }).success);
    check('model.depth takes distanceScale (default 1) and proximity_gate takes maxDistanceM', cjsRoot.coreCatalog.getNodeType('model.depth').config.parse({}).distanceScale === 1 && cjsRoot.coreCatalog.getNodeType('model.depth').config.safeParse({ distanceScale: 0.4 }).success && cjsRoot.coreCatalog.getNodeType('logic.proximity_gate').config.parse({ maxDistanceM: 8 }).maxDistanceM === 8 && cjsRoot.coreCatalog.getNodeType('logic.proximity_gate').config.parse({}).maxDistanceM === undefined);
    check('model manifests accept postprocess.kind depth-anything-metric', cjsRoot.modelManifestSchema.shape.postprocess.shape.kind.safeParse('depth-anything-metric').success);
  }
  check('NODE_GROUPS names `function` (not `custom`) as the seventh group', cjsRoot.NODE_GROUPS.length === 7 && cjsRoot.NODE_GROUPS[6] === 'function' && !cjsRoot.NODE_GROUPS.includes('custom'), cjsRoot.NODE_GROUPS.join(','));
  check('CORE_NAMESPACES are the seven core namespaces plus function', cjsRoot.CORE_NAMESPACES.join(',') === 'source,video,telemetry,model,logic,output,connector,function', cjsRoot.CORE_NAMESPACES.join(','));
  const sample = cjsRoot.getNodeType('telemetry.ema');
  check('nodeTypeDefSchema accepts ui.editor "code" (additive) and rejects an unknown editor', cjsRoot.nodeTypeDefSchema.safeParse({ ...sample, ui: { ...sample.ui, editor: 'code' } }).success && !cjsRoot.nodeTypeDefSchema.safeParse({ ...sample, ui: { ...sample.ui, editor: 'nope' } }).success);
  const base = JSON.parse(readFileSync(join(root, 'fixtures/models/detection/yolov8n/1/manifest.json'), 'utf8'));
  check('model manifest `family` is an open string (a pack family parses; empty is refused); MODEL_FAMILIES keeps the three documented values', cjsRoot.modelManifestSchema.safeParse({ ...base, family: 'classification' }).success && !cjsRoot.modelManifestSchema.safeParse({ ...base, family: '' }).success && cjsRoot.MODEL_FAMILIES.join(',') === 'detection,depth,segmentation');
}

// 4d. Code function nodes (M7): the two defs, the config schema, the version rule, the runners in dist/.
{
  const js = cjsRoot.getNodeType('function.javascript');
  const py = cjsRoot.getNodeType('function.python');
  const portsOf = (d) => `${d.inputs.map((p) => `${p.id}:${p.channel}${p.tag ? '/' + p.tag : ''}:${p.cardinality}:${p.required}`).join(',')} -> ${d.outputs.map((p) => `${p.id}:${p.channel}/${p.tag}:${p.cardinality}`).join(',')}`;
  check('function.javascript and function.python are core nodes in the function group with editor "code" and target any', js?.group === 'function' && py?.group === 'function' && js.ui.editor === 'code' && py.ui.editor === 'code' && js.ui.icon === 'braces' && py.ui.icon === 'file-code' && js.runtime.target === 'any' && py.runtime.target === 'any' && cjsRoot.isCorePack(cjsRoot.corePacks[7]));
  check('function ports: event:json (untagged, many, optional) in, result:json/result out', portsOf(js) === 'event:json:many:false -> result:json/result:many' && portsOf(py) === portsOf(js), portsOf(js));
  const defaults = js.config.parse({});
  check('function config defaults: handler "handler", timeoutMs 3000, memoryMb 256, versions [], deployedVersion null, a starter code', defaults.handler === 'handler' && defaults.timeoutMs === 3000 && defaults.memoryMb === 256 && Array.isArray(defaults.versions) && defaults.versions.length === 0 && defaults.deployedVersion === null && typeof defaults.code === 'string' && defaults.code.includes('async function handler(event, context)') && py.config.parse({}).code.includes('def handler(event, context)'));
  check('function config ranges: timeoutMs 100..30000, memoryMb 128..2048, code at most 256 KB, handler an identifier', !js.config.safeParse({ timeoutMs: 99 }).success && !js.config.safeParse({ timeoutMs: 30001 }).success && js.config.safeParse({ timeoutMs: 100 }).success && !js.config.safeParse({ memoryMb: 127 }).success && !js.config.safeParse({ memoryMb: 2049 }).success && js.config.safeParse({ memoryMb: 2048 }).success && !js.config.safeParse({ code: 'x'.repeat(256 * 1024 + 1) }).success && js.config.safeParse({ code: 'x'.repeat(256 * 1024) }).success && !js.config.safeParse({ handler: 'not valid' }).success && cjsRoot.FUNCTION_CODE_MAX_BYTES === 262144);
  const versions = [{ version: 2, code: 'v2', handler: 'h2', publishedAt: '2026-09-05T00:00:00Z' }, { version: 1, code: 'v1', publishedAt: '2026-09-04T00:00:00Z', description: 'first' }];
  const cfg = js.config.parse({ code: 'latest', versions, deployedVersion: 2 });
  const r = cjsRoot.resolveFunctionCode;
  check('version rule: deployedVersion present in versions runs that snapshot (its code and handler), labelled vN', JSON.stringify(r(cfg)) === JSON.stringify({ code: 'v2', handler: 'h2', functionVersion: 2, label: 'v2' }) && r(cfg, 1).code === 'v1' && r(cfg, 1).handler === 'handler' && r(cfg, 1).label === 'v1', JSON.stringify(r(cfg)));
  check('version rule: deployedVersion null, or not in versions, runs the working copy as $LATEST', r(js.config.parse({ code: 'latest', versions })).label === '$LATEST' && r(js.config.parse({ code: 'latest', versions, deployedVersion: 3 })).code === 'latest' && r(js.config.parse({ code: 'latest', versions, deployedVersion: 3 })).functionVersion === '$LATEST');
  let bad = ''; try { r(cfg, 3); } catch (e) { bad = e.message; }
  check('version rule: an explicit version that is not published throws naming the published ones', bad === "version 3 is not in the node's versions (have: 2, 1)", bad);
  check('dist/runtime holds the two runners (copied by the build); functionSpawnSpec points at them, with the runner file as the only read grant', existsSync(join(root, 'dist/runtime/js/runner.cjs')) && existsSync(join(root, 'dist/runtime/python/runner.py')) && cjsRoot.functionSpawnSpec('javascript', { memoryMb: 128 }).args.join(' ').includes('--max-old-space-size=128') && cjsRoot.functionSpawnSpec('javascript', { memoryMb: 128 }).args.includes(`--allow-fs-read=${join(root, 'dist/runtime/js/runner.cjs')}`) && cjsRoot.functionSpawnSpec('javascript', { memoryMb: 128 }).args.filter((a) => a.startsWith('--allow-')).length === 1 && cjsRoot.functionSpawnSpec('javascript', { memoryMb: 128 }).args.at(-1) === join(root, 'dist/runtime/js/runner.cjs') && cjsRoot.functionSpawnSpec('python').command === 'python3' && cjsRoot.functionSpawnSpec('python').args.at(-1) === join(root, 'dist/runtime/python/runner.py'));
  check('the node flag follows the version: --experimental-permission before 22.13, --permission from 22.13 and 23', cjsRoot.nodePermissionFlag('20.20.2') === '--experimental-permission' && cjsRoot.nodePermissionFlag('22.12.0') === '--experimental-permission' && cjsRoot.nodePermissionFlag('22.13.0') === '--permission' && cjsRoot.nodePermissionFlag('24.14.0') === '--permission');
  const env = cjsRoot.functionChildEnv({ PATH: '/bin', HOME: '/h', XORGATE_SECRET_A: 'x', NODE_OPTIONS: '--require evil', AWS_SECRET_ACCESS_KEY: 'y', FFMPEG_PATH: '/f', TZ: 'UTC' });
  check('functionChildEnv keeps only the allowlist (PATH, HOME, TZ, ...): no XORGATE_SECRET_*, no NODE_OPTIONS, nothing else', JSON.stringify(env) === JSON.stringify({ PATH: '/bin', HOME: '/h', TZ: 'UTC' }), JSON.stringify(env));
  check('root exports resolveFunctionCode, functionChildEnv, functionSpawnSpec, nodePermissionFlag', ['resolveFunctionCode', 'functionChildEnv', 'functionSpawnSpec', 'nodePermissionFlag'].every((n) => typeof cjsRoot[n] === 'function'));
}

// 4e. Platform-shell exports (0.3.0): the reference progress transport, the
// artifact key helpers, the capture-format rule and the connector request
// builders reach the root entry point; the two former internal files are gone.
{
  check('root exports simPreviewPayloadSchema and V2_RUN_PREFIX', typeof cjsRoot.simPreviewPayloadSchema?.safeParse === 'function' && cjsRoot.V2_RUN_PREFIX === 'workflows/v2/runs/');
  check('key helpers name the artifact tree under workflows/v2/runs/<runId>/', cjsRoot.manifestKey('r1') === 'workflows/v2/runs/r1/manifest.json' && cjsRoot.resultKey('r1') === 'workflows/v2/runs/r1/result.json' && cjsRoot.eventsKey('r1') === 'workflows/v2/runs/r1/events.jsonl' && cjsRoot.recordsKey('r1', 'n3', 'json') === 'workflows/v2/runs/r1/outputs/n3/records.json' && cjsRoot.frameKey('r1', 'n5', 7) === 'workflows/v2/runs/r1/frames/n5/7.jpg' && cjsRoot.inputRecordsKey('r1', 'n1') === 'workflows/v2/runs/r1/inputs/n1/records.jsonl' && cjsRoot.runPrefix('r1') === 'workflows/v2/runs/r1/');
  check('simTopicPrefix / runTopicPrefix lay out wf/sim and wf/run per org and run', cjsRoot.simTopicPrefix('org', 'run') === 'wf/sim/org/run' && cjsRoot.runTopicPrefix('org', 'run') === 'wf/run/org/run');
  const published = [];
  const progress = new cjsRoot.IotRunProgress({ runId: 'smoke-progress', topicPrefix: cjsRoot.simTopicPrefix('org', 'smoke-progress'), publish: async (topic, payload) => { published.push([topic, JSON.parse(payload)]); }, log: () => {} });
  progress.runStatus({ status: 'running' });
  progress.step({ seq: 0, nodeId: 'n1', label: 'T', status: 'ok', output: '1 sample', durationMs: 1 });
  progress.event({ kind: 'overspeed', occurredAt: '2026-08-12T23:56:01.289Z', confidence: 1, payloadSummary: 'x' });
  progress.record({ nodeId: 'n2', port: 'out', ts: 1, seq: 0, payload: { a: 1 } });
  progress.runStatus({ status: 'succeeded' });
  await progress.flush();
  const topics = published.map(([t]) => t).join(' ');
  const parsed = published.every(([t, p]) => (t.endsWith('/status') ? cjsRoot.simStatusPayloadSchema : t.endsWith('/steps') ? cjsRoot.simStepPayloadSchema : t.endsWith('/events') ? cjsRoot.simEventPayloadSchema : cjsRoot.simRecordPayloadSchema).safeParse(p).success);
  check('IotRunProgress publishes status/steps/events/records/<nodeId> in order, payloads parsing with the sim*PayloadSchema', topics === 'wf/sim/org/smoke-progress/status wf/sim/org/smoke-progress/steps wf/sim/org/smoke-progress/events wf/sim/org/smoke-progress/records/n2 wf/sim/org/smoke-progress/status' && parsed && published[0][1].status === 'running' && published[4][1].status === 'succeeded', topics);
  const frames = [];
  const teed = cjsRoot.teeArtifactSink({ putFrame: async (nodeId, seq) => { frames.push(`${nodeId}/${seq}`); return `k/${nodeId}/${seq}`; } }, progress);
  const key = await teed.putFrame('viz', 3, Buffer.from('not a jpeg'));
  await progress.flush();
  check('teeArtifactSink writes through to the inner sink (its key wins) and previews best-effort (a bad JPEG is logged, not thrown)', key === 'k/viz/3' && frames.join() === 'viz/3');
  const def = { schemaVersion: 2, nodes: [
    { id: 'a', type: 'output.data_capture', position: { x: 0, y: 0 }, data: { label: 'A', config: { format: 'json' } } },
    { id: 'b', type: 'output.data_capture', position: { x: 0, y: 0 }, data: { label: 'B', config: {} } },
    { id: 'c', type: 'source.telemetry', position: { x: 0, y: 0 }, data: { label: 'C', config: {} } },
  ], edges: [] };
  check('captureFormatsOf (root and ./local are the same function) maps each data_capture node to jsonl unless json is configured', cjsRoot.captureFormatsOf === cjsLocal.captureFormatsOf && JSON.stringify(cjsRoot.captureFormatsOf(def)) === JSON.stringify({ a: 'json', b: 'jsonl' }));
  const here = cjsRoot.buildHereRequest(43.6, -79.5, 'KEY');
  const overpass = cjsRoot.buildOverpassRequest(43.6, -79.5);
  check('connector request builders: Google Roads URL carries the rounded position and the key; HERE and Overpass return { url, init }', cjsRoot.buildGoogleRoadsUrl(43.6, -79.5, 'K') === 'https://roads.googleapis.com/v1/speedLimits?path=43.6000%2C-79.5000&units=KPH&key=K' && here.url.startsWith('https://routematching.hereapi.com/v8/match/routelinks?') && here.url.includes('apikey=KEY') && typeof here.init === 'object' && overpass.url === 'https://overpass-api.de/api/interpreter' && overpass.init.headers['User-Agent'].startsWith('xorgate-workflows/2'));
  check('connector response parsers: Roads, HERE and Overpass answers reduce to { speedLimitKph, placeId? }; parseMaxspeedTag reads km/h and mph', JSON.stringify(cjsRoot.parseGoogleRoadsResponse({ speedLimits: [{ placeId: 'p', speedLimit: 50, units: 'KPH' }] })) === JSON.stringify({ speedLimitKph: 50, placeId: 'p' }) && cjsRoot.parseOverpassResponse({ elements: [{ tags: { maxspeed: '30 mph' } }] }).speedLimitKph === 48 && cjsRoot.parseHereResponse({}).speedLimitKph === null && cjsRoot.parseMaxspeedTag('60') === 60 && cjsRoot.parseMaxspeedTag('nope') === null);
  check('dist/cjs/engine and dist/esm/engine no longer ship session.js or finalize.js (moved to the platform shell)', ['cjs', 'esm'].every((f) => !existsSync(join(root, `dist/${f}/engine/session.js`)) && !existsSync(join(root, `dist/${f}/engine/finalize.js`))));
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
