import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sessionStatePath, assertRunSession, safeSessionPath } from "./session-routing.mjs";
import { readProjectDirection } from "./project-direction.mjs";
import { atomicWriteArtifact } from "./artifact-storage.mjs";
import { inspectProject, isProjectRecoveryReadable, SCHEMA_VERSION } from "./lode-core.mjs";
import { readContextCapsule } from "./context-compiler.mjs";
import { buildFreshLodeReview, readLineageArtifact } from "./execution-lineage.mjs";
import { artifactAuthorityBoundary, verifyArtifactAuthorityBoundary } from "./authority-plane-contract.mjs";
import { withProjectMutation } from "./project-mutation-lock.mjs";
import { operationPointerHash, sessionStateHash, inspectRunStorageTransition } from "./run-lineage.mjs";
import { normalizeSessionWorkEvidence, recordSessionWorkEvidence } from "./session-work-context.mjs";

import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";

export const COMPACTION_RECOVERY_VERSION = "0.3.0";
export const RECOVERY_CHECKPOINT_SYNC_VERSION = "0.1.0";

const OPEN_STATES = new Set(["preparing", "prepared", "provider_compacted", "verified"]);
const TERMINAL_STATES = new Set(["continued", "superseded", "aborted"]);
const UNCERTAIN_CONTINUATION_REASON = "continuation-consumed-outcome-uncertain";

const fail = (message, code = "COMPACTION_RECOVERY_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const now = () => new Date().toISOString();
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is required.`, "INVALID_COMPACTION_INPUT");
  return value.trim();
}

function stringList(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    fail(`${label} must be an array of non-empty strings.`, "INVALID_COMPACTION_INPUT");
  }
  return [...new Set(value.map((item) => item.trim()))].sort();
}

function turnId(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative safe integer.`, "INVALID_USER_TURN_ID");
  return value;
}

function readyProject(root, action, { readOnly = false } = {}) {
  const inspected = inspectProject(root);
  if (inspected.status === "not_initialized") fail("Lode Agent Core is not initialized.", "NOT_INITIALIZED");
  if (readOnly && isProjectRecoveryReadable(inspected)) return inspected;
  if (inspected.status === "drifted") fail(`Managed file drift must be resolved before ${action}.`, "MANAGED_DRIFT");
  if (inspected.status !== "ready") fail(`Project must be ready before ${action}; current status: ${inspected.status}.`, "PROJECT_NOT_READY");
  return inspected;
}

function atomicWrite(file, content) {
  atomicWriteArtifact(file, content);
}

function replaceJson(file, value) {
  atomicWriteArtifact(file, json(value));
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`${label} is invalid JSON: ${error.message}`, "INVALID_COMPACTION_CANON"); }
}

function checkpointDirectory(root, storage) {
  return path.join(root, formatForVerifiedOwner(storage).directory, "sessions", "ledger");
}

function checkpointFile(root, checkpointId, storage) {
  if (typeof checkpointId !== "string" || !/^checkpoint-[a-f0-9]{24}$/.test(checkpointId)) {
    fail("Recovery checkpoint id is invalid.", "INVALID_RECOVERY_CHECKPOINT_ID");
  }
  return safeSessionPath(root, formatForVerifiedOwner(storage).directory, "sessions", "ledger", `${checkpointId}.json`);
}

function compactionRoot(root, storage) {
  return safeSessionPath(root, path.relative(root, path.dirname(sessionStatePath(root, storage))), "compaction");
}

function epochFile(root, epochId, storage) {
  if (typeof epochId !== "string" || !/^compaction-epoch-[a-f0-9-]{36}$/.test(epochId)) {
    fail("Compaction epoch id is invalid.", "INVALID_COMPACTION_EPOCH_ID");
  }
  return path.join(compactionRoot(root, storage), "epochs", `${epochId}.json`);
}

function currentEpochFile(root, storage) {
  return path.join(compactionRoot(root, storage), "current.json");
}

function consumptionFile(root, epochId, storage) {
  return path.join(compactionRoot(root, storage), "consumptions", `${epochId}.json`);
}

function verifyContentIdentity(document, { idField, hashField, prefix, label }) {
  const payload = { ...document };
  const recordedId = payload[idField];
  const recordedHash = payload[hashField];
  delete payload[idField];
  delete payload[hashField];
  const actualHash = digest(canonicalJson(payload));
  if (recordedHash !== actualHash || recordedId !== `${prefix}-${actualHash.slice(0, 24)}`) {
    fail(`${label} digest verification failed.`, "COMPACTION_DIGEST_MISMATCH");
  }
  return document;
}

function readRunPointer(inspected) {
  const state = inspected.state;
  if (!state.activeRunId) return null;
  if (!state.activeExecutionContractId || !state.currentWholePlanId) {
    fail("Active Run state is missing its ExecutionContract or WholePlan pointer.", "COMPACTION_RUN_POINTER_REQUIRED");
  }
  const runFile = path.join(inspected.project.projectRoot, formatForVerifiedOwner(inspected.storage).directory, "sessions", "runs", state.activeRunId, "run.json");
  const run = readJson(runFile, "Active Run canon");
  assertRunSession(inspected.project.projectRoot, run, state);
  if (run.status !== "active" || run.runId !== state.activeRunId || run.wholePlanId !== state.currentWholePlanId
    || run.executionContractId !== state.activeExecutionContractId) {
    fail("Active Run state does not match Run canon.", "COMPACTION_RUN_POINTER_MISMATCH");
  }
  const contract = readLineageArtifact({ root: inspected.project.projectRoot, artifactId: run.executionContractId }).artifact;
  if (contract.kind !== "ExecutionContract" || contract.wholePlanId !== run.wholePlanId || contract.capsuleId !== run.capsuleId) {
    fail("Active Run does not match its verified ExecutionContract.", "COMPACTION_RUN_LINEAGE_MISMATCH");
  }
  const plan = readLineageArtifact({ root: inspected.project.projectRoot, artifactId: run.wholePlanId }).artifact;
  if (plan.kind !== "WholePlanSnapshot") fail("Active Run WholePlan pointer is invalid.", "COMPACTION_RUN_LINEAGE_MISMATCH");
  const capsule = readContextCapsule({ root: inspected.project.projectRoot, capsuleId: run.capsuleId }).capsule;
  return {
    runId: run.runId,
    wholePlanId: run.wholePlanId,
    executionContractId: run.executionContractId,
    contextCapsuleDigest: capsule.capsuleHash,
    currentResultPacketId: state.lastResultPacketId || null,
  };
}

