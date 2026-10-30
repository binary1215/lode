import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, snapshot, sha, pluginRoot } from "./helpers/session-work-linkage-fixture.mjs";
import { explorerFixture } from "./helpers/graph-explorer-fixture.mjs";
import { explorerDom } from "./helpers/graph-explorer-dom-fixture.mjs";
import { inspectProject } from "../scripts/lib/lode-core.mjs";
import { inspectProjectExperience } from "../scripts/lib/project-bootstrap.mjs";
import { resumeProjectLocation } from "../scripts/lib/project-relocation.mjs";
import { createSessionCallContext } from "../scripts/lib/session-routing.mjs";
import { createNativeSessionHostBridge } from "../scripts/lib/session-native-host.mjs";
import { buildAttentionProjection } from "../scripts/lib/experience-projection.mjs";
import { buildGraphExplorerSnapshot, exportGraphExplorer } from "../scripts/lib/graph-explorer.mjs";
import { queryProjectGraph } from "../scripts/lib/project-graph.mjs";
import { formatCliResult, formatProjectStatus } from "../scripts/lib/cli-presentation.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { catalogTools, tools, dispatch } from "../scripts/mcp-server.mjs";

const request = (root, args = {}) => ({ id: "synthetic-status", method: "tools/call", params: {
  name: "lode_project_status", arguments: { project_root: root, ...args }, _meta: { threadId: "synthetic-read-only-status" } } });

test("search filters results/overview without hiding selected eligible context or bypassing evidence scope", () => {
  const data = { kind: "GraphExplorerSnapshot", project: { projectId: "synthetic" }, graph: {
    nodes: [{ nodeId: "alpha", kind: "File", name: "Alpha", views: ["work"] }, { nodeId: "beta", kind: "File", name: "Beta", views: ["work"] },
      { nodeId: "old", kind: "File", name: "Old", historical: true, views: ["work"] }],
    edges: [{ from: "alpha", to: "beta", type: "IMPORTS" }, { from: "alpha", to: "old", type: "OLD" }], initialNodeId: "alpha" },
    codeGraph: { nodes: [], edges: [] }, originals: {}, history: { entries: [] } };
  const before = JSON.stringify(data), ui = explorerDom(data);
  const drawn = () => ui.ids.get("graph").children.map(node => node.getAttribute("data-node")).filter(Boolean);
  for (const query of ["Beta", "no-such-record"]) {
    ui.ids.get("search").value = query; ui.event("search", "input");
    assert.equal(ui.ids.get("records").children.length, query === "Beta" ? 1 : 0);
    assert(drawn().includes("alpha")); assert(!drawn().includes("old"));
    assert(ui.ids.get("selected-title").textContent.includes("Alpha"));
    assert(!/-\d+ off-screen/.test(ui.ids.get("status").textContent));
  }
  ui.ids.get("axis").value = "context"; ui.event("axis", "change");
  assert.equal(drawn().length, 0);
  assert.match(ui.ids.get("status").textContent, /Selected record is hidden by current filters/);
  ui.event("restore-scope");
  assert(drawn().includes("alpha"));
  assert(ui.ids.get("selected-title").textContent.includes("Alpha"));
  assert.equal(ui.ids.get("include-history").checked, false);
  ui.ids.get("axis").value = "all"; ui.event("axis", "change");
  ui.ids.get("view").value = "product"; ui.event("view", "change"); assert.equal(drawn().length, 0);
  ui.ids.get("view").value = "all"; ui.event("view", "change"); assert(drawn().includes("alpha"));
  assert.equal(JSON.stringify(data), before);
});

test("MCP human descriptions and attention labels use Lode without rewriting wire identity", async () => {
  const walk = value => {
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (["description", "title"].includes(key) && typeof entry === "string") assert.doesNotMatch(entry, /\bHEAD\b/);
      else walk(entry);
    }
  };
  walk(catalogTools); walk(tools);
  const managed = tools.find(tool => tool.name === "lode_tools_call");
  assert.deepEqual(managed.inputSchema.properties.execution_mode.enum, ["ordinary", "managed"]);
  const contract = await dispatch({ id: 1, method: "tools/call", params: { name: "head_core_contract", arguments: {} } });
  assert(!contract.error); // Compatibility operation name remains accepted.
  const attention = buildAttentionProjection({ readiness: { core: { state: "not_initialized" } } });
  assert.equal(attention.items[0].owner, "HEAD"); assert.equal(attention.items[0].ownerLabel, "Lode");
  assert.doesNotMatch(attention.items[0].summary, /\bHEAD\b/);
});

