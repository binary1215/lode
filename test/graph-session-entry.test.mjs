import { worldSnapshotFile, graphSnapshotFile, readFixtureSnapshot, writeFixtureSnapshot } from "./helpers/snapshot-storage-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCommand, usage } from "../scripts/head.mjs";
import { dispatch, tools } from "../scripts/mcp-server.mjs";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { buildWorldModel } from "../scripts/lib/world-model.mjs";
import { startOnboarding, reviewOnboarding } from "../scripts/lib/onboarding.mjs";
import { startFeatureMapping, reviewFeatureMapping } from "../scripts/lib/feature-mapping.mjs";
import { inspectWorldModel } from "../scripts/lib/world-model.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const request = (name, args = {}) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
async function call(name, args = {}, options) {
  const response = await dispatch(request(name, args), options);
  assert.equal(response.error, undefined, `${name}: ${response.error?.message}`);
  return response.result.structuredContent;
}
function fixture(t, initialized = true) {
  const parent = fs.realpathSync(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "head-graph-session-entry-"));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, "source.mjs"), "export function answer() { return 42; }\n");
  if (initialized) initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  return { root, layout: initialized ? inspectProject(root).storage : null };
}
function snapshot(root) {
  return fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? snapshot(file) : [[path.relative(root, file), fs.readFileSync(file).toString("base64")]];
  });
}
function writeInput(root, name, value) {
  const file = path.join(root, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}
async function startCliRun(root, sessionId, suffix) {
  const route = sessionId ? ["--session", sessionId] : [];
  const compiled = await runCommand(["context-compile", root, "--task", `Preserve ${suffix} progress`, ...route]);
  const planInput = writeInput(root, `${suffix}-plan`, { objective: `Complete ${suffix}`, plan: [{ id: "inspect", outcome: `Verify ${suffix}` }] });
  const plan = await runCommand(["lineage-plan", root, "--input", planInput, ...route]);
  const contractInput = writeInput(root, `${suffix}-contract`, { wholePlanId: plan.artifact.wholePlanId,
    capsuleId: compiled.capsule.capsuleId, scope: `Inspect ${suffix}`, acceptanceCriteria: [`${suffix} evidence checked`] });
  const contract = await runCommand(["lineage-contract", root, "--input", contractInput, ...route]);
  const started = await runCommand(["run-start", root, "--contract", contract.artifact.executionContractId, ...route]);
  return { ...started, plan, contract, compiled };
}

test("public session creation preserves the default active Run and unknown effect record", async t => {
  const { root, layout } = fixture(t);
  const active = await startCliRun(root, null, "default");
  const defaultFile = path.join(root, layout.directory, "sessions", "current.json");
  const current = JSON.parse(fs.readFileSync(defaultFile, "utf8"));
  current.unconfirmedExternalEffect = { action: "publish", outcome: "unknown", replayAllowed: false };
  fs.writeFileSync(defaultFile, JSON.stringify(current));
  const before = fs.readFileSync(defaultFile, "utf8");
  const [createdA, createdB] = await Promise.all([
    call("head_session_create", { project_root: root, purpose: "Inspect API" }),
    Promise.resolve().then(async () => (await runCommand(["session-create", root, "--purpose", "Inspect UI"]))),
  ]);
  assert.notEqual(createdA.sessionId, createdB.sessionId);
  assert.equal(fs.readFileSync(defaultFile, "utf8"), before);
  const listed = await call("head_session_list", { project_root: root });
  assert.equal(listed.sessions.length, 3);
  assert.equal(listed.defaultSessionId, current.sessionId);
  assert.equal(listed.sessions.find(session => session.default).state.activeRunId, active.run.runId);
  assert.deepEqual(listed.sessions.find(session => session.default).state.unconfirmedExternalEffect, current.unconfirmedExternalEffect);
});

test("concurrent public MCP awaits and CLI operations keep two Session checkpoints and Runs independent", async t => {
  const { root, layout } = fixture(t);
  const defaultFile = path.join(root, layout.directory, "sessions", "current.json");
  const defaultBefore = fs.readFileSync(defaultFile, "utf8");
  const a = await call("head_session_create", { project_root: root, purpose: "API progress" });
  const b = await runCommand(["session-create", root, "--purpose", "UI progress"]);
  const ids = [a.sessionId, b.sessionId];
  const bases = await Promise.all(ids.map(session_id => call("head_checkpoint_basis", { project_root: root, session_id })));
  const checkpoints = await Promise.all(ids.map((session_id, index) => call("head_checkpoint_sync", {
    project_root: root, session_id, expected_recovery_basis_id: bases[index].basis.basisId,
    purpose: `${index}: scoped purpose`, approved_decisions: [], current_position: `${index}: independent progress`,
    next_expected_result: `${index}: next result`, open_review_ids: [],
  })));
  assert.notEqual(checkpoints[0].checkpoint.checkpointId, checkpoints[1].checkpoint.checkpointId);
  for (let index = 0; index < ids.length; index++) {
    assert.equal(checkpoints[index].checkpoint.sessionId, ids[index]);
    const restored = await runCommand(["session-restore", root, "--session", ids[index]]);
    assert.equal(restored.projection.sessionId, ids[index]);
    assert.equal(restored.projection.consumerInstruction.historicalCheckpointContext.currentPosition, `${index}: independent progress`);
  }
  const crossed = await dispatch(request("head_session_restore", { project_root: root, session_id: ids[0],
    checkpoint_id: checkpoints[1].checkpoint.checkpointId }));
  assert(crossed.error, "Another Session's checkpoint cannot supply this Session's direction");
  const runA = await startCliRun(root, ids[0], "api");
  const runB = await startCliRun(root, ids[1], "ui");
  assert.notEqual(runA.run.runId, runB.run.runId);
  await Promise.all(ids.map(async (session_id, index) => call("head_checkpoint_sync", { project_root: root, session_id,
    expected_recovery_basis_id: (await runCommand(["checkpoint-basis", root, "--session", session_id])).basis.basisId,
    purpose: `${index}: active Run`, approved_decisions: [], current_position: `${index}: active Run`,
    next_expected_result: `${index}: keep working`, open_review_ids: [] })));
  const restored = await Promise.all(ids.map(session_id => call("head_session_restore", { project_root: root, session_id })));
  assert.equal(restored[0].projection.activeRun.runId, runA.run.runId);
  assert.equal(restored[1].projection.activeRun.runId, runB.run.runId);
  assert.equal(fs.readFileSync(defaultFile, "utf8"), defaultBefore);
  const beforeReads = snapshot(root);
  await Promise.all(ids.flatMap(session_id => [call("head_project_status", { project_root: root, session_id }),
    call("head_project_graph", { project_root: root, session_id, query: "answer" })]));
  for (let index = 0; index < ids.length; index++) {
    const graph = await call("head_project_graph", { project_root: root, session_id: ids[index], anchor_ids: [ids[index]], depth: 2 });
    assert(graph.nodes.some(node => node.nodeId === ids[index]), "Each logical Session is discoverable through work graph evidence");
    const runId = [runA, runB][index].run.runId;
    assert(graph.nodes.some(node => node.nodeId === runId), "The compact graph retains the exact linked Run identity");
    const detail = await call("head_project_graph", { project_root: root, session_id: ids[index], anchor_ids: [runId], details: true });
    assert(detail.nodes.some(node => node.runId === runId), "Explicit expansion preserves the original Run detail");
    assert.equal(graph.authority.executionAuthority, false);
  }
  assert.deepEqual(snapshot(root), beforeReads);
});

test("a later common cancellation survives historical checkpoint restore across Sessions", async t => {
  const { root, layout } = fixture(t);
  const a = await call("head_session_create", { project_root: root, purpose: "Deploy investigation" });
  const b = await call("head_session_create", { project_root: root, purpose: "User direction" });
  const initial = { goal: "Investigate release", constraints: [], decisions: ["Investigate deployment"], cancelledActions: [] };
  const first = await call("head_project_direction_update", { project_root: root, session_id: a.sessionId,
    expected_direction_id: null, direction: initial });
  const checkpoint = await runCommand(["checkpoint", root, "--session", a.sessionId,
    "--summary", "Deployment investigation complete", "--next", "Deploy after current authorization"]);
  const revised = { ...initial, constraints: ["Do not deploy"], decisions: ["User cancelled deployment"], cancelledActions: ["deploy"] };
  const second = await call("head_project_direction_update", { project_root: root, session_id: b.sessionId,
    expected_direction_id: first.direction.directionId, direction: revised });
  const before = snapshot(root);
  const restored = await call("head_session_restore", { project_root: root, session_id: a.sessionId,
    checkpoint_id: checkpoint.checkpoint.checkpointId });
  assert.equal(restored.projection.currentProjectDirection.directionId, second.direction.directionId);
  assert.deepEqual(restored.projection.consumerInstruction.currentProjectDirection.input.cancelledActions, ["deploy"]);
  assert.equal(restored.checkpoint.nextExpectedResult, "Deploy after current authorization");
  assert.equal(restored.projection.consumerInstruction.commonDirectionPrecedence, "current-common-constraints-and-cancellations-apply-before-historical-session-intent");
  const stale = await dispatch(request("head_project_direction_update", { project_root: root, session_id: a.sessionId,
    expected_direction_id: first.direction.directionId, direction: initial }));
  assert.match(stale.error?.message || "", /changed|current exact basis/i);
  assert.equal((await call("head_project_direction_read", { project_root: root })).directionId, second.direction.directionId);
  assert.deepEqual(snapshot(root), before);
});

test("managed entry is optional discoverable execution with the existing authorization boundary", async t => {
  const { root, layout } = fixture(t), before = snapshot(root);
  const discovered = await call("head_tools_discover", { name: "head_bounded_worker_start" });
  assert.equal(discovered.persisted, false);
  assert.equal(discovered.grantsAuthorization, false);
  assert.equal(discovered.tools[0].invokeWith, "lode_tools_call");
  assert.equal(discovered.tools[0].executionMode, "managed");
  const denied = await dispatch(request("head_tools_call", { name: "head_bounded_worker_start", execution_mode: "managed",
    arguments: { project_root: root } }));
  assert(denied.error);
  assert.doesNotMatch(denied.error.message, /not available on the ordinary/);
  assert.deepEqual(snapshot(root), before);
  assert(usage({ all: true, surface: "managed-maintenance" }).commands.some(command => command.includes("worker-wave-create")));
  assert(!usage().commands.some(command => command.includes("worker-wave-create")));
  assert(tools.some(tool => tool.name === "lode_project_graph"));
});

test("public graph-first fallback needs no initialization, Product approval, Run, Capsule or DB", async t => {
  for (const initialized of [false, true]) {
    const { root, layout } = fixture(t, initialized), before = snapshot(root);
    const first = await call("head_project_graph", { project_root: root, query: "missing information" });
    assert.equal(first.kind, "ProjectGraphDiscoveryProjection");
    assert.equal(first.sourceFallback.available, true);
    assert.equal(first.coverage.emptyResultProvesAbsence, false);
    assert.equal(first.freshness.wholeWorldCurrentRequired, false);
    assert.equal(first.authority.ordinaryWorkBlocked, false);
    for (const property of ["executionAuthority", "promotionAuthority", "recoveryAuthority", "instructionAuthority"]) assert.equal(first.authority[property], false);
    const next = await call("head_project_graph", { project_root: root, query: "missing information", previous_result: first });
    const cli = await runCommand(["graph-query", root, "--query", "missing information"]);
    assert.equal(next.resultId, first.resultId);
    assert.equal(cli.resultId, first.resultId);
    assert.deepEqual(snapshot(root), before);
    if (initialized) assert(!fs.existsSync(path.join(root, layout.directory, "world-model", "current.json")));
    else { assert(!fs.existsSync(path.join(root, ".head"))); assert(!fs.existsSync(path.join(root, ".lode"))); }
    fs.writeFileSync(path.join(root, "ordinary-work.txt"), "continue ordinary source work\n");
    assert.equal(fs.readFileSync(path.join(root, "ordinary-work.txt"), "utf8"), "continue ordinary source work\n");
  }
});

test("stale intact World evidence stays readable, while tampering and another root are excluded per layer", async t => {
  const { root, layout } = fixture(t);
  const planInput = writeInput(root, "retained-work-plan", { objective: "Retain independent work evidence", plan: ["inspect sources"] });
  const plan = await runCommand(["lineage-plan", root, "--input", planInput]);
  const world = await buildWorldModel({ root });
  const revision = world.snapshot.temporalProvenanceGraph.nodes.find(node => node.kind === "FileRevision" && node.path === "source.mjs");
  assert(revision);
  fs.writeFileSync(path.join(root, "source.mjs"), "export function answer() { return 43; }\n");
  const before = snapshot(root);
  const retained = await call("head_project_graph", { project_root: root, anchor_ids: [revision.nodeId], depth: 1,
    world_model_id: world.snapshot.worldModelId });
  const included = retained.nodes.find(node => node.nodeId === revision.nodeId);
  assert.equal(included.freshness, "historical-source-bytes");
  assert.equal(included.sourceReference.worldModelId, world.snapshot.worldModelId);
  assert(retained.summary.freshnessStates["historical-source-bytes"] >= 1);
  assert.equal(retained.authority.executionAuthority, false);
  assert.deepEqual(snapshot(root), before);
  const snapshotFile = worldSnapshotFile(root, world.snapshot.worldModelId);
  const corrupt = readFixtureSnapshot(snapshotFile);
  corrupt.repositoryFingerprint = "tampered";
  writeFixtureSnapshot(snapshotFile, corrupt);
  const corruptedBefore = snapshot(root);
  const excluded = await runCommand(["graph-query", root, "--anchors", plan.artifact.wholePlanId]);
  assert(excluded.integrity.excluded.some(item => item.layer === "world"));
  assert(excluded.nodes.some(node => node.nodeId === plan.artifact.wholePlanId));
  assert.equal(excluded.sourceFallback.available, true);
  assert.deepEqual(snapshot(root), corruptedBefore);
  const { root: another } = fixture(t, false);
  fs.cpSync(path.join(root, layout.directory), path.join(another, layout.directory), { recursive: true });
  const copiedBefore = snapshot(another);
  const wrongRoot = await call("head_project_graph", { project_root: another });
  assert.equal(wrongRoot.status, "source-fallback");
  assert.equal(wrongRoot.nodes.length, 0);
  assert.deepEqual(snapshot(another), copiedBefore);
  // A wholly foreign canonical directory is unowned. Make the copied marker
  // related to this root while retaining its foreign Project ID to exercise
  // the recognized-owner identity failure rather than claiming ownership.
  const copiedProjectFile = path.join(another, layout.directory, "project.json");
  const copiedProject = JSON.parse(fs.readFileSync(copiedProjectFile, "utf8"));
  fs.writeFileSync(copiedProjectFile, JSON.stringify({ ...copiedProject, projectRoot: fs.realpathSync(another) }));
  const mismatchedBefore = snapshot(another);
  const mismatchedOwner = await call("head_project_graph", { project_root: another });
  assert.equal(mismatchedOwner.status, "source-fallback");
  assert.equal(mismatchedOwner.nodes.length, 0);
  assert(mismatchedOwner.sourceFallback.reasonCodes.includes("PROJECT_IDENTITY_MISMATCH"));
  assert.deepEqual(snapshot(another), mismatchedBefore);
});

test("rejected Product candidates retain review and revision state through public graph expansion and summary", async t => {
  const { root, layout } = fixture(t);
  const started = await startOnboarding({ root, mode: "new", brief: {
    schemaVersion: 1, name: "Message service", summary: "Deliver messages.",
    capabilities: [{ key: "delivery", name: "Delivery", description: "Deliver one message." }],
  } });
  const candidate = started.candidateSet.candidates[0];
  const pending = await call("head_project_graph", { project_root: root, anchor_ids: [candidate.candidateId], depth: 1 });
  assert.equal(pending.nodes.find(node => node.nodeId === candidate.candidateId).reviewState, "candidate");
  await reviewOnboarding({ root, candidateSetId: started.candidateSet.candidateSetId, disposition: "reject", rationale: "Reject this proposal." });
  const before = snapshot(root);
  const rejected = await runCommand(["graph-query", root, "--anchors", candidate.candidateId, "--depth", "2"]);
  const node = rejected.nodes.find(node => node.nodeId === candidate.candidateId);
  assert.equal(node.reviewState, "rejected");
  assert.equal(node.revisionId, started.candidateSet.productModelId);
  assert(rejected.summary.reviewStates.rejected >= 1);
  const links = rejected.edges.filter(edge => edge.from === candidate.candidateId || edge.to === candidate.candidateId);
  assert(links.length > 0);
  for (const link of links) {
    assert.equal(link.endpointStates.find(endpoint => endpoint.nodeId === candidate.candidateId).reviewState, "rejected");
    assert.equal(link.executionAuthority, false);
  }
  const hidden = await call("head_project_graph", { project_root: root, anchor_ids: [candidate.candidateId], include_candidates: false });
  assert(!hidden.nodes.some(item => item.nodeId === candidate.candidateId));
  assert.equal(hidden.coverage.emptyResultProvesAbsence, false);
  assert.deepEqual(snapshot(root), before);
});

test("rejected relationships stored in a retained World remain rejected in graph summaries and neighbor endpoints", async t => {
  const { root, layout } = fixture(t);
  const started = await startOnboarding({ root, mode: "new", brief: {
    schemaVersion: 1, name: "Answer service", summary: "Answer a request.",
    capabilities: [{ key: "answer", name: "Answer", description: "Answer one request." }],
  } });
  await reviewOnboarding({ root, candidateSetId: started.candidateSet.candidateSetId, disposition: "accept-all", rationale: "Approve the exact answer capability." });
  const current = (await inspectWorldModel({ root }));
  const graph = current.snapshot.temporalProvenanceGraph;
  const source = graph.nodes.find(node => node.kind === "File" && node.path === "source.mjs");
  const product = graph.nodes.find(node => node.kind === "Capability" && node.key === "answer");
  assert(source); assert(product);
  const mapping = await startFeatureMapping({ root, semanticProposal: { schemaVersion: 1,
    sourceSnapshotId: graph.sourceSnapshotId, productModelId: current.snapshot.productModel.productModelId,
    candidates: [{ relationshipType: "IMPLEMENTS", sourceNodeId: source.nodeId, productNodeId: product.nodeId,
      explanation: "The proposed source implements the answer capability.", confidence: 0.9 }] } });
  const candidateId = mapping.candidateSet.candidates[0].candidateId;
  await reviewFeatureMapping({ root, candidateSetId: mapping.candidateSet.candidateSetId,
    disposition: "reject", rationale: "This relationship lacks product evidence." });
  const rejectedWorld = (await inspectWorldModel({ root })).snapshot;
  fs.appendFileSync(path.join(root, "source.mjs"), "\n// Later source revision\n");
  const before = snapshot(root);
  const discovered = await call("head_project_graph", { project_root: root, anchor_ids: [candidateId], depth: 2,
    world_model_id: rejectedWorld.worldModelId });
  assert.equal(discovered.nodes.find(node => node.nodeId === candidateId).reviewState, "rejected");
  assert(discovered.summary.reviewStates.rejected >= 1);
  const edges = discovered.edges.filter(edge => edge.from === candidateId || edge.to === candidateId);
  assert(edges.some(edge => edge.type === "REJECTED_BY"));
  for (const edge of edges) assert.equal(edge.endpointStates.find(endpoint => endpoint.nodeId === candidateId).reviewState, "rejected");
  assert.equal(discovered.authority.executionAuthority, false);
  assert.deepEqual(snapshot(root), before);
});
