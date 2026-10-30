import crypto from "node:crypto";
import { familyFormatForOriginal, formatForVerifiedOwner } from "./project-storage-format.mjs";

export const ONBOARDING_PROTOCOL_VERSION = "0.1.0";
export const ONBOARDING_STATE_PROTOCOL_VERSION = "0.2.0";
export const ONBOARDING_STATE_RELATIVE_PATH = ".head/onboarding/current.json";
export const ONBOARDING_CANDIDATE_DIRECTORY = ".head/onboarding/candidate-sets";
export const ONBOARDING_REVIEW_DIRECTORY = ".head/onboarding/review-decisions";
export const ONBOARDING_PRODUCT_REVISION_DIRECTORY = ".head/onboarding/product-model-revisions";
export const ONBOARDING_STORAGE_DIRECTORY = ".head/onboarding/storage-selections";
export const SESSION_RECORD_DIRECTORY = ".head/sessions/records";

const PHASES = new Set([
  "initialized",
  "awaiting-evidence",
  "awaiting-review",
  "revision-required",
  "rejected",
  "ready",
]);

const fail = (message, code = "ONBOARDING_CONTRACT_ERROR") => {
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

export function onboardingCanonicalJson(value) {
  return JSON.stringify(canonical(value));
}

export function onboardingDigest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is required.`, "INVALID_ONBOARDING_INPUT");
  return value.trim();
}

function optionalText(value, label) {
  if (value == null) return "";
  if (typeof value !== "string") fail(`${label} must be a string.`, "INVALID_ONBOARDING_INPUT");
  return value.trim();
}

function optionalIdentity(value, pattern, label) {
  if (value == null) return null;
  const normalized = requiredText(value, label);
  if (!pattern.test(normalized)) fail(`${label} is invalid.`, "INVALID_ONBOARDING_STATE");
  return normalized;
}

function requiredIdentity(value, pattern, label) {
  const normalized = requiredText(value, label);
  if (!pattern.test(normalized)) fail(`${label} is invalid.`, "INVALID_ONBOARDING_STATE");
  return normalized;
}

function assertFields(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`, "INVALID_ONBOARDING_INPUT");
  }
  const unexpected = Object.keys(value).filter((field) => !allowed.includes(field));
  if (unexpected.length) {
    const secretLike = unexpected.some((field) => /password|token|credential|api.?key|secret|username/i.test(field));
    fail(
      `${label} contains unsupported fields: ${unexpected.sort().join(", ")}`,
      secretLike ? "ONBOARDING_SECRET_VALUE_REJECTED" : "UNSUPPORTED_ONBOARDING_FIELD",
    );
  }
}

function withIdentity(payload, prefix, idField, hashField) {
  const hash = onboardingDigest(onboardingCanonicalJson(payload));
  return { ...payload, [idField]: `${prefix}-${hash.slice(0, 24)}`, [hashField]: hash };
}

function verifyIdentity(document, { prefix, idField, hashField, label }) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    fail(`${label} is invalid.`, "INVALID_ONBOARDING_ARTIFACT");
  }
  const payload = { ...document };
  delete payload[idField];
  delete payload[hashField];
  const hash = onboardingDigest(onboardingCanonicalJson(payload));
  if (document[hashField] !== hash || document[idField] !== `${prefix}-${hash.slice(0, 24)}`) {
    fail(`${label} digest verification failed.`, "ONBOARDING_DIGEST_MISMATCH");
  }
  return document;
}

function secretReferenceNames(value) {
  const source = value == null ? {} : value;
  assertFields(source, ["username", "password"], "GraphDB secretReferenceNames");
  const result = {};
  for (const field of ["username", "password"]) {
    if (source[field] == null) continue;
    const name = requiredText(source[field], `GraphDB secretReferenceNames.${field}`);
    if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(name)) {
      fail(
        `GraphDB secretReferenceNames.${field} must be an environment-style reference name, not a credential value.`,
        "INVALID_ONBOARDING_SECRET_REFERENCE",
      );
    }
    if (new Set([
      "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH",
      "GODEBUG", "GOTRACEBACK",
    ]).has(name)) {
      fail(
        `GraphDB secretReferenceNames.${field} cannot name a child-process control variable.`,
        "INVALID_ONBOARDING_SECRET_REFERENCE",
      );
    }
    result[field] = name;
  }
  if (Object.keys(result).length !== 2) {
    fail("GraphDB username and password secret-reference names are required together.", "INVALID_ONBOARDING_SECRET_REFERENCE");
  }
  return result;
}

