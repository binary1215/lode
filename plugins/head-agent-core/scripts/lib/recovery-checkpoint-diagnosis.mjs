import fs from "node:fs";
import path from "node:path";
import { inspectProject, isProjectRecoveryReadable, SCHEMA_VERSION } from "./lode-core.mjs";
import { inspectRecoveryCheckpointBasis } from "./compaction-recovery.mjs";
import { sessionStateHash } from "./run-lineage.mjs";
import { restoreSessionFromArtifacts } from "./session-recovery.mjs";

import { formatForVerifiedOwner } from "./project-storage-format.mjs";
import { publicToolName } from "./lode-artifact-composition.mjs";

export const RECOVERY_CHECKPOINT_DIAGNOSIS_VERSION = "0.1.0";

const CORE_FAILURE_CODES = new Set([
  "MANAGED_DRIFT",
  "NOT_INITIALIZED",
  "PROJECT_NOT_READY",
]);

const INTEGRITY_FAILURE_CODES = new Set([
  "COMPACTION_DIGEST_MISMATCH",
  "INVALID_COMPACTION_CANON",
  "INVALID_COMPACTION_CONSUMPTION",
  "INVALID_COMPACTION_EPOCH",
  "INVALID_RECOVERY_CHECKPOINT",
  "INVALID_RECOVERY_CHECKPOINT_ID",
  "INVALID_SESSION_CANON",
  "INVALID_SESSION_RECOVERY_ARTIFACT",
  "INVALID_CONTEXT_CANON",
  "INVALID_FRESH_HEAD_REVIEW",
  "INVALID_LINEAGE_ARTIFACT",
  "INVALID_RUN_RESULT_INTEGRATION_RECEIPT",
  "INVALID_RUN_RESULT_INTEGRATION_REQUEST",
  "LINEAGE_DIGEST_MISMATCH",
  "LINEAGE_IDENTITY_MISMATCH",
  "SESSION_RUN_IDENTITY_MISMATCH",
]);

const REQUIRED_ARTIFACT_MISSING_CODES = new Set([
  "CAPSULE_NOT_FOUND",
  "LINEAGE_ARTIFACT_NOT_FOUND",
  "SESSION_RUN_NOT_FOUND",
]);

const SYNCABLE_CHECKPOINT_DRIFT_CODES = new Set([
  "SESSION_RESTORE_CURRENT_CHECKPOINT_REQUIRED",
  "SESSION_RESTORE_POINTER_DRIFT",
]);

function observedProject(root) {
  try {
    const inspected = inspectProject(root);
    const selectedRunId = inspected.state?.activeRunId
      || inspected.state?.pendingReview?.runId
      || inspected.state?.lastReviewedRunId
      || null;
    const selectedRunFileStatus = selectedRunId == null
      ? "not-applicable"
      : !/^run-[0-9]+-[a-f0-9]{6}$/.test(selectedRunId)
        ? "invalid-id"
        : fs.existsSync(path.join(inspected.project.projectRoot, formatForVerifiedOwner(inspected.storage).directory, "sessions", "runs", selectedRunId, "run.json"))
          ? "present"
          : "missing";
    return {
      storage: inspected.storage,
      status: inspected.status,
      recoveryReadable: isProjectRecoveryReadable(inspected),
      projectId: inspected.project?.projectId || null,
      sessionId: inspected.state?.sessionId || null,
      latestCheckpointId: inspected.state?.latestCheckpoint || null,
      sessionRecordHash: inspected.state ? sessionStateHash(inspected.state) : null,
      selectedRunId,
      selectedRunFileStatus,
      errorCode: null,
    };
  } catch (error) {
    return {
      status: "inspection-failed",
      recoveryReadable: false,
      projectId: null,
      sessionId: null,
      latestCheckpointId: null,
      sessionRecordHash: null,
      selectedRunId: null,
      selectedRunFileStatus: "unknown",
      errorCode: error?.code || "PROJECT_INSPECTION_FAILED",
    };
  }
}

function attempt(operation) {
  try {
    return { ok: true, value: operation(), error: null };
  } catch (error) {
    return { ok: false, value: null, error };
  }
}

