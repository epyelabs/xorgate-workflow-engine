#!/usr/bin/env node
// M2 fixture verification: every fixture parses against the REAL engine
// contracts (compiled dist — run `npm run build` first).
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let failed = false;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}
const readJson = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const { workflowDefinitionSchema } = require(join(root, 'dist/schemas/workflows.js'));
const { validateDefinitionForPublish } = require(join(root, 'dist/validate.js'));
const { runManifestSchema } = require(join(root, 'dist/engine/manifest.js'));
const { parseTelemetryCsv } = require(join(root, 'dist/catalog/nodes/source-telemetry.js'));

// Templates: schema-parse + full publish validation against the catalog.
for (const f of ['overspeed', 'perimeter-person-detect', 'overspeed-osm']) {
  const raw = readJson(`fixtures/templates/${f}.json`);
  const parsed = workflowDefinitionSchema.safeParse(raw);
  check(`template ${f} parses (schemaVersion 2)`, parsed.success && raw.schemaVersion === 2);
  if (parsed.success) {
    const res = validateDefinitionForPublish(parsed.data);
    const errors = (res.issues ?? []).filter((i) => i.severity === 'error');
    check(
      `template ${f} publish-validates`,
      res.ok !== false && errors.length === 0,
      errors.map((i) => i.message).join('; '),
    );
  }
}

// Manifests: runManifestSchema (bindings are passthrough by design).
for (const f of ['overspeed', 'perimeter']) {
  const parsed = runManifestSchema.safeParse(readJson(`fixtures/manifests/${f}.manifest.json`));
  check(
    `manifest ${f} parses (manifestVersion 2)`,
    parsed.success,
    parsed.success ? '' : JSON.stringify(parsed.error.issues[0]),
  );
}

// Telemetry CSV: the executor's own parser, with the overspeed graph's filter.
const csv = readFileSync(join(root, 'fixtures/telemetry/window.csv'), 'utf8');
const { samples, skippedCells } = parseTelemetryCsv(csv, ['gps.lat', 'gps.lon', 'gps.speed']);
const speeds = samples.map((s) => s.signals['gps.speed']);
check(
  'telemetry CSV parses via parseTelemetryCsv',
  samples.length === 150 && skippedCells === 0,
  `${samples.length} samples, speed ${Math.min(...speeds)}-${Math.max(...speeds)} km/h`,
);
check('telemetry has a >10 km/h overspeed excursion', Math.min(...speeds) > 10);

// Binary fixtures present and sized sanely.
const video = statSync(join(root, 'fixtures/video/drive.mp4'));
check('video/drive.mp4 present', video.size > 1_000_000, `${(video.size / 1e6).toFixed(1)} MB`);
const onnx = statSync(join(root, 'fixtures/models/detection/yolov8n/1/model.onnx'));
check('yolov8n model.onnx present', onnx.size === 12851122, `${onnx.size} bytes (S3 size match)`);
const mm = readJson('fixtures/models/detection/yolov8n/1/manifest.json');
check('model manifest names yolov8n', JSON.stringify(mm).includes('yolov8n'));

process.exit(failed ? 1 : 0);
