import { withSnapshotReferences, withSnapshotReferencesAsync } from "./snapshot-reference-lifetime.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicCreateArtifact } from "./artifact-storage.mjs";
import { inspectProject, SCHEMA_VERSION } from "./lode-core.mjs";
import { readContextCapsule } from "./context-compiler.mjs";
import { artifactAuthorityBoundary, verifyArtifactAuthorityBoundary } from "./authority-plane-contract.mjs";

import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";

const projectStorage = new WeakMap();

export const EXECUTION_LINEAGE_VERSION = "0.4.0";
const FRESH_HEAD_REVIEW_VERSION = "0.1.0";

const DEFINITIONS = Object.freeze({
  WholePlanSnapshot: { prefix: "whole-plan", directory: "whole-plans", idField: "wholePlanId" },
  ExecutionContract: { prefix: "execution-contract", directory: "execution-contracts", idField: "executionContractId" },
  ResultPacket: { prefix: "result-packet", directory: "result-packets", idField: "resultPacketId" },
  ReviewDecision: { prefix: "review-decision", directory: "review-decisions", idField: "reviewDecisionId" },
});

const fail = (message, code = "EXECUTION_LINEAGE_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is required.`, "INVALID_LINEAGE_INPUT");
  return value.trim();
}

function optionalText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value, label, { required = false } = {}) {
  const source = value == null ? [] : value;
  if (!Array.isArray(source) || source.some((item) => typeof item !== "string" || !item.trim())) {
    fail(`${label} must be an array of non-empty strings.`, "INVALID_LINEAGE_INPUT");
  }
  const normalized = source.map((item) => item.trim());
  if (required && normalized.length === 0) fail(`${label} must not be empty.`, "INVALID_LINEAGE_INPUT");
  return normalized;
}

function recordList(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    fail(`${label} must be an array of objects.`, "INVALID_LINEAGE_INPUT");
  }
  return value.map((item) => canonical(item));
}

function candidateKnowledge(value) {
  const records = recordList(value, "Knowledge proposals");
  const allowedKinds = new Set(["Evidence", "Claim", "Decision", "Unknown"]);
  return records.map((item) => {
    if (!allowedKinds.has(item.kind)) fail("Knowledge proposal kind is invalid.", "INVALID_KNOWLEDGE_PROPOSAL");
    const candidate = { ...item };
    delete candidate.proposalId;
    delete candidate.status;
    delete candidate.instructionAuthority;
    if (!Object.entries(candidate).some(([key, entry]) => key !== "kind" && typeof entry === "string" && entry.trim())) {
      fail("Knowledge proposal must contain descriptive content.", "INVALID_KNOWLEDGE_PROPOSAL");
    }
    const proposalHash = digest(canonicalJson(candidate));
    return {
      ...candidate,
      proposalId: `knowledge-proposal-${proposalHash.slice(0, 24)}`,
      status: "candidate",
      instructionAuthority: false,
    };
  });
}

function knowledgeRecommendations(value, proposals) {
  const records = recordList(value, "Knowledge recommendations");
  const validIds = new Set(proposals.map((item) => item.proposalId));
  const allowed = new Set(["recommend-promotion", "reject", "defer"]);
  const seen = new Set();
  return records.map((item) => {
    if (!validIds.has(item.proposalId)) fail("Knowledge recommendation references an unknown proposal.", "UNKNOWN_KNOWLEDGE_PROPOSAL");
    if (seen.has(item.proposalId)) fail("Knowledge proposal recommendation is duplicated.", "DUPLICATE_KNOWLEDGE_RECOMMENDATION");
    seen.add(item.proposalId);
    if (!allowed.has(item.recommendation)) fail("Knowledge recommendation is invalid.", "INVALID_KNOWLEDGE_RECOMMENDATION");
    return {
      proposalId: item.proposalId,
      recommendation: item.recommendation,
      rationale: requiredText(item.rationale, "Knowledge recommendation rationale"),
      authorityEffect: "none-until-separate-authorized-promotion",
    };
  });
}

function projectForWrite(root) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") {
    fail(`Project must be ready to write lineage; current status: ${inspected.status}.`, "PROJECT_NOT_READY");
  }
  projectStorage.set(inspected.project, inspected.storage);
  return inspected.project;
}

function projectForRead(root) {
  const inspected = inspectProject(root);
  if (inspected.status === "not_initialized") fail("Lode Agent Core is not initialized.", "NOT_INITIALIZED");
  projectStorage.set(inspected.project, inspected.storage);
  return inspected.project;
}

