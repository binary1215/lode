# Changelog

[한국어](CHANGELOG.ko.md)

## Publication policy

Intermediate beta versions are distributed through the Codex and Claude
marketplace branches after successful CI and publication checks. A source commit
or version number alone does not prove publication. Git tags and GitHub Releases
are made only for separately designated releases; missing intermediate tags are
not backfilled. Marketplace publication does not prove local installation or
Host/MCP reload.

## 0.3.0-beta.105 — publication tracked separately

- MCP discovery groups operations per resource behind an `action` enum, starting
  with `lode_bounded_worker`, `lode_bounded_worker_job` and
  `lode_bounded_worker_wave`. A grouped call is rewritten to its member
  operation before any check, so results, errors and effects are unchanged. The
  default tool list of 23 is unchanged; the listed catalog shrinks from 144 to
  131 tools.
- The replaced names (`lode_bounded_worker_prepare` …
  `lode_bounded_worker_wave_abandon`, and their `head_*` spellings) remain
  callable directly and through the routers until 0.5.0. Discovery lists them as
  `deprecatedAliases` and no longer shows them as tools.
- New `docs/mcp-surface.md` maps every grouped action to its deprecated name;
  `node scripts/generate-mcp-surface-docs.mjs --check` keeps it current.
- The `lode_tools_call` description points to `lode_tools_read`.

## 0.3.0-beta.104 — publication tracked separately

- `.lode` projects head the derived knowledge-graph index "LODE Agent derived
  knowledge graph", the same string `.head` projects write since 0.3.0-beta.102.
