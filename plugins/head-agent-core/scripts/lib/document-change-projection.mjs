import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { familyFormatForOriginal, formatForVerifiedOwner, relativeProjectArtifact } from "./project-storage-format.mjs";
import { normalizeProductModelDocument } from "./product-model.mjs";

export const DOCUMENT_CHANGE_GRAPH_PROJECTION_VERSION = "0.1.0";

const DIRECTORIES = Object.freeze({
  candidateSets: ".head/document-changes/candidate-sets",
  reviewDecisions: ".head/document-changes/review-decisions",
  productModelRevisions: ".head/document-changes/product-model-revisions",
  applicationReceipts: ".head/document-changes/applications",
});
const LIMITS = Object.freeze({ maxArtifactsPerKind: 128, maxArtifactBytes: 8 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024 });
const PATTERNS = Object.freeze({
  candidateSets: /^document-change-candidate-set-[a-f0-9]{24}$/,
  reviewDecisions: /^document-change-review-decision-[a-f0-9]{24}$/,
  productModelRevisions: /^product-model-[a-f0-9]{24}$/,
  applicationReceipts: /^document-change-application-[a-f0-9]{24}$/,
});
const ID_FIELDS = Object.freeze({
  candidateSets: "candidateSetId",
  reviewDecisions: "reviewDecisionId",
  productModelRevisions: "productModelId",
  applicationReceipts: "applicationReceiptId",
});
const HASH_FIELDS = Object.freeze({
  candidateSets: "candidateSetHash",
  reviewDecisions: "reviewDecisionHash",
  productModelRevisions: "revisionHash",
  applicationReceipts: "applicationReceiptHash",
});

const fail = (message, code = "DOCUMENT_CHANGE_PROJECTION_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

const canonicalJson = (value) => JSON.stringify(canonical(value));

function safeRelativeMarkdownPath(value) {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\\") || !value.endsWith(".md")) {
    fail("Document-change candidate path is invalid.", "INVALID_DOCUMENT_CHANGE_PROJECTION_CANDIDATE");
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === ".." || normalized.startsWith("../")) fail("Document-change candidate path escapes its projection.", "INVALID_DOCUMENT_CHANGE_PROJECTION_CANDIDATE");
}

function safeDirectory(projectRoot, relativeDirectory) {
  const root = path.resolve(projectRoot);
  const directory = path.resolve(root, ...relativeDirectory.split("/"));
  const relative = path.relative(root, directory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("Document-change projection path escapes the project root.", "DOCUMENT_CHANGE_PROJECTION_PATH_ESCAPE");
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail("Document-change projection path traverses a symlink.", "DOCUMENT_CHANGE_PROJECTION_SYMLINK");
  }
  return directory;
}

function verifyContentIdentity(document, kind) {
  const idField = ID_FIELDS[kind];
  const hashField = HASH_FIELDS[kind];
  const payload = { ...document };
  if (kind !== "productModelRevisions") delete payload[idField];
  delete payload[hashField];
  const hash = digest(canonicalJson(payload));
  if (document[hashField] !== hash || !PATTERNS[kind].test(document[idField] || "")) fail(`Document-change ${kind} digest or identity is invalid.`, "DOCUMENT_CHANGE_PROJECTION_DIGEST_MISMATCH");
  if (kind !== "productModelRevisions") {
    const prefixes = {
      candidateSets: "document-change-candidate-set",
      reviewDecisions: "document-change-review-decision",
      applicationReceipts: "document-change-application",
    };
    if (document[idField] !== `${prefixes[kind]}-${hash.slice(0, 24)}`) fail(`Document-change ${kind} content identity is invalid.`, "DOCUMENT_CHANGE_PROJECTION_DIGEST_MISMATCH");
  }
  return document;
}

