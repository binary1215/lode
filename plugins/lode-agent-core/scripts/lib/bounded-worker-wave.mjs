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
import { artifactAuthorityBoundary, verifyArtifactAuthorityBoundary } from "./authority-plane-contract.mjs";
import { readBoundedWorkerDispatch } from "./bounded-worker-dispatch.mjs";
import { readContextCapsule } from "./context-compiler.mjs";
import { readLineageArtifact } from "./execution-lineage.mjs";
import { inspectProject } from "./lode-core.mjs";
import { inspectRuntimeExecutionLease } from "./runtime-execution-lease.mjs";
import { readWorkerAdmissionProjection } from "./worker-admission.mjs";
import { readRuntimeInvocationResult } from "./runtime-run-result-application.mjs";
import { writeRuntimeInvocationArtifactExclusive } from "./runtime-invocation-record.mjs";

export const BOUNDED_WORKER_WAVE_VERSION = "0.1.0";

const MAX_WAVE_MEMBERS = 64;
const ABANDON_REASON_CODES = new Set([
  "partial-launch",
  "lineage-drift",
  "operator-stop",
  "unrecoverable-member",
  "other",
]);

const fail = (message, code = "BOUNDED_WORKER_WAVE_ERROR") => {
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
const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;
const compareText = (left, right) => left.localeCompare(right, "en");

function assertExactFields(value, fields, label, code = "INVALID_BOUNDED_WORKER_WAVE") {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...fields].sort())) {
    fail(`${label} fields are invalid.`, code);
  }
}

function identify(payload, { prefix, idKey, hashKey }) {
  const hash = digest(canonicalJson(payload));
  return { ...payload, [idKey]: `${prefix}-${hash.slice(0, 24)}`, [hashKey]: hash };
}

function verifyIdentity(document, { prefix, idKey, hashKey, code }) {
  const payload = { ...document };
  const id = payload[idKey];
  const hash = payload[hashKey];
  delete payload[idKey];
  delete payload[hashKey];
  const expected = identify(payload, { prefix, idKey, hashKey });
  if (id !== expected[idKey] || hash !== expected[hashKey]) fail("Bounded worker wave identity is invalid.", code);
}

function ready(root, action) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") fail(`Project must be ready before ${action}; current status: ${inspected.status}.`, "PROJECT_NOT_READY");
  return inspected;
}

function waveDirectory(root, storage) {
  return path.join(root, formatForVerifiedOwner(storage).directory, "runtime", "worker-waves");
}

function requireWaveId(waveId) {
  if (!/^bounded-worker-wave-[a-f0-9]{24}$/.test(waveId || "")) {
    fail("Bounded worker wave id is invalid.", "INVALID_BOUNDED_WORKER_WAVE_ID");
  }
  return waveId;
}

function waveFile(root, waveId, storage) {
  return path.join(waveDirectory(root, storage), `${requireWaveId(waveId)}.json`);
}

function terminalFile(root, waveId, storage) {
  return path.join(waveDirectory(root, storage), `${requireWaveId(waveId)}.terminal.json`);
}

function readJson(file, label, code) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`${label} is invalid JSON: ${error.message}`, code); }
}

function currentLineage(inspected) {
  const root = inspected.project.projectRoot;
  const state = inspected.state;
  if (!state.activeRunId || !state.currentWholePlanId || !state.activeExecutionContractId) {
    fail("Bounded worker wave requires one exact active contract-bound Run.", "BOUNDED_WORKER_WAVE_RUN_CONFLICT");
  }
  const runPath = path.join(root, formatForVerifiedOwner(inspected).directory, "sessions", "runs", state.activeRunId, "run.json");
  const run = readJson(runPath, "Active Run", "INVALID_BOUNDED_WORKER_WAVE_LINEAGE");
  assertRunSession(root, run, state);
  if (run.status !== "active" || run.runId !== state.activeRunId || run.wholePlanId !== state.currentWholePlanId
    || run.executionContractId !== state.activeExecutionContractId || !/^capsule-[a-f0-9]{24}$/.test(run.capsuleId || "")) {
    fail("Active Run does not match the canonical Session pointer.", "BOUNDED_WORKER_WAVE_LINEAGE_DRIFT");
  }
  const plan = readLineageArtifact({ root, artifactId: run.wholePlanId }).artifact;
  const contract = readLineageArtifact({ root, artifactId: run.executionContractId }).artifact;
  const capsule = readContextCapsule({ root, capsuleId: run.capsuleId }).capsule;
  if (plan.kind !== "WholePlanSnapshot" || contract.kind !== "ExecutionContract"
    || contract.wholePlanId !== plan.wholePlanId || contract.capsuleId !== capsule.capsuleId) {
    fail("Run plan, contract, or Context Capsule lineage is inconsistent.", "BOUNDED_WORKER_WAVE_LINEAGE_DRIFT");
  }
  return {
    projectId: inspected.project.projectId,
    [formatForVerifiedOwner(inspected).sessionIdField]: state.sessionId,
    sessionPointerHash: digest(canonicalJson(state)),
    runId: run.runId,
    runHash: digest(canonicalJson(run)),
    wholePlanId: plan.wholePlanId,
    executionContractId: contract.executionContractId,
    contextCapsuleId: capsule.capsuleId,
    contextCapsuleHash: capsule.capsuleHash,
  };
}

function verifyLineageMatches(wave, inspected) {
  const current = currentLineage(inspected);
  const fields = [
    "projectId", formatForVerifiedOwner(inspected).sessionIdField, "runId", "runHash", "wholePlanId",
    "executionContractId", "contextCapsuleId", "contextCapsuleHash",
  ];
  if (fields.some((field) => wave[field] !== current[field])) {
    fail("Bounded worker wave is stale against the current Session/Run/plan/contract/Capsule lineage.", "BOUNDED_WORKER_WAVE_LINEAGE_DRIFT");
  }
  return current;
}

