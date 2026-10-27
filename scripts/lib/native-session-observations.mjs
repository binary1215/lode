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
import { resolveRuntimeOperationalStateRoot } from "./runtime-execution-lease.mjs";
import { safeSessionPath, withSessionRoute } from "./session-routing.mjs";
import { createSessionHostAdapter } from "./session-host-adapter.mjs";
import { readSessionWorkContext } from "./session-work-context.mjs";
import { SESSION_WORK_DEFAULT_CHARACTERS } from "./session-work-evidence-original.mjs";

// Optional Host-local P5. Neither events, ancestry nor process presence selects
// a logical Session, closes work, grants approval or establishes safe replay.
export const NATIVE_OBSERVATION_LIMITS = Object.freeze({ bytes: 128 * 1024, slots: 64, replay: 64,
  lockMs: 200, headerBytes: 64 * 1024, responseBytes: 16 * 1024, displayed: 16 });
const sha = x => crypto.createHash("sha256").update(x).digest("hex");
const json = JSON.stringify;
const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
export const nativeId = x => typeof x === "string" && x.length > 0 && x.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(x);
const digest = x => typeof x === "string" && /^[a-f0-9]{64}$/u.test(x);
const nullableId = x => x === null || nativeId(x);
const callerKey = c => [c.runtime, c.nativeSessionId, c.agentId || null];
const callerDigest = c => sha(json(callerKey(c)));
const validCaller = c => object(c) && ["codex", "claude", "opencode"].includes(c.runtime)
  && nativeId(c.nativeSessionId) && nullableId(c.agentId ?? null) && (c.runtime !== "codex" || !c.agentId);
