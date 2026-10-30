#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  ArcadeDbGraphProjectionAdapter,
  ArcadeDbHttpTransport,
  buildPreparedTraversalRequest,
  createActivatedArcadeDbGraphProjectionAdapter,
  graphProjectionCanonicalJson,
  inspectArcadeDbGraphProjectionActivation,
  materializeGraphProjection,
  queryGraphProjection,
} from "./lib/graph-projection-adapter.mjs";
import { buildStorageSelection } from "./lib/onboarding-contract.mjs";
import { buildPreparedTraversalCostEvidence } from "./lib/prepared-traversal-benchmark.mjs";
import { buildTemporalProvenanceGraph, queryTemporalProvenanceGraph } from "./lib/temporal-provenance.mjs";
import { inspectWorldModel } from "./lib/world-model.mjs";

const fail = (message, code = "PREPARED_TRAVERSAL_BENCHMARK_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const expectedFixtureFile = path.resolve(scriptDirectory, "../benchmarks/prepared-traversal-v1/expected.json");

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value == null) fail("Arguments must be --name value pairs.", "INVALID_BENCHMARK_ARGUMENTS");
    const name = key.slice(2);
    if (!["iterations", "live-project", "query"].includes(name) || result[name] != null) {
      fail(`Unsupported or duplicate argument: ${key}`, "INVALID_BENCHMARK_ARGUMENTS");
    }
    result[name] = value;
  }
  const iterations = Number(result.iterations || 7);
  if (!Number.isInteger(iterations) || iterations < 3 || iterations > 100) {
    fail("--iterations must be an integer from 3 through 100.", "INVALID_BENCHMARK_ARGUMENTS");
  }
  return { iterations, liveProject: result["live-project"] || "", query: result.query || "" };
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

class ObservationLedger {
  constructor() { this.reset(); }
  reset() { this.operations = new Map(); this.writeAttemptCount = 0; }
  observe(name, started, value) {
    const current = this.operations.get(name) || { calls: 0, normalizedResponseBytes: 0, elapsedMs: [] };
    current.calls += 1;
    current.normalizedResponseBytes += value == null ? 0 : Buffer.byteLength(JSON.stringify(value), "utf8");
    current.elapsedMs.push(Math.max(0, performance.now() - started));
    this.operations.set(name, current);
    return value;
  }
  summary() {
    return {
      operations: Object.fromEntries([...this.operations.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => [name, {
        calls: value.calls,
        normalizedResponseBytes: value.normalizedResponseBytes,
        medianElapsedMs: median(value.elapsedMs),
      }])),
      writeAttemptCount: this.writeAttemptCount,
    };
  }
}

