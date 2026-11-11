# Project discovery and Session routing

Read this when you install or adopt Lode, look for existing work or recorded
conclusions, find a related conversation, or update evidence after integrated
changes. Exact query, index, Session and direction APIs, with counterexamples,
are in [graph discovery](../../../docs/graph-discovery.md).

For new information, call `lode_project_graph` first or reuse a sufficient
same-basis result; read bounded nearby relations, original state, integrity,
freshness and coverage, and use original sources when needed. World, Product,
Runs and databases are not prerequisites. Historical approval is evidence, and
an effect rechecks current authority.

## Installation and adoption

1. For an explicit, authorized install or update, follow the chosen client's
   official path in [Install](../../../README.md#install). Perform the permitted
   actions and check the installation inventory or returned result, rather
   than only returning commands.
2. Reuse valid installations and the user's runtime, link and preserve choices.
   An initialized Project keeps its recorded runtime set; choose a client
   subset only for a new Project.
3. Login, Host approval, an unavailable action or a user-controlled restart may
   need the user. Leave app restarts, cache edits, wholesale config rewrites,
   trust settings, other clients and model-call permission to the user.

Installed files, Project initialization, instruction linking and actual Host
loading are separate observations; a CLI version or generated file does not
prove loading. Check an already available tool when useful. Unknown loading
blocks no independent work, and a declined installation leaves ordinary work
available. Users without this Skill can follow the README directly.

**OpenCode.** For selected OpenCode projects, init, resume and status return
`opencodeConnection`, with separate local-instruction and MCP observations and
the next useful action.

1. Reuse configured entries, sufficient AGENTS links and legacy aliases; a
   manual integration record is no reason to add a duplicate.
2. Within an authorized setup request, inspect the exact current file and apply
   only the missing diff, preserving model, permissions, other servers and
   order.
3. Ask about a disabled or conflicting entry only when setup needs it and the
   choice is material; existing consent is reused, and there is no setup gate.

JSONC, concurrent edits, unresolved Host variables and uninspectable components
stay unknown. The observer never merges or repairs user config, and configured
state is not actual Host loading.

## Existing work and recorded conclusions

**Find Sessions.** Reuse sufficient supplied context. Otherwise:

1. Call `lode_session_list` for a bounded page of stored Session states (CLI
   `session-list <project>`). Page with `max_sessions` (CLI `--max-sessions`,
   default 16, maximum 64) and the returned `nextAfterSessionId` as
   `after_session_id` (CLI `--after-session`), only when more pages are useful.
   The cursor names an entry, not a route; a missing cursor after concurrent
   changes needs a fresh page.
2. Pass `session_id` (CLI `--session <id>`) to the same list to preview one
   exact Session's work and Todo without selecting it, even with a lost or
   unselected Host binding. A preview reads at most eight recent bodies; honor
   its partial, conflict or unknown coverage and expand needed originals with
   `lode_session` (`work_read`).
3. For known canonical Session work, execution-lineage or historical-direction
   paths, use the graph `paths` argument before a global inventory; a `paths`
   read leaves unrelated membership and incoming relations unknown. For broader
   history in a known Session, call `lode_session` (`work_read`) with
   `scan_evidence: true` (CLI `session-work-read --scan-evidence`) and follow
   only the returned `enumeration.next` arguments. An exhausted page does not
   prove complete history.

Use request-local `session_id` or `--session` without replacing the default
Session, and apply current common constraints and cancellations separately when
restoring checkpoint fields.

Per-Session errors keep healthy rows; an unreadable shared directory is
unavailable, not empty. Reads never repair, bind or initialize anything, and
retained artifacts are not current permission.

**Present what you found.** Show the selected record's conclusion or recent
results with exact IDs or digests, judgments, pending work, uncertainty and
current cancellation. Default ordering, a declared work root, an ended
observation, empty pending work or passing tests do not prove completion or make
a record the whole work's result. Keep conflicting branches and same-title work
with different owners separate, expand linked ResultPackets or ReviewDecisions
only for their verified scope, and label model synthesis as derived with its
originals cited. To continue in an existing conversation, see
[continuing work](runtime-composition.md#continuing-in-an-existing-conversation).

**Find a conversation.** When it matters, reuse bounded Host candidates already
available, or a bounded listing the Host exposes, and pass them to
`lode_session_list` as `conversation_candidates` (CLI `--conversation-candidates
<file>`). Lode supplies each `runtime`, `native_session_id`, optional `agent_id`
and `environment_scope: "current"`; the user fills in no selectors. The result
checks at most 16 selectors in the current namespace; preserve its mapping
revision and digest, read time, row failures and omitted counts. An absent
mapping never selects the default; other or unverified namespaces are
unsupported, with no local fallback. Stored connection is not work-root
participation, ownership, live activity or contact readiness. Candidates change
no caller, route, environment or selection and authorize no message or
assignment. Live peers and their send addresses come from
`lode_conversation_list`; sending uses `lode_conversation_send`. With no Host
list, continue from existing records.

**Read saved work.** Search ranks lexical evidence; it does not judge relevance
or sufficiency. Saved reasons, alternatives, observed and pending work and
unknowns are graph evidence:

1. Use fitting `workContent` directly.
2. For a large multi-original result, check `workContentCoverage.partial` and
   the ranges in `workContentExcerpts`, and expand only useful missing content
   with its `originalExpansion`, keeping the owner and comparing the expanded ID
   and digest.

Saved observations and citations are historical evidence, not current
direction, live execution, review acceptance or effect authorization. Shared
direction excerpts keep constraints, decisions, cancellations, revision and
freshness; an omission disclosure leads to the original direction read.

**Code impact.** Use `lode_world` (`query`) through `lode_tools_read`, or
`world-query --query <symbol> --depth <0..3> --limit <n>`. Containment or
revision expansion is not IMPORTS/CALLS analysis. If World is absent or stale,
inspect the affected imports and calls directly instead of activating World,
refreshing everything or creating a Run. Verify retained links against current
sources before an effect.

**Hidden originals.** If an inventory bound hides relevant originals, call
`lode_project_graph` with `inventory_page: true`, optionally narrowed by
`inventory_paths` to returned owned record files or directories (CLI
`graph-query --inventory-page --inventory-paths <path,...>`). These are untyped
byte rows, not graph nodes or review proof. Follow the returned `exactRead` or
`next` arguments yourself and check `coverage`, failures and unresolved typed
dependencies: `metadata-bound` offers narrowing, `changed-scope` offers a
restart, and exhaustion applies only to the observed range. Follow `next` pages
as returned, and repeat a call only with changed arguments; stop when no
useful `next` remains; discovery completion is not a work prerequisite.

## After integrated changes

At a meaningful completion boundary:

1. **Check the integrated change.** Look at the edits, additions, deletions or
   renames and the affected callers and importers, including unchanged files
   whose relations may now resolve differently. Workers supply changed paths and
   symbols, purpose, evidence and unknowns; Lode reconciles overlapping results
   first and reuses sufficiently current hook results.
2. **Index records.** `lode_project_graph_index` (CLI `graph-index`) inventories
   existing verified records and observations; it does not parse code or infer
   features. Initialization, resume and source or observation persistence
   already update it; index explicitly when relevant records are new or missing
   or after reconciliation. Unchanged input is reused.
3. **Refresh an existing World when follow-up work needs it.** Run CLI
   `world-refresh`, then bounded `lode_world` (`query`) or `world-query` for the
   affected relations. The refresh reads and hashes every eligible source file
   and reuses unchanged analysis; it is not a changed-files-only read. Inspect
   freshness, scope, added, changed and removed paths, relation evidence and
   unresolved imports or calls. A rename can appear as remove and add; report it
   that way rather than claiming a verified rename lineage. `lode_world`
   (`model`) and `lode_projection` (`incremental_refresh_status`) are read-only
   checks, not refreshes.
4. **Connect purpose, implementation and verification** through existing source
   documents, current user direction, exact code references and applicable
   results. Each original keeps its approval state: indexing documents or
   conversation creates no Product Canon, and storing a feature explanation is
   no reason to write P2 direction. Unsupported links stay in their
   originals with the unprojected scope disclosed. A test file is implementation
   evidence; a PASS needs its execution result and basis. Preserve durable
   evidence only when later work needs it.

**On failure:** report the unreflected paths or records and the remaining
uncertainty, keep valid historical evidence labelled, verify current sources and
continue independent work. An old graph does not prove currentness; stop
retrying an unchanged failure, and graph success is not a general completion
gate. Details:
[graph discovery](../../../docs/graph-discovery.md#maintain-evidence-after-integrated-changes).
This is completion guidance, not an automatic Host lifecycle hook.
