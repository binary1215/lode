---
name: lode-agent-core
description: Initialize, recover, or operate a provider-neutral Lode Project with common user direction and independently routed logical Sessions, graph-first discovery, direct work, optional bounded delegation, and durable recovery. Use for Lode Agent Core, context recovery, compaction, selected context handoff, multi-step Runs, or worker coordination.
---

# Lode Agent Core

Lode keeps the user's objective, constraints and acceptance criteria connected
to execution and completion. Continuity belongs to canonical project records,
rather than a model, provider conversation, host, database or transcript.
Understand the request, find needed context, work directly or delegate useful
outcomes, integrate results, and preserve important changes.

## Constitution

1. Keep one canonical Project with common user direction and independently
   routed logical Lode Sessions. Each owns its purpose, progress and recovery.
2. Apply current common constraints across Sessions. Restoring an earlier
   Session cannot undo a later common deployment cancellation.
3. Find new project information through bounded graph discovery first, or reuse
   sufficient same-basis results. Continue from original records when needed.
4. Treat results, observations, messages and external reviews as evidence.
   Historical approval does not grant current effect authorization.
5. Keep graphs, indexes, Markdown and continuity views replaceable. Important
   decisions and recovery direction remain in their original records.
6. Change Product Canon through the explicit user ReviewDecision for its exact
   current candidate. Ordinary authorized fixes need no extra review ceremony.
7. Keep provider capability behind adapters with the same authority semantics.
   Fork, availability and operational success create no authority.

P1-P5 is internal enforcement, not a user form. Before changing authority or
recovery, read [the constitution](../../docs/lode-constitution.md) and
[authority planes](../../docs/authority-plane-contract.md).

## Enter and keep working

