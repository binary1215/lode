import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject, SCHEMA_VERSION } from "../scripts/lib/head-core.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { createExecutionContract, createWholePlanSnapshot } from "../scripts/lib/execution-lineage.mjs";
import { startRun, finishRun, getPendingReviewContext, reviewRun } from "../scripts/lib/run-lineage.mjs";
import { createRecoveryCheckpoint } from "../scripts/lib/compaction-recovery.mjs";
import { integrateReviewedRunCheckpoint, readRunResultIntegration, restoreSessionFromArtifacts } from "../scripts/lib/session-recovery.mjs";
import { artifactAuthorityBoundary } from "../scripts/lib/authority-plane-contract.mjs";
import { createHeadSession, withSessionRoute } from "../scripts/lib/session-routing.mjs";
import { updateProjectDirection } from "../scripts/lib/project-direction.mjs";

import { seedLegacyProject } from "./helpers/legacy-project-fixture.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";


const pluginRoot = path.resolve(import.meta.dirname, "..");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };
async function fixture(t, { legacy = false } = {}) {
  const parent = process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "head-legacy-integration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (legacy) seedLegacyProject(root, pluginRoot);
  else initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage, directory = formatForVerifiedOwner(storage).directory;
  const capsule = (await compileContext({ root, task: "Verify legacy integration original reading", budget: 2048, persist: true })).capsule;
  const plan = createWholePlanSnapshot({ root, objective: "Preserve original approval", plan: [{ id: "execute", outcome: "Original identity survives" }] }).artifact;
  const contract = createExecutionContract({ root, wholePlanId: plan.wholePlanId, capsuleId: capsule.capsuleId,
    scope: "Bounded legacy fixture", acceptanceCriteria: ["Original approval is exact"] }).artifact;
  const run = startRun({ root, executionContractId: contract.executionContractId }).run;
  finishRun({ root, outcome: "Original integration fixture", evidence: [{ uri: "test/legacy-integration-read.test.mjs", digest: "fixture" }],
    planDelta: "No rewrite", impactRadius: ["test fixture"], verification: [{ check: "fixture", status: "passed" }], unknowns: [] });
  const review = reviewRun({ root, reviewContextId: getPendingReviewContext({ root }).review.reviewContextId,
    disposition: "accept", rationale: "Exact fixture verified", nextActions: ["Record explicit direction"] }).reviewDecision;
  const input = { runId: run.runId, reviewDecisionId: review.reviewDecisionId, purpose: "Preserve reviewed original",
    approvedDecisions: ["Exact result accepted"], currentPosition: "Accepted fixture", nextExpectedResult: "Manual next authorized work", openReviewIds: [] };
  return { root, input, storage, directory, stateFile: path.join(root, directory, "sessions", "current.json") };
}

