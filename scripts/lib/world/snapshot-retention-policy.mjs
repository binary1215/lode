import fs from "node:fs";
import path from "node:path";

// Age and count apply only to published World history that nothing the user
// can diff still names. Current worlds, decision/record pins, and the chunks
// those snapshots need stay. An unreadable policy keeps every historical
// snapshot instead of guessing.
export const DEFAULT_SNAPSHOT_RETENTION = Object.freeze({ keepCount: 8, keepDays: 14 });
export const SNAPSHOT_RETENTION_RELATIVE = "refresh/snapshot-retention.json";
const SNAPSHOT_ID = /^(?:world-model|graph-snapshot|source-snapshot)-[a-f0-9]{24}$/;

function parsePolicy(document) {
  if (!document || typeof document !== "object" || Array.isArray(document) || document.schemaVersion !== 1) return null;
  if (JSON.stringify(Object.keys(document).sort()) !== JSON.stringify(["keepCount", "keepDays", "schemaVersion"])) return null;
  if (!Number.isSafeInteger(document.keepCount) || document.keepCount < 1 || document.keepCount > 10000) return null;
  if (!Number.isSafeInteger(document.keepDays) || document.keepDays < 0 || document.keepDays > 3650) return null;
  return { keepCount: document.keepCount, keepDays: document.keepDays };
}

export function resolveSnapshotRetentionPolicy({ root, storage, override = null } = {}) {
  const preserve = (source) => ({ ...DEFAULT_SNAPSHOT_RETENTION, source, preserveAllHistory: true });
  let policy = { ...DEFAULT_SNAPSHOT_RETENTION };
  let source = "default";
  if (root && storage?.directory) {
    const file = path.join(root, storage.directory, SNAPSHOT_RETENTION_RELATIVE);
    if (fs.existsSync(file)) {
      try {
        const parsed = parsePolicy(JSON.parse(fs.readFileSync(file, "utf8")));
        if (!parsed) return preserve("invalid-config-preserve");
        policy = parsed;
        source = "project-file";
      } catch {
        return preserve("invalid-config-preserve");
      }
    }
  }
  if (override && (override.keepCount != null || override.keepDays != null)) {
    const parsed = parsePolicy({
      schemaVersion: 1,
      keepCount: override.keepCount ?? policy.keepCount,
      keepDays: override.keepDays ?? policy.keepDays,
    });
    if (!parsed) return preserve("invalid-override-preserve");
    policy = parsed;
    source = "override";
  }
  return { ...policy, source, preserveAllHistory: false };
}

export function ancestryIdsOf(document) {
  const found = new Set();
  const add = (value) => {
    if (typeof value === "string" && SNAPSHOT_ID.test(value)) found.add(value);
  };
  const walk = (value, key) => {
    if (Array.isArray(value) && (key === "parentSourceSnapshotIds" || key === "parentSnapshotIds")) {
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

export function isHistoryRoot(relative) {
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

function mtimeMsOf(row) {
  if (Number.isFinite(row.mtimeMs)) return row.mtimeMs;
  const raw = row.identity?.mtime;
  if (raw == null || !/^\d+$/.test(String(raw))) return 0;
  try {
    const value = BigInt(raw);
    return Number(value > 100000000000000n ? value / 1000000n : value);
  } catch {
    return 0;
  }
}

// keepIds are snapshot ids and identity ids that must survive. hardIds are the
// ones a missing file must report. History receipts and parent links are not
// hard: they only order the count/age window.
export function selectRetainedSnapshotIds({ snapshots = [], roots = [], policy, nowMs = Date.now() } = {}) {
  if (!policy || policy.preserveAllHistory) return { preserveAllHistory: true, keepIds: null, hardIds: null, reasons: new Map() };
  const byId = new Map();
  for (const row of snapshots)
    for (const id of row.identityIds || [row.id]) {
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(row);
    }
  const hardIds = new Set();
  const addHard = (id) => {
    if (SNAPSHOT_ID.test(id || "")) hardIds.add(id);
  };
  for (const root of roots) {
    if (isHistoryRoot(root.relative || root.path)) continue;
    const ancestry = new Set(root.ancestryIds || []);
    for (const id of root.references || []) if (!ancestry.has(id)) addHard(id);
    for (const digest of root.requiredWorldHashes || []) if (/^[a-f0-9]{64}$/.test(digest)) addHard("world-model-" + digest.slice(0, 24));
  }
  const published = [];
  const seen = new Set();
  const stack = [];
  for (const root of roots) {
    if (
      !String(root.relative || root.path || "")
        .replaceAll("\\", "/")
        .endsWith("world-model/current.json")
    )
      continue;
    const ancestry = new Set(root.ancestryIds || []);
    for (const id of root.references || []) if (id.startsWith("world-model-") && !ancestry.has(id)) stack.push(id);
  }
  while (stack.length) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    for (const row of byId.get(id) || []) {
      if (String(row.id || "").startsWith("world-model-") && !published.some((item) => item.id === row.id)) published.push(row);
      for (const parent of row.ancestryIds || []) if (!seen.has(parent)) stack.push(parent);
    }
  }
  published.sort((left, right) => mtimeMsOf(right) - mtimeMsOf(left) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const keepIds = new Set(hardIds);
  const reasons = new Map();
  for (const id of hardIds) reasons.set(id, "retained-decision-or-current");
  const cutoff = policy.keepDays > 0 ? nowMs - policy.keepDays * 24 * 60 * 60 * 1000 : null;
  published.forEach((row, index) => {
    const recentCount = index < policy.keepCount;
    const recentAge = cutoff != null && mtimeMsOf(row) >= cutoff;
    if (!recentCount && !recentAge) return;
    keepIds.add(row.id);
    for (const id of row.identityIds || []) keepIds.add(id);
    if (!reasons.has(row.id)) reasons.set(row.id, recentCount ? "retained-recent-count" : "retained-recent-age");
  });
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
  return { preserveAllHistory: false, keepIds, hardIds, reasons };
}
