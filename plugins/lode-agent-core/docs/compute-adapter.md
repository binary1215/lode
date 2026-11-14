# ComputeAdapter and WorkerProtocol baseline

Read [`architecture.md`](architecture.md) and
[`authority-plane-contract.md`](authority-plane-contract.md) before changing
this plane.

## Purpose and current boundary

`ComputeAdapter` separates deterministic heavy computation from the JavaScript control plane without transferring product authority, runtime authority, or semantic identity to an implementation language. Contract version `0.3.0` and WorkerProtocol version `0.2.0` are active.

`JsReferenceComputeAdapter` runs deterministic reference operations in-process and remains the semantic oracle and local fallback. `GoWorkerComputeAdapter` provides a verified native stdio transport. The Go source now implements `repository.scan.v1` and matches the JavaScript complete response across seven success/failure fixtures, including explicit source-scope filtering, but packaged release manifests still advertise `worker.health.v1` only. Comparative measurements show regressions for small and medium inputs and only marginal improvement for a large input, so production World Model scanning remains JavaScript rather than claiming unproven acceleration. No user project receives native source or binaries.

## Authority boundary

Every adapter descriptor must declare:

- `authority: computation-only`;
- `instructionAuthority: false`;
- `promotionAuthority: false`;
- `controlAuthority: false`;
- `mutatesProject: false`;
- `mutatesCanon: false`;
- `semanticIdentity: backend-neutral-canonical-output`.

Every request and response records `authorityEffect: none`. Result validation recursively rejects any instruction, promotion, control, canonical, or unique-authority flag unless its value is exactly `false`. This is a defense-in-depth boundary; operation-specific validators must still reject output that falls outside the operation schema.

The JavaScript control plane remains responsible for Product Canon writes, ReviewDecision, candidate promotion, Context policy, CLI/MCP integration, backend selection, worker integrity verification, and process lifecycle enforcement.

## Canonical WorkerProtocol

A `ComputeRequest` contains:

```text
schemaVersion, protocol, kind, requestId,
operation, input, inputDigest,
semanticProducer, limits, authorityEffect
```

An operation name is explicitly versioned, for example `repository.scan.v1`. Input must be plain finite JSON. Canonical object-key ordering determines `inputDigest`; protocol version, operation, input digest, semantic producer, and normalized limits determine the content-derived `requestId`.

A `ComputeResponse` echoes the request identity and contains:

```text
status, result, resultDigest,
warnings[], errors[], authorityEffect
```

Successful output must be complete, canonical JSON within `maxOutputBytes`, free of authority escalation, and match its SHA-256 result digest. Failed output has no partial result or digest and requires at least one structured error. Warning and error records are canonically ordered. Request/response mismatch, extra fields, malformed JSON, digest drift, unsupported operations, and partial results fail closed.

## Resource and cancellation contract

Normalized limits record:

- timeout;
- maximum input and output bytes;
- maximum files;
- maximum bytes per file;
- maximum total source bytes.

The default `maxOutputBytes` is **64 MiB (67,108,864 bytes)**. Without an explicit
caller output budget, a validated error containing only `COMPUTE_OUTPUT_LIMIT`
allows **64 → 128 → 256 → 512 MiB**, at most three retries after the first attempt.
JavaScript and Go accept at most **512 MiB (536,870,912 bytes)** of complete UTF-8
JSON response, including its envelope, not just `result` or displayed output.
An explicit output budget, including an explicit default, remains exact without
automatic growth. Input, source, artifact, Markdown and MCP limits do not change.
The generic executor shares one deadline and cancellation signal across attempts;
identity, digest, permission, mixed errors, malformed output, transport stdout
violations and crashes are not growth triggers. A valid Go worker returns a small
typed output-limit failure rather than crashing when its encoded success is too big.
An old 64 MiB native worker may reject a larger request: existing disclosed
crash/fallback rules still apply, but that rejection does not authorize another
budget increase. Production manifests still advertise health only.

JavaScript reference operations retain a private canonical completed result for
the invocation and re-envelope it, without running the handler again. Incremental
repository scans likewise scan once and re-envelope the same captured facts;
this synchronous scan does not acquire a new executor timeout. Initial production
scans use the same retained-result path through the JavaScript fallback. No retry
repeats installation, World/document writes or persists an attempt artifact.
Other adapters can re-execute only their computation-only contract with the same
frozen request input; a repeated filesystem observation is not proof of the same
source snapshot. Each result must be complete, validated and freshness-checked by
its consumer. Native repository scanning is not enabled by this policy.

Every larger budget has a new content-derived `requestId`; input, producer,
non-output limits, and the digest of the same complete result remain unchanged.
Attempt budgets, retry count and ceiling are operational diagnostics, not semantic
or authority state. Exhaustion reports the final budget and original cause;
output is never silently truncated. The 512 MiB byte ceiling is not a memory or
JSON-runtime capacity guarantee: string-capacity failures are reported separately
and never retried as output overflow. Envelope bytes and digest are verified
without building a second giant response string.

The control-plane executor applies timeout and external cancellation to an `AbortSignal`, clears timers and listeners in all outcomes, and returns elapsed time only as operational diagnostics outside the protocol response. JavaScript reference handlers must cooperatively observe that signal; therefore untrusted or non-cooperative work is not eligible for the in-process backend.

