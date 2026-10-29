import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { familyFormatForOriginal, formatForVerifiedOwner, relativeProjectArtifact } from "./project-storage-format.mjs";
import { inspectProject, SCHEMA_VERSION } from "./lode-core.mjs";
import {
  FEATURE_MAPPING_CANDIDATE_DIRECTORY,
  FEATURE_MAPPING_REVIEW_DIRECTORY,
  FEATURE_MAPPING_STATE_RELATIVE_PATH,
  FEATURE_MAPPING_VERSION,
  featureMappingCanonicalJson,
  featureMappingDigest,
  loadFeatureMappingProjection,
  verifyFeatureMappingCandidateSet,
  verifyFeatureMappingReviewDecision,
} from "./feature-mapping-projection.mjs";
import { buildWorldModel, inspectWorldModel } from "./world-model.mjs";
import { refreshWorldModel } from "./incremental-refresh.mjs";
import { withProjectMutationAsync } from "./project-mutation-lock.mjs";

const MAX_CANDIDATES = 500;
const MAX_EVIDENCE = 750;
const MAX_UNKNOWNS = 100;
const MAX_DIAGNOSTIC_PATHS = 200;

const fail = (message, code = "FEATURE_MAPPING_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const now = () => new Date().toISOString();

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is required.`, "INVALID_FEATURE_MAPPING_INPUT");
  return value.trim();
}

function assertRecordFields(value, allowedFields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`, "INVALID_FEATURE_MAPPING_PROPOSAL");
  const allowed = new Set(allowedFields);
  const unexpected = Object.keys(value).filter((field) => !allowed.has(field));
  if (unexpected.length) fail(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}`, "INVALID_FEATURE_MAPPING_PROPOSAL");
}

function readyProject(root, action = "feature mapping") {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") {
    fail(`Project must be ready for ${action}; current status: ${inspected.status}.`, "PROJECT_NOT_READY");
  }
  return inspected;
}

function relativeFile(projectRoot, relative, storage) {
  const root = path.resolve(projectRoot);
  const candidate = path.resolve(root, ...relativeProjectArtifact(storage, ...relative.split("/").slice(1)).split("/"));
  const fromRoot = path.relative(root, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    fail(`Feature mapping artifact path escapes the project root: ${relative}`, "FEATURE_MAPPING_PATH_ESCAPE");
  }
  let current = root;
  for (const segment of fromRoot.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      fail(`Feature mapping artifact path traverses a symlink: ${relative}`, "FEATURE_MAPPING_SYMLINK_PATH");
    }
  }
  return candidate;
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

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`${label} is invalid JSON: ${error.message}`, "INVALID_FEATURE_MAPPING_ARTIFACT"); }
}

function persistImmutable(file, document, label) {
  if (fs.existsSync(file)) {
    const existing = readJson(file, label);
    if (featureMappingCanonicalJson(existing) !== featureMappingCanonicalJson(document)) {
      fail(`${label} identity collision detected.`, "FEATURE_MAPPING_IMMUTABLE_COLLISION");
    }
    return { status: "existing", file, document: existing };
  }
  atomicWrite(file, json(document));
  return { status: "recorded", file, document };
}

function stateFile(projectRoot, storage) {
  return relativeFile(projectRoot, FEATURE_MAPPING_STATE_RELATIVE_PATH, storage);
}

function candidateSetFile(projectRoot, candidateSetId, storage) {
  if (!/^feature-mapping-candidates-[a-f0-9]{24}$/.test(candidateSetId || "")) {
    fail("Feature mapping candidate-set id is invalid.", "INVALID_FEATURE_MAPPING_CANDIDATE_SET_ID");
  }
  return relativeFile(projectRoot, `${FEATURE_MAPPING_CANDIDATE_DIRECTORY}/${candidateSetId}.json`, storage);
}

function reviewDecisionFile(projectRoot, reviewDecisionId, storage) {
  if (!/^feature-mapping-review-decision-[a-f0-9]{24}$/.test(reviewDecisionId || "")) {
    fail("Feature mapping ReviewDecision id is invalid.", "INVALID_FEATURE_MAPPING_REVIEW_ID");
  }
  return relativeFile(projectRoot, `${FEATURE_MAPPING_REVIEW_DIRECTORY}/${reviewDecisionId}.json`, storage);
}

function buildState({ projectId, sessionId, phase, stateRevision, candidateSetId = null, reviewDecisionId = null,
  worldModelId = null, graphSnapshotId = null, sourceSnapshotId = null, productModelId = null, updatedAt } = {}, storage) {
  if (!["awaiting-evidence", "awaiting-review", "reviewed", "rejected"].includes(phase)
    || !Number.isInteger(stateRevision) || stateRevision < 0) {
    fail("Feature mapping state fields are invalid.", "INVALID_FEATURE_MAPPING_STATE");
  }
  const payload = {
    schemaVersion: 1,
    kind: "FeatureMappingStatePointer",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-feature-mapping"), version: FEATURE_MAPPING_VERSION },
    projectId: requiredText(projectId, "projectId"),
    sessionId: requiredText(sessionId, "sessionId"),
    phase,
    stateRevision,
    candidateSetId,
    reviewDecisionId,
    worldModelId,
    graphSnapshotId,
    sourceSnapshotId,
    productModelId,
    updatedAt: requiredText(updatedAt, "updatedAt"),
  };
  return { ...payload, pointerHash: featureMappingDigest(featureMappingCanonicalJson(payload)) };
}

function verifyState(document, { projectId, sessionId }, storage) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    fail("Feature mapping state pointer is invalid.", "INVALID_FEATURE_MAPPING_STATE");
  }
  const payload = { ...document };
  delete payload.pointerHash;
  if (document.pointerHash !== featureMappingDigest(featureMappingCanonicalJson(payload))) {
    fail("Feature mapping state pointer digest verification failed.", "FEATURE_MAPPING_STATE_DIGEST_MISMATCH");
  }
  const originalFormat = familyFormatForOriginal("head-agent-core-feature-mapping", document, storage);
  const rebuilt = originalFormat ? buildState({ ...payload }, originalFormat) : null;
  if (featureMappingCanonicalJson(rebuilt) !== featureMappingCanonicalJson(document)
    || document.projectId !== projectId || document.sessionId !== sessionId) {
    fail("Feature mapping state pointer identity is invalid.", "FEATURE_MAPPING_STATE_IDENTITY_MISMATCH");
  }
  return document;
}

function writeState(projectRoot, previous, changes, storage) {
  const state = buildState({
    ...previous,
    ...changes,
    stateRevision: previous ? previous.stateRevision + 1 : 0,
    updatedAt: now(),
  }, storage);
  atomicWrite(stateFile(projectRoot, storage), json(state));
  return state;
}

function endpointFor(node, revision, extra = {}) {
  return {
    nodeId: node.nodeId,
    kind: node.kind,
    revisionId: revision.nodeId,
    path: node.path || "",
    name: node.name || "",
    key: node.key || "",
    ...extra,
  };
}

function evidenceArtifact({ sourceKind, sourceNodeId, sourceRevisionId, path: sourcePath = "", line = null, contentDigest = "", statement }) {
  const payload = {
    schemaVersion: 1,
    kind: "FeatureMappingEvidence",
    sourceKind,
    sourceNodeId,
    sourceRevisionId,
    path: sourcePath,
    line: Number.isInteger(line) && line > 0 ? line : null,
    contentDigest,
    statement: requiredText(statement, "Evidence statement"),
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const hash = featureMappingDigest(featureMappingCanonicalJson(payload));
  return { ...payload, evidenceId: `feature-mapping-evidence-${hash.slice(0, 24)}`, evidenceHash: hash };
}

function candidateArtifact({ relationshipType, from, to, evidenceIds, explanation, confidence, sourceSnapshotId, origin }, storage) {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) fail("Feature mapping candidate confidence must be from zero through one.", "INVALID_FEATURE_MAPPING_CONFIDENCE");
  const normalizedExplanation = requiredText(explanation, "Candidate explanation");
  if (normalizedExplanation.length > 2000) fail("Feature mapping candidate explanation must contain at most 2000 characters.", "INVALID_FEATURE_MAPPING_PROPOSAL");
  const payload = {
    schemaVersion: 1,
    kind: "FeatureMappingCandidate",
    relationshipType,
    from,
    to,
    evidenceIds: [...new Set(evidenceIds)].sort(),
    explanation: normalizedExplanation,
    confidence: Number(confidence.toFixed(6)),
    sourceSnapshotId,
    origin,
    producer: formatForVerifiedOwner(storage).protocol("head-agent-core-feature-mapping-proposal-normalizer"),
    producerVersion: FEATURE_MAPPING_VERSION,
    authorityClass: "candidate",
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const hash = featureMappingDigest(featureMappingCanonicalJson(payload));
  return { ...payload, candidateId: `feature-mapping-candidate-${hash.slice(0, 24)}`, candidateHash: hash };
}

function unknownArtifact(sourceSnapshotId, kind, statement, evidenceIds = []) {
  const normalizedEvidenceIds = [...new Set(evidenceIds)].sort();
  const hash = featureMappingDigest(featureMappingCanonicalJson({ sourceSnapshotId, kind, statement, evidenceIds: normalizedEvidenceIds }));
  return { unknownId: `feature-mapping-unknown-${hash.slice(0, 24)}`, statement, evidenceIds: normalizedEvidenceIds, status: "open" };
}

function candidateSetArtifact({ project, sessionId, worldModel, candidates, evidence, unknowns }, storage) {
  const orderedCandidates = [...candidates].sort((left, right) => left.candidateId.localeCompare(right.candidateId)).slice(0, MAX_CANDIDATES);
  const usedEvidence = new Set(orderedCandidates.flatMap((candidate) => candidate.evidenceIds));
  const orderedEvidence = [...evidence].filter((item) => usedEvidence.has(item.evidenceId))
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)).slice(0, MAX_EVIDENCE);
  const payload = {
    schemaVersion: 1,
    kind: "FeatureMappingCandidateSet",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-feature-mapping-candidates"), version: FEATURE_MAPPING_VERSION },
    projectId: project.projectId,
    sessionId,
    worldModelId: worldModel.worldModelId,
    graphSnapshotId: worldModel.temporalProvenanceGraph.graphSnapshotId,
    sourceSnapshotId: worldModel.temporalProvenanceGraph.sourceSnapshotId,
    productModelId: worldModel.productModel.productModelId,
    productModelHash: worldModel.productModel.productModelHash,
    candidates: orderedCandidates,
    evidence: orderedEvidence,
    unknowns: [...unknowns].sort((left, right) => left.unknownId.localeCompare(right.unknownId)).slice(0, MAX_UNKNOWNS),
    reviewProtocol: {
      decisionScope: "feature-implementation-mapping",
      allowedDispositions: ["accept-all", "accept-selection", "reject"],
      authorityTransition: "only-an-explicit-feature-mapping-review-may-create-reviewed-relationships",
      reviewedRelationshipsAreSeparateFromCandidates: true,
    },
    limits: { maxCandidates: MAX_CANDIDATES, maxEvidence: MAX_EVIDENCE, maxUnknowns: MAX_UNKNOWNS },
    authorityClass: "candidate-set",
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const hash = featureMappingDigest(featureMappingCanonicalJson(payload));
  return verifyFeatureMappingCandidateSet({
    ...payload,
    candidateSetId: `feature-mapping-candidates-${hash.slice(0, 24)}`,
    candidateSetHash: hash,
  }, project.projectId, storage);
}

function candidatesFromSemanticProposal(proposal, worldModel, storage) {
  const graph = worldModel.temporalProvenanceGraph;
  const continuityGenerations = graph.logicalLineageState?.continuityGenerationByLogicalEntityId || {};
  const continuityUnknown = new Set(graph.logicalLineageState?.continuityUnknownLogicalEntityIds || []);
  const nodeById = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const currentRevisionByLogical = new Map(graph.edges.filter((edge) => edge.type === "CURRENT_REVISION")
    .map((edge) => [edge.from, nodeById.get(edge.to)]));
  const fileDigestById = new Map(graph.nodes.filter((node) => node.kind === "FileRevision")
    .map((revision) => [revision.logicalEntityId, revision.digest]));
  const fileClassificationById = new Map(graph.nodes.filter((node) => node.kind === "FileRevision")
    .map((revision) => [revision.logicalEntityId, revision.classification]));
  const productNodes = graph.nodes.filter((node) => ["Feature", "Capability"].includes(node.kind));
  const evidenceById = new Map();

  if (!productNodes.length) {
    return { candidates: [], evidence: [], unknowns: [unknownArtifact(graph.sourceSnapshotId, "missing-product-canon", "No authoritative Feature or Capability exists. Complete Product Canon onboarding before implementation mapping.")] };
  }
  if (proposal == null) {
    return { candidates: [], evidence: [], unknowns: [unknownArtifact(graph.sourceSnapshotId, "semantic-mapping-proposal-required", "Fresh HEAD semantic implementation-mapping candidates are required. Core intentionally does not infer product-to-code meaning from names or lexical overlap.")] };
  }
  assertRecordFields(proposal, ["schemaVersion", "sourceSnapshotId", "productModelId", "candidates"], "Feature mapping semantic proposal");
  if (proposal.schemaVersion !== 1) fail("Feature mapping semantic proposal schemaVersion must be 1.", "INVALID_FEATURE_MAPPING_PROPOSAL");
  if (requiredText(proposal.sourceSnapshotId, "Feature mapping proposal sourceSnapshotId") !== graph.sourceSnapshotId) fail("Feature mapping proposal is bound to a stale SourceSnapshot.", "FEATURE_MAPPING_PROPOSAL_DRIFT");
  if (requiredText(proposal.productModelId, "Feature mapping proposal productModelId") !== worldModel.productModel.productModelId) fail("Feature mapping proposal is bound to stale Product Canon.", "FEATURE_MAPPING_PROPOSAL_DRIFT");
  if (!Array.isArray(proposal.candidates) || !proposal.candidates.length || proposal.candidates.length > MAX_CANDIDATES) fail(`Feature mapping proposal must contain 1 through ${MAX_CANDIDATES} candidates.`, "INVALID_FEATURE_MAPPING_PROPOSAL");

  const candidates = proposal.candidates.map((item, index) => {
    assertRecordFields(item, ["relationshipType", "sourceNodeId", "productNodeId", "explanation", "confidence"], `Feature mapping proposal candidate ${index}`);
    const relationshipType = requiredText(item.relationshipType, `Feature mapping proposal candidate ${index}.relationshipType`).toUpperCase();
    if (!["IMPLEMENTS", "VERIFIED_BY"].includes(relationshipType)) fail("Feature mapping proposal relationshipType must be IMPLEMENTS or VERIFIED_BY.", "INVALID_FEATURE_MAPPING_PROPOSAL");
    const sourceNode = nodeById.get(requiredText(item.sourceNodeId, `Feature mapping proposal candidate ${index}.sourceNodeId`));
    const productNode = nodeById.get(requiredText(item.productNodeId, `Feature mapping proposal candidate ${index}.productNodeId`));
    if (!sourceNode || !productNode) fail("Feature mapping proposal references a node absent from the current GraphSnapshot.", "FEATURE_MAPPING_PROPOSAL_EVIDENCE_MISSING");
    if (!["Feature", "Capability"].includes(productNode.kind)) fail("Feature mapping proposal productNodeId must name a current Feature or Capability.", "INVALID_FEATURE_MAPPING_DIRECTION");
    if (relationshipType === "IMPLEMENTS" && (!["File", "Symbol"].includes(sourceNode.kind)
      || fileClassificationById.get(sourceNode.kind === "Symbol" ? sourceNode.fileId : sourceNode.nodeId) === "test")) {
      fail("IMPLEMENTS proposals require a current non-test File or Symbol source.", "INVALID_FEATURE_MAPPING_DIRECTION");
    }
    if (relationshipType === "VERIFIED_BY" && sourceNode.kind !== "Test") fail("VERIFIED_BY proposals require a current Test source.", "INVALID_FEATURE_MAPPING_DIRECTION");
    const sourceRevision = currentRevisionByLogical.get(sourceNode.nodeId);
    const productRevision = currentRevisionByLogical.get(productNode.nodeId);
    if (!sourceRevision || !productRevision) fail("Feature mapping proposal endpoints must have current revisions.", "FEATURE_MAPPING_PROPOSAL_EVIDENCE_MISSING");
    if (continuityUnknown.has(sourceNode.nodeId) || continuityUnknown.has(productNode.nodeId)) {
      fail("Feature mapping proposal endpoint continuity is unknown because its prior derived view is unavailable; restore verified lineage evidence before approval.", "FEATURE_MAPPING_PROPOSAL_CONTINUITY_UNKNOWN");
    }
    const sourceFileId = sourceNode.kind === "Symbol" ? sourceNode.fileId : sourceNode.fileId || sourceNode.nodeId;
    const contentDigest = fileDigestById.get(sourceFileId) || "";
    const evidence = evidenceArtifact({
      sourceKind: `head-semantic-proposal-${sourceNode.kind.toLocaleLowerCase()}`,
      sourceNodeId: sourceNode.nodeId,
      sourceRevisionId: sourceRevision.nodeId,
      path: sourceNode.path || sourceRevision.path || "",
      line: sourceRevision.line || null,
      contentDigest,
      statement: `Fresh HEAD cites current ${sourceNode.kind} ${sourceNode.name || sourceNode.path} as evidence for a proposed ${relationshipType} relation with authoritative ${productNode.kind} ${productRevision.semantic.name || productNode.key}.`,
    });
    evidenceById.set(evidence.evidenceId, evidence);
    const productEndpoint = endpointFor(productNode, productRevision, {
      name: productRevision.semantic.name || "",
      continuityGeneration: continuityGenerations[productNode.nodeId] || 0,
    });
    const sourceEndpoint = endpointFor(sourceNode, sourceRevision, {
      continuityGeneration: continuityGenerations[sourceNode.nodeId] || 0,
    });
    const from = relationshipType === "IMPLEMENTS" ? sourceEndpoint : productEndpoint;
    const to = relationshipType === "IMPLEMENTS" ? productEndpoint : sourceEndpoint;
    return candidateArtifact({
      relationshipType,
      from,
      to,
      evidenceIds: [evidence.evidenceId],
      explanation: item.explanation,
      confidence: item.confidence,
      sourceSnapshotId: graph.sourceSnapshotId,
      origin: "fresh-head-semantic-mapping-proposal",
    }, storage);
  });
  const deduplicated = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  if (deduplicated.size !== candidates.length) fail("Feature mapping proposal contains duplicate candidates.", "DUPLICATE_FEATURE_MAPPING_PROPOSAL");
  return { candidates: [...deduplicated.values()], evidence: [...evidenceById.values()], unknowns: [] };
}

function buildReviewDecision({ candidateSet, disposition, acceptedCandidateIds, rejectedCandidateIds, rationale }, storage) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "ReviewDecision",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-feature-mapping-review"), version: FEATURE_MAPPING_VERSION },
    decisionScope: "feature-implementation-mapping",
    projectId: candidateSet.projectId,
    sessionId: candidateSet.sessionId,
    candidateSetId: candidateSet.candidateSetId,
    disposition,
    acceptedCandidateIds: [...acceptedCandidateIds].sort(),
    rejectedCandidateIds: [...rejectedCandidateIds].sort(),
    rationale: requiredText(rationale, "Review rationale"),
    sourceSnapshotId: candidateSet.sourceSnapshotId,
    productModelId: candidateSet.productModelId,
    productModelHash: candidateSet.productModelHash,
    authority: "explicit-user-feature-mapping-review",
    instructionAuthority: true,
    promotionAuthority: disposition.startsWith("accept"),
    lineage: [
      { relation: "reviews-candidate-set", targetId: candidateSet.candidateSetId },
      ...acceptedCandidateIds.map((candidateId) => ({ relation: "promotes-candidate-to-separate-reviewed-relationship", targetId: candidateId })),
    ],
  };
  const hash = featureMappingDigest(featureMappingCanonicalJson(payload));
  return verifyFeatureMappingReviewDecision({
    ...payload,
    reviewDecisionId: `feature-mapping-review-decision-${hash.slice(0, 24)}`,
    reviewDecisionHash: hash,
  }, candidateSet, candidateSet.projectId, storage);
}

async function rebuildWithProjection({ projectRoot, projectId, currentProductModelId, sourceWorld,
  additionalCandidateSets = [], additionalReviewDecisions = [] }, storage) {
  const projection = loadFeatureMappingProjection({ storage,
    projectRoot,
    projectId,
    currentProductModelId,
    additionalCandidateSets,
    additionalReviewDecisions,
  });
  return (await buildWorldModel({
    root: projectRoot,
    persist: true,
    featureMappingProjectionInput: projection,
    parentSourceSnapshotIds: sourceWorld.temporalProvenanceGraph.parentSourceSnapshotIds,
    revisionParentIds: sourceWorld.temporalProvenanceGraph.revisionParentIds,
  }));
}

export async function startFeatureMapping(options = {}) {
  return (await withProjectMutationAsync({ root: options.root ?? ".", scope: "session-recovery" }, async () => (await startFeatureMappingLocked(options))));
}

async function startFeatureMappingLocked({ root = ".", semanticProposal = null, expectedCandidateSetId = null } = {}) {
  const inspected = readyProject(root, "feature mapping start");
  const storage = inspected.storage;
  if (inspected.state.activeRunId || inspected.state.pendingReview) {
    fail("Feature mapping cannot change reviewed relationships while a Run is active or awaiting review.", "FEATURE_MAPPING_RUN_CONFLICT");
  }
  const projectRoot = inspected.project.projectRoot;
  const currentStateFile = stateFile(projectRoot, storage);
  const previousState = fs.existsSync(currentStateFile)
    ? verifyState(readJson(currentStateFile, "Feature mapping state pointer"), { projectId: inspected.project.projectId, sessionId: inspected.state.sessionId }, storage)
    : null;
  if (expectedCandidateSetId !== null) {
    if (previousState?.phase !== "awaiting-review" || expectedCandidateSetId !== previousState.candidateSetId || semanticProposal === null) {
      fail("Replacing pending evidence requires the exact current candidate-set ID and a fresh semantic proposal.", "FEATURE_MAPPING_SUPERSESSION_CONFLICT");
    }
    const oldCandidate = readFeatureMappingCandidateSet({ root: projectRoot, candidateSetId: expectedCandidateSetId }).candidateSet;
    if (oldCandidate.sessionId !== inspected.state.sessionId || previousState.reviewDecisionId !== null) fail("Pending candidate lineage is not an unreviewed current Session candidate.", "FEATURE_MAPPING_SUPERSESSION_CONFLICT");
    if (recordedCandidateReview({ projectRoot, projectId: inspected.project.projectId, candidateSet: oldCandidate }, storage)) {
      fail("A durable decision already exists. Recover its exact pending projection; do not supersede reviewed evidence.", "FEATURE_MAPPING_REVIEW_CONFLICT");
    }
  } else if (previousState?.phase === "awaiting-review") {
    fail(`Inspect pending evidence ${previousState.candidateSetId}; HEAD may explicitly replace it with an exact expected candidate-set ID and fresh proposal, or present it for user review when promotion is needed.`, "FEATURE_MAPPING_REVIEW_REQUIRED");
  }
  let indexed;
  try { indexed = (await inspectWorldModel({ root: projectRoot })); }
  catch (error) {
    if (semanticProposal != null || !["WORLD_MODEL_NOT_BUILT", "WORLD_MODEL_SNAPSHOT_MISSING"].includes(error.code)) throw error;
    // The explicit no-proposal setup may create its first derived view. An exact
    // proposal, however, must be checked against the World HEAD actually read.
    await buildWorldModel({ root: projectRoot, persist: true });
    indexed = (await inspectWorldModel({ root: projectRoot }));
  }
  if (indexed.status !== "current" && semanticProposal == null) {
    // Setup without pinned evidence can refresh in the same explicit operation.
    // The refresh pipeline preserves source/revision ancestry for real changes.
    await refreshWorldModel({ root: projectRoot });
    indexed = (await inspectWorldModel({ root: projectRoot }));
  }
  if (indexed.status !== "current") {
    fail("Repository evidence or Product Canon changed; explicitly refresh the World before proposing mappings.", "FEATURE_MAPPING_SOURCE_DRIFT");
  }
  const proposed = candidatesFromSemanticProposal(semanticProposal, indexed.snapshot, storage);
  const candidateSet = candidateSetArtifact({
    project: inspected.project,
    sessionId: inspected.state.sessionId,
    worldModel: indexed.snapshot,
    candidates: proposed.candidates,
    evidence: proposed.evidence,
    unknowns: proposed.unknowns,
  }, storage);
  const projected = await rebuildWithProjection({
    projectRoot,
    projectId: inspected.project.projectId,
    currentProductModelId: indexed.snapshot.productModel.productModelId,
    sourceWorld: indexed.snapshot,
    additionalCandidateSets: [candidateSet],
  }, storage);
  persistImmutable(candidateSetFile(projectRoot, candidateSet.candidateSetId, storage), candidateSet, "Feature mapping candidate set");
  const phase = candidateSet.candidates.length ? "awaiting-review" : "awaiting-evidence";
  const state = writeState(projectRoot, previousState, {
    projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId,
    phase,
    candidateSetId: candidateSet.candidateSetId,
    reviewDecisionId: null,
    worldModelId: projected.snapshot.worldModelId,
    graphSnapshotId: projected.snapshot.temporalProvenanceGraph.graphSnapshotId,
    sourceSnapshotId: projected.snapshot.temporalProvenanceGraph.sourceSnapshotId,
    productModelId: projected.snapshot.productModel.productModelId,
  }, storage);
  return {
    status: phase === "awaiting-review" ? "awaiting_feature_mapping_review" : "awaiting_feature_mapping_evidence",
    state,
    candidateSet,
    worldModel: {
      evidenceWorldModelId: indexed.snapshot.worldModelId,
      projectedWorldModelId: projected.snapshot.worldModelId,
      sourceSnapshotId: projected.snapshot.temporalProvenanceGraph.sourceSnapshotId,
      graphSnapshotId: projected.snapshot.temporalProvenanceGraph.graphSnapshotId,
    },
    authority: "candidates-have-no-promotion-authority",
  };
}

export function readFeatureMappingCandidateSet({ root = ".", candidateSetId } = {}) {
  const inspected = readyProject(root, "Feature mapping candidate-set inspection");
  const storage = inspected.storage;
  const file = candidateSetFile(inspected.project.projectRoot, candidateSetId, storage);
  if (!fs.existsSync(file)) fail(`Feature mapping candidate set not found: ${candidateSetId}`, "FEATURE_MAPPING_CANDIDATE_SET_NOT_FOUND");
  const candidateSet = verifyFeatureMappingCandidateSet(readJson(file, "Feature mapping candidate set"), inspected.project.projectId, storage);
  if (candidateSet.candidateSetId !== candidateSetId) {
    fail("Feature mapping candidate-set filename does not match its exact identity.", "FEATURE_MAPPING_CANDIDATE_SET_IDENTITY_MISMATCH");
  }
  return { status: "verified", file, candidateSet };
}

export function readFeatureMappingReviewDecision({ root = ".", reviewDecisionId } = {}) {
  const inspected = readyProject(root, "Feature mapping review inspection");
  const storage = inspected.storage;
  const file = reviewDecisionFile(inspected.project.projectRoot, reviewDecisionId, storage);
  if (!fs.existsSync(file)) fail(`Feature mapping ReviewDecision not found: ${reviewDecisionId}`, "FEATURE_MAPPING_REVIEW_NOT_FOUND");
  const review = readJson(file, "Feature mapping ReviewDecision");
  const candidateSet = readFeatureMappingCandidateSet({ root: inspected.project.projectRoot, candidateSetId: review.candidateSetId }).candidateSet;
  const reviewDecision = verifyFeatureMappingReviewDecision(review, candidateSet, inspected.project.projectId, storage);
  if (reviewDecision.reviewDecisionId !== reviewDecisionId) {
    fail("Feature mapping ReviewDecision filename does not match its exact identity.", "FEATURE_MAPPING_REVIEW_IDENTITY_MISMATCH");
  }
  return { status: "verified", file, reviewDecision };
}

function recordedCandidateReview({ projectRoot, projectId, candidateSet }, storage) {
  // Reuse the bounded canonical-artifact reader, never an embedded graph's
  // copy of a decision. No additional intent or transaction artifact is needed.
  const projection = loadFeatureMappingProjection({ storage, projectRoot, projectId, currentProductModelId: candidateSet.productModelId });
  const directory = relativeFile(projectRoot, FEATURE_MAPPING_REVIEW_DIRECTORY, storage);
  const files = fs.existsSync(directory)
    ? fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name)
    : [];
  const expectedFiles = new Set(projection.reviewDecisions.map((review) => `${review.reviewDecisionId}.json`));
  if (files.length !== expectedFiles.size || files.some((file) => !expectedFiles.has(file))) {
    fail("Feature mapping ReviewDecision filenames do not match their exact identities.", "FEATURE_MAPPING_REVIEW_IDENTITY_MISMATCH");
  }
  const matches = projection.reviewDecisions.filter((review) => review.candidateSetId === candidateSet.candidateSetId);
  if (matches.length > 1) {
    fail("The exact Feature mapping candidate set has conflicting durable decisions; preserve the records and reconcile their authority before proceeding.", "FEATURE_MAPPING_REVIEW_CONFLICT");
  }
  if (!matches.length) return null;
  const review = readFeatureMappingReviewDecision({ root: projectRoot, reviewDecisionId: matches[0].reviewDecisionId }).reviewDecision;
  if (review.sessionId !== candidateSet.sessionId) {
    fail("Feature mapping ReviewDecision belongs to a different HEAD Session.", "FEATURE_MAPPING_REVIEW_IDENTITY_MISMATCH");
  }
  return review;
}

function completeMappingReview({ projectRoot, state, review, snapshot, worldStatus = "current", reusedReviewDecision = false, updatePointer = true }, storage) {
  const nextPhase = review.disposition === "reject" ? "rejected" : "reviewed";
  const nextState = updatePointer ? writeState(projectRoot, state, {
    phase: nextPhase,
    reviewDecisionId: review.reviewDecisionId,
    worldModelId: snapshot.worldModelId,
    graphSnapshotId: snapshot.temporalProvenanceGraph.graphSnapshotId,
    sourceSnapshotId: snapshot.temporalProvenanceGraph.sourceSnapshotId,
    productModelId: snapshot.productModel.productModelId,
  }, storage) : state;
  return {
    status: nextPhase === "reviewed" ? "feature_mappings_reviewed" : "feature_mappings_rejected",
    state: nextState,
    reviewDecision: review,
    reusedReviewDecision,
    reviewedRelationshipCount: review.acceptedCandidateIds.length,
    worldModel: {
      status: worldStatus,
      worldModelId: snapshot.worldModelId,
      graphSnapshotId: snapshot.temporalProvenanceGraph.graphSnapshotId,
      sourceSnapshotId: snapshot.temporalProvenanceGraph.sourceSnapshotId,
    },
  };
}

function reviewProjectionState(snapshot, review) {
  const reviewDecisionIds = snapshot.featureMappingProjection?.reviewDecisionIds || [];
  const projectedReview = snapshot.temporalProvenanceGraph?.nodes?.find((node) => node.nodeId === review.reviewDecisionId) || null;
  const idPresent = reviewDecisionIds.includes(review.reviewDecisionId);
  const exact = idPresent && projectedReview?.kind === "FeatureMappingReviewDecision"
    && projectedReview.reviewDecisionHash === review.reviewDecisionHash;
  return {
    exact,
    absent: !idPresent && projectedReview == null,
  };
}

function exactRequestCanRepairOrphanProjection({ projectRoot, projectId, candidateSet, world, review }, storage) {
  const expectedProjection = loadFeatureMappingProjection({ storage,
    projectRoot,
    projectId,
    currentProductModelId: candidateSet.productModelId,
    additionalReviewDecisions: [review],
  });
  if (world.status !== "stale"
    || world.snapshot.temporalProvenanceGraph.sourceSnapshotId !== candidateSet.sourceSnapshotId
    || world.snapshot.productModel.productModelId !== candidateSet.productModelId
    || world.snapshot.productModel.productModelHash !== candidateSet.productModelHash
    || world.snapshot.featureMappingProjection?.projectionInputHash !== expectedProjection.projectionInputHash
    || !reviewProjectionState(world.snapshot, review).exact
    || world.changes?.featureMappingProjectionChanged !== true
    || world.changes?.temporalProvenanceChanged !== true) return false;
  const allowedDerivedDrift = new Set(["featureMappingProjectionChanged", "temporalProvenanceChanged"]);
  return Object.entries(world.changes || {}).every(([key, value]) => allowedDerivedDrift.has(key)
    || (Array.isArray(value) ? value.length === 0 : value !== true));
}

export async function reviewFeatureMapping(options = {}) {
  return (await withProjectMutationAsync({ root: options.root ?? ".", scope: "session-recovery" }, async () => (await reviewFeatureMappingLocked(options))));
}

async function reviewFeatureMappingLocked({ root = ".", candidateSetId, disposition, acceptedCandidateIds = [], rationale } = {}) {
  const inspected = readyProject(root, "Feature mapping review");
  const storage = inspected.storage;
  if (inspected.state.activeRunId || inspected.state.pendingReview) {
    fail("Feature mapping review cannot change reviewed relationships while a Run is active or awaiting review.", "FEATURE_MAPPING_RUN_CONFLICT");
  }
  const projectRoot = inspected.project.projectRoot;
  const pointerFile = stateFile(projectRoot, storage);
  if (!fs.existsSync(pointerFile)) fail("Feature mapping has not started.", "FEATURE_MAPPING_NOT_STARTED");
  const state = verifyState(readJson(pointerFile, "Feature mapping state pointer"), { projectId: inspected.project.projectId, sessionId: inspected.state.sessionId }, storage);
  if (!["awaiting-review", "reviewed", "rejected"].includes(state.phase) || state.candidateSetId !== candidateSetId) {
    fail("Feature mapping review references a stale or non-reviewable candidate set.", "STALE_FEATURE_MAPPING_CANDIDATE_SET");
  }
  const candidateSet = readFeatureMappingCandidateSet({ root: projectRoot, candidateSetId }).candidateSet;
  if (candidateSet.sessionId !== state.sessionId) {
    fail("Feature mapping candidate set belongs to a different HEAD Session.", "FEATURE_MAPPING_CANDIDATE_SET_IDENTITY_MISMATCH");
  }
  const normalizedDisposition = requiredText(disposition, "Review disposition").toLocaleLowerCase();
  if (!["accept-all", "accept-selection", "reject"].includes(normalizedDisposition)) {
    fail("Feature mapping disposition must be accept-all, accept-selection, or reject.", "INVALID_FEATURE_MAPPING_REVIEW_DISPOSITION");
  }
  if (!Array.isArray(acceptedCandidateIds) || acceptedCandidateIds.some((id) => typeof id !== "string" || !id)) {
    fail("acceptedCandidateIds must be an array of identities.", "INVALID_FEATURE_MAPPING_REVIEW_SELECTION");
  }
  const allIds = candidateSet.candidates.map((candidate) => candidate.candidateId);
  const known = new Set(allIds);
  const selectedIds = normalizedDisposition === "accept-all" ? allIds : normalizedDisposition === "reject" ? [] : [...new Set(acceptedCandidateIds)].sort();
  if (selectedIds.some((id) => !known.has(id))) fail("Feature mapping review references an unknown candidate.", "UNKNOWN_FEATURE_MAPPING_CANDIDATE");
  if (normalizedDisposition === "accept-selection" && !selectedIds.length) {
    fail("accept-selection requires at least one candidate.", "FEATURE_MAPPING_SELECTION_REQUIRED");
  }
  const selected = new Set(selectedIds);
  const rejectedIds = allIds.filter((id) => !selected.has(id));
  const review = buildReviewDecision({
    candidateSet,
    disposition: normalizedDisposition,
    acceptedCandidateIds: selectedIds,
    rejectedCandidateIds: rejectedIds,
    rationale,
  }, storage);
  const recordedReview = recordedCandidateReview({ projectRoot, projectId: inspected.project.projectId, candidateSet }, storage);
  const pointerPending = state.phase === "awaiting-review";
  if (!pointerPending && (!recordedReview || state.reviewDecisionId !== recordedReview.reviewDecisionId
    || state.phase !== (recordedReview.disposition === "reject" ? "rejected" : "reviewed"))) {
    fail("Completed Feature mapping state does not match its exact durable decision.", "FEATURE_MAPPING_REVIEW_CONFLICT");
  }
  if (recordedReview && featureMappingCanonicalJson(recordedReview) !== featureMappingCanonicalJson(review)) {
    if (!pointerPending) fail("Feature mapping review references an already reviewed candidate set.", "STALE_FEATURE_MAPPING_CANDIDATE_SET");
    fail(`A different Feature mapping ReviewDecision is already durable for this exact candidate set. Retry the unchanged saved decision ${recordedReview.reviewDecisionId} to finish its pending state update.`, "FEATURE_MAPPING_REVIEW_CONFLICT");
  }
  let currentWorld = (await inspectWorldModel({ root: projectRoot }));
  if (recordedReview) {
    const projectionState = reviewProjectionState(currentWorld.snapshot, recordedReview);
    if (!projectionState.exact && !projectionState.absent) {
      fail("The World projection does not match the exact saved Feature mapping decision.", "FEATURE_MAPPING_REVIEW_PROJECTION_MISMATCH");
    }
    if (projectionState.absent) {
      await rebuildWithProjection({
        projectRoot,
        projectId: inspected.project.projectId,
        currentProductModelId: currentWorld.snapshot.productModel.productModelId,
        sourceWorld: currentWorld.snapshot,
      }, storage);
      currentWorld = (await inspectWorldModel({ root: projectRoot }));
      if (!reviewProjectionState(currentWorld.snapshot, recordedReview).exact) {
        fail("The saved Feature mapping decision could not be verified in the rebuilt World projection.", "FEATURE_MAPPING_REVIEW_PROJECTION_MISMATCH");
      }
    }
    // The durable exact P1 decision already owns the disposition. Source drift
    // is disclosed, not reinterpreted as a need to approve that decision again.
    return completeMappingReview({ projectRoot, state, review: recordedReview, snapshot: currentWorld.snapshot,
      worldStatus: currentWorld.status, reusedReviewDecision: true, updatePointer: pointerPending }, storage);
  }
  const currentCandidateEvidence = candidateEvidenceIsCurrent(candidateSet, currentWorld);
  const repairableOrphanProjection = normalizedDisposition !== "reject" && !currentCandidateEvidence && exactRequestCanRepairOrphanProjection({
    projectRoot, projectId: inspected.project.projectId, candidateSet, world: currentWorld, review,
  }, storage);
  if (normalizedDisposition !== "reject" && !currentCandidateEvidence && !repairableOrphanProjection) {
    fail(`Repository evidence or Product Canon changed after mapping proposal. Explicitly reject the outdated candidate set ${candidateSetId}, then have HEAD propose fresh evidence; stale candidates cannot be accepted.`, "FEATURE_MAPPING_SOURCE_DRIFT");
  }
  if (normalizedDisposition === "reject" && currentWorld.status !== "current") {
    // A rejection closes an exact historical proposal, not a claim that its
    // evidence is current. Refresh only its derived view, preserving ancestry.
    // All request/authority validation above must finish before this write.
    await refreshWorldModel({ root: projectRoot });
    currentWorld = (await inspectWorldModel({ root: projectRoot }));
    if (currentWorld.status !== "current") {
      fail("World evidence changed during rejection refresh; retry the same explicit rejection after concurrent changes settle.", "FEATURE_MAPPING_SOURCE_DRIFT");
    }
  }
  // P1 authority is durable before the rebuildable P4 projection. A failed
  // projection write therefore recovers from this exact decision without a
  // second user choice. A legacy orphan projection is only accepted when the
  // current explicit request matches it and all non-derived evidence is exact.
  persistImmutable(reviewDecisionFile(projectRoot, review.reviewDecisionId, storage), review, "Feature mapping ReviewDecision");
  const projected = await rebuildWithProjection({
    projectRoot,
    projectId: inspected.project.projectId,
    currentProductModelId: currentWorld.snapshot.productModel.productModelId,
    sourceWorld: currentWorld.snapshot,
  }, storage);
  return completeMappingReview({ projectRoot, state, review, snapshot: projected.snapshot }, storage);
}

function candidateEvidenceIsCurrent(candidateSet, world) {
  return world.status === "current"
    && world.snapshot.temporalProvenanceGraph.sourceSnapshotId === candidateSet.sourceSnapshotId
    && world.snapshot.productModel.productModelId === candidateSet.productModelId
    && world.snapshot.productModel.productModelHash === candidateSet.productModelHash;
}

function reviewedRelationshipDiagnostics(world) {
  const graph = world.snapshot.temporalProvenanceGraph;
  const relationships = graph.nodes
    .filter((node) => node.kind === "ReviewedRelationship")
    .map((node) => ({
      reviewedRelationshipId: node.nodeId,
      relationshipType: node.relationshipType,
      fromNodeId: node.fromNodeId,
      toNodeId: node.toNodeId,
      approvalStatus: node.approvalStatus || "approved",
      endpointStatus: node.endpointStatus || (node.projectionStatus === "current" ? "present" : "missing"),
      evidenceStatus: node.evidenceStatus || (node.projectionStatus === "current" ? "unchanged" : "unavailable"),
      semanticAssessmentStatus: node.semanticAssessmentStatus || (node.projectionStatus === "current" ? "assessed" : "not-assessed"),
      projectionStatus: node.projectionStatus,
      projectionCurrent: node.projectionCurrent ?? node.projectionStatus === "current",
      currentFromRevisionId: node.currentFromRevisionId ?? null,
      currentToRevisionId: node.currentToRevisionId ?? null,
      userActionRequired: false,
    })).sort((left, right) => left.reviewedRelationshipId.localeCompare(right.reviewedRelationshipId));
  const product = world.snapshot.productModel;
  const nodeById = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const groupByKey = new Map(product.featureGroups.map((group) => [group.key, group]));
  const groupPaths = (groupKey, seen = new Set()) => {
    if (seen.has(groupKey)) return [[groupKey]];
    const group = groupByKey.get(groupKey);
    if (!group || !group.parentFeatureGroupKeys.length) return [[groupKey]];
    const nextSeen = new Set([...seen, groupKey]);
    return group.parentFeatureGroupKeys.flatMap((parentKey) => groupPaths(parentKey, nextSeen)
      .map((path) => [...path, groupKey]));
  };
  const productLogicalByKindKey = new Map(graph.nodes.filter((node) => ["Feature", "FeatureGroup", "Capability"].includes(node.kind))
    .map((node) => [`${node.kind}:${node.key}`, node.nodeId]));
  const allCodeToProductPaths = relationships.flatMap((relationship) => {
    const productKind = relationship.relationshipType === "IMPLEMENTS" ? nodeById.get(relationship.toNodeId)?.kind : nodeById.get(relationship.fromNodeId)?.kind;
    const productNodeId = relationship.relationshipType === "IMPLEMENTS" ? relationship.toNodeId : relationship.fromNodeId;
    const sourceNodeId = relationship.relationshipType === "IMPLEMENTS" ? relationship.fromNodeId : relationship.toNodeId;
    const productNode = nodeById.get(productNodeId);
    const base = {
      reviewedRelationshipId: relationship.reviewedRelationshipId,
      relationshipType: relationship.relationshipType,
      sourceNodeId,
      sourcePath: nodeById.get(sourceNodeId)?.path || "",
      productNodeId,
      productKind,
      productKey: productNode?.key || "",
      projectionStatus: relationship.projectionStatus,
    };
    if (productKind !== "Feature") return [{ ...base, featureGroupPathKeys: [], featureGroupPathNodeIds: [] }];
    const feature = product.features.find((item) => item.key === productNode.key);
    if (!feature?.featureGroupKeys?.length) return [{ ...base, featureGroupPathKeys: [], featureGroupPathNodeIds: [] }];
    return feature.featureGroupKeys.flatMap((groupKey) => groupPaths(groupKey).map((pathKeys) => ({
      ...base,
      featureGroupPathKeys: pathKeys,
      featureGroupPathNodeIds: pathKeys.map((key) => productLogicalByKindKey.get(`FeatureGroup:${key}`)).filter(Boolean),
    })));
  }).sort((left, right) => left.reviewedRelationshipId.localeCompare(right.reviewedRelationshipId)
    || left.featureGroupPathKeys.join("/").localeCompare(right.featureGroupPathKeys.join("/")));
  const codeToProductPaths = allCodeToProductPaths.slice(0, MAX_DIAGNOSTIC_PATHS);
  const omittedPaths = allCodeToProductPaths.slice(MAX_DIAGNOSTIC_PATHS);
  const featureCoverage = product.features.map((feature) => {
    const nodeId = productLogicalByKindKey.get(`Feature:${feature.key}`);
    const matching = relationships.filter((relationship) => relationship.relationshipType === "IMPLEMENTS" && relationship.toNodeId === nodeId);
    return {
      featureKey: feature.key,
      featureNodeId: nodeId,
      featureGroupKeys: feature.featureGroupKeys,
      mappingStatus: matching.some((item) => item.projectionCurrent) ? "current"
        : matching.length ? "historical-or-stale" : "unmapped",
      reviewedRelationshipIds: matching.map((item) => item.reviewedRelationshipId).sort(),
    };
  }).sort((left, right) => left.featureKey.localeCompare(right.featureKey));
  const groupCoverage = product.featureGroups.map((group) => {
    const descendantKeys = new Set(product.featureGroups.filter((candidate) => groupPaths(candidate.key).some((path) => path.includes(group.key))).map((item) => item.key));
    const members = featureCoverage.filter((feature) => feature.featureGroupKeys.some((key) => descendantKeys.has(key)));
    return {
      featureGroupKey: group.key,
      featureGroupNodeId: productLogicalByKindKey.get(`FeatureGroup:${group.key}`),
      parentFeatureGroupKeys: group.parentFeatureGroupKeys,
      featureCount: members.length,
      currentMappedFeatureCount: members.filter((feature) => feature.mappingStatus === "current").length,
      staleMappedFeatureCount: members.filter((feature) => feature.mappingStatus === "historical-or-stale").length,
      unmappedFeatureCount: members.filter((feature) => feature.mappingStatus === "unmapped").length,
    };
  }).sort((left, right) => left.featureGroupKey.localeCompare(right.featureGroupKey));
  return {
    reviewedCount: relationships.length,
    projectionCurrentCount: relationships.filter((item) => item.projectionCurrent).length,
    needsHeadRecheckCount: relationships.filter((item) => item.semanticAssessmentStatus === "needs-recheck").length,
    reintroducedEndpointCount: relationships.filter((item) => item.endpointStatus === "reintroduced").length,
    missingEndpointCount: relationships.filter((item) => item.endpointStatus === "missing").length,
    userActionRequired: false,
    relationships,
    productCoverage: {
      featureCoverage,
      featureGroupCoverage: groupCoverage,
      codeToProductPaths,
      pathBoundary: {
        complete: omittedPaths.length === 0,
        included: codeToProductPaths.length,
        total: allCodeToProductPaths.length,
        omitted: omittedPaths.length,
        nextReviewedRelationshipIds: [...new Set(omittedPaths.map((item) => item.reviewedRelationshipId))].slice(0, 20),
        expansion: "query the current GraphSnapshot by the listed ReviewedRelationship ids",
      },
      authority: "read-only-P4-diagnostic",
      userActionRequired: false,
    },
  };
}

export async function inspectFeatureMapping({ root = "." } = {}) {
  const inspected = readyProject(root, "Feature mapping inspection");
  const storage = inspected.storage;
  const file = stateFile(inspected.project.projectRoot, storage);
  if (!fs.existsSync(file)) {
    return {
      status: "not_started",
      projectId: inspected.project.projectId,
      sessionId: inspected.state.sessionId,
      nextAction: "Have fresh HEAD inspect the current graph, then run feature-mapping-start with a semantic proposal.",
    };
  }
  const state = verifyState(readJson(file, "Feature mapping state pointer"), { projectId: inspected.project.projectId, sessionId: inspected.state.sessionId }, storage);
  const candidateSet = state.candidateSetId
    ? readFeatureMappingCandidateSet({ root: inspected.project.projectRoot, candidateSetId: state.candidateSetId }).candidateSet
    : null;
  if (candidateSet && candidateSet.sessionId !== state.sessionId) {
    fail("Feature mapping candidate set belongs to a different HEAD Session.", "FEATURE_MAPPING_CANDIDATE_SET_IDENTITY_MISMATCH");
  }
  const savedReview = candidateSet ? recordedCandidateReview({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, candidateSet }, storage) : null;
  const reviewDecision = state.reviewDecisionId
    ? readFeatureMappingReviewDecision({ root: inspected.project.projectRoot, reviewDecisionId: state.reviewDecisionId }).reviewDecision
    : savedReview;
  const world = (await inspectWorldModel({ root: inspected.project.projectRoot }));
  const awaitingReview = state.phase === "awaiting-review";
  const currentEvidence = candidateSet && candidateEvidenceIsCurrent(candidateSet, world);
  const runConflict = Boolean(inspected.state.activeRunId || inspected.state.pendingReview);
  return {
    status: state.phase.replaceAll("-", "_"),
    state,
    candidateSet,
    reviewDecision,
    reviewRecovery: awaitingReview && savedReview ? { status: "pointer-update-pending", reviewDecisionId: savedReview.reviewDecisionId, requiresNewUserDecision: false } : null,
    reviewReadiness: awaitingReview ? {
      candidateSetId: candidateSet.candidateSetId,
      evidenceStatus: currentEvidence ? "current" : "stale",
      acceptanceAvailable: currentEvidence && !runConflict && !savedReview,
      explicitRejectionAvailable: !runConflict && !savedReview,
      runConflict,
      nextAction: runConflict
        ? "Finish the existing Run or its pending review before changing the mapping review state."
        : savedReview
        ? "Retry the unchanged saved ReviewDecision to finish its pending state update; no new user decision is needed."
        : currentEvidence
        ? "Ask the user to review this exact candidate set; only explicit acceptance promotes mappings."
        : "Ask whether the user wants to reject this exact outdated candidate set, then have HEAD propose fresh evidence. Rejection preserves earlier approved mappings.",
    } : null,
    worldModel: {
      status: world.status,
      worldModelId: world.snapshot.worldModelId,
      graphSnapshotId: world.snapshot.temporalProvenanceGraph.graphSnapshotId,
      sourceSnapshotId: world.snapshot.temporalProvenanceGraph.sourceSnapshotId,
      matchesMappingState: world.snapshot.worldModelId === state.worldModelId
        && world.snapshot.temporalProvenanceGraph.graphSnapshotId === state.graphSnapshotId,
    },
    relationshipDiagnostics: reviewedRelationshipDiagnostics(world),
    authority: {
      candidates: "non-authoritative-until-explicit-review",
      reviewedRelationships: "explicit-user-reviewed-mapping-facts",
      productCanon: "unchanged-user-owned-project-canon",
      graph: "rebuildable-derived-projection",
    },
  };
}
