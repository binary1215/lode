import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";
import { createWholePlanSnapshot } from "../scripts/lib/execution-lineage.mjs";
import { proposeProductPolicy } from "../scripts/lib/product-policy.mjs";
import { updateProjectDirection, readProjectDirection } from "../scripts/lib/project-direction.mjs";
import { queryProjectGraph } from "../scripts/lib/project-graph.mjs";
import { buildWorldModel, readWorldModelForDiscovery, inspectWorldDomainFreshness, buildWorldTraversalEligibility } from "../scripts/lib/world-model.mjs";
import { InMemoryGraphProjectionAdapter, materializeGraphProjection } from "../scripts/lib/graph-projection-adapter.mjs";
import { projectGraphDigest } from "../scripts/lib/discovery-index.mjs";
import { runCommand } from "../scripts/head.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");

test("literal code identifiers precede repeated document headings without excluding documents or reviving stale code", async t => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/delivery.mjs"), "export function resolveDelivery() { return 1; }\nexport function get() { return 2; }\nexport function CacheRelay() { return 3; }\n");
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(root, `delivery-${i}.md`), "# resolveDelivery implementation\nDesign reference.\n");
  fs.writeFileSync(path.join(root, "onboarding.md"), "# How do I get onboarding done?\n");
  const reasonPlan = createWholePlanSnapshot({ root, objective: "The reason we chose CacheRelay is preserving pending work", plan: ["Keep exact reasons"] }).artifact;
  await buildWorldModel({ root });
  for (const query of ["resolveDelivery", "`resolveDelivery`", "resolveDelivery()"]) {
    const result = await queryProjectGraph({ root, query, depth: 0, maxNodes: 60 });
    assert.equal(result.nodes[0].path, "src/delivery.mjs");
    assert(result.nodes.some(node => node.path?.endsWith(".md")), "Matching documentation stays eligible");
    safe(result);
  }
  const documents = await queryProjectGraph({ root, query: "implementation", depth: 0, maxNodes: 60 });
  assert(documents.nodes[0].path.endsWith(".md"), "No unconditional code-kind preference");
  for (const query of ["How do I get onboarding done?", "How do I `get` onboarding done?"]) {
    const onboarding = await queryProjectGraph({ root, query, depth: 0, maxNodes: 60 });
    assert.equal(onboarding.nodes[0].path, "onboarding.md", "A common word or its typography is not a code selector");
  }
  for (const query of ["What is the reason we chose CacheRelay?", "What is the reason we chose `CacheRelay`?"]) {
    const reasons = await queryProjectGraph({ root, query, depth: 0, maxNodes: 60 });
    assert.equal(reasons.nodes[0].nodeId, reasonPlan.wholePlanId, "Reason questions keep their original ranking");
  }
  const filtered = await queryProjectGraph({ root, query: "resolveDelivery", paths: ["delivery-0.md"], depth: 0, maxNodes: 60 });
  assert(filtered.nodes.length > 0); assert(filtered.nodes.every(node => node.path === "delivery-0.md"));
  fs.appendFileSync(path.join(root, "src/delivery.mjs"), "// Later source drift\n");
  const stale = await queryProjectGraph({ root, query: "resolveDelivery implementation", depth: 0, maxNodes: 60 });
  const observed = (await inspectWorldDomainFreshness({ root }));
  assert.equal(observed.freshness.domains.code.status, "stale");
  const eligible = new Set(buildWorldTraversalEligibility(observed.snapshot, observed.freshness.domains).nodeIds);
  for (const node of stale.nodes.filter(node => node.origin?.layer === "world")) assert(eligible.has(node.nodeId),
    "Ranking cannot revive an excluded original; eligible historical evidence remains navigable");
});
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "head-retrieval-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  const layout = formatForVerifiedOwner(storage);
  return { root, storage, layout };
}
function originals(root, layout) {
  const files = {};
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else files[next] = projectGraphDigest(fs.readFileSync(path.join(root, next)));
    }
  }
  walk(layout.directory); return files;
}
function safe(result) {
  for (const item of [result.authority, ...result.nodes, ...result.edges]) {
    for (const field of ["instructionAuthority", "promotionAuthority", "recoveryAuthority", "executionAuthority"]) assert.equal(item[field], false);
  }
  assert.equal(result.authority.ordinaryWorkBlocked, false);
  assert.equal(result.coverage.semanticSufficiency, "HEAD-owned");
}

