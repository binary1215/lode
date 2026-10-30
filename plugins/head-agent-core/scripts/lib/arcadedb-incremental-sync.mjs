import crypto from "node:crypto";
import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
import { verifyTemporalProvenanceGraph } from "./temporal-provenance.mjs";

export const ARCADEDB_INCREMENTAL_SYNC_VERSION = "0.1.0";
export const ARCADEDB_INCREMENTAL_SYNC_DEFAULT_BATCH_SIZE = 50;
export const ARCADEDB_INCREMENTAL_SYNC_MAX_BATCH_SIZE = 200;

const fail = (message, code = "ARCADEDB_INCREMENTAL_SYNC_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export const incrementalSyncCanonicalJson = (value) => JSON.stringify(canonical(value));
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));

function contentIdentity(payload, prefix) {
  const hash = digest(incrementalSyncCanonicalJson(payload));
  return { id: `${prefix}-${hash.slice(0, 24)}`, hash };
}

function normalizedBatchSize(value) {
  const size = value == null ? ARCADEDB_INCREMENTAL_SYNC_DEFAULT_BATCH_SIZE : Number(value);
  if (!Number.isInteger(size) || size < 1 || size > ARCADEDB_INCREMENTAL_SYNC_MAX_BATCH_SIZE) {
    fail(`Incremental sync batchSize must be from 1 through ${ARCADEDB_INCREMENTAL_SYNC_MAX_BATCH_SIZE}.`, "ARCADEDB_INCREMENTAL_SYNC_BATCH_SIZE_INVALID");
  }
  return size;
}

function idFor(kind, record) {
  return kind === "node" ? record.nodeId : record.edgeId;
}

function compareById(kind) {
  return (left, right) => String(idFor(kind, left)).localeCompare(String(idFor(kind, right)));
}

function recordDelta(kind, baseRecords, targetRecords) {
  const base = new Map(baseRecords.map((record) => [idFor(kind, record), record]));
  const target = new Map(targetRecords.map((record) => [idFor(kind, record), record]));
  const carried = [];
  const rebased = [];
  const added = [];
  const changed = [];
  const removed = [];
  const usedBaseIds = new Set();
  const unmatchedTargets = [];
  const semanticJson = (record) => {
    const payload = clone(record);
    delete payload.sourceSnapshotId;
    if (kind === "edge") delete payload.edgeId;
    return incrementalSyncCanonicalJson(payload);
  };
  for (const record of [...target.values()].sort(compareById(kind))) {
    const identifier = idFor(kind, record);
    if (!base.has(identifier)) {
      unmatchedTargets.push(record);
      continue;
    }
    const prior = base.get(identifier);
    usedBaseIds.add(identifier);
    if (incrementalSyncCanonicalJson(prior) === incrementalSyncCanonicalJson(record)) carried.push(record);
    else if (semanticJson(prior) === semanticJson(record)) rebased.push({ source: prior, target: record });
    else changed.push(record);
  }
  if (kind === "edge") {
    const candidates = new Map();
    for (const record of [...base.values()].filter((item) => !usedBaseIds.has(idFor(kind, item))).sort(compareById(kind))) {
      const key = semanticJson(record);
      if (!candidates.has(key)) candidates.set(key, []);
      candidates.get(key).push(record);
    }
    for (const record of unmatchedTargets) {
      const matches = candidates.get(semanticJson(record)) || [];
      const prior = matches.shift();
      if (!prior) added.push(record);
      else {
        usedBaseIds.add(prior.edgeId);
        rebased.push({ source: prior, target: record });
      }
    }
  } else added.push(...unmatchedTargets);
  rebased.sort((left, right) => String(idFor(kind, left.target)).localeCompare(String(idFor(kind, right.target))));
  for (const record of [...base.values()].sort(compareById(kind))) {
    if (!usedBaseIds.has(idFor(kind, record))) removed.push(record);
  }
  return { carried, rebased, added, changed, removed };
}

function deltaSummary(kind, delta) {
  const ids = (records) => records.map((record) => idFor(kind, record));
  const summarize = (records) => ({
    count: records.length,
    idSetHash: digest(incrementalSyncCanonicalJson(ids(records))),
  });
  return {
    carried: summarize(delta.carried),
    rebased: summarize(delta.rebased.map((entry) => entry.target)),
    added: summarize(delta.added),
    changed: summarize(delta.changed),
    removed: summarize(delta.removed),
  };
}

