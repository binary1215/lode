import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { familyFormatForOriginal, formatForVerifiedOwner, relativeProjectArtifact } from "./project-storage-format.mjs";

// Auxiliary state, impact candidates and impact reviews retain their own contract.
export const CHANGE_SET_VERSION = "0.2.0";
export const CHANGE_SET_RECORD_VERSION = "0.3.0";
export const CHANGE_SET_PROJECTION_VERSION = "0.3.0";
export const VCS_EVIDENCE_VERSION = "0.1.0";
export const CHANGE_SET_DIRECTORY = ".head/change-sets/records";
export const CHANGE_IMPACT_CANDIDATE_DIRECTORY = ".head/change-sets/impact-candidate-sets";
export const CHANGE_IMPACT_REVIEW_DIRECTORY = ".head/change-sets/impact-review-decisions";
export const VCS_EVIDENCE_DIRECTORY = ".head/change-sets/vcs-evidence";

const LIMITS = Object.freeze({
  maxChangeSets: 256,
  maxCandidateSets: 256,
  maxReviewDecisions: 256,
  maxVcsEvidence: 512,
  maxChangesPerSet: 2000,
  maxCandidatesPerSet: 1000,
  maxUnknownsPerSet: 100,
  maxCommitObservationsPerEvidence: 256,
  maxArtifactBytes: 8 * 1024 * 1024,
  maxTotalBytes: 48 * 1024 * 1024,
});

const fail = (message, code = "CHANGE_SET_PROJECTION_ERROR") => {
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

export function changeSetCanonicalJson(value) {
  return JSON.stringify(canonical(value));
}

export function changeSetDigest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function verifyIdentity(document, { idField, hashField, prefix, label }) {
  if (!document || typeof document !== "object" || Array.isArray(document)) fail(`${label} is invalid.`, "INVALID_CHANGE_SET_ARTIFACT");
  const payload = { ...document };
  delete payload[idField];
  delete payload[hashField];
  const hash = changeSetDigest(changeSetCanonicalJson(payload));
  if (document[hashField] !== hash || document[idField] !== `${prefix}-${hash.slice(0, 24)}`) {
    fail(`${label} digest verification failed.`, "CHANGE_SET_DIGEST_MISMATCH");
  }
  return document;
}

function sortedUnique(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value)) {
    fail(`${label} must be an array of non-empty strings.`, "INVALID_CHANGE_SET_ARTIFACT");
  }
  const normalized = [...new Set(values)].sort();
  if (changeSetCanonicalJson(values) !== changeSetCanonicalJson(normalized)) {
    fail(`${label} must be sorted and unique.`, "CHANGE_SET_ORDER_MISMATCH");
  }
  return normalized;
}

function verifySnapshotReference(reference, label, version) {
  const keys = version === CHANGE_SET_RECORD_VERSION ? ["graphSnapshotId", "sourceSnapshotId", "worldModelId"] : ["graphSnapshotId", "sourceSnapshotId"];
  if (!reference || typeof reference !== "object" || Array.isArray(reference)
    || changeSetCanonicalJson(Object.keys(reference).sort()) !== changeSetCanonicalJson(keys)
    || !/^graph-snapshot-[a-f0-9]{24}$/.test(reference.graphSnapshotId || "")
    || !/^source-snapshot-[a-f0-9]{24}$/.test(reference.sourceSnapshotId || "")
    || version === CHANGE_SET_RECORD_VERSION && !/^world-model-[a-f0-9]{24}$/.test(reference.worldModelId || "")) {
    fail(`${label} is invalid.`, "INVALID_CHANGE_SET_SNAPSHOT_REFERENCE");
  }
  return reference;
}

