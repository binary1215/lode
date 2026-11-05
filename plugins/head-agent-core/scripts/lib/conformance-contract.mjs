import crypto from "node:crypto";
import { SCHEMA_VERSION } from "./lode-core.mjs";
import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
import { artifactAuthorityBoundary, verifyArtifactAuthorityBoundary } from "./authority-plane-contract.mjs";

export const CONFORMANCE_PROTOCOL_VERSION = "0.1.0";
export const CONFORMANCE_CLAIM_KINDS = Object.freeze(["potential-conflict", "possible-conformance-gap"]);
export const CONFORMANCE_RISK_HINTS = Object.freeze(["unknown", "low", "medium", "high"]);
export const CONFORMANCE_DISPOSITIONS = Object.freeze([
  "acknowledge", "defer", "dismiss", "request-code-fix", "request-canon-revision", "accept-resolution",
]);
export const CONFORMANCE_DISCLOSURES = Object.freeze([
  "graph-unavailable", "graph-not-used", "observation-coverage-partial", "optional-source-unavailable",
  "evidence-coverage-unknown", "direct-source-anchor-used",
]);

const fail = (message, code = "CONFORMANCE_CONTRACT_ERROR") => { const error = new Error(message); error.code = code; throw error; };

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function conformanceCanonicalJson(value) { return JSON.stringify(canonical(value)); }
export function conformanceDigest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

function exactFields(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`, "INVALID_CONFORMANCE_ARTIFACT");
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) fail(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}.`, "INVALID_CONFORMANCE_ARTIFACT");
}

function text(value, label, max = 8192, { optional = false } = {}) {
  if (value == null && optional) return "";
  if (typeof value !== "string" || (!optional && !value.trim()) || Buffer.byteLength(value, "utf8") > max) fail(`${label} must be a bounded string.`, "INVALID_CONFORMANCE_ARTIFACT");
  return value.trim();
}

function stableKey(value, label, max = 192) {
  const normalized = text(value, label, max);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) fail(`${label} must be a stable key.`, "INVALID_CONFORMANCE_ARTIFACT");
  return normalized;
}

function digest(value, label) {
  if (!/^[a-f0-9]{64}$/.test(value || "")) fail(`${label} must be a SHA-256 digest.`, "INVALID_CONFORMANCE_ARTIFACT");
  return value;
}

function identity(document, prefix, idField, hashField) {
  const payload = { ...document }; delete payload[idField]; delete payload[hashField];
  const hash = conformanceDigest(conformanceCanonicalJson(payload));
  return { ...document, [idField]: `${prefix}-${hash.slice(0, 24)}`, [hashField]: hash };
}

function verifyIdentity(document, prefix, idField, hashField, label) {
  const payload = { ...document }; delete payload[idField]; delete payload[hashField];
  const hash = conformanceDigest(conformanceCanonicalJson(payload));
  if (document[hashField] !== hash || document[idField] !== `${prefix}-${hash.slice(0, 24)}`) fail(`${label} digest verification failed.`, "CONFORMANCE_DIGEST_MISMATCH");
}

function authorityValid(document, authority) {
  return document.authority === authority && document.instructionAuthority === false && document.promotionAuthority === false
    && document.mutatesCanon === false && document.recoveryAuthority === false && document.blocksOrdinaryWork === false;
}

function normalizeBaseline(value) {
  exactFields(value, ["productModelId", "productModelHash", "worldModelId", "worldModelHash", "sourceSnapshotId", "graphSnapshotId"], "Conformance baseline");
  const nullableId = (item, expression, label) => {
    if (item == null) return null;
    if (!expression.test(item)) fail(`${label} is invalid.`, "INVALID_CONFORMANCE_BASELINE");
    return item;
  };
  const worldModelId = nullableId(value.worldModelId, /^world-model-[a-f0-9]{24}$/, "Conformance worldModelId");
  const worldModelHash = value.worldModelHash == null ? null : digest(value.worldModelHash, "Conformance worldModelHash");
  const sourceSnapshotId = nullableId(value.sourceSnapshotId, /^source-snapshot-[a-f0-9]{24}$/, "Conformance sourceSnapshotId");
  const graphSnapshotId = nullableId(value.graphSnapshotId, /^graph-snapshot-[a-f0-9]{24}$/, "Conformance graphSnapshotId");
  if ([worldModelId, worldModelHash, sourceSnapshotId, graphSnapshotId].some((item) => item !== null)
    && [worldModelId, worldModelHash, sourceSnapshotId, graphSnapshotId].some((item) => item === null)) fail("Conformance World baseline must be complete or absent.", "INVALID_CONFORMANCE_BASELINE");
  return {
    productModelId: text(value.productModelId, "Conformance productModelId", 96),
    productModelHash: digest(value.productModelHash, "Conformance productModelHash"),
    worldModelId,
    worldModelHash,
    sourceSnapshotId,
    graphSnapshotId,
  };
}

