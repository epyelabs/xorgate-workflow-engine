# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/); the
version number follows the policy in [docs/compatibility.md](./docs/compatibility.md)
(contracts first, the catalog hash named whenever it moves).

## Unreleased

### Connector and comparator

A minor under `docs/compatibility.md`: additive optional config on
`connector.third_party` and `logic.comparator`, additive fields on their
records, new exports from the connector module. The core catalog moves from
`f8861576c807e382` to `4b1a1732646c0e0d` (28 nodes); without `core/function`
the 26 other defs move from `184300277358e824` to `3759a3cca37524e3`.

#### Added (P0.3: rate policy, retries, timeouts, error budget, no-answer records)

- `connector.third_party` config, all optional with defaults:
  - `maxRequestsPerSecond`: token-bucket pacing, burst 1. Default per
    provider: OSM 1 (plus up to 250 ms jitter, as before), HERE 5, Google
    Roads 10.
  - `retry: { attempts: 4, baseMs: 500, maxMs: 8000 }`: retries on HTTP 429
    and 5xx with full-jitter exponential back-off. A `Retry-After` header
    (delta-seconds or HTTP-date) is honoured instead, up to 60 s; a longer one
    ends the lookup's attempts. `attempts` counts the first request.
  - `requestTimeoutMs` (default 10000): an `AbortSignal` on `ctx.http`, raced
    so a fetch that ignores the signal still times out; covers the body read.
  - `onLookupError: 'fail' | 'skip'` (default `fail`) and `maxErrorRatio`
    (default 0.2). With `skip`, a lookup that still fails after its retries
    (or times out) is a no-answer for that position; the node fails once the
    failed share exceeds `maxErrorRatio` after at least 10 lookups, or at the
    end of the input when every lookup failed. A rejected key (401/403)
    always fails the node.
  - `emitNoAnswer` (default false): positions without a limit emit
    `{ ts, speedLimitKph: null, source, reason }`, `reason` one of
    `no_answer`, `capped` (past `maxLookupsPerRun`) or `error` (skip path).
  - `osmEndpoint` (default `https://overpass-api.de/api/interpreter`).
- `logic.comparator` config `maxReferenceAgeMs` (a held reference older than
  this is stale) and `fallbackReference` (the value used when there is no
  usable record: none yet, a null field, or stale; without it such samples are
  skipped). The condition `meta` gains `referenceSource: 'record' | 'fallback'`
  and `referenceAgeMs` (sample ts minus the record's ts, null before any
  record). Together with `emitNoAnswer` this moves Alocate's "held limit,
  assume 50" rule (driver-behaviour CONTRACT 3.1) into the template: on the
  M0-P0 stale-limit shape the false events are dropped and real ones are
  compared against the assumed limit.
- Connector module exports (deep, not from the root): `RequestThrottle`
  (now token-bucket: `new RequestThrottle(ratePerSecond, { jitterMs, burst,
  clock })`), `requestWithPolicy`, `parseRetryAfter`, `backoffDelayMs`,
  `ConnectorFatalError`, `ConnectorLookupError`, `DEFAULT_REQUESTS_PER_SECOND`,
  and the internal clock seam `connectorClock` / `resetConnectorClock` used by
  the tests. `buildOverpassRequest` takes an optional endpoint.
- Fixture `fixtures/templates/overspeed-osm-fallback.json`: the production
  overspeed graph (10 s hold grid, OSM) with `emitNoAnswer` + `skip` on the
  connector and `fallbackReference: 50`, `maxReferenceAgeMs: 5000` on the
  comparator.
- `test/connector/connector-test.mjs`, run by `npm test`: pacing on a virtual
  clock, 429 then success with and without `Retry-After`, a hung fetch hitting
  the timeout, the skip path and the error budget, `emitNoAnswer`, and the
  stale-limit scenario on the production graph.

#### Executor behaviour

- `connector.third_party`: HERE and Google Roads lookups are now paced (5 and
  10 per second) and retried on 429/5xx instead of failing on the first one.
  OSM's single fixed 3 s back-off is replaced by the retry policy above. The
  step summary is set even when the node fails, and a failure message ends
  with the lookup counts in brackets. Failure messages after retries say
  `after N attempts`.
