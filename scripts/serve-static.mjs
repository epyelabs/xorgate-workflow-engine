#!/usr/bin/env node
// A dependency-free static file server for a registry mirror or a fixtures
// mirror during tests: `node scripts/serve-static.mjs <dir> [port]`. Prints
// `listening <url>` once bound (port 0 picks a free one). The acceptance
// commands use `npx serve` for the same job; the golden test uses this so it
// needs nothing installed and the server lives outside the test process
// (spawnSync blocks the test's own event loop).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';

const [dirArg, portArg] = process.argv.slice(2);
if (!dirArg) {
  console.error('usage: node scripts/serve-static.mjs <dir> [port]');
  process.exit(2);
}
const dir = resolve(dirArg);
const TYPES = { '.json': 'application/json', '.onnx': 'application/octet-stream', '.mp4': 'video/mp4', '.csv': 'text/csv' };

const server = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  const file = resolve(join(dir, pathname));
  if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  const body = readFileSync(file);
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-length': body.length });
  res.end(body);
});
server.listen(Number(portArg ?? 0), '127.0.0.1', () => {
  console.log(`listening http://127.0.0.1:${server.address().port}`);
});
