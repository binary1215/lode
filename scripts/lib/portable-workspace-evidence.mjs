import fs from "node:fs";
import path from "node:path";
import { projectWorkspacePathExclusion, projectWorkspaceSelectedPaths, inspectProjectWorkspaceFile } from "./project-workspace-transfer.mjs";
import { assertCopiedProjectRelativePath, copiedProjectFile, inspectCopiedProjectFile, verifyCopiedProjectFile, copyOriginal } from "./project-copy-evidence.mjs";
import { nativeRoot, pinNativeRoot, nativeCheck } from "./provider-native-history-host.mjs";
import { verifyCodexProjectCatalog } from "./codex-project-catalog.mjs";
import { derivedHash as hash, derivedJson as json, derivedFail as fail } from "./claude-derived-encoder.mjs";

const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const rootKey = (value, platform = process.platform) => {
  if (platform !== "win32") return path.posix.resolve(value);
  let resolved = path.win32.resolve(value);
  if (resolved.startsWith("\\\\?\\UNC\\")) resolved = "\\\\" + resolved.slice(8);
  else if (resolved.startsWith("\\\\?\\")) resolved = resolved.slice(4);
  return resolved.toLowerCase();
};
const groupId = value => { const { workspaceId, ...body } = value; return "workspace-evidence-" + hash(json(body)).slice(0, 24); };

