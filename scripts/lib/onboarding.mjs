import { withSnapshotReferences, withSnapshotReferencesAsync } from "./snapshot-reference-lifetime.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { familyFormatForOriginal, formatForVerifiedOwner, relativeProjectArtifact } from "./project-storage-format.mjs";
import { inspectProject, SCHEMA_VERSION } from "./lode-core.mjs";
import { defaultSessionStatePath, sessionStatePath } from "./session-routing.mjs";
import {
  buildOnboardingState,
  buildSessionRecord,
  buildStorageSelection,
  onboardingCanonicalJson,
  onboardingDigest,
  onboardingStateLatestReviewDecisionId,
  verifyOnboardingState,
  verifySessionRecord,
  verifyStorageSelection,
} from "./onboarding-contract.mjs";
import {
  loadOnboardingGraphProjection,
  onboardingCandidateProducerReviewDecisionId,
  verifyOnboardingCandidateSetForProjection,
  verifyOnboardingReviewDecisionForProjection,
  verifyProductModelRevisionForProjection,
  productModelRevisionForImmutableRetry,
} from "./onboarding-projection.mjs";
import {
  emptyProductModelDocument,
  normalizeProductModelDocument,
  productModelDocument,
  PRODUCT_ENTITY_KINDS_V1 as PRODUCT_ENTITY_KINDS,
  readProductModelCanon,
} from "./product-model.mjs";
import { buildWorldModel, inspectWorldModel, readWorldModel, readWorldModelSnapshot } from "./world-model.mjs";
import { readRepositorySourceScope, writeRepositorySourceScope } from "./repository-source-scope.mjs";
import { withProjectMutation, withProjectMutationAsync } from "./project-mutation-lock.mjs";
import { historicalEntryForPath, readCommittedHistoricalArtifactBoundary } from "./historical-artifact-boundary-store.mjs";
import { publishHistoricalContinuityReceipt } from "./historical-continuity.mjs";

export const ONBOARDING_CANDIDATE_VERSION = "0.4.0";
export const ONBOARDING_REVIEW_VERSION = "0.1.0";
export const ONBOARDING_INFERENCE_VERSION = "0.4.0";

const MAX_CANDIDATES = 200;
const MAX_EVIDENCE_RECORDS = 250;
const MAX_UNKNOWNS = 100;
const MAX_PROPOSAL_EVIDENCE_PER_CANDIDATE = 8;
const KIND_ORDER = new Map(PRODUCT_ENTITY_KINDS.map((kind, index) => [kind, index]));
const ARRAY_BY_KIND = Object.freeze({
  FeatureGroup: "featureGroups",
  Capability: "capabilities",
  Feature: "features",
  Requirement: "requirements",
  Constraint: "constraints",
  Decision: "decisions",
});

const fail = (message, code = "ONBOARDING_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const now = () => new Date().toISOString();
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const ABSENT_WORLD_CODES = new Set(["WORLD_MODEL_NOT_BUILT", "WORLD_MODEL_SNAPSHOT_MISSING"]);

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is required.`, "INVALID_ONBOARDING_INPUT");
  return value.trim();
}

function textList(value, label) {
  const source = value == null ? [] : value;
  if (!Array.isArray(source) || source.some((item) => typeof item !== "string" || !item.trim())) {
    fail(`${label} must be an array of non-empty strings.`, "INVALID_ONBOARDING_INPUT");
  }
  const normalized = source.map((item) => item.trim());
  if (new Set(normalized).size !== normalized.length) fail(`${label} contains duplicate values.`, "DUPLICATE_ONBOARDING_INPUT");
  return normalized.sort();
}

function recordList(value, label) {
  const source = value == null ? [] : value;
  if (!Array.isArray(source) || source.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    fail(`${label} must be an array of objects.`, "INVALID_ONBOARDING_INPUT");
  }
  return source;
}

function assertRecordFields(record, allowed, label) {
  const unexpected = Object.keys(record).filter((field) => !allowed.includes(field));
  if (unexpected.length) fail(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}`, "UNSUPPORTED_ONBOARDING_FIELD");
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

function readJson(file, label, code = "INVALID_ONBOARDING_ARTIFACT") {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`${label} is invalid JSON: ${error.message}`, code); }
}

function readyProject(root, action = "onboarding", sessionScope = "default") {
  const inspected = inspectProject(root, { sessionScope });
  if (inspected.status !== "ready") {
    fail(`Project must be ready for ${action}; current status: ${inspected.status}.`, "PROJECT_NOT_READY");
  }
  return inspected;
}

function relativeFile(projectRoot, relative) {
  const root = path.resolve(projectRoot);
  const candidate = path.resolve(root, ...relative.split("/"));
  const fromRoot = path.relative(root, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    fail(`Onboarding artifact path escapes the project root: ${relative}`, "ONBOARDING_PATH_ESCAPE");
  }
  let current = root;
  for (const segment of fromRoot.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      fail(`Onboarding artifact path traverses a symlink: ${relative}`, "ONBOARDING_SYMLINK_PATH");
    }
  }
  return candidate;
}

function stateFile(projectRoot, storageOwner) {
  return relativeFile(projectRoot, relativeProjectArtifact(storageOwner, "onboarding", "current.json"));
}

function sessionRecordFile(projectRoot, sessionId, storageOwner) {
  return relativeFile(projectRoot, `${relativeProjectArtifact(storageOwner, "sessions", "records")}/${sessionId}.json`);
}

function storageSelectionFile(projectRoot, storageSelectionId, storageOwner) {
  return relativeFile(projectRoot, `${relativeProjectArtifact(storageOwner, "onboarding", "storage-selections")}/${storageSelectionId}.json`);
}

function candidateSetFile(projectRoot, candidateSetId, storageOwner) {
  if (!/^onboarding-candidates-[a-f0-9]{24}$/.test(candidateSetId || "")) {
    fail("Onboarding candidate-set id is invalid.", "INVALID_ONBOARDING_CANDIDATE_SET_ID");
  }
  return relativeFile(projectRoot, `${relativeProjectArtifact(storageOwner, "onboarding", "candidate-sets")}/${candidateSetId}.json`);
}

function reviewDecisionFile(projectRoot, reviewDecisionId, storageOwner) {
  if (!/^onboarding-review-decision-[a-f0-9]{24}$/.test(reviewDecisionId || "")) {
    fail("Onboarding ReviewDecision id is invalid.", "INVALID_ONBOARDING_REVIEW_ID");
  }
  return relativeFile(projectRoot, `${relativeProjectArtifact(storageOwner, "onboarding", "review-decisions")}/${reviewDecisionId}.json`);
}

function persistImmutable(file, document, label) {
  if (fs.existsSync(file)) {
    const existing = readJson(file, label);
    if (onboardingCanonicalJson(existing) !== onboardingCanonicalJson(document)) {
      fail(`${label} identity collision detected.`, "ONBOARDING_IMMUTABLE_COLLISION");
    }
    return { status: "existing", file, document: existing };
  }
  atomicWrite(file, json(document));
  return { status: "recorded", file, document };
}

function productModelHasEntities(model) {
  return Object.values(ARRAY_BY_KIND).some((field) => model[field].length > 0);
}

function writeState(projectRoot, previous, changes, storageOwner) {
  const latestReviewDecisionId = Object.hasOwn(changes, "latestReviewDecisionId")
    ? changes.latestReviewDecisionId
    : onboardingStateLatestReviewDecisionId(previous);
  const state = buildOnboardingState({
    ...previous,
    ...changes,
    latestReviewDecisionId,
    stateRevision: previous.stateRevision + 1,
    updatedAt: now(),
  }, storageOwner);
  atomicWrite(stateFile(projectRoot, storageOwner), json(state));
  return state;
}

function migrationPreview(inspected) {
  const storageOwner = inspected.storage;
  const product = readProductModelCanon({ storage: storageOwner, projectRoot: inspected.project.projectRoot });
  const storageSelection = buildStorageSelection({ projectId: inspected.project.projectId, selection: { mode: "local" } }, storageOwner);
  const sessionRecord = buildSessionRecord({ project: inspected.project, sessionState: inspected.state }, storageOwner);
  const state = buildOnboardingState({
    projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId,
    phase: "initialized",
    stateRevision: 0,
    storageSelectionId: storageSelection.storageSelectionId,
    productModelId: product.model.productModelId,
    migration: "legacy-missing-state-v1",
    updatedAt: inspected.project.createdAt || inspected.state.updatedAt,
  }, storageOwner);
  return { product, storageSelection, sessionRecord, state };
}

function ensureOnboardingState(inspected) {
  const storageOwner = inspected.storage;
  const projectRoot = inspected.project.projectRoot;
  const file = stateFile(projectRoot, storageOwner);
  if (!fs.existsSync(file)) {
    const migration = migrationPreview(inspected);
    persistImmutable(
      sessionRecordFile(projectRoot, migration.sessionRecord.sessionId, storageOwner),
      migration.sessionRecord,
      "HEAD Session record",
    );
    persistImmutable(
      storageSelectionFile(projectRoot, migration.storageSelection.storageSelectionId, storageOwner),
      migration.storageSelection,
      "Onboarding storage selection",
    );
    atomicWrite(file, json(migration.state));
    return migration.state;
  }
  const state = verifyOnboardingState(readJson(file, "Onboarding state pointer"), {
    projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId,
    storage: storageOwner,
  });
  const sessionFile = sessionRecordFile(projectRoot, state.sessionId, storageOwner);
  if (!fs.existsSync(sessionFile)) fail("HEAD Session record is missing.", "ONBOARDING_SESSION_RECORD_MISSING");
  verifySessionRecord(readJson(sessionFile, "HEAD Session record"), {
    projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId,
    storage: storageOwner,
  });
  const storageFile = storageSelectionFile(projectRoot, state.storageSelectionId, storageOwner);
  if (!fs.existsSync(storageFile)) fail("Onboarding storage selection is missing.", "ONBOARDING_STORAGE_SELECTION_MISSING");
  verifyStorageSelection(readJson(storageFile, "Onboarding storage selection"), inspected.project.projectId, storageOwner);
  return state;
}

function evidenceRecord(fields) {
  const payload = {
    sourceKind: requiredText(fields.sourceKind, "Evidence sourceKind"),
    sourceId: requiredText(fields.sourceId, "Evidence sourceId"),
    path: fields.path || "",
    line: Number.isInteger(fields.line) && fields.line > 0 ? fields.line : null,
    contentDigest: fields.contentDigest || "",
    statement: requiredText(fields.statement, "Evidence statement"),
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const hash = onboardingDigest(onboardingCanonicalJson(payload));
  return { ...payload, evidenceId: `onboarding-evidence-${hash.slice(0, 24)}`, evidenceHash: hash };
}

function candidateArtifact({ kind, entity, evidenceIds, explanation, confidence, sourceSnapshotId, origin }, storageOwner) {
  const format = formatForVerifiedOwner(storageOwner);
  if (!PRODUCT_ENTITY_KINDS.includes(kind)) fail(`Unsupported product candidate kind: ${kind}`, "INVALID_ONBOARDING_CANDIDATE");
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    fail("Onboarding candidate confidence must be from zero through one.", "INVALID_ONBOARDING_CONFIDENCE");
  }
  const normalizedExplanation = requiredText(explanation, "Candidate explanation");
  if (normalizedExplanation.length > 2000) {
    fail("Onboarding candidate explanation must contain at most 2000 characters.", "INVALID_ONBOARDING_CANDIDATE");
  }
  const payload = {
    schemaVersion: 1,
    kind: "OnboardingProductCandidate",
    productKind: kind,
    proposedEntity: entity,
    evidenceIds: [...new Set(evidenceIds)].sort(),
    explanation: normalizedExplanation,
    confidence: Number(confidence.toFixed(6)),
    sourceSnapshotId: requiredText(sourceSnapshotId, "Candidate sourceSnapshotId"),
    origin: requiredText(origin, "Candidate origin"),
    producer: origin === "user-owned-brief-candidate"
      ? format.protocol("head-agent-core-user-brief-normalizer")
      : format.protocol("head-agent-core-semantic-proposal-normalizer"),
    producerVersion: ONBOARDING_INFERENCE_VERSION,
    authorityClass: "candidate",
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const hash = onboardingDigest(onboardingCanonicalJson(payload));
  return { ...payload, candidateId: `onboarding-candidate-${hash.slice(0, 24)}`, candidateHash: hash };
}

function candidateCompare(left, right) {
  return (KIND_ORDER.get(left.productKind) - KIND_ORDER.get(right.productKind))
    || compareText(left.proposedEntity.key, right.proposedEntity.key)
    || compareText(left.candidateId, right.candidateId);
}

function modelFromCandidateEntities(candidates, storageOwner) {
  const document = emptyProductModelDocument(storageOwner);
  for (const candidate of candidates) document[ARRAY_BY_KIND[candidate.productKind]].push(candidate.proposedEntity);
  return normalizeProductModelDocument(document, storageOwner);
}

function buildCandidateSet({ projectId, sessionId, inputMode, storageSelectionId, worldModel, candidates, evidence, unknowns, parentCandidateSetIds = [], producerReviewDecisionId = null, briefEvidenceId = null }, storageOwner) {
  if (candidates.length > MAX_CANDIDATES || evidence.length > MAX_EVIDENCE_RECORDS || unknowns.length > MAX_UNKNOWNS) {
    fail("Onboarding candidate set exceeds its deterministic size bounds.", "ONBOARDING_CANDIDATE_SET_LIMIT");
  }
  const orderedCandidates = [...candidates].sort(candidateCompare);
  modelFromCandidateEntities(orderedCandidates, storageOwner);
  const orderedEvidence = [...evidence].sort((left, right) => compareText(left.evidenceId, right.evidenceId));
  const knownEvidence = new Set(orderedEvidence.map((item) => item.evidenceId));
  for (const candidate of orderedCandidates) {
    for (const evidenceId of candidate.evidenceIds) if (!knownEvidence.has(evidenceId)) {
      fail(`Candidate references unknown evidence: ${evidenceId}`, "UNKNOWN_ONBOARDING_EVIDENCE");
    }
  }
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "OnboardingCandidateSet",
    protocol: { name: formatForVerifiedOwner(storageOwner).protocol("head-agent-core-onboarding-candidates"), version: ONBOARDING_CANDIDATE_VERSION },
    projectId,
    sessionId,
    inputMode,
    storageSelectionId,
    sourceSnapshotId: worldModel.temporalProvenanceGraph.sourceSnapshotId,
    productModelId: worldModel.productModel.productModelId,
    briefEvidenceId,
    candidates: orderedCandidates,
    evidence: orderedEvidence,
    unknowns: [...unknowns].sort((left, right) => compareText(left.unknownId, right.unknownId)),
    parentCandidateSetIds: [...new Set(parentCandidateSetIds)].sort(),
    producerReviewDecisionId,
    reviewProtocol: {
      decisionScope: "product-canon-bootstrap",
      allowedDispositions: ["accept-all", "accept-selection", "revise", "reject"],
      authorityTransition: "only-an-explicit-onboarding-review-decision-may-write-product-canon",
    },
    limits: {
      maxSemanticProposalEvidencePerCandidate: MAX_PROPOSAL_EVIDENCE_PER_CANDIDATE,
      maxCandidates: MAX_CANDIDATES,
      maxEvidenceRecords: MAX_EVIDENCE_RECORDS,
      maxUnknowns: MAX_UNKNOWNS,
    },
    authorityClass: "candidate-set",
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const hash = onboardingDigest(onboardingCanonicalJson(payload));
  return { ...payload, candidateSetId: `onboarding-candidates-${hash.slice(0, 24)}`, candidateSetHash: hash };
}

function verifyCandidateSet(document, projectId = "") {
  const storageOwner = familyFormatForOriginal("head-agent-core-onboarding-candidates", document);
  if (!document || document.kind !== "OnboardingCandidateSet") fail("Onboarding candidate set is invalid.", "INVALID_ONBOARDING_CANDIDATE_SET");
  const payload = { ...document };
  delete payload.candidateSetId;
  delete payload.candidateSetHash;
  const hash = onboardingDigest(onboardingCanonicalJson(payload));
  if (document.candidateSetHash !== hash || document.candidateSetId !== `onboarding-candidates-${hash.slice(0, 24)}`) {
    fail("Onboarding candidate-set digest verification failed.", "ONBOARDING_CANDIDATE_SET_DIGEST_MISMATCH");
  }
  if (projectId && document.projectId !== projectId) fail("Onboarding candidate set belongs to another project.", "ONBOARDING_PROJECT_MISMATCH");
  modelFromCandidateEntities(document.candidates || [], storageOwner);
  const evidenceIds = new Set((document.evidence || []).map((item) => item.evidenceId));
  for (const candidate of document.candidates || []) {
    if (candidate.instructionAuthority !== false || candidate.promotionAuthority !== false || candidate.authorityClass !== "candidate") {
      fail("Onboarding candidate attempts to acquire authority.", "ONBOARDING_CANDIDATE_AUTHORITY_VIOLATION");
    }
    const candidatePayload = { ...candidate };
    delete candidatePayload.candidateId;
    delete candidatePayload.candidateHash;
    const candidateHash = onboardingDigest(onboardingCanonicalJson(candidatePayload));
    if (candidate.candidateHash !== candidateHash || candidate.candidateId !== `onboarding-candidate-${candidateHash.slice(0, 24)}`) {
      fail("Onboarding candidate digest verification failed.", "ONBOARDING_CANDIDATE_DIGEST_MISMATCH");
    }
    for (const evidenceId of candidate.evidenceIds || []) if (!evidenceIds.has(evidenceId)) {
      fail(`Candidate references unknown evidence: ${evidenceId}`, "UNKNOWN_ONBOARDING_EVIDENCE");
    }
  }
  return verifyOnboardingCandidateSetForProjection(document, projectId, storageOwner);
}

export function readOnboardingCandidateSet({ root = ".", candidateSetId } = {}) {
  const inspected = readyProject(root, "candidate-set inspection");
  const storageOwner = inspected.storage;
  const file = candidateSetFile(inspected.project.projectRoot, candidateSetId, storageOwner);
  if (!fs.existsSync(file)) fail(`Onboarding candidate set not found: ${candidateSetId}`, "ONBOARDING_CANDIDATE_SET_NOT_FOUND");
  const historical = readCommittedHistoricalArtifactBoundary({ storage: storageOwner, root: inspected.project.projectRoot, projectId: inspected.project.projectId, allowAbsent: true });
  const relative = `${relativeProjectArtifact(storageOwner, "onboarding", "candidate-sets")}/${candidateSetId}.json`;
  const historicalEntry = historicalEntryForPath(historical, relative, "historical-candidate-set");
  if (historicalEntry) return { status: "historical-ready-opaque", file, candidateSet: null, historicalArtifact: historicalEntry, historicalBoundaryId: historical.boundary.boundaryId };
  return { status: "verified", file, candidateSet: verifyCandidateSet(readJson(file, "Onboarding candidate set"), inspected.project.projectId) };
}

function candidateBytes(projectRoot, id, storageOwner) {
  const file = candidateSetFile(projectRoot, id, storageOwner);
  if (!fs.existsSync(file)) return null;
  if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 8 * 1024 * 1024) {
    fail("Candidate repair requires a bounded regular file.", "ONBOARDING_RECOVERY_FILE_INVALID");
  }
  return fs.readFileSync(file);
}

