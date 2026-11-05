import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
const sessionIdOf = record => {
  const format = familyFormatForOriginal({ sessionIdentity: true }, record);
  return format ? record?.[format.sessionIdField] : undefined;
};
const originalFormat = record => familyFormatForOriginal({ kind: record?.kind }, record);
const lineageFormat = record => familyFormatForOriginal({ sessionIdentity: true }, record);
import fs from "node:fs";
import path from "node:path";
import { assertRunSession } from "./session-routing.mjs";
import { artifactAuthorityBoundary, verifyArtifactAuthorityBoundary } from "./authority-plane-contract.mjs";
import { inspectProject } from "./lode-core.mjs";
import { buildFreshHeadReview, createResultPacket, readLineageArtifact } from "./execution-lineage.mjs";
import { finishRun, getPendingReviewContext, inspectRunStorageTransition } from "./run-lineage.mjs";
import { withProjectMutationAsync } from "./project-mutation-lock.mjs";
import { readWorkerPatchIntegration, requireCurrentWorkerPatchIntegration } from "./worker-patch-integration.mjs";
import { readWorkerIntegrationBasis } from "./worker-integration-basis.mjs";
import { readWorkerPatchApplicationEvidence } from "./worker-integration-application.mjs";
import { integrationDigest as digest, integrationJson as json, workerIntegrationDirectory,
  readIntegrationBytes, publishIntegrationJson } from "./worker-integration-store.mjs";

const fail = (message, code = "WORKER_INTEGRATION_RESULT_CONFLICT") => { throw Object.assign(new Error(message), { code }); };
const same = (left, right) => json(left) === json(right);
const flags = { instructionAuthority: false, promotionAuthority: false, recoveryAuthority: false,
  reviewDecisionCreated: false, mutatesCanon: false };
const packetFields = ["outcome", "evidence", "planDelta", "impactRadius", "verification", "unknowns", "knowledgeProposals"];
const packetInput = packet => Object.fromEntries(packetFields.map(key => [key, packet[key]]));
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function fields(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !same(Object.keys(value).sort(), [...names].sort())) fail("Invalid integration result record fields.");
}
function identify(payload, prefix, idField, hashField) {
  const hash = digest(json(payload));
  return { ...payload, [idField]: `${prefix}-${hash.slice(0, 24)}`, [hashField]: hash };
}
function assertIdentity(document, kind, prefix, idField, hashField) {
  const payload = { ...document };
  delete payload[idField]; delete payload[hashField];
  if (document.kind !== kind || document.protocolVersion !== "0.1.0"
    || !same(Object.fromEntries(Object.keys(flags).map(key => [key, document[key]])), flags)
    || !same(identify(payload, prefix, idField, hashField), document)) fail("Integration result identity or authority differs.");
  verifyArtifactAuthorityBoundary(kind, document.authorityBoundary);
}
function fileFor(root, integrationId, suffix, create = false, storage) {
  if (!/^worker-integration-[a-f0-9]{24}--[a-f0-9]{24}$/.test(integrationId || "")) fail("Invalid integration identity.");
  if (suffix !== "result-application" && !/^worker-integration-verification-[a-f0-9]{24}$/.test(suffix || "")) fail("Invalid integration result suffix.");
  return path.join(workerIntegrationDirectory(root, create, storage), `${integrationId}--${suffix}.json`);
}
function membersFor(intent) {
  return intent.members.map(({ candidate, ...member }) => ({ ...member,
    candidateId: candidate.candidateId, candidateHash: candidate.candidateHash }));
}
function normalizedReport({ outcome, evidence, verification, planDelta = "", impactRadius = [], unknowns = [] }) {
  const records = (value, label) => {
    if (!Array.isArray(value) || !value.length || value.some(item => !item || typeof item !== "object" || Array.isArray(item))) fail(`HEAD ${label} must be nonempty records.`);
    // JSON is evidence data, never an executable instruction or approval.
    return JSON.parse(json(value));
  };
  const texts = value => {
    if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) fail("HEAD report lists require nonempty text.");
    return value.map(item => item.trim());
  };
  if (typeof outcome !== "string" || !outcome.trim() || typeof planDelta !== "string") fail("HEAD outcome and plan delta require text.");
  return { outcome: outcome.trim(), evidence: records(evidence, "evidence"), verification: records(verification, "verification"),
    planDelta: planDelta.trim(), impactRadius: texts(impactRadius), unknowns: texts(unknowns) };
}
const reference = record => record ? { recordId: record.recordId, recordHash: record.recordHash } : null;
function effectEvidence(application) {
  const complete = application.status === "applied" && application.allEffectsCompleted === true;
  const incomplete = application.status === "incomplete" && application.allEffectsCompleted === false && !!application.settlement;
  if (!application.claim || application.outstanding !== false || !complete && !incomplete || complete && application.settlement
    || application.effectResults.some(effect => (effect.attempts || []).some(attempt => attempt.receipt?.ownerQuiescent !== true))) {
    fail("Whole-result publication needs completed or explicitly settled quiescent effects.", "WORKER_INTEGRATION_EFFECTS_INCOMPLETE");
  }
  return { disposition: complete ? "complete" : "settled-incomplete", claim: reference(application.claim),
    settlement: application.settlement ? { ...reference(application.settlement), basisDigest: application.settlement.basisDigest } : null,
    effects: application.effectResults.map(effect => ({ index: effect.index, path: effect.path, status: effect.status,
      attempts: effect.attempts.map(attempt => ({ attemptNumber: attempt.attemptNumber, status: attempt.status,
        started: reference(attempt.started), receipt: reference(attempt.receipt),
        ownerQuiescent: attempt.receipt?.ownerQuiescent ?? false, nativeStatus: attempt.receipt?.nativeStatus ?? null,
        initialReceipt: reference(attempt.initialReceipt), reconciliationReceipt: reference(attempt.reconciliationReceipt) })) })) };
}
function dependencyObservations(basis) {
  return basis.dependencies.map(entry => ({ path: entry.path, status: entry.status, observed: entry.observed,
    originals: entry.originals, changedDuringObservation: entry.changedDuringObservation, isEffectTarget: !!entry.expectedEffect }));
}
const basisObservation = basis => ({ observationStable: basis.observationStable,
  allDependenciesObservable: basis.allDependenciesObservable, observation: basis.observation });