function readSessionPointer(inspected) {
  const state = inspected.state;
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

function transitionRunId(state) {
  return state.activeRunId || state.pendingReview?.runId || state.lastReviewedRunId || null;
}

function readTransitionRun(inspected) {
  const runId = transitionRunId(inspected.state);
  if (!runId) return null;
  if (!/^run-[0-9]+-[a-f0-9]{6}$/.test(runId)) fail("Current Run transition id is invalid.", "INVALID_RUN_CANON");
  const file = path.join(inspected.project.projectRoot, formatForVerifiedOwner(inspected.storage).directory, "sessions", "runs", runId, "run.json");
  if (!fs.existsSync(file)) fail(`Current Run canon not found: ${runId}`, "INVALID_RUN_CANON");
  const run = readJson(file, "Current Run canon");
  assertRunSession(inspected.project.projectRoot, run, inspected.state);
  if (run.runId !== runId || !run.wholePlanId || !run.executionContractId || !run.capsuleId) {
    fail("Current Run canon is incomplete or belongs to another Run.", "INVALID_RUN_CANON");
  }
  const contract = readLineageArtifact({ root: inspected.project.projectRoot, artifactId: run.executionContractId }).artifact;
  const plan = readLineageArtifact({ root: inspected.project.projectRoot, artifactId: run.wholePlanId }).artifact;
  const capsule = readContextCapsule({ root: inspected.project.projectRoot, capsuleId: run.capsuleId }).capsule;
  if (contract.kind !== "ExecutionContract" || plan.kind !== "WholePlanSnapshot"
    || contract.executionContractId !== run.executionContractId || contract.wholePlanId !== run.wholePlanId
    || contract.capsuleId !== run.capsuleId) {
    fail("Current Run transition lineage is inconsistent.", "RUN_LINEAGE_CONFLICT");
  }
  return {
    file,
    run,
    lineage: {
      runId,
      runStatus: run.status,
      wholePlanId: run.wholePlanId,
      executionContractId: run.executionContractId,
      capsuleId: run.capsuleId,
      contextCapsuleDigest: capsule.capsuleHash,
      resultPacketId: run.resultPacketId || null,
      reviewDecisionId: run.reviewDecisionId || null,
    },
  };
}

function inspectRunTransitionState(inspected) {
  const loaded = readTransitionRun(inspected);
  if (!loaded) return { status: "none", lineage: null, transition: null };
  const { run, lineage } = loaded;
  const transition = run.sessionTransition;
  if (!transition) return { status: "stable", lineage, transition: null };
  if (transition.kind === "start") {
    const inspectedTransition = inspectRunStorageTransition({ inspected });
    return { ...inspectedTransition, lineage };
  }
  if (transition.before && transition.patch) {
    if (!new Set(["finish", "review"]).has(transition.kind)
      || transition.projectId !== inspected.project.projectId || transition.sessionId !== inspected.state.sessionId
      || transition.runId !== run.runId || typeof transition.changedAt !== "string" || !Number.isFinite(Date.parse(transition.changedAt))) {
      fail("Current Run Session change is invalid.", "INVALID_RUN_CANON");
    }
    const equal = (left, right) => canonicalJson(left ?? null) === canonicalJson(right ?? null);
    const committed = Object.entries(transition.patch).every(([key, value]) => equal(inspected.state[key], value));
    const unchanged = Object.entries(transition.before).every(([key, value]) => equal(inspected.state[key], value));
    const terminal = transition.kind === "finish" ? "awaiting_review" : "reviewed";
    const id = transition.kind === "finish" ? run.resultPacketId : run.reviewDecisionId;
    if (run.status !== terminal || id !== transition.artifactId) fail("Run does not match its final Session change.", "RUN_TRANSITION_CONFLICT");
    let artifactStatus = "verified";
    try {
      const artifact = readLineageArtifact({ root: inspected.project.projectRoot, artifactId: id }).artifact;
      if (artifact.kind !== (transition.kind === "finish" ? "ResultPacket" : "ReviewDecision")) fail("Run Session change has a different artifact kind.", "RUN_TRANSITION_CONFLICT");
    } catch (error) {
      if (error.code !== "LINEAGE_ARTIFACT_NOT_FOUND" || committed && transition.kind === "review") throw error;
      artifactStatus = committed ? "missing-evidence" : "missing-before-publication";
    }
    return { status: committed ? "committed" : unchanged ? "incomplete" : "conflict", lineage,
      transition: { kind: transition.kind, artifactId: id, artifactStatus, changedAt: transition.changedAt, transitionHash: digest(canonicalJson(transition)) } };
  }
  if (!new Set(["finish", "review"]).has(transition.kind)
    || transition.projectId !== inspected.project.projectId || transition.sessionId !== inspected.state.sessionId
    || transition.runId !== run.runId || typeof transition.artifactId !== "string"
    || typeof transition.changedAt !== "string" || !Number.isFinite(Date.parse(transition.changedAt))
    || !/^[a-f0-9]{64}$/.test(transition.beforeSessionHash || "")
    || !/^[a-f0-9]{64}$/.test(transition.afterSessionHash || "")
    || !/^[a-f0-9]{64}$/.test(transition.afterOperationPointerHash || "")) {
    fail("Current Run transition record is invalid.", "INVALID_RUN_CANON");
  }
  const expectedArtifactKind = transition.kind === "finish" ? "ResultPacket" : "ReviewDecision";
  const terminalStatus = transition.kind === "finish" ? "awaiting_review" : "reviewed";
  let artifactStatus = "missing-before-publication";
  try {
    const artifact = readLineageArtifact({ root: inspected.project.projectRoot, artifactId: transition.artifactId }).artifact;
    if (artifact.kind !== expectedArtifactKind) fail("Run transition artifact kind is invalid.", "RUN_TRANSITION_CONFLICT");
    artifactStatus = "verified";
  } catch (error) {
    if (error.code !== "LINEAGE_ARTIFACT_NOT_FOUND") throw error;
    if (run.status === terminalStatus && expectedArtifactKind !== "ResultPacket") throw error;
    if (run.status === terminalStatus) artifactStatus = "missing-evidence";
  }
  const currentSessionHash = sessionStateHash(inspected.state);
  const currentOperationPointerHash = operationPointerHash(inspected.state);
  const committed = transition.kind === "finish"
    ? run.status === terminalStatus
      && inspected.state.pendingReview?.runId === run.runId
      && inspected.state.pendingReview?.resultPacketId === transition.artifactId
      && inspected.state.lastResultPacketId === transition.artifactId
    : run.status === terminalStatus
      && inspected.state.pendingReview == null
      && inspected.state.lastReviewedRunId === run.runId
      && inspected.state.lastReviewDecisionId === transition.artifactId;
  let status;
  if (committed) status = currentOperationPointerHash === transition.afterOperationPointerHash ? "committed" : "committed-later-state";
  else if (currentSessionHash === transition.beforeSessionHash) status = "incomplete";
  else status = "conflict";
  return {
    status,
    lineage,
    transition: {
      kind: transition.kind,
      artifactId: transition.artifactId,
      changedAt: transition.changedAt,
      transitionHash: digest(canonicalJson(transition)),
      artifactStatus,
      currentSessionHash,
      currentOperationPointerHash,
      beforeSessionHash: transition.beforeSessionHash,
      afterSessionHash: transition.afterSessionHash,
      afterOperationPointerHash: transition.afterOperationPointerHash,
    },
  };
}

function inspectCompactionStateForSync(inspected) {
  const epoch = currentEpoch(inspected.project.projectRoot, inspected.storage);
  if (!epoch) return { status: "idle", epoch: null };
  if (epoch.projectId !== inspected.project.projectId || epoch.sessionId !== inspected.state.sessionId
    || !new Set([...OPEN_STATES, ...TERMINAL_STATES]).has(epoch.state)
    || typeof epoch.checkpointId !== "string" || !/^checkpoint-[a-f0-9]{24}$/.test(epoch.checkpointId)
    || typeof epoch.checkpointDigest !== "string" || !/^[a-f0-9]{64}$/.test(epoch.checkpointDigest)) {
    fail("Current compaction epoch is invalid for this Project and Session.", "INVALID_COMPACTION_EPOCH");
  }
  const consumption = continuationConsumption(inspected.project.projectRoot, epoch, inspected.storage);
  if (consumption.status === "invalid") fail("Current compaction continuation consumption is invalid.", "INVALID_COMPACTION_CONSUMPTION");
  if (epoch.state !== "preparing") {
    const checkpoint = readRecoveryCheckpoint({ root: inspected.project.projectRoot, checkpointId: epoch.checkpointId }).checkpoint;
    if (checkpoint.checkpointDigest !== epoch.checkpointDigest) fail("Current compaction epoch checkpoint digest is invalid.", "COMPACTION_DIGEST_MISMATCH");
  }
  return {
    status: OPEN_STATES.has(epoch.state) ? "open" : "terminal",
    epoch: {
      epochId: epoch.epochId,
      state: epoch.state,
      checkpointId: epoch.checkpointId,
      checkpointDigest: epoch.checkpointDigest,
      continuationConsumption: consumption.status,
      updatedAt: epoch.updatedAt || null,
    },
  };
}

function recoveryCheckpointBasisFromInspection(inspected) {
  const latestCheckpoint = inspected.state.latestCheckpoint
    ? readRecoveryCheckpoint({ root: inspected.project.projectRoot, checkpointId: inspected.state.latestCheckpoint }).checkpoint
    : null;
  const runTransition = inspectRunTransitionState(inspected);
  const compaction = inspectCompactionStateForSync(inspected);
  const payload = {
    kind: "RecoveryCheckpointSyncBasis",
    protocol: { name: formatForVerifiedOwner(inspected.storage).protocol("head-agent-core-recovery-checkpoint-sync"), version: RECOVERY_CHECKPOINT_SYNC_VERSION },
    persisted: false,
    projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId,
    latestCheckpointId: latestCheckpoint?.checkpointId || null,
    currentProjectDirectionId: readProjectDirection({ root: inspected.project.projectRoot })?.directionId || null,
    latestCheckpointDigest: latestCheckpoint?.checkpointDigest || null,
    sessionRecordHash: sessionStateHash(inspected.state),
    sessionUpdatedAt: inspected.state.updatedAt,
    references: {
      currentWholePlanId: inspected.state.currentWholePlanId || null,
      activeRunId: inspected.state.activeRunId || null,
      activeExecutionContractId: inspected.state.activeExecutionContractId || null,
      lastResultPacketId: inspected.state.lastResultPacketId || null,
      pendingReview: inspected.state.pendingReview == null ? null : canonical(inspected.state.pendingReview),
      lastReviewDecisionId: inspected.state.lastReviewDecisionId || null,
      lastReviewedRunId: inspected.state.lastReviewedRunId || null,
      requiredPlanAction: inspected.state.requiredPlanAction == null ? null : canonical(inspected.state.requiredPlanAction),
      runLineage: runTransition.lineage,
    },
    runTransition: { status: runTransition.status, transition: runTransition.transition },
    compaction,
    directionAuthorship: {
      owner: formatForVerifiedOwner(inspected.storage).value("current-provider-head"),
      deriveAfterBasisRead: true,
      replacingOnlyTheBasisIdOnAnOlderDirectionIsValid: false,
      coreVerification: "exact-identity-lineage-and-concurrency-only",
    },
    authority: {
      plane: "P4-non-persisted-comparison",
      recovery: false,
      instruction: false,
      review: false,
      promotion: false,
      canonMutation: false,
    },
  };
  const basisHash = digest(canonicalJson(payload));
  return { ...payload, basisId: `recovery-basis-${basisHash.slice(0, 24)}`, basisHash };
}

export function inspectRecoveryCheckpointBasis({ root = "." } = {}) {
  const inspected = readyProject(root, "recovery checkpoint freshness is inspected", { readOnly: true });
  const basis = recoveryCheckpointBasisFromInspection(inspected);
  return {
    status: "recovery_checkpoint_basis_inspected",
    basis,
    syncAvailability: inspected.status !== "ready" ? "unavailable-managed-projection-drift"
      : basis.runTransition.status === "incomplete" ? "deferred-run-transition"
      : basis.runTransition.status === "conflict" ? "conflict-run-transition"
        : basis.compaction.status === "open" ? "deferred-compaction" : "ready",
    persisted: false,
    authorityChanged: false,
    ordinaryWorkBlocked: false,
    userDecisionRequired: false,
  };
}

function verifiedReviewedRunIntegration(inspected, input, checkpointInput) {
  if (input == null) return null;
  const keys = Object.keys(input).sort();
  if (canonicalJson(keys) !== canonicalJson(["integrationInputHash", "reviewDecisionId", "runId"])) {
    fail("Reviewed Run integration requires the exact decision and caller direction.", "INVALID_RUN_RESULT_INTEGRATION");
  }
  const runId = requiredText(input.runId, "Reviewed Run id");
  const reviewDecisionId = requiredText(input.reviewDecisionId, "Reviewed Run ReviewDecision id");
  const integrationInputHash = requiredText(input.integrationInputHash, "Run result integration input hash");
  if (!/^run-[0-9]+-[a-f0-9]{6}$/.test(runId) || !/^review-decision-[a-f0-9]{24}$/.test(reviewDecisionId)
    || !/^[a-f0-9]{64}$/.test(integrationInputHash)) {
    fail("Reviewed Run integration identities are invalid.", "INVALID_RUN_RESULT_INTEGRATION");
  }
  if (integrationInputHash !== digest(canonicalJson(checkpointInput))) fail("Integration direction differs from the exact caller input.", "RUN_RESULT_INTEGRATION_CONFLICT");
  if (inspected.state.activeRunId || inspected.state.pendingReview || inspected.state.lastReviewDecisionId !== reviewDecisionId) {
    fail("Reviewed Run integration requires the current completed review state.", "RUN_RESULT_INTEGRATION_STATE_CONFLICT");
  }
  const file = path.join(inspected.project.projectRoot, formatForVerifiedOwner(inspected.storage).directory, "sessions", "runs", runId, "run.json");
  if (!fs.existsSync(file)) fail(`Reviewed Run canon not found: ${runId}`, "RUN_RESULT_INTEGRATION_RUN_NOT_FOUND");
  const run = readJson(file, "Reviewed Run canon");
  assertRunSession(inspected.project.projectRoot, run, inspected.state);
  if (run.runId !== runId || run.status !== "reviewed" || run.reviewDecisionId !== reviewDecisionId || !run.resultPacketId) {
    fail("Reviewed Run canon does not match the integration request.", "RUN_RESULT_INTEGRATION_RUN_CONFLICT");
  }
  const review = readLineageArtifact({ root: inspected.project.projectRoot, artifactId: reviewDecisionId }).artifact;
  const result = readLineageArtifact({ root: inspected.project.projectRoot, artifactId: run.resultPacketId }).artifact;
  if (review.kind !== "ReviewDecision" || result.kind !== "ResultPacket" || review.disposition !== "accept"
    || review.resultPacketId !== result.resultPacketId || review.resultPacketId !== run.resultPacketId
    || review.wholePlanId !== run.wholePlanId) {
    fail("Only an accepted ResultPacket with exact Fresh HEAD review lineage may be integrated.", "RUN_RESULT_NOT_ACCEPTED");
  }
  const contract = readLineageArtifact({ root: inspected.project.projectRoot, artifactId: result.executionContractId }).artifact;
  const plan = readLineageArtifact({ root: inspected.project.projectRoot, artifactId: review.wholePlanId }).artifact;
  const capsule = readContextCapsule({ root: inspected.project.projectRoot, capsuleId: contract.capsuleId }).capsule;
  const freshReview = buildFreshLodeReview({
    root: inspected.project.projectRoot,
    wholePlanId: run.wholePlanId,
    resultPacketId: run.resultPacketId,
    sessionId: inspected.state.sessionId,
    runId,
  }).review;
  if (contract.kind !== "ExecutionContract" || plan.kind !== "WholePlanSnapshot"
    || contract.executionContractId !== run.executionContractId || contract.wholePlanId !== plan.wholePlanId
    || run.capsuleId !== contract.capsuleId || review.reviewContextId !== freshReview.reviewContextId) {
    fail("Reviewed Run integration lineage is inconsistent.", "RUN_RESULT_INTEGRATION_LINEAGE_CONFLICT");
  }
  return {
    runId,
    wholePlanId: plan.wholePlanId,
    executionContractId: contract.executionContractId,
    contextCapsuleDigest: capsule.capsuleHash,
    resultPacketId: result.resultPacketId,
    reviewDecisionId: review.reviewDecisionId,
    reviewContextId: review.reviewContextId,
    previousCheckpointId: inspected.state.latestCheckpoint || null,
    integrationInputHash,
    disposition: review.disposition,
    reviewedAt: requiredText(run.reviewedAt, "Reviewed Run timestamp"),
  };
}

function normalizeCheckpointDirection(inspected, { purpose, approvedDecisions = [], currentPosition, nextExpectedResult, openReviewIds = [] }) {
  const pendingReviewIds = inspected.state.pendingReview?.resultPacketId ? [inspected.state.pendingReview.resultPacketId] : [];
  return {
    purpose: requiredText(purpose, "Checkpoint purpose"),
    approvedDecisions: stringList(approvedDecisions, "Approved decisions"),
    currentPosition: requiredText(currentPosition, "Current position"),
    nextExpectedResult: requiredText(nextExpectedResult, "Next expected result"),
    openReviewIds: [...new Set([...stringList(openReviewIds || [], "Open review ids"), ...pendingReviewIds])].sort(),
  };
}

function recoveryCheckpointPayload({ inspected, purpose, approvedDecisions, currentPosition, nextExpectedResult, openReviewIds, reviewedRunIntegration, createdAt = null }) {
  const direction = normalizeCheckpointDirection(inspected, { purpose, approvedDecisions, currentPosition, nextExpectedResult, openReviewIds });
  const normalizedCheckpointInput = {
    runId: reviewedRunIntegration?.runId || null,
    reviewDecisionId: reviewedRunIntegration?.reviewDecisionId || null,
    ...direction,
  };
  const verifiedIntegration = verifiedReviewedRunIntegration(inspected, reviewedRunIntegration, normalizedCheckpointInput);
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "SessionRunCheckpoint",
    protocol: { name: formatForVerifiedOwner(inspected.storage).protocol("head-agent-core-session-run-recovery"), version: COMPACTION_RECOVERY_VERSION },
    projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId,
    authorityBoundary: artifactAuthorityBoundary("SessionRunCheckpoint"),
    purpose: normalizedCheckpointInput.purpose,
    approvedDecisions: normalizedCheckpointInput.approvedDecisions,
    currentPosition: normalizedCheckpointInput.currentPosition,
    nextExpectedResult: normalizedCheckpointInput.nextExpectedResult,
    sessionPointer: readSessionPointer(inspected),
    runPointer: readRunPointer(inspected),
    reviewedRunIntegration: verifiedIntegration,
    openReviewIds: normalizedCheckpointInput.openReviewIds,
    createdAt: verifiedIntegration?.reviewedAt || createdAt || now(),
    authority: {
      recovery: "canonical-session-run-checkpoint",
      recoveryFieldSources: formatForVerifiedOwner(inspected.storage).value("explicit-head-user-direction-and-verified-p2-lineage-only"),
      evidenceRecords: "reference-only-not-recovery-field-source",
      providerSummary: "orientation-only",
      continuitySnapshot: "derived-view-not-recovery-input",
    },
  };
}

