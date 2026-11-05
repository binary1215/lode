# Document change review and application

Status: active alpha contract

Protocol version: `0.1.0`

Application receipts are P3 evidence under the
[`AuthorityPlaneContract`](authority-plane-contract.md). The applied Product Canon
child GraphSnapshot is built before its receipt exists, so that named snapshot
must exclude the receipt. Only a later audit child may include it; Core verifies
the changed graph identity, parent SourceSnapshot, same-snapshot exclusion, and
child inclusion and rejects causal self-reference.

## Purpose

Generated Markdown is a deterministic human-facing projection of a verified `GraphSnapshot`. An edited page is therefore evidence of a proposed product change, not a new source of authority. This contract supplies the missing explicit transition:

```text
edited generated Markdown
  -> immutable DocumentChangeCandidateSet
  -> explicit user ReviewDecision
  -> exact complete Product Model revision
  -> verified Product Canon write
  -> child SourceSnapshot and GraphSnapshot
  -> reconciled deterministic Markdown
  -> immutable application receipt
  -> later audit SourceSnapshot and GraphSnapshot
```

No Markdown parser or model is allowed to infer the authoritative Product Model from the edited prose. An accepting review must include the complete structured `resultingProductModel` selected by the user.

## Authority boundary

`DocumentChangeCandidateSet` and each candidate remain immutable evidence with false instruction and promotion authority. They are never relabeled after review.

An accepting `ReviewDecision` has:

- `decisionScope: document-to-product-canon`;
- `authority: explicit-user-document-change-review`;
- `instructionAuthority: true`;
- `promotionAuthority: true`;
- an exact partition of accepted and rejected candidate identities;
- the candidate, DocumentProjection, GraphSnapshot, SourceSnapshot, previous Product Model, and resulting Product Model identities;
- a required user rationale.

A rejection is still an explicit user ReviewDecision, but has `promotionAuthority: false` and no resulting Product Model.

The application receipt is evidence of what happened. It has no independent instruction or promotion authority.

## Review input

The CLI accepts a strict JSON object:

```json
{
  "candidateSetId": "document-change-candidate-set-...",
  "disposition": "accept-all",
  "acceptedCandidateIds": [],
  "resultingProductModel": {
    "schemaVersion": 1,
    "featureGroups": [],
    "capabilities": [],
    "features": [],
    "requirements": [],
    "constraints": [],
    "decisions": []
  },
  "rationale": "Explicit user rationale",
  "apply": true
}
```

Supported dispositions are `accept-all`, `accept-selection`, and `reject`.

- `accept-all` rejects an explicit `acceptedCandidateIds` list and accepts the complete candidate set;
- `accept-selection` requires a non-empty unique subset and rejects the complement;
- `reject` forbids accepted candidates and a resulting Product Model;
- accepting dispositions require a complete Product Model that differs from current Canon;
- `apply` defaults to `true`; `false` records a review that must later be applied explicitly.

The full target model is deliberate. It prevents arbitrary Markdown text, headings, links, or generated layout from becoming an implicit Product Canon patch.

## Validation and failure boundaries

Before recording a review, the implementation verifies:

- project readiness and absence of an active or pending-review Run;
- candidate-set content identity and exact project scope;
- the current published bytes still match the captured proposal;
- the base DocumentProjection and GraphSnapshot remain available and digest-valid;
- accepting reviews still target the same Product Canon used by the candidate projection;
- the complete resulting Product Model passes strict keys, references, hierarchy, and cycle validation;
- one candidate set cannot receive conflicting ReviewDecisions.

Before application, it verifies the durable review and target Product Model revision and distinguishes the reviewed Canon, its exact approved result, and a later unrelated Canon. Non-document source drift still requires reconciliation; drift caused by this exact approved Canon can be rebuilt. Publication accepts only each reviewed preimage or exact target content, so partial publication can resume without overwriting later user edits.

An accepted application writes only the reviewed Product Model, derives revision parents, builds and verifies a child SourceSnapshot and GraphSnapshot, and then replaces the reviewed published drift with deterministic Markdown from that graph. A rejection does not mutate Canon. After either outcome, the immutable receipt is projected into a subsequent audit child GraphSnapshot and the deterministic Markdown view is advanced to that audit graph.

The receipt deliberately names the pre-audit application outcome. It cannot name the same GraphSnapshot that contains it because that would create a content-hash cycle. The later audit graph is derived evidence only; the immutable ReviewDecision and application receipt remain the authoritative transition records.

Failure does not roll back an already applied approved Canon or blanket-restore documents. The same durable decision resumes missing projections, including rejection after partial publication; no second approval is required. Status separates Canon application from projection readiness. A narrow P3 Evidence basis binds the review hash to the before-World identity, without copying approval or document bodies. Older interrupted work without that basis can reconstruct from the verified reviewed graph rather than demand reapproval. The existing candidate and immutable target projection supply preimage/target bytes. Later Canon, document pointers, and third-party edits are preserved; an old receipt is historical success, not a claim that current projections are ready. Canon replacement acquires its fixed temporary path exclusively and removes only that call's owned temporary after a partial write failure; a pre-existing `EEXIST` temporary is preserved.

## Artifacts

```text
.lode/document-changes/
  candidate-sets/<document-change-candidate-set-id>.json
  review-decisions/<document-change-review-decision-id>.json
  product-model-revisions/<product-model-id>.json
  applications/<document-change-application-id>.json
  application-bases/<document-change-review-decision-id>.json
```

The application receipt binds:

- ReviewDecision and CandidateSet identities and hashes;
- previous and resulting Product Model identities and hashes;
- before and after World Model, SourceSnapshot, and GraphSnapshot identities;
- the resulting DocumentProjection identity and hash;
- whether Canon changed;
- `activeRunMutation: none`.

All semantic identities are content-derived. Git commits, branches, GraphDB record IDs, provider sessions, filesystem locations, and timestamps do not participate.

## CLI

```text
lode-agent world-docs-review <project> --input <review.json>
lode-agent world-docs-apply <project> --review <document-change-review-decision-id>
lode-agent world-docs-review-status <project> --candidate-set <document-change-candidate-set-id>
lode-agent world-docs-review-read <project> --review <document-change-review-decision-id>
lode-agent world-docs-application-read <project> --application <document-change-application-id>
```

## Read-only MCP

```text
lode_document_change_review_status
lode_document_change_review
lode_document_change_application
```

MCP cannot record a review, apply one, write Canon, rebuild a graph, or publish documents.

## Explicitly deferred

- semantic extraction of structured Product Model changes from prose;
- automatic approval or application;
- bidirectional document synchronization and conflict resolution;
- Obsidian and Notion publication adapters;
- remote GraphDB materialization.
