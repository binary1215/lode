# MCP tool surface and deprecated names

Lode lists a small default set of MCP tools and makes every other operation
available through discovery and the two routers. Since 0.3, operations on the same
resource are grouped into one tool that takes an `action`.

## Default list

The ordinary `tools/list` has 23 tools. It includes `lode_tools_discover`,
`lode_tools_read`, `lode_tools_call` and `lode_tools_read_chain`. Grouping does
not change it; grouping changes only what discovery and the managed maintenance
`tools/list` show.

The native Claude Hook helper `lode_session_host_request_prepare` is not a
catalog tool. No `tools/list`, discovery or router shows or routes it; only the
bundled PreToolUse Hook calls it. Earlier versions listed it as a 23rd tool.

## Grouped tools

A grouped tool is named after its resource, for example
`lode_bounded_worker_wave`. Its `action` selects exactly one existing operation:

```json
{
  "name": "lode_tools_call",
  "arguments": {
    "name": "lode_bounded_worker_wave",
    "execution_mode": "managed",
    "arguments": { "action": "seal", "project_root": "/path/to/project", "wave_id": "bounded-worker-wave-0123456789abcdef01234567" }
  }
}
```

- **Routes.** Each action keeps its operation's route. Read-only actions go
  through `lode_tools_read`; `lode_tools_read` refuses an action that is not
  read-only. Discovery returns `actions`, with each action's `invokeWith`,
  required fields and `executionMode`.
- **Managed actions.** An action whose operation is a managed mutation, such as
  `seal` above, needs `execution_mode: "managed"` on `lode_tools_call`, exactly
  like the operation it selects. Without it the ordinary surface refuses it with
  `MANAGED_OPERATION_NOT_ON_DEFAULT_SURFACE`. The table marks these actions, and
  discovery reports them with `executionMode: "managed"`.
- **Arguments.** The grouped schema declares `action` and every field its actions
  use. Lode removes `action` and runs the operation with the remaining
  arguments, so each action still checks its own required fields. A field that
  only another action uses is not used: most operations ignore it, and some
  refuse it (for example `lode_project_bundle`). Discovery lists each action's
  `required` fields.
- **Results.** A grouped call returns exactly what the operation returns, and it
  runs the same Session, write-guard and managed-surface checks.
- **Errors.** A missing or unknown `action` is refused with
  `INVALID_TOOL_ARGUMENTS` before any operation runs.

## Read chain

`lode_tools_read_chain` runs several read-only Lode tool calls as one
declarative step list inside the server and returns only the rows asked for,
with counts made by Lode and `knownMissing`, what Lode knows is missing. It executes no code:
a step is data, not an expression. A chain grants nothing and writes nothing (no
record, cache or temporary file), and nothing it does changes what a later call
may do or is given.

```json
{
  "project_root": "/path/to/project",
  "steps": [
    { "id": "todo", "read": { "name": "lode_product_graph_query", "arguments": { "question": "changes", "list": "reviewAgain" } }, "pages": 3 },
    { "id": "nodes", "from": "todo", "where": { "field": "kind", "eq": "node" } },
    { "id": "one", "from": "nodes", "unique": { "by": "id" } },
    { "id": "callers", "each": { "from": "one", "value": "id", "max": 20 },
      "read": { "name": "lode_product_graph_query", "arguments": { "question": "up", "id": { "$item": true } } } },
    { "id": "pointing", "from": "callers", "where": { "all": [{ "field": "kind", "eq": "node" }, { "field": "depth", "gte": 1 }] } },
    { "id": "busy", "from": "pointing", "count": { "by": "item" } },
    { "id": "top", "from": "busy", "sort": { "by": "count", "order": "desc" } }
  ],
  "return": [{ "from": "top", "limit": 10 }],
  "on_error": "continue"
}
```

- **Inner tools.** Only a tool that declares how it says "no answer", "more
  pages" and "cut" can be an inner call: `lode_product_graph_query` (also as
  `lode_product_graph` with `action: "query"`) and `lode_project_graph` (not
  with `inventory_page`). Every other tool, Session-bound reads included, is
  refused with `CHAIN_TOOL_NOT_CHAINABLE` before any call; call it directly
  through `lode_tools_read`. Neither inner tool is Session-bound or keeps any
  state for its caller, and each inner call is the request a `lode_tools_read`
  caller would send, run with the chain request's caller, surface, environment
  and cancellation signal, so the inner result equals that direct call. A
  router, the discovery tool, the chain itself, an unknown tool or a tool that is
  not read-only is refused too.