- `logic.comparator`: a reference record whose field is `null` clears the
  held reference (before, it was ignored and the old value held). The
  connector emits such records only with `emitNoAnswer`, so existing graphs
  are unaffected.

## 0.5.0 (2026-09-28)

Webhooks on `output.event` and `nodeId` on events. A minor under the policy
in `docs/compatibility.md`: an additive optional config field, an additive
field on the event record and on `result.json` / `events.jsonl` / progress
events, new flags, new environment variables, new exports. The core catalog
moves from `2b2a3c052696cf1e` to `f8861576c807e382` (28 nodes):
`output.event` gained `webhook`. Without `core/function` the 26 other defs
move from `ab458ea46642308b` to `184300277358e824`.

### Added

- `output.event` config `webhook` (optional string, flat): the name of the
  endpoint each event is delivered to. The template carries the name only;
  the platform binds it to the org's endpoint of that name, and a local run
  binds it with the flags below. The executor does not read it.
- Every event record carries `nodeId`, the `output.event` node that emitted
  it, stamped by the engine (executors call `ctx.emitEvent` without it; a
  `nodeId` they pass is ignored). It is written to `events.jsonl`,
  `result.json`, the NDJSON / callback progress stream and the
  `IotRunProgress` event payload. `engineEventSchema` and
  `simEventPayloadSchema` accept it as optional, so a 0.4.0 `result.json`
  still parses. New type `EngineEventInput` (the record without `nodeId`) is
  what `ctx.emitEvent` takes.
- Local webhook delivery: `xwe run --webhook <name>=<url>` (repeatable),
  `--webhook-secret <name>=<whsec_...>` (repeatable), `--webhooks <file>`
  (`{ "<name>": { "url", "secret"? } }`), `--allow-insecure-webhooks`, and
  the environment variables `XWE_WEBHOOK_<NAME>` / `XWE_WEBHOOK_SECRET_<NAME>`
  (flag > file > env). Each event of a bound node is one POST with the
  platform envelope (`type: "workflow.event"`, `apiVersion: "2026-09-27"`,
  `data.nodeId`, `data.run.trigger: "local"`, org/workspace/template fields
  null) and Standard Webhooks headers (`webhook-id`, `webhook-timestamp`,
  `webhook-signature: v1,<base64 HMAC-SHA256(key, id.timestamp.body)>`, plus
  `x-xorgate-event`); unsigned without a secret. Best-effort: one attempt,
  10 s timeout, no retry, never fails the run; POSTs settle before
  `engine.run` resolves. URLs must be `https:` (or `http:` with
  `--allow-insecure-webhooks`) without user-info; a bad URL or secret is a
  usage error (exit 2) naming the webhook, never the value. An unbound name
  is warned once and its events are skipped.
- `engine.run({ webhooks: { bindings, secrets, allowInsecure, env, fetch, timeoutMs } })`,
  type `EngineWebhookOptions`.
- `xwe validate` lists the webhook names a template references, each bound
  (with the URL's origin, signed or unsigned, and where the binding came
  from) or unbound, and accepts the same webhook flags. Unbound is a warning,
  not an error. `inspectTemplate` returns `webhooks: [{ name, nodeIds }]`.
- `./local` exports the webhook helpers: `localWebhookSink`,
  `resolveWebhookBindings`, `webhookRefsOf`, `signWebhookPayload`,
  `webhookHeaders`, `workflowEventEnvelope`, `webhookSecretKey`,
  `generateWebhookSecret`, `webhookUrlProblem`, `webhookEnvVar`,
  `webhookSecretEnvVar`, `uuidv7`, `WEBHOOK_API_VERSION`. The root exports
  `WEBHOOK_ENV_PREFIX`.
- `EngineRunDeps.redact` (optional): values known to be secret before the run,
  scrubbed like values read through the secrets seam.
