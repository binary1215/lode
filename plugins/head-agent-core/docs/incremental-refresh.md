# Incremental observed-state refresh

Status: explicit refresh, debounced filesystem/CI ingestion, and opt-in post-refresh Markdown projection active

Protocol version: `0.2.0`; digest-verified `0.1.0` requests and receipts remain readable

## Purpose

Incremental refresh reconstructs observed project state without granting a watcher, compute backend, graph, or document authority over Product Canon. Manual, debounced filesystem, and structured CI triggers now enter the same verified refresh pipeline.

The active pipeline is:

```text
manual request or verified RefreshTriggerBatch
  -> exclusive project World Model writer lease
  -> verified current World Model
  -> content-derived IncrementalRefreshRequest
  -> rediscover and byte-hash every eligible file
  -> reuse analysis only for digest-identical verified files
  -> validate one complete RepositoryScanResult
  -> preview a child SourceSnapshot and GraphSnapshot
  -> persist and verify graph materialization
  -> atomically advance the World Model pointer
  -> persist an immutable IncrementalRefreshReceipt
  -> advance the refresh receipt pointer
  -> evaluate a separate PostRefreshProjectionPolicy
  -> persist an immutable PostRefreshProjectionReceipt
```

The filesystem and CI adapters never provide the changed-file truth. They supply bounded evidence that causes this complete discovery and hashing pipeline to run. The refresh core itself never publishes documents; a separate safe-default-manual policy may regenerate deterministic Markdown after refresh succeeds. See [`refresh-trigger.md`](refresh-trigger.md) and [`post-refresh-projection.md`](post-refresh-projection.md).

## Authority boundary

Refresh may update observed facts:

- file content digests and classification;
- heuristic symbols, imports, dependencies, bindings, and calls;
- immutable File, Symbol, and Test revisions;
- SourceSnapshot, GraphSnapshot, and World Model materializations;
- read-only runtime observations supplied through an already validated adapter.

Refresh cannot:

- mutate Feature, Capability, Requirement, Constraint, Decision, or other Product Canon;
- accept Feature mappings, Change impacts, onboarding candidates, or document changes;
- grant instruction, promotion, canon-mutation, or control authority;
- rewrite an existing World Model, SourceSnapshot, revision, Capsule, contract, Run, or ResultPacket;
- replace the ContextCapsule pinned to an active Run;
- use document publication as Canon, promotion, instruction, or active-Run mutation authority.

An explicit post-refresh operational policy may publish Markdown only after the World Model transition verifies. Edited or unmanaged views are preserved, current edits are captured as non-authoritative candidates against the base graph, and projection failures do not roll the verified World Model pointer back. Automatic Obsidian and Notion publication remain deferred.

The graph remains a rebuildable projection. Git and GraphDB are optional and are not needed for refresh identity, ancestry, or recovery.

## Changed-file reuse boundary

Incremental means semantic analysis reuse, not trusting timestamps or watcher hints. Every eligible path is rediscovered, every eligible file is read, and its raw bytes are SHA-256 hashed under the same limits as `repository.scan.v1`.

Prior analysis is reused only when all of these match the digest-verified previous scan:

- normalized relative path;
- raw-byte digest;
- byte length;
- classification;
- language;
- repository-scan and source-analysis protocol versions.

Changed and added files are analyzed with the JavaScript reference semantics. Removed paths are detected from the complete before/after path sets. The final `RepositoryScanResult` uses the existing `repository.scan.v1` schema and identity, so a conforming full scan and incremental scan produce the same result, result digest, semantic graph, and World Model inputs.

Reuse counts, analyzed paths, backend name, and execution mode are operational diagnostics. They do not participate in repository-scan, World Model, SourceSnapshot, GraphSnapshot, ContextCapsule, request, or receipt semantic identity.

## Request contract

`IncrementalRefreshRequest` binds:

- project identity;
- exact base World Model and SourceSnapshot identities;
- trigger kind and sorted evidence identities;
- either discovered changes or an exact sorted changed-path expectation;
- optional explicit additional SourceSnapshot parents;
- false instruction, promotion, and canon-mutation authority.

The explicit CLI emits `trigger.kind: manual`. The active filesystem watcher and structured CI ingestion emit `filesystem` and `ci`; each request names exactly one immutable `RefreshTriggerBatch` as evidence. `change-set` and `runtime-observation` remain reserved for later verified adapters. Event paths are hints and never become an exact change expectation.

An exact changed-path expectation fails before any World Model pointer mutation when the observed added, changed, and removed path union differs.

## Snapshot and revision ancestry

When no observed or canonical input changed and no new explicit parent was supplied, refresh records an `unchanged` receipt and keeps the current World Model and SourceSnapshot identities.