function verifyChange(change) {
  if (!change || typeof change !== "object" || Array.isArray(change)
    || !/^change-record-[a-f0-9]{24}$/.test(change.changeId || "")
    || !["added", "modified", "removed"].includes(change.changeKind)
    || !["File", "Symbol", "Test"].includes(change.entityKind)
    || typeof change.logicalEntityId !== "string" || !change.logicalEntityId
    || (change.beforeRevisionId !== null && typeof change.beforeRevisionId !== "string")
    || (change.afterRevisionId !== null && typeof change.afterRevisionId !== "string")) {
    fail("ChangeSet revision change is invalid.", "INVALID_CHANGE_SET_CHANGE");
  }
  const payload = { ...change };
  delete payload.changeId;
  const hash = changeSetDigest(changeSetCanonicalJson(payload));
  if (change.changeId !== `change-record-${hash.slice(0, 24)}`) fail("ChangeSet revision change identity is invalid.", "CHANGE_SET_CHANGE_IDENTITY_MISMATCH");
  if ((change.changeKind === "added" && (change.beforeRevisionId !== null || !change.afterRevisionId))
    || (change.changeKind === "removed" && (!change.beforeRevisionId || change.afterRevisionId !== null))
    || (change.changeKind === "modified" && (!change.beforeRevisionId || !change.afterRevisionId || change.beforeRevisionId === change.afterRevisionId))) {
    fail("ChangeSet revision endpoints do not match the change kind.", "INVALID_CHANGE_SET_CHANGE");
  }
  return change;
}

export function verifyChangeSet(document, projectId = "", storage = undefined) {
  verifyIdentity(document, { idField: "changeSetId", hashField: "changeSetHash", prefix: "change-set", label: "ChangeSet" });
  if (document.schemaVersion !== 1 || document.kind !== "ChangeSet"
    || !familyFormatForOriginal("head-agent-core-change-set", document, storage) || !["0.1.0", "0.2.0", CHANGE_SET_RECORD_VERSION].includes(document.protocol?.version)
    || (projectId && document.projectId !== projectId)
    || typeof document.sessionId !== "string" || !document.sessionId
    || !/^result-packet-[a-f0-9]{24}$/.test(document.resultPacketId || "")
    || !/^review-decision-[a-f0-9]{24}$/.test(document.reviewDecisionId || "")
    || document.reviewDisposition !== "accept"
    || document.authority !== "reviewed-execution-change-lineage"
    || document.instructionAuthority !== false || document.promotionAuthority !== false
    || !Array.isArray(document.changes) || document.changes.length < 1 || document.changes.length > LIMITS.maxChangesPerSet) {
    fail("ChangeSet fields or authority are invalid.", "INVALID_CHANGE_SET");
  }
  verifySnapshotReference(document.before, "ChangeSet before snapshot", document.protocol.version);
  verifySnapshotReference(document.after, "ChangeSet after snapshot", document.protocol.version);
  if (document.before.sourceSnapshotId === document.after.sourceSnapshotId) {
    fail("ChangeSet before and after snapshots must differ.", "EMPTY_CHANGE_SET");
  }
  sortedUnique(document.parentChangeSetIds, "parentChangeSetIds");
  if (document.parentChangeSetIds.includes(document.changeSetId)) fail("A ChangeSet cannot parent itself.", "CHANGE_SET_CYCLE");
  const ids = new Set();
  for (const change of document.changes) {
    verifyChange(change);
    if (ids.has(change.changeId)) fail("Duplicate ChangeSet revision change.", "DUPLICATE_CHANGE_SET_CHANGE");
    ids.add(change.changeId);
  }
  if (changeSetCanonicalJson(document.changes.map((item) => item.changeId)) !== changeSetCanonicalJson([...ids].sort())) {
    fail("ChangeSet revision changes must use identity order.", "CHANGE_SET_ORDER_MISMATCH");
  }
  return document;
}

