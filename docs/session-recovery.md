# Session restore and reviewed-result integration

This contract implements the provider-neutral outcomes of the original Lode
Session restore and worker-result integration flow without resuming a hidden
provider conversation or embedding Herdr-specific process, pane, CLI, socket, or
TUI behavior.

## Moving a Project folder

After moving or copying the complete Project directory, ask Lode to resume at
its new path, or run `node scripts/lode.mjs resume "<new-project-directory>"`
from the plugin directory. The same typed initialize/resume tool supports this;
an explicit logical `session_id` selects that existing Session.

Resume preserves the Project ID, default and named Session IDs, checkpoints,
Work records and World originals. It retains exact previous Project metadata
locally, verifies its identity chain, and updates only the current location and
its managed manifest entry. Interrupted publication resumes the exact pending
transition; divergent files or conflicting local owners are not overwritten.
Actual source and adapter reads use the new path, never the historical path.
Source changes at the new location still produce ordinary freshness/drift results.

Old execution authorizations, root-bound leases and native Host bindings do not
move with this identity. Re-establish those operational capabilities only when
needed under their existing contracts. Resume does not replay an effect, change
recovery direction, require a new Product review or re-onboard the Project.
The plugin does not move files for you, scan the old location, or enforce that
only one copy exists globally. User-owned integration files remain preserved.

## Original Feature mapping

The original source numbering is preserved rather than repurposed:

| Original Feature | Original outcome | This plugin's relationship |
|---|---|---|
| HF-007 | continue through context compaction | implemented by the separate provider-neutral compaction recovery contract |
| HF-008 | restore a prior Lode OpenCode Session | artifact-only restore reproduces the semantic consumer input; provider `ses_*` resume is intentionally not claimed |
| HF-009 | dispatch an independently ownable worker task | belongs to the separate bounded runtime/coordination vertical; this integration transaction is not dispatch |
| HF-010 | integrate a completed worker branch | represented provider-neutrally by accepted ResultPacket review plus explicit Lode-owned checkpoint integration |

This mapping distinguishes behavioral equivalence from ritual parity. It does not
rename provider-loss continuity as HF-010 or claim that a checkpoint transaction
alone closes the original dispatch/wait lifecycle.

## Authority boundary

| Artifact | Plane | Role |
|---|---|---|
| `WholePlanSnapshot`, `ExecutionContract`, `ContextCapsule`, `Run`, `SessionRunCheckpoint` | P2 | recoverable project execution lineage and exact next direction |
| `ReviewDecision` | P1 | Fresh Lode's explicit normative judgment |
| `BoundedWorkerDispatch`, `ResultPacket` | P3 | worker ownership and result evidence; legacy integration request/receipt records remain readable |
| `SessionRestoreProjection` | P4 | non-persisted, reproducible consumer view |
| `ContinuationOutcome`, `BoundedWorkerWaitOutcome`, execution lease/process | P5 | optional live attachment and operational progress only |
| `BoundedWorkerWave`, seal, abandonment | P3 | same-lineage multi-dispatch grouping and non-success handoff evidence |
| `WorkerWaveStatusProjection`, `WorkerWaveResultProjection` | P4 | non-persisted launch-wave views |
| `BoundedWorkerWaveWaitOutcome` | P5 | bounded sealed-wave observation only |

The planes are not a persistence ranking. A P3 ResultPacket can be absent after
checkpoint creation without changing P2 direction. A P1 ReviewDecision can
accept a result, but it does not replace the P2 Session checkpoint. The
integration operation receives `purpose`, `approvedDecisions`, `currentPosition`,
and `nextExpectedResult` explicitly; neither a worker reply nor ResultPacket is
allowed to author those fields.

## Independent Session routing and current common direction

One canonical Project has independently routed logical Lode Sessions.
`session_id` (MCP) or `--session` (CLI) selects the request's target without
switching `.lode/sessions/current.json`; additional records live under
`.lode/sessions/by-id/<session-id>/current.json`. Existing identities, review
records, active and unknown work stay intact. Session-local purpose/progress
updates do not overwrite another Session or common direction.

