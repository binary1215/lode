import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import {
  ArcadeDbGraphProjectionAdapter,
  ArcadeDbHttpTransport,
  buildGraphProjectionPointer,
} from "./lib/graph-projection-adapter.mjs";
import { buildArcadeDbIncrementalSyncManifest, buildArcadeDbIncrementalSyncReceipt, executeArcadeDbIncrementalSync } from "./lib/arcadedb-incremental-sync.mjs";
import { buildStorageSelection } from "./lib/onboarding-contract.mjs";
import { buildTemporalProvenanceGraph } from "./lib/temporal-provenance.mjs";

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));

class MemorySyncTransport {
  constructor({ failCheckpointAfter = -1 } = {}) {
    this.failCheckpointAfter = failCheckpointAfter;
    this.checkpointFailureUsed = false;
    this.successfulCheckpointWrites = 0;
    this.snapshots = new Map();
    this.pointers = new Map();
    this.topologies = new Map();
    this.manifests = new Map();
    this.checkpoints = new Map();
    this.batchCalls = new Map();
  }

  describe() { return { protocol: "arcadedb-http-json", credentialsPersisted: false }; }
  ensureSchema() {}
  ensureTopologySchema() {}
  ensureSyncSchema() {}
  readPointer(projectId) { return this.pointers.get(projectId) ?? null; }
  readSnapshot(projectId, graphSnapshotId) { return this.snapshots.get(`${projectId}:${graphSnapshotId}`) ?? null; }
  writeSnapshot(projectId, graphSnapshotId, documentJson) {
    const key = `${projectId}:${graphSnapshotId}`;
    const created = !this.snapshots.has(key);
    if (created) this.snapshots.set(key, documentJson);
    return created;
  }
  writePointer(projectId, pointerJson) { this.pointers.set(projectId, pointerJson); }
  writePointerCompareAndSwap(projectId, expectedPointerJson, pointerJson) {
    const current = this.pointers.get(projectId) ?? null;
    if (current !== expectedPointerJson) return false;
    this.pointers.set(projectId, pointerJson);
    return true;
  }
  listSnapshotIds(projectId) {
    return [...this.snapshots.keys()].filter((key) => key.startsWith(`${projectId}:`))
      .map((key) => key.slice(projectId.length + 1)).sort();
  }
  readTopology(projectId, graphSnapshotId) {
    const value = this.topologies.get(`${projectId}:${graphSnapshotId}`);
    return value == null ? null : clone(value);
  }
  writeTopology(projectId, graphSnapshotId, graph, topology) {
    const key = `${projectId}:${graphSnapshotId}`;
    const value = this.topologies.get(key) || {
      topologyJson: null,
      nodeJsons: graph.nodes.map((record) => JSON.stringify(record)),
      edgeJsons: graph.edges.map((record) => JSON.stringify(record)),
    };
    value.topologyJson = JSON.stringify(topology);
    this.topologies.set(key, value);
  }
  readSyncManifest(projectId, syncId) { return this.manifests.get(`${projectId}:${syncId}`) ?? null; }
  writeSyncManifest(projectId, syncId, syncJson) {
    const key = `${projectId}:${syncId}`;
    const existing = this.manifests.get(key);
    if (existing != null && existing !== syncJson) throw Object.assign(new Error("manifest conflict"), { code: "ARCADEDB_INCREMENTAL_SYNC_MANIFEST_CONFLICT" });
    this.manifests.set(key, syncJson);
    return existing == null;
  }
  readSyncCheckpoints(projectId, syncId) {
    const prefix = `${projectId}:${syncId}:`;
    return [...this.checkpoints.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value).sort();
  }
  writeSyncCheckpoint(projectId, syncId, batchId, checkpointJson) {
    if (!this.checkpointFailureUsed && this.failCheckpointAfter >= 0
      && this.successfulCheckpointWrites >= this.failCheckpointAfter) {
      this.checkpointFailureUsed = true;
      throw Object.assign(new Error("checkpoint interruption"), { code: "ARCADEDB_TRANSPORT_UNAVAILABLE" });
    }
    const key = `${projectId}:${syncId}:${batchId}`;
    const existing = this.checkpoints.get(key);
    if (existing != null && existing !== checkpointJson) throw Object.assign(new Error("checkpoint conflict"), { code: "ARCADEDB_INCREMENTAL_SYNC_CHECKPOINT_CONFLICT" });
    this.checkpoints.set(key, checkpointJson);
    if (existing == null) this.successfulCheckpointWrites += 1;
    return existing == null;
  }
  applySyncBatch(projectId, manifest, batch) {
    this.batchCalls.set(batch.batchId, (this.batchCalls.get(batch.batchId) || 0) + 1);
    const targetKey = `${projectId}:${manifest.targetGraphSnapshotId}`;
    const target = this.topologies.get(targetKey) || { topologyJson: null, nodeJsons: [], edgeJsons: [] };
    const base = manifest.baseGraphSnapshotId == null
      ? { nodeJsons: [], edgeJsons: [] }
      : this.topologies.get(`${projectId}:${manifest.baseGraphSnapshotId}`) || { nodeJsons: [], edgeJsons: [] };
    const field = batch.recordKind === "node" ? "nodeJsons" : "edgeJsons";
    const idField = batch.recordKind === "node" ? "nodeId" : "edgeId";
    const baseById = new Map(base[field].map((json) => {
      const record = JSON.parse(json);
      return [record[idField], record];
    }));
    const targetById = new Map(target[field].map((json) => {
      const record = JSON.parse(json);
      return [record[idField], record];
    }));
    for (const record of batch.records) {
      const sourceId = batch.recordKind === "node" ? record.sourceNodeId : record.sourceEdgeId;
      const source = baseById.get(sourceId || record[idField]);
      const value = batch.operation === "carry-forward"
        ? source
        : batch.operation === "rebase"
          ? { ...source, [idField]: record[idField], sourceSnapshotId: manifest.sourceSnapshotId }
          : record;
      if (!value) throw Object.assign(new Error("missing source"), { code: "ARCADEDB_INCREMENTAL_SYNC_BASE_MISSING" });
      if (targetById.has(record[idField])) throw Object.assign(new Error("create-only conflict"), { code: "ARCADEDB_WRITE_OUTCOME_UNKNOWN" });
      targetById.set(record[idField], clone(value));
    }
    target[field] = [...targetById.values()].sort((left, right) => left[idField].localeCompare(right[idField]))
      .map((value) => JSON.stringify(value));
    this.topologies.set(targetKey, target);
    return true;
  }
  readSyncBatchRecords(projectId, graphSnapshotId, batch) {
    const topology = this.topologies.get(`${projectId}:${graphSnapshotId}`) || { nodeJsons: [], edgeJsons: [] };
    const field = batch.recordKind === "node" ? "nodeJsons" : "edgeJsons";
    const idField = batch.recordKind === "node" ? "nodeId" : "edgeId";
    const requested = new Set(batch.records.map((record) => record[idField]));
    return topology[field].filter((json) => requested.has(JSON.parse(json)[idField]));
  }
}

