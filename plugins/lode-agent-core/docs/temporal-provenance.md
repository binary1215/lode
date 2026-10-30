# Temporal provenance GraphSnapshot alpha

Read [`architecture.md`](architecture.md) and
[`authority-plane-contract.md`](authority-plane-contract.md) before changing
this plane.

## Purpose and authority

The temporal provenance graph connects user-owned product intent, immutable onboarding review history, and observed repository state across time without making Git or GraphDB a product prerequisite. It is a deterministic, rebuildable `GraphSnapshot` derived from validated Product Canon, immutable onboarding artifacts, the current supported source scan, and explicit parent identities. It is evidence for Context Compiler traversal; storing canon, candidate, or review projections in the graph does not make the graph project canon, instruction authority, or promotion authority.

The graph builder consumes only provider-neutral inputs:

- project identity;
- normalized `.lode/context/product-model.json` content and its evidence identity;
- digest-verified onboarding artifacts, FeatureMappingCandidateSets and mapping ReviewDecisions, provider-neutral ChangeSets with change-impact review artifacts, Product Operating Loop artifacts, and optional immutable VCS evidence attachments;
- normalized file paths, SHA-256 content digests, classifications, languages, and extracted symbols;
- zero-or-more explicit parent `SourceSnapshot` identities;
- optional zero-or-more parent Revision identities keyed by stable logical entity identity.

Git commits, branches, tags, GraphDB record IDs, provider session IDs, document-provider page IDs, observation timestamps, and line locations used only as Evidence are excluded from required logical entity and ChangeSet identity. The enclosing World Model may separately contain optional Git history. The temporal GraphSnapshot consumes no live Git state; it consumes only separately persisted and digest-verified `VcsEvidence` and release-observation projection inputs.

## Logical entities and immutable revisions

Temporal provenance vocabulary `0.15.0` materializes a P4 rebuildable relation and retrieval index under the [`AuthorityPlaneContract`](authority-plane-contract.md). New World Model graphs use the existing `0.16.0` stable relation producer in every storage layout. Digest-valid historical protocols from `0.2.0` through `0.15.0` remain readable without rewriting their bytes, identities or pins. The vocabulary includes bounded opaque historical onboarding references and the existing Policy and Observation projections:

- stable product logical entities: `FeatureGroup`, `Capability`, `Feature`, `Requirement`, `Constraint`, `Decision`, and schema-v2 `Policy`;
- immutable product states: the corresponding `*Revision` kinds;
- stable implementation logical entities: `Repository`, `File`, `Symbol`, and `Test`;
- immutable implementation states: `FileRevision`, `SymbolRevision`, and `TestRevision`;
- temporal roots and external ancestry references: `SourceSnapshot`, `SourceSnapshotReference`, and `RevisionReference`.
- onboarding evidence and review history: `OnboardingCandidateSet`, `OnboardingProductCandidate`, `OnboardingEvidence`, `OnboardingUnknown`, `OnboardingReviewDecision`, `ProductConceptReference`, and `ProductModelRevision`.
- bounded historical onboarding continuity: opaque `HistoricalOnboardingCandidateReference` nodes and non-authoritative `HISTORICALLY_FOLLOWS` edges. Exact `typedRevisionIds` and `opaqueRevisionIds` coverage must agree with the projected revision set; it cannot grant P1 or recovery authority.
- mapping review history: `FeatureMappingCandidateSet`, `FeatureMappingCandidate`, `FeatureMappingEvidence`, `FeatureMappingUnknown`, `FeatureMappingReviewDecision`, `ReviewedRelationship`, and historical `MappingEndpointReference`.
- change lineage: `ChangeSet`, `ChangeRevisionReference`, execution-lineage references, `ChangeImpactCandidateSet`, `ChangeImpactCandidate`, `ChangeImpactUnknown`, `ChangeImpactReviewDecision`, `ReviewedImpact`, and historical product references.
- optional external change evidence: `VcsEvidence` and immutable `GitCommit` observation nodes. These nodes are omitted when no attachment exists and never replace the ChangeSet.
- document review lineage: hidden `DocumentChangeCandidateSet` and `DocumentChangeCandidate` nodes plus normally visible `DocumentChangeReviewDecision`, `DocumentProductModelRevision`, `DocumentChangeApplication`, and historical `DocumentProjectionReference` evidence.
- product operating evidence: `ProductSignal`, `ProductHypothesis`, hidden `ProductInitiativeCandidate` and `ProductFeatureCandidate`, historical `ProductFeatureReference`, explicit `ProductInitiativeReviewDecision`, separate `ReviewedProductInitiative`, and execution-bound `OutcomeObservation` nodes.
- release evidence: `BranchStateObservation`, `DeploymentResultObservation`, `ReleaseObservation`, and embedded immutable `GitCommit` observations.
- Policy review history: hidden `ProductPolicyCandidate` and `ProductPolicyEvidence`, explicit `ProductPolicyReviewDecision`, historical `ProductModelRevisionReference`, and the exact current `PolicyRevision` when its semantic content matches an accepted proposal.
- common observation and measurement evidence: `ObservationTypeDescriptor`, `ObservationCollectionReceipt`, `ObservationRecord`, and `DerivedObservationRecord`, with interpretation remaining outside graph authority. Verified per-target delivery events may point to an exact current `FileRevision` or a derived historical `RevisionReference`.