function observationUnknowns(document) {
  return document.dependencyObservations.filter(entry => entry.observed.kind === "unverifiable" || entry.changedDuringObservation)
    .map(entry => `Read dependency ${entry.path} was ${entry.observed.kind === "unverifiable" ? `unobservable (${entry.observed.code})` : "changing during observation"}; retained as unknown evidence.`);
}
function resultFields(document) {
  const report = document.headReport;
  return { outcome: report.outcome, planDelta: report.planDelta, impactRadius: report.impactRadius,
    unknowns: [...report.unknowns, ...observationUnknowns(document)],
    knowledgeProposals: [], evidence: [{ kind: "WorkerIntegrationResultEvidence", integrationId: document.integrationId,
      integrationHash: document.integrationHash, lineage: document.lineage, memberProvenance: document.memberProvenance,
      effectDisposition: document.effectDisposition, effectEvidence: document.effectEvidence, dependencyObservations: document.dependencyObservations,
      basisObservation: document.basisObservation,
      basisDigest: document.basisDigest, headReportDigest: digest(json(report)), evidence: report.evidence, ...flags }],
    verification: [{ kind: lineageFormat(document.lineage).kind("HeadWorkerIntegrationVerification"), basisDigest: document.basisDigest,
      headReportDigest: digest(json(report)), checks: report.verification,
      semanticAssessmentOwner: lineageFormat(document.lineage).roleField, compilerSufficiencyClaimed: false, ...flags }] };
}

