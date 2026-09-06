#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { coreCatalog, corePacks } from '../catalog/index';
import { createCatalog, type NodePack } from '../catalog/pack';
import { createEngine, XweUsageError, type EngineRunOptions } from '../create-engine';
import { createLogger, isLogLevel, LOG_LEVELS, type Logger } from '../engine/log';
import { inspectTemplate, loadDefinition } from '../local/manifest-builder';
import { localHost } from '../local/host';
import { ndjsonProgress, resolveFfmpeg } from '../local/target';
import { doctorReport } from './doctor';
import { ModelsUsageError, runModelsCommand } from './models';
import { loadPacks } from './packs';

/**
 * xwe — the workflow engine CLI: argument parsing over createEngine + localHost.
 *
 *   xwe validate <template.json> [--pack module]...
 *   xwe run <template.json> --input video=./drive.mp4 --input telemetry=./window.csv
 *           [--out ./out] [--run-id id] [--models-dir dir]... [--secrets s.json]
 *           [--progress json] [--emit-video] [--window from,to] [--pack module]...
 *   xwe run --manifest <manifest.json> [same flags]
 *   xwe models list | pull <family>/<name>[@v] | path <family>/<name>[@v] | check <dir>
 *   xwe function test <template.json> <nodeId> --event <event.json> [--version n]
 *   xwe doctor [--models-dir dir]...
 *   --log-level silent|error|info|debug on any command (default info)
 *
 * Exit codes: 0 success · 1 run failed (failing node named) · 2 usage/config.
 * Diagnostics go to stderr; stdout carries results (validate, doctor, models)
 * and the NDJSON progress stream. `--log-level` gates stderr only.
 */

const USAGE = `usage:
  xwe validate <template.json> [--pack <module>]...
  xwe run <template.json> --input <key>=<path> ... [options]
  xwe run --manifest <manifest.json> [options]
  xwe models list | pull <family>/<name>[@<version>] | path <family>/<name>[@<version>] | check <dir>
  xwe function test <template.json> <nodeId> --event <event.json> [--version <n>]
  xwe doctor [--models-dir <dir>]...

options:
  --input <key>=<path>   bind a source node (key: video | telemetry | <nodeId>)
  --out <dir>            artifact root (default ./out); run writes <out>/<runId>/
  --run-id <id>          run id (default local-<timestamp>)
  --models-dir <dir>     model registry root(s), searched before the cache (XWE_MODELS_DIR, default ~/.xorgate/models)
  --pull                 fetch a model the graph names from the registry when it is not on disk (or XWE_MODELS_PULL=1)
  --secrets <file>       JSON { "<logical-name>": "<value>" }; env XORGATE_SECRET_* also works
  --progress json        emit NDJSON progress on stdout
  --emit-video           mux visualization frames into out/<runId>/video/<nodeId>.mp4
  --window <from>,<to>   ISO run window (rarely needed locally)
  --pack <module>        register a node pack (an npm package name or a path, resolved from cwd); repeatable
  --event <file>         function test: the event to run through the handler ({ "tag"?, "ts"?, "payload" })
  --version <n>          function test: run a published snapshot instead of the working copy
  --log-level <level>    stderr verbosity on any command: silent | error | info (default) | debug`;

let logger: Logger = createLogger('info');

function fail(message: string, code = 2): never {
  logger.error(`xwe: ${message}`);
  process.exit(code);
}

/**
 * `--log-level <level>` / `--log-level=<level>` is accepted anywhere on the
 * line, for every subcommand, and removed before the subcommand parses its
 * own flags. An unknown level is a usage error.
 */
function extractLogLevel(argv: string[]): { level: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let level: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--log-level') {
      level = argv[i + 1];
      if (level === undefined) fail(`--log-level needs a value: ${LOG_LEVELS.join(' | ')}`);
      i += 1;
    } else if (arg.startsWith('--log-level=')) {
      level = arg.slice('--log-level='.length);
    } else {
      rest.push(arg);
    }
  }
  return { level, rest };
}

