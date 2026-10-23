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

/** Synthetic HERE: one link per matched point; link ids carry the chunk number and point index. */
function mockHere({ unmatched = () => false, limitFor = () => 50, bodies = [], urls = [], fail = () => null } = {}) {
  let chunkNo = 0;
  return async (url, init) => {
    const body = String(init.body);
    bodies.push(body);
    urls.push(String(url));
    const k = chunkNo++;
    const failure = fail(k);
    if (failure) return failure;
    const [, ...lines] = body.trim().split('\n');
    const pts = lines.map((l) => { const [lat, lon, iso] = l.split(','); return { lat: Number(lat), lon: Number(lon), ts: Date.parse(iso) }; });
    const links = [];
    const waypoint = [];
    pts.forEach((p, i) => {
      if (unmatched(p)) return;
      const linkId = `+c${k}p${i}`;
      const limit = limitFor(p);
      links.push({ linkId, attributes: { SPEED_LIMITS_FCN: limit === null ? [] : [{ FROM_REF_SPEED_LIMIT: String(limit), TO_REF_SPEED_LIMIT: '0', UNIT: 'K' }] } });
      waypoint.push({ linkId, routeLinkSeqNrMatched: links.length - 1, timestamp: p.ts, confidenceValue: 0.9 });
    });
    return json({ response: { route: [{ waypoint, leg: [{ link: links }] }], warnings: [] } });
  };
}
const traceCfg = (extra = {}) => ({ provider: 'here', lookupMode: 'trace', ...extra });
const csvSamples = (p) => {
  const [head, ...lines] = readFileSync(join(root, p), 'utf8').trim().split('\n');
  const cols = head.split(',');
  return lines.map((l) => { const v = l.split(',').map(Number); return { ts: v[0], signals: Object.fromEntries(cols.slice(1).map((c, i) => [c, v[i + 1]])) }; });
};

// --- request shape and the intersection fixture -------------------------------------
{
  const tpl = readJson('fixtures/templates/overspeed-here-trace.json');
  const fixture = readJson('fixtures/connector/here-routematch-intersection.json');
  const samples = csvSamples('fixtures/telemetry/intersection-trace.csv');
  const bodies = [];
  const urls = [];
  const inits = [];
  useVirtualClock();
  const r = await run(tpl, samples, async (url, init) => { urls.push(String(url)); bodies.push(String(init.body)); inits.push(init); return json(fixture); }, { channelCapacity: BIG_CAPACITY });
  realClock();
  const u = new URL(urls[0] ?? 'http://x/');
  const rows = (bodies[0] ?? '').trim().split('\n');
  check('trace request: one POST to /v8/match/routelinks with apikey, routeMatch=1, car mode and SPEED_LIMITS_FCn(*), text/plain body', urls.length === 1 && u.origin + u.pathname === 'https://routematching.hereapi.com/v8/match/routelinks' && u.searchParams.get('routeMatch') === '1' && u.searchParams.get('mode') === 'fastest;car;traffic:disabled' && u.searchParams.get('attributes') === 'SPEED_LIMITS_FCn(*)' && u.searchParams.has('apikey') && inits[0].method === 'POST' && inits[0].headers['Content-Type'] === 'text/plain', urls[0]);
  check('trace request: CSV trace latitude,longitude,timestamp,heading,speed_kmh with ISO 8601 UTC timestamps, one row per sample', rows[0] === 'latitude,longitude,timestamp,heading,speed_kmh' && rows.length === 16 && rows[1] === '43.660990,-79.531085,2026-10-17T20:36:40.000Z,90,45', rows.slice(0, 2).join(' | '));
  const recs = r.records;
  check('trace intersection fixture: 15 records in ts order, every one matched to the arterial at 50 (no side-street flip to 30, direction-aware FROM/TO pick)', r.outcome.status === 'succeeded' && recs.length === 15 && recs.every((x, i) => x.ts === samples[i].ts && x.speedLimitKph === 50 && x.matched === true && x.source === 'here') && recs.slice(0, 7).every((x) => x.linkId === '+1197711001') && recs.slice(7).every((x) => x.linkId === '-1197711002'), `${r.outcome.error} ${JSON.stringify(recs.map((x) => [x.speedLimitKph, x.linkId]))}`);
  check('trace intersection fixture: comparator at 1 Hz true on 0/15, no event; summary names the trace', /^true on 0\/15 samples/.test(r.step('cmp').output) && r.outcome.events.length === 0 && /^15 speed-limit record\(s\) via here \(trace\), 1 lookup\(s\), 15\/15 trace point\(s\) matched in 1 chunk\(s\)$/.test(r.step('roads').output), `${r.step('cmp').output} | ${r.step('roads').output}`);
  check('parseHereTraceResponse reads a top-level route (OpenAPI shape) like the response wrapper', JSON.stringify(conn.parseHereTraceResponse(fixture.response, samples)) === JSON.stringify(conn.parseHereTraceResponse(fixture, samples)));
  check('hereLinkSpeedLimit: mph rows convert, 0 / 999 are no limit, the other direction answers when the driven one is empty', conn.hereLinkSpeedLimit({ linkId: '7', attributes: { SPEED_LIMITS_FCN: [{ FROM_REF_SPEED_LIMIT: '35', UNIT: 'M' }] } }) === 56 && conn.hereLinkSpeedLimit({ linkId: '7', attributes: { SPEED_LIMITS_FCN: [{ FROM_REF_SPEED_LIMIT: '999', TO_REF_SPEED_LIMIT: '0' }] } }) === null && conn.hereLinkSpeedLimit({ linkId: '-7', attributes: { SPEED_LIMITS_FCN: [{ FROM_REF_SPEED_LIMIT: '60', TO_REF_SPEED_LIMIT: null }] } }) === 60);
}