export function verifyWorkerIntegrationVerification(document) {
  fields(document, ["kind", "protocolVersion", "authorityBoundary", "integrationId", "integrationHash", "lineage",
    "memberProvenance", "basisDigest", "observedBasisDigest", "effectDisposition", "effectEvidence", "dependencyObservations", "basisObservation", "headReport", "wholeResultPacket", ...Object.keys(flags), "verificationId", "verificationHash"]);
  assertIdentity(document, "WorkerIntegrationVerification", "worker-integration-verification", "verificationId", "verificationHash");
  if (!lineageFormat(document.lineage) || !validHash(document.basisDigest) || !validHash(document.observedBasisDigest)
    || !same(normalizedReport(document.headReport), document.headReport) || !Array.isArray(document.dependencyObservations)
    || !["complete", "settled-incomplete"].includes(document.effectDisposition)
    || document.effectDisposition !== document.effectEvidence?.disposition
    || typeof document.basisObservation?.allDependenciesObservable !== "boolean" || typeof document.basisObservation?.observationStable !== "boolean"
    || document.dependencyObservations.some(entry => !entry || typeof entry.path !== "string" || typeof entry.status !== "string"
      || !Array.isArray(entry.originals) || typeof entry.isEffectTarget !== "boolean" || typeof entry.changedDuringObservation !== "boolean"
      || !["file", "absent", "unverifiable"].includes(entry.observed?.kind))) fail("Invalid frozen HEAD verification.");
  const packet = document.wholeResultPacket;
  if (!packet || packet.kind !== "ResultPacket" || packet.projectId !== document.lineage.projectId
    || packet.executionContractId !== document.lineage.executionContractId || !same(packetInput(packet), resultFields(document))) fail("Frozen whole ResultPacket differs from HEAD verification.");
  verifyArtifactAuthorityBoundary("ResultPacket", packet.authorityBoundary);
  const { resultPacketId, artifactHash, ...payload } = packet;
  if (artifactHash !== digest(json(payload)) || resultPacketId !== `result-packet-${artifactHash.slice(0, 24)}`
    || packet.recoveryAuthority !== false || packet.canonMutationAuthority !== false || packet.reviewDecisionCreated !== false) fail("Frozen ResultPacket digest or authority differs.");
  return document;
}
function readVerification(root, intent, verificationId) {
  const document = verifyWorkerIntegrationVerification(JSON.parse(readIntegrationBytes(fileFor(root, intent.integrationId, verificationId, false, lineageFormat(intent.lineage)))));
  if (document.verificationId !== verificationId || document.integrationId !== intent.integrationId
    || document.integrationHash !== intent.integrationHash || !same(document.lineage, intent.lineage)
    || !same(document.memberProvenance, membersFor(intent))) fail("HEAD verification belongs to different integration provenance.");
  const application = readWorkerPatchApplicationEvidence({ root, integrationId: intent.integrationId, storage: lineageFormat(intent.lineage) });
  if (!same(document.effectEvidence, effectEvidence(application))) fail("Frozen verification differs from exact stored effect and settlement evidence.");
  return document;
}
function requireBasis(intent, basis, expectedDigest) {
  const impactSafe = basis?.dependencies?.filter(entry => entry.expectedEffect)
    .every(entry => !entry.changedDuringObservation && entry.observed.kind !== "unverifiable");
  if (!basis || basis.lineageVerified !== true || basis.integrationId !== intent.integrationId
    || basis.integrationHash !== intent.integrationHash || !same(basis.lineage, intent.lineage)
    || !impactSafe || basis.basisDigest !== expectedDigest) {
    fail("Current impact targets or observed basis changed; reassess the current basis and prepare a new HEAD verification.", "WORKER_INTEGRATION_REVERIFICATION_REQUIRED");
  }
  // Effect settlement is independent of semantic sufficiency. In either
  // disposition, an unobservable read-only dependency stays explicit unknown
  // evidence, never invented bytes or a permanent failure-reporting gate.
  // Only actual patch targets require stable observable current images; no-op
  // ownership and semantic HEAD prose cannot manufacture new effect gates.
}
async function applicationFor(input, inspection) {
  const read = inspection.readApplication || (await import("./worker-integration-application.mjs")).readWorkerPatchApplication;
  return read(input);
}
async function requireSettledApplication(root, intent, basisDigest, inspection) {
  const application = await applicationFor({ root, integrationId: intent.integrationId, storage: lineageFormat(intent.lineage) }, inspection);
  // Caller prose, a test observation hook, or an allEffectsCompleted boolean
  // cannot substitute for the stored exact claim/attempt/receipt/settlement.
  const stored = readWorkerPatchApplicationEvidence({ root, integrationId: intent.integrationId, storage: lineageFormat(intent.lineage) });
  const effects = effectEvidence(stored);
  if (!same(application.intent, intent) || !same(effectEvidence(application), effects)) fail("Observed effects differ from exact stored evidence.");
  requireBasis(intent, application.currentBasis, basisDigest);
  const basis = readWorkerIntegrationBasis({ root, integrationId: intent.integrationId, storage: lineageFormat(intent.lineage) });
  requireBasis(intent, basis, basisDigest);
  return { effects, basis };
}