const fail = () => { throw Object.assign(new Error("Optional native observation is unavailable."), { code: "NATIVE_OBSERVATION_UNAVAILABLE" }); };
const keys = (x, allowed) => object(x) && Object.keys(x).every(k => allowed.includes(k));
const events = {
  SessionStart: "start-observed", UserPromptSubmit: "prompt-observed", Stop: "response-end-observed",
  SubagentStart: "child-start-observed", SubagentStop: "response-end-observed", SessionEnd: "caller-end-observed",
  "session.created": "start-observed", "session.status": "status-observed", "session.idle": "idle-observed",
  "session.deleted": "caller-deleted-observed", "session.error": "error-observed",
};
const reasons = ["clear", "resume", "logout", "prompt_input_exit", "other"];
const sources = ["startup", "resume", "clear", "compact", "fork"];
function safeFile(file, maxBytes) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) fail();
  return fs.readFileSync(file);
}
function safeDirectories(base, parts, create) {
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) { if (!create) continue; fs.mkdirSync(current); }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  }
  return current;
}
function projectIdentity(root) {
  const base = fs.realpathSync(path.resolve(root));
  const storage = resolveProjectStorage(base);
  const format = formatForVerifiedOwner(storage);
  const project = JSON.parse(fs.readFileSync(safeSessionPath(base, format.directory, "project.json"), "utf8"));
  if (project.schemaVersion !== 1 || project.projectRoot !== base || !new RegExp(`^${format.projectPrefix}[a-f0-9]{20}$`, "u").test(project.projectId || "")) fail();
  return { base, project, storage };
}
function location(root, caller, environment, create = false) {
  if (!validCaller(caller)) fail();
  const { base, project, storage } = projectIdentity(root);
  const operational = resolveRuntimeOperationalStateRoot({ projectRoot: base, storage, environment, create });
  const owner = { projectId: project.projectId, rootDigest: sha(base), callerDigest: callerDigest(caller) };
  // Never create/read the caller's session-bindings directory here: directory
  // absence has an existing, important selection-recovery meaning.
  const directory = safeDirectories(operational, ["native-observations", sha(json(owner))], create);
  return { owner, directory, file: path.join(directory, "snapshot.json") };
}
function validInstance(x) {
  return keys(x, ["pid", "ppid", "birth", "environment", "platform"])
    && Number.isSafeInteger(x.pid) && x.pid > 0 && Number.isSafeInteger(x.ppid) && x.ppid >= 0
    && nativeId(x.birth) && nativeId(x.environment) && ["win32", "linux"].includes(x.platform);
}
function validObservation(x) {
  if (!keys(x, ["kind", "event", "phase", "requestId", "source", "reason", "member", "instance", "edge", "nativeStatus"])) return false;
  if (x.kind === "edge") {
    const e = x.edge, m = e?.mapping;
    return Object.keys(x).length === 2 && keys(e, ["relation", "sourceNativeId", "contract", "headerDigest", "mapping"])
      && ["native-fork", "native-parent"].includes(e.relation) && nativeId(e.sourceNativeId)
      && e.contract === "codex-own-session-meta-v1" && digest(e.headerDigest)
      && (m === null || keys(m, ["sessionId", "revision", "bindingDigest"])
        && /^session-[a-f0-9-]{36}$/iu.test(m.sessionId || "") && Number.isSafeInteger(m.revision) && m.revision > 0 && digest(m.bindingDigest));
  }
  return x.kind === "event" && Object.hasOwn(events, x.event) && x.phase === events[x.event]
    && nullableId(x.requestId) && (x.source === null || sources.includes(x.source))
    && (x.reason === null || reasons.includes(x.reason))
    && (!Object.hasOwn(x, "member") || validCaller(x.member) && Object.keys(x.member).length === 3)
    && (!Object.hasOwn(x, "instance") || validInstance(x.instance))
    && (!Object.hasOwn(x, "nativeStatus") || ["busy", "retry", "idle"].includes(x.nativeStatus));
}
function slotKey(x) {
  if (x.kind === "edge") return sha(json(["edge", x.edge.relation, x.edge.sourceNativeId]));
  // Missing prompt IDs do not join a prompt and a Stop. A caller-only end never
  // closes a request. Distinct witnessed OS instances cannot overwrite each other.
  return sha(json(["event", x.member ? callerKey(x.member) : null,
    x.event === "SessionEnd" || x.event === "session.deleted" ? "caller-end" : x.requestId || x.event,
    x.instance ? [x.instance.environment, x.instance.pid, x.instance.birth] : null]));
}
function readSnapshot(loc) {
  if (!fs.existsSync(loc.file)) return null;
  const state = JSON.parse(safeFile(loc.file, NATIVE_OBSERVATION_LIMITS.bytes));
  const { snapshotDigest, ...payload } = state;
  if (!keys(state, ["kind", "version", "owner", "sequence", "omitted", "rows", "replay", "snapshotDigest"])
    || state.kind !== "NativeObservationSnapshot" || state.version !== 1 || json(state.owner) !== json(loc.owner)
    || !Number.isSafeInteger(state.sequence) || state.sequence < 0 || !Number.isSafeInteger(state.omitted) || state.omitted < 0
    || !Array.isArray(state.rows) || state.rows.length > NATIVE_OBSERVATION_LIMITS.slots
    || !Array.isArray(state.replay) || state.replay.length > NATIVE_OBSERVATION_LIMITS.replay
    || state.replay.some(r => !keys(r, ["id", "digest"]) || !nativeId(r.id) || !digest(r.digest))
    || state.rows.some(r => !keys(r, ["key", "sequence", "receivedAt", "observation"]) || r.key !== slotKey(r.observation)
      || !Number.isSafeInteger(r.sequence) || r.sequence < 1 || r.sequence > state.sequence
      || typeof r.receivedAt !== "string" || !Number.isFinite(Date.parse(r.receivedAt)) || !validObservation(r.observation))
    || new Set(state.rows.map(r => r.key)).size !== state.rows.length || snapshotDigest !== sha(json(payload))) fail();
  const edges = state.rows.filter(r => r.observation.kind === "edge");
  if (edges.length > 2 || new Set(edges.map(r => r.observation.edge.relation)).size !== edges.length) fail();
  return state;
}
export function createNativeObservationStore({ environment = process.env } = {}) {
  return Object.freeze({
    read({ root, caller }) { return readSnapshot(location(root, caller, environment)); },
    async observe({ root, caller, observation, additionalObservations = [], eventId = null }) {
      if (!validObservation(observation) || !nullableId(eventId) || !Array.isArray(additionalObservations)
        || additionalObservations.length > 2 || additionalObservations.some(o => o.kind !== "edge" || !validObservation(o))
        || eventId && additionalObservations.length) fail();
      const loc = location(root, caller, environment, true), lock = path.join(loc.directory, "writer.lock");
      const token = crypto.randomUUID(), deadline = Date.now() + NATIVE_OBSERVATION_LIMITS.lockMs;
      let fd, owner;
      while (fd === undefined) {
        try { fd = fs.openSync(lock, "wx"); }
        catch (e) {
          // Windows may report deletion-pending lock contention as EPERM
          // rather than EEXIST. Retry only this optional exclusive acquisition,
          // within the same fixed bound; never remove or steal a lock.
          const contention = e.code === "EEXIST" || process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(e.code);
          if (!contention || Date.now() >= deadline) throw e;
          await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
        }
      }
      try {
        owner = fs.fstatSync(fd); fs.writeFileSync(fd, token);
        // Reread/validate inside the critical section, not before lock acquisition.
        const old = readSnapshot(loc), eventDigest = sha(json(observation));
        const prior = eventId && old?.replay.find(r => r.id === eventId);
        if (prior) { if (prior.digest !== eventDigest) fail(); return { retained: true, replay: true }; }
        const payload = { kind: "NativeObservationSnapshot", version: 1, owner: loc.owner,
          sequence: old?.sequence || 0, omitted: old?.omitted || 0,
          rows: [...old?.rows || []], replay: old?.replay || [] };
        for (const candidate of [observation, ...additionalObservations]) {
          const key = slotKey(candidate), existing = payload.rows.find(r => r.key === key);
          // First retained edge mapping (including null) cannot be rewritten.
          // A conflicting later source for the same immutable relation is not
          // permission to retarget a historical source. At most two edge rows.
          if (candidate.kind === "edge" && payload.rows.some(r => r.observation.kind === "edge"
            && r.observation.edge.relation === candidate.edge.relation)) continue;
          if (existing && (candidate.kind === "edge" || json(existing.observation) === json(candidate)) && !eventId) continue;
          payload.sequence++;
          if (!Number.isSafeInteger(payload.sequence)) fail();
          payload.rows = payload.rows.filter(r => r.key !== key);
          payload.rows.push({ key, sequence: payload.sequence, receivedAt: new Date().toISOString(), observation: candidate });
        }
        if (payload.sequence === (old?.sequence || 0) && !eventId) return { retained: true, replay: true };
        if (eventId) payload.replay = [...payload.replay, { id: eventId, digest: eventDigest }].slice(-NATIVE_OBSERVATION_LIMITS.replay);
        const encode = () => json({ ...payload, snapshotDigest: sha(json(payload)) }) + "\n";
        while (payload.rows.length > NATIVE_OBSERVATION_LIMITS.slots || Buffer.byteLength(encode()) > NATIVE_OBSERVATION_LIMITS.bytes) {
          const oldestEvent = payload.rows.findIndex(r => r.observation.kind !== "edge");
          if (oldestEvent < 0) fail(); payload.rows.splice(oldestEvent, 1); payload.omitted++;
        }
        location(root, caller, environment); // Revalidate the optional path before publication.
        atomicWriteArtifact(loc.file, encode());
        return { retained: true, replay: false };
      } finally {
        fs.closeSync(fd);
        try {
          const current = fs.lstatSync(lock);
          if (owner && current.isFile() && !current.isSymbolicLink() && current.dev === owner.dev && current.ino === owner.ino
            && fs.readFileSync(lock, "utf8") === token) fs.unlinkSync(lock);
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        // A replaced/unknown lock belongs to someone else: never remove it.
      }
    },
  });
}

export function normalizeNativeHook({ runtime, event } = {}) {
  if (!["codex", "claude"].includes(runtime) || !object(event) || !nativeId(event.session_id)
    || typeof event.cwd !== "string" || !Object.hasOwn(events, event.hook_event_name)
    || event.hook_event_name.includes(".")) return null;
  const child = ["SubagentStart", "SubagentStop"].includes(event.hook_event_name);
  if (child && !nativeId(event.agent_id) || event.agent_id != null && !nativeId(event.agent_id)) return null;
  if (runtime === "codex" && ["SessionStart", "Stop", "SessionEnd"].includes(event.hook_event_name) && event.agent_id) return null;
  const caller = { runtime, nativeSessionId: runtime === "codex" && event.agent_id ? event.agent_id : event.session_id,
    agentId: runtime === "claude" ? event.agent_id || null : null };
  const requestId = ["SessionStart", "SessionEnd"].includes(event.hook_event_name) ? null
    : runtime === "codex" ? event.turn_id : event.prompt_id;
  if (requestId != null && !nativeId(requestId)) return null;
  const observation = { kind: "event", event: event.hook_event_name, phase: events[event.hook_event_name], requestId: requestId || null,
    source: sources.includes(event.source) ? event.source : null, reason: reasons.includes(event.reason) ? event.reason : null };
  const membership = child ? { caller: { runtime, nativeSessionId: event.session_id, agentId: null },
    observation: { ...observation, member: caller } } : null;
  return { root: event.cwd, caller, observation, membership };
}

// Exact supplied own header only. No transcript tail/body/history traversal and
// no dependency on transcripts for ordinary root startup or caller routing.
function ownCodexEdges(event, caller, root) {
  if (!(event.hook_event_name === "SessionStart" && event.source === "fork"
    || ["SubagentStart", "SubagentStop"].includes(event.hook_event_name))) return [];
  const file = event.hook_event_name === "SubagentStop" ? event.agent_transcript_path : event.transcript_path;
  if (typeof file !== "string" || !path.isAbsolute(file)) return [];
  const resolved = path.resolve(file);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep)) {
    current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) fail();
  }
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let bytes;
  try {
    if (!fs.fstatSync(fd).isFile()) fail();
    const buffer = Buffer.alloc(NATIVE_OBSERVATION_LIMITS.headerBytes);
    const n = fs.readSync(fd, buffer, 0, buffer.length, 0), end = buffer.subarray(0, n).indexOf(10);
    if (end < 0 && n === buffer.length) fail();
    bytes = buffer.subarray(0, end < 0 ? n : end);
  } finally { fs.closeSync(fd); }
  const line = JSON.parse(bytes.toString("utf8")), meta = line.payload;
  if (line.type !== "session_meta" || !object(meta) || meta.id !== caller.nativeSessionId
    || !nativeId(meta.cli_version) || typeof meta.cwd !== "string" || fs.realpathSync(meta.cwd) !== fs.realpathSync(root)) return [];
  return [["native-fork", meta.forked_from_id], ["native-parent", meta.parent_thread_id]]
    .filter(([, id]) => nativeId(id) && id !== caller.nativeSessionId)
    .map(([relation, sourceNativeId]) => ({ relation, sourceNativeId, contract: "codex-own-session-meta-v1", headerDigest: sha(bytes), mapping: null }));
}
export async function observeNativeHook({ runtime, event, environment = process.env, processObserver = null } = {}) {
  const normalized = normalizeNativeHook({ runtime, event });
  if (!normalized) return { retained: false };
  const { root, caller, observation, membership } = normalized;
  // Do not initialize an untouched project or inspect user registry/transcripts
  // for a Hook whose Project is absent or invalid.
  const store = createNativeObservationStore({ environment });
  // Validate only shared Project identity here. A corrupt/unsafe child snapshot
  // must not pre-empt the independent reported-root membership publication.
  try { projectIdentity(root); } catch { return { retained: false }; }
  if (runtime === "claude" && ["SessionStart", "UserPromptSubmit"].includes(event.hook_event_name)) {
    try {
      const probe = processObserver || (await import("./native-session-process.mjs")).observeClaudeProcess;
      const instance = await probe({ nativeSessionId: caller.nativeSessionId, environment });
      if (validInstance(instance)) observation.instance = instance;
    } catch { /* Optional exact process association is unknown. */ }
  }
  const additionalObservations = [];
  if (runtime === "codex") {
    try {
      for (const edge of ownCodexEdges(event, caller, root)) {
        try {
          const mapping = createSessionHostAdapter({ runtime, nativeSessionId: edge.sourceNativeId, environment }).read({ root });
          if (["bound", "default"].includes(mapping.status)) edge.mapping = { sessionId: mapping.sessionId, revision: mapping.revision, bindingDigest: mapping.bindingDigest };
        } catch { /* Edge only, never current/default mapping fallback. */ }
        additionalObservations.push({ kind: "edge", edge });
      }
    } catch { /* Unsupported/missing own metadata never blocks startup/work. */ }
  }
  let retained = false;
  // One own-caller publication containing the event and up to two direct edges,
  // plus at most one independent reported-root membership publication.
  try { retained = (await store.observe({ root, caller, observation, additionalObservations })).retained; } catch { /* Optional only. */ }
  if (membership && callerDigest(membership.caller) !== callerDigest(caller)) {
    try { await store.observe({ root, ...membership }); } catch { /* Independent bounded second publication, not a transaction. */ }
  }
  return { retained };
}

