import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { createSessionCallContext, sessionCallRequiresBinding } from "../scripts/lib/session-routing.mjs";
import { readProjectDirection, updateProjectDirection } from "../scripts/lib/project-direction.mjs";
import { createRecoveryCheckpoint, inspectRecoveryCheckpointBasis, prepareCompaction, verifyCompaction, continueCompaction, inspectCompaction } from "../scripts/lib/compaction-recovery.mjs";
import { inspectRecoveryCheckpointDiagnosis } from "../scripts/lib/recovery-checkpoint-diagnosis.mjs";
import { restoreSessionFromArtifacts } from "../scripts/lib/session-recovery.mjs";
import { recordSessionWorkEvidence } from "../scripts/lib/session-work-context.mjs";
import { enterConversationRecovery } from "../scripts/lib/compaction-lifecycle.mjs";
import { inspectProjectExperience } from "../scripts/lib/project-bootstrap.mjs";
import { buildWorldModel } from "../scripts/lib/world-model.mjs";
import { defineMetric } from "../scripts/lib/measurement-workflow.mjs";
import { recordProductSignal, recordProductHypothesis, proposeProductInitiative } from "../scripts/lib/product-operating-loop.mjs";
import { formatCliResult, formatMcpToolContent, formatReviewOutcome } from "../scripts/lib/cli-presentation.mjs";
import { runCommand } from "../scripts/head.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "head-boundary-consistency-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  return { root, layout };
}
function snapshot(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(item => item.isFile()).map(item => {
    const file = path.join(item.parentPath, item.name), stat = fs.statSync(file);
    return [path.relative(root, file), crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), stat.mtimeMs, stat.mode];
  }).sort(([a], [b]) => a.localeCompare(b));
}
const directionInput = { goal: "Inspect synthetic records only", constraints: ["No external effects"], cancelledActions: ["deploy"] };
const recoveryInput = { purpose: "Retain local reasoning", approvedDecisions: [], currentPosition: "Local inspection", nextExpectedResult: "Explain the existing result" };
function loseDirection(root, layout) {
  const saved = updateProjectDirection({ root, input: directionInput });
  const pointer = path.join(root, layout.directory, "project-direction/current.json"), bytes = fs.readFileSync(pointer);
  fs.unlinkSync(pointer); return { saved, pointer, bytes };
}
async function mcp(root, name, args = {}, options = {}, routed = false, write = false) {
  const response = await dispatch({ jsonrpc: "2.0", id: "boundary-test", method: "tools/call", params: {
    name: routed ? write ? "head_tools_call" : "head_tools_read" : name,
    arguments: routed ? { name, arguments: { project_root: root, ...args } } : { project_root: root, ...args },
  } }, options);
  assert.equal(response.error, undefined, JSON.stringify(response));
  assert.equal(response.result?.isError, undefined, JSON.stringify(response));
  return response.result;
}

