import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { createExecutionContract, createResultPacket, createWholePlanSnapshot } from "../scripts/lib/execution-lineage.mjs";
import { diffGraphLineage, inspectGraphLineage, inspectGraphLineageComparison, projectExecutionLineageOverlay, traceGraphLineage } from "../scripts/lib/graph-lineage.mjs";
import { buildGraphExplorerSnapshot, exportGraphExplorer } from "../scripts/lib/graph-explorer.mjs";
import { explorerCodec } from "../scripts/graph-explorer/codec.js";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { normalizeProductModelDocument } from "../scripts/lib/product-model.mjs";
import { buildTemporalProvenanceGraph, verifyTemporalProvenanceGraph } from "../scripts/lib/temporal-provenance.mjs";
import { buildWorldModel } from "../scripts/lib/world-model.mjs";
import { runCommand } from "../scripts/head.mjs";
import { dispatch as dispatchMcp, catalogTools as mcpTools } from "../scripts/mcp-server.mjs";
import { formatCliResult } from "../scripts/lib/cli-presentation.mjs";
import { LocalJsonWorldModelStoreAdapter, assertWorldModelStoreAdapter } from "../scripts/lib/world-model-store.mjs";
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
  assert.equal(diff.changeExplanation.relations.snapshotMembership.count, 1);
  const membership=diff.changeExplanation.relations.snapshotMembership.items[0];
  assert.equal(membership.fromSourceSnapshotId,first.snapshot.temporalProvenanceGraph.sourceSnapshotId);
  assert.equal(membership.toSourceSnapshotId,second.snapshot.temporalProvenanceGraph.sourceSnapshotId);
  assert.equal(membership.path,"src/stable.mjs");
  assert(diff.changeExplanation.relations.contentAdded.count > 0, "Different snapshot/decision endpoints stay distinct");
  assert(diff.changes.addedNodes.items.some(id => second.snapshot.temporalProvenanceGraph.nodes.some(n => n.nodeId === id && n.kind === "DecisionRevision")));
  assert.equal(diff.changeExplanation.semanticContinuityClaimed, false);
  assert.equal(diff.changeExplanation.rawChangesPreserved, true);
  assert.deepEqual(fs.readFileSync(first.file), original);
  assert.deepEqual((await readWorldModelSnapshot({ root, worldModelId: first.snapshot.worldModelId })).snapshot, first.snapshot);
  const cli = formatCliResult("graph-lineage-diff", diff);
  assert.match(cli, /Changed node content:.*snapshot membership only:/);
  assert.match(cli, /Exact raw changes and historical identities are preserved/);
  assert.match(cli, /Snapshot\/context observations: 1 memberships/);
  const rpc=await dispatchMcp({method:"tools/call",params:{name:"head_graph_lineage_diff",arguments:{project_root:root,from_world_model_id:first.snapshot.worldModelId,to_world_model_id:second.snapshot.worldModelId}}});
  assert.equal(rpc.error,undefined);const wire=JSON.parse(rpc.result.content[0].text);
  assert.equal(wire.changeExplanation.relations.snapshotMembership.count,1);assert.deepEqual(wire.changes,diff.changes);
  const output=path.join(os.tmpdir(),"lode-membership-"+crypto.randomUUID()+".html");t.after(()=>fs.rmSync(output,{force:true}));
  const exported=await exportGraphExplorer({root,query:"stable",history:true,output});
  const encoded=/<script[^>]*id="snapshot"[^>]*>([\s\S]*?)<\/script>/.exec(fs.readFileSync(exported.file,"utf8"));assert(encoded);
  const htmlSnapshot=explorerCodec.decode(JSON.parse(encoded[1]));
  assert.equal(htmlSnapshot.history.diff.changeExplanation.relations.snapshotMembership.count,1);
  const selected=await diffGraphLineage({root,fromWorldModelId:htmlSnapshot.history.diff.from.worldModelId,
    toWorldModelId:htmlSnapshot.history.diff.to.worldModelId,limit:40});
  assert.deepEqual(htmlSnapshot.history.diff.changes,selected.changes);
});