export function verifyGitCommitObservation(document, storage = undefined) {
  verifyIdentity(document, {
    idField: "gitCommitObservationId",
    hashField: "gitCommitObservationHash",
    prefix: "git-commit-observation",
    label: "Git commit observation",
  });
  if (document.schemaVersion !== 1 || document.kind !== "GitCommitObservation"
    || !familyFormatForOriginal("head-agent-core-git-commit-observation", document, storage) || document.protocol?.version !== VCS_EVIDENCE_VERSION
    || document.vcsKind !== "git" || !/^[a-f0-9]{40,64}$/.test(document.objectId || "")
    || typeof document.authoredAt !== "string" || Number.isNaN(Date.parse(document.authoredAt))
    || typeof document.committedAt !== "string" || Number.isNaN(Date.parse(document.committedAt))
    || !document.author || typeof document.author.name !== "string"
    || (document.authorEmailDigest && !/^[a-f0-9]{64}$/.test(document.authorEmailDigest))
    || typeof document.subject !== "string" || typeof document.body !== "string"
    || document.evidence?.sourceKind !== "git-commit-object"
    || document.evidence?.uri !== `git:${document.objectId}` || document.evidence?.digest !== document.objectId
    || document.evidence?.instructionAuthority !== false
    || document.authority !== "derived-vcs-observation" || document.trustBoundary !== "evidence-not-instruction"
    || document.instructionAuthority !== false || document.promotionAuthority !== false) {
    fail("Git commit observation fields or authority are invalid.", "INVALID_GIT_COMMIT_OBSERVATION");
  }
  sortedUnique(document.parents, "Git commit observation parents");
  if (document.parents.some((item) => !/^[a-f0-9]{40,64}$/.test(item))) {
    fail("Git commit observation parent object id is invalid.", "INVALID_GIT_COMMIT_OBSERVATION");
  }
  sortedUnique(document.refs, "Git commit observation refs");
  return document;
}

export function verifyVcsEvidence(document, changeSet, projectId = "", storage = undefined) {
  verifyIdentity(document, { idField: "vcsEvidenceId", hashField: "vcsEvidenceHash", prefix: "vcs-evidence", label: "VCS evidence" });
  if (document.schemaVersion !== 1 || document.kind !== "VcsEvidence"
    || !familyFormatForOriginal("head-agent-core-vcs-evidence", document, storage ?? familyFormatForOriginal("head-agent-core-change-set", changeSet)) || document.protocol?.version !== VCS_EVIDENCE_VERSION
    || (projectId && document.projectId !== projectId) || !changeSet || document.changeSetId !== changeSet.changeSetId
    || document.changeSetHash !== changeSet.changeSetHash || document.sessionId !== changeSet.sessionId
    || document.vcsKind !== "git" || document.attachmentMethod !== "explicit-commit-selection"
    || typeof document.rationale !== "string" || !document.rationale
    || !/^git-history-[a-f0-9]{24}$/.test(document.gitHistory?.historyId || "")
    || !/^[a-f0-9]{64}$/.test(document.gitHistory?.historyHash || "")
    || document.gitHistory?.coverage !== "all-reachable-commits"
    || !Array.isArray(document.commitObservations) || document.commitObservations.length < 1
    || document.commitObservations.length > LIMITS.maxCommitObservationsPerEvidence
    || document.authority !== "optional-derived-vcs-evidence" || document.trustBoundary !== "evidence-not-instruction"
    || document.instructionAuthority !== false || document.promotionAuthority !== false) {
    fail("VCS evidence fields or authority are invalid.", "INVALID_VCS_EVIDENCE");
  }
  const observationIds = new Set();
  const objectIds = new Set();
  for (const observation of document.commitObservations) {
    verifyGitCommitObservation(observation, familyFormatForOriginal("head-agent-core-vcs-evidence", document, storage));
    if (observationIds.has(observation.gitCommitObservationId) || objectIds.has(observation.objectId)) {
      fail("VCS evidence contains a duplicate commit observation.", "DUPLICATE_GIT_COMMIT_OBSERVATION");
    }
    observationIds.add(observation.gitCommitObservationId);
    objectIds.add(observation.objectId);
  }
  if (changeSetCanonicalJson(document.commitObservations.map((item) => item.gitCommitObservationId)) !== changeSetCanonicalJson([...observationIds].sort())) {
    fail("VCS evidence commit observations must use identity order.", "CHANGE_SET_ORDER_MISMATCH");
  }
  return document;
}

