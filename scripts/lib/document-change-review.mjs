import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { familyFormatForOriginal, formatForVerifiedOwner, relativeProjectArtifact } from "./project-storage-format.mjs";
import { atomicWriteArtifact } from "./artifact-storage.mjs";
import { inspectProject, SCHEMA_VERSION } from "./lode-core.mjs";
import {
  createDocumentProjectionAdapter,
  materializeReviewedMarkdownProjection,
  resumeReviewedMarkdownProjection,
  inspectMarkdownProjection,
  readDocumentChangeCandidateSet,
  verifyDocumentChangeCandidateSet,
  verifyDocumentChangeCandidateSetAgainstPublished,
} from "./document-projection-adapter.mjs";
import { createGraphProjectionAdapter } from "./graph-projection-adapter.mjs";
import {
  normalizeProductModelDocument,
  productModelDocument,
  PRODUCT_MODEL_RELATIVE_PATH,
  readProductModelCanon,
} from "./product-model.mjs";
import { withRefreshWriterLease } from "./refresh-writer-lease.mjs";
import {
  buildWorldModel,
  deriveIncrementalRevisionParents,
  findWorldModelSnapshot,
  inspectWorldModel,
  readWorldModelSnapshot,
} from "./world-model.mjs";
import { createWorldModelStoreAdapter } from "./world-model-store.mjs";
import {
  artifactAuthorityBoundary,
  assertNoAuthorityAmplification,
  assertReceiptProjectedOnlyInChild,
  verifyArtifactAuthorityBoundary,
} from "./authority-plane-contract.mjs";

import { DOCUMENT_CHANGE_REVIEW_VERSION, documentChangeReviewCanonicalJson, verifyDocumentChangeProductModelRevision } from "./product-model-revision-verification.mjs";
export { DOCUMENT_CHANGE_REVIEW_VERSION, documentChangeReviewCanonicalJson, verifyDocumentChangeProductModelRevision };
export const DOCUMENT_CHANGE_REVIEW_DIRECTORY = ".head/document-changes/review-decisions";
export const DOCUMENT_CHANGE_PRODUCT_REVISION_DIRECTORY = ".head/document-changes/product-model-revisions";
export const DOCUMENT_CHANGE_APPLICATION_DIRECTORY = ".head/document-changes/applications";

const MAX_ARTIFACTS = 128;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const REVIEW_ID_PATTERN = /^document-change-review-decision-[a-f0-9]{24}$/;
const APPLICATION_ID_PATTERN = /^document-change-application-[a-f0-9]{24}$/;
const PRODUCT_MODEL_ID_PATTERN = /^product-model-[a-f0-9]{24}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