Restore also returns `currentProjectDirection` from the current common P2 record.
Its goal, constraints, decisions and cancelled actions remain distinct from
historical checkpoint fields: a past deploy step cannot revoke a later shared
cancellation. `lode_project_direction_update` requires the exact read
`expected_direction_id` and current user direction. Concurrent differences require
reconciliation. Neither restore nor this direction record grants an execution
authorization. An older valid record remains inspectable history, while a stale
checkpoint cannot drive current effect execution merely by being readable.

If a verified Project has lost its selected Session, ordinary work and common
direction remain available. Entry returns `sessionDiscovery.call` for the
existing read-only `lode_session_list` with that exact Project root. Reuse
verified candidates already supplied; call discovery only when missing dependent
context matters. Startup/failure does not enumerate Sessions or select a default.
The list bounds returned state, but enumerates directory names; do not describe
it as bounded total scan cost. Titles and recency never prove the same task or
carry past approval. A damaged or foreign Project owner cannot supply a
same-Project discovery hint.

## Artifact-only Session restore

`session-restore` starts from the current canonical checkpoint pointer and:

1. digest-verifies the content-addressed `SessionRunCheckpoint`;
2. requires current protocol `0.3.0` and its immutable `sessionPointer`;
3. preserves the historical pointer separately from the selected Session record (`current.json`
   for the preserved default, or `by-id/<session-id>/current.json`);
4. re-verifies the current WholePlan and, when active, exact Run,
   ExecutionContract, and ContextCapsule digest;
5. re-verifies pending review lineage when ResultPacket evidence is present;
6. returns a deterministic, non-persisted `SessionRestoreProjection`.

The read-only project experience may run this exact verification to report
`no-current-checkpoint`, `verified-current-checkpoint`, or
`attention-required`. That readiness view does not return recovery direction,
consume a continuation token, or attach a provider. Lode reads the full restore
projection only when a verified current checkpoint exists.

Projection 0.2 preserves exact checkpoint meaning and exposes current execution
separately. Old position/next result is labelled under
`consumerInstruction.historicalCheckpointContext`, not issued as a current next
action. Pointer differences alone do not fail ordinary restore. Tamper,
owner/reference contradictions and required current lineage loss remain scoped
failures. Provider identities, transcript/summary, resume/stream remain outside
this view. See [state separation](recovery-state-separation.md).

`lode_conversation_enter` composes this same read-only restore with bounded
project-status facts when needed current entry context has not already been
supplied. The Skill reuses sufficient verified context for the exact Project and
selected logical Session, including current common direction and cancellations;
relevant basis changes require only the affected current originals. It does not
make the user request recovery, supply an identity or perform a second status
round trip. Ordinary entry leaves detailed World inspection explicitly unchecked,
not current, stale or absent; full status/doctor diagnosis remains available when
needed, not as a compulsory follow-up. No current checkpoint means ordinary work
continues; verification failure is assigned to Lode and pauses only
recovery-dependent work. Explicit `session-restore` remains available for
diagnostics and adapter integration.

If P3 ResultPacket evidence was deleted after checkpoint creation, restore still
returns the exact P2 direction and marks the evidence `missing-evidence`; it does
not manufacture a Fresh Lode review context. The caller must recover or reproduce
the required evidence before review.

## Read-only checkpoint diagnosis

`lode_checkpoint_diagnose` is the common read-only P4 diagnosis used by project
readiness and conversation entry when a current pointer exists, and exposed by
typed MCP and the advanced CLI. It reports the
current checkpoint pointer or its absence, artifact-only restore verification,
mechanical checkpoint-sync availability, and one bounded next Lode action. It
does not write a lock, cache, checkpoint, Session pointer, approval, or Canon.
Reading it does not invoke another provider Lode or model assessment.

For a current pointer, diagnosis performs the bounded sequence
`basis B0 -> artifact restore -> basis B1`. A normal result requires equal basis
identity and Session hash plus an exact Project, Session, checkpoint ID, and
checkpoint digest match in the restore tuple. If the observations change, the
result is `observation-changed-retry`; it never merges both reads into a normal
state. These are sequential filesystem observations, not an atomic snapshot.
They cannot detect a change-and-revert ABA between reads, and the projection says
so explicitly.

The projection keeps these cases distinct:

- no current pointer;
- a pointer whose checkpoint ledger file is missing;
- checkpoint or required-lineage structural/digest failure;
- a missing required Session, Run, lineage, or Capsule artifact;
- a verified checkpoint whose Session or required lineage has drifted;
- verified P2 recovery with missing optional P3 ResultPacket evidence; and
- state changing during the read sequence.

