# Snapshot storage and preservation

New local World/Graph snapshots use compact JSON compressed as `.json.gz`. Existing `.json` files keep their original paths and bytes and are reused by ID. Installation, resume and reads do not migrate them.

New complete local writes under a verified selected Project owner use `chunked-code-v3`. The gzip root uses physical schema 3 / producer 0.3.0 and references immutable code indexes and leaves. Five original arrays are distributed across 64 stable exact-path buckets; each physical World leaf groups its three array families, and each Graph leaf groups its two. The World and Graph share exact Graph leaves. Indexes restore every original occurrence in its original order, including duplicates and unknown row fields. There is no replay chain through previous snapshots.

This choice prioritizes retained storage over latency. In a paired synthetic case with 48 files and 16 functions per file, one-line refresh stored 410,222 versus 99,716 new bytes (75.7% less), while first generation was about 28% slower. A four-file case used about 28% more bytes on first generation, took 22% longer initially and 23% longer for code refresh. These warm-cache local measurements are not universal speed, Host/model or total-I/O claims. Full reconstruction, original verification and metadata still scale with the graph.

Existing `shared-domains-v2` roots keep physical schema 2 / producer 0.2.0 and whole code parts. They remain readable and selectable through the existing programmatic adapter options, as do whole JSON/gzip, Git and domain-v1. These are not additional public CLI/MCP options. A repeated unchanged ID reuses its exact original representation; installation, resume, reads and repeated indexing never convert it in place. Only a genuinely new snapshot can use the new default.

Pure lower adapters without a selected Project owner retain whole-document
storage. They do not require initialization to keep their existing contract.
Explicit composition choices still require and fully validate the owner.

Physical schema 3 needs a reader supporting `chunked-code-v3`, introduced with beta.75. Beta.74 and earlier cannot read these new roots. Beta.69 and earlier also reject schema-2 roots with `INVALID_SNAPSHOT_COMPOSITION`. Update each client sharing the Project before writing new snapshots. This is format compatibility guidance, not a new setup or approval gate. New readers retain old original paths and bytes and never substitute current data for missing historical evidence. Physical layout adds no fields to semantic World payloads.

Readers retain the full part/address/Project/type/producer/digest and reconstructed
World/Graph verification. Parts are dependencies of the existing retention and
deletion closures and publisher/reader lifetimes. A missing, corrupt or denied
part fails the dependent read; current data never substitutes for it. Existing
Graph-first/World pointer publication can still report a partial failure: this
layout does not create a two-pointer atomic transaction or roll back committed work.



## Reader compatibility in status

New World/Graph pointer publications record advisory `readerRequirements` from the actual verified stored representation, alongside its exact snapshot ID. The Graph pointer includes the declaration in its existing pointer digest; the World pointer keeps its existing snapshot ID/hash checks. The advisory declaration is not an independent World integrity proof. Status reads only bounded local pointers and separates Core readiness from each projection's declared physical layout/schema/producer support. It does not hydrate the World or certify snapshot integrity, freshness or semantic sufficiency. Existing pointers without requirements display `not-inspected`; they are not silently called compatible. Unsupported or unavailable layers carry specific reasons in CLI and typed MCP output, while ordinary Core work continues. No new setup, refresh or approval step is required.

Actual reads keep full verification. A newer or older composition schema or producer is `STORAGE_VERSION_MISMATCH` and names this Lode version and the schemas it reads. The message is a version mismatch, not data corruption. Refresh and storage GC stop before any delete or rewrite in that state. Missing, corrupt, identity/digest and permission failures remain errors. This cannot change behavior in an already deployed older reader. Storage-format notices and loaded/configured package mismatch describe different facts.

## Storage choices at a glance

