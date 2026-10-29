import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatForVerifiedOwner, familyFormatForOriginal } from "../scripts/lib/project-storage-format.mjs";
import { loadReleaseObservationProjection } from "../scripts/lib/release-observation-projection.mjs";
import { initializeProject, inspectProject } from "../scripts/lib/lode-core.mjs";
import { buildTemporalProvenanceGraph, queryTemporalProvenanceGraph } from "../scripts/lib/temporal-provenance.mjs";
import {
  buildPreparedTraversalRequest, verifyPreparedTraversalRequest, verifyPreparedTraversalVerification,
  graphProjectionCanonicalJson, LocalJsonGraphProjectionAdapter, InMemoryGraphProjectionAdapter,
} from "../scripts/lib/graph-projection-adapter.mjs";

test("bare lode-like project IDs do not change the existing lower projection wire default", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), "lode-bare-id-contract-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 20 : 0, retryDelay: 100 }));
  const projectId = `lode-${"a".repeat(20)}`;
  const legacy = loadReleaseObservationProjection({ projectRoot: root, projectId });
  assert.equal(legacy.protocol.name, "head-agent-core-release-observation-projection");
  assert.equal(legacy.projectId, projectId);
  assert.equal(formatForVerifiedOwner(projectId).dialect, "head");
  assert.deepEqual(fs.readdirSync(root), []);
});

test("Release lower reader accepts explicit Lode layout without reading Project Session manifest or lease", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), "lode-wire-contract-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 20 : 0, retryDelay: 100 }));
  // No Project/default/manifest exists: this is a lower contract fixture, not init.
  const storage = Object.freeze({ projectRoot: root, projectId: `lode-${"b".repeat(20)}`, dialect: "lode", directory: ".lode", projectFile: path.join(root, ".lode/project.json") });
  const original = fs.readFileSync, reads = [];
  fs.readFileSync = (file, ...args) => {
    reads.push(String(file));
    assert.equal(String(file) === storage.projectFile || /(?:current|manifest|owner)\.json$/.test(String(file)), false, "Stored reader acquired a new currentness prerequisite");
    return original(file, ...args);
  };
  let projection;
  try { projection = loadReleaseObservationProjection({ projectRoot: root, projectId: storage.projectId, storage }); }
  finally { fs.readFileSync = original; }
  assert.equal(projection.protocol.name, "lode-agent-core-release-observation-projection");
  assert.deepEqual(projection.branchStates, []); assert.deepEqual(projection.deploymentResults, []); assert.deepEqual(projection.releases, []);
  assert.equal(reads.length, 0); assert.deepEqual(fs.readdirSync(root), []);
});

test("original family matching rejects hybrid owner fields without changing signed original bytes", () => {
  const old = { protocol: { name: "head-agent-core-session-work-evidence", version: "0.1.0" }, headSessionId: "legacy-session", text: "Original HEAD text remains evidence." };
  const fresh = { protocol: { name: "lode-agent-core-session-work-evidence", version: "0.1.0" }, lodeSessionId: "fresh-session", text: "Original HEAD text remains evidence." };
  const family = { legacy: old.protocol.name, lode: fresh.protocol.name };
  const before = [JSON.stringify(old), JSON.stringify(fresh)];
  assert.equal(familyFormatForOriginal(family, old).dialect, "head");
  assert.equal(familyFormatForOriginal(family, fresh).dialect, "lode");
  assert.equal(familyFormatForOriginal(family, { ...old, lodeSessionId: "fresh-session" }), null);
  assert.equal(familyFormatForOriginal(family, { ...fresh, headSessionId: "legacy-session" }), null);
  assert.equal(familyFormatForOriginal(family, { ...old, protocol: fresh.protocol }), null);
  assert.deepEqual([JSON.stringify(old), JSON.stringify(fresh)], before);
});

