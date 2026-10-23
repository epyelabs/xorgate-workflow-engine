#!/usr/bin/env node
// Connector and comparator suite (P0.3 rate policy, P1.1 trace mode): the
// connector.third_party executor and logic.comparator driven through
// runGraph with HTTP mocked (no network) and a virtual clock for pacing and
// back-off. Run `npm run build` first (`npm test` does).
//
// Channel capacity: graphs that buffer a whole input (trace mode) pass a large
// `channelCapacity` through EngineRunDeps, since main's batch channels are
// still bounded at 32 (P0.1 makes them unbounded on another branch).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const engine = require(join(root, 'dist/cjs/index.js'));
// Deep import for the internal clock seam; the same module instance the catalog runs.
const conn = require(join(root, 'dist/cjs/catalog/nodes/connector-third-party.js'));

let failed = false;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}
const readJson = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const BIG_CAPACITY = 1_000_000;

// --- virtual clock ---------------------------------------------------------------
function useVirtualClock(start = 1_800_000_000_000) {
  const clock = { t: start, sleeps: [] };
  conn.connectorClock.now = () => clock.t;
  conn.connectorClock.sleep = async (ms) => {
    clock.sleeps.push(ms);
    clock.t += ms;
  };
  conn.connectorClock.random = () => 0.5;
  return clock;
}
const realClock = () => conn.resetConnectorClock();

// --- graph helpers ---------------------------------------------------------------
const node = (id, type, config, label = id) => ({ id, type, position: { x: 0, y: 0 }, data: { label, config } });
const edge = (source, sourceHandle, target, targetHandle) => ({ id: `${source}-${target}-${targetHandle}`, source, target, sourceHandle, targetHandle });

/** src -> roads -> cap (records captured). */
function connectorGraph(roadsConfig) {
  return {
    schemaVersion: 2,
    nodes: [
      node('src', 'source.telemetry', { metrics: ['gps.lat', 'gps.lon', 'gps.speed'] }),
      node('roads', 'connector.third_party', roadsConfig),
      node('cap', 'output.data_capture', { format: 'jsonl' }),
    ],
    edges: [edge('src', 'telemetry', 'roads', 'positions'), edge('roads', 'speed_limit', 'cap', 'records')],
  };
}

async function run(definition, samples, httpFetch, extra = {}) {
  const outcome = await engine.runGraph(
    { runId: 'connector-test', mode: extra.mode ?? 'batch', deviceId: null, window: null, definition, bindings: { src: { kind: 'telemetry_inline', samples } } },
    { sources: {}, secrets: { getSecret: async () => 'test-key-0123456789' }, httpFetch, log: () => {}, ...(extra.channelCapacity ? { channelCapacity: extra.channelCapacity } : {}), deadlineMs: extra.deadlineMs ?? 30000 },
  );
  const step = (id) => outcome.steps.find((s) => s.nodeId === id);
  return { outcome, step, records: (outcome.captures.cap ?? []).map((c) => c.record) };
}

/** n samples at 1 Hz moving north ~22 m per sample (distinct 4 dp positions). */
function drive(n, { t0 = 1_792_000_000_000, lat0 = 43.65, lon0 = -79.5, speed = 50, stepDeg = 0.0002 } = {}) {
  return Array.from({ length: n }, (_, i) => ({ ts: t0 + i * 1000, signals: { 'gps.lat': lat0 + i * stepDeg, 'gps.lon': lon0, 'gps.speed': speed } }));
}

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const hereOk = (limit) => json({ response: { route: [{ leg: [{ link: [{ linkId: '+1', attributes: { SPEED_LIMITS_FCN: [{ FROM_REF_SPEED_LIMIT: String(limit), TO_REF_SPEED_LIMIT: String(limit), UNIT: 'K' }] } }] }] }] } });

// =============================== P0.3 ===============================================