// --- chunk boundaries with overlap ------------------------------------------------------
{
  const plan = conn.planTraceChunks(25, 10, 4);
  check('planTraceChunks(25, 10, 4): sends [0,10) [6,16) [12,22) [18,25), answers [0,8) [8,14) [14,20) [20,25)', JSON.stringify(plan.map((c) => [c.start, c.end, c.ownFrom, c.ownTo])) === JSON.stringify([[0, 10, 0, 8], [6, 16, 8, 14], [12, 22, 14, 20], [18, 25, 20, 25]]), JSON.stringify(plan));
  check('planTraceChunks: overlap is capped below half a chunk; one chunk when n fits; none for n 0', JSON.stringify(conn.planTraceChunks(10, 4, 50).map((c) => [c.start, c.end])) === JSON.stringify([[0, 4], [3, 7], [6, 10]]) && conn.planTraceChunks(1000, 1000, 10).length === 1 && conn.planTraceChunks(0, 10, 2).length === 0);
  useVirtualClock();
  const bodies = [];
  const samples = drive(25);
  const r = await run(connectorGraph(traceCfg({ traceChunkPoints: 10, traceOverlapPoints: 4 })), samples, mockHere({ bodies }), { channelCapacity: BIG_CAPACITY });
  realClock();
  const firstTs = bodies.map((b) => Date.parse(b.split('\n')[1].split(',')[2]) - samples[0].ts);
  const sizes = bodies.map((b) => b.trim().split('\n').length - 1);
  const owner = r.records.map((x) => x.linkId);
  const expected = samples.map((_, j) => { const k = j < 8 ? 0 : j < 14 ? 1 : j < 20 ? 2 : 3; return `+c${k}p${j - [0, 6, 12, 18][k]}`; });
  check('trace chunks: 4 requests whose bodies start at samples 0, 6, 12, 18 (overlap re-sent) with 10, 10, 10, 7 points', bodies.length === 4 && JSON.stringify(firstTs) === JSON.stringify([0, 6000, 12000, 18000]) && JSON.stringify(sizes) === JSON.stringify([10, 10, 10, 7]), `${firstTs} / ${sizes}`);
  check('trace chunks: every sample answered exactly once, in ts order, by the chunk that owns it (overlap split down the middle)', r.outcome.status === 'succeeded' && r.records.length === 25 && r.records.every((x, i) => x.ts === samples[i].ts) && JSON.stringify(owner) === JSON.stringify(expected), JSON.stringify(owner));
}

