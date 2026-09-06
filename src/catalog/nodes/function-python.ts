import type { EngineEmit, EngineInChannel, EngineRunCtx } from '../types';
import { runFunctionNode } from '../../engine/function-runtime';
import { functionConfigSchema, functionNodeDef, resolveFunctionCode, type FunctionConfig } from './function-common';

// `function.python` (distribution M7, docs workflows/functions): the template
// author's Python handler, run once per incoming json event in a sandboxed
// child process (`python3` from PATH, isolated, standard library only); the
// return value is emitted as json/result with the event's ts, None drops the
// event. The config shape, the version rule and the def are shared with
// function.javascript in ./function-common; the runtime is
// ../../engine/function-runtime.

const configSchema = functionConfigSchema('python');

export const def = functionNodeDef('python');

export const executor = async function* functionPython(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
): AsyncIterable<EngineEmit> {
  const cfg = configSchema.parse(config) as FunctionConfig;
  yield* runFunctionNode('python', resolveFunctionCode(cfg), cfg, inputs, ctx);
};
