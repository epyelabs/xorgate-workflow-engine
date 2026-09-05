# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/); the
version number follows the policy in [docs/compatibility.md](./docs/compatibility.md)
(contracts first, the catalog hash named whenever it moves).

## Unreleased

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
