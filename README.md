# xorgate-workflow-engine

The portable xorgate workflow engine: `runGraph` plus the full 26-node catalog,
extracted as a standalone, AWS-free codebase. Inputs are sources (video, CSV,
JSON, ...) plus a workflow template (JSON, definition schemaVersion 2); outputs
are model records/events plus a trace (`events.jsonl` + `result.json`), with
processed video to follow. The local runner (LocalTargetIO + `xwe` CLI) lands
in later milestones.

Plan and architecture: `xorgate/plans/portable_workflow_engine_architecture/`
(in the xorgate workspace, not this repo).

## Divergence baseline

Copied from `xorgate/backend/xorgate-core-service` at commit:

```
a8862e771ff16825fec2cb458dda2575bf46a375
```

This is the permanent baseline for diffing. The copies WILL drift and that is
accepted; the frozen contracts (definition schemaVersion 2, manifest/result
schemas, catalog node defs) are the compatibility line, not the code.
Periodically diff `src/workflows` in core-service against this commit to
cherry-pick fixes in either direction. Re-integration into core-service is the
north star, out of scope here.

## Copy map (from core-service)

| Source | Here | Notes |
|---|---|---|
| `src/workflows/engine/` | `src/engine/` | minus `target.ts` (CloudTargetIO) and `live-ingest.ts` (AWS IoT MQTT-over-WSS transport, hand-rolled SigV4; only `engine-runner/main.ts` imported it) |
| `src/workflows/catalog/` | `src/catalog/` | verbatim, all 26 nodes |
| `src/workflows/models/registry.ts` | `src/models/registry.ts` | schema only; S3 `store.ts` stays behind |
| `src/workflows/validate.ts` | `src/validate.ts` | needed by `engine/index.ts` (resolvePort); AWS-free |
| `src/workflows/compat.ts` | `src/compat.ts` | needed by `catalog/serialize.ts` and `validate.ts`; AWS-free |
| `src/schemas/workflows.ts` | `src/schemas/workflows.ts` | the definition zod schema (frozen contract); pure zod |
| `engine-runner/Dockerfile` | `Dockerfile` | path fixes only; multi-arch build comes later |

Only import-path edits were made (the `schemas/workflows` specifiers); zero
executor-logic changes. `org-credentials.ts` was not needed: only `target.ts`
imported it.

## Usage (M3: the local runner)

```
npx xwe validate fixtures/templates/overspeed.json
npx xwe run fixtures/templates/overspeed.json \
    --input telemetry=fixtures/telemetry/window.csv --out ./out
npx xwe run fixtures/templates/perimeter-person-detect.json \
    --input video=fixtures/video/drive.mp4 --out ./out
```

- `validate` strict-parses a template against the catalog and prints the
  required `--input` keys and secrets. `run` also accepts a prebuilt
  `--manifest manifest.json` instead of a template.
- Artifacts land in `out/<runId>/` mirroring the cloud S3 run-prefix layout
  exactly: `events.jsonl`, `outputs/<nodeId>/records.*`,
  `frames/<nodeId>/<seq>.jpg`, `result.json` written last.
- Bindings reuse the EXISTING kinds (zero executor edits): `video_local`
  for video files; `telemetry_csv` / `telemetry_materialized` with `s3Key`
  resolved as a local path for telemetry.
- Models resolve from `--models-dir`, else `./fixtures/models`, else
  `~/.xorgate/models`, in the registry layout
  (`<family>/<name>/<version>/{manifest.json,model.onnx}`). No network.
- Secrets: env `XORGATE_SECRET_<LOGICAL_NAME>` or `--secrets secrets.json`
  (`{ "anthropic-api-key": "..." }`); only graphs with connector/VLM nodes
  need any. `--progress json` emits NDJSON status/step/event lines on stdout.
- ffmpeg: `FFMPEG_PATH`, else PATH, else the `ffmpeg-static` devDependency
  (docker images apt-install it instead).
- `--emit-video` muxes each visualization node's annotated frames into
  `out/<runId>/video/<nodeId>.mp4` (h264, fps from the feeding decode_sample's
  config). Runner-level only — no catalog node, no cloud impact.
- Exit codes: 0 success, 1 run failed (failing node named on stderr), 2 usage.

## Docker (the supported path)

```
docker build -t xwe .                                        # native arch
docker buildx build --platform linux/amd64,linux/arm64 -t xwe .   # multi-arch
docker run --rm -v "$PWD":/work xwe \
    run fixtures/templates/overspeed.json \
    --input telemetry=fixtures/telemetry/window.csv --out out
```

The image apt-installs ffmpeg and sets the entrypoint to the CLI; mount your
workspace (templates, inputs, `fixtures/models`, output dir) at `/work`.

Per host:

| Host | Path |
|---|---|
| Linux (amd64/arm64) | docker (supported), or bare node 20 + system ffmpeg |
| macOS dev machines | bare `node` for development (`ffmpeg-static` covers ffmpeg); docker works too |
| Raspberry Pi 5 | the arm64 image (proven in M5) |

## Build / verify

```
npm ci
npm run typecheck
npm run smoke   # builds, imports runGraph, asserts 26 catalog nodes + no AWS deps
npm test        # builds, runs the golden overspeed + perimeter fixture runs
```

Module system is CommonJS, matching the source's `engine-runner/tsconfig.json`
(the copied code uses extensionless relative imports).
