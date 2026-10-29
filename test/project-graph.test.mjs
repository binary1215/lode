import { readFixtureSnapshot } from "./helpers/snapshot-storage-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";
import { createWholePlanSnapshot, createExecutionContract, createResultPacket, createReviewDecision, buildFreshHeadReview } from "../scripts/lib/execution-lineage.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { startRun } from "../scripts/lib/run-lineage.mjs";
import { proposeProductPolicy, reviewProductPolicy } from "../scripts/lib/product-policy.mjs";
import { prepareSourceContext } from "../scripts/lib/source-context-workflow.mjs";
import { readSourceObservation } from "../scripts/lib/source-observation.mjs";
import { buildWorldModel } from "../scripts/lib/world-model.mjs";
import { InMemoryGraphProjectionAdapter, materializeGraphProjection } from "../scripts/lib/graph-projection-adapter.mjs";
import { projectGraphIndexPath, projectGraphDigest } from "../scripts/lib/discovery-index.mjs";
import { indexProjectGraph, queryProjectGraph } from "../scripts/lib/project-graph.mjs";
import { startOnboarding, reviewOnboarding } from "../scripts/lib/onboarding.mjs";
import { historicalIntegrityBasis } from "../scripts/lib/historical-artifact-boundary-store.mjs";
import { publishHistoricalContinuityReceipt } from "../scripts/lib/historical-continuity.mjs";
import { buildGraphExplorerSnapshot } from "../scripts/lib/graph-explorer.mjs";
import { explorerDom } from "./helpers/graph-explorer-dom-fixture.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fixture(t, initialized = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "head-project-graph-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (initialized) initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = initialized ? inspectProject(root).storage : undefined;
  const layout = initialized ? formatForVerifiedOwner(storage) : undefined;
  fs.writeFileSync(path.join(root, "module.mjs"), "export const answer = 42;\n");
  return { root, storage, layout };
}
function headFiles(root, layout) {
  const result = {};
  const walk = (relative) => {
    const directory = path.join(root, relative);
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else result[next] = projectGraphDigest(fs.readFileSync(path.join(root, next)));
    }
  };
  if (layout) walk(layout.directory);
  else { walk(".head"); walk(".lode"); } // Deliberate no-init protection of both namespaces.
  return result;
}
async function observed(root, layout) {
  await prepareSourceContext({ root, task: "Inspect the exact answer source", needs: [{ kind: "source", path: "module.mjs" }], retain: true });
  return JSON.parse(fs.readFileSync(path.join(root, layout.directory, "graph-discovery", "index.json"), "utf8"));
}
function noAuthority(result) {
  for (const field of ["instructionAuthority", "promotionAuthority", "recoveryAuthority", "executionAuthority", "ordinaryWorkBlocked"]) assert.equal(result.authority[field], false);
  for (const node of result.nodes) for (const field of ["instructionAuthority", "promotionAuthority", "recoveryAuthority", "executionAuthority"]) assert.equal(node[field], false);
  for (const edge of result.edges) for (const field of ["instructionAuthority", "promotionAuthority", "recoveryAuthority", "executionAuthority"]) assert.equal(edge[field], false);
}

test("compact Run and Session state preserves active/unknown status and ownership without effects", async t => {
  const { root, storage, layout } = fixture(t);
  const capsule = (await compileContext({ root, task: "Inspect synthetic request", persist: true })).capsule;
  const plan = createWholePlanSnapshot({ root, objective: "Inspect synthetic request", plan: ["Read local fixture"] }).artifact;
  const contract = createExecutionContract({ root, wholePlanId: plan.wholePlanId, capsuleId: capsule.capsuleId,
    scope: "Synthetic read", acceptanceCriteria: ["Observed local fixture"] }).artifact;
  const started = startRun({ root, executionContractId: contract.executionContractId });
  const runId = started.run.runId, sessionId = started.state.sessionId;
  const runFile = path.join(root, layout.directory, "sessions/runs", runId, "run.json");
  for (const status of ["active", "unknown"]) {
    // Synthetic retained-state fixture, not an execution transition or repair.
    const run = JSON.parse(fs.readFileSync(runFile, "utf8"));
    run.status = status;
    if (status === "unknown") run.unknowns = ["Delivery acknowledgement remains unresolved"];
    fs.writeFileSync(runFile, JSON.stringify(run));
    const before = headFiles(root, layout);
    const compact = await queryProjectGraph({ root, anchorIds: [runId], depth: 0 });
    const detail = await queryProjectGraph({ root, ...compact.nodes[0].detail });
    assert.equal(compact.nodes[0].status, status);
    assert.equal(detail.nodes[0].status, status);
    assert.equal(compact.nodes[0].sessionId, sessionId);
    assert.equal(compact.nodes[0].runId, runId);
    assert.equal(compact.nodes[0].revisionId, detail.nodes[0].revisionId);
    assert.deepEqual(compact.nodes[0].sourceReference, detail.nodes[0].sourceReference);
    // Active status does not make the compact navigation a full Run original.
    assert.equal(compact.nodes[0].contentPartial, true);
    assert(compact.sourceFallback.reasonCodes.includes("PROJECT_GRAPH_COMPACT_CONTENT_PARTIAL"));
    if (status === "unknown") {
      assert(compact.nodes[0].excerpt.includes(run.unknowns[0]));
      assert.deepEqual(detail.nodes[0].unknowns, run.unknowns);
      assert(compact.sourceFallback.reasonCodes.includes("PROJECT_GRAPH_COMPACT_CONTENT_PARTIAL"));
    }
    const session = await queryProjectGraph({ root, anchorIds: [sessionId], depth: 0 });
    const sessionDetail = await queryProjectGraph({ root, ...session.nodes[0].detail });
    assert.equal(session.nodes[0].mode, "run");
    assert.equal(session.nodes[0].activeRunId, runId);
    assert.equal(session.nodes[0].sessionId, sessionId);
    for (const field of ["mode", "activeRunId", "sessionId", "latestCheckpoint", "revisionId"]) {
      assert.deepEqual(session.nodes[0][field], sessionDetail.nodes[0][field]);
    }
    const related = await queryProjectGraph({ root, anchorIds: [sessionId], depth: 1 });
    assert(related.edges.some(edge => edge.type === "ACTIVE_RUN" && edge.from === sessionId && edge.to === runId));
    assert(related.edges.some(edge => edge.type === "RECORDED_FOR_SESSION" && edge.from === runId && edge.to === sessionId));
    assert.equal(related.nodes.find(node => node.nodeId === runId).status, status);
    for (const result of [compact, detail, session, sessionDetail, related]) noAuthority(result);
    assert.deepEqual(headFiles(root, layout), before);
  }
});