Ephemeral conversational learning never enters a GraphSnapshot. A v0.2 Initiative candidate may contain inline reasoning and no Feature resolution; it has no `PROPOSES_TO` edge until review and, when it has no persisted hypothesis references, no `PROPOSES_FROM` edge. Explicit accept review resolves exactly one existing Feature, Feature candidate, or honest gap in the separate reviewed Initiative. The candidate bytes remain unchanged.

Product logical identity derives from project identity, entity kind, and stable user-owned key. Renaming a Feature preserves logical identity while semantic edits create a new FeatureRevision. `File` identity derives from project identity and normalized path. `Symbol` identity derives from its File identity, kind, name, and deterministic same-name occurrence rather than its line number. `Test` identity derives from project identity and path. Revision identities derive from the logical identity, semantic state, and sorted parent Revision identities. A line move therefore preserves the Symbol logical identity while changing its SymbolRevision.

The `SourceSnapshot` identity includes the project, complete sorted current Revision sets, an ancestry-independent state digest, the producer version, and sorted zero-or-more parent SourceSnapshots. Multiple parents are supported from the first schema version. This records a DAG shape only; automatic merge, conflict detection, conflict resolution, and ancestry fetching remain deferred.

## Provenance-complete projection

New relation identity separates logical relationship and content revision from global
snapshot membership. Exact endpoints, Project, endpoint continuity generation,
evidence, authority, confidence and producer/analysis basis remain inputs. A relation
to a different SourceSnapshot still has a different exact endpoint. This producer
does not require the experimental domain-bundle layout.

The read-only lineage diff keeps its original `changes` and pagination. Its separate
`changeExplanation` distinguishes changed record content from records differing
only in global `sourceSnapshotId` membership. All other fields remain compared;
ambiguous relation matches stay separate. Producer/analysis transitions are explicit,
including the first comparison across the old and new writers. This is mechanical
record comparison, not a judgment of semantic continuity, approval or sufficiency.
Explanation examples are bounded within the same selected scope; raw diff pages
and exact historical snapshot reads remain available.

Every projected node records `nodeId`, `kind`, `authorityClass`, `origin`, sorted `evidenceIds`, `freshness`, producer identity and version, and boolean instruction/promotion authority flags. Snapshot-scoped nodes also record `sourceSnapshotId`; Revision nodes record their logical entity and sorted parent identities.

Every edge records the same authority and provenance surface plus `edgeId`, typed endpoints, and `sourceSnapshotId`. Heuristic Symbol nodes and relations carry numeric confidence. The current implemented relation subset is:

- `CONTAINS`;
- `REALIZES`;
- `GOVERNED_BY`;
- `HAS_REVISION`;
- `CURRENT_REVISION`;
- `PARENT_OF`;
- `DECLARES`;
- `REFERENCES`;
- `PROPOSES_FROM`, `PROPOSES_TO`, and `SUPPORTED_BY`;
- `REVIEWED_BY`, `ACCEPTED_BY`, and `REJECTED_BY`;
- `PRODUCES` and `PROMOTED_FROM`. For onboarding, `revise ReviewDecision -[:PRODUCES]-> successor CandidateSet` is distinct from `accept ReviewDecision -[:PRODUCES]-> ProductModelRevision`.
- non-authoritative historical continuity through `HISTORICALLY_FOLLOWS`.
- reviewed canonical `IMPLEMENTS` and `VERIFIED_BY` edges.
- provider-neutral `CHANGES` and `SUPERSEDES` lineage plus explicitly reviewed `IMPACTS` edges.
- optional `ChangeSet -[:MATERIALIZED_AS]-> VcsEvidence -[:REFERENCES]-> GitCommit` evidence links.
- product learning and observation through `SUPPORTED_BY`, `PROPOSES_FROM`, `PROPOSES_TO`, review/promotion relations, and `OutcomeObservation -[:OBSERVES]-> ChangeSet|ReviewedProductInitiative`.
- release evidence through `AT_REVISION`, `OBSERVED_ON`, `EVIDENCED_BY`, and optional `ReleaseObservation -[:DEPLOYS]-> ChangeSet`.
- Policy proposal and approval through `PROPOSES_FROM`, `PROPOSES_TO`, `SUPPORTED_BY`, `REVIEWED_BY`, `ACCEPTED_BY`, `REJECTED_BY`, `PRODUCES`, and `REFERENCES`, plus exact Policy-to-Requirement/Constraint/Decision `GOVERNED_BY` edges when those optional semantic references are explicit. A later unrelated Product Model change does not erase the accepted ReviewDecision path to an unchanged current `PolicyRevision`.
- common Observation shapes and derivations through `CONFORMS_TO`, `EVIDENCED_BY`, and `DERIVED_FROM`; a verified `delivery.state` record may additionally use `AT_REVISION` for its exact retained source revision. Declared-only revision strings receive no graph edge.

The verifier rejects digest mismatch, unsupported node or relation types, duplicate identities, nondeterministic ordering, dangling or invalid endpoint kinds, missing provenance, invalid authority flags, invalid confidence, scope mismatch, and direct self-parent cycles.

The non-persisted graph-lineage trace may add a bounded currentness diagnostic for Policy evidence present in the result. It re-hashes only safe local sources up to 64 MiB and reports `unchanged`, `changed`, `missing`, or `not-assessed`; external evidence and failed bounded reads stay `not-assessed`. This read-time P4 diagnostic does not rewrite the historical graph, reassess meaning, invalidate an accepted ReviewDecision, or create a review gate.

## Deterministic bounded traversal

`queryTemporalProvenanceGraph` first verifies the complete GraphSnapshot, then constructs temporal traversal protocol `0.3.0`. It has two mutually exclusive anchor modes: `lexical-discovery` for explicit search, and `exact-head-proposed` for semantic anchors supplied by Lode. Exact mode requires one to 32 unique node IDs plus the current `expectedGraphSnapshotId`; every anchor must exist and satisfy the requested kind, authority, freshness, confidence, and candidate policy. The query records:

- node-kind, relation, authority-class, and freshness allowlists;
- minimum confidence;
- default exclusion of CandidateSet, candidate, Evidence, Unknown, ProductConceptReference, ProductInitiativeCandidate, ProductFeatureCandidate, ProductPolicyCandidate, and ProductPolicyEvidence nodes, with an explicit `includeUnreviewedCandidates` opt-in;
- maximum depth, node count, and edge count;
- anchor identities and deterministic ordering.

Lexical discovery never proves task relevance. Exact anchors do not widen relations or bounds, and stale, missing, cross-snapshot, or ineligible anchors fail closed. Neither mode can write Product Canon, a ReviewDecision, or P2 recovery direction.

The result records graph, query, and result IDs and hashes; selected nodes and edges; inclusion reasons; exclusion counts; and truncation. A backend may accelerate this algorithm later but may not widen the allowlists, reorder semantic results, admit stale evidence, or alter the digest.

## CLI and MCP

