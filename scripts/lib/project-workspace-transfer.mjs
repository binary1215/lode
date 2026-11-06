import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertCopiedProjectRelativePath, copiedProjectFile, inspectCopiedProjectFile, verifyCopiedProjectFile, copyOriginal } from "./project-copy-evidence.mjs";
import { nativeRoot, pinNativeRoot } from "./provider-native-history-host.mjs";

const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { code }); };
const pin = root => { const stat = fs.lstatSync(root, { bigint: true }); return { path: root, dev: String(stat.dev), ino: String(stat.ino) }; };

// This consumes the current Host's selected repository-owned path inventory.
// It does not crawl historical roots, follow attachments, run Git or install
// dependencies. Project governance and client-private state have other owners.
function excluded(relative) {
  const parts = relative.split("/").map(part => part.toLowerCase());
  if (parts.includes(".git")) return "git-metadata-not-in-code-scope";
  if (parts.some(part => [".head", ".lode"].includes(part))) return "optional-core-records-use-common-portability";
  if (parts.some(part => [".codex", ".claude", ".opencode"].includes(part))) return "client-private-state-not-in-code-scope";
  if (parts.some(part => [".ssh", ".aws", ".azure", ".gnupg", ".kube"].includes(part))) return "private-user-configuration-not-in-code-scope";
  const name = parts.at(-1);
  if (["agents.md", "claude.md"].includes(name)) return "current-host-instruction-integration-required";
  if ([".mcp.json", "opencode.json", "opencode.jsonc"].includes(name)) return "host-connection-configuration-not-in-code-scope";
  if (name === ".env" || /^\.env\.(?!example$|sample$|template$)/.test(name)
    || ["auth.json", "credentials.json", ".npmrc", ".pypirc", ".netrc"].includes(name))
    return "credential-or-local-environment-not-in-code-scope";
  if (/\.(?:key|p12|pfx|jks|keystore|pk8|pkcs8|kdbx)$/u.test(name) || ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"].includes(name))
    return "credential-container-not-in-code-scope";
  return null;
}
const privateFormatFailures = new WeakSet();
export function inspectProjectWorkspaceFile(root, relative, options = {}) {
  const scan = /\.(?:pem|asc)$/iu.test(relative); let tail = "";
  try {
    const entry = inspectCopiedProjectFile(root, relative, { ...options, onChunk(bytes, start) {
      options.onChunk?.(bytes, start);
      if (!scan) return;
      const text = tail + bytes.toString("latin1");
      if (/-----BEGIN (?:(?:[A-Z0-9]+ )*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/u.test(text)) {
        const error = Object.assign(new Error("Selected file contains a recognized private-key container header."), { code: "WORKSPACE_PRIVATE_KEY_FORMAT" });
        privateFormatFailures.add(error); throw error;
      }
      tail = text.slice(-160);
    } });
    return { status: "observed", entry };
  } catch (error) {
    if (!privateFormatFailures.has(error)) throw error;
    return { status: "excluded", reason: "private-key-format-not-in-code-scope" };
  }
}
function targetLocation(targetRoot) {
  if (typeof targetRoot !== "string" || !path.isAbsolute(targetRoot)) fail("WORKSPACE_TRANSFER_TARGET_REQUIRED");
  const absolute = path.resolve(targetRoot), parent = nativeRoot(path.dirname(absolute));
  const requested = copiedProjectFile(parent, path.basename(absolute)), exists = fs.existsSync(requested);
  return { parent, exists, target: exists ? nativeRoot(requested) : requested };
}
const contains = (base, child) => {
  const relative = path.relative(base, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
};
function checkRootRelationship(source, target, mode, targetExists) {
  const same = targetExists && pin(source).dev === pin(target).dev && pin(source).ino === pin(target).ino;
  if (mode === "reuse" && !same) fail("WORKSPACE_TRANSFER_REUSE_REQUIRES_SAME_ROOT");
  if (mode === "copy" && same) fail("WORKSPACE_TRANSFER_USE_REUSE_FOR_SAME_ROOT");
  if (mode === "copy" && (contains(source, target) || contains(target, source))) fail("WORKSPACE_TRANSFER_ROOT_OVERLAP");
}
function checker(signal, assertCurrentAuthority) {
  if (typeof assertCurrentAuthority !== "function") fail("WORKSPACE_TRANSFER_AUTHORITY_CHECK_REQUIRED");
  return () => {
    if (signal?.aborted) fail("WORKSPACE_TRANSFER_CANCELLED");
    const result = assertCurrentAuthority();
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch(() => {}); fail("WORKSPACE_TRANSFER_SYNCHRONOUS_AUTHORITY_REQUIRED");
    }
    if (result === false) fail("WORKSPACE_TRANSFER_AUTHORITY_DENIED");
  };
}
function pathsFor(paths) {
  if (!Array.isArray(paths) || new Set(paths).size !== paths.length) fail("WORKSPACE_TRANSFER_PATH_SELECTION_INVALID");
  const seen = new Set();
  for (const relative of paths) {
    assertCopiedProjectRelativePath(relative);
    const key = process.platform === "win32" ? relative.toLowerCase() : relative;
    if (seen.has(key)) fail("WORKSPACE_TRANSFER_PATH_COLLISION");
    seen.add(key);
  }
  return [...paths].sort();
}
export { excluded as projectWorkspacePathExclusion, pathsFor as projectWorkspaceSelectedPaths };

// P4 preparation only: no target directories, records or permissions are made.
// An unreadable selected source retains its primary failure; partial file sets
// are not relabelled as a complete runnable Project.
export function prepareProjectWorkspaceTransfer({ sourceRoot, targetRoot, paths = [], mode = "copy",
  signal, assertCurrentAuthority = () => {} } = {}) {
  const check = checker(signal, assertCurrentAuthority); check();
  if (!["copy", "reuse"].includes(mode)) fail("WORKSPACE_TRANSFER_MODE_INVALID");
  const source = nativeRoot(sourceRoot), sourcePin = pinNativeRoot(source);
  const { target, parent, exists: targetExists } = targetLocation(targetRoot);
  checkRootRelationship(source, target, mode, targetExists);
  const entries = [];
  for (const relative of pathsFor(paths)) {
    check(); sourcePin.verify();
    const reason = excluded(relative);
    if (reason) { entries.push({ path: relative, status: "excluded", reason }); continue; }
    const inspected = inspectProjectWorkspaceFile(source, relative, { signal, assertCurrentAuthority: check });
    if (inspected.status === "excluded") { entries.push({ path: relative, status: "excluded", reason: inspected.reason }); continue; }
    const entry = inspected.entry;
    let targetState = "absent";
    if (targetExists && fs.existsSync(copiedProjectFile(target, relative))) {
      const existing = inspectCopiedProjectFile(target, relative, { signal, assertCurrentAuthority: check });
      targetState = existing.sha256 === entry.sha256 && existing.bytes === entry.bytes ? "identical" : "conflict";
    }
    entries.push({ ...entry, status: "observed", targetState });
  }
  sourcePin.verify(); check();
  const plan = { schemaVersion: 1, kind: "ProjectWorkspaceTransferPlan", authorityPlane: "P3",
    mode, source: pin(source), target: { path: target, parent: pin(parent), existing: targetExists ? pin(nativeRoot(target)) : null },
    selectedPaths: [...paths].sort(), entries,
    selectionOrigin: "current-host-selected-repository-owned-paths; no inferred full-worktree coverage",
    grantsRecoveryAuthority: false, grantsExecutionPermission: false };
  return { plan, planDigest: hash(plan), authorityPlane: "P4", persisted: false,
    requestedFileCount: paths.length, excludedFileCount: entries.filter(entry => entry.status === "excluded").length,
    conflicts: entries.filter(entry => entry.targetState === "conflict").map(entry => entry.path),
    workspaceFilesCopied: false, runnableProjectVerified: false };
}

// Current exact roots and authority are supplied independently of historical
// plan data. A digest is an integrity check, never an approval or P2 direction.
export function applyProjectWorkspaceTransfer({ plan, expectedPlanDigest, sourceRoot, targetRoot,
  signal, assertCurrentAuthority = () => {} } = {}) {
  const check = checker(signal, assertCurrentAuthority); check();
  if (typeof expectedPlanDigest !== "string" || hash(plan) !== expectedPlanDigest
    || plan?.schemaVersion !== 1 || plan.kind !== "ProjectWorkspaceTransferPlan"
    || plan.authorityPlane !== "P3" || !["copy", "reuse"].includes(plan.mode)
    || plan.grantsRecoveryAuthority !== false || plan.grantsExecutionPermission !== false)
    fail("WORKSPACE_TRANSFER_PLAN_INVALID");
  const currentTarget = targetLocation(targetRoot);
  if (nativeRoot(sourceRoot) !== plan.source.path || currentTarget.target !== plan.target.path) fail("WORKSPACE_TRANSFER_CURRENT_ROOT_MISMATCH");
  const source = nativeRoot(sourceRoot), sourcePin = pinNativeRoot(source);
  checkRootRelationship(source, currentTarget.target, plan.mode, currentTarget.exists);
  const parent = nativeRoot(path.dirname(plan.target.path)), parentPin = pinNativeRoot(parent);
  if (!isDeepStrictEqual(pin(source), plan.source) || !isDeepStrictEqual(pin(parent), plan.target.parent))
    fail("WORKSPACE_TRANSFER_ROOT_CHANGED");
  const requested = pathsFor(plan.selectedPaths);
  if (!Array.isArray(plan.entries) || plan.entries.length !== requested.length
    || !isDeepStrictEqual(plan.entries.map(entry => entry.path), requested)) fail("WORKSPACE_TRANSFER_PLAN_INVALID");
  // Recheck every source before creating even the target root. Original read
  // failures are primary, without a different-tool or path fallback.
  for (const entry of plan.entries) {
    check(); sourcePin.verify();
    const reason = excluded(entry.path);
    if (reason) {
      if (entry.status !== "excluded" || entry.reason !== reason) fail("WORKSPACE_TRANSFER_SCOPE_CHANGED");
    } else {
      if (entry.status !== "observed") fail("WORKSPACE_TRANSFER_PLAN_INVALID");
      verifyCopiedProjectFile(source, entry, { signal, assertCurrentAuthority: check });
    }
  }
  check(); parentPin.verify();
  const target = copiedProjectFile(parent, path.basename(plan.target.path));
  if (plan.target.existing && (!fs.existsSync(target) || !isDeepStrictEqual(pin(nativeRoot(target)), plan.target.existing)))
    fail("WORKSPACE_TRANSFER_ROOT_CHANGED");
  if (!fs.existsSync(target)) { check(); fs.mkdirSync(target); }
  const targetPin = pinNativeRoot(target), results = [], ownedStages = [];
  try {
    for (const entry of plan.entries) {
      check(); parentPin.verify(); sourcePin.verify(); targetPin.verify();
      if (entry.status === "excluded") { results.push({ path: entry.path, status: "excluded", reason: entry.reason }); continue; }
      verifyCopiedProjectFile(source, entry, { signal, assertCurrentAuthority: check });
      const file = copiedProjectFile(target, entry.path);
      if (fs.existsSync(file)) {
        const observed = inspectCopiedProjectFile(target, entry.path, { signal, assertCurrentAuthority: check });
        results.push({ path: entry.path, status: observed.sha256 === entry.sha256 && observed.bytes === entry.bytes ? "reused-exact" : "conflict-preserved" });
        continue;
      }
      if (plan.mode === "reuse") fail("WORKSPACE_TRANSFER_REUSE_SOURCE_CHANGED");
      const targetDirectory = path.posix.dirname(entry.path);
      if (targetDirectory !== ".") {
        const directory = copiedProjectFile(target, targetDirectory); check(); fs.mkdirSync(directory, { recursive: true });
        copiedProjectFile(target, targetDirectory);
      }
      const directoryRoot = targetDirectory === "." ? target : copiedProjectFile(target, targetDirectory);
      const directoryPin = pinNativeRoot(directoryRoot), directoryIdentity = pin(directoryRoot);
      const copyCheck = () => { check(); parentPin.verify(); sourcePin.verify(); targetPin.verify(); directoryPin.verify(); };
      const result = { path: entry.path, status: "copy-outcome-unverified" };
      results.push(result);
      copyOriginal(source, target, entry, { targetRelative: entry.path, signal, assertCurrentAuthority: copyCheck,
        onTemporary: owned => {
          ownedStages.push({ ...owned, parent: directoryIdentity, publishedPath: entry.path });
          directoryPin.verify();
        } });
      verifyCopiedProjectFile(target, entry, { signal, assertCurrentAuthority: copyCheck });
      result.status = "copied-exact";
    }
    check(); sourcePin.verify(); targetPin.verify();
    for (const entry of plan.entries) if (entry.status !== "excluded")
      verifyCopiedProjectFile(source, entry, { signal, assertCurrentAuthority: check });
  } catch (error) {
    const cleanup = [];
    for (const owned of ownedStages) {
      try {
        parentPin.verify(); targetPin.verify();
        const parentRelative = path.posix.dirname(owned.path);
        const stageParent = parentRelative === "." ? target : nativeRoot(copiedProjectFile(target, parentRelative));
        if (!isDeepStrictEqual(pin(stageParent), owned.parent)) {
          cleanup.push({ path: owned.path, status: "parent-changed-not-deleted" }); continue;
        }
        const temporary = copiedProjectFile(target, owned.path), stat = fs.lstatSync(temporary, { bigint: true, throwIfNoEntry: false });
        if (!stat) { cleanup.push({ path: owned.path, status: "already-absent" }); continue; }
        if (!stat.isFile() || String(stat.dev) !== owned.dev || String(stat.ino) !== owned.ino
          || String(stat.birthtimeNs) !== owned.birthtimeNs || owned.nlink !== "1") {
          cleanup.push({ path: owned.path, status: "identity-changed-not-deleted" }); continue;
        }
        const destination = fs.lstatSync(copiedProjectFile(target, owned.publishedPath), { bigint: true, throwIfNoEntry: false });
        const publishedOwn = destination?.isFile() && String(destination.dev) === owned.dev && String(destination.ino) === owned.ino;
        if (stat.nlink !== 1n && !(stat.nlink === 2n && publishedOwn)) {
          cleanup.push({ path: owned.path, status: "link-count-changed-not-deleted" }); continue;
        }
        if (error.copyStageUnlinkDenied === true && owned.path === error.incompleteObject) {
          cleanup.push({ path: owned.path, status: "permission-denied-not-retried" }); continue;
        }
        // Cleanup of our exact temporary entry is not an alternative copy or
        // a rollback of any published destination. Never delete by name alone.
        fs.unlinkSync(temporary);
        cleanup.push({ path: owned.path, status: "owned-stage-removed" });
      } catch (cleanupError) {
        cleanup.push({ path: owned.path, status: "cleanup-unverified", code: cleanupError.code || "CLEANUP_FAILED" });
      }
    }
    error.workspaceTransferResult = { status: "workspace-transfer-incomplete", authorityPlane: "P5",
      planDigest: expectedPlanDigest, targetRoot: target, results, primaryFailure: error.code || "WORKSPACE_TRANSFER_FAILED",
      incompleteObject: error.incompleteObject || null, temporaryCleanup: cleanup,
      temporaryCleanupComplete: cleanup.every(row => ["already-absent", "owned-stage-removed"].includes(row.status))
        && (!error.incompleteObject || cleanup.some(row => row.path === error.incompleteObject)),
      overwrittenFiles: 0, grantsRecoveryAuthority: false, grantsExecutionPermission: false };
    throw error;
  }
  return { status: results.some(row => row.status === "conflict-preserved") ? "workspace-transfer-partial"
    : results.some(row => row.status === "excluded") ? "workspace-transfer-with-exclusions" : "workspace-selected-files-verified",
    authorityPlane: "P5", planDigest: expectedPlanDigest, mode: plan.mode, results,
    coverage: "only current selected paths; excluded paths remain excluded", runnableProjectVerified: false,
    overwrittenFiles: 0, modelCalls: 0, grantsRecoveryAuthority: false, grantsExecutionPermission: false };
}