function sameProjectObservation(first, second) {
  return first.recoveryReadable === second.recoveryReadable
    && (first.recoveryReadable || first.status === second.status)
    && first.projectId === second.projectId
    && first.sessionId === second.sessionId
    && first.latestCheckpointId === second.latestCheckpointId
    && first.sessionRecordHash === second.sessionRecordHash
    && first.selectedRunId === second.selectedRunId
    && first.selectedRunFileStatus === second.selectedRunFileStatus
    && first.errorCode === second.errorCode;
}

function sameBasis(first, second) {
  return first?.basis?.basisId === second?.basis?.basisId
    && first?.basis?.basisHash === second?.basis?.basisHash
    && first?.basis?.projectId === second?.basis?.projectId
    && first?.basis?.sessionId === second?.basis?.sessionId
    && first?.basis?.latestCheckpointId === second?.basis?.latestCheckpointId
    && first?.basis?.latestCheckpointDigest === second?.basis?.latestCheckpointDigest
    && first?.basis?.sessionRecordHash === second?.basis?.sessionRecordHash;
}

function projectMatchesBasis(project, basisResult) {
  const basis = basisResult?.basis;
  return Boolean(basis)
    && project.recoveryReadable
    && project.projectId === basis.projectId
    && project.sessionId === basis.sessionId
    && project.latestCheckpointId === basis.latestCheckpointId
    && project.sessionRecordHash === basis.sessionRecordHash;
}

function restoreMatchesBasis(restoreResult, firstBasis, secondBasis) {
  const projection = restoreResult?.projection;
  const checkpoint = restoreResult?.checkpoint;
  const tuples = [firstBasis, secondBasis].map((result) => ({
    projectId: result?.basis?.projectId || null,
    sessionId: result?.basis?.sessionId || null,
    checkpointId: result?.basis?.latestCheckpointId || null,
    checkpointDigest: result?.basis?.latestCheckpointDigest || null,
  }));
  const restored = {
    projectId: projection?.projectId || null,
    sessionId: projection?.sessionId || null,
    checkpointId: checkpoint?.checkpointId || null,
    checkpointDigest: checkpoint?.checkpointDigest || null,
  };
  return tuples.every((tuple) => JSON.stringify(tuple) === JSON.stringify(restored))
    && projection?.checkpoint?.checkpointId === checkpoint?.checkpointId
    && projection?.checkpoint?.checkpointDigest === checkpoint?.checkpointDigest;
}

function restoreMatchesProjectObservation(restoreResult, project) {
  const { projection, checkpoint } = restoreResult || {};
  return Boolean(project.latestCheckpointId && checkpoint?.checkpointDigest)
    && checkpoint?.projectId === project.projectId
    && checkpoint?.sessionId === project.sessionId
    && projection?.projectId === checkpoint.projectId
    && projection?.sessionId === checkpoint.sessionId
    && checkpoint.checkpointId === project.latestCheckpointId
    && projection?.checkpoint?.checkpointId === checkpoint.checkpointId
    && projection?.checkpoint?.checkpointDigest === checkpoint.checkpointDigest;
}

function optionalResultEvidence(projection) {
  const evidence = [
    projection?.pendingReview?.resultEvidence,
    projection?.lastResultEvidence,
    projection?.integrationEvidence,
  ].filter((item) => item?.resultPacketId);
  const missingResultPacketIds = [...new Set(
    evidence.filter((item) => item.status === "missing-evidence").map((item) => item.resultPacketId),
  )].sort();
  return {
    status: missingResultPacketIds.length ? "missing-evidence" : evidence.length ? "verified" : "not-applicable",
    missingResultPacketIds,
    requiredForCheckpointRestore: false,
  };
}

function checkpointUpdateFromBasis(basisResult, checkpointPresent) {
  const availability = basisResult?.syncAvailability || "unavailable";
  const reasonCodes = {
    "deferred-run-transition": "RUN_TRANSITION_INCOMPLETE",
    "conflict-run-transition": "RUN_TRANSITION_SESSION_DRIFT",
    "deferred-compaction": "COMPACTION_EPOCH_OPEN",
  };
  return {
    status: availability,
    freshDirectionPublishable: availability === "ready",
    exactCurrentReuseMayConverge: Boolean(checkpointPresent)
      && new Set(["ready", "deferred-compaction"]).has(availability),
    candidateDirectionCompared: false,
    reasonCode: reasonCodes[availability] || null,
    assessmentScope: "mechanical transition availability only",
  };
}