function definitionForId(artifactId) {
  if (typeof artifactId !== "string") fail("Lineage artifact id is required.", "INVALID_LINEAGE_ID");
  const match = Object.entries(DEFINITIONS).find(([, definition]) => artifactId.startsWith(`${definition.prefix}-`));
  if (!match || !/^[a-z-]+-[a-f0-9]{24}$/.test(artifactId)) fail("Lineage artifact id is invalid.", "INVALID_LINEAGE_ID");
  return { kind: match[0], ...match[1] };
}

function artifactFile(root, definition, artifactId, storage) {
  return path.join(root, formatForVerifiedOwner(storage).directory, "lineage", definition.directory, `${artifactId}.json`);
}

function buildArtifact({ project, kind, body, parents = [] }) {
  const definition = DEFINITIONS[kind];
  if (!definition) fail(`Unsupported lineage artifact kind: ${kind}`, "UNSUPPORTED_LINEAGE_KIND");
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind,
    protocol: { name: formatForVerifiedOwner(projectStorage.get(project)).protocol("head-agent-core-execution-lineage"), version: EXECUTION_LINEAGE_VERSION },
    projectId: project.projectId,
    authorityBoundary: artifactAuthorityBoundary(kind),
    ...body,
    lineage: parents.map((item) => ({ kind: "LineageLink", relation: item.relation, targetId: item.targetId })),
  };
  const artifactHash = digest(canonicalJson(payload));
  const artifactId = `${definition.prefix}-${artifactHash.slice(0, 24)}`;
  return { ...payload, [definition.idField]: artifactId, artifactHash };
}

function persistArtifact(root, artifact, persist, storage) {
  const definition = DEFINITIONS[artifact.kind];
  const artifactId = artifact[definition.idField];
  if (!persist) return { status: "preview", artifact };
  const file = artifactFile(root, definition, artifactId, storage);
  if (fs.existsSync(file)) {
    const existing = readLineageArtifact({ root, artifactId });
    return { status: "existing", file, artifact: existing.artifact };
  }
  try { atomicCreateArtifact(file, json(artifact)); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    return { status: "existing", file, artifact: readLineageArtifact({ root, artifactId }).artifact };
  }
  return { status: "recorded", file, artifact };
}

export function readLineageArtifact({ root = ".", artifactId } = {}) {
  const project = projectForRead(root);
  const definition = definitionForId(artifactId);
  const file = artifactFile(project.projectRoot, definition, artifactId, projectStorage.get(project));
  if (!fs.existsSync(file)) fail(`Lineage artifact not found: ${artifactId}`, "LINEAGE_ARTIFACT_NOT_FOUND");
  let artifact;
  try { artifact = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`Lineage artifact is invalid JSON: ${error.message}`, "INVALID_LINEAGE_ARTIFACT"); }
  if (artifact.kind !== definition.kind || artifact.projectId !== project.projectId) {
    fail("Lineage artifact identity does not match this project.", "LINEAGE_IDENTITY_MISMATCH");
  }
  const lineageVersion = artifact.protocol?.version;
  if (!familyFormatForOriginal("head-agent-core-execution-lineage", artifact, projectStorage.get(project)) || !new Set(["0.3.0", EXECUTION_LINEAGE_VERSION]).has(lineageVersion)) {
    fail("Lineage artifact protocol is invalid.", "INVALID_LINEAGE_ARTIFACT");
  }
  if (lineageVersion === EXECUTION_LINEAGE_VERSION) verifyArtifactAuthorityBoundary(artifact.kind, artifact.authorityBoundary);
  const recordedHash = artifact.artifactHash;
  const payload = { ...artifact };
  delete payload[definition.idField];
  delete payload.artifactHash;
  const actualHash = digest(canonicalJson(payload));
  if (artifact[definition.idField] !== artifactId || recordedHash !== actualHash || artifactId !== `${definition.prefix}-${actualHash.slice(0, 24)}`) {
    fail("Lineage artifact digest verification failed.", "LINEAGE_DIGEST_MISMATCH");
  }
  return { status: "verified", file, artifact };
}

function requireArtifact(root, artifactId, kind) {
  const result = readLineageArtifact({ root, artifactId });
  if (result.artifact.kind !== kind) fail(`Expected ${kind}: ${artifactId}`, "LINEAGE_KIND_MISMATCH");
  return result.artifact;
}

