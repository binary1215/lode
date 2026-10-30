import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { createExecutionContract, createResultPacket, createWholePlanSnapshot } from "../scripts/lib/execution-lineage.mjs";
import { diffGraphLineage, inspectGraphLineage, projectExecutionLineageOverlay, traceGraphLineage } from "../scripts/lib/graph-lineage.mjs";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { normalizeProductModelDocument } from "../scripts/lib/product-model.mjs";
import { buildTemporalProvenanceGraph, verifyTemporalProvenanceGraph } from "../scripts/lib/temporal-provenance.mjs";
import { buildWorldModel } from "../scripts/lib/world-model.mjs";
import { runCommand } from "../scripts/head.mjs";
import { dispatch as dispatchMcp, catalogTools as mcpTools } from "../scripts/mcp-server.mjs";
import { formatCliResult } from "../scripts/lib/cli-presentation.mjs";
import { LocalJsonWorldModelStoreAdapter } from "../scripts/lib/world-model-store.mjs";
import { readWorldModelSnapshot } from "../scripts/lib/world-model.mjs";
import { temporalRelationIdentity } from "../scripts/lib/temporal-relation-identity.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

const graphDigest = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "head-agent-graph-lineage-"));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  return { root, layout };
}

test("projects retained graph genealogy without creating another artifact stream", async (t) => {
  const { root, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const content = "export const stable = true;\n";
  fs.writeFileSync(path.join(root, "src", "before.mjs"), content);
  const first = await buildWorldModel({ root });
  fs.renameSync(path.join(root, "src", "before.mjs"), path.join(root, "src", "after.mjs"));
  const second = await buildWorldModel({ root, parentSourceSnapshotIds: [first.snapshot.temporalProvenanceGraph.sourceSnapshotId] });

  const snapshotsDirectory = path.join(root, layout.directory, "world-model", "snapshots");
  const beforeRead = fs.readdirSync(snapshotsDirectory).sort();
  const status = (await inspectGraphLineage({ root, limit: 100 }));
  const afterRead = fs.readdirSync(snapshotsDirectory).sort();
  assert.deepEqual(afterRead, beforeRead);
  assert.equal(status.totalRetainedSnapshots, 2);
  assert.equal(status.tiers.persistedSegmentArtifacts, false);
  assert.equal(status.authority.plane, "P4-derived-view");
  assert.equal(status.authority.ordinaryWorkBlocked, false);
  assert.equal(status.segment.entries.find((item) => item.worldModelId === second.snapshot.worldModelId).tier, "hot");
  assert.equal(status.segment.entries.find((item) => item.worldModelId === first.snapshot.worldModelId).tier, "warm");

  const diff = (await diffGraphLineage({ root, fromWorldModelId: first.snapshot.worldModelId, toWorldModelId: second.snapshot.worldModelId }));
  assert.deepEqual(diff.changes.possibleMoves.items.map((item) => [item.fromPath, item.toPath]), [["src/before.mjs", "src/after.mjs"]]);
  assert.equal(diff.changes.possibleMoves.items[0].semanticContinuityClaimed, false);
  assert.equal(diff.semantics.reviewRequiredOnlyIfContinuityIsPromoted, true);

  const afterFile = second.snapshot.temporalProvenanceGraph.nodes.find((node) => node.kind === "File" && node.path === "src/after.mjs");
  const trace = (await traceGraphLineage({ root, anchorId: afterFile.nodeId, depth: 1 }));
  assert.equal(trace.anchorMode, "exact");
  assert.equal(trace.graph.traversalQuery.anchorIds.includes(afterFile.nodeId), true);
  assert.equal(trace.semantics.graphWritesRecoveryDirection, false);

  const cli = await runCommand(["graph-lineage-diff", root, "--from", first.snapshot.worldModelId, "--to", second.snapshot.worldModelId]);
  assert.equal(cli.kind, "GraphLineageDiffProjection");
  assert.equal(mcpTools.some((tool) => tool.name === "lode_graph_lineage_status"), true);
  const mcp = await dispatchMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "head_graph_lineage_trace", arguments: { project_root: root, anchor_id: afterFile.nodeId, depth: 0 } } });
  assert.equal(mcp.result.structuredContent.kind, "GraphLineageTraceProjection");

  fs.writeFileSync(path.join(root, "src", "unindexed.mjs"), "export const drift = true;\n");
  (await assert.rejects(async () => (await traceGraphLineage({ root, anchorId: afterFile.nodeId })), { code: "WORLD_MODEL_STALE" }));
  const historical = (await traceGraphLineage({ root, worldModelId: second.snapshot.worldModelId, anchorId: afterFile.nodeId, depth: 0 }));
  assert.equal(historical.worldModelId, second.snapshot.worldModelId);
  assert.equal(historical.authority.ordinaryWorkBlocked, false);
});