const fail = (message, code = "DOCUMENT_CHANGE_REVIEW_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};


function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is required.`, "INVALID_DOCUMENT_CHANGE_REVIEW");
  return value.trim();
}

function sortedUnique(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value)) {
    fail(`${label} must be an array of non-empty strings.`, "INVALID_DOCUMENT_CHANGE_REVIEW");
  }
  const normalized = [...new Set(values)].sort();
  if (documentChangeReviewCanonicalJson(normalized) !== documentChangeReviewCanonicalJson(values)) {
    fail(`${label} must be sorted and unique.`, "DOCUMENT_CHANGE_REVIEW_ORDER_MISMATCH");
  }
  return normalized;
}

const modelDocument = productModelDocument;

function readyProject(root, action) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") fail(`Project must be ready for ${action}.`, "PROJECT_NOT_READY");
  return inspected;
}

function assertAuthorityMutable(inspected) {
  if (inspected.state.activeRunId || inspected.state.pendingReview) {
    fail("Document-change review cannot change product authority while a Run is active or awaiting review.", "DOCUMENT_CHANGE_RUN_CONFLICT");
  }
}

function safeFile(projectRoot, relativeDirectory, id, pattern, code, storage) {
  if (!pattern.test(id || "")) fail("Document-change artifact id is invalid.", code);
  const root = path.resolve(projectRoot);
  const file = path.resolve(root, ...relativeProjectArtifact(storage, ...relativeDirectory.split("/").slice(1)).split("/"), `${id}.json`);
  const relative = path.relative(root, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("Document-change artifact path escapes the project root.", "DOCUMENT_CHANGE_PATH_ESCAPE");
  }
  let current = root;
  for (const segment of path.dirname(relative).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      fail("Document-change artifact path traverses a symlink.", "DOCUMENT_CHANGE_SYMLINK_PATH");
    }
  }
  return file;
}

function reviewFile(projectRoot, id, storage) {
  return safeFile(projectRoot, DOCUMENT_CHANGE_REVIEW_DIRECTORY, id, REVIEW_ID_PATTERN, "INVALID_DOCUMENT_CHANGE_REVIEW_ID", storage);
}

function applicationFile(projectRoot, id, storage) {
  return safeFile(projectRoot, DOCUMENT_CHANGE_APPLICATION_DIRECTORY, id, APPLICATION_ID_PATTERN, "INVALID_DOCUMENT_CHANGE_APPLICATION_ID", storage);
}

function revisionFile(projectRoot, id, storage) {
  return safeFile(projectRoot, DOCUMENT_CHANGE_PRODUCT_REVISION_DIRECTORY, id, PRODUCT_MODEL_ID_PATTERN, "INVALID_PRODUCT_MODEL_REVISION", storage);
}

function parseJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`${label} is invalid JSON: ${error.message}`, "INVALID_DOCUMENT_CHANGE_ARTIFACT_JSON"); }
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function atomicWrite(file, content) {
  atomicWriteArtifact(file, content);
}

function persistImmutable(file, document, verifier, label) {
  if (fs.existsSync(file)) {
    const existing = verifier(parseJson(file, label));
    if (documentChangeReviewCanonicalJson(existing) !== documentChangeReviewCanonicalJson(document)) {
      fail(`${label} conflicts with an existing immutable identity.`, "DOCUMENT_CHANGE_IMMUTABLE_COLLISION");
    }
    return { file, created: false, document: existing };
  }
  atomicWrite(file, json(document));
  return { file, created: true, document: verifier(parseJson(file, label)) };
}

function buildProductModelRevision({ projectId, model }, storage) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "ProductModelRevision",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-document-change-product-revision"), version: DOCUMENT_CHANGE_REVIEW_VERSION },
    projectId,
    authorityBoundary: artifactAuthorityBoundary("ProductModelRevision"),
    productModelId: model.productModelId,
    productModelHash: model.productModelHash,
    document: modelDocument(model),
    authority: "explicit-user-reviewed-product-canon-revision",
    instructionAuthority: true,
    promotionAuthority: true,
  };
  return { ...payload, revisionHash: digest(documentChangeReviewCanonicalJson(payload)) };
}


function buildReviewDecision({ candidateSet, disposition, acceptedCandidateIds, rejectedCandidateIds, rationale, candidateProductModel, reviewedProductModel, resultingProductModel }, storage) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "ReviewDecision",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-document-change-review"), version: DOCUMENT_CHANGE_REVIEW_VERSION },
    decisionScope: "document-to-product-canon",
    projectId: candidateSet.projectId,
    authorityBoundary: artifactAuthorityBoundary("ReviewDecision"),
    candidateSetId: candidateSet.candidateSetId,
    candidateSetHash: candidateSet.candidateSetHash,
    documentProjectionId: candidateSet.documentProjectionId,
    documentProjectionHash: candidateSet.documentProjectionHash,
    candidateGraphSnapshotId: candidateSet.graphSnapshotId,
    candidateGraphSnapshotHash: candidateSet.graphSnapshotHash,
    candidateSourceSnapshotId: candidateSet.sourceSnapshotId,
    candidateProductModelId: candidateProductModel.productModelId,
    candidateProductModelHash: candidateProductModel.productModelHash,
    reviewedProductModelId: reviewedProductModel.productModelId,
    reviewedProductModelHash: reviewedProductModel.productModelHash,
    disposition,
    acceptedCandidateIds,
    rejectedCandidateIds,
    rationale: requiredText(rationale, "Review rationale"),
    resultingProductModelId: resultingProductModel?.productModelId || null,
    resultingProductModelHash: resultingProductModel?.productModelHash || null,
    authority: "explicit-user-document-change-review",
    instructionAuthority: true,
    promotionAuthority: disposition.startsWith("accept"),
    lineage: [
      { relation: "reviews-candidate-set", targetId: candidateSet.candidateSetId },
      { relation: "reviews-document-projection", targetId: candidateSet.documentProjectionId },
      { relation: "reviews-product-model", targetId: reviewedProductModel.productModelId },
      ...(resultingProductModel ? [{ relation: "authorizes-product-model", targetId: resultingProductModel.productModelId }] : []),
    ],
  };
  const hash = digest(documentChangeReviewCanonicalJson(payload));
  return { ...payload, reviewDecisionId: `document-change-review-decision-${hash.slice(0, 24)}`, reviewDecisionHash: hash };
}

export function verifyDocumentChangeReviewDecision(document, candidateSet = null, projectId = "", storage = undefined) {
  if (!document || document.schemaVersion !== 1 || document.kind !== "ReviewDecision"
    || !familyFormatForOriginal("head-agent-core-document-change-review", document, storage ?? (candidateSet ? familyFormatForOriginal("head-agent-core-document-change-candidates", candidateSet) : undefined))
    || document.protocol?.version !== DOCUMENT_CHANGE_REVIEW_VERSION
    || document.decisionScope !== "document-to-product-canon"
    || (projectId && document.projectId !== projectId)
    || !REVIEW_ID_PATTERN.test(document.reviewDecisionId || "")
    || !HASH_PATTERN.test(document.reviewDecisionHash || "")
    || !["accept-all", "accept-selection", "reject"].includes(document.disposition)
    || document.authority !== "explicit-user-document-change-review"
    || document.instructionAuthority !== true
    || document.promotionAuthority !== document.disposition.startsWith("accept")
    || typeof document.rationale !== "string" || !document.rationale
    || !PRODUCT_MODEL_ID_PATTERN.test(document.candidateProductModelId || "")
    || !HASH_PATTERN.test(document.candidateProductModelHash || "")
    || !PRODUCT_MODEL_ID_PATTERN.test(document.reviewedProductModelId || "")
    || !HASH_PATTERN.test(document.reviewedProductModelHash || "")) {
    fail("Document-change ReviewDecision is invalid.", "INVALID_DOCUMENT_CHANGE_REVIEW");
  }
  if (document.authorityBoundary) verifyArtifactAuthorityBoundary("ReviewDecision", document.authorityBoundary);
  const payload = { ...document };
  delete payload.reviewDecisionId;
  delete payload.reviewDecisionHash;
  const hash = digest(documentChangeReviewCanonicalJson(payload));
  if (document.reviewDecisionHash !== hash || document.reviewDecisionId !== `document-change-review-decision-${hash.slice(0, 24)}`) {
    fail("Document-change ReviewDecision digest verification failed.", "DOCUMENT_CHANGE_REVIEW_DIGEST_MISMATCH");
  }
  sortedUnique(document.acceptedCandidateIds, "acceptedCandidateIds");
  sortedUnique(document.rejectedCandidateIds, "rejectedCandidateIds");
  if (candidateSet) {
    verifyDocumentChangeCandidateSet(candidateSet);
    if (document.projectId !== candidateSet.projectId || document.candidateSetId !== candidateSet.candidateSetId
      || document.candidateSetHash !== candidateSet.candidateSetHash
      || document.documentProjectionId !== candidateSet.documentProjectionId
      || document.documentProjectionHash !== candidateSet.documentProjectionHash
      || document.candidateGraphSnapshotId !== candidateSet.graphSnapshotId
      || document.candidateGraphSnapshotHash !== candidateSet.graphSnapshotHash
      || document.candidateSourceSnapshotId !== candidateSet.sourceSnapshotId) {
      fail("Document-change ReviewDecision scope does not match its candidate set.", "DOCUMENT_CHANGE_REVIEW_SCOPE_MISMATCH");
    }
    const known = candidateSet.candidates.map((candidate) => candidate.candidateId).sort();
    const partition = [...document.acceptedCandidateIds, ...document.rejectedCandidateIds].sort();
    if (new Set(partition).size !== partition.length || documentChangeReviewCanonicalJson(known) !== documentChangeReviewCanonicalJson(partition)) {
      fail("Document-change ReviewDecision candidate partition is invalid.", "DOCUMENT_CHANGE_REVIEW_SELECTION_MISMATCH");
    }
  }
  const accepting = document.disposition.startsWith("accept");
  if ((accepting && (!PRODUCT_MODEL_ID_PATTERN.test(document.resultingProductModelId || "") || !HASH_PATTERN.test(document.resultingProductModelHash || "")))
    || (!accepting && (document.resultingProductModelId !== null || document.resultingProductModelHash !== null))
    || (accepting && document.acceptedCandidateIds.length < 1)
    || (!accepting && document.acceptedCandidateIds.length !== 0)) {
    fail("Document-change ReviewDecision promotion fields are invalid.", "INVALID_DOCUMENT_CHANGE_REVIEW");
  }
  return document;
}

function buildApplicationReceipt({ review, candidateSet, beforeWorld, afterWorld, projection, canonChanged }, storage) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "DocumentCanonApplicationReceipt",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-document-change-application"), version: DOCUMENT_CHANGE_REVIEW_VERSION },
    projectId: review.projectId,
    reviewDecisionId: review.reviewDecisionId,
    reviewDecisionHash: review.reviewDecisionHash,
    candidateSetId: candidateSet.candidateSetId,
    candidateSetHash: candidateSet.candidateSetHash,
    disposition: review.disposition,
    previousProductModelId: review.reviewedProductModelId,
    previousProductModelHash: review.reviewedProductModelHash,
    resultingProductModelId: review.resultingProductModelId || review.reviewedProductModelId,
    resultingProductModelHash: review.resultingProductModelHash || review.reviewedProductModelHash,
    before: {
      worldModelId: beforeWorld.worldModelId,
      sourceSnapshotId: beforeWorld.temporalProvenanceGraph.sourceSnapshotId,
      graphSnapshotId: beforeWorld.temporalProvenanceGraph.graphSnapshotId,
      graphSnapshotHash: beforeWorld.temporalProvenanceGraph.graphSnapshotHash,
    },
    after: {
      worldModelId: afterWorld.worldModelId,
      sourceSnapshotId: afterWorld.temporalProvenanceGraph.sourceSnapshotId,
      graphSnapshotId: afterWorld.temporalProvenanceGraph.graphSnapshotId,
      graphSnapshotHash: afterWorld.temporalProvenanceGraph.graphSnapshotHash,
      documentProjectionId: projection.documentProjectionId,
      documentProjectionHash: projection.documentProjectionHash,
    },
    canonChanged,
    canonMutation: canonChanged ? "exact-user-reviewed-product-model" : "none",
    activeRunMutation: "none",
    authority: "application-evidence-not-independent-authority",
    authorityBoundary: artifactAuthorityBoundary("DocumentCanonApplicationReceipt"),
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const hash = digest(documentChangeReviewCanonicalJson(payload));
  return { ...payload, applicationReceiptId: `document-change-application-${hash.slice(0, 24)}`, applicationReceiptHash: hash };
}

export function verifyDocumentChangeApplicationReceipt(document, review = null, candidateSet = null, projectId = "", storage = undefined) {
  if (!document || document.schemaVersion !== 1 || document.kind !== "DocumentCanonApplicationReceipt"
    || !familyFormatForOriginal("head-agent-core-document-change-application", document, storage ?? (review ? familyFormatForOriginal("head-agent-core-document-change-review", review) : undefined))
    || document.protocol?.version !== DOCUMENT_CHANGE_REVIEW_VERSION
    || (projectId && document.projectId !== projectId)
    || !APPLICATION_ID_PATTERN.test(document.applicationReceiptId || "")
    || !HASH_PATTERN.test(document.applicationReceiptHash || "")
    || typeof document.canonChanged !== "boolean"
    || document.canonMutation !== (document.canonChanged ? "exact-user-reviewed-product-model" : "none")
    || document.activeRunMutation !== "none"
    || document.authority !== "application-evidence-not-independent-authority"
    || document.instructionAuthority !== false || document.promotionAuthority !== false) {
    fail("Document-change application receipt is invalid.", "INVALID_DOCUMENT_CHANGE_APPLICATION");
  }
  if (document.authorityBoundary) verifyArtifactAuthorityBoundary("DocumentCanonApplicationReceipt", document.authorityBoundary);
  for (const identity of [document.previousProductModelId, document.resultingProductModelId]) if (!PRODUCT_MODEL_ID_PATTERN.test(identity || "")) {
    fail("Document-change application Product Model identity is invalid.", "INVALID_DOCUMENT_CHANGE_APPLICATION");
  }
  for (const hash of [document.previousProductModelHash, document.resultingProductModelHash, document.before?.graphSnapshotHash, document.after?.graphSnapshotHash, document.after?.documentProjectionHash]) if (!HASH_PATTERN.test(hash || "")) {
    fail("Document-change application digest field is invalid.", "INVALID_DOCUMENT_CHANGE_APPLICATION");
  }
  for (const id of [document.before?.worldModelId, document.after?.worldModelId]) if (!/^world-model-[a-f0-9]{24}$/.test(id || "")) fail("Document-change application World Model identity is invalid.", "INVALID_DOCUMENT_CHANGE_APPLICATION");
  for (const id of [document.before?.sourceSnapshotId, document.after?.sourceSnapshotId]) if (!/^source-snapshot-[a-f0-9]{24}$/.test(id || "")) fail("Document-change application SourceSnapshot identity is invalid.", "INVALID_DOCUMENT_CHANGE_APPLICATION");
  for (const id of [document.before?.graphSnapshotId, document.after?.graphSnapshotId]) if (!/^graph-snapshot-[a-f0-9]{24}$/.test(id || "")) fail("Document-change application GraphSnapshot identity is invalid.", "INVALID_DOCUMENT_CHANGE_APPLICATION");
  if (!/^document-projection-[a-f0-9]{24}$/.test(document.after?.documentProjectionId || "")) fail("Document-change application DocumentProjection identity is invalid.", "INVALID_DOCUMENT_CHANGE_APPLICATION");
  const payload = { ...document };
  delete payload.applicationReceiptId;
  delete payload.applicationReceiptHash;
  const hash = digest(documentChangeReviewCanonicalJson(payload));
  if (document.applicationReceiptHash !== hash || document.applicationReceiptId !== `document-change-application-${hash.slice(0, 24)}`) {
    fail("Document-change application receipt digest verification failed.", "DOCUMENT_CHANGE_APPLICATION_DIGEST_MISMATCH");
  }
  if (review && (document.reviewDecisionId !== review.reviewDecisionId || document.reviewDecisionHash !== review.reviewDecisionHash
    || document.disposition !== review.disposition || document.previousProductModelId !== review.reviewedProductModelId
    || document.resultingProductModelId !== (review.resultingProductModelId || review.reviewedProductModelId))) {
    fail("Document-change application receipt does not match its ReviewDecision.", "DOCUMENT_CHANGE_APPLICATION_REVIEW_MISMATCH");
  }
  if (candidateSet && (document.candidateSetId !== candidateSet.candidateSetId || document.candidateSetHash !== candidateSet.candidateSetHash)) {
    fail("Document-change application receipt does not match its candidate set.", "DOCUMENT_CHANGE_APPLICATION_CANDIDATE_MISMATCH");
  }
  return document;
}

function artifactFiles(projectRoot, relativeDirectory, storage) {
  const directory = path.resolve(projectRoot, ...relativeProjectArtifact(storage, ...relativeDirectory.split("/").slice(1)).split("/"));
  if (!fs.existsSync(directory)) return [];
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name)).sort();
  if (files.length > MAX_ARTIFACTS) fail("Document-change artifact count exceeds its bound.", "DOCUMENT_CHANGE_ARTIFACT_LIMIT");
  for (const file of files) if (fs.statSync(file).size > MAX_ARTIFACT_BYTES) fail("Document-change artifact exceeds its byte bound.", "DOCUMENT_CHANGE_ARTIFACT_LIMIT");
  return files;
}

function reviewForCandidate(projectRoot, candidateSetId, storage) {
  let found = null;
  for (const file of artifactFiles(projectRoot, DOCUMENT_CHANGE_REVIEW_DIRECTORY, storage)) {
    const review = verifyDocumentChangeReviewDecision(parseJson(file, "Document-change ReviewDecision"), undefined, undefined, storage);
    if (path.basename(file) !== `${review.reviewDecisionId}.json`) fail("Document-change ReviewDecision file name does not match its identity.", "DOCUMENT_CHANGE_ARTIFACT_ID_MISMATCH");
    if (review.candidateSetId !== candidateSetId) continue;
    if (found && found.reviewDecisionId !== review.reviewDecisionId) fail("DocumentChangeCandidateSet has conflicting ReviewDecisions.", "DOCUMENT_CHANGE_REVIEW_CONFLICT");
    found = review;
  }
  return found;
}

function applicationForReview(projectRoot, reviewDecisionId, storage) {
  let found = null;
  for (const file of artifactFiles(projectRoot, DOCUMENT_CHANGE_APPLICATION_DIRECTORY, storage)) {
    const receipt = verifyDocumentChangeApplicationReceipt(parseJson(file, "Document-change application receipt"), undefined, undefined, undefined, storage);
    if (path.basename(file) !== `${receipt.applicationReceiptId}.json`) fail("Document-change application file name does not match its identity.", "DOCUMENT_CHANGE_ARTIFACT_ID_MISMATCH");
    if (receipt.reviewDecisionId !== reviewDecisionId) continue;
    if (found && found.applicationReceiptId !== receipt.applicationReceiptId) fail("Document-change ReviewDecision has conflicting application receipts.", "DOCUMENT_CHANGE_APPLICATION_CONFLICT");
    found = receipt;
  }
  return found;
}

export function readDocumentChangeReviewDecision({ root = ".", reviewDecisionId } = {}) {
  const inspected = readyProject(root, "document-change review inspection");
  const storage = inspected.storage;
  const file = reviewFile(inspected.project.projectRoot, reviewDecisionId, storage);
  if (!fs.existsSync(file)) fail(`Document-change ReviewDecision is missing: ${reviewDecisionId}`, "DOCUMENT_CHANGE_REVIEW_NOT_FOUND");
  const review = verifyDocumentChangeReviewDecision(parseJson(file, "Document-change ReviewDecision"), null, inspected.project.projectId, storage);
  if (review.reviewDecisionId !== reviewDecisionId) fail("Document-change ReviewDecision file does not contain the requested identity.", "DOCUMENT_CHANGE_ARTIFACT_ID_MISMATCH");
  const candidateSet = readDocumentChangeCandidateSet({ storage, projectRoot: inspected.project.projectRoot, id: review.candidateSetId }).candidateSet;
  verifyDocumentChangeReviewDecision(review, candidateSet, inspected.project.projectId, storage);
  let resultingProductModelRevision = null;
  if (review.resultingProductModelId) {
    const revision = revisionFile(inspected.project.projectRoot, review.resultingProductModelId, storage);
    if (!fs.existsSync(revision)) fail("Reviewed ProductModelRevision is missing.", "DOCUMENT_CHANGE_PRODUCT_REVISION_NOT_FOUND");
    resultingProductModelRevision = verifyDocumentChangeProductModelRevision(parseJson(revision, "Document-change ProductModelRevision"), inspected.project.projectId, storage);
    if (resultingProductModelRevision.productModelId !== review.resultingProductModelId
      || resultingProductModelRevision.productModelHash !== review.resultingProductModelHash) fail("ReviewDecision ProductModelRevision binding is inconsistent.", "DOCUMENT_CHANGE_PRODUCT_REVISION_MISMATCH");
  }
  return { status: "verified", file, reviewDecision: review, candidateSet, resultingProductModelRevision };
}

export function readDocumentChangeApplicationReceipt({ root = ".", applicationReceiptId } = {}) {
  const inspected = readyProject(root, "document-change application inspection");
  const storage = inspected.storage;
  const file = applicationFile(inspected.project.projectRoot, applicationReceiptId, storage);
  if (!fs.existsSync(file)) fail(`Document-change application receipt is missing: ${applicationReceiptId}`, "DOCUMENT_CHANGE_APPLICATION_NOT_FOUND");
  const receipt = verifyDocumentChangeApplicationReceipt(parseJson(file, "Document-change application receipt"), null, null, inspected.project.projectId, storage);
  if (receipt.applicationReceiptId !== applicationReceiptId) fail("Document-change application file does not contain the requested identity.", "DOCUMENT_CHANGE_ARTIFACT_ID_MISMATCH");
  const review = readDocumentChangeReviewDecision({ root: inspected.project.projectRoot, reviewDecisionId: receipt.reviewDecisionId });
  verifyDocumentChangeApplicationReceipt(receipt, review.reviewDecision, review.candidateSet, inspected.project.projectId, storage);
  return { status: "verified", file, applicationReceipt: receipt, reviewDecision: review.reviewDecision, candidateSet: review.candidateSet };
}

async function buildDocumentAuditChild({ projectRoot, beforeWorld, storeAdapter, graphProjectionAdapter, computeAdapter, writerLease }) {
  const common = {
    root: projectRoot,
    persist: false,
    storeAdapter,
    graphProjectionAdapter,
    computeAdapter,
    parentSourceSnapshotIds: beforeWorld.temporalProvenanceGraph.parentSourceSnapshotIds,
    revisionParentIds: beforeWorld.temporalProvenanceGraph.revisionParentIds,
  };
  const sameLineagePreview = await buildWorldModel(common);
  const revisionParentIds = deriveIncrementalRevisionParents({
    previousGraph: beforeWorld.temporalProvenanceGraph,
    candidateGraph: sameLineagePreview.snapshot.temporalProvenanceGraph,
  });
  const parentSourceSnapshotIds = [beforeWorld.temporalProvenanceGraph.sourceSnapshotId];
  const preview = await buildWorldModel({ ...common, parentSourceSnapshotIds, revisionParentIds });
  return buildWorldModel({
    ...common,
    persist: true,
    parentSourceSnapshotIds,
    revisionParentIds,
    expectedWorldModelId: preview.snapshot.worldModelId,
    expectedCurrentWorldModelId: beforeWorld.worldModelId,
    writerLease,
  });
}

async function applyReviewLocked({ inspected, reviewDecisionId, storeAdapter = null, graphProjectionAdapter = null, documentProjectionAdapter = null, computeAdapter = null, writerLease }) {
  const storage = inspected.storage;
  assertAuthorityMutable(inspected);
  const projectRoot = inspected.project.projectRoot;
  const reviewed = readDocumentChangeReviewDecision({ root: projectRoot, reviewDecisionId });
  const review = reviewed.reviewDecision;
  const candidateSet = reviewed.candidateSet;
  const existingApplication = applicationForReview(projectRoot, review.reviewDecisionId, storage);
  const currentCanon = readProductModelCanon({ storage, projectRoot });
  const canonBefore = currentCanon.model.productModelId === review.reviewedProductModelId && currentCanon.model.productModelHash === review.reviewedProductModelHash;
  const canonApplied = review.promotionAuthority && currentCanon.model.productModelId === review.resultingProductModelId && currentCanon.model.productModelHash === review.resultingProductModelHash;
  if (existingApplication) {
    verifyDocumentChangeApplicationReceipt(existingApplication, review, candidateSet, inspected.project.projectId, storage);
    if (currentCanon.model.productModelHash !== existingApplication.resultingProductModelHash) return { status: "already-applied", currentProjection: "later-canon-preserved", applicationReceipt: existingApplication, reviewDecision: review };
  }
  if (!canonBefore && !canonApplied) fail("Product Canon has a later value; preserve it.", "DOCUMENT_CHANGE_PRODUCT_CANON_DRIFT");
  // A durable reject leaves Canon unchanged. Canon equality cannot distinguish
  // not-started from partially published; the resume primitive checks every
  // file against the reviewed preimage and immutable target instead.
  const currentStatus = inspectWorldModel({ root: projectRoot, storeAdapter });
  const documentOnlyDriftKeys = new Set(["documentChangeProjectionChanged", "temporalProvenanceChanged"]);
  if (canonApplied) {
    // These derived inputs bind currentProductModelId and change with this exact
    // approved Canon. Rebuild from verified current records, never roll them back.
    for (const key of ["productModelChanged", "onboardingProjectionChanged", "productPolicyProjectionChanged", "featureMappingProjectionChanged"]) documentOnlyDriftKeys.add(key);
  }
  const nonDocumentDrift = Object.entries(currentStatus.changes || {}).some(([key, value]) => !documentOnlyDriftKeys.has(key)
    && (Array.isArray(value) ? value.length > 0 : value === true));
  if (currentStatus.status !== "current" && nonDocumentDrift) {
    fail("Repository World Model has non-document drift and must be refreshed before applying a document-change review.", "DOCUMENT_CHANGE_WORLD_MODEL_STALE");
  }
  const basisFile = safeFile(projectRoot, ".head/document-changes/application-bases", review.reviewDecisionId, REVIEW_ID_PATTERN, "INVALID_DOCUMENT_CHANGE_REVIEW_ID", storage);
  let beforeWorld;
  if (existingApplication) beforeWorld = readWorldModelSnapshot({ root: projectRoot, worldModelId: existingApplication.before.worldModelId, storeAdapter }).snapshot;
  else if (fs.existsSync(basisFile)) {
    const basis = parseJson(basisFile, "Document application basis");
    const { basisHash, ...payload } = basis;
    if (digest(documentChangeReviewCanonicalJson(payload)) !== basisHash || basis.kind !== "Evidence"
      || basis.purpose !== "document-application-basis" || basis.reviewDecisionHash !== review.reviewDecisionHash
      || basis.projectId !== review.projectId || basis.instructionAuthority !== false || basis.promotionAuthority !== false) {
      fail("Document application basis is invalid.", "DOCUMENT_CHANGE_APPLICATION_BASIS_INVALID");
    }
    verifyArtifactAuthorityBoundary("Evidence", basis.authorityBoundary);
    beforeWorld = readWorldModelSnapshot({ root: projectRoot, worldModelId: basis.beforeWorldModelId, storeAdapter }).snapshot;
  } else {
    // Older interrupted applications have no basis: use the exact reviewed
    // graph, not a made-up observation of the old process's current pointer.
    beforeWorld = canonApplied
      ? findWorldModelSnapshot({ root: projectRoot, graphSnapshotId: candidateSet.graphSnapshotId, storeAdapter }).matches.find((world) => world.temporalProvenanceGraph.graphSnapshotHash === candidateSet.graphSnapshotHash)
      : currentStatus.snapshot;
    if (!beforeWorld) fail("Reviewed World basis is missing.", "DOCUMENT_CHANGE_CANDIDATE_GRAPH_MISSING");
    const payload = { schemaVersion: 1, kind: "Evidence", purpose: "document-application-basis",
      projectId: review.projectId, reviewDecisionHash: review.reviewDecisionHash,
      beforeWorldModelId: beforeWorld.worldModelId, basisOrigin: canonApplied ? "reviewed-graph-reconstruction" : "observed-before-application",
      authorityBoundary: artifactAuthorityBoundary("Evidence"), instructionAuthority: false, promotionAuthority: false };
    persistImmutable(basisFile, { ...payload, basisHash: digest(documentChangeReviewCanonicalJson(payload)) }, (value) => value, "Document application basis");
  }
  if (beforeWorld.productModel.productModelHash !== review.reviewedProductModelHash) fail("Application basis does not bind the reviewed Canon.", "DOCUMENT_CHANGE_APPLICATION_BASIS_INVALID");
  if (documentChangeReviewCanonicalJson(beforeWorld.files.map(({ path, digest }) => ({ path, digest }))) !== documentChangeReviewCanonicalJson(currentStatus.snapshot.files.map(({ path, digest }) => ({ path, digest })))) {
    fail("Later repository changes require a separate projection reconciliation.", "DOCUMENT_CHANGE_WORLD_MODEL_STALE");
  }
  const selectedStore = createWorldModelStoreAdapter({ storage, projectRoot, adapter: storeAdapter });
  const selectedGraph = createGraphProjectionAdapter({ storage, projectRoot, adapter: graphProjectionAdapter });
  const selectedDocuments = createDocumentProjectionAdapter({ storage, projectRoot, adapter: documentProjectionAdapter });
  const canonFile = path.resolve(projectRoot, ...relativeProjectArtifact(storage, ...PRODUCT_MODEL_RELATIVE_PATH.split("/").slice(1)).split("/"));
  try {
    let afterWorld = existingApplication ? readWorldModelSnapshot({ root: projectRoot, worldModelId: existingApplication.after.worldModelId, storeAdapter }).snapshot : beforeWorld;
    if (review.promotionAuthority && !existingApplication) {
      assertNoAuthorityAmplification({
        sourceKind: "CandidateSet",
        targetKind: "ProductCanon",
        reviewDecision: review,
        effect: "apply-exact-user-reviewed-product-model",
      });
      const revision = reviewed.resultingProductModelRevision;
      if (!canonApplied) atomicWrite(canonFile, json(revision.document));
      const common = {
        root: projectRoot,
        persist: false,
        storeAdapter: selectedStore,
        graphProjectionAdapter: selectedGraph,
        computeAdapter,
        parentSourceSnapshotIds: beforeWorld.temporalProvenanceGraph.parentSourceSnapshotIds,
        revisionParentIds: beforeWorld.temporalProvenanceGraph.revisionParentIds,
      };
      const sameLineagePreview = await buildWorldModel(common);
      const revisionParentIds = deriveIncrementalRevisionParents({
        previousGraph: beforeWorld.temporalProvenanceGraph,
        candidateGraph: sameLineagePreview.snapshot.temporalProvenanceGraph,
      });
      const parentSourceSnapshotIds = [beforeWorld.temporalProvenanceGraph.sourceSnapshotId];
      const preview = await buildWorldModel({ ...common, parentSourceSnapshotIds, revisionParentIds });
      const rebuilt = await buildWorldModel({
        ...common,
        persist: true,
        parentSourceSnapshotIds,
        revisionParentIds,
        expectedWorldModelId: preview.snapshot.worldModelId,
        expectedCurrentWorldModelId: currentStatus.snapshot.worldModelId,
        writerLease,
      });
      afterWorld = rebuilt.snapshot;
      if (afterWorld.productModel.productModelId !== review.resultingProductModelId
        || afterWorld.productModel.productModelHash !== review.resultingProductModelHash
        || !afterWorld.temporalProvenanceGraph.parentSourceSnapshotIds.includes(beforeWorld.temporalProvenanceGraph.sourceSnapshotId)) {
        fail("Document review did not produce the expected Product Canon GraphSnapshot.", "DOCUMENT_CHANGE_GRAPH_VERIFICATION_FAILED");
      }
    }
    const materialized = existingApplication ? { projection: selectedDocuments.readProjection(existingApplication.after.documentProjectionId)?.document } : materializeReviewedMarkdownProjection({
      storage, projectRoot,
      graph: afterWorld.temporalProvenanceGraph,
      candidateSet,
      reviewDecision: review,
      adapter: selectedDocuments,
    });
    const receipt = existingApplication || verifyDocumentChangeApplicationReceipt(buildApplicationReceipt({
      review,
      candidateSet,
      beforeWorld,
      afterWorld,
      projection: materialized.projection,
      canonChanged: review.promotionAuthority,
    }, storage), review, candidateSet, inspected.project.projectId, storage);
    const persistedReceipt = persistImmutable(applicationFile(projectRoot, receipt.applicationReceiptId, storage), receipt, (value) => verifyDocumentChangeApplicationReceipt(value, review, candidateSet, inspected.project.projectId, storage), "Document-change application receipt");
    const auditCurrent = inspectWorldModel({ root: projectRoot, storeAdapter: selectedStore });
    const audit = auditCurrent.snapshot.temporalProvenanceGraph.documentChangeProjection.applicationReceiptIds.includes(receipt.applicationReceiptId)
      && auditCurrent.snapshot.temporalProvenanceGraph.parentSourceSnapshotIds.includes(afterWorld.temporalProvenanceGraph.sourceSnapshotId)
      ? { snapshot: auditCurrent.snapshot } : await buildDocumentAuditChild({
      projectRoot,
      beforeWorld: afterWorld,
      storeAdapter: selectedStore,
      graphProjectionAdapter: selectedGraph,
      computeAdapter,
      writerLease,
    });
    assertReceiptProjectedOnlyInChild({
      receiptId: receipt.applicationReceiptId,
      namedGraphSnapshotId: receipt.after.graphSnapshotId,
      namedGraphReceiptIds: afterWorld.temporalProvenanceGraph.documentChangeProjection.applicationReceiptIds,
      namedSourceSnapshotId: afterWorld.temporalProvenanceGraph.sourceSnapshotId,
      childGraphSnapshotId: audit.snapshot.temporalProvenanceGraph.graphSnapshotId,
      childParentSourceSnapshotIds: audit.snapshot.temporalProvenanceGraph.parentSourceSnapshotIds,
      childGraphReceiptIds: audit.snapshot.temporalProvenanceGraph.documentChangeProjection.applicationReceiptIds,
    });
    const auditProjection = resumeReviewedMarkdownProjection({ storage, projectRoot, graph: audit.snapshot.temporalProvenanceGraph, adapter: selectedDocuments,
      baseProjectionId: receipt.after.documentProjectionId });
    const verifiedWorld = inspectWorldModel({ root: projectRoot, storeAdapter: selectedStore });
    if (verifiedWorld.status !== "current" || verifiedWorld.snapshot.worldModelId !== audit.snapshot.worldModelId) {
      fail("Applied document review did not leave a current verified World Model.", "DOCUMENT_CHANGE_APPLICATION_WORLD_MISMATCH");
    }
    return {
      status: existingApplication ? "already-applied" : review.promotionAuthority ? "applied" : "rejected-and-reconciled",
      reviewDecision: review,
      applicationReceipt: persistedReceipt.document,
      worldModel: afterWorld,
      auditWorldModel: audit.snapshot,
      documentProjection: auditProjection.projection,
    };
  } catch (error) {
    // Durable approval and any confirmed Canon effect survive a projection
    // failure. Never erase receipts or roll later pointers/user edits backward.
    error.projectionPending = true;
    throw error;
  }
}

export async function applyDocumentChangeReview({ root = ".", reviewDecisionId, storeAdapter = null, graphProjectionAdapter = null, documentProjectionAdapter = null, computeAdapter = null } = {}) {
  const inspected = readyProject(root, "document-change review application");
  const storage = inspected.storage;
  return withRefreshWriterLease({
    storage, projectRoot: inspected.project.projectRoot,
    projectId: inspected.project.projectId,
  }, (writerLease) => applyReviewLocked({ inspected, reviewDecisionId: requiredText(reviewDecisionId, "reviewDecisionId"), storeAdapter, graphProjectionAdapter, documentProjectionAdapter, computeAdapter, writerLease }));
}

export async function reviewDocumentChanges({
  root = ".",
  candidateSetId,
  disposition,
  acceptedCandidateIds = [],
  resultingProductModel = null,
  rationale,
  apply = true,
  storeAdapter = null,
  graphProjectionAdapter = null,
  documentProjectionAdapter = null,
  computeAdapter = null,
} = {}) {
  const inspected = readyProject(root, "document-change review");
  const storage = inspected.storage;
  return withRefreshWriterLease({
    storage, projectRoot: inspected.project.projectRoot,
    projectId: inspected.project.projectId,
  }, async (writerLease) => {
    assertAuthorityMutable(inspected);
    if (typeof apply !== "boolean") fail("apply must be a boolean.", "INVALID_DOCUMENT_CHANGE_REVIEW");
    const projectRoot = inspected.project.projectRoot;
    const candidateSet = readDocumentChangeCandidateSet({ storage, projectRoot, id: requiredText(candidateSetId, "candidateSetId") }).candidateSet;
    const normalizedDisposition = requiredText(disposition, "Review disposition").toLowerCase();
    if (!["accept-all", "accept-selection", "reject"].includes(normalizedDisposition)) fail("Document-change review disposition is invalid.", "INVALID_DOCUMENT_CHANGE_REVIEW_DISPOSITION");
    const historical = findWorldModelSnapshot({ root: projectRoot, graphSnapshotId: candidateSet.graphSnapshotId, storeAdapter });
    const candidateWorld = historical.matches.find((snapshot) => snapshot.temporalProvenanceGraph.graphSnapshotHash === candidateSet.graphSnapshotHash
      && snapshot.temporalProvenanceGraph.sourceSnapshotId === candidateSet.sourceSnapshotId);
    if (!candidateWorld) fail("DocumentChangeCandidateSet base GraphSnapshot is unavailable or divergent.", "DOCUMENT_CHANGE_CANDIDATE_GRAPH_MISSING");
    const currentCanon = readProductModelCanon({ storage, projectRoot });
    const allCandidateIds = candidateSet.candidates.map((candidate) => candidate.candidateId).sort();
    let accepted = [];
    if (normalizedDisposition === "accept-all") {
      if (acceptedCandidateIds.length) fail("accept-all cannot specify acceptedCandidateIds.", "INVALID_DOCUMENT_CHANGE_REVIEW_SELECTION");
      accepted = allCandidateIds;
    } else if (normalizedDisposition === "accept-selection") {
      accepted = [...new Set(acceptedCandidateIds)].sort();
      if (!accepted.length || accepted.length !== acceptedCandidateIds.length || accepted.some((id) => !allCandidateIds.includes(id))) {
        fail("accept-selection requires a non-empty unique subset of candidate ids.", "INVALID_DOCUMENT_CHANGE_REVIEW_SELECTION");
      }
    } else if (acceptedCandidateIds.length || resultingProductModel !== null) {
      fail("reject cannot include accepted candidates or a resulting Product Model.", "INVALID_DOCUMENT_CHANGE_REVIEW_SELECTION");
    }
    const rejected = allCandidateIds.filter((id) => !accepted.includes(id));
    const priorReview = reviewForCandidate(projectRoot, candidateSet.candidateSetId, storage);
    if (priorReview) {
      verifyDocumentChangeReviewDecision(priorReview, candidateSet, inspected.project.projectId, storage);
      const proposedHash = resultingProductModel ? normalizeProductModelDocument(resultingProductModel, storage).productModelHash : null;
      if (priorReview.disposition !== normalizedDisposition || priorReview.rationale !== rationale
        || documentChangeReviewCanonicalJson(priorReview.acceptedCandidateIds) !== documentChangeReviewCanonicalJson(accepted)
        || priorReview.resultingProductModelHash !== proposedHash) {
        fail("Document candidate already has a different explicit decision.", "DOCUMENT_CHANGE_ALREADY_REVIEWED");
      }
      return apply ? applyReviewLocked({ inspected, reviewDecisionId: priorReview.reviewDecisionId, storeAdapter, graphProjectionAdapter, documentProjectionAdapter, computeAdapter, writerLease })
        : { status: "reviewed-awaiting-application", reviewDecision: priorReview };
    }
    verifyDocumentChangeCandidateSetAgainstPublished({ storage, projectRoot, candidateSet, adapter: documentProjectionAdapter });
    let nextModel = null;
    if (normalizedDisposition.startsWith("accept")) {
      if (currentCanon.model.productModelId !== candidateWorld.productModel.productModelId
        || currentCanon.model.productModelHash !== candidateWorld.productModel.productModelHash) {
        fail("Product Canon changed after the candidate document projection; capture and review a new candidate set.", "DOCUMENT_CHANGE_PRODUCT_CANON_DRIFT");
      }
      if (!resultingProductModel) fail("Accepted document changes require an explicit complete resultingProductModel.", "DOCUMENT_CHANGE_PRODUCT_MODEL_REQUIRED");
      nextModel = normalizeProductModelDocument(resultingProductModel, storage);
      if (nextModel.productModelId === currentCanon.model.productModelId) {
        fail("Accepted document changes must produce a different explicit Product Model; reject the candidates to discard them.", "DOCUMENT_CHANGE_CANON_CHANGE_REQUIRED");
      }
    }
    const review = verifyDocumentChangeReviewDecision(buildReviewDecision({
      candidateSet,
      disposition: normalizedDisposition,
      acceptedCandidateIds: accepted,
      rejectedCandidateIds: rejected,
      rationale,
      candidateProductModel: candidateWorld.productModel,
      reviewedProductModel: currentCanon.model,
      resultingProductModel: nextModel,
    }, storage), candidateSet, inspected.project.projectId, storage);
    const existing = reviewForCandidate(projectRoot, candidateSet.candidateSetId, storage);
    if (existing && existing.reviewDecisionId !== review.reviewDecisionId) fail("DocumentChangeCandidateSet already has a different ReviewDecision.", "DOCUMENT_CHANGE_ALREADY_REVIEWED");
    let productRevision = null;
    if (nextModel) {
      productRevision = verifyDocumentChangeProductModelRevision(buildProductModelRevision({ projectId: inspected.project.projectId, model: nextModel }, storage), inspected.project.projectId, storage);
      persistImmutable(revisionFile(projectRoot, productRevision.productModelId, storage), productRevision, (value) => verifyDocumentChangeProductModelRevision(value, inspected.project.projectId, storage), "Document-change ProductModelRevision");
    }
    persistImmutable(reviewFile(projectRoot, review.reviewDecisionId, storage), review, (value) => verifyDocumentChangeReviewDecision(value, candidateSet, inspected.project.projectId, storage), "Document-change ReviewDecision");
    if (!apply) return { status: "reviewed-awaiting-application", reviewDecision: review, productModelRevision: productRevision };
    return applyReviewLocked({ inspected, reviewDecisionId: review.reviewDecisionId, storeAdapter, graphProjectionAdapter, documentProjectionAdapter, computeAdapter, writerLease });
  });
}

export function inspectDocumentChangeReviewStatus({ root = ".", candidateSetId } = {}) {
  const inspected = readyProject(root, "document-change review status");
  const storage = inspected.storage;
  const candidateSet = readDocumentChangeCandidateSet({ storage, projectRoot: inspected.project.projectRoot, id: requiredText(candidateSetId, "candidateSetId") }).candidateSet;
  const review = reviewForCandidate(inspected.project.projectRoot, candidateSet.candidateSetId, storage);
  if (!review) return { status: "awaiting-review", candidateSetId: candidateSet.candidateSetId, candidateCount: candidateSet.candidates.length };
  verifyDocumentChangeReviewDecision(review, candidateSet, inspected.project.projectId, storage);
  const application = applicationForReview(inspected.project.projectRoot, review.reviewDecisionId, storage);
  if (application) verifyDocumentChangeApplicationReceipt(application, review, candidateSet, inspected.project.projectId, storage);
  const canon = readProductModelCanon({ storage, projectRoot: inspected.project.projectRoot });
  const canonApplied = canon.model.productModelHash === (review.resultingProductModelHash || review.reviewedProductModelHash);
  let projectionsReady = false;
  let projectionReasonCode = null;
  if (application && canonApplied) {
    try {
      const world = inspectWorldModel({ root: inspected.project.projectRoot });
      projectionsReady = world.status === "current"
        && world.snapshot.temporalProvenanceGraph.documentChangeProjection.applicationReceiptIds.includes(application.applicationReceiptId)
        && inspectMarkdownProjection({ storage, projectRoot: inspected.project.projectRoot, graph: world.snapshot.temporalProvenanceGraph }).status === "current";
    } catch (error) { projectionReasonCode = error.code || "DOCUMENT_CHANGE_PROJECTION_UNVERIFIABLE"; }
  }
  return {
    status: application && (!canonApplied || projectionsReady) ? (application.canonChanged ? "applied" : "rejected-and-reconciled")
      : canonApplied ? "canon-applied-projection-pending" : "reviewed-awaiting-application",
    canonApplied, projectionsReady, projectionReasonCode,
    candidateSetId: candidateSet.candidateSetId,
    reviewDecisionId: review.reviewDecisionId,
    applicationReceiptId: application?.applicationReceiptId || null,
    disposition: review.disposition,
    reviewedProductModelId: review.reviewedProductModelId,
    resultingProductModelId: review.resultingProductModelId,
    currentProductModelId: canon.model.productModelId,
    authority: "status-only",
    instructionAuthority: false,
    promotionAuthority: false,
  };
}
