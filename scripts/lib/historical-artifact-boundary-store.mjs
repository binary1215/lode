import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { formatForVerifiedOwner, familyFormatForOriginal, relativeProjectArtifact } from "./project-storage-format.mjs";

export const HISTORICAL_BOUNDARY_PROTOCOL_VERSION = "0.1.0";
export const HISTORICAL_BOUNDARY_ROOT = ".head/onboarding/historical-boundaries";

const ROLES = new Set([
  "historical-candidate-set",
  "historical-review",
  "historical-product-revision",
  "legacy-world-embedding-reference",
]);
const INTERPRETATION_MODES = new Set([
  "opaque-historical",
  "current-typed-with-historical-provenance",
  "opaque-legacy-revision",
]);
const ROLE_PATH_SPECS = Object.freeze({
  "historical-candidate-set": {
    id: /^onboarding-candidates-[a-f0-9]{24}$/,
    path: (artifactId, storage) => relativeProjectArtifact(storage, "onboarding", "candidate-sets", `${artifactId}.json`),
  },
  "historical-review": {
    id: /^onboarding-review-decision-[a-f0-9]{24}$/,
    path: (artifactId, storage) => relativeProjectArtifact(storage, "onboarding", "review-decisions", `${artifactId}.json`),
  },
  "historical-product-revision": {
    id: /^product-model-[a-f0-9]{24}$/,
    path: (artifactId, storage) => relativeProjectArtifact(storage, "onboarding", "product-model-revisions", `${artifactId}.json`),
  },
  "legacy-world-embedding-reference": {
    id: /^world-model-[a-f0-9]{24}$/,
    path: (artifactId, storage) => relativeProjectArtifact(storage, "world-model", "snapshots", `${artifactId}.json`),
  },
});
const MAX_ENTRIES = 512;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

function fail(message, code = "HISTORICAL_BOUNDARY_ERROR") {
  throw Object.assign(new Error(message), { code });
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function historicalBoundaryCanonicalJson(value) {
  return JSON.stringify(canonical(value));
}

export function historicalBoundaryDigest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} is invalid.`, "INVALID_HISTORICAL_BOUNDARY");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} fields are invalid.`, "INVALID_HISTORICAL_BOUNDARY");
}

function normalizedRelative(value) {
  if (typeof value !== "string" || !value || value.includes("\\")) fail("Historical inventory path is invalid.", "HISTORICAL_BOUNDARY_PATH_ESCAPE");
  if (path.posix.isAbsolute(value) || value.split("/").some((part) => !part || part === "." || part === "..")) {
    fail("Historical inventory path escapes the project.", "HISTORICAL_BOUNDARY_PATH_ESCAPE");
  }
  return value;
}

function safeProjectFile(projectRoot, relative, { mustExist = true } = {}) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const normalized = normalizedRelative(relative);
  const candidate = path.resolve(root, ...normalized.split("/"));
  const rel = path.relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) fail("Historical inventory path escapes the project.", "HISTORICAL_BOUNDARY_PATH_ESCAPE");
  let current = root;
  for (const segment of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail("Historical inventory path traverses a symlink.", "HISTORICAL_BOUNDARY_SYMLINK");
  }
  if (mustExist && !fs.existsSync(candidate)) fail(`Historical artifact is missing: ${normalized}`, "HISTORICAL_BOUNDARY_ARTIFACT_MISSING");
  return candidate;
}