test("metric CLI normal/lost context and MCP direct/router share Project facts without replacing selection", async t => {
  const { root, layout } = fixture(t);
  await defineMetric({ root, metricKey: "request-latency", unit: "milliseconds", direction: "decrease" });
  const context = createSessionCallContext(); context.lose(root);
  const binding = context.read(root), before = snapshot(root);
  const defaultFile = path.join(root, layout.directory, "sessions/current.json"), originalRead = fs.readFileSync;
  const readinessReads = [];
  let reads = 0;
  fs.readFileSync = (file, ...args) => { if (file === defaultFile) reads++; return originalRead(file, ...args); };
  let plain, lost, direct, routed;
  try {
    plain = await runCommand(["metric-status", root]); readinessReads.push(reads); reads = 0;
    lost = await runCommand(["metric-status", root], { sessionContext: context }); readinessReads.push(reads); reads = 0;
    direct = await mcp(root, "head_metric_status", {}, { sessionContext: context }); readinessReads.push(reads); reads = 0;
    routed = await mcp(root, "head_metric_status", {}, { sessionContext: context }, true); readinessReads.push(reads);
  } finally { fs.readFileSync = originalRead; }
  assert.equal(plain.status, "active"); assert.equal(plain.definitions.length, 1);
  assert.deepEqual(lost, plain); assert.deepEqual(direct.structuredContent, plain); assert.deepEqual(routed.structuredContent, plain);
  assert.ok(readinessReads[0] > 0, "Existing observation readiness still reads the default record; not a new routing fallback");
  assert.deepEqual(readinessReads, readinessReads.map(() => readinessReads[0]));
  assert.deepEqual(context.read(root), binding); assert.deepEqual(snapshot(root), before);
  assert.equal(sessionCallRequiresBinding("metric-status", "cli"), false);
  assert.equal(sessionCallRequiresBinding("synthetic-unclassified", "cli"), true);
  assert.equal(sessionCallRequiresBinding("head_run_start"), true);
  assert.equal((await runCommand(["conversation-enter", root], { sessionContext: context })).status, "session_selection_unresolved");
  assert.equal((await runCommand(["synthetic-unclassified", root], { sessionContext: context })).status, "session_selection_unresolved");
  assert.deepEqual(snapshot(root), before);
});

for (const hasCheckpoint of [false, true]) test(`lost common direction preserves independent entry with checkpoint=${hasCheckpoint}`, async t => {
  const { root, layout } = fixture(t);
  const checkpoint = hasCheckpoint ? createRecoveryCheckpoint({ root, ...recoveryInput }).checkpoint : null;
  const evidence = recordSessionWorkEvidence({ root, input: { summary: "Retain synthetic reason", judgments: [{ assessment: "Keep exact keys", reason: "Case is meaningful" }] } }).evidence;
  loseDirection(root, layout); const before = snapshot(root);
  const entry = (await enterConversationRecovery({ root })), status = (await inspectProjectExperience({ root }));
  for (const view of [entry, status, (await mcp(root, "head_conversation_enter")).structuredContent]) {
    assert.equal(view.ordinaryWorkBlocked, false); assert.equal(view.userDecisionRequired, false);
    assert.equal(view.recoveryDependentWorkBlocked, false);
    const project = view.projectStatus || view;
    assert.equal(project.currentProjectDirection, null);
    assert.equal(project.currentProjectDirectionAvailability.status, "unavailable");
    assert.equal(project.attention.items.find(item => item.id === "current-project-direction-unavailable").actionability,
      "when-current-direction-dependent-work-is-in-scope");
  }
  assert.equal(entry.workContext.records[0].evidenceId, evidence.evidenceId);
  assert.match(formatCliResult("conversation-enter", entry), /current common direction is unavailable/i);
  assert.match(formatCliResult("status", status), /current common direction is unavailable/i);
  const diagnosis = inspectRecoveryCheckpointDiagnosis({ root, includeRestore: true });
  assert.equal(diagnosis.checkpointUpdate.freshDirectionPublishable, false);
  assert.equal(diagnosis.checkpointUpdate.exactCurrentReuseMayConverge, false);
  assert.equal(diagnosis.observationConsistency.firstBasisId, null);
  assert.equal(diagnosis.observationConsistency.basisReadsMatched, false);
  assert.match(diagnosis.observationConsistency.scope, /0 successful recovery basis reads/);
  assert.throws(() => inspectRecoveryCheckpointBasis({ root }), { code: "PROJECT_DIRECTION_UNAVAILABLE" });
  if (hasCheckpoint) {
    const restored = restoreSessionFromArtifacts({ root });
    assert.deepEqual(restored.checkpoint, checkpoint);
    assert.equal(entry.restore.checkpoint.checkpointId, checkpoint.checkpointId);
    assert.equal(diagnosis.artifactRecovery.status, "verified");
    assert.equal(diagnosis.observationConsistency.restoreTupleMatched, true);
    assert.equal(diagnosis.currentCheckpoint.checkpointId, checkpoint.checkpointId);
    assert.equal(diagnosis.currentCheckpoint.checkpointDigest, checkpoint.checkpointDigest);
    assert.equal(diagnosis.restore.checkpoint.checkpointDigest, checkpoint.checkpointDigest);
    assert.equal(restored.projection.consumerInstruction.currentProjectDirectionAvailability.status, "unavailable");
    assert.match(formatCliResult("session-restore", restored), /current common direction remains unavailable/i);
  } else assert.equal(diagnosis.artifactRecovery.status, "not-applicable");
  const context = createSessionCallContext(); context.lose(root);
  const originalRead = fs.readFileSync, defaultFile = path.join(root, layout.directory, "sessions/current.json");
  let unresolved;
  fs.readFileSync = (file, ...args) => { assert.notEqual(file, defaultFile, "Lost-selection Project facts must not inspect default"); return originalRead(file, ...args); };
  try { unresolved = await runCommand(["conversation-enter", root], { sessionContext: context }); }
  finally { fs.readFileSync = originalRead; }
  assert.equal(unresolved.availability.currentProjectDirection, "unavailable");
  assert.equal(unresolved.project.projectId, inspectProject(root).project.projectId);
  assert.match(formatCliResult("conversation-enter", unresolved), /unavailable, not empty/);
  assert.deepEqual(snapshot(root), before);
});