// Explicit current Host inventories only. Do not traverse a whole workspace,
// follow attachments/historical paths, copy client state or infer a full repo.
export function capturePortableWorkspaces({ catalog, workspaceSources, queue, addValidator, check, signal }) {
  if (!Array.isArray(workspaceSources)) fail("PORTABLE_WORKSPACE_SOURCE_SELECTION_INVALID");
  const members = verifyCodexProjectCatalog(catalog).records, seen = new Set();
  return workspaceSources.map(selection => {
    check();
    if (!selection || Object.keys(selection).sort().join(",") !== "paths,sourceRoot" || typeof selection.sourceRoot !== "string" || !path.isAbsolute(selection.sourceRoot)) fail("PORTABLE_WORKSPACE_SOURCE_SELECTION_INVALID");
    if (!members.some(member => typeof member.cwd === "string" && path.isAbsolute(member.cwd) && rootKey(member.cwd) === rootKey(selection.sourceRoot))) fail("PORTABLE_WORKSPACE_OUTSIDE_SELECTED_PROJECT");
    const root = nativeRoot(selection.sourceRoot), pin = pinNativeRoot(root);
    if (seen.has(rootKey(root))) fail("PORTABLE_WORKSPACE_SOURCE_DUPLICATE"); seen.add(rootKey(root));
    const source = { root, check: () => { check(); pin.verify(); } }, selectedPaths = projectWorkspaceSelectedPaths(selection.paths), observedAt = new Date().toISOString();
    const entries = selectedPaths.map(relative => {
      const reason = projectWorkspacePathExclusion(relative);
      if (reason && reason !== "current-host-instruction-integration-required") return { path: relative, status: "excluded", reason };
      source.check(); let original;
      try {
        const inspected = inspectProjectWorkspaceFile(root, relative, { signal, assertCurrentAuthority: source.check });
        if (inspected.status === "excluded") return { path: relative, status: "excluded", reason: inspected.reason };
        original = inspected.entry;
      }
      catch (error) {
        if (error.code !== "ENOENT" || error.path !== path.join(root, ...relative.split("/"))) throw error;
        return { path: relative, status: "unavailable", reason: "selected-source-file-not-found", primarySourceFailure: { code: "ENOENT" } };
      }
      addValidator(() => verifyCopiedProjectFile(root, original, { signal, assertCurrentAuthority: source.check }));
      const sourceExecutable = process.platform === "win32" ? null : (fs.lstatSync(copiedProjectFile(root, relative)).mode & 0o111) !== 0;
      return { path: relative, status: reason ? "evidence-only" : "captured", ...(reason ? { reason } : {}), sourceExecutable, original: queue(source, relative, original) };
    });
    source.check(); const stat = fs.lstatSync(root, { bigint: true });
    const group = { schemaVersion: 1, kind: "PortableWorkspaceEvidence", authorityPlane: "P3", sourceRoot: root, sourcePlatform: process.platform,
      sourceIdentity: { dev: String(stat.dev), ino: String(stat.ino), scope: "capture-host-only-not-target-identity" }, selectedPaths, entries, observedAt,
      completedAt: new Date().toISOString(), snapshotClaim: "independent-verified-file-reads-not-whole-worktree-snapshot", fullRepositoryInventoryClaimed: false,
      credentialCoverage: "recognized-paths-and-key-container-formats-only-not-secret-free-certification",
      sourcePermissionsImported: false, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
    return { ...group, workspaceId: groupId(group) };
  });
}

export function verifyPortableWorkspaceEvidence(groups, verifyObject, catalog, requiredSourceRoots = null, objectSelection = "all-evidence") {
  if (!Array.isArray(groups)) fail("PORTABLE_WORKSPACE_EVIDENCE_INVALID");
  const roots = new Set();
  for (const group of groups) {
    const verifyBody = entry => {
      if ((requiredSourceRoots === null || requiredSourceRoots.includes(group.sourceRoot))
        && (objectSelection === "all-evidence" || entry.status === "captured")) verifyObject(entry.original);
    };
    if (group?.schemaVersion !== 1 || group.kind !== "PortableWorkspaceEvidence" || group.authorityPlane !== "P3"
      || typeof group.sourceRoot !== "string" || !(path.win32.isAbsolute(group.sourceRoot) || path.posix.isAbsolute(group.sourceRoot))
      || !["win32", "linux", "darwin"].includes(group.sourcePlatform) || group.workspaceId !== groupId(group)
      || group.sourceIdentity?.scope !== "capture-host-only-not-target-identity" || !/^\d+$/u.test(group.sourceIdentity.dev) || !/^\d+$/u.test(group.sourceIdentity.ino)
      || group.snapshotClaim !== "independent-verified-file-reads-not-whole-worktree-snapshot"
      || group.credentialCoverage !== "recognized-paths-and-key-container-formats-only-not-secret-free-certification"
      || ["fullRepositoryInventoryClaimed", "sourcePermissionsImported", "grantsRecoveryAuthority", "restoresExecutionPermission"].some(key => group[key] !== false)
      || !Array.isArray(group.selectedPaths) || !Array.isArray(group.entries) || group.selectedPaths.length !== group.entries.length
      || new Set(group.selectedPaths).size !== group.selectedPaths.length || roots.has(group.sourceRoot)) fail("PORTABLE_WORKSPACE_EVIDENCE_INVALID");
    roots.add(group.sourceRoot);
    const sourceStyle = group.sourcePlatform === "win32" ? path.win32 : path.posix;
    if (catalog && !verifyCodexProjectCatalog(catalog).records.some(member => typeof member.cwd === "string" && sourceStyle.isAbsolute(member.cwd)
      && rootKey(member.cwd, group.sourcePlatform) === rootKey(group.sourceRoot, group.sourcePlatform))) fail("PORTABLE_WORKSPACE_OUTSIDE_SELECTED_PROJECT");
    for (const [index, entry] of group.entries.entries()) {
      assertCopiedProjectRelativePath(entry.path);
      if (entry.path !== group.selectedPaths[index]) fail("PORTABLE_WORKSPACE_EVIDENCE_INVALID");
      const reason = projectWorkspacePathExclusion(entry.path);
      if (entry.sourceExecutable !== undefined && ![null, true, false].includes(entry.sourceExecutable)) fail("PORTABLE_WORKSPACE_EVIDENCE_INVALID");
      if (reason === "current-host-instruction-integration-required") {
        if (entry.status !== "evidence-only" || entry.reason !== reason || !digest(entry.original?.sha256) || !Number.isSafeInteger(entry.original.bytes) || entry.original.bytes < 0) fail("PORTABLE_WORKSPACE_EVIDENCE_INVALID");
        verifyBody(entry);
      }
      else if (reason) { if (entry.status !== "excluded" || entry.reason !== reason || entry.original !== undefined) fail("PORTABLE_WORKSPACE_PRIVATE_PATH"); }
      else if (entry.status === "excluded" && entry.reason === "private-key-format-not-in-code-scope" && /\.(?:pem|asc)$/iu.test(entry.path)) { if (entry.original !== undefined) fail("PORTABLE_WORKSPACE_PRIVATE_PATH"); }
      else if (entry.status === "unavailable") { if (entry.reason !== "selected-source-file-not-found" || entry.primarySourceFailure?.code !== "ENOENT" || entry.original !== undefined) fail("PORTABLE_WORKSPACE_EVIDENCE_INVALID"); }
      else { if (entry.status !== "captured" || !digest(entry.original?.sha256) || !Number.isSafeInteger(entry.original.bytes) || entry.original.bytes < 0) fail("PORTABLE_WORKSPACE_EVIDENCE_INVALID"); verifyBody(entry); }
    }
  }
}

// This validates only the explicit current destination. Source roots in the
// archive are lookup labels; no source-PC path or account/config is opened.
function targetLocation(requested, check) {
  if (typeof requested !== "string" || !path.isAbsolute(requested)) fail("PORTABLE_WORKSPACE_CURRENT_TARGET_REQUIRED");
  const absolute = path.resolve(requested); let ancestor = absolute;
  while (!fs.lstatSync(ancestor, { throwIfNoEntry: false })) { check(); const parent = path.dirname(ancestor); if (parent === ancestor) fail("PORTABLE_WORKSPACE_TARGET_PARENT_UNAVAILABLE"); ancestor = parent; }
  const parent = nativeRoot(ancestor), parentPin = pinNativeRoot(parent), relative = path.relative(ancestor, absolute).split(path.sep).join("/");
  const target = relative ? copiedProjectFile(parent, relative) : parent;
  return { target, parentPin, exists: Boolean(fs.lstatSync(target, { throwIfNoEntry: false })) };
}
const containsRoot = (base, file) => {
  const relative = path.relative(rootKey(base), rootKey(file));
  return !relative || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
const directoryId = directory => { const stat = fs.lstatSync(directory, { bigint: true }); return stat.dev + ":" + stat.ino; };
function archiveDirectoryIds(root, check) {
  const ids = new Set(), pending = [root];
  while (pending.length) {
    check(); const directory = pending.pop(), id = directoryId(directory); if (ids.has(id)) continue; ids.add(id);
    const handle = fs.opendirSync(directory);
    try { for (let entry; (entry = handle.readSync()); ) { check(); if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(path.join(directory, entry.name)); } }
    finally { handle.closeSync(); }
  }
  return ids;
}

export async function restorePortableWorkspaces({ directory, archiveId, expectedArchiveDigest, workspaceTargets = [], signal, assertCurrentAuthority }) {
  if (typeof assertCurrentAuthority !== "function" || !digest(expectedArchiveDigest) || !Array.isArray(workspaceTargets)) fail("PORTABLE_WORKSPACE_CURRENT_SCOPE_REQUIRED");
  const check = () => nativeCheck(signal, assertCurrentAuthority); check();
  const { inspectPortableProjectEvidence } = await import("./portable-project-evidence.mjs");
  const copiedRoots = workspaceTargets.filter(mapping => (mapping?.mode ?? "copy") === "copy").map(mapping => mapping?.sourceRoot);
  const archive = inspectPortableProjectEvidence({ directory, archiveId, expectedArchiveDigest, workspaceSourceRoots: copiedRoots, workspaceObjectSelection: "restore-captured-only", signal, assertCurrentAuthority: check });
  const archivePin = pinNativeRoot(archive.directory), sourceCheck = () => { check(); archivePin.verify(); };
  const protectedDirectories = copiedRoots.length ? archiveDirectoryIds(archive.directory, sourceCheck) : new Set();
  const protectArchive = location => {
    sourceCheck();
    if (containsRoot(archive.directory, location.target) || protectedDirectories.has(directoryId(location.parentPin.root))) fail("PORTABLE_WORKSPACE_ARCHIVE_TARGET_OVERLAP");
  };
  const groups = archive.manifest.workspaceEvidence ?? [], plans = [], seenSource = new Set(), targetOwners = new Map(), outputOwners = new Map();
  for (const mapping of workspaceTargets) {
    check();
    if (!mapping || Object.keys(mapping).some(key => !["sourceRoot", "targetRoot", "mode"].includes(key)) || typeof mapping.sourceRoot !== "string"
      || seenSource.has(mapping.sourceRoot) || !["copy", "reuse"].includes(mapping.mode ?? "copy")) fail("PORTABLE_WORKSPACE_TARGET_SELECTION_INVALID");
    seenSource.add(mapping.sourceRoot); const group = groups.find(group => group.sourceRoot === mapping.sourceRoot);
    if (!group) fail("PORTABLE_WORKSPACE_CAPTURE_NOT_SELECTED");
    const location = targetLocation(mapping.targetRoot, check), mode = mapping.mode ?? "copy", key = rootKey(location.target);
    if (mode === "copy") protectArchive(location);
    if (mode === "copy" && targetOwners.has(key) || targetOwners.get(key)?.mode === "copy") fail("PORTABLE_WORKSPACE_DISTINCT_ROOT_MERGE");
    targetOwners.set(key, { sourceRoot: group.sourceRoot, mode });
    if (mode === "reuse") { plans.push({ group, ...location, mode, entries: [] }); continue; }
    projectWorkspaceSelectedPaths(group.selectedPaths); // current target case/alias policy, not an archive-read gate
    const entries = group.entries.filter(entry => entry.status === "captured" && !projectWorkspacePathExclusion(entry.path)).map(entry => {
      const target = path.resolve(location.target, ...entry.path.split("/")), fileKey = rootKey(target);
      protectArchive(targetLocation(path.dirname(target), check));
      if (outputOwners.has(fileKey)) fail("PORTABLE_WORKSPACE_DISTINCT_ROOT_MERGE"); outputOwners.set(fileKey, group.sourceRoot);
      if (!location.exists) return { ...entry, targetState: "absent" };
      check(); const file = copiedProjectFile(location.target, entry.path);
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!stat) return { ...entry, targetState: "absent" };
      const current = inspectCopiedProjectFile(location.target, entry.path, { signal, assertCurrentAuthority: check });
      return { ...entry, targetState: current.sha256 === entry.original.sha256 && current.bytes === entry.original.bytes ? "identical" : "conflict" };
    });
    plans.push({ group, ...location, mode, entries });
  }
  const results = []; let active = null;
  try {
    for (const plan of plans) {
      check(); plan.parentPin.verify(); active = { sourceRoot: plan.group.sourceRoot, targetRoot: plan.target, completedPaths: [], currentPath: null,
        currentEffect: null, unvisitedPaths: plan.entries.map(entry => entry.path) };
      if (plan.mode === "reuse") {
        if (!plan.exists) { results.push({ sourceRoot: plan.group.sourceRoot, targetRoot: plan.target, status: "reuse-target-unavailable", filesWritten: 0 }); active = null; continue; }
        nativeRoot(plan.target); results.push({ sourceRoot: plan.group.sourceRoot, targetRoot: plan.target, status: "existing-workspace-reused", sourceVersionEquivalenceClaimed: false, filesWritten: 0 }); active = null; continue;
      }
      const conflicts = plan.entries.filter(entry => entry.targetState === "conflict").map(entry => entry.path);
      if (conflicts.length) { results.push({ sourceRoot: plan.group.sourceRoot, targetRoot: plan.target, status: "workspace-file-conflicts", conflicts, filesWritten: 0 }); active = null; continue; }
      fs.mkdirSync(plan.target, { recursive: true }); const target = nativeRoot(plan.target), pin = pinNativeRoot(target); let filesWritten = 0;
      for (const entry of plan.entries) {
        sourceCheck(); pin.verify(); active.currentPath = entry.path;
        active.unvisitedPaths.shift(); active.currentEffect = "not-entered";
        verifyCopiedProjectFile(archive.directory, { ...entry.original, path: "objects/" + entry.original.sha256 + ".bin" }, { signal, assertCurrentAuthority: sourceCheck });
        const before = fs.lstatSync(copiedProjectFile(target, entry.path), { throwIfNoEntry: false });
        if (!before) { fs.mkdirSync(path.dirname(copiedProjectFile(target, entry.path)), { recursive: true }); check(); pin.verify(); }
        protectArchive(targetLocation(path.dirname(copiedProjectFile(target, entry.path)), check));
        active.currentEffect = "create-only-copy-entered";
        copyOriginal(archive.directory, target, { ...entry.original, path: "objects/" + entry.original.sha256 + ".bin" }, { targetRelative: entry.path, signal,
          assertCurrentAuthority: () => { sourceCheck(); pin.verify(); } });
        if (!before) filesWritten++; active.completedPaths.push(entry.path); active.currentPath = null; active.currentEffect = null;
      }
      const unavailablePaths = plan.group.entries.filter(entry => entry.status === "unavailable").map(entry => ({ path: entry.path, reason: entry.reason }));
      results.push({ sourceRoot: plan.group.sourceRoot, targetRoot: target, status: unavailablePaths.length ? "selected-workspace-files-restored-with-missing-source" : "selected-workspace-files-restored", filesWritten, unavailablePaths,
        selectedPermittedFiles: plan.entries.length, excludedPaths: plan.group.entries.filter(entry => entry.status === "excluded").map(entry => ({ path: entry.path, reason: entry.reason })),
        evidenceOnlyPaths: plan.group.entries.filter(entry => projectWorkspacePathExclusion(entry.path) === "current-host-instruction-integration-required").map(entry => ({ path: entry.path, reason: "current-host-instruction-integration-required" })),
        fullRepositoryInventoryClaimed: false, sourcePermissionsImported: false, sourceExecutableMetadataApplied: false,
        targetPermissionPolicy: "current-target-defaults" }); active = null;
    }
  } catch (error) {
    error.portableWorkspaceObservation = { kind: "PortableWorkspaceRestorePartialOutcome", authorityPlane: "P5", results, active,
      unvisitedSourceRoots: plans.slice(results.length + (active ? 1 : 0)).map(plan => plan.group.sourceRoot), primaryFailure: { code: error.code || error.name },
      rollbackAttempted: false, additionalFilesystemObservationAfterFailure: false, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
    throw error;
  }
  return { status: "portable-workspaces-observed", authorityPlane: "P5", archiveId, archiveDigest: archive.archiveDigest, results,
    workspaceObjectCoverage: archive.workspaceObjectCoverage,
    pendingSourceRoots: [...groups.filter(group => !seenSource.has(group.sourceRoot)).map(group => group.sourceRoot), ...results.filter(row => !["selected-workspace-files-restored", "existing-workspace-reused"].includes(row.status)).map(row => row.sourceRoot)],
    nextConversationMappings: results.filter(row => ["selected-workspace-files-restored", "selected-workspace-files-restored-with-missing-source", "existing-workspace-reused"].includes(row.status)).flatMap(row => {
      const group = groups.find(group => group.sourceRoot === row.sourceRoot), sourceStyle = group.sourcePlatform === "win32" ? path.win32 : path.posix;
      return [...new Set(verifyCodexProjectCatalog(archive.manifest.catalog).records.filter(member => typeof member.cwd === "string" && sourceStyle.isAbsolute(member.cwd)
        && rootKey(member.cwd, group.sourcePlatform) === rootKey(group.sourceRoot, group.sourcePlatform)).map(member => member.cwd))].map(sourceRoot => ({ sourceRoot, targetRoot: row.targetRoot }));
    }),
    originalSourcePathsAccessed: false, nativePublicationAttempted: false, initializedProjectOrSession: false, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
}
