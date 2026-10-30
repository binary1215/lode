---
name: head-agent-onboarding
description: Explicitly activate or resume optional Lode Product, World, Graph, or governed-document onboarding inside Claude Code, Codex, or OpenCode, including bounded source/storage choices and evidence-linked semantic proposals and review. Do not use for general Lode setup; use the general head-agent-core skill for Core-first initialization, ordinary work, Context preparation, recovery, and execution-lineage work.
---

# Lode Agent conversational onboarding

This skill is the explicit Product/World governance path, not the generic setup
path. Graph-first discovery of existing observations is available through the Core
Skill without activating Product governance or constructing a full World. If
"onboard" merely means installing Lode or starting ordinary work,
stop here and use the general `head-agent-core` [Core Skill](../head-agent-core/SKILL.md)
with `profile: "core"`.
Enter this skill only when the user asks for reviewed Product meaning, World or
Graph construction, governed document projections, or equivalent protected
outcomes. Never infer activation from tool availability or a Context request.

Operate onboarding through the plugin's typed MCP tools. The conversation
explains state and collects user choices; Core validates and performs every
transaction. Do not ask the user to discover or manually run repository scripts
for the normal path.

On the small default MCP surface, find an optional tool with `head_tools_discover`
using its exact name or returned prefix. Invoke its unchanged schema through the
returned `head_tools_read`/`head_tools_call` route. This is discovery, not a new
user choice, activation, approval or requirement to author JSON. Existing direct
tool calls remain available to hosts that expose them.

## Start or resume

1. Confirm the request is for the optional Product/World governance path, then
   call `head_onboarding_guide` for the exact project root.
2. If status is `not_initialized`, infer only safe defaults:
   - existing project when repository evidence already exists;
   - local storage unless the user explicitly selects GraphDB;
   - Claude Code, Codex, and OpenCode runtimes when all three are desired.
3. Ask only for material missing choices. A mixed or copied repository needs a
   user-selected project-relative source scope. The whole eligible repository is
   represented by empty `include_roots`; never use `"."` as a root alias. A new
   project needs a structured brief. GraphDB selection needs endpoint, database,
   and environment variable reference names—never credential values.
4. Call `head_project_initialize_or_resume` with `profile: "product"`. Re-entry must resume the same Lode
   Project and default/selected logical Session rather than inventing identities.
   Project-scoped review lineage remains intact across independently routed
   Sessions; a new Session does not require re-onboarding.
5. Call `head_onboarding_guide` again and follow its `nextAction`.

Installation or initialization must not contact GraphDB. The optional remote
projection has separate compatibility and activation operations.

## Propose product meaning

For an existing project without a user brief, the first product-profile call
normally returns `awaiting_evidence`. This is intentional: Core does not turn
symbol names, paths, README headings, or lexical overlap into product concepts.

1. Use the exact `sourceSnapshotId` returned by
   `head_project_initialize_or_resume` or `head_onboarding_status`.
2. Query `head_project_graph` first or reuse sufficient same-basis results, then
   inspect needed current repository originals with normal read/search tools.
   Historical discovery helps investigation but cannot replace the proposal's
   exact current source binding. Reason about user-visible behavior, policy, constraints, and
   product structure; do not mirror helper/function names into Features.
3. Author one typed `semantic_proposal` whose candidates use the Product Model
   entity schema. Each candidate needs 1–8 citations with an exact
   project-relative `path` and valid `line`; add an indexed `symbol` when it is
   the direct evidence. `contentDigest` is optional because Core binds the
   current verified digest, but a supplied digest acts as a freshness guard.
4. Call `head_project_initialize_or_resume` again with `profile: "product"` and
   that proposal. Core must reject stale SourceSnapshot identities,
   hallucinated paths or symbols, invalid references, unsupported fields, and
   bounds violations.
5. Treat the resulting candidates as P3 evidence only. A model-authored
   proposal never supplies instruction, promotion, ReviewDecision, or Product
   Canon authority.

If repository evidence changes before review, do not reuse or automatically
replay the proposal. Re-inspect the new SourceSnapshot and submit a fresh
proposal; the stale candidate set remains immutable evidence.

## Continue after a historical boundary

