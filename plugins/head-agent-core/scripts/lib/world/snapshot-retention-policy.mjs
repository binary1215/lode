import fs from "node:fs";
import path from "node:path";

// A retention window is opt-in: without a usable policy file and without
// --keep-count / --keep-days, storage GC keeps exactly what it kept before
// (every retained reference and its ancestry). When a window is configured,
// age and count apply only to published World history that nothing current or
// recorded still names. Current pointers and what they name, decision/record
// pins, snapshots named by hash, snapshots without a trustworthy time and the
// parts those snapshots need stay. A policy file that exists but cannot be
// used keeps every historical snapshot instead of guessing, and says why.
// DEFAULT_SNAPSHOT_RETENTION only fills the value a run leaves out when it
// gives one of --keep-count / --keep-days and no policy file supplies the other.
export const DEFAULT_SNAPSHOT_RETENTION = Object.freeze({ keepCount: 8, keepDays: 14 });
export const SNAPSHOT_RETENTION_RELATIVE = "refresh/snapshot-retention.json";
const SNAPSHOT_ID = /^(?:world-model|graph-snapshot|source-snapshot)-[a-f0-9]{24}$/;

// The reason a policy document cannot be used, or null when it can.
function policyProblem(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) return "not a JSON object";
  if (document.schemaVersion !== 1) return "schemaVersion must be 1";
  const keys = Object.keys(document).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["keepCount", "keepDays", "schemaVersion"]))
    return "fields must be exactly schemaVersion, keepCount and keepDays";
  if (!Number.isSafeInteger(document.keepCount) || document.keepCount < 1 || document.keepCount > 10000) return "keepCount must be an integer from 1 to 10000";
  if (!Number.isSafeInteger(document.keepDays) || document.keepDays < 0 || document.keepDays > 3650) return "keepDays must be an integer from 0 to 3650";
  return null;
}

// Validates --keep-count / --keep-days values as given on a command line.
// Returns the retention override or throws a usage error.
export function parseRetentionOptions(options = {}) {
  const read = (flag, min, max) => {
    const raw = options[flag];
    if (raw == null) return undefined;
    const text = String(raw).trim();
    if (!/^\d+$/.test(text) || Number(text) < min || Number(text) > max)
      throw Object.assign(new Error(`--${flag} must be an integer from ${min} to ${max}; got "${raw}".`), { code: "INVALID_STORAGE_GC_RETENTION_OPTION" });
    return Number(text);
  };
  const keepCount = read("keep-count", 1, 10000);
  const keepDays = read("keep-days", 0, 3650);
  if (keepCount === undefined && keepDays === undefined) return null;
  return { ...(keepCount === undefined ? {} : { keepCount }), ...(keepDays === undefined ? {} : { keepDays }) };
}

export function resolveSnapshotRetentionPolicy({ root, storage, override = null } = {}) {
  const off = (source, problem = null) => ({ keepCount: null, keepDays: null, source, preserveAllHistory: true, ...(problem ? { problem } : {}) });
  let file = null;
  let fileProblem = null;
  if (root && storage?.directory) {
    const location = path.join(root, storage.directory, SNAPSHOT_RETENTION_RELATIVE);
    if (fs.existsSync(location)) {
      try {
        // A file saved by Windows PowerShell 5.1 starts with a byte order mark.
        const document = JSON.parse(fs.readFileSync(location, "utf8").replace(/^﻿/, ""));
        fileProblem = policyProblem(document);
        if (!fileProblem) file = { keepCount: document.keepCount, keepDays: document.keepDays };
      } catch (error) {
        fileProblem = error instanceof SyntaxError ? "not valid JSON" : "unreadable (" + (error.code || error.message) + ")";
      }
    }
  }
  if (override && (override.keepCount != null || override.keepDays != null)) {
    const candidate = {
      schemaVersion: 1,
      keepCount: override.keepCount ?? file?.keepCount ?? DEFAULT_SNAPSHOT_RETENTION.keepCount,
      keepDays: override.keepDays ?? file?.keepDays ?? DEFAULT_SNAPSHOT_RETENTION.keepDays,
    };
    const problem = policyProblem(candidate);
    if (problem) return off("invalid-options", problem);
    return {
      keepCount: candidate.keepCount,
      keepDays: candidate.keepDays,
      source: "options",
      preserveAllHistory: false,
      ...(fileProblem ? { fileProblem } : {}),
    };
  }
  if (fileProblem) return off("invalid-project-file", fileProblem);
  if (file) return { ...file, source: "project-file", preserveAllHistory: false };
  return off("not-configured");
}

