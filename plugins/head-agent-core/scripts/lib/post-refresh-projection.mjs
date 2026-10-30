import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { familyFormatForOriginal, formatForVerifiedOwner } from "./project-storage-format.mjs";
import { inspectProject, SCHEMA_VERSION } from "./lode-core.mjs";
import {
  captureDocumentChangeCandidates,
  createDocumentProjectionAdapter,
  inspectMarkdownProjection,
  materializeMarkdownProjection,
  readDocumentChangeCandidateSet,
  verifyDocumentProjection,
} from "./document-projection-adapter.mjs";

export const POST_REFRESH_PROJECTION_VERSION = "0.1.0";
export const DEFAULT_POST_REFRESH_PROJECTION_MODE = "manual";

const POLICY_PATTERN = /^post-refresh-projection-policy-[a-f0-9]{24}$/;
const RECEIPT_PATTERN = /^post-refresh-projection-receipt-[a-f0-9]{24}$/;
const REFRESH_REQUEST_PATTERN = /^incremental-refresh-request-[a-f0-9]{24}$/;
const REFRESH_RECEIPT_PATTERN = /^incremental-refresh-receipt-[a-f0-9]{24}$/;
const DOCUMENT_PROJECTION_PATTERN = /^document-projection-[a-f0-9]{24}$/;
const CANDIDATE_SET_PATTERN = /^document-change-candidate-set-[a-f0-9]{24}$/;
const MODES = new Set(["manual", "automatic"]);
const OUTCOMES = new Set([
  "manual-deferred",
  "projected",
  "unchanged",
  "blocked-edited-view",
  "blocked-stale-edited-view",
  "blocked-unmanaged-view",
  "failed",
]);
const BASE_STATUSES = new Set([
  "not-inspected-manual-policy",
  "not-materialized",
  "unmanaged",
  "current",
  "stale",
  "modified",
  "inspection-failed",
]);