class FixtureArcadeDbTransport extends ObservationLedger {
  constructor() {
    super();
    this.snapshots = new Map();
    this.pointers = new Map();
    this.topologies = new Map();
  }
  describe() { return { protocol: "arcadedb-http-json", credentialsPersisted: false }; }
  ensureSchema() {}
  ensureTopologySchema() {}
  readPointer(projectId) {
    const started = performance.now();
    return this.observe("readPointer", started, this.pointers.get(projectId) ?? null);
  }
  readSnapshot(projectId, graphSnapshotId) {
    const started = performance.now();
    return this.observe("readSnapshot", started, this.snapshots.get(`${projectId}:${graphSnapshotId}`) ?? null);
  }
  writePointer(projectId, pointerJson) { this.pointers.set(projectId, pointerJson); }
  writeSnapshot(projectId, graphSnapshotId, snapshotJson) {
    const key = `${projectId}:${graphSnapshotId}`;
    const created = !this.snapshots.has(key);
    if (created) this.snapshots.set(key, snapshotJson);
    return created;
  }
  listSnapshotIds(projectId) {
    const started = performance.now();
    const values = [...this.snapshots.keys()].filter((key) => key.startsWith(`${projectId}:`))
      .map((key) => key.slice(projectId.length + 1)).sort();
    return this.observe("listSnapshotIds", started, values);
  }
  readTopology(projectId, graphSnapshotId) {
    const started = performance.now();
    const value = this.topologies.get(`${projectId}:${graphSnapshotId}`) || null;
    return this.observe("readTopology", started, value == null ? null : structuredClone(value));
  }
  readTopologyManifest(projectId, graphSnapshotId) {
    const started = performance.now();
    const value = this.topologies.get(`${projectId}:${graphSnapshotId}`)?.topologyJson ?? null;
    return this.observe("readTopologyManifest", started, value);
  }
  writeTopology(projectId, graphSnapshotId, graph, topology) {
    this.topologies.set(`${projectId}:${graphSnapshotId}`, {
      topologyJson: graphProjectionCanonicalJson(topology),
      nodeJsons: graph.nodes.map((node) => graphProjectionCanonicalJson(node)),
      edgeJsons: graph.edges.map((edge) => graphProjectionCanonicalJson(edge)),
    });
  }
  queryTopology(projectId, graphSnapshotId, { anchorIds, maxDepth, maxRecords }) {
    const started = performance.now();
    const topology = this.topologies.get(`${projectId}:${graphSnapshotId}`);
    const nodes = (topology?.nodeJsons || []).map((value) => JSON.parse(value));
    const edges = (topology?.edgeJsons || []).map((value) => JSON.parse(value));
    const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
    const visitedNodes = new Set(anchorIds);
    const visitedEdges = new Set();
    const records = anchorIds.map((nodeId) => ({
      recordType: "HeadAgentGraphNode", nodeJson: graphProjectionCanonicalJson(nodeById.get(nodeId)), edgeJson: null, recordDepth: 0,
    }));
    let frontier = new Set(anchorIds);
    for (let level = 0; level < maxDepth && frontier.size; level += 1) {
      const next = new Set();
      for (const edge of edges) {
        if ((!frontier.has(edge.from) && !frontier.has(edge.to)) || visitedEdges.has(edge.edgeId)) continue;
        visitedEdges.add(edge.edgeId);
        records.push({
          recordType: "HeadAgentGraphEdge", nodeJson: null, edgeJson: graphProjectionCanonicalJson(edge), recordDepth: (level * 2) + 1,
        });
        for (const nodeId of [edge.from, edge.to]) if (!visitedNodes.has(nodeId)) next.add(nodeId);
      }
      for (const nodeId of [...next].sort()) {
        visitedNodes.add(nodeId);
        records.push({
          recordType: "HeadAgentGraphNode", nodeJson: graphProjectionCanonicalJson(nodeById.get(nodeId)), edgeJson: null, recordDepth: (level + 1) * 2,
        });
      }
      frontier = next;
    }
    const response = {
      protocolVersion: "0.1.0", graphSnapshotId, anchorIds: [...anchorIds], maxDepth, maxRecords,
      truncated: records.length > maxRecords, records: records.slice(0, maxRecords),
    };
    return this.observe("queryTopology", started, response);
  }
}

class ReadOnlyObservedArcadeDbTransport extends ObservationLedger {
  constructor(delegate) { super(); this.delegate = delegate; }
  describe() { return this.delegate.describe(); }
  denyWrite() { this.writeAttemptCount += 1; fail("Live benchmark transport is read-only.", "LIVE_BENCHMARK_WRITE_FORBIDDEN"); }
  ensureSchema() { return this.denyWrite(); }
  ensureTopologySchema() { return this.denyWrite(); }
  ensureSyncSchema() { return this.denyWrite(); }
  writePointer() { return this.denyWrite(); }
  writeSnapshot() { return this.denyWrite(); }
  writeTopology() { return this.denyWrite(); }
  writeSyncManifest() { return this.denyWrite(); }
  writeSyncCheckpoint() { return this.denyWrite(); }
  applySyncBatch() { return this.denyWrite(); }
  writePointerCompareAndSwap() { return this.denyWrite(); }
  call(name, args) {
    const started = performance.now();
    return this.observe(name, started, this.delegate[name](...args));
  }
  readPointer(...args) { return this.call("readPointer", args); }
  readSnapshot(...args) { return this.call("readSnapshot", args); }
  listSnapshotIds(...args) { return this.call("listSnapshotIds", args); }
  readTopology(...args) { return this.call("readTopology", args); }
  readTopologyManifest(...args) { return this.call("readTopologyManifest", args); }
  queryTopology(...args) { return this.call("queryTopology", args); }
  readSyncManifest(...args) { return this.call("readSyncManifest", args); }
  readSyncCheckpoints(...args) { return this.call("readSyncCheckpoints", args); }
  readSyncBatchRecords(...args) { return this.call("readSyncBatchRecords", args); }
}