test("execution overlay reads exact lineage but cannot promote or recover", async (t) => {
  const { root, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const compiled = (await compileContext({ root, task: "Verify a bounded execution overlay", persist: true }));
  const plan = createWholePlanSnapshot({ root, objective: "Keep graph reads non-authoritative", plan: ["create lineage", "read projection"] });
  const contract = createExecutionContract({
    root,
    wholePlanId: plan.artifact.wholePlanId,
    capsuleId: compiled.capsule.capsuleId,
    scope: "Read exact execution lineage",
    acceptanceCriteria: ["No authority amplification"],
  });
  const result = createResultPacket({
    root,
    executionContractId: contract.artifact.executionContractId,
    outcome: "Projection verified",
    evidence: [{ uri: "test/graph-lineage.test.mjs", digest: "graph-lineage-test", summary: "bounded test evidence" }],
    verification: [{ check: "graph lineage test", status: "passed" }],
  });
  const overlay = projectExecutionLineageOverlay(root, { nodes: [{ kind: "ExecutionLineageReference", referencedArtifactId: result.artifact.resultPacketId }] });
  const ids = new Set(overlay.artifacts.map((item) => item.artifactId));
  assert.equal(ids.has(result.artifact.resultPacketId), true);
  assert.equal(ids.has(contract.artifact.executionContractId), true);
  assert.equal(ids.has(plan.artifact.wholePlanId), true);
  assert.equal(overlay.authority.instructionAuthority, false);
  assert.equal(overlay.authority.promotionAuthority, false);
  assert.equal(overlay.authority.recoveryAuthority, false);
});

test("the current reader preserves digest-valid temporal 0.12 vocabulary compatibility", () => {
  const current = buildTemporalProvenanceGraph({
    projectId: "head-0123456789abcdef0123",
    files: [],
    productModel: normalizeProductModelDocument({ schemaVersion: 1, featureGroups: [], capabilities: [], features: [], requirements: [], constraints: [], decisions: [] }),
  });
  const legacy = structuredClone(current);
  legacy.protocol.version = "0.12.0";
  delete legacy.productModelSchemaVersion;
  delete legacy.logicalLineageState;
  legacy.nodeKinds = legacy.nodeKinds.filter((kind) => !["Policy", "PolicyRevision", "ProductModelRevisionReference", "ProductPolicyCandidate", "ProductPolicyEvidence", "ProductPolicyReviewDecision", "HistoricalOnboardingCandidateReference"].includes(kind));
  legacy.relationTypes = legacy.relationTypes.filter((type) => type !== "HISTORICALLY_FOLLOWS");
  delete legacy.productPolicyProjection;
  delete legacy.summary.policyCount;
  delete legacy.summary.productPolicyCandidateCount;
  delete legacy.summary.productPolicyEvidenceCount;
  delete legacy.summary.productPolicyReviewDecisionCount;
  delete legacy.summary.appliedProductPolicyDecisionCount;
  delete legacy.summary.historicalOnboardingReferenceCount;
  delete legacy.summary.historicalContinuityCount;
  delete legacy.graphSnapshotId;
  delete legacy.graphSnapshotHash;
  legacy.graphSnapshotHash = graphDigest(legacy);
  legacy.graphSnapshotId = `graph-snapshot-${legacy.graphSnapshotHash.slice(0, 24)}`;
  assert.equal(verifyTemporalProvenanceGraph(legacy).graphSnapshotId, legacy.graphSnapshotId);
});

function writeFixtureDecision(root, layout, statement) {
  const file = path.join(root, layout.directory, "context/product-model.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, featureGroups: [], capabilities: [], features: [],
    requirements: [], constraints: [], decisions: [{ key: "D1", statement, status: "active" }] }));
}

