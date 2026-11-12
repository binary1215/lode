# Rule surface audit

Measured: 2026-11-13 for 0.3.0-beta.118: `main` commit `68d41b8` with the beta.118 change applied.

This audit records how much text and how many calls Lode asks of a model, and
which runtime rules remain. Every number below comes from
`node scripts/audit-metrics.mjs` on that commit unless the row says it is a hand
count. Add `--json` for the full report.

The script only prints. It has no limits and no failing exit code for any value.
A CI check that fails above a limit was ruled out: the numbers inform a
decision, they do not make it. The script writes nothing into the repository.
Its save and resume flows run the in-process MCP server on temporary projects
under the system temporary directory and remove them before exit.

## Always-read instructions

These are the texts a model receives in every session without asking for them.

| Source | Delivered as | Characters | Prohibitions |
| --- | --- | ---: | ---: |
| Entry paragraph (`coreEntryGuidance`) | MCP `initialize` instructions | 822 | 1 |
| SessionStart context, fresh core project | Claude Code and Codex Hook `additionalContext`; the same start context in OpenCode's system prompt | 1,909 | 2 |
| `lode-agent-core` Skill description | Skill list | 342 | 0 |
| `lode-agent-onboarding` Skill description | Skill list | 408 | 1 |
| `lode-conversation` Skill description | Skill list | 219 | 0 |
| Project instructions (`lode-instructions.md`) | root `CLAUDE.md` / `AGENTS.md` / `opencode.json`, only when written or linked | 2,301 | 1 |

| Total | Characters | Prohibitions |
| --- | ---: | ---: |
| By default (first five rows) | 3,700 | 4 |
| By default, entry paragraph counted once | 2,878 | |
| With root instruction files (all six rows) | 6,001 | 5 |
| With root instruction files, entry paragraph counted once | 4,357 | |

Notes:

- Initialization does not write root instruction files by default. On a fresh
  core project the Claude, Codex and OpenCode instruction integrations all
  report `withheld`. Two opt-ins make the project instructions always-read:
  `write_root_instruction_files` writes `CLAUDE.md` and `AGENTS.md` equal to the
  generated `lode-instructions.md`, and `instruction_integration: "link"` adds a
  managed block that imports it (`@` lines in Claude Code; a pointer to read it
  for Codex and OpenCode).
- The entry paragraph is repeated inside the SessionStart context and inside the
  project instructions. The "counted once" rows subtract the repeats.
- The SessionStart context contains the project path twice (JSON-escaped), so
  1,909 and every total that includes it depend on where the project is. The
  measurement used a 73-character escaped temporary path on Windows; a shorter
  path gives a smaller number (7 characters shorter gives 1,895). The script
  prints the path length it saw.
- The SessionStart context grows with recorded direction. After one save it was
  3,842 characters.
- The default tool list is also sent every session. It is not in these totals;
  it is measured under Tool surface below, and its prohibition phrases are
  counted separately (31).

## Prohibition phrases

The script counts these phrases: `never`, `do not`, `must not`, `cannot`. It
matches whole words, case-insensitively, over the full text. This is the list the
0.3.0-beta.110 measurement used; 0.3.0-beta.109 counted only "never" and
"do not" (see the changelog). Other strong words such as "must" or "forbidden"
are not counted.

The default `tools/list` result, sent every session, contains 31 of these
phrases (29 "never", 2 "cannot"). It is counted apart from the instruction
texts.

| File | Characters | Prohibitions |
| --- | ---: | ---: |
| `skills/lode-agent-core/SKILL.md` | 11,632 | 15 |
| `skills/lode-agent-onboarding/SKILL.md` | 11,411 | 25 |
| `skills/lode-conversation/SKILL.md` | 3,887 | 3 |
| `references/authority-and-roles.md` | 4,496 | 11 |
| `references/context-compiler.md` | 10,744 | 16 |
| `references/context-workflow.md` | 2,115 | 2 |
| `references/conversation-ux.md` | 11,972 | 6 |
| `references/project-discovery.md` | 10,487 | 4 |
| `references/recovery-workflow.md` | 10,350 | 4 |
| `references/runtime-composition.md` | 13,539 | 8 |

The four references rewritten in step 4-C (conversation-ux, recovery-workflow,
runtime-composition, project-discovery) total 46,348 characters and 22
prohibitions. The per-file counts match the 4-C result (6, 4, 8, 4). The
character total is higher than the 44,905 recorded then because
`recovery-workflow.md` grew from 8,907 to 10,350 characters between
0.3.0-beta.111 and 0.3.0-beta.115.

## Tool surface

| Surface | Tools |
| --- | ---: |
| Default `tools/list` | 22 |
| `managed-maintenance` server `tools/list` | 53 |
| Listed catalog (reached through `lode_tools_discover`; 19 are also in the default list) | 50 |
| All operations, including deprecated names | 143 |

