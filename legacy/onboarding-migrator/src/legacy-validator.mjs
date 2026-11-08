import fs from "node:fs";
import path from "node:path";
import { inspectProject } from "../../../scripts/lib/head-core.mjs";
import {
  ONBOARDING_CANDIDATE_DIRECTORY,
  ONBOARDING_PRODUCT_REVISION_DIRECTORY,
  ONBOARDING_REVIEW_DIRECTORY,
  ONBOARDING_STATE_PROTOCOL_VERSION,
  ONBOARDING_STATE_RELATIVE_PATH,
  onboardingCanonicalJson,
  onboardingDigest,
  verifyOnboardingState,
} from "../../../scripts/lib/onboarding-contract.mjs";
import {
  verifyOnboardingCandidateSetForProjection,
  verifyOnboardingReviewDecisionForProjection,
  verifyProductModelRevisionForProjection,
} from "../../../scripts/lib/onboarding-projection.mjs";
import { normalizeProductModelDocument, PRODUCT_ENTITY_KINDS_V1, readProductModelCanon } from "../../../scripts/lib/product-model.mjs";
import { createVerifiedHistoricalInventoryCapability } from "../../../scripts/lib/historical-artifact-boundary.mjs";
import { historicalBoundaryDigest } from "../../../scripts/lib/historical-artifact-boundary-store.mjs";

const LEGACY_LIMITS = Object.freeze({ maxInferredSymbols: 24, maxCandidates: 200, maxEvidenceRecords: 250, maxUnknowns: 100 });
const FAMILIES = Object.freeze({
  "0.1.0": { worldModel: "required", reviewField: "reviewDecisionId" },
  "0.2.0": { worldModel: "absent", reviewField: "reviewDecisionId" },
  "0.3.0": { worldModel: "absent", reviewField: "producerReviewDecisionId" },
});
const MAX_FILES = 512;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;
const KIND_ORDER = new Map(PRODUCT_ENTITY_KINDS_V1.map((kind, index) => [kind, index]));