function verifyCandidateSet(document, projectId, storage) {
  verifyContentIdentity(document, "candidateSets");
  if (document.kind !== "DocumentChangeCandidateSet" || document.schemaVersion !== 1
    || !familyFormatForOriginal("head-agent-core-document-change-candidates", document, storage) || document.protocol?.version !== "0.1.0"
    || document.projectId !== projectId || document.authority !== "unreviewed-candidate"
    || document.instructionAuthority !== false || document.promotionAuthority !== false || document.requiresReviewDecision !== true
    || !/^document-projection-[a-f0-9]{24}$/.test(document.documentProjectionId || "") || !/^[a-f0-9]{64}$/.test(document.documentProjectionHash || "")
    || !/^graph-snapshot-[a-f0-9]{24}$/.test(document.graphSnapshotId || "") || !/^[a-f0-9]{64}$/.test(document.graphSnapshotHash || "")
    || !/^source-snapshot-[a-f0-9]{24}$/.test(document.sourceSnapshotId || "")
    || !Array.isArray(document.candidates) || document.candidates.length < 1) fail("DocumentChangeCandidateSet fields or authority are invalid.", "INVALID_DOCUMENT_CHANGE_PROJECTION_CANDIDATE_SET");
  const ids = new Set();
  let previousPath = "";
  for (const candidate of document.candidates) {
    safeRelativeMarkdownPath(candidate.relativePath);
    const payload = { ...candidate };
    delete payload.candidateId;
    const hash = digest(canonicalJson(payload));
    if (candidate.kind !== "DocumentChangeCandidate" || candidate.schemaVersion !== 1
      || candidate.candidateId !== `document-change-candidate-${hash.slice(0, 24)}` || ids.has(candidate.candidateId)
      || candidate.documentProjectionId !== document.documentProjectionId || candidate.graphSnapshotId !== document.graphSnapshotId
      || !["added", "modified", "removed"].includes(candidate.changeType)
      || previousPath && previousPath.localeCompare(candidate.relativePath) >= 0
      || candidate.authority !== "unreviewed-candidate" || candidate.instructionAuthority !== false || candidate.promotionAuthority !== false
      || (candidate.baseContentHash !== null && !/^[a-f0-9]{64}$/.test(candidate.baseContentHash || ""))
      || (candidate.proposedContentHash !== null && !/^[a-f0-9]{64}$/.test(candidate.proposedContentHash || ""))
      || (candidate.baseContent !== null && (typeof candidate.baseContent !== "string" || Buffer.byteLength(candidate.baseContent, "utf8") > 1024 * 1024 || digest(candidate.baseContent) !== candidate.baseContentHash))
      || (candidate.proposedContent !== null && (typeof candidate.proposedContent !== "string" || Buffer.byteLength(candidate.proposedContent, "utf8") > 1024 * 1024 || digest(candidate.proposedContent) !== candidate.proposedContentHash))
      || (candidate.changeType === "added" && (candidate.baseContent !== null || candidate.proposedContent === null))
      || (candidate.changeType === "removed" && (candidate.proposedContent !== null || candidate.baseContent === null))
      || (candidate.changeType === "modified" && (candidate.baseContent === null || candidate.proposedContent === null))) {
      fail("DocumentChangeCandidate fields or identity are invalid.", "INVALID_DOCUMENT_CHANGE_PROJECTION_CANDIDATE");
    }
    ids.add(candidate.candidateId);
    previousPath = candidate.relativePath;
  }
  return document;
}

function verifyReview(document, projectId, storage) {
  verifyContentIdentity(document, "reviewDecisions");
  if (document.kind !== "ReviewDecision" || document.schemaVersion !== 1
    || !familyFormatForOriginal("head-agent-core-document-change-review", document, storage) || document.protocol?.version !== "0.1.0"
    || document.decisionScope !== "document-to-product-canon" || document.projectId !== projectId
    || document.authority !== "explicit-user-document-change-review" || document.instructionAuthority !== true
    || !["accept-all", "accept-selection", "reject"].includes(document.disposition)
    || document.promotionAuthority !== document.disposition.startsWith("accept")
    || !Array.isArray(document.acceptedCandidateIds) || !Array.isArray(document.rejectedCandidateIds)) {
    fail("Document-change ReviewDecision fields or authority are invalid.", "INVALID_DOCUMENT_CHANGE_PROJECTION_REVIEW");
  }
  return document;
}

function verifyProductRevision(document, projectId, storage) {
  verifyContentIdentity(document, "productModelRevisions");
  if (document.kind !== "ProductModelRevision" || document.schemaVersion !== 1 || document.projectId !== projectId
    || !familyFormatForOriginal("head-agent-core-document-change-product-revision", document, storage) || document.protocol?.version !== "0.1.0"
    || document.authority !== "explicit-user-reviewed-product-canon-revision" || document.instructionAuthority !== true || document.promotionAuthority !== true) {
    fail("Document-change ProductModelRevision fields or authority are invalid.", "INVALID_DOCUMENT_CHANGE_PROJECTION_PRODUCT_REVISION");
  }
  const model = normalizeProductModelDocument(document.document, familyFormatForOriginal("head-agent-core-document-change-product-revision", document, storage));
  if (model.productModelId !== document.productModelId || model.productModelHash !== document.productModelHash) fail("Document-change ProductModelRevision does not match its Product Model.", "INVALID_DOCUMENT_CHANGE_PROJECTION_PRODUCT_REVISION");
  return document;
}

