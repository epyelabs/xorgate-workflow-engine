#!/usr/bin/env node
// Pivot rds-data telemetry rows (ts_ms, metric, value) into the frozen
// simulator CSV shape (source-telemetry.ts): ts,gps.lat,gps.lon,gps.speed.
// Usage: node scripts/fixtures/build-telemetry-csv.mjs <rows.json> <out.csv>
// The exact grab command for <rows.json> is in fixtures/README.md.
import { readFileSync, writeFileSync } from 'node:fs';

const [rowsPath, outPath] = process.argv.slice(2);
if (!rowsPath || !outPath) {
  console.error('usage: build-telemetry-csv.mjs <rows.json> <out.csv>');
  process.exit(1);
}
const METRICS = ['gps.lat', 'gps.lon', 'gps.speed'];
const rows = JSON.parse(readFileSync(rowsPath, 'utf8'));
const byTs = new Map();
for (const r of rows) {
  const ts = Math.round(Number(r.ts_ms));
  if (!byTs.has(ts)) byTs.set(ts, {});
  byTs.get(ts)[r.metric] = r.value;
}
const keys = [...byTs.keys()].sort((a, b) => a - b);
const lines = [`ts,${METRICS.join(',')}`];
for (const ts of keys) {
  const v = byTs.get(ts);
  if (METRICS.some((m) => v[m] == null)) continue;
  lines.push(`${ts},${METRICS.map((m) => v[m]).join(',')}`);
}
writeFileSync(outPath, lines.join('\n') + '\n');
const speeds = keys.map((k) => byTs.get(k)['gps.speed']).filter((s) => s != null);
console.log(
  `wrote ${outPath}: ${lines.length - 1} samples, ` +
    `${new Date(keys[0]).toISOString()} -> ${new Date(keys.at(-1)).toISOString()}, ` +
    `speed ${Math.min(...speeds)}-${Math.max(...speeds)} km/h`,
);