test("compact named-content omissions remain partial even when the search excerpt is short", async t => {
  const { root, storage, layout } = fixture(t);
  const plan = createWholePlanSnapshot({ root, objective: "Inspect a short objective", plan: ["Read local fixture"] }).artifact;
  const before = headFiles(root, layout);
  const compact = await queryProjectGraph({ root, anchorIds: [plan.wholePlanId], depth: 0 });
  const detail = await queryProjectGraph({ root, ...compact.nodes[0].detail });
  assert(compact.nodes[0].excerpt.includes(plan.objective));
  assert(compact.nodes[0].excerpt.length < 360);
  assert.equal(compact.nodes[0].objective, undefined);
  assert.equal(detail.nodes[0].objective, plan.objective);
  assert.equal(compact.nodes[0].contentPartial, true);
  assert(compact.sourceFallback.reasonCodes.includes("PROJECT_GRAPH_COMPACT_CONTENT_PARTIAL"));
  assert.deepEqual(headFiles(root, layout), before);
  noAuthority(compact); noAuthority(detail);
});

test("observed ingestion shares one replaceable inventory; core-only graph reads reuse exact originals", async t => {
  const { root, storage, layout } = fixture(t), index = await observed(root, layout);
  assert(index.entries.some(entry => entry.path.includes("source-bundles")));
  assert(index.entries.some(entry => entry.path.includes("records/by-source-key")));
  assert(index.entries.every(entry => Object.keys(entry).sort().join(",") === "bytes,path,sha256"));
  assert.equal(indexProjectGraph({ root }).status, "reused");
  const before = headFiles(root, layout), first = await queryProjectGraph({ root, query: "module.mjs", depth: 2 });
  const observation = first.nodes.find(node => node.kind === "ObservationRecord");
  assert(observation);
  assert(first.nodes.some(node => node.kind === "FileRevisionReference" && node.path === "module.mjs"));
  assert(first.edges.some(edge => edge.type === "OBSERVES_EXACT_REVISION"));
  assert.equal(first.coverage.emptyResultProvesAbsence, false);
  assert.equal(first.freshness.wholeWorldCurrentRequired, false);
  const second = await queryProjectGraph({ root, query: "module.mjs", depth: 2, previousResult: first });
  assert.equal(first.resultId, second.resultId);
  assert.equal(second.reuse.status, "same-basis-result-reused");
  const work = await queryProjectGraph({ root, anchorIds: [observation.nodeId], view: "work" });
  const product = await queryProjectGraph({ root, anchorIds: [observation.nodeId], view: "product" });
  assert.equal(work.nodes[0].nodeId, product.nodes[0].nodeId);
  assert.deepEqual(headFiles(root, layout), before);
  assert(!fs.existsSync(path.join(root, layout.directory, "world-model/current.json")));
  noAuthority(first);
});

test("selected source currentness reads only selected paths and refreshes same-size bytes across requests", async t => {
  const { root, layout } = fixture(t);
  fs.writeFileSync(path.join(root, "unrelated.mjs"), "export const unrelated = 7;\n");
  await prepareSourceContext({ root, task: "Observe two independent source files", needs: [
    { kind: "source", path: "module.mjs" }, { kind: "source", path: "unrelated.mjs" }], retain: true });
  const read = fs.readFileSync, calls = [];
  t.mock.method(fs, "readFileSync", function(file, ...args) {
    if ([path.join(root, "module.mjs"), path.join(root, "unrelated.mjs")].includes(String(file))) calls.push(String(file));
    return read.call(this, file, ...args);
  });
  const query = { root, paths: ["module.mjs"], depth: 1, details: true };
  const first = await queryProjectGraph(query);
  assert(first.nodes.some(node => node.sourceCurrentness?.path === "module.mjs"));
  assert(first.nodes.some(node => node.kind === "ObservationRecord" && node.sourceCurrentness?.path === "module.mjs"),
    "the retained source-path alias must still admit its Observation, not just the file reference");
  assert.equal(calls.filter(file => file === path.join(root, "unrelated.mjs")).length, 0);
  assert.equal(first.basis.sourceCurrentnessScope, "selected-nodes-and-edge-endpoints");
  const target = path.join(root, "module.mjs"), stat = fs.statSync(target);
  fs.writeFileSync(target, "export const answer = 99;\n"); fs.utimesSync(target, stat.atime, stat.mtime);
  const second = await queryProjectGraph(query);
  assert.notEqual(first.basis.sourceCurrentnessDigest, second.basis.sourceCurrentnessDigest);
  for (const edge of second.edges) for (const endpoint of edge.endpointStates) {
    assert.equal(endpoint.freshness, second.nodes.find(node => node.nodeId === endpoint.nodeId).freshness);
  }
  assert(second.nodes.some(node => node.sourceCurrentness?.freshness === "historical-source-bytes"));
  noAuthority(second);
});

