'use strict';
/**
 * The JavaScript function runner: one process per `function.javascript` node
 * instance per run, spawned by the engine (src/engine/function-runtime.ts) as
 *
 *   node --permission --allow-fs-read=<this file> --max-old-space-size=<memoryMb> runner.cjs
 *
 * (`--experimental-permission` on Node 20/21; the read grant covers only
 * this file, which Node 20 needs to load the entry point). It speaks one JSON object per
 * line: requests on stdin, answers on stdout, diagnostics on stderr.
 *
 *   -> { t: "init", code, handler, version, nodeId, runId, timeoutMs }
 *   <- { t: "ready", runtime }            | { t: "error", message, stack, logs }
 *   -> { t: "event", seq, event: { tag, ts, seq, payload } }
 *   <- { t: "log", seq, line }            (zero or more, as context.log is called)
 *   <- { t: "result", seq, value, logs, durationMs }
 *      | { t: "error", seq, message, stack, logs, durationMs }
 *   -> { t: "close" }                     (or end of stdin) -> exit 0
 *
 * The user's code runs inside a fresh V8 context whose global object has a
 * null prototype and only the ECMAScript built-ins plus the timers, a
 * console that feeds the invocation log, and a `require` that refuses. Code
 * generation from strings is disabled in that context, so `eval`, the
 * `Function` constructor and every wrapper-based escape throw; `import()` has
 * no loader in that context and throws too. Nothing from this (main) realm is
 * exposed as a property the user's code can reach: every host function is
 * held in a closure of a bootstrap evaluated inside the context, and every
 * value crossing the boundary is a primitive. Node's permission model is the
 * outer wall: even this file cannot read the file system, spawn a process or
 * start a worker. The process has no `XORGATE_SECRET_*` in its environment
 * (the engine builds it from an allowlist), and the user's code has no
 * `process` at all.
 */
const vm = require('node:vm');
const readline = require('node:readline');

const MAX_LOG_LINE_CHARS = 4096;
const MAX_LOG_LINES_PER_INVOCATION = 1000;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const stdout = process.stdout;
function send(obj) {
  stdout.write(`${JSON.stringify(obj)}\n`);
}
function sendRaw(text) {
  stdout.write(`${text}\n`);
}

// --- the sandbox -------------------------------------------------------------

const sandbox = Object.create(null);
const context = vm.createContext(sandbox, {
  name: 'code-function',
  codeGeneration: { strings: false, wasm: false },
});

// Host state the bootstrap's closures read through the `host` object below.
// `host` itself never leaves this realm: the bootstrap destructures it into
// closure variables and exposes only context-realm functions.
let currentSeq = -1;
let currentDeadline = 0;
let currentLogs = [];
let droppedLogs = 0;

function pushLog(line) {
  if (currentLogs.length >= MAX_LOG_LINES_PER_INVOCATION) {
    droppedLogs += 1;
    return;
  }
  const text = line.length > MAX_LOG_LINE_CHARS ? `${line.slice(0, MAX_LOG_LINE_CHARS)}…` : line;
  currentLogs.push(text);
  send({ t: 'log', seq: currentSeq, line: text });
}

const timers = new Set();
const host = {
  log(line) {
    pushLog(String(line));
  },
  remaining() {
    return Math.max(0, currentDeadline - Date.now());
  },
  setTimeout(fn, ms, args) {
    const handle = setTimeout(() => {
      timers.delete(handle);
      try {
        fn(...args);
      } catch (err) {
        pushLog(`uncaught exception in a timer: ${describe(err).message}`);
      }
    }, Number(ms) || 0);
    timers.add(handle);
    return Number(handle);
  },
  clearTimeout(id) {
    for (const handle of timers) {
      if (Number(handle) === Number(id)) {
        clearTimeout(handle);
        timers.delete(handle);
        return;
      }
    }
  },
  setInterval(fn, ms, args) {
    const handle = setInterval(() => {
      try {
        fn(...args);
      } catch (err) {
        pushLog(`uncaught exception in an interval: ${describe(err).message}`);
      }
    }, Number(ms) || 0);
    timers.add(handle);
    return Number(handle);
  },
};

