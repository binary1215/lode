# Snapshot storage and preservation

New local World/Graph snapshots use compact JSON compressed as `.json.gz`. Existing `.json` files keep their original paths and bytes and are reused by ID. Installation, resume and reads do not migrate them.

## Encoding and historical reads

The existing adapters list/read both formats and return the actual physical location. Encoding does not change semantic IDs, hashes, parent provenance or authority. Explicit `snapshotEncoding: "json"` uses compact uncompressed JSON for new writes.

New files use atomic no-clobber publication. Invalid, truncated or conflicting representations fail; readers never substitute another snapshot to hide corruption. Publication failure leaves the prior pointer intact. Existing source fallback remains available.

Compressed input is bounded at 256 MiB and decoded JSON at 512 MiB to bound decompression allocation. These storage limits do not change Context token tiers, child stdout or MCP limits. Existing raw JSON keeps its prior caller-specific bounds. Original typed readers still verify decoded identity, digest and structure.

Historical boundary references bind exact physical path, byte length and raw SHA. Both suffixes are accepted for World references, but equivalent decoded content cannot replace a byte-pinned original. Existing boundary byte limits remain unchanged.

Compression saves disk bytes and adds computation. It does not prove faster parsing, verification or queries. Measure the same Project/identities/query and report read, decompression, parse and typed verification separately. A first query after fixture preparation is not OS-cache-cold.

## Storage inspection; deletion is not available yet

```powershell
lode-agent storage-gc C:\path\to\project
lode-agent storage-gc C:\path\to\project --json
```

CLI inspection requires no selected Session; it adds no public MCP operation. The short output shows counts and preservation; structured output adds physical bytes, observed dependencies and coverage gaps.

**GC apply is incomplete and unavailable.** Even `--apply` or `apply: true` preserves every file and returns zero deleted/reclaimable bytes. Observed unreferenced bytes are candidates for further checking, not certified safe deletions. Inspection writes no review, checkpoint or cleanup plan. Default inspection exits 0; unsupported apply exits 1 with `SNAPSHOT_GC_APPLY_UNAVAILABLE` while preserving the useful inspection result.

The diagnostic follows identifiers from current/previous pointers, parents, ChangeSets, refresh requests/receipts, Capsules, Session/Run/checkpoint and review/onboarding records, including exact historical byte references. Ambiguous matches retain the entire observed closure. Unknown schema, unsafe paths, missing roots, stages, active/unknown writers and bounded-scan omissions remain explicit gaps. String matching does not certify reference validity or absence.

The missing boundary is reference publication: `compileContext`, `recordChangeSet`, execution-lineage publication and direct adapter callers do not yet all protect snapshot validation through commit against GC. A gate at rename alone is too late for a writer that read a snapshot before deletion. Full apply requires actual transaction coverage, including async/nested/inherited-lease paths, and must yield promptly to active work. This patch adds no global writer gate to ordinary work.

There is no background collector or age/last-N deletion. When all snapshots are referenced, observed unreferenced count is zero. Real cleanup requires a later implemented and verified apply path and explicit execution authority.

## Generated Git ignore rules

Initialization and explicit resume create the selected `.lode/.gitignore` or retained `.head/.gitignore` only when it is absent. Every existing file stays untouched, including user-edited generated rules. Atomic no-clobber creation preserves a file created concurrently. Explicit Project negations skip optional generation. Optional ignore failure does not block project readiness or ordinary work.

| Relative pattern inside storage | Why disposable |
| --- | --- |
| `/graph-discovery/index.json` | Rebuilt from verified original records. |
| `/.operations/` | Transient process-owned scoped locks. |
| `/refresh/writer.lock/` | Host-local active refresh lease. |
| `/refresh/writer.lock.*.staging/` | Unpublished refresh lease staging. |

No snapshots, Canon, Session records, Capsules, historical boundaries, installation manifests or user-edited documents are blanket-ignored. The helper never runs Git, stages/untracks files or changes global configuration. Ignore rules reclaim no disk space.

## Explicit local Git snapshot candidate

Gzip remains the default for new ordinary snapshots. Only the internal local World/Graph adapter option `snapshotEncoding: "git"` selects new-only storage in the Project-managed `snapshot-objects.git`. It does not alter the product repository's Git settings, index, branches, hooks or remotes. Existing JSON/gzip originals are neither migrated nor re-encoded. Default consumers can read all three representations and retain exact identity, Project and content-hash verification.

A Git original has no physical JSON path. Where a location is already part of the public result, World/Graph return `file: null` or `snapshotLocation: null` with a small `snapshotStorage` descriptor: store ID, object format/ID, encoding, raw byte length and SHA-256. Current-pointer and refresh-receipt paths remain real JSON files. The bounded World MCP status has no location field and gains no locator.

World, freshness, Compiler, lineage, Explorer and dependent workflows await storage I/O completion. Factories, hashes, verifiers and diff computation remain synchronous. CLI and typed MCP consume the same completed values and errors. Discovery does not collect new snapshots or select a configured external adapter; legacy historical inventory 0.1 file pins are unchanged.

