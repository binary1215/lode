# Project onboarding

Ordinary work starts with Core. This guide configures the optional Product model; its initialization examples select `--profile product`.

Read [`architecture.md`](architecture.md) and
[`authority-plane-contract.md`](authority-plane-contract.md) before changing
this contract. Onboarding bootstraps product authority; it does not grant
authority to repository structure, model inference, Git, GraphDB, a validation
fixture, or a provider conversation.

## State and authority

Initialization now creates:

- an immutable project-scoped `LodeSession` record under `.lode/sessions/records/`;
- a digest-verified `.lode/onboarding/current.json` state pointer;
- an immutable local-default `OnboardingStorageSelection`;
- the empty user-owned `.lode/context/product-model.json` canon.

The Lode Session identity is independent from Claude Code, Codex, OpenCode, and all other provider conversation IDs. Older initialized projects report `migration_required` through read-only inspection. The next mutating onboarding command creates the missing Session record, local storage selection, and state pointer while preserving the existing Session ID and Product Model identity.

State-pointer protocol `0.2.0` names the most recent decision as
`latestReviewDecisionId`. Current Core no longer interprets state protocol
`0.1.0`; projects that still use it require the separately pinned legacy
migrator or a separately reviewed recovery path. A successor candidate separately names the `revise` decision
that produced it as `producerReviewDecisionId`; the producer and latest review
are intentionally different after that successor is accepted or rejected.

The state machine is:

```text
initialized
  -> explicit World Model index
  -> awaiting-review | awaiting-evidence | ready(existing canon)
  -> revise -> successor immutable candidate set -> awaiting-review
  -> reject -> rejected
  -> accept-all | accept-selection
       -> new Product Model revision
       -> new child SourceSnapshot and verified GraphSnapshot
       -> ready
```

Fresh Lode semantic proposals and user-owned briefs create `OnboardingCandidateSet` evidence with `instructionAuthority: false` and `promotionAuthority: false`. Core does not infer product meaning from symbol names, repository paths, README headings, or lexical rules. It verifies every proposed source path, digest, line, optional symbol, Product Model reference, and resource bound against the current World Model. Only an explicit `ReviewDecision` with `decisionScope: "product-canon-bootstrap"` may write Product Canon. A candidate is never mutated or relabeled: revision creates a successor candidate with a new identity, and acceptance creates separate canon plus an immutable decision receipt.

Candidate protocol `0.4.0` derives candidate-set identity from project, Session, mode, exact SourceSnapshot, Product Model input, bounded semantic proposals, verified Evidence, Unknowns, ancestry, producer ReviewDecision, and producer policy. It deliberately excludes the derived World Model ID so authority review is not coupled to a materialized-view pointer. Candidate sets from the retired lexical-inference protocols are rejected and must be replaced by fresh Lode semantic proposals against the current SourceSnapshot.

## Historical onboarding boundary

Completed candidate protocols `0.1.0` through `0.3.0` are interpreted only by
the standalone package documented in
[`onboarding-migrator.md`](onboarding-migrator.md). The current plugin does not
ship, import, invoke, or expose that parser through MCP. A successful one-shot
apply writes only a create-only P3 boundary, application receipt, and final
commit marker. Historical candidates and their reviews then remain opaque,
while Product Model revisions that independently pass the current verifier keep
their original P1 status.

Normal status, World, Context, Session recovery, and new current onboarding work
continue without the helper. If product meaning should change, the provider
Lode authors a fresh current semantic proposal with
`lode_onboarding_semantic_refresh` or `onboarding-semantic-refresh`; the user
then reviews the new candidate through the ordinary ReviewDecision path. The
first current candidate does not reuse a historical candidate as typed ancestry.
Instead, a P3 continuity receipt and P4 `HISTORICALLY_FOLLOWS` edge preserve only
historical continuity and grant no instruction, recovery, or promotion authority.

## Public initialize and resume path

The preferred human-facing path is the bundled `lode-agent-onboarding` Skill
inside a Claude Code, Codex or OpenCode conversation. It first calls the read-only
`lode_onboarding_guide` tool, asks only for unresolved material choices, and
then invokes the same Core through typed MCP operations:

- `lode_project_initialize_or_resume` for idempotent project and Lode Session
  composition;
- `lode_onboarding_review` for an explicit evidence-linked candidate decision;
- `lode_markdown_projection_build` for a derived, recoverable document view.