for (const missingDirection of [false, true]) test(`diagnosis never combines an outer checkpoint A with independently restored B; unavailable=${missingDirection}`, t => {
  const { root, layout } = fixture(t);
  updateProjectDirection({ root, input: directionInput });
  const checkpointA = createRecoveryCheckpoint({ root, ...recoveryInput, purpose: "Synthetic checkpoint A" }).checkpoint;
  const sessionFile = path.join(root, layout.directory, "sessions/current.json"), stateA = fs.readFileSync(sessionFile);
  const checkpointB = createRecoveryCheckpoint({ root, ...recoveryInput, purpose: "Synthetic checkpoint B" }).checkpoint;
  const stateB = fs.readFileSync(sessionFile);
  fs.writeFileSync(sessionFile, stateA);
  if (missingDirection) fs.unlinkSync(path.join(root, layout.directory, "project-direction/current.json"));
  assert.notEqual(checkpointA.checkpointDigest, checkpointB.checkpointDigest);
  const before = snapshot(root), originalRead = fs.readFileSync;
  let restoreReads = 0, diagnosis;
  fs.readFileSync = function (file, ...args) {
    // No read-time writes: outer reads see A; every read inside restore sees B.
    if (path.resolve(String(file)) === sessionFile && new Error().stack.includes("restoreSessionFromArtifacts")) {
      restoreReads++;
      const encoding = typeof args[0] === "string" ? args[0] : args[0]?.encoding;
      return encoding ? stateB.toString(encoding) : Buffer.from(stateB);
    }
    return originalRead.call(this, file, ...args);
  };
  try { diagnosis = inspectRecoveryCheckpointDiagnosis({ root, includeRestore: true }); }
  finally { fs.readFileSync = originalRead; }
  assert.ok(restoreReads > 0, "The restore observed a different internally stable current checkpoint");
  assert.equal(diagnosis.diagnosis.reasonCode, "RECOVERY_DIAGNOSIS_OBSERVATION_CHANGED");
  assert.equal(diagnosis.artifactRecovery.status, "not-conclusive");
  assert.equal(diagnosis.observationConsistency.restoreTupleMatched, false);
  assert.equal(diagnosis.currentCheckpoint.checkpointId, checkpointA.checkpointId);
  assert.notEqual(diagnosis.currentCheckpoint.checkpointDigest, checkpointB.checkpointDigest);
  assert.equal(diagnosis.currentCheckpoint.checkpointDigest, missingDirection ? null : checkpointA.checkpointDigest);
  assert.equal(diagnosis.restore, undefined, "Never expose mismatched restore as verified current context");
  assert.equal(diagnosis.checkpointUpdate.freshDirectionPublishable, false);
  assert.equal(diagnosis.recoveryDependentWorkBlocked, true);
  assert.equal(diagnosis.ordinaryWorkBlocked, false);
  assert.equal(diagnosis.userDecisionRequired, false);
  assert.equal(diagnosis.observationConsistency.atomicFilesystemSnapshot, false);
  assert.equal(diagnosis.observationConsistency.abaChangesDetectable, false);
  if (missingDirection) assert.match(diagnosis.observationConsistency.scope, /0 successful recovery basis reads/);
  assert.deepEqual(snapshot(root), before);
});

