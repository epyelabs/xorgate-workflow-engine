# @xorgate/workflow-engine

The xorgate workflow engine as one npm package and one container image. It
runs a workflow template (a JSON graph of 28 catalog nodes: video decoding,
object detection, depth, segmentation, telemetry math, logic, events,
captures, annotated video, and your own JavaScript or Python functions) over
local files, with no account, no API key and
no network unless a node in the graph asks for one. The same package is the
`xwe` command, a library you embed, and a host contract you can implement
over your own storage.

Documentation: <https://docs.xorgate.io/docs/workflows> (the Workflows
section is the manual; the pages under it describe this package).
Compatibility policy: [docs/compatibility.md](./docs/compatibility.md).
Changes: [CHANGELOG.md](./CHANGELOG.md). License: MIT.

## Install

```bash
npm install @xorgate/workflow-engine        # library + the xwe command
npm install -g @xorgate/workflow-engine     # xwe on your PATH
npm install --omit=optional @xorgate/workflow-engine   # without ONNX Runtime and the VLM client (telemetry-only hosts)
```

`onnxruntime-node` (model nodes) and the VLM provider client (`model.vlm`)
are optional dependencies. Video nodes need `ffmpeg` on `PATH` or in
`FFMPEG_PATH`; npm never installs it. `xwe doctor` tells you what a machine
is missing and how to fix it.

The image bundles Node, ffmpeg and the ONNX Runtime binding for its own
architecture (linux/amd64 and linux/arm64):

```bash
docker run --rm -v "$PWD":/work ghcr.io/epyelabs/xwe doctor
docker run --rm -v "$PWD":/work ghcr.io/epyelabs/xwe run overspeed.json --input telemetry=window.csv --out out
```

## Run

```bash
xwe validate template.json                                   # what a run needs: inputs, secrets, models
xwe run template.json --input video=drive.mp4 --out out       # artifacts land in out/<runId>/
xwe run template.json --input telemetry=window.csv --progress json   # NDJSON progress on stdout
xwe models pull detection/yolov8n                             # into ~/.xorgate/models, sha256 verified
xwe models check ./my-models/detection/forklift/1             # validate a model directory you made
xwe function test template.json fn --event event.json        # one event through a function node's handler
xwe doctor                                                    # ffmpeg, ONNX Runtime, python3, models, registry, catalog
```

- **Inputs** bind source nodes to files by key: `video`, `telemetry`, or a
  node id. A `.csv` or `.jsonl` becomes a telemetry binding; a video file a
  video binding. `--manifest` runs a prebuilt run manifest instead.
- **Artifacts**: `out/<runId>/events.jsonl`, `outputs/<nodeId>/records.*`,
  `frames/<nodeId>/<seq>.jpg`, and `result.json` written last. `--emit-video`
  muxes each visualization node's frames into `video/<nodeId>.mp4`.
- **Models** resolve from `--models-dir` roots, then the cache
  (`XWE_MODELS_DIR`, default `~/.xorgate/models`), then, with `--pull` or
  `XWE_MODELS_PULL=1`, the registry (`XWE_MODEL_REGISTRY`, default
  `https://models.xorgate.io`). Any directory in the registry layout
  (`<family>/<name>/<version>/{manifest.json,model.onnx}`) is a root, so your
  own fine-tuned model is a directory, not a special case: `tools/export/`
  turns weights into one.
- **Secrets** for connector and VLM nodes come from the environment
  (`XORGATE_SECRET_<LOGICAL_NAME>`, for example `XORGATE_SECRET_HERE_API_KEY`)
  or a `--secrets file.json` of `{ "<logical-name>": "<value>" }`. A value
  never appears in any artifact or output line, and child processes never
  see the variables.
- **Node packs**: `--pack <module>` (also on `validate`) registers extra nodes
  from an npm package or a path; `examples/packs/acme-scale/` is a complete
  one.
- **Code function nodes**: `function.javascript` and `function.python` hold
  a handler inside the template and run it once per incoming `json` event in
  a sandboxed child process (the engine's own `node` under its permission
  model, or `python3 -I -S` from `PATH`, with `timeoutMs` and `memoryMb`
  limits, no file system, no network, no `XORGATE_SECRET_*`); the return
  value is emitted as `json/result`. `xwe function test` runs one event
  through a node's handler; `examples/functions/` has the docs' example.