function verifiedFreshLodeReview(review, storage) {
  const format = formatForVerifiedOwner(storage);
  // Legacy review validation historically used kind/hash/prefix, not a new
  // protocol/version readiness gate. Only the new family adds its tuple guard.
  if (!review || review.kind !== format.kind("FreshHeadReview")
    || format.dialect === "lode" && !familyFormatForOriginal("head-agent-core-fresh-head-review", review, storage)) fail("Fresh HEAD review context is required.", "INVALID_FRESH_HEAD_REVIEW");
  const recordedHash = review.reviewContextHash;
  const recordedId = review.reviewContextId;
  const payload = { ...review };
  delete payload.reviewContextId;
  delete payload.reviewContextHash;
  const actualHash = digest(canonicalJson(payload));
  if (recordedHash !== actualHash || recordedId !== `${format.value("fresh-head-review")}-${actualHash.slice(0, 24)}`) {
    fail("Fresh HEAD review context digest verification failed.", "FRESH_HEAD_REVIEW_DIGEST_MISMATCH");
  }
  return review;
}

export function buildFreshLodeReview({ root = ".", wholePlanId, resultPacketId, sessionId = "", runId = "", historical = false } = {}) {
  if (typeof historical !== "boolean") fail("Historical review projection mode must be explicit.", "INVALID_FRESH_HEAD_REVIEW");
  // Recompute immutable historical P4 evidence without requiring current role
  // projections or Session readiness. This never applies a ReviewDecision;
  // ordinary review/action callers retain the existing ready-project boundary.
  const project = historical ? projectForRead(root) : projectForWrite(root);
  const planId = requiredText(wholePlanId, "Whole-plan id");
  const resultId = requiredText(resultPacketId, "Result Packet id");
  const plan = requireArtifact(project.projectRoot, planId, "WholePlanSnapshot");
  const result = requireArtifact(project.projectRoot, resultId, "ResultPacket");
  const contract = requireArtifact(project.projectRoot, result.executionContractId, "ExecutionContract");
  if (contract.wholePlanId !== planId) {
    fail("Result Packet and Fresh HEAD review do not reference the same WholePlanSnapshot.", "LINEAGE_CONFLICT");
  }
  const capsule = readContextCapsule({ root: project.projectRoot, capsuleId: contract.capsuleId }).capsule;
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: formatForVerifiedOwner(projectStorage.get(project)).kind("FreshHeadReview"),
    protocol: { name: formatForVerifiedOwner(projectStorage.get(project)).protocol("head-agent-core-fresh-head-review"), version: FRESH_HEAD_REVIEW_VERSION },
    projectId: project.projectId,
    sessionId: optionalText(sessionId),
    runId: optionalText(runId),
    wholePlan: plan,
    executionContract: contract,
    resultPacket: result,
    contextReference: {
      capsuleId: capsule.capsuleId,
      capsuleHash: capsule.capsuleHash,
      snapshotId: capsule.snapshot?.snapshotId || "",
      coverage: capsule.snapshot?.coverage || "unknown",
    },
    authority: project.authority,
    reviewProtocol: {
      question: "Does the result deliver the user's intended outcome to its next actual consumer? Which evidence supports that claim, what remains unverified, and does the ExecutionContract still serve the WholePlanSnapshot objective and invariants rather than narrowing them? Distinguish source changes, fixture/test success, installation, and actual Host behavior; require only evidence appropriate to this task's claims.",
      allowedDispositions: ["accept", "revise", "expand", "rollback", "escalate"],
      requiredReturn: ["disposition", "rationale", "nextActions"],
    },
    excludedContext: [
      "executor-transcript",
      "raw-failure-log",
      "provider-session-state",
      "unpromoted-repository-instructions",
    ],
  };
  const reviewContextHash = digest(canonicalJson(payload));
  const review = {
    ...payload,
    reviewContextId: `${formatForVerifiedOwner(projectStorage.get(project)).value("fresh-head-review")}-${reviewContextHash.slice(0, 24)}`,
    reviewContextHash,
  };
  return { status: "ready_for_fresh_head_review", review };
}

function createWholePlanSnapshotUncoordinated({ root = ".", objective, plan, invariants = [], sources = [], persist = true } = {}) {
  const project = projectForWrite(root);
  const normalizedObjective = requiredText(objective, "Whole-plan objective");
  if (plan == null || (typeof plan === "string" && !plan.trim())) fail("Whole plan is required.", "INVALID_LINEAGE_INPUT");
  const artifact = buildArtifact({
    project,
    kind: "WholePlanSnapshot",
    body: {
      objective: normalizedObjective,
      plan: canonical(plan),
      generation: 0,
      invariants: stringList(invariants, "Whole-plan invariants"),
      sources: recordList(sources, "Whole-plan sources"),
    },
    parents: [],
  });
  return persistArtifact(project.projectRoot, artifact, persist, projectStorage.get(project));
}