test("direction loss never masks corrupt checkpoint verification", async t => {
  const { root, layout } = fixture(t), checkpoint = createRecoveryCheckpoint({ root, ...recoveryInput }).checkpoint;
  loseDirection(root, layout);
  const file = path.join(root, layout.directory, "sessions/ledger", `${checkpoint.checkpointId}.json`);
  assert.ok(fs.existsSync(file));
  fs.appendFileSync(file, "invalid"); const before = snapshot(root);
  const entry = (await enterConversationRecovery({ root }));
  assert.equal(entry.recoveryDependentWorkBlocked, true); assert.equal(entry.ordinaryWorkBlocked, false);
  assert.notEqual(entry.projectStatus.readiness.recovery.restorable, true);
  assert.deepEqual(snapshot(root), before);
});

test("direction availability changes during entry are not published as stable context", async t => {
  const { root, layout } = fixture(t); createRecoveryCheckpoint({ root, ...recoveryInput }); const lost = loseDirection(root, layout);
  const read = fs.readFileSync; let restoredPointer = false;
  fs.readFileSync = (file, ...args) => {
    if (!restoredPointer && String(file).includes(`${path.sep}sessions${path.sep}ledger${path.sep}`)) {
      restoredPointer = true; fs.writeFileSync(lost.pointer, lost.bytes);
    }
    return read(file, ...args);
  };
  let entry;
  try { entry = (await enterConversationRecovery({ root })); } finally { fs.readFileSync = read; }
  assert.equal(restoredPointer, true);
  assert.equal(entry.reasonCode, "CONVERSATION_ENTRY_BASIS_CHANGED");
  assert.equal(entry.persisted, false); assert.equal(entry.ordinaryWorkBlocked, false);
});

test("lost current direction rejects valid continuation before one-shot consumption; healthy/duplicate/supersede stay exact", t => {
  const { root, layout } = fixture(t); updateProjectDirection({ root, input: directionInput });
  const prepared = prepareCompaction({ root, ...recoveryInput, runtime: "codex", userTurnIdAtPrepare: 7 });
  verifyCompaction({ root, epochId: prepared.epoch.epochId, checkpointDigest: prepared.checkpoint.checkpointDigest, currentUserTurnId: 7, providerCompacted: true });
  const pointer = path.join(root, layout.directory, "project-direction/current.json"), bytes = fs.readFileSync(pointer); fs.unlinkSync(pointer);
  const before = snapshot(root), input = { root, epochId: prepared.epoch.epochId, continuationToken: prepared.continuationToken, currentUserTurnId: 7 };
  assert.throws(() => continueCompaction(input), { code: "PROJECT_DIRECTION_UNAVAILABLE" });
  assert.deepEqual(snapshot(root), before); assert.equal(inspectCompaction({ root }).epoch.state, "verified");
  assert.throws(() => continueCompaction({ ...input, continuationToken: "invalid-token" }), { code: "INVALID_COMPACTION_TOKEN" });
  fs.writeFileSync(pointer, bytes);
  assert.equal(continueCompaction(input).status, "compaction_continuation_consumed");
  assert.throws(() => continueCompaction(input), { code: "COMPACTION_TOKEN_CONSUMED" });
  const { root: other, layout: otherLayout } = fixture(t); updateProjectDirection({ root: other, input: directionInput });
  const later = prepareCompaction({ root: other, ...recoveryInput, runtime: "codex", userTurnIdAtPrepare: 7 });
  verifyCompaction({ root: other, epochId: later.epoch.epochId, checkpointDigest: later.checkpoint.checkpointDigest, currentUserTurnId: 7, providerCompacted: true });
  fs.unlinkSync(path.join(other, otherLayout.directory, "project-direction/current.json"));
  assert.throws(() => continueCompaction({ root: other, epochId: later.epoch.epochId, continuationToken: later.continuationToken, currentUserTurnId: 8 }), { code: "COMPACTION_SUPERSEDED" });
  assert.equal(inspectCompaction({ root: other }).epoch.state, "superseded");
});

