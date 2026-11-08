import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";
import { createHeadSession } from "../scripts/lib/session-routing.mjs";
import { queryProjectGraph, indexProjectGraph } from "../scripts/lib/project-graph.mjs";
import { prepareSourceContext } from "../scripts/lib/source-context-workflow.mjs";
import { proposeProductPolicy, reviewProductPolicy } from "../scripts/lib/product-policy.mjs";
import { buildWorldModel } from "../scripts/lib/world-model.mjs";
import { createWholePlanSnapshot } from "../scripts/lib/execution-lineage.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { runCommand } from "../scripts/head.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "head-coherence-")));
  t.after(() => {
    assert.match(path.basename(root), /^head-coherence-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage,
    layout = formatForVerifiedOwner(storage);
  return { root, storage, layout };
}
const call = (root, args) => dispatch({ id: 1, method: "tools/call", params: { name: "head_project_graph", arguments: { project_root: root, ...args } } });
const request = (root, anchor, extra = {}) => ({ root, anchorIds: [anchor], depth: 0, maxNodes: 1, maxEdges: 0, details: true, ...extra });
function noAuthority(result) {
  for (const value of [result.authority, ...result.nodes, ...result.edges])
    for (const key of ["instructionAuthority", "promotionAuthority", "recoveryAuthority", "executionAuthority"]) assert.equal(value[key], false);
  assert.equal(result.authority.ordinaryWorkBlocked, false);
}
function sameMetadataWrite(file, edit) {
  const stat = fs.statSync(file),
    before = fs.readFileSync(file, "utf8"),
    after = edit(before);
  assert.equal(Buffer.byteLength(after), Buffer.byteLength(before));
  fs.writeFileSync(file, after);
  fs.utimesSync(file, stat.atime, stat.mtime);
}
function headBytes(root, layout) {
  const entries = [];
  function walk(file) {
    for (const e of fs.readdirSync(file, { withFileTypes: true })) {
      const next = path.join(file, e.name);
      if (e.isDirectory()) walk(next);
      else entries.push([path.relative(root, next), fs.readFileSync(next).toString("base64")]);
    }
  }
  walk(path.join(root, layout.directory));
  return entries.sort((a, b) => a[0].localeCompare(b[0]));
}

test("MCP and CLI support zero edges, inclusive bounds and reject non-integer types", async (t) => {
  const { root, layout } = fixture(t),
    session = createHeadSession({ root, purpose: "Isolated exact anchor" }).sessionId;
  for (const details of [false, true])
    for (const depth of [0, 2, 8]) {
      const rpc = await call(root, { anchor_ids: [session], depth, max_nodes: 1, max_edges: 0, details });
      assert.equal(rpc.error, undefined);
      assert.equal(rpc.result.structuredContent.nodes[0].nodeId, session);
      assert.deepEqual(rpc.result.structuredContent.edges, []);
      noAuthority(rpc.result.structuredContent);
      const cli = await runCommand([
        "graph-query",
        root,
        "--anchors",
        session,
        "--depth",
        String(depth),
        "--max-nodes",
        "1",
        "--max-edges",
        "0",
        "--details",
        String(details),
      ]);
      assert.deepEqual(cli.edges, []);
      assert.equal(cli.nodes[0].nodeId, session);
    }
  const max = await call(root, { depth: 8, max_nodes: 500, max_edges: 1000 });
  assert.equal(max.error, undefined);
  for (const field of ["max_edges", "max_nodes", "depth"])
    for (const value of [false, true, null, "1", [], {}, 0.5]) {
      const rpc = await call(root, { [field]: value });
      assert(rpc.error, `${field}: ${JSON.stringify(value)}`);
    }
  for (const args of [{ max_edges: -1 }, { max_edges: 1001 }, { max_nodes: 0 }, { max_nodes: 501 }, { depth: -1 }, { depth: 9 }])
    assert((await call(root, args)).error);
  // Actual foreground CLI transport, not just its exported handler.
  const child = spawnSync(
    process.execPath,
    [path.join(pluginRoot, "scripts/head.mjs"), "graph-query", root, "--anchors", session, "--depth", "2", "--max-nodes", "1", "--max-edges", "0", "--json"],
    { windowsHide: true, encoding: "utf8", timeout: 30000 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout).edges, []);
});

test("warm exact anchors verify bytes without writing or claiming whole-layer currentness", async (t) => {
  const { root, layout } = fixture(t),
    a = createHeadSession({ root, purpose: "focus-old" }).sessionId;
  const b = createHeadSession({ root, purpose: "other-old" }).sessionId;
  const q = request(root, a),
    before = headBytes(root, layout),
    cold = await queryProjectGraph(q),
    warm = await queryProjectGraph({ ...q, previousResult: cold });
  assert.equal(warm.reuse.status, "scoped-originals-reused");
  assert.equal(warm.reuse.wholeProjectCurrent, false);
  assert.deepEqual(warm.nodes, cold.nodes);
  assert.deepEqual(warm.edges, cold.edges);
  assert.notEqual(warm.resultId, cold.resultId, "narrower verification claims need their own identity");
  assert.deepEqual(warm.integrity.verifiedLayers, []);
  assert(warm.integrity.retainedVerifiedLayers.includes("sessions"));
  assert(warm.integrity.verifiedRecordPaths.includes(`${layout.directory}/sessions/by-id/${a}/current.json`));
  assert(!warm.integrity.verifiedRecordPaths.includes(`${layout.directory}/sessions/by-id/${b}/current.json`));
  assert.equal(warm.coverage.unrelatedRecordBytesReverified, false);
  assert.equal(warm.sourceFallback.needed, true);
  assert.equal(warm.basis.recordsDigestScope, "retained-discovery-inventory");
  assert.deepEqual(headBytes(root, layout), before);
  noAuthority(warm);
  sameMetadataWrite(path.join(root, `${layout.directory}/sessions/by-id/${a}/current.json`), (value) => value.replace("focus-old", "focus-new"));
  const changed = await queryProjectGraph({ ...q, previousResult: warm });
  assert.equal(changed.nodes[0].purpose, "focus-new");
  assert.notEqual(changed.nodes[0].revisionId, cold.nodes[0].revisionId);
  fs.unlinkSync(path.join(root, `${layout.directory}/sessions/by-id/${a}/current.json`));
  assert(!(await queryProjectGraph(q)).nodes.some((node) => node.nodeId === a));
});

test("unrelated external bytes are not advertised current and broad queries rediscover them", async (t) => {
  const { root, layout } = fixture(t),
    a = createHeadSession({ root, purpose: "selected" }).sessionId,
    b = createHeadSession({ root, purpose: "other-old" }).sessionId;
  const q = request(root, a),
    cold = await queryProjectGraph(q);
  sameMetadataWrite(path.join(root, `${layout.directory}/sessions/by-id/${b}/current.json`), (value) => value.replace("other-old", "other-new"));
  const warm = await queryProjectGraph({ ...q, previousResult: cold });
  assert.equal(warm.reuse.status, "scoped-originals-reused");
  assert.equal(warm.coverage.unrelatedRecordBytesReverified, false);
  const broad = await queryProjectGraph({ root, query: "other-new", depth: 0, details: true });
  assert.equal(broad.nodes.find((node) => node.nodeId === b).purpose, "other-new");
  assert.notEqual(broad.reuse.status, "scoped-originals-reused");
});

test("hidden review producers are reverified even with zero edges and a cut-off neighbor", async (t) => {
  const { root, layout } = fixture(t),
    proposal = await proposeProductPolicy({ root, operation: "create", key: "synthetic-rule", name: "Synthetic rule", statement: "Keep durable originals" });
  await reviewProductPolicy({ root, candidateId: proposal.candidate.candidateId, disposition: "reject", rationale: "Synthetic review" });
  indexProjectGraph({ root });
  const q = request(root, proposal.candidate.candidateId),
    cold = await queryProjectGraph(q),
    warm = await queryProjectGraph({ ...q, previousResult: cold });
  assert.equal(warm.nodes[0].reviewState, "rejected");
  assert.equal(warm.edges.length, 0);
  const reviewPath = warm.integrity.verifiedRecordPaths.find((p) => p.includes("product-policy") && p.includes("review"));
  assert(reviewPath);
  sameMetadataWrite(path.join(root, reviewPath), (value) => value.replace("Synthetic review", "Tampering review"));
  const broken = await queryProjectGraph({ ...q, previousResult: warm });
  assert(!broken.nodes.some((node) => node.nodeId === proposal.candidate.candidateId));
  assert(broken.integrity.excluded.some((e) => e.layer === "policy"));
  noAuthority(broken);
});

test("new incoming edge from an unread external Session needs rediscovery, never a whole-project claim", async (t) => {
  const { root, layout } = fixture(t),
    b = createHeadSession({ root, purpose: "Initially unrelated" }).sessionId;
  const plan = createWholePlanSnapshot({ root, objective: "Synthetic whole plan", plan: ["Inspect original evidence"] }).artifact;
  indexProjectGraph({ root });
  const q = request(root, plan.wholePlanId, { depth: 1, maxNodes: 10, maxEdges: 10 }),
    cold = await queryProjectGraph(q);
  const file = path.join(root, `${layout.directory}/sessions/by-id/${b}/current.json`),
    state = JSON.parse(fs.readFileSync(file));
  state.currentWholePlanId = plan.wholePlanId;
  fs.writeFileSync(file, JSON.stringify(state));
  const warm = await queryProjectGraph({ ...q, previousResult: cold });
  assert.equal(warm.reuse.status, "scoped-originals-reused");
  assert.equal(warm.reuse.wholeProjectCurrent, false);
  assert(!warm.edges.some((e) => e.from === b));
  assert.equal(warm.sourceFallback.needed, true);
  assert.equal(warm.coverage.relationScope, "retained-discovery-relations-with-original-producers-reverified");
  const broad = await queryProjectGraph({ root, query: "Synthetic whole plan", depth: 1, details: true });
  assert(broad.edges.some((e) => e.from === b && e.to === plan.wholePlanId));
  indexProjectGraph({ root });
  const refreshed = await queryProjectGraph(q);
  assert(refreshed.edges.some((e) => e.from === b && e.to === plan.wholePlanId));
  noAuthority(warm);
  noAuthority(refreshed);
});

test("Run status and legacy default owner are hidden byte dependencies, not display-only proof", async (t) => {
  const { root, layout } = fixture(t),
    a = createHeadSession({ root, purpose: "selected Run" }).sessionId;
  const currentFile = path.join(root, `${layout.directory}/sessions/by-id/${a}/current.json`),
    state = JSON.parse(fs.readFileSync(currentFile));
  const runId = "run-1234567890-abcdef",
    runDir = path.join(root, `${layout.directory}/sessions/runs/${runId}`);
  fs.mkdirSync(runDir, { recursive: true });
  state.activeRunId = runId;
  fs.writeFileSync(currentFile, JSON.stringify(state));
  const project = JSON.parse(fs.readFileSync(path.join(root, layout.directory, "project.json")));
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ schemaVersion: 1, projectId: project.projectId, runId, status: "active" }));
  indexProjectGraph({ root });
  const q = request(root, a, { depth: 1, maxNodes: 5, maxEdges: 5 }),
    cold = await queryProjectGraph(q),
    warm = await queryProjectGraph({ ...q, previousResult: cold });
  assert.equal(warm.reuse.status, "scoped-originals-reused");
  assert(warm.integrity.verifiedRecordPaths.includes(`${layout.directory}/sessions/current.json`));
  assert(warm.integrity.verifiedRecordPaths.includes(`${layout.directory}/sessions/runs/${runId}/run.json`));
  sameMetadataWrite(path.join(runDir, "run.json"), (value) => value.replace('"active"', '"failed"'));
  const failed = await queryProjectGraph({ ...q, previousResult: warm });
  assert.equal(failed.nodes.find((n) => n.nodeId === runId).status, "failed");
  const defaultFile = path.join(root, layout.directory, "sessions/current.json"),
    defaultState = JSON.parse(fs.readFileSync(defaultFile));
  defaultState.sessionId = a;
  fs.writeFileSync(defaultFile, JSON.stringify(defaultState));
  const moved = await queryProjectGraph({ ...q, previousResult: failed });
  assert.equal(moved.nodes.find((n) => n.nodeId === runId).sessionId, a);
  noAuthority(moved);
});