const projectId = "incremental-sync-verifier";
const file = (filePath, content) => ({
  path: filePath,
  digest: digest(content),
  language: "javascript",
  classification: "source",
  symbols: [{ kind: "function", name: filePath.replace(/\W/g, "_"), line: 1 }],
});
const baseGraph = buildTemporalProvenanceGraph({ projectId, files: [file("src/a.mjs", "a")] });
const targetGraph = buildTemporalProvenanceGraph({ projectId, files: [file("src/a.mjs", "a"), file("src/b.mjs", "b")] });
const storageSelection = buildStorageSelection({
  projectId,
  selection: {
    mode: "graphdb",
    endpoint: "https://graph.example.test",
    database: "verifier",
    secretReferenceNames: { username: "HEAD_GRAPHDB_USERNAME", password: "HEAD_GRAPHDB_PASSWORD" },
  },
});

function adapter(transport, baseGraphValue = null) {
  return new ArcadeDbGraphProjectionAdapter({
    storageSelection,
    transport,
    topologyRequired: true,
    incrementalSyncRequired: true,
    baseGraph: baseGraphValue,
  });
}

const transport = new MemorySyncTransport();
const initial = adapter(transport);
(await initial.writeSnapshot(baseGraph.graphSnapshotId, baseGraph));
await initial.writePointer(buildGraphProjectionPointer(baseGraph));
const initialState = initial.takeCompletedIncrementalSync();
assert.equal(initialState.manifest.batchCount > 0, true);

const unchanged = adapter(transport, baseGraph);
(await unchanged.writeSnapshot(baseGraph.graphSnapshotId, baseGraph));
await unchanged.writePointer(buildGraphProjectionPointer(baseGraph));
const unchangedState = unchanged.takeCompletedIncrementalSync();
assert.equal(unchangedState.manifest.noChange, true);
assert.equal(unchangedState.manifest.batchCount, 0);