export function buildStorageSelection({ projectId, selection = null } = {}, storage) {
  const format = formatForVerifiedOwner(storage);
  const normalizedProjectId = requiredText(projectId, "projectId");
  const source = selection == null ? { mode: "local" } : selection;
  assertFields(source, ["mode", "endpoint", "database", "secretReferenceNames"], "Storage selection");
  const mode = requiredText(source.mode || "local", "Storage selection mode").toLowerCase();
  if (!new Set(["local", "graphdb"]).has(mode)) {
    fail("Storage selection mode must be local or graphdb.", "INVALID_ONBOARDING_STORAGE_MODE");
  }
  let graphdb = null;
  if (mode === "local") {
    if (source.endpoint != null || source.database != null || source.secretReferenceNames != null) {
      fail("Local storage selection cannot contain GraphDB configuration.", "INVALID_ONBOARDING_STORAGE_SELECTION");
    }
  } else {
    const endpoint = requiredText(source.endpoint, "GraphDB endpoint");
    let parsed;
    try { parsed = new URL(endpoint); }
    catch { fail("GraphDB endpoint must be an absolute HTTP or HTTPS URL.", "INVALID_ONBOARDING_GRAPHDB_ENDPOINT"); }
    if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      fail(
        "GraphDB endpoint must use HTTP(S) and cannot embed credentials, query parameters, or fragments.",
        parsed.username || parsed.password ? "ONBOARDING_SECRET_VALUE_REJECTED" : "INVALID_ONBOARDING_GRAPHDB_ENDPOINT",
      );
    }
    const database = requiredText(source.database, "GraphDB database");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(database)) {
      fail("GraphDB database name is invalid.", "INVALID_ONBOARDING_GRAPHDB_DATABASE");
    }
    graphdb = {
      endpoint: parsed.toString().replace(/\/$/, ""),
      database,
      secretReferenceNames: secretReferenceNames(source.secretReferenceNames),
      capabilityStatus: "pending-unverified-adapter",
    };
  }
  return withIdentity({
    schemaVersion: 1,
    kind: "OnboardingStorageSelection",
    protocol: { name: format.protocol("head-agent-core-onboarding-storage"), version: ONBOARDING_PROTOCOL_VERSION },
    projectId: normalizedProjectId,
    mode,
    local: {
      adapterKind: "local-json",
      authority: "derived-evidence-only",
      rebuildable: true,
      uniqueAuthority: false,
    },
    graphdb,
    localFallback: true,
    credentialValuesPersisted: false,
    instructionAuthority: false,
    promotionAuthority: false,
  }, "onboarding-storage", "storageSelectionId", "storageSelectionHash");
}

export function verifyStorageSelection(document, projectId = "", storage) {
  const verified = verifyIdentity(document, {
    prefix: "onboarding-storage",
    idField: "storageSelectionId",
    hashField: "storageSelectionHash",
    label: "Onboarding storage selection",
  });
  if (projectId && verified.projectId !== projectId) {
    fail("Onboarding storage selection belongs to another project.", "ONBOARDING_PROJECT_MISMATCH");
  }
  const format = familyFormatForOriginal("head-agent-core-onboarding-storage", verified, storage);
  if (!format) fail("Onboarding storage selection fields are invalid.", "INVALID_ONBOARDING_STORAGE_SELECTION");
  const rebuilt = buildStorageSelection({
    projectId: verified.projectId,
    selection: verified.mode === "local" ? { mode: "local" } : {
      mode: "graphdb",
      endpoint: verified.graphdb?.endpoint,
      database: verified.graphdb?.database,
      secretReferenceNames: verified.graphdb?.secretReferenceNames,
    },
  }, format);
  if (onboardingCanonicalJson(rebuilt) !== onboardingCanonicalJson(verified)) {
    fail("Onboarding storage selection fields are invalid.", "INVALID_ONBOARDING_STORAGE_SELECTION");
  }
  return verified;
}