function memberFromDispatch(dispatch) {
  return {
    authorizationId: dispatch.authorizationId,
    authorizationHash: dispatch.authorizationHash,
    dispatchId: dispatch.dispatchId,
    dispatchHash: dispatch.dispatchHash,
    workerRole: dispatch.workerRole,
    runtime: dispatch.runtime,
  };
}

function memberMatchesDispatch(member, dispatch) {
  return canonicalJson(member) === canonicalJson(memberFromDispatch(dispatch));
}

function normalizeAuthorizationIds(values) {
  if (!Array.isArray(values) || values.length < 2 || values.length > MAX_WAVE_MEMBERS) {
    fail(`Bounded worker wave requires between 2 and ${MAX_WAVE_MEMBERS} authorization ids.`, "INVALID_BOUNDED_WORKER_WAVE_MEMBERS");
  }
  const normalized = values.map((value) => String(value || "").trim());
  if (normalized.some((value) => !/^execution-authorization-[a-f0-9]{24}$/.test(value))) {
    fail("Bounded worker wave contains an invalid authorization id.", "INVALID_BOUNDED_WORKER_WAVE_MEMBERS");
  }
  if (new Set(normalized).size !== normalized.length) {
    fail("Bounded worker wave cannot reuse one authorization or dispatch.", "BOUNDED_WORKER_WAVE_DUPLICATE_MEMBER");
  }
  return normalized.sort(compareText);
}

export function verifyBoundedWorkerWave(document) {
  const format = familyFormatForOriginal("head-agent-core-bounded-worker-wave", document);
  const fields = [
    "schemaVersion", "kind", "protocol", "authorityBoundary", "projectId", (format?.sessionIdField || "headSessionId"),
    "sessionPointerHash", "runId", "runHash", "wholePlanId", "executionContractId", "contextCapsuleId",
    "contextCapsuleHash", "members", "waveBoundary", "authority", "recoveryAuthority", "instructionAuthority",
    "reviewAuthority", "promotionAuthority", "mutatesCanon", "waveId", "waveHash",
  ];
  assertExactFields(document, fields, "BoundedWorkerWave");
  verifyArtifactAuthorityBoundary("BoundedWorkerWave", document.authorityBoundary);
  if (!Array.isArray(document.members) || document.members.length < 2 || document.members.length > MAX_WAVE_MEMBERS) {
    fail("BoundedWorkerWave member count is invalid.", "INVALID_BOUNDED_WORKER_WAVE");
  }
  const memberFields = ["authorizationId", "authorizationHash", "dispatchId", "dispatchHash", "workerRole", "runtime"];
  for (const member of document.members) {
    assertExactFields(member, memberFields, "BoundedWorkerWave member");
    if (!/^execution-authorization-[a-f0-9]{24}$/.test(member.authorizationId || "")
      || !/^[a-f0-9]{64}$/.test(member.authorizationHash || "")
      || !/^bounded-worker-dispatch-[a-f0-9]{24}$/.test(member.dispatchId || "")
      || !/^[a-f0-9]{64}$/.test(member.dispatchHash || "")
      || member.workerRole === (format?.roleField || "head") || typeof member.workerRole !== "string" || !member.workerRole
      || !new Set(["claude", "codex", "opencode"]).has(member.runtime)) {
      fail("BoundedWorkerWave member violates the dispatch boundary.", "INVALID_BOUNDED_WORKER_WAVE");
    }
  }
  const authorizationIds = document.members.map((member) => member.authorizationId);
  const dispatchIds = document.members.map((member) => member.dispatchId);
  const boundary = {
    createsExecutionAuthorization: false,
    widensMemberScope: false,
    independentAtMostOnceLeases: true,
    wholeOutcomeOwner: format?.roleField || "head",
    sealRequiresEveryMemberStarted: true,
    completionRequiresEveryMemberSucceeded: true,
    providerIdentityPersisted: false,
    herdrIdentityPersisted: false,
    reviewDecisionCreated: false,
    recoveryDirectionWritable: false,
  };
  if (document.schemaVersion !== 1 || document.kind !== "BoundedWorkerWave"
    || !format || document.protocol?.name !== format.protocol("head-agent-core-bounded-worker-wave")
    || document.protocol?.version !== BOUNDED_WORKER_WAVE_VERSION
    || !new RegExp(`^${format?.projectPrefix || "head-"}[a-f0-9]{20}$`).test(document.projectId || "")
    || !/^session-[A-Fa-f0-9-]{36}$/.test(sessionIdOf(document) || "")
    || !/^[a-f0-9]{64}$/.test(document.sessionPointerHash || "")
    || !/^run-[0-9]+-[a-f0-9]{6}$/.test(document.runId || "")
    || !/^[a-f0-9]{64}$/.test(document.runHash || "")
    || !/^whole-plan-[a-f0-9]{24}$/.test(document.wholePlanId || "")
    || !/^execution-contract-[a-f0-9]{24}$/.test(document.executionContractId || "")
    || !/^capsule-[a-f0-9]{24}$/.test(document.contextCapsuleId || "")
    || !/^[a-f0-9]{64}$/.test(document.contextCapsuleHash || "")
    || authorizationIds.some((value, index) => index > 0 && compareText(authorizationIds[index - 1], value) >= 0)
    || new Set(dispatchIds).size !== dispatchIds.length
    || canonicalJson(document.waveBoundary) !== canonicalJson(boundary)
    || document.authority !== "parallel-worker-launch-grouping-evidence-only"
    || document.recoveryAuthority !== false || document.instructionAuthority !== false
    || document.reviewAuthority !== false || document.promotionAuthority !== false || document.mutatesCanon !== false) {
    fail("BoundedWorkerWave violates the P3 grouping boundary.", "INVALID_BOUNDED_WORKER_WAVE");
  }
  verifyIdentity(document, {
    prefix: "bounded-worker-wave", idKey: "waveId", hashKey: "waveHash", code: "BOUNDED_WORKER_WAVE_DIGEST_MISMATCH",
  });
  return document;
}

