import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readContextCapsule } from "./context-compiler.mjs";
import { inspectProject, SCHEMA_VERSION } from "./head-core.mjs";
import {
  executeIncrementalRepositoryScan,
  managedRootFilesForProject,
} from "./repository-scan.mjs";
import { readRepositorySourceScope } from "./repository-source-scope.mjs";
import {
  buildWorldModel,
  deriveIncrementalRevisionParents,
  inspectWorldModel,
  readWorldModel,
  readWorldModelSnapshot,
} from "./world-model.mjs";
import {
  completePostRefreshProjection,
  inspectPostRefreshProjection as inspectPostRefreshProjectionArtifact,
  preparePostRefreshProjection,
  readPostRefreshProjectionReceipt as readPostRefreshProjectionReceiptArtifact,
} from "./post-refresh-projection.mjs";
import { withRefreshWriterLease } from "./refresh-writer-lease.mjs";
import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";

export const INCREMENTAL_REFRESH_VERSION = "0.2.0";
const LEGACY_INCREMENTAL_REFRESH_VERSION = "0.1.0";
const REQUEST_PATTERN = /^incremental-refresh-request-[a-f0-9]{24}$/;
const RECEIPT_PATTERN = /^incremental-refresh-receipt-[a-f0-9]{24}$/;
const SOURCE_SNAPSHOT_PATTERN = /^source-snapshot-[a-f0-9]{24}$/;
const TRIGGER_KINDS = new Set(["manual", "filesystem", "ci", "change-set", "runtime-observation"]);

