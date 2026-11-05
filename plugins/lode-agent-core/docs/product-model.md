# Product Model canon

Read [`architecture.md`](architecture.md) and
[`authority-plane-contract.md`](authority-plane-contract.md) before changing
this contract. The Product Model records user-owned product intent; it does not
infer authority from repository layout, generated graphs, Git history,
validation fixtures, or model output.

## Authority and lifecycle

`.lode/context/product-model.json` is mutable project canon for `FeatureGroup`, `Capability`, `Feature`, `Requirement`, `Constraint`, `Decision`, and optional schema-v2 `Policy`. New project initialization creates an explicit empty schema-v1 document. Existing schema-v1 bytes, protocol, hash, read, and replay behavior remain exact; schema v2 is entered only by an explicitly accepted Policy candidate or another already-authorized complete Product Model write. An older initialized project without the file is interpreted as the same empty semantic model until an authorized process creates the file, so migration does not invent product meaning.

An empty Product Model means “Lode has no approved product concepts yet.” Existing source files, tests, README headings, issues, or directory names remain Evidence and do not automatically become Features. The active onboarding flow can normalize immutable candidates from a provider Lode semantic proposal grounded in bounded current repository evidence, or from a structured new-project brief, but requires an explicit batch ReviewDecision before promotion into this canon. Directory structure is never converted into authoritative FeatureGroup taxonomy.

## Schema

Stable `key` values identify logical product entities across renames and description changes. Names and descriptions are revision content rather than identity. References use keys and are validated before the model can be indexed.

```json
{
  "schemaVersion": 2,
  "featureGroups": [
    {
      "key": "communication",
      "name": "Communication",
      "description": "User-facing communication experiences.",
      "parentFeatureGroupKeys": []
    }
  ],
  "capabilities": [
    {
      "key": "message-delivery",
      "name": "Message delivery",
      "description": "Deliver a message to its intended recipients."
    }
  ],
  "features": [
    {
      "key": "direct-message",
      "name": "Direct message",
      "description": "Send a message to one recipient.",
      "featureGroupKeys": ["communication"],
      "capabilityKeys": ["message-delivery"],
      "governedBy": [
        { "kind": "Requirement", "key": "delivery-confirmation" }
      ]
    }
  ],
  "requirements": [
    {
      "key": "delivery-confirmation",
      "statement": "Accepted messages expose delivery confirmation.",
      "description": ""
    }
  ],
  "constraints": [],
  "decisions": [],
  "policies": [
    {
      "key": "human-review",
      "name": "Human review",
      "description": "Require review for the selected product surface.",
      "statement": "Changes to communication require explicit user review.",
      "status": "active",
      "appliesTo": [
        { "kind": "FeatureGroup", "key": "communication" }
      ],
      "governedBy": [
        { "kind": "Requirement", "key": "delivery-confirmation" }
      ]
    }
  ]
}
```

Keys use letters, digits, dot, underscore, colon, or hyphen. Keys must be unique within each entity kind. FeatureGroup parent relations must be acyclic. Feature references to groups, capabilities, requirements, constraints, and decisions must resolve. A Decision has `status: "active"` or `"superseded"`. A Policy has `status: "active"` or `"retired"`, applies only to explicitly named Feature or FeatureGroup keys, and may cite exact Requirement, Constraint, or Decision keys through optional `governedBy` references. Empty references are valid. Neither application nor semantic references are inferred from group membership.

## Policy proposal and review

In conversation, Lode may use `lode_product_policy_propose` to record one immutable create, revise, or retire candidate against the exact current Product Model. The proposal can cite bounded local source evidence and exact semantic references, but missing optional evidence or references are disclosed rather than made a gate. It does not change Canon or block ordinary work. Lode presents the meaning, exact applications, references, evidence state, and impact as one compact decision card; only after an unambiguous current user decision may it call `lode_product_policy_review`. `lode_product_policy_status` is a read-only inspection surface.

Acceptance is the one protected transition: it rechecks the current Session, Product Model base, active Run conflict, candidate identity, and any bound local evidence, then records the ReviewDecision and writes the exact schema-v2 result under the common mutation lock. Exact replay completes only missing outputs of that same immutable decision and does not ask for another decision; when the approved Canon is already published, replay repairs only missing derived projection output. Rejection records the disposition without changing Canon. Candidate and ReviewDecision artifacts are projected into the graph for audit; there is no second Policy store.

