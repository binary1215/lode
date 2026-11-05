# Authority and roles

Read `../../../docs/authority-plane-contract.md` for the executable five-plane
artifact classification and Graph/record boundary.

## Lode

Lode owns ordinary investigation, whole-outcome understanding, execution strategy, context composition, integration, and completion judgment. Lode keeps one primary flow connected from authoritative input to the result consumed next.

## User

The user owns material product direction, policy, architecture, cost, workflow, irreversible impact, and consequential external action. Ask only when the missing choice would materially alter the result.

## Developer

Developer owns one bounded, independently consumable implementation result. The brief supplies the boundary and canonical evidence; Developer returns the result plus direct execution evidence.

## Coder

Coder implements a fully decided bounded scope: one Session request or a Run contract. Any missing choice that could alter observable behavior is a scope conflict returned to Lode. Session results remain evidence; Run result application retains Fresh Lode review and explicit integration.

## Reviewer

Reviewer provides an independent evaluation when useful, including a bounded second opinion. Reviewer tests options and assumptions against evidence appropriate to the user's question but does not implement or choose the final direction.

Detailed inspection returns facts, counterexamples and exact candidate evidence.
Lode integrates them against the preserved criteria and current user conditions;
inspection history is not automatically the next planning context. Integration
may inspect material originals directly and update the plan from learned facts.

Completing a review completes that contribution, not the reviewed implementation.
A favorable verdict remains evidence; it does not create a ReviewDecision or
authorize a new scope. Lode integrates findings under the existing user request
and applicable Run contract. Do not add another approval step for ordinary fixes
already authorized by the user.

## Invariants

- Provider session identifiers are not Lode Session or Run identifiers.
- Canonical files outrank conversation summaries and logs.
- Managed file drift stops state mutation until reconciled.
- One project ID maps to one canonical root.
- A Project has common current user direction and multiple request-local logical
  Sessions. Their progress is independent; routing never overwrites the default
  Session or restores a superseded shared cancellation as current permission.
- Graph-first discovery may expose intact historical, candidate and rejected
  evidence with its original revision/state. Partial absence is not proof of
  absence, and source fallback needs no World/Product/Run/DB readiness gate.
- Capability never implies authorization.
- ResultPacket and Worker Report are P3 evidence; SessionRunCheckpoint is the P2 recovery record; ReviewDecision is a P1 normative record.
- ProductCanonFeature and ReviewedFeature are P1; FeatureCandidate and ProductFeatureCandidate are P3. A graph label never promotes a candidate.
- An accepted ProductPolicyReviewDecision is P1 and changes only its exact candidate-bound Product Model revision. ProductPolicyCandidate and its evidence are P3; evidence-currentness and graph lineage are P4. Evidence drift never silently revokes or revises Canon.
- Metric definitions, collected observations, derived comparisons, and assessment hypotheses are P3 evidence; status and trace are P4 views. Adapter or collection-condition equality is evidence, never product success, causality, approval, or recovery direction.
- P3 evidence, P4 views, and P5 effects cannot be promoted into P2 recovery authority; checkpoint fields come only from explicit Lode/user direction and verified P2 lineage.
- Artifact-only Session restore is a non-persisted P4 projection; it reproduces a P2 checkpoint direction but cannot replace or rewrite that checkpoint.
- An accepted ResultPacket may be checkpoint-integrated only after its exact P1 ReviewDecision, and the P3 integration receipt cannot author recovery fields.
- GraphSnapshot, GraphDB, traversal, Markdown, and continuity views are P4 derived indexes/views and cannot mutate Product Canon.
- PID, tokens, proofs, endpoints, inboxes, delivery receipts, and provider-session references are P5 operational effects and cannot become meaning or recovery authority.
- Distribution and Host are architectural planes outside the semantic authority lattice.
