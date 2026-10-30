# Snapshot storage and preservation

New local World/Graph snapshots use compact JSON compressed as `.json.gz`. Existing `.json` files keep their original paths and bytes and are reused by ID. Installation, resume and reads do not migrate them.

Ordinary complete writes under a selected Project owner use `shared-domains-v2`: a gzip root with
the changing composition inline and references to immutable code parts. A World
uses at most two parts, a Graph at most one. The parts retain the existing domain
schema 1 / producer 0.1.0; only the root uses schema 2 / producer 0.2.0. There is
no chain of previous snapshots to reconstruct. Decisions can reuse code parts;
code changes may replace an entire code part. Snapshot membership metadata still
scales with the graph. This is neither selective first-read IO nor O(change) work.

Pure lower adapters without a selected Project owner retain whole-document
storage. They do not require initialization to keep their existing contract.
Explicit composition choices still require and fully validate the owner.

The minimum reader is a release supporting physical schema 2. **Beta.69 and
earlier reject new schema-2 roots** with `INVALID_SNAPSHOT_COMPOSITION`; they do
not downgrade or rewrite them. Update each client sharing the Project before
reading new World/Graph snapshots. This is format compatibility guidance, not a
new setup or approval gate. Older whole JSON/gzip, Git and domain-v1 originals
remain readable by the new reader, in place. Explicit whole/Git/v1 choices remain
available. Physical layout does not add fields to new semantic World payloads;
an already recorded v1 analysis field is preserved for unchanged-history identity.

Readers retain the full part/address/Project/type/producer/digest and reconstructed
World/Graph verification. Parts are dependencies of the existing retention and
deletion closures and publisher/reader lifetimes. A missing, corrupt or denied
part fails the dependent read; current data never substitutes for it. Existing
Graph-first/World pointer publication can still report a partial failure: this
layout does not create a two-pointer atomic transaction or roll back committed work.

## Encoding and historical reads

The existing adapters list/read both formats and return the actual physical location. Encoding does not change semantic IDs, hashes, parent provenance or authority. Explicit `snapshotEncoding: "json"` uses compact uncompressed JSON for new writes.

New files use atomic no-clobber publication. Invalid, truncated or conflicting representations fail; readers never substitute another snapshot to hide corruption. Publication failure leaves the prior pointer intact. Existing source fallback remains available.

Compressed input is bounded at 256 MiB and decoded JSON at 512 MiB to bound decompression allocation. These storage limits do not change Context token tiers, child stdout or MCP limits. Existing raw JSON keeps its prior caller-specific bounds. Original typed readers still verify decoded identity, digest and structure.

Historical boundary references bind exact physical path, byte length and raw SHA. Both suffixes are accepted for World references, but equivalent decoded content cannot replace a byte-pinned original. Existing boundary byte limits remain unchanged.

Compression saves disk bytes and adds computation. It does not prove faster parsing, verification or queries. Measure the same Project/identities/query and report read, decompression, parse and typed verification separately. A first query after fixture preparation is not OS-cache-cold.

## Storage inspection and explicit cleanup

```powershell
lode-agent storage-gc C:\path\to\project
lode-agent storage-gc C:\path\to\project --json
lode-agent storage-gc C:\path\to\project --apply --json
```

Default inspection is zero-write. Observed unreferenced bytes are a diagnostic, not permission or proof that deletion is safe. No selected Session, new MCP tool, user pin/save form or background collector is required.

Explicit CLI `--apply` awaits a separate typed reachability check and deletes proven orphan World/Graph JSON/gzip representations, supported private Git snapshot addresses/objects, and unreferenced domain fragments. It preserves current/previous pointers, parents and source aliases, Capsules, supported ChangeSet/VCS and execution-lineage roots, verified Session/checkpoint roots, and physical byte references. It never deletes Canon, Session records or valid source bundles: successful and failed source bundles are original P3 evidence and remain roots themselves. There is no age or last-N deletion. When every snapshot is referenced, successful apply deletes zero files.