function verifiedWave(inspected, waveId) {
  const file = waveFile(inspected.project.projectRoot, waveId, inspected.storage);
  if (!fs.existsSync(file)) fail(`Bounded worker wave not found: ${waveId}.`, "BOUNDED_WORKER_WAVE_NOT_FOUND");
  const wave = verifyBoundedWorkerWave(readJson(file, "BoundedWorkerWave", "INVALID_BOUNDED_WORKER_WAVE"));
  if (wave.waveId !== waveId) fail("Bounded worker wave file identity is invalid.", "BOUNDED_WORKER_WAVE_DIGEST_MISMATCH");
  // Historical evidence is bound to its stored lineage, not the current
  // execution pointer. Reading evidence must not authorize another effect.
  const root = inspected.project.projectRoot;
  if (wave.projectId !== inspected.project.projectId) {
    fail("Bounded worker wave belongs to another project.", "BOUNDED_WORKER_WAVE_LINEAGE_DRIFT");
  }
  const plan = readLineageArtifact({ root, artifactId: wave.wholePlanId }).artifact;
  const contract = readLineageArtifact({ root, artifactId: wave.executionContractId }).artifact;
  const capsule = readContextCapsule({ root, capsuleId: wave.contextCapsuleId }).capsule;
  const run = readJson(path.join(root, formatForVerifiedOwner(inspected).directory, "sessions", "runs", wave.runId, "run.json"),
    "Recorded Run", "INVALID_BOUNDED_WORKER_WAVE_LINEAGE");
  if (plan.kind !== "WholePlanSnapshot" || contract.kind !== "ExecutionContract"
    || contract.wholePlanId !== wave.wholePlanId || contract.capsuleId !== wave.contextCapsuleId
    || capsule.capsuleHash !== wave.contextCapsuleHash || run.runId !== wave.runId
    || run.wholePlanId !== wave.wholePlanId || run.executionContractId !== wave.executionContractId
    || run.capsuleId !== wave.contextCapsuleId) {
    fail("Bounded worker wave stored lineage is inconsistent.", "BOUNDED_WORKER_WAVE_LINEAGE_DRIFT");
  }
  for (const member of wave.members) {
    const { dispatch } = readBoundedWorkerDispatch({ root: inspected.project.projectRoot, authorizationId: member.authorizationId });
    if (!memberMatchesDispatch(member, dispatch)
      || dispatch.projectId !== wave.projectId || sessionIdOf(dispatch) !== sessionIdOf(wave)
      || dispatch.runId !== wave.runId || dispatch.wholePlanId !== wave.wholePlanId
      || dispatch.executionContractId !== wave.executionContractId || dispatch.contextCapsuleId !== wave.contextCapsuleId) {
      fail("Bounded worker wave member dispatch or lineage was changed.", "BOUNDED_WORKER_WAVE_MEMBER_DRIFT");
    }
  }
  return { file, wave };
}

export function createBoundedWorkerWave(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("Bounded worker wave create input is invalid.", "INVALID_BOUNDED_WORKER_WAVE_CREATE_INPUT");
  }
  const unsupported = Object.keys(options).filter((key) => !new Set(["root", "authorizationIds"]).has(key));
  if (unsupported.length) {
    fail(`Bounded worker wave cannot create or widen authorization fields: ${unsupported.sort(compareText).join(", ")}.`, "BOUNDED_WORKER_WAVE_AUTHORIZATION_AMPLIFICATION_REJECTED");
  }
  const { root = ".", authorizationIds } = options;
  const inspected = ready(root, "a bounded worker wave is created");
  const lineage = currentLineage(inspected);
  const members = normalizeAuthorizationIds(authorizationIds).map((authorizationId) => {
    const { dispatch } = readBoundedWorkerDispatch({ root: inspected.project.projectRoot, authorizationId });
    if (dispatch.projectId !== lineage.projectId || sessionIdOf(dispatch) !== sessionIdOf(lineage)
      || dispatch.runId !== lineage.runId || dispatch.wholePlanId !== lineage.wholePlanId
      || dispatch.executionContractId !== lineage.executionContractId || dispatch.contextCapsuleId !== lineage.contextCapsuleId) {
      fail("Bounded worker wave members must share the exact current Project/Session/Run/plan/contract/Capsule lineage.", "BOUNDED_WORKER_WAVE_MEMBER_LINEAGE_CONFLICT");
    }
    return memberFromDispatch(dispatch);
  });
  const wave = verifyBoundedWorkerWave(identify({
    schemaVersion: 1,
    kind: "BoundedWorkerWave",
    protocol: { name: formatForVerifiedOwner(inspected).protocol("head-agent-core-bounded-worker-wave"), version: BOUNDED_WORKER_WAVE_VERSION },
    authorityBoundary: artifactAuthorityBoundary("BoundedWorkerWave"),
    ...lineage,
    members,
    waveBoundary: {
      createsExecutionAuthorization: false,
      widensMemberScope: false,
      independentAtMostOnceLeases: true,
      wholeOutcomeOwner: formatForVerifiedOwner(inspected).roleField,
      sealRequiresEveryMemberStarted: true,
      completionRequiresEveryMemberSucceeded: true,
      providerIdentityPersisted: false,
      herdrIdentityPersisted: false,
      reviewDecisionCreated: false,
      recoveryDirectionWritable: false,
    },
    authority: "parallel-worker-launch-grouping-evidence-only",
    recoveryAuthority: false,
    instructionAuthority: false,
    reviewAuthority: false,
    promotionAuthority: false,
    mutatesCanon: false,
  }, { prefix: "bounded-worker-wave", idKey: "waveId", hashKey: "waveHash" }));
  const file = waveFile(inspected.project.projectRoot, wave.waveId, inspected.storage);
  try { writeRuntimeInvocationArtifactExclusive(file, pretty(wave)); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = verifiedWave(inspected, wave.waveId).wave;
    if (existing.waveHash !== wave.waveHash) fail("Bounded worker wave create replay diverged.", "BOUNDED_WORKER_WAVE_CREATE_CONFLICT");
    return { status: "existing", file, wave: existing };
  }
  return { status: "created", file, wave };
}

