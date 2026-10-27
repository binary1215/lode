import { formatForVerifiedOwner, familyFormatForOriginal, resolveProjectStorage } from "./project-storage-format.mjs";
const sessionIdOf = record => {
  const format = familyFormatForOriginal({ sessionIdentity: true }, record);
  return format ? record?.[format.sessionIdField] : undefined;
};
const originalFormat = record => familyFormatForOriginal({ kind: record?.kind }, record);
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteArtifact } from "./artifact-storage.mjs";
import { withProjectMutation } from "./project-mutation-lock.mjs";
import { resolveRuntimeOperationalStateRoot } from "./runtime-execution-lease.mjs";
import { createSessionCallContext, safeSessionPath, withSessionCallContext, sessionSelectionUnresolved } from "./session-routing.mjs";
import { defaultSessionStatePath } from "./session-paths.mjs";
import { enterConversationRecovery } from "./compaction-lifecycle.mjs";

export const SESSION_HOST_ADAPTER_VERSION = "0.1.0";
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const encode = (value) => JSON.stringify(value);
function fail(message, code = "INVALID_SESSION_HOST_INPUT") { throw Object.assign(new Error(message), { code }); }
function required(value) { return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/.test(value); }
function project(root) {
  const base = fs.realpathSync(path.resolve(root));
  const storage = resolveProjectStorage(base);
  const format = formatForVerifiedOwner(storage);
  const record = JSON.parse(fs.readFileSync(safeSessionPath(base, format.directory, "project.json"), "utf8"));
  if (record.schemaVersion !== 1 || record.projectRoot !== base || !new RegExp(`^${format.projectPrefix}[a-f0-9]{20}$`).test(record.projectId || "")) fail("Project identity differs.", "PROJECT_IDENTITY_MISMATCH");
  return { root: base, projectId: record.projectId, storage };
}

