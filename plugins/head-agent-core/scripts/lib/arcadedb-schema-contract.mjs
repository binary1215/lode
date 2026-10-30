import { formatForVerifiedOwner } from "./project-storage-format.mjs";

// Only the owned semantic keys, not a general database migration engine.
export const ARCADEDB_REQUIRED_KEYS = Object.freeze(Object.fromEntries(Object.entries({
  HeadAgentGraphSnapshot: ["projectId", "graphSnapshotId"],
  HeadAgentGraphSnapshotChunk: ["projectId", "graphSnapshotId", "chunkIndex"],
  HeadAgentGraphPointer: ["projectId"],
  HeadAgentGraphNode: ["projectId", "graphSnapshotId", "nodeId"],
  HeadAgentGraphEdge: ["projectId", "graphSnapshotId", "edgeId"],
  HeadAgentGraphTopology: ["projectId", "graphSnapshotId"],
  HeadAgentGraphTopologyChunk: ["projectId", "graphSnapshotId", "chunkIndex"],
  HeadAgentGraphSyncManifest: ["projectId", "syncId"],
  HeadAgentGraphSyncCheckpoint: ["projectId", "syncId", "batchId"],
}).map(([name, keys]) => [name, Object.freeze(keys)])));

export function arcadeDbRequiredKeysFor(owner) {
  const format = formatForVerifiedOwner(owner);
  return Object.freeze(Object.fromEntries(Object.entries(ARCADEDB_REQUIRED_KEYS)
    .map(([name, keys]) => [format.kind(name), keys])));
}

const keysByName = Object.freeze({
  ...ARCADEDB_REQUIRED_KEYS,
  LodeAgentGraphSnapshot: ARCADEDB_REQUIRED_KEYS.HeadAgentGraphSnapshot,
  LodeAgentGraphSnapshotChunk: ARCADEDB_REQUIRED_KEYS.HeadAgentGraphSnapshotChunk,
  LodeAgentGraphPointer: ARCADEDB_REQUIRED_KEYS.HeadAgentGraphPointer,
  LodeAgentGraphNode: ARCADEDB_REQUIRED_KEYS.HeadAgentGraphNode,
  LodeAgentGraphEdge: ARCADEDB_REQUIRED_KEYS.HeadAgentGraphEdge,
  LodeAgentGraphTopology: ARCADEDB_REQUIRED_KEYS.HeadAgentGraphTopology,
  LodeAgentGraphTopologyChunk: ARCADEDB_REQUIRED_KEYS.HeadAgentGraphTopologyChunk,
  LodeAgentGraphSyncManifest: ARCADEDB_REQUIRED_KEYS.HeadAgentGraphSyncManifest,
  LodeAgentGraphSyncCheckpoint: ARCADEDB_REQUIRED_KEYS.HeadAgentGraphSyncCheckpoint,
});

export function requiredIndexDdl(name) {
  const keys = keysByName[name];
  if (!keys) throw new Error("Unknown HEAD reserved type");
  return `CREATE INDEX IF NOT EXISTS ON ${name} (${keys.join(", ")}) UNIQUE`;
}

export function inspectRequiredIndex(record) {
  const keys = keysByName[record.name];
  if (!keys) throw new Error("Unknown HEAD reserved type");
  if (!Array.isArray(record.indexes)) return { status: "unverifiable", reason: "index-metadata-unavailable" };
  let matching = false;
  for (const index of record.indexes) {
    if (!index || !Array.isArray(index.properties) || index.properties.some((key) => typeof key !== "string") || typeof index.unique !== "boolean") {
      return { status: "unverifiable", reason: "index-metadata-incomplete" };
    }
    if (JSON.stringify(index.properties) === JSON.stringify(keys)) {
      if (!index.unique) return { status: "conflict", reason: "required-key-not-unique" };
      if (index.status != null && !["AVAILABLE", "ONLINE", "VALID"].includes(String(index.status).toUpperCase())) return { status: "unverifiable", reason: "required-index-not-ready" };
      matching = true;
    } else if (index.unique && !keys.every((key) => index.properties.includes(key))) {
      return { status: "conflict", reason: "additional-unique-key-restricts-head-writes" };
    }
  }
  return { status: matching ? "compatible" : "missing", reason: matching ? "required-unique-key-verified" : "required-index-missing" };
}