const rawHash = (bytes) => bytes === null ? null : crypto.createHash("sha256").update(bytes).digest("hex");

function preserveCandidateBytes(projectRoot, id, bytes, storageOwner) {
  if (bytes === null) return null;
  const file = relativeFile(projectRoot, `${formatForVerifiedOwner(storageOwner).directory}/onboarding/recovery-custody/${id}--${rawHash(bytes)}.bin`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, bytes, { flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  if (!fs.readFileSync(file).equals(bytes)) fail("Candidate custody backup differs.", "ONBOARDING_RECOVERY_CUSTODY_CONFLICT");
  return file;
}

export function restoreOnboardingCandidate({ root = ".", candidateSetId, sourceContent, expectedRawHash } = {}) {
  return withProjectMutation({ root, scope: "onboarding-promotion" }, () => {
    const inspected = readyProject(root, "exact candidate restoration");
    const storageOwner = inspected.storage;
    const projectRoot = inspected.project.projectRoot;
    const file = candidateSetFile(projectRoot, candidateSetId, storageOwner);
    if (typeof sourceContent !== "string" || Buffer.byteLength(sourceContent) > 8 * 1024 * 1024
      || !(expectedRawHash === null || /^[a-f0-9]{64}$/.test(expectedRawHash || ""))) {
      fail("Restoration requires bounded original content and an exact observed raw hash (null for missing).", "ONBOARDING_RECOVERY_INPUT_INVALID");
    }
    let source;
    try { source = JSON.parse(sourceContent); }
    catch { fail("Restoration source is not JSON.", "ONBOARDING_RECOVERY_SOURCE_INVALID"); }
    verifyCandidateSet(source, inspected.project.projectId);
    if (source.candidateSetId !== candidateSetId) fail("Restoration source is not the requested candidate.", "ONBOARDING_RECOVERY_SOURCE_MISMATCH");
    const before = candidateBytes(projectRoot, candidateSetId, storageOwner);
    // Semantic identity is independent of whitespace. Never rewrite a healthy file.
    if (before !== null) {
      try {
        const current = verifyCandidateSet(JSON.parse(before), inspected.project.projectId);
        if (current.candidateSetHash === source.candidateSetHash) return { status: "already-restored", candidateSetId, candidateSetHash: source.candidateSetHash, rawHash: rawHash(before), sourceRawBytesEqual: before.equals(Buffer.from(sourceContent)) };
      } catch { /* The exact corrupt bytes remain guarded below. */ }
    }
    if (rawHash(before) !== expectedRawHash) fail("Candidate changed before restoration.", "ONBOARDING_RECOVERY_CONFLICT");
    const custodyFile = preserveCandidateBytes(projectRoot, candidateSetId, before, storageOwner);
    if (rawHash(candidateBytes(projectRoot, candidateSetId, storageOwner)) !== expectedRawHash) fail("Candidate changed during restoration.", "ONBOARDING_RECOVERY_CONFLICT");
    atomicWrite(file, sourceContent);
    readOnboardingCandidateSet({ root: projectRoot, candidateSetId });
    return { status: "restored", candidateSetId, candidateSetHash: source.candidateSetHash,
      rawHash: rawHash(Buffer.from(sourceContent)), sourceRawBytesEqual: true, custodyFile,
      canonicalContentVerified: true, priorRawBytesEqualityClaimed: false, canonChanged: false, recoveryChanged: false };
  });
}

function normalizedBrief(brief, storageOwner) {
  if (brief == null) return null;
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) fail("Onboarding brief must be an object.", "INVALID_ONBOARDING_BRIEF");
  const allowed = new Set(["schemaVersion", "name", "summary", ...Object.values(ARRAY_BY_KIND)]);
  const unexpected = Object.keys(brief).filter((field) => !allowed.has(field));
  if (unexpected.length) fail(`Onboarding brief contains unsupported fields: ${unexpected.sort().join(", ")}`, "UNSUPPORTED_ONBOARDING_FIELD");
  if (brief.schemaVersion !== 1) fail("Onboarding brief schemaVersion must be 1.", "INVALID_ONBOARDING_BRIEF");
  const model = normalizeProductModelDocument({
    schemaVersion: 1,
    featureGroups: brief.featureGroups || [],
    capabilities: brief.capabilities || [],
    features: brief.features || [],
    requirements: brief.requirements || [],
    constraints: brief.constraints || [],
    decisions: brief.decisions || [],
  }, storageOwner);
  const normalized = {
    schemaVersion: 1,
    name: typeof brief.name === "string" ? brief.name.trim() : "",
    summary: typeof brief.summary === "string" ? brief.summary.trim() : "",
    ...productModelDocument(model, storageOwner),
  };
  const hash = onboardingDigest(onboardingCanonicalJson(normalized));
  return { document: normalized, model, evidenceId: `onboarding-brief-${hash.slice(0, 24)}`, evidenceHash: hash };
}

function semanticProposalRequiredUnknown(sourceSnapshotId, storageOwner) {
  const statement = `Fresh ${formatForVerifiedOwner(storageOwner).value("HEAD")} semantic product candidates are required. Core intentionally does not infer product meaning from file names, symbols, or lexical overlap.`;
  const hash = onboardingDigest(onboardingCanonicalJson({ sourceSnapshotId, kind: "semantic-product-proposal-required", statement }));
  return { unknownId: `onboarding-unknown-${hash.slice(0, 24)}`, statement, evidenceIds: [], status: "open" };
}

function normalizedProposalEvidence(value, index, { projectRoot, sourceSnapshotId, filesByPath }) {
  assertRecordFields(value, ["path", "line", "contentDigest", "symbol"], `Semantic proposal evidence ${index}`);
  const relativePath = requiredText(value.path, `Semantic proposal evidence ${index}.path`).replace(/\\/g, "/");
  if (path.posix.isAbsolute(relativePath) || relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
    fail(`Semantic proposal evidence ${index}.path must be a normalized project-relative path.`, "INVALID_ONBOARDING_SEMANTIC_PROPOSAL");
  }
  const file = filesByPath.get(relativePath);
  if (!file) fail(`Semantic proposal evidence path is absent from the current World Model: ${relativePath}`, "ONBOARDING_SEMANTIC_EVIDENCE_MISSING");
  const contentDigest = value.contentDigest == null ? file.digest : requiredText(value.contentDigest, `Semantic proposal evidence ${index}.contentDigest`).toLowerCase();
  if (contentDigest !== file.digest) fail(`Semantic proposal evidence digest does not match the current World Model: ${relativePath}`, "ONBOARDING_SEMANTIC_EVIDENCE_DRIFT");
  const line = value.line;
  const source = fs.readFileSync(path.join(projectRoot, ...relativePath.split("/")), "utf8");
  const lineCount = source.split(/\r?\n/u).length;
  if (!Number.isInteger(line) || line < 1 || line > lineCount) fail(`Semantic proposal evidence line is outside the current file: ${relativePath}:${value.line}`, "INVALID_ONBOARDING_SEMANTIC_PROPOSAL");
  let symbol = null;
  if (value.symbol != null) {
    assertRecordFields(value.symbol, ["name", "kind", "line"], `Semantic proposal evidence ${index}.symbol`);
    symbol = {
      name: requiredText(value.symbol.name, `Semantic proposal evidence ${index}.symbol.name`),
      kind: requiredText(value.symbol.kind, `Semantic proposal evidence ${index}.symbol.kind`),
      line: value.symbol.line,
    };
    if (!Number.isInteger(symbol.line) || symbol.line < 1) fail(`Semantic proposal evidence ${index}.symbol.line is invalid.`, "INVALID_ONBOARDING_SEMANTIC_PROPOSAL");
    if (!(file.symbols || []).some((item) => item.name === symbol.name && item.kind === symbol.kind && item.line === symbol.line)) {
      fail(`Semantic proposal symbol is absent from the current World Model: ${relativePath}:${symbol.name}`, "ONBOARDING_SEMANTIC_EVIDENCE_MISSING");
    }
  }
  return { file, relativePath, line, symbol, sourceSnapshotId };
}

function candidatesFromSemanticProposal(proposal, worldModel, projectRoot, storageOwner) {
  if (proposal == null) return { candidates: [], evidence: [], unknowns: [semanticProposalRequiredUnknown(worldModel.temporalProvenanceGraph.sourceSnapshotId, storageOwner)] };
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) fail("Semantic product proposal must be an object.", "INVALID_ONBOARDING_SEMANTIC_PROPOSAL");
  assertRecordFields(proposal, ["schemaVersion", "sourceSnapshotId", "candidates"], "Semantic product proposal");
  if (proposal.schemaVersion !== 1) fail("Semantic product proposal schemaVersion must be 1.", "INVALID_ONBOARDING_SEMANTIC_PROPOSAL");
  const sourceSnapshotId = requiredText(proposal.sourceSnapshotId, "Semantic product proposal sourceSnapshotId");
  if (sourceSnapshotId !== worldModel.temporalProvenanceGraph.sourceSnapshotId) fail("Semantic product proposal is bound to a stale SourceSnapshot.", "ONBOARDING_SEMANTIC_PROPOSAL_DRIFT");
  const proposed = recordList(proposal.candidates, "Semantic product proposal candidates");
  if (!proposed.length) fail("Semantic product proposal must contain at least one candidate.", "INVALID_ONBOARDING_SEMANTIC_PROPOSAL");
  if (proposed.length > MAX_CANDIDATES) fail("Semantic product proposal exceeds the candidate bound.", "ONBOARDING_CANDIDATE_SET_LIMIT");
  const filesByPath = new Map(worldModel.files.map((file) => [file.path, file]));
  const evidenceById = new Map();
  const candidates = proposed.map((item, candidateIndex) => {
    assertRecordFields(item, ["productKind", "proposedEntity", "evidence", "explanation", "confidence"], `Semantic product candidate ${candidateIndex}`);
    const productKind = requiredText(item.productKind, `Semantic product candidate ${candidateIndex}.productKind`);
    const evidenceInput = recordList(item.evidence, `Semantic product candidate ${candidateIndex}.evidence`);
    if (!evidenceInput.length || evidenceInput.length > MAX_PROPOSAL_EVIDENCE_PER_CANDIDATE) {
      fail(`Semantic product candidate ${candidateIndex} must contain 1 through ${MAX_PROPOSAL_EVIDENCE_PER_CANDIDATE} evidence records.`, "INVALID_ONBOARDING_SEMANTIC_PROPOSAL");
    }
    const evidenceIds = evidenceInput.map((record, evidenceIndex) => {
      const normalized = normalizedProposalEvidence(record, evidenceIndex, { projectRoot, sourceSnapshotId, filesByPath });
      const evidence = evidenceRecord({
        sourceKind: formatForVerifiedOwner(storageOwner).value(normalized.symbol ? "head-semantic-proposal-symbol" : "head-semantic-proposal-source"),
        sourceId: sourceSnapshotId,
        path: normalized.relativePath,
        line: normalized.line,
        contentDigest: normalized.file.digest,
        statement: normalized.symbol
          ? `Current ${normalized.symbol.kind} symbol ${normalized.symbol.name} is cited as evidence for proposed ${productKind}.`
          : `Current repository source ${normalized.relativePath}:${normalized.line} is cited as evidence for proposed ${productKind}.`,
      });
      evidenceById.set(evidence.evidenceId, evidence);
      return evidence.evidenceId;
    });
    return candidateArtifact({
      kind: productKind,
      entity: item.proposedEntity,
      evidenceIds,
      explanation: requiredText(item.explanation, `Semantic product candidate ${candidateIndex}.explanation`),
      confidence: item.confidence,
      sourceSnapshotId,
      origin: formatForVerifiedOwner(storageOwner).value("fresh-head-semantic-proposal"),
    }, storageOwner);
  });
  modelFromCandidateEntities(candidates, storageOwner);
  return { candidates, evidence: [...evidenceById.values()], unknowns: [] };
}