// Trusted Host composition API, deliberately NOT a public MCP native-ID input.
// The embedding Host must obtain the actual per-request caller. Stock Codex
// Pre/PostToolUse parent session_id alone cannot do that for child agents.
export function createSessionHostAdapter({ runtime, nativeSessionId, agentId = null, environment = process.env,
  platform = process.platform, homeDirectory, deadlineAt = null } = {}) {
  if (!["codex", "claude", "opencode"].includes(runtime) || !required(nativeSessionId) || agentId !== null && !required(agentId)) fail("A verified runtime/caller identity is required.");
  if (deadlineAt !== null && !Number.isSafeInteger(deadlineAt)) fail("Invalid optional Host deadline.");
  const checkDeadline = () => { if (deadlineAt !== null && Date.now() >= deadlineAt) fail("Optional Host linkage deadline elapsed.", "HOST_BINDING_DEADLINE"); };
  const bindingMutation = (owner, operation) => {
    checkDeadline();
    return withProjectMutation({ root: owner.root, scope: "host-session-binding",
      ...(deadlineAt !== null ? { timeoutMs: Math.max(0, deadlineAt - Date.now()) } : {}) }, () => {
      checkDeadline(); return operation();
    });
  };
  const callerDigest = sha(encode([runtime, nativeSessionId, agentId]));
  const locallyUnconfirmed = new Set();
  const selectionTickets = new WeakMap();
  const pendingTickets = new Map();
  function location(owner, create = false) {
    const operationalRoot = resolveRuntimeOperationalStateRoot({ projectRoot: owner.root, storage: owner.storage, environment, platform, homeDirectory, create });
    const parts = ["session-bindings", sha(encode([owner.projectId, owner.root, callerDigest]))];
    let current = operationalRoot;
    for (const part of parts) {
      current = path.join(current, part);
      if (fs.existsSync(current)) {
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Unsafe Host binding directory.", "UNSAFE_SESSION_HOST_BINDING");
      }
    }
    const file = path.join(current, "binding.json");
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) fail("Unsafe Host binding file.", "UNSAFE_SESSION_HOST_BINDING");
    }
    if (create) fs.mkdirSync(current, { recursive: true });
    return file;
  }
  function readOwner(owner) {
    const file = location(owner);
    if (!fs.existsSync(file)) {
      if (fs.existsSync(path.dirname(file))) fail("Previously created Host binding is missing.", "SESSION_HOST_BINDING_MISSING");
      return { status: "absent", revision: 0, authorityPlane: "P5", retained: false };
    }
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    const { bindingDigest, ...payload } = record;
    const fields = ["kind", "version", "authorityPlane", "projectId", "callerDigest", "status", "sessionId", "revision",
      "previousDigest", "recoveryAuthority", "instructionAuthority", "bindingDigest"];
    if (Object.keys(record).length !== fields.length || Object.keys(record).some((key) => !fields.includes(key))
      || record.kind !== "HostSessionBinding" || record.version !== SESSION_HOST_ADAPTER_VERSION || record.authorityPlane !== "P5"
      || record.projectId !== owner.projectId || record.callerDigest !== callerDigest || !["bound", "default", "pending", "lost"].includes(record.status)
      || record.recoveryAuthority !== false || record.instructionAuthority !== false
      || !Number.isSafeInteger(record.revision) || record.revision < 1 || bindingDigest !== sha(encode(payload))
      || record.status === "lost" && record.sessionId !== null
      || record.status !== "lost" && !/^session-[A-Fa-f0-9-]{36}$/.test(record.sessionId || "")
      || record.previousDigest !== null && !/^[a-f0-9]{64}$/.test(record.previousDigest)) {
      fail("Host binding is corrupt or belongs to another caller/Project.", "SESSION_HOST_BINDING_INTEGRITY");
    }
    return record;
  }
  const write = (owner, payload) => {
    checkDeadline();
    const record = { ...payload, bindingDigest: sha(encode(payload)) };
    const file = location(owner, true);
    location(owner); // recheck newly created namespace before atomic publication
    checkDeadline();
    atomicWriteArtifact(file, encode(record) + "\n");
    return record;
  };
  const payloadOf = (record) => { const { bindingDigest, ...payload } = record; return payload; };
  const ticketKey = (owner, record) => encode([owner.root, record.bindingDigest]);
  function selectionOutcome(state, status, extra = {}) {
    return { status, projectId: state.owner.projectId, sessionId: state.selected.sessionId,
      retained: status === "host_selection_retained", persisted: status === "host_selection_retained" ? true : "unconfirmed",
      currentExplicitRequestsAllowed: true, ordinaryWorkBlocked: false, executionReplayAllowed: false,
      recoveryAuthority: false, ...extra };
  }
  // Split the existing P5 pending/commit publication around an already validated
  // selection operation. The opaque ticket is local ownership, not permission.
  function prepareSelection({ root = ".", sessionId, expectedRevision, expectedBindingDigest } = {}) {
    const owner = project(root);
    const context = createSessionCallContext();
    const selected = context.select(owner.root, sessionId);
    const state = { owner, selected, context, before: null, pending: null, previousTicket: null, outcome: null, preparationError: null };
    const ticket = Object.freeze({}); selectionTickets.set(ticket, state);
    try {
      bindingMutation(owner, () => {
        if (project(owner.root).projectId !== owner.projectId) fail("Project changed before Host selection.", "PROJECT_IDENTITY_MISMATCH");
        const before = readOwner(owner); state.before = before;
        if (before.status === "absent") {
          try { state.previousDefault = createSessionCallContext().select(owner.root, ""); }
          catch (error) {
            // Only the unrelated absent/malformed default may be unavailable.
            // Without that predecessor, settlement must not guess a rollback.
            if (error.headSessionRecordPath !== defaultSessionStatePath(owner.root, owner.storage)) throw error;
          }
        }
        if (expectedRevision != null && before.revision !== expectedRevision) fail("Host selection changed.", "SESSION_HOST_BINDING_CONFLICT");
        if (expectedBindingDigest !== undefined && (before.bindingDigest || null) !== expectedBindingDigest) fail("Host selection basis changed.", "SESSION_HOST_BINDING_CONFLICT");
        if (["bound", "default"].includes(before.status) && before.sessionId === selected.sessionId) return;
        state.previousTicket = pendingTickets.get(ticketKey(owner, before)) || null;
        const payload = { kind: "HostSessionBinding", version: SESSION_HOST_ADAPTER_VERSION, authorityPlane: "P5",
          projectId: owner.projectId, callerDigest, status: "pending", sessionId: selected.sessionId,
          revision: before.revision + 1, previousDigest: before.bindingDigest || null,
          recoveryAuthority: false, instructionAuthority: false };
        state.pending = write(owner, payload);
        pendingTickets.set(ticketKey(owner, state.pending), state);
      });
    } catch (error) { state.preparationError = error.code || "HOST_BINDING_STORAGE_ERROR"; }
    return { ticket, context, sessionId: selected.sessionId, prepared: !state.preparationError,
      ...(state.preparationError ? { reasonCode: state.preparationError } : {}) };
  }
  function settleSelection({ ticket, outcome } = {}) {
    const state = selectionTickets.get(ticket);
    if (!state || !["succeeded", "not-started", "uncertain"].includes(outcome)) fail("Expected an owned selection ticket and proven outcome.");
    if (state.outcome) {
      if (state.outcome !== outcome) fail("Selection settlement retry differs.", "SESSION_HOST_SETTLEMENT_CONFLICT");
      return state.result;
    }
    state.outcome = outcome;
    const { owner, selected } = state;
    try {
      state.result = bindingMutation(owner, () => {
        if (project(owner.root).projectId !== owner.projectId) fail("Project changed before Host settlement.", "PROJECT_IDENTITY_MISMATCH");
        const current = readOwner(owner);
        if (state.preparationError) {
          if (state.preparationError === "SESSION_HOST_BINDING_CONFLICT") return selectionOutcome(state, "host_selection_superseded", { reasonCode: "NEWER_SELECTION_INTENT" });
          // An unchanged failed preparation with no effect does not lose a good
          // route. Success/unknown without durable intent cannot claim linkage.
          if (outcome !== "not-started" && current.bindingDigest === state.before?.bindingDigest) locallyUnconfirmed.add(owner.root);
          return selectionOutcome(state, "host_selection_not_retained", { reasonCode: state.preparationError });
        }
        if (!state.pending) {
          if (current.bindingDigest !== state.before?.bindingDigest) return selectionOutcome(state, "host_selection_superseded", { reasonCode: "NEWER_SELECTION_INTENT" });
          locallyUnconfirmed.delete(owner.root);
          return selectionOutcome(state, "host_selection_retained", { binding: current });
        }
        if (current.bindingDigest !== state.pending.bindingDigest) {
          return selectionOutcome(state, "host_selection_superseded", { reasonCode: "NEWER_SELECTION_INTENT" });
        }
        if (outcome === "uncertain") return selectionOutcome(state, "host_selection_not_retained", { reasonCode: "SELECTION_OUTCOME_UNCERTAIN" });
        if (outcome === "succeeded") {
          const binding = write(owner, { ...payloadOf(current), status: selected.status });
          locallyUnconfirmed.delete(owner.root);
          return selectionOutcome(state, "host_selection_retained", { binding });
        }
        // Only a trusted, proven pre-effect failure can restore its exact prior
        // choice. A concurrent pending predecessor needs live owned evidence.
        let previous = state.before;
        let previousDefault = state.previousDefault;
        let predecessor = state.previousTicket;
        if (previous.status === "pending") {
          if (!predecessor || predecessor.outcome === "uncertain" || predecessor.preparationError) {
            return selectionOutcome(state, "host_selection_not_retained", { reasonCode: "PRIOR_SELECTION_UNCERTAIN" });
          }
          if (predecessor.outcome === "succeeded") previous = { ...previous, status: predecessor.selected.status };
          else if (predecessor.outcome === "not-started") {
            // Walk only owned proven failures, not historical guesses. A live
            // predecessor can then settle against the restored monotonic CAS.
            while (previous.status === "pending" && predecessor?.outcome === "not-started") {
              previousDefault = predecessor.previousDefault || previousDefault;
              previous = predecessor.before;
              predecessor = predecessor.previousTicket;
            }
            if (previous.status === "pending" && (!predecessor || predecessor.outcome === "uncertain")) {
              return selectionOutcome(state, "host_selection_not_retained", { reasonCode: "PRIOR_SELECTION_UNCERTAIN" });
            }
            if (previous.status === "pending" && predecessor.outcome === "succeeded") previous = { ...previous, status: predecessor.selected.status };
          }
        }
        if (previous.status === "absent") {
          // Before this attempt, absent meant the verified existing default.
          // Preserve that exact prior route, not a new inferred selection.
          const prior = previousDefault || state.previousTicket?.previousDefault;
          if (!prior) return selectionOutcome(state, "host_selection_not_retained", { reasonCode: "PRIOR_SELECTION_UNCERTAIN" });
          createSessionCallContext().select(owner.root, prior.sessionId);
          previous = { ...payloadOf(current), status: prior.status, sessionId: prior.sessionId };
        }
        const binding = write(owner, { ...payloadOf(previous), revision: current.revision + 1, previousDigest: current.bindingDigest });
        if (binding.status === "pending" && predecessor && !predecessor.outcome) {
          pendingTickets.delete(ticketKey(owner, predecessor.pending));
          predecessor.pending = binding;
          pendingTickets.set(ticketKey(owner, binding), predecessor);
        }
        return selectionOutcome(state, "host_selection_cancelled", { binding, persisted: true, reasonCode: "PROVEN_PRE_EFFECT_FAILURE" });
      });
    } catch (error) {
      // Do not turn a successful Core effect into failure or replay it.
      locallyUnconfirmed.add(owner.root);
      state.result = selectionOutcome(state, "host_selection_not_retained", { reasonCode: error.code || "HOST_BINDING_STORAGE_ERROR" });
    } finally {
      if (state.pending) pendingTickets.delete(ticketKey(owner, state.pending));
    }
    return state.result;
  }
  function selection({ root = ".", sessionId = undefined, expectedRevision, lost = false } = {}) {
    const owner = project(root);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !lost && sessionId === undefined) fail("Explicit selection needs its observed binding revision.");
    // Validate the declared canonical selection before P5 publication; provider
    // handles, names and timestamps never select a logical Session.
    const selected = lost ? null : createSessionCallContext().select(owner.root, sessionId);
    try {
      const binding = bindingMutation(owner, () => {
        if (project(owner.root).projectId !== owner.projectId) fail("Project changed before Host selection.", "PROJECT_IDENTITY_MISMATCH");
        const before = readOwner(owner);
        const targetStatus = lost ? "lost" : selected.status;
        if (before.status === targetStatus && before.sessionId === (selected?.sessionId || null)
          && [before.revision, before.revision - 1].includes(expectedRevision)) return before;
        const interrupted = before.status === "pending" && before.sessionId === selected?.sessionId
          && expectedRevision === before.revision - 1;
        if (!interrupted && before.revision !== expectedRevision) fail("Host selection changed; reconcile only this selection.", "SESSION_HOST_BINDING_CONFLICT");
        const payload = {
          kind: "HostSessionBinding", version: SESSION_HOST_ADAPTER_VERSION, authorityPlane: "P5",
          projectId: owner.projectId, callerDigest, status: targetStatus, sessionId: selected?.sessionId || null,
          revision: interrupted ? before.revision : before.revision + 1,
          previousDigest: interrupted ? before.previousDigest : before.bindingDigest || null,
          recoveryAuthority: false, instructionAuthority: false,
        };
        // Only a declared selection change gets this pending P5 state. A crash
        // between intent and commit leaves known loss, never the old/default
        // route. Retrying performs persistence only, never a task/tool effect.
        if (!lost && !interrupted) write(owner, { ...payload, status: "pending" });
        return write(owner, payload);
      });
      locallyUnconfirmed.delete(owner.root);
      return { status: "host_selection_retained", projectId: owner.projectId, sessionId: binding.sessionId,
        binding, retained: true, persisted: true, recoveryAuthority: false, executionReplayAllowed: false };
    } catch (error) {
      locallyUnconfirmed.add(owner.root);
      return { status: "host_selection_not_retained", projectId: owner.projectId, sessionId: selected?.sessionId || null,
        retained: false, persisted: "unconfirmed", reasonCode: error.code || "HOST_BINDING_STORAGE_ERROR",
        currentExplicitRequestsAllowed: true, ordinaryWorkBlocked: false, executionReplayAllowed: false,
        nextHeadAction: "Keep the current explicit request result. Repair only optional Host linkage; do not repeat completed effects. Across restart, only the last durably confirmed state or pending loss can be known." };
    }
  }
  function contextFor(projectRoot, { allowAbsentDefault = false, onBindingRead = null } = {}) {
    const owner = project(projectRoot), context = createSessionCallContext();
    const binding = readOwner(owner);
    if (onBindingRead) onBindingRead(binding);
    if (locallyUnconfirmed.has(owner.root)) { context.lose(owner.root); return context; }
    if (binding.status === "absent" && allowAbsentDefault) return context;
    if (["bound", "default"].includes(binding.status)) context.select(owner.root, binding.sessionId);
    else context.lose(owner.root);
    return context;
  }
  return Object.freeze({
    describe: () => ({ adapterKey: "head.session-host", version: SESSION_HOST_ADAPTER_VERSION, authorityPlane: "P5",
      nativeIdentitySource: "trusted-embedding-host-per-request-caller", providerIdentityInCanon: false,
      recoveryAuthority: false, instructionAuthority: false, stockMcpNativeIdentityAssumed: false }),
    read({ root = "." } = {}) { checkDeadline(); return readOwner(project(root)); },
    prepareSelection,
    settleSelection,
    select: (options) => selection(options),
    lose: (options) => selection({ ...options, lost: true }),
    resolveSessionContext(request, options = {}) {
      const outer = request?.params?.arguments;
      const args = ["head_tools_read", "head_tools_call", "lode_tools_read", "lode_tools_call"].includes(request?.params?.name) ? outer?.arguments : outer;
      if (!args?.project_root) fail("Expected an exact Project-scoped MCP request.");
      return contextFor(args.project_root, options);
    },
    enter({ root = "." } = {}) {
      try {
        const context = contextFor(root);
        return withSessionCallContext({ root, context }, () => enterConversationRecovery({ root }));
      } catch (error) {
        // Same narrow Project-only path as MCP; no default Session is inspected
        // and then hidden. A damaged common original remains an error.
        return sessionSelectionUnresolved(root, { includeProjectFacts: true, reasonCode: error.code || "HOST_BINDING_UNAVAILABLE" });
      }
    },
  });
}
