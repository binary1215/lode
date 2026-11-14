# Runtime composition

Read this when you delegate work, preserve a plan across stages, read native
Host activity, hand work to another conversation, or choose managed execution.
Lode is one provider-neutral core with replaceable Host, runtime and platform
boundaries.

## Choose execution means separately from risk

Direct Lode work is the default. Observe, Session, Run and Authority describe
risk and persistence, not a launcher. For useful ordinary delegation:

1. Use only tools the current Host exposes, with a brief, an independent
   ownership boundary and the sources and constraints each contribution needs.
   Preserve user input, account and cost scope; disclose a missing Host control.
2. Choose context per contribution:
   - a fix whose earlier exceptions and agreements are hard to summarize: a
     supported, in-scope fork, naming the current task so superseded discussion
     is not taken as direction;
   - an independent review: fresh context with the requirements, tests and
     constraints, not the parent's conclusion;
   - a long sequential verification that would crowd out the objective: a
     bounded delegation that returns acceptance findings, new facts, remaining
     uncertainty and evidence links;
   - a small error-message fix: direct work.
3. A shared writable checkout is not isolation: reconcile overlapping writes or
   work sequentially. A fork's history is context, not authority or isolation.
4. At completion, workers return changed, added, deleted and renamed code,
   affected references, decisions, original evidence, actual verification
   results (a test added is not a test passed) and unknowns.