function fail(message, code = "LEGACY_ONBOARDING_MIGRATOR_ERROR") {
  throw Object.assign(new Error(message), { code });
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${label} is invalid JSON: ${error.message}`, "LEGACY_MIGRATOR_INVALID_JSON");
  }
}

function contentIdentity(document, idField, hashField, prefix, label) {
  const payload = { ...document };
  delete payload[idField];
  delete payload[hashField];
  const hash = onboardingDigest(onboardingCanonicalJson(payload));
  if (document[hashField] !== hash || document[idField] !== `${prefix}-${hash.slice(0, 24)}`)
    fail(`${label} digest is invalid.`, "LEGACY_MIGRATOR_DIGEST_MISMATCH");
}

function sortedUnique(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value)) fail(`${label} is invalid.`, "LEGACY_MIGRATOR_CANDIDATE_INVALID");
  const sorted = [...new Set(values)].sort();
  if (onboardingCanonicalJson(values) !== onboardingCanonicalJson(sorted)) fail(`${label} must be sorted and unique.`, "LEGACY_MIGRATOR_CANDIDATE_INVALID");
  return sorted;
}

function readArtifact(file, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    fail(`${label} is missing or unsafe.`, "LEGACY_MIGRATOR_ARTIFACT_MISSING");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_ENTRY_BYTES) {
    fail(`${label} is missing, unsafe, or exceeds its byte bound.`, stat.size > MAX_ENTRY_BYTES ? "LEGACY_MIGRATOR_LIMIT" : "LEGACY_MIGRATOR_ARTIFACT_MISSING");
  }
  const bytes = fs.readFileSync(file);
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`${label} is invalid JSON: ${error.message}`, "LEGACY_MIGRATOR_INVALID_JSON");
  }
  return { document, bytes };
}

function entry(relative, role, artifactId, protocolFamily, protocolVersion, bytes, interpretationMode = "opaque-historical") {
  return {
    path: relative,
    role,
    artifactId,
    protocolFamily,
    protocolVersion,
    byteLength: bytes.byteLength,
    sha256: historicalBoundaryDigest(bytes),
    interpretationMode,
  };
}

function verifyCandidateSet(candidate, projectId) {
  contentIdentity(candidate, "candidateSetId", "candidateSetHash", "onboarding-candidates", "Legacy candidate set");
  const version = candidate.protocol?.name === "head-agent-core-onboarding-candidates" ? candidate.protocol.version : "";
  const family = FAMILIES[version];
  if (
    !family ||
    candidate.projectId !== projectId ||
    candidate.schemaVersion !== 1 ||
    candidate.kind !== "OnboardingCandidateSet" ||
    !/^head-[a-f0-9]{20}$/.test(candidate.projectId || "") ||
    !/^session-[A-Fa-f0-9-]{36}$/.test(candidate.sessionId || "") ||
    !["existing", "new"].includes(candidate.inputMode) ||
    !/^onboarding-storage-[a-f0-9]{24}$/.test(candidate.storageSelectionId || "") ||
    !/^source-snapshot-[a-f0-9]{24}$/.test(candidate.sourceSnapshotId || "") ||
    !/^product-model-[a-f0-9]{24}$/.test(candidate.productModelId || "") ||
    candidate.authorityClass !== "candidate-set" ||
    candidate.instructionAuthority !== false ||
    candidate.promotionAuthority !== false ||
    onboardingCanonicalJson(candidate.limits) !== onboardingCanonicalJson(LEGACY_LIMITS)
  )
    fail("Legacy candidate family is invalid.", "LEGACY_MIGRATOR_CANDIDATE_INVALID");
  if (family.worldModel === "required" ? !/^world-model-[a-f0-9]{24}$/.test(candidate.worldModelId || "") : candidate.worldModelId != null) {
    fail("Legacy candidate World binding is invalid.", "LEGACY_MIGRATOR_CANDIDATE_INVALID");
  }
  const alternate = family.reviewField === "reviewDecisionId" ? "producerReviewDecisionId" : "reviewDecisionId";
  if (Object.hasOwn(candidate, alternate)) fail("Legacy candidate producer field is invalid.", "LEGACY_MIGRATOR_CANDIDATE_INVALID");
  if (
    !Array.isArray(candidate.candidates) ||
    !Array.isArray(candidate.evidence) ||
    !Array.isArray(candidate.unknowns) ||
    candidate.candidates.length > LEGACY_LIMITS.maxCandidates ||
    candidate.evidence.length > LEGACY_LIMITS.maxEvidenceRecords ||
    candidate.unknowns.length > LEGACY_LIMITS.maxUnknowns
  )
    fail("Legacy candidate collections exceed their bound.", "LEGACY_MIGRATOR_LIMIT");
  const evidenceIds = new Set();
  for (const evidence of candidate.evidence) {
    contentIdentity(evidence, "evidenceId", "evidenceHash", "onboarding-evidence", "Legacy onboarding evidence");
    if (
      evidence.instructionAuthority !== false ||
      evidence.promotionAuthority !== false ||
      typeof evidence.sourceKind !== "string" ||
      !evidence.sourceKind ||
      typeof evidence.sourceId !== "string" ||
      !evidence.sourceId ||
      typeof evidence.statement !== "string" ||
      !evidence.statement ||
      evidenceIds.has(evidence.evidenceId)
    ) {
      fail("Legacy Evidence authority or identity is invalid.", "LEGACY_MIGRATOR_CANDIDATE_INVALID");
    }
    evidenceIds.add(evidence.evidenceId);
  }
  if (onboardingCanonicalJson(candidate.evidence.map((item) => item.evidenceId)) !== onboardingCanonicalJson([...evidenceIds].sort())) {
    fail("Legacy Evidence ordering is invalid.", "LEGACY_MIGRATOR_CANDIDATE_INVALID");
  }
  const candidateIds = new Set();
  for (const item of candidate.candidates) {
    contentIdentity(item, "candidateId", "candidateHash", "onboarding-candidate", "Legacy product candidate");
    if (
      item.schemaVersion !== 1 ||
      item.kind !== "OnboardingProductCandidate" ||
      !PRODUCT_ENTITY_KINDS_V1.includes(item.productKind) ||
      item.producer !== "head-agent-core-onboarding-inference" ||
      item.producerVersion !== version ||
      item.authorityClass !== "candidate" ||
      item.instructionAuthority !== false ||
      item.promotionAuthority !== false ||
      !Number.isFinite(item.confidence) ||
      item.confidence < 0 ||
      item.confidence > 1 ||
      typeof item.explanation !== "string" ||
      !item.explanation ||
      item.explanation.length > 2000 ||
      item.sourceSnapshotId !== candidate.sourceSnapshotId ||
      sortedUnique(item.evidenceIds, `Legacy candidate ${item.candidateId} evidence`).some((id) => !evidenceIds.has(id)) ||
      candidateIds.has(item.candidateId)
    ) {
      fail("Legacy product candidate binding is invalid.", "LEGACY_MIGRATOR_CANDIDATE_INVALID");
    }
    candidateIds.add(item.candidateId);
  }
  const orderedCandidates = [...candidate.candidates].sort(
    (left, right) =>
      KIND_ORDER.get(left.productKind) - KIND_ORDER.get(right.productKind) ||
      String(left.proposedEntity?.key).localeCompare(String(right.proposedEntity?.key), "en") ||
      left.candidateId.localeCompare(right.candidateId, "en"),
  );
  if (
    onboardingCanonicalJson(candidate.candidates.map((item) => item.candidateId)) !== onboardingCanonicalJson(orderedCandidates.map((item) => item.candidateId))
  ) {
    fail("Legacy product candidate ordering is invalid.", "LEGACY_MIGRATOR_CANDIDATE_INVALID");
  }
  const unknownIds = new Set();
  for (const unknown of candidate.unknowns) {
    if (
      !/^onboarding-unknown-[a-f0-9]{24}$/.test(unknown?.unknownId || "") ||
      typeof unknown.statement !== "string" ||
      !unknown.statement ||
      unknown.status !== "open" ||
      sortedUnique(unknown.evidenceIds || [], `Legacy Unknown ${unknown?.unknownId} evidence`).some((id) => !evidenceIds.has(id)) ||
      unknownIds.has(unknown.unknownId)
    )
      fail("Legacy Unknown binding is invalid.", "LEGACY_MIGRATOR_CANDIDATE_INVALID");
    unknownIds.add(unknown.unknownId);
  }
  if (onboardingCanonicalJson(candidate.unknowns.map((item) => item.unknownId)) !== onboardingCanonicalJson([...unknownIds].sort())) {
    fail("Legacy Unknown ordering is invalid.", "LEGACY_MIGRATOR_CANDIDATE_INVALID");
  }
  for (const parent of sortedUnique(candidate.parentCandidateSetIds || [], "Legacy candidate ancestry")) {
    if (!/^onboarding-candidates-[a-f0-9]{24}$/.test(parent)) fail("Legacy candidate ancestry is invalid.", "LEGACY_MIGRATOR_CANDIDATE_INVALID");
  }
  return { version, producerReviewDecisionId: candidate[family.reviewField] ?? null };
}

function revisionInterpretation(revision) {
  try {
    verifyProductModelRevisionForProjection(revision);
    return "current-typed-with-historical-provenance";
  } catch {
    if (revision?.kind !== "ProductModelRevision" || !revision.document || typeof revision.document !== "object") return "opaque-legacy-revision";
    const model = normalizeProductModelDocument(revision.document);
    if (revision.productModelId !== model.productModelId || revision.productModelHash !== model.productModelHash)
      fail("Historical Product revision is invalid.", "LEGACY_MIGRATOR_REVISION_INVALID");
    return "opaque-legacy-revision";
  }
}

function inventoryRevision(projectRoot, productModelId) {
  const relative = `${ONBOARDING_PRODUCT_REVISION_DIRECTORY}/${productModelId}.json`;
  const snapshot = readArtifact(path.join(projectRoot, ...relative.split("/")), "Historical Product Model revision");
  const revision = snapshot.document;
  if (revision.productModelId !== productModelId) fail("Historical Product revision filename does not match its identity.", "LEGACY_MIGRATOR_REVISION_INVALID");
  const interpretationMode = revisionInterpretation(revision);
  return {
    revision,
    inventory: entry(
      relative,
      "historical-product-revision",
      productModelId,
      revision.kind || "ProductModelRevision",
      String(revision.schemaVersion || ""),
      snapshot.bytes,
      interpretationMode,
    ),
  };
}

function artifactDocuments(projectRoot, relativeDirectory, filePattern, idField, label) {
  const directory = path.join(projectRoot, ...relativeDirectory.split("/"));
  if (!fs.existsSync(directory) || !fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) {
    fail(`${label} directory is missing or unsafe.`, "LEGACY_MIGRATOR_ARTIFACT_MISSING");
  }
  const files = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"));
  if (files.length > MAX_FILES) fail(`${label} directory exceeds its bound.`, "LEGACY_MIGRATOR_LIMIT");
  return files.map((item) => {
    if (!item.isFile() || item.isSymbolicLink() || !filePattern.test(item.name))
      fail(`${label} directory contains an unsafe entry.`, "LEGACY_MIGRATOR_ARTIFACT_MISSING");
    const relative = `${relativeDirectory}/${item.name}`;
    const artifact = readArtifact(path.join(directory, item.name), label);
    if (`${artifact.document?.[idField]}.json` !== item.name) {
      fail(`${label} filename does not match its document identity.`, "LEGACY_MIGRATOR_ARTIFACT_ID_PATH_MISMATCH");
    }
    return { relative, ...artifact };
  });
}

function validateLegacyChain({ candidates, reviews, projectId }) {
  if (!candidates.length) fail("First slice requires a complete legacy candidate chain.", "LEGACY_MIGRATOR_UNSUPPORTED_CHAIN");
  const candidateById = new Map();
  const familyById = new Map();
  for (const candidate of candidates) {
    const family = verifyCandidateSet(candidate, projectId);
    if (candidateById.has(candidate.candidateSetId)) fail("Legacy candidate identity is duplicated.", "LEGACY_MIGRATOR_UNSUPPORTED_CHAIN");
    candidateById.set(candidate.candidateSetId, candidate);
    familyById.set(candidate.candidateSetId, family);
  }
  const reviewById = new Map();
  const reviewsByCandidateId = new Map();
  for (const review of reviews.filter((document) => candidateById.has(document.candidateSetId))) {
    const candidate = candidateById.get(review.candidateSetId);
    verifyOnboardingReviewDecisionForProjection(review, candidate, projectId);
    if (reviewById.has(review.reviewDecisionId)) fail("Legacy review identity is duplicated.", "LEGACY_MIGRATOR_UNSUPPORTED_CHAIN");
    reviewById.set(review.reviewDecisionId, review);
    const grouped = reviewsByCandidateId.get(review.candidateSetId) || [];
    grouped.push(review);
    reviewsByCandidateId.set(review.candidateSetId, grouped);
  }
  const referencedAsParent = new Set();
  const expectedReviewIds = new Set();
  for (const candidate of candidates) {
    const parents = candidate.parentCandidateSetIds || [];
    for (const parentId of parents) {
      if (!candidateById.has(parentId)) fail("Legacy candidate references a missing parent.", "LEGACY_MIGRATOR_DANGLING_PARENT");
      referencedAsParent.add(parentId);
    }
    const producerReviewDecisionId = familyById.get(candidate.candidateSetId).producerReviewDecisionId;
    if (!parents.length && producerReviewDecisionId != null)
      fail("Legacy root candidate has an impossible producer review.", "LEGACY_MIGRATOR_READY_BINDING_MISMATCH");
    if (parents.length && !producerReviewDecisionId) fail("Legacy successor lacks its producer review.", "LEGACY_MIGRATOR_READY_BINDING_MISMATCH");
    if (producerReviewDecisionId) {
      const producer = reviewById.get(producerReviewDecisionId);
      if (!producer || producer.disposition !== "revise" || !parents.includes(producer.candidateSetId)) {
        fail("Legacy successor is not bound to the revise review of one of its parents.", "LEGACY_MIGRATOR_READY_BINDING_MISMATCH");
      }
      expectedReviewIds.add(producerReviewDecisionId);
    }
  }
  const terminals = candidates.filter((candidate) => !referencedAsParent.has(candidate.candidateSetId));
  if (terminals.length !== 1) fail("Legacy candidate chain must have exactly one terminal candidate.", "LEGACY_MIGRATOR_UNSUPPORTED_CHAIN");
  const terminalCandidate = terminals[0];
  const accepting = (reviewsByCandidateId.get(terminalCandidate.candidateSetId) || []).filter(
    (review) => review.promotionAuthority && review.disposition.startsWith("accept"),
  );
  if (accepting.length !== 1) fail("Legacy terminal candidate requires exactly one accepting review.", "LEGACY_MIGRATOR_UNSUPPORTED_CHAIN");
  const terminalReview = accepting[0];
  expectedReviewIds.add(terminalReview.reviewDecisionId);
  if (expectedReviewIds.size !== reviewById.size || [...reviewById.keys()].some((id) => !expectedReviewIds.has(id))) {
    fail("Legacy review set is not the exact closed revise-to-accept chain.", "LEGACY_MIGRATOR_UNSUPPORTED_CHAIN");
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (candidateId) => {
    if (visited.has(candidateId)) return;
    if (visiting.has(candidateId)) fail("Legacy candidate ancestry contains a cycle.", "LEGACY_MIGRATOR_PARENT_CYCLE");
    visiting.add(candidateId);
    for (const parentId of candidateById.get(candidateId).parentCandidateSetIds || []) visit(parentId);
    visiting.delete(candidateId);
    visited.add(candidateId);
  };
  visit(terminalCandidate.candidateSetId);
  if (visited.size !== candidateById.size) fail("Legacy inventory contains an unrelated candidate chain.", "LEGACY_MIGRATOR_UNSUPPORTED_CHAIN");
  return { terminalCandidate, terminalReview, reviewById, familyById };
}

function validateLiveReadyLineage({ state, candidateDocuments, reviewDocuments, legacyChain, projectId, canon }) {
  const liveCandidate = candidateDocuments.find((document) => document.candidateSetId === state.candidateSetId);
  const liveReview = reviewDocuments.find((document) => document.reviewDecisionId === state.latestReviewDecisionId);
  if (!liveCandidate || !liveReview) fail("Current ready onboarding lineage is incomplete.", "LEGACY_MIGRATOR_INCOMPLETE_READY");
  const liveIsLegacy = Boolean(FAMILIES[liveCandidate.protocol?.version]);
  if (liveIsLegacy) verifyCandidateSet(liveCandidate, projectId);
  else verifyOnboardingCandidateSetForProjection(liveCandidate, projectId);
  verifyOnboardingReviewDecisionForProjection(liveReview, liveCandidate, projectId);
  if (
    !liveReview.promotionAuthority ||
    !liveReview.disposition.startsWith("accept") ||
    liveReview.resultingProductModelId !== canon.model.productModelId ||
    liveReview.resultingProductModelHash !== canon.model.productModelHash
  ) {
    fail("Current ready onboarding lineage does not produce live Canon.", "LEGACY_MIGRATOR_INCOMPLETE_READY");
  }
  if (liveIsLegacy) {
    if (
      liveCandidate.candidateSetId !== legacyChain.terminalCandidate.candidateSetId ||
      liveReview.reviewDecisionId !== legacyChain.terminalReview.reviewDecisionId
    ) {
      fail("Live legacy ready pointer does not match the verified terminal approval.", "LEGACY_MIGRATOR_READY_BINDING_MISMATCH");
    }
    return;
  }
  const currentCandidateById = new Map(
    candidateDocuments.filter((candidate) => !FAMILIES[candidate.protocol?.version]).map((candidate) => [candidate.candidateSetId, candidate]),
  );
  const ancestry = new Set();
  const visit = (candidateId) => {
    if (ancestry.has(candidateId)) return;
    const candidate = currentCandidateById.get(candidateId);
    if (!candidate) fail("Current onboarding ancestry is incomplete.", "LEGACY_MIGRATOR_INCOMPLETE_READY");
    verifyOnboardingCandidateSetForProjection(candidate, projectId);
    ancestry.add(candidateId);
    for (const parentId of candidate.parentCandidateSetIds || []) visit(parentId);
  };
  visit(liveCandidate.candidateSetId);
  const lineageReviews = reviewDocuments.filter((review) => ancestry.has(review.candidateSetId));
  for (const review of lineageReviews) verifyOnboardingReviewDecisionForProjection(review, currentCandidateById.get(review.candidateSetId), projectId);
  if (!lineageReviews.some((review) => review.previousProductModelId === legacyChain.terminalReview.resultingProductModelId)) {
    fail("Current ready lineage is not connected to the verified historical Canon.", "LEGACY_MIGRATOR_READY_BINDING_MISMATCH");
  }
}

export function inspectLegacyOnboarding({ root = "." } = {}) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") fail("Project/P2 is not independently current-readable.", "LEGACY_MIGRATOR_P2_UNREADABLE");
  const projectRoot = inspected.project.projectRoot;
  const stateFile = path.join(projectRoot, ...ONBOARDING_STATE_RELATIVE_PATH.split("/"));
  const rawState = readJson(stateFile, "Onboarding state");
  if (rawState.protocol?.version !== ONBOARDING_STATE_PROTOCOL_VERSION)
    fail("First slice does not migrate legacy onboarding state.", "LEGACY_MIGRATOR_UNSUPPORTED_STATE");
  const state = verifyOnboardingState(rawState, { projectId: inspected.project.projectId, sessionId: inspected.state.sessionId });
  if (state.phase !== "ready" || !state.candidateSetId || !state.latestReviewDecisionId || !state.productModelId)
    fail("First slice requires complete ready onboarding.", "LEGACY_MIGRATOR_INCOMPLETE_READY");
  const candidateArtifacts = artifactDocuments(
    projectRoot,
    ONBOARDING_CANDIDATE_DIRECTORY,
    /^onboarding-candidates-[a-f0-9]{24}\.json$/,
    "candidateSetId",
    "Onboarding candidate set",
  );
  const candidateDocuments = candidateArtifacts.map((artifact) => artifact.document);
  const candidateArtifactById = new Map(candidateArtifacts.map((artifact) => [artifact.document.candidateSetId, artifact]));
  const legacyCandidates = candidateDocuments.filter((document) => FAMILIES[document.protocol?.version]);
  for (const candidate of legacyCandidates)
    if (candidate.sessionId !== state.sessionId) {
      fail("Legacy candidate does not match the canonical Session.", "LEGACY_MIGRATOR_READY_BINDING_MISMATCH");
    }
  const reviewArtifacts = artifactDocuments(
    projectRoot,
    ONBOARDING_REVIEW_DIRECTORY,
    /^onboarding-review-decision-[a-f0-9]{24}\.json$/,
    "reviewDecisionId",
    "Onboarding ReviewDecision",
  );
  const reviewDocuments = reviewArtifacts.map((artifact) => artifact.document);
  const reviewArtifactById = new Map(reviewArtifacts.map((artifact) => [artifact.document.reviewDecisionId, artifact]));
  const legacyChain = validateLegacyChain({ candidates: legacyCandidates, reviews: reviewDocuments, projectId: inspected.project.projectId });
  const candidate = legacyChain.terminalCandidate;
  const review = legacyChain.terminalReview;
  const canon = readProductModelCanon({ projectRoot });
  if (canon.status !== "present" || canon.model.productModelId !== state.productModelId) {
    fail("Current Canon or historical resulting revision is missing or not independently current-readable.", "LEGACY_MIGRATOR_CURRENT_CANON_UNSUPPORTED");
  }
  validateLiveReadyLineage({ state, candidateDocuments, reviewDocuments, legacyChain, projectId: inspected.project.projectId, canon });
  const liveRevision = inventoryRevision(projectRoot, canon.model.productModelId);
  if (
    liveRevision.inventory.interpretationMode !== "current-typed-with-historical-provenance" ||
    liveRevision.revision.productModelHash !== canon.model.productModelHash
  ) {
    fail("Live current Canon revision is not independently current-readable.", "LEGACY_MIGRATOR_CURRENT_CANON_UNSUPPORTED");
  }
  const entries = [];
  const entryPaths = new Set();
  const addEntry = (value) => {
    if (!entryPaths.has(value.path)) {
      entries.push(value);
      entryPaths.add(value.path);
    }
  };
  for (const legacyCandidate of legacyCandidates) {
    const artifact = candidateArtifactById.get(legacyCandidate.candidateSetId);
    addEntry(
      entry(
        artifact.relative,
        "historical-candidate-set",
        legacyCandidate.candidateSetId,
        legacyCandidate.protocol.name,
        legacyCandidate.protocol.version,
        artifact.bytes,
      ),
    );
    if (legacyCandidate.worldModelId) {
      const worldRelative = `.head/world-model/snapshots/${legacyCandidate.worldModelId}.json`;
      const worldArtifact = readArtifact(path.join(projectRoot, ...worldRelative.split("/")), "Legacy World embedding");
      const world = worldArtifact.document;
      addEntry(
        entry(
          worldRelative,
          "legacy-world-embedding-reference",
          legacyCandidate.worldModelId,
          world.protocol?.name || world.kind || "WorldModel",
          world.protocol?.version || String(world.schemaVersion || ""),
          worldArtifact.bytes,
        ),
      );
    }
  }
  for (const historicalReview of legacyChain.reviewById.values()) {
    const artifact = reviewArtifactById.get(historicalReview.reviewDecisionId);
    addEntry(
      entry(
        artifact.relative,
        "historical-review",
        historicalReview.reviewDecisionId,
        historicalReview.protocol.name,
        historicalReview.protocol.version,
        artifact.bytes,
      ),
    );
    const previous = inventoryRevision(projectRoot, historicalReview.previousProductModelId);
    if (previous.revision.productModelHash !== historicalReview.previousProductModelHash)
      fail("Historical review previous revision binding is invalid.", "LEGACY_MIGRATOR_READY_BINDING_MISMATCH");
    addEntry(previous.inventory);
    if (historicalReview.resultingProductModelId) {
      const resulting = inventoryRevision(projectRoot, historicalReview.resultingProductModelId);
      if (resulting.revision.productModelHash !== historicalReview.resultingProductModelHash)
        fail("Historical review resulting revision binding is invalid.", "LEGACY_MIGRATOR_READY_BINDING_MISMATCH");
      addEntry(resulting.inventory);
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
  if (entries.length > MAX_FILES || entries.reduce((sum, item) => sum + item.byteLength, 0) > MAX_BYTES)
    fail("Legacy inventory exceeds its bound.", "LEGACY_MIGRATOR_LIMIT");
  const validation = {
    status: "complete-ready-verified",
    supportedCandidateVersions: [...new Set([...legacyChain.familyById.values()].map((family) => family.version))].sort(),
    historicalReadyCandidateSetId: candidate.candidateSetId,
    historicalReadyReviewDecisionId: review.reviewDecisionId,
    historicalResultingProductModelId: review.resultingProductModelId,
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const capability = createVerifiedHistoricalInventoryCapability({ root: projectRoot, projectId: inspected.project.projectId, entries, validation });
  if (
    capability.appliedAtBasis.onboardingState.candidateSetId !== state.candidateSetId ||
    capability.appliedAtBasis.onboardingState.latestReviewDecisionId !== state.latestReviewDecisionId ||
    capability.appliedAtBasis.onboardingState.productModelId !== state.productModelId ||
    capability.appliedAtBasis.canon.id !== canon.model.productModelId
  ) {
    fail("Live onboarding basis changed during historical validation.", "LEGACY_MIGRATOR_PREFLIGHT_BASIS_DRIFT");
  }
  return {
    status: "complete-ready-verified",
    projectRoot,
    projectId: inspected.project.projectId,
    candidateProtocolVersion: legacyChain.familyById.get(candidate.candidateSetId).version,
    entries,
    validation,
    capability,
  };
}