test("natural questions rank domain evidence ahead of boilerplate, without a relevance gate", async t => {
  const { root, layout } = fixture(t);
  for (let i = 0; i < 70; i++) await proposeProductPolicy({ root, operation: "create", key: `spacing-${i}`,
    name: `ThemeSpacing${i}`, statement: "The reason we chose the display spacing is readability." });
  const target = createWholePlanSnapshot({ root, objective: "CacheRelay preserves unsent requests during disconnected restarts.", plan: ["Retain pending requests"] }).artifact;
  const before = originals(root, layout);
  const compact = await queryProjectGraph({ root, query: "What is the reason we chose CacheRelay?" });
  const detailed = await queryProjectGraph({ root, query: "What is the reason we chose CacheRelay?", details: true });
  assert.equal(compact.nodes[0].nodeId, target.wholePlanId);
  assert.equal(compact.nodes.length, 8);
  assert.equal(detailed.nodes.length, 60);
  assert(Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(detailed)) / 4);
  assert.equal(compact.coverage.verifiedNodeCount, detailed.coverage.verifiedNodeCount);
  assert.equal(compact.omittedMatchCount, detailed.omittedMatchCount + 52);
  for (const selected of compact.nodes) {
    const expanded = await queryProjectGraph({ root, ...selected.detail });
    const original = expanded.nodes[0];
    assert.equal(original.nodeId, selected.nodeId);
    assert.equal(original.revisionId, selected.revisionId);
    assert.equal(original.reviewState, selected.reviewState);
    assert.equal(original.freshness, selected.freshness);
    assert.deepEqual(original.sourceReference, selected.sourceReference);
    assert.equal(expanded.query.details, true);
  }
  assert.equal(compact.nodes[0].objective, undefined);
  assert.equal(detailed.nodes[0].objective, target.objective);
  assert(compact.nodes[0].excerpt.includes("CacheRelay"));
  assert.deepEqual(originals(root, layout), before);
  for (const query of ["What is the reason we chose CacheRelay?", "What is the reason we chose cacherelay?", "What is the reason we chose CACHERELAY?", "CacheRelay를 유지하는 이유는?", "CacheRelay?", "cache relay"]) {
    for (const maxNodes of [1, 60]) {
      const result = await queryProjectGraph({ root, query, maxNodes, maxEdges: 1, depth: 0 });
      assert.equal(result.nodes[0]?.nodeId, target.wholePlanId, query);
      safe(result);
      const repeated = await queryProjectGraph({ root, query, maxNodes, maxEdges: 1, depth: 0, previousResult: result });
      assert.equal(result.resultId, repeated.resultId);
      assert.equal(repeated.reuse.status, "same-basis-result-reused");
    }
  }
  const missing = await queryProjectGraph({ root, query: "UnseenNebulaCode", depth: 0 });
  assert.equal(missing.nodes.length, 0);
  assert.equal(missing.coverage.emptyResultProvesAbsence, false);
  const exact = await queryProjectGraph({ root, query: "UnseenNebulaCode", anchorIds: [target.wholePlanId], depth: 0 });
  assert.equal(exact.nodes[0].nodeId, target.wholePlanId);
  assert.deepEqual(originals(root, layout), before);
});

test("metadata keys are not query evidence; short words and Korean names remain discoverable", async t => {
  const { root, layout } = fixture(t);
  const first = createWholePlanSnapshot({ root, objective: "IS checks and 오프라인큐 preserve local requests", plan: ["Inspect the comparison"] }).artifact;
  for (const query of ["IS", "오프라인큐는?", "오프라인큐의 이유는?"]) {
    const result = await queryProjectGraph({ root, query, depth: 0 });
    assert(result.nodes.some(node => node.nodeId === first.wholePlanId), query);
  }
  for (const query of ["instructionAuthority", "retained-evidence", "sourceReference", "schemaVersion"]) {
    assert.equal((await queryProjectGraph({ root, query, depth: 0 })).nodes.length, 0, query);
  }
});