// Evaluated inside the context: installs the globals the user's code may use
// and returns the invoke function. Everything defined here lives in the
// sandbox realm, so `setTimeout.constructor` is the sandbox's Function (whose
// code generation is disabled), never the host's.
const bootstrap = vm.runInContext(
  `(function (host) {
  'use strict';
  const hostLog = host.log;
  const hostRemaining = host.remaining;
  const hostSetTimeout = host.setTimeout;
  const hostClearTimeout = host.clearTimeout;
  const hostSetInterval = host.setInterval;

  function format(args) {
    const parts = [];
    for (const a of args) {
      if (typeof a === 'string') parts.push(a);
      else if (a instanceof Error) parts.push(String(a.stack || a));
      else if (typeof a === 'object' && a !== null) {
        try { parts.push(JSON.stringify(a)); } catch { parts.push(String(a)); }
      } else parts.push(String(a));
    }
    return parts.join(' ');
  }
  const log = (...args) => { hostLog(format(args)); };

  globalThis.console = { log, info: log, warn: log, error: log, debug: log, trace: log };
  globalThis.setTimeout = function setTimeout(fn, ms, ...args) {
    if (typeof fn !== 'function') throw new TypeError('setTimeout needs a function');
    return hostSetTimeout(fn, ms, args);
  };
  globalThis.clearTimeout = function clearTimeout(id) { hostClearTimeout(id); };
  globalThis.setInterval = function setInterval(fn, ms, ...args) {
    if (typeof fn !== 'function') throw new TypeError('setInterval needs a function');
    return hostSetInterval(fn, ms, args);
  };
  globalThis.clearInterval = globalThis.clearTimeout;
  globalThis.queueMicrotask = function queueMicrotask(fn) { Promise.resolve().then(fn); };
  globalThis.structuredClone = function structuredClone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); };
  const denied = (what) => {
    const err = new Error(what + ' is not available in a code function: no module access, no file system, no network (ERR_ACCESS_DENIED)');
    err.code = 'ERR_ACCESS_DENIED';
    return err;
  };
  globalThis.require = function require(id) { throw denied('require(' + JSON.stringify(String(id)) + ')'); };
  globalThis.fetch = function fetch() { throw denied('fetch()'); };

  return function invoke(handler, eventJson, nodeId, runId, functionVersion) {
    const event = JSON.parse(eventJson);
    const context = Object.freeze({
      log,
      nodeId,
      runId,
      functionVersion,
      remainingTimeMs() { return hostRemaining(); },
    });
    return Promise.resolve(handler(event, context)).then((value) => {
      if (value === undefined || value === null) return null;
      const text = JSON.stringify(value);
      return text === undefined ? null : text;
    });
  };
})`,
  context,
  { filename: 'bootstrap.js' },
);
const invoke = bootstrap(host);

// --- errors --------------------------------------------------------------------

/** { message, stack } for anything thrown by the user's code (any realm, any type). */
function describe(err) {
  let message;
  let stack = '';
  try {
    if (err && typeof err === 'object') {
      const name = typeof err.name === 'string' ? err.name : 'Error';
      const msg = typeof err.message === 'string' ? err.message : String(err);
      message = `${name}: ${msg}`;
      if (typeof err.stack === 'string') stack = err.stack;
    } else {
      message = `Uncaught ${typeof err === 'string' ? JSON.stringify(err) : String(err)}`;
    }
  } catch {
    message = 'Error: (unprintable error)';
  }
  if (message.includes('Code generation from strings disallowed')) {
    message = 'EvalError: eval() and the Function constructor are not available in a code function (ERR_ACCESS_DENIED)';
  }
  // A syntax error has no user frame; V8 names the line at the top of the stack.
  const syntaxAt = /^SyntaxError/.test(message) ? stack.match(/^index\.js:(\d+)/m) : null;
  if (syntaxAt) message = `${message} (index.js:${syntaxAt[1]})`;
  if (err && (err.code === 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING' || err.code === 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG')) {
    message = 'Error: import() is not available in a code function: no module access (ERR_ACCESS_DENIED)';
    stack = '';
  }
  // Keep only the frames inside the user's code (index.js, and the native
  // frames it called, such as Array.filter); the runner's and Node's own
  // frames are noise to the author of index.js.
  const frames = stack
    .split('\n')
    .filter((line) => /^\s+at .*\((?:index\.js:\d+:\d+|<anonymous>)\)$/.test(line) || /^\s+at index\.js:\d+:\d+$/.test(line))
    .map((line) => line.replace(/\s+$/, ''));
  return { message, stack: frames.join('\n') };
}

// --- protocol ------------------------------------------------------------------