const delta = adapter(transport, baseGraph);
(await delta.writeSnapshot(targetGraph.graphSnapshotId, targetGraph));
await delta.writePointer(buildGraphProjectionPointer(targetGraph));
const deltaState = delta.takeCompletedIncrementalSync();
assert.equal(deltaState.manifest.nodeDelta.rebased.count > 0, true);
assert.equal(deltaState.manifest.edgeDelta.rebased.count > 0, true);
assert.equal(deltaState.manifest.nodeDelta.added.count + deltaState.manifest.nodeDelta.changed.count < targetGraph.nodes.length, true);
const receipt = buildArcadeDbIncrementalSyncReceipt({
  manifest: deltaState.manifest,
  syncState: deltaState.syncState,
  pointerBefore: deltaState.pointerBefore,
  pointerAfter: deltaState.pointerAfter,
  snapshotVerified: true,
  topologyVerified: true,
  localMirrorVerified: true,
});
assert.equal(receipt.atomicPointerTransitionVerified, true);

const interruptedTransport = new MemorySyncTransport({ failCheckpointAfter: 1 });
const interrupted = adapter(interruptedTransport);
(await assert.rejects(async () => (await interrupted.writeSnapshot(targetGraph.graphSnapshotId, targetGraph)), { code: "ARCADEDB_WRITE_OUTCOME_UNKNOWN" }));
assert.equal(interruptedTransport.readPointer(projectId), null);
const resumed = adapter(interruptedTransport);
(await resumed.writeSnapshot(targetGraph.graphSnapshotId, targetGraph));
await resumed.writePointer(buildGraphProjectionPointer(targetGraph));
assert.equal(resumed.takeCompletedIncrementalSync().syncState.resumedBatchCount > 0, true);

const conflictTransport = new MemorySyncTransport();
const conflict = adapter(conflictTransport);
(await conflict.writeSnapshot(baseGraph.graphSnapshotId, baseGraph));
const externalPointer = buildGraphProjectionPointer(baseGraph);
conflictTransport.pointers.set(projectId, JSON.stringify(externalPointer));
await assert.rejects(() => conflict.writePointer(externalPointer), { code: "ARCADEDB_INCREMENTAL_SYNC_POINTER_CONFLICT" });

class HttpCommandContractTransport extends ArcadeDbHttpTransport {
  constructor() {
    super({ storageSelection });
    this.pointerJson = null;
    this.commands = [];
  }

  invoke(operation, input = {}) {
    this.commands.push({ operation, ...input });
    if (operation === "query") return {
      ok: true,
      status: 200,
      body: { result: this.pointerJson == null ? [] : [{ pointerJson: this.pointerJson }] },
    };
    if (input.command?.startsWith("INSERT INTO HeadAgentGraphPointer")) {
      if (this.pointerJson != null) throw Object.assign(new Error("duplicate pointer"), { code: "ARCADEDB_REQUEST_REJECTED" });
      this.pointerJson = input.params.pointerJson;
    }
    if (input.command?.startsWith("UPDATE HeadAgentGraphPointer")
      && this.pointerJson === input.params.expectedPointerJson) {
      this.pointerJson = input.params.pointerJson;
    }
    return { ok: true, status: 200, body: { result: [] } };
  }
}

const httpContract = new HttpCommandContractTransport();
const firstPointerJson = JSON.stringify(buildGraphProjectionPointer(baseGraph));
const secondPointerJson = JSON.stringify(buildGraphProjectionPointer(targetGraph));
assert.equal(await httpContract.writePointerCompareAndSwap(projectId, null, firstPointerJson), true);
assert.equal(await httpContract.writePointerCompareAndSwap(projectId, firstPointerJson, secondPointerJson), true);
assert.equal(await httpContract.writePointerCompareAndSwap(projectId, firstPointerJson, firstPointerJson), false);
const pointerMutationCommands = httpContract.commands.filter((call) => call.operation === "command");
assert.match(pointerMutationCommands[0].command, /^INSERT INTO HeadAgentGraphPointer/);
assert.match(pointerMutationCommands[1].command, /^UPDATE HeadAgentGraphPointer/);
assert.equal(pointerMutationCommands.some((call) => call.language === "sqlscript" || call.command.includes("LET current")), false);