test("selected source bytes and absence preserve retained evidence without authorizing effects", async (t) => {
  const { root, layout } = fixture(t),
    file = path.join(root, "module.mjs");
  fs.writeFileSync(file, "export const answer = 42;\n");
  await prepareSourceContext({ root, task: "Synthetic source", needs: [{ kind: "source", path: "module.mjs" }], retain: true });
  const seed = await queryProjectGraph({ root, query: "module.mjs", details: true }),
    observation = seed.nodes.find((n) => n.kind === "ObservationRecord");
  assert(observation);
  const q = request(root, observation.nodeId, { depth: 2, maxNodes: 10, maxEdges: 10 }),
    cold = await queryProjectGraph(q);
  assert.equal((await queryProjectGraph(q)).reuse.status, "scoped-originals-reused");
  sameMetadataWrite(file, (value) => value.replace("42", "99"));
  const changed = await queryProjectGraph({ ...q, previousResult: cold });
  assert(changed.nodes.some((n) => n.freshness === "historical-source-bytes"));
  fs.unlinkSync(file);
  const absent = await queryProjectGraph(q);
  assert(absent.nodes.some((n) => n.freshness === "unavailable"));
  noAuthority(absent);
});

test("index tamper/deletion, forged previous, external membership and two Session hooks fall back without a gate", async (t) => {
  const { root, layout } = fixture(t),
    a = createHeadSession({ root, purpose: "owned selected" }).sessionId,
    q = request(root, a),
    cold = await queryProjectGraph(q);
  const forged = await queryProjectGraph({ ...q, previousResult: { ...cold, nodes: [{ nodeId: "forged", promotionAuthority: true }] } });
  assert(!forged.nodes.some((n) => n.nodeId === "forged"));
  noAuthority(forged);
  const file = path.join(root, layout.directory, "graph-discovery/index.json"),
    index = JSON.parse(fs.readFileSync(file));
  index.projectId = "head-" + "0".repeat(20);
  fs.writeFileSync(file, JSON.stringify(index));
  const tampered = await queryProjectGraph(q);
  assert.equal(tampered.nodes[0].nodeId, a);
  assert.notEqual(tampered.reuse.status, "scoped-originals-reused");
  fs.unlinkSync(file);
  assert.equal((await queryProjectGraph(q)).nodes[0].nodeId, a);
  const [b, c] = await Promise.all([
    Promise.resolve().then(() => createHeadSession({ root, purpose: "parallel B" })),
    Promise.resolve().then(() => createHeadSession({ root, purpose: "parallel C" })),
  ]);
  const refreshed = JSON.parse(fs.readFileSync(file));
  for (const s of [b, c]) assert(refreshed.entries.some((e) => e.path.includes(s.sessionId)));
  await queryProjectGraph(q);
  const warm = await queryProjectGraph(q);
  assert.equal(warm.reuse.status, "scoped-originals-reused");
  const dir = path.join(root, layout.directory, "sessions/by-id/session-00000000-0000-4000-8000-000000000001");
  fs.mkdirSync(dir);
  const external = {
    ...JSON.parse(fs.readFileSync(path.join(root, `${layout.directory}/sessions/by-id/${b.sessionId}/current.json`))),
    sessionId: path.basename(dir),
    purpose: "external",
  };
  fs.writeFileSync(path.join(dir, "current.json"), JSON.stringify(external));
  const direct = await queryProjectGraph(request(root, external.sessionId));
  assert.equal(direct.nodes[0].purpose, "external");
  const changed = await queryProjectGraph({ ...q, previousResult: warm });
  assert.notEqual(changed.reuse.status, "scoped-originals-reused");
  noAuthority(changed);
});

