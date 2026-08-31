# Fixtures

Real data grabbed read-only from xorgate **dev** (account 111910761410,
us-east-1) on 2026-08-31, for the golden runs described in the plan
(`xorgate/plans/portable_workflow_engine_architecture/`). Nothing here was
written back to xorgate.

## Templates (`templates/`)

Published schemaVersion-2 definitions, verbatim from the dev DB
(`workflow_template_versions.definition`, cluster `epye-sandbox-db`, database
`xorgatedb_dev`), pulled via `aws rds-data execute-statement`:

| File | Template (org Alocate, dev) | Version | Notes |
|---|---|---|---|
| `overspeed.json` | "Overspeed Detect" `bf730702-26de-4875-af12-34c53159abbc` | published v2 | **The golden case.** Telemetry-only: `source.telemetry` (gps.lat/lon/speed) → `telemetry.derivative` (speed_from_position → `speed_kph`) → `logic.threshold` (> 10 kph) → `output.event` (overspeed). Hermetic: no network, no model. |
| `perimeter-person-detect.json` | "Perimeter Person Detect" `13ee6db3-fdbe-4282-8d9a-1df1eb1fd518` | published v2 | The video+model case: `source.video` → `video.decode_sample` (2 fps) → `model.object_detection` (yolov8n) → `logic.detection_gate` (person) → `output.event`. Exercises the detection path and the model fixture. |
| `overspeed-osm.json` | "Overspeed via OSM (scenario 2c demo)" `4daaeb95-e50b-4649-9dab-0fa2d8df7af2` | published v1 | The connector case. NOT for the golden test: it calls public Overpass at run time (real intermittent 429s, see workflow_refactor M7 notes). Kept for manual connector testing. |

Grab command (per template id/version):

```
aws rds-data execute-statement --region us-east-1 \
  --resource-arn arn:aws:rds:us-east-1:111910761410:cluster:epye-sandbox-db \
  --secret-arn "arn:aws:secretsmanager:us-east-1:111910761410:secret:epye-sandbox/xorgate-db-credentials-PxoDqV" \
  --database xorgatedb_dev --format-records-as JSON \
  --sql "SELECT definition FROM workflow_template_versions WHERE template_id='<id>' AND version=<n> AND status='published'"
```

## Telemetry (`telemetry/window.csv`)

A real 150 s highway drive window, device `2f5002f9-4e3d-495c-bb65-9fc5535c095d`
(dev), **2026-08-12 23:56:00–23:58:29 UTC** (Hwy 427, Toronto): 1 Hz GPS,
speeds 74–118 kph, so the > 10 kph overspeed condition holds throughout and the
golden event must fire. Columns follow the frozen simulator CSV contract
(`source-telemetry.ts`): `ts` (epoch ms) + one numeric column per signal:
`ts,gps.lat,gps.lon,gps.speed` (`gps.speed` unit is km/h).

Source: `telemetry_readings` in the dev DB (same cluster as above), metrics
`gps.lat`/`gps.lon`/`gps.speed`, pivoted to one row per timestamp (rows missing
any of the three metrics dropped). Grab + pivot:

```
aws rds-data execute-statement --region us-east-1 \
  --resource-arn arn:aws:rds:us-east-1:111910761410:cluster:epye-sandbox-db \
  --secret-arn "arn:aws:secretsmanager:us-east-1:111910761410:secret:epye-sandbox/xorgate-db-credentials-PxoDqV" \
  --database xorgatedb_dev --format-records-as JSON \
  --sql "SELECT extract(epoch FROM ts)*1000 AS ts_ms, metric, value FROM telemetry_readings WHERE device_id='2f5002f9-4e3d-495c-bb65-9fc5535c095d' AND metric IN ('gps.lat','gps.lon','gps.speed') AND ts BETWEEN '2026-08-12 23:56:00' AND '2026-08-12 23:58:30' ORDER BY ts" \
  --query formattedRecords --output text > telemetry-rows.json
node scripts/fixtures/build-telemetry-csv.mjs telemetry-rows.json fixtures/telemetry/window.csv
```