Optional ResultPacket loss does not invalidate self-contained P2 direction, but
review-dependent work still needs that evidence. Required artifact loss or
integrity failure is never downgraded to optional loss, staleness, or absence.
Artifact recovery and sync availability are separate axes: a stable pointer drift
may make the old checkpoint unrestorable while a fresh, Lode-authored direction
is mechanically publishable. Neither fact proves semantic freshness. Equality of
IDs, hashes, or basis bytes cannot establish that the natural-language direction
still represents the latest user intent; only the current provider Lode assesses
that when checkpoint work is materially relevant.

## Freshness-gated checkpoint synchronization

Normal provider Lode operation uses a read-derive-sync sequence rather than
blindly rewriting the Session checkpoint:

```text
lode_checkpoint_basis (read-only P4 comparison)
  -> current provider Lode derives direction from that exact basis
  -> lode_checkpoint_sync (locked P2 publish or exact reuse)
```

The non-persisted basis binds the exact Project and Session, current checkpoint,
Session record hash, Run/WholePlan/ExecutionContract/Capsule and review
references, any Run publication transition, and current compaction epoch. Core
rebuilds it under the existing Session-recovery mutation lock immediately before
publication. The basis is concurrency evidence, not recovery direction and not
an approval.

Synchronization has four explicit outcomes:

- `created`: one new content-addressed checkpoint was published and the Session
  pointer advanced;
- `reused`: the current checkpoint already has the same normalized direction and
  exact current lineage, so neither ledger nor Session pointer is written;
- `deferred`: an incomplete exact Run transition or changed checkpoint during an
  open compaction epoch must be handled first; ordinary independent work remains
  available;
- `conflict`: the supplied basis is stale or the recorded Run transition conflicts
  with current Session state, so no recovery bytes are written.

The checkpoint identity for one unchanged basis and direction is deterministic.
Retries before ledger publication, after ledger publication but before Session
pointer publication, and after pointer publication therefore converge without a
second ledger entry. Concurrent identical calls converge on `created` plus
`reused`; a different concurrent direction cannot overwrite the winner.

Core can prove identity, lineage, transition state, and byte equivalence. It
cannot prove that a model actually reconsidered natural-language direction.
Provider Lode must derive direction *after* reading the returned basis; changing
only `expectedRecoveryBasisId` on an older direction violates the caller
contract. This does not create a user confirmation step.

Stable pending review is a valid checkpoint boundary. An incomplete finish or
review publication is not: sync returns `deferred` until the exact existing Run
operation completes its missing Session write. A general sync never accepts or
creates `reviewedRunIntegration`. It may reuse an exactly current integrated
checkpoint, but changed direction or lineage creates an unbound checkpoint;
accepted-result binding remains exclusive to `run-integrate-checkpoint`.

Short Observe work, conversation entry, status reads, and absent Host hooks do
not create a first checkpoint. A trusted Host may invoke this sequence at a
natural context-loss, handoff, or durable-Run boundary. Provider Lode may also
use it when an existing checkpoint should reflect a user objective/constraint
change, verified stage completion, failure/wait transition, or whole-task
completion. Lode first decides whether durable recovery direction materially
needs publication; this is never a mandatory per-turn call. No daemon, timer,
extra per-turn model call, or provider-session identity is required.

Protocol `0.1.0` and `0.2.0` checkpoints remain readable through the checkpoint
reader for audit and compaction compatibility. They cannot drive current
artifact-only restore because they predate the immutable Session pointer. The
public `lode-agent checkpoint` command now writes only the canonical content-addressed
P2 format. The old direct time-based API is retired and cannot advance
`latestCheckpoint`.

## Bounded reviewed-result integration

The connected flow is:

```text
BoundedWorkerDispatch (P3)
  -> at-most-once lease / supervised provider / bounded wait (P5)
  -> ResultPacket (P3)
  -> deterministic Fresh Lode review projection
  -> explicit accept ReviewDecision (P1)
  -> explicit integration input owned by Lode/user direction
  -> SessionRunCheckpoint (P2)
```

