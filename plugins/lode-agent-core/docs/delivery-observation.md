# Delivery state observation

Status: implemented provider-neutral P3 event contract and non-persisted P4 current/history projection under protocol `0.1.0`.

## Purpose and boundary

Delivery state answers a narrower operational question than Product Canon or release approval: **which artifact revision was observed on which environment target, in what explicit order?** It works for Git-backed and Gitless products and does not deploy, poll, approve, or judge success.

Each Host-reported event becomes an immutable common `ObservationRecord` with type `delivery.state`. `DeliveryStateProjection` is computed on read. Neither artifact changes Product Canon, creates a `ReviewDecision`, writes P2 recovery direction, or blocks ordinary work. Product-specific CI, deployment, device, analytics, and credential handling stays in the Host adapter.

This complements rather than replaces [Release observation](release-observation.md). Release observation verifies reachable Git commits, current refs, and a separately reported approval. Delivery observation preserves per-target application, failure, and rollback history without interpreting it as a release.

## Event contract

```json
{
  "environmentKey": "environment-a",
  "targetKey": "target-one",
  "artifactKey": "service.public-api",
  "revisionKey": "v2",
  "revisionDigest": "<sha256>",
  "outcome": "applied",
  "sequence": 1,
  "predecessorObservationId": "observation-<24 hex>",
  "rollbackTargetObservationId": null,
  "observedAt": "2026-09-01T00:00:00.000Z",
  "sourceScopeDigest": "<sha256>",
  "sourceEventKeyDigest": "<sha256>",
  "sourceEvidenceDigest": "<sha256>",
  "revisionReference": {
    "worldModelId": "world-model-<24 hex>",
    "revisionId": "file-revision-<24 hex>",
    "sourcePath": "revisions/v2.txt",
    "digest": "<sha256>"
  }
}
```

`outcome` is `applied`, `failed`, `cancelled`, or `rolled-back`. A rollback names the exact earlier applied observation in `rollbackTargetObservationId`. The optional `revisionReference` is all-or-nothing. When present, Core verifies the retained World snapshot, exact `FileRevision`, path, and digest before writing anything. Without it, the revision remains explicitly `declared`; a string supplied by the Host is never relabeled as a verified repository revision.

`delivery.state` is a Core-owned specialization because its verified binding creates an `AT_REVISION` graph claim. Generic `lode_observation_ingest` and generic registered adapters reject this reserved type; Hosts use `lode_delivery_observe`, whose dedicated writer repeats the same-project retained-World check at the persistence boundary. This is a proof-integrity boundary, not a user approval gate: custom Observation types remain open, and declared delivery revisions remain accepted through the dedicated call.

Replay uses the common exact adapter/version/source-scope/source-event key. Identical replay converges. Divergent content fails without replacing the earlier event.

## Current-state reconstruction

Current state is not chosen by receipt time or filename order. For each exact environment, target, and artifact, Core verifies the explicit nonnegative `sequence` and exact predecessor chain. Independent artifacts on one target therefore never overwrite each other's current state or manufacture a mixed-version result:

- one root at sequence zero;
- one record per sequence;
- each later record points to the exact preceding sequence;
- one successor per predecessor;
- rollback points to an earlier applied or rolled-back event in the same target history.

Any missing, duplicate, divergent, or nonconsecutive order leaves that artifact-target history `unknown` and exposes bounded issue records. Core does not guess the newest event. A failed or cancelled attempt appears as `lastAttempt` but does not overwrite the most recent applied or rolled-back revision. Environments are `uniform`, `mixed`, or `unknown` per artifact across **observed** targets only, then conservatively summarized. The projection always reports `deploymentCompleteEstablished: false` and `unobservedTargetsInferred: false` because Core does not know the product-specific target inventory.

The default read returns at most 100 history events, with exact totals and omissions. A caller may request up to the store-wide bound of 4,096. This keeps ordinary status readable without deleting history or adding an ingestion gate.

## Graph genealogy

A verified revision binding adds `ObservationRecord -[:AT_REVISION]-> FileRevision`. If the exact verified revision is historical rather than present in the current source snapshot, the P4 graph creates a derived `RevisionReference` carrying its retained World identity, logical file identity, path, and digest. Declared-only revisions receive no `AT_REVISION` edge. Graph verification rejects a missing or mismatched verified edge.

The graph remains a rebuildable view. Deleting GraphDB or a materialized graph cannot delete delivery records or change current delivery semantics.

## CLI and MCP

```text
lode-agent delivery-observe <project> --input <delivery-observation.json>
lode-agent delivery-status <project> [--environment <key>] [--target <key>] [--history-limit <1..4096>]
```

- `lode_delivery_observe`
- `lode_delivery_status`

The typed observation call intentionally adds no user confirmation checkbox: it records non-authoritative Host evidence and grants no deployment or product authority. Trusted Host composition should construct the structured event; ordinary users inspect the concise status card or ask Lode about an environment or target.

## Acceptance properties

- two environments may show different current revisions without either being overwritten;
- independent artifacts on one target keep independent ordering and current state;
- one-target partial application makes an environment `mixed` rather than complete;
- failed attempts preserve the last applied state;
- rollback is a new immutable event, not deletion of later history;
- missing or conflicting order produces `unknown` rather than receive-time guessing;
- unobserved targets never become successful by inference;
- exact retained source revisions are mechanically verified and graph-linked, while declared references stay disclosed;
- generic Observation input cannot self-assert the reserved verified delivery binding;
- P1 Product Canon, P2 recovery, and ReviewDecision bytes remain unchanged;
- CLI and MCP return the same Core projection identity.