- **Steps.** Every step has an `id`, yields a list of rows (plain objects; a list
  entry that is not an object becomes `{ "value": … }`) and reads earlier steps
  only. The eight kinds: `read` (one call; `take` names the row list in the
  result, a dotted path, default the tool's declared list; a result without a
  list there is one row and counts as not fully seen; `pages` 1–10 follows the
  tool's own next-page arguments, only for a tool that declares them), `each`
  with `read` (one call per row of an earlier step, in order; `value` names the
  field handed over, `{ "$item": true }` as a whole argument value is that value,
  each produced row carries `item`, and `max` counts the step's inner calls,
  pages included; rows without the value get no call and are counted, so filter
  them out first), `where` (`eq`, `ne`, `in`, `contains`, `startsWith`, `exists`,
  `gte`, `lte`, combined with `all` / `any`), `pick` (a dotted path keeps its
  nesting), `sort` (`by`, `asc` / `desc`, stable; text by UTF-16 code units;
  missing and null values last), `limit`, `unique` (`by`, the first row wins) and
  `count` (`by`, rows `{ value, count }` in first-seen order; rows without the
  field are one row `{ value: null, missing: true, count }`). There are no
  expressions, regular expressions, string building, branching or loops.
  `lode_tools_discover` with `name: "lode_tools_read_chain"` returns this
  reference.
- **Before any call.** The whole program is checked first (shape, step
  references, tools, project root, bounds) and every problem is reported at once
  with status `refused`; then no inner call happens. `project_root` is given once
  and supplied to every inner call; an inner `project_root` that names another
  folder is refused.
- **One build.** A chain never returns rows from two product graph builds. This
  is detected after each call, not prevented: every answered product graph query
  carries `buildSha256` (the bytes of `graph.json` and `check.json` of every build
  it read, and the baseline it was read against). When a later answer differs
  from the first, the chain stops with `CHAIN_BUILD_CHANGED` and the answer
  carries no rows and no content of either build: codes, counts and, in
  `basis`, only tool names and `pinned` (not the first build's time or
  freshness); a rebuild or a baseline move between two calls does that. A next page after such
  a change is reported by the tool itself (`basis-changed`) and stops the chain
  the same way; a wrong `expected_basis_sha256` on a first call is that call's own
  failure. `lode_project_graph` has no such identity and is listed in `basis`
  with `pinned: false`.
- **Failures.** A failed or refused inner call is recorded in `issues` with its
  code, the step and the item (shortened), and the chain continues;
  `on_error: "stop"` stops there. Nothing is retried, and a non-answer is never a
  row.
- **Same input, same output.** The same input and the same state give
  byte-identical output. The state includes `lode_project_graph`'s own
  process cache: an identical second chain can differ in what that tool says
  about reusing an earlier result, namely `reuse.status` in its answer and
  reason codes such as `PROJECT_GRAPH_SCOPED_VERIFICATION` in its
  `sourceFallback.reasonCodes` (so in `basis[].stated[].reasonCodes` too).
  Product graph answers have no such cache.

### Bounds

| Bound | Value |
| --- | --- |
| Steps | 12 |
| Inner calls in total, pages included | 40 |
| Calls of one `each`, pages included | 20 |
| Pages of one `read` | 10 |
| Values of one `in` | 100 |
| Fields of one `pick` | 32 |
| Parts of a field path | 4 |
| Nesting of `all` / `any` | 2 |
| Nesting of the input | 32 |
| Returned bytes (`max_bytes`) | default 16 KiB, from 4 KiB to 64 KiB |
| Intermediate rows | 16 MiB |
| Input | 64 KiB |

A program past a bound of its own shape (steps, values, fields, path parts,
nesting, input, `max_bytes`, `max`, `pages`) is refused before any call. The call,
page, `each` and intermediate bounds cut: the answer holds what was reached and
counts what was not. The answer as sent is never over `max_bytes`: when even
the answer without rows does not fit, issue messages and items go first, then
headers, then issues become counts by code, then `basis` keeps tool names.

### Answer

```json
{
  "status": "completed",
  "knownMissing": [],
  "ran": { "steps": 7, "calls": 5, "failed": 0, "refused": 0 },
  "basis": [{ "tool": "lode_product_graph_query", "pinned": true, "builtAt": "…", "freshness": "…", "stated": [{ "confirmationComparison": "compared", "baselineComparison": "compared" }] }],
  "header": ["…"],
  "results": { "top": { "total": 3, "returned": 3, "cut": 0, "rows": [{ "value": "…", "count": 3 }] } },
  "notSeen": { "pagesLeft": 0, "itemsLeft": 0, "eachSkipped": 0, "eachNoValue": 0, "callsSkipped": 0, "rowsDropped": 0, "answersSaidIncomplete": 0, "takeNotAList": 0 },
  "issues": [],
  "persisted": false,
  "grantsAuthorization": false
}
```

- `status`: `completed`; `partial` (a bound was reached, a tool said rows or
  content were missing from its answer, an inner call failed or was refused,
  rows had no `each` value, or an answer had no list where `take` pointed:
  any non-zero `notSeen` count); `stopped` (the build or baseline changed, `on_error: "stop"`, or
  the request was cancelled); `refused` (the program is invalid).
- `knownMissing` lists the reasons Lode knows something is missing from the
  rows and content of these answers: `STATUS_PARTIAL` or `STATUS_STOPPED`,
  `INNER_CALL_FAILED`, `INNER_CALL_REFUSED`, `NOT_SEEN_<count>` for each
  non-zero `notSeen` count (a page not followed is `NOT_SEEN_pagesLeft`),
  `ROWS_CUT`, `STEP_NOT_REACHED`, and `TOOL_SAID:<tool>:<signal>` for each
  signal an inner answer gave about itself. When even those names do not fit
  in `max_bytes`, the tool reasons become one `TOOL_SAID_INCOMPLETE:<n>`. **An
  empty list does not prove completeness: it means nothing Lode can detect was
  missing.** How much of the source the graph covers is not in this list; it is
  the product graph `header` and the `stated` coverage in `basis`.
- The signals each inner tool gives: for `lode_product_graph_query`, a page not
  followed (`page.remaining`), a mark on the answer (`missing`, for a title
  that says something was not checked or compared) or on a row
  (`rows[].missing`: a list cut in prose, a tree cut below the first level, the
  row cap of one answer, the connections of a find result capped at six, a
  check not run, a comparison not made, the confirmation-record limit, an
  unread confirmation record), a before/after side whose status is `partial`
  or `unavailable`, `confirmationComparison` or `baselineComparison` other
  than `compared` (`confirmationComparison` is `partial` when the build read
  only the first confirmation records by name, which every list and row
  `confirmation` then comes from; `baselineComparison` is `baseline-moved`
  when the baseline was moved after the build), and an impact preview whose `impact.status` is
  `unavailable` or `partial`; for `lode_project_graph`,
  `status` `source-fallback` (no graph match), `truncated`, `omittedMatchCount`,
  `boundary.items`, `boundary.omittedCount`, `boundary.omittedAnchorCount`,
  `unmatchedAnchorIds`, `integrity.excluded`,
  `integrity.omittedVerifiedRecordPathCount`, `coverage.state`,
  `coverage.layers[].status`, `coverage.inventoryBoundReached`,
  `sourceFallback.needed`, `sourceFallback.excludedInputs`, and a node's
  `contentPartial`, `directionContentCoverage.partial` or
  `workContentCoverage.partial` (and the summary's direction references).
  The project graph's list is not exhaustive, and its coverage is partial by
  design, so a chain over it always has reasons.
- A mark (`missing`) has a `kind` (`cut`, `rowCap`, `connectionsCut`,
  `notChecked`, `notCompared`, `recordLimit`, `recordUnread`), the `site` that
  wrote it, and what it knows: `left`, `shown` and `total`, `present` and
  `read`, `check` (the check that did not run, also on the answer of that
  check's own list), `list`, `with` (`baseline` or `confirmations`, what was
  not compared), `code` (an unread record's reason code) and `rows` (the row
  cap). The row-cap mark counts hidden node rows: it has `left` only when that
  count is every hidden node row, and a hidden group line or "more" row is not
  in it. A "비교하지 않음 — …" row answering a list that was not compared has
  no mark of its own: the mark is on the answer.
- Not reported as missing, because they shorten how one row or one block
  reads, not what the answer lists: a 기능's positions shortened in its line
  ("… 외 N곳"); "본문은 여기 넣지 않는다" in the `changes` summary (the
  content is `changes --list content`); a node type the build does not extract
  ("뽑지 않음" in the overview; the header's limits say so); the before/after
  text of a content row shown up to 40 lines of 240 characters (`rows[].detail`
  has it whole within the page bound); and what only `check.txt` and the Graph
  Explorer page show (file lists and side-by-side text shortened there).
- A page continuation row of the product graph (`continues: "nextPage"`) is a
  marker, not a row: a followed page brings its rows, and a page not followed
  is counted in `notSeen.pagesLeft`. Rows a later page repeats (its root, its
  headings, a group line) are not added again, so following pages gives the
  rows one call with a large enough limit gives. The tool marks those rows
  (`repeats: "earlierPage"`) and only marked rows are left out: a row equal to
  an earlier one is kept. A chain that starts at a later page keeps them.
  `toolItems` in a result is the tool's own item count (`page.total` of each
  read's first page, summed over the calls of an `each`).
- `basis` names each inner tool once: `pinned`; for the product graph the first
  answer's `builtAt` and freshness and what it `stated`
  (`confirmationComparison`, `baselineComparison`, and for impact its status
  and reasons); for `lode_project_graph` what it `stated` (coverage state,
  whether a source fallback is needed, excluded layers with reason codes, the
  fallback reason codes, `status` and `unmatchedAnchorIds`). At most four
  distinct statements per tool; an empty one is left out. A list in a
  statement keeps eight entries and says how many more there were
  (`<name>Omitted`).
- Only steps named in `return` carry rows. `total` is the step's rows,
  `returned` the rows in the answer, `cut` the rest (a `return` `limit` or
  `max_bytes`).
- `notSeen`: `pagesLeft` reads that stopped with a next page, `itemsLeft` the
  items those pages still had, `eachSkipped` rows past an `each` maximum,
  `eachNoValue` rows without the `each` value, `callsSkipped` calls not made
  because of the call bound or full intermediate rows, `rowsDropped` rows
  dropped at the intermediate bound, `answersSaidIncomplete` inner answers that
  said rows or content were missing from themselves, `takeNotAList` answers
  without a list where `take` pointed.
- A header that every inner answer repeated is given once in `header`;
  different headers are listed in `headers` with the step they came from.
- The content text is the JSON answer itself, not a second copy in prose.

The CLI has the same chain, with the same checks and answer:
`lode-agent tools-read-chain <project> --input chain.json`. The input may omit
`project_root`.

### Result shapes

`lode_tools_discover` by exact name returns a short `resultShape` for
`lode_product_graph_query` (rows `rows`; `header`; paging `page.total`,
`page.remaining`, `page.nextMcpArguments`; `builtAt`, `buildSha256`,
`confirmationComparison`), `lode_project_graph` (rows `nodes`, also `edges`;
with `inventory_page` the rows are `inventoryPage.rows` and the next call
`inventoryPage.next`) and `lode_session_work_read` (rows `records`, also
`todoContext.items`; next `nextAfterEvidenceId`). `chainable` says whether the
tool can be an inner call. For a grouped tool, each action with a shape carries
it.

## Deprecated names

The operation names a group replaced remain callable for two minor versions:
directly, through `lode_tools_read` / `lode_tools_call`, and in their historical
`head_*` spelling. They are removed in the version named in the table header.

- Discovery lists only the grouped tool. Looking up a deprecated name returns that
  grouped tool, whose `deprecatedAliases` lists each old name with its `action`
  and `removedIn` version.
- The Claude Code `PreToolUse` matchers in `hooks/claude.json` cover every
  grouped tool with an effectful or Session-bound action, and the deprecated
  names of those effectful or Session-bound operations.
- Operation results that suggest a next call name the grouped tool and its
  action, for example `lode_session` with `action: "work_read"` or
  `lode_context` with `action: "prepare"`. They no longer suggest the
  deprecated names, which stay callable until the removal version.

## Mapping

<!-- generated: mcp-surface-groups (node scripts/generate-mcp-surface-docs.mjs) -->

| Grouped tool | `action` | Route | Deprecated name (0.5.0) |
| --- | --- | --- | --- |
| `lode_bounded_worker` | `prepare` | `lode_tools_call` with `execution_mode: managed` | `lode_bounded_worker_prepare` |
| `lode_bounded_worker` | `start` | `lode_tools_call` with `execution_mode: managed` | `lode_bounded_worker_start` |
| `lode_bounded_worker` | `reconcile` | `lode_tools_call` with `execution_mode: managed` | `lode_bounded_worker_reconcile` |
| `lode_bounded_worker` | `dispatch` | `lode_tools_call` with `execution_mode: managed` | `lode_bounded_worker_dispatch` |
| `lode_bounded_worker` | `status` | `lode_tools_read` | `lode_bounded_worker_status` |
| `lode_bounded_worker` | `wait` | `lode_tools_read` | `lode_bounded_worker_wait` |
| `lode_bounded_worker` | `apply_result` | `lode_tools_call` with `execution_mode: managed` | `lode_bounded_worker_apply_result` |
| `lode_bounded_worker_job` | `reconcile` | `lode_tools_call` with `execution_mode: managed` | `lode_bounded_worker_job_reconcile` |
| `lode_bounded_worker_job` | `patch` | `lode_tools_read` | `lode_bounded_worker_job_patch` |
| `lode_bounded_worker_wave` | `create` | `lode_tools_call` with `execution_mode: managed` | `lode_bounded_worker_wave_create` |
| `lode_bounded_worker_wave` | `read` | `lode_tools_read` | `lode_bounded_worker_wave_read` |
| `lode_bounded_worker_wave` | `seal` | `lode_tools_call` with `execution_mode: managed` | `lode_bounded_worker_wave_seal` |
| `lode_bounded_worker_wave` | `status` | `lode_tools_read` | `lode_bounded_worker_wave_status` |
| `lode_bounded_worker_wave` | `results` | `lode_tools_read` | `lode_bounded_worker_wave_results` |
| `lode_bounded_worker_wave` | `wait` | `lode_tools_read` | `lode_bounded_worker_wave_wait` |
| `lode_bounded_worker_wave` | `abandon` | `lode_tools_call` with `execution_mode: managed` | `lode_bounded_worker_wave_abandon` |
| `lode_project_document` | `prepare` | `lode_tools_call` | `lode_project_document_prepare` |
| `lode_project_document` | `publish` | `lode_tools_call` | `lode_project_document_publish` |
| `lode_project_document` | `status` | `lode_tools_read` | `lode_project_document_status` |
| `lode_work_document` | `configure` | `lode_tools_call` | `lode_work_document_configure` |
| `lode_work_document` | `prepare` | `lode_tools_call` | `lode_work_document_prepare` |
| `lode_work_document` | `publish` | `lode_tools_call` | `lode_work_document_publish` |
| `lode_work_document` | `status` | `lode_tools_read` | `lode_work_document_status` |
| `lode_onboarding` | `guide` | `lode_tools_read` | `lode_onboarding_guide` |
| `lode_onboarding` | `semantic_refresh` | `lode_tools_call` | `lode_onboarding_semantic_refresh` |
| `lode_onboarding` | `candidate_restore` | `lode_tools_call` | `lode_onboarding_candidate_restore` |
| `lode_onboarding` | `review` | `lode_tools_call` | `lode_onboarding_review` |
| `lode_onboarding` | `status` | `lode_tools_read` | `lode_onboarding_status` |
| `lode_project_bundle` | `export` | `lode_tools_call` | `lode_project_bundle_export` |
| `lode_project_bundle` | `read` | `lode_tools_read` | `lode_project_bundle_read` |
| `lode_project_bundle` | `import` | `lode_tools_call` | `lode_project_bundle_import` |
| `lode_product` | `signal_record` | `lode_tools_call` | `lode_product_signal_record` |
| `lode_product` | `hypothesis_record` | `lode_tools_call` | `lode_product_hypothesis_record` |
| `lode_product` | `initiative_propose` | `lode_tools_call` | `lode_product_initiative_propose` |
| `lode_product` | `initiative_review` | `lode_tools_call` | `lode_product_initiative_review` |
| `lode_product` | `outcome_observe` | `lode_tools_call` | `lode_product_outcome_observe` |
| `lode_product` | `operating_status` | `lode_tools_read` | `lode_product_operating_status` |
| `lode_product` | `policy_propose` | `lode_tools_call` | `lode_product_policy_propose` |
| `lode_product` | `policy_review` | `lode_tools_call` | `lode_product_policy_review` |
| `lode_product` | `policy_status` | `lode_tools_read` | `lode_product_policy_status` |
| `lode_product` | `policy_candidate` | `lode_tools_read` | `lode_product_policy_candidate` |
| `lode_product` | `policy_review_decision` | `lode_tools_read` | `lode_product_policy_review_decision` |
| `lode_metric` | `define` | `lode_tools_call` | `lode_metric_define` |
| `lode_metric` | `observe` | `lode_tools_call` | `lode_metric_observe` |
| `lode_metric` | `compare` | `lode_tools_call` | `lode_metric_compare` |
| `lode_metric` | `assess` | `lode_tools_call` | `lode_metric_assess` |
| `lode_metric` | `status` | `lode_tools_read` | `lode_metric_status` |
| `lode_metric` | `trace` | `lode_tools_read` | `lode_metric_trace` |
| `lode_delivery` | `observe` | `lode_tools_call` | `lode_delivery_observe` |
| `lode_delivery` | `status` | `lode_tools_read` | `lode_delivery_status` |
| `lode_delivery` | `release_observe` | `lode_tools_call` | `lode_release_observe` |
| `lode_delivery` | `release_status` | `lode_tools_read` | `lode_release_status` |
| `lode_runtime` | `adapters` | `lode_tools_read` | `lode_runtime_adapters` |
| `lode_runtime` | `invocation_authorization` | `lode_tools_read` | `lode_runtime_invocation_authorization` |
| `lode_runtime` | `invocation_result` | `lode_tools_read` | `lode_runtime_invocation_result` |
| `lode_runtime` | `state` | `lode_tools_read` | `lode_runtime_state` |
| `lode_feature_mapping` | `propose` | `lode_tools_call` | `lode_feature_mapping_propose` |
| `lode_feature_mapping` | `status` | `lode_tools_read` | `lode_feature_mapping_status` |
| `lode_feature_mapping` | `review` | `lode_tools_call` | `lode_feature_mapping_review` |
| `lode_product_graph` | `build` | `lode_tools_call` | `lode_product_graph_build` |
| `lode_product_graph` | `check` | `lode_tools_read` | `lode_product_graph_check` |
| `lode_product_graph` | `query` | `lode_tools_read` | `lode_product_graph_query` |
| `lode_product_graph` | `sample` | `lode_tools_read` | `lode_product_graph_sample` |
| `lode_product_graph` | `baseline` | `lode_tools_call` | `lode_product_graph_baseline` |
| `lode_product_graph` | `confirm` | `lode_tools_call` | `lode_product_graph_confirm` |
| `lode_product_graph` | `runs_add` | `lode_tools_call` | `lode_product_graph_runs_add` |
| `lode_product_graph` | `approve` | `lode_tools_call` | `lode_product_graph_approve` |
| `lode_vcs` | `change_set_status` | `lode_tools_read` | `lode_change_set_status` |
| `lode_vcs` | `evidence` | `lode_tools_read` | `lode_vcs_evidence` |
| `lode_vcs` | `git_history` | `lode_tools_read` | `lode_git_history` |
| `lode_conformance` | `prepare` | `lode_tools_read` | `lode_conformance_prepare` |
| `lode_conformance` | `propose` | `lode_tools_call` | `lode_conformance_propose` |
| `lode_conformance` | `queue` | `lode_tools_read` | `lode_conformance_queue` |
| `lode_conformance` | `read` | `lode_tools_read` | `lode_conformance_read` |
| `lode_conformance` | `disposition` | `lode_tools_call` | `lode_conformance_disposition` |
| `lode_conformance` | `resolution_propose` | `lode_tools_call` | `lode_conformance_resolution_propose` |
| `lode_conformance` | `trigger_status` | `lode_tools_read` | `lode_conformance_trigger_status` |
| `lode_conformance` | `trigger_prepare` | `lode_tools_call` | `lode_conformance_trigger_prepare` |
| `lode_source` | `context` | `lode_tools_call` | `lode_source_context` |
| `lode_source` | `observation_read` | `lode_tools_read` | `lode_source_observation_read` |
| `lode_context` | `prepare` | `lode_tools_read` | `lode_context_prepare` |
| `lode_context` | `preview` | `lode_tools_read` | `lode_context_preview` |
| `lode_context` | `capsule` | `lode_tools_read` | `lode_context_capsule` |
| `lode_session` | `work_record` | `lode_tools_call` | `lode_session_work_record` |
| `lode_session` | `work_read` | `lode_tools_read` | `lode_session_work_read` |
| `lode_session` | `continue` | `lode_tools_call` | `lode_session_continue` |
| `lode_run` | `integrate_checkpoint` | `lode_tools_call` | `lode_run_integrate_checkpoint` |
| `lode_run` | `integration` | `lode_tools_read` | `lode_run_integration` |
| `lode_run` | `start` | `lode_tools_call` | `lode_run_start` |
| `lode_world` | `model` | `lode_tools_read` | `lode_world_model` |
| `lode_world` | `query` | `lode_tools_read` | `lode_world_query` |
| `lode_projection` | `incremental_refresh_status` | `lode_tools_read` | `lode_incremental_refresh_status` |
| `lode_projection` | `incremental_refresh_receipt` | `lode_tools_read` | `lode_incremental_refresh_receipt` |
| `lode_projection` | `refresh_trigger_status` | `lode_tools_read` | `lode_refresh_trigger_status` |
| `lode_projection` | `refresh_trigger_delivery` | `lode_tools_read` | `lode_refresh_trigger_delivery` |
| `lode_projection` | `graph_projection_status` | `lode_tools_read` | `lode_graph_projection_status` |
| `lode_projection` | `graphdb_projection_status` | `lode_tools_read` | `lode_graphdb_projection_status` |
| `lode_projection` | `graphdb_database_status` | `lode_tools_read` | `lode_graphdb_database_status` |
| `lode_projection` | `graphdb_connection_preflight` | `lode_tools_read` | `lode_graphdb_connection_preflight` |
| `lode_projection` | `graphdb_database_initialize` | `lode_tools_call` | `lode_graphdb_database_initialize` |
| `lode_projection` | `graphdb_projection_activate` | `lode_tools_call` | `lode_graphdb_projection_activate` |
| `lode_projection` | `markdown_projection_build` | `lode_tools_call` | `lode_markdown_projection_build` |
| `lode_projection` | `markdown_projection_status` | `lode_tools_read` | `lode_markdown_projection_status` |
| `lode_projection` | `post_refresh_projection_status` | `lode_tools_read` | `lode_post_refresh_projection_status` |
| `lode_projection` | `post_refresh_projection_receipt` | `lode_tools_read` | `lode_post_refresh_projection_receipt` |
| `lode_document_change` | `candidates` | `lode_tools_read` | `lode_document_change_candidates` |
| `lode_document_change` | `review_status` | `lode_tools_read` | `lode_document_change_review_status` |
| `lode_document_change` | `review` | `lode_tools_read` | `lode_document_change_review` |
| `lode_document_change` | `application` | `lode_tools_read` | `lode_document_change_application` |
| `lode_graph_lineage` | `status` | `lode_tools_read` | `lode_graph_lineage_status` |
| `lode_graph_lineage` | `trace` | `lode_tools_read` | `lode_graph_lineage_trace` |
| `lode_graph_lineage` | `diff` | `lode_tools_read` | `lode_graph_lineage_diff` |
| `lode_compact` | `prepare` | `lode_tools_call` | `lode_compact_prepare` |
| `lode_compact` | `verify` | `lode_tools_call` | `lode_compact_verify` |
| `lode_compact` | `continue` | `lode_tools_call` | `lode_compact_continue` |
| `lode_compact` | `status` | `lode_tools_read` | `lode_compact_status` |
| `lode_compact` | `abort` | `lode_tools_call` | `lode_compact_abort` |
| `lode_compact` | `compaction_lifecycle_step` | `lode_tools_call` | `lode_compaction_lifecycle_step` |
| `lode_observation` | `sources` | `lode_tools_read` | `lode_observation_sources` |
| `lode_observation` | `prepare` | `lode_tools_read` | `lode_observation_prepare` |
| `lode_observation` | `collect_source` | `lode_tools_call` | `lode_observation_collect_source` |
| `lode_observation` | `ingest` | `lode_tools_call` | `lode_observation_ingest` |
| `lode_observation` | `derive` | `lode_tools_call` | `lode_observation_derive` |
| `lode_observation` | `read` | `lode_tools_read` | `lode_observation_read` |
| `lode_observation` | `query` | `lode_tools_read` | `lode_observation_query` |

<!-- end generated: mcp-surface-groups -->
