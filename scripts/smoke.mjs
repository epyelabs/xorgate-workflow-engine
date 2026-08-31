#!/usr/bin/env node
// M1 smoke: the copied engine loads, the catalog is whole, and nothing AWS
// snuck into the dependency tree. Run after `npm run build`.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failed = false;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

// 1. Engine entry loads and exports runGraph.
const engine = require(join(root, 'dist/engine/index.js'));
check('runGraph exported', typeof engine.runGraph === 'function');

// 2. Catalog registry loads with all 26 node defs.
const catalog = require(join(root, 'dist/catalog/index.js'));
const nodeTypes = catalog.listNodeTypes();
check('catalog has 26 node defs', nodeTypes.length === 26, `found ${nodeTypes.length}`);

// 3. Catalog payload builds; print its content hash + schema version.
const { buildCatalogPayload } = require(join(root, 'dist/catalog/serialize.js'));
const payload = buildCatalogPayload();
check(
  'catalog payload builds',
  typeof payload.catalogVersion === 'string' && payload.nodes.length === 26,
  `catalogVersion=${payload.catalogVersion} schemaVersion=${payload.schemaVersion}`,
);

// 4. No AWS packages anywhere: package.json, lockfile, and the src/ tree.
const AWS_RE = /@aws-sdk|aws-lambda/;
for (const f of ['package.json', 'package-lock.json']) {
  check(`${f} has no AWS packages`, !AWS_RE.test(readFileSync(join(root, f), 'utf8')));
}
const hits = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (AWS_RE.test(readFileSync(p, 'utf8'))) hits.push(p);
  }
})(join(root, 'src'));
check('src/ has no AWS references', hits.length === 0, hits.join(', '));

process.exit(failed ? 1 : 0);