const preparedAnchorDigest = value => crypto.createHash("sha256").update(value).digest("hex");
const preparedAnchorDocumentDigest = value => preparedAnchorDigest(graphProjectionCanonicalJson(value));
async function preparedAnchorFixture(t, ownerAware = false) {
  const parent = fs.realpathSync(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, "lode-prepared-anchor-")));
  t.after(() => {
    assert.equal(path.dirname(root), parent); assert(path.basename(root).startsWith("lode-prepared-anchor-"));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 20 : 0, retryDelay: 100 });
  });
  // Same file-descriptor semantics as the existing prepared traversal benchmark:
  // actual source digest, language/classification and bounded source declarations.
  const source = "export function acceptRequest() { return 'accepted'; }\n";
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/request.mjs"), source);
  const files = [{ path: "src/request.mjs", digest: preparedAnchorDigest(source), language: "javascript",
    classification: "source", symbols: [{ name: "acceptRequest", kind: "function", line: 1 }] }];
  let storage;
  if (ownerAware) {
    initializeProject({ root, pluginRoot: path.resolve(import.meta.dirname, ".."), runtimes: ["codex"] });
    storage = inspectProject(root).storage;
    assert.equal(storage.dialect, "lode");
    assert.equal(storage.projectRoot, root);
  }
  // Legacy is a real pure builder invocation, not a renamed canonical graph.
  const graph = buildTemporalProvenanceGraph({ projectId: storage?.projectId || "project-prepared-anchor-legacy",
    files, ...(storage ? { storage } : {}) });
  const local = new LocalJsonGraphProjectionAdapter({ projectRoot: root, ...(storage ? { storage } : {}) });
  const memory = new InMemoryGraphProjectionAdapter();
  for (const adapter of [local, memory]) (await adapter.writeSnapshot(graph.graphSnapshotId, structuredClone(graph)));
  return { root, storage, graph, local, memory, files };
}
function preparedAnchorQuery(graph, exact) {
  const anchor = graph.nodes.find(node => node.kind === "File" && node.path === "src/request.mjs");
  assert(anchor, "Actual builder must retain the source File anchor.");
  return exact ? { anchorIds: [anchor.nodeId], expectedGraphSnapshotId: graph.graphSnapshotId, depth: 1, maxNodes: 100, maxEdges: 200 }
    : { query: anchor.nodeId, depth: 1, maxNodes: 100, maxEdges: 200 };
}
function preparedAnchorRehash(document, { query = false } = {}) {
  if (query) {
    document.queryHash = preparedAnchorDocumentDigest(document.traversalQuery);
    document.queryId = "traversal-query-" + document.queryHash.slice(0, 24);
  }
  const payload = { ...document };
  delete payload.requestId; delete payload.requestHash;
  document.requestHash = preparedAnchorDocumentDigest(payload);
  document.requestId = "prepared-traversal-" + document.requestHash.slice(0, 24);
  return document;
}
function assertPreparedAnchorDigests(request) {
  assert.equal(request.queryHash, preparedAnchorDocumentDigest(request.traversalQuery));
  assert.equal(request.queryId, "traversal-query-" + request.queryHash.slice(0, 24));
  assert.equal(request.expansionHash, preparedAnchorDocumentDigest(request.expansion));
  const manifest = { ...request.graphManifest };
  delete manifest.graphManifestHash;
  assert.equal(request.graphManifest.graphManifestHash, preparedAnchorDocumentDigest(manifest));
  const payload = { ...request };
  delete payload.requestId; delete payload.requestHash;
  assert.equal(request.requestHash, preparedAnchorDocumentDigest(payload));
  assert.equal(request.requestId, "prepared-traversal-" + request.requestHash.slice(0, 24));
}
async function preparedAnchorReplay(fixture, exact) {
  const { storage, graph, local, memory } = fixture;
  const result = queryTemporalProvenanceGraph(graph, preparedAnchorQuery(graph, exact));
  const before = graphProjectionCanonicalJson({ graph, result });
  const request = buildPreparedTraversalRequest({ graph, result, ...(storage ? { storage } : {}) });
  const originalRequest = graphProjectionCanonicalJson(request);
  const format = formatForVerifiedOwner(storage);
  assert.equal(request.protocol.name, format.protocol("head-agent-core-prepared-traversal"));
  assert.equal(request.traversalQuery.anchorMode, exact ? format.value("exact-head-proposed") : "lexical-discovery");
  assert.deepEqual(request.traversalQuery, result.traversalQuery);
  assertPreparedAnchorDigests(request);
  assert.strictEqual(verifyPreparedTraversalRequest(request, { graph, result, ...(storage ? { storage } : {}) }), request);
  const location = local.snapshotLocation(graph.graphSnapshotId);
  const diskBefore = fs.readFileSync(location, "utf8");
  const diskEntriesBefore = fs.readdirSync(path.dirname(location)).sort();
  const memoryBefore = graphProjectionCanonicalJson([...memory.snapshots]);
  for (const adapter of [local, memory]) {
    const verification = (await adapter.queryPrepared(request));
    assert.strictEqual(verifyPreparedTraversalVerification(verification, request, storage), verification);
    assert.equal(verification.protocol.name, request.protocol.name);
    for (const key of ["requestId", "requestHash", "queryId", "queryHash", "resultId", "resultHash", "expansionHash"]) {
      assert.equal(verification[key], request[key]);
    }
  }
  assert.equal(fs.readFileSync(location, "utf8"), diskBefore);
  assert.deepEqual(fs.readdirSync(path.dirname(location)).sort(), diskEntriesBefore);
  assert.equal(graphProjectionCanonicalJson([...memory.snapshots]), memoryBefore);
  assert.equal(graphProjectionCanonicalJson({ graph, result }), before);
  assert.equal(graphProjectionCanonicalJson(request), originalRequest);
  return { request, result };
}