`worker-dispatch` binds one registered non-Lode role to the exact current Run
`ExecutionAuthorization`. The same role may retry idempotently; a competing role
conflicts, and the authorization can be consumed only once. `worker-wait` returns
a non-persisted operational outcome. It cannot mutate the WholePlan, supply
recovery direction, or create a ReviewDecision. `worker-apply` accepts only a
completed actual-provider result with verified native supervision and creates
only the ResultPacket plus Fresh Lode review context. Explicit review and the
integration transaction below remain separate.

Multiple existing dispatches may be viewed through the provider-neutral wave
contract in [`bounded-worker-wave.md`](bounded-worker-wave.md). Wave seal is
start-evidence aggregation, not result acceptance. Wave `completed` means all
members succeeded operationally. Each member keeps its own authorization, lease
and returned evidence; this is not a requirement for per-member ReviewDecision
or checkpoint publication. For a multi-worker Run, Lode gathers the individual
evidence, assesses the combined basis and publishes one whole Run ResultPacket.
Fresh Lode review, an explicit ReviewDecision and explicit HF-010 checkpoint
integration then apply to that whole result. Wave completion performs none of
these steps, and it does not terminate outstanding members. The single-worker
`worker-apply` path above is separate from this combined finish; see
[`worker-context-integration.md`](worker-context-integration.md).

## P2-first optional live continuation

`session-continue` always calls artifact restore before consulting a provider or
workspace host. A trusted host-injected adapter may then fresh-verify the exact
current Lode attachment. Its `ContinuationOutcome` is P5 and non-persisted. It
records either `attached` or a disclosed `fresh-logical-head` fallback, keeps the
same checkpoint and restore projection, and never reads provider summary or
transcript. Provider session identifiers are neither canonical nor persisted.
Attach failure therefore changes conversation convenience, not HF-008 semantic
recovery.

`run-integrate-checkpoint` requires the exact reviewed Run and ReviewDecision.
Core re-verifies the Run, ResultPacket, WholePlan, ExecutionContract,
ContextCapsule, Fresh Lode review identity, current Session state, and `accept`
disposition before writing anything. `revise`, `expand`, `rollback`, and
`escalate` stay on their normal next-plan or user-direction paths and cannot be
mislabeled as result integration.

One ReviewDecision binds to at most one recovery checkpoint. A locked publication
stores the exact reviewed lineage and explicit Lode-authored direction in that
checkpoint. Identical retry reuses it; different direction conflicts.
If publication stops between ledger and Session pointer, retry completes only
that pointer update. A later checkpoint is never rolled back by retry.

New integration produces no separate request or receipt. Historical request and
receipt formats remain narrowly readable without rewriting original bytes.
The current builder no longer accepts the historical request-ID input variant.
An already committed historical checkpoint keeps its exact identity on retry.
If only a verified original request remains, read returns
`legacy_integration_pending`; integration reports
`RUN_RESULT_LEGACY_INTEGRATION_PENDING` without writing or automatically finishing
it. Its original input is P3 reference evidence, not restored P2 direction.
Lode inspects actual state and current common direction before manually carrying
forward still-applicable work. No additional user approval or global ordinary-work
block is introduced; malformed originals fail only the affected read/integration.
ResultPacket remains reference evidence; its later absence cannot change the
checkpoint's self-contained direction. Review, operational completion and
checkpoint publication remain distinct meanings, not duplicate approval ceremonies.

## Public surfaces

Worker mutations support explicit useful managed execution when interruption
recovery, ownership or effect tracking needs it. Use CLI `managed`, or discover
the typed tool and call `lode_tools_call` with `execution_mode: "managed"`.
The retained `managed-maintenance` CLI/server remains a compatible entry.
Routing preserves every original authorization, lease, lineage and effect check;
Lode chooses it without a new user unlock. Ordinary read/status/wait and exact
owned cancellation remain available. Recovery alone, worker count, file edits
and ordinary Host failures do not force managed execution.

