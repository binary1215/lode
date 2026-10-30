import { withSnapshotReferences, withSnapshotReferencesAsync } from "./snapshot-reference-lifetime.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { familyFormatForOriginal, formatForVerifiedOwner, relativeProjectArtifact } from "./project-storage-format.mjs";
import { inspectProject, SCHEMA_VERSION } from "./lode-core.mjs";
import { readContextCapsule } from "./context-compiler.mjs";
import { readLineageArtifact } from "./execution-lineage.mjs";
import {
  buildWorldModel,
  findWorldModelSnapshot,
  inspectWorldModel,
  readWorldModelSnapshot,
} from "./world-model.mjs";
import { refreshWorldModel } from "./incremental-refresh.mjs";
import { withProjectMutationAsync } from "./project-mutation-lock.mjs";
import {
  CHANGE_IMPACT_CANDIDATE_DIRECTORY,
  CHANGE_IMPACT_REVIEW_DIRECTORY,
  CHANGE_SET_DIRECTORY,
  CHANGE_SET_VERSION,
  CHANGE_SET_RECORD_VERSION,
  VCS_EVIDENCE_DIRECTORY,
  VCS_EVIDENCE_VERSION,
  changeSetCanonicalJson,
  changeSetDigest,
  loadChangeSetProjection,
  verifyGitCommitObservation,
  verifyChangeImpactCandidateSet,
  verifyChangeImpactReviewDecision,
  verifyChangeSet,
  verifyVcsEvidence,
} from "./change-set-projection.mjs";

const STATE_RELATIVE_PATH = ".head/change-sets/current.json";