export function normalizeCanonAnchor(value) {
  exactFields(value, ["entityKind", "entityKey"], "Conformance Canon anchor");
  const entityKind = text(value.entityKind, "Conformance Canon entityKind", 32);
  if (!new Set(["FeatureGroup", "Capability", "Feature", "Requirement", "Constraint", "Decision", "Policy"]).has(entityKind)) fail("Conformance Canon entityKind is invalid.", "INVALID_CONFORMANCE_CANON_ANCHOR");
  return { entityKind, entityKey: stableKey(value.entityKey, "Conformance Canon entityKey", 128) };
}

export function normalizeConformanceEvidenceAnchor(value) {
  exactFields(value, ["kind", "path", "fileDigest", "startLine", "endLine", "excerptDigest", "revisionId", "symbolId", "changeSetId", "changeSetHash", "changeId", "observationId", "observationHash", "graphSnapshotId", "nodeId"], "Conformance evidence anchor");
  const kind = text(value.kind, "Conformance evidence kind", 32);
  if (kind === "source") {
    const startLine = value.startLine == null ? null : Number(value.startLine);
    const endLine = value.endLine == null ? null : Number(value.endLine);
    if ((startLine === null) !== (endLine === null) || startLine !== null && (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine - startLine > 400)) fail("Conformance source line range is invalid.", "INVALID_CONFORMANCE_SOURCE_ANCHOR");
    if ((startLine === null) !== (value.excerptDigest == null)) fail("Conformance source excerpt digest must accompany its line range.", "INVALID_CONFORMANCE_SOURCE_ANCHOR");
    return { kind, path: text(value.path, "Conformance source path", 1024), fileDigest: digest(value.fileDigest, "Conformance fileDigest"), startLine, endLine, excerptDigest: value.excerptDigest == null ? null : digest(value.excerptDigest, "Conformance excerptDigest"), revisionId: value.revisionId == null ? null : text(value.revisionId, "Conformance revisionId", 128), symbolId: value.symbolId == null ? null : text(value.symbolId, "Conformance symbolId", 128) };
  }
  if (kind === "change") return { kind, changeSetId: text(value.changeSetId, "Conformance changeSetId", 96), changeSetHash: digest(value.changeSetHash, "Conformance changeSetHash"), changeId: text(value.changeId, "Conformance changeId", 96) };
  if (kind === "observation") return { kind, observationId: text(value.observationId, "Conformance observationId", 96), observationHash: digest(value.observationHash, "Conformance observationHash") };
  if (kind === "graph") return { kind, graphSnapshotId: text(value.graphSnapshotId, "Conformance graphSnapshotId", 96), nodeId: text(value.nodeId, "Conformance graph nodeId", 192) };
  fail("Conformance evidence kind is invalid.", "INVALID_CONFORMANCE_EVIDENCE_ANCHOR");
}

function normalizeDisclosures(values) {
  if (!Array.isArray(values)) fail("Conformance disclosures must be an array.", "INVALID_CONFORMANCE_DISCLOSURE");
  const normalized = [...new Set(values.map((value) => text(value, "Conformance disclosure", 96)))].sort();
  if (normalized.some((value) => !CONFORMANCE_DISCLOSURES.includes(value))) fail("Conformance disclosure is invalid.", "INVALID_CONFORMANCE_DISCLOSURE");
  return normalized;
}

