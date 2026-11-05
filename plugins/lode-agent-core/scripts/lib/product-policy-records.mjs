import { formatForVerifiedOwner, familyFormatForOriginal, relativeProjectArtifact } from "./project-storage-format.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeProductModelDocument, productModelDocument, upgradeProductModelDocument } from "./product-model.mjs";
import { verifyArtifactAuthorityBoundary } from "./authority-plane-contract.mjs";

// Frozen record schema, not initialization or effect orchestration.
const SCHEMA_VERSION = 1;
export const PRODUCT_POLICY_VERSION = "0.1.0";
export const PRODUCT_POLICY_CANDIDATE_DIRECTORY = ".head/product-policy/candidates";
export const PRODUCT_POLICY_REVIEW_DIRECTORY = ".head/product-policy/review-decisions";
const HASH = /^[a-f0-9]{64}$/;
const CANDIDATE_ID = /^policy-candidate-[a-f0-9]{24}$/;
const REVIEW_ID = /^review-decision-[a-f0-9]{24}$/;
const fail = (message, code = "PRODUCT_POLICY_ERROR") => { throw Object.assign(new Error(message), { code }); };
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export const productPolicyCanonicalJson = value => JSON.stringify(canonical(value));
const digest = value => crypto.createHash("sha256").update(value).digest("hex");

