#!/usr/bin/env node
/**
 * Post-processing for the dual build (copied from @xorgate/sdk, extended for
 * this package's extensionless source imports):
 *
 * 1. The package is `"type": "module"`, so drop a `{ "type": "commonjs" }`
 *    marker into dist/cjs and a `{ "type": "module" }` one into dist/esm.
 * 2. The source uses extensionless relative imports (it started life as
 *    CommonJS). Node's ESM loader needs full paths, so rewrite every relative
 *    specifier in dist/esm (`.js` and `.d.ts`) to `./x.js` or `./x/index.js`.
 * 3. `import.meta` cannot appear in a file that also compiles as CommonJS, so
 *    src/engine/lazy-require.ts carries a placeholder string that becomes
 *    `import.meta.url` here, in the ESM output only.
 * 4. Mark the CLI entry executable (npm does this on install; a checkout
 *    running `npx xwe` from dist/ needs it too).
 */
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const esm = join(root, 'dist/esm');
const cjs = join(root, 'dist/cjs');

for (const [dir, type] of [
  [cjs, 'commonjs'],
  [esm, 'module'],
]) {
  if (!existsSync(dir)) throw new Error(`${dir} is missing; run both tsc builds first`);
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ type }, null, 2)}\n`);
}

// --- 2. extensionful relative specifiers in dist/esm ------------------------
const SPECIFIER_RE = /((?:\bfrom|\bimport|\bexport\s*\*\s*from|\bexport\s*\{[^}]*\}\s*from)\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\2/g;
let rewritten = 0;
let filesTouched = 0;
const unresolved = [];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function withExtension(fromFile, spec) {
  if (/\.(?:m?js|json|d\.ts)$/.test(spec)) return spec;
  const base = resolve(dirname(fromFile), spec);
  if (existsSync(`${base}.js`)) return `${spec}.js`;
  if (existsSync(base) && statSync(base).isDirectory() && existsSync(join(base, 'index.js'))) {
    return `${spec}/index.js`;
  }
  unresolved.push(`${fromFile}: ${spec}`);
  return spec;
}

for (const file of walk(esm)) {
  if (!/\.(?:js|d\.ts)$/.test(file)) continue;
  const source = readFileSync(file, 'utf8');
  let count = 0;
  const out = source.replace(SPECIFIER_RE, (whole, lead, quote, spec) => {
    const next = withExtension(file, spec);
    if (next === spec) return whole;
    count++;
    return `${lead}${quote}${next}${quote}`;
  });
  if (count > 0) {
    writeFileSync(file, out);
    rewritten += count;
    filesTouched++;
  }
}
if (unresolved.length > 0) {
  throw new Error(`relative imports that resolve to nothing in dist/esm:\n  ${unresolved.join('\n  ')}`);
}

// --- 3. import.meta.url in the ESM lazy-require ------------------------------
const PLACEHOLDER = "'__XWE_ESM_MODULE_URL__'";
const lazy = join(esm, 'engine/lazy-require.js');
const lazySource = readFileSync(lazy, 'utf8');
const hits = lazySource.split(PLACEHOLDER).length - 1;
if (hits !== 1) throw new Error(`expected exactly one ${PLACEHOLDER} in ${lazy}, found ${hits}`);
writeFileSync(lazy, lazySource.replace(PLACEHOLDER, 'import.meta.url'));

// --- 4. the bin ---------------------------------------------------------------
const bin = join(cjs, 'cli/index.js');
if (!readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node')) {
  throw new Error(`${bin} lost its shebang line`);
}
chmodSync(bin, 0o755);

console.log(
  `finalize-build: wrote dist/{cjs,esm}/package.json; ${rewritten} relative specifier(s) in ${filesTouched} ESM file(s) given extensions; import.meta.url placed in engine/lazy-require.js; bin marked executable`,
);