// Frozen 0.1 request/receipt shapes are copied from the historical producer,
// not a production migration or compatibility producer API.
function historicalRequest(root, input, changes = {}) {
  const inspected = inspectProject(root);
  const payload = { schemaVersion: SCHEMA_VERSION, kind: "RunResultIntegrationRequest",
    protocol: { name: "head-agent-core-run-result-integration", version: "0.1.0" },
    projectId: inspected.project.projectId, sessionId: inspected.state.sessionId,
    authorityBoundary: artifactAuthorityBoundary("RunResultIntegrationRequest"),
    runId: input.runId, reviewDecisionId: input.reviewDecisionId, input, integrationInputHash: hash(input),
    requestedAt: "2026-09-22T00:00:00.000Z", recoveryAuthority: false, instructionAuthority: false, promotionAuthority: false, ...changes };
  const integrationRequestHash = hash(payload);
  const request = { ...payload, integrationRequestId: `run-result-integration-request-${integrationRequestHash.slice(0, 24)}`, integrationRequestHash };
  const file = path.join(root, ".head", "sessions", "integrations", "requests", `${input.reviewDecisionId}.json`);
  write(file, request);
  return { request, file };
}
function committedHistorical(f) {
  const current = integrateReviewedRunCheckpoint({ root: f.root, ...f.input });
  const { request, file: requestFile } = historicalRequest(f.root, f.input);
  const { checkpointId: discardedId, checkpointDigest: discardedDigest, ...payload } = current.checkpoint;
  const { previousCheckpointId, ...integration } = payload.reviewedRunIntegration;
  payload.reviewedRunIntegration = { ...integration, integrationRequestId: request.integrationRequestId };
  const checkpointDigest = hash(payload);
  const checkpoint = { ...payload, checkpointId: `checkpoint-${checkpointDigest.slice(0, 24)}`, checkpointDigest };
  const checkpointFile = path.join(f.root, ".head", "sessions", "ledger", `${checkpoint.checkpointId}.json`);
  write(checkpointFile, checkpoint);
  fs.unlinkSync(current.file); // Exact owned synthetic record replaced by the frozen old-format fixture.
  write(f.stateFile, { ...JSON.parse(fs.readFileSync(f.stateFile)), latestCheckpoint: checkpoint.checkpointId });
  const receiptPayload = { schemaVersion: SCHEMA_VERSION, kind: "RunResultIntegrationReceipt",
    protocol: { name: "head-agent-core-run-result-integration", version: "0.1.0" },
    projectId: checkpoint.projectId, sessionId: checkpoint.sessionId, authorityBoundary: artifactAuthorityBoundary("RunResultIntegrationReceipt"),
    runId: f.input.runId, reviewDecisionId: f.input.reviewDecisionId, resultPacketId: integration.resultPacketId,
    checkpointId: checkpoint.checkpointId, checkpointDigest, integrationRequestId: request.integrationRequestId,
    integrationInputHash: request.integrationInputHash, integratedAt: "2026-09-22T00:01:00.000Z",
    checkpointFieldSource: "explicit-head-user-integration-input-only", resultPacketRole: "reference-evidence-only",
    reviewDecisionCreated: false, recoveryAuthority: false, instructionAuthority: false, promotionAuthority: false };
  const integrationReceiptHash = hash(receiptPayload);
  const receipt = { ...receiptPayload, integrationReceiptId: `run-result-integration-${integrationReceiptHash.slice(0, 24)}`, integrationReceiptHash };
  const receiptFile = path.join(f.root, ".head", "sessions", "integrations", `${f.input.reviewDecisionId}.json`);
  write(receiptFile, receipt);
  return { requestFile, checkpointFile, receiptFile, checkpoint, receipt };
}
function bytes(files) { return files.map((file) => fs.readFileSync(file, "utf8")); }
function checkpointFiles(root) {
  const ledger = path.join(root, ".head", "sessions", "ledger");
  return fs.existsSync(ledger) ? fs.readdirSync(ledger).filter((name) => name.endsWith(".json")) : [];
}

test("new integration accepts only three fields and never produces historical request or receipt", async (t) => {
  const f = (await fixture(t));
  assert.throws(() => createRecoveryCheckpoint({ root: f.root, ...f.input, reviewedRunIntegration: {
    runId: f.input.runId, reviewDecisionId: f.input.reviewDecisionId, integrationInputHash: hash(f.input),
    integrationRequestId: "run-result-integration-request-000000000000000000000000" } }), { code: "INVALID_RUN_RESULT_INTEGRATION" });
  const recorded = integrateReviewedRunCheckpoint({ root: f.root, ...f.input });
  assert.equal(Object.hasOwn(recorded.integration, "integrationRequestId"), false);
  assert.equal(Object.hasOwn(recorded.integration, "previousCheckpointId"), true);
  assert.equal(fs.existsSync(path.join(f.root, f.directory, "sessions", "integrations")), false);
  const originals = bytes([f.stateFile, recorded.file]);
  assert.equal(integrateReviewedRunCheckpoint({ root: f.root, ...f.input }).checkpoint.checkpointId, recorded.checkpoint.checkpointId);
  assert.deepEqual(bytes([f.stateFile, recorded.file]), originals);
});

