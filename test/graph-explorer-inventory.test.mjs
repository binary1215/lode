import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { collectGraphExplorerInventory, queryProjectGraph } from "../scripts/lib/project-graph.mjs";
import { buildWorldModel, inspectWorldDomainFreshness } from "../scripts/lib/world-model.mjs";
import { LocalJsonWorldModelStoreAdapter } from "../scripts/lib/world-model-store.mjs";
import { explorerFixture } from "./helpers/graph-explorer-fixture.mjs";
import { snapshot } from "./helpers/session-work-linkage-fixture.mjs";

test("viewer collection retains complete verified topology beyond conversational bounds without writes or a limit-disabling query flag", async t => {
  const f = await explorerFixture(t);
  for (let file = 0; file < 7; file++) fs.writeFileSync(path.join(f.root, `src/generic-${file}.mjs`),
    Array.from({ length: 100 }, (_, i) => `export function generic${file}_${i}() { return ${i ? `generic${file}_${i - 1}()` : "1"}; }`).join("\n"));
  await buildWorldModel({ root: f.root });
  const before = snapshot(f.base), storeAdapter = new LocalJsonWorldModelStoreAdapter({ projectRoot: f.root, storage: f.storage });
  const full = await collectGraphExplorerInventory({ root: f.root, query: "generic", storeAdapter });
  assert(full.nodes.length > 500); assert(full.edges.length > 1000);
  assert.equal(full.coverage.verifiedNodeCount, full.nodes.length);
  const world = (await inspectWorldDomainFreshness({ root: f.root, storeAdapter }));
  const edgeIds = new Set(full.edges.map(edge => edge.edgeId));
  for (const edge of world.snapshot.temporalProvenanceGraph.edges) assert(edgeIds.has(edge.edgeId));
  assert.equal(full.basis.projectId, f.projectId); assert.equal(full.authority.instructionAuthority, false);
  assert(full.structural.graph.nodes.length > 500); assert(full.detailSelection.nodes.length <= 60);
  const ordinary = await queryProjectGraph({ root: f.root, query: "generic", details: true, viewerInventory: true, storeAdapter });
  assert(ordinary.nodes.length <= 60); assert(ordinary.edges.length <= 120);
  await assert.rejects(((queryProjectGraph({ root: f.root, maxNodes: 501 }))), { code: "INVALID_PROJECT_GRAPH_BOUND" });
  assert.deepEqual(snapshot(f.base), before);
});

test("viewer retains non-current typed edges without making them current or weakening ordinary discovery", async t => {
  const f = await explorerFixture(t), file = path.join(f.root, "src/relay.mjs");
  fs.appendFileSync(file, "\n// Current source differs from the retained snapshot\n");
  const before = snapshot(f.base), storeAdapter = new LocalJsonWorldModelStoreAdapter({ projectRoot: f.root, storage: f.storage });
  const full = await collectGraphExplorerInventory({ root: f.root, storeAdapter });
  const nonCurrent = full.edges.filter(edge => edge.currentTraversalEligible === false);
  assert(nonCurrent.length > 0); assert(nonCurrent.every(edge => edge.viewerCurrentness === "domain-not-current"));
  assert.notEqual(full.structural.freshness.domains.code.status, "current");
  const ordinary = await queryProjectGraph({ root: f.root, details: true, storeAdapter });
  const selected = new Set(ordinary.edges.map(edge => edge.edgeId));
  assert(nonCurrent.every(edge => !selected.has(edge.edgeId)));
  assert.deepEqual(snapshot(f.base), before);
});