The closed root/path verifier registry is in `scripts/lib/snapshot-deletion-closure.mjs`. Core initialization, whole snapshots, Capsules, execution-lineage, checkpoints, normal SessionWork/Todo, separately routed Session pointers, reviewed Run originals and ChangeSet/impact pointers have supported paths. Additional Product/onboarding, refresh, Run/Session and observation layouts are supported only where their exact paths have a registered original verifier. Unknown paths/schema, corrupt or missing dependencies, incomplete bounded scans, unsupported backend structures, unsafe paths and unknown owners preserve the candidate set with specific coverage reasons. This first file collector does not claim complete support for every existing artifact layout. Missing source-byte retention is distinct from snapshot reachability; cleanup never captures replacement originals.

Current cooperating local publishers register a transient Project-local P5 lifetime before original validation and retain it through actual asynchronous completion. New ordinary work invalidates that GC attempt permanently, even if the work finishes before the scan does. Only registration and one-file unlink use short admission; parsing, hashes and awaits do not serialize ordinary work. Borrowed/nested lifetimes remain covered. An expired detached callback cannot publish cached references without reacquiring its exact originals. Synchronous pointer APIs stay synchronous, validate exact file targets under a lifetime and do not gain Product approval gates. Separate low-level calls do not reserve an orphan between calls.

Pure readers do not register or write management files. A retained immutable closure protects historical reads; already materialized calculations need no further opens. An explicit arbitrary orphan-ID read racing cleanup can return the real missing/unavailable error, never a substituted current snapshot. Unsupported or ambiguous coverage prevents cleanup rather than blocking unrelated work. Registration failure cannot silently run a dependent publication unguarded while a collector may start.

The scan decodes one original file at a time, runs the same pure typed verifier, and retains only ID/source-alias/full-hash/exact-byte-pin summaries. The existing 512 MiB per-file decoded bound applies before allocation/parsing. Stored input remains bounded at 1 GiB and 50,000 entries; encoded reference summaries are bounded at 64 MiB. Total decoded input is measured without a small cumulative decoded limit that permanently excludes ordinary history. These are not total V8 RSS guarantees. File-level event-loop yields and cancellation checks stop a cancelled scan before the next file.

Only explicit GC qualifies the filesystem. Windows uses a hidden, deadline-bound DriveInfo query and preserves mapped/network/unknown drive types. Linux currently supports statfs types for ext filesystems, XFS, Btrfs and tmpfs. Other platforms and unknown filesystems preserve cleanup. Ordinary work gains no PowerShell probe; statically unsupported platforms, UNC roots and Linux filesystem types do not require new publisher registration. OS classification does not prove every hidden backing layer or exclude noncooperating hosts.

Supported mixed backends are verified together; their presence no longer excludes all cleanup or bypasses publisher lifetimes. A malformed Git placeholder without an owner/config remains excluded while ordinary work retains its existing bypass. Initial Git retirement supports only the owned SHA256 direct loose-ref format with no packed refs, reflogs or snapshot symrefs. One ref is compared under nonblocking ref and packed-ref locks; unsupported forms are preserved. Source originals are verified and retained without blocking unrelated domain/Git orphan cleanup.

This is a cooperative local filesystem protocol, not universal exclusion of old/raw writers or shared hosts. Known foreign/unknown ownership and unsupported storage are preserved; absence of new lock files is not proof that every old process has stopped. No age/PID guess reclaims snapshot lifetime records. Participant/attempt records are transient operations, not P2 direction, review or retention plans.

Structured apply output separates deleted, failed and preserved paths and reports actual completed count/bytes after cancellation, drift or a later unlink failure. Successful `gc_applied` exits 0; preserved/yielded/partial results exit 1 and retain their useful structured result. Human output explains zero-removal success, yielding, unsupported apply, incomplete preservation and partial effects separately; error codes remain visible. No effect is automatically replayed. Git ref retirement and physical file reclamation are separate results. Output reports actual unlinked bytes, new pack bytes and net managed-file bytes; file length is not allocated disk blocks. Migration and installation are separate.

## Generated Git ignore rules

Initialization and explicit resume create the selected `.lode/.gitignore` or retained `.head/.gitignore` only when it is absent. Every existing file stays untouched, including user-edited generated rules. Atomic no-clobber creation preserves a file created concurrently. Each generated rule is checked separately against root exceptions. For example, `!.gitkeep` permits the exact `/graph-discovery/index.json` rule but preserves directory-wide rules that could hide a descendant `.gitkeep`. A provably disjoint rooted exception permits its unrelated rules; overlapping or ambiguous wildcard/escape rules remain skipped. Results identify the included and skipped subset. The helper rechecks observed policy bytes before creation; it does not lock arbitrary external editors or change tracked files. Optional ignore failure does not block project readiness or ordinary work.

