import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
const sessionIdOf = record => {
  const format = familyFormatForOriginal({ sessionIdentity: true }, record);
  return format ? record?.[format.sessionIdField] : undefined;
};
const originalFormat = record => familyFormatForOriginal({ kind: record?.kind }, record);
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertProjectActionsCurrent, readProjectDirection, assertAuthorizationProjectDirection } from "./project-direction.mjs";
import { assertRunSession } from "./session-routing.mjs";
import { spawn } from "node:child_process";
import { inspectProject, SCHEMA_VERSION } from "./lode-core.mjs";
import { readContextCapsule } from "./context-compiler.mjs";
import { readLineageArtifact } from "./execution-lineage.mjs";
import { inspectRunStorageTransition } from "./run-lineage.mjs";
import { withProjectMutation } from "./project-mutation-lock.mjs";
import { writeRuntimeInvocationArtifactExclusive } from "./runtime-invocation-storage.mjs";
import { captureWorkerSourceBasis, verifyWorkerSourceBasis, requireCurrentWorkerSourceBasis } from "./worker-source-basis.mjs";
import { verifyWorkerExecutionBoundary } from "./worker-workspace.mjs";
import { captureWorkerWriteBasis, requireCurrentWorkerWriteBasis } from "./worker-patch-basis.mjs";
import { isWorkerPatchProposalMode, verifyWorkerPatchProposalExecutionBoundary, verifyWorkerPatchProposal } from "./worker-patch-proposal-contract.mjs";
import { workerMemberFile, readWorkerMemberChain, requireCurrentWorkerMember } from "./worker-member-registry.mjs";
import {
  verifyRuntimeProjectBinding,
  verifyRuntimeProtocolEvidence,
} from "./runtime-protocol-evidence.mjs";
import {
  inspectRuntimeExecutionLease,
  verifyRuntimeExecutionLeaseOwnership,
  verifyRuntimeExecutionLeaseRelease,
  withRuntimeExecutionLease,
  recordRuntimeInvocationStartFailure,
  verifyRuntimeInvocationNeverStarted,
  reconcileUnconsumedWorkerLease,
} from "./runtime-execution-lease.mjs";

export const EXECUTION_AUTHORIZATION_VERSION = "0.3.0";
export const WORKER_EXECUTION_AUTHORIZATION_VERSION = "0.4.0";
export const BOUND_WORKER_EXECUTION_AUTHORIZATION_VERSION = "0.5.0";
export const WRITE_BOUND_WORKER_EXECUTION_AUTHORIZATION_VERSION = "0.6.0";
export const PROPOSAL_WORKER_EXECUTION_AUTHORIZATION_VERSION = "0.7.0";
export const RUNTIME_INVOCATION_AUTHORIZATION_VERSION = EXECUTION_AUTHORIZATION_VERSION;
export const RUNTIME_EVENT_ENVELOPE_VERSION = "0.1.0";
export const RUNTIME_LIFECYCLE_RECEIPT_VERSION = "0.6.0";
export const RUNTIME_RESULT_DRAFT_VERSION = "0.5.0";
export const RUNTIME_STRUCTURED_RESULT_VERSION = "0.1.0";
export const RUNTIME_PATCH_PROPOSAL_RESULT_VERSION = "0.2.0";
const LEGACY_RUNTIME_LIFECYCLE_RECEIPT_VERSION = "0.5.0";
const LEGACY_RUNTIME_RESULT_DRAFT_VERSION = "0.4.0";
const LEGACY_EXECUTION_AUTHORIZATION_VERSION = "0.2.0";

const RUNTIMES = Object.freeze(["claude", "codex", "opencode"]);
const WORKSPACE_MODES = Object.freeze(["read-only", "workspace-write"]);
const EXECUTION_SCOPE_KINDS = Object.freeze(["session", "run"]);
const REQUIRED_INVOKE_ACTION = "runtime.invoke";
const WORKSPACE_ACTION = Object.freeze({
  "read-only": "project.read",
  "workspace-write": "project.write",
});
const DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 60_000,
  terminationGraceMs: 1_000,
  maxInputBytes: 2 * 1024 * 1024,
  maxStdoutBytes: 8 * 1024 * 1024,
  maxStderrBytes: 256 * 1024,
  maxEvents: 4_096,
  maxEventBytes: 2 * 1024 * 1024,
});

const fail = (message, code = "RUNTIME_INVOCATION_LIFECYCLE_ERROR") => {
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
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function identify(payload, prefix, idKey, hashKey) {
  const hash = digest(canonicalJson(payload));
  return { ...payload, [idKey]: `${prefix}-${hash.slice(0, 24)}`, [hashKey]: hash };
}

function verifyIdentity(document, { prefix, idKey, hashKey, code }) {
  const payload = { ...document };
  delete payload[idKey];
  delete payload[hashKey];
  const hash = digest(canonicalJson(payload));
  if (document[hashKey] !== hash || document[idKey] !== `${prefix}-${hash.slice(0, 24)}`) {
    fail("Runtime invocation artifact digest verification failed.", code);
  }
}

function assertFields(value, fields, label, code = "INVALID_RUNTIME_INVOCATION_ARTIFACT") {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} is invalid.`, code);
  const expected = new Set(fields);
  if (Object.keys(value).some((field) => !expected.has(field)) || fields.some((field) => !(field in value))) {
    fail(`${label} fields are invalid.`, code);
  }
}

function requiredText(value, label, code = "INVALID_RUNTIME_INVOCATION_INPUT") {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is required.`, code);
  return value.trim();
}

function normalizeRuntime(value) {
  const runtime = String(value || "").trim().toLowerCase();
  if (!RUNTIMES.includes(runtime)) fail(`Unsupported runtime: ${runtime || "(empty)"}.`, "UNSUPPORTED_RUNTIME_INVOCATION");
  return runtime;
}

function normalizeWorkspaceMode(value) {
  const mode = String(value || "read-only").trim().toLowerCase();
  if (!WORKSPACE_MODES.includes(mode)) fail(`Unsupported workspace mode: ${mode || "(empty)"}.`, "INVALID_RUNTIME_WORKSPACE_MODE");
  return mode;
}

function normalizeRuntimeSelection(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("Runtime selection must be an object.", "INVALID_RUNTIME_SELECTION");
  }
  const unexpected = Object.keys(value).filter((field) => field !== "model");
  if (unexpected.length) fail(`Runtime selection contains unsupported fields: ${unexpected.sort().join(", ")}.`, "INVALID_RUNTIME_SELECTION");
  const model = value.model == null || value.model === "" ? null : String(value.model).trim();
  if (model !== null && (!/^[a-z0-9][a-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/.test(model)
    || model.includes("..") || Buffer.byteLength(model) > 256)) {
    fail("Runtime model selection must use a bounded provider/model identifier.", "INVALID_RUNTIME_SELECTION");
  }
  return { model };
}

function normalizeLimits(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invocation limits must be an object.", "INVALID_RUNTIME_INVOCATION_LIMITS");
  const unexpected = Object.keys(value).filter((key) => !(key in DEFAULT_LIMITS));
  if (unexpected.length) fail(`Invocation limits contain unsupported fields: ${unexpected.sort().join(", ")}.`, "INVALID_RUNTIME_INVOCATION_LIMITS");
  const limits = { ...DEFAULT_LIMITS, ...value };
  if (!Object.prototype.hasOwnProperty.call(value, "maxEventBytes")
    && Object.prototype.hasOwnProperty.call(value, "maxStdoutBytes")) {
    limits.maxEventBytes = Math.min(DEFAULT_LIMITS.maxEventBytes, limits.maxStdoutBytes);
  }
  const ranges = {
    timeoutMs: [1_000, 3_600_000],
    terminationGraceMs: [100, 10_000],
    maxInputBytes: [1_024, 8 * 1024 * 1024],
    maxStdoutBytes: [1_024, 16 * 1024 * 1024],
    maxStderrBytes: [1_024, 2 * 1024 * 1024],
    maxEvents: [1, 16_384],
    maxEventBytes: [256, 2 * 1024 * 1024],
  };
  for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < minimum || limits[key] > maximum) {
      fail(`${key} must be an integer from ${minimum} through ${maximum}.`, "INVALID_RUNTIME_INVOCATION_LIMITS");
    }
  }
  if (limits.maxEventBytes > limits.maxStdoutBytes) {
    fail("maxEventBytes cannot exceed maxStdoutBytes.", "INVALID_RUNTIME_INVOCATION_LIMITS");
  }
  return limits;
}

function boundedResultText(value, label, { empty = false, maximum = 16_384 } = {}) {
  if (typeof value !== "string" || (!empty && !value.trim()) || Buffer.byteLength(value) > maximum) {
    fail(`${label} is invalid or exceeds ${maximum} bytes.`, "INVALID_RUNTIME_STRUCTURED_RESULT");
  }
  return value;
}

function boundedResultList(value, label, { maximumItems = 64, maximumItemBytes = 8_192 } = {}) {
  if (!Array.isArray(value) || value.length > maximumItems
    || value.some((item) => typeof item !== "string" || !item.trim() || Buffer.byteLength(item) > maximumItemBytes)) {
    fail(`${label} is invalid or exceeds its bound.`, "INVALID_RUNTIME_STRUCTURED_RESULT");
  }
  return [...value];
}

export function verifyRuntimeStructuredResult(document, { scopeKind = null, authorization = null } = {}) {
  const proposalResult = document?.protocolVersion === RUNTIME_PATCH_PROPOSAL_RESULT_VERSION;
  assertFields(document, [
    "schemaVersion", "kind", "protocolVersion", "outcome", "evidence", "planDelta", "impactRadius", "verification", "unknowns",
    ...(proposalResult ? ["patchProposal"] : []),
  ], "Runtime structured result", "INVALID_RUNTIME_STRUCTURED_RESULT");
  if (Buffer.byteLength(canonicalJson(document)) > 128 * 1024) fail("Runtime structured result exceeds its total-byte boundary.", "INVALID_RUNTIME_STRUCTURED_RESULT");
  const verifiedAuthorization = authorization === null ? null : verifyRuntimeInvocationAuthorization(authorization);
  if (verifiedAuthorization && ((verifiedAuthorization.protocolVersion === PROPOSAL_WORKER_EXECUTION_AUTHORIZATION_VERSION) !== proposalResult
    || scopeKind !== null && scopeKind !== verifiedAuthorization.scope.kind)) {
    fail("Runtime result version or scope differs from its exact authorization.", "INVALID_RUNTIME_STRUCTURED_RESULT");
  }
  scopeKind = verifiedAuthorization?.scope.kind ?? scopeKind;
  const result = {
    schemaVersion: document.schemaVersion,
    kind: document.kind,
    protocolVersion: document.protocolVersion,
    outcome: boundedResultText(document.outcome, "Runtime structured result outcome"),
    evidence: boundedResultList(document.evidence, "Runtime structured result evidence"),
    planDelta: boundedResultText(document.planDelta, "Runtime structured result planDelta", { empty: true }),
    impactRadius: boundedResultList(document.impactRadius, "Runtime structured result impactRadius"),
    verification: boundedResultList(document.verification, "Runtime structured result verification"),
    unknowns: boundedResultList(document.unknowns, "Runtime structured result unknowns"),
    ...(proposalResult ? { patchProposal: verifyWorkerPatchProposal(document.patchProposal, {
      basis: verifiedAuthorization?.workerInput.proposalBasis ?? null,
      basisDigest: verifiedAuthorization?.workerInput.executionBoundary.proposalBasisDigest ?? null,
      maxBytes: verifiedAuthorization?.limits.maxInputBytes ?? 128 * 1024,
      storage: verifiedAuthorization ? originalFormat(verifiedAuthorization) : undefined,
    }) } : {}),
  };
  if (result.schemaVersion !== 1 || result.kind !== "RuntimeStructuredResult"
    || ![RUNTIME_STRUCTURED_RESULT_VERSION, RUNTIME_PATCH_PROPOSAL_RESULT_VERSION].includes(result.protocolVersion)
    || ![null, ...EXECUTION_SCOPE_KINDS].includes(scopeKind)
    || scopeKind === "session" && (result.planDelta !== "" || result.impactRadius.length !== 0)
    || Buffer.byteLength(canonicalJson(result)) > 128 * 1024) {
    fail("Runtime structured result violates its scope or total-byte boundary.", "INVALID_RUNTIME_STRUCTURED_RESULT");
  }
  return result;
}

function realRoot(root) {
  return fs.realpathSync(path.resolve(root));
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`${label} is invalid JSON: ${error.message}`, "INVALID_RUNTIME_INVOCATION_ARTIFACT"); }
}

