import { withSnapshotReferences, withSnapshotReferencesAsync } from "./snapshot-reference-lifetime.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { withProjectMutation } from "./project-mutation-lock.mjs";
import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";

export const REFRESH_WRITER_LEASE_VERSION = "0.1.0";

const fail = (message, code = "REFRESH_WRITER_LEASE_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const HOST = crypto.createHash("sha256").update(os.hostname()).digest("hex").slice(0, 16);
const PUBLICATION_DELAYS_MS = [10, 20, 40, 80];
const pause = new Int32Array(new SharedArrayBuffer(4));

function leaseDirectory(projectRoot, storage = null) {
  return path.join(path.resolve(projectRoot), formatForVerifiedOwner(storage).directory, "refresh", "writer.lock");
}

function ownerFile(projectRoot, storage = null) {
  return path.join(leaseDirectory(projectRoot, storage), "owner.json");
}

function readOwner(projectRoot, storage = null) {
  const file = ownerFile(projectRoot, storage);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`Refresh writer lease owner is invalid JSON: ${error.message}`, "INVALID_REFRESH_WRITER_LEASE"); }
}

function verifyOwner(owner, { projectId = "", token = "", storage = null } = {}) {
  const format = familyFormatForOriginal("head-agent-core-refresh-writer-lease", owner, storage);
  if (!owner || typeof owner !== "object" || Array.isArray(owner)
    || owner.schemaVersion !== 1 || owner.kind !== "RefreshWriterLease"
    || !format
    || owner.protocol?.version !== REFRESH_WRITER_LEASE_VERSION
    || typeof owner.projectId !== "string" || !new RegExp(`^${format.projectPrefix}[a-f0-9]{20}$`).test(owner.projectId)
    || !Number.isInteger(owner.pid) || owner.pid <= 0
    || typeof owner.token !== "string" || !/^[a-f0-9]{32}$/.test(owner.token)
    || typeof owner.startedAt !== "string" || Number.isNaN(Date.parse(owner.startedAt))
    || owner.authority !== "operational-refresh-serialization-only"
    || owner.instructionAuthority !== false || owner.promotionAuthority !== false
    || owner.canonMutationAuthority !== false) {
    fail("Refresh writer lease owner is invalid.", "INVALID_REFRESH_WRITER_LEASE");
  }
  if (projectId && owner.projectId !== projectId) fail("Refresh writer lease belongs to another project.", "REFRESH_WRITER_LEASE_PROJECT_MISMATCH");
  if (token && owner.token !== token) fail("Refresh writer lease token does not match the active owner.", "REFRESH_WRITER_LEASE_TOKEN_MISMATCH");
  return owner;
}

function processState(pid) {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error?.code === "ESRCH") return "absent";
    return "unknown";
  }
}

function statOrAbsent(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function verifyPublicationDirectory(directory, expectedBytes, { allowEmpty = false } = {}) {
  const parent = fs.lstatSync(path.dirname(directory));
  const stat = fs.lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || !stat.isDirectory() || stat.isSymbolicLink()) {
    fail("Refresh publication path is not a safe directory.", "UNSAFE_REFRESH_WRITER_LEASE");
  }
  const entries = fs.readdirSync(directory);
  if (allowEmpty && entries.length === 0) return false;
  if (entries.length !== 1 || entries[0] !== "owner.json") fail("Refresh publication contains unexpected files.", "UNSAFE_REFRESH_WRITER_LEASE");
  const file = path.join(directory, "owner.json");
  const ownerStat = fs.lstatSync(file);
  if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || fs.readFileSync(file, "utf8") !== expectedBytes) {
    fail("Refresh publication owner changed.", "UNSAFE_REFRESH_WRITER_LEASE");
  }
  return true;
}

