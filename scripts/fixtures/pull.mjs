#!/usr/bin/env node
/**
 * `npm run fixtures:pull`: fetch the large golden fixtures listed in
 * fixtures/fixtures.json into fixtures/, verifying sha256 and size. A file
 * that is already present with the right hash is left alone, so this is
 * cheap to run before every test (`npm test` does). Standalone on purpose:
 * it runs before the build.
 *
 *   node scripts/fixtures/pull.mjs [--force]
 *   XWE_FIXTURES_URL=https://models.example.internal node scripts/fixtures/pull.mjs
 *
 * `url` entries are relative to `baseUrl` (or absolute); `XWE_FIXTURES_URL`
 * replaces `baseUrl`. http(s): and file: URLs are both accepted.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifestPath = join(root, 'fixtures', 'fixtures.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const force = process.argv.includes('--force');
const baseUrl = (process.env.XWE_FIXTURES_URL && process.env.XWE_FIXTURES_URL.trim()) || manifest.baseUrl;

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const mb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} kB`);

function resolveUrl(url) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return `${baseUrl.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

async function openStream(url) {
  if (url.startsWith('file:')) {
    const p = fileURLToPath(url);
    if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`not found: ${p}`);
    return createReadStream(p);
  }
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (!res.body) throw new Error(`empty body for ${url}`);
  return Readable.fromWeb(res.body);
}

let failed = 0;
let pulled = 0;
let present = 0;
for (const [rel, entry] of Object.entries(manifest.files)) {
  const dest = join(root, 'fixtures', rel);
  if (!force && existsSync(dest) && statSync(dest).size === entry.sizeBytes && sha256(dest) === entry.sha256) {
    console.log(`ok    fixtures/${rel} (${mb(entry.sizeBytes)}, sha256 verified)`);
    present++;
    continue;
  }
  const url = resolveUrl(entry.url);
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part-${process.pid}`;
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    const body = await openStream(url);
    await pipeline(
      body,
      async function* (source) {
        for await (const chunk of source) {
          hash.update(chunk);
          bytes += chunk.length;
          yield chunk;
        }
      },
      createWriteStream(part),
    );
    const actual = hash.digest('hex');
    if (actual !== entry.sha256 || bytes !== entry.sizeBytes) {
      rmSync(part, { force: true });
      console.error(`FAIL  fixtures/${rel}: downloaded ${bytes} bytes sha256 ${actual.slice(0, 12)}…, fixtures.json says ${entry.sizeBytes} bytes ${entry.sha256.slice(0, 12)}…; nothing kept`);
      failed++;
      continue;
    }
    renameSync(part, dest);
    console.log(`pull  fixtures/${rel} <- ${url} (${mb(bytes)}, sha256 verified)`);
    pulled++;
  } catch (err) {
    rmSync(part, { force: true });
    console.error(`FAIL  fixtures/${rel} <- ${url}: ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}
console.log(`fixtures: ${present} present, ${pulled} pulled, ${failed} failed (source ${baseUrl})`);
if (failed > 0) {
  console.error('fixtures: set XWE_FIXTURES_URL to a mirror that serves the fixtures/ prefix (see fixtures/README.md)');
  process.exit(1);
}
