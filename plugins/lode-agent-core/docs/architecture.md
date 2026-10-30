# Architecture decision

## Adopted shape

The plugin is organized as thin provider distributions around a provider-neutral core:

```text
.codex-plugin/plugin.json
  -> skills/lode-agent-core       human/agent operating contract
  -> .mcp.json                    read-only inspection surface
  -> scripts/lode.mjs             explicit mutation entrypoint
       -> scripts/lib/lode-core   project canon and projections
       -> scripts/lib/session-routing independent logical Session routing
       -> scripts/lib/project-direction common current user direction
       -> scripts/lib/project-graph bounded graph-first discovery
       -> scripts/lib/context-compiler
                                  versioned task Context Capsules
       -> scripts/lib/execution-lineage
                                  content-derived lineage artifacts
       -> scripts/lib/run-lineage contract-bound Run state transitions
       -> scripts/lib/product-model user-owned product-intent canon contract
        -> scripts/lib/onboarding project-scoped bootstrap, candidate, review, and promotion state machine
             -> scripts/lib/onboarding-contract Session, storage, and state-pointer identity contract
             -> scripts/lib/onboarding-projection immutable onboarding artifact validation and graph input
       -> scripts/lib/compute-adapter backend-neutral compute and WorkerProtocol contract
       -> scripts/lib/world-model incremental repository view
            -> scripts/lib/semantic-graph evidence-linked semantic projection
            -> scripts/lib/temporal-provenance immutable revision DAG and bounded traversal
            -> scripts/lib/git-history replaceable Git evidence source
            -> scripts/lib/runtime-state replaceable runtime evidence source
            -> scripts/lib/world-model-store replaceable storage contract
```

Claude Code, Codex, and OpenCode are projections of the same `.lode/` authority. They do not own separate project truth.

Small lower-level boundaries keep record consumers out of effect orchestration:
`session-paths` supplies path confinement to routing and common direction;
`product-policy-records` supplies immutable Policy verification/readers to graph
projection; `runtime-invocation-storage` owns exclusive artifact publication;
and `worker-patch-proposal-contract` supplies proposal verification without
runtime launch. Existing public modules reexport their prior contracts. These
cuts preserve record identities and authority; other World/refresh/operating-loop
dependencies remain and no runtime-speed improvement is claimed.

The source tree remains the directly runnable Core. CI creates independent,
content-verified `lode-codex-marketplace` and `lode-claude-marketplace` branches
for new Lode installations, while continuing to publish the existing HEAD
identities on `codex-marketplace` and `claude-marketplace`. Each branch contains
one plugin and its single vocabulary; no installation is migrated or registered
twice. CI uses the same allowlisted distribution and overlays one five-platform, version- and
commit-bound native bundle assembled from the verified build matrix. Runtime
selection is exact-host and integrity-gated; the other targets remain inert
distribution bytes. Claude's generated branch adds only the catalog, plugin
manifest, and `${CLAUDE_PLUGIN_ROOT}` MCP cache-path projection required by
Claude Code. Distribution metadata, native binaries, and cache paths cannot
alter Core identity, Product Canon, Session/Run recovery, or any authority plane. See
[`codex-marketplace.md`](codex-marketplace.md) and
[`claude-marketplace.md`](claude-marketplace.md).

## Constitutional core and optional profiles

The stable normative root is the small provider-neutral Lode constitution in
[`lode-constitution.md`](lode-constitution.md). P1-P5 is its executable internal
type system, not a mandatory user ceremony. The public initialize/resume
transaction exposes two profiles without creating separate project identities:

- `core` preserves the canonical Project, selected logical Session, provider
  projections and eligible existing-observation index by default;
- `product` explicitly activates or resumes evidence-linked onboarding and the
  Product/World/Graph governance path.

Both profiles use the same Core transaction, Project identity, Session identity,
managed-install convergence, and authority contracts. Core resume never deletes
or silently refreshes an already active Product profile. Onboarding input is
rejected unless `product` is selected explicitly. Provider adapters may expose
different optional capabilities, but no adapter may redefine these semantics.

`profile` is therefore an operation choice, not persisted project mode. The
read-only `LodeProjectExperienceProjection` reports Core readiness and Product
readiness independently, chooses one actionable next step, and discloses the
preconditions for Context compilation, durable Runs, bounded workers,
compaction recovery, and provider invocation. It is bounded, non-persisted, and
authority-free: inspection cannot activate a capability, repair a managed file,
create a Run or ReviewDecision, consume a lease, or write recovery direction.
CLI `status`/`doctor` and MCP `lode_project_status` return the same projection.
The verified onboarding status remains embedded so friendly guidance never
replaces the canonical state machine.

The same projection exposes `readiness.recovery` as factual, read-only guidance.
`no-current-checkpoint` keeps ordinary Session work available,
`verified-current-checkpoint` means artifact-only restore succeeded, and
`attention-required` discloses that only the affected recovery path needs
repair. Reading this field cannot consume compaction continuation, attach a
provider, or write P2 direction.

