#!/usr/bin/env node
// Runtime tests for 0.5.3's external cancel seam: `runGraph(spec, { signal })`
// and `engine.run({ signal })`. Hermetic (a test pack, no network, no media).
// An abort mid-run stops every still-running node through the deadline /
// stall-detector path (`cancelled` steps), resolves `failed` with
// `Run cancelled` and `cancelled: true`, and clears the deadline timer and
// the stall detector; a pre-aborted signal refuses the run; a late abort is a
// no-op. Run `npm run build` first.
import { getEventListeners } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { runGraph, createCatalog, corePacks, defineNode, createEngine, engineResultSchema, RUN_CANCELLED_ERROR, XweUsageError } =
  await import(join(root, 'dist/esm/index.js'));
const { localHost } = await import(join(root, 'dist/esm/local/index.js'));

let failed = false;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

// --- a test pack: `abx.tick` yields `count` records, one every `everyMs`
// (busy in its own await between yields); `abx.sink` drains its input. -------
const started = { tick: 0, sink: 0 };
const tick = {
  def: defineNode({
    type: 'abx.tick', version: 1, group: 'source', label: 'Tick', description: 'test', ui: { icon: 'clock' },
    inputs: [],
    outputs: [{ id: 'records', label: 'Records', channel: 'json', tag: 'rec', cardinality: 'many', required: false }],
    config: z.object({ count: z.number().int().default(1_000_000), everyMs: z.number().int().default(20) }),
    requires: [], runtime: { target: 'any' },
  }),
  executor: async function* (_inputs, config, ctx) {
    started.tick += 1;
    for (let i = 0; i < config.count; i++) {
      await sleep(config.everyMs);
      yield { ch: 'json', port: 'records', ts: 1786578960000 + i, payload: { i } };
    }
    ctx.setSummary(`${config.count} ticks`);
  },
};
const sink = {
  def: defineNode({
    type: 'abx.sink', version: 1, group: 'output', label: 'Sink', description: 'test', ui: { icon: 'inbox' },
    inputs: [{ id: 'records', label: 'Records', channel: 'json', cardinality: 'one', required: true }],
    outputs: [],
    config: z.object({}), requires: [], runtime: { target: 'any' },
  }),
  executor: async function* (inputs, _config, ctx) {
    started.sink += 1;
    let n = 0;
    for await (const _m of inputs[0].messages) n += 1;
    ctx.setSummary(`${n} records`);
  },
};
// `abx.relay` (for createEngine, whose local manifest wants a core source):
// sleeps `everyMs` per telemetry message, then counts it.
const relay = {
  def: defineNode({
    type: 'abx.relay', version: 1, group: 'output', label: 'Relay', description: 'test', ui: { icon: 'clock' },
    inputs: [{ id: 'telemetry', label: 'Telemetry', channel: 'telemetry', cardinality: 'one', required: true }],
    outputs: [],
    config: z.object({ everyMs: z.number().int().default(20) }), requires: [], runtime: { target: 'any' },
  }),
  executor: async function* (inputs, config, ctx) {
    let n = 0;
    for await (const _m of inputs[0].messages) {
      await sleep(config.everyMs);
      n += 1;
    }
    ctx.setSummary(`${n} samples`);
  },
};
const catalog = createCatalog([...corePacks, { name: 'abort-test-pack', version: '1.0.0', nodes: [tick, sink, relay] }]);
const libGraph = {
  schemaVersion: 2,
  nodes: [
    { id: 'src', type: 'source.telemetry', position: { x: 0, y: 0 }, data: { label: 'Telemetry', config: { metrics: ['speed_kph'] } } },
    { id: 'r', type: 'abx.relay', position: { x: 0, y: 0 }, data: { label: 'Relay', config: {} } },
  ],
  edges: [{ id: 'e', source: 'src', target: 'r', sourceHandle: 'telemetry', targetHandle: 'telemetry' }],
};
const graph = (tickConfig = {}) => ({
  schemaVersion: 2,
  nodes: [
    { id: 't', type: 'abx.tick', position: { x: 0, y: 0 }, data: { label: 'Tick', config: tickConfig } },
    { id: 's', type: 'abx.sink', position: { x: 0, y: 0 }, data: { label: 'Sink', config: {} } },
  ],
  edges: [{ id: 'e', source: 't', target: 's', sourceHandle: 'records', targetHandle: 'records' }],
});
const run = (signal, deps = {}, tickConfig = {}) => {
  const logs = [];
  const t0 = Date.now();
  return runGraph(
    { runId: 'ab', mode: 'simulation', deviceId: null, window: null, definition: graph(tickConfig), bindings: {} },
    { sources: { readTelemetryWindow: async () => [] }, catalog, log: (m) => logs.push(m), ...(signal ? { signal } : {}), ...deps },
  ).then((outcome) => ({ outcome, logs, ms: Date.now() - t0, step: (id) => outcome.steps.find((s) => s.nodeId === id) }));
};