function batchRecords(kind, operation, records) {
  if (operation === "carry-forward") {
    return records.map((record) => kind === "node"
      ? { nodeId: record.nodeId }
      : { edgeId: record.edgeId, from: record.from, to: record.to });
  }
  if (operation === "rebase") {
    return records.map(({ source, target }) => kind === "node"
      ? { nodeId: target.nodeId, sourceNodeId: source.nodeId }
      : { edgeId: target.edgeId, sourceEdgeId: source.edgeId, from: target.from, to: target.to });
  }
  return clone(records);
}

function buildBatches({ projectId, baseGraphSnapshotId, targetGraphSnapshotId, kind, operation, records, batchSize, firstIndex, format }) {
  const batches = [];
  for (let offset = 0; offset < records.length; offset += batchSize) {
    const payload = {
      schemaVersion: 1,
      kind: "ArcadeDbIncrementalSyncBatch",
      protocol: { name: format.protocol("head-agent-core-arcadedb-incremental-sync"), version: ARCADEDB_INCREMENTAL_SYNC_VERSION },
      projectId,
      baseGraphSnapshotId,
      targetGraphSnapshotId,
      batchIndex: firstIndex + batches.length,
      recordKind: kind,
      operation,
      records: batchRecords(kind, operation, records.slice(offset, offset + batchSize)),
      authority: "derived-operational-evidence-only",
      instructionAuthority: false,
      promotionAuthority: false,
      credentialValuesPersisted: false,
      serverRecordIdentitySemantic: false,
    };
    const identity = contentIdentity(payload, "arcadedb-sync-batch");
    batches.push({ ...payload, batchId: identity.id, batchHash: identity.hash });
  }
  return batches;
}

export function buildArcadeDbIncrementalSyncManifest({ baseGraph = null, targetGraph, batchSize = null, storage = null } = {}) {
  const format = formatForVerifiedOwner(storage);
  verifyTemporalProvenanceGraph(targetGraph);
  if (targetGraph.protocol.name !== format.protocol("head-agent-core-temporal-provenance")) {
    fail("Incremental sync target has a different storage family.", "ARCADEDB_INCREMENTAL_SYNC_PROJECT_MISMATCH");
  }
  if (baseGraph != null) {
    verifyTemporalProvenanceGraph(baseGraph);
    if (baseGraph.projectId !== targetGraph.projectId || baseGraph.protocol.name !== targetGraph.protocol.name) {
      fail("Incremental sync base and target projects differ.", "ARCADEDB_INCREMENTAL_SYNC_PROJECT_MISMATCH");
    }
  }
  const size = normalizedBatchSize(batchSize);
  const sameSnapshot = baseGraph?.graphSnapshotId === targetGraph.graphSnapshotId
    && baseGraph?.graphSnapshotHash === targetGraph.graphSnapshotHash;
  const nodeDelta = sameSnapshot
    ? { carried: [], rebased: [], added: [], changed: [], removed: [] }
    : recordDelta("node", baseGraph?.nodes || [], targetGraph.nodes);
  const edgeDelta = sameSnapshot
    ? { carried: [], rebased: [], added: [], changed: [], removed: [] }
    : recordDelta("edge", baseGraph?.edges || [], targetGraph.edges);
  const batches = [];
  for (const [kind, operation, records] of [
    ["node", "carry-forward", nodeDelta.carried],
    ["node", "rebase", nodeDelta.rebased],
    ["node", "upsert", [...nodeDelta.added, ...nodeDelta.changed].sort(compareById("node"))],
    ["edge", "carry-forward", edgeDelta.carried],
    ["edge", "rebase", edgeDelta.rebased],
    ["edge", "create", [...edgeDelta.added, ...edgeDelta.changed].sort(compareById("edge"))],
  ]) {
    batches.push(...buildBatches({
      projectId: targetGraph.projectId,
      baseGraphSnapshotId: baseGraph?.graphSnapshotId || null,
      targetGraphSnapshotId: targetGraph.graphSnapshotId,
      kind,
      operation,
      records,
      batchSize: size,
      firstIndex: batches.length,
      format,
    }));
  }
  const payload = {
    schemaVersion: 1,
    kind: "ArcadeDbIncrementalSyncManifest",
    protocol: { name: format.protocol("head-agent-core-arcadedb-incremental-sync"), version: ARCADEDB_INCREMENTAL_SYNC_VERSION },
    projectId: targetGraph.projectId,
    baseGraphSnapshotId: baseGraph?.graphSnapshotId || null,
    baseGraphSnapshotHash: baseGraph?.graphSnapshotHash || null,
    targetGraphSnapshotId: targetGraph.graphSnapshotId,
    targetGraphSnapshotHash: targetGraph.graphSnapshotHash,
    sourceSnapshotId: targetGraph.sourceSnapshotId,
    batchSize: size,
    nodeDelta: deltaSummary("node", nodeDelta),
    edgeDelta: deltaSummary("edge", edgeDelta),
    batches,
    batchCount: batches.length,
    batchSetHash: digest(incrementalSyncCanonicalJson(batches.map((batch) => ({ batchId: batch.batchId, batchHash: batch.batchHash })))),
    noChange: sameSnapshot,
    authority: "derived-operational-evidence-only",
    rebuildableFromLocalGraphSnapshot: true,
    instructionAuthority: false,
    promotionAuthority: false,
    credentialValuesPersisted: false,
    serverRecordIdentitySemantic: false,
  };
  const identity = contentIdentity(payload, "arcadedb-sync");
  return verifyArcadeDbIncrementalSyncManifest({ ...payload, syncId: identity.id, syncHash: identity.hash });
}

