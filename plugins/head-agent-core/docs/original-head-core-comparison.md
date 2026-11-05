# Original HEAD Core comparison

Reviewed: 2026-08-20

Status: historical source comparison. Later Claude Code support, constitutional
profile defaults, bounded worker waves, readiness UX, and source-linked selected-context
Context preview expansion are not part of the reviewed source slice and must be
evaluated from the current architecture and executable tests rather than inferred
from this document.

This document compares the extracted `Won6314/head-agent-core` reference with
this provider-neutral plugin. It records design lineage, adopted corrections,
and the remaining limits of a claim that this plugin is preferable for
universal plugin use. It does not claim to be an official upstream release, a
drop-in replacement, or a superset of every upstream host capability.

## Reference basis

The historical comparison names these paths in the extracted original Core:

- `packages/core/head/HEAD_CORE.md` for whole-outcome ownership and decision
  authority;
- `packages/core/docs/FOUNDATIONS.md` for bounded context, canon, delegation,
  evidence, and Core/project boundaries;
- `packages/core/docs/TECHNICAL_ARCHITECTURE.md` for the installed OpenCode,
  Herdr, Session/Run, worker, and role-message architecture;
- `packages/core/theory/04-evolution-evidence-and-limits.md` and the general-rule
  course for proportional machinery and generative rules.

The exact upstream commit used on 2026-08-20 was not recorded here. These path
strings are historical references; the following check does not reconstruct or
replace that unknown baseline.

