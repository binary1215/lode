import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveProjectStorage, formatForVerifiedOwner } from "./project-storage-format.mjs";
import { resolveOperation } from "./lode-operation-contract.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
import { withProjectMutation } from "./project-mutation-lock.mjs";
import { atomicCreateArtifact } from "./artifact-storage.mjs";
import { noteProjectGraphChange } from "./discovery-index.mjs";
import { safeSessionPath, defaultSessionStatePath } from "./session-paths.mjs";
export { safeSessionPath, defaultSessionStatePath } from "./session-paths.mjs";
import { readProjectDirectionView } from "./project-direction-view.mjs";
export { readProjectDirection, updateProjectDirection } from "./project-direction.mjs";

// Routing is request-local Host selection, never a persisted global selector.
const routes = new AsyncLocalStorage();
const callContexts = new WeakSet();
const fail = (message, code, recordPath = null) => { throw Object.assign(new Error(message), { code,
  ...(recordPath ? { headSessionRecordPath: recordPath } : {}) }); };
const canonicalRoot = (root) => fs.realpathSync(path.resolve(root || "."));
const validId = (id) => typeof id === "string" && /^session-[a-fA-F0-9-]{36}$/.test(id);

// Shared call boundary, not a permission or a read-only/effect classification.
// These CLI entries consume the same Project-only evidence as their MCP peers;
// unclassified CLI operations retain routing rather than guessing independence.
const independentCliInfo = new Set(["help", "--help", "-h", "help-all", "version", "--version"]);
const cliProjectCalls = new Map(Object.entries({
  "graph-query": "head_project_graph", "graph-index": "head_project_graph_index",
  "graph-explorer": "head_project_graph",
  "project-direction-read": "head_project_direction_read", "project-direction-update": "head_project_direction_update",
  "session-list": "head_session_list", "session-create": "head_session_create",
  "world-query": "head_world_query", "world-history": "head_git_history",
  "observation-sources": "head_observation_sources", "observation-read": "head_observation_read", "observation-query": "head_observation_query",
  "source-context": "head_source_context", "source-observation-read": "head_source_observation_read",
  "context-read": "head_context_capsule", "lineage-read": "head_lineage_artifact",
  "metric-status": "head_metric_status",
}));
const selectedSessionCalls = new Set(["head_project_initialize_or_resume", "head_project_status", "head_conversation_enter", "head_session_restore", "head_session_continue",
  "head_pending_review", "head_runtime_adapters", "head_runtime_state", "head_world_model", "head_context_prepare", "head_context_preview", "head_compaction_lifecycle_step",
  "head_continuity_snapshot", "head_product_operating_status", "head_session_work_record", "head_session_work_read"]);
export function sessionCallRequiresBinding(name, surface = "mcp") {
  if (surface === "cli") {
    if (independentCliInfo.has(name)) return false;
    const peer = cliProjectCalls.get(name);
    return peer ? sessionCallRequiresBinding(peer) : true;
  }
  name = resolveOperation(name)?.semanticName ?? name;
  return /^(head_checkpoint_|head_run_|head_runtime_invocation_|head_bounded_worker_|head_worker_integration|head_compact_)/u.test(name || "")
    || selectedSessionCalls.has(name);
}

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`Session record cannot be read: ${error.message}`, "INVALID_SESSION_CANON", file); }
}

export function assertRunSession(root, run, state) {
  // Historical Runs predate the explicit owner field; their original default
  // Session can still read/finish them, but a new Session cannot adopt them.
  const owner = run.sessionId || read(defaultSessionStatePath(root)).sessionId;
  if (owner !== state.sessionId) fail("Run belongs to another logical HEAD Session.", "RUN_SESSION_MISMATCH");
}

function selectedRoute(root) { return routes.getStore()?.get(canonicalRoot(root)) || null; }
function selectedId(root) { return selectedRoute(root)?.sessionId || null; }

