# Common Observation contract and adapters

## Task-scoped source collection

`lode_source_context` / `lode-agent source-context` collects Lode-selected current
source evidence and feeds it into the existing Context Compiler. Lode translates
the conversational task into exact paths and qualified function names; users do
not author hashes, IDs or JSON. No World scan, full reindex, Product onboarding or
GraphDB is required. A task-only request returns a Lode selection step rather
than inventing semantic relevance from words.

The current live collector is **Python stdlib AST**, not LSP: Python 3.8+ found
on Host PATH, or a trusted absolute `LODE_PYTHON` setting. `HEAD_PYTHON` remains a
compatibility name; conflicting configured values are rejected rather than
silently selecting an interpreter. It runs the packaged
worker with `-I -S -B` in a neutral directory, parses supplied bytes, never imports
project modules, and opens no network listener. It reports positive direct-name
lexical candidates for an unambiguous undecorated module function or an earlier
unconditional function local to the selected caller. Imported/aliased, attribute,
dynamic, shadowed, decorated, conditional and unresolved enclosing-scope calls
are disclosed as unresolved. Nested bodies/default/decorator evaluation are not
complete call coverage. No semantic truth or complete program coverage is claimed.

Source reads bind exact dirty working-tree bytes and reject symlinks/path escape,
concurrent changes and non-UTF8/BOM/lone-CR input rather than silently rewriting
it. AST UTF8 byte offsets are converted to exact UTF16 ranges, including CRLF and
non-BMP text. Source files and raw responses each use the existing v0 1 MiB bound;
ordinary source excerpts disclose omitted bytes and fit the common Observation
64 KiB string contract. The batch has at most 32 Lode-selected needs. A per-worker
15-second default (Host-selectable up to 120 seconds), bounded stdout/stderr and
explicit cancellation keep failures finite; these are operational bounds, not
semantic sufficiency gates.

Successful observations use `source.structural-context` in the common P3 store
and separately hashed original source/response bundles when `retain` is selected.
Default ephemeral inputs receive the same verification before Context use but
make no durable-recovery claim. Cross-process reuse checks current source,
query, Python/AST/tokenizer, worker and normalizer identities. Failed collection
records preserve raw responses when available and coalesce identical outcomes.
Read exact success/failure keys with `lode_source_observation_read`; keys are
returned to Lode automatically. Retention is a task-local evidence choice, not
an extra user approval. Neither cache, observations, results nor Context previews
alter Product Canon, ReviewDecision or P2 checkpoint/direction.

Historical reads validate stored integrity even when working-tree sources have
changed: `sourceState` discloses stale/unavailable bytes and current Context
eligibility separately. Damaged/missing stored candidates are reported and left
untouched; the Host tries valid candidates or fresh collection, without losing
independent needs. Optional retention failure does not invalidate verified
ephemeral evidence, but `retentionPending` prevents a durable-handoff claim.
`SourceContextResult` is a P4 wrapper; the included `ContextCapsule` remains a
P2-typed **unpersisted, unbound preview**, not a recovery update.
`SourceCollectionFailure` is P3, and process/cache state is P5. Existing version
0.6 authority boundaries remain valid; new classification is additive.

`pendingNeeds` applies only to dependent judgments. Independent needs still
collect and compile; source-text fallback never satisfies a CALLS requirement.
`observed` means selected observations were included, **not** task completion,
whole-call-graph completeness or Lode semantic acceptance. CLI interrupts and
MCP cancellation/connection close settle after the owned worker terminates.

Read [Architecture](architecture.md) and [Authority planes](authority-plane-contract.md) before changing this contract. Release-specific evidence remains documented in [Release observation](release-observation.md), per-target delivery history in [Delivery state observation](delivery-observation.md), and exact task inclusion in [Context Compiler](context-compiler.md).

Status: implemented provider-neutral P3 evidence grammar and P4 projection.

## Boundary

The common contract standardizes evidence shape, lineage, coverage, replay, and authority without standardizing product vocabulary. An `ObservationTypeDescriptor` declares only a closed bounded payload schema. It cannot declare a Feature, policy, success condition, causal relation, tool route, or product meaning.

An adapter supplies an exact `ObservationSourceBinding` and bounded input. Core creates an immutable `ObservationRecord` plus one `ObservationCollectionReceipt`. Deterministic computation over exact source records creates a separate `DerivedObservationRecord`; it never rewrites an observed fact.