function unavailableCheckpointUpdate(reasonCode, status = "unavailable") {
  return {
    status,
    freshDirectionPublishable: false,
    exactCurrentReuseMayConverge: false,
    candidateDirectionCompared: false,
    reasonCode,
    assessmentScope: "mechanical transition availability only",
  };
}

function semanticFreshnessBoundary(storage) {
  return {
    status: "not-mechanically-determined",
    mechanicallyDetermined: false,
    basisEqualityProvesCurrentIntent: false,
    digestEqualityProvesCurrentIntent: false,
    automaticHeadAssessmentTriggered: false,
    requiredEvaluator: formatForVerifiedOwner(storage).value("current-provider-head-when-recovery-direction-is-materially-relevant"),
  };
}

function observationConsistency({ state, firstBasis, secondBasis, restoreTupleMatched = null, retryRequired }) {
  const successfulBasisReads = Number(Boolean(firstBasis)) + Number(Boolean(secondBasis));
  return {
    state,
    firstBasisId: firstBasis?.basis?.basisId || null,
    secondBasisId: secondBasis?.basis?.basisId || null,
    basisReadsMatched: Boolean(firstBasis && secondBasis && sameBasis(firstBasis, secondBasis)),
    restoreTupleMatched,
    retryRequired,
    atomicFilesystemSnapshot: false,
    abaChangesDetectable: false,
    scope: successfulBasisReads === 2
      ? "two sequential verified basis reads and one artifact-restore tuple"
      : `${successfulBasisReads} successful recovery basis reads; bounded Project/Session observations and any attempted artifact restore`,
  };
}

function authorityBoundary() {
  return {
    plane: "P4-non-persisted-diagnosis",
    recovery: false,
    instruction: false,
    review: false,
    promotion: false,
    canonMutation: false,
  };
}

function baseProjection({ project, checkpoint, diagnosis, artifactRecovery, checkpointUpdate, consistency, nextHeadAction, headActionRequired, recoveryDependentWorkBlocked, reviewDependentWorkBlocked = false }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "RecoveryCheckpointDiagnosisProjection",
    protocol: { name: formatForVerifiedOwner(project.storage).protocol("head-agent-core-recovery-checkpoint-diagnosis"), version: RECOVERY_CHECKPOINT_DIAGNOSIS_VERSION },
    status: "recovery_checkpoint_diagnosed",
    projectId: project.projectId,
    sessionId: project.sessionId,
    currentCheckpoint: checkpoint,
    diagnosis,
    artifactRecovery,
    checkpointUpdate,
    semanticFreshness: semanticFreshnessBoundary(project.storage),
    observationConsistency: consistency,
    nextHeadAction,
    headActionRequired,
    recoveryDependentWorkBlocked,
    reviewDependentWorkBlocked,
    ordinaryWorkBlocked: false,
    userDecisionRequired: false,
    persisted: false,
    writes: { checkpointLedger: 0, sessionPointer: 0, mutationLease: 0, diagnosisCache: 0 },
    autoRepairAttempted: false,
    authorityChanged: false,
    authority: authorityBoundary(),
  };
}

function currentCheckpoint(project, basisResult = null) {
  const basis = basisResult?.basis;
  const checkpointId = basis?.latestCheckpointId ?? project.latestCheckpointId ?? null;
  return {
    pointer: checkpointId ? "present" : "none",
    checkpointId,
    checkpointDigest: basis?.latestCheckpointDigest || null,
  };
}