let handler = null;
let nodeId = '';
let runId = '';
let functionVersion = '$LATEST';
let busy = false;
const queue = [];

function loadHandler(init) {
  const code = typeof init.code === 'string' ? init.code : '';
  const name = typeof init.handler === 'string' ? init.handler : 'handler';
  if (!IDENTIFIER.test(name)) {
    throw new Error(`handler "${name}" is not a valid identifier`);
  }
  // The user's code as the body of a function compiled in the sandbox
  // context, with index.js as its file name so stack traces point at the
  // editor's lines. Compiled once on its own first, so a syntax error names
  // the author's line rather than the appended statement, which then hands
  // the named handler back.
  vm.compileFunction(code, [], { parsingContext: context, filename: 'index.js' });
  const factory = vm.compileFunction(`${code}\n;return typeof ${name} === 'function' ? ${name} : undefined;`, [], {
    parsingContext: context,
    filename: 'index.js',
  });
  const fn = factory();
  if (typeof fn !== 'function') {
    throw new Error(`handler "${name}" is not a function in the code (define \`async function ${name}(event, context)\`)`);
  }
  return fn;
}

async function handleEvent(msg) {
  const seq = typeof msg.seq === 'number' ? msg.seq : 0;
  currentSeq = seq;
  currentLogs = [];
  droppedLogs = 0;
  const started = Date.now();
  currentDeadline = started + (typeof msg.timeoutMs === 'number' ? msg.timeoutMs : 3000);
  let eventJson;
  try {
    eventJson = JSON.stringify(msg.event ?? null);
  } catch (err) {
    send({ t: 'error', seq, message: `event is not serializable: ${describe(err).message}`, stack: '', logs: [], durationMs: 0 });
    return;
  }
  try {
    const value = await invoke(handler, eventJson, nodeId, runId, functionVersion);
    const durationMs = Date.now() - started;
    if (droppedLogs > 0) currentLogs.push(`… ${droppedLogs} more log line(s) dropped`);
    sendRaw(
      `{"t":"result","seq":${seq},"value":${value === null ? 'null' : value},"logs":${JSON.stringify(currentLogs)},"durationMs":${durationMs}}`,
    );
  } catch (err) {
    const { message, stack } = describe(err);
    send({ t: 'error', seq, message, stack, logs: currentLogs, durationMs: Date.now() - started });
  }
}

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length > 0) {
    const msg = queue.shift();
    if (msg.t === 'event') {
      if (!handler) {
        send({ t: 'error', seq: msg.seq ?? 0, message: 'Error: event before init', stack: '', logs: [], durationMs: 0 });
        continue;
      }
      await handleEvent(msg);
    } else if (msg.t === 'init') {
      nodeId = typeof msg.nodeId === 'string' ? msg.nodeId : '';
      runId = typeof msg.runId === 'string' ? msg.runId : '';
      functionVersion = msg.version === undefined || msg.version === null ? '$LATEST' : msg.version;
      currentSeq = -1;
      currentLogs = [];
      try {
        handler = loadHandler(msg);
        const heap = (process.execArgv.find((a) => a.startsWith('--max-old-space-size=')) ?? '').split('=')[1];
        send({
          t: 'ready',
          runtime: `node ${process.versions.node}`,
          limits: {
            memory: heap ? `max-old-space-size ${heap} MB` : 'default heap',
            permission: process.permission ? 'enabled (read grant on the runner file only)' : 'off',
          },
        });
      } catch (err) {
        const { message, stack } = describe(err);
        send({ t: 'error', seq: -1, message, stack, logs: currentLogs, durationMs: 0 });
      }
    } else if (msg.t === 'close') {
      process.exit(0);
    } else {
      send({ t: 'error', seq: msg.seq ?? -1, message: `Error: unknown message type "${String(msg.t)}"`, stack: '', logs: [], durationMs: 0 });
    }
  }
  busy = false;
}

process.on('unhandledRejection', (reason) => {
  pushLog(`unhandled promise rejection: ${describe(reason).message}`);
});

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ t: 'error', seq: -1, message: 'Error: malformed request line', stack: '', logs: [], durationMs: 0 });
    return;
  }
  queue.push(msg);
  void pump();
});
rl.on('close', () => {
  const finish = () => process.exit(0);
  if (busy) {
    const wait = () => (busy ? setTimeout(wait, 5) : finish());
    wait();
  } else finish();
});
