# Provider-neutral Lode constitution

## Purpose

Lode Agent Core preserves one coherent project direction across context loss,
provider replacement, optional workers, and replaceable storage. It does this
with a small normative constitution and typed internal enforcement. The
mechanisms are subordinate to the protected outcomes.

## Normative rules

1. **One coherent project direction.** One canonical Project holds common user
   direction and multiple independently routed logical Lode Sessions. Each
   Session preserves its own purpose, progress, active work and recovery.
   Provider sessions, panes, processes and model calls are replaceable consumers.
2. **Direct work is the default.** Lode handles ordinary work coherently.
   Delegation is justified only by a bounded, independently reviewable whole
   outcome; parallelism does not create scope or authority.
3. **Recovery is artifact-owned.** Plans, contracts, checkpoints, and exact
   references preserve direction. Summaries and transcripts may help a human
   orient, but cannot rewrite recovery state.
4. **Outputs are evidence.** Worker results, runtime events, messages,
   repository observations, and external reviews remain reviewable evidence.
5. **Views are replaceable.** Graphs, indexes, Markdown, Context Capsules, and
   continuity snapshots are reproducible consumers of authority-bearing and
   evidentiary records. They cannot become unique truth by convenience.
6. **Authority is explicit.** Product Canon changes only through a user-authored
   ReviewDecision scoped to the exact current candidate set. Execution success,
   model agreement, and author feedback do not imply approval.
7. **Provider neutrality preserves semantics, not feature symmetry.** Each
   adapter may expose only the capabilities it can prove. Missing optional
   capability is disclosed; Core contracts are never weakened to imitate a
   provider-specific runtime.

## Profiles

The public initialization transaction has two profiles:

- `core` is the default. It preserves Project/Session anchors and provider
  projections and indexes eligible existing observations for graph discovery.
  Product inference, Canon promotion, whole-World construction and governed
  documents remain optional.
- `product` explicitly starts or resumes evidence-linked onboarding and the
  review-gated Product/World/Graph path.

The product profile is an optional governance capability, not the definition of
Lode itself. A core resume preserves any existing product state without
refreshing or promoting it. Supplying onboarding input without explicitly
selecting `product` fails closed.

Profiles are per-operation choices, not persistent modes. A read-only readiness
projection may explain Core and Product state, recommend a next action, and
disclose optional capability prerequisites. That projection has no authority:
it cannot activate Product, create execution lineage, grant authorization,
repair drift, or write recovery direction.

## Records and graph boundary

The graph records provenance *about* authoritative and evidentiary artifacts;
it does not become the record of authority.

| Concern | Durable owner | Graph or document role |
| --- | --- | --- |
| approved product meaning | Product Model revision + ReviewDecision | projection and audit trail |
| common direction and independent progress | ProjectDirection + selected Session/Run pointers + checkpoint | referenced recovery view |
| execution outcome | ResultPacket + review lineage | evidence traversal |
| repository observation | SourceSnapshot and immutable revisions | bounded discovery |
| host effect | lease, PID, endpoint, delivery receipt | operational evidence only |

If a graph, database, Markdown view, or cache disappears, the system must remain
recoverable from its canonical records and evidence. Rebuilding a view must not
create a ReviewDecision, advance a Session, consume an authorization, or claim a
host effect.

## Compaction continuity

When the managed compaction lifecycle is chosen, use its four-step protocol:
prepare an immutable checkpoint, compact in the provider, verify the resulting
context against trusted real-user-turn evidence, and consume one continuation
token. Ordinary native compaction and startup instead reuse sufficient supplied
context or read-only conversation entry. Without a checkpoint, ordinary direct
work and Host delegation continue; edits, worker count and ordinary failures do
not require the managed lifecycle. The fixed recovery anchors remain
`.lode/project.json`, the selected logical Session record, and its exact
checkpoint. `.lode/sessions/current.json` remains the default Session record;
other Sessions use `.lode/sessions/by-id/<session-id>/current.json` without
switching that default. Read current common ProjectDirection alongside restore:
older checkpoint fields stay exact, but cannot undo newer shared constraints or
cancelled actions. Provider summaries are never promoted into these anchors.
A newer user turn supersedes the prepared continuation.

## Graph-first discovery and execution choice

New project information starts with bounded graph discovery or sufficient
same-basis reuse. Lode work and Product are logical views of common originals.
Queries retain revision, provenance, coverage and original candidate/rejection
state, including intact historical evidence. Absence or failed coverage calls
for original-source fallback, not a general readiness gate. Full World currentness,
Product approval, indexing completion, Run/Capsule and a database connection are
not prerequisites for ordinary exploration. Damaged layers are excluded separately;
effects recheck current sources and authority.

Direct work, ordinary Host delegation and managed execution serve the needed
outcome. Managed work is useful for durable ownership, interruption recovery or
uncertain/duplicate effects; edits, worker count or ordinary failure do not force
it. Fork/fresh is a separate context choice and does not grant approval,
isolation or cache guarantees. Preserve completed contributions and reconcile
unknown effects before replacement while independent work continues.

After meaningful code or feature work, Lode owns checking whether the integrated
result needs graph maintenance. Connect purpose, implementation and actual
verification to their original records, update necessary supported relations,
and disclose unknown or unprojected scope. Graph projection never creates meaning,
approval or recovery direction. Reuse sufficient existing updates; do not require
per-turn full refresh, World/DB activation, new Run/Capsule, watcher or routine
user approval. Failed maintenance leaves a scoped evidence gap while current
original-source fallback and independent work remain available. See
[graph maintenance](graph-discovery.md#maintain-evidence-after-integrated-changes).

## Conformance test

An extension conforms only if it can answer yes to all of these:

- Can the Project and Session survive replacement of the provider component?
- Can the protected outcome work without optional Product/Graph machinery?
- Is every authority transition explicit, scoped, and replay-safe?
- Can every derived view be rebuilt without inventing meaning or direction?
- Does an unavailable optional adapter disclose loss instead of weakening Core?
- Are worker and host effects bounded by exact identity, ownership, and cleanup
  evidence?

The detailed enforceable mapping is in
[`authority-plane-contract.md`](authority-plane-contract.md).