function cmdValidate(templatePath: string, packs: NodePack[]): number {
  const definition = loadDefinition(templatePath);
  const catalog = packs.length > 0 ? createCatalog([...corePacks, ...packs]) : coreCatalog;
  const info = inspectTemplate(definition, catalog);
  if (info.issues.length > 0) {
    logger.error(`INVALID: ${info.issues.length} issue(s)`);
    for (const issue of info.issues) {
      logger.error(
        `  ${issue.code}${issue.nodeId ? ` [${issue.nodeId}]` : ''}${issue.edgeId ? ` [edge ${issue.edgeId}]` : ''}: ${issue.message}`,
      );
    }
    return 1;
  }
  console.log(`OK: ${definition.nodes.length} nodes, ${definition.edges.length} edges (schemaVersion 2)`);
  if (info.sources.length > 0) {
    console.log('required inputs:');
    for (const s of info.sources) {
      console.log(`  --input ${s.inputKey}=<path>   ${s.type} "${s.label}" (node ${s.nodeId})`);
    }
  } else {
    console.log('required inputs: none');
  }
  const secretTokens = info.requires.filter((t) => t.startsWith('secret:'));
  console.log(
    `required secrets: ${secretTokens.length > 0 ? secretTokens.map((t) => t.slice('secret:'.length)).join(', ') : 'none'}`,
  );
  const other = info.requires.filter((t) => !t.startsWith('secret:'));
  if (other.length > 0) console.log(`other requirements: ${other.join(', ')}`);
  return 0;
}

/**
 * `--secrets <file>`: a JSON object of string values. Read and parse errors
 * name the file only; the parser's message (which quotes the offending text)
 * and the file's contents never reach stderr.
 */
