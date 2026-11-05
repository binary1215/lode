# Debounced refresh triggers

Status: filesystem and structured CI trigger ingestion active

Protocol version: `0.2.0`; digest-verified `0.1.0` batches and deliveries remain readable

## Purpose

The trigger layer converts noisy filesystem or CI observations into bounded, immutable evidence and delivers that evidence to the existing incremental refresh contract. It never treats an event path as a complete change list and never grants an event producer authority over Product Canon, reviewed relationships, an active Run, or generated documents.

```text
filesystem or CI observations
  -> bounded debounce queue
  -> canonical RefreshTriggerBatch
  -> exclusive project refresh-writer lease
  -> IncrementalRefreshRequest / complete repository rescan
  -> IncrementalRefreshReceipt
  -> PostRefreshProjectionPolicy / PostRefreshProjectionReceipt
  -> RefreshTriggerDeliveryReceipt
  -> replaceable trigger pointer
```

The World Model is still determined by complete eligible-file discovery, raw-byte reads, and content hashing. Trigger payloads only explain why the scan ran.

## Supported sources

Two source adapters are active:

- `filesystem`: a foreground Node `fs.watch` adapter with recursive watching and bounded debounce;
- `ci`: a structured JSON event file processed as one bounded batch.

Both adapters emit the same normalized event vocabulary:

```json
{
  "kind": "path-hint",
  "operation": "change",
  "path": "src/service.mjs",
  "evidenceId": null
}
```

or:

```json
{
  "kind": "project-signal",
  "operation": "build",
  "path": null,
  "evidenceId": "ci-build-0001"
}
```

Operations are labels, not executable commands. Paths must remain inside the project. Absolute paths, drive-qualified paths, NUL bytes, and traversal escapes fail closed.

## Debounce and coalescing

The queue accepts a debounce window from 25 through 60,000 milliseconds and a batch limit from 1 through 4,096 buffered events. Defaults are 350 milliseconds and 1,024 events.

Batch construction:

- normalizes path separators and ordering;
- sorts and deduplicates accepted events canonically;
- records duplicate events as `duplicate-event`;
- excludes repository-scan ignored directories and managed projection files as `excluded-or-managed-path`;
- records bounded overflow as `event-limit-exceeded` and forces a full rescan;
- excludes timer duration, arrival timestamps, backend record IDs, and process identity from semantic batch identity.

Events under `.lode`, `.git`, dependency/vendor trees, build outputs, and caches do not schedule a refresh by themselves. This prevents the trigger artifacts written under `.lode` from recursively triggering the watcher. If excluded events arrive beside a real project event, their dropped count remains visible in the batch evidence.

The queue serializes deliveries in arrival-batch order. A second batch may accumulate while the first scan runs, but two deliveries from one queue never execute concurrently.

If another process owns the World Model writer lease, only `REFRESH_WRITER_BUSY` is retryable. The queue restores the failed batch into its bounded buffer, preserves overflow as a forced-rescan signal, and retries no faster than once per second. Digest, schema, authority, path, graph, and pointer failures are not retried automatically.

## Immutable trigger artifacts

`RefreshTriggerBatch` records:

- project and source-adapter identity;
- canonical accepted event hints;
- input, accepted, coalesced, and dropped counts;
- sorted discard reasons;
- whether a complete rescan is required;
- false instruction, promotion, and canon-mutation authority.

`RefreshTriggerDeliveryReceipt` records:

- the exact trigger batch identity and hash;
- before and after World Model, SourceSnapshot, and GraphSnapshot identities;
- linked incremental request and receipt identities when a rescan ran;
- `ignored`, `unchanged`, or `refreshed` disposition;
- exclusive World Model writer and expected-pointer-check serialization evidence;
- the exact post-refresh projection receipt, policy identity, and `manual-deferred`, `projected`, `unchanged`, blocked, or failed document disposition for an applied delivery.

The local reference stores:

```text
.lode/refresh/triggers/batches/refresh-trigger-batch-*.json
.lode/refresh/triggers/deliveries/refresh-trigger-delivery-*.json
.lode/refresh/triggers/current.json
.lode/document-projection/post-refresh/receipts/post-refresh-projection-receipt-*.json
```

