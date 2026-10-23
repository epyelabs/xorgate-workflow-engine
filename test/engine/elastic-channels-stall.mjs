#!/usr/bin/env node
// Runtime tests for 0.5.1's elastic channels and stall detector (plan
// workflow-engine-improvements P0.1 + P0.2). Hermetic: HERE is mocked through
// the httpFetch seam, telemetry is synthetic and inline, no network.
//
// The five FINDINGS 1.5 cases on the production overspeed shape
// (src -> rs (10 s resample) -> roads (HERE) -> cmp.reference, rs -> cmp.signal,
// roads -> cap, cmp -> deb -> evt) over a 30 min drive at 1 Hz (179 grid ticks):
// every one must succeed under the default elastic channels; under
// channelMode 'bounded' the deadlocking ones must fail with "Graph stalled"
// naming both sides of the cycle, within stallMs. Run `npm run build` first.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { runGraph, createCatalog, corePacks, defineNode, createEngine, engineResultSchema } = await import(
  join(root, 'dist/esm/index.js')
);
const { localHost } = await import(join(root, 'dist/esm/local/index.js'));
// The connector paces provider requests (0.5.1: HERE 5/s). These cases are
// about channels and stalls, not pacing, and their timing bounds assume
// lookups answer at once: neutralize the pacing sleep through the
// connector's clock seam (the same ESM module instance the catalog runs).
const { connectorClock } = await import(join(root, 'dist/esm/catalog/nodes/connector-third-party.js'));
connectorClock.sleep = async () => {};

let failed = false;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

// --- the synthetic drive ---------------------------------------------------------
const T0 = 1786578960000; // aligned to the 10 s grid
const SAMPLES = 1800; // 30 min at 1 Hz -> 179 grid ticks (the resampler emits a tick once a later sample crosses it)
const TICKS = 179;
// Two overspeed episodes (80 kph against a 60 limit): ticks 5..10 and 100..109.
const speeding = (i) => (i >= 50 && i < 110) || (i >= 1000 && i < 1100);
const drive = Array.from({ length: SAMPLES }, (_, i) => ({
  ts: T0 + i * 1000,
  signals: {
    speed_kph: speeding(i) ? 80 : 50,
    'gps.latitude': 43.6 + i * 0.0001, // ~11 m/s: every 10 s tick is a new 4-dp position
    'gps.longitude': -79.55,
  },
}));

const overspeedGraph = (maxLookupsPerRun = 500) => ({
  schemaVersion: 2,
  nodes: [
    { id: 'src', type: 'source.telemetry', position: { x: 0, y: 0 }, data: { label: 'Telemetry', config: { metrics: ['speed_kph', 'gps.latitude', 'gps.longitude'] } } },
    { id: 'rs', type: 'telemetry.resample', position: { x: 0, y: 0 }, data: { label: 'Resample', config: { intervalSeconds: 10 } } },
    { id: 'roads', type: 'connector.third_party', position: { x: 0, y: 0 }, data: { label: 'Connector (HERE)', config: { provider: 'here', maxLookupsPerRun } } },
    { id: 'cmp', type: 'logic.comparator', position: { x: 0, y: 0 }, data: { label: 'Comparator', config: { field: 'speedLimitKph', signal: 'speed_kph', operator: 'gt' } } },
    { id: 'deb', type: 'logic.debounce', position: { x: 0, y: 0 }, data: { label: 'Debounce', config: { minDurationMs: 5000, cooldownMs: 0 } } },
    { id: 'evt', type: 'output.event', position: { x: 0, y: 0 }, data: { label: 'Emit Event', config: { kind: 'overspeed' } } },
    { id: 'cap', type: 'output.data_capture', position: { x: 0, y: 0 }, data: { label: 'Speed limits', config: { format: 'jsonl' } } },
  ],
  edges: [
    { id: 'e1', source: 'src', target: 'rs', sourceHandle: 'telemetry', targetHandle: 'telemetry' },
    { id: 'e2', source: 'rs', target: 'roads', sourceHandle: 'telemetry', targetHandle: 'positions' },
    { id: 'e3', source: 'rs', target: 'cmp', sourceHandle: 'telemetry', targetHandle: 'signal' },
    { id: 'e4', source: 'roads', target: 'cmp', sourceHandle: 'speed_limit', targetHandle: 'reference' },
    { id: 'e5', source: 'roads', target: 'cap', sourceHandle: 'speed_limit', targetHandle: 'records' },
    { id: 'e6', source: 'cmp', target: 'deb', sourceHandle: 'condition', targetHandle: 'condition' },
    { id: 'e7', source: 'deb', target: 'evt', sourceHandle: 'condition', targetHandle: 'condition' },
  ],
});