const fail = (message, code = "INCREMENTAL_REFRESH_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertFields(record, allowed, label) {
  if (!record || typeof record !== "object" || Array.isArray(record)) fail(`${label} must be an object.`, "INVALID_REFRESH_SCHEMA");
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length) fail(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}`, "INVALID_REFRESH_SCHEMA");
}

function readyProject(root) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") fail(`Project must be ready for observed-state refresh; current status: ${inspected.status}.`, "PROJECT_NOT_READY");
  return inspected;
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
  catch (error) { fail(`${label} is invalid JSON: ${error.message}`, "INVALID_REFRESH_DOCUMENT"); }
}

function normalizedUnique(values, label, validator) {
  if (!Array.isArray(values)) fail(`${label} must be an array.`, "INVALID_REFRESH_SCHEMA");
  const normalized = values.map((value, index) => validator(value, `${label}[${index}]`)).sort(compareText);
  if (new Set(normalized).size !== normalized.length) fail(`${label} contains duplicates.`, "INVALID_REFRESH_SCHEMA");
  return normalized;
}

function normalizedPath(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    fail(`${label} is not a normalized relative path.`, "INVALID_REFRESH_PATH");
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized === ".." || normalized.startsWith("../")) fail(`${label} escapes the project root.`, "INVALID_REFRESH_PATH");
  return value;
}

function normalizedEvidenceId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,255}$/.test(value)) fail(`${label} is invalid.`, "INVALID_REFRESH_EVIDENCE_ID");
  return value;
}

function normalizedSourceSnapshotId(value, label) {
  if (typeof value !== "string" || !SOURCE_SNAPSHOT_PATTERN.test(value)) fail(`${label} is invalid.`, "INVALID_REFRESH_PARENT");
  return value;
}

function identity(kind, payload) {
  const hash = digest(canonicalJson(payload));
  return { id: `${kind}-${hash.slice(0, 24)}`, hash };
}

function buildIncrementalRefreshRequestVersion({
  projectId,
  baseWorldModelId,
  baseSourceSnapshotId,
  triggerKind = "manual",
  triggerEvidenceIds = [],
  expectedChangedPaths = null,
  additionalParentSourceSnapshotIds = [],
} = {}, protocolVersion = INCREMENTAL_REFRESH_VERSION, storage = null, originalFormat = null) {
  const format = originalFormat || formatForVerifiedOwner(storage);
  if (typeof projectId !== "string" || !new RegExp(`^${format.projectPrefix}[a-f0-9]{20}$`).test(projectId)) fail("Refresh projectId is invalid.", "INVALID_REFRESH_SCHEMA");
  if (typeof baseWorldModelId !== "string" || !/^world-model-[a-f0-9]{24}$/.test(baseWorldModelId)) fail("Refresh base World Model id is invalid.", "INVALID_REFRESH_SCHEMA");
  normalizedSourceSnapshotId(baseSourceSnapshotId, "baseSourceSnapshotId");
  if (!TRIGGER_KINDS.has(triggerKind)) fail("Refresh trigger kind is unsupported.", "INVALID_REFRESH_TRIGGER");
  const evidenceIds = normalizedUnique(triggerEvidenceIds, "triggerEvidenceIds", normalizedEvidenceId);
  const expectation = expectedChangedPaths == null
    ? { mode: "discover", paths: [] }
    : { mode: "exact", paths: normalizedUnique(expectedChangedPaths, "expectedChangedPaths", normalizedPath) };
  const parents = normalizedUnique(additionalParentSourceSnapshotIds, "additionalParentSourceSnapshotIds", normalizedSourceSnapshotId)
    .filter((item) => item !== baseSourceSnapshotId);
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "IncrementalRefreshRequest",
    protocol: { name: format.protocol("head-agent-core-incremental-refresh"), version: protocolVersion },
    projectId,
    baseWorldModelId,
    baseSourceSnapshotId,
    trigger: { kind: triggerKind, evidenceIds },
    expectation,
    additionalParentSourceSnapshotIds: parents,
    authority: "bounded-observed-state-refresh-request",
    instructionAuthority: false,
    promotionAuthority: false,
    canonMutationAuthority: false,
  };
  const requestIdentity = identity("incremental-refresh-request", payload);
  return { ...payload, refreshRequestId: requestIdentity.id, refreshRequestHash: requestIdentity.hash };
}

export function buildIncrementalRefreshRequest(options = {}, storage = null) {
  return buildIncrementalRefreshRequestVersion(options, INCREMENTAL_REFRESH_VERSION, storage);
}

export function verifyIncrementalRefreshRequest(request, expectedOwner = null) {
  if (!request || typeof request !== "object" || Array.isArray(request)) fail("Incremental refresh request is invalid.", "INVALID_REFRESH_SCHEMA");
  const format = familyFormatForOriginal("head-agent-core-incremental-refresh", request, expectedOwner);
  const protocolVersion = request.protocol?.version;
  if (![LEGACY_INCREMENTAL_REFRESH_VERSION, INCREMENTAL_REFRESH_VERSION].includes(protocolVersion)
    || !format) fail("Incremental refresh request protocol is unsupported.", "INVALID_REFRESH_SCHEMA");
  const rebuilt = buildIncrementalRefreshRequestVersion({
    projectId: request.projectId,
    baseWorldModelId: request.baseWorldModelId,
    baseSourceSnapshotId: request.baseSourceSnapshotId,
    triggerKind: request.trigger?.kind,
    triggerEvidenceIds: request.trigger?.evidenceIds,
    expectedChangedPaths: request.expectation?.mode === "exact" ? request.expectation.paths : null,
    additionalParentSourceSnapshotIds: request.additionalParentSourceSnapshotIds,
  }, protocolVersion, expectedOwner, format);
  if (!REQUEST_PATTERN.test(request.refreshRequestId || "") || canonicalJson(rebuilt) !== canonicalJson(request)) fail("Incremental refresh request identity verification failed.", "REFRESH_REQUEST_DIGEST_MISMATCH");
  return request;
}

function combinedPaths(changes) {
  return [...changes.added, ...changes.changed, ...changes.removed].sort(compareText);
}

function changeSummary(previous, next) {
  const before = new Map(previous.files.map((file) => [file.path, file.digest]));
  const after = new Map(next.files.map((file) => [file.path, file.digest]));
  return {
    added: [...after.keys()].filter((file) => !before.has(file)).sort(compareText),
    changed: [...after.keys()].filter((file) => before.has(file) && before.get(file) !== after.get(file)).sort(compareText),
    removed: [...before.keys()].filter((file) => !after.has(file)).sort(compareText),
  };
}

function runBinding(inspected, nextSourceSnapshotId) {
  const state = inspected.state;
  if (state.activeRunId) {
    if (!/^run-[A-Za-z0-9-]+$/.test(state.activeRunId)) fail("Active Run id is invalid.", "REFRESH_RUN_STATE_INVALID");
    const runFile = path.join(inspected.project.projectRoot, formatForVerifiedOwner(inspected.storage).directory, "sessions", "runs", state.activeRunId, "run.json");
    const run = readJson(runFile, "Active Run canon");
    if (run.status !== "active" || run.executionContractId !== state.activeExecutionContractId || !run.capsuleId) fail("Active Run canon does not match Session state.", "REFRESH_RUN_STATE_INVALID");
    const capsule = readContextCapsule({ root: inspected.project.projectRoot, capsuleId: run.capsuleId }).capsule;
    const pinnedSourceSnapshotId = capsule.repositoryTemporalGraph?.sourceSnapshotId || null;
    return {
      status: "active-run-pinned-inputs",
      activeRunId: run.runId,
      wholePlanId: run.wholePlanId,
      executionContractId: run.executionContractId,
      capsuleId: run.capsuleId,
      pinnedWorldModelId: capsule.repositoryContext?.[0]?.worldModelId || capsule.productContext?.[0]?.worldModelId || null,
      pinnedSourceSnapshotId,
      refreshedSourceSnapshotId: nextSourceSnapshotId,
      driftDetected: pinnedSourceSnapshotId !== nextSourceSnapshotId,
      requiredHeadAction: "continue-recompile-revise-or-cancel",
    };
  }
  if (state.pendingReview) return {
    status: "pending-review-result-frozen",
    activeRunId: null,
    wholePlanId: state.pendingReview.wholePlanId,
    executionContractId: null,
    capsuleId: null,
    pinnedWorldModelId: null,
    pinnedSourceSnapshotId: null,
    refreshedSourceSnapshotId: nextSourceSnapshotId,
    driftDetected: true,
    requiredHeadAction: "review-result-against-recorded-contract-and-current-drift",
  };
  return {
    status: "no-active-execution",
    activeRunId: null,
    wholePlanId: state.currentWholePlanId || null,
    executionContractId: null,
    capsuleId: null,
    pinnedWorldModelId: null,
    pinnedSourceSnapshotId: null,
    refreshedSourceSnapshotId: nextSourceSnapshotId,
    driftDetected: false,
    requiredHeadAction: "none",
  };
}

function revisionTransition(previousGraph, nextGraph) {
  const kinds = new Set(["FileRevision", "SymbolRevision", "TestRevision", "FeatureGroupRevision", "CapabilityRevision", "FeatureRevision", "RequirementRevision", "ConstraintRevision", "DecisionRevision", "PolicyRevision"]);
  const previousIds = new Set(previousGraph.nodes.filter((node) => kinds.has(node.kind)).map((node) => node.nodeId));
  const revisions = nextGraph.nodes.filter((node) => kinds.has(node.kind));
  return {
    reusedRevisionCount: revisions.filter((node) => previousIds.has(node.nodeId)).length,
    createdRevisionCount: revisions.filter((node) => !previousIds.has(node.nodeId)).length,
    parentedRevisionCount: revisions.filter((node) => node.parentRevisionIds.length > 0).length,
  };
}

function buildReceipt({ request, previousSnapshot, nextSnapshot, status, inspected }) {
  const observedChanges = changeSummary(previousSnapshot, nextSnapshot);
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "IncrementalRefreshReceipt",
    protocol: request.protocol,
    projectId: request.projectId,
    refreshRequestId: request.refreshRequestId,
    refreshRequestHash: request.refreshRequestHash,
    status,
    base: {
      worldModelId: previousSnapshot.worldModelId,
      sourceSnapshotId: previousSnapshot.temporalProvenanceGraph.sourceSnapshotId,
      graphSnapshotId: previousSnapshot.temporalProvenanceGraph.graphSnapshotId,
    },
    next: {
      worldModelId: nextSnapshot.worldModelId,
      sourceSnapshotId: nextSnapshot.temporalProvenanceGraph.sourceSnapshotId,
      graphSnapshotId: nextSnapshot.temporalProvenanceGraph.graphSnapshotId,
      parentSourceSnapshotIds: nextSnapshot.temporalProvenanceGraph.parentSourceSnapshotIds,
    },
    observedChanges,
    revisionTransition: revisionTransition(previousSnapshot.temporalProvenanceGraph, nextSnapshot.temporalProvenanceGraph),
    executionDrift: runBinding(inspected, nextSnapshot.temporalProvenanceGraph.sourceSnapshotId),
    projectionDisposition: {
      graph: "verified-before-world-pointer-advance",
      documents: "not-regenerated-by-refresh-core-post-policy-evaluated-separately",
    },
    authority: "verified-observed-state-refresh-evidence",
    instructionAuthority: false,
    promotionAuthority: false,
    canonMutation: "none",
  };
  const receiptIdentity = identity("incremental-refresh-receipt", payload);
  return { ...payload, refreshReceiptId: receiptIdentity.id, refreshReceiptHash: receiptIdentity.hash };
}

export function verifyIncrementalRefreshReceipt(receipt, expectedOwner = null) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) fail("Incremental refresh receipt is invalid.", "INVALID_REFRESH_SCHEMA");
  assertFields(receipt, ["schemaVersion", "kind", "protocol", "projectId", "refreshRequestId", "refreshRequestHash", "status", "base", "next", "observedChanges", "revisionTransition", "executionDrift", "projectionDisposition", "authority", "instructionAuthority", "promotionAuthority", "canonMutation", "refreshReceiptId", "refreshReceiptHash"], "Incremental refresh receipt");
  assertFields(receipt.base, ["worldModelId", "sourceSnapshotId", "graphSnapshotId"], "Incremental refresh receipt base");
  assertFields(receipt.next, ["worldModelId", "sourceSnapshotId", "graphSnapshotId", "parentSourceSnapshotIds"], "Incremental refresh receipt next");
  assertFields(receipt.observedChanges, ["added", "changed", "removed"], "Incremental refresh receipt changes");
  assertFields(receipt.revisionTransition, ["reusedRevisionCount", "createdRevisionCount", "parentedRevisionCount"], "Incremental refresh receipt revision transition");
  assertFields(receipt.executionDrift, ["status", "activeRunId", "wholePlanId", "executionContractId", "capsuleId", "pinnedWorldModelId", "pinnedSourceSnapshotId", "refreshedSourceSnapshotId", "driftDetected", "requiredHeadAction"], "Incremental refresh receipt execution drift");
  assertFields(receipt.projectionDisposition, ["graph", "documents"], "Incremental refresh receipt projection disposition");
  const format = familyFormatForOriginal("head-agent-core-incremental-refresh", receipt, expectedOwner);
  const protocolVersion = receipt.protocol?.version;
  if (!RECEIPT_PATTERN.test(receipt.refreshReceiptId || "") || !REQUEST_PATTERN.test(receipt.refreshRequestId || "")
    || !["unchanged", "refreshed"].includes(receipt.status)
    || receipt.schemaVersion !== SCHEMA_VERSION
    || !format
    || ![LEGACY_INCREMENTAL_REFRESH_VERSION, INCREMENTAL_REFRESH_VERSION].includes(protocolVersion)
    || receipt.authority !== "verified-observed-state-refresh-evidence"
    || receipt.instructionAuthority !== false || receipt.promotionAuthority !== false || receipt.canonMutation !== "none") {
    fail("Incremental refresh receipt contract is invalid.", "INVALID_REFRESH_RECEIPT");
  }
  for (const side of [receipt.base, receipt.next]) {
    if (!/^world-model-[a-f0-9]{24}$/.test(side.worldModelId || "") || !SOURCE_SNAPSHOT_PATTERN.test(side.sourceSnapshotId || "") || !/^graph-snapshot-[a-f0-9]{24}$/.test(side.graphSnapshotId || "")) {
      fail("Incremental refresh receipt snapshot identity is invalid.", "INVALID_REFRESH_RECEIPT");
    }
  }
  const normalizedParents = normalizedUnique(receipt.next.parentSourceSnapshotIds, "next.parentSourceSnapshotIds", normalizedSourceSnapshotId);
  if (canonicalJson(normalizedParents) !== canonicalJson(receipt.next.parentSourceSnapshotIds)) fail("Incremental refresh SourceSnapshot parents are not canonical.", "INVALID_REFRESH_RECEIPT");
  if (![receipt.revisionTransition.reusedRevisionCount, receipt.revisionTransition.createdRevisionCount, receipt.revisionTransition.parentedRevisionCount]
    .every((value) => Number.isInteger(value) && value >= 0)) fail("Incremental refresh revision counts are invalid.", "INVALID_REFRESH_RECEIPT");
  const driftActions = {
    "active-run-pinned-inputs": "continue-recompile-revise-or-cancel",
    "pending-review-result-frozen": "review-result-against-recorded-contract-and-current-drift",
    "no-active-execution": "none",
  };
  const expectedDocumentDisposition = protocolVersion === LEGACY_INCREMENTAL_REFRESH_VERSION
    ? "not-regenerated-explicit-follow-up-only"
    : "not-regenerated-by-refresh-core-post-policy-evaluated-separately";
  if (!(receipt.executionDrift.status in driftActions)
    || receipt.executionDrift.requiredHeadAction !== driftActions[receipt.executionDrift.status]
    || typeof receipt.executionDrift.driftDetected !== "boolean"
    || receipt.executionDrift.refreshedSourceSnapshotId !== receipt.next.sourceSnapshotId
    || receipt.projectionDisposition.graph !== "verified-before-world-pointer-advance"
    || receipt.projectionDisposition.documents !== expectedDocumentDisposition) {
    fail("Incremental refresh execution or projection disposition is invalid.", "INVALID_REFRESH_RECEIPT");
  }
  const payload = { ...receipt };
  delete payload.refreshReceiptId;
  delete payload.refreshReceiptHash;
  const receiptHash = digest(canonicalJson(payload));
  if (receipt.refreshReceiptHash !== receiptHash || receipt.refreshReceiptId !== `incremental-refresh-receipt-${receiptHash.slice(0, 24)}`) {
    fail("Incremental refresh receipt identity verification failed.", "REFRESH_RECEIPT_DIGEST_MISMATCH");
  }
  const changeGroups = [receipt.observedChanges.added, receipt.observedChanges.changed, receipt.observedChanges.removed]
    .map((group) => normalizedUnique(group, "observedChanges", normalizedPath));
  if (canonicalJson(changeGroups) !== canonicalJson([receipt.observedChanges.added, receipt.observedChanges.changed, receipt.observedChanges.removed])) {
    fail("Incremental refresh changes are not canonically ordered.", "INVALID_REFRESH_RECEIPT");
  }
  if (new Set(changeGroups.flat()).size !== changeGroups.flat().length) fail("Incremental refresh change groups overlap.", "INVALID_REFRESH_RECEIPT");
  if (receipt.status === "unchanged") {
    if (receipt.base.worldModelId !== receipt.next.worldModelId || receipt.base.sourceSnapshotId !== receipt.next.sourceSnapshotId
      || receipt.base.graphSnapshotId !== receipt.next.graphSnapshotId || changeGroups.flat().length !== 0) {
      fail("An unchanged refresh receipt cannot claim new snapshot identities or file changes.", "INVALID_REFRESH_RECEIPT");
    }
  } else if (receipt.base.worldModelId === receipt.next.worldModelId || receipt.base.sourceSnapshotId === receipt.next.sourceSnapshotId
    || !receipt.next.parentSourceSnapshotIds.includes(receipt.base.sourceSnapshotId)) {
    fail("A refreshed receipt must create a child of the verified base SourceSnapshot.", "INVALID_REFRESH_RECEIPT");
  }
  return receipt;
}

function requestFile(projectRoot, requestId, storage = null) {
  if (!REQUEST_PATTERN.test(requestId || "")) fail("Incremental refresh request id is invalid.", "INVALID_REFRESH_REQUEST_ID");
  return path.join(projectRoot, formatForVerifiedOwner(storage).directory, "refresh", "requests", `${requestId}.json`);
}

function receiptFile(projectRoot, receiptId, storage = null) {
  if (!RECEIPT_PATTERN.test(receiptId || "")) fail("Incremental refresh receipt id is invalid.", "INVALID_REFRESH_RECEIPT_ID");
  return path.join(projectRoot, formatForVerifiedOwner(storage).directory, "refresh", "receipts", `${receiptId}.json`);
}

function currentFile(projectRoot, storage = null) {
  return path.join(projectRoot, formatForVerifiedOwner(storage).directory, "refresh", "current.json");
}

function persistImmutable(file, document, verifier, label) {
  if (fs.existsSync(file)) {
    const stored = verifier(readJson(file, label));
    if (canonicalJson(stored) !== canonicalJson(document)) fail(`${label} conflicts with an existing immutable artifact.`, "REFRESH_ARTIFACT_CONFLICT");
    return { file, created: false };
  }
  atomicWrite(file, json(document));
  const stored = verifier(readJson(file, label));
  if (canonicalJson(stored) !== canonicalJson(document)) fail(`${label} changed during persistence.`, "REFRESH_ARTIFACT_WRITE_MISMATCH");
  return { file, created: true };
}

function buildPointer(receipt) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "IncrementalRefreshPointer",
    projectId: receipt.projectId,
    refreshRequestId: receipt.refreshRequestId,
    refreshReceiptId: receipt.refreshReceiptId,
    worldModelId: receipt.next.worldModelId,
    sourceSnapshotId: receipt.next.sourceSnapshotId,
  };
  const pointerIdentity = identity("incremental-refresh-pointer", payload);
  return { ...payload, refreshPointerId: pointerIdentity.id, refreshPointerHash: pointerIdentity.hash };
}

export function verifyIncrementalRefreshPointer(pointer, storage = null) {
  const format = formatForVerifiedOwner(storage);
  assertFields(pointer, ["schemaVersion", "kind", "projectId", "refreshRequestId", "refreshReceiptId", "worldModelId", "sourceSnapshotId", "refreshPointerId", "refreshPointerHash"], "Incremental refresh pointer");
  if (!pointer || pointer.schemaVersion !== SCHEMA_VERSION || pointer.kind !== "IncrementalRefreshPointer"
    || !new RegExp(`^${format.projectPrefix}[a-f0-9]{20}$`).test(pointer.projectId || "")
    || !RECEIPT_PATTERN.test(pointer.refreshReceiptId || "") || !REQUEST_PATTERN.test(pointer.refreshRequestId || "")
    || !/^world-model-[a-f0-9]{24}$/.test(pointer.worldModelId || "") || !SOURCE_SNAPSHOT_PATTERN.test(pointer.sourceSnapshotId || "")) {
    fail("Incremental refresh pointer is invalid.", "INVALID_REFRESH_POINTER");
  }
  const payload = { ...pointer };
  delete payload.refreshPointerId;
  delete payload.refreshPointerHash;
  const pointerHash = digest(canonicalJson(payload));
  if (pointer.refreshPointerHash !== pointerHash || pointer.refreshPointerId !== `incremental-refresh-pointer-${pointerHash.slice(0, 24)}`) {
    fail("Incremental refresh pointer identity verification failed.", "REFRESH_POINTER_DIGEST_MISMATCH");
  }
  return pointer;
}

export function readIncrementalRefreshRequest({ root = ".", refreshRequestId } = {}) {
  const inspected = readyProject(root);
  const file = requestFile(inspected.project.projectRoot, refreshRequestId, inspected.storage);
  if (!fs.existsSync(file)) fail(`Incremental refresh request is missing: ${refreshRequestId}`, "REFRESH_REQUEST_NOT_FOUND");
  const request = verifyIncrementalRefreshRequest(readJson(file, "Incremental refresh request"), inspected.storage);
  if (request.projectId !== inspected.project.projectId) fail("Incremental refresh request belongs to another project.", "REFRESH_PROJECT_MISMATCH");
  return { status: "verified", file, request };
}

export async function readIncrementalRefreshReceipt({ root = ".", refreshReceiptId, storeAdapter = null } = {}) {
  const inspected = readyProject(root);
  const file = receiptFile(inspected.project.projectRoot, refreshReceiptId, inspected.storage);
  if (!fs.existsSync(file)) fail(`Incremental refresh receipt is missing: ${refreshReceiptId}`, "REFRESH_RECEIPT_NOT_FOUND");
  const receipt = verifyIncrementalRefreshReceipt(readJson(file, "Incremental refresh receipt"), inspected.storage);
  if (receipt.projectId !== inspected.project.projectId) fail("Incremental refresh receipt belongs to another project.", "REFRESH_PROJECT_MISMATCH");
  const requestEntry = readIncrementalRefreshRequest({ root: inspected.project.projectRoot, refreshRequestId: receipt.refreshRequestId });
  if (requestEntry.request.refreshRequestHash !== receipt.refreshRequestHash
    || requestEntry.request.baseWorldModelId !== receipt.base.worldModelId
    || requestEntry.request.baseSourceSnapshotId !== receipt.base.sourceSnapshotId) {
    fail("Incremental refresh request and receipt disagree.", "REFRESH_REQUEST_RECEIPT_MISMATCH");
  }
  const baseSnapshot = (await readWorldModelSnapshot({ root: inspected.project.projectRoot, worldModelId: receipt.base.worldModelId, storeAdapter })).snapshot;
  const nextSnapshot = receipt.next.worldModelId === receipt.base.worldModelId
    ? baseSnapshot
    : (await readWorldModelSnapshot({ root: inspected.project.projectRoot, worldModelId: receipt.next.worldModelId, storeAdapter })).snapshot;
  if (baseSnapshot.temporalProvenanceGraph.sourceSnapshotId !== receipt.base.sourceSnapshotId
    || baseSnapshot.temporalProvenanceGraph.graphSnapshotId !== receipt.base.graphSnapshotId
    || nextSnapshot.temporalProvenanceGraph.sourceSnapshotId !== receipt.next.sourceSnapshotId
    || nextSnapshot.temporalProvenanceGraph.graphSnapshotId !== receipt.next.graphSnapshotId
    || canonicalJson(nextSnapshot.temporalProvenanceGraph.parentSourceSnapshotIds) !== canonicalJson(receipt.next.parentSourceSnapshotIds)
    || canonicalJson(changeSummary(baseSnapshot, nextSnapshot)) !== canonicalJson(receipt.observedChanges)
    || canonicalJson(revisionTransition(baseSnapshot.temporalProvenanceGraph, nextSnapshot.temporalProvenanceGraph)) !== canonicalJson(receipt.revisionTransition)) {
    fail("Incremental refresh receipt does not match its verified World Model snapshots.", "REFRESH_RECEIPT_SNAPSHOT_MISMATCH");
  }
  return { status: "verified", file, receipt, requestFile: requestEntry.file, request: requestEntry.request };
}

export async function inspectIncrementalRefresh({ root = ".", storeAdapter = null } = {}) {
  const inspected = readyProject(root);
  const file = currentFile(inspected.project.projectRoot, inspected.storage);
  const world = (await readWorldModel({ root: inspected.project.projectRoot, storeAdapter }));
  if (!fs.existsSync(file)) return {
    status: "not-refreshed",
    currentWorldModelId: world.snapshot.worldModelId,
    currentSourceSnapshotId: world.snapshot.temporalProvenanceGraph.sourceSnapshotId,
  };
  const pointer = verifyIncrementalRefreshPointer(readJson(file, "Incremental refresh pointer"), inspected.storage);
  if (pointer.projectId !== inspected.project.projectId) fail("Incremental refresh pointer belongs to another project.", "REFRESH_PROJECT_MISMATCH");
  const receipt = (await readIncrementalRefreshReceipt({ root: inspected.project.projectRoot, refreshReceiptId: pointer.refreshReceiptId, storeAdapter })).receipt;
  if (receipt.refreshRequestId !== pointer.refreshRequestId || receipt.next.worldModelId !== pointer.worldModelId || receipt.next.sourceSnapshotId !== pointer.sourceSnapshotId) {
    fail("Incremental refresh pointer and receipt disagree.", "REFRESH_POINTER_MISMATCH");
  }
  const freshness = (await inspectWorldModel({ root: inspected.project.projectRoot, storeAdapter }));
  return {
    status: world.snapshot.worldModelId === receipt.next.worldModelId && freshness.status === "current" ? "current" : "stale",
    pointerFile: file,
    pointer,
    receipt,
    currentWorldModelId: world.snapshot.worldModelId,
    currentSourceSnapshotId: world.snapshot.temporalProvenanceGraph.sourceSnapshotId,
    worldModelFreshness: freshness.status,
  };
}

export async function readPostRefreshProjectionReceipt({ root = ".", postRefreshProjectionReceiptId, storeAdapter = null, documentProjectionAdapter = null } = {}) {
  const post = readPostRefreshProjectionReceiptArtifact({ root, postRefreshProjectionReceiptId, documentProjectionAdapter });
  const refresh = (await readIncrementalRefreshReceipt({ root, refreshReceiptId: post.receipt.refresh.refreshReceiptId, storeAdapter }));
  if (post.receipt.refresh.refreshRequestId !== refresh.request.refreshRequestId
    || post.receipt.refresh.refreshRequestHash !== refresh.request.refreshRequestHash
    || post.receipt.refresh.refreshReceiptHash !== refresh.receipt.refreshReceiptHash
    || post.receipt.refresh.status !== refresh.receipt.status
    || canonicalJson({
      worldModelId: post.receipt.base.worldModelId,
      sourceSnapshotId: post.receipt.base.sourceSnapshotId,
      graphSnapshotId: post.receipt.base.graphSnapshotId,
    }) !== canonicalJson(refresh.receipt.base)
    || post.receipt.target.worldModelId !== refresh.receipt.next.worldModelId
    || post.receipt.target.sourceSnapshotId !== refresh.receipt.next.sourceSnapshotId
    || post.receipt.target.graphSnapshotId !== refresh.receipt.next.graphSnapshotId) {
    fail("Post-refresh projection receipt does not match its incremental refresh lineage.", "POST_REFRESH_PROJECTION_REFRESH_MISMATCH");
  }
  return { ...post, refresh };
}

export async function inspectPostRefreshProjectionStatus({ root = ".", storeAdapter = null, documentProjectionAdapter = null } = {}) {
  const status = inspectPostRefreshProjectionArtifact({ root, documentProjectionAdapter });
  if (!status.receipt) return status;
  const verified = (await readPostRefreshProjectionReceipt({
    root,
    postRefreshProjectionReceiptId: status.receipt.postRefreshProjectionReceiptId,
    storeAdapter,
    documentProjectionAdapter,
  }));
  return { ...status, receipt: verified.receipt, refresh: verified.refresh };
}

async function refreshWorldModelLocked({
  root = ".",
  triggerKind = "manual",
  triggerEvidenceIds = [],
  expectedChangedPaths = null,
  additionalParentSourceSnapshotIds = [],
  storeAdapter = null,
  graphProjectionAdapter = null,
  gitHistoryAdapter = null,
  runtimeStateAdapter = null,
  writerLease = null,
} = {}) {
  const inspected = readyProject(root);
  const projectRoot = inspected.project.projectRoot;
  const stored = (await readWorldModel({ root: projectRoot, storeAdapter }));
  const previousSnapshot = stored.snapshot;
  const request = buildIncrementalRefreshRequest({
    projectId: inspected.project.projectId,
    baseWorldModelId: previousSnapshot.worldModelId,
    baseSourceSnapshotId: previousSnapshot.temporalProvenanceGraph.sourceSnapshotId,
    triggerKind,
    triggerEvidenceIds,
    expectedChangedPaths,
    additionalParentSourceSnapshotIds,
  }, inspected.storage);
  const repositoryScanExecution = await executeIncrementalRepositoryScan({
    projectRoot,
    managedRootFiles: managedRootFilesForProject(inspected.project, inspected.storage),
    sourceScope: readRepositorySourceScope({ projectRoot, storage: inspected.storage }).sourceScope,
    previousSnapshot,
    storage: inspected.storage,
  });
  const observedPaths = combinedPaths(repositoryScanExecution.diagnostics.changes);
  if (request.expectation.mode === "exact" && canonicalJson(observedPaths) !== canonicalJson(request.expectation.paths)) {
    fail("Observed changed paths do not match the exact refresh expectation.", "REFRESH_CHANGE_EXPECTATION_MISMATCH");
  }

  const common = {
    root: projectRoot,
    persist: false,
    storeAdapter,
    gitHistoryAdapter,
    runtimeStateAdapter,
    repositoryScanExecution,
  };
  const sameLineagePreview = await buildWorldModel({
    ...common,
    parentSourceSnapshotIds: previousSnapshot.temporalProvenanceGraph.parentSourceSnapshotIds,
    revisionParentIds: previousSnapshot.temporalProvenanceGraph.revisionParentIds,
    filterRevisionParentsToCurrentEntities: true,
  });
  const additionalParentsRequested = request.additionalParentSourceSnapshotIds
    .some((parentId) => !previousSnapshot.temporalProvenanceGraph.parentSourceSnapshotIds.includes(parentId));
  const requiresRefresh = sameLineagePreview.snapshot.worldModelId !== previousSnapshot.worldModelId || additionalParentsRequested;
  let nextPreview = sameLineagePreview;
  let revisionParentIds = previousSnapshot.temporalProvenanceGraph.revisionParentIds;
  let parentSourceSnapshotIds = previousSnapshot.temporalProvenanceGraph.parentSourceSnapshotIds;
  if (requiresRefresh) {
    revisionParentIds = deriveIncrementalRevisionParents({
      previousGraph: previousSnapshot.temporalProvenanceGraph,
      candidateGraph: sameLineagePreview.snapshot.temporalProvenanceGraph,
    });
    parentSourceSnapshotIds = [...new Set([
      previousSnapshot.temporalProvenanceGraph.sourceSnapshotId,
      ...request.additionalParentSourceSnapshotIds,
    ])].sort(compareText);
    nextPreview = await buildWorldModel({ ...common, parentSourceSnapshotIds, revisionParentIds });
  }

  const receipt = buildReceipt({
    request,
    previousSnapshot,
    nextSnapshot: requiresRefresh ? nextPreview.snapshot : previousSnapshot,
    status: requiresRefresh ? "refreshed" : "unchanged",
    inspected,
  });
  const requestEntry = persistImmutable(requestFile(projectRoot, request.refreshRequestId, inspected.storage), request, (record) => verifyIncrementalRefreshRequest(record, inspected.storage), "Incremental refresh request");

  let world = stored;
  if (requiresRefresh) {
    world = await buildWorldModel({
      root: projectRoot,
      persist: true,
      storeAdapter,
      graphProjectionAdapter,
      gitHistoryAdapter,
      runtimeStateAdapter,
      repositoryScanExecution,
      parentSourceSnapshotIds,
      revisionParentIds,
      expectedWorldModelId: nextPreview.snapshot.worldModelId,
      expectedCurrentWorldModelId: previousSnapshot.worldModelId,
      writerLease,
    });
    if (world.snapshot.worldModelId !== receipt.next.worldModelId || world.snapshot.temporalProvenanceGraph.sourceSnapshotId !== receipt.next.sourceSnapshotId) {
      fail("Persisted World Model does not match the verified refresh receipt.", "REFRESH_PERSISTENCE_MISMATCH");
    }
  }
  const receiptEntry = persistImmutable(receiptFile(projectRoot, receipt.refreshReceiptId, inspected.storage), receipt, (record) => verifyIncrementalRefreshReceipt(record, inspected.storage), "Incremental refresh receipt");
  const pointer = buildPointer(receipt);
  atomicWrite(currentFile(projectRoot, inspected.storage), json(pointer));
  const storedPointer = verifyIncrementalRefreshPointer(readJson(currentFile(projectRoot, inspected.storage), "Incremental refresh pointer"), inspected.storage);
  if (canonicalJson(storedPointer) !== canonicalJson(pointer)) fail("Incremental refresh pointer changed during persistence.", "REFRESH_POINTER_WRITE_MISMATCH");

  return {
    status: receipt.status,
    requestFile: requestEntry.file,
    receiptFile: receiptEntry.file,
    pointerFile: currentFile(projectRoot, inspected.storage),
    request,
    receipt,
    pointer,
    worldModel: {
      worldModelId: world.snapshot.worldModelId,
      sourceSnapshotId: world.snapshot.temporalProvenanceGraph.sourceSnapshotId,
      graphSnapshotId: world.snapshot.temporalProvenanceGraph.graphSnapshotId,
    },
    diagnostics: {
      repositoryScan: repositoryScanExecution.diagnostics,
      semanticConformance: "validated-by-repository-scan-contract; full-reference equivalence is covered by conformance tests",
    },
  };
}

export async function refreshWorldModel(options = {}) {
  const root = options.root ?? ".";
  const inspected = readyProject(root);
  return (await withRefreshWriterLease({
    projectRoot: inspected.project.projectRoot,
    projectId: inspected.project.projectId,
    lease: options.writerLease || null,
    storage: inspected.storage,
  }, async (writerLease) => {
    const beforeSnapshot = (await readWorldModel({ root: inspected.project.projectRoot, storeAdapter: options.storeAdapter || null })).snapshot;
    const preflight = preparePostRefreshProjection({
      projectRoot: inspected.project.projectRoot,
      projectId: inspected.project.projectId,
      storage: inspected.storage,
      graph: beforeSnapshot.temporalProvenanceGraph,
      documentProjectionAdapter: options.documentProjectionAdapter || null,
    });
    const refreshed = await refreshWorldModelLocked({ ...options, writerLease });
    const afterSnapshot = (await readWorldModel({ root: inspected.project.projectRoot, storeAdapter: options.storeAdapter || null })).snapshot;
    const postRefreshProjection = completePostRefreshProjection({
      projectRoot: inspected.project.projectRoot,
      projectId: inspected.project.projectId,
      storage: inspected.storage,
      beforeSnapshot,
      afterSnapshot,
      refreshRequest: refreshed.request,
      refreshReceipt: refreshed.receipt,
      preflight,
      documentProjectionAdapter: options.documentProjectionAdapter || null,
    });
    return { ...refreshed, postRefreshProjection };
  }));
}