// Reproduce the former 0.15 writer contract, retaining the original graph body.
// The ordinary exact readers must verify these historical bytes before diffing.
function legacyWholeSnapshot(snapshot, { verify = true } = {}) {
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
  if (verify) verifyTemporalProvenanceGraph(graph);
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
  assert.equal(transition.changeExplanation.relations.snapshotMembership.count, 0);
  assert.deepEqual(fs.readFileSync(oldEntry.location), oldBytes);
});

test("same FileRevision ID cannot hide changed digest, status or unknown metadata as membership", async t => {
  const {root,layout}=fixture();t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,"src/stable.mjs"),"export const stable = true;\n");
  writeFixtureDecision(root,layout,"First decision");const first=await buildWorldModel({root});
  writeFixtureDecision(root,layout,"Second decision");const second=await buildWorldModel({root});
  const before=legacyWholeSnapshot(first.snapshot),store=new LocalJsonWorldModelStoreAdapter({projectRoot:root,storage:layout});
  await store.writeSnapshot(before.worldModelId,before);
  for(const patch of [{digest:"f".repeat(64)},{status:"cancelled"},{unknownExtension:{status:"not-established"}}]){
    const candidate=structuredClone(second.snapshot),node=candidate.temporalProvenanceGraph.nodes.find(n=>n.kind==="FileRevision");
    Object.assign(node,patch);const after=legacyWholeSnapshot(candidate,{verify:false});
    await store.writeSnapshot(after.worldModelId,after);
    const input={root,fromWorldModelId:before.worldModelId,toWorldModelId:after.worldModelId,limit:500};
    if(Object.hasOwn(patch,"digest"))await assert.rejects(diffGraphLineage(input),{code:"TEMPORAL_NODE_IDENTITY_MISMATCH"});
    else {
      const diff=await diffGraphLineage(input);
      assert.equal(diff.changeExplanation.relations.snapshotMembership.count,0);
      assert(diff.changeExplanation.changedNodes.content.items.includes(node.nodeId));
    }
  }
  for(const patch of [{status:"cancelled"},{unknownExtension:{status:"not-established"}},{producer:"another-producer"}]){
    const candidate=structuredClone(second.snapshot),target=candidate.temporalProvenanceGraph.nodes.find(n=>n.kind==="FileRevision"),edge=candidate.temporalProvenanceGraph.edges.find(e=>e.type==="CONTAINS"&&e.to===target.nodeId);
    Object.assign(edge,patch);const after=legacyWholeSnapshot(candidate,{verify:false});await store.writeSnapshot(after.worldModelId,after);
    const input={root,fromWorldModelId:before.worldModelId,toWorldModelId:after.worldModelId,limit:500};
    if(Object.hasOwn(patch,"producer")){await assert.rejects(diffGraphLineage(input),{code:"INVALID_TEMPORAL_PROVENANCE_GRAPH"});continue;}
    const diff=await diffGraphLineage(input);
    assert.equal(diff.changeExplanation.relations.snapshotMembership.count,0);
    assert(diff.changeExplanation.relations.contentAdded.items.includes(after.temporalProvenanceGraph.edges.find(e=>e.type==="CONTAINS"&&e.to===target.nodeId).edgeId));
  }
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


async function comparisonFixture(t) {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(f.root, 'src/change.mjs'), 'export const value = 1;\n');
  const first = (await buildWorldModel({ root: f.root })).snapshot;
  fs.writeFileSync(path.join(f.root, 'src/change.mjs'), 'export const value = 2;\n');
  const second = (await buildWorldModel({ root: f.root })).snapshot;
  return { ...f, first, second };
}
function comparisonBytes(root) {
  const result = {};
  const visit = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name); if (entry.isDirectory()) visit(file);
    else result[path.relative(root, file)] = graphDigest(fs.readFileSync(file).toString('base64'));
  } };
  visit(root); return result;
}
async function separateComparison(root, storeAdapter = null) {
  const lineage = await inspectGraphLineage({ root, limit: 3, storeAdapter }), entries = lineage.segment.entries;
  const current = entries.find(entry => entry.worldModelId === lineage.currentWorldModelId);
  const parent = entries.find(entry => current?.parentSourceSnapshotIds.includes(entry.sourceSnapshotId));
  const pair = current && parent ? [parent, current] : entries.slice(0, 2);
  const diff = pair.length === 2 ? await diffGraphLineage({ root, fromWorldModelId: pair[0].worldModelId,
    toWorldModelId: pair[1].worldModelId, limit: 40, storeAdapter }) : null;
  return { lineage, entries, diff, comparison: parent ? 'retained-parent-to-current' : 'exact-retained-pair-not-chronological-inference' };
}