function validSummary(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Number.isInteger(value.count) && value.count >= 0 && /^[a-f0-9]{64}$/.test(value.idSetHash || "");
}

export function verifyArcadeDbIncrementalSyncBatch(document) {
  const format = familyFormatForOriginal("head-agent-core-arcadedb-incremental-sync", document);
  if (!document || document.kind !== "ArcadeDbIncrementalSyncBatch" || document.schemaVersion !== 1
    || !format
    || document.protocol?.version !== ARCADEDB_INCREMENTAL_SYNC_VERSION
    || typeof document.projectId !== "string" || !document.projectId
    || (document.baseGraphSnapshotId != null && !/^graph-snapshot-[a-f0-9]{24}$/.test(document.baseGraphSnapshotId))
    || !/^graph-snapshot-[a-f0-9]{24}$/.test(document.targetGraphSnapshotId || "")
    || !Number.isInteger(document.batchIndex) || document.batchIndex < 0
    || !new Set(["node", "edge"]).has(document.recordKind)
    || !new Set(["carry-forward", "rebase", "upsert", "create"]).has(document.operation)
    || (document.recordKind === "node" && document.operation === "create")
    || (document.recordKind === "edge" && document.operation === "upsert")
    || !Array.isArray(document.records) || document.records.length < 1 || document.records.length > ARCADEDB_INCREMENTAL_SYNC_MAX_BATCH_SIZE
    || document.authority !== "derived-operational-evidence-only"
    || document.instructionAuthority !== false || document.promotionAuthority !== false
    || document.credentialValuesPersisted !== false || document.serverRecordIdentitySemantic !== false
    || !/^arcadedb-sync-batch-[a-f0-9]{24}$/.test(document.batchId || "")
    || !/^[a-f0-9]{64}$/.test(document.batchHash || "")) {
    fail("ArcadeDB incremental sync batch is invalid.", "INVALID_ARCADEDB_INCREMENTAL_SYNC_BATCH");
  }
  const identifiers = document.records.map((record) => document.recordKind === "node" ? record?.nodeId : record?.edgeId);
  if (identifiers.some((value) => typeof value !== "string" || !value)
    || new Set(identifiers).size !== identifiers.length
    || incrementalSyncCanonicalJson(identifiers) !== incrementalSyncCanonicalJson([...identifiers].sort())) {
    fail("ArcadeDB incremental sync batch record ordering is invalid.", "INVALID_ARCADEDB_INCREMENTAL_SYNC_BATCH");
  }
  if (new Set(["carry-forward", "rebase"]).has(document.operation) && document.baseGraphSnapshotId == null) {
    fail("Carry-forward and rebase batches require a base GraphSnapshot.", "INVALID_ARCADEDB_INCREMENTAL_SYNC_BATCH");
  }
  if (document.operation === "rebase" && document.records.some((record) => document.recordKind === "node"
    ? typeof record.sourceNodeId !== "string" || !record.sourceNodeId
    : typeof record.sourceEdgeId !== "string" || !record.sourceEdgeId || typeof record.from !== "string" || typeof record.to !== "string")) {
    fail("Rebase batch source identity is invalid.", "INVALID_ARCADEDB_INCREMENTAL_SYNC_BATCH");
  }
  const payload = { ...document };
  delete payload.batchId;
  delete payload.batchHash;
  const identity = contentIdentity(payload, "arcadedb-sync-batch");
  if (document.batchId !== identity.id || document.batchHash !== identity.hash) {
    fail("ArcadeDB incremental sync batch digest verification failed.", "ARCADEDB_INCREMENTAL_SYNC_BATCH_DIGEST_MISMATCH");
  }
  return document;
}