function runCanon(projectRoot, runId, storage) {
  const file = path.join(projectRoot, formatForVerifiedOwner(storage).directory, "sessions", "runs", runId, "run.json");
  if (!fs.existsSync(file)) fail(`Active Run canon is missing: ${runId}.`, "RUNTIME_INVOCATION_RUN_MISSING");
  const run = readJson(file, "Run canon");
  assertRunSession(projectRoot, run, inspectProject(projectRoot).state);
  if (run.runId !== runId || run.status !== "active") fail("Runtime invocation requires the exact active Run canon.", "RUNTIME_INVOCATION_RUN_NOT_ACTIVE");
  // A verified committed start is storage provenance, not an authorization.
  // An active Run with a prepared finish has
  // already frozen its result, even if its Session pointer has not committed.
  // Only the exact finish retry may complete that transition; it is not an
  // opportunity to authorize or prepare another execution/file effect.
  if (run.sessionTransition != null) {
    if (run.sessionTransition.kind === "start") {
      let storage;
      try { storage = inspectRunStorageTransition({ root: projectRoot }); }
      catch (error) {
        throw Object.assign(new Error(`Run start storage lineage cannot authorize execution: ${error.message}`, { cause: error }),
          { code: "RUNTIME_INVOCATION_LINEAGE_CONFLICT", causeCode: error.code });
      }
      if (storage.runId === runId && storage.status === "committed") return run;
      fail("Run start Session storage is not verified committed.", "RUNTIME_INVOCATION_RUN_TRANSITION_PENDING");
    }
    if (run.sessionTransition.kind === "finish") {
      fail("The Run has a prepared finish transition; recover that exact result before new execution.", "RUNTIME_INVOCATION_RUN_TRANSITION_PENDING");
    }
    fail("Active Run contains an invalid execution transition.", "RUNTIME_INVOCATION_LINEAGE_CONFLICT");
  }
  return run;
}

function lineage(root, artifactId, kind) {
  const artifact = readLineageArtifact({ root, artifactId }).artifact;
  if (artifact.kind !== kind) fail(`Expected ${kind}: ${artifactId}.`, "RUNTIME_INVOCATION_LINEAGE_KIND_MISMATCH");
  return artifact;
}

function runInvocationInput({ plan, contract, capsule }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "RuntimeExecutionInput",
    protocolVersion: RUNTIME_INVOCATION_AUTHORIZATION_VERSION,
    wholePlan: {
      wholePlanId: plan.wholePlanId,
      objective: plan.objective,
      plan: plan.plan,
      generation: plan.generation,
      invariants: plan.invariants,
    },
    executionContract: {
      executionContractId: contract.executionContractId,
      scope: contract.scope,
      acceptanceCriteria: contract.acceptanceCriteria,
      constraints: contract.constraints,
      allowedActions: contract.allowedActions,
      forbiddenActions: contract.forbiddenActions,
    },
    contextCapsule: capsule,
    returnContract: {
      kind: "ResultPacketDraft",
      requiredSections: ["outcome", "evidence", "planDelta", "impactRadius", "verification", "unknowns"],
      responseFormat: "single-json-object-only-no-markdown",
      wireResultShape: {
        schemaVersion: 1,
        kind: "RuntimeStructuredResult",
        protocolVersion: RUNTIME_STRUCTURED_RESULT_VERSION,
        outcome: "non-empty string",
        evidence: ["non-empty evidence strings"],
        planDelta: "string describing the completed plan delta",
        impactRadius: ["relative paths or bounded impact descriptions"],
        verification: ["non-empty verification strings"],
        unknowns: ["explicit remaining unknowns, or an empty array"],
      },
      transcriptIsNotResultPacket: true,
      evidenceInstructionAuthority: false,
    },
  };
}

function sessionInvocationInput({ request, capsule, requiredActions }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "RuntimeExecutionInput",
    protocolVersion: RUNTIME_INVOCATION_AUTHORIZATION_VERSION,
    sessionTask: {
      request,
      allowedActions: requiredActions,
      forbiddenActions: ["canon.mutate", "external.write", "deploy", "publish", "irreversible.delete"],
      localOnly: true,
      reversibleOnly: true,
    },
    contextCapsule: capsule,
    returnContract: {
      kind: "SessionResultDraft",
      requiredSections: ["outcome", "evidence", "planDelta", "impactRadius", "verification", "unknowns"],
      responseFormat: "single-json-object-only-no-markdown",
      fixedFields: { planDelta: "", impactRadius: [] },
      scopeInstruction: "This is a Session result, not a Run result. planDelta must be exactly the empty string and impactRadius must be exactly the empty array; these are fixed values, not examples. Describe local changes and their effects in outcome and evidence, and proposed file changes in patchProposal when present. Do not populate Run-only fields or create a Run to report this result.",
      wireResultShape: {
        schemaVersion: 1,
        kind: "RuntimeStructuredResult",
        protocolVersion: RUNTIME_STRUCTURED_RESULT_VERSION,
        outcome: "non-empty string",
        evidence: ["non-empty evidence strings"],
        planDelta: "",
        impactRadius: [],
        verification: ["non-empty verification strings"],
        unknowns: ["explicit remaining unknowns, or an empty array"],
      },
      freshHeadReviewRequired: false,
      transcriptIsNotResult: true,
      evidenceInstructionAuthority: false,
    },
  };
}

function normalizeScopeInput(value = { kind: "run" }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("Execution authorization scope must be an object.", "INVALID_EXECUTION_AUTHORIZATION_SCOPE");
  }
  const kind = String(value.kind || "").trim().toLowerCase();
  if (!EXECUTION_SCOPE_KINDS.includes(kind)) fail(`Unsupported execution scope: ${kind || "(empty)"}.`, "INVALID_EXECUTION_AUTHORIZATION_SCOPE");
  const allowed = kind === "session" ? new Set(["kind", "request", "contextCapsuleId"]) : new Set(["kind"]);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) fail(`Execution authorization scope contains unsupported fields: ${unexpected.sort().join(", ")}.`, "INVALID_EXECUTION_AUTHORIZATION_SCOPE");
  if (kind === "run") return { kind };
  const request = requiredText(value.request, "Session execution request", "INVALID_EXECUTION_AUTHORIZATION_SCOPE");
  const contextCapsuleId = value.contextCapsuleId == null ? null : requiredText(value.contextCapsuleId, "Session context capsule id", "INVALID_EXECUTION_AUTHORIZATION_SCOPE");
  if (contextCapsuleId !== null && !/^capsule-[a-f0-9]{24}$/.test(contextCapsuleId)) {
    fail("Session context capsule id is invalid.", "INVALID_EXECUTION_AUTHORIZATION_SCOPE");
  }
  return { kind, request, contextCapsuleId };
}

function authorizationFile(root, authorizationId, storage) {
  return path.join(root, formatForVerifiedOwner(storage).directory, "runtime", "execution-authorizations", `${authorizationId}.json`);
}

function verifyWorkerInput(worker, storage) {
  assertFields(worker, ["taskKey", "role", "outcome", "selectedContext", "sessionRequest", "sourceBasis", "previousAuthorizationId", ...(Object.hasOwn(worker || {}, "executionBoundary") ? ["executionBoundary"] : []), ...(Object.hasOwn(worker || {}, "writeBasis") ? ["writeBasis"] : []), ...(Object.hasOwn(worker || {}, "proposalBasis") ? ["proposalBasis"] : [])], "Worker execution input");
  if (!/^[a-z][a-z0-9-]{0,95}$/.test(worker.taskKey || "")
    || !/^[a-z][a-z0-9-]{0,63}$/.test(worker.role || "") || worker.role === formatForVerifiedOwner(storage).roleField
    || typeof worker.outcome !== "string" || !worker.outcome.trim()
    || typeof worker.selectedContext !== "string"
    || worker.previousAuthorizationId !== null && !/^execution-authorization-[a-f0-9]{24}$/.test(worker.previousAuthorizationId)
    || worker.sessionRequest !== null && (typeof worker.sessionRequest !== "string" || !worker.sessionRequest.trim())) {
    fail("Worker input requires a stable task key, non-HEAD role and bounded outcome.", "INVALID_WORKER_EXECUTION_INPUT");
  }
  return worker;
}

function attachWorkerInput(input, worker) {
  if (!worker) return input;
  return { ...input, protocolVersion: worker.proposalBasis ? PROPOSAL_WORKER_EXECUTION_AUTHORIZATION_VERSION : worker.writeBasis ? WRITE_BOUND_WORKER_EXECUTION_AUTHORIZATION_VERSION : worker.executionBoundary ? BOUND_WORKER_EXECUTION_AUTHORIZATION_VERSION : WORKER_EXECUTION_AUTHORIZATION_VERSION,
    ...(worker.proposalBasis ? { returnContract: { ...input.returnContract,
      requiredSections: [...input.returnContract.requiredSections, "patchProposal"],
      wireResultShape: { ...input.returnContract.wireResultShape, protocolVersion: RUNTIME_PATCH_PROPOSAL_RESULT_VERSION,
        patchProposal: { proposalBasisDigest: worker.executionBoundary.proposalBasisDigest,
          changes: [{ path: "exact relative path from boundedWorker.proposalBasis",
            after: "null for deletion, or an object with exactly contentBase64 (canonical base64) and mode (integer 0 through 511)" }] } },
      proposalOnly: true, applyFiles: false, proposalTargetsGrantWriteAuthority: false,
      emptyChangesAllowed: true, coreComputesCandidateDigests: true,
    } } : {}),
    boundedWorker: { taskKey: worker.taskKey, role: worker.role, outcome: worker.outcome,
      selectedContext: worker.selectedContext, expandsExecutionContract: false,
      sourceBasis: worker.sourceBasis,
      ...(worker.executionBoundary ? { executionBoundary: worker.executionBoundary } : {}),
      ...(worker.writeBasis ? { writeBasis: worker.writeBasis } : {}),
      ...(worker.proposalBasis ? { proposalBasis: worker.proposalBasis } : {}),
      effectivePermissionEvidence: false } };
}

function persistWorkerAuthorization(root, authorization, retry, storage) {
  return withProjectMutation({ root, scope: "worker-member-authorization" }, () => {
    const chain = readWorkerMemberChain(root, authorization).map(verifyRuntimeInvocationAuthorization);
    // Repair publication from frozen bytes before considering a new capture.
    for (const record of chain) {
      const published = authorizationFile(root, record.authorizationId, originalFormat(record));
      if (!fs.existsSync(published)) writeRuntimeInvocationArtifactExclusive(published, json(record));
      else if (readRuntimeInvocationAuthorization({ root, authorizationId: record.authorizationId }).authorization.authorizationHash !== record.authorizationHash) {
        fail("Worker authorization lookup conflicts with its frozen input.", "WORKER_MEMBER_AUTHORIZATION_CONFLICT");
      }
    }
    const current = chain.at(-1);
    if (current) {
      const payload = { ...authorization, workerInput: { ...authorization.workerInput, previousAuthorizationId: current.workerInput.previousAuthorizationId } };
      delete payload.authorizationId; delete payload.authorizationHash;
      const comparable = identify(payload, "execution-authorization", "authorizationId", "authorizationHash");
      if (comparable.authorizationHash === current.authorizationHash && !retry) return { status: "existing", file: authorizationFile(root, current.authorizationId, originalFormat(current)), authorization: current };
      let lease = inspectRuntimeExecutionLease({ projectRoot: root, projectId: current.projectId, authorizationId: current.authorizationId, storage: originalFormat(current) });
      if (!lease.singleUseConsumed && comparable.authorizationHash === current.authorizationHash) {
        return { status: "existing", file: authorizationFile(root, current.authorizationId, originalFormat(current)), authorization: current };
      }
      if (lease.status === "claimed") {
        try { lease = reconcileUnconsumedWorkerLease({ projectRoot: root, authorization: current }); }
        catch (error) {
          if (error.code !== "RUNTIME_EXECUTION_LEASE_BUSY") throw error;
          fail("Worker owner is active or cannot be proven absent; reprepare is not safe yet.", "WORKER_MEMBER_AUTHORIZATION_CONFLICT");
        }
      }
      if (lease.singleUseConsumed && !verifyRuntimeInvocationNeverStarted({ projectRoot: root, authorization: current }) || lease.status === "claimed") {
        fail("An active or consumed attempt requires verified terminal reconciliation before retry.", "WORKER_MEMBER_AUTHORIZATION_CONFLICT");
      }
      payload.workerInput.previousAuthorizationId = current.authorizationId;
      authorization = verifyRuntimeInvocationAuthorization(identify(payload, "execution-authorization", "authorizationId", "authorizationHash"));
    }
    const memberFile = workerMemberFile(root, authorization, current?.authorizationId || null);
    writeRuntimeInvocationArtifactExclusive(memberFile, json(authorization));
    const file = authorizationFile(root, authorization.authorizationId, storage);
    if (fs.existsSync(file)) {
      const existing = readRuntimeInvocationAuthorization({ root, authorizationId: authorization.authorizationId }).authorization;
      return { status: "existing", file, authorization: existing };
    }
    writeRuntimeInvocationArtifactExclusive(file, json(authorization));
    return { status: "recorded", file, authorization };
  });
}

