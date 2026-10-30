# GraphProjectionAdapter contract

Read [`architecture.md`](architecture.md) and
[`authority-plane-contract.md`](authority-plane-contract.md) before changing
this boundary.

## Purpose

`GraphProjectionAdapter` version `0.1.0` separates the semantic temporal `GraphSnapshot` from the backend used to materialize and traverse it. Temporal provenance protocol `0.12.0` embeds the P4 boundary from the [`AuthorityPlaneContract`](authority-plane-contract.md). The embedded, digest-verified GraphSnapshot in the World Model remains the recoverable source for rebuilding a projection. Neither the snapshot, local adapter, nor ArcadeDB adapter is Product semantic Canon, instruction authority, promotion authority, or unique authority.

Product semantic Canon remains P1; the Core GraphSnapshot is its P4 relation and retrieval index. The graph's ProductModel identity binds the exact projected source without transferring its normative authority. Distribution and Host are architectural planes, not additional meaning planes. A graph adapter runs behind an exact Product Canon byte fence: mutation or deletion is restored and rejected before the World Model pointer can advance.

The contract exists alongside `WorldModelStoreAdapter` rather than replacing it:

```text
canon + executable state + verified lineage
  -> RepositoryWorldModel containing recoverable GraphSnapshot
       -> GraphProjectionAdapter
            -> local JSON projection
            -> in-memory conformance projection
            -> activated ArcadeDB HTTP projection + local mirror
```

Backend identity, filesystem locations, remote record IDs, and operational timing are excluded from `GraphSnapshot`, `TraversalQuery`, `TemporalTraversalResult`, Context Capsule, and World Model semantic identities.

## Required interface and authority

Every adapter implements synchronous host-facing methods:

```text
describe
readPointer
readSnapshot
writePointer
writeSnapshot
listSnapshotIds
query
```

The host-facing contract remains synchronous. `ArcadeDbHttpTransport` uses an exact-child Node bridge for the asynchronous HTTP request and exchanges bounded JSON over standard input/output. Credential values are resolved from the named environment variables only inside that child, never placed in command arguments, request artifacts, activation receipts, descriptors, or semantic identities.

Every descriptor must declare:

```text
contract: replaceable-rebuildable-derived-graph-projection
authority: derived-evidence-only
rebuildable: true
uniqueAuthority: false
instructionAuthority: false
promotionAuthority: false
remote: boolean
durable: boolean
```

An adapter that claims project canon, instruction, promotion, or unique authority is rejected before materialization.

## Local materialization

The default local adapter stores:

```text
.lode/graph-projection/current.json
.lode/graph-projection/snapshots/graph-snapshot-*.json.gz
.lode/graph-projection/snapshots/graph-snapshot-*.json
```

New local snapshot files use compact `.json.gz`; existing `.json` snapshots remain byte-for-byte intact. See [Snapshot storage and preservation](snapshot-storage.md) for physical encoding and the current inspection-only GC surface.

The snapshot is immutable and byte-semantically equivalent under canonical JSON to the verified graph embedded in the current World Model. The pointer is content-addressed and records the project, GraphSnapshot, GraphSnapshot hash, and SourceSnapshot identities plus the non-authoritative projection flags.

World Model indexing writes and verifies the immutable World Model snapshot, materializes and re-reads the graph projection, then advances the World Model pointer. A projection failure therefore cannot make an unverified graph current in the World Model. A projection snapshot left behind before a later pointer failure is harmless derived data and is verified again before reuse.

## Query and fallback behavior

Temporal traversal protocol `0.2.0` first computes the deterministic reference contract from the embedded recoverable GraphSnapshot. Lexical discovery and exact Lode-proposed anchors are mutually exclusive. Exact mode binds one to 32 eligible node IDs to the current GraphSnapshot and cannot widen the caller's relation, authority, freshness, confidence, depth, node, edge, or candidate policy. A current adapter query must return the exact same canonical `TemporalTraversalResult`, including GraphSnapshot, query, result identities, ordering, bounds, inclusion, and exclusion reasons.

- current adapter: query through the adapter and reject any semantic mismatch;
- no materialized adapter pointer: use the embedded graph and disclose `GRAPH_PROJECTION_NOT_MATERIALIZED`;
- different projected current GraphSnapshot: fail closed with `GRAPH_PROJECTION_STALE`;
- missing, corrupt, tampered, or conflicting snapshot/pointer: fail closed;
- backend absence never removes the embedded graph or changes semantic identity.

