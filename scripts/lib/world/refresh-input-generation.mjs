import fs from "node:fs";
import path from "node:path";
import { atomicWriteText } from "../core/fs-atomic.mjs";
import { sha256Hex } from "../core/digest.mjs";

// Rebuildable caches. They are not snapshot roots and are ignored by GC.
export const FILE_STAT_CACHE_RELATIVE = "refresh/file-stat-cache.json";
export const INPUT_GENERATION_RELATIVE = "refresh/input-generation.json";

const SKIP_STORAGE_PREFIXES = [
  "snapshot-bundles/",
  "world-model/snapshots/",
  "graph-projection/snapshots/",
  "snapshot-objects.git/",
  "refresh/",
  "document-projection/",
  ".snapshot-gc/",
  ".operations/",
];

function cachePath(root, storage, relative) {
  return path.join(root, storage.directory, relative);
}

function readJsonIfPresent(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function loadFileStatCache(root, storage) {
  const document = readJsonIfPresent(cachePath(root, storage, FILE_STAT_CACHE_RELATIVE));
  const map = new Map();
  if (!document || document.kind !== "RefreshFileStatCache" || document.schemaVersion !== 1 || !document.files) return map;
  for (const [file, entry] of Object.entries(document.files)) {
    if (!entry || typeof entry.digest !== "string") continue;
    map.set(file, entry);
  }
  return map;
}

export function saveFileStatCache(root, storage, cache) {
  const files = Object.fromEntries([...cache.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  atomicWriteText(cachePath(root, storage, FILE_STAT_CACHE_RELATIVE), JSON.stringify({ schemaVersion: 1, kind: "RefreshFileStatCache", files }));
}

export function statMatchesCached(previous, cached, absolute) {
  if (!previous || !cached || previous.digest !== cached.digest || previous.bytes !== cached.bytes) return null;
  let identity;
  try {
    identity = fileIdentity(absolute);
  } catch {
    return null;
  }
  if (
    identity.bytes !== cached.bytes ||
    identity.mtimeNs !== cached.mtimeNs ||
    identity.ctimeNs !== cached.ctimeNs ||
    identity.ino !== cached.ino ||
    identity.dev !== cached.dev
  )
    return null;
  return identity;
}

export function fileIdentity(absolute) {
  const stat = fs.statSync(absolute, { bigint: true });
  return {
    bytes: Number(stat.size),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    ino: stat.ino.toString(),
    dev: stat.dev.toString(),
  };
}

// A filesystem that keeps whole seconds (FAT keeps two) can take a second
// write inside the tick of the first, leaving size and times as they were. A
// file whose modification time has no sub-second part is trusted only once
// that tick is over; until then it is read again.
const COARSE_TICK_NS = 2_000_000_000n;
export function timestampSettled(identity, nowMs = Date.now()) {
  let modified;
  try {
    modified = BigInt(identity.mtimeNs);
  } catch {
    return false;
  }
  if (modified % 1_000_000_000n !== 0n) return true;
  return BigInt(Math.trunc(nowMs)) * 1_000_000n - modified >= COARSE_TICK_NS;
}

// `before` is the stat taken before the bytes were read. The stat taken after
// that read is recorded only when it still describes the same bytes.
export function identitiesAgree(before, after, byteLength) {
  if (!before || !after || !Number.isInteger(byteLength) || byteLength < 0) return false;
  return (
    before.bytes === after.bytes &&
    before.bytes === byteLength &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs &&
    before.ino === after.ino &&
    before.dev === after.dev
  );
}

export function rememberFileStat(cache, relative, absolute, digest, bytes, before) {
  let after = null;
  try {
    after = fileIdentity(absolute);
  } catch {
    after = null;
  }
  if (!identitiesAgree(before, after, bytes) || !timestampSettled(after)) {
    if (cache) cache.delete(relative);
    return null;
  }
  const entry = { ...after, digest, bytes };
  if (cache) cache.set(relative, entry);
  return entry;
}

function walkStorageInputs(root, storage) {
  const base = path.join(root, storage.directory);
  const rows = [];
  const stack = [""];
  while (stack.length) {
    const relative = stack.pop();
    const absolute = relative ? path.join(base, relative) : base;
    let stat;
    try {
      stat = fs.lstatSync(absolute, { bigint: true });
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (relative && SKIP_STORAGE_PREFIXES.some((prefix) => relative + "/" === prefix || relative.startsWith(prefix))) continue;
      for (const name of fs.readdirSync(absolute)) stack.push(relative ? relative + "/" + name : name);
      continue;
    }
    if (!stat.isFile() || stat.nlink !== 1n) continue;
    const portable = relative.replaceAll("\\", "/");
    if (SKIP_STORAGE_PREFIXES.some((prefix) => portable.startsWith(prefix))) continue;
    rows.push([portable, stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString(), stat.ino.toString()]);
  }
  rows.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return rows;
}

function considerGit(rows, relative, absolute) {
  let stat;
  try {
    stat = fs.lstatSync(absolute, { bigint: true });
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolute)) considerGit(rows, relative ? relative + "/" + name : name, path.join(absolute, name));
    return;
  }
  if (!stat.isFile()) return;
  rows.push([relative.replaceAll("\\", "/"), stat.size.toString(), stat.mtimeNs.toString()]);
}

function linkedGitDirectories(root) {
  const gitPath = path.join(root, ".git");
  let marker;
  try {
    marker = fs.lstatSync(gitPath);
  } catch {
    return { status: "absent", directories: [] };
  }
  if (marker.isSymbolicLink()) return { status: "unresolved", directories: [] };
  if (marker.isDirectory()) return { status: "ok", directories: [["gitdir", gitPath]] };
  if (!marker.isFile() || marker.size > 8192) return { status: "unresolved", directories: [] };
  let text = "";
  try {
    text = fs
      .readFileSync(gitPath, "utf8")
      .replace(/^\uFEFF/, "")
      .trim();
  } catch {
    return { status: "unresolved", directories: [] };
  }
  const match = /^gitdir:\s*(.+)$/.exec(text);
  if (!match) return { status: "unresolved", directories: [] };
  const gitDir = path.resolve(path.dirname(gitPath), match[1].trim());
  let gitDirStat;
  try {
    gitDirStat = fs.lstatSync(gitDir);
  } catch {
    return { status: "unresolved", directories: [] };
  }
  if (!gitDirStat.isDirectory() || gitDirStat.isSymbolicLink()) return { status: "unresolved", directories: [] };
  const directories = [["gitdir", gitDir]];
  const commonFile = path.join(gitDir, "commondir");
  try {
    const commonStat = fs.lstatSync(commonFile);
    if (commonStat.isFile() && !commonStat.isSymbolicLink() && commonStat.size <= 8192) {
      const commonDir = path.resolve(gitDir, fs.readFileSync(commonFile, "utf8").trim());
      const commonDirStat = fs.lstatSync(commonDir);
      if (commonDirStat.isDirectory() && !commonDirStat.isSymbolicLink() && path.resolve(commonDir) !== path.resolve(gitDir))
        directories.push(["commondir", commonDir]);
    }
  } catch {
    /* An ordinary gitdir has no commondir. A linked worktree that loses it is unresolved below only when the file is unreadable after existing. */
  }
  return { status: "ok", directories };
}

export function refreshGitIdentity(root) {
  const linked = linkedGitDirectories(root);
  if (linked.status !== "ok") return linked.status;
  const rows = [];
  considerGit(rows, ".git", path.join(root, ".git"));
  for (const [label, directory] of linked.directories) {
    considerGit(rows, `${label}/HEAD`, path.join(directory, "HEAD"));
    considerGit(rows, `${label}/packed-refs`, path.join(directory, "packed-refs"));
    const refs = path.join(directory, "refs");
    if (fs.existsSync(refs)) considerGit(rows, `${label}/refs`, refs);
  }
  rows.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return sha256Hex(JSON.stringify(rows));
}

// `git` lets a build record the git state it read before it built, so a
// commit made while it was building leaves the stamp behind the repository
// and the next refresh takes the full path.
export function refreshInputStamp(root, storage, { git = refreshGitIdentity(root) } = {}) {
  return sha256Hex(JSON.stringify({ storage: walkStorageInputs(root, storage), git }));
}

const REVISION_KINDS = new Set([
  "FileRevision",
  "SymbolRevision",
  "TestRevision",
  "FeatureGroupRevision",
  "CapabilityRevision",
  "FeatureRevision",
  "RequirementRevision",
  "ConstraintRevision",
  "DecisionRevision",
  "PolicyRevision",
]);

function confirmAgreedFile(root, file) {
  const absolute = path.join(root, file.path);
  let before = null;
  let after = null;
  let raw;
  try {
    before = fileIdentity(absolute);
    raw = fs.readFileSync(absolute);
    after = fileIdentity(absolute);
  } catch {
    return null;
  }
  if (!identitiesAgree(before, after, raw.length) || !timestampSettled(after) || raw.length !== file.bytes || sha256Hex(raw) !== file.digest) return null;
  return { ...after, digest: file.digest, bytes: file.bytes };
}

function agreedGenerationEntry(entry, file) {
  if (!entry || entry.digest !== file.digest || entry.bytes !== file.bytes) return null;
  if (typeof entry.mtimeNs !== "string" || typeof entry.ctimeNs !== "string" || typeof entry.ino !== "string" || typeof entry.dev !== "string") return null;
  return {
    bytes: entry.bytes,
    mtimeNs: entry.mtimeNs,
    ctimeNs: entry.ctimeNs,
    ino: entry.ino,
    dev: entry.dev,
    digest: entry.digest,
  };
}

export function writeRefreshInputGeneration({ root, storage, snapshot, verifiedFiles = null, gitIdentity = undefined }) {
  const graph = snapshot.temporalProvenanceGraph;
  const revisions = graph.nodes.filter((node) => REVISION_KINDS.has(node.kind));
  const files = {};
  for (const file of snapshot.files || []) {
    // A scan map is authoritative, including when a file is absent from it:
    // that file changed around the read and must not be paired with a later stat.
    const entry = verifiedFiles ? agreedGenerationEntry(verifiedFiles.get(file.path), file) : confirmAgreedFile(root, file);
    if (entry) files[file.path] = entry;
  }
  const document = {
    schemaVersion: 1,
    kind: "RefreshInputGeneration",
    worldModelId: snapshot.worldModelId,
    worldModelHash: snapshot.worldModelHash,
    sourceSnapshotId: graph.sourceSnapshotId,
    graphSnapshotId: graph.graphSnapshotId,
    parentSourceSnapshotIds: graph.parentSourceSnapshotIds,
    revisionNodeCount: revisions.length,
    parentedRevisionCount: revisions.filter((node) => node.parentRevisionIds?.length > 0).length,
    stamp: refreshInputStamp(root, storage, gitIdentity === undefined ? {} : { git: gitIdentity }),
    files,
  };
  atomicWriteText(cachePath(root, storage, INPUT_GENERATION_RELATIVE), JSON.stringify(document));
  saveFileStatCache(root, storage, new Map(Object.entries(files)));
  return document;
}

export function readRefreshInputGeneration(root, storage) {
  const document = readJsonIfPresent(cachePath(root, storage, INPUT_GENERATION_RELATIVE));
  if (!document || document.kind !== "RefreshInputGeneration" || document.schemaVersion !== 1) return null;
  if (typeof document.worldModelId !== "string" || typeof document.stamp !== "string" || !document.files || typeof document.files !== "object") return null;
  return document;
}