test('P2a actual Explorer history reuses verified endpoints with exact output and no new records', async t => {
  const f = await comparisonFixture(t), before = comparisonBytes(f.root);
  const original = LocalJsonWorldModelStoreAdapter.prototype.readSnapshot;
  let reads = 0;
  t.mock.method(LocalJsonWorldModelStoreAdapter.prototype, 'readSnapshot', function(...args) { reads++; return original.apply(this, args); });
  const expected = await separateComparison(f.root); assert.equal(reads, 5);
  reads = 0; const actual = await inspectGraphLineageComparison({ root: f.root });
  assert.equal(reads, 2); assert.deepEqual(actual, expected);
  reads = 0; await diffGraphLineage({ root: f.root, fromWorldModelId: f.first.worldModelId, toWorldModelId: f.second.worldModelId });
  assert.equal(reads, 2, 'the first distinct pair still reads both full endpoints');
  reads = 0; await buildGraphExplorerSnapshot({ root: f.root, query: 'change.mjs', history: false }); const inventoryReads = reads;
  reads = 0; const explorer = await buildGraphExplorerSnapshot({ root: f.root, query: 'change.mjs', history: true });
  assert.equal(explorer.history.status, 'retained');
  assert.equal(reads - inventoryReads, 2, 'the actual Explorer consumes the composite reader');
  assert.deepEqual(explorer.history, { status: 'retained', ...expected });
  assert.deepEqual(comparisonBytes(f.root), before);
  t.diagnostic(JSON.stringify({ separateHistoryAndDiffReads: 5, compositeHistoryAndDiffReads: 2, explorerHistoryExtraReads: 2,
    firstDistinctPairFullReads: 2, originalFilesUnchanged: true, persistence: 'none' }));
});

test('P2a request-owned reads detach retained aliases and revalidate every new request', async t => {
  const f = await comparisonFixture(t), before = comparisonBytes(f.root), expected = await separateComparison(f.root);
  const docs = new Map([[f.first.worldModelId, structuredClone(f.first)], [f.second.worldModelId, structuredClone(f.second)]]);
  const store = new LocalJsonWorldModelStoreAdapter({ projectRoot: f.root, storage: f.layout });
  let reads = 0;
  store.readSnapshot = id => {
    reads++; const document = docs.get(id);
    if (reads === 1) queueMicrotask(() => { document.sourceDigest = 'f'.repeat(64); });
    return { document, location: 'synthetic-retained:' + id };
  };
  const actual = await inspectGraphLineageComparison({ root: f.root, storeAdapter: store });
  assert.equal(reads, 2); assert.deepEqual(actual, expected);
  assert.equal(Object.isFrozen(docs.get(f.first.worldModelId)), false);
  assert.equal(Object.isFrozen(docs.get(f.second.worldModelId)), false);
  assert.equal(docs.get(f.second.worldModelId).sourceDigest, 'f'.repeat(64));
  actual.diff.changeExplanation.producerTransition.from.protocol.version = 'caller-local-output';
  assert.equal(docs.get(f.first.worldModelId).temporalProvenanceGraph.protocol.version, '0.16.0');
  await assert.rejects(() => inspectGraphLineageComparison({ root: f.root, storeAdapter: store }), { code: 'WORLD_MODEL_DIGEST_MISMATCH' });
  await assert.rejects(() => diffGraphLineage({ root: f.root, storeAdapter: store,
    fromWorldModelId: f.first.worldModelId, toWorldModelId: f.second.worldModelId,
    verifiedSnapshots: [f.first, f.second], snapshot: f.second }), { code: 'WORLD_MODEL_DIGEST_MISMATCH' });
  assert.deepEqual(comparisonBytes(f.root), before);
});