export function reconcileWorkerMember({ root = ".", taskKey } = {}) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") fail("Worker member reconciliation requires a ready project.", "PROJECT_NOT_READY");
  if (!/^[a-z][a-z0-9-]{0,95}$/.test(taskKey || "")) fail("Worker task key is invalid.", "INVALID_WORKER_EXECUTION_INPUT");
  const basis = { kind: "ExecutionAuthorization", projectId: inspected.project.projectId, [formatForVerifiedOwner(inspected).sessionIdField]: inspected.state.sessionId,
    scope: { runId: inspected.state.activeRunId || null }, workerInput: { taskKey } };
  return withProjectMutation({ root, scope: "worker-member-authorization" }, () => {
    const records = readWorkerMemberChain(root, basis).map(verifyRuntimeInvocationAuthorization);
    if (!records.length) fail("No frozen input exists for this worker member.", "WORKER_MEMBER_NOT_FOUND");
    const recovered = [];
    for (const record of records) {
      const file = authorizationFile(root, record.authorizationId, originalFormat(record));
      if (!fs.existsSync(file)) { writeRuntimeInvocationArtifactExclusive(file, json(record)); recovered.push(record.authorizationId); }
      else if (readRuntimeInvocationAuthorization({ root, authorizationId: record.authorizationId }).authorization.authorizationHash !== record.authorizationHash) {
        fail("Published worker input conflicts with frozen member input.", "WORKER_MEMBER_AUTHORIZATION_CONFLICT");
      }
    }
    return { status: recovered.length ? "reconciled" : "existing", authorization: records.at(-1), recovered,
      providerInvoked: false, recoveryAuthority: false };
  });
}

export function buildRuntimeInvocationAuthorization({
  root = ".",
  runtime,
  scope = { kind: "run" },
  workspaceMode = "read-only",
  runtimeSelection = {},
  worker = null,
  retry = false,
  protocolEvidence,
  projectBinding,
  limits = {},
  persist = true,
} = {}) {
  const inspected = inspectProject(root);
  if (typeof retry !== "boolean" || retry && worker === null) fail("Worker retry must target a logical worker member.", "INVALID_WORKER_EXECUTION_INPUT");
  if (inspected.status !== "ready") fail(`Project must be ready for runtime invocation authorization; current status: ${inspected.status}.`, "PROJECT_NOT_READY");
  const selectedRuntime = normalizeRuntime(runtime);
  const selectedWorkspaceMode = normalizeWorkspaceMode(workspaceMode);
  const selectedRuntimeSelection = normalizeRuntimeSelection(runtimeSelection);
  const selectedScope = normalizeScopeInput(scope);
  if (!inspected.project.runtimes.includes(selectedRuntime)) fail("Runtime is not enabled for this HEAD project.", "RUNTIME_NOT_ENABLED_FOR_PROJECT");
  const projectRoot = inspected.project.projectRoot;
  const requiredActions = [REQUIRED_INVOKE_ACTION, WORKSPACE_ACTION[selectedWorkspaceMode]];
  let executionScope;
  let input;
  if (selectedScope.kind === "run") {
    if (!inspected.state.activeRunId || !inspected.state.activeExecutionContractId) {
      fail("Run execution authorization requires an active contract-bound Run.", "ACTIVE_CONTRACT_BOUND_RUN_REQUIRED");
    }
    const run = runCanon(projectRoot, inspected.state.activeRunId, inspected.storage);
    const contract = lineage(projectRoot, inspected.state.activeExecutionContractId, "ExecutionContract");
    const plan = lineage(projectRoot, contract.wholePlanId, "WholePlanSnapshot");
    const capsule = readContextCapsule({ root: projectRoot, capsuleId: contract.capsuleId }).capsule;
    if (run.executionContractId !== contract.executionContractId || run.wholePlanId !== plan.wholePlanId || run.capsuleId !== capsule.capsuleId) {
      fail("Active Run, ExecutionContract, WholePlanSnapshot, and ContextCapsule do not compose.", "RUNTIME_INVOCATION_LINEAGE_CONFLICT");
    }
    const allowed = new Set(contract.allowedActions || []);
    assertProjectActionsCurrent({ root: projectRoot, actions: contract.allowedActions || [] });
    const forbidden = new Set(contract.forbiddenActions || []);
    if (requiredActions.some((action) => !allowed.has(action)) || requiredActions.some((action) => forbidden.has(action))) {
      fail(`ExecutionContract must allow ${requiredActions.join(" and ")} and must not forbid either action.`, "RUNTIME_INVOCATION_NOT_AUTHORIZED");
    }
    executionScope = {
      kind: "run",
      userRequestDigest: null,
      userRequestBytes: null,
      runId: run.runId,
      wholePlanId: plan.wholePlanId,
      executionContractId: contract.executionContractId,
      contextCapsuleId: capsule.capsuleId,
    };
    input = runInvocationInput({ plan, contract, capsule });
  } else {
    if (inspected.state.mode !== "session" || inspected.state.activeRunId || inspected.state.activeExecutionContractId || inspected.state.pendingReview) {
      fail("Session execution authorization requires an idle HEAD Session with no active Run or pending review.", "SESSION_EXECUTION_STATE_CONFLICT");
    }
    const capsule = selectedScope.contextCapsuleId === null
      ? null : readContextCapsule({ root: projectRoot, capsuleId: selectedScope.contextCapsuleId }).capsule;
    executionScope = {
      kind: "session",
      userRequestDigest: digest(selectedScope.request),
      userRequestBytes: Buffer.byteLength(selectedScope.request),
      runId: null,
      wholePlanId: null,
      executionContractId: null,
      contextCapsuleId: capsule?.capsuleId || null,
    };
    input = sessionInvocationInput({ request: selectedScope.request, capsule, requiredActions });
  }
  const verifiedProtocol = verifyRuntimeProtocolEvidence(protocolEvidence);
  const verifiedBinding = verifyRuntimeProjectBinding(projectBinding);
  const runtimeObservation = verifiedProtocol.observations.find((item) => item.runtime === selectedRuntime);
  const runtimeBinding = verifiedBinding.bindings.find((item) => item.runtime === selectedRuntime);
  const rootDigest = digest(realRoot(projectRoot));
  const bindingMismatches = [
    verifiedBinding.projectId !== inspected.project.projectId ? "project" : null,
    sessionIdOf(verifiedBinding) !== inspected.state.sessionId ? "session" : null,
    verifiedBinding.projectRootDigest !== rootDigest ? "root" : null,
    verifiedBinding.protocolEvidenceId !== verifiedProtocol.evidenceId ? "protocol" : null,
    verifiedBinding.status !== formatForVerifiedOwner(inspected).value("verified-head-project-session-capability-binding") ? "status" : null,
    runtimeBinding?.capabilityStatus !== "observed" ? "runtime-binding" : null,
    !runtimeObservation?.protocolNegotiationObserved ? "runtime-observation" : null,
  ].filter(Boolean);
  if (bindingMismatches.length > 0) {
    fail(`Runtime capability evidence is not an exact verified binding for this project, Session, and runtime (${bindingMismatches.join(", ")}).`, "RUNTIME_INVOCATION_CAPABILITY_BINDING_INVALID");
  }
  const normalizedLimits = normalizeLimits(limits);
  let workerInput = null;
  if (worker !== null) {
    const selection = { sourcePaths: [], ...worker };
    const proposalWorker = isWorkerPatchProposalMode(selection.executionBoundary?.mode);
    assertFields(selection, ["taskKey", "role", "outcome", "selectedContext", "sourcePaths", ...(Object.hasOwn(selection, "executionBoundary") ? ["executionBoundary"] : []), ...(proposalWorker ? ["proposalPaths"] : [])], "Worker selection");
    const { sourcePaths, proposalPaths, ...brief } = selection;
    const sourceBasis = captureWorkerSourceBasis({ root: projectRoot, paths: sourcePaths, maxBytes: normalizedLimits.maxInputBytes, storage: inspected.storage });
    const writeBasis = brief.executionBoundary?.writeBasisDigest === undefined ? null
      : captureWorkerWriteBasis({ root: projectRoot, paths: brief.executionBoundary.ownedPaths, maxBytes: normalizedLimits.maxInputBytes, storage: inspected.storage });
    const proposalBasis = proposalWorker ? captureWorkerWriteBasis({ root: projectRoot, paths: proposalPaths, maxBytes: normalizedLimits.maxInputBytes, storage: inspected.storage }) : null;
    workerInput = verifyWorkerInput({ ...brief, sourceBasis, ...(writeBasis !== null ? { writeBasis } : {}), ...(proposalBasis !== null ? { proposalBasis } : {}), sessionRequest: selectedScope.kind === "session" ? selectedScope.request : null, previousAuthorizationId: null }, inspected.storage);
    if (proposalWorker) verifyWorkerPatchProposalExecutionBoundary(workerInput.executionBoundary, sourceBasis, selectedWorkspaceMode, proposalBasis, normalizedLimits.maxInputBytes, inspected.storage);
    else if (Object.hasOwn(workerInput, "executionBoundary")) verifyWorkerExecutionBoundary(workerInput.executionBoundary, sourceBasis, selectedWorkspaceMode, writeBasis, normalizedLimits.maxInputBytes, inspected.storage);
    const roleFile = path.join(projectRoot, formatForVerifiedOwner(inspected).directory, "roles", `${workerInput.role}.md`);
    if (!fs.existsSync(roleFile) || !fs.lstatSync(roleFile).isFile() || fs.lstatSync(roleFile).isSymbolicLink()) {
      fail("Worker role must be registered before input authorization.", "INVALID_BOUNDED_WORKER_ROLE");
    }
    input = attachWorkerInput(input, workerInput);
  }
  const currentProjectDirection = readProjectDirection({ root: projectRoot });
  if (currentProjectDirection) input = { ...input, currentProjectDirection };
  const inputBytes = Buffer.byteLength(canonicalJson(input));
  if (inputBytes > normalizedLimits.maxInputBytes) fail("Runtime execution input exceeds the accepted input bound.", "RUNTIME_INVOCATION_INPUT_LIMIT");
  const payload = {
    schemaVersion: 1,
    kind: "ExecutionAuthorization",
    // Absence is not a new direction or grant. Keep the original payload/ID so
    // an already-consumed authorization cannot be replayed under a null field.
    ...(currentProjectDirection ? { currentProjectDirectionId: currentProjectDirection.directionId } : {}),
    protocolVersion: workerInput?.proposalBasis ? PROPOSAL_WORKER_EXECUTION_AUTHORIZATION_VERSION : workerInput?.writeBasis ? WRITE_BOUND_WORKER_EXECUTION_AUTHORIZATION_VERSION : workerInput?.executionBoundary ? BOUND_WORKER_EXECUTION_AUTHORIZATION_VERSION : workerInput ? WORKER_EXECUTION_AUTHORIZATION_VERSION : RUNTIME_INVOCATION_AUTHORIZATION_VERSION,
    ...(workerInput ? { workerInput } : {}),
    projectId: inspected.project.projectId,
    [formatForVerifiedOwner(inspected).sessionIdField]: inspected.state.sessionId,
    scope: executionScope,
    runtime: selectedRuntime,
    workspaceMode: selectedWorkspaceMode,
    runtimeSelection: selectedRuntimeSelection,
    requiredAllowedActions: requiredActions,
    projectRootDigest: rootDigest,
    runtimeProjectBindingId: verifiedBinding.bindingId,
    runtimeProtocolEvidenceId: verifiedProtocol.evidenceId,
    runtimeProtocolObservationId: runtimeObservation.observationId,
    executionInput: {
      digest: digest(canonicalJson(input)),
      bytes: inputBytes,
      transport: "bounded-stdin-required",
      retention: workerInput ? "authorization-selected-input" : "ephemeral-only",
      includesContextCapsule: executionScope.contextCapsuleId !== null,
      rawContentPersisted: workerInput !== null,
    },
    limits: normalizedLimits,
    authorizationBoundary: {
      acceptedContractDerived: executionScope.kind === "run",
      exactActiveRunRequired: executionScope.kind === "run",
      idleSessionRequired: executionScope.kind === "session",
      contextCapsuleRequired: executionScope.kind === "run",
      projectFenceRequired: true,
      callerFenceRequiredAtExecution: true,
      exactChildOwnershipRequired: true,
      descendantTreeOwnershipRequiredForProviderControl: true,
      providerEventValidationRequired: true,
      freshHeadReviewRequired: executionScope.kind === "run",
      capabilityDoesNotGrantAuthorization: true,
      singleInvocationExecutionLeaseRequired: true,
      executionLeaseActivated: false,
      providerControlEnabled: false,
    },
    authority: "scope-bounded-single-invocation-authorization",
    instructionAuthority: false,
    promotionAuthority: false,
    mutatesCanon: false,
  };
  const authorization = verifyRuntimeInvocationAuthorization(identify(
    payload,
    "execution-authorization",
    "authorizationId",
    "authorizationHash",
  ));
  if (!persist) return { status: "preview", authorization };
  if (workerInput) return persistWorkerAuthorization(projectRoot, authorization, retry, inspected.storage);
  const file = authorizationFile(projectRoot, authorization.authorizationId, inspected.storage);
  if (fs.existsSync(file)) {
    return { status: "existing", file, authorization: readRuntimeInvocationAuthorization({ root: projectRoot, authorizationId: authorization.authorizationId }).authorization };
  }
  atomicWrite(file, json(authorization));
  return { status: "recorded", file, authorization };
}