## Video (`video/drive.mp4`)

The first 25 s of a segment from the SAME drive as the telemetry window
(stream copy, no re-encode): session `019ff848-dad9-7ad0-90ad-42cb81390eb9`
(device `2f5002f9-...`, cam0), segment `00034`. Per its sidecar the segment
starts **2026-08-12T23:56:31.867Z** (NTP time source, 59.98 s, h264 1280x720
15 fps), so the clip covers 23:56:31.867–23:56:56.867 UTC — fully inside the
telemetry window, driving ~75–91 km/h. Highway footage with vehicles in frame,
so yolov8n has real detections. `manifests/perimeter.manifest.json` `startedAt`
carries the sidecar-exact value. Provenance keys (bucket
`xorgate-core-dev-111910761410-us-east-1`):

```
media-sessions/v1/2f5002f9-4e3d-495c-bb65-9fc5535c095d/cam0/019ff848-dad9-7ad0-90ad-42cb81390eb9/00034.mp4
media-sessions/v1/2f5002f9-4e3d-495c-bb65-9fc5535c095d/cam0/019ff848-dad9-7ad0-90ad-42cb81390eb9/00034.json  (sidecar: startTs 1786578991867)
```

Grab + trim (macOS dev machines have no system ffmpeg; the trim script drives
an `ffmpeg-static` binary the way core-service's engine-smoke.ts does):

```
aws s3 cp s3://xorgate-core-dev-111910761410-us-east-1/media-sessions/v1/2f5002f9-4e3d-495c-bb65-9fc5535c095d/cam0/019ff848-dad9-7ad0-90ad-42cb81390eb9/00034.mp4 /tmp/00034.mp4
node scripts/fixtures/trim-video.mjs /tmp/00034.mp4 fixtures/video/drive.mp4 25 <path-to-ffmpeg>
```

## Model (`models/detection/yolov8n/1/`)

`model.onnx` (12.85 MB) + `manifest.json`, verbatim from the dev S3 model
registry. The directory layout mirrors the registry keys EXACTLY
(`models/<family>/<name>/<version>/`, family `detection` — see
`src/models/registry.ts`), per the plan's local-layout-mirrors-S3 rule:

```
aws s3 cp s3://xorgate-core-dev-111910761410-us-east-1/models/detection/yolov8n/1/manifest.json fixtures/models/detection/yolov8n/1/manifest.json
aws s3 cp s3://xorgate-core-dev-111910761410-us-east-1/models/detection/yolov8n/1/model.onnx fixtures/models/detection/yolov8n/1/model.onnx
```

## Manifests (`manifests/`)

Hand-written run manifests against `src/engine/manifest.ts`
(`runManifestSchema`, manifestVersion 2), one per golden case, with LOCAL
source bindings:

- `overspeed.manifest.json` — binds `n1` with the EXISTING `telemetry_csv`
  kind; on the local target the `s3Key` field is resolved as a LOCAL PATH by
  the fetchText seam (M3 decision: reuse existing kinds, zero executor edits).
- `perimeter.manifest.json` — binds `n1` with the EXISTING `video_local`
  kind (`source-video.ts` already ships it for "tests / already-local media").
- `output.bucket` is `"local"`: LocalTargetIO treats the bucket as a label and
  writes `out/<runId>/` mirroring `output.prefix`'s key layout.

## Sizes

| File | Size | Committed? |
|---|---|---|
| templates/*.json | < 5 KB each | yes |
| telemetry/window.csv | ~7 KB (150 samples) | yes |
| video/drive.mp4 | 3.0 MB (25 s trim) | yes |
| models/detection/yolov8n/1/model.onnx | 12.85 MB | yes (under the ~25 MB line) |
| models/detection/yolov8n/1/manifest.json | 1.7 KB | yes |