function verifyImpactCandidate(candidate, changeSet, storage) {
  verifyIdentity(candidate, { idField: "candidateId", hashField: "candidateHash", prefix: "change-impact-candidate", label: "Change impact candidate" });
  if (candidate.schemaVersion !== 1 || candidate.kind !== "ChangeImpactCandidate" || (candidate.protocol != null && !familyFormatForOriginal("head-agent-core-change-impact-candidates", candidate, storage)) || candidate.relationshipType !== "IMPACTS"
    || candidate.changeSetId !== changeSet.changeSetId
    || !["Feature", "Capability"].includes(candidate.target.kind)
    || typeof candidate.target.nodeId !== "string" || !candidate.target.nodeId
    || typeof candidate.target.revisionId !== "string" || !candidate.target.revisionId
    || typeof candidate.confidence !== "number" || candidate.confidence < 0 || candidate.confidence > 1
    || typeof candidate.explanation !== "string" || !candidate.explanation
    || candidate.authorityClass !== "candidate" || candidate.instructionAuthority !== false || candidate.promotionAuthority !== false) {
    fail("Change impact candidate fields or authority are invalid.", "INVALID_CHANGE_IMPACT_CANDIDATE");
  }
  sortedUnique(candidate.changeIds, `Candidate ${candidate.candidateId} changeIds`);
  sortedUnique(candidate.reviewedRelationshipIds, `Candidate ${candidate.candidateId} reviewedRelationshipIds`);
  const knownChanges = new Set(changeSet.changes.map((item) => item.changeId));
  if (!candidate.changeIds.length || candidate.changeIds.some((id) => !knownChanges.has(id))) {
    fail("Change impact candidate references an unknown ChangeSet change.", "UNKNOWN_CHANGE_SET_CHANGE");
  }
  return candidate;
}

export function verifyChangeImpactCandidateSet(document, changeSet, projectId = "", storage = undefined) {
  verifyIdentity(document, { idField: "candidateSetId", hashField: "candidateSetHash", prefix: "change-impact-candidates", label: "Change impact candidate set" });
  const legacy = document.protocol?.version === "0.1.0";
  if (document.schemaVersion !== 1 || document.kind !== "ChangeImpactCandidateSet"
    || !familyFormatForOriginal("head-agent-core-change-impact-candidates", document, storage ?? familyFormatForOriginal("head-agent-core-change-set", changeSet)) || !["0.1.0", CHANGE_SET_VERSION].includes(document.protocol?.version)
    || (projectId && document.projectId !== projectId) || !changeSet || document.changeSetId !== changeSet.changeSetId
    || document.afterSourceSnapshotId !== changeSet.after.sourceSnapshotId
    || document.authorityClass !== "candidate-set" || document.instructionAuthority !== false || document.promotionAuthority !== false
    || !Array.isArray(document.candidates) || !Array.isArray(document.unknowns)
    || document.candidates.length > LIMITS.maxCandidatesPerSet || document.unknowns.length > LIMITS.maxUnknownsPerSet) {
    fail("Change impact candidate-set fields or authority are invalid.", "INVALID_CHANGE_IMPACT_CANDIDATE_SET");
  }
  const ids = new Set();
  for (const candidate of document.candidates) {
    verifyImpactCandidate(candidate, changeSet, familyFormatForOriginal("head-agent-core-change-impact-candidates", document, storage));
    if (ids.has(candidate.candidateId)) fail("Duplicate Change impact candidate.", "DUPLICATE_CHANGE_IMPACT_CANDIDATE");
    ids.add(candidate.candidateId);
  }
  if (changeSetCanonicalJson(document.candidates.map((item) => item.candidateId)) !== changeSetCanonicalJson([...ids].sort())) {
    fail("Change impact candidates must use identity order.", "CHANGE_SET_ORDER_MISMATCH");
  }
  const knownChangeIds = new Set(changeSet.changes.map((item) => item.changeId));
  for (const unknown of document.unknowns) if (!unknown || !/^change-impact-unknown-[a-f0-9]{24}$/.test(unknown.unknownId || "")
    || typeof unknown.statement !== "string" || !unknown.statement || unknown.status !== "open"
    || (!legacy && (typeof unknown.kind !== "string" || !unknown.kind || !Array.isArray(unknown.changeIds)
      || unknown.changeIds.some((id) => !knownChangeIds.has(id))))) {
    fail("Change impact Unknown is invalid.", "INVALID_CHANGE_IMPACT_UNKNOWN");
  }
  if (!legacy) {
    const coverage = document.coverage;
    if (!coverage || coverage.unit !== "repository-path" || !Array.isArray(coverage.units)
      || coverage.totalChangedUnits !== coverage.units.length || coverage.totalChanges !== changeSet.changes.length) {
      fail("Change impact coverage is invalid.", "INVALID_CHANGE_IMPACT_COVERAGE");
    }
    const covered = new Set();
    const statusCounts = { mapped: 0, partial: 0, unmapped: 0, "historical-only": 0 };
    let mappedChanges = 0;
    let historicalOnlyChanges = 0;
    let unmappedChanges = 0;
    let previousKey = "";
    for (const unit of coverage.units) {
      if (!unit || typeof unit.unitKey !== "string" || !unit.unitKey || (previousKey && previousKey.localeCompare(unit.unitKey) >= 0)
        || !Object.hasOwn(statusCounts, unit.status)) fail("Change impact coverage units are invalid.", "INVALID_CHANGE_IMPACT_COVERAGE");
      previousKey = unit.unitKey;
      for (const field of ["changeIds", "mappedChangeIds", "historicalOnlyChangeIds", "unmappedChangeIds"]) sortedUnique(unit[field], `Coverage ${unit.unitKey} ${field}`);
      const partition = [...unit.mappedChangeIds, ...unit.historicalOnlyChangeIds, ...unit.unmappedChangeIds].sort();
      if (changeSetCanonicalJson(partition) !== changeSetCanonicalJson(unit.changeIds)
        || unit.changeIds.some((id) => !knownChangeIds.has(id) || covered.has(id))) {
        fail("Change impact coverage must partition each change exactly once.", "INVALID_CHANGE_IMPACT_COVERAGE");
      }
      unit.changeIds.forEach((id) => covered.add(id));
      statusCounts[unit.status] += 1;
      mappedChanges += unit.mappedChangeIds.length;
      historicalOnlyChanges += unit.historicalOnlyChangeIds.length;
      unmappedChanges += unit.unmappedChangeIds.length;
    }
    if (covered.size !== changeSet.changes.length || coverage.fullyMappedUnits !== statusCounts.mapped
      || coverage.partiallyMappedUnits !== statusCounts.partial || coverage.unmappedUnits !== statusCounts.unmapped
      || coverage.historicalOnlyUnits !== statusCounts["historical-only"] || coverage.mappedChanges !== mappedChanges
      || coverage.historicalOnlyChanges !== historicalOnlyChanges || coverage.unmappedChanges !== unmappedChanges) {
      fail("Change impact coverage summary does not match its units.", "INVALID_CHANGE_IMPACT_COVERAGE");
    }
  }
  return document;
}

