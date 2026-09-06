import type { EngineEmit, EngineInChannel, EngineRunCtx } from '../types';
import { runFunctionNode } from '../../engine/function-runtime';
import { functionConfigSchema, functionNodeDef, resolveFunctionCode, type FunctionConfig } from './function-common';

// `function.javascript` (distribution M7, docs workflows/functions): the
// template author's JavaScript handler, run once per incoming json event in
// a sandboxed child process (the engine's own node with its permission model
// on); the return value is emitted as json/result with the event's ts, null
// or undefined drops the event. The config shape, the version rule and the
// def are shared with function.python in ./function-common; the runtime is
// ../../engine/function-runtime.

const configSchema = functionConfigSchema('javascript');

export const def = functionNodeDef('javascript');

export const executor = async function* functionJavascript(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
): AsyncIterable<EngineEmit> {
  const cfg = configSchema.parse(config) as FunctionConfig;
  yield* runFunctionNode('javascript', resolveFunctionCode(cfg), cfg, inputs, ctx);
};