export function verifyArcadeDbIncrementalSyncManifest(document, { baseGraph = null, targetGraph = null } = {}) {
  const format = familyFormatForOriginal("head-agent-core-arcadedb-incremental-sync", document);
  if (!document || document.kind !== "ArcadeDbIncrementalSyncManifest" || document.schemaVersion !== 1
    || !format
    || document.protocol?.version !== ARCADEDB_INCREMENTAL_SYNC_VERSION
    || typeof document.projectId !== "string" || !document.projectId
    || (document.baseGraphSnapshotId != null && !/^graph-snapshot-[a-f0-9]{24}$/.test(document.baseGraphSnapshotId))
    || (document.baseGraphSnapshotHash != null && !/^[a-f0-9]{64}$/.test(document.baseGraphSnapshotHash))
    || ((document.baseGraphSnapshotId == null) !== (document.baseGraphSnapshotHash == null))
    || !/^graph-snapshot-[a-f0-9]{24}$/.test(document.targetGraphSnapshotId || "")
    || !/^[a-f0-9]{64}$/.test(document.targetGraphSnapshotHash || "")
    || !/^source-snapshot-[a-f0-9]{24}$/.test(document.sourceSnapshotId || "")
    || !Number.isInteger(document.batchSize) || document.batchSize < 1 || document.batchSize > ARCADEDB_INCREMENTAL_SYNC_MAX_BATCH_SIZE
    || ![document.nodeDelta, document.edgeDelta].every((delta) => delta && ["carried", "rebased", "added", "changed", "removed"].every((key) => validSummary(delta[key])))
    || !Array.isArray(document.batches) || !Number.isInteger(document.batchCount) || document.batchCount !== document.batches.length
    || !/^[a-f0-9]{64}$/.test(document.batchSetHash || "") || typeof document.noChange !== "boolean"
    || document.authority !== "derived-operational-evidence-only" || document.rebuildableFromLocalGraphSnapshot !== true
    || document.instructionAuthority !== false || document.promotionAuthority !== false
    || document.credentialValuesPersisted !== false || document.serverRecordIdentitySemantic !== false
    || !/^arcadedb-sync-[a-f0-9]{24}$/.test(document.syncId || "") || !/^[a-f0-9]{64}$/.test(document.syncHash || "")) {
    fail("ArcadeDB incremental sync manifest is invalid.", "INVALID_ARCADEDB_INCREMENTAL_SYNC_MANIFEST");
  }
  document.batches.forEach((batch, index) => {
    verifyArcadeDbIncrementalSyncBatch(batch);
    if (batch.protocol.name !== document.protocol.name || batch.projectId !== document.projectId || batch.baseGraphSnapshotId !== document.baseGraphSnapshotId
      || batch.targetGraphSnapshotId !== document.targetGraphSnapshotId || batch.batchIndex !== index
      || batch.records.length > document.batchSize) {
      fail("ArcadeDB incremental sync batch does not match its manifest.", "INVALID_ARCADEDB_INCREMENTAL_SYNC_MANIFEST");
    }
  });
  const batchSetHash = digest(incrementalSyncCanonicalJson(document.batches.map((batch) => ({ batchId: batch.batchId, batchHash: batch.batchHash }))));
  if (document.batchSetHash !== batchSetHash) fail("ArcadeDB incremental sync batch set digest is invalid.", "ARCADEDB_INCREMENTAL_SYNC_BATCH_SET_MISMATCH");
  const payload = { ...document };
  delete payload.syncId;
  delete payload.syncHash;
  const identity = contentIdentity(payload, "arcadedb-sync");
  if (document.syncId !== identity.id || document.syncHash !== identity.hash) {
    fail("ArcadeDB incremental sync manifest digest verification failed.", "ARCADEDB_INCREMENTAL_SYNC_MANIFEST_DIGEST_MISMATCH");
  }
  if (targetGraph) {
    const expected = buildArcadeDbIncrementalSyncManifest({ baseGraph, targetGraph, batchSize: document.batchSize, storage: format });
    if (incrementalSyncCanonicalJson(document) !== incrementalSyncCanonicalJson(expected)) {
      fail("ArcadeDB incremental sync manifest differs from the verified graph delta.", "ARCADEDB_INCREMENTAL_SYNC_MANIFEST_MISMATCH");
    }
  }
  return document;
}

function expectedRecordsForBatch(batch, targetGraph) {
  const kind = batch.recordKind;
  const records = kind === "node" ? targetGraph.nodes : targetGraph.edges;
  const byId = new Map(records.map((record) => [idFor(kind, record), record]));
  return batch.records.map((record) => byId.get(idFor(kind, record))).filter(Boolean).sort(compareById(kind));
}