export function verifyChangeImpactReviewDecision(document, candidateSet, projectId = "", storage = undefined) {
  verifyIdentity(document, { idField: "reviewDecisionId", hashField: "reviewDecisionHash", prefix: "change-impact-review-decision", label: "Change impact ReviewDecision" });
  if (document.schemaVersion !== 1 || document.kind !== "ReviewDecision"
    || !familyFormatForOriginal("head-agent-core-change-impact-review", document, storage ?? familyFormatForOriginal("head-agent-core-change-impact-candidates", candidateSet)) || !["0.1.0", CHANGE_SET_VERSION].includes(document.protocol?.version)
    || document.decisionScope !== "change-impact" || (projectId && document.projectId !== projectId)
    || !["accept-all", "accept-selection", "reject"].includes(document.disposition)
    || document.authority !== "explicit-user-change-impact-review" || document.instructionAuthority !== true
    || document.promotionAuthority !== document.disposition.startsWith("accept")
    || typeof document.rationale !== "string" || !document.rationale || !candidateSet || document.candidateSetId !== candidateSet.candidateSetId) {
    fail("Change impact ReviewDecision fields or authority are invalid.", "INVALID_CHANGE_IMPACT_REVIEW");
  }
  sortedUnique(document.acceptedCandidateIds, "acceptedCandidateIds");
  sortedUnique(document.rejectedCandidateIds, "rejectedCandidateIds");
  const known = new Set(candidateSet.candidates.map((item) => item.candidateId));
  const accepted = new Set(document.acceptedCandidateIds);
  const rejected = new Set(document.rejectedCandidateIds);
  if ([...accepted, ...rejected].some((id) => !known.has(id)) || [...accepted].some((id) => rejected.has(id))
    || accepted.size + rejected.size !== known.size || (document.disposition === "reject" && accepted.size)
    || (document.disposition.startsWith("accept") && !accepted.size)) {
    fail("Change impact ReviewDecision candidate partition is invalid.", "INVALID_CHANGE_IMPACT_REVIEW_SELECTION");
  }
  return document;
}

