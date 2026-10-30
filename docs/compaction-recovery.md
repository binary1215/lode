# Compaction recovery

Saved P2 direction and selected work/Todo evidence support continuation. Optional bounded prompt/final-response references from supported Hooks are quoted P5 context, not full transcript capture or current approval. Managed automatic continuation still needs a trusted Host adapter; ordinary read-only entry and fork guidance do not implement that lifecycle. See [Host support](session-work-context.md).

Compaction is a lossy provider operation. Recovery authority remains the canonical Session/Run checkpoint; provider transcripts, compaction summaries, provider-session identities, and `LodeContinuitySnapshot` are orientation or derived views only.

Protocol `0.3.0` embeds the P2 recovery/lineage boundary from
[`authority-plane-contract.md`](authority-plane-contract.md). A ResultPacket or
Worker Report is P3 evidence, not a prerequisite for reading the checkpoint's
purpose, approved decisions, current position, or exact next expected result.
Deleting ResultPacket evidence after checkpoint creation is covered by an
executable recovery test; it cannot turn a summary, graph, inbox, or provider
session into recovery authority.

Checkpoint authority metadata states that recovery fields come only from explicit
Lode/user direction plus verified P2 lineage. P3 evidence may be referenced for
audit but is never a recovery-field source; general non-amplification tests reject
P3, P4, and P5 attempts to become P2.

## Automatic conversation UX

On project entry, after compaction and after provider replacement, the Skill
reuses sufficient verified current context already supplied for the exact
Project and selected logical Session, including current common direction and
cancellations. If needed content is missing, it obtains it once through the
normal read-only `lode_conversation_enter` path. Relevant basis changes require
the affected current originals, not another setup/status/list/graph chain. Entry
has three bounded outcomes:

- a current checkpoint verifies and its exact P2 direction is restored;
- no checkpoint exists and ordinary work continues without a recovery gate; or
- checkpoint integrity needs attention, which pauses only checkpoint-dependent
  work and never invents direction.

The same call includes the bounded project-status, Attention, loaded/configured
package-version, and presentation projections, so normal entry does not require
a second status call. Detailed World inspection is explicitly unchecked on
ordinary entry, not current, stale or absent; full status/doctor diagnosis remains
available when needed, without a mandatory follow-up. Recovery verification failure is `headActionRequired`, not
a user decision. `userDecisionRequired` remains false unless an independent
protected decision is actually pending, and `ordinaryWorkBlocked` remains false.

The user does not provide checkpoint identities, lifecycle events, trusted turn
counters, or continuation tokens. Explicit `session-restore` and `compact-*`
commands remain advanced diagnostic surfaces.

When recovery needs explanation, project readiness and conversation entry reuse
the same `lode_checkpoint_diagnose` contract. It reads `basis B0`, verifies
artifact restore, then reads `basis B1`; changed observations require a fresh
read. It writes no lock or cache, triggers no model call, and does not claim an
atomic filesystem snapshot or ABA detection. Missing pointer, missing pointed
ledger artifact, integrity failure, required-lineage drift, and optional P3
ResultPacket loss remain separate. Its sync-availability field is mechanical and
does not claim that checkpoint prose still reflects current user intent.

