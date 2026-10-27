# Graph-first discovery and independent Sessions

## Ordinary use

Tell Lode the task once. Lode restores the relevant logical Session and current
common direction, then queries nearby project relations before seeking new
information. Reuse sufficient same-basis results. Missing or failed graph layers
lead to original files and records. No full World refresh, Product approval,
Run/Capsule, completed index or database is required to begin ordinary exploration.

The work view connects Sessions, changes, results, review and recovery records.
The Product view connects product goals, requirements, decisions and source
evidence. Both reference common originals instead of storing the same decision
twice. Current and historical revisions, unapproved candidates and rejected
records keep their own identities and states through expansion. Graph paths
explain provenance and sequence; they do not by themselves establish cause.

## Query and fallback

The default typed MCP entry is `lode_project_graph`. Lode supplies `project_root`
and `query` from the task, with optional `anchor_ids`, `paths`, `depth`,
`max_nodes`, `max_edges`, `view` (`all`, `work`, `product`),
`world_model_id`, `previous_result`, `include_candidates` and `session_id`.
Bounds limit transport; they are not a task-sufficiency decision or a user form.
Inclusive integer bounds are depth 0–8, nodes 1–500 and edges 0–1000. Zero edges
is a supported nodes-only query in Core, CLI and MCP; it does not mean zero nodes.
Out-of-range values and non-integer typed inputs are rejected rather than coerced.

The default compact result selects 8 nodes and 12 edges, retaining identity,
revision/state, provenance and coverage while omitting rich repeated payload.
Use `details: true` with returned anchors for original bounded detail and
relations; detailed defaults are 60 nodes and 120 edges. Explicit bounds can
expand either view. A short result never proves task sufficiency.

### Saved work reasons and remaining work

Already retained `SessionWorkEvidence` is discoverable through the existing
`lode_project_graph` and `graph-query` paths. Questions can match actual judgment
assessment, reason and alternatives, observed work, pending work and uncertainty,
even when the matching term is absent from the summary. Exact paths, anchors and
Session or evidence neighbors return the same typed work node and its actual
owner. No new save, native binding, Run, index refresh or user-supplied selector is
required merely to discover an existing original.

For a text query without explicit anchors or paths, bounded selection admits a
matching work original first, then its verified direct declared root and explicit
work citations before later matches. Shared endpoints cost one node; each unique
connecting edge still costs its own slot. If a companion cannot fit, the matching
original stays usable. The same node/edge/depth bounds apply, and omitted matches
are counted from the actual returned set. A companion is depth one, not a new
depth-zero seed. Explicit selectors, depth zero and zero-edge queries keep their
existing meanings. This is navigation over recorded relationships, not semantic
sufficiency, inferred task identity or a new Feature registry.

An explicit `paths` filter can also find verified historical work whose
`kind: "source"` reference names that exact logical Project path. The association
survives changed, missing, oversized, non-file, permission-denied or otherwise
unavailable targets; an observed `SESSION_PATH_ESCAPE` contributes no new match.
An artifact-kind reference alone adds no such eligibility. Original provenance,
retained/current digests and per-reference diagnostics remain distinct: this is
name association, not current target safety, ownership, body reconstruction or
effect permission. It adds no reference-path search text or exact-score bonus.

Reuse complete returned `workContent`. When useful, follow an actually returned
root, verified typed endpoint or boundary selector with a bounded neighbor query
using `anchor_ids` and `depth > 0`, keeping compact bounds and dropping unrelated
search filters. A `detail` request at depth zero expands that original, not its
siblings. Expand only actual partial content through a supported returned detail
or `originalExpansion`; a selector's existence is not a reason to reread full
bodies. Bounds can still hide an alternative or follow-up body: retain unresolved
coverage rather than treating nonempty results as completion. No additional save,
approval, index, binding or World tool chain is required.