function candidatesFromBrief(brief, sourceSnapshotId, storageOwner) {
  if (!brief) return { candidates: [], evidence: [], unknowns: [] };
  const briefEvidence = evidenceRecord({
    sourceKind: "user-owned-onboarding-brief",
    sourceId: brief.evidenceId,
    contentDigest: brief.evidenceHash,
    statement: brief.document.summary || brief.document.name || "User-provided onboarding brief",
  });
  const candidates = [];
  for (const kind of PRODUCT_ENTITY_KINDS) {
    for (const entity of brief.model[ARRAY_BY_KIND[kind]]) {
      candidates.push(candidateArtifact({
        kind,
        entity,
        evidenceIds: [briefEvidence.evidenceId],
        explanation: "The user-owned brief supplies direct product evidence, but explicit onboarding review remains the authority transition into Product Canon.",
        confidence: 1,
        sourceSnapshotId,
        origin: "user-owned-brief-candidate",
      }, storageOwner));
    }
  }
  return { candidates, evidence: [briefEvidence], unknowns: [] };
}

function mergeCandidateSources(semantic, fromBrief) {
  const candidates = new Map();
  for (const candidate of semantic.candidates) candidates.set(`${candidate.productKind}:${candidate.proposedEntity.key}`, candidate);
  for (const candidate of fromBrief.candidates) candidates.set(`${candidate.productKind}:${candidate.proposedEntity.key}`, candidate);
  const evidence = new Map();
  for (const record of [...semantic.evidence, ...fromBrief.evidence]) evidence.set(record.evidenceId, record);
  const usedEvidence = new Set([...candidates.values()].flatMap((candidate) => candidate.evidenceIds));
  return {
    candidates: [...candidates.values()],
    evidence: [...evidence.values()].filter((record) => usedEvidence.has(record.evidenceId)),
    unknowns: semantic.unknowns,
  };
}

function persistStorageSelection(projectRoot, selection, storageOwner) {
  const file = storageSelectionFile(projectRoot, selection.storageSelectionId, storageOwner);
  return persistImmutable(file, selection, "Onboarding storage selection");
}

async function rebuildWithOnboardingProjection({
  projectRoot,
  projectId,
  currentProductModelId,
  sourceWorld,
  additionalCandidateSets = [],
  additionalReviewDecisions = [],
  additionalProductModelRevisions = [],
  parentSourceSnapshotIds = null,
  revisionParentIds = null,
}, storageOwner) {
  const sourceGraph = sourceWorld.snapshot.temporalProvenanceGraph;
  const onboardingProjectionInput = loadOnboardingGraphProjection({ storage: storageOwner,
    projectRoot,
    projectId,
    currentProductModelId,
    additionalCandidateSets,
    additionalReviewDecisions,
    additionalProductModelRevisions,
  });
  return (await buildWorldModel({
    root: projectRoot,
    persist: true,
    onboardingProjectionInput,
    parentSourceSnapshotIds: parentSourceSnapshotIds ?? sourceGraph.parentSourceSnapshotIds,
    revisionParentIds: revisionParentIds ?? sourceGraph.revisionParentIds,
  }));
}

async function startOnboardingUncoordinated(options = {}) {
  return (await withProjectMutationAsync({ root: options.root ?? ".", scope: "onboarding-promotion" }, async () => (await startOnboardingLocked(options))));
}

async function proposeOnboardingSemanticRefreshUncoordinated(options = {}) {
  return (await withProjectMutationAsync({ root: options.root ?? ".", scope: "onboarding-promotion" }, async () => (await proposeOnboardingSemanticRefreshLocked(options))));
}

async function proposeOnboardingSemanticRefreshLocked({ root = ".", semanticProposal, recoveryBasis = null } = {}) {
  if (recoveryBasis) return (await recoverableCandidateRefresh({ root, semanticProposal, recoveryBasis }));
  const inspected = readyProject(root, "historical onboarding semantic refresh");
  const storageOwner = inspected.storage;
  if (inspected.state.activeRunId || inspected.state.pendingReview) fail("Semantic refresh cannot change product authority while a Run is active or awaiting review.", "ONBOARDING_RUN_CONFLICT");
  const projectRoot = inspected.project.projectRoot;
  const previousState = ensureOnboardingState(inspected);
  if (previousState.phase !== "ready") fail("Semantic refresh requires ready onboarding state.", "ONBOARDING_REFRESH_NOT_AVAILABLE");
  const historical = readCommittedHistoricalArtifactBoundary({ storage: storageOwner, root: projectRoot, projectId: inspected.project.projectId, allowAbsent: false });
  const previousIsHistorical = Boolean(historicalEntryForPath(historical, `${relativeProjectArtifact(storageOwner, "onboarding", "candidate-sets")}/${previousState.candidateSetId}.json`, "historical-candidate-set"));
  if (!previousIsHistorical && previousState.candidateSetId) readOnboardingCandidateSet({ root: projectRoot, candidateSetId: previousState.candidateSetId });
  if (semanticProposal == null) fail("A fresh current HEAD semantic proposal is required.", "ONBOARDING_SEMANTIC_REPROPOSAL_REQUIRED");
  const productCanon = readProductModelCanon({ storage: storageOwner, projectRoot });
  if (productCanon.status !== "present" || productCanon.model.productModelId !== previousState.productModelId) fail("Product Canon changed before semantic refresh.", "ONBOARDING_PRODUCT_CANON_DRIFT");
  let world;
  try { world = (await inspectWorldModel({ root: projectRoot })); }
  catch (error) { if (!ABSENT_WORLD_CODES.has(error.code)) throw error; }
  if (!world || world.status !== "current") world = await buildWorldModel({ root: projectRoot, persist: true });
  const semantic = candidatesFromSemanticProposal(semanticProposal, world.snapshot, projectRoot, storageOwner);
  const candidateSet = buildCandidateSet({
    projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId,
    inputMode: "existing",
    storageSelectionId: previousState.storageSelectionId,
    worldModel: world.snapshot,
    candidates: semantic.candidates,
    evidence: semantic.evidence,
    unknowns: semantic.unknowns,
    parentCandidateSetIds: previousIsHistorical || !previousState.candidateSetId ? [] : [previousState.candidateSetId],
    producerReviewDecisionId: null,
  }, storageOwner);
  persistImmutable(candidateSetFile(projectRoot, candidateSet.candidateSetId, storageOwner), candidateSet, "Onboarding candidate set");
  const continuityReceipt = previousIsHistorical ? publishHistoricalContinuityReceipt({ storage: storageOwner, root: projectRoot, currentCandidateSet: candidateSet }) : null;
  const projectedWorld = await rebuildWithOnboardingProjection({
    projectRoot,
    projectId: inspected.project.projectId,
    currentProductModelId: productCanon.model.productModelId,
    sourceWorld: world,
  }, storageOwner);
  const phase = candidateSet.candidates.length ? "awaiting-review" : "awaiting-evidence";
  const state = writeState(projectRoot, previousState, {
    phase,
    candidateSetId: candidateSet.candidateSetId,
    latestReviewDecisionId: null,
    productModelId: productCanon.model.productModelId,
    previousProductModelId: productCanon.model.productModelId,
    worldModelId: projectedWorld.snapshot.worldModelId,
    sourceSnapshotId: projectedWorld.snapshot.temporalProvenanceGraph.sourceSnapshotId,
  }, storageOwner);
  return {
    status: phase === "awaiting-review" ? "awaiting_onboarding_review" : "awaiting_onboarding_evidence",
    state,
    candidateSet,
    continuityReceipt,
    historicalCoverage: historical.coverage,
    worldModel: { worldModelId: projectedWorld.snapshot.worldModelId, sourceSnapshotId: projectedWorld.snapshot.temporalProvenanceGraph.sourceSnapshotId,
      graphSnapshotId: projectedWorld.snapshot.temporalProvenanceGraph.graphSnapshotId },
    authority: { candidate: "P3-non-authoritative", continuity: "P3-evidence", productCanonChanged: false },
  };
}

async function startOnboardingLocked({ root = ".", mode = "existing", storage = null, brief = null, semanticProposal = null, sourceScope = null } = {}) {
  const recovered = await recoverOnboardingPromotionLocked({ root });
  if (recovered) return recovered;
  const inspected = readyProject(root, "onboarding start");
  const storageOwner = inspected.storage;
  if (inspected.state.activeRunId || inspected.state.pendingReview) {
    fail("Onboarding cannot change product authority while a Run is active or awaiting review.", "ONBOARDING_RUN_CONFLICT");
  }
  const projectRoot = inspected.project.projectRoot;
  if (brief != null && semanticProposal != null) fail("Onboarding accepts either a user-owned brief or a fresh HEAD semantic proposal, not both.", "ONBOARDING_INPUT_CONFLICT");
  const previousState = ensureOnboardingState(inspected);
  if (new Set(["awaiting-review", "revision-required"]).has(previousState.phase)) {
    fail("The current onboarding candidate set requires review before onboarding can restart.", "ONBOARDING_REVIEW_REQUIRED");
  }
  if (previousState.phase === "ready") fail("Onboarding is already ready.", "ONBOARDING_ALREADY_READY");
  const inputMode = requiredText(mode, "Onboarding mode").toLowerCase();
  if (!new Set(["existing", "new"]).has(inputMode)) fail("Onboarding mode must be existing or new.", "INVALID_ONBOARDING_MODE");
  const selectedSourceScope = sourceScope == null
    ? readRepositorySourceScope({ storage: storageOwner, projectRoot })
    : writeRepositorySourceScope({ storage: storageOwner, projectRoot, selection: sourceScope });
  const normalizedStorage = buildStorageSelection({ projectId: inspected.project.projectId, selection: storage || { mode: "local" } }, storageOwner);
  persistStorageSelection(projectRoot, normalizedStorage, storageOwner);
  const world = await buildWorldModel({ root: projectRoot, persist: true });
  const productCanon = readProductModelCanon({ storage: storageOwner, projectRoot });
  if (productModelHasEntities(productCanon.model)) {
    const state = writeState(projectRoot, previousState, {
      phase: "ready",
      storageSelectionId: normalizedStorage.storageSelectionId,
      worldModelId: world.snapshot.worldModelId,
      sourceSnapshotId: world.snapshot.temporalProvenanceGraph.sourceSnapshotId,
      candidateSetId: null,
      latestReviewDecisionId: null,
      productModelId: productCanon.model.productModelId,
      previousProductModelId: productCanon.model.productModelId,
    }, storageOwner);
    return {
      status: "ready_existing_product_canon",
      state,
      storageSelection: normalizedStorage,
      sourceScope: selectedSourceScope.sourceScope,
      worldModel: { worldModelId: world.snapshot.worldModelId, sourceSnapshotId: world.snapshot.temporalProvenanceGraph.sourceSnapshotId },
      productModel: productCanon.model,
      disclosure: normalizedStorage.mode === "graphdb" ? "GraphDB adapter is pending; onboarding completed on the local conformance path." : "Local materialization is active.",
    };
  }
  const briefInput = normalizedBrief(brief, storageOwner);
  const semantic = semanticProposal == null && briefInput
    ? { candidates: [], evidence: [], unknowns: [] }
    : candidatesFromSemanticProposal(semanticProposal, world.snapshot, projectRoot, storageOwner);
  const briefCandidates = candidatesFromBrief(briefInput, world.snapshot.temporalProvenanceGraph.sourceSnapshotId, storageOwner);
  const merged = mergeCandidateSources(semantic, briefCandidates);
  const candidateSet = buildCandidateSet({
    projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId,
    inputMode,
    storageSelectionId: normalizedStorage.storageSelectionId,
    worldModel: world.snapshot,
    candidates: merged.candidates,
    evidence: merged.evidence,
    unknowns: merged.unknowns,
    parentCandidateSetIds: previousState.candidateSetId ? [previousState.candidateSetId] : [],
    briefEvidenceId: briefInput?.evidenceId || null,
  }, storageOwner);
  const projectedWorld = await rebuildWithOnboardingProjection({
    projectRoot,
    projectId: inspected.project.projectId,
    currentProductModelId: productCanon.model.productModelId,
    sourceWorld: world,
    additionalCandidateSets: [candidateSet],
  }, storageOwner);
  persistImmutable(candidateSetFile(projectRoot, candidateSet.candidateSetId, storageOwner), candidateSet, "Onboarding candidate set");
  const phase = candidateSet.candidates.length ? "awaiting-review" : "awaiting-evidence";
  const state = writeState(projectRoot, previousState, {
    phase,
    storageSelectionId: normalizedStorage.storageSelectionId,
    worldModelId: projectedWorld.snapshot.worldModelId,
    sourceSnapshotId: projectedWorld.snapshot.temporalProvenanceGraph.sourceSnapshotId,
    candidateSetId: candidateSet.candidateSetId,
    latestReviewDecisionId: null,
    productModelId: productCanon.model.productModelId,
    previousProductModelId: productCanon.model.productModelId,
  }, storageOwner);
  return {
    status: phase === "awaiting-review" ? "awaiting_onboarding_review" : "awaiting_onboarding_evidence",
    state,
    storageSelection: normalizedStorage,
    sourceScope: selectedSourceScope.sourceScope,
    candidateSet,
    worldModel: {
      evidenceWorldModelId: world.snapshot.worldModelId,
      projectedWorldModelId: projectedWorld.snapshot.worldModelId,
      sourceSnapshotId: projectedWorld.snapshot.temporalProvenanceGraph.sourceSnapshotId,
      graphSnapshotId: projectedWorld.snapshot.temporalProvenanceGraph.graphSnapshotId,
    },
    disclosure: normalizedStorage.mode === "graphdb" ? "GraphDB adapter is pending; local materialization remains active." : "Local materialization is active.",
  };
}

async function refreshOnboardingCandidatesUncoordinated(options = {}) {
  return (await withProjectMutationAsync({ root: options.root ?? ".", scope: "onboarding-promotion" }, async () => (await recoverableCandidateRefresh(options))));
}

// The exact caller-observed pointer/raw digest also identifies custody after a
// process died between relocation and publication. Never restore over a later
// pointer or an existing file. This restores bytes, not their validity/authority.
function restoreRefreshCustody({ root = ".", recoveryBasis } = {}) {
  if (!recoveryBasis || !/^[a-f0-9]{64}$/.test(recoveryBasis.rawHash || "")) return;
  const inspected = readyProject(root), projectRoot = inspected.project.projectRoot;
  const storageOwner = inspected.storage;
  const state = ensureOnboardingState(inspected);
  if (state.pointerHash !== recoveryBasis.pointerHash || candidateBytes(projectRoot, state.candidateSetId, storageOwner) !== null) return;
  const custody = relativeFile(projectRoot, `${formatForVerifiedOwner(storageOwner).directory}/onboarding/recovery-custody/${state.candidateSetId}--${recoveryBasis.rawHash}.bin`);
  if (!fs.existsSync(custody)) return;
  if (!fs.lstatSync(custody).isFile() || fs.statSync(custody).size > 8 * 1024 * 1024) fail("Invalid recovery custody file.", "ONBOARDING_RECOVERY_CUSTODY_CONFLICT");
  const bytes = fs.readFileSync(custody);
  if (rawHash(bytes) !== recoveryBasis.rawHash) fail("Custody digest differs.", "ONBOARDING_RECOVERY_CUSTODY_CONFLICT");
  fs.writeFileSync(candidateSetFile(projectRoot, state.candidateSetId, storageOwner), bytes, { flag: "wx" });
}

async function recoverableCandidateRefresh(options) {
  restoreRefreshCustody(options);
  try { return await refreshOnboardingCandidatesLocked(options); }
  catch (error) {
    try { restoreRefreshCustody(options); }
    catch (restoreError) { error.custodyRecoveryCode = restoreError.code || "ONBOARDING_RECOVERY_CUSTODY_CONFLICT"; }
    throw error;
  }
}

