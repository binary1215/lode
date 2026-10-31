# Lode Agent Core documentation

[한국어 문서](ko/README.md)

This index covers the public, current documentation shipped with the plugin.
Historical design records are labeled as such inside their documents. Development-only
work logs are intentionally excluded from the distribution and are not runtime authority.

## Start here

| I want to… | Start with |
| --- | --- |
| Install for my client | [Install](../README.md#install) |
| Start my actual task | [First request](../README.md#first-request) |
| Continue remaining work | [Recovery](../README.md#recovery), [saved work](session-work-context.md) |
| Review reasons and before/after changes | [Recorded context and diff](context-lineage.md) |
| Automate a workflow | [Core commands](#command-reference), [Context examples](context-compiler.md#context-examples), [optional Product setup](onboarding.md#product-cli-examples) |

## Architecture and Product reference

- [Architecture decision](architecture.md)
- [Provider-neutral Lode constitution](lode-constitution.md)
- [Authority planes and the Graph/record boundary](authority-plane-contract.md)
- [Project onboarding](onboarding.md)
- [Standalone legacy onboarding migrator boundary](onboarding-migrator.md)
- [Product Model canon](product-model.md)
- [Product Operating Loop](product-operating-loop.md)
- [Release observation](release-observation.md)
- [Delivery state observation](delivery-observation.md)

## Context, world, and retrieval

- [Graph-first discovery and independent Sessions](graph-discovery.md)
- [Local read-only Graph Explorer](graph-explorer.md)
- [Recorded code context and before/after comparison](context-lineage.md)
- [Lode Context Compiler design](context-compiler.md)
- [Repository World Model semantic alpha](world-model.md)
- [Snapshot encoding, storage inspection and preservation](snapshot-storage.md)
- [Temporal provenance GraphSnapshot alpha](temporal-provenance.md)
- [Review-gated Feature mapping](feature-mapping.md)
- [Incremental observed-state refresh](incremental-refresh.md)
- [Debounced refresh triggers](refresh-trigger.md)
- [Post-refresh Markdown projection policy](post-refresh-projection.md)

## Execution, recovery, and coordination

- [Recovery meaning, Session selection and World domains](recovery-state-separation.md)
- [Work artifact storage guide](artifact-storage.md)

- [Execution Lineage contract and Run lifecycle](execution-lineage.md)
- [Provider-neutral ChangeSet and reviewed impact](change-sets.md)
- [Non-blocking Conformance reconciliation](conformance-reconciliation.md)
- [Compaction recovery](compaction-recovery.md)
- [Session restore and reviewed-result integration](session-recovery.md)
- [Session work context and Host continuity](session-work-context.md)
- [Same-project conversation messaging](conversation-messaging.md)
- [Ordinary Host delegation and optional attachment](role-coordination.md)
- [Provider-neutral bounded worker launch waves](bounded-worker-wave.md)
- [Worker context and Lode integration](worker-context-integration.md)
- [Optional provider-neutral worker admission](worker-admission.md)
- [External runtime state evidence](runtime-state.md)

## Adapters and projections

- [Runtime adapter contracts](runtime-adapters.md)
- [Common Observation contract and adapters](observation-adapters.md)
- [ComputeAdapter and WorkerProtocol baseline](compute-adapter.md)
- [GraphProjectionAdapter contract](graph-projection-adapter.md)
- [DocumentProjectionAdapter and deterministic Markdown projection](document-projection-adapter.md)
- [Document change review and application](document-change-review.md)
- [Philosophy-preserving fast path](performance-fast-path-design.md)

## Distribution and verification

- [Verification evidence and limits](verification-evidence.md)

- [Codex marketplace distribution](codex-marketplace.md)
- [Claude Code marketplace distribution](claude-marketplace.md)
- [Rule surface audit](rule-surface-audit.md)

## Historical design evidence

These documents explain prior design comparisons or audits. They do not override the
current executable contracts above.

- [Original HEAD Core comparison](original-head-core-comparison.md)
- [Lode-Agent GraphDB Brief v4 summary and design review](Lode_GraphDB_Brief_v4.md)

<a id="command-reference"></a>

## CLI, automation, and advanced setup

The normal path starts with [your task in the README](../README.md#first-request). Use the following CLI
surface when a script, CI job, offline recovery procedure, or host integration
needs the same deterministic Core behavior without a guided conversation.

The default path initializes only the provider-neutral Lode constitution and its
fixed Project/Session recovery anchors:

```powershell
lode-agent init C:\path\to\project --runtime claude,codex,opencode
```

It returns `core_ready`, preserving identities and updating the lightweight
existing-observation index where available. Product inference, governed World
construction and document governance remain optional. The same bounded status is available
at any time:

```powershell
lode-agent status C:\path\to\project
```

Successful human-readable status is intentionally one line. Exceptions name
the owner, reason, affected operation, and next action; `doctor` or `--json`
shows Core, optional Product governance, Context readiness, executing CLI/library
and configured package versions, and technical details. Host tool loading is not
observed by that package inspection. The structured projection separates
`readiness.core`, `readiness.product`, and `readiness.context`, names one
`nextAction`, and lists optional capabilities with their real prerequisites.
For example, Product appears as `available-not-activated`, while bounded workers
appear as `requires-session-or-run-authorization` for retained managed work.
Ordinary second opinions use available Host delegation; worker count alone does
not require a Run. This is a non-persisted advisory
projection: reading it never activates Product, creates a Run, grants authority,
or repairs drift. `profile` remains a choice for one initialize/resume operation,
not a hidden project mode.

Top-level status is one of `core_ready`,
`product_evidence_required`, `product_review_required`, `product_ready`,
`product_refresh_required`, or `core_drifted`. The exact lower-level onboarding
state remains visible under `readiness.product.onboardingStatus`.