test("current and historical common direction expose all bounded fields without P2 mutation", async t => {
  const { root, layout } = fixture(t);
  const old = updateProjectDirection({ root, expectedDirectionId: null, input: { goal: "Document flow", constraints: ["AirGapBoundary"], decisions: ["RetentionChoice"], cancelledActions: ["UploadCancelled"] } }).direction;
  const current = updateProjectDirection({ root, expectedDirectionId: old.directionId, input: { goal: "Document flow", constraints: ["LocalBoundary"], decisions: [], cancelledActions: ["ExternalCancelled"] } }).direction;
  const before = originals(root, layout);
  for (const [query, direction, freshness] of [["AirGapBoundary", old, "historical-direction-reference"], ["RetentionChoice", old, "historical-direction-reference"], ["UploadCancelled", old, "historical-direction-reference"], ["LocalBoundary", current, "current-direction-reference"]]) {
    const result = await queryProjectGraph({ root, query, depth: 0, details: true });
    const node = result.nodes.find(node => node.nodeId === direction.directionId);
    assert(node, query);
    assert.deepEqual(node.directionEvidence, direction.input);
    assert.equal(node.freshness, freshness);
    assert.equal(node.revisionId, direction.directionId);
    assert(node.sourceReference.path.includes("/revisions/"));
    assert.equal(result.summary.directionReferences[0].freshness, freshness);
    safe(result);
  }
  assert.deepEqual(readProjectDirection({ root }), current);
  assert.deepEqual(originals(root, layout), before);
});

test("direction excerpts disclose truncation and keep full originals accessible", async t => {
  const { root, layout } = fixture(t);
  const direction = updateProjectDirection({ root, expectedDirectionId: null, input: { goal: "G".repeat(3000), constraints: Array.from({ length: 40 }, (_, i) => `Constraint${i} ` + "x".repeat(700)), decisions: [], cancelledActions: [] } }).direction;
  const before = originals(root, layout);
  const result = await queryProjectGraph({ root, anchorIds: [direction.directionId], depth: 0, details: true });
  const node = result.nodes[0];
  assert.equal(node.directionEvidence.goal.length, 2048);
  assert.equal(node.directionEvidence.constraints.length, 32);
  assert.equal(node.directionEvidence.constraints[0].length, 512);
  assert.equal(node.directionContentCoverage.constraints.omittedCount, 8);
  assert.equal(node.directionContentCoverage.partial, true);
  assert.equal(result.sourceFallback.needed, true);
  assert(result.sourceFallback.reasonCodes.includes("PROJECT_DIRECTION_EXCERPT_PARTIAL"));
  assert.deepEqual(readProjectDirection({ root }), direction);
  assert.deepEqual(originals(root, layout), before);
  safe(result);
  const compact = await queryProjectGraph({ root, anchorIds: [direction.directionId], depth: 0 });
  assert.equal(compact.nodes[0].directionEvidence.goal.length, 240);
  assert.equal(compact.nodes[0].directionEvidence.constraints.length, 3);
  assert.equal(compact.nodes[0].directionContentCoverage.partial, true);
  assert.equal(compact.sourceFallback.needed, true);
  assert(compact.sourceFallback.reasonCodes.includes("PROJECT_GRAPH_COMPACT_CONTENT_PARTIAL"));
  assert.equal(compact.nodes[0].sourceReference.path, result.nodes[0].sourceReference.path);
});

async function worldFixture(t) {
  const { root, storage, layout } = fixture(t);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/queue.mjs"), "export function enqueue(value) { return value; }\n");
  fs.writeFileSync(path.join(root, "src/submit.mjs"), "import { enqueue } from './queue.mjs';\nexport function submit(value) { return enqueue(value); }\n");
  fs.writeFileSync(path.join(root, "cli.mjs"), "import { submit } from './src/submit.mjs';\nexport function main(value) { return submit(value); }\n");
  fs.writeFileSync(path.join(root, "decoration.mjs"), "export const decoration = true;\n");
  await buildWorldModel({ root }); return { root, storage, layout };
}