The default `tools/list` result is 29,201 characters of JSON (29,201 UTF-8
bytes; all ASCII). A Host that defers tool schemas may send less of it to the
model; the script measures what the server returns.

## Calls for save, resume and delegation

Save and resume are scripted. The script runs each sequence on a temporary core
project with the in-process MCP server and reports the calls it dispatched and
the outcome (save `created`, resume returning the saved purpose). Verified
callers are simulated the way the Hosts identify them: a Codex `threadId`, and
for Claude Code a PreToolUse hook preparation before each call. The CLI row is
not run by the script; it is the same two operations as the unverified MCP
caller.

| Task | Caller | Lode calls | Sequence |
| --- | --- | ---: | --- |
| Save | Unverified MCP caller | 2 | `lode_checkpoint_basis`, then `lode_checkpoint_sync` |
| Save | CLI (not run by the script) | 2 | `checkpoint-basis`, then `checkpoint-sync` |
| Save | Caller the Host verified, after entry | 1 | `lode_checkpoint_sync` |
| Resume | New conversation, unverified MCP caller | 1 | `lode_conversation_enter` |
| Resume | New Codex thread | 1 | `lode_conversation_enter` |
| Resume | New Claude Code conversation, Project with one Session | 1 | `lode_conversation_enter` |
| Resume | New Claude Code conversation, Project with several Sessions | 2 | `lode_session_list`, then `lode_conversation_enter` with the `session_id` the user chose |
| Resume | Same Codex thread after compaction, with the SessionStart Hook | 0 | The Hook delivers the saved direction |

The Claude Code rows follow the state each step returns, as the Skill entry
table says. A new Claude Code conversation has no Session binding, and its
SessionStart Hook still selects nothing (`session_selection_unresolved`).
When the Project has one Session, the Hook's `reasonCode` is
`SINGLE_SESSION_ENTRY_AVAILABLE` and `sessionDiscovery.call` is
`lode_conversation_enter`: entry answers with that Session for the request and
returns its saved direction, and no binding is written. With several Sessions
the Hook gives `SESSION_SELECTION_LOST` and `lode_session_list`, and the user
chooses (since 0.3.0-beta.118; before it a new Claude Code conversation took
two calls in either case).

Delegation is a hand count from the documented paths. It is not scripted
because a worker run needs a model provider. Step 4-E (a lightweight managed
worker path) was not built, so these are today's numbers.

| Path | Lode calls | Host calls | Source |
| --- | ---: | --- | --- |
| Ordinary Host delegation (default) | 0 | 1 per worker | [runtime composition](../skills/lode-agent-core/references/runtime-composition.md) |
| Managed worker, launch to frozen patch | 4 minimum | 0 | [worker integration](worker-context-integration.md) |
| Managed worker, frozen patch to integrated Run result | 4 | 0 | [worker integration](worker-context-integration.md) |

The managed launch is `lode_bounded_worker` (prepare), `lode_bounded_worker`
(start), one or more `lode_bounded_worker_job_status` until the job ends, and
`lode_bounded_worker_job` (patch). Integration is `lode_worker_integration` with
prepare, apply, prepare-result and publish-result. Opening the Run and its later
review are not counted.

## History

These earlier values come from the changelog and the design record. They were
measured at the time, not by this script.

| Change | Before | After | Release and PR |
| --- | ---: | ---: | --- |
| Project instructions (`lode-instructions.md`), characters | 8,381 | 2,301 | 0.3.0-beta.109, #54 |
| Default `tools/list` | 23 | 22 | 0.3.0-beta.106, #51 |
| Listed catalog | 130 | 50 | 0.3.0-beta.108, #53 |
| 4-C reference set, characters | 68,835 | 44,905 | 0.3.0-beta.110, #59 |
| 4-C reference set, prohibitions | 138 | 22 | 0.3.0-beta.110, #59 |

## Runtime rules

A runtime rule stays only when it protects a user-visible outcome or an
authority boundary. Each retained rule has a narrow scope, a place where the
code enforces it, a failure you can observe, and a condition under which it can
be narrowed or removed.

### Retained invariants

| Invariant | Enforcement point | Observable failure | Narrowing or removal condition |
| --- | --- | --- | --- |
| Canon, evidence, candidates and projections stay separate | artifact validators and explicit ReviewDecision transitions | digest or authority mismatch, or a candidate that stays unpromoted | only if all affected artifacts become one authority class, which is not planned |
| Executing or mutating work is bound to the exact project and owned process or path | project fences, caller fences, safe-root checks, native supervisor | rejection before start, or a bounded cleanup receipt | read-only paths already omit execution-only fences |
| Semantic identities are content-derived and can be checked for freshness | canonical hashing, snapshot pointers, adapter verification | stale or tampered identity is rejected | timing and physical adapter identity are already excluded |
| Credentials and raw provider transcripts stay operational and non-canonical | environment filters, bounded temporary streams, transcript-free receipts | a missing credential is reported without storing the secret | none needed while providers keep their own auth stores |
| Git, GraphDB, native acceleration and document hosts are optional and never the only authority | adapter contracts and rebuildable embedded artifacts | a disclosed fallback or an adapter-local failure | adapter checks disappear when that adapter is not selected |
| A refused action is reported, not retried another way, and an action with an unknown outcome is not repeated | the entry paragraph, lease consumption receipts, at-most-once worker leases | a refusal or unknown outcome in the result | none planned |