The Skill does not create a second onboarding protocol. The provider Lode may
inspect current repository evidence and author a typed `semantic_proposal`, but
the Core validates and gates that proposal and the user still owns the
ReviewDecision. The Skill cannot infer a user ReviewDecision, widen source
scope, or persist GraphDB credentials. If MCP is
unavailable, the CLI below is the equivalent recovery and automation surface.

The primary public command composes project creation or verification,
installation-projection convergence, and onboarding start or resume:

```powershell
node scripts/lode.mjs init C:\path\to\project --runtime claude,codex,opencode --input .\onboarding.json --profile product
node scripts/lode.mjs resume C:\path\to\project --runtime claude,codex,opencode --profile product
```

The first command creates exactly one project-scoped Lode Session and starts
onboarding. Repetition verifies the existing project/runtime binding. A pending
candidate review or ready Product Canon is returned without rewriting the
onboarding pointer or creating duplicate authority artifacts. After a plugin
upgrade, only drift-free managed OpenCode configuration is converged to the new
verified release path; user-modified or unowned configuration fails closed.

The same path can be invoked during installation:

```powershell
.\scripts\install.ps1 --project C:\path\to\project --runtime claude,codex,opencode --onboarding-input .\onboarding.json --profile product
```

## Low-level onboarding restart

Already initialized projects can explicitly restart an `initialized`,
`awaiting-evidence`, or `rejected` onboarding phase with the lower-level command:

```powershell
node scripts/lode.mjs onboarding-start C:\path\to\project
node scripts/lode.mjs onboarding-status C:\path\to\project
```

An existing project indexes code and documentation first. If no user brief or fresh Lode semantic proposal is supplied, onboarding stops at `awaiting-evidence` with an explicit Unknown; it does not manufacture product concepts from code vocabulary. A proposal contains at most 200 candidates, each with one through eight current source citations, while the set remains capped at 250 evidence records and 100 Unknowns. Each citation must name an exact project-relative path and valid line, may add an exact indexed symbol, and may include a digest as an optimistic freshness guard. Core always binds the verified current World digest itself. Stale, hallucinated, out-of-scope, oversized, or structurally invalid proposals fail closed. Valid proposals remain P3 candidate evidence until explicit user review.

### Repository source scope

Before indexing, the user may persist a project-relative observation boundary. Empty `includeRoots` means the whole eligible repository; `excludeRoots` always wins. Roots are normalized paths, not globs, and the selection is content-derived evidence with no instruction or promotion authority.

```json
{
  "includeRoots": [],
  "excludeRoots": [".generated-evidence", "bundled-third-party", "generated-copy"]
}
```

Supply this object as `sourceScope` inside the public `init --input` document so
the boundary exists before the first index. The low-level `source-scope-set`
command remains available for an initialized project before an explicit
`onboarding-start`, or for a later reviewed rescan. The exact scope identity is
embedded in `RepositoryScanResult` and the World Model source digest. A later
scope change makes the existing index stale; it never edits Product Canon or an
accepted Capsule.

A new-project brief uses the Product Model entity schema while remaining a candidate until review:

```json
{
  "mode": "new",
  "brief": {
    "schemaVersion": 1,
    "name": "Message service",
    "summary": "Deliver messages with explicit verification.",
    "featureGroups": [
      {
        "key": "group:communication",
        "name": "Communication",
        "description": "User-facing communication.",
        "parentFeatureGroupKeys": []
      }
    ],
    "capabilities": [
      {
        "key": "capability:delivery",
        "name": "Delivery",
        "description": "Deliver one accepted message."
      }
    ],
    "features": [
      {
        "key": "feature:direct-message",
        "name": "Direct message",
        "description": "Send one message to one recipient.",
        "featureGroupKeys": ["group:communication"],
        "capabilityKeys": ["capability:delivery"],
        "governedBy": []
      }
    ],
    "requirements": [],
    "constraints": [],
    "decisions": []
  }
}
```

```powershell
node scripts/lode.mjs init C:\path\to\project --input .\onboarding-start.json --profile product
```

A project whose Product Canon already contains approved entities skips candidate bootstrap, still indexes implementation evidence, verifies the Product Model projection, and enters `ready`.

## Storage selection

Local materialization is complete and is the default. ArcadeDB can be selected without making it a prerequisite:

```json
{
  "mode": "existing",
  "storage": {
    "mode": "graphdb",
    "endpoint": "https://graph.example.test",
    "database": "head",
    "secretReferenceNames": {
      "username": "LODE_GRAPHDB_USERNAME",
      "password": "LODE_GRAPHDB_PASSWORD"
    }
  }
}
```

