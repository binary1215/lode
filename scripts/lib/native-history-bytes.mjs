import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { copiedProjectFile } from "./project-copy-evidence.mjs";
import { SNAPSHOT_STORAGE_LIMITS } from "./snapshot-storage-codec.mjs";

// Whole histories are not JSON snapshots. Bound each decoded frame and IO
// allocation, not the sum of independently verified historical records.
export const HISTORY_IO_BYTES = 1024 * 1024;
export const HISTORY_MEMORY_BYTES = 16 * HISTORY_IO_BYTES;
export const HISTORY_FRAME_BYTES = 64 * HISTORY_IO_BYTES;
const files = new WeakMap();
const releases = new WeakMap();
const fail = code => { throw Object.assign(new Error(code), { code }); };
function scopeCheck(check) {
  let primary = null;
  return () => {
    if (primary) throw primary;
    try { const value = check();
      if (value === false) fail("NATIVE_HISTORY_AUTHORITY_DENIED");
      if (value && typeof value.then === "function") { Promise.resolve(value).catch(() => {}); fail("NATIVE_HISTORY_SYNCHRONOUS_AUTHORITY_REQUIRED"); }
    } catch (error) { primary = error; throw primary; }
  };
}
export { scopeCheck as historyScopeCheck };
const identity = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
function writeAll(fd, bytes, check = () => {}) {
  for (let offset = 0; offset < bytes.length;) {
    check(); const n = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (!n) fail("NATIVE_HISTORY_WRITE_INCOMPLETE"); offset += n;
  }
}
function cleanupScratch(root, rootOwner, fileOwner) {
  const directory = fs.lstatSync(root, { bigint: true }), file = path.join(root, "prefix.bin");
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.dev !== rootOwner.dev || directory.ino !== rootOwner.ino)
    fail("NATIVE_HISTORY_CAPTURE_CLEANUP_CHANGED");
  const current = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (current) {
    if (!fileOwner || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || current.dev !== fileOwner.dev || current.ino !== fileOwner.ino)
      fail("NATIVE_HISTORY_CAPTURE_CLEANUP_CHANGED");
    fs.unlinkSync(file);
  } else if (fileOwner) fail("NATIVE_HISTORY_CAPTURE_CLEANUP_CHANGED");
  fs.rmdirSync(root); // Never recursively remove an unknown child.
}
export const isHistoryBytes = raw => files.has(raw);
function stopHistoryOwner(owner, error) {
  if (!owner.failed) { owner.failed = true; owner.failure = error; }
  return owner.failure;
}
function checkHistoryOwner(owner) {
  if (owner.failed) throw owner.failure;
  try {
    owner.check();
    const root = fs.lstatSync(owner.root, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== owner.rootIdentity.dev || root.ino !== owner.rootIdentity.ino)
      fail("NATIVE_HISTORY_ROOT_CHANGED");
  } catch (error) { throw stopHistoryOwner(owner, error); }
}