function currentResult(root, authorizationId, storage) {
  try { return readRuntimeInvocationResult({ root, authorizationId, storage }); }
  catch (error) {
    if (error.code === "RUNTIME_INVOCATION_RESULT_NOT_FOUND") return null;
    throw error;
  }
}

function memberOperationalStatus(root, projectId, member, storage) {
  const result = currentResult(root, member.authorizationId, storage);
  const lease = inspectRuntimeExecutionLease({ projectRoot: root, projectId, authorizationId: member.authorizationId, storage });
  const started = lease.singleUseConsumed === true || Boolean(result);
  const returned = Boolean(result);
  const succeeded = result?.receipt?.status === "completed";
  const releasedWithoutResult = !result && lease.release !== null;
  const incompleteConsumption = lease.status === "consumed-incomplete";
  const failed = Boolean(result && result.receipt.status !== "completed") || releasedWithoutResult || incompleteConsumption;
  const waiting = started && !returned && !failed;
  return {
    authorizationId: member.authorizationId,
    dispatchId: member.dispatchId,
    workerRole: member.workerRole,
    runtime: member.runtime,
    state: succeeded ? "succeeded" : failed ? "failed" : waiting ? "waiting" : "requested",
    started,
    returned,
    waiting,
    succeeded,
    failed,
    leaseStatus: lease.status,
    consumptionId: lease.consumption?.consumptionId || null,
    releaseId: lease.release?.releaseId || null,
    lifecycleReceiptId: result?.receipt?.receiptId || lease.release?.lifecycleReceiptId || null,
    resultDraftId: result?.draft?.draftId || null,
  };
}

function verifySeal(document, wave) {
  const format = familyFormatForOriginal("head-agent-core-bounded-worker-wave-seal", document);
  const fields = [
    "schemaVersion", "kind", "protocol", "authorityBoundary", "projectId", (format?.sessionIdField || "headSessionId"), "waveId", "waveHash",
    "runId", "wholePlanId", "executionContractId", "contextCapsuleId", "memberStartEvidence", "sealBoundary",
    "authority", "recoveryAuthority", "instructionAuthority", "reviewAuthority", "promotionAuthority", "mutatesCanon",
    "sealId", "sealHash",
  ];
  assertExactFields(document, fields, "BoundedWorkerWaveSeal", "INVALID_BOUNDED_WORKER_WAVE_SEAL");
  verifyArtifactAuthorityBoundary("BoundedWorkerWaveSeal", document.authorityBoundary);
  const evidenceFields = ["authorizationId", "dispatchId", "consumptionId", "lifecycleReceiptId", "terminalStatus"];
  if (!Array.isArray(document.memberStartEvidence) || document.memberStartEvidence.length !== wave.members.length) {
    fail("BoundedWorkerWaveSeal start evidence is incomplete.", "INVALID_BOUNDED_WORKER_WAVE_SEAL");
  }
  for (let index = 0; index < document.memberStartEvidence.length; index += 1) {
    const evidence = document.memberStartEvidence[index];
    const member = wave.members[index];
    assertExactFields(evidence, evidenceFields, "BoundedWorkerWaveSeal member evidence", "INVALID_BOUNDED_WORKER_WAVE_SEAL");
    if (evidence.authorizationId !== member.authorizationId || evidence.dispatchId !== member.dispatchId
      || !/^runtime-execution-consumption-[a-f0-9]{24}$/.test(evidence.consumptionId || "")
      || evidence.lifecycleReceiptId !== null && !/^runtime-lifecycle-receipt-[a-f0-9]{24}$/.test(evidence.lifecycleReceiptId)
      || !new Set(["active", "completed", "failed", "incomplete"]).has(evidence.terminalStatus)) {
      fail("BoundedWorkerWaveSeal member evidence is invalid.", "INVALID_BOUNDED_WORKER_WAVE_SEAL");
    }
  }
  if (new Set(document.memberStartEvidence.map((evidence) => evidence.consumptionId)).size !== wave.members.length) {
    fail("BoundedWorkerWaveSeal reused one authorization consumption.", "INVALID_BOUNDED_WORKER_WAVE_SEAL");
  }
  const boundary = {
    allMembersStartedFromVerifiedLeaseConsumption: true,
    readOnlyStatusCannotSeal: true,
    createsExecutionAuthorization: false,
    memberLeasesRemainIndependent: true,
    completionAuthority: false,
    reviewDecisionCreated: false,
    recoveryDirectionWritable: false,
  };
  if (document.schemaVersion !== 1 || document.kind !== "BoundedWorkerWaveSeal"
    || !format || document.protocol?.name !== format.protocol("head-agent-core-bounded-worker-wave-seal")
    || document.protocol?.version !== BOUNDED_WORKER_WAVE_VERSION
    || document.projectId !== wave.projectId || sessionIdOf(document) !== sessionIdOf(wave)
    || document.waveId !== wave.waveId || document.waveHash !== wave.waveHash || document.runId !== wave.runId
    || document.wholePlanId !== wave.wholePlanId || document.executionContractId !== wave.executionContractId
    || document.contextCapsuleId !== wave.contextCapsuleId
    || canonicalJson(document.memberStartEvidence.map((entry) => entry.authorizationId))
      !== canonicalJson(wave.members.map((entry) => entry.authorizationId))
    || canonicalJson(document.sealBoundary) !== canonicalJson(boundary)
    || document.authority !== "verified-all-member-start-evidence-only"
    || document.recoveryAuthority !== false || document.instructionAuthority !== false
    || document.reviewAuthority !== false || document.promotionAuthority !== false || document.mutatesCanon !== false) {
    fail("BoundedWorkerWaveSeal violates the P3 seal boundary.", "INVALID_BOUNDED_WORKER_WAVE_SEAL");
  }
  verifyIdentity(document, {
    prefix: "bounded-worker-wave-seal", idKey: "sealId", hashKey: "sealHash", code: "BOUNDED_WORKER_WAVE_SEAL_DIGEST_MISMATCH",
  });
  return document;
}