The node's `workContent` contains original values, not a generated explanation.
`workContentCoverage.partial` distinguishes complete content from display
omission. Small fitting reasons remain complete in short output, including a
bundle of small reasons whose total exceeds the ordinary work reader's default
32768 characters. One selected work original can retain its complete near-64KiB
body when it fits the existing maximum, even with Session or file navigation
nodes beside it; a short question result does not require an extra detail read.

Default CLI/MCP text puts returned literal bodies and grouped judgments ahead of
their detailed metadata, with a short actual-owner and historical/partial-scope
notice first. A judgment's assessment, reason and alternatives stay together and
retain their original values and order. Additional original fields, including
unknown keys and empty values, stay at their own object location; identity,
reference diagnostics and residual detail follow the corresponding node or edge.
Coverage, excerpt ranges, omissions and supported expansion remain with the
enclosing result. This rendering adds no summary, field cap or read: Core values,
MCP `structuredContent`, CLI `--json`, Hooks, selection and proof are unchanged.

Default text factors exact known false work-projection authority flags into the
historical scope notice and does not print `coverage.state` twice. Complete
`selectedBodyGroups` metadata is omitted only when it exactly duplicates the
rendered groups, including original indices and owners. Partial/unknown metadata,
new values, actual bodies, diagnostics and expansions remain visible. This
text-only factoring leaves `details: true` graph text unchanged; structured values
and JSON remain intact in both modes. Smaller text is not a claim of lower reader
I/O, heap usage or model tokens.

For a large multi-original result, `workContentExcerpts` identifies actual source
field/index/subfield ranges and their total length. It does not put a shortened
reason into a field that claims to contain the whole value. Display allocation
preserves available pending work and unknowns across nodes instead of allowing
one long reason to consume every node's share. `details` requests the richer
existing presentation; neither presentation establishes semantic sufficiency.

`originalExpansion` supplies the existing `lode_session_work_read` call with the
verified owner's `session_id`, exact `evidence_ids`, `max_records` of one and the
actual enriched record-array size as `max_characters`. A successful same-basis
expansion returns that one original with no budget omission. Compare its owner,
ID and `evidenceDigest` with the graph result. This digest is distinct from
`sourceReference.digest`, which identifies the original file bytes. If the
original, owner or reference changes after discovery, recheck the affected
source; an old size estimate does not prove current completeness. An enriched
record exceeding the reader's existing maximum has no falsely callable complete
expansion and retains the original-source fallback.

Saved running, paused, ended and unknown observations remain historical evidence.
They do not clear pending work, unknown effects, canonical review obligations or
current cancellations. A file citation preserves its retained revision and
current byte status; a changed or unavailable reference does not erase an intact
work original or claim that historical file contents were recovered.

A full body alongside a changed reference or `sourceFallback` does not itself
require rereading that body. Expand missing content or check affected current
source when the next decision actually needs it; neither the fallback nor the
readable historical body supplies current effect permission.

Queries remain read-only and Project-scoped. Exact repeat proof still observes
all admitted work producer bytes, owner and relationship dependencies; it is not
constant-time or constant-byte lookup. Cold discovery, reference checks, output
shells and text/structured content duplication retain costs. Bounded displayed
content and existing cache eviction do not prove low memory use, Host delivery,
model adherence or a performance improvement.

Natural-language questions match bounded display/domain values, excluding
authority flags and revision/provenance boilerplate. Rare matching terms help
order results before the transport bound. This is deterministic lexical
navigation, not semantic inference: Lode judges relevance and missing context.
Punctuation, identifier parts and Korean particle aliases aid lookup without
replacing the original term. Exact paths/anchors remain available; Lode supplies
them when useful, rather than asking the user to write a query or scoring form.

```text
lode-agent graph-query <project> --query "<task>"
lode-agent graph-index <project>
lode-agent session-list <project>
lode-agent session-create <project> --purpose "<independent work>"
lode-agent graph-query <project> --session <logical-session> --query "<task>"
```

