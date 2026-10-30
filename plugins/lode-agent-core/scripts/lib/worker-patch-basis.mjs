import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { captureWorkerSourceBasis, verifyWorkerSourceBasis, workerSourcePathParts } from "./worker-source-basis.mjs";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = message => { throw Object.assign(new Error(message), { code: "WORKER_PATCH_CONFLICT" }); };
const key = value => process.platform === "win32" ? value.toLowerCase() : value;
function pathsChecked(paths, storage) {
  if (!Array.isArray(paths) || paths.length > 256) fail("Write basis exceeds its path bound.");
  const seen = new Set();
  for (const relative of paths) {
    const parts = workerSourcePathParts(relative, storage);
    if (process.platform === "win32" && parts.some(part => /[<>"|?*]/u.test(part)
      || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))) fail("Write path has a platform alias.");
    if (seen.has(key(relative))) fail("Write ownership contains duplicate or aliased paths.");
    seen.add(key(relative));
  }
  for (const relative of seen) {
    const parts = relative.split("/");
    for (let i = 1; i < parts.length; i++) if (seen.has(parts.slice(0, i).join("/"))) fail("Write ownership overlaps a parent file.");
  }
}
function fields(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...names].sort())) fail("Invalid patch basis fields.");
}
function byteBound(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail("Patch basis needs a finite byte bound.");
}
function observe(root, relative, maxBytes, storage) {
  const parts = workerSourcePathParts(relative, storage);
  let cursor = fs.realpathSync(root);
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]);
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (!stat) return { path: relative, kind: "absent" };
    if (stat.isSymbolicLink()) fail("Patch path traverses a symbolic link or junction.");
    if (i < parts.length - 1) {
      if (!stat.isDirectory()) fail("Patch parent is not a directory.");
      continue;
    }
    if (!stat.isFile() || stat.nlink !== 1) fail("Patch target is not an unaliased regular file.");
    const [source] = captureWorkerSourceBasis({ root, paths: [relative], maxBytes, storage });
    const after = fs.lstatSync(cursor);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.mode !== stat.mode
      || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) fail("Patch basis changed during capture.");
    return { path: relative, kind: "file", mode: stat.mode & 0o777, ...source };
  }
}

// P3 candidate input, not a mutation or permission. Absence and file mode are
// explicit: missing bytes are never treated as an empty existing file.
export function captureWorkerWriteBasis({ root, paths, maxBytes, storage }) {
  byteBound(maxBytes);
  pathsChecked(paths, storage);
  let remaining = maxBytes;
  return [...paths].sort().map(relative => {
    const entry = observe(root, relative, remaining, storage);
    remaining -= entry.bytes || 0;
    return entry;
  });
}

export function verifyWorkerWriteBasis(basis, maxBytes, storage = undefined) {
  byteBound(maxBytes);
  if (!Array.isArray(basis)) fail("Invalid write basis.");
  pathsChecked(basis.map(entry => entry?.path), storage);
  let total = 0;
  for (let i = 0; i < basis.length; i++) {
    const entry = basis[i];
    if (i && basis[i - 1].path >= entry.path) fail("Write basis paths must be ordered.");
    if (entry.kind === "absent") fields(entry, ["path", "kind"]);
    else if (entry.kind === "file") {
      fields(entry, ["path", "kind", "mode", "digest", "bytes", "contentBase64"]);
      if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) fail("Invalid file mode.");
      const { kind, mode, ...source } = entry;
      verifyWorkerSourceBasis([source], maxBytes - total, storage);
      total += source.bytes;
    } else fail("Unsupported write basis type.");
  }
  return basis;
}

export function requireCurrentWorkerWriteBasis({ root, basis, maxBytes, storage }) {
  verifyWorkerWriteBasis(basis, maxBytes, storage);
  const current = captureWorkerWriteBasis({ root, paths: basis.map(entry => entry.path), maxBytes, storage });
  if (JSON.stringify(current) !== JSON.stringify(basis)) fail("Selected worker write preimage changed.");
}