```text
node scripts/lode.mjs world-index <project> --parent-snapshot <id,id>
node scripts/lode.mjs world-index <project> --revision-parents <json-file>
node scripts/lode.mjs world-temporal <project> --query <text> --kind File,FileRevision --relations HAS_REVISION,CURRENT_REVISION --depth 1 --limit 100 --edge-limit 200
node scripts/lode.mjs world-temporal <project> --anchor-ids <node-id,node-id> --graph-snapshot <graph-snapshot-id> --relations HAS_REVISION,CURRENT_REVISION --depth 1 --limit 100 --edge-limit 200
node scripts/lode.mjs world-temporal <project> --query <candidate-id> --kind FeatureMappingCandidate,FeatureMappingEvidence --include-candidates true --depth 1 --limit 100 --edge-limit 200
node scripts/lode.mjs world-temporal <project> --query <change-set-id> --relations CHANGES,IMPACTS,SUPERSEDES --depth 3 --limit 200 --edge-limit 400
node scripts/lode.mjs world-temporal <project> --query <change-set-id> --relations MATERIALIZED_AS,REFERENCES --depth 2 --limit 200 --edge-limit 400
```

`--revision-parents` reads a JSON object whose keys are current logical entity IDs and whose values are arrays of parent Revision IDs. The read-only MCP tool `lode_temporal_graph` exposes the same bounded traversal through `include_unreviewed_candidates`. Both reject a stale World Model. ReviewDecision and ProductModelRevision receipts remain visible under normal reviewed traversal; the unreviewed candidate surface requires explicit opt-in and still has no authority effect.

The Context Compiler does not infer temporal anchors from task-token overlap. Lode may attach an exact current `graphAnchor` to a `temporal-relation` EvidenceNeed; Core then emits a separate `GraphTraversalEvidence` carrier only after verifying Project, World Model, GraphSnapshot, node eligibility, relation allowlist, and traversal bounds. Local JSON, in-memory, and activated ArcadeDB adapters must return the exact reference result. Adapter identity remains outside Capsule identity. See [`graph-projection-adapter.md`](graph-projection-adapter.md).

Reviewed execution changes bind `ChangeSet` records to exact before/after source revisions. A reviewed current product impact also binds its exact Feature or Capability revision with `AT_REVISION`; later drift keeps the historical receipt but removes the current-impact claim. Git refs alone never create `DeploymentResultObservation` or `ReleaseObservation`. Delivery lineage appears only after a Host submits separately approved, successful, exact-commit deployment evidence.

Per-target delivery genealogy is distinct from that release path. A Host may record explicit applied, failed, cancelled, and rolled-back `delivery.state` events without Git. The graph links only mechanically verified retained source revisions; current target state is a separate bounded P4 read projection based on explicit sequence and predecessor evidence. It never infers release approval, environment completeness, or success for unobserved targets. See [`delivery-observation.md`](delivery-observation.md).

The active deterministic Markdown renderer consumes this verified graph through `DocumentProjectionAdapter` after indexing. It preserves canonical edge direction, links relation endpoints to node pages, and records the exact GraphSnapshot and SourceSnapshot identities. Generated pages are human views only and are never traversed back into Context Compiler input. Edited pages become non-authoritative `DocumentChangeCandidateSet` evidence. Explicit reviews are projected into a later child graph; an application receipt binds the actual application outcome, then a subsequent audit child graph projects that receipt. This two-stage boundary avoids a GraphSnapshot hash depending on a receipt that names the same GraphSnapshot. Context Compiler does not opt into the document candidate surface. See [`document-projection-adapter.md`](document-projection-adapter.md) and [`document-change-review.md`](document-change-review.md).

## Deferred boundaries

This beta does not infer commit-to-ChangeSet matching, project-complete execution lineage, or promote general candidates beyond implemented review scopes. Local/in-memory and explicitly activated ArcadeDB GraphProjectionAdapter paths are implemented; Obsidian, Notion, and non-ArcadeDB remote graph transports remain deferred. Explicit document-candidate review/application and later audit projection are active but never infer product meaning from prose. The system still does not infer parent revisions or ChangeSet ancestry, perform merges, automatically promote candidates, or treat current-state pointers as canon.