function verifyAbandonment(document, wave) {
  const format = familyFormatForOriginal("head-agent-core-bounded-worker-wave-abandonment", document);
  const fields = [
    "schemaVersion", "kind", "protocol", "authorityBoundary", "projectId", (format?.sessionIdField || "headSessionId"), "waveId", "waveHash",
    "runId", "reasonCode", "reasonSummary", "memberEvidence", "abandonBoundary", "authority", "recoveryAuthority",
    "instructionAuthority", "reviewAuthority", "promotionAuthority", "mutatesCanon", "abandonmentId", "abandonmentHash",
  ];
  assertExactFields(document, fields, "BoundedWorkerWaveAbandonment", "INVALID_BOUNDED_WORKER_WAVE_ABANDONMENT");
  verifyArtifactAuthorityBoundary("BoundedWorkerWaveAbandonment", document.authorityBoundary);
  const evidenceFields = ["authorizationId", "dispatchId", "state", "consumptionId", "lifecycleReceiptId"];
  if (!Array.isArray(document.memberEvidence) || document.memberEvidence.length !== wave.members.length) {
    fail("BoundedWorkerWaveAbandonment member evidence is incomplete.", "INVALID_BOUNDED_WORKER_WAVE_ABANDONMENT");
  }
  for (let index = 0; index < document.memberEvidence.length; index += 1) {
    const evidence = document.memberEvidence[index];
    const member = wave.members[index];
    assertExactFields(evidence, evidenceFields, "BoundedWorkerWaveAbandonment member evidence", "INVALID_BOUNDED_WORKER_WAVE_ABANDONMENT");
    if (evidence.authorizationId !== member.authorizationId || evidence.dispatchId !== member.dispatchId
      || !new Set(["requested", "waiting", "succeeded", "failed"]).has(evidence.state)
      || evidence.consumptionId !== null && !/^runtime-execution-consumption-[a-f0-9]{24}$/.test(evidence.consumptionId)
      || evidence.lifecycleReceiptId !== null && !/^runtime-lifecycle-receipt-[a-f0-9]{24}$/.test(evidence.lifecycleReceiptId)) {
      fail("BoundedWorkerWaveAbandonment member evidence is invalid.", "INVALID_BOUNDED_WORKER_WAVE_ABANDONMENT");
    }
  }
  const boundary = {
    successClaimed: false,
    privilegedInstruction: false,
    freeFormReasonAuthority: false,
    createsReviewDecision: false,
    writesRecoveryDirection: false,
  };
  if (document.schemaVersion !== 1 || document.kind !== "BoundedWorkerWaveAbandonment"
    || !format || document.protocol?.name !== format.protocol("head-agent-core-bounded-worker-wave-abandonment")
    || document.protocol?.version !== BOUNDED_WORKER_WAVE_VERSION
    || document.projectId !== wave.projectId || sessionIdOf(document) !== sessionIdOf(wave)
    || document.waveId !== wave.waveId || document.waveHash !== wave.waveHash || document.runId !== wave.runId
    || !ABANDON_REASON_CODES.has(document.reasonCode)
    || typeof document.reasonSummary !== "string" || Buffer.byteLength(document.reasonSummary, "utf8") > 256
    || /[\u0000-\u001f\u007f]/u.test(document.reasonSummary)
    || canonicalJson(document.memberEvidence.map((entry) => entry.authorizationId))
      !== canonicalJson(wave.members.map((entry) => entry.authorizationId))
    || canonicalJson(document.abandonBoundary) !== canonicalJson(boundary)
    || document.authority !== "abandoned-wave-handoff-evidence-only"
    || document.recoveryAuthority !== false || document.instructionAuthority !== false
    || document.reviewAuthority !== false || document.promotionAuthority !== false || document.mutatesCanon !== false) {
    fail("BoundedWorkerWaveAbandonment violates the P3 handoff boundary.", "INVALID_BOUNDED_WORKER_WAVE_ABANDONMENT");
  }
  verifyIdentity(document, {
    prefix: "bounded-worker-wave-abandonment", idKey: "abandonmentId", hashKey: "abandonmentHash",
    code: "BOUNDED_WORKER_WAVE_ABANDONMENT_DIGEST_MISMATCH",
  });
  return document;
}