5. Lode checks the combined checkout after reconciliation and performs or
   verifies any needed graph update for that integrated basis, reusing
   persistence-hook results; see
   [after integrated changes](project-discovery.md#after-integrated-changes).
   Workers run no uncoordinated global refresh. An update failure is a scoped
   evidence gap, not a new approval, worker authorization or barrier to
   independent work.

**On failure:** keep completed contributions and user edits. Continue the
unfinished part directly or sequentially only when it never started or left no
effects; inspect unknown outcomes and overlapping effects before replacing
anything, while independent work continues. A cancellation request does not
establish exit.

An active Run may use Host contributions under its own whole-result review
contract; Host handles stay operational and results do not become decisions or
direction.

Successful tests alone are not completion: when a result leaves a user
requirement unchecked (for example, a required output format), Lode assesses it
before claiming the goal is met, inspecting specific source evidence where a
summary leaves a question open.

## Preserved plan sources and next stages

For substantial work, record the goal, agreed conditions, reasons, alternatives
and completion meaning before detailed production or inspection. An accepted review
is not by itself a preserved judgment context; reuse an actually preserved
planning source or say that the plan is reconstructed from current direction and
records.

1. **Preserve the source**, with the current scope and Host tools:
   - keep the completed plan conversation idle, and have an authorized
     coordinating context obtain contributions from it; or
   - obtain a separate preservation fork; once its ready identity and plan basis
     are observed, the original may progress, and the preserved source stays
     idle (no work, receipts or probes).
2. **Check readiness on the actual Host surface.** Confirm that the source turn
   actually completed (its reported turn or activity) and that the child has a
   usable identity and plan basis; worktree setup needs its actual ready result,
   not an invented mapping. A visible plan message is not a completed turn, and
   pending client IDs are not ready thread IDs. Read before
   fork is not an atomic freeze; limit preservation claims to the inheritance
   actually observed. A ready child may already be running, so inspect unknown
   effects before sending more work. An uncertain fork is inspected, not repeated
   automatically.
3. **Split roles.** Implementation gets owned files or effects; independent
   inspection gets the same criteria and the exact candidate, not the
   implementation conversation; integration receives findings, counterexamples,
   exact results and uncertainty, and may inspect specific originals. A sibling
   fork shares the plan's assumptions, so its review checks the goal and
   plausible counterexamples, not only conformance to the plan.
4. **At each meaningful stage**, integrate completed results, new facts, changed
   assumptions, reasons, remaining dependencies and next actions, and evolve the
   next plan from them under the whole goal. Detailed review history is not
   promoted into the next plan automatically. A changed candidate needs review of
   its affected claims; an unchanged clarification can reuse the existing
   inspection. Preserve a newly accepted plan source once its turn completes.

When Host history is insufficient, a bounded check in an actual work child can
show what context is available; echoing the expected answer back is not
evidence. Always supply current cancellation, role and effect authority
separately. If the source already advanced and the Host has no historical
cutoff, use fresh work or records and call it reconstruction. A missing
capability limits that claim, not independent direct work, and a refusal is not
bypassed through another tool. Ordinary work needs no new Session, Run, Capsule,
plan file, save or fixed number of chats.

## Native observations and current Host activity

Packaged Codex and Claude lifecycle Hooks keep small optional Host-local
observations; `head_project_status` may include `nativeContext`, whose caller
can differ from the requested Session. Read them as at-check facts:

- receipt order is not causality or a complete census;
- `Stop`/`SubagentStop` means a response end, not success; a caller-level
  `SessionEnd` does not finish its tasks;
- Claude's exact PID/birth check means only hosting-process presence, not child
  activity.

**Codex related records.** For supported exact Codex metadata, entry can include
related source bodies from the logical mapping captured when a direct edge was
observed; `selectionBasis` and `recordRead` tell observation and later read
apart. They are later reference reads, not fork-cutoff history or parent
direction, and current child and common constraints win. Absent mapping stays
absent.

**Prepared input.** For an exact managed authorization,
`lode_runtime` (`invocation_authorization`), `lode_bounded_worker` (`status`) or
CLI `runtime-invocation-read --authorization <id>` can add a historical
`preparedInput` view that verifies retained originals and compares the serialized
input's size and digest. It is a read-only historical view, not current
permission or recovery direction: preparation does not prove
delivery or model use, missing originals and integrity failures stay distinct,
and later cancellations stay in force. An optional view failure keeps the
primary authorization read. Details:
[runtime adapters](../../../docs/runtime-adapters.md).

**Codex live state.** Where the app exposes `wait_threads`, and you have an actual
ready `threadId` (from an authorized launch, fork or known target, or the trusted
`nativeContext.hostTarget.threadId`), a material current-state question can be
answered as follows:

1. Call `wait_threads` once with `timeoutMs: 0` for that target. Pass `hostId`
   only if it was genuinely supplied, never inferred from a local path; no prior
   status call is needed. `clientThreadId`, collaboration IDs and managed
   handles are not app thread IDs without an actual mapping.
2. Use the returned target and current turn. `timedOut: true` can accompany a
   valid active poll and is not a target failure. `afterCursor` tracks new
   information, not an execution identity, and an older completed result does
   not close a newer turn or logical Lode work.
3. If the snapshot answers the question, stop. Use a narrow `read_thread` only
   for a material missing result or failure detail.

There is no automatic status/wait/read chain, self-poll, list-all or socket/CLI
fallback, and Core neither calls peer MCP tools nor persists these snapshots.

**OpenCode.** The optional V1 entry uses the supplied Host client and the local
Lode MCP alias. Busy, retry and idle are at-check; an absent status entry means
no non-idle entry, not ended. Unavailable observations leave ordinary work and
recovery usable.

## Follow-up handoffs

1. Lead with what changed, what is already usable and the remaining question,
   with relevant constraints, ownership changes and evidence references.
2. Reuse context the recipient already has. When the recipient is new, has lost
   context or holds an outdated basis, supply the missing requirements and
   reasoning: delta-first is not delta-only.
3. After context loss, recover from artifacts first where that contract applies
   ([recovery presentation](conversation-ux.md#recovery-presentation)); the
   handoff is supporting context.

A brief needs no acknowledgement handshake, token or new artifact, grants no
authority, replaces no recovery record, and is not a way to edit digest-bound
managed input.

## Continuing in an existing conversation

Reuse sufficient current context before searching again. For related work,
inspect its exact records and responsibility: a shared title, file or topic is a
hint, not ownership. Logical Session, work root and native conversation are
different things; the caller's native Host target is not a global
Session-to-chat directory, and activity is never ownership or completion. See
[record discovery](project-discovery.md#existing-work-and-recorded-conclusions).

**Messaging another conversation** needs a real Host target and direct human
authorization for that action; an agent message or historical approval does not
grant it.

1. List same-Project live conversations, read-only, with `head_conversation_list`.
   The Host lifecycle registers endpoints; listing never initializes or repairs
   one, and a registration is local evidence, not Canon or recovery direction.
2. Send with `head_conversation_send` only under that authorization, conveying
   the current request, changed scope, decisions, evidence, constraints,
   expected outcome and known gaps. Current corrections and cancellations
   override older suggestions.
3. On `unknown`, the handoff may already have happened: do not retry or inject
   it again automatically.

Tested boundaries: [conversation messaging](../../../docs/conversation-messaging.md).

## Explicit managed execution

Choose this path when durable ownership, interruption recovery, unknown effects
or duplicate-integration prevention need the managed contracts. File editing,
worker count, duration and ordinary Host failure do not force it.

1. **Entry.** CLI: `node <plugin-root>/scripts/head.mjs managed <command> ...`.
   MCP: discover the managed tool's schema and `executionMode` (known tools can
   skip discovery), then call `head_tools_call` with `execution_mode: "managed"`.
   Lode chooses this internally; there is no user unlock. The original
   authorization, lease, lineage and effect checks still run. The
   `managed-maintenance` CLI and stdio server remain compatible entries; reads,
   status, wait and exact owned cancellation stay ordinary diagnostics. Leave the
   user's installed server configuration as it is.
2. **One managed Session result.** Use the idle Session's exact
   ExecutionAuthorization and `lode_bounded_worker` (`dispatch`); `worker-execute`
   receives the authorized sessionRequest. `worker-apply` and waves are Run-only;
   a wave groups independent authorizations, not a shared permission.
3. **Managed Codex patch proposal.** Lode derives the task, exact model, selected
   context, source paths and proposal targets, calls `lode_bounded_worker`
   (`prepare`), then (`start`) with the returned task key. Preparation makes no
   model turn and does not prove account or model readiness. The user supplies
   no modules, JSON, IDs or routine approval. `selected-only` never silently
   inherits global instructions (preparation reports
   `unavailable_for_selected_scope` instead, with no automatic switch or retry);
   select `host-global` only within the approved input scope.
4. **Context mode.** Preparation defaults to fresh (one turn). `context_mode:
   "native-prefix"` seeds a new durable controlled conversation from the selected
   context and forks a child (two turns); it does not inherit this
   conversation. Use it only within the existing call, input and persistence
   scope, inspect `executionPlan`, and claim no stronger native guarantees or
   cache savings.

**On failure:** a missing managed backend affects that operation only. Unknown
effects, receipt and basis checks, user-edit protection and owned cleanup still
apply. When integration or wave status returns `guidance`, Lode handles the
scoped inspection, reassessment or cleanup itself, without a user form,
approval step, automatic retry or new direction.

The adapter architecture (AgentRuntimeAdapter, PlatformAdapter,
WorkspaceHostAdapter) and its deferred capabilities are described in
[runtime adapters](../../../docs/runtime-adapters.md) and
[architecture](../../../docs/architecture.md).