// --- unmatched points and samples without a position give null ---------------------------
{
  useVirtualClock();
  const samples = drive(20);
  samples[15] = { ts: samples[15].ts, signals: { 'gps.speed': 50 } }; // no position
  const lat5 = samples[5].signals['gps.lat'];
  const lat9 = samples[9].signals['gps.lat'];
  const r = await run(connectorGraph(traceCfg()), samples, mockHere({ unmatched: (p) => p.lat >= lat5 - 1e-7 && p.lat <= lat9 + 1e-7, limitFor: (p) => (p.lat > samples[17].signals['gps.lat'] - 1e-7 ? null : 60) }), { channelCapacity: BIG_CAPACITY });
  realClock();
  const shape = r.records.map((x) => (x.speedLimitKph === null ? `${x.reason}:${x.matched}` : x.speedLimitKph)).join(',');
  const want = [...Array(5).fill(60), ...Array(5).fill('no_answer:false'), ...Array(5).fill(60), 'no_position:false', 60, 'no_answer:true', 'no_answer:true', 'no_answer:true'].join(',');
  check('trace unmatched: points HERE did not match (fewer waypoints, paired by timestamp) and samples without a position emit null; a matched link without a limit is null with matched true', r.outcome.status === 'succeeded' && r.records.length === 20 && shape === want, shape);
  check('trace unmatched: the summary counts matched points and null records', /^11 speed-limit record\(s\) via here \(trace\), 1 lookup\(s\), 9 null record\(s\), 8 without coverage.*, 1 without position, 14\/19 trace point\(s\) matched in 1 chunk\(s\)$/.test(r.step('roads').output), r.step('roads').output);
}

// --- the 429 path, chunk failures and the request cap --------------------------------------
{
  const clock = useVirtualClock();
  let n = 0;
  const here = mockHere();
  const r = await run(connectorGraph(traceCfg({ traceChunkPoints: 10, traceOverlapPoints: 2 })), drive(18), (url, init) => (++n === 1 ? json({ error: 'Too Many Requests' }, 429, { 'Retry-After': '1' }) : here(url, init)), { channelCapacity: BIG_CAPACITY });
  realClock();
  check('trace 429: the first chunk is retried after Retry-After 1 s, then both chunks answer', r.outcome.status === 'succeeded' && n === 3 && clock.sleeps.includes(1000) && r.records.length === 18 && r.records.every((x) => x.matched) && /, 2 lookup\(s\), 1 retry/.test(r.step('roads').output), `${r.outcome.error} | ${r.step('roads').output} | ${clock.sleeps}`);
}
{
  useVirtualClock();
  const failMid = (k) => (k === 1 ? json({ error: 'boom' }, 500) : null);
  const ok = await run(connectorGraph(traceCfg({ traceChunkPoints: 10, traceOverlapPoints: 0, onLookupError: 'skip', maxErrorRatio: 0.5, retry: { attempts: 1 } })), drive(30), mockHere({ fail: failMid }), { channelCapacity: BIG_CAPACITY });
  const shape = ok.records.map((x) => (x.speedLimitKph === null ? x.reason : 'ok'));
  check('trace chunk failure with skip: the run stays green, the failed chunk\'s samples are null (reason error)', ok.outcome.status === 'succeeded' && shape.length === 30 && shape.slice(10, 20).every((x) => x === 'error') && shape.slice(0, 10).concat(shape.slice(20)).every((x) => x === 'ok'), `${ok.outcome.error} ${shape}`);
  const tripped = await run(connectorGraph(traceCfg({ traceChunkPoints: 10, traceOverlapPoints: 0, onLookupError: 'skip', retry: { attempts: 1 } })), drive(30), mockHere({ fail: failMid }), { channelCapacity: BIG_CAPACITY });
  check('trace chunk failure with skip: 1 of 3 chunks > maxErrorRatio 0.2 fails the node at the end', tripped.outcome.status === 'failed' && /failing too often \(1\/3 > maxErrorRatio 0\.2\)/.test(tripped.outcome.error), tripped.outcome.error);
  const failed = await run(connectorGraph(traceCfg({ traceChunkPoints: 10, traceOverlapPoints: 0, retry: { attempts: 1 } })), drive(30), mockHere({ fail: failMid }), { channelCapacity: BIG_CAPACITY });
  check('trace chunk failure with fail (default): the node fails naming the chunk', failed.outcome.status === 'failed' && /HERE trace request failed \(HTTP 500, points 10-19\)/.test(failed.outcome.error), failed.outcome.error);
  const bodies = [];
  const capped = await run(connectorGraph(traceCfg({ traceChunkPoints: 10, traceOverlapPoints: 4, maxLookupsPerRun: 2 })), drive(25), mockHere({ bodies }), { channelCapacity: BIG_CAPACITY });
  const reasons = capped.records.map((x) => x.reason ?? 'ok');
  check('trace cap: maxLookupsPerRun counts requests; samples owned by unsent chunks are null (reason capped)', capped.outcome.status === 'succeeded' && bodies.length === 2 && reasons.slice(0, 14).every((x) => x === 'ok') && reasons.slice(14).every((x) => x === 'capped') && /11 skipped by lookup cap/.test(capped.step('roads').output), `${reasons} | ${capped.step('roads').output}`);
  realClock();
}