// --- pacing: the throttle alone, then each provider's default through the executor --
{
  const clock = useVirtualClock(0);
  const th = new conn.RequestThrottle(5);
  const at = [];
  for (let i = 0; i < 5; i++) { await th.wait(); at.push(clock.t); }
  check('pacing: RequestThrottle(5 rps) spaces requests 200 ms apart, first immediate (virtual clock)', JSON.stringify(at) === JSON.stringify([0, 200, 400, 600, 800]), JSON.stringify(at));
  const late = [];
  clock.t = 5000; await th.wait(); late.push(clock.t); await th.wait(); late.push(clock.t);
  check('pacing: an idle bucket does not bank a burst (burst 1)', JSON.stringify(late) === JSON.stringify([5000, 5200]), JSON.stringify(late));
  realClock();
}
for (const [provider, minGap, maxGap] of [['here', 200, 200], ['google_roads', 100, 100], ['osm', 1000, 1250]]) {
  const clock = useVirtualClock();
  conn.connectorClock.random = () => 0.999;
  const calls = [];
  const http = async () => {
    calls.push(clock.t);
    if (provider === 'osm') return json({ elements: [{ tags: { maxspeed: '60' } }] });
    if (provider === 'google_roads') return json({ speedLimits: [{ placeId: 'p', speedLimit: 60, units: 'KPH' }] });
    return hereOk(60);
  };
  const r = await run(connectorGraph({ provider }), drive(6), http);
  const gaps = calls.slice(1).map((t, i) => t - calls[i]);
  check(`pacing: ${provider} default spacing ${minGap}${maxGap !== minGap ? `-${maxGap}` : ''} ms between lookups (6 lookups, virtual clock)`, r.outcome.status === 'succeeded' && calls.length === 6 && gaps.every((g) => g >= minGap && g <= maxGap), `${r.outcome.error} gaps=${gaps}`);
  realClock();
}
{
  const clock = useVirtualClock();
  const calls = [];
  const r = await run(connectorGraph({ provider: 'here', maxRequestsPerSecond: 2 }), drive(3), async () => { calls.push(clock.t); return hereOk(50); });
  check('pacing: maxRequestsPerSecond 2 on HERE gives 500 ms spacing', r.outcome.status === 'succeeded' && calls[1] - calls[0] === 500 && calls[2] - calls[1] === 500, JSON.stringify(calls));
  realClock();
}