const fail = (message, code = "POST_REFRESH_PROJECTION_ERROR") => {
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

function assertFields(record, allowed, label) {
  if (!record || typeof record !== "object" || Array.isArray(record)) fail(`${label} must be an object.`, "INVALID_POST_REFRESH_PROJECTION_SCHEMA");
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length) fail(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}`, "INVALID_POST_REFRESH_PROJECTION_SCHEMA");
}

function readyProject(root) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") fail(`Project must be ready for document projection policy; current status: ${inspected.status}.`, "PROJECT_NOT_READY");
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
  catch (error) { fail(`${label} is invalid JSON: ${error.message}`, "INVALID_POST_REFRESH_PROJECTION_DOCUMENT"); }
}

function identity(prefix, payload) {
  const hash = digest(canonicalJson(payload));
  return { id: `${prefix}-${hash.slice(0, 24)}`, hash };
}

function rootDirectory(projectRoot, storage) {
  return path.join(path.resolve(projectRoot), formatForVerifiedOwner(storage).directory, "document-projection", "post-refresh");
}

function policyFile(projectRoot, policyId, storage) {
  if (!POLICY_PATTERN.test(policyId || "")) fail("Post-refresh projection policy id is invalid.", "INVALID_POST_REFRESH_PROJECTION_POLICY_ID");
  return path.join(rootDirectory(projectRoot, storage), "policies", `${policyId}.json`);
}

function policyPointerFile(projectRoot, storage) {
  return path.join(rootDirectory(projectRoot, storage), "current-policy.json");
}

function receiptFile(projectRoot, receiptId, storage) {
  if (!RECEIPT_PATTERN.test(receiptId || "")) fail("Post-refresh projection receipt id is invalid.", "INVALID_POST_REFRESH_PROJECTION_RECEIPT_ID");
  return path.join(rootDirectory(projectRoot, storage), "receipts", `${receiptId}.json`);
}

function receiptPointerFile(projectRoot, storage) {
  return path.join(rootDirectory(projectRoot, storage), "current.json");
}

function persistImmutable(file, document, verifier, label, storage) {
  if (fs.existsSync(file)) {
    const stored = verifier(readJson(file, label), storage);
    if (canonicalJson(stored) !== canonicalJson(document)) fail(`${label} conflicts with an existing immutable artifact.`, "POST_REFRESH_PROJECTION_ARTIFACT_CONFLICT");
    return { file, created: false };
  }
  atomicWrite(file, json(document));
  const stored = verifier(readJson(file, label), storage);
  if (canonicalJson(stored) !== canonicalJson(document)) fail(`${label} changed during persistence.`, "POST_REFRESH_PROJECTION_ARTIFACT_WRITE_MISMATCH");
  return { file, created: true };
}

function buildPolicy({ projectId, mode, selection }, storage) {
  if (!new RegExp(`^${formatForVerifiedOwner(storage).projectPrefix}[a-f0-9]{20}$`).test(projectId || "") || !MODES.has(mode) || !["implicit-safe-default", "explicit-user-selection"].includes(selection)) {
    fail("Post-refresh projection policy input is invalid.", "INVALID_POST_REFRESH_PROJECTION_POLICY");
  }
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "PostRefreshProjectionPolicy",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-post-refresh-projection"), version: POST_REFRESH_PROJECTION_VERSION },
    projectId,
    mode,
    formats: ["markdown"],
    selection,
    safeguards: {
      editedDocuments: "capture-candidates-and-preserve",
      unmanagedDocuments: "preserve-and-block",
      projectionFailure: "preserve-world-model-and-record-failure",
    },
    authority: "operational-projection-policy-not-project-canon",
    instructionAuthority: false,
    promotionAuthority: false,
    canonMutation: "none",
  };
  const policyIdentity = identity("post-refresh-projection-policy", payload);
  return verifyPostRefreshProjectionPolicy({ ...payload, policyId: policyIdentity.id, policyHash: policyIdentity.hash }, storage);
}

export function verifyPostRefreshProjectionPolicy(policy, storage = undefined) {
  assertFields(policy, ["schemaVersion", "kind", "protocol", "projectId", "mode", "formats", "selection", "safeguards", "authority", "instructionAuthority", "promotionAuthority", "canonMutation", "policyId", "policyHash"], "Post-refresh projection policy");
  assertFields(policy.safeguards, ["editedDocuments", "unmanagedDocuments", "projectionFailure"], "Post-refresh projection policy safeguards");
  if (policy.schemaVersion !== SCHEMA_VERSION || policy.kind !== "PostRefreshProjectionPolicy"
    || canonicalJson(policy.protocol) !== canonicalJson({ name: familyFormatForOriginal("head-agent-core-post-refresh-projection", policy, storage)?.protocol("head-agent-core-post-refresh-projection"), version: POST_REFRESH_PROJECTION_VERSION })
    || !new RegExp(`^${(familyFormatForOriginal("head-agent-core-post-refresh-projection", policy, storage)?.projectPrefix)}[a-f0-9]{20}$`).test(policy.projectId || "") || !POLICY_PATTERN.test(policy.policyId || "")
    || !/^[a-f0-9]{64}$/.test(policy.policyHash || "") || !MODES.has(policy.mode)
    || canonicalJson(policy.formats) !== canonicalJson(["markdown"])
    || !["implicit-safe-default", "explicit-user-selection"].includes(policy.selection)
    || policy.safeguards.editedDocuments !== "capture-candidates-and-preserve"
    || policy.safeguards.unmanagedDocuments !== "preserve-and-block"
    || policy.safeguards.projectionFailure !== "preserve-world-model-and-record-failure"
    || policy.authority !== "operational-projection-policy-not-project-canon"
    || policy.instructionAuthority !== false || policy.promotionAuthority !== false || policy.canonMutation !== "none") {
    fail("Post-refresh projection policy contract is invalid.", "INVALID_POST_REFRESH_PROJECTION_POLICY");
  }
  const payload = { ...policy };
  delete payload.policyId;
  delete payload.policyHash;
  const expected = identity("post-refresh-projection-policy", payload);
  if (policy.policyId !== expected.id || policy.policyHash !== expected.hash) fail("Post-refresh projection policy digest verification failed.", "POST_REFRESH_PROJECTION_POLICY_DIGEST_MISMATCH");
  return policy;
}

function buildPolicyPointer(policy) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "PostRefreshProjectionPolicyPointer",
    projectId: policy.projectId,
    policyId: policy.policyId,
    policyHash: policy.policyHash,
  };
  const pointerIdentity = identity("post-refresh-projection-policy-pointer", payload);
  return { ...payload, pointerId: pointerIdentity.id, pointerHash: pointerIdentity.hash };
}

function verifyPolicyPointer(pointer, storage) {
  assertFields(pointer, ["schemaVersion", "kind", "projectId", "policyId", "policyHash", "pointerId", "pointerHash"], "Post-refresh projection policy pointer");
  if (pointer.schemaVersion !== SCHEMA_VERSION || pointer.kind !== "PostRefreshProjectionPolicyPointer"
    || !new RegExp(`^${formatForVerifiedOwner(storage).projectPrefix}[a-f0-9]{20}$`).test(pointer.projectId || "") || !POLICY_PATTERN.test(pointer.policyId || "")
    || !/^[a-f0-9]{64}$/.test(pointer.policyHash || "")
    || !/^post-refresh-projection-policy-pointer-[a-f0-9]{24}$/.test(pointer.pointerId || "")
    || !/^[a-f0-9]{64}$/.test(pointer.pointerHash || "")) fail("Post-refresh projection policy pointer is invalid.", "INVALID_POST_REFRESH_PROJECTION_POLICY_POINTER");
  const payload = { ...pointer };
  delete payload.pointerId;
  delete payload.pointerHash;
  const expected = identity("post-refresh-projection-policy-pointer", payload);
  if (pointer.pointerId !== expected.id || pointer.pointerHash !== expected.hash) fail("Post-refresh projection policy pointer digest verification failed.", "POST_REFRESH_PROJECTION_POLICY_POINTER_DIGEST_MISMATCH");
  return pointer;
}

function loadEffectivePolicy({ projectRoot, projectId }, storage) {
  const pointerLocation = policyPointerFile(projectRoot, storage);
  if (!fs.existsSync(pointerLocation)) {
    return { status: "implicit-default", policy: buildPolicy({ projectId, mode: DEFAULT_POST_REFRESH_PROJECTION_MODE, selection: "implicit-safe-default" }, storage), policyFile: null, pointer: null, pointerFile: null };
  }
  const pointer = verifyPolicyPointer(readJson(pointerLocation, "Post-refresh projection policy pointer"), storage);
  if (pointer.projectId !== projectId) fail("Post-refresh projection policy pointer belongs to another project.", "POST_REFRESH_PROJECTION_PROJECT_MISMATCH");
  const file = policyFile(projectRoot, pointer.policyId, storage);
  if (!fs.existsSync(file)) fail("Post-refresh projection policy pointer references a missing policy.", "POST_REFRESH_PROJECTION_POLICY_NOT_FOUND");
  const policy = verifyPostRefreshProjectionPolicy(readJson(file, "Post-refresh projection policy"), storage);
  if (policy.projectId !== projectId || policy.policyHash !== pointer.policyHash) fail("Post-refresh projection policy and pointer disagree.", "POST_REFRESH_PROJECTION_POLICY_POINTER_MISMATCH");
  return { status: "configured", policy, policyFile: file, pointer, pointerFile: pointerLocation };
}

export function setPostRefreshProjectionPolicy(options = {}) {
  assertFields(options, ["root", "mode"], "Post-refresh projection policy options");
  const { root = ".", mode } = options;
  const inspected = readyProject(root);
  const storage = inspected.storage;
  if (!MODES.has(mode)) fail("Post-refresh projection mode must be manual or automatic.", "INVALID_POST_REFRESH_PROJECTION_MODE");
  const projectRoot = inspected.project.projectRoot;
  const policy = buildPolicy({ projectId: inspected.project.projectId, mode, selection: "explicit-user-selection" }, storage);
  const stored = persistImmutable(policyFile(projectRoot, policy.policyId, storage), policy, verifyPostRefreshProjectionPolicy, "Post-refresh projection policy", storage);
  const pointer = buildPolicyPointer(policy);
  atomicWrite(policyPointerFile(projectRoot, storage), json(pointer));
  const verifiedPointer = verifyPolicyPointer(readJson(policyPointerFile(projectRoot, storage), "Post-refresh projection policy pointer"), storage);
  if (canonicalJson(verifiedPointer) !== canonicalJson(pointer)) fail("Post-refresh projection policy pointer changed during persistence.", "POST_REFRESH_PROJECTION_POLICY_POINTER_WRITE_MISMATCH");
  return { status: "configured", policy, policyFile: stored.file, pointer, pointerFile: policyPointerFile(projectRoot, storage) };
}

export function inspectPostRefreshProjectionPolicy({ root = "." } = {}) {
  const inspected = readyProject(root);
  const storage = inspected.storage;
  return loadEffectivePolicy({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId }, storage);
}

function binding(snapshot) {
  return {
    worldModelId: snapshot.worldModelId,
    sourceSnapshotId: snapshot.temporalProvenanceGraph.sourceSnapshotId,
    graphSnapshotId: snapshot.temporalProvenanceGraph.graphSnapshotId,
  };
}

function normalizedErrorCode(error) {
  const code = typeof error?.code === "string" ? error.code : "DOCUMENT_PROJECTION_FAILED";
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : "DOCUMENT_PROJECTION_FAILED";
}

export function preparePostRefreshProjection({ projectRoot, storage, projectId, graph, documentProjectionAdapter = null } = {}) {
  let loaded;
  try {
    loaded = loadEffectivePolicy({ projectRoot, projectId }, storage);
  } catch (error) {
    return {
      policy: null,
      policyStatus: "invalid",
      baseDocumentStatus: "inspection-failed",
      baseDocumentProjectionId: null,
      disposition: "failed",
      reasonCode: normalizedErrorCode(error),
      candidateSet: null,
    };
  }
  const { policy } = loaded;
  if (policy.mode === "manual") return {
    policy,
    policyStatus: loaded.status,
    baseDocumentStatus: "not-inspected-manual-policy",
    baseDocumentProjectionId: null,
    disposition: "manual-deferred",
    reasonCode: "MANUAL_POLICY",
    candidateSet: null,
  };
  try {
    const inspected = inspectMarkdownProjection({ projectRoot, storage, graph, adapter: documentProjectionAdapter });
    if (inspected.status === "unmanaged") return {
      policy,
      policyStatus: loaded.status,
      baseDocumentStatus: inspected.status,
      baseDocumentProjectionId: null,
      disposition: "blocked-unmanaged-view",
      reasonCode: "DOCUMENT_PROJECTION_UNMANAGED_CONTENT",
      candidateSet: null,
    };
    if (inspected.status === "modified") {
      if (inspected.graphFreshness !== "current") return {
        policy,
        policyStatus: loaded.status,
        baseDocumentStatus: inspected.status,
        baseDocumentProjectionId: inspected.documentProjectionId,
        disposition: "blocked-stale-edited-view",
        reasonCode: "DOCUMENT_PROJECTION_STALE_EDITED_VIEW",
        candidateSet: null,
      };
      const captured = captureDocumentChangeCandidates({ projectRoot, storage, graph, adapter: documentProjectionAdapter, persist: true });
      return {
        policy,
        policyStatus: loaded.status,
        baseDocumentStatus: inspected.status,
        baseDocumentProjectionId: inspected.documentProjectionId,
        disposition: "blocked-edited-view",
        reasonCode: "DOCUMENT_CHANGE_CANDIDATES_REQUIRE_REVIEW",
        candidateSet: captured.candidateSet,
      };
    }
    return {
      policy,
      policyStatus: loaded.status,
      baseDocumentStatus: inspected.status,
      baseDocumentProjectionId: inspected.documentProjectionId || null,
      disposition: "ready",
      reasonCode: "READY_FOR_AUTOMATIC_MARKDOWN_PROJECTION",
      candidateSet: null,
    };
  } catch (error) {
    return {
      policy,
      policyStatus: loaded.status,
      baseDocumentStatus: "inspection-failed",
      baseDocumentProjectionId: null,
      disposition: "failed",
      reasonCode: normalizedErrorCode(error),
      candidateSet: null,
    };
  }
}

function buildReceipt({ projectId, preflight, beforeSnapshot, afterSnapshot, refreshRequest, refreshReceipt, outcome }, storage) {
  const candidateSet = preflight.candidateSet || null;
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "PostRefreshProjectionReceipt",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-post-refresh-projection"), version: POST_REFRESH_PROJECTION_VERSION },
    projectId,
    policy: preflight.policy ? {
      policyId: preflight.policy.policyId,
      policyHash: preflight.policy.policyHash,
      mode: preflight.policy.mode,
      selection: preflight.policy.selection,
    } : null,
    refresh: {
      refreshRequestId: refreshRequest.refreshRequestId,
      refreshRequestHash: refreshRequest.refreshRequestHash,
      refreshReceiptId: refreshReceipt.refreshReceiptId,
      refreshReceiptHash: refreshReceipt.refreshReceiptHash,
      status: refreshReceipt.status,
    },
    base: {
      ...binding(beforeSnapshot),
      documentStatus: preflight.baseDocumentStatus,
      documentProjectionId: preflight.baseDocumentProjectionId,
    },
    target: binding(afterSnapshot),
    outcome: {
      status: outcome.status,
      reasonCode: outcome.reasonCode,
      documentProjectionId: outcome.documentProjectionId || null,
      documentProjectionHash: outcome.documentProjectionHash || null,
      candidateSetId: candidateSet?.candidateSetId || null,
      candidateSetHash: candidateSet?.candidateSetHash || null,
    },
    authority: "derived-post-refresh-projection-evidence-only",
    instructionAuthority: false,
    promotionAuthority: false,
    canonMutation: "none",
    activeRunMutation: "none",
  };
  const receiptIdentity = identity("post-refresh-projection-receipt", payload);
  return verifyPostRefreshProjectionReceipt({ ...payload, postRefreshProjectionReceiptId: receiptIdentity.id, postRefreshProjectionReceiptHash: receiptIdentity.hash }, storage);
}

function validSnapshotBinding(value, label) {
  assertFields(value, ["worldModelId", "sourceSnapshotId", "graphSnapshotId"], label);
  if (!/^world-model-[a-f0-9]{24}$/.test(value.worldModelId || "")
    || !/^source-snapshot-[a-f0-9]{24}$/.test(value.sourceSnapshotId || "")
    || !/^graph-snapshot-[a-f0-9]{24}$/.test(value.graphSnapshotId || "")) fail(`${label} is invalid.`, "INVALID_POST_REFRESH_PROJECTION_RECEIPT");
}

export function verifyPostRefreshProjectionReceipt(receipt, storage = undefined) {
  assertFields(receipt, ["schemaVersion", "kind", "protocol", "projectId", "policy", "refresh", "base", "target", "outcome", "authority", "instructionAuthority", "promotionAuthority", "canonMutation", "activeRunMutation", "postRefreshProjectionReceiptId", "postRefreshProjectionReceiptHash"], "Post-refresh projection receipt");
  assertFields(receipt.refresh, ["refreshRequestId", "refreshRequestHash", "refreshReceiptId", "refreshReceiptHash", "status"], "Post-refresh projection receipt refresh binding");
  assertFields(receipt.base, ["worldModelId", "sourceSnapshotId", "graphSnapshotId", "documentStatus", "documentProjectionId"], "Post-refresh projection receipt base");
  assertFields(receipt.outcome, ["status", "reasonCode", "documentProjectionId", "documentProjectionHash", "candidateSetId", "candidateSetHash"], "Post-refresh projection receipt outcome");
  validSnapshotBinding({ worldModelId: receipt.base.worldModelId, sourceSnapshotId: receipt.base.sourceSnapshotId, graphSnapshotId: receipt.base.graphSnapshotId }, "Post-refresh projection receipt base snapshot");
  validSnapshotBinding(receipt.target, "Post-refresh projection receipt target snapshot");
  if (receipt.policy !== null) assertFields(receipt.policy, ["policyId", "policyHash", "mode", "selection"], "Post-refresh projection receipt policy binding");
  if (receipt.schemaVersion !== SCHEMA_VERSION || receipt.kind !== "PostRefreshProjectionReceipt"
    || canonicalJson(receipt.protocol) !== canonicalJson({ name: familyFormatForOriginal("head-agent-core-post-refresh-projection", receipt, storage)?.protocol("head-agent-core-post-refresh-projection"), version: POST_REFRESH_PROJECTION_VERSION })
    || !new RegExp(`^${(familyFormatForOriginal("head-agent-core-post-refresh-projection", receipt, storage)?.projectPrefix)}[a-f0-9]{20}$`).test(receipt.projectId || "")
    || !RECEIPT_PATTERN.test(receipt.postRefreshProjectionReceiptId || "")
    || !/^[a-f0-9]{64}$/.test(receipt.postRefreshProjectionReceiptHash || "")
    || !REFRESH_REQUEST_PATTERN.test(receipt.refresh.refreshRequestId || "")
    || !/^[a-f0-9]{64}$/.test(receipt.refresh.refreshRequestHash || "")
    || !REFRESH_RECEIPT_PATTERN.test(receipt.refresh.refreshReceiptId || "")
    || !/^[a-f0-9]{64}$/.test(receipt.refresh.refreshReceiptHash || "")
    || !["unchanged", "refreshed"].includes(receipt.refresh.status)
    || !BASE_STATUSES.has(receipt.base.documentStatus)
    || (receipt.base.documentProjectionId !== null && !DOCUMENT_PROJECTION_PATTERN.test(receipt.base.documentProjectionId || ""))
    || !OUTCOMES.has(receipt.outcome.status) || !/^[A-Z][A-Z0-9_]{0,79}$/.test(receipt.outcome.reasonCode || "")
    || receipt.authority !== "derived-post-refresh-projection-evidence-only"
    || receipt.instructionAuthority !== false || receipt.promotionAuthority !== false
    || receipt.canonMutation !== "none" || receipt.activeRunMutation !== "none") {
    fail("Post-refresh projection receipt contract is invalid.", "INVALID_POST_REFRESH_PROJECTION_RECEIPT");
  }
  if (receipt.policy !== null && (!POLICY_PATTERN.test(receipt.policy.policyId || "")
    || !/^[a-f0-9]{64}$/.test(receipt.policy.policyHash || "") || !MODES.has(receipt.policy.mode)
    || !["implicit-safe-default", "explicit-user-selection"].includes(receipt.policy.selection))) {
    fail("Post-refresh projection receipt policy binding is invalid.", "INVALID_POST_REFRESH_PROJECTION_RECEIPT");
  }
  const hasProjection = receipt.outcome.documentProjectionId !== null || receipt.outcome.documentProjectionHash !== null;
  const hasCandidate = receipt.outcome.candidateSetId !== null || receipt.outcome.candidateSetHash !== null;
  if (hasProjection !== (["projected", "unchanged"].includes(receipt.outcome.status))
    || (hasProjection && (!DOCUMENT_PROJECTION_PATTERN.test(receipt.outcome.documentProjectionId || "") || !/^[a-f0-9]{64}$/.test(receipt.outcome.documentProjectionHash || "")))
    || hasCandidate !== (receipt.outcome.status === "blocked-edited-view")
    || (hasCandidate && (!CANDIDATE_SET_PATTERN.test(receipt.outcome.candidateSetId || "") || !/^[a-f0-9]{64}$/.test(receipt.outcome.candidateSetHash || "")))
    || (receipt.outcome.status === "manual-deferred" && receipt.policy?.mode !== "manual")
    || (["projected", "unchanged", "blocked-edited-view", "blocked-stale-edited-view", "blocked-unmanaged-view"].includes(receipt.outcome.status) && receipt.policy?.mode !== "automatic")
    || (receipt.outcome.status === "failed" && receipt.policy?.mode === "manual")) {
    fail("Post-refresh projection receipt outcome is inconsistent.", "INVALID_POST_REFRESH_PROJECTION_RECEIPT");
  }
  const payload = { ...receipt };
  delete payload.postRefreshProjectionReceiptId;
  delete payload.postRefreshProjectionReceiptHash;
  const expected = identity("post-refresh-projection-receipt", payload);
  if (receipt.postRefreshProjectionReceiptId !== expected.id || receipt.postRefreshProjectionReceiptHash !== expected.hash) {
    fail("Post-refresh projection receipt digest verification failed.", "POST_REFRESH_PROJECTION_RECEIPT_DIGEST_MISMATCH");
  }
  return receipt;
}

function buildReceiptPointer(receipt) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "PostRefreshProjectionPointer",
    projectId: receipt.projectId,
    postRefreshProjectionReceiptId: receipt.postRefreshProjectionReceiptId,
    refreshReceiptId: receipt.refresh.refreshReceiptId,
    policyId: receipt.policy?.policyId || null,
  };
  const pointerIdentity = identity("post-refresh-projection-pointer", payload);
  return { ...payload, pointerId: pointerIdentity.id, pointerHash: pointerIdentity.hash };
}

function verifyReceiptPointer(pointer, storage) {
  assertFields(pointer, ["schemaVersion", "kind", "projectId", "postRefreshProjectionReceiptId", "refreshReceiptId", "policyId", "pointerId", "pointerHash"], "Post-refresh projection pointer");
  if (pointer.schemaVersion !== SCHEMA_VERSION || pointer.kind !== "PostRefreshProjectionPointer"
    || !new RegExp(`^${formatForVerifiedOwner(storage).projectPrefix}[a-f0-9]{20}$`).test(pointer.projectId || "") || !RECEIPT_PATTERN.test(pointer.postRefreshProjectionReceiptId || "")
    || !REFRESH_RECEIPT_PATTERN.test(pointer.refreshReceiptId || "")
    || (pointer.policyId !== null && !POLICY_PATTERN.test(pointer.policyId || ""))
    || !/^post-refresh-projection-pointer-[a-f0-9]{24}$/.test(pointer.pointerId || "")
    || !/^[a-f0-9]{64}$/.test(pointer.pointerHash || "")) fail("Post-refresh projection pointer is invalid.", "INVALID_POST_REFRESH_PROJECTION_POINTER");
  const payload = { ...pointer };
  delete payload.pointerId;
  delete payload.pointerHash;
  const expected = identity("post-refresh-projection-pointer", payload);
  if (pointer.pointerId !== expected.id || pointer.pointerHash !== expected.hash) fail("Post-refresh projection pointer digest verification failed.", "POST_REFRESH_PROJECTION_POINTER_DIGEST_MISMATCH");
  return pointer;
}

export function completePostRefreshProjection({
  projectRoot,
  storage,
  projectId,
  beforeSnapshot,
  afterSnapshot,
  refreshRequest,
  refreshReceipt,
  preflight,
  documentProjectionAdapter = null,
} = {}) {
  let outcome;
  if (preflight.disposition !== "ready") {
    outcome = { status: preflight.disposition, reasonCode: preflight.reasonCode, documentProjectionId: null, documentProjectionHash: null };
  } else {
    try {
      const currentPolicy = loadEffectivePolicy({ projectRoot, projectId }, storage).policy;
      if (currentPolicy.policyId !== preflight.policy.policyId || currentPolicy.policyHash !== preflight.policy.policyHash) {
        fail("Post-refresh projection policy changed during refresh; document publication was skipped.", "POST_REFRESH_PROJECTION_POLICY_CHANGED");
      }
      const materialized = materializeMarkdownProjection({ projectRoot, storage, graph: afterSnapshot.temporalProvenanceGraph, adapter: documentProjectionAdapter });
      outcome = {
        status: materialized.status,
        reasonCode: materialized.status === "projected" ? "AUTOMATIC_MARKDOWN_PROJECTION_CREATED" : "AUTOMATIC_MARKDOWN_PROJECTION_UNCHANGED",
        documentProjectionId: materialized.projection.documentProjectionId,
        documentProjectionHash: materialized.projection.documentProjectionHash,
      };
    } catch (error) {
      outcome = { status: "failed", reasonCode: normalizedErrorCode(error), documentProjectionId: null, documentProjectionHash: null };
    }
  }
  const receipt = buildReceipt({ projectId, preflight, beforeSnapshot, afterSnapshot, refreshRequest, refreshReceipt, outcome }, storage);
  const stored = persistImmutable(receiptFile(projectRoot, receipt.postRefreshProjectionReceiptId, storage), receipt, verifyPostRefreshProjectionReceipt, "Post-refresh projection receipt", storage);
  const pointer = buildReceiptPointer(receipt);
  atomicWrite(receiptPointerFile(projectRoot, storage), json(pointer));
  const verifiedPointer = verifyReceiptPointer(readJson(receiptPointerFile(projectRoot, storage), "Post-refresh projection pointer"), storage);
  if (canonicalJson(verifiedPointer) !== canonicalJson(pointer)) fail("Post-refresh projection pointer changed during persistence.", "POST_REFRESH_PROJECTION_POINTER_WRITE_MISMATCH");
  return { status: receipt.outcome.status, receipt, receiptFile: stored.file, pointer, pointerFile: receiptPointerFile(projectRoot, storage) };
}

export function readPostRefreshProjectionReceipt({ root = ".", postRefreshProjectionReceiptId, documentProjectionAdapter = null } = {}) {
  const inspected = readyProject(root);
  const storage = inspected.storage;
  const projectRoot = inspected.project.projectRoot;
  const file = receiptFile(projectRoot, postRefreshProjectionReceiptId, storage);
  if (!fs.existsSync(file)) fail(`Post-refresh projection receipt is missing: ${postRefreshProjectionReceiptId}`, "POST_REFRESH_PROJECTION_RECEIPT_NOT_FOUND");
  const receipt = verifyPostRefreshProjectionReceipt(readJson(file, "Post-refresh projection receipt"), storage);
  if (receipt.projectId !== inspected.project.projectId) fail("Post-refresh projection receipt belongs to another project.", "POST_REFRESH_PROJECTION_PROJECT_MISMATCH");
  let policy = null;
  if (receipt.policy) {
    policy = receipt.policy.selection === "implicit-safe-default"
      ? buildPolicy({ projectId: receipt.projectId, mode: DEFAULT_POST_REFRESH_PROJECTION_MODE, selection: "implicit-safe-default" }, storage)
      : verifyPostRefreshProjectionPolicy(readJson(policyFile(projectRoot, receipt.policy.policyId, storage), "Post-refresh projection policy"), storage);
    if (policy.policyId !== receipt.policy.policyId || policy.policyHash !== receipt.policy.policyHash || policy.mode !== receipt.policy.mode) {
      fail("Post-refresh projection receipt policy binding is inconsistent.", "POST_REFRESH_PROJECTION_POLICY_RECEIPT_MISMATCH");
    }
  }
  let candidateSet = null;
  if (receipt.outcome.candidateSetId) {
    candidateSet = readDocumentChangeCandidateSet({ projectRoot, storage, id: receipt.outcome.candidateSetId }).candidateSet;
    if (candidateSet.candidateSetHash !== receipt.outcome.candidateSetHash) fail("Post-refresh projection receipt candidate binding is inconsistent.", "POST_REFRESH_PROJECTION_CANDIDATE_RECEIPT_MISMATCH");
  }
  let projection = null;
  if (receipt.outcome.documentProjectionId) {
    const adapter = createDocumentProjectionAdapter({ projectRoot, storage, adapter: documentProjectionAdapter });
    const entry = adapter.readProjection(receipt.outcome.documentProjectionId);
    if (!entry) fail("Post-refresh projection receipt references a missing DocumentProjection.", "POST_REFRESH_DOCUMENT_PROJECTION_NOT_FOUND");
    projection = verifyDocumentProjection(entry.document, null, storage);
    if (projection.documentProjectionHash !== receipt.outcome.documentProjectionHash || projection.graphSnapshotId !== receipt.target.graphSnapshotId) {
      fail("Post-refresh projection receipt DocumentProjection binding is inconsistent.", "POST_REFRESH_DOCUMENT_PROJECTION_RECEIPT_MISMATCH");
    }
  }
  return { status: "verified", file, receipt, policy, candidateSet, projection };
}

export function inspectPostRefreshProjection({ root = ".", documentProjectionAdapter = null } = {}) {
  const inspected = readyProject(root);
  const storage = inspected.storage;
  const projectRoot = inspected.project.projectRoot;
  let policy;
  try {
    policy = loadEffectivePolicy({ projectRoot, projectId: inspected.project.projectId }, storage);
  } catch (error) {
    policy = {
      status: "invalid",
      errorCode: normalizedErrorCode(error),
      authority: "invalid-operational-policy-has-no-project-authority",
    };
  }
  const file = receiptPointerFile(projectRoot, storage);
  if (!fs.existsSync(file)) return { status: "not-evaluated", policy };
  const pointer = verifyReceiptPointer(readJson(file, "Post-refresh projection pointer"), storage);
  if (pointer.projectId !== inspected.project.projectId) fail("Post-refresh projection pointer belongs to another project.", "POST_REFRESH_PROJECTION_PROJECT_MISMATCH");
  const receipt = readPostRefreshProjectionReceipt({ root: projectRoot, postRefreshProjectionReceiptId: pointer.postRefreshProjectionReceiptId, documentProjectionAdapter });
  if (receipt.receipt.refresh.refreshReceiptId !== pointer.refreshReceiptId || (receipt.receipt.policy?.policyId || null) !== pointer.policyId) {
    fail("Post-refresh projection pointer and receipt disagree.", "POST_REFRESH_PROJECTION_POINTER_MISMATCH");
  }
  return { status: receipt.receipt.outcome.status, policy, pointerFile: file, pointer, receipt: receipt.receipt };
}
