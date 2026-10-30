import { verifyLooseSnapshotAddress } from "./snapshot-backend-reclamation.mjs";
import { withSnapshotReferences, withSnapshotReferencesAsync } from "./snapshot-reference-lifetime.mjs";
import { DOMAIN_BUNDLE_LAYOUT, SHARED_DOMAIN_LAYOUT, createSnapshotComposition, hydrateSnapshotEntry } from "./snapshot-domain-bundles.mjs";
import { GitSnapshotStore } from "./git-snapshot-store.mjs";
import { storedSnapshotLocation, readSnapshotFile, writeStoredSnapshot, listStoredSnapshotIds } from "./snapshot-storage-codec.mjs";
import crypto from "node:crypto";
import { formatForVerifiedOwner, familyFormatForOriginal, relativeProjectArtifact, projectOwnsRecordedRoot } from "./project-storage-format.mjs";
import { requiredIndexDdl, inspectRequiredIndex } from "./arcadedb-schema-contract.mjs";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { ONBOARDING_STORAGE_DIRECTORY, verifyOnboardingState, verifyStorageSelection } from "./onboarding-contract.mjs";
import { queryTemporalProvenanceGraph, verifyTemporalProvenanceGraph, createTemporalVerificationScope, ownWorldSnapshotForTemporalScope } from "./temporal-provenance.mjs";
import { resolveVerifiedArcadeDbNativeBridge } from "./arcadedb-native-bridge.mjs";
import {
  ARCADEDB_INCREMENTAL_SYNC_VERSION,
  buildArcadeDbIncrementalSyncReceipt,
  buildArcadeDbIncrementalSyncManifest,
  executeArcadeDbIncrementalSync,
  incrementalSyncCanonicalJson,
  verifyArcadeDbIncrementalSyncReceipt,
  verifyArcadeDbIncrementalSyncManifest,
} from "./arcadedb-incremental-sync.mjs";

export const GRAPH_PROJECTION_ADAPTER_VERSION = "0.1.0";
export const GRAPH_PROJECTION_CONTRACT = "replaceable-rebuildable-derived-graph-projection";
export const ARCADEDB_GRAPH_PROJECTION_VERSION = "0.1.0";
export const ARCADEDB_GRAPH_TOPOLOGY_VERSION = "0.1.0";
export const ARCADEDB_SERVER_TRAVERSAL_VERSION = "0.1.0";
export const PREPARED_TRAVERSAL_VERSION = "0.1.0";
export const ARCADEDB_BRIDGE_BATCH_VERSION = "0.1.0";

const ARCADEDB_NATIVE_BATCH_MODES = new Set(["auto", "off", "required"]);
const ARCADEDB_BRIDGE_ENVIRONMENT_ALLOWLIST = Object.freeze([
  "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR",
  "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
]);

const ARCADEDB_SNAPSHOT_TYPE = "HeadAgentGraphSnapshot";
const ARCADEDB_SNAPSHOT_CHUNK_TYPE = "HeadAgentGraphSnapshotChunk";
const ARCADEDB_POINTER_TYPE = "HeadAgentGraphPointer";
const ARCADEDB_NODE_TYPE = "HeadAgentGraphNode";
const ARCADEDB_EDGE_TYPE = "HeadAgentGraphEdge";
const ARCADEDB_TOPOLOGY_TYPE = "HeadAgentGraphTopology";
const ARCADEDB_TOPOLOGY_CHUNK_TYPE = "HeadAgentGraphTopologyChunk";
const ARCADEDB_SYNC_TYPE = "HeadAgentGraphSyncManifest";
const ARCADEDB_SYNC_CHECKPOINT_TYPE = "HeadAgentGraphSyncCheckpoint";
export const ARCADEDB_GRAPH_RESERVED_SCHEMA = Object.freeze([
  Object.freeze({ name: ARCADEDB_SNAPSHOT_TYPE, type: "document", properties: Object.freeze({ projectId: "STRING", graphSnapshotId: "STRING", graphSnapshotHash: "STRING", sourceSnapshotId: "STRING", documentJson: "STRING" }) }),
  Object.freeze({ name: ARCADEDB_SNAPSHOT_CHUNK_TYPE, type: "document", properties: Object.freeze({ projectId: "STRING", graphSnapshotId: "STRING", chunkIndex: "INTEGER", chunkJson: "STRING" }) }),
  Object.freeze({ name: ARCADEDB_POINTER_TYPE, type: "document", properties: Object.freeze({ projectId: "STRING", pointerJson: "STRING" }) }),
  Object.freeze({ name: ARCADEDB_NODE_TYPE, type: "vertex", properties: Object.freeze({ projectId: "STRING", graphSnapshotId: "STRING", graphSnapshotHash: "STRING", sourceSnapshotId: "STRING", nodeId: "STRING", nodeKind: "STRING", nodeJson: "STRING" }) }),
  Object.freeze({ name: ARCADEDB_EDGE_TYPE, type: "edge", properties: Object.freeze({ projectId: "STRING", graphSnapshotId: "STRING", graphSnapshotHash: "STRING", sourceSnapshotId: "STRING", edgeId: "STRING", edgeType: "STRING", edgeJson: "STRING" }) }),
  Object.freeze({ name: ARCADEDB_TOPOLOGY_TYPE, type: "document", properties: Object.freeze({ projectId: "STRING", graphSnapshotId: "STRING", topologyId: "STRING", topologyJson: "STRING" }) }),
  Object.freeze({ name: ARCADEDB_TOPOLOGY_CHUNK_TYPE, type: "document", properties: Object.freeze({ projectId: "STRING", graphSnapshotId: "STRING", chunkIndex: "INTEGER", chunkJson: "STRING" }) }),
  Object.freeze({ name: ARCADEDB_SYNC_TYPE, type: "document", properties: Object.freeze({ projectId: "STRING", syncId: "STRING", syncJson: "STRING" }) }),
  Object.freeze({ name: ARCADEDB_SYNC_CHECKPOINT_TYPE, type: "document", properties: Object.freeze({ projectId: "STRING", syncId: "STRING", batchId: "STRING", checkpointJson: "STRING" }) }),
]);
export function arcadeDbGraphReservedSchemaFor(storage = null) {
  const format = formatForVerifiedOwner(storage);
  return ARCADEDB_GRAPH_RESERVED_SCHEMA.map(entry => ({ ...entry, name: format.kind(entry.name) }));
}

const ARCADEDB_ACTIVATION_DIRECTORY = path.join(".head", "graph-projection", "arcadedb", "activations");
const ARCADEDB_CONFORMANCE_DIRECTORY = path.join(".head", "graph-projection", "arcadedb", "conformance");
const ARCADEDB_ACTIVATION_POINTER = path.join(".head", "graph-projection", "arcadedb", "current.json");
const ARCADEDB_TOPOLOGY_ACTIVATION_DIRECTORY = path.join(".head", "graph-projection", "arcadedb", "topology", "activations");
const ARCADEDB_TOPOLOGY_ACTIVATION_POINTER = path.join(".head", "graph-projection", "arcadedb", "topology", "current.json");
const ARCADEDB_INCREMENTAL_SYNC_RECEIPT_DIRECTORY = path.join(".head", "graph-projection", "arcadedb", "sync", "receipts");
const ARCADEDB_INCREMENTAL_SYNC_RECEIPT_POINTER = path.join(".head", "graph-projection", "arcadedb", "sync", "current.json");
const ARCADEDB_TRANSPORT_METHODS = ["describe", "ensureSchema", "readPointer", "readSnapshot", "writePointer", "writeSnapshot", "listSnapshotIds"];
const ARCADEDB_TOPOLOGY_TRANSPORT_METHODS = ["ensureTopologySchema", "readTopology", "writeTopology"];
const ARCADEDB_SERVER_TRAVERSAL_TRANSPORT_METHODS = ["queryTopology"];
const ARCADEDB_PREPARED_TRAVERSAL_TRANSPORT_METHODS = ["readTopologyManifest", "queryTopology"];
const ARCADEDB_INCREMENTAL_SYNC_TRANSPORT_METHODS = [
  "ensureSyncSchema", "readSyncManifest", "writeSyncManifest", "readSyncCheckpoints", "writeSyncCheckpoint",
  "applySyncBatch", "readSyncBatchRecords", "writePointerCompareAndSwap",
];
const ARCADEDB_SERVER_TRAVERSAL_MODE = "server-expanded-client-canonicalized";
const ARCADEDB_SERVER_TRAVERSAL_MAX_RECORDS = 8192;
const ARCADEDB_SNAPSHOT_CHUNK_BYTES = 8 * 1024;
const PREPARED_TRAVERSAL_ORDERING = "record-depth-then-semantic-id-ascending";
const BRIDGE_FILE = fileURLToPath(new URL("./arcadedb-http-bridge.mjs", import.meta.url));
const PLUGIN_ROOT = path.resolve(path.dirname(BRIDGE_FILE), "..", "..");
const PREPARED_POINTER_READ_TOKEN = Symbol("head-agent-prepared-pointer-read-token");
const preparedPointerReads = new WeakMap();

const REQUIRED_METHODS = [
  "describe",
  "readPointer",
  "readSnapshot",
  "writePointer",
  "writeSnapshot",
  "listSnapshotIds",
  "query",
];