async function refreshOnboardingCandidatesLocked({ root = ".", semanticProposal = null, recoveryBasis = null } = {}) {
  const recovered = recoveryBasis ? null : await recoverOnboardingPromotionLocked({ root });
  if (recovered) return { ...recovered, refreshed: false };
  const inspected = readyProject(root, "onboarding candidate refresh");
  const storageOwner = inspected.storage;
  if (inspected.state.activeRunId || inspected.state.pendingReview) {
    fail("Onboarding candidate refresh cannot run while a Run is active or awaiting review.", "ONBOARDING_RUN_CONFLICT");
  }
  const projectRoot = inspected.project.projectRoot;
  const state = ensureOnboardingState(inspected);
  if (!new Set(["awaiting-review", "revision-required"]).has(state.phase)) {
    fail("Onboarding candidate refresh requires a review-pending candidate set.", "ONBOARDING_REFRESH_NOT_AVAILABLE");
  }
  const productCanon = readProductModelCanon({ storage: storageOwner, projectRoot });
  if (productCanon.model.productModelId !== state.productModelId) {
    fail("Product Canon changed after candidate proposal; candidate evidence cannot refresh automatically.", "ONBOARDING_PRODUCT_CANON_DRIFT");
  }
  let previousSet;
  let damagedBytes = null;
  if (recoveryBasis) {
    if (recoveryBasis.pointerHash !== state.pointerHash || !Object.hasOwn(recoveryBasis, "rawHash") || !semanticProposal) {
      fail("Candidate recovery requires the current pointer basis and a HEAD semantic proposal.", "ONBOARDING_RECOVERY_CONFLICT");
    }
    damagedBytes = candidateBytes(projectRoot, state.candidateSetId, storageOwner);
    if (rawHash(damagedBytes) !== recoveryBasis.rawHash) fail("Damaged candidate changed.", "ONBOARDING_RECOVERY_CONFLICT");
    if (damagedBytes) {
      let valid = false;
      try { verifyCandidateSet(JSON.parse(damagedBytes), inspected.project.projectId); valid = true; } catch {}
      if (valid) fail("Use normal refresh for a verified candidate.", "ONBOARDING_RECOVERY_NOT_REQUIRED");
    }
    // Unreadable reviews are unknown, never evidence of absence of approval.
    const reviewDir = relativeFile(projectRoot, relativeProjectArtifact(storageOwner, "onboarding", "review-decisions"));
    for (const name of fs.existsSync(reviewDir) ? fs.readdirSync(reviewDir) : []) {
      if (!name.endsWith(".json")) continue;
      const review = verifyReviewDecision(readJson(relativeFile(projectRoot, `${relativeProjectArtifact(storageOwner, "onboarding", "review-decisions")}/${name}`), "ReviewDecision"), inspected.project.projectId);
      if (review.candidateSetId === state.candidateSetId) fail("A reviewed candidate requires exact restoration, not replacement.", "ONBOARDING_RECOVERY_REVIEWED");
    }
    if (onboardingStateLatestReviewDecisionId(state)) fail("Review lineage requires exact restoration.", "ONBOARDING_RECOVERY_REVIEWED");
    const candidateDir = relativeFile(projectRoot, relativeProjectArtifact(storageOwner, "onboarding", "candidate-sets"));
    for (const name of fs.existsSync(candidateDir) ? fs.readdirSync(candidateDir) : []) {
      if (!name.endsWith(".json") || name === `${state.candidateSetId}.json`) continue;
      const other = verifyCandidateSet(readJson(relativeFile(projectRoot, `${relativeProjectArtifact(storageOwner, "onboarding", "candidate-sets")}/${name}`), "Candidate"), inspected.project.projectId);
      if (other.parentCandidateSetIds.includes(state.candidateSetId)) fail("Referenced historical candidate requires exact restoration.", "ONBOARDING_RECOVERY_REFERENCED");
    }
    previousSet = { candidateSetId: state.candidateSetId, productModelId: state.productModelId,
      inputMode: "existing", storageSelectionId: state.storageSelectionId, sourceSnapshotId: state.sourceSnapshotId };
    // Validate meaning and current cited bytes before relocating damaged evidence.
    candidatesFromSemanticProposal(semanticProposal, (await readWorldModelSnapshot({ root, worldModelId: state.worldModelId })).snapshot, projectRoot, storageOwner);
    preserveCandidateBytes(projectRoot, state.candidateSetId, damagedBytes, storageOwner);
    if (rawHash(candidateBytes(projectRoot, state.candidateSetId, storageOwner)) !== recoveryBasis.rawHash) fail("Candidate changed before custody relocation.", "ONBOARDING_RECOVERY_CONFLICT");
    if (damagedBytes) fs.unlinkSync(candidateSetFile(projectRoot, state.candidateSetId, storageOwner));
  } else previousSet = readOnboardingCandidateSet({ root: projectRoot, candidateSetId: state.candidateSetId }).candidateSet;
  if (productCanon.model.productModelId !== state.productModelId || productCanon.model.productModelId !== previousSet.productModelId) {
    fail("Product Canon changed after candidate proposal; candidate evidence cannot refresh automatically.", "ONBOARDING_PRODUCT_CANON_DRIFT");
  }
  let currentWorld;
  try {
    currentWorld = recoveryBasis ? await buildWorldModel({ root: projectRoot, persist: true })
      : await reconcileOrphanedOnboardingProjection({ projectRoot, state, candidateSet: previousSet, world: (await inspectWorldModel({ root: projectRoot })) }, storageOwner);
  } catch (error) {
    if (!ABSENT_WORLD_CODES.has(error.code)) throw error;
    // Explicit Product resume may reconstruct a missing view, never a decision.
    // Read-only status and Core resume do not enter this mutation path.
    await buildWorldModel({ root: projectRoot, persist: true });
    currentWorld = (await inspectWorldModel({ root: projectRoot }));
  }
  if (currentWorld.status === "current" && currentWorld.snapshot.temporalProvenanceGraph.sourceSnapshotId === previousSet.sourceSnapshotId && semanticProposal == null) {
    return { status: "onboarding_candidates_current", refreshed: false, reason: "source-snapshot-current", state, candidateSet: previousSet };
  }
  const world = currentWorld.status === "current" ? currentWorld : await buildWorldModel({ root: projectRoot, persist: true });
  if (world.snapshot.temporalProvenanceGraph.sourceSnapshotId === previousSet.sourceSnapshotId && semanticProposal == null) {
    return { status: "onboarding_candidates_current", refreshed: false, reason: "source-snapshot-current", state, candidateSet: previousSet };
  }
  if (semanticProposal == null) {
    return {
      status: "onboarding_semantic_reproposal_required",
      refreshed: false,
      reason: formatForVerifiedOwner(storageOwner).value("source-snapshot-changed-fresh-head-semantic-proposal-required"),
      state,
      candidateSet: previousSet,
      currentSourceSnapshotId: world.snapshot.temporalProvenanceGraph.sourceSnapshotId,
    };
  }
  const semantic = candidatesFromSemanticProposal(semanticProposal, world.snapshot, projectRoot, storageOwner);
  const candidateSet = buildCandidateSet({
    projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId,
    inputMode: previousSet.inputMode,
    storageSelectionId: previousSet.storageSelectionId,
    worldModel: world.snapshot,
    candidates: semantic.candidates,
    evidence: semantic.evidence,
    unknowns: semantic.unknowns,
    parentCandidateSetIds: recoveryBasis ? [] : [previousSet.candidateSetId],
  }, storageOwner);
  const projectedWorld = await rebuildWithOnboardingProjection({
    projectRoot,
    projectId: inspected.project.projectId,
    currentProductModelId: productCanon.model.productModelId,
    sourceWorld: world,
    additionalCandidateSets: [candidateSet],
  }, storageOwner);
  persistImmutable(candidateSetFile(projectRoot, candidateSet.candidateSetId, storageOwner), candidateSet, "Onboarding candidate set");
  if (recoveryBasis) {
    const final = readyProject(root);
    if (final.state.sessionId !== inspected.state.sessionId || final.state.activeRunId || final.state.pendingReview
      || ensureOnboardingState(final).pointerHash !== state.pointerHash) {
      fail("Onboarding lineage changed during recovery proposal.", "ONBOARDING_RECOVERY_CONFLICT");
    }
  }
  const phase = candidateSet.candidates.length ? "awaiting-review" : "awaiting-evidence";
  const nextState = writeState(projectRoot, state, {
    phase,
    candidateSetId: candidateSet.candidateSetId,
    latestReviewDecisionId: null,
    worldModelId: projectedWorld.snapshot.worldModelId,
    sourceSnapshotId: projectedWorld.snapshot.temporalProvenanceGraph.sourceSnapshotId,
  }, storageOwner);
  return {
    status: "onboarding_candidates_refreshed",
    refreshed: true,
    reason: "source-snapshot-changed",
    state: nextState,
    candidateSet,
    previousCandidateSetId: previousSet.candidateSetId,
    worldModel: {
      worldModelId: projectedWorld.snapshot.worldModelId,
      sourceSnapshotId: projectedWorld.snapshot.temporalProvenanceGraph.sourceSnapshotId,
      graphSnapshotId: projectedWorld.snapshot.temporalProvenanceGraph.graphSnapshotId,
    },
  };
}

function editedCandidates(candidateSet, userEdits, addedEntities = [], removedCandidateIds = [], storageOwner) {
  const edits = new Map();
  for (const [index, edit] of recordList(userEdits, "userEdits").entries()) {
    assertRecordFields(edit, ["candidateId", "entity"], `userEdits[${index}]`);
    const candidateId = requiredText(edit.candidateId, "userEdits.candidateId");
    if (!edit.entity || typeof edit.entity !== "object" || Array.isArray(edit.entity)) fail("userEdits.entity is required.", "INVALID_ONBOARDING_EDIT");
    if (edits.has(candidateId)) fail(`Duplicate edit for ${candidateId}.`, "DUPLICATE_ONBOARDING_EDIT");
    edits.set(candidateId, edit.entity);
  }
  const removed = new Set(textList(removedCandidateIds, "removedCandidateIds"));
  const known = new Map(candidateSet.candidates.map((candidate) => [candidate.candidateId, candidate]));
  for (const candidateId of [...edits.keys(), ...removed]) if (!known.has(candidateId)) {
    fail(`Unknown onboarding candidate: ${candidateId}`, "UNKNOWN_ONBOARDING_CANDIDATE");
  }
  const provisional = candidateSet.candidates.filter((candidate) => !removed.has(candidate.candidateId)).map((candidate) => ({
    kind: candidate.productKind,
    entity: edits.get(candidate.candidateId) || candidate.proposedEntity,
    source: candidate,
  }));
  for (const [index, addition] of recordList(addedEntities, "addedEntities").entries()) {
    assertRecordFields(addition, ["kind", "entity"], `addedEntities[${index}]`);
    if (!PRODUCT_ENTITY_KINDS.includes(addition.kind) || !addition.entity || typeof addition.entity !== "object" || Array.isArray(addition.entity)) {
      fail("addedEntities entries require a supported kind and entity.", "INVALID_ONBOARDING_ADDITION");
    }
    provisional.push({ kind: addition.kind, entity: addition.entity, source: null });
  }
  const document = emptyProductModelDocument();
  for (const item of provisional) document[ARRAY_BY_KIND[item.kind]].push(item.entity);
  const normalized = normalizeProductModelDocument(document, storageOwner);
  const normalizedByIdentity = new Map();
  for (const kind of PRODUCT_ENTITY_KINDS) for (const entity of normalized[ARRAY_BY_KIND[kind]]) {
    normalizedByIdentity.set(`${kind}:${entity.key}`, entity);
  }
  return provisional.map((item) => ({
    ...item,
    entity: normalizedByIdentity.get(`${item.kind}:${String(item.entity.key || "").trim()}`),
  }));
}

function revisionCandidateSet({ candidateSet, revisionItems, reviewDecision, worldModel }, storageOwner) {
  const reviewEvidence = evidenceRecord({
    sourceKind: "onboarding-review-input",
    sourceId: reviewDecision.reviewDecisionId,
    contentDigest: reviewDecision.reviewDecisionHash,
    statement: "User-authored onboarding revision input for a successor candidate set.",
  });
  const evidence = [...candidateSet.evidence, reviewEvidence];
  const candidates = revisionItems.map((item) => candidateArtifact({
    kind: item.kind,
    entity: item.entity,
    evidenceIds: item.source ? [...item.source.evidenceIds, reviewEvidence.evidenceId] : [reviewEvidence.evidenceId],
    explanation: item.source
      ? "The user revised or retained this prior candidate; it remains non-authoritative until a later acceptance review."
      : "The user proposed this entity during revision; it remains non-authoritative until a later acceptance review.",
    confidence: item.source && onboardingCanonicalJson(item.source.proposedEntity) === onboardingCanonicalJson(item.entity) ? item.source.confidence : 1,
    sourceSnapshotId: candidateSet.sourceSnapshotId,
    origin: item.source ? "onboarding-review-revision" : "onboarding-review-addition",
  }, storageOwner));
  return buildCandidateSet({
    projectId: candidateSet.projectId,
    sessionId: candidateSet.sessionId,
    inputMode: candidateSet.inputMode,
    storageSelectionId: candidateSet.storageSelectionId,
    worldModel,
    candidates,
    evidence,
    unknowns: candidateSet.unknowns,
    parentCandidateSetIds: [candidateSet.candidateSetId],
    producerReviewDecisionId: reviewDecision.reviewDecisionId,
    briefEvidenceId: candidateSet.briefEvidenceId,
  }, storageOwner);
}

function mergeAcceptedIntoCanon(previousModel, acceptedItems, storageOwner) {
  const document = productModelDocument(previousModel, storageOwner);
  const existing = new Map();
  for (const kind of PRODUCT_ENTITY_KINDS) for (const entity of document[ARRAY_BY_KIND[kind]]) {
    existing.set(`${kind}:${entity.key}`, entity);
  }
  for (const item of acceptedItems) {
    const identity = `${item.kind}:${item.entity.key}`;
    if (existing.has(identity) && onboardingCanonicalJson(existing.get(identity)) !== onboardingCanonicalJson(item.entity)) {
      fail(`Product Canon conflict for ${identity}.`, "ONBOARDING_PRODUCT_CANON_CONFLICT");
    }
    if (!existing.has(identity)) document[ARRAY_BY_KIND[item.kind]].push(item.entity);
    existing.set(identity, item.entity);
  }
  return normalizeProductModelDocument(document, storageOwner);
}

function buildReviewDecision({ candidateSet, disposition, acceptedCandidateIds, rejectedCandidateIds, userEdits, addedEntities, rationale, previousProductModel, resultingProductModel = null }, storageOwner) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "ReviewDecision",
    protocol: { name: formatForVerifiedOwner(storageOwner).protocol("head-agent-core-onboarding-review"), version: ONBOARDING_REVIEW_VERSION },
    decisionScope: "product-canon-bootstrap",
    projectId: candidateSet.projectId,
    sessionId: candidateSet.sessionId,
    candidateSetId: candidateSet.candidateSetId,
    disposition,
    acceptedCandidateIds: [...acceptedCandidateIds].sort(),
    rejectedCandidateIds: [...rejectedCandidateIds].sort(),
    userEdits,
    addedEntities,
    rationale: requiredText(rationale, "Review rationale"),
    previousProductModelId: previousProductModel.productModelId,
    previousProductModelHash: previousProductModel.productModelHash,
    resultingProductModelId: resultingProductModel?.productModelId || null,
    resultingProductModelHash: resultingProductModel?.productModelHash || null,
    authority: "explicit-user-onboarding-review",
    instructionAuthority: true,
    promotionAuthority: disposition.startsWith("accept"),
    lineage: [
      { relation: "reviews-candidate-set", targetId: candidateSet.candidateSetId },
      { relation: "reviews-product-model", targetId: previousProductModel.productModelId },
      ...(resultingProductModel ? [{ relation: "promotes-to", targetId: resultingProductModel.productModelId }] : []),
    ],
  };
  const hash = onboardingDigest(onboardingCanonicalJson(payload));
  return { ...payload, reviewDecisionId: `onboarding-review-decision-${hash.slice(0, 24)}`, reviewDecisionHash: hash };
}

