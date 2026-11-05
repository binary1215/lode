import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { familyFormatForOriginal, formatForVerifiedOwner, relativeProjectArtifact } from "./project-storage-format.mjs";

export const FEATURE_MAPPING_VERSION = "0.2.0";
export const FEATURE_MAPPING_STATE_RELATIVE_PATH = ".head/feature-mappings/current.json";
export const FEATURE_MAPPING_CANDIDATE_DIRECTORY = ".head/feature-mappings/candidate-sets";
export const FEATURE_MAPPING_REVIEW_DIRECTORY = ".head/feature-mappings/review-decisions";

const LIMITS = Object.freeze({
  maxCandidateSets: 128,
  maxReviewDecisions: 128,
  maxCandidatesPerSet: 500,
  maxEvidencePerSet: 750,
  maxUnknownsPerSet: 100,
  maxArtifactBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
});

const fail = (message, code = "FEATURE_MAPPING_PROJECTION_ERROR") => {
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

export function featureMappingCanonicalJson(value) {
  return JSON.stringify(canonical(value));
}

export function featureMappingDigest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function verifyIdentity(document, { idField, hashField, prefix, label }) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    fail(`${label} is invalid.`, "INVALID_FEATURE_MAPPING_ARTIFACT");
  }
  const payload = { ...document };
  delete payload[idField];
  delete payload[hashField];
  const hash = featureMappingDigest(featureMappingCanonicalJson(payload));
  if (document[hashField] !== hash || document[idField] !== `${prefix}-${hash.slice(0, 24)}`) {
    fail(`${label} digest verification failed.`, "FEATURE_MAPPING_DIGEST_MISMATCH");
  }
  return document;
}

function sortedUnique(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value)) {
    fail(`${label} must be an array of non-empty strings.`, "INVALID_FEATURE_MAPPING_ARTIFACT");
  }
  const normalized = [...new Set(values)].sort();
  if (featureMappingCanonicalJson(values) !== featureMappingCanonicalJson(normalized)) {
    fail(`${label} must be sorted and unique.`, "FEATURE_MAPPING_ORDER_MISMATCH");
  }
  return normalized;
}

function verifyEndpoint(endpoint, label) {
  if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)
    || typeof endpoint.nodeId !== "string" || !endpoint.nodeId
    || typeof endpoint.kind !== "string" || !endpoint.kind
    || typeof endpoint.revisionId !== "string" || !endpoint.revisionId
    || (endpoint.continuityGeneration != null
      && (!Number.isSafeInteger(endpoint.continuityGeneration) || endpoint.continuityGeneration < 0))) {
    fail(`${label} is invalid.`, "INVALID_FEATURE_MAPPING_ENDPOINT");
  }
  return endpoint;
}

function verifyEvidence(evidence) {
  verifyIdentity(evidence, {
    idField: "evidenceId",
    hashField: "evidenceHash",
    prefix: "feature-mapping-evidence",
    label: "Feature mapping Evidence",
  });
  if (evidence.kind !== "FeatureMappingEvidence" || evidence.schemaVersion !== 1
    || typeof evidence.sourceKind !== "string" || !evidence.sourceKind
    || typeof evidence.sourceNodeId !== "string" || !evidence.sourceNodeId
    || typeof evidence.sourceRevisionId !== "string" || !evidence.sourceRevisionId
    || typeof evidence.statement !== "string" || !evidence.statement
    || evidence.instructionAuthority !== false || evidence.promotionAuthority !== false) {
    fail("Feature mapping Evidence fields or authority are invalid.", "INVALID_FEATURE_MAPPING_EVIDENCE");
  }
  return evidence;
}