// Explicit HEAD assessment, not a user approval gate. A changed observation gets
// a new immutable verification; no stale candidate reserves publication forever.
export async function prepareWorkerIntegrationResult({ root = ".", integrationId, basisDigest, storage, ...report } = {}, inspection = {}) {
  if (Object.hasOwn(report, "effectDisposition") || Object.hasOwn(report, "effectEvidence")) fail("Effect disposition is derived from stored evidence, not caller-selected.");
  return withProjectMutationAsync({ root, scope: "session-recovery" }, async () => {
    const intent = requireCurrentWorkerPatchIntegration({ root, integrationId, storage });
    const { effects } = await requireSettledApplication(root, intent, basisDigest, inspection);
    const headReport = normalizedReport(report);
    const basis = readWorkerIntegrationBasis({ root, integrationId, storage });
    requireBasis(intent, basis, basisDigest);
    const payload = { kind: "WorkerIntegrationVerification", protocolVersion: "0.1.0",
      authorityBoundary: artifactAuthorityBoundary("WorkerIntegrationVerification"),
      integrationId, integrationHash: intent.integrationHash, lineage: intent.lineage, memberProvenance: membersFor(intent),
      basisDigest, observedBasisDigest: basis.observedBasisDigest, effectDisposition: effects.disposition, effectEvidence: effects,
      dependencyObservations: dependencyObservations(basis), basisObservation: basisObservation(basis), headReport, ...flags };
    const wholeResultPacket = createResultPacket({ root, executionContractId: intent.lineage.executionContractId,
      ...resultFields(payload), persist: false }).artifact;
    const document = verifyWorkerIntegrationVerification(identify({ ...payload, wholeResultPacket },
      "worker-integration-verification", "verificationId", "verificationHash"));
    // Recheck after the only asynchronous boundary; no source or P2 mutation is
    // authorized by the observation or by its semantic-assessment prose.
    requireCurrentWorkerPatchIntegration({ root, integrationId, storage });
    requireBasis(intent, readWorkerIntegrationBasis({ root, integrationId, storage }), basisDigest);
    const created = publishIntegrationJson(fileFor(root, integrationId, document.verificationId, true, lineageFormat(intent.lineage)), document);
    return { status: created ? "prepared" : "existing", verification: document, resultPacketPublished: false, ...flags };
  });
}

function readApplication(root, intent) {
  const file = fileFor(root, intent.integrationId, "result-application", false, lineageFormat(intent.lineage));
  if (!fs.existsSync(file)) return null;
  const application = JSON.parse(readIntegrationBytes(file));
  fields(application, ["kind", "protocolVersion", "authorityBoundary", "integrationId", "integrationHash", "lineage",
    "verificationId", "verificationHash", "resultPacketId", "reviewContextId", "reviewContextHash", "status", "freshHeadReviewRequired",
    ...Object.keys(flags), "applicationId", "applicationHash"]);
  assertIdentity(application, "WorkerIntegrationResultApplication", "worker-integration-result-application", "applicationId", "applicationHash");
  const verification = readVerification(root, intent, application.verificationId);
  if (application.integrationId !== intent.integrationId || application.integrationHash !== intent.integrationHash
    || !same(application.lineage, intent.lineage) || application.verificationHash !== verification.verificationHash
    || application.resultPacketId !== verification.wholeResultPacket.resultPacketId
    || application.status !== "whole-result-published-awaiting-review" || application.freshHeadReviewRequired !== true
    || !validHash(application.reviewContextHash) || application.reviewContextId !== `${lineageFormat(intent.lineage).value("fresh-head-review")}-${application.reviewContextHash.slice(0, 24)}`) fail("Integration result receipt differs from its frozen provenance.");
  const resultPacket = readLineageArtifact({ root, artifactId: application.resultPacketId }).artifact;
  if (!same(resultPacket, verification.wholeResultPacket)) fail("Published ResultPacket differs from frozen whole result.");
  const run = JSON.parse(readIntegrationBytes(path.join(fs.realpathSync(root), lineageFormat(intent.lineage).directory, "sessions/runs", intent.lineage.runId, "run.json")));
  if (run.runId !== intent.lineage.runId || run.resultPacketId !== resultPacket.resultPacketId
    || run.wholePlanId !== intent.lineage.wholePlanId || run.executionContractId !== intent.lineage.executionContractId
    || run.capsuleId !== intent.lineage.contextCapsuleId || !["awaiting_review", "reviewed"].includes(run.status)) fail("Published whole result differs from its historical Run.");
  const historicalReview = buildFreshHeadReview({ root, wholePlanId: intent.lineage.wholePlanId,
    resultPacketId: resultPacket.resultPacketId, sessionId: sessionIdOf(intent.lineage), runId: intent.lineage.runId, historical: true }).review;
  if (historicalReview.reviewContextId !== application.reviewContextId
    || historicalReview.reviewContextHash !== application.reviewContextHash) fail("Publication receipt references a different historical Fresh HEAD review.");
  return { application, verification, resultPacket };
}

