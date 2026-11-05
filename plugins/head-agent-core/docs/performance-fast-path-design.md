# Philosophy-preserving fast path

Status: the query-only read batch and the scoped storage/coverage optimizations
listed below are implemented. Other sections remain implementation design. No fast path is authoritative merely because it is
available or faster.

This design reduces duplicate transport, I/O, parsing, and canonicalization
without creating a second source of truth. Read it together with
[`architecture.md`](architecture.md),
[`authority-plane-contract.md`](authority-plane-contract.md),
[`world-model.md`](world-model.md), and
[`context-compiler.md`](context-compiler.md).

## Objective

Return the same canonical results, identities, exclusions, fallback decisions,
and fail-closed errors with less operational work. Performance belongs only to
P5. P1 Product Canon and ReviewDecision, P2 recovery lineage, P3 evidence and
dispatch, and P4 rebuildable graph and continuity meaning are unchanged.

The reference JavaScript implementation remains the semantic oracle. A fast
path may produce a candidate result, but the existing validator remains the
final acceptance boundary.

## Non-goals

- no new Product Canon, recovery, review, instruction, or execution authority;
- no provider-, host-, database-, repository-, or fixture-specific behavior;
- no background service, persistent worker, or hidden long-lived daemon;
- no source-byte freshness decision based only on path metadata or watcher
  events;
- no top-k prefilter that changes the complete Context candidate list,
  exclusions, scores, or ordering;
- no benchmark, latency, cache, PID, endpoint, credential, or physical adapter
  field in a semantic identity;
- no optimization-specific retry that hides an integrity failure or repeats an
  ambiguous effect.

## Universal fast-path invariant

For one canonical input and producer version:

```text
reference(input).semantic == verify(fast(input)).semantic
reference(input).identity == verify(fast(input)).identity
reference(input).failure  == verify(fast(input)).failure
```

Operational diagnostics may differ. Removing diagnostics from both responses
must leave deeply equal canonical output. Any mismatch disables the fast path
and fails the conformance gate; it does not choose the faster result.

## Component A: operational probe

`OperationalProbe` is an optional caller-owned collector. It records bounded
counters and durations outside canonical payloads:

- exact-child launches;
- HTTP read requests;
- files and bytes read;
- bytes hashed;
- files parsed or semantically reused;
- verified reads reused within one scope;
- candidate descriptors built or reused;
- named phase durations.

The probe has no content-derived identity, is not persisted by default, and is
never passed to a semantic builder. Normal operation does not allocate a probe.
Benchmarks create one explicitly.

## Component B: query-only GraphDB read batch

The existing exact child continues to resolve credentials only from configured
environment-reference names. A bounded batch accepts from one through eight
`query` operations and no command or database-lifecycle operation. The prepared
path uses it for topology manifest plus bounded traversal after the already
verified current-pointer read; keeping pointer inspection separate preserves the
existing fallback/stale decision and its one-shot pointer token. It rejects an
incompatible protocol, unsupported operation, oversized input/output, excessive
query count, and an excessive timeout.

The child returns bounded untrusted response envelopes and exits. The parent
then applies the existing independent pointer, manifest, traversal,
request-binding, and receipt-digest validators. A missing pointer retains the disclosed embedded
fallback. A stale pointer retains the existing stale error. Missing, partial,
reordered, duplicated, digest-invalid, or graph-mismatched batch output fails
closed. Transport unavailability follows only the existing documented fallback
policy; integrity failure never falls back silently.

The JavaScript exact child is the reference transport. A separate Go exact
child implements the same read-only protocol without entering the computation
worker contract. Installed native artifacts include a content-addressed bridge
manifest; only a verified platform binary is selected automatically. Missing
native artifacts use the JavaScript reference path in `auto` mode. Startup or
invalid-output failure may use that path with disclosed operational diagnostics
in `auto` mode; `required` rejects it. Initial or post-selection manifest/binary
integrity failure always fails closed. The exact child receives only the
selected secret references and a bounded operational environment allowlist.

The transport advertises the capability as operational metadata:

```json
{
  "preparedReadBatchProtocolVersion": "0.1.0",
  "preparedTraversalBatchAuthorityEffect": "none"
}
```

Adapters without the capability use the current request path. No canonical
GraphSnapshot, TraversalQuery, TraversalResult, Context Capsule, or error code
depends on capability availability.

## Component C: request-scoped verified reads

`VerifiedReadScope` exists for one top-level synchronous operation. It may memoize
already validated Product Canon, projection, pointer, and World Model reads that
the same operation would otherwise repeat.

The scope:

1. resolves and binds one project root;
2. captures exact raw boundary bytes and validated identities;
3. returns immutable values or defensive clones;
4. forbids use by an authority-changing write;
5. re-reads the boundary before returning the top-level result;
6. discards all memoized values and retries once when the boundary changes;
7. fails closed with a stable change-during-read code if the retry also changes;
8. ends with the operation and is never serialized.

`--fresh` bypasses reuse. A process-global assertion that a project is current is
forbidden. Cross-request cache work requires a separate proof that preserves the
same byte-level freshness and is outside this design.

## Component D: single-pass repository inspection