export function* historyChunks(raw) {
  if (!isHistoryBytes(raw)) { yield raw; return; }
  const view = files.get(raw), owner = view.owner;
  let fd = null;
  try {
    checkHistoryOwner(owner); const file = copiedProjectFile(owner.root, owner.relative);
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const verify = () => {
      checkHistoryOwner(owner);
      for (const s of [fs.fstatSync(fd, { bigint: true }), fs.lstatSync(copiedProjectFile(owner.root, owner.relative), { bigint: true })])
        if (!s.isFile() || s.nlink !== 1n || identity(s) !== owner.identity) fail("NATIVE_HISTORY_BYTES_CHANGED");
    };
    verify();
    for (let offset = 0; offset < raw.length;) {
      checkHistoryOwner(owner); const bytes = Buffer.allocUnsafe(Math.min(HISTORY_IO_BYTES, raw.length - offset)); let read = 0;
      while (read < bytes.length) {
        const n = fs.readSync(fd, bytes, read, bytes.length - read, view.start + offset + read);
        if (!n) fail("NATIVE_HISTORY_BYTES_CHANGED"); read += n;
      }
      offset += read; yield bytes;
    }
    verify();
  } catch (error) { throw stopHistoryOwner(owner, error); }
  finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (cleanup) {
      if (!owner.failed) throw stopHistoryOwner(owner, cleanup);
      if (owner.failure && typeof owner.failure === "object") owner.failure.descriptorCleanup = { code: cleanup.code };
    }
  }
}
export function historyHash(raw) {
  const digest = crypto.createHash("sha256");
  for (const bytes of historyChunks(raw)) digest.update(bytes);
  return digest.digest("hex");
}
export function historyEquals(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  if (Buffer.isBuffer(left) && right instanceof Uint8Array) return left.equals(right);
  return historyHash(left) === historyHash(right);
}
// Typed address/index metadata is one JSON document, not a JSONL body frame.
// Preserve its existing snapshot bound rather than imposing the frame bound.
export function historyMetadataText(raw) {
  if (raw.length > SNAPSHOT_STORAGE_LIMITS.decodedBytes) fail("NATIVE_HISTORY_METADATA_READ_LIMIT");
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat([...historyChunks(raw)], raw.length));
}
const smallReadWindows = new WeakMap();
// Only fragment getters use this private read window. Full-byte hash, chunk
// iteration and final source reconciliation always read the current file.
function smallHistoryRange(view, start, length) {
  const owner = view.owner;
  try {
    const verifyNamed = () => {
      checkHistoryOwner(owner);
      const stat = fs.lstatSync(copiedProjectFile(owner.root, owner.relative), { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || identity(stat) !== owner.identity)
        fail("NATIVE_HISTORY_BYTES_CHANGED");
    };
    checkHistoryOwner(owner); // No private cached byte is exposed before final named validation.
    const absolute = view.start + start;
    let cached = smallReadWindows.get(owner);
    if (!cached || absolute < cached.start || absolute + length > cached.start + cached.bytes.length) {
      const windowStart = Math.max(view.start, Math.floor(absolute / HISTORY_IO_BYTES) * HISTORY_IO_BYTES);
      const windowEnd = Math.min(view.start + view.length, windowStart + HISTORY_IO_BYTES);
      if (absolute + length > windowEnd) return null; // Cross-window/large frame: exact fresh read.
      const bytes = Buffer.concat([...historyChunks(new HistoryBytes(owner, windowStart, windowEnd - windowStart))], windowEnd - windowStart);
      cached = { start: windowStart, bytes };
      smallReadWindows.set(owner, cached);
    }
    verifyNamed();
    // Never expose the cached Buffer, including through an iterator or subarray.
    return Buffer.from(cached.bytes.subarray(absolute - cached.start, absolute - cached.start + length));
  } catch (error) { throw stopHistoryOwner(owner, error); }
}

class HistoryBytes {
  constructor(owner, start, length) { files.set(this, { owner, start }); this.length = length; Object.freeze(this); }
  subarray(start = 0, end = this.length) {
    const clamp = n => n < 0 ? Math.max(0, this.length + n) : Math.min(this.length, n);
    start = clamp(start); end = Math.max(start, clamp(end));
    const v = files.get(this), result = new HistoryBytes(v.owner, v.start + start, end - start);
    if (result.length > HISTORY_FRAME_BYTES) return result;
    if (Number.isSafeInteger(v.start + start) && Number.isSafeInteger(result.length) && result.length <= HISTORY_IO_BYTES) {
      const cached = smallHistoryRange({ ...v, length: this.length }, start, result.length);
      if (cached !== null) return cached;
    }
    return Buffer.concat([...historyChunks(result)], result.length);
  }
  indexOf(byte, from = 0) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) fail("NATIVE_HISTORY_BYTE_SEARCH_INVALID");
    const v = files.get(this); from = Math.min(this.length, Math.max(0, from)); let offset = from;
    for (const chunk of historyChunks(new HistoryBytes(v.owner, v.start + from, this.length - from))) {
      const i = chunk.indexOf(byte); if (i >= 0) return offset + i; offset += chunk.length;
    }
    return -1;
  }
  lastIndexOf(byte) {
    // Reverse bounded windows avoid scanning a gigabyte to find the final LF.
    for (let end = this.length; end > 0;) {
      const start = Math.max(0, end - HISTORY_IO_BYTES), i = this.subarray(start, end).lastIndexOf(byte);
      if (i >= 0) return start + i; end = start;
    }
    return -1;
  }
  includes(byte) { return this.indexOf(byte) >= 0; }
  at(index) { if (index < 0) index += this.length; return index < 0 || index >= this.length ? undefined : this.subarray(index, index + 1)[0]; }
  equals(other) { return historyEquals(this, other); }
  toString(encoding = "utf8") {
    if (this.length > HISTORY_FRAME_BYTES) fail("NATIVE_HISTORY_WHOLE_STRING_UNQUALIFIED");
    return Buffer.concat([...historyChunks(this)], this.length).toString(encoding);
  }
}
export function historyView(root, relative, check = () => {}) {
  check = scopeCheck(check);
  check(); const rootIdentity = fs.lstatSync(root, { bigint: true });
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) fail("NATIVE_HISTORY_ROOT_CHANGED");
  const s = fs.lstatSync(copiedProjectFile(root, relative), { bigint: true });
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || s.size > BigInt(Number.MAX_SAFE_INTEGER)) fail("NATIVE_HISTORY_BYTES_UNSAFE");
  const owner = { root, relative, rootIdentity, identity: identity(s), check, failed: false };
  checkHistoryOwner(owner);
  return new HistoryBytes(owner, 0, Number(s.size));
}
export function readHistoryRaw(root, relative, signal, check = () => {}) {
  const current = () => {
    if (signal?.aborted) fail("NATIVE_HISTORY_OPERATION_CANCELLED");
    const value = check();
    if (signal?.aborted) fail("NATIVE_HISTORY_OPERATION_CANCELLED");
    if (value === false) fail("NATIVE_HISTORY_AUTHORITY_DENIED");
    if (value && typeof value.then === "function") { Promise.resolve(value).catch(() => {}); fail("NATIVE_HISTORY_SYNCHRONOUS_AUTHORITY_REQUIRED"); }
  };
  const view = historyView(root, relative, current), sha256 = historyHash(view);
  const raw = view.length <= HISTORY_MEMORY_BYTES ? view.subarray(0) : view;
  return { entry: { path: relative, bytes: raw.length, sha256 }, raw };
}

