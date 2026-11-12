# Original HEAD Core comparison

Compared: 2026-11-12.

- Lode: `main` commit `b85e14b` (0.3.0-beta.116).
- Original: [`Won6314/head-agent-core`](https://github.com/Won6314/head-agent-core)
  at commit
  [`33d861458ab099dbcc22e49f329b628fbbba872b`](https://github.com/Won6314/head-agent-core/tree/33d861458ab099dbcc22e49f329b628fbbba872b)
  (2026-11-10). It was read as text from a shallow clone. Nothing from it was
  installed or run.

HEAD (old name) is what Lode was called before the rename. This document uses
HEAD only for the original.

Lode is not bound to the original. Its goal is to be easier to use. This
document records what Lode added and why, and where the two take different
routes to the same outcome. A difference is a design choice on one side, not a
defect of either side.

## The original today

The original repository now centers on one plugin, `head-context` 0.9.7, for
Claude Code and Codex. It keeps work in the project as plain files:

- a work session is a folder with a `context.md` purpose file;
- inside it, named work branches open and close, and a closed branch merges into
  one main history;
- each save appends one entry to a `history.md`, with an optional next step;
- a `todo.md` keeps later work.

SessionStart hooks put the HEAD Core text, the work context and, after `/clear`
or compaction, the last few exchanges back into the conversation. The plugin has
nine MCP tools (`list`, `load`, `create`, `save`, `branch`, `read`, `todo`,
`conversations`, `setup`), plus `send` on Codex, and one Skill, `start-job`. The
first run asks the user before it turns on the core text.

The core text,
[HEAD Core](https://github.com/Won6314/head-agent-core/blob/33d861458ab099dbcc22e49f329b628fbbba872b/packages/context/instructions/HEAD_CORE.md),
explains how context shapes a model's work (resolution, narrowing, trees,
evidence) and then gives working principles. It says detailed behavior belongs
in skills and procedures, and prohibitions belong in review criteria. Other
packages hold skills, procedures, worker role cores and shared runtime code. The
older install-shaped host daemon is kept under `packages/_platform/` and is not
part of the release.

## Principles both keep

- The lead agent owns the whole outcome; the user owns choices that change the
  result.
- Agree on the problem before detailed work.
- Keep detailed work in separate contexts and take back packaged results.
- A summary or report is evidence, not a new agreement.
- Run the main flow for real before adding checks around it.
- Keep always-loaded instructions broad and put procedure detail where the work
  needs it.

## Measured side by side

Lode values come from `node scripts/audit-metrics.mjs` (see the
[rule surface audit](rule-surface-audit.md)). Original values are hand counts on
the commit above; the method is in the last column.

| Measure | Original | Lode | Original method |
| --- | --- | --- | --- |
| Core text read every session | 6,909 characters (HEAD Core, after first-run consent) | 822-character entry paragraph; 2,301-character project instructions only when root files are written or linked | characters of the committed blob (`git show <commit>:packages/context/instructions/HEAD_CORE.md`, LF line endings) |
| MCP server instructions | 1,314 characters shared, plus 241 for Claude Code or 337 for Codex | 822 characters | characters of the template-literal values in the committed `packages/context/core/mcp.mjs` (escaped backticks counted once; read as text, not evaluated) |
| Skill descriptions in the Skill list | 1 Skill, 76 characters | 3 Skills, 969 characters | characters of the committed `start-job` `description` value |
| Tools listed by default | 9 (10 on Codex) | 22 | tool table in `packages/context/README.md` |
| Calls to save | 1 (`save`) | 1 for a verified Host caller, 2 otherwise | tool table |
| Calls to resume | 0 when the start hook loads the work session; 1 (`load`) otherwise | 0 in a linked Host conversation; 1 (`lode_conversation_enter`) for an unverified caller or a new Codex thread; 2 for a new Claude Code conversation (`lode_project_initialize_or_resume` or `lode_session_list`, then `lode_conversation_enter`) | README hook section |
| Calls to delegate | 0 plugin calls; the Host's fork or agent tool | 0 Lode calls on the default path; 4 + 4 on the managed path | server instructions |
| Prohibition phrases in the core text | 3 | 1 in the entry paragraph; 4 across the default always-read text | phrase list of the audit; the original's server instructions and Skill are in Korean, so the English list does not apply to them |

## What Lode added and why

| Addition | Why |
| --- | --- |
| One provider-neutral core with Claude Code, Codex and OpenCode adapters and the same CLI and MCP surface | The same project and records work from any of the three hosts, and a host can be replaced without losing project meaning. See [runtime adapters](runtime-adapters.md). |
| Content-addressed Project, Session, Run and checkpoint records with a recovery basis check on save | Recovery after compaction, `/clear` or a host change can verify what it restores, and two writers cannot silently overwrite each other's direction. See [session recovery](session-recovery.md). |
| A one-call save for a caller the Host verified | Keeps the conflict check without asking the model for an extra read. |
| An embedded, rebuildable project graph with optional GraphDB and document projections | Code and record discovery without making a database or a document host the source of truth. |
| Managed execution: authorizations, at-most-once leases, a native process supervisor, bounded workers and one integration flow | Work that needs durable ownership, recovery after interruption or tracking of unknown effects has a contract. Ordinary delegation stays with the Host. |
| Optional Product onboarding with evidence-linked candidates and an explicit review | Product meaning changes only by the user's decision, never from model inference. |
| Same-Project conversation listing and messaging with explicit delivery outcomes | A sender learns whether a message was delivered, queued, unknown or refused, and an unknown handoff is not replayed. See [conversation messaging](conversation-messaging.md). |
| Marketplace packages, installers for Windows, macOS and Linux, and optional native workers | Installation and updates work the same way on each platform. |

## Where the two take different routes

- **Work units.** The original uses work sessions with named work branches that
  close into one main history. Lode uses logical Sessions with recorded work
  evidence and checkpoints, and opens a Run only for persistent ownership,
  recovery after interruption, unknown effects or duplicate integration.
- **Core text.** The original loads a longer text that teaches the context
  theory behind its principles. Lode loads a short entry paragraph and moves
  procedure detail into Skills and references that are read on demand.
- **Tool surface.** The original lists nine tools. Lode lists 22 by default;
  discovery lists a catalog of 50, 19 of which are also in the default list.
- **Recent conversation.** After `/clear` or compaction, the original puts the
  last five exchanges back into the conversation. Lode restores recorded
  direction and a bounded reference to the user's last prompt.
- **First run.** The original asks the user once and then writes project
  settings, including the default-fork setting for Claude Code. Lode initializes
  without writing root instruction files unless asked.

## Earlier comparisons

Earlier versions of this document compared Lode with older shapes of the
original. On 2026-08-20 the original author audited Lode source `fd9ad3b` and,
after several rounds, found no blocking correction. On 2026-10-20 the original
paths were checked again at
[`ba220c55c14b8af947bf6d1fb9d27a620a2cf2aa`](https://github.com/Won6314/head-agent-core/tree/ba220c55c14b8af947bf6d1fb9d27a620a2cf2aa).
Both results apply only to the commits they name. This document makes no
comparative verdict.