At a natural durable-work or context-loss boundary outside an already open
compaction epoch, provider Lode may use `lode_checkpoint_basis` followed by
`lode_checkpoint_sync`. The first call is a non-persisted read-only comparison;
the second revalidates the same exact Project/Session/Run and publication state
under the existing mutation lock. Identical state and direction reuses the
current checkpoint without a write. Stale direction conflicts, and an incomplete
Run transition or changed direction during an open epoch defers only the sync.
The user is not asked to save, approve, or supply protocol fields. See
[`session-recovery.md`](session-recovery.md#freshness-gated-checkpoint-synchronization).

## State transition

```text
idle -> prepared -> verified -> continued
                  \-> superseded
                  \-> aborted
```

`compact-prepare` creates a content-addressed `SessionRunCheckpoint` with:

- `purpose`
- `approvedDecisions[]`
- `currentPosition`
- `nextExpectedResult`
- an immutable `sessionPointer` over the current Session mode, Run/review pointers,
  last result/review references, and required next-plan action
- a verified active-Run pointer, when a Run is active
- an optional verified accepted-Run integration reference
- open review references

An active-Run pointer binds the exact Run, WholePlanSnapshot, ExecutionContract, and ContextCapsule digest. The checkpoint—not the Capsule—owns recovery direction.

The immutable Session pointer makes exact one-shot continuation falsifiable:
its current target must still match the checkpoint. Ordinary artifact recovery
instead separates historical meaning from verified current execution facts; see
[state separation](recovery-state-separation.md).
Protocol `0.1.0` and `0.2.0` checkpoints remain digest-readable for audit, but
they do not contain the complete pointer required by current artifact-only
restore. See [Session restore and reviewed-result integration](session-recovery.md).

The same operation creates one `CompactionEpoch`. The epoch contains the checkpoint identity, the real-user-turn sequence at preparation, state, and a hash bound to an unguessable continuation token. The raw token is returned once and is not persisted. No provider-session identity is stored.

`compact-verify` accepts explicit provider-success evidence and the current trusted real-user-turn sequence. It re-reads and digest-verifies the checkpoint and current Session/Run pointers. A newer real user turn supersedes the continuation. Provider failure, checkpoint tamper, state drift, or a non-canonical recovery source aborts or rejects recovery; the Core never fills missing direction from a summary.

`compact-continue` revalidates the current checkpoint, Session, Run and epoch before atomic at-most-once token consumption. A newer checkpoint or user turn invalidates old continuation. It returns exact checkpoint-bound direction; a second consumption fails. Verification writes one epoch update, without a separate derived recovery receipt or intermediate provider-compacted write.

Prepare validates its inputs and any existing open epoch before changing the
current checkpoint. Mutating Session/Run recovery operations share a transient
project-local P5 lock; reads never acquire it. Contention asks the caller to retry
the affected operation, not the user to approve it. An interrupted prepare closes
only its uncertain token epoch on the next mutation, preserving the complete P2
checkpoint that was actually published. This is process-interruption recovery,
not a guarantee of power-loss durability. A dead local owner can be reclaimed;
an unknown or foreign-host owner is not guessed dead. A reused PID can require
Host-side ownership inspection and operational lock cleanup; Core does not steal
a possibly live lock based on age. This does not block read-only or ordinary work.
Release removes its own lease, not the shared `.lode/.operations` parent. That
single empty directory is a stable P5 container, not a new artifact per operation.

If the continuation consumption is durable but committing the terminal epoch
fails, status reports an uncertain outcome without repairing anything. The next
mutation closes that exact P5 epoch as aborted; it never replays the token or
claims provider execution. Lifecycle retry restores current verified P2 direction,
acknowledges the retained event, and requests a fresh logical Lode without another
user approval. A lost acknowledgement can be retried without new artifacts. A new
prepare is then possible. Neither settlement nor status authors a checkpoint.

## Provider-neutral Host lifecycle boundary

The Core does not invoke provider compaction. An injected Host adapter may expose
one journaled `conversation-entry`, `provider-replaced`, `before-compaction`, or
`after-compaction` event at a time. Its descriptor is fixed to P5, carries no
recovery/instruction/promotion authority, and promises not to replay an uncertain
mutation. Events contain the exact Project, Lode Session, runtime, monotonic
trusted real-user-turn sequence, and only for post-compaction an epoch plus the
bounded outcome `succeeded`, `failed`, or `uncertain`. Provider session IDs,
transcripts, summaries, prompts, credentials, PIDs, sockets, and UI identities
are rejected from this contract.

`lode_compaction_lifecycle_step` processes the event without exposing those
operational fields to the user:

1. Before compaction it reuses an exact current checkpoint when possible. If new
   recovery direction is needed, provider Lode authors it from the current user
   direction, existing approved decisions, and verified P2 lineage only; it may
   not invent an approval, and the user is not asked to fill a schema.
2. The raw token is retained only by the Host adapter and never returned from the
   lifecycle result or persisted in project Canon.
3. After a reported success, Core performs artifact-only P2 restore first, then
   verifies the exact epoch/checkpoint/current turn and consumes at most once.
4. A newer real user turn supersedes the old continuation. An uncertain outcome
   is not verified, continued, or automatically replayed. Provider failure aborts
   only the epoch.
5. If transport continuation is unavailable after successful P2 restore, the
   epoch is closed and Lode continues as a disclosed fresh logical Lode from the
   verified artifacts.

Codex and Claude already deliver recorded Lode context through their packaged
`SessionStart` hooks, including `compact`. Codex runs that hook before the
immediate continuation after root-session compaction. See the
[Codex hook contract](https://learn.chatgpt.com/docs/hooks#sessionstart).

For OpenCode V1, the packaged plugin appends read-only context through
`experimental.chat.system.transform` on each model request. This includes the
summary request and the next ordinary request; it is not an exactly-once
post-compaction event. The supported source contract is OpenCode v1.19.0 at
`733b2c627e5aec39cb33cc22373bdce33053ef2c`. Code-mode/V2 is outside this support
claim. The plugin preserves user and summary prompts and other plugins' system
text. It rechecks the exact native Session, Project and directory, then reads
the existing selected Session and current shared constraints. Missing or lost
selection never substitutes the default or parent Session and does not block
ordinary work.

The OpenCode addition is capped at 32,768 UTF-16 characters, matching the
existing Codex delivery resource bound; Claude retains its 10,000-character
bound. These are serialization bounds, not a claim of sufficient context.
Omitted content keeps its existing disclosure and references for expansion.

Claude Code and Codex store a bounded local reference to recent user `prompt`
text from `UserPromptSubmit`. The text stays outside project Canon. `PreCompact`
freezes that reference and returns no hook decision. `SessionStart` sources
`compact` and `clear` append it only when the existing character ceiling still
has room. The reference is labeled non-authoritative. The checkpoint remains
the recovery source.

OpenCode stores user text from `message.part.updated`. It has no separate
pre-compaction event that carries the prompt, so those message events are the
capture point. `experimental.session.compacting` freezes the reference.
`session.compacted` and a `command.executed` event whose name is `clear` mark
it for one later `experimental.chat.system.transform`. That transform appends
it when it fits and does not append it on ordinary turns. If the host does not
emit `command.executed` for `/clear`, OpenCode has no `/clear` signal.

This delivery reads recorded originals and that bounded prompt reference. It
does not create a checkpoint or compaction epoch, authorize an effect, or
implement managed one-shot continuation. That managed lifecycle still
requires a trusted Host adapter with its existing exact evidence. Local SDK-stub,
pinned-source consumer and generated-package tests do not prove an installed
Host or live model run. Missing optional integration leaves ordinary work usable.

```text
lode-agent compact-prepare <project> --input <recovery.json>
lode-agent compact-verify <project> --input <verification.json>
lode-agent compact-continue <project> --input <continuation.json>
lode-agent compact-status <project>
lode-agent compact-abort <project> --input <abort.json>
```

The mutating commands are advanced `help-all` operations; read-only
`compact-status` remains a light diagnostic. Observe and ordinary Session work
create no epoch by default. An active Run should prepare at a natural idle
boundary before provider compaction. Compaction never approves an open review,
changes Product Canon or candidate bytes, or performs an external write. Explicit
prepare may publish Lode-authored P2 direction as a new checkpoint; provider
compaction and continuation never author or replace that direction.

General checkpoint sync never closes, aborts, or replaces an open epoch. Exact
checkpoint reuse is free of artifact and pointer writes; any changed direction
waits for the existing compaction transition to reach its own terminal path.
This keeps operational recovery from becoming a new global work gate.

Host integration additionally uses `lode_conversation_enter` and
`lode_compaction_lifecycle_step`; they are not a user setup ritual. The lifecycle
step is non-blocking-unavailable when no adapter is injected.

Example prepare input:

```json
{
  "runtime": "codex",
  "userTurnIdAtPrepare": 42,
  "purpose": "Preserve the accepted whole outcome",
  "approvedDecisions": ["The provider summary is not recovery canon"],
  "currentPosition": "Implementation is complete; integrated verification remains",
  "nextExpectedResult": "A verified integrated test result",
  "openReviewIds": []
}
```

Verification requires `epochId`, `checkpointDigest`, `currentUserTurnId`, and `providerCompacted: true`. Continuation requires `epochId`, the one-time `continuationToken`, and `currentUserTurnId`.