function verifyReviewDecision(document, projectId = "") {
  if (!document || document.kind !== "ReviewDecision" || document.decisionScope !== "product-canon-bootstrap") {
    fail("Onboarding ReviewDecision is invalid.", "INVALID_ONBOARDING_REVIEW");
  }
  const payload = { ...document };
  delete payload.reviewDecisionId;
  delete payload.reviewDecisionHash;
  const hash = onboardingDigest(onboardingCanonicalJson(payload));
  if (document.reviewDecisionHash !== hash || document.reviewDecisionId !== `onboarding-review-decision-${hash.slice(0, 24)}`) {
    fail("Onboarding ReviewDecision digest verification failed.", "ONBOARDING_REVIEW_DIGEST_MISMATCH");
  }
  if (projectId && document.projectId !== projectId) fail("Onboarding ReviewDecision belongs to another project.", "ONBOARDING_PROJECT_MISMATCH");
  if (!new Set(["accept-all", "accept-selection", "revise", "reject"]).has(document.disposition)) {
    fail("Onboarding ReviewDecision disposition is invalid.", "INVALID_ONBOARDING_REVIEW");
  }
  return document;
}

export function readOnboardingReviewDecision({ root = ".", reviewDecisionId } = {}) {
  const inspected = readyProject(root, "onboarding review inspection");
  const storageOwner = inspected.storage;
  const file = reviewDecisionFile(inspected.project.projectRoot, reviewDecisionId, storageOwner);
  if (!fs.existsSync(file)) fail(`Onboarding ReviewDecision not found: ${reviewDecisionId}`, "ONBOARDING_REVIEW_NOT_FOUND");
  const historical = readCommittedHistoricalArtifactBoundary({ storage: storageOwner, root: inspected.project.projectRoot, projectId: inspected.project.projectId, allowAbsent: true });
  const historicalEntry = historicalEntryForPath(historical, `${relativeProjectArtifact(storageOwner, "onboarding", "review-decisions")}/${reviewDecisionId}.json`, "historical-review");
  if (historicalEntry) return { status: "historical-ready-opaque", file, reviewDecision: null, historicalArtifact: historicalEntry, historicalBoundaryId: historical.boundary.boundaryId };
  const reviewDecision = verifyReviewDecision(readJson(file, "Onboarding ReviewDecision"), inspected.project.projectId);
  if (reviewDecision.reviewDecisionId !== reviewDecisionId) fail("Onboarding ReviewDecision identity does not match its requested file.", "ONBOARDING_REVIEW_IDENTITY_MISMATCH");
  const candidateSet = readOnboardingCandidateSet({ root: inspected.project.projectRoot, candidateSetId: reviewDecision.candidateSetId }).candidateSet;
  verifyOnboardingReviewDecisionForProjection(reviewDecision, candidateSet, inspected.project.projectId);
  if (candidateSet.sessionId !== reviewDecision.sessionId) fail("Onboarding ReviewDecision Session identity is invalid.", "ONBOARDING_SESSION_MISMATCH");
  const known = new Set(candidateSet.candidates.map((candidate) => candidate.candidateId));
  const accepted = new Set(reviewDecision.acceptedCandidateIds || []);
  const rejected = new Set(reviewDecision.rejectedCandidateIds || []);
  if ([...accepted, ...rejected].some((candidateId) => !known.has(candidateId))
    || [...accepted].some((candidateId) => rejected.has(candidateId))) {
    fail("Onboarding ReviewDecision candidate references are invalid.", "INVALID_ONBOARDING_REVIEW");
  }
  const accepting = reviewDecision.disposition.startsWith("accept");
  if (reviewDecision.promotionAuthority !== accepting
    || (accepting && (!reviewDecision.resultingProductModelId || !reviewDecision.resultingProductModelHash))
    || (!accepting && (reviewDecision.resultingProductModelId || reviewDecision.resultingProductModelHash))) {
    fail("Onboarding ReviewDecision promotion fields are invalid.", "INVALID_ONBOARDING_REVIEW");
  }
  return { status: "verified", file, reviewDecision };
}

function productModelRevisionDocument(model, storageOwner) {
  if (!storageOwner?.projectId) fail("Product revision requires a verified Project owner.", "PROJECT_IDENTITY_MISMATCH");
  return {
    schemaVersion: 1,
    kind: "ProductModelRevision",
    projectId: storageOwner.projectId,
    productModelId: model.productModelId,
    productModelHash: model.productModelHash,
    document: productModelDocument(model, storageOwner),
    authority: "user-owned-project-canon-revision",
  };
}

function persistProductRevision(projectRoot, model, storageOwner) {
  const revision = productModelRevisionDocument(model, storageOwner);
  const file = relativeFile(projectRoot, `${relativeProjectArtifact(storageOwner, "onboarding", "product-model-revisions")}/${model.productModelId}.json`);
  const intended = fs.existsSync(file) ? productModelRevisionForImmutableRetry(readJson(file, "Product Model revision"), revision, storageOwner) : revision;
  return persistImmutable(
    file,
    intended,
    "Product Model revision",
  );
}

function readProductRevision(projectRoot, productModelId, storageOwner) {
  if (!/^product-model-[a-f0-9]{24}$/.test(productModelId || "")) {
    fail("Product Model revision id is invalid.", "INVALID_PRODUCT_MODEL_REVISION");
  }
  const file = relativeFile(projectRoot, `${relativeProjectArtifact(storageOwner, "onboarding", "product-model-revisions")}/${productModelId}.json`);
  if (!fs.existsSync(file)) fail(`Product Model revision is missing: ${productModelId}`, "PRODUCT_MODEL_REVISION_MISSING");
  const revision = readJson(file, "Product Model revision");
  const normalized = normalizeProductModelDocument(revision.document, storageOwner);
  if (revision.kind !== "ProductModelRevision"
    || revision.productModelId !== productModelId
    || revision.productModelId !== normalized.productModelId
    || revision.productModelHash !== normalized.productModelHash
    || revision.authority !== "user-owned-project-canon-revision") {
    fail("Product Model revision digest verification failed.", "PRODUCT_MODEL_REVISION_DIGEST_MISMATCH");
  }
  verifyProductModelRevisionForProjection(revision, storageOwner);
  return { file, revision };
}

function decisionForCandidate(projectRoot, candidateSetId, storageOwner) {
  if (!candidateSetId) return null;
  const directory = relativeFile(projectRoot, relativeProjectArtifact(storageOwner, "onboarding", "review-decisions"));
  if (!fs.existsSync(directory)) return null;
  const decisions = [];
  for (const name of fs.readdirSync(directory).sort()) {
    if (!/^onboarding-review-decision-[a-f0-9]{24}\.json$/.test(name)) continue;
    const document = readJson(relativeFile(projectRoot, `${relativeProjectArtifact(storageOwner, "onboarding", "review-decisions")}/${name}`), "Onboarding ReviewDecision");
    if (document.candidateSetId !== candidateSetId) continue;
    decisions.push(readOnboardingReviewDecision({ root: projectRoot, reviewDecisionId: name.slice(0, -5) }).reviewDecision);
  }
  if (decisions.length > 1) fail("The candidate set has conflicting durable decisions.", "ONBOARDING_REVIEW_CONFLICT");
  return decisions[0] || null;
}

function verifiedPromotion({ projectRoot, state, review, allowUnpublishedReview = false }, storageOwner) {
  const decisionFile = reviewDecisionFile(projectRoot, review.reviewDecisionId, storageOwner);
  if (fs.existsSync(decisionFile)) {
    const durable = readOnboardingReviewDecision({ root: projectRoot, reviewDecisionId: review.reviewDecisionId }).reviewDecision;
    if (durable.reviewDecisionHash !== review.reviewDecisionHash) fail("Onboarding decision changed during application.", "ONBOARDING_REVIEW_CONFLICT");
  } else if (!allowUnpublishedReview) {
    fail("Approved onboarding recovery requires its durable decision.", "ONBOARDING_REVIEW_NOT_FOUND");
  }
  const candidateSet = readOnboardingCandidateSet({ root: projectRoot, candidateSetId: review.candidateSetId }).candidateSet;
  const canon = readProductModelCanon({ storage: storageOwner, projectRoot });
  if (![review.previousProductModelId, review.resultingProductModelId].includes(canon.model.productModelId)
    || ![review.previousProductModelId, review.resultingProductModelId].includes(state.productModelId)) {
    fail("A later Product Canon or onboarding state cannot be overwritten by an earlier review.", "ONBOARDING_PRODUCT_CANON_DRIFT");
  }
  const previousFile = relativeFile(projectRoot, `${relativeProjectArtifact(storageOwner, "onboarding", "product-model-revisions")}/${review.previousProductModelId}.json`);
  const previous = fs.existsSync(previousFile) ? readProductRevision(projectRoot, review.previousProductModelId, storageOwner).revision
    : canon.model.productModelId === review.previousProductModelId ? productModelRevisionDocument(canon.model, storageOwner) : null;
  if (!previous) fail("The approved promotion's previous Product revision is unavailable.", "PRODUCT_MODEL_REVISION_MISSING");
  const selected = new Set(review.acceptedCandidateIds);
  const reviewedItems = editedCandidates(candidateSet, review.userEdits, [], [], storageOwner).filter((item) => selected.has(item.source.candidateId));
  const expected = mergeAcceptedIntoCanon(normalizeProductModelDocument(previous.document, storageOwner), reviewedItems, storageOwner);
  const resultingFile = relativeFile(projectRoot, `${relativeProjectArtifact(storageOwner, "onboarding", "product-model-revisions")}/${review.resultingProductModelId}.json`);
  const resulting = fs.existsSync(resultingFile) ? readProductRevision(projectRoot, review.resultingProductModelId, storageOwner).revision
    : productModelRevisionDocument(expected, storageOwner);
  if (review.sessionId !== state.sessionId || review.candidateSetId !== state.candidateSetId
    || previous.productModelHash !== review.previousProductModelHash
    || resulting.productModelHash !== review.resultingProductModelHash
    || expected.productModelHash !== review.resultingProductModelHash) {
    fail("Onboarding promotion does not match its approved Product revisions.", "ONBOARDING_REVIEW_CONFLICT");
  }
  if (state.phase === "ready") {
    if (onboardingStateLatestReviewDecisionId(state) !== review.reviewDecisionId
      || state.productModelId !== review.resultingProductModelId
      || canon.model.productModelId !== review.resultingProductModelId) {
      fail("Completed onboarding does not match its acceptance decision.", "ONBOARDING_REVIEW_CONFLICT");
    }
  } else {
    if (!["awaiting-review", "revision-required"].includes(state.phase)
      || state.productModelId !== review.previousProductModelId) {
      fail("Onboarding promotion has an incompatible current phase.", "ONBOARDING_REVIEW_CONFLICT");
    }
    const prior = onboardingStateLatestReviewDecisionId(state);
    if (prior !== onboardingCandidateProducerReviewDecisionId(candidateSet)) {
      fail("Onboarding promotion cannot replace a later disposition.", "ONBOARDING_REVIEW_CONFLICT");
    }
  }
  return { candidateSet, previous, resulting, canon };
}

function promotionResult({ state, review, productModel, world, reasonCode = null }) {
  return {
    status: reasonCode ? "onboarding_approved_projection_pending" : "onboarding_ready",
    state,
    reviewDecision: review,
    productModel,
    productCanonChanged: true,
    ...(reasonCode ? { projection: { status: "refresh_required", reasonCode, ordinaryWorkBlocked: false, userReviewRequired: false } } : {}),
    worldModel: world ? {
      worldModelId: world.snapshot.worldModelId,
      sourceSnapshotId: world.snapshot.temporalProvenanceGraph.sourceSnapshotId,
      graphSnapshotId: world.snapshot.temporalProvenanceGraph.graphSnapshotId,
    } : null,
  };
}

// The already durable P1 ReviewDecision is the commit intent. Recovery never
// creates approval from a graph, a transaction receipt, or a caller's retry.
async function applyApprovedPromotion({ projectRoot, state, review, publishReview = false }, storageOwner) {
  if (!publishReview && state.phase === "ready") {
    const verified = verifiedPromotion({ projectRoot, state, review }, storageOwner);
    if (state.sourceSnapshotId !== verified.candidateSet.sourceSnapshotId) {
      let world = null;
      let reasonCode = null;
      try {
        world = (await inspectWorldModel({ root: projectRoot }));
        if (world.status !== "current") reasonCode = "WORLD_MODEL_STALE";
      } catch (error) { if (!ABSENT_WORLD_CODES.has(error.code)) throw error; reasonCode = error.code; }
      return { ...promotionResult({ state, review, productModel: normalizeProductModelDocument(verified.resulting.document, storageOwner), world, reasonCode }), productCanonChanged: false };
    }
  }
  const prepared = withProjectMutation({ root: projectRoot, scope: "session-recovery" }, () => {
    const { candidateSet, previous, resulting, canon } = verifiedPromotion({ projectRoot, state, review, allowUnpublishedReview: publishReview }, storageOwner);
    const inspected = readyProject(projectRoot, "onboarding promotion recovery");
    if (inspected.state.sessionId !== state.sessionId || inspected.state.activeRunId || inspected.state.pendingReview) {
      fail("Onboarding promotion cannot replace current Session or active Run authority.", "ONBOARDING_RUN_CONFLICT");
    }
    if (publishReview) persistImmutable(reviewDecisionFile(projectRoot, review.reviewDecisionId, storageOwner), review, "Onboarding ReviewDecision");
    const nextModel = normalizeProductModelDocument(resulting.document, storageOwner);
    persistProductRevision(projectRoot, normalizeProductModelDocument(previous.document, storageOwner), storageOwner);
    persistProductRevision(projectRoot, nextModel, storageOwner);
    if (canon.model.productModelId !== review.resultingProductModelId) {
      atomicWrite(relativeFile(projectRoot, relativeProjectArtifact(storageOwner, "context", "product-model.json")), json(resulting.document));
    }
    let nextState = state;
    if (state.phase !== "ready") {
      // Canon and its authority pointer converge before any awaited derived work.
      // The old World remains visibly stale until the rebuild is verified.
      nextState = writeState(projectRoot, state, {
        phase: "ready",
        latestReviewDecisionId: review.reviewDecisionId,
        productModelId: review.resultingProductModelId,
        previousProductModelId: review.previousProductModelId,
      }, storageOwner);
    }
    return { candidateSet, nextModel, nextState, inspected };
  });
  const { candidateSet, nextModel, inspected } = prepared;
  let { nextState } = prepared;
  try {
    let currentWorld = null;
    try { currentWorld = (await inspectWorldModel({ root: projectRoot })); }
    catch (error) { if (!ABSENT_WORLD_CODES.has(error.code)) throw error; }
    const alreadyProjected = currentWorld?.status === "current"
      && currentWorld.snapshot.productModel.productModelId === nextModel.productModelId
      && currentWorld.snapshot.temporalProvenanceGraph.parentSourceSnapshotIds.includes(candidateSet.sourceSnapshotId)
      && currentWorld.snapshot.temporalProvenanceGraph.onboardingProjection.reviewDecisionIds.includes(review.reviewDecisionId);
    const rebuilt = alreadyProjected ? currentWorld : await rebuildWithOnboardingProjection({
      projectRoot,
      projectId: inspected.project.projectId,
      currentProductModelId: nextModel.productModelId,
      sourceWorld: currentWorld || { snapshot: { temporalProvenanceGraph: {} } },
      parentSourceSnapshotIds: [candidateSet.sourceSnapshotId],
      revisionParentIds: {},
    }, storageOwner);
    const verifiedWorld = (await inspectWorldModel({ root: projectRoot }));
    if (verifiedWorld.status !== "current"
      || rebuilt.snapshot.productModel.productModelId !== nextModel.productModelId
      || rebuilt.snapshot.temporalProvenanceGraph.productModelId !== nextModel.productModelId
      || !rebuilt.snapshot.temporalProvenanceGraph.parentSourceSnapshotIds.includes(candidateSet.sourceSnapshotId)
      || !rebuilt.snapshot.temporalProvenanceGraph.onboardingProjection.reviewDecisionIds.includes(review.reviewDecisionId)
      || !rebuilt.snapshot.temporalProvenanceGraph.onboardingProjection.productModelRevisionIds.includes(nextModel.productModelId)) {
      fail("Approved Product Canon did not produce the expected verified GraphSnapshot.", "ONBOARDING_GRAPH_VERIFICATION_FAILED");
    }
    withProjectMutation({ root: projectRoot, scope: "session-recovery" }, () => {
      const after = ensureOnboardingState(readyProject(projectRoot));
      verifiedPromotion({ projectRoot, state: after, review }, storageOwner);
      if (after.pointerHash !== nextState.pointerHash) {
        fail("Onboarding state changed during projection rebuild.", "ONBOARDING_REVIEW_CONFLICT");
      }
      if (nextState.worldModelId !== rebuilt.snapshot.worldModelId
        || nextState.sourceSnapshotId !== rebuilt.snapshot.temporalProvenanceGraph.sourceSnapshotId) {
        nextState = writeState(projectRoot, nextState, {
          worldModelId: rebuilt.snapshot.worldModelId,
          sourceSnapshotId: rebuilt.snapshot.temporalProvenanceGraph.sourceSnapshotId,
        }, storageOwner);
      }
    });
    return promotionResult({ state: nextState, review, productModel: nextModel, world: rebuilt });
  } catch (error) {
    // Approval remains P1 even when optional P4 materialization fails. Do not
    // roll back newer Canon or make the user repeat an already durable decision.
    verifiedPromotion({ projectRoot, state: ensureOnboardingState(readyProject(projectRoot)), review }, storageOwner);
    if (["ONBOARDING_REVIEW_CONFLICT", "ONBOARDING_PRODUCT_CANON_DRIFT", "ONBOARDING_RUN_CONFLICT", "ONBOARDING_STATE_IDENTITY_MISMATCH"].includes(error.code)) throw error;
    return promotionResult({ state: nextState, review, productModel: nextModel, world: null, reasonCode: error.code || "ONBOARDING_GRAPH_REBUILD_FAILED" });
  }
}