Repository freshness continues to rediscover every eligible path and hash every
eligible file's actual bytes. One pass compares those digests with the verified
prior scan:

```text
discover -> read bytes once -> hash -> compare prior digest
                                      | equal: reuse validated analysis
                                      | changed: parse current bytes
                                      | new: parse current bytes
after discovery: record removed paths -> canonical sort -> validate result
```

This replaces the changed-state sequence that first performs a full freshness
read and then performs a second complete scan. Path size, timestamps, file IDs,
filesystem events, and watcher generations may appear in operational diagnostics
or suggest work, but cannot prove current content and cannot skip the byte hash.

The produced `RepositoryScanResult`, change set, source digest, World Model, and
GraphSnapshot must be byte-equivalent to the complete reference scan. Existing
limits, source-scope rules, symlink handling, classifications, skip counts, and
canonical ordering remain unchanged.

## Component E: immutable Context candidate descriptors

An in-memory bounded cache may retain task-independent descriptors keyed by the
exact World Model hash, curated-knowledge digest, compiler version, and budget
protocol. A descriptor may contain immutable canonical records, normalized term
sets, lookup maps, importance, and approximate token cost.

Every compilation still recomputes task terms, history class, relevance, score,
the complete candidate order, budget inclusion, exclusion reason, and the final
Capsule hash. The `candidateIds`, `includedIds`, and complete exclusion records
must match the uncached compiler exactly. Temporal expansion still uses the same
bounded verified query and cannot consume unreviewed candidates unless the
existing explicit option permits them.

Cache entries are deep-frozen, bounded, non-persistent, and replaced when any
key identity changes. Cache state never enters Capsule identity or provenance.

## Failure and fallback matrix

| Condition | Required behavior |
| --- | --- |
| optional fast capability absent | use reference path and disclose diagnostics |
| transport unavailable before a read effect | retain documented read fallback |
| selected native binary digest changes | fail closed without reference fallback |
| partial or malformed batch | fail closed |
| pointer, manifest, request, or digest mismatch | fail closed with existing semantic error |
| read boundary changes once | discard and retry once |
| read boundary changes again | fail closed |
| repository byte digest changes | parse that file and report exact stale/change state |
| cache entry missing or evicted | rebuild descriptor from verified input |
| fast/reference canonical mismatch | disable candidate and fail conformance |

## Implementation slices

1. Add the operational probe and reference-versus-candidate comparison harness.
2. Collapse repository freshness and incremental analysis into one byte-exact
   pass; retain the complete reference path for differential tests.
3. Add the query-only exact-child batch as an optional Graph projection
   capability; retain the current transport path.
4. Add `VerifiedReadScope` to World Model and Context top-level operations.
5. Add the immutable Context descriptor cache without changing selection.
6. Run integrated cold/warm, stale, tamper, crash, cancellation, fallback, and
   distribution tests before advertising any capability.

Each slice is independently revertible. The Go read bridge alone passed its
separate evidence gate; this does not imply migration of repository scan,
canonical verification, graph semantics, or Context compilation.

## Acceptance evidence

The merge gate requires:

- deep equality after removing explicitly operational diagnostics;
- identical semantic IDs and hashes across reference and candidate paths;
- identical candidate order, inclusion, exclusion, and trust boundaries;
- identical stale, tamper, replay, timeout, cancellation, and unavailable error
  classification;
- zero new project, Canon, checkpoint, review, graph, or credential writes;
- exact child and descendant cleanup;
- no development history or validation-fixture identity in an installed runtime
  surface;
- cold-path non-regression and a repeatable warm-path improvement on
  representative small, medium, and large generic corpora.

Timing supports activation but never proves semantic correctness. A candidate
that is equivalent but not materially faster remains available only as test
evidence and is not advertised. A candidate that is faster but not equivalent is
rejected.

The current Windows loopback acceptance ran 30 paired batches with equal
canonical responses. The JavaScript exact child measured 144.722 ms median and
the Go exact child 34.624 ms median (4.18x). These values are operational and
host-specific, do not enter any semantic identity, and must be refreshed on
other release hosts; the activation rule is the durable part: native median no
greater than 80 percent of the reference median after semantic parity passes.

## Philosophical fit

This design preserves the original Lode relationship: Lode owns integration and
completion judgment; the user owns consequential direction; canonical artifacts
outlive provider sessions; derived graphs and caches are replaceable; bounded
workers and adapters cannot acquire authority; and evidence must remain connected
to the consumer that decides. The fast path changes physical work, not who may
decide, what is true, how recovery works, or what constitutes completion.

## Adopted scope and measurement limits

Selected-owner flat shared parts, separate snapshot membership, bounded private-Git batches and request-owned verification reuse are implemented. Snapshot membership can still scale with the whole graph. Earlier synthetic storage timings preceded final corrections and are not a remeasurement of the final release. Some small or repeated operations were slower. P2b and the Rust prototype were not adopted. Explicit GC predates the coverage-index change.

The coverage index preserves output and callback order; it does not improve semantic retrieval by itself. See [verification evidence](verification-evidence.md#coverage-computation-comparison) and [storage compatibility](snapshot-storage.md).