export function createRecoveryCheckpoint(options = {}) {
  return withRecoveryMutation(options, () => createRecoveryCheckpointLocked(options));
}

function createRecoveryCheckpointLocked({ root = ".", purpose, approvedDecisions = [], currentPosition, nextExpectedResult, openReviewIds = [], reviewedRunIntegration = null } = {}) {
  const inspected = readyProject(root, "a recovery checkpoint is created");
  if (reviewedRunIntegration) {
    const keys = Object.keys(reviewedRunIntegration).sort();
    const expectedKeys = ["integrationInputHash", "reviewDecisionId", "runId"];
    if (canonicalJson(keys) !== canonicalJson(expectedKeys) || !/^[a-f0-9]{64}$/.test(reviewedRunIntegration.integrationInputHash || "")) fail("Reviewed integration requires the exact decision and input identity.", "INVALID_RUN_RESULT_INTEGRATION");
    const direction = normalizeCheckpointDirection(inspected, { purpose, approvedDecisions, currentPosition, nextExpectedResult, openReviewIds });
    const inputHash = digest(canonicalJson({ runId: reviewedRunIntegration.runId, reviewDecisionId: reviewedRunIntegration.reviewDecisionId, ...direction }));
    const directory = checkpointDirectory(inspected.project.projectRoot, inspected.storage);
    const matches = (fs.existsSync(directory) ? fs.readdirSync(directory) : [])
      .filter((name) => /^checkpoint-[a-f0-9]{24}\.json$/.test(name))
      // Routing metadata only selects the exact decision; it grants no trust.
      // Matching records still require current Project/Session/digest validation.
      .filter((name) => readJson(path.join(directory, name), "Recovery checkpoint routing metadata").reviewedRunIntegration?.reviewDecisionId === reviewedRunIntegration.reviewDecisionId)
      .map((name) => readRecoveryCheckpoint({ root: inspected.project.projectRoot, checkpointId: name.slice(0, -5) }).checkpoint)
      .filter((record) => record.reviewedRunIntegration?.reviewDecisionId === reviewedRunIntegration.reviewDecisionId);
    if (matches.length > 1) fail("One ReviewDecision has multiple integration checkpoints.", "RUN_RESULT_INTEGRATION_MULTIPLE_CHECKPOINTS");
    if (matches[0]) {
      const checkpoint = matches[0];
      if (checkpoint.sessionId !== inspected.state.sessionId || checkpoint.reviewedRunIntegration.runId !== reviewedRunIntegration.runId
        || checkpoint.reviewedRunIntegration.integrationInputHash !== inputHash || inputHash !== reviewedRunIntegration.integrationInputHash) {
        fail("ReviewDecision already has a different recovery direction.", "RUN_RESULT_INTEGRATION_CONFLICT");
      }
      const previousCheckpointId = Object.hasOwn(checkpoint.reviewedRunIntegration, "previousCheckpointId")
        ? checkpoint.reviewedRunIntegration.previousCheckpointId : checkpoint.reviewedRunIntegration.integrationRequestId ? null : undefined;
      if (inspected.state.latestCheckpoint !== checkpoint.checkpointId
        && inspected.state.latestCheckpoint === previousCheckpointId) {
        if (canonicalJson(readSessionPointer(inspected)) !== canonicalJson(checkpoint.sessionPointer)) fail("Interrupted integration cannot overwrite changed Session work.", "RUN_RESULT_INTEGRATION_STATE_CONFLICT");
        return persistRecoveryCheckpoint(inspected, checkpoint);
      }
      return { status: "existing", file: checkpointFile(inspected.project.projectRoot, checkpoint.checkpointId, inspected.storage), checkpoint, state: inspected.state };
    }
    // A historical request records a pending operation, not permission to
    // manufacture a replacement checkpoint. The Session recovery reader owns
    // original verification and the bounded manual HEAD transfer diagnostic.
    const requestFile = path.join(inspected.project.projectRoot, formatForVerifiedOwner(inspected.storage).directory, "sessions", "integrations", "requests", `${reviewedRunIntegration.reviewDecisionId}.json`);
    if (fs.existsSync(requestFile)) {
      fail(`Historical integration remains pending at ${requestFile}; read the original with readRunResultIntegration and transfer its verified direction through HEAD.`, "RUN_RESULT_LEGACY_INTEGRATION_PENDING");
    }
  }
  const payload = recoveryCheckpointPayload({ inspected, purpose, approvedDecisions, currentPosition, nextExpectedResult, openReviewIds, reviewedRunIntegration });
  const checkpointDigest = digest(canonicalJson(payload));
  const checkpointId = `checkpoint-${checkpointDigest.slice(0, 24)}`;
  const checkpoint = { ...payload, checkpointId, checkpointDigest };
  return persistRecoveryCheckpoint(inspected, checkpoint);
}

