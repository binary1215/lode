---
name: lode-agent-core
description: Initialize, recover, or operate a provider-neutral Lode Project with common user direction and independently routed logical Sessions, graph-first discovery, direct work, optional bounded delegation, and durable recovery. Use for Lode Agent Core, context recovery, compaction, selected context handoff, multi-step Runs, or worker coordination.
---

# Lode Agent Core

## Entry procedure

Read the state you were given (Hook `additionalContext` or the result of
`lode_conversation_enter`) and follow its row. Branch on `status` and
`reasonCode` values, never on message text.

| Incoming state | Call | Use of the result |
| --- | --- | --- |
| `conversation_ready` | none | Work from `workContext` records and `workContext.todoContext` directly. |
| `conversation_direction_restored` (and its `_without_transport_continuation` / `_after_uncertain_continuation` variants) | none | Compare `currentProjectDirection` goal, constraints and cancellations with the current request; the current request wins. |
| `session_selection_unresolved` | `sessionDiscovery.call` as returned (= `lode_session_list`, in the default list) | Show candidates and leave the choice to the user; independent work continues. |
| `conversation_recovery_unavailable` or Hook `host_context_unavailable` + `reasonCode: NOT_INITIALIZED` | `lode_project_initialize_or_resume {project_root, profile: "core"}` only when the user wants Lode here | Never create root instruction files without `write_root_instruction_files`. |
| same + `PROJECT_RELOCATION_AVAILABLE` / `PROJECT_RELOCATION_PENDING` | `nextAction.entrypoint` as returned (resume, `profile: "core"`) | Never initialize a new Project over a moved one. |
| same + `PROJECT_NOT_READY` | `lode_project_status {project_root}` | Report the drift it names; ordinary work is not blocked (`ordinaryWorkBlocked: false`). |
| `CONVERSATION_ENTRY_BASIS_CHANGED` attention | `lode_conversation_enter` once more | Only dependent context needs the reread. |
| MCP error with `error.data.reasonCode` | `INVALID_TOOL_ARGUMENTS` → fix the arguments; `PROJECT_NOT_READY` → `lode_project_status`; `NO_PENDING_REVIEW` → normal, nothing awaits review | Do not match message strings. |
| Tool not in the default list | `lode_tools_read {name, arguments}` (read-only) / `lode_tools_call {name, arguments}` (effects) | The router checks read-only status first; `lode_tools_discover {name \| prefix}` returns exact schemas. |

Entry rules that apply to every row:

- Reuse sufficient verified entry context already supplied for this exact Project
  and selected Session; call `lode_conversation_enter` (read-only) once only when
  needed context is missing. Do not repeat init/status/list/graph to confirm it.
- `lode_project_initialize_or_resume` is for first adoption, explicit Session
  selection/resume or managed-installation convergence. A Skill match or new turn
  is not a setup trigger. Do not initialize an unrelated repository.
- No checkpoint means ordinary work continues. Selection loss pauses only
  dependent work. Do not enumerate Sessions on every turn or guess owners from titles.
- `lode_project_direction_read` returning `null` means no common direction is
  recorded; it is not approved emptiness.
- Startup lookup is read-only. Use a verified Host selection or an exact explicit
  route (`session_id` on typed calls, `--session` on CLI); never guess identities
  and never ask for bind/save/ID rituals. Host limits are in the
  [work context and Host limits](../../docs/session-work-context.md) reference.
- Continue the original task in the same turn; no repeat request, profile choice,
  user JSON or recovery ritual.

## Install and adopt