Credentials, provider sessions, process IDs, sockets, and source cursors remain Host-local. Only credential reference names may appear in the binding, and they are not copied into observation records. Replay identity is scoped to the exact adapter key, adapter version, source-scope digest, and source-event-key digest. Identical replay inside that binding converges on the same record, while divergent content fails closed. Independent source bindings may reuse an upstream event key without colliding.

Core publishes each create-only Observation artifact with an atomic same-directory hard-link commit. Concurrent writers therefore cannot replace an existing replay key: identical content converges, while a losing divergent writer stops before creating its receipt. A receipt is written only for the record identity that actually won or already existed, so later readers never inherit a record/receipt split-brain. This process-safe storage fence adds no ingestion approval or semantic judgment.

## Coverage and graph

Coverage is explicit: complete, sampled, partial, or unknown. Complete coverage is accepted only when a bounded enumeration supplies a query digest, equal examined and source totals, and zero omissions. An adapter cannot claim completeness from a sample.

The rebuildable common `ObservationStatusProjection` creates `CONFORMS_TO`, `EVIDENCED_BY`, and `DERIVED_FROM`. It does not infer impact, motivation, measurement, ownership, success, or Feature links. The delivery specialization may additionally add `AT_REVISION` only after verifying an exact retained World `FileRevision`; declared revision strings receive no such edge. Product interpretation belongs to a Lode-authored `ProductHypothesis` or the existing review-gated candidate flow. `ProductSignal` remains available for lossless human/source statements; it is not manufactured from arbitrary payload fields.

Release evidence is a strict specialization, not a replacement by the generic adapter. `BranchStateObservation`, `DeploymentResultObservation`, and `ReleaseObservation` preserve their exact Git reachability, approval, commit, ref, and lineage checks.

Per-target delivery history is another thin specialization. It reuses the common immutable record and receipt, derives current state from explicit sequence/predecessor evidence rather than receipt time, leaves conflicts unknown, and never infers completeness for unobserved targets. It adds no deployment engine or approval gate.

Because a verified `delivery.state` record grants the graph-specific `AT_REVISION` proof label, that type is reserved to the dedicated delivery writer. Generic ingestion and registered generic adapters reject it instead of trusting a self-asserted binding. This does not close custom Observation types or add a human confirmation: it keeps the mechanically elevated claim behind its exact same-Project World/revision verifier.

## Host adapter SDK and reference file adapter

`ObservationAdapterRegistry` is a process-local P5 Host registry. It binds an adapter instance to one exact ready Lode Project, `ObservationSourceBinding`, and `ObservationTypeDescriptor`, then delegates collection through the same Core verifier used by structured Host input. The same source alias may be used independently in different Projects, but its opaque source ID and collection remain Project-bound. Registration has no arbitrary Core source-count gate. Its non-persisted P4 discovery view returns at most 64 sources per page, supports exact type/adapter/availability filters, and exposes an opaque cursor bound to the current filtered registry projection. A stale cursor restarts at the first page with explicit resynchronization metadata because source discovery has no authority or mutation effect; collection still revalidates the exact current Project and source ID. The registry, source aliases, source paths, credentials, cursors, provider identities, and polling state are never written into the project. Core never discovers or dynamically loads project adapter code; only a trusted Host composition may register an adapter instance.

Each source projection includes a bounded descriptor-shape summary: type/version, forms, and at most 16 field key/type/required triples with an omission count. A Host may attach only a bounded operational availability state (`unknown`, `ready`, `auth-missing`, `rate-limited`, or `unavailable`), timestamp, retry timestamp, and stable reason code. These hints are P5 operational evidence with false semantic authority. They cannot rank product relevance, establish freshness sufficiency, or become instructions.

Product-specific adapters own authentication, API queries, pagination, rate limits, webhook acknowledgement, and cursor storage outside Core. They normalize one bounded result into the common contract; Core persists only the verified P3 record and receipt. Missing optional adapters do not block Lode, and adapter output cannot assign product meaning.

`JsonEventFileObservationAdapter` is the provider-neutral reference for CI or webhook spool integration. It opens one regular, non-symlink JSON file from an absolute Host path, verifies the opened file identity, enforces a 512 KiB read bound, and hashes the raw event key and full evidence before collection. The source path, raw event key, source alias, and credential reference names are not persisted. The event file contains only the product-shaped event:

