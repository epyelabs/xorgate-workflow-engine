#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { createEngine, XweUsageError, type EngineRunOptions } from '../create-engine';
import { inspectTemplate, loadDefinition } from '../local/manifest-builder';
import { localHost } from '../local/host';
import { ndjsonProgress, resolveFfmpeg } from '../local/target';
import { doctorReport } from './doctor';
import { ModelsUsageError, runModelsCommand } from './models';

/**
 * xwe — the workflow engine CLI: argument parsing over createEngine + localHost.
 *
 *   xwe validate <template.json>
 *   xwe run <template.json> --input video=./drive.mp4 --input telemetry=./window.csv
 *           [--out ./out] [--run-id id] [--models-dir dir]... [--secrets s.json]
 *           [--progress json] [--emit-video] [--window from,to]
 *   xwe run --manifest <manifest.json> [same flags]
 *   xwe models list | pull <family>/<name>[@v] | path <family>/<name>[@v] | check <dir>
 *   xwe doctor [--models-dir dir]...
 *
 * Exit codes: 0 success · 1 run failed (failing node named) · 2 usage/config.
 */

const USAGE = `usage:
  xwe validate <template.json>
  xwe run <template.json> --input <key>=<path> ... [options]
  xwe run --manifest <manifest.json> [options]
  xwe models list | pull <family>/<name>[@<version>] | path <family>/<name>[@<version>] | check <dir>
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
  --window <from>,<to>   ISO run window (rarely needed locally)`;

function fail(message: string, code = 2): never {
  console.error(`xwe: ${message}`);
  process.exit(code);
}

function cmdValidate(templatePath: string): number {
  const definition = loadDefinition(templatePath);
  const info = inspectTemplate(definition);
  if (info.issues.length > 0) {
    console.error(`INVALID: ${info.issues.length} issue(s)`);
    for (const issue of info.issues) {
      console.error(
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
}

async function cmdRun(templatePath: string | undefined, flags: RunFlags): Promise<number> {
  const runOptions: EngineRunOptions = {};
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

  const secretsFile = flags.secrets
    ? (JSON.parse(readFileSync(flags.secrets, 'utf8')) as Record<string, string>)
    : undefined;

  const engine = createEngine({
    host: localHost({
      modelDirs: flags.modelsDir,
      outDir: flags.out,
      ...(flags.pull ? { models: { pull: true } } : {}),
      ...(secretsFile ? { secrets: secretsFile } : {}),
      ...(flags.progress === 'json' ? { progress: ndjsonProgress((line) => console.log(line)) } : {}),
    }),
    log: (m) => console.error(`[engine] ${m}`),
  });

  if (!resolveFfmpeg()) {
    console.error(
      'xwe: warning: no ffmpeg found (FFMPEG_PATH, PATH, or ffmpeg-static) — video nodes will fail',
    );
  }

  const startedAt = Date.now();
  const { result, runDir, outcome } = await engine.run(runOptions);

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.error(`[xwe] ${outcome.status} in ${seconds}s -> ${path.join(runDir, 'result.json')}`);
  for (const step of result.steps) {
    console.error(`  ${step.status.padEnd(7)} ${step.nodeId.padEnd(12)} ${step.output}`);
  }
  if (outcome.status === 'failed') {
    console.error(
      `xwe: run failed at node ${outcome.failedNodeId ?? '(none)'}: ${outcome.error ?? 'unknown error'}`,
    );
    return 1;
  }
  console.error(`  events: ${result.events.length}`);
  return 0;
}

async function cmdDoctor(modelDirs: string[]): Promise<number> {
  const report = await doctorReport({ modelDirs });
  for (const line of report.lines) console.log(line);
  return report.ok ? 0 : 1;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'validate') {
    const templatePath = rest[0];
    if (!templatePath) fail(`validate needs a template path\n${USAGE}`);
    return cmdValidate(templatePath);
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
    });
  }
  if (command === 'models') {
    return runModelsCommand(rest);
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
    console.error(`xwe: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(err instanceof XweUsageError || err instanceof ModelsUsageError ? err.exitCode : 2);
  },
);