// --- retries: 429 then success, without and with Retry-After ------------------------
{
  const clock = useVirtualClock();
  let n = 0;
  const http = async () => (++n === 1 ? json({ error: 'Too Many Requests' }, 429) : hereOk(50));
  const r = await run(connectorGraph({ provider: 'here' }), drive(1), http);
  const backoff = clock.sleeps.find((ms) => ms !== 200);
  check('retry: HERE 429 then 200 succeeds with one retry, full-jitter back-off in [0, 500) ms', r.outcome.status === 'succeeded' && n === 2 && r.records.length === 1 && r.records[0].speedLimitKph === 50 && /1 retry/.test(r.step('roads').output) && backoff !== undefined && backoff >= 0 && backoff < 500, `${r.outcome.error} | ${r.step('roads').output} | sleeps=${clock.sleeps}`);
  realClock();
}
{
  const clock = useVirtualClock();
  let n = 0;
  const http = async () => (++n === 1 ? json({ error: 'Too Many Requests' }, 429, { 'Retry-After': '2' }) : hereOk(50));
  const r = await run(connectorGraph({ provider: 'here' }), drive(1), http);
  check('retry: Retry-After: 2 is honoured (a 2000 ms wait) before the successful retry', r.outcome.status === 'succeeded' && n === 2 && clock.sleeps.includes(2000), `sleeps=${clock.sleeps}`);
  realClock();
}
{
  const clock = useVirtualClock();
  let n = 0;
  const http = async () => (++n === 1 ? json({}, 429, { 'Retry-After': new Date(clock.t + 3000).toUTCString() }) : hereOk(50));
  const r = await run(connectorGraph({ provider: 'here' }), drive(1), http);
  check('retry: an HTTP-date Retry-After is honoured too', r.outcome.status === 'succeeded' && clock.sleeps.some((ms) => ms >= 2000 && ms <= 3000), `sleeps=${clock.sleeps}`);
  realClock();
}
{
  const clock = useVirtualClock();
  let n = 0;
  const http = async () => { n++; return json({ remark: 'overloaded' }, 503); };
  const r = await run(connectorGraph({ provider: 'osm' }), drive(2), http);
  check('retry: OSM 503 on every attempt fails the node after 4 attempts (default), counts on the failure and in the summary', r.outcome.status === 'failed' && n === 4 && /Overpass is overloaded or unavailable \(HTTP 503 after 4 attempts\)/.test(r.outcome.error) && /\[0 speed-limit record\(s\) via osm, 1 lookup\(s\), 3 retries\]$/.test(r.outcome.error), `${n} ${r.outcome.error}`);
  realClock();
}
{
  useVirtualClock();
  let n = 0;
  const r = await run(connectorGraph({ provider: 'google_roads', retry: { attempts: 1 } }), drive(1), async () => { n++; return json({}, 500); });
  check('retry: attempts 1 disables retries', r.outcome.status === 'failed' && n === 1 && /Google Roads request failed \(HTTP 500\)/.test(r.outcome.error), r.outcome.error);
  realClock();
}
{
  const clock = useVirtualClock();
  let n = 0;
  const r = await run(connectorGraph({ provider: 'here' }), drive(1), async () => { n++; return json({}, 429, { 'Retry-After': '120' }); });
  check('retry: a Retry-After past 60 s is not waited out (one attempt, then the lookup fails)', r.outcome.status === 'failed' && n === 1 && !clock.sleeps.includes(120000) && /HTTP 429/.test(r.outcome.error), `${n} ${r.outcome.error}`);
  realClock();
}

// --- timeout: a hung fetch ----------------------------------------------------------
{
  const started = Date.now();
  const hung = () => new Promise(() => {}); // never settles, ignores the signal
  const r = await run(connectorGraph({ provider: 'here', requestTimeoutMs: 100 }), drive(1), hung);
  const ms = Date.now() - started;
  check('timeout: a fetch that never settles (and ignores the AbortSignal) fails the lookup after requestTimeoutMs', r.outcome.status === 'failed' && /HERE request timed out after 100 ms/.test(r.outcome.error) && ms < 3000, `${ms} ms: ${r.outcome.error}`);
  let aborted = false;
  const polite = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); }));
  let k = 0;
  const r2 = await run(connectorGraph({ provider: 'here', requestTimeoutMs: 50, onLookupError: 'skip', emitNoAnswer: true }), drive(2), (url, init) => (k++ === 0 ? polite(url, init) : Promise.resolve(hereOk(40))));
  check('timeout: the AbortSignal reaches ctx.http; with skip the timed-out lookup becomes a null record (reason error)', aborted && r2.outcome.status === 'succeeded' && r2.records.length === 2 && r2.records[0].speedLimitKph === null && r2.records[0].reason === 'error' && r2.records[1].speedLimitKph === 40, `${r2.outcome.error} ${JSON.stringify(r2.records)}`);
}

