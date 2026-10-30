# Non-blocking Conformance reconciliation

## Optional exact Canon lookup

The existing queue accepts an optional canonAnchor with entityKind and entityKey;
CLI uses --canon-kind and --canon-key together, and MCP uses canon_anchor with
entity_kind and entity_key. The default queue is unchanged. Lookup selects the
logical Canon, not only its latest revision: earlier unresolved or deferred
Findings remain visible with currentness disclosures. Unrelated Finding source
anchors are not re-read; retained artifact integrity is still verified.
Pagination stays available, and filter changes resynchronize the read-only cursor.

Context workflow exposes not-queried pointers only for included Lode-selected
Canon keys. It performs no queue read, persistence, suppression, or semantic
selection and changes neither Capsule coverage nor approval. Lode follows a
pointer only when objections could affect the current judgment, reuses sufficient
current evidence, and reads the exact returned Finding when needed. Previously
acknowledged evidence may be important to a different task. Missing optional
Graph or Observation still permits ordinary source work. This is an explicit
conversational connection, not an automatic Host notifier or global Attention scan.

Read [Architecture](architecture.md), [Authority planes](authority-plane-contract.md), [ChangeSets](change-sets.md), and [Observation adapters](observation-adapters.md) before changing this contract.

Status: implemented provider-neutral P3 candidate evidence, P4 queue and audit view, and optional P5 Host trigger composition.

## Lode maintenance without another user gate

The existing disposition API accepts `actor: "head"` for `acknowledge` and
`defer` without `confirmUserDisposition` (MCP: `confirm_user_disposition`).
Its receipt uses `head-maintenance-evidence-not-user-decision-or-execution-authority`,
not user provenance. Lode cannot follow any user receipt or close a Finding;
user dispositions still require confirmation and may supersede Lode maintenance.
Readers validate the entire author chain, not just individual hashes. Replay
includes author authority. Queue/read output exposes the author and maintained
Findings remain visible in the default all-status queue. Maintenance requests
no user response and establishes neither resolution nor execution permission.

## Boundary

Conformance reconciliation compares approved Product Canon with exact current source, ChangeSet, Observation, or optional Graph evidence without turning Core into a semantic policy engine. Provider Lode proposes `ConformanceFindingCandidate`; Core verifies its exact current anchors, digest, Project, baseline, bounds, replay identity, and non-authority fields. Core does not infer a violation, semantic relevance, sufficiency, severity, resolution, or product meaning.

Missing Graph, partial or unknown Observation coverage, an unavailable optional source, and an advisory risk hint are disclosures rather than ordinary-work gates. Cross-Project evidence, path escape, tampering, divergent replay, authority amplification, and stale mutation input fail only the affected Conformance operation. A stale read-only cursor resynchronizes to its first page, while a stale proposal asks Lode to prepare again. Neither condition asks the user for IDs or blocks unrelated work.

## Artifacts and planes

| Artifact | Plane | Effect |
| --- | --- | --- |
| `ConformanceFindingCandidate` | P3 | immutable provider-Lode semantic candidate with exact evidence |
| `ConformanceDispositionReceipt` | P3 | exact-Finding user disposition or explicitly attributed Lode acknowledge/defer |
| `ConformanceResolutionCandidate` | P3 | fresh provider-Lode reassessment that cannot close a Finding |
| `ConformancePreparationProjection` | P4 | bounded current Canon and optional World baseline for Lode |
| `ConformanceQueueProjection` | P4 | rebuildable, paginated queue state |
| `ConformanceFindingGraphProjection` | P4 | candidate-hidden audit graph with no verdict relation |
| `ConformanceTriggerBatchProjection` | P4 | non-persisted bounded Host-trigger preparation |
| `ConformanceTriggerBinding` | P5 | process-local optional Host configuration and delivery state |

No Conformance artifact is P1 or P2. A request to fix code still enters the ordinary Observe, Session, or Run lane. A request to revise Canon still enters the existing exact candidate and explicit user `ReviewDecision` path. A disposition grants neither execution authorization nor recovery direction.

## Conversational flow

The user describes the work once. Lode performs the structure internally:

```text
lode_conformance_prepare
  -> provider Lode semantic comparison
  -> lode_conformance_propose
  -> lode_conformance_queue
  -> natural-language batch disposition when useful
```

`lode_conformance_prepare` pages current Product Canon entities and returns the current Product Model plus an optional current World/Source/Graph baseline. Graph is never required: an exact bounded project-relative source digest, one reviewed ChangeSet change, or one immutable Observation is sufficient mechanical evidence. Lode may use multiple anchor kinds when that improves reviewability.

Core computes disclosures. The provider and user do not assert that a connector is complete, a Graph is current, or an Observation is comprehensive. Finding fingerprinting excludes explanatory wording and converges the same Project, baseline, Canon anchor, evidence anchors, and claim kind even when Lode phrases the explanation differently.

Direct source hashing is bounded to 64 MiB so one diagnostic request cannot monopolize the MCP process. This limits only that anchor form: larger files may use an exact current World or ChangeSet anchor, and ordinary work remains available. If a previously accepted direct source anchor later grows beyond that bound, queue inspection marks only that Finding `needs-recheck` with an exact reason; it does not abort the rest of the read-only queue or infer resolution.