- Fixture `fixtures/templates/overspeed-webhook.json`; the golden suite
  delivers to a loopback listener and verifies the signature; the smoke test
  pins a signing vector computed with the `standardwebhooks` package (the
  platform's core-service test pins the same vector).

### Changed

- Catalog hash `2b2a3c052696cf1e` -> `f8861576c807e382` (see above).
- `result.json` and `events.jsonl` events gain `nodeId`.

### Security

- Webhook secrets follow the 0.1.0 secret-hygiene rules: registered with the
  run's redactor, never printed, never written to an artifact or progress
  message, and `scrubSecretEnv` now also removes every `XWE_WEBHOOK_*`
  variable (URLs and secrets) from child processes (ffmpeg, function
  runners). A malformed `--webhooks` file is reported by file and key only.

### Docs

- `output.event`'s `attachClip` is documented as unimplemented: nothing reads
  it and `clipKey` is always null. The field stays (templates set it); the
  misleading source comment is gone.
- README: a Webhooks subsection under Run.

## 0.4.0 (2026-09-26)

Metric depth and a distance label. A minor under the policy in
`docs/compatibility.md`: additive config fields and values, additive payload
fields. The core catalog moves from `08c8c39436928e5e` to `2b2a3c052696cf1e`
(28 nodes): `output.visualization`'s `overlays` gained `distance`,
`model.depth` gained `distanceScale`, `logic.proximity_gate` gained
`maxDistanceM`.

### Added

- Model manifests accept `postprocess.kind: "depth-anything-metric"`: a depth
  model whose output is depth in metres. `model.depth` inverts it before the
  usual normalization, so `proximity`, the colormap and `logic.proximity_gate`
  behave as on the relative model, and each box in `json:depth` gains
  `distanceM` (median metres over the box's central half) and each record a
  frame `metres: { min, median, max }` range. Relative models are unchanged.
- `output.visualization` overlay `distance`: labels read `TRUCK - 5.2 M`
  (one decimal under 10 m, whole metres above). It draws the boxes of the
  connected Depth input (Depth's own detections, enriched with `distanceM`),
  and logs once when the depth model is relative and has no distance to show.
- `model.depth` config `distanceScale` (default 1): multiplies `distanceM`
  and the `metres` range, a per-camera calibration.
- `logic.proximity_gate` config `maxDistanceM` (optional): with a metric
  depth model, a box matches when it is within that many metres, and
  `minProximity` is ignored; on a relative model the node fails with a message
  naming the fix. Condition meta carries `maxDistanceM` and each box's
  `distanceM`.
- `tools/export/export_depth.py --variant metric-outdoor` exports
  `depth/depth-anything-v2-metric-outdoor-small`
  (`depth-anything/Depth-Anything-V2-Metric-Outdoor-Small-hf`); `xwe models
  check` validates the new kind.

### Notes

- Metric outdoor depth assumes a narrow camera. On the 00008 dashcam sample
  the reported metres are self-consistent (distance x box width over a
  1.88 m-wide vehicle gives a focal length within about 10% across 38 frames)
  but imply a 53° horizontal field of view, so a wide-angle dashcam reads 2 to
  4x too far. `distanceScale ≈ tan(26.5°) / tan(HFOV / 2)` corrects it (0.42
  at 100°, 0.29 at 120°); a measured distance to a known object is better.

## 0.3.0 (2026-09-08)

Exports for a platform shell. No node definition, executor or contract
changes; the core catalog stays at `08c8c39436928e5e` (28 nodes). A minor
under the policy in `docs/compatibility.md`: new exports only.

### Added

- Root exports for hosts that publish progress to a topic plane and keep
  artifacts under the v2 run prefix (the platform's shell is the first):
  `IotRunProgress` (the reference `EngineProgressSink` over a
  `ProgressTransport`, one publish chain per run, records and previews paced
  and size-capped, `flush()` after the run), `teeArtifactSink`,
  `simTopicPrefix`, `runTopicPrefix`, `simPreviewPayloadSchema` and the
  types `ProgressTransport`, `SimPreviewPayload`.
- The artifact key helpers behind the artifact tree: `V2_RUN_PREFIX`,
  `manifestKey`, `resultKey`, `eventsKey`, `recordsKey`, `frameKey`,
  `inputRecordsKey` (`runPrefix` was already exported).
- `captureFormatsOf` from the root entry point (unchanged on `./local`).
- The connector request builders and parsers, so a shell can probe a
  provider credential with the exact requests the node makes:
  `buildGoogleRoadsUrl`, `parseGoogleRoadsResponse`, `buildHereRequest`,
  `parseHereResponse`, `buildOverpassRequest`, `parseOverpassResponse`,
  `parseMaxspeedTag`, and the types `SpeedLimitProvider`, `SpeedLimitLookup`,
  `RoadsResponse`, `HereRouteMatchResponse`, `OverpassResponse`.
- `npm run smoke` asserts every new name on both module formats, exercises
  `IotRunProgress` through an in-memory transport and checks the key layout.

### Removed

- The internal files `engine/session.ts` and `engine/finalize.ts`. They were
  never exported or referenced (deep imports are not a contract); the
  platform shell that used them takes them over.

## 0.2.0 (2026-09-06)

Code function nodes. Core catalog `catalogVersion` moves from
`e481243f5ffe4678` (0.1.0, 26 nodes) to `08c8c39436928e5e` (28 nodes): a
minor under the policy in `docs/compatibility.md`, because two core nodes
were added. The 26 pre-existing definitions are byte-identical; on their own
they still hash to `e481243f5ffe4678` (`npm run smoke` asserts it).

### Added

- `function.javascript` and `function.python` (group `function`, the eighth
  core pack `core/function`): a handler stored in the template, run once per
  incoming `json` event (any tag, port `event`) in a sandboxed child process,
  its return value emitted as `json/result` with the event's `ts`; `null`,
  `undefined` or `None` drops the event. Config: `handler` (`"handler"`),
  `timeoutMs` (3000, 100 to 30000), `memoryMb` (256, 128 to 2048), `code`
  (at most 256 KB), `versions[]` (`{ version, code, handler, publishedAt,
  description? }`) and `deployedVersion` (runs when present in `versions`,
  else the working copy). `ui.editor: "code"`, `runtime.target: "any"`.
- The function runtime: one process per node instance per run, started on
  the first event, JSON per line over stdio (`dist/runtime/js/runner.cjs`,
  `dist/runtime/python/runner.py`, shipped in the package). JavaScript runs
  under the engine's own `node` with the permission model on and no file
  system, child-process or worker grants (only a read grant on the runner
  file itself), `--max-old-space-size` from `memoryMb`, the user's code in a
  V8 context with only the language built-ins, timers and a log console
  (no `process`, no `require`, no `import()`, no `eval`, no `fetch`).
  Python runs `python3 -I -S` from `PATH` with `RLIMIT_AS` from `memoryMb`
  where the platform enforces it, the standard library minus the modules
  that reach files, processes or the network, and `open()` refused.
  `timeoutMs` per invocation kills the process and fails the step. The
  child environment is an allowlist (`PATH`, `HOME`, locale, `TZ`, temp
  directories): no `XORGATE_SECRET_*`, no `NODE_OPTIONS`.
- `context` = `{ log, nodeId, runId, functionVersion, remainingTimeMs }`;
  `context.log` lines (and `console.log` / `print()`) reach the run as
  `record` progress messages on the pseudo-port `log`, tagged `log`, payload
  `{ line, invocation }`, and are listed in a failed step's output. Step
  summary `N invocation(s), M result(s), K dropped[, L log line(s)]
  ($LATEST|vN, javascript|python, ~X ms)`.
- `xwe function test <template> <nodeId> --event <file> [--version n]` and
  `engine.testFunction({ template, nodeId, event, version? })` resolving
  `{ ok, result?, error?, logs, durationMs, functionVersion, nodeId, type,
  language, runtime }`; exit 1 when the handler threw, timed out or failed
  to load, 2 when nothing ran.
- `xwe doctor` reports `python3` (informational).
- The container image installs `python3` (arm64 940 MB to 991 MB, amd64
  1.03 GB to 1.08 GB).
- `EngineRunCtx` gains an optional `emitRecord` and a `level` argument on
  `log` (additive); root exports `resolveFunctionCode`,
  `functionChildEnv`, `functionSpawnSpec`, `nodePermissionFlag`,
  `FUNCTION_CODE_MAX_BYTES` and the function types.
- `examples/functions/`: the docs' forklift-summary template in both
  languages and the event to test it with.

## 0.1.0 (2026-09-05)

The first published release: the engine that ran from a checkout, packaged.
Core catalog `catalogVersion` `e481243f5ffe4678` (26 nodes, unchanged since
the engine was split out of the platform).

### Added

- The package `@xorgate/workflow-engine` (MIT) with three entry points:
  `.` (the engine core, the catalog, every schema and seam type), `./local`
  (the file host) and `./testing` (the conformance kit), built as ESM and
  CommonJS with declaration files; the `xwe` command as its `bin`.
- `createEngine({ host, catalog | packs, log })` and `engine.run(options)`
  resolving `{ result, runDir, outcome }`; a failed run resolves with
  `result.json` written, a usage error rejects with `XweUsageError`
  (`exitCode: 2`). `localHost({ modelDirs, outDir, secrets, progress,
  baseDir, models, env, log })` as the reference host; the host contract
  `EngineHost.bind` over the four seams.
- `validateDefinition` and `inspectTemplate` from the root; `path` accepted
  as an alias of `s3Key` in hand-written local manifests.
- Models: the registry layout resolved through explicit roots
  (`--models-dir`), the cache (`XWE_MODELS_DIR`, default
  `~/.xorgate/models`) and, on request (`--pull`, `XWE_MODELS_PULL=1`), an
  HTTPS registry (`XWE_MODEL_REGISTRY`, default `https://models.xorgate.io`)
  with sha256 verification; `name@version` pins; `xwe models list | pull |
  path | check`; `checkModelDir` from `./local`; the additive `files` block
  in the model manifest; `tools/export/` for bringing your own model.
- Node packs: `NodePack`, `createCatalog`, `corePacks`, `coreCatalog`;
  `xwe run | validate --pack <module>`; the additive `packs[]` in the catalog
  payload; the `function` group (was the empty `custom`); `ui.editor:
  "code"`; the model manifest's `family` as an open string.
- `xwe doctor`.
- The conformance kit: `runConformance({ host, fixturesDir })` from
  `./testing` runs the four golden expectations through `createEngine`
  against any host.
- `--log-level silent | error | info | debug` on every command, and `log` on
  `createEngine` as a level or a sink; the NDJSON progress messages and the
  exit codes are declared stable (`docs/compatibility.md`).
- `docs/compatibility.md`: the contract table and the semver policy.
- CI (`.github/workflows/ci.yml`: typecheck, smoke, the golden suite and
  `verify:tarball` on Linux x64, Linux arm64 and macOS) and a release
  workflow (`release.yml`, manual trigger for now: npm publish with
  provenance, multi-arch image to `ghcr.io/epyelabs/xwe`). 0.1.0 itself was
  published from a maintainer's machine.
- The container image keeps only its own ONNX Runtime binding (arm64 940 MB,
  amd64 1.03 GB).

### Security

- Secret hygiene: any value read through the secrets seam is replaced with
  `[redacted]` in step summaries, failure messages, events, captured
  records, progress messages and log lines before they leave `runGraph`;
  the URL-encoded form is scrubbed too. Child processes (ffmpeg) inherit an
  environment without `XORGATE_SECRET_*`. A `--secrets` file that does not
  parse is reported by name only. A registry URL carrying credentials is
  refused by name. Registry URLs print without their user-info part.

### Changed

- `onnxruntime-node` and the VLM provider client are optional dependencies;
  ffmpeg is never installed by npm.
- The default model search path is the cache only; a checkout passes
  `--models-dir fixtures/models`. The large fixtures are pulled
  (`npm run fixtures:pull`), not committed; the repository history was
  rewritten to drop them.
