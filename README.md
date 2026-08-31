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

## Build / verify

```
npm ci
npm run typecheck
npm run smoke   # builds, imports runGraph, asserts 26 catalog nodes + no AWS deps
```

Module system is CommonJS, matching the source's `engine-runner/tsconfig.json`
(the copied code uses extensionless relative imports).