check('RUN_CANCELLED_ERROR is exported', RUN_CANCELLED_ERROR === 'Run cancelled');

// --- abort mid-run --------------------------------------------------------------
for (const [label, reason, expected] of [
  ['bare abort()', undefined, 'run cancelled'],
  ['a string reason', 'stopped by operator', 'stopped by operator'],
  ['an Error reason', new Error('cancel.json seen'), 'cancel.json seen'],
]) {
  const before = timeouts();
  const ac = new AbortController();
  // A long deadline and the default stall detector are both armed: abort must clear them.
  const pending = run(ac.signal, { deadlineMs: 60_000 });
  await sleep(150);
  if (reason === undefined) ac.abort();
  else ac.abort(reason);
  const r = await pending;
  const o = r.outcome;
  check(
    `mid-run (${label}): resolves failed, "Run cancelled", cancelled: true, within a yield`,
    o.status === 'failed' && o.error === 'Run cancelled' && o.cancelled === true && o.failedNodeId === null && r.ms < 1000,
    `${o.status} ${o.error} cancelled=${o.cancelled} ${r.ms} ms`,
  );
  check(
    `mid-run (${label}): every running node is cancelled with "cancelled: ${expected}"`,
    o.steps.length === 2 &&
      o.steps.every((s) => s.status === 'cancelled') &&
      r.step('t').output.startsWith(`cancelled: ${expected} (after `) &&
      r.step('s').output === `cancelled: ${expected}`,
    o.steps.map((s) => `${s.nodeId}:${s.status}:${s.output}`).join(' | '),
  );
  check(
    `mid-run (${label}): the deadline timer and the stall detector are cleared, the listener removed`,
    timeouts() <= before && getEventListeners(ac.signal, 'abort').length === 0 && r.logs.some((l) => l.startsWith(`run cancelled (${expected})`)),
    `timeouts ${before} -> ${timeouts()}, listeners ${getEventListeners(ac.signal, 'abort').length}`,
  );
}

// Abort while a deadline-free run is parked on a channel (the sink waits on t).
{
  const ac = new AbortController();
  const pending = run(ac.signal, { stallMs: 0 }, { everyMs: 5_000 });
  await sleep(100);
  ac.abort('parked');
  const r = await pending;
  check(
    'mid-run: a node parked on an empty channel is cancelled too; a busy one stops at its next await',
    r.outcome.cancelled === true && r.step('s').output === 'cancelled: parked' && r.step('t').status === 'cancelled',
    r.outcome.steps.map((s) => `${s.nodeId}:${s.status}:${s.output}`).join(' | '),
  );
}

// --- pre-aborted ---------------------------------------------------------------------
{
  const n0 = { ...started };
  const r = await run(AbortSignal.abort('too late'), { deadlineMs: 60_000 });
  const o = r.outcome;
  check(
    'pre-aborted: refused at once with the same failed result, no steps, no executor started',
    o.status === 'failed' && o.error === 'Run cancelled' && o.cancelled === true && o.steps.length === 0 &&
      started.tick === n0.tick && started.sink === n0.sink && r.ms < 100 && r.logs.some((l) => l === 'run cancelled before start (too late)'),
    `${o.status} ${o.error} steps=${o.steps.length} started=${JSON.stringify(started)} ${r.ms} ms`,
  );
}

// --- abort after completion -----------------------------------------------------------
{
  const ac = new AbortController();
  const r = await run(ac.signal, {}, { count: 3, everyMs: 5 });
  let threw = null;
  try {
    ac.abort('after the fact');
  } catch (err) {
    threw = err;
  }
  await sleep(20);
  const o = r.outcome;
  check(
    'late abort: harmless (no throw), the outcome stays succeeded, no listener left behind',
    threw === null && o.status === 'succeeded' && o.error === null && !('cancelled' in o) && o.steps.every((s) => s.status === 'ok') &&
      getEventListeners(ac.signal, 'abort').length === 0,
    `${o.status} ${o.error} threw=${threw}`,
  );
}

// An abort after the deadline already stopped the run keeps the deadline's verdict.
{
  const ac = new AbortController();
  const pending = run(ac.signal, { deadlineMs: 100, stallMs: 0 }, { everyMs: 300 });
  setTimeout(() => ac.abort('after the deadline'), 150);
  const r = await pending;
  await sleep(100);
  check(
    'deadline first: a later abort does not overwrite "Run exceeded its max runtime"',
    r.outcome.error === 'Run exceeded its max runtime' && !('cancelled' in r.outcome),
    `${r.outcome.error} cancelled=${r.outcome.cancelled}`,
  );
}