function readTerminal(root, wave) {
  const file = terminalFile(root, wave.waveId, originalFormat(wave));
  if (!fs.existsSync(file)) return { file, seal: null, abandonment: null };
  const document = readJson(file, "Bounded worker wave terminal record", "INVALID_BOUNDED_WORKER_WAVE_TERMINAL");
  if (document?.kind === "BoundedWorkerWaveSeal") return { file, seal: verifySeal(document, wave), abandonment: null };
  if (document?.kind === "BoundedWorkerWaveAbandonment") return { file, seal: null, abandonment: verifyAbandonment(document, wave) };
  fail("Bounded worker wave terminal record kind is invalid.", "INVALID_BOUNDED_WORKER_WAVE_TERMINAL");
}

function buildStatusProjection({ root, wave, seal = null, abandonment = null, admissionHost = null }) {
  const members = wave.members.map((member) => memberOperationalStatus(root, wave.projectId, member, originalFormat(wave)));
  const counts = {
    requested: members.length,
    started: members.filter((member) => member.started).length,
    returned: members.filter((member) => member.returned).length,
    waiting: members.filter((member) => member.waiting).length,
    succeeded: members.filter((member) => member.succeeded).length,
    failed: members.filter((member) => member.failed).length,
  };
  const state = abandonment ? "abandoned" : !seal ? "open" : counts.failed > 0 ? "failed"
    : counts.succeeded === counts.requested ? "completed" : "sealed";
  const payload = {
    schemaVersion: 1,
    kind: "WorkerWaveStatusProjection",
    protocol: { name: originalFormat(wave).protocol("head-agent-core-worker-wave-status"), version: BOUNDED_WORKER_WAVE_VERSION },
    authorityBoundary: artifactAuthorityBoundary("WorkerWaveStatusProjection"),
    projectId: wave.projectId,
    [originalFormat(wave).sessionIdField]: sessionIdOf(wave),
    waveId: wave.waveId,
    sealId: seal?.sealId || null,
    abandonmentId: abandonment?.abandonmentId || null,
    state,
    counts,
    members,
    guidance: {
      ordinaryWorkBlocked: false, userActionRequired: false, aggregateAvailable: Boolean(seal) && !abandonment,
      canSeal: !seal && !abandonment && counts.started === counts.requested,
      unsettledMemberAuthorizationIds: members.filter(member => member.started && !member.releaseId).map(member => member.authorizationId),
      groupStateProvesProcessCleanup: false, abandonCancelsMembers: false, waitAbortCancelsMembers: false,
      nextStep: abandonment ? "Preserve returned evidence and inspect or cancel each owned unfinished member; abandonment does not stop workers."
        : !seal ? counts.started === counts.requested ? "All members have start evidence, but this wave is not sealed. Inspect individual results; status never seals or selects a maintenance mutation."
          : "Inspect the existing individual jobs and preserve returned evidence. This partial wave cannot provide aggregate wait/results without a seal; it does not request more launches or block independent work."
          : counts.failed > 0 ? "Preserve useful results and inspect or cancel unfinished owned members. One failure does not mean every worker stopped; reconcile unknown effects before retry."
            : state === "completed" ? "HEAD reviews the combined results and verifies owned process cleanup. Group success is not approval or P2 integration."
              : "Observe individual members or use bounded aggregate wait. Ending a wait does not cancel workers.",
      persisted: false, grantsPermission: false,
    },
    persisted: false,
    completionAuthority: false,
    recoveryAuthority: false,
    instructionAuthority: false,
    reviewAuthority: false,
    promotionAuthority: false,
    mutatesCanon: false,
  };
  if (admissionHost !== null) {
    const admissionMembers = wave.members.map((member) => readWorkerAdmissionProjection({
      host: admissionHost,
      root,
      authorizationId: member.authorizationId,
    }));
    payload.admission = {
      availability: admissionMembers.every((member) => member.availability === "available") ? "available" : "unavailable",
      members: admissionMembers,
    };
  }
  return identify(payload, { prefix: "worker-wave-status", idKey: "statusProjectionId", hashKey: "statusProjectionHash" });
}

export function readBoundedWorkerWave({ root = ".", waveId } = {}) {
  const inspected = ready(root, "a bounded worker wave is read");
  const { file, wave } = verifiedWave(inspected, waveId);
  const { seal, abandonment } = readTerminal(inspected.project.projectRoot, wave);
  return { status: "verified", file, wave, seal, abandonment };
}

export function readBoundedWorkerWaveStatus({ root = ".", waveId, admissionHost = null } = {}) {
  const read = readBoundedWorkerWave({ root, waveId });
  const projection = buildStatusProjection({ root: path.resolve(root), wave: read.wave, seal: read.seal, abandonment: read.abandonment, admissionHost });
  return { status: "worker_wave_status_verified", projection };
}

