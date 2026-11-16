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
  atomicWriteText(
    cachePath(root, storage, FILE_STAT_CACHE_RELATIVE),
    JSON.stringify({ schemaVersion: 1, kind: "RefreshFileStatCache", files }),
  );
}

function fileIdentity(absolute) {
  const stat = fs.statSync(absolute, { bigint: true });
  return {
    bytes: Number(stat.size),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    ino: stat.ino.toString(),
    dev: stat.dev.toString(),
  };
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

export function rememberFileStat(cache, relative, absolute, digest, bytes) {
  if (!cache) return;
  try {
    cache.set(relative, { ...fileIdentity(absolute), digest, bytes });
  } catch {
    cache.delete(relative);
  }
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

function gitIdentity(root) {
  const gitPath = path.join(root, ".git");
  if (!fs.existsSync(gitPath)) return "absent";
  const rows = [];
  const consider = (relative, absolute) => {
    let stat;
    try {
      stat = fs.lstatSync(absolute, { bigint: true });
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute)) consider(relative ? relative + "/" + name : name, path.join(absolute, name));
      return;
    }
    if (!stat.isFile()) return;
    rows.push([relative.replaceAll("\\", "/"), stat.size.toString(), stat.mtimeNs.toString()]);
  };
  const stat = fs.lstatSync(gitPath);
  if (stat.isFile()) consider(".git", gitPath);
  else {
    consider("HEAD", path.join(gitPath, "HEAD"));
    consider("packed-refs", path.join(gitPath, "packed-refs"));
    const refs = path.join(gitPath, "refs");
    if (fs.existsSync(refs)) consider("refs", refs);
  }
  rows.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return sha256Hex(JSON.stringify(rows));
}

export function refreshInputStamp(root, storage) {
  return sha256Hex(JSON.stringify({ storage: walkStorageInputs(root, storage), git: gitIdentity(root) }));
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

export function writeRefreshInputGeneration({ root, storage, snapshot }) {
  const graph = snapshot.temporalProvenanceGraph;
  const revisions = graph.nodes.filter((node) => REVISION_KINDS.has(node.kind));
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
    stamp: refreshInputStamp(root, storage),
  };
  atomicWriteText(cachePath(root, storage, INPUT_GENERATION_RELATIVE), JSON.stringify(document));
  return document;
}

export function readRefreshInputGeneration(root, storage) {
  const document = readJsonIfPresent(cachePath(root, storage, INPUT_GENERATION_RELATIVE));
  if (!document || document.kind !== "RefreshInputGeneration" || document.schemaVersion !== 1) return null;
  if (typeof document.worldModelId !== "string" || typeof document.stamp !== "string") return null;
  return document;
}
