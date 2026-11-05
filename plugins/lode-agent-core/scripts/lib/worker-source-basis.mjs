import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = (message, code = "INVALID_WORKER_SOURCE_BASIS") => { throw Object.assign(new Error(message), { code }); };

export function workerSourcePathParts(value, storage = undefined) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes(":")) fail("Worker source path must be repository relative.");
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[\u0000-\u001f]/u.test(part)
    || /[. ]$/u.test(part) || [".head", ".git"].includes(part.toLowerCase())) || path.isAbsolute(value)
    || formatForVerifiedOwner(storage).dialect === "lode" && (process.platform === "win32" ? parts[0]?.toLowerCase() : parts[0]) === ".lode") {
    fail("Worker source path escapes the selected source boundary.");
  }
  return parts;
}

function readSource(root, relative, maxBytes, storage) {
  const canonicalRoot = fs.realpathSync(root);
  let file = canonicalRoot;
  for (const part of workerSourcePathParts(relative, storage)) {
    file = path.join(file, part);
    if (fs.lstatSync(file).isSymbolicLink()) fail("Worker source cannot traverse a symbolic link or junction.");
  }
  const resolved = fs.realpathSync(file);
  const inside = path.relative(canonicalRoot, resolved);
  if (inside.startsWith(`..${path.sep}`) || inside === ".." || path.isAbsolute(inside)) fail("Worker source resolved outside the project.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) fail("Worker source is not one bounded regular file.");
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fs.fstatSync(fd);
    const named = fs.lstatSync(file);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || named.isSymbolicLink() || named.ino !== before.ino
      || named.dev !== before.dev || fs.realpathSync(file) !== resolved) {
      fail("Worker source changed while being captured.", "WORKER_SOURCE_BASIS_DRIFT");
    }
    return buffer.subarray(0, length);
  } finally { fs.closeSync(fd); }
}

// A selected byte basis is evidence, not an OS sandbox or an atomic repository
// snapshot. Dirty and untracked files are included exactly when HEAD selects them.
export function captureWorkerSourceBasis({ root, paths = [], maxBytes, storage }) {
  requireByteBound(maxBytes);
  if (!Array.isArray(paths) || paths.length > 256 || new Set(paths).size !== paths.length) fail("Worker source selection is invalid.");
  let remaining = maxBytes;
  return [...paths].sort().map((relative) => {
    const bytes = readSource(root, relative, remaining, storage);
    remaining -= bytes.length;
    return { path: relative, digest: digest(bytes), bytes: bytes.length, contentBase64: bytes.toString("base64") };
  });
}

export function verifyWorkerSourceBasis(basis, maxBytes, storage = undefined) {
  requireByteBound(maxBytes);
  if (!Array.isArray(basis) || basis.length > 256) fail("Worker source basis is invalid.");
  let total = 0;
  for (let index = 0; index < basis.length; index += 1) {
    const item = basis[index];
    if (!item || Object.keys(item).sort().join(",") !== "bytes,contentBase64,digest,path") fail("Worker source entry fields are invalid.");
    workerSourcePathParts(item.path, storage);
    if (index && basis[index - 1].path >= item.path) fail("Worker source paths must be unique and ordered.");
    if (typeof item.contentBase64 !== "string") fail("Worker source bytes are missing.");
    const bytes = Buffer.from(item.contentBase64, "base64");
    total += bytes.length;
    if (bytes.toString("base64") !== item.contentBase64 || bytes.length !== item.bytes
      || digest(bytes) !== item.digest || total > maxBytes) fail("Worker source content does not match its bounded digest.");
  }
  return basis;
}

function requireByteBound(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("Worker source requires an explicit finite byte bound.");
}

export function requireCurrentWorkerSourceBasis({ root, basis, maxBytes, storage }) {
  verifyWorkerSourceBasis(basis, maxBytes, storage);
  for (const source of basis) {
    const bytes = readSource(root, source.path, maxBytes, storage);
    if (bytes.length !== source.bytes || digest(bytes) !== source.digest) {
      fail(`Selected worker source changed: ${source.path}`, "WORKER_SOURCE_BASIS_DRIFT");
    }
  }
}