function fixtureGraph() {
  const files = Array.from({ length: 64 }, (_, index) => {
    const ordinal = String(index).padStart(3, "0");
    return {
      path: `src/component-${ordinal}.mjs`,
      digest: crypto.createHash("sha256").update(`prepared-traversal-fixture-${ordinal}`).digest("hex"),
      language: "javascript",
      classification: index % 8 === 0 ? "test" : "source",
      symbols: [{ name: `component${ordinal}`, kind: "function", line: 1 }],
    };
  });
  return buildTemporalProvenanceGraph({ projectId: "project-prepared-traversal-benchmark", files });
}

function queryFor(graph, queryText = "") {
  const anchor = graph.nodes.find((node) => node.kind === "File") || graph.nodes[0];
  return { query: queryText || anchor.nodeId, depth: 1, maxNodes: 100, maxEdges: 200 };
}

function fixtureExpectation({ graph, request, result, costEvidence }) {
  return {
    schemaVersion: 1,
    kind: "PreparedTraversalBenchmarkFixtureExpectation",
    protocolVersion: "0.1.0",
    graphSnapshotId: graph.graphSnapshotId,
    graphSnapshotHash: graph.graphSnapshotHash,
    requestId: request.requestId,
    requestHash: request.requestHash,
    resultId: result.resultId,
    resultHash: result.resultHash,
    costEvidenceId: costEvidence.evidenceId,
    costEvidenceHash: costEvidence.evidenceHash,
    preparedQueryBytes: costEvidence.preparedQueryBytes,
    fullReloadBaselineBytes: costEvidence.fullReloadBaselineBytes,
    savedBytes: costEvidence.savedBytes,
    reductionBasisPoints: costEvidence.reductionBasisPoints,
    authorityEffect: "none",
  };
}

function verifyPreparedReadShape(transportSummary, iterations) {
  const calls = (operation) => transportSummary.operations[operation]?.calls || 0;
  const pointerReadCalls = calls("readPointer");
  const topologyManifestReadCalls = calls("readTopologyManifest");
  const traversalQueryCalls = calls("queryTopology");
  if (pointerReadCalls !== iterations || topologyManifestReadCalls !== iterations || traversalQueryCalls !== iterations) {
    fail("Prepared traversal must perform exactly one pointer, manifest, and bounded traversal read per query.", "PREPARED_TRAVERSAL_DUPLICATE_READ");
  }
  return {
    queryCount: iterations,
    previousPointerReadBaselineCalls: iterations * 2,
    pointerReadCalls,
    savedPointerReadCalls: iterations,
    pointerReadReductionBasisPoints: 5000,
    topologyManifestReadCalls,
    traversalQueryCalls,
    semanticIdentityEffect: "none",
  };
}