function classifyFailure(error, project) {
  const reasonCode = error?.code || "SESSION_RESTORE_VERIFICATION_FAILED";
  if (reasonCode === "RECOVERY_CHECKPOINT_NOT_FOUND" && project.latestCheckpointId) {
    return {
      state: "current-checkpoint-artifact-missing",
      failureClass: "missing-ledger-artifact",
      summary: "The Session points to a checkpoint whose ledger file is missing.",
      nextHeadAction: {
        id: "recover-exact-checkpoint-artifact",
        summary: "Recover the exact checkpoint bytes from trusted evidence, or inspect the current Session direction explicitly; do not invent or auto-repair it.",
      },
    };
  }
  if (CORE_FAILURE_CODES.has(reasonCode)) {
    return {
      state: "core-drift",
      failureClass: "core-readiness",
      summary: "Core readiness or managed-file integrity prevents checkpoint diagnosis.",
      nextHeadAction: {
        id: "resolve-core-readiness",
        summary: "Inspect and resolve the exact Core readiness failure before relying on checkpoint-dependent work.",
      },
    };
  }
  if (REQUIRED_ARTIFACT_MISSING_CODES.has(reasonCode)
    || (reasonCode === "INVALID_RUN_CANON" && project.selectedRunFileStatus === "missing")) {
    return {
      state: "required-recovery-artifact-missing",
      failureClass: "required-artifact-loss",
      summary: "A required Session, Run, lineage, or Capsule artifact is missing.",
      nextHeadAction: {
        id: "recover-required-recovery-artifact",
        summary: "Recover the exact required artifact from trusted evidence before checkpoint-dependent work; do not substitute optional evidence or a summary.",
      },
    };
  }
  if (INTEGRITY_FAILURE_CODES.has(reasonCode) || reasonCode.includes("DIGEST")
    || reasonCode === "INVALID_RUN_CANON") {
    return {
      state: "checkpoint-integrity-failure",
      failureClass: "integrity",
      summary: "A recovery artifact failed structural or digest verification.",
      nextHeadAction: {
        id: "restore-trusted-recovery-artifact",
        summary: "Inspect the exact failed artifact and restore only trusted bytes; do not rewrite direction from a summary or derived view.",
      },
    };
  }
  if (reasonCode.startsWith("SESSION_RESTORE_") || reasonCode.startsWith("SESSION_RUN_")
    || reasonCode.includes("LINEAGE") || reasonCode.includes("CAPSULE") || reasonCode.includes("REVIEW")) {
    return {
      state: "checkpoint-reference-drift",
      failureClass: "reference-or-lineage",
      summary: "The checkpoint no longer matches the exact current Session or verified lineage.",
      nextHeadAction: {
        id: "inspect-exact-session-lineage",
        summary: "Inspect the current Session and lineage, then let the current provider HEAD assess a fresh direction only if a new checkpoint is useful.",
      },
    };
  }
  return {
    state: "verification-failed",
    failureClass: "unclassified-verification",
    summary: "Checkpoint recovery verification did not complete.",
    nextHeadAction: {
      id: "inspect-recovery-verification-failure",
      summary: "Inspect the exact reason code and retry a fresh read after the underlying recovery evidence is understood.",
    },
  };
}

function failureProjection({ project, error, firstBasis = null, secondBasis = null, consistencyState = "not-established-after-verification-failure", projectChanged = false }) {
  const classified = classifyFailure(error, project);
  const integrityFailure = classified.failureClass === "integrity";
  const stableBasis = Boolean(firstBasis && secondBasis && sameBasis(firstBasis, secondBasis) && !projectChanged);
  const changed = projectChanged || Boolean(firstBasis && secondBasis && !sameBasis(firstBasis, secondBasis));
  const retryRequired = changed;
  const basisCanDescribeUpdate = stableBasis && SYNCABLE_CHECKPOINT_DRIFT_CODES.has(error?.code || "");
  return baseProjection({
    project,
    checkpoint: currentCheckpoint(project, secondBasis || firstBasis),
    diagnosis: {
      state: classified.state,
      reasonCode: error?.code || "SESSION_RESTORE_VERIFICATION_FAILED",
      failureClass: classified.failureClass,
      summary: classified.summary,
    },
    artifactRecovery: {
      status: "failed",
      reasonCode: error?.code || "SESSION_RESTORE_VERIFICATION_FAILED",
      optionalResultEvidence: { status: "unknown", missingResultPacketIds: [], requiredForCheckpointRestore: false },
    },
    checkpointUpdate: basisCanDescribeUpdate && !integrityFailure
      ? checkpointUpdateFromBasis(secondBasis, Boolean(secondBasis.basis.latestCheckpointId))
      : unavailableCheckpointUpdate(error?.code || "SESSION_RESTORE_VERIFICATION_FAILED"),
    consistency: observationConsistency({
      state: changed ? "changed-during-observed-reads" : consistencyState,
      firstBasis,
      secondBasis,
      restoreTupleMatched: false,
      retryRequired,
    }),
    nextHeadAction: classified.nextHeadAction,
    headActionRequired: true,
    recoveryDependentWorkBlocked: classified.state === "core-drift" ? Boolean(project.latestCheckpointId) : true,
  });
}