test("copied and interrupted status is project-only P4, readonly even with explicit/lost/native context", async t => {
  const f = fixture(t);
  const guide = (await inspectProjectExperience({ root: f.root }));
  for (const capability of guide.capabilities) if (typeof capability.entrypoint === "string") assert.doesNotMatch(capability.entrypoint, /\bHEAD\b/);
  for (const stage of [null, "project", "manifest"]) {
    const root = path.join(f.base, `copy-${stage ?? "new"}`); fs.cpSync(f.root, root, { recursive: true });
    if (stage) assert.throws(() => resumeProjectLocation({ root, pluginRoot, onPublication(at) { if (at === stage) throw Error("synthetic interruption"); } }));
    const context = createSessionCallContext(); context.lose(root);
    const before = snapshot(f.base), expected = stage ? "relocation_pending" : "relocation_available";
    assert.equal((await inspectProjectExperience({ root })).status, expected);
    for (const argv of [["status", root], ["doctor", root, "--session", f.session.sessionId]]) {
      const result = await runCommand(argv, { sessionContext: context });
      assert.equal(result.status, expected); assert.equal(result.retainedProject.projectId, f.owner.project.projectId);
      assert.equal(result.selectedSession.status, "not-inspected"); assert.equal(result.selectedSession.selectionClaimed, false);
      assert.equal(result.ordinaryWorkBlocked, false); assert.equal(result.authority.writesRecoveryDirection, false);
      const text = formatProjectStatus(result);
      assert.doesNotMatch(text, /Initialize|Lode is ready|No recovery checkpoint|\bHEAD\b/);
      assert.match(text, /not inspected or restored/);
    }
    let bindingReads = 0;
    const response = await dispatch(request(root), { sessionContext: context, resolveSessionContext() { bindingReads++; throw Error("must not resolve binding"); } });
    assert.equal(response.result.structuredContent.status, expected); assert.equal(bindingReads, 0);
    const native = createNativeSessionHostBridge({ runtime: "codex", environment: { HEAD_AGENT_OPERATIONAL_STATE_ROOT: f.operational } });
    const result = await dispatch(request(root), { nativeSessionBridge: native });
    assert.equal(result.result.structuredContent.status, expected);
    const exact = await dispatch(request(root, { session_id: f.session.sessionId }), { sessionContext: context });
    assert.equal(exact.result.structuredContent.selectedSession.selectionClaimed, false);
    const invalid = await dispatch(request(root, { session_id: "session-foreign" })); assert(invalid.error || invalid.result?.isError);
    assert.equal(context.read(root).status, "lost"); assert.deepEqual(snapshot(f.base), before);
    if (!stage) assert.equal(inspectProject(root).status, "not_initialized");
  }
  const lost = createSessionCallContext(); lost.lose(f.root);
  const normal = (await runCommand(["status", f.root], { sessionContext: lost }));
  assert.equal(normal.status, "session_selection_unresolved"); assert(!normal?.then, "normal-root diagnostics stay synchronous");
});

test("tampered copied metadata remains an integrity failure, not relocation or new initialization advice", async t => {
  const f = fixture(t), root = path.join(f.base, "tampered"); fs.cpSync(f.root, root, { recursive: true });
  const project = path.join(root, ".lode/project.json"), value = JSON.parse(fs.readFileSync(project));
  value.authority.lode = "foreign"; fs.writeFileSync(project, JSON.stringify(value));
  const before = snapshot(f.base); (await assert.rejects(async () => (await inspectProjectExperience({ root })))); assert.deepEqual(snapshot(f.base), before);
});

test("shared metadata omits generated host paths but retains exact evidence and every exported ID", async t => {
  const f = await explorerFixture(t), before = snapshot(f.root);
  const normal = await buildGraphExplorerSnapshot({ root: f.root, query: "relay" });
  const shared = await buildGraphExplorerSnapshot({ root: f.root, query: "relay", share: true });
  assert.equal(normal.project.root, f.root); assert(normal.regenerate.argv.includes(process.execPath));
  assert.equal(shared.project.root, undefined); assert.equal(shared.regenerate.argv, undefined);
  assert.equal(shared.metadataPolicy.anonymized, false);
  assert.deepEqual(shared.graph.nodes.map(node => node.nodeId), normal.graph.nodes.map(node => node.nodeId));
  assert.deepEqual(shared.graph.edges.map(edge => edge.edgeId), normal.graph.edges.map(edge => edge.edgeId));
  assert.deepEqual(shared.originals, normal.originals);
  for (const node of shared.graph.nodes) assert.equal(node.originalExpansion?.arguments?.project_root, undefined);
  const file = path.join(f.base, "shared.html"), result = await runCommand(["graph-explorer", f.root, "--share", "--output", file]);
  const html = fs.readFileSync(file, "utf8"); assert.equal(result.bytes, Buffer.byteLength(html));
  assert.equal(Number(html.match(/HTML size: (\d+) bytes/)[1]), result.bytes);
  assert.match(html, /not anonymization/); assert(result.advisories.length); assert.equal(result.ordinaryWorkBlocked, false);
  assert.deepEqual(snapshot(f.root), before);
  await assert.rejects(((exportGraphExplorer({ root: f.root, share: "yes", output: path.join(f.base, "invalid.html") }))), { code: "GRAPH_EXPLORER_INVALID_SHARE_OPTION" });
  assert.equal(fs.existsSync(path.join(f.base, "invalid.html")), false);
  const empty = path.join(f.base, "empty-target"); fs.mkdirSync(empty);
  const absent = await buildGraphExplorerSnapshot({ root: empty });
  assert.equal(absent.project, null); assert.equal(absent.graph.nodes.length, 0); assert.equal(absent.codeGraph.nodes.length, 0);
  assert(absent.unavailable.includes("PROJECT_GRAPH_NOT_INITIALIZED")); assert.deepEqual(fs.readdirSync(empty), []);
});