function safeDirectory(projectRoot, relative) {
  const root = path.resolve(projectRoot);
  const directory = path.resolve(root, ...relative.split("/"));
  const fromRoot = path.relative(root, directory);
  if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) fail("ChangeSet projection path escapes the project root.", "CHANGE_SET_PATH_ESCAPE");
  let current = root;
  for (const segment of fromRoot.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail("ChangeSet projection path traverses a symlink.", "CHANGE_SET_SYMLINK_PATH");
  }
  return directory;
}

function readArtifacts(projectRoot, relative, label, limit, storage) {
  const directory = safeDirectory(projectRoot, relativeProjectArtifact(storage, ...relative.split("/").slice(1)));
  if (!fs.existsSync(directory)) return [];
  const files = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name)).sort();
  if (files.length > limit) fail(`${label} count exceeds its bound.`, "CHANGE_SET_PROJECTION_LIMIT");
  const documents = [];
  let bytes = 0;
  for (const file of files) {
    const size = fs.statSync(file).size;
    if (size > LIMITS.maxArtifactBytes || (bytes += size) > LIMITS.maxTotalBytes) fail(`${label} artifacts exceed their byte bound.`, "CHANGE_SET_PROJECTION_LIMIT");
    try { documents.push(JSON.parse(fs.readFileSync(file, "utf8"))); }
    catch (error) { fail(`${label} artifact is invalid JSON: ${error.message}`, "INVALID_CHANGE_SET_ARTIFACT"); }
  }
  return documents;
}

function merge(items, additional, idField, label) {
  const merged = new Map();
  for (const item of [...items, ...additional]) {
    const existing = merged.get(item[idField]);
    if (existing && changeSetCanonicalJson(existing) !== changeSetCanonicalJson(item)) fail(`${label} identity collision.`, "CHANGE_SET_IMMUTABLE_COLLISION");
    merged.set(item[idField], item);
  }
  return [...merged.values()].sort((left, right) => left[idField].localeCompare(right[idField]));
}