export function verifyRuntimeInvocationAuthorization(document) {
  const format = originalFormat(document);
  const legacyAuthorization = document?.protocolVersion === LEGACY_EXECUTION_AUTHORIZATION_VERSION;
  const proposalWorker = document?.protocolVersion === PROPOSAL_WORKER_EXECUTION_AUTHORIZATION_VERSION;
  const writeBoundWorker = document?.protocolVersion === WRITE_BOUND_WORKER_EXECUTION_AUTHORIZATION_VERSION;
  const boundWorker = proposalWorker || writeBoundWorker || document?.protocolVersion === BOUND_WORKER_EXECUTION_AUTHORIZATION_VERSION;
  const workerAuthorization = boundWorker || document?.protocolVersion === WORKER_EXECUTION_AUTHORIZATION_VERSION;
  assertFields(document, [
    "schemaVersion", "kind", "protocolVersion", "projectId", (format?.sessionIdField || "headSessionId"), "scope", "runtime", "workspaceMode", "requiredAllowedActions",
    "projectRootDigest", "runtimeProjectBindingId", "runtimeProtocolEvidenceId", "runtimeProtocolObservationId",
    "executionInput", "limits", "authorizationBoundary", "authority", "instructionAuthority", "promotionAuthority",
    "mutatesCanon", "authorizationId", "authorizationHash", ...(legacyAuthorization ? [] : ["runtimeSelection"]),
    ...(Object.hasOwn(document || {}, "currentProjectDirectionId") ? ["currentProjectDirectionId"] : []),
    ...(workerAuthorization ? ["workerInput"] : []),
  ], "Runtime invocation authorization");
  assertFields(document.scope, [
    "kind", "userRequestDigest", "userRequestBytes", "runId", "wholePlanId", "executionContractId", "contextCapsuleId",
  ], "Execution authorization scope");
  assertFields(document.executionInput, [
    "digest", "bytes", "transport", "retention", "includesContextCapsule", "rawContentPersisted",
  ], "Runtime invocation execution input");
  assertFields(document.authorizationBoundary, [
    "acceptedContractDerived", "exactActiveRunRequired", "idleSessionRequired", "contextCapsuleRequired", "projectFenceRequired", "callerFenceRequiredAtExecution",
    "exactChildOwnershipRequired", "descendantTreeOwnershipRequiredForProviderControl", "providerEventValidationRequired",
    "freshHeadReviewRequired", "capabilityDoesNotGrantAuthorization", "singleInvocationExecutionLeaseRequired",
    "executionLeaseActivated", "providerControlEnabled",
  ], "Runtime invocation authorization boundary");
  const runtime = normalizeRuntime(document.runtime);
  if (Object.hasOwn(document, "currentProjectDirectionId") && document.currentProjectDirectionId !== null
    && !/^direction-[a-f0-9]{24}$/.test(document.currentProjectDirectionId || "")) fail("Invalid common Project direction basis.", "INVALID_RUNTIME_INVOCATION_AUTHORIZATION");
  const workspaceMode = normalizeWorkspaceMode(document.workspaceMode);
  const runtimeSelection = legacyAuthorization ? { model: null } : normalizeRuntimeSelection(document.runtimeSelection);
  const expectedActions = [REQUIRED_INVOKE_ACTION, WORKSPACE_ACTION[workspaceMode]];
  const scopeKind = String(document.scope.kind || "").trim().toLowerCase();
  if (!EXECUTION_SCOPE_KINDS.includes(scopeKind)) fail("Execution authorization scope is invalid.", "INVALID_RUNTIME_INVOCATION_AUTHORIZATION");
  const runScope = scopeKind === "run";
  if (workerAuthorization) {
    const worker = verifyWorkerInput(document.workerInput, format);
    verifyWorkerSourceBasis(worker.sourceBasis, normalizeLimits(document.limits).maxInputBytes, format);
    if (boundWorker !== Object.hasOwn(worker, "executionBoundary")) fail("Worker execution boundary version differs.", "INVALID_WORKER_EXECUTION_INPUT");
    if (writeBoundWorker !== Object.hasOwn(worker, "writeBasis")
      || writeBoundWorker !== Object.hasOwn(worker.executionBoundary || {}, "writeBasisDigest")) fail("Worker write basis version differs.", "INVALID_WORKER_EXECUTION_INPUT");
    if (proposalWorker !== Object.hasOwn(worker, "proposalBasis")
      || proposalWorker !== isWorkerPatchProposalMode(worker.executionBoundary?.mode)) fail("Worker proposal basis version differs.", "INVALID_WORKER_EXECUTION_INPUT");
    if (proposalWorker) verifyWorkerPatchProposalExecutionBoundary(worker.executionBoundary, worker.sourceBasis, workspaceMode, worker.proposalBasis, normalizeLimits(document.limits).maxInputBytes, format);
    else if (boundWorker) verifyWorkerExecutionBoundary(worker.executionBoundary, worker.sourceBasis, workspaceMode, worker.writeBasis ?? null, normalizeLimits(document.limits).maxInputBytes, format);
    if (Buffer.byteLength(canonicalJson(worker)) > normalizeLimits(document.limits).maxInputBytes) {
      fail("Retained worker input exceeds its authorization bound.", "RUNTIME_INVOCATION_INPUT_LIMIT");
    }
    if (runScope ? worker.sessionRequest !== null
      : digest(worker.sessionRequest || "") !== document.scope.userRequestDigest
        || Buffer.byteLength(worker.sessionRequest || "") !== document.scope.userRequestBytes) {
      fail("Retained worker request differs from its authorized scope.", "RUNTIME_INVOCATION_INPUT_DRIFT");
    }
  }
  const expectedBoundary = {
    acceptedContractDerived: runScope,
    exactActiveRunRequired: runScope,
    idleSessionRequired: !runScope,
    contextCapsuleRequired: runScope,
    projectFenceRequired: true,
    callerFenceRequiredAtExecution: true,
    exactChildOwnershipRequired: true,
    descendantTreeOwnershipRequiredForProviderControl: true,
    providerEventValidationRequired: true,
    freshHeadReviewRequired: runScope,
    capabilityDoesNotGrantAuthorization: true,
    singleInvocationExecutionLeaseRequired: true,
    executionLeaseActivated: false,
    providerControlEnabled: false,
  };
  if (document.schemaVersion !== 1 || document.kind !== "ExecutionAuthorization"
    || !new Set([RUNTIME_INVOCATION_AUTHORIZATION_VERSION, LEGACY_EXECUTION_AUTHORIZATION_VERSION, WORKER_EXECUTION_AUTHORIZATION_VERSION, BOUND_WORKER_EXECUTION_AUTHORIZATION_VERSION, WRITE_BOUND_WORKER_EXECUTION_AUTHORIZATION_VERSION, PROPOSAL_WORKER_EXECUTION_AUTHORIZATION_VERSION]).has(document.protocolVersion)
    || document.runtime !== runtime
    || document.workspaceMode !== workspaceMode || canonicalJson(document.requiredAllowedActions) !== canonicalJson(expectedActions)
    || !legacyAuthorization && canonicalJson(document.runtimeSelection) !== canonicalJson(runtimeSelection)
    || (!format || !new RegExp(`^${format.projectPrefix}[a-f0-9]{20}$`).test(document.projectId || ""))
    || !/^session-[A-Fa-f0-9-]{36}$/.test(sessionIdOf(document) || "")
    || (runScope && (!/^run-[0-9]+-[a-f0-9]{6}$/.test(document.scope.runId || "")
      || !/^whole-plan-[a-f0-9]{24}$/.test(document.scope.wholePlanId || "")
      || !/^execution-contract-[a-f0-9]{24}$/.test(document.scope.executionContractId || "")
      || !/^capsule-[a-f0-9]{24}$/.test(document.scope.contextCapsuleId || "")
      || document.scope.userRequestDigest !== null || document.scope.userRequestBytes !== null))
    || (!runScope && (!/^[a-f0-9]{64}$/.test(document.scope.userRequestDigest || "")
      || !Number.isSafeInteger(document.scope.userRequestBytes) || document.scope.userRequestBytes < 1
      || document.scope.runId !== null || document.scope.wholePlanId !== null || document.scope.executionContractId !== null
      || document.scope.contextCapsuleId !== null && !/^capsule-[a-f0-9]{24}$/.test(document.scope.contextCapsuleId || "")))
    || !/^[a-f0-9]{64}$/.test(document.projectRootDigest || "")
    || !/^runtime-project-binding-[a-f0-9]{24}$/.test(document.runtimeProjectBindingId || "")
    || !/^runtime-protocol-evidence-[a-f0-9]{24}$/.test(document.runtimeProtocolEvidenceId || "")
    || !/^runtime-protocol-observation-[a-f0-9]{24}$/.test(document.runtimeProtocolObservationId || "")
    || !/^[a-f0-9]{64}$/.test(document.executionInput.digest || "")
    || !Number.isSafeInteger(document.executionInput.bytes) || document.executionInput.bytes < 1
    || document.executionInput.transport !== "bounded-stdin-required"
    || document.executionInput.retention !== (workerAuthorization ? "authorization-selected-input" : "ephemeral-only")
    || document.executionInput.includesContextCapsule !== (document.scope.contextCapsuleId !== null) || document.executionInput.rawContentPersisted !== workerAuthorization
    || canonicalJson(document.limits) !== canonicalJson(normalizeLimits(document.limits))
    || canonicalJson(document.authorizationBoundary) !== canonicalJson(expectedBoundary)
    || document.authority !== "scope-bounded-single-invocation-authorization"
    || document.instructionAuthority !== false || document.promotionAuthority !== false || document.mutatesCanon !== false) {
    fail("Runtime invocation authorization is invalid.", "INVALID_RUNTIME_INVOCATION_AUTHORIZATION");
  }
  verifyIdentity(document, {
    prefix: "execution-authorization",
    idKey: "authorizationId",
    hashKey: "authorizationHash",
    code: "RUNTIME_INVOCATION_AUTHORIZATION_DIGEST_MISMATCH",
  });
  return document;
}

// Internal pure composition for historical read projections. No current-state,
// source-freshness, lease or execution operation is invoked here. Callers must
// verify the exact selected originals and compare the final bytes and digest.
export function runtimeInvocationInputFromOriginals({ authorization, plan, contract, capsule = null, direction = null } = {}) {
  const verified = verifyRuntimeInvocationAuthorization(authorization);
  if (verified.scope.kind === "session" && !verified.workerInput) return null;
  let input = verified.scope.kind === "run" ? runInvocationInput({ plan, contract, capsule })
    : sessionInvocationInput({ request: verified.workerInput.sessionRequest, capsule, requiredActions: verified.requiredAllowedActions });
  input = attachWorkerInput(input, verified.workerInput);
  if (direction) input = { ...input, currentProjectDirection: direction };
  return Buffer.from(canonicalJson(input), "utf8");
}