```text
lode-agent checkpoint <project> --summary <text> [--next <text>]
lode-agent checkpoint-basis <project>
lode-agent checkpoint-diagnose <project>
lode-agent checkpoint-sync <project> --input <head-direction.json>
lode-agent session-restore <project> [--checkpoint <checkpoint-id>]
lode-agent session-continue <project> --runtime <codex|opencode> [--checkpoint <checkpoint-id>]
lode-agent managed worker-dispatch <project> --authorization <authorization-id> --role <non-head-role>
lode-agent worker-wait <project> --authorization <authorization-id> [--wait-timeout-ms <milliseconds>]
lode-agent managed worker-execute <project> --authorization <authorization-id> --role <non-head-role>
lode-agent managed worker-apply <project> --authorization <authorization-id>
lode-agent managed worker-wave-create <project> --input <wave.json>
lode-agent managed worker-wave-seal <project> --wave <bounded-worker-wave-id>
lode-agent worker-wave-status <project> --wave <bounded-worker-wave-id>
lode-agent worker-wave-wait <project> --wave <bounded-worker-wave-id>
lode-agent managed worker-wave-abandon <project> --input <abandonment.json>
lode-agent run-integrate-checkpoint <project> --input <integration.json>
lode-agent run-integration-read <project> --review <review-decision-id>
```

Typed MCP exposes `lode_checkpoint_basis`, `lode_checkpoint_diagnose`,
`lode_checkpoint_sync`, continuation,
dispatch/status/wait/apply, restore, and explicit integration. Basis, restore,
diagnosis, status, and wait are read-only. Checkpoint sync is idempotent and revalidates its
exact basis under the common mutation lock. Continuation may refresh
only the injected host-local P5 attachment; dispatch and application are
idempotent project-state writes. None grants review, Canon, publication, or
external-action authority.

Fresh-process tests run restore with distinct Codex and OpenCode provider-session
environment values and require the same projection identity with neither value
present in the result. Counterexamples cover Session pointer drift, missing
ResultPacket evidence, non-accept review, divergent replay, and CLI/MCP parity.

`npm run verify:hostless-session-recovery` adds the resident-consumer proof. One
fresh process integrates, independent Codex/OpenCode-labeled processes restore
the same projection and execute one read-only next move, and injected inbox text
cannot author that move. The verifier also covers interruption before/after checkpoint
publication, independent writers, divergent integration and non-accept review.
It requires no Git repository, GraphDB, WorkspaceHost, Herdr process, or provider
session resume.

## Bounded prompt references and absent native correlation

Optional local prompt references are redacted plaintext P5 hints, not encryption,
a transcript, an instruction or a P2 recovery source. The reference-only store uses
0700 directories and 0600 staging files on POSIX, checks owned regular entries
and rejects unsafe links. Existing references are bounded and re-masked before
reuse. These are best-effort credential patterns, not a universal secret detector.
On Windows, the dedicated prompt directory and regular single-link files use a
protected DACL limited to the current token SID and SYSTEM. A hidden, bounded
Windows PowerShell/.NET check re-reads that ACL before success; POSIX mode flags
are not used as Windows proof. Verification is reused only for the same filesystem
entry within one synchronous operation, never across callers/turns. No general
operational directory ACL is changed. Missing verifier, unowned entries or unsafe
links suppress capture/reuse rather than claim private storage. This adds local
helper-start cost and does not protect against the same user, administrators or
kernel access, encrypt records, or reverse any prior exposure.
Existing directory/file checks share one fixed helper request; a new stage is
checked separately before plaintext. Helpers share one five-second monotonic
budget per public operation, and a failed check is not retried within that call.
Hooks still wait synchronously for this optional work; it is not a no-overhead or
nonblocking performance guarantee.
Unavailable optional storage suppresses that hint, not ordinary direct work.

An absent Claude native-caller binding cannot silently choose another logical
Session through the Project default. Exact explicit logical routes and explicit
initialize/resume remain available. No old-to-new native-ID correlation is guessed
from recency or a different caller. Synthetic routing tests do not prove actual
Claude `/clear` ID changes or automatic cross-ID restoration.

For Claude's explicit `SessionEnd(reason=clear)` followed by
`SessionStart(source=clear)`, optional P5 carrier continuity can retain an already
selected logical Session. Both events must independently verify the same local
environment, process PID and OS creation identity through an exact CLI registry
entry. The Project, canonical root and agent must match. The old binding's
Session, revision and digest are reread under the existing selection CAS lock;
the new caller must have no binding. PID liveness, recency, or `source=clear`
alone is never enough. The terminal ancestry row does not query its unused
parent; its `ppid=0` means not requested, not a verified parent identity.