test("retained source revisions survive changes and disappearances; current effects still reject drift", async t => {
  const { root, storage, layout } = fixture(t), index = await observed(root, layout);
  const bundlePath = index.entries.find(entry => entry.path.includes("source-bundles")).path;
  const key = path.basename(bundlePath, ".json"), projectId = inspectProject(root).project.projectId;
  const first = await queryProjectGraph({ root, query: "module.mjs" });
  fs.writeFileSync(path.join(root, "module.mjs"), "export const answer = 99;\n");
  const before = headFiles(root, layout), second = await queryProjectGraph({ root, query: "module.mjs", previousResult: first });
  assert.notEqual(second.basis.sourceCurrentnessDigest, first.basis.sourceCurrentnessDigest);
  assert(second.nodes.some(node => node.freshness === "historical-source-bytes"));
  assert.throws(() => readSourceObservation(root, projectId, key, { storage }), { code: "SOURCE_DRIFT" });
  assert(readSourceObservation(root, projectId, key, { requireCurrent: false, storage }));
  fs.unlinkSync(path.join(root, "module.mjs"));
  const third = await queryProjectGraph({ root, query: "module.mjs" });
  assert(third.nodes.some(node => node.freshness === "unavailable"));
  assert.equal(third.authority.ordinaryWorkBlocked, false);
  assert.deepEqual(headFiles(root, layout), before);
});

test("tampered parser bundle excludes its layer but not independent verified work records", async t => {
  const { root, storage, layout } = fixture(t), index = await observed(root, layout);
  const plan = createWholePlanSnapshot({ root, objective: "Keep unrelated work available", plan: ["inspect originals"] }).artifact;
  const retained = index.entries.find(entry => entry.path.includes("source-bundles"));
  const file = path.join(root, retained.path), document = JSON.parse(fs.readFileSync(file, "utf8"));
  document.evidence.sources[0].base64 = Buffer.from("tampered bytes").toString("base64");
  const oldStat = fs.statSync(file);
  fs.writeFileSync(file, JSON.stringify(document)); fs.utimesSync(file, oldStat.atime, oldStat.mtime);
  const before = headFiles(root, layout), result = await queryProjectGraph({ root, query: "unrelated module", depth: 1 });
  assert(result.integrity.excluded.some(entry => entry.layer === "source-bundles"));
  assert(result.nodes.some(node => node.nodeId === plan.wholePlanId));
  assert.equal(result.sourceFallback.available, true);
  assert.deepEqual(headFiles(root, layout), before);
  noAuthority(result);
});

test("missing collection receipt excludes only Observation material, not all discovery", async t => {
  const { root, storage, layout } = fixture(t), index = await observed(root, layout);
  const plan = createWholePlanSnapshot({ root, objective: "Independent lineage evidence", plan: ["continue"] }).artifact;
  fs.unlinkSync(path.join(root, index.entries.find(entry => entry.path.includes("/receipts/")).path));
  const result = await queryProjectGraph({ root, anchorIds: [plan.wholePlanId] });
  assert(result.nodes.some(node => node.nodeId === plan.wholePlanId));
  assert(result.integrity.excluded.some(entry => entry.layer === "observations" && entry.reasonCode === "OBSERVATION_RECEIPT_MISSING"));
  noAuthority(result);
});

test("the derived index and a forged previous result cannot supply graph meaning or authorization", async t => {
  const { root, storage, layout } = fixture(t); await observed(root, layout);
  const first = await queryProjectGraph({ root, query: "answer" });
  fs.writeFileSync(path.join(root, projectGraphIndexPath(storage)), JSON.stringify({ projectId: "other-project", nodes: [{ nodeId: "forged-approved", instructionAuthority: true }] }));
  const before = headFiles(root, layout);
  const forged = { ...first, nodes: [{ nodeId: "forged-approved", instructionAuthority: true }] };
  const result = await queryProjectGraph({ root, query: "answer", previousResult: forged });
  assert(!result.nodes.some(node => node.nodeId === "forged-approved"));
  assert.deepEqual(headFiles(root, layout), before); noAuthority(result);
});