| Relative pattern inside storage | Why disposable |
| --- | --- |
| `/graph-discovery/index.json` | Rebuilt from verified original records. |
| `/.snapshot-gc/` | Transient local snapshot participants and GC attempts. |
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

The internal local adapters still accept `snapshotLayout: "domain-bundles-v1"` explicitly. Ordinary complete snapshots use the flat v2 layout above; `snapshotLayout: "whole"` preserves whole-file writes. Existing IDs, JSON/gzip files, Git objects and historical byte pins are not rewritten. This older trial adds no user pin/save/approval step.

The trial emits Graph protocol 0.16 alongside the unchanged 0.15 producer. A relation has a stable `logicalRelationId`, an evidence-sensitive `contentRevisionId`/`edgeId`, and its exact `sourceSnapshotId` observation. Logical identity includes Project, endpoint logical identities and continuity generation/unknown state, type, origin, authority and producer. Content revisions also bind concrete endpoints, evidence, freshness and confidence. Edges targeting a SourceSnapshot bind that exact endpoint. Deletion/recreation, another Session, changed evidence or confidence cannot silently become the same observation or revision. Existing graph protocols retain their original verification and IDs.

A compact composition references at most three immutable domain bundles: World code facts/semantic analysis, normalized code graph records, and the remaining graph composition. Repository-wide evidence, Product/decision relations and snapshot membership remain in the changing composition. Unchanged code bundles can be reused across decision-only changes; graph-node/edge observation membership is restored during exact reconstruction. Bundles are not one file per node. Optional native `bundleEncoding: "zstd"` is a local trial; absent runtime support is reported and never triggers installation.

The writer reuses semantic analysis only from a previously verified World with the same complete analysis input basis: Project, all scanner facts, source scope/rules, producer versions, source-relation input and managed-file exclusions. Canon/projection relations and continuity are still rebuilt. The result reports whether this analysis was reused; matching mtime/size or source bytes alone is insufficient.

Readers verify composition and bundle Project/type/schema/producer, exact managed address, SHA-256 and decoded length; depth, count and total reconstruction are bounded by the existing 512 MiB storage limit. Verification reuse is request-local and bound to immutable addresses. Missing or corrupt chunks are errors for the dependent read; they are never replaced with current source. The reconstructed World/Graph still passes the original typed/semantic verification. File/Git locators describe physical representation; the composition separately binds reconstructed content. This is not authority or a P2 recovery direction.

The same trial can use explicit Git roots plus gzip domain files. This is a hybrid, not a claim that all chunks are Git objects. No automatic pack, cleanup, ref deletion or remote access runs on ordinary reads or approval. A missing Git executable has `SNAPSHOT_GIT_EXECUTABLE_UNAVAILABLE`; existing file-backed reads remain available. A non-Git product folder does not prevent the private candidate store.

### Typed preservation observation

Structured `storage-gc` inspection now includes `typedClosure` over actual verified Capsules, ChangeSets and execution-lineage artifacts, then exact World, Graph, domain dependencies and retained source bundles. Semantic path/digest references are distinct from physical byte pins. Unknown roots, missing dependencies and intermediate publication are retained and disclosed. A World file record alone does not retain the original source bytes.

This projection is an observed read sequence, not a deletion certificate. Explicit apply uses the separate typed deletion closure and transient publisher lifetimes described above. This observation alone never authorizes deletion; Git refs and original bundles remain retained. Do not use a successful inspection to claim cleanup is safe.

The private Git store creates an ignore file only inside its own newly owned store/staging area and only when parent user exceptions are provably unrelated to that area. Potentially overlapping or ambiguous exceptions preserve the user policy. It preserves existing ignore files and tracking; it neither stages nor untracks anything. These retained objects have recovery value and are not disposable cache.