```json
{
  "schemaVersion": 1,
  "eventKey": "build-42",
  "subject": { "type": "example.ci.target", "key": "app" },
  "form": "event",
  "temporalScope": {
    "observedAt": "2026-09-01T01:00:00.000Z",
    "start": null,
    "end": null
  },
  "coverage": {
    "state": "complete",
    "basis": "enumerated-bounded-query",
    "queryDigest": "<sha256>",
    "examinedCount": 1,
    "sourceReportedTotal": 1,
    "omittedCount": 0,
    "cursorStartDigest": null,
    "cursorEndDigest": null
  },
  "payload": { "succeeded": true }
}
```

The advanced one-shot Host configuration supplies the binding, descriptor, and absolute event path. `sourceKey` is optional and is derived from the exact binding and descriptor when omitted:

```json
{
  "binding": {
    "adapterKey": "head.json-event-file-observation",
    "adapterVersion": "0.1.0",
    "sourceScopeDigest": "<sha256>",
    "credentialReferenceNames": []
  },
  "descriptor": {
    "typeKey": "example.ci.build-result",
    "typeVersion": "1.0.0",
    "forms": ["event"],
    "payloadSchema": {
      "fields": [{ "key": "succeeded", "type": "boolean", "required": true }],
      "additionalFields": false
    }
  },
  "eventFile": "<absolute-host-path>"
}
```

Run `observation-file-ingest` only from a trusted Host/CI integration. It intentionally has no MCP file-path surface: normal conversational use should call a configured Host integration rather than ask the model or user to compose paths and provenance JSON. The reference adapter is one-shot and does not provide a daemon, scheduler, remote connector, or automatic product interpretation.

## Conversational configured-source flow

A trusted Host composition passes its Project-bound registry to `serveMcp`. After provider Lode selects one exact required `typeKey`, `lode_observation_prepare` performs the read-only reuse-first flow: it queries current exact Observation IDs, then returns matching configured source IDs without selecting or collecting one. When existing evidence is not semantically sufficient and durable current evidence is actually needed, Lode pages or filters `lode_observation_sources` as necessary and calls `lode_observation_collect_source` with one selected ID:

```text
trusted Host configuration
  -> lode_observation_prepare(exact Lode-selected typeKey)
  -> existing exact Observation IDs first
  -> lode_observation_sources only for paging or diagnosis
  -> opaque Project-bound sourceId
  -> lode_observation_collect_source
  -> verified P3 ObservationRecord + ObservationCollectionReceipt
```

The preparation projection does not judge semantic sufficiency, infer relevance from lexical overlap, select a source, or persist anything. Provider Lode performs that judgment in the conversation. The model and user provide no file path, credential reference, binding, descriptor, digest, coverage claim, provider identity, or source alias on this path. Core verifies Project readiness before the adapter may access its source. Missing Host composition is disclosed as optional adapter unavailability; it does not fall back to user-authored provenance or weaken the common contract. An embedding Host may use the same injected registry with the advanced CLI composition, but the ordinary standalone CLI does not load adapter code or configuration dynamically.

## Metric evidence workflow

The metric workflow is a thin provider-neutral use of the common contract, not a second analytics store. `lode_metric_define` registers a versioned metric shape containing its unit and desired direction. An exact replay is idempotent; a conflicting shape under the same metric key and version fails with a request to use a new version instead of making later lookup ambiguous.

`lode_metric_observe` records an exact subject, value, time scope, source scope, sample size when known, coverage, and collection-adapter identity. If a Host retries the same event without resupplying an observation time, Core reuses the durable event time; changed content under the same source event still fails closed. `lode_metric_compare` permits a numeric difference only for the exact same descriptor, subject, unit, and direction. Different adapter key, adapter version, adapter descriptor digest, source scope, snapshot/aggregate form, period duration, sample size, or coverage state does not add an approval gate: the numeric comparison remains available, but the result marks the condition as same, different, or unknown, states that no normalization was applied, and downgrades derived coverage rather than presenting a like-for-like result. Even when every recorded collection condition matches, Core reports only `recordedCollectionConditionsEquivalent: true`; semantic equivalence remains `not-assessed` and is never mechanically inferred.