The Go adapter starts one executable directly with `shell: false`, a minimal environment, and the verified binary directory as its working directory. The manifest forbids descendants, network access, and project writes. Stdout is bounded by the request output limit plus framing, stderr is bounded separately, and timeout or cancellation targets the exact recorded child PID with graceful termination followed by bounded forced termination. Completion is not reported until the PID exits. Descendant-tree supervision for a future worker that is allowed to spawn children remains deferred.

## Conformance

`verifyComputeAdapterConformance` sends the exact same immutable request to the JavaScript reference adapter and a candidate adapter. The complete canonical protocol responses must match, not only a selected field. Its content-derived report records fixture names, operations, request IDs, statuses, and result digests.

Conformance proves equivalence only for the supplied fixtures. An operation cannot move to Go until its operation-specific schema, deterministic JavaScript implementation, failure fixtures, representative benchmark corpus, and semantic identity checks exist.

`worker.health.v1` is the first native conformance operation. Both backends return the same canonical authority-free readiness result. A test-only `worker.lifecycle.v1` fixture waits until the adapter timeout and proves cancellation plus PID exit; production manifests do not advertise that lifecycle operation.

The Go `repository.scan.v1` candidate covers the same bounded file traversal, built-in exclusions, normalized user-selected include/exclude roots, raw-byte hashes, UTF-8 replacement behavior, classification, language mapping, symbol cap, dependency extraction, import bindings, call extraction, skipped counts, summaries, and content-derived identity as the JavaScript reference. Canonical JSON uses JavaScript-compatible UTF-16 key ordering and escaping. The tracked corpus covers JavaScript, Python, Markdown/Unicode, configuration, Dockerfile, test classification, excluded directories, explicit source scope, unsupported files, managed projections, invalid roots, and resource-limit failures.

## Distribution and selection

Each supported platform package contains the executable and a strict `WORKER-MANIFEST.json`. The manifest binds the WorkerProtocol version, platform, architecture, normalized plugin-relative executable path, byte size, SHA-256 digest, advertised operations, process restrictions, and all-false authority flags to a content-derived manifest ID.

Selection permits only the exact platform directory and executable beneath the plugin root. The adapter rejects symlinked manifests or binaries, path traversal, realpath escape, size or digest mismatch, incompatible protocols, unsupported targets, and missing executable permission on non-Windows hosts. Platform packages are built for Windows x64, Linux x64/arm64, and macOS x64/arm64. The release workflow tests Go code, runs vet, builds a host fixture, verifies JS/Go health conformance and cancellation cleanup, and only then creates platform archives. A version-exact tag or manual dispatch publishes those archives and `SHA256SUMS` as a GitHub Release for the user-scoped installer. Main-branch publication also assembles all five verified archives into the Codex and Claude marketplace snapshots, so marketplace installs can select the current-host binary offline instead of silently falling back because no release asset was delivered.

## Fallback policy

The adapter may use the JavaScript reference path when the manifest or binary is absent, incompatible, corrupt, or does not advertise the requested operation, or when the native process cannot start, crashes, or fails during stdin delivery. The operational diagnostics record the backend, execution mode, whether fallback occurred, a bounded reason code, and verified worker identity when available. They are excluded from semantic output and content-derived identities.

Malformed or digest-invalid native responses, stdout limit violations, timeouts, and caller cancellation fail closed instead of being retried in-process. This avoids hiding an integrity failure or repeating work after the caller has explicitly stopped it.

## Repository scan v1

`repository.scan.v1` accepts an absolute project root only as an operational input. Its validated semantic result contains the content-derived `RepositorySourceScope`, normalized relative paths, content digests, sizes, classifications, languages, symbols, dependencies, import bindings, calls, skip counts, and a content-derived `scanId`. The scope has user-selected observation-boundary authority only and explicitly has no instruction or promotion authority. The result contains no absolute root, backend name, PID, timing, GraphDB identifier, Git requirement, source text, instruction authority, or promotion authority.

The World Model consumes only a successfully validated complete result. JavaScript and future native implementations must use the same source-analysis producer version and canonical ordering. Backend name, execution mode, request ID, result digest, and elapsed time remain pointer or caller diagnostics outside the World Model snapshot identity.

The tracked corpus under `benchmarks/repository-scan-v1/basic` covers file, symbol, dependency, binding, call, Unicode, classification, exclusion, and failure behavior. `npm run benchmark:repository-scan` repeats the reference operation, fails on semantic identity drift, and reports timing only as non-semantic diagnostics. `scripts/benchmark-go-repository-scan.mjs` first proves complete-response conformance, alternates backend order, rejects fallback, and reports operational medians. The reviewed Windows evaluation is stored at `benchmarks/repository-scan-v1/native-evaluation.json`: the Go path was slower for small and medium corpora and only about 1.07x faster on the large corpus. This is insufficient for default activation.

## Explicitly deferred

- compute-backed graph construction, traversal, or Context selection operations;
- production activation, size-aware selection, or transport amortization for the conformant Go `repository.scan.v1` candidate;
- worker descendants and descendant process-tree supervision;
- benchmark-based migration of file scanning, parsing, World Model construction, graph traversal, or Context selection;
- Rust or other native backends.