function persistRecoveryCheckpoint(inspected, checkpoint) {
  const { checkpointId } = checkpoint;
  const file = checkpointFile(inspected.project.projectRoot, checkpointId, inspected.storage);
  let existed = fs.existsSync(file);
  if (!existed) {
    try {
      atomicWrite(file, json(checkpoint));
    } catch (error) {
      // Two identical integrations may derive the same immutable checkpoint
      // before either process observes the file. The losing create converges
      // only when the exact content-addressed target now exists and verifies.
      if (!fs.existsSync(file)) throw error;
      existed = true;
    }
  }
  if (existed) readRecoveryCheckpoint({ root: inspected.project.projectRoot, checkpointId });
  const state = { ...inspected.state, latestCheckpoint: checkpointId, updatedAt: now() };
  replaceJson(sessionStatePath(inspected.project.projectRoot, inspected.storage), state);
  return { status: existed ? "existing" : "checkpointed", file, checkpoint, state };
}

function currentCheckpointForSync(inspected) {
  if (!inspected.state.latestCheckpoint) return null;
  return readRecoveryCheckpoint({ root: inspected.project.projectRoot, checkpointId: inspected.state.latestCheckpoint }).checkpoint;
}

function checkpointMatchesSyncRequest(checkpoint, inspected, direction) {
  if (!checkpoint || checkpoint.protocol?.version !== COMPACTION_RECOVERY_VERSION
    || checkpoint.projectId !== inspected.project.projectId || checkpoint.sessionId !== inspected.state.sessionId) return false;
  const comparableCheckpoint = {
    purpose: checkpoint.purpose,
    approvedDecisions: checkpoint.approvedDecisions,
    currentPosition: checkpoint.currentPosition,
    nextExpectedResult: checkpoint.nextExpectedResult,
    openReviewIds: checkpoint.openReviewIds,
    sessionPointer: checkpoint.sessionPointer,
    runPointer: checkpoint.runPointer,
  };
  const expected = {
    ...direction,
    sessionPointer: readSessionPointer(inspected),
    runPointer: readRunPointer(inspected),
  };
  return canonicalJson(comparableCheckpoint) === canonicalJson(expected);
}

