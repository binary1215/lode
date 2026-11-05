import { formatForVerifiedOwner, relativeProjectArtifact } from "./project-storage-format.mjs";
import {
  PRODUCT_POLICY_VERSION, PRODUCT_POLICY_CANDIDATE_DIRECTORY, PRODUCT_POLICY_REVIEW_DIRECTORY,
  productPolicyCanonicalJson, requiredText, optionalText, safeFile, readJson,
  normalizeEvidenceAnchors, evidenceStatusFor, policyHash, candidateFile, reviewFile, nextPolicyModel,
  verifyProductPolicyCandidate, verifyProductPolicyReviewDecision,
  readProductPolicyCandidateRecord, readProductPolicyReviewDecisionRecord,
} from "./product-policy-records.mjs";
export {
  PRODUCT_POLICY_VERSION, PRODUCT_POLICY_CANDIDATE_DIRECTORY, PRODUCT_POLICY_REVIEW_DIRECTORY,
  productPolicyCanonicalJson, verifyProductPolicyCandidate, verifyProductPolicyReviewDecision,
} from "./product-policy-records.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inspectProject, SCHEMA_VERSION } from "./lode-core.mjs";
import { verifyProductModelRevisionForProjection, productModelRevisionForImmutableRetry } from "./onboarding-projection.mjs";
import {
  normalizeProductModelDocument,
  productModelDocument,
  readProductModelCanon,
} from "./product-model.mjs";
import { withProjectMutation, withProjectMutationAsync } from "./project-mutation-lock.mjs";
import { artifactAuthorityBoundary } from "./authority-plane-contract.mjs";
import { buildWorldModel, readWorldModel } from "./world-model.mjs";
import { refreshWorldModel } from "./incremental-refresh.mjs";
import { inspectProductPolicyEvidenceCurrentness } from "./product-policy-evidence.mjs";


const REVIEW_ID = /^review-decision-[a-f0-9]{24}$/;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_REVIEWS = 1024;