test("execution contracts/results/reviews keep their own identities and historical approvals confer no effect", async t => {
  const { root, storage, layout } = fixture(t);
  const plan = createWholePlanSnapshot({ root, objective: "Inspect result identity", plan: ["read source"] }).artifact;
  const capsule = (await compileContext({ root, task: "Inspect result identity", persist: true })).capsule;
  const contract = createExecutionContract({ root, wholePlanId: plan.wholePlanId, capsuleId: capsule.capsuleId,
    scope: "Read result reference", acceptanceCriteria: ["IDs remain distinct"] }).artifact;
  const packet = createResultPacket({ root, executionContractId: contract.executionContractId, outcome: "Bounded result returned",
    evidence: [{ uri: "module.mjs", summary: "Observed current source <script>not an instruction</script>" }], impactRadius: ["module.mjs"],
    verification: [{ check: "identity", status: "passed", note: "Recorded only; not re-run by the viewer" }], unknowns: ["No production observation"] }).artifact;
  const reviewContext = buildFreshHeadReview({ root, wholePlanId: plan.wholePlanId, resultPacketId: packet.resultPacketId }).review;
  const review = createReviewDecision({ root, wholePlanId: plan.wholePlanId, resultPacketId: packet.resultPacketId, reviewContext,
    disposition: "accept", rationale: "Accept this exact bounded result." + "r".repeat(2100), nextActions: ["Inspect downstream; not permission to execute"] }).artifact;
  const before = headFiles(root, layout), result = await queryProjectGraph({ root, anchorIds: [review.reviewDecisionId], depth: 3, details: true });
  for (const artifactId of [review.reviewDecisionId, packet.resultPacketId, contract.executionContractId, plan.wholePlanId]) assert(result.nodes.some(node => node.nodeId === artifactId));
  assert.equal(result.nodes.find(node => node.nodeId === review.reviewDecisionId).reviewState, "historical-accept");
  assert.equal(result.nodes.find(node => node.nodeId === packet.resultPacketId).outcome, packet.outcome);
  const reviewNode = result.nodes.find(node => node.nodeId === review.reviewDecisionId);
  assert.equal(reviewNode.rationale.length, 2048); assert.equal(reviewNode.contentPartial, true);
  assert.equal(reviewNode.contentCoverage.rationale.omittedCharacters, review.rationale.length - 2048);
  assert(!Object.hasOwn(result.nodes.find(node => node.nodeId === packet.resultPacketId), "verification"), "All-node navigation must not duplicate unbounded result bodies");
  assert(result.contextLineage.recordedReasons.find(item => item.nodeId === review.reviewDecisionId).contentPartial);
  const report = await buildGraphExplorerSnapshot({ root, anchorIds: [review.reviewDecisionId] }), ui = explorerDom(report);
  assert.match(ui.ids.get("original").textContent, /Recorded next action \(not execution permission\)/);
  const resultEntry = ui.ids.get("records").querySelectorAll("[data-record-entry]").find(button => button.getAttribute("data-record-entry") === packet.resultPacketId);
  ui.event(resultEntry);
  for (const field of ["Recorded check / verification", "Recorded evidence", "Recorded impact radius", "not re-run by the viewer"]) assert(ui.ids.get("original").textContent.includes(field), field);
  noAuthority(result); assert.deepEqual(headFiles(root, layout), before);
});

test("World-independent decision flow preserves ChangeSet parents and onboarding producer versus acceptance", async t => {
  const { root, storage, layout } = fixture(t);
  const started = await startOnboarding({ root, mode: "new", brief: { schemaVersion: 1, name: "Generic local service", summary: "Inspect local evidence.",
    capabilities: [{ key: "inspect", name: "Inspect", description: "Read evidence." }] } });
  const candidate = started.candidateSet.candidates[0];
  const revised = await reviewOnboarding({ root, candidateSetId: started.candidateSet.candidateSetId, disposition: "revise", rationale: "Keep the original proposal; review a successor separately.",
    userEdits: [{ candidateId: candidate.candidateId, entity: { ...candidate.proposedEntity, description: "Read exact evidence, not inferred causes." } }] });
  const successor = revised.candidateSet;
  assert(successor?.candidateSetId && successor.candidateSetId !== started.candidateSet.candidateSetId);
  const accepted = await reviewOnboarding({ root, candidateSetId: successor.candidateSetId, disposition: "accept-all", rationale: "Accept the successor, not its producing review." });
  // Contract-valid synthetic retained ChangeSets, not Run execution/causality.
  const make = (parents, hex) => {
    const change = { changeKind: "modified", entityKind: "File", logicalEntityId: "generic-file", beforeRevisionId: "old-file", afterRevisionId: "new-file", path: "module.mjs" };
    const payload = { schemaVersion: 1, kind: "ChangeSet", protocol: { name: layout.protocol("head-agent-core-change-set"), version: "0.2.0" }, projectId: inspectProject(root).project.projectId,
      sessionId: "synthetic-session", resultPacketId: `result-packet-${hex.repeat(24)}`, reviewDecisionId: `review-decision-${hex.repeat(24)}`,
      reviewDisposition: "accept", authority: "reviewed-execution-change-lineage", instructionAuthority: false, promotionAuthority: false,
      parentChangeSetIds: parents, before: { sourceSnapshotId: `source-snapshot-${"a".repeat(24)}`, graphSnapshotId: `graph-snapshot-${"a".repeat(24)}` },
      after: { sourceSnapshotId: `source-snapshot-${hex.repeat(24)}`, graphSnapshotId: `graph-snapshot-${hex.repeat(24)}` },
      changes: [{ ...change, changeId: `change-record-${projectGraphDigest(change).slice(0, 24)}` }] };
    const document = fixtureIdentity(payload, "changeSetId", "changeSetHash", "change-set");
    const directory = path.join(root, layout.directory, "change-sets/records"); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, document.changeSetId + ".json"), JSON.stringify(document)); return document;
  };
  const parent = make([], "b"), child = make([parent.changeSetId], "c");
  const worldDirectory = path.join(root, layout.directory, "world-model");
  if (fs.existsSync(worldDirectory)) fs.renameSync(worldDirectory, path.join(root, "world-fixture-not-selected"));
  const before = headFiles(root, layout), result = await queryProjectGraph({ root, anchorIds: [child.changeSetId, successor.candidateSetId], details: true, depth: 2 });
  const has = (type, from, to) => result.edges.some(edge => edge.type === type && edge.from === from && edge.to === to);
  assert(has("SUPERSEDES", child.changeSetId, parent.changeSetId));
  assert(has("PARENT_OF", started.candidateSet.candidateSetId, successor.candidateSetId));
  assert(has("PRODUCES", revised.reviewDecision.reviewDecisionId, successor.candidateSetId));
  assert(has("REVIEWS", accepted.reviewDecision.reviewDecisionId, successor.candidateSetId));
  assert.notEqual(revised.reviewDecision.reviewDecisionId, accepted.reviewDecision.reviewDecisionId);
  assert.equal(result.coverage.layers.find(layer => layer.layer === "world").status, "absent");
  noAuthority(result); assert.deepEqual(headFiles(root, layout), before);
});