test("explicit target Projects remain separate from plugin executable/cwd, with honest missing layers", async t => {
  const a = fixture(t, "APP_A_ORDER_PROCESSING"), b = fixture(t, "APP_B_WEATHER_SERVICE");
  a.save({ summary: "APP_A_ORDER_PROCESSING" }); b.save({ summary: "APP_B_WEATHER_SERVICE" });
  const initial = [snapshot(a.root), snapshot(b.root)], started = performance.now(), timings = [];
  for (const [f, own, other] of [[a, "APP_A_ORDER_PROCESSING", "APP_B_WEATHER_SERVICE"], [b, "APP_B_WEATHER_SERVICE", "APP_A_ORDER_PROCESSING"]]) {
    for (const details of [false, true]) {
      const at = performance.now(), result = await runCommand(["graph-query", f.root, "--query", own, "--details", String(details)]);
      timings.push({ details, ms: performance.now() - at });
      assert.equal(result.basis.projectId, f.owner.project.projectId); assert(!JSON.stringify(result).includes(other));
    }
    const graph = await buildGraphExplorerSnapshot({ root: f.root, query: own });
    assert.equal(graph.project.projectId, f.owner.project.projectId); assert(JSON.stringify(graph).includes(own));
    assert(!JSON.stringify(graph).includes(other)); assert.equal(graph.codeGraph.status, "unavailable");
    assert(!graph.codeGraph.nodes.length); // No fallback to plugin installation code.
  }
  assert.deepEqual([snapshot(a.root), snapshot(b.root)], initial);
  t.diagnostic(JSON.stringify({ scope: "Two tiny synthetic Core-only Projects; no GUI or 7.5s workload claim", runnerCwd: process.cwd(), pluginRoot, elapsedMs: performance.now() - started, timings }));
});

test("missing current citation is currently absent, not an inferred deletion, rename or empty diff", async t => {
  const f = fixture(t), source = "export function action() { return 1; }\n";
  fs.mkdirSync(path.join(f.root, "src")); const file = path.join(f.root, "src/action.mjs"); fs.writeFileSync(file, source);
  const saved = f.save({ summary: "Inspect action", references: [{ kind: "source", path: "src/action.mjs", digest: sha(source) }] });
  fs.unlinkSync(file); const before = snapshot(f.root);
  const graph = await queryProjectGraph({ root: f.root, paths: ["src/action.mjs"], details: true, depth: 3 });
  const recorded = graph.contextLineage.files.find(item => item.path === "src/action.mjs");
  assert.equal(recorded.currentObservation.status, "current-path-not-found");
  assert.equal(recorded.currentObservation.deletionEstablished, false); assert.equal(recorded.currentObservation.renameEstablished, false);
  assert.match(recorded.currentObservation.explanation, /does not establish deletion, rename/);
  // An exact citation now permits a bounded local-history lookup. This non-Git
  // fixture retains an explicit gap, never invented historical bytes or a diff.
  assert.equal(recorded.comparisons.length, 1);
  const comparison = recorded.comparisons[0];
  assert.equal(comparison.status, "unknown"); assert.equal(comparison.reasonCode, "EXACT_SOURCE_PAIR_UNAVAILABLE");
  assert.equal(comparison.before, null); assert.equal(comparison.after, null);
  assert.equal(comparison.diff, undefined); assert.equal(comparison.retainedOriginal, undefined);
  assert.deepEqual(comparison.symbols, []); assert.equal(comparison.citedReference.digest, sha(source));
  assert.equal(comparison.gap.reasonCode, "LOCAL_GIT_NOT_A_REPOSITORY");
  // Metadata discovery now establishes the non-Git gap before launching Git.
  // Keep the unknown/no-diff assertions above and the zero-write check below.
  assert.equal(graph.contextLineage.sourceReads.localGitCommands, 0);
  assert.equal(graph.contextLineage.sourceReads.writes, false);
  assert.match(formatCliResult("graph-query", graph).replace(/\s*\|\s*/g, " ").replace(/\s+/g, " "), /does not establish deletion, rename/);
  const snapshotView = await buildGraphExplorerSnapshot({ root: f.root, query: "src/action.mjs" });
  snapshotView.graph.initialNodeId = saved.evidence.evidenceId;
  const ui = explorerDom(snapshotView); assert.match(ui.ids.get("context-lineage-body").textContent, /does not establish deletion, rename/);
  assert.deepEqual(snapshot(f.root), before);
});