// A private create-only capture, never a path from a transcript. Callers release
// it in finally after the immutable archive has consumed it, also on failure.
export function captureHistoryPrefix(fd, length, check = () => {}, onCreated = () => {}) {
  check = scopeCheck(check);
  if (!Number.isSafeInteger(length) || length < 0) fail("NATIVE_HISTORY_PREFIX_INVALID");
  check(); const root = fs.mkdtempSync(path.join(os.tmpdir(), "lode-history-")), relative = "prefix.bin";
  const file = path.join(root, relative), rootOwner = fs.lstatSync(root, { bigint: true }); let output = null, raw = null, fileOwner = null;
  try {
    output = fs.openSync(file, "wx", 0o600);
    fileOwner = fs.fstatSync(output, { bigint: true });
    const storage = { root, file, rootIdentity: { dev: String(rootOwner.dev), ino: String(rootOwner.ino) },
      fileIdentity: { dev: String(fileOwner.dev), ino: String(fileOwner.ino) }, expectedBytes: length };
    onCreated(storage);
    const bytes = Buffer.allocUnsafe(Math.min(HISTORY_IO_BYTES, length));
    for (let offset = 0; offset < length;) {
      check(); const n = fs.readSync(fd, bytes, 0, Math.min(bytes.length, length - offset), offset);
      if (!n) fail("NATIVE_HISTORY_PREFIX_CHANGED");
      writeAll(output, bytes.subarray(0, n), check);
      offset += n;
    }
    fs.fsyncSync(output); fs.closeSync(output); output = null;
    raw = historyView(root, relative); // Captured bytes no longer depend on a live guard.
    return { raw, storage, release() { const owner = files.get(raw).owner; const s = fs.lstatSync(file, { bigint: true });
      if (identity(s) !== owner.identity || !s.isFile() || s.nlink !== 1n) fail("NATIVE_HISTORY_CAPTURE_CLEANUP_CHANGED");
      cleanupScratch(root, rootOwner, fileOwner); } };
  } catch (error) {
    if (output !== null) try { fs.closeSync(output); } catch (cleanup) { error.descriptorCleanup = { code: cleanup.code }; }
    // Only this invocation's exclusive file; do not recursively remove paths.
    try { cleanupScratch(root, rootOwner, fileOwner); } catch (cleanup) { error.captureCleanup = { code: cleanup.code, preservedPath: root }; }
    throw error;
  }
}