test("default whole snapshots distinguish decision changes from unchanged code membership and preserve exact history", async t => {
  const { root, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "src/stable.mjs"), "export function stable() { return 1; }\n");
  writeFixtureDecision(root, layout, "Keep the original output");
  const first = await buildWorldModel({ root }), original = fs.readFileSync(first.file);
  writeFixtureDecision(root, layout, "Use the reviewed output");
  const second = await buildWorldModel({ root });
  assert.equal(second.snapshot.temporalProvenanceGraph.protocol.version, "0.16.0");
  const diff = await diffGraphLineage({ root, fromWorldModelId: first.snapshot.worldModelId, toWorldModelId: second.snapshot.worldModelId });
  const codeIds = new Set(first.snapshot.temporalProvenanceGraph.nodes.filter(n => n.path === "src/stable.mjs").map(n => n.nodeId));
  assert(diff.changes.changedNodes.items.some(id => codeIds.has(id)), "Raw changedNodes keeps membership changes");
  assert(diff.changeExplanation.changedNodes.observationOnly.items.some(id => codeIds.has(id)));
  assert(!diff.changeExplanation.changedNodes.content.items.some(id => codeIds.has(id)));
  const codeEdges = graph => graph.edges.filter(e => codeIds.has(e.from) && codeIds.has(e.to)).map(e => e.edgeId).sort();
  assert(codeEdges(first.snapshot.temporalProvenanceGraph).length);
  assert.deepEqual(codeEdges(first.snapshot.temporalProvenanceGraph), codeEdges(second.snapshot.temporalProvenanceGraph));
  assert(diff.changeExplanation.relations.observationOnly.count > 0);
  assert(diff.changeExplanation.relations.contentAdded.count > 0, "Different snapshot/decision endpoints stay distinct");
  assert(diff.changes.addedNodes.items.some(id => second.snapshot.temporalProvenanceGraph.nodes.some(n => n.nodeId === id && n.kind === "DecisionRevision")));
  assert.equal(diff.changeExplanation.semanticContinuityClaimed, false);
  assert.equal(diff.changeExplanation.rawChangesPreserved, true);
  assert.deepEqual(fs.readFileSync(first.file), original);
  assert.deepEqual((await readWorldModelSnapshot({ root, worldModelId: first.snapshot.worldModelId })).snapshot, first.snapshot);
  const cli = formatCliResult("graph-lineage-diff", diff);
  assert.match(cli, /Changed node content:.*snapshot membership only:/);
  assert.match(cli, /Exact raw changes and historical identities are preserved/);
});

// Reproduce the former 0.15 writer contract, retaining the original graph body.
// The ordinary exact readers must verify these historical bytes before diffing.
function legacyWholeSnapshot(snapshot) {
  const document = structuredClone(snapshot), graph = document.temporalProvenanceGraph;
  graph.protocol.version = "0.15.0";
  delete graph.relationAnalysisBasis;
  for (const edge of graph.edges) {
    delete edge.edgeId; delete edge.logicalRelationId; delete edge.contentRevisionId;
    edge.producerVersion = "0.15.0";
    edge.edgeId = `temporal-edge-${graphDigest(edge).slice(0, 24)}`;
  }
  graph.edges.sort((a, b) => a.edgeId.localeCompare(b.edgeId));
  delete graph.graphSnapshotId; delete graph.graphSnapshotHash;
  graph.graphSnapshotHash = graphDigest(graph);
  graph.graphSnapshotId = `graph-snapshot-${graph.graphSnapshotHash.slice(0, 24)}`;
  verifyTemporalProvenanceGraph(graph);
  delete document.worldModelId; delete document.worldModelHash;
  document.worldModelHash = graphDigest(document);
  document.worldModelId = `world-model-${document.worldModelHash.slice(0, 24)}`;
  return document;
}

test("legacy raw edge changes remain exact and the first producer transition is explicit", async t => {
  const { root, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "src/stable.mjs"), "export const stable = true;\n");
  writeFixtureDecision(root, layout, "First decision");
  const first = await buildWorldModel({ root });
  writeFixtureDecision(root, layout, "Second decision");
  const second = await buildWorldModel({ root });
  const before = legacyWholeSnapshot(first.snapshot), after = legacyWholeSnapshot(second.snapshot);
  const store = new LocalJsonWorldModelStoreAdapter({ projectRoot: root, storage: layout });
  const oldEntry = await store.writeSnapshot(before.worldModelId, before), oldBytes = fs.readFileSync(oldEntry.location);
  await store.writeSnapshot(after.worldModelId, after);
  const diff = await diffGraphLineage({ root, fromWorldModelId: before.worldModelId, toWorldModelId: after.worldModelId, limit: 500 });
  const oldIds = new Set(before.temporalProvenanceGraph.edges.map(e => e.edgeId));
  assert.deepEqual(diff.changes.addedEdges.items, after.temporalProvenanceGraph.edges.map(e => e.edgeId).filter(id => !oldIds.has(id)).sort());
  assert(diff.changeExplanation.relations.observationOnly.count > 0);
  assert(diff.changeExplanation.relations.contentAdded.count < diff.changes.addedEdges.count);
  const transition = await diffGraphLineage({ root, fromWorldModelId: before.worldModelId, toWorldModelId: second.snapshot.worldModelId });
  assert.equal(transition.changeExplanation.producerTransition.changed, true);
  assert.equal(transition.changeExplanation.producerTransition.from.protocol.version, "0.15.0");
  assert.equal(transition.changeExplanation.producerTransition.to.protocol.version, "0.16.0");
  assert.equal(transition.changeExplanation.relations.observationOnly.count, 0);
  assert.deepEqual(fs.readFileSync(oldEntry.location), oldBytes);
});