function publishOwnedDirectory(staging, directory, expectedBytes) {
  let firstError;
  for (let attempt = 0; ; attempt += 1) {
    verifyPublicationDirectory(staging, expectedBytes);
    if (statOrAbsent(directory)) throw Object.assign(new Error("Refresh writer lock exists."), { code: "EEXIST" });
    try {
      fs.renameSync(staging, directory);
      return;
    } catch (error) {
      firstError ||= error;
      const source = statOrAbsent(staging);
      const destination = statOrAbsent(directory);
      if (!source && destination) {
        // A wrapper or OS boundary may report failure after the move happened.
        // Exact owned bytes prove this publication completed; never replay it.
        verifyPublicationDirectory(directory, expectedBytes);
        return;
      }
      if (destination) throw Object.assign(new Error("Refresh writer lock exists."), { code: "EEXIST", cause: error });
      if (!source || process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
      if (attempt >= PUBLICATION_DELAYS_MS.length) throw firstError;
      verifyPublicationDirectory(staging, expectedBytes);
      // Only repeat this unpublished owned rename under the management mutex.
      // 150ms total accommodates Windows sharing contention, not work admission.
      Atomics.wait(pause, 0, 0, PUBLICATION_DELAYS_MS[attempt]);
    }
  }
}

function removeOwnedDirectory(projectRoot, owner, storage = null) {
  const directory = leaseDirectory(projectRoot, storage);
  const file = ownerFile(projectRoot, storage);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Refresh writer lease path is not a safe directory.", "UNSAFE_REFRESH_WRITER_LEASE");
  const stored = verifyOwner(readOwner(projectRoot, storage), { projectId: owner.projectId, token: owner.token, storage });
  if (stored.pid !== owner.pid) fail("Refresh writer lease PID changed before release.", "REFRESH_WRITER_LEASE_TOKEN_MISMATCH");
  const entries = fs.readdirSync(directory).sort();
  if (entries.length !== 1 || entries[0] !== "owner.json") fail("Refresh writer lease contains unexpected files.", "UNSAFE_REFRESH_WRITER_LEASE");
  fs.unlinkSync(file);
  fs.rmdirSync(directory);
}

function recoverDeadOwner(projectRoot, projectId, storage = null) {
  const directory = leaseDirectory(projectRoot, storage);
  if (!fs.existsSync(directory)) return false;
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Refresh writer lease path is not a safe directory.", "UNSAFE_REFRESH_WRITER_LEASE");
  if (fs.readdirSync(directory).length === 0) {
    // No operation can acquire the new lease before its populated directory is
    // published. Under the management lock an empty directory is an interrupted
    // legacy publication or release, and contains no recovery or owner record.
    fs.rmdirSync(directory);
    return true;
  }
  const owner = verifyOwner(readOwner(projectRoot, storage), { projectId, storage });
  if (owner.hostIdentity !== HOST) fail("Refresh writer owner is from another or unverified Host.", "REFRESH_WRITER_BUSY");
  const state = processState(owner.pid);
  if (state !== "absent") {
    fail(`Refresh writer is already active or cannot be proven absent (pid ${owner.pid}).`, "REFRESH_WRITER_BUSY");
  }
  removeOwnedDirectory(projectRoot, owner, storage);
  return true;
}

function acquire({ projectRoot, projectId, storage = null }) {
  const format = formatForVerifiedOwner(storage);
  const directory = leaseDirectory(projectRoot, storage);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  for (const name of fs.readdirSync(path.dirname(directory))) {
    const match = /^writer\.lock\.([a-f0-9]{16})\.([1-9][0-9]*)\.([a-f0-9]{32})\.staging$/.exec(name);
    if (!match || match[1] !== HOST || processState(Number(match[2])) !== "absent") continue;
    const staging = path.join(path.dirname(directory), name);
    const stat = fs.lstatSync(staging);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Refresh staging path is unsafe.", "UNSAFE_REFRESH_WRITER_LEASE");
    const entries = fs.readdirSync(staging);
    if (entries.some((entry) => entry !== "owner.json")) fail("Refresh staging contains unexpected files.", "UNSAFE_REFRESH_WRITER_LEASE");
    if (entries.length) {
      // This path was never published or used as a lease. Its exact Host/PID/
      // nonce name proves cleanup ownership even if wx write stopped midway.
      fs.unlinkSync(path.join(staging, "owner.json"));
    }
    fs.rmdirSync(staging);
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (fs.existsSync(directory)) throw Object.assign(new Error("Refresh writer lock exists."), { code: "EEXIST" });
      const owner = {
        schemaVersion: 1,
        kind: "RefreshWriterLease",
        protocol: { name: format.protocol("head-agent-core-refresh-writer-lease"), version: REFRESH_WRITER_LEASE_VERSION },
        projectId,
        pid: process.pid,
        hostIdentity: HOST,
        token: crypto.randomBytes(16).toString("hex"),
        startedAt: new Date().toISOString(),
        authority: "operational-refresh-serialization-only",
        instructionAuthority: false,
        promotionAuthority: false,
        canonMutationAuthority: false,
      };
      const staging = `${directory}.${HOST}.${owner.pid}.${owner.token}.staging`;
      const ownerBytes = json(owner);
      let publicationError = null;
      try {
        fs.mkdirSync(staging);
        fs.writeFileSync(path.join(staging, "owner.json"), ownerBytes, { encoding: "utf8", flag: "wx" });
        publishOwnedDirectory(staging, directory, ownerBytes);
        return owner;
      } catch (error) {
        publicationError = error;
        throw error;
      } finally {
        try {
          if (statOrAbsent(staging)) {
            if (verifyPublicationDirectory(staging, ownerBytes, { allowEmpty: true })) fs.unlinkSync(path.join(staging, "owner.json"));
            fs.rmdirSync(staging);
          }
        } catch (cleanupError) {
          if (!publicationError) throw cleanupError;
          publicationError.cleanupFailure = { code: cleanupError.code, message: cleanupError.message };
        }
      }
    } catch (error) {
      if (error?.code !== "EEXIST" || error.cleanupFailure) throw error;
      if (attempt === 0 && recoverDeadOwner(projectRoot, projectId, storage)) continue;
      fail("Refresh writer is already active.", "REFRESH_WRITER_BUSY");
    }
  }
  fail("Refresh writer lease could not be acquired.", "REFRESH_WRITER_BUSY");
}