test("fully committed historical originals reuse identity and bytes even after independent newer direction", async (t) => {
  const f = (await fixture(t, { legacy: true }));
  const legacy = committedHistorical(f);
  const files = [legacy.requestFile, legacy.checkpointFile, legacy.receiptFile, f.stateFile];
  const originals = bytes(files);
  assert.equal(readRunResultIntegration({ root: f.root, reviewDecisionId: f.input.reviewDecisionId }).receipt.integrationReceiptId, legacy.receipt.integrationReceiptId);
  assert.equal(integrateReviewedRunCheckpoint({ root: f.root, ...f.input }).checkpoint.checkpointId, legacy.checkpoint.checkpointId);
  assert.deepEqual(bytes(files), originals);
  const current = createRecoveryCheckpoint({ root: f.root, purpose: "Independent newer direction", currentPosition: "Newer work", nextExpectedResult: "Keep latest checkpoint" }).checkpoint;
  const currentBytes = fs.readFileSync(f.stateFile, "utf8");
  assert.equal(integrateReviewedRunCheckpoint({ root: f.root, ...f.input }).checkpoint.checkpointId, legacy.checkpoint.checkpointId);
  assert.equal(fs.readFileSync(f.stateFile, "utf8"), currentBytes);
  assert.equal(inspectProject(f.root).state.latestCheckpoint, current.checkpointId);
  assert.deepEqual(bytes(files.slice(0, 3)), originals.slice(0, 3));
});

test("historical restore preserves missing optional result evidence and latest common cancellation", async (t) => {
  const f = (await fixture(t, { legacy: true }));
  const legacy = committedHistorical(f);
  const originals = bytes([legacy.requestFile, legacy.checkpointFile, legacy.receiptFile]);
  const direction = updateProjectDirection({ root: f.root, input: { goal: "Current common goal", cancelledActions: ["Manual next authorized work"] } }).direction;
  fs.unlinkSync(path.join(f.root, ".head", "lineage", "result-packets", `${legacy.checkpoint.reviewedRunIntegration.resultPacketId}.json`));
  const restored = restoreSessionFromArtifacts({ root: f.root });
  assert.equal(restored.projection.integrationEvidence.status, "missing-evidence");
  assert.equal(restored.projection.currentProjectDirection.directionId, direction.directionId);
  assert.equal(readRunResultIntegration({ root: f.root, reviewDecisionId: f.input.reviewDecisionId }).checkpoint.checkpointId, legacy.checkpoint.checkpointId);
  assert.deepEqual(bytes([legacy.requestFile, legacy.checkpointFile, legacy.receiptFile]), originals);
});

test("verified request-only interruption remains pending without writes and cannot block independent Session work", async (t) => {
  const f = (await fixture(t, { legacy: true }));
  const legacy = historicalRequest(f.root, f.input);
  const cancellation = updateProjectDirection({ root: f.root, input: { goal: "Current goal", cancelledActions: [f.input.nextExpectedResult] } }).direction;
  const originals = bytes([legacy.file, f.stateFile]);
  const before = checkpointFiles(f.root);
  const pending = readRunResultIntegration({ root: f.root, reviewDecisionId: f.input.reviewDecisionId });
  assert.equal(pending.status, "legacy_integration_pending");
  assert.equal(pending.file, legacy.file);
  assert.deepEqual(pending.historicalInput, f.input);
  assert.equal(pending.originalRole, "historical-P3-reference-evidence-not-restored-P2-direction");
  assert.equal(pending.recoveryAuthority, false);
  assert.equal(pending.instructionAuthority, false);
  assert.equal(pending.promotionAuthority, false);
  assert.equal(pending.currentProjectDirection.directionId, cancellation.directionId);
  assert.equal(pending.ordinaryWorkBlocked, false);
  assert.equal(pending.userDecisionRequired, false);
  assert.throws(() => integrateReviewedRunCheckpoint({ root: f.root, ...f.input }), (error) => {
    assert.equal(error.code, "RUN_RESULT_LEGACY_INTEGRATION_PENDING");
    assert.equal(error.pendingIntegration.request.integrationRequestId, legacy.request.integrationRequestId);
    assert.match(error.message, /manually transfer/); return true;
  });
  assert.throws(() => integrateReviewedRunCheckpoint({ root: f.root, ...f.input, nextExpectedResult: "Divergent direction" }), { code: "RUN_RESULT_INTEGRATION_CONFLICT" });
  assert.throws(() => createRecoveryCheckpoint({ root: f.root, ...f.input, reviewedRunIntegration: {
    runId: f.input.runId, reviewDecisionId: f.input.reviewDecisionId, integrationInputHash: hash(f.input) } }), { code: "RUN_RESULT_LEGACY_INTEGRATION_PENDING" });
  assert.deepEqual(bytes([legacy.file, f.stateFile]), originals);
  assert.deepEqual(checkpointFiles(f.root), before);
  const other = createHeadSession({ root: f.root, purpose: "Independent ordinary work" });
  withSessionRoute(f.root, other.sessionId, () => {
    const checkpoint = createRecoveryCheckpoint({ root: f.root, purpose: "Independent session direction", currentPosition: "Ordinary independent work", nextExpectedResult: "Still applicable work" }).checkpoint;
    assert.equal(restoreSessionFromArtifacts({ root: f.root }).checkpoint.checkpointId, checkpoint.checkpointId);
    assert.throws(() => readRunResultIntegration({ root: f.root, reviewDecisionId: f.input.reviewDecisionId }), { code: "RUN_RESULT_INTEGRATION_REQUEST_CONFLICT" });
  });
  const ordinary = createRecoveryCheckpoint({ root: f.root, purpose: "Direct work", currentPosition: "Pending integration only", nextExpectedResult: "Unrelated direct next work" }).checkpoint;
  assert.equal(restoreSessionFromArtifacts({ root: f.root }).checkpoint.checkpointId, ordinary.checkpointId);
  assert.equal(fs.readFileSync(legacy.file, "utf8"), originals[0]);
});