export function readRuntimeInvocationAuthorization({ root = ".", authorizationId } = {}) {
  if (!/^execution-authorization-[a-f0-9]{24}$/.test(authorizationId || "")) {
    fail("Runtime invocation authorization id is invalid.", "INVALID_RUNTIME_INVOCATION_AUTHORIZATION_ID");
  }
  const inspected = inspectProject(root);
  if (inspected.status === "not_initialized") fail("Lode Agent Core is not initialized.", "NOT_INITIALIZED");
  const file = authorizationFile(inspected.project.projectRoot, authorizationId, inspected.storage);
  if (!fs.existsSync(file)) fail(`Runtime invocation authorization not found: ${authorizationId}.`, "RUNTIME_INVOCATION_AUTHORIZATION_NOT_FOUND");
  const authorization = verifyRuntimeInvocationAuthorization(readJson(file, "Runtime invocation authorization"));
  if (authorization.projectId !== inspected.project.projectId) fail("Runtime invocation authorization belongs to another project.", "RUNTIME_INVOCATION_PROJECT_MISMATCH");
  return { status: "verified", file, authorization };
}

export function inspectRuntimeInvocationExecutionLease({ root = ".", authorizationId } = {}) {
  const inspected = inspectProject(root);
  if (inspected.status === "not_initialized") fail("Lode Agent Core is not initialized.", "NOT_INITIALIZED");
  const authorization = readRuntimeInvocationAuthorization({ root: inspected.project.projectRoot, authorizationId }).authorization;
  const recordedReceiptFile = path.join(
    inspected.project.projectRoot,
    formatForVerifiedOwner(inspected).directory, "runtime", "invocations", authorization.authorizationId, "receipt.json",
  );
  const recordedReceipt = fs.existsSync(recordedReceiptFile)
    ? verifyRuntimeInvocationLifecycleReceipt(readJson(recordedReceiptFile, "Runtime invocation lifecycle receipt"))
    : null;
  if (recordedReceipt && recordedReceipt.authorizationId !== authorization.authorizationId) {
    fail("Recorded runtime invocation receipt belongs to another authorization.", "RUNTIME_INVOCATION_RECORD_CONFLICT");
  }
  return {
    status: "verified",
    authorizationId: authorization.authorizationId,
    projectId: authorization.projectId,
    [originalFormat(authorization).sessionIdField]: sessionIdOf(authorization),
    scope: authorization.scope,
    runtime: authorization.runtime,
    lease: inspectRuntimeExecutionLease({
      projectRoot: inspected.project.projectRoot,
      storage: inspected.storage,
      projectId: inspected.project.projectId,
      authorizationId: authorization.authorizationId,
    }),
    providerInvoked: recordedReceipt?.providerBoundary.actualProviderInvoked || false,
    providerMode: recordedReceipt?.providerBoundary.mode || null,
    boundedOneShotInvocationEnabled: recordedReceipt?.providerBoundary.boundedOneShotInvocationEnabled || false,
    providerControlEnabled: false,
  };
}

// Integration must revalidate current authority and retained input even after
// its own file effects changed preimages. It must separately verify exact
// per-path pre/post journal state; this read is not permission to execute.
export function verifyRuntimeInvocationCurrentLineage(input = {}) {
  const prepared = prepareRuntimeInvocationInput(input, false);
  return { ...prepared, sourceBasisVerified: false, executionPrepared: false };
}

export function prepareRuntimeInvocationExecution(input = {}) {
  return prepareRuntimeInvocationInput(input, true);
}

function prepareRuntimeInvocationInput({ root = ".", authorization, sessionRequest = "" } = {}, verifyCurrentSources) {
  const verified = verifyRuntimeInvocationAuthorization(authorization);
  const inspected = inspectProject(root);
  if (inspected.status !== "ready" || inspected.project.projectId !== verified.projectId || inspected.state.sessionId !== sessionIdOf(verified)) {
    fail("Runtime execution requires the authorization's exact project and HEAD Session.", "RUNTIME_INVOCATION_FENCE_MISMATCH");
  }
  if (verified.scope.kind === "run" && (inspected.state.activeRunId !== verified.scope.runId
    || inspected.state.activeExecutionContractId !== verified.scope.executionContractId
    || inspected.state.currentWholePlanId !== verified.scope.wholePlanId
    || inspected.state.mode !== "run" || inspected.state.pendingReview)) {
    fail("Run execution requires the authorization's exact active Run, WholePlan and ExecutionContract.", "RUNTIME_INVOCATION_FENCE_MISMATCH");
  }
  if (verified.scope.kind === "session" && (inspected.state.mode !== "session" || inspected.state.activeRunId
    || inspected.state.activeExecutionContractId || inspected.state.pendingReview)) {
    fail("Session execution requires the authorization's idle HEAD Session.", "RUNTIME_INVOCATION_FENCE_MISMATCH");
  }
  const projectRoot = inspected.project.projectRoot;
  if (digest(realRoot(projectRoot)) !== verified.projectRootDigest) fail("Runtime invocation project root changed after authorization.", "RUNTIME_INVOCATION_PROJECT_DRIFT");
  const currentProjectDirection = assertAuthorizationProjectDirection(projectRoot, verified);
  assertProjectActionsCurrent({ root: projectRoot, actions: verified.requiredAllowedActions });
  if (verified.workerInput) {
    requireCurrentWorkerMember(projectRoot, verified);
    if (verifyCurrentSources) {
      requireCurrentWorkerSourceBasis({ root: projectRoot, basis: verified.workerInput.sourceBasis, maxBytes: verified.limits.maxInputBytes, storage: inspected.storage });
      if (verified.workerInput.writeBasis) requireCurrentWorkerWriteBasis({ root: projectRoot, basis: verified.workerInput.writeBasis, maxBytes: verified.limits.maxInputBytes, storage: inspected.storage });
      if (verified.workerInput.proposalBasis) requireCurrentWorkerWriteBasis({ root: projectRoot, basis: verified.workerInput.proposalBasis, maxBytes: verified.limits.maxInputBytes, storage: inspected.storage });
    }
    if (sessionRequest && sessionRequest !== verified.workerInput.sessionRequest) fail("Worker Session request changed.", "RUNTIME_INVOCATION_INPUT_DRIFT");
    sessionRequest = verified.workerInput.sessionRequest || "";
  }
  let executionInput;
  if (verified.scope.kind === "run") {
    const run = runCanon(projectRoot, verified.scope.runId, inspected.storage);
    const contract = lineage(projectRoot, verified.scope.executionContractId, "ExecutionContract");
    assertProjectActionsCurrent({ root: projectRoot, actions: contract.allowedActions || [] });
    const plan = lineage(projectRoot, verified.scope.wholePlanId, "WholePlanSnapshot");
    const capsule = readContextCapsule({ root: projectRoot, capsuleId: verified.scope.contextCapsuleId }).capsule;
    if (run.executionContractId !== contract.executionContractId || run.wholePlanId !== plan.wholePlanId
      || run.capsuleId !== capsule.capsuleId || contract.wholePlanId !== plan.wholePlanId
      || contract.capsuleId !== capsule.capsuleId) {
      fail("Current Run, ExecutionContract, WholePlanSnapshot and ContextCapsule do not compose.", "RUNTIME_INVOCATION_LINEAGE_CONFLICT");
    }
    executionInput = runInvocationInput({ plan, contract, capsule });
  } else {
    const request = requiredText(sessionRequest, "Session execution request", "RUNTIME_INVOCATION_INPUT_DRIFT");
    if (digest(request) !== verified.scope.userRequestDigest || Buffer.byteLength(request) !== verified.scope.userRequestBytes) {
      fail("Session execution request changed after authorization.", "RUNTIME_INVOCATION_INPUT_DRIFT");
    }
    const capsule = verified.scope.contextCapsuleId === null
      ? null : readContextCapsule({ root: projectRoot, capsuleId: verified.scope.contextCapsuleId }).capsule;
    executionInput = sessionInvocationInput({ request, capsule, requiredActions: verified.requiredAllowedActions });
  }
  executionInput = attachWorkerInput(executionInput, verified.workerInput);
  if (currentProjectDirection) executionInput = { ...executionInput, currentProjectDirection };
  const input = Buffer.from(canonicalJson(executionInput), "utf8");
  if (input.length !== verified.executionInput.bytes || digest(input) !== verified.executionInput.digest) {
    fail("Runtime execution input changed after authorization.", "RUNTIME_INVOCATION_INPUT_DRIFT");
  }
  return { authorization: verified, inspected, projectRoot, executionInput, input };
}

function eventType(record) {
  for (const key of ["type", "eventType", "kind"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim().slice(0, 128);
  }
  return "unknown";
}

function eventClass(type) {
  const value = type.toLowerCase();
  if (/error|fail/.test(value)) return "error";
  if (/assistant|message|output|text/.test(value)) return "assistant-output";
  if (/tool|command|file|patch|edit/.test(value)) return "tool-observation";
  if (/usage|metric|token/.test(value)) return "usage";
  if (/session|thread|turn|start|complete|finish|close/.test(value)) return "lifecycle";
  return "unknown";
}

function sessionReferences(record) {
  const found = [];
  const visit = (value, depth = 0) => {
    if (!value || depth > 4) return;
    if (Array.isArray(value)) return value.slice(0, 64).forEach((item) => visit(item, depth + 1));
    if (typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (["thread_id", "session_id", "sessionid", "threadid"].includes(key.toLowerCase())
        && typeof item === "string" && item.trim()) found.push(item.trim());
      else visit(item, depth + 1);
    }
  };
  visit(record);
  return [...new Set(found)].sort(compareText);
}

export function normalizeRuntimeEvent({ authorization, sequence, line } = {}) {
  const verified = verifyRuntimeInvocationAuthorization(authorization);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= verified.limits.maxEvents) {
    fail("Runtime event sequence exceeds the authorization bound.", "RUNTIME_EVENT_LIMIT");
  }
  if (typeof line !== "string" || !line.trim()) fail("Runtime event line is empty.", "INVALID_RUNTIME_EVENT");
  const bytes = Buffer.byteLength(line);
  if (bytes > verified.limits.maxEventBytes) fail("Runtime event exceeds the per-event bound.", "RUNTIME_EVENT_OUTPUT_LIMIT");
  let record;
  try { record = JSON.parse(line); }
  catch { fail("Runtime emitted non-JSON event output.", "INVALID_RUNTIME_EVENT_JSON"); }
  if (!record || typeof record !== "object" || Array.isArray(record)) fail("Runtime event must be one JSON object.", "INVALID_RUNTIME_EVENT");
  const canonical = canonicalJson(record);
  const type = eventType(record);
  const references = sessionReferences(record).map((value) => digest(`${verified.authorizationId}\n${value}`));
  const payload = {
    schemaVersion: 1,
    kind: "RuntimeEventEnvelope",
    protocolVersion: RUNTIME_EVENT_ENVELOPE_VERSION,
    authorizationId: verified.authorizationId,
    runtime: verified.runtime,
    sequence,
    eventType: type,
    eventClass: eventClass(type),
    payloadDigest: digest(canonical),
    payloadBytes: Buffer.byteLength(canonical),
    providerSessionReferenceDigests: references,
    rawPayloadPersisted: false,
    transcriptAuthority: "none",
    instructionAuthority: false,
    promotionAuthority: false,
  };
  return verifyRuntimeEventEnvelope(identify(payload, "runtime-event", "eventId", "eventHash"));
}

export function verifyRuntimeEventEnvelope(document) {
  assertFields(document, [
    "schemaVersion", "kind", "protocolVersion", "authorizationId", "runtime", "sequence", "eventType",
    "eventClass", "payloadDigest", "payloadBytes", "providerSessionReferenceDigests", "rawPayloadPersisted",
    "transcriptAuthority", "instructionAuthority", "promotionAuthority", "eventId", "eventHash",
  ], "Runtime event envelope");
  const allowedClasses = new Set(["error", "lifecycle", "assistant-output", "tool-observation", "usage", "unknown"]);
  if (document.schemaVersion !== 1 || document.kind !== "RuntimeEventEnvelope"
    || document.protocolVersion !== RUNTIME_EVENT_ENVELOPE_VERSION
    || !/^execution-authorization-[a-f0-9]{24}$/.test(document.authorizationId || "")
    || document.runtime !== normalizeRuntime(document.runtime)
    || !Number.isSafeInteger(document.sequence) || document.sequence < 0
    || typeof document.eventType !== "string" || !document.eventType || document.eventType.length > 128
    || !allowedClasses.has(document.eventClass) || document.eventClass !== eventClass(document.eventType)
    || !/^[a-f0-9]{64}$/.test(document.payloadDigest || "")
    || !Number.isSafeInteger(document.payloadBytes) || document.payloadBytes < 2
    || !Array.isArray(document.providerSessionReferenceDigests)
    || canonicalJson(document.providerSessionReferenceDigests) !== canonicalJson([...new Set(document.providerSessionReferenceDigests)].sort(compareText))
    || document.providerSessionReferenceDigests.some((item) => !/^[a-f0-9]{64}$/.test(item))
    || document.rawPayloadPersisted !== false || document.transcriptAuthority !== "none"
    || document.instructionAuthority !== false || document.promotionAuthority !== false) {
    fail("Runtime event envelope is invalid.", "INVALID_RUNTIME_EVENT_ENVELOPE");
  }
  verifyIdentity(document, { prefix: "runtime-event", idKey: "eventId", hashKey: "eventHash", code: "RUNTIME_EVENT_DIGEST_MISMATCH" });
  return document;
}