When a refresh is required:

- the verified current SourceSnapshot becomes a parent automatically;
- optional explicit additional parents are sorted and deduplicated;
- unchanged logical entities keep their existing revision identity and parent set;
- changed logical entities create a new revision whose parent is the previous current revision;
- new entities start with no revision parent;
- removed entities are absent from the next current projection but remain addressable in prior immutable snapshots.

This supports multiple-parent DAG shape without implementing automatic merge or conflict resolution.

## Active execution drift

An active Run is not stopped or mutated by refresh. Its Run record, ExecutionContract, WholePlanSnapshot, and ContextCapsule remain fixed. The receipt records:

- Run, plan, contract, and Capsule identities;
- the Capsule-pinned SourceSnapshot when present;
- the refreshed SourceSnapshot;
- whether drift exists;
- the required Lode choice: continue with pinned inputs, recompile, revise, or cancel.

A pending ResultPacket likewise remains frozen for Fresh Lode review. Refresh evidence may inform review, but cannot rewrite the result or its accepted execution inputs.

## Immutable artifacts

The local reference implementation stores:

```text
.lode/refresh/requests/incremental-refresh-request-*.json
.lode/refresh/receipts/incremental-refresh-receipt-*.json
.lode/refresh/current.json
.lode/refresh/triggers/batches/refresh-trigger-batch-*.json
.lode/refresh/triggers/deliveries/refresh-trigger-delivery-*.json
.lode/refresh/triggers/current.json
.lode/document-projection/post-refresh/policies/post-refresh-projection-policy-*.json
.lode/document-projection/post-refresh/receipts/post-refresh-projection-receipt-*.json
.lode/document-projection/post-refresh/current-policy.json
.lode/document-projection/post-refresh/current.json
```

Requests and receipts are content-derived immutable artifacts. The current file is a digest-verified replaceable pointer. A later full index or refresh can make the latest receipt stale without invalidating its historical evidence.

## CLI and MCP

```powershell
node scripts/lode.mjs world-refresh <project>
node scripts/lode.mjs world-refresh <project> --expect-changed src/a.mjs,src/b.mjs
node scripts/lode.mjs world-refresh-status <project>
node scripts/lode.mjs world-refresh-read <project> --receipt incremental-refresh-receipt-<24-hex>
node scripts/lode.mjs world-refresh-events <project> --input refresh-events.json
node scripts/lode.mjs world-refresh-watch <project> --debounce-ms 350 --max-events 1024
node scripts/lode.mjs world-refresh-trigger-status <project>
node scripts/lode.mjs world-refresh-trigger-read <project> --delivery refresh-trigger-delivery-<24-hex>
node scripts/lode.mjs world-docs-policy-set <project> --input post-refresh-policy.json
node scripts/lode.mjs world-docs-policy-status <project>
node scripts/lode.mjs world-docs-refresh-status <project>
node scripts/lode.mjs world-docs-refresh-read <project> --receipt post-refresh-projection-receipt-<24-hex>
```

`--trigger-evidence` adds sorted evidence identities. `--parent-snapshot` declares additional SourceSnapshot parents; it does not request or perform a merge.

Read-only MCP exposes:

- `lode_incremental_refresh_status`;
- `lode_incremental_refresh_receipt`;
- `lode_refresh_trigger_status`;
- `lode_refresh_trigger_delivery`;
- `lode_post_refresh_projection_status`;
- `lode_post_refresh_projection_receipt`.

MCP does not expose refresh mutation.

## Failure policy

Refresh fails closed on:

- missing, stale, tampered, or mismatched base artifacts;
- repository-scan request, response, result, or digest mismatch;
- exact changed-path expectation mismatch;
- invalid path or parent identities;
- World Model preview drift or concurrent pointer conflict;
- active, unknown, unsafe, or mismatched project World Model writer lease ownership;
- trigger batch, delivery, incremental-link, or trigger-pointer mismatch;
- graph projection failure or semantic divergence;
- request, receipt, or pointer digest mismatch;
- active Run state that disagrees with its Run or Capsule artifacts.

The existing verified World Model pointer remains authoritative for current derived state when validation fails before pointer advancement.

A document policy, adapter, renderer, or publication failure is isolated after the refresh-core transition. It records a `failed` post-refresh receipt and preserves the verified World Model, Product Canon, active execution inputs, and existing published view.

## Deferred next stages

The verified trigger queue and opt-in post-refresh Markdown policy now complete the local automatic observed-state-to-human-view path without granting documents authority. Explicit DocumentChangeCandidate review/application and its temporal audit projection are active. Automatic remote GraphDB refresh, background service installation, provider-specific CI webhooks, Obsidian/Notion publication, and bidirectional document synchronization remain later stages.
