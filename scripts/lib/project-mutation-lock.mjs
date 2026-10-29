import { withSnapshotReferences, withSnapshotReferencesAsync } from "./snapshot-reference-lifetime.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { resolveProjectStorage, formatForVerifiedOwner, assertProjectStorageUnchanged } from "./project-storage-format.mjs";

// Local P5 serialization only. These transient files never supply project
// direction, survive as Canon, or lock ordinary read-only work.
const context = new AsyncLocalStorage();
const pause = new Int32Array(new SharedArrayBuffer(4));
const WAIT_MS = 10_000;
const READ_ATTEMPTS = 6;
const READ_RETRY_MS = 10;
const HOST = crypto.createHash("sha256").update(os.hostname()).digest("hex").slice(0, 16);
const OWNER = /^owner-([a-f0-9]{16})-([1-9][0-9]*)-([a-f0-9]{32})\.json$/;

function fail(message, code = "PROJECT_MUTATION_BUSY") {
  throw Object.assign(new Error(message), { code });
}

function lockFor(root, scope, storage) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(scope)) fail("Invalid mutation scope.", "INVALID_PROJECT_MUTATION_SCOPE");
  const canonicalRoot = fs.realpathSync(path.resolve(root));
  const headRoot = path.join(canonicalRoot, formatForVerifiedOwner(storage).directory);
  if (!fs.existsSync(headRoot)) fail("Lode Agent Core is not initialized.", "NOT_INITIALIZED");
  retryLockRead(() => safeDirectory(headRoot));
  return path.join(headRoot, ".operations", `${scope}.lock`);
}

function safeDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Unsafe mutation lock path.", "INVALID_PROJECT_MUTATION_LOCK");
  return stat;
}

function retryLockRead(read) {
  // Windows can deny an enumeration while a competing owner removes its
  // directory. Errno alone cannot distinguish that from persistent ACL denial.
  // Retry only pre-effect reads, finitely, preserving the first original error.
  let firstError;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    try { return read(); }
    catch (error) {
      if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
      firstError ??= error;
      if (attempt === READ_ATTEMPTS - 1) throw firstError;
      Atomics.wait(pause, 0, 0, READ_RETRY_MS);
    }
  }
}

function readLockPath(directory, target, read) {
  return retryLockRead(() => {
    // Revalidate the complete lock namespace on every read attempt. Never
    // convert an unsafe replacement into transient contention.
    const parent = path.dirname(directory);
    safeDirectory(path.dirname(parent));
    safeDirectory(parent);
    if (target !== parent) safeDirectory(target);
    return read();
  });
}

function lockEntries(directory, target = directory) {
  return readLockPath(directory, target, () => fs.readdirSync(target));
}

function absent(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === "ESRCH"; }
}

function release(owner) {
  // Never unlink a generic owner path: another process may already have
  // acquired a new directory after a stale-owner cleanup.
  try { fs.unlinkSync(owner.file); }
  catch (error) { if (error.code !== "ENOENT") throw error; return; }
  try { fs.rmdirSync(owner.directory); }
  catch (error) {
    // Ownership is already released by the exact nonce unlink. A succeeding
    // writer (or a Windows enumeration handle) may prevent directory removal;
    // never turn a committed operation into failure for this empty-shell cleanup.
    if (!new Set(["ENOENT", "ENOTEMPTY", "EEXIST", "EPERM", "EACCES"]).has(error.code)) throw error;
  }
  // The parent is a shared namespace, not this owner's lease. Keep its single
  // empty directory: another process may already be creating a sibling lock.
}