async function runFixture(iterations, queryText) {
  const graph = fixtureGraph();
  const query = queryFor(graph, queryText);
  const result = queryTemporalProvenanceGraph(graph, query);
  const request = buildPreparedTraversalRequest({ graph, result });
  if (request.traversalQuery.anchorIds.length === 0) fail("Benchmark query must resolve at least one graph anchor.", "BENCHMARK_QUERY_HAS_NO_ANCHOR");
  const costEvidence = buildPreparedTraversalCostEvidence({ graph, request });
  const expected = JSON.parse(fs.readFileSync(expectedFixtureFile, "utf8"));
  const actualExpectation = fixtureExpectation({ graph, request, result, costEvidence });
  if (graphProjectionCanonicalJson(expected) !== graphProjectionCanonicalJson(actualExpectation)) {
    fail(`Prepared traversal benchmark no longer matches the reviewed fixture identity. Actual: ${JSON.stringify(actualExpectation)}`, "BENCHMARK_FIXTURE_IDENTITY_DRIFT");
  }
  const selection = buildStorageSelection({
    projectId: graph.projectId,
    selection: {
      mode: "graphdb",
      endpoint: "https://fixture.invalid",
      database: "head_agent_fixture",
      secretReferenceNames: { username: "HEAD_GRAPHDB_USERNAME", password: "HEAD_GRAPHDB_PASSWORD" },
    },
  });
  const transport = new FixtureArcadeDbTransport();
  const adapter = new ArcadeDbGraphProjectionAdapter({
    storageSelection: selection,
    transport,
    topologyRequired: true,
    serverTraversalRequired: true,
    preparedTraversalRequired: true,
  });
  (await materializeGraphProjection({ projectRoot: ".", graph, adapter }));
  const alternateAnchor = graph.nodes.find((node) => !request.traversalQuery.anchorIds.includes(node.nodeId));
  if (!alternateAnchor) fail("Benchmark requires a second graph anchor for receipt replay rejection.", "BENCHMARK_REPLAY_ANCHOR_MISSING");
  const alternateResult = queryTemporalProvenanceGraph(graph, {
    query: alternateAnchor.nodeId,
    depth: 0,
    maxNodes: 1,
    maxEdges: 0,
  });
  const alternateRequest = buildPreparedTraversalRequest({ graph, result: alternateResult });
  const replayedVerification = (await adapter.queryPrepared(alternateRequest));
  const queryPrepared = adapter.queryPrepared.bind(adapter);
  adapter.queryPrepared = () => replayedVerification;
  let receiptReplayRejected = false;
  try {
    (await queryGraphProjection({ projectRoot: ".", graph, adapter, query }));
  } catch (error) {
    if (error.code !== "PREPARED_TRAVERSAL_VERIFICATION_MISMATCH") throw error;
    receiptReplayRejected = true;
  } finally {
    adapter.queryPrepared = queryPrepared;
  }
  if (!receiptReplayRejected) fail("Prepared traversal accepted a valid receipt from a distinct request.", "BENCHMARK_RECEIPT_REPLAY_ACCEPTED");
  transport.reset();
  const elapsedMs = [];
  let receiptReuseCount = 0;
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    const execution = (await queryGraphProjection({ projectRoot: ".", graph, adapter, query }));
    elapsedMs.push(Math.max(0, performance.now() - started));
    if (execution.result.resultId !== result.resultId || execution.result.resultHash !== result.resultHash) {
      fail("Fixture benchmark semantic identity drifted.", "BENCHMARK_SEMANTIC_IDENTITY_DRIFT");
    }
    const receipt = execution.diagnostics.preparedTraversal?.clientReceiptVerification;
    if (receipt?.verificationDocumentDigest !== "independently-verified"
      || receipt.requestBinding !== "same-stack-locally-built-request"
      || receipt.fullRequestReverification !== false) {
      fail("Fixture benchmark did not use the bounded client-receipt verification path.", "BENCHMARK_RECEIPT_VERIFICATION_DRIFT");
    }
    receiptReuseCount += 1;
  }
  const transportSummary = transport.summary();
  if (transportSummary.writeAttemptCount !== 0
    || transportSummary.operations.readSnapshot?.calls
    || transportSummary.operations.readTopology?.calls) {
    fail("Prepared fixture benchmark performed a forbidden full read or write.", "BENCHMARK_BOUNDARY_VIOLATION");
  }
  const readShape = verifyPreparedReadShape(transportSummary, iterations);
  return {
    mode: "arcadedb-transport-contract-fixture",
    graph,
    request,
    result,
    costEvidence,
    elapsedMs,
    transportSummary,
    readShape,
    receiptVerification: {
      queryCount: iterations,
      locallyBuiltRequestReuseCount: receiptReuseCount,
      fullRequestReverificationCount: 0,
      verificationDocumentDigestChecks: iterations,
      requestBindingChecks: iterations,
      semanticIdentityEffect: "none",
    },
    receiptReplayRejected,
    liveEnvironmentValidated: false,
  };
}

