import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readGraphProject, safeGraphFile } from "./discovery-index.mjs";
import { readSnapshotFile } from "./snapshot-storage-codec.mjs";
import { beginSnapshotCollection, withSnapshotCollectionUnlink, finishSnapshotCollection, snapshotCollectionCancelled } from "./snapshot-reference-lifetime.mjs";
import { buildSnapshotDeletionClosure, snapshotFileIdentity, sameSnapshotFileIdentity } from "./snapshot-deletion-closure.mjs";
import { qualifySnapshotFileSystem } from "./snapshot-filesystem.mjs";

// Dry-run remains zero-write and observational. Explicit apply separately
// verifies the supported typed closure under cooperative publisher lifetimes.
export const SNAPSHOT_GC_UNCOVERED_WRITERS = Object.freeze([]);
const ids = text => [...new Set(text.match(/\b(?:world-model|graph-snapshot|source-snapshot)-[a-f0-9]{24}\b/g) || [])];
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const MAX_FILES = 50_000, MAX_SCAN_BYTES = 1024 * 1024 * 1024;
const snapshotPath = relative => /\/(?:world-model|graph-projection)\/snapshots\/((?:world-model|graph-snapshot)-[a-f0-9]{24})\.json(?:\.gz)?$/.exec(relative);
export function inspectSnapshotGarbageCollection({ root = ".", apply = false } = {}) {
  if (typeof apply !== "boolean") throw new Error("apply must be a boolean.");
  const owner = readGraphProject(root), projectRoot = owner.projectRoot, storage = owner.storage;
  if (!owner.project) throw Object.assign(new Error("Project is not initialized."), { code: "NOT_INITIALIZED" });
  const prefix = storage.directory, snapshots = [], roots = [], issues = [], scanned = [], bytePins = [];
  let count = 0, bytesRead = 0, stopped = false;const deferredBackends=[];
  const issue = (relative, reasonCode) => issues.push({ path: relative, reasonCode });
  function walk(relative) {
    let file, stat;
    try { file = safeGraphFile(projectRoot, relative); stat = fs.lstatSync(file); }
    catch (error) { issue(relative, error.code || "STORAGE_PATH_UNAVAILABLE"); return; }
    if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) { issue(relative, "UNSAFE_STORAGE_ENTRY"); return; }
    if (stat.isDirectory()) {
      if(relative===prefix+"/.snapshot-gc")return;
      if(relative===prefix+"/snapshot-objects.git"||relative===prefix+"/snapshot-bundles"){deferredBackends.push(relative);issue(relative,"TYPED_BACKEND_OBSERVATION_REQUIRED");return;}
      // A live/unknown operation is preservation evidence, never something this
      // diagnostic removes or waits for. No age/PID-based owner reclamation.
      if (relative === prefix + "/.operations" || relative === prefix + "/refresh/writer.lock" || /\/refresh\/writer\.lock\..*\.staging$/.test(relative)) {
        if (fs.readdirSync(file).length) issue(relative, "ACTIVE_OR_UNKNOWN_WRITER"); return;
      }
      for (const name of fs.readdirSync(file).sort()) { if (stopped) break; walk(relative + "/" + name); }
      return;
    }
    if (++count > MAX_FILES || bytesRead + stat.size > MAX_SCAN_BYTES) { stopped = true; issue(relative, "STORAGE_SCAN_INCOMPLETE"); return; }
    if (relative === prefix + "/graph-discovery/index.json") return; // Rebuildable membership, not a historical root.
    if (relative.endsWith(".tmp")) { issue(relative, "UNPUBLISHED_OR_UNKNOWN_STAGE"); return; }
    let bytes, document, text;
    try {
      const match = snapshotPath(relative);
      if (match) {
        const read = readSnapshotFile(file); bytes = read.bytes; document = read.document; text = JSON.stringify(document);
        bytesRead += Buffer.byteLength(text);
        if (bytesRead > MAX_SCAN_BYTES) { stopped = true; issue(relative, "STORAGE_SCAN_INCOMPLETE"); return; }
        if (document.projectId && document.projectId !== owner.project.projectId) issue(relative, "CROSS_PROJECT_SNAPSHOT");
        if ((document.worldModelId || document.graphSnapshotId) !== match[1]) { issue(relative, "SNAPSHOT_FILENAME_ID_MISMATCH"); return; }
        const identityIds = [document.worldModelId, document.graphSnapshotId, document.sourceSnapshotId,
          document.temporalProvenanceGraph?.graphSnapshotId, document.temporalProvenanceGraph?.sourceSnapshotId].filter(Boolean);
        snapshots.push({ id: match[1], path: relative, bytes: bytes.length, sha256: sha(bytes), identityIds, references: ids(text) });
      } else {
        bytes = fs.readFileSync(file); bytesRead += bytes.length;
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (relative.endsWith(".json")) {
          document = JSON.parse(text);
          if (document.projectId && document.projectId !== owner.project.projectId) issue(relative, "CROSS_PROJECT_REFERENCE_ROOT");
          if (document.schemaVersion !== undefined && ![1, 2].includes(document.schemaVersion)) issue(relative, "UNKNOWN_REFERENCE_SCHEMA");
          const pending = [document];
          while (pending.length) {
            const value = pending.pop(); if (!value || typeof value !== "object") continue;
            if (typeof value.path === "string" && snapshotPath(value.path) && Number.isInteger(value.byteLength) && typeof value.sha256 === "string") bytePins.push(value);
            for (const child of Object.values(value)) if (child && typeof child === "object") pending.push(child);
          }
        } else if (!/\.(?:md|txt|gitignore)$/.test(relative) && !relative.endsWith("/.gitignore")) issue(relative, "UNKNOWN_REFERENCE_FILE_TYPE");
        roots.push({ path: relative, references: ids(text) });
      }
      scanned.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) });
    } catch (error) { issue(relative, error.code || "REFERENCE_ROOT_UNREADABLE"); }
  }
  walk(prefix);
  const physicalIds = new Map();
  for (const item of snapshots) { if (physicalIds.has(item.id)) issue(item.path, "SNAPSHOT_REPRESENTATION_CONFLICT"); physicalIds.set(item.id, item.path); }
  const byId = new Map();
  for (const snapshot of snapshots) for (const id of snapshot.identityIds) {
    if (!byId.has(id)) byId.set(id, []); byId.get(id).push(snapshot);
  }
  const reasons = new Map(), queue = roots.flatMap(root => root.references.map(id => ({ id, reason: "retained-reference:" + root.path })));
  const pinnedFiles = new Map(scanned.map(item => [item.path, item]));
  for (const pin of bytePins) {
    const actual = pinnedFiles.get(pin.path);
    if (!actual || actual.bytes !== pin.byteLength || actual.sha256 !== pin.sha256) issue(pin.path, "HISTORICAL_BYTE_REFERENCE_UNAVAILABLE");
    else queue.push({ id: snapshotPath(pin.path)[1], reason: "exact-historical-byte-reference:" + pin.path });
  }
  for (let i = 0; i < queue.length; i++) {
    const { id, reason } = queue[i], matches = byId.get(id) || [];
    if (!matches.length) { issue(id, "RETAINED_SNAPSHOT_REFERENCE_UNAVAILABLE"); continue; }
    for (const snapshot of matches) {
      if (reasons.has(snapshot.path)) continue;
      reasons.set(snapshot.path, reason);
      for (const dependency of snapshot.references) queue.push({ id: dependency, reason: "dependency-of:" + snapshot.id });
    }
  }
  const observedUnreferenced = snapshots.filter(item => !reasons.has(item.path));
  const rows = snapshots.map(item => ({ id: item.id, path: item.path, bytes: item.bytes, sha256: item.sha256,
    observedReference: reasons.get(item.path) || null, disposition: "retain",
    reasonCode: reasons.has(item.path) ? "RETAINED_REFERENCE_CLOSURE" : issues.length ? "INCOMPLETE_REFERENCE_COVERAGE" : "APPLY_REQUIRES_TYPED_CLOSURE_AND_LIFETIME" }));
  return { kind: "SnapshotStorageInspection", authorityPlane: "P4", persisted: false, projectId: owner.project.projectId,
    status: apply ? "gc_apply_unavailable_preserved" : "gc_dry_run", requestedApply: apply,
    ...(apply ? { code: "SNAPSHOT_GC_APPLY_UNAVAILABLE" } : {}),
    applyAvailable: false, applyPerformed: false, deletedCount: 0, reclaimedBytes: 0, reclaimableBytes: 0,
    snapshotCount: rows.length, storedBytes: rows.reduce((n, item) => n + item.bytes, 0), retainedCount: rows.length,
    observedUnreferencedCount: observedUnreferenced.length, observedUnreferencedBytes: observedUnreferenced.reduce((n, item) => n + item.bytes, 0),
    interpretation: "Observed unreferenced IDs are candidates for further verification, not established safe deletions. Current/previous, parents and all observed retained references are preserved. No age or last-N deletion.",
    basis: { digest: sha(JSON.stringify(scanned)), readConsistency: "observed-sequence-not-atomic-filesystem-snapshot", scannedFiles: count, bytesRead },
    backendInspection:{mode:"synchronous-file-observation",deferredBackends,authority:"no-deletion-certificate"},
    coverage: { scanComplete: !stopped && issues.length === 0, referenceValidity: "not-certified-by-string-scan", schemaCoverage: "typed-validity-not-asserted-for-root-documents", writerCoverage: "not-certified-by-zero-write-inspection", issues: issues.slice(0, 200), omittedIssues: Math.max(0, issues.length - 200) },
    snapshots: rows.slice(0, 200), omittedSnapshots: Math.max(0, rows.length - 200), uncoveredWriters: SNAPSHOT_GC_UNCOVERED_WRITERS,
    ordinaryWorkBlocked: false, instructionAuthority: false, recoveryAuthority: false, executionAuthority: false };
}