function buildCheckpoint({ manifest, batch, verifiedRecords }) {
  const format = familyFormatForOriginal("head-agent-core-arcadedb-incremental-sync", manifest);
  const payload = {
    schemaVersion: 1,
    kind: "ArcadeDbIncrementalSyncCheckpoint",
    protocol: { name: format.protocol("head-agent-core-arcadedb-incremental-sync"), version: ARCADEDB_INCREMENTAL_SYNC_VERSION },
    projectId: manifest.projectId,
    syncId: manifest.syncId,
    syncHash: manifest.syncHash,
    targetGraphSnapshotId: manifest.targetGraphSnapshotId,
    batchId: batch.batchId,
    batchHash: batch.batchHash,
    batchIndex: batch.batchIndex,
    recordKind: batch.recordKind,
    operation: batch.operation,
    recordCount: verifiedRecords.length,
    verifiedRecordSetHash: digest(incrementalSyncCanonicalJson(verifiedRecords)),
    status: "verified",
    authority: "derived-operational-evidence-only",
    instructionAuthority: false,
    promotionAuthority: false,
    credentialValuesPersisted: false,
    serverRecordIdentitySemantic: false,
  };
  const identity = contentIdentity(payload, "arcadedb-sync-checkpoint");
  return { ...payload, checkpointId: identity.id, checkpointHash: identity.hash };
}

export function verifyArcadeDbIncrementalSyncCheckpoint(document, { manifest = null, batch = null, expectedRecords = null } = {}) {
  const format = familyFormatForOriginal("head-agent-core-arcadedb-incremental-sync", document);
  if (!document || document.kind !== "ArcadeDbIncrementalSyncCheckpoint" || document.schemaVersion !== 1
    || !format
    || document.protocol?.version !== ARCADEDB_INCREMENTAL_SYNC_VERSION
    || typeof document.projectId !== "string" || !document.projectId
    || !/^arcadedb-sync-[a-f0-9]{24}$/.test(document.syncId || "") || !/^[a-f0-9]{64}$/.test(document.syncHash || "")
    || !/^graph-snapshot-[a-f0-9]{24}$/.test(document.targetGraphSnapshotId || "")
    || !/^arcadedb-sync-batch-[a-f0-9]{24}$/.test(document.batchId || "") || !/^[a-f0-9]{64}$/.test(document.batchHash || "")
    || !Number.isInteger(document.batchIndex) || document.batchIndex < 0
    || !new Set(["node", "edge"]).has(document.recordKind)
    || !new Set(["carry-forward", "rebase", "upsert", "create"]).has(document.operation)
    || !Number.isInteger(document.recordCount) || document.recordCount < 1
    || !/^[a-f0-9]{64}$/.test(document.verifiedRecordSetHash || "") || document.status !== "verified"
    || document.authority !== "derived-operational-evidence-only"
    || document.instructionAuthority !== false || document.promotionAuthority !== false
    || document.credentialValuesPersisted !== false || document.serverRecordIdentitySemantic !== false
    || !/^arcadedb-sync-checkpoint-[a-f0-9]{24}$/.test(document.checkpointId || "") || !/^[a-f0-9]{64}$/.test(document.checkpointHash || "")) {
    fail("ArcadeDB incremental sync checkpoint is invalid.", "INVALID_ARCADEDB_INCREMENTAL_SYNC_CHECKPOINT");
  }
  const payload = { ...document };
  delete payload.checkpointId;
  delete payload.checkpointHash;
  const identity = contentIdentity(payload, "arcadedb-sync-checkpoint");
  if (document.checkpointId !== identity.id || document.checkpointHash !== identity.hash) {
    fail("ArcadeDB incremental sync checkpoint digest verification failed.", "ARCADEDB_INCREMENTAL_SYNC_CHECKPOINT_DIGEST_MISMATCH");
  }
  if (manifest && (document.protocol.name !== manifest.protocol?.name || document.projectId !== manifest.projectId || document.syncId !== manifest.syncId
    || document.syncHash !== manifest.syncHash || document.targetGraphSnapshotId !== manifest.targetGraphSnapshotId)) {
    fail("ArcadeDB incremental sync checkpoint does not match its manifest.", "ARCADEDB_INCREMENTAL_SYNC_CHECKPOINT_MISMATCH");
  }
  if (batch && (document.protocol.name !== batch.protocol?.name || document.batchId !== batch.batchId || document.batchHash !== batch.batchHash
    || document.batchIndex !== batch.batchIndex || document.recordKind !== batch.recordKind
    || document.operation !== batch.operation || document.recordCount !== batch.records.length)) {
    fail("ArcadeDB incremental sync checkpoint does not match its batch.", "ARCADEDB_INCREMENTAL_SYNC_CHECKPOINT_MISMATCH");
  }
  if (expectedRecords && document.verifiedRecordSetHash !== digest(incrementalSyncCanonicalJson(expectedRecords))) {
    fail("ArcadeDB incremental sync checkpoint verification set differs.", "ARCADEDB_INCREMENTAL_SYNC_CHECKPOINT_MISMATCH");
  }
  return document;
}