test("paths-only adapter query binds exact verified File anchors and preserves failure reuse", async t => {
  const { root, layout } = await worldFixture(t), before = originals(root, layout);
  let calls = 0;
  class Offline extends InMemoryGraphProjectionAdapter {
    readPointer() { calls++; throw Object.assign(new Error("fixture offline"), { code: "ARCADEDB_UNAVAILABLE" }); }
  }
  const graphProjectionAdapter = new Offline();
  const first = await queryProjectGraph({ root, paths: ["src\\queue.mjs"], graphProjectionAdapter });
  assert.equal(calls, 1);
  assert.equal(first.adapter.fallbackReasonCode, "ARCADEDB_UNAVAILABLE");
  assert(first.nodes.some(node => node.path === "src/queue.mjs"));
  const again = await queryProjectGraph({ root, paths: ["src/queue.mjs"], graphProjectionAdapter });
  assert.equal(calls, 1);
  assert.equal(first.resultId, again.resultId);
  assert.deepEqual(originals(root, layout), before);
  safe(first);
});

test("paths-only verified adapter and local-only selectors are correctly distinguished", async t => {
  const { root, storage, layout } = await worldFixture(t);
  const graph = (await readWorldModelForDiscovery({ root })).snapshot.temporalProvenanceGraph;
  const graphProjectionAdapter = new InMemoryGraphProjectionAdapter();
  (await materializeGraphProjection({ projectRoot: root, storage, graph, adapter: graphProjectionAdapter }));
  const result = await queryProjectGraph({ root, paths: ["src/queue.mjs"], graphProjectionAdapter });
  assert.equal(result.adapter.status, "verified");
  safe(result);
  let calls = 0;
  class Unused extends InMemoryGraphProjectionAdapter { readPointer() { calls++; throw new Error("not expected"); } }
  const unused = new Unused();
  const plan = createWholePlanSnapshot({ root, objective: "Inspect local evidence", plan: ["Read source"] }).artifact;
  for (const selector of [{}, { paths: ["not-in-world.mjs"] }, { anchorIds: [plan.wholePlanId] }]) {
    const local = await queryProjectGraph({ root, ...selector, graphProjectionAdapter: unused });
    assert.equal(local.adapter.status, "not-used");
    assert.equal(local.adapter.fallbackUsed, false);
    assert.equal(local.adapter.reasonCode, "COMBINED_LOCAL_ONLY");
    safe(local);
  }
  assert.equal(calls, 0);
});

test("exact path queries and code impact use existing public CLI/MCP with bounded fallback", async t => {
  const { root, layout } = await worldFixture(t);
  const before = originals(root, layout);
  const cli = await runCommand(["graph-query", root, "--query", "src/queue.mjs", "--max-nodes", "1", "--depth", "0"]);
  assert.equal(cli.nodes[0]?.path, "src/queue.mjs");
  const rpc = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "head_project_graph", arguments: { project_root: root, query: "src/queue.mjs", max_nodes: 1, depth: 0 } } });
  assert(!rpc.error);
  assert.equal(cli.resultId, rpc.result.structuredContent.resultId);
  const impact = await runCommand(["world-query", root, "--query", "enqueue", "--depth", "3", "--limit", "20"]);
  const serialized = JSON.stringify(impact);
  assert(serialized.includes("src/queue.mjs"));
  assert(serialized.includes("src/submit.mjs"));
  assert(serialized.includes("cli.mjs"));
  assert(!serialized.includes("decoration.mjs"));
  assert(serialized.includes("IMPORTS"));
  assert(serialized.includes("CALLS"));
  fs.writeFileSync(path.join(root, "src/queue.mjs"), "export function enqueue(value) { return [value]; }\n");
  const retained = await queryProjectGraph({ root, paths: ["src/queue.mjs"] });
  assert(retained.nodes.some(node => node.freshness === "historical-source-bytes"));
  safe(retained);
  assert.deepEqual(originals(root, layout), before);
});
