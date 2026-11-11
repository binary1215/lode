# Conversation UX contract

Read this when you carry an ordinary request through Lode: entering a
conversation, agreeing on work, waiting, recovering, presenting a decision or
reporting an outcome. Lode's authority and recovery contracts are internal
safety mechanisms, not a setup ceremony for the user.

## Task-first entry

1. Keep the user's original task and continue it in the same turn after Core
   initialization or resume, unless a real authority, scope, integrity or
   destructive-action boundary needs the user.
2. Use Core initialization/resume only for first adoption, a missing Project,
   explicit Session selection/resume or required installation convergence, and
   only in a repository that already has Lode or when the user asks for it.
3. Otherwise use the verified entry context already supplied for the exact
   Project and selected Session, with its current direction and cancellations.
   If something is missing, call read-only `lode_conversation_enter` once and
   expand only the dependent originals. Identity, digest or time alone does not
   prove current intent.
4. When a relevant source, direction or cancellation changes, read the affected
   current originals before dependent action instead of repeating setup.

Product governance, World construction, durable Runs, managed workers and
provider execution stay optional.

## Graph-first information and Session continuity

Query `lode_project_graph` for new project information, or reuse a sufficient
same-basis result. Read its basis, revision and coverage: absence under partial
coverage is not absence of facts. Continue from original sources when the graph
is absent or a layer fails, and check the current sources and your authority
before an effect.

Use separate logical Sessions when work needs its own progress and recovery.
Route each request explicitly without switching the default Session. A
restored earlier step does not undo a common cancellation, and a scope change in
one Session does not redirect another. The user maintains no Session IDs.

## Agreement and implementation

- Reuse a concrete user agreement that still holds for the current request,
  constraints and cancellations.
- Ask only about an unresolved, material choice. Small exact fixes proceed
  directly; analysis or proposal requests stay read-only.
- Investigation and preparation stay within current authority, and
  reversibility grants no extra permission. Only work that depends on an
  unresolved choice waits.
- For nontrivial implementation, state the agreed behavior, scope, acceptance
  and important uncertainty in the existing work context; Lode owns routine
  design, verification and error handling.
- Re-agree only a material change to user-visible behavior, scope, conditions,
  authority, external effects or an important user-owned architecture choice,
  with its delta, impact and options.