// A trusted embedding Host owns one context per caller, not per Project or
// shared MCP process. No provider identity or selector is written into Canon.
export function createSessionCallContext() {
  const bindings = new Map();
  const context = Object.freeze({
    read(root) { return bindings.get(canonicalRoot(root)) || Object.freeze({ status: "unselected", revision: 0 }); },
    select(root, sessionId, expectedRevision = null) {
      const base = canonicalRoot(root), before = this.read(base);
      if (expectedRevision != null && before.revision !== expectedRevision) fail("Host Session binding changed.", "HEAD_SESSION_BINDING_CONFLICT");
      let selected = sessionId;
      if (sessionId == null || sessionId === "") {
        const file = defaultSessionStatePath(base, resolveProjectStorage(base)), state = read(file);
        if (!state || !validId(state.sessionId)) fail("Default Session has an invalid canonical identity.", "INVALID_SESSION_CANON", file);
        selected = state.sessionId;
      }
      const resolved = resolveSessionRoute(base, selected);
      const value = Object.freeze({ status: resolved.stateFile === defaultSessionStatePath(base, resolved.storage) ? "default" : "bound", sessionId: selected, revision: before.revision + 1 });
      bindings.set(base, value);
      return value;
    },
    lose(root) {
      const base = canonicalRoot(root), before = this.read(base);
      bindings.set(base, Object.freeze({ status: "lost", revision: before.revision + 1 }));
    },
  });
  callContexts.add(context);
  return context;
}

export function withSessionCallContext({ root, sessionId, context = null }, operation) {
  if (!context) return withSessionRoute(root, sessionId, operation);
  if (!callContexts.has(context)) fail("Expected a trusted caller-scoped Host context.", "INVALID_HEAD_SESSION_CALL_CONTEXT");
  const binding = sessionId !== undefined ? context.select(root, sessionId) : context.read(root);
  if (binding.status === "lost") fail("Selected logical Session was lost; do not silently substitute default.", "HEAD_SESSION_SELECTION_LOST");
  return withSessionRoute(root, binding.sessionId, operation);
}

export function sessionSelectionUnresolved(root, { includeProjectFacts = false, reasonCode = "HEAD_SESSION_SELECTION_LOST" } = {}) {
  // Do not inspect a default Session and redact it. These are the only original
  // records needed for the unavailable-selection response, including mixed reads.
  const storage = resolveProjectStorage(root);
  const projectFile = safeSessionPath(root, formatForVerifiedOwner(storage).directory, "project.json");
  if (!fs.existsSync(projectFile)) fail("Lode Agent Core is not initialized.", "NOT_INITIALIZED");
  const project = read(projectFile);
  if (project.schemaVersion !== 1 || project.projectRoot !== canonicalRoot(root)
    || typeof project.projectId !== "string" || !project.projectId) fail("Project identity differs.", "PROJECT_IDENTITY_MISMATCH");
  const directionView = readProjectDirectionView({ root });
  const { currentProjectDirection } = directionView;
  if (currentProjectDirection && currentProjectDirection.projectId !== project.projectId) fail("Project identity changed while reading its common direction.", "PROJECT_IDENTITY_MISMATCH");
  const unresolved = { status: "session_selection_unresolved", reasonCode,
    projectId: project.projectId, sessionId: null, sessionSelection: { status: "lost" },
    ordinaryWorkBlocked: false, recoveryDependentWorkBlocked: true,
    headActionRequired: true, userDecisionRequired: false,
    headActionScope: "selected-session-dependent-work-only",
    affectedOperations: ["selected-session-read", "selected-session-mutation"],
    nextHeadAction: "Continue independent Project/source work. Only for dependent work, use an already verified explicit logical Session or Host binding; ask only if a material selection remains ambiguous.",
    ...directionView, executionReplayAllowed: false,
    persisted: false, recoveryAuthority: false };
  if (!includeProjectFacts) return unresolved;
  return {
    ...unresolved,
    project: { projectId: project.projectId, projectRoot: project.projectRoot },
    availability: { project: "identity_verified", currentProjectDirection: directionView.currentProjectDirectionAvailability?.status || (currentProjectDirection ? "available" : "not_recorded"),
      session: "unavailable", run: "unavailable", recovery: "unavailable",
      managedProjectionDrift: "not_assessed", runtime: "not_assessed", product: "not_assessed" },
    nextAction: { id: "continue_independent_work", summary: unresolved.nextHeadAction },
    presentation: { mode: "exception", summary: "Independent work can continue. Selected Session, Run and recovery facts are unavailable; this is not a checkpoint failure or a recovery success.",
      headActionScope: unresolved.headActionScope, userActionRequired: false },
  };
}