| Choice | Use |
| --- | --- |
| `chunked-code-v3` with gzip | Default complete new writes with a verified selected owner; less retained code duplication, with disclosed latency costs. |
| `shared-domains-v2` with gzip | Explicit whole-code-part layout and retained schema-2 history. |
| Whole JSON/gzip | Retained historical files and lower adapters without a selected owner. |
| Private Git | Explicit selection, with the same original verification. |
| Domain-v1 or zstd | Existing programmatic adapter options, with disclosed runtime support; no public CLI/MCP selector. |
| GC inspection | Read-only; ordinary startup never requires cleanup. |
| Explicit GC application | Deletes only supported, verified unreferenced storage under the existing safety contract. |

## Encoding and historical reads

The existing adapters list/read both formats and return the actual physical location. Encoding does not change semantic IDs, hashes, parent provenance or authority. Explicit `snapshotEncoding: "json"` uses compact uncompressed JSON for new writes.

New files use atomic no-clobber publication. Invalid, truncated or conflicting representations fail; readers never substitute another snapshot to hide corruption. A failed single-file publication leaves that file’s prior pointer intact; Graph and World pointers are still separate publications and can report partial success. Existing source fallback remains available.

Compressed input is bounded at 256 MiB and decoded JSON at 512 MiB to bound decompression allocation. These storage limits do not change Context token tiers, child stdout or MCP limits. Existing raw JSON keeps its prior caller-specific bounds. Original typed readers still verify decoded identity, digest and structure.

Historical boundary references bind exact physical path, byte length and raw SHA. Both suffixes are accepted for World references, but equivalent decoded content cannot replace a byte-pinned original. Existing boundary byte limits remain unchanged.

Compression saves disk bytes and adds computation. It does not prove faster parsing, verification or queries. Measure the same Project/identities/query and report read, decompression, parse and typed verification separately. A first query after fixture preparation is not OS-cache-cold.

## Storage inspection and explicit cleanup

```powershell
lode-agent storage-gc C:\path\to\project
lode-agent storage-gc C:\path\to\project --json
lode-agent storage-gc C:\path\to\project --apply --json
```

`storedBytes` retains its legacy snapshot-file scope. The separate `physicalStorage` view reports per-backend and total observed regular-file lengths, including domain bundles, private Git, source bundles and other Project files. It discloses excluded unsafe/transient entries and bounded partial coverage; it is neither allocated disk usage nor safely reclaimable space. Apply reports the typed inventory scope before cleanup without a second filesystem scan. These diagnostic totals never select deletion candidates.

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

Initialization and explicit resume create the selected `.lode/.gitignore` or retained `.head/.gitignore` when absent. They upgrade an older generated file only when its entire contents match the known generated body, using LF or CRLF. Additional comments, reordered rules and user edits stay untouched. This is not marker-based ownership. Linked or changing files are preserved; before publication the helper rechecks the observed policy bytes. It does not provide a filesystem compare-and-swap against uncooperating external editors.

Each exact file rule is checked separately against root exceptions. Directory rules such as `/snapshot-bundles/` and `/world-model/snapshots/` are still written when the root `.gitignore` has an unanchored exception such as `!.gitkeep`, `!docs/`, or `!snapshots`, including `!.lode/**`. Git does not re-include a child of a directory excluded by `.lode/.gitignore`, so omitting those rules is what exposes the snapshots. An exact-file exception can still skip only that file rule. Results name included and skipped rules. Optional ignore failure never blocks readiness or ordinary work. The user's root `.gitignore` is not modified.

| Relative pattern inside storage | Why disposable |
| --- | --- |
| `/graph-discovery/index.json` | Rebuilt from verified original records. |
| `/.snapshot-gc/` | Transient local snapshot participants and GC attempts. |
| `/.operations/` | Transient process-owned scoped locks. |
| `/messaging/` | Live same-project conversation mailbox, not canon or recovery state. |
| `/refresh/writer.lock/` | Host-local active refresh lease. |
| `/refresh/writer.lock.*.staging/` | Unpublished refresh lease staging. |

