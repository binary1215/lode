# Authority planes and the Graph/record boundary

Read [`architecture.md`](architecture.md) before changing this contract. Runtime
direction comes from user-owned project authority, not repository-development
history or validation fixtures.

Status: active, executable contract

Protocol version: `0.9.0`

Digest-valid `0.1.0`, `0.2.0`, `0.3.0`, `0.4.0`, `0.5.0`, `0.6.0`, `0.7.0`, and `0.8.0` embedded boundaries remain readable for upgrade continuity;
new builders emit `0.9.0`. The only legacy classification retained by the reader
is the former generic Feature/Policy naming, never used to promote a new artifact.

`WorkerPatchIntegrationIntent` is P3: exact dispatch, authorization, settled
receipt, and owner-frozen patch provenance for one Lode-selected combination.
It does not reserve paths, apply files, authorize new execution, complete a Run,
or write recovery direction. Its history remains readable after source/Session
drift without requiring surviving Host temporary files. Current execution and
file-effect checks are separate from that historical evidence read.

Application adds P3 `WorkerIntegrationEffectClaim`, `WorkerIntegrationEffectAttempt`,
and `WorkerIntegrationEffectReceipt`: bounded evidence that an exact file effect
may have started, not another execution authorization. Outstanding actual paths
are checked across Runs and Sessions; read dependencies and unchanged ownership
do not reserve paths. A P3 `WorkerIntegrationIncompleteSettlement` records an
explicit incomplete handoff only after effect-owner quiescence is established.
It neither rewrites an unknown attempt as success nor authorizes its replay.
Native journals, process identities and live ownership remain P5.

`WorkerIntegrationVerification` freezes Lode's assessment of the observed combined
basis. `WorkerIntegrationResultApplication` links the one whole ResultPacket to
the existing Run finish and Fresh Lode review. Both are P3; neither produces a
ReviewDecision or integrates a P2 checkpoint. A changed basis requires renewed
Lode assessment, not a new user approval ceremony or a permanent source lock.

## Why this boundary exists

Lode Agent Core coordinates meaning, recovery, evidence, derived retrieval, and
live effects without allowing one representation to inherit another's authority.
The five planes below classify semantic artifacts. `Distribution` and `Host` are
separate architectural planes: they package or execute these contracts but never
become an additional source of product meaning or recovery direction.

| Plane | Ownership | Representative artifacts | Forbidden inference |
|---|---|---|---|
| P1 Normative Authority | approved product meaning, policy, and explicit decisions | Product Canon, ProductModelRevision, ProductCanonFeature/ReviewedFeature, PolicyCanon/ReviewedPolicy, ReviewDecision, accepted ProductPolicyReviewDecision | existence in a graph, message, result, or host cannot create approval |
| P2 Canonical Recovery/Lineage Record | provider-independent recovery of Project, Session, Run, plan, context, contract, and next direction | Project, ProjectDirection, LodeSession, Run, WholePlanSnapshot, ContextCapsule, ExecutionContract, SessionRunCheckpoint | evidence deletion or provider summary cannot rewrite checkpoint fields |
| P3 Evidence Record | reviewable results, observations, candidates, claims, ownership records, and audit receipts | ResultPacket, WorkerReport, BoundedWorkerDispatch, BoundedWorkerWave/Seal/Abandonment, CandidateSet, FeatureCandidate/ProductFeatureCandidate, PolicyCandidate/ProductPolicyCandidate, Evidence, ObservationTypeDescriptor/ObservationRecord/DerivedObservationRecord/ObservationCollectionReceipt, MetricDefinitionProjection, ProductHypothesis, ConformanceFindingCandidate/DispositionReceipt/ResolutionCandidate, BranchStateObservation, DeploymentResultObservation, ReleaseObservation, DocumentCanonApplicationReceipt, RunResultIntegrationRequest/Receipt | evidence cannot promote itself or become recovery canon |
| P4 Derived Relation/View | reproducible retrieval and human-facing views | ProjectGraphDiscoveryProjection, ProjectGraphObservationIndex, GraphSnapshot, GraphDB projection, TraversalResult, GraphLineageStatusProjection/TraceProjection/DiffProjection, MeasurementLineageProjection, DeliveryStateProjection, Markdown/Document projection, LodeContinuitySnapshot, SessionRestoreProjection, RecoveryCheckpointDiagnosisProjection, WorkerWaveStatusProjection/ResultProjection, ObservationStatusProjection, ObservationSourceDiscoveryProjection, ObservationPreparationProjection, ConformancePreparationProjection/QueueProjection/FindingGraphProjection/TriggerBatchProjection | a projection cannot mutate Canon, grant instruction authority, or be the only recovery source |
| P5 Operational Effect | host-local process, continuation, wait, and delivery effects | PID, token, proof, lease, endpoint, inbox, delivery receipt, ContinuationOutcome, BoundedWorkerWaitOutcome, BoundedWorkerWaveWaitOutcome, ObservationSourceBinding, ConformanceTriggerBinding, provider-session reference | successful continuation, waiting, delivery, or process control cannot authorize execution, review, promotion, or recovery |