const fail = (message, code = "GRAPH_PROJECTION_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

function assertFields(value, fields, label, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} is invalid.`, code);
  const expected = new Set(fields);
  const unexpected = Object.keys(value).filter((field) => !expected.has(field));
  const missing = fields.filter((field) => !(field in value));
  if (unexpected.length || missing.length) fail(`${label} fields are invalid.`, code);
}

function bindPreparedPointerRead(adapter, entry) {
  if (entry == null) return null;
  const token = Object.freeze({});
  preparedPointerReads.set(token, { adapter, entry: clone(entry) });
  return { ...entry, [PREPARED_POINTER_READ_TOKEN]: token };
}

function consumePreparedPointerRead(adapter, token) {
  if (!token || typeof token !== "object") return null;
  const bound = preparedPointerReads.get(token);
  preparedPointerReads.delete(token);
  return bound?.adapter === adapter ? clone(bound.entry) : null;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const child = canonical(value[key]);
      if (Object.hasOwn(Object.prototype, key)) Object.defineProperty(result, key, { value: child, writable: true, enumerable: true, configurable: true });
      else result[key] = child;
    }
    return result;
  }
  return value;
}

export function graphProjectionCanonicalJson(value) {
  return JSON.stringify(canonical(value));
}

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const clone = (value) => JSON.parse(JSON.stringify(value));

function graphSnapshotId(value) {
  if (typeof value !== "string" || !/^graph-snapshot-[a-f0-9]{24}$/.test(value)) {
    fail("GraphSnapshot id is invalid.", "INVALID_GRAPH_SNAPSHOT_ID");
  }
  return value;
}

function parseDocument(file, label) {
  try { return file.endsWith(".json.gz") ? readSnapshotFile(file).document : JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    // Corrupt encoding is a document error; operational failures keep their code.
    if (file.endsWith(".json.gz") && error.code && error.code !== "INVALID_SNAPSHOT_ENCODING") throw error;
    fail(`${label} is invalid JSON: ${error.message}`, "INVALID_GRAPH_PROJECTION_DOCUMENT");
  }
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function assertGraphProjectionAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") fail("A GraphProjectionAdapter object is required.", "INVALID_GRAPH_PROJECTION_ADAPTER");
  if (adapter.adapterVersion !== GRAPH_PROJECTION_ADAPTER_VERSION) {
    fail(`GraphProjectionAdapter version must be ${GRAPH_PROJECTION_ADAPTER_VERSION}.`, "INCOMPATIBLE_GRAPH_PROJECTION_ADAPTER");
  }
  for (const method of REQUIRED_METHODS) if (typeof adapter[method] !== "function") {
    fail(`GraphProjectionAdapter is missing ${method}().`, "INVALID_GRAPH_PROJECTION_ADAPTER");
  }
  const descriptor = adapter.describe();
  if (!descriptor || descriptor.contract !== GRAPH_PROJECTION_CONTRACT
    || typeof descriptor.adapterKind !== "string" || !descriptor.adapterKind.trim()
    || descriptor.adapterVersion !== GRAPH_PROJECTION_ADAPTER_VERSION) {
    fail("GraphProjectionAdapter descriptor is invalid.", "INVALID_GRAPH_PROJECTION_ADAPTER");
  }
  if (descriptor.authority !== "derived-evidence-only" || descriptor.instructionAuthority !== false
    || descriptor.promotionAuthority !== false || descriptor.rebuildable !== true || descriptor.uniqueAuthority !== false) {
    fail("GraphProjectionAdapter cannot claim canon, instruction, promotion, or unique authority.", "INVALID_GRAPH_PROJECTION_AUTHORITY");
  }
  if (typeof descriptor.remote !== "boolean" || typeof descriptor.durable !== "boolean") {
    fail("GraphProjectionAdapter must disclose remote and durable behavior.", "INVALID_GRAPH_PROJECTION_ADAPTER");
  }
  if (descriptor.preparedTraversalProtocolVersion != null
    && (descriptor.preparedTraversalProtocolVersion !== PREPARED_TRAVERSAL_VERSION
      || typeof descriptor.preparedTraversalMode !== "string" || !descriptor.preparedTraversalMode.trim()
      || typeof adapter.queryPrepared !== "function")) {
    fail("GraphProjectionAdapter prepared traversal capability is invalid.", "INVALID_GRAPH_PROJECTION_ADAPTER");
  }
  return adapter;
}

function pointerPayload(graph, storage = null) {
  if (storage != null && !familyFormatForOriginal("head-agent-core-temporal-provenance", graph, storage)) fail("Graph pointer owner family is incoherent.", "INVALID_GRAPH_PROJECTION_POINTER");
  return {
    schemaVersion: 1,
    kind: "GraphProjectionPointer",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-graph-projection"), version: GRAPH_PROJECTION_ADAPTER_VERSION },
    projectId: graph.projectId,
    graphSnapshotId: graph.graphSnapshotId,
    graphSnapshotHash: graph.graphSnapshotHash,
    sourceSnapshotId: graph.sourceSnapshotId,
    authority: "derived-evidence-only",
    rebuildable: true,
    uniqueAuthority: false,
    instructionAuthority: false,
    promotionAuthority: false,
  };
}

function pointerFor(graph, storage = null) {
  const payload = pointerPayload(graph, storage);
  const pointerHash = digest(graphProjectionCanonicalJson(payload));
  return { ...payload, pointerId: `graph-projection-pointer-${pointerHash.slice(0, 24)}`, pointerHash };
}

export function buildGraphProjectionPointer(graph, storage = null) {
  verifyTemporalProvenanceGraph(graph);
  return pointerFor(graph, storage);
}

export function verifyGraphProjectionPointer(document, expectedGraph = null, storage = null) {
  if (!document || document.kind !== "GraphProjectionPointer" || document.schemaVersion !== 1
    || !familyFormatForOriginal("head-agent-core-graph-projection", document, storage)
    || document.protocol?.version !== GRAPH_PROJECTION_ADAPTER_VERSION
    || typeof document.projectId !== "string" || !document.projectId
    || !/^graph-snapshot-[a-f0-9]{24}$/.test(document.graphSnapshotId || "")
    || !/^[a-f0-9]{64}$/.test(document.graphSnapshotHash || "")
    || !/^source-snapshot-[a-f0-9]{24}$/.test(document.sourceSnapshotId || "")
    || document.authority !== "derived-evidence-only" || document.rebuildable !== true || document.uniqueAuthority !== false
    || document.instructionAuthority !== false || document.promotionAuthority !== false) {
    fail("Graph projection pointer is invalid.", "INVALID_GRAPH_PROJECTION_POINTER");
  }
  const payload = { ...document };
  delete payload.pointerId;
  delete payload.pointerHash;
  const pointerHash = digest(graphProjectionCanonicalJson(payload));
  if (document.pointerHash !== pointerHash || document.pointerId !== `graph-projection-pointer-${pointerHash.slice(0, 24)}`) {
    fail("Graph projection pointer digest verification failed.", "GRAPH_PROJECTION_POINTER_DIGEST_MISMATCH");
  }
  if (expectedGraph && (document.projectId !== expectedGraph.projectId
    || document.graphSnapshotId !== expectedGraph.graphSnapshotId
    || document.graphSnapshotHash !== expectedGraph.graphSnapshotHash
    || document.sourceSnapshotId !== expectedGraph.sourceSnapshotId)) {
    fail("Graph projection pointer does not match the expected GraphSnapshot.", "GRAPH_PROJECTION_STALE");
  }
  return document;
}

function topologyPayload(graph, storage = null) {
  verifyTemporalProvenanceGraph(graph);
  if (storage != null && !familyFormatForOriginal("head-agent-core-temporal-provenance", graph, storage)) fail("Graph topology owner family is incoherent.", "INVALID_ARCADEDB_GRAPH_TOPOLOGY");
  return {
    schemaVersion: 1,
    kind: "ArcadeDbGraphTopology",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-arcadedb-graph-topology"), version: ARCADEDB_GRAPH_TOPOLOGY_VERSION },
    projectId: graph.projectId,
    graphSnapshotId: graph.graphSnapshotId,
    graphSnapshotHash: graph.graphSnapshotHash,
    sourceSnapshotId: graph.sourceSnapshotId,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    nodeSetHash: digest(graphProjectionCanonicalJson(graph.nodes)),
    edgeSetHash: digest(graphProjectionCanonicalJson(graph.edges)),
    authority: "derived-evidence-only",
    rebuildable: true,
    uniqueAuthority: false,
    instructionAuthority: false,
    promotionAuthority: false,
    serverRecordIdentitySemantic: false,
  };
}

export function buildArcadeDbGraphTopology(graph, storage = null) {
  const payload = topologyPayload(graph, storage);
  const topologyHash = digest(graphProjectionCanonicalJson(payload));
  return { ...payload, topologyId: `arcadedb-graph-topology-${topologyHash.slice(0, 24)}`, topologyHash };
}

export function verifyArcadeDbGraphTopology(document, graph = null, storage = null) {
  assertFields(document, [
    "schemaVersion", "kind", "protocol", "projectId", "graphSnapshotId", "graphSnapshotHash", "sourceSnapshotId", "nodeCount",
    "edgeCount", "nodeSetHash", "edgeSetHash", "authority", "rebuildable", "uniqueAuthority", "instructionAuthority",
    "promotionAuthority", "serverRecordIdentitySemantic", "topologyId", "topologyHash",
  ], "ArcadeDB graph topology", "INVALID_ARCADEDB_GRAPH_TOPOLOGY");
  if (!document || document.kind !== "ArcadeDbGraphTopology" || document.schemaVersion !== 1
    || !familyFormatForOriginal("head-agent-core-arcadedb-graph-topology", document, storage)
    || document.protocol?.version !== ARCADEDB_GRAPH_TOPOLOGY_VERSION
    || typeof document.projectId !== "string" || !document.projectId
    || !/^graph-snapshot-[a-f0-9]{24}$/.test(document.graphSnapshotId || "")
    || !/^[a-f0-9]{64}$/.test(document.graphSnapshotHash || "")
    || !/^source-snapshot-[a-f0-9]{24}$/.test(document.sourceSnapshotId || "")
    || !Number.isInteger(document.nodeCount) || document.nodeCount < 0
    || !Number.isInteger(document.edgeCount) || document.edgeCount < 0
    || !/^[a-f0-9]{64}$/.test(document.nodeSetHash || "") || !/^[a-f0-9]{64}$/.test(document.edgeSetHash || "")
    || document.authority !== "derived-evidence-only" || document.rebuildable !== true || document.uniqueAuthority !== false
    || document.instructionAuthority !== false || document.promotionAuthority !== false || document.serverRecordIdentitySemantic !== false
    || !/^arcadedb-graph-topology-[a-f0-9]{24}$/.test(document.topologyId || "")
    || !/^[a-f0-9]{64}$/.test(document.topologyHash || "")) {
    fail("ArcadeDB graph topology is invalid.", "INVALID_ARCADEDB_GRAPH_TOPOLOGY");
  }
  const payload = { ...document };
  delete payload.topologyId;
  delete payload.topologyHash;
  const hash = digest(graphProjectionCanonicalJson(payload));
  if (document.topologyHash !== hash || document.topologyId !== `arcadedb-graph-topology-${hash.slice(0, 24)}`) {
    fail("ArcadeDB graph topology digest verification failed.", "ARCADEDB_GRAPH_TOPOLOGY_DIGEST_MISMATCH");
  }
  if (graph) {
    const expectedPayload = topologyPayload(graph);
    expectedPayload.protocol = document.protocol;
    const expectedHash = digest(graphProjectionCanonicalJson(expectedPayload));
    const expected = { ...expectedPayload, topologyId: `arcadedb-graph-topology-${expectedHash.slice(0, 24)}`, topologyHash: expectedHash };
    if (graphProjectionCanonicalJson(document) !== graphProjectionCanonicalJson(expected)) {
      fail("ArcadeDB graph topology does not match the expected GraphSnapshot.", "ARCADEDB_GRAPH_TOPOLOGY_MISMATCH");
    }
  }
  return document;
}

function descriptor(adapterKind, { remote, durable }) {
  return {
    contract: GRAPH_PROJECTION_CONTRACT,
    adapterKind,
    adapterVersion: GRAPH_PROJECTION_ADAPTER_VERSION,
    authority: "derived-evidence-only",
    rebuildable: true,
    uniqueAuthority: false,
    instructionAuthority: false,
    promotionAuthority: false,
    remote,
    durable,
  };
}

function assertArcadeDbTransport(transport) {
  if (!transport || typeof transport !== "object") fail("An ArcadeDB transport is required.", "INVALID_ARCADEDB_TRANSPORT");
  for (const method of ARCADEDB_TRANSPORT_METHODS) if (typeof transport[method] !== "function") {
    fail(`ArcadeDB transport is missing ${method}().`, "INVALID_ARCADEDB_TRANSPORT");
  }
  const described = transport.describe();
  if (!described || described.protocol !== "arcadedb-http-json" || described.credentialsPersisted !== false) {
    fail("ArcadeDB transport descriptor is invalid.", "INVALID_ARCADEDB_TRANSPORT");
  }
  return transport;
}

function assertArcadeDbTopologyTransport(transport) {
  for (const method of ARCADEDB_TOPOLOGY_TRANSPORT_METHODS) if (typeof transport?.[method] !== "function") {
    fail(`ArcadeDB transport is missing topology method ${method}().`, "INVALID_ARCADEDB_TOPOLOGY_TRANSPORT");
  }
  return transport;
}

function assertArcadeDbServerTraversalTransport(transport) {
  for (const method of ARCADEDB_SERVER_TRAVERSAL_TRANSPORT_METHODS) if (typeof transport?.[method] !== "function") {
    fail(`ArcadeDB transport is missing server traversal method ${method}().`, "INVALID_ARCADEDB_SERVER_TRAVERSAL_TRANSPORT");
  }
  return transport;
}

function assertArcadeDbPreparedTraversalTransport(transport) {
  for (const method of ARCADEDB_PREPARED_TRAVERSAL_TRANSPORT_METHODS) if (typeof transport?.[method] !== "function") {
    fail(`ArcadeDB transport is missing prepared traversal method ${method}().`, "INVALID_ARCADEDB_PREPARED_TRAVERSAL_TRANSPORT");
  }
  return transport;
}

function assertArcadeDbIncrementalSyncTransport(transport) {
  for (const method of ARCADEDB_INCREMENTAL_SYNC_TRANSPORT_METHODS) if (typeof transport?.[method] !== "function") {
    fail(`ArcadeDB transport is missing incremental sync method ${method}().`, "INVALID_ARCADEDB_INCREMENTAL_SYNC_TRANSPORT");
  }
  return transport;
}

function supportsArcadeDbIncrementalSync(transport) {
  return ARCADEDB_INCREMENTAL_SYNC_TRANSPORT_METHODS.every((method) => typeof transport?.[method] === "function");
}

function supportsPreparedTraversal(adapter) {
  const described = adapter.describe();
  return described.preparedTraversalProtocolVersion === PREPARED_TRAVERSAL_VERSION
    && typeof adapter.queryPrepared === "function";
}

function bridgeError(result, operation = "query") {
  let document = null;
  try { document = JSON.parse(String(result.stdout || "")); } catch { /* handled below */ }
  const supplied = document?.error?.code;
  const allowed = new Set(["ARCADEDB_TRANSPORT_UNAVAILABLE", "ARCADEDB_CREDENTIALS_UNAVAILABLE", "ARCADEDB_WRITE_OUTCOME_UNKNOWN", "ARCADEDB_AUTHENTICATION_FAILED", "ARCADEDB_REQUEST_FAILED", "ARCADEDB_REMOTE_RESPONSE_INVALID", "ARCADEDB_BRIDGE_INVALID_INPUT"]);
  let code = allowed.has(supplied) ? supplied : (result.error?.code === "ETIMEDOUT" ? "ARCADEDB_TRANSPORT_UNAVAILABLE" : "ARCADEDB_BRIDGE_FAILED");
  if (["command", "create-database", "drop-database"].includes(operation) && ["ARCADEDB_TRANSPORT_UNAVAILABLE", "ARCADEDB_BRIDGE_FAILED"].includes(code)) code = "ARCADEDB_WRITE_OUTCOME_UNKNOWN";
  const error = new Error(document?.error?.message || "ArcadeDB HTTP bridge failed.");
  error.code = code;
  error.phase = document?.error?.phase || "bridge";
  error.effectState = code === "ARCADEDB_WRITE_OUTCOME_UNKNOWN" ? "maybe-applied" : document?.error?.effectState;
  throw error;
}

function responseRecords(response) {
  const result = response?.body?.result;
  if (result == null) return [];
  if (!Array.isArray(result)) fail("ArcadeDB returned an invalid result envelope.", "ARCADEDB_INVALID_RESPONSE");
  return result;
}

export function buildArcadeDbBridgeEnvironment(input, source = process.env) {
  const references = input?.secretReferenceNames;
  if (!references || typeof references !== "object" || Array.isArray(references)) {
    fail("ArcadeDB bridge secret references are invalid.", "ARCADEDB_BRIDGE_INVALID_INPUT");
  }
  const names = [references.username, references.password];
  if (names.some((name) => typeof name !== "string" || !/^[A-Z][A-Z0-9_]{2,127}$/.test(name))) {
    fail("ArcadeDB bridge secret references are invalid.", "ARCADEDB_BRIDGE_INVALID_INPUT");
  }
  const selected = {};
  for (const name of [...ARCADEDB_BRIDGE_ENVIRONMENT_ALLOWLIST, ...names]) {
    if (Object.prototype.hasOwnProperty.call(source, name) && typeof source[name] === "string") selected[name] = source[name];
  }
  return selected;
}

export class ArcadeDbHttpTransport {
  constructor({
    storageSelection,
    timeoutMs = 15000,
    nativeBatchBridge = process.env.LODE_AGENT_ARCADEDB_NATIVE_MODE || process.env.HEAD_AGENT_ARCADEDB_NATIVE_MODE || "auto",
    storage = null,
  } = {}) {
    this.storage = storage;
    this.storageSelection = verifyStorageSelection(storageSelection, "", storage);
    if (this.storageSelection.mode !== "graphdb") fail("ArcadeDB transport requires a GraphDB storage selection.", "ARCADEDB_SELECTION_REQUIRED");
    this.timeoutMs = Number(timeoutMs);
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1000 || this.timeoutMs > 120000) {
      fail("ArcadeDB timeout must be from 1000 through 120000 milliseconds.", "INVALID_ARCADEDB_TIMEOUT");
    }
    this.nativeBatchBridge = null;
    const explicitNativeBatchSelection = nativeBatchBridge && typeof nativeBatchBridge === "object";
    if (explicitNativeBatchSelection && formatForVerifiedOwner(storage).dialect === "lode") {
      fail("Explicit native bridge has no verified Lode family capability.", "ARCADEDB_NATIVE_BRIDGE_NOT_AVAILABLE");
    }
    this.nativeBatchMode = explicitNativeBatchSelection ? "required" : (nativeBatchBridge ?? "off");
    if (!ARCADEDB_NATIVE_BATCH_MODES.has(this.nativeBatchMode)) {
      fail("Native ArcadeDB batch bridge mode must be auto, off, or required.", "INVALID_ARCADEDB_NATIVE_BRIDGE_MODE");
    }
    this.batchDiagnostics = {
      backend: "javascript-exact-child",
      fallbackUsed: false,
      fallbackReasonCode: "",
    };
    let selectedNativeBridge = this.nativeBatchMode === "off" ? null : nativeBatchBridge;
    if (!explicitNativeBatchSelection && (this.nativeBatchMode === "auto" || this.nativeBatchMode === "required")) {
      try {
        const resolved = resolveVerifiedArcadeDbNativeBridge({ pluginRoot: PLUGIN_ROOT });
        if (formatForVerifiedOwner(storage).dialect === "lode" && resolved.manifest.kind !== "LodeAgentArcadeDbBridgeManifest") {
          fail("Installed native bridge does not support the required Lode family.", "ARCADEDB_NATIVE_BRIDGE_NOT_AVAILABLE");
        }
        selectedNativeBridge = { executablePath: resolved.binaryPath, sha256: resolved.manifest.binary.sha256 };
      } catch (error) {
        if (this.nativeBatchMode === "required"
          || !["ARCADEDB_NATIVE_BRIDGE_NOT_AVAILABLE", "ARCADEDB_NATIVE_BRIDGE_TARGET_UNSUPPORTED"].includes(error.code)) throw error;
        selectedNativeBridge = null;
      }
    }
    if (selectedNativeBridge != null) {
      assertFields(selectedNativeBridge, ["executablePath", "sha256"], "Native ArcadeDB batch bridge", "INVALID_ARCADEDB_NATIVE_BRIDGE");
      const executablePath = path.resolve(selectedNativeBridge.executablePath || "");
      const sha256 = String(selectedNativeBridge.sha256 || "").toLowerCase();
      if (!path.isAbsolute(executablePath) || !/^[a-f0-9]{64}$/.test(sha256) || !fs.statSync(executablePath, { throwIfNoEntry: false })?.isFile()) {
        fail("Native ArcadeDB batch bridge selection is invalid.", "INVALID_ARCADEDB_NATIVE_BRIDGE");
      }
      this.nativeBatchBridge = Object.freeze({ executablePath, sha256 });
    }
  }

  describe() {
    return {
      protocol: "arcadedb-http-json",
      protocolVersion: ARCADEDB_GRAPH_PROJECTION_VERSION,
      remote: true,
      durable: true,
      credentialsPersisted: false,
      secretResolution: "environment-reference-at-request-time",
      preparedReadBatchProtocolVersion: ARCADEDB_BRIDGE_BATCH_VERSION,
      nativeBatchMode: this.nativeBatchMode,
      nativeBatchCandidateSelected: this.nativeBatchBridge != null,
    };
  }

  runBridge(input, { native = false } = {}) {
    let command = process.execPath;
    let args = [BRIDGE_FILE];
    if (native) {
      const selection = this.nativeBatchBridge;
      let currentDigest = "";
      try { currentDigest = selection ? digest(fs.readFileSync(selection.executablePath)) : ""; }
      catch { currentDigest = ""; }
      if (!selection || currentDigest !== selection.sha256) {
        fail("Native ArcadeDB batch bridge failed integrity verification.", "ARCADEDB_NATIVE_BRIDGE_INTEGRITY_MISMATCH");
      }
      command = selection.executablePath;
      args = [];
    }
    const result = childProcess.spawnSync(command, args, {
      input: JSON.stringify(input),
      encoding: "utf8",
      windowsHide: true,
      timeout: this.timeoutMs + 2000,
      maxBuffer: 64 * 1024 * 1024,
      env: buildArcadeDbBridgeEnvironment(input),
    });
    if (result.error || result.status == null || result.status === 2) bridgeError(result, input.operation);
    let response;
    try { response = JSON.parse(String(result.stdout || "")); }
    catch { fail("ArcadeDB HTTP bridge returned invalid JSON.", "ARCADEDB_INVALID_RESPONSE"); }
    if (response.error) bridgeError(result, input.operation);
    if (result.status !== 0 || response.ok !== true) {
      const status = Number(response.status || 0);
      const code = status === 401 || status === 403
        ? "ARCADEDB_AUTHENTICATION_FAILED"
        : status === 429 || status >= 500
          ? ["command", "create-database", "drop-database"].includes(input.operation) ? "ARCADEDB_WRITE_OUTCOME_UNKNOWN" : "ARCADEDB_TRANSPORT_UNAVAILABLE"
          : "ARCADEDB_REQUEST_REJECTED";
      fail(`ArcadeDB request was rejected${status ? ` with HTTP ${status}` : ""}.`, code);
    }
    return response;
  }

  invoke(operation, { language = "sql", command = "", params = {} } = {}) {
    const input = {
      endpoint: this.storageSelection.graphdb.endpoint,
      database: this.storageSelection.graphdb.database,
      secretReferenceNames: this.storageSelection.graphdb.secretReferenceNames,
      operation,
      timeoutMs: this.timeoutMs,
      ...(operation === "ready" || operation === "credential-status" ? {} : { language, command, params }),
    };
    return this.runBridge(input);
  }

  invokeQueryBatch(queries) {
    if (!Array.isArray(queries) || queries.length < 1 || queries.length > 8) {
      fail("ArcadeDB query batch must contain from one through eight queries.", "INVALID_ARCADEDB_QUERY_BATCH");
    }
    const input = {
      protocol: { name: formatForVerifiedOwner(this.storage).protocol("head-agent-core-arcadedb-query-batch"), version: ARCADEDB_BRIDGE_BATCH_VERSION },
      endpoint: this.storageSelection.graphdb.endpoint,
      database: this.storageSelection.graphdb.database,
      secretReferenceNames: this.storageSelection.graphdb.secretReferenceNames,
      operation: "query-batch",
      timeoutMs: this.timeoutMs,
      queries: clone(queries),
    };
    let response;
    let normalizedResponses = null;
    if (this.nativeBatchBridge) {
      try {
        response = this.runBridge(input, { native: true });
        normalizedResponses = this.normalizeQueryBatchResponse(response, queries.length);
        this.batchDiagnostics = { backend: "go-exact-child", fallbackUsed: false, fallbackReasonCode: "" };
      } catch (error) {
        if (this.nativeBatchMode === "required"
          || !["ARCADEDB_BRIDGE_FAILED", "ARCADEDB_INVALID_RESPONSE"].includes(error.code)) throw error;
        this.batchDiagnostics = { backend: "javascript-exact-child", fallbackUsed: true, fallbackReasonCode: error.code };
        response = this.runBridge(input);
      }
    } else {
      response = this.runBridge(input);
      this.batchDiagnostics = { backend: "javascript-exact-child", fallbackUsed: false, fallbackReasonCode: "" };
    }
    return normalizedResponses || this.normalizeQueryBatchResponse(response, queries.length);
  }

  normalizeQueryBatchResponse(response, expectedCount) {
    const responses = response?.body?.responses;
    if (!Array.isArray(responses) || responses.length !== expectedCount
      || responses.some((item) => !item || !Number.isInteger(item.status) || item.status < 200 || item.status > 299 || !("body" in item))) {
      fail("ArcadeDB query batch response is invalid.", "ARCADEDB_INVALID_RESPONSE");
    }
    return responses.map((item) => ({ ok: true, status: item.status, body: item.body }));
  }

  preparedReadBatchDiagnostics() {
    return clone(this.batchDiagnostics);
  }

  ready() {
    this.invoke("ready");
    return true;
  }

  credentialStatus() {
    const body = this.invoke("credential-status")?.body;
    if (!body || typeof body.usernameReferencePresent !== "boolean"
      || typeof body.passwordReferencePresent !== "boolean"
      || typeof body.allReferencesPresent !== "boolean"
      || body.credentialValuesReturned !== false || body.networkRequestPerformed !== false
      || body.allReferencesPresent !== (body.usernameReferencePresent && body.passwordReferencePresent)) {
      fail("ArcadeDB credential-reference status response is invalid.", "ARCADEDB_INVALID_RESPONSE");
    }
    return body;
  }

  databaseExists() {
    const response = this.invoke("exists");
    const value = response?.body?.result ?? response?.body?.exists;
    if (typeof value !== "boolean") fail("ArcadeDB database-existence response is invalid.", "ARCADEDB_INVALID_RESPONSE");
    return value;
  }

  createDatabase() {
    this.invoke("create-database");
    return true;
  }

  dropDatabase() {
    this.invoke("drop-database");
    return true;
  }

  readSchemaTypes() {
    const response = this.invoke("query", {
      command: "SELECT name, type, properties, indexes FROM schema:types ORDER BY name",
    });
    return responseRecords(response);
  }

  ensureSchema() {
    const command = [
      `CREATE DOCUMENT TYPE ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SNAPSHOT_TYPE)} IF NOT EXISTS`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SNAPSHOT_TYPE)}.projectId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SNAPSHOT_TYPE)}.graphSnapshotId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SNAPSHOT_TYPE)}.graphSnapshotHash IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SNAPSHOT_TYPE)}.sourceSnapshotId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SNAPSHOT_TYPE)}.documentJson IF NOT EXISTS STRING`,
      requiredIndexDdl(formatForVerifiedOwner(this.storage).kind(ARCADEDB_SNAPSHOT_TYPE)),
      `CREATE DOCUMENT TYPE ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SNAPSHOT_CHUNK_TYPE)} IF NOT EXISTS`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SNAPSHOT_CHUNK_TYPE)}.projectId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SNAPSHOT_CHUNK_TYPE)}.graphSnapshotId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SNAPSHOT_CHUNK_TYPE)}.chunkIndex IF NOT EXISTS INTEGER`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SNAPSHOT_CHUNK_TYPE)}.chunkJson IF NOT EXISTS STRING`,
      requiredIndexDdl(formatForVerifiedOwner(this.storage).kind(ARCADEDB_SNAPSHOT_CHUNK_TYPE)),
      `CREATE DOCUMENT TYPE ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_POINTER_TYPE)} IF NOT EXISTS`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_POINTER_TYPE)}.projectId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_POINTER_TYPE)}.pointerJson IF NOT EXISTS STRING`,
      requiredIndexDdl(formatForVerifiedOwner(this.storage).kind(ARCADEDB_POINTER_TYPE)),
    ].join(";\n");
    this.invoke("command", { language: "sqlscript", command });
    this.verifyRequiredIndexes([formatForVerifiedOwner(this.storage).kind(ARCADEDB_SNAPSHOT_TYPE), formatForVerifiedOwner(this.storage).kind(ARCADEDB_SNAPSHOT_CHUNK_TYPE), formatForVerifiedOwner(this.storage).kind(ARCADEDB_POINTER_TYPE)]);
  }

  ensureTopologySchema() {
    const commands = [
      `CREATE VERTEX TYPE ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE)} IF NOT EXISTS`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE)}.projectId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE)}.graphSnapshotId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE)}.graphSnapshotHash IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE)}.sourceSnapshotId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE)}.nodeId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE)}.nodeKind IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE)}.nodeJson IF NOT EXISTS STRING`,
      requiredIndexDdl(formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE)),
      `CREATE EDGE TYPE ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_EDGE_TYPE)} IF NOT EXISTS`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_EDGE_TYPE)}.projectId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_EDGE_TYPE)}.graphSnapshotId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_EDGE_TYPE)}.graphSnapshotHash IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_EDGE_TYPE)}.sourceSnapshotId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_EDGE_TYPE)}.edgeId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_EDGE_TYPE)}.edgeType IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_EDGE_TYPE)}.edgeJson IF NOT EXISTS STRING`,
      requiredIndexDdl(formatForVerifiedOwner(this.storage).kind(ARCADEDB_EDGE_TYPE)),
      `CREATE DOCUMENT TYPE ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_TOPOLOGY_TYPE)} IF NOT EXISTS`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_TOPOLOGY_TYPE)}.projectId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_TOPOLOGY_TYPE)}.graphSnapshotId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_TOPOLOGY_TYPE)}.topologyId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_TOPOLOGY_TYPE)}.topologyJson IF NOT EXISTS STRING`,
      requiredIndexDdl(formatForVerifiedOwner(this.storage).kind(ARCADEDB_TOPOLOGY_TYPE)),
      `CREATE DOCUMENT TYPE ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_TOPOLOGY_CHUNK_TYPE)} IF NOT EXISTS`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_TOPOLOGY_CHUNK_TYPE)}.projectId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_TOPOLOGY_CHUNK_TYPE)}.graphSnapshotId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_TOPOLOGY_CHUNK_TYPE)}.chunkIndex IF NOT EXISTS INTEGER`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_TOPOLOGY_CHUNK_TYPE)}.chunkJson IF NOT EXISTS STRING`,
      requiredIndexDdl(formatForVerifiedOwner(this.storage).kind(ARCADEDB_TOPOLOGY_CHUNK_TYPE)),
    ];
    for (const command of commands) this.invoke("command", { command });
    this.verifyRequiredIndexes([formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE), formatForVerifiedOwner(this.storage).kind(ARCADEDB_EDGE_TYPE), formatForVerifiedOwner(this.storage).kind(ARCADEDB_TOPOLOGY_TYPE), formatForVerifiedOwner(this.storage).kind(ARCADEDB_TOPOLOGY_CHUNK_TYPE)]);
  }

  ensureSyncSchema() {
    const commands = [
      `CREATE DOCUMENT TYPE ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SYNC_TYPE)} IF NOT EXISTS`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SYNC_TYPE)}.projectId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SYNC_TYPE)}.syncId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SYNC_TYPE)}.syncJson IF NOT EXISTS STRING`,
      requiredIndexDdl(formatForVerifiedOwner(this.storage).kind(ARCADEDB_SYNC_TYPE)),
      `CREATE DOCUMENT TYPE ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SYNC_CHECKPOINT_TYPE)} IF NOT EXISTS`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SYNC_CHECKPOINT_TYPE)}.projectId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SYNC_CHECKPOINT_TYPE)}.syncId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SYNC_CHECKPOINT_TYPE)}.batchId IF NOT EXISTS STRING`,
      `CREATE PROPERTY ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SYNC_CHECKPOINT_TYPE)}.checkpointJson IF NOT EXISTS STRING`,
      requiredIndexDdl(formatForVerifiedOwner(this.storage).kind(ARCADEDB_SYNC_CHECKPOINT_TYPE)),
    ];
    for (const command of commands) this.invoke("command", { command });
    this.verifyRequiredIndexes([formatForVerifiedOwner(this.storage).kind(ARCADEDB_SYNC_TYPE), formatForVerifiedOwner(this.storage).kind(ARCADEDB_SYNC_CHECKPOINT_TYPE)]);
  }

  verifyRequiredIndexes(names) {
    const records = this.readSchemaTypes();
    for (const name of names) {
      const record = records.find((item) => item.name === name);
      if (!record || inspectRequiredIndex(record).status !== "compatible") {
        fail("Required HEAD unique index was not verified after schema provisioning.", "ARCADEDB_SCHEMA_UNVERIFIED");
      }
    }
  }

  readPointer(projectId) {
    const response = this.invoke("query", {
      command: `SELECT pointerJson FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_POINTER_TYPE)} WHERE projectId = :projectId LIMIT 1`,
      params: { projectId },
    });
    return responseRecords(response)[0]?.pointerJson ?? null;
  }

  readSyncManifest(projectId, syncId) {
    const response = this.invoke("query", {
      command: `SELECT syncJson FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SYNC_TYPE)} WHERE projectId = :projectId AND syncId = :syncId LIMIT 1`,
      params: { projectId, syncId },
    });
    return responseRecords(response)[0]?.syncJson ?? null;
  }

  writeSyncManifest(projectId, syncId, syncJson) {
    try {
      this.invoke("command", {
        command: `INSERT INTO ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SYNC_TYPE)} SET projectId = :projectId, syncId = :syncId, syncJson = :syncJson`,
        params: { projectId, syncId, syncJson },
      });
      return true;
    } catch (error) {
      if (this.readSyncManifest(projectId, syncId) === syncJson) return false;
      throw error;
    }
  }

  readSyncCheckpoints(projectId, syncId) {
    const response = this.invoke("query", {
      command: `SELECT checkpointJson FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SYNC_CHECKPOINT_TYPE)} WHERE projectId = :projectId AND syncId = :syncId ORDER BY batchId`,
      params: { projectId, syncId },
    });
    return responseRecords(response).map((record) => record.checkpointJson);
  }

  writeSyncCheckpoint(projectId, syncId, batchId, checkpointJson) {
    const existing = responseRecords(this.invoke("query", {
      command: `SELECT checkpointJson FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SYNC_CHECKPOINT_TYPE)} WHERE projectId = :projectId AND syncId = :syncId AND batchId = :batchId LIMIT 1`,
      params: { projectId, syncId, batchId },
    }))[0]?.checkpointJson ?? null;
    if (existing != null) {
      if (existing !== checkpointJson) fail("ArcadeDB sync checkpoint conflicts with immutable remote content.", "ARCADEDB_INCREMENTAL_SYNC_CHECKPOINT_CONFLICT");
      return false;
    }
    try {
      this.invoke("command", {
        command: `INSERT INTO ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SYNC_CHECKPOINT_TYPE)} SET projectId = :projectId, syncId = :syncId, batchId = :batchId, checkpointJson = :checkpointJson`,
        params: { projectId, syncId, batchId, checkpointJson },
      });
      return true;
    } catch (error) {
      const after = responseRecords(this.invoke("query", {
        command: `SELECT checkpointJson FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SYNC_CHECKPOINT_TYPE)} WHERE projectId = :projectId AND syncId = :syncId AND batchId = :batchId LIMIT 1`,
        params: { projectId, syncId, batchId },
      }))[0]?.checkpointJson ?? null;
      if (after === checkpointJson) return false;
      throw error;
    }
  }

  applySyncBatch(projectId, manifest, batch) {
    verifyArcadeDbIncrementalSyncManifest(manifest);
    const params = {
      projectId,
      baseGraphSnapshotId: manifest.baseGraphSnapshotId,
      targetGraphSnapshotId: manifest.targetGraphSnapshotId,
      graphSnapshotHash: manifest.targetGraphSnapshotHash,
      sourceSnapshotId: manifest.sourceSnapshotId,
    };
    const commands = ["BEGIN ISOLATION REPEATABLE_READ"];
    for (const [index, record] of batch.records.entries()) {
      const suffix = String(index);
      if (batch.recordKind === "node") {
        Object.assign(params, { [`nodeId${suffix}`]: record.nodeId });
        if (new Set(["carry-forward", "rebase"]).has(batch.operation)) {
          Object.assign(params, { [`sourceNodeId${suffix}`]: record.sourceNodeId || record.nodeId });
          commands.push(`LET source${suffix} = SELECT nodeKind, nodeJson FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE)} WHERE projectId = :projectId AND graphSnapshotId = :baseGraphSnapshotId AND nodeId = :sourceNodeId${suffix} LIMIT 1`);
          const nodeJson = batch.operation === "rebase"
            ? `convert.toJson(map.merge(convert.fromJsonMap($source${suffix}[0].nodeJson), {sourceSnapshotId: :sourceSnapshotId}))`
            : `$source${suffix}[0].nodeJson`;
          commands.push(`IF ($source${suffix}.size() = 1) { INSERT INTO ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE)} SET projectId = :projectId, graphSnapshotId = :targetGraphSnapshotId, graphSnapshotHash = :graphSnapshotHash, sourceSnapshotId = :sourceSnapshotId, nodeId = :nodeId${suffix}, nodeKind = $source${suffix}[0].nodeKind, nodeJson = ${nodeJson}; } ELSE { ROLLBACK; RETURN false; }`);
        } else {
          Object.assign(params, { [`nodeKind${suffix}`]: record.kind, [`nodeJson${suffix}`]: graphProjectionCanonicalJson(record) });
          commands.push(`INSERT INTO ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE)} SET projectId = :projectId, graphSnapshotId = :targetGraphSnapshotId, graphSnapshotHash = :graphSnapshotHash, sourceSnapshotId = :sourceSnapshotId, nodeId = :nodeId${suffix}, nodeKind = :nodeKind${suffix}, nodeJson = :nodeJson${suffix}`);
        }
        continue;
      }
      Object.assign(params, {
        [`edgeId${suffix}`]: record.edgeId,
        [`fromNodeId${suffix}`]: record.from,
        [`toNodeId${suffix}`]: record.to,
      });
      commands.push(`LET existing${suffix} = SELECT edgeJson FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_EDGE_TYPE)} WHERE projectId = :projectId AND graphSnapshotId = :targetGraphSnapshotId AND edgeId = :edgeId${suffix} LIMIT 1`);
      if (new Set(["carry-forward", "rebase"]).has(batch.operation)) {
        Object.assign(params, { [`sourceEdgeId${suffix}`]: record.sourceEdgeId || record.edgeId });
        commands.push(`LET source${suffix} = SELECT edgeType, edgeJson FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_EDGE_TYPE)} WHERE projectId = :projectId AND graphSnapshotId = :baseGraphSnapshotId AND edgeId = :sourceEdgeId${suffix} LIMIT 1`);
        const edgeJson = batch.operation === "rebase"
          ? `convert.toJson(map.merge(convert.fromJsonMap($source${suffix}[0].edgeJson), {edgeId: :edgeId${suffix}, sourceSnapshotId: :sourceSnapshotId}))`
          : `$source${suffix}[0].edgeJson`;
          commands.push(`IF ($existing${suffix}.size() = 0 AND $source${suffix}.size() = 1) { CREATE EDGE ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_EDGE_TYPE)} FROM (SELECT FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE)} WHERE projectId = :projectId AND graphSnapshotId = :targetGraphSnapshotId AND nodeId = :fromNodeId${suffix}) TO (SELECT FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE)} WHERE projectId = :projectId AND graphSnapshotId = :targetGraphSnapshotId AND nodeId = :toNodeId${suffix}) SET projectId = :projectId, graphSnapshotId = :targetGraphSnapshotId, graphSnapshotHash = :graphSnapshotHash, sourceSnapshotId = :sourceSnapshotId, edgeId = :edgeId${suffix}, edgeType = $source${suffix}[0].edgeType, edgeJson = ${edgeJson}; } ELSE { IF ($existing${suffix}.size() = 0) { ROLLBACK; RETURN false; } }`);
      } else {
        Object.assign(params, { [`edgeType${suffix}`]: record.type, [`edgeJson${suffix}`]: graphProjectionCanonicalJson(record) });
        commands.push(`IF ($existing${suffix}.size() = 0) { CREATE EDGE ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_EDGE_TYPE)} FROM (SELECT FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE)} WHERE projectId = :projectId AND graphSnapshotId = :targetGraphSnapshotId AND nodeId = :fromNodeId${suffix}) TO (SELECT FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE)} WHERE projectId = :projectId AND graphSnapshotId = :targetGraphSnapshotId AND nodeId = :toNodeId${suffix}) SET projectId = :projectId, graphSnapshotId = :targetGraphSnapshotId, graphSnapshotHash = :graphSnapshotHash, sourceSnapshotId = :sourceSnapshotId, edgeId = :edgeId${suffix}, edgeType = :edgeType${suffix}, edgeJson = :edgeJson${suffix}; }`);
      }
    }
    commands.push("COMMIT", "RETURN true");
    this.invoke("command", { language: "sqlscript", command: commands.join(";\n"), params });
    return true;
  }

  readSyncBatchRecords(projectId, graphSnapshotId, batch) {
    const field = batch.recordKind === "node" ? "nodeJson" : "edgeJson";
    const identifier = batch.recordKind === "node" ? "nodeId" : "edgeId";
    const type = batch.recordKind === "node" ? formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE) : formatForVerifiedOwner(this.storage).kind(ARCADEDB_EDGE_TYPE);
    const ids = batch.records.map((record) => record[identifier]);
    const response = this.invoke("query", {
      command: `SELECT ${field}, ${identifier} FROM ${type} WHERE projectId = :projectId AND graphSnapshotId = :graphSnapshotId AND ${identifier} IN :recordIds ORDER BY ${identifier}`,
      params: { projectId, graphSnapshotId, recordIds: ids },
    });
    return responseRecords(response).map((record) => record[field]);
  }

  readSnapshot(projectId, id) {
    const response = this.invoke("query", {
      command: `SELECT documentJson FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SNAPSHOT_TYPE)} WHERE projectId = :projectId AND graphSnapshotId = :graphSnapshotId LIMIT 1`,
      params: { projectId, graphSnapshotId: id },
    });
    const documentJson = responseRecords(response)[0]?.documentJson ?? null;
    if (documentJson == null) return null;
    let manifest;
    try { manifest = JSON.parse(documentJson); }
    catch { return documentJson; }
    if (manifest?.kind === formatForVerifiedOwner(this.storage).kind("HeadAgentGraphSnapshotTopologyManifest")) {
      if (manifest.schemaVersion !== 1 || manifest.encoding !== "topology-backed-canonical-graph"
        || !/^arcadedb-graph-topology-[a-f0-9]{24}$/.test(manifest.topologyId || "")
        || !/^[a-f0-9]{64}$/.test(manifest.topologyHash || "")
        || !Number.isSafeInteger(manifest.byteLength) || manifest.byteLength < 1
        || !/^[a-f0-9]{64}$/.test(manifest.sha256 || "") || typeof manifest.graphHeaderJson !== "string") {
        fail("ArcadeDB topology-backed graph snapshot manifest is invalid.", "ARCADEDB_GRAPH_SNAPSHOT_TOPOLOGY_MANIFEST_MISMATCH");
      }
      const remote = this.readTopology(projectId, id);
      if (!remote || typeof remote.topologyJson !== "string") fail("ArcadeDB topology-backed graph snapshot is missing its topology.", "ARCADEDB_GRAPH_SNAPSHOT_TOPOLOGY_MANIFEST_MISMATCH");
      const topology = verifyArcadeDbGraphTopology(parseRemoteJson(remote.topologyJson, "ArcadeDB graph topology"), null, this.storage);
      if (topology.topologyId !== manifest.topologyId || topology.topologyHash !== manifest.topologyHash) {
        fail("ArcadeDB topology-backed graph snapshot references a different topology.", "ARCADEDB_GRAPH_SNAPSHOT_TOPOLOGY_MANIFEST_MISMATCH");
      }
      let header;
      try { header = JSON.parse(manifest.graphHeaderJson); }
      catch { fail("ArcadeDB topology-backed graph snapshot header is invalid.", "ARCADEDB_GRAPH_SNAPSHOT_TOPOLOGY_MANIFEST_MISMATCH"); }
      const nodes = remote.nodeJsons.map((value) => parseRemoteJson(value, "ArcadeDB graph node")).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
      const edges = remote.edgeJsons.map((value) => parseRemoteJson(value, "ArcadeDB graph edge")).sort((left, right) => left.edgeId.localeCompare(right.edgeId));
      const assembled = graphProjectionCanonicalJson({ ...header, nodes, edges });
      if (nodes.length !== topology.nodeCount || edges.length !== topology.edgeCount
        || digest(graphProjectionCanonicalJson(nodes)) !== topology.nodeSetHash
        || digest(graphProjectionCanonicalJson(edges)) !== topology.edgeSetHash
        || Buffer.byteLength(assembled, "utf8") !== manifest.byteLength || digest(assembled) !== manifest.sha256) {
        fail("ArcadeDB topology-backed graph snapshot failed reconstruction verification.", "ARCADEDB_GRAPH_SNAPSHOT_TOPOLOGY_MANIFEST_MISMATCH");
      }
      return assembled;
    }
    if (manifest?.kind !== formatForVerifiedOwner(this.storage).kind("HeadAgentGraphSnapshotChunkManifest")) return documentJson;
    if (manifest.schemaVersion !== 1 || manifest.encoding !== "gzip-base64-json-chunks"
      || !Number.isSafeInteger(manifest.chunkCount) || manifest.chunkCount < 1
      || !Number.isSafeInteger(manifest.byteLength) || manifest.byteLength < 1
      || !/^[a-f0-9]{64}$/.test(manifest.sha256 || "")) {
      fail("ArcadeDB graph snapshot chunk manifest is invalid.", "ARCADEDB_GRAPH_SNAPSHOT_CHUNK_MISMATCH");
    }
    const chunks = [];
    let afterChunkIndex = -1;
    for (;;) {
      const page = responseRecords(this.invoke("query", {
        command: `SELECT chunkIndex, chunkJson FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SNAPSHOT_CHUNK_TYPE)} WHERE projectId = :projectId AND graphSnapshotId = :graphSnapshotId AND chunkIndex > :afterChunkIndex ORDER BY chunkIndex LIMIT 10`,
        params: { projectId, graphSnapshotId: id, afterChunkIndex },
      }));
      chunks.push(...page);
      if (page.length < 10) break;
      afterChunkIndex = page.at(-1).chunkIndex;
    }
    if (chunks.length !== manifest.chunkCount || chunks.some((item, index) => item.chunkIndex !== index || typeof item.chunkJson !== "string")) {
      fail("ArcadeDB graph snapshot chunks are incomplete.", "ARCADEDB_GRAPH_SNAPSHOT_CHUNK_MISMATCH");
    }
    let assembled;
    try { assembled = zlib.gunzipSync(Buffer.from(chunks.map((item) => item.chunkJson).join(""), "base64")).toString("utf8"); }
    catch { fail("ArcadeDB graph snapshot chunks could not be decompressed.", "ARCADEDB_GRAPH_SNAPSHOT_CHUNK_MISMATCH"); }
    if (Buffer.byteLength(assembled, "utf8") !== manifest.byteLength || digest(assembled) !== manifest.sha256) {
      fail("ArcadeDB graph snapshot chunks failed content verification.", "ARCADEDB_GRAPH_SNAPSHOT_CHUNK_MISMATCH");
    }
    return assembled;
  }

  async writeSnapshot(projectId, id, documentJson, metadata) {
    try {
      let storedDocumentJson = documentJson;
      if (metadata?.topologyBacked === true) {
        let graph;
        try { graph = JSON.parse(documentJson); }
        catch { fail("Topology-backed snapshot input is invalid JSON.", "ARCADEDB_GRAPH_SNAPSHOT_TOPOLOGY_MANIFEST_MISMATCH"); }
        verifyTemporalProvenanceGraph(graph);
        const topology = buildArcadeDbGraphTopology(graph, this.storage);
        const header = { ...graph };
        delete header.nodes;
        delete header.edges;
        storedDocumentJson = graphProjectionCanonicalJson({
          schemaVersion: 1,
          kind: formatForVerifiedOwner(this.storage).kind("HeadAgentGraphSnapshotTopologyManifest"),
          encoding: "topology-backed-canonical-graph",
          topologyId: topology.topologyId,
          topologyHash: topology.topologyHash,
          graphHeaderJson: graphProjectionCanonicalJson(header),
          byteLength: Buffer.byteLength(documentJson, "utf8"),
          sha256: digest(documentJson),
        });
      } else if (Buffer.byteLength(documentJson, "utf8") > ARCADEDB_SNAPSHOT_CHUNK_BYTES) {
        const encoded = zlib.gzipSync(Buffer.from(documentJson, "utf8"), { level: 9 }).toString("base64");
        const chunks = [];
        for (let offset = 0; offset < encoded.length; offset += ARCADEDB_SNAPSHOT_CHUNK_BYTES) {
          chunks.push(encoded.slice(offset, offset + ARCADEDB_SNAPSHOT_CHUNK_BYTES));
        }
        const existingChunks = new Map();
        let afterExistingChunkIndex = -1;
        for (;;) {
          const page = responseRecords(this.invoke("query", {
            command: `SELECT chunkIndex, chunkJson FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SNAPSHOT_CHUNK_TYPE)} WHERE projectId = :projectId AND graphSnapshotId = :graphSnapshotId AND chunkIndex > :afterExistingChunkIndex ORDER BY chunkIndex LIMIT 10`,
            params: { projectId, graphSnapshotId: id, afterExistingChunkIndex },
          }));
          for (const item of page) existingChunks.set(item.chunkIndex, item.chunkJson);
          if (page.length < 10) break;
          afterExistingChunkIndex = page.at(-1).chunkIndex;
        }
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
          if (existingChunks.has(chunkIndex)) {
            if (existingChunks.get(chunkIndex) !== chunks[chunkIndex]) {
              fail("ArcadeDB graph snapshot contains a conflicting partial chunk.", "ARCADEDB_GRAPH_SNAPSHOT_CHUNK_MISMATCH");
            }
            continue;
          }
          try {
            this.invoke("command", {
              command: `INSERT INTO ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SNAPSHOT_CHUNK_TYPE)} SET projectId = :projectId, graphSnapshotId = :graphSnapshotId, chunkIndex = :chunkIndex, chunkJson = :chunkJson`,
              params: { projectId, graphSnapshotId: id, chunkIndex, chunkJson: chunks[chunkIndex] },
            });
          } catch (error) { fail("ArcadeDB snapshot chunk write failed.", `ARCADEDB_SNAPSHOT_CHUNK_WRITE_FAILED:${error.code || "UNKNOWN"}`); }
        }
        storedDocumentJson = graphProjectionCanonicalJson({
          schemaVersion: 1,
          kind: formatForVerifiedOwner(this.storage).kind("HeadAgentGraphSnapshotChunkManifest"),
          encoding: "gzip-base64-json-chunks",
          chunkCount: chunks.length,
          byteLength: Buffer.byteLength(documentJson, "utf8"),
          sha256: digest(documentJson),
        });
      }
      const snapshotExists = responseRecords(this.invoke("query", {
        command: `SELECT graphSnapshotId FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SNAPSHOT_TYPE)} WHERE projectId = :projectId AND graphSnapshotId = :graphSnapshotId LIMIT 1`,
        params: { projectId, graphSnapshotId: id },
      })).length > 0;
      try {
        this.invoke("command", {
          command: snapshotExists
            ? `UPDATE ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SNAPSHOT_TYPE)} SET graphSnapshotHash = :graphSnapshotHash, sourceSnapshotId = :sourceSnapshotId, documentJson = :documentJson WHERE projectId = :projectId AND graphSnapshotId = :graphSnapshotId`
            : `INSERT INTO ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SNAPSHOT_TYPE)} SET projectId = :projectId, graphSnapshotId = :graphSnapshotId, graphSnapshotHash = :graphSnapshotHash, sourceSnapshotId = :sourceSnapshotId, documentJson = :documentJson`,
          params: { projectId, graphSnapshotId: id, documentJson: storedDocumentJson, ...metadata },
        });
      } catch (error) { fail("ArcadeDB snapshot manifest write failed.", `ARCADEDB_SNAPSHOT_MANIFEST_WRITE_FAILED:${error.code || "UNKNOWN"}`); }
      return true;
    } catch (error) {
      if (error.code === "ARCADEDB_REQUEST_REJECTED" && (await this.readSnapshot(projectId, id)) != null) return false;
      throw error;
    }
  }

  writePointer(projectId, pointerJson) {
    const exists = responseRecords(this.invoke("query", {
      command: `SELECT projectId FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_POINTER_TYPE)} WHERE projectId = :projectId LIMIT 1`,
      params: { projectId },
    })).length > 0;
    this.invoke("command", {
      command: exists
        ? `UPDATE ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_POINTER_TYPE)} SET pointerJson = :pointerJson WHERE projectId = :projectId`
        : `INSERT INTO ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_POINTER_TYPE)} SET projectId = :projectId, pointerJson = :pointerJson`,
      params: { projectId, pointerJson },
    });
  }

  async writePointerCompareAndSwap(projectId, expectedPointerJson, pointerJson) {
    if (expectedPointerJson == null) {
      try {
        this.invoke("command", {
          command: `INSERT INTO ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_POINTER_TYPE)} SET projectId = :projectId, pointerJson = :pointerJson`,
          params: { projectId, pointerJson },
        });
      } catch (error) {
        const currentPointerJson = (await this.readPointer(projectId));
        if (currentPointerJson === pointerJson) return true;
        if (currentPointerJson != null) return false;
        throw error;
      }
      return (await this.readPointer(projectId)) === pointerJson;
    }
    try {
      this.invoke("command", {
        command: `UPDATE ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_POINTER_TYPE)} SET pointerJson = :pointerJson WHERE projectId = :projectId AND pointerJson = :expectedPointerJson`,
        params: { projectId, expectedPointerJson, pointerJson },
      });
    } catch (error) {
      if ((await this.readPointer(projectId)) === pointerJson) return true;
      throw error;
    }
    return (await this.readPointer(projectId)) === pointerJson;
  }

  listSnapshotIds(projectId) {
    const response = this.invoke("query", {
      command: `SELECT graphSnapshotId FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_SNAPSHOT_TYPE)} WHERE projectId = :projectId ORDER BY graphSnapshotId`,
      params: { projectId },
    });
    return responseRecords(response).map((record) => record.graphSnapshotId);
  }

  readTopologyManifest(projectId, graphSnapshotId) {
    const response = this.invoke("query", {
      command: `SELECT topologyJson FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_TOPOLOGY_TYPE)} WHERE projectId = :projectId AND graphSnapshotId = :graphSnapshotId LIMIT 1`,
      params: { projectId, graphSnapshotId },
    });
    const topologyJson = responseRecords(response)[0]?.topologyJson ?? null;
    return this.decodeTopologyManifest(projectId, graphSnapshotId, topologyJson);
  }

  decodeTopologyManifest(projectId, graphSnapshotId, topologyJson) {
    if (topologyJson == null) return null;
    let manifest;
    try { manifest = JSON.parse(topologyJson); }
    catch { return topologyJson; }
    if (manifest?.kind !== formatForVerifiedOwner(this.storage).kind("HeadAgentGraphTopologyChunkManifest")) return topologyJson;
    if (manifest.schemaVersion !== 1 || manifest.encoding !== "gzip-base64-json-chunks"
      || !Number.isSafeInteger(manifest.chunkCount) || manifest.chunkCount < 1
      || !Number.isSafeInteger(manifest.byteLength) || manifest.byteLength < 1
      || !/^[a-f0-9]{64}$/.test(manifest.sha256 || "")) {
      fail("ArcadeDB graph topology chunk manifest is invalid.", "ARCADEDB_GRAPH_TOPOLOGY_CHUNK_MISMATCH");
    }
    const chunks = [];
    let afterChunkIndex = -1;
    for (;;) {
      const page = responseRecords(this.invoke("query", {
        command: `SELECT chunkIndex, chunkJson FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_TOPOLOGY_CHUNK_TYPE)} WHERE projectId = :projectId AND graphSnapshotId = :graphSnapshotId AND chunkIndex > :afterChunkIndex ORDER BY chunkIndex LIMIT 10`,
        params: { projectId, graphSnapshotId, afterChunkIndex },
      }));
      chunks.push(...page);
      if (page.length < 10) break;
      afterChunkIndex = page.at(-1).chunkIndex;
    }
    if (chunks.length !== manifest.chunkCount || chunks.some((item, index) => item.chunkIndex !== index || typeof item.chunkJson !== "string")) {
      fail("ArcadeDB graph topology chunks are incomplete.", "ARCADEDB_GRAPH_TOPOLOGY_CHUNK_MISMATCH");
    }
    let assembled;
    try { assembled = zlib.gunzipSync(Buffer.from(chunks.map((item) => item.chunkJson).join(""), "base64")).toString("utf8"); }
    catch { fail("ArcadeDB graph topology chunks could not be decompressed.", "ARCADEDB_GRAPH_TOPOLOGY_CHUNK_MISMATCH"); }
    if (Buffer.byteLength(assembled, "utf8") !== manifest.byteLength || digest(assembled) !== manifest.sha256) {
      fail("ArcadeDB graph topology chunks failed content verification.", "ARCADEDB_GRAPH_TOPOLOGY_CHUNK_MISMATCH");
    }
    return assembled;
  }

  readPreparedTraversalBatch(projectId, graphSnapshotId, { anchorIds, maxDepth, maxRecords }) {
    if (!Array.isArray(anchorIds) || anchorIds.length > 500
      || anchorIds.some((nodeId) => typeof nodeId !== "string" || !nodeId)
      || !Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 3
      || !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > ARCADEDB_SERVER_TRAVERSAL_MAX_RECORDS) {
      fail("ArcadeDB prepared read batch request is invalid.", "INVALID_ARCADEDB_PREPARED_READ_BATCH");
    }
    const queries = [{
      language: "sql",
      command: `SELECT topologyJson FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_TOPOLOGY_TYPE)} WHERE projectId = :projectId AND graphSnapshotId = :graphSnapshotId LIMIT 1`,
      params: { projectId, graphSnapshotId },
    }];
    if (anchorIds.length > 0) queries.push({
      language: "sql",
      command: `SELECT @type AS recordType, nodeJson, edgeJson, $depth AS recordDepth FROM (TRAVERSE bothE('${formatForVerifiedOwner(this.storage).kind(ARCADEDB_EDGE_TYPE)}'), bothV() FROM (SELECT FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE)} WHERE projectId = :projectId AND graphSnapshotId = :graphSnapshotId AND nodeId IN :anchorIds) MAXDEPTH ${maxDepth * 2} LIMIT ${maxRecords + 1} STRATEGY BREADTH_FIRST)`,
      params: { projectId, graphSnapshotId, anchorIds: [...anchorIds] },
    });
    const responses = this.invokeQueryBatch(queries);
    const topologyJson = this.decodeTopologyManifest(
      projectId,
      graphSnapshotId,
      responseRecords(responses[0])[0]?.topologyJson ?? null,
    );
    const records = anchorIds.length > 0 ? responseRecords(responses[1]) : [];
    return {
      topologyJson,
      traversal: {
        protocolVersion: ARCADEDB_SERVER_TRAVERSAL_VERSION,
        graphSnapshotId,
        anchorIds: [...anchorIds],
        maxDepth,
        maxRecords,
        truncated: records.length > maxRecords,
        records: records.slice(0, maxRecords),
      },
    };
  }

  readTopology(projectId, graphSnapshotId) {
    const topologyJson = this.readTopologyManifest(projectId, graphSnapshotId);
    const readPaged = (type, field, orderField) => {
      const values = [];
      const pageSize = 50;
      let afterId = "";
      for (;;) {
        const page = responseRecords(this.invoke("query", {
          command: `SELECT ${field}, ${orderField} FROM ${type} WHERE projectId = :projectId AND graphSnapshotId = :graphSnapshotId AND ${orderField} > :afterId ORDER BY ${orderField} LIMIT ${pageSize}`,
          params: { projectId, graphSnapshotId, afterId },
        }));
        values.push(...page.map((record) => record[field]));
        if (page.length < pageSize) break;
        afterId = page.at(-1)[orderField];
      }
      return values;
    };
    let nodeJsons;
    let edgeJsons;
    try { nodeJsons = readPaged(formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE), "nodeJson", "nodeId"); }
    catch (error) { fail("ArcadeDB paged topology node read failed.", `ARCADEDB_TOPOLOGY_NODE_PAGE_READ_FAILED:${error.code || "UNKNOWN"}`); }
    try { edgeJsons = readPaged(formatForVerifiedOwner(this.storage).kind(ARCADEDB_EDGE_TYPE), "edgeJson", "edgeId"); }
    catch (error) { fail("ArcadeDB paged topology edge read failed.", `ARCADEDB_TOPOLOGY_EDGE_PAGE_READ_FAILED:${error.code || "UNKNOWN"}`); }
    if (topologyJson == null && nodeJsons.length === 0 && edgeJsons.length === 0) return null;
    return {
      topologyJson,
      nodeJsons,
      edgeJsons,
    };
  }

  writeTopology(projectId, graphSnapshotId, graph, topology) {
    this.ensureTopologySchema();
    const fullTopologyJson = graphProjectionCanonicalJson(topology);
    const chunks = [];
    if (Buffer.byteLength(fullTopologyJson, "utf8") > ARCADEDB_SNAPSHOT_CHUNK_BYTES) {
      const encoded = zlib.gzipSync(Buffer.from(fullTopologyJson, "utf8"), { level: 9 }).toString("base64");
      for (let offset = 0; offset < encoded.length; offset += ARCADEDB_SNAPSHOT_CHUNK_BYTES) chunks.push(encoded.slice(offset, offset + ARCADEDB_SNAPSHOT_CHUNK_BYTES));
    }
    const topologyJson = chunks.length ? graphProjectionCanonicalJson({ schemaVersion: 1, kind: formatForVerifiedOwner(this.storage).kind("HeadAgentGraphTopologyChunkManifest"), encoding: "gzip-base64-json-chunks", chunkCount: chunks.length, byteLength: Buffer.byteLength(fullTopologyJson, "utf8"), sha256: digest(fullTopologyJson) }) : fullTopologyJson;
    const exactExistingManifest = () => {
      const records = responseRecords(this.invoke("query", {
        command: `SELECT topologyId, topologyJson FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_TOPOLOGY_TYPE)} WHERE projectId = :projectId AND graphSnapshotId = :graphSnapshotId LIMIT 2`,
        params: { projectId, graphSnapshotId },
      }));
      if (!records.length) return false;
      if (records.length !== 1 || records[0].topologyId !== topology.topologyId || records[0].topologyJson !== topologyJson) {
        fail("ArcadeDB topology manifest contains different immutable content.", "ARCADEDB_GRAPH_TOPOLOGY_CONFLICT");
      }
      return true;
    };
    if (exactExistingManifest()) return false;
    const batchSize = 10;
    const readExistingIds = (type, field) => {
      const ids = [];
      let afterId = "";
      for (;;) {
        const page = responseRecords(this.invoke("query", {
          command: `SELECT ${field} FROM ${type} WHERE projectId = :projectId AND graphSnapshotId = :graphSnapshotId AND ${field} > :afterId ORDER BY ${field} LIMIT 200`,
          params: { projectId, graphSnapshotId, afterId },
        }));
        ids.push(...page.map((item) => item[field]));
        if (page.length < 200) break;
        afterId = page.at(-1)[field];
      }
      return new Set(ids);
    };
    const existingNodeIds = readExistingIds(formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE), "nodeId");
    const missingNodes = graph.nodes.filter((node) => !existingNodeIds.has(node.nodeId));
    for (let start = 0; start < missingNodes.length; start += batchSize) {
      const params = {};
      const commands = missingNodes.slice(start, start + batchSize).map((node, index) => {
        const suffix = `${start + index}`;
        Object.assign(params, {
          [`projectId${suffix}`]: projectId, [`graphSnapshotId${suffix}`]: graphSnapshotId,
          [`graphSnapshotHash${suffix}`]: graph.graphSnapshotHash, [`sourceSnapshotId${suffix}`]: graph.sourceSnapshotId,
          [`nodeId${suffix}`]: node.nodeId, [`nodeKind${suffix}`]: node.kind,
          [`nodeJson${suffix}`]: graphProjectionCanonicalJson(node),
        });
        return `INSERT INTO ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE)} SET projectId = :projectId${suffix}, graphSnapshotId = :graphSnapshotId${suffix}, nodeId = :nodeId${suffix}, graphSnapshotHash = :graphSnapshotHash${suffix}, sourceSnapshotId = :sourceSnapshotId${suffix}, nodeKind = :nodeKind${suffix}, nodeJson = :nodeJson${suffix}`;
      });
      this.invoke("command", { language: "sqlscript", command: commands.join(";\n"), params });
    }
    const existingEdgeIds = readExistingIds(formatForVerifiedOwner(this.storage).kind(ARCADEDB_EDGE_TYPE), "edgeId");
    const missingEdges = graph.edges.filter((edge) => !existingEdgeIds.has(edge.edgeId));
    for (let start = 0; start < missingEdges.length; start += batchSize) {
      const params = {};
      const commands = missingEdges.slice(start, start + batchSize).map((edge, index) => {
        const suffix = `${start + index}`;
        Object.assign(params, {
          [`projectId${suffix}`]: projectId, [`graphSnapshotId${suffix}`]: graphSnapshotId,
          [`graphSnapshotHash${suffix}`]: graph.graphSnapshotHash, [`sourceSnapshotId${suffix}`]: graph.sourceSnapshotId,
          [`edgeId${suffix}`]: edge.edgeId, [`edgeType${suffix}`]: edge.type,
          [`edgeJson${suffix}`]: graphProjectionCanonicalJson(edge), [`fromNodeId${suffix}`]: edge.from,
          [`toNodeId${suffix}`]: edge.to,
        });
        return `CREATE EDGE ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_EDGE_TYPE)} FROM (SELECT FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE)} WHERE projectId = :projectId${suffix} AND graphSnapshotId = :graphSnapshotId${suffix} AND nodeId = :fromNodeId${suffix}) TO (SELECT FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE)} WHERE projectId = :projectId${suffix} AND graphSnapshotId = :graphSnapshotId${suffix} AND nodeId = :toNodeId${suffix}) SET projectId = :projectId${suffix}, graphSnapshotId = :graphSnapshotId${suffix}, graphSnapshotHash = :graphSnapshotHash${suffix}, sourceSnapshotId = :sourceSnapshotId${suffix}, edgeId = :edgeId${suffix}, edgeType = :edgeType${suffix}, edgeJson = :edgeJson${suffix}`;
      });
      this.invoke("command", { language: "sqlscript", command: commands.join(";\n"), params });
    }
    if (chunks.length) {
      const existingChunks = new Map();
      let afterExistingChunkIndex = -1;
      for (;;) {
        const page = responseRecords(this.invoke("query", {
          command: `SELECT chunkIndex, chunkJson FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_TOPOLOGY_CHUNK_TYPE)} WHERE projectId = :projectId AND graphSnapshotId = :graphSnapshotId AND chunkIndex > :afterExistingChunkIndex ORDER BY chunkIndex LIMIT 10`,
          params: { projectId, graphSnapshotId, afterExistingChunkIndex },
        }));
        for (const item of page) existingChunks.set(item.chunkIndex, item.chunkJson);
        if (page.length < 10) break;
        afterExistingChunkIndex = page.at(-1).chunkIndex;
      }
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        if (existingChunks.has(chunkIndex)) {
          if (existingChunks.get(chunkIndex) !== chunks[chunkIndex]) fail("ArcadeDB graph topology contains a conflicting partial chunk.", "ARCADEDB_GRAPH_TOPOLOGY_CHUNK_MISMATCH");
          continue;
        }
        try {
          this.invoke("command", {
            command: `INSERT INTO ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_TOPOLOGY_CHUNK_TYPE)} SET projectId = :projectId, graphSnapshotId = :graphSnapshotId, chunkIndex = :chunkIndex, chunkJson = :chunkJson`,
            params: { projectId, graphSnapshotId, chunkIndex, chunkJson: chunks[chunkIndex] },
          });
        } catch (error) { fail("ArcadeDB topology chunk write failed.", `ARCADEDB_TOPOLOGY_CHUNK_WRITE_FAILED:${error.code || "UNKNOWN"}`); }
      }
    }
    try {
      this.invoke("command", {
        command: `INSERT INTO ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_TOPOLOGY_TYPE)} SET projectId = :projectId, graphSnapshotId = :graphSnapshotId, topologyId = :topologyId, topologyJson = :topologyJson`,
        params: { projectId, graphSnapshotId, topologyId: topology.topologyId, topologyJson },
      });
    } catch (error) {
      if (exactExistingManifest()) return false;
      fail("ArcadeDB topology manifest write failed.", `ARCADEDB_TOPOLOGY_MANIFEST_WRITE_FAILED:${error.code || "UNKNOWN"}`);
    }
    return true;
  }

  queryTopology(projectId, graphSnapshotId, { anchorIds, maxDepth, maxRecords }) {
    if (!Array.isArray(anchorIds) || anchorIds.length > 500
      || anchorIds.some((nodeId) => typeof nodeId !== "string" || !nodeId)
      || !Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 3
      || !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > ARCADEDB_SERVER_TRAVERSAL_MAX_RECORDS) {
      fail("ArcadeDB server traversal request is invalid.", "INVALID_ARCADEDB_SERVER_TRAVERSAL_REQUEST");
    }
    if (anchorIds.length === 0) return {
      protocolVersion: ARCADEDB_SERVER_TRAVERSAL_VERSION,
      graphSnapshotId,
      anchorIds: [],
      maxDepth,
      maxRecords,
      truncated: false,
      records: [],
    };
    const response = this.invoke("query", {
      command: `SELECT @type AS recordType, nodeJson, edgeJson, $depth AS recordDepth FROM (TRAVERSE bothE('${formatForVerifiedOwner(this.storage).kind(ARCADEDB_EDGE_TYPE)}'), bothV() FROM (SELECT FROM ${formatForVerifiedOwner(this.storage).kind(ARCADEDB_NODE_TYPE)} WHERE projectId = :projectId AND graphSnapshotId = :graphSnapshotId AND nodeId IN :anchorIds) MAXDEPTH ${maxDepth * 2} LIMIT ${maxRecords + 1} STRATEGY BREADTH_FIRST)`,
      params: { projectId, graphSnapshotId, anchorIds },
    });
    const records = responseRecords(response);
    return {
      protocolVersion: ARCADEDB_SERVER_TRAVERSAL_VERSION,
      graphSnapshotId,
      anchorIds: [...anchorIds],
      maxDepth,
      maxRecords,
      truncated: records.length > maxRecords,
      records: records.slice(0, maxRecords),
    };
  }
}