function attempt(directory) {
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  try { readLockPath(directory, path.dirname(directory), () => {}); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (fs.existsSync(directory)) {
    try {
      const files = lockEntries(directory);
      for (const name of files) {
        const match = OWNER.exec(name);
        if (!match) fail("Unexpected mutation lock entry.", "INVALID_PROJECT_MUTATION_LOCK");
        if (match[1] === HOST && absent(Number(match[2]))) release({ directory, file: path.join(directory, name) });
      }
      if (files.length) return null;
      // Empty means a released owner was removed before rmdir. A populated
      // owner is always published atomically; rmdir cannot remove a new owner.
      try { fs.rmdirSync(directory); }
      catch (error) { if (!new Set(["ENOENT", "ENOTEMPTY", "EEXIST", "EPERM", "EACCES"]).has(error.code)) throw error; }
      return null;
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  const name = `owner-${HOST}-${process.pid}-${crypto.randomBytes(16).toString("hex")}.json`;
  const staging = path.join(path.dirname(directory), `.${path.basename(directory)}-${name}.staging`);
  const owner = { directory, file: path.join(directory, name) };
  let publishing = false;
  try {
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, name), JSON.stringify({ pid: process.pid, parentPid: process.ppid, scope: path.basename(directory), authorityPlane: "P5", recoveryAuthority: false }), { flag: "wx" });
    // Publish a fully populated directory. The visible lock never has a gap
    // without owner identity, even when the publishing process exits abruptly.
    publishing = true;
    fs.renameSync(staging, directory);
    return owner;
  } catch (error) {
    if (error.code === "ENOENT" || publishing && new Set(["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"]).has(error.code) || fs.existsSync(directory)) return null;
    throw error;
  } finally {
    if (fs.existsSync(staging)) {
      try { fs.unlinkSync(path.join(staging, name)); } catch (error) { if (error.code !== "ENOENT") throw error; }
      try { fs.rmdirSync(staging); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
}

function cleanInterruptedStaging(directory) {
  const parent = path.dirname(directory);
  if (!fs.existsSync(parent)) return;
  let files;
  try {
    files = lockEntries(directory, parent);
  } catch (error) { if (error.code === "ENOENT") return; throw error; }
  const prefix = `.${path.basename(directory)}-`;
  for (const name of files) {
    if (!name.startsWith(prefix) || !name.endsWith(".staging")) continue;
    const ownerName = name.slice(prefix.length, -".staging".length);
    const match = OWNER.exec(ownerName);
    if (!match || match[1] !== HOST || !absent(Number(match[2]))) continue;
    const staging = path.join(parent, name);
    try {
      const entries = lockEntries(directory, staging);
      if (entries.some((entry) => entry !== ownerName)) fail("Unexpected staged mutation lock entry.", "INVALID_PROJECT_MUTATION_LOCK");
      if (entries.length) release({ directory: staging, file: path.join(staging, ownerName) });
      else fs.rmdirSync(staging);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function nestedOwner(directory) {
  const owner = context.getStore()?.get(directory);
  if (owner && fs.existsSync(owner.file)) return owner;
  return null;
}

// Private Host state can reuse the same nonce-owned serialization without
// creating a Project operation or making optional delivery a recovery gate.
export function withLocalMutation({ directory, timeoutMs = WAIT_MS }, operation) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)
    || !Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > WAIT_MS) fail("Invalid local mutation lock.", "INVALID_PROJECT_MUTATION_SCOPE");
  if (nestedOwner(directory)) return operation();
  cleanInterruptedStaging(directory);
  const deadline = Date.now() + timeoutMs;
  let owner;
  while (!(owner = attempt(directory))) {
    // A synchronous caller cannot wait for an unrelated async owner in this
    // event loop: doing so would prevent that owner from releasing its lock.
    try {
      if (lockEntries(directory).some((name) => {
        const match = OWNER.exec(name);
        return match?.[1] === HOST && match[2] === String(process.pid);
      })) {
        fail(`The ${path.basename(directory, ".lock")} operation is active in this process; retry shortly.`);
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (Date.now() >= deadline) fail(`The ${path.basename(directory, ".lock")} operation is busy; retry this operation shortly.`);
    Atomics.wait(pause, 0, 0, 10);
  }
  try {
    const active = new Map(context.getStore() || []);
    active.set(directory, owner);
    const result = context.run(active, operation);
    if (result && typeof result.then === "function") fail("Use the asynchronous mutation coordinator for asynchronous operations.", "INVALID_PROJECT_MUTATION_OPERATION");
    return result;
  } finally { release(owner); }
}

function withProjectMutationUncoordinated({ root = ".", scope, storage, timeoutMs }, operation) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(scope)) fail("Invalid mutation scope.", "INVALID_PROJECT_MUTATION_SCOPE");
  storage ??= resolveProjectStorage(root);
  const recheck = () => { if (storage?.projectFile) assertProjectStorageUnchanged(storage); };
  recheck();
  return withLocalMutation({ directory: lockFor(root, scope, storage), timeoutMs }, () => { recheck(); return operation(); });
}

async function withProjectMutationAsyncUncoordinated({ root = ".", scope, storage }, operation) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(scope)) fail("Invalid mutation scope.", "INVALID_PROJECT_MUTATION_SCOPE");
  storage ??= resolveProjectStorage(root);
  const recheck = () => { if (storage?.projectFile) assertProjectStorageUnchanged(storage); };
  recheck();
  const directory = lockFor(root, scope, storage);
  if (nestedOwner(directory)) return operation();
  cleanInterruptedStaging(directory);
  const deadline = Date.now() + WAIT_MS;
  let owner;
  while (!(owner = attempt(directory))) {
    if (Date.now() >= deadline) fail(`The ${scope} operation is busy; retry this operation shortly.`);
    await delay(10);
  }
  try {
    recheck();
    const active = new Map(context.getStore() || []);
    active.set(directory, owner);
    return await context.run(active, operation);
  } finally { release(owner); }
}

function prepareProjectMutation(options) {
  const { root = ".", scope } = options;
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(scope)) fail("Invalid mutation scope.", "INVALID_PROJECT_MUTATION_SCOPE");
  const storage = options.storage ?? resolveProjectStorage(root);
  const directory = lockFor(root, scope, storage);
  // Preserve the existing pure namespace/input errors before registering the
  // additional snapshot lifetime. A damaged lock path is never contention.
  for (const file of [path.dirname(directory), directory]) retryLockRead(() => {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail("Unsafe mutation lock path.", "INVALID_PROJECT_MUTATION_LOCK");
  });
  return { ...options, root, storage };
}

export function withProjectMutation(options = {}, ...rest) {
  const prepared = prepareProjectMutation(options);
  return withSnapshotReferences({ root: prepared.root, storage: prepared.storage }, () => withProjectMutationUncoordinated(prepared, ...rest));
}

export async function withProjectMutationAsync(options = {}, ...rest) {
  const prepared = prepareProjectMutation(options);
  return withSnapshotReferencesAsync({ root: prepared.root, storage: prepared.storage }, () => withProjectMutationAsyncUncoordinated(prepared, ...rest));
}
