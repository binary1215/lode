# Execution Lineage contract and Run lifecycle

## Review the outcome, not just the contract

Fresh Lode review asks whether the result serves the user's intended outcome and
its next actual consumer, which evidence supports that claim, and what remains
unverified. The existing review dispositions and authorization boundaries are
unchanged. A source-only fix may use source and focused regression evidence;
claiming that a Host feature works requires appropriate Host evidence. Neither
example imposes live testing on every task. Reuse sufficient current evidence.
A review-only request stays read-only even if earlier work was approved.

Read [`architecture.md`](architecture.md) and
[`authority-plane-contract.md`](authority-plane-contract.md) before changing
this lifecycle.

## State machine

For optional work-evidence organization, see the [artifact storage guide](artifact-storage.md).
Folder names and Step numbers do not create Run lineage or authority.

```text
Session
  -> verified ExecutionContract
  -> Run(active)
  -> ResultPacket
  -> Review(awaiting ReviewDecision)
  -> Session
```

Managed Runs require a persisted, digest-verified `ExecutionContract` bound to
one `WholePlanSnapshot` and one persisted `ContextCapsule`. Ordinary direct work
and Host delegation do not require this lifecycle. The contract records Lode's
task-local acceptance of the selected context; there is no EvidenceNeed-set or
Compiler coverage-proof digest gate. Lode judges semantic sufficiency.

A Run cannot finish with only a success string. Completion creates a `ResultPacket` containing evidence and verification. The project enters Review mode and blocks the next Run until Lode records a `ReviewDecision`.

Finish and review bind the exact validated request to the existing Run before
publishing its artifact, terminal Run state, and Session pointer. If interrupted,
the same request may finish the missing writes after restart. The artifact must
still independently verify; an intent is not a result or an approval. Affected Session fields are compared before advancing the pointer; unrelated
checkpoint updates do not become transition conflicts. Completed response-loss
replay is read-only, and changed inputs fail only that transition. No checkpoint,
new review gate, or separate per-retry journal is created. Normal status reads do
not repair state; explicit checkpoint integration remains a separate Lode action.

The active lineage protocol is `0.4.0`. Each current lineage artifact embeds its
verified [`AuthorityPlaneContract`](authority-plane-contract.md) boundary:
WholePlanSnapshot and ExecutionContract are P2 recovery/lineage records,
ResultPacket is P3 evidence with false recovery, Canon-mutation, and review
authority, and ReviewDecision is a P1 normative record. A ResultPacket can support
a decision but cannot create one or become the only recovery source.

The current implementation builds a deterministic Fresh Lode review projection and can run an authorized Codex or OpenCode one-shot invocation through the common supervised runtime path. A fail-closed application bridge converts only a completed, verified, transcript-free Run draft into the canonical `ResultPacket` and Fresh Lode projection. Provider-session resume or hydration is not required for meaning or recovery, and no runtime result manufactures a `ReviewDecision`; the calling Lode must consume the verified projection and provide that decision.

## Explicit mutation commands

Mutation commands accept JSON input files so structured authority and evidence are not flattened into shell strings.

Create a Whole-plan snapshot:

```text
node scripts/lode.mjs lineage-plan <project> --input <whole-plan.json>
```

```json
{
  "objective": "Deliver the accepted whole outcome",
  "plan": [
    { "id": "implementation", "outcome": "Bounded result" },
    { "id": "verification", "outcome": "Direct proof" }
  ],
  "invariants": ["Project canon outranks derived context"],
  "sources": [{ "uri": ".lode/instructions/project.md", "role": "verified-project-direction" }]
}
```

Compile and persist the task Context Capsule, then create an Execution Contract:

```text
node scripts/lode.mjs context-compile <project> --task "bounded task" --budget 32768
node scripts/lode.mjs lineage-contract <project> --input <execution-contract.json>
```

```json
{
  "wholePlanId": "whole-plan-<24 hex>",
  "capsuleId": "capsule-<24 hex>",
  "scope": "Make recovery status actionable for the CLI operator",
  "acceptanceCriteria": [
    "The operator can identify the affected operation and next action without treating optional recovery attention as a general work block",
    "Verify the claimed CLI projection behavior and preservation of recovery state with appropriate direct evidence",
    "Disclose unverified installation or live Host behavior instead of inferring it from source or fixture results"
  ],
  "constraints": ["Do not change material product direction"],
  "allowedActions": ["Edit and test local plugin source"],
  "forbiddenActions": ["Deploy or publish"]
}
```