const initialManifest = buildArcadeDbIncrementalSyncManifest({ targetGraph: baseGraph });
// Public call retry after a lost checkpoint must not reapply exact effects or
// overwrite a later value. Also model a competing writer after the pre-read.
for (const fault of ["exact", "foreign", "partial", "race"]) {
  const remote = new MemorySyncTransport({ failCheckpointAfter: 0 });
  const batch = initialManifest.batches[0];
  const key = `${projectId}:${baseGraph.graphSnapshotId}`;
  const field = batch.recordKind === "node" ? "nodeJsons" : "edgeJsons";
  if (fault === "race") {
    const original = remote.applySyncBatch.bind(remote);
    remote.applySyncBatch = (project, manifest, requested) => {
      remote.topologies.set(key, { topologyJson: null, nodeJsons: [], edgeJsons: [], [field]: [JSON.stringify({ ...batch.records[0], foreign: true })] });
      return original(project, manifest, requested);
    };
  }
  assert.throws(() => executeArcadeDbIncrementalSync({ transport: remote, manifest: initialManifest, targetGraph: baseGraph }), { code: "ARCADEDB_WRITE_OUTCOME_UNKNOWN" });
  const topology = remote.topologies.get(key);
  if (fault === "foreign") topology[field][0] = JSON.stringify({ ...JSON.parse(topology[field][0]), foreign: true });
  if (fault === "partial") { assert.ok(topology[field].length > 1); topology[field].pop(); }
  const before = JSON.stringify(topology[field]);
  if (fault === "exact") executeArcadeDbIncrementalSync({ transport: remote, manifest: initialManifest, targetGraph: baseGraph });
  else assert.throws(() => executeArcadeDbIncrementalSync({ transport: remote, manifest: initialManifest, targetGraph: baseGraph }), {
    code: fault === "partial" ? "ARCADEDB_WRITE_OUTCOME_UNKNOWN" : "ARCADEDB_INCREMENTAL_SYNC_BATCH_CONTENT_MISMATCH",
  });
  assert.equal(remote.batchCalls.get(batch.batchId), 1);
  assert.equal(JSON.stringify(remote.topologies.get(key)[field]), before);
}
const nodeBatch = initialManifest.batches.find((batch) => batch.recordKind === "node");
httpContract.applySyncBatch(projectId, initialManifest, nodeBatch);
assert.match(httpContract.commands.at(-1).command, /INSERT INTO HeadAgentGraphNode/);
assert.doesNotMatch(httpContract.commands.at(-1).command, /UPSERT|UPDATE HeadAgentGraphNode|COMMIT RETRY/);
// Legacy/full-topology publication has the same post-read race boundary.
const transportSource = fs.readFileSync(new URL("./lib/graph-projection-adapter.mjs", import.meta.url), "utf8");
assert.doesNotMatch(transportSource, /UPDATE \$\{ARCADEDB_NODE_TYPE\}.*UPSERT/);
const parallelPairs = new Map();
for (const edge of baseGraph.edges) {
  const key = `${edge.from}:${edge.to}`;
  parallelPairs.set(key, (parallelPairs.get(key) || 0) + 1);
}
assert.equal([...parallelPairs.values()].some((count) => count > 1), true);
const edgeBatch = initialManifest.batches.find((batch) => batch.recordKind === "edge" && batch.operation === "create");
assert.ok(edgeBatch);
httpContract.applySyncBatch(projectId, initialManifest, edgeBatch);
const edgeCommand = httpContract.commands.at(-1);
assert.equal(edgeCommand.operation, "command");
assert.equal(edgeCommand.command.includes("IF NOT EXISTS"), false);

const bridgeSource = fs.readFileSync(new URL("./lib/arcadedb-http-bridge.mjs", import.meta.url), "utf8");
assert.equal(bridgeSource.includes("process.exit(response.ok ? 0 : 3)"), false);
assert.equal(bridgeSource.includes("process.exitCode = response.ok ? 0 : 3"), true);

process.stdout.write(`${JSON.stringify({
  status: "arcadedb_incremental_sync_verified",
  scenarios: ["initial-upload", "no-change", "semantic-rebase-delta", "checkpoint-resume", "pointer-conflict", "receipt", "http-cas-contract", "parallel-edge-command-contract", "bridge-graceful-exit-contract", "exact-no-reapply", "foreign-preserved", "partial-unknown", "post-read-race-create-only"],
  initialBatchCount: initialState.manifest.batchCount,
  deltaBatchCount: deltaState.manifest.batchCount,
  rebasedNodeCount: deltaState.manifest.nodeDelta.rebased.count,
  rebasedEdgeCount: deltaState.manifest.edgeDelta.rebased.count,
  credentialValuesPersisted: false,
  authorityEffect: "none",
}, null, 2)}\n`);
