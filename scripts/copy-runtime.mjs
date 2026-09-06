#!/usr/bin/env node
/**
 * Copies the function runners (runtime/) into dist/runtime/ so the package
 * ships them: dist/runtime/js/runner.cjs and dist/runtime/python/runner.py.
 * They are plain files, not TypeScript, and the engine locates them at run
 * time relative to the package root (src/engine/function-runtime.ts). Run by
 * `npm run build` after the two tsc builds; independent of finalize-build.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'runtime');
const to = join(root, 'dist/runtime');

for (const file of ['js/runner.cjs', 'python/runner.py']) {
  if (!existsSync(join(from, file))) throw new Error(`copy-runtime: ${join('runtime', file)} is missing`);
}
rmSync(to, { recursive: true, force: true });
mkdirSync(dirname(to), { recursive: true });
cpSync(from, to, { recursive: true, filter: (src) => !src.includes('__pycache__') });
console.log('copy-runtime: runtime/ -> dist/runtime/ (js/runner.cjs, python/runner.py)');