function changedObservationProjection({ project, firstBasis, secondBasis, restoreTupleMatched = null }) {
  return baseProjection({
    project,
    checkpoint: currentCheckpoint(project, secondBasis || firstBasis),
    diagnosis: {
      state: "observation-changed-retry",
      reasonCode: "RECOVERY_DIAGNOSIS_OBSERVATION_CHANGED",
      failureClass: "sequential-read-drift",
      summary: "Recovery state changed while the bounded read sequence was in progress.",
    },
    artifactRecovery: {
      status: "not-conclusive",
      reasonCode: "RECOVERY_DIAGNOSIS_OBSERVATION_CHANGED",
      optionalResultEvidence: { status: "unknown", missingResultPacketIds: [], requiredForCheckpointRestore: false },
    },
    checkpointUpdate: unavailableCheckpointUpdate("RECOVERY_DIAGNOSIS_OBSERVATION_CHANGED", "recheck-required"),
    consistency: observationConsistency({
      state: "changed-during-observed-reads",
      firstBasis,
      secondBasis,
      restoreTupleMatched,
      retryRequired: true,
    }),
    nextHeadAction: {
      id: "retry-checkpoint-diagnosis",
      summary: "Retry the read-only diagnosis from a fresh boundary before any checkpoint-dependent action; do not merge the two observations.",
    },
    headActionRequired: true,
    recoveryDependentWorkBlocked: true,
  });
}

function directionUnavailableProjection({ project, restoreAttempt, includeRestore }) {
  if (project.latestCheckpointId && !restoreAttempt?.ok) {
    return failureProjection({ project, error: restoreAttempt?.error
      || Object.assign(new Error("Checkpoint restore was not observed."), { code: "SESSION_RESTORE_VERIFICATION_FAILED" }) });
  }
  const restored = restoreAttempt?.value;
  if (restored && !restoreMatchesProjectObservation(restored, project)) {
    return changedObservationProjection({ project, firstBasis: null, secondBasis: null, restoreTupleMatched: false });
  }
  if (restored && restored.projection.currentProjectDirectionAvailability?.status !== "unavailable") {
    return changedObservationProjection({ project, firstBasis: null, secondBasis: null });
  }
  const checkpoint = currentCheckpoint(project);
  if (restored) checkpoint.checkpointDigest = restored.checkpoint.checkpointDigest;
  const evidence = restored ? optionalResultEvidence(restored.projection)
    : { status: "not-applicable", missingResultPacketIds: [], requiredForCheckpointRestore: false };
  const executionStatus = restored?.projection.currentExecution?.status || "verified";
  const executionBlocked = new Set(["incomplete", "conflict"]).has(executionStatus);
  const projection = baseProjection({
    project, checkpoint,
    diagnosis: { state: restored ? "verified-checkpoint" : "no-current-checkpoint",
      reasonCode: "PROJECT_DIRECTION_UNAVAILABLE", failureClass: null,
      summary: "Retained Session artifacts remain readable, but current common direction is unavailable. This is not an empty direction or an execution authorization." },
    artifactRecovery: { status: restored ? "verified" : "not-applicable",
      reasonCode: restored ? null : "NO_CURRENT_CHECKPOINT",
      ...(restored ? { sessionRestoreId: restored.projection.sessionRestoreId, currentExecutionStatus: executionStatus } : {}),
      optionalResultEvidence: evidence },
    checkpointUpdate: unavailableCheckpointUpdate("PROJECT_DIRECTION_UNAVAILABLE"),
    consistency: observationConsistency({ state: "stable-selected-artifacts-current-direction-unavailable",
      firstBasis: null, secondBasis: null, restoreTupleMatched: restored ? true : null, retryRequired: false }),
    nextHeadAction: { id: "continue-independent-work-current-direction-unavailable",
      summary: "Use verified Session context for independent work. Only dependent effects or new direction publication need current common authority; do not guess a revision or replay historical work." },
    headActionRequired: executionBlocked, recoveryDependentWorkBlocked: executionBlocked,
    reviewDependentWorkBlocked: evidence.status === "missing-evidence",
  });
  projection.currentProjectDirectionAvailability = {
    status: "unavailable", reasonCode: "PROJECT_DIRECTION_UNAVAILABLE", dependentEffectsBlocked: true,
  };
  if (includeRestore && restored) projection.restore = restored;
  return projection;
}

