import { formatForVerifiedOwner, familyFormatForOriginal, relativeProjectArtifact } from "./project-storage-format.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SCHEMA_VERSION } from "./lode-core.mjs";
import { verifyGitCommitObservation } from "./change-set-projection.mjs";
import { OBSERVATION_PROTOCOL_VERSION } from "./observation-contract.mjs";

// Stored P3 originals and their derived input; no writer or current World lookup.
export const RELEASE_OBSERVATION_VERSION = "0.1.0";
export const BRANCH_STATE_OBSERVATION_DIRECTORY = ".head/release-observations/branch-states";
export const DEPLOYMENT_RESULT_OBSERVATION_DIRECTORY = ".head/release-observations/deployment-results";
export const RELEASE_OBSERVATION_DIRECTORY = ".head/release-observations/releases";

const DIRECTORIES = Object.freeze({
  branchStates: BRANCH_STATE_OBSERVATION_DIRECTORY,
  deploymentResults: DEPLOYMENT_RESULT_OBSERVATION_DIRECTORY,
  releases: RELEASE_OBSERVATION_DIRECTORY,
});
const LIMITS = Object.freeze({ maxArtifacts: 1024, maxArtifactBytes: 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024 });
const DEPLOYMENT_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const REF_KINDS = new Set(["branch", "remote", "tag"]);
const fail = (message, code = "RELEASE_OBSERVATION_ERROR") => { const error = new Error(message); error.code = code; throw error; };

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function releaseObservationCanonicalJson(value) { return JSON.stringify(canonical(value)); }
export function releaseObservationDigest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

function requiredText(value, label, max = 512) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value.trim(), "utf8") > max) fail(`${label} is invalid.`, "INVALID_RELEASE_OBSERVATION_INPUT");
  return value.trim();
}

function stableKey(value, label) {
  const normalized = requiredText(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) fail(`${label} is not a stable key.`, "INVALID_RELEASE_OBSERVATION_INPUT");
  return normalized;
}

function verifyIdentity(document, prefix, idField, hashField, label) {
  const payload = { ...document }; delete payload[idField]; delete payload[hashField];
  const hash = releaseObservationDigest(releaseObservationCanonicalJson(payload));
  if (document[hashField] !== hash || document[idField] !== `${prefix}-${hash.slice(0, 24)}`) fail(`${label} digest verification failed.`, "RELEASE_OBSERVATION_DIGEST_MISMATCH");
}

function authorityValid(document, authority) {
  return document.authority === authority && document.epistemicClass === "observed-fact"
    && document.instructionAuthority === false && document.promotionAuthority === false
    && document.mutatesCanon === false && document.recoveryAuthority === false;
}

export function verifyBranchStateObservation(document, projectId = "", storage) {
  verifyIdentity(document, "branch-state-observation", "branchStateObservationId", "branchStateObservationHash", "BranchStateObservation");
  if (document.schemaVersion !== SCHEMA_VERSION || document.kind !== "BranchStateObservation"
    || !familyFormatForOriginal("head-agent-core-release-observation", document, storage) || document.protocol?.version !== RELEASE_OBSERVATION_VERSION
    || (projectId && document.projectId !== projectId) || document.vcsKind !== "git"
    || !REF_KINDS.has(document.refKind) || typeof document.ref !== "string" || !/^refs\/(?:heads|remotes|tags)\//.test(document.ref)
    || !/^[a-f0-9]{64}$/.test(document.referencesDigest || "")
    || !authorityValid(document, "non-authoritative-branch-state-observation")) fail("BranchStateObservation fields or authority are invalid.", "INVALID_BRANCH_STATE_OBSERVATION");
  verifyGitCommitObservation(document.commitObservation, familyFormatForOriginal("head-agent-core-release-observation", document, storage));
  if (document.commit !== document.commitObservation.objectId) fail("BranchStateObservation commit lineage is invalid.", "INVALID_BRANCH_STATE_OBSERVATION");
  return document;
}

export function verifyDeploymentResultObservation(document, projectId = "", storage) {
  verifyIdentity(document, "deployment-result-observation", "deploymentResultObservationId", "deploymentResultObservationHash", "DeploymentResultObservation");
  if (document.schemaVersion !== SCHEMA_VERSION || document.kind !== "DeploymentResultObservation"
    || !familyFormatForOriginal("head-agent-core-release-observation", document, storage) || document.protocol?.version !== RELEASE_OBSERVATION_VERSION
    || (projectId && document.projectId !== projectId) || !DEPLOYMENT_STATUSES.has(document.status)
    || !/^[a-f0-9]{40,64}$/.test(document.commit || "") || typeof document.observedAt !== "string" || Number.isNaN(Date.parse(document.observedAt))
    || stableKey(document.environmentKey, "Deployment environmentKey") !== document.environmentKey
    || !/^[a-f0-9]{64}$/.test(document.sourceEventKeyDigest || "") || !/^[a-f0-9]{64}$/.test(document.deploymentEvidenceDigest || "")
    || typeof document.approved !== "boolean" || (document.approved !== (document.approvalEvidenceDigest !== null))
    || document.approvalEvidenceDigest !== null && !/^[a-f0-9]{64}$/.test(document.approvalEvidenceDigest || "")
    || !authorityValid(document, "non-authoritative-deployment-result-observation")) fail("DeploymentResultObservation fields or authority are invalid.", "INVALID_DEPLOYMENT_RESULT_OBSERVATION");
  return document;
}