export function createConformanceFindingCandidate({ projectId, sessionId, baseline, canonAnchor, evidenceAnchors, claim, disclosures = [] } = {}, storage) {
  const format = formatForVerifiedOwner(storage);
  if (!Array.isArray(evidenceAnchors) || evidenceAnchors.length < 1 || evidenceAnchors.length > 64) fail("Conformance Finding requires one through 64 exact evidence anchors.", "INVALID_CONFORMANCE_EVIDENCE_COUNT");
  exactFields(claim, ["kind", "summary", "rationale", "riskHint"], "Conformance claim");
  const claimKind = text(claim.kind, "Conformance claim kind", 64);
  const riskHint = text(claim.riskHint || "unknown", "Conformance risk hint", 16);
  if (!CONFORMANCE_CLAIM_KINDS.includes(claimKind) || !CONFORMANCE_RISK_HINTS.includes(riskHint)) fail("Conformance claim kind or risk hint is invalid.", "INVALID_CONFORMANCE_CLAIM");
  const anchors = evidenceAnchors.map(normalizeConformanceEvidenceAnchor).sort((a, b) => conformanceCanonicalJson(a).localeCompare(conformanceCanonicalJson(b)));
  if (new Set(anchors.map(conformanceCanonicalJson)).size !== anchors.length) fail("Conformance Finding contains duplicate evidence anchors.", "DUPLICATE_CONFORMANCE_EVIDENCE");
  const normalizedBaseline = normalizeBaseline(baseline);
  const normalizedCanonAnchor = normalizeCanonAnchor(canonAnchor);
  const fingerprintHash = conformanceDigest(conformanceCanonicalJson({ projectId, baseline: normalizedBaseline, canonAnchor: normalizedCanonAnchor, evidenceAnchors: anchors, claimKind }));
  const body = {
    schemaVersion: SCHEMA_VERSION,
    kind: "ConformanceFindingCandidate",
    protocol: { name: format.protocol("head-agent-core-conformance-reconciliation"), version: CONFORMANCE_PROTOCOL_VERSION },
    projectId: text(projectId, "Conformance projectId", 256),
    sessionId: text(sessionId, "Conformance sessionId", 256),
    baseline: normalizedBaseline,
    canonAnchor: normalizedCanonAnchor,
    evidenceAnchors: anchors,
    fingerprintId: `conformance-fingerprint-${fingerprintHash.slice(0, 24)}`,
    fingerprintHash,
    claim: { kind: claimKind, summary: text(claim.summary, "Conformance claim summary", 2048), rationale: text(claim.rationale, "Conformance claim rationale", 8192), riskHint },
    disclosures: normalizeDisclosures(disclosures),
    epistemicClass: "inferred-meaning",
    authority: "non-authoritative-conformance-finding-candidate",
    authorityBoundary: artifactAuthorityBoundary("ConformanceFindingCandidate"),
    instructionAuthority: false,
    promotionAuthority: false,
    mutatesCanon: false,
    recoveryAuthority: false,
    blocksOrdinaryWork: false,
  };
  return verifyConformanceFindingCandidate(identity(body, "conformance-finding", "findingId", "findingHash"), projectId, storage);
}

export function verifyConformanceFindingCandidate(document, projectId = "", storage) {
  exactFields(document, ["schemaVersion", "kind", "protocol", "projectId", "sessionId", "baseline", "canonAnchor", "evidenceAnchors", "fingerprintId", "fingerprintHash", "claim", "disclosures", "epistemicClass", "authority", "authorityBoundary", "instructionAuthority", "promotionAuthority", "mutatesCanon", "recoveryAuthority", "blocksOrdinaryWork", "findingId", "findingHash"], "ConformanceFindingCandidate");
  exactFields(document.protocol, ["name", "version"], "ConformanceFindingCandidate protocol");
  const format = familyFormatForOriginal("head-agent-core-conformance-reconciliation", document, storage);
  verifyIdentity(document, "conformance-finding", "findingId", "findingHash", "ConformanceFindingCandidate");
  if (document.schemaVersion !== SCHEMA_VERSION || document.kind !== "ConformanceFindingCandidate"
    || !format || document.protocol?.version !== CONFORMANCE_PROTOCOL_VERSION
    || projectId && document.projectId !== projectId || document.epistemicClass !== "inferred-meaning"
    || !authorityValid(document, "non-authoritative-conformance-finding-candidate")) fail("ConformanceFindingCandidate fields or authority are invalid.", "INVALID_CONFORMANCE_FINDING");
  normalizeBaseline(document.baseline); normalizeCanonAnchor(document.canonAnchor);
  if (!Array.isArray(document.evidenceAnchors) || document.evidenceAnchors.length < 1 || document.evidenceAnchors.length > 64) fail("Conformance Finding evidence count is invalid.", "INVALID_CONFORMANCE_EVIDENCE_COUNT");
  const anchors = document.evidenceAnchors.map(normalizeConformanceEvidenceAnchor).sort((a, b) => conformanceCanonicalJson(a).localeCompare(conformanceCanonicalJson(b)));
  if (conformanceCanonicalJson(anchors) !== conformanceCanonicalJson(document.evidenceAnchors) || new Set(anchors.map(conformanceCanonicalJson)).size !== anchors.length) fail("Conformance Finding evidence normalization is invalid.", "INVALID_CONFORMANCE_EVIDENCE_ANCHOR");
  exactFields(document.claim, ["kind", "summary", "rationale", "riskHint"], "Conformance claim");
  if (!CONFORMANCE_CLAIM_KINDS.includes(document.claim.kind) || !CONFORMANCE_RISK_HINTS.includes(document.claim.riskHint)) fail("Conformance claim is invalid.", "INVALID_CONFORMANCE_CLAIM");
  const fingerprintHash = conformanceDigest(conformanceCanonicalJson({ projectId: document.projectId, baseline: document.baseline, canonAnchor: document.canonAnchor, evidenceAnchors: document.evidenceAnchors, claimKind: document.claim.kind }));
  if (document.fingerprintHash !== fingerprintHash || document.fingerprintId !== `conformance-fingerprint-${fingerprintHash.slice(0, 24)}`) fail("Conformance Finding fingerprint is invalid.", "INVALID_CONFORMANCE_FINGERPRINT");
  text(document.claim.summary, "Conformance claim summary", 2048); text(document.claim.rationale, "Conformance claim rationale", 8192);
  normalizeDisclosures(document.disclosures);
  verifyArtifactAuthorityBoundary("ConformanceFindingCandidate", document.authorityBoundary);
  return document;
}