An exact source-bundle pin uses the raw digest of the same buffer parsed by the existing bundleKey/Project/schema/observation verifier. Observed physical bytes must match that digest; a mismatch remains retained, unverified and partial. Repeated before/after path reads alone do not prove this binding or prevent ABA substitution. This still does not certify a future reader/writer lifetime.

## Adopted incremental-scale scope

Explicit whole-file gzip and the existing domain-bundles-v1 read/write contracts remain available. Full World/Graph hash, original-byte, Project and authority checks are retained. Changed bytes from one synchronous source observation are consumed by analysis instead of accumulated until the walk ends; ownership validation of reused previous analysis stays intact. There is no new cache/save/pin/approval step or daemon.

File-level relation reuse and two packed-chunk formats were evaluated in separate local frozen trials. Additional validation/copy and full reconstruction/file-check costs increased observed end-to-end latency, so these trials are not adopted into the active product path. The existing domain trial's exact whole codeAnalysisInputBasis reuse is preserved. Full traversal/hash, relationship generation, serialization/verification, snapshot listing and Git namespace checks remain; this patch does not claim an O(change) whole pipeline. No history/original migration, GC or ref deletion occurs.

### Request-local private Git reads

Private Git object reads use a bounded `cat-file --batch` child per selected object group. Exact OID, object type, declared size, raw Git hash, frame terminator and complete EOF are checked. Metadata is validated before it supplies the snapshot body bound; streamed buffers are owned by the decoder. The same operation deadline and cancellation apply, and every child is reaped before return. Isolated cleanup verification consumes the same protocol without reading from the main store as a fallback.

This changes subprocess orchestration only. Full World/Graph and Project checks, exact snapshot addresses, namespace checks and existing publication/cleanup lifetimes remain. There is no daemon, network request, shared authorization or persistent read cache. Explicit whole-gzip storage remains available; fewer children alone do not establish whole-project performance.

## Mixed-backend physical cleanup

Explicit cleanup builds a self-contained replacement pack through bounded stdout streaming. It reserves SHA256 index-v2 space before writing, uses one overall deadline, and verifies every required OID/type/raw hash in isolated scratch with no old-DB or alternate fallback. A new pack is published before its index; old indexes are retired before old packs. A verified identical existing pair is reused and excluded from retirement. Kept or failed snapshot representations remain operational pins for all their domain/object dependencies. A fully referenced history correctly reclaims zero snapshots.

Pack production, indexing and verification use the existing verified native process supervisor for process-tree cleanup. If its capability is unavailable, only physical pack cleanup is deferred; ordinary reads and writes do not gain this requirement. The existing one-shot 4 MiB input boundary is checked before execution, never truncated into a partial successful pack. Cancellation, disk exhaustion, unknown locks, sidecars and partial effects remain visible. No destructive Git prune/repack child runs beside ordinary work. Pure rooted Git reads reacquire only the first chosen OID/store/raw hash for a bounded transient pack-open failure, never a new current target or a permission/digest failure.

The synchronous zero-write inspection skips binary Git/domain internals and reports deferred backend observation; the CLI also returns its existing asynchronous typed retention projection. Neither view is a deletion certificate. An incomplete or crashed unknown staging/pack state is preserved; no age-based ownership stealing or automatic effect replay occurs.

A later explicit cleanup can reinventory an unindexed, correctly named private pack after verifying owner/config, exact physical identity, PACK checksum and snapshot metadata in bounded isolated scratch. Recovery scratch directories are sequential, removed before the next pack or producer, and share the same aggregate disk cap and whole-operation deadline. Pure inspection remains zero-write. Unknown/corrupt/foreign content, or an incomplete retained dependency proof, preserves every remaining candidate. If the full closure is proven but an exact retained object is unavailable to the main producer, only physical packing is deferred. Scratch indexes never repair the main store. Only a fresh, fully verified replacement producer may reuse an unchanged identical unindexed pack and publish its own index last; this is a new explicit collection, not replay of an earlier effect.

Transient participant/attempt ownership and both create-only ref locks bind Project, nonce, host, PID and a fixed Node runtime time origin. The verified attempt owner is passed through the short effect boundary; a different runtime origin cannot perform or clean up that owner’s effect even if the PID matches. This explicitly labelled runtime origin is not an independently queried OS process CreationDate or permission to reclaim unknown/old owners. Ordinary work gains no OS process probe.