// The retention part of a storage GC result: whether a window is in force,
// where it came from, the window itself, and what keeps a snapshot.
export function describeSnapshotRetention(policy) {
  const base = {
    mode: policy.preserveAllHistory ? "off" : "window",
    source: policy.source,
    keepCount: policy.preserveAllHistory ? null : policy.keepCount,
    keepDays: policy.preserveAllHistory ? null : policy.keepDays,
    preserveAllHistory: policy.preserveAllHistory,
    ...(policy.problem ? { problem: policy.problem } : {}),
    ...(policy.fileProblem ? { policyFileProblem: policy.fileProblem } : {}),
  };
  if (policy.preserveAllHistory)
    return {
      ...base,
      policy:
        policy.source === "not-configured"
          ? "retention is off (no policy file, no --keep-count / --keep-days): every snapshot a retained record names, and its ancestry, stays; only snapshots nothing names are eligible"
          : `retention is off because the ${policy.source === "invalid-options" ? "--keep-count / --keep-days values" : "policy file " + SNAPSHOT_RETENTION_RELATIVE} cannot be used (${policy.problem}): every snapshot a retained record names, and its ancestry, stays`,
    };
  return {
    ...base,
    policy: `retention window from ${policy.source === "options" ? "this run's options" : "the policy file " + SNAPSHOT_RETENTION_RELATIVE}: the newest ${policy.keepCount} Worlds by first write time, or those first written in the last ${policy.keepDays} days, stay with the current pointers and what they name, snapshots that decisions and records pin, snapshots named by hash and snapshots without a trustworthy time; older World history that only refresh history names is released`,
  };
}

export function snapshotIdsIn(value, found = new Set()) {
  if (typeof value === "string") {
    if (/^(?:world-model|graph-snapshot|source-snapshot)-[a-f0-9]{24}$/.test(value)) found.add(value);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const child of value) snapshotIdsIn(child, found);
    return found;
  }
  for (const child of Object.values(value)) snapshotIdsIn(child, found);
  return found;
}

// The lineage ids of a stored snapshot: every id it lists under
// parentSourceSnapshotIds, parentSnapshotIds, previousWorldModelId or
// referencedSourceSnapshotId (and a refresh request's additionalParentSourceSnapshotIds). Decided per id, not per occurrence, on purpose: a
// World also names its parents' source snapshots inside its revisions, and
// those are lineage too (reading, refreshing and diffing a kept World never
// opens its parent). Only snapshot rows use this to leave a parent to its
// window. Records do not: a record pins every id it names, parents included.
export function ancestryIdsOf(document) {
  const found = new Set();
  const add = (value) => {
    if (typeof value === "string" && SNAPSHOT_ID.test(value)) found.add(value);
  };
  const walk = (value, key) => {
    if (Array.isArray(value) && (key === "parentSourceSnapshotIds" || key === "parentSnapshotIds" || key === "additionalParentSourceSnapshotIds")) {
      for (const item of value) add(item);
      return;
    }
    if (typeof value === "string" && (key === "previousWorldModelId" || key === "referencedSourceSnapshotId")) {
      add(value);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, key);
      return;
    }
    for (const [childKey, child] of Object.entries(value)) walk(child, childKey);
  };
  if (document && typeof document === "object") walk(document, "");
  return [...found];
}

// The ids of records a current pointer names (its receipt and request), so
// those records are kept with the snapshots they need.
export function namedRecordIds(document) {
  const found = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) return found;
  for (const [key, value] of Object.entries(document)) if (/(?:ReceiptId|RequestId)$/.test(key) && typeof value === "string" && value) found.push(value);
  return found;
}

const tail = (relative) => {
  const normalized = String(relative || "").replaceAll("\\", "/");
  for (const marker of ["world-model/current.json", "graph-projection/current.json", "refresh/current.json", "document-projection/post-refresh/current.json"])
    if (normalized === marker || normalized.endsWith("/" + marker)) return marker;
  return null;
};
export const isCurrentPointerRoot = (relative) => tail(relative) !== null;

// Paths of the history records the current pointers name: they are read by
// refresh status and by the next build, so they are not history to a window.
export function currentRecordPaths(roots = []) {
  const named = new Set();
  for (const root of roots) if (isCurrentPointerRoot(root.relative || root.path)) for (const id of root.namedRecordIds || []) named.add(id);
  const paths = new Set();
  for (const root of roots) {
    const name = String(root.relative || root.path || "")
      .replaceAll("\\", "/")
      .split("/")
      .pop()
      .replace(/\.json$/, "");
    if (named.has(name)) paths.add(root.relative || root.path);
  }
  return paths;
}

export function isHistoryRoot(relative, protectedPaths = null) {
  if (isCurrentPointerRoot(relative) || protectedPaths?.has(relative)) return false;
  const normalized = String(relative || "").replaceAll("\\", "/");
  const refresh = normalized.includes("/refresh/") ? normalized.slice(normalized.lastIndexOf("refresh/")) : normalized;
  const projection = normalized.includes("document-projection/post-refresh/")
    ? normalized.slice(normalized.lastIndexOf("document-projection/post-refresh/"))
    : normalized;
  return (
    refresh === "refresh/current.json" ||
    refresh.startsWith("refresh/requests/") ||
    refresh.startsWith("refresh/receipts/") ||
    projection === "document-projection/post-refresh/current.json" ||
    projection.startsWith("document-projection/post-refresh/receipts/")
  );
}