export const HEAD_CONFORMANCE_MAINTENANCE_AUTHORITY = "head-maintenance-evidence-not-user-decision-or-execution-authority";
export const USER_CONFORMANCE_DISPOSITION_AUTHORITY = "user-disposition-evidence-not-canon-or-execution-authority";

export function createConformanceDispositionReceipt({ projectId, sessionId, finding, disposition, rationale, deferUntil = null, previousDisposition = null, resolution = null, actor = "user" } = {}, storage) {
  const format = formatForVerifiedOwner(storage);
  if (!["user", "head", "lode"].includes(actor)) fail("Conformance disposition actor is invalid.", "INVALID_CONFORMANCE_DISPOSITION");
  if (actor !== "user" && (!["acknowledge", "defer"].includes(disposition)
    || previousDisposition && previousDisposition.authority !== format.value(HEAD_CONFORMANCE_MAINTENANCE_AUTHORITY))) fail("HEAD may only acknowledge/defer without superseding a user disposition.", "CONFORMANCE_HEAD_MAINTENANCE_ONLY");
  const verified = verifyConformanceFindingCandidate(finding, projectId, storage);
  const normalizedDisposition = text(disposition, "Conformance disposition", 64);
  if (!CONFORMANCE_DISPOSITIONS.includes(normalizedDisposition)) fail("Conformance disposition is invalid.", "INVALID_CONFORMANCE_DISPOSITION");
  if (deferUntil != null && Number.isNaN(Date.parse(deferUntil))) fail("Conformance deferUntil is invalid.", "INVALID_CONFORMANCE_DISPOSITION");
  const normalizedDeferUntil = deferUntil == null ? null : new Date(deferUntil).toISOString();
  if (normalizedDisposition !== "defer" && normalizedDeferUntil !== null) fail("Conformance deferUntil is invalid.", "INVALID_CONFORMANCE_DISPOSITION");
  if (previousDisposition != null) verifyConformanceDispositionReceipt(previousDisposition, verified, projectId, storage);
  if (resolution != null) verifyConformanceResolutionCandidate(resolution, verified, projectId, storage);
  if ((normalizedDisposition === "accept-resolution") !== (resolution != null)) fail("accept-resolution requires one exact resolution candidate and no other disposition may carry one.", "INVALID_CONFORMANCE_DISPOSITION");
  const body = {
    schemaVersion: SCHEMA_VERSION,
    kind: "ConformanceDispositionReceipt",
    protocol: { name: format.protocol("head-agent-core-conformance-reconciliation"), version: CONFORMANCE_PROTOCOL_VERSION },
    projectId: text(projectId, "Conformance projectId", 256),
    sessionId: text(sessionId, "Conformance sessionId", 256),
    findingId: verified.findingId,
    findingHash: verified.findingHash,
    previousDispositionId: previousDisposition?.dispositionId || null,
    previousDispositionHash: previousDisposition?.dispositionHash || null,
    resolutionId: resolution?.resolutionId || null,
    resolutionHash: resolution?.resolutionHash || null,
    disposition: normalizedDisposition,
    rationale: text(rationale, "Conformance disposition rationale", 4096),
    deferUntil: normalizedDeferUntil,
    scope: "exact-finding-only",
    authority: actor !== "user" ? format.value(HEAD_CONFORMANCE_MAINTENANCE_AUTHORITY) : USER_CONFORMANCE_DISPOSITION_AUTHORITY,
    authorityBoundary: artifactAuthorityBoundary("ConformanceDispositionReceipt"),
    instructionAuthority: false,
    promotionAuthority: false,
    mutatesCanon: false,
    recoveryAuthority: false,
    blocksOrdinaryWork: false,
  };
  return verifyConformanceDispositionReceipt(identity(body, "conformance-disposition", "dispositionId", "dispositionHash"), verified, projectId, storage);
}

