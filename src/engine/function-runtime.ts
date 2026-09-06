import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as path from 'node:path';
import type { EngineEmit, EngineInChannel, EngineMessage, EngineRunCtx } from '../catalog/types';
import { inputsForPort } from './helpers';
import { scrubSecretEnv } from './child-env';
import { packageRootDir } from './lazy-require';

/**
 * The code function runtime (distribution M7, design §8, docs
 * workflows/functions): one child process per function node instance per
 * run, started on the first event, reused for every event after it, speaking
 * one JSON object per line over stdio. The runners live in dist/runtime/
 * (runtime/js/runner.cjs, runtime/python/runner.py in the source tree); this
 * module spawns them, enforces `timeoutMs` (kill and fail the step) and turns
 * their answers into `json/result` messages, log records and step summaries.
 *
 * The child's environment is built from an allowlist over `scrubSecretEnv`:
 * no `XORGATE_SECRET_*`, no secrets file path, no `NODE_OPTIONS`. Node runs
 * with its permission model enabled and no grants; Python runs isolated
 * (`-I -S`) with the runner's own guards.
 */

export type FunctionLanguage = 'javascript' | 'python';

export interface FunctionEvent {
  tag?: string;
  ts: number;
  seq?: number;
  payload: unknown;
}

export type FunctionInvocation =
  | { ok: true; invocation: number; value: unknown; dropped: boolean; logs: string[]; durationMs: number }
  | {
      ok: false;
      invocation: number;
      /** `TypeError: ...`, `timed out after 3000 ms (...)`, `the function process exited with code 1: ...` */
      error: string;
      /** The frames inside the user's code, one per line; may be empty. */
      stack: string;
      logs: string[];
      durationMs: number;
      timedOut: boolean;
      /** The process is gone (timeout or crash); the node cannot continue. */
      exited: boolean;
    };

export interface FunctionProcessOptions {
  language: FunctionLanguage;
  code: string;
  handler: string;
  functionVersion: '$LATEST' | number;
  nodeId: string;
  runId: string;
  timeoutMs: number;
  memoryMb: number;
  /** Every log line, as it happens (also returned with the invocation). */
  onLog?: (line: string, invocation: number) => void;
  /** The parent environment to derive the child's from. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Where the runners are. Default: `<package root>/dist/runtime`. */
  runtimeDir?: string;
  /** The Python interpreter. Default `python3` from PATH. */
  python?: string;
}

/** Variables a runner may inherit. Everything else, `XORGATE_SECRET_*` first, stays behind. */
const ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'PATHEXT', 'COMSPEC'];

/** The environment a function runner is spawned with. */
export function functionChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const scrubbed = scrubSecretEnv(env);
  const out: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) if (scrubbed[key] !== undefined) out[key] = scrubbed[key];
  return out;
}

/** `--permission` from Node 22.13 / 23; `--experimental-permission` before (Node 20, 21, early 22). */
export function nodePermissionFlag(version: string = process.versions.node): string {
  const [major = 0, minor = 0] = version.split('.').map((n) => Number(n));
  return major >= 23 || (major === 22 && minor >= 13) ? '--permission' : '--experimental-permission';
}

export function defaultRuntimeDir(): string {
  return path.join(packageRootDir(), 'dist', 'runtime');
}

/** How a runner is spawned; exported for `xwe doctor` and the tests. */
export function functionSpawnSpec(
  language: FunctionLanguage,
  opts: { memoryMb: number; runtimeDir?: string; python?: string } = { memoryMb: 256 },
): { command: string; args: string[] } {
  const runtimeDir = opts.runtimeDir ?? defaultRuntimeDir();
  if (language === 'javascript') {
    return {
      command: process.execPath,
      args: [nodePermissionFlag(), `--max-old-space-size=${opts.memoryMb}`, '--no-warnings', path.join(runtimeDir, 'js', 'runner.cjs')],
    };
  }
  return { command: opts.python ?? 'python3', args: ['-I', '-S', '-B', '-u', path.join(runtimeDir, 'python', 'runner.py')] };
}