// The file's modification time, or null when the row has none it can trust
// (a snapshot inside the git store carries no time). Such rows are kept.
function mtimeMsOf(row) {
  if (Number.isFinite(row.mtimeMs) && row.mtimeMs > 0) return row.mtimeMs;
  const raw = row.identity?.mtime;
  if (raw == null || !/^\d+$/.test(String(raw))) return null;
  try {
    const value = BigInt(raw);
    const ms = Number(value > 100000000000000n ? value / 1000000n : value);
    return ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

// keepIds are snapshot ids and identity ids that must survive. hardIds are the
// ones a missing file must report. History receipts and parent links are not
// hard: they only order the window. Current pointers (World, Graph, refresh,
// post-refresh) are hard with their ancestry (previousWorldModelId), and so is
// what the refresh pointers name; a snapshot named by hash in a record is kept.
export function selectRetainedSnapshotIds({ snapshots = [], roots = [], policy, nowMs = Date.now() } = {}) {
  if (!policy || policy.preserveAllHistory) return { preserveAllHistory: true, keepIds: null, hardIds: null, reasons: new Map() };
  const byId = new Map();
  for (const row of snapshots)
    for (const id of row.identityIds || [row.id]) {
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(row);
    }
  const protectedPaths = currentRecordPaths(roots);
  const hardIds = new Set();
  const reasons = new Map();
  const addHard = (id, reason = "retained-decision-or-current") => {
    if (!SNAPSHOT_ID.test(id || "")) return;
    hardIds.add(id);
    if (!reasons.has(id)) reasons.set(id, reason);
  };
  const hashes = new Map();
  for (const row of snapshots)
    for (const digest of [row.sha256, row.worldModelHash, row.graphSnapshotHash].filter((value) => /^[a-f0-9]{64}$/.test(value || ""))) {
      if (!hashes.has(digest)) hashes.set(digest, []);
      hashes.get(digest).push(row);
    }
  for (const root of roots) {
    const relative = root.relative || root.path;
    if (isHistoryRoot(relative, protectedPaths)) continue;
    const current = isCurrentPointerRoot(relative) || protectedPaths.has(relative);
    // A current pointer or a record pins every snapshot it names, including the
    // parents it lists (a Capsule's parentSourceSnapshotIds): a window never
    // releases what a record names, so no run can find it missing later.
    for (const id of root.references || []) addHard(id, current ? "retained-current" : "retained-decision-or-current");
    for (const digest of root.requiredWorldHashes || []) if (/^[a-f0-9]{64}$/.test(digest)) addHard("world-model-" + digest.slice(0, 24));
    for (const digest of root.digestReferences || []) for (const row of hashes.get(digest) || []) addHard(row.id, "retained-by-hash");
  }
  // Every published World, by its own write time, whatever its lineage: a
  // sibling published without a parent is as recent as its time says.
  const timed = [];
  const keepIds = new Set(hardIds);
  for (const row of snapshots) {
    if (!String(row.id || "").startsWith("world-model-")) continue;
    if (mtimeMsOf(row) === null) {
      keepIds.add(row.id);
      for (const id of row.identityIds || []) keepIds.add(id);
      if (!reasons.has(row.id)) reasons.set(row.id, "retained-no-trustworthy-time");
      continue;
    }
    if (!timed.some((item) => item.id === row.id)) timed.push(row);
  }
  timed.sort((left, right) => mtimeMsOf(right) - mtimeMsOf(left) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const cutoff = policy.keepDays > 0 ? nowMs - policy.keepDays * 24 * 60 * 60 * 1000 : null;
  timed.forEach((row, index) => {
    const recentCount = index < policy.keepCount;
    const recentAge = cutoff != null && mtimeMsOf(row) >= cutoff;
    if (!recentCount && !recentAge) return;
    keepIds.add(row.id);
    for (const id of row.identityIds || []) keepIds.add(id);
    if (!reasons.has(row.id)) reasons.set(row.id, recentCount ? "retained-recent-count" : "retained-recent-age");
  });
  for (const id of hardIds) for (const row of byId.get(id) || []) for (const identity of row.identityIds || []) keepIds.add(identity);
  const queue = [...keepIds];
  while (queue.length) {
    const id = queue.pop();
    for (const row of byId.get(id) || []) {
      const ancestry = new Set(row.ancestryIds || []);
      for (const dep of row.references || []) {
        if (!dep || ancestry.has(dep) || keepIds.has(dep)) continue;
        keepIds.add(dep);
        reasons.set(dep, "retained-structural-dependency");
        queue.push(dep);
      }
    }
  }
  return { preserveAllHistory: false, keepIds, hardIds, reasons, protectedPaths };
}