test("exact rejected Policy remains visible as rejected even without World or ready generated installation", async t => {
  const { root, storage, layout } = fixture(t);
  const proposed = await proposeProductPolicy({ root, operation: "create", key: "quartz-review-rule", name: "QuartzNebulaPolicy", statement: "QuartzNebulaClause forbids unattended deployment." });
  const candidate = proposed.candidate;
  for (const query of [candidate.policyKey, candidate.proposedPolicy.name, "QuartzNebulaClause"]) {
    const pending = await queryProjectGraph({ root, query, depth: 0 });
    assert.equal(pending.nodes.find(node => node.nodeId === candidate.candidateId).reviewState, "candidate");
    noAuthority(pending);
  }
  await reviewProductPolicy({ root, candidateId: proposed.candidate.candidateId, disposition: "reject", rationale: "Do not adopt this policy." });
  fs.appendFileSync(path.join(root, layout.directory, `generated/${layout.dialect}-instructions.md`), "\nlocal change\n");
  const before = headFiles(root, layout), result = await queryProjectGraph({ root, anchorIds: [proposed.candidate.candidateId], depth: 1, details: true });
  assert.equal(result.nodes.find(node => node.nodeId === proposed.candidate.candidateId).reviewState, "rejected");
  assert(result.summary.reviewStates.rejected > 0);
  assert(result.edges.some(edge => edge.endpointStates.some(endpoint => endpoint.reviewState === "rejected")));
  const node = result.nodes.find(node => node.nodeId === candidate.candidateId);
  assert.deepEqual(node.proposedPolicy, Object.fromEntries(["key", "name", "statement", "description"].filter(key => typeof candidate.proposedPolicy[key] === "string").map(key => [key, candidate.proposedPolicy[key]])));
  for (const field of ["policyKey", "baseProductModelId", "resultingProductModelId"]) assert.equal(node[field], candidate[field]);
  assert.equal(node.revisionId, candidate.candidateId);
  const endpoint = result.edges.flatMap(edge => edge.endpointStates).find(state => state.nodeId === candidate.candidateId);
  assert.equal(endpoint.baseProductModelId, candidate.baseProductModelId);
  assert.equal(endpoint.resultingProductModelId, candidate.resultingProductModelId);
  assert.equal(endpoint.proposedPolicy.statement, candidate.proposedPolicy.statement);
  const summarized = result.summary.policyReferences.find(state => state.nodeId === candidate.candidateId);
  assert.deepEqual(summarized, endpoint);
  for (const query of [candidate.policyKey, candidate.proposedPolicy.name, "QuartzNebulaClause"]) {
    const searched = await queryProjectGraph({ root, query, depth: 1 });
    assert.equal(searched.nodes.find(node => node.nodeId === candidate.candidateId).reviewState, "rejected");
    noAuthority(searched);
  }
  assert.equal(result.coverage.layers.find(layer => layer.layer === "world").status, "absent");
  noAuthority(result); assert.deepEqual(headFiles(root, layout), before);
});