// --- skip path and error budget -------------------------------------------------------
{
  useVirtualClock();
  let n = 0;
  const http = async () => (++n % 6 === 0 ? json({}, 502) : hereOk(60));
  const r = await run(connectorGraph({ provider: 'here', onLookupError: 'skip', emitNoAnswer: true, retry: { attempts: 1 } }), drive(12), http);
  const nulls = r.records.filter((x) => x.speedLimitKph === null);
  check('skip: 2 failed lookups of 12 (16.7 % <= 20 %) keep the run green, failed positions emit reason "error"', r.outcome.status === 'succeeded' && r.records.length === 12 && nulls.length === 2 && nulls.every((x) => x.reason === 'error' && x.source === 'here') && /2 failed lookup\(s\)/.test(r.step('roads').output), `${r.outcome.error} | ${r.step('roads').output}`);
  const r2 = await run(connectorGraph({ provider: 'here', onLookupError: 'skip', retry: { attempts: 1 } }), drive(12), async () => { n++; return n % 6 === 0 ? json({}, 502) : hereOk(60); });
  check('skip without emitNoAnswer: failed positions emit nothing (10 records of 12)', r2.outcome.status === 'succeeded' && r2.records.length === 10, `${r2.outcome.error} ${r2.records.length}`);
  realClock();
}
{
  useVirtualClock();
  let n = 0;
  const http = async () => (++n % 3 === 0 ? json({}, 500) : hereOk(60));
  const r = await run(connectorGraph({ provider: 'here', onLookupError: 'skip', retry: { attempts: 1 } }), drive(30), http);
  check('skip: errors past maxErrorRatio (1 in 3 > 20 %) fail the node once 10 lookups were made', r.outcome.status === 'failed' && /failing too often \(3\/10 > maxErrorRatio 0\.2\); last: HERE request failed \(HTTP 500\)/.test(r.outcome.error), r.outcome.error);
  const r3 = await run(connectorGraph({ provider: 'here', onLookupError: 'skip', retry: { attempts: 1 } }), drive(3), async () => json({}, 500));
  check('skip: a short run where every lookup failed fails at the end of the input', r3.outcome.status === 'failed' && /failing too often \(3\/3/.test(r3.outcome.error), r3.outcome.error);
  n = 0;
  const r2 = await run(connectorGraph({ provider: 'here', onLookupError: 'skip', maxErrorRatio: 0.5, retry: { attempts: 1 } }), drive(30), async () => (++n % 3 === 0 ? json({}, 500) : hereOk(60)));
  check('skip: maxErrorRatio 0.5 tolerates the same 1-in-3 failures', r2.outcome.status === 'succeeded' && r2.records.length === 20, r2.outcome.error);
  realClock();
}
{
  useVirtualClock();
  const r = await run(connectorGraph({ provider: 'here', onLookupError: 'skip' }), drive(3), async (url) => json({ error: 'invalid apikey', request: String(url) }, 401));
  check('skip: a rejected API key (401) still fails the node, key redacted', r.outcome.status === 'failed' && r.outcome.error.startsWith('HERE rejected the API key (HTTP 401)') && !r.outcome.error.includes('test-key-0123456789'), r.outcome.error);
  realClock();
}

// --- emitNoAnswer and capping -------------------------------------------------------
{
  useVirtualClock();
  const r = await run(connectorGraph({ provider: 'osm', emitNoAnswer: true, maxLookupsPerRun: 3 }), drive(5), async () => json({ elements: [] }));
  const reasons = r.records.map((x) => x.reason).join(',');
  check('emitNoAnswer: no-answer and capped positions emit { ts, speedLimitKph: null, source, reason }', r.outcome.status === 'succeeded' && reasons === 'no_answer,no_answer,no_answer,capped,capped' && r.records.every((x, i) => x.ts === 1_792_000_000_000 + i * 1000 && x.speedLimitKph === null && x.source === 'osm'), reasons);
  realClock();
}
{
  useVirtualClock();
  const urls = [];
  const r = await run(connectorGraph({ provider: 'osm', osmEndpoint: 'https://overpass.example.test/api/interpreter' }), drive(1), async (url) => { urls.push(String(url)); return json({ elements: [{ tags: { maxspeed: '40' } }] }); });
  check('osmEndpoint: lookups go to the configured Overpass URL', r.outcome.status === 'succeeded' && urls[0] === 'https://overpass.example.test/api/interpreter', urls[0]);
  realClock();
}

// --- comparator: null clears, maxReferenceAgeMs, fallbackReference -----------------
// The executor driven directly with in-memory channels (condition messages
// cannot be captured by output.data_capture, which takes json only).
const cmpMod = require(join(root, 'dist/cjs/catalog/nodes/logic-comparator.js'));
async function comparator(config, references, signals) {
  const chan = (msgs) => ({ async *[Symbol.asyncIterator]() { for (const m of msgs) yield m; } });
  const ref = references.map((payload, i) => ({ ch: 'json', ts: payload.ts, seq: i, payload }));
  const sig = signals.map(([ts, speed], i) => ({ ch: 'telemetry', ts, seq: i, payload: { signals: { 'gps.speed': speed } } }));
  let summary = '';
  const ctx = { setSummary: (s) => { summary = s; }, log: () => {} };
  const out = [];
  const inputs = [
    { port: 'signal', from: { nodeId: 'src', port: 'telemetry' }, messages: chan(sig) },
    { port: 'reference', from: { nodeId: 'roads', port: 'speed_limit' }, messages: chan(ref) },
  ];
  for await (const m of cmpMod.executor(inputs, cmpMod.def.config.parse(config), ctx)) out.push(m.payload);
  return { out, summary };
}
{
  const base = { signal: 'gps.speed', operator: 'gt', field: 'speedLimitKph', margin: 5 };
  const refs = [{ ts: 0, speedLimitKph: 30, source: 'osm' }, { ts: 1000, speedLimitKph: null, source: 'osm', reason: 'no_answer' }, { ts: 2000, speedLimitKph: 30, source: 'osm' }];
  const speeds = [[0, 45], [1000, 45], [2000, 45]];
  const today = await comparator(base, refs, speeds);
  check('comparator: a null field clears the held reference (no fallback: that sample is skipped)', today.out.length === 2 && today.out.map((p) => p.meta.referenceAgeMs).join(',') === '0,0' && /true on 2\/2 samples \(1 before first reference\)/.test(today.summary), `${today.summary} ${JSON.stringify(today.out.map((p) => p.meta))}`);
  const fb = await comparator({ ...base, fallbackReference: 50 }, refs, speeds);
  check('comparator: fallbackReference answers while cleared; meta.referenceSource / referenceAgeMs say which', fb.out.map((p) => `${p.meta.reference}/${p.meta.referenceSource}/${p.value}`).join(',') === '30/record/true,50/fallback/false,30/record/true' && fb.out[1].meta.record?.reason === 'no_answer' && /1 against fallback 50/.test(fb.summary), `${fb.summary} ${JSON.stringify(fb.out.map((p) => p.meta))}`);
  const aged = await comparator({ ...base, maxReferenceAgeMs: 1500 }, [refs[0]], [[0, 45], [1000, 45], [2000, 45], [3000, 45]]);
  check('comparator: maxReferenceAgeMs 1500 without fallback compares ages 0 and 1000 ms and skips the older samples', aged.out.map((p) => p.meta.referenceAgeMs).join(',') === '0,1000' && /true on 2\/2 samples \(2 without a usable reference\), 2 with a stale reference/.test(aged.summary), `${aged.summary}`);
  const agedFb = await comparator({ ...base, maxReferenceAgeMs: 1500, fallbackReference: 50 }, [refs[0]], [[-1000, 45], [0, 45], [1000, 45], [2000, 45]]);
  check('comparator: before the first record and past the max age, fallbackReference is used', agedFb.out.map((p) => `${p.meta.reference}/${p.meta.referenceSource}/${p.meta.referenceAgeMs}`).join(',') === '50/fallback/null,30/record/0,30/record/1000,50/fallback/2000', JSON.stringify(agedFb.out.map((p) => p.meta)));
  const plain = await comparator(base, [refs[0], { ts: 1000, source: 'osm' }], speeds);
  check('comparator: a record without the field is still ignored (the reference holds), defaults unchanged', plain.out.length === 3 && plain.out.every((p) => p.meta.reference === 30 && p.meta.referenceSource === 'record'), JSON.stringify(plain.out.map((p) => p.meta)));
}

// --- the M0-P0 stale-limit scenario, on the production overspeed graph --------------
// 10 s hold grid over a 1 Hz drive. Segment A (0-60 s): positions near a
// side street tagged 30, driving 30. B (60-90 s): no tagged way within 30 m,
// driving 45: today the comparator holds the side street's 30 and fires a
// false overspeed (45 > 30 + 5). C (90-130 s): 30 km/h. D (130-200 s): no
// tagged way, driving 70: a real overspeed either way (70 > 50 + 5).
{
  const fallbackTpl = readJson('fixtures/templates/overspeed-osm-fallback.json');
  const baselineTpl = structuredClone(fallbackTpl);
  for (const n of baselineTpl.nodes) {
    if (n.id === 'roads') { delete n.data.config.emitNoAnswer; delete n.data.config.onLookupError; }
    if (n.id === 'cmp') { delete n.data.config.fallbackReference; delete n.data.config.maxReferenceAgeMs; }
  }
  const t0 = 1_792_269_400_000;
  const samples = Array.from({ length: 200 }, (_, s) => {
    const seg = s < 60 ? 'A' : s < 90 ? 'B' : s < 130 ? 'C' : 'D';
    const tagged = seg === 'A' || seg === 'C';
    return { ts: t0 + s * 1000, signals: { 'obd.speed': seg === 'B' ? 45 : seg === 'D' ? 70 : 30, 'gps.lat': (tagged ? 43.60 : 43.70) + s * 0.0001, 'gps.lon': -79.55 } };
  });
  const overpass = async (_url, init) => {
    const q = decodeURIComponent(String(init.body).slice(5));
    const lat = Number(/around:30,([-\d.]+),/.exec(q)[1]);
    return json({ elements: lat < 43.65 ? [{ tags: { highway: 'residential', maxspeed: '30' } }] : [] });
  };
  useVirtualClock();
  const base = await run(baselineTpl, samples, overpass);
  const fb = await run(fallbackTpl, samples, overpass);
  realClock();
  const ev = (r) => r.outcome.events.map((e) => ({ at: Date.parse(e.occurredAt) - t0, ref: e.payload.reference, src: e.payload.referenceSource, age: e.payload.referenceAgeMs, recTs: e.payload.record?.ts }));
  const b = ev(base);
  const f = ev(fb);
  check('stale limit (baseline, prod graph as configured today): 2 overspeed events, the first against a held 30 from an older record', base.outcome.status === 'succeeded' && b.length === 2 && b[0].ref === 30 && b[0].recTs < t0 + b[0].at && b[0].at >= 60000 && b[0].at < 90000 && b[1].at >= 130000, JSON.stringify(b));
  check('stale limit (emitNoAnswer + skip on roads, fallbackReference 50 + maxReferenceAgeMs 5000 on cmp): the false event is dropped, the real one fires against the assumed 50', fb.outcome.status === 'succeeded' && f.length === 1 && f[0].at >= 130000 && f[0].ref === 50 && f[0].src === 'fallback', JSON.stringify(f));
  // Same, without emitNoAnswer: the age rule alone catches the held limit.
  const ageOnly = structuredClone(fallbackTpl);
  for (const n of ageOnly.nodes) if (n.id === 'roads') delete n.data.config.emitNoAnswer;
  useVirtualClock();
  const ao = await run(ageOnly, samples, overpass);
  realClock();
  check('stale limit (maxReferenceAgeMs alone, connector silent on no answer): same single real event', ao.outcome.status === 'succeeded' && ev(ao).length === 1 && ev(ao)[0].src === 'fallback' && ev(ao)[0].age > 5000, JSON.stringify(ev(ao)));
}

// =============================== P1.1 (trace mode) ======================================
// (appended below)

if (failed) {
  console.error('connector-test: FAILED');
  process.exit(1);
}
console.log('connector-test: all checks passed');
