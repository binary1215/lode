import crypto from "node:crypto";
import { familyFormatForOriginal } from "./project-storage-format.mjs";
import { normalizeProductModelDocument } from "./product-model.mjs";
import { verifyArtifactAuthorityBoundary } from "./authority-plane-contract.mjs";

// Pure typed verification only. Core evidence reads must not load optional
// World, graph or document-projection implementations.
export const DOCUMENT_CHANGE_REVIEW_VERSION = "0.1.0";
const PRODUCT_MODEL_ID_PATTERN = /^product-model-[a-f0-9]{24}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
const digest = value => crypto.createHash("sha256").update(value).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function documentChangeReviewCanonicalJson(value) {
  return JSON.stringify(canonical(value));
}

export function verifyProductModelRevisionForProjection(document, storage = null) {
  if (!document || document.schemaVersion !== 1 || document.kind !== "ProductModelRevision" || document.authority !== "user-owned-project-canon-revision") {
    fail("Product Model revision is invalid.", "INVALID_ONBOARDING_PRODUCT_REVISION");
  }
  const model = normalizeProductModelDocument(document.document, storage);
  if (document.productModelId !== model.productModelId || document.productModelHash !== model.productModelHash) {
    fail("Product Model revision digest verification failed.", "ONBOARDING_PRODUCT_REVISION_DIGEST_MISMATCH");
  }
  if (document.projectId !== undefined && (typeof document.projectId !== "string" || !document.projectId
    || storage?.projectId && document.projectId !== storage.projectId)) {
    fail("Product Model revision Project identity differs.", "ONBOARDING_PRODUCT_REVISION_PROJECT_MISMATCH");
  }
  return document;
}

export function verifyDocumentChangeProductModelRevision(document, projectId = "", storage = undefined) {
  if (!document || document.schemaVersion !== 1 || document.kind !== "ProductModelRevision"
    || !familyFormatForOriginal("head-agent-core-document-change-product-revision", document, storage)
    || document.protocol?.version !== DOCUMENT_CHANGE_REVIEW_VERSION
    || (projectId && document.projectId !== projectId)
    || !PRODUCT_MODEL_ID_PATTERN.test(document.productModelId || "")
    || !HASH_PATTERN.test(document.productModelHash || "")
    || !HASH_PATTERN.test(document.revisionHash || "")
    || document.authority !== "explicit-user-reviewed-product-canon-revision"
    || document.instructionAuthority !== true || document.promotionAuthority !== true) {
    fail("Document-change ProductModelRevision is invalid.", "INVALID_DOCUMENT_CHANGE_PRODUCT_REVISION");
  }
  if (document.authorityBoundary) verifyArtifactAuthorityBoundary("ProductModelRevision", document.authorityBoundary);
  const normalized = normalizeProductModelDocument(document.document, familyFormatForOriginal("head-agent-core-document-change-product-revision", document, storage));
  if (normalized.productModelId !== document.productModelId || normalized.productModelHash !== document.productModelHash) {
    fail("Document-change ProductModelRevision does not match its Product Model.", "DOCUMENT_CHANGE_PRODUCT_REVISION_MISMATCH");
  }
  const payload = { ...document };
  delete payload.revisionHash;
  if (document.revisionHash !== digest(documentChangeReviewCanonicalJson(payload))) {
    fail("Document-change ProductModelRevision digest verification failed.", "DOCUMENT_CHANGE_PRODUCT_REVISION_DIGEST_MISMATCH");
  }
  return document;
}