function normalizedReviewEdits(candidateSet, userEdits, addedEntities, removedCandidateIds, storageOwner) {
  const revisionItems = editedCandidates(candidateSet, userEdits, addedEntities, removedCandidateIds, storageOwner);
  const normalizedUserEdits = recordList(userEdits, "userEdits").map((edit) => {
    const revised = revisionItems.find((item) => item.source?.candidateId === edit.candidateId);
    if (!revised) fail(`Edited candidate was removed or is unavailable: ${edit.candidateId}`, "INVALID_ONBOARDING_EDIT");
    return { candidateId: edit.candidateId, entity: revised.entity };
  }).sort((left, right) => compareText(left.candidateId, right.candidateId));
  const normalizedAddedEntities = revisionItems.filter((item) => !item.source)
    .map((item) => ({ kind: item.kind, entity: item.entity }))
    .sort((left, right) => (KIND_ORDER.get(left.kind) - KIND_ORDER.get(right.kind)) || compareText(left.entity.key, right.entity.key));
  return { revisionItems, normalizedUserEdits, normalizedAddedEntities };
}

function verifiedNonPromotion({ projectRoot, state, review, allowUnpublishedReview = false }, storageOwner) {
  if (!["revise", "reject"].includes(review.disposition)) fail("A non-promoting decision is required.", "INVALID_ONBOARDING_REVIEW");
  if (fs.existsSync(reviewDecisionFile(projectRoot, review.reviewDecisionId, storageOwner))) {
    const durable = readOnboardingReviewDecision({ root: projectRoot, reviewDecisionId: review.reviewDecisionId }).reviewDecision;
    if (durable.reviewDecisionHash !== review.reviewDecisionHash) fail("Onboarding decision changed during application.", "ONBOARDING_REVIEW_CONFLICT");
  } else if (!allowUnpublishedReview) fail("Onboarding recovery requires its durable decision.", "ONBOARDING_REVIEW_NOT_FOUND");
  const candidateSet = readOnboardingCandidateSet({ root: projectRoot, candidateSetId: review.candidateSetId }).candidateSet;
  const canon = readProductModelCanon({ storage: storageOwner, projectRoot });
  if (canon.model.productModelHash !== review.previousProductModelHash || state.productModelId !== review.previousProductModelId
    || candidateSet.productModelId !== review.previousProductModelId) {
    fail("A reviewed disposition cannot replace later Product Canon.", "ONBOARDING_PRODUCT_CANON_DRIFT");
  }
  if (review.sessionId !== state.sessionId || review.projectId !== state.projectId) fail("Onboarding decision belongs to another Session.", "ONBOARDING_SESSION_MISMATCH");
  const successor = review.disposition === "revise" ? revisionCandidateSet({
    candidateSet,
    revisionItems: editedCandidates(candidateSet, review.userEdits, review.addedEntities, review.rejectedCandidateIds, storageOwner),
    reviewDecision: review,
    // These exact source identities belong to the reviewed immutable candidate;
    // a newer or missing P4 World cannot change the successor's meaning or ID.
    worldModel: { productModel: { productModelId: review.previousProductModelId }, temporalProvenanceGraph: { sourceSnapshotId: candidateSet.sourceSnapshotId } },
  }, storageOwner) : null;
  const applied = onboardingStateLatestReviewDecisionId(state) === review.reviewDecisionId
    && (successor ? state.candidateSetId === successor.candidateSetId && ["awaiting-review", "awaiting-evidence"].includes(state.phase)
      : state.candidateSetId === candidateSet.candidateSetId && state.phase === "rejected");
  if (successor && fs.existsSync(candidateSetFile(projectRoot, successor.candidateSetId, storageOwner))) {
    const stored = readOnboardingCandidateSet({ root: projectRoot, candidateSetId: successor.candidateSetId }).candidateSet;
    if (stored.candidateSetHash !== successor.candidateSetHash) fail("Onboarding successor differs from its reviewed inputs.", "ONBOARDING_REVIEW_CONFLICT");
  } else if (successor && applied) fail("The applied revision is missing its successor candidate set.", "ONBOARDING_CANDIDATE_SET_NOT_FOUND");
  if (!applied && (state.candidateSetId !== candidateSet.candidateSetId
    || !["awaiting-review", "awaiting-evidence", "revision-required"].includes(state.phase)
    || onboardingStateLatestReviewDecisionId(state) !== onboardingCandidateProducerReviewDecisionId(candidateSet))) {
    fail("A historical disposition cannot replace later onboarding direction.", "ONBOARDING_REVIEW_CONFLICT");
  }
  const projectedWorld = null;
  return { candidateSet, successor, canon, applied, projectedWorld };
}

// P4 lookup stays outside the synchronous Canon application scope.
async function projectedNonPromotionWorld({ projectRoot, state, review, verified }) {
  if (!verified.applied || !state.worldModelId) return null;
  try {
    const stored = await readWorldModelSnapshot({ root: projectRoot, worldModelId: state.worldModelId });
    const projection = stored.snapshot.temporalProvenanceGraph.onboardingProjection;
    return projection.reviewDecisionIds.includes(review.reviewDecisionId)
      && (!verified.successor || projection.candidateSetIds.includes(verified.successor.candidateSetId)) ? stored : null;
  } catch (error) { if (!ABSENT_WORLD_CODES.has(error.code)) throw error; return null; }
}

function nonPromotionResult({ state, review, successor, world, reasonCode = null }) {
  return {
    status: reasonCode ? "onboarding_review_projection_pending" : review.disposition === "revise" ? "onboarding_revision_awaiting_review" : "onboarding_rejected",
    state, reviewDecision: review, productCanonChanged: false,
    ...(successor ? { candidateSet: successor } : {}),
    ...(reasonCode ? { projection: { status: "refresh_required", reasonCode, ordinaryWorkBlocked: false, userReviewRequired: false } } : {}),
    worldModel: world ? { worldModelId: world.snapshot.worldModelId,
      sourceSnapshotId: world.snapshot.temporalProvenanceGraph.sourceSnapshotId,
      graphSnapshotId: world.snapshot.temporalProvenanceGraph.graphSnapshotId } : null,
  };
}

async function applyNonPromotingReview({ projectRoot, state, review, publishReview = false }, storageOwner) {
  const prepared = withProjectMutation({ root: projectRoot, scope: "session-recovery" }, () => {
    const verified = verifiedNonPromotion({ projectRoot, state, review, allowUnpublishedReview: publishReview }, storageOwner);
    const inspected = readyProject(projectRoot, "onboarding review recovery");
    if (inspected.state.sessionId !== state.sessionId || inspected.state.activeRunId || inspected.state.pendingReview) fail("Onboarding review conflicts with current Session or Run.", "ONBOARDING_RUN_CONFLICT");
    if (ensureOnboardingState(inspected).pointerHash !== state.pointerHash) fail("Onboarding state changed before review application.", "ONBOARDING_REVIEW_CONFLICT");
    if (publishReview) persistImmutable(reviewDecisionFile(projectRoot, review.reviewDecisionId, storageOwner), review, "Onboarding ReviewDecision");
    if (verified.successor) persistImmutable(candidateSetFile(projectRoot, verified.successor.candidateSetId, storageOwner), verified.successor, "Onboarding candidate set");
    const nextState = verified.applied ? state : writeState(projectRoot, state, {
      phase: verified.successor ? verified.successor.candidates.length ? "awaiting-review" : "awaiting-evidence" : "rejected",
      candidateSetId: verified.successor?.candidateSetId || verified.candidateSet.candidateSetId,
      latestReviewDecisionId: review.reviewDecisionId,
      sourceSnapshotId: verified.candidateSet.sourceSnapshotId,
    }, storageOwner);
    return { ...verified, state: nextState };
  });
  let nextState = prepared.state;
  if (prepared.applied && state.worldModelId) {
    try {
      const stored = await readWorldModelSnapshot({ root: projectRoot, worldModelId: state.worldModelId });
      const projection = stored.snapshot.temporalProvenanceGraph.onboardingProjection;
      if (projection.reviewDecisionIds.includes(review.reviewDecisionId)
        && (!prepared.successor || projection.candidateSetIds.includes(prepared.successor.candidateSetId))) prepared.projectedWorld = stored;
    } catch (error) { if (!ABSENT_WORLD_CODES.has(error.code)) throw error; }
  }
  if (prepared.projectedWorld) {
    let reasonCode = null;
    try { if ((await inspectWorldModel({ root: projectRoot })).status !== "current") reasonCode = "WORLD_MODEL_STALE"; }
    catch (error) { if (!ABSENT_WORLD_CODES.has(error.code)) throw error; reasonCode = error.code; }
    return nonPromotionResult({ state: nextState, review, successor: prepared.successor, world: prepared.projectedWorld, reasonCode });
  }
  try {
    let sourceWorld = { snapshot: { temporalProvenanceGraph: {} } };
    try { sourceWorld = (await readWorldModelSnapshot({ root: projectRoot, worldModelId: state.worldModelId })); }
    catch (error) { if (!ABSENT_WORLD_CODES.has(error.code)) throw error; }
    const world = await rebuildWithOnboardingProjection({ projectRoot, projectId: state.projectId,
      currentProductModelId: prepared.canon.model.productModelId, sourceWorld,
      parentSourceSnapshotIds: sourceWorld.snapshot.temporalProvenanceGraph.parentSourceSnapshotIds || [],
      revisionParentIds: sourceWorld.snapshot.temporalProvenanceGraph.revisionParentIds || {},
    }, storageOwner);
    const current = (await inspectWorldModel({ root: projectRoot }));
    const graph = world.snapshot.temporalProvenanceGraph;
    if (current.status !== "current" || !graph.onboardingProjection.reviewDecisionIds.includes(review.reviewDecisionId)
      || (prepared.successor && !graph.onboardingProjection.candidateSetIds.includes(prepared.successor.candidateSetId))) fail("The reviewed disposition projection did not verify.", "ONBOARDING_GRAPH_VERIFICATION_FAILED");
    withProjectMutation({ root: projectRoot, scope: "session-recovery" }, () => {
      const after = ensureOnboardingState(readyProject(projectRoot));
      verifiedNonPromotion({ projectRoot, state: after, review }, storageOwner);
      if (after.pointerHash !== nextState.pointerHash) fail("Onboarding state changed during projection.", "ONBOARDING_REVIEW_CONFLICT");
      if (after.worldModelId !== world.snapshot.worldModelId || after.sourceSnapshotId !== graph.sourceSnapshotId) {
        nextState = writeState(projectRoot, after, { worldModelId: world.snapshot.worldModelId, sourceSnapshotId: graph.sourceSnapshotId }, storageOwner);
      }
    });
    return nonPromotionResult({ state: nextState, review, successor: prepared.successor, world });
  } catch (error) {
    verifiedNonPromotion({ projectRoot, state: ensureOnboardingState(readyProject(projectRoot)), review }, storageOwner);
    if (["ONBOARDING_REVIEW_CONFLICT", "ONBOARDING_PRODUCT_CANON_DRIFT", "ONBOARDING_RUN_CONFLICT", "ONBOARDING_STATE_IDENTITY_MISMATCH"].includes(error.code)) throw error;
    return nonPromotionResult({ state: nextState, review, successor: prepared.successor, world: null, reasonCode: error.code || "ONBOARDING_GRAPH_REBUILD_FAILED" });
  }
}

function nonPromotingDecisionForState(projectRoot, state, own = null, storageOwner) {
  own ??= decisionForCandidate(projectRoot, state.candidateSetId, storageOwner);
  if (own) return own.promotionAuthority ? null : own;
  const latestId = onboardingStateLatestReviewDecisionId(state);
  if (!latestId || !state.candidateSetId) return null;
  const latest = readOnboardingReviewDecision({ root: projectRoot, reviewDecisionId: latestId }).reviewDecision;
  const candidate = readOnboardingCandidateSet({ root: projectRoot, candidateSetId: state.candidateSetId }).candidateSet;
  return latest.disposition === "revise" && onboardingCandidateProducerReviewDecisionId(candidate) === latestId ? latest : null;
}

async function reconcileOrphanedOnboardingProjection({ projectRoot, state, candidateSet, world }, storageOwner) {
  const changes = world.changes;
  const onlyOnboardingChanged = changes.onboardingProjectionChanged
    && Object.entries(changes).every(([key, value]) => ["onboardingProjectionChanged", "temporalProvenanceChanged"].includes(key)
      || (Array.isArray(value) ? value.length === 0 : value === false));
  if (world.status === "current" || !onlyOnboardingChanged) return world;
  // Older code could publish a P4 graph containing a decision that never reached
  // its P1 file. Rebuild from persisted records; never extract that decision.
  let sourceWorld = world;
  try { sourceWorld = (await readWorldModelSnapshot({ root: projectRoot, worldModelId: state.worldModelId })); }
  catch (error) { if (!ABSENT_WORLD_CODES.has(error.code)) throw error; }
  await rebuildWithOnboardingProjection({ projectRoot, projectId: state.projectId,
    currentProductModelId: state.productModelId, sourceWorld,
  }, storageOwner);
  const current = (await inspectWorldModel({ root: projectRoot }));
  if (current.status !== "current" || current.snapshot.temporalProvenanceGraph.sourceSnapshotId !== candidateSet.sourceSnapshotId) {
    fail("Canonical evidence changed while reconciling the orphaned projection.", "ONBOARDING_SOURCE_DRIFT");
  }
  return current;
}