const fail = (message, code = "PRODUCT_POLICY_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};


const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;




function readyProject(root, action) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") fail(`Project must be ready for ${action}.`, "PROJECT_NOT_READY");
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


function persistImmutable(file, document, verifier, label) {
  const bytes = Buffer.byteLength(json(document));
  if (bytes > MAX_ARTIFACT_BYTES) fail(`${label} exceeds the bounded artifact size.`, "PRODUCT_POLICY_ARTIFACT_LIMIT");
  if (fs.existsSync(file)) {
    const existing = verifier(readJson(file, label));
    if (productPolicyCanonicalJson(existing) !== productPolicyCanonicalJson(document)) fail(`${label} identity collision detected.`, "PRODUCT_POLICY_IMMUTABLE_COLLISION");
    return { status: "existing", file, document: existing };
  }
  atomicWrite(file, json(document));
  return { status: "recorded", file, document };
}



function sourceEvidenceDigest(projectRoot, reference) {
  const file = safeFile(projectRoot, reference);
  if (!fs.existsSync(file)) fail(`Policy source evidence is missing: ${reference}`, "PRODUCT_POLICY_EVIDENCE_NOT_FOUND");
  const stat = fs.statSync(file);
  if (!stat.isFile()) fail(`Policy source evidence is not a regular file: ${reference}`, "PRODUCT_POLICY_EVIDENCE_UNSAFE");
  if (stat.size > MAX_SOURCE_BYTES) fail(`Policy source evidence exceeds 64 MiB: ${reference}`, "PRODUCT_POLICY_EVIDENCE_TOO_LARGE");
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}

function bindLocalEvidence(projectRoot, anchors) {
  return normalizeEvidenceAnchors(anchors).map((anchor) => {
    if (anchor.kind !== "source") return anchor;
    const currentDigest = sourceEvidenceDigest(projectRoot, anchor.reference);
    if (anchor.digest && anchor.digest !== currentDigest) fail(`Policy source evidence digest does not match: ${anchor.reference}`, "PRODUCT_POLICY_EVIDENCE_STALE");
    return { ...anchor, digest: currentDigest };
  }).sort((left, right) => productPolicyCanonicalJson(left).localeCompare(productPolicyCanonicalJson(right)));
}

function revalidateLocalEvidence(projectRoot, candidate) {
  let verifiedLocalSourceCount = 0;
  for (const anchor of candidate.evidenceAnchors) {
    if (anchor.kind !== "source") continue;
    if (sourceEvidenceDigest(projectRoot, anchor.reference) !== anchor.digest) {
      fail(`Policy source evidence changed after proposal: ${anchor.reference}`, "PRODUCT_POLICY_EVIDENCE_STALE");
    }
    verifiedLocalSourceCount += 1;
  }
  return {
    status: candidate.evidenceStatus,
    verifiedLocalSourceCount,
    unverifiedExternalCount: candidate.evidenceAnchors.length - verifiedLocalSourceCount,
  };
}




function revisionFile(projectRoot, productModelId, storage = null) {
  return safeFile(projectRoot, relativeProjectArtifact(storage, "onboarding", "product-model-revisions", `${productModelId}.json`));
}

function productRevision(model, storage = null) {
  if (!storage?.projectId) fail("Product revision requires a verified Project owner.", "PROJECT_IDENTITY_MISMATCH");
  return verifyProductModelRevisionForProjection({
    schemaVersion: SCHEMA_VERSION,
    kind: "ProductModelRevision",
    projectId: storage.projectId,
    productModelId: model.productModelId,
    productModelHash: model.productModelHash,
    document: productModelDocument(model),
    authority: "user-owned-project-canon-revision",
  }, storage);
}

function persistProductRevision(root, model, storage) {
  const file = revisionFile(root, model.productModelId, storage), revision = productRevision(model, storage);
  const intended = fs.existsSync(file) ? productModelRevisionForImmutableRetry(readJson(file, "Product Model revision"), revision, storage) : revision;
  return persistImmutable(file, intended, value => verifyProductModelRevisionForProjection(value, storage), "Product Model revision");
}


function buildCandidate({ inspected, operation, key, baseModel, prior, proposed, resultingModel, evidenceAnchors, explanation }) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "ProductPolicyCandidate",
    protocol: { name: formatForVerifiedOwner(inspected.storage).protocol("head-agent-core-product-policy-candidate"), version: PRODUCT_POLICY_VERSION },
    projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId,
    operation,
    policyKey: key,
    baseProductModelId: baseModel.productModelId,
    baseProductModelHash: baseModel.productModelHash,
    baseProductModelDocument: productModelDocument(baseModel),
    priorPolicyHash: policyHash(prior),
    proposedPolicy: proposed,
    resultingProductModelId: resultingModel.productModelId,
    resultingProductModelHash: resultingModel.productModelHash,
    resultingProductModelDocument: productModelDocument(resultingModel),
    evidenceAnchors,
    evidenceStatus: evidenceStatusFor(evidenceAnchors),
    explanation,
    epistemicClass: "proposed-meaning",
    authority: "candidate-not-product-canon",
    authorityBoundary: artifactAuthorityBoundary("PolicyCandidate"),
    instructionAuthority: false,
    promotionAuthority: false,
    recoveryAuthority: false,
    mutatesCanon: false,
    blocksOrdinaryWork: false,
  };
  const candidateHash = digest(productPolicyCanonicalJson(payload));
  return { ...payload, candidateId: `policy-candidate-${candidateHash.slice(0, 24)}`, candidateHash };
}


function buildReview({ candidate, disposition, rationale, storage = null }) {
  const accepting = disposition === "accept";
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "ReviewDecision",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-product-policy-review"), version: PRODUCT_POLICY_VERSION },
    projectId: candidate.projectId,
    sessionId: candidate.sessionId,
    candidateId: candidate.candidateId,
    candidateHash: candidate.candidateHash,
    disposition,
    rationale,
    previousProductModelId: candidate.baseProductModelId,
    previousProductModelHash: candidate.baseProductModelHash,
    resultingProductModelId: accepting ? candidate.resultingProductModelId : null,
    resultingProductModelHash: accepting ? candidate.resultingProductModelHash : null,
    authority: "explicit-user-review-decision",
    authorityBoundary: artifactAuthorityBoundary("ReviewDecision"),
    instructionAuthority: false,
    promotionAuthority: accepting,
    recoveryAuthority: false,
    mutatesCanon: accepting,
    blocksOrdinaryWork: false,
  };
  const reviewDecisionHash = digest(productPolicyCanonicalJson(payload));
  return { ...payload, reviewDecisionId: `review-decision-${reviewDecisionHash.slice(0, 24)}`, reviewDecisionHash };
}