export function verifyReleaseObservation(document, projectId = "", storage) {
  verifyIdentity(document, "release-observation", "releaseObservationId", "releaseObservationHash", "ReleaseObservation");
  if (document.schemaVersion !== SCHEMA_VERSION || document.kind !== "ReleaseObservation"
    || !familyFormatForOriginal("head-agent-core-release-observation", document, storage) || document.protocol?.version !== RELEASE_OBSERVATION_VERSION
    || (projectId && document.projectId !== projectId) || !/^deployment-result-observation-[a-f0-9]{24}$/.test(document.deploymentResultObservationId || "")
    || !Array.isArray(document.branchStateObservationIds) || !document.branchStateObservationIds.length
    || releaseObservationCanonicalJson(document.branchStateObservationIds) !== releaseObservationCanonicalJson([...new Set(document.branchStateObservationIds)].sort())
    || document.branchStateObservationIds.some((id) => !/^branch-state-observation-[a-f0-9]{24}$/.test(id))
    || !/^[a-f0-9]{40,64}$/.test(document.commit || "") || stableKey(document.environmentKey, "Release environmentKey") !== document.environmentKey
    || (document.changeSetId === null) !== (document.vcsEvidenceId === null)
    || document.changeSetId !== null && !/^change-set-[a-f0-9]{24}$/.test(document.changeSetId || "")
    || document.vcsEvidenceId !== null && !/^vcs-evidence-[a-f0-9]{24}$/.test(document.vcsEvidenceId || "")
    || !authorityValid(document, "non-authoritative-release-observation")) fail("ReleaseObservation fields or authority are invalid.", "INVALID_RELEASE_OBSERVATION");
  return document;
}

function safeDirectory(projectRoot, relative) {
  const root = path.resolve(projectRoot);
  const directory = path.resolve(root, ...relative.split("/"));
  const fromRoot = path.relative(root, directory);
  if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) fail("Release observation path escapes project root.", "RELEASE_OBSERVATION_PATH_ESCAPE");
  let current = root;
  for (const segment of fromRoot.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail("Release observation path traverses a symlink.", "RELEASE_OBSERVATION_SYMLINK_PATH");
  }
  return directory;
}

function readArtifacts(projectRoot, relative, label) {
  const directory = safeDirectory(projectRoot, relative);
  if (!fs.existsSync(directory)) return [];
  let totalBytes = 0;
  const files = fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  if (files.length > LIMITS.maxArtifacts) fail(`${label} count exceeds the configured limit.`, "RELEASE_OBSERVATION_LIMIT");
  return files.map((name) => {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > LIMITS.maxArtifactBytes) fail(`${label} artifact is unsafe or too large.`, "RELEASE_OBSERVATION_LIMIT");
    totalBytes += stat.size;
    if (totalBytes > LIMITS.maxTotalBytes) fail(`${label} total bytes exceed the configured limit.`, "RELEASE_OBSERVATION_LIMIT");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  });
}

function projectionPayload({ projectId, branchStates, deploymentResults, releases, storage }) {
  const format = formatForVerifiedOwner(storage);
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "ReleaseObservationProjectionInput",
    protocol: { name: format.protocol("head-agent-core-release-observation-projection"), version: RELEASE_OBSERVATION_VERSION },
    projectId,
    commonObservationContract: {
      protocol: { name: format.protocol("head-agent-core-observation"), version: OBSERVATION_PROTOCOL_VERSION },
      role: "domain-specialization-with-exact-git-and-approved-deployment-lineage",
      genericReplacement: false,
      semanticAuthority: false,
    },
    branchStates,
    deploymentResults,
    releases,
    authority: "derived-projection-input-not-release-authority",
    instructionAuthority: false,
    promotionAuthority: false,
  };
}