`lode_project_graph_index` / `graph-index` explicitly updates the replaceable
existing-observation index. Core initialize/resume and source/observation
persistence also update it where useful. Unchanged input is reused. Queries do
not create per-read receipts, candidates, approvals or checkpoints.

Read basis/revision, integrity, freshness, coverage, original state and provenance
with the result. Intact historical inputs may be useful evidence even when they
cannot authorize a present effect. A damaged or cross-Project layer is excluded;
unrelated valid layers remain usable. Empty/partial results do not prove that
facts do not exist. Use the returned original-source fallback and widen only the
missing context. A sufficient previous result or known same-basis adapter failure
may be reused without another adapter request. Requery when its relevant basis
changes. Current-effect checks remain independent.

### Scoped repeat reads

For an exact local anchor with no text/path search and no World/custom store or
adapter, Core may reuse a process-local discovery after checking Project and
index bytes, directory names/types, selected originals, relation producers and
boundary endpoints, selected source bytes, and hidden review/lineage/Session/Run
dependencies. This does not add a census of unrelated Session state bodies that
the existing path omitted. For depth0 work-only anchors that all actually fit in the returned
node set, the proof may omit unrelated reference-only bytes and uniquely mapped,
previously canonical-valid independent work originals. Selected work references,
actual or potential incoming producers, their directly needed endpoints/root
gates, existing non-work/owner/default dependencies and uncertain work remain
protected. A missing current edge is not proof that its potential producer is
irrelevant. Ambiguous identity/origin, a matched anchor omitted by maxNodes, or an
unsupported query keeps the old conservative proof or original-backed fallback.
No source path is dropped when another required or uncertain role needs it.

Follow the returned node's `detail` through `lode_project_graph` with its
`anchor_ids`, `details` and `depth`; no extra selector or native binding is needed.
The normalized defaults remain maxEdges120 for detail and maxEdges12 for compact
output. Explicit maxEdges0 is a separate query key, not a prerequisite for this
reuse. Depth0 still discloses incident boundary/next anchors. Missing/stale index,
membership/layout change or required proof failure silently uses the existing
original-backed discovery, not a new gate, repair write or mandatory extra query.

This narrower result has its own identity and `scoped-originals-reused` status.
`verifiedLayers` is empty; `retainedVerifiedLayers` describes the earlier typed
discovery. `verifiedRecordPaths` lists up to 256 paths in the actual byte proof;
`verifiedRecordCount`, `omittedVerifiedRecordPathCount` and `basis.proofDigest`
describe that proof, not all inventory records. Inventory/relationship basis
digests, `retainedDiscoveryNodeCount` and `coverage.layers` retain the earlier
discovery scope. Likewise `integrity.excluded` and `sourceFallback.excludedInputs`
are retained exclusion diagnostics, not a fresh census of currently damaged or
absent unrelated originals; `sourceFallback.action` discloses that distinction.
An independent unread original's later timestamp change or damage need not break
this narrow reuse, and the result does not certify its current integrity.
Coverage says unrelated bytes were not reverified; current membership means
names/types only. Sources outside selected/boundary nodes and new relations from
unread Session bodies remain unverified. Original-source fallback stays available.
Before effects, read the
affected originals and use the independent current-effect checks. New anchors
and broad queries can rediscover external changes without extra user approval.

Cold reads, ranked/path searches, source-collection-failure anchors, retained World and optional/custom adapter
queries still use the full existing path. Membership and index bytes grow with
the record set; cold preparation adds proof/index/membership work. Fewer warm
file reads is not a constant-byte or latency claim, and small projects can read
more bytes due to the index. Cold typed discovery, proof classification, retained
result copies and warm output cloning still cost work and memory. Existing seed
and hit checks keep their order; there is no new membership/index post-check after
the hit's proof scan, so sequential observations are not an atomic latest-at-return
snapshot. This graph-only reuse does not improve default recovery, startup or
SessionStart Hook reads. It creates no approval, P2 direction or effect authority.
No query writes a record, installs a watcher or asks the user to audit all history.