Each private Git operation shares a deadline and cancellation signal; children are hidden, shell-free and reaped before completion. No filter, textconv or lazy fetch runs. Immutable refs are create-only; concurrent writes converge only for the exact same original. Project/store/raw/object mismatches, linked paths, external alternates and unapproved private configuration fail the affected operation. No ref deletion, GC, automatic pack or source-specific Git writer is introduced. Physical managed-store changes are excluded from code-source freshness; actual source, Canon and P3 changes remain observable.

Default adoption requires measured costs and independent review. A smaller active pack is not proof of lower total disk use when loose originals are retained, or of faster reads.

## Local domain-bundle trial (explicit; not a new default)

The internal local adapters accept `snapshotLayout: "domain-bundles-v1"`. Ordinary adapters still write whole gzip snapshots. Existing IDs, JSON/gzip files, Git objects and historical byte pins are not rewritten. This trial adds no user pin/save/approval step.

The trial emits Graph protocol 0.16 alongside the unchanged 0.15 producer. A relation has a stable `logicalRelationId`, an evidence-sensitive `contentRevisionId`/`edgeId`, and its exact `sourceSnapshotId` observation. Logical identity includes Project, endpoint logical identities and continuity generation/unknown state, type, origin, authority and producer. Content revisions also bind concrete endpoints, evidence, freshness and confidence. Edges targeting a SourceSnapshot bind that exact endpoint. Deletion/recreation, another Session, changed evidence or confidence cannot silently become the same observation or revision. Existing graph protocols retain their original verification and IDs.

A compact composition references at most three immutable domain bundles: World code facts/semantic analysis, normalized code graph records, and the remaining graph composition. Repository-wide evidence, Product/decision relations and snapshot membership remain in the changing composition. Unchanged code bundles can be reused across decision-only changes; graph-node/edge observation membership is restored during exact reconstruction. Bundles are not one file per node. Optional native `bundleEncoding: "zstd"` is a local trial; absent runtime support is reported and never triggers installation.

The writer reuses semantic analysis only from a previously verified World with the same complete analysis input basis: Project, all scanner facts, source scope/rules, producer versions, source-relation input and managed-file exclusions. Canon/projection relations and continuity are still rebuilt. The result reports whether this analysis was reused; matching mtime/size or source bytes alone is insufficient.

Readers verify composition and bundle Project/type/schema/producer, exact managed address, SHA-256 and decoded length; depth, count and total reconstruction are bounded by the existing 512 MiB storage limit. Verification reuse is request-local and bound to immutable addresses. Missing or corrupt chunks are errors for the dependent read; they are never replaced with current source. The reconstructed World/Graph still passes the original typed/semantic verification. File/Git locators describe physical representation; the composition separately binds reconstructed content. This is not authority or a P2 recovery direction.

The same trial can use explicit Git roots plus gzip domain files. This is a hybrid, not a claim that all chunks are Git objects. No automatic pack, cleanup, ref deletion or remote access runs on ordinary reads or approval. A missing Git executable has `SNAPSHOT_GIT_EXECUTABLE_UNAVAILABLE`; existing file-backed reads remain available. A non-Git product folder does not prevent the private candidate store.

### Typed preservation observation

Structured `storage-gc` inspection now includes `typedClosure` over actual verified Capsules, ChangeSets and execution-lineage artifacts, then exact World, Graph, domain dependencies and retained source bundles. Semantic path/digest references are distinct from physical byte pins. Unknown roots, missing dependencies and intermediate publication are retained and disclosed. A World file record alone does not retain the original source bytes.

This projection is an observed read sequence, not a transaction or deletion certificate. Writer validation-to-publication and active-reader lifetime remain uncovered for a future collector. Apply, ref deletion and persistent leases remain absent; all existing storage is preserved. Do not use a successful inspection to claim cleanup is safe.

The private Git store creates an ignore file only inside its own newly owned store/staging area and only when parent user policies have no explicit negation. It preserves existing ignore files and tracking; it neither stages nor untracks anything. These retained objects have recovery value and are not disposable cache.

An exact source-bundle pin uses the raw digest of the same buffer parsed by the existing bundleKey/Project/schema/observation verifier. Observed physical bytes must match that digest; a mismatch remains retained, unverified and partial. Repeated before/after path reads alone do not prove this binding or prevent ABA substitution. This still does not certify a future reader/writer lifetime.

## Adopted incremental-scale scope

Ordinary whole gzip and the existing domain-bundles-v1 contract remain unchanged. Full World/Graph hash, original-byte, Project and authority checks are retained. Changed bytes from one synchronous source observation are consumed by analysis instead of accumulated until the walk ends; ownership validation of reused previous analysis stays intact. There is no new cache/save/pin/approval step or daemon.

File-level relation reuse and two packed-chunk formats were evaluated in separate local frozen trials. Additional validation/copy and full reconstruction/file-check costs increased observed end-to-end latency, so these trials are not adopted into the active product path. The existing domain trial's exact whole codeAnalysisInputBasis reuse is preserved. Full traversal/hash, relationship generation, serialization/verification, snapshot listing and Git namespace checks remain; this patch does not claim an O(change) whole pipeline. No history/original migration, GC or ref deletion occurs.
