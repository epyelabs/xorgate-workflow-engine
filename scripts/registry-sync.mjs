#!/usr/bin/env node
/**
 * Publish a directory in the registry layout to a registry target, with a
 * generated `index.json` (an array of every manifest) at the root:
 *
 *   node scripts/registry-sync.mjs <source-root> <target> [--dry-run] [--overwrite] [--allow-unverified]
 *
 *   <source-root>   a directory laid out as <family>/<name>/<version>/{manifest.json,model.onnx}
 *   <target>        a directory (created; used by tests behind `npx serve`), or
 *                   s3://<bucket>[/<prefix>] (the owner's public registry; uses the
 *                   machine's own `aws` CLI and credentials; never exercised by tests)
 *
 * Every manifest must parse against the engine's schema, sit at the path its
 * identity says (family/name/version), and declare files["model.onnx"].sha256
 * that matches the file (run `xwe models check <dir>` to fill it in), because
 * `xwe models pull` verifies what this publishes. Versions are immutable: an
 * S3 version that already exists is skipped unless --overwrite is given.
 * Run `npm run build` first (the schema is read from dist/).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positionals = args.filter((a) => !a.startsWith('--'));
const [sourceArg, targetArg] = positionals;
if (!sourceArg || !targetArg) {
  console.error('usage: node scripts/registry-sync.mjs <source-root> <target-dir | s3://bucket[/prefix]> [--dry-run] [--overwrite] [--allow-unverified]');
  process.exit(2);
}
const dryRun = flags.has('--dry-run');
const overwrite = flags.has('--overwrite');
const allowUnverified = flags.has('--allow-unverified');

const schemaPath = join(root, 'dist/cjs/models/registry.js');
if (!existsSync(schemaPath)) {
  console.error('registry-sync: dist/ is missing; run `npm run build` first');
  process.exit(2);
}
const { modelManifestSchema } = require(schemaPath);

const source = resolve(sourceArg);
if (!existsSync(source) || !statSync(source).isDirectory()) {
  console.error(`registry-sync: ${source} is not a directory`);
  process.exit(2);
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const isDir = (p) => existsSync(p) && statSync(p).isDirectory();
const subdirs = (p) => readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

// 1. Collect and validate every version directory.
const versions = [];
const problems = [];
for (const family of subdirs(source).sort()) {
  for (const name of subdirs(join(source, family)).sort()) {
    for (const version of subdirs(join(source, family, name)).filter((v) => /^\d+$/.test(v)).sort((a, b) => Number(a) - Number(b))) {
      const dir = join(source, family, name, version);
      const rel = `${family}/${name}/${version}`;
      const manifestPath = join(dir, 'manifest.json');
      const modelPath = join(dir, 'model.onnx');
      if (!existsSync(manifestPath) || !existsSync(modelPath)) {
        problems.push(`${rel}: manifest.json and model.onnx are both required`);
        continue;
      }
      let manifest;
      try {
        manifest = modelManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
      } catch (err) {
        problems.push(`${rel}: manifest.json does not parse: ${err.message.split('\n')[0]}`);
        continue;
      }
      if (manifest.family !== family || manifest.name !== name || manifest.version !== Number(version)) {
        problems.push(`${rel}: manifest identity is ${manifest.family}/${manifest.name}/${manifest.version}, not the directory`);
        continue;
      }
      const declared = manifest.files?.['model.onnx'];
      const size = statSync(modelPath).size;
      if (!declared) {
        if (!allowUnverified) {
          problems.push(`${rel}: manifest has no files["model.onnx"].sha256 (run \`xwe models check ${dir}\`, or pass --allow-unverified)`);
          continue;
        }
      } else {
        const actual = sha256(modelPath);
        if (declared.sha256 !== actual) {
          problems.push(`${rel}: files["model.onnx"].sha256 is ${declared.sha256.slice(0, 12)}…, the file is ${actual.slice(0, 12)}…`);
          continue;
        }
        if (declared.sizeBytes !== size) {
          problems.push(`${rel}: files["model.onnx"].sizeBytes is ${declared.sizeBytes}, the file is ${size} bytes`);
          continue;
        }
      }
      versions.push({ rel, dir, manifest, size, verified: Boolean(declared) });
    }
  }
}
if (problems.length > 0) {
  for (const p of problems) console.error(`registry-sync: ${p}`);
  process.exit(1);
}
if (versions.length === 0) {
  console.error(`registry-sync: no <family>/<name>/<version>/ directories under ${source}`);
  process.exit(1);
}
const index = versions.map((v) => v.manifest);
const indexJson = JSON.stringify(index, null, 2) + '\n';

// 2. Publish.
function runAws(cliArgs) {
  if (dryRun) {
    console.log(`  (dry-run) aws ${cliArgs.join(' ')}`);
    return { status: 0, stdout: '' };
  }
  const res = spawnSync('aws', cliArgs, { encoding: 'utf8' });
  if (res.error) throw new Error(`aws CLI not runnable: ${res.error.message}`);
  return res;
}

if (targetArg.startsWith('s3://')) {
  const base = targetArg.replace(/\/+$/, '');
  let published = 0;
  let skipped = 0;
  for (const v of versions) {
    const dest = `${base}/${v.rel}/`;
    if (!overwrite) {
      const probe = runAws(['s3', 'ls', `${dest}manifest.json`]);
      if (!dryRun && probe.status === 0 && probe.stdout.trim() !== '') {
        console.log(`  skip    ${v.rel} (already published; versions are immutable, pass --overwrite to replace)`);
        skipped++;
        continue;
      }
    }
    const res = runAws(['s3', 'cp', '--recursive', '--only-show-errors', '--content-type', 'application/octet-stream', v.dir, dest]);
    if (res.status !== 0) {
      console.error(`registry-sync: upload of ${v.rel} failed:\n${res.stderr}`);
      process.exit(1);
    }
    // manifest.json goes up again with its own content type
    const m = runAws(['s3', 'cp', '--only-show-errors', '--content-type', 'application/json', join(v.dir, 'manifest.json'), `${dest}manifest.json`]);
    if (m.status !== 0) {
      console.error(`registry-sync: manifest upload of ${v.rel} failed:\n${m.stderr}`);
      process.exit(1);
    }
    console.log(`  publish ${v.rel} (model.onnx ${(v.size / 1048576).toFixed(1)} MB${v.verified ? ', sha256 in manifest' : ', UNVERIFIED'})`);
    published++;
  }
  const tmpIndex = join(root, 'out', `registry-index-${process.pid}.json`);
  mkdirSync(dirname(tmpIndex), { recursive: true });
  writeFileSync(tmpIndex, indexJson);
  const idx = runAws(['s3', 'cp', '--only-show-errors', '--content-type', 'application/json', '--cache-control', 'max-age=60', tmpIndex, `${base}/index.json`]);
  rmSync(tmpIndex, { force: true });
  if (idx.status !== 0) {
    console.error(`registry-sync: index.json upload failed:\n${idx.stderr}`);
    process.exit(1);
  }
  console.log(`  index   ${base}/index.json (${index.length} model${index.length === 1 ? '' : 's'})`);
  console.log(`registry-sync: ${published} published, ${skipped} skipped -> ${base}${dryRun ? ' (dry-run, nothing uploaded)' : ''}`);
} else {
  const target = resolve(targetArg);
  if (!dryRun) mkdirSync(target, { recursive: true });
  for (const v of versions) {
    const dest = join(target, v.rel);
    if (!dryRun) {
      mkdirSync(dest, { recursive: true });
      cpSync(v.dir, dest, { recursive: true });
    }
    console.log(`  copy    ${v.rel} (model.onnx ${(v.size / 1048576).toFixed(1)} MB${v.verified ? ', sha256 in manifest' : ', UNVERIFIED'})`);
  }
  if (!dryRun) writeFileSync(join(target, 'index.json'), indexJson);
  console.log(`  index   ${join(target, 'index.json')} (${index.length} model${index.length === 1 ? '' : 's'})`);
  console.log(`registry-sync: ${versions.length} version(s) -> ${target}${dryRun ? ' (dry-run, nothing written)' : ''}`);
  if (!isDir(target) && !dryRun) process.exit(1);
}
