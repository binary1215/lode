import { worldSnapshotFile, graphSnapshotFile, readFixtureSnapshot, writeFixtureSnapshot } from "./helpers/snapshot-storage-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runCommand } from "../scripts/head.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";
import { inspectOnboarding, reviewOnboarding, startOnboarding } from "../scripts/lib/onboarding.mjs";
import { inspectConversationalOnboarding } from "../scripts/lib/onboarding-conversation.mjs";
import { initializeOrResumeProject, inspectProjectExperience } from "../scripts/lib/project-bootstrap.mjs";
import { refreshWorldModel } from "../scripts/lib/incremental-refresh.mjs";
import { inspectFeatureMapping, startFeatureMapping, reviewFeatureMapping } from "../scripts/lib/feature-mapping.mjs";
import { inspectWorldModel } from "../scripts/lib/world-model.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function bytes(root) {
  const result = {};
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else result[path.relative(root, file).replaceAll("\\", "/")] = fs.readFileSync(file).toString("base64");
    }
  };
  visit(root);
  return result;
}

function authority(root, layout) {
  return Object.fromEntries(Object.entries(bytes(root)).filter(([name]) => name === `${layout.directory}/project.json`
    || name.startsWith(`${layout.directory}/sessions/`) || name === `${layout.directory}/context/product-model.json` || name.startsWith(`${layout.directory}/onboarding/`)));
}

