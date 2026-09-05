# @xorgate/workflow-engine

The portable xorgate workflow engine as one npm package: the library
(`createEngine`, `runGraph`, the full 26-node catalog, every schema) and the
`xwe` command. Inputs are sources (video, CSV, JSON, ...) plus a workflow
template (JSON, definition schemaVersion 2); outputs are model records/events
plus a trace (`events.jsonl` + `result.json`) and, on request, annotated video.
Not published yet: it runs from this checkout (see Build / verify) until the
0.1.0 release.

```ts
import { createEngine } from "@xorgate/workflow-engine"
import { localHost } from "@xorgate/workflow-engine/local"

const engine = createEngine({ host: localHost({ modelDirs: ["./models"], outDir: "./out" }) })
const run = await engine.run({ template: "./overspeed.json", inputs: { telemetry: "./window.csv" } })
console.log(run.result.status, run.result.events.length, run.runDir)
```

Entry points: `.` (core, catalog, schemas, seams), `./local` (the file host),
`./testing` (the conformance kit). The CLI is the `bin`, not an export.

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
    --input video=fixtures/video/drive.mp4 --models-dir fixtures/models --out ./out
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
- Models resolve from `--models-dir` roots first, then the cache
  (`XWE_MODELS_DIR`, default `~/.xorgate/models`), then, only with `--pull`
  or `XWE_MODELS_PULL=1`, the registry (`XWE_MODEL_REGISTRY`, default
  `https://models.xorgate.io`), all in the registry layout
  (`<family>/<name>/<version>/{manifest.json,model.onnx}`). `xwe models
  list | pull | path | check` manage the cache and validate a model
  directory; pulls verify the manifest's `files.sha256`. The checkout's
  fixture model is a root like any other: `--models-dir fixtures/models`.
- Large fixtures are pulled, not committed: `npm run fixtures:pull` (run by
  `npm test`) fetches them per `fixtures/fixtures.json`.
- Secrets: env `XORGATE_SECRET_<LOGICAL_NAME>` or `--secrets secrets.json`
  (`{ "anthropic-api-key": "..." }`); only graphs with connector/VLM nodes
  need any. `--progress json` emits NDJSON status/step/event lines on stdout.
- ffmpeg: `FFMPEG_PATH`, else PATH, else the `ffmpeg-static` devDependency
  (docker images apt-install it instead).
- `--emit-video` muxes each visualization node's annotated frames into
  `out/<runId>/video/<nodeId>.mp4` (h264, fps from the feeding decode_sample's
  config). Runner-level only — no catalog node, no cloud impact.
- Exit codes: 0 success, 1 run failed (failing node named on stderr), 2 usage.
- `xwe doctor` prints node, ffmpeg, the ONNX Runtime binding, the VLM client,
  the model roots and their contents, the registry and the catalog hash; exits
  1 when ffmpeg or the ONNX binding is missing.
- A hand-written `--manifest` may say `path` where the platform kinds say
  `s3Key` (`telemetry_csv`, `telemetry_materialized`, `video_file`, session
  segments); the local host folds the alias before the engine sees it.

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
npm run smoke            # builds, loads both module formats, asserts 26 catalog nodes + no cloud deps
npm test                 # builds, runs the golden runs through the CLI and the library
npm run verify:tarball   # npm pack, install into fresh projects, run through npx / import / require
npm run ci               # all of the above
```

The build is dual ESM + CJS with declaration files (`dist/esm`, `dist/cjs`),
from one extensionless-import source tree: `scripts/finalize-build.mjs` adds
the extensions the ESM loader needs and places `import.meta.url` in the one
file that lazily requires optional packages. The `xwe` bin is the CJS build.