function providerModeProfile(runtime, providerMode) {
  const selectedRuntime = String(runtime || "").trim().toLowerCase();
  const fixtureMode = providerMode === "conformance-fixture" || providerMode === `${selectedRuntime}-protocol-fixture`;
  const actualProvider = providerMode === `actual-${selectedRuntime}`;
  return { fixtureMode, actualProvider, valid: fixtureMode || actualProvider };
}

function lifecycleSummary({ authorization, events, status, exitCode, signal, stdoutBytes, stderrBytes, stdoutDigest, stderrDigest,
  callerFenceDigest, childFenceDigest, childStarted, childExitObserved, terminationRequested, projectFenceValidated,
  inputDigestObserved, noDescendantFixture, descendantTreeOwnershipValidated = false, consumption,
  providerMode = "conformance-fixture", providerSessionCreated = false, providerDiagnosticCodes = [], structuredResult = null,
  supervision = null }) {
  const eventIds = events.map((item) => item.eventId);
  const eventTypes = [...new Set(events.map((item) => item.eventType))].sort(compareText);
  const unknownEventTypes = [...new Set(events.filter((item) => item.eventClass === "unknown").map((item) => item.eventType))].sort(compareText);
  const providerSessionReferenceDigests = [...new Set(events.flatMap((item) => item.providerSessionReferenceDigests))].sort(compareText);
  const normalizedProviderDiagnosticCodes = [...new Set(providerDiagnosticCodes)].sort(compareText);
  if (normalizedProviderDiagnosticCodes.length > 32
    || normalizedProviderDiagnosticCodes.some((item) => typeof item !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(item))) {
    fail("Runtime provider diagnostic codes are invalid.", "INVALID_RUNTIME_PROVIDER_DIAGNOSTICS");
  }
  const { fixtureMode, actualProvider, valid } = providerModeProfile(authorization.runtime, providerMode);
  if (!valid) fail("Runtime provider mode is invalid.", "INVALID_RUNTIME_PROVIDER_MODE");
  const verifiedResult = structuredResult === null ? null : verifyRuntimeStructuredResult(structuredResult, { scopeKind: authorization.scope.kind, authorization });
  if (authorization.protocolVersion === PROPOSAL_WORKER_EXECUTION_AUTHORIZATION_VERSION && status === "completed" && verifiedResult === null) {
    fail("Completed proposal execution requires its typed patch proposal.", "INVALID_RUNTIME_STRUCTURED_RESULT");
  }
  const processSupervision = supervision === null ? {
    supervisionMode: "no-descendant-fixture",
    supervisionStrategy: "exact-child-only",
    supervisorManifestDigest: "",
    ownershipEstablished: childStarted && childExitObserved,
    providerChildStarted: false,
    providerChildExitObserved: false,
    treeCleanupAttempted: false,
    treeCleanupVerified: childStarted && childExitObserved,
  } : {
    supervisionMode: supervision.supervisionMode,
    supervisionStrategy: supervision.supervisionStrategy,
    supervisorManifestDigest: supervision.supervisorManifestDigest,
    ownershipEstablished: supervision.ownershipEstablished,
    providerChildStarted: supervision.providerChildStarted,
    providerChildExitObserved: supervision.providerChildExitObserved,
    treeCleanupAttempted: supervision.treeCleanupAttempted,
    treeCleanupVerified: supervision.treeCleanupVerified,
  };
  return {
    schemaVersion: 1,
    kind: "RuntimeInvocationLifecycleReceipt",
    protocolVersion: RUNTIME_LIFECYCLE_RECEIPT_VERSION,
    authorizationId: authorization.authorizationId,
    projectId: authorization.projectId,
    [originalFormat(authorization).sessionIdField]: sessionIdOf(authorization),
    scopeKind: authorization.scope.kind,
    runId: authorization.scope.runId,
    executionContractId: authorization.scope.executionContractId,
    executionLeaseConsumptionId: consumption.consumptionId,
    runtime: authorization.runtime,
    status,
    exitCode,
    signal,
    eventIds,
    eventTypes,
    unknownEventTypes,
    providerSessionReferenceDigests,
    eventCount: eventIds.length,
    stdoutBytes,
    stderrBytes,
    stdoutDigest,
    stderrDigest,
    inputDigestObserved,
    processBoundary: {
      callerFenceDigest,
      childFenceDigest,
      exactChildStarted: childStarted,
      exactChildExitObserved: childExitObserved,
      terminationRequested,
      projectFenceValidated,
      shellInterpretation: false,
      rawCommandPersisted: false,
      rawOutputPersisted: false,
      childPidPersisted: false,
      noDescendantFixture,
      descendantTreeOwnershipValidated,
      ...processSupervision,
    },
    providerBoundary: {
      mode: providerMode,
      conformanceFixtureOnly: fixtureMode,
      actualProviderInvoked: actualProvider,
      actualProviderSessionCreated: providerSessionCreated,
      boundedOneShotInvocationEnabled: actualProvider,
      generalProviderControlEnabled: false,
      lifecycleConformanceEvidenceOnly: fixtureMode,
      diagnosticCodes: normalizedProviderDiagnosticCodes,
      structuredResultObserved: verifiedResult !== null,
      structuredResultDigest: verifiedResult === null ? "" : digest(canonicalJson(verifiedResult)),
      structuredResultBytes: verifiedResult === null ? 0 : Buffer.byteLength(canonicalJson(verifiedResult)),
    },
    executionLeaseBoundary: {
      authorizationConsumedBeforeInvocation: consumption.singleUseBoundary.authorizationConsumedBeforeInvocation,
      atMostOnce: consumption.singleUseBoundary.atMostOnce,
      replayAllowed: consumption.singleUseBoundary.replayAllowed,
      providerInvokedAtConsumption: consumption.singleUseBoundary.providerInvokedAtConsumption,
      crashRecovery: consumption.singleUseBoundary.crashRecovery,
    },
    authority: "execution-evidence-not-canon",
    instructionAuthority: false,
    promotionAuthority: false,
    mutatesCanon: false,
  };
}

export function buildRuntimeInvocationLifecycleReceipt(input = {}) {
  return verifyRuntimeInvocationLifecycleReceipt(identify(
    lifecycleSummary(input),
    "runtime-lifecycle-receipt",
    "receiptId",
    "receiptHash",
  ));
}

export function verifyRuntimeInvocationLifecycleReceipt(document) {
  const format = originalFormat(document);
  const legacyReceipt = document?.protocolVersion === LEGACY_RUNTIME_LIFECYCLE_RECEIPT_VERSION;
  assertFields(document, [
    "schemaVersion", "kind", "protocolVersion", "authorizationId", "projectId", (format?.sessionIdField || "headSessionId"), "scopeKind", "runId",
    "executionContractId", "executionLeaseConsumptionId", "runtime", "status", "exitCode", "signal", "eventIds", "eventTypes",
    "unknownEventTypes", "providerSessionReferenceDigests", "eventCount", "stdoutBytes", "stderrBytes",
    "stdoutDigest", "stderrDigest", "inputDigestObserved", "processBoundary", "providerBoundary", "executionLeaseBoundary", "authority",
    "instructionAuthority", "promotionAuthority", "mutatesCanon", "receiptId", "receiptHash",
  ], "Runtime invocation lifecycle receipt");
  assertFields(document.processBoundary, [
    "callerFenceDigest", "childFenceDigest", "exactChildStarted", "exactChildExitObserved", "terminationRequested",
    "projectFenceValidated", "shellInterpretation", "rawCommandPersisted", "rawOutputPersisted", "childPidPersisted",
    "noDescendantFixture", "descendantTreeOwnershipValidated", "supervisionMode", "supervisionStrategy",
    "supervisorManifestDigest", "ownershipEstablished", "providerChildStarted", "providerChildExitObserved",
    "treeCleanupAttempted", "treeCleanupVerified",
  ], "Runtime invocation process boundary");
  assertFields(document.providerBoundary, [
    "mode", "conformanceFixtureOnly", "actualProviderInvoked", "actualProviderSessionCreated",
    "boundedOneShotInvocationEnabled", "generalProviderControlEnabled", "lifecycleConformanceEvidenceOnly",
    ...(legacyReceipt ? [] : ["diagnosticCodes"]), "structuredResultObserved", "structuredResultDigest", "structuredResultBytes",
  ], "Runtime invocation provider boundary");
  assertFields(document.executionLeaseBoundary, [
    "authorizationConsumedBeforeInvocation", "atMostOnce", "replayAllowed", "providerInvokedAtConsumption", "crashRecovery",
  ], "Runtime invocation execution lease boundary");
  const statuses = new Set(["completed", "failed", "cancelled", "timed-out", "output-limited", "invalid-event"]);
  const sortedUnique = (items) => Array.isArray(items) && canonicalJson(items) === canonicalJson([...new Set(items)].sort(compareText));
  const completed = document.status === "completed";
  const terminated = new Set(["cancelled", "timed-out", "output-limited", "invalid-event"]).has(document.status);
  const { fixtureMode, actualProvider, valid: validProviderMode } = providerModeProfile(document.runtime, document.providerBoundary.mode);
  const nativeSupervision = document.processBoundary.supervisionMode === "native-process-tree";
  const fixtureSupervision = document.processBoundary.supervisionMode === "no-descendant-fixture";
  const expectedProviderBoundary = {
    mode: document.providerBoundary.mode,
    conformanceFixtureOnly: fixtureMode,
    actualProviderInvoked: actualProvider,
    actualProviderSessionCreated: document.providerBoundary.actualProviderSessionCreated,
    boundedOneShotInvocationEnabled: actualProvider,
    generalProviderControlEnabled: false,
    lifecycleConformanceEvidenceOnly: fixtureMode,
    ...(legacyReceipt ? {} : { diagnosticCodes: document.providerBoundary.diagnosticCodes }),
    structuredResultObserved: document.providerBoundary.structuredResultObserved,
    structuredResultDigest: document.providerBoundary.structuredResultDigest,
    structuredResultBytes: document.providerBoundary.structuredResultBytes,
  };
  if (document.schemaVersion !== 1 || document.kind !== "RuntimeInvocationLifecycleReceipt"
    || !new Set([LEGACY_RUNTIME_LIFECYCLE_RECEIPT_VERSION, RUNTIME_LIFECYCLE_RECEIPT_VERSION]).has(document.protocolVersion)
    || !statuses.has(document.status)
    || document.runtime !== normalizeRuntime(document.runtime)
    || !/^execution-authorization-[a-f0-9]{24}$/.test(document.authorizationId || "")
    || (!format || !new RegExp(`^${format.projectPrefix}[a-f0-9]{20}$`).test(document.projectId || ""))
    || !/^session-[A-Fa-f0-9-]{36}$/.test(sessionIdOf(document) || "")
    || !EXECUTION_SCOPE_KINDS.includes(document.scopeKind)
    || (document.scopeKind === "run" && (!/^run-[0-9]+-[a-f0-9]{6}$/.test(document.runId || "")
      || !/^execution-contract-[a-f0-9]{24}$/.test(document.executionContractId || "")))
    || (document.scopeKind === "session" && (document.runId !== null || document.executionContractId !== null))
    || !/^runtime-execution-consumption-[a-f0-9]{24}$/.test(document.executionLeaseConsumptionId || "")
    || !Number.isInteger(document.exitCode) && document.exitCode !== null
    || typeof document.signal !== "string" || document.signal.length > 32
    || !sortedUnique(document.eventIds) || document.eventIds.some((item) => !/^runtime-event-[a-f0-9]{24}$/.test(item))
    || !sortedUnique(document.eventTypes) || !sortedUnique(document.unknownEventTypes) || !sortedUnique(document.providerSessionReferenceDigests)
    || document.eventCount !== document.eventIds.length
    || !Number.isSafeInteger(document.stdoutBytes) || document.stdoutBytes < 0
    || !Number.isSafeInteger(document.stderrBytes) || document.stderrBytes < 0
    || !/^[a-f0-9]{64}$/.test(document.stdoutDigest || "") || !/^[a-f0-9]{64}$/.test(document.stderrDigest || "")
    || !/^[a-f0-9]{64}$/.test(document.inputDigestObserved || "")
    || !/^[a-f0-9]{64}$/.test(document.processBoundary.callerFenceDigest || "")
    || !/^[a-f0-9]{64}$/.test(document.processBoundary.childFenceDigest || "")
    || document.processBoundary.exactChildStarted !== document.processBoundary.exactChildExitObserved
    || document.processBoundary.projectFenceValidated !== true || document.processBoundary.shellInterpretation !== false
    || document.processBoundary.rawCommandPersisted !== false || document.processBoundary.rawOutputPersisted !== false
    || document.processBoundary.childPidPersisted !== false || typeof document.processBoundary.noDescendantFixture !== "boolean"
    || typeof document.processBoundary.descendantTreeOwnershipValidated !== "boolean"
    || !nativeSupervision && !fixtureSupervision
    || !new Set(["exact-child-only", "windows-job-object", "posix-process-group"]).has(document.processBoundary.supervisionStrategy)
    || typeof document.processBoundary.ownershipEstablished !== "boolean"
    || typeof document.processBoundary.providerChildStarted !== "boolean"
    || typeof document.processBoundary.providerChildExitObserved !== "boolean"
    || typeof document.processBoundary.treeCleanupAttempted !== "boolean"
    || typeof document.processBoundary.treeCleanupVerified !== "boolean"
    || document.processBoundary.descendantTreeOwnershipValidated
      && (!document.processBoundary.exactChildStarted || !document.processBoundary.exactChildExitObserved)
    || document.processBoundary.noDescendantFixture
      && document.processBoundary.descendantTreeOwnershipValidated !== document.processBoundary.exactChildStarted
    || fixtureSupervision && (!document.processBoundary.noDescendantFixture
      || document.processBoundary.supervisionStrategy !== "exact-child-only"
      || document.processBoundary.supervisorManifestDigest !== ""
      || document.processBoundary.providerChildStarted || document.processBoundary.providerChildExitObserved
      || document.processBoundary.treeCleanupAttempted
      || document.processBoundary.ownershipEstablished !== document.processBoundary.exactChildStarted
      || document.processBoundary.treeCleanupVerified !== document.processBoundary.exactChildStarted)
    || nativeSupervision && (document.processBoundary.noDescendantFixture
      || !new Set(["windows-job-object", "posix-process-group"]).has(document.processBoundary.supervisionStrategy)
      || !/^[a-f0-9]{64}$/.test(document.processBoundary.supervisorManifestDigest || "")
      || !document.processBoundary.providerChildStarted
      || document.processBoundary.descendantTreeOwnershipValidated !== (document.processBoundary.ownershipEstablished && document.processBoundary.treeCleanupVerified))
    || (completed && (document.exitCode !== 0 || document.processBoundary.terminationRequested !== false))
    || (completed && nativeSupervision && !document.processBoundary.providerChildExitObserved)
    || (terminated && document.processBoundary.terminationRequested !== true)
    || !validProviderMode
    || actualProvider && completed && (!document.providerBoundary.actualProviderSessionCreated || !document.providerBoundary.structuredResultObserved)
    || actualProvider && completed && !document.processBoundary.descendantTreeOwnershipValidated
    || fixtureMode && document.providerBoundary.actualProviderInvoked
    || typeof document.providerBoundary.actualProviderSessionCreated !== "boolean"
    || !legacyReceipt && (!sortedUnique(document.providerBoundary.diagnosticCodes)
      || document.providerBoundary.diagnosticCodes.length > 32
      || document.providerBoundary.diagnosticCodes.some((item) => typeof item !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(item)))
    || typeof document.providerBoundary.structuredResultObserved !== "boolean"
    || (document.providerBoundary.structuredResultObserved
      ? (!/^[a-f0-9]{64}$/.test(document.providerBoundary.structuredResultDigest || "")
        || !Number.isSafeInteger(document.providerBoundary.structuredResultBytes) || document.providerBoundary.structuredResultBytes < 1)
      : document.providerBoundary.structuredResultDigest !== "" || document.providerBoundary.structuredResultBytes !== 0)
    || canonicalJson(document.providerBoundary) !== canonicalJson(expectedProviderBoundary)
    || canonicalJson(document.executionLeaseBoundary) !== canonicalJson({
      authorizationConsumedBeforeInvocation: true,
      atMostOnce: true,
      replayAllowed: false,
      providerInvokedAtConsumption: false,
      crashRecovery: "authorization-remains-consumed-new-head-decision-required",
    })
    || document.authority !== "execution-evidence-not-canon" || document.instructionAuthority !== false
    || document.promotionAuthority !== false || document.mutatesCanon !== false) {
    fail("Runtime invocation lifecycle receipt is invalid.", "INVALID_RUNTIME_LIFECYCLE_RECEIPT");
  }
  verifyIdentity(document, { prefix: "runtime-lifecycle-receipt", idKey: "receiptId", hashKey: "receiptHash", code: "RUNTIME_LIFECYCLE_RECEIPT_DIGEST_MISMATCH" });
  return document;
}