async function approvedFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(pluginRoot, ".qa-onboarding-world-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "README.md"), "# Delivery service\n");
  fs.writeFileSync(path.join(root, "src/delivery.mjs"), "export function deliver(message) { return { delivered: message }; }\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  const layout = formatForVerifiedOwner(storage);
  const started = await startOnboarding({ root, mode: "new", brief: {
    schemaVersion: 1, name: "Delivery", summary: "Deliver one message.",
    capabilities: [{ key: "delivery", name: "Delivery", description: "Deliver a message." }],
  } });
  const request = { root, candidateSetId: started.candidateSet.candidateSetId, disposition: "accept-all", rationale: "Approve the exact delivery concept." };
  const accepted = await reviewOnboarding(request);
  assert.equal(accepted.status, "onboarding_ready", JSON.stringify(accepted.projection));
  return { root, storage, layout, request, accepted };
}

async function statusParity(root) {
  const expected = (await inspectProjectExperience({ root }));
  const cli = await runCommand(["status", root]);
  const mcp = await dispatch({ jsonrpc: "2.0", id: "workflow-status", method: "tools/call",
    params: { name: "head_project_status", arguments: { project_root: root } } });
  assert.equal(mcp.error, undefined);
  for (const result of [cli, mcp.result.structuredContent]) {
    assert.equal(result.status, expected.status);
    assert.deepEqual(result.readiness, expected.readiness);
    assert.deepEqual(result.nextAction, expected.nextAction);
  }
  return expected;
}

async function proposal(root) {
  const current = (await inspectWorldModel({ root }));
  assert.equal(current.status, "current");
  const graph = current.snapshot.temporalProvenanceGraph;
  return {
    schemaVersion: 1, sourceSnapshotId: graph.sourceSnapshotId, productModelId: current.snapshot.productModel.productModelId,
    candidates: [{ relationshipType: "IMPLEMENTS",
      sourceNodeId: graph.nodes.find((node) => node.kind === "File" && node.path === "src/delivery.mjs").nodeId,
      productNodeId: graph.nodes.find((node) => node.kind === "Capability" && node.key === "delivery").nodeId,
      explanation: "HEAD cites the deliver implementation for the reviewed delivery capability.", confidence: 0.9 }],
  };
}

test("accepted and refreshed Worlds support mapping and exact Context without changing approval history", async (t) => {
  for (const changeSource of [false, true]) {
    const { root, layout, request, accepted } = await approvedFixture(t);
    const protectedBytes = authority(root, layout);
    if (changeSource) {
      fs.appendFileSync(path.join(root, "README.md"), "\nCurrent delivery documentation.\n");
      const stale = await statusParity(root);
      assert.equal(stale.nextAction.entrypoint.worldOperation, "incremental-refresh");
      assert.equal((await runCommand(["world-refresh", root])).status, "refreshed");
    }
    const current = (await inspectWorldModel({ root }));
    const beforeRead = bytes(root);
    const status = await statusParity(root);
    assert.equal(status.status, "product_ready");
    assert.equal(status.readiness.context.worldModelId, current.snapshot.worldModelId);
    assert.equal((await initializeOrResumeProject({ root, pluginRoot, profile: "product" })).status, "product_ready");
    assert.notEqual((await inspectConversationalOnboarding({ root })).nextAction, "refresh_or_reconcile_world");
    const replay = await reviewOnboarding(request);
    assert.equal(replay.status, "onboarding_ready");
    assert.equal(replay.worldModel.worldModelId, current.snapshot.worldModelId);
    assert.equal(replay.productCanonChanged, false);
    assert.deepEqual(bytes(root), beforeRead, "readiness, resume and completed replay are pure");
    assert.equal((await inspectOnboarding({ root })).state.worldModelId, accepted.worldModel.worldModelId, "historical approval reference is retained");

    const input = (await proposal(root));
    const inputBytes = JSON.stringify(input);
    const started = await startFeatureMapping({ root, semanticProposal: input });
    assert.equal(started.status, "awaiting_feature_mapping_review");
    assert.equal(JSON.stringify(input), inputBytes);
    const mappingWorld = (await inspectWorldModel({ root })).snapshot;
    assert.equal(mappingWorld.temporalProvenanceGraph.sourceSnapshotId, input.sourceSnapshotId);
    assert.deepEqual(mappingWorld.temporalProvenanceGraph.parentSourceSnapshotIds, current.snapshot.temporalProvenanceGraph.parentSourceSnapshotIds);
    assert.deepEqual(mappingWorld.temporalProvenanceGraph.revisionParentIds, current.snapshot.temporalProvenanceGraph.revisionParentIds);
    assert.deepEqual(mappingWorld.files, current.snapshot.files);
    assert.equal(mappingWorld.productModel.productModelHash, current.snapshot.productModel.productModelHash);
    assert.deepEqual(authority(root, layout), protectedBytes);
    const reviewed = await reviewFeatureMapping({ root, candidateSetId: started.candidateSet.candidateSetId,
      disposition: "accept-all", rationale: "Approve the exact implementation relationship." });
    assert.equal(reviewed.status, "feature_mappings_reviewed");
    const reviewedWorld = (await inspectWorldModel({ root }));
    assert.equal(reviewedWorld.status, "current");
    assert.equal(reviewedWorld.snapshot.temporalProvenanceGraph.sourceSnapshotId, input.sourceSnapshotId);
    assert.deepEqual(reviewedWorld.snapshot.temporalProvenanceGraph.parentSourceSnapshotIds, current.snapshot.temporalProvenanceGraph.parentSourceSnapshotIds);
    assert.deepEqual(reviewedWorld.snapshot.temporalProvenanceGraph.revisionParentIds, current.snapshot.temporalProvenanceGraph.revisionParentIds);
    const capsule = (await compileContext({ root, task: "Explain the reviewed delivery implementation.", persist: false,
      evidenceNeeds: [{ id: "delivery-product", kind: "product-context", entityKeys: ["delivery"], minimumItems: 1 },
        { id: "delivery-source", kind: "repository-source", paths: ["src/delivery.mjs"], minimumItems: 1 }] })).capsule;
    assert.deepEqual(capsule.evidenceGaps, []);
    assert.equal(Object.hasOwn(capsule, "coverageAssessment"), false, "context selection does not grant semantic approval");
    assert.equal((await statusParity(root)).status, "product_ready");
    assert.deepEqual(authority(root, layout), protectedBytes);
    assert.equal((await refreshWorldModel({ root })).status, "unchanged");
    const stable = bytes(root);
    assert.equal((await refreshWorldModel({ root })).status, "unchanged");
    assert.deepEqual(bytes(root), stable, "repeated unchanged refresh reuses its exact records");
  }
});

test("missing World guidance executes a rebuild and converges without reapproval", async (t) => {
  for (const missing of ["directory", "snapshot"]) {
    const { root, layout, request, accepted } = await approvedFixture(t);
    const protectedBytes = authority(root, layout);
    if (missing === "directory") fs.rmSync(path.join(root, layout.directory, "world-model"), { recursive: true, force: true });
    else fs.unlinkSync(worldSnapshotFile(root, accepted.worldModel.worldModelId));
    const beforeRead = bytes(root);
    const status = await statusParity(root);
    assert.equal(status.readiness.core.state, "ready");
    assert.equal(status.readiness.context.worldModelId, null);
    assert.equal(status.nextAction.entrypoint.worldOperation, "rebuild");
    assert.equal(status.nextAction.entrypoint.cli, "lode-agent world-index <project>");
    assert.equal((await inspectConversationalOnboarding({ root })).nextAction, "refresh_or_reconcile_world");
    assert.deepEqual(bytes(root), beforeRead);
    const command = status.nextAction.entrypoint.cli.split(" ")[1];
    await runCommand([command, root]);
    assert.equal((await statusParity(root)).status, "product_ready");
    assert.equal((await initializeOrResumeProject({ root, pluginRoot, profile: "product" })).status, "product_ready");
    assert.equal((await reviewOnboarding(request)).status, "onboarding_ready");
    assert.deepEqual(authority(root, layout), protectedBytes);
    assert.equal((await refreshWorldModel({ root })).status, "unchanged");
    assert.equal((await statusParity(root)).status, "product_ready");
  }
});

test("mapping preserves real source drift and digest failures without preliminary indexing", async (t) => {
  const { root, layout } = await approvedFixture(t);
  const input = (await proposal(root));
  const source = path.join(root, "src/delivery.mjs");
  const originalSource = fs.readFileSync(source);
  fs.appendFileSync(source, "\nexport const changed = true;\n");
  let before = bytes(root);
  await assert.rejects(() => startFeatureMapping({ root, semanticProposal: input }), { code: "FEATURE_MAPPING_SOURCE_DRIFT" });
  assert.deepEqual(bytes(root), before);
  fs.writeFileSync(source, originalSource);
  before = bytes(root);
  await assert.rejects(() => startFeatureMapping({ root, semanticProposal: { ...input, sourceSnapshotId: `source-snapshot-${"0".repeat(24)}` } }), { code: "FEATURE_MAPPING_PROPOSAL_DRIFT" });
  assert.deepEqual(bytes(root), before);
  const canonFile = path.join(root, layout.directory, "context/product-model.json");
  const canonBytes = fs.readFileSync(canonFile);
  const changedCanon = JSON.parse(canonBytes);
  changedCanon.capabilities[0].description = "A different product contract.";
  fs.writeFileSync(canonFile, JSON.stringify(changedCanon));
  before = bytes(root);
  await assert.rejects(() => startFeatureMapping({ root, semanticProposal: input }), { code: "FEATURE_MAPPING_SOURCE_DRIFT" });
  assert.equal((await statusParity(root)).readiness.product.state, "integrity_attention");
  assert.deepEqual(bytes(root), before);
  fs.writeFileSync(canonFile, canonBytes);
  const pointer = JSON.parse(fs.readFileSync(path.join(root, layout.directory, "world-model/current.json"), "utf8"));
  const filename = worldSnapshotFile(root, pointer.worldModelId);
  const world = readFixtureSnapshot(filename);
  world.worldModelHash = "0".repeat(64);
  writeFixtureSnapshot(filename, world);
  before = bytes(root);
  (await assert.rejects(async () => (await inspectWorldModel({ root }))));
  await assert.rejects(() => startFeatureMapping({ root, semanticProposal: input }));
  assert.equal((await statusParity(root)).readiness.product.state, "integrity_attention");
  assert.deepEqual(bytes(root), before);
});

test("explicit mapping setup without a pinned proposal refreshes stale evidence in one operation", async (t) => {
  const { root, layout } = await approvedFixture(t);
  const previous = (await inspectWorldModel({ root })).snapshot.temporalProvenanceGraph;
  const previousRevision = previous.nodes.find((node) => node.kind === "FileRevision" && node.path === "src/delivery.mjs");
  const protectedBytes = authority(root, layout);
  fs.appendFileSync(path.join(root, "src/delivery.mjs"), "\nexport const deliveryFormat = 'message';\n");
  const setup = await startFeatureMapping({ root });
  assert.equal(setup.status, "awaiting_feature_mapping_evidence");
  assert.equal(setup.candidateSet.candidates.length, 0);
  assert.ok(setup.candidateSet.unknowns.length > 0);
  assert.equal(fs.existsSync(path.join(root, layout.directory, "feature-mappings/review-decisions")), false, "setup does not manufacture a mapping decision");
  const current = (await inspectWorldModel({ root }));
  assert.equal(current.status, "current");
  assert.ok(current.snapshot.temporalProvenanceGraph.parentSourceSnapshotIds.includes(previous.sourceSnapshotId));
  assert.ok(Object.values(current.snapshot.temporalProvenanceGraph.revisionParentIds).flat().includes(previousRevision.nodeId));
  assert.deepEqual(authority(root, layout), protectedBytes);
  const started = await startFeatureMapping({ root, semanticProposal: (await proposal(root)) });
  assert.equal(started.status, "awaiting_feature_mapping_review");
  assert.deepEqual(authority(root, layout), protectedBytes);
});

test("explicit stale mapping rejection unblocks a fresh reviewed proposal and Context without revoking prior review", async (t) => {
  for (const refreshFirst of [true, false]) {
    const { root, layout } = await approvedFixture(t);
    const protectedBytes = authority(root, layout);
    const first = await startFeatureMapping({ root, semanticProposal: (await proposal(root)) });
    const prior = await reviewFeatureMapping({ root, candidateSetId: first.candidateSet.candidateSetId,
      disposition: "accept-all", rationale: "Approve the first exact implementation relationship." });
    const priorFile = path.join(root, layout.directory, "feature-mappings/review-decisions", `${prior.reviewDecision.reviewDecisionId}.json`);
    const priorBytes = fs.readFileSync(priorFile);
    const nextInput = (await proposal(root));
    nextInput.candidates[0].explanation += " A separate proposed evidence review.";
    const pending = await startFeatureMapping({ root, semanticProposal: nextInput });
    const historicalGraph = (await inspectWorldModel({ root })).snapshot.temporalProvenanceGraph;
    const previousRevision = historicalGraph.nodes.find((node) => node.kind === "FileRevision" && node.path === "src/delivery.mjs");
    fs.appendFileSync(path.join(root, "src/delivery.mjs"), "\nexport const deliveryFormat = 'updated-message';\n");
    if (refreshFirst) assert.equal((await runCommand(["world-refresh", root])).status, "refreshed");
    const before = bytes(root);
    const staleStatus = (await inspectFeatureMapping({ root }));
    assert.equal(staleStatus.reviewReadiness.evidenceStatus, "stale");
    assert.equal(staleStatus.reviewReadiness.acceptanceAvailable, false);
    assert.equal(staleStatus.reviewReadiness.explicitRejectionAvailable, true);
    assert.match(staleStatus.reviewReadiness.nextAction, /reject.*exact outdated/i);
    assert.deepEqual(await runCommand(["feature-mapping-status", root]), staleStatus);
    const staleMcp = await dispatch({ jsonrpc: "2.0", id: "stale-mapping-status", method: "tools/call",
      params: { name: "head_feature_mapping_status", arguments: { project_root: root } } });
    assert.deepEqual(staleMcp.result.structuredContent, staleStatus);
    assert.match(staleMcp.result.content[0].text, /Acceptance is unavailable/u);
    assert.match(staleMcp.result.content[0].text, /reject this exact outdated set/u);
    assert.doesNotMatch(staleMcp.result.content[0].text, /Options: accept/u);
    await assert.rejects(() => startFeatureMapping({ root, semanticProposal: nextInput }), { code: "FEATURE_MAPPING_REVIEW_REQUIRED" });
    for (const disposition of ["accept-all", "accept-selection"]) {
      await assert.rejects(() => reviewFeatureMapping({ root, candidateSetId: pending.candidateSet.candidateSetId,
        disposition, acceptedCandidateIds: [pending.candidateSet.candidates[0].candidateId], rationale: "Cannot approve changed evidence." }),
      { code: "FEATURE_MAPPING_SOURCE_DRIFT" });
    }
    assert.deepEqual(bytes(root), before, "stale acceptance and replacement proposal cannot write");
    const request = { candidateSetId: pending.candidateSet.candidateSetId, disposition: "reject",
      rationale: "Explicitly reject the exact outdated proposal; keep prior approved relationships." };
    const denied = await dispatch({ jsonrpc: "2.0", id: "unconfirmed-stale-reject", method: "tools/call",
      params: { name: "head_feature_mapping_review", arguments: { project_root: root,
        candidate_set_id: request.candidateSetId, disposition: request.disposition, rationale: request.rationale, confirm_user_review: false } } });
    assert.match(denied.error.message, /explicit user confirmation/i);
    assert.deepEqual(bytes(root), before, "read-only guidance and unconfirmed rejection cannot write");
    let rejected;
    if (refreshFirst) {
      const inputFile = path.join(root, layout.directory, "feature-mappings/reject-input.json");
      fs.writeFileSync(inputFile, JSON.stringify(request));
      rejected = await runCommand(["feature-mapping-review", root, "--input", inputFile]);
      fs.unlinkSync(inputFile);
    } else {
      const response = await dispatch({ jsonrpc: "2.0", id: "stale-mapping-reject", method: "tools/call",
        params: { name: "head_feature_mapping_review", arguments: { project_root: root,
          candidate_set_id: request.candidateSetId, disposition: request.disposition, rationale: request.rationale, confirm_user_review: true } } });
      assert.equal(response.error, undefined, JSON.stringify(response.error));
      rejected = response.result.structuredContent;
    }
    assert.equal(rejected.status, "feature_mappings_rejected");
    assert.equal(rejected.reviewDecision.promotionAuthority, false);
    assert.deepEqual(rejected.reviewDecision.acceptedCandidateIds, []);
    assert.equal(rejected.reviewDecision.sourceSnapshotId, pending.candidateSet.sourceSnapshotId, "decision retains historical evidence identity");
    assert.equal(rejected.reviewDecision.productModelId, pending.candidateSet.productModelId);
    const current = (await inspectWorldModel({ root }));
    assert.equal(current.status, "current");
    const graph = current.snapshot.temporalProvenanceGraph;
    assert.ok(graph.parentSourceSnapshotIds.includes(historicalGraph.sourceSnapshotId));
    assert.ok(Object.values(graph.revisionParentIds).flat().includes(previousRevision.nodeId));
    assert.deepEqual(fs.readFileSync(priorFile), priorBytes);
    assert.deepEqual(graph.nodes.filter((node) => node.kind === "ReviewedRelationship").map((node) => node.reviewDecisionId), [prior.reviewDecision.reviewDecisionId]);
    const historicalRelationship = graph.nodes.find((node) => node.kind === "ReviewedRelationship"
      && node.reviewDecisionId === prior.reviewDecision.reviewDecisionId);
    assert.equal(historicalRelationship.approvalStatus, "approved", "the immutable review remains preserved");
    assert.equal(historicalRelationship.evidenceStatus, "changed", "changed source is not projected as current evidence");
    assert.equal(historicalRelationship.projectionCurrent, false);
    assert.equal(graph.edges.some((edge) => edge.type === "IMPLEMENTS" && edge.authorityClass === "reviewed"), false,
      "historical approval cannot masquerade as a current implementation relation");
    assert.ok(graph.edges.some((edge) => edge.type === "REJECTED_BY" && edge.to === rejected.reviewDecision.reviewDecisionId));
    const direct = (await inspectFeatureMapping({ root }));
    const cli = await runCommand(["feature-mapping-status", root]);
    const mcp = await dispatch({ jsonrpc: "2.0", id: "mapping-status", method: "tools/call",
      params: { name: "head_feature_mapping_status", arguments: { project_root: root } } });
    assert.equal(mcp.error, undefined);
    assert.deepEqual(cli, direct);
    assert.deepEqual(mcp.result.structuredContent, direct);
    const fresh = await startFeatureMapping({ root, semanticProposal: (await proposal(root)) });
    assert.equal(fresh.status, "awaiting_feature_mapping_review");
    const approved = await reviewFeatureMapping({ root, candidateSetId: fresh.candidateSet.candidateSetId,
      disposition: "accept-all", rationale: "Approve the fresh exact evidence after rejecting the obsolete proposal." });
    assert.equal(approved.status, "feature_mappings_reviewed");
    const refreshedWorld = (await inspectWorldModel({ root }));
    assert.equal(refreshedWorld.status, "current");
    assert.ok(refreshedWorld.snapshot.temporalProvenanceGraph.edges.some((edge) => edge.type === "IMPLEMENTS"
      && edge.authorityClass === "reviewed"), "only the fresh review restores a current implementation relation");
    const capsule = (await compileContext({ root, task: "Explain current delivery implementation.", persist: false,
      evidenceNeeds: [{ id: "delivery-product", kind: "product-context", entityKeys: ["delivery"], minimumItems: 1 },
        { id: "delivery-source", kind: "repository-source", paths: ["src/delivery.mjs"], minimumItems: 1 }] })).capsule;
    assert.deepEqual(capsule.evidenceGaps, []);
    assert.equal(Object.hasOwn(capsule, "coverageAssessment"), false);
    assert.deepEqual(authority(root, layout), protectedBytes);
    assert.deepEqual(fs.readFileSync(priorFile), priorBytes);
  }
});
