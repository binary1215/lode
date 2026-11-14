import { sha256CanonicalJson as sessionStateHash } from "../core/digest.mjs";
import { canonicalValue as canonical } from "../core/canonical-json.mjs";
import { fail } from "../core/errors.mjs";
// Pure source-data validation shared by ordinary Run readers and portability.
// It never selects a storage owner, writes P2, repairs transitions or replays work.

export function operationPointerHash(state) {
  return sessionStateHash(
    Object.fromEntries(
      [
        "sessionId",
        "mode",
        "currentWholePlanId",
        "activeRunId",
        "activeExecutionContractId",
        "lastResultPacketId",
        "pendingReview",
        "lastReviewDecisionId",
        "lastReviewedRunId",
        "requiredPlanAction",
      ].map((key) => [key, state[key] ?? null]),
    ),
  );
}

export function completedTransitionMatches(run, state, patch) {
  const transition = run.sessionTransition;
  const terminal =
    transition.kind === "start" ? run.status === "active" : transition.kind === "finish" ? run.status === "awaiting_review" : run.status === "reviewed";
  return terminal && Object.entries(patch).every(([key, value]) => sameValue(state[key], value));
}

export const sameValue = (left, right) => JSON.stringify(canonical(left ?? null)) === JSON.stringify(canonical(right ?? null));
export function unchangedSession(state, transition, patch) {
  return transition.before
    ? Object.entries(transition.before).every(([key, value]) => sameValue(state[key], value)) && sameValue(transition.patch, patch)
    : sessionStateHash(state) === transition.beforeSessionHash &&
        sessionStateHash({ ...state, ...patch, updatedAt: transition.changedAt }) === transition.afterSessionHash;
}

export const startPatch = (run) => ({
  mode: "run",
  currentWholePlanId: run.wholePlanId,
  activeRunId: run.runId,
  activeExecutionContractId: run.executionContractId,
  requiredPlanAction: null,
});
export const finishPatch = (run) => ({
  mode: "review",
  activeRunId: null,
  activeExecutionContractId: null,
  lastResultPacketId: run.resultPacketId,
  pendingReview: {
    runId: run.runId,
    wholePlanId: run.wholePlanId,
    resultPacketId: run.resultPacketId,
  },
});
export const reviewPatch = (run, artifact) => ({
  mode: "session",
  pendingReview: null,
  lastReviewDecisionId: run.reviewDecisionId,
  lastReviewedRunId: run.runId,
  requiredPlanAction:
    artifact.disposition === "accept"
      ? null
      : {
          kind: ["revise", "expand"].includes(artifact.disposition) ? "next-whole-plan" : "user-direction",
          disposition: artifact.disposition,
          wholePlanId: run.wholePlanId,
          reviewDecisionId: run.reviewDecisionId,
        },
});

function verifyRunLineage(root, run, inspected, requireArtifact, readContextCapsule) {
  if (run.sessionId != null && run.sessionId !== inspected.state.sessionId) fail("Run belongs to another Session.", "RUN_SESSION_MISMATCH");
  if (run.projectId !== inspected.project.projectId) fail("Run belongs to another Project.", "RUN_LINEAGE_CONFLICT");
  const contract = requireArtifact(root, run.executionContractId, "ExecutionContract");
  requireArtifact(root, run.wholePlanId, "WholePlanSnapshot");
  readContextCapsule({ root, capsuleId: run.capsuleId });
  if (contract.wholePlanId !== run.wholePlanId || contract.capsuleId !== run.capsuleId)
    fail("Run lineage differs from its verified Contract.", "RUN_LINEAGE_CONFLICT");
  return contract;
}

function verifyStartOperation(root, run, inspected, requireArtifact, readContextCapsule) {
  const op = run.startOperation;
  if (!op) return null;
  const { operationHash, ...payload } = op;
  if (
    operationHash !== sessionStateHash(payload) ||
    op.projectId !== run.projectId ||
    op.sessionId !== run.sessionId ||
    op.runId !== run.runId ||
    !sameValue(op.patch, startPatch(run)) ||
    op.transition?.kind !== "start" ||
    op.transition?.artifactId !== run.runId ||
    op.inputHash !==
      sessionStateHash({
        executionContractId: run.executionContractId,
        wholePlanId: run.wholePlanId,
        capsuleId: run.capsuleId,
      }) ||
    (op.requestKeyHash !== null && !/^[a-f0-9]{64}$/.test(op.requestKeyHash || ""))
  )
    fail("Run start identity is invalid.", "RUN_START_IDENTITY_CONFLICT");
  verifyRunLineage(root, run, inspected, requireArtifact, readContextCapsule);
  return op;
}