async function onboardingFixture(t) {
  const { root, storage, layout } = fixture(t);
  const started = await startOnboarding({ root, mode: "new", brief: { schemaVersion: 1, name: "Synthetic service",
    summary: "Deliver one reviewed message.", capabilities: [{ key: "delivery", name: "Delivery", description: "Deliver a message." }] } });
  const reviewed = await reviewOnboarding({ root, candidateSetId: started.candidateSet.candidateSetId,
    disposition: "accept-all", rationale: "Synthetic acceptance." });
  return { root, storage, layout, started, reviewed };
}
async function assertWarmCold(root, options, previous) {
  const warm = await queryProjectGraph({ root, ...options, previousResult: previous });
  const coldModule = await import(`../scripts/lib/project-graph.mjs?dependency-test=${Math.random()}`);
  const cold = await coldModule.queryProjectGraph({ root, ...options });
  assert.deepEqual(warm.integrity, cold.integrity);
  assert.deepEqual(warm.coverage, cold.coverage);
  assert.equal(warm.resultId, cold.resultId, JSON.stringify(Object.keys(warm).filter(key => JSON.stringify(warm[key]) !== JSON.stringify(cold[key])).map(key => [key, warm[key], cold[key]])));
  noAuthority(warm); return warm;
}

test("historical dependency add/change/remove and unexpected directory entries invalidate warm discovery only in onboarding", async t => {
  const { root, storage, layout, started } = await onboardingFixture(t);
  const plan = createWholePlanSnapshot({ root, objective: "Independent original work", plan: ["read source"] }).artifact;
  const options = { anchorIds: [started.candidateSet.candidateSetId, plan.wholePlanId], depth: 1 };
  const original = await queryProjectGraph({ root, ...options });
  const boundaryDirectory = path.join(root, layout.directory, "onboarding/historical-boundaries/historical-boundary-aaaaaaaaaaaaaaaaaaaaaaaa");
  fs.mkdirSync(boundaryDirectory, { recursive: true });
  const file = path.join(boundaryDirectory, "boundary.json"); fs.writeFileSync(file, "{broken");
  const before = headFiles(root, layout), broken = await assertWarmCold(root, options, original);
  assert.notEqual(broken.resultId, original.resultId);
  assert(broken.integrity.excluded.some(item => item.layer === "onboarding" && item.reasonCode === "INVALID_HISTORICAL_BOUNDARY_JSON"));
  assert(broken.nodes.some(node => node.nodeId === plan.wholePlanId));
  assert.equal(broken.sourceFallback.available, true); assert.deepEqual(headFiles(root, layout), before);
  fs.writeFileSync(file, "{}");
  const changed = await assertWarmCold(root, options, broken);
  assert(changed.integrity.excluded.some(item => item.layer === "onboarding" && item.reasonCode === "INVALID_HISTORICAL_BOUNDARY"));
  fs.unlinkSync(file);
  const missing = await assertWarmCold(root, options, changed);
  assert(missing.integrity.excluded.some(item => item.layer === "onboarding"));
  fs.rmdirSync(boundaryDirectory);
  const restored = await assertWarmCold(root, options, missing);
  assert(!restored.integrity.excluded.some(item => item.layer === "onboarding"));
  fs.writeFileSync(path.join(root, layout.directory, "onboarding/historical-boundaries/unexpected.txt"), "unexpected");
  const nonJson = await assertWarmCold(root, options, restored);
  assert(nonJson.integrity.excluded.some(item => item.layer === "onboarding" && item.reasonCode === "INVALID_HISTORICAL_BOUNDARY_PATH"));
});

