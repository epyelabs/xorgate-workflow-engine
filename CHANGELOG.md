# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/); the
version number follows the policy in [docs/compatibility.md](./docs/compatibility.md)
(contracts first, the catalog hash named whenever it moves).

## Unreleased (0.4.0)

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