`lode_metric_assess` records only a P3 ProductHypothesis and always states that causality is not established. A follow-up uses `lode_product_initiative_propose` with the exact assessment hypothesis ID; there is no separate metric formatter. It creates only a Product Initiative candidate, which still needs the existing explicit user review before approval. `lode_metric_status` and `lode_metric_trace` are bounded read-only P4 views. None of these operations writes Product Canon, a ReviewDecision, Conformance disposition, or P2 recovery direction.

## Context and use

### Committed metric evidence and derived World updates

Metric define, observe and compare retain their exact committed primary IDs even
if the subsequent World projection fails. A healthy `worldModel` keeps its
existing `worldModelId` and `graphSnapshotId`. Only a post-commit projection
failure returns `worldModel: {status: "deferred", reasonCode,
ordinaryWorkBlocked: false}` alongside the original saved result. The bounded
code discloses no raw error message, path or stack.

Deferred means the derived update did not complete, not that a retry is queued
or that it wrote no derived bytes. Completed evidence need not be re-created or
force-refreshed. Validation, identity/digest, permission, primary publication,
and incomplete observation/receipt or descriptor/comparison transactions remain
errors. Exact retry keeps its existing convergence and observed-time reuse;
neither a retry nor a World view grants Product or recovery authority.

### Optional Python declaration reads

The user asks for the task once; Lode chooses how to inspect it without requesting
JSON, digests, IDs, parser or budget choices. Keep ordinary file reads or an
already-current World range read when sufficient; no Context workflow is needed
just because the file is Python or a declaration name is known. Lode may choose
selected-source for useful narrow evidence, exact declaration boundaries or
task-scoped Context inclusion, without a per-call benchmark, justification form
or approval. Once chosen, read a known unique name directly; outline is optional.
Within this workflow, `source` includes file text in Context and is suitable for
small files or whole-file context; it is not synonymous with ordinary file reading.
Outline plus selection can cost more than one file read. Count World construction
separately if needed; ordinary World ranges may include trailing lines and do not
create a Context Capsule. These outputs do not establish universal performance superiority.

When parsing is unavailable, fails, or evidence drifts, Lode can re-query or
continue ordinary reads without pretending that exact boundaries or Context
inclusion were verified. Never reuse stale selection coordinates. Independent
work continues; ask only about unresolved user intent or existing authority
boundaries. Report results and meaningful limitations, not every internal state
or a repeated menu of lookup choices.

For a local developer comparison, run
`node scripts/measure-python-declarations.mjs --output <new-absolute-directory>`.
It records three fresh-process trials, in-process repeat queries, individual
values and medians, raw dispatch responses, correctness and process logs. Fresh
process does not mean cold OS cache. Fixed execution order and instrumentation
affect latency; serialized in-process dispatch bytes are not stdio wire or
installed Host cost. Provider tokens, billing and prompt-cache savings remain
unknown. This measurement is optional, not a usage or deployment gate.

The existing `lode_source_context` accepts `declarations` for a bounded static
outline and `selected-source` for a known qualified declaration. The latter needs
no prior outline. CLI uses `--kind`; an unqualified `--symbol` option retains its
existing outgoing-call meaning. For ambiguous occurrences, Lode supplies the
returned exact selection through typed MCP or advanced CLI `--input` needs.
Lode authors that structure in normal conversation; explicit advanced API/CLI
requests remain supported.

New declaration Context details include a compact `collectionProfile`: producer,
Python version, protocols and implementation digests, even without retention.
Failures expose the same summary when worker identity was already obtained.
It describes the attempted parser, not successful parsing or runtime truth;
missing identity is not invented. No full file, raw worker frame or executable
path is added to the public response. Existing v1 details remain unchanged.

The parser remains isolated stdlib AST/tokenize. No project module executes. A
selection binds path, digest, qualified name, declaration kind, occurrence and
UTF-16 end-exclusive range. Source spans preserve decorators and internal bytes;
display signatures are separate lossy labels. The bounds are one 1 MiB source,
64 list entries, 500 display characters, and 60,000 serialized detail bytes within
the existing 65,536-byte Observation field. A selected body over 48,000 bytes is
explicitly unavailable rather than silently cut; JSON escaping can reach the
detail limit earlier. These are response bounds, not semantic eligibility or a
requirement to perform an outline. Ordinary source/range inspection stays usable.