### Installed package versus active connection

Installed-file integrity and the current conversation's MCP schema/runtime are
separate checks. Use that conversation's existing read-only entry and graph
tools on the intended root; do not initialize an arbitrary Project or treat a
different chat's successful call as proof that this chat reloaded. A zero-edge
bound rejection is not an import/installation failure. A fresh CLI or a separately
launched app-server also does not verify the desktop conversation's connection.

The [official app-server documentation](https://learn.chatgpt.com/docs/app-server)
describes `config/mcpServer/reload` as reloading disk configuration and queuing
refresh for loaded threads. Use a supported Host reload only where that operation
is actually exposed and authorized, then check the target conversation again.
This plugin does not provide that desktop Host operation. If unavailable, report
the active connection as unverified rather than killing shared MCP processes,
editing caches or claiming automatic repair.

Optional ArcadeDB preserves activated temporal-query verification and embedded
fallback. Combined original-record traversal remains Core/local; this path does
not claim combined acceleration. Existing prepared-traversal acceleration follows
its separate adapter contract. Local index and original-source fallback remain usable.
This implementation's source/fixture tests do not establish new live ArcadeDB,
Host lifecycle or model behavior evidence. Speed, token savings and quality
improvements remain hypotheses until measured.

Paths-only requests bind logical File anchors from the verified retained World
to its exact snapshot for optional temporal adapter verification. With no usable
temporal selector, browsing and Work-only anchors remain `not-used` combined-local
navigation, not adapter failure. A genuine adapter failure retains its reason and
same-basis fallback reuse. Neither path claims combined traversal acceleration.

## Code impact versus record navigation

General `CONTAINS`, `HAS_REVISION` and `DECLARES` paths connect records and
versions; expanding them is not code-impact analysis. For a symbol's import/call
neighbors use existing `lode_world_query` or:

```text
lode-agent world-query <project> --query "<symbol>" --depth 3 --limit 20
```

This bounded `IMPORTS`/`CALLS` lookup uses the World capability when available.
Lode accesses the optional MCP tool through its existing discover/invoke route;
no new user setup is required. If World is absent or its relevant source is stale,
read the affected current imports/calls directly. Retained links may guide that
inspection but do not prove current impact. Do not make whole-World refresh,
new Run, Product review or database activation an investigation gate.

## Maintain evidence after integrated changes

At the end of a meaningful code-change or feature-addition segment, Lode checks
the integrated result for needed graph maintenance. Include added, changed,
deleted or renamed code and affected references/imports/calls, not only edited
files. Workers return their changes, original evidence and unknowns; Lode
reconciles the combined checkout and owns its update and verification. Workers
do not each perform an uncoordinated global refresh.

| Existing surface | What it does | What it does not do |
| --- | --- | --- |
| `lode_project_graph_index` / `graph-index` | Refreshes the replaceable inventory of existing verified records and observations; reuses identical input | Does not extract new repository code relations or infer a feature |
| `world-refresh` | Refreshes an already active World, including its supported code relations and revision evidence | Does not activate missing Product/World capability or grant approval |
| `lode_world_model`, `lode_incremental_refresh_status`, `lode_world_query` / `world-query` | Reads freshness/refresh evidence or bounded affected relations | Does not trigger a World refresh |

Core initialization/resume and supported source/observation persistence already
update the observation inventory. Reuse their sufficiently current results;
an explicit index is useful for relevant new/missing records or reconciliation,
not a ritual after every save. When follow-up work needs existing World relations,
the current refresh discovers and reads/hashes **all eligible files** under the
configured source scope, reuses unchanged semantic analysis, and recomputes
supported links against the current file set. It is not a changed-files-only
reader. Unchanged callers may gain or lose resolved targets. Preserve excluded
scope, analyzer support/confidence, unresolved imports/calls and other unknowns.
A rename may be observed as remove/add; a name match alone cannot establish
semantic identity or verified rename lineage.

Lode connects a feature's purpose/requirements to its implementation and actual
verification through existing source documents, user direction, code references
and applicable observation/result/candidate records. Keep original paths,
digests/revisions and approval state. A test's presence is not a PASS: execution
needs the actual command, tested basis, result and uncertainty. Indexing plain
documents, general conversation or successful execution does not automatically
create Product Canon or approval; existing exact user review remains unchanged.
Reference current user direction; do not write P2 direction just to store a
feature explanation.
Existing graph schemas project supported references; they do not automatically
turn arbitrary prose into typed feature-to-code-to-test edges. Keep unsupported
links in the originals and disclose what is still unprojected. Durable evidence
is retained when later work needs it, without a new compulsory form, Run or record
for every edit. Existing active/unknown execution contracts still apply; refreshing
the graph does not rewrite their digest-bound inputs or authorize another effect.

```text
lode-agent graph-index <project>
lode-agent world-refresh <project>
lode-agent world-query <project> --query "<affected symbol>" --depth 3 --limit 20
```

Use only the relevant path. No World/DB activation, full reindex, Run/Capsule,
watcher installation or routine user approval is required for ordinary work.
If maintenance fails, retain affected unreflected paths/records and uncertainty;
verify current originals and continue independent work. A retained old graph is
historical evidence, not proof that the new code is reflected. This completion
guidance uses existing capabilities; it is not a new automatic Host lifecycle hook.

Representative checks, selected according to the task rather than required as
one universal checklist: an edit changes current source evidence and supported
neighbors; a new feature keeps purpose/implementation/test references while test
execution remains separate; deletion/rename removes obsolete current relations
without erasing history; parallel integration updates the combined basis; and
refresh failure leaves a disclosed gap with usable original-source fallback.

## Route independent progress

One canonical Project holds common user direction. The original Session record
`.lode/sessions/current.json` remains the default. Additional logical Sessions
use `.lode/sessions/by-id/<session-id>/current.json`. Request-local `session_id`
(MCP) or `--session` (CLI) selects a Session without switching/overwriting the
default. `lode_session_list` lists logical Sessions; `lode_session_create`
accepts optional `new_session_id` and `purpose`. An existing ID is not rebound
to another purpose. These identities are independent of provider sessions.

`lode_session_list` returns a bounded metadata page (default 16, maximum 64 via
`max_sessions` / CLI `--max-sessions`). Pass its `nextAfterSessionId` as
`after_session_id` / CLI `--after-session` for another useful page. This traversal
key can be `default`, a Session ID, or `entry:<name>` for an invalid directory
name; it is not a logical Session route. A directory named `default` has the
distinct key `entry:default`.
Errors count as page slots, so a corrupt default or invalid last entry cannot
trap traversal. Pages are non-atomic and a removed cursor requires a fresh page.
Coverage distinguishes remaining/unavailable entries and shared-directory failure
from an empty inventory. Common Project identity failure remains an error.
`returnedEntries` distinguishes displayed slots from `inspectedEntries`;
`readButNotReturnedEntries` counts an inspected slot deferred by the output bound.
The default identity check is disclosed separately. Continuation includes any
deferred slot, so reading it does not silently skip it on the next page.

On this list only, existing `session_id` / `--session` requests an exact read-only
work preview. It preserves native persistent binding, shared caller selection and
the outer request route, including lost/unselected state. Without it the list
reads no work bodies. Preview composes the existing bounded Work/Todo reader for
one Session, preserving old unresolved tasks, conflicts and incomplete coverage.
Use exact work/source expansion for missing evidence; no binding/save is required.
Recent recorded conclusions include original reasons, remaining work and unknowns.
Latest summary, ended activity, empty pending or PASS never designates a whole-work
representative result, current responsible conversation or permission. Current
constraints/cancellation prevail. Native ancestry mapping records selection at
observation; records read later are references, not proven fork-time handoff,
delivery or model input. Exact prepared managed input alone proves neither use.

Recorded Todo task, status, attribution, next action, reason, progress and priority
also seed graph search. A partial Todo uses `workContentExcerpts` with its original
index, `todoId`, subfield and character range, alongside recorded status/origin
and declared revision selectors. It is never renumbered into a compact task array.
`workContentCoverage.fieldItems.todos` discloses whole/partial/omitted items.
Historical revisions remain separate; graph display does not independently infer
current task state, conflicts, completion or prior/reference freshness. Expand the
existing exact original when needed. Default Work text can refer to identical
task fields already shown for the same original ID/digest; structured results and
unknown fields remain intact.

Each Session retains local purpose, progress, active/unknown work, approvals and
checkpoints. One Session's investigation scope does not redirect another's task.
Existing records remain in place; routing does not require re-onboarding.

## Current common direction

`lode_project_direction_read` / `project-direction-read` returns the current
`ProjectDirection` or no record. Its `input` holds `goal`, `constraints`,
`decisions` and `cancelledActions`. It is P2 current user direction and grants
no execution authorization. Publish actual current user direction with
`lode_project_direction_update` using the read `expected_direction_id` (null
for first publication) and `direction` object. CLI uses
`project-direction-update --input <direction.json> --expected-direction <id>`.
Lode supplies the typed input from the conversation; users do not fill a form.

The pointer `.lode/project-direction/current.json` references immutable revisions.
Exact-basis comparison reconciles competing updates; timestamp and last write do
not resolve semantic conflicts. Identical updates reuse existing direction.

Graph direction nodes expose bounded `directionEvidence` for all four input
fields and `directionContentCoverage` for omitted/truncated content. Their summary
retains original path, revision and current/historical state. Read full direction
from its original when needed; a partial graph excerpt is neither the complete
direction nor P2 recovery authority. Old constraints remain historical evidence,
not the current common instruction.

Restore returns `currentProjectDirection` beside the exact historical checkpoint
fields. Suppose a Session was preparing a deployment and the user later cancelled
deployment for the whole Project: restoring that Session keeps its historical
position but applies the current cancellation before any effect. It neither
rewrites the old checkpoint nor revives its old permission. A graph copy of an
accepted decision remains evidence; execution rechecks current authority and
affected original sources.

## Counterexamples to preserve

- An unapproved/rejected neighbor never becomes approved through an edge or summary.
- A valid old revision is historical, not damaged; a wrong-Project or tampered
  artifact is excluded rather than labelled merely stale.
- A failed database query never requires Product approval to read original code.
- Concurrent Session updates never select a new global current Session.
- A common cancellation survives restoring an older deployment checkpoint.
- Read-only discovery and entry never publish direction, approval or recovery.
- One worker's uncertain effect needs reconciliation without blocking independent work.

See [authority planes](authority-plane-contract.md),
[Session recovery](session-recovery.md) and
[runtime composition](../skills/lode-agent-core/references/runtime-composition.md).

## Path bases and existing Projects

Project-internal references use validated Project-root-relative `/` paths. Generated
Markdown `relativePath` starts at the published root; each href starts at its
containing document. A `../` document link does not permit `..` in a durable selector.

Runtime `project_root`, stored `projectRoot`, installation `pluginRoot` and root-derived
identities remain bound to the verified absolute root and actual Session owner. New
Projects use `.lode/`; existing `.head/` records and exact selectors stay unchanged.
These are existing path contracts, not workspace relocation or automatic repair.

## Exact declaration selectors

A whole query naming a declaration, a whole backtick-wrapped identifier, or a
whole call expression can rank matching code declarations ahead of repeated
document headings. Natural-language questions keep their existing lexical
ordering, even when a word or backtick matches a function name. Documents remain
eligible; no code-kind filter or semantic sufficiency judgment is introduced.
Use exact paths or anchors when the question needs a more precise starting point.