export function requiredText(value, label, max = 4000) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is required.`, "INVALID_PRODUCT_POLICY_INPUT");
  const normalized = value.trim();
  if (normalized.length > max) fail(`${label} is too long.`, "INVALID_PRODUCT_POLICY_INPUT");
  return normalized;
}

export function optionalText(value, label, max = 4000) {
  if (value == null) return "";
  if (typeof value !== "string") fail(`${label} must be text.`, "INVALID_PRODUCT_POLICY_INPUT");
  const normalized = value.trim();
  if (normalized.length > max) fail(`${label} is too long.`, "INVALID_PRODUCT_POLICY_INPUT");
  return normalized;
}

export function exactFields(value, fields, label) {
  const expected = [...fields].sort();
  const actual = Object.keys(value || {}).sort();
  if (productPolicyCanonicalJson(actual) !== productPolicyCanonicalJson(expected)) fail(`${label} contains unsupported or missing fields.`, `INVALID_${label.replaceAll(" ", "_").toUpperCase()}`);
}

export function safeFile(projectRoot, relative) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const file = path.resolve(root, ...relative.split("/"));
  const fromRoot = path.relative(root, file);
  if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) fail("Product Policy artifact path escapes the project root.", "PRODUCT_POLICY_PATH_ESCAPE");
  let current = root;
  for (const segment of fromRoot.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail("Product Policy artifact path traverses a symlink.", "PRODUCT_POLICY_SYMLINK_PATH");
  }
  return file;
}

export function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`${label} is invalid JSON: ${error.message}`, "INVALID_PRODUCT_POLICY_ARTIFACT"); }
}

export function normalizeEvidenceAnchors(value = []) {
  if (!Array.isArray(value) || value.length > 32) fail("Policy evidenceAnchors must be an array of at most 32 records.", "INVALID_PRODUCT_POLICY_EVIDENCE");
  const allowedKinds = new Set(["user-request", "source", "observation", "decision", "other"]);
  const anchors = value.map((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) fail(`Policy evidenceAnchors[${index}] must be an object.`, "INVALID_PRODUCT_POLICY_EVIDENCE");
    const unexpected = Object.keys(record).filter((key) => !["kind", "reference", "digest", "summary"].includes(key));
    if (unexpected.length) fail(`Policy evidenceAnchors[${index}] contains unsupported fields.`, "INVALID_PRODUCT_POLICY_EVIDENCE");
    const kind = requiredText(record.kind, `Policy evidenceAnchors[${index}].kind`, 32);
    if (!allowedKinds.has(kind)) fail(`Policy evidenceAnchors[${index}].kind is invalid.`, "INVALID_PRODUCT_POLICY_EVIDENCE");
    let reference = requiredText(record.reference, `Policy evidenceAnchors[${index}].reference`, 1024);
    if (kind === "source") {
      reference = reference.replaceAll("\\", "/").replace(/^\.\//, "");
      if (!reference || path.posix.isAbsolute(reference) || /^[A-Za-z]:\//.test(reference)
        || reference === ".." || reference.startsWith("../") || reference.includes("/../")) {
        fail(`Policy evidenceAnchors[${index}].reference must be a project-relative source path.`, "INVALID_PRODUCT_POLICY_EVIDENCE");
      }
      reference = path.posix.normalize(reference);
    }
    const anchorDigest = record.digest == null ? null : requiredText(record.digest, `Policy evidenceAnchors[${index}].digest`, 64);
    if (anchorDigest !== null && !HASH.test(anchorDigest)) fail(`Policy evidenceAnchors[${index}].digest must be SHA-256.`, "INVALID_PRODUCT_POLICY_EVIDENCE");
    return { kind, reference, digest: anchorDigest, summary: optionalText(record.summary, `Policy evidenceAnchors[${index}].summary`, 1000) };
  }).sort((left, right) => productPolicyCanonicalJson(left).localeCompare(productPolicyCanonicalJson(right)));
  if (new Set(anchors.map(productPolicyCanonicalJson)).size !== anchors.length) fail("Policy evidenceAnchors contains duplicates.", "INVALID_PRODUCT_POLICY_EVIDENCE");
  return anchors;
}

export function evidenceStatusFor(anchors) {
  if (!anchors.length) return "not-supplied";
  const sourceCount = anchors.filter((anchor) => anchor.kind === "source").length;
  if (!sourceCount) return "unverified-external";
  return sourceCount === anchors.length ? "local-source-bound" : "partially-bound";
}

export function policyHash(policy) { return policy ? digest(productPolicyCanonicalJson(policy)) : null; }

export function candidateFile(projectRoot, candidateId, storage = null) {
  if (!CANDIDATE_ID.test(candidateId || "")) fail("Product Policy candidate id is invalid.", "INVALID_PRODUCT_POLICY_CANDIDATE_ID");
  return safeFile(projectRoot, relativeProjectArtifact(storage, "product-policy", "candidates", `${candidateId}.json`));
}

export function reviewFile(projectRoot, reviewDecisionId, storage = null) {
  if (!REVIEW_ID.test(reviewDecisionId || "")) fail("Product Policy ReviewDecision id is invalid.", "INVALID_PRODUCT_POLICY_REVIEW_ID");
  return safeFile(projectRoot, relativeProjectArtifact(storage, "product-policy", "review-decisions", `${reviewDecisionId}.json`));
}

export function nextPolicyModel({ baseModel, operation, key, name, description, statement, appliesTo, governedBy, storage = null }) {
  const document = upgradeProductModelDocument(baseModel);
  const index = document.policies.findIndex((policy) => policy.key === key);
  const prior = index >= 0 ? document.policies[index] : null;
  if (operation === "create" && prior) fail(`Policy already exists: ${key}`, "PRODUCT_POLICY_ALREADY_EXISTS");
  if (operation !== "create" && !prior) fail(`Policy does not exist: ${key}`, "PRODUCT_POLICY_NOT_FOUND");
  if (operation !== "create" && prior.status === "retired") fail(`Policy is already retired: ${key}`, "PRODUCT_POLICY_RETIRED");
  let proposed;
  if (operation === "retire") proposed = { ...prior, status: "retired" };
  else proposed = {
    key,
    name: requiredText(name ?? prior?.name, "Policy name", 256),
    description: optionalText(description ?? prior?.description, "Policy description", 4000),
    statement: requiredText(statement ?? prior?.statement, "Policy statement", 8000),
    status: "active",
    appliesTo: appliesTo ?? prior?.appliesTo ?? [],
    governedBy: governedBy ?? prior?.governedBy ?? [],
  };
  if (index < 0) document.policies.push(proposed);
  else document.policies[index] = proposed;
  const resultingModel = normalizeProductModelDocument(document, storage);
  const normalizedPolicy = resultingModel.policies.find((policy) => policy.key === key);
  if (resultingModel.productModelId === baseModel.productModelId) fail("Product Policy proposal would not change Product Canon.", "PRODUCT_POLICY_NO_CHANGE");
  return { prior, proposed: normalizedPolicy, resultingModel };
}

export function verifyProductPolicyCandidate(document, projectId = "", storage = undefined) {
  const format = familyFormatForOriginal("head-agent-core-product-policy-candidate", document, storage);
  exactFields(document, ["schemaVersion", "kind", "protocol", "projectId", "sessionId", "operation", "policyKey", "baseProductModelId", "baseProductModelHash", "baseProductModelDocument", "priorPolicyHash", "proposedPolicy", "resultingProductModelId", "resultingProductModelHash", "resultingProductModelDocument", "evidenceAnchors", "evidenceStatus", "explanation", "epistemicClass", "authority", "authorityBoundary", "instructionAuthority", "promotionAuthority", "recoveryAuthority", "mutatesCanon", "blocksOrdinaryWork", "candidateId", "candidateHash"], "Product Policy candidate");
  if (!document || document.schemaVersion !== SCHEMA_VERSION || document.kind !== "ProductPolicyCandidate"
    || !format || document.protocol.version !== PRODUCT_POLICY_VERSION
    || !CANDIDATE_ID.test(document.candidateId || "") || !HASH.test(document.candidateHash || "")
    || projectId && document.projectId !== projectId || !["create", "revise", "retire"].includes(document.operation)
    || document.policyKey !== document.proposedPolicy?.key || !["not-supplied", "local-source-bound", "partially-bound", "unverified-external"].includes(document.evidenceStatus)
    || document.epistemicClass !== "proposed-meaning" || document.authority !== "candidate-not-product-canon"
    || document.instructionAuthority !== false || document.promotionAuthority !== false || document.recoveryAuthority !== false
    || document.mutatesCanon !== false || document.blocksOrdinaryWork !== false) fail("Product Policy candidate is invalid.", "INVALID_PRODUCT_POLICY_CANDIDATE");
  verifyArtifactAuthorityBoundary("PolicyCandidate", document.authorityBoundary);
  const base = normalizeProductModelDocument(document.baseProductModelDocument, format);
  const result = normalizeProductModelDocument(document.resultingProductModelDocument, format);
  if (base.productModelId !== document.baseProductModelId || base.productModelHash !== document.baseProductModelHash
    || result.productModelId !== document.resultingProductModelId || result.productModelHash !== document.resultingProductModelHash) {
    fail("Product Policy candidate Product Model binding is invalid.", "PRODUCT_POLICY_MODEL_BINDING_MISMATCH");
  }
  const normalizedEvidence = normalizeEvidenceAnchors(document.evidenceAnchors);
  if (productPolicyCanonicalJson(normalizedEvidence) !== productPolicyCanonicalJson(document.evidenceAnchors)
    || normalizedEvidence.some((anchor) => anchor.kind === "source" && !anchor.digest)
    || document.evidenceStatus !== evidenceStatusFor(normalizedEvidence)) fail("Product Policy candidate evidence is not normalized or accurately disclosed.", "INVALID_PRODUCT_POLICY_EVIDENCE");
  let expected;
  try {
    expected = nextPolicyModel({
      baseModel: base,
      operation: document.operation,
      key: document.policyKey,
      name: document.proposedPolicy?.name,
      description: document.proposedPolicy?.description,
      statement: document.proposedPolicy?.statement,
      appliesTo: document.proposedPolicy?.appliesTo,
      governedBy: document.proposedPolicy?.governedBy,
      storage: format,
    });
  } catch (error) {
    fail(`Product Policy candidate transition is invalid: ${error.message}`, "PRODUCT_POLICY_TRANSITION_MISMATCH");
  }
  if (policyHash(expected.prior) !== document.priorPolicyHash
    || productPolicyCanonicalJson(expected.proposed) !== productPolicyCanonicalJson(document.proposedPolicy)
    || productPolicyCanonicalJson(productModelDocument(expected.resultingModel)) !== productPolicyCanonicalJson(productModelDocument(result))) {
    fail("Product Policy candidate changes more than its declared operation.", "PRODUCT_POLICY_TRANSITION_MISMATCH");
  }
  const payload = { ...document };
  delete payload.candidateId;
  delete payload.candidateHash;
  const hash = digest(productPolicyCanonicalJson(payload));
  if (hash !== document.candidateHash || document.candidateId !== `policy-candidate-${hash.slice(0, 24)}`) fail("Product Policy candidate digest verification failed.", "PRODUCT_POLICY_CANDIDATE_DIGEST_MISMATCH");
  return document;
}

export function verifyProductPolicyReviewDecision(document, candidate = null, projectId = "", storage = undefined) {
  const format = familyFormatForOriginal("head-agent-core-product-policy-review", document, storage);
  exactFields(document, ["schemaVersion", "kind", "protocol", "projectId", "sessionId", "candidateId", "candidateHash", "disposition", "rationale", "previousProductModelId", "previousProductModelHash", "resultingProductModelId", "resultingProductModelHash", "authority", "authorityBoundary", "instructionAuthority", "promotionAuthority", "recoveryAuthority", "mutatesCanon", "blocksOrdinaryWork", "reviewDecisionId", "reviewDecisionHash"], "Product Policy ReviewDecision");
  if (!document || document.schemaVersion !== SCHEMA_VERSION || document.kind !== "ReviewDecision"
    || !format || document.protocol.version !== PRODUCT_POLICY_VERSION
    || !REVIEW_ID.test(document.reviewDecisionId || "") || !HASH.test(document.reviewDecisionHash || "")
    || projectId && document.projectId !== projectId || !["accept", "reject"].includes(document.disposition)
    || document.authority !== "explicit-user-review-decision" || document.instructionAuthority !== false
    || document.promotionAuthority !== (document.disposition === "accept") || document.recoveryAuthority !== false
    || document.mutatesCanon !== (document.disposition === "accept") || document.blocksOrdinaryWork !== false) fail("Product Policy ReviewDecision is invalid.", "INVALID_PRODUCT_POLICY_REVIEW");
  verifyArtifactAuthorityBoundary("ReviewDecision", document.authorityBoundary);
  const accepting = document.disposition === "accept";
  if (accepting !== Boolean(document.resultingProductModelId) || accepting !== Boolean(document.resultingProductModelHash)) fail("Product Policy ReviewDecision promotion fields are invalid.", "INVALID_PRODUCT_POLICY_REVIEW");
  if (candidate) {
    verifyProductPolicyCandidate(candidate, projectId || candidate.projectId, format);
    if (document.projectId !== candidate.projectId || document.sessionId !== candidate.sessionId || document.candidateId !== candidate.candidateId
      || document.candidateHash !== candidate.candidateHash || document.previousProductModelId !== candidate.baseProductModelId
      || document.previousProductModelHash !== candidate.baseProductModelHash
      || accepting && (document.resultingProductModelId !== candidate.resultingProductModelId || document.resultingProductModelHash !== candidate.resultingProductModelHash)) {
      fail("Product Policy ReviewDecision does not match its exact candidate.", "PRODUCT_POLICY_REVIEW_SCOPE_MISMATCH");
    }
  }
  const payload = { ...document };
  delete payload.reviewDecisionId;
  delete payload.reviewDecisionHash;
  const hash = digest(productPolicyCanonicalJson(payload));
  if (hash !== document.reviewDecisionHash || document.reviewDecisionId !== `review-decision-${hash.slice(0, 24)}`) fail("Product Policy ReviewDecision digest verification failed.", "PRODUCT_POLICY_REVIEW_DIGEST_MISMATCH");
  return document;
}


function recordProject(root, storage) {
  const projectRoot = fs.realpathSync(path.resolve(root));
  const project = readJson(safeFile(projectRoot, relativeProjectArtifact(storage, "project.json")), "Project canon");
  if (project.schemaVersion !== SCHEMA_VERSION || project.projectRoot !== projectRoot || !project.projectId) fail("Project canon does not match this canonical root.", "PROJECT_IDENTITY_MISMATCH");
  return { projectRoot, projectId: project.projectId, storage };
}
export function readProductPolicyCandidateRecord({ root = ".", candidateId, storage = null } = {}) {
  const owner = recordProject(root, storage);
  const file = candidateFile(owner.projectRoot, candidateId, storage);
  if (!fs.existsSync(file)) fail(`Product Policy candidate is missing: ${candidateId}`, "PRODUCT_POLICY_CANDIDATE_NOT_FOUND");
  const candidate = verifyProductPolicyCandidate(readJson(file, "Product Policy candidate"), owner.projectId, formatForVerifiedOwner(storage));
  if (candidate.candidateId !== candidateId) fail("Product Policy candidate filename does not match its identity.", "PRODUCT_POLICY_ARTIFACT_IDENTITY_MISMATCH");
  return { status: "verified", file, candidate };
}
export function readProductPolicyReviewDecisionRecord({ root = ".", reviewDecisionId, storage = null } = {}) {
  const owner = recordProject(root, storage);
  const file = reviewFile(owner.projectRoot, reviewDecisionId, storage);
  if (!fs.existsSync(file)) fail(`Product Policy ReviewDecision is missing: ${reviewDecisionId}`, "PRODUCT_POLICY_REVIEW_NOT_FOUND");
  const review = verifyProductPolicyReviewDecision(readJson(file, "Product Policy ReviewDecision"), null, owner.projectId, formatForVerifiedOwner(storage));
  if (review.reviewDecisionId !== reviewDecisionId) fail("Product Policy ReviewDecision filename does not match its identity.", "PRODUCT_POLICY_ARTIFACT_IDENTITY_MISMATCH");
  const candidate = readProductPolicyCandidateRecord({ root: owner.projectRoot, candidateId: review.candidateId, storage }).candidate;
  return { status: "verified", file, reviewDecision: verifyProductPolicyReviewDecision(review, candidate, owner.projectId, formatForVerifiedOwner(storage)), candidate };
}