async function recoverOnboardingPromotionLocked({ root = "." } = {}) {
  const inspected = readyProject(root, "onboarding promotion recovery");
  const storageOwner = inspected.storage;
  const projectRoot = inspected.project.projectRoot;
  if (!fs.existsSync(stateFile(projectRoot, storageOwner))) return null;
  const state = ensureOnboardingState(inspected);
  const historical = readCommittedHistoricalArtifactBoundary({ storage: storageOwner, root: projectRoot, projectId: inspected.project.projectId, allowAbsent: true });
  if (state.candidateSetId && historicalEntryForPath(historical, `${relativeProjectArtifact(storageOwner, "onboarding", "candidate-sets")}/${state.candidateSetId}.json`, "historical-candidate-set")) {
    if (state.phase !== "ready") fail("Opaque historical onboarding cannot execute promotion recovery.", "ONBOARDING_HISTORICAL_RECOVERY_RETIRED");
    return null;
  }
  const own = decisionForCandidate(projectRoot, state.candidateSetId, storageOwner);
  const nonPromoting = nonPromotingDecisionForState(projectRoot, state, own, storageOwner);
  if (nonPromoting) {
    const verified = verifiedNonPromotion({ projectRoot, state, review: nonPromoting }, storageOwner);
    verified.projectedWorld = await projectedNonPromotionWorld({ projectRoot, state, review: nonPromoting, verified });
    return verified.projectedWorld ? null : (await applyNonPromotingReview({ projectRoot, state, review: nonPromoting }, storageOwner));
  }
  const review = own?.promotionAuthority ? own : null;
  if (!review) return null;
  // A completed historical review is not a request to refresh every later World.
  if (state.phase === "ready" && state.sourceSnapshotId !== readOnboardingCandidateSet({ root: projectRoot, candidateSetId: review.candidateSetId }).candidateSet.sourceSnapshotId) return null;
  return (await applyApprovedPromotion({ projectRoot, state, review }, storageOwner));
}

async function recoverOnboardingPromotionUncoordinated(options = {}) {
  return (await withProjectMutationAsync({ root: options.root ?? ".", scope: "onboarding-promotion" }, async () => (await recoverOnboardingPromotionLocked(options))));
}

async function reviewOnboardingUncoordinated(options = {}) {
  return (await withProjectMutationAsync({ root: options.root ?? ".", scope: "onboarding-promotion" }, async () => (await reviewOnboardingLocked(options))));
}

function assertAcceptanceReplay({ projectRoot, state, candidateSet, review, disposition, acceptedCandidateIds, removedCandidateIds, userEdits, addedEntities, rationale }, storageOwner) {
  const normalizedDisposition = requiredText(disposition, "Review disposition").toLowerCase();
  if (!normalizedDisposition.startsWith("accept") || removedCandidateIds.length || addedEntities.length) {
    fail("The candidate set already has a different durable user decision.", "ONBOARDING_REVIEW_REPLAY_CONFLICT");
  }
  const previous = normalizeProductModelDocument(verifiedPromotion({ projectRoot, state, review }, storageOwner).previous.document, storageOwner);
  const items = editedCandidates(candidateSet, userEdits, [], [], storageOwner);
  const selectedIds = normalizedDisposition === "accept-all" ? candidateSet.candidates.map((item) => item.candidateId) : textList(acceptedCandidateIds, "acceptedCandidateIds");
  const selected = new Set(selectedIds);
  const edits = recordList(userEdits, "userEdits").map((edit) => ({
    candidateId: edit.candidateId,
    entity: items.find((item) => item.source?.candidateId === edit.candidateId).entity,
  })).sort((left, right) => compareText(left.candidateId, right.candidateId));
  const requested = buildReviewDecision({
    candidateSet,
    disposition: normalizedDisposition,
    acceptedCandidateIds: selectedIds,
    rejectedCandidateIds: candidateSet.candidates.map((item) => item.candidateId).filter((id) => !selected.has(id)),
    userEdits: edits,
    addedEntities: [],
    rationale,
    previousProductModel: previous,
    resultingProductModel: mergeAcceptedIntoCanon(previous, items.filter((item) => selected.has(item.source.candidateId)), storageOwner),
  }, storageOwner);
  if (requested.reviewDecisionHash !== review.reviewDecisionHash) {
    fail("A divergent retry cannot rewrite the durable user decision.", "ONBOARDING_REVIEW_REPLAY_CONFLICT");
  }
}

function assertNonPromotionReplay({ projectRoot, state, candidateSet, review, disposition, acceptedCandidateIds, removedCandidateIds, userEdits, addedEntities, rationale }, storageOwner) {
  const normalizedDisposition = requiredText(disposition, "Review disposition").toLowerCase();
  if (normalizedDisposition !== review.disposition || acceptedCandidateIds.length
    || (normalizedDisposition === "reject" && (userEdits.length || addedEntities.length || removedCandidateIds.length))) {
    fail("A divergent retry cannot replace a durable disposition.", "ONBOARDING_REVIEW_REPLAY_CONFLICT");
  }
  const { normalizedUserEdits, normalizedAddedEntities } = normalizedReviewEdits(candidateSet, userEdits, addedEntities, removedCandidateIds, storageOwner);
  const { canon } = verifiedNonPromotion({ projectRoot, state, review }, storageOwner);
  const requested = buildReviewDecision({ candidateSet, disposition: normalizedDisposition, acceptedCandidateIds: [],
    rejectedCandidateIds: normalizedDisposition === "reject" ? candidateSet.candidates.map((item) => item.candidateId) : textList(removedCandidateIds, "removedCandidateIds"),
    userEdits: normalizedUserEdits, addedEntities: normalizedAddedEntities, rationale, previousProductModel: canon.model,
  }, storageOwner);
  if (requested.reviewDecisionHash !== review.reviewDecisionHash) fail("A divergent retry cannot rewrite the durable user decision.", "ONBOARDING_REVIEW_REPLAY_CONFLICT");
}

async function reviewOnboardingLocked({
  root = ".",
  candidateSetId,
  disposition,
  acceptedCandidateIds = [],
  removedCandidateIds = [],
  userEdits = [],
  addedEntities = [],
  rationale,
} = {}) {
  const inspected = readyProject(root, "onboarding review");
  const storageOwner = inspected.storage;
  if (inspected.state.activeRunId || inspected.state.pendingReview) {
    fail("Onboarding review cannot change product authority while a Run is active or awaiting review.", "ONBOARDING_RUN_CONFLICT");
  }
  const projectRoot = inspected.project.projectRoot;
  const state = ensureOnboardingState(inspected);
  const reviewedSetId = requiredText(candidateSetId, "candidateSetId");
  const candidateRead = readOnboardingCandidateSet({ root: projectRoot, candidateSetId: reviewedSetId });
  if (candidateRead.status === "historical-ready-opaque") {
    fail("Historical candidates are audit-only and cannot receive a new ReviewDecision.", "ONBOARDING_HISTORICAL_CANDIDATE_REVIEW_RETIRED");
  }
  const candidateSet = candidateRead.candidateSet;
  const recorded = decisionForCandidate(projectRoot, reviewedSetId, storageOwner);
  if (recorded) {
    if (recorded.promotionAuthority) {
      assertAcceptanceReplay({ projectRoot, state, candidateSet, review: recorded, disposition, acceptedCandidateIds, removedCandidateIds, userEdits, addedEntities, rationale }, storageOwner);
      return (await applyApprovedPromotion({ projectRoot, state, review: recorded }, storageOwner));
    }
    assertNonPromotionReplay({ projectRoot, state, candidateSet, review: recorded, disposition, acceptedCandidateIds, removedCandidateIds, userEdits, addedEntities, rationale }, storageOwner);
    return (await applyNonPromotingReview({ projectRoot, state, review: recorded }, storageOwner));
  }
  if (state.candidateSetId !== reviewedSetId) fail("Onboarding review references a stale candidate set.", "STALE_ONBOARDING_CANDIDATE_SET");
  if (candidateSet.sourceSnapshotId !== state.sourceSnapshotId) {
    fail("Onboarding candidate set no longer matches the recorded source snapshot.", "ONBOARDING_SOURCE_SNAPSHOT_CONFLICT");
  }
  const currentWorld = await reconcileOrphanedOnboardingProjection({ projectRoot, state, candidateSet, world: (await inspectWorldModel({ root: projectRoot })) }, storageOwner);
  if (currentWorld.status !== "current"
    || currentWorld.snapshot.temporalProvenanceGraph.sourceSnapshotId !== candidateSet.sourceSnapshotId) {
    fail("Observed project state changed after candidate proposal; re-index and create a new candidate set.", "ONBOARDING_SOURCE_DRIFT");
  }
  const normalizedDisposition = requiredText(disposition, "Review disposition").toLowerCase();
  if (!new Set(["accept-all", "accept-selection", "revise", "reject"]).has(normalizedDisposition)) {
    fail("Onboarding ReviewDecision disposition is invalid.", "INVALID_ONBOARDING_REVIEW_DISPOSITION");
  }
  const currentCanon = readProductModelCanon({ storage: storageOwner, projectRoot });
  if (currentCanon.model.productModelId !== candidateSet.productModelId || currentCanon.model.productModelId !== state.productModelId) {
    fail("Product Canon changed after candidate proposal; a new onboarding candidate set is required.", "ONBOARDING_PRODUCT_CANON_DRIFT");
  }
  const { revisionItems, normalizedUserEdits, normalizedAddedEntities } = normalizedReviewEdits(candidateSet, userEdits, addedEntities, removedCandidateIds, storageOwner);
  const allCandidateIds = candidateSet.candidates.map((candidate) => candidate.candidateId);

  if (normalizedDisposition === "revise") {
    if (!userEdits.length && !addedEntities.length && !removedCandidateIds.length) {
      fail("Revise requires an edit, addition, or removal.", "ONBOARDING_REVISION_REQUIRED");
    }
    const review = buildReviewDecision({
      candidateSet,
      disposition: normalizedDisposition,
      acceptedCandidateIds: [],
      rejectedCandidateIds: textList(removedCandidateIds, "removedCandidateIds"),
      userEdits: normalizedUserEdits,
      addedEntities: normalizedAddedEntities,
      rationale,
      previousProductModel: currentCanon.model,
    }, storageOwner);
    verifyReviewDecision(review, inspected.project.projectId);
    return (await applyNonPromotingReview({ projectRoot, state, review, publishReview: true }, storageOwner));
  }

  if (normalizedDisposition === "reject") {
    if (userEdits.length || addedEntities.length || acceptedCandidateIds.length) {
      fail("Reject cannot include accepted candidates, edits, or additions.", "INVALID_ONBOARDING_REJECTION");
    }
    const review = buildReviewDecision({
      candidateSet,
      disposition: normalizedDisposition,
      acceptedCandidateIds: [],
      rejectedCandidateIds: allCandidateIds,
      userEdits: [],
      addedEntities: [],
      rationale,
      previousProductModel: currentCanon.model,
    }, storageOwner);
    verifyReviewDecision(review, inspected.project.projectId);
    return (await applyNonPromotingReview({ projectRoot, state, review, publishReview: true }, storageOwner));
  }

  if (!candidateSet.candidates.length) fail("An empty candidate set cannot be accepted.", "ONBOARDING_EVIDENCE_REQUIRED");
  if (addedEntities.length || removedCandidateIds.length) {
    fail("Additions and removals require a revise decision followed by review of the successor candidate set.", "ONBOARDING_REVISION_REQUIRED");
  }
  const selectedIds = normalizedDisposition === "accept-all"
    ? allCandidateIds
    : textList(acceptedCandidateIds, "acceptedCandidateIds");
  if (!selectedIds.length) fail("accept-selection requires at least one candidate.", "ONBOARDING_SELECTION_REQUIRED");
  const candidateById = new Map(candidateSet.candidates.map((candidate) => [candidate.candidateId, candidate]));
  for (const candidateId of selectedIds) if (!candidateById.has(candidateId)) {
    fail(`Unknown onboarding candidate: ${candidateId}`, "UNKNOWN_ONBOARDING_CANDIDATE");
  }
  const selected = new Set(selectedIds);
  for (const edit of userEdits) if (!selected.has(edit.candidateId)) {
    fail("A user edit can only target an accepted candidate.", "INVALID_ONBOARDING_EDIT");
  }
  const acceptedItems = revisionItems.filter((item) => item.source && selected.has(item.source.candidateId));
  const nextModel = mergeAcceptedIntoCanon(currentCanon.model, acceptedItems, storageOwner);
  const rejectedIds = allCandidateIds.filter((candidateId) => !selected.has(candidateId));
  const review = buildReviewDecision({
    candidateSet,
    disposition: normalizedDisposition,
    acceptedCandidateIds: selectedIds,
    rejectedCandidateIds: rejectedIds,
    userEdits: normalizedUserEdits,
    addedEntities: [],
    rationale,
    previousProductModel: currentCanon.model,
    resultingProductModel: nextModel,
  }, storageOwner);
  verifyReviewDecision(review, inspected.project.projectId);
  return (await applyApprovedPromotion({ projectRoot, state, review, publishReview: true }, storageOwner));
}

function verifyCurrentOnboardingReviewLineage({ projectRoot, state, candidateSet, latestReviewDecision }, storageOwner) {
  const latestReviewDecisionId = onboardingStateLatestReviewDecisionId(state);
  const producerReviewDecisionId = candidateSet
    ? onboardingCandidateProducerReviewDecisionId(candidateSet)
    : null;
  let producerReviewDecision = null;

  if (producerReviewDecisionId) {
    producerReviewDecision = readOnboardingReviewDecision({
      root: projectRoot,
      reviewDecisionId: producerReviewDecisionId,
    }).reviewDecision;
    const producerEvidence = candidateSet.evidence.find((evidence) => (
      evidence.sourceKind === "onboarding-review-input"
      && evidence.sourceId === producerReviewDecisionId
      && evidence.contentDigest === producerReviewDecision.reviewDecisionHash
    ));
    if (producerReviewDecision.disposition !== "revise"
      || producerReviewDecision.projectId !== candidateSet.projectId
      || producerReviewDecision.sessionId !== candidateSet.sessionId
      || !candidateSet.parentCandidateSetIds.includes(producerReviewDecision.candidateSetId)
      || !producerEvidence) {
      fail("Onboarding successor candidate set has invalid producer ReviewDecision lineage.", "ONBOARDING_REVIEW_CONFLICT");
    }
  }

  if ((latestReviewDecision?.reviewDecisionId || null) !== latestReviewDecisionId) {
    fail("Onboarding state latest ReviewDecision could not be verified.", "ONBOARDING_REVIEW_CONFLICT");
  }

  if (["awaiting-review", "awaiting-evidence", "revision-required"].includes(state.phase)) {
    if (latestReviewDecisionId !== producerReviewDecisionId) {
      fail("Review-pending onboarding state does not match its successor-producing ReviewDecision.", "ONBOARDING_REVIEW_CONFLICT");
    }
  } else if (state.phase === "ready" && candidateSet) {
    if (!latestReviewDecision?.disposition.startsWith("accept")
      || latestReviewDecision.candidateSetId !== candidateSet.candidateSetId) {
      fail("Ready onboarding state does not name the acceptance ReviewDecision for its current candidate set.", "ONBOARDING_REVIEW_CONFLICT");
    }
  } else if (state.phase === "rejected") {
    if (!candidateSet || latestReviewDecision?.disposition !== "reject"
      || latestReviewDecision.candidateSetId !== candidateSet.candidateSetId) {
      fail("Rejected onboarding state does not name the rejection ReviewDecision for its current candidate set.", "ONBOARDING_REVIEW_CONFLICT");
    }
  } else if (!candidateSet && latestReviewDecisionId) {
    fail("Onboarding state names a ReviewDecision without a current candidate set.", "ONBOARDING_REVIEW_CONFLICT");
  }

  return {
    producerReviewDecisionId,
    latestReviewDecisionId,
    producerReviewDecision,
  };
}