- **Webhooks**: see [Webhooks](#webhooks) below.
- **Third-party lookups** (`connector.third_party`): requests are paced per
  provider (HERE 5/s, Google Roads 10/s, OSM 1/s; `maxRequestsPerSecond`),
  retried on 429/5xx honouring `Retry-After` (`retry`), bounded by
  `requestTimeoutMs`, and can skip failed lookups within an error budget
  (`onLookupError: "skip"`, `maxErrorRatio`) and emit null "no answer"
  records (`emitNoAnswer`); `osmEndpoint` points OSM at another Overpass
  server. `lookupMode: "trace"` route-matches the whole input with HERE in
  chunked requests (batch and simulation runs only). `logic.comparator`'s
  `maxReferenceAgeMs` and `fallbackReference` handle a stale or missing
  reference.
- **Channels**: in batch and simulation runs every edge except `frames` and
  `video` buffers without bound, so a fan-out that later merges by timestamp
  cannot deadlock; `engine.run({ channelMode: "bounded" })` restores the
  pre-0.5.1 behaviour. A stall detector (`stallMs`, default 30 s, 0 disables)
  fails a graph whose running nodes are all parked with no progress, and the
  nodes still running at a stall or deadline are reported `cancelled`.
- **Exit codes**: `0` success; `1` the run failed (the failing node is named,
  `result.json` still written); `2` usage or configuration, nothing ran.
- **Logging**: `--log-level silent | error | info | debug` on any command
  gates stderr only; stdout carries results and the progress stream.

### Webhooks

An `output.event` node's optional `webhook` field names an endpoint (for
example `dispatch`); the template carries the name, never a URL or secret. On
the platform the org's endpoint registry binds the name. Locally you bind it:

```bash
xwe run template.json --input telemetry=window.csv \
  --webhook dispatch=https://example.com/hooks/xorgate \
  --webhook-secret dispatch=whsec_...        # optional: sign the POSTs
xwe validate template.json --webhook dispatch=https://...   # lists each name: bound or unbound
```

- Bindings come from `--webhook <name>=<url>` (repeatable), a
  `--webhooks file.json` of `{ "<name>": { "url": "...", "secret"?: "whsec_..." } }`,
  or `XWE_WEBHOOK_<NAME>` / `XWE_WEBHOOK_SECRET_<NAME>` (name upper-cased,
  `-` becomes `_`). Flags win over the file, the file over the environment.
  In a library, `engine.run({ webhooks: { bindings, secrets } })`.