The local operational hint cache has at most 64 instances, 128 KiB total and
8 KiB per hint. Its ten-minute lifetime starts at the retained end observation;
replay cannot refresh it. Ambiguous pairs, expiry, tamper, missing observations,
changed mappings and failed writes suppress only automatic linkage. The retained
start must follow the end; a reordered or replayed start cannot acquire a later
hint. A first start without an exact witness cannot be repaired by a later
replay; replaced or evicted caller observations leave its order unconfirmed.
Consumption precedes binding, so a partial write is not automatically retried. There is no
binding inventory search, new logical Session, P2 direction change or effect
replay. Existing explicit selection and ordinary work remain available.

The existing command Hook limits remain one second for SessionEnd and ten
seconds for SessionStart. Optional clear observation/linkage shares an absolute
deadline of at most one second, capped by the remaining command budget. Project
validation precedes registry access; the exact OS query can overlap loading of
the existing readers. Helpers are hidden, awaited and closed on failure as well
as success. Startup rendering and prompt-reference delivery retain their own
existing behavior. Synthetic command-entry and process tests establish local
writer/hint/lookup/CAS/startup consumption only, not installed Claude event
delivery, an actual `/clear`, model reception or a performance guarantee.

References are prepared without consumption. The entire bounded reference fits
the actual context string or stays stored; partial inclusion is not implied.
Command Hooks consume only after the local stdout write callback succeeds;
`write(false)` is backpressure, not failure. OpenCode consumes only after its
still-current output slot accepts the text, and retains that text when rebuilding
the same output object. Private P5 nonce-owned serialization protects writes;
acknowledgement of an older generation preserves a changed store in full.
Failed cleanup or a crash after output can repeat a hint. None of these local
boundaries proves Host reception, model use or exactly-once delivery.

Direct Claude/Codex `Stop.last_assistant_message` can preserve bounded, redacted
visible final text without reading transcripts or tools. Codex `turn_id` must
match the captured prompt's own turn. Neither published Hook contract supplies
an explicit predecessor connecting Stop to the next prompt: adjacency is shown
as `unverified`, and approval is `not-inferred`. Host-delivered prompts may be
automatic continuations, scheduled work or messages; human origin is also
`unverified`. Missing/null fields supply no proposal, StopFailure error text is
excluded, and OpenCode assistant adjacency remains unsupported. This is recent
context with explicit uncertainty, not complete proposal/reply recovery.
Published field contracts: [Codex Stop](https://learn.chatgpt.com/docs/hooks#stop)
and [Claude Stop input](https://code.claude.com/docs/en/hooks#stop-input).

## Explicit tasks across recovery

Default work context keeps full `records[].content` and separate P4
`recordExcerpts`. Read the latter using their exact `source`, original field/index
and declared ranges. Related judgment/task fields retain their association, but
partial coverage can omit a condition. Zero full bodies with excerpts is partial
history, not no history or complete recovery. Use the supplied exact-read
expansion for missing dependent evidence; current P2 direction/cancellation and
the independent Todo view continue to govern ordinary work.

HEAD can record optional `todos` through the existing `lode_session_work_record`
or checkpoint's optional work evidence. Users describe work normally. HEAD
supplies stable `todoId`, task, recorded attribution, explicit status and a next
action for unresolved work. `partial`, `waiting`, `completed` and `cancelled`
are distinct; waiting/cancellation retain a reason. Progress and related exact
evidence belong to the P3 record, not inferred process activity. Updates cite an
exact same-Session `prior`; divergent branches stay conflicts. Explicit
`resolves` selectors can reconcile other branches without choosing by timestamp.
Retry reuses its original and never reopens a newer revision.

`workContext.todoContext` selects known unresolved tasks independently of recent
work's eight-record default. Entry/resume and bounded Host startup include it
under current P2 direction/cancellations. The existing replaceable graph index
contains task navigation hints; selected task originals are verified again.
Already verified originals from this request also supply task metadata, so an
unindexed publication can join immediately without a second scan or index repair.
Contradictory hints are disclosed and do not defeat a valid original.
Uninspected originals and missing/damaged indexes leave coverage unknown, never
proof of an empty list or completion. No read repairs the index, refreshes World
or blocks independent work. Expand with `lode_session_work_read` using `todo_id`,
`after_todo_id`, or bounded `scan_todos` original pages and `after_evidence_id`.
CLI `session-work-read --input` accepts their camelCase Core equivalents.
Omitted IDs, counts and continuation remain visible. These P4 views do not grant
effects or author P2, and records without `todos` keep their existing bytes/IDs.