test("World and path/ranked queries retain full original-backed discovery; connected zero-edge bounds work", async (t) => {
  const { root, layout } = fixture(t);
  fs.writeFileSync(path.join(root, "module.mjs"), "export function value() { return 42; }\n");
  const world = await buildWorldModel({ root }),
    graph = world.snapshot.temporalProvenanceGraph;
  const file = graph.nodes.find((n) => n.kind === "File"),
    q = request(root, file.nodeId, { depth: 3 });
  const first = await queryProjectGraph(q),
    second = await queryProjectGraph({ ...q, previousResult: first });
  assert.deepEqual(second.edges, []);
  assert.notEqual(second.reuse.status, "scoped-originals-reused");
  assert.equal((await call(root, { anchor_ids: [file.nodeId], depth: 3, max_edges: 0 })).error, undefined);
  assert.notEqual((await queryProjectGraph({ root, paths: [file.path] })).reuse.status, "scoped-originals-reused");
});

test("warm costs count sync/async reads including index bytes; unrelated Session bodies are not read", async (t) => {
  const { root, layout } = fixture(t);
  let selected;
  for (let i = 0; i < 30; i++) {
    const s = createHeadSession({ root, purpose: `Synthetic ${i}` }).sessionId;
    selected ||= s;
  }
  const q = request(root, selected),
    cold = await queryProjectGraph(q);
  const originals = { sync: fs.readFileSync, async: fsp.readFile },
    reads = [];
  const record = (file, value, mode) => {
    if (typeof file === "string" && path.resolve(file).startsWith(root + path.sep))
      reads.push({ path: path.relative(root, file).replaceAll("\\", "/"), bytes: Buffer.byteLength(value), mode });
    return value;
  };
  fs.readFileSync = function (file, ...args) {
    return record(file, originals.sync.call(this, file, ...args), "sync");
  };
  fsp.readFile = async function (file, ...args) {
    return record(file, await originals.async.call(this, file, ...args), "async");
  };
  syncBuiltinESMExports();
  let warm;
  try {
    warm = await queryProjectGraph({ ...q, previousResult: cold });
  } finally {
    fs.readFileSync = originals.sync;
    fsp.readFile = originals.async;
    syncBuiltinESMExports();
  }
  assert.equal(warm.reuse.status, "scoped-originals-reused");
  assert.deepEqual(warm.nodes, cold.nodes);
  assert.deepEqual(warm.edges, cold.edges);
  assert(reads.some((read) => read.path === `${layout.directory}/graph-discovery/index.json`));
  assert(reads.filter((read) => read.path.startsWith(`${layout.directory}/sessions/by-id/`)).every((read) => read.path.includes(selected)));
  t.diagnostic(
    JSON.stringify({
      calls: reads.length,
      bytes: reads.reduce((n, r) => n + r.bytes, 0),
      indexBytes: reads.filter((r) => r.path.endsWith("graph-discovery/index.json")).reduce((n, r) => n + r.bytes, 0),
      reads,
    }),
  );
});