- Each event from a bound node is one `POST` with the platform's envelope
  (`{ id, type: "workflow.event", apiVersion, createdAt, organizationId: null,
  workspaceId: null, data: { nodeId, kind, occurredAt, confidence,
  payloadSummary, payload, run: { id, trigger: "local", deviceId, ... } } }`)
  and [Standard Webhooks](https://www.standardwebhooks.com/) headers
  (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256>`),
  so a receiver verifies local and platform deliveries with the same code.
  Without a secret the POST is unsigned.
- URLs must be `https:` and carry no `user:pass@`; `--allow-insecure-webhooks`
  accepts `http:` for a receiver on your machine.
- **Local delivery is best-effort**: one attempt per event, a 10 s timeout,
  no retry, no outbox; a failed POST is logged and never fails the run. A
  name with no binding is warned about once and its events are skipped. The
  platform's delivery (retries, delivery log, redelivery) is separate.
- Webhook secrets are treated like `XORGATE_SECRET_*`: never printed, never
  in an artifact, and `XWE_WEBHOOK_*` variables are removed from every child
  process's environment.
- Every event now carries the `nodeId` that emitted it, in `events.jsonl`,
  `result.json` and the progress stream.

## Embed

```ts
import { createEngine } from "@xorgate/workflow-engine"
import { localHost } from "@xorgate/workflow-engine/local"

const engine = createEngine({ host: localHost({ modelDirs: ["./models"], outDir: "./out" }) })
const run = await engine.run({ template: "./overspeed.json", inputs: { telemetry: "./window.csv" } })
console.log(run.result.status, run.result.events.length, run.runDir)
```

`engine.run` resolves to `{ result, runDir, outcome }`; a failed run resolves
with `result.status === "failed"` and `result.json` written; usage errors
reject with `XweUsageError` (`exitCode: 2`). `createEngine({ packs })` or
`createEngine({ catalog })` adds node packs; `createEngine({ log: "debug" })`
or a `(message, level) => void` sink gives you the engine's diagnostics.

Three entry points, ESM and CommonJS, with declaration files:

| Import | Contents |
| --- | --- |
| `@xorgate/workflow-engine` | `createEngine` (with `engine.run` and `engine.testFunction`), `runGraph` (the storage-free core over the four host seams), `validateDefinition`, `inspectTemplate`, the catalog (`listNodeTypes`, `buildCatalogPayload`, `createCatalog`, `corePacks`, `defineNode`), the executor helpers, every schema and seam type |
| `@xorgate/workflow-engine/local` | `localHost` and its parts (`localSources`, `localArtifactSink`, `localSecretReader`, `ndjsonProgress`, `writeRunArtifacts`, `emitVideo`), the model resolver chain, `checkModelDir`, the webhook helpers (`localWebhookSink`, `signWebhookPayload`, `webhookHeaders`, `workflowEventEnvelope`, ...) |
| `@xorgate/workflow-engine/testing` | `runConformance` |

Importing any of them loads no native module; ONNX Runtime and the VLM
client are required lazily by the executors that use them.

### Your own host

The core reads and writes only through four small interfaces: sources,
artifacts, secrets, progress. `runGraph` takes them directly; `createEngine`
takes an `EngineHost` whose `bind` returns them plus where the run's artifacts
live. `localHost` is the reference implementation and short enough to read.
Prove yours with the conformance kit, which runs the engine's four golden
expectations through your host:

```ts
import { runConformance } from "@xorgate/workflow-engine/testing"

const report = await runConformance({ host: myHost, fixturesDir: "./fixtures" })
// report.ok; report.cases: overspeed, detection, visualization, missing-input
```

## Developing

```bash
npm ci
npm run typecheck
npm run smoke            # builds; both module formats load; catalog hash; no cloud SDK
npm test                 # builds; the golden suite (CLI, library, conformance kit, secret hygiene, log levels)
npm run verify:tarball   # npm pack, install into fresh projects, run through npx / import / require
npm run ci               # all of the above
```

`npm test` and `npm run smoke` first run `npm run fixtures:pull`, which
fetches the two large golden fixtures (a 25 s video and the yolov8n model)
from the public registry per `fixtures/fixtures.json`; `XWE_FIXTURES_URL`
points it at a mirror. Runs in the checkout pass `--models-dir fixtures/models`.

The build is dual ESM + CJS from one extensionless-import source tree;
`scripts/finalize-build.mjs` adds the extensions the ESM loader needs, and
`scripts/copy-runtime.mjs` copies the function runners (`runtime/`) into
`dist/runtime/`. The `xwe` bin is the CJS build. `npm pack` rebuilds `dist`
first.

Image:

```bash
docker build -t xwe .                                              # native architecture
docker buildx build --platform linux/amd64,linux/arm64 -t xwe .    # multi-arch
docker run --rm -v "$PWD":/work xwe run fixtures/templates/overspeed.json \
    --input telemetry=fixtures/telemetry/window.csv --out out
```

The runtime stage keeps only the image's own ONNX Runtime binding and adds
`python3` for `function.python` (arm64 991 MB, amd64 1.08 GB). To run the golden suite inside the image, mount the
checkout and shadow the host's `node_modules` with a Linux install in a named
volume:

```bash
npm run fixtures:pull
docker run --rm -v "$PWD":/work -v xwe-test-modules:/work/node_modules \
    --entrypoint sh xwe -c 'npm ci --include=dev && npm test'
```

CI (`.github/workflows/ci.yml`) runs the gate on Linux x64, Linux arm64 and
macOS. `release.yml` (manual trigger) publishes to npm with provenance and
pushes the multi-arch image to `ghcr.io/epyelabs/xwe`; the version in
`package.json` must match the `v*` tag it is run for.

## Provenance

The engine was split out of the platform's `xorgate-core-service` at commit
`a8862e771ff16825fec2cb458dda2575bf46a375` (`src/workflows/engine`,
`src/workflows/catalog`, the schemas), minus the cloud target wiring. The
frozen contracts (definition `schemaVersion: 2`, the manifest and result
schemas, the catalog node definitions) are the compatibility line between
the two, not the code; see [docs/compatibility.md](./docs/compatibility.md).
Re-integration into the platform is the direction, not part of this package.