const SYNC_TRANSPORT_METHODS = [
  "ensureSyncSchema", "readSyncManifest", "writeSyncManifest", "readSyncCheckpoints", "writeSyncCheckpoint",
  "applySyncBatch", "readSyncBatchRecords",
];

function assertSyncTransport(transport) {
  for (const method of SYNC_TRANSPORT_METHODS) if (typeof transport?.[method] !== "function") {
    fail(`ArcadeDB transport is missing incremental sync method ${method}().`, "INVALID_ARCADEDB_INCREMENTAL_SYNC_TRANSPORT");
  }
  return transport;
}

function parseRemoteJson(value, label) {
  try { return JSON.parse(value); }
  catch { fail(`${label} is invalid JSON.`, "ARCADEDB_INCREMENTAL_SYNC_REMOTE_DOCUMENT_INVALID"); }
}

function writeOnce(operation, confirm) {
  try { return operation(); }
  catch (error) {
    if (!["ARCADEDB_TRANSPORT_UNAVAILABLE", "ARCADEDB_WRITE_OUTCOME_UNKNOWN"].includes(error.code)) throw error;
    // UNIQUE is not enough to make SET/UPSERT replay safe. Observe the effect,
    // never repeat it. Absence/partial/unreadable is not proof of non-execution.
    try { if (confirm()) return; } catch { /* retain uncertainty */ }
    fail("Remote write outcome is unknown; reconcile this effect before retrying.", "ARCADEDB_WRITE_OUTCOME_UNKNOWN");
  }
}