for (const disposition of ["accept", "reject"]) test(`committed ${disposition} review exposes deferred projection in CLI/MCP text and structured results`, async t => {
  const { root, layout } = fixture(t); await buildWorldModel({ root, persist: true });
  const signal = await recordProductSignal({ root, statement: "Synthetic interface observation", observedAt: "2026-10-16T00:00:00.000Z" });
  const hypothesis = await recordProductHypothesis({ root, statement: "Synthetic interface hypothesis", signalIds: [signal.signal.signalId] });
  const proposed = await proposeProductInitiative({ root, title: "Improve synthetic interface", hypothesisIds: [hypothesis.hypothesis.hypothesisId],
    featureResolution: { kind: "candidate", feature: { key: "interface", name: "Interface", capabilityKeys: [] } } });
  const pointer = path.join(root, layout.directory, "world-model/current.json"); fs.writeFileSync(pointer, "{broken-world");
  const request = { initiativeCandidateId: proposed.initiativeCandidate.initiativeCandidateId, disposition, rationale: "Synthetic exact user review fixture" };
  const inputFile = path.join(root, "synthetic-review-input.json"); fs.writeFileSync(inputFile, JSON.stringify(request));
  const cli = await runCommand(["product-initiative-review", root, "--input", inputFile]);
  assert.equal(cli.persistenceStatus, "recorded"); assert.equal(cli.productGraph.status, "deferred");
  const cliText = formatCliResult("product-initiative-review", cli);
  assert.ok(cliText.includes(cli.reviewDecision.reviewDecisionId)); assert.match(cliText, /derived graph update deferred/);
  const args = { initiative_candidate_id: request.initiativeCandidateId, disposition, rationale: request.rationale, confirm_user_review: true };
  const before = snapshot(root);
  for (const routed of [false, true]) {
    const result = await mcp(root, "head_product_initiative_review", args, {}, routed, true);
    assert.equal(result.structuredContent.persistenceStatus, "existing");
    assert.deepEqual(result.structuredContent.reviewDecision, cli.reviewDecision);
    assert.equal(result.structuredContent.productGraph.status, "deferred");
    assert.ok(result.content[0].text.includes(cli.reviewDecision.reviewDecisionId));
    assert.match(result.content[0].text, /derived graph update deferred/);
    assert.equal(result.content[0].text, formatMcpToolContent("head_product_initiative_review", result.structuredContent));
  }
  assert.deepEqual(snapshot(root), before); assert.equal(fs.readFileSync(pointer, "utf8"), "{broken-world");
  const healthy = { ...cli, productGraph: { projectionInputId: "a", worldModelId: "b", graphSnapshotId: "c" } };
  const without = { ...cli }; delete without.productGraph;
  assert.equal(formatReviewOutcome(healthy), formatReviewOutcome(without), "Healthy review text is unchanged");
  assert.doesNotMatch(formatReviewOutcome(healthy), /deferred/);
});