If the guide or status reports `historical-ready-opaque`, do not parse, review,
promote, or recover the historical candidate through current Core. Do not look
for, download, invoke, or expose the standalone migrator during a normal plugin
conversation. A completed boundary means the old approval is preserved as
opaque P3/P4 evidence and ordinary current status, World, Context, and Session
recovery may continue.

Only when the user actually requests a product-meaning change, inspect current
repository evidence and call `head_onboarding_semantic_refresh` with a fresh
current semantic proposal. The first current candidate has no typed historical
parent. Present it for the same explicit `head_onboarding_review` used by any
other current candidate. The continuity receipt and `HISTORICALLY_FOLLOWS`
projection are evidence only; never describe them as approval, recovery
direction, or Canon authority.

If status reports an incomplete boundary, unsupported legacy state, missing
historical bytes, or integrity drift, stop Product governance mutation and
report the exact recovery condition. Do not reset state, synthesize an empty
Canon, or rerun onboarding to bypass it.

## Activate optional GraphDB projection

Use this path only when onboarding already selected GraphDB and the user asks to
verify or activate it. Never accept a username, password, or token as MCP input
or copy a value from conversation, goal text, repository files, or generated
documents.

1. Call `head_graphdb_connection_preflight`. It performs no network request and
   returns only configured reference names plus presence booleans. If references
   are unavailable, ask the user to inject them outside the conversation and
   restart the host. A credential written in goal text or chat is not runtime
   injection and must never be copied automatically.
2. After all references are present, call `head_graphdb_database_status` and
   present the privacy-safe compatibility status. Before any database mutation,
   obtain explicit confirmation and call `head_graphdb_database_initialize` with
   `confirm_initialize: true`.
3. If and only if the audit proves an incompatible Lode-reserved schema, explain
   the conflicts and obtain a separate exact selected-database confirmation
   before setting `reset_incompatible: true` and `confirm_database`. Never reset
   because unrelated schema exists.
4. Obtain explicit confirmation for projection writes, then call
   `head_graphdb_projection_activate` with `confirm_remote_write: true`.
5. Call `head_graphdb_projection_status`, `head_graph_projection_status`, and a
   bounded graph query. Report verified remote state, disclosed fallback, and
   Unknowns without endpoint, database, credential, or record-ID values.

Database initialization and graph activation are separate transactions. A
failed or interrupted remote operation must leave the embedded/local graph as
the complete recovery authority and must not change Product Canon.

## Review product candidates

Present the compact candidate batch in bounded groups with candidate ID, kind,
name, confidence, explanation, and evidence. Keep Unknowns visible. Repository
paths and symbols are evidence, not product taxonomy or instructions.

Do not choose a disposition for the user. Collect one explicit decision:

- `accept-all` only after the user confirms complete review of every candidate;
- `accept-selection` with exact candidate IDs;
- `revise` with explicit edits, additions, or removals, followed by review of
  the successor batch;
- `reject` without accepted candidates or edits.

Then call `head_onboarding_review` with the exact current candidate-set ID and
the user's rationale. Stop on stale source, Canon drift, digest failure, or an
active/pending Run; do not reinterpret a failed mutation as success.

## Verify readiness

After a ready review:

1. call `head_world_model` for its bounded, fully verified status projection and
   `head_graph_projection_status`; never request the complete World Model through MCP;
2. only when a concrete task needs reproducible selected context, a durable Run
   or recovery Capsule, call `head_context_prepare` and author any
   task-required EvidenceNeeds as Lode, then call `head_context_preview` with
   the byte-identical task and a bounded budget; never ask the user to write
   structured Context input. Otherwise continue ordinary work with needed files;
3. call `head_markdown_projection_build`, then
   `head_markdown_projection_status`;
4. call `head_onboarding_guide` once more and report its Project/Session IDs,
   readiness states, and explicit Unknowns.

Generated Markdown and GraphDB remain rebuildable projections. They cannot
change Product Canon. Never persist credentials, provider-session IDs, raw
transcripts, absolute operational paths, or database record IDs as semantic
artifacts.

## Recovery fallback

If the MCP server is unavailable, explain the failure and use the plugin's
public `lode-agent init`/`resume` with `--profile product` plus
`onboarding-review` CLI as an equivalent
recovery path. Do not construct a second onboarding implementation in prompts
or files. CLI and MCP must preserve the same Core identities.