export function verifyRefreshWriterLease({ projectRoot, projectId, lease, storage = null }) {
  const owner = verifyOwner(lease, { projectId, token: lease?.token || "", storage });
  if (owner.pid !== process.pid) fail("Refresh writer lease is not owned by this process.", "REFRESH_WRITER_LEASE_NOT_OWNED");
  const stored = verifyOwner(readOwner(projectRoot, storage), { projectId, token: owner.token, storage });
  if (stored.pid !== owner.pid) fail("Refresh writer lease PID does not match its stored owner.", "REFRESH_WRITER_LEASE_NOT_OWNED");
  return lease;
}

async function withRefreshWriterLeaseUncoordinated({ projectRoot, projectId, lease = null, storage = null }, operation) {
  if (typeof operation !== "function") fail("Refresh writer lease requires an operation.", "INVALID_REFRESH_WRITER_LEASE_OPERATION");
  if (lease) {
    verifyRefreshWriterLease({ projectRoot, projectId, lease, storage });
    return operation(lease);
  }
  const acquired = withProjectMutation({ root: projectRoot, storage, scope: "refresh-lock-management" }, () => acquire({ projectRoot, projectId, storage }));
  try {
    return await operation(acquired);
  } finally {
    withProjectMutation({ root: projectRoot, storage, scope: "refresh-lock-management" }, () => removeOwnedDirectory(projectRoot, acquired, storage));
  }
}

export function inspectRefreshWriterLease({ projectRoot, projectId, storage = null }) {
  const directory = leaseDirectory(projectRoot, storage);
  if (!fs.existsSync(directory)) return { status: "idle", leaseDirectory: directory };
  const owner = verifyOwner(readOwner(projectRoot, storage), { projectId, storage });
  return {
    status: processState(owner.pid) === "alive" ? "active" : "stale-or-unknown",
    leaseDirectory: directory,
    owner: { pid: owner.pid, startedAt: owner.startedAt, protocol: owner.protocol },
  };
}

export async function withRefreshWriterLease(options = {}, ...rest) {
  return withSnapshotReferencesAsync({ root: options.projectRoot ?? ".", storage: options.storage }, () => withRefreshWriterLeaseUncoordinated(options, ...rest));
}