- A Markdown projection stored with the earlier heading of its dialect ("Lode
  Agent derived knowledge graph" for `.lode`, "HEAD Agent derived knowledge
  graph" for `.head`) is reported `stale` with `staleReason:
  "earlier-index-heading"` while its graph is unchanged, instead of failing as
  semantically divergent. The next `world-docs-build` rewrites it; stored
  records are not migrated.

## 0.3.0-beta.103 — publication tracked separately

- The detached worker owner's failure line in `stderr.bin` names the failing
  file operation (`syscall`, `path`, `dest`, `errno`) and its stack, so an
  intermittent filesystem error can be located.
- The concurrent presence-rewrite test is bounded to 40 rewrites per process so
  it checks the rename race rather than lock starvation on a slow runner.

## 0.3.0-beta.102 — publication tracked separately

- Source code names wire protocols, record kinds and stored values by their Lode
  spelling; the legacy `head-*` spellings come from inverse tables in
  `compat/head/format.mjs`. Bytes written to disk are unchanged for both the
  `.lode` and the `.head` dialect, and either spelling is accepted when a record
  is read.
- The stored review field `freshHeadReviewRequired`, the canon coverage values
  `curated-head-canon(-only)` and the Todo origin `head-proposed` gain Lode
  spellings (`freshLodeReviewRequired`, `curated-lode-canon(-only)`,
  `lode-proposed`). `.lode` projects write the new spelling, `.head` projects keep
  the old one, and readers accept both. `lode-proposed` is added to the Todo
  origin input enum. Forward compatibility is not kept: a `.lode` project written
  by this version is not fully readable by 0.3.0-beta.101 or older, which rejects
  the new execution-authorization field and reports `lode-proposed` Todos as
  unavailable. `.head` projects are unaffected.
- The derived knowledge-graph document written by `.head` projects is headed
  "LODE Agent derived knowledge graph".

## 0.3.0-beta.101 — publication tracked separately

- Runtime error and guidance messages call the agent Lode instead of HEAD. The
  `.head` project heading "HEAD Agent derived knowledge graph" and the fixed
  Codex proposal instructions are unchanged.
- Reported statuses, actions and guidance values use the Lode name (for example
  `lode-selection-required`, `refresh-lode-assessment` and `Lode-owned`). The
  CLI presentation still accepts the old status spellings.
- The CLI command is `lode-continuity`; `head-continuity` remains an alias.

## 0.3.0-beta.100 — publication tracked separately

- Reason codes no longer spell the old product name: `HEAD_X` is now `X`, and
  the inner `_HEAD_` segment is dropped from nine more codes. For one version,
  MCP `error.data` and CLI JSON failures also carry the old code as
  `legacyReasonCode`. `UNSUPPORTED_GC_GIT_HEAD` (Git HEAD) and the `HEAD_*`
  environment variables are unchanged.
- These values now use the Lode name: compaction status `lode_direction_required`,
  context-workflow next action `lode_assess_semantic_sufficiency`, and context
  workflow and preparation status `ready_for_lode_semantic_assessment`.
- Docs and Skills use the Lode names; the historical comparison marks HEAD as the
  old name. Hook matchers still cover the legacy `head_*` aliases.

## 0.3.0-beta.99 — publication tracked separately

- Make the canonical `lode_*` name the internal operation name. The 147
  operation descriptors live in `scripts/lib/lode-operation-contract.mjs`; tool
  descriptions say "Lode" in the source instead of being rewritten when listed.
  `head_*` names are still accepted as one-way aliases on MCP and the router, and
  `tools/list`, discovery, hooks and the CLI output are unchanged.
- Reduce `compat/head/public-names.mjs` to the one-way legacy alias rule plus the
  environment and discovery-prefix tables. `.head/` project readers are unchanged.

## 0.3.0-beta.98 — publication tracked separately

- Dispatch every CLI command through the operation registry. `scripts/lode.mjs`
  no longer has per-command branches; CLI-only commands are registry entries
  without an MCP tool, and multi-name commands use registry aliases. Help,
  version and error output are unchanged, and no call changes.
- Record the `caller` stand-in and the document prepare/publish commands in the
  dispatch recordings; refuse an implementation call on a handle-only entry
  explicitly.

## 0.3.0-beta.97 — publication tracked separately

- Dispatch every MCP tool through the operation registry, which is now also the
  MCP tool list. The ternary dispatch chain in `mcp-server.mjs` is gone; the
  last 32 MCP operations moved with their adapters, `project_status` and the
  conformance trigger tools as explicit handlers, and the 4 MiB `world_model`
  response cap as a registry field checked at the same point. No behavior change.
- Generate the Claude hook matcher from the operation registry and read the
  declared `project_root` schema from it. CLI command branches remain until the
  next release.

## 0.3.0-beta.96 — publication tracked separately

- Dispatch 44 more operations through the operation registry (111 of 144):
  project direction, onboarding, product policy and operating loop, conformance
  reads, source and context, session recovery reads, world and GraphDB status,
  document change reads, conversation entry, the compaction lifecycle step and
  observation prepare/collect. Host values reach them through the call context
  on the same surface as before; no behavior change.
- Record the host values, the `=== "true"` option branches and the option-built
  CLI inputs in the dispatch recordings with identifiable stand-ins.

## 0.3.0-beta.95 — publication tracked separately

- Let operation registry entries declare per-surface `before`/`after` adapters.
  The explicit MCP confirmations, the compact MCP results and the prepared-input
  view now run through them, in the same order as before, with no behavior change.
- Dispatch run start, release observation, feature mapping, onboarding review,
  Markdown projection build, bounded-worker status/prepare/start, runtime
  authorization read, product initiatives, observation ingest/derive and
  conformance proposals through the registry (67 of 144). The shared adapter
  helpers live in `scripts/lib/dispatch-adapters.mjs`.
- Record each refused MCP confirmation in the dispatch recordings and assert the
  derived-Observation confirmation refusal directly.

## 0.3.0-beta.94 — publication tracked separately

- Dispatch the measurement, delivery, release status, refresh receipt/status and
  observation read/query/sources operations through the operation registry (50
  of 144), with no behavior change on either surface.
- Record numeric edge limits and the `--include-execution false` case in the
  dispatch recordings, and match entry states in the documented-flow check as
  whole tokens of the core Skill's entry table.

## 0.3.0-beta.93 — publication tracked separately

- Dispatch the checkpoint, compaction, graph-lineage, change-set and
  lineage-read operations through the operation registry (32 of 144), with no
  behavior change on either surface.
- Keep the shared session work evidence schema fragments in
  `scripts/lib/tool-schemas.mjs`, used by both the MCP server and the registry.
- Record numeric wait timeouts and an unsupported JSON input field in the
  dispatch recordings, drop the CLI imports the registry made unused, and match
  entry states against the core Skill's entry table in the documented-flow check.

## 0.3.0-beta.92 — publication tracked separately

- Add `scripts/lib/operation-registry.mjs`, one registry that the MCP server and
  the CLI both dispatch through. The bounded-worker job, dispatch and wave
  operations are the first fifteen to use it; every other operation keeps its
  existing branch, and no call or tool definition changes.
- Pin which library call every MCP tool and CLI command makes in
  `test/fixtures/dispatch-recordings.json`, checked by
  `test/dispatch-recordings.test.mjs`.
- Add `scripts/verify-documented-flow.mjs`, which runs the README first-request
  flow through the CLI and MCP on synthetic projects and requires the same
  `status`, `reasonCode` and `nextAction` on both; the docs now name the flow's
  result statuses. CI runs it.

## 0.3.0-beta.91 — publication tracked separately

- Add shared `scripts/lib/core/` helpers for SHA-256 digests, canonical JSON,
  errors and reason codes, atomic writes and path-escape checks, and move the
  duplicated local helpers in `scripts/lib` onto them. Digest bytes, messages,
  codes and file effects are unchanged; a lint test keeps raw `createHash`,
  `renameSync` and local digest helpers out of the library.
- `REASON_CODES` in `scripts/lib/core/errors.mjs` lists the reason codes used as
  `code`/`reasonCode` values or fail/error call arguments; a test keeps it in
  sync with the code.

## 0.3.0-beta.90 — publication tracked separately

- Format every JavaScript source once with Prettier 3.9.10 (`printWidth` 160,
  otherwise defaults). JSON, Markdown, text and test fixtures keep their bytes.
  `.prettierrc`, `.prettierignore` and `.editorconfig` record the style,
  `npm run format` / `format:check` pin the version through npx without a
  dependency, the JavaScript CI job checks formatting, and
  `.git-blame-ignore-revs` hides the formatting commit from blame.
- Add `scripts/compare-test-baseline.mjs`, which diffs the failing-test sets of
  two TAP runs so a branch is judged by new failures against its base rather than
  by the absolute count on machines where some suites always fail.

## 0.3.0-beta.89 — publication tracked separately

- Turn the Lode Skills into an entry procedure. The core Skill opens with a
  table from the entry state (`conversation_ready`, `session_selection_unresolved`,
  `conversation_recovery_unavailable` with `NOT_INITIALIZED` or
  `PROJECT_RELOCATION_*`, MCP `error.data.reasonCode`) to the call to make and
  how to use its result; authority doctrine becomes one-line rules that link
  `docs/lode-constitution.md`. The conversation Skill maps result fields to the
  sentences they produce, and the onboarding Skill lists every `nextAction` value.
- Emit `node <plugin-root>/scripts/lode.mjs …`, the entry point every install
  has, as `nextAction.entrypoint.cli` and in readiness hints; CLI help explains
  the optional `lode-agent` launcher spelling.
- Generate the PreToolUse matchers in `hooks/claude.json` from the tool catalog
  (`scripts/generate-claude-hooks.mjs`, `--check`), verified byte-for-byte by a
  test. The matcher is built from the full catalog, so the Hook now also runs on
  `lode_tools_read` / `lode_tools_call` and the other router and discovery tools.
- Add `docs/glossary.md` (and Korean), open the README with what/why, the two
  installs, the first request and the glossary, and document the required keys
  and formats for `session-create --new-session`, `checkpoint-sync` and
  `session-work-record --input`. Their validation errors name the offending key
  or expected format; reason codes are unchanged.

## 0.3.0-beta.88 — publication tracked separately

- Enforce the declared `project_root` argument of every MCP tool before dispatch.
  A missing, empty or non-string root is refused as `INVALID_TOOL_ARGUMENTS`
  instead of silently meaning the server's current directory or surfacing a Node
  `TypeError`; routed calls are checked after the router's own shape and
  read-only checks. Every other argument rule keeps the operation's own refusal,
  identical on the CLI and MCP paths.
- Keep library reason codes on MCP errors as `error.data.reasonCode`, so an
  agent can branch on the documented code rather than on message text.
- Report a folder holding a Lode Project recorded for another root as an
  existing Project in conversation entry and the SessionStart Hook
  (`PROJECT_RELOCATION_AVAILABLE`/`PROJECT_RELOCATION_PENDING` with the explicit
  resume as next action), matching `status`. Implicit readers still adopt
  nothing. Session work reads on an uninitialized folder fail as
  `NOT_INITIALIZED` rather than a raw legacy-path `ENOENT`.
- Make `lode_session_list` directly callable from the default catalog (23
  tools), since unresolved entry names it as the discovery call. The onboarding
  guide answers `provide_product_evidence` on an initialized Core project
  instead of repeating `initialize_or_resume`. Withheld root-instruction notices
  no longer print `undefined`.
- Document that instruction linking creates a missing CLAUDE.md/AGENTS.md with
  only the link block, and that a copy whose records prove their origin is
  adopted as a relocation on explicit resume.
## 0.3.0-beta.87 — publication tracked separately

- Apply the existing controlled cleanup clock to the two remaining semantic
  clean-close fixture tests. Preserve the real native EOF/exit/tree/PID proof,
  production grace policy and forced/uncertain/nonzero negative tests.
- Add bounded test-only filesystem event and delivery diagnostics without changing
  the actual write, five-second bound, production watcher or success assertions.
  Repeated macOS timeout cause remains unestablished.
- Add Project documentation with linked human and agent views of actual Product,
  nested feature groups and multi-parent feature membership. Keep shared work and
  decisions linked once, unknown membership explicit, and narrative bound to its
  original sources.
- Share destination identity and bounded publication progress across Sessions;
  preserve existing task documents, personal notes, stable pages and reading history.
  Project scope is opt-in and meaningful analysis needs no Todo.
- Continue large hierarchies beyond 65 pages without restarting completed prefixes.
  Retain unknown effects and exact rejected-write retry boundaries. Multi-call lost-
  create searches report candidates, never current global uniqueness or auto-binding.
- Expose the same Project document Core through typed MCP, CLI and Skill.
  Synthetic vault/HTTP tests do not qualify live Notion or local app loading.

- Reuse exact unchanged reading views and their existing history links across
  unrelated publications. Preserve source, direction and pending-repair identity;
  real source changes still create history and user edits remain drift.

- Stabilize the existing post-clean-close cancellation test with its controlled
  cleanup clock, preserving real EOF, exact exit, PID absence and forced-close
  rejection. Production grace policies and failure predicates are unchanged.

## 0.3.0-beta.82 — publication tracked separately

- Prepare human explanations and agent Markdown from the same exact selected work
  originals, preserving reasons, conditions, actual changes and unknowns. Existing
  work needs no Product onboarding, World rebuild, Run or Todo adoption.
- Connect user-selected Notion and Obsidian destinations to scoped task results.
  Keep stable start links, separate personal notes and immutable reading revisions;
  current links describe the last verified publication, not task or deployment success.
- Preserve HEAD's rich evidence, comparison, quotation and related-record selection
  on exact retries. Keep successful original work saves independent of publication
  failures and continue missing selection through the existing CLI/MCP conversation.
- Recover verified synchronous Notion 403 restricted-resource rejections through an
  explicit identical-request successor, retaining prior attempts and causes. Unknown
  effects, lost responses, async failures and failed rejection saves never authorize
  another write. Preserve user edits and keep publication evidence outside P2 direction.
- Validate 206 affected regression tests, nine independent synthetic review groups
  and four documentation/distribution validators. Live Notion and Obsidian GUI
  qualification remain unperformed; the earlier full-suite local timeout remains
  incomplete. CI and marketplace publication results must be checked separately.

## 0.3.0-beta.81 — publication tracked separately

- Quarantine malformed conversation records without rewriting their original
  bytes or blocking neighboring messages. Revalidate and consume each caller
  ticket before enqueue; uncertain sends cannot reuse that consumption.
- Preserve the selected standalone Claude launcher across upgrade/rollback,
  without a new environment-variable setup step. Keep root instruction/config
  creation explicitly optional across CLI, MCP and distribution setup, including
  later opt-in, while retaining independent file-ownership choices.
- Bind hook trust observations to the same exact state entry; unsupported plugin
  identities remain unverified and never block ordinary work. Project-local
  distrust does not imply user/system hooks are disabled.
- Keep readable graph summaries while restoring complete exact raw diff paging.
  Respect explicit storage-tracking choices and declared minimum reader versions.
- Reduce duplicate GC reference calculations and share its existing deadline.
  Referenced history remains retained; zero reclaimed bytes can be successful.
  macOS physical GC remains unsupported, with explicit zero-effect coverage.
- Run the full JavaScript suite on all three CI hosts, isolate synthetic paths
  and Git configuration, and rebuild automatic Go fixtures from current sources.
  Keep externally prepared CI fixtures caller-owned. No live Host/MCP reload is implied.
- These changes correct the audit paths; they do not claim a complete live-app
  review of historical merge 404d662 or general repository-speed improvement.

## 0.3.0-beta.80 — publication tracked separately

- Include eligible exact retained source originals cited by the selected Session
  in the default portable export, with a references-only alternative and explicit
  per-reference omissions. Preserve raw bytes, identities and current target direction.
- Connect fresh and existing same-Project import, resume and re-export to exact
  CLI/MCP/Explorer historical diffs through verified admission/Session receipts.
  Unrelated source-bundle inventory limits do not hide imported exact originals.
- Reject duplicate and escaped-equivalent JSON keys at every raw object depth,
  including structural response frames. Keep normal BOM/whitespace/CRLF/Unicode
  bytes unchanged; fixed included-original conflicts cannot become omission success.
- Validate manifest capabilities through historical ownership proofs. Keep older
  bundles readable with honest source coverage and ordinary source/Git query behavior.
- Targeted synthetic and independent review passed. Physical symlink escape,
  exhaustive filesystem races, actual GUI/native-app continuation and performance
  remain unqualified. Git-only source collection remains separate; no new Git fetch
  or execution/recovery authority is introduced by this transfer.

## 0.3.0-beta.79 — publication tracked separately

- Publish all selected OpenCode sessions, messages and parts in one transaction
  through the qualified offline adapter. Preserve originals and reject global ID
  collisions without upsert, partial publication or automatic uncertain replay.
- Bind the official Windows x64 baseline 1.19.5 binary and the observed isolated
  schema/migration set; preserve existing Project mappings and target settings.
  Validate known message/part fields, existing ancestry and actual SQL ordering.
- Fix independent-review counterexamples for cross-Project parents, existing
  cycles, ordering-key drift, unrepresentable nested Session fields and hidden
  schema objects. Keep read-only clients usable and report writer contention.
- Relevant local tests passed 106/106. A separate independent CLI/MCP test and
  official isolated SQL reads checked 2 sessions, 63 messages and 63 parts; these
  are distinct evidence. Claude version/SDK synthetic reads were also exercised.
  GUI picker, native continuation, real user databases and model calls remain
  unqualified. No ordinary-profile fallback or default CLI bootstrap is enabled.

## 0.3.0-beta.78 — publication tracked separately

- Add a readable, digest-bound HANDOFF to selected Project/Session bundles and
  standalone inspection without provider startup or recovery-authority promotion.
- Connect same-platform Claude raw-history capture/restoration and optional SDK
  reading, with preflight conflicts, exact readback and no replay of uncertain effects.
- Add OpenCode Host-export and isolated import/readback interfaces. Keep the
  default CLI bootstrap unavailable until qualified; no ordinary-profile DB writer.
- Preserve source originals, current target authority and existing Codex behavior.
  Cover companion aliases, whitespace JSONL, exact-case IDs and partial failures.
  Local implementation and independent integration review passed; actual official
  client/SDK app tests, picker visibility and model continuation were excluded.

## 0.3.0-beta.77 — publication tracked separately

- Integrate same-project conversation messaging with read-only discovery,
  Host-registered destination binding and exclusive caller-ticket consumption.
- Keep unconfirmed handoffs unknown without automatic redelivery; reuse the
  existing Go supervisor for owned Codex proxy cleanup. Preserve ordinary
  work, current P1–P5 authority and Project/native-history portability boundaries.
- Preserve user ignore policies and actual pre-beta75 generated history rules.
  Provider protocol fixtures do not claim three-client live acceptance.

## 0.3.0-beta.76 — publication tracked separately

- Move a Project and selected Session using exact original records and reference
  closure. Preserve current destination settings, default selection and newer
  common direction; recover known copy/newline transitions without inventing origin.
- Include recovery-required common proof path/ID/hash metadata by default after
  a pre-export scope notice. Other Session bodies remain excluded; explicit
  `selected-only` retains partial provenance where proof is omitted.
- Add an optional exact-version Codex native-history Host adapter with local
  before-backups, current-policy metadata verification, bounded owned-process
  cleanup and at-most-once partial-group recovery. This is experimental, not a
  stable import API or proof of model continuation/current instruction binding.
- Keep Core P1–P5 and P2 recovery boundaries. Native registration evidence never
  grants a ReviewDecision, Canon promotion, Session ownership or execution permission.

## 0.3.0-beta.75 — publication tracked separately

- Default complete new local World/Graph writes to coalesced `chunked-code-v3`
  (physical schema 3). Retain old whole/v1/v2 originals and reuse unchanged IDs
  without conversion. Index, history, Compiler, Explorer, CLI/MCP and typed GC
  reconstruct and verify the same exact semantic evidence.
- Prioritize storage over latency by explicit user choice: a paired 48-file
  synthetic case cut one-line new bytes by 75.7%, with first generation 28% slower.
  A four-file case used 28% more first-write bytes, took 22% longer initially
  and 23% longer for code refresh. No universal speed or Host/model claim.
- Separate Core readiness from bounded advisory storage-reader requirements and
  distinguish observed physical file bytes from snapshot-only or reclaimable bytes.
  Preserve typed verification, permission failures, cancellation and GC deadlines.
- Upgrade only exact known generated ignore files, preserve user edits and relevant
  exceptions, and add separately labelled retained-history rules without untracking.
  Bound descriptor reads during file growth and reduce temporary relation-hash
  allocations without changing their canonical output.

## 0.3.0-beta.74 — publication tracked separately

- Use the existing controlled cleanup clock for the native queued-write/EOF
  regression. Preserve exact write order, EOF completion, clean native exit and
  process-tree proof without assuming an OS close event arrives within 66 ms.
- Keep production transport/native code and configured cleanup budgets unchanged
  (default 1,000 ms; this fixture uses 200 ms), together with strict forced-exit
  failure classification. Real escalation and EOF-resistant tests retain their
  clocks and assertions.

## 0.3.0-beta.73 — publication tracked separately

- Reorganize the English and Korean READMEs around installation, the first task,
  remaining work, plan updates and recorded before/after evidence. Move advanced
  commands and contracts to their existing specialist documents, preserving links.
- Correct Product-profile examples, Node requirements, Claude plugin/standalone
  launch conditions and current versus historical World/Graph protocol descriptions.
- Clarify shared schema-2 reader compatibility, explicit GC behavior, bounded Host
  references and the limits of synthetic performance evidence.
- Keep runtime behavior and execution fixtures unchanged; verify the relocated
  documentation contracts and translated README destinations.

## 0.3.0-beta.72 — publication tracked separately

- Let native GC termination finish and record its cleanup proof within the
  original collection deadline. Request graceful termination once; the existing
  deadline remains the hard-stop boundary for a stuck supervisor.
- Preserve byte caps, the first failure, post-stop write suppression, and explicit
  cleanup uncertainty. A stalled native process can use the remaining operation
  deadline; missing POSIX cleanup evidence still fails closed.
- Add controlled delayed-proof, stuck-process and ordinary-cancellation regression
  cases, while retaining the strict real native cleanup checks.

## 0.3.0-beta.71 — publication tracked separately

- Reuse exact selected-fragment field/index buckets when calculating partial
  work-context coverage, reducing repeated scans within each render.
- Preserve original content, selected IDs and order, partial ranges, omission
  warnings, and existing presentation/fit callback behavior without new reads,
  persistent caches, runtime artifacts or user workflow gates.
- Focused synthetic comparisons retain identical complete startup output and
  reduce partial-render computation cost. This does not establish improved
  retrieval quality, semantic sufficiency or actual Host/model utilization.

## 0.3.0-beta.70 — publication tracked separately

- Use flat shared code-domain parts for new complete World/Graph snapshots under
  selected Project ownership, preserving semantic IDs and existing whole/Git/v1
  history. Pure lower adapters retain whole-document storage without new setup.
- Report malformed optional World/Graph data as Product integrity attention while
  keeping Core ready. Explicit Product operations retain exact errors and leave
  damaged originals unchanged.
- Separate unchanged file membership from content changes in CLI/MCP/Explorer,
  retaining raw endpoints, counts/pages and visible omitted-example counts.
- Generate only ignore rules disjoint from existing exceptions, preserving user
  files and tracked policy. Batch private Git reads and reuse verified
  request-owned endpoints without a persistent cache or weaker owner checks.
- Balanced local synthetic measurements show smaller decision-only growth and
  faster first queries, with some repeated and small operations remaining slower.
  This is not a universal speedup; P2b and Rust prototypes are not adopted.

Composition schema 2 needs a supporting reader: beta.69 and earlier reject it.
Update every client sharing a store before writing v2. Publication, installation
and active Host/MCP loading remain separate.

## 0.3.0-beta.69 — publication tracked separately

- Explain new World/Graph lineage as content changes and snapshot membership while
  retaining exact raw evidence. Reuse analysis only after source and basis validation;
  unchanged verified World/Graph content can retain its immutable identity.
- Preserve project ignore exceptions and unrelated OpenCode configuration. Show
  local connection readiness without claiming the running Host has loaded it;
  describe existing cleanup outcomes without changing exit codes or policy.
- Connect exact requested Git/LFS assets to source comparisons, terminal output and
  Graph Explorer even when no graph node exists. Keep pointer identity, local cache
  presence and payload verification separate, with no implicit remote fetch.
- Read verified linked worktrees, including external common directories, through
  reciprocal metadata checks. Keep private snapshot storage independent.
- Independent source, synthetic consumer and browser evidence covers this scope.
  Later batch/scoped performance experiments are excluded. Marketplace publication,
  installation and Host/MCP loading remain separate checks.

## 0.3.0-beta.68 — publication tracked separately

- Connect substantial staged work to a completed preserved plan source, useful
  implementation/review contributions, and judgment integration through existing
  ordinary Host tools. Keep small direct work and current authority unchanged.
- Evolve the next plan from integrated results and learned facts instead of
  resetting to the initial plan or inheriting detailed review as the next planner.
- Keep native history observations, reconstructed context, actual Host behavior
  and model-quality evidence distinct. Preserve existing recovery and managed
  execution contracts without new APIs, records or user approval rituals.

## 0.3.0-beta.67 — publication tracked separately

- Add explicit, reference-verified local cleanup for orphan World/Graph files,
  private Git refs and objects, and domain bundles. Retain current/history, exact
  byte pins, recovery records, and successful or failed source originals.
- Keep pure reads zero-write and pointer APIs synchronous. Ordinary publication
  invalidates remaining cleanup effects without adding a user approval ritual.
- Bound replacement packs in isolated storage and recover valid unindexed packs
  only during a new explicit cleanup. Preserve unknown owners, damaged content,
  partial results, and incomplete retention evidence.
- Fix rooted pack-read races and Windows scratch paths; bind ref locks to the
  verified Project, attempt, host and runtime process origin.
- Verified frozen v8 with 84 GC regressions and independent Windows synthetic
  storage/CLI review. Marketplace publication and Host loading remain separate.

## 0.3.0-beta.66 — publication tracked separately

- Preserve revision-anchored Git/World evidence with immutable snapshot storage,
  domain freshness and exact temporal lineage. Keep whole-gzip storage as the default.
- Bound move matching and expose exact path-scoped, paged lineage queries across
  Core, CLI and MCP without turning partial coverage into semantic sufficiency.
- Count completed/cancelled Todo details separately from unresolved work; retain
  branch conflicts, unknown coverage and existing conversation/startup behavior.
- Exclude actual `.lode` directories at every distribution depth while preserving
  local records and ordinary `.lode` names in support code and documents.
- No tag or GitHub Release is created for this intermediate beta. Marketplace
  publication, disk installation and current Host loading are verified separately.

## 0.3.0-beta.65 — publication tracked separately

- Explore one exact Feature through structure, recorded work, and changes/related
  impact views. Preserve selection, pinned positions, camera, independent readers
  and exact source comparisons while paging large evidence inventories.
- Keep historical state, cancellation, uncertainty and partial/omitted Todo
  coverage visible on collapsed cards. Unfamiliar currentness stays readable;
  display grouping cannot create causality, approval or current permission.
- Join Product, World, reviewed code mappings and work citations by exact source
  identity. Symbol-only mappings follow their declaring file revision without
  claiming that the entire file implements a Feature.
- Reuse request-owned verified original bytes and digests across read consumers,
  retaining ownership, freshness and integrity checks. Separate static MCP
  contract metadata from effect orchestration without changing public behavior.
- Focused synthetic tests and independent actual-browser review cover this local
  implementation. Whole-project speed, live Host/model behavior, installation
  and publication remain separate claims. No intermediate release tag is implied.

## 0.3.0-beta.64 — publication tracked separately

- Restore useful work reasons, results and remaining tasks with exact original
  references and bounded excerpts. Current direction, cancellation and uncertainty
  remain distinct from historical evidence; routine entry does not require a save.
- Continue exact graph and historical-record reads without a whole inventory scan.
  Optional raw artifact inventory has explicit byte/entry limits and coverage;
  discovery never promotes evidence into approval or recovery direction.
- Reuse minimal entry guidance and preserve user-owned installation files. Protect
  supported Claude/OpenCode child state writes only with verified call provenance;
  explicit policy settings and ordinary direct work keep their existing semantics.
- Add exact process-witnessed Claude clear continuity and request-scoped packaged
  MCP composition. Missing proof keeps normal explicit recovery and project setup
  available. Owned installed MCP launchers follow verified upgrade/rollback pointers.
- Distinguish ordinary native recovery from the optional managed compaction
  lifecycle. Offer existing Session discovery only when dependent context is
  missing; current common direction keeps its original-read expansion priority.
- Local synthetic consumer and independent source checks are recorded separately
  from actual installed Host/model behavior, CI, marketplace publication and local
  reload. Preserve beta.63 payloads; intermediate release tags are not backfilled.

## 0.3.0-beta.63 — publication tracked separately

- Run the existing checks for every pull request targeting main, regardless of
  changed paths. Preserve push filters, required checks, permissions and
  publication conditions; runtime behavior is unchanged.
- Use a new beta version because publication integrity includes the workflow
  recipe. Preserve existing beta.62 packages and publication safeguards.
  Marketplace publication and local installation remain separately verified.

## 0.3.0-beta.62 — publication tracked separately

- Restore selected Session work and Todo context with exact original references.
  Preserve historical branches, conflicting observations, uncertainty and current
  cancellation without requiring a Run or promoting work evidence to direction.
- Reuse original-file bytes within a read request and use bounded recent-work
  navigation. Keep reference digests, Project ownership and freshness checks;
  missing or changed originals remain visible.
- Present work and Todo fields concisely in CLI, MCP and Graph Explorer, with
  exact source expansion and explicit partial coverage rather than repeated bodies.
- Make new onboarding and policy Product revisions directly citable from
  SessionWork. Verify each revision family and keep identical model contents in
  different Projects separate. Preserve ownerless historical bytes and retries;
  do not infer ownership for direct citation.
- Independent source and focused synthetic consumer checks cover these changes.
  Actual Host/model/GUI behavior, marketplace publication and local installation
  remain separate verification scopes. No release tag is implied.

## 0.3.0-beta.61 — publication tracked separately

- Protect optional prompt-reference storage with Windows owner/SYSTEM-only
  DACLs and a shared, bounded helper budget. Preserve masking, Project scoping,
  POSIX permissions and ordinary work when optional capture is unavailable.
- Keep the child-write guard off by default, apply enabled checks to the exact
  call, select the installed Claude package exactly, and avoid implicit default
  routing when native binding is missing. Portable OpenCode configuration stays
  unchanged; explicit logical Session routing remains available.
- Show supported work observations, follow-ups and exact partial excerpts in
  Graph Explorer cards. Preserve exact lineage endpoints, source comparisons,
  file/hunk navigation and honest missing-original or exhausted-budget notices.
- Keep large maps responsive with cooperative placement and the existing Canvas
  overview of explored evidence. Preserve all exported records/relationships,
  search, pins and explicit Focus back to cards; do not invent graph membership.
- Validate the scoped changes with independent source/browser review and focused
  synthetic checks. Correct obsolete all-SVG assertions and use controlled clocks
  for the cleanup phase boundary without changing runtime grace periods.
  Actual Host/provider behavior, Claude `/clear`, other-PC card causes and
  real-project performance remain unverified. Marketplace publication and local
  installation still require separate confirmation; no release tag is implied.

## 0.3.0-beta.60 — publication tracked separately

- Make Graph Explorer maps title-first, with per-card details and independently
  folded reading cards. Preserve intentional expansion, scroll, selection,
  camera and pins; measure changed card bounds without rearranging the graph.
- Show evidence-backed direct groups without inventing membership or edges.
  Keep source freshness, missing originals and recorded conditions available
  when expanded, including unfamiliar states.
- Connect Source-layer imports/calls to existing exact source comparisons by
  path and digest. Open code context explicitly and retain added/removed lines,
  file/hunk navigation and conservative missing-path/rename explanations.
- Verify the requested UI in a real localhost browser on synthetic reader
  output, alongside focused source tests. This is not proof of actual Host
  use, large-graph browser performance, 200% text or all long-body scrolling.
  Source/PR readiness is not marketplace publication or local installation.

## 0.3.0-beta.59 — publication tracked separately

- Write portable Claude Code, Codex, and OpenCode MCP launch lines. Shared
  `.mcp.json` and `opencode.json` use `node` plus a project-relative script or
  the client placeholder (`${CLAUDE_PLUGIN_ROOT}`, `${PLUGIN_ROOT}`,
  `{env:LODE_PLUGIN_ROOT}`). Absolute Node and install paths stay out of those
  files. Scan tracked files and three-client init output for concrete personal
  home paths, with the marketplace negative fixture allowlisted. Replace the
  personal Windows LSP fixture path. Default graph-explorer HTML remains a
  local report; `--share` still omits generated machine paths.
- Add an optional MCP subagent state-write guard. It is off unless
  `LODE_SUBAGENT_WRITE_GUARD=enforce`. Enforcement rejects non-read-only Lode
  tools from a subagent caller with `SUBAGENT_STATE_WRITE_REJECTED`. Claude
  uses the existing child `agent_id`, Codex uses `_meta.agent_id`,
  `_meta.subagent`, or a `SubagentStart` observation, and OpenCode uses a
  child session `parentID` in the exact pre-execution hook. OpenCode applies the
  same catalog read-only hint and shared policy without cross-call tickets. The
  default stays off, so a subagent can still record canon and checkpoints.
- Restore a bounded, redacted, local user-prompt reference after compaction
  or clear. Claude Code and Codex capture `prompt` on `UserPromptSubmit`,
  freeze it on `PreCompact`, and append it from `SessionStart` `compact` or
  `clear` when it fits. OpenCode captures `message.part.updated`, freezes it
  in `experimental.session.compacting`, and appends it once on the next system
  transform after `session.compacted` or a `clear` `command.executed` event.
  References are scoped by verified Project identity and caller, preserving
  explicit same-Project relocation without leaking between Projects. The text
  is non-authoritative. The checkpoint remains the recovery source.
- Resolve OpenCode's empty env-expanded launch path only from a hash-verified
  managed original bound to the current package. Keep user-owned, edited and
  unrelated commands unchanged. Verify actual selected installation paths
  after synthetic distribution upgrade and rollback, not a releaseId substring.
- This source entry is not publication proof. No intermediate tag or GitHub
  Release is created for this beta.

## 0.3.0-beta.58 — publication tracked separately

- Collapse selection tools on narrow screens and fit graph labels using measured
  extents; retain selection actions, pinned positions and graph authority limits.
- Prefer exact declaration identifiers in graph queries without turning ordinary
  words into semantic intent or excluding documents. Request-local lookup reuse
  preserves freshness and integrity checks; no material speedup was measured.
- Show exact cited historical text when a current file is missing. Display only
  bounded, byte-verified historical rename candidates, never inferred identity,
  causality or a replacement current path. Preserve UTF-8 BOM evidence.
- Correct remaining CLI display labels, add English/Korean security and
  contribution guidance, and include those documents in distribution payloads.
- Consolidate duplicate storage test files and legacy fixture setup, and remove
  redundant discovery-only subprocesses without weakening real process tests.
- Enable GitHub private vulnerability reporting and link its reporting form in
  both security documents; no response SLA or support window is promised.
- Actual browser GUI acceptance and the reported 7.3-second query remain
  unverified.
  Local and synthetic checks do not prove GUI, Host loading or provider behavior.

This source entry is not publication proof. Verify the exact source commit's CI
and each canonical/compatibility marketplace marker separately. No intermediate
tag/GitHub Release, local installation or MCP reload is included.

## 0.3.0-beta.57 — published to Codex and Claude marketplaces

Source: `e77c8e84ba82bbc70764110087d8485b2dbd7973`.
CI [39610882032](https://github.com/binary1215/lode/actions/runs/39610882032)
completed successfully. Canonical and compatibility Codex/Claude marketplace
branches were verified against this source. No GitHub Release or tag was made
for this intermediate beta, under the publication policy above. These are
publication records, not proof that a particular Host has reloaded the package.

- Use the existing controlled cleanup clock before invalid-transport requests
  start automatic shutdown. Keep all named cases and require exact native exit,
  verified tree cleanup and PID absence; do not change production grace periods
  or reinterpret uncertain cleanup as success.
- Carry forward beta.56's graph multi-selection UX. Actual browser GUI acceptance
  remains pending; a successful CI run is not GUI or Host reload evidence.

## 0.3.0-beta.56 — not published

Source: `be9bcacae377babe3aa425172661b5b9d9820847`.
CI [39602422243](https://github.com/binary1215/lode/actions/runs/39602422243)
failed two invalid-transport cleanup tests; marketplace publication was skipped.
The original failure remains recorded separately from the beta.57 repair.

- Keep multiple selected records and exact-linked file comparisons open together.
- Separate reading focus from exposure and camera; add rectangle selection,
  repeatable boundary expansion, contribution folding and real view history.
- Highlight selected connection branches with fixed component references, all
  equal shortest predecessors and original directions; do not infer causality.
- Keep large selections accessible through paging and cancellable calculations.
  These are local read-only presentation changes, not new authority or gates.
- Synthetic UI regressions are not actual browser/GUI acceptance.

## 0.3.0-beta.55 — published

Source: `fe731c88183f021e05c9a1a6e8bb7ac34890cd9c`.
CI [39581040674](https://github.com/binary1215/lode/actions/runs/39581040674)
succeeded; Lode and compatibility Codex/Claude marketplace branches were verified.

- Preserve selected graph context during search while retaining explicit scope.
- Explain verified copied/pending Project locations without adopting them in status.
- Omit generated local metadata with `graph-explorer --share`; retain original
  evidence and disclose exact HTML size without a size gate.
- Correct relocation/CLI guidance, human-facing Lode labels and missing-source
  explanations. These changes do not add a new MCP tool or recovery authority.

## 0.3.0-beta.54 — published

Source: `d0c12fe20ad0759efedb096542ecd7ccf47af2a3`.
CI [39562855184](https://github.com/binary1215/lode/actions/runs/39562855184)
succeeded; Lode and compatibility Codex/Claude marketplace branches were verified.
Preserved immediate Session-loss diagnostics and aligned the explicit-relocation
regression fixture with supported resume behavior.

## 0.3.0-beta.53 — not published

Source: `22d471e18e0ebbe82b8ea07612cc749598ae20c4`.
Added scalable graph navigation, exact context detail and explicit Project-folder
relocation. CI failed two regression tests; marketplace publishers were skipped.
The corrected successor is beta.54, not a replacement of this source history.

## 0.3.0-beta.52

Source: `4883322`. Retained recorded context provenance in shared graph views.

## 0.3.0-beta.51 — not published

Source: `465120c`. Aligned graph presentation and scan signatures. CI failed;
do not interpret this version as a successfully published marketplace release.

## 0.3.0-beta.50 / beta.49

Sources: `3327dfc` / `a2a9b08`. Added compute-output retries up to 512 MiB and
raised the default compute-output budget to 64 MiB, respectively. These entries
describe source changes, not an independent assertion of publication status.