export function verifyChangeSetProjectionInput(projection, storage = undefined) {
  const projectionVersion = projection?.protocol?.version;
  const legacy = projectionVersion === "0.1.0";
  if (!projection || projection.kind !== "ChangeSetProjectionInput"
    || !familyFormatForOriginal("head-agent-core-change-set-projection", projection, storage)
    || !["0.1.0", "0.2.0", CHANGE_SET_PROJECTION_VERSION].includes(projectionVersion)
    || !Array.isArray(projection.changeSets) || !Array.isArray(projection.candidateSets) || !Array.isArray(projection.reviewDecisions)
    || (!legacy && !Array.isArray(projection.vcsEvidence))) {
    fail("ChangeSet projection input is invalid.", "INVALID_CHANGE_SET_PROJECTION");
  }
  const changeSets = new Map();
  for (const changeSet of projection.changeSets) {
    verifyChangeSet(changeSet, projection.projectId, familyFormatForOriginal("head-agent-core-change-set-projection", projection, storage));
    if (changeSets.has(changeSet.changeSetId)) fail("Duplicate ChangeSet.", "DUPLICATE_CHANGE_SET");
    changeSets.set(changeSet.changeSetId, changeSet);
  }
  for (const changeSet of changeSets.values()) for (const parentId of changeSet.parentChangeSetIds) {
    if (!changeSets.has(parentId)) fail(`ChangeSet parent is missing: ${parentId}`, "CHANGE_SET_PARENT_MISSING");
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (changeSetId) => {
    if (visiting.has(changeSetId)) fail(`ChangeSet ancestry contains a cycle: ${changeSetId}`, "CHANGE_SET_CYCLE");
    if (visited.has(changeSetId)) return;
    visiting.add(changeSetId);
    for (const parentId of changeSets.get(changeSetId).parentChangeSetIds) visit(parentId);
    visiting.delete(changeSetId);
    visited.add(changeSetId);
  };
  for (const changeSetId of changeSets.keys()) visit(changeSetId);
  const candidateSets = new Map();
  for (const candidateSet of projection.candidateSets) {
    const changeSet = changeSets.get(candidateSet.changeSetId);
    if (!changeSet) fail("Change impact candidate set references an unknown ChangeSet.", "UNKNOWN_CHANGE_SET");
    verifyChangeImpactCandidateSet(candidateSet, changeSet, projection.projectId, familyFormatForOriginal("head-agent-core-change-set-projection", projection, storage));
    candidateSets.set(candidateSet.candidateSetId, candidateSet);
  }
  const reviewIds = new Set();
  for (const review of projection.reviewDecisions) {
    const candidateSet = candidateSets.get(review.candidateSetId);
    if (!candidateSet) fail("Change impact review references an unknown candidate set.", "UNKNOWN_CHANGE_IMPACT_CANDIDATE_SET");
    verifyChangeImpactReviewDecision(review, candidateSet, projection.projectId, familyFormatForOriginal("head-agent-core-change-set-projection", projection, storage));
    if (reviewIds.has(review.reviewDecisionId)) fail("Duplicate Change impact ReviewDecision.", "DUPLICATE_CHANGE_IMPACT_REVIEW");
    reviewIds.add(review.reviewDecisionId);
  }
  const vcsEvidenceIds = new Set();
  for (const evidence of projection.vcsEvidence || []) {
    const changeSet = changeSets.get(evidence.changeSetId);
    if (!changeSet) fail("VCS evidence references an unknown ChangeSet.", "UNKNOWN_CHANGE_SET");
    verifyVcsEvidence(evidence, changeSet, projection.projectId, familyFormatForOriginal("head-agent-core-change-set-projection", projection, storage));
    if (vcsEvidenceIds.has(evidence.vcsEvidenceId)) fail("Duplicate VCS evidence.", "DUPLICATE_VCS_EVIDENCE");
    vcsEvidenceIds.add(evidence.vcsEvidenceId);
  }
  const payload = { ...projection };
  delete payload.projectionInputId;
  delete payload.projectionInputHash;
  const hash = changeSetDigest(changeSetCanonicalJson(payload));
  if (projection.projectionInputHash !== hash || projection.projectionInputId !== `change-set-projection-${hash.slice(0, 24)}`) {
    fail("ChangeSet projection digest verification failed.", "CHANGE_SET_PROJECTION_DIGEST_MISMATCH");
  }
  return projection;
}

export function loadChangeSetProjection({ projectRoot, projectId, storage, additionalChangeSets = [], additionalCandidateSets = [], additionalReviewDecisions = [], additionalVcsEvidence = [] } = {}) {
  const changeSets = merge(readArtifacts(projectRoot, CHANGE_SET_DIRECTORY, "ChangeSet", LIMITS.maxChangeSets, storage), additionalChangeSets, "changeSetId", "ChangeSet");
  const candidateSets = merge(readArtifacts(projectRoot, CHANGE_IMPACT_CANDIDATE_DIRECTORY, "Change impact candidate set", LIMITS.maxCandidateSets, storage), additionalCandidateSets, "candidateSetId", "Change impact candidate set");
  const reviewDecisions = merge(readArtifacts(projectRoot, CHANGE_IMPACT_REVIEW_DIRECTORY, "Change impact ReviewDecision", LIMITS.maxReviewDecisions, storage), additionalReviewDecisions, "reviewDecisionId", "Change impact ReviewDecision");
  const vcsEvidence = merge(readArtifacts(projectRoot, VCS_EVIDENCE_DIRECTORY, "VCS evidence", LIMITS.maxVcsEvidence, storage), additionalVcsEvidence, "vcsEvidenceId", "VCS evidence");
  const payload = {
    schemaVersion: 1,
    kind: "ChangeSetProjectionInput",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-change-set-projection"), version: CHANGE_SET_PROJECTION_VERSION },
    projectId,
    changeSets,
    candidateSets,
    reviewDecisions,
    vcsEvidence,
    authority: "derived-projection-input-not-change-lineage-authority",
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const hash = changeSetDigest(changeSetCanonicalJson(payload));
  return verifyChangeSetProjectionInput({ ...payload, projectionInputId: `change-set-projection-${hash.slice(0, 24)}`, projectionInputHash: hash }, storage);
}
