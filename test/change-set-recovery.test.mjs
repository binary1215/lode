import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { recordChangeSet, reviewChangeImpact, inspectChangeSets } from "../scripts/lib/change-set.mjs";
import { verifyChangeSet, changeSetCanonicalJson, changeSetDigest, CHANGE_SET_VERSION, CHANGE_SET_RECORD_VERSION } from "../scripts/lib/change-set-projection.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { createExecutionContract, createWholePlanSnapshot } from "../scripts/lib/execution-lineage.mjs";
import { startFeatureMapping, reviewFeatureMapping } from "../scripts/lib/feature-mapping.mjs";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { finishRun, getPendingReviewContext, reviewRun, startRun } from "../scripts/lib/run-lineage.mjs";
import { buildWorldModel, inspectWorldModel, readWorldModelSnapshot } from "../scripts/lib/world-model.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");

function temporaryProject(t, label) {
  const parent = process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, `head-change-set-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function reviewFiles(root, layout) {
  const directory = path.join(root, layout.directory, "change-sets", "impact-review-decisions");
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort() : [];
}

function headSessionState(root) {
  const state = inspectProject(root).state;
  return {
    sessionId: state.sessionId,
    activeRunId: state.activeRunId,
    pendingReview: state.pendingReview,
    lastReviewDecisionId: state.lastReviewDecisionId,
  };
}

async function captureError(action) {
  try { return { result: await action(), error: null }; }
  catch (error) { return { result: null, error }; }
}

async function changeSetFixture(t, label) {
  const root = temporaryProject(t, label);
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  const product = {
    schemaVersion: 1,
    featureGroups: [{ key: "messaging", name: "Messaging", description: "Communication features." }],
    capabilities: [{ key: "delivery", name: "Delivery", description: "Deliver messages." }],
    features: [{
      key: "send",
      name: "Send message",
      description: "Send a user message.",
      featureGroupKeys: ["messaging"],
      capabilityKeys: ["delivery"],
      governedBy: [],
    }],
    requirements: [],
    constraints: [],
    decisions: [],
  };
  fs.writeFileSync(path.join(root, layout.directory, "context", "product-model.json"), `${JSON.stringify(product, null, 2)}\n`);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "message.mjs"), "export function send(message) { return message; }\n");

  await startFeatureMapping({ root });
  const world = (await inspectWorldModel({ root })).snapshot;
  const graph = world.temporalProvenanceGraph;
  const sourceNode = graph.nodes.find((node) => node.kind === "File" && node.path === "src/message.mjs");
  const featureNode = graph.nodes.find((node) => node.kind === "Feature" && node.key === "send");
  assert.ok(sourceNode && featureNode);
  const proposed = await startFeatureMapping({
    root,
    semanticProposal: {
      schemaVersion: 1,
      sourceSnapshotId: graph.sourceSnapshotId,
      productModelId: world.productModel.productModelId,
      candidates: [{
        relationshipType: "IMPLEMENTS",
        sourceNodeId: sourceNode.nodeId,
        productNodeId: featureNode.nodeId,
        explanation: "The source implements the reviewed messaging feature.",
        confidence: 1,
      }],
    },
  });
  await reviewFeatureMapping({
    root,
    candidateSetId: proposed.candidateSet.candidateSetId,
    disposition: "accept-all",
    rationale: "The fixture explicitly reviews the exact mapping.",
  });

  const capsule = (await compileContext({ root, task: "Change the message implementation", budget: 32768, persist: true }));
  const plan = createWholePlanSnapshot({
    root,
    objective: "Change the implementation with reviewed lineage",
    plan: [{ id: "implement", outcome: "Verified changed implementation" }],
  });
  const contract = createExecutionContract({
    root,
    wholePlanId: plan.artifact.wholePlanId,
    capsuleId: capsule.capsule.capsuleId,
    scope: "Change the fixture implementation",
    acceptanceCriteria: ["Return exact fixture evidence"],
  });
  startRun({ root, executionContractId: contract.artifact.executionContractId });
  fs.appendFileSync(path.join(root, "src", "message.mjs"), "export const changed = true;\n");
  const finished = finishRun({
    root,
    outcome: "Fixture changed",
    evidence: [{ uri: "src/message.mjs", digest: "generic-contained-fixture", summary: "Changed implementation" }],
    verification: [{ check: "generic contained fixture", status: "passed" }],
  });
  const pending = getPendingReviewContext({ root });
  const executionReview = reviewRun({
    root,
    reviewContextId: pending.review.reviewContextId,
    disposition: "accept",
    rationale: "The contained fixture execution was explicitly reviewed.",
  });
  await buildWorldModel({ root, persist: true });
  const recordRequest = {
    root,
    resultPacketId: finished.resultPacket.resultPacketId,
    reviewDecisionId: executionReview.reviewDecision.reviewDecisionId,
  };
  const recorded = await recordChangeSet(recordRequest);
  assert.equal(recorded.status, "awaiting_change_impact_review");
  assert.ok(recorded.candidateSet.candidates.length > 0);
  const reviewRequest = {
    root,
    candidateSetId: recorded.candidateSet.candidateSetId,
    disposition: "accept-all",
    rationale: "The exact contained impact candidates are explicitly accepted.",
  };
  return { root, layout, recordRequest, recorded, reviewRequest };
}

test("stale Change impact candidates remain explicitly rejectable without another gate", async (t) => {
  const fixture = await changeSetFixture(t, "stale-reject");
  const sessionBefore = headSessionState(fixture.root);
  fs.appendFileSync(path.join(fixture.root, "src", "message.mjs"), "export const laterWork = true;\n");
  await buildWorldModel({ root: fixture.root, persist: true });

  await assert.rejects(() => reviewChangeImpact(fixture.reviewRequest), (error) => error.code === "CHANGE_IMPACT_SOURCE_DRIFT");
  const rejectedRequest = {
    ...fixture.reviewRequest,
    disposition: "reject",
    rationale: "The exact historical candidate set is obsolete and is explicitly rejected.",
  };
  const rejected = await reviewChangeImpact(rejectedRequest);
  assert.equal(rejected.status, "change_impacts_rejected");
  assert.equal((await inspectChangeSets({ root: fixture.root })).status, "rejected");
  assert.equal((await reviewChangeImpact(rejectedRequest)).reusedReviewDecision, true);

  const rerecord = await captureError(async () => (await recordChangeSet(fixture.recordRequest)));
  assert.notEqual(rerecord.error?.code, "CHANGE_IMPACT_REVIEW_REQUIRED");
  assert.deepEqual(headSessionState(fixture.root), sessionBefore);
});

test("Change impact review recovers exact P1 decisions across durable write boundaries", async (t) => {
  for (const boundary of ["decision", "projection", "state"]) {
    await t.test(boundary, async (subtest) => {
      const fixture = await changeSetFixture(subtest, `boundary-${boundary}`);
      const realRename = fs.renameSync;
      const worldPointer = path.resolve(fixture.root, fixture.layout.directory, "world-model", "current.json");
      const statePointer = path.resolve(fixture.root, fixture.layout.directory, "change-sets", "current.json");
      let injected = false;
      try {
        fs.renameSync = function (from, to) {
          const target = path.resolve(String(to));
          const decisionTarget = target.includes(`${path.sep}${fixture.layout.directory}${path.sep}change-sets${path.sep}impact-review-decisions${path.sep}`)
            && path.basename(target).startsWith("change-impact-review-decision-");
          const matches = boundary === "decision" ? decisionTarget : boundary === "projection" ? target === worldPointer : target === statePointer;
          if (!injected && matches) {
            injected = true;
            throw Object.assign(new Error(`Injected ${boundary} boundary failure`), { code: "EIO" });
          }
          return realRename.apply(this, arguments);
        };
        await assert.rejects(() => reviewChangeImpact(fixture.reviewRequest), (error) => error.code === "EIO");
      } finally {
        fs.renameSync = realRename;
      }
      assert.equal(injected, true);
      assert.equal(reviewFiles(fixture.root, fixture.layout).length, boundary === "decision" ? 0 : 1);

      if (boundary !== "decision") {
        const divergent = await captureError(() => reviewChangeImpact({
          ...fixture.reviewRequest,
          rationale: "A divergent retry must not replace the saved user decision.",
        }));
        assert.equal(divergent.error?.code, "CHANGE_IMPACT_REVIEW_CONFLICT");
        assert.equal(reviewFiles(fixture.root, fixture.layout).length, 1);
        const pending = (await inspectChangeSets({ root: fixture.root }));
        assert.equal(pending.reviewRecovery?.requiresNewUserDecision, false);
      }

      const recovered = await reviewChangeImpact(fixture.reviewRequest);
      assert.equal(recovered.status, "change_impacts_reviewed");
      assert.equal(recovered.reusedReviewDecision, boundary !== "decision");
      assert.equal(reviewFiles(fixture.root, fixture.layout).length, 1);
      assert.equal((await inspectChangeSets({ root: fixture.root })).status, "reviewed");
      assert.equal((await inspectWorldModel({ root: fixture.root })).status, "current");
      assert.equal((await reviewChangeImpact(fixture.reviewRequest)).reusedReviewDecision, true);
    });
  }
});

test("legacy orphan P4 cannot authorize a divergent review but exact user intent can repair it", async (t) => {
  const fixture = await changeSetFixture(t, "orphan-projection");
  const stateFile = path.join(fixture.root, fixture.layout.directory, "change-sets", "current.json");
  const pendingState = fs.readFileSync(stateFile, "utf8");
  const accepted = await reviewChangeImpact(fixture.reviewRequest);
  const reviewFile = path.join(fixture.root, fixture.layout.directory, "change-sets", "impact-review-decisions", `${accepted.reviewDecision.reviewDecisionId}.json`);
  fs.unlinkSync(reviewFile);
  fs.writeFileSync(stateFile, pendingState);
  assert.equal((await inspectWorldModel({ root: fixture.root })).status, "stale");

  await assert.rejects(() => reviewChangeImpact({
    ...fixture.reviewRequest,
    rationale: "This changed intent must not inherit authority from Graph.",
  }), (error) => error.code === "CHANGE_IMPACT_SOURCE_DRIFT");
  assert.equal(reviewFiles(fixture.root, fixture.layout).length, 0);

  const repaired = await reviewChangeImpact(fixture.reviewRequest);
  assert.equal(repaired.status, "change_impacts_reviewed");
  assert.equal(repaired.reusedReviewDecision, false);
  assert.equal(reviewFiles(fixture.root, fixture.layout).length, 1);
  assert.equal((await inspectWorldModel({ root: fixture.root })).status, "current");
});

test("reviewed execution changes link exact source and Product revisions without claiming delivery", async (t) => {
  const fixture = await changeSetFixture(t, "exact-revision-lineage");
  await reviewChangeImpact(fixture.reviewRequest);
  const graph = (await inspectWorldModel({ root: fixture.root })).snapshot.temporalProvenanceGraph;
  const nodes = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const retainedChangeReferences = graph.nodes.filter((node) => node.kind === "ChangeRevisionReference" && nodes.has(node.referencedRevisionId));
  assert.ok(retainedChangeReferences.length > 0);
  for (const reference of retainedChangeReferences) {
    assert.ok(graph.edges.some((edge) => edge.type === "REFERENCES" && edge.from === reference.nodeId && edge.to === reference.referencedRevisionId));
  }
  const currentImpacts = graph.nodes.filter((node) => node.kind === "ReviewedImpact" && node.projectionStatus === "current");
  assert.ok(currentImpacts.length > 0);
  for (const impact of currentImpacts) {
    assert.ok(graph.edges.some((edge) => edge.type === "AT_REVISION" && edge.from === impact.nodeId && edge.to === impact.targetRevisionId));
  }
  assert.equal(graph.nodes.some((node) => node.kind === "ReleaseObservation"), false);
  assert.equal(graph.nodes.some((node) => node.kind === "DeploymentResultObservation"), false);
});


test("ChangeSet record 0.3 pins World endpoints while legacy originals and auxiliary contracts stay unchanged", async (t) => {
  const f = await changeSetFixture(t, "world-endpoints");
  const record = f.recorded.changeSet;
  assert.equal(record.protocol.version, CHANGE_SET_RECORD_VERSION);
  assert.equal(CHANGE_SET_VERSION, "0.2.0");
  assert.equal(f.recorded.candidateSet.protocol.version, "0.2.0");
  for (const endpoint of [record.before, record.after]) {
    assert.deepEqual(Object.keys(endpoint).sort(), ["graphSnapshotId", "sourceSnapshotId", "worldModelId"]);
    const retained = (await readWorldModelSnapshot({ root: f.root, worldModelId: endpoint.worldModelId })).snapshot;
    assert.equal(retained.projectId, record.projectId);
    assert.equal(retained.temporalProvenanceGraph.graphSnapshotId, endpoint.graphSnapshotId);
    assert.equal(retained.temporalProvenanceGraph.sourceSnapshotId, endpoint.sourceSnapshotId);
  }
  const signed = (mutate) => {
    const payload = structuredClone(record); delete payload.changeSetId; delete payload.changeSetHash; mutate(payload);
    const hash = changeSetDigest(changeSetCanonicalJson(payload));
    return { ...payload, changeSetId: "change-set-" + hash.slice(0, 24), changeSetHash: hash };
  };
  for (const version of ["0.1.0", "0.2.0"]) {
    const legacy = signed(d => { d.protocol.version = version; delete d.before.worldModelId; delete d.after.worldModelId; });
    const bytes = JSON.stringify(legacy), digest = changeSetDigest(bytes), id = legacy.changeSetId;
    assert.equal(verifyChangeSet(legacy, record.projectId, f.layout), legacy);
    assert.equal(JSON.stringify(legacy), bytes); assert.equal(changeSetDigest(bytes), digest); assert.equal(legacy.changeSetId, id);
    assert.throws(() => verifyChangeSet(signed(d => { d.protocol.version = version; }), record.projectId, f.layout), { code: "INVALID_CHANGE_SET_SNAPSHOT_REFERENCE" });
  }
  for (const mutate of [d => { delete d.before.worldModelId; }, d => { d.after.extra = true; }, d => { d.before.worldModelId = "invalid"; }]) {
    assert.throws(() => verifyChangeSet(signed(mutate), record.projectId, f.layout), { code: "INVALID_CHANGE_SET_SNAPSHOT_REFERENCE" });
  }
  assert.throws(() => verifyChangeSet(signed(d => { d.protocol.version = "0.4.0"; }), record.projectId, f.layout), { code: "INVALID_CHANGE_SET" });
  const reviewed = await reviewChangeImpact(f.reviewRequest);
  assert.equal(reviewed.reviewDecision.protocol.version, "0.2.0");
  const state = JSON.parse(fs.readFileSync(path.join(f.root, f.layout.directory, "change-sets", "current.json"), "utf8"));
  assert.equal(state.protocol.version, "0.2.0");
});