`scripts/lib/authority-plane-contract.mjs` emits one content-derived
`AuthorityPlaneContract`, assigns the implemented artifacts above to exact planes,
and verifies embedded artifact boundaries. These are semantic classes rather than
a persistence hierarchy: P2 is authoritative for recovery but does not own P1
product meaning; P1 review does not replace P2 checkpoint state.

The boundary object's false instruction/promotion flags mean that classification
alone grants no action. A specific P1 ReviewDecision may separately carry an
exact, digest-bound scoped authorization; no other plane gains that authorization
merely by referencing or storing the decision.

## Non-amplification

The approval boundary trusts the local caller to convey an actual user decision.
Core verifies the exact target, disposition, digests, and permitted transition;
it does not authenticate a human merely because a request names the user or sets
a confirmation flag. The Host and provider Lode must connect the user's current
decision to the unchanged candidate before calling the protected mutation.
Tool annotations describe effects, not approval. A Host that needs stronger
authentication can check its own user-action receipt before calling Core; such
receipts and provider identities stay at the Host boundary. Ordinary work does
not acquire an additional approval step.

Authority may not move upward merely because one plane points at another. A
P3 candidate may affect P1 only through an explicit, verified ReviewDecision and
the exact reviewed mutation operation. World/Graph preparation captures the exact Product Canon bytes consumed by the snapshot. Immutable preparation runs outside the short `session-recovery` commit scope. Before current pointers are published, that scope rechecks Project/storage identity, Canon basis, and the expected current World pointer. A basis change fails with `WORLD_MODEL_CANON_BASIS_CONFLICT` and preserves the current Canon; a byte difference alone does not identify its writer. Core never restores earlier Canon bytes over another write. Permission, identity, and I/O failures retain their original code. Explicit forbidden authority APIs still reject amplification. This is cooperative Core serialization, not an OS sandbox or a claim of crash-atomic publication across pointers.

Candidate and reviewed product concepts have distinct names and planes. A generic
or unreviewed Feature/Policy is never classified as P1 merely because a graph node
uses that label. Only a Product Canon or separately reviewed Feature/Policy is P1;
FeatureCandidate, ProductFeatureCandidate, and PolicyCandidate remain P3.

An accepted Product Policy ReviewDecision changes only the exact candidate-bound Product Canon revision. Its P4 graph copy, an Observation comparison, a metric assessment, and a follow-up candidate cannot repeat or widen that authority. Differences or unknowns in measurement collection conditions remain disclosed evidence rather than either a silent equivalence claim or a new blocking gate.

P3 evidence, P4 derived views, and P5 operational effects cannot be promoted into
P2 recovery authority at all. A checkpoint may reference evidence for audit, but
its recovery fields come only from explicit Lode/user direction and verified P2
lineage. ResultPacket, GraphSnapshot, continuity, inbox, or provider-session state
cannot supply or rewrite those fields.

The same rule applies in context and coordination:

- a provider Lode semantic product proposal is P3 evidence; Core may verify and
  normalize it into an immutable candidate set, but it cannot create Product
  Canon or a ReviewDecision;
- a Capsule may include a bounded graph traversal only with false instruction and
  promotion authority;
- the non-persisted ContextWorkflowProjection is P4 selection advice: sources,
  omissions and uncertainty, without fixed tiers or an inclusion-proof gate.
  Lode judges sufficiency and chooses useful expansion. It cannot select meaning,
  invoke a provider, mutate state, grant approval or write recovery direction;
- the non-persisted ContextPreparationProjection is P4 candidate visibility,
  not semantic inference: it accepts task text only, exposes bounded current
  identities and lexical discovery material, and lets provider Lode author the
  structured proposal without requiring user JSON. It cannot choose
  EvidenceNeeds or graph anchors, persist provider/session identity, or write
  P2 direction. Any later preview revalidates Project/World/Graph drift;
- unreviewed candidates remain excluded from Canon context compilation; graph
  discovery may include them as explicitly labelled P3 evidence, retaining their
  original candidate/rejection state through relation expansion;
- provider summaries, continuity views, inbox messages, and replies cannot change
  checkpoint fields or create a ReviewDecision;
- a remote GraphDB can accelerate a verified query but cannot reconstruct Product
  Canon after the local normative and recovery records are lost.

Common observations preserve the same split. `ObservationTypeDescriptor`, `ObservationRecord`, `DerivedObservationRecord`, and `ObservationCollectionReceipt` are P3 evidence artifacts; `ObservationStatusProjection`, `ObservationSourceDiscoveryProjection`, and `ObservationPreparationProjection` are P4; `ObservationSourceBinding` is P5. Descriptor registration, collection, derivation, source discovery, reuse-first preparation, exact-ID Capsule inclusion, or a hypothesis reference cannot create P1 meaning or P2 direction. See [`observation-adapters.md`](observation-adapters.md).

Delivery state preserves that split without adding a new authority plane. A `delivery.state` `ObservationRecord` is P3; its current/history `DeliveryStateProjection` and exact verified `AT_REVISION` relation are P4. Explicit ordering conflicts fail the affected current-state derivation to `unknown`, not ordinary work. A failed attempt cannot erase prior applied evidence, and an unobserved target cannot be inferred successful. See [`delivery-observation.md`](delivery-observation.md).

Conformance reconciliation also preserves the split. Finding and resolution candidates plus exact-Finding disposition receipts are P3; preparation, queue, audit graph, and trigger-batch projections are P4; optional process-local trigger bindings are P5. Missing Graph, partial coverage, advisory risk, optional adapter loss, open Findings, and queue length cannot block ordinary work. Only cross-Project evidence, tampering, stale mutation input, path escape, divergent replay, or authority amplification fails the affected operation. A request to fix code still needs the ordinary execution lane, and a request to revise Canon still needs the existing exact user `ReviewDecision`. See [`conformance-reconciliation.md`](conformance-reconciliation.md).

Product Initiative review records one scoped decision containing the exact candidate and Feature selection. Reviewed initiative and FeatureCandidate outputs are read-only reconstructions of that decision, not duplicate stored approvals. The existing P5 writer lease serializes competing decisions. Exact retry reuses the decision; a missing legacy deferred selection is never guessed.

## Graph versus record

Product semantic Canon remains P1. Core temporal `GraphSnapshot` is P4: a
content-derived, rebuildable relation and retrieval index over verified Canon and
records. Its `productModelId` and hash bind the source it projects; they do not
transfer Product Canon authority into the graph. GraphDB is only a replaceable
materialization of that exact snapshot. Deleting GraphDB and generated Markdown
must leave Product Canon, Session/Run recovery, and ReviewDecision lineage intact.

This distinction preserves the original Product Graph insight without conflating
two products: a product-knowledge model can contain semantic Canon, while Lode
Core's temporal graph is the derived index over the Canon and execution records.
Only the former owns meaning; the latter owns navigation.