The reference comparison intentionally favors correctness over acceleration. `PreparedTraversalRequest` protocol `0.1.0` now binds the already-fixed GraphSnapshot identity, deterministic TraversalQuery, expected result identity, and exact unfiltered bounded node/edge radius. An adapter returns a content-derived verification receipt; it never returns or chooses the authoritative semantic result. The provider-neutral client still returns its deterministic reference result after receipt verification.

## ArcadeDB activation and materialization

Onboarding persists only the ArcadeDB endpoint, database, and environment-style username/password reference names. Selection alone is pending configuration and does not activate remote I/O. With both referenced environment variables available, activation is explicit:

```powershell
node scripts/lode.mjs world-graph-remote-database-status C:\path\to\project
node scripts/lode.mjs world-graph-remote-database-initialize C:\path\to\project
node scripts/lode.mjs world-graph-remote-activate C:\path\to\project
node scripts/lode.mjs world-graph-remote-status C:\path\to\project
```

Database status is read-only and reports a content-derived compatibility audit without endpoint, database name, credential value, or record identity. Initialization creates a missing selected database. Existing unrelated types do not block activation and are never a reset reason. The nine `LodeAgentGraph*` reserved types are checked for kind, properties, exact UNIQUE keys and relevant write constraints. Observed keys and constraints are bound into the audit hash. Missing types/properties/indexes are a compatible partial schema, not proof of activation readiness. Unavailable metadata is unverified, not permission to reset. A proven incompatible reserved contract permits an explicit whole-database reset only with both `--reset-incompatible true` and an exact `--confirm-database` match; inspection and non-destructive repair remain alternatives. Reset invalidates mutable pointers, retaining immutable receipts and the local graph mirror. Activation verifies the provisioned reserved schema before graph writes. This is not a generic migration engine or a version-wide gate.

Activation provisions the projection, topology and sync schema, compares current and target graphs, and writes a content-addressed delta manifest. Batches default to at most 50 records, with a maximum of 200. Exact records use semantic identity; snapshot-only changes use compact rebase records, while new or changed content uses full canonical JSON. Every call reads actual batch content, even if a checkpoint exists. Exact content needs no repeated batch write; foreign content is preserved as conflict, and partial or unverified effects remain unknown. Missing checkpoints are not evidence that a write never ran. New batch writes use create-only records and required UNIQUE keys, not node UPSERT; a competing insert cannot be overwritten. Response loss is reconciled by exact read-back, never an unconditional batch/SQL retry. These adapter guarantees are required of alternative transports as well.

Header/body transport failure on the first read can use an exact verified local mirror only before any remote observation, including a null result. Authentication, malformed or empty successful query responses, integrity errors, and size limits do not trigger that fallback. JS and Go read bridges reject empty success bodies. Write response loss is a potentially applied effect and remains unknown unless exact read-back proves it; neither local fallback nor read failure authorizes a write replay. These are operational boundaries, not new Core-only workflow gates. Local fixtures do not establish live ArcadeDB conformance.

After all batches are complete, activation writes and verifies the complete topology plus a small topology-backed GraphSnapshot envelope instead of duplicating the full graph JSON remotely. Baseline adapter equivalence and prepared server-traversal conformance use a staged target pointer, so neither pass can make the candidate current. Only after both passes and the local recovery snapshot succeed does a single conditional pointer update advance an existing pointer from the exact observed predecessor; an initial pointer uses the project-unique index as its compare-and-insert fence. The result is re-read, a different predecessor fails closed, and an already installed identical target is accepted idempotently. The local pointer then mirrors it atomically. `.lode/graph-projection/arcadedb/sync/receipts` records a content-derived receipt binding manifest, checkpoint set, prior/final pointers, full snapshot/topology verification, local recovery, and the atomic transition. Credential values, endpoints, target names, server record identities, and timing remain excluded.

The local canonical GraphSnapshot remains the independent recovery source. The remote topology-backed envelope reconstructs that exact graph from snapshot-scoped vertices and edges and rejects count, set-digest, topology, byte-length, or full-content mismatch. Every vertex stores the exact semantic node JSON and every edge stores the exact semantic edge JSON while ArcadeDB record IDs remain operational details. The topology manifest binds the project, GraphSnapshot, SourceSnapshot, sorted node and edge set digests, counts, and non-authority flags to a content-derived identity. Unique indexes bind vertices and edges to `(projectId, graphSnapshotId, semanticId)` without making those database indexes semantic identity.