export function verifyConformanceDispositionReceipt(document, finding, projectId = "", storage) {
  exactFields(document, ["schemaVersion", "kind", "protocol", "projectId", "sessionId", "findingId", "findingHash", "previousDispositionId", "previousDispositionHash", "resolutionId", "resolutionHash", "disposition", "rationale", "deferUntil", "scope", "authority", "authorityBoundary", "instructionAuthority", "promotionAuthority", "mutatesCanon", "recoveryAuthority", "blocksOrdinaryWork", "dispositionId", "dispositionHash"], "ConformanceDispositionReceipt");
  exactFields(document.protocol, ["name", "version"], "ConformanceDispositionReceipt protocol");
  const format = familyFormatForOriginal("head-agent-core-conformance-reconciliation", document, storage);
  verifyIdentity(document, "conformance-disposition", "dispositionId", "dispositionHash", "ConformanceDispositionReceipt");
  const verified = verifyConformanceFindingCandidate(finding, projectId, storage);
  if (document.schemaVersion !== SCHEMA_VERSION || document.kind !== "ConformanceDispositionReceipt"
    || !format || document.protocol?.version !== CONFORMANCE_PROTOCOL_VERSION
    || document.protocol.name !== verified.protocol.name
    || projectId && document.projectId !== projectId || document.findingId !== verified.findingId || document.findingHash !== verified.findingHash
    || (document.previousDispositionId === null) !== (document.previousDispositionHash === null)
    || document.previousDispositionId != null && (!/^conformance-disposition-[a-f0-9]{24}$/.test(document.previousDispositionId) || !/^[a-f0-9]{64}$/.test(document.previousDispositionHash))
    || (document.resolutionId === null) !== (document.resolutionHash === null)
    || document.resolutionId != null && (!/^conformance-resolution-[a-f0-9]{24}$/.test(document.resolutionId) || !/^[a-f0-9]{64}$/.test(document.resolutionHash))
    || (document.disposition === "accept-resolution") !== (document.resolutionId !== null)
    || !CONFORMANCE_DISPOSITIONS.includes(document.disposition) || document.scope !== "exact-finding-only"
    || !(authorityValid(document, USER_CONFORMANCE_DISPOSITION_AUTHORITY)
      || authorityValid(document, format.value(HEAD_CONFORMANCE_MAINTENANCE_AUTHORITY)) && ["acknowledge", "defer"].includes(document.disposition))) fail("ConformanceDispositionReceipt fields or authority are invalid.", "INVALID_CONFORMANCE_DISPOSITION");
  text(document.rationale, "Conformance disposition rationale", 4096);
  if (document.deferUntil != null && Number.isNaN(Date.parse(document.deferUntil)) || document.disposition !== "defer" && document.deferUntil !== null) fail("Conformance disposition deferUntil is invalid.", "INVALID_CONFORMANCE_DISPOSITION");
  verifyArtifactAuthorityBoundary("ConformanceDispositionReceipt", document.authorityBoundary);
  return document;
}