async function runLive(projectRoot, iterations, queryText) {
  const inspected = inspectArcadeDbGraphProjectionActivation({ projectRoot });
  if (inspected.status !== "verified-active"
    || inspected.conformanceReport?.candidateAdapter?.preparedTraversalProtocolVersion !== "0.1.0") {
    fail("Live benchmark requires a verified prepared-traversal ArcadeDB activation.", "LIVE_PREPARED_TRAVERSAL_NOT_ACTIVE");
  }
  const world = (await inspectWorldModel({ root: projectRoot }));
  const graph = world.snapshot.temporalProvenanceGraph;
  const query = queryFor(graph, queryText);
  const result = queryTemporalProvenanceGraph(graph, query);
  const request = buildPreparedTraversalRequest({ graph, result });
  if (request.traversalQuery.anchorIds.length === 0) fail("Benchmark query must resolve at least one graph anchor.", "BENCHMARK_QUERY_HAS_NO_ANCHOR");
  const costEvidence = buildPreparedTraversalCostEvidence({ graph, request });
  const transport = new ReadOnlyObservedArcadeDbTransport(new ArcadeDbHttpTransport({ storageSelection: inspected.storageSelection }));
  const adapter = createActivatedArcadeDbGraphProjectionAdapter({ projectRoot, transport });
  if (!adapter?.describe().preparedTraversalProtocolVersion) {
    fail("Live activated adapter does not expose prepared traversal.", "LIVE_PREPARED_TRAVERSAL_NOT_ACTIVE");
  }
  const elapsedMs = [];
  let receiptReuseCount = 0;
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    const execution = (await queryGraphProjection({ projectRoot, graph, adapter, query }));
    elapsedMs.push(Math.max(0, performance.now() - started));
    if (execution.result.resultId !== result.resultId || execution.result.resultHash !== result.resultHash
      || execution.diagnostics.fallbackUsed) {
      fail("Live benchmark used fallback or changed semantic identity.", "LIVE_BENCHMARK_CONFORMANCE_FAILED");
    }
    const receipt = execution.diagnostics.preparedTraversal?.clientReceiptVerification;
    if (receipt?.verificationDocumentDigest !== "independently-verified"
      || receipt.requestBinding !== "same-stack-locally-built-request"
      || receipt.fullRequestReverification !== false) {
      fail("Live benchmark did not use the bounded client-receipt verification path.", "LIVE_BENCHMARK_RECEIPT_VERIFICATION_DRIFT");
    }
    receiptReuseCount += 1;
  }
  const transportSummary = transport.summary();
  if (transportSummary.writeAttemptCount !== 0
    || transportSummary.operations.readSnapshot?.calls
    || transportSummary.operations.readTopology?.calls) {
    fail("Live benchmark performed a forbidden full read or write.", "LIVE_BENCHMARK_BOUNDARY_VIOLATION");
  }
  const readShape = verifyPreparedReadShape(transportSummary, iterations);
  return {
    mode: "arcadedb-live-read-only",
    graph,
    request,
    result,
    costEvidence,
    elapsedMs,
    transportSummary,
    readShape,
    receiptVerification: {
      queryCount: iterations,
      locallyBuiltRequestReuseCount: receiptReuseCount,
      fullRequestReverificationCount: 0,
      verificationDocumentDigestChecks: iterations,
      requestBindingChecks: iterations,
      semanticIdentityEffect: "none",
    },
    liveEnvironmentValidated: true,
  };
}

try {
  const { iterations, liveProject, query } = parseArguments(process.argv.slice(2));
  const execution = liveProject
    ? await runLive(liveProject, iterations, query)
    : await runFixture(iterations, query);
  const elapsed = [...execution.elapsedMs].sort((left, right) => left - right);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    kind: "PreparedTraversalBenchmarkReport",
    mode: execution.mode,
    semanticIdentity: {
      graphSnapshotId: execution.graph.graphSnapshotId,
      graphSnapshotHash: execution.graph.graphSnapshotHash,
      requestId: execution.request.requestId,
      requestHash: execution.request.requestHash,
      resultId: execution.result.resultId,
      resultHash: execution.result.resultHash,
      costEvidenceId: execution.costEvidence.evidenceId,
      costEvidenceHash: execution.costEvidence.evidenceHash,
    },
    deterministicCost: execution.costEvidence,
    diagnostics: {
      iterations,
      minElapsedMs: elapsed[0],
      medianElapsedMs: median(elapsed),
      maxElapsedMs: elapsed.at(-1),
      transport: execution.transportSummary,
      pointerReadOptimization: execution.readShape,
      clientReceiptOptimization: execution.receiptVerification,
      timingSemantic: false,
    },
    safety: {
      queryPhaseReadOnly: true,
      persistentWrites: false,
      credentialsPersisted: false,
      fullSnapshotReads: 0,
      fullTopologyReads: 0,
      ...(execution.receiptReplayRejected == null ? {} : {
        distinctValidReceiptReplayRejected: execution.receiptReplayRejected === true,
      }),
      liveEnvironmentValidated: execution.liveEnvironmentValidated,
    },
    authorityEffect: "none",
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.code ? `${error.code}: ` : ""}${error.message}\n`);
  process.exitCode = 1;
}
