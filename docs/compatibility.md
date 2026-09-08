# Compatibility

What `@xorgate/workflow-engine` promises across versions, and how its version
number moves. The engine is a set of contracts (documents, interfaces, a
message stream, exit codes) with code behind them; the contracts are what a
template author, a host implementer, a pack author and an operator depend on,
so they are what the version number is about.

## The contracts

| Contract | Identity | Defined in | Who depends on it |
| --- | --- | --- | --- |
| Workflow definition | `schemaVersion: 2` | `workflowDefinitionSchema` (`src/schemas/workflows.ts`); v1 graphs are upgraded by `upgradeDefinition` | template authors, the platform editor, `validateDefinition` |
| Run manifest | `manifestVersion: 2` | `runManifestSchema` (`src/engine/manifest.ts`) | `xwe run --manifest`, `engine.run({ manifest })`, hosts that build manifests |
| `result.json` | `resultVersion: 2`, `engineVersion: 2` | `engineResultSchema`, `buildEngineResult` | tooling that reads run artifacts; the platform's run pages |
| Artifact tree | `events.jsonl`, `outputs/<nodeId>/records.*`, `frames/<nodeId>/<seq>.jpg`, `result.json` last | `writeRunArtifacts` (`src/local/target.ts`) | hosts, tooling |
| Artifact keys | the artifact tree under `workflows/v2/runs/<runId>/` (`V2_RUN_PREFIX`): `manifest.json`, `result.json`, `events.jsonl`, `outputs/<nodeId>/records.<jsonl\|json>`, `frames/<nodeId>/<seq>.jpg`, `inputs/<nodeId>/records.jsonl` | `runPrefix`, `manifestKey`, `resultKey`, `eventsKey`, `recordsKey`, `frameKey`, `inputRecordsKey` (`src/engine/manifest.ts`) | remote hosts keyed by path (object stores), tooling |
| Catalog payload | `schemaVersion: 2`; `catalogVersion` is the content hash of the node definitions (the core catalog is `08c8c39436928e5e` from 0.2.0, `e481243f5ffe4678` in 0.1.0); `packs[]` is additive | `buildCatalogPayload` (`src/catalog/index.ts`) | editors, drift detection between two hosts |
| Node definitions | every `NodeTypeDef` field of the 28 core nodes: type, version, ports, config schema, `requires` | `src/catalog/nodes/*.ts` | templates (a changed def changes `catalogVersion`) |
| Model manifest | v1; the `files` block is additive; `family` is an open string with `MODEL_FAMILIES` as the known values | `modelManifestSchema` (`src/models/registry.ts`) | registries, `xwe models check`, bring-your-own models |
| Registry layout | `<family>/<name>/<version>/{manifest.json,model.onnx}`, `index.json` at the root as an array of manifests | `src/local/registry-client.ts` | private registries and mirrors |
| Host seams | `EngineSourceReader`, `EngineArtifactSink`, `EngineSecretReader`, `EngineProgressSink`; `EngineHost.bind` returning `EngineBoundRun` | `src/catalog/types.ts`, `src/host.ts` | host implementers (the platform shell, custom storage) |
| `EngineSourceReader.fetchModel` | `({ family, name }) => { manifest, modelPath }`; a version pin rides in `name` as `name@version` | `src/catalog/types.ts` | hosts |
| Progress messages | `t: status \| step \| event \| record`, each stamped `at`; the same objects as NDJSON (`--progress json`) and as callbacks (`engine.run({ progress })`); over a topic plane, one topic per kind under a prefix (`status`, `steps`, `events`, `records/<nodeId>`, `preview/<nodeId>`) with `simTopicPrefix` / `runTopicPrefix` naming the prefix | `objectProgress` (`src/local/target.ts`); schemas `sim*PayloadSchema` and `IotRunProgress`, the reference transport implementation over a `ProgressTransport` (`src/engine/progress.ts`) | `--progress json` consumers, platform transports |
| CLI exit codes | `0` success, `1` the run or validation failed (`result.json` written for runs), `2` usage or configuration (nothing ran) | `src/cli/index.ts` | scripts, CI |
| CLI commands and flags | `validate`, `run`, `models list \| pull \| path \| check`, `function test`, `doctor`; every flag on the CLI reference | `src/cli/*.ts` | operators |
| Library entry points | `.`, `./local`, `./testing`, the names each exports | `src/index.ts`, `src/local/index.ts`, `src/testing/index.ts` | applications embedding the engine |
| Node packs | `NodePack { name, version, nodes: [{ def, executor }] }`, `createCatalog`, `corePacks`, the namespace rules | `src/catalog/pack.ts` | pack authors |
| Environment | `XWE_MODELS_DIR`, `XWE_MODELS_PULL`, `XWE_MODEL_REGISTRY`, `XORGATE_SECRET_<LOGICAL_NAME>`, `FFMPEG_PATH` | `src/local/paths.ts`, `src/local/target.ts` | operators |
| Conformance kit | the four cases and their pinned expectations (`CONFORMANCE_EXPECTATIONS`) | `src/testing/conformance.ts` | host implementers |
| Code functions | the handler contract (`handler(event, context)`, `context = { log, nodeId, runId, functionVersion, remainingTimeMs }`, the return value as `json/result`, `null` drops), the config shape and the version rule, `log` records on the pseudo-port `log`, `engine.testFunction`'s result shape | `src/catalog/nodes/function-common.ts`, `src/engine/function-runtime.ts` | template authors, the platform editor |
| Node.js | `>=20` | `package.json` `engines` | everyone |