export function sessionStatePath(root, storage) {
  const route = selectedRoute(root);
  storage ??= route?.storage;
  const defaultFile = defaultSessionStatePath(root, storage);
  if (!route) return defaultFile;
  const file = safeSessionPath(root, path.relative(canonicalRoot(root), route.stateFile));
  const state = read(file);
  const project = read(safeSessionPath(root, formatForVerifiedOwner(storage).directory, "project.json"));
  if (state.sessionId !== route.sessionId || project.projectId !== route.projectId
    || state.projectId && state.projectId !== route.projectId) fail("Selected logical Session identity changed during the request.", "HEAD_SESSION_IDENTITY_MISMATCH");
  return file;
}

// Immutable, content-addressed checkpoints/runs remain shared and identity-bound.
// Mutable epoch pointers and operational progress belong to the selected Session.
export function sessionDataPath(root, ...parts) {
  const route = selectedRoute(root);
  const storage = route?.storage;
  const state = sessionStatePath(root, storage);
  return state === defaultSessionStatePath(root, storage)
    ? safeSessionPath(root, formatForVerifiedOwner(storage).directory, "sessions", ...parts)
    : safeSessionPath(root, formatForVerifiedOwner(storage).directory, "sessions", "by-id", selectedId(root), ...parts);
}

function resolveSessionRoute(base, sessionId, preflightOwner = null) {
  const storage = preflightOwner?.storage ?? resolveProjectStorage(base);
  const directory = formatForVerifiedOwner(storage).directory;
  if (!validId(sessionId)) fail("Expected a logical HEAD Session id.", "INVALID_HEAD_SESSION_ID");
  const project = read(safeSessionPath(base, directory, "project.json"));
  if (project.schemaVersion !== 1 || !project.projectId || (preflightOwner
    ? JSON.stringify(project) !== JSON.stringify(preflightOwner.project) : project.projectRoot !== base)) fail("Project identity differs.", "PROJECT_IDENTITY_MISMATCH");
  const defaultFile = defaultSessionStatePath(base, storage);
  const namedFile = safeSessionPath(base, directory, "sessions", "by-id", sessionId, "current.json");
  const named = fs.existsSync(namedFile);
  let defaultState = null;
  if (named) {
    // A healthy default can establish an actual collision, but its unrelated
    // absence or malformed bytes cannot invalidate this exact named original.
    try { if (fs.existsSync(defaultFile)) defaultState = read(defaultFile); }
    catch (error) { if (error.code !== "INVALID_SESSION_CANON") throw error; }
    if (defaultState?.sessionId === sessionId) fail("Default and named Session identities collide.", "HEAD_SESSION_IDENTITY_MISMATCH", defaultFile);
  } else defaultState = read(defaultFile);
  const file = named ? namedFile : defaultState?.sessionId === sessionId ? defaultFile : namedFile;
  if (!fs.existsSync(file)) fail("Logical HEAD Session does not exist.", "HEAD_SESSION_NOT_FOUND");
  const state = read(file);
  if (!state || state.sessionId !== sessionId || (named ? state.projectId !== project.projectId : state.projectId && state.projectId !== project.projectId)) fail("Session identity does not match this Project.", "HEAD_SESSION_IDENTITY_MISMATCH", file);
  return { sessionId, stateFile: file, projectId: project.projectId, storage };
}

// Read-only input preflight for the explicit resume transaction. This does not
// establish a route, mutate a Host binding or make a copied Project current.
export function validateRelocationSessionSelection({ root, storage, project }, { sessionId, context = null } = {}) {
  if (context && !callContexts.has(context)) fail("Expected a trusted caller-scoped Host context.", "INVALID_HEAD_SESSION_CALL_CONTEXT");
  const binding = context?.read(root);
  if (sessionId === undefined && binding?.status === "lost") fail("Selected logical Session was lost.", "HEAD_SESSION_SELECTION_LOST");
  const selected = sessionId === undefined ? binding?.sessionId : sessionId;
  if (selected == null || selected === "") {
    const file = defaultSessionStatePath(root, storage), state = read(file);
    if (state?.schemaVersion !== 1 || !validId(state.sessionId) || state.projectId && state.projectId !== project.projectId) fail("Default Session identity differs.", "INVALID_SESSION_CANON", file);
  } else resolveSessionRoute(canonicalRoot(root), selected, { storage, project });
}

export function withSessionRoute(root, sessionId, operation) {
  const base = canonicalRoot(root);
  if (sessionId == null || sessionId === "") return operation();
  const route = resolveSessionRoute(base, sessionId);
  const active = new Map(routes.getStore() || []);
  active.set(base, route);
  return routes.run(active, operation);
}

