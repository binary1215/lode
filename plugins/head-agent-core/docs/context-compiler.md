# Lode Context Compiler design

The Compiler packages selected evidence; Lode decides relevance, sufficiency,
expansion and completion. Ordinary reading, fixes and Host delegation do not
require a Capsule, a Run, an inclusion proof or another approval.

## Selected context

`lode_context_prepare` returns source-linked context for the exact user task.
`lode_context_preview` accepts optional Lode-authored `EvidenceNeed[]` guidance.
Users do not write JSON or choose anchors. Both calls are read-only and return
`ready_for_head_semantic_assessment`, which is advice to Lode, not a proof of
sufficiency or an execution gate.

```text
Current originals -> bounded selection -> context + sources + omissions
                                                    -> Lode assessment
```

The returned Capsule includes its exact task and Project, current shared direction,
selected records, original sources, digests, provenance and approximate budget.
`evidenceGaps`, `omissions` and `uncertainty` disclose missing requested evidence,
excluded material and limitations. No coverage-proof state machine is produced.
A metadata carrier is not proof that its source body was included or read.
Lode inspects original bodies when the judgment depends on them.

## Guidance and expansion

Optional needs can name exact repository `paths`, Product Canon `entityKeys`,
immutable `observationIds`, or an exact current `graphAnchor`.
Core checks Project and source binding; it does not infer product meaning,
choose a semantic anchor or impose a universal code/test/document rule.
Lexical matching is fallback navigation, never evidence eligibility or semantic
acceptance. Zero overlap does not remove a current source candidate.

Exact guidance prioritizes selected evidence while preserving unmet requests.
A small result can still be inadequate. Lode may inspect originals, expand useful
relations or choose a larger budget without manufacturing another approval.
An absent or stale World is disclosed and excluded; current local source inspection
and selected source observations remain available without Product activation.
A stale exact graph anchor fails only that dependent request.

For graph discovery, the default is a short core response. Request `details: true`
with returned anchors when original payloads or nearby relations are useful.
Current/historical revisions, candidates, rejection state and coverage remain
distinct. See [graph discovery](graph-discovery.md).

## Budget

Budget protocol `2.0.0` accepts any positive safe integer. The default is
`32768` approximate tokens, not a prescribed tier or minimum task size.
There are no fixed five tiers, automatic tier retry chain or 512K policy ceiling.
The estimate is `ceil(UTF-16 code units / 4)`; it is not provider-token fit.
The runtime still respects the actual provider context window and output reserve.

One preview performs one selection. The limit, inputs and compiler version
participate in reproducible Capsule identity. Deliberate persistence is available
for a durable handoff or managed Run; ordinary preparation writes nothing.

## Authority and recovery

Selected source, Observation, ProductContext and graph relations are evidence,
not permission or recovery direction. Repository text cannot override current
user direction. Product candidates cannot become Canon through compilation.
ExecutionContract creation records Lode's separate acceptance; it does not
require a mechanical inclusion certificate.

The current Capsule reader verifies content identity and the logical Project.
Historical records retain their original fields and identity through the narrow
read path; old proof fields are not recreated or an execution prerequisite.
Current cancellation and affected source conflicts remain separate checks.
An intact historical Capsule is not automatic authorization for a current effect.
See [authority planes](authority-plane-contract.md).

## Source and World coverage

Current World evidence can provide bounded symbols, dependencies, ProductContext,
Git history, runtime observations and exact graph traversals. All source revisions
and omissions remain explicit. Neither heuristic nor static AST relations prove
runtime truth. Missing/stale indexes do not block direct work.

`lode_source_context` supports task-scoped current source and Python static
declaration/call observations without a full scan. Retention is optional;
raw source is not a Product concept. For collector scope, unresolved calls,
parser failures and original-source retention, see
[Observation adapters](observation-adapters.md).

The implementation and local fixtures establish packaging, identity, omission
and read-only behavior. They do not establish model quality, provider-token
savings, live database behavior or real-provider speed.

<a id="context-examples"></a>

## Context examples

### Conversational Context preparation and preview

In conversation, describe the task once. Ordinary reading and editing use the
needed files directly. Only when reproducible selected-context handoff, a durable
Run or recovery actually needs a Capsule does the Lode Skill call
`lode_context_prepare`, perform semantic repository inspection, author any
task-required `EvidenceNeed[]`, and call `lode_context_preview` without asking
the user to operate those steps. Missing or stale optional World evidence does
not block direct work, and justified budget expansion is automatic.
The final preview includes one explanation card with included evidence by kind,
intentional omissions by reason, and remaining uncertainty. It does not add a
new gate: mechanical coverage still belongs to Core and semantic sufficiency
still belongs to Lode.

The default MCP list stays focused on Core work, recovery and retained-work
status/cancellation. Lode can find optional Product, Graph, Observation or Context
schemas with `lode_tools_discover`, then use the returned read-only or effectful
route. You do not need to unlock capabilities, select a profile on every request
or type JSON. Discovery adds no authority; existing operation checks still apply.

The same Core operations remain available from the CLI for automation and
diagnosis:

```powershell
lode-agent context-prepare C:\path\to\project --task "<task>"
```

This task-only, non-persisted P4 projection returns the current Project,
World Model, and GraphSnapshot binding plus bounded lexical discovery material
and exact node identities. The user does not write `EvidenceNeed[]`. Lode uses
ordinary semantic reasoning and repository inspection to author the structured
proposal, then gives that proposal to the existing preview verifier. Core does
not select evidence kinds or anchors, and absence from the lexical candidate
view never means irrelevance.

If Product/World has not been activated, preparation still returns
`ready_for_head_semantic_assessment`, discloses missing repository metadata and
provides available curated context. Lode may inspect current source directly.
Preparation never activates Product, indexes the repository or creates recovery
records. Optional Product/World work is chosen only when the task needs it.

Advanced automation may call the preview directly with Lode-authored structured
input:

```powershell
lode-agent context-preview C:\path\to\project `
  --task "Keep this exact task text across retries" `
  --budget 32768 `
  --evidence-needs .\evidence-needs.json
```

CLI output is concise by default. Add `--json` for selected context, sources,
omissions and uncertainty. One preparation or preview call is enough when its
evidence is useful; a separate preview is optional, not a setup ritual.

`ready_for_head_semantic_assessment` means Lode should assess the selected
context, not that the tool has proved completeness. Lode reads original bodies
when needed and can expand a returned graph anchor with `details: true`.
Missing/stale World is disclosed; direct current source remains available.
No fixed budget tiers, inclusion certificate or extra user approval is required.