## Disposition and resolution

Supported exact-Finding dispositions are `acknowledge`, `defer`, `dismiss`, `request-code-fix`, `request-canon-revision`, and `accept-resolution`. They form a create-only linked chain. Repeating the exact latest disposition converges; branching or tampering fails closed.

Source or Canon drift changes an open row to `needs-recheck`; it never proves resolution. Provider Lode may submit an exact fresh `ConformanceResolutionCandidate` with `appears-resolved`, `still-present`, or `uncertain`. Only an explicit user-confirmed `accept-resolution` for one current `appears-resolved` candidate closes that exact Finding. This closure is queue state, not Product Canon or a general suppression rule.

Immediately before recording a new `accept-resolution`, Core revalidates that resolution candidate's own exact evidence anchors against the current source, ChangeSet, Observation, or Graph state. It does not reuse the original Finding anchors and does not require Graph. If those anchors drift, only the new closure attempt returns `CONFORMANCE_RESOLUTION_STALE`; ordinary work and the existing queue remain available. An exact replay of an already recorded disposition returns the immutable receipt without reinterpreting later evidence, which preserves at-most-once user decisions.

Whole-file source anchors may omit `startLine`, `endLine`, `excerptDigest`, `revisionId`, and `symbolId`. The shared Core boundary normalizes those omitted optional fields to `null` before verification, so CLI and typed MCP produce the same identity and users are not required to write placeholder fields.

The P4 audit graph uses only `CHECKS_AGAINST`, `EVIDENCED_BY`, `DISPOSITIONED_BY`, and `REASSESSED_BY`. It never automatically emits `VIOLATES`, `CONFORMS_TO`, `SATISFIES`, or `RESOLVED`, and candidate nodes stay hidden from default product traversal.

## Optional Host triggers

`ConformanceTriggerRegistry` is a process-local provider-neutral composition over verified `change-set`, `observation`, `release-observation`, and `refresh-receipt` identities. It loads no project code and persists no source alias, project path, credential, provider identity, process identity, or cursor into the Project.

The default mode is `opportunistic`: a Host prepares queued evidence at a natural conversational boundary without background provider execution. `monitor` and automatic provider assessment require explicit user opt-in. Host trigger delivery creates no Finding by itself; provider Lode still performs semantic assessment and Core still verifies the proposal.

Duplicate triggers converge across both queued and pending evidence. An empty queue returns idle without creating a pending batch. Preparation computes and verifies the complete projection before atomically moving selected triggers from the queue into one pending batch, so a preparation failure loses no trigger. Refresh receipts coalesce to the latest queued verified receipt; omission lineage travels with that queued receipt and is reported only by the batch that contains it, never as a process-lifetime cumulative count. A prepared batch is stable until the Host marks it complete. If delivery or provider outcome is uncertain, automatic replay and completion stop; only an explicit user retry decision may clear the uncertain state. One unavailable Host adapter returns an optional-capability disclosure and ordinary Lode work continues.

## CLI and typed MCP

Normal conversation uses typed MCP. CLI remains available for trusted automation and diagnosis:

```text
lode-agent conformance-prepare <project>
lode-agent conformance-propose <project> --input <provider-head-proposal.json>
lode-agent conformance-queue <project>
lode-agent conformance-read <project> --finding <conformance-finding-id>
lode-agent conformance-disposition <project> --input <user-confirmed-disposition.json>
lode-agent conformance-resolution-propose <project> --input <provider-head-resolution.json>
```

Pages contain at most 64 entities or Findings. This is an output bound, not an eligibility, registration, or persistence gate; opaque cursors expose the 65th and later items.

## Acceptance properties

- lexical overlap, file names, test presence, document classes, Graph availability, connector availability, coverage class, risk hint, and queue length never determine candidate eligibility or ordinary-work blocking;
- Core accepts exact source, ChangeSet, Observation, and Graph anchors independently or together;
- candidate creation, status, disposition, resolution, and Host trigger operations leave Product Canon, `ReviewDecision`, Session pointers, checkpoints, and execution authorization unchanged;
- stale baselines reject only a mutation and tell Lode to repeat read-only preparation;
- stale read-only cursors resynchronize without user ceremony;
- wording-only duplicate claims converge by exact semantic anchor fingerprint both across calls and within one proposal batch;
- source drift creates `needs-recheck`, never automatic resolution;
- a new resolution acceptance revalidates the resolution candidate's own fresh exact evidence, while an already recorded exact disposition replay remains stable;
- omitted whole-file source optionals and explicit `null` normalize to the same CLI/MCP identity;
- resolution requires fresh exact evidence and explicit user confirmation to close one Finding;
- Host monitor execution is opt-in, failed preparation retains queued triggers, duplicate delivery converges, refresh omission counts stay batch-local, uncertain outcomes do not auto-replay, and Host state remains outside the Project;
- CLI and MCP return the same Core identities, and the 65th item remains reachable.