function verifyApplication(document, projectId, storage) {
  verifyContentIdentity(document, "applicationReceipts");
  if (document.kind !== "DocumentCanonApplicationReceipt" || document.schemaVersion !== 1
    || !familyFormatForOriginal("head-agent-core-document-change-application", document, storage) || document.protocol?.version !== "0.1.0"
    || document.projectId !== projectId || document.authority !== "application-evidence-not-independent-authority"
    || document.instructionAuthority !== false || document.promotionAuthority !== false
    || !/^world-model-[a-f0-9]{24}$/.test(document.before?.worldModelId || "") || !/^world-model-[a-f0-9]{24}$/.test(document.after?.worldModelId || "")
    || !/^graph-snapshot-[a-f0-9]{24}$/.test(document.before?.graphSnapshotId || "") || !/^graph-snapshot-[a-f0-9]{24}$/.test(document.after?.graphSnapshotId || "")
    || !/^document-projection-[a-f0-9]{24}$/.test(document.after?.documentProjectionId || "")) {
    fail("Document-change application receipt fields or authority are invalid.", "INVALID_DOCUMENT_CHANGE_PROJECTION_APPLICATION");
  }
  return document;
}

function readKind(projectRoot, projectId, kind, verify, storage) {
  const directory = safeDirectory(projectRoot, relativeProjectArtifact(storage, ...DIRECTORIES[kind].split("/").slice(1)));
  if (!fs.existsSync(directory)) return { documents: [], totalBytes: 0 };
  if (!fs.statSync(directory).isDirectory()) fail("Document-change projection source is not a directory.", "INVALID_DOCUMENT_CHANGE_PROJECTION_PATH");
  const entries = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length > LIMITS.maxArtifactsPerKind) fail("Document-change projection artifact count exceeds its bound.", "DOCUMENT_CHANGE_PROJECTION_LIMIT");
  let totalBytes = 0;
  const documents = entries.map((entry) => {
    if (entry.isSymbolicLink() || !entry.isFile()) fail("Document-change projection contains a non-file artifact.", "DOCUMENT_CHANGE_PROJECTION_SYMLINK");
    const id = entry.name.slice(0, -5);
    if (!PATTERNS[kind].test(id)) fail(`Document-change projection filename is invalid: ${entry.name}`, "INVALID_DOCUMENT_CHANGE_PROJECTION_PATH");
    const file = path.join(directory, entry.name);
    const size = fs.statSync(file).size;
    totalBytes += size;
    if (size > LIMITS.maxArtifactBytes || totalBytes > LIMITS.maxTotalBytes) fail("Document-change projection byte bound exceeded.", "DOCUMENT_CHANGE_PROJECTION_LIMIT");
    let document;
    try { document = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { fail(`Document-change projection JSON is invalid: ${error.message}`, "INVALID_DOCUMENT_CHANGE_PROJECTION_JSON"); }
    if (document[ID_FIELDS[kind]] !== id) fail("Document-change projection filename does not match its identity.", "DOCUMENT_CHANGE_PROJECTION_IDENTITY_MISMATCH");
    return verify(document, projectId, storage);
  });
  return { documents, totalBytes };
}

export function verifyDocumentChangeProjectionInput(input, storage = undefined) {
  if (!input || input.kind !== "DocumentChangeGraphProjectionInput" || !familyFormatForOriginal("head-agent-core-document-change-graph-projection", input, storage)
    || input.protocol?.version !== DOCUMENT_CHANGE_GRAPH_PROJECTION_VERSION || typeof input.projectId !== "string" || !input.projectId
    || input.authority !== "derived-projection-input-not-document-authority" || input.instructionAuthority !== false || input.promotionAuthority !== false) {
    fail("Document-change graph projection input is invalid.", "INVALID_DOCUMENT_CHANGE_PROJECTION_INPUT");
  }
  const payload = { ...input };
  delete payload.projectionInputId;
  delete payload.projectionInputHash;
  const hash = digest(canonicalJson(payload));
  if (input.projectionInputHash !== hash || input.projectionInputId !== `document-change-projection-${hash.slice(0, 24)}`) fail("Document-change graph projection input digest verification failed.", "DOCUMENT_CHANGE_PROJECTION_INPUT_DIGEST_MISMATCH");
  return input;
}