export function verifyHistoricalInventoryEntries(entries, { projectRoot, projectId, verifyBytes = true, storage } = {}) {
  const format = formatForVerifiedOwner(storage);
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_ENTRIES) fail("Historical inventory count is invalid.", "HISTORICAL_BOUNDARY_LIMIT");
  const seenPaths = new Set();
  const seenRoles = new Set();
  let totalBytes = 0;
  for (const entry of entries) {
    exactKeys(entry, ["path", "role", "artifactId", "protocolFamily", "protocolVersion", "byteLength", "sha256", "interpretationMode"], "Historical inventory entry");
    normalizedRelative(entry.path);
    if (seenPaths.has(entry.path)) fail(`Historical inventory path is duplicated: ${entry.path}`, "HISTORICAL_BOUNDARY_DUPLICATE");
    seenPaths.add(entry.path);
    if (Number.isInteger(entry.byteLength) && entry.byteLength > MAX_ENTRY_BYTES) {
      fail("Historical inventory entry exceeds its byte bound.", "HISTORICAL_BOUNDARY_LIMIT");
    }
    if (!ROLES.has(entry.role) || typeof entry.artifactId !== "string" || !entry.artifactId
      || typeof entry.protocolFamily !== "string" || !entry.protocolFamily
      || typeof entry.protocolVersion !== "string" || !entry.protocolVersion
      || !Number.isInteger(entry.byteLength) || entry.byteLength < 1
      || !/^[a-f0-9]{64}$/.test(entry.sha256 || "") || !INTERPRETATION_MODES.has(entry.interpretationMode)) {
      fail("Historical inventory entry fields are invalid.", "INVALID_HISTORICAL_BOUNDARY");
    }
    if (entry.role !== "historical-product-revision" && entry.interpretationMode !== "opaque-historical") {
      fail("Only Product Model revisions may declare a revision interpretation mode.", "INVALID_HISTORICAL_BOUNDARY");
    }
    totalBytes += entry.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) fail("Historical inventory exceeds its total byte bound.", "HISTORICAL_BOUNDARY_LIMIT");
    if (verifyBytes) {
      const file = safeProjectFile(projectRoot, entry.path);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.byteLength) fail(`Historical artifact bytes changed: ${entry.path}`, "HISTORICAL_BOUNDARY_INTEGRITY_DRIFT");
      const bytes = fs.readFileSync(file);
      if (historicalBoundaryDigest(bytes) !== entry.sha256) fail(`Historical artifact digest changed: ${entry.path}`, "HISTORICAL_BOUNDARY_INTEGRITY_DRIFT");
    }
    const roleSpec = ROLE_PATH_SPECS[entry.role];
    if (!roleSpec.id.test(entry.artifactId) || entry.path !== roleSpec.path(entry.artifactId, storage)
      && !(entry.role === "legacy-world-embedding-reference" && entry.path === roleSpec.path(entry.artifactId, storage) + ".gz")) {
      fail("Historical inventory role, path, and artifact identity do not agree.", "HISTORICAL_BOUNDARY_ROLE_PATH_MISMATCH");
    }
    seenRoles.add(entry.role);
  }
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path, "en"));
  if (historicalBoundaryCanonicalJson(entries) !== historicalBoundaryCanonicalJson(sorted)) fail("Historical inventory entries must be path-sorted.", "INVALID_HISTORICAL_BOUNDARY_ORDER");
  if (!seenRoles.has("historical-candidate-set") || !seenRoles.has("historical-review") || !seenRoles.has("historical-product-revision")) {
    fail("Historical inventory is incomplete for a completed approval chain.", "HISTORICAL_BOUNDARY_INCOMPLETE");
  }
  if (projectId && !new RegExp(`^${format.projectPrefix}[a-f0-9]{20}$`).test(projectId)) fail("Historical boundary Project identity is invalid.", "INVALID_HISTORICAL_BOUNDARY");
  return entries;
}

function verifyIdentity(document, { idField, hashField, prefix, label }) {
  const payload = { ...document };
  delete payload[idField];
  delete payload[hashField];
  const hash = historicalBoundaryDigest(historicalBoundaryCanonicalJson(payload));
  if (document[hashField] !== hash || document[idField] !== `${prefix}-${hash.slice(0, 24)}`) fail(`${label} identity is invalid.`, "HISTORICAL_BOUNDARY_DIGEST_MISMATCH");
  return document;
}

