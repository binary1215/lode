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
