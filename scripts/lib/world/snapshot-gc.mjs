import { inspectPhysicalStorage, summarizeObservedStorageFiles, mergePhysicalStorageObservations } from "./snapshot-storage-accounting.mjs";
import fs from "node:fs";
import path from "node:path";
import { readGraphProject, safeGraphFile } from "./discovery-index.mjs";
import { readSnapshotFile } from "./snapshot-storage-codec.mjs";
import {
  beginSnapshotCollection,
  withSnapshotCollectionUnlink,
  finishSnapshotCollection,
  snapshotCollectionCancelled,
} from "./snapshot-reference-lifetime.mjs";
import { buildSnapshotDeletionClosure, snapshotFileIdentity, sameSnapshotFileIdentity } from "./snapshot-deletion-closure.mjs";
import { qualifySnapshotFileSystem } from "./snapshot-filesystem.mjs";
import { sha256Hex as sha } from "../core/digest.mjs";
import { hydrateSnapshotEntry } from "./snapshot-domain-bundles.mjs";
import {
  ancestryIdsOf,
  namedRecordIds,
  resolveSnapshotRetentionPolicy,
  selectRetainedSnapshotIds,
  snapshotIdsIn,
  SNAPSHOT_RETENTION_RELATIVE,
} from "./snapshot-retention-policy.mjs";

// Dry-run remains zero-write and observational. Explicit apply separately
// verifies the supported typed closure under cooperative publisher lifetimes.
export const SNAPSHOT_GC_UNCOVERED_WRITERS = Object.freeze([]);
const ids = (text) => [...new Set(text.match(/\b(?:world-model|graph-snapshot|source-snapshot)-[a-f0-9]{24}\b/g) || [])];
const MAX_FILES = 50_000,
  MAX_SCAN_BYTES = 1024 * 1024 * 1024;
const snapshotPath = (relative) =>
  /\/(?:world-model|graph-projection)\/snapshots\/((?:world-model|graph-snapshot)-[a-f0-9]{24})\.json(?:\.gz)?$/.exec(relative);