Source paths were checked again on 2026-10-20 at upstream
[`ba220c55c14b8af947bf6d1fb9d27a620a2cf2aa`](https://github.com/Won6314/head-agent-core/tree/ba220c55c14b8af947bf6d1fb9d27a620a2cf2aa):
[HEAD Core](https://github.com/Won6314/head-agent-core/blob/ba220c55c14b8af947bf6d1fb9d27a620a2cf2aa/packages/core/head/HEAD_CORE.md),
[Foundations](https://github.com/Won6314/head-agent-core/blob/ba220c55c14b8af947bf6d1fb9d27a620a2cf2aa/packages/core/docs/FOUNDATIONS.md),
[Technical Architecture](https://github.com/Won6314/head-agent-core/blob/ba220c55c14b8af947bf6d1fb9d27a620a2cf2aa/packages/core/docs/TECHNICAL_ARCHITECTURE.md)
and [Evolution, evidence and limits](https://github.com/Won6314/head-agent-core/blob/ba220c55c14b8af947bf6d1fb9d27a620a2cf2aa/packages/core/theory/04-evolution-evidence-and-limits.md).
The separately checked plugin-root commit
[`067701f0c0390a6b9f7dfd1a90a417d10247bd02`](https://github.com/Won6314/head-agent-core/tree/067701f0c0390a6b9f7dfd1a90a417d10247bd02)
has `instructions/HEAD_CORE.md` but not the historical
`packages/core/docs/FOUNDATIONS.md` path. These permanent links identify the
2026-10-20 check, not a new comparative verdict or the source of the earlier audit.

The reference establishes six portable principles that this plugin must retain:

1. HEAD owns the whole outcome while the user owns material direction.
2. One connected primary flow is stronger evidence than disconnected ceremony.
3. Context is the smallest complete authoritative set for one owner and result.
4. Session/Run canon survives lossy conversation and generated summaries.
5. A worker result is evidence, not automatic authority.
6. Structure scales with consequence, coordination, continuity, and evidence.

## Structural comparison

| Concern | Original HEAD Core | This plugin | Universal-plugin consequence |
| --- | --- | --- | --- |
| Runtime composition | A user-scoped OpenCode/Herdr installation with one loopback coordination daemon and exact pane/tab/session evidence | One provider-neutral Core with typed Claude Code, Codex, and OpenCode adapters, a portable CLI/MCP surface, runtime-independent HEAD identities, an injected exact-endpoint WorkspaceHost contract, and a production host-export filesystem bridge | Provider replacement does not replace project meaning; the plugin generalizes endpoint identity and external-host delivery without embedding host-specific executable, socket, command, pane, or TUI knowledge, while the original still has the established installed-Herdr provider-client operating path |
| Durable authority | Project-owned Session/Run canon plus host-owned task/message state | Git-independent Project, Session, Run, Product Canon, World Model, Context, Execution Lineage, and recovery artifacts | More semantic and execution state is portable across providers and storage backends |
| Graph role | A retrieval index whose linked source files remain authoritative | An embedded content-addressed GraphSnapshot with local, GraphDB, and document projections that remain rebuildable and non-authoritative | Graph storage is optional and cannot become a hidden orchestrator or source of truth |
| Product model | Product and policy definitions remain project-owned extensions | Strict user-owned Product Canon plus candidate/review boundaries and a Product Operating Loop | Product learning is integrated without allowing inference or outcomes to promote Canon |
| Ordinary work | Direct coherent work is the default; Run, worker, graph, and formal review are conditional | Observe, Session, Run, and Authority lanes select the lightest safe contract; the recommendation itself has no authority | Universal use does not force heavyweight lineage onto read/reason work |
| Continuity | Canonical Session/Run recovery and at most one explicit post-compaction continuation | Canonical Session/Run recovery plus an on-demand, non-persisted continuity view; provider conversations and transcripts remain non-canonical | Cross-provider recovery is semantic rather than a promise to restore a provider session |
| Distribution | Immutable release composition, project initialization, OpenCode integration, host daemon, roles, and procedures | Git-backed Codex marketplace package, OpenCode/Codex runtime paths, optional native workers, and Windows/macOS/Linux installation | The plugin is broader across providers and hosts; universal-directory publication remains publisher-owned and incomplete |

## Strict surfaces narrowed from the earlier plugin design

The original design rejects permanent machinery that has not earned its
coordination, context, or maintenance cost. The source slice reviewed at
alpha.66 applied that correction at executable boundaries. This is historical
comparison evidence: beta.16 removes its advisory lane classifier and ephemeral
note formatter entirely, leaving judgment and prose to HEAD:


- `ProductLearningNote` keeps an observation, hypothesis, or inferred meaning
  ephemeral by default. It has no content identity, graph node, persistence, or
  authority. The Core recommends persistence only for cross-Run recovery,
  rebuttal/audit, product state, or handoff/context-loss needs.
- `recommendOperatingLane` is a pure advisory classifier. Observe adds no
  WholePlan, Capsule, Run, lease, or review. Session covers one bounded
  reversible result. Run is selected for dependency, recovery, or independent
  review needs. Authority is selected only at the affected user-owned boundary.
- Product and continuity reads can reuse a disclosed same-process snapshot or
  content-identity cache. Core writes invalidate it, and `--fresh` forces full
  verification. The cache never grants instruction, promotion, or recovery
  authority.
- An Initiative can begin from explicit inline reasoning without first creating
  Signals or Hypotheses. Feature resolution can be deferred until acceptance,
  so an unreviewed proposal creates no `ProductFeatureCandidate` by default.
- The seven existing Product Operating Loop operations remain available for
  durable work, but they are no longer the mandatory entrance to ordinary
  observation or planning.
- `head help` exposes only the light default surface; `head help-all` retains
  every advanced, compatibility, audit, and recovery command. The lane
  recommendation is explicitly optional and cannot guard another operation.

The universal red lines remain: epistemic classes do not merge; a candidate is
immutable; review is a separate artifact; Product Canon never changes from
model inference; external writes, credentials, material initiative decisions,
and recovery-canon replacement stay user-owned; provider transcripts, Git,
GraphDB, documents, and adapters remain non-authoritative.

## Connected implementation evidence

The default path is now demonstrable end to end:

```text
read or reason
  -> ephemeral typed note
  -> advisory risk lane
  -> direct bounded work when safe
  -> immutable Initiative candidate only when durable product action is needed
  -> separate user ReviewDecision
  -> Feature resolution at acceptance
  -> accepted execution lineage for consequential implementation
```

The integrated tests verify that notes create no project artifacts or graph
nodes, direct reasoning needs no prerequisite Signal/Hypothesis, rejected or
unconfirmed reviews write nothing, accepted review preserves candidate bytes,
Feature candidates appear only at review time, Product Canon remains unchanged,
cache hits are disclosed and invalidated by writes, `--fresh` works, and an
externally tampered cached artifact is rejected when its filesystem identity
changes. The full suite, plugin validator, Skill validator, and syntax checks
are release gates for this change.

## Advantages and remaining gaps

For a provider-neutral, Git-optional, GraphDB-optional plugin, this repository
has stronger portable semantics than the original runtime composition:

- project, product, graph, change, execution, and recovery identities do not
  depend on one provider session or one host daemon;
- three provider adapters share one semantic Core instead of forking authority;
- Windows, macOS, and Linux installation and exact descendant cleanup are part
  of the tested distribution;
- Product Canon, candidate review, temporal provenance, Context compilation,
  execution review, and optional projections form one connected contract;
- the light ordinary path now preserves the original's proportionality rather
  than making those deeper contracts universal overhead.

The original still has capabilities this plugin deliberately has not claimed:
general provider-session resume/stream and an established installed-Herdr
operating path. The plugin now has provider-neutral
host-bound durable project-role messaging, append-only exact endpoint targets,
fresh-snapshot/ack/post-snapshot delivery fencing, deterministic two-fresh-process
Codex/OpenCode generic-host evidence, and a production host-export bridge whose
separate live consumer acknowledges create-only requests. The external host binds
each exported endpoint uniquely to the current coordination binding plus one
per-process proof, so snapshot membership or copied coordinates cannot self-claim
another role's live caller identity. It does not bundle a
Herdr-specific adapter. Actual already-running Codex/OpenCode tool consumption,
P2-first optional exact HEAD attachment, bounded worker dispatch/own/wait/result/
review/integration, and exact-owned one-shot interrupt/close are verified on
Windows through the portable host/runtime contracts. Automatic DAG
merge/conflict resolution, Obsidian/Notion publication, and OpenAI universal
plugin-directory publication also remain incomplete. These are extension gaps,
not reasons to weaken authority separation, but they bound any superiority
claim.

The original author directly audited exact pushed source `fd9ad3b` after the
portable continuation, independently ownable worker, actual Codex/OpenCode host
round trip, and criterion-resolution evidence were complete. That audit issued
all three unconditional comparative verdicts with no blocking correction.
Later Claude Code, bounded-wave, and constitutional-profile changes do not
inherit that exact-source verdict automatically. Claude Code has the same
deterministic one-shot authorization, lease, supervisor, result, compaction, and
projection contracts, while its live model-call and already-running-host round
trips remain separate opt-in evidence gates.

## Claim boundary for author review

The proposition to validate is narrow:

> For universal provider-neutral plugin use, this repository now preserves the
> original HEAD philosophy while providing a more portable semantic,
> product-authority, graph, execution-lineage, and distribution foundation.

The proposition is false if any mandatory everyday rule still lacks a protected
outcome, if the core default can bypass a user-owned authority transition, if a
derived view becomes unique recovery or meaning, or if an original portable
Core responsibility was lost rather than relocated. The already-audited verdict
applies to `fd9ad3b`; every later source slice needs its own bounded audit.

## Original-author review outcome

The first file-mail verdict on 2026-08-20 was intentionally scope-limited. It
accepted broader provider-neutral foundation coverage while withholding overall
and philosophical superiority until live coordination, portable recovery, and
worker ownership gaps were closed.

Those gaps were subsequently implemented and audited in several exact-source
rounds. In criterion-resolution reply
`20260820T183022Z--completeness-criterion-resolution`, the original author ruled
that artifact-owned P2 restore satisfies semantic HF-008, live attachment is an
optional P5 continuity feature, provider resume/stream and Herdr-specific
implementation are optional adapter capabilities, and one-OS live evidence plus
portable Host contracts satisfy the portability criterion. For exact pushed
source `fd9ad3baf8879bd4b92f18e1b9cf4562358d737e`, the final verdict was:

- blocking correction: none;
- philosophical superiority: yes;
- overall completeness superiority: yes;
- overall superiority: yes.

This remains comparative advisory evidence, not a Product Canon ReviewDecision
or project authority. It is also commit-scoped: later Claude Code, bounded worker
wave, and default-core/profile changes require fresh source review before the
verdict can be claimed for current `main`. The current implementation continues
to exclude embedded Herdr-specific behavior; equivalent outcomes use the
provider-neutral Host/runtime contracts or separately owned optional adapters.