export function verifyHistoricalArtifactBoundary(document, { projectRoot, projectId, verifyBytes = true, storage } = {}) {
  const format = familyFormatForOriginal("head-agent-core-historical-artifact-boundary", document, storage);
  if (document?.kind !== "HistoricalArtifactBoundary" || !format
    || document.protocol?.version !== HISTORICAL_BOUNDARY_PROTOCOL_VERSION || document.schemaVersion !== 1
    || document.authorityClass !== "evidence" || document.instructionAuthority !== false || document.promotionAuthority !== false
    || !new RegExp(`^${format.projectPrefix}[a-f0-9]{20}$`).test(document.projectId || "") || (projectId && document.projectId !== projectId)
    || !/^[a-f0-9]{64}$/.test(document.inventoryHash || "") || !document.appliedAtBasis || typeof document.appliedAtBasis !== "object"
    || !/^onboarding-candidates-[a-f0-9]{24}$/.test(document.validatedHistoricalApproval?.candidateSetId || "")
    || !/^onboarding-review-decision-[a-f0-9]{24}$/.test(document.validatedHistoricalApproval?.reviewDecisionId || "")
    || !/^product-model-[a-f0-9]{24}$/.test(document.validatedHistoricalApproval?.resultingProductModelId || "")) {
    fail("Historical boundary fields or authority are invalid.", "INVALID_HISTORICAL_BOUNDARY");
  }
  exactKeys(document.validatedHistoricalApproval, ["candidateSetId", "reviewDecisionId", "resultingProductModelId"], "Validated historical approval");
  const payload = { ...document };
  delete payload.boundaryId;
  delete payload.boundaryHash;
  const boundaryHash = historicalBoundaryDigest(historicalBoundaryCanonicalJson(payload));
  if (document.boundaryHash !== boundaryHash || document.boundaryId !== `historical-boundary-${document.inventoryHash.slice(0, 24)}`) {
    fail("Historical boundary identity is invalid.", "HISTORICAL_BOUNDARY_DIGEST_MISMATCH");
  }
  verifyHistoricalInventoryEntries(document.entries, { projectRoot, projectId: document.projectId, verifyBytes, storage: format });
  if (!document.entries.some((entry) => entry.role === "historical-candidate-set" && entry.artifactId === document.validatedHistoricalApproval.candidateSetId)
    || !document.entries.some((entry) => entry.role === "historical-review" && entry.artifactId === document.validatedHistoricalApproval.reviewDecisionId)
    || !document.entries.some((entry) => entry.role === "historical-product-revision"
      && entry.artifactId === document.validatedHistoricalApproval.resultingProductModelId
      && entry.interpretationMode === "current-typed-with-historical-provenance")) {
    fail("Validated historical approval is not covered by the exact inventory.", "HISTORICAL_BOUNDARY_INCOMPLETE");
  }
  const inventoryHash = historicalBoundaryDigest(historicalBoundaryCanonicalJson({ projectId: document.projectId, entries: document.entries }));
  if (inventoryHash !== document.inventoryHash) fail("Historical inventory hash is invalid.", "HISTORICAL_BOUNDARY_DIGEST_MISMATCH");
  return document;
}

export function verifyHistoricalBoundaryReceipt(document, boundary) {
  if (document?.kind !== "HistoricalBoundaryApplicationReceipt" || !familyFormatForOriginal("head-agent-core-historical-boundary-application", document, familyFormatForOriginal("head-agent-core-historical-artifact-boundary", boundary))
    || document.protocol?.version !== HISTORICAL_BOUNDARY_PROTOCOL_VERSION || document.schemaVersion !== 1
    || document.projectId !== boundary.projectId || document.boundaryId !== boundary.boundaryId || document.boundaryHash !== boundary.boundaryHash
    || document.inventoryHash !== boundary.inventoryHash || document.appliedAtBasisHash !== historicalBoundaryDigest(historicalBoundaryCanonicalJson(boundary.appliedAtBasis))
    || document.authorityClass !== "evidence" || document.instructionAuthority !== false || document.promotionAuthority !== false) {
    fail("Historical boundary receipt is invalid.", "INVALID_HISTORICAL_BOUNDARY_RECEIPT");
  }
  verifyIdentity(document, { idField: "receiptId", hashField: "receiptHash", prefix: "historical-boundary-receipt", label: "Historical boundary receipt" });
  return document;
}

