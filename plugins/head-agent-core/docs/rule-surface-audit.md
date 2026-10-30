# Rule surface audit

Reviewed: 2026-08-27

This audit checks whether Lode Agent Core retains only rules that protect a
user-visible outcome or an authority boundary. A rule is retained only when it
has a narrow scope, an implementation enforcement point, an observable failure,
and a condition under which it can be narrowed or removed.

## Retained universal invariants

| Invariant | Enforcement point | Observable failure | Narrowing or removal condition |
| --- | --- | --- | --- |
| Canon, evidence, candidates, and projections do not impersonate one another | artifact validators and explicit ReviewDecision transitions | digest/authority mismatch or candidate remains unpromoted | removable only if all affected artifacts become one authority class, which is not planned |
| Executing or mutating work is bound to the exact project and owned process/path | project fences, caller fences, safe-root checks, native supervisor | pre-start rejection or bounded cleanup receipt | read-only Observe paths already omit execution-only fences |
| Semantic identities are content-derived and freshness-verifiable | canonical hashing, snapshot pointers, adapter verification | stale/tampered identity rejection | operational timing and physical adapter identity are already excluded |
| Credentials and raw provider transcripts remain operational and non-canonical | environment filters, bounded ephemeral streams, transcript-free receipts | missing capability/credential diagnostic without secret persistence | no broader rule is needed while providers retain their own auth stores |
| Optional Git, GraphDB, native acceleration, and document hosts cannot become unique authority | adapter contracts and rebuildable embedded artifacts | disclosed fallback or adapter-local failure | adapter checks disappear when that adapter is not selected |

## Lane-scoped rules

| Lane | Rules retained | Rules deliberately absent |
| --- | --- | --- |
| Observe | bounded read, freshness, authority disclosure | no WholePlan, Capsule, Run, lease, or review by default |
| Session | exact request digest, project/workspace scope, reversible local actions, bounded one-shot lease/result | no ExecutionContract, active Run, Product Canon mutation, or Fresh Lode review |
| Run | accepted WholePlan, ExecutionContract, ContextCapsule, exact Run, bounded executor, ResultPacket, Fresh Lode review | no provider-session identity or automatic Canon promotion |
| Authority | Run controls plus the explicit user-owned decision at the affected boundary | no implied approval from capability, graph materialization, document edits, or model output |

## Subsystem and adapter-local rules

- Project/Session initialization alone does not require Product onboarding,
  repository indexing, Graph, Capsule, or ReviewDecision machinery. The `core`
  profile is the public default; onboarding input must explicitly select the
  `product` profile.
- Onboarding alone requires evidence-linked candidates and an explicit batch
  ReviewDecision before Product Canon bootstrap.
- Graph and document adapters alone require rebuildability, snapshot parity,
  stale/tamper rejection, and no promotion authority.
- Native compute alone requires manifest integrity and semantic equivalence to
  the JavaScript reference; absence or unsupported operation has a disclosed
  JavaScript fallback.
- Distribution alone requires owned paths, immutable release identity, verified
  native packages, recoverable pointer changes, and project-state preservation.
- Codex alone requires its negotiated fixed `exec` options and portable output
  schema. OpenCode alone requires `run --format json --pure`, a permission/privacy
  overlay, and its event codec; the user's global OpenCode provider settings and
  authentication remain authoritative.
- Windows Job Objects and POSIX process groups are host-local mechanisms for the
  same provider-descendant cleanup outcome, not additional semantic rules.

## Deferred optional capabilities

General provider-session resume/stream, broader process-host control, automatic
DAG merge/conflict resolution, Obsidian/Notion publication, and OpenAI universal
plugin-directory publication remain optional. P2-first exact optional Lode
attachment, bounded worker ownership/wait, role messaging, WorkspaceHost
integration, and exact-owned one-shot interrupt/close are active scoped
capabilities rather than universal prerequisites.
Their absence does not block installation, onboarding, graph recovery, Context,
Session, Run, provider replacement, or Git/GraphDB-free core operation.

## Removed or narrowed rules

- Removed the requirement to route every task through WholePlan, Capsule, Run,
  and Fresh Lode; the risk-proportional lanes now own those costs.
- Removed Product/World/Graph onboarding from the universal initialization path;
  the optional product profile owns that cost and its review gates.
- Removed Git commits/decision markers and GraphDB availability from semantic
  identity, recovery, and onboarding prerequisites.
- Removed provider-session identity from Lode Project, Session, and Run identity.
- Removed the adapter-owned OpenCode OpenAI-compatible provider preset, endpoint
  normalization, and environment-specific OpenAI/LiteLLM assumptions. OpenCode
  reads the user's resolved global settings instead.
- Removed a fixed model-call count as a success criterion; deliberate opt-in and
  bounded resources remain the relevant controls.
- Removed the external-security-software Bun crash from adapter/model/auth failure
  inference.
- Removed duplicate native-supervisor deferral and package/MCP version sources;
  one implementation boundary and package metadata remain.

## Verdict

The public vertical has no unresolved global rule that exists only because a
subsystem supports it. Remaining mandatory rules map to authority separation,
credential/privacy protection, exact scope/identity, recoverability, or process
ownership. Optional adapter capabilities stay scoped and do not become core
gates. Re-run this audit whenever a new mandatory rule is proposed, and require
its enforcement point, observable failure, and removal condition in the same
change.