After review, source evidence can change without silently revising or invalidating the accepted Policy. Status and lineage trace expose one shared bounded P4 currentness projection: each source is `unchanged`, `changed`, `missing`, or `not-assessed`, while external evidence remains `not-assessed`. Byte freshness is not semantic reassessment, does not require an automatic second review, and never blocks ordinary work. Lode may use the disclosed change as evidence for a new proposal when the task warrants it.

## Temporal projection

Indexing normalizes arrays and object fields, derives a `productModelHash`, and projects each logical product entity plus one immutable current Revision into the temporal GraphSnapshot. A logical entity keeps the same project-scoped identity when its name or description changes; its Revision identity changes with semantic content or explicit sorted parents.

Product relations use one canonical direction:

- `FeatureGroup -CONTAINS-> FeatureGroup`;
- `FeatureGroup -CONTAINS-> Feature`;
- `Feature -REALIZES-> Capability`;
- `Feature -GOVERNED_BY-> Requirement|Constraint|Decision`;
- `Policy -GOVERNED_BY-> Requirement|Constraint|Decision`, only for explicit semantic references;
- `Feature|FeatureGroup -GOVERNED_BY-> Policy`, only for explicit Policy applications;
- logical entity `-HAS_REVISION->` and `-CURRENT_REVISION->` immutable Revision.

These nodes and relations carry `authorityClass: "canon-projected"` because they are derived views of canon. They still have `instructionAuthority: false` and `promotionAuthority: false`: a GraphSnapshot never becomes canon or an authority mechanism merely because it contains a projection of canon.

Whitespace, object-field ordering, and set-like reference ordering do not change the semantic Product Model identity. A semantic change makes the stored World Model stale until explicit re-indexing creates and verifies a new immutable snapshot.

## Query and Context Compiler behavior

After `world-index`, product concepts can be traversed with the same bounded temporal query contract:

```powershell
node scripts/lode.mjs world-temporal <project> --query "Message delivery" --kind Feature,FeatureRevision,Capability --relations REALIZES,HAS_REVISION,CURRENT_REVISION --depth 2 --limit 100 --edge-limit 200
```

The Context Compiler may include a task-relevant bounded Product Context only from a current verified World Model. It records GraphSnapshot, query, and result digests, allows only `canon-projected` product relations, and excludes unreviewed candidates.

## Onboarding promotion

The project-scoped onboarding state machine stores candidate sets and `decisionScope: "product-canon-bootstrap"` ReviewDecisions separately from this file. Candidates have content-derived identities plus evidence, confidence, producer, source snapshot, and explicit false instruction/promotion authority flags. `accept-all` and dependency-complete `accept-selection` create a new normalized Product Model only after stale-source, Product Canon drift, conflict, and reference checks pass. `revise` creates a successor candidate set; `reject` leaves canon unchanged.

Acceptance records previous and resulting Product Model identities and immutable Product Model revision documents. It then rebuilds a child SourceSnapshot and verifies that the new Product Model identity is present in the current temporal GraphSnapshot before onboarding becomes ready. See [`onboarding.md`](onboarding.md) for the complete state and input contracts.

The temporal graph also projects the immutable candidate, Evidence, Unknown, ReviewDecision, and ProductModelRevision receipts needed to explain how a concept reached canon. These receipts do not become Product Model entities. Candidate nodes point to separate `ProductConceptReference` nodes, while only the reviewed resulting `.lode/context/product-model.json` content creates `canon-projected` Product entities and revisions.

## Document-change application

Edited generated Markdown remains a proposal and is never parsed into Product Canon. A scoped document-change ReviewDecision can accept a captured candidate set only when the user supplies a complete Product Model that passes this same schema and identity validation. Application verifies candidate bytes, the reviewed Canon identity, and the current World Model; writes the exact reviewed model; rebuilds a child SourceSnapshot and GraphSnapshot; verifies the resulting Product Model projection; and then reconciles Markdown. Rejection reconciles the view to the current graph without changing Canon. See [`document-change-review.md`](document-change-review.md).

## Explicitly deferred

This slice does not treat inferred code or documentation meaning as canon without review. Feature-to-code, Feature-to-test, and ChangeSet-to-product impact mappings use separate immutable candidates and explicit ReviewDecision contracts, but they do not mutate Product Canon. Provider-neutral ChangeSets record reviewed change lineage rather than redefining product intent. Deterministic Markdown is a derived GraphSnapshot view, edited pages become candidates rather than Product Canon, and their reviews/applications are projected into later audit GraphSnapshots. Dedicated imported-backlog adapters, broader conformance relations, and Obsidian/Notion projections remain deferred.