export function createHistoryArtifact(file, raw, check = () => {}) {
  check = scopeCheck(check);
  check(); const temporary = path.join(path.dirname(file), "." + path.basename(file) + "." + crypto.randomUUID() + ".tmp");
  let fd = null, owner = null, stagedIdentity = null, failure = null;
  try {
    fd = fs.openSync(temporary, "wx", 0o600); owner = fs.fstatSync(fd, { bigint: true });
    const expected = historyHash(raw); let written = 0;
    for (const chunk of historyChunks(raw)) {
      writeAll(fd, chunk, check); written += chunk.length;
    }
    fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
    const staged = historyView(path.dirname(file), path.basename(temporary), check);
    const namedOwner = fs.lstatSync(temporary, { bigint: true });
    if (namedOwner.dev !== owner.dev || namedOwner.ino !== owner.ino || namedOwner.nlink !== 1n) fail("NATIVE_HISTORY_STAGING_CLEANUP_CHANGED");
    if (written !== raw.length || historyHash(staged) !== expected) fail("NATIVE_HISTORY_ARTIFACT_CHANGED");
    stagedIdentity = fs.lstatSync(temporary, { bigint: true });
    check();
    const finalOwner = fs.lstatSync(temporary, { bigint: true });
    if (finalOwner.dev !== owner.dev || finalOwner.ino !== owner.ino || finalOwner.nlink !== 1n
      || finalOwner.size !== stagedIdentity.size || finalOwner.mtimeNs !== stagedIdentity.mtimeNs) fail("NATIVE_HISTORY_STAGING_CLEANUP_CHANGED");
    fs.linkSync(temporary, file); // Atomic, never overwrite/append/retry.
  } catch (error) { failure = error; throw error;
  } finally {
    try {
      if (fd !== null) fs.closeSync(fd);
      const current = fs.lstatSync(temporary, { bigint: true, throwIfNoEntry: false });
      if (current) {
        if (!owner || !current.isFile() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino
          || stagedIdentity && (current.size !== stagedIdentity.size || current.mtimeNs !== stagedIdentity.mtimeNs)) fail("NATIVE_HISTORY_STAGING_CLEANUP_CHANGED");
        fs.unlinkSync(temporary);
      }
    } catch (cleanup) { if (failure) failure.stagingCleanup = { code: cleanup.code, preservedPath: temporary }; else throw cleanup; }
  }
}