export function readRelatedNativeWorkContext({ root, caller, childSessionId, environment = process.env } = {}) {
  const snapshot = createNativeObservationStore({ environment }).read({ root, caller });
  if (!snapshot) return null;
  const seen = new Set([childSessionId]), sources = [];
  let characters = SESSION_WORK_DEFAULT_CHARACTERS;
  for (const { observation, sequence, receivedAt } of snapshot.rows) {
    const edge = observation.kind === "edge" && observation.edge, mapping = edge?.mapping;
    if (!mapping || seen.has(mapping.sessionId) || sources.length >= 2) continue;
    seen.add(mapping.sessionId);
    try {
      const work = withSessionRoute(root, mapping.sessionId, () => readSessionWorkContext({ root,
        expectedSessionId: mapping.sessionId, maxCharacters: Math.max(2, characters) }));
      if (!work.records?.length || work.status === "work_context_basis_changed") continue;
      // Not parent P2 purpose/checkpoint/direction, not native fork-cutoff history.
      const { sessionPurpose, latestCheckpointId, basis, ...historical } = work;
      characters -= json(historical.records).length;
      sources.push({ relation: edge.relation, sourceNativeId: edge.sourceNativeId,
        selection: "selected-when-edge-observed-not-fork-cutoff",
        selectionBasis: { ...mapping, receivedSequence: sequence, receivedAt },
        recordRead: { at: new Date().toISOString(), scope: "later-reference-read",
          historicalInput: "unknown", preparedInput: "not-established", delivery: "not-established", modelUse: "not-established" },
        workContext: historical });
    } catch { /* One unavailable source does not erase a valid child/source. */ }
  }
  return sources.length ? { kind: "RelatedNativeWorkContext", persisted: false, recoveryAuthority: false,
    instructionAuthority: false, ordinaryWorkBlocked: false, sources } : null;
}