For an authorized installation/update request, perform the selected client's
available official procedure and verify its result; see
[installation and adoption](references/project-discovery.md#installation-and-adoption).
Users without the plugin start at [Install](../../README.md#install), without an
installed-Skill prerequisite. Preserve valid installations and runtime/link choices.
Installed files do not prove Host loading; unavailable loading never blocks
independent authorized work. Retained storage formats:
[recovery](references/recovery-workflow.md#retained-project-storage).

- Default `profile: "core"`. Use `profile: "product"` and the sibling
  `lode-agent-onboarding` Skill only for an actual Product/World outcome.
- Initialization preserves root instructions. Reuse an already-given choice with
  `instruction_integration: "link"` (CLI `--instruction-integration link`);
  `preserve` makes no edits. Do not re-offer a declined connection.
- Pick `--runtime claude|codex|opencode` for the selected client only.

## Work from context

- `workContext.records[].content` is original; `recordExcerpts` name exact owner,
  field and range. Read missing originals with `lode_session_work_read` only when
  the next action needs them. Excerpts alone are neither empty history nor recovery.
- Todos: write optional work-evidence `todos` (stable ID, task, next action,
  explicit status, exact prior revision on update) at meaningful changes only.
  Partial and waiting remain open; elapsed time never completes a task.
  Current user direction/cancellations and P2 take precedence over every Todo.
- Common direction: read `lode_project_direction_read`; publish user direction
  with `lode_project_direction_update` and its exact basis (`expected_direction_id`).
- `lode_session_list` previews Sessions read-only; inspect partial/error coverage
  before concluding there is no unfinished work. See
  [existing work](references/project-discovery.md#existing-work-and-recorded-conclusions).
- Prompt/final-response references and native observations are quoted context, not
  approval; see [runtime composition](references/runtime-composition.md#native-observations-and-current-host-activity).

## Find context through the graph

- New project information: `lode_project_graph {project_root, query}` with
  only useful anchors/filters, or reuse same-basis results. Widen from nearby
  relations; no whole-graph prompt injection or per-turn rescans.
- Code impact: `lode_world_query` (CLI `world-query`) for bounded `IMPORTS`/`CALLS`
  neighbors. With absent or stale World evidence, read current source imports directly.
- Read basis, freshness, coverage and provenance together. Empty or partial
  coverage does not prove absence; fall back to original sources on failure.
  World currentness, Product approval, Run, Capsule and ArcadeDB are not
  exploration gates. Recheck affected sources before changes.
- Visual graph on request:
  `node <plugin-root>/scripts/lode.mjs graph-explorer "<target-project-root>"`
  (always the user's Project root; `--share` omits generated metadata only). See
  [Graph Explorer](../../docs/graph-explorer.md) and [project discovery](references/project-discovery.md).

## Agree the work, not the paperwork

- Reuse still-valid user agreement. Agree only unresolved material behavior,
  scope, conditions or user-owned architecture; re-agree only the delta.
- Small exact fixes proceed directly; analysis/proposal-only stays read-only.
  Only choice-dependent implementation waits.
- Summaries, reviewer assent and model inference create no user authority. A short
  reply must clearly answer a concrete proposal.

## Choose execution and preserve judgment

Work directly for small tasks. Delegate an independently reviewable outcome with
outcome, allowed context, file ownership and completion evidence; reconcile
overlapping writes. Ordinary Host delegation is enough unless durable ownership,
interruption recovery or uncertain effects need tracking: then use
`lode_tools_call` with `execution_mode: "managed"`. Fork/fresh context grants no
approval or isolation. Continuing in another chat needs a verified target and
messaging authority; see
[existing conversations](references/runtime-composition.md#continuing-in-an-existing-conversation),
[follow-up handoffs](references/runtime-composition.md#follow-up-handoffs) and
[runtime composition](references/runtime-composition.md).

- After a stage, integrate actual results, changed assumptions and remaining work
  before planning the next one; preserve completed contributions.
- A cancel request does not prove exit. Never replay uncertain external effects.
  Wave or Run success is operational evidence, not approval or P2 direction.

## Finish and preserve

- After meaningful code changes, check whether the graph needs an update; reuse
  hook updates, run the existing index/World refresh when needed and report what
  stays unverified. Test presence is not an executed PASS. See
  [after integrated changes](references/project-discovery.md#after-integrated-changes).
- Preserve otherwise-unrepresented reasons, alternatives and unknowns only at a
  meaningful handoff: `work_evidence` on `lode_checkpoint_sync`, or
  `lode_session_work_record` for Run-free work. Optional `workLink`,
  `executionObservation` and `workTopics` reuse returned exact selectors.
  No per-turn save, save approval or user JSON.
- Work documents: `lode_work_document_prepare/publish/status`; Project documents:
  `lode_project_document_prepare/publish/status`. Retry a verified rejected write
  only through `retry_rejected_writes` with the returned attempt reference; unknown
  outcomes allow readback only. See [work documents](../../docs/work-document-projection.md).
- Saving is not execution permission: after a save, effects still need current
  user authority. A permission denial is not capability absence; do not switch
  tools or write files directly to get the refused effect.
- Lead with the outcome and uncertainty; use the
  [Lode conversation](../lode-conversation/SKILL.md) Skill when explaining.

Why these rules hold (authority planes, evidence vs. permission, P1–P5):
[constitution](../../docs/lode-constitution.md) and
[authority planes](../../docs/authority-plane-contract.md). Detail is optional,
not a prerequisite reference/tool chain: [context workflow](references/context-workflow.md),
[compiler](references/context-compiler.md), [recovery workflow](references/recovery-workflow.md),
[Session recovery](../../docs/session-recovery.md),
[authority and roles](references/authority-and-roles.md),
[conversation UX](references/conversation-ux.md).

## CLI

The CLI is `node <plugin-root>/scripts/lode.mjs <command>`; when the installer
(`scripts/install.sh` / `scripts/install.ps1`) created the launcher, `lode-agent <command>`
is the same program. Marketplace installs have no launcher.

```text
node <plugin-root>/scripts/lode.mjs init <project> --runtime codex
node <plugin-root>/scripts/lode.mjs resume <project> --session <logical-session>
node <plugin-root>/scripts/lode.mjs graph-query <project> --query "<task>"
node <plugin-root>/scripts/lode.mjs session-list <project>
node <plugin-root>/scripts/lode.mjs managed <command> <project> <arguments>
node <plugin-root>/scripts/lode.mjs help-all
```
