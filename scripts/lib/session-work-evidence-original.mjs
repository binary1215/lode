import { familyFormatForOriginal } from "./project-storage-format.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { verifyArtifactAuthorityBoundary } from "./authority-plane-contract.mjs";
import { safeSessionPath } from "./session-paths.mjs";
import { verifyProductModelRevisionForProjection, verifyDocumentChangeProductModelRevision } from "./product-model-revision-verification.mjs";

// Shared exact original verifier. No Session selection, scan, index or writes.
export const SESSION_WORK_CONTEXT_VERSION = "0.1.0";
export const PROTOCOL = { name: "head-agent-core-session-work-evidence", version: SESSION_WORK_CONTEXT_VERSION };
export const MAX_RECORD_BYTES = 64 * 1024;
export const MAX_REFERENCE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_SCAN = 512;
export const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const encoded = (value) => JSON.stringify(canonical(value));
export function fail(message, code = "INVALID_SESSION_WORK_EVIDENCE") { throw Object.assign(new Error(message), { code }); }
function object(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.includes(key))) fail(`Invalid ${label} fields.`);
}
function text(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be non-empty text.`);
  return value.trim();
}
function list(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  return value.map((item) => text(item, label));
}
function relative(value) {
  const name = text(value, "Reference path").replaceAll("\\", "/");
  if (path.isAbsolute(name) || /^[A-Za-z]:/.test(name) || name.split("/").some((part) => !part || part === "." || part === "..")) {
    fail("Reference path must stay inside the exact Project.", "SESSION_WORK_REFERENCE_ESCAPE");
  }
  return name;
}
function exactEvidence(value) {
  object(value, ["evidenceId", "evidenceDigest"], "exact work evidence");
  if (!/^work-evidence-[a-f0-9]{24}$/.test(value.evidenceId || "") || !/^[a-f0-9]{64}$/.test(value.evidenceDigest || "")) fail("An exact work evidence selector needs its original identity and evidence digest.");
  return { evidenceId: value.evidenceId, evidenceDigest: value.evidenceDigest };
}
export const sameEvidence = (a, b) => a?.evidenceId === b?.evidenceId && a?.evidenceDigest === b?.evidenceDigest;
export const sessionTodoDeclarations = content => (content.todos || []).map(todo => ({ todoId: todo.todoId, status: todo.status,
  ...(todo.prior ? { prior: todo.prior } : {}), ...(todo.resolves ? { resolves: todo.resolves } : {}) }));
export function normalizeSessionWorkEvidence(input) {
  object(input, ["summary", "judgments", "observedWork", "pending", "unknowns", "suggestedFollowUp", "references", "occurrenceKey", "workLink", "executionObservation", "workTopics", "todos"], "work evidence");
  if (input.judgments !== undefined && !Array.isArray(input.judgments)) fail("Judgments must be an array.");
  if (input.references !== undefined && !Array.isArray(input.references)) fail("References must be an array.");
  const content = {
    summary: input.summary === undefined ? null : text(input.summary, "Summary"),
    judgments: (input.judgments || []).map((item) => {
      object(item, ["assessment", "reason", "alternatives"], "judgment");
      return { assessment: text(item.assessment, "Assessment"), reason: text(item.reason, "Reason"), alternatives: list(item.alternatives, "Alternatives") };
    }),
    observedWork: list(input.observedWork, "Observed work"),
    pending: list(input.pending, "Pending work"),
    unknowns: list(input.unknowns, "Unknowns"),
    suggestedFollowUp: list(input.suggestedFollowUp, "Suggested follow-up"),
    references: (input.references || []).map((item) => {
      object(item, ["path", "digest", "kind"], "reference");
      if (!/^[a-f0-9]{64}$/.test(item.digest || "") || !["source", "artifact"].includes(item.kind)) fail("Reference needs exact SHA-256 and source/artifact kind.");
      return { path: relative(item.path), digest: item.digest, kind: item.kind };
    }),
    // Optional HEAD-owned event distinction. Reusing text is not proof that a
    // new observation happened. No user ID or timestamp form is required.
    occurrenceKey: input.occurrenceKey === undefined ? null : text(input.occurrenceKey, "Occurrence key"),
  };
  // Absent extensions remain absent: legacy normalized bytes and identities do
  // not change. These selectors name saved notes, never execution attempts.
  if (input.workTopics !== undefined) content.workTopics = list(input.workTopics, "Work topics");
  if (input.workLink !== undefined) {
    object(input.workLink, ["root", "predecessor"], "work link");
    content.workLink = { root: exactEvidence(input.workLink.root), predecessor: exactEvidence(input.workLink.predecessor) };
  }
  if (input.executionObservation !== undefined) {
    object(input.executionObservation, ["state", "target"], "execution observation");
    if (!["running", "paused", "ended", "unknown"].includes(input.executionObservation.state)) fail("Invalid saved observation state.");
    content.executionObservation = { state: input.executionObservation.state,
      ...(input.executionObservation.target !== undefined ? { target: exactEvidence(input.executionObservation.target) } : {}) };
  }
  if (input.todos !== undefined) {
    if (!Array.isArray(input.todos) || !input.todos.length) fail("Todos must contain explicit work revisions.");
    const ids = new Set();
    content.todos = input.todos.map(item => {
      object(item, ["todoId", "task", "status", "nextAction", "reason", "progress", "priority", "origin", "prior", "resolves", "relatedEvidence"], "Todo revision");
      if (!/^todo-[a-z0-9][a-z0-9-]{0,79}$/.test(item.todoId || "") || ids.has(item.todoId)) fail("Use a distinct stable Todo ID per item in this record.");
      ids.add(item.todoId);
      if (!["pending", "partial", "waiting", "completed", "cancelled"].includes(item.status)
        || !["user-directed", "head-proposed"].includes(item.origin)) fail("Todo needs explicit status and recorded attribution.");
      const todo = { todoId: item.todoId, task: text(item.task, "Todo task"), status: item.status, origin: item.origin };
      for (const field of ["nextAction", "reason", "progress", "priority"]) if (item[field] !== undefined) todo[field] = text(item[field], "Todo " + field);
      if (["pending", "partial", "waiting"].includes(item.status) && !todo.nextAction) fail("An unresolved Todo needs its next action.");
      if (["waiting", "cancelled"].includes(item.status) && !todo.reason) fail("Waiting or cancellation needs its recorded reason.");
      if (item.prior !== undefined) todo.prior = exactEvidence(item.prior);
      for (const field of ["resolves", "relatedEvidence"]) if (item[field] !== undefined) {
        if (!Array.isArray(item[field])) fail("Todo exact references must be an array.");
        todo[field] = item[field].map(exactEvidence);
      }
      return todo;
    });
  }
  if (!content.summary && !content.judgments.length && !content.observedWork.length && !content.pending.length
    && !content.unknowns.length && !content.suggestedFollowUp.length && !content.references.length && !content.executionObservation && !content.todos?.length) fail("Select some meaningful work evidence.");
  if (Buffer.byteLength(encoded(content)) > MAX_RECORD_BYTES - 4096) fail("Selected work evidence exceeds the record bound; retain exact references or separate meaningful segments.", "SESSION_WORK_EVIDENCE_TOO_LARGE");
  return content;
}
export const SESSION_WORK_DEFAULT_CHARACTERS = 32768;
export const SESSION_WORK_MAX_CHARACTERS = 512 * 1024;
const observedReadContexts = new WeakMap();
export function createSessionWorkReadContext(root, storage = undefined) {
  const files = new Map(); let retainedBytes = 0;
  const observe = (relative, maximum) => {
    if (!files.has(relative)) {
      try {
        const file = safeSessionPath(root, relative), stat = fs.lstatSync(file);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size > maximum) {
          throw Object.assign(new Error("Work input exceeds this reader's bound."), { code: "SESSION_WORK_REFERENCE_UNAVAILABLE", requestBoundOnly: true });
        }
        if (!stat.isFile() || stat.isSymbolicLink()) {
          fail("Work input exceeds its existing read bounds.", "SESSION_WORK_REFERENCE_UNAVAILABLE");
        }
        const bytes = fs.readFileSync(file);
        if (bytes.length > maximum) {
          throw Object.assign(new Error("Work input exceeds its existing read bounds."), { code: "SESSION_WORK_REFERENCE_UNAVAILABLE", requestBoundOnly: true });
        }
        // Retention is an optimization, never an additional evidence/read gate.
        if (retainedBytes + bytes.length > 128 * 1024 * 1024) return { bytes };
        retainedBytes += bytes.length; files.set(relative, { bytes });
      } catch (error) { if (error.requestBoundOnly) throw error; files.set(relative, { error }); }
    }
    const result = files.get(relative);
    if (result.error) throw result.error;
    if (result.bytes.length > maximum) fail("Work input exceeds its existing read bounds.", "SESSION_WORK_REFERENCE_UNAVAILABLE");
    return result;
  };
  // Keep retained observations private. A caller may alter its returned Buffer
  // without changing another consumer's source or a memoized byte digest.
  const read = (relative, maximum) => Buffer.from(observe(relative, maximum).bytes);
  const context = { storage, read };
  observedReadContexts.set(context, { root, read, observe });
  return context;
}

// Internal byte observation, not a typed verdict or a currentness receipt.
// Only the unchanged owned context can reuse this pure digest. The original
// retention fallback still observes and hashes new bytes on each read.
export function readSessionWorkFileObservation(root, relative, maximum, context = null, { preflight = true, includeBytes = true } = {}) {
  // Match the caller's existing observation boundary: reference inspection did
  // preflight paths, while graph currentness used context.read directly.
  if (preflight && context) safeSessionPath(root, relative);
  const owned = context && observedReadContexts.get(context);
  if (owned && owned.root === root && context.read === owned.read) {
    const observed = owned.observe(relative, maximum);
    observed.digest ??= sha(observed.bytes);
    return { ...(includeBytes ? { bytes: Buffer.from(observed.bytes) } : {}), digest: observed.digest };
  }
  const bytes = context ? context.read(relative, maximum) : readSessionWorkFileBytes(root, relative, maximum);
  return { ...(includeBytes ? { bytes } : {}), digest: sha(bytes) };
}

export function sessionWorkPath(relative) {
  const match = /^(\.(?:head|lode)\/sessions(?:\/by-id\/(session-[a-fA-F0-9-]{36}))?)\/work-evidence\/(work-evidence-[a-f0-9]{24})\.json$/.exec(relative);
  return match ? { sessionId: match[2] || null, evidenceId: match[3], statePath: match[1] + "/current.json", directory: match[1] + "/work-evidence" } : null;
}
export function verifySessionWorkEvidenceOwner({ root, projectBytes, stateBytes, storage }) {
  const project = JSON.parse(projectBytes), state = JSON.parse(stateBytes);
  if (project.schemaVersion !== 1 || project.projectRoot !== root || typeof project.projectId !== "string"
    || !/^session-[a-fA-F0-9-]{36}$/.test(state.sessionId || "") || state.projectId && state.projectId !== project.projectId) {
    fail("Work evidence Project/Session identity differs.", "HEAD_SESSION_IDENTITY_MISMATCH");
  }
  return { root, storage, projectId: project.projectId, sessionId: state.sessionId, state, basis: sha(Buffer.concat([projectBytes, stateBytes])) };
}
export function inputIdentity(owner, content) { return sha(encoded({ projectId: owner.projectId, sessionId: owner.sessionId, content })); }
export function readSessionWorkFileBytes(root, relative, maximum, context = null) {
  const file = safeSessionPath(root, relative);
  if (context) return context.read(relative, maximum);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) fail("Reference bytes unavailable within bounds.", "SESSION_WORK_REFERENCE_UNAVAILABLE");
  const bytes = fs.readFileSync(file);
  if (bytes.length > maximum) fail("Reference bytes unavailable within bounds.", "SESSION_WORK_REFERENCE_UNAVAILABLE");
  return bytes;
}
export function verifySessionWorkEvidenceOriginal({ owner, evidenceId, bytes }) {
  if (bytes.length > MAX_RECORD_BYTES) fail("Unsafe or oversized work evidence.");
  const record = JSON.parse(bytes.toString("utf8"));
  object(record, ["schemaVersion", "kind", "subtype", "protocol", "projectId", "sessionId", "content", "recordedAt", "authorityBoundary", "evidenceId", "evidenceDigest"], "work original");
  const { evidenceDigest, ...payload } = record;
  const format = familyFormatForOriginal(PROTOCOL.name, record, owner.storage);
  const content = normalizeSessionWorkEvidence(Object.fromEntries(Object.entries(record.content || {}).filter(([, value]) => value !== null)));
  if (record.schemaVersion !== 1 || record.kind !== "Evidence" || record.subtype !== "SessionWorkEvidence"
    || !format || encoded(record.protocol) !== encoded({ ...PROTOCOL, name: format.protocol(PROTOCOL.name) }) || encoded(content) !== encoded(record.content)
    || record.projectId !== owner.projectId || record.sessionId !== owner.sessionId
    || record.evidenceId !== evidenceId || evidenceId !== `work-evidence-${inputIdentity(owner, content).slice(0, 24)}`
    || evidenceDigest !== sha(encoded(payload)) || !Number.isFinite(Date.parse(record.recordedAt))) {
    fail("Work evidence integrity or owner mismatch.", "SESSION_WORK_EVIDENCE_INTEGRITY");
  }
  verifyArtifactAuthorityBoundary("Evidence", record.authorityBoundary);
  return record;
}
export function readSessionWorkEvidenceOriginalFile(owner, evidenceId, context = null) {
  if (!/^work-evidence-[a-f0-9]{24}$/.test(evidenceId || "")) fail("Invalid work evidence identity.");
  const relative = owner.workDirectory + "/" + evidenceId + ".json";
  const bytes = readSessionWorkFileBytes(owner.root, relative, MAX_RECORD_BYTES, context);
  return { record: verifySessionWorkEvidenceOriginal({ owner, evidenceId, bytes }), bytes };
}
export function inspectSessionWorkReference(owner, ref, { saving = false, excerptCharacters = 0, proof = null, context = null } = {}) {
  try {
    if (proof && !excerptCharacters) {
      if (proof.error) throw proof.error;
      if (proof.byteDigest !== ref.digest) fail("Reference bytes changed.", "SESSION_WORK_REFERENCE_CHANGED");
      return { ...ref, status: "intact-retained-original", originalOwner: { projectId: owner.projectId, sessionId: owner.sessionId },
        semanticFreshness: "not-inferred", instructionAuthority: false, recoveryAuthority: false };
    }
    const { bytes, digest } = readSessionWorkFileObservation(owner.root, ref.path, MAX_REFERENCE_BYTES, context, { includeBytes: ref.kind === "artifact" || excerptCharacters > 0 });
    if (digest !== ref.digest) fail("Reference bytes changed.", "SESSION_WORK_REFERENCE_CHANGED");
    let originalOwner = null;
    if (ref.kind === "artifact") {
      const artifact = JSON.parse(bytes.toString("utf8"));
      if (artifact.projectId !== owner.projectId) fail("Referenced artifact belongs to another Project.", "SESSION_WORK_REFERENCE_PROJECT_MISMATCH");
      if (artifact.kind === "ProductModelRevision") {
        if (artifact.authority === "user-owned-project-canon-revision") {
          const fields = new Set(["schemaVersion", "kind", "projectId", "productModelId", "productModelHash", "document", "authority"]);
          if (Object.keys(artifact).some(key => !fields.has(key))) fail("Unsupported Product revision shape.", "SESSION_WORK_REFERENCE_UNSUPPORTED_PRODUCT_REVISION");
          verifyProductModelRevisionForProjection(artifact, owner.storage);
        } else if (artifact.authority === "explicit-user-reviewed-product-canon-revision") {
          verifyDocumentChangeProductModelRevision(artifact, owner.projectId, owner.storage);
        } else fail("Unsupported Product revision family.", "SESSION_WORK_REFERENCE_UNSUPPORTED_PRODUCT_REVISION");
      }
      originalOwner = { projectId: artifact.projectId, sessionId: artifact.sessionId || null };
    }
    const body = excerptCharacters ? bytes.toString("utf8") : "";
    return { ...ref, status: ref.kind === "artifact" ? "intact-retained-original" : "matching-current-bytes",
      originalOwner, ...(excerptCharacters ? { excerpt: body.slice(0, excerptCharacters), omittedCharacters: Math.max(0, body.length - excerptCharacters) } : {}),
      semanticFreshness: "not-inferred", instructionAuthority: false, recoveryAuthority: false };
  } catch (error) {
    if (saving) throw error;
    return { ...ref, status: "unavailable", reasonCode: error.code || "INVALID_REFERENCE", contentReconstructed: false };
  }
}