const FIXTURE_SOURCE = String.raw`
const crypto = require('node:crypto');
const runtime = process.argv[1];
const mode = process.argv[2];
let input = Buffer.alloc(0);
process.stdin.on('data', (chunk) => { input = Buffer.concat([input, chunk]); });
process.on('SIGTERM', () => process.exit(143));
process.stdin.on('end', () => {
  const inputDigest = crypto.createHash('sha256').update(input).digest('hex');
  const write = (record) => process.stdout.write(JSON.stringify(record) + '\n');
  write({ type: 'session.started', sessionId: 'fixture-session', runtime, inputDigest });
  if (mode === 'invalid-event') process.stdout.write('{invalid-json}\n');
  else if (mode === 'output-limit') process.stdout.write(JSON.stringify({ type: 'assistant.output', text: 'x'.repeat(1024 * 1024) }) + '\n');
  else {
    write({ type: 'assistant.completed', runtime, result: 'fixture-completed' });
    write({ type: 'turn.completed', runtime, verification: 'fixture-success' });
  }
  if (mode === 'wait') setInterval(() => {}, 1000);
});
`;

function minimalEnvironment(environment) {
  const allowed = new Set(["systemroot", "windir", "temp", "tmp", "lang", "lc_all"]);
  const result = {};
  for (const [key, value] of Object.entries(environment || {})) {
    if (allowed.has(key.toLowerCase()) && typeof value === "string") result[key] = value;
  }
  result.CI = "1";
  result.NO_COLOR = "1";
  result.TERM = "dumb";
  return result;
}

function callerFence(root, authorizationId) {
  return digest(canonicalJson({
    authorizationId,
    pid: process.pid,
    parentPid: process.ppid,
    executable: process.execPath,
    projectRoot: realRoot(root),
  }));
}

export function buildRuntimeInvocationCallerFence(root, authorizationId) {
  return callerFence(root, authorizationId);
}

export async function runRuntimeLifecycleConformance({
  root = ".",
  authorization,
  sessionRequest = "",
  mode = "success",
  signal = null,
  spawnImplementation = spawn,
  onProcessEvent = () => {},
} = {}) {
  const verified = verifyRuntimeInvocationAuthorization(authorization);
  if (!new Set(["success", "wait", "invalid-event", "output-limit"]).has(mode)) fail("Unsupported lifecycle conformance mode.", "INVALID_RUNTIME_CONFORMANCE_MODE");
  const { projectRoot, input } = prepareRuntimeInvocationExecution({ root, authorization: verified, sessionRequest });
  const callerFenceDigest = callerFence(projectRoot, verified.authorizationId);
  const leased = await withRuntimeExecutionLease({
    projectRoot,
    authorization: verified,
    ownerFenceDigest: callerFenceDigest,
  }, async ({ lease, consumption, operationalStateRoot }) => {
    verifyRuntimeExecutionLeaseOwnership({ projectRoot, operationalStateRoot, authorization: verified, lease, consumption });
  const ownershipNonce = crypto.randomBytes(32).toString("hex");
  let child;
  let timer;
  let abortHandler;
  let terminationRequested = false;
  let timedOut = false;
  let cancelled = false;
  let outputLimited = false;
  let invalidEvent = false;
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let lineBuffer = "";
  const events = [];

  const receipt = await new Promise((resolve, reject) => {
    try {
      child = spawnImplementation(process.execPath, ["-e", FIXTURE_SOURCE, verified.runtime, mode], {
        cwd: projectRoot,
        env: minimalEnvironment(process.env),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const code = "RUNTIME_CONFORMANCE_SPAWN_FAILED";
      recordRuntimeInvocationStartFailure({ projectRoot, authorization: verified, lease, consumption, errorCode: code });
      reject(Object.assign(new Error(`Lifecycle conformance child could not start: ${error.message}`), { code }));
      return;
    }
    let childStarted = false;
    let childExitObserved = false;
    let childFenceDigest = digest(`${callerFenceDigest}\nnot-started\n${ownershipNonce}`);
    let inputDigestObserved = digest(Buffer.alloc(0));
    const terminate = (reason) => {
      if (!childStarted || childExitObserved || terminationRequested) return;
      terminationRequested = true;
      if (reason === "timeout") timedOut = true;
      if (reason === "cancel") cancelled = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!childExitObserved) child.kill("SIGKILL");
      }, verified.limits.terminationGraceMs).unref();
    };
    timer = setTimeout(() => terminate("timeout"), verified.limits.timeoutMs);
    if (signal) {
      if (signal.aborted) terminate("cancel");
      else {
        abortHandler = () => terminate("cancel");
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    }
    child.once("spawn", () => {
      childStarted = true;
      childFenceDigest = digest(`${callerFenceDigest}\n${child.pid}\n${ownershipNonce}`);
      onProcessEvent({ type: "spawn", pid: child.pid, parentPid: process.pid, command: process.execPath, cwd: projectRoot, ports: "none" });
      child.stdin.end(input);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      reject(Object.assign(new Error(`Lifecycle conformance child failed: ${error.message}`), { code: "RUNTIME_CONFORMANCE_SPAWN_FAILED" }));
    });
    child.stdout.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > verified.limits.maxStdoutBytes) {
        outputLimited = true;
        terminate("output-limit");
        return;
      }
      lineBuffer += chunk.toString("utf8");
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        if (events.length >= verified.limits.maxEvents) {
          outputLimited = true;
          terminate("output-limit");
          break;
        }
        try {
          const envelope = normalizeRuntimeEvent({ authorization: verified, sequence: events.length, line });
          events.push(envelope);
          const raw = JSON.parse(line);
          if (typeof raw.inputDigest === "string" && /^[a-f0-9]{64}$/.test(raw.inputDigest)) inputDigestObserved = raw.inputDigest;
        } catch (error) {
          invalidEvent = true;
          terminate("invalid-event");
          break;
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > verified.limits.maxStderrBytes) {
        outputLimited = true;
        terminate("output-limit");
      }
    });
    child.once("exit", (code, childSignal) => {
      childExitObserved = true;
      onProcessEvent({ type: "exit", pid: child.pid, parentPid: process.pid, exitCode: Number.isInteger(code) ? code : null, signal: childSignal || "none" });
      clearTimeout(timer);
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      const status = cancelled ? "cancelled" : timedOut ? "timed-out" : outputLimited ? "output-limited"
        : invalidEvent ? "invalid-event" : code === 0 ? "completed" : "failed";
      const payload = lifecycleSummary({
        authorization: verified,
        events: events.sort((left, right) => compareText(left.eventId, right.eventId)),
        status,
        exitCode: Number.isInteger(code) ? code : null,
        signal: childSignal || "",
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
        stdoutDigest: digest(stdout),
        stderrDigest: digest(stderr),
        callerFenceDigest,
        childFenceDigest,
        childStarted,
        childExitObserved,
        terminationRequested,
        projectFenceValidated: true,
        inputDigestObserved,
        noDescendantFixture: true,
        descendantTreeOwnershipValidated: childStarted && childExitObserved,
        consumption,
      });
      resolve(verifyRuntimeInvocationLifecycleReceipt(identify(payload, "runtime-lifecycle-receipt", "receiptId", "receiptHash")));
    });
  });
  if (receipt.inputDigestObserved !== verified.executionInput.digest && receipt.status === "completed") {
    fail("Lifecycle conformance fixture did not observe the authorized execution input.", "RUNTIME_INVOCATION_INPUT_NOT_OBSERVED");
  }
  return { status: "lifecycle_conformance_recorded", receipt, events };
  });
  return {
    ...leased.result,
    executionLease: {
      consumption: leased.consumption,
      release: leased.release,
    },
  };
}