export function executeArcadeDbIncrementalSync({ transport, manifest, baseGraph = null, targetGraph, maxRetries = 3 } = {}) {
  const selected = assertSyncTransport(transport);
  verifyTemporalProvenanceGraph(targetGraph);
  const verifiedManifest = verifyArcadeDbIncrementalSyncManifest(manifest, { baseGraph, targetGraph });
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
    fail("ArcadeDB incremental sync maxRetries must be from zero through five.", "ARCADEDB_INCREMENTAL_SYNC_RETRY_INVALID");
  }
  selected.ensureSyncSchema();
  const existingManifestJson = selected.readSyncManifest(verifiedManifest.projectId, verifiedManifest.syncId);
  if (existingManifestJson == null) writeOnce(
    () => selected.writeSyncManifest(verifiedManifest.projectId, verifiedManifest.syncId, incrementalSyncCanonicalJson(verifiedManifest)),
    () => incrementalSyncCanonicalJson(parseRemoteJson(selected.readSyncManifest(verifiedManifest.projectId, verifiedManifest.syncId), "Sync manifest")) === incrementalSyncCanonicalJson(verifiedManifest));
  else if (incrementalSyncCanonicalJson(parseRemoteJson(existingManifestJson, "ArcadeDB sync manifest")) !== incrementalSyncCanonicalJson(verifiedManifest)) {
    fail("ArcadeDB incremental sync manifest conflicts with remote content.", "ARCADEDB_INCREMENTAL_SYNC_MANIFEST_CONFLICT");
  }
  const confirmedManifestJson = selected.readSyncManifest(verifiedManifest.projectId, verifiedManifest.syncId);
  if (confirmedManifestJson == null || incrementalSyncCanonicalJson(parseRemoteJson(confirmedManifestJson, "ArcadeDB sync manifest")) !== incrementalSyncCanonicalJson(verifiedManifest)) {
    fail("ArcadeDB incremental sync manifest write was not verified.", "ARCADEDB_INCREMENTAL_SYNC_MANIFEST_WRITE_MISMATCH");
  }
  const remoteCheckpoints = new Map(selected.readSyncCheckpoints(verifiedManifest.projectId, verifiedManifest.syncId)
    .map((value) => {
      const checkpoint = verifyArcadeDbIncrementalSyncCheckpoint(parseRemoteJson(value, "ArcadeDB sync checkpoint"), { manifest: verifiedManifest });
      return [checkpoint.batchId, checkpoint];
    }));
  let appliedBatchCount = 0;
  let resumedBatchCount = 0;
  let retryCount = 0;
  const checkpoints = [];
  for (const batch of verifiedManifest.batches) {
    const expected = expectedRecordsForBatch(batch, targetGraph);
    if (expected.length !== batch.records.length) {
      fail("ArcadeDB incremental sync batch references missing target records.", "ARCADEDB_INCREMENTAL_SYNC_TARGET_MISMATCH");
    }
    const prior = remoteCheckpoints.get(batch.batchId);
    if (prior) verifyArcadeDbIncrementalSyncCheckpoint(prior, { manifest: verifiedManifest, batch, expectedRecords: expected });
    const readObserved = () => selected.readSyncBatchRecords(verifiedManifest.projectId, verifiedManifest.targetGraphSnapshotId, batch)
      .map((value) => typeof value === "string" ? parseRemoteJson(value, "ArcadeDB sync batch record") : value)
      .sort(compareById(batch.recordKind));
    // A missing checkpoint says nothing about execution. Reconcile every batch,
    // including checkpointed batches, before any new effect. Transport writes
    // must be create-only: the pre-read is not a lock against a concurrent writer.
    const before = readObserved();
    const exact = incrementalSyncCanonicalJson(before) === incrementalSyncCanonicalJson(expected);
    if (!exact) {
      const id = batch.recordKind === "node" ? "nodeId" : "edgeId";
      const expectedById = new Map(expected.map((record) => [record[id], incrementalSyncCanonicalJson(record)]));
      if (before.some((record) => expectedById.get(record[id]) !== incrementalSyncCanonicalJson(record))) {
        fail("Remote batch contains different content; preserve it.", "ARCADEDB_INCREMENTAL_SYNC_BATCH_CONTENT_MISMATCH");
      }
      if (before.length || prior) fail("Remote batch is partial or lost; reconcile without replay.", "ARCADEDB_WRITE_OUTCOME_UNKNOWN");
      writeOnce(() => selected.applySyncBatch(verifiedManifest.projectId, verifiedManifest, batch),
        () => incrementalSyncCanonicalJson(readObserved()) === incrementalSyncCanonicalJson(expected));
      appliedBatchCount += 1;
    } else resumedBatchCount += 1;
    const observed = readObserved();
    if (incrementalSyncCanonicalJson(observed) !== incrementalSyncCanonicalJson(expected)) {
      fail("ArcadeDB incremental sync batch verification failed.", "ARCADEDB_INCREMENTAL_SYNC_BATCH_CONTENT_MISMATCH");
    }
    if (prior) { checkpoints.push(prior); continue; }
    const checkpoint = buildCheckpoint({ manifest: verifiedManifest, batch, verifiedRecords: observed });
    writeOnce(() => selected.writeSyncCheckpoint(verifiedManifest.projectId, verifiedManifest.syncId, batch.batchId, incrementalSyncCanonicalJson(checkpoint)),
      () => selected.readSyncCheckpoints(verifiedManifest.projectId, verifiedManifest.syncId).some((value) => incrementalSyncCanonicalJson(parseRemoteJson(value, "Sync checkpoint")) === incrementalSyncCanonicalJson(checkpoint)));
    checkpoints.push(checkpoint);
  }
  const confirmed = new Map(selected.readSyncCheckpoints(verifiedManifest.projectId, verifiedManifest.syncId).map((value) => {
    const checkpoint = parseRemoteJson(value, "ArcadeDB sync checkpoint");
    return [checkpoint.batchId, checkpoint];
  }));
  for (const batch of verifiedManifest.batches) {
    const expected = expectedRecordsForBatch(batch, targetGraph);
    verifyArcadeDbIncrementalSyncCheckpoint(confirmed.get(batch.batchId), { manifest: verifiedManifest, batch, expectedRecords: expected });
  }
  return {
    status: verifiedManifest.noChange ? "no-change" : "batches-verified",
    manifest: verifiedManifest,
    checkpoints,
    appliedBatchCount,
    resumedBatchCount,
    retryCount,
    authorityEffect: "none",
    credentialValuesPersisted: false,
  };
}