export function inspectSnapshotGarbageCollection({ root = ".", apply = false, retention = null } = {}) {
  if (typeof apply !== "boolean") throw new Error("apply must be a boolean.");
  const owner = readGraphProject(root),
    projectRoot = owner.projectRoot,
    storage = owner.storage;
  if (!owner.project) throw Object.assign(new Error("Project is not initialized."), { code: "NOT_INITIALIZED" });
  const prefix = storage.directory,
    snapshots = [],
    roots = [],
    issues = [],
    scanned = [],
    bytePins = [];
  const physicalRows = [],
    physicalParts = [],
    physicalIssues = [];
  let count = 0,
    bytesRead = 0,
    stopped = false;
  const deferredBackends = [];
  const issue = (relative, reasonCode) => issues.push({ path: relative, reasonCode });
  // Whether the git snapshot store has a ref for this id, read from its ref
  // files without running git (a loose ref or a packed-refs line). Unreadable
  // ref files count as "may hold it": the apply opens the store and decides.
  let packedSnapshotRefs = null;
  const gitStoreNamesSnapshot = (id) => {
    if (!deferredBackends.includes(prefix + "/snapshot-objects.git") || !/^[a-z][a-z0-9-]{0,127}$/.test(id)) return false;
    const gitDirectory = path.join(projectRoot, prefix, "snapshot-objects.git");
    try {
      if (fs.lstatSync(path.join(gitDirectory, "refs", "lode-snapshots", id), { throwIfNoEntry: false })?.isFile()) return true;
      if (packedSnapshotRefs === null) {
        const packed = path.join(gitDirectory, "packed-refs");
        const stat = fs.lstatSync(packed, { throwIfNoEntry: false });
        packedSnapshotRefs = new Set();
        if (stat?.isFile())
          for (const line of fs.readFileSync(packed, "utf8").split("\n")) {
            const match = / refs\/lode-snapshots\/(\S+)$/.exec(line.trim());
            if (match) packedSnapshotRefs.add(match[1]);
          }
      }
      return packedSnapshotRefs.has(id);
    } catch {
      return true;
    }
  };
  function walk(relative) {
    let file, stat;
    try {
      file = safeGraphFile(projectRoot, relative);
      stat = fs.lstatSync(file);
    } catch (error) {
      issue(relative, error.code || "STORAGE_PATH_UNAVAILABLE");
      physicalIssues.push({ path: relative, reasonCode: error.code || "PHYSICAL_ENTRY_UNAVAILABLE" });
      return;
    }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
      issue(relative, "UNSAFE_STORAGE_ENTRY");
      physicalIssues.push({ path: relative, reasonCode: "UNSAFE_PHYSICAL_ENTRY_EXCLUDED" });
      return;
    }
    if (stat.isDirectory()) {
      if (relative === prefix + "/.snapshot-gc") {
        physicalIssues.push({ path: relative, reasonCode: "TRANSIENT_COORDINATION_EXCLUDED" });
        return;
      }
      if (relative === prefix + "/snapshot-objects.git" || relative === prefix + "/snapshot-bundles") {
        deferredBackends.push(relative);
        physicalParts.push(inspectPhysicalStorage({ root: projectRoot, storage, relativePaths: [relative.slice(prefix.length + 1)] }));
        issue(relative, "TYPED_BACKEND_OBSERVATION_REQUIRED");
        return;
      }
      // A live/unknown operation is preservation evidence, never something this
      // diagnostic removes or waits for. No age/PID-based owner reclamation.
      if (relative === prefix + "/.operations" || relative === prefix + "/refresh/writer.lock" || /\/refresh\/writer\.lock\..*\.staging$/.test(relative)) {
        const directory = fs.opendirSync(file);
        try {
          if (directory.readSync()) {
            issue(relative, "ACTIVE_OR_UNKNOWN_WRITER");
            physicalIssues.push({ path: relative, reasonCode: "TRANSIENT_COORDINATION_EXCLUDED" });
          }
        } finally {
          directory.closeSync();
        }
        return;
      }
      for (const name of fs.readdirSync(file).sort()) {
        if (stopped) break;
        walk(relative + "/" + name);
      }
      return;
    }
    if (++count > MAX_FILES || bytesRead + stat.size > MAX_SCAN_BYTES) {
      stopped = true;
      issue(relative, "STORAGE_SCAN_INCOMPLETE");
      return;
    }
    physicalRows.push({ relative: relative.slice(prefix.length + 1), bytes: stat.size });
    if (
      relative === prefix + "/graph-discovery/index.json" ||
      relative === prefix + "/refresh/file-stat-cache.json" ||
      relative === prefix + "/refresh/input-generation.json" ||
      relative === prefix + "/" + SNAPSHOT_RETENTION_RELATIVE ||
      relative.startsWith(prefix + "/refresh/.watch-arm-")
    )
      return; // Rebuildable membership, refresh input cache or a watcher's leftover startup probe: not a historical root.
    if (relative.endsWith(".tmp")) {
      issue(relative, "UNPUBLISHED_OR_UNKNOWN_STAGE");
      return;
    }
    let bytes, document, text;
    try {
      const match = snapshotPath(relative);
      if (match) {
        const read = readSnapshotFile(file);
        bytes = read.bytes;
        document = read.document;
        text = JSON.stringify(document);
        bytesRead += Buffer.byteLength(text);
        if (bytesRead > MAX_SCAN_BYTES) {
          stopped = true;
          issue(relative, "STORAGE_SCAN_INCOMPLETE");
          return;
        }
        if (document.projectId && document.projectId !== owner.project.projectId) issue(relative, "CROSS_PROJECT_SNAPSHOT");
        if ((document.worldModelId || document.graphSnapshotId) !== match[1]) {
          issue(relative, "SNAPSHOT_FILENAME_ID_MISMATCH");
          return;
        }
        let logical = document;
        if (document.kind === "SnapshotComposition") {
          try {
            logical = hydrateSnapshotEntry({ root: owner.projectRoot, storage: owner.storage, entry: { location: file, document } }).document;
          } catch (error) {
            issue(relative, error.code || "TYPED_BACKEND_OBSERVATION_REQUIRED");
          }
        }
        const identityIds = [
          logical.worldModelId,
          logical.graphSnapshotId,
          logical.sourceSnapshotId,
          logical.temporalProvenanceGraph?.graphSnapshotId,
          logical.temporalProvenanceGraph?.sourceSnapshotId,
        ].filter(Boolean);
        snapshots.push({
          id: match[1],
          path: relative,
          bytes: bytes.length,
          sha256: sha(bytes),
          identityIds,
          references: logical === document ? ids(text) : [...snapshotIdsIn(logical)],
          ancestryIds: ancestryIdsOf(logical),
          mtimeMs: stat.mtimeMs,
        });
      } else {
        bytes = fs.readFileSync(file);
        bytesRead += bytes.length;
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (relative.endsWith(".json")) {
          document = JSON.parse(text);
          if (document.projectId && document.projectId !== owner.project.projectId) issue(relative, "CROSS_PROJECT_REFERENCE_ROOT");
          if (document.schemaVersion !== undefined && ![1, 2].includes(document.schemaVersion)) issue(relative, "UNKNOWN_REFERENCE_SCHEMA");
          const pending = [document];
          while (pending.length) {
            const value = pending.pop();
            if (!value || typeof value !== "object") continue;
            if (typeof value.path === "string" && snapshotPath(value.path) && Number.isInteger(value.byteLength) && typeof value.sha256 === "string")
              bytePins.push(value);
            for (const child of Object.values(value)) if (child && typeof child === "object") pending.push(child);
          }
        } else if (!/\.(?:md|txt|gitignore)$/.test(relative) && !relative.endsWith("/.gitignore")) issue(relative, "UNKNOWN_REFERENCE_FILE_TYPE");
        const requiredWorldHashes = [];
        if (document && typeof document === "object") {
          const pendingHashes = [document];
          while (pendingHashes.length) {
            const value = pendingHashes.pop();
            if (!value || typeof value !== "object") continue;
            for (const field of ["repositoryWorldModel", "worldModelHash"])
              if (/^[a-f0-9]{64}$/.test(value[field] || "")) requiredWorldHashes.push(value[field]);
            for (const child of Object.values(value)) if (child && typeof child === "object") pendingHashes.push(child);
          }
        }
        roots.push({
          path: relative,
          relative: relative.slice(prefix.length + 1),
          references: ids(text),
          ancestryIds: document && typeof document === "object" ? ancestryIdsOf(document) : [],
          namedRecordIds: document && typeof document === "object" ? namedRecordIds(document) : [],
          digestReferences: [...new Set(text.match(/[a-f0-9]{64}/g) || [])],
          requiredWorldHashes,
        });
      }
      scanned.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) });
    } catch (error) {
      issue(relative, error.code || "REFERENCE_ROOT_UNREADABLE");
    }
  }
  walk(prefix);
  const physicalIds = new Map();
  for (const item of snapshots) {
    if (physicalIds.has(item.id)) issue(item.path, "SNAPSHOT_REPRESENTATION_CONFLICT");
    physicalIds.set(item.id, item.path);
  }
  const byId = new Map();
  for (const snapshot of snapshots)
    for (const id of snapshot.identityIds) {
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(snapshot);
    }
  const reasons = new Map(),
    queue = roots.flatMap((root) => root.references.map((id) => ({ id, reason: "retained-reference:" + root.path })));
  const pinnedFiles = new Map(scanned.map((item) => [item.path, item]));
  for (const pin of bytePins) {
    const actual = pinnedFiles.get(pin.path);
    if (!actual || actual.bytes !== pin.byteLength || actual.sha256 !== pin.sha256) issue(pin.path, "HISTORICAL_BYTE_REFERENCE_UNAVAILABLE");
    else queue.push({ id: snapshotPath(pin.path)[1], reason: "exact-historical-byte-reference:" + pin.path });
  }
  for (let i = 0; i < queue.length; i++) {
    const { id, reason } = queue[i],
      matches = byId.get(id) || [];
    if (!matches.length) {
      // A dry run does not open snapshot-objects.git or snapshot-bundles. A
      // whole World or Graph snapshot is either a file here or a ref of the git
      // store (a bundle is only a part a whole snapshot names), so such an id
      // that is neither is reported as missing. Another id (a source snapshot
      // inside a graph) may sit inside an unopened backend's content.
      const wholeSnapshot = /^(?:world-model|graph-snapshot)-[a-f0-9]{24}$/.test(id);
      if (wholeSnapshot ? !gitStoreNamesSnapshot(id) : !deferredBackends.length) issue(id, "RETAINED_SNAPSHOT_REFERENCE_UNAVAILABLE");
      continue;
    }
    for (const snapshot of matches) {
      if (reasons.has(snapshot.path)) continue;
      reasons.set(snapshot.path, reason);
      for (const dependency of snapshot.references) queue.push({ id: dependency, reason: "dependency-of:" + snapshot.id });
    }
  }
  const observedUnreferenced = snapshots.filter((item) => !reasons.has(item.path));
  const typedBackendDeferred = deferredBackends.length > 0 && issues.every((item) => item.reasonCode === "TYPED_BACKEND_OBSERVATION_REQUIRED");
  const nextAction = typedBackendDeferred
    ? "Dry-run did not open snapshot-objects.git or snapshot-bundles, so it cannot certify deletions from those backends. Run storage-gc --apply. That reads them. gc_applied with applyPerformed false means the typed closure kept every referenced snapshot."
    : null;
  const retentionPolicy = resolveSnapshotRetentionPolicy({ root: owner.projectRoot, storage: owner.storage, override: retention });
  const decision = selectRetainedSnapshotIds({ snapshots, roots, policy: retentionPolicy });
  const kept = (item) =>
    decision.preserveAllHistory ? reasons.has(item.path) : decision.keepIds.has(item.id) || (item.identityIds || []).some((id) => decision.keepIds.has(id));
  // D5: when the dry run already knows apply would refuse (issues other than
  // the unopened typed backends), it names nothing as reclaimable.
  const applyWouldRefuse = issues.length > 0 && !typedBackendDeferred;
  const rows = snapshots.map((item) => {
    const keep = kept(item) || applyWouldRefuse;
    return {
      id: item.id,
      path: item.path,
      bytes: item.bytes,
      sha256: item.sha256,
      observedReference: reasons.get(item.path) || null,
      disposition: keep ? "retain" : "reclaim",
      reasonCode: keep
        ? "RETAINED_REFERENCE_CLOSURE"
        : reasons.has(item.path)
          ? "RETENTION_POLICY_EXPIRED"
          : issues.length
            ? "INCOMPLETE_REFERENCE_COVERAGE"
            : "APPLY_REQUIRES_TYPED_CLOSURE_AND_LIFETIME",
    };
  });
  if (applyWouldRefuse) for (const row of rows) if (!kept(snapshots.find((item) => item.path === row.path))) row.reasonCode = "INCOMPLETE_REFERENCE_COVERAGE";
  const reclaimable = rows.filter((item) => item.disposition === "reclaim");
  return {
    kind: "SnapshotStorageInspection",
    authorityPlane: "P4",
    persisted: false,
    projectId: owner.project.projectId,
    status: apply ? "gc_apply_unavailable_preserved" : "gc_dry_run",
    requestedApply: apply,
    ...(apply && !typedBackendDeferred ? { code: "SNAPSHOT_GC_APPLY_UNAVAILABLE" } : {}),
    applyAvailable: issues.length === 0 || typedBackendDeferred,
    ...(nextAction ? { nextAction } : {}),
    applyPerformed: false,
    deletedCount: 0,
    reclaimedBytes: 0,
    reclaimableBytes: reclaimable.reduce((n, item) => n + item.bytes, 0),
    retention: {
      keepCount: retentionPolicy.keepCount,
      keepDays: retentionPolicy.keepDays,
      source: retentionPolicy.source,
      preserveAllHistory: retentionPolicy.preserveAllHistory,
      reclaimableSnapshots: reclaimable.length,
      policy: retentionPolicy.preserveAllHistory
        ? retentionPolicy.source === "not-configured"
          ? "no retention window configured; every retained reference and its ancestry stays"
          : "retention config is not usable; historical snapshots stay"
        : `keep the current pointers and what they name, snapshots pinned by decisions and records, snapshots without a trustworthy time, and the newest ${retentionPolicy.keepCount} Worlds by write time or those written in the last ${retentionPolicy.keepDays} days`,
    },
    physicalStorage: mergePhysicalStorageObservations([
      summarizeObservedStorageFiles(physicalRows, { complete: !stopped && !physicalIssues.length, issues: physicalIssues }),
      ...physicalParts,
    ]),
    storedBytesScope: "whole-or-composition-snapshot-files-only",
    snapshotCount: rows.length,
    storedBytes: rows.reduce((n, item) => n + item.bytes, 0),
    retainedCount: rows.length - reclaimable.length,
    observedUnreferencedCount: observedUnreferenced.length,
    observedUnreferencedBytes: observedUnreferenced.reduce((n, item) => n + item.bytes, 0),
    interpretation:
      "Dry-run names snapshot files explicit --apply would delete. Current worlds, decision and record pins, and the configured recent window stay. Source texts, Canon, and Session records are not snapshot files and are not deleted. This inspection does not delete.",
    basis: { digest: sha(JSON.stringify(scanned)), readConsistency: "observed-sequence-not-atomic-filesystem-snapshot", scannedFiles: count, bytesRead },
    backendInspection: { mode: "synchronous-file-observation", deferredBackends, authority: "no-deletion-certificate" },
    coverage: {
      scanComplete: !stopped && issues.length === 0,
      referenceValidity: "not-certified-by-string-scan",
      schemaCoverage: "typed-validity-not-asserted-for-root-documents",
      writerCoverage: "not-certified-by-zero-write-inspection",
      issues: issues.slice(0, 200),
      omittedIssues: Math.max(0, issues.length - 200),
    },
    snapshots: rows.slice(0, 200),
    omittedSnapshots: Math.max(0, rows.length - 200),
    uncoveredWriters: SNAPSHOT_GC_UNCOVERED_WRITERS,
    ordinaryWorkBlocked: false,
    instructionAuthority: false,
    recoveryAuthority: false,
    executionAuthority: false,
  };
}

