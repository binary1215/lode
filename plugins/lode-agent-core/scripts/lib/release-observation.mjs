import { formatForVerifiedOwner, relativeProjectArtifact } from "./project-storage-format.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inspectProject, SCHEMA_VERSION } from "./lode-core.mjs";
import { readChangeSet, readVcsEvidence } from "./change-set.mjs";
import { VCS_EVIDENCE_VERSION, verifyGitCommitObservation } from "./change-set-projection.mjs";
import { withRefreshWriterLease } from "./refresh-writer-lease.mjs";
import {
  RELEASE_OBSERVATION_VERSION, releaseObservationCanonicalJson, releaseObservationDigest,
  verifyBranchStateObservation, verifyDeploymentResultObservation, verifyReleaseObservation,
  loadReleaseObservationProjection, DEPLOYMENT_STATUSES, REF_KINDS,
  fail, requiredText, stableKey, safeDirectory,
} from "./release-observation-projection.mjs";

export {
  RELEASE_OBSERVATION_VERSION,
  BRANCH_STATE_OBSERVATION_DIRECTORY,
  DEPLOYMENT_RESULT_OBSERVATION_DIRECTORY,
  RELEASE_OBSERVATION_DIRECTORY,
  releaseObservationCanonicalJson,
  releaseObservationDigest,
  verifyBranchStateObservation,
  verifyDeploymentResultObservation,
  verifyReleaseObservation,
  verifyReleaseObservationProjectionInput,
  loadReleaseObservationProjection,
} from "./release-observation-projection.mjs";

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function exactFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`, "INVALID_RELEASE_OBSERVATION_INPUT");
  const expected = [...fields].sort();
  const actual = Object.keys(value).sort();
  if (releaseObservationCanonicalJson(actual) !== releaseObservationCanonicalJson(expected)) fail(`${label} fields are invalid.`, "INVALID_RELEASE_OBSERVATION_INPUT");
}

function digestValue(value, label, nullable = false) {
  if (nullable && value === null) return null;
  const normalized = String(value || "").toLocaleLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) fail(`${label} must be a SHA-256 digest.`, "INVALID_RELEASE_OBSERVATION_INPUT");
  return normalized;
}

function commitId(value) {
  const normalized = String(value || "").toLocaleLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(normalized)) fail("Deployment commit is invalid.", "INVALID_RELEASE_OBSERVATION_INPUT");
  return normalized;
}

function identity(payload, prefix, idField, hashField) {
  const hash = releaseObservationDigest(releaseObservationCanonicalJson(payload));
  return { ...payload, [idField]: `${prefix}-${hash.slice(0, 24)}`, [hashField]: hash };
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try { fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function persistImmutable(projectRoot, relative, id, document) {
  const file = path.join(safeDirectory(projectRoot, relative), `${id}.json`);
  if (fs.existsSync(file)) {
    const existing = JSON.parse(fs.readFileSync(file, "utf8"));
    if (releaseObservationCanonicalJson(existing) !== releaseObservationCanonicalJson(document)) fail(`Immutable identity collision: ${id}`, "RELEASE_OBSERVATION_IMMUTABLE_COLLISION");
    return { status: "existing", file };
  }
  atomicWrite(file, json(document));
  return { status: "recorded", file };
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
  const hash = releaseObservationDigest(releaseObservationCanonicalJson(payload));
  return verifyGitCommitObservation({ ...payload, gitCommitObservationId: `git-commit-observation-${hash.slice(0, 24)}`, gitCommitObservationHash: hash }, storage);
}

function branchState(projectId, reference, referencesDigest, commitObservation, storage) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "BranchStateObservation",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-release-observation"), version: RELEASE_OBSERVATION_VERSION },
    projectId,
    vcsKind: "git",
    ref: reference.ref,
    refKind: reference.kind,
    commit: commitObservation.objectId,
    referencesDigest,
    commitObservation,
    epistemicClass: "observed-fact",
    authority: "non-authoritative-branch-state-observation",
    instructionAuthority: false,
    promotionAuthority: false,
    mutatesCanon: false,
    recoveryAuthority: false,
  };
  return verifyBranchStateObservation(identity(payload, "branch-state-observation", "branchStateObservationId", "branchStateObservationHash"), projectId, storage);
}

function normalizeDeploymentInput(input) {
  exactFields(input, ["environmentKey", "status", "commit", "observedAt", "sourceEventKeyDigest", "deploymentEvidenceDigest", "approved", "approvalEvidenceDigest", "changeSetId", "vcsEvidenceId"], "Deployment result");
  const status = requiredText(input.status, "Deployment status", 32).toLocaleLowerCase();
  if (!DEPLOYMENT_STATUSES.has(status)) fail("Deployment status is invalid.", "INVALID_RELEASE_OBSERVATION_INPUT");
  const observedAt = requiredText(input.observedAt, "Deployment observedAt", 64);
  if (Number.isNaN(Date.parse(observedAt))) fail("Deployment observedAt is invalid.", "INVALID_RELEASE_OBSERVATION_INPUT");
  if (typeof input.approved !== "boolean") fail("Deployment approved must be boolean.", "INVALID_RELEASE_OBSERVATION_INPUT");
  const approvalEvidenceDigest = digestValue(input.approvalEvidenceDigest, "Deployment approvalEvidenceDigest", true);
  if (input.approved !== (approvalEvidenceDigest !== null)) fail("Deployment approval evidence does not match approved.", "INVALID_RELEASE_OBSERVATION_INPUT");
  const changeSetId = input.changeSetId == null ? null : requiredText(input.changeSetId, "Deployment changeSetId", 96);
  const vcsEvidenceId = input.vcsEvidenceId == null ? null : requiredText(input.vcsEvidenceId, "Deployment vcsEvidenceId", 96);
  if ((changeSetId === null) !== (vcsEvidenceId === null)) fail("ChangeSet and VCS evidence must be supplied together.", "INVALID_RELEASE_OBSERVATION_INPUT");
  return {
    environmentKey: stableKey(input.environmentKey, "Deployment environmentKey"),
    status,
    commit: commitId(input.commit),
    observedAt,
    sourceEventKeyDigest: digestValue(input.sourceEventKeyDigest, "Deployment sourceEventKeyDigest"),
    deploymentEvidenceDigest: digestValue(input.deploymentEvidenceDigest, "Deployment deploymentEvidenceDigest"),
    approved: input.approved,
    approvalEvidenceDigest,
    changeSetId,
    vcsEvidenceId,
  };
}

export class StructuredDeploymentResultAdapter {
  constructor({ input } = {}) { this.adapterVersion = RELEASE_OBSERVATION_VERSION; this.input = input; }
  describe() { return { adapterKind: "structured-deployment-result", adapterVersion: this.adapterVersion, authority: "observed-evidence-only", providerNeutral: true, persistsProviderIdentity: false }; }
  readResult() { return normalizeDeploymentInput(this.input); }
}

export function assertDeploymentResultAdapter(adapter) {
  if (!adapter || typeof adapter !== "object" || adapter.adapterVersion !== RELEASE_OBSERVATION_VERSION || typeof adapter.describe !== "function" || typeof adapter.readResult !== "function") fail("DeploymentResultAdapter is invalid.", "INVALID_DEPLOYMENT_RESULT_ADAPTER");
  const descriptor = adapter.describe();
  if (descriptor.authority !== "observed-evidence-only" || descriptor.providerNeutral !== true || descriptor.persistsProviderIdentity !== false) fail("DeploymentResultAdapter crosses the authority boundary.", "INVALID_DEPLOYMENT_RESULT_ADAPTER_AUTHORITY");
  return adapter;
}

function deploymentResult(projectId, normalized, storage) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "DeploymentResultObservation",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-release-observation"), version: RELEASE_OBSERVATION_VERSION },
    projectId,
    ...normalized,
    epistemicClass: "observed-fact",
    authority: "non-authoritative-deployment-result-observation",
    instructionAuthority: false,
    promotionAuthority: false,
    mutatesCanon: false,
    recoveryAuthority: false,
  };
  return verifyDeploymentResultObservation(identity(payload, "deployment-result-observation", "deploymentResultObservationId", "deploymentResultObservationHash"), projectId, storage);
}

function releaseObservation(projectId, deployment, branchStates, storage) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "ReleaseObservation",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-release-observation"), version: RELEASE_OBSERVATION_VERSION },
    projectId,
    environmentKey: deployment.environmentKey,
    commit: deployment.commit,
    deploymentResultObservationId: deployment.deploymentResultObservationId,
    branchStateObservationIds: branchStates.map((item) => item.branchStateObservationId).sort(),
    changeSetId: deployment.changeSetId,
    vcsEvidenceId: deployment.vcsEvidenceId,
    epistemicClass: "observed-fact",
    authority: "non-authoritative-release-observation",
    instructionAuthority: false,
    promotionAuthority: false,
    mutatesCanon: false,
    recoveryAuthority: false,
  };
  return verifyReleaseObservation(identity(payload, "release-observation", "releaseObservationId", "releaseObservationHash"), projectId, storage);
}

function readyProject(root) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") fail(`Project must be ready for release observation; current status: ${inspected.status}.`, "PROJECT_NOT_READY");
  return inspected;
}

export async function observeReleaseState({ root = ".", input = null, adapter = null } = {}) {
  const inspected = readyProject(root);
  const storage = inspected.storage;
  const directories = { branchStates: relativeProjectArtifact(storage, "release-observations", "branch-states"), deploymentResults: relativeProjectArtifact(storage, "release-observations", "deployment-results"), releases: relativeProjectArtifact(storage, "release-observations", "releases") };
  return withRefreshWriterLease({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, storage }, async (writerLease) => {
  const selected = assertDeploymentResultAdapter(adapter || new StructuredDeploymentResultAdapter({ input }));
  const normalized = await selected.readResult({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId });
  const verifiedInput = normalizeDeploymentInput(normalized);
  const { buildWorldModel } = await import("./world-model.mjs");
  const before = await buildWorldModel({ root: inspected.project.projectRoot, persist: true, writerLease, storage });
  const history = before.snapshot.gitDecisionHistory;
  if (history.status !== "available") fail("Verified Git history is unavailable for release observation.", "RELEASE_GIT_HISTORY_UNAVAILABLE");
  const commit = history.commits.find((item) => item.commit === verifiedInput.commit);
  if (!commit) fail("Deployment commit is absent from verified reachable Git history.", "RELEASE_COMMIT_NOT_FOUND");
  const commitObservation = gitCommitObservation(commit, storage);
  const references = (before.snapshot.git.references || []).filter((item) => item.commit === verifiedInput.commit && REF_KINDS.has(item.kind));
  const branchStates = references.map((reference) => branchState(inspected.project.projectId, reference, before.snapshot.git.referencesDigest, commitObservation, storage));
  for (const branch of branchStates) persistImmutable(inspected.project.projectRoot, directories.branchStates, branch.branchStateObservationId, branch);
  const deployment = deploymentResult(inspected.project.projectId, verifiedInput, storage);
  const currentProjection = loadReleaseObservationProjection({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, storage: inspected.storage });
  const conflicting = currentProjection.deploymentResults.find((item) => item.sourceEventKeyDigest === deployment.sourceEventKeyDigest && item.deploymentResultObservationId !== deployment.deploymentResultObservationId);
  if (conflicting) fail("Deployment source event was replayed with divergent content.", "DIVERGENT_DEPLOYMENT_RESULT_REPLAY");
  persistImmutable(inspected.project.projectRoot, directories.deploymentResults, deployment.deploymentResultObservationId, deployment);
  let release = null;
  let releaseStatus = deployment.status === "succeeded" && deployment.approved ? "awaiting_matching_product_ref" : "not_release_eligible";
  if (deployment.status === "succeeded" && deployment.approved && branchStates.length) {
    if (deployment.changeSetId) {
      const changeSet = readChangeSet({ root: inspected.project.projectRoot, changeSetId: deployment.changeSetId, storage }).changeSet;
      const vcsEvidence = readVcsEvidence({ root: inspected.project.projectRoot, vcsEvidenceId: deployment.vcsEvidenceId, storage }).vcsEvidence;
      if (vcsEvidence.changeSetId !== changeSet.changeSetId || !vcsEvidence.commitObservations.some((item) => item.objectId === deployment.commit)) fail("Release ChangeSet/VCS evidence does not contain the deployed commit.", "RELEASE_VCS_EVIDENCE_MISMATCH");
    }
    release = releaseObservation(inspected.project.projectId, deployment, branchStates, storage);
    persistImmutable(inspected.project.projectRoot, directories.releases, release.releaseObservationId, release);
    releaseStatus = "release_observed";
  }
  const after = await buildWorldModel({ root: inspected.project.projectRoot, persist: true, writerLease, storage });
  return {
    status: releaseStatus,
    branchStates,
    deploymentResult: deployment,
    release,
    adapter: selected.describe(),
    worldModel: { worldModelId: after.snapshot.worldModelId, graphSnapshotId: after.snapshot.temporalProvenanceGraph.graphSnapshotId },
    authority: { observations: "P3-evidence-only", graph: "P4-derived", productCanonMutated: false, reviewDecisionCreated: false, recoveryDirectionMutated: false },
  };
  });
}

export function inspectReleaseObservations({ root = "." } = {}) {
  const inspected = readyProject(root);
  const projection = loadReleaseObservationProjection({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, storage: inspected.storage });
  return {
    status: projection.branchStates.length || projection.deploymentResults.length || projection.releases.length ? "active" : "not_started",
    projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId,
    projection,
    authority: { observations: "P3-evidence-only", graph: "P4-derived", productCanon: "unchanged", recovery: "unchanged" },
  };
}