Historical `source.structural-context` with evidence version 1 is unchanged.
New `source.python-declaration-context` records use type version 1 and evidence
version 2 via explicit dispatch; the same create-only store is reused. Historical
records are not migrated or rehashed. New retained records are also checked for
source drift before Context inclusion. Default retention remains off; no Canon,
World, ReviewDecision or recovery direction is created by these optional reads.

Context compilation excludes common observations by default. Lode performs semantic analysis and requests exact identities through an EvidenceNeed whose kind is `observation` and whose `observationIds` are immutable current IDs. Core preserves selected evidence, exclusions and uncertainty without an inclusion-proof gate, lexical eligibility rule, semantic promotion or sufficiency judgment.

Ordinary inspection remains ephemeral. Persist an Observation only when cross-Run, rebuttal/audit, handoff, or context-loss evidence is required. A Host adapter, not the user, constructs the exact source binding, descriptor, digests, coverage, and provenance confirmation. `observation-ingest` and `lode_observation_ingest` are advanced Host/CI surfaces for already bounded input. The redundant collect compatibility alias is removed. `observation-source-collect` and `lode_observation_collect_source` remain distinct configured Host-source collection surfaces, not aliases for ingesting already bounded input.

`observation-query` and `lode_observation_query` return both an unfiltered `inventorySummary` (all retained counts and graph policy) and a filtered page, without full payload nodes. No separate status call is needed. `inventorySummary` is not the filtered match count; an empty page cannot establish that the retained inventory is empty. Queries filter exact current identities by type, subject, source, time, and observed/derived kind with a maximum page of 100. Cursor continuation is bound to the exact current `ObservationStatusProjection`; drift fails closed. Query results contain payload digests rather than payload bodies. The exact read surface returns the selected record, descriptor, and bounded receipt or derivation lineage. Querying is discovery, not semantic selection, Context eligibility, or sufficiency judgment.

## Acceptance properties

- unrelated product domains use the same contract without domain vocabulary in Core;
- independent source bindings may reuse the same upstream event key, while divergent replay inside one exact binding fails closed;
- concurrent identical writers converge and concurrent divergent writers retain exactly one record with exactly one matching receipt;
- observation writes leave Product Canon and Session recovery bytes unchanged;
- Product Signal and other unrelated operating flows do not load or depend on unused Observation storage;
- false completeness, schema drift, authority drift, and divergent replay fail closed;
- status and query output stays bounded and never turns discovery into semantic selection;
- default Capsule compilation includes no common observation, even with lexical overlap;
- an exact Lode EvidenceNeed includes only the named immutable records;
- derived records and projections cannot add semantic graph relations;
- a hypothesis may reference exact observations while remaining non-authoritative;
- CLI and MCP return the same Core identities.
- the Host registry remains non-persisted P5 configuration, while its verified result uses the same P3 identity and replay contract;
- source registration is not blocked by the bounded status projection, and omitted status entries are disclosed;
- exact source filters and opaque pagination make every registered source discoverable without unbounded output;
- stale source cursors restart with explicit non-authoritative resynchronization rather than creating a user-visible recovery ritual;
- source shape and availability summaries stay bounded, non-semantic, non-instructional, and non-persisted;
- reuse-first preparation returns existing exact Observation IDs before matching configured sources and never judges sufficiency or collects automatically;
- every registered source ID is bound to one exact Lode Project and cannot be collected into another Project;
- Project readiness is verified before external adapter collection;
- the conversational source flow accepts only an opaque configured source ID and never asks the user for provenance structure;
- the reference event-file adapter accepts unrelated product schemas without persisting Host paths, raw event keys, source aliases, or credential references;
- the reference file path stays outside MCP, and malformed, oversized, relative-path, or divergent events fail closed.
- the same metric key and version cannot acquire two definitions, while a new explicit version remains available;
- numeric before/after comparison remains usable across disclosed adapter-revision and collection-condition differences without claiming semantic equivalence, normalization, or causality;
- metric assessment and follow-up stay P3 evidence/candidates and do not mutate Conformance, Product Canon, or P2 recovery.
- delivery failure never overwrites prior applied state, rollback remains a new immutable event, and conflicting order stays unknown;
- exact delivery revision bindings are verified before persistence and connected in P4, while declared-only references remain disclosed and unlinked;
- delivery status is bounded and cannot infer success for unobserved targets or deployment completeness.