function checkpointSyncOutcome(outcome, { expectedBasisId, basis, resultingBasis = null, checkpoint = null, persisted = null, reasonCode = null }) {
  const writes = persisted
    ? {
        checkpointLedger: persisted.status === "checkpointed" ? 1 : 0,
        sessionPointer: 1,
      }
    : { checkpointLedger: 0, sessionPointer: 0 };
  return {
    status: `recovery_checkpoint_sync_${outcome}`,
    outcome,
    expectedBasisId,
    observedBasisId: basis.basisId,
    basis,
    resultingBasis,
    checkpoint,
    reasonCode,
    writes,
    persisted: outcome === "created",
    authorityChanged: outcome === "created",
    headActionRequired: new Set(["deferred", "conflict"]).has(outcome),
    userDecisionRequired: false,
    ordinaryWorkBlocked: false,
    retryGuidance: outcome === "deferred"
      ? "Recover or close the exact existing transition, inspect a fresh basis, and let HEAD re-derive direction before retrying."
      : outcome === "conflict"
        ? "Inspect a fresh basis and let HEAD re-derive direction; do not attach a new basis to an old direction."
        : null,
  };
}

export function syncRecoveryCheckpoint(options = {}) {
  const allowed = new Set([
    "root", "expectedRecoveryBasisId", "purpose", "approvedDecisions", "currentPosition", "nextExpectedResult", "openReviewIds", "workEvidence",
  ]);
  const unexpected = Object.keys(options).filter((key) => !allowed.has(key));
  if (unexpected.length) fail(`Recovery checkpoint sync contains unsupported fields: ${unexpected.sort().join(", ")}`, "INVALID_RECOVERY_CHECKPOINT_SYNC_INPUT");
  const expectedBasisId = requiredText(options.expectedRecoveryBasisId, "Expected recovery basis id");
  if (!/^recovery-basis-[a-f0-9]{24}$/.test(expectedBasisId)) fail("Expected recovery basis id is invalid.", "INVALID_RECOVERY_CHECKPOINT_BASIS_ID");
  if (options.workEvidence !== undefined) normalizeSessionWorkEvidence(options.workEvidence);
  return withProjectMutation({ root: options.root, scope: "session-recovery" }, () => {
    const inspected = readyProject(options.root, "recovery checkpoint direction is synchronized");
    const direction = normalizeCheckpointDirection(inspected, options);
    // P3 retention and P2 publication are separate outcomes, even in one call.
    // Evidence never fills a direction field, and storage trouble cannot turn
    // a valid direction update into a new ordinary-work gate.
    let workEvidence;
    if (options.workEvidence !== undefined) {
      try {
        const retained = recordSessionWorkEvidence({ root: options.root, input: options.workEvidence });
        workEvidence = { status: retained.status, evidenceId: retained.evidence.evidenceId, file: retained.file, writes: retained.writes,
          authorityPlane: "P3", recoveryAuthority: false, executionReplayAllowed: false };
      } catch (error) {
        workEvidence = { status: "work_evidence_retention_unconfirmed", reasonCode: error.code || "SESSION_WORK_EVIDENCE_STORAGE_ERROR",
          authorityPlane: "P3", recoveryAuthority: false, executionReplayAllowed: false,
          nextHeadAction: "Inspect or retry only this selected evidence save; do not repeat completed effects." };
      }
    }
    const finish = (outcome) => workEvidence === undefined ? outcome : { ...outcome, workEvidence };
    const basis = recoveryCheckpointBasisFromInspection(inspected);
    if (basis.runTransition.status === "incomplete") {
      return finish(checkpointSyncOutcome("deferred", {
        expectedBasisId, basis, reasonCode: "RUN_TRANSITION_INCOMPLETE",
      }));
    }
    if (basis.runTransition.status === "conflict") {
      return finish(checkpointSyncOutcome("conflict", {
        expectedBasisId, basis, reasonCode: "RUN_TRANSITION_SESSION_DRIFT",
      }));
    }
    const currentCheckpoint = currentCheckpointForSync(inspected);
    const exactReuse = checkpointMatchesSyncRequest(currentCheckpoint, inspected, direction);
    if (exactReuse) {
      return finish(checkpointSyncOutcome("reused", { expectedBasisId, basis, checkpoint: currentCheckpoint }));
    }
    if (basis.compaction.status === "open") {
      return finish(checkpointSyncOutcome("deferred", {
        expectedBasisId, basis, reasonCode: "COMPACTION_EPOCH_OPEN",
      }));
    }
    if (expectedBasisId !== basis.basisId) {
      return finish(checkpointSyncOutcome("conflict", {
        expectedBasisId, basis, reasonCode: "RECOVERY_CHECKPOINT_SYNC_STALE_BASIS",
      }));
    }
    const deterministicCreatedAt = typeof inspected.state.updatedAt === "string" && Number.isFinite(Date.parse(inspected.state.updatedAt))
      ? inspected.state.updatedAt : inspected.project.createdAt;
    const payload = recoveryCheckpointPayload({
      inspected,
      ...direction,
      reviewedRunIntegration: null,
      createdAt: deterministicCreatedAt,
    });
    const checkpointDigest = digest(canonicalJson(payload));
    const checkpoint = { ...payload, checkpointId: `checkpoint-${checkpointDigest.slice(0, 24)}`, checkpointDigest };
    const persisted = persistRecoveryCheckpoint(inspected, checkpoint);
    const resultingInspection = readyProject(inspected.project.projectRoot, "recovery checkpoint synchronization result is read");
    return finish(checkpointSyncOutcome("created", {
      expectedBasisId,
      basis,
      resultingBasis: recoveryCheckpointBasisFromInspection(resultingInspection),
      checkpoint,
      persisted,
    }));
  });
}