interface RunnerReply {
  t: 'ready' | 'result' | 'error' | 'log';
  seq?: number;
  value?: unknown;
  logs?: string[];
  durationMs?: number;
  message?: string;
  stack?: string;
  line?: string;
  runtime?: string;
  limits?: Record<string, string>;
}

function lastLines(text: string, n = 3): string {
  const lines = text.trim().split('\n').filter((l) => l.trim());
  return lines.slice(-n).join(' | ');
}

/**
 * One runner process. `start()` spawns it and loads the code; `invoke()`
 * runs one event under `timeoutMs`; `close()` ends it. After a timeout or a
 * crash the process is gone and the node's step has failed, so nothing is
 * restarted.
 */
export class FunctionProcess {
  private child: ChildProcess | null = null;
  private exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  private exited = false;
  private stderrTail = '';
  private pending: { resolve: (reply: RunnerReply) => void; reject: (err: Error) => void } | null = null;
  private invocations = 0;
  private currentLogs: string[] = [];
  /** `node 20.20.2`, `python 3.11.2`: what the runner reported on `ready`. */
  runtime = '';
  limits: Record<string, string> = {};

  constructor(private readonly opts: FunctionProcessOptions) {}

  get language(): FunctionLanguage {
    return this.opts.language;
  }

  /** How many events this process has been asked to handle. */
  get invocationCount(): number {
    return this.invocations;
  }