A separate retained-history block excludes new accidental tracking only for `/world-model/snapshots/`, `/graph-projection/snapshots/`, `/snapshot-bundles/` and `/snapshot-objects.git/`. These originals have retention and recovery value; they are not disposable cache. Canon, Session records, Capsules, pointers, historical boundaries, installation manifests and user-edited documents are outside this list. The helper never runs Git, stages/untracks files or changes global configuration. Ignore rules reclaim no disk space.

## Explicit local Git snapshot candidate

Gzip remains the default for new ordinary snapshots. Only the internal local World/Graph adapter option `snapshotEncoding: "git"` selects new-only storage in the Project-managed `snapshot-objects.git`. It does not alter the product repository's Git settings, index, branches, hooks or remotes. Existing JSON/gzip originals are neither migrated nor re-encoded. Default consumers can read all three representations and retain exact identity, Project and content-hash verification.

A Git original has no physical JSON path. Where a location is already part of the public result, World/Graph return `file: null` or `snapshotLocation: null` with a small `snapshotStorage` descriptor: store ID, object format/ID, encoding, raw byte length and SHA-256. Current-pointer and refresh-receipt paths remain real JSON files. The bounded World MCP status has no location field and gains no locator.

World, freshness, Compiler, lineage, Explorer and dependent workflows await storage I/O completion. Factories, hashes, verifiers and diff computation remain synchronous. CLI and typed MCP consume the same completed values and errors. Discovery does not collect new snapshots or select a configured external adapter; legacy historical inventory 0.1 file pins are unchanged.

Each private Git operation shares a deadline and cancellation signal; children are hidden, shell-free and reaped before completion. No filter, textconv or lazy fetch runs. Immutable refs are create-only; concurrent writes converge only for the exact same original. Project/store/raw/object mismatches, linked paths, external alternates and unapproved private configuration fail the affected operation. Ordinary reads and writes do not delete refs, run GC or pack automatically. The separate explicit cleanup above can reclaim verified orphan storage; no source-specific Git writer is introduced. Physical managed-store changes are excluded from code-source freshness; actual source, Canon and P3 changes remain observable.

Default adoption requires measured costs and independent review. A smaller active pack is not proof of lower total disk use when loose originals are retained, or of faster reads.

## Local domain-bundle trial (explicit; not a new default)

The internal local adapters still accept `snapshotLayout: "domain-bundles-v1"` explicitly. Ordinary complete new snapshots use v3 above; `snapshotLayout: "whole"` preserves whole-file writes. Existing IDs, JSON/gzip files, Git objects and historical byte pins are not rewritten. This older trial adds no user pin/save/approval step.

The trial emits Graph protocol 0.16 alongside the unchanged 0.15 producer. A relation has a stable `logicalRelationId`, an evidence-sensitive `contentRevisionId`/`edgeId`, and its exact `sourceSnapshotId` observation. Logical identity includes Project, endpoint logical identities and continuity generation/unknown state, type, origin, authority and producer. Content revisions also bind concrete endpoints, evidence, freshness and confidence. Edges targeting a SourceSnapshot bind that exact endpoint. Deletion/recreation, another Session, changed evidence or confidence cannot silently become the same observation or revision. Existing graph protocols retain their original verification and IDs.

In the older v1 trial, a compact composition references at most three immutable domain bundles: World code facts/semantic analysis, normalized code graph records, and the remaining graph composition. Repository-wide evidence, Product/decision relations and snapshot membership remain in the changing composition. Unchanged code bundles can be reused across decision-only changes; graph-node/edge observation membership is restored during exact reconstruction. Bundles are not one file per node. Optional native `bundleEncoding: "zstd"` is a local trial; absent runtime support is reported and never triggers installation.

The writer reuses semantic analysis only from a previously verified World with the same complete analysis input basis: Project, all scanner facts, source scope/rules, producer versions, source-relation input and managed-file exclusions. Canon/projection relations and continuity are still rebuilt. The result reports whether this analysis was reused; matching mtime/size or source bytes alone is insufficient.