function verifyCandidate(candidate, evidenceIds, storage) {
  verifyIdentity(candidate, {
    idField: "candidateId",
    hashField: "candidateHash",
    prefix: "feature-mapping-candidate",
    label: "Feature mapping candidate",
  });
  if (candidate.kind !== "FeatureMappingCandidate" || candidate.schemaVersion !== 1
    || !["IMPLEMENTS", "VERIFIED_BY"].includes(candidate.relationshipType)
    || candidate.authorityClass !== "candidate" || candidate.instructionAuthority !== false
    || candidate.promotionAuthority !== false || candidate.producer !== formatForVerifiedOwner(storage).protocol("head-agent-core-feature-mapping-proposal-normalizer")
    || candidate.producerVersion !== FEATURE_MAPPING_VERSION
    || !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1
    || typeof candidate.explanation !== "string" || !candidate.explanation || candidate.explanation.length > 2000
    || !/^source-snapshot-[a-f0-9]{24}$/.test(candidate.sourceSnapshotId || "")) {
    fail("Feature mapping candidate fields or authority are invalid.", "INVALID_FEATURE_MAPPING_CANDIDATE");
  }
  verifyEndpoint(candidate.from, "Feature mapping candidate from endpoint");
  verifyEndpoint(candidate.to, "Feature mapping candidate to endpoint");
  if (candidate.relationshipType === "IMPLEMENTS"
    && (!["File", "Symbol"].includes(candidate.from.kind) || !["Feature", "Capability"].includes(candidate.to.kind))) {
    fail("IMPLEMENTS candidates must point from File or Symbol to Feature or Capability.", "INVALID_FEATURE_MAPPING_DIRECTION");
  }
  if (candidate.relationshipType === "VERIFIED_BY"
    && (!["Feature", "Capability"].includes(candidate.from.kind) || candidate.to.kind !== "Test")) {
    fail("VERIFIED_BY candidates must point from Feature or Capability to Test.", "INVALID_FEATURE_MAPPING_DIRECTION");
  }
  sortedUnique(candidate.evidenceIds, `Candidate ${candidate.candidateId} evidenceIds`);
  for (const evidenceId of candidate.evidenceIds) if (!evidenceIds.has(evidenceId)) {
    fail(`Feature mapping candidate references unknown Evidence: ${evidenceId}`, "UNKNOWN_FEATURE_MAPPING_EVIDENCE");
  }
  return candidate;
}

export function verifyFeatureMappingCandidateSet(document, projectId = "", storage = undefined) {
  verifyIdentity(document, {
    idField: "candidateSetId",
    hashField: "candidateSetHash",
    prefix: "feature-mapping-candidates",
    label: "Feature mapping candidate set",
  });
  if (document.schemaVersion !== 1 || document.kind !== "FeatureMappingCandidateSet"
    || !familyFormatForOriginal("head-agent-core-feature-mapping-candidates", document, storage)
    || document.protocol?.version !== FEATURE_MAPPING_VERSION
    || (projectId && document.projectId !== projectId)
    || !/^world-model-[a-f0-9]{24}$/.test(document.worldModelId || "")
    || !/^graph-snapshot-[a-f0-9]{24}$/.test(document.graphSnapshotId || "")
    || !/^source-snapshot-[a-f0-9]{24}$/.test(document.sourceSnapshotId || "")
    || !/^product-model-[a-f0-9]{24}$/.test(document.productModelId || "")
    || !/^[a-f0-9]{64}$/.test(document.productModelHash || "")
    || document.authorityClass !== "candidate-set" || document.instructionAuthority !== false
    || document.promotionAuthority !== false) {
    fail("Feature mapping candidate-set fields or authority are invalid.", "INVALID_FEATURE_MAPPING_CANDIDATE_SET");
  }
  if (!Array.isArray(document.candidates) || !Array.isArray(document.evidence) || !Array.isArray(document.unknowns)
    || document.candidates.length > LIMITS.maxCandidatesPerSet
    || document.evidence.length > LIMITS.maxEvidencePerSet
    || document.unknowns.length > LIMITS.maxUnknownsPerSet) {
    fail("Feature mapping candidate set exceeds its bounded collections.", "FEATURE_MAPPING_CANDIDATE_SET_LIMIT");
  }
  const evidenceIds = new Set();
  for (const evidence of document.evidence) {
    verifyEvidence(evidence);
    if (evidenceIds.has(evidence.evidenceId)) fail("Duplicate Feature mapping Evidence.", "DUPLICATE_FEATURE_MAPPING_EVIDENCE");
    evidenceIds.add(evidence.evidenceId);
  }
  const candidateIds = new Set();
  for (const candidate of document.candidates) {
    verifyCandidate(candidate, evidenceIds, familyFormatForOriginal("head-agent-core-feature-mapping-candidates", document, storage));
    if (candidateIds.has(candidate.candidateId)) fail("Duplicate Feature mapping candidate.", "DUPLICATE_FEATURE_MAPPING_CANDIDATE");
    candidateIds.add(candidate.candidateId);
  }
  if (featureMappingCanonicalJson(document.candidates.map((item) => item.candidateId))
    !== featureMappingCanonicalJson([...candidateIds].sort())
    || featureMappingCanonicalJson(document.evidence.map((item) => item.evidenceId))
    !== featureMappingCanonicalJson([...evidenceIds].sort())) {
    fail("Feature mapping candidates and Evidence must use identity order.", "FEATURE_MAPPING_ORDER_MISMATCH");
  }
  for (const unknown of document.unknowns) {
    if (!unknown || !/^feature-mapping-unknown-[a-f0-9]{24}$/.test(unknown.unknownId || "")
      || typeof unknown.statement !== "string" || !unknown.statement || unknown.status !== "open") {
      fail("Feature mapping Unknown is invalid.", "INVALID_FEATURE_MAPPING_UNKNOWN");
    }
    sortedUnique(unknown.evidenceIds, `Unknown ${unknown.unknownId} evidenceIds`);
  }
  return document;
}