  async start(): Promise<void> {
    const spec = functionSpawnSpec(this.opts.language, {
      memoryMb: this.opts.memoryMb,
      ...(this.opts.runtimeDir ? { runtimeDir: this.opts.runtimeDir } : {}),
      ...(this.opts.python ? { python: this.opts.python } : {}),
    });
    const child = spawn(spec.command, spec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: functionChildEnv(this.opts.env),
    });
    this.child = child;
    const spawnFailure = new Promise<never>((_, reject) => {
      child.on('error', (err: NodeJS.ErrnoException) => {
        this.exited = true;
        reject(
          new Error(
            err.code === 'ENOENT'
              ? `${spec.command} was not found on PATH; function.${this.opts.language} nodes need it (xwe doctor reports it)`
              : `could not start the ${this.opts.language} function runner: ${err.message}`,
          ),
        );
      });
    });
    spawnFailure.catch(() => {});
    this.exit = new Promise((resolve) => {
      child.on('close', (code, signal) => {
        this.exited = true;
        resolve({ code, signal });
        if (this.pending) {
          const why = signal ? `was killed (${signal})` : `exited with code ${code ?? -1}`;
          const tail = lastLines(this.stderrTail);
          this.pending.reject(new RunnerExit(`the function process ${why}${tail ? `: ${tail}` : ''}`));
          this.pending = null;
        }
      });
    });
    child.stderr!.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-4096);
    });
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    lines.on('line', (line) => this.onLine(line));

    const ready = await Promise.race([
      this.request({
        t: 'init',
        code: this.opts.code,
        handler: this.opts.handler,
        version: this.opts.functionVersion === '$LATEST' ? null : this.opts.functionVersion,
        nodeId: this.opts.nodeId,
        runId: this.opts.runId,
        timeoutMs: this.opts.timeoutMs,
        memoryMb: this.opts.memoryMb,
      }, Math.max(this.opts.timeoutMs, 5_000)),
      spawnFailure,
    ]);
    if (ready.t === 'error') {
      this.kill();
      throw new FunctionLoadError(joinTrace(ready.message ?? 'failed to load', ready.stack));
    }
    this.runtime = ready.runtime ?? '';
    this.limits = ready.limits ?? {};
  }

  async invoke(event: FunctionEvent): Promise<FunctionInvocation> {
    if (!this.child || this.exited) throw new Error('the function process is not running');
    const invocation = ++this.invocations;
    this.currentLogs = [];
    const started = Date.now();
    let reply: RunnerReply;
    try {
      reply = await this.request({ t: 'event', seq: invocation, event, timeoutMs: this.opts.timeoutMs }, this.opts.timeoutMs);
    } catch (err) {
      const durationMs = Date.now() - started;
      if (err instanceof RunnerTimeout) {
        this.kill();
        return {
          ok: false,
          invocation,
          error: `timed out after ${this.opts.timeoutMs} ms (the function process was killed)`,
          stack: '',
          logs: this.currentLogs,
          durationMs,
          timedOut: true,
          exited: true,
        };
      }
      return {
        ok: false,
        invocation,
        error: err instanceof Error ? err.message : String(err),
        stack: '',
        logs: this.currentLogs,
        durationMs,
        timedOut: false,
        exited: true,
      };
    }
    const logs = Array.isArray(reply.logs) ? reply.logs : this.currentLogs;
    const durationMs = typeof reply.durationMs === 'number' ? reply.durationMs : Date.now() - started;
    if (reply.t === 'result') {
      const value = reply.value === undefined ? null : reply.value;
      return { ok: true, invocation, value, dropped: value === null, logs, durationMs };
    }
    return {
      ok: false,
      invocation,
      error: reply.message ?? 'unknown error',
      stack: reply.stack ?? '',
      logs,
      durationMs,
      timedOut: false,
      exited: false,
    };
  }

  /** Ends the process: a close message, then a short grace period, then SIGKILL. */
  async close(): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    try {
      child.stdin!.write('{"t":"close"}\n');
      child.stdin!.end();
    } catch {
      // already gone
    }
    const grace = new Promise<void>((resolve) => setTimeout(resolve, 500).unref());
    await Promise.race([this.exit, grace]);
    if (!this.exited) this.kill();
  }

  kill(): void {
    if (this.child && !this.exited) {
      this.child.kill('SIGKILL');
    }
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let reply: RunnerReply;
    try {
      reply = JSON.parse(line) as RunnerReply;
    } catch {
      this.pending?.reject(new Error(`unexpected output from the function runner: ${line.slice(0, 200)}`));
      this.pending = null;
      return;
    }
    if (reply.t === 'log') {
      const text = typeof reply.line === 'string' ? reply.line : String(reply.line);
      this.currentLogs.push(text);
      this.opts.onLog?.(text, this.invocations);
      return;
    }
    if (this.pending) {
      this.pending.resolve(reply);
      this.pending = null;
    }
  }

  private request(msg: Record<string, unknown>, timeoutMs: number): Promise<RunnerReply> {
    return new Promise<RunnerReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new RunnerTimeout());
      }, timeoutMs);
      this.pending = {
        resolve: (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.child!.stdin!.write(`${JSON.stringify(msg)}\n`, (err) => {
        if (err && this.pending) {
          clearTimeout(timer);
          this.pending = null;
          reject(new RunnerExit(`could not write to the function process: ${err.message}`));
        }
      });
    });
  }
}

class RunnerTimeout extends Error {
  constructor() {
    super('timeout');
  }
}
class RunnerExit extends Error {}

/** The code did not load: a syntax error, a missing handler, an invalid identifier. */
export class FunctionLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FunctionLoadError';
  }
}

export function joinTrace(message: string, stack?: string): string {
  return stack && stack.trim() ? `${message}\n${stack}` : message;
}

/** The step output for a failed invocation: which one, the error, its trace, and the invocation's log lines. */
export function formatInvocationFailure(result: Extract<FunctionInvocation, { ok: false }>): string {
  const head = `invocation ${result.invocation} ${result.timedOut || result.exited ? '' : 'failed: '}${result.error}`;
  let text = joinTrace(head, result.stack);
  if (result.logs.length > 0) text += `\nlogs:\n${result.logs.map((l) => `  ${l}`).join('\n')}`;
  return text;
}