function createNextWholePlanSnapshotUncoordinated({ root = ".", reviewDecisionId, plan, invariants, sources, persist = true } = {}) {
  const project = projectForWrite(root);
  const reviewId = requiredText(reviewDecisionId, "ReviewDecision id");
  if (plan == null || (typeof plan === "string" && !plan.trim())) fail("Next whole plan is required.", "INVALID_LINEAGE_INPUT");
  const review = requireArtifact(project.projectRoot, reviewId, "ReviewDecision");
  if (!new Set(["revise", "expand"]).has(review.disposition)) {
    fail("Only revise or expand ReviewDecisions may create a next WholePlanSnapshot.", "NEXT_PLAN_NOT_ALLOWED");
  }
  const previous = requireArtifact(project.projectRoot, review.wholePlanId, "WholePlanSnapshot");
  const nextInvariants = invariants == null
    ? previous.invariants || []
    : stringList(invariants, "Whole-plan invariants");
  const nextSources = sources == null
    ? previous.sources || []
    : recordList(sources, "Whole-plan sources");
  const artifact = buildArtifact({
    project,
    kind: "WholePlanSnapshot",
    body: {
      objective: previous.objective,
      plan: canonical(plan),
      generation: Number(previous.generation || 0) + 1,
      previousWholePlanId: previous.wholePlanId,
      reviewDecisionId: review.reviewDecisionId,
      invariants: nextInvariants,
      sources: nextSources,
    },
    parents: [
      { relation: "refines", targetId: previous.wholePlanId },
      { relation: "responds-to", targetId: review.reviewDecisionId },
    ],
  });
  return persistArtifact(project.projectRoot, artifact, persist, projectStorage.get(project));
}

function createExecutionContractUncoordinated({ root = ".", wholePlanId, capsuleId, scope, acceptanceCriteria, constraints = [], allowedActions = [], forbiddenActions = [], persist = true } = {}) {
  const project = projectForWrite(root);
  const planId = requiredText(wholePlanId, "Whole-plan id");
  const contextId = requiredText(capsuleId, "Context Capsule id");
  requireArtifact(project.projectRoot, planId, "WholePlanSnapshot");
  readContextCapsule({ root: project.projectRoot, capsuleId: contextId });
  const artifact = buildArtifact({
    project,
    kind: "ExecutionContract",
    body: {
      wholePlanId: planId,
      capsuleId: contextId,
      contextAcceptance: {
        authority: formatForVerifiedOwner(projectStorage.get(project)).value("HEAD"),
        disposition: "accepted-for-this-execution-contract",
        semanticJudgmentSource: formatForVerifiedOwner(projectStorage.get(project)).value("HEAD-not-context-compiler"),
      },
      scope: requiredText(scope, "Execution scope"),
      acceptanceCriteria: stringList(acceptanceCriteria, "Acceptance criteria", { required: true }),
      constraints: stringList(constraints, "Execution constraints"),
      allowedActions: stringList(allowedActions, "Allowed actions"),
      forbiddenActions: stringList(forbiddenActions, "Forbidden actions"),
    },
    parents: [
      { relation: "bounded-by", targetId: planId },
      { relation: "context-from", targetId: contextId },
    ],
  });
  return persistArtifact(project.projectRoot, artifact, persist, projectStorage.get(project));
}

function createResultPacketUncoordinated({ root = ".", executionContractId, outcome, evidence, planDelta = "", impactRadius = [], verification, unknowns = [], knowledgeProposals = [], persist = true } = {}) {
  const project = projectForWrite(root);
  const contractId = requiredText(executionContractId, "Execution Contract id");
  const contract = requireArtifact(project.projectRoot, contractId, "ExecutionContract");
  requireArtifact(project.projectRoot, contract.wholePlanId, "WholePlanSnapshot");
  readContextCapsule({ root: project.projectRoot, capsuleId: contract.capsuleId });
  const normalizedEvidence = recordList(evidence, "Result evidence").map((item) => ({ ...item, instructionAuthority: false }));
  const normalizedVerification = recordList(verification, "Result verification");
  if (normalizedEvidence.length === 0) fail("Result evidence must not be empty.", "INVALID_LINEAGE_INPUT");
  if (normalizedVerification.length === 0) fail("Result verification must not be empty.", "INVALID_LINEAGE_INPUT");
  const artifact = buildArtifact({
    project,
    kind: "ResultPacket",
    body: {
      executionContractId: contractId,
      outcome: requiredText(outcome, "Result outcome"),
      evidence: normalizedEvidence,
      planDelta: optionalText(planDelta),
      impactRadius: stringList(impactRadius, "Impact radius"),
      verification: normalizedVerification,
      unknowns: stringList(unknowns, "Result unknowns"),
      knowledgeProposals: candidateKnowledge(knowledgeProposals),
      recoveryAuthority: false,
      canonMutationAuthority: false,
      reviewDecisionCreated: false,
    },
    parents: [{ relation: "result-of", targetId: contractId }],
  });
  return persistArtifact(project.projectRoot, artifact, persist, projectStorage.get(project));
}

