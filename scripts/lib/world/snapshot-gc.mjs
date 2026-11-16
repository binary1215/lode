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
import {
  buildSnapshotDeletionClosure,
  classifyGcStorePath,
  observeSnapshotRetentionClosure,
  snapshotFileIdentity,
  sameSnapshotFileIdentity,
} from "./snapshot-deletion-closure.mjs";
import { qualifySnapshotFileSystem } from "./snapshot-filesystem.mjs";
import { sha256Hex as sha } from "../core/digest.mjs";
import {
  ancestryIdsOf,
  currentRecordPaths,
  describeSnapshotRetention,
  isCurrentPointerRoot,
  isHistoryRoot,
  namedRecordIds,
  resolveSnapshotRetentionPolicy,
} from "./snapshot-retention-policy.mjs";
import { planRetentionReleases, readRetentionReleases, writeRetentionRelease } from "./snapshot-retention-releases.mjs";

// References from history to snapshots an earlier windowed apply released: a
// count, the dates, and the first few, so a reader sees "released by retention
// on <date>" instead of a missing snapshot.
function releasedReferenceSummary(references) {
  if (!references.length) return {};
  const ids = [...new Set(references.map((item) => item.id))];
  const dates = [...new Set(references.map((item) => item.releasedAt))].sort();
  return {
    releasedReferences: {
      count: references.length,
      snapshots: ids.length,
      releasedOn: dates,
      meaning: "history names these snapshots; retention released them on the dates given; they are not missing",
      entries: references.slice(0, 50),
    },
  };
}

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
  // accountOnly: a folder storage GC does not read (a mailbox, a folder of the
  // user's own): its bytes are counted, nothing in it is a root or an issue.
  // What retention released earlier, from the verified release records. A
  // record that cannot be used is an issue and excuses nothing. Without records
  // the walk keeps nothing extra.
  const releases = readRetentionReleases({ root: projectRoot, storage, projectId: owner.project.projectId });
  const withReleases = releases.records.length > 0;
  function walk(relative, accountOnly = false) {
    let file, stat;
    try {
      file = safeGraphFile(projectRoot, relative);
      stat = fs.lstatSync(file);
    } catch (error) {
      issue(relative, error.code || "STORAGE_PATH_UNAVAILABLE");
      physicalIssues.push({ path: relative, reasonCode: error.code || "PHYSICAL_ENTRY_UNAVAILABLE" });
      return;
    }
    // Release records have their own reader, which knows the hard-link pair an
    // interrupted create can leave; they are never roots here.
    if (!stat.isDirectory() && !stat.isSymbolicLink() && relative.startsWith(prefix + "/refresh/retention-releases/")) {
      physicalRows.push({ relative: relative.slice(prefix.length + 1), bytes: stat.size });
      return;
    }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
      if (accountOnly && !stat.isSymbolicLink() && stat.isFile()) {
        physicalRows.push({ relative: relative.slice(prefix.length + 1), bytes: stat.size });
        return;
      }
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
      // The apply's inventory rules: the same folders are walked, skipped or kept.
      const kind = accountOnly ? "account" : classifyGcStorePath(relative.slice(prefix.length + 1), { directory: true });
      if (kind === "unsupported") issue(relative, "UNSUPPORTED_GC_STORAGE_DIRECTORY");
      const inner = accountOnly || kind !== "walk";
      for (const name of fs.readdirSync(file).sort()) {
        if (stopped) break;
        walk(relative + "/" + name, inner);
      }
      return;
    }
    if (++count > MAX_FILES || bytesRead + stat.size > MAX_SCAN_BYTES) {
      stopped = true;
      issue(relative, "STORAGE_SCAN_INCOMPLETE");
      return;
    }
    physicalRows.push({ relative: relative.slice(prefix.length + 1), bytes: stat.size });
    if (accountOnly) return;
    // The apply's inventory rules: caches, generated output, release records and
    // the user's own product graph files are not roots and not issues.
    const kind = classifyGcStorePath(relative.slice(prefix.length + 1), { directory: false });
    if (kind === "ignore" || kind === "user-kept") return;
    if (kind === "unsupported") {
      issue(relative, relative.endsWith(".tmp") ? "UNPUBLISHED_OR_UNKNOWN_STAGE" : "UNSUPPORTED_GC_REFERENCE_ROOT");
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
        const identityIds = [
          document.worldModelId,
          document.graphSnapshotId,
          document.sourceSnapshotId,
          document.temporalProvenanceGraph?.graphSnapshotId,
          document.temporalProvenanceGraph?.sourceSnapshotId,
        ].filter(Boolean);
        snapshots.push({
          id: match[1],
          path: relative,
          bytes: bytes.length,
          sha256: sha(bytes),
          identityIds,
          references: ids(text),
          ...(withReleases ? { ancestryIds: ancestryIdsOf(document) } : {}),
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
        const storeRelative = relative.slice(prefix.length + 1);
        roots.push({
          path: relative,
          relative: storeRelative,
          references: ids(text),
          ...(withReleases && isCurrentPointerRoot(storeRelative) && document ? { namedRecordIds: namedRecordIds(document) } : {}),
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
  const walkIssueCount = issues.length;
  for (const problem of releases.problems) issue(problem.path, problem.reasonCode);
  const releasedReferences = [];
  // The records the current pointers name are not history, in every mode.
  const protectedPaths = withReleases ? currentRecordPaths(roots) : new Set();
  const snapshotById = new Map(snapshots.map((item) => [item.id, item]));
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
      if (wholeSnapshot ? gitStoreNamesSnapshot(id) : deferredBackends.length) continue;
      // History that names an id a release record lists is released by
      // retention, not missing: an older refresh receipt or request, or a stored
      // snapshot's own lineage ids (its parents). Nothing else is excused.
      const release = releases.released.get(id);
      const fromHistory = reason.startsWith("dependency-of:")
        ? (snapshotById.get(reason.slice("dependency-of:".length))?.ancestryIds || []).includes(id)
        : reason.startsWith("retained-reference:") && isHistoryRoot(reason.slice("retained-reference:".length + prefix.length + 1), protectedPaths);
      if (release && fromHistory) {
        releasedReferences.push({ path: reason.slice(reason.indexOf(":") + 1), id, releasedAt: release.releasedAt, releaseId: release.releaseId });
        continue;
      }
      issue(id, "RETAINED_SNAPSHOT_REFERENCE_UNAVAILABLE");
      continue;
    }
    for (const snapshot of matches) {
      if (reasons.has(snapshot.path)) continue;
      reasons.set(snapshot.path, reason);
      for (const dependency of snapshot.references) queue.push({ id: dependency, reason: "dependency-of:" + snapshot.id });
    }
  }
  const observedUnreferenced = snapshots.filter((item) => !reasons.has(item.path));
  const retentionPolicy = resolveSnapshotRetentionPolicy({ root: owner.projectRoot, storage: owner.storage, override: retention });
  // Without a window the dry run is what it was before retention existed: a
  // cheap string scan that names nothing as reclaimable. With a window it runs
  // the apply's own walk, root readers and selection (minus the git snapshot
  // store and the bundle store, which it does not open), so it names exactly
  // the files the apply would delete from what it can see.
  let windowed = null;
  if (!retentionPolicy.preserveAllHistory) {
    windowed = observeSnapshotRetentionClosure({ root: owner.projectRoot, retention, gitStoreNamesSnapshot, deferredBackends });
    // The reference walk above is the default scan; under a window the apply's closure judges references instead.
    issues.splice(walkIssueCount);
    for (const item of windowed.issues) issues.push(item);
    releasedReferences.splice(0, releasedReferences.length, ...windowed.releasedReferences);
  }
  const typedBackendDeferred = deferredBackends.length > 0 && issues.every((item) => item.reasonCode === "TYPED_BACKEND_OBSERVATION_REQUIRED");
  const nextAction = typedBackendDeferred
    ? "Dry-run did not open snapshot-objects.git or snapshot-bundles, so it cannot certify deletions from those backends. Run storage-gc --apply. That reads them. gc_applied with applyPerformed false means the typed closure kept every referenced snapshot."
    : null;
  // D5: when the dry run already knows apply would refuse (issues other than
  // the unopened typed backends), it names nothing as reclaimable.
  const applyWouldRefuse = issues.length > 0 && !typedBackendDeferred;
  const candidatePaths = new Set(
    windowed && !applyWouldRefuse ? windowed.snapshots.filter((row) => !windowed.retained.has(row.path)).map((row) => row.path) : [],
  );
  const rows = snapshots.map((item) => {
    const reclaim = candidatePaths.has(item.path);
    return {
      id: item.id,
      path: item.path,
      bytes: item.bytes,
      sha256: item.sha256,
      observedReference: reasons.get(item.path) || null,
      disposition: reclaim ? "reclaim" : "retain",
      reasonCode: reclaim
        ? "RETENTION_WINDOW_RELEASED"
        : windowed
          ? applyWouldRefuse
            ? "INCOMPLETE_REFERENCE_COVERAGE"
            : "RETAINED_REFERENCE_CLOSURE"
          : reasons.has(item.path)
            ? "RETAINED_REFERENCE_CLOSURE"
            : issues.length
              ? "INCOMPLETE_REFERENCE_COVERAGE"
              : "APPLY_REQUIRES_TYPED_CLOSURE_AND_LIFETIME",
    };
  });
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
      ...describeSnapshotRetention(retentionPolicy),
      reclaimableSnapshots: reclaimable.length,
      released: reclaimable.map((item) => ({ id: item.id, path: item.path, bytes: item.bytes, rule: windowed.releaseRules.get(item.path) || "unreferenced" })),
      releaseRecords: releases.records.length,
      ...(releases.staging.length ? { releaseStaging: releases.staging } : {}),
      ...releasedReferenceSummary(releasedReferences),
      ...(windowed && deferredBackends.length
        ? { unseenBackends: deferredBackends, note: "snapshots stored in these backends were not read; the apply reads them and may keep more" }
        : {}),
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
    interpretation: retentionPolicy.preserveAllHistory
      ? "Retention is off: observed unreferenced IDs are candidates for further verification, not established safe deletions. Every retained reference and its ancestry is preserved. No age or last-N deletion. This inspection does not delete."
      : "A retention window is in force: rows marked reclaim are the snapshot files --apply with the same window would delete. Current pointers and what they name, decision and record pins, snapshots named by hash, snapshots without a trustworthy time and the window stay. Source texts, Canon and Session records are not snapshot files and are not deleted. This inspection does not delete.",
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
  // Which retention is in force, known before anything else, so a refused or
  // cancelled apply still says whether it was off or a window.
  try {
    if (owner.project)
      result.retention = describeSnapshotRetention(resolveSnapshotRetentionPolicy({ root: owner.projectRoot, storage: owner.storage, override: retention }));
  } catch {
    // The policy reader never throws for a bad file; an unreadable store is reported below.
  }
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
    // Under a window, record what this apply releases before anything is
    // unlinked. If the record cannot be written, nothing is deleted. A default
    // apply (no window) writes none.
    // Only what this apply will try to unlink: a git-stored snapshot whose refs
    // are packed is deferred, never listed.
    const toRelease = closure.candidates.filter((row) => row.backend !== "git" || closure.mixed.physicalEligible);
    if (closure.retentionPolicy && !closure.retentionPolicy.preserveAllHistory && toRelease.length) {
      try {
        const documents = planRetentionReleases({
          projectId: closure.owner.projectId,
          policy: closure.retentionPolicy,
          collectionAttemptId: "snapshot-collection-" + attempt.nonce,
          releasedAt: new Date().toISOString(),
          released: toRelease.map((row) => ({
            id: row.id,
            hash: row.worldModelHash || row.graphSnapshotHash || null,
            identityIds: [row.id, ...(row.identityIds || [])],
            rule: closure.releaseRules?.get(row.path) || "unreferenced",
          })),
        });
        const written = documents.map((document) => ({
          path: writeRetentionRelease({ root: closure.owner.root, storage: closure.owner.storage, document }),
          releaseId: document.releaseId,
          releasedAt: document.releasedAt,
          count: document.released.length,
        }));
        result.retentionRelease = {
          path: written[0].path,
          releaseId: written[0].releaseId,
          releasedAt: written[0].releasedAt,
          count: written.reduce((sum, item) => sum + item.count, 0),
          records: written,
        };
      } catch (error) {
        result.code = error.code || "RETENTION_RELEASE_WRITE_FAILED";
        result.status = "gc_preserved";
        result.applyAvailable = false;
        return result;
      }
    }
    // Under a window, Worlds before Graphs: history names both, and a World
    // names its Graph, so if an unlink fails or is cancelled part way what
    // remains is a Graph nothing current names, never a stored World whose Graph
    // is gone. Without a window the candidates are orphans nothing names, and
    // the order stays as it was.
    const windowedApply = closure.retentionPolicy && !closure.retentionPolicy.preserveAllHistory;
    const unlinkOrder = windowedApply
      ? [...closure.candidates].sort((left, right) => Number(right.id.startsWith("world-model-")) - Number(left.id.startsWith("world-model-")))
      : closure.candidates;
    for (const candidate of unlinkOrder) {
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
    const deletedPaths = new Set([...result.deleted.map((item) => item.path), ...result.retiredRefs.map((item) => item.path)]);
    result.retention = {
      ...describeSnapshotRetention(retentionPolicy),
      referencedSnapshots: closure.retained.size,
      eligibleOrphanSnapshots: closure.candidates.length,
      releaseRecords: (closure.releaseRecords || []).length + (result.retentionRelease?.records.length || 0),
      ...releasedReferenceSummary(closure.releasedReferences || []),
      // Each deleted snapshot and the rule it went under: no retained root
      // names it, or it is outside the window.
      released: closure.candidates
        .filter((row) => deletedPaths.has(row.path))
        .map((row) => ({
          id: row.id,
          path: row.path,
          bytes: row.bytes,
          rule: closure.releaseRules?.get(row.path) || "unreferenced",
        })),
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