function recordedReview(projectRoot, candidate, storage = null) {
  const directory = safeFile(projectRoot, relativeProjectArtifact(storage, "product-policy", "review-decisions"));
  if (!fs.existsSync(directory)) return null;
  const names = fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  if (names.length > MAX_REVIEWS) fail("Product Policy review directory exceeds its bounded audit limit.", "PRODUCT_POLICY_ARTIFACT_LIMIT");
  const matches = [];
  for (const name of names) {
    if (!REVIEW_ID.test(name.slice(0, -5))) fail("Product Policy review directory contains an unexpected artifact.", "INVALID_PRODUCT_POLICY_ARTIFACT");
    const review = verifyProductPolicyReviewDecision(readJson(path.join(directory, name), "Product Policy ReviewDecision"), null, "", formatForVerifiedOwner(storage));
    if (review.reviewDecisionId !== name.slice(0, -5)) fail("Product Policy ReviewDecision filename does not match its identity.", "PRODUCT_POLICY_ARTIFACT_IDENTITY_MISMATCH");
    if (review.candidateId === candidate.candidateId) matches.push(verifyProductPolicyReviewDecision(review, candidate, candidate.projectId, formatForVerifiedOwner(storage)));
  }
  if (matches.length > 1) fail("Product Policy candidate has conflicting durable decisions.", "PRODUCT_POLICY_REVIEW_CONFLICT");
  return matches[0] || null;
}

export async function proposeProductPolicy({ root = ".", operation = "create", key, name = null, description = null, statement = null, appliesTo = null, governedBy = null, evidenceAnchors = [], explanation = "" } = {}) {
  return (await withProjectMutationAsync({ root, scope: "onboarding-promotion" }, async () => {
    const inspected = readyProject(root, "Product Policy proposal");
    const canon = readProductModelCanon({ projectRoot: inspected.project.projectRoot, storage: inspected.storage }).model;
    const normalizedOperation = requiredText(operation, "Policy operation", 16).toLowerCase();
    if (!["create", "revise", "retire"].includes(normalizedOperation)) fail("Policy operation must be create, revise, or retire.", "INVALID_PRODUCT_POLICY_INPUT");
    const policyKey = requiredText(key, "Policy key", 128);
    const transition = nextPolicyModel({ baseModel: canon, operation: normalizedOperation, key: policyKey, name, description, statement, appliesTo, governedBy, storage: inspected.storage });
    const candidate = verifyProductPolicyCandidate(buildCandidate({
      inspected,
      operation: normalizedOperation,
      key: policyKey,
      baseModel: canon,
      prior: transition.prior,
      proposed: transition.proposed,
      resultingModel: transition.resultingModel,
      evidenceAnchors: bindLocalEvidence(inspected.project.projectRoot, evidenceAnchors),
      explanation: optionalText(explanation, "Policy proposal explanation", 4000),
    }), inspected.project.projectId, inspected.storage);
    const entry = persistImmutable(candidateFile(inspected.project.projectRoot, candidate.candidateId, inspected.storage), candidate, (value) => verifyProductPolicyCandidate(value, inspected.project.projectId, inspected.storage), "Product Policy candidate");
    return {
      status: "awaiting-review",
      file: entry.file,
      candidate,
      reviewRequired: true,
      ordinaryWorkBlocked: false,
      userAction: `Review exact candidate ${candidate.candidateId}; accepting changes Product Canon, rejecting only records the disposition.`,
    };
  }));
}

export function readProductPolicyCandidate({ root = ".", candidateId } = {}) {
  const inspected = readyProject(root, "Product Policy candidate inspection");
  return readProductPolicyCandidateRecord({ root: inspected.project.projectRoot, candidateId, storage: inspected.storage });
}

export function readProductPolicyReviewDecision({ root = ".", reviewDecisionId } = {}) {
  const inspected = readyProject(root, "Product Policy review inspection");
  return readProductPolicyReviewDecisionRecord({ root: inspected.project.projectRoot, reviewDecisionId, storage: inspected.storage });
}