export function sealBoundedWorkerWave({ root = ".", waveId } = {}) {
  const read = readBoundedWorkerWave({ root, waveId });
  verifyLineageMatches(read.wave, ready(root, "a bounded worker wave is sealed"));
  if (read.abandonment) fail("An abandoned bounded worker wave cannot be sealed.", "BOUNDED_WORKER_WAVE_ABANDONED");
  if (read.seal) return { status: "existing", seal: read.seal, wave: read.wave };
  const members = read.wave.members.map((member) => memberOperationalStatus(path.resolve(root), read.wave.projectId, member, originalFormat(read.wave)));
  if (members.some((member) => !member.started || !member.consumptionId)) {
    fail("Every bounded worker wave member must have verified authorization consumption before seal.", "BOUNDED_WORKER_WAVE_NOT_FULLY_STARTED");
  }
  const memberStartEvidence = members.map((member) => ({
    authorizationId: member.authorizationId,
    dispatchId: member.dispatchId,
    consumptionId: member.consumptionId,
    lifecycleReceiptId: member.lifecycleReceiptId,
    terminalStatus: member.succeeded ? "completed" : member.failed ? "failed" : member.leaseStatus === "consumed-incomplete" ? "incomplete" : "active",
  }));
  const seal = verifySeal(identify({
    schemaVersion: 1,
    kind: "BoundedWorkerWaveSeal",
    protocol: { name: originalFormat(read.wave).protocol("head-agent-core-bounded-worker-wave-seal"), version: BOUNDED_WORKER_WAVE_VERSION },
    authorityBoundary: artifactAuthorityBoundary("BoundedWorkerWaveSeal"),
    projectId: read.wave.projectId,
    [originalFormat(read.wave).sessionIdField]: sessionIdOf(read.wave),
    waveId: read.wave.waveId,
    waveHash: read.wave.waveHash,
    runId: read.wave.runId,
    wholePlanId: read.wave.wholePlanId,
    executionContractId: read.wave.executionContractId,
    contextCapsuleId: read.wave.contextCapsuleId,
    memberStartEvidence,
    sealBoundary: {
      allMembersStartedFromVerifiedLeaseConsumption: true,
      readOnlyStatusCannotSeal: true,
      createsExecutionAuthorization: false,
      memberLeasesRemainIndependent: true,
      completionAuthority: false,
      reviewDecisionCreated: false,
      recoveryDirectionWritable: false,
    },
    authority: "verified-all-member-start-evidence-only",
    recoveryAuthority: false,
    instructionAuthority: false,
    reviewAuthority: false,
    promotionAuthority: false,
    mutatesCanon: false,
  }, { prefix: "bounded-worker-wave-seal", idKey: "sealId", hashKey: "sealHash" }), read.wave);
  const file = terminalFile(path.resolve(root), read.wave.waveId, originalFormat(read.wave));
  try { writeRuntimeInvocationArtifactExclusive(file, pretty(seal)); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const terminal = readTerminal(path.resolve(root), read.wave);
    if (!terminal.seal) fail("Bounded worker wave was already abandoned.", "BOUNDED_WORKER_WAVE_ABANDONED");
    const existing = terminal.seal;
    if (existing.sealHash !== seal.sealHash) fail("Bounded worker wave seal replay diverged.", "BOUNDED_WORKER_WAVE_SEAL_CONFLICT");
    return { status: "existing", seal: existing, wave: read.wave };
  }
  return { status: "sealed", seal, wave: read.wave };
}

function normalizeReasonSummary(value) {
  const summary = String(value || "").trim().replace(/\s+/gu, " ");
  if (Buffer.byteLength(summary, "utf8") > 256 || /[\u0000-\u001f\u007f]/u.test(summary)) {
    fail("Bounded worker wave abandonment reason summary is invalid.", "INVALID_BOUNDED_WORKER_WAVE_ABANDON_REASON");
  }
  return summary;
}

export function abandonBoundedWorkerWave({ root = ".", waveId, reasonCode, reasonSummary = "" } = {}) {
  const read = readBoundedWorkerWave({ root, waveId });
  verifyLineageMatches(read.wave, ready(root, "a bounded worker wave is abandoned"));
  if (read.seal) fail("A sealed bounded worker wave cannot be abandoned.", "BOUNDED_WORKER_WAVE_ALREADY_SEALED");
  const normalizedCode = String(reasonCode || "").trim();
  if (!ABANDON_REASON_CODES.has(normalizedCode)) fail("Bounded worker wave abandonment reason code is invalid.", "INVALID_BOUNDED_WORKER_WAVE_ABANDON_REASON");
  const normalizedSummary = normalizeReasonSummary(reasonSummary);
  if (read.abandonment) {
    if (read.abandonment.reasonCode !== normalizedCode || read.abandonment.reasonSummary !== normalizedSummary) {
      fail("Bounded worker wave abandonment replay diverged.", "BOUNDED_WORKER_WAVE_ABANDON_CONFLICT");
    }
    return { status: "existing", abandonment: read.abandonment, wave: read.wave };
  }
  const members = read.wave.members.map((member) => memberOperationalStatus(path.resolve(root), read.wave.projectId, member, originalFormat(read.wave)));
  const memberEvidence = members.map((member) => ({
    authorizationId: member.authorizationId,
    dispatchId: member.dispatchId,
    state: member.state,
    consumptionId: member.consumptionId,
    lifecycleReceiptId: member.lifecycleReceiptId,
  }));
  const abandonment = verifyAbandonment(identify({
    schemaVersion: 1,
    kind: "BoundedWorkerWaveAbandonment",
    protocol: { name: originalFormat(read.wave).protocol("head-agent-core-bounded-worker-wave-abandonment"), version: BOUNDED_WORKER_WAVE_VERSION },
    authorityBoundary: artifactAuthorityBoundary("BoundedWorkerWaveAbandonment"),
    projectId: read.wave.projectId,
    [originalFormat(read.wave).sessionIdField]: sessionIdOf(read.wave),
    waveId: read.wave.waveId,
    waveHash: read.wave.waveHash,
    runId: read.wave.runId,
    reasonCode: normalizedCode,
    reasonSummary: normalizedSummary,
    memberEvidence,
    abandonBoundary: {
      successClaimed: false,
      privilegedInstruction: false,
      freeFormReasonAuthority: false,
      createsReviewDecision: false,
      writesRecoveryDirection: false,
    },
    authority: "abandoned-wave-handoff-evidence-only",
    recoveryAuthority: false,
    instructionAuthority: false,
    reviewAuthority: false,
    promotionAuthority: false,
    mutatesCanon: false,
  }, { prefix: "bounded-worker-wave-abandonment", idKey: "abandonmentId", hashKey: "abandonmentHash" }), read.wave);
  const file = terminalFile(path.resolve(root), read.wave.waveId, originalFormat(read.wave));
  try { writeRuntimeInvocationArtifactExclusive(file, pretty(abandonment)); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const terminal = readTerminal(path.resolve(root), read.wave);
    if (!terminal.abandonment) fail("Bounded worker wave was already sealed.", "BOUNDED_WORKER_WAVE_ALREADY_SEALED");
    const existing = terminal.abandonment;
    if (existing.abandonmentHash !== abandonment.abandonmentHash) fail("Bounded worker wave abandonment replay diverged.", "BOUNDED_WORKER_WAVE_ABANDON_CONFLICT");
    return { status: "existing", abandonment: existing, wave: read.wave };
  }
  return { status: "abandoned", abandonment, wave: read.wave };
}