Conversation entry composes that same verification through read-only
`lode_conversation_enter` and returns bounded project-status, unified Attention,
package-version, and presentation projections in the same call. These P4-style
views add no stored queue or gate: `userDecisionRequired` is reserved for a
protected user decision, `headActionRequired` assigns internal follow-up to
Lode, and each item lists the affected operation while ordinary work remains
available by default. Pending optional Product work is marked
`when-product-governance-is-in-scope`; its existence alone cannot turn entry
into an immediate user decision. A separate optional P5
`CompactionLifecycleHostAdapter` can deliver journaled pre/post-compaction and
provider-replacement events, retain the raw continuation token outside project
Canon, and report only a bounded provider outcome. Core restores P2 before any
verify or continuation action. The adapter cannot carry provider-session
identity or author recovery, instruction, review, promotion, or Product Canon;
its absence is a non-blocking capability gap, not a project-readiness failure.

## Common direction, Sessions and discovery

One canonical Project carries current common user direction. Independently routed
Sessions preserve their own purpose, progress, checkpoints and active/unknown work.
Request-local routing retains `.lode/sessions/current.json` as the default record;
additional Sessions use `.lode/sessions/by-id/<session-id>/current.json`. A logical
Session identity is not a provider session ID. Project-scoped onboarding keeps its
original review lineage.

`ProjectDirection` is P2 current user direction: immutable revisions behind
`.lode/project-direction/current.json`. Exact-basis compare-and-swap prevents
timestamp/last-writer replacement. Restore preserves the historical checkpoint's
exact fields while exposing current common direction separately; it cannot undo
a later shared constraint or cancelled action. The record grants no execution
authorization.

`lode_project_graph` queries a bounded P4 observation index and optional retained
World layer. Work and Product views reference common originals. Results retain
basis/revision, integrity, freshness, coverage, provenance and candidate/rejection
state through relation expansion. Intact history remains readable; damaged layers
are excluded independently. Empty/partial coverage is not absence. Same-basis
results and known failures can be reused. Graph/adapter loss returns original-source
fallback without a full-World-current, Product-review, Run/Capsule, index-completion
or database gate. Index updates reuse unchanged input; reads publish no checkpoint,
approval, candidate or per-read receipt. Effects recheck current sources and
authority. See [project discovery](../skills/lode-agent-core/references/project-discovery.md).

Direct, ordinary Host and managed execution are choices of means. Managed work
may serve a new useful durable outcome; file edits, worker count and ordinary
failure do not force it. Fork/fresh selects context independently without an
approval, isolation or cache guarantee.

## Onboarding authority plane

Initialization preserves the default Session and dormant onboarding pointer,
updates the existing-observation index independently of provider conversations,
and builds the governed local World Model only through explicit `product` scope. A structured user brief may
directly seed candidates; otherwise a fresh provider Lode authors a bounded
semantic proposal from current evidence. The JavaScript Core validates exact
SourceSnapshot, path, digest, line, optional symbol, Product Model references,
and bounds before presenting one immutable batch. Core performs no lexical
product inference, and the proposal has no instruction or promotion authority.

Only an explicit user-authored `ReviewDecision` with `decisionScope: product-canon-bootstrap` may create a Product Canon revision. The CLI and typed `lode_onboarding_review` operation delegate the same exact-candidate checks to Core; neither routing nor discovery supplies user approval. Acceptance records previous and next Product Model hashes, rebuilds a child SourceSnapshot, and verifies the temporal GraphSnapshot before the state pointer becomes ready. Revision creates a successor candidate set; rejection leaves canon unchanged. Immutable candidate, Evidence, Unknown, ReviewDecision, and ProductModelRevision receipts are projected into the graph for audit, but the projection cannot decide or promote. Read-only status and graph operations cannot review or promote.

Storage selection defaults to the complete local path. A GraphDB endpoint, database, and environment-style secret-reference names can be recorded as pending operational configuration, but credentials are rejected and no remote success is claimed before an adapter passes conformance. See [`onboarding.md`](onboarding.md).

## Why the old runtime is not embedded

The original implementation binds project authority to a live Herdr pane and OpenCode session, installs POSIX services, and uses Unix-oriented paths and process assumptions. Copying that runtime into a Codex plugin would falsely advertise cross-platform support and weaken its cleanup/fencing invariants.

The runtime layer keeps `PlatformAdapter`, `AgentRuntimeAdapter` and
`WorkspaceHostAdapter` boundaries. Capability observation never grants execution
authority. Managed invocation retains at-most-once ownership, scope, cancellation
and cleanup; ordinary Host delegation uses existing Host controls without Lode
role tokens, generations, inboxes or target chains. Current user direction and
unknown actual effects remain preserved.