export function buildSessionRecord({ project, sessionState } = {}, storage) {
  const format = formatForVerifiedOwner(storage);
  if (!project || typeof project !== "object" || !sessionState || typeof sessionState !== "object") {
    fail("Project and session state are required.", "INVALID_ONBOARDING_SESSION");
  }
  return withIdentity({
    schemaVersion: 1,
    kind: format.kind("HeadSession"),
    protocol: { name: format.protocol("head-agent-core-session"), version: ONBOARDING_PROTOCOL_VERSION },
    projectId: requiredText(project.projectId, "project.projectId"),
    sessionId: requiredText(sessionState.sessionId, "sessionState.sessionId"),
    createdAt: optionalText(project.createdAt || sessionState.updatedAt, "Session createdAt"),
    providerReferences: [],
    identityBoundary: format.value("project-scoped-head-session-not-provider-conversation"),
    instructionAuthority: false,
    promotionAuthority: false,
  }, "session-record", "sessionRecordId", "sessionRecordHash");
}

export function verifySessionRecord(document, { projectId = "", sessionId = "", storage } = {}) {
  const verified = verifyIdentity(document, {
    prefix: "session-record",
    idField: "sessionRecordId",
    hashField: "sessionRecordHash",
    label: "HEAD Session record",
  });
  if ((projectId && verified.projectId !== projectId) || (sessionId && verified.sessionId !== sessionId)) {
    fail("HEAD Session record identity does not match current project state.", "ONBOARDING_SESSION_MISMATCH");
  }
  const format = familyFormatForOriginal("head-agent-core-session", verified, storage);
  if (!format) fail("HEAD Session record fields are invalid.", "INVALID_ONBOARDING_SESSION");
  const rebuilt = buildSessionRecord({
    project: { projectId: verified.projectId, createdAt: verified.createdAt },
    sessionState: { sessionId: verified.sessionId },
  }, format);
  if (onboardingCanonicalJson(rebuilt) !== onboardingCanonicalJson(verified)) {
    fail("HEAD Session record fields are invalid.", "INVALID_ONBOARDING_SESSION");
  }
  return verified;
}

function buildOnboardingStateDocument({
  projectId,
  sessionId,
  phase = "initialized",
  stateRevision = 0,
  storageSelectionId,
  worldModelId = null,
  sourceSnapshotId = null,
  candidateSetId = null,
  latestReviewDecisionId = null,
  productModelId = null,
  previousProductModelId = null,
  migration = "native",
  updatedAt,
} = {}, { protocolVersion, reviewField, storage }) {
  const format = formatForVerifiedOwner(storage);
  const normalizedPhase = requiredText(phase, "Onboarding phase");
  if (!PHASES.has(normalizedPhase)) fail("Onboarding phase is invalid.", "INVALID_ONBOARDING_PHASE");
  if (!Number.isInteger(stateRevision) || stateRevision < 0) fail("Onboarding stateRevision is invalid.", "INVALID_ONBOARDING_STATE");
  const payload = {
    schemaVersion: 1,
    kind: "OnboardingStatePointer",
    protocol: { name: format.protocol("head-agent-core-onboarding"), version: protocolVersion },
    projectId: requiredIdentity(projectId, new RegExp(`^${format.projectPrefix}[a-f0-9]{20}$`), "projectId"),
    sessionId: requiredIdentity(sessionId, /^session-[A-Fa-f0-9-]{36}$/, "sessionId"),
    phase: normalizedPhase,
    stateRevision,
    storageSelectionId: requiredIdentity(storageSelectionId, /^onboarding-storage-[a-f0-9]{24}$/, "storageSelectionId"),
    worldModelId: optionalIdentity(worldModelId, /^world-model-[a-f0-9]{24}$/, "worldModelId"),
    sourceSnapshotId: optionalIdentity(sourceSnapshotId, /^source-snapshot-[a-f0-9]{24}$/, "sourceSnapshotId"),
    candidateSetId: optionalIdentity(candidateSetId, /^onboarding-candidates-[a-f0-9]{24}$/, "candidateSetId"),
    [reviewField]: optionalIdentity(latestReviewDecisionId, /^onboarding-review-decision-[a-f0-9]{24}$/, reviewField),
    productModelId: optionalIdentity(productModelId, /^product-model-[a-f0-9]{24}$/, "productModelId"),
    previousProductModelId: optionalIdentity(previousProductModelId, /^product-model-[a-f0-9]{24}$/, "previousProductModelId"),
    migration: requiredText(migration, "migration"),
    updatedAt: requiredText(updatedAt, "updatedAt"),
  };
  const pointerHash = onboardingDigest(onboardingCanonicalJson(payload));
  return { ...payload, pointerHash };
}