Activated query mode remains `server-expanded-client-canonicalized`. A newly conformed activation advertises prepared traversal `0.1.0`. Query execution computes the deterministic reference locally from the embedded GraphSnapshot, verifies the current remote pointer and topology manifest, then asks ArcadeDB to expand only the prepared snapshot-scoped radius with breadth-first `TRAVERSE`. It does not reload the full remote snapshot or complete vertex/edge topology. One semantic hop is two physical traversal depths (vertex to edge to vertex), depth remains zero through three, and the response is capped at 8,192 records with one additional record used only to detect overflow.

The pointer verified at prepared-query inspection is reused exactly once by the immediately following synchronous query through a non-serializable object token bound to that `ArcadeDbGraphProjectionAdapter` instance. The token is not a credential, cache, receipt, semantic field, or persistent artifact. A missing, foreign, invalid, or already-consumed token performs the normal remote pointer read, and the pointer document is still checked against the complete prepared GraphSnapshot identity. This removes only the duplicate round trip; it does not extend freshness across queries or let callers assert current state.

After that independent pointer check, the topology-manifest read and bounded traversal use one query-only exact-child batch. The JavaScript child is the reference implementation. A separate Go child may be selected only from a content-addressed platform manifest in the verified native distribution; it resolves the same environment-reference names, accepts no write operation, and returns untrusted response envelopes. Missing native artifacts use the JavaScript batch. Native startup, invalid-output, or post-selection binary-integrity failure falls back to that reference path with operational diagnostics, while an invalid installed manifest fails closed. The computation worker remains network-forbidden: GraphDB access belongs only to this transport boundary.

The server response is evidence, not semantic authority. The client requires the exact prepared radius, verifies every JSON record and physical traversal depth, and rejects stale manifests, missing coverage, duplicates, forged or out-of-radius records, and truncation. It then returns the unchanged deterministic `TemporalTraversalResult`; server ordering, ArcadeDB record IDs, transport metadata, and verification receipts never enter query or result identity. This is query-scoped integrity: status inspection and activation still perform complete remote snapshot/topology verification, so corruption outside the requested radius is detected by those full-audit paths rather than claimed away by a bounded query.

## Prepared traversal performance evidence

`PreparedTraversalCostEvidence` protocol `0.1.0` is content-derived from the exact GraphSnapshot and `PreparedTraversalRequest`. Its payload model counts normalized UTF-8 canonical-JSON response components: the identity envelope, graph manifest, bounded expansion, complete GraphSnapshot, and complete topology records. The prepared total contains only the identity envelope, manifest, and bounded expansion. The conservative full-reload baseline adds one complete snapshot and one complete topology record set. This is reproducible logical transport-cost evidence, not a claim about HTTP framing, compression, database cache state, or wall-clock latency.

The reviewed 64-file fixture under `benchmarks/prepared-traversal-v1` fixes graph, request, result, and cost-evidence identities. With the P1-P5 authority boundary and current summary fields included in the GraphSnapshot, it records 20,491 prepared bytes versus an 836,589-byte baseline, saving 816,098 bytes or 9,755 basis points. Run it with:

```text
npm run benchmark:prepared-traversal -- --iterations 7
```

Elapsed time and observed transport-call sizes are emitted only under diagnostics and never enter `PreparedTraversalCostEvidence`, graph, query, result, or Capsule identity. The fixture verifies zero full snapshot reads, zero full topology reads, and zero query-phase writes.

An already activated prepared ArcadeDB project can use the same harness in strictly read-only mode:

```text
npm run benchmark:prepared-traversal -- --live-project <project-path> --iterations 7
```

The live path reads the project-scoped activation and environment reference names, accepts no credential values or credential flags, rejects fallback and semantic drift, and replaces every schema/snapshot/topology/pointer write method with a fail-closed guard. Reports exclude endpoint, database, credential values, and project paths. A fixture run proves the contract and deterministic cost identity; only a successful `arcadedb-live-read-only` report proves behavior and latency against a live environment.

The 2026-08-20 privacy-safe live acceptance used an already verified 8,037-node and 12,441-edge project graph. Seven identical prepared traversals processed 220,930 normalized bytes instead of the 23,101,697-byte full-reload baseline, saving 22,880,767 bytes or 9,904 basis points. Every run preserved the exact graph, request, query, and result identities; query-phase writes, full snapshot reads, and full topology reads remained zero. The first run measured 2,942.2 ms end-to-end and 134.7 ms for bounded database expansion. After removing duplicate pointer reads and redundant receipt work, the fresh completion run retained the same semantic and byte identities with a 2,820.4 ms end-to-end median and 137.7 ms database-expansion median; timing remains diagnostic rather than semantic evidence.