export function readRecoveryCheckpoint({ root = ".", checkpointId, historical = false, storage } = {}) {
  const inspected = historical ? { storage, project: readJson(safeSessionPath(root, formatForVerifiedOwner(storage).directory, "project.json"), "Project canon") }
    : readyProject(root, "a recovery checkpoint is read", { readOnly: true });
  if (inspected.project.projectRoot !== fs.realpathSync(path.resolve(root))) fail("Project root identity differs.", "PROJECT_IDENTITY_MISMATCH");
  const file = checkpointFile(inspected.project.projectRoot, checkpointId, inspected.storage);
  if (!fs.existsSync(file)) fail(`Recovery checkpoint not found: ${checkpointId}`, "RECOVERY_CHECKPOINT_NOT_FOUND");
  const checkpoint = readJson(file, "Recovery checkpoint");
  if (checkpoint.kind !== "SessionRunCheckpoint" || checkpoint.projectId !== inspected.project.projectId
    || !historical && checkpoint.sessionId !== inspected.state.sessionId || !checkpoint.purpose || !Array.isArray(checkpoint.approvedDecisions)
    || !checkpoint.currentPosition || !checkpoint.nextExpectedResult) {
    fail("Recovery checkpoint is incomplete or belongs to another Project/Session.", "INVALID_RECOVERY_CHECKPOINT");
  }
  const checkpointVersion = checkpoint.protocol?.version;
  if (!familyFormatForOriginal("head-agent-core-session-run-recovery", checkpoint, inspected.storage) || !new Set(["0.1.0", "0.2.0", COMPACTION_RECOVERY_VERSION]).has(checkpointVersion)) {
    fail("Recovery checkpoint protocol is invalid.", "INVALID_RECOVERY_CHECKPOINT");
  }
  if (new Set(["0.2.0", COMPACTION_RECOVERY_VERSION]).has(checkpointVersion)) {
    verifyArtifactAuthorityBoundary("SessionRunCheckpoint", checkpoint.authorityBoundary);
  }
  if (checkpointVersion === COMPACTION_RECOVERY_VERSION && (!checkpoint.sessionPointer || typeof checkpoint.sessionPointer !== "object"
    || !("reviewedRunIntegration" in checkpoint))) {
    fail("Current recovery checkpoint is missing its immutable Session pointer.", "INVALID_RECOVERY_CHECKPOINT");
  }
  verifyContentIdentity(checkpoint, { idField: "checkpointId", hashField: "checkpointDigest", prefix: "checkpoint", label: "Recovery checkpoint" });
  return { status: "verified", file, checkpoint };
}

function readEpoch(root, epochId, storage) {
  const file = epochFile(root, epochId, storage);
  if (!fs.existsSync(file)) fail(`Compaction epoch not found: ${epochId}`, "COMPACTION_EPOCH_NOT_FOUND");
  const epoch = readJson(file, "Compaction epoch");
  if (epoch.epochId !== epochId || epoch.kind !== "CompactionEpoch"
    || formatForVerifiedOwner(storage).dialect === "lode" && !familyFormatForOriginal("head-agent-core-compaction-recovery", epoch, storage)) fail("Compaction epoch identity is invalid.", "INVALID_COMPACTION_EPOCH");
  return { file, epoch };
}

function writeEpoch(file, epoch, state, fields = {}) {
  const updated = { ...epoch, ...fields, state, updatedAt: now() };
  replaceJson(file, updated);
  return updated;
}

function currentEpoch(root, storage) {
  const file = currentEpochFile(root, storage);
  if (!fs.existsSync(file)) return null;
  const pointer = readJson(file, "Current compaction epoch pointer");
  return readEpoch(root, pointer.epochId, storage).epoch;
}

function continuationConsumption(root, epoch, storage) {
  const file = consumptionFile(root, epoch.epochId, storage);
  if (!fs.existsSync(file)) return { status: "absent" };
  let value;
  try { value = readJson(file, "Compaction continuation consumption"); }
  catch (error) {
    if (error.code !== "INVALID_COMPACTION_CANON") throw error;
    return { status: "invalid" };
  }
  const valid = value?.schemaVersion === SCHEMA_VERSION
    && value.kind === "CompactionContinuationConsumption"
    && value.epochId === epoch.epochId && value.checkpointId === epoch.checkpointId
    && value.checkpointDigest === epoch.checkpointDigest
    && typeof value.consumedAt === "string" && Number.isFinite(Date.parse(value.consumedAt))
    && value.providerSessionIdentityPersisted === false;
  return { status: valid ? "consumed" : "invalid" };
}

function settleInterruptedContinuation(inspected, epoch) {
  if (epoch?.state !== "verified" || epoch.projectId !== inspected.project.projectId
    || epoch.sessionId !== inspected.state.sessionId
    || continuationConsumption(inspected.project.projectRoot, epoch, inspected.storage).status !== "consumed") return epoch;
  // The at-most-once claim is durable, but returning/submitting the continuation
  // is not proven. Close only P5; never recreate a token, receipt of success, or P2.
  return writeEpoch(epochFile(inspected.project.projectRoot, epoch.epochId, inspected.storage), epoch, "aborted", {
    abortReason: UNCERTAIN_CONTINUATION_REASON,
    continuationTokenBindingHash: null,
  });
}

// Host lifecycle mutation, not a read-side repair or a new recovery authority.
export function settleCompactionContinuation({ root = ".", epochId } = {}) {
  return withProjectMutation({ root, scope: "session-recovery" }, () => {
    const inspected = readyProject(root, "interrupted continuation is closed");
    const epoch = currentEpoch(inspected.project.projectRoot, inspected.storage);
    if (!epoch || epoch.epochId !== epochId || epoch.projectId !== inspected.project.projectId
      || epoch.sessionId !== inspected.state.sessionId) {
      fail("Interrupted continuation does not match the current Project, Session and epoch.", "COMPACTION_CHECKPOINT_STALE");
    }
    if (continuationConsumption(inspected.project.projectRoot, epoch, inspected.storage).status !== "consumed") {
      fail("Interrupted continuation requires its exact durable consumption.", "INVALID_COMPACTION_CONSUMPTION");
    }
    const settled = settleInterruptedContinuation(inspected, epoch);
    if (settled.state !== "aborted" || settled.abortReason !== UNCERTAIN_CONTINUATION_REASON) {
      fail("Continuation is not an interrupted consumption.", "INVALID_COMPACTION_STATE");
    }
    return { status: "compaction_continuation_outcome_uncertain", epoch: settled, retryAllowed: false, authorityChanged: false };
  });
}

function withRecoveryMutation(options, operation) {
  return withProjectMutation({ root: options.root, scope: "session-recovery" }, () => {
    const inspected = readyProject(options.root, "a recovery operation runs");
    const previous = currentEpoch(inspected.project.projectRoot, inspected.storage);
    if (previous?.state === "preparing") {
      // The previous process stopped before prepare returned. Preserve whichever
      // complete P2 checkpoint was published, and close only the P5 token whose
      // delivery is now uncertain. No raw token or direction is reconstructed.
      writeEpoch(epochFile(inspected.project.projectRoot, previous.epochId, inspected.storage), previous, "aborted", {
        abortReason: "prepare-interrupted-before-token-delivery",
        continuationTokenBindingHash: null,
      });
    }
    settleInterruptedContinuation(inspected, previous);
    return operation();
  });
}

function assertCurrentStateMatchesCheckpoint(inspected, checkpoint) {
  if (inspected.state.sessionId !== checkpoint.sessionId || inspected.state.latestCheckpoint !== checkpoint.checkpointId) {
    fail("Current Session no longer points to the prepared recovery checkpoint.", "COMPACTION_CHECKPOINT_STALE");
  }
  if (checkpoint.protocol?.version === COMPACTION_RECOVERY_VERSION
    && canonicalJson(readSessionPointer(inspected)) !== canonicalJson(checkpoint.sessionPointer)) {
    fail("Current Session pointer changed after compaction prepare.", "COMPACTION_SESSION_DRIFT");
  }
  const currentRun = readRunPointer(inspected);
  if (canonicalJson(currentRun) !== canonicalJson(checkpoint.runPointer)) {
    fail("Current Run pointer changed after compaction prepare.", "COMPACTION_RUN_DRIFT");
  }
  const currentReviews = inspected.state.pendingReview?.resultPacketId ? [inspected.state.pendingReview.resultPacketId] : [];
  if (currentReviews.some((id) => !checkpoint.openReviewIds.includes(id))) {
    fail("An open review is missing from the recovery checkpoint.", "COMPACTION_REVIEW_DRIFT");
  }
}