export function verifyReleaseObservationProjectionInput(projection, storage = undefined) {
  const format = familyFormatForOriginal("head-agent-core-release-observation-projection", projection, storage);
  if (!projection || projection.kind !== "ReleaseObservationProjectionInput"
    || !format || projection.protocol?.version !== RELEASE_OBSERVATION_VERSION
    || !Array.isArray(projection.branchStates) || !Array.isArray(projection.deploymentResults) || !Array.isArray(projection.releases)
    || projection.commonObservationContract?.protocol?.name !== format.protocol("head-agent-core-observation")
    || projection.commonObservationContract?.protocol?.version !== OBSERVATION_PROTOCOL_VERSION
    || projection.commonObservationContract?.role !== "domain-specialization-with-exact-git-and-approved-deployment-lineage"
    || projection.commonObservationContract?.genericReplacement !== false || projection.commonObservationContract?.semanticAuthority !== false
    || projection.authority !== "derived-projection-input-not-release-authority" || projection.instructionAuthority !== false || projection.promotionAuthority !== false) fail("Release observation projection is invalid.", "INVALID_RELEASE_OBSERVATION_PROJECTION");
  const branches = new Map(projection.branchStates.map((item) => [verifyBranchStateObservation(item, projection.projectId, format).branchStateObservationId, item]));
  if (branches.size !== projection.branchStates.length) fail("Duplicate BranchStateObservation.", "DUPLICATE_BRANCH_STATE_OBSERVATION");
  const deployments = new Map();
  const deploymentKeys = new Map();
  for (const item of projection.deploymentResults) {
    verifyDeploymentResultObservation(item, projection.projectId, format);
    if (deployments.has(item.deploymentResultObservationId)) fail("Duplicate DeploymentResultObservation.", "DUPLICATE_DEPLOYMENT_RESULT_OBSERVATION");
    const existingKey = deploymentKeys.get(item.sourceEventKeyDigest);
    if (existingKey && existingKey !== item.deploymentResultObservationId) fail("Deployment source event has divergent persisted observations.", "DIVERGENT_DEPLOYMENT_RESULT_REPLAY");
    deployments.set(item.deploymentResultObservationId, item);
    deploymentKeys.set(item.sourceEventKeyDigest, item.deploymentResultObservationId);
  }
  const releaseIds = new Set();
  for (const release of projection.releases) {
    verifyReleaseObservation(release, projection.projectId, format);
    if (releaseIds.has(release.releaseObservationId)) fail("Duplicate ReleaseObservation.", "DUPLICATE_RELEASE_OBSERVATION");
    releaseIds.add(release.releaseObservationId);
    const deployment = deployments.get(release.deploymentResultObservationId);
    if (!deployment || deployment.status !== "succeeded" || deployment.approved !== true || deployment.commit !== release.commit || deployment.environmentKey !== release.environmentKey) fail("ReleaseObservation deployment lineage is invalid.", "INVALID_RELEASE_OBSERVATION_LINEAGE");
    for (const id of release.branchStateObservationIds) if (branches.get(id)?.commit !== release.commit) fail("ReleaseObservation branch lineage is invalid.", "INVALID_RELEASE_OBSERVATION_LINEAGE");
  }
  const payload = { ...projection }; delete payload.projectionInputId; delete payload.projectionInputHash;
  const hash = releaseObservationDigest(releaseObservationCanonicalJson(payload));
  if (projection.projectionInputHash !== hash || projection.projectionInputId !== `release-observation-projection-${hash.slice(0, 24)}`) fail("Release observation projection digest verification failed.", "RELEASE_OBSERVATION_PROJECTION_DIGEST_MISMATCH");
  return projection;
}

export function loadReleaseObservationProjection({ projectRoot, projectId, storage } = {}) {
  const directories = storage ? { branchStates: relativeProjectArtifact(storage, "release-observations", "branch-states"), deploymentResults: relativeProjectArtifact(storage, "release-observations", "deployment-results"), releases: relativeProjectArtifact(storage, "release-observations", "releases") } : DIRECTORIES;
  const branchStates = readArtifacts(projectRoot, directories.branchStates, "BranchStateObservation").map((item) => verifyBranchStateObservation(item, projectId, storage)).sort((a, b) => a.branchStateObservationId.localeCompare(b.branchStateObservationId));
  const deploymentResults = readArtifacts(projectRoot, directories.deploymentResults, "DeploymentResultObservation").map((item) => verifyDeploymentResultObservation(item, projectId, storage)).sort((a, b) => a.deploymentResultObservationId.localeCompare(b.deploymentResultObservationId));
  const releases = readArtifacts(projectRoot, directories.releases, "ReleaseObservation").map((item) => verifyReleaseObservation(item, projectId, storage)).sort((a, b) => a.releaseObservationId.localeCompare(b.releaseObservationId));
  const payload = projectionPayload({ projectId, branchStates, deploymentResults, releases, storage });
  const hash = releaseObservationDigest(releaseObservationCanonicalJson(payload));
  return verifyReleaseObservationProjectionInput({ ...payload, projectionInputId: `release-observation-projection-${hash.slice(0, 24)}`, projectionInputHash: hash }, storage);
}

export { DIRECTORIES, DEPLOYMENT_STATUSES, REF_KINDS, fail, requiredText, stableKey, safeDirectory };