**Authority.** Recovered agreements are reconciled with current requests and
cancellations and do not authorize execution by themselves. Summaries, reviewer
assent, model inference and keywords create no user authority. A short reply
counts only when it clearly answers a concrete proposal and scope. A new or
changed protected target needs the current user decision described in
[Decision presentation](#decision-presentation).

**Management records.** A management-record failure limits only dependent
management work. It cannot turn a primary identity, digest, permission or
partial-write failure into success, or replace a required ReviewDecision.
Saving grants no execution permission. Preserve completed effects and
reconcile uncertain ones rather than replaying work to repair records.

## Direct work and ordinary delegation

1. Work directly unless independently reviewable contributions help; then use
   the Host's own delegation tools with a short brief and an ownership boundary.
   Ordinary parallel work needs no managed worker or wave.
2. When a contribution fails, keep its usable evidence and continue independent
   work. Redo the unfinished part only after confirming it left no effects; an
   unknown side effect is reconciled, not replayed.
3. Integrate current results, keep intervening user changes, and report the
   combined outcome and its limits.

Use managed execution only when durable recovery or effect tracking is useful;
Lode supplies that route without another user choice.

## Waiting and resumption

When a wait matters to the task, name the dependency, the next actor or event,
and the independent work that can continue. Describe automatic resumption only
when a Host mechanism confirms it. Keep submitted, delivered, active and
completed apart; when observation is unavailable, report the last known fact and
the uncertainty. Use the Host's waiting mechanisms instead of repeated notices
or polling.

## Recovery presentation

A `.lode/` folder does not prove that a restorable checkpoint exists. Recovery
readiness has three states:

- **no current checkpoint:** continue ordinary Session work;
- **verified current checkpoint:** read the restore projection before continuing;
- **attention required:** disclose the exact recovery failure; direction is not
  rebuilt from a summary, transcript, graph, Capsule or message.

Entry is read-only: it consumes no continuation token and rewrites no
checkpoint. With a trusted Host lifecycle event, Lode calls the lifecycle step
itself; the user supplies no event, epoch, turn or token fields. A new user
request supersedes a prepared continuation for future work only.

**Diagnosis.** When entry reports recovery attention, or the user asks why
recovery is unavailable, call `lode_checkpoint_diagnose` and present its one
bounded reason and next Lode action. Treat `observation-changed-retry` as a
request for a fresh read.

**Publishing direction.** Persist only when direction materially changes, a
verified stage completes, work starts failing or waiting, the task completes, or
a handoff or context loss approaches, and the existing checkpoint is no longer
sufficient. Then:

1. read a fresh `lode_checkpoint_basis` (a diagnosis does not replace it);
2. derive the direction from that exact basis;
3. call `lode_checkpoint_sync`.

`created` and `reused` are quiet success. `deferred` and `conflict` are
Lode-owned follow-up for that recovery path; they block no independent work and
imply no user decision.

## Decision presentation

Present a protected decision as a compact card: the exact subject, why it is
needed now, evidence and impact in the user's language, the bounded
dispositions, and an optional recommendation labeled as advisory. Candidate IDs
are not the primary interaction.

Before applying the reply, re-read the exact current candidate or Finding and
verify that the target is unique and unchanged. Lode interprets the reply
itself; a Core regex, keyword matcher, silence or default disposition is never
an answer. A short reply such as "yes" counts only when it unambiguously answers
one immediately pending decision. Provider summaries, model recommendations,
confirmation booleans and earlier decisions are not substitutes for the current
user's reply.

For a Policy, show its plain-language statement, exact application targets,
evidence state, and whether it is created, revised or retired.

## Outcome presentation

Use the returned reasons, changes and uncertainty to choose the next authorized
work and check its actual outcome. User-facing explanation can use the optional
[Lode conversation](../../lode-conversation/SKILL.md) Skill.

Keep these apart: review completion and acceptance; context coverage and
semantic sufficiency; worker or wave success and whole-task completion; a
ResultPacket and acceptance; a commit and a push; a deployment observation and
product success.

- **Entry and status** are quiet: one line unless the user asks or a real
  exception exists, which names its owner, reason, operation and next action.
  `userDecisionRequired` means a real protected decision; `headActionRequired`
  means Lode acts. Neither blocks ordinary work, and an optional Product review
  (`when-product-governance-is-in-scope`) is a notice.
- **Metric comparisons:** lead with the number, then the collection conditions
  that differ or are unknown; no normalization or causality is established.
- **Delivery state:** lead with the environment summary and say "observed
  targets"; show target detail for mixed, failed, rolled-back or unknown state.

## Optional product evidence

Read only the part the current outcome needs. When an optional tool is not in
the default list, inspect it with `lode_tools_discover` and call its returned
`invokeWith` route; the operation still enforces its own checks. In every path
below, the user supplies ordinary language, not IDs, digests or JSON, and an
explicit user disposition is what changes Product Canon.

- **Observations** ([adapters](../../../docs/observation-adapters.md)): persist
  external facts only for a durable cross-Run, audit, handoff or context-loss
  need. Call `lode_observation` (`prepare`) for the one exact `typeKey`; reuse a
  sufficient record via `lode_observation` (`read`) or (`query`); otherwise call
  (`collect_source`) with a configured source, or disclose the adapter gap and
  continue. Cite a record through an EvidenceNeed with exact `observationIds`.
  An adapter payload creates no Signal, candidate, decision or recovery
  direction.
- **Policies** ([Product model](../../../docs/product-model.md)): call
  `lode_product` (`policy_propose`) with exact Feature or FeatureGroup
  applications, present one card, and call (`policy_review`) only after the user
  accepts or rejects that exact candidate.
- **Metrics** ([operating loop](../../../docs/product-operating-loop.md)):
  report each collection condition as `same`, `different` or `unknown`; an
  assessment is a ProductHypothesis, and a follow-up is `lode_product`
  (`initiative_propose`) citing it.
- **Delivery** ([delivery](../../../docs/delivery-observation.md)): summarize
  `lode_delivery` (`status`) as `uniform`, `mixed` or `unknown`; a trusted Host
  adapter records with (`observe`). `delivery.state` always uses this dedicated
  call, never generic Observation ingestion.
- **Conformance** ([reconciliation](../../../docs/conformance-reconciliation.md)):
  `lode_conformance` (`prepare`), then your own semantic comparison cited with
  exact anchors in (`propose`); read (`queue`) in pages at work boundaries. Lode
  may acknowledge or defer a Finding; closing or dismissing one needs the user's
  disposition through (`disposition`). A Finding is evidence, not a violation.
- **Feature mapping** ([mapping](../../../docs/feature-mapping.md)):
  `lode_feature_mapping` (`propose`) with exact Product and source or test node
  identities, not names; (`review`) with `confirm_user_review: true` only after
  the user's explicit disposition.