export function createLodeSession({ root = ".", sessionId = `session-${crypto.randomUUID()}`, purpose = "" } = {}) {
  if (!validId(sessionId) || typeof purpose !== "string") fail("Invalid logical Session input.", "INVALID_HEAD_SESSION_INPUT");
  const base = canonicalRoot(root);
  const storage = resolveProjectStorage(base);
  const directory = formatForVerifiedOwner(storage).directory;
  return withProjectMutation({ root: base, scope: "head-session-create" }, () => {
    const project = read(safeSessionPath(base, directory, "project.json"));
    if (project.projectRoot !== base) fail("Project root identity differs.", "PROJECT_IDENTITY_MISMATCH");
    const defaultState = read(defaultSessionStatePath(base, storage));
    const file = defaultState.sessionId === sessionId ? defaultSessionStatePath(base, storage)
      : safeSessionPath(base, directory, "sessions", "by-id", sessionId, "current.json");
    if (fs.existsSync(file)) {
      const state = read(file);
      if (state.sessionId !== sessionId || state.projectId && state.projectId !== project.projectId || purpose && state.purpose !== purpose) fail("Session create retry differs from its existing identity or purpose.", "HEAD_SESSION_CREATE_CONFLICT");
      return { status: "existing", projectId: project.projectId, sessionId, state };
    }
    const state = { schemaVersion: 1, projectId: project.projectId, sessionId, purpose,
      mode: "session", currentWholePlanId: null, activeRunId: null, activeExecutionContractId: null,
      lastResultPacketId: null, pendingReview: null, lastReviewDecisionId: null,
      requiredPlanAction: null, latestCheckpoint: null, updatedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    safeSessionPath(base, path.relative(base, file));
    atomicCreateArtifact(file, `${JSON.stringify(state, null, 2)}\n`);
    noteProjectGraphChange(base);
    return { status: "created", projectId: project.projectId, sessionId, state };
  });
}

export function listLodeSessions({ root = ".", maxSessions = 16, afterSessionId = null } = {}) {
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 64
    || afterSessionId !== null && (typeof afterSessionId !== "string" || afterSessionId.length > 512)) {
    fail("Invalid bounded Session page.", "INVALID_HEAD_SESSION_INPUT");
  }
  const base = canonicalRoot(root);
  const storage = resolveProjectStorage(base);
  const managementDirectory = formatForVerifiedOwner(storage).directory;
  const projectFile = safeSessionPath(base, managementDirectory, "project.json");
  const projectBytes = fs.readFileSync(projectFile), project = read(projectFile);
  if (project.schemaVersion !== 1 || typeof project.projectId !== "string" || !project.projectId || project.projectRoot !== base) fail("Project identity differs.", "PROJECT_IDENTITY_MISMATCH");
  const unavailable = [], sessions = [];
  const diagnostic = (key, error) => ({ entry: key, sessionId: validId(key) ? key : null,
    status: "unavailable", reasonCode: error.code || "SESSION_READ_UNAVAILABLE" });
  const inspect = (key) => {
    if (key !== "default" && !validId(key)) fail("Unexpected entry in logical Sessions.", "INVALID_HEAD_SESSION_ID");
    const file = key === "default" ? defaultSessionStatePath(base, storage)
      : safeSessionPath(base, managementDirectory, "sessions", "by-id", key, "current.json");
    const fd = fs.openSync(file, "r");
    let bytes;
    try {
      if (!fs.fstatSync(fd).isFile()) fail("Session state is not a file.", "INVALID_SESSION_CANON");
      const buffer = Buffer.alloc(65537), count = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (count > 65536) fail("Session state exceeds bounded discovery; inspect the exact Session separately.", "SESSION_LIST_ITEM_TOO_LARGE");
      bytes = buffer.subarray(0, count);
    } finally { fs.closeSync(fd); }
    let state;
    try { state = JSON.parse(bytes); } catch { fail("Session state is malformed.", "INVALID_SESSION_CANON"); }
    if (state?.schemaVersion !== 1 || !validId(state.sessionId)
      || key !== "default" && state.sessionId !== key
      || (key === "default" ? state.projectId && state.projectId !== project.projectId : state.projectId !== project.projectId)) {
      fail("Session identity differs.", "HEAD_SESSION_IDENTITY_MISMATCH");
    }
    safeSessionPath(base, path.relative(base, file));
    return { sessionId: state.sessionId, purpose: state.purpose || "", default: key === "default", state,
      source: { path: path.relative(base, file).replaceAll("\\", "/"), bytes: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex") } };
  };
  let defaultRow = null, defaultError = null;
  try { defaultRow = inspect("default"); } catch (error) { defaultError = diagnostic("default", error); }
  let entries = [{ key: "default", id: null }], directoryError = null, directoryStatus = "enumerated";
  try {
    const directory = safeSessionPath(base, managementDirectory, "sessions", "by-id");
    entries.push(...fs.readdirSync(directory).sort().map(id => ({ key: validId(id) ? id : `entry:${id}`, id })));
  } catch (error) {
    if (error.code === "ENOENT") directoryStatus = "not-present-at-check";
    else directoryError = { status: "unavailable", reasonCode: error.code || "SESSION_DIRECTORY_UNAVAILABLE" };
  }
  // Exact routing cannot use a default identity also occupied by a named
  // current.json. Do not advertise either identity as healthy in discovery.
  const defaultIdentity = defaultRow?.sessionId;
  if (defaultIdentity) {
    try {
      const duplicate = safeSessionPath(base, managementDirectory, "sessions", "by-id", defaultIdentity, "current.json");
      if (fs.existsSync(duplicate)) fail("Default and named Session identities collide.", "HEAD_SESSION_IDENTITY_MISMATCH");
    } catch (error) { defaultRow = null; defaultError = diagnostic("default", error); }
  }
  const cursor = afterSessionId === null ? -1 : entries.findIndex(entry => entry.key === afterSessionId);
  if (afterSessionId !== null && cursor < 0) fail("Session page cursor is no longer present; read the first page again.", "HEAD_SESSION_LIST_CURSOR_CHANGED");
  let inspected = 0, returned = 0, characters = 0, last = null;
  for (const { key, id } of entries.slice(cursor + 1, cursor + 1 + maxSessions)) {
    inspected += 1;
    let row, error;
    try {
      if (id === null) { row = defaultRow; error = defaultError; }
      else {
        if (!validId(id)) fail("Unexpected entry in logical Sessions.", "INVALID_HEAD_SESSION_ID");
        row = inspect(id);
        if (row.sessionId === defaultIdentity) fail("Default and named Session identities collide.", "HEAD_SESSION_IDENTITY_MISMATCH");
      }
    } catch (caught) { row = null; error = diagnostic(id ?? "default", caught); }
    // Bound full metadata, not just row count. Oversized states remain available
    // to an exact reader; no condition is silently cut from a displayed state.
    if (row && JSON.stringify(row).length > 30000) { row = null; error = diagnostic(id ?? "default", { code: "SESSION_LIST_ITEM_TOO_LARGE" }); }
    if (error) error = { ...error, traversalKey: key };
    const cost = JSON.stringify(row || error).length;
    if (returned && characters + cost > 32768) break;
    if (row) sessions.push(row); else unavailable.push(error);
    characters += cost; returned += 1; last = key;
  }
  safeSessionPath(base, managementDirectory, "project.json");
  if (!fs.readFileSync(projectFile).equals(projectBytes)) fail("Project identity changed during discovery.", "PROJECT_IDENTITY_MISMATCH");
  const remaining = Math.max(0, entries.length - (cursor + 1 + returned));
  return { projectId: project.projectId, defaultSessionId: defaultRow?.sessionId || null, sessions,
    projectSource: { path: path.relative(base, projectFile).replaceAll("\\", "/"), sha256: crypto.createHash("sha256").update(projectBytes).digest("hex") },
    status: directoryError || defaultError || unavailable.length || remaining ? "partial" : "inspected-page",
    unavailable, ...(defaultError ? { defaultAvailability: defaultError } : {}),
    coverage: { discoveredEntries: entries.length, inspectedEntries: inspected, returnedEntries: returned,
      readButNotReturnedEntries: inspected - returned, remainingEntries: remaining,
      directory: directoryError || { status: directoryStatus }, contents: "stored-session-state-only-not-live-work-or-completion",
      maxSessions, maxCharacters: 32768, defaultIdentityInspected: true,
      inspectionScope: "requested-page-slots; default-identity-also-checked-separately", snapshot: false },
    nextAfterSessionId: remaining ? last : null,
    persisted: false, recoveryAuthority: false, instructionAuthority: false, ordinaryWorkBlocked: false };
}

// Exact historical exports only; execution has one implementation.
export { createLodeSession as createHeadSession, listLodeSessions as listHeadSessions };