export function historicalIntegrityBasis(boundary, receipt) {
  return {
    projectId: boundary.projectId,
    inventoryHash: boundary.inventoryHash,
    entries: boundary.entries.map(({ path: entryPath, artifactId, byteLength, sha256 }) => ({ path: entryPath, artifactId, byteLength, sha256 })),
    boundaryId: boundary.boundaryId,
    boundaryHash: boundary.boundaryHash,
    receiptId: receipt.receiptId,
    receiptHash: receipt.receiptHash,
  };
}

export function verifyHistoricalBoundaryCommit(document, boundary, receipt) {
  const basis = historicalIntegrityBasis(boundary, receipt);
  if (document?.kind !== "HistoricalBoundaryCommitMarker" || !familyFormatForOriginal("head-agent-core-historical-boundary-commit", document, familyFormatForOriginal("head-agent-core-historical-artifact-boundary", boundary))
    || document.protocol?.version !== HISTORICAL_BOUNDARY_PROTOCOL_VERSION || document.schemaVersion !== 1
    || document.projectId !== boundary.projectId || document.boundaryId !== boundary.boundaryId || document.boundaryHash !== boundary.boundaryHash
    || document.receiptId !== receipt.receiptId || document.receiptHash !== receipt.receiptHash || document.inventoryHash !== boundary.inventoryHash
    || document.historicalIntegrityBasisHash !== historicalBoundaryDigest(historicalBoundaryCanonicalJson(basis))
    || document.authorityClass !== "evidence" || document.instructionAuthority !== false || document.promotionAuthority !== false) {
    fail("Historical boundary commit marker is invalid.", "INVALID_HISTORICAL_BOUNDARY_COMMIT");
  }
  verifyIdentity(document, { idField: "commitId", hashField: "commitHash", prefix: "historical-boundary-commit", label: "Historical boundary commit" });
  return document;
}

function parseJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`${label} is invalid JSON: ${error.message}`, "INVALID_HISTORICAL_BOUNDARY_JSON"); }
}

function boundaryDirectories(projectRoot, storage) {
  const root = safeProjectFile(projectRoot, relativeProjectArtifact(storage, "onboarding", "historical-boundaries"), { mustExist: false });
  if (!fs.existsSync(root)) return [];
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) fail("Historical boundary root is invalid.", "HISTORICAL_BOUNDARY_SYMLINK");
  const entries = fs.readdirSync(root, { withFileTypes: true });
  if (entries.length > 1) fail("Only one historical boundary is supported by the first migration slice.", "HISTORICAL_BOUNDARY_DIVERGENT_REPLAY");
  for (const entry of entries) if (!entry.isDirectory() || entry.isSymbolicLink() || !/^historical-boundary-[a-f0-9]{24}$/.test(entry.name)) {
    fail("Historical boundary root contains an unexpected entry.", "INVALID_HISTORICAL_BOUNDARY_PATH");
  }
  return entries.map((entry) => path.join(root, entry.name));
}