async function refreshPolicyProjection(projectRoot, reviewDecisionId) {
  try {
    (await readWorldModel({ root: projectRoot }));
    return await refreshWorldModel({ root: projectRoot, triggerKind: "manual", triggerEvidenceIds: [reviewDecisionId] });
  } catch (error) {
    if (!new Set(["WORLD_MODEL_NOT_BUILT", "WORLD_MODEL_SNAPSHOT_MISSING"]).has(error.code)) throw error;
    return (await buildWorldModel({ root: projectRoot }));
  }
}

export async function reviewProductPolicy({ root = ".", candidateId, disposition, rationale } = {}) {
  const normalizedDisposition = requiredText(disposition, "Policy review disposition", 16).toLowerCase();
  if (!["accept", "reject"].includes(normalizedDisposition)) fail("Policy review disposition must be accept or reject.", "INVALID_PRODUCT_POLICY_REVIEW");
  const normalizedRationale = requiredText(rationale, "Policy review rationale", 4000);
  const applied = await withProjectMutationAsync({ root, scope: "onboarding-promotion" }, async () => {
    const outer = readyProject(root, "Product Policy review");
    return withProjectMutation({ root: outer.project.projectRoot, scope: "session-recovery" }, () => {
      const inspected = readyProject(outer.project.projectRoot, "Product Policy review");
      const candidate = readProductPolicyCandidate({ root: inspected.project.projectRoot, candidateId }).candidate;
      if (candidate.sessionId !== inspected.state.sessionId) fail("Product Policy candidate belongs to another HEAD Session.", "PRODUCT_POLICY_SESSION_DRIFT");
      const intended = verifyProductPolicyReviewDecision(buildReview({ candidate, disposition: normalizedDisposition, rationale: normalizedRationale, storage: inspected.storage }), candidate, inspected.project.projectId, inspected.storage);
      const existing = recordedReview(inspected.project.projectRoot, candidate, inspected.storage);
      if (existing && existing.reviewDecisionId !== intended.reviewDecisionId) fail(`A different ReviewDecision is already durable for this candidate: ${existing.reviewDecisionId}`, "PRODUCT_POLICY_REVIEW_CONFLICT");
      const review = existing || intended;
      const canon = readProductModelCanon({ projectRoot: inspected.project.projectRoot, storage: inspected.storage }).model;
      if (normalizedDisposition === "reject") {
        const entry = persistImmutable(reviewFile(inspected.project.projectRoot, review.reviewDecisionId, inspected.storage), review, (value) => verifyProductPolicyReviewDecision(value, candidate, inspected.project.projectId, inspected.storage), "Product Policy ReviewDecision");
        return { status: "rejected", inspected, candidate, review, reviewFile: entry.file, canonChanged: false };
      }
      const atBase = canon.productModelId === candidate.baseProductModelId && canon.productModelHash === candidate.baseProductModelHash;
      const atResult = canon.productModelId === candidate.resultingProductModelId && canon.productModelHash === candidate.resultingProductModelHash;
      if (!atBase && !atResult) fail("Product Canon changed after this Policy proposal; create and review a fresh candidate.", "PRODUCT_POLICY_CANON_DRIFT");
      if (atBase && (inspected.state.activeRunId || inspected.state.pendingReview)) {
        fail("Product Policy acceptance cannot change Product Canon while a Run is active or awaiting result review.", "PRODUCT_POLICY_RUN_CONFLICT");
      }
      const evidenceCheck = existing ? { status: "bound-by-durable-review", replayed: true }
        : { ...revalidateLocalEvidence(inspected.project.projectRoot, candidate), replayed: false };
      const entry = persistImmutable(reviewFile(inspected.project.projectRoot, review.reviewDecisionId, inspected.storage), review, (value) => verifyProductPolicyReviewDecision(value, candidate, inspected.project.projectId, inspected.storage), "Product Policy ReviewDecision");
      const baseModel = normalizeProductModelDocument(candidate.baseProductModelDocument, inspected.storage);
      const resultModel = normalizeProductModelDocument(candidate.resultingProductModelDocument, inspected.storage);
      persistProductRevision(inspected.project.projectRoot, baseModel, inspected.storage);
      persistProductRevision(inspected.project.projectRoot, resultModel, inspected.storage);
      if (atBase) atomicWrite(safeFile(inspected.project.projectRoot, relativeProjectArtifact(inspected.storage, "context", "product-model.json")), json(productModelDocument(resultModel)));
      return { status: "accepted", inspected, candidate, review, reviewFile: entry.file, canonChanged: atBase, evidenceCheck };
    });
  });
  if (applied.status !== "accepted") return { ...applied, ordinaryWorkBlocked: false };
  try {
    const projection = await refreshPolicyProjection(applied.inspected.project.projectRoot, applied.review.reviewDecisionId);
    return { ...applied, status: "accepted", projectionStatus: "current", projection, ordinaryWorkBlocked: false, additionalUserReviewRequired: false };
  } catch (error) {
    return {
      ...applied,
      status: "accepted-projection-pending",
      projectionStatus: "refresh-required",
      projectionError: { code: error.code || "PRODUCT_POLICY_PROJECTION_FAILED", message: error.message },
      ordinaryWorkBlocked: false,
      additionalUserReviewRequired: false,
      userAction: "Retry this unchanged ReviewDecision to repair only the derived World/Graph projection; no new approval is required.",
    };
  }
}