// Immutable historical receipts need no current source/provider, same Session
// pointer or role-projection readiness. Selected Session record integrity checks
// still apply through existing readers. This cannot finish another Run.
export function readWorkerIntegrationResult({ root = ".", integrationId, verificationId, storage } = {}) {
  const { intent } = readWorkerPatchIntegration({ root, integrationId, storage });
  const existing = readApplication(root, intent);
  if (existing) {
    if (verificationId && verificationId !== existing.verification.verificationId) fail("Publication already selected a different exact HEAD verification.");
    return { status: "published", intent, ...existing, ...flags };
  }
  return { status: verificationId ? "prepared" : "not-published", intent, application: null,
    verification: verificationId ? readVerification(root, intent, verificationId) : null, resultPacket: null, ...flags };
}

function currentTarget(root, intent, packet) {
  const inspected = inspectProject(root);
  const { lineage } = intent;
  const state = inspected.state;
  if (inspected.status !== "ready" || inspected.project.projectId !== lineage.projectId
    || digest(fs.realpathSync(inspected.project.projectRoot)) !== lineage.projectRootDigest
    || state.sessionId !== sessionIdOf(lineage) || (state.activeRunId || state.pendingReview?.runId) !== lineage.runId
    || state.currentWholePlanId !== lineage.wholePlanId
    || state.activeRunId && (state.mode !== "run" || state.pendingReview || state.activeExecutionContractId !== lineage.executionContractId)
    || !state.activeRunId && (state.mode !== "review" || state.activeExecutionContractId)) fail("Whole result belongs to a different current Run or HEAD Session; current work was not changed.");
  const run = JSON.parse(readIntegrationBytes(path.join(inspected.project.projectRoot, formatForVerifiedOwner(inspected).directory, "sessions/runs", lineage.runId, "run.json")));
  assertRunSession(inspected.project.projectRoot, run, state);
  if (run.runId !== lineage.runId || !["active", "awaiting_review"].includes(run.status)
    || run.wholePlanId !== lineage.wholePlanId || run.executionContractId !== lineage.executionContractId || run.capsuleId !== lineage.contextCapsuleId
    || run.resultPacketId && run.resultPacketId !== packet.resultPacketId
    || !state.activeRunId && (run.status !== "awaiting_review" || state.pendingReview.wholePlanId !== lineage.wholePlanId
      || state.pendingReview.resultPacketId !== packet.resultPacketId || run.resultPacketId !== packet.resultPacketId)) fail("Whole result target differs from exact Run canon.");
  if (run.sessionTransition?.kind === "start") {
    const storage = inspectRunStorageTransition({ root, inspected });
    if (storage.status !== "committed" || storage.runId !== lineage.runId) fail("Run start storage is not exact and committed.");
  } else if (run.sessionTransition && (run.sessionTransition.kind !== "finish" || run.sessionTransition.artifactId !== packet.resultPacketId
    || run.sessionTransition.projectId !== lineage.projectId || run.sessionTransition.sessionId !== sessionIdOf(lineage)
    || run.sessionTransition.runId !== lineage.runId)) fail("Run already froze a different exact result transition.");
  if (run.status === "awaiting_review" && !run.sessionTransition) fail("Completed result lacks its exact finish transition.");
  return { replay: run.sessionTransition?.kind === "finish" };
}