export function releaseHistoryBytes(raw) { const release = releases.get(raw); if (release) { release(); releases.delete(raw); } }
export async function captureHistoryChunks(chunks, check = () => {}, onCreated = () => {}) {
  check = scopeCheck(check); check();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lode-history-")), rootOwner = fs.lstatSync(root, { bigint: true });
  let output = null, fileOwner = null;
  try {
    output = fs.openSync(path.join(root, "prefix.bin"), "wx", 0o600); fileOwner = fs.fstatSync(output, { bigint: true });
    const storage = { root, file: path.join(root, "prefix.bin"), rootIdentity: { dev: String(rootOwner.dev), ino: String(rootOwner.ino) },
      fileIdentity: { dev: String(fileOwner.dev), ino: String(fileOwner.ino) } };
    onCreated(storage);
    for await (const chunk of chunks) { check(); if (!(chunk instanceof Uint8Array) || chunk.length > HISTORY_IO_BYTES) fail("NATIVE_HISTORY_CHUNK_INVALID"); writeAll(output, chunk, check); }
    fs.fsyncSync(output); fs.closeSync(output); output = null;
    const raw = historyView(root, "prefix.bin");
    return { raw, storage, release() {
      const current = fs.lstatSync(path.join(root, "prefix.bin"), { bigint: true });
      if (identity(current) !== files.get(raw).owner.identity || current.nlink !== 1n) fail("NATIVE_HISTORY_CAPTURE_CLEANUP_CHANGED");
      cleanupScratch(root, rootOwner, fileOwner);
    } };
  } catch (error) {
    if (output !== null) try { fs.closeSync(output); } catch (cleanup) { error.descriptorCleanup = { code: cleanup.code }; }
    try { cleanupScratch(root, rootOwner, fileOwner); } catch (cleanup) { error.captureCleanup = { code: cleanup.code, preservedPath: root }; }
    throw error;
  }
}
export function encodeHistoryLines(records, check = () => {}) {
  check = scopeCheck(check);
  let chunks = [], length = 0, root = null, rootOwner = null, fileOwner = null, output = null, raw = null;
  try {
    for (const record of records) {
      check();
      const bytes = Buffer.from(JSON.stringify(record) + "\n");
      if (bytes.length - 1 > HISTORY_FRAME_BYTES) fail("NATIVE_HISTORY_FRAME_TOO_LARGE");
      length += bytes.length;
      if (!Number.isSafeInteger(length)) fail("NATIVE_HISTORY_PREFIX_INVALID");
      if (output === null && length > HISTORY_MEMORY_BYTES) {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "lode-history-")); rootOwner = fs.lstatSync(root, { bigint: true }); output = fs.openSync(path.join(root, "prefix.bin"), "wx", 0o600);
        fileOwner = fs.fstatSync(output, { bigint: true });
        for (const chunk of chunks) writeAll(output, chunk, check); chunks = [];
      }
      if (output === null) chunks.push(bytes); else writeAll(output, bytes, check);
    }
    if (output === null) return Buffer.concat(chunks, length);
    fs.fsyncSync(output); fs.closeSync(output); output = null;
    raw = historyView(root, "prefix.bin");
    releases.set(raw, () => {
      const s = fs.lstatSync(path.join(root, "prefix.bin"), { bigint: true });
      if (identity(s) !== files.get(raw).owner.identity || s.nlink !== 1n || !s.isFile()) fail("NATIVE_HISTORY_CAPTURE_CLEANUP_CHANGED");
      cleanupScratch(root, rootOwner, fileOwner);
    });
    return raw;
  } catch (error) {
    if (output !== null) try { fs.closeSync(output); } catch (cleanup) { error.descriptorCleanup = { code: cleanup.code }; }
    if (root) try { cleanupScratch(root, rootOwner, fileOwner); } catch (cleanup) { error.captureCleanup = { code: cleanup.code, preservedPath: root }; }
    throw error;
  }
}

export function* historyLines(raw, maximum = HISTORY_FRAME_BYTES) {
  let parts = [], bytes = 0;
  for (const chunk of historyChunks(raw)) {
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset), stop = end < 0 ? chunk.length : end;
      if (bytes + stop - offset > maximum) fail("NATIVE_HISTORY_FRAME_TOO_LARGE");
      parts.push(chunk.subarray(offset, stop)); bytes += stop - offset;
      if (end < 0) break;
      yield parts.length === 1 ? parts[0] : Buffer.concat(parts, bytes);
      parts = []; bytes = 0; offset = end + 1;
    }
  }
  if (bytes) yield parts.length === 1 ? parts[0] : Buffer.concat(parts, bytes);
}