test("historical target request corruption, wrong owner and malformed originals fail locally and are preserved", async (t) => {
  const f = (await fixture(t, { legacy: true }));
  let legacy = historicalRequest(f.root, f.input, { projectId: "another-project" });
  assert.throws(() => readRunResultIntegration({ root: f.root, reviewDecisionId: f.input.reviewDecisionId }), { code: "RUN_RESULT_INTEGRATION_REQUEST_CONFLICT" });
  legacy = historicalRequest(f.root, f.input, { sessionId: "session-00000000-0000-0000-0000-000000000000" });
  assert.throws(() => readRunResultIntegration({ root: f.root, reviewDecisionId: f.input.reviewDecisionId }), { code: "RUN_RESULT_INTEGRATION_REQUEST_CONFLICT" });
  legacy = historicalRequest(f.root, f.input);
  write(legacy.file, { ...legacy.request, integrationInputHash: "0".repeat(64) });
  const corrupt = fs.readFileSync(legacy.file, "utf8");
  assert.throws(() => integrateReviewedRunCheckpoint({ root: f.root, ...f.input }), { code: "RUN_RESULT_INTEGRATION_REQUEST_DIGEST_MISMATCH" });
  assert.equal(fs.readFileSync(legacy.file, "utf8"), corrupt);
  fs.writeFileSync(legacy.file, "{broken");
  assert.throws(() => readRunResultIntegration({ root: f.root, reviewDecisionId: f.input.reviewDecisionId }), { code: "INVALID_SESSION_RECOVERY_ARTIFACT" });
  assert.equal(fs.readFileSync(legacy.file, "utf8"), "{broken");
  assert.doesNotThrow(() => createRecoveryCheckpoint({ root: f.root, purpose: "Unrelated local work", currentPosition: "Target failure only", nextExpectedResult: "Direct work" }));
});

test("historical committed receipt damage is not bypassed by an exact replay", async (t) => {
  const f = (await fixture(t, { legacy: true }));
  const legacy = committedHistorical(f);
  write(legacy.receiptFile, { ...legacy.receipt, checkpointDigest: "0".repeat(64) });
  const originals = bytes([legacy.requestFile, legacy.checkpointFile, legacy.receiptFile, f.stateFile]);
  assert.throws(() => integrateReviewedRunCheckpoint({ root: f.root, ...f.input }), { code: "RUN_RESULT_INTEGRATION_RECEIPT_DIGEST_MISMATCH" });
  assert.deepEqual(bytes([legacy.requestFile, legacy.checkpointFile, legacy.receiptFile, f.stateFile]), originals);
});