export function inspectRecoveryCheckpointDiagnosis({ root = ".", includeRestore = false } = {}) {
  const projectBefore = observedProject(root);
  if (!projectBefore.recoveryReadable) {
    const error = Object.assign(new Error("Project is not ready for recovery checkpoint diagnosis."), {
      code: projectBefore.errorCode || (projectBefore.status === "not_initialized" ? "NOT_INITIALIZED" : "PROJECT_NOT_READY"),
    });
    return failureProjection({ project: projectBefore, error });
  }

  const firstAttempt = attempt(() => inspectRecoveryCheckpointBasis({ root }));
  const checkpointForRestore = firstAttempt.ok ? firstAttempt.value.basis.latestCheckpointId
    : firstAttempt.error?.code === "PROJECT_DIRECTION_UNAVAILABLE" ? projectBefore.latestCheckpointId : null;
  const restoreAttempt = checkpointForRestore
    ? attempt(() => restoreSessionFromArtifacts({ root }))
    : null;
  const secondAttempt = attempt(() => inspectRecoveryCheckpointBasis({ root }));
  const projectAfter = observedProject(root);
  const projectChanged = !sameProjectObservation(projectBefore, projectAfter);

  const failures = [firstAttempt, restoreAttempt, secondAttempt].filter((item) => item && !item.ok);
  const integrityFailure = failures.find((item) => {
    const code = item.error?.code || "";
    return INTEGRITY_FAILURE_CODES.has(code) || code.includes("DIGEST");
  });
  if (integrityFailure) {
    return failureProjection({
      project: projectAfter,
      error: integrityFailure.error,
      firstBasis: firstAttempt.value,
      secondBasis: secondAttempt.value,
      projectChanged,
    });
  }
  if (!firstAttempt.ok || !secondAttempt.ok) {
    const error = (!firstAttempt.ok ? firstAttempt.error : secondAttempt.error);
    const attemptsDisagree = firstAttempt.ok !== secondAttempt.ok
      || (!firstAttempt.ok && !secondAttempt.ok && firstAttempt.error?.code !== secondAttempt.error?.code);
    if (projectChanged || attemptsDisagree) {
      return changedObservationProjection({ project: projectAfter, firstBasis: firstAttempt.value, secondBasis: secondAttempt.value });
    }
    if (firstAttempt.error?.code === "PROJECT_DIRECTION_UNAVAILABLE"
      && secondAttempt.error?.code === "PROJECT_DIRECTION_UNAVAILABLE") {
      return directionUnavailableProjection({ project: projectAfter, restoreAttempt, includeRestore });
    }
    return failureProjection({ project: projectAfter, error, projectChanged });
  }

  const firstBasis = firstAttempt.value;
  const secondBasis = secondAttempt.value;
  const basisSequenceStable = sameBasis(firstBasis, secondBasis)
    && !projectChanged
    && projectMatchesBasis(projectBefore, firstBasis)
    && projectMatchesBasis(projectAfter, secondBasis);
  if (!basisSequenceStable) {
    return changedObservationProjection({ project: projectAfter, firstBasis, secondBasis });
  }

  if (!firstBasis.basis.latestCheckpointId) {
    return baseProjection({
      project: projectAfter,
      checkpoint: currentCheckpoint(projectAfter, secondBasis),
      diagnosis: {
        state: "no-current-checkpoint",
        reasonCode: "NO_CURRENT_CHECKPOINT",
        failureClass: null,
        summary: "The Session has no current checkpoint pointer.",
      },
      artifactRecovery: {
        status: "not-applicable",
        reasonCode: "NO_CURRENT_CHECKPOINT",
        optionalResultEvidence: { status: "not-applicable", missingResultPacketIds: [], requiredForCheckpointRestore: false },
      },
      checkpointUpdate: checkpointUpdateFromBasis(secondBasis, false),
      consistency: observationConsistency({
        state: "stable-across-observed-reads",
        firstBasis,
        secondBasis,
        retryRequired: false,
      }),
      nextHeadAction: {
        id: "continue-or-assess-checkpoint-need",
        summary: `Continue ordinary work. Only if durable recovery is useful, read a fresh ${publicToolName("head_checkpoint_basis")}, then let the current provider Lode derive direction before sync.`,
      },
      headActionRequired: false,
      recoveryDependentWorkBlocked: false,
    });
  }

  if (!restoreAttempt?.ok) {
    return failureProjection({
      project: projectAfter,
      error: restoreAttempt?.error || Object.assign(new Error("Restore was not attempted."), { code: "SESSION_RESTORE_VERIFICATION_FAILED" }),
      firstBasis,
      secondBasis,
    });
  }
  const tupleMatched = restoreMatchesBasis(restoreAttempt.value, firstBasis, secondBasis);
  if (!tupleMatched) {
    return changedObservationProjection({ project: projectAfter, firstBasis, secondBasis, restoreTupleMatched: false });
  }

  const resultEvidence = optionalResultEvidence(restoreAttempt.value.projection);
  const missingOptionalEvidence = resultEvidence.status === "missing-evidence";
  const executionStatus = restoreAttempt.value.projection.currentExecution?.status || "verified";
  const executionBlocked = new Set(["incomplete", "conflict"]).has(executionStatus);
  const projection = baseProjection({
    project: projectAfter,
    checkpoint: currentCheckpoint(projectAfter, secondBasis),
    diagnosis: {
      state: missingOptionalEvidence
        ? "verified-checkpoint-with-missing-result-evidence"
        : "verified-checkpoint",
      reasonCode: executionBlocked ? (executionStatus === "conflict" ? "RUN_TRANSITION_SESSION_DRIFT" : "RUN_TRANSITION_INCOMPLETE") : missingOptionalEvidence ? "OPTIONAL_RESULT_PACKET_EVIDENCE_MISSING" : "CHECKPOINT_ARTIFACT_RECOVERY_VERIFIED",
      failureClass: null,
      summary: missingOptionalEvidence
        ? "The P2 checkpoint verifies, while optional P3 ResultPacket evidence is missing."
        : "Historical checkpoint meaning and current execution facts verify separately across the observed reads.",
    },
    artifactRecovery: {
      status: missingOptionalEvidence ? "verified-with-missing-optional-evidence" : "verified",
      reasonCode: missingOptionalEvidence ? "OPTIONAL_RESULT_PACKET_EVIDENCE_MISSING" : null,
      sessionRestoreId: restoreAttempt.value.projection.sessionRestoreId,
      currentExecutionStatus: executionStatus,
      optionalResultEvidence: resultEvidence,
    },
    checkpointUpdate: checkpointUpdateFromBasis(secondBasis, true),
    consistency: observationConsistency({
      state: "stable-across-observed-reads",
      firstBasis,
      secondBasis,
      restoreTupleMatched: true,
      retryRequired: false,
    }),
    nextHeadAction: executionBlocked ? {
      id: "inspect-affected-run-storage",
      summary: "Historical meaning remains readable. Inspect the exact incomplete/conflicting Run storage before dependent effects; do not replay external work or rewrite checkpoint direction.",
    } : missingOptionalEvidence
      ? {
          id: "recover-result-evidence-if-review-is-needed",
          summary: "Continue from verified P2 direction; recover or reproduce the named P3 ResultPacket only before review-dependent work.",
        }
      : {
          id: "continue-from-verified-artifacts",
          summary: "Read current execution and common direction alongside historical checkpoint meaning. Do not replay historical next actions or require checkpoint sync for ordinary work.",
        },
    headActionRequired: executionBlocked,
    recoveryDependentWorkBlocked: executionBlocked,
    reviewDependentWorkBlocked: missingOptionalEvidence,
  });
  if (includeRestore) projection.restore = restoreAttempt.value;
  return projection;
}