test('P2a preserves custom thenables and non-cloneable extensions without treating them as a cache capability', async t => {
  const f = await comparisonFixture(t), before = comparisonBytes(f.root), expected = await separateComparison(f.root);
  const docs = new Map([[f.first.worldModelId, f.first], [f.second.worldModelId, f.second]]);
  const store = new LocalJsonWorldModelStoreAdapter({ projectRoot: f.root, storage: f.layout });
  let reads = 0;
  store.readSnapshot = id => { reads++; return { then(resolve) { resolve({ document: docs.get(id), location: 'synthetic-thenable' }); } }; };
  assert.deepEqual(await inspectGraphLineageComparison({ root: f.root, storeAdapter: store }), expected);
  assert.equal(reads, 2);
  reads = 0; store.readSnapshot = id => { reads++; return { document: { ...docs.get(id), unusedExtension() {} }, location: 'synthetic-extension' }; };
  assert.deepEqual(await inspectGraphLineageComparison({ root: f.root, storeAdapter: store }), expected);
  assert.equal(reads, 5, 'non-cloneable custom bodies keep the original full-read behavior');
  store.readSnapshot = () => { throw Object.assign(new Error('synthetic permission denial'), { code: 'EACCES' }); };
  await assert.rejects(() => inspectGraphLineageComparison({ root: f.root, storeAdapter: store }), { code: 'EACCES' });
  assert.deepEqual(comparisonBytes(f.root), before);
});


test('P2a preserves bounded page choices and rejects a valid foreign Project snapshot before memoing', async t => {
  const f = await comparisonFixture(t), foreign = await comparisonFixture(t), before = comparisonBytes(f.root);
  for (const limit of [1, 2, 3]) {
    const actual = await inspectGraphLineageComparison({ root: f.root, limit });
    const lineage = await inspectGraphLineage({ root: f.root, limit }), entries = lineage.segment.entries;
    const current = entries.find(entry => entry.worldModelId === lineage.currentWorldModelId);
    const parent = entries.find(entry => current?.parentSourceSnapshotIds.includes(entry.sourceSnapshotId));
    const pair = current && parent ? [parent, current] : entries.slice(0, 2);
    const diff = pair.length === 2 ? await diffGraphLineage({ root: f.root, fromWorldModelId: pair[0].worldModelId,
      toWorldModelId: pair[1].worldModelId, limit: 40 }) : null;
    assert.deepEqual(actual, { lineage, entries, diff, comparison: parent ? 'retained-parent-to-current' : 'exact-retained-pair-not-chronological-inference' });
  }
  const store = new LocalJsonWorldModelStoreAdapter({ projectRoot: f.root, storage: f.layout });
  store.readPointer = () => ({ document: { schemaVersion: 1, kind: 'WorldModelPointer', projectId: f.first.projectId,
    worldModelId: foreign.second.worldModelId, worldModelHash: foreign.second.worldModelHash } });
  store.readSnapshot = () => ({ document: foreign.second, location: 'synthetic-foreign-original' });
  await assert.rejects(() => inspectGraphLineageComparison({ root: f.root, storeAdapter: store }), { code: 'WORLD_MODEL_IDENTITY_MISMATCH' });
  assert.deepEqual(comparisonBytes(f.root), before);
});


for (const mode of ['fixed-read-method', 'frozen-interface']) test('P2a readonly adapter compatibility: ' + mode, async t => {
  const f = await comparisonFixture(t), before = comparisonBytes(f.root);
  const physical = new LocalJsonWorldModelStoreAdapter({ projectRoot: f.root, storage: f.layout });
  const original = physical.readSnapshot.bind(physical); let reads = 0;
  const read = id => { reads++; return original(id); }; let adapter = physical;
  if (mode === 'fixed-read-method') Object.defineProperty(physical, 'readSnapshot', { value: read, writable: false, configurable: false });
  else {
    adapter = { adapterVersion: physical.adapterVersion, readSnapshot: read };
    for (const method of ['describe', 'readPointer', 'writePointer', 'writeSnapshot', 'listSnapshotIds']) adapter[method] = physical[method].bind(physical);
    Object.freeze(adapter);
  }
  assert.equal(assertWorldModelStoreAdapter(adapter), adapter);
  const expected = await separateComparison(f.root, adapter); assert.equal(reads, 5); reads = 0;
  assert.deepEqual(await inspectGraphLineageComparison({ root: f.root, storeAdapter: adapter }), expected);
  assert.equal(reads, 2); assert.deepEqual(comparisonBytes(f.root), before);
});
