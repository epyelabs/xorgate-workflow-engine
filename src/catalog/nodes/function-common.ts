import { z } from 'zod';
import type { NodeTypeDef } from '../types';
import { defineNode } from '../types';
import type { FunctionLanguage } from '../../engine/function-runtime';

/**
 * What the two code function nodes share (distribution M7, design §8, docs
 * workflows/functions): the config schema (the web editor's shape: a working
 * copy, published snapshots and which one is deployed), the version rule and
 * the def. The executors are in ../../engine/function-runtime.
 */

/** The working copy and every snapshot are bounded so a template stays a template. */
export const FUNCTION_CODE_MAX_BYTES = 256 * 1024;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const codeSchema = z
  .string()
  .max(FUNCTION_CODE_MAX_BYTES, `code must be at most ${FUNCTION_CODE_MAX_BYTES} characters`);

const handlerSchema = z
  .string()
  .min(1)
  .regex(IDENTIFIER, 'handler must be an identifier');

export const functionVersionSchema = z.object({
  version: z.number().int().positive(),
  code: codeSchema,
  handler: handlerSchema.default('handler'),
  publishedAt: z.string().min(1),
  description: z.string().optional(),
});
export type FunctionVersionSnapshot = z.infer<typeof functionVersionSchema>;

/** The default working copy per language: the editor's starter handler, a passthrough. */
export const DEFAULT_CODE: Record<FunctionLanguage, string> = {
  javascript: `/**
 * Xorgate code function (JavaScript).
 *
 * Called once per JSON event arriving on the "event" input. Whatever the
 * handler returns is emitted on the "result" output; return null or
 * undefined to drop the event.
 */
async function handler(event, context) {
  context.log("received event", event)

  return {
    ...event,
    processedAt: new Date().toISOString(),
  }
}
`,
  python: `"""Xorgate code function (Python).

Called once per JSON event arriving on the "event" input. Whatever the
handler returns is emitted on the "result" output; return None to drop
the event.
"""

def handler(event, context):
    context.log("received event", event)

    return {
        **event,
        "processed": True,
    }
`,
};

export function functionConfigSchema(language: FunctionLanguage): z.ZodTypeAny {
  return z.object({
    handler: handlerSchema.default('handler').describe('Name of the function invoked per event.'),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(30000)
      .default(3000)
      .describe('Per-invocation deadline in milliseconds; on expiry the process is killed and the step fails.'),
    memoryMb: z
      .number()
      .int()
      .min(128)
      .max(2048)
      .default(256)
      .describe('Memory limit for the function process (the heap for JavaScript, the address space for Python).'),
    code: codeSchema.default(DEFAULT_CODE[language]).describe('The working copy ($LATEST).'),
    versions: z
      .array(functionVersionSchema)
      .default([])
      .describe('Published snapshots, newest first: { version, code, handler, publishedAt, description? }.'),
    deployedVersion: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .describe('The snapshot that runs, or null for the working copy.'),
  });
}

export interface FunctionConfig {
  handler: string;
  timeoutMs: number;
  memoryMb: number;
  code: string;
  versions: FunctionVersionSnapshot[];
  deployedVersion: number | null;
}

/** The code a node runs: `deployedVersion` when set and present in `versions`, else the working copy. */
export interface ResolvedFunctionCode {
  code: string;
  handler: string;
  /** `"$LATEST"` for the working copy, the snapshot number otherwise (what `context.functionVersion` is). */
  functionVersion: '$LATEST' | number;
  /** `$LATEST` or `v<n>`, for step summaries and reports. */
  label: string;
}

export function resolveFunctionCode(cfg: FunctionConfig, version?: number): ResolvedFunctionCode {
  const wanted = version ?? cfg.deployedVersion;
  if (wanted !== null && wanted !== undefined) {
    const snapshot = cfg.versions.find((v) => v.version === wanted);
    if (snapshot) {
      return { code: snapshot.code, handler: snapshot.handler, functionVersion: snapshot.version, label: `v${snapshot.version}` };
    }
    if (version !== undefined) {
      const have = cfg.versions.map((v) => v.version);
      throw new Error(
        `version ${version} is not in the node's versions (${have.length > 0 ? `have: ${have.join(', ')}` : 'none published'})`,
      );
    }
  }
  return { code: cfg.code, handler: cfg.handler, functionVersion: '$LATEST', label: '$LATEST' };
}

const ports: Pick<NodeTypeDef, 'inputs' | 'outputs'> = {
  inputs: [{ id: 'event', label: 'Event', channel: 'json', cardinality: 'many', required: false }],
  outputs: [{ id: 'result', label: 'Result', channel: 'json', tag: 'result', cardinality: 'many', required: false }],
};

export function functionNodeDef(language: FunctionLanguage): NodeTypeDef {
  const javascript = language === 'javascript';
  return defineNode({
    type: `function.${language}`,
    version: 1,
    group: 'function',
    label: javascript ? 'JavaScript Function' : 'Python Function',
    description: javascript
      ? 'Runs your JavaScript handler on each incoming event in a sandboxed child process; the return value is emitted as a result.'
      : 'Runs your Python handler on each incoming event in a sandboxed child process; the return value is emitted as a result.',
    ui: { icon: javascript ? 'braces' : 'file-code', editor: 'code' },
    ...ports,
    config: functionConfigSchema(language),
    requires: [],
    runtime: { target: 'any' },
  });
}