export function loadDocumentChangeProjection({ projectRoot, projectId, storage } = {}) {
  const candidateSets = readKind(projectRoot, projectId, "candidateSets", verifyCandidateSet, storage);
  const reviewDecisions = readKind(projectRoot, projectId, "reviewDecisions", verifyReview, storage);
  const productModelRevisions = readKind(projectRoot, projectId, "productModelRevisions", verifyProductRevision, storage);
  const applicationReceipts = readKind(projectRoot, projectId, "applicationReceipts", verifyApplication, storage);
  const candidatesBySet = new Map(candidateSets.documents.map((item) => [item.candidateSetId, item]));
  const reviewsById = new Map(reviewDecisions.documents.map((item) => [item.reviewDecisionId, item]));
  const revisionsByModelId = new Map(productModelRevisions.documents.map((item) => [item.productModelId, item]));
  for (const review of reviewDecisions.documents) {
    const set = candidatesBySet.get(review.candidateSetId);
    if (!set || set.candidateSetHash !== review.candidateSetHash) fail("Document-change ReviewDecision references a missing or mismatched candidate set.", "DOCUMENT_CHANGE_PROJECTION_DANGLING_REVIEW");
    if (review.documentProjectionId !== set.documentProjectionId || review.documentProjectionHash !== set.documentProjectionHash
      || review.candidateGraphSnapshotId !== set.graphSnapshotId || review.candidateGraphSnapshotHash !== set.graphSnapshotHash
      || review.candidateSourceSnapshotId !== set.sourceSnapshotId) fail("Document-change ReviewDecision scope does not match its candidate set.", "DOCUMENT_CHANGE_PROJECTION_REVIEW_SCOPE_MISMATCH");
    const known = set.candidates.map((candidate) => candidate.candidateId).sort();
    const partition = [...review.acceptedCandidateIds, ...review.rejectedCandidateIds].sort();
    if (new Set(partition).size !== partition.length || canonicalJson(known) !== canonicalJson(partition)) fail("Document-change ReviewDecision candidate partition is invalid.", "DOCUMENT_CHANGE_PROJECTION_REVIEW_SELECTION_MISMATCH");
    if (review.promotionAuthority) {
      const revision = revisionsByModelId.get(review.resultingProductModelId);
      if (!revision || revision.productModelHash !== review.resultingProductModelHash) fail("Document-change ReviewDecision references a missing ProductModelRevision.", "DOCUMENT_CHANGE_PROJECTION_DANGLING_PRODUCT_REVISION");
    } else if (review.resultingProductModelId !== null || review.resultingProductModelHash !== null) {
      fail("Rejected document-change review cannot name a resulting Product Model.", "INVALID_DOCUMENT_CHANGE_PROJECTION_REVIEW");
    }
  }
  for (const receipt of applicationReceipts.documents) {
    const review = reviewsById.get(receipt.reviewDecisionId);
    const set = candidatesBySet.get(receipt.candidateSetId);
    if (!review || receipt.reviewDecisionHash !== review.reviewDecisionHash || !set || receipt.candidateSetHash !== set.candidateSetHash
      || receipt.disposition !== review.disposition || receipt.previousProductModelId !== review.reviewedProductModelId
      || receipt.resultingProductModelId !== (review.resultingProductModelId || review.reviewedProductModelId)) fail("Document-change application receipt references missing or mismatched lineage.", "DOCUMENT_CHANGE_PROJECTION_DANGLING_APPLICATION");
  }
  const payload = {
    kind: "DocumentChangeGraphProjectionInput",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-document-change-graph-projection"), version: DOCUMENT_CHANGE_GRAPH_PROJECTION_VERSION },
    projectId,
    candidateSets: candidateSets.documents,
    reviewDecisions: reviewDecisions.documents,
    productModelRevisions: productModelRevisions.documents,
    applicationReceipts: applicationReceipts.documents,
    authority: "derived-projection-input-not-document-authority",
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const projectionInputHash = digest(canonicalJson(payload));
  return verifyDocumentChangeProjectionInput({ ...payload, projectionInputId: `document-change-projection-${projectionInputHash.slice(0, 24)}`, projectionInputHash }, storage);
}