test("pure legacy prepared traversal retains default original digests and replays lexical and exact anchors in both local adapters", async t => {
  const fixture = (await preparedAnchorFixture(t));
  assert.equal(fixture.graph.protocol.name, "head-agent-core-temporal-provenance");
  assert.equal(graphProjectionCanonicalJson(buildTemporalProvenanceGraph({ projectId: fixture.graph.projectId, files: fixture.files })),
    graphProjectionCanonicalJson(fixture.graph));
  for (const exact of [false, true]) {
    const { request, result } = (await preparedAnchorReplay(fixture, exact));
    assert.equal(request.protocol.name, "head-agent-core-prepared-traversal");
    assert.equal(graphProjectionCanonicalJson(buildPreparedTraversalRequest({ graph: fixture.graph, result, storage: null })),
      graphProjectionCanonicalJson(request));
  }
});

test("owner-aware Lode prepared traversal preserves canonical lexical and exact anchors through both local adapters", async t => {
  const fixture = (await preparedAnchorFixture(t, true));
  assert.equal(fixture.graph.protocol.name, "lode-agent-core-temporal-provenance");
  for (const exact of [false, true]) (await preparedAnchorReplay(fixture, exact));
  assert.equal(fs.existsSync(path.join(fixture.root, ".head")), false);
  assert(fs.existsSync(path.join(fixture.root, ".lode", "project.json")));
});

test("prepared traversal rejects rehashed exact anchor hybrids and cross-family lexical graph expectations", async t => {
  for (const ownerAware of [false, true]) {
    const fixture = (await preparedAnchorFixture(t, ownerAware)), { graph, storage } = fixture;
    const { request } = (await preparedAnchorReplay(fixture, true));
    const hybrid = structuredClone(request);
    hybrid.traversalQuery.anchorMode = ownerAware ? "exact-head-proposed" : "exact-lode-proposed";
    preparedAnchorRehash(hybrid, { query: true });
    assertPreparedAnchorDigests(hybrid);
    assert.throws(() => verifyPreparedTraversalRequest(hybrid, { ...(storage ? { storage } : {}) }),
      { code: "INVALID_PREPARED_TRAVERSAL_REQUEST" });
    for (const adapter of [fixture.local, fixture.memory]) {
      (await assert.rejects(async () => (await adapter.queryPrepared(hybrid)), { code: "INVALID_PREPARED_TRAVERSAL_REQUEST" }));
    }
    assert.throws(() => buildPreparedTraversalRequest({ graph, result: { ...queryTemporalProvenanceGraph(graph, preparedAnchorQuery(graph, true)),
      traversalQuery: hybrid.traversalQuery }, ...(storage ? { storage } : {}) }), { code: "INVALID_PREPARED_TRAVERSAL_REQUEST" });

    const lexical = (await preparedAnchorReplay(fixture, false));
    const lexicalHybrid = structuredClone(lexical.request);
    lexicalHybrid.protocol.name = ownerAware ? "head-agent-core-prepared-traversal" : "lode-agent-core-prepared-traversal";
    preparedAnchorRehash(lexicalHybrid);
    assertPreparedAnchorDigests(lexicalHybrid);
    // Standalone original validation cannot invent a graph family for shared
    // lexical mode. Supplying the real graph/result must reject the mismatch,
    // not relabel its protocol after hashing a different family's expected body.
    assert.strictEqual(verifyPreparedTraversalRequest(lexicalHybrid), lexicalHybrid);
    assert.throws(() => verifyPreparedTraversalRequest(lexicalHybrid, { graph, result: lexical.result }),
      { code: "PREPARED_TRAVERSAL_REQUEST_MISMATCH" });
  }
});

test("prepared traversal preserves query expansion manifest and request digest tamper errors in both original families", async t => {
  const wrongDigest = value => (value[0] === "0" ? "1" : "0") + value.slice(1);
  for (const ownerAware of [false, true]) {
    const fixture = (await preparedAnchorFixture(t, ownerAware));
    const { request } = (await preparedAnchorReplay(fixture, true));
    const original = graphProjectionCanonicalJson(request);
    const cases = [
      [document => { document.traversalQuery.minConfidence = 0.5; }, "PREPARED_TRAVERSAL_QUERY_DIGEST_MISMATCH"],
      [document => { document.expansionHash = wrongDigest(document.expansionHash); }, "PREPARED_TRAVERSAL_EXPANSION_DIGEST_MISMATCH"],
      [document => { document.graphManifest.graphManifestHash = wrongDigest(document.graphManifest.graphManifestHash); }, "PREPARED_TRAVERSAL_GRAPH_MANIFEST_DIGEST_MISMATCH"],
      [document => { document.requestHash = wrongDigest(document.requestHash); }, "PREPARED_TRAVERSAL_DIGEST_MISMATCH"],
    ];
    for (const [tamper, code] of cases) {
      const document = structuredClone(request); tamper(document);
      // Keep the outer hash stale: the existing inner-digest ordering must win.
      assert.throws(() => verifyPreparedTraversalRequest(document, { ...(fixture.storage ? { storage: fixture.storage } : {}) }), { code });
    }
    assert.equal(graphProjectionCanonicalJson(request), original);
    assertPreparedAnchorDigests(request);
  }
});