function maybeSupersede(root, epochFilePath, epoch, currentUserTurnId) {
  const current = turnId(currentUserTurnId, "Current user turn id");
  if (!OPEN_STATES.has(epoch.state)) return epoch;
  if (current <= epoch.userTurnIdAtPrepare) return epoch;
  const superseded = writeEpoch(epochFilePath, epoch, "superseded", {
    supersededByUserTurnId: current,
    continuationTokenBindingHash: null,
  });
  return superseded;
}

function validateCompactionRuntime(runtime) {
  if (!new Set(["manual", "claude", "codex", "opencode"]).has(runtime)) {
    fail("Compaction runtime is invalid.", "INVALID_COMPACTION_RUNTIME");
  }
  return runtime;
}

function createCompactionEpoch({ inspected, checkpoint, runtime, userTurnIdAtPrepare, commitCheckpoint = null }) {
  const previous = currentEpoch(inspected.project.projectRoot, inspected.storage);
  if (previous && OPEN_STATES.has(previous.state)) fail(`Compaction epoch is already open: ${previous.epochId}`, "COMPACTION_EPOCH_ALREADY_OPEN");
  if (inspected.state.activeRunId && !checkpoint.runPointer) {
    fail("Active Run compaction requires a verified Run pointer.", "COMPACTION_RUN_POINTER_REQUIRED");
  }
  const epochId = `compaction-epoch-${crypto.randomUUID()}`;
  const continuationToken = crypto.randomBytes(32).toString("base64url");
  const epoch = {
    schemaVersion: SCHEMA_VERSION,
    kind: "CompactionEpoch",
    protocol: { name: formatForVerifiedOwner(inspected.storage).protocol("head-agent-core-compaction-recovery"), version: COMPACTION_RECOVERY_VERSION },
    epochId,
    projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId,
    runId: checkpoint.runPointer?.runId || null,
    checkpointId: checkpoint.checkpointId,
    checkpointDigest: checkpoint.checkpointDigest,
    userTurnIdAtPrepare: turnId(userTurnIdAtPrepare, "User turn id at prepare"),
    continuationTokenBindingHash: digest(`${epochId}\n${checkpoint.checkpointDigest}\n${continuationToken}`),
    runtime: validateCompactionRuntime(runtime),
    state: "preparing",
    createdAt: now(),
    updatedAt: now(),
    providerSessionIdentityPersisted: false,
  };
  const file = epochFile(inspected.project.projectRoot, epochId, inspected.storage);
  const pointerFile = currentEpochFile(inspected.project.projectRoot, inspected.storage);
  const sessionFile = sessionStatePath(inspected.project.projectRoot, inspected.storage);
  const previousPointer = fs.existsSync(pointerFile) ? fs.readFileSync(pointerFile) : null;
  const previousSession = fs.readFileSync(sessionFile);
  const checkpointPath = checkpointFile(inspected.project.projectRoot, checkpoint.checkpointId, inspected.storage);
  const checkpointExisted = fs.existsSync(checkpointPath);
  let prepared;
  try {
    atomicWrite(file, json(epoch));
    replaceJson(pointerFile, { schemaVersion: SCHEMA_VERSION, epochId, updatedAt: now() });
    if (commitCheckpoint) commitCheckpoint();
    prepared = writeEpoch(file, epoch, "prepared");
  } catch (error) {
    // Synchronous failures restore exact pointers. Abrupt process death is
    // handled by the preparing state on the next mutation, without replaying
    // the lost token or treating a P5 journal as recovery authority.
    atomicWrite(sessionFile, previousSession);
    if (previousPointer) atomicWrite(pointerFile, previousPointer);
    else if (fs.existsSync(pointerFile)) fs.unlinkSync(pointerFile);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    if (!checkpointExisted && fs.existsSync(checkpointPath)) fs.unlinkSync(checkpointPath);
    throw error;
  }
  return {
    status: "compaction_prepared",
    checkpoint,
    epoch: prepared,
    continuationToken,
    warning: "Compaction is lossy; recovery authority remains the Session/Run checkpoint.",
    providerAction: "Perform provider compaction explicitly, then verify it with trusted user-turn evidence.",
  };
}

export function prepareCompaction(options = {}) {
  validateCompactionRuntime(options.runtime ?? "manual");
  turnId(options.userTurnIdAtPrepare, "User turn id at prepare");
  return withRecoveryMutation(options, () => prepareCompactionLocked(options));
}

function prepareCompactionLocked({ root = ".", runtime = "manual", userTurnIdAtPrepare, purpose, approvedDecisions = [], currentPosition, nextExpectedResult, openReviewIds = [] } = {}) {
  const inspected = readyProject(root, "compaction is prepared");
  validateCompactionRuntime(runtime);
  turnId(userTurnIdAtPrepare, "User turn id at prepare");
  const previous = currentEpoch(inspected.project.projectRoot, inspected.storage);
  if (previous && OPEN_STATES.has(previous.state)) fail(`Compaction epoch is already open: ${previous.epochId}`, "COMPACTION_EPOCH_ALREADY_OPEN");
  const payload = recoveryCheckpointPayload({ inspected, purpose, approvedDecisions, currentPosition, nextExpectedResult, openReviewIds });
  const checkpointDigest = digest(canonicalJson(payload));
  const checkpoint = { ...payload, checkpointId: `checkpoint-${checkpointDigest.slice(0, 24)}`, checkpointDigest };
  return createCompactionEpoch({
    inspected,
    checkpoint,
    runtime,
    userTurnIdAtPrepare,
    commitCheckpoint: () => persistRecoveryCheckpoint(inspected, checkpoint),
  });
}

export function prepareCompactionFromCurrentCheckpoint(options = {}) {
  validateCompactionRuntime(options.runtime ?? "manual");
  turnId(options.userTurnIdAtPrepare, "User turn id at prepare");
  return withRecoveryMutation(options, () => prepareCompactionFromCurrentCheckpointLocked(options));
}

function prepareCompactionFromCurrentCheckpointLocked({ root = ".", runtime = "manual", userTurnIdAtPrepare } = {}) {
  const inspected = readyProject(root, "compaction is prepared from the current recovery checkpoint");
  validateCompactionRuntime(runtime);
  if (!inspected.state.latestCheckpoint) {
    fail("A current canonical recovery checkpoint is required.", "SESSION_RESTORE_CHECKPOINT_REQUIRED");
  }
  const checkpoint = readRecoveryCheckpoint({
    root: inspected.project.projectRoot,
    checkpointId: inspected.state.latestCheckpoint,
  }).checkpoint;
  if (checkpoint.protocol?.version !== COMPACTION_RECOVERY_VERSION || !checkpoint.sessionPointer) {
    fail("Only a current checkpoint with the complete Session pointer can be reused.", "SESSION_RESTORE_CURRENT_CHECKPOINT_REQUIRED");
  }
  assertCurrentStateMatchesCheckpoint(inspectProject(inspected.project.projectRoot), checkpoint);
  return {
    ...createCompactionEpoch({ inspected, checkpoint, runtime, userTurnIdAtPrepare }),
    checkpointReused: true,
  };
}

export function verifyCompaction(options = {}) {
  turnId(options.currentUserTurnId, "Current user turn id");
  return withRecoveryMutation(options, () => verifyCompactionLocked(options));
}