function fixtureIdentity(payload, idField, hashField, prefix) {
  const digest = projectGraphDigest(payload);
  return { ...payload, [idField]: `${prefix}-${digest.slice(0, 24)}`, [hashField]: digest };
}
function committedHistoricalFixture(root, candidateSet, storage, layout) {
  const originals = headFiles(root, layout), projectId = inspectProject(root).project.projectId;
  const entries = Object.keys(originals).filter(file => file === `${layout.directory}/onboarding/candidate-sets/${candidateSet.candidateSetId}.json`
    || file.startsWith(`${layout.directory}/onboarding/review-decisions/`) || file === `${layout.directory}/onboarding/product-model-revisions/${candidateSet.productModelId}.json`
    || file.startsWith(`${layout.directory}/world-model/snapshots/`)).map(file => {
    const bytes = fs.readFileSync(path.join(root, file)), document = file.endsWith(".json.gz") ? readFixtureSnapshot(path.join(root,file)) : JSON.parse(bytes);
    const role = file.includes("/candidate-sets/") ? "historical-candidate-set" : file.includes("/review-decisions/") ? "historical-review"
      : file.includes("/product-model-revisions/") ? "historical-product-revision" : "legacy-world-embedding-reference";
    return { path: file, role, artifactId: role === "historical-candidate-set" ? document.candidateSetId : role === "historical-review" ? document.reviewDecisionId
      : role === "historical-product-revision" ? document.productModelId : document.worldModelId,
      protocolFamily: document.protocol?.name || document.kind, protocolVersion: document.protocol?.version || String(document.schemaVersion),
      byteLength: bytes.length, sha256: projectGraphDigest(bytes), interpretationMode: role === "historical-product-revision" ? "current-typed-with-historical-provenance" : "opaque-historical" };
  }).sort((a, b) => a.path.localeCompare(b.path, "en"));
  const reviewPath = Object.keys(originals).find(file => file.startsWith(`${layout.directory}/onboarding/review-decisions/`));
  const review = JSON.parse(fs.readFileSync(path.join(root, reviewPath)));
  // Both base and accepted result revisions remain typed original evidence.
  const resultPath = `${layout.directory}/onboarding/product-model-revisions/${review.resultingProductModelId}.json`;
  if (!entries.some(entry => entry.path === resultPath)) {
    const bytes = fs.readFileSync(path.join(root, resultPath)), doc = JSON.parse(bytes);
    entries.push({ path: resultPath, role: "historical-product-revision", artifactId: doc.productModelId, protocolFamily: doc.protocol?.name || doc.kind,
      protocolVersion: doc.protocol?.version || String(doc.schemaVersion), byteLength: bytes.length, sha256: projectGraphDigest(bytes), interpretationMode: "current-typed-with-historical-provenance" });
    entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
  }
  const inventoryHash = projectGraphDigest({ projectId, entries });
  const payload = { schemaVersion: 1, kind: "HistoricalArtifactBoundary", protocol: { name: layout.protocol("head-agent-core-historical-artifact-boundary"), version: "0.1.0" }, projectId, inventoryHash, entries,
    validatedHistoricalApproval: { candidateSetId: candidateSet.candidateSetId, reviewDecisionId: review.reviewDecisionId, resultingProductModelId: review.resultingProductModelId },
    appliedAtBasis: { fixture: true }, authorityClass: "evidence", instructionAuthority: false, promotionAuthority: false };
  const boundary = { ...payload, boundaryId: `historical-boundary-${inventoryHash.slice(0, 24)}`, boundaryHash: projectGraphDigest(payload) };
  const receipt = fixtureIdentity({ schemaVersion: 1, kind: "HistoricalBoundaryApplicationReceipt", protocol: { name: layout.protocol("head-agent-core-historical-boundary-application"), version: "0.1.0" },
    projectId, boundaryId: boundary.boundaryId, boundaryHash: boundary.boundaryHash, inventoryHash,
    appliedAtBasisHash: projectGraphDigest(boundary.appliedAtBasis), authorityClass: "evidence", instructionAuthority: false, promotionAuthority: false }, "receiptId", "receiptHash", "historical-boundary-receipt");
  const commit = fixtureIdentity({ schemaVersion: 1, kind: "HistoricalBoundaryCommitMarker", protocol: { name: layout.protocol("head-agent-core-historical-boundary-commit"), version: "0.1.0" },
    projectId, boundaryId: boundary.boundaryId, boundaryHash: boundary.boundaryHash, receiptId: receipt.receiptId, receiptHash: receipt.receiptHash, inventoryHash,
    historicalIntegrityBasisHash: projectGraphDigest(historicalIntegrityBasis(boundary, receipt)), authorityClass: "evidence", instructionAuthority: false, promotionAuthority: false }, "commitId", "commitHash", "historical-boundary-commit");
  const directory = path.join(root, layout.directory, "onboarding/historical-boundaries", boundary.boundaryId); fs.mkdirSync(directory, { recursive: true });
  for (const [name, doc] of Object.entries({ boundary, receipt, commit })) fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(doc));
  const nextPayload = { ...candidateSet, unknowns: [...candidateSet.unknowns,
    { unknownId: "onboarding-unknown-aaaaaaaaaaaaaaaaaaaaaaaa", statement: "Synthetic continuity uncertainty", evidenceIds: [], status: "open" }].sort((a, b) => a.unknownId.localeCompare(b.unknownId)) };
  delete nextPayload.candidateSetId; delete nextPayload.candidateSetHash;
  const current = fixtureIdentity(nextPayload, "candidateSetId", "candidateSetHash", "onboarding-candidates");
  fs.writeFileSync(path.join(root, layout.directory, "onboarding/candidate-sets", `${current.candidateSetId}.json`), JSON.stringify(current));
  return { boundary, receipt: publishHistoricalContinuityReceipt({ root, currentCandidateSet: current, storage }), current };
}

test("committed continuity and exact retained World dependencies agree warm/cold through tamper, deletion, restoration and addition", async t => {
  const { root, storage, layout, started } = await onboardingFixture(t);
  const retained = committedHistoricalFixture(root, started.candidateSet, storage, layout);
  const plan = createWholePlanSnapshot({ root, objective: "Preserve independent work", plan: ["continue"] }).artifact;
  const options = { anchorIds: [retained.current.candidateSetId, plan.wholePlanId], depth: 0 };
  let previous = await assertWarmCold(root, options);
  assert(previous.coverage.layers.some(layer => layer.layer === "onboarding" && layer.status === "verified"), JSON.stringify(previous.integrity.excluded));
  const continuity = path.join(root, layout.directory, "onboarding/historical-continuity", `${retained.receipt.receiptId}.json`);
  const original = fs.readFileSync(continuity);
  for (const content of [Buffer.from(JSON.stringify({ ...retained.receipt, relation: "PROMOTES" })), Buffer.from("{broken")]) {
    fs.writeFileSync(continuity, content); previous = await assertWarmCold(root, options, previous);
    assert(previous.integrity.excluded.some(item => item.layer === "onboarding"));
    assert(previous.nodes.some(node => node.nodeId === plan.wholePlanId));
  }
  fs.writeFileSync(continuity, original); previous = await assertWarmCold(root, options, previous);
  assert(!previous.integrity.excluded.some(item => item.layer === "onboarding"));
  fs.unlinkSync(continuity); previous = await assertWarmCold(root, options, previous);
  assert(!previous.integrity.excluded.some(item => item.layer === "onboarding"));
  fs.writeFileSync(continuity, original); previous = await assertWarmCold(root, options, previous);
  fs.writeFileSync(path.join(path.dirname(continuity), "extra.txt"), "invalid extra entry");
  previous = await assertWarmCold(root, options, previous);
  assert(previous.integrity.excluded.some(item => item.reasonCode === "INVALID_HISTORICAL_CONTINUITY_PATH"));
  fs.unlinkSync(path.join(path.dirname(continuity), "extra.txt"));
  previous = await assertWarmCold(root, options, previous);
  const worldReference = retained.boundary.entries.find(entry => entry.role === "legacy-world-embedding-reference");
  const worldFile = path.join(root, worldReference.path), worldBytes = fs.readFileSync(worldFile);
  fs.writeFileSync(worldFile, "{}"); previous = await assertWarmCold(root, options, previous);
  assert(previous.integrity.excluded.some(item => item.layer === "onboarding" && item.reasonCode === "HISTORICAL_BOUNDARY_INTEGRITY_DRIFT"));
  assert(previous.nodes.some(node => node.nodeId === plan.wholePlanId));
  fs.writeFileSync(worldFile, worldBytes); previous = await assertWarmCold(root, options, previous);
  assert(!previous.integrity.excluded.some(item => item.layer === "onboarding"));
});