Only endpoint, database, and environment-style secret-reference names are persisted. Embedded URL credentials, password/token fields, and credential values are rejected. The immutable selection records its status at selection time as `pending-unverified-adapter`, and onboarding continues through local JSON with explicit disclosure.

`LODE_GRAPHDB_USERNAME` and `LODE_GRAPHDB_PASSWORD` are caller-chosen reference
names in this new-configuration example, not an automatic environment alias
mechanism. An existing selection keeps its exact saved names, including any
`HEAD_GRAPHDB_USERNAME` and `HEAD_GRAPHDB_PASSWORD` references; do not rename
them or rewrite selection digests as part of a package update.

After the first current GraphSnapshot exists, inject both referenced environment variables outside the conversation and restart the host so the plugin process inherits them. The normal conversation path calls `lode_graphdb_connection_preflight` first. That exact-child check performs no network request and returns only the configured reference names and their presence booleans; it never returns credential, endpoint, or database values. Once both references are present, the Skill calls `lode_graphdb_database_status`, obtains explicit user confirmation, calls `lode_graphdb_database_initialize`, obtains a separate remote-write confirmation, and calls `lode_graphdb_projection_activate`. These typed MCP operations accept confirmation and exact-target reset evidence but never credential values. The equivalent recovery/automation CLI is `world-graph-remote-database-status`, `world-graph-remote-database-initialize`, and `world-graph-remote-activate`.

Unrelated existing schema is compatible and preserved. Reset is available only for a proven conflict with a Lode-reserved type and requires `reset_incompatible: true` plus the exact selected database through MCP, or `--reset-incompatible true --confirm-database <exact-selected-name>` through CLI. Activation uploads a verified resumable GraphSnapshot delta, proves complete reconstruction and bounded traversal equality against the local adapter, then advances the remote pointer by exact-predecessor compare-and-swap and persists separate content-addressed activation and sync receipts. `world-graph-remote-status`, `lode_graphdb_projection_status`, and `lode_graphdb_database_status` report operational state without exposing credential or target values. A failed initialization or activation leaves the complete local graph mirror as the recovery path and cannot promote Product Canon.

## Batch review

Read the current candidate set with `onboarding-status` or `onboarding-candidates`. Review input must name the exact current `candidateSetId`; stale source, Product Canon drift, candidate tampering, or a different set fails closed.

Accept all candidates:

```json
{
  "candidateSetId": "onboarding-candidates-<24-hex>",
  "disposition": "accept-all",
  "rationale": "Adopt the reviewed bootstrap batch."
}
```

Accept a dependency-complete selection:

```json
{
  "candidateSetId": "onboarding-candidates-<24-hex>",
  "disposition": "accept-selection",
  "acceptedCandidateIds": ["onboarding-candidate-<24-hex>"],
  "rationale": "Adopt only the reviewed capability."
}
```

Revise candidates without changing canon:

```json
{
  "candidateSetId": "onboarding-candidates-<24-hex>",
  "disposition": "revise",
  "userEdits": [
    {
      "candidateId": "onboarding-candidate-<24-hex>",
      "entity": {
        "key": "capability:delivery",
        "name": "Verified delivery",
        "description": "Deliver and verify one accepted message."
      }
    }
  ],
  "addedEntities": [],
  "removedCandidateIds": [],
  "rationale": "Use reviewed product language before promotion."
}
```

`revise` produces a new immutable candidate set linked to the prior set and its
producer ReviewDecision. A later acceptance or rejection records a separate
latest ReviewDecision over that successor; the two identities are not required
to match. Additions and removals require this two-review path; they cannot be
introduced and promoted in the same decision. `reject` records all candidates as
rejected and leaves Product Canon unchanged.

```powershell
node scripts/lode.mjs onboarding-review C:\path\to\project --input .\onboarding-review.json
node scripts/lode.mjs onboarding-review-read C:\path\to\project --review onboarding-review-decision-<24-hex>
```

## Promotion and recovery

Acceptance validates stable keys and references, rejects conflicts, then persists
the explicit P1 ReviewDecision, followed by the previous/resulting immutable
Product Model revisions, before publishing Canon and its onboarding pointer. Graph rebuild
comes afterwards and cannot create or revoke approval. Public readiness becomes
`ready` only with a current digest-verified projection of that approved identity.