export function verifyRunTransitionOriginal({ inspected, run, requireArtifact, readContextCapsule }) {
  const root = inspected.project.projectRoot;
  verifyRunLineage(root, run, inspected, requireArtifact, readContextCapsule);
  const transition = run.sessionTransition;
  if (!transition) return { status: "stable", runId: run.runId, transition: null, executionReplayAllowed: false };
  if (!transition.before || !transition.patch)
    return {
      status: "legacy",
      runId: run.runId,
      transition: { kind: transition.kind },
      executionReplayAllowed: false,
    };
  const kind = transition.kind;
  let artifact = null,
    patch;
  if (kind === "start") {
    const op = verifyStartOperation(root, run, inspected, requireArtifact, readContextCapsule);
    if (!op || !sameValue(transition, op.transition)) fail("Run start transition differs from its request identity.", "RUN_START_IDENTITY_CONFLICT");
    patch = startPatch(run);
    if (run.status !== "active") fail("Start transition is not active.", "RUN_TRANSITION_CONFLICT");
  } else {
    if (!["finish", "review"].includes(kind)) fail("Unknown Run transition.", "RUN_TRANSITION_CONFLICT");
    const id = kind === "finish" ? run.resultPacketId : run.reviewDecisionId;
    if (transition.artifactId !== id || run.status !== (kind === "finish" ? "awaiting_review" : "reviewed"))
      fail("Run transition identity differs.", "RUN_TRANSITION_CONFLICT");
    try {
      artifact = requireArtifact(root, id, kind === "finish" ? "ResultPacket" : "ReviewDecision");
    } catch (error) {
      if (error.code !== "LINEAGE_ARTIFACT_NOT_FOUND") throw error;
      const alreadyStored =
        kind === "finish" && sameValue(transition.patch, finishPatch(run)) && completedTransitionMatches(run, inspected.state, finishPatch(run));
      if (transition.projectId !== inspected.project.projectId || transition.sessionId !== inspected.state.sessionId || transition.runId !== run.runId)
        fail("Run transition owner differs.", "RUN_TRANSITION_CONFLICT");
      return {
        status: alreadyStored ? "committed" : "incomplete",
        runId: run.runId,
        transition: { kind, artifactId: id, artifactStatus: "missing-evidence" },
        executionReplayAllowed: false,
        unknownEffect: !alreadyStored,
      };
    }
    if (
      (kind === "finish" && artifact.executionContractId !== run.executionContractId) ||
      (kind === "review" &&
        (artifact.resultPacketId !== run.resultPacketId || artifact.wholePlanId !== run.wholePlanId || artifact.disposition !== run.reviewDisposition))
    )
      fail("Run transition artifact lineage differs.", "RUN_TRANSITION_CONFLICT");
    patch = kind === "finish" ? finishPatch(run) : reviewPatch(run, artifact);
  }
  if (
    transition.projectId !== inspected.project.projectId ||
    transition.sessionId !== inspected.state.sessionId ||
    transition.runId !== run.runId ||
    !Number.isFinite(Date.parse(transition.changedAt)) ||
    !sameValue(transition.patch, patch) ||
    !sameValue(
      Object.keys(transition.before).sort(),
      [...new Set([...Object.keys(patch), "currentWholePlanId", "activeRunId", "activeExecutionContractId", "lastReviewedRunId"])].sort(),
    )
  )
    fail("Run Session preimage/patch is invalid.", "RUN_TRANSITION_CONFLICT");
  return {
    status: completedTransitionMatches(run, inspected.state, patch)
      ? "committed"
      : unchangedSession(inspected.state, transition, patch)
        ? "incomplete"
        : "conflict",
    runId: run.runId,
    transition: {
      kind,
      artifactId: transition.artifactId,
      artifactStatus: kind === "start" ? "not-required" : "verified",
    },
    executionReplayAllowed: false,
    unknownEffect: kind !== "review",
  };
}

export { sessionStateHash };
