# Glossary

[한국어](ko/glossary.md)

Short definitions of the terms Lode uses in tool results, Skills and these
documents. Each entry links to the document that defines it in full.

| Term | Definition | Defined in |
| --- | --- | --- |
| Project | The one canonical record of a repository's Lode state, stored in its `.lode/` folder (older Projects: `.head/`). It owns the common user direction and the logical Sessions, and stays the same across providers, Hosts and conversations. | [Constitution](lode-constitution.md), [portability](project-portability.md) |
| Session | A logical Lode Session: one independently routed line of work inside a Project with its own purpose, progress and recovery. It is not a provider conversation; a request selects it with `session_id` or `--session`. | [Graph discovery and Sessions](graph-discovery.md), [Session restore](session-recovery.md) |
| P2 direction | The user's current direction kept as P2 (canonical recovery) records: the common Project direction plus the selected Session's purpose, constraints and cancellations. Evidence, summaries and historical approvals cannot rewrite it; a later cancellation always applies. | [Authority planes](authority-plane-contract.md), [Session restore](session-recovery.md) |
| Run | A durable unit of managed execution with an execution contract, a ResultPacket and a Fresh Lode review. Use it only when ownership, interruption recovery or uncertain effects need tracking; ordinary work needs none. | [Execution lineage](execution-lineage.md) |
| Capsule | A ContextCapsule: a reproducible, content-addressed bundle of selected context for one exact task. Prepare it only for a selected-context handoff, a durable Run or recovery; reading files directly is the default. | [Context Compiler](context-compiler.md) |
| Canon | Product Canon: approved product meaning and policy (P1). It changes only through an explicit user ReviewDecision for an exact current candidate; graphs, results and messages never promote themselves into it. | [Product Model](product-model.md), [authority planes](authority-plane-contract.md) |
| World | The Repository World Model: a rebuildable view of code structure (files, symbols, imports, calls) derived from the repository. It is evidence for context and impact queries, not canon or instruction authority. | [World Model](world-model.md) |
| Product | The optional governance layer for reviewed product meaning (Features, Policies, Metrics) activated with `profile: "product"`. Core work, graph discovery and recovery work without it. | [Product Model](product-model.md), [onboarding](onboarding.md) |
| Host | The client running the conversation: Claude Code, Codex or OpenCode. It supplies native session identity, hooks and delegation; Host success or availability grants no Lode authority. | [Session work context and Host continuity](session-work-context.md), [runtime adapters](runtime-adapters.md) |
| Checkpoint | A SessionRunCheckpoint: the P2 record of a Session's current position, decisions and next expected result, written by checkpoint sync. Without one, ordinary work simply continues. | [Session restore](session-recovery.md), [compaction recovery](compaction-recovery.md) |
| Capability | An optional function an adapter or Host can prove it provides, such as a tool family found through discovery. Its absence is disclosed and limits only the work that depends on it; having a capability never grants authorization. | [Constitution](lode-constitution.md), [architecture](architecture.md) |
| Observation | A recorded fact from an external source (tests, deployments, releases, metrics, source collection) kept as P3 evidence. Observations inform judgment but cannot approve, recover or direct work. | [Observation adapters](observation-adapters.md) |

The authority planes P1–P5 behind these terms are summarized in the
[authority plane contract](authority-plane-contract.md).