## Result and checkpoint boundary

`ResultPacket` and `WorkerReport` are P3 evidence. They can be reviewed, attached,
or deleted without changing the exact `nextExpectedResult` already frozen in a P2
`SessionRunCheckpoint`. `ReviewDecision` is P1 normative record. The checkpoint is
the recovery record. Neither substitutes for the other.

An accepted reviewed result connects to recovery through explicit integration.
Lode supplies direction; verified ResultPacket and ReviewDecision are references,
not field authors. One locked checkpoint publication binds the exact reviewed
Run and normalized direction. Identical retries reuse it; divergent direction
conflicts; interruption resumes only the missing Session pointer update.
No separate integration request or receipt is newly produced. Historical records
remain readable through their narrow original-format path. Artifact-only restore
uses self-contained P2 direction, not a surviving evidence receipt.

The non-persisted recovery checkpoint basis follows P4 non-amplification. It
binds exact current P2 identities and transition state only so Core can detect a
stale or convergent publish request. Provider Lode remains the only component
that derives natural-language recovery direction, and must do so after reading
that basis. Basis existence, a changed basis ID, a Run result, an open epoch, or
an operational Host event cannot supply a checkpoint field. The locked sync may
only create one P2 checkpoint from explicit Lode direction, reuse exact current
bytes, defer an incomplete transition, or reject stale state.

Optional live continuation follows the same boundary. Core restores the exact P2
checkpoint first, then a P5 WorkspaceHost adapter may fresh-verify one already-
running endpoint. The non-persisted `ContinuationOutcome` reports `attached` or a
disclosed fresh logical Lode fallback; it cannot change the SessionRestoreProjection,
persist provider identity, or claim recovery authority.

`RecoveryCheckpointDiagnosisProjection` is also P4. It verifies a bounded
`basis B0 -> restore -> basis B1` sequence and reports facts about the current
pointer, artifact recovery, and mechanical sync availability. It cannot cache a
basis, acquire the mutation lock, repair evidence, invoke a provider Lode, judge
semantic freshness, or supply any checkpoint field. Sequential agreement is not
an atomic filesystem snapshot and cannot detect ABA. A changed sequence requires
a fresh read; integrity failure and required-artifact loss remain failures rather
than being relabeled as optional evidence loss.

Independently ownable worker execution records one P3 `BoundedWorkerDispatch` over
an exact Session or Run `ExecutionAuthorization`. Session workers return one
bounded result for Lode evidence consumption through wait/result read, without
Run application, a compulsory persisted Capsule, or P1/P2 advancement. Run
workers retain the following review/integration boundary. P5 lease/process/wait state enforces
at-most-once use and reports progress, but neither dispatch nor wait can alter the
WholePlan or create a ReviewDecision. Only the resulting P3 ResultPacket reaches
Fresh Lode; explicit P1 review and the existing reviewed-result integration are
still required before a new P2 checkpoint is written.

`BoundedWorkerWave` may group multiple such dispatches only when their exact
Project, Lode Session, active Run, WholePlan, ExecutionContract, and Capsule
lineage is identical. It grants no authorization and each lease remains
independent. A P3 seal requires verified consumption for every member; P4 status
cannot create that seal. Wave failure, completion, abandonment, result projection,
and P5 wait cannot create P1 review or P2 recovery direction.

The executable recovery test creates a ResultPacket, prepares a checkpoint,
deletes the ResultPacket file, and verifies that the checkpoint still reproduces
the exact next expected result. This is the deletion test for the evidence/recovery
boundary, not permission to discard evidence in normal operation.

## Causal projection and no self-reference

Document application may retain a narrow P3 Evidence basis binding one verified
review hash to the before-World identity. It copies neither approval nor document
bodies, never supplies P2 fields, and cannot authorize a mutation by itself.
The same durable accept or reject decision resumes derived publication from
existing preimage/target artifacts. Projection failure does not erase an already
applied approved Canon or grant permission to overwrite later user edits.

A receipt cannot be part of the GraphSnapshot that the receipt itself names.
Document Canon application therefore uses this causal order:

```text
verified ReviewDecision
  -> exact reviewed Product Canon mutation
  -> named child World Model / GraphSnapshot
  -> immutable application receipt naming that snapshot
  -> later audit child GraphSnapshot that may project the receipt
```

Core verifies both halves: the named graph excludes the new receipt, and the
later graph has a different identity, names the earlier SourceSnapshot as a
parent, and includes the receipt. Same-snapshot inclusion fails with
`GRAPH_SNAPSHOT_RECEIPT_SELF_REFERENCE`.

## Executable acceptance criteria

- every current lineage, checkpoint, GraphSnapshot, and application-receipt
  builder emits its exact plane boundary and current readers verify it;
- P4-to-P1 promotion without an explicit ReviewDecision fails;
- Canon basis changes refuse derived pointer publication and preserve the changed Canon bytes;
- deleting ResultPacket evidence after checkpoint creation does not alter or
  prevent recovery of `nextExpectedResult`;
- the receipt is absent from its named graph and present only in a later child;
- local, in-memory, and activated GraphDB backends preserve the same semantic
  GraphSnapshot and TraversalResult identities;
- a reply creates zero ReviewDecisions, and a provider summary cannot change a
  checkpoint digest or field.

Optional Worker Admission is P5 Host operational state. Its queue, reservation,
generation, capacity, expectation, and status records cannot create or mutate
P1 review, P2 recovery direction, P3 result meaning, Product Canon, or wave
completion. Missing admission state blocks only the affected admission domain;
ordinary Core recovery and non-admission execution remain governed by their
existing contracts.

## Discovery, common direction and Session routing

`ProjectDirection` is P2 current common user direction: goal, constraints,
decisions and cancelled actions. Exact-basis updates reconcile concurrent intent.
These fields and historical approvals read from the graph grant no execution
authorization. Multiple logical Sessions keep independent progress/recovery through
request-local routing without switching the default Session. Restore preserves
checkpoint fields exactly and applies current common direction separately.

`ProjectGraphDiscoveryProjection` and its replaceable `ProjectGraphObservationIndex`
are P4. Work/Product views reference the same originals. Bounded discovery reads
intact historical/unapproved/rejected evidence with original state, basis and
revision preserved through relation expansion. This does not relax Canon compiler
candidate exclusion or promote an old approval into current effect permission.
Valid layers remain usable without full World currentness, Product review,
Run/Capsule or DB; damaged layers are excluded independently. Empty/partial
coverage is not absence and returns original-source fallback. Same-basis results
and failures may be reused. Reading creates neither approval nor checkpoint.

## Canon publication coordination

Onboarding promotion and Product Policy acceptance already publish Canon inside the short `session-recovery` scope; document-review Canon application now joins that same scope and revalidates its reviewed preimage. None holds that scope across awaited projection work. World refresh may hold its existing writer lease before entering this scope; Canon publishers release the scope before requesting a derived refresh, avoiding the reverse lock order. Fresh initialization creates an unpublished Project with collision checks and is not a replacement Canon publisher. Immutable snapshot preparation may remain after a conflict; it grants no authority and does not advance current pointers.

Built-in Activated ArcadeDB materialization also separates the real local mirror pointer from remote publication. Only local Graph and World current-pointer writes occur in the short Canon commit scope. Remote pointer, topology activation and sync-receipt work run after that scope is released, preserving the existing unavailable-before-remote-observation-only fallback. A remote integrity, permission or uncertain write failure remains an error; it cannot create a successful receipt or roll back a newer Canon/current pointer. Errors disclose which local publication was confirmed and which external work did not complete. This separation does not claim an atomic transaction across local and remote stores.

After awaited remote publication, the actual current local mirror is read again before topology/sync receipts can claim `localMirrorVerified`. Direct materialization also rechecks the real local current before returning success. World completion revalidates its consumed Canon bytes and expected current World pointer. A superseding local/current value is preserved and reported as conflict with the confirmed prior remote effect; no automatic replay or rollback is introduced.