Readers verify composition and bundle Project/type/schema/producer, exact managed address, SHA-256 and decoded length; depth, count and total reconstruction are bounded by the existing 512 MiB storage limit. Verification reuse is request-local and bound to immutable addresses. Missing or corrupt chunks are errors for the dependent read; they are never replaced with current source. The reconstructed World/Graph still passes the original typed/semantic verification. File/Git locators describe physical representation; the composition separately binds reconstructed content. This is not authority or a P2 recovery direction.

The same trial can use explicit Git roots plus gzip domain files. This is a hybrid, not a claim that all chunks are Git objects. No automatic pack, cleanup, ref deletion or remote access runs on ordinary reads or approval. A missing Git executable has `SNAPSHOT_GIT_EXECUTABLE_UNAVAILABLE`; existing file-backed reads remain available. A non-Git product folder does not prevent the private candidate store.

### Typed preservation observation

Structured `storage-gc` inspection now includes `typedClosure` over actual verified Capsules, ChangeSets and execution-lineage artifacts, then exact World, Graph, domain dependencies and retained source bundles. Semantic path/digest references are distinct from physical byte pins. Unknown roots, missing dependencies and intermediate publication are retained and disclosed. A World file record alone does not retain the original source bytes.

This projection is an observed read sequence, not a deletion certificate. Explicit apply uses the separate typed deletion closure and transient publisher lifetimes described above. This observation alone never authorizes deletion; Git refs and original bundles remain retained. Do not use a successful inspection to claim cleanup is safe.

The private Git store creates an ignore file inside its own newly owned store/staging area. A parent exception such as `!.gitkeep` does not suppress that file, because the nested `*` exclusion is what keeps the objects out of the user's index. It preserves existing ignore files and tracking; it neither stages nor untracks anything. These retained objects have recovery value and are not disposable cache.

An exact source-bundle pin uses the raw digest of the same buffer parsed by the existing bundleKey/Project/schema/observation verifier. Observed physical bytes must match that digest; a mismatch remains retained, unverified and partial. Repeated before/after path reads alone do not prove this binding or prevent ABA substitution. This still does not certify a future reader/writer lifetime.

## Adopted incremental-scale scope

Explicit whole-file gzip and the existing domain-bundles-v1 read/write contracts remain available. Full World/Graph hash, original-byte, Project and authority checks are retained. Changed bytes from one synchronous source observation are consumed by analysis instead of accumulated until the walk ends; ownership validation of reused previous analysis stays intact. There is no new cache/save/pin/approval step or daemon.

Earlier file-level relation reuse and two different packed-chunk formats were evaluated in separate local frozen trials, before the coalesced v3 implementation described above. Additional validation/copy and full reconstruction/file-check costs increased observed end-to-end latency, so those earlier trials were not adopted into the active product path. That historical result does not describe the current coalesced v3 default. The existing domain trial's exact whole codeAnalysisInputBasis reuse is preserved. Full traversal/hash, relationship generation, serialization/verification, snapshot listing and Git namespace checks remain; this patch does not claim an O(change) whole pipeline. No history/original migration, GC or ref deletion occurs.

### Request-local private Git reads

Private Git object reads use a bounded `cat-file --batch` child per selected object group. Exact OID, object type, declared size, raw Git hash, frame terminator and complete EOF are checked. Metadata is validated before it supplies the snapshot body bound; streamed buffers are owned by the decoder. The same operation deadline and cancellation apply, and every child is reaped before return. Isolated cleanup verification consumes the same protocol without reading from the main store as a fallback.

This changes subprocess orchestration only. Full World/Graph and Project checks, exact snapshot addresses, namespace checks and existing publication/cleanup lifetimes remain. There is no daemon, network request, shared authorization or persistent read cache. Explicit whole-gzip storage remains available; fewer children alone do not establish whole-project performance.

## Mixed-backend physical cleanup

