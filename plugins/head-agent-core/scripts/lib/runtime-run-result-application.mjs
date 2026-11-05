import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
const sessionIdOf = record => {
  const format = familyFormatForOriginal({ sessionIdentity: true }, record);
  return format ? record?.[format.sessionIdField] : undefined;
};
const originalFormat = record => familyFormatForOriginal({ kind: record?.kind }, record);
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertRunSession } from "./session-routing.mjs";
import { inspectProject } from "./lode-core.mjs";
import { readContextCapsule } from "./context-compiler.mjs";
import { buildFreshHeadReview, readLineageArtifact } from "./execution-lineage.mjs";
import { finishRun, getPendingReviewContext } from "./run-lineage.mjs";
import { withProjectMutation } from "./project-mutation-lock.mjs";
import { isWorkerPatchProposalMode } from "./worker-patch-proposal.mjs";
import {
  readRuntimeInvocationRecord,
  runtimeInvocationRecordDirectory,
  writeRuntimeInvocationArtifactExclusive,
} from "./runtime-invocation-record.mjs";

export const RUNTIME_RUN_RESULT_APPLICATION_VERSION = "0.1.0";

const fail = (message, code = "RUNTIME_RUN_RESULT_APPLICATION_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

const canonicalJson = (value) => JSON.stringify(canonicalValue(value));
const prettyJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

function assertExactFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} is invalid.`, "INVALID_RUNTIME_RUN_RESULT_APPLICATION");
  const expected = new Set(fields);
  if (Object.keys(value).some((field) => !expected.has(field)) || fields.some((field) => !(field in value))) {
    fail(`${label} fields are invalid.`, "INVALID_RUNTIME_RUN_RESULT_APPLICATION");
  }
}

function identifyApplication(payload) {
  const applicationHash = digest(canonicalJson(payload));
  return {
    ...payload,
    applicationId: `runtime-run-result-application-${applicationHash.slice(0, 24)}`,
    applicationHash,
  };
}

export function verifyRuntimeRunResultApplication(document) {
  assertExactFields(document, [
    "schemaVersion", "kind", "protocolVersion", "authorizationId", "lifecycleReceiptId", "draftId",
    "runId", "executionContractId", "resultPacketId", "reviewContextId", "status",
    "freshHeadReviewRequired", "rawTranscriptIncluded", "authority", "instructionAuthority",
    "promotionAuthority", "mutatesCanon", "applicationId", "applicationHash",
  ], "Runtime Run result application");
  const { applicationId, applicationHash, ...payload } = document;
  const expectedHash = digest(canonicalJson(payload));
  if (document.schemaVersion !== 1 || document.kind !== "RuntimeRunResultApplication"
    || document.protocolVersion !== RUNTIME_RUN_RESULT_APPLICATION_VERSION
    || !/^execution-authorization-[a-f0-9]{24}$/.test(document.authorizationId || "")
    || !/^runtime-lifecycle-receipt-[a-f0-9]{24}$/.test(document.lifecycleReceiptId || "")
    || !/^runtime-result-draft-[a-f0-9]{24}$/.test(document.draftId || "")
    || !/^run-[0-9]+-[a-f0-9]{6}$/.test(document.runId || "")
    || !/^execution-contract-[a-f0-9]{24}$/.test(document.executionContractId || "")
    || !/^result-packet-[a-f0-9]{24}$/.test(document.resultPacketId || "")
    || !/^fresh-(?:head|lode)-review-[a-f0-9]{24}$/.test(document.reviewContextId || "")
    || document.status !== "run-result-applied-awaiting-review"
    || document.freshHeadReviewRequired !== true || document.rawTranscriptIncluded !== false
    || document.authority !== "execution-lineage-application-evidence"
    || document.instructionAuthority !== false || document.promotionAuthority !== false || document.mutatesCanon !== false
    || applicationHash !== expectedHash
    || applicationId !== `runtime-run-result-application-${expectedHash.slice(0, 24)}`) {
    fail("Runtime Run result application is invalid.", "INVALID_RUNTIME_RUN_RESULT_APPLICATION");
  }
  return document;
}

function runResultApplicationFile(projectRoot, authorizationId, storage) {
  return path.join(runtimeInvocationRecordDirectory(projectRoot, authorizationId, storage), "application.json");
}

export function normalizeRuntimeRunResultTextProjection({ outcome, planDelta, impactRadius, unknowns } = {}) {
  if (typeof outcome !== "string" || typeof planDelta !== "string"
    || !Array.isArray(impactRadius) || impactRadius.some((item) => typeof item !== "string")
    || !Array.isArray(unknowns) || unknowns.some((item) => typeof item !== "string")) {
    fail("Runtime Run result text projection is invalid.", "INVALID_RUNTIME_RUN_RESULT_APPLICATION");
  }
  return {
    outcome: outcome.trim(),
    planDelta: planDelta.trim(),
    impactRadius: impactRadius.map((item) => item.trim()),
    unknowns: unknowns.map((item) => item.trim()),
  };
}

function canonicalRunResultFields(record) {
  const { authorization, receipt, draft } = record;
  if (authorization.protocolVersion === "0.7.0"
    && isWorkerPatchProposalMode(authorization.workerInput?.executionBoundary?.mode)) {
    fail("A read-only patch proposal is not an applied Run result; use worker-integrate for HEAD application and whole-result verification.", "RUNTIME_PATCH_PROPOSAL_INTEGRATION_REQUIRED");
  }
  const lifecycleEvidence = draft.evidence[0];
  const lifecycleVerification = draft.verification[0];
  if (draft.scopeKind !== "run" || !draft.providerResult || draft.freshHeadReviewRequired !== true
    || receipt.status !== "completed" || receipt.exitCode !== 0
    || receipt.providerBoundary.actualProviderInvoked !== true
    || receipt.providerBoundary.structuredResultObserved !== true
    || receipt.processBoundary.descendantTreeOwnershipValidated !== true
    || lifecycleVerification.status !== "passed") {
    fail("Only a completed, native-supervised actual-provider Run result can enter canonical Execution Lineage.", "RUNTIME_RUN_RESULT_NOT_APPLICABLE");
  }
  const normalizedText = normalizeRuntimeRunResultTextProjection({
    outcome: draft.outcome,
    planDelta: draft.planDelta,
    impactRadius: draft.impactRadius,
    unknowns: draft.unknowns,
  });
  return {
    // Execution Lineage canonicalizes the user-facing text boundary before it
    // hashes a ResultPacket. Mirror that normalization here so harmless model
    // whitespace cannot make an otherwise exact verified draft conflict with
    // its canonical projection.
    outcome: normalizedText.outcome,
    evidence: [{
      kind: "RuntimeInvocationResultEvidence",
      runtime: authorization.runtime,
      authorizationId: draft.authorizationId,
      runtimeResultDraftId: draft.draftId,
      lifecycleReceiptId: draft.lifecycleReceiptId,
      executionLeaseConsumptionId: draft.executionLeaseConsumptionId,
      executionLeaseReleaseId: draft.executionLeaseReleaseId,
      eventIds: [...lifecycleEvidence.eventIds],
      eventTypes: [...lifecycleEvidence.eventTypes],
      providerDiagnosticCodes: [...(lifecycleEvidence.providerDiagnosticCodes || [])],
      providerSessionReferenceDigests: [...lifecycleEvidence.providerSessionReferenceDigests],
      structuredResultDigest: lifecycleEvidence.structuredResultDigest,
      providerEvidence: [...draft.providerResult.evidence],
      actualProviderInvoked: true,
      rawTranscriptIncluded: false,
      instructionAuthority: false,
    }],
    planDelta: normalizedText.planDelta,
    impactRadius: normalizedText.impactRadius,
    verification: [{
      kind: "RuntimeInvocationResultVerification",
      runtime: authorization.runtime,
      status: "passed",
      lifecycleReceiptId: draft.lifecycleReceiptId,
      projectFenceValidated: lifecycleVerification.projectFenceValidated,
      exactChildExitObserved: lifecycleVerification.exactChildExitObserved,
      descendantTreeOwnershipValidated: lifecycleVerification.descendantTreeOwnershipValidated,
      inputDigestMatched: lifecycleVerification.inputDigestMatched,
      providerVerification: [...draft.providerResult.verification],
    }],
    unknowns: normalizedText.unknowns,
    knowledgeProposals: [],
  };
}

function verifyCanonicalRunResultPacket(resultPacket, fields, authorization) {
  const packetFields = {
    outcome: resultPacket?.outcome,
    evidence: resultPacket?.evidence,
    planDelta: resultPacket?.planDelta,
    impactRadius: resultPacket?.impactRadius,
    verification: resultPacket?.verification,
    unknowns: resultPacket?.unknowns,
    knowledgeProposals: resultPacket?.knowledgeProposals,
  };
  const mismatchedFields = Object.keys(fields)
    .filter((field) => canonicalJson(packetFields[field]) !== canonicalJson(fields[field]));
  if (resultPacket?.kind !== "ResultPacket") mismatchedFields.push("kind");
  if (resultPacket?.executionContractId !== authorization.scope.executionContractId) mismatchedFields.push("executionContractId");
  if (mismatchedFields.length) {
    fail(`Canonical ResultPacket does not exactly match the verified runtime draft (fields: ${[...new Set(mismatchedFields)].sort(compareText).join(", ")}).`, "RUNTIME_RUN_RESULT_PACKET_CONFLICT");
  }
  return resultPacket;
}

function readRuntimeRunResultApplication(record) {
  const { projectRoot, authorizationId, authorization, receipt, draft } = record;
  const file = runResultApplicationFile(projectRoot, authorizationId, record.storage ?? originalFormat(authorization));
  if (!fs.existsSync(file)) return null;
  const application = verifyRuntimeRunResultApplication(JSON.parse(fs.readFileSync(file, "utf8")));
  if (application.authorizationId !== authorizationId || application.lifecycleReceiptId !== receipt.receiptId
    || application.draftId !== draft.draftId || application.runId !== draft.runId
    || application.executionContractId !== draft.executionContractId
    || authorization.scope.kind !== "run" || authorization.scope.runId !== application.runId
    || authorization.scope.executionContractId !== application.executionContractId) {
    fail("Runtime Run result application conflicts with its invocation lineage.", "RUNTIME_RUN_RESULT_APPLICATION_CONFLICT");
  }
  const resultPacket = readLineageArtifact({ root: projectRoot, artifactId: application.resultPacketId }).artifact;
  verifyCanonicalRunResultPacket(resultPacket, canonicalRunResultFields(record), authorization);
  const expectedReview = buildFreshHeadReview({
    root: projectRoot,
    wholePlanId: authorization.scope.wholePlanId,
    resultPacketId: resultPacket.resultPacketId,
    sessionId: sessionIdOf(authorization),
    runId: authorization.scope.runId,
  }).review;
  if (expectedReview.reviewContextId !== application.reviewContextId) {
    fail("Runtime Run result application does not match the deterministic Fresh HEAD context.", "RUNTIME_RUN_RESULT_APPLICATION_CONFLICT");
  }
  return application;
}

export function readRuntimeInvocationResult({ root = ".", authorizationId, storage } = {}) {
  const record = readRuntimeInvocationRecord({ root, authorizationId, storage });
  const application = readRuntimeRunResultApplication(record);
  return {
    status: record.status,
    authorizationId,
    receipt: record.receipt,
    draft: record.draft,
    events: record.events,
    application,
  };
}

export function applyRuntimeRunResult({ root = ".", authorizationId, storage } = {}) {
  // Reading the target before taking finishRun's lock leaves a scope race.
  // Keep record validation, exact target validation, Run/Session completion and
  // the application receipt in the same existing reentrant mutation scope.
  return withProjectMutation({ root, scope: "session-recovery" }, () => applyRuntimeRunResultLocked({ root, authorizationId, storage }));
}

function verifyApplicationProjectSession(record) {
  const inspected = inspectProject(record.projectRoot);
  const { authorization } = record;
  if (inspected.status !== "ready" || inspected.project.projectId !== authorization.projectId
    || inspected.state.sessionId !== sessionIdOf(authorization)
    || digest(fs.realpathSync(inspected.project.projectRoot)) !== authorization.projectRootDigest) {
    fail("Runtime result application requires its exact current Project and HEAD Session.", "RUNTIME_RUN_RESULT_APPLICATION_CONFLICT");
  }
  return inspected;
}

function verifyApplicationRun(record, inspected) {
  const { authorization, projectRoot } = record;
  const { state } = inspected;
  const scope = authorization.scope;
  const targetRunId = state.activeRunId || state.pendingReview?.runId;
  if (targetRunId !== scope.runId || state.currentWholePlanId !== scope.wholePlanId
    || state.activeRunId && (state.activeExecutionContractId !== scope.executionContractId || state.pendingReview)) {
    fail("Runtime result belongs to a different Run or ExecutionContract; current work was not changed.", "RUNTIME_RUN_RESULT_APPLICATION_CONFLICT");
  }
  const run = JSON.parse(fs.readFileSync(path.join(projectRoot, formatForVerifiedOwner(inspected).directory, "sessions", "runs", scope.runId, "run.json"), "utf8"));
  assertRunSession(projectRoot, run, inspected.state);
  const contract = readLineageArtifact({ root: projectRoot, artifactId: scope.executionContractId }).artifact;
  const plan = readLineageArtifact({ root: projectRoot, artifactId: scope.wholePlanId }).artifact;
  const capsule = readContextCapsule({ root: projectRoot, capsuleId: scope.contextCapsuleId }).capsule;
  if (run.runId !== scope.runId || !["active", "awaiting_review"].includes(run.status)
    || run.executionContractId !== scope.executionContractId || run.wholePlanId !== scope.wholePlanId
    || run.capsuleId !== scope.contextCapsuleId || contract.kind !== "ExecutionContract"
    || contract.wholePlanId !== scope.wholePlanId || contract.capsuleId !== capsule.capsuleId
    || plan.kind !== "WholePlanSnapshot"
    || !state.activeRunId && (run.status !== "awaiting_review"
      || state.pendingReview.wholePlanId !== run.wholePlanId || state.pendingReview.resultPacketId !== run.resultPacketId)) {
    fail("Runtime result target does not match its exact canonical execution lineage.", "RUNTIME_RUN_RESULT_APPLICATION_CONFLICT");
  }
}

function applyRuntimeRunResultLocked({ root, authorizationId, storage }) {
  const record = readRuntimeInvocationRecord({ root, authorizationId, storage });
  const { projectRoot, authorization } = record;
  const inspected = verifyApplicationProjectSession(record);
  if (authorization.scope.kind !== "run"
    || authorization.scope.runId !== record.draft.runId
    || authorization.scope.executionContractId !== record.draft.executionContractId) {
    fail("Runtime invocation is not the exact authorized Run.", "RUNTIME_RUN_AUTHORIZATION_REQUIRED");
  }
  const fields = canonicalRunResultFields(record);
  const existingApplication = readRuntimeRunResultApplication(record);
  if (existingApplication) {
    const resultPacket = readLineageArtifact({ root: projectRoot, artifactId: existingApplication.resultPacketId }).artifact;
    verifyCanonicalRunResultPacket(resultPacket, fields, authorization);
    return {
      status: "runtime_run_result_already_applied",
      authorizationId,
      application: existingApplication,
      resultPacket,
      freshHeadReview: null,
      canonicalCommit: "committed",
      executionReplayAllowed: false,
      projectionUpdate: { status: "not-requested", ordinaryWorkBlocked: false },
    };
  }

  verifyApplicationRun(record, inspected);
  const finished = finishRun({ root: projectRoot, ...fields });
  const resultPacket = finished.resultPacket;
  const freshHead = getPendingReviewContext({ root: projectRoot });
  verifyCanonicalRunResultPacket(resultPacket, fields, authorization);
  if (freshHead.pendingReview.runId !== authorization.scope.runId
    || freshHead.pendingReview.resultPacketId !== resultPacket.resultPacketId
    || freshHead.review.reviewContextId === "") {
    fail("Fresh HEAD review does not match the applied runtime Run result.", "RUNTIME_RUN_RESULT_APPLICATION_CONFLICT");
  }
  const application = verifyRuntimeRunResultApplication(identifyApplication({
    schemaVersion: 1,
    kind: "RuntimeRunResultApplication",
    protocolVersion: RUNTIME_RUN_RESULT_APPLICATION_VERSION,
    authorizationId,
    lifecycleReceiptId: record.receipt.receiptId,
    draftId: record.draft.draftId,
    runId: authorization.scope.runId,
    executionContractId: authorization.scope.executionContractId,
    resultPacketId: resultPacket.resultPacketId,
    reviewContextId: freshHead.review.reviewContextId,
    status: "run-result-applied-awaiting-review",
    freshHeadReviewRequired: true,
    rawTranscriptIncluded: false,
    authority: "execution-lineage-application-evidence",
    instructionAuthority: false,
    promotionAuthority: false,
    mutatesCanon: false,
  }));
  const applicationFile = runResultApplicationFile(projectRoot, authorizationId, record.storage ?? originalFormat(authorization));
  try {
    writeRuntimeInvocationArtifactExclusive(applicationFile, prettyJson(application));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const concurrent = readRuntimeInvocationResult({ root: projectRoot, authorizationId, storage: record.storage ?? originalFormat(authorization) }).application;
    if (!concurrent || concurrent.applicationId !== application.applicationId) {
      fail("Concurrent runtime Run result application diverged.", "RUNTIME_RUN_RESULT_APPLICATION_CONFLICT");
    }
  }
  return {
    status: "runtime_run_result_applied",
    authorizationId,
    application,
    resultPacket,
    freshHeadReview: freshHead.review,
    canonicalCommit: finished.canonicalCommit,
    executionReplayAllowed: false,
    projectionUpdate: finished.projectionUpdate,
  };
}