function acceptedPolicySuccessors(projectRoot, projectId, storage = null) {
  const directory = safeFile(projectRoot, relativeProjectArtifact(storage, "product-policy", "review-decisions"));
  const successors = new Map();
  if (!fs.existsSync(directory)) return successors;
  const names = fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  if (names.length > MAX_REVIEWS) fail("Product Policy review directory exceeds its bounded audit limit.", "PRODUCT_POLICY_ARTIFACT_LIMIT");
  for (const name of names) {
    const reviewDecisionId = name.slice(0, -5);
    if (!REVIEW_ID.test(reviewDecisionId)) fail("Product Policy review directory contains an unexpected artifact.", "INVALID_PRODUCT_POLICY_ARTIFACT");
    const review = verifyProductPolicyReviewDecision(readJson(path.join(directory, name), "Product Policy ReviewDecision"), null, projectId, formatForVerifiedOwner(storage));
    if (review.reviewDecisionId !== reviewDecisionId) fail("Product Policy ReviewDecision filename does not match its identity.", "PRODUCT_POLICY_ARTIFACT_IDENTITY_MISMATCH");
    if (review.disposition !== "accept") continue;
    const candidate = readProductPolicyCandidateRecord({ root: projectRoot, candidateId: review.candidateId, storage }).candidate;
    verifyProductPolicyReviewDecision(review, candidate, projectId, formatForVerifiedOwner(storage));
    const current = successors.get(candidate.baseProductModelId) || new Set();
    current.add(candidate.resultingProductModelId);
    successors.set(candidate.baseProductModelId, current);
  }
  return successors;
}

function reachesProductModel(successors, start, target) {
  const visited = new Set();
  const queue = [start];
  while (queue.length) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    if (current === target) return true;
    visited.add(current);
    for (const next of successors.get(current) || []) if (!visited.has(next)) queue.push(next);
  }
  return false;
}

export function inspectProductPolicyStatus({ root = ".", candidateId } = {}) {
  const inspected = readyProject(root, "Product Policy status");
  const candidate = readProductPolicyCandidate({ root: inspected.project.projectRoot, candidateId }).candidate;
  const review = recordedReview(inspected.project.projectRoot, candidate, inspected.storage);
  const canon = readProductModelCanon({ projectRoot: inspected.project.projectRoot, storage: inspected.storage }).model;
  const superseded = review?.disposition === "accept" && reachesProductModel(
    acceptedPolicySuccessors(inspected.project.projectRoot, inspected.project.projectId, inspected.storage),
    candidate.resultingProductModelId,
    canon.productModelId,
  );
  const canonState = canon.productModelId === candidate.resultingProductModelId ? "result-current"
    : superseded ? "superseded" : canon.productModelId === candidate.baseProductModelId ? "base-current" : "diverged";
  const status = !review ? "awaiting-review" : review.disposition === "reject" ? "rejected"
    : canonState === "result-current" ? "accepted"
      : canonState === "superseded" ? "accepted-historical" : "review-recorded-application-pending";
  return {
    status,
    candidateId: candidate.candidateId,
    reviewDecisionId: review?.reviewDecisionId || null,
    canonState,
    evidenceStatus: candidate.evidenceStatus,
    evidenceCurrentness: inspectProductPolicyEvidenceCurrentness({ projectRoot: inspected.project.projectRoot, candidate }),
    ordinaryWorkBlocked: false,
    userAction: review ? null : `Review exact candidate ${candidate.candidateId}.`,
  };
}