export function readHistoricalBoundaryApplication({ root = ".", projectId = "", allowAbsent = true, requireCommitted = false, verifyBytes = true, storage } = {}) {
  const projectRoot = fs.realpathSync(path.resolve(root));
  const directories = boundaryDirectories(projectRoot, storage);
  if (!directories.length) {
    if (allowAbsent) return null;
    fail("Historical boundary is absent.", "HISTORICAL_BOUNDARY_NOT_FOUND");
  }
  const directory = directories[0];
  const expected = new Set(["boundary.json", "receipt.json", "commit.json"]);
  const actual = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of actual) if (!expected.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) fail("Historical boundary directory contains an unexpected entry.", "INVALID_HISTORICAL_BOUNDARY_PATH");
  const boundaryFile = path.join(directory, "boundary.json");
  if (!fs.existsSync(boundaryFile)) fail("Historical boundary directory is missing its boundary.", "INVALID_HISTORICAL_BOUNDARY");
  const boundary = verifyHistoricalArtifactBoundary(parseJson(boundaryFile, "Historical boundary"), { projectRoot, projectId, verifyBytes, storage });
  if (path.basename(directory) !== boundary.boundaryId) fail("Historical boundary directory identity is invalid.", "HISTORICAL_BOUNDARY_IDENTITY_MISMATCH");
  const receiptFile = path.join(directory, "receipt.json");
  const commitFile = path.join(directory, "commit.json");
  const receipt = fs.existsSync(receiptFile) ? verifyHistoricalBoundaryReceipt(parseJson(receiptFile, "Historical boundary receipt"), boundary) : null;
  const commit = fs.existsSync(commitFile) ? receipt && verifyHistoricalBoundaryCommit(parseJson(commitFile, "Historical boundary commit"), boundary, receipt) : null;
  if (fs.existsSync(commitFile) && !receipt) fail("Historical boundary commit lacks a receipt.", "INVALID_HISTORICAL_BOUNDARY_COMMIT");
  if (requireCommitted && !commit) fail("Historical boundary application is incomplete.", "HISTORICAL_BOUNDARY_PARTIAL");
  const entryByPath = new Map(boundary.entries.map((entry) => [entry.path, entry]));
  return {
    directory,
    boundary,
    receipt,
    commit,
    applicationStatus: commit ? "committed" : "partial",
    boundaryIntegrity: "verified",
    historicalIntegrityBasis: receipt ? historicalIntegrityBasis(boundary, receipt) : null,
    coverage: {
      opaqueCandidateSetIds: boundary.entries.filter((entry) => entry.role === "historical-candidate-set").map((entry) => entry.artifactId),
      opaqueReviewDecisionIds: boundary.entries.filter((entry) => entry.role === "historical-review").map((entry) => entry.artifactId),
      typedRevisionIds: boundary.entries.filter((entry) => entry.role === "historical-product-revision" && entry.interpretationMode === "current-typed-with-historical-provenance").map((entry) => entry.artifactId),
      opaqueRevisionIds: boundary.entries.filter((entry) => entry.role === "historical-product-revision" && entry.interpretationMode === "opaque-legacy-revision").map((entry) => entry.artifactId),
      legacyWorldEmbeddingReferenceIds: boundary.entries.filter((entry) => entry.role === "legacy-world-embedding-reference").map((entry) => entry.artifactId),
      omittedHistoricalSemantics: "legacy candidate and review bodies remain opaque to current Core",
    },
    entryByPath,
  };
}

export function readCommittedHistoricalArtifactBoundary(options = {}) {
  return readHistoricalBoundaryApplication({ ...options, requireCommitted: true });
}

export function historicalEntryForPath(application, relativePath, role = null) {
  const entry = application?.entryByPath?.get(relativePath) || null;
  return entry && (!role || entry.role === role) ? entry : null;
}

export function historicalBoundaryStorageFiles(projectRoot, boundaryId, storage = undefined) {
  if (!/^historical-boundary-[a-f0-9]{24}$/.test(boundaryId || "")) fail("Historical boundary identity is invalid.", "INVALID_HISTORICAL_BOUNDARY");
  const directory = safeProjectFile(projectRoot, relativeProjectArtifact(storage, "onboarding", "historical-boundaries", boundaryId), { mustExist: false });
  return { directory, boundary: path.join(directory, "boundary.json"), receipt: path.join(directory, "receipt.json"), commit: path.join(directory, "commit.json") };
}