const fail = (message, code = "CHANGE_SET_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function readyProject(root, action) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") fail(`Project must be ready for ${action}; current status: ${inspected.status}.`, "PROJECT_NOT_READY");
  return inspected;
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is required.`, "INVALID_CHANGE_SET_INPUT");
  return value.trim();
}

function normalizedIds(values, label) {
  if (values == null) return [];
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value)) fail(`${label} must be an array of identities.`, "INVALID_CHANGE_SET_INPUT");
  return [...new Set(values)].sort();
}

function safeFile(projectRoot, relative, id, prefix, storage) {
  if (!new RegExp(`^${prefix}-[a-f0-9]{24}$`).test(id || "")) fail(`Invalid ${prefix} identity.`, "INVALID_CHANGE_SET_ID");
  return path.join(projectRoot, ...relativeProjectArtifact(storage, ...relative.split("/").slice(1)).split("/"), `${id}.json`);
}

function stateFile(projectRoot, storage) {
  return path.join(projectRoot, ...relativeProjectArtifact(storage, ...STATE_RELATIVE_PATH.split("/").slice(1)).split("/"));
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

function persistImmutable(file, document, label) {
  if (fs.existsSync(file)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { fail(`${label} is invalid JSON: ${error.message}`, "INVALID_CHANGE_SET_ARTIFACT"); }
    if (changeSetCanonicalJson(existing) !== changeSetCanonicalJson(document)) fail(`${label} immutable identity collision.`, "CHANGE_SET_IMMUTABLE_COLLISION");
    return "existing";
  }
  atomicWrite(file, json(document));
  return "recorded";
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`${label} is invalid JSON: ${error.message}`, "INVALID_CHANGE_SET_ARTIFACT"); }
}

function stateArtifact(project, body, storage) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "ChangeSetStatePointer",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-change-set-state"), version: CHANGE_SET_VERSION },
    projectId: project.projectId,
    sessionId: body.sessionId,
    phase: body.phase,
    changeSetId: body.changeSetId,
    candidateSetId: body.candidateSetId,
    reviewDecisionId: body.reviewDecisionId || null,
    worldModelId: body.worldModelId,
    graphSnapshotId: body.graphSnapshotId,
    sourceSnapshotId: body.sourceSnapshotId,
    vcsEvidenceIds: normalizedIds(body.vcsEvidenceIds || [], "vcsEvidenceIds"),
  };
  const stateHash = changeSetDigest(changeSetCanonicalJson(payload));
  return { ...payload, stateId: `change-set-state-${stateHash.slice(0, 24)}`, stateHash };
}

export function verifyChangeSetStatePointer(document, project, storage) {
  if (!document || document.kind !== "ChangeSetStatePointer" || !familyFormatForOriginal("head-agent-core-change-set-state", document, storage) || document.protocol?.version !== CHANGE_SET_VERSION
    || document.projectId !== project.projectId || document.sessionId !== project.sessionId
    || !["awaiting-review", "awaiting-evidence", "reviewed", "rejected"].includes(document.phase)) {
    fail("ChangeSet state pointer is invalid.", "INVALID_CHANGE_SET_STATE");
  }
  if (document.vcsEvidenceIds != null) normalizedIds(document.vcsEvidenceIds, "vcsEvidenceIds");
  const payload = { ...document };
  delete payload.stateId;
  delete payload.stateHash;
  const hash = changeSetDigest(changeSetCanonicalJson(payload));
  if (document.stateHash !== hash || document.stateId !== `change-set-state-${hash.slice(0, 24)}`) fail("ChangeSet state pointer digest verification failed.", "CHANGE_SET_STATE_DIGEST_MISMATCH");
  return document;
}

function writeState(projectRoot, project, body, storage) {
  const state = stateArtifact({ ...project, sessionId: body.sessionId }, body, storage);
  atomicWrite(stateFile(projectRoot, storage), json(state));
  return state;
}

function revisionState(snapshot) {
  const graph = snapshot.temporalProvenanceGraph;
  const revisionKinds = new Map([["FileRevision", "File"], ["SymbolRevision", "Symbol"], ["TestRevision", "Test"]]);
  const revisions = new Map();
  for (const node of graph.nodes) if (revisionKinds.has(node.kind)) revisions.set(node.logicalEntityId, {
    revisionId: node.nodeId,
    entityKind: revisionKinds.get(node.kind),
    path: node.path || "",
    name: node.name || "",
  });
  return revisions;
}

function revisionChanges(before, after) {
  const beforeState = revisionState(before);
  const afterState = revisionState(after);
  const logicalIds = [...new Set([...beforeState.keys(), ...afterState.keys()])].sort();
  return logicalIds.flatMap((logicalEntityId) => {
    const previous = beforeState.get(logicalEntityId) || null;
    const current = afterState.get(logicalEntityId) || null;
    if (previous?.revisionId === current?.revisionId) return [];
    const payload = {
      changeKind: !previous ? "added" : !current ? "removed" : "modified",
      logicalEntityId,
      entityKind: current?.entityKind || previous?.entityKind || "",
      path: current?.path || previous?.path || "",
      name: current?.name || previous?.name || "",
      beforeRevisionId: previous?.revisionId || null,
      afterRevisionId: current?.revisionId || null,
    };
    const hash = changeSetDigest(changeSetCanonicalJson(payload));
    return [{ changeId: `change-record-${hash.slice(0, 24)}`, ...payload }];
  }).sort((left, right) => left.changeId.localeCompare(right.changeId));
}

function snapshotReference(snapshot, includeWorldModelId = false) {
  return {
    ...(includeWorldModelId ? { worldModelId: snapshot.worldModelId } : {}),
    graphSnapshotId: snapshot.temporalProvenanceGraph.graphSnapshotId,
    sourceSnapshotId: snapshot.temporalProvenanceGraph.sourceSnapshotId,
  };
}

function currentProductRevision(graph, logicalEntityId) {
  const edge = graph.edges.find((candidate) => candidate.type === "CURRENT_REVISION" && candidate.from === logicalEntityId);
  return edge?.to || "";
}

function impactCandidateSet(changeSet, afterSnapshot, storage) {
  const graph = afterSnapshot.temporalProvenanceGraph;
  const changeByLogical = new Map();
  for (const change of changeSet.changes) {
    if (!changeByLogical.has(change.logicalEntityId)) changeByLogical.set(change.logicalEntityId, []);
    changeByLogical.get(change.logicalEntityId).push(change);
  }
  const grouped = new Map();
  const currentMappedChanges = new Set();
  const historicalMappedChanges = new Set();
  for (const relationship of graph.nodes.filter((node) => node.kind === "ReviewedRelationship")) {
    let changedLogicalId = "";
    let targetNodeId = "";
    let targetKind = "";
    if (relationship.relationshipType === "IMPLEMENTS" && changeByLogical.has(relationship.fromNodeId)) {
      changedLogicalId = relationship.fromNodeId;
      targetNodeId = relationship.toNodeId;
      targetKind = relationship.toKind;
    } else if (relationship.relationshipType === "VERIFIED_BY" && changeByLogical.has(relationship.toNodeId)) {
      changedLogicalId = relationship.toNodeId;
      targetNodeId = relationship.fromNodeId;
      targetKind = relationship.fromKind;
    }
    if (!changedLogicalId || !["Feature", "Capability"].includes(targetKind)) continue;
    const relationshipCurrent = relationship.projectionStatus === "current";
    const relationshipSupportsReview = relationshipCurrent
      || (relationship.projectionStatus === "stale-evidence" && relationship.endpointStatus === "present" && relationship.evidenceStatus === "changed");
    for (const change of changeByLogical.get(changedLogicalId)) {
      (relationshipSupportsReview ? currentMappedChanges : historicalMappedChanges).add(change.changeId);
    }
    if (!relationshipSupportsReview) continue;
    const revisionId = currentProductRevision(graph, targetNodeId);
    if (!revisionId) continue;
    const key = `${targetKind}:${targetNodeId}:${revisionId}`;
    if (!grouped.has(key)) grouped.set(key, { target: { kind: targetKind, nodeId: targetNodeId, revisionId }, changeIds: new Set(), reviewedRelationshipIds: new Set(), semanticRecheckRequired: false });
    const group = grouped.get(key);
    for (const change of changeByLogical.get(changedLogicalId)) group.changeIds.add(change.changeId);
    group.reviewedRelationshipIds.add(relationship.nodeId);
    if (!relationshipCurrent) group.semanticRecheckRequired = true;
  }
  const candidates = [...grouped.values()].map((group) => {
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      kind: "ChangeImpactCandidate",
      protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-change-impact-candidates"), version: CHANGE_SET_VERSION },
      changeSetId: changeSet.changeSetId,
      relationshipType: "IMPACTS",
      target: group.target,
      changeIds: [...group.changeIds].sort(),
      reviewedRelationshipIds: [...group.reviewedRelationshipIds].sort(),
      confidence: group.semanticRecheckRequired ? 0.8 : 1,
      explanation: group.semanticRecheckRequired
        ? "A reviewed mapping connects this still-present logical endpoint to the product concept, but its source evidence changed; explicit impact review must reassess the connection."
        : "Reviewed Feature mapping relations connect changed code or tests to this product concept.",
      authorityClass: "candidate",
      instructionAuthority: false,
      promotionAuthority: false,
    };
    const hash = changeSetDigest(changeSetCanonicalJson(payload));
    return { ...payload, candidateId: `change-impact-candidate-${hash.slice(0, 24)}`, candidateHash: hash };
  }).sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  const unitsByPath = new Map();
  for (const change of changeSet.changes) {
    const unitKey = change.path || change.logicalEntityId;
    if (!unitsByPath.has(unitKey)) unitsByPath.set(unitKey, []);
    unitsByPath.get(unitKey).push(change);
  }
  const coverageUnits = [...unitsByPath.entries()].map(([unitKey, changes]) => {
    const fileLevelCurrent = changes.some((change) => change.entityKind === "File" && currentMappedChanges.has(change.changeId));
    const fileLevelHistorical = changes.some((change) => change.entityKind === "File" && historicalMappedChanges.has(change.changeId));
    const mappedChangeIds = changes.filter((change) => fileLevelCurrent || currentMappedChanges.has(change.changeId)).map((change) => change.changeId).sort();
    const historicalOnlyChangeIds = changes.filter((change) => !mappedChangeIds.includes(change.changeId)
      && (fileLevelHistorical || historicalMappedChanges.has(change.changeId))).map((change) => change.changeId).sort();
    const unmappedChangeIds = changes.filter((change) => !mappedChangeIds.includes(change.changeId)
      && !historicalOnlyChangeIds.includes(change.changeId)).map((change) => change.changeId).sort();
    const status = mappedChangeIds.length && (unmappedChangeIds.length || historicalOnlyChangeIds.length) ? "partial"
      : unmappedChangeIds.length ? "unmapped"
        : historicalOnlyChangeIds.length && !mappedChangeIds.length ? "historical-only" : "mapped";
    return { unitKey, path: changes[0].path || "", status,
      changeIds: changes.map((change) => change.changeId).sort(), mappedChangeIds, historicalOnlyChangeIds, unmappedChangeIds };
  }).sort((left, right) => left.unitKey.localeCompare(right.unitKey));
  const coverage = {
    unit: "repository-path",
    totalChangedUnits: coverageUnits.length,
    fullyMappedUnits: coverageUnits.filter((unit) => unit.status === "mapped").length,
    partiallyMappedUnits: coverageUnits.filter((unit) => unit.status === "partial").length,
    unmappedUnits: coverageUnits.filter((unit) => unit.status === "unmapped").length,
    historicalOnlyUnits: coverageUnits.filter((unit) => unit.status === "historical-only").length,
    totalChanges: changeSet.changes.length,
    mappedChanges: coverageUnits.reduce((count, unit) => count + unit.mappedChangeIds.length, 0),
    historicalOnlyChanges: coverageUnits.reduce((count, unit) => count + unit.historicalOnlyChangeIds.length, 0),
    unmappedChanges: coverageUnits.reduce((count, unit) => count + unit.unmappedChangeIds.length, 0),
    units: coverageUnits,
  };
  const unknowns = [];
  const addUnknown = (kind, statement, changeIds) => {
    const payload = { changeSetId: changeSet.changeSetId, kind, statement, changeIds: [...changeIds].sort(), status: "open" };
    const hash = changeSetDigest(changeSetCanonicalJson(payload));
    unknowns.push({ ...payload, unknownId: `change-impact-unknown-${hash.slice(0, 24)}` });
  };
  const unmappedChangeIds = coverageUnits.flatMap((unit) => unit.unmappedChangeIds).sort();
  const historicalOnlyChangeIds = coverageUnits.flatMap((unit) => unit.historicalOnlyChangeIds).sort();
  if (unmappedChangeIds.length) addUnknown("unmapped-change-coverage",
    `${unmappedChangeIds.length} changed revision(s) have no current reviewed Feature or Capability mapping; this is unresolved impact evidence, not proof of no impact.`, unmappedChangeIds);
  if (historicalOnlyChangeIds.length) addUnknown("historical-mapping-only",
    `${historicalOnlyChangeIds.length} changed revision(s) connect only to historical or stale mapping evidence and require fresh HEAD assessment.`, historicalOnlyChangeIds);
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "ChangeImpactCandidateSet",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-change-impact-candidates"), version: CHANGE_SET_VERSION },
    projectId: changeSet.projectId,
    sessionId: changeSet.sessionId,
    changeSetId: changeSet.changeSetId,
    afterSourceSnapshotId: changeSet.after.sourceSnapshotId,
    afterGraphSnapshotId: changeSet.after.graphSnapshotId,
    candidates,
    unknowns,
    coverage,
    authorityClass: "candidate-set",
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const hash = changeSetDigest(changeSetCanonicalJson(payload));
  return verifyChangeImpactCandidateSet({ ...payload, candidateSetId: `change-impact-candidates-${hash.slice(0, 24)}`, candidateSetHash: hash }, changeSet, changeSet.projectId, storage);
}

function lineageForChangeSet(projectRoot, resultPacketId, reviewDecisionId) {
  const result = readLineageArtifact({ root: projectRoot, artifactId: requiredText(resultPacketId, "ResultPacket id") }).artifact;
  const review = readLineageArtifact({ root: projectRoot, artifactId: requiredText(reviewDecisionId, "ReviewDecision id") }).artifact;
  if (result.kind !== "ResultPacket" || review.kind !== "ReviewDecision" || review.resultPacketId !== result.resultPacketId) {
    fail("ChangeSet ResultPacket and ReviewDecision lineage do not match.", "CHANGE_SET_LINEAGE_CONFLICT");
  }
  if (review.disposition !== "accept") fail("Only an accepted execution ReviewDecision may authorize a ChangeSet.", "CHANGE_SET_REVIEW_NOT_ACCEPTED");
  const contract = readLineageArtifact({ root: projectRoot, artifactId: result.executionContractId }).artifact;
  const capsule = readContextCapsule({ root: projectRoot, capsuleId: contract.capsuleId }).capsule;
  if (!capsule.repositoryTemporalGraph?.graphSnapshotId) fail("The ExecutionContract ContextCapsule did not pin a temporal GraphSnapshot.", "CHANGE_SET_BASE_SNAPSHOT_MISSING");
  return { result, review, contract, capsule };
}

async function rebuildProjection({ projectRoot, projectId, sourceWorld, additionalChangeSets = [], additionalCandidateSets = [], additionalReviewDecisions = [], additionalVcsEvidence = [] }, storage) {
  const projection = loadChangeSetProjection({ storage, projectRoot, projectId, additionalChangeSets, additionalCandidateSets, additionalReviewDecisions, additionalVcsEvidence });
  const built = await buildWorldModel({
    root: projectRoot,
    persist: true,
    changeSetProjectionInput: projection,
    parentSourceSnapshotIds: sourceWorld.temporalProvenanceGraph.parentSourceSnapshotIds,
    revisionParentIds: sourceWorld.temporalProvenanceGraph.revisionParentIds,
  });
  return { ...built, changeSetProjectionInput: projection };
}

export function readChangeSet({ root = ".", changeSetId } = {}) {
  const inspected = readyProject(root, "ChangeSet inspection");
  const storage = inspected.storage;
  const file = safeFile(inspected.project.projectRoot, CHANGE_SET_DIRECTORY, changeSetId, "change-set", storage);
  if (!fs.existsSync(file)) fail(`ChangeSet not found: ${changeSetId}`, "CHANGE_SET_NOT_FOUND");
  return { status: "verified", file, changeSet: verifyChangeSet(readJson(file, "ChangeSet"), inspected.project.projectId, storage) };
}

export function readChangeImpactCandidateSet({ root = ".", candidateSetId } = {}) {
  const inspected = readyProject(root, "Change impact candidate inspection");
  const storage = inspected.storage;
  const file = safeFile(inspected.project.projectRoot, CHANGE_IMPACT_CANDIDATE_DIRECTORY, candidateSetId, "change-impact-candidates", storage);
  if (!fs.existsSync(file)) fail(`Change impact candidate set not found: ${candidateSetId}`, "CHANGE_IMPACT_CANDIDATE_SET_NOT_FOUND");
  const candidateSet = readJson(file, "Change impact candidate set");
  const changeSet = readChangeSet({ root: inspected.project.projectRoot, changeSetId: candidateSet.changeSetId }).changeSet;
  return { status: "verified", file, candidateSet: verifyChangeImpactCandidateSet(candidateSet, changeSet, inspected.project.projectId, storage) };
}

export function readChangeImpactReviewDecision({ root = ".", reviewDecisionId } = {}) {
  const inspected = readyProject(root, "Change impact review inspection");
  const storage = inspected.storage;
  const file = safeFile(inspected.project.projectRoot, CHANGE_IMPACT_REVIEW_DIRECTORY, reviewDecisionId, "change-impact-review-decision", storage);
  if (!fs.existsSync(file)) fail(`Change impact ReviewDecision not found: ${reviewDecisionId}`, "CHANGE_IMPACT_REVIEW_NOT_FOUND");
  const review = readJson(file, "Change impact ReviewDecision");
  const candidateSet = readChangeImpactCandidateSet({ root: inspected.project.projectRoot, candidateSetId: review.candidateSetId }).candidateSet;
  const reviewDecision = verifyChangeImpactReviewDecision(review, candidateSet, inspected.project.projectId, storage);
  if (reviewDecision.reviewDecisionId !== reviewDecisionId) fail("Change impact ReviewDecision filename does not match its exact identity.", "CHANGE_IMPACT_REVIEW_IDENTITY_MISMATCH");
  return { status: "verified", file, reviewDecision };
}

export function readVcsEvidence({ root = ".", vcsEvidenceId } = {}) {
  const inspected = readyProject(root, "VCS evidence inspection");
  const storage = inspected.storage;
  const file = safeFile(inspected.project.projectRoot, VCS_EVIDENCE_DIRECTORY, vcsEvidenceId, "vcs-evidence", storage);
  if (!fs.existsSync(file)) fail(`VCS evidence not found: ${vcsEvidenceId}`, "VCS_EVIDENCE_NOT_FOUND");
  const vcsEvidence = readJson(file, "VCS evidence");
  const changeSet = readChangeSet({ root: inspected.project.projectRoot, changeSetId: vcsEvidence.changeSetId }).changeSet;
  return { status: "verified", file, vcsEvidence: verifyVcsEvidence(vcsEvidence, changeSet, inspected.project.projectId, storage) };
}

function gitCommitObservation(commit, storage) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "GitCommitObservation",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-git-commit-observation"), version: VCS_EVIDENCE_VERSION },
    vcsKind: "git",
    objectId: commit.commit,
    parents: [...commit.parents].sort(),
    authoredAt: commit.authoredAt,
    committedAt: commit.committedAt,
    author: { name: commit.author.name },
    authorEmailDigest: commit.authorEmailDigest,
    refs: [...commit.refs].sort(),
    subject: commit.subject,
    body: commit.body,
    evidence: { ...commit.evidence },
    authority: "derived-vcs-observation",
    trustBoundary: "evidence-not-instruction",
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const hash = changeSetDigest(changeSetCanonicalJson(payload));
  return verifyGitCommitObservation({ ...payload, gitCommitObservationId: `git-commit-observation-${hash.slice(0, 24)}`, gitCommitObservationHash: hash }, storage);
}

function buildVcsEvidence(changeSet, history, commitIds, rationale, storage) {
  const ids = [...new Set(normalizedIds(commitIds, "commitIds").map((item) => item.toLocaleLowerCase()))].sort();
  if (!ids.length || ids.some((item) => !/^[a-f0-9]{40,64}$/.test(item))) fail("commitIds must contain one or more Git object ids.", "INVALID_VCS_EVIDENCE_INPUT");
  const commits = new Map(history.commits.map((commit) => [commit.commit, commit]));
  const missing = ids.filter((id) => !commits.has(id));
  if (missing.length) fail(`Selected Git commits are absent from the verified history: ${missing.join(", ")}`, "VCS_EVIDENCE_COMMIT_NOT_FOUND");
  const commitObservations = ids.map((id) => gitCommitObservation(commits.get(id), storage))
    .sort((left, right) => left.gitCommitObservationId.localeCompare(right.gitCommitObservationId));
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "VcsEvidence",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-vcs-evidence"), version: VCS_EVIDENCE_VERSION },
    projectId: changeSet.projectId,
    sessionId: changeSet.sessionId,
    changeSetId: changeSet.changeSetId,
    changeSetHash: changeSet.changeSetHash,
    vcsKind: "git",
    attachmentMethod: "explicit-commit-selection",
    rationale: requiredText(rationale, "VCS evidence rationale"),
    gitHistory: {
      historyId: history.historyId,
      historyHash: history.historyHash,
      coverage: history.coverage,
    },
    commitObservations,
    authority: "optional-derived-vcs-evidence",
    trustBoundary: "evidence-not-instruction",
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const hash = changeSetDigest(changeSetCanonicalJson(payload));
  return verifyVcsEvidence({ ...payload, vcsEvidenceId: `vcs-evidence-${hash.slice(0, 24)}`, vcsEvidenceHash: hash }, changeSet, changeSet.projectId, storage);
}

async function attachVcsEvidenceUncoordinated({ root = ".", changeSetId, commitIds = [], rationale } = {}) {
  const inspected = readyProject(root, "VCS evidence attachment");
  const storage = inspected.storage;
  if (inspected.state.activeRunId || inspected.state.pendingReview) {
    fail("VCS evidence attachment cannot replace the current graph while a Run is active or awaiting review.", "VCS_EVIDENCE_RUN_CONFLICT");
  }
  const projectRoot = inspected.project.projectRoot;
  const changeSet = readChangeSet({ root: projectRoot, changeSetId: requiredText(changeSetId, "ChangeSet id") }).changeSet;
  const originalIdentity = { changeSetId: changeSet.changeSetId, changeSetHash: changeSet.changeSetHash };
  const current = (await inspectWorldModel({ root: projectRoot }));
  if (current.status !== "current") fail("Current repository evidence is stale; index it before attaching VCS evidence.", "VCS_EVIDENCE_SOURCE_DRIFT");
  const history = current.snapshot.gitDecisionHistory;
  if (!history || history.status !== "available" || history.coverage !== "all-reachable-commits") {
    fail(`Verified Git history is unavailable (${history?.reasonCode || history?.status || "missing"}).`, "VCS_EVIDENCE_UNAVAILABLE");
  }
  const vcsEvidence = buildVcsEvidence(changeSet, history, commitIds, rationale, storage);
  const projected = await rebuildProjection({
    projectRoot,
    projectId: inspected.project.projectId,
    sourceWorld: current.snapshot,
    additionalVcsEvidence: [vcsEvidence],
  }, storage);
  persistImmutable(safeFile(projectRoot, VCS_EVIDENCE_DIRECTORY, vcsEvidence.vcsEvidenceId, "vcs-evidence", storage), vcsEvidence, "VCS evidence");
  let state = null;
  if (fs.existsSync(stateFile(projectRoot, storage))) {
    const previous = verifyChangeSetStatePointer(readJson(stateFile(projectRoot, storage), "ChangeSet state pointer"), { ...inspected.project, sessionId: inspected.state.sessionId }, storage);
    const vcsEvidenceIds = projected.changeSetProjectionInput.vcsEvidence
      .filter((item) => item.changeSetId === previous.changeSetId).map((item) => item.vcsEvidenceId).sort();
    state = writeState(projectRoot, inspected.project, {
      sessionId: previous.sessionId,
      phase: previous.phase,
      changeSetId: previous.changeSetId,
      candidateSetId: previous.candidateSetId,
      reviewDecisionId: previous.reviewDecisionId,
      worldModelId: projected.snapshot.worldModelId,
      graphSnapshotId: projected.snapshot.temporalProvenanceGraph.graphSnapshotId,
      sourceSnapshotId: projected.snapshot.temporalProvenanceGraph.sourceSnapshotId,
      vcsEvidenceIds,
    }, storage);
  }
  const unchanged = changeSet.changeSetId === originalIdentity.changeSetId && changeSet.changeSetHash === originalIdentity.changeSetHash;
  if (!unchanged) fail("VCS evidence attachment changed the provider-neutral ChangeSet identity.", "CHANGE_SET_IDENTITY_DRIFT");
  return {
    status: "vcs_evidence_attached",
    vcsEvidence,
    state,
    changeSetIdentity: { ...originalIdentity, unchanged: true },
    worldModel: { worldModelId: projected.snapshot.worldModelId, ...snapshotReference(projected.snapshot) },
    authority: "optional-evidence-not-change-lineage-or-project-canon",
  };
}

async function recordChangeSetUncoordinated({ root = ".", resultPacketId, reviewDecisionId, beforeWorldModelId = "", parentChangeSetIds = [] } = {}) {
  const inspected = readyProject(root, "ChangeSet recording");
  const storage = inspected.storage;
  if (inspected.state.activeRunId || inspected.state.pendingReview) fail("ChangeSet recording requires the execution Run and Fresh HEAD review to be complete.", "CHANGE_SET_RUN_CONFLICT");
  const projectRoot = inspected.project.projectRoot;
  const existingStateFile = stateFile(projectRoot, storage);
  if (fs.existsSync(existingStateFile)) {
    const currentState = verifyChangeSetStatePointer(readJson(existingStateFile, "ChangeSet state pointer"), { ...inspected.project, sessionId: inspected.state.sessionId }, storage);
    if (currentState.phase === "awaiting-review") fail("The current Change impact candidate set requires review before another ChangeSet is recorded.", "CHANGE_IMPACT_REVIEW_REQUIRED");
  }
  const lineage = lineageForChangeSet(projectRoot, resultPacketId, reviewDecisionId);
  let before;
  if (beforeWorldModelId) before = (await readWorldModelSnapshot({ root: projectRoot, worldModelId: beforeWorldModelId })).snapshot;
  else {
    const matches = (await findWorldModelSnapshot({ root: projectRoot, graphSnapshotId: lineage.capsule.repositoryTemporalGraph.graphSnapshotId })).matches;
    const expectedHash = lineage.capsule.snapshot?.sourceDigests?.repositoryWorldModel || "";
    before = matches.find((snapshot) => !expectedHash || snapshot.worldModelHash === expectedHash) || null;
    if (!before) fail("The ContextCapsule World Model snapshot cannot be recovered.", "CHANGE_SET_BASE_SNAPSHOT_MISSING");
  }
  const current = (await inspectWorldModel({ root: projectRoot }));
  if (current.status !== "current") fail("Current repository evidence is stale; index it before recording a ChangeSet.", "CHANGE_SET_SOURCE_DRIFT");
  const after = current.snapshot;
  const changes = revisionChanges(before, after);
  if (!changes.length) fail("No File, Symbol, or Test revision changed between the pinned execution context and current state.", "EMPTY_CHANGE_SET");
  const parents = normalizedIds(parentChangeSetIds, "parentChangeSetIds");
  for (const parentId of parents) readChangeSet({ root: projectRoot, changeSetId: parentId });
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "ChangeSet",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-change-set"), version: CHANGE_SET_RECORD_VERSION },
    projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId,
    parentChangeSetIds: parents,
    before: snapshotReference(before, true),
    after: snapshotReference(after, true),
    wholePlanId: lineage.review.wholePlanId,
    executionContractId: lineage.result.executionContractId,
    resultPacketId: lineage.result.resultPacketId,
    reviewDecisionId: lineage.review.reviewDecisionId,
    reviewDisposition: lineage.review.disposition,
    changes,
    authority: "reviewed-execution-change-lineage",
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const hash = changeSetDigest(changeSetCanonicalJson(payload));
  const changeSet = verifyChangeSet({ ...payload, changeSetId: `change-set-${hash.slice(0, 24)}`, changeSetHash: hash }, inspected.project.projectId, storage);
  const candidateSet = impactCandidateSet(changeSet, after, storage);
  const projected = await rebuildProjection({ projectRoot, projectId: inspected.project.projectId, sourceWorld: after, additionalChangeSets: [changeSet], additionalCandidateSets: [candidateSet] }, storage);
  persistImmutable(safeFile(projectRoot, CHANGE_SET_DIRECTORY, changeSet.changeSetId, "change-set", storage), changeSet, "ChangeSet");
  persistImmutable(safeFile(projectRoot, CHANGE_IMPACT_CANDIDATE_DIRECTORY, candidateSet.candidateSetId, "change-impact-candidates", storage), candidateSet, "Change impact candidate set");
  const phase = candidateSet.candidates.length ? "awaiting-review" : "awaiting-evidence";
  const state = writeState(projectRoot, inspected.project, {
    sessionId: inspected.state.sessionId,
    phase,
    changeSetId: changeSet.changeSetId,
    candidateSetId: candidateSet.candidateSetId,
    reviewDecisionId: null,
    worldModelId: projected.snapshot.worldModelId,
    graphSnapshotId: projected.snapshot.temporalProvenanceGraph.graphSnapshotId,
    sourceSnapshotId: projected.snapshot.temporalProvenanceGraph.sourceSnapshotId,
    vcsEvidenceIds: [],
  }, storage);
  return { status: phase === "awaiting-review" ? "awaiting_change_impact_review" : "awaiting_change_impact_evidence", state, changeSet, candidateSet, worldModel: { worldModelId: projected.snapshot.worldModelId, ...snapshotReference(projected.snapshot) }, authority: "impact-candidates-have-no-promotion-authority" };
}

function buildImpactReview(candidateSet, disposition, acceptedCandidateIds, rationale, storage) {
  const allIds = candidateSet.candidates.map((item) => item.candidateId);
  const selected = disposition === "accept-all" ? allIds : disposition === "reject" ? [] : normalizedIds(acceptedCandidateIds, "acceptedCandidateIds");
  const known = new Set(allIds);
  if (selected.some((id) => !known.has(id))) fail("Change impact review references an unknown candidate.", "UNKNOWN_CHANGE_IMPACT_CANDIDATE");
  if (disposition === "accept-selection" && !selected.length) fail("accept-selection requires at least one candidate.", "CHANGE_IMPACT_SELECTION_REQUIRED");
  const accepted = new Set(selected);
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "ReviewDecision",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-change-impact-review"), version: CHANGE_SET_VERSION },
    decisionScope: "change-impact",
    projectId: candidateSet.projectId,
    sessionId: candidateSet.sessionId,
    changeSetId: candidateSet.changeSetId,
    candidateSetId: candidateSet.candidateSetId,
    disposition,
    acceptedCandidateIds: selected,
    rejectedCandidateIds: allIds.filter((id) => !accepted.has(id)),
    rationale: requiredText(rationale, "Review rationale"),
    authority: "explicit-user-change-impact-review",
    instructionAuthority: true,
    promotionAuthority: disposition.startsWith("accept"),
  };
  const hash = changeSetDigest(changeSetCanonicalJson(payload));
  return verifyChangeImpactReviewDecision({ ...payload, reviewDecisionId: `change-impact-review-decision-${hash.slice(0, 24)}`, reviewDecisionHash: hash }, candidateSet, candidateSet.projectId, storage);
}

function recordedImpactReview({ projectRoot, projectId, candidateSet }, storage) {
  // Only the immutable P1 artifact directory may establish a saved review.
  // A rebuildable Graph node is useful for equality checks, never authority.
  const projection = loadChangeSetProjection({ storage, projectRoot, projectId });
  const directory = path.join(projectRoot, ...relativeProjectArtifact(storage, ...CHANGE_IMPACT_REVIEW_DIRECTORY.split("/").slice(1)).split("/"));
  const files = fs.existsSync(directory)
    ? fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name)
    : [];
  const expectedFiles = new Set(projection.reviewDecisions.map((review) => `${review.reviewDecisionId}.json`));
  if (files.length !== expectedFiles.size || files.some((file) => !expectedFiles.has(file))) {
    fail("Change impact ReviewDecision filenames do not match their exact identities.", "CHANGE_IMPACT_REVIEW_IDENTITY_MISMATCH");
  }
  const matches = projection.reviewDecisions.filter((review) => review.candidateSetId === candidateSet.candidateSetId);
  if (matches.length > 1) {
    fail("The exact Change impact candidate set has conflicting durable decisions; preserve the records and reconcile their authority before proceeding.", "CHANGE_IMPACT_REVIEW_CONFLICT");
  }
  if (!matches.length) return null;
  const review = readChangeImpactReviewDecision({ root: projectRoot, reviewDecisionId: matches[0].reviewDecisionId }).reviewDecision;
  if (review.sessionId !== candidateSet.sessionId || review.changeSetId !== candidateSet.changeSetId) {
    fail("Change impact ReviewDecision belongs to different ChangeSet lineage.", "CHANGE_IMPACT_REVIEW_IDENTITY_MISMATCH");
  }
  return review;
}

function impactReviewProjectionState(snapshot, review) {
  const reviewDecisionIds = snapshot.changeSetProjection?.reviewDecisionIds || [];
  const projectedReview = snapshot.temporalProvenanceGraph?.nodes?.find((node) => node.nodeId === review.reviewDecisionId) || null;
  const idPresent = reviewDecisionIds.includes(review.reviewDecisionId);
  const exact = idPresent && projectedReview?.kind === "ChangeImpactReviewDecision"
    && projectedReview.reviewDecisionHash === review.reviewDecisionHash;
  return { exact, absent: !idPresent && projectedReview == null };
}

function currentCandidateEvidence(candidateSet, state, world) {
  return world.status === "current"
    && world.snapshot.worldModelId === state.worldModelId
    && world.snapshot.temporalProvenanceGraph.graphSnapshotId === state.graphSnapshotId
    && world.snapshot.temporalProvenanceGraph.sourceSnapshotId === candidateSet.afterSourceSnapshotId;
}

function exactRequestCanRepairOrphanProjection({ projectRoot, projectId, candidateSet, world, review }, storage) {
  const expectedProjection = loadChangeSetProjection({ storage, projectRoot, projectId, additionalReviewDecisions: [review] });
  if (world.status !== "stale"
    || world.snapshot.temporalProvenanceGraph.sourceSnapshotId !== candidateSet.afterSourceSnapshotId
    || world.snapshot.changeSetProjection?.projectionInputHash !== expectedProjection.projectionInputHash
    || !impactReviewProjectionState(world.snapshot, review).exact
    || world.changes?.changeSetProjectionChanged !== true
    || world.changes?.temporalProvenanceChanged !== true) return false;
  const allowedDerivedDrift = new Set(["changeSetProjectionChanged", "temporalProvenanceChanged"]);
  return Object.entries(world.changes || {}).every(([key, value]) => allowedDerivedDrift.has(key)
    || (Array.isArray(value) ? value.length === 0 : value !== true));
}

function completeImpactReview({ projectRoot, inspected, state, review, snapshot, worldStatus = "current", reusedReviewDecision = false, updatePointer = true }, storage) {
  const nextPhase = review.disposition === "reject" ? "rejected" : "reviewed";
  const projection = loadChangeSetProjection({ storage, projectRoot, projectId: inspected.project.projectId });
  const nextState = updatePointer ? writeState(projectRoot, inspected.project, {
    sessionId: inspected.state.sessionId,
    phase: nextPhase,
    changeSetId: state.changeSetId,
    candidateSetId: state.candidateSetId,
    reviewDecisionId: review.reviewDecisionId,
    worldModelId: snapshot.worldModelId,
    graphSnapshotId: snapshot.temporalProvenanceGraph.graphSnapshotId,
    sourceSnapshotId: snapshot.temporalProvenanceGraph.sourceSnapshotId,
    vcsEvidenceIds: projection.vcsEvidence.filter((item) => item.changeSetId === state.changeSetId).map((item) => item.vcsEvidenceId).sort(),
  }, storage) : state;
  return {
    status: nextPhase === "reviewed" ? "change_impacts_reviewed" : "change_impacts_rejected",
    state: nextState,
    reviewDecision: review,
    reusedReviewDecision,
    reviewedImpactCount: review.acceptedCandidateIds.length,
    worldModel: { status: worldStatus, worldModelId: snapshot.worldModelId, ...snapshotReference(snapshot) },
  };
}

export async function reviewChangeImpact(options = {}) {
  return (await withProjectMutationAsync({ root: options.root ?? ".", scope: "session-recovery" }, async () => (await reviewChangeImpactLocked(options))));
}

async function reviewChangeImpactLocked({ root = ".", candidateSetId, disposition, acceptedCandidateIds = [], rationale } = {}) {
  const inspected = readyProject(root, "Change impact review");
  const storage = inspected.storage;
  if (inspected.state.activeRunId || inspected.state.pendingReview) fail("Change impact review cannot advance while a Run is active or awaiting review.", "CHANGE_SET_RUN_CONFLICT");
  const projectRoot = inspected.project.projectRoot;
  if (!fs.existsSync(stateFile(projectRoot, storage))) fail("No ChangeSet is awaiting impact review.", "CHANGE_SET_NOT_STARTED");
  const state = verifyChangeSetStatePointer(readJson(stateFile(projectRoot, storage), "ChangeSet state pointer"), { ...inspected.project, sessionId: inspected.state.sessionId }, storage);
  if (!["awaiting-review", "reviewed", "rejected"].includes(state.phase) || state.candidateSetId !== candidateSetId) fail("Change impact review references a stale or non-reviewable candidate set.", "STALE_CHANGE_IMPACT_CANDIDATE_SET");
  const candidateSet = readChangeImpactCandidateSet({ root: projectRoot, candidateSetId }).candidateSet;
  if (candidateSet.sessionId !== state.sessionId || candidateSet.changeSetId !== state.changeSetId) fail("Change impact candidate set belongs to different ChangeSet lineage.", "CHANGE_IMPACT_CANDIDATE_SET_IDENTITY_MISMATCH");
  const normalizedDisposition = requiredText(disposition, "Review disposition").toLocaleLowerCase();
  if (!["accept-all", "accept-selection", "reject"].includes(normalizedDisposition)) fail("Change impact disposition must be accept-all, accept-selection, or reject.", "INVALID_CHANGE_IMPACT_REVIEW_DISPOSITION");
  const review = buildImpactReview(candidateSet, normalizedDisposition, acceptedCandidateIds, rationale, storage);
  const recordedReview = recordedImpactReview({ projectRoot, projectId: inspected.project.projectId, candidateSet }, storage);
  const pointerPending = state.phase === "awaiting-review";
  if (!pointerPending && (!recordedReview || state.reviewDecisionId !== recordedReview.reviewDecisionId
    || state.phase !== (recordedReview.disposition === "reject" ? "rejected" : "reviewed"))) {
    fail("Completed Change impact state does not match its exact durable decision.", "CHANGE_IMPACT_REVIEW_CONFLICT");
  }
  if (recordedReview && changeSetCanonicalJson(recordedReview) !== changeSetCanonicalJson(review)) {
    if (!pointerPending) fail("Change impact review references an already reviewed candidate set.", "STALE_CHANGE_IMPACT_CANDIDATE_SET");
    fail(`A different Change impact ReviewDecision is already durable for this exact candidate set. Retry the unchanged saved decision ${recordedReview.reviewDecisionId} to finish its pending state update.`, "CHANGE_IMPACT_REVIEW_CONFLICT");
  }
  let current = (await inspectWorldModel({ root: projectRoot }));
  if (recordedReview) {
    const projectionState = impactReviewProjectionState(current.snapshot, recordedReview);
    if (!projectionState.exact && !projectionState.absent) fail("The World projection does not match the exact saved Change impact decision.", "CHANGE_IMPACT_REVIEW_PROJECTION_MISMATCH");
    if (projectionState.absent) {
      await rebuildProjection({ projectRoot, projectId: inspected.project.projectId, sourceWorld: current.snapshot }, storage);
      current = (await inspectWorldModel({ root: projectRoot }));
      if (!impactReviewProjectionState(current.snapshot, recordedReview).exact) fail("The saved Change impact decision could not be verified in the rebuilt World projection.", "CHANGE_IMPACT_REVIEW_PROJECTION_MISMATCH");
    }
    return completeImpactReview({ projectRoot, inspected, state, review: recordedReview, snapshot: current.snapshot,
      worldStatus: current.status, reusedReviewDecision: true, updatePointer: pointerPending }, storage);
  }
  const evidenceCurrent = currentCandidateEvidence(candidateSet, state, current);
  const repairableOrphanProjection = normalizedDisposition !== "reject" && !evidenceCurrent && exactRequestCanRepairOrphanProjection({
    projectRoot, projectId: inspected.project.projectId, candidateSet, world: current, review,
  }, storage);
  if (normalizedDisposition !== "reject" && !evidenceCurrent && !repairableOrphanProjection) {
    fail(`Repository evidence changed after impact inference. Explicitly reject the outdated candidate set ${candidateSetId}, then record a fresh ChangeSet from current evidence; stale candidates cannot be accepted.`, "CHANGE_IMPACT_SOURCE_DRIFT");
  }
  if (normalizedDisposition === "reject" && current.status !== "current") {
    await refreshWorldModel({ root: projectRoot });
    current = (await inspectWorldModel({ root: projectRoot }));
    if (current.status !== "current") fail("World evidence changed during rejection refresh; retry the same explicit rejection after concurrent changes settle.", "CHANGE_IMPACT_SOURCE_DRIFT");
  }
  // P1 authority is durable before its rebuildable P4 projection. Exact retry
  // repairs projection/pointer boundaries without asking the user again.
  persistImmutable(safeFile(projectRoot, CHANGE_IMPACT_REVIEW_DIRECTORY, review.reviewDecisionId, "change-impact-review-decision", storage), review, "Change impact ReviewDecision");
  const projected = await rebuildProjection({ projectRoot, projectId: inspected.project.projectId, sourceWorld: current.snapshot }, storage);
  return completeImpactReview({ projectRoot, inspected, state, review, snapshot: projected.snapshot }, storage);
}

export async function inspectChangeSets({ root = "." } = {}) {
  const inspected = readyProject(root, "ChangeSet inspection");
  const storage = inspected.storage;
  const file = stateFile(inspected.project.projectRoot, storage);
  if (!fs.existsSync(file)) return { status: "not_started", projectId: inspected.project.projectId, sessionId: inspected.state.sessionId, nextAction: "Record a ChangeSet after an accepted execution review and repository re-index." };
  const state = verifyChangeSetStatePointer(readJson(file, "ChangeSet state pointer"), { ...inspected.project, sessionId: inspected.state.sessionId }, storage);
  const changeSet = readChangeSet({ root: inspected.project.projectRoot, changeSetId: state.changeSetId }).changeSet;
  const candidateSet = readChangeImpactCandidateSet({ root: inspected.project.projectRoot, candidateSetId: state.candidateSetId }).candidateSet;
  const savedReview = recordedImpactReview({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, candidateSet }, storage);
  const reviewDecision = state.reviewDecisionId ? readChangeImpactReviewDecision({ root: inspected.project.projectRoot, reviewDecisionId: state.reviewDecisionId }).reviewDecision : savedReview;
  const projection = loadChangeSetProjection({ storage, projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId });
  const vcsEvidence = projection.vcsEvidence.filter((item) => item.changeSetId === changeSet.changeSetId);
  const world = (await inspectWorldModel({ root: inspected.project.projectRoot }));
  const awaitingReview = state.phase === "awaiting-review";
  const evidenceCurrent = currentCandidateEvidence(candidateSet, state, world);
  const runConflict = Boolean(inspected.state.activeRunId || inspected.state.pendingReview);
  return {
    status: state.phase.replaceAll("-", "_"), state, changeSet, candidateSet, reviewDecision, vcsEvidence,
    reviewRecovery: awaitingReview && savedReview ? { status: "pointer-update-pending", reviewDecisionId: savedReview.reviewDecisionId, requiresNewUserDecision: false } : null,
    reviewReadiness: awaitingReview ? {
      candidateSetId: candidateSet.candidateSetId,
      evidenceStatus: evidenceCurrent ? "current" : "stale",
      acceptanceAvailable: evidenceCurrent && !runConflict && !savedReview,
      explicitRejectionAvailable: !runConflict && !savedReview,
      runConflict,
      nextAction: runConflict
        ? "Finish the existing Run or its pending review before changing the impact review state."
        : savedReview
        ? "Retry the unchanged saved ReviewDecision to finish its pending state update; no new user decision is needed."
        : evidenceCurrent
        ? "Ask the user to review this exact candidate set; only explicit acceptance promotes impacts."
        : "Ask whether the user wants to reject this exact outdated candidate set, then record a fresh ChangeSet from current evidence.",
    } : null,
    worldModel: { status: world.status, worldModelId: world.snapshot.worldModelId, graphSnapshotId: world.snapshot.temporalProvenanceGraph.graphSnapshotId, sourceSnapshotId: world.snapshot.temporalProvenanceGraph.sourceSnapshotId, matchesState: world.snapshot.worldModelId === state.worldModelId },
    authority: { changeSet: "reviewed-execution-change-lineage", impactCandidates: "non-authoritative-until-explicit-review", reviewedImpacts: "explicit-user-reviewed-impact-facts", vcsEvidence: "optional-derived-evidence-not-instruction", graph: "rebuildable-derived-projection", git: "optional-vcs-evidence-not-required" },
  };
}

export async function recordChangeSet(options = {}, ...rest) {
  return withSnapshotReferencesAsync({ root: options.root ?? ".", storage: options.storage }, () => recordChangeSetUncoordinated(options, ...rest));
}

export async function attachVcsEvidence(options = {}, ...rest) {
  return withSnapshotReferencesAsync({ root: options.root ?? ".", storage: options.storage }, () => attachVcsEvidenceUncoordinated(options, ...rest));
}
