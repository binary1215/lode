import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { diffGraphLineage } from "../scripts/lib/graph-lineage.mjs";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";
import { refreshWorldModel } from "../scripts/lib/incremental-refresh.mjs";
import { normalizeProductModelDocument } from "../scripts/lib/product-model.mjs";
import { writeRepositorySourceScope } from "../scripts/lib/repository-source-scope.mjs";
import {
  buildTemporalProvenanceGraph,
  currentTemporalLogicalEntityIds,
  filterRevisionParentsForCurrentTemporalEntities,
} from "../scripts/lib/temporal-provenance.mjs";
import { buildWorldModel, readWorldModel } from "../scripts/lib/world-model.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");

function productModelDocument() {
  return {
    schemaVersion: 1,
    featureGroups: [{ key: "coordination", name: "Coordination", description: "Coordinate one whole outcome." }],
    capabilities: [{ key: "continuity", name: "Continuity", description: "Preserve verified lineage." }],
    features: [{
      key: "head-continuity",
      name: "HEAD continuity",
      description: "Continue from verified project artifacts.",
      featureGroupKeys: ["coordination"],
      capabilityKeys: ["continuity"],
      governedBy: [],
    }],
    requirements: [],
    constraints: [],
    decisions: [],
  };
}

function createProject(t, label) {
  const temporaryRoot = process.env.HEAD_AGENT_TEST_TMP ? path.resolve(process.env.HEAD_AGENT_TEST_TMP) : os.tmpdir();
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporaryRoot, `head-refresh-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  const layout = formatForVerifiedOwner(storage);
  fs.writeFileSync(path.join(root, layout.directory, "context", "product-model.json"), `${JSON.stringify(productModelDocument(), null, 2)}\n`);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  return { root, storage, layout };
}

function authorityBytes(root, layout) {
  return Object.fromEntries([
    `${layout.directory}/project.json`,
    `${layout.directory}/sessions/current.json`,
    `${layout.directory}/context/product-model.json`,
  ].map((relativePath) => [relativePath, fs.readFileSync(path.join(root, ...relativePath.split("/")))]));
}

function currentRevision(graph, kind, predicate) {
  return graph.nodes.find((node) => node.kind === kind && predicate(node));
}

test("refresh drops deleted revision-parent keys while preserving surviving and historical lineage", async (t) => {
  const { root, layout } = createProject(t, "linked-delete");
  fs.writeFileSync(path.join(root, "src", "tokens.py"), [
    "def removed_token():",
    "    return 1",
    "",
    "def surviving_token():",
    "    return 9",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "src", "stable.py"), "def stable_token():\n    return 3\n");
  await buildWorldModel({ root });

  fs.writeFileSync(path.join(root, "src", "tokens.py"), [
    "def removed_token():",
    "    return 2",
    "",
    "def surviving_token():",
    "    return 9",
    "",
  ].join("\n"));
  const evolvedProductModel = productModelDocument();
  evolvedProductModel.features[0].description = "Continue from exact verified project artifacts.";
  fs.writeFileSync(path.join(root, layout.directory, "context", "product-model.json"), `${JSON.stringify(evolvedProductModel, null, 2)}\n`);
  assert.equal((await refreshWorldModel({ root })).status, "refreshed");
  const protectedBefore = authorityBytes(root, layout);
  const beforeDeletion = (await readWorldModel({ root })).snapshot;
  const beforeGraph = beforeDeletion.temporalProvenanceGraph;
  const removedRevision = currentRevision(beforeGraph, "SymbolRevision", (node) => node.name === "removed_token");
  const survivingRevision = currentRevision(beforeGraph, "SymbolRevision", (node) => node.name === "surviving_token");
  const stableRevision = currentRevision(beforeGraph, "FileRevision", (node) => node.path === "src/stable.py");
  const featureRevision = currentRevision(beforeGraph, "FeatureRevision", (node) => node.key === "head-continuity");
  assert.ok(removedRevision);
  assert.ok(survivingRevision);
  assert.ok(stableRevision);
  assert.ok(featureRevision);
  assert.ok(beforeGraph.revisionParentIds[removedRevision.logicalEntityId]?.length > 0);
  assert.ok(beforeGraph.revisionParentIds[featureRevision.logicalEntityId]?.length > 0);

  fs.writeFileSync(path.join(root, "src", "tokens.py"), "def surviving_token():\n    return 10\n");
  const deleted = await refreshWorldModel({ root });
  assert.equal(deleted.status, "refreshed");
  const afterDeletion = (await readWorldModel({ root })).snapshot;
  const afterGraph = afterDeletion.temporalProvenanceGraph;
  assert.equal(afterGraph.nodes.some((node) => node.logicalEntityId === removedRevision.logicalEntityId), false);
  assert.equal(Object.hasOwn(afterGraph.revisionParentIds, removedRevision.logicalEntityId), false);
  const survivingAfter = currentRevision(afterGraph, "SymbolRevision", (node) => node.name === "surviving_token");
  const stableAfter = currentRevision(afterGraph, "FileRevision", (node) => node.path === "src/stable.py");
  const featureAfter = currentRevision(afterGraph, "FeatureRevision", (node) => node.key === "head-continuity");
  assert.deepEqual(survivingAfter.parentRevisionIds, [survivingRevision.nodeId]);
  assert.equal(stableAfter.nodeId, stableRevision.nodeId);
  assert.deepEqual(stableAfter.parentRevisionIds, stableRevision.parentRevisionIds);
  assert.equal(featureAfter.nodeId, featureRevision.nodeId);
  assert.deepEqual(featureAfter.parentRevisionIds, featureRevision.parentRevisionIds);
  assert.ok(afterGraph.parentSourceSnapshotIds.includes(beforeGraph.sourceSnapshotId));

  const lineageDiff = (await diffGraphLineage({
    root,
    fromWorldModelId: beforeDeletion.worldModelId,
    toWorldModelId: afterDeletion.worldModelId,
  }));
  assert.equal(lineageDiff.kind, "GraphLineageDiffProjection");
  assert.ok(lineageDiff.changes.removedNodes.count > 0);
  assert.deepEqual(authorityBytes(root, layout), protectedBefore);

  const unchanged = await refreshWorldModel({ root });
  assert.equal(unchanged.status, "unchanged");
  assert.equal(unchanged.worldModel.worldModelId, afterDeletion.worldModelId);
  assert.deepEqual(authorityBytes(root, layout), protectedBefore);

  const currentWorldModelId = afterDeletion.worldModelId;
  await assert.rejects(((buildWorldModel({
    root,
    expectedWorldModelId: `world-model-${"0".repeat(24)}`,
  }))), { code: "REFRESH_PREVIEW_DRIFT" });
  await assert.rejects(((buildWorldModel({
    root,
    expectedCurrentWorldModelId: `world-model-${"f".repeat(24)}`,
  }))), { code: "REFRESH_POINTER_CONFLICT" });
  assert.equal((await readWorldModel({ root })).snapshot.worldModelId, currentWorldModelId);
});

test("refresh handles linked symbol rename, file deletion, and source-scope exclusion", async (t) => {
  const { root: renameRoot } = createProject(t, "rename");
  fs.writeFileSync(path.join(renameRoot, "src", "rename.py"), "def old_name():\n    return 1\n");
  await buildWorldModel({ root: renameRoot });
  fs.writeFileSync(path.join(renameRoot, "src", "rename.py"), "def old_name():\n    return 2\n");
  await refreshWorldModel({ root: renameRoot });
  const beforeRename = (await readWorldModel({ root: renameRoot })).snapshot.temporalProvenanceGraph;
  const oldRevision = currentRevision(beforeRename, "SymbolRevision", (node) => node.name === "old_name");
  assert.ok(beforeRename.revisionParentIds[oldRevision.logicalEntityId]?.length > 0);
  fs.writeFileSync(path.join(renameRoot, "src", "rename.py"), "def new_name():\n    return 2\n");
  assert.equal((await refreshWorldModel({ root: renameRoot })).status, "refreshed");
  const afterRename = (await readWorldModel({ root: renameRoot })).snapshot.temporalProvenanceGraph;
  assert.equal(Object.hasOwn(afterRename.revisionParentIds, oldRevision.logicalEntityId), false);
  assert.deepEqual(currentRevision(afterRename, "SymbolRevision", (node) => node.name === "new_name").parentRevisionIds, []);

  for (const mode of ["delete-file", "exclude-scope"]) {
    const { root, layout, storage } = createProject(t, mode);
    fs.writeFileSync(path.join(root, "src", "item.py"), "def item():\n    return 1\n");
    fs.writeFileSync(path.join(root, "src", "keep.py"), "def keep():\n    return 1\n");
    await buildWorldModel({ root });
    fs.writeFileSync(path.join(root, "src", "item.py"), "def item():\n    return 2\n");
    await refreshWorldModel({ root });
    const before = (await readWorldModel({ root })).snapshot.temporalProvenanceGraph;
    const itemRevision = currentRevision(before, "FileRevision", (node) => node.path === "src/item.py");
    assert.ok(before.revisionParentIds[itemRevision.logicalEntityId]?.length > 0);
    if (mode === "delete-file") fs.rmSync(path.join(root, "src", "item.py"));
    else writeRepositorySourceScope({ projectRoot: root, storage, selection: { includeRoots: [], excludeRoots: ["src/item.py"] } });
    assert.equal((await refreshWorldModel({ root })).status, "refreshed");
    const after = (await readWorldModel({ root })).snapshot.temporalProvenanceGraph;
    assert.equal(after.nodes.some((node) => node.logicalEntityId === itemRevision.logicalEntityId), false);
    assert.equal(Object.hasOwn(after.revisionParentIds, itemRevision.logicalEntityId), false);
  }
});

test("current logical-entity filtering shares graph identity rules and keeps strict explicit validation", () => {
  const projectId = "project-current-temporal-entities";
  const files = [{
    path: "test/continuity.test.py",
    digest: crypto.createHash("sha256").update("def continuity(): pass\n").digest("hex"),
    language: "python",
    classification: "test",
    symbols: [{ name: "continuity", kind: "function", line: 1 }],
  }];
  const productModel = normalizeProductModelDocument(productModelDocument());
  const graph = buildTemporalProvenanceGraph({ projectId, files, productModel });
  const logicalKinds = new Set(["File", "Symbol", "Test", "FeatureGroup", "Capability", "Feature", "Requirement", "Constraint", "Decision"]);
  const graphLogicalIds = graph.nodes.filter((node) => logicalKinds.has(node.kind)).map((node) => node.nodeId).sort();
  assert.deepEqual(currentTemporalLogicalEntityIds({ projectId, files, productModel }), graphLogicalIds);

  const feature = graph.nodes.find((node) => node.kind === "Feature");
  const featureRevision = graph.nodes.find((node) => node.kind === "FeatureRevision");
  const missingSymbolId = `symbol-${"a".repeat(24)}`;
  const candidateParents = {
    [feature.nodeId]: [featureRevision.nodeId],
    [missingSymbolId]: [`symbol-revision-${"b".repeat(24)}`],
  };
  const filtered = filterRevisionParentsForCurrentTemporalEntities({
    projectId,
    files,
    productModel,
    revisionParentIds: candidateParents,
  });
  assert.deepEqual(filtered, { [feature.nodeId]: [featureRevision.nodeId] });
  assert.throws(() => buildTemporalProvenanceGraph({
    projectId,
    files,
    productModel,
    revisionParentIds: candidateParents,
  }), { code: "UNKNOWN_REVISION_PARENT_ENTITY" });
});