test("real code and line changes stay visible while unrelated exact code relations remain stable", async t => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "src/change.mjs"), "export function value() { return 1; }\n");
  fs.writeFileSync(path.join(root, "src/untouched.mjs"), "export function untouched() { return 7; }\n");
  const first = await buildWorldModel({ root });
  fs.writeFileSync(path.join(root, "src/change.mjs"), "\nexport function value() { return 2; }\n");
  const second = await buildWorldModel({ root });
  const diff = await diffGraphLineage({ root, fromWorldModelId: first.snapshot.worldModelId, toWorldModelId: second.snapshot.worldModelId, limit: 500 });
  const a = first.snapshot.temporalProvenanceGraph, b = second.snapshot.temporalProvenanceGraph;
  const stableIds = new Set(a.nodes.filter(n => n.path === "src/untouched.mjs").map(n => n.nodeId));
  const edges = graph => graph.edges.filter(e => stableIds.has(e.from) && stableIds.has(e.to)).map(e => e.edgeId).sort();
  assert.deepEqual(edges(a), edges(b));
  assert(diff.changeExplanation.changedNodes.content.items.some(id => b.nodes.some(n => n.nodeId === id && n.path === "src/change.mjs")));
  assert(diff.changes.addedNodes.items.some(id => b.nodes.some(n => n.nodeId === id && n.kind === "FileRevision" && n.path === "src/change.mjs")));
  const scoped = await diffGraphLineage({ root, fromWorldModelId: first.snapshot.worldModelId, toWorldModelId: second.snapshot.worldModelId, scopePaths: ["src/untouched.mjs"], limit: 1 });
  assert.equal(scoped.changeExplanation.changedNodes.content.count, 0);
  assert.equal(scoped.scope.globalChangeCounts, "not-computed");
});

test("stable relation identity never merges evidence, authority, producer, exact endpoints or continuity", () => {
  const nodes = new Map([["one", { kind: "FileRevision", logicalEntityId: "file-one" }], ["two", { kind: "SymbolRevision", logicalEntityId: "symbol-two" }]]);
  const basis = { projectId: "project-one", nodes, relationAnalysisBasis: { analyzer: "fixture" } };
  const edge = { type: "DECLARES", from: "one", to: "two", sourceSnapshotId: "source-a", authorityClass: "heuristic", origin: "fixture",
    evidenceIds: ["digest-a"], confidence: 0.6, producer: "fixture", producerVersion: "0.16.0" };
  const identity = temporalRelationIdentity(edge, basis);
  assert.deepEqual(temporalRelationIdentity({ ...edge, sourceSnapshotId: "source-b" }, basis), identity);
  for (const patch of [{ evidenceIds: ["digest-b"] }, { confidence: 0.8 }, { authorityClass: "reviewed" }, { producerVersion: "another" },
    { origin: "another" }, { freshness: "stale" }, { status: "cancelled" }, { layer: "other" }, { to: "another-exact-revision" }]) {
    assert.notEqual(temporalRelationIdentity({ ...edge, ...patch }, basis).edgeId, identity.edgeId);
  }
  assert.notEqual(temporalRelationIdentity(edge, { ...basis, projectId: "project-two" }).edgeId, identity.edgeId);
  assert.notEqual(temporalRelationIdentity(edge, { ...basis, logicalLineageState: { continuityGenerationByLogicalEntityId: { "file-one": 1 } } }).edgeId, identity.edgeId);
  assert.notEqual(temporalRelationIdentity(edge, { ...basis, relationAnalysisBasis: { analyzer: "another" } }).edgeId, identity.edgeId);
});
