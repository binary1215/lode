import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
const sessionIdOf = record => {
  const format = familyFormatForOriginal({ sessionIdentity: true }, record);
  return format ? record?.[format.sessionIdField] : undefined;
};
const originalFormat = record => familyFormatForOriginal({ kind: record?.kind }, record);
import crypto from "node:crypto";
import path from "node:path";
import { artifactAuthorityBoundary, verifyArtifactAuthorityBoundary } from "./authority-plane-contract.mjs";
import { restoreSessionFromArtifacts } from "./session-recovery.mjs";

export const RUNTIME_SESSION_CONTINUATION_VERSION = "0.1.0";

const fail = (message, code = "RUNTIME_SESSION_CONTINUATION_ERROR") => {
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

const canonicalJson = (value) => JSON.stringify(canonical(value));
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function runtimeName(value) {
  const runtime = String(value || "").trim().toLowerCase();
  if (!new Set(["claude", "codex", "opencode"]).has(runtime)) fail("Runtime continuation requires claude, codex, or opencode.", "INVALID_RUNTIME_CONTINUATION_RUNTIME");
  return runtime;
}

function identify(payload) {
  const continuationOutcomeHash = digest(canonicalJson(payload));
  return {
    ...payload,
    continuationOutcomeId: `continuation-outcome-${continuationOutcomeHash.slice(0, 24)}`,
    continuationOutcomeHash,
  };
}

export function verifyContinuationOutcome(document) {
  const format = familyFormatForOriginal("head-agent-core-runtime-session-continuation", document);
  const fields = [
    "schemaVersion", "kind", "protocol", "authorityBoundary", "projectId", (format?.sessionIdField || "headSessionId"), "runtime",
    "status", "disclosure", "checkpointId", "sessionRestoreId", "attachmentVerified", "attachmentRole",
    "providerSessionIdentityPersisted", "providerSessionIdentityCanonical", "providerTranscriptUsed",
    "providerSummaryUsed", "p2RestoredBeforeAttachment", "p2DirectionChanged", "persisted",
    "recoveryAuthority", "instructionAuthority", "reviewAuthority", "promotionAuthority", "mutatesCanon",
    "continuationOutcomeId", "continuationOutcomeHash",
  ];
  if (!document || typeof document !== "object" || Array.isArray(document)
    || canonicalJson(Object.keys(document).sort()) !== canonicalJson([...fields].sort())) {
    fail("ContinuationOutcome fields are invalid.", "INVALID_CONTINUATION_OUTCOME");
  }
  verifyArtifactAuthorityBoundary("ContinuationOutcome", document.authorityBoundary);
  const payload = { ...document };
  delete payload.continuationOutcomeId;
  delete payload.continuationOutcomeHash;
  const expected = identify(payload);
  if (document.schemaVersion !== 1 || document.kind !== "ContinuationOutcome"
    || !format || document.protocol?.name !== format.protocol("head-agent-core-runtime-session-continuation")
    || document.protocol?.version !== RUNTIME_SESSION_CONTINUATION_VERSION
    || !new RegExp(`^${format?.projectPrefix || "head-"}[a-f0-9]{20}$`).test(document.projectId || "")
    || !/^session-[A-Fa-f0-9-]{36}$/.test(sessionIdOf(document) || "")
    || document.runtime !== runtimeName(document.runtime)
    || !new Set(["attached", "fresh-logical-head"]).has(document.status)
    || !new Set(["exact-live-provider-attachment", "provider-attachment-not-requested", "provider-attachment-unavailable"]).has(document.disclosure)
    || !/^checkpoint-[a-f0-9]{24}$/.test(document.checkpointId || "")
    || !/^session-restore-[a-f0-9]{24}$/.test(document.sessionRestoreId || "")
    || document.attachmentVerified !== (document.status === "attached")
    || document.attachmentRole !== (document.status === "attached" ? "head" : null)
    || document.providerSessionIdentityPersisted !== false || document.providerSessionIdentityCanonical !== false
    || document.providerTranscriptUsed !== false || document.providerSummaryUsed !== false
    || document.p2RestoredBeforeAttachment !== true || document.p2DirectionChanged !== false
    || document.persisted !== false || document.recoveryAuthority !== false || document.instructionAuthority !== false
    || document.reviewAuthority !== false || document.promotionAuthority !== false || document.mutatesCanon !== false
    || document.continuationOutcomeId !== expected.continuationOutcomeId
    || document.continuationOutcomeHash !== expected.continuationOutcomeHash) {
    fail("ContinuationOutcome violates the P2-first optional P5 boundary.", "INVALID_CONTINUATION_OUTCOME");
  }
  return document;
}

export function continueSessionFromArtifacts({
  root = ".", checkpointId = null, runtime, hostAttachment = null, attachmentRequested = false,
  workspaceHostAdapter = null, storage,
} = {}) {
  const selectedRuntime = runtimeName(runtime);
  const before = restoreSessionFromArtifacts({ root, checkpointId });
  const format = storage == null
    ? familyFormatForOriginal("head-agent-core-artifact-session-restore", before.projection)
    : formatForVerifiedOwner(storage);
  let attachment = null;
  let status = "fresh-logical-head";
  let disclosure = attachmentRequested ? "provider-attachment-unavailable" : "provider-attachment-not-requested";
  if (hostAttachment !== null) {
    attachment = hostAttachment;
    if (attachment.role !== "head" || attachment.runtime !== selectedRuntime) {
      fail("The live attachment is not the exact HEAD runtime requested for continuation.", "RUNTIME_CONTINUATION_ATTACHMENT_CONFLICT");
    }
    if (workspaceHostAdapter !== null) {
      const received = workspaceHostAdapter.receive({ attachment, boundary: {
        projectId: before.projection.projectId, [format.sessionIdField]: before.projection.sessionId,
        role: "head", projectRoot: path.resolve(root),
      } });
      if (received.status === "attached") {
        status = "attached";
        disclosure = "exact-live-provider-attachment";
      } else {
        disclosure = "provider-attachment-unavailable";
      }
    } else disclosure = "provider-attachment-unavailable";
  }
  const after = restoreSessionFromArtifacts({ root, checkpointId: before.checkpoint.checkpointId });
  if (after.projection.sessionRestoreId !== before.projection.sessionRestoreId
    || after.projection.sessionRestoreHash !== before.projection.sessionRestoreHash
    || after.checkpoint.checkpointId !== before.checkpoint.checkpointId) {
    fail("Provider continuation changed the canonical P2 recovery projection.", "RUNTIME_CONTINUATION_P2_DRIFT");
  }
  const outcome = verifyContinuationOutcome(identify({
    schemaVersion: 1,
    kind: "ContinuationOutcome",
    protocol: { name: format.protocol("head-agent-core-runtime-session-continuation"), version: RUNTIME_SESSION_CONTINUATION_VERSION },
    authorityBoundary: artifactAuthorityBoundary("ContinuationOutcome"),
    projectId: before.projection.projectId,
    [format.sessionIdField]: before.projection.sessionId,
    runtime: selectedRuntime,
    status,
    disclosure,
    checkpointId: before.checkpoint.checkpointId,
    sessionRestoreId: before.projection.sessionRestoreId,
    attachmentVerified: status === "attached",
    attachmentRole: status === "attached" ? attachment.role : null,
    providerSessionIdentityPersisted: false,
    providerSessionIdentityCanonical: false,
    providerTranscriptUsed: false,
    providerSummaryUsed: false,
    p2RestoredBeforeAttachment: true,
    p2DirectionChanged: false,
    persisted: false,
    recoveryAuthority: false,
    instructionAuthority: false,
    reviewAuthority: false,
    promotionAuthority: false,
    mutatesCanon: false,
  }));
  return {
    status: status === "attached" ? "session_continued_with_live_attachment" : "session_continued_with_fresh_logical_head",
    restore: before,
    continuationOutcome: outcome,
  };
}
