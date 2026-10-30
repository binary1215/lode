import { formatForVerifiedOwner, familyFormatForOriginal, relativeProjectArtifact } from "./project-storage-format.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  readProductPolicyCandidateRecord as readProductPolicyCandidate,
  readProductPolicyReviewDecisionRecord as readProductPolicyReviewDecision,
  verifyProductPolicyCandidate,
  verifyProductPolicyReviewDecision,
} from "./product-policy-records.mjs";
import { artifactAuthorityBoundary, verifyArtifactAuthorityBoundary } from "./authority-plane-contract.mjs";

export const PRODUCT_POLICY_GRAPH_PROJECTION_VERSION = "0.1.0";
const MAX_ARTIFACTS = 1024;
const CANDIDATE_ID = /^policy-candidate-[a-f0-9]{24}$/;
const REVIEW_ID = /^review-decision-[a-f0-9]{24}$/;

const fail = (message, code = "PRODUCT_POLICY_PROJECTION_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

const canonicalJson = (value) => JSON.stringify(canonical(value));
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function directoryIds(projectRoot, relativeDirectory, pattern, label) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const directory = path.resolve(root, ...relativeDirectory.split("/"));
  const relative = path.relative(root, directory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(`${label} path escapes the project.`, "PRODUCT_POLICY_PROJECTION_PATH_ESCAPE");
  if (!fs.existsSync(directory)) return [];
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} path is unsafe.`, "PRODUCT_POLICY_PROJECTION_PATH_UNSAFE");
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length > MAX_ARTIFACTS) fail(`${label} exceeds its bounded artifact count.`, "PRODUCT_POLICY_PROJECTION_LIMIT");
  return entries.map((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) fail(`${label} contains an unsupported artifact.`, "PRODUCT_POLICY_PROJECTION_PATH_UNSAFE");
    const id = entry.name.slice(0, -5);
    if (!pattern.test(id)) fail(`${label} filename is invalid.`, "PRODUCT_POLICY_PROJECTION_IDENTITY_MISMATCH");
    return id;
  });
}

function reaches(successors, start, target) {
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

function applicationStatuses(candidates, reviews, currentProductModelId) {
  const reviewByCandidate = new Map();
  const successors = new Map();
  const candidateById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  for (const review of reviews) {
    if (reviewByCandidate.has(review.candidateId)) fail("A Product Policy candidate has multiple ReviewDecisions.", "PRODUCT_POLICY_PROJECTION_REVIEW_CONFLICT");
    reviewByCandidate.set(review.candidateId, review);
    if (review.disposition !== "accept") continue;
    const candidate = candidateById.get(review.candidateId);
    const prior = successors.get(candidate.baseProductModelId) || new Set();
    prior.add(candidate.resultingProductModelId);
    successors.set(candidate.baseProductModelId, prior);
  }
  return candidates.map((candidate) => {
    const review = reviewByCandidate.get(candidate.candidateId) || null;
    const applicationStatus = !review ? "awaiting-review" : review.disposition === "reject" ? "rejected"
      : candidate.resultingProductModelId === currentProductModelId ? "applied-current"
        : reaches(successors, candidate.resultingProductModelId, currentProductModelId) ? "applied-historical" : "application-pending-or-diverged";
    return { candidate, reviewDecisionId: review?.reviewDecisionId || null, applicationStatus };
  });
}

export function verifyProductPolicyGraphProjection(document, projectId = "", storage = undefined) {
  const format = familyFormatForOriginal("head-agent-core-product-policy-graph-projection", document, storage);
  if (!document || document.kind !== "ProductPolicyGraphProjectionInput"
    || !format
    || document.protocol.version !== PRODUCT_POLICY_GRAPH_PROJECTION_VERSION
    || projectId && document.projectId !== projectId
    || !/^product-model-[a-f0-9]{24}$/.test(document.currentProductModelId || "")
    || !Array.isArray(document.candidates) || !Array.isArray(document.reviewDecisions)
    || document.authority !== "derived-projection-input-not-product-canon"
    || document.instructionAuthority !== false || document.promotionAuthority !== false || document.recoveryAuthority !== false) {
    fail("Product Policy graph projection is invalid.", "INVALID_PRODUCT_POLICY_PROJECTION");
  }
  verifyArtifactAuthorityBoundary("GraphSnapshot", document.authorityBoundary);
  if (document.candidates.length > MAX_ARTIFACTS || document.reviewDecisions.length > MAX_ARTIFACTS) fail("Product Policy graph projection exceeds its bounded artifact count.", "PRODUCT_POLICY_PROJECTION_LIMIT");
  const candidates = document.candidates.map((entry) => {
    if (!entry || !["awaiting-review", "rejected", "applied-current", "applied-historical", "application-pending-or-diverged"].includes(entry.applicationStatus)) fail("Product Policy projection application status is invalid.", "INVALID_PRODUCT_POLICY_PROJECTION");
    return verifyProductPolicyCandidate(entry.candidate, document.projectId, format);
  });
  const candidateById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const reviews = document.reviewDecisions.map((review) => {
    const candidate = candidateById.get(review.candidateId);
    if (!candidate) fail("Product Policy projection ReviewDecision is dangling.", "PRODUCT_POLICY_PROJECTION_DANGLING_REVIEW");
    return verifyProductPolicyReviewDecision(review, candidate, document.projectId, format);
  });
  const expectedEntries = applicationStatuses(candidates, reviews, document.currentProductModelId);
  if (canonicalJson(expectedEntries) !== canonicalJson(document.candidates)) fail("Product Policy projection application statuses are not reproducible.", "PRODUCT_POLICY_PROJECTION_STATUS_MISMATCH");
  const payload = { ...document };
  delete payload.projectionInputId;
  delete payload.projectionInputHash;
  const projectionInputHash = digest(canonicalJson(payload));
  if (document.projectionInputHash !== projectionInputHash || document.projectionInputId !== `product-policy-projection-${projectionInputHash.slice(0, 24)}`) fail("Product Policy projection digest verification failed.", "PRODUCT_POLICY_PROJECTION_DIGEST_MISMATCH");
  return document;
}

export function loadProductPolicyGraphProjection({ projectRoot, projectId, currentProductModelId, storage = null } = {}) {
  const format = formatForVerifiedOwner(storage);
  if (typeof projectRoot !== "string" || !projectRoot || !new RegExp(`^${format.projectPrefix}[a-f0-9]{20}$`).test(projectId || "") || !/^product-model-[a-f0-9]{24}$/.test(currentProductModelId || "")) fail("Product Policy graph projection scope is invalid.", "INVALID_PRODUCT_POLICY_PROJECTION_SCOPE");
  const candidates = directoryIds(projectRoot, relativeProjectArtifact(storage, "product-policy", "candidates"), CANDIDATE_ID, "Product Policy candidate directory")
    .map((candidateId) => readProductPolicyCandidate({ root: projectRoot, candidateId, storage }).candidate);
  const reviewDecisions = directoryIds(projectRoot, relativeProjectArtifact(storage, "product-policy", "review-decisions"), REVIEW_ID, "Product Policy review directory")
    .map((reviewDecisionId) => readProductPolicyReviewDecision({ root: projectRoot, reviewDecisionId, storage }).reviewDecision);
  const payload = {
    kind: "ProductPolicyGraphProjectionInput",
    protocol: { name: format.protocol("head-agent-core-product-policy-graph-projection"), version: PRODUCT_POLICY_GRAPH_PROJECTION_VERSION },
    projectId,
    currentProductModelId,
    candidates: applicationStatuses(candidates, reviewDecisions, currentProductModelId),
    reviewDecisions,
    authority: "derived-projection-input-not-product-canon",
    authorityBoundary: artifactAuthorityBoundary("GraphSnapshot"),
    instructionAuthority: false,
    promotionAuthority: false,
    recoveryAuthority: false,
  };
  const projectionInputHash = digest(canonicalJson(payload));
  return verifyProductPolicyGraphProjection({ ...payload, projectionInputId: `product-policy-projection-${projectionInputHash.slice(0, 24)}`, projectionInputHash }, projectId, storage);
}