An optional endpoint attachment restores P2 first and uses the current Host
snapshot and process-ownership proof. The portable export bridge retains one
current snapshot, not a delivery mail service. Host loss falls back to the same
canonical logical Lode. Earlier live role-message tests are historical evidence,
not validation of this simplified path. Provider resume/stream and host-specific
pane/socket/TUI translation remain outside Core.
See [runtime adapters](runtime-adapters.md).

## File ownership

`.lode/` is plugin-managed canon. Root `CLAUDE.md`, `.mcp.json`, `AGENTS.md`, and `opencode.json` remain independently owned projections: absent files may be generated, existing project-owned files stay intact and alternatives remain under `.lode/generated/`. A verified Claude plugin MCP connection avoids a duplicate project configuration. Packaged clients use `node`, project-relative `scripts/mcp-server.mjs` or placeholders (`${CLAUDE_PLUGIN_ROOT}`, `${PLUGIN_ROOT}`, `{env:LODE_PLUGIN_ROOT}`). Standalone Claude initialization can use a verified local launcher or exact absolute package entry. These paths are machine-local; they do not embed an absolute Node binary. See [runtime launch paths](runtime-adapters.md#startup-guidance-and-claude-file-ownership).

The managed manifest records SHA-256 digests. Canonical mutation stops when managed drift is detected.

## Context Compiler plane

The Context Compiler sits between canonical project knowledge and Lode execution. It compiles a bounded, reproducible `ContextCapsule`; it does not become a second authority.

The `ContextWorkflowProjection` is non-persisted P4 advice over selected context.
It exposes sources, omissions and uncertainty for Lode assessment, not inclusion
proof or fixed token tiers. One preview makes one selection; Lode may inspect
original evidence or expand a useful anchor. It never authorizes execution,
invokes a provider or writes recovery direction.

The same workflow includes a non-persisted `ContextExplanationCard` that groups
included evidence by kind, summarizes intentional omissions by the Compiler's
existing reason codes, and states remaining uncertainty. It explains an
existing Capsule result; it neither adds an EvidenceNeed nor changes selection,
budget, semantic-sufficiency ownership, or authority.

The preceding `ContextPreparationProjection` returns selected context from the exact
user task without another required tool round trip. Missing/stale World is
disclosed while direct current source remains usable. Optional Lode guidance is
verified against its exact source binding; lexical ranking is not a semantic
decision or a candidate-eligibility gate.

```text
Canonical sources -> Snapshot -> Lode EvidenceNeeds -> verified packing/budget -> ContextCapsule -> Lode/Executor
       ^                                                        |
       |             verified candidate knowledge               |
       +--------------------------------------------------------+
```

The world model and capsules are materialized views. They must be rebuildable from evidence and project canon. `Snapshot`, `Evidence`, `Claim`, `Decision`, `Unknown`, and `ContextCapsule` are the semantic boundary; storage technology remains replaceable.

Compiler unavailability is an adapter-level fail-open condition. Identity drift, canon drift, invalid knowledge, or Capsule digest mismatch is a core fail-closed condition.

## Execution Lineage plane

Execution Lineage turns a Capsule into an auditable whole-plan loop without relying on a provider conversation as authority.

```text
WholePlanSnapshot
  -> ExecutionContract + ContextCapsule
  -> Executor
  -> ResultPacket
  -> ReviewDecision
  -> accepted result or refined WholePlanSnapshot
```

Each artifact has a content-derived identifier, digest verification, and typed `LineageLink` parents. `ResultPacket` evidence is explicitly non-instructional. A Fresh Lode reconstructs review context from these verified artifacts rather than resuming a hidden model session.

Artifact-only Session restore now reconstructs the current consumer input from
the exact content-addressed `SessionRunCheckpoint`, immutable Session pointer,
and verified Run/plan/contract/Capsule lineage. The returned
`SessionRestoreProjection` is non-persisted P4 and does not use provider session
identity, transcript, summary, resume, or stream. After an accepted Fresh Lode
ReviewDecision, a separate one-shot operation may bind the reviewed Run to a P2
checkpoint whose recovery fields are explicit Lode/user input; ResultPacket and
historical P3 integration receipts cannot author or replace that direction.
New integration stores the exact accepted lineage in the checkpoint itself,
without separate request or receipt files. See
[`session-recovery.md`](session-recovery.md).

Provider-neutral launch-wave visibility is a separate P3/P4/P5 composition over
existing HF-009 dispatches. A `BoundedWorkerWave` cannot create or widen an
authorization; an explicit seal requires every independent lease consumption;
status/results remain P4 views and wait remains P5. Members retain individual
authorization, lease and result evidence. For a multi-worker Run, Lode assesses
the combined result and publishes one whole Run ResultPacket; Fresh Lode review,
an explicit ReviewDecision and explicit HF-010 checkpoint integration follow
for that whole result, not independently for every member. Wave completion
performs none of those transitions. See
[`bounded-worker-wave.md`](bounded-worker-wave.md).

Checkpoint freshness uses a non-persisted read-only basis over the exact current
P2 identities and Run/compaction transition state. Provider Lode derives the
natural-language direction; Core only revalidates that basis under the existing
mutation lock and creates, reuses, defers, or conflicts the checkpoint publish.
Identical retry has no extra ledger or pointer write. P3/P4/P5 never author the
direction, open compaction is not replaced, and accepted-result binding remains
exclusive to the existing reviewed-Run integration transaction. See
[`session-recovery.md`](session-recovery.md#freshness-gated-checkpoint-synchronization).

Checkpoint diagnosis is a separate non-persisted P4 projection over two verified
basis reads with artifact restore between them. It exposes pointer presence,
restore verification, mechanical sync availability, and the next Lode action,
without caching, locking, repairing, or invoking a model. Stable identity does
not prove semantic freshness; sequential reads are not an atomic snapshot and
cannot detect ABA. Integrity failure, required-reference drift, pointed-artifact
loss, and optional P3 ResultPacket loss remain distinct. Project readiness and
conversation entry reuse this contract when recovery has a current pointer; the
no-pointer fast path stays a cheap ordinary-work fact. CLI and typed MCP expose
the full diagnosis on demand.

Version 0.3 alpha binds Runs to verified contracts, converts completion into a ResultPacket, builds a deterministic minimum Fresh Lode review projection, and requires that exact projection for the manual Lode ReviewDecision. `revise` and `expand` require a ReviewDecision-linked next WholePlanSnapshot before another Run. Candidate knowledge and Lode recommendations remain authority-free. Exact optional WorkspaceHost attachment is active only after P2 restore; general provider resume/stream, broader runtime controls, and authorized knowledge-promotion surfaces remain deferred.

## Repository World Model plane

The World Model materializes supported repository files, heuristic symbols, dependencies, imports, and resolvable calls as content-addressed evidence. An optional provider-neutral `SourceRelationEvidenceAdapter` may add language-AST `IMPORTS` and `CALLS` evidence bound to the exact current file manifest; Core preserves its analyzer, source, and confidence separately instead of replacing the heuristic fallback. Hot is the current snapshot, Warm is the pointer's change summary, and Cold is the retained prior snapshot set.

`WorldModelStoreAdapter` separates World Model persistence from semantic snapshot identity. The snapshot contains only the invariant rebuildable-storage contract; the pointer records the active adapter descriptor. The local JSON adapter is active, and an in-memory conformance test proves that the same canonical inputs produce the same World Model ID through a different adapter.

`IncrementalRefreshRequest` and `IncrementalRefreshReceipt` establish observed-state refresh after explicit indexing. Refresh rediscovers and byte-hashes every eligible file, reuses verified analysis only for digest-identical files, and must produce the same `RepositoryScanResult` as the full reference path. An actual change automatically makes the verified current SourceSnapshot a parent, preserves unchanged revision identities, parents changed revisions to their previous current revision, validates graph materialization, and advances the World Model pointer only after the preview identity is fixed. Active Runs retain their exact Capsule and contract; the receipt records drift and the required explicit Lode choice. Product Canon and reviewed relationships are not mutated. See [`incremental-refresh.md`](incremental-refresh.md).

`RefreshTriggerBatch` and `RefreshTriggerDeliveryReceipt` add the next ingestion layer. A foreground recursive filesystem watcher and a strict CI event-file adapter feed one bounded debounce queue. Paths remain non-authoritative hints: every delivery invokes the same complete refresh scan. Accepted events are canonically sorted, duplicates and excluded/overflow observations are counted, `.lode` events do not self-trigger, and a project-scoped exclusive writer lease serializes manual, filesystem, and CI refreshes before the existing pointer comparison. Trigger artifacts have no instruction, promotion, or canon-mutation authority. See [`refresh-trigger.md`](refresh-trigger.md).

`GraphProjectionAdapter` is the separate graph materialization and traversal boundary. The embedded temporal GraphSnapshot remains the recoverable source; local JSON, in-memory, and explicitly activated ArcadeDB adapters preserve identical GraphSnapshot and TraversalResult identities, reject authority escalation and stale/tampered projections, and disclose embedded-graph fallback when no materialization exists. `PreparedTraversalRequest` binds an already-fixed query and result to exact bounded expansion evidence. ArcadeDB can verify that radius from a pointer and topology manifest without full query-time reload. Topology-manifest and bounded-traversal reads share one query-only exact-child batch after independent pointer inspection. The JavaScript bridge is the reference transport; an integrity-verified Go bridge is selected from the native distribution when present, while all semantic and authority verification remains in JavaScript. ArcadeDB vertices, edges, transport output, and receipts remain derived evidence and cannot own unique authority. See [`graph-projection-adapter.md`](graph-projection-adapter.md).

Prepared-traversal performance evidence keeps two planes separate. Canonical UTF-8 payload-component sizes form reproducible, content-derived cost evidence; elapsed time, cache state, transport calls, and normalized observed response sizes are operational diagnostics only. The live benchmark can use only an already verified activation and exposes no mutation method, so measuring GraphDB cannot advance pointers, create schemas, or alter authority.

`DocumentProjectionAdapter` is the separate human-view boundary after the verified graph. The deterministic Markdown reference renderer emits content-derived `DocumentProjection` artifacts and a replaceable published view under `.lode/generated/knowledge`; local and in-memory adapters must preserve identical document content and projection identity. Explicit generation remains available. A separate safe-default-manual `PostRefreshProjectionPolicy` may enable automatic publication only for an unedited view after verified refresh, while immutable receipts bind policy, refresh, graph, projection, and candidate evidence. Published drift is never overwritten: current edits become an immutable `DocumentChangeCandidateSet` with no canon, instruction, or promotion authority. A scoped explicit review may accept candidates only with a complete user-supplied Product Model, rebuild a verified child GraphSnapshot, and reconcile Markdown, or reject them without canon mutation. Candidate sets, reviews, Product Model revisions, and application receipts are projected into later audit GraphSnapshots without acquiring authority; Obsidian and Notion remain deferred. See [`document-projection-adapter.md`](document-projection-adapter.md), [`document-change-review.md`](document-change-review.md), and [`post-refresh-projection.md`](post-refresh-projection.md).

The semantic graph uses content-derived node and edge identities, file digest and line evidence, explicit source/confidence labels, and `evidence-not-instruction` trust boundaries. Default coverage remains heuristic file containment, module imports, and resolvable JavaScript/TypeScript/Python calls. Optional AST relations are accepted only through a strict current-manifest adapter contract and remain P4 structural evidence without semantic, instruction, promotion, review, or recovery authority.

The Product Model source at `.lode/context/product-model.json` is user-owned canon. It defines stable FeatureGroup, Capability, Feature, Requirement, Constraint, and Decision keys independently from repository directories. Optional schema-v2 Policy records apply only to explicit Feature or FeatureGroup keys through immutable P3 candidates and an exact user ReviewDecision; group membership never creates inheritance, and the graph is not a second Policy store. Schema-v1 bytes and identities remain exact. A missing Product Model in an older initialized project is the explicit empty semantic model; code and documents do not silently fill it. See [`product-model.md`](product-model.md).

The temporal provenance graph is a separate verified projection so structural evidence identities are not silently redefined. Its traversal protocol has mutually exclusive `lexical-discovery` and exact-Lode-anchor modes. Exact mode binds current GraphSnapshot plus one to 32 node IDs and cannot widen relation, authority, freshness, confidence, depth, node, edge, or candidate policy. Context Compiler accepts exact anchors only inside Lode-owned EvidenceNeeds and emits separate `GraphTraversalEvidence`; it never promotes lexical search into semantic relevance. Product nodes and product relations remain `canon-projected`, candidate-space nodes remain hidden without explicit opt-in, and local or activated ArcadeDB projections preserve the embedded GraphSnapshot as the recoverable source. Policy approval paths remain linked to an unchanged current Policy revision across unrelated Product Model revisions; reviewed source changes and product impacts bind exact revisions, while Git refs alone never imply deployment.

Graph genealogy reuses retained content-addressed World snapshots instead of creating a second history store. `GraphLineageStatusProjection`, `GraphLineageTraceProjection`, and `GraphLineageDiffProjection` are non-persisted P4 views: they expose bounded Hot/Warm/Cold pages, exact or discovery traces, verified execution-artifact references, Policy-evidence byte currentness, and snapshot differences. They cannot write P2 recovery direction, invalidate an accepted Policy, or infer semantic continuity. Equal content digests across removed and added paths produce only `exact-content-possible-move` evidence; a semantic identity claim remains a separate Lode proposal and needs review only if it is promoted.

The provider-neutral common Observation boundary records domain-shaped data without teaching Core product vocabulary. `ObservationTypeDescriptor`, `ObservationRecord`, `DerivedObservationRecord`, and `ObservationCollectionReceipt` are P3; `ObservationStatusProjection` is a separate rebuildable P4 evidence graph and its verified nodes and relations are also projected into the unified temporal GraphSnapshot; `ObservationSourceBinding` is P5 Host configuration. A process-local `ObservationAdapterRegistry` binds optional source-specific adapters to one exact ready Project without persisting their paths, credentials, cursors, or provider identities. Its non-persisted discovery view provides exact filters, opaque pagination with disclosed read-only resynchronization, bounded descriptor shape, and Host-local availability hints without imposing a registration gate. `ObservationPreparationProjection` combines exact existing-evidence query and matching source discovery for reuse-first UX but never chooses meaning, sufficiency, a source, or collection. A Host-injected MCP composition collects only by opaque Project-bound source ID. `JsonEventFileObservationAdapter` provides a bounded one-shot CI reference without adding an MCP file-path surface. Automatic graph relations are limited to `CONFORMS_TO`, `EVIDENCED_BY`, and `DERIVED_FROM`. The metric workflow reuses these P3 records, exposes adapter-revision and other collection-condition differences without blocking numeric comparison, and keeps assessment as a non-causal ProductHypothesis plus an optional review-gated initiative candidate. Context Compiler includes an observation only through an exact Lode-owned EvidenceNeed; observation collection cannot create Product Canon, product meaning, a ReviewDecision, or P2 recovery direction. Invalid Observation lineage makes only that graph layer unavailable; unrelated World/Product work remains usable. See [`observation-adapters.md`](observation-adapters.md).

Non-blocking Conformance reconciliation lets provider Lode compare exact approved Canon with current source, ChangeSet, Observation, or optional Graph evidence. Core validates anchors and persists only P3 candidates, resolution candidates, and exact-Finding user dispositions; it performs no lexical or semantic verdict. Its paginated P4 queue and candidate-hidden audit graph cannot block ordinary work, authorize a fix, revise Canon, or write recovery. Missing Graph, partial coverage, optional adapter loss, and advisory risk remain disclosures. A process-local optional P5 trigger registry coalesces verified Host evidence and stops automatic replay after an uncertain provider outcome; default opportunistic use invokes no background provider. See [`conformance-reconciliation.md`](conformance-reconciliation.md).

`DeploymentResultAdapter` is a separate Host observation boundary. It supplies bounded deployment facts and evidence digests without persisting provider run/session/process identities. Core independently verifies reachable Git history and current product refs before recording create-only `BranchStateObservation`, `DeploymentResultObservation`, and eligible `ReleaseObservation` P3 evidence. Their P4 graph projection cannot authorize deployment, approve a product outcome, mutate Product Canon, or write P2 recovery direction. See [`release-observation.md`](release-observation.md).

## Native compute plane

`ComputeAdapter` contract `0.3.0` and WorkerProtocol `0.2.0` define a replaceable computation boundary without changing semantic identities or transferring authority from the JavaScript control plane. Canonical requests bind a versioned operation, input digest, semantic producer, and resource limits. Canonical responses are all-or-nothing, digest-verified, size-bounded, structured, and fixed to `authorityEffect: none`.

`JsReferenceComputeAdapter` remains the conformance oracle and local fallback. `GoWorkerComputeAdapter` verifies a content-addressed platform manifest, confines the executable to the plugin distribution root, launches it directly without a shell, bounds stdio and time, and verifies exact child-PID exit. Missing, incompatible, corrupt, unsupported, spawn-failed, or crashed native paths fall back to JavaScript with disclosed operational reason codes; invalid native responses, timeouts, and cancellation fail closed. A Go `repository.scan.v1` candidate now matches seven complete success/failure responses and identical corpus identities, including multilingual and Unicode evidence plus explicit include/exclude source scope. Comparative benchmarks regress on small and medium inputs and improve only marginally on a large input, so release manifests still advertise only `worker.health.v1`; production World Model scans remain on JavaScript. Compute-backed graph operations and a benchmark-justified native selection policy remain deferred. See [`compute-adapter.md`](compute-adapter.md).

`GitHistoryAdapter` separately supplies rebuildable, content-addressed commit evidence. The default asynchronous Git CLI adapter may fail open with explicit coverage when process launch is unavailable; a byte-preserving host-export adapter provides the same semantic input in constrained runtimes. Current refs validate reachability, and commit messages remain evidence rather than instructions or promoted decisions.

`RuntimeStateAdapter` supplies strict point-in-time external runtime observations. Its source descriptor is pointer metadata rather than semantic identity; normalized observations are content-addressed and freshness-gated. The adapter is read-only and grants neither instruction nor runtime control authority. Separate `PlatformAdapter`, `AgentRuntimeAdapter`, and `WorkspaceHostAdapter` references make provider/platform/host composition explicit. Current-host discovery, bounded fixed version/help evidence, and `RuntimeProjectBinding` establish capability without authorization. The invocation-authorization layer then derives a non-executing single-call boundary from the exact active Lode lineage; a durable at-most-once lease consumes it before the supervisor starts and keeps it non-replayable after completion, timeout, cancellation, or caller failure. Event/receipt/draft schemas, native Job Object/process-group fixtures, and live Codex/OpenCode Session/Run evidence prove the control-plane and tree-cleanup shape. Optional exact-endpoint attachment is a non-authoritative Host capability; ordinary tasks use Host-native coordination. P2-first exact optional attachment and exact-owned one-shot interrupt/close are active. Provider hydration, general resume/stream, and broader process control remain deferred. AST-accurate graphs and structured Git decision inference also remain deferred. See [`runtime-state.md`](runtime-state.md) and [`runtime-adapters.md`](runtime-adapters.md).

<a id="detailed-core-model"></a>

## Core model

Lode separates meaning, recovery, evidence, views, and effects so that one
representation cannot inherit another's authority.

| Plane | Owns | Examples | Does not authorize |
| --- | --- | --- | --- |
| P1 Normative authority | approved meaning and explicit decisions | Product Canon, ReviewDecision | inference from a graph, result, or message |
| P2 Recovery and lineage | provider-independent project direction | Session, Run, plan, Capsule, contract, checkpoint | rewriting direction from a summary or result |
| P3 Evidence | reviewable observations and results | candidates, ResultPacket, ChangeSet, receipts | self-promotion or checkpoint authorship |
| P4 Derived views | reproducible retrieval and human views | GraphSnapshot, traversal, Markdown, continuity | Canon mutation or unique recovery |
| P5 Operational effects | host-local execution and delivery | PID, lease, endpoint, inbox, delivery receipt | execution, review, promotion, or recovery authority |

Distribution and host integrations package or execute these contracts; neither
becomes a sixth source of product meaning. The complete executable boundary is
documented in [Authority planes](authority-plane-contract.md).

The smaller normative root and the formal Record/Graph boundary are documented
in [Provider-neutral Lode constitution](lode-constitution.md).

### Architecture at a glance

```mermaid
flowchart LR
    U[User objective] --> H[Whole-plan Lode]
    PC[Product Canon] --> WM[World Model + GraphSnapshot]
    RE[Repository evidence] --> WM
    H --> CC[Context Compiler]
    WM -->|bounded evidence| CC
    CC --> RA[Runtime adapter]
    RA --> RP[ResultPacket]
    RP --> FR[Fresh Lode review]
    WM --> PX[Local / ArcadeDB / Markdown projections]
```

The feedback path is explicit: an accepted result may become reviewed lineage,
the repository can be re-indexed, and a later graph may project that evidence.
No result, projection, or runtime effect accepts itself.

### Lode judgment with reproducible selected context

The Context Compiler packs evidence selected for the task under an explicit budget.
It records what was included, excluded, stale, missing, truncated, or unknown.
The same canonical inputs, compiler version, traversal policy, and budget
reproduce the same Context Capsule.

The default budget is `32768` approximate tokens, and Lode may use any positive
safe integer. There is no five-tier ladder or 512K policy ceiling. Actual provider
context fit and output reserve still apply; the estimate is not a tokenizer proof.

Lode may guide selection with exact repository paths, Product Canon keys,
Observation IDs or bounded current graph anchors. The compiler supplies
`evidenceGaps`, `omissions` and `uncertainty`, not an inclusion-proof gate.
Lode decides whether more source evidence is needed. A persisted ExecutionContract
records that separate judgment; it does not manufacture semantic acceptance.

A Capsule is a derived execution input, not a second Canon. Digest or Canon drift
fails closed; simple read/reason work does not create a Capsule by default.

### Execution and recovery

Managed execution follows this durable, reviewable sequence:

```text
WholePlanSnapshot
  → ExecutionContract + ContextCapsule
  → runtime or bounded worker
  → ResultPacket
  → Fresh Lode ReviewDecision
  → accepted lineage or a revised plan
```

Provider loss does not require importing a transcript. `session-restore`
reconstructs the current input from the exact P2 checkpoint and verified lineage.
After an accepted result, `run-integrate-checkpoint` can bind that review to a new
checkpoint only when Lode or the user explicitly supplies its recovery fields.

With a trusted Host adapter, managed intentional compaction uses this contract.
Packaged read-only context delivery does not perform this whole lifecycle:

1. provider Lode writes or reuses the exact P2 direction before compaction;
2. a provider-neutral Host adapter retains the one-time transport token outside
   project Canon and performs the provider-owned compaction;
3. Core restores P2 first, then verifies trusted real-user-turn evidence and
   rejects drift, uncertain replay, or summary-derived recovery;
4. the Host submits the checkpoint-bound continuation at most once, or Lode
   continues as a disclosed fresh logical Lode from the verified artifacts.

The normal UX is simply to continue the task. `lode_conversation_enter` is the
automatic read-only entry projection used by the Skill, while the `compact-*`
and `lode_compaction_lifecycle_step` surfaces are advanced adapter and diagnostic
operations. Missing Host hooks do not create a setup gate and never block
ordinary work.

For a durable direction update, the Skill internally uses the read-only
`lode_checkpoint_basis` and idempotent `lode_checkpoint_sync` surfaces. Core
returns `created`, `reused`, `deferred`, or `conflict`; only the affected recovery
path pauses, and none of these outcomes asks the user for checkpoint JSON.

When recovery needs explanation, `lode_checkpoint_diagnose` gives one bounded,
read-only answer: the current pointer, artifact-restore result, mechanical update
availability, and the next Lode action. It writes no lock or cache and never calls
another model merely to read status. Matching IDs and hashes prove artifact
consistency, not that checkpoint prose still matches the latest user intent.
Changed sequential reads require a retry; the result explicitly does not claim an
atomic filesystem snapshot or ABA detection. Ordinary independent work remains
available while only checkpoint-dependent work pauses on a real recovery fault.

A newer real user turn wins over a pending continuation. See
[Compaction recovery](compaction-recovery.md) and
[Session recovery](session-recovery.md).

### Product learning

Everyday observations can remain non-persisted notes. Durable artifacts are
created only when another Run, audit, product-state transition, or handoff needs
them:

```text
Signal → Hypothesis → Initiative candidate → user ReviewDecision
       → reviewed Initiative → accepted execution → OutcomeObservation
```

This is not one automatic promotion chain. Evidence remains evidence,
hypotheses remain hypotheses, and a reviewed Initiative remains distinct from
Product Canon. Lode judges risk and persistence directly, without a recommendation
API or a note-formatting call:

- Observe for read and reasoning work;
- Session for one bounded, reversible result;
- Run for dependent or recovery-sensitive work;
- Explicit authority for Canon, initiative decisions or effects outside the current
  approved scope. Updating a useful checkpoint within already approved direction
  is not a new user decision.

See [Product Operating Loop](product-operating-loop.md).
Git ref and deployment plumbing is documented in
[Release observation](release-observation.md).
Per-environment and per-target application, failure, and rollback history is
documented in [Delivery state observation](delivery-observation.md).

<a id="runtime-coordination-reference"></a>

## Runtime and coordination

Claude Code, Codex, and OpenCode are projections over one `.lode/` authority. Runtime adapters
observe capability, consume one exact authorization at most once, supervise the
owned process tree, validate structured output, and keep operational state
outside the project.

Ordinary delegation uses the current Host's tasks, messages and progress.
Lode provides context and ownership, combines successful contributions, inspects
unknown effects, and handles only the unfinished part. There is no Lode role-token,
generation, inbox or target-chain setup. Worker success cannot approve Canon or
write recovery direction.

Optional endpoint attachment first restores P2 direction, then attaches only if
the exact live endpoint can be verified. If the endpoint is gone, Lode reports
a fresh-logical-Lode fallback from the verified records. The portable export
bridge is attachment-only; it retains one
current snapshot, not a durable delivery mail service. Host-specific pane/socket/UI
behavior stays outside Core. See [Runtime adapters](runtime-adapters.md)
and [Host delegation and attachment](role-coordination.md).

<a id="optional-graphdb-reference"></a>

## Optional GraphDB

Local storage is the default. GraphDB is not required for onboarding,
context compilation, execution lineage, or recovery.

ArcadeDB can be explicitly activated as a derived graph projection. Credentials
are resolved only through environment-variable references and never enter
project artifacts, graph identities, generated documents, or receipts. Remote
activation must prove semantic conformance with the recoverable embedded graph.

The JavaScript bridge is the semantic reference. When a verified native package
is present, read-only prepared queries may use a content-addressed Go query-batch
bridge; JavaScript still verifies the pointer, topology, traversal, request
binding, and receipt. Set `LODE_AGENT_ARCADEDB_NATIVE_MODE` to:

- `auto`: use the verified native bridge when available, otherwise disclose and
  use the JavaScript reference path;
- `off`: always use the JavaScript path;
- `required`: fail when the verified native path is unavailable.

Manifest, binary, and post-selection digest mismatches always fail closed.
Exact children receive only configured credential-reference variables and a
bounded OS, TLS, locale, and proxy allowlist. The compute worker itself remains
network-free and authority-free. See
[Graph projection adapter](graph-projection-adapter.md).

<a id="design-principles-reference"></a>

## Design principles

Lode Agent Core Plugin is inspired by
[Won6314/head-agent-core](https://github.com/Won6314/head-agent-core) and
independently reworked as a provider-neutral plugin. It is not an official
upstream release or a drop-in replacement. See the
[source-grounded comparison](original-head-core-comparison.md).

The implementation uses these principles across providers:

- Lode owns the connected whole outcome;
- the user retains consequential authority;
- semantic sufficiency belongs to Lode; bounded verified context beats maximum context;
- durable Canon survives temporary model sessions;
- delegation stays bounded and non-authoritative;
- completion requires connected primary evidence;
- graphs are retrieval indexes, not unquestioned authority;
- project meaning remains separate from runtime mechanisms.

Read the upstream
[Foundations](https://github.com/Won6314/head-agent-core/blob/ba220c55c14b8af947bf6d1fb9d27a620a2cf2aa/packages/core/docs/FOUNDATIONS.md)
and
[Technical Architecture](https://github.com/Won6314/head-agent-core/blob/ba220c55c14b8af947bf6d1fb9d27a620a2cf2aa/packages/core/docs/TECHNICAL_ARCHITECTURE.md)
for the original design context.