Start the Run:

```text
node scripts/lode.mjs run-start <project> --contract execution-contract-<24 hex>
```

Finish through a Result Packet:

```text
node scripts/lode.mjs run-finish <project> --input <result.json>
```

```json
{
  "outcome": "Observed bounded result",
  "evidence": [
    { "uri": "test/example.test.mjs", "digest": "sha256-or-evidence-id", "summary": "What this proves" }
  ],
  "planDelta": "No change to the approved whole plan",
  "impactRadius": ["component-a", "contract-b"],
  "verification": [
    { "check": "test command", "status": "passed", "evidence": "output digest or summary" }
  ],
  "unknowns": []
}
```

Build the Fresh Lode review projection:

```text
node scripts/lode.mjs run-review-context <project>
```

The projection returns a content-derived `reviewContextId`. It contains the verified WholePlanSnapshot, ExecutionContract, ResultPacket, Capsule reference, authority, and review protocol. Executor transcript, raw failure logs, provider session state, and unpromoted repository instructions are explicitly excluded.

Review the pending result using that exact projection:

```text
node scripts/lode.mjs run-review <project> --input <review.json>
```

```json
{
  "reviewContextId": "fresh-head-review-<24 hex>",
  "disposition": "accept",
  "rationale": "The Result Packet satisfies the Execution Contract and whole-plan invariants.",
  "nextActions": ["Continue with the next accepted contract"]
}
```

Allowed dispositions are `accept`, `revise`, `expand`, `rollback`, and `escalate`.

`revise` and `expand` set a next-plan gate. Create a new generation linked to that ReviewDecision:

```text
node scripts/lode.mjs lineage-next-plan <project> --input <next-whole-plan.json>
```

```json
{
  "reviewDecisionId": "review-decision-<24 hex>",
  "plan": [{ "id": "revised-step", "outcome": "Evidence-driven next result" }]
}
```

The original objective is inherited and cannot be silently replaced. The new snapshot records `generation`, `previousWholePlanId`, and typed `refines` / `responds-to` links. The next Run must use a contract bound to this new snapshot. `rollback` and `escalate` remain blocked until explicit user-owned direction resolves them.

Result Packets may contain candidate knowledge:

```json
{
  "knowledgeProposals": [
    { "kind": "Claim", "statement": "Observed candidate fact", "evidenceRefs": ["evidence-id"] }
  ]
}
```

Fresh Lode may return recommendations inside the ReviewDecision:

```json
{
  "knowledgeProposalRecommendations": [
    {
      "proposalId": "knowledge-proposal-<24 hex>",
      "recommendation": "recommend-promotion",
      "rationale": "Direct evidence supports this candidate."
    }
  ]
}
```

Allowed recommendations are `recommend-promotion`, `reject`, and `defer`. They never mutate knowledge canon or gain instruction authority in this version.

## Read and verification surfaces

```text
node scripts/lode.mjs lineage-read <project> --artifact <lineage-artifact-id>
```

The read-only MCP tool `lode_lineage_artifact` exposes the same digest verification. Neither read surface promotes evidence, changes authority, or advances a Run.

## Failure boundaries

- missing or invalid contract: Run start fails closed;
- tampered plan, Capsule, contract, result, or review: digest verification fails closed;
- unfinished prior review: the next Run is rejected;
- Result Packet without evidence or verification: Run finish is rejected;
- result and whole-plan mismatch: ReviewDecision creation is rejected;
- missing or stale Fresh Lode review context id: ReviewDecision creation is rejected;
- revise/expand followed by an old or unrelated plan: the next Run is rejected;
- rollback/escalate without explicit user direction: the next Run is rejected;
- knowledge proposal or recommendation: remains authority-free and does not mutate canon;
- provider conversation loss: verified project artifacts remain sufficient to reconstruct the logical state.
- ResultPacket deletion after a later SessionRunCheckpoint: the exact checkpoint `nextExpectedResult` remains readable without consulting the deleted evidence.
