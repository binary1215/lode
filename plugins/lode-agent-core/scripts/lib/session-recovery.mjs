import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readProjectDirectionView, sameProjectDirectionView } from "./project-direction-view.mjs";
import { assertRunSession } from "./session-routing.mjs";
import { inspectRunStorageTransition } from "./run-lineage.mjs";
import { inspectProject, isProjectRecoveryReadable, SCHEMA_VERSION } from "./lode-core.mjs";
import { readContextCapsule } from "./context-compiler.mjs";
import { buildFreshLodeReview, readLineageArtifact } from "./execution-lineage.mjs";
import { COMPACTION_RECOVERY_VERSION, createRecoveryCheckpoint, readRecoveryCheckpoint } from "./compaction-recovery.mjs";
import { artifactAuthorityBoundary, verifyArtifactAuthorityBoundary } from "./authority-plane-contract.mjs";

import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";

export const SESSION_RECOVERY_VERSION = "0.2.0";
// Frozen historical integration originals do not share the projection version.
const HISTORICAL_INTEGRATION_VERSION = "0.1.0";

const fail = (message, code = "SESSION_RECOVERY_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

const canonicalJson = (value) => JSON.stringify(canonical(value));
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is required.`, "INVALID_SESSION_RECOVERY_INPUT");
  return value.trim();
}

function stringList(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    fail(`${label} must be an array of non-empty strings.`, "INVALID_SESSION_RECOVERY_INPUT");
  }
  return [...new Set(value.map((item) => item.trim()))].sort();
}

function readyProject(root, action, { readOnly = false } = {}) {
  const inspected = inspectProject(root);
  if (readOnly ? !isProjectRecoveryReadable(inspected) : inspected.status !== "ready") fail(`Project must be ready before ${action}; current status: ${inspected.status}.`, "PROJECT_NOT_READY");
  if (typeof inspected.state?.sessionId !== "string" || !inspected.state.sessionId) {
    fail("Session canon is missing its canonical identity.", "INVALID_SESSION_CANON");
  }
  return inspected;
}

function sessionPointer(state) {
  return {
    mode: state.mode,
    currentWholePlanId: state.currentWholePlanId || null,
    activeRunId: state.activeRunId || null,
    activeExecutionContractId: state.activeExecutionContractId || null,
    lastResultPacketId: state.lastResultPacketId || null,
    pendingReview: state.pendingReview == null ? null : canonical(state.pendingReview),
    lastReviewDecisionId: state.lastReviewDecisionId || null,
    requiredPlanAction: state.requiredPlanAction == null ? null : canonical(state.requiredPlanAction),
  };
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`${label} is invalid JSON: ${error.message}`, "INVALID_SESSION_RECOVERY_ARTIFACT"); }
}

function runFile(root, runId, storage) {
  if (typeof runId !== "string" || !/^run-[0-9]+-[a-f0-9]{6}$/.test(runId)) {
    fail("Run id is invalid.", "INVALID_SESSION_RUN_ID");
  }
  return path.join(root, formatForVerifiedOwner(storage).directory, "sessions", "runs", runId, "run.json");
}

function readRun(root, runId, storage) {
  const file = runFile(root, runId, storage);
  if (!fs.existsSync(file)) fail(`Run canon not found: ${runId}`, "SESSION_RUN_NOT_FOUND");
  const run = readJson(file, "Run canon");
  const inspected = inspectProject(root);
  assertRunSession(root, run, inspected.state);
  if (run.projectId !== inspected.project.projectId) fail("Run belongs to another Project.", "SESSION_RUN_IDENTITY_MISMATCH");
  if (run.runId !== runId) fail("Run canon identity is invalid.", "SESSION_RUN_IDENTITY_MISMATCH");
  return run;
}

function verifiedArtifact(root, artifactId, kind) {
  const artifact = readLineageArtifact({ root, artifactId }).artifact;
  if (artifact.kind !== kind) fail(`Expected ${kind}: ${artifactId}`, "SESSION_RECOVERY_LINEAGE_KIND_MISMATCH");
  return artifact;
}

function verifiedActiveRun(root, pointer, storage) {
  const run = readRun(root, pointer.activeRunId, storage);
  if (run.status !== "active" || run.executionContractId !== pointer.activeExecutionContractId
    || run.wholePlanId !== pointer.currentWholePlanId) {
    fail("Active Run canon does not match the Session pointer.", "SESSION_RESTORE_ACTIVE_RUN_CONFLICT");
  }
  const contract = verifiedArtifact(root, run.executionContractId, "ExecutionContract");
  const plan = verifiedArtifact(root, run.wholePlanId, "WholePlanSnapshot");
  const capsule = readContextCapsule({ root, capsuleId: run.capsuleId }).capsule;
  const expected = {
    runId: run.runId,
    wholePlanId: plan.wholePlanId,
    executionContractId: contract.executionContractId,
    contextCapsuleDigest: capsule.capsuleHash,
    currentResultPacketId: pointer.lastResultPacketId,
  };
  if (contract.wholePlanId !== plan.wholePlanId || contract.capsuleId !== run.capsuleId) {
    fail("Active Run contract, plan and Capsule disagree.", "SESSION_RESTORE_ACTIVE_RUN_CONFLICT");
  }
  return expected;
}

function optionalResultEvidence(root, resultPacketId) {
  if (!resultPacketId) return { status: "not-applicable", resultPacketId: null };
  try {
    const result = verifiedArtifact(root, resultPacketId, "ResultPacket");
    return { status: "verified", resultPacketId: result.resultPacketId, artifactHash: result.artifactHash };
  } catch (error) {
    if (error.code !== "LINEAGE_ARTIFACT_NOT_FOUND") throw error;
    return { status: "missing-evidence", resultPacketId, artifactHash: null };
  }
}

function verifiedPendingReview(root, pointer, storage) {
  const pending = pointer.pendingReview;
  if (!pending || typeof pending !== "object" || !pending.runId || !pending.wholePlanId || !pending.resultPacketId) {
    fail("Pending review Session pointer is incomplete.", "SESSION_RESTORE_PENDING_REVIEW_CONFLICT");
  }
  const run = readRun(root, pending.runId, storage);
  if (run.status !== "awaiting_review" || run.wholePlanId !== pending.wholePlanId || run.resultPacketId !== pending.resultPacketId) {
    fail("Pending review does not match Run canon.", "SESSION_RESTORE_PENDING_REVIEW_CONFLICT");
  }
  verifiedArtifact(root, pending.wholePlanId, "WholePlanSnapshot");
  const evidence = optionalResultEvidence(root, pending.resultPacketId);
  let freshHeadReviewContextId = null;
  if (evidence.status === "verified") {
    freshHeadReviewContextId = buildFreshLodeReview({
      root,
      wholePlanId: pending.wholePlanId,
      resultPacketId: pending.resultPacketId,
      sessionId: pointer.sessionId,
      runId: pending.runId,
    }).review.reviewContextId;
  }
  return { ...pending, resultEvidence: evidence, freshHeadReviewContextId };
}

function verifyLastReview(root, pointer) {
  if (!pointer.lastReviewDecisionId) return null;
  const review = verifiedArtifact(root, pointer.lastReviewDecisionId, "ReviewDecision");
  if (pointer.requiredPlanAction && pointer.requiredPlanAction.reviewDecisionId !== review.reviewDecisionId) {
    fail("Required plan action does not match the last ReviewDecision.", "SESSION_RESTORE_REQUIRED_PLAN_ACTION_CONFLICT");
  }
  return {
    reviewDecisionId: review.reviewDecisionId,
    artifactHash: review.artifactHash,
    disposition: review.disposition,
    wholePlanId: review.wholePlanId,
    resultPacketId: review.resultPacketId,
  };
}

function verifyReviewedRunIntegration(root, checkpoint, storage) {
  const integration = checkpoint.reviewedRunIntegration;
  if (integration == null) return null;
  const run = readRun(root, integration.runId, storage);
  const review = verifiedArtifact(root, integration.reviewDecisionId, "ReviewDecision");
  const plan = verifiedArtifact(root, integration.wholePlanId, "WholePlanSnapshot");
  const contract = verifiedArtifact(root, integration.executionContractId, "ExecutionContract");
  const capsule = readContextCapsule({ root, capsuleId: contract.capsuleId }).capsule;
  const expected = {
    runId: run.runId,
    wholePlanId: plan.wholePlanId,
    executionContractId: contract.executionContractId,
    contextCapsuleDigest: capsule.capsuleHash,
    resultPacketId: integration.resultPacketId,
    reviewDecisionId: review.reviewDecisionId,
    reviewContextId: review.reviewContextId,
    ...(Object.hasOwn(integration, "integrationRequestId") ? { integrationRequestId: integration.integrationRequestId } : { previousCheckpointId: integration.previousCheckpointId }),
    integrationInputHash: integration.integrationInputHash,
    disposition: review.disposition,
    reviewedAt: run.reviewedAt,
  };
  const checkpointInput = {
    runId: integration.runId,
    reviewDecisionId: integration.reviewDecisionId,
    purpose: checkpoint.purpose,
    approvedDecisions: checkpoint.approvedDecisions,
    currentPosition: checkpoint.currentPosition,
    nextExpectedResult: checkpoint.nextExpectedResult,
    openReviewIds: checkpoint.openReviewIds,
  };
  const checkpointInputHash = digest(canonicalJson(checkpointInput));
  if (run.status !== "reviewed" || run.reviewDecisionId !== review.reviewDecisionId
    || run.resultPacketId !== integration.resultPacketId || run.wholePlanId !== plan.wholePlanId
    || run.executionContractId !== contract.executionContractId || run.capsuleId !== contract.capsuleId
    || review.disposition !== "accept" || review.resultPacketId !== integration.resultPacketId
    || review.wholePlanId !== plan.wholePlanId
    || Object.hasOwn(integration, "integrationRequestId") && !/^run-result-integration-request-[a-f0-9]{24}$/.test(integration.integrationRequestId)
    || integration.integrationInputHash !== checkpointInputHash
    || canonicalJson(expected) !== canonicalJson(integration)) {
    fail("Reviewed Run integration reference no longer matches verified lineage.", "SESSION_RESTORE_INTEGRATION_LINEAGE_CONFLICT");
  }
  return expected;
}

function verifyPointerShape(pointer) {
  if (!new Set(["session", "run", "review"]).has(pointer.mode)) {
    fail("Session mode is invalid for artifact-only restore.", "SESSION_RESTORE_MODE_CONFLICT");
  }
  if (pointer.activeRunId && pointer.pendingReview) {
    fail("Session cannot have an active Run and pending review simultaneously.", "SESSION_RESTORE_MODE_CONFLICT");
  }
  if (Boolean(pointer.activeRunId) !== Boolean(pointer.activeExecutionContractId)
    || pointer.activeRunId && !pointer.currentWholePlanId) {
    fail("Current Session has an orphan Run/contract/plan reference.", "SESSION_RESTORE_ACTIVE_RUN_CONFLICT");
  }
  if ((pointer.mode === "run") !== Boolean(pointer.activeRunId)
    || (pointer.mode === "review") !== Boolean(pointer.pendingReview)
    || (pointer.mode === "session") !== (!pointer.activeRunId && !pointer.pendingReview)) {
    fail("Session mode does not match its Run/review pointers.", "SESSION_RESTORE_MODE_CONFLICT");
  }
}

function projectionIdentity(payload) {
  const sessionRestoreHash = digest(canonicalJson(payload));
  return { ...payload, sessionRestoreId: `session-restore-${sessionRestoreHash.slice(0, 24)}`, sessionRestoreHash };
}

export function restoreSessionFromArtifacts({ root = ".", checkpointId = null } = {}) {
  const inspected = readyProject(root, "artifact-only Session restore", { readOnly: true });
  const selectedCheckpointId = checkpointId == null ? inspected.state.latestCheckpoint : requiredText(checkpointId, "Recovery checkpoint id");
  if (!selectedCheckpointId) fail("Session restore requires a current canonical recovery checkpoint.", "SESSION_RESTORE_CHECKPOINT_REQUIRED");
  if (inspected.state.latestCheckpoint !== selectedCheckpointId) {
    fail("Session restore accepts only the current canonical checkpoint pointer.", "SESSION_RESTORE_CHECKPOINT_NOT_CURRENT");
  }
  const checkpoint = readRecoveryCheckpoint({ root: inspected.project.projectRoot, checkpointId: selectedCheckpointId }).checkpoint;
  if (checkpoint.protocol.version !== COMPACTION_RECOVERY_VERSION || !checkpoint.sessionPointer) {
    fail("Legacy checkpoints remain readable but cannot drive artifact-only Session restore.", "SESSION_RESTORE_CURRENT_CHECKPOINT_REQUIRED");
  }
  const currentPointer = { sessionId: inspected.state.sessionId, ...sessionPointer(inspected.state) };
  const checkpointPointer = { sessionId: checkpoint.sessionId, ...checkpoint.sessionPointer };
  // The checkpoint preserves meaning and its historical position. Current P2
  // facts are verified on their own, not made to equal that past position.
  const checkpointMatchesCurrentExecution = canonicalJson(currentPointer) === canonicalJson(checkpointPointer);
  verifyPointerShape(currentPointer);
  const storageTransition = inspectRunStorageTransition({ root: inspected.project.projectRoot, inspected });
  const currentRunId = currentPointer.activeRunId || currentPointer.pendingReview?.runId || inspected.state.lastReviewedRunId;
  const currentRunBasis = currentRunId ? digest(fs.readFileSync(runFile(inspected.project.projectRoot, currentRunId, inspected.storage))) : null;
  const executionIncomplete = new Set(["incomplete", "conflict"]).has(storageTransition.status);
  if (currentPointer.currentWholePlanId) verifiedArtifact(inspected.project.projectRoot, currentPointer.currentWholePlanId, "WholePlanSnapshot");
  const activeRun = currentPointer.activeRunId && !executionIncomplete
    ? verifiedActiveRun(inspected.project.projectRoot, currentPointer, inspected.storage)
    : null;
  const pendingReview = currentPointer.pendingReview && !executionIncomplete
    ? verifiedPendingReview(inspected.project.projectRoot, currentPointer, inspected.storage)
    : null;
  const lastReviewDecision = verifyLastReview(inspected.project.projectRoot, currentPointer);
  let reviewedRunIntegration;
  try { reviewedRunIntegration = verifyReviewedRunIntegration(inspected.project.projectRoot, checkpoint, inspected.storage); }
  catch (error) {
    if (!new Set(["SESSION_RUN_NOT_FOUND", "CAPSULE_NOT_FOUND", "LINEAGE_ARTIFACT_NOT_FOUND"]).has(error.code)) throw error;
    reviewedRunIntegration = { ...checkpoint.reviewedRunIntegration, status: "historical-reference-unavailable", reasonCode: error.code };
  }
  const lastResultEvidence = optionalResultEvidence(inspected.project.projectRoot, currentPointer.lastResultPacketId);
  const integrationEvidence = reviewedRunIntegration?.resultPacketId
    ? optionalResultEvidence(inspected.project.projectRoot, reviewedRunIntegration.resultPacketId)
    : { status: "not-applicable", resultPacketId: null, artifactHash: null };
  const directionView = readProjectDirectionView({ root: inspected.project.projectRoot });
  const { currentProjectDirection } = directionView;
  const after = inspectProject(inspected.project.projectRoot);
  const directionAfter = readProjectDirectionView({ root: inspected.project.projectRoot });
  if (!isProjectRecoveryReadable(after) || canonicalJson(after.project) !== canonicalJson(inspected.project)
    || canonicalJson(after.state) !== canonicalJson(inspected.state)
    || !sameProjectDirectionView(directionAfter, directionView)
    || (currentRunId ? digest(fs.readFileSync(runFile(inspected.project.projectRoot, currentRunId, inspected.storage))) : null) !== currentRunBasis) {
    fail("Session or common direction changed during restore; reread only this observation.", "SESSION_RESTORE_OBSERVATION_CHANGED");
  }
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "SessionRestoreProjection",
    protocol: { name: formatForVerifiedOwner(inspected.storage).protocol("head-agent-core-artifact-session-restore"), version: SESSION_RECOVERY_VERSION },
    projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId,
    ...directionView,
    authorityBoundary: artifactAuthorityBoundary("SessionRestoreProjection"),
    checkpoint: {
      checkpointId: checkpoint.checkpointId,
      checkpointDigest: checkpoint.checkpointDigest,
      purpose: checkpoint.purpose,
      approvedDecisions: checkpoint.approvedDecisions,
      currentPosition: checkpoint.currentPosition,
      nextExpectedResult: checkpoint.nextExpectedResult,
      openReviewIds: checkpoint.openReviewIds,
    },
    sessionPointer: sessionPointer(inspected.state),
    checkpointMatchesCurrentExecution,
    currentExecution: { status: executionIncomplete ? storageTransition.status : "verified", sessionPointer: currentPointer, activeRun, pendingReview, lastReviewDecision, storageTransition },
    activeRun,
    pendingReview,
    lastReviewDecision,
    lastResultEvidence,
    reviewedRunIntegration,
    integrationEvidence,
    consumerInstruction: {
      mode: formatForVerifiedOwner(inspected.storage).value("fresh-logical-head-from-verified-artifacts"),
      purpose: checkpoint.purpose,
      historicalCheckpointContext: { currentPosition: checkpoint.currentPosition, nextExpectedResult: checkpoint.nextExpectedResult },
      currentExecution: { status: executionIncomplete ? storageTransition.status : "verified", sessionPointer: currentPointer, activeRun, pendingReview, lastReviewDecision, storageTransition },
      nextActionOwner: formatForVerifiedOwner(inspected.storage).value("current-head-assessment-not-historical-checkpoint-replay"),
      historicalApprovalGrantsCurrentEffect: false,
      ...(currentProjectDirection ? { currentProjectDirection,
        commonDirectionPrecedence: "current-common-constraints-and-cancellations-apply-before-historical-session-intent" } : {}),
      ...(directionView.currentProjectDirectionAvailability ? {
        currentProjectDirectionAvailability: directionView.currentProjectDirectionAvailability,
      } : {}),
    },
    providerBoundary: {
      providerSessionIdentityRequired: false,
      providerSessionIdentityPersisted: false,
      providerTranscriptUsed: false,
      providerSummaryUsed: false,
      resumeEnabled: false,
      streamEnabled: false,
    },
    persisted: false,
    recoveryAuthority: false,
    instructionAuthority: false,
    promotionAuthority: false,
    objectiveRewrite: false,
  };
  return { status: "session_restored_from_artifacts", projection: projectionIdentity(payload), checkpoint };
}

function integrationDirectory(root, storage) {
  return path.join(root, formatForVerifiedOwner(storage).directory, "sessions", "integrations");
}

function integrationRequestFile(root, reviewDecisionId, storage) {
  return path.join(integrationDirectory(root, storage), "requests", `${reviewDecisionId}.json`);
}

function integrationFile(root, reviewDecisionId, storage) {
  if (typeof reviewDecisionId !== "string" || !/^review-decision-[a-f0-9]{24}$/.test(reviewDecisionId)) {
    fail("Run result integration ReviewDecision id is invalid.", "INVALID_RUN_RESULT_INTEGRATION_ID");
  }
  return path.join(integrationDirectory(root, storage), `${reviewDecisionId}.json`);
}

function integrationInput({ runId, reviewDecisionId, purpose, approvedDecisions, currentPosition, nextExpectedResult, openReviewIds }) {
  return {
    runId: requiredText(runId, "Reviewed Run id"),
    reviewDecisionId: requiredText(reviewDecisionId, "ReviewDecision id"),
    purpose: requiredText(purpose, "Integration checkpoint purpose"),
    approvedDecisions: stringList(approvedDecisions || [], "Approved decisions"),
    currentPosition: requiredText(currentPosition, "Integration current position"),
    nextExpectedResult: requiredText(nextExpectedResult, "Integration next expected result"),
    openReviewIds: stringList(openReviewIds || [], "Open review ids"),
  };
}

function verifyIntegrationRequest(root, request, expectedInput = null, expectedInputHash = null, storage) {
  if (request?.kind !== "RunResultIntegrationRequest" || !familyFormatForOriginal("head-agent-core-run-result-integration", request, storage)
    || request.protocol?.version !== HISTORICAL_INTEGRATION_VERSION) {
    fail("Run result integration request is invalid.", "INVALID_RUN_RESULT_INTEGRATION_REQUEST");
  }
  const expectedInputKeys = ["approvedDecisions", "currentPosition", "nextExpectedResult", "openReviewIds", "purpose", "reviewDecisionId", "runId"];
  if (!request.input || canonicalJson(Object.keys(request.input).sort()) !== canonicalJson(expectedInputKeys)
    || request.recoveryAuthority !== false || request.instructionAuthority !== false
    || request.promotionAuthority !== false || Number.isNaN(Date.parse(request.requestedAt))) {
    fail("Run result integration request schema is invalid.", "INVALID_RUN_RESULT_INTEGRATION_REQUEST");
  }
  verifyArtifactAuthorityBoundary("RunResultIntegrationRequest", request.authorityBoundary);
  const payload = { ...request };
  const recordedId = payload.integrationRequestId;
  const recordedHash = payload.integrationRequestHash;
  delete payload.integrationRequestId;
  delete payload.integrationRequestHash;
  const actualHash = digest(canonicalJson(payload));
  if (recordedHash !== actualHash || recordedId !== `run-result-integration-request-${actualHash.slice(0, 24)}`
    || request.integrationInputHash !== digest(canonicalJson(request.input))) {
    fail("Run result integration request digest verification failed.", "RUN_RESULT_INTEGRATION_REQUEST_DIGEST_MISMATCH");
  }
  if ((expectedInputHash && request.integrationInputHash !== expectedInputHash)
    || (expectedInput && canonicalJson(request.input) !== canonicalJson(expectedInput))) {
    fail("ReviewDecision already has a different create-only integration request.", "RUN_RESULT_INTEGRATION_CONFLICT");
  }
  const inspected = readyProject(root, "a Run result integration request is verified");
  if (request.projectId !== inspected.project.projectId || request.sessionId !== inspected.state.sessionId
    || request.reviewDecisionId !== request.input.reviewDecisionId || request.runId !== request.input.runId) {
    fail("Run result integration request belongs to another Project, Session, Run, or ReviewDecision.", "RUN_RESULT_INTEGRATION_REQUEST_CONFLICT");
  }
  return request;
}

function verifyIntegrationReceipt(root, receipt, expectedReviewDecisionId = null, storage) {
  if (receipt?.kind !== "RunResultIntegrationReceipt" || !familyFormatForOriginal("head-agent-core-run-result-integration", receipt, storage)
    || receipt.protocol?.version !== HISTORICAL_INTEGRATION_VERSION || receipt.reviewDecisionId !== (expectedReviewDecisionId || receipt.reviewDecisionId)) {
    fail("Run result integration receipt is invalid.", "INVALID_RUN_RESULT_INTEGRATION_RECEIPT");
  }
  verifyArtifactAuthorityBoundary("RunResultIntegrationReceipt", receipt.authorityBoundary);
  const payload = { ...receipt };
  const recordedId = payload.integrationReceiptId;
  const recordedHash = payload.integrationReceiptHash;
  delete payload.integrationReceiptId;
  delete payload.integrationReceiptHash;
  const actualHash = digest(canonicalJson(payload));
  if (recordedHash !== actualHash || recordedId !== `run-result-integration-${actualHash.slice(0, 24)}`) {
    fail("Run result integration receipt digest verification failed.", "RUN_RESULT_INTEGRATION_RECEIPT_DIGEST_MISMATCH");
  }
  const checkpoint = readRecoveryCheckpoint({ root, checkpointId: receipt.checkpointId }).checkpoint;
  const request = verifyIntegrationRequest(root, readJson(integrationRequestFile(root, receipt.reviewDecisionId, storage), "Run result integration request"), null, null, storage);
  const expectedInputHash = digest(canonicalJson({
    runId: receipt.runId,
    reviewDecisionId: receipt.reviewDecisionId,
    purpose: checkpoint.purpose,
    approvedDecisions: checkpoint.approvedDecisions,
    currentPosition: checkpoint.currentPosition,
    nextExpectedResult: checkpoint.nextExpectedResult,
    openReviewIds: checkpoint.openReviewIds,
  }));
  if (checkpoint.projectId !== receipt.projectId || checkpoint.sessionId !== receipt.sessionId
    || request.integrationRequestId !== receipt.integrationRequestId || request.integrationInputHash !== receipt.integrationInputHash
    || checkpoint.checkpointDigest !== receipt.checkpointDigest || receipt.integrationInputHash !== expectedInputHash
    || checkpoint.reviewedRunIntegration?.reviewDecisionId !== receipt.reviewDecisionId
    || checkpoint.reviewedRunIntegration?.runId !== receipt.runId
    || checkpoint.reviewedRunIntegration?.integrationRequestId !== receipt.integrationRequestId
    || checkpoint.reviewedRunIntegration?.integrationInputHash !== receipt.integrationInputHash) {
    fail("Run result integration receipt does not match its recovery checkpoint.", "RUN_RESULT_INTEGRATION_RECEIPT_CONFLICT");
  }
  return { receipt, checkpoint };
}

function pendingHistoricalIntegration(root, reviewDecisionId, storage) {
  const file = integrationRequestFile(root, reviewDecisionId, storage);
  if (!fs.existsSync(file)) return null;
  const request = verifyIntegrationRequest(root, readJson(file, "Historical integration request"), null, null, storage);
  if (request.reviewDecisionId !== reviewDecisionId) fail("Historical request does not match its original path.", "RUN_RESULT_INTEGRATION_REQUEST_CONFLICT");
  return {
    status: "legacy_integration_pending", file, request,
    historicalInput: request.input,
    originalRole: "historical-P3-reference-evidence-not-restored-P2-direction",
    ...readProjectDirectionView({ root }),
    nextAction: "HEAD may inspect the verified historical P3 input and current common direction, then independently derive current direction and manually transfer only still-applicable work. The request is not restored P2 direction and is never automatically adopted or completed.",
    recoveryAuthority: false, instructionAuthority: false, promotionAuthority: false,
    persisted: false, ordinaryWorkBlocked: false, userDecisionRequired: false, headActionRequired: true,
  };
}

export function readRunResultIntegration({ root = ".", reviewDecisionId } = {}) {
  const inspected = readyProject(root, "a Run result integration is read");
  const file = integrationFile(inspected.project.projectRoot, reviewDecisionId, inspected.storage);
  if (fs.existsSync(file)) return { status: "verified", file, ...verifyIntegrationReceipt(inspected.project.projectRoot, readJson(file, "Run result integration receipt"), reviewDecisionId, inspected.storage) };
  const ledger = path.join(inspected.project.projectRoot, formatForVerifiedOwner(inspected.storage).directory, "sessions", "ledger");
  const matches = [];
  for (const entry of fs.existsSync(ledger) ? fs.readdirSync(ledger, { withFileTypes: true }) : []) {
    if (!entry.isFile() || !/^checkpoint-[a-f0-9]{24}\.json$/.test(entry.name)) continue;
    const checkpointId = entry.name.slice(0, -5);
    // Unrelated Sessions share this ledger. Select the decision before applying
    // the strict current reader; a matching cross-Session/Project record fails.
    const candidate = readJson(path.join(ledger, entry.name), "Recovery checkpoint routing metadata");
    if (candidate.reviewedRunIntegration?.reviewDecisionId !== reviewDecisionId) continue;
    const checkpoint = readRecoveryCheckpoint({ root: inspected.project.projectRoot, checkpointId }).checkpoint;
    if (checkpoint.reviewedRunIntegration?.reviewDecisionId === reviewDecisionId && checkpoint.sessionId === inspected.state.sessionId) matches.push(checkpoint);
  }
  if (matches.length > 1) fail("ReviewDecision is linked to multiple recovery checkpoints.", "RUN_RESULT_INTEGRATION_MULTIPLE_CHECKPOINTS");
  if (!matches[0]) {
    const pending = pendingHistoricalIntegration(inspected.project.projectRoot, reviewDecisionId, inspected.storage);
    if (pending) return pending;
    fail(`Run result integration not found: ${reviewDecisionId}`, "RUN_RESULT_INTEGRATION_NOT_FOUND");
  }
  const checkpoint = matches[0];
  return { status: "verified", file: path.join(ledger, `${checkpoint.checkpointId}.json`), checkpoint, integration: verifyReviewedRunIntegration(inspected.project.projectRoot, checkpoint, inspected.storage) };
}

export function integrateReviewedRunCheckpoint({ root = ".", runId, reviewDecisionId, purpose, approvedDecisions = [], currentPosition, nextExpectedResult, openReviewIds = [] } = {}) {
  const inspected = readyProject(root, "a reviewed Run result is integrated");
  const input = integrationInput({ runId, reviewDecisionId, purpose, approvedDecisions, currentPosition, nextExpectedResult, openReviewIds });
  const integrationInputHash = digest(canonicalJson(input));
  const requestFile = integrationRequestFile(inspected.project.projectRoot, input.reviewDecisionId, inspected.storage);
  if (fs.existsSync(requestFile)) {
    verifyIntegrationRequest(inspected.project.projectRoot, readJson(requestFile, "Historical integration request"), input, integrationInputHash, inspected.storage);
    const original = readRunResultIntegration({ root: inspected.project.projectRoot, reviewDecisionId: input.reviewDecisionId });
    if (original.status === "legacy_integration_pending") {
      const error = new Error(`Historical integration remains pending at ${original.file}. ${original.nextAction}`);
      error.code = "RUN_RESULT_LEGACY_INTEGRATION_PENDING";
      error.pendingIntegration = original;
      throw error;
    }
  }
  const recorded = createRecoveryCheckpoint({
      root: inspected.project.projectRoot,
      purpose: input.purpose,
      approvedDecisions: input.approvedDecisions,
      currentPosition: input.currentPosition,
      nextExpectedResult: input.nextExpectedResult,
      openReviewIds: input.openReviewIds,
      reviewedRunIntegration: {
        runId: input.runId,
        reviewDecisionId: input.reviewDecisionId,
        integrationInputHash,
      },
    });
  return {
    status: recorded.status === "existing" ? "run_result_integration_existing" : "run_result_integrated_checkpointed",
    checkpoint: recorded.checkpoint,
    integration: recorded.checkpoint.reviewedRunIntegration,
    file: recorded.file,
  };
}