function verifyCompactionLocked({ root = ".", epochId, checkpointDigest, currentUserTurnId, providerCompacted = false, recoverySource = "canonical-checkpoint" } = {}) {
  const inspected = readyProject(root, "compaction recovery is verified");
  const loaded = readEpoch(inspected.project.projectRoot, epochId, inspected.storage);
  let epoch = maybeSupersede(inspected.project.projectRoot, loaded.file, loaded.epoch, currentUserTurnId);
  if (epoch.state === "superseded") fail("A newer real user turn superseded the pending continuation.", "COMPACTION_SUPERSEDED");
  if (recoverySource !== "canonical-checkpoint") fail("Recovery must use only the canonical Session/Run checkpoint.", "NON_CANONICAL_RECOVERY_SOURCE");
  if (epoch.state !== "prepared" && epoch.state !== "provider_compacted") fail(`Compaction cannot be verified from state ${epoch.state}.`, "INVALID_COMPACTION_STATE");
  if (!providerCompacted && epoch.state === "prepared") {
    writeEpoch(loaded.file, epoch, "aborted", { abortReason: "provider-compaction-failed", continuationTokenBindingHash: null });
    fail("Provider compaction did not succeed; a new prepare is required before retry.", "PROVIDER_COMPACTION_FAILED");
  }
  if (checkpointDigest !== epoch.checkpointDigest) {
    writeEpoch(loaded.file, epoch, "aborted", { abortReason: "checkpoint-digest-mismatch", continuationTokenBindingHash: null });
    fail("Prepared checkpoint digest does not match the supplied digest.", "COMPACTION_DIGEST_MISMATCH");
  }
  let checkpoint;
  try {
    checkpoint = readRecoveryCheckpoint({ root: inspected.project.projectRoot, checkpointId: epoch.checkpointId }).checkpoint;
    assertCurrentStateMatchesCheckpoint(inspectProject(inspected.project.projectRoot), checkpoint);
  } catch (error) {
    writeEpoch(loaded.file, epoch, "aborted", { abortReason: error.code || "checkpoint-verification-failed", continuationTokenBindingHash: null });
    throw error;
  }
  epoch = writeEpoch(loaded.file, epoch, "verified", { providerCompactedAt: epoch.providerCompactedAt || now(), verifiedAt: now() });
  return {
    status: "compaction_verified",
    epoch,
    checkpoint,
    recoverySource: "canonical-session-run-checkpoint",
    excludedSources: ["provider-transcript", "provider-summary", "provider-session-identity", formatForVerifiedOwner(inspected.storage).kind("HEADContinuitySnapshot")],
  };
}

export function continueCompaction(options = {}) {
  turnId(options.currentUserTurnId, "Current user turn id");
  return withRecoveryMutation(options, () => continueCompactionLocked(options));
}

function continueCompactionLocked({ root = ".", epochId, continuationToken, currentUserTurnId } = {}) {
  const inspected = readyProject(root, "compaction continuation is authorized");
  const loaded = readEpoch(inspected.project.projectRoot, epochId, inspected.storage);
  let epoch = maybeSupersede(inspected.project.projectRoot, loaded.file, loaded.epoch, currentUserTurnId);
  if (epoch.state === "superseded") fail("A newer real user turn superseded the pending continuation.", "COMPACTION_SUPERSEDED");
  if (epoch.state === "continued" || fs.existsSync(consumptionFile(inspected.project.projectRoot, epochId, inspected.storage))) {
    fail("Compaction continuation token was already consumed.", "COMPACTION_TOKEN_CONSUMED");
  }
  if (epoch.state !== "verified") fail(`Compaction continuation requires verified state; current state: ${epoch.state}.`, "COMPACTION_NOT_VERIFIED");
  const token = requiredText(continuationToken, "Continuation token");
  const bindingHash = digest(`${epochId}\n${epoch.checkpointDigest}\n${token}`);
  if (bindingHash !== epoch.continuationTokenBindingHash) fail("Continuation token does not match this epoch and checkpoint.", "INVALID_COMPACTION_TOKEN");
  const checkpoint = readRecoveryCheckpoint({ root: inspected.project.projectRoot, checkpointId: epoch.checkpointId }).checkpoint;
  if (checkpoint.checkpointDigest !== epoch.checkpointDigest || epoch.projectId !== inspected.project.projectId
    || epoch.sessionId !== inspected.state.sessionId || currentEpoch(inspected.project.projectRoot, inspected.storage)?.epochId !== epoch.epochId) {
    fail("The continuation no longer matches the current Project, Session, epoch, and checkpoint.", "COMPACTION_CHECKPOINT_STALE");
  }
  assertCurrentStateMatchesCheckpoint(readyProject(inspected.project.projectRoot, "continuation is consumed"), checkpoint);
  // Existing current-direction verification precedes the one-shot P5 write;
  // unavailable common authority must not be reported only after consumption.
  const currentProjectDirection = readProjectDirection({ root: inspected.project.projectRoot });
  const consumption = {
    schemaVersion: SCHEMA_VERSION,
    kind: "CompactionContinuationConsumption",
    epochId,
    checkpointId: epoch.checkpointId,
    checkpointDigest: epoch.checkpointDigest,
    consumedAt: now(),
    providerSessionIdentityPersisted: false,
  };
  const consumedFile = consumptionFile(inspected.project.projectRoot, epochId, inspected.storage);
  fs.mkdirSync(path.dirname(consumedFile), { recursive: true });
  try { fs.writeFileSync(consumedFile, json(consumption), { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if (error.code === "EEXIST") fail("Compaction continuation token was already consumed.", "COMPACTION_TOKEN_CONSUMED");
    throw error;
  }
  epoch = writeEpoch(loaded.file, epoch, "continued", { continuedAt: now(), continuationTokenBindingHash: null });
  return {
    status: "compaction_continuation_consumed",
    epoch,
    checkpoint,
    currentProjectDirection,
    continuationInstruction: `Continue from checkpoint ${checkpoint.checkpointId} subject to the current common Project direction, constraints and cancelled actions; its historical nextExpectedResult grants no current effect authorization. Preserve the checkpoint's recorded purpose and approved decisions.`,
    providerSubmission: "adapter-or-user-owned",
  };
}

export function abortCompaction(options = {}) {
  return withRecoveryMutation(options, () => abortCompactionLocked(options));
}

function abortCompactionLocked({ root = ".", epochId, reason = "explicit-abort" } = {}) {
  const inspected = readyProject(root, "compaction is aborted");
  const loaded = readEpoch(inspected.project.projectRoot, epochId, inspected.storage);
  if (TERMINAL_STATES.has(loaded.epoch.state)) fail(`Compaction epoch is already terminal: ${loaded.epoch.state}.`, "COMPACTION_ALREADY_TERMINAL");
  const epoch = writeEpoch(loaded.file, loaded.epoch, "aborted", {
    abortReason: requiredText(reason, "Abort reason"),
    continuationTokenBindingHash: null,
  });
  return { status: "compaction_aborted", epoch };
}

export function inspectCompaction({ root = "." } = {}) {
  const inspected = readyProject(root, "compaction status is read");
  const epoch = currentEpoch(inspected.project.projectRoot, inspected.storage);
  if (!epoch) return { status: "idle", sessionId: inspected.state.sessionId, recoveryAuthority: "session-run-checkpoint" };
  const consumption = continuationConsumption(inspected.project.projectRoot, epoch, inspected.storage);
  let checkpoint = null;
  let checkpointVerification = { status: "verified", code: null };
  try { checkpoint = readRecoveryCheckpoint({ root: inspected.project.projectRoot, checkpointId: epoch.checkpointId }).checkpoint; }
  catch (error) { checkpointVerification = { status: "failed", code: error.code || "COMPACTION_RECOVERY_ERROR" }; }
  return {
    status: epoch.state === "preparing" ? "interrupted-prepare" : OPEN_STATES.has(epoch.state) ? "open" : "terminal",
    epoch: { ...epoch, continuationTokenBindingHash: epoch.continuationTokenBindingHash ? "present-not-disclosed" : null },
    checkpoint,
    checkpointVerification,
    continuationConsumption: consumption.status,
    continuationOutcome: consumption.status === "consumed" && (epoch.state === "verified"
      || (epoch.state === "aborted" && epoch.abortReason === UNCERTAIN_CONTINUATION_REASON)) ? "uncertain" : null,
    recoveryAuthority: "session-run-checkpoint",
    providerSessionIdentityPersisted: false,
  };
}
