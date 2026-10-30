import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { AsyncLocalStorage } from "node:async_hooks";
import { withLocalMutation } from "./project-mutation-lock.mjs";
import { resolveProjectStorage, assertProjectStorageUnchanged } from "./project-storage-format.mjs";
import { classifySnapshotFileSystem } from "./snapshot-filesystem.mjs";

// Transient cooperative local P5 only. No Session selection, direction or lease
// authority. Admission protects registration/one unlink, never a whole scan.
const context = new AsyncLocalStorage();
const host = crypto.createHash("sha256").update(os.hostname()).digest("hex");
// Stable for this Node process, including repeated module loads. This is the
// runtime's origin, not an independently queried OS CreationDate or liveness
// proof. Never reclaim another owner's state from PID/age guesses.
const processBirth = performance.timeOrigin;
const fail = (message, code = "SNAPSHOT_REFERENCE_COORDINATION_UNAVAILABLE") => {
  throw Object.assign(new Error(message), { code, retryable: true });
};
function namespace(root, supplied) {
  const storage = supplied?.projectFile ? supplied : resolveProjectStorage(root);
  // No owned Project means no eligible collector. Initialization retains its
  // existing behavior; this is not a fallback after registration failure.
  if (!storage?.projectFile) return null;
  assertProjectStorageUnchanged(storage);
  const projectRoot = fs.realpathSync(path.resolve(root));
  if (projectRoot !== storage.projectRoot) fail("Snapshot coordination Project changed.");
  const base = path.join(projectRoot, storage.directory);
  const excludedReason = /^(?:\\\\|\/\/)/.test(projectRoot) ? "UNSUPPORTED_SHARED_STORAGE"
    : !["win32", "linux"].includes(process.platform) ? "UNSUPPORTED_GC_PLATFORM"
      : process.platform === "linux" && classifySnapshotFileSystem({ platform: "linux", type: fs.statfsSync(projectRoot).type }) !== "qualified-local"
        ? "UNSUPPORTED_OR_UNKNOWN_GC_FILESYSTEM" : null;
  return { storage, projectRoot, base, excludedReason, directory: path.join(base, ".snapshot-gc"),
    admission: path.join(base, ".operations", "snapshot-reference-admission.lock") };
}
function safeDirectory(directory, create = false) {
  if (create) fs.mkdirSync(directory, { recursive: true });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Unsafe snapshot coordination directory.");
}
function prepare(ns) {
  safeDirectory(ns.base);
  safeDirectory(ns.directory, true);
  safeDirectory(path.join(ns.directory, "participants"), true);
}
function retainedBackend(ns) {
  // A malformed placeholder store is not made collectable merely by existing.
  // Valid Git/domain/source backends now participate in the supported closure.
  safeDirectory(ns.base);
  const directory=path.join(ns.base,"snapshot-objects.git");
  if(fs.existsSync(directory)) {
    safeDirectory(directory);
    if(!fs.existsSync(path.join(directory,"lode-owner.json"))||!fs.existsSync(path.join(directory,"config")))return {path:directory,reasonCode:"UNVERIFIED_GC_GIT_BACKEND"};
  }
  return null;
}
function assertNoEligiblePriorAttempt(ns) {
  const stat = fs.lstatSync(ns.directory, { throwIfNoEntry: false });
  if (!stat) return;
  safeDirectory(ns.directory);
  for (const name of attempts(ns)) {
    const nonce = name.slice(8, -5);
    verifyOwner(ns, original(path.join(ns.directory, name)), nonce);
    const cancel = path.join(ns.directory, `cancel-${nonce}.json`);
    if (!fs.existsSync(cancel)) fail("An earlier snapshot collection attempt is not cancelled.");
    const latch = original(cancel);
    if (latch.nonce !== nonce || latch.invalidated !== true) fail("Earlier snapshot cancellation cannot be verified.");
  }
}
function admission(ns, operation, timeoutMs = 10_000) {
  assertProjectStorageUnchanged(ns.storage);
  return withLocalMutation({ directory: ns.admission, timeoutMs }, () => {
    assertProjectStorageUnchanged(ns.storage);
    prepare(ns);
    return operation();
  });
}
function original(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) fail("Unsafe snapshot coordination owner.");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function attempts(ns) {
  const names = fs.readdirSync(ns.directory);
  if(names.includes("staging"))safeDirectory(path.join(ns.directory,"staging"));
  if (names.some(name => name !== "participants" && name !== "staging" && !/^(?:attempt|cancel)-[a-f0-9]{32}\.json$/.test(name))) fail("Unknown snapshot coordination state.");
  return names.filter(name => name.startsWith("attempt-"));
}
function owner(ns, nonce) {
  return { schemaVersion: 1, projectId: ns.storage.projectId, nonce, host, pid: process.pid,
    processBirth, processBirthBasis: "node-runtime-time-origin" };
}
function verifyOwner(ns, document, nonce) {
  if (document?.schemaVersion !== 1 || document.projectId !== ns.storage.projectId || document.nonce !== nonce
    || document.host !== host || !Number.isSafeInteger(document.pid) || document.pid < 1
    || !Number.isFinite(document.processBirth) || document.processBirth <= 0
    || document.processBirthBasis !== "node-runtime-time-origin") fail("Unknown snapshot coordination ownership.");
  return document;
}
function invalidate(ns) {
  for (const name of attempts(ns)) {
    const nonce = name.slice(8, -5);
    verifyOwner(ns, original(path.join(ns.directory, name)), nonce);
    const file = path.join(ns.directory, `cancel-${nonce}.json`);
    const body = JSON.stringify({ nonce, invalidated: true });
    try { fs.writeFileSync(file, body, { flag: "wx" }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = original(file);
      if (existing.nonce !== nonce || existing.invalidated !== true) fail("Invalid snapshot cancellation latch.");
    }
  }
}
function begin(root, storage) {
  const ns = namespace(root, storage);
  if (!ns) return null;
  const inherited = context.getStore()?.get(ns.base);
  if (inherited) {
    // A detached callback must reacquire its originals, not merely acquire a
    // fresh token around stale cached references. Fail before its effect.
    if (!inherited.active) fail("Snapshot reference lifetime ended; reacquire exact originals in a fresh operation.", "SNAPSHOT_REFERENCE_LIFETIME_EXPIRED");
    assertProjectStorageUnchanged(inherited.ns.storage);
    const actual = verifyOwner(ns, original(inherited.file), inherited.nonce);
    if (actual.pid !== process.pid || actual.processBirth !== processBirth) fail("Snapshot reference owner changed.");
    inherited.references += 1;
    return inherited;
  }
  if (ns.excludedReason) return null; // Same static exclusion used by every current collector.
  // Only a structurally unowned placeholder is statically excluded. Valid
  // mixed backends enroll publishers and are verified by the collector; a
  // momentary absence of GC never permits unguarded publication.
  if (retainedBackend(ns)) { assertNoEligiblePriorAttempt(ns); return null; }
  return admission(ns, () => {
    invalidate(ns);
    const nonce = crypto.randomBytes(16).toString("hex");
    const file = path.join(ns.directory, "participants", `${nonce}.json`);
    fs.writeFileSync(file, JSON.stringify(owner(ns, nonce)), { flag: "wx" });
    return { ns, nonce, file, active: true, references: 1 };
  });
}
function release(token) {
  if (!token || --token.references) return;
  token.active = false;
  const actual = verifyOwner(token.ns, original(token.file), token.nonce);
  if (actual.pid !== process.pid || actual.processBirth !== processBirth) fail("Snapshot reference owner changed.");
  fs.unlinkSync(token.file);
}
function run(token, operation) {
  if (!token) return operation();
  const active = new Map(context.getStore() || []);
  active.set(token.ns.base, token);
  return context.run(active, operation);
}
function releaseAfterOperation(token, { failed, primaryError, completed }) {
  try { release(token); }
  catch (error) {
    if (failed) {
      if (primaryError && typeof primaryError === "object") {
        try { primaryError.snapshotReferenceCleanup = { code: error.code || "SNAPSHOT_REFERENCE_RELEASE_FAILED" }; } catch { /* Preserve the primary error even when frozen. */ }
      }
    } else {
      error.operationCompleted = completed;
      error.phase = "snapshot-reference-release";
      throw error;
    }
  }
}
export function withSnapshotReferences({ root = ".", storage } = {}, operation) {
  let token;
  try { token = begin(root, storage); } catch (error) { error.retryable = true; throw error; }
  let failed = false, primaryError, completed = false;
  try {
    const result = run(token, operation);
    if (result && typeof result.then === "function") fail("Asynchronous snapshot publication requires its awaited lifetime.", "INVALID_SNAPSHOT_REFERENCE_OPERATION");
    completed = true;
    return result;
  } catch (error) { failed = true; primaryError = error; throw error; }
  finally { releaseAfterOperation(token, { failed, primaryError, completed }); }
}
export async function withSnapshotReferencesAsync({ root = ".", storage } = {}, operation) {
  let token;
  try { token = begin(root, storage); } catch (error) { error.retryable = true; throw error; }
  let failed = false, primaryError, completed = false;
  try { const result = await run(token, operation); completed = true; return result; }
  catch (error) { failed = true; primaryError = error; throw error; }
  finally { releaseAfterOperation(token, { failed, primaryError, completed }); }
}

export function beginSnapshotCollection({ root = ".", storage } = {}) {
  const ns = namespace(root, storage);
  if (!ns) return { status: "preserved", reasonCode: "NOT_INITIALIZED" };
  if (ns.excludedReason) return { status: "preserved", reasonCode: ns.excludedReason };
  try {
    const excluded = retainedBackend(ns);
    if (excluded) return { status: "preserved", reasonCode: excluded.reasonCode };
    return admission(ns, () => {
      if (attempts(ns).length || fs.readdirSync(ns.directory).some(name => name.startsWith("cancel-"))
        || fs.readdirSync(path.join(ns.directory, "participants")).length || fs.existsSync(path.join(ns.directory,"staging")) && fs.readdirSync(path.join(ns.directory,"staging")).length) return { status: "yielded", reasonCode: "ACTIVE_OR_UNKNOWN_SNAPSHOT_OPERATION" };
      const nonce = crypto.randomBytes(16).toString("hex");
      const file = path.join(ns.directory, `attempt-${nonce}.json`);
      fs.writeFileSync(file, JSON.stringify(owner(ns, nonce)), { flag: "wx" });
      return { status: "active", ns, nonce, file };
    }, 0);
  } catch (error) { return { status: "preserved", reasonCode: error.code || "SNAPSHOT_COORDINATION_UNAVAILABLE" }; }
}
export function snapshotCollectionCancelled(attempt) {
  try {
    verifyOwner(attempt.ns, original(attempt.file), attempt.nonce);
    return fs.existsSync(path.join(attempt.ns.directory, `cancel-${attempt.nonce}.json`));
  } catch { return true; }
}
export function withSnapshotCollectionUnlink(attempt, operation) {
  return admission(attempt.ns, () => {
    const actual = verifyOwner(attempt.ns, original(attempt.file), attempt.nonce);
    if (actual.pid !== process.pid || actual.processBirth !== processBirth || fs.existsSync(path.join(attempt.ns.directory, `cancel-${attempt.nonce}.json`))
      || fs.readdirSync(path.join(attempt.ns.directory, "participants")).length) fail("Snapshot collection yielded to ordinary work.", "SNAPSHOT_COLLECTION_INVALIDATED");
    return operation(Object.freeze(actual));
  }, 0);
}
export function finishSnapshotCollection(attempt) {
  if (attempt?.status !== "active") return;
  admission(attempt.ns, () => {
    const actual = verifyOwner(attempt.ns, original(attempt.file), attempt.nonce);
    if (actual.pid !== process.pid || actual.processBirth !== processBirth) fail("Snapshot collection ownership changed.");
    fs.unlinkSync(attempt.file);
    const cancel = path.join(attempt.ns.directory, `cancel-${attempt.nonce}.json`);
    if (fs.existsSync(cancel)) {
      const document = original(cancel);
      if (document.nonce !== attempt.nonce || document.invalidated !== true) fail("Snapshot cancellation identity changed.");
      fs.unlinkSync(cancel);
    }
  });
}