/**
 * Messages from several connections in arrival order. Unlike `mergeByTs`
 * (which waits for one message from every input before yielding the first),
 * this never blocks on a silent input: a function upstream that drops every
 * event must not stall a function downstream that also reads the source.
 * With one connection it is that connection's order.
 */
export async function* mergeByArrival(inputs: EngineInChannel[]): AsyncIterable<EngineMessage> {
  if (inputs.length === 1) {
    for await (const msg of inputs[0].messages) yield msg;
    return;
  }
  const iterators = inputs.map((input) => input.messages[Symbol.asyncIterator]());
  const pending = new Map<number, Promise<{ index: number; result: IteratorResult<EngineMessage> }>>();
  const pull = (index: number): void => {
    pending.set(index, iterators[index].next().then((result) => ({ index, result })));
  };
  iterators.forEach((_, i) => pull(i));
  while (pending.size > 0) {
    const { index, result } = await Promise.race(pending.values());
    pending.delete(index);
    if (result.done) continue;
    pull(index);
    yield result.value;
  }
}

/** Config as the node's schema parses it (../catalog/nodes/function-common.ts). */
export interface FunctionNodeConfig {
  handler: string;
  timeoutMs: number;
  memoryMb: number;
  code: string;
  versions: Array<{ version: number; code: string; handler: string; publishedAt: string; description?: string }>;
  deployedVersion: number | null;
}

/**
 * The executor both function nodes share: events in, results out, one
 * process for the whole run. Any invocation failure (a thrown error, a
 * timeout, a crash) throws, which fails the step and skips everything
 * downstream, like any other node.
 */
export async function* runFunctionNode(
  language: FunctionLanguage,
  resolved: { code: string; handler: string; functionVersion: '$LATEST' | number; label: string },
  cfg: Pick<FunctionNodeConfig, 'timeoutMs' | 'memoryMb'>,
  inputs: EngineInChannel[],
  ctx: EngineRunCtx,
): AsyncIterable<EngineEmit> {
  let proc: FunctionProcess | null = null;
  let invocations = 0;
  let results = 0;
  let dropped = 0;
  let logLines = 0;
  let handlerMs = 0;
  let currentTs = 0;
  try {
    for await (const msg of mergeByArrival(inputsForPort(inputs, 'event'))) {
      if (msg.ch !== 'json') continue;
      currentTs = msg.ts;
      if (!proc) {
        proc = new FunctionProcess({
          language,
          code: resolved.code,
          handler: resolved.handler,
          functionVersion: resolved.functionVersion,
          nodeId: ctx.nodeId,
          runId: ctx.runId,
          timeoutMs: cfg.timeoutMs,
          memoryMb: cfg.memoryMb,
          onLog: (line, invocation) => {
            logLines += 1;
            ctx.emitRecord?.({ port: 'log', tag: 'log', ts: currentTs, payload: { line, invocation } });
            ctx.log(`log: ${line}`, 'debug');
          },
        });
        await proc.start();
        ctx.log(`${language} function runner started (${proc.runtime}, ${resolved.label})`, 'debug');
      }
      invocations += 1;
      const r = await proc.invoke({ tag: msg.tag, ts: msg.ts, seq: msg.seq, payload: msg.payload });
      handlerMs += r.durationMs;
      if (!r.ok) throw new Error(formatInvocationFailure(r));
      if (r.dropped) {
        dropped += 1;
        continue;
      }
      results += 1;
      yield { ch: 'json', tag: 'result', port: 'result', ts: msg.ts, payload: r.value };
    }
    const avg = invocations > 0 ? Math.round(handlerMs / invocations) : 0;
    ctx.setSummary(
      `${invocations} invocation(s), ${results} result(s), ${dropped} dropped` +
        (logLines > 0 ? `, ${logLines} log line(s)` : '') +
        ` (${resolved.label}, ${language}, ~${avg} ms)`,
    );
  } finally {
    await proc?.close();
  }
}