export function buildOnboardingState(input = {}, storage) {
  return buildOnboardingStateDocument(input, {
    protocolVersion: ONBOARDING_STATE_PROTOCOL_VERSION,
    reviewField: "latestReviewDecisionId",
    storage,
  });
}

export function onboardingStateLatestReviewDecisionId(document = {}) {
  if (Object.hasOwn(document, "reviewDecisionId")) {
    fail("Retired onboarding state requires the standalone legacy migrator.", "ONBOARDING_LEGACY_STATE_REQUIRES_MIGRATOR");
  }
  return document.latestReviewDecisionId ?? null;
}

export function verifyOnboardingState(document, { projectId = "", sessionId = "", storage } = {}) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    fail("Onboarding state pointer is invalid.", "INVALID_ONBOARDING_STATE");
  }
  const payload = { ...document };
  delete payload.pointerHash;
  if (document.pointerHash !== onboardingDigest(onboardingCanonicalJson(payload))) {
    fail("Onboarding state pointer digest verification failed.", "ONBOARDING_STATE_DIGEST_MISMATCH");
  }
  if (!PHASES.has(document.phase) || !Number.isInteger(document.stateRevision) || document.stateRevision < 0) {
    fail("Onboarding state pointer fields are invalid.", "INVALID_ONBOARDING_STATE");
  }
  if ((projectId && document.projectId !== projectId) || (sessionId && document.sessionId !== sessionId)) {
    fail("Onboarding state pointer identity does not match current project state.", "ONBOARDING_STATE_IDENTITY_MISMATCH");
  }
  const format = familyFormatForOriginal("head-agent-core-onboarding", document, storage);
  const stateVersion = format ? document.protocol.version : "";
  if (stateVersion !== ONBOARDING_STATE_PROTOCOL_VERSION) {
    fail("Unsupported onboarding state requires an explicit standalone migration or recovery operation.", stateVersion === ONBOARDING_PROTOCOL_VERSION
      ? "ONBOARDING_LEGACY_STATE_REQUIRES_MIGRATOR" : "INVALID_ONBOARDING_STATE");
  }
  const stateInput = {
    projectId: document.projectId,
    sessionId: document.sessionId,
    phase: document.phase,
    stateRevision: document.stateRevision,
    storageSelectionId: document.storageSelectionId,
    worldModelId: document.worldModelId,
    sourceSnapshotId: document.sourceSnapshotId,
    candidateSetId: document.candidateSetId,
    latestReviewDecisionId: onboardingStateLatestReviewDecisionId(document),
    productModelId: document.productModelId,
    previousProductModelId: document.previousProductModelId,
    migration: document.migration,
    updatedAt: document.updatedAt,
  };
  const rebuilt = buildOnboardingState(stateInput, format);
  if (onboardingCanonicalJson(rebuilt) !== onboardingCanonicalJson(document)) {
    fail("Onboarding state pointer fields are invalid.", "INVALID_ONBOARDING_STATE");
  }
  return document;
}

export function initialOnboardingDocuments({ project, sessionState, productModelId, updatedAt, storage: inputStorage } = {}, storage = inputStorage) {
  const sessionRecord = buildSessionRecord({ project, sessionState }, storage);
  const storageSelection = buildStorageSelection({ projectId: project.projectId, selection: { mode: "local" } }, storage);
  const state = buildOnboardingState({
    projectId: project.projectId,
    sessionId: sessionState.sessionId,
    phase: "initialized",
    stateRevision: 0,
    storageSelectionId: storageSelection.storageSelectionId,
    productModelId,
    migration: "native",
    updatedAt,
  }, storage);
  return { sessionRecord, storageSelection, state };
}