function afterImage(relative, value, maxBytes) {
  if (value === null) return { path: relative, kind: "absent" };
  fields(value, ["contentBase64", "mode"]);
  if (typeof value.contentBase64 !== "string" || !Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o777) fail("Invalid patch postimage.");
  const bytes = Buffer.from(value.contentBase64, "base64");
  if (bytes.toString("base64") !== value.contentBase64 || bytes.length > maxBytes) fail("Patch postimage exceeds its exact byte bound.");
  return { path: relative, kind: "file", mode: value.mode, digest: hash(bytes), bytes: bytes.length, contentBase64: value.contentBase64 };
}
const sameImage = (left, right) => left.kind === right.kind && (left.kind === "absent"
  || left.mode === right.mode && left.digest === right.digest && left.bytes === right.bytes);

export function buildWorkerPatchCandidate({ basis, changes, maxBytes, storage }) {
  verifyWorkerWriteBasis(basis, maxBytes, storage);
  if (!Array.isArray(changes)) fail("Patch changes must be an array.");
  pathsChecked(changes.map(change => change?.path), storage);
  let remaining = maxBytes;
  const patches = [...changes].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(change => {
    fields(change, ["path", "after"]);
    const before = basis.find(entry => entry.path === change.path);
    if (!before) fail("Patch changes an unowned path.");
    const after = afterImage(change.path, change.after, remaining);
    remaining -= after.bytes || 0;
    return { before, after };
  }).filter(patch => !sameImage(patch.before, patch.after));
  const payload = { kind: "WorkerPatchCandidate", protocolVersion: "0.1.0", basis, patches, maxBytes,
    instructionAuthority: false, promotionAuthority: false, recoveryAuthority: false };
  const candidateHash = hash(JSON.stringify(payload));
  return { ...payload, candidateId: `worker-patch-${candidateHash.slice(0, 24)}`, candidateHash };
}

export function verifyWorkerPatchCandidate(candidate, storage = undefined) {
  fields(candidate, ["kind", "protocolVersion", "basis", "patches", "maxBytes", "instructionAuthority", "promotionAuthority", "recoveryAuthority", "candidateId", "candidateHash"]);
  if (!Array.isArray(candidate.patches)) fail("Invalid patch list.");
  const expected = buildWorkerPatchCandidate({ basis: candidate.basis, maxBytes: candidate.maxBytes, storage,
    changes: candidate.patches.map(patch => {
      fields(patch, ["before", "after"]);
      return { path: patch.after?.path, after: patch.after?.kind === "absent" ? null
        : { contentBase64: patch.after?.contentBase64, mode: patch.after?.mode } };
    }) });
  if (JSON.stringify(expected) !== JSON.stringify(candidate)) fail("Patch candidate differs from its exact basis or digest.");
  return candidate;
}

// Read-only per-path reconciliation. This is not a claim of atomic CAS, applied
// ownership, semantic correctness, combined tests, or a finished Run.
export function inspectWorkerPatchCandidate({ root, candidate, storage }) {
  verifyWorkerPatchCandidate(candidate, storage);
  const paths = candidate.patches.map(({ before, after }) => {
    let observed;
    try { observed = observe(root, before.path, candidate.maxBytes, storage); }
    catch (error) {
      if (!["WORKER_PATCH_CONFLICT", "INVALID_WORKER_SOURCE_BASIS", "WORKER_SOURCE_BASIS_DRIFT", "ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) throw error;
      return { path: before.path, status: "conflict", reason: "unverifiable-target", code: error.code };
    }
    return { path: before.path, status: sameImage(observed, after) ? "postimage-present"
      : sameImage(observed, before) ? "preimage-present" : "conflict", observed };
  });
  return { candidateId: candidate.candidateId, paths, hasConflicts: paths.some(item => item.status === "conflict"),
    allPostimagesPresent: paths.every(item => item.status === "postimage-present"), appliedByThisOperation: false,
    recoveryAuthority: false, semanticVerification: "not-assessed" };
}