If publication is interrupted, read-only status exposes
`promotion_recovery_pending` without repairing state or blocking ordinary Core
work. Product resume or an exact retry completes the already approved transition
from its verified ReviewDecision and revisions; a missing revision can be
reconstructed only from the exact approved candidates/edits and the verified
previous Canon, with the resulting hash checked against that decision. No duplicate user review is
required. A divergent retry, tampered revision, or unrelated current Canon cannot
overwrite the accepted decision or newer state. If only Graph rebuild fails,
`onboarding_approved_projection_pending` preserves approval and reports the
remaining projection work. A partial graph is derived evidence, never recovery
authority. No additional transaction artifact is created for each retry.

Revision and rejection also persist their exact P1 decision before publishing a
successor or phase pointer, then rebuild Graph. Interrupted application reports
`review_recovery_pending`; failed derived publication reports
`onboarding_review_projection_pending`. Resume completes the recorded decision
without another user decision, and an exact retry returns the same result. A
rejected set stays rejected on a plain resume. A legacy orphan Graph containing
an unrecorded decision is rebuilt from persisted canonical artifacts, never used
to manufacture that missing decision.

Missing World pointers or snapshots are optional derived-data loss, not loss of
Product approval or P2 direction. Entry, status, and Core resume remain read-only
and usable while reporting Product/Context refresh needs. Explicit Product resume
can rebuild the derived view from retained artifacts; it does not reapprove Canon.
Malformed Canon, decisions, or digest mismatches remain errors rather than being
classified as harmless absence.

Windows may briefly reject publication of an otherwise free refresh lock. The
P5 lease retries only the same verified staging directory, with at most 150 ms
of backoff, under its existing management mutex. It never repeats the World
operation or user decision. Occupied or modified paths are not overwritten;
exhaustion reports the operational failure while preserving any durable approval.

Later source changes do not erase the historical onboarding decision. Read-only
status reports `ready_world_changed` while current World evidence is unavailable
or stale. After an explicit refresh verifies the current Canon and onboarding
decision projection, readiness returns to ready without replacing historical
approval snapshot IDs or asking for another approval. An unchanged refresh stays
ready. A missing World base is rebuilt with explicit `world-index`; an existing
stale base uses `world-refresh`. Status never runs either operation implicitly.

The read-only MCP tool `lode_onboarding_status` verifies the state pointer, Session record, storage selection, current candidate set, successor-producing ReviewDecision, latest phase-appropriate ReviewDecision, Product Model revisions, Product Canon identity, and World Model freshness. For a review-pending successor the producer is also the latest decision; for `ready` or `rejected`, the latest decision must directly review the current successor and carry the matching acceptance or rejection disposition. The separate `lode_onboarding_review` transaction accepts only an explicit user-authored disposition against the exact current candidate-set identity and delegates every promotion check to Core.

## Temporal graph projection

Current World snapshots project onboarding through temporal provenance protocol
`0.15.0`. Candidate sets connect to exact source evidence, candidates connect to
Evidence and separate proposed product-concept references, and ReviewDecisions
preserve accepted, rejected, revised, and promotion outcomes. A revise decision
has an explicit `PRODUCES` edge to its successor candidate set; a later accepted
decision separately connects to immutable previous/resulting ProductModelRevision
receipts, and the resulting receipt links back to the promoted candidate identities.
Opaque historical candidate references expose only bounded IDs and digests and
connect to a fresh current candidate solely through `HISTORICALLY_FOLLOWS`.

This graph is an audit and traversal projection, not the decision source. All projected node and edge instruction/promotion flags are false, even when the source ReviewDecision records the user's promotion authority. Normal traversal hides CandidateSet, candidate, Evidence, Unknown, and proposed-concept nodes. A user can explicitly inspect them with `world-temporal --include-candidates true` or MCP `include_unreviewed_candidates: true`; the Context Compiler never enables that option. Reviewed decision and ProductModelRevision receipts remain available in normal reviewed traversal.

Run the dependency-free verifier with:

```powershell
npm run verify:onboarding
```

It covers existing code, a new-project brief, empty evidence, revision followed by acceptance, selection, or rejection, phase-aware producer/latest review lineage, deterministic restart, candidate/review/promotion graph projection, default candidate exclusion, explicit candidate traversal, graph and artifact tampering, pre-existing canon, stale source, secret rejection, legacy migration, read-only status MCP, and operation without Git, GraphDB, or a Go binary. `npm run verify:conversational-onboarding` separately proves the typed conversation-native `revise -> guide -> accept -> guide` vertical.

## Explicitly deferred