function parseRemoteJson(value, label) {
  if (typeof value !== "string") fail(`${label} is not a JSON string.`, "ARCADEDB_INVALID_RESPONSE");
  try { return JSON.parse(value); }
  catch { fail(`${label} is invalid JSON.`, "ARCADEDB_INVALID_RESPONSE"); }
}

function verifyResumablePartialTopology(remote, graph) {
  if (!remote || remote.topologyJson != null || !Array.isArray(remote.nodeJsons) || !Array.isArray(remote.edgeJsons)) {
    fail("ArcadeDB graph topology partial state is invalid.", "ARCADEDB_GRAPH_TOPOLOGY_CONTENT_MISMATCH");
  }
  const expectedNodes = new Map(graph.nodes.map((node) => [node.nodeId, graphProjectionCanonicalJson(node)]));
  const expectedEdges = new Map(graph.edges.map((edge) => [edge.edgeId, graphProjectionCanonicalJson(edge)]));
  const seenNodes = new Set();
  const seenEdges = new Set();
  for (const value of remote.nodeJsons) {
    const node = parseRemoteJson(value, "ArcadeDB partial graph topology node");
    if (seenNodes.has(node.nodeId) || expectedNodes.get(node.nodeId) !== graphProjectionCanonicalJson(node)) {
      fail("ArcadeDB graph topology contains a conflicting partial node.", "ARCADEDB_GRAPH_TOPOLOGY_CONTENT_MISMATCH");
    }
    seenNodes.add(node.nodeId);
  }
  for (const value of remote.edgeJsons) {
    const edge = parseRemoteJson(value, "ArcadeDB partial graph topology edge");
    if (seenEdges.has(edge.edgeId) || expectedEdges.get(edge.edgeId) !== graphProjectionCanonicalJson(edge)) {
      fail("ArcadeDB graph topology contains a conflicting partial edge.", "ARCADEDB_GRAPH_TOPOLOGY_CONTENT_MISMATCH");
    }
    seenEdges.add(edge.edgeId);
  }
  return true;
}

