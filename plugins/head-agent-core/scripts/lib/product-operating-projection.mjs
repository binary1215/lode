import { formatForVerifiedOwner, familyFormatForOriginal, relativeProjectArtifact } from "./project-storage-format.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SCHEMA_VERSION } from "./lode-core.mjs";
import { loadObservationArtifacts } from "./observation-store.mjs";

// Read/projection responsibility shared by World, Temporal and the mutation facade.
// This loader reads originals; it does not publish, repair or refresh them.
export const PRODUCT_OPERATING_LOOP_VERSION = "0.4.0";
export const PRODUCT_HYPOTHESIS_VERSION = "0.5.0";
export const PRODUCT_SIGNAL_DIRECTORY = ".head/product-operations/signals";
export const PRODUCT_HYPOTHESIS_DIRECTORY = ".head/product-operations/hypotheses";
export const PRODUCT_INITIATIVE_CANDIDATE_DIRECTORY = ".head/product-operations/initiative-candidates";
export const PRODUCT_INITIATIVE_REVIEW_DIRECTORY = ".head/product-operations/initiative-reviews";
// Historical outputs are read in place. New reviewed outputs are views of the
// exact decision, so publishing one approval needs only one durable record.
export const REVIEWED_PRODUCT_INITIATIVE_DIRECTORY = ".head/product-operations/reviewed-initiatives";
export const PRODUCT_FEATURE_CANDIDATE_DIRECTORY = ".head/product-operations/feature-candidates";
export const OUTCOME_OBSERVATION_DIRECTORY = ".head/product-operations/outcome-observations";

export const DIRECTORIES = Object.freeze({
  signals: PRODUCT_SIGNAL_DIRECTORY,
  hypotheses: PRODUCT_HYPOTHESIS_DIRECTORY,
  initiativeCandidates: PRODUCT_INITIATIVE_CANDIDATE_DIRECTORY,
  initiativeReviews: PRODUCT_INITIATIVE_REVIEW_DIRECTORY,
  reviewedInitiatives: REVIEWED_PRODUCT_INITIATIVE_DIRECTORY,
  featureCandidates: PRODUCT_FEATURE_CANDIDATE_DIRECTORY,
  outcomeObservations: OUTCOME_OBSERVATION_DIRECTORY,
});

export const LIMITS = Object.freeze({ maxArtifacts: 512, maxArtifactBytes: 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024 });
const LEGACY_PROTOCOL_VERSIONS = new Set(["0.1.0", "0.2.0", "0.3.0"]);
const OBSERVATION_REFERENCE_PROTOCOL_VERSIONS = new Set(["0.3.0", PRODUCT_OPERATING_LOOP_VERSION, PRODUCT_HYPOTHESIS_VERSION]);

export const fail = (message, code = "PRODUCT_OPERATING_LOOP_ERROR") => { const error = new Error(message); error.code = code; throw error; };

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function productOperatingCanonicalJson(value) { return JSON.stringify(canonical(value)); }
export function productOperatingDigest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

function supportedProtocolVersion(value) {
  return value === PRODUCT_OPERATING_LOOP_VERSION || LEGACY_PROTOCOL_VERSIONS.has(value);
}