// Explicit asynchronous effect, separate from the unchanged zero-write
// inspection. A diagnostic string scan is never its deletion certificate.
export async function applySnapshotGarbageCollection({ root = ".", signal, onProcess } = {}) {
  const deadline=Date.now()+30_000;
  const owner = readGraphProject(root);
  const result = { kind: "SnapshotStorageInspection", authorityPlane: "P4", persisted: false,
    projectId: owner.project?.projectId, requestedApply: true, status: "gc_preserved",
    applyAvailable: false, applyPerformed: false, deletedCount: 0, reclaimedBytes: 0,
    deleted: [], failed: [], preserved: [], deferred:[], retiredRefs:[], retiredRefCount:0, deletedDomainBundles:0, deletedObjectFiles:0, deletedSourceBundles:0, writtenPackBytes:0, publishedPackBytes:0, ordinaryWorkBlocked: false,
    instructionAuthority: false, recoveryAuthority: false, executionAuthority: false,
    support: "cooperating-current-local-entrypoints; not universal old/raw/shared-host exclusion",
    physicalScope: "verified orphan whole World/Graph files, private loose Git refs/objects and domain fragments; source/canonical originals retained" };
  if (signal?.aborted) return { ...result, code: "SNAPSHOT_GC_CANCELLED" };
  const attempt = beginSnapshotCollection({ root, storage: owner.storage });
  if (attempt.status !== "active") return { ...result, status: attempt.status === "yielded" ? "gc_yielded" : "gc_preserved", code: attempt.reasonCode };
  let closure;
  try {
    result.filesystem = await qualifySnapshotFileSystem({ root: owner.projectRoot, signal, onProcess });
    if (result.filesystem.status !== "qualified-local") {
      result.code = signal?.aborted ? "SNAPSHOT_GC_CANCELLED" : result.filesystem.reasonCode;
      return result;
    }
    closure = await buildSnapshotDeletionClosure({ root,signal,onProcess,deadline,collectionAttempt:attempt, shouldContinue: () => !signal?.aborted && !snapshotCollectionCancelled(attempt) });
    result.coverage = { referenceValidity: closure.certified ? "typed-supported-root-closure" : "incomplete-preserved",
      backend: closure.backend, decodedInputBytes: closure.decodedBytes, retainedSummaryBytes: closure.summaryBytes,
      maxSummaryBytes: closure.maxSummaryBytes, issues: closure.issues.slice(0, 200), omittedIssues: closure.omittedIssues || 0 };
    result.basis = { digest: closure.basisDigest, readConsistency: "cooperative-lifetime-and-exact-file-identity" };
    result.snapshotCount = closure.snapshots.length;
    result.storedBytes = closure.snapshots.reduce((sum, item) => sum + item.bytes, 0)+closure.mixed.storedBytes;
    if (!closure.certified) {
      result.code = signal?.aborted ? "SNAPSHOT_GC_CANCELLED" : closure.interrupted || snapshotCollectionCancelled(attempt) ? "SNAPSHOT_COLLECTION_INVALIDATED" : "SNAPSHOT_GC_REFERENCE_COVERAGE_INCOMPLETE";
      if (result.code === "SNAPSHOT_COLLECTION_INVALIDATED") result.status = "gc_yielded";
      return result;
    }
    withSnapshotCollectionUnlink(attempt, () => {});
    result.applyAvailable = true;
    for (const candidate of closure.candidates) {
      if (signal?.aborted) { result.code = "SNAPSHOT_GC_CANCELLED"; break; }
      try {
        if(candidate.backend==="git") {
          if(!closure.mixed.physicalEligible){result.deferred.push({path:candidate.path,code:"UNSUPPORTED_GC_PACKED_REFS"});continue;}
          const refFile=closure.mixed.retireRef(candidate,attempt);
          result.retiredRefs.push({id:candidate.id,path:candidate.path,ref:candidate.ref,oid:candidate.oid});result.retiredRefCount++;
          closure.mixed.recordDelete(result,refFile,"git-ref");await new Promise(resolve=>setImmediate(resolve));continue;
        }
        // Expensive inventory/typed/hash work has completed outside admission.
        // Under cooperation a new publication permanently invalidates this
        // attempt, even if that operation has already finished (ABA).
        withSnapshotCollectionUnlink(attempt, () => {
          const safe = safeGraphFile(owner.projectRoot, candidate.path);
          const stat = fs.lstatSync(safe, { bigint: true });
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
            || !sameSnapshotFileIdentity(candidate.identity, snapshotFileIdentity(stat))) {
            throw Object.assign(new Error("Snapshot file identity changed."), { code: "SNAPSHOT_GC_CANDIDATE_DRIFT" });
          }
          fs.unlinkSync(safe);
        });
        result.deleted.push({ id: candidate.id, path: candidate.path, bytes: candidate.bytes, sha256: candidate.sha256 });
        result.deletedCount += 1;
        result.reclaimedBytes += candidate.bytes;
        result.applyPerformed = true;await new Promise(resolve=>setImmediate(resolve));
      } catch (error) {
        result.code = error.code || "SNAPSHOT_GC_DELETE_FAILED";
        result.failed.push({ path: candidate.path, code: result.code });
        break;
      }
    }
    if(!result.code) {
      const removed=new Set([...result.deleted.map(item=>item.path),...result.retiredRefs.map(item=>item.path)]);
      await closure.mixed.reclaim({attempt,result,remainingSnapshots:closure.snapshots.filter(row=>!removed.has(row.path)),pinnedOids:closure.pinnedOids,pinnedPaths:closure.pinnedPaths});
    }
    result.status = result.code ? result.applyPerformed ? "gc_partial" : "gc_preserved" : result.deferred.length ? result.applyPerformed ? "gc_partial" : "gc_preserved" : "gc_applied";
    return result;
  } catch (error) {
    result.code = error.code || "SNAPSHOT_GC_FAILED";
    if(error.nativeProcessCleanup)result.nativeProcessCleanup=error.nativeProcessCleanup;
    if(error.snapshotStagingCleanup)result.cleanup={status:"owner-preserved",...error.snapshotStagingCleanup};
    result.status = result.applyPerformed ? "gc_partial" : "gc_preserved";
    return result;
  } finally {
    if (closure) {
      const deleted = new Set([...result.deleted.map(item => item.path),...result.retiredRefs.map(item=>item.path)]);
      result.preserved = closure.snapshots.filter(item => !deleted.has(item.path)).map(item => ({ id: item.id, path: item.path,
        reasonCode: closure.retained.has(item.path) ? "RETAINED_REFERENCE_CLOSURE" : result.code || "PRESERVED" }));
      result.retainedCount = result.preserved.length;
    }
    result.actualUnlinkedBytes=result.reclaimedBytes;result.netStorageBytes=result.reclaimedBytes-result.publishedPackBytes;
    try { finishSnapshotCollection(attempt); }
    catch (error) {
      result.cleanup = { status: "owner-preserved", code: error.code || "SNAPSHOT_GC_CLEANUP_FAILED" };
      result.code ??= result.cleanup.code;
      result.status = result.deletedCount ? "gc_partial" : "gc_preserved";
    }
  }
}