function unfilteredTraversalRadius(graph, anchorIds, maxDepth) {
  const nodeDepths = new Map(anchorIds.map((nodeId) => [nodeId, 0]));
  const edgeDepths = new Map();
  let frontier = new Set(anchorIds);
  for (let level = 0; level < maxDepth && frontier.size; level += 1) {
    const next = new Set();
    for (const edge of graph.edges) {
      if (!frontier.has(edge.from) && !frontier.has(edge.to)) continue;
      if (!edgeDepths.has(edge.edgeId)) edgeDepths.set(edge.edgeId, (level * 2) + 1);
      for (const nodeId of [edge.from, edge.to]) {
        if (nodeDepths.has(nodeId)) continue;
        nodeDepths.set(nodeId, (level + 1) * 2);
        next.add(nodeId);
      }
    }
    frontier = next;
  }
  return { nodeDepths, edgeDepths };
}

function traversalOptionsFromQuery(query, format) {
  const exactAnchorMode = format.value("exact-head-proposed");
  if (!["lexical-discovery", exactAnchorMode].includes(query.anchorMode)) {
    fail("Prepared traversal query anchor mode differs from its original family.", "INVALID_PREPARED_TRAVERSAL_REQUEST");
  }
  return {
    query: query.anchorMode === "lexical-discovery" ? query.normalizedQuery : null,
    anchorIds: query.anchorMode === exactAnchorMode ? [...query.anchorIds] : null,
    expectedGraphSnapshotId: query.expectedGraphSnapshotId,
    kinds: [...query.allowedKinds],
    relations: [...query.allowedRelations],
    authorityClasses: [...query.allowedAuthorityClasses],
    freshness: [...query.allowedFreshness],
    minConfidence: query.minConfidence,
    includeUnreviewedCandidates: query.includeUnreviewedCandidates,
    depth: query.maxDepth,
    maxNodes: query.maxNodes,
    maxEdges: query.maxEdges,
  };
}

function preparedExpansion(graph, query) {
  const radius = unfilteredTraversalRadius(graph, query.anchorIds, query.maxDepth);
  const nodesById = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const edgesById = new Map(graph.edges.map((edge) => [edge.edgeId, edge]));
  const nodes = [...radius.nodeDepths.entries()].map(([nodeId, recordDepth]) => ({
    nodeId,
    recordDepth,
    nodeJson: graphProjectionCanonicalJson(nodesById.get(nodeId)),
  })).sort((left, right) => left.recordDepth - right.recordDepth || left.nodeId.localeCompare(right.nodeId));
  const edges = [...radius.edgeDepths.entries()].map(([edgeId, recordDepth]) => ({
    edgeId,
    recordDepth,
    edgeJson: graphProjectionCanonicalJson(edgesById.get(edgeId)),
  })).sort((left, right) => left.recordDepth - right.recordDepth || left.edgeId.localeCompare(right.edgeId));
  return {
    ordering: PREPARED_TRAVERSAL_ORDERING,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    recordCount: nodes.length + edges.length,
    nodes,
    edges,
  };
}

function preparedGraphManifest(graph) {
  const payload = {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    nodeSetHash: digest(graphProjectionCanonicalJson(graph.nodes)),
    edgeSetHash: digest(graphProjectionCanonicalJson(graph.edges)),
  };
  return { ...payload, graphManifestHash: digest(graphProjectionCanonicalJson(payload)) };
}