Everything else is implementation. In particular these are **not** contracts,
and may change in any release: the wording of log lines and of the CLI's
human-readable stderr, the wording of step summaries (they are one-line
human text; the conformance kit matches their leading counts, not their
prose), the internal module layout under `dist/` (deep imports are not
supported), the exact bytes of frames, JPEGs and MP4s, and detection counts
within the documented tolerance, the wire protocol between the engine and
its function runners (`dist/runtime/`), the exact wording of the sandbox's
refusals, and which standard-library modules the Python runner denies.

## The version number

The package follows semantic versioning, with the contracts above as the
subject:

- **Major** (`x.0.0`): a breaking change to any contract in the table. A field
  removed or retyped in a document, a seam method renamed or given a new
  required parameter, a progress message type removed, an exit code
  reassigned, a core node type or port removed, a node's config schema
  narrowed so an existing template stops validating, the Node.js floor
  raised past a major that was supported.
- **Minor** (`0.x.0`): an additive change. A new optional field in a document,
  a new optional seam method, a new progress message type or a new optional
  field on one, a new command or flag, a new core node (which changes the
  core `catalogVersion`; the old and new hashes are named in the changelog),
  a new export, a new environment variable.
- **Patch** (`0.0.x`): no contract changes. Bug fixes, performance work,
  dependency updates, documentation. A fix that changes what an executor
  produces on the same input (a corrected threshold edge, a different
  detection count on the same frames) is a patch, and the changelog names the
  affected node types under an "Executor behaviour" heading so a host can
  decide whether to re-baseline.

Two rules the table implies:

- **Schema versions move only on majors.** `schemaVersion`, `manifestVersion`
  and `resultVersion` stay at 2 while the package stays at 0.x and 1.x
  additive; a document written by an older release keeps parsing on every
  newer release of the same major. Documents written by a newer minor may
  carry fields an older release ignores.
- **`catalogVersion` is the drift detector, not a version number.** Two hosts
  with the same `catalogVersion` execute the same node definitions. A hash
  change on a minor release means a node was added or a def gained an
  additive field; the changelog says which. A template validated against one
  hash and run against another still validates unless the change was a major.

While the package is `0.x`, semantic versioning would allow breaking changes
on minors. This package does not use that latitude: the rules above apply
from `0.1.0`. The intent is that `1.0.0` changes nothing but the number.

## Releasing

Releases are tags. The release workflow (`.github/workflows/release.yml`) runs
on `v*` tags, refuses a tag that does not equal `v<package.json version>`,
runs the full gate (`npm run ci`), publishes to npm with provenance, then
builds and pushes the multi-arch image to `ghcr.io/epyelabs/xwe:<version>`
(and `:latest` for a stable version). The repository needs an `NPM_TOKEN`
secret (or npm trusted publishing for the workflow), the `id-token: write`
and `packages: write` permissions the workflow declares, and, optionally, a
`release` environment with required reviewers.

The changelog (`CHANGELOG.md`) has one section per version, with the contract
changes and any executor behaviour changes named explicitly.
