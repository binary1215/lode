import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { atomicCreateArtifact } from "./artifact-storage.mjs";

// Physical snapshot encoding only. IDs and semantic hashes are still verified
// by the existing World/Graph readers. These are storage bounds, not MCP output
// or Context token budgets. Legacy JSON is never re-encoded in place.
export const SNAPSHOT_STORAGE_LIMITS = Object.freeze({ compressedBytes: 256 * 1024 * 1024, decodedBytes: 512 * 1024 * 1024 });
const fail = (message, code = "INVALID_SNAPSHOT_ENCODING") => { throw Object.assign(new Error(message), { code }); };
export function safeSnapshotPath(root, file) {
  const canonical = fs.realpathSync(root), target = path.resolve(file), relative = path.relative(canonical, target);
  if (!relative || relative.startsWith('..'+path.sep) || relative === '..' || path.isAbsolute(relative)) fail("Snapshot path escapes Project.", "UNSAFE_SNAPSHOT_PATH");
  let current = canonical;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || current !== target && !stat.isDirectory())) fail("Snapshot path is linked or invalid.", "UNSAFE_SNAPSHOT_PATH");
  }
  return target;
}
export function storedSnapshotLocation(root, jsonFile, encoding = "gzip") {
  if (!["gzip", "json"].includes(encoding)) fail("Unsupported snapshot encoding.");
  safeSnapshotPath(root, jsonFile); safeSnapshotPath(root, jsonFile + '.gz');
  const json = fs.lstatSync(jsonFile, { throwIfNoEntry: false }), gzip = fs.lstatSync(jsonFile + '.gz', { throwIfNoEntry: false });
  if (json && gzip) fail("Two physical representations claim one snapshot ID.", "SNAPSHOT_REPRESENTATION_CONFLICT");
  return json ? jsonFile : gzip ? jsonFile + '.gz' : jsonFile + (encoding === "gzip" ? '.gz' : '');
}
export function decodeSnapshotBytes(bytes, { compressed = false, compressedBytes = SNAPSHOT_STORAGE_LIMITS.compressedBytes,
  decodedBytes = SNAPSHOT_STORAGE_LIMITS.decodedBytes } = {}) {
  if (!Buffer.isBuffer(bytes)) fail("Snapshot bytes must be a Buffer.");
  if (![compressedBytes, decodedBytes].every(value => Number.isSafeInteger(value) && value > 0)) fail("Invalid snapshot storage bound.");
  let decoded = bytes;
  if (compressed) {
    if (bytes.length > compressedBytes) fail("Compressed snapshot exceeds its storage bound.", "SNAPSHOT_STORAGE_LIMIT");
    try { decoded = zlib.gunzipSync(bytes, { maxOutputLength: decodedBytes }); }
    catch (error) { fail("Snapshot gzip is corrupt, truncated or exceeds its decoded bound.", error.code === "ERR_BUFFER_TOO_LARGE" ? "SNAPSHOT_STORAGE_LIMIT" : "INVALID_SNAPSHOT_ENCODING"); }
  }
  if (decoded.length > decodedBytes) fail("Decoded snapshot exceeds its storage bound.", "SNAPSHOT_STORAGE_LIMIT");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded)); }
  catch { fail("Snapshot is not valid UTF-8 JSON."); }
}
export function readSnapshotFile(file, limits = {}) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("Snapshot is not a single regular file.", "UNSAFE_SNAPSHOT_PATH");
  const compressed = file.endsWith('.json.gz');
  const maximum = compressed ? limits.compressedBytes ?? SNAPSHOT_STORAGE_LIMITS.compressedBytes : limits.decodedBytes ?? Number.MAX_SAFE_INTEGER;
  if (stat.size > maximum) fail("Snapshot exceeds its storage bound.", "SNAPSHOT_STORAGE_LIMIT");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.nlink !== 1) fail("Snapshot changed before read.", "SNAPSHOT_STORAGE_DRIFT");
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== stat.size || fs.fstatSync(fd).size !== stat.size) fail("Snapshot changed during read.", "SNAPSHOT_STORAGE_DRIFT");
    return { bytes, document: !compressed && limits.decodedBytes === undefined
      ? JSON.parse(bytes.toString("utf8")) : decodeSnapshotBytes(bytes, { ...limits, compressed }) };
  } finally { fs.closeSync(fd); }
}
export function writeStoredSnapshot({ root, jsonFile, document, encoding = "gzip", readDocument = file => readSnapshotFile(file).document }) {
  const location = storedSnapshotLocation(root, jsonFile, encoding);
  if (fs.existsSync(location)) return { location, created: false, document: readDocument(location) };
  const text = JSON.stringify(document) + '\n';
  if (Buffer.byteLength(text) > SNAPSHOT_STORAGE_LIMITS.decodedBytes) fail("New snapshot exceeds decoded storage bound.", "SNAPSHOT_STORAGE_LIMIT");
  const bytes = encoding === "gzip" ? zlib.gzipSync(text) : Buffer.from(text);
  if (encoding === "gzip" && bytes.length > SNAPSHOT_STORAGE_LIMITS.compressedBytes) fail("New snapshot exceeds compressed storage bound.", "SNAPSHOT_STORAGE_LIMIT");
  safeSnapshotPath(root, location);
  try { atomicCreateArtifact(location, bytes); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    storedSnapshotLocation(root, jsonFile, encoding);
    return { location, created: false, document: readDocument(location) };
  }
  storedSnapshotLocation(root, jsonFile, encoding);
  return { location, created: true, document };
}
export function listStoredSnapshotIds(root, directory, prefix) {
  safeSnapshotPath(root, directory);
  if (!fs.existsSync(directory)) return [];
  const pattern = new RegExp('^(' + prefix + '-[a-f0-9]{24})\\.json(?:\\.gz)?$');
  return [...new Set(fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && pattern.test(entry.name))
    .map(entry => entry.name.match(pattern)[1]))].sort();
}