export function createConformanceResolutionCandidate({ projectId, sessionId, finding, baseline, evidenceAnchors, assessment, rationale, disclosures = [] } = {}, storage) {
  const format = formatForVerifiedOwner(storage);
  const verified = verifyConformanceFindingCandidate(finding, projectId, storage);
  const normalizedAssessment = text(assessment, "Conformance resolution assessment", 32);
  if (!new Set(["appears-resolved", "still-present", "uncertain"]).has(normalizedAssessment)) fail("Conformance resolution assessment is invalid.", "INVALID_CONFORMANCE_RESOLUTION");
  if (!Array.isArray(evidenceAnchors) || evidenceAnchors.length < 1 || evidenceAnchors.length > 64) fail("Conformance resolution requires exact evidence.", "INVALID_CONFORMANCE_RESOLUTION");
  const anchors = evidenceAnchors.map(normalizeConformanceEvidenceAnchor).sort((a, b) => conformanceCanonicalJson(a).localeCompare(conformanceCanonicalJson(b)));
  if (new Set(anchors.map(conformanceCanonicalJson)).size !== anchors.length) fail("Conformance resolution contains duplicate evidence anchors.", "DUPLICATE_CONFORMANCE_EVIDENCE");
  const body = {
    schemaVersion: SCHEMA_VERSION,
    kind: "ConformanceResolutionCandidate",
    protocol: { name: format.protocol("head-agent-core-conformance-reconciliation"), version: CONFORMANCE_PROTOCOL_VERSION },
    projectId: text(projectId, "Conformance projectId", 256),
    sessionId: text(sessionId, "Conformance sessionId", 256),
    findingId: verified.findingId,
    findingHash: verified.findingHash,
    baseline: normalizeBaseline(baseline),
    evidenceAnchors: anchors,
    assessment: normalizedAssessment,
    rationale: text(rationale, "Conformance resolution rationale", 8192),
    disclosures: normalizeDisclosures(disclosures),
    epistemicClass: "inferred-meaning",
    authority: "non-authoritative-conformance-resolution-candidate",
    authorityBoundary: artifactAuthorityBoundary("ConformanceResolutionCandidate"),
    instructionAuthority: false,
    promotionAuthority: false,
    mutatesCanon: false,
    recoveryAuthority: false,
    blocksOrdinaryWork: false,
  };
  return verifyConformanceResolutionCandidate(identity(body, "conformance-resolution", "resolutionId", "resolutionHash"), verified, projectId, storage);
}

export function verifyConformanceResolutionCandidate(document, finding, projectId = "", storage) {
  exactFields(document, ["schemaVersion", "kind", "protocol", "projectId", "sessionId", "findingId", "findingHash", "baseline", "evidenceAnchors", "assessment", "rationale", "disclosures", "epistemicClass", "authority", "authorityBoundary", "instructionAuthority", "promotionAuthority", "mutatesCanon", "recoveryAuthority", "blocksOrdinaryWork", "resolutionId", "resolutionHash"], "ConformanceResolutionCandidate");
  exactFields(document.protocol, ["name", "version"], "ConformanceResolutionCandidate protocol");
  const format = familyFormatForOriginal("head-agent-core-conformance-reconciliation", document, storage);
  verifyIdentity(document, "conformance-resolution", "resolutionId", "resolutionHash", "ConformanceResolutionCandidate");
  const verified = verifyConformanceFindingCandidate(finding, projectId, storage);
  if (document.schemaVersion !== SCHEMA_VERSION || document.kind !== "ConformanceResolutionCandidate"
    || !format || document.protocol?.version !== CONFORMANCE_PROTOCOL_VERSION
    || document.protocol.name !== verified.protocol.name
    || projectId && document.projectId !== projectId || document.findingId !== verified.findingId || document.findingHash !== verified.findingHash
    || !new Set(["appears-resolved", "still-present", "uncertain"]).has(document.assessment)
    || document.epistemicClass !== "inferred-meaning" || !authorityValid(document, "non-authoritative-conformance-resolution-candidate")) fail("ConformanceResolutionCandidate fields or authority are invalid.", "INVALID_CONFORMANCE_RESOLUTION");
  normalizeBaseline(document.baseline);
  if (!Array.isArray(document.evidenceAnchors) || document.evidenceAnchors.length < 1 || document.evidenceAnchors.length > 64) fail("Conformance resolution evidence is invalid.", "INVALID_CONFORMANCE_RESOLUTION");
  const anchors = document.evidenceAnchors.map(normalizeConformanceEvidenceAnchor).sort((a, b) => conformanceCanonicalJson(a).localeCompare(conformanceCanonicalJson(b)));
  if (conformanceCanonicalJson(anchors) !== conformanceCanonicalJson(document.evidenceAnchors) || new Set(anchors.map(conformanceCanonicalJson)).size !== anchors.length) fail("Conformance resolution evidence normalization is invalid.", "INVALID_CONFORMANCE_RESOLUTION");
  text(document.rationale, "Conformance resolution rationale", 8192); normalizeDisclosures(document.disclosures);
  verifyArtifactAuthorityBoundary("ConformanceResolutionCandidate", document.authorityBoundary);
  return document;
}