function buildResultProjection(statusProjection) {
  const payload = {
    schemaVersion: 1,
    kind: "WorkerWaveResultProjection",
    protocol: { name: originalFormat(statusProjection).protocol("head-agent-core-worker-wave-results"), version: BOUNDED_WORKER_WAVE_VERSION },
    authorityBoundary: artifactAuthorityBoundary("WorkerWaveResultProjection"),
    projectId: statusProjection.projectId,
    [originalFormat(statusProjection).sessionIdField]: sessionIdOf(statusProjection),
    waveId: statusProjection.waveId,
    sealId: statusProjection.sealId,
    state: statusProjection.state,
    counts: statusProjection.counts,
    results: statusProjection.members.map((member) => ({
      authorizationId: member.authorizationId,
      dispatchId: member.dispatchId,
      state: member.state,
      lifecycleReceiptId: member.lifecycleReceiptId,
      resultDraftId: member.resultDraftId,
    })),
    persisted: false,
    resultAuthority: "evidence-reference-only",
    recoveryAuthority: false,
    instructionAuthority: false,
    reviewAuthority: false,
    promotionAuthority: false,
    mutatesCanon: false,
  };
  return identify(payload, { prefix: "worker-wave-results", idKey: "resultProjectionId", hashKey: "resultProjectionHash" });
}

export function readBoundedWorkerWaveResults({ root = ".", waveId } = {}) {
  const read = readBoundedWorkerWave({ root, waveId });
  if (!read.seal || read.abandonment) fail("Aggregate results require a verified seal. Read individual jobs and wave status; HEAD may seal after every member started, or abandon a partial launch without cancelling its members.", "BOUNDED_WORKER_WAVE_NOT_SEALED");
  const projection = buildStatusProjection({ root: path.resolve(root), wave: read.wave, seal: read.seal, abandonment: null });
  return { status: "worker_wave_results_verified", projection: buildResultProjection(projection) };
}

function waitOutcome(statusProjection, timedOut) {
  const payload = {
    schemaVersion: 1,
    kind: "BoundedWorkerWaveWaitOutcome",
    protocol: { name: originalFormat(statusProjection).protocol("head-agent-core-bounded-worker-wave-wait"), version: BOUNDED_WORKER_WAVE_VERSION },
    authorityBoundary: artifactAuthorityBoundary("BoundedWorkerWaveWaitOutcome"),
    projectId: statusProjection.projectId,
    [originalFormat(statusProjection).sessionIdField]: sessionIdOf(statusProjection),
    waveId: statusProjection.waveId,
    sealId: statusProjection.sealId,
    state: timedOut ? "timed-out" : statusProjection.state,
    counts: statusProjection.counts,
    timedOut,
    guidance: statusProjection.guidance,
    persisted: false,
    reviewDecisionCreated: false,
    recoveryDirectionWritable: false,
    recoveryAuthority: false,
    instructionAuthority: false,
    reviewAuthority: false,
    promotionAuthority: false,
    mutatesCanon: false,
  };
  return identify(payload, { prefix: "bounded-worker-wave-wait", idKey: "waitOutcomeId", hashKey: "waitOutcomeHash" });
}

export async function waitForBoundedWorkerWave({
  root = ".", waveId, timeoutMs = 0, pollIntervalMs = 100, signal = null,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 600_000
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 5_000) {
    fail("Bounded worker wave wait limits are invalid.", "INVALID_BOUNDED_WORKER_WAVE_WAIT");
  }
  const initial = readBoundedWorkerWave({ root, waveId });
  if (!initial.seal || initial.abandonment) fail("Aggregate wait requires a verified seal. Read individual jobs and wave status; partial launch is not completion and abandonment does not cancel members.", "BOUNDED_WORKER_WAVE_NOT_SEALED");
  const startedAt = Date.now();
  while (true) {
    if (signal?.aborted) fail("Wave wait was aborted; workers were not cancelled. Inspect or cancel each owned unfinished member and verify cleanup.", "BOUNDED_WORKER_WAVE_WAIT_ABORTED");
    const status = readBoundedWorkerWaveStatus({ root, waveId }).projection;
    if (new Set(["completed", "failed"]).has(status.state)) {
      return { status: `bounded_worker_wave_${status.state}`, projection: status, waitOutcome: waitOutcome(status, false) };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return { status: timeoutMs > 0 ? "bounded_worker_wave_timed_out" : "bounded_worker_wave_waiting", projection: status, waitOutcome: waitOutcome(status, timeoutMs > 0) };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, timeoutMs - (Date.now() - startedAt))));
  }
}
