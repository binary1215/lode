# Review-gated Feature mapping

Read [`architecture.md`](architecture.md) and
[`authority-plane-contract.md`](authority-plane-contract.md) before changing
this authority boundary.

## Pending evidence maintenance

Lode may inspect and batch proposals without asking for a decision after every
candidate. When an unreviewed pending batch becomes obsolete, the existing
proposal accepts `expectedCandidateSetId` and a fresh semantic proposal (CLI
`--expected-candidate-set`; MCP `expected_candidate_set_id`). Under the shared
mutation lock, Core verifies the exact old artifact and all durable review files
before replacing the workflow pointer. Any saved user decision, corrupt review,
stale expected ID or stale new evidence rejects before writes. Old evidence and
reviewed relationships remain intact. No rejection, approval or P2 direction is
fabricated. Only explicit user review promotes the new batch's relationships.

## Contract

Feature mapping protocol `0.2.0` connects authoritative `Feature` and `Capability` concepts to observed `File`, `Symbol`, and `Test` entities without allowing Core code analysis to invent either relevance or an approved product relationship.

The canonical directions are:

```text
File or Symbol -[:IMPLEMENTS]-> Feature or Capability
Feature or Capability -[:VERIFIED_BY]-> Test
```

A provider Lode may propose mappings after reading current project evidence. Core then verifies the proposal schema, exact current endpoint identities and revisions, relationship direction, source and product snapshot bindings, bounded confidence, explanation, and content-addressed Evidence before creating an immutable `FeatureMappingCandidateSet`. Candidate and Evidence records have false instruction and promotion authority. With no semantic proposal, Core records an explicit Unknown and creates no candidates.

An explicit user-authored mapping `ReviewDecision` may accept all candidates, accept a named selection, or reject the batch. Acceptance does not mutate a candidate. It creates a separate `ReviewedRelationship` receipt linked to the candidate by `PROMOTED_FROM` and to the decision by `PRODUCES`, then materializes the reviewed canonical `IMPLEMENTS` or `VERIFIED_BY` edge. Rejection records `REJECTED_BY` and creates no canonical mapping edge.

Product Canon is not modified by mapping review. Every review requires the exact
current candidate set, verified digests, and no active or awaiting-review Run.
Acceptance additionally requires current repository and Product evidence matching
the proposal. An explicit user rejection may close that exact candidate set after
source or Product evidence changes; it cannot promote a relationship.

Rejection retains the immutable proposal and its historical bindings, while the
derived graph uses verified current Product identity. If World is verifiably
stale, the same explicit rejection operation refreshes it with preserved ancestry.
A missing World still needs explicit rebuilding; a corrupt World remains an
integrity error, not permission to overwrite it. After rejection, Lode can inspect
current evidence and propose a replacement without source rollback or manual
state deletion. Drift or a request to start another proposal never invents a
user rejection, and prior reviewed relationship records remain intact.

The immutable P1 ReviewDecision is written before its rebuildable P4 World
projection. If the decision was saved but projection or final workflow-pointer
publication was interrupted, the same normalized review request rebuilds only
the missing derived view and completes the pointer after verifying the saved
decision. This is recovery of an existing decision, not another approval: later
source drift is disclosed rather than grounds to rewrite the decision or ask for
reapproval. A failure before the P1 write cannot publish a decision projection.
A different disposition, selection, or rationale for that same candidate set
fails before refresh or publication. Multiple conflicting saved decisions also
fail without selecting or deleting one.

For compatibility with an interrupted older publication order, a P4 projection
without a durable decision may be repaired only from the current explicit review
request, and only when its exact decision identity is already projected while
repository evidence, Product identity, and every non-derived freshness signal
still match the candidate set. The graph copy is comparison evidence, never the
source of the P1 decision. A changed request, real source or Product drift, or a
partial/mismatched projection fails closed. Proposal and review writes share the
existing Session mutation coordinator; read-only status remains non-mutating and
exposes pending recovery without requesting a new user decision. Once completed,
the unchanged request for the same current candidate returns the verified
existing result without changing stored project records. This does not reopen a
reviewed batch or allow replay against a newer candidate pointer.

Starting a proposal reuses the verified current World rather than rebuilding it
with empty ancestry. Derived mapping publication preserves the current source
and revision lineage. This prevents publication itself from making a current
proposal stale; actual source, Canon, or endpoint drift still requires fresh
evidence. Historical approval and the submitted proposal are not rewritten.

An explicit setup without a semantic proposal may build an absent World or
refresh a verified stale one within that same operation. It creates only the
existing evidence/Unknown batch, not inferred mappings or a user decision.
Read-only status never performs this setup.

## Commands

```text
node scripts/lode.mjs feature-mapping-start <project> --input <semantic-mapping-proposal.json>
node scripts/lode.mjs feature-mapping-status <project>
node scripts/lode.mjs feature-mapping-candidates <project> --candidate-set <feature-mapping-candidates-id>
node scripts/lode.mjs feature-mapping-review <project> --input <mapping-review.json>
node scripts/lode.mjs feature-mapping-review-read <project> --review <feature-mapping-review-decision-id>
```

Example semantic proposal input:

```json
{
  "schemaVersion": 1,
  "sourceSnapshotId": "source-snapshot-<24-hex>",
  "productModelId": "product-model-<24-hex>",
  "candidates": [
    {
      "relationshipType": "IMPLEMENTS",
      "sourceNodeId": "symbol-<24-hex>",
      "productNodeId": "feature-<24-hex>",
      "explanation": "The implementation behavior and the approved Feature contract match.",
      "confidence": 0.9
    }
  ]
}
```

Example acceptance input:

```json
{
  "candidateSetId": "feature-mapping-candidates-<24-hex>",
  "disposition": "accept-selection",
  "acceptedCandidateIds": ["feature-mapping-candidate-<24-hex>"],
  "rationale": "Reviewed repository and test evidence supports this product relationship."
}
```

`accept-all` ignores `acceptedCandidateIds`; `reject` accepts none. CLI review and typed MCP `lode_feature_mapping_review` call the same Core mutation; MCP additionally requires `confirm_user_review: true`. MCP also exposes `lode_feature_mapping_propose` and read-only `lode_feature_mapping_status`. Normal temporal traversal excludes the unreviewed candidate surface unless `include_unreviewed_candidates` is explicitly enabled.

## Storage and projection

The local conformance path stores:

```text
.lode/feature-mappings/current.json
.lode/feature-mappings/candidate-sets/feature-mapping-candidates-*.json
.lode/feature-mappings/review-decisions/feature-mapping-review-decision-*.json
```

Candidate sets and ReviewDecisions are immutable, digest-verified artifacts. `current.json` is only a digest-verified workflow pointer. The temporal graph and World Model remain rebuildable projections; Git and GraphDB are optional and do not participate in mapping authority.

If a previously reviewed endpoint disappears, the historical receipt remains with stale freshness and the current canonical edge is omitted. A later semantic proposal and explicit review are required to establish a new current mapping.

## Semantic proposal boundary

Core does not infer product meaning from names, paths, token overlap, or a repository-specific vocabulary. The provider Lode owns semantic reading and proposes only bounded relationships; Core owns current-evidence verification, deterministic normalization, immutable storage, drift checks, and review gating. An invalid or stale proposal fails closed. There is no lexical fallback.

Provider-neutral live proposal orchestration, change-impact candidates, bulk user edits/revision batches, automatic mapping refresh, and general relationship-promotion policy remain deferred.