export function buildRuntimeResultPacketDraft({ authorization, receipt, leaseRelease, providerResult = null } = {}) {
  const verifiedAuthorization = verifyRuntimeInvocationAuthorization(authorization);
  const verifiedReceipt = verifyRuntimeInvocationLifecycleReceipt(receipt);
  const verifiedRelease = verifyRuntimeExecutionLeaseRelease(leaseRelease);
  const verifiedProviderResult = providerResult === null
    ? null : verifyRuntimeStructuredResult(providerResult, { scopeKind: verifiedAuthorization.scope.kind, authorization: verifiedAuthorization });
  if (verifiedAuthorization.protocolVersion === PROPOSAL_WORKER_EXECUTION_AUTHORIZATION_VERSION
    && verifiedReceipt.status === "completed" && verifiedProviderResult === null) {
    fail("Completed proposal execution requires its typed patch proposal.", "INVALID_RUNTIME_STRUCTURED_RESULT");
  }
  if (verifiedReceipt.authorizationId !== verifiedAuthorization.authorizationId
    || verifiedReceipt.scopeKind !== verifiedAuthorization.scope.kind
    || verifiedReceipt.executionContractId !== verifiedAuthorization.scope.executionContractId
    || verifiedReceipt.runId !== verifiedAuthorization.scope.runId
    || verifiedRelease.authorizationId !== verifiedAuthorization.authorizationId
    || verifiedRelease.consumptionId !== verifiedReceipt.executionLeaseConsumptionId
    || verifiedRelease.lifecycleReceiptId !== verifiedReceipt.receiptId) {
    fail("Runtime receipt does not belong to the authorized execution scope.", "RUNTIME_RESULT_DRAFT_LINEAGE_CONFLICT");
  }
  const actualProvider = verifiedReceipt.providerBoundary.actualProviderInvoked;
  const providerResultDigest = verifiedProviderResult === null ? "" : digest(canonicalJson(verifiedProviderResult));
  if (verifiedReceipt.providerBoundary.structuredResultObserved !== (verifiedProviderResult !== null)
    || verifiedReceipt.providerBoundary.structuredResultDigest !== providerResultDigest
    || verifiedReceipt.providerBoundary.structuredResultBytes !== (verifiedProviderResult === null ? 0 : Buffer.byteLength(canonicalJson(verifiedProviderResult)))) {
    fail("Runtime structured result does not match the lifecycle receipt.", "RUNTIME_RESULT_DRAFT_STRUCTURED_RESULT_CONFLICT");
  }
  const successful = verifiedReceipt.status === "completed" && verifiedReceipt.exitCode === 0
    && verifiedReceipt.inputDigestObserved === verifiedAuthorization.executionInput.digest
    && (!actualProvider || verifiedReceipt.processBoundary.descendantTreeOwnershipValidated);
  const providerDiagnosticCodes = verifiedReceipt.providerBoundary.diagnosticCodes || [];
  const lifecycleUnknowns = verifiedReceipt.unknownEventTypes.map((type) => `Unrecognized provider event type: ${type}`);
  lifecycleUnknowns.push(...providerDiagnosticCodes.map((code) => `Provider diagnostic: ${code}`));
  if (actualProvider && !verifiedReceipt.processBoundary.descendantTreeOwnershipValidated) {
    lifecycleUnknowns.push("Actual provider descendant-tree ownership is not yet validated.");
  }
  const payload = {
    schemaVersion: 1,
    kind: "RuntimeResultPacketDraft",
    protocolVersion: RUNTIME_RESULT_DRAFT_VERSION,
    authorizationId: verifiedAuthorization.authorizationId,
    lifecycleReceiptId: verifiedReceipt.receiptId,
    executionLeaseConsumptionId: verifiedReceipt.executionLeaseConsumptionId,
    executionLeaseReleaseId: verifiedRelease.releaseId,
    scopeKind: verifiedAuthorization.scope.kind,
    executionContractId: verifiedAuthorization.scope.executionContractId,
    runId: verifiedAuthorization.scope.runId,
    outcome: verifiedProviderResult?.outcome
      || (successful ? "Provider lifecycle conformance completed." : `Provider lifecycle conformance ended with ${verifiedReceipt.status}.`),
    evidence: [{
      kind: "RuntimeLifecycleEvidence",
      lifecycleReceiptId: verifiedReceipt.receiptId,
      executionLeaseConsumptionId: verifiedReceipt.executionLeaseConsumptionId,
      executionLeaseReleaseId: verifiedRelease.releaseId,
      eventIds: verifiedReceipt.eventIds,
      eventTypes: verifiedReceipt.eventTypes,
      providerDiagnosticCodes,
      providerSessionReferenceDigests: verifiedReceipt.providerSessionReferenceDigests,
      actualProviderInvoked: actualProvider,
      structuredResultDigest: providerResultDigest,
      instructionAuthority: false,
    }],
    providerResult: verifiedProviderResult,
    planDelta: verifiedProviderResult?.planDelta || "",
    impactRadius: verifiedProviderResult?.impactRadius || [],
    verification: [{
      kind: "RuntimeLifecycleVerification",
      status: successful ? "passed" : "failed",
      projectFenceValidated: verifiedReceipt.processBoundary.projectFenceValidated,
      exactChildExitObserved: verifiedReceipt.processBoundary.exactChildExitObserved,
      descendantTreeOwnershipValidated: verifiedReceipt.processBoundary.descendantTreeOwnershipValidated,
      inputDigestMatched: verifiedReceipt.inputDigestObserved === verifiedAuthorization.executionInput.digest,
    }],
    unknowns: [...new Set([...lifecycleUnknowns, ...(verifiedProviderResult?.unknowns || [])])].sort(compareText),
    finalResultPacketPersisted: false,
    freshHeadReviewRequired: verifiedAuthorization.scope.kind === "run",
    rawTranscriptIncluded: false,
    authority: "draft-evidence-not-reviewed-result",
    instructionAuthority: false,
    promotionAuthority: false,
    mutatesCanon: false,
  };
  return verifyRuntimeResultPacketDraft(identify(payload, "runtime-result-draft", "draftId", "draftHash"), { authorization: verifiedAuthorization });
}

export function verifyRuntimeResultPacketDraft(document, { authorization = null } = {}) {
  const legacyDraft = document?.protocolVersion === LEGACY_RUNTIME_RESULT_DRAFT_VERSION;
  assertFields(document, [
    "schemaVersion", "kind", "protocolVersion", "authorizationId", "lifecycleReceiptId", "executionLeaseConsumptionId",
    "executionLeaseReleaseId", "scopeKind", "executionContractId",
    "runId", "outcome", "evidence", "providerResult", "planDelta", "impactRadius", "verification", "unknowns",
    "finalResultPacketPersisted", "freshHeadReviewRequired", "rawTranscriptIncluded", "authority",
    "instructionAuthority", "promotionAuthority", "mutatesCanon", "draftId", "draftHash",
  ], "Runtime ResultPacket draft");
  if (!Array.isArray(document.evidence) || document.evidence.length !== 1
    || !Array.isArray(document.verification) || document.verification.length !== 1) {
    fail("Runtime ResultPacket draft evidence and verification cardinality are invalid.", "INVALID_RUNTIME_RESULT_PACKET_DRAFT");
  }
  const evidence = document.evidence[0];
  const verification = document.verification[0];
  assertFields(evidence, [
    "kind", "lifecycleReceiptId", "executionLeaseConsumptionId", "executionLeaseReleaseId", "eventIds", "eventTypes",
    ...(legacyDraft ? [] : ["providerDiagnosticCodes"]), "providerSessionReferenceDigests", "actualProviderInvoked",
    "structuredResultDigest", "instructionAuthority",
  ], "Runtime ResultPacket draft evidence");
  assertFields(verification, [
    "kind", "status", "projectFenceValidated", "exactChildExitObserved", "descendantTreeOwnershipValidated", "inputDigestMatched",
  ], "Runtime ResultPacket draft verification");
  const sortedUnique = (items) => Array.isArray(items) && canonicalJson(items) === canonicalJson([...new Set(items)].sort(compareText));
  const providerResult = document.providerResult === null
    ? null : verifyRuntimeStructuredResult(document.providerResult, { scopeKind: document.scopeKind, authorization });
  if (authorization !== null) {
    const verified = verifyRuntimeInvocationAuthorization(authorization);
    if (document.authorizationId !== verified.authorizationId || document.scopeKind !== verified.scope.kind
      || document.runId !== verified.scope.runId || document.executionContractId !== verified.scope.executionContractId
      || verified.protocolVersion === PROPOSAL_WORKER_EXECUTION_AUTHORIZATION_VERSION && verification.status === "passed" && providerResult === null) {
      fail("Runtime draft differs from its exact authorization or required proposal.", "RUNTIME_RESULT_DRAFT_LINEAGE_CONFLICT");
    }
  }
  const providerResultDigest = providerResult === null ? "" : digest(canonicalJson(providerResult));
  if (document.schemaVersion !== 1 || document.kind !== "RuntimeResultPacketDraft"
    || !new Set([LEGACY_RUNTIME_RESULT_DRAFT_VERSION, RUNTIME_RESULT_DRAFT_VERSION]).has(document.protocolVersion)
    || !/^execution-authorization-[a-f0-9]{24}$/.test(document.authorizationId || "")
    || !/^runtime-lifecycle-receipt-[a-f0-9]{24}$/.test(document.lifecycleReceiptId || "")
    || !/^runtime-execution-consumption-[a-f0-9]{24}$/.test(document.executionLeaseConsumptionId || "")
    || !/^runtime-execution-release-[a-f0-9]{24}$/.test(document.executionLeaseReleaseId || "")
    || !EXECUTION_SCOPE_KINDS.includes(document.scopeKind)
    || (document.scopeKind === "run" && (!/^execution-contract-[a-f0-9]{24}$/.test(document.executionContractId || "")
      || !/^run-[0-9]+-[a-f0-9]{6}$/.test(document.runId || "")))
    || (document.scopeKind === "session" && (document.executionContractId !== null || document.runId !== null))
    || typeof document.outcome !== "string" || !document.outcome
    || evidence.kind !== "RuntimeLifecycleEvidence" || evidence.lifecycleReceiptId !== document.lifecycleReceiptId
    || evidence.executionLeaseConsumptionId !== document.executionLeaseConsumptionId
    || evidence.executionLeaseReleaseId !== document.executionLeaseReleaseId
    || !sortedUnique(evidence.eventIds) || evidence.eventIds.some((item) => !/^runtime-event-[a-f0-9]{24}$/.test(item))
    || !sortedUnique(evidence.eventTypes)
    || !legacyDraft && (!sortedUnique(evidence.providerDiagnosticCodes)
      || evidence.providerDiagnosticCodes.length > 32
      || evidence.providerDiagnosticCodes.some((item) => typeof item !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(item)))
    || !sortedUnique(evidence.providerSessionReferenceDigests)
    || evidence.providerSessionReferenceDigests.some((item) => !/^[a-f0-9]{64}$/.test(item))
    || typeof evidence.actualProviderInvoked !== "boolean" || evidence.structuredResultDigest !== providerResultDigest
    || evidence.instructionAuthority !== false
    || verification.kind !== "RuntimeLifecycleVerification" || !new Set(["passed", "failed"]).has(verification.status)
    || [verification.projectFenceValidated, verification.exactChildExitObserved, verification.descendantTreeOwnershipValidated, verification.inputDigestMatched].some((item) => typeof item !== "boolean")
    || typeof document.planDelta !== "string" || document.planDelta !== (providerResult?.planDelta || "")
    || !Array.isArray(document.impactRadius) || canonicalJson(document.impactRadius) !== canonicalJson(providerResult?.impactRadius || [])
    || !Array.isArray(document.unknowns) || document.unknowns.some((item) => typeof item !== "string" || !item)
    || document.finalResultPacketPersisted !== false || document.freshHeadReviewRequired !== (document.scopeKind === "run")
    || document.rawTranscriptIncluded !== false || document.authority !== "draft-evidence-not-reviewed-result"
    || document.instructionAuthority !== false || document.promotionAuthority !== false || document.mutatesCanon !== false) {
    fail("Runtime ResultPacket draft is invalid.", "INVALID_RUNTIME_RESULT_PACKET_DRAFT");
  }
  verifyIdentity(document, { prefix: "runtime-result-draft", idKey: "draftId", hashKey: "draftHash", code: "RUNTIME_RESULT_DRAFT_DIGEST_MISMATCH" });
  return document;
}

export const RUNTIME_INVOCATION_REQUIRED_ACTIONS = Object.freeze({
  invoke: REQUIRED_INVOKE_ACTION,
  readOnly: WORKSPACE_ACTION["read-only"],
  workspaceWrite: WORKSPACE_ACTION["workspace-write"],
});
