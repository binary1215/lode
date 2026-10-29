import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject, createCheckpoint } from "../scripts/lib/head-core.mjs";
import { inspectProjectExperience } from "../scripts/lib/project-bootstrap.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { createExecutionContract, createWholePlanSnapshot } from "../scripts/lib/execution-lineage.mjs";
import { finishRun, getPendingReviewContext, reviewRun, startRun } from "../scripts/lib/run-lineage.mjs";
import { createRecoveryCheckpoint, readRecoveryCheckpoint } from "../scripts/lib/compaction-recovery.mjs";
import {
  integrateReviewedRunCheckpoint,
  readRunResultIntegration,
  restoreSessionFromArtifacts,
} from "../scripts/lib/session-recovery.mjs";
import { dispatch, catalogTools as mcpTools } from "../scripts/mcp-server.mjs";
import { runCommand } from "../scripts/head.mjs";

import { seedLegacyProject } from "./helpers/legacy-project-fixture.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";


const pluginRoot = path.resolve(import.meta.dirname, "..");
const cliFile = path.join(pluginRoot, "scripts", "head.mjs");

function temporaryProject(prefix = "head-session-recovery-test-") {
  const parent = process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

function initialize(root) {
  initializeProject({ root, pluginRoot, runtimes: ["claude", "codex", "opencode"] });
  const storage = inspectProject(root).storage;
  return { root, storage, directory: formatForVerifiedOwner(storage).directory };
}

async function startFixtureRun(root, suffix = "artifact-only recovery") {
  const capsule = (await compileContext({ root, task: `Verify ${suffix}`, budget: 32_768, persist: true })).capsule;
  const plan = createWholePlanSnapshot({
    root,
    objective: `Complete ${suffix}`,
    plan: [{ id: "execute", outcome: suffix }],
    invariants: ["Worker evidence cannot become recovery direction"],
  }).artifact;
  const contract = createExecutionContract({
    root,
    wholePlanId: plan.wholePlanId,
    capsuleId: capsule.capsuleId,
    scope: `Produce ${suffix}`,
    acceptanceCriteria: ["Fresh HEAD verifies the bounded result"],
  }).artifact;
  const run = startRun({ root, executionContractId: contract.executionContractId }).run;
  return { capsule, plan, contract, run };
}

function finishFixtureRun(root) {
  return finishRun({
    root,
    outcome: "Bounded worker result returned as evidence",
    evidence: [{ uri: "test/session-recovery-integration.test.mjs", digest: "bounded-worker-evidence" }],
    planDelta: "No objective rewrite",
    impactRadius: ["session recovery"],
    verification: [{ check: "bounded result", status: "passed" }],
    unknowns: [],
  });
}

function reviewFixtureRun(root, disposition = "accept") {
  const context = getPendingReviewContext({ root });
  return reviewRun({
    root,
    reviewContextId: context.review.reviewContextId,
    disposition,
    rationale: disposition === "accept" ? "The exact contract is satisfied." : "A revised WholePlan is required.",
    nextActions: disposition === "accept" ? ["Checkpoint the explicit next direction"] : ["Create a next WholePlanSnapshot"],
  });
}

function integrationInput(run, reviewDecision, overrides = {}) {
  return {
    runId: run.runId,
    reviewDecisionId: reviewDecision.reviewDecisionId,
    purpose: "Advance recovery only after accepted Fresh HEAD review",
    approvedDecisions: ["Fresh HEAD accepted the exact ResultPacket"],
    currentPosition: "The bounded worker result is reviewed and integrated",
    nextExpectedResult: "Start only the next explicitly authorized unit of work",
    openReviewIds: [],
    ...overrides,
  };
}

function childRestore(root, environment) {
  const result = spawnSync(process.execPath, [cliFile, "session-restore", root, "--json"], {
    cwd: pluginRoot,
    env: { ...process.env, ...environment },
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

const canonicalJson = (value) => JSON.stringify(canonical(value));

test("the public checkpoint surface creates one content-addressed P2 canon and restores identically across fresh provider processes", async (t) => {
  const { root, directory } = initialize(temporaryProject());
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const beforeCheckpoint = (await inspectProjectExperience({ root }));
  assert.equal(beforeCheckpoint.readiness.recovery.state, "no-current-checkpoint");
  assert.equal(beforeCheckpoint.readiness.recovery.userDecisionRequired, false);
  assert.throws(() => createCheckpoint({ root, summary: "legacy", next: "legacy" }), { code: "LEGACY_CHECKPOINT_API_RETIRED" });

  const checkpointed = (await runCommand([
    "checkpoint", root,
    "--summary", "Preserve the exact provider-neutral Session direction",
    "--next", "Continue from the verified artifact projection",
  ]));
  assert.match(checkpointed.checkpoint.checkpointId, /^checkpoint-[a-f0-9]{24}$/u);
  assert.equal(checkpointed.checkpoint.kind, "SessionRunCheckpoint");
  assert.equal(checkpointed.checkpoint.authorityBoundary.planeId, "P2");
  assert.equal(checkpointed.checkpoint.protocol.version, "0.3.0");
  assert.equal(checkpointed.checkpoint.sessionPointer.mode, "session");
  const stateFile = path.join(root, directory, "sessions", "current.json");
  const checkpointFile = path.join(root, directory, "sessions", "ledger", `${checkpointed.checkpoint.checkpointId}.json`);
  const stateBeforeReadiness = fs.readFileSync(stateFile, "utf8");
  const checkpointBeforeReadiness = fs.readFileSync(checkpointFile, "utf8");
  const afterCheckpoint = (await inspectProjectExperience({ root }));
  assert.equal(afterCheckpoint.readiness.recovery.state, "verified-current-checkpoint");
  assert.equal(afterCheckpoint.readiness.recovery.restorable, true);
  assert.equal(afterCheckpoint.readiness.recovery.authority.writesRecoveryDirection, false);
  assert.equal(fs.readFileSync(stateFile, "utf8"), stateBeforeReadiness);
  assert.equal(fs.readFileSync(checkpointFile, "utf8"), checkpointBeforeReadiness);

  const codex = childRestore(root, { CODEX_THREAD_ID: "provider-secret-codex-thread" });
  const opencode = childRestore(root, { OPENCODE_SESSION_ID: "provider-secret-opencode-session" });
  assert.equal(codex.projection.sessionRestoreId, opencode.projection.sessionRestoreId);
  assert.equal(codex.projection.sessionRestoreHash, opencode.projection.sessionRestoreHash);
  assert.equal(codex.projection.consumerInstruction.historicalCheckpointContext.nextExpectedResult, "Continue from the verified artifact projection");
  assert.equal(codex.projection.consumerInstruction.nextExpectedResult, undefined);
  assert.equal(codex.projection.providerBoundary.providerSessionIdentityRequired, false);
  assert.equal(codex.projection.providerBoundary.resumeEnabled, false);
  assert.equal(codex.projection.authorityBoundary.planeId, "P4");
  assert.equal(JSON.stringify(codex).includes("provider-secret-codex-thread"), false);
  assert.equal(JSON.stringify(opencode).includes("provider-secret-opencode-session"), false);
});

test("artifact-only restore revalidates the exact active Run lineage and rejects pointer drift", async (t) => {
  const { root, directory } = initialize(temporaryProject());
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = (await startFixtureRun(root, "active Run restore"));
  const checkpoint = createRecoveryCheckpoint({
    root,
    purpose: "Recover the active Run without a provider session",
    approvedDecisions: ["The exact ExecutionContract remains active"],
    currentPosition: "The bounded Run is active",
    nextExpectedResult: "The exact contract-bound ResultPacket",
  }).checkpoint;
  const restored = restoreSessionFromArtifacts({ root });
  assert.deepEqual(restored.projection.activeRun, {
    runId: fixture.run.runId,
    wholePlanId: fixture.plan.wholePlanId,
    executionContractId: fixture.contract.executionContractId,
    contextCapsuleDigest: fixture.capsule.capsuleHash,
    currentResultPacketId: null,
  });
  assert.equal(restored.checkpoint.checkpointId, checkpoint.checkpointId);

  const stateFile = path.join(root, directory, "sessions", "current.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.activeExecutionContractId = "execution-contract-000000000000000000000000";
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  assert.equal(restoreSessionFromArtifacts({ root }).projection.currentExecution.status, "conflict");
  const attention = (await inspectProjectExperience({ root }));
  assert.equal(attention.readiness.recovery.state, "verified-current-checkpoint");
  assert.equal(attention.readiness.recovery.userDecisionRequired, false);
  assert.equal(attention.readiness.recovery.headActionRequired, true);
  assert.equal(attention.readiness.recovery.ordinaryWorkBlocked, false);
  assert.equal(attention.readiness.recovery.reasonCode, "RUN_TRANSITION_SESSION_DRIFT");
  assert.equal(attention.readiness.recovery.currentExecutionStatus, "conflict");
  assert.equal(attention.nextAction.id, "work_directly");
});

test("legacy content-addressed checkpoints stay readable but cannot drive current Session restore", (t) => {
  const root = temporaryProject();
  seedLegacyProject(root, pluginRoot);
  const directory = ".head";
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const current = createRecoveryCheckpoint({
    root,
    purpose: "Create a current checkpoint before simulating legacy bytes",
    approvedDecisions: [],
    currentPosition: "Session is idle",
    nextExpectedResult: "A legacy compatibility read",
  }).checkpoint;
  const payload = { ...current, protocol: { ...current.protocol, version: "0.2.0" }, authorityBoundary: { ...current.authorityBoundary, contractVersion: "0.2.0" } };
  delete payload.checkpointId;
  delete payload.checkpointDigest;
  delete payload.sessionPointer;
  delete payload.reviewedRunIntegration;
  const checkpointDigest = crypto.createHash("sha256").update(canonicalJson(payload)).digest("hex");
  const checkpointId = `checkpoint-${checkpointDigest.slice(0, 24)}`;
  const legacy = { ...payload, checkpointId, checkpointDigest };
  fs.writeFileSync(path.join(root, directory, "sessions", "ledger", `${checkpointId}.json`), `${JSON.stringify(legacy, null, 2)}\n`);
  const stateFile = path.join(root, directory, "sessions", "current.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  fs.writeFileSync(stateFile, `${JSON.stringify({ ...state, latestCheckpoint: checkpointId }, null, 2)}\n`);

  assert.equal(readRecoveryCheckpoint({ root, checkpointId }).checkpoint.protocol.version, "0.2.0");
  assert.throws(() => restoreSessionFromArtifacts({ root }), { code: "SESSION_RESTORE_CURRENT_CHECKPOINT_REQUIRED" });
});

test("checkpoint direction survives deletion of pending ResultPacket evidence without inventing a Fresh HEAD review", async (t) => {
  const { root, directory } = initialize(temporaryProject());
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  (await startFixtureRun(root, "pending review recovery"));
  const finished = finishFixtureRun(root);
  const nextExpectedResult = "Recover the exact pending position and request missing evidence instead of guessing";
  createRecoveryCheckpoint({
    root,
    purpose: "Preserve pending review recovery",
    approvedDecisions: [],
    currentPosition: "One ResultPacket is awaiting Fresh HEAD review",
    nextExpectedResult,
  });
  const resultFile = path.join(root, directory, "lineage", "result-packets", `${finished.resultPacket.resultPacketId}.json`);
  fs.unlinkSync(resultFile);

  const restored = restoreSessionFromArtifacts({ root });
  assert.equal(restored.projection.checkpoint.nextExpectedResult, nextExpectedResult);
  assert.equal(restored.projection.pendingReview.resultEvidence.status, "missing-evidence");
  assert.equal(restored.projection.pendingReview.freshHeadReviewContextId, null);
  assert.equal(restored.projection.consumerInstruction.historicalCheckpointContext.nextExpectedResult, nextExpectedResult);
  assert.equal(restored.projection.recoveryAuthority, false);
});

test("accepted worker evidence integrates once through Fresh HEAD into an explicit P2 checkpoint", async (t) => {
  const { root, directory } = initialize(temporaryProject());
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = (await startFixtureRun(root, "bounded worker integration"));
  const finished = finishFixtureRun(root);
  const reviewed = reviewFixtureRun(root, "accept");
  const input = integrationInput(fixture.run, reviewed.reviewDecision);

  const integrated = integrateReviewedRunCheckpoint({ root, ...input });
  assert.equal(integrated.status, "run_result_integrated_checkpointed");
  assert.equal(integrated.checkpoint.authorityBoundary.planeId, "P2");
  assert.equal(integrated.integrationReceipt, undefined);
  assert.equal(fs.existsSync(path.join(root, directory, "sessions/integrations")), false);
  assert.equal(integrated.checkpoint.reviewedRunIntegration.runId, fixture.run.runId);
  assert.equal(integrated.checkpoint.reviewedRunIntegration.resultPacketId, finished.resultPacket.resultPacketId);
  assert.equal(integrated.checkpoint.reviewedRunIntegration.reviewDecisionId, reviewed.reviewDecision.reviewDecisionId);
  assert.equal(integrated.checkpoint.reviewedRunIntegration.integrationRequestId, undefined);
  assert.match(integrated.checkpoint.reviewedRunIntegration.integrationInputHash, /^[a-f0-9]{64}$/);
  assert.equal(integrated.checkpoint.nextExpectedResult, input.nextExpectedResult);

  assert.throws(() => createRecoveryCheckpoint({
    root,
    purpose: input.purpose,
    approvedDecisions: input.approvedDecisions,
    currentPosition: input.currentPosition,
    nextExpectedResult: input.nextExpectedResult,
    openReviewIds: input.openReviewIds,
    reviewedRunIntegration: { runId: input.runId, reviewDecisionId: input.reviewDecisionId },
  }), { code: "INVALID_RUN_RESULT_INTEGRATION" });
  assert.throws(() => createRecoveryCheckpoint({
    root,
    purpose: input.purpose,
    approvedDecisions: input.approvedDecisions,
    currentPosition: input.currentPosition,
    nextExpectedResult: "A direction that differs from the exact stored checkpoint",
    openReviewIds: input.openReviewIds,
    reviewedRunIntegration: {
      runId: input.runId,
      reviewDecisionId: input.reviewDecisionId,
      integrationInputHash: integrated.integration.integrationInputHash,
    },
  }), { code: "RUN_RESULT_INTEGRATION_CONFLICT" });

  const retry = integrateReviewedRunCheckpoint({ root, ...input });
  assert.equal(retry.status, "run_result_integration_existing");
  assert.equal(retry.checkpoint.checkpointId, integrated.checkpoint.checkpointId);
  assert.deepEqual(retry.integration, integrated.integration);
  assert.throws(() => integrateReviewedRunCheckpoint({ root, ...integrationInput(fixture.run, reviewed.reviewDecision, { nextExpectedResult: "A conflicting direction" }) }), {
    code: "RUN_RESULT_INTEGRATION_CONFLICT",
  });
  assert.equal(readRunResultIntegration({ root, reviewDecisionId: reviewed.reviewDecision.reviewDecisionId }).checkpoint.checkpointId, integrated.checkpoint.checkpointId);

  const resultFile = path.join(root, directory, "lineage", "result-packets", `${finished.resultPacket.resultPacketId}.json`);
  fs.unlinkSync(resultFile);
  const requestFile = path.join(root, directory, "sessions", "integrations", "requests", `${reviewed.reviewDecision.reviewDecisionId}.json`);
  const restored = restoreSessionFromArtifacts({ root });
  assert.equal(restored.projection.consumerInstruction.historicalCheckpointContext.nextExpectedResult, input.nextExpectedResult);
  assert.equal(restored.projection.integrationEvidence.status, "missing-evidence");
  assert.equal(restored.projection.reviewedRunIntegration.reviewDecisionId, reviewed.reviewDecision.reviewDecisionId);
  assert.equal(fs.existsSync(requestFile), false);
});

test("non-accept review cannot be mislabeled as worker-result integration", async (t) => {
  const { root, directory } = initialize(temporaryProject());
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = (await startFixtureRun(root, "rejected worker integration"));
  finishFixtureRun(root);
  const reviewed = reviewFixtureRun(root, "revise");
  assert.throws(() => integrateReviewedRunCheckpoint({ root, ...integrationInput(fixture.run, reviewed.reviewDecision) }), {
    code: "RUN_RESULT_NOT_ACCEPTED",
  });
  assert.equal(fs.existsSync(path.join(root, directory, "sessions", "integrations", `${reviewed.reviewDecision.reviewDecisionId}.json`)), false);
  assert.equal(fs.existsSync(path.join(root, directory, "sessions", "integrations", "requests", `${reviewed.reviewDecision.reviewDecisionId}.json`)), false);
});

test("CLI help and MCP expose artifact restore plus explicit integration without provider resume", async (t) => {
  const { root, directory } = initialize(temporaryProject());
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = (await startFixtureRun(root, "MCP integration surface"));
  finishFixtureRun(root);
  const reviewed = reviewFixtureRun(root, "accept");
  const input = integrationInput(fixture.run, reviewed.reviewDecision);

  assert.equal((await runCommand(["help"])).commands.some((command) => command.includes("session-restore")), false);
  assert.equal((await runCommand(["help-all"])).commands.some((command) => command.includes("session-restore")), true);
  assert.equal((await runCommand(["help-all"])).commands.some((command) => command.includes("session-continue")), true);
  assert.equal((await runCommand(["help-all"])).commands.some((command) => command.includes("worker-dispatch")), false);
  assert.equal((await runCommand(["managed-maintenance", "help-all"])).commands.some((command) => command.includes("worker-wave-create")), true);
  assert.equal(mcpTools.some((tool) => tool.name === "lode_session_restore"), true);
  assert.equal(mcpTools.some((tool) => tool.name === "lode_session_continue"), true);
  assert.equal(mcpTools.some((tool) => tool.name === "lode_bounded_worker_dispatch"), true);
  assert.equal(mcpTools.some((tool) => tool.name === "lode_bounded_worker_wait"), true);
  assert.equal(mcpTools.some((tool) => tool.name === "lode_bounded_worker_wave_create"), true);
  assert.equal(mcpTools.some((tool) => tool.name === "lode_bounded_worker_wave_read"), true);
  assert.equal(mcpTools.some((tool) => tool.name === "lode_bounded_worker_wave_seal"), true);
  assert.equal(mcpTools.some((tool) => tool.name === "lode_bounded_worker_wave_status"), true);
  assert.equal(mcpTools.some((tool) => tool.name === "lode_bounded_worker_wave_results"), true);
  assert.equal(mcpTools.some((tool) => tool.name === "lode_bounded_worker_wave_wait"), true);
  assert.equal(mcpTools.some((tool) => tool.name === "lode_bounded_worker_wave_abandon"), true);
  assert.equal(mcpTools.some((tool) => tool.name === "lode_run_integrate_checkpoint"), true);

  const integrated = await dispatch({
    jsonrpc: "2.0",
    id: 701,
    method: "tools/call",
    params: {
      name: "lode_run_integrate_checkpoint",
      arguments: {
        project_root: root,
        run_id: input.runId,
        review_decision_id: input.reviewDecisionId,
        purpose: input.purpose,
        approved_decisions: input.approvedDecisions,
        current_position: input.currentPosition,
        next_expected_result: input.nextExpectedResult,
      },
    },
  });
  assert.equal(integrated.result.structuredContent.status, "run_result_integrated_checkpointed");

  const restored = await dispatch({
    jsonrpc: "2.0",
    id: 702,
    method: "tools/call",
    params: { name: "lode_session_restore", arguments: { project_root: root } },
  });
  assert.equal(restored.result.structuredContent.status, "session_restored_from_artifacts");
  assert.equal(restored.result.structuredContent.projection.providerBoundary.resumeEnabled, false);
  assert.equal(restored.result.structuredContent.projection.consumerInstruction.historicalCheckpointContext.nextExpectedResult, input.nextExpectedResult);

  const continued = await dispatch({
    jsonrpc: "2.0",
    id: 703,
    method: "tools/call",
    params: { name: "lode_session_continue", arguments: { project_root: root, runtime: "codex" } },
  });
  assert.equal(continued.result.structuredContent.status, "session_continued_with_fresh_logical_head");
  assert.equal(continued.result.structuredContent.continuationOutcome.p2RestoredBeforeAttachment, true);
  assert.equal(continued.result.structuredContent.continuationOutcome.p2DirectionChanged, false);
  assert.equal(continued.result.structuredContent.continuationOutcome.providerSessionIdentityPersisted, false);
});

test("hostless resident HEAD recovery verifier closes crash, concurrency, provider-loss, and inbox-authority counterexamples", () => {
  const verifier = path.join(pluginRoot, "scripts", "verify-hostless-session-recovery.mjs");
  const result = spawnSync(process.execPath, [verifier], {
    cwd: pluginRoot,
    env: { ...process.env },
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "hostless_resident_head_recovery_verified");
  assert.equal(report.processBoundary.identicalProjectionAcrossCodexOpenCode, true);
  assert.equal(report.crashRecovery.beforeCheckpointConverged, true);
  assert.equal(report.crashRecovery.checkpointBeforeSessionConverged, true);
  assert.equal(report.crashRecovery.extraRequestOrReceiptCreated, false);
  assert.equal(report.missingEvidence.missingEvidenceDisclosed, true);
  assert.equal(report.missingEvidence.nextExpectedResultUnchanged, true);
  assert.equal(report.concurrency.checkpointCount, 1);
  assert.equal(report.concurrency.divergentPurposeRejected, "RUN_RESULT_INTEGRATION_CONFLICT");
  assert.equal(report.authority.nonAcceptRejected, "RUN_RESULT_NOT_ACCEPTED");
  assert.equal(report.authority.inboxReplyUsedAsDirection, false);
  assert.equal(report.residentHeadConsumer.sameOutcomeAfterProviderReplacement, true);
  assert.deepEqual(report.dependencies, {
    gitRequired: false,
    graphDbRequired: false,
    workspaceHostRequired: false,
    herdrRequired: false,
  });
});