// Explicit asynchronous effect, separate from the unchanged zero-write
// inspection. A diagnostic string scan is never its deletion certificate.
export async function applySnapshotGarbageCollection({ root = ".", signal, onProcess, retention = null } = {}) {
  // Inventory and reclaim are not one deadline. A single clock made a large
  // store abort before any unreachable byte was deleted. Each plain Git
  // command keeps its own bound; the supervised pack step has no clock of its
  // own and stops on cancellation. Admission covers one unlink, not the walk.
  const owner = readGraphProject(root);
  const result = {
    kind: "SnapshotStorageInspection",
    authorityPlane: "P4",
    persisted: false,
    projectId: owner.project?.projectId,
    requestedApply: true,
    status: "gc_preserved",
    applyAvailable: false,
    applyPerformed: false,
    deletedCount: 0,
    reclaimedBytes: 0,
    deleted: [],
    failed: [],
    preserved: [],
    deferred: [],
    retiredRefs: [],
    retiredRefCount: 0,
    deletedDomainBundles: 0,
    deletedObjectFiles: 0,
    deletedSourceBundles: 0,
    writtenPackBytes: 0,
    publishedPackBytes: 0,
    ordinaryWorkBlocked: false,
    instructionAuthority: false,
    recoveryAuthority: false,
    executionAuthority: false,
    support: "cooperating-current-local-entrypoints; not universal old/raw/shared-host exclusion",
    physicalScope: "verified orphan whole World/Graph files, private loose Git refs/objects and domain fragments; source/canonical originals retained",
  };
  if (signal?.aborted) return { ...result, code: "SNAPSHOT_GC_CANCELLED" };
  try {
    const { inspectStorageReaderCompatibility } = await import("./snapshot-storage-compatibility.mjs");
    const { verifyWorldModelPointerOriginal } = await import("./world-model.mjs");
    const { verifyGraphProjectionPointer } = await import("./graph-projection-adapter.mjs");
    const compatibility = inspectStorageReaderCompatibility({
      root: owner.projectRoot,
      storage: owner.storage,
      verifyWorldPointer: (pointer) => verifyWorldModelPointerOriginal(pointer, owner.project.projectId),
      verifyGraphPointer: (pointer) => verifyGraphProjectionPointer(pointer, null, owner.storage),
    });
    const mismatch = compatibility.layers.find((layer) => ["STORAGE_VERSION_MISMATCH", "INVALID_READER_REQUIREMENTS"].includes(layer.reasonCode));
    if (mismatch)
      return {
        ...result,
        code: mismatch.reasonCode,
        message: mismatch.message || mismatch.reasonCode,
        requiredVersion: mismatch.requiredVersion || null,
        installedVersion: mismatch.installedVersion || null,
      };
    // A pointer written before minimumReader existed is read as it is. GC does
    // not rewrite it: that write belongs under the writer lease, which the next
    // refresh holds when it records the missing fields.
  } catch (error) {
    if (error.code === "STORAGE_VERSION_MISMATCH") return { ...result, code: error.code, message: error.message };
  }
  const attempt = beginSnapshotCollection({ root, storage: owner.storage });
  if (attempt.status !== "active") return { ...result, status: attempt.status === "yielded" ? "gc_yielded" : "gc_preserved", code: attempt.reasonCode };
  let closure;
  try {
    result.filesystem = await qualifySnapshotFileSystem({ root: owner.projectRoot, signal, onProcess, deadline: Date.now() + 3_000 });
    if (result.filesystem.status !== "qualified-local") {
      result.code = signal?.aborted ? "SNAPSHOT_GC_CANCELLED" : result.filesystem.reasonCode;
      return result;
    }
    closure = await buildSnapshotDeletionClosure({
      root,
      signal,
      onProcess,
      deadline: null,
      collectionAttempt: attempt,
      shouldContinue: () => !signal?.aborted && !snapshotCollectionCancelled(attempt),
      retention,
    });
    result.coverage = {
      referenceValidity: closure.certified ? "typed-supported-root-closure" : "incomplete-preserved",
      backend: closure.backend,
      decodedInputBytes: closure.decodedBytes,
      retainedSummaryBytes: closure.summaryBytes,
      maxSummaryBytes: closure.maxSummaryBytes,
      issues: closure.issues.slice(0, 200),
      omittedIssues: closure.omittedIssues || 0,
    };
    if (closure.productGraphKept?.length) result.productGraphKept = closure.productGraphKept;
    result.basis = { digest: closure.basisDigest, readConsistency: "cooperative-lifetime-and-exact-file-identity" };
    result.snapshotCount = closure.snapshots.length;
    result.physicalStorage = summarizeObservedStorageFiles(
      [...closure.entries, ...closure.mixed.files.values()].map((row) => ({ relative: row.path.slice(owner.storage.directory.length + 1), bytes: row.bytes })),
      { complete: false, scope: "typed-closure-inventoried-files-before-cleanup", issues: [{ reasonCode: "COORDINATION_AND_NONINVENTORIED_FILES_EXCLUDED" }] },
    );
    result.storedBytesScope = "snapshot-files-plus-typed-backend-inventory-before-cleanup";
    result.storedBytes = closure.snapshots.reduce((sum, item) => sum + item.bytes, 0) + closure.mixed.storedBytes;
    if (!closure.certified) {
      result.code = signal?.aborted
        ? "SNAPSHOT_GC_CANCELLED"
        : closure.interrupted || snapshotCollectionCancelled(attempt)
          ? "SNAPSHOT_COLLECTION_INVALIDATED"
          : "SNAPSHOT_GC_REFERENCE_COVERAGE_INCOMPLETE";
      if (result.code === "SNAPSHOT_COLLECTION_INVALIDATED") result.status = "gc_yielded";
      return result;
    }
    withSnapshotCollectionUnlink(attempt, () => {});
    result.applyAvailable = true;
    for (const candidate of closure.candidates) {
      if (signal?.aborted) {
        result.code = "SNAPSHOT_GC_CANCELLED";
        break;
      }
      try {
        if (candidate.backend === "git") {
          if (!closure.mixed.physicalEligible) {
            result.deferred.push({ path: candidate.path, code: "UNSUPPORTED_GC_PACKED_REFS" });
            continue;
          }
          const refFile = closure.mixed.retireRef(candidate, attempt);
          result.retiredRefs.push({ id: candidate.id, path: candidate.path, ref: candidate.ref, oid: candidate.oid });
          result.retiredRefCount++;
          closure.mixed.recordDelete(result, refFile, "git-ref");
          await new Promise((resolve) => setImmediate(resolve));
          continue;
        }
        // Expensive inventory/typed/hash work has completed outside admission.
        // Under cooperation a new publication permanently invalidates this
        // attempt, even if that operation has already finished (ABA).
        withSnapshotCollectionUnlink(attempt, () => {
          const safe = safeGraphFile(owner.projectRoot, candidate.path);
          const stat = fs.lstatSync(safe, { bigint: true });
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !sameSnapshotFileIdentity(candidate.identity, snapshotFileIdentity(stat))) {
            throw Object.assign(new Error("Snapshot file identity changed."), { code: "SNAPSHOT_GC_CANDIDATE_DRIFT" });
          }
          fs.unlinkSync(safe);
        });
        result.deleted.push({ id: candidate.id, path: candidate.path, bytes: candidate.bytes, sha256: candidate.sha256 });
        result.deletedCount += 1;
        result.reclaimedBytes += candidate.bytes;
        result.applyPerformed = true;
        await new Promise((resolve) => setImmediate(resolve));
      } catch (error) {
        result.code = error.code || "SNAPSHOT_GC_DELETE_FAILED";
        result.failed.push({ path: candidate.path, code: result.code });
        break;
      }
    }
    if (!result.code) {
      const removed = new Set([...result.deleted.map((item) => item.path), ...result.retiredRefs.map((item) => item.path)]);
      await closure.mixed.reclaim({
        attempt,
        result,
        remainingSnapshots: closure.snapshots.filter((row) => !removed.has(row.path)),
        pinnedOids: closure.pinnedOids,
        pinnedPaths: closure.pinnedPaths,
      });
    }
    const retentionPolicy = closure.retentionPolicy || { keepCount: null, keepDays: null, source: "unresolved", preserveAllHistory: true };
    result.retention = {
      keepCount: retentionPolicy.keepCount,
      keepDays: retentionPolicy.keepDays,
      source: retentionPolicy.source,
      preserveAllHistory: retentionPolicy.preserveAllHistory,
      referencedSnapshots: closure.retained.size,
      eligibleOrphanSnapshots: closure.candidates.length,
      policy: retentionPolicy.preserveAllHistory
        ? retentionPolicy.source === "not-configured"
          ? "no retention window configured; every retained reference and its ancestry stays; zero reclaimed bytes can be a complete successful result"
          : "retention config is not usable; historical snapshots stay; zero reclaimed bytes can be a complete successful result"
        : `keep the current pointers and what they name, snapshots pinned by decisions and records, snapshots without a trustworthy time, and the newest ${retentionPolicy.keepCount} Worlds by write time or those written in the last ${retentionPolicy.keepDays} days; older unpinned history is eligible; zero reclaimed bytes can be a complete successful result`,
    };
    result.status = result.code
      ? result.applyPerformed
        ? "gc_partial"
        : "gc_preserved"
      : result.deferred.length
        ? result.applyPerformed
          ? "gc_partial"
          : "gc_preserved"
        : "gc_applied";
    if (result.status === "gc_applied" && !result.applyPerformed)
      result.nextAction =
        "Typed closure certified the retained snapshots. Nothing unreachable was deleted. A dry run that names TYPED_BACKEND_OBSERVATION_REQUIRED has not opened snapshot-objects.git or snapshot-bundles; this apply did.";
    return result;
  } catch (error) {
    result.code = error.code || "SNAPSHOT_GC_FAILED";
    if (error.nativeProcessCleanup) result.nativeProcessCleanup = error.nativeProcessCleanup;
    if (error.snapshotStagingCleanup) result.cleanup = { status: "owner-preserved", ...error.snapshotStagingCleanup };
    result.status = result.applyPerformed ? "gc_partial" : "gc_preserved";
    return result;
  } finally {
    if (closure) {
      const deleted = new Set([...result.deleted.map((item) => item.path), ...result.retiredRefs.map((item) => item.path)]);
      result.preserved = closure.snapshots
        .filter((item) => !deleted.has(item.path))
        .map((item) => ({
          id: item.id,
          path: item.path,
          reasonCode: closure.retained.has(item.path) ? "RETAINED_REFERENCE_CLOSURE" : result.code || "PRESERVED",
        }));
      result.retainedCount = result.preserved.length;
    }
    result.actualUnlinkedBytes = result.reclaimedBytes;
    result.netStorageBytes = result.reclaimedBytes - result.publishedPackBytes;
    try {
      finishSnapshotCollection(attempt);
    } catch (error) {
      result.cleanup = { status: "owner-preserved", code: error.code || "SNAPSHOT_GC_CLEANUP_FAILED" };
      result.code ??= result.cleanup.code;
      result.status = result.deletedCount ? "gc_partial" : "gc_preserved";
    }
  }
}