export function verifyFeatureMappingReviewDecision(document, candidateSet, projectId = "", storage = undefined) {
  verifyIdentity(document, {
    idField: "reviewDecisionId",
    hashField: "reviewDecisionHash",
    prefix: "feature-mapping-review-decision",
    label: "Feature mapping ReviewDecision",
  });
  if (document.schemaVersion !== 1 || document.kind !== "ReviewDecision"
    || !familyFormatForOriginal("head-agent-core-feature-mapping-review", document, storage ?? familyFormatForOriginal("head-agent-core-feature-mapping-candidates", candidateSet))
    || document.protocol?.version !== FEATURE_MAPPING_VERSION
    || document.decisionScope !== "feature-implementation-mapping"
    || (projectId && document.projectId !== projectId)
    || !["accept-all", "accept-selection", "reject"].includes(document.disposition)
    || document.authority !== "explicit-user-feature-mapping-review"
    || document.instructionAuthority !== true
    || document.promotionAuthority !== document.disposition.startsWith("accept")
    || typeof document.rationale !== "string" || !document.rationale) {
    fail("Feature mapping ReviewDecision fields or authority are invalid.", "INVALID_FEATURE_MAPPING_REVIEW");
  }
  if (!candidateSet || document.candidateSetId !== candidateSet.candidateSetId
    || document.sourceSnapshotId !== candidateSet.sourceSnapshotId
    || document.productModelId !== candidateSet.productModelId
    || document.productModelHash !== candidateSet.productModelHash) {
    fail("Feature mapping ReviewDecision scope does not match its candidate set.", "FEATURE_MAPPING_REVIEW_SCOPE_MISMATCH");
  }
  sortedUnique(document.acceptedCandidateIds, "acceptedCandidateIds");
  sortedUnique(document.rejectedCandidateIds, "rejectedCandidateIds");
  const known = new Set(candidateSet.candidates.map((item) => item.candidateId));
  const accepted = new Set(document.acceptedCandidateIds);
  const rejected = new Set(document.rejectedCandidateIds);
  if ([...accepted, ...rejected].some((id) => !known.has(id)) || [...accepted].some((id) => rejected.has(id))
    || accepted.size + rejected.size !== known.size) {
    fail("Feature mapping ReviewDecision candidate partition is invalid.", "INVALID_FEATURE_MAPPING_REVIEW_SELECTION");
  }
  if (document.disposition === "reject" && accepted.size !== 0) {
    fail("Rejected Feature mapping review cannot accept candidates.", "INVALID_FEATURE_MAPPING_REVIEW_SELECTION");
  }
  if (document.disposition.startsWith("accept") && accepted.size === 0) {
    fail("Accepted Feature mapping review requires at least one candidate.", "INVALID_FEATURE_MAPPING_REVIEW_SELECTION");
  }
  return document;
}

function safeDirectory(projectRoot, relative) {
  const root = path.resolve(projectRoot);
  const directory = path.resolve(root, ...relative.split("/"));
  const fromRoot = path.relative(root, directory);
  if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    fail("Feature mapping projection path escapes the project root.", "FEATURE_MAPPING_PATH_ESCAPE");
  }
  let current = root;
  for (const segment of fromRoot.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      fail("Feature mapping projection path traverses a symlink.", "FEATURE_MAPPING_SYMLINK_PATH");
    }
  }
  return directory;
}

function readArtifacts(projectRoot, relative, label, limit, storage) {
  const directory = safeDirectory(projectRoot, relativeProjectArtifact(storage, ...relative.split("/").slice(1)));
  if (!fs.existsSync(directory)) return { items: [], bytes: 0 };
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name)).sort();
  if (files.length > limit) fail(`${label} count exceeds its bound.`, "FEATURE_MAPPING_PROJECTION_LIMIT");
  const items = [];
  let bytes = 0;
  for (const file of files) {
    const size = fs.statSync(file).size;
    if (size > LIMITS.maxArtifactBytes) fail(`${label} artifact is too large.`, "FEATURE_MAPPING_PROJECTION_LIMIT");
    bytes += size;
    if (bytes > LIMITS.maxTotalBytes) fail(`${label} artifacts exceed their total bound.`, "FEATURE_MAPPING_PROJECTION_LIMIT");
    try { items.push(JSON.parse(fs.readFileSync(file, "utf8"))); }
    catch (error) { fail(`${label} artifact is invalid JSON: ${error.message}`, "INVALID_FEATURE_MAPPING_ARTIFACT"); }
  }
  return { items, bytes };
}