// Without a signal nothing changes.
{
  const r = await run(undefined, {}, { count: 3, everyMs: 5 });
  check('no signal: runs as before', r.outcome.status === 'succeeded' && !('cancelled' in r.outcome), r.outcome.error);
}

// --- createEngine: the option reaches the engine; result.json carries `cancelled` ----------
{
  const dir = mkdtempSync(join(tmpdir(), 'xwe-abort-'));
  const engine = createEngine({ host: localHost({ outDir: dir, baseDir: root }), catalog });
  const csv = (n) => {
    const file = join(dir, `drive-${n}.csv`);
    writeFileSync(file, 'ts,speed_kph\n' + Array.from({ length: n }, (_, i) => `${1786578960000 + i * 1000},50`).join('\n') + '\n');
    return { telemetry: file };
  };
  const short = csv(3);
  const long = csv(1800); // 1800 x 20 ms = 36 s if nothing stopped it
  const statuses = (msgs) => msgs.filter((m) => m.t === 'status').map((m) => m.status);

  const okMsgs = [];
  const ok = await engine.run({ template: libGraph, inputs: short, runId: 'ab-lib-ok', progress: (m) => okMsgs.push(m) });
  check('createEngine: a finite run still succeeds', ok.result.status === 'succeeded' && !('cancelled' in ok.result), ok.result.error);

  const ac = new AbortController();
  const msgs = [];
  const pending = engine.run({ template: libGraph, inputs: long, runId: 'ab-lib-mid', signal: ac.signal, deadlineMs: 60_000, progress: (m) => msgs.push(m) });
  setTimeout(() => ac.abort('stopped by operator'), 150);
  const mid = await pending;
  const written = JSON.parse(readFileSync(join(dir, 'ab-lib-mid', 'result.json'), 'utf8'));
  check(
    'createEngine mid-run: resolves (not rejects) failed + cancelled; result.json parses, adds only `cancelled`, the running node is cancelled',
    mid.result.status === 'failed' && mid.result.error === 'Run cancelled' && mid.result.cancelled === true && mid.outcome.cancelled === true &&
      written.cancelled === true && written.status === 'failed' && engineResultSchema.safeParse(written).success &&
      JSON.stringify(Object.keys(written).filter((k) => k !== 'cancelled')) === JSON.stringify(Object.keys(ok.result)) &&
      // The source already pushed its window (elastic edge) and finished ok; the relay was still running.
      written.steps.find((s) => s.nodeId === 'src')?.status === 'ok' &&
      written.steps.find((s) => s.nodeId === 'r')?.status === 'cancelled' &&
      written.steps.find((s) => s.nodeId === 'r')?.output.startsWith('cancelled: stopped by operator') &&
      mid.result.failedNodeId === null,
    `${mid.result.status} ${mid.result.error} keys=${Object.keys(written)} steps=${JSON.stringify(written.steps.map((s) => [s.nodeId, s.status, s.output]))}`,
  );
  check(
    'createEngine mid-run: progress reports running then failed with "Run cancelled"',
    JSON.stringify(statuses(msgs)) === '["running","failed"]' && msgs.at(-1).error === 'Run cancelled',
    JSON.stringify(statuses(msgs)),
  );

  const preMsgs = [];
  const pre = await engine.run({ template: libGraph, inputs: long, runId: 'ab-lib-pre', signal: AbortSignal.abort(), progress: (m) => preMsgs.push(m) });
  const preWritten = JSON.parse(readFileSync(join(dir, 'ab-lib-pre', 'result.json'), 'utf8'));
  check(
    'createEngine pre-aborted: result.json written (failed, cancelled, no steps); never reports running',
    pre.result.status === 'failed' && pre.result.cancelled === true && preWritten.cancelled === true && preWritten.steps.length === 0 &&
      engineResultSchema.safeParse(preWritten).success && JSON.stringify(statuses(preMsgs)) === '["failed"]',
    `${pre.result.status} ${JSON.stringify(statuses(preMsgs))}`,
  );

  let usage = null;
  try {
    await engine.run({ template: libGraph, inputs: short, runId: 'ab-lib-bad', signal: {} });
  } catch (err) {
    usage = err;
  }
  check('createEngine: a signal that is not an AbortSignal is a usage error', usage instanceof XweUsageError && /signal must be an AbortSignal/.test(usage.message), String(usage));

  // An older reader (the 0.5.2 schema had no `cancelled`) strips the field: the addition is safe.
  const legacy = engineResultSchema.omit({ cancelled: true }).safeParse(written);
  check('result.json: a reader without `cancelled` still parses a cancelled result', legacy.success && !('cancelled' in legacy.data));
}

console.log(failed ? '\nabort-signal tests: FAILED' : '\nabort-signal tests: all passed');
process.exit(failed ? 1 : 0);