export async function publishWorkerIntegrationResult({ root = ".", integrationId, verificationId, storage } = {}, inspection = {}) {
  return withProjectMutationAsync({ root, scope: "session-recovery" }, async () => {
    const historical = readWorkerIntegrationResult({ root, integrationId, verificationId, storage });
    if (historical.application) return { ...historical, status: "already-published", freshHeadReview: null,
      canonicalCommit: "committed", executionReplayAllowed: false, projectionUpdate: { status: "not-requested", ordinaryWorkBlocked: false } };
    const { intent, verification } = historical;
    if (!verification) fail("An exact HEAD integration verification is required.");
    const packet = verification.wholeResultPacket;
    const target = currentTarget(root, intent, packet);
    if (!target.replay) {
      requireCurrentWorkerPatchIntegration({ root, integrationId, storage });
      const { effects, basis } = await requireSettledApplication(root, intent, verification.basisDigest, inspection);
      if (!same(effects, verification.effectEvidence)) fail("Effect evidence changed after HEAD assessment; prepare a new verification.");
      if (verification.observedBasisDigest !== basis.observedBasisDigest
        || !same(verification.dependencyObservations, dependencyObservations(basis))
        || !same(verification.basisObservation, basisObservation(basis))) {
        fail("Frozen machine observations differ from the current verified basis; prepare a new HEAD verification.", "WORKER_INTEGRATION_REVERIFICATION_REQUIRED");
      }
      requireCurrentWorkerPatchIntegration({ root, integrationId, storage });
      currentTarget(root, intent, packet);
    }
    // The existing Run transition freezes this exact packet before canonical
    // publication. Its retry checks own the partial P2 repair, not this P3 file.
    // Once frozen, later source drift does not invalidate historical recovery.
    const preview = createResultPacket({ root, executionContractId: intent.lineage.executionContractId,
      ...packetInput(packet), persist: false }).artifact;
    if (!same(preview, packet)) fail("Frozen packet no longer matches its exact canonical projection.");
    // finishRun prepares its P2 transition before publishing a new packet. If
    // this content-addressed packet already exists, reject tamper first, rather
    // than leaving a prepared transition merely because existing evidence broke.
    try {
      const existing = readLineageArtifact({ root, artifactId: packet.resultPacketId }).artifact;
      if (!same(existing, packet)) fail("Existing ResultPacket differs from frozen whole result.");
    } catch (error) { if (error.code !== "LINEAGE_ARTIFACT_NOT_FOUND") throw error; }
    const result = finishRun({ root, ...packetInput(packet) });
    if (!same(result.resultPacket, packet)) fail("Run completion differs from the frozen whole ResultPacket.");
    const fresh = getPendingReviewContext({ root });
    if (fresh.pendingReview.runId !== intent.lineage.runId || fresh.pendingReview.resultPacketId !== packet.resultPacketId
      || fresh.pendingReview.wholePlanId !== intent.lineage.wholePlanId) fail("Fresh HEAD review differs from whole integration result.");
    const application = identify({ kind: "WorkerIntegrationResultApplication", protocolVersion: "0.1.0",
      authorityBoundary: artifactAuthorityBoundary("WorkerIntegrationResultApplication"),
      integrationId, integrationHash: intent.integrationHash, lineage: intent.lineage,
      verificationId: verification.verificationId, verificationHash: verification.verificationHash,
      resultPacketId: packet.resultPacketId, reviewContextId: fresh.review.reviewContextId, reviewContextHash: fresh.review.reviewContextHash,
      status: "whole-result-published-awaiting-review", freshHeadReviewRequired: true, ...flags },
    "worker-integration-result-application", "applicationId", "applicationHash");
    publishIntegrationJson(fileFor(root, integrationId, "result-application", true, lineageFormat(intent.lineage)), application);
    return { status: "published", intent, application, verification, resultPacket: packet, freshHeadReview: fresh.review,
      canonicalCommit: result.canonicalCommit, projectionUpdate: result.projectionUpdate, executionReplayAllowed: false, ...flags };
  });
}