export function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is required.`, "INVALID_PRODUCT_OPERATING_INPUT");
  return value.trim();
}

export function sortedIds(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim())) fail(`${label} must be an array of identities.`, "INVALID_PRODUCT_OPERATING_INPUT");
  return [...new Set(values.map((value) => value.trim()))].sort();
}

export function safeDirectory(projectRoot, relative) {
  const root = path.resolve(projectRoot);
  const directory = path.resolve(root, ...relative.split("/"));
  const fromRoot = path.relative(root, directory);
  if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) fail("Product operating path escapes project root.", "PRODUCT_OPERATING_PATH_ESCAPE");
  let current = root;
  for (const segment of fromRoot.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail("Product operating path traverses a symlink.", "PRODUCT_OPERATING_SYMLINK_PATH");
  }
  return directory;
}

export function artifact(payload, prefix, idField, hashField) {
  const hash = productOperatingDigest(productOperatingCanonicalJson(payload));
  return { ...payload, [idField]: `${prefix}-${hash.slice(0, 24)}`, [hashField]: hash };
}

function verifyIdentity(document, prefix, idField, hashField, label) {
  if (!document || typeof document !== "object" || Array.isArray(document)) fail(`${label} is invalid.`, "INVALID_PRODUCT_OPERATING_ARTIFACT");
  const payload = { ...document }; delete payload[idField]; delete payload[hashField];
  const hash = productOperatingDigest(productOperatingCanonicalJson(payload));
  if (document[hashField] !== hash || document[idField] !== `${prefix}-${hash.slice(0, 24)}`) fail(`${label} digest verification failed.`, "PRODUCT_OPERATING_DIGEST_MISMATCH");
  return document;
}

function commonValid(document, kind, projectId, epistemicClass, authority, storage) {
  const format = familyFormatForOriginal("head-agent-core-product-operating-loop", document, storage);
  return document.schemaVersion === SCHEMA_VERSION && document.kind === kind
    && Boolean(format) && (supportedProtocolVersion(document.protocol?.version) || (kind === "ProductHypothesis" && document.protocol?.version === PRODUCT_HYPOTHESIS_VERSION))
    && (!projectId || document.projectId === projectId) && document.epistemicClass === epistemicClass
    && document.authority === authority && document.instructionAuthority === false && document.promotionAuthority === false;
}

export function verifyProductSignal(document, projectId = "", storage = undefined) {
  verifyIdentity(document, "product-signal", "signalId", "signalHash", "ProductSignal");
  if (!commonValid(document, "ProductSignal", projectId, "observed-fact", "non-authoritative-observation", storage)
    || typeof document.statement !== "string" || !document.statement || typeof document.observedAt !== "string" || Number.isNaN(Date.parse(document.observedAt))) fail("ProductSignal fields are invalid.", "INVALID_PRODUCT_SIGNAL");
  sortedIds(document.evidenceIds, "ProductSignal evidenceIds");
  return document;
}

export function verifyProductHypothesis(document, projectId = "", storage = undefined) {
  verifyIdentity(document, "product-hypothesis", "hypothesisId", "hypothesisHash", "ProductHypothesis");
  const signalIds = sortedIds(document.signalIds || [], "ProductHypothesis signalIds");
  const observationIds = sortedIds(document.observationIds || [], "ProductHypothesis observationIds");
  if (!commonValid(document, "ProductHypothesis", projectId, "hypothesis", "non-authoritative-hypothesis", storage)
    || typeof document.statement !== "string" || !document.statement || !signalIds.length && !observationIds.length
    || observationIds.some((id) => !/^(?:observation|derived-observation)-[a-f0-9]{24}$/.test(id))) fail("ProductHypothesis fields are invalid.", "INVALID_PRODUCT_HYPOTHESIS");
  if (!OBSERVATION_REFERENCE_PROTOCOL_VERSIONS.has(document.protocol.version) && document.observationIds != null) fail("Legacy ProductHypothesis may not gain Observation references.", "INVALID_PRODUCT_HYPOTHESIS");
  if (document.protocol.version === PRODUCT_HYPOTHESIS_VERSION ? document.referenceSemantics !== "neutral" : Object.hasOwn(document, "referenceSemantics")) fail("ProductHypothesis reference semantics are invalid.", "INVALID_PRODUCT_HYPOTHESIS");
  return document;
}

function verifyFeatureResolution(resolution) {
  if (!resolution || typeof resolution !== "object" || !["existing-feature", "candidate", "gap"].includes(resolution.kind)) fail("Feature resolution is invalid.", "INVALID_FEATURE_RESOLUTION");
  if (resolution.kind === "existing-feature" && (!resolution.featureKey || !resolution.productModelId)) fail("Existing Feature resolution is incomplete.", "INVALID_FEATURE_RESOLUTION");
  if (resolution.kind === "candidate" && !/^product-feature-candidate-[a-f0-9]{24}$/.test(resolution.featureCandidateId || "")) fail("Feature candidate resolution is incomplete.", "INVALID_FEATURE_RESOLUTION");
  if (resolution.kind === "gap" && !resolution.reason) fail("Feature gap requires a reason.", "INVALID_FEATURE_RESOLUTION");
  return resolution;
}

export function verifyProductFeatureCandidate(document, projectId = "", storage = undefined) {
  verifyIdentity(document, "product-feature-candidate", "featureCandidateId", "featureCandidateHash", "ProductFeatureCandidate");
  if (!commonValid(document, "ProductFeatureCandidate", projectId, "inferred-meaning", "candidate-not-product-canon", storage)
    || !/^[a-f0-9]{64}$/.test(document.initiativeCandidateSeed || "") || !document.feature?.key || !document.feature?.name) fail("ProductFeatureCandidate fields are invalid.", "INVALID_PRODUCT_FEATURE_CANDIDATE");
  sortedIds(document.feature.capabilityKeys, "Feature candidate capabilityKeys");
  return document;
}

export function verifyProductInitiativeCandidate(document, projectId = "", storage = undefined) {
  verifyIdentity(document, "product-initiative-candidate", "initiativeCandidateId", "initiativeCandidateHash", "ProductInitiativeCandidate");
  if (!commonValid(document, "ProductInitiativeCandidate", projectId, "inferred-meaning", "candidate-not-approved-decision", storage)
    || !document.title || !Array.isArray(document.hypothesisIds)
    || (!document.hypothesisIds.length && !(typeof document.reasoning === "string" && document.reasoning))) fail("ProductInitiativeCandidate fields are invalid.", "INVALID_PRODUCT_INITIATIVE_CANDIDATE");
  sortedIds(document.hypothesisIds, "Initiative hypothesisIds");
  if (document.featureResolution != null) verifyFeatureResolution(document.featureResolution);
  return document;
}

export function verifyProductInitiativeReviewDecision(document, projectId = "", storage = undefined) {
  verifyIdentity(document, "product-initiative-review", "reviewDecisionId", "reviewDecisionHash", "Product Initiative ReviewDecision");
  if (document.schemaVersion !== SCHEMA_VERSION || document.kind !== "ReviewDecision" || !familyFormatForOriginal("head-agent-core-product-initiative-review", document, storage)
    || !supportedProtocolVersion(document.protocol?.version) || (!projectId || document.projectId === projectId) === false
    || document.decisionScope !== "product-initiative" || !["accept", "reject"].includes(document.disposition) || !document.rationale
    || document.authority !== "explicit-user-product-initiative-review" || document.instructionAuthority !== true
    || document.promotionAuthority !== (document.disposition === "accept")) fail("Product Initiative ReviewDecision fields are invalid.", "INVALID_PRODUCT_INITIATIVE_REVIEW");
  if (document.protocol.version === PRODUCT_OPERATING_LOOP_VERSION) {
    if (!/^[a-f0-9]{64}$/.test(document.initiativeCandidateHash || "")
      || !Object.hasOwn(document, "featureResolution") || !Object.hasOwn(document, "featureCandidate")) fail("Current Product Initiative ReviewDecision lacks its exact reviewed Feature selection.", "INVALID_PRODUCT_INITIATIVE_REVIEW");
    if (document.disposition === "reject") {
      if (document.featureResolution !== null || document.featureCandidate !== null) fail("Rejected Product Initiative ReviewDecision cannot bind a Feature resolution.", "INVALID_PRODUCT_INITIATIVE_REVIEW");
    } else {
      verifyFeatureResolution(document.featureResolution);
      if (document.featureResolution.kind === "candidate") {
        if (!document.featureCandidate || verifyProductFeatureCandidate(document.featureCandidate, projectId, familyFormatForOriginal("head-agent-core-product-initiative-review", document, storage)).featureCandidateId !== document.featureResolution.featureCandidateId) fail("Product Initiative ReviewDecision Feature candidate binding is invalid.", "INVALID_PRODUCT_INITIATIVE_REVIEW");
      } else if (document.featureCandidate !== null) fail("Product Initiative ReviewDecision embeds an unrelated Feature candidate.", "INVALID_PRODUCT_INITIATIVE_REVIEW");
    }
  }
  return document;
}

export function verifyReviewedProductInitiative(document, projectId = "", storage = undefined) {
  verifyIdentity(document, "reviewed-product-initiative", "initiativeId", "initiativeHash", "ReviewedProductInitiative");
  if (!commonValid(document, "ReviewedProductInitiative", projectId, "approved-decision", "reviewed-product-initiative-not-product-canon", storage)
    || !document.initiativeCandidateId || !document.reviewDecisionId || !document.title || !Array.isArray(document.hypothesisIds)) fail("ReviewedProductInitiative fields are invalid.", "INVALID_REVIEWED_PRODUCT_INITIATIVE");
  verifyFeatureResolution(document.featureResolution);
  return document;
}

export function verifyOutcomeObservation(document, projectId = "", storage = undefined) {
  verifyIdentity(document, "outcome-observation", "outcomeObservationId", "outcomeObservationHash", "OutcomeObservation");
  if (!commonValid(document, "OutcomeObservation", projectId, document.epistemicClass, "non-authoritative-outcome-evidence", storage)
    || !["observed-fact", "derived-projection"].includes(document.epistemicClass) || !document.statement
    || !document.changeSetId || !document.resultPacketId || !document.executionReviewDecisionId) fail("OutcomeObservation fields are invalid.", "INVALID_OUTCOME_OBSERVATION");
  sortedIds(document.evidenceIds, "OutcomeObservation evidenceIds");
  return document;
}

function readArtifacts(projectRoot, relative, limit = LIMITS.maxArtifacts, storage = null) {
  const directory = safeDirectory(projectRoot, relativeProjectArtifact(storage, ...relative.split("/").slice(1)));
  if (!fs.existsSync(directory)) return [];
  const files = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => path.join(directory, entry.name)).sort();
  if (files.length > limit) fail("Product operating artifact count exceeds its bound.", "PRODUCT_OPERATING_LIMIT");
  let bytes = 0;
  return files.map((file) => {
    const size = fs.statSync(file).size; bytes += size;
    if (size > LIMITS.maxArtifactBytes || bytes > LIMITS.maxTotalBytes) fail("Product operating artifacts exceed their byte bound.", "PRODUCT_OPERATING_LIMIT");
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { fail(`Product operating artifact is invalid JSON: ${error.message}`, "INVALID_PRODUCT_OPERATING_ARTIFACT"); }
  });
}

export function verifyProductOperatingProjectionInput(projection, storage = undefined) {
  if (!projection || projection.kind !== "ProductOperatingProjectionInput"
    || !familyFormatForOriginal("head-agent-core-product-operating-projection", projection, storage)
    || !supportedProtocolVersion(projection.protocol?.version)
    || typeof projection.projectId !== "string" || !projection.projectId
    || projection.authority !== "derived-product-graph-input-not-product-or-execution-canon"
    || projection.instructionAuthority !== false || projection.promotionAuthority !== false) {
    fail("Product operating projection input is invalid.", "INVALID_PRODUCT_OPERATING_PROJECTION");
  }
  const format = familyFormatForOriginal("head-agent-core-product-operating-projection", projection, storage);
  for (const field of Object.keys(DIRECTORIES)) {
    if (!Array.isArray(projection[field])) fail(`Product operating projection ${field} is invalid.`, "INVALID_PRODUCT_OPERATING_PROJECTION");
    const family = field === "initiativeReviews" ? "head-agent-core-product-initiative-review" : "head-agent-core-product-operating-loop";
    if (projection[field].some(record => !familyFormatForOriginal(family, record, format))) fail(`Product operating projection ${field} is invalid.`, "INVALID_PRODUCT_OPERATING_PROJECTION");
  }
  const payload = { ...projection }; delete payload.projectionInputId; delete payload.projectionInputHash;
  const hash = productOperatingDigest(productOperatingCanonicalJson(payload));
  if (projection.projectionInputHash !== hash || projection.projectionInputId !== `product-operating-projection-${hash.slice(0, 24)}`) {
    fail("Product operating projection digest verification failed.", "PRODUCT_OPERATING_PROJECTION_DIGEST_MISMATCH");
  }
  return projection;
}

export function loadProductOperatingProjection({ projectRoot, projectId, storage = null } = {}) {
  const format = formatForVerifiedOwner(storage);
  const arrays = Object.fromEntries(Object.entries(DIRECTORIES).map(([key, relative]) => [key, readArtifacts(projectRoot, relative, LIMITS.maxArtifacts, storage)]));
  const validators = {
    signals: verifyProductSignal, hypotheses: verifyProductHypothesis, initiativeCandidates: verifyProductInitiativeCandidate,
    initiativeReviews: verifyProductInitiativeReviewDecision, reviewedInitiatives: verifyReviewedProductInitiative,
    featureCandidates: verifyProductFeatureCandidate, outcomeObservations: verifyOutcomeObservation,
  };
  for (const [key, values] of Object.entries(arrays)) for (const value of values) validators[key](value, projectId, format);
  for (const review of arrays.initiativeReviews) {
    if (review.featureCandidate && !arrays.featureCandidates.some((item) => item.featureCandidateId === review.featureCandidate.featureCandidateId)) arrays.featureCandidates.push(review.featureCandidate);
    if (review.disposition !== "accept" || arrays.reviewedInitiatives.some((item) => item.reviewDecisionId === review.reviewDecisionId)) continue;
    const candidate = arrays.initiativeCandidates.find((item) => item.initiativeCandidateId === review.initiativeCandidateId);
    const resolution = review.featureResolution ?? candidate?.featureResolution;
    // Old decisions without a frozen selection remain readable and unresolved.
    if (candidate && resolution) arrays.reviewedInitiatives.push(buildReviewedInitiative(candidate, { ...review, featureResolution: resolution }, format));
  }
  const by = (values, field) => new Map(values.map((value) => [value[field], value]));
  const signals = by(arrays.signals, "signalId");
  const hypotheses = by(arrays.hypotheses, "hypothesisId");
  const initiatives = by(arrays.initiativeCandidates, "initiativeCandidateId");
  const featureCandidates = by(arrays.featureCandidates, "featureCandidateId");
  const reviews = by(arrays.initiativeReviews, "reviewDecisionId");
  const reviewedInitiatives = by(arrays.reviewedInitiatives, "initiativeId");
  const referencedObservationIds = new Set(arrays.hypotheses.flatMap((hypothesis) => hypothesis.observationIds || []));
  const observationIds = new Set();
  if (referencedObservationIds.size) {
    const observationArtifacts = loadObservationArtifacts({ projectRoot, projectId, storage });
    for (const item of observationArtifacts.observations) observationIds.add(item.observationId);
    for (const item of observationArtifacts.derivedObservations) observationIds.add(item.derivedObservationId);
  }
  const changes = new Map(readArtifacts(projectRoot, ".head/change-sets/records", LIMITS.maxArtifacts, storage).map((value) => [value.changeSetId, value]));
  for (const hypothesis of arrays.hypotheses) if (hypothesis.signalIds.some((id) => !signals.has(id))) fail("ProductHypothesis references an unknown ProductSignal.", "UNKNOWN_PRODUCT_SIGNAL");
  for (const hypothesis of arrays.hypotheses) if ((hypothesis.observationIds || []).some((id) => !observationIds.has(id))) fail("ProductHypothesis references an unknown Observation.", "UNKNOWN_OBSERVATION");
  for (const initiative of arrays.initiativeCandidates) {
    if (initiative.hypothesisIds.some((id) => !hypotheses.has(id))) fail("ProductInitiativeCandidate references an unknown ProductHypothesis.", "UNKNOWN_PRODUCT_HYPOTHESIS");
    if (initiative.featureResolution?.kind === "candidate") {
      const featureCandidate = featureCandidates.get(initiative.featureResolution.featureCandidateId);
      if (!featureCandidate) fail("ProductInitiativeCandidate references an unknown ProductFeatureCandidate.", "UNKNOWN_PRODUCT_FEATURE_CANDIDATE");
      const expectedSeed = initiativeSeed(initiative);
      if (featureCandidate.initiativeCandidateSeed !== expectedSeed) fail("ProductFeatureCandidate seed does not match its ProductInitiativeCandidate.", "PRODUCT_FEATURE_CANDIDATE_SEED_MISMATCH");
    }
  }
  const reviewedCandidateIds = new Set();
  for (const review of arrays.initiativeReviews) {
    const candidate = initiatives.get(review.initiativeCandidateId);
    if (!candidate) fail("Product Initiative review references an unknown candidate.", "UNKNOWN_PRODUCT_INITIATIVE_CANDIDATE");
    if (reviewedCandidateIds.has(review.initiativeCandidateId)) fail("Product Initiative candidate has conflicting ReviewDecisions.", "PRODUCT_INITIATIVE_ALREADY_REVIEWED");
    verifyReviewDecisionCandidateLineage(review, candidate);
    reviewedCandidateIds.add(review.initiativeCandidateId);
  }
  for (const reviewed of arrays.reviewedInitiatives) {
    const review = reviews.get(reviewed.reviewDecisionId);
    if (!review || review.disposition !== "accept" || review.initiativeCandidateId !== reviewed.initiativeCandidateId) fail("ReviewedProductInitiative lacks its accepting ReviewDecision.", "INVALID_REVIEWED_PRODUCT_INITIATIVE_LINEAGE");
    const candidate = initiatives.get(reviewed.initiativeCandidateId);
    const reviewedMeaning = { title: reviewed.title, description: reviewed.description, reasoning: reviewed.reasoning || "", hypothesisIds: reviewed.hypothesisIds };
    const candidateMeaning = { title: candidate?.title, description: candidate?.description, reasoning: candidate?.reasoning || "", hypothesisIds: candidate?.hypothesisIds };
    if (!candidate || productOperatingCanonicalJson(reviewedMeaning) !== productOperatingCanonicalJson(candidateMeaning)
      || (candidate.featureResolution != null && productOperatingCanonicalJson(reviewed.featureResolution) !== productOperatingCanonicalJson(candidate.featureResolution))
      || (review.protocol.version === PRODUCT_OPERATING_LOOP_VERSION && productOperatingCanonicalJson(reviewed.featureResolution) !== productOperatingCanonicalJson(review.featureResolution))) {
      fail("ReviewedProductInitiative rewrites its immutable candidate.", "REVIEWED_PRODUCT_INITIATIVE_CANDIDATE_MISMATCH");
    }
    if (reviewed.featureResolution.kind === "candidate") {
      const featureCandidate = featureCandidates.get(reviewed.featureResolution.featureCandidateId);
      if (!featureCandidate) fail("ReviewedProductInitiative references an unknown ProductFeatureCandidate.", "UNKNOWN_PRODUCT_FEATURE_CANDIDATE");
      const expectedSeed = initiativeSeed(candidate);
      if (featureCandidate.initiativeCandidateSeed !== expectedSeed) fail("Reviewed ProductFeatureCandidate seed does not match its ProductInitiativeCandidate.", "PRODUCT_FEATURE_CANDIDATE_SEED_MISMATCH");
    }
  }
  for (const outcome of arrays.outcomeObservations) {
    const changeSet = changes.get(outcome.changeSetId);
    if (!changeSet) fail("OutcomeObservation references an unknown ChangeSet.", "UNKNOWN_CHANGE_SET");
    if (outcome.resultPacketId !== changeSet.resultPacketId || outcome.executionReviewDecisionId !== changeSet.reviewDecisionId) fail("OutcomeObservation does not match its ChangeSet execution lineage.", "OUTCOME_CHANGE_SET_LINEAGE_MISMATCH");
    if (outcome.initiativeId && !reviewedInitiatives.has(outcome.initiativeId)) fail("OutcomeObservation references an unknown ReviewedProductInitiative.", "UNKNOWN_REVIEWED_PRODUCT_INITIATIVE");
  }
  const idFields = { signals: "signalId", hypotheses: "hypothesisId", initiativeCandidates: "initiativeCandidateId", initiativeReviews: "reviewDecisionId", reviewedInitiatives: "initiativeId", featureCandidates: "featureCandidateId", outcomeObservations: "outcomeObservationId" };
  const payload = {
    schemaVersion: SCHEMA_VERSION, kind: "ProductOperatingProjectionInput",
    protocol: { name: format.protocol("head-agent-core-product-operating-projection"), version: PRODUCT_OPERATING_LOOP_VERSION },
    projectId, ...Object.fromEntries(Object.entries(arrays).map(([key, values]) => [key, values.sort((a, b) => a[idFields[key]].localeCompare(b[idFields[key]]))])),
    authority: "derived-product-graph-input-not-product-or-execution-canon", instructionAuthority: false, promotionAuthority: false,
  };
  const projectionInputHash = productOperatingDigest(productOperatingCanonicalJson(payload));
  return verifyProductOperatingProjectionInput({ ...payload, projectionInputId: `product-operating-projection-${projectionInputHash.slice(0, 24)}`, projectionInputHash }, format);
}

export function initiativeSeed(candidate) {
  const seedInput = { projectId: candidate.projectId, title: candidate.title, description: candidate.description, hypothesisIds: candidate.hypothesisIds };
  if (candidate.protocol?.version !== "0.1.0") seedInput.reasoning = candidate.reasoning || "";
  return productOperatingDigest(productOperatingCanonicalJson(seedInput));
}

export function verifyReviewDecisionCandidateLineage(reviewDecision, candidate) {
  const format = familyFormatForOriginal("head-agent-core-product-initiative-review", reviewDecision);
  if (!format || !familyFormatForOriginal("head-agent-core-product-operating-loop", candidate, format)) fail("Product Initiative ReviewDecision candidate binding is stale or invalid.", "INVALID_PRODUCT_INITIATIVE_REVIEW_LINEAGE");
  if (reviewDecision.protocol.version !== PRODUCT_OPERATING_LOOP_VERSION) return;
  if (reviewDecision.initiativeCandidateHash !== candidate.initiativeCandidateHash) fail("Product Initiative ReviewDecision candidate binding is stale or invalid.", "INVALID_PRODUCT_INITIATIVE_REVIEW_LINEAGE");
  if (reviewDecision.disposition === "accept" && candidate.featureResolution != null && productOperatingCanonicalJson(reviewDecision.featureResolution) !== productOperatingCanonicalJson(candidate.featureResolution)) fail("Product Initiative ReviewDecision replaces the candidate's frozen Feature resolution.", "INVALID_PRODUCT_INITIATIVE_REVIEW_LINEAGE");
  if (reviewDecision.featureCandidate && reviewDecision.featureCandidate.initiativeCandidateSeed !== initiativeSeed(candidate)) fail("Product Initiative ReviewDecision Feature candidate seed is invalid.", "INVALID_PRODUCT_INITIATIVE_REVIEW_LINEAGE");
}

export function buildReviewedInitiative(candidate, reviewDecision, storage = null) {
  const approved = { schemaVersion: SCHEMA_VERSION, kind: "ReviewedProductInitiative", protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-product-operating-loop"), version: PRODUCT_OPERATING_LOOP_VERSION }, projectId: candidate.projectId, initiativeCandidateId: candidate.initiativeCandidateId, reviewDecisionId: reviewDecision.reviewDecisionId, title: candidate.title, description: candidate.description, reasoning: candidate.reasoning || "", hypothesisIds: candidate.hypothesisIds, featureResolution: reviewDecision.featureResolution, epistemicClass: "approved-decision", authority: "reviewed-product-initiative-not-product-canon", instructionAuthority: false, promotionAuthority: false };
  return verifyReviewedProductInitiative(artifact(approved, "reviewed-product-initiative", "initiativeId", "initiativeHash"), candidate.projectId, formatForVerifiedOwner(storage));
}