For an authorized installation/update request, perform the selected client's
available official procedure and verify its result; see
[installation and adoption](references/project-discovery.md#installation-and-adoption).
Users without the plugin start at [Install](../../README.md#install), without an
installed-Skill prerequisite. Preserve valid installations and runtime/link choices.
Installed files do not prove Host loading; unavailable loading never blocks
independent authorized work. This is not another setup or approval checklist.
For retained storage formats see [recovery](references/recovery-workflow.md#retained-project-storage).

For first Lode adoption or missing Project initialization, an explicit Session
selection/resume, or required managed-installation convergence, use
`lode_project_initialize_or_resume` with the exact root and default
`profile: "core"`. Otherwise reuse sufficient verified current entry context
already supplied for that exact Project and selected logical Session. If needed
current context is missing, obtain it once through read-only
`lode_conversation_enter`. A Skill match, existing Project or new turn alone is
not another setup or binding trigger. Continue the original task in the same
turn; do not ask for a repeat request, profile choice, JSON or recovery ritual.

Core preserves identities and indexes eligible existing observations where
available, without inferring Product meaning. Use `profile: "product"` and the
sibling onboarding Skill for an actual Product/World governance outcome.
Do not initialize an unrelated repository merely because a coding request
matched this Skill.

Entry includes current direction, useful work context, recovery, status and
Attention. Read and reuse sufficient supplied content quietly, including after
compaction/provider replacement, unless its relevant basis changes or needed
content is missing. Matching identity, digest or time alone does not prove current
intent. Expand only the missing dependent originals; do not repeat
init/status/list/graph merely to confirm complete unchanged material. Ordinary
entry leaves detailed World inspection explicitly unchecked, not current, stale
or absent; use full status/doctor diagnostics when needed, not as a follow-up
ritual. No checkpoint means ordinary work continues. Automatically obtain missing
selected Session direction with current common constraints; never invent it from
a transcript. Missing direction is not approved emptiness.
Selection loss pauses only dependent work; reuse verified same-Project candidates
already supplied, or follow the returned `sessionDiscovery.call` only when that
missing context matters. This existing read-only list previews evidence without
selecting a Session. Do not enumerate Sessions on startup/failure/every turn or
guess ownership from titles/recency. Continue independent work; partial entry is
not recovery success. No repeated question, automatic selection or user ID form.

Use supplied `workContext` bodies and `recordExcerpts` to connect recorded reasons,
alternatives and remaining work to the current request and cancellations. Full
`records[].content` stays original; an excerpt identifies its exact owner, field,
index and partial range. Keep a judgment or task's related fields together and
notice omitted conditions before relying on it. Excerpts alone are neither an
empty history nor complete recovery. Default order is not semantic importance.
Use `lode_session_work_read` for missing originals only when the next action needs
them; reuse sufficient supplied evidence without another read or save ritual.
Historical suggestions, saved completion and approvals are not current effect
permission. Do the useful bounded work and verify its actual result.

For multi-step work that must survive interruption, use the existing optional
work-evidence `todos` at meaningful task/status/priority changes. Supply stable
IDs, task, next action, explicit status, attribution and actual progress/exact
references; cite an exact prior revision on update. Do not ask the user for JSON,
save approval or a Todo ritual, and do not create a record each turn. Read
`workContext.todoContext` independently of recent notes on entry/resume. Partial
and waiting remain open; ended/idle/elapsed time never completes a task.
Conflicting branches require explicit reconciliation, not a clock winner.
Missing index coverage is unknown; expand only useful exact items or bounded
original pages through `lode_session_work_read`, without a Run or World refresh.
Current user direction/cancellations and P2 take precedence over every Todo.

Optional Host prompt/final-response references are quoted P5 context only.
Human origin and next-turn adjacency may be unverified; do not turn a short
reply beside a historical proposal into approval. Use current explicit direction
and exact original context; missing proposal fields are not permission to crawl
transcripts. Keep the provider's normal compaction summary enabled.

Returned links can connect recent work to the cited judgment or declared root.
A saved close qualifies its exact earlier note, not a resumed sibling, another
Session, pending review or remaining unknowns. Keep those owners and scopes
separate; do not add start/end saves, IDs or questions to make the links usable.

Optional native observations describe the caller, not logical Session execution.
Related ancestry context contains verified historical P3, never inherited P2
direction. Use current Host activity only when it answers a material uncertainty;
see [runtime composition](references/runtime-composition.md#native-observations-and-current-host-activity).
Missing observations never require a bind/save, ID question or extra lookup chain.

Use optional `session_id` on typed calls or `--session` on CLI for request-local
routing. On `lode_session_list` these identify a read-only preview, preserving
native, shared caller and outer request selections. Page only when useful; inspect
partial/error coverage and existing Todo rather than inferring no unfinished work.
See [existing work](references/project-discovery.md#existing-work-and-recorded-conclusions).
Logical Session identities are not provider conversations or assigned owners.
Read shared goal/constraints/decisions/cancelled actions through
`lode_project_direction_read`; publish current user direction through
`lode_project_direction_update` with its exact basis. Reconcile competing
updates rather than last-writer overwrite. A Session's local investigation
change does not automatically change another Session's goal.

## Find context through the graph

For new project information, call `lode_project_graph` with task/query and only
useful anchors/filters, or reuse sufficient same-basis results. Read nearby
relations first and widen when needed. Avoid whole-graph prompt injection and
per-turn full rescans. Lode interprets relevance; lexical overlap is a hint.

Natural questions search bounded display/domain evidence, not metadata keys.
Exact names, paths or anchors help narrow a partial result; Lode supplies them
without asking the user to rewrite the task. Common direction excerpts include
constraints, decisions and cancellations with current/historical revision labels.
Read the original direction when the excerpt is partial or before relying on it
for a current effect; its graph copy grants no permission.

For code impact, use existing `lode_world_query` / CLI `world-query` for bounded
`IMPORTS`/`CALLS` neighbors, not general `CONTAINS`/`HAS_REVISION`/`DECLARES`
expansion. With absent or stale World evidence, inspect affected current source
imports/calls directly. Do not require a whole World refresh, new Run or approval
just to investigate; retained links are hints to verify, not current impact proof.

Read basis/revision, integrity, freshness, coverage, original state and provenance
together. Work and Product are linked logical views of common original records.
Different revisions of the same path remain distinct. Intact historical evidence
stays readable and labelled, including unapproved/rejected state through relation
expansion. Reference or sequence does not prove cause.

Empty/partial coverage does not prove absence. Use disclosed original-source
fallback on absence or failure. Reuse known same-basis adapter failures without
repeated requests; retry when that basis changes. Exclude the damaged or
cross-Project layer while using remaining valid evidence. Full World currentness,
Product approval, Run, Capsule, indexing completion and ArcadeDB connectivity
are not general exploration gates. Before changes, recheck affected current
sources and effect authority.
Read [project discovery](references/project-discovery.md) for implementation.

For an explicitly requested visual graph, use the existing CLI:
`node <plugin-root>/scripts/lode.mjs graph-explorer "<target-project-root>"`.
Resolve the executable from this installation, but always pass the user's target
Project root explicitly, even when the working directory is the plugin folder.
The graph describes that Project, not Lode itself. Missing Project/World/source
evidence stays unavailable; never substitute the plugin repository or a demo.
Return the new offline HTML path. No new MCP tool, database setup or Session
binding is needed. For sharing use `--share` only as generated-metadata omission,
not anonymization of originals. To follow one Feature, select its exact model-bound
record and use Structure / Recorded work / Changes & related impact. Keep source
citation, implementation mapping, historical rationale and exact before/after
comparison distinct; shared files and whole-model citations do not prove cause
or fulfillment. Missing detail uses existing exact reader / focused regeneration,
never an inferred pair or a new setup gate. See [Graph Explorer](../../docs/graph-explorer.md).

## Agree the work, not the paperwork

Reuse concrete user agreement that remains valid for the current request,
constraints and cancellations. Agree unresolved material user-visible behavior,
scope, conditions and important user-owned architecture choices. Re-agree only
the material delta, impact and options, not routine internal choices. Small exact
fixes proceed directly; analysis/proposal-only stays read-only. Preparation stays
within current authority; reversibility grants none. Only choice-dependent
implementation waits while approved independent work continues.

For nontrivial implementation, clarify purpose, agreed behavior, scope,
acceptance, component responsibilities/connections and important uncertainty in
useful existing work context. No fixed questions, new plan file, save-success
gate or prerequisite reference/tool chain is required. Lode owns routine internal
design, verification and error handling. Verify the agreed behavior and report
meaningful deviations and unknowns without mandatory report sections.

Summaries, reviewer assent and model inference create no user authority. A short
reply must clearly answer a concrete proposal and scope. Reconcile recovered
agreements with current requests and cancellations; ordinary agreement reuse
cannot replace the current user decision for a new or changed protected target.

## Choose execution and preserve judgment

Work directly for small tasks. Delegate independently reviewable outcomes when
parallel work helps or long sequential execution/review could crowd out the
context needed to judge the whole objective. Brief each worker with outcome,
allowed context, file ownership, constraints and useful completion evidence.
Reconcile overlapping writes and preserve other workers' and user changes.
For continuing work, use related evidence and actual responsibility, then verify
an available Host target and current messaging authority. A matching title/path
or recent activity does not assign ownership. With no target or permission,
continue authorized work here; see [existing conversations](references/runtime-composition.md#continuing-in-an-existing-conversation).

Use ordinary Host delegation when sufficient. Use managed execution when durable
ownership, interruption recovery, uncertain effects or duplicate integration
prevention need tracking. File edits, worker count and ordinary failure alone
do not force managed execution. A new managed wave may serve a useful durable
outcome; existing managed work and unknown effects retain their contracts.
Read [runtime composition](references/runtime-composition.md) for exact entries.

Fork/fresh is a separate context choice: supported in-scope fork can preserve
prior design reasons; selected fresh context can support narrow work or independent
review. Neither grants approval, Canon/P2 authority, file isolation, cache reuse
or lower cost. Preserve semantically sufficient context.

Lode checks objective achievement, new facts, uncertainty and supporting evidence.
Keep completed contributions and continue independent unfinished work. Before
replacing unknown work, inspect its exact effects. A cancel request does not
prove exit. Wait for/cancel owned work and verify cleanup. Do not replay uncertain
external effects blindly. For durable Runs, retain accepted lineage, ResultPacket,
Fresh Lode review, explicit ReviewDecision and checkpoint integration.
Wave success is operational evidence, not approval or P2 direction.

## Finish changes with usable graph evidence

After a meaningful code-change or feature-addition work segment, Lode checks
whether the integrated result needs a graph update. Connect affected code and
the purpose, decisions and verification needed by later work to their originals;
reuse updates already made by persistence hooks. Use the existing index or World
refresh when needed, then check supported affected relations and disclose what
remains unverified or unprojected. Test presence is not an executed PASS.
Workers return changes, evidence and unknowns; Lode owns the integrated update.
Do not require every worker or turn to refresh globally, activate World/DB,
create a Run/Capsule, install a watcher or ask for routine approval. On update
failure, retain the affected gap and continue source fallback and independent work.
Read [project discovery](references/project-discovery.md#after-integrated-changes)
for the distinct existing update paths and their limits.

## Preserve useful work

Lead with the outcome and actual uncertainty. Successful entry, reuse and sync
are quiet; meaningful exceptions retain their affected operation, owner and
next action. Bind protected decisions to the unique unchanged current target.
Technical IDs and schemas are diagnostic detail, not user prerequisites.

Reuse existing checkpoint/result/review/source originals. Preserve only useful,
otherwise-unrepresented reasons, alternatives, observations and uncertainty at a
meaningful handoff: optional `work_evidence` with an already useful checkpoint
sync, or `lode_session_work_record` for Run-free work. No per-turn record,
transcript copy, save approval, user JSON, compulsory budget tier or Run/Capsule.
Session-local purpose/constraints/cancellation stay in explicit P2 direction;
P3 evidence cannot supply them or change shared ProjectDirection.

A management-record failure limits only dependent management work. Host/tool
permission or approval denial is not capability absence: do not obtain the refused
effect by switching tools, using CLI/direct file writes or changing policy.
Report what was not preserved and its recovery limits; continue independently
authorized work and permitted source fallback for unavailable capabilities.
Preserve primary identity/digest/permission/partial-write failures and required
ReviewDecision. Saving grants no execution permission; repair missing persistence
only within current authority, never replay completed or uncertain effects.

At those same useful preservation boundaries, reuse returned exact evidence
selectors for optional `workLink` root/predecessor and exact-target historical
`executionObservation`. Use existing artifact references for an earlier judgment
whose actual reasons matter. Default entry can include that cited body and the
declared anchor alongside recent results/pending work. Coexisting saved states
are not live execution or an inferred conflict. Unsaved conversation can still
be lost on abrupt exit.

At meaningful completion, handoff or changed conditions, connect the whole user
outcome to actual consumer results, reasons and remaining work; reuse originals
instead of saving each turn. Optional `workTopics` labels help find that work
without Product onboarding or a user taxonomy. Session/root groups organize
returned bodies only: identical labels do not merge work, create a Feature or
prove completion. Native automatic end, ancestry and live activity are not
implemented by these saved observations.

Native init/resume can retain verified selection; startup only reads that linkage.
Its loss does not erase Core success or permit replay. Other reads, work recording
and checkpoint sync do not select the chat.
Use a verified explicit route on unsupported Hosts, without bind/save questions
or identity guesses. Host-only helpers are not model tools or permission bypasses.
For relevant routing, bounds or recovery details see
[work context and Host limits](../../docs/session-work-context.md); this is not a
required extra read before ordinary work.

## Progressive references and tools

Load only what the current outcome needs:

- Graph discovery, logical Sessions and common direction:
  [project discovery](references/project-discovery.md).
- Reproducible Context: [context workflow](references/context-workflow.md) and
  [compiler](references/context-compiler.md).
- Checkpoint sync and compaction: [recovery workflow](references/recovery-workflow.md)
  and [Session recovery](../../docs/session-recovery.md).
- Delegation and fork/fresh: [runtime composition](references/runtime-composition.md)
  and [follow-up handoffs](references/runtime-composition.md#follow-up-handoffs).
- Roles and authority: [authority and roles](references/authority-and-roles.md).
- Decisions, waiting, results and optional Product evidence:
  [conversation UX](references/conversation-ux.md).
- When useful for explaining Lode work to the user:
  [Lode conversation](../lode-conversation/SKILL.md), an optional communication aid.
- Product governance: sibling `lode-agent-onboarding`, then its subsystem docs.

Default MCP includes graph discovery and ordinary Core entry/recovery. Use an
already-provided typed tool directly for normal first use. For optional tools,
use `lode_tools_discover` by name/prefix and its compatible `invokeWith` router
with `{name, arguments}` and the unchanged inner schema. A known optional contract
can use its existing router without prior discovery. Lode supplies arguments
without user unlock/forms. For useful managed execution,
`lode_tools_call` accepts `execution_mode: "managed"`; routing preserves original
authority/lease/effect checks. Read/status/wait and exact owned cancellation remain
ordinary diagnostics.

```text
node <plugin-root>/scripts/lode.mjs init <project> --runtime codex
node <plugin-root>/scripts/lode.mjs resume <project> --session <logical-session>
node <plugin-root>/scripts/lode.mjs graph-query <project> --query "<task>"
node <plugin-root>/scripts/lode.mjs session-list <project>
node <plugin-root>/scripts/lode.mjs managed <command> <project> <arguments>
node <plugin-root>/scripts/lode.mjs help-all
```

Initialization preserves existing root instructions by default. During an
explicit setup/connect request, reuse the user's already-given choice through
the existing init/resume `instruction_integration: "link"` option (CLI
`--instruction-integration link`); `preserve` makes no instruction edits. Do not
ask again, repeatedly offer a declined connection or make setup a prerequisite
for an ordinary task. Linking appends one bounded block using the verified
actual `.head/` or `.lode/` sources. Claude uses native `@` imports; Codex receives
an explicit instruction to read those files, not an assumed `@` import. Synthetic
link verification does not establish that an actual Host consumed the files.
Use `claude` or `opencode` instead of the example's `codex` for that selected
client; combine runtimes only when the user wants those integrations.