test("optional adapter failures coalesce per basis and fall back to verified embedded graph", async t => {
  const { root, storage, layout } = fixture(t), world = await buildWorldModel({ root });
  let calls = 0;
  class BrokenAdapter extends InMemoryGraphProjectionAdapter {
    readPointer() { calls += 1; throw Object.assign(new Error("offline"), { code: "ARCADEDB_UNAVAILABLE" }); }
  }
  const adapter = new BrokenAdapter();
  const before = headFiles(root, layout);
  const first = await queryProjectGraph({ root, query: "module.mjs", graphProjectionAdapter: adapter });
  assert(first.nodes.length);
  assert.equal(first.adapter.status, "unavailable");
  assert.equal(first.adapter.fallbackReasonCode, "ARCADEDB_UNAVAILABLE");
  assert.equal(first.adapter.acceleratesCombinedTraversal, false);
  assert.equal(calls, 1);
  const second = await queryProjectGraph({ root, query: "module.mjs", graphProjectionAdapter: adapter });
  assert.equal(second.resultId, first.resultId); assert.equal(calls, 1);
  assert.equal(second.basis.worldModelId, world.snapshot.worldModelId);
  assert.deepEqual(headFiles(root, layout), before); noAuthority(second);
});

test("verified optional adapter retains exact query semantics without claiming whole retrieval acceleration", async t => {
  const { root, storage, layout } = fixture(t), world = await buildWorldModel({ root });
  const adapter = new InMemoryGraphProjectionAdapter();
  (await materializeGraphProjection({ projectRoot: root, storage, graph: world.snapshot.temporalProvenanceGraph, adapter }));
  const result = await queryProjectGraph({ root, query: "answer", graphProjectionAdapter: adapter });
  assert.equal(result.adapter.status, "verified");
  assert.equal(result.adapter.scope, "temporal-query-verification");
  assert.equal(result.adapter.fallbackUsed, false);
  assert.equal(result.adapter.acceleratesCombinedTraversal, false);
  noAuthority(result);
});

test("same path in retained World revisions remains separate; generated installation drift is no discovery gate", async t => {
  const { root, storage, layout } = fixture(t), first = await buildWorldModel({ root });
  fs.writeFileSync(path.join(root, "module.mjs"), "export const answer = 64;\n");
  const second = await buildWorldModel({ root });
  fs.appendFileSync(path.join(root, layout.directory, `generated/${layout.dialect}-instructions.md`), "\nlocal generated drift\n");
  assert.equal(inspectProject(root).status, "drifted");
  const a = await queryProjectGraph({ root, worldModelId: first.snapshot.worldModelId, query: "module.mjs" });
  const b = await queryProjectGraph({ root, worldModelId: second.snapshot.worldModelId, query: "module.mjs" });
  const revisionA = a.nodes.find(node => node.kind === "FileRevision" && node.path === "module.mjs");
  const revisionB = b.nodes.find(node => node.kind === "FileRevision" && node.path === "module.mjs");
  assert(revisionA); assert(revisionB); assert.notEqual(revisionA.nodeId, revisionB.nodeId);
  assert.equal(revisionA.snapshotState, "historical");
  assert.equal(revisionA.freshness, "historical-source-bytes");
  assert.equal(revisionB.freshness, "current-source-bytes");
  assert.equal(b.authority.ordinaryWorkBlocked, false);
});

test("source fallback and bounded expansion disclose incompleteness, not a readiness failure", async t => {
  const { root, layout } = fixture(t, false), before = headFiles(root, layout);
  const missing = await queryProjectGraph({ root, query: "anything" });
  assert.equal(missing.status, "source-fallback"); assert.equal(missing.coverage.emptyResultProvesAbsence, false);
  assert.deepEqual(headFiles(root, layout), before);
  const { root: initialized, layout: initializedLayout } = fixture(t); await observed(initialized, initializedLayout);
  const bounded = await queryProjectGraph({ root: initialized, query: "", depth: 2, maxNodes: 1, maxEdges: 1 });
  assert.equal(bounded.truncated, true); assert.equal(bounded.sourceFallback.needed, true); noAuthority(bounded);
});
