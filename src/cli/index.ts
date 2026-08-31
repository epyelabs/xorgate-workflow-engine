#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { runGraph, type EngineRunOutcome } from '../engine/index';
import { runManifestSchema, type RunManifest } from '../engine/manifest';
import { upgradeDefinition } from '../compat';
import { buildLocalManifest, inspectTemplate, loadDefinition } from '../local/manifest-builder';
import {
  defaultModelDirs,
  localArtifactSink,
  localSecretReader,
  localSources,
  ndjsonProgress,
  resolveFfmpeg,
  writeLocalRunArtifacts,
} from '../local/target';
import { emitVisualizationVideos } from '../local/emit-video';
import { captureFormatsOf } from './capture-formats';

/**
 * xwe — the portable workflow engine CLI (M3).
 *
 *   xwe validate <template.json>
 *   xwe run <template.json> --input video=./drive.mp4 --input telemetry=./window.csv
 *           [--out ./out] [--run-id id] [--models-dir dir]... [--secrets s.json]
 *           [--progress json] [--window from,to]
 *   xwe run --manifest <manifest.json> [same flags]
 *
 * Exit codes: 0 success · 1 run failed (failing node named) · 2 usage/config.
 */

const USAGE = `usage:
  xwe validate <template.json>
  xwe run <template.json> --input <key>=<path> ... [options]
  xwe run --manifest <manifest.json> [options]

options:
  --input <key>=<path>   bind a source node (key: video | telemetry | <nodeId>)
  --out <dir>            artifact root (default ./out); run writes <out>/<runId>/
  --run-id <id>          run id (default local-<timestamp>)
  --models-dir <dir>     model registry root(s); default ./fixtures/models, ~/.xorgate/models
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
}

async function cmdRun(templatePath: string | undefined, flags: RunFlags): Promise<number> {
  let manifest: RunManifest;
  if (flags.manifest) {
    manifest = runManifestSchema.parse(JSON.parse(readFileSync(flags.manifest, 'utf8')));
    manifest = { ...manifest, definition: upgradeDefinition(manifest.definition) };
  } else if (templatePath) {
    const inputs: Record<string, string> = {};
    for (const pair of flags.input) {
      const eq = pair.indexOf('=');
      if (eq <= 0) fail(`--input must be <key>=<path>, got "${pair}"`);
      inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    let window: { from: string; to: string } | null = null;
    if (flags.window) {
      const [from, to] = flags.window.split(',');
      if (!from || !to) fail('--window must be <fromISO>,<toISO>');
      window = { from, to };
    }
    manifest = buildLocalManifest({
      definition: loadDefinition(templatePath),
      inputs,
      runId: flags.runId ?? `local-${Date.now()}`,
      window,
    });
  } else {
    fail(`run needs a template path or --manifest\n${USAGE}`);
  }

  const runId = flags.runId ?? manifest.runId;
  const runDir = path.resolve(flags.out, runId);
  const formats = captureFormatsOf(manifest.definition);
  const secretsFile = flags.secrets
    ? (JSON.parse(readFileSync(flags.secrets, 'utf8')) as Record<string, string>)
    : undefined;
  const modelDirs = flags.modelsDir.length > 0 ? flags.modelsDir : defaultModelDirs();
  const progress = flags.progress === 'json' ? ndjsonProgress((line) => console.log(line)) : undefined;

  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) {
    console.error(
      'xwe: warning: no ffmpeg found (FFMPEG_PATH, PATH, or ffmpeg-static) — video nodes will fail',
    );
  }

  const startedAt = Date.now();
  progress?.runStatus({ status: 'running' });
  let outcome: EngineRunOutcome;
  try {
    outcome = await runGraph(
      {
        runId,
        mode: manifest.mode,
        deviceId: manifest.deviceId,
        window: manifest.window
          ? { fromMs: Date.parse(manifest.window.from), toMs: Date.parse(manifest.window.to) }
          : null,
        definition: manifest.definition,
        bindings: Object.fromEntries(manifest.inputs.map((i) => [i.nodeId, i.binding])),
      },
      {
        sources: localSources({ modelDirs }),
        artifacts: localArtifactSink(runDir),
        secrets: localSecretReader({ env: process.env, secretsFile }),
        ...(progress ? { progress } : {}),
        ...(manifest.limits.maxRuntimeSeconds
          ? { deadlineMs: manifest.limits.maxRuntimeSeconds * 1000 }
          : {}),
        log: (m) => console.error(`[engine] ${m}`),
      },
    );
  } catch (err) {
    // Engine-level crash: still land a result.json, like the cloud targets.
    const message = err instanceof Error ? err.message : String(err);
    outcome = {
      status: 'failed',
      error: message,
      failedNodeId: null,
      steps: [],
      events: [],
      captures: {},
      metrics: { nodes: manifest.definition.nodes.length, okSteps: 0, events: 0, messages: 0 },
    };
  }

  const result = writeLocalRunArtifacts(runDir, runId, outcome, formats);
  if (flags.emitVideo && outcome.status === 'succeeded') {
    await emitVisualizationVideos({
      runDir,
      definition: manifest.definition,
      log: (m) => console.error(`[xwe] ${m}`),
    });
  }
  progress?.runStatus({
    status: outcome.status,
    error: outcome.error,
    failedNodeId: outcome.failedNodeId,
  });

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
    });
  }
  console.error(USAGE);
  return command === undefined || command === '--help' || command === 'help' ? 0 : 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`xwe: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  },
);