Explicit cleanup builds a self-contained replacement pack through bounded stdout streaming. It reserves SHA256 index-v2 space before writing, uses one overall deadline, and verifies every required OID/type/raw hash in isolated scratch with no old-DB or alternate fallback. A new pack is published before its index; old indexes are retired before old packs. A verified identical existing pair is reused and excluded from retirement. Kept or failed snapshot representations remain operational pins for all their domain/object dependencies. A fully referenced history correctly reclaims zero snapshots.

Pack production, indexing and verification use the existing verified native process supervisor for process-tree cleanup. If its capability is unavailable, only physical pack cleanup is deferred; ordinary reads and writes do not gain this requirement. The existing one-shot 4 MiB input boundary is checked before execution, never truncated into a partial successful pack. Cancellation, disk exhaustion, unknown locks, sidecars and partial effects remain visible. No destructive Git prune/repack child runs beside ordinary work. Pure rooted Git reads reacquire only the first chosen OID/store/raw hash for a bounded transient pack-open failure, never a new current target or a permission/digest failure.

The synchronous zero-write inspection skips binary Git/domain internals and reports deferred backend observation; the CLI also returns its existing asynchronous typed retention projection. Neither view is a deletion certificate. An incomplete or crashed unknown staging/pack state is preserved; no age-based ownership stealing or automatic effect replay occurs.

A later explicit cleanup can reinventory an unindexed, correctly named private pack after verifying owner/config, exact physical identity, PACK checksum and snapshot metadata in bounded isolated scratch. Recovery scratch directories are sequential, removed before the next pack or producer, and share the same aggregate disk cap and whole-operation deadline. Pure inspection remains zero-write. Unknown/corrupt/foreign content, or an incomplete retained dependency proof, preserves every remaining candidate. If the full closure is proven but an exact retained object is unavailable to the main producer, only physical packing is deferred. Scratch indexes never repair the main store. Only a fresh, fully verified replacement producer may reuse an unchanged identical unindexed pack and publish its own index last; this is a new explicit collection, not replay of an earlier effect.

Transient participant/attempt ownership and both create-only ref locks bind Project, nonce, host, PID and a fixed Node runtime time origin. The verified attempt owner is passed through the short effect boundary; a different runtime origin cannot perform or clean up that owner’s effect even if the PID matches. This explicitly labelled runtime origin is not an independently queried OS process CreationDate or permission to reclaim unknown/old owners. Ordinary work gains no OS process probe.

GC cancellation asks the native supervisor to stop once and waits for its cleanup proof within the operation’s original absolute deadline. Only reaching that deadline forces termination; it does not extend the deadline or infer successful cleanup. A stuck supervisor can use the remaining operation deadline (up to the existing default 30 seconds). Byte-cap and original errors remain failures, including when cleanup cannot be verified.

## Chunked code format and verification

The v3 index owns unique bucket descriptors with exact per-family counts and per-list order. Leaves have a strict group/bucket/family shape; another family cannot fill a missing one. Indexes and leaves keep the existing domain envelope schema 1 / producer 0.1.0. At most 128 leaves and two indexes are needed; the request verification allowance is 512 distinct parts, depth three and the existing aggregate decoded-byte bound. Older v1/v2 keep their original eight-part allowance. These are storage-format bounds, not Context budgets or semantic gates.

Every descriptor checks its Project, domain, managed address, encoding, declared bytes and digest. Conflicting descriptors for one address fail. Root and bundle descriptor reads allocate only the observed size and inspect at most one extra sentinel byte, retaining before/after identity checks. Reconstructed whole bytes must still match length/SHA and the original World/Graph verifiers.

Typed GC validates index-to-leaf dependencies with the same per-family grammar and retains only bounded descriptor/count summaries. Current/previous/history roots, exact index/leaf byte pins and remaining roots after failed unlink retain their transitive parts. Unknown, missing, corrupt or foreign parts prevent uncertified deletion. GC remains explicit with its original cancellation and whole-operation deadline; no background migration or cleanup is added.