function readSecretsFile(file: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as { code?: string }).code;
    return fail(`--secrets ${file}: cannot read it${code ? ` (${code})` : ''}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail(`--secrets ${file}: not valid JSON (expected { "<logical-name>": "<value>" })`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail(`--secrets ${file}: expected a JSON object of { "<logical-name>": "<value>" }`);
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') return fail(`--secrets ${file}: the value of "${name}" must be a string`);
    out[name] = value;
  }
  return out;
}

interface RunFlags {
  manifest?: string;
  input: string[];
  out: string;
  runId?: string;
  modelsDir: string[];
  secrets?: string;
  progress?: string;
  emitVideo?: boolean;
  window?: string;
  pull?: boolean;
  pack: string[];
}

async function cmdRun(templatePath: string | undefined, flags: RunFlags): Promise<number> {
  const runOptions: EngineRunOptions = {};
  const packs = await loadPacks(flags.pack, { log: (line) => logger.info(line) });
  if (flags.manifest) {
    runOptions.manifest = flags.manifest;
  } else if (templatePath) {
    const inputs: Record<string, string> = {};
    for (const pair of flags.input) {
      const eq = pair.indexOf('=');
      if (eq <= 0) fail(`--input must be <key>=<path>, got "${pair}"`);
      inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    if (flags.window) {
      const [from, to] = flags.window.split(',');
      if (!from || !to) fail('--window must be <fromISO>,<toISO>');
      runOptions.window = { from, to };
    }
    runOptions.template = templatePath;
    runOptions.inputs = inputs;
  } else {
    fail(`run needs a template path or --manifest\n${USAGE}`);
  }
  if (flags.runId) runOptions.runId = flags.runId;
  if (flags.emitVideo) runOptions.emitVideo = true;
  if (flags.progress !== undefined && flags.progress !== 'json') fail(`--progress takes "json", got "${flags.progress}"`);

  const secretsFile = flags.secrets ? readSecretsFile(flags.secrets) : undefined;

  const engine = createEngine({
    ...(packs.length > 0 ? { packs } : {}),
    host: localHost({
      modelDirs: flags.modelsDir,
      outDir: flags.out,
      ...(flags.pull ? { models: { pull: true } } : {}),
      ...(secretsFile ? { secrets: secretsFile } : {}),
      ...(flags.progress === 'json' ? { progress: ndjsonProgress((line) => console.log(line)) } : {}),
      log: (m) => logger.info(`[xwe] ${m}`),
    }),
    log: (m, level) => logger[level](`[engine] ${m}`),
  });

  if (!resolveFfmpeg()) {
    logger.info('xwe: warning: no ffmpeg found (FFMPEG_PATH, PATH, or ffmpeg-static); video nodes will fail');
  }

  const startedAt = Date.now();
  const { result, runDir, outcome } = await engine.run(runOptions);

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  logger.info(`[xwe] ${outcome.status} in ${seconds}s -> ${path.join(runDir, 'result.json')}`);
  for (const step of result.steps) {
    logger.info(`  ${step.status.padEnd(7)} ${step.nodeId.padEnd(12)} ${step.output}`);
  }
  if (outcome.status === 'failed') {
    logger.error(
      `xwe: run failed at node ${outcome.failedNodeId ?? '(none)'}: ${outcome.error ?? 'unknown error'}`,
    );
    return 1;
  }
  logger.info(`  events: ${result.events.length}`);
  return 0;
}

/**
 * `xwe function test <template> <nodeId> --event <file> [--version n]`: one
 * event through the node's handler in the run's sandboxed runtime. The
 * report goes to stdout; exit 0 when the handler answered, 1 when it threw,
 * timed out or failed to load, 2 when nothing ran.
 */
async function cmdFunctionTest(
  templatePath: string | undefined,
  nodeId: string | undefined,
  flags: { event?: string; version?: string },
): Promise<number> {
  if (!templatePath || !nodeId) fail(`function test needs a template path and a node id\n${USAGE}`);
  if (!flags.event) fail('function test needs --event <file>');
  let version: number | undefined;
  if (flags.version !== undefined) {
    version = Number(flags.version);
    if (!Number.isInteger(version) || version <= 0) fail(`--version must be a positive integer, got "${flags.version}"`);
  }
  const engine = createEngine({
    host: localHost({ log: (m) => logger.info(`[xwe] ${m}`) }),
    log: (m, level) => logger[level](`[engine] ${m}`),
  });
  const test = await engine.testFunction({
    template: templatePath,
    nodeId,
    event: flags.event,
    ...(version !== undefined ? { version } : {}),
  });
  const label = test.functionVersion === '$LATEST' ? '$LATEST' : `v${test.functionVersion}`;
  console.log(`${(test.ok ? 'ok' : 'failed').padEnd(7)} ${test.nodeId.padEnd(12)} ${test.type}  ${label}  ${test.durationMs} ms`);
  if (test.ok) console.log(`result: ${test.result === null ? 'null (dropped)' : JSON.stringify(test.result)}`);
  else console.log(`error: ${test.error}`);
  if (test.logs.length === 0) console.log('logs: none');
  else {
    console.log('logs:');
    for (const line of test.logs) console.log(`  ${line}`);
  }
  return test.ok ? 0 : 1;
}

async function cmdDoctor(modelDirs: string[]): Promise<number> {
  const report = await doctorReport({ modelDirs });
  for (const line of report.lines) console.log(line);
  return report.ok ? 0 : 1;
}

async function main(): Promise<number> {
  const { level, rest: argv } = extractLogLevel(process.argv.slice(2));
  if (level !== undefined) {
    if (!isLogLevel(level)) fail(`--log-level must be one of ${LOG_LEVELS.join(', ')}, got "${level}"`);
    logger = createLogger(level);
  }
  const [command, ...rest] = argv;
  if (command === 'validate') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { pack: { type: 'string', multiple: true } },
    });
    const templatePath = positionals[0];
    if (!templatePath) fail(`validate needs a template path\n${USAGE}`);
    const packs = await loadPacks(values.pack ?? [], { log: (line) => logger.info(line) });
    return cmdValidate(templatePath, packs);
  }
  if (command === 'run') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        manifest: { type: 'string' },
        input: { type: 'string', multiple: true },
        out: { type: 'string', default: 'out' },
        'run-id': { type: 'string' },
        'models-dir': { type: 'string', multiple: true },
        secrets: { type: 'string' },
        progress: { type: 'string' },
        'emit-video': { type: 'boolean' },
        window: { type: 'string' },
        pull: { type: 'boolean' },
        pack: { type: 'string', multiple: true },
      },
    });
    return cmdRun(positionals[0], {
      manifest: values.manifest,
      input: values.input ?? [],
      out: values.out ?? 'out',
      runId: values['run-id'],
      modelsDir: values['models-dir'] ?? [],
      secrets: values.secrets,
      progress: values.progress,
      emitVideo: values['emit-video'],
      window: values.window,
      pull: values.pull,
      pack: values.pack ?? [],
    });
  }
  if (command === 'models') {
    // `xwe:` lines are failures; `[xwe]` lines are the pull narrative.
    return runModelsCommand(rest, { stderr: (line) => (line.startsWith('xwe:') ? logger.error(line) : logger.info(line)) });
  }
  if (command === 'function') {
    const [sub, ...args] = rest;
    if (sub !== 'test') fail(`function takes the subcommand "test"\n${USAGE}`);
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { event: { type: 'string' }, version: { type: 'string' } },
    });
    return cmdFunctionTest(positionals[0], positionals[1], { event: values.event, version: values.version });
  }
  if (command === 'doctor') {
    const { values } = parseArgs({
      args: rest,
      options: { 'models-dir': { type: 'string', multiple: true } },
    });
    return cmdDoctor(values['models-dir'] ?? []);
  }
  console.error(USAGE);
  return command === undefined || command === '--help' || command === 'help' ? 0 : 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    logger.error(`xwe: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(err instanceof XweUsageError || err instanceof ModelsUsageError ? err.exitCode : 2);
  },
);