export function buildArcadeDbIncrementalSyncReceipt({ manifest, syncState, pointerBefore = null, pointerAfter, snapshotVerified, topologyVerified, localMirrorVerified } = {}) {
  const verifiedManifest = verifyArcadeDbIncrementalSyncManifest(manifest);
  const format = familyFormatForOriginal("head-agent-core-arcadedb-incremental-sync", verifiedManifest);
  if (!syncState || !Array.isArray(syncState.checkpoints) || !pointerAfter
    || snapshotVerified !== true || topologyVerified !== true || localMirrorVerified !== true) {
    fail("ArcadeDB incremental sync receipt requires complete verification evidence.", "INVALID_ARCADEDB_INCREMENTAL_SYNC_RECEIPT");
  }
  const payload = {
    schemaVersion: 1,
    kind: "ArcadeDbIncrementalSyncReceipt",
    protocol: { name: format.protocol("head-agent-core-arcadedb-incremental-sync"), version: ARCADEDB_INCREMENTAL_SYNC_VERSION },
    projectId: verifiedManifest.projectId,
    syncId: verifiedManifest.syncId,
    syncHash: verifiedManifest.syncHash,
    baseGraphSnapshotId: verifiedManifest.baseGraphSnapshotId,
    targetGraphSnapshotId: verifiedManifest.targetGraphSnapshotId,
    targetGraphSnapshotHash: verifiedManifest.targetGraphSnapshotHash,
    pointerBeforeId: pointerBefore?.pointerId || null,
    pointerAfterId: pointerAfter.pointerId,
    pointerAdvanced: pointerBefore?.pointerId !== pointerAfter.pointerId,
    batchCount: verifiedManifest.batchCount,
    appliedBatchCount: syncState.appliedBatchCount,
    resumedBatchCount: syncState.resumedBatchCount,
    retryCount: syncState.retryCount,
    checkpointSetHash: digest(incrementalSyncCanonicalJson(syncState.checkpoints.map((checkpoint) => ({ checkpointId: checkpoint.checkpointId, checkpointHash: checkpoint.checkpointHash })).sort((left, right) => left.checkpointId.localeCompare(right.checkpointId)))),
    snapshotVerified: true,
    topologyVerified: true,
    localMirrorVerified: true,
    atomicPointerTransitionVerified: true,
    authority: "derived-operational-evidence-only",
    rebuildableFromLocalGraphSnapshot: true,
    instructionAuthority: false,
    promotionAuthority: false,
    credentialValuesPersisted: false,
    serverRecordIdentitySemantic: false,
  };
  const identity = contentIdentity(payload, "arcadedb-sync-receipt");
  return verifyArcadeDbIncrementalSyncReceipt({ ...payload, receiptId: identity.id, receiptHash: identity.hash });
}

export function verifyArcadeDbIncrementalSyncReceipt(document) {
  const format = familyFormatForOriginal("head-agent-core-arcadedb-incremental-sync", document);
  if (!document || document.kind !== "ArcadeDbIncrementalSyncReceipt" || document.schemaVersion !== 1
    || !format
    || document.protocol?.version !== ARCADEDB_INCREMENTAL_SYNC_VERSION
    || typeof document.projectId !== "string" || !document.projectId
    || !/^arcadedb-sync-[a-f0-9]{24}$/.test(document.syncId || "") || !/^[a-f0-9]{64}$/.test(document.syncHash || "")
    || (document.baseGraphSnapshotId != null && !/^graph-snapshot-[a-f0-9]{24}$/.test(document.baseGraphSnapshotId))
    || !/^graph-snapshot-[a-f0-9]{24}$/.test(document.targetGraphSnapshotId || "") || !/^[a-f0-9]{64}$/.test(document.targetGraphSnapshotHash || "")
    || (document.pointerBeforeId != null && !/^graph-projection-pointer-[a-f0-9]{24}$/.test(document.pointerBeforeId))
    || !/^graph-projection-pointer-[a-f0-9]{24}$/.test(document.pointerAfterId || "") || typeof document.pointerAdvanced !== "boolean"
    || ![document.batchCount, document.appliedBatchCount, document.resumedBatchCount, document.retryCount].every((value) => Number.isInteger(value) && value >= 0)
    || document.appliedBatchCount + document.resumedBatchCount !== document.batchCount
    || !/^[a-f0-9]{64}$/.test(document.checkpointSetHash || "")
    || document.snapshotVerified !== true || document.topologyVerified !== true || document.localMirrorVerified !== true
    || document.atomicPointerTransitionVerified !== true || document.authority !== "derived-operational-evidence-only"
    || document.rebuildableFromLocalGraphSnapshot !== true || document.instructionAuthority !== false || document.promotionAuthority !== false
    || document.credentialValuesPersisted !== false || document.serverRecordIdentitySemantic !== false
    || !/^arcadedb-sync-receipt-[a-f0-9]{24}$/.test(document.receiptId || "") || !/^[a-f0-9]{64}$/.test(document.receiptHash || "")) {
    fail("ArcadeDB incremental sync receipt is invalid.", "INVALID_ARCADEDB_INCREMENTAL_SYNC_RECEIPT");
  }
  const payload = { ...document };
  delete payload.receiptId;
  delete payload.receiptHash;
  const identity = contentIdentity(payload, "arcadedb-sync-receipt");
  if (document.receiptId !== identity.id || document.receiptHash !== identity.hash) {
    fail("ArcadeDB incremental sync receipt digest verification failed.", "ARCADEDB_INCREMENTAL_SYNC_RECEIPT_DIGEST_MISMATCH");
  }
  return document;
}