Batch and delivery files are immutable and content-derived. `current.json` is a replaceable digest-verified pointer.

## Single-writer boundary

Every persistent World Model build, including explicit indexing plus manual, filesystem, and CI refresh, acquires the same project-scoped lease:

```text
.lode/refresh/writer.lock/owner.json
```

Directory creation is the cross-process exclusive operation. The owner document is operational metadata only and contains process ID, random token, start time, and false authority flags. A nested trigger delivery may reuse only a verified lease owned by the same process and project. This makes all core World Model pointer writers mutually exclusive; triggered refresh additionally verifies that the current pointer still matches its preview base.

An active or ownership-unknown lease fails with `REFRESH_WRITER_BUSY`. A lease whose recorded PID is proven absent may be recovered after verifying that the lock directory contains only its exact owner file. The implementation never terminates another process to recover a lease. The lock is released in `finally`, and the World Model still performs its expected-current-pointer comparison before writing.

## CLI

Structured CI ingestion uses an input file:

```json
{
  "sourceKind": "ci",
  "events": [
    {
      "kind": "project-signal",
      "operation": "build",
      "path": null,
      "evidenceId": "ci-build-0001"
    }
  ],
  "maxEvents": 1024
}
```

```powershell
node scripts/lode.mjs world-refresh-events <project> --input refresh-events.json
node scripts/lode.mjs world-refresh-watch <project> --debounce-ms 350 --max-events 1024
node scripts/lode.mjs world-refresh-trigger-status <project>
node scripts/lode.mjs world-refresh-trigger-read <project> --delivery refresh-trigger-delivery-<24-hex>
```

`world-refresh-watch` intentionally runs in the foreground. `SIGINT` or `SIGTERM` closes the filesystem watcher, flushes a pending real project batch, waits for the serialized delivery, releases the writer lease, and returns a bounded shutdown summary. Service installation and background daemon ownership remain deferred.

The event-ingestion command accepts only `sourceKind`, `events`, and optional `maxEvents`. It does not accept commands, environment values, credentials, endpoints, GraphDB records, Product Canon mutations, or exact changed-path assertions.

## Read-only MCP

MCP exposes only verification:

- `lode_refresh_trigger_status`;
- `lode_refresh_trigger_delivery`.

MCP cannot start a watcher, ingest CI events, acquire mutation authority, or initiate refresh.

## Authority and execution boundaries

Trigger batches and deliveries are evidence without instruction or promotion authority. They cannot:

- promote Feature or relationship candidates;
- edit Product Canon or Decisions;
- infer an accepted ChangeSet or merge;
- change an accepted ExecutionContract or ContextCapsule;
- rewrite an active Run or pending ResultPacket;
- grant itself document-publication authority; only the separately selected post-refresh policy may regenerate clean Markdown;
- make Git or GraphDB required.

When a triggered refresh creates a newer SourceSnapshot during an active Run, the linked incremental receipt records the same explicit continue, recompile, revise, or cancel requirement as a manual refresh.

## Failure policy

The trigger path fails closed on:

- invalid or escaping paths and unsupported event fields;
- malformed batch, delivery, pointer, or authority flags;
- content digest mismatch or immutable artifact conflict;
- active, unknown, unsafe, or mismatched writer lease ownership;
- incremental request/receipt mismatch;
- post-refresh policy, receipt, candidate, or DocumentProjection binding mismatch;
- World Model preview drift, pointer conflict, or graph materialization failure;
- stale or tampered linked snapshots.

A trigger batch may remain as immutable evidence if downstream refresh fails, but no delivery pointer is advanced. A writer-busy failure is boundedly requeued; all other refresh failures require correction or a new explicit trigger. A downstream document-projection failure is instead recorded in a linked delivery and does not invalidate or roll back the successful observed-state refresh.

## Deferred next stages

This slice does not install a background service or connect a provider-specific CI webhook. Hosts invoke the foreground watcher or create the strict CI event file. Safe opt-in automatic Markdown regeneration, explicit DocumentChangeCandidate review/application, and its temporal audit projection are active. Automatic remote GraphDB projection refresh, Obsidian/Notion publication, bidirectional synchronization, automatic merge, and general semantic promotion remain deferred.