// A diagnostic boundary, never a replacement for strict promotion validation.
// Core/P2 validation deliberately remains outside the optional capability catch.
export async function inspectOptionalOnboarding({ root = "." } = {}) {
  return (await inspectOptionalOnboardingRecords(root, true));
}

// Intra-package conversation composition only; no public diagnostic selector.
// Product originals keep their normal validation, not aggregate World freshness.
export async function inspectOptionalOnboardingForEntry({ root = "." } = {}) {
  return (await inspectOptionalOnboardingRecords(root, false));
}

async function inspectOptionalOnboardingRecords(root, inspectWorld) {
  const inspected = readyProject(root, "optional Product inspection", "selected");
  try { return (await inspectOnboardingRecords(root, inspectWorld)); }
  catch (error) {
    const unrelatedDefaultFailure = error.headSessionRecordPath === defaultSessionStatePath(root, inspected.storage)
      && sessionStatePath(root, inspected.storage) !== defaultSessionStatePath(root, inspected.storage);
    if (!/^(?:INVALID_)?(?:ONBOARDING|WORLD_MODEL|GRAPH_|TEMPORAL_|PRODUCT_MODEL|PRODUCT_CANON|DOCUMENT_|ARCADEDB|HISTORICAL_|STORAGE_SELECTION|SESSION_RECORD)/.test(error.code || "")
      && !new Set(["ENOENT", "EACCES", "EPERM", "EISDIR",
        "INVALID_SNAPSHOT_COMPOSITION", "SNAPSHOT_COMPOSITION_DIGEST_MISMATCH",
        "INVALID_SNAPSHOT_BUNDLE_ADDRESS", "INVALID_SNAPSHOT_BUNDLE_ENCODING", "INVALID_SNAPSHOT_BUNDLE_REFERENCE", "INVALID_SNAPSHOT_BUNDLE_SHAPE",
        "SNAPSHOT_BUNDLE_BASIS_MISMATCH", "SNAPSHOT_BUNDLE_CODEC_UNAVAILABLE", "SNAPSHOT_BUNDLE_COUNT_LIMIT", "SNAPSHOT_BUNDLE_CYCLE",
        "SNAPSHOT_BUNDLE_DIGEST_MISMATCH", "SNAPSHOT_BUNDLE_TYPE_MISMATCH", "SNAPSHOT_STORAGE_LIMIT", "SNAPSHOT_STORAGE_DRIFT", "UNSAFE_SNAPSHOT_PATH",
      ]).has(error.code)
      && !unrelatedDefaultFailure) throw error;
    return {
      status: "integrity_attention",
      reasonCode: error.code,
      ...(unrelatedDefaultFailure ? { unavailableDependency: "default-session" } : {}),
      ordinaryWorkBlocked: false,
      userReviewRequired: false,
      nextAction: "inspect_product_governance",
    };
  }
}

export async function inspectOnboarding({ root = "." } = {}) {
  return (await inspectOnboardingRecords(root, true));
}

function uninspectedWorld(state) {
  // IDs are retained onboarding references, not proof of current World content.
  return { status: "not-inspected", worldModelId: state.worldModelId,
    sourceSnapshotId: state.sourceSnapshotId, graphSnapshotId: null,
    matchesCandidateSource: null, matchesOnboardingSnapshot: null };
}

async function inspectOnboardingRecords(root, inspectWorld) {
  const inspected = readyProject(root, "onboarding inspection");
  const storageOwner = inspected.storage;
  const projectRoot = inspected.project.projectRoot;
  const file = stateFile(projectRoot, storageOwner);
  if (!fs.existsSync(file)) {
    const migration = migrationPreview(inspected);
    return {
      status: "migration_required",
      projectId: inspected.project.projectId,
      sessionId: inspected.state.sessionId,
      migration: {
        kind: migration.state.migration,
        phase: migration.state.phase,
        storageSelectionId: migration.storageSelection.storageSelectionId,
        writesRequired: [
          relativeProjectArtifact(storageOwner, "onboarding", "current.json"),
          `${relativeProjectArtifact(storageOwner, "sessions", "records")}/${migration.sessionRecord.sessionId}.json`,
          `${relativeProjectArtifact(storageOwner, "onboarding", "storage-selections")}/${migration.storageSelection.storageSelectionId}.json`,
        ],
      },
    };
  }
  const state = verifyOnboardingState(readJson(file, "Onboarding state pointer"), {
    projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId,
    storage: storageOwner,
  });
  const sessionRecord = verifySessionRecord(
    readJson(sessionRecordFile(projectRoot, state.sessionId, storageOwner), "HEAD Session record"),
    { projectId: inspected.project.projectId, sessionId: inspected.state.sessionId, storage: storageOwner },
  );
  const storageSelection = verifyStorageSelection(
    readJson(storageSelectionFile(projectRoot, state.storageSelectionId, storageOwner), "Onboarding storage selection"),
    inspected.project.projectId,
    storageOwner,
  );
  const historical = readCommittedHistoricalArtifactBoundary({ storage: storageOwner, root: projectRoot, projectId: inspected.project.projectId, allowAbsent: true });
  const historicalCandidate = state.candidateSetId
    ? historicalEntryForPath(historical, `${relativeProjectArtifact(storageOwner, "onboarding", "candidate-sets")}/${state.candidateSetId}.json`, "historical-candidate-set")
    : null;
  if (historicalCandidate) {
    const latestReviewDecisionId = onboardingStateLatestReviewDecisionId(state);
    const historicalReview = latestReviewDecisionId
      ? historicalEntryForPath(historical, `${relativeProjectArtifact(storageOwner, "onboarding", "review-decisions")}/${latestReviewDecisionId}.json`, "historical-review")
      : null;
    if (state.phase !== "ready" || !historicalReview) fail("Historical onboarding boundary does not cover a complete ready state.", "HISTORICAL_BOUNDARY_INCOMPLETE");
    const productCanon = readProductModelCanon({ storage: storageOwner, projectRoot });
    if (productCanon.status !== "present" || productCanon.model.productModelId !== state.productModelId) {
      fail("Historical boundary cannot replace current Product Canon validation.", "ONBOARDING_PRODUCT_CANON_DRIFT");
    }
    const currentRevision = readProductRevision(projectRoot, state.productModelId, storageOwner).revision;
    if (currentRevision.productModelHash !== productCanon.model.productModelHash) fail("Current Product revision does not match Canon.", "ONBOARDING_PRODUCT_CANON_DRIFT");
    let world = null;
    if (state.worldModelId && !inspectWorld) world = uninspectedWorld(state);
    else if (state.worldModelId) {
      try {
        const inspectedWorld = (await inspectWorldModel({ root: projectRoot }));
        world = { status: inspectedWorld.status, worldModelId: inspectedWorld.snapshot.worldModelId,
          sourceSnapshotId: inspectedWorld.snapshot.temporalProvenanceGraph.sourceSnapshotId,
          graphSnapshotId: inspectedWorld.snapshot.temporalProvenanceGraph.graphSnapshotId,
          matchesOnboardingSnapshot: inspectedWorld.snapshot.worldModelId === state.worldModelId };
      } catch (error) {
        if (!ABSENT_WORLD_CODES.has(error.code)) throw error;
        world = { status: "unavailable", reasonCode: error.code, ordinaryWorkBlocked: false, nextAction: "refresh_product_world" };
      }
    }
    return {
      status: world?.status === "not-inspected" ? "ready_world_unchecked"
        : world?.status === "current" ? "ready" : "ready_world_changed",
      state,
      sessionRecord,
      storageSelection,
      candidateSet: null,
      reviewDecision: null,
      historical: {
        applicationStatus: historical.applicationStatus,
        boundaryIntegrity: historical.boundaryIntegrity,
        boundaryId: historical.boundary.boundaryId,
        candidate: historicalCandidate,
        review: historicalReview,
        coverage: historical.coverage,
        nextAction: "Use a fresh current semantic proposal only when product meaning should change.",
      },
      productModel: productCanon.model,
      productModelRevisions: { current: currentRevision },
      worldModel: world,
      recovery: { nextAction: ["current", "not-inspected"].includes(world?.status) ? "continue" : "refresh_product_world", userReviewRequired: false, ordinaryWorkBlocked: false },
      authority: { productCanon: "user-owned-project-canon", candidates: "historical-ready-opaque", graph: "rebuildable-derived-evidence" },
    };
  }
  const candidateSet = state.candidateSetId
    ? readOnboardingCandidateSet({ root: projectRoot, candidateSetId: state.candidateSetId }).candidateSet
    : null;
  const latestReviewDecisionId = onboardingStateLatestReviewDecisionId(state);
  const reviewDecision = latestReviewDecisionId
    ? readOnboardingReviewDecision({ root: projectRoot, reviewDecisionId: latestReviewDecisionId }).reviewDecision
    : null;
  const productCanon = readProductModelCanon({ storage: storageOwner, projectRoot });
  const own = decisionForCandidate(projectRoot, state.candidateSetId, storageOwner);
  const pendingDisposition = nonPromotingDecisionForState(projectRoot, state, own, storageOwner);
  if (pendingDisposition) {
    const disposition = verifiedNonPromotion({ projectRoot, state, review: pendingDisposition }, storageOwner);
    disposition.projectedWorld = await projectedNonPromotionWorld({ projectRoot, state, review: pendingDisposition, verified: disposition });
    if (!disposition.projectedWorld) return {
      status: "review_recovery_pending", state, sessionRecord, storageSelection, candidateSet,
      reviewDecision: pendingDisposition, productModel: productCanon.model, worldModel: null,
      recovery: { nextAction: "resume_product_governance", userReviewRequired: false, ordinaryWorkBlocked: false },
      authority: { productCanon: "user-owned-project-canon", candidates: "non-authoritative-until-review", graph: "rebuildable-derived-evidence" },
    };
  }
  const pendingAcceptance = candidateSet && state.sourceSnapshotId === candidateSet.sourceSnapshotId
    ? own?.promotionAuthority ? own : null : null;
  if (pendingAcceptance) {
    const promotion = verifiedPromotion({ projectRoot, state, review: pendingAcceptance }, storageOwner);
    return {
      status: "promotion_recovery_pending",
      state,
      sessionRecord,
      storageSelection,
      candidateSet,
      reviewDecision: pendingAcceptance,
      productModel: productCanon.model,
      productModelRevisions: { previous: promotion.previous, resulting: promotion.resulting },
      worldModel: null,
      recovery: { nextAction: "resume_product_governance", userReviewRequired: false, ordinaryWorkBlocked: false },
      authority: {
        productCanon: "user-owned-project-canon",
        candidates: "non-authoritative-until-review",
        graph: "rebuildable-derived-evidence",
      },
    };
  }
  const reviewLineage = verifyCurrentOnboardingReviewLineage({
    projectRoot,
    state,
    candidateSet,
    latestReviewDecision: reviewDecision,
  }, storageOwner);
  if (productCanon.model.productModelId !== state.productModelId) {
    fail("Onboarding state Product Model identity does not match current canon.", "ONBOARDING_PRODUCT_CANON_DRIFT");
  }
  const productModelRevisions = reviewDecision?.promotionAuthority ? {
    previous: readProductRevision(projectRoot, reviewDecision.previousProductModelId, storageOwner).revision,
    resulting: readProductRevision(projectRoot, reviewDecision.resultingProductModelId, storageOwner).revision,
  } : null;
  let world = null;
  if (state.worldModelId && !inspectWorld) world = uninspectedWorld(state);
  else if (state.worldModelId) {
    try {
      const inspectedWorld = (await inspectWorldModel({ root: projectRoot }));
      world = {
        status: inspectedWorld.status,
        worldModelId: inspectedWorld.snapshot.worldModelId,
        sourceSnapshotId: inspectedWorld.snapshot.temporalProvenanceGraph.sourceSnapshotId,
        graphSnapshotId: inspectedWorld.snapshot.temporalProvenanceGraph.graphSnapshotId,
        matchesCandidateSource: !candidateSet || inspectedWorld.snapshot.temporalProvenanceGraph.sourceSnapshotId === candidateSet.sourceSnapshotId,
        matchesOnboardingSnapshot: inspectedWorld.snapshot.worldModelId === state.worldModelId
          && inspectedWorld.snapshot.temporalProvenanceGraph.sourceSnapshotId === state.sourceSnapshotId,
      };
    } catch (error) {
      if (!ABSENT_WORLD_CODES.has(error.code)) throw error;
      world = { status: "unavailable", reasonCode: error.code, worldModelId: state.worldModelId,
        sourceSnapshotId: state.sourceSnapshotId, graphSnapshotId: null, matchesOnboardingSnapshot: false,
        ordinaryWorkBlocked: false, nextAction: "refresh_product_world" };
    }
  }
  // The state keeps the historical approval reference. inspectWorldModel checks
  // today's Canon and complete decision projection independently; a legitimate
  // refreshed child is usable without changing that history or approving again.
  const status = state.phase === "ready"
    ? world?.status === "not-inspected" ? "ready_world_unchecked"
      : world?.status === "current" ? "ready" : "ready_world_changed"
    : state.phase.replaceAll("-", "_");
  return {
    status,
    state,
    sessionRecord,
    storageSelection,
    candidateSet,
    reviewDecision,
    reviewLineage: {
      producerReviewDecisionId: reviewLineage.producerReviewDecisionId,
      latestReviewDecisionId: reviewLineage.latestReviewDecisionId,
    },
    productModel: productCanon.model,
    productModelRevisions,
    worldModel: world,
    authority: {
      productCanon: "user-owned-project-canon",
      candidates: "non-authoritative-until-review",
      graph: "rebuildable-derived-evidence",
    },
  };
}

export async function startOnboarding(options = {}, ...rest) {
  return withSnapshotReferencesAsync({ root: options.root ?? ".", storage: options.storage }, () => startOnboardingUncoordinated(options, ...rest));
}

export async function proposeOnboardingSemanticRefresh(options = {}, ...rest) {
  return withSnapshotReferencesAsync({ root: options.root ?? ".", storage: options.storage }, () => proposeOnboardingSemanticRefreshUncoordinated(options, ...rest));
}

export async function refreshOnboardingCandidates(options = {}, ...rest) {
  return withSnapshotReferencesAsync({ root: options.root ?? ".", storage: options.storage }, () => refreshOnboardingCandidatesUncoordinated(options, ...rest));
}

export async function recoverOnboardingPromotion(options = {}, ...rest) {
  return withSnapshotReferencesAsync({ root: options.root ?? ".", storage: options.storage }, () => recoverOnboardingPromotionUncoordinated(options, ...rest));
}

export async function reviewOnboarding(options = {}, ...rest) {
  return withSnapshotReferencesAsync({ root: options.root ?? ".", storage: options.storage }, () => reviewOnboardingUncoordinated(options, ...rest));
}