export function verifyFeatureMappingProjectionInput(projection, storage = undefined) {
  if (!projection || projection.kind !== "FeatureMappingProjectionInput"
    || !familyFormatForOriginal("head-agent-core-feature-mapping-projection", projection, storage)
    || projection.protocol?.version !== FEATURE_MAPPING_VERSION
    || !Array.isArray(projection.candidateSets) || !Array.isArray(projection.reviewDecisions)) {
    fail("Feature mapping projection input is invalid.", "INVALID_FEATURE_MAPPING_PROJECTION");
  }
  const candidateById = new Map();
  for (const candidateSet of projection.candidateSets) {
    verifyFeatureMappingCandidateSet(candidateSet, projection.projectId, familyFormatForOriginal("head-agent-core-feature-mapping-projection", projection, storage));
    if (candidateById.has(candidateSet.candidateSetId)) fail("Duplicate Feature mapping candidate set.", "DUPLICATE_FEATURE_MAPPING_CANDIDATE_SET");
    candidateById.set(candidateSet.candidateSetId, candidateSet);
  }
  const reviewIds = new Set();
  for (const review of projection.reviewDecisions) {
    const candidateSet = candidateById.get(review.candidateSetId);
    if (!candidateSet) fail("Feature mapping review references an unknown candidate set.", "UNKNOWN_FEATURE_MAPPING_CANDIDATE_SET");
    verifyFeatureMappingReviewDecision(review, candidateSet, projection.projectId, familyFormatForOriginal("head-agent-core-feature-mapping-projection", projection, storage));
    if (reviewIds.has(review.reviewDecisionId)) fail("Duplicate Feature mapping ReviewDecision.", "DUPLICATE_FEATURE_MAPPING_REVIEW");
    reviewIds.add(review.reviewDecisionId);
  }
  const payload = { ...projection };
  delete payload.projectionInputId;
  delete payload.projectionInputHash;
  const hash = featureMappingDigest(featureMappingCanonicalJson(payload));
  if (projection.projectionInputHash !== hash || projection.projectionInputId !== `feature-mapping-projection-${hash.slice(0, 24)}`) {
    fail("Feature mapping projection digest verification failed.", "FEATURE_MAPPING_PROJECTION_DIGEST_MISMATCH");
  }
  return projection;
}

export function loadFeatureMappingProjection({
  projectRoot,
  projectId,
  currentProductModelId,
  storage,
  additionalCandidateSets = [],
  additionalReviewDecisions = [],
} = {}) {
  const candidateFiles = readArtifacts(projectRoot, FEATURE_MAPPING_CANDIDATE_DIRECTORY, "Feature mapping candidate set", LIMITS.maxCandidateSets, storage);
  const reviewFiles = readArtifacts(projectRoot, FEATURE_MAPPING_REVIEW_DIRECTORY, "Feature mapping ReviewDecision", LIMITS.maxReviewDecisions, storage);
  const candidates = new Map();
  for (const candidateSet of [...candidateFiles.items, ...additionalCandidateSets]) {
    verifyFeatureMappingCandidateSet(candidateSet, projectId, storage);
    const existing = candidates.get(candidateSet.candidateSetId);
    if (existing && featureMappingCanonicalJson(existing) !== featureMappingCanonicalJson(candidateSet)) {
      fail("Feature mapping candidate-set identity collision.", "FEATURE_MAPPING_IMMUTABLE_COLLISION");
    }
    candidates.set(candidateSet.candidateSetId, candidateSet);
  }
  const reviews = new Map();
  for (const review of [...reviewFiles.items, ...additionalReviewDecisions]) {
    const candidateSet = candidates.get(review.candidateSetId);
    if (!candidateSet) fail("Feature mapping review references an unknown candidate set.", "UNKNOWN_FEATURE_MAPPING_CANDIDATE_SET");
    verifyFeatureMappingReviewDecision(review, candidateSet, projectId, storage);
    const existing = reviews.get(review.reviewDecisionId);
    if (existing && featureMappingCanonicalJson(existing) !== featureMappingCanonicalJson(review)) {
      fail("Feature mapping ReviewDecision identity collision.", "FEATURE_MAPPING_IMMUTABLE_COLLISION");
    }
    reviews.set(review.reviewDecisionId, review);
  }
  const payload = {
    schemaVersion: 1,
    kind: "FeatureMappingProjectionInput",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-feature-mapping-projection"), version: FEATURE_MAPPING_VERSION },
    projectId,
    currentProductModelId,
    candidateSets: [...candidates.values()].sort((left, right) => left.candidateSetId.localeCompare(right.candidateSetId)),
    reviewDecisions: [...reviews.values()].sort((left, right) => left.reviewDecisionId.localeCompare(right.reviewDecisionId)),
    authority: "derived-projection-input-not-project-canon",
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const hash = featureMappingDigest(featureMappingCanonicalJson(payload));
  return verifyFeatureMappingProjectionInput({
    ...payload,
    projectionInputId: `feature-mapping-projection-${hash.slice(0, 24)}`,
    projectionInputHash: hash,
  }, storage);
}