- an executed live prepared-query evaluation, compare-and-swap publication, and non-ArcadeDB transports;
- dedicated imported-backlog connectors beyond an explicit structured brief;
- general relationship promotion beyond the separate Feature/code/test mapping review scope;
- automatic semantic promotion, document synchronization, and merge/conflict resolution.

## Optional integrity and candidate recovery

Known Product/World/Graph integrity errors appear in existing readiness and Attention views; they do not block healthy Core entry, conversation recovery or ordinary work. The affected Product operation still verifies its evidence strictly. Lode handles diagnostics rather than asking users to fill recovery forms.

For a damaged or missing candidate with a verified original, use `lode_onboarding_candidate_restore` (CLI `onboarding-candidate-restore`). Lode supplies exact Project/candidate identity, original content and the observed raw digest. The operation preserves damaged bytes in recovery custody, checks concurrent changes and atomically replaces only the exact target. Equal canonical content is not a claim of identical raw bytes. Restoration creates no approval, Canon change or P2 direction.

Without an original, only a damaged unreviewed/unreferenced current candidate can use the existing semantic refresh with `recoveryBasis`. Lode supplies a fresh evidence-linked proposal; Core never invents product meaning or inherits old approval. Canon and lineage preconditions are checked before relocation. Damaged bytes remain in digest-addressed custody; a failed call restores them only if the pointer is unchanged and the original path is absent. After process loss, repeating the same pointer/raw basis recovers that exact custody before resuming. Other files, later pointers and new edits are never rolled back. Reviewed candidates require exact restoration rather than semantic replacement.

<a id="product-cli-examples"></a>

## Product CLI examples

### Conversation-first path

The bundled `lode-agent-onboarding` Skill is the interactive entry for optional Product onboarding.
It inspects the current state, asks only for material choices such as repository
scope or storage mode, semantically analyzes bounded current evidence, submits a
typed proposal for Core verification, presents the resulting evidence-linked
candidates, and uses explicit review before Product Canon changes. It selects
the `product` profile explicitly. The provider proposal remains P3 evidence.

### Optional Product profile CLI path

Initialize or resume the same project and Lode Session identities:

```powershell
lode-agent init C:\path\to\project --runtime claude,codex,opencode --profile product
lode-agent onboarding-status C:\path\to\project
```

Without a structured user brief, first use intentionally returns
`awaiting-evidence`; Core does not invent product concepts from symbols. The
conversation Skill normally supplies the fresh semantic proposal. CLI users may
pass the same `semanticProposal` inside `--input`; after Core verifies the exact
SourceSnapshot, paths, lines, optional symbols, and Product Model references, an
immutable candidate-set ID is returned. Inspect it before review:

```powershell
$onboarding = lode-agent onboarding-status C:\path\to\project | ConvertFrom-Json
lode-agent onboarding-candidates C:\path\to\project `
  --candidate-set $onboarding.state.candidateSetId
```

Create `onboarding-review.json` only after reviewing the evidence. This compact
example accepts the complete bootstrap batch; selection or revision is safer
when any candidate should be renamed, split, merged, or excluded.

```json
{
  "candidateSetId": "onboarding-candidates-<id>",
  "disposition": "accept-all",
  "rationale": "I reviewed every evidence-linked candidate and adopt this bootstrap batch."
}
```

Apply the decision and verify the resulting views:

```powershell
lode-agent onboarding-review C:\path\to\project --input .\onboarding-review.json
lode-agent graph-query C:\path\to\project --query "<task>"
lode-agent world-status C:\path\to\project
lode-agent context-preview C:\path\to\project `
  --task "Find implementation evidence for one reviewed Feature" --budget 32768
lode-agent world-docs-build C:\path\to\project
lode-agent resume C:\path\to\project --runtime claude,codex,opencode --profile product
```

`accept-all` is supported for a fully inspected batch, but it is not the default
recommendation. Review can instead accept a dependency-complete selection,
revise or reject the batch, request more evidence, or retain explicit Unknowns.
See [Onboarding](onboarding.md) for the complete contract.

### Source scope

For repositories with generated output, vendored dependencies, copied projects,
large fixtures, or model bundles, define a project-relative observation boundary
before the first index:

```json
{
  "mode": "existing",
  "sourceScope": {
    "includeRoots": ["src", "packages"],
    "excludeRoots": ["dist", "vendor", "generated", "fixtures"]
  }
}
```

Pass it with `lode-agent init ... --profile product --input .\onboarding.json`. Source Scope
controls observation only; it cannot define Product Canon, approve a candidate,
or grant execution authority.
