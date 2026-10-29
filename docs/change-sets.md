# Provider-neutral ChangeSet and reviewed impact

Read [`architecture.md`](architecture.md) and
[`authority-plane-contract.md`](authority-plane-contract.md) before changing
this contract.

## Purpose and authority

ChangeSet record protocol `0.3.0` records one reviewed logical change independently from Git commits, branches, providers, or executor attempts. A ChangeSet is created only from:

- the verified World Model and temporal GraphSnapshot pinned by an ExecutionContract ContextCapsule;
- a different, current post-execution World Model and SourceSnapshot;
- the matching ResultPacket;
- an accepted execution ReviewDecision.

It records exact added, modified, and removed `File`, `Symbol`, and `Test` revisions. It has reviewed change-lineage status but no instruction or promotion authority. New records pin each endpoint with the exact `worldModelId`, `graphSnapshotId`, and `sourceSnapshotId` already observed before the record is created. Retrieval verifies the retained World identity, Project, and graph/source pair directly; it does not need to inventory unrelated snapshots. World IDs locate exact retained evidence and do not confer authority. The Git-independent graph/source revisions, ResultPacket, and ReviewDecision remain the semantic evidence. Existing record `0.1.0` and `0.2.0` originals retain their two-key endpoints, bytes, hashes, and IDs; their bounded pair lookup can report partial coverage. State, impact candidates, and impact reviews remain protocol `0.2.0`. Git may later attach optional `VcsEvidence`; no `.git` directory or commit identity is required.

## Two-stage identity boundary

The pre-change and post-change snapshots are fixed before the ChangeSet exists. The ChangeSet is then projected by a subsequent World Model rebuild. This avoids a self-referential graph identity: adding a ChangeSet changes the GraphSnapshot and World Model projection, but not the already-fixed observed SourceSnapshot identity.

ChangeSets contain sorted zero-or-more `parentChangeSetIds`. Multiple parents are valid from protocol `0.1.0`; automatic merge, ancestry discovery, conflict detection, and conflict resolution remain deferred.

## Impact candidates and review

The plugin compares exact before/after revisions and follows only existing reviewed `IMPLEMENTS` and `VERIFIED_BY` receipts to infer Feature or Capability impact. Inference creates an immutable `ChangeImpactCandidateSet`. It never creates `IMPACTS` directly.

An explicit change-impact ReviewDecision may:

- `accept-all`;
- `accept-selection` with named candidate IDs;
- `reject`.

Acceptance creates a separate immutable `ReviewedImpact` receipt and a reviewed `ChangeSet -[:IMPACTS]-> Feature|Capability` edge. Rejection creates no canonical impact edge. Candidate nodes remain excluded from normal traversal and every Context Capsule; explicit read-only traversal may opt in.

Acceptance still requires the exact candidate evidence to be current. An explicit `reject` may close the exact stale candidate set because rejection makes no freshness claim; Core first refreshes only the derived World view, then records the rejection. The immutable P1 `ReviewDecision` is written before its rebuildable P4 World/Graph projection and mutable state pointer. If a later write fails, an unchanged retry reuses that exact durable decision and repairs only the missing projection or pointer without asking for another user decision. A conflicting retry fails closed. A legacy orphan P4 projection can be recovered only when the current explicit request, full projection digest, review digest, source identity, and all non-derived drift checks match; Graph never supplies the missing authority.

If no reviewed mapping connects changed code or tests to Product Canon, the candidate set records an open Unknown and remains `awaiting-evidence`.

## Optional VCS evidence

VCS evidence protocol `0.1.0` attaches one or more explicitly selected Git commit observations to an existing ChangeSet. The attachment command accepts only commit object IDs present in the current digest-verified `GitDecisionHistory`; it does not infer equivalence from timestamps, messages, diffs, branch names, or executor sessions.

The immutable `VcsEvidence` artifact embeds normalized `GitCommitObservation` records and the Git-history identity that verified them. This permits later GraphSnapshot reconstruction when `.git`, the Git executable, or the original history adapter is unavailable. The attachment never edits the ChangeSet and does not add Git identity to its hash. It projects only:

```text
ChangeSet -MATERIALIZED_AS-> VcsEvidence -REFERENCES-> GitCommit
```

These nodes and edges are derived evidence with `instructionAuthority: false`, `promotionAuthority: false`, and `evidence-not-instruction`. A commit is neither a ChangeSet nor proof that the implementation satisfies Product Canon. Missing history, unknown commit IDs, source drift, artifact tampering, and active/pending Run conflicts fail closed for attachment; all Git-independent operations remain available.

## Commands

```text
node scripts/lode.mjs change-set-record <project> --input <change-set.json>
node scripts/lode.mjs change-set-status <project>
node scripts/lode.mjs change-set-read <project> --change-set <change-set-id>
node scripts/lode.mjs change-impact-candidates <project> --candidate-set <candidate-set-id>
node scripts/lode.mjs change-impact-review <project> --input <review.json>
node scripts/lode.mjs change-impact-review-read <project> --review <review-decision-id>
node scripts/lode.mjs change-set-vcs-attach <project> --input <vcs-evidence.json>
node scripts/lode.mjs change-set-vcs-read <project> --vcs-evidence <vcs-evidence-id>
```

Minimal recording input:

```json
{
  "resultPacketId": "result-packet-<24-hex>",
  "reviewDecisionId": "review-decision-<24-hex>",
  "parentChangeSetIds": []
}
```

`beforeWorldModelId` is optional. When omitted, the core recovers the exact World Model pinned by the ExecutionContract ContextCapsule. The current post-change World Model must be fresh and must contain a different SourceSnapshot.

Review input:

```json
{
  "candidateSetId": "change-impact-candidates-<24-hex>",
  "disposition": "accept-all",
  "acceptedCandidateIds": [],
  "rationale": "Reviewed revision evidence supports the impact."
}
```

VCS evidence attachment input:

```json
{
  "changeSetId": "change-set-<24-hex>",
  "commitIds": ["<40-or-64-hex-git-object-id>"],
  "rationale": "This verified commit observation materializes the reviewed logical change."
}
```

The read-only MCP tools `lode_change_set_status` and `lode_vcs_evidence` expose verified state and attachments without recording, reviewing, or promoting anything. When an exact durable impact decision exists but its state pointer is pending, status reports recovery with `requiresNewUserDecision: false` and directs the caller to retry the unchanged decision.

## Project artifacts

```text
.lode/change-sets/current.json
.lode/change-sets/records/change-set-*.json
.lode/change-sets/impact-candidate-sets/change-impact-candidates-*.json
.lode/change-sets/impact-review-decisions/change-impact-review-decision-*.json
.lode/change-sets/vcs-evidence/vcs-evidence-*.json
```

Every artifact and pointer is content-derived and digest-verified. Source drift, unaccepted execution review, mismatched ResultPacket/ReviewDecision, missing pinned snapshots, stale candidate identity, tampering, active/pending Run conflict, and empty revision difference fail closed.

## Deferred boundaries

Automatic ChangeSet creation from CI or filesystem events, inferred commit-to-ChangeSet matching, general execution-lineage graph projection, merge automation, imported ticket/backlog adapters, projection of document review receipts into later graphs, Obsidian/Notion projection, and GraphDB acceleration remain deferred. Non-blocking provider-Lode Conformance candidates are active as a separate P3/P4/P5 subsystem and never reuse this blocking impact-review state pointer; see [Conformance reconciliation](conformance-reconciliation.md). Explicit DocumentChangeCandidate review/application is active but does not create a ChangeSet or alter ChangeSet authority.