### Rules by risk lane

| Lane | Rules retained | Rules deliberately absent |
| --- | --- | --- |
| Observe | bounded read, freshness, authority disclosure | no WholePlan, Capsule, Run, lease or review by default |
| Session | exact request digest, project scope, reversible local actions, bounded one-shot lease and result | no ExecutionContract, active Run, Product Canon change or Fresh Lode review |
| Run | accepted WholePlan, ExecutionContract, ContextCapsule, exact Run, bounded executor, ResultPacket, Fresh Lode review | no provider-session identity and no automatic Canon promotion |
| Authority | Run controls plus the user's explicit decision at the affected boundary | no approval implied by capability, graph materialization, document edits or model output |

The project instructions (always read only when root files are written or
linked) name when to open a Run: persistent ownership,
recovery after interruption, tracking effects with unknown outcomes, or
preventing duplicate integration. Otherwise work stays direct.

### Subsystem and adapter rules

- Initialization alone does not require Product onboarding, repository indexing,
  Graph, Capsule or ReviewDecision. The `core` profile is the default;
  onboarding must select the `product` profile explicitly.
- Onboarding alone requires evidence-linked candidates and an explicit batch
  ReviewDecision before Product Canon bootstrap.
- Graph and document adapters alone require rebuildability, snapshot parity,
  stale and tamper rejection, and no promotion authority.
- Native compute alone requires manifest integrity and the same results as the
  JavaScript reference. When it is absent, the JavaScript fallback is disclosed.
- Distribution alone requires owned paths, immutable release identity, verified
  native packages, recoverable pointer changes and preserved project state.
- Codex alone requires its fixed `exec` options and portable output schema.
  OpenCode alone requires `run --format json --pure`, a permission and privacy
  overlay, and its event codec. The user's own OpenCode provider settings and
  authentication stay in charge.
- The id-less save of a verified caller uses a recovery basis the server holds
  in memory for that caller. Explicit ids, unverified callers and the CLI keep
  the two-call save.
- Windows Job Objects and POSIX process groups are host-local ways to clean up
  provider descendants. They are not extra semantic rules.

### Optional capabilities

General provider-session resume and streaming, broader process-host control,
automatic merge and conflict resolution of dependent work, Obsidian or Notion
publication, and OpenAI plugin-directory publication remain optional and
unbuilt. Optional exact Lode attachment, bounded worker ownership and wait,
same-Project conversation messaging (`lode_conversation_list`,
`lode_conversation_send`) and exact-owned one-shot interrupt and close are
active but scoped. None of them is a prerequisite for installation, onboarding,
graph recovery, Context, Session, Run, provider replacement, or core operation
without Git or GraphDB.

### Removed or narrowed rules

- Tasks no longer have to go through WholePlan, Capsule, Run and Fresh Lode;
  the risk lanes own those costs.
- Product, World and Graph onboarding left the default initialization path.
- Git commits, decision markers and GraphDB availability are no longer part of
  semantic identity, recovery or onboarding.
- Provider-session identity is no longer part of Project, Session or Run
  identity.
- The OpenCode adapter no longer carries its own provider preset or endpoint
  rules; it reads the user's resolved settings.
- A fixed model-call count is not a success criterion.
- Role mail and export delivery machinery were removed. Conversation messaging
  uses the Host's live conversations.
- Tests no longer pin the wording of instructions, documents, Skills or tool
  descriptions (0.3.0-beta.107). Structural checks remain.
- Instructions that apply to one procedure are no longer always loaded
  (0.3.0-beta.109). They stay in the Skill and its references.
- The native Hook helper `lode_session_host_request_prepare` is no longer listed
  (0.3.0-beta.106).

## Not measured

- How much of the default tool list a given Host actually puts in front of the
  model.
- Token counts. All sizes are characters or UTF-8 bytes.
- Delegation calls by script, and any model-quality effect of the text sizes.

## Verdict

The default always-read instruction text is 3,700 characters (on the measuring
path) with 4 prohibition phrases; the default tool list sent beside it has 31. The
retained runtime rules map to authority separation, credential and privacy
protection, exact scope and identity, recoverability, or process ownership.
Optional adapters stay scoped. When a new mandatory rule is proposed, re-run
`node scripts/audit-metrics.mjs` and state the rule's enforcement point,
observable failure and removal condition in the same change.