export async function projectNativeObservations({ root, caller, environment = process.env, processProbe = null } = {}) {
  let snapshot = null;
  try { snapshot = createNativeObservationStore({ environment }).read({ root, caller }); } catch { /* Optional corrupt/missing. */ }
  if (!snapshot && caller.runtime !== "codex") return null;
  const observations = (snapshot?.rows || []).filter(r => r.observation.kind === "event").slice(-NATIVE_OBSERVATION_LIMITS.displayed)
    .map(({ sequence, receivedAt, observation }) => ({ receivedSequence: sequence, receivedAt, ...observation }));
  if (caller.runtime === "claude" && observations.some(o => o.instance)) {
    try {
      const probe = processProbe || (await import("./native-session-process.mjs")).probeClaudeProcesses;
      const checks = await probe({ instances: observations.flatMap(o => o.instance ? [o.instance] : []), nativeSessionId: caller.nativeSessionId, environment });
      for (const row of observations) if (row.instance) row.processObservation = checks.find(c => c.pid === row.instance.pid && c.birth === row.instance.birth
        && c.environment === row.instance.environment && c.platform === row.instance.platform)
        || { state: "unknown", scope: "observed-hosting-instance-not-agent-activity" };
    } catch { /* No fabricated ended/current state after probe failure. */ }
  }
  return { authorityPlane: "P5", scope: "native-caller-not-logical-session-execution", caller: {
    runtime: caller.runtime, nativeSessionId: caller.nativeSessionId, agentId: caller.agentId || null },
    ...(caller.runtime === "codex" ? { hostTarget: { threadId: caller.nativeSessionId } } : {}),
    interpretation: "Receipt-ordered observations, not causal order/current task state, completion, approval or safe replay. No complete activity census.",
    observations, omitted: (snapshot?.omitted || 0) + Math.max(0, (snapshot?.rows.filter(r => r.observation.kind === "event").length || 0) - observations.length),
    persisted: false, recoveryAuthority: false, instructionAuthority: false };
}

// The bound is the full serialized result increment, including text/structured
// duplication and JSON escaping. Original canonical content is never truncated.
export function appendNativeStatus(result, projection) {
  if (!projection || !object(result?.structuredContent) || result.isError || !Array.isArray(result.content)
    || result.structuredContent.status === "session_selection_unresolved" || Object.hasOwn(result.structuredContent, "nativeContext")) return result;
  const native = { ...projection, observations: [...projection.observations] }, originalBytes = Buffer.byteLength(json(result));
  for (;;) {
    const next = { ...result, content: [...result.content, { type: "text",
      text: "Native caller observations (optional P5, not logical task state):\n" + json(native) }],
      structuredContent: { ...result.structuredContent, nativeContext: native } };
    if (Buffer.byteLength(json(next)) - originalBytes <= NATIVE_OBSERVATION_LIMITS.responseBytes) return next;
    if (!native.observations.length) return result;
    native.observations.shift(); native.omitted++;
  }
}