// --- decimation of stationary points -----------------------------------------------------
{
  useVirtualClock();
  const parked = Array.from({ length: 10 }, (_, i) => ({ ts: 1_792_000_000_000 + i * 1000, signals: { 'gps.lat': 43.65 + (i % 2) * 0.00001, 'gps.lon': -79.5, 'gps.speed': 0 } }));
  const moving = drive(10, { t0: 1_792_000_010_000, lat0: 43.6502 });
  const bodies = [];
  const r = await run(connectorGraph(traceCfg({ traceMinSpacingM: 5 })), [...parked, ...moving], mockHere({ bodies }), { channelCapacity: BIG_CAPACITY });
  realClock();
  const sent = bodies[0].trim().split('\n').length - 1;
  check('traceMinSpacingM 5: ten parked samples (1 m jitter) are sent as one point and all take its answer; moving samples are all sent', r.outcome.status === 'succeeded' && sent === 11 && r.records.length === 20 && r.records.slice(0, 10).every((x) => x.linkId === '+c0p0') && new Set(r.records.slice(10).map((x) => x.linkId)).size === 10, `sent=${sent} ${JSON.stringify(r.records.map((x) => x.linkId))}`);
}

// --- where trace mode does not run ---------------------------------------------------------
{
  const live = await run(connectorGraph(traceCfg()), drive(3), mockHere(), { mode: 'live' });
  check('trace in a live run fails at start with a clear message (batch and simulation only)', live.outcome.status === 'failed' && /lookupMode 'trace' collects the whole input before matching it, so it runs in batch and simulation runs only/.test(live.outcome.error), live.outcome.error);
  const osm = await run(connectorGraph({ provider: 'osm', lookupMode: 'trace' }), drive(3), mockHere());
  check('trace with a provider other than HERE fails at start', osm.outcome.status === 'failed' && /supports provider 'here' only \(got 'osm'\)/.test(osm.outcome.error), osm.outcome.error);
}

// --- a 1 h drive, production-shaped graph, mocked HERE ---------------------------------------
{
  const tpl = readJson('fixtures/templates/overspeed-here-trace.json');
  // 3600 samples at 1 Hz; 60 km/h for two minutes in every ten (limit 50), else 40.
  const samples = Array.from({ length: 3600 }, (_, s) => ({ ts: 1_792_000_000_000 + s * 1000, signals: { 'gps.lat': 43.6 + s * 0.00011, 'gps.lon': -79.5, 'gps.speed': s % 600 < 120 ? 60 : 40, 'gps.heading': 0 } }));
  const bodies = [];
  const started = Date.now();
  const r = await run(tpl, samples, mockHere({ bodies }), { channelCapacity: BIG_CAPACITY });
  const ms = Date.now() - started;
  console.log(`     (1 h trace drive wall time: ${ms} ms)`);
  check('1 h drive (3600 samples): 4 chunk requests instead of ~360 point lookups, 3600 records, 6 overspeed events, well under 5 s', r.outcome.status === 'succeeded' && bodies.length === 4 && r.records.length === 3600 && r.outcome.events.length === 6 && ms < 5000, `${ms} ms, ${bodies.length} requests, ${r.records.length} records, ${r.outcome.events.length} events, ${r.outcome.error}`);
}

if (failed) {
  console.error('connector-test: FAILED');
  process.exit(1);
}
console.log('connector-test: all checks passed');