// Mocked HERE route matching: lookup k (0-based, in call order) is unanswered
// when k is in [silentFrom, silentFrom + silentCount); otherwise 60 kph.
function hereMock({ silentFrom = 0, silentCount = 0 } = {}) {
  const calls = { n: 0 };
  const answered = JSON.stringify({ response: { route: [{ leg: [{ link: [{ attributes: { SPEED_LIMITS_FCN: [{ FROM_REF_SPEED_LIMIT: '60' }] } }] }] }] } });
  const empty = JSON.stringify({ response: { route: [] } });
  const fetch = async () => {
    const k = calls.n++;
    const silent = k >= silentFrom && k < silentFrom + silentCount;
    return new Response(silent ? empty : answered, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetch };
}

async function runCase({ name, mock, maxLookupsPerRun, mode = 'batch', deps = {} }) {
  const http = hereMock(mock);
  const logs = [];
  const started = Date.now();
  const outcome = await runGraph(
    { runId: `rt-${name}`, mode, deviceId: null, window: null, definition: overspeedGraph(maxLookupsPerRun), bindings: { src: { kind: 'telemetry_inline', samples: drive } } },
    {
      sources: { readTelemetryWindow: async () => [] },
      secrets: { getSecret: async () => 'fake-here-key' },
      httpFetch: http.fetch,
      log: (m, level) => logs.push(`${level} ${m}`),
      ...deps,
    },
  );
  const step = (id) => outcome.steps.find((s) => s.nodeId === id);
  const edge = (id) => outcome.channels?.find((c) => c.edgeId === id);
  return { outcome, lookups: http.calls.n, logs, ms: Date.now() - started, step, edge };
}

// --- P0.1: the five FINDINGS 1.5 cases succeed under elastic channels -------------
const CASES = [
  // [name, mock, maxLookupsPerRun, expected lookups, expected events, deadlocks when bounded]
  ['25 unanswered from tick 20', { silentFrom: 20, silentCount: 25 }, 500, TICKS, 2, false],
  ['60 unanswered from tick 20', { silentFrom: 20, silentCount: 60 }, 500, TICKS, 2, true],
  ['40 unanswered from tick 0', { silentFrom: 0, silentCount: 40 }, 500, TICKS, 1, true],
  ['lookup cap 100, all answered', {}, 100, 100, 2, true],
  // The FINDINGS row with capacity 1,000,000: what elastic now does by default.
  ['60 unanswered from tick 20 (capacity 1e6)', { silentFrom: 20, silentCount: 60 }, 500, TICKS, 2, false, { channelMode: 'bounded', channelCapacity: 1_000_000 }],
];

for (const [name, mock, cap, lookups, eventsWanted, , deps] of CASES) {
  const r = await runCase({ name, mock, maxLookupsPerRun: cap, deps });
  const o = r.outcome;
  check(
    `elastic: ${name} succeeds with ${lookups} lookups and ${eventsWanted} event(s)`,
    o.status === 'succeeded' && r.lookups === lookups && o.events.length === eventsWanted && o.events.every((e) => e.kind === 'overspeed' && e.nodeId === 'evt') && o.steps.every((s) => s.status === 'ok'),
    `${o.status} ${o.error ?? ''}; ${r.lookups} lookups, ${o.events.length} events, steps ${o.steps.map((s) => `${s.nodeId}:${s.status}`).join(',')}`,
  );
  if (cap === 100) {
    check('elastic: the lookup cap reports the capped ticks', /100 lookup\(s\), 79 skipped by lookup cap/.test(r.step('roads')?.output ?? ''), r.step('roads')?.output);
  }
  if (!deps) {
    const e3 = r.edge('e3');
    check(
      `elastic: ${name}: telemetry/json/condition edges are unbounded, nothing waits (rs -> cmp maxDepth ${e3?.maxDepth})`,
      r.outcome.channels.length === 7 && r.outcome.channels.every((c) => c.policy === 'unbounded' && c.capacity === Infinity) && (!mock.silentCount || e3.maxDepth > 32 || mock.silentCount <= 32),
      JSON.stringify(r.outcome.channels.map((c) => [c.edgeId, c.policy, c.maxDepth])),
    );
  }
}

// Debug log: the channel policy line and one maxDepth line per edge.
{
  const r = await runCase({ name: 'debug-log', mock: { silentFrom: 20, silentCount: 60 } });
  check(
    'debug log names the channel policy and every edge maxDepth',
    r.logs.includes('debug channels (batch, elastic): 7 unbounded') &&
      r.logs.filter((l) => /^debug channel e\d (\S+) -> (\S+) \((telemetry|json|condition), unbounded\): maxDepth \d+$/.test(l)).length === 7,
    r.logs.filter((l) => l.includes('channel')).join(' | '),
  );
}

// simulation mode is elastic too.
{
  const r = await runCase({ name: 'simulation', mock: { silentFrom: 20, silentCount: 60 }, mode: 'simulation' });
  check('elastic: simulation mode runs the 60-tick case to success', r.outcome.status === 'succeeded' && r.lookups === TICKS && r.outcome.channels.every((c) => c.policy === 'unbounded'), `${r.outcome.error} ${r.lookups}`);
}

// --- live mode is unchanged ----------------------------------------------------------
{
  const r = await runCase({ name: 'live-ok', mock: { silentFrom: 20, silentCount: 25 }, mode: 'live' });
  check(
    'live: non-frames edges still block at 32 (the 25-tick case fits) and channelMode does not apply',
    r.outcome.status === 'succeeded' && r.outcome.channels.every((c) => c.policy === 'block' && c.capacity === 32 && c.maxDepth <= 32) && r.logs.includes('debug channels (live): 7 block@32'),
    JSON.stringify(r.outcome.channels?.map((c) => [c.edgeId, c.policy, c.maxDepth])),
  );
  const s = await runCase({ name: 'live-stall', mock: { silentFrom: 20, silentCount: 60 }, mode: 'live', deps: { stallMs: 300 } });
  check(
    'live: the 60-tick case still deadlocks as before (now caught by the stall detector)',
    s.outcome.status === 'failed' && s.outcome.error.startsWith('Graph stalled: ') && s.outcome.error.includes('cmp waiting on roads (0 queued)') && s.outcome.error.includes('rs blocked pushing to cmp (32/32)'),
    s.outcome.error,
  );
}

// --- P0.2: bounded channels + the stall detector ------------------------------------
for (const [name, mock, cap, , , deadlocks] of CASES.slice(0, 4)) {
  const stallMs = 400;
  const r = await runCase({ name: `bounded-${name}`, mock, maxLookupsPerRun: cap, deps: { channelMode: 'bounded', stallMs } });
  const o = r.outcome;
  if (!deadlocks) {
    check(`bounded: ${name} still succeeds (fits in 32)`, o.status === 'succeeded', o.error);
    continue;
  }
  check(
    `bounded: ${name} fails as a stall within stallMs (+ check interval), naming cmp and rs`,
    o.status === 'failed' &&
      o.failedNodeId === null &&
      /^Graph stalled: /.test(o.error) &&
      o.error.includes('cmp waiting on roads (0 queued)') &&
      o.error.includes('rs blocked pushing to cmp (32/32)') &&
      /\(no progress for \d+ s\)$/.test(o.error) &&
      r.ms < 5000,
    `${r.ms} ms: ${o.error}`,
  );
  check(
    `bounded: ${name}: every still-running node is cancelled with its own wait, none skipped`,
    o.steps.every((s) => s.status === 'cancelled') &&
      r.step('cmp').output.startsWith('cancelled: graph stalled while waiting on roads (0 queued)') &&
      r.step('rs').output.startsWith('cancelled: graph stalled while blocked pushing to cmp (32/32)'),
    o.steps.map((s) => `${s.nodeId}:${s.status}:${s.output}`).join(' | '),
  );
}

// The default stallMs (30 s) on the 40-tick case: fails within the window, not at a deadline.
const defaultStall = (async () => {
  const r = await runCase({ name: 'bounded-default-stall', mock: { silentFrom: 0, silentCount: 40 }, deps: { channelMode: 'bounded' } });
  // Detection lands between stallMs and stallMs + two check intervals (2 s each).
  check(
    `bounded: the default stallMs fails the deadlock in 30-34 s (took ${(r.ms / 1000).toFixed(1)} s)`,
    r.outcome.status === 'failed' && r.outcome.error.startsWith('Graph stalled: ') && r.outcome.error.includes('cmp waiting on roads') && r.outcome.error.includes('rs blocked pushing to cmp') && r.ms >= 30_000 && r.ms < 34_500,
    r.outcome.error,
  );
})();

// --- deadline: running nodes are `cancelled`, not `skipped (upstream failure)` --------
{
  const r = await runCase({ name: 'deadline', mock: { silentFrom: 20, silentCount: 60 }, deps: { channelMode: 'bounded', stallMs: 0, deadlineMs: 500 } });
  const o = r.outcome;
  check(
    'deadline: fails "Run exceeded its max runtime"; the earlier event is kept',
    o.status === 'failed' && o.error === 'Run exceeded its max runtime' && o.failedNodeId === null && o.events.length === 1,
    `${o.status} ${o.error} events=${o.events.length}`,
  );
  check(
    'deadline: still-running steps are cancelled with the reason and their wait',
    o.steps.every((s) => s.status === 'cancelled' && s.output.startsWith('cancelled: run exceeded its max runtime (500 ms) while ')) &&
      r.step('cmp').output.includes('while waiting on roads (0 queued)') &&
      r.step('rs').output.includes('while blocked pushing to cmp (32/32)'),
    o.steps.map((s) => `${s.nodeId}:${s.status}:${s.output}`).join(' | '),
  );
}

// A failure still skips its descendants (unchanged), and the run is not a stall.
{
  const fetch = async () => new Response('{"error":"nope"}', { status: 403 });
  const outcome = await runGraph(
    { runId: 'rt-fail', mode: 'batch', deviceId: null, window: null, definition: overspeedGraph(), bindings: { src: { kind: 'telemetry_inline', samples: drive } } },
    { sources: { readTelemetryWindow: async () => [] }, secrets: { getSecret: async () => 'k' }, httpFetch: fetch, log: () => {}, stallMs: 200 },
  );
  const st = Object.fromEntries(outcome.steps.map((s) => [s.nodeId, s]));
  check(
    'failure: a failing connector still skips cmp/deb/evt/cap as "skipped (upstream failure)"',
    outcome.status === 'failed' && outcome.failedNodeId === 'roads' && ['cmp', 'deb', 'evt', 'cap'].every((id) => st[id].status === 'skipped' && st[id].output === 'skipped (upstream failure)') && st.src.status === 'ok' && st.rs.status === 'ok',
    outcome.steps.map((s) => `${s.nodeId}:${s.status}`).join(','),
  );
}

// A busy node (a slow HTTP answer) is not a stall, however long it takes.
{
  let n = 0;
  const answered = JSON.stringify({ response: { route: [{ leg: [{ link: [{ attributes: { SPEED_LIMITS_FCN: [{ FROM_REF_SPEED_LIMIT: '60' }] } }] }] }] } });
  const fetch = async () => {
    if (n++ === 3) await new Promise((r) => setTimeout(r, 600)); // one lookup outlasts stallMs
    return new Response(answered, { status: 200 });
  };
  const outcome = await runGraph(
    { runId: 'rt-busy', mode: 'batch', deviceId: null, window: null, definition: overspeedGraph(), bindings: { src: { kind: 'telemetry_inline', samples: drive } } },
    { sources: { readTelemetryWindow: async () => [] }, secrets: { getSecret: async () => 'k' }, httpFetch: fetch, log: () => {}, channelMode: 'bounded', stallMs: 100 },
  );
  check('busy: a node parked in its own await (a 600 ms lookup, stallMs 100) is not a stall', outcome.status === 'succeeded', outcome.error);
}

// --- frames edges keep backpressure ----------------------------------------------------
// A test pack: `rtx.burst` emits N frames and N json records as fast as it can;
// `rtx.slow` reads every frame first (one macrotask each), then the records.
const N = 300;
const burst = {
  def: defineNode({
    type: 'rtx.burst', version: 1, group: 'source', label: 'Burst', description: 'test', ui: { icon: 'zap' },
    inputs: [],
    outputs: [
      { id: 'frames', label: 'Frames', channel: 'frames', cardinality: 'many', required: false },
      { id: 'records', label: 'Records', channel: 'json', tag: 'rec', cardinality: 'many', required: false },
    ],
    config: z.object({}), requires: [], runtime: { target: 'any' },
  }),
  executor: async function* (_inputs, _config, ctx) {
    for (let i = 0; i < N; i++) {
      yield { ch: 'json', port: 'records', ts: T0 + i, payload: { i } };
      yield { ch: 'frames', port: 'frames', ts: T0 + i, payload: { i } };
    }
    ctx.setSummary(`${N} frames`);
  },
};
const slow = {
  def: defineNode({
    type: 'rtx.slow', version: 1, group: 'output', label: 'Slow', description: 'test', ui: { icon: 'turtle' },
    inputs: [
      { id: 'frames', label: 'Frames', channel: 'frames', cardinality: 'one', required: true },
      { id: 'records', label: 'Records', channel: 'json', cardinality: 'one', required: true },
    ],
    outputs: [],
    config: z.object({}), requires: [], runtime: { target: 'any' },
  }),
  executor: async function* (inputs, _config, ctx) {
    let frames = 0;
    let records = 0;
    for await (const _m of inputs.find((i) => i.port === 'frames').messages) {
      frames += 1;
      await new Promise((r) => setImmediate(r));
    }
    for await (const _m of inputs.find((i) => i.port === 'records').messages) records += 1;
    ctx.setSummary(`${frames} frames, ${records} records`);
  },
};
const testCatalog = createCatalog([...corePacks, { name: 'rt-test-pack', version: '1.0.0', nodes: [burst, slow] }]);
const framesGraph = {
  schemaVersion: 2,
  nodes: [
    { id: 'b', type: 'rtx.burst', position: { x: 0, y: 0 }, data: { label: 'Burst', config: {} } },
    { id: 's', type: 'rtx.slow', position: { x: 0, y: 0 }, data: { label: 'Slow', config: {} } },
  ],
  edges: [
    { id: 'f', source: 'b', target: 's', sourceHandle: 'frames', targetHandle: 'frames' },
    { id: 'j', source: 'b', target: 's', sourceHandle: 'records', targetHandle: 'records' },
  ],
};
const runFrames = (mode, deps = {}) =>
  runGraph(
    { runId: `rt-frames-${mode}`, mode, deviceId: null, window: null, definition: framesGraph, bindings: {} },
    { sources: { readTelemetryWindow: async () => [] }, catalog: testCatalog, log: () => {}, ...deps },
  );
{
  const o = await runFrames('batch');
  const f = o.channels.find((c) => c.edgeId === 'f');
  const j = o.channels.find((c) => c.edgeId === 'j');
  check(
    `frames (batch, elastic): the frames edge still blocks (maxDepth ${f?.maxDepth} <= 32) while the json edge buffers (${j?.maxDepth})`,
    o.status === 'succeeded' && f.policy === 'block' && f.capacity === 32 && f.maxDepth <= 32 && f.maxDepth > 0 && j.policy === 'unbounded' && j.maxDepth > 32 && o.steps.find((s) => s.nodeId === 's').output === `${N} frames, ${N} records`,
    `${o.status} ${o.error ?? ''} ${JSON.stringify(o.channels)}`,
  );
  const b = await runFrames('batch', { channelMode: 'bounded', stallMs: 200 });
  check(
    'frames (batch, bounded): the same graph stalls, and the error names both sides',
    b.status === 'failed' && b.error.startsWith('Graph stalled: ') && b.error.includes('b blocked pushing to s (32/32)') && b.error.includes('s waiting on b (into frames) (0 queued)'),
    b.error,
  );
  const l = await runFrames('live', { stallMs: 200 });
  const lf = l.channels.find((c) => c.edgeId === 'f');
  check(
    'frames (live): frames drop oldest at 32, json still blocks (unchanged)',
    lf.policy === 'drop-oldest' && lf.maxDepth <= 32 && l.channels.find((c) => c.edgeId === 'j').policy === 'block',
    JSON.stringify(l.channels),
  );
}

// --- createEngine passes channelMode / stallMs through; result.json carries `cancelled` --
{
  const dir = mkdtempSync(join(tmpdir(), 'xwe-rt-'));
  const csv = join(dir, 'drive.csv');
  writeFileSync(csv, 'ts,speed_kph,gps.latitude,gps.longitude\n' + drive.map((s) => `${s.ts},${s.signals.speed_kph},${s.signals['gps.latitude']},${s.signals['gps.longitude']}`).join('\n') + '\n');
  const template = overspeedGraph();
  const runWith = async (runId, options) => {
    const http = hereMock({ silentFrom: 20, silentCount: 60 });
    const local = localHost({ outDir: dir, baseDir: root });
    const host = { bind: async (a) => ({ ...(await local.bind(a)), httpFetch: http.fetch }) };
    return createEngine({ host }).run({ template, inputs: { telemetry: csv }, runId, secrets: { 'here-api-key': 'k' }, ...options });
  };
  const ok = await runWith('rt-lib-elastic', {});
  check('createEngine: the 60-tick case succeeds by default (elastic)', ok.result.status === 'succeeded' && ok.result.events.length === 2, ok.result.error);
  const bad = await runWith('rt-lib-bounded', { channelMode: 'bounded', stallMs: 300 });
  const written = JSON.parse(readFileSync(join(dir, 'rt-lib-bounded', 'result.json'), 'utf8'));
  check(
    'createEngine: channelMode/stallMs reach the engine; result.json has cancelled steps, parses, and keeps its keys',
    bad.result.status === 'failed' && bad.result.error.startsWith('Graph stalled: ') && written.steps.some((s) => s.status === 'cancelled') && engineResultSchema.safeParse(written).success &&
      JSON.stringify(Object.keys(written)) === JSON.stringify(Object.keys(ok.result)) && !('channels' in written) && JSON.stringify(Object.keys(written.metrics)) === JSON.stringify(['nodes', 'okSteps', 'events', 'messages']),
    `${bad.result.error} keys=${Object.keys(written)}`,
  );
}

await defaultStall;
console.log(failed ? '\nruntime tests: FAILED' : '\nruntime tests: all passed');
process.exit(failed ? 1 : 0);