function createReviewDecisionUncoordinated({ root = ".", wholePlanId, resultPacketId, reviewContext, disposition, rationale, nextActions = [], knowledgeProposalRecommendations = [], persist = true } = {}) {
  const project = projectForWrite(root);
  const planId = requiredText(wholePlanId, "Whole-plan id");
  const resultId = requiredText(resultPacketId, "Result Packet id");
  requireArtifact(project.projectRoot, planId, "WholePlanSnapshot");
  const result = requireArtifact(project.projectRoot, resultId, "ResultPacket");
  const contract = requireArtifact(project.projectRoot, result.executionContractId, "ExecutionContract");
  if (contract.wholePlanId !== planId) {
    fail("Result Packet and ReviewDecision do not reference the same WholePlanSnapshot.", "LINEAGE_CONFLICT");
  }
  const review = verifiedFreshLodeReview(reviewContext, projectStorage.get(project));
  if (review.projectId !== project.projectId || review.wholePlan?.wholePlanId !== planId || review.resultPacket?.resultPacketId !== resultId) {
    fail("Fresh HEAD review context does not match this ReviewDecision.", "FRESH_HEAD_REVIEW_CONFLICT");
  }
  const normalizedDisposition = requiredText(disposition, "Review disposition").toLowerCase();
  const allowed = new Set(["accept", "revise", "expand", "rollback", "escalate"]);
  if (!allowed.has(normalizedDisposition)) fail("Review disposition is invalid.", "INVALID_REVIEW_DISPOSITION");
  const artifact = buildArtifact({
    project,
    kind: "ReviewDecision",
    body: {
      wholePlanId: planId,
      resultPacketId: resultId,
      reviewContextId: review.reviewContextId,
      disposition: normalizedDisposition,
      rationale: requiredText(rationale, "Review rationale"),
      nextActions: stringList(nextActions, "Review next actions"),
      knowledgeProposalRecommendations: knowledgeRecommendations(
        knowledgeProposalRecommendations,
        result.knowledgeProposals || [],
      ),
    },
    parents: [
      { relation: "reviews-against", targetId: planId },
      { relation: "reviews-result", targetId: resultId },
      { relation: "reviewed-through", targetId: review.reviewContextId },
    ],
  });
  return persistArtifact(project.projectRoot, artifact, persist, projectStorage.get(project));
}

// Preserve the exact historical public export; one implementation owns both names.
export { buildFreshLodeReview as buildFreshHeadReview };

export function createWholePlanSnapshot(options = {}, ...rest) {
  return options.persist === false ? createWholePlanSnapshotUncoordinated(options, ...rest) : withSnapshotReferences({ root: options.root ?? ".", storage: options.storage }, () => createWholePlanSnapshotUncoordinated(options, ...rest));
}

export function createNextWholePlanSnapshot(options = {}, ...rest) {
  return options.persist === false ? createNextWholePlanSnapshotUncoordinated(options, ...rest) : withSnapshotReferences({ root: options.root ?? ".", storage: options.storage }, () => createNextWholePlanSnapshotUncoordinated(options, ...rest));
}

export function createExecutionContract(options = {}, ...rest) {
  return options.persist === false ? createExecutionContractUncoordinated(options, ...rest) : withSnapshotReferences({ root: options.root ?? ".", storage: options.storage }, () => createExecutionContractUncoordinated(options, ...rest));
}

export function createResultPacket(options = {}, ...rest) {
  return options.persist === false ? createResultPacketUncoordinated(options, ...rest) : withSnapshotReferences({ root: options.root ?? ".", storage: options.storage }, () => createResultPacketUncoordinated(options, ...rest));
}

export function createReviewDecision(options = {}, ...rest) {
  return options.persist === false ? createReviewDecisionUncoordinated(options, ...rest) : withSnapshotReferences({ root: options.root ?? ".", storage: options.storage }, () => createReviewDecisionUncoordinated(options, ...rest));
}