export function buildPreparedTraversalRequest({ graph, result, storage = null } = {}) {
  verifyTemporalProvenanceGraph(graph);
  const format = familyFormatForOriginal("head-agent-core-temporal-provenance", graph, storage);
  if (!format) fail("Prepared traversal owner family is incoherent.", "INVALID_PREPARED_TRAVERSAL_REQUEST");
  if (!result || result.kind !== "TemporalTraversalResult" || !result.traversalQuery) {
    fail("Prepared traversal requires a deterministic TemporalTraversalResult.", "INVALID_PREPARED_TRAVERSAL_REQUEST");
  }
  const recomputed = queryTemporalProvenanceGraph(graph, traversalOptionsFromQuery(result.traversalQuery, format));
  if (graphProjectionCanonicalJson(recomputed) !== graphProjectionCanonicalJson(result)) {
    fail("Prepared traversal result differs from the deterministic GraphSnapshot result.", "PREPARED_TRAVERSAL_RESULT_MISMATCH");
  }
  const expansion = preparedExpansion(graph, result.traversalQuery);
  const expansionHash = digest(graphProjectionCanonicalJson(expansion));
  const payload = {
    schemaVersion: 1,
    kind: "PreparedTraversalRequest",
    protocol: { name: format.protocol("head-agent-core-prepared-traversal"), version: PREPARED_TRAVERSAL_VERSION },
    projectId: graph.projectId,
    graphSnapshotId: graph.graphSnapshotId,
    graphSnapshotHash: graph.graphSnapshotHash,
    sourceSnapshotId: graph.sourceSnapshotId,
    traversalQuery: clone(result.traversalQuery),
    queryId: result.queryId,
    queryHash: result.queryHash,
    resultId: result.resultId,
    resultHash: result.resultHash,
    graphManifest: preparedGraphManifest(graph),
    expansion,
    expansionHash,
    authority: "derived-verification-evidence-only",
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const requestHash = digest(graphProjectionCanonicalJson(payload));
  return verifyPreparedTraversalRequest({ ...payload, requestId: `prepared-traversal-${requestHash.slice(0, 24)}`, requestHash });
}

export function verifyPreparedTraversalRequest(document, { graph = null, result = null, storage = null } = {}) {
  assertFields(document, [
    "schemaVersion", "kind", "protocol", "projectId", "graphSnapshotId", "graphSnapshotHash", "sourceSnapshotId",
    "traversalQuery", "queryId", "queryHash", "resultId", "resultHash", "graphManifest", "expansion", "expansionHash", "authority",
    "instructionAuthority", "promotionAuthority", "requestId", "requestHash",
  ], "Prepared traversal request", "INVALID_PREPARED_TRAVERSAL_REQUEST");
  const format = familyFormatForOriginal("head-agent-core-prepared-traversal", document, storage);
  const exactAnchorMode = format?.value("exact-head-proposed");
  const query = document?.traversalQuery;
  if (query && typeof query === "object" && !Array.isArray(query)) assertFields(query, [
    "anchorMode", "normalizedQuery", "anchorIds", "expectedGraphSnapshotId", "allowedKinds", "allowedRelations", "allowedAuthorityClasses", "allowedFreshness",
    "minConfidence", "includeUnreviewedCandidates", "maxDepth", "maxNodes", "maxEdges", "ordering",
  ], "Prepared traversal query", "INVALID_PREPARED_TRAVERSAL_REQUEST");
  const expansion = document?.expansion;
  const graphManifest = document?.graphManifest;
  if (graphManifest && typeof graphManifest === "object" && !Array.isArray(graphManifest)) assertFields(graphManifest, [
    "nodeCount", "edgeCount", "nodeSetHash", "edgeSetHash", "graphManifestHash",
  ], "Prepared traversal graph manifest", "INVALID_PREPARED_TRAVERSAL_REQUEST");
  if (expansion && typeof expansion === "object" && !Array.isArray(expansion)) assertFields(expansion, [
    "ordering", "nodeCount", "edgeCount", "recordCount", "nodes", "edges",
  ], "Prepared traversal expansion", "INVALID_PREPARED_TRAVERSAL_REQUEST");
  if (!document || document.kind !== "PreparedTraversalRequest" || document.schemaVersion !== 1
    || !format || document.protocol?.version !== PREPARED_TRAVERSAL_VERSION
    || typeof document.projectId !== "string" || !document.projectId
    || !/^graph-snapshot-[a-f0-9]{24}$/.test(document.graphSnapshotId || "")
    || !/^[a-f0-9]{64}$/.test(document.graphSnapshotHash || "")
    || !/^source-snapshot-[a-f0-9]{24}$/.test(document.sourceSnapshotId || "")
    || !query || !["lexical-discovery", exactAnchorMode].includes(query.anchorMode)
    || typeof query.normalizedQuery !== "string"
    || (query.anchorMode === "lexical-discovery" && !query.normalizedQuery)
    || (query.anchorMode === exactAnchorMode && query.normalizedQuery !== "")
    || !Array.isArray(query.anchorIds) || query.anchorIds.length > (query.anchorMode === exactAnchorMode ? 32 : 500)
    || (query.anchorMode === exactAnchorMode && query.anchorIds.length < 1)
    || query.anchorIds.some((nodeId) => typeof nodeId !== "string" || !nodeId || nodeId.length > 256)
    || new Set(query.anchorIds).size !== query.anchorIds.length
    || (query.anchorMode === exactAnchorMode && query.expectedGraphSnapshotId !== document.graphSnapshotId)
    || (query.anchorMode === "lexical-discovery" && query.expectedGraphSnapshotId !== null)
    || !Array.isArray(query.allowedKinds) || !Array.isArray(query.allowedRelations)
    || !Array.isArray(query.allowedAuthorityClasses) || !Array.isArray(query.allowedFreshness)
    || !Number.isFinite(query.minConfidence) || query.minConfidence < 0 || query.minConfidence > 1
    || typeof query.includeUnreviewedCandidates !== "boolean"
    || !Number.isInteger(query.maxDepth) || query.maxDepth < 0 || query.maxDepth > 3
    || !Number.isInteger(query.maxNodes) || query.maxNodes < 1 || query.maxNodes > 500
    || !Number.isInteger(query.maxEdges) || query.maxEdges < 0 || query.maxEdges > 1000
    || query.ordering !== "nodeId-then-edgeId-ascending"
    || !/^traversal-query-[a-f0-9]{24}$/.test(document.queryId || "") || !/^[a-f0-9]{64}$/.test(document.queryHash || "")
    || !/^traversal-result-[a-f0-9]{24}$/.test(document.resultId || "") || !/^[a-f0-9]{64}$/.test(document.resultHash || "")
    || !graphManifest || !Number.isInteger(graphManifest.nodeCount) || graphManifest.nodeCount < 0
    || !Number.isInteger(graphManifest.edgeCount) || graphManifest.edgeCount < 0
    || !/^[a-f0-9]{64}$/.test(graphManifest.nodeSetHash || "")
    || !/^[a-f0-9]{64}$/.test(graphManifest.edgeSetHash || "")
    || !/^[a-f0-9]{64}$/.test(graphManifest.graphManifestHash || "")
    || !expansion || expansion.ordering !== PREPARED_TRAVERSAL_ORDERING
    || !Number.isInteger(expansion.nodeCount) || expansion.nodeCount < 0
    || !Number.isInteger(expansion.edgeCount) || expansion.edgeCount < 0
    || !Number.isInteger(expansion.recordCount) || expansion.recordCount < 0
    || !Array.isArray(expansion.nodes) || !Array.isArray(expansion.edges)
    || expansion.nodeCount !== expansion.nodes.length || expansion.edgeCount !== expansion.edges.length
    || expansion.recordCount !== expansion.nodes.length + expansion.edges.length
    || expansion.nodeCount > graphManifest.nodeCount || expansion.edgeCount > graphManifest.edgeCount
    || !/^[a-f0-9]{64}$/.test(document.expansionHash || "")
    || document.authority !== "derived-verification-evidence-only"
    || document.instructionAuthority !== false || document.promotionAuthority !== false
    || !/^prepared-traversal-[a-f0-9]{24}$/.test(document.requestId || "")
    || !/^[a-f0-9]{64}$/.test(document.requestHash || "")) {
    fail("Prepared traversal request is invalid.", "INVALID_PREPARED_TRAVERSAL_REQUEST");
  }
  const queryHash = digest(graphProjectionCanonicalJson(query));
  if (document.queryHash !== queryHash || document.queryId !== `traversal-query-${queryHash.slice(0, 24)}`) {
    fail("Prepared traversal query digest verification failed.", "PREPARED_TRAVERSAL_QUERY_DIGEST_MISMATCH");
  }
  const nodeIds = new Set();
  for (const record of expansion.nodes) {
    assertFields(record, ["nodeId", "recordDepth", "nodeJson"], "Prepared traversal node", "INVALID_PREPARED_TRAVERSAL_REQUEST");
    let node;
    try { node = JSON.parse(record.nodeJson); } catch { fail("Prepared traversal node JSON is invalid.", "INVALID_PREPARED_TRAVERSAL_REQUEST"); }
    if (!node || typeof node !== "object" || Array.isArray(node) || node.nodeId !== record.nodeId
      || nodeIds.has(record.nodeId) || record.nodeJson !== graphProjectionCanonicalJson(node)
      || !Number.isInteger(record.recordDepth) || record.recordDepth < 0 || record.recordDepth > query.maxDepth * 2
      || record.recordDepth % 2 !== 0) {
      fail("Prepared traversal node is invalid, duplicated, or out of bounds.", "INVALID_PREPARED_TRAVERSAL_REQUEST");
    }
    nodeIds.add(record.nodeId);
  }
  const edgeIds = new Set();
  for (const record of expansion.edges) {
    assertFields(record, ["edgeId", "recordDepth", "edgeJson"], "Prepared traversal edge", "INVALID_PREPARED_TRAVERSAL_REQUEST");
    let edge;
    try { edge = JSON.parse(record.edgeJson); } catch { fail("Prepared traversal edge JSON is invalid.", "INVALID_PREPARED_TRAVERSAL_REQUEST"); }
    if (!edge || typeof edge !== "object" || Array.isArray(edge) || edge.edgeId !== record.edgeId
      || edgeIds.has(record.edgeId) || record.edgeJson !== graphProjectionCanonicalJson(edge)
      || !Number.isInteger(record.recordDepth) || record.recordDepth < 1 || record.recordDepth > query.maxDepth * 2
      || record.recordDepth % 2 !== 1) {
      fail("Prepared traversal edge is invalid, duplicated, or out of bounds.", "INVALID_PREPARED_TRAVERSAL_REQUEST");
    }
    edgeIds.add(record.edgeId);
  }
  const canonicalNodes = [...expansion.nodes].sort((left, right) => left.recordDepth - right.recordDepth || left.nodeId.localeCompare(right.nodeId));
  const canonicalEdges = [...expansion.edges].sort((left, right) => left.recordDepth - right.recordDepth || left.edgeId.localeCompare(right.edgeId));
  const rootIds = expansion.nodes.filter((record) => record.recordDepth === 0).map((record) => record.nodeId).sort();
  if (graphProjectionCanonicalJson(expansion.nodes) !== graphProjectionCanonicalJson(canonicalNodes)
    || graphProjectionCanonicalJson(expansion.edges) !== graphProjectionCanonicalJson(canonicalEdges)
    || graphProjectionCanonicalJson(rootIds) !== graphProjectionCanonicalJson([...query.anchorIds].sort())) {
    fail("Prepared traversal expansion ordering or anchors are invalid.", "INVALID_PREPARED_TRAVERSAL_REQUEST");
  }
  if (document.expansionHash !== digest(graphProjectionCanonicalJson(expansion))) {
    fail("Prepared traversal expansion digest verification failed.", "PREPARED_TRAVERSAL_EXPANSION_DIGEST_MISMATCH");
  }
  const graphManifestPayload = { ...graphManifest };
  delete graphManifestPayload.graphManifestHash;
  if (graphManifest.graphManifestHash !== digest(graphProjectionCanonicalJson(graphManifestPayload))) {
    fail("Prepared traversal graph manifest digest verification failed.", "PREPARED_TRAVERSAL_GRAPH_MANIFEST_DIGEST_MISMATCH");
  }
  const payload = { ...document };
  delete payload.requestId;
  delete payload.requestHash;
  const requestHash = digest(graphProjectionCanonicalJson(payload));
  if (document.requestHash !== requestHash || document.requestId !== `prepared-traversal-${requestHash.slice(0, 24)}`) {
    fail("Prepared traversal request digest verification failed.", "PREPARED_TRAVERSAL_DIGEST_MISMATCH");
  }
  if (graph || result) {
    if (!graph || !result) fail("Prepared traversal expected graph and result must be supplied together.", "INVALID_PREPARED_TRAVERSAL_EXPECTATION");
    const expected = buildPreparedTraversalRequest({ graph, result, storage });
    if (graphProjectionCanonicalJson(document) !== graphProjectionCanonicalJson(expected)) {
      fail("Prepared traversal request differs from the deterministic expected request.", "PREPARED_TRAVERSAL_REQUEST_MISMATCH");
    }
  }
  return document;
}

function preparedTraversalVerificationDocumentFromVerified(prepared, verificationMode) {
  if (typeof verificationMode !== "string" || !/^[a-z0-9-]+$/.test(verificationMode)) {
    fail("Prepared traversal verification mode is invalid.", "INVALID_PREPARED_TRAVERSAL_VERIFICATION");
  }
  const payload = {
    schemaVersion: 1,
    kind: "PreparedTraversalVerification",
    protocol: prepared.protocol,
    requestId: prepared.requestId,
    requestHash: prepared.requestHash,
    graphSnapshotId: prepared.graphSnapshotId,
    graphSnapshotHash: prepared.graphSnapshotHash,
    queryId: prepared.queryId,
    queryHash: prepared.queryHash,
    resultId: prepared.resultId,
    resultHash: prepared.resultHash,
    expansionHash: prepared.expansionHash,
    nodeCount: prepared.expansion.nodeCount,
    edgeCount: prepared.expansion.edgeCount,
    verificationMode,
    authority: "derived-verification-evidence-only",
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const verificationHash = digest(graphProjectionCanonicalJson(payload));
  return {
    ...payload,
    verificationId: `prepared-traversal-verification-${verificationHash.slice(0, 24)}`,
    verificationHash,
  };
}

function buildPreparedTraversalVerificationFromVerified(prepared, verificationMode) {
  return verifyPreparedTraversalVerification(preparedTraversalVerificationDocumentFromVerified(prepared, verificationMode));
}

function buildPreparedTraversalVerification(request, verificationMode) {
  return buildPreparedTraversalVerificationFromVerified(verifyPreparedTraversalRequest(request), verificationMode);
}

export function verifyPreparedTraversalVerification(document, expectedRequest = null, storage = null) {
  assertFields(document, [
    "schemaVersion", "kind", "protocol", "requestId", "requestHash", "graphSnapshotId", "graphSnapshotHash",
    "queryId", "queryHash", "resultId", "resultHash", "expansionHash", "nodeCount", "edgeCount", "verificationMode",
    "authority", "instructionAuthority", "promotionAuthority", "verificationId", "verificationHash",
  ], "Prepared traversal verification", "INVALID_PREPARED_TRAVERSAL_VERIFICATION");
  if (!document || document.kind !== "PreparedTraversalVerification" || document.schemaVersion !== 1
    || !familyFormatForOriginal("head-agent-core-prepared-traversal", document) || document.protocol?.version !== PREPARED_TRAVERSAL_VERSION
    || !/^prepared-traversal-[a-f0-9]{24}$/.test(document.requestId || "") || !/^[a-f0-9]{64}$/.test(document.requestHash || "")
    || !/^graph-snapshot-[a-f0-9]{24}$/.test(document.graphSnapshotId || "") || !/^[a-f0-9]{64}$/.test(document.graphSnapshotHash || "")
    || !/^traversal-query-[a-f0-9]{24}$/.test(document.queryId || "") || !/^[a-f0-9]{64}$/.test(document.queryHash || "")
    || !/^traversal-result-[a-f0-9]{24}$/.test(document.resultId || "") || !/^[a-f0-9]{64}$/.test(document.resultHash || "")
    || !/^[a-f0-9]{64}$/.test(document.expansionHash || "")
    || !Number.isInteger(document.nodeCount) || document.nodeCount < 0
    || !Number.isInteger(document.edgeCount) || document.edgeCount < 0
    || typeof document.verificationMode !== "string" || !/^[a-z0-9-]+$/.test(document.verificationMode)
    || document.authority !== "derived-verification-evidence-only"
    || document.instructionAuthority !== false || document.promotionAuthority !== false
    || !/^prepared-traversal-verification-[a-f0-9]{24}$/.test(document.verificationId || "")
    || !/^[a-f0-9]{64}$/.test(document.verificationHash || "")) {
    fail("Prepared traversal verification is invalid.", "INVALID_PREPARED_TRAVERSAL_VERIFICATION");
  }
  const payload = { ...document };
  delete payload.verificationId;
  delete payload.verificationHash;
  const verificationHash = digest(graphProjectionCanonicalJson(payload));
  if (document.verificationHash !== verificationHash
    || document.verificationId !== `prepared-traversal-verification-${verificationHash.slice(0, 24)}`) {
    fail("Prepared traversal verification digest verification failed.", "PREPARED_TRAVERSAL_VERIFICATION_DIGEST_MISMATCH");
  }
  if (expectedRequest) {
    const request = verifyPreparedTraversalRequest(expectedRequest);
    const expected = preparedTraversalVerificationDocumentFromVerified(request, document.verificationMode);
    if (graphProjectionCanonicalJson(document) !== graphProjectionCanonicalJson(expected)) {
      fail("Prepared traversal verification does not match its request.", "PREPARED_TRAVERSAL_VERIFICATION_MISMATCH");
    }
  }
  return document;
}

function verifyPreparedTraversalVerificationAgainstLocallyBuiltRequest(document, locallyBuiltRequest) {
  const verified = verifyPreparedTraversalVerification(document);
  const expected = preparedTraversalVerificationDocumentFromVerified(locallyBuiltRequest, verified.verificationMode);
  if (graphProjectionCanonicalJson(verified) !== graphProjectionCanonicalJson(expected)) {
    fail("Prepared traversal verification does not match its request.", "PREPARED_TRAVERSAL_VERIFICATION_MISMATCH");
  }
  return verified;
}

function verifyArcadeDbServerTraversalResponseAgainstPrepared({ prepared, response, maxRecords }) {
  const format = familyFormatForOriginal("head-agent-core-prepared-traversal", prepared);
  const query = prepared.traversalQuery;
  assertFields(response, [
    "protocolVersion", "graphSnapshotId", "anchorIds", "maxDepth", "maxRecords", "truncated", "records",
  ], "ArcadeDB server traversal response", "ARCADEDB_SERVER_TRAVERSAL_RESPONSE_MISMATCH");
  if (response.protocolVersion !== ARCADEDB_SERVER_TRAVERSAL_VERSION
    || response.graphSnapshotId !== prepared.graphSnapshotId
    || graphProjectionCanonicalJson(response.anchorIds) !== graphProjectionCanonicalJson(query.anchorIds)
    || response.maxDepth !== query.maxDepth || response.maxRecords !== maxRecords
    || typeof response.truncated !== "boolean" || !Array.isArray(response.records)
    || response.records.length > maxRecords) {
    fail("ArcadeDB server traversal response envelope is invalid or stale.", "ARCADEDB_SERVER_TRAVERSAL_RESPONSE_MISMATCH");
  }
  if (response.truncated) {
    fail("ArcadeDB server traversal exceeded its bounded response budget.", "ARCADEDB_SERVER_TRAVERSAL_TRUNCATED");
  }

  const expectedNodes = new Map(prepared.expansion.nodes.map((record) => [record.nodeId, record]));
  const expectedEdges = new Map(prepared.expansion.edges.map((record) => [record.edgeId, record]));
  const returnedNodes = new Set();
  const returnedEdges = new Set();
  for (const record of response.records) {
    if (!record || typeof record !== "object" || Array.isArray(record)
      || !Number.isInteger(record.recordDepth) || record.recordDepth < 0 || record.recordDepth > query.maxDepth * 2) {
      fail("ArcadeDB server traversal returned an invalid record envelope.", "ARCADEDB_SERVER_TRAVERSAL_RESPONSE_MISMATCH");
    }
    if (record.recordType === format.kind(ARCADEDB_NODE_TYPE) && typeof record.nodeJson === "string" && record.edgeJson == null) {
      const node = parseRemoteJson(record.nodeJson, "ArcadeDB server traversal node");
      const expected = expectedNodes.get(node.nodeId);
      if (!expected || returnedNodes.has(node.nodeId)
        || graphProjectionCanonicalJson(node) !== expected.nodeJson
        || expected.recordDepth !== record.recordDepth) {
        fail("ArcadeDB server traversal returned a duplicate, forged, or out-of-radius node.", "ARCADEDB_SERVER_TRAVERSAL_RESPONSE_MISMATCH");
      }
      returnedNodes.add(node.nodeId);
      continue;
    }
    if (record.recordType === format.kind(ARCADEDB_EDGE_TYPE) && typeof record.edgeJson === "string" && record.nodeJson == null) {
      const edge = parseRemoteJson(record.edgeJson, "ArcadeDB server traversal edge");
      const expected = expectedEdges.get(edge.edgeId);
      if (!expected || returnedEdges.has(edge.edgeId)
        || graphProjectionCanonicalJson(edge) !== expected.edgeJson
        || expected.recordDepth !== record.recordDepth) {
        fail("ArcadeDB server traversal returned a duplicate, forged, or out-of-radius edge.", "ARCADEDB_SERVER_TRAVERSAL_RESPONSE_MISMATCH");
      }
      returnedEdges.add(edge.edgeId);
      continue;
    }
    fail("ArcadeDB server traversal returned an unknown record type.", "ARCADEDB_SERVER_TRAVERSAL_RESPONSE_MISMATCH");
  }

  if (returnedNodes.size !== expectedNodes.size || returnedEdges.size !== expectedEdges.size
    || [...expectedNodes.keys()].some((nodeId) => !returnedNodes.has(nodeId))
    || [...expectedEdges.keys()].some((edgeId) => !returnedEdges.has(edgeId))) {
    fail("ArcadeDB server traversal did not return the complete bounded graph radius.", "ARCADEDB_SERVER_TRAVERSAL_COVERAGE_MISMATCH");
  }
  return true;
}

function verifyArcadeDbServerTraversalResponse({ request, response, maxRecords }) {
  return verifyArcadeDbServerTraversalResponseAgainstPrepared({
    prepared: verifyPreparedTraversalRequest(request),
    response,
    maxRecords,
  });
}

export class ArcadeDbGraphProjectionAdapter {
  constructor({
    storageSelection,
    storage = null,
    transport = null,
    topologyRequired = false,
    serverTraversalRequired = false,
    preparedTraversalRequired = false,
    rewriteTopologyManifest = false,
    incrementalSyncRequired = false,
    stagedPointer = null,
    baseGraph = null,
  } = {}) {
    this.storage = storage;
    this.storageSelection = verifyStorageSelection(storageSelection, "", storage);
    if (this.storageSelection.mode !== "graphdb") fail("ArcadeDB adapter requires a GraphDB storage selection.", "ARCADEDB_SELECTION_REQUIRED");
    this.projectId = this.storageSelection.projectId;
    this.transport = assertArcadeDbTransport(transport || new ArcadeDbHttpTransport({ storageSelection: this.storageSelection, storage }));
    this.adapterVersion = GRAPH_PROJECTION_ADAPTER_VERSION;
    const endpoint = new URL(this.storageSelection.graphdb.endpoint);
    this.locationBase = `arcadedb://${endpoint.host}/${encodeURIComponent(this.storageSelection.graphdb.database)}/${formatForVerifiedOwner(storage).dialect === "lode" ? "lode-agent" : "head-agent"}/${encodeURIComponent(this.projectId)}`;
    this.schemaReady = false;
    this.topologySchemaReady = false;
    this.preparedTraversalRequired = preparedTraversalRequired === true;
    this.rewriteTopologyManifest = rewriteTopologyManifest === true;
    this.incrementalSyncRequired = incrementalSyncRequired === true;
    this.stagedPointer = stagedPointer == null ? null : clone(verifyGraphProjectionPointer(stagedPointer, null, this.storage));
    if (baseGraph != null) verifyTemporalProvenanceGraph(baseGraph);
    this.baseGraph = baseGraph == null ? null : clone(baseGraph);
    this.pendingIncrementalSync = null;
    this.completedIncrementalSync = null;
    this.pendingPointerBase = null;
    this.serverTraversalRequired = serverTraversalRequired === true || this.preparedTraversalRequired;
    this.topologyRequired = topologyRequired === true || this.serverTraversalRequired;
    if (this.serverTraversalRequired) assertArcadeDbServerTraversalTransport(this.transport);
    if (this.preparedTraversalRequired) assertArcadeDbPreparedTraversalTransport(this.transport);
    if (this.incrementalSyncRequired) assertArcadeDbIncrementalSyncTransport(this.transport);
  }

  describe() {
    return {
      ...descriptor("arcadedb-http", { remote: true, durable: true }),
      remoteProtocol: this.transport.describe().protocol,
      remoteProtocolVersion: ARCADEDB_GRAPH_PROJECTION_VERSION,
      credentialsPersisted: false,
      serverRecordIdentitySemantic: false,
      incrementalSyncProtocolVersion: this.incrementalSyncRequired ? ARCADEDB_INCREMENTAL_SYNC_VERSION : null,
      incrementalSyncMode: this.incrementalSyncRequired ? "content-addressed-batches-checkpoints-cas" : "legacy-full-materialization",
      topologyMode: this.topologyRequired ? "snapshot-scoped-vertex-edge-verified" : "not-required",
      traversalMode: this.serverTraversalRequired
        ? ARCADEDB_SERVER_TRAVERSAL_MODE
        : this.topologyRequired ? "verified-topology-client-reference" : "verified-snapshot-client-reference",
      ...(this.serverTraversalRequired ? {
        serverTraversalProtocolVersion: ARCADEDB_SERVER_TRAVERSAL_VERSION,
      } : {}),
      ...(this.preparedTraversalRequired ? {
        preparedTraversalProtocolVersion: PREPARED_TRAVERSAL_VERSION,
        preparedTraversalMode: "manifest-and-bounded-records",
      } : {}),
    };
  }

  diagnostics() {
    return typeof this.transport.preparedReadBatchDiagnostics === "function"
      ? { preparedReadBatch: this.transport.preparedReadBatchDiagnostics() }
      : {};
  }

  ensureSchema() {
    if (!this.schemaReady) {
      this.transport.ensureSchema();
      this.schemaReady = true;
    }
  }

  ensureTopologySchema() {
    if (!this.topologySchemaReady) {
      assertArcadeDbTopologyTransport(this.transport).ensureTopologySchema();
      this.topologySchemaReady = true;
    }
  }

  async readPointer() {
    if (this.stagedPointer) return { location: `${this.locationBase}/staged-current`, document: clone(this.stagedPointer) };
    const value = (await this.transport.readPointer(this.projectId));
    return value == null ? null : { location: `${this.locationBase}/current`, document: parseRemoteJson(value, "ArcadeDB graph projection pointer") };
  }

  async readPointerForPreparedQuery() {
    return bindPreparedPointerRead(this, (await this.readPointer()));
  }

  async readSnapshot(id) {
    graphSnapshotId(id);
    const value = (await this.transport.readSnapshot(this.projectId, id));
    if (value == null) return null;
    const document = parseRemoteJson(value, "ArcadeDB graph projection snapshot");
    if (this.topologyRequired) this.readTopology(document);
    return { location: `${this.locationBase}/snapshots/${id}`, document };
  }

  async writeSnapshot(id, document) {
    graphSnapshotId(id);
    this.ensureSchema();
    if (this.incrementalSyncRequired) {
      verifyTemporalProvenanceGraph(document);
      this.ensureTopologySchema();
      const transport = assertArcadeDbIncrementalSyncTransport(this.transport);
      const pointerJson = (await transport.readPointer(this.projectId));
      const pointer = pointerJson == null ? null : verifyGraphProjectionPointer(parseRemoteJson(pointerJson, "ArcadeDB graph projection pointer"), null, this.storage);
      let baseGraph = pointer ? this.baseGraph : null;
      if (pointer && (!baseGraph || baseGraph.graphSnapshotId !== pointer.graphSnapshotId || baseGraph.graphSnapshotHash !== pointer.graphSnapshotHash)) {
        const baseJson = (await transport.readSnapshot(this.projectId, pointer.graphSnapshotId));
        if (baseJson == null) fail("ArcadeDB incremental sync pointer references a missing base GraphSnapshot.", "ARCADEDB_INCREMENTAL_SYNC_BASE_MISSING");
        baseGraph = parseRemoteJson(baseJson, "ArcadeDB incremental sync base GraphSnapshot");
        verifyTemporalProvenanceGraph(baseGraph);
      }
      if (pointer && (baseGraph.projectId !== pointer.projectId || baseGraph.graphSnapshotId !== pointer.graphSnapshotId
        || baseGraph.graphSnapshotHash !== pointer.graphSnapshotHash || baseGraph.sourceSnapshotId !== pointer.sourceSnapshotId)) {
        fail("ArcadeDB incremental sync base graph differs from the current pointer.", "ARCADEDB_INCREMENTAL_SYNC_BASE_MISMATCH");
      }
      const manifest = buildArcadeDbIncrementalSyncManifest({ storage: this.storage, baseGraph, targetGraph: document });
      const syncState = executeArcadeDbIncrementalSync({ transport, manifest, baseGraph, targetGraph: document });
      const topology = buildArcadeDbGraphTopology(document, this.storage);
      transport.writeTopology(this.projectId, document.graphSnapshotId, clone(document), clone(topology));
      const verifiedTopology = this.readTopology(document).topology;
      const created = (await transport.writeSnapshot(this.projectId, id, graphProjectionCanonicalJson(document), {
        graphSnapshotHash: document.graphSnapshotHash,
        sourceSnapshotId: document.sourceSnapshotId,
        topologyBacked: true,
      }));
      const value = (await transport.readSnapshot(this.projectId, id));
      if (value == null) fail("ArcadeDB did not return the synchronized GraphSnapshot.", "GRAPH_PROJECTION_WRITE_MISMATCH");
      const verifiedDocument = parseRemoteJson(value, "ArcadeDB synchronized GraphSnapshot");
      verifyTemporalProvenanceGraph(verifiedDocument);
      if (graphProjectionCanonicalJson(verifiedDocument) !== graphProjectionCanonicalJson(document)) {
        fail("ArcadeDB synchronized GraphSnapshot differs from the target.", "GRAPH_PROJECTION_WRITE_MISMATCH");
      }
      this.pendingPointerBase = pointer;
      this.pendingIncrementalSync = { manifest, syncState, topology: verifiedTopology };
      return { location: `${this.locationBase}/snapshots/${id}`, document: verifiedDocument, created, incrementalSync: syncState };
    }
    if (this.topologyRequired) this.materializeTopology(document);
    const created = (await this.transport.writeSnapshot(this.projectId, id, graphProjectionCanonicalJson(document), {
      graphSnapshotHash: document.graphSnapshotHash,
      sourceSnapshotId: document.sourceSnapshotId,
    }));
    const entry = (await this.readSnapshot(id));
    if (!entry) fail("ArcadeDB did not return the written GraphSnapshot.", "GRAPH_PROJECTION_WRITE_MISMATCH");
    return { ...entry, created };
  }

  async writePointer(document) {
    if (this.stagedPointer) {
      this.stagedPointer = clone(verifyGraphProjectionPointer(document, null, this.storage));
      return { location: `${this.locationBase}/staged-current`, document: clone(this.stagedPointer) };
    }
    this.ensureSchema();
    if (this.pendingIncrementalSync) {
      const expectedJson = this.pendingPointerBase == null ? null : graphProjectionCanonicalJson(this.pendingPointerBase);
      const pointerJson = graphProjectionCanonicalJson(document);
      const applied = assertArcadeDbIncrementalSyncTransport(this.transport)
        .writePointerCompareAndSwap(this.projectId, expectedJson, pointerJson);
      if (!applied) fail("ArcadeDB graph pointer changed during incremental sync.", "ARCADEDB_INCREMENTAL_SYNC_POINTER_CONFLICT");
      const entry = (await this.readPointer());
      if (!entry || graphProjectionCanonicalJson(entry.document) !== pointerJson) {
        fail("ArcadeDB incremental sync pointer verification failed.", "GRAPH_PROJECTION_WRITE_MISMATCH");
      }
      this.pendingIncrementalSync.pointerAfter = clone(entry.document);
      this.completedIncrementalSync = {
        ...this.pendingIncrementalSync,
        pointerBefore: clone(this.pendingPointerBase),
        pointerAfter: clone(entry.document),
      };
      this.pendingIncrementalSync = null;
      this.pendingPointerBase = null;
      return entry;
    }
    if (this.incrementalSyncRequired) {
      const entry = (await this.readPointer());
      if (entry && graphProjectionCanonicalJson(entry.document) === graphProjectionCanonicalJson(document)) return entry;
      fail("ArcadeDB pointer advancement requires a verified incremental sync.", "ARCADEDB_INCREMENTAL_SYNC_REQUIRED");
    }
    this.transport.writePointer(this.projectId, graphProjectionCanonicalJson(document));
    const entry = (await this.readPointer());
    if (!entry) fail("ArcadeDB did not return the written graph pointer.", "GRAPH_PROJECTION_WRITE_MISMATCH");
    return entry;
  }

  takeCompletedIncrementalSync() {
    const completed = this.completedIncrementalSync;
    this.completedIncrementalSync = null;
    return completed == null ? null : clone(completed);
  }

  async listSnapshotIds() {
    return (await this.transport.listSnapshotIds(this.projectId)).map(graphSnapshotId).sort();
  }

  materializeTopology(graph) {
    verifyTemporalProvenanceGraph(graph);
    this.ensureTopologySchema();
    const transport = assertArcadeDbTopologyTransport(this.transport);
    const topology = buildArcadeDbGraphTopology(graph, this.storage);
    if (!this.rewriteTopologyManifest) {
      const existing = transport.readTopology(this.projectId, graph.graphSnapshotId);
      if (existing?.topologyJson != null) return this.readTopology(graph).topology;
      if (existing) verifyResumablePartialTopology(existing, graph);
    }
    transport.writeTopology(this.projectId, graph.graphSnapshotId, clone(graph), clone(topology));
    return this.readTopology(graph).topology;
  }

  readTopology(graph) {
    verifyTemporalProvenanceGraph(graph);
    const remote = assertArcadeDbTopologyTransport(this.transport).readTopology(this.projectId, graph.graphSnapshotId);
    if (!remote) fail("ArcadeDB graph topology is missing.", "ARCADEDB_GRAPH_TOPOLOGY_MISSING");
    if (typeof remote.topologyJson !== "string" || !Array.isArray(remote.nodeJsons) || !Array.isArray(remote.edgeJsons)) {
      if (Array.isArray(remote.nodeJsons) || Array.isArray(remote.edgeJsons)) {
        fail("ArcadeDB graph topology is partial.", "ARCADEDB_GRAPH_TOPOLOGY_CONTENT_MISMATCH");
      }
      fail("ArcadeDB graph topology record envelope is invalid.", "ARCADEDB_INVALID_RESPONSE");
    }
    const topology = verifyArcadeDbGraphTopology(parseRemoteJson(remote.topologyJson, "ArcadeDB graph topology"), graph, this.storage);
    const nodes = remote.nodeJsons.map((value) => parseRemoteJson(value, "ArcadeDB graph topology node"))
      .sort((left, right) => String(left.nodeId).localeCompare(String(right.nodeId)));
    const edges = remote.edgeJsons.map((value) => parseRemoteJson(value, "ArcadeDB graph topology edge"))
      .sort((left, right) => String(left.edgeId).localeCompare(String(right.edgeId)));
    if (nodes.length !== topology.nodeCount || edges.length !== topology.edgeCount
      || digest(graphProjectionCanonicalJson(nodes)) !== topology.nodeSetHash
      || digest(graphProjectionCanonicalJson(edges)) !== topology.edgeSetHash
      || graphProjectionCanonicalJson(nodes) !== graphProjectionCanonicalJson(graph.nodes)
      || graphProjectionCanonicalJson(edges) !== graphProjectionCanonicalJson(graph.edges)) {
      fail("ArcadeDB graph topology is partial, conflicting, or divergent.", "ARCADEDB_GRAPH_TOPOLOGY_CONTENT_MISMATCH");
    }
    return { topology, nodes, edges, location: `${this.locationBase}/topologies/${graph.graphSnapshotId}` };
  }

  async query(id, options) {
    const entry = (await this.readSnapshot(id));
    if (!entry) fail(`Graph projection snapshot is missing: ${id}`, "GRAPH_PROJECTION_SNAPSHOT_MISSING");
    const reference = queryTemporalProvenanceGraph(entry.document, options);
    if (!this.serverTraversalRequired || reference.traversalQuery.anchorIds.length === 0) return reference;
    const request = buildPreparedTraversalRequest({ graph: entry.document, result: reference, storage: this.storage });
    if (request.expansion.recordCount > ARCADEDB_SERVER_TRAVERSAL_MAX_RECORDS) {
      fail("ArcadeDB server traversal expansion exceeds the record budget.", "ARCADEDB_SERVER_TRAVERSAL_RECORD_LIMIT");
    }
    const maxRecords = Math.max(1, request.expansion.recordCount);
    let response;
    try {
      response = assertArcadeDbServerTraversalTransport(this.transport).queryTopology(
        this.projectId,
        entry.document.graphSnapshotId,
        {
          anchorIds: [...reference.traversalQuery.anchorIds],
          maxDepth: reference.traversalQuery.maxDepth,
          maxRecords,
        },
      );
    } catch (error) { fail("ArcadeDB server traversal query failed.", `ARCADEDB_SERVER_TRAVERSAL_QUERY_FAILED_DEPTH_${reference.traversalQuery.maxDepth}:${error.code || "UNKNOWN"}`); }
    verifyArcadeDbServerTraversalResponse({ request, response, maxRecords });
    return reference;
  }

  async queryPrepared(request, { pointerReadToken = null } = {}) {
    if (!this.preparedTraversalRequired) {
      fail("ArcadeDB prepared traversal is not active for this adapter.", "PREPARED_TRAVERSAL_NOT_ACTIVE");
    }
    const prepared = verifyPreparedTraversalRequest(request, { storage: this.storage });
    if (prepared.projectId !== this.projectId) {
      fail("Prepared traversal project does not match the ArcadeDB adapter.", "PREPARED_TRAVERSAL_PROJECT_MISMATCH");
    }
    if (prepared.expansion.recordCount > ARCADEDB_SERVER_TRAVERSAL_MAX_RECORDS) {
      fail("ArcadeDB prepared traversal expansion exceeds the record budget.", "ARCADEDB_SERVER_TRAVERSAL_RECORD_LIMIT");
    }
    const pointerEntry = consumePreparedPointerRead(this, pointerReadToken) || (await this.readPointer());
    if (!pointerEntry) fail("ArcadeDB graph projection pointer is missing.", "GRAPH_PROJECTION_SNAPSHOT_MISSING");
    verifyGraphProjectionPointer(pointerEntry.document, prepared, this.storage);
    const transport = assertArcadeDbPreparedTraversalTransport(this.transport);
    const maxRecords = Math.max(1, prepared.expansion.recordCount);
    const batch = typeof transport.readPreparedTraversalBatch === "function"
      ? transport.readPreparedTraversalBatch(this.projectId, prepared.graphSnapshotId, {
        anchorIds: [...prepared.traversalQuery.anchorIds],
        maxDepth: prepared.traversalQuery.maxDepth,
        maxRecords,
      })
      : null;
    const topologyJson = batch ? batch.topologyJson : transport.readTopologyManifest(this.projectId, prepared.graphSnapshotId);
    if (typeof topologyJson !== "string") fail("ArcadeDB graph topology manifest is missing.", "ARCADEDB_GRAPH_TOPOLOGY_MISSING");
    const topology = verifyArcadeDbGraphTopology(parseRemoteJson(topologyJson, "ArcadeDB graph topology manifest"), null, this.storage);
    const graphManifest = prepared.graphManifest;
    if (topology.projectId !== prepared.projectId || topology.graphSnapshotId !== prepared.graphSnapshotId
      || topology.graphSnapshotHash !== prepared.graphSnapshotHash || topology.sourceSnapshotId !== prepared.sourceSnapshotId
      || topology.nodeCount !== graphManifest.nodeCount || topology.edgeCount !== graphManifest.edgeCount
      || topology.nodeSetHash !== graphManifest.nodeSetHash || topology.edgeSetHash !== graphManifest.edgeSetHash) {
      fail("ArcadeDB graph topology manifest is stale or cannot cover the prepared traversal.", "ARCADEDB_GRAPH_TOPOLOGY_MISMATCH");
    }
    if (prepared.traversalQuery.anchorIds.length > 0) {
      const response = batch ? batch.traversal : transport.queryTopology(this.projectId, prepared.graphSnapshotId, {
        anchorIds: [...prepared.traversalQuery.anchorIds],
        maxDepth: prepared.traversalQuery.maxDepth,
        maxRecords,
      });
      verifyArcadeDbServerTraversalResponseAgainstPrepared({ prepared, response, maxRecords });
    }
    return buildPreparedTraversalVerificationFromVerified(prepared, "arcadedb-manifest-bounded-expansion");
  }
}

const FALLBACK_CODES = new Set(["ARCADEDB_TRANSPORT_UNAVAILABLE", "ARCADEDB_CREDENTIALS_UNAVAILABLE"]);

export class ActivatedArcadeDbGraphProjectionAdapter {
  constructor({ projectRoot, storageSelection, remoteAdapter = null, transport = null, storage = null } = {}) {
    this.adapterVersion = GRAPH_PROJECTION_ADAPTER_VERSION;
    this.storage = storage;
    this.projectRoot = path.resolve(projectRoot || ".");
    this.projectId = storageSelection.projectId;
    this.local = new LocalJsonGraphProjectionAdapter({ projectRoot, storage });
    this.remote = remoteAdapter || new ArcadeDbGraphProjectionAdapter({ storageSelection, transport, storage });
    this.fallbackUsed = false;
    this.fallbackReasonCode = "";
    this.remoteObserved = false;
    this.remoteMutated = false;
    this.pendingTopologyActivation = null;
    this.lastIncrementalSyncReceipt = null;
  }

  describe() {
    const remoteDescriptor = this.remote.describe();
    return {
      ...descriptor("activated-arcadedb-with-local-mirror", { remote: true, durable: true }),
      credentialsPersisted: false,
      localMirror: true,
      fallbackPolicy: "unavailable-before-remote-observation-only",
      topologyMode: remoteDescriptor.topologyMode,
      traversalMode: remoteDescriptor.traversalMode,
      ...(remoteDescriptor.serverTraversalProtocolVersion
        ? { serverTraversalProtocolVersion: remoteDescriptor.serverTraversalProtocolVersion }
        : {}),
      ...(remoteDescriptor.preparedTraversalProtocolVersion ? {
        preparedTraversalProtocolVersion: remoteDescriptor.preparedTraversalProtocolVersion,
        preparedTraversalMode: remoteDescriptor.preparedTraversalMode,
      } : {}),
      ...(remoteDescriptor.incrementalSyncProtocolVersion ? {
        incrementalSyncProtocolVersion: remoteDescriptor.incrementalSyncProtocolVersion,
        incrementalSyncMode: remoteDescriptor.incrementalSyncMode,
      } : {}),
    };
  }

  diagnostics() {
    const remoteDiagnostics = typeof this.remote.diagnostics === "function" ? this.remote.diagnostics() : {};
    const batchFallback = remoteDiagnostics.preparedReadBatch?.fallbackUsed === true;
    return {
      ...remoteDiagnostics,
      fallbackUsed: this.fallbackUsed || batchFallback,
      fallbackReasonCode: this.fallbackReasonCode || remoteDiagnostics.preparedReadBatch?.fallbackReasonCode || "",
    };
  }

  async callRemote(operation, fallback) {
    if (this.fallbackUsed) return fallback();
    try { return await operation(); }
    catch (error) {
      if (!FALLBACK_CODES.has(error.code) || this.remoteObserved || this.remoteMutated) throw error;
      this.fallbackUsed = true;
      this.fallbackReasonCode = error.code;
      return fallback();
    }
  }

  async readVerifiedLocalPointer() {
    const entry = (await this.local.readPointer());
    if (!entry) return null;
    const snapshot = (await this.readVerifiedLocalSnapshot(entry.document.graphSnapshotId));
    if (!snapshot) fail("Local mirror pointer references missing evidence.", "GRAPH_PROJECTION_SNAPSHOT_MISSING");
    verifyGraphProjectionPointer(entry.document, snapshot.document, this.storage);
    this.localBasis = entry.document;
    return entry;
  }

  async readVerifiedLocalSnapshot(id) {
    const entry = (await this.local.readSnapshot(id));
    if (!entry) return null;
    verifyTemporalProvenanceGraph(entry.document);
    if (entry.document.projectId !== this.projectId || entry.document.graphSnapshotId !== id
      || (this.localBasis?.graphSnapshotId === id && this.localBasis.graphSnapshotHash !== entry.document.graphSnapshotHash)) {
      fail("Local mirror identity does not match the requested evidence.", "GRAPH_PROJECTION_SNAPSHOT_CONFLICT");
    }
    return entry;
  }

  async readPointer() {
    const entry = (await this.callRemote(async () => (await this.remote.readPointer()), async () => (await this.readVerifiedLocalPointer())));
    if (!this.fallbackUsed) this.remoteObserved = true;
    return entry;
  }

  async readPointerForPreparedQuery() {
    const entry = (await this.callRemote(
      async () => typeof this.remote.readPointerForPreparedQuery === "function"
        ? (await this.remote.readPointerForPreparedQuery())
        : (await this.remote.readPointer()),
      async () => (await this.readVerifiedLocalPointer()),
    ));
    if (!this.fallbackUsed) this.remoteObserved = true;
    return entry;
  }

  async readSnapshot(id) {
    const entry = (await this.callRemote(async () => (await this.remote.readSnapshot(id)), async () => (await this.readVerifiedLocalSnapshot(id))));
    if (!this.fallbackUsed) this.remoteObserved = true;
    return entry;
  }

  async writeSnapshot(id, document) {
    const entry = (await this.callRemote(async () => {
      this.remoteMutated = true;
      const remoteEntry = (await this.remote.writeSnapshot(id, document));
      const localEntry = (await this.local.writeSnapshot(id, document));
      if (graphProjectionCanonicalJson(localEntry.document) !== graphProjectionCanonicalJson(remoteEntry.document)) {
        fail("ArcadeDB and local mirror snapshots differ.", "GRAPH_PROJECTION_SNAPSHOT_CONFLICT");
      }
      if (this.remote.topologyRequired) {
        const topology = this.remote.readTopology(document).topology;
        this.pendingTopologyActivation = buildArcadeDbGraphTopologyActivation({ storage: this.storage,
          storageSelection: this.remote.storageSelection,
          graph: document,
          topology,
        });
      }
      return remoteEntry;
    }, async () => (await this.local.writeSnapshot(id, document))));
    return entry;
  }

  async publishRemotePointer(document) {
    const localEntry = (await this.local.readPointer());
    if (!localEntry || graphProjectionCanonicalJson(localEntry.document) !== graphProjectionCanonicalJson(document)) {
      fail("Local mirror no longer names the prepared pointer; remote publication was not attempted.", "GRAPH_PROJECTION_WRITE_MISMATCH");
    }
    return (await this.callRemote(async () => {
      this.remoteMutated = true;
      const remoteEntry = await this.remote.writePointer(document);
      if (graphProjectionCanonicalJson(localEntry.document) !== graphProjectionCanonicalJson(remoteEntry.document)) {
        fail("ArcadeDB and local mirror pointers differ.", "GRAPH_PROJECTION_WRITE_MISMATCH");
      }
      // Awaited remote work cannot use the pre-await mirror object as proof.
      // A concurrent public materialization may already have advanced it.
      const currentLocal = this.local.readPointer();
      if (!currentLocal || graphProjectionCanonicalJson(currentLocal.document) !== graphProjectionCanonicalJson(document)) {
        const error = Object.assign(new Error("Remote Graph pointer was published, but the local mirror changed while awaiting it; preserve the newer local pointer."), { code: "GRAPH_PROJECTION_PUBLICATION_CONFLICT" });
        error.graphPublication = { local: "superseded", remote: "published-at-prior-basis", graphSnapshotId: document.graphSnapshotId };
        throw error;
      }
      const completedSync = typeof this.remote.takeCompletedIncrementalSync === "function"
        ? this.remote.takeCompletedIncrementalSync()
        : null;
      if (completedSync) {
        const receipt = buildArcadeDbIncrementalSyncReceipt({
          manifest: completedSync.manifest,
          syncState: completedSync.syncState,
          pointerBefore: completedSync.pointerBefore,
          pointerAfter: completedSync.pointerAfter,
          snapshotVerified: true,
          topologyVerified: true,
          localMirrorVerified: true,
        });
        this.lastIncrementalSyncReceipt = persistArcadeDbIncrementalSyncReceipt({ storage: this.storage,
          projectRoot: this.projectRoot,
          receipt,
        }).receipt;
      }
      if (this.pendingTopologyActivation) {
        if (this.pendingTopologyActivation.graphSnapshotId !== document.graphSnapshotId
          || this.pendingTopologyActivation.graphSnapshotHash !== document.graphSnapshotHash) {
          fail("ArcadeDB topology activation does not match the advancing graph pointer.", "ARCADEDB_TOPOLOGY_ACTIVATION_STALE");
        }
        persistArcadeDbGraphTopologyActivation({ storage: this.storage, projectRoot: this.projectRoot, activation: this.pendingTopologyActivation });
        this.pendingTopologyActivation = null;
      }
      return remoteEntry;
    }, () => localEntry));
  }

  async writePointer(document) {
    this.local.writePointer(document);
    return this.publishRemotePointer(document);
  }

  async listSnapshotIds() {
    return (await this.callRemote(async () => {
      const remoteIds = (await this.remote.listSnapshotIds());
      if (remoteIds.length) this.remoteObserved = true;
      return [...new Set([...remoteIds, ...(await this.local.listSnapshotIds())])].sort();
    }, async () => (await this.local.listSnapshotIds())));
  }

  async query(id, options) {
    const result = (await this.callRemote(async () => (await this.remote.query(id, options)), async () => (await this.local.query(id, options))));
    if (!this.fallbackUsed) this.remoteObserved = true;
    return result;
  }

  async queryPrepared(request, context = {}) {
    const verification = (await this.callRemote(
      async () => (await this.remote.queryPrepared(request, context)),
      async () => (await this.local.queryPrepared(request, context)),
    ));
    if (!this.fallbackUsed) this.remoteObserved = true;
    return verification;
  }
}

export class LocalJsonGraphProjectionAdapter {
  constructor({ projectRoot, storage = null, snapshotEncoding = "gzip", snapshotLayout, bundleEncoding = "gzip", gitOptions = {} }) {
    if (typeof projectRoot !== "string" || !projectRoot.trim()) fail("Local graph projection requires projectRoot.", "GRAPH_PROJECTION_ROOT_REQUIRED");
    this.storage = storage;
    this.projectRoot = path.resolve(projectRoot);
    // Pure lower contracts do not acquire a Project-init prerequisite.
    // Selecting the default never replaces composition's full owner checks.
    if (snapshotLayout === undefined) snapshotLayout = snapshotEncoding === "git" || !projectOwnsRecordedRoot(storage, this.projectRoot) ? "whole" : SHARED_DOMAIN_LAYOUT;
    if (!["whole", DOMAIN_BUNDLE_LAYOUT, SHARED_DOMAIN_LAYOUT].includes(snapshotLayout)) fail("Unknown snapshot layout.", "INVALID_SNAPSHOT_LAYOUT");
    this.snapshotLayout = snapshotLayout; this.bundleEncoding = bundleEncoding;
    this.snapshotEncoding = snapshotEncoding;
    this.gitOptions = gitOptions;
    this.gitStore = () => new GitSnapshotStore({ projectRoot: this.projectRoot, storage: this.storage, ...this.gitOptions });
    this.adapterVersion = GRAPH_PROJECTION_ADAPTER_VERSION;
  }

  describe() {
    return {
      ...descriptor(this.snapshotEncoding === "git" ? "local-git-snapshot-candidate" : "local-json", { remote: false, durable: true }),
      ...(this.snapshotLayout !== "whole" ? { snapshotLayout: this.snapshotLayout } : {}),
      preparedTraversalProtocolVersion: PREPARED_TRAVERSAL_VERSION,
      preparedTraversalMode: "local-snapshot-reference",
    };
  }

  pointerLocation() {
    return path.join(this.projectRoot, formatForVerifiedOwner(this.storage).directory, "graph-projection", "current.json");
  }

  snapshotLocation(id) {
    return storedSnapshotLocation(this.projectRoot, path.join(this.projectRoot, formatForVerifiedOwner(this.storage).directory, "graph-projection", "snapshots", `${graphSnapshotId(id)}.json`), this.snapshotEncoding === "git" ? "gzip" : this.snapshotEncoding);
  }

  readPointer() {
    const location = this.pointerLocation();
    return fs.existsSync(location) ? { location, document: parseDocument(location, "Graph projection pointer") } : null;
  }

  async readSnapshot(id) {
    const location = this.snapshotLocation(id);
    const entry = fs.existsSync(location) ? { location, document: parseDocument(location, "Graph projection snapshot") }
      : this.storage?.projectFile ? await this.gitStore().read(id) : null;
    return hydrateSnapshotEntry({ root: this.projectRoot, storage: this.storage, entry });
  }

  async writeSnapshot(id, document) {
    return withSnapshotReferencesAsync({ root: this.projectRoot, storage: this.storage }, () => this.#writeSnapshotUnderLifetime(id, document));
  }

  async #writeSnapshotUnderLifetime(id, document) {
    const existing = await this.readSnapshot(id);
    if (existing) return { ...existing, created: false };
    if (this.snapshotLayout === DOMAIN_BUNDLE_LAYOUT || this.snapshotLayout === SHARED_DOMAIN_LAYOUT && document.kind === "GraphSnapshot") {
      document = createSnapshotComposition({ root: this.projectRoot, storage: this.storage, document, encoding: this.bundleEncoding, layout: this.snapshotLayout }).document;
    }
    if (this.snapshotEncoding === "git") {
      return hydrateSnapshotEntry({ root: this.projectRoot, storage: this.storage, entry: await this.gitStore().write(id, document) });
    }
    const written = writeStoredSnapshot({ root: this.projectRoot, jsonFile: path.join(this.projectRoot, formatForVerifiedOwner(this.storage).directory, "graph-projection", "snapshots", `${graphSnapshotId(id)}.json`), document, encoding: this.snapshotEncoding, readDocument: file => parseDocument(file, "Graph projection snapshot") });
    return hydrateSnapshotEntry({ root: this.projectRoot, storage: this.storage, entry: written });
  }

  writePointer(document) {
    return withSnapshotReferences({ root: this.projectRoot, storage: this.storage }, () => {
      // Revalidate precomputed exact targets after admission. No asynchronous
      // pointer conversion or new Product semantic gate. Mixed Git is retained
      // by collection and does not require a synchronous Git subprocess here.
      const gitDirectory = path.join(this.projectRoot, formatForVerifiedOwner(this.storage).directory, "snapshot-objects.git");
      for (const target of [document.graphSnapshotId]) {
        if (!target) continue;
        const targetFile = this.snapshotLocation(target);
        if (!fs.existsSync(targetFile)) {
          // This is a synchronous address revalidation under the active lifetime.
          // Unsupported Git layouts retain their GC exclusion rather than adding a semantic preparation gate.
          if(fs.existsSync(gitDirectory)&&verifyLooseSnapshotAddress({root:this.projectRoot,storage:this.storage,id:target}))continue;
          throw Object.assign(new Error("Snapshot pointer target is missing."), { code: "SNAPSHOT_POINTER_TARGET_MISSING" });
        }
        const original = parseDocument(targetFile, "Snapshot pointer target");
        if (original.graphSnapshotId !== target) throw Object.assign(new Error("Snapshot pointer target identity changed."), { code: "SNAPSHOT_POINTER_TARGET_MISMATCH" });
      }
      const location = this.pointerLocation();
      atomicWrite(location, json(document));
      return { location, document };
    });
  }

  async listSnapshotIds() {
    const directory = path.join(this.projectRoot, formatForVerifiedOwner(this.storage).directory, "graph-projection", "snapshots");
    return [...new Set([...listStoredSnapshotIds(this.projectRoot, directory, "graph-snapshot"), ...(this.storage?.projectFile ? await this.gitStore().list("graph-snapshot") : [])])].sort();
  }

  async query(id, options) {
    const entry = (await this.readSnapshot(id));
    if (!entry) fail(`Graph projection snapshot is missing: ${id}`, "GRAPH_PROJECTION_SNAPSHOT_MISSING");
    return queryTemporalProvenanceGraph(entry.document, options);
  }

  async queryPrepared(request) {
    const scope = createTemporalVerificationScope();
    try {
      const prepared = verifyPreparedTraversalRequest(request, { storage: this.storage });
      const entry = (await this.readSnapshot(prepared.graphSnapshotId));
      if (!entry) fail(`Graph projection snapshot is missing: ${prepared.graphSnapshotId}`, "GRAPH_PROJECTION_SNAPSHOT_MISSING");
      const graph = ownWorldSnapshotForTemporalScope(scope, { temporalProvenanceGraph: entry.document }).temporalProvenanceGraph;
      const result = queryTemporalProvenanceGraph(graph, traversalOptionsFromQuery(prepared.traversalQuery,
        familyFormatForOriginal("head-agent-core-prepared-traversal", prepared, this.storage)));
      verifyPreparedTraversalRequest(prepared, { graph, result, storage: this.storage });
      return buildPreparedTraversalVerification(prepared, "local-snapshot-reference");
    } finally { scope.close(); }
  }
}

export class InMemoryGraphProjectionAdapter {
  constructor({ adapterKind = "in-memory" } = {}) {
    this.adapterVersion = GRAPH_PROJECTION_ADAPTER_VERSION;
    this.adapterKind = adapterKind;
    this.pointer = null;
    this.snapshots = new Map();
  }

  describe() {
    return {
      ...descriptor(this.adapterKind, { remote: false, durable: false }),
      preparedTraversalProtocolVersion: PREPARED_TRAVERSAL_VERSION,
      preparedTraversalMode: "memory-snapshot-reference",
    };
  }

  readPointer() {
    return this.pointer ? { location: "memory://graph-projection/current", document: clone(this.pointer) } : null;
  }

  readSnapshot(id) {
    graphSnapshotId(id);
    const document = this.snapshots.get(id);
    return document ? { location: `memory://graph-projection/snapshots/${id}`, document: clone(document) } : null;
  }

  writeSnapshot(id, document) {
    graphSnapshotId(id);
    const created = !this.snapshots.has(id);
    if (created) this.snapshots.set(id, clone(document));
    return { location: `memory://graph-projection/snapshots/${id}`, created, document: clone(this.snapshots.get(id)) };
  }

  writePointer(document) {
    this.pointer = clone(document);
    return { location: "memory://graph-projection/current", document: clone(document) };
  }

  listSnapshotIds() {
    return [...this.snapshots.keys()].sort();
  }

  async query(id, options) {
    const entry = (await this.readSnapshot(id));
    if (!entry) fail(`Graph projection snapshot is missing: ${id}`, "GRAPH_PROJECTION_SNAPSHOT_MISSING");
    return queryTemporalProvenanceGraph(entry.document, options);
  }

  async queryPrepared(request) {
    const prepared = verifyPreparedTraversalRequest(request);
    const entry = (await this.readSnapshot(prepared.graphSnapshotId));
    if (!entry) fail(`Graph projection snapshot is missing: ${prepared.graphSnapshotId}`, "GRAPH_PROJECTION_SNAPSHOT_MISSING");
    const result = queryTemporalProvenanceGraph(entry.document, traversalOptionsFromQuery(prepared.traversalQuery,
      familyFormatForOriginal("head-agent-core-prepared-traversal", prepared)));
    verifyPreparedTraversalRequest(prepared, { graph: entry.document, result });
    return buildPreparedTraversalVerification(prepared, "memory-snapshot-reference");
  }
}

function activationPayload({ storageSelection, graph, conformanceReport, storage = null }) {
  const selection = verifyStorageSelection(storageSelection, "", storage);
  if (selection.mode !== "graphdb") fail("GraphDB activation requires a GraphDB storage selection.", "ARCADEDB_SELECTION_REQUIRED");
  verifyTemporalProvenanceGraph(graph);
  if (!conformanceReport || !/^graph-projection-conformance-[a-f0-9]{24}$/.test(conformanceReport.conformanceReportId || "")
    || !/^[a-f0-9]{64}$/.test(conformanceReport.conformanceReportHash || "")
    || conformanceReport.graphSnapshotId !== graph.graphSnapshotId
    || conformanceReport.graphSnapshotHash !== graph.graphSnapshotHash
    || conformanceReport.semanticIdentity !== "adapter-neutral") {
    fail("GraphDB activation requires a current adapter-neutral conformance report.", "INVALID_ARCADEDB_ACTIVATION_CONFORMANCE");
  }
  if (storage != null && (!familyFormatForOriginal("head-agent-core-onboarding-storage", selection, storage)
    || !familyFormatForOriginal("head-agent-core-temporal-provenance", graph, storage)
    || !familyFormatForOriginal("head-agent-core-graph-projection-conformance", conformanceReport, storage))) {
    fail("GraphDB activation owner family is incoherent.", "INVALID_ARCADEDB_ACTIVATION_CONFORMANCE");
  }
  return {
    schemaVersion: 1,
    kind: "ArcadeDbGraphProjectionActivation",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-arcadedb-graph-projection"), version: ARCADEDB_GRAPH_PROJECTION_VERSION },
    projectId: selection.projectId,
    storageSelectionId: selection.storageSelectionId,
    storageSelectionHash: selection.storageSelectionHash,
    graphSnapshotId: graph.graphSnapshotId,
    graphSnapshotHash: graph.graphSnapshotHash,
    conformanceReportId: conformanceReport.conformanceReportId,
    conformanceReportHash: conformanceReport.conformanceReportHash,
    adapterKind: "arcadedb-http",
    authority: "derived-evidence-only",
    rebuildable: true,
    uniqueAuthority: false,
    instructionAuthority: false,
    promotionAuthority: false,
    credentialValuesPersisted: false,
    serverRecordIdentitySemantic: false,
    activationStatus: "verified-active",
  };
}

export function buildArcadeDbGraphProjectionActivation({ storageSelection, graph, conformanceReport, storage = null } = {}) {
  const payload = activationPayload({ storageSelection, graph, conformanceReport, storage });
  const activationHash = digest(graphProjectionCanonicalJson(payload));
  return { ...payload, activationId: `arcadedb-graph-activation-${activationHash.slice(0, 24)}`, activationHash };
}

export function verifyArcadeDbGraphProjectionActivation(document, storage = null) {
  assertFields(document, [
    "schemaVersion", "kind", "protocol", "projectId", "storageSelectionId", "storageSelectionHash", "graphSnapshotId", "graphSnapshotHash",
    "conformanceReportId", "conformanceReportHash", "adapterKind", "authority", "rebuildable", "uniqueAuthority", "instructionAuthority",
    "promotionAuthority", "credentialValuesPersisted", "serverRecordIdentitySemantic", "activationStatus", "activationId", "activationHash",
  ], "ArcadeDB graph projection activation", "INVALID_ARCADEDB_ACTIVATION");
  if (!document || !/^arcadedb-graph-activation-[a-f0-9]{24}$/.test(document.activationId || "")
    || !/^[a-f0-9]{64}$/.test(document.activationHash || "")) {
    fail("ArcadeDB graph projection activation is invalid.", "INVALID_ARCADEDB_ACTIVATION");
  }
  const payload = { ...document };
  delete payload.activationId;
  delete payload.activationHash;
  const hash = digest(graphProjectionCanonicalJson(payload));
  if (document.activationHash !== hash || document.activationId !== `arcadedb-graph-activation-${hash.slice(0, 24)}`
    || document.kind !== "ArcadeDbGraphProjectionActivation" || document.schemaVersion !== 1
    || !familyFormatForOriginal("head-agent-core-arcadedb-graph-projection", document, storage)
    || document.protocol?.version !== ARCADEDB_GRAPH_PROJECTION_VERSION
    || typeof document.projectId !== "string" || !document.projectId
    || !/^onboarding-storage-[a-f0-9]{24}$/.test(document.storageSelectionId || "")
    || !/^[a-f0-9]{64}$/.test(document.storageSelectionHash || "")
    || !/^graph-snapshot-[a-f0-9]{24}$/.test(document.graphSnapshotId || "")
    || !/^[a-f0-9]{64}$/.test(document.graphSnapshotHash || "")
    || !/^graph-projection-conformance-[a-f0-9]{24}$/.test(document.conformanceReportId || "")
    || !/^[a-f0-9]{64}$/.test(document.conformanceReportHash || "")
    || document.adapterKind !== "arcadedb-http"
    || document.authority !== "derived-evidence-only" || document.rebuildable !== true || document.uniqueAuthority !== false
    || document.instructionAuthority !== false || document.promotionAuthority !== false
    || document.credentialValuesPersisted !== false || document.serverRecordIdentitySemantic !== false
    || document.activationStatus !== "verified-active") {
    fail("ArcadeDB graph projection activation digest verification failed.", "ARCADEDB_ACTIVATION_DIGEST_MISMATCH");
  }
  return document;
}

function activationPointerFor(activation) {
  const payload = {
    schemaVersion: 1,
    kind: "ArcadeDbGraphProjectionActivationPointer",
    protocol: activation.protocol,
    projectId: activation.projectId,
    storageSelectionId: activation.storageSelectionId,
    activationId: activation.activationId,
    activationHash: activation.activationHash,
    credentialValuesPersisted: false,
  };
  const pointerHash = digest(graphProjectionCanonicalJson(payload));
  return { ...payload, pointerId: `arcadedb-graph-activation-pointer-${pointerHash.slice(0, 24)}`, pointerHash };
}

function verifyActivationPointer(document, storage = null) {
  assertFields(document, [
    "schemaVersion", "kind", "protocol", "projectId", "storageSelectionId", "activationId", "activationHash",
    "credentialValuesPersisted", "pointerId", "pointerHash",
  ], "ArcadeDB activation pointer", "INVALID_ARCADEDB_ACTIVATION_POINTER");
  if (!document || !/^arcadedb-graph-activation-pointer-[a-f0-9]{24}$/.test(document.pointerId || "")
    || !/^[a-f0-9]{64}$/.test(document.pointerHash || "") || document.credentialValuesPersisted !== false
    || document.kind !== "ArcadeDbGraphProjectionActivationPointer" || document.schemaVersion !== 1
    || !familyFormatForOriginal("head-agent-core-arcadedb-graph-projection", document, storage)
    || document.protocol?.version !== ARCADEDB_GRAPH_PROJECTION_VERSION
    || typeof document.projectId !== "string" || !document.projectId
    || !/^onboarding-storage-[a-f0-9]{24}$/.test(document.storageSelectionId || "")
    || !/^arcadedb-graph-activation-[a-f0-9]{24}$/.test(document.activationId || "")
    || !/^[a-f0-9]{64}$/.test(document.activationHash || "")) {
    fail("ArcadeDB activation pointer is invalid.", "INVALID_ARCADEDB_ACTIVATION_POINTER");
  }
  const payload = { ...document };
  delete payload.pointerId;
  delete payload.pointerHash;
  const hash = digest(graphProjectionCanonicalJson(payload));
  if (document.pointerHash !== hash || document.pointerId !== `arcadedb-graph-activation-pointer-${hash.slice(0, 24)}`) {
    fail("ArcadeDB activation pointer digest verification failed.", "ARCADEDB_ACTIVATION_POINTER_DIGEST_MISMATCH");
  }
  return document;
}

export function persistArcadeDbGraphProjectionActivation({ projectRoot, storage = null, activation, conformanceReport } = {}) {
  const root = path.resolve(projectRoot || ".");
  const verified = verifyArcadeDbGraphProjectionActivation(activation, storage);
  const verifiedConformance = verifyGraphProjectionConformanceReport(conformanceReport, storage);
  if (verifiedConformance.conformanceReportId !== verified.conformanceReportId
    || verifiedConformance.conformanceReportHash !== verified.conformanceReportHash
    || verifiedConformance.graphSnapshotId !== verified.graphSnapshotId
    || verifiedConformance.graphSnapshotHash !== verified.graphSnapshotHash) {
    fail("ArcadeDB activation and conformance report identities differ.", "ARCADEDB_ACTIVATION_CONFORMANCE_MISMATCH");
  }
  const conformanceFile = path.join(root, relativeProjectArtifact(storage, ...ARCADEDB_CONFORMANCE_DIRECTORY.split(path.sep).slice(1)), `${verifiedConformance.conformanceReportId}.json`);
  if (fs.existsSync(conformanceFile)) {
    const existing = parseDocument(conformanceFile, "Graph projection conformance report");
    if (graphProjectionCanonicalJson(existing) !== graphProjectionCanonicalJson(verifiedConformance)) {
      fail("Graph projection conformance identity conflicts with existing content.", "GRAPH_PROJECTION_CONFORMANCE_CONFLICT");
    }
  } else atomicWrite(conformanceFile, json(verifiedConformance));
  const activationFile = path.join(root, relativeProjectArtifact(storage, ...ARCADEDB_ACTIVATION_DIRECTORY.split(path.sep).slice(1)), `${verified.activationId}.json`);
  if (fs.existsSync(activationFile)) {
    const existing = parseDocument(activationFile, "ArcadeDB graph projection activation");
    if (graphProjectionCanonicalJson(existing) !== graphProjectionCanonicalJson(verified)) {
      fail("ArcadeDB activation identity conflicts with existing content.", "ARCADEDB_ACTIVATION_CONFLICT");
    }
  } else atomicWrite(activationFile, json(verified));
  const pointer = activationPointerFor(verified);
  const pointerFile = path.join(root, relativeProjectArtifact(storage, ...ARCADEDB_ACTIVATION_POINTER.split(path.sep).slice(1)));
  atomicWrite(pointerFile, json(pointer));
  return { activation: verified, activationFile, conformanceReport: verifiedConformance, conformanceFile, pointer, pointerFile };
}

function currentStorageSelection(projectRoot, storage = null) {
  const stateFile = path.join(projectRoot, formatForVerifiedOwner(storage).directory, "onboarding", "current.json");
  if (!fs.existsSync(stateFile)) return null;
  const state = verifyOnboardingState(parseDocument(stateFile, "Onboarding state"), { storage });
  const selectionFile = path.join(projectRoot, relativeProjectArtifact(storage, ...ONBOARDING_STORAGE_DIRECTORY.split("/").slice(1)), `${state.storageSelectionId}.json`);
  if (!fs.existsSync(selectionFile)) fail("Onboarding storage selection is missing.", "ONBOARDING_STORAGE_SELECTION_MISSING");
  return verifyStorageSelection(parseDocument(selectionFile, "Onboarding storage selection"), state.projectId, storage);
}

export function inspectArcadeDbGraphProjectionActivation({ projectRoot, storage = null } = {}) {
  const root = path.resolve(projectRoot || ".");
  const storageSelection = currentStorageSelection(root, storage);
  if (!storageSelection || storageSelection.mode !== "graphdb") return {
    status: "not-configured",
    storageSelection, storage,
    activation: null,
    credentialValuesPersisted: false,
  };
  const pointerFile = path.join(root, relativeProjectArtifact(storage, ...ARCADEDB_ACTIVATION_POINTER.split(path.sep).slice(1)));
  if (!fs.existsSync(pointerFile)) return {
    status: "pending-activation",
    storageSelection, storage,
    activation: null,
    credentialValuesPersisted: false,
  };
  const pointer = verifyActivationPointer(parseDocument(pointerFile, "ArcadeDB activation pointer"), storage);
  if (pointer.projectId !== storageSelection.projectId || pointer.storageSelectionId !== storageSelection.storageSelectionId) return {
    status: "pending-activation",
    storageSelection, storage,
    activation: null,
    previousActivationId: pointer.activationId,
    credentialValuesPersisted: false,
  };
  const activationFile = path.join(root, relativeProjectArtifact(storage, ...ARCADEDB_ACTIVATION_DIRECTORY.split(path.sep).slice(1)), `${pointer.activationId}.json`);
  if (!fs.existsSync(activationFile)) fail("ArcadeDB activation pointer references a missing receipt.", "ARCADEDB_ACTIVATION_MISSING");
  const activation = verifyArcadeDbGraphProjectionActivation(parseDocument(activationFile, "ArcadeDB graph projection activation"), storage);
  if (activation.activationHash !== pointer.activationHash || activation.projectId !== storageSelection.projectId
    || activation.storageSelectionId !== storageSelection.storageSelectionId
    || activation.storageSelectionHash !== storageSelection.storageSelectionHash) {
    fail("ArcadeDB activation does not match the current storage selection.", "ARCADEDB_ACTIVATION_STALE");
  }
  const conformanceFile = path.join(root, relativeProjectArtifact(storage, ...ARCADEDB_CONFORMANCE_DIRECTORY.split(path.sep).slice(1)), `${activation.conformanceReportId}.json`);
  if (!fs.existsSync(conformanceFile)) fail("ArcadeDB activation references a missing conformance report.", "ARCADEDB_CONFORMANCE_MISSING");
  const conformanceReport = verifyGraphProjectionConformanceReport(parseDocument(conformanceFile, "Graph projection conformance report"), storage);
  if (conformanceReport.conformanceReportHash !== activation.conformanceReportHash
    || conformanceReport.graphSnapshotId !== activation.graphSnapshotId
    || conformanceReport.graphSnapshotHash !== activation.graphSnapshotHash) {
    fail("ArcadeDB activation conformance report is stale or conflicting.", "ARCADEDB_ACTIVATION_CONFORMANCE_MISMATCH");
  }
  return {
    status: "verified-active",
    storageSelection, storage,
    activation,
    pointer,
    activationFile,
    conformanceReport,
    conformanceFile,
    pointerFile,
    credentialValuesPersisted: false,
  };
}

function topologyActivationPayload({ storageSelection, graph, topology, storage = null }) {
  const selection = verifyStorageSelection(storageSelection, "", storage);
  if (selection.mode !== "graphdb") fail("Graph topology activation requires a GraphDB storage selection.", "ARCADEDB_SELECTION_REQUIRED");
  verifyTemporalProvenanceGraph(graph);
  verifyArcadeDbGraphTopology(topology, graph, storage);
  return {
    schemaVersion: 1,
    kind: "ArcadeDbGraphTopologyActivation",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-arcadedb-graph-topology"), version: ARCADEDB_GRAPH_TOPOLOGY_VERSION },
    projectId: selection.projectId,
    storageSelectionId: selection.storageSelectionId,
    storageSelectionHash: selection.storageSelectionHash,
    graphSnapshotId: graph.graphSnapshotId,
    graphSnapshotHash: graph.graphSnapshotHash,
    sourceSnapshotId: graph.sourceSnapshotId,
    topologyId: topology.topologyId,
    topologyHash: topology.topologyHash,
    nodeCount: topology.nodeCount,
    edgeCount: topology.edgeCount,
    adapterKind: "arcadedb-http",
    authority: "derived-verification-evidence-only",
    rebuildable: true,
    uniqueAuthority: false,
    instructionAuthority: false,
    promotionAuthority: false,
    credentialValuesPersisted: false,
    serverRecordIdentitySemantic: false,
    traversalMode: "verified-topology-client-reference",
    activationStatus: "verified-active",
  };
}

export function buildArcadeDbGraphTopologyActivation({ storageSelection, graph, topology, storage = null } = {}) {
  const payload = topologyActivationPayload({ storageSelection, graph, topology, storage });
  const activationHash = digest(graphProjectionCanonicalJson(payload));
  return { ...payload, activationId: `arcadedb-topology-activation-${activationHash.slice(0, 24)}`, activationHash };
}

export function verifyArcadeDbGraphTopologyActivation(document, storage = null) {
  assertFields(document, [
    "schemaVersion", "kind", "protocol", "projectId", "storageSelectionId", "storageSelectionHash", "graphSnapshotId",
    "graphSnapshotHash", "sourceSnapshotId", "topologyId", "topologyHash", "nodeCount", "edgeCount", "adapterKind", "authority",
    "rebuildable", "uniqueAuthority", "instructionAuthority", "promotionAuthority", "credentialValuesPersisted",
    "serverRecordIdentitySemantic", "traversalMode", "activationStatus", "activationId", "activationHash",
  ], "ArcadeDB graph topology activation", "INVALID_ARCADEDB_TOPOLOGY_ACTIVATION");
  if (!document || document.kind !== "ArcadeDbGraphTopologyActivation" || document.schemaVersion !== 1
    || !familyFormatForOriginal("head-agent-core-arcadedb-graph-topology", document, storage)
    || document.protocol?.version !== ARCADEDB_GRAPH_TOPOLOGY_VERSION
    || typeof document.projectId !== "string" || !document.projectId
    || !/^onboarding-storage-[a-f0-9]{24}$/.test(document.storageSelectionId || "")
    || !/^[a-f0-9]{64}$/.test(document.storageSelectionHash || "")
    || !/^graph-snapshot-[a-f0-9]{24}$/.test(document.graphSnapshotId || "")
    || !/^[a-f0-9]{64}$/.test(document.graphSnapshotHash || "")
    || !/^source-snapshot-[a-f0-9]{24}$/.test(document.sourceSnapshotId || "")
    || !/^arcadedb-graph-topology-[a-f0-9]{24}$/.test(document.topologyId || "")
    || !/^[a-f0-9]{64}$/.test(document.topologyHash || "")
    || !Number.isInteger(document.nodeCount) || document.nodeCount < 0
    || !Number.isInteger(document.edgeCount) || document.edgeCount < 0
    || document.adapterKind !== "arcadedb-http" || document.authority !== "derived-verification-evidence-only"
    || document.rebuildable !== true || document.uniqueAuthority !== false || document.instructionAuthority !== false
    || document.promotionAuthority !== false || document.credentialValuesPersisted !== false
    || document.serverRecordIdentitySemantic !== false || document.traversalMode !== "verified-topology-client-reference"
    || document.activationStatus !== "verified-active"
    || !/^arcadedb-topology-activation-[a-f0-9]{24}$/.test(document.activationId || "")
    || !/^[a-f0-9]{64}$/.test(document.activationHash || "")) {
    fail("ArcadeDB graph topology activation is invalid.", "INVALID_ARCADEDB_TOPOLOGY_ACTIVATION");
  }
  const payload = { ...document };
  delete payload.activationId;
  delete payload.activationHash;
  const hash = digest(graphProjectionCanonicalJson(payload));
  if (document.activationHash !== hash || document.activationId !== `arcadedb-topology-activation-${hash.slice(0, 24)}`) {
    fail("ArcadeDB graph topology activation digest verification failed.", "ARCADEDB_TOPOLOGY_ACTIVATION_DIGEST_MISMATCH");
  }
  return document;
}

function topologyActivationPointerFor(activation) {
  const payload = {
    schemaVersion: 1,
    kind: "ArcadeDbGraphTopologyActivationPointer",
    protocol: activation.protocol,
    projectId: activation.projectId,
    storageSelectionId: activation.storageSelectionId,
    activationId: activation.activationId,
    activationHash: activation.activationHash,
    credentialValuesPersisted: false,
  };
  const pointerHash = digest(graphProjectionCanonicalJson(payload));
  return { ...payload, pointerId: `arcadedb-topology-pointer-${pointerHash.slice(0, 24)}`, pointerHash };
}

function verifyTopologyActivationPointer(document, storage = null) {
  assertFields(document, [
    "schemaVersion", "kind", "protocol", "projectId", "storageSelectionId", "activationId", "activationHash",
    "credentialValuesPersisted", "pointerId", "pointerHash",
  ], "ArcadeDB graph topology activation pointer", "INVALID_ARCADEDB_TOPOLOGY_POINTER");
  if (!document || document.kind !== "ArcadeDbGraphTopologyActivationPointer" || document.schemaVersion !== 1
    || !familyFormatForOriginal("head-agent-core-arcadedb-graph-topology", document, storage)
    || document.protocol?.version !== ARCADEDB_GRAPH_TOPOLOGY_VERSION
    || typeof document.projectId !== "string" || !document.projectId
    || !/^onboarding-storage-[a-f0-9]{24}$/.test(document.storageSelectionId || "")
    || !/^arcadedb-topology-activation-[a-f0-9]{24}$/.test(document.activationId || "")
    || !/^[a-f0-9]{64}$/.test(document.activationHash || "") || document.credentialValuesPersisted !== false
    || !/^arcadedb-topology-pointer-[a-f0-9]{24}$/.test(document.pointerId || "")
    || !/^[a-f0-9]{64}$/.test(document.pointerHash || "")) {
    fail("ArcadeDB graph topology activation pointer is invalid.", "INVALID_ARCADEDB_TOPOLOGY_POINTER");
  }
  const payload = { ...document };
  delete payload.pointerId;
  delete payload.pointerHash;
  const hash = digest(graphProjectionCanonicalJson(payload));
  if (document.pointerHash !== hash || document.pointerId !== `arcadedb-topology-pointer-${hash.slice(0, 24)}`) {
    fail("ArcadeDB graph topology activation pointer digest verification failed.", "ARCADEDB_TOPOLOGY_POINTER_DIGEST_MISMATCH");
  }
  return document;
}

export function persistArcadeDbGraphTopologyActivation({ projectRoot, storage = null, activation } = {}) {
  const root = path.resolve(projectRoot || ".");
  const verified = verifyArcadeDbGraphTopologyActivation(activation, storage);
  const activationFile = path.join(root, relativeProjectArtifact(storage, ...ARCADEDB_TOPOLOGY_ACTIVATION_DIRECTORY.split(path.sep).slice(1)), `${verified.activationId}.json`);
  if (fs.existsSync(activationFile)) {
    const existing = verifyArcadeDbGraphTopologyActivation(parseDocument(activationFile, "ArcadeDB graph topology activation"), storage);
    if (graphProjectionCanonicalJson(existing) !== graphProjectionCanonicalJson(verified)) {
      fail("ArcadeDB graph topology activation identity conflicts with existing content.", "ARCADEDB_TOPOLOGY_ACTIVATION_CONFLICT");
    }
  } else atomicWrite(activationFile, json(verified));
  const pointer = topologyActivationPointerFor(verified);
  const pointerFile = path.join(root, relativeProjectArtifact(storage, ...ARCADEDB_TOPOLOGY_ACTIVATION_POINTER.split(path.sep).slice(1)));
  atomicWrite(pointerFile, json(pointer));
  return { activation: verified, activationFile, pointer, pointerFile };
}

export function inspectArcadeDbGraphTopologyActivation({ projectRoot, storage = null, graph = null } = {}) {
  const root = path.resolve(projectRoot || ".");
  const storageSelection = currentStorageSelection(root, storage);
  if (!storageSelection || storageSelection.mode !== "graphdb") return { status: "not-configured", storageSelection, activation: null };
  const pointerFile = path.join(root, relativeProjectArtifact(storage, ...ARCADEDB_TOPOLOGY_ACTIVATION_POINTER.split(path.sep).slice(1)));
  if (!fs.existsSync(pointerFile)) return { status: "pending-topology-activation", storageSelection, activation: null };
  const pointer = verifyTopologyActivationPointer(parseDocument(pointerFile, "ArcadeDB graph topology activation pointer"), storage);
  if (pointer.projectId !== storageSelection.projectId || pointer.storageSelectionId !== storageSelection.storageSelectionId) {
    return { status: "pending-topology-activation", storageSelection, activation: null, previousActivationId: pointer.activationId };
  }
  const activationFile = path.join(root, relativeProjectArtifact(storage, ...ARCADEDB_TOPOLOGY_ACTIVATION_DIRECTORY.split(path.sep).slice(1)), `${pointer.activationId}.json`);
  if (!fs.existsSync(activationFile)) fail("ArcadeDB graph topology pointer references a missing activation.", "ARCADEDB_TOPOLOGY_ACTIVATION_MISSING");
  const activation = verifyArcadeDbGraphTopologyActivation(parseDocument(activationFile, "ArcadeDB graph topology activation"), storage);
  if (activation.activationHash !== pointer.activationHash || activation.projectId !== storageSelection.projectId
    || activation.storageSelectionId !== storageSelection.storageSelectionId
    || activation.storageSelectionHash !== storageSelection.storageSelectionHash) {
    fail("ArcadeDB graph topology activation does not match the current storage selection.", "ARCADEDB_TOPOLOGY_ACTIVATION_STALE");
  }
  if (graph && (activation.graphSnapshotId !== graph.graphSnapshotId || activation.graphSnapshotHash !== graph.graphSnapshotHash
    || activation.sourceSnapshotId !== graph.sourceSnapshotId)) {
    return { status: "stale", storageSelection, activation, pointer, activationFile, pointerFile };
  }
  return { status: "verified-active", storageSelection, activation, pointer, activationFile, pointerFile };
}

function incrementalSyncReceiptPointerFor(receipt) {
  const verified = verifyArcadeDbIncrementalSyncReceipt(receipt);
  const payload = {
    schemaVersion: 1,
    kind: "ArcadeDbIncrementalSyncReceiptPointer",
    protocol: verified.protocol,
    projectId: verified.projectId,
    syncId: verified.syncId,
    receiptId: verified.receiptId,
    receiptHash: verified.receiptHash,
    targetGraphSnapshotId: verified.targetGraphSnapshotId,
    targetGraphSnapshotHash: verified.targetGraphSnapshotHash,
    credentialValuesPersisted: false,
  };
  const pointerHash = digest(graphProjectionCanonicalJson(payload));
  return { ...payload, pointerId: `arcadedb-sync-receipt-pointer-${pointerHash.slice(0, 24)}`, pointerHash };
}

function verifyIncrementalSyncReceiptPointer(document, storage = null) {
  assertFields(document, [
    "schemaVersion", "kind", "protocol", "projectId", "syncId", "receiptId", "receiptHash",
    "targetGraphSnapshotId", "targetGraphSnapshotHash", "credentialValuesPersisted", "pointerId", "pointerHash",
  ], "ArcadeDB incremental sync receipt pointer", "INVALID_ARCADEDB_INCREMENTAL_SYNC_RECEIPT_POINTER");
  if (document.kind !== "ArcadeDbIncrementalSyncReceiptPointer" || document.schemaVersion !== 1
    || !familyFormatForOriginal("head-agent-core-arcadedb-incremental-sync", document, storage)
    || document.protocol?.version !== ARCADEDB_INCREMENTAL_SYNC_VERSION
    || typeof document.projectId !== "string" || !document.projectId
    || !/^arcadedb-sync-[a-f0-9]{24}$/.test(document.syncId || "")
    || !/^arcadedb-sync-receipt-[a-f0-9]{24}$/.test(document.receiptId || "")
    || !/^[a-f0-9]{64}$/.test(document.receiptHash || "")
    || !/^graph-snapshot-[a-f0-9]{24}$/.test(document.targetGraphSnapshotId || "")
    || !/^[a-f0-9]{64}$/.test(document.targetGraphSnapshotHash || "")
    || document.credentialValuesPersisted !== false
    || !/^arcadedb-sync-receipt-pointer-[a-f0-9]{24}$/.test(document.pointerId || "")
    || !/^[a-f0-9]{64}$/.test(document.pointerHash || "")) {
    fail("ArcadeDB incremental sync receipt pointer is invalid.", "INVALID_ARCADEDB_INCREMENTAL_SYNC_RECEIPT_POINTER");
  }
  const payload = { ...document };
  delete payload.pointerId;
  delete payload.pointerHash;
  const pointerHash = digest(graphProjectionCanonicalJson(payload));
  if (document.pointerHash !== pointerHash || document.pointerId !== `arcadedb-sync-receipt-pointer-${pointerHash.slice(0, 24)}`) {
    fail("ArcadeDB incremental sync receipt pointer digest verification failed.", "ARCADEDB_INCREMENTAL_SYNC_RECEIPT_POINTER_DIGEST_MISMATCH");
  }
  return document;
}

export function persistArcadeDbIncrementalSyncReceipt({ projectRoot, storage = null, receipt } = {}) {
  const root = path.resolve(projectRoot || ".");
  const verified = verifyArcadeDbIncrementalSyncReceipt(receipt);
  if (storage != null && !familyFormatForOriginal("head-agent-core-arcadedb-incremental-sync", verified, storage)) fail("Incremental sync receipt owner family is incoherent.", "INVALID_ARCADEDB_INCREMENTAL_SYNC_RECEIPT");
  const receiptFile = path.join(root, relativeProjectArtifact(storage, ...ARCADEDB_INCREMENTAL_SYNC_RECEIPT_DIRECTORY.split(path.sep).slice(1)), `${verified.receiptId}.json`);
  if (fs.existsSync(receiptFile)) {
    const existing = verifyArcadeDbIncrementalSyncReceipt(parseDocument(receiptFile, "ArcadeDB incremental sync receipt"));
    if (graphProjectionCanonicalJson(existing) !== graphProjectionCanonicalJson(verified)) {
      fail("ArcadeDB incremental sync receipt identity conflicts with existing content.", "ARCADEDB_INCREMENTAL_SYNC_RECEIPT_CONFLICT");
    }
  } else atomicWrite(receiptFile, json(verified));
  const pointer = incrementalSyncReceiptPointerFor(verified);
  const pointerFile = path.join(root, relativeProjectArtifact(storage, ...ARCADEDB_INCREMENTAL_SYNC_RECEIPT_POINTER.split(path.sep).slice(1)));
  atomicWrite(pointerFile, json(pointer));
  return { receipt: verified, receiptFile, pointer, pointerFile };
}

export function inspectArcadeDbIncrementalSyncReceipt({ projectRoot, storage = null, graph = null } = {}) {
  const root = path.resolve(projectRoot || ".");
  const pointerFile = path.join(root, relativeProjectArtifact(storage, ...ARCADEDB_INCREMENTAL_SYNC_RECEIPT_POINTER.split(path.sep).slice(1)));
  if (!fs.existsSync(pointerFile)) return { status: "not-synchronized", receipt: null };
  const pointer = verifyIncrementalSyncReceiptPointer(parseDocument(pointerFile, "ArcadeDB incremental sync receipt pointer"), storage);
  const receiptFile = path.join(root, relativeProjectArtifact(storage, ...ARCADEDB_INCREMENTAL_SYNC_RECEIPT_DIRECTORY.split(path.sep).slice(1)), `${pointer.receiptId}.json`);
  if (!fs.existsSync(receiptFile)) fail("ArcadeDB incremental sync receipt pointer references missing content.", "ARCADEDB_INCREMENTAL_SYNC_RECEIPT_MISSING");
  const receipt = verifyArcadeDbIncrementalSyncReceipt(parseDocument(receiptFile, "ArcadeDB incremental sync receipt"));
  if (storage != null && !familyFormatForOriginal("head-agent-core-arcadedb-incremental-sync", receipt, storage)) fail("Incremental sync receipt owner family is incoherent.", "INVALID_ARCADEDB_INCREMENTAL_SYNC_RECEIPT");
  if (receipt.projectId !== pointer.projectId || receipt.syncId !== pointer.syncId
    || receipt.receiptHash !== pointer.receiptHash || receipt.targetGraphSnapshotId !== pointer.targetGraphSnapshotId
    || receipt.targetGraphSnapshotHash !== pointer.targetGraphSnapshotHash) {
    fail("ArcadeDB incremental sync receipt pointer is stale or divergent.", "ARCADEDB_INCREMENTAL_SYNC_RECEIPT_POINTER_MISMATCH");
  }
  if (graph && (receipt.projectId !== graph.projectId || receipt.targetGraphSnapshotId !== graph.graphSnapshotId
    || receipt.targetGraphSnapshotHash !== graph.graphSnapshotHash)) {
    return { status: "stale", receipt, pointer, receiptFile, pointerFile };
  }
  return { status: "verified-current", receipt, pointer, receiptFile, pointerFile };
}

export function createActivatedArcadeDbGraphProjectionAdapter({ projectRoot, storage = null, transport = null } = {}) {
  const inspected = inspectArcadeDbGraphProjectionActivation({ projectRoot, storage });
  if (inspected.status !== "verified-active") return null;
  const topology = inspectArcadeDbGraphTopologyActivation({ projectRoot, storage });
  const serverTraversalRequired = inspected.conformanceReport?.candidateAdapter?.traversalMode === ARCADEDB_SERVER_TRAVERSAL_MODE;
  const preparedTraversalRequired = inspected.conformanceReport?.candidateAdapter?.preparedTraversalProtocolVersion
    === PREPARED_TRAVERSAL_VERSION;
  return new ActivatedArcadeDbGraphProjectionAdapter({
    projectRoot, storage,
    storageSelection: inspected.storageSelection,
    remoteAdapter: new ArcadeDbGraphProjectionAdapter({
      storage, storageSelection: inspected.storageSelection,
      transport,
      topologyRequired: serverTraversalRequired || topology.status === "verified-active" || topology.status === "stale",
      serverTraversalRequired,
      preparedTraversalRequired,
      incrementalSyncRequired: true,
    }),
  });
}

export function createGraphProjectionAdapter({ projectRoot, storage = null, adapter = null } = {}) {
  return assertGraphProjectionAdapter(adapter
    || createActivatedArcadeDbGraphProjectionAdapter({ projectRoot, storage })
    || new LocalJsonGraphProjectionAdapter({ projectRoot, storage }));
}

function adapterReport(adapter) {
  return { ...adapter.describe(), ...(typeof adapter.diagnostics === "function" ? adapter.diagnostics() : {}) };
}

export async function prepareGraphProjection({ projectRoot, storage = null, graph, adapter = null } = {}) {
  verifyTemporalProvenanceGraph(graph);
  const selected = createGraphProjectionAdapter({ projectRoot, adapter, storage });
  const existing = (await selected.readSnapshot(graph.graphSnapshotId));
  let snapshotEntry;
  if (existing) {
    verifyTemporalProvenanceGraph(existing.document);
    if (graphProjectionCanonicalJson(existing.document) !== graphProjectionCanonicalJson(graph)) {
      fail("Graph projection adapter returned conflicting content for the same GraphSnapshot id.", "GRAPH_PROJECTION_SNAPSHOT_CONFLICT");
    }
    snapshotEntry = existing;
  } else {
    snapshotEntry = (await selected.writeSnapshot(graph.graphSnapshotId, clone(graph)));
    verifyTemporalProvenanceGraph(snapshotEntry.document);
    if (graphProjectionCanonicalJson(snapshotEntry.document) !== graphProjectionCanonicalJson(graph)) {
      fail("Graph projection adapter changed the GraphSnapshot during materialization.", "GRAPH_PROJECTION_WRITE_MISMATCH");
    }
  }
  // Built-in remote transports and their child/network work never run in the
  // World Canon commit scope. Prepare the real local mirror here instead.
  let publicationAdapter = selected;
  let remotePublication = null;
  if (selected instanceof ActivatedArcadeDbGraphProjectionAdapter) {
    publicationAdapter = selected.local;
    remotePublication = pointer => selected.publishRemotePointer(pointer);
  } else if (selected.describe().remote === true) {
    publicationAdapter = new LocalJsonGraphProjectionAdapter({ projectRoot, storage });
    remotePublication = pointer => selected.writePointer(pointer);
  }
  let localSnapshotEntry = snapshotEntry;
  if (publicationAdapter !== selected) {
    localSnapshotEntry = await publicationAdapter.readSnapshot(graph.graphSnapshotId) || await publicationAdapter.writeSnapshot(graph.graphSnapshotId, clone(graph));
    verifyTemporalProvenanceGraph(localSnapshotEntry.document);
    if (graphProjectionCanonicalJson(localSnapshotEntry.document) !== graphProjectionCanonicalJson(graph)) fail("Local publication mirror differs from prepared graph.", "GRAPH_PROJECTION_SNAPSHOT_CONFLICT");
  }
  return { selected, publicationAdapter, remotePublication, graph, storage, snapshotEntry, localSnapshotEntry, existing: Boolean(existing), pointer: pointerFor(graph, storage) };
}

export function publishPreparedGraphProjection(prepared) {
  const { selected, publicationAdapter, graph, storage, snapshotEntry, localSnapshotEntry, existing, pointer } = prepared;
  verifyTemporalProvenanceGraph(graph);
  verifyGraphProjectionPointer(pointer, graph, storage);
  const pointerEntry = publicationAdapter.writePointer(clone(pointer));
  if (pointerEntry && typeof pointerEntry.then === "function") fail("Local graph pointer publication returned an asynchronous result.", "GRAPH_PROJECTION_WRITE_MISMATCH");
  verifyGraphProjectionPointer(pointerEntry.document, graph, storage);
  if (graphProjectionCanonicalJson(pointerEntry.document) !== graphProjectionCanonicalJson(pointer)) {
    fail("Graph projection adapter changed the pointer during materialization.", "GRAPH_PROJECTION_WRITE_MISMATCH");
  }
  return {
    status: existing ? "unchanged" : "projected",
    pointer,
    pointerLocation: pointerEntry.location,
    snapshotLocation: localSnapshotEntry.location,
    ...(localSnapshotEntry.snapshotStorage ? { snapshotStorage: localSnapshotEntry.snapshotStorage } : {}),
    remotePublication: prepared.remotePublication ? "pending" : "not-required",
    adapter: adapterReport(selected),
  };
}

export async function completePreparedGraphProjection(prepared, localResult) {
  if (!prepared.remotePublication) return localResult;
  try {
    const remote = await prepared.remotePublication(clone(prepared.pointer));
    verifyGraphProjectionPointer(remote.document, prepared.graph, prepared.storage);
    if (graphProjectionCanonicalJson(remote.document) !== graphProjectionCanonicalJson(prepared.pointer)) fail("Remote graph pointer differs from prepared pointer.", "GRAPH_PROJECTION_WRITE_MISMATCH");
    const currentLocal = await prepared.publicationAdapter.readPointer();
    if (!currentLocal || graphProjectionCanonicalJson(currentLocal.document) !== graphProjectionCanonicalJson(prepared.pointer)) {
      const error = Object.assign(new Error("Local Graph current changed during external publication; preserve the newer pointer."), { code: "GRAPH_PROJECTION_PUBLICATION_CONFLICT" });
      error.graphPublication = { local: "superseded", remote: "published-at-prior-basis", graphSnapshotId: prepared.graph.graphSnapshotId };
      throw error;
    }
    return { ...localResult, remotePublication: prepared.selected.fallbackUsed ? "unavailable-local-fallback" : "published", remotePointerLocation: remote.location };
  } catch (error) {
    error.graphPublication ??= { local: "published", remote: "failed-or-uncertain", graphSnapshotId: prepared.graph.graphSnapshotId };
    throw error;
  }
}

export async function materializeGraphProjection(options = {}) {
  const prepared = await prepareGraphProjection(options);
  return (await completePreparedGraphProjection(prepared, publishPreparedGraphProjection(prepared)));
}

export async function inspectGraphProjection({ projectRoot, storage = null, graph, adapter = null } = {}) {
  verifyTemporalProvenanceGraph(graph);
  const selected = createGraphProjectionAdapter({ projectRoot, adapter, storage });
  const pointerEntry = (await selected.readPointer());
  if (!pointerEntry) return {
    status: "not-materialized",
    graphSnapshotId: graph.graphSnapshotId,
    fallbackAvailable: true,
    adapter: adapterReport(selected),
  };
  const pointer = verifyGraphProjectionPointer(pointerEntry.document, null, storage);
  if (pointer.graphSnapshotId !== graph.graphSnapshotId || pointer.graphSnapshotHash !== graph.graphSnapshotHash
    || pointer.sourceSnapshotId !== graph.sourceSnapshotId || pointer.projectId !== graph.projectId) {
    return {
      status: "stale",
      expectedGraphSnapshotId: graph.graphSnapshotId,
      projectedGraphSnapshotId: pointer.graphSnapshotId,
      fallbackAvailable: false,
      pointer,
      adapter: adapterReport(selected),
    };
  }
  const snapshotEntry = (await selected.readSnapshot(pointer.graphSnapshotId));
  if (!snapshotEntry) fail("Graph projection pointer references a missing snapshot.", "GRAPH_PROJECTION_SNAPSHOT_MISSING");
  verifyTemporalProvenanceGraph(snapshotEntry.document);
  if (graphProjectionCanonicalJson(snapshotEntry.document) !== graphProjectionCanonicalJson(graph)) {
    fail("Graph projection snapshot differs from the embedded recoverable GraphSnapshot.", "GRAPH_PROJECTION_SNAPSHOT_CONFLICT");
  }
  return {
    status: "current",
    graphSnapshotId: graph.graphSnapshotId,
    pointer,
    pointerLocation: pointerEntry.location,
    snapshotLocation: snapshotEntry.location,
    fallbackAvailable: true,
    adapter: adapterReport(selected),
  };
}

async function inspectPreparedGraphProjection({ projectRoot, graph, adapter, storage = null }) {
  verifyTemporalProvenanceGraph(graph);
  const selected = createGraphProjectionAdapter({ projectRoot, adapter, storage });
  const pointerEntry = typeof selected.readPointerForPreparedQuery === "function"
    ? (await selected.readPointerForPreparedQuery())
    : (await selected.readPointer());
  if (!pointerEntry) return {
    status: "not-materialized",
    graphSnapshotId: graph.graphSnapshotId,
    fallbackAvailable: true,
    adapter: adapterReport(selected),
  };
  const pointer = verifyGraphProjectionPointer(pointerEntry.document, null, storage);
  if (pointer.graphSnapshotId !== graph.graphSnapshotId || pointer.graphSnapshotHash !== graph.graphSnapshotHash
    || pointer.sourceSnapshotId !== graph.sourceSnapshotId || pointer.projectId !== graph.projectId) {
    return {
      status: "stale",
      expectedGraphSnapshotId: graph.graphSnapshotId,
      projectedGraphSnapshotId: pointer.graphSnapshotId,
      fallbackAvailable: false,
      pointer,
      adapter: adapterReport(selected),
    };
  }
  return {
    status: "current",
    graphSnapshotId: graph.graphSnapshotId,
    pointer,
    pointerReadToken: pointerEntry[PREPARED_POINTER_READ_TOKEN] || null,
    pointerLocation: pointerEntry.location,
    snapshotVerification: "query-scoped-prepared",
    fallbackAvailable: true,
    adapter: adapterReport(selected),
  };
}

export async function queryGraphProjection({ projectRoot, storage = null, graph, adapter = null, query = {} } = {}) {
  const expected = queryTemporalProvenanceGraph(graph, query);
  // Existing remote/prepared traversal contracts cannot prove a domain mask.
  // Keep the original verified graph/hash and use deterministic local expansion;
  // do not query, materialize or rewrite the remote store to emulate support.
  if (query.eligibility) return { result: expected, diagnostics: {
    executionMode: "embedded-domain-eligibility-fallback", fallbackUsed: true,
    fallbackReasonCode: "GRAPH_PROJECTION_DOMAIN_ELIGIBILITY_UNSUPPORTED",
    originalGraphSnapshotId: graph.graphSnapshotId, originalGraphSnapshotHash: graph.graphSnapshotHash,
    domainEligibilityHash: expected.traversalQuery.domainEligibilityHash,
  } };
  const selected = createGraphProjectionAdapter({ projectRoot, adapter, storage });
  const prepared = supportsPreparedTraversal(selected);
  const inspected = prepared
    ? (await inspectPreparedGraphProjection({ projectRoot, graph, adapter: selected, storage }))
    : (await inspectGraphProjection({ projectRoot, graph, adapter: selected, storage }));
  if (inspected.status === "not-materialized") return {
    result: expected,
    diagnostics: {
      adapter: adapterReport(selected),
      executionMode: "embedded-graph-fallback",
      fallbackUsed: true,
      fallbackReasonCode: "GRAPH_PROJECTION_NOT_MATERIALIZED",
    },
  };
  if (inspected.status === "stale") {
    fail("Graph projection adapter is stale and cannot answer a current query.", "GRAPH_PROJECTION_STALE");
  }
  if (prepared) {
    const request = buildPreparedTraversalRequest({ graph, result: expected, storage });
    const verification = verifyPreparedTraversalVerificationAgainstLocallyBuiltRequest((await selected.queryPrepared(clone(request), {
      pointerReadToken: inspected.pointerReadToken,
    })), request);
    const selectedDiagnostics = typeof selected.diagnostics === "function" ? selected.diagnostics() : {};
    return {
      result: expected,
      diagnostics: {
        adapter: adapterReport(selected),
        executionMode: "prepared-graph-projection-adapter",
        fallbackUsed: selectedDiagnostics.fallbackUsed === true,
        fallbackReasonCode: selectedDiagnostics.fallbackReasonCode || "",
        preparedTraversal: {
          requestId: request.requestId,
          expansionHash: request.expansionHash,
          verificationId: verification.verificationId,
          verificationMode: verification.verificationMode,
          clientReceiptVerification: {
            verificationDocumentDigest: "independently-verified",
            requestBinding: "same-stack-locally-built-request",
            fullRequestReverification: false,
          },
        },
      },
    };
  }
  const candidate = (await selected.query(graph.graphSnapshotId, clone(query)));
  if (graphProjectionCanonicalJson(candidate) !== graphProjectionCanonicalJson(expected)) {
    fail("Graph projection adapter query result differs from the deterministic reference result.", "GRAPH_PROJECTION_QUERY_MISMATCH");
  }
  return {
    result: candidate,
    diagnostics: {
      adapter: adapterReport(selected),
      executionMode: "graph-projection-adapter",
      fallbackUsed: false,
      fallbackReasonCode: "",
    },
  };
}

export async function verifyGraphProjectionAdapterConformance({
  projectRoot,
  graph,
  referenceAdapter,
  candidateAdapter,
  storage = null,
  queries = [],
} = {}) {
  verifyTemporalProvenanceGraph(graph);
  const reference = createGraphProjectionAdapter({ projectRoot, adapter: referenceAdapter, storage });
  const candidate = createGraphProjectionAdapter({ projectRoot, adapter: candidateAdapter, storage });
  if (!Array.isArray(queries) || queries.length < 1 || queries.length > 64) {
    fail("Graph projection conformance requires from one through 64 query fixtures.", "INVALID_GRAPH_PROJECTION_CONFORMANCE_FIXTURES");
  }
  const names = new Set();
  const normalized = queries.map((fixture) => {
    if (!fixture || typeof fixture.name !== "string" || !fixture.name.trim() || !fixture.query || typeof fixture.query !== "object") {
      fail("Every graph projection conformance fixture requires a name and query object.", "INVALID_GRAPH_PROJECTION_CONFORMANCE_FIXTURES");
    }
    const name = fixture.name.trim();
    if (names.has(name)) fail(`Duplicate graph projection conformance fixture: ${name}`, "INVALID_GRAPH_PROJECTION_CONFORMANCE_FIXTURES");
    names.add(name);
    return { name, query: fixture.query };
  }).sort((left, right) => left.name.localeCompare(right.name));

  (await materializeGraphProjection({ projectRoot, graph, storage, adapter: reference }));
  try { (await materializeGraphProjection({ projectRoot, graph, storage, adapter: candidate })); }
  catch (error) { fail("Candidate graph projection materialization failed during conformance.", `GRAPH_PROJECTION_CANDIDATE_MATERIALIZATION_FAILED:${error.code || "UNKNOWN"}`); }
  const cases = (await Promise.all(normalized.map(async (fixture) => {
    const referenceResult = (await queryGraphProjection({ projectRoot, graph, storage, adapter: reference, query: fixture.query })).result;
    let candidateResult;
    try { candidateResult = (await queryGraphProjection({ projectRoot, graph, storage, adapter: candidate, query: fixture.query })).result; }
    catch (error) { fail(`Candidate graph projection query failed: ${fixture.name}.`, `GRAPH_PROJECTION_CANDIDATE_QUERY_FAILED:${error.code || "UNKNOWN"}`); }
    if (graphProjectionCanonicalJson(referenceResult) !== graphProjectionCanonicalJson(candidateResult)) {
      fail(`Graph projection adapters diverged for fixture: ${fixture.name}`, "GRAPH_PROJECTION_CONFORMANCE_MISMATCH");
    }
    return {
      name: fixture.name,
      queryId: referenceResult.queryId,
      queryHash: referenceResult.queryHash,
      resultId: referenceResult.resultId,
      resultHash: referenceResult.resultHash,
    };
  })));
  const payload = {
    schemaVersion: 1,
    kind: "GraphProjectionConformanceReport",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-graph-projection-conformance"), version: GRAPH_PROJECTION_ADAPTER_VERSION },
    graphSnapshotId: graph.graphSnapshotId,
    graphSnapshotHash: graph.graphSnapshotHash,
    sourceSnapshotId: graph.sourceSnapshotId,
    referenceAdapter: reference.describe(),
    candidateAdapter: candidate.describe(),
    cases,
    semanticIdentity: "adapter-neutral",
    authority: "derived-verification-evidence-only",
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const conformanceReportHash = digest(graphProjectionCanonicalJson(payload));
  return verifyGraphProjectionConformanceReport({ ...payload, conformanceReportId: `graph-projection-conformance-${conformanceReportHash.slice(0, 24)}`, conformanceReportHash });
}

export function verifyGraphProjectionConformanceReport(document, storage = null) {
  assertFields(document, [
    "schemaVersion", "kind", "protocol", "graphSnapshotId", "graphSnapshotHash", "sourceSnapshotId", "referenceAdapter",
    "candidateAdapter", "cases", "semanticIdentity", "authority", "instructionAuthority", "promotionAuthority",
    "conformanceReportId", "conformanceReportHash",
  ], "Graph projection conformance report", "INVALID_GRAPH_PROJECTION_CONFORMANCE_REPORT");
  if (!document || document.kind !== "GraphProjectionConformanceReport" || document.schemaVersion !== 1
    || !familyFormatForOriginal("head-agent-core-graph-projection-conformance", document, storage)
    || document.protocol?.version !== GRAPH_PROJECTION_ADAPTER_VERSION
    || !/^graph-snapshot-[a-f0-9]{24}$/.test(document.graphSnapshotId || "")
    || !/^[a-f0-9]{64}$/.test(document.graphSnapshotHash || "")
    || !/^source-snapshot-[a-f0-9]{24}$/.test(document.sourceSnapshotId || "")
    || !Array.isArray(document.cases) || document.cases.length < 1 || document.cases.length > 64
    || document.semanticIdentity !== "adapter-neutral"
    || document.authority !== "derived-verification-evidence-only"
    || document.instructionAuthority !== false || document.promotionAuthority !== false
    || !/^graph-projection-conformance-[a-f0-9]{24}$/.test(document.conformanceReportId || "")
    || !/^[a-f0-9]{64}$/.test(document.conformanceReportHash || "")) {
    fail("Graph projection conformance report is invalid.", "INVALID_GRAPH_PROJECTION_CONFORMANCE_REPORT");
  }
  for (const adapter of [document.referenceAdapter, document.candidateAdapter]) {
    if (!adapter || adapter.contract !== GRAPH_PROJECTION_CONTRACT || adapter.adapterVersion !== GRAPH_PROJECTION_ADAPTER_VERSION
      || typeof adapter.adapterKind !== "string" || !adapter.adapterKind.trim()
      || typeof adapter.remote !== "boolean" || typeof adapter.durable !== "boolean"
      || adapter.authority !== "derived-evidence-only" || adapter.rebuildable !== true
      || adapter.uniqueAuthority !== false || adapter.instructionAuthority !== false || adapter.promotionAuthority !== false) {
      fail("Graph projection conformance report contains an invalid adapter descriptor.", "INVALID_GRAPH_PROJECTION_CONFORMANCE_REPORT");
    }
  }
  const names = new Set();
  for (const fixture of document.cases) {
    assertFields(fixture, ["name", "queryId", "queryHash", "resultId", "resultHash"], "Graph projection conformance case", "INVALID_GRAPH_PROJECTION_CONFORMANCE_REPORT");
    if (!fixture || typeof fixture.name !== "string" || !fixture.name.trim() || names.has(fixture.name)
      || !/^traversal-query-[a-f0-9]{24}$/.test(fixture.queryId || "") || !/^[a-f0-9]{64}$/.test(fixture.queryHash || "")
      || !/^traversal-result-[a-f0-9]{24}$/.test(fixture.resultId || "") || !/^[a-f0-9]{64}$/.test(fixture.resultHash || "")) {
      fail("Graph projection conformance report case is invalid.", "INVALID_GRAPH_PROJECTION_CONFORMANCE_REPORT");
    }
    names.add(fixture.name);
  }
  if (graphProjectionCanonicalJson([...names]) !== graphProjectionCanonicalJson([...names].sort())) {
    fail("Graph projection conformance cases are not canonically ordered.", "INVALID_GRAPH_PROJECTION_CONFORMANCE_REPORT");
  }
  const payload = { ...document };
  delete payload.conformanceReportId;
  delete payload.conformanceReportHash;
  const hash = digest(graphProjectionCanonicalJson(payload));
  if (document.conformanceReportHash !== hash || document.conformanceReportId !== `graph-projection-conformance-${hash.slice(0, 24)}`) {
    fail("Graph projection conformance report digest verification failed.", "GRAPH_PROJECTION_CONFORMANCE_DIGEST_MISMATCH");
  }
  return document;
}