The same completion acceptance exercised the new write path against a dedicated project namespace in the selected live database. The 8,037/12,441 production-sized projection passed a zero-batch no-change sync with identical predecessor/target pointers, verified snapshot/topology/local mirror, and an immutable receipt. A separate small fixture passed initial upload, a four-batch delta, interruption after one checkpoint, checkpoint resume, stale-predecessor pointer-conflict rejection, and conflict recovery. It also exposed and fixed three transport defects before acceptance: forced bridge exit after a valid large response, SQLScript use of a server-reserved variable in CAS, and endpoint-based `IF NOT EXISTS` suppression of distinct parallel semantic edges. The acceptance namespace was removed exactly and verified at zero remaining records; the nine reserved types and unrelated records were preserved.

An interrupted sync resumes only from a digest-verified manifest and immutable verified checkpoints. An uncheckpointed batch is safe to replay, but a conflicting manifest, checkpoint, batch record, complete topology, or pointer predecessor fails closed rather than being repaired silently.

After activation, the default adapter mirrors every successful remote snapshot and pointer into the local JSON projection. Connection/timeout or missing-environment-reference failure may select the local mirror only before any remote content has been observed or mutated in that operation. Authentication failure, rejected requests, stale pointers, missing records, digest mismatch, content conflict, semantic query divergence, or failure after a remote observation/mutation fail closed. If local progress occurs during a remote outage, a later stale remote pointer also fails closed until explicit activation repairs and re-verifies the projection.

## Active adapters and surfaces

- `LocalJsonGraphProjectionAdapter`: durable dependency-free baseline;
- `InMemoryGraphProjectionAdapter`: non-durable conformance implementation;
- `ArcadeDbGraphProjectionAdapter`: authenticated ArcadeDB HTTP/JSON durable projection with resumable content-addressed delta batches, immutable checkpoints, snapshot-scoped vertex/edge topology, topology-backed snapshot reconstruction, pointer compare-and-swap, and optional conformance-gated prepared bounded expansion without full query-time reload;
- `ActivatedArcadeDbGraphProjectionAdapter`: remote-first adapter with a complete local mirror and narrowly classified pre-observation availability fallback;
- `verifyGraphProjectionAdapterConformance`: content-derived report naming both authority-bounded adapters and proving adapter-neutral semantics over one GraphSnapshot and one-to-64 named bounded query fixtures;
- `world-graph-status`: read and verify projection state;
- `world-graph-remote-activate` and `world-graph-remote-status`: explicit activation and read-only remote status;
- `world-graph-remote-database-status` and `world-graph-remote-database-initialize`: read-only compatibility audit and explicit exact-target provisioning/reset boundary;
- `lode_graph_projection_status`: read-only MCP equivalent;
- `lode_graphdb_projection_status` and `lode_graphdb_database_status`: read-only MCP activation and compatibility status equivalents;
- `world-temporal`, MCP temporal traversal, and Context Compiler temporal expansion use the adapter boundary while preserving result identity.
- the separate [`DocumentProjectionAdapter`](document-projection-adapter.md) consumes the verified GraphSnapshot for deterministic Markdown without changing graph identity.

## Deferred

- adaptive concurrency and measured batch-size tuning beyond the bounded deterministic default;
- further local canonical-verification amortization only where a new measured bottleneck preserves independent trust-boundary checks;
- non-ArcadeDB GraphDB transports;
- asynchronous pooled remote transport, retry/backoff, and transport amortization;
- compute-backed graph construction or traversal;
- topology schema migrations and operational observability;
- Obsidian/Notion document adapters.

Automated tests use an in-memory transport and do not require or mutate a user GraphDB. Database initialization and graph activation are the only explicit remote mutation surfaces; neither accepts credential values as arguments.

The optional ArcadeDB native read bridge is a separate exact child, not the Go
computation worker. `LODE_AGENT_ARCADEDB_NATIVE_MODE=auto|off|required` selects
its runtime availability policy. Missing native capability may use the
JavaScript reference exact child only in `auto`; selected binary or manifest
integrity drift fails closed in every mode. Both exact children receive only the
configured username/password reference values and a bounded operational
environment. The Go bridge rejects redirects, applies one deadline and one
aggregate wire budget to the complete batch, and exposes only SELECT queries on
the ArcadeDB query endpoint. Parent-side canonical graph and receipt validation
is unchanged.
