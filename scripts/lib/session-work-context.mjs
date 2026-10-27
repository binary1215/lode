import { formatForVerifiedOwner, resolveProjectStorage } from "./project-storage-format.mjs";
import fs from "node:fs";
import path from "node:path";
import { atomicCreateArtifact } from "./artifact-storage.mjs";
import { artifactAuthorityBoundary } from "./authority-plane-contract.mjs";
import { withProjectMutation } from "./project-mutation-lock.mjs";
import { safeSessionPath, sessionStatePath, withSessionRoute, listLodeSessions } from "./session-routing.mjs";
import { readProjectDirectionView } from "./project-direction-view.mjs";

// Selected HEAD-authored P3 evidence, not a transcript, direction store, or
// inference engine. Entry never repairs or writes these originals.
import { SESSION_WORK_CONTEXT_VERSION, PROTOCOL, DEFAULT_SCAN, sha, encoded, fail, sameEvidence,
  normalizeSessionWorkEvidence, inputIdentity, verifySessionWorkEvidenceOwner,
  readSessionWorkEvidenceOriginalFile, inspectSessionWorkReference, createSessionWorkReadContext,
  readSessionWorkFileBytes, MAX_RECORD_BYTES,
  SESSION_WORK_DEFAULT_CHARACTERS, SESSION_WORK_MAX_CHARACTERS, sessionTodoDeclarations } from "./session-work-evidence-original.mjs";
import { noteProjectGraphChange, readSessionWorkNavigationHints } from "./discovery-index.mjs";
import { fitSelectedBodyGroups, workBodyTuples } from "./session-work-body-organization.mjs";
import { readSessionWorkTodos } from "./session-work-todo.mjs";
export { SESSION_WORK_CONTEXT_VERSION, normalizeSessionWorkEvidence };
function identity(root, storage) {
  const base = fs.realpathSync(path.resolve(root));
  storage ??= resolveProjectStorage(base, { readLegacyProject() {
    // Preserve the original selected-Session reader's dependency/error order.
    // This is the actual route, never a newly required default Session check.
    const legacy = formatForVerifiedOwner();
    const projectBytes = fs.readFileSync(safeSessionPath(base, legacy.directory, "project.json"));
    const stateBytes = fs.readFileSync(sessionStatePath(base, legacy));
    verifySessionWorkEvidenceOwner({ root: base, projectBytes, stateBytes });
    return JSON.parse(projectBytes);
  } });
  const projectBytes = fs.readFileSync(safeSessionPath(base, formatForVerifiedOwner(storage).directory, "project.json"));
  const stateBytes = fs.readFileSync(sessionStatePath(base, storage));
  return { ...verifySessionWorkEvidenceOwner({ root: base, projectBytes, stateBytes, storage }),
    statePath: path.relative(base, sessionStatePath(base, storage)).replaceAll("\\", "/"),
    workDirectory: path.relative(base, path.join(path.dirname(sessionStatePath(base, storage)), "work-evidence")).replaceAll("\\", "/") };
}
function directory(root, storage) { return path.join(path.dirname(sessionStatePath(root, storage)), "work-evidence"); }
function fileFor(root, evidenceId, storage) {
  if (!/^work-evidence-[a-f0-9]{24}$/.test(evidenceId || "")) fail("Invalid work evidence identity.");
  return safeSessionPath(root, path.relative(root, path.join(directory(root, storage), `${evidenceId}.json`)));
}
function readOriginalFile(owner, evidenceId) { return readSessionWorkEvidenceOriginalFile(owner, evidenceId); }
function readOriginal(owner, evidenceId) { return readOriginalFile(owner, evidenceId).record; }
const reference = inspectSessionWorkReference;
// Internal graph reader: explicit real owner, without Host selection persistence.
export function readSessionWorkEvidenceOwner({ root, sessionId, storage }) {
  if (!sessionId) fail("An exact logical owner is required.", "HEAD_SESSION_IDENTITY_MISMATCH");
  return withSessionRoute(root, sessionId, () => identity(root, storage));
}

// Existing list consumer composition. A preview never selects a Host binding,
// falls back to default, or reads the bodies of every listed Session.
export function readSessionWorkList({ root = ".", sessionId = null, maxSessions = 16, afterSessionId = null } = {}) {
  const list = listLodeSessions({ root, maxSessions, afterSessionId });
  if (sessionId === null) return list;
  let preview;
  try {
    if (!sessionId) fail("An exact preview Session is required.", "INVALID_HEAD_SESSION_ID");
    preview = withSessionRoute(root, sessionId, () => {
      const workContext = readSessionWorkContext({ root, expectedSessionId: sessionId, maxRecords: 8, maxCharacters: 16384 });
      return { status: workContext.status, sessionId, workContext,
        conclusion: { scope: "recent-recorded-results", representativeResult: "not-designated",
          evidence: workContext.records.map(record => ({ evidenceId: record.evidenceId, evidenceDigest: record.evidenceDigest })),
          interpretation: "Read each original summary with its judgments, pending work and unknowns. Latest, ended, empty pending and PASS do not establish whole-work completion." },
        inputProvenance: "reference-read-now-not-proven-historical-handoff-or-model-input" };
    });
  } catch (error) {
    // Common identity errors cannot be dressed up as a valid Project preview.
    if (["PROJECT_IDENTITY_MISMATCH", "PROJECT_STORAGE_IDENTITY_MISMATCH"].includes(error.code)) throw error;
    preview = { status: "unavailable", sessionId, reasonCode: error.code || "SESSION_READ_UNAVAILABLE" };
  }
  const projectBytes = fs.readFileSync(safeSessionPath(root, list.projectSource.path));
  if (sha(projectBytes) !== list.projectSource.sha256) fail("Project identity changed during preview.", "PROJECT_IDENTITY_MISMATCH");
  // Read common corrections/cancellation after historical bodies, not before
  // them. This remains an at-check view, never an atomic snapshot or authority.
  preview = { ...preview, ...readProjectDirectionView({ root }) };
  return { ...list, preview, previewBounds: { sessions: 1, maxRecords: 8, maxCharactersPerBodyCollection: 16384 },
    interpretation: "Stored evidence for discovery, not an owner assignment, current Host target, whole-work completion or permission. Preview preserves all selections." };
}
export function recordSessionWorkEvidence({ root = ".", input, storage } = {}) {
  const content = normalizeSessionWorkEvidence(input);
  return withProjectMutation({ root, storage, scope: "session-recovery" }, () => {
    const owner = identity(root, storage);
    const evidenceId = `work-evidence-${inputIdentity(owner, content).slice(0, 24)}`;
    const file = fileFor(owner.root, evidenceId, owner.storage);
    // A retry reuses intact originals even if their source has since changed.
    // Revalidation cannot force the caller to redo an already completed effect.
    if (fs.existsSync(file)) {
      const evidence = readOriginal(owner, evidenceId);
      if (encoded(evidence.content) !== encoded(content)) fail("Work evidence identity collision.", "SESSION_WORK_EVIDENCE_CONFLICT");
      return { status: "session_work_evidence_reused", evidence, file, persisted: false, writes: 0, authorityChanged: false, executionReplayAllowed: false };
    }
    const endpoints = new Map();
    const endpoint = (selector) => {
      if (!endpoints.has(selector.evidenceId)) endpoints.set(selector.evidenceId, readOriginal(owner, selector.evidenceId));
      const original = endpoints.get(selector.evidenceId);
      if (!sameEvidence(original, selector)) fail("Work link endpoint differs from its exact original.", "SESSION_WORK_LINK_MISMATCH");
      return original;
    };
    if (content.workLink) {
      endpoint(content.workLink.root);
      const predecessor = endpoint(content.workLink.predecessor);
      if (!sameEvidence(predecessor, content.workLink.root) && !sameEvidence(predecessor.content.workLink?.root, content.workLink.root)) {
        fail("Work predecessor does not declare this exact root.", "SESSION_WORK_LINK_MISMATCH");
      }
    }
    if (content.executionObservation?.target) endpoint(content.executionObservation.target);
    for (const todo of content.todos || []) {
      for (const prior of [todo.prior, ...(todo.resolves || [])].filter(Boolean)) {
        if (!endpoint(prior).content.todos?.some(previous => previous.todoId === todo.todoId)) {
          fail("Todo prior does not name the same item in this exact Session.", "SESSION_TODO_PRIOR_MISMATCH");
        }
      }
      for (const related of todo.relatedEvidence || []) endpoint(related);
    }
    content.references.forEach((ref) => reference(owner, ref, { saving: true }));
    if (identity(owner.root, owner.storage).basis !== owner.basis) fail("Session changed before work evidence publication.", "SESSION_WORK_OBSERVATION_CHANGED");
    const payload = { schemaVersion: 1, kind: "Evidence", subtype: "SessionWorkEvidence", protocol: { ...PROTOCOL, name: formatForVerifiedOwner(owner.storage).protocol(PROTOCOL.name) },
      projectId: owner.projectId, sessionId: owner.sessionId, content, recordedAt: new Date().toISOString(),
      authorityBoundary: artifactAuthorityBoundary("Evidence"), evidenceId };
    const evidence = { ...payload, evidenceDigest: sha(encoded(payload)) };
    fs.mkdirSync(directory(owner.root, owner.storage), { recursive: true });
    fileFor(owner.root, evidenceId, owner.storage); // revalidate new ancestors before publication
    atomicCreateArtifact(file, `${JSON.stringify(evidence, null, 2)}\n`);
    const derived = noteProjectGraphChange(owner.root, [path.relative(owner.root, file).replaceAll("\\", "/")]);
    const graphIndex = derived.status === "unavailable" ? { status: "deferred", reasonCode: derived.reasonCode, ordinaryWorkBlocked: false } : derived;
    return { status: "session_work_evidence_recorded", evidence, file, persisted: true, writes: 1, authorityChanged: false, executionReplayAllowed: false, graphIndex };
  });
}

function workMetadata(original) {
  return { evidenceId: original.evidenceId, evidenceDigest: original.evidenceDigest, recordedAt: original.recordedAt,
    ...(original.content.workLink ? { workLink: original.content.workLink } : {}),
    ...(original.content.executionObservation ? { executionObservation: original.content.executionObservation } : {}) };
}
// One compact relation pass over the already verified selected-Session scan.
// No body/ancestor lookup, clock winner, execution epoch or state transition.
function workOrganization(metadata, unavailableIds, globalRecent, maxRecords, resolver = null, incremental = false, failedQualifiers = null) {
  const byId = new Map(metadata.map((m) => [m.evidenceId, m]));
  const incoming = new Map(), qualifierNodes = new Map(), producers = new Map();
  const lookup = (id) => unavailableIds.has(id) ? null : resolver ? resolver(id) : byId.get(id);
  const cycles = new Set(), colors = new Map();
  const lostCount = m => failedQualifiers?.get(m.evidenceId + ":" + m.evidenceDigest)?.size || 0;
  const groupFor = id => {
    if (!incoming.has(id)) incoming.set(id, { head: null, tail: null, count: 0, unavailable: 0, states: new Map(), version: 0, cached: null });
    return incoming.get(id);
  };
  const attach = (m) => {
    const target = m.executionObservation?.target;
    if (!unavailableIds.has(m.evidenceId) && target && !qualifierNodes.has(m.evidenceId) && sameEvidence(lookup(target.evidenceId), target)) {
      const group = groupFor(target.evidenceId), node = { metadata: m, group, previous: group.tail, next: null };
      if (group.tail) group.tail.next = node; else group.head = node;
      group.tail = node; group.count++;
      group.version++;
      group.states.set(m.executionObservation.state, (group.states.get(m.executionObservation.state) || 0) + 1);
      qualifierNodes.set(m.evidenceId, node);
    }
  };
  const register = (m) => {
    if (lostCount(m)) groupFor(m.evidenceId);
    const target = m.executionObservation?.target;
    if (target) {
      if (!producers.has(target.evidenceId)) producers.set(target.evidenceId, new Map());
      producers.get(target.evidenceId).set(m.evidenceId, m);
      attach(m);
    }
    for (const producer of producers.get(m.evidenceId)?.values() || []) attach(producer);
  };
  // The resolver is initialized by the caller after construction. Initial
  // attachment uses the already-canonical local map, not external hints.
  for (const m of metadata) {
    const target = m.executionObservation?.target;
    if (target) {
      if (!producers.has(target.evidenceId)) producers.set(target.evidenceId, new Map());
      producers.get(target.evidenceId).set(m.evidenceId, m);
    }
  }
  const initialResolver = resolver; resolver = null;
  for (const m of metadata) { attach(m); if (lostCount(m)) groupFor(m.evidenceId); }
  resolver = initialResolver;
  for (const m of metadata) {
    const trail = []; let id = m.evidenceId;
    while (byId.has(id) && !colors.has(id)) {
      colors.set(id, 1); trail.push(id);
      const pred = byId.get(id).workLink?.predecessor;
      id = pred && sameEvidence(byId.get(pred.evidenceId), pred) ? pred.evidenceId : null;
    }
    if (colors.get(id) === 1) {
      for (let i = trail.length - 1; i >= 0; i--) { cycles.add(trail[i]); if (trail[i] === id) break; }
    }
    for (const visited of trail) colors.set(visited, 2);
  }
  const endpointStatus = (selector) => {
    if (unavailableIds.has(selector.evidenceId)) return "unavailable";
    const target = lookup(selector.evidenceId);
    return target ? sameEvidence(target, selector) ? "verified" : "unavailable" : globalRecent ? "unavailable" : "not-inspected";
  };
  const observedCycle = (source) => {
    if (!incremental) return cycles.has(source);
    const visited = new Set(); let id = source;
    // Only already observed exact metadata. Never follow a file/ancestor here,
    // and a root equal to predecessor is not a terminal/acyclic proof.
    while (byId.has(id) && !unavailableIds.has(id) && !visited.has(id)) {
      visited.add(id);
      const pred = byId.get(id).workLink?.predecessor;
      if (!pred || !sameEvidence(lookup(pred.evidenceId), pred)) return false;
      id = pred.evidenceId;
    }
    return id === source && visited.size > 0;
  };
  const relations = (m) => {
    const rows = [];
    if (!m) return rows;
    for (const [role, selector] of [["root", m.workLink?.root], ["predecessor", m.workLink?.predecessor], ["target", m.executionObservation?.target]]) {
      if (!selector) continue;
      let status = endpointStatus(selector);
      if (role === "predecessor" && status === "verified") {
        const pred = lookup(selector.evidenceId);
        if (observedCycle(m.evidenceId) || resolver && endpointStatus(m.workLink.root) === "unavailable"
          || !pred || !sameEvidence(pred, m.workLink.root) && !sameEvidence(pred.workLink?.root, m.workLink.root)) status = "unavailable";
      }
      rows.push({ role, status, ...(status === "unavailable" ? { reasonCode: "SESSION_WORK_LINK_UNAVAILABLE" } : {}) });
    }
    return rows;
  };
  return {
    byId, incoming,
    add(m) { if (!byId.has(m.evidenceId)) { byId.set(m.evidenceId, m); register(m); } },
    invalidate(id) {
      const node = qualifierNodes.get(id);
      if (!node) return;
      const group = node.group;
      if (node.previous) node.previous.next = node.next; else group.head = node.next;
      if (node.next) node.next.previous = node.previous; else group.tail = node.previous;
      group.count--; group.unavailable++; group.version++;
      const state = node.metadata.executionObservation.state;
      group.states.set(state, group.states.get(state) - 1);
      qualifierNodes.delete(id);
      return node.metadata;
    },
    overlay(id) {
      const m = lookup(id), group = incoming.get(id), rows = relations(m);
      if (!m || !m.workLink && !m.executionObservation && !group) return null;
      if (group && group.cached?.version !== group.version) {
        const candidates = [];
        for (let node = group.head; node && (incremental || candidates.length < maxRecords); node = node.next) candidates.push(node.metadata);
        if (incremental) candidates.sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt)) || a.evidenceId.localeCompare(b.evidenceId));
        const qualifiers = [];
        for (const q of candidates.slice(0, maxRecords)) {
          qualifiers.push({ evidenceId: q.evidenceId, evidenceDigest: q.evidenceDigest, state: q.executionObservation.state });
        }
        group.cached = { version: group.version, qualifiers };
      }
      const qualifiers = group?.cached.qualifiers || [], count = group?.count || 0;
      const unavailableCount = failedQualifiers ? lostCount(m) : group?.unavailable || 0;
      return { states: ["running", "paused", "ended", "unknown"].filter((s) => group?.states.get(s) > 0), qualifierCount: count, qualifiers,
        omittedQualifierCount: count - qualifiers.length, unavailableQualifierCount: unavailableCount,
        coverage: unavailableCount || rows.some((r) => r.status === "unavailable") ? "partial" : globalRecent ? "verified-scan" : "not-inspected",
        relations: rows };
    },
    summary(sourceIds = null) {
      let unavailableRelations = 0, uninspectedRelations = 0;
      const roots = new Set(), children = new Map();
      const ids = sourceIds || byId.keys();
      for (const id of ids) {
        const m = lookup(id);
        if (!m) continue;
        if (m.workLink) {
          roots.add(encoded(m.workLink.root));
          const key = encoded(m.workLink.predecessor);
          children.set(key, (children.get(key) || 0) + 1);
        }
        for (const row of relations(m)) {
          if (row.status === "unavailable") unavailableRelations++;
          if (row.status === "not-inspected") uninspectedRelations++;
        }
      }
      return { interpretation: "Saved historical observations coexist; neither their state, time nor predecessor establishes current live state, success or authority.",
        liveState: "not-observed", scope: globalRecent && !sourceIds ? "discovered-selected-session" : "inspected-originals-only",
        roots: roots.size, branchingPredecessors: [...children.values()].filter((n) => n > 1).length,
        unavailableRelations, uninspectedRelations };
    },
  };
}

// Internal pure single-original projection, shared by exact expansion sizing.
export function projectExactSessionWorkRecord(original, references) {
  const organized = Boolean(original.content.workLink || original.content.executionObservation);
  const organization = organized ? workOrganization([workMetadata(original)], new Set(), false, 1) : null;
  const overlay = organization?.overlay(original.evidenceId);
  return { ...original, ...(organization ? { selectionRole: "recent", ...(overlay ? { savedActivity: overlay } : {}) } : {}), references };
}

// Discover D once. Optional headers only order historical candidates; all U
// joins this same request. Fresh canonical proofs, not rows, populate validity.
function readDefaultWorkContext(owner, maxRecords, maxCharacters, context) {
  let names;
  try { names = fs.readdirSync(directory(owner.root, owner.storage), { withFileTypes: true }); }
  catch (error) { if (error.code !== "ENOENT") throw error; names = []; }
  names = names.filter(entry => /^work-evidence-[a-f0-9]{24}\.json$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  const discovered = new Set(names.map(entry => entry.name.slice(0, -5)));
  const regularIds = new Set(names.filter(entry => entry.isFile()).map(entry => entry.name.slice(0, -5)));
  context.todoInventory = [...discovered];
  const hints = discovered.size ? readSessionWorkNavigationHints(owner, regularIds, context) : new Map();
  const inspected = new Set(), observations = new Map(), errors = new Map(), failedQualifiers = new Map();
  const hintMismatch = new Error("Historical navigation differs from a healthy current original.");
  const select = (headers) => {
  const hinted = headers.size > 0;
  const metadata = [], currentMetadata = [], fresh = new Map([...errors].map(([id, error]) => [id, { error }])), unavailableIds = new Set(errors.keys());
  const budget = new Set();
  const selected = [], roles = new Map(), attempted = new Set(), deferred = new Set();
  let relatedReads = 0, organization;
  const reject = (id, error) => {
    context.todoObservedRows?.delete(id);
    errors.set(id, error);
    unavailableIds.add(id);
    budget.delete(id);
    fresh.set(id, { error });
    const lost = organization?.invalidate(id)?.executionObservation?.target;
    // Only an actually canonical, exact-target-attached producer can create a
    // loss count. Retain that fact through fallback, never its validity/state.
    if (lost) {
      const key = lost.evidenceId + ":" + lost.evidenceDigest;
      if (!failedQualifiers.has(key)) failedQualifiers.set(key, new Set());
      failedQualifiers.get(key).add(id);
    }
    return fresh.get(id);
  };
  const inspect = (id) => {
    if (discovered.has(id)) inspected.add(id);
    if (errors.has(id)) throw errors.get(id);
    const { record, bytes } = readOriginalFile(owner, id), byteDigest = sha(bytes), m = workMetadata(record);
    const previous = observations.get(id);
    if (previous && (previous.byteDigest !== byteDigest || !sameEvidence(previous.metadata, m) || previous.metadata.recordedAt !== m.recordedAt)) {
      fail("Work evidence changed during selection.", "SESSION_WORK_OBSERVATION_CHANGED");
    }
    observations.set(id, { metadata: m, byteDigest });
    const header = headers.get(id);
    if (header && (header.rawDigest !== byteDigest || header.recordedAt !== record.recordedAt
      || header.observationTargetId !== (record.content.executionObservation?.target?.evidenceId || null))) throw hintMismatch;
    if (discovered.has(id)) {
      context.todoObservedRows ||= new Map();
      context.todoObservedRows.set(id, { path: owner.workDirectory + "/" + id + ".json", rawDigest: byteDigest,
        ownerSessionId: owner.sessionId, evidenceDigest: record.evidenceDigest, todoRevisions: sessionTodoDeclarations(record.content) });
    }
    return { record, bytes, metadata: m, byteDigest };
  };
  for (const id of discovered) {
    if (headers.has(id)) { metadata.push({ evidenceId: id, recordedAt: headers.get(id).recordedAt }); continue; }
    try {
      const observed = inspect(id);
      metadata.push(observed.metadata); currentMetadata.push(observed.metadata);
    } catch (error) { reject(id, error); }
  }
  metadata.sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt)) || a.evidenceId.localeCompare(b.evidenceId));
  currentMetadata.sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt)) || a.evidenceId.localeCompare(b.evidenceId));
  let byId;
  const resolve = (id) => unavailableIds.has(id) || fresh.get(id)?.error ? null : fresh.get(id)?.metadata || byId.get(id);
  // Only canonical observations enter this map. Further body/endpoint/known
  // producer proofs join incrementally; no hint-only row becomes valid state.
  organization = workOrganization(currentMetadata, unavailableIds, !hinted, maxRecords, resolve, hinted, failedQualifiers);
  byId = organization.byId;
  const load = (id, body = false) => {
    // A late-added endpoint can prove a relation, but it cannot enlarge S's
    // body domain or its discovered-original counters in this response.
    if (body && !discovered.has(id)) return null;
    const previous = fresh.get(id);
    if (previous?.error || previous && (!body || previous.record)) return previous;
    try {
      if (previous) {
        const bytes = readSessionWorkFileBytes(owner.root, `${owner.workDirectory}/${id}.json`, MAX_RECORD_BYTES);
        if (sha(bytes) !== previous.byteDigest) fail("Work evidence changed before body admission.", "SESSION_WORK_OBSERVATION_CHANGED");
        // Exact bytes were already canonical-verified in this request. A new
        // raw read is still required when proof-only becomes a body candidate.
        previous.record = JSON.parse(bytes.toString("utf8"));
        return previous;
      }
      const { record, metadata, byteDigest } = inspect(id);
      const proof = { metadata, byteDigest, ...(body ? { record } : {}) };
      fresh.set(id, proof);
      if (discovered.has(id)) organization.add(metadata);
      return proof;
    } catch (error) { if (error === hintMismatch) throw error; return reject(id, error); }
  };
  const incomingCandidates = new Map(), incomingPrepared = new Set();
  for (const candidate of metadata) {
    const targetId = headers.has(candidate.evidenceId) ? headers.get(candidate.evidenceId).observationTargetId
      : candidate.executionObservation?.target?.evidenceId;
    if (!targetId) continue;
    if (!incomingCandidates.has(targetId)) incomingCandidates.set(targetId, new Set());
    incomingCandidates.get(targetId).add(candidate.evidenceId);
  }
  const ensureKnownIncoming = (id) => {
    if (!hinted || incomingPrepared.has(id)) return;
    incomingPrepared.add(id);
    // All known producers, not just the displayed prefix. Self/owner/actual
    // target proof only; unrelated producer links/refs are not recursive gates.
    for (const producer of incomingCandidates.get(id) || []) load(producer);
  };
  const checkEndpoints = (original) => {
    for (const endpoint of [original.content.workLink?.root, original.content.workLink?.predecessor, original.content.executionObservation?.target]) {
      if (endpoint) load(endpoint.evidenceId);
    }
  };
  const prefix = owner.workDirectory + "/";
  const citedId = (ref) => ref.kind === "artifact" && ref.path.startsWith(prefix)
    && /^work-evidence-[a-f0-9]{24}\.json$/.test(ref.path.slice(prefix.length)) ? ref.path.slice(prefix.length, -5) : null;
  const showOrganization = (bodies) => bodies.some((record) => record.content.workLink || record.content.executionObservation
    || roles.get(record.evidenceId) !== "recent" || organization.incoming.has(record.evidenceId));
  const render = (bodies) => {
    const organized = showOrganization(bodies);
    return bodies.map((record) => {
    const overlay = organized ? organization.overlay(record.evidenceId) : null;
    const { references: retained, selectionRole: previousRole, savedActivity: previousOverlay, ...original } = record;
    return { ...original, ...(organized ? { selectionRole: roles.get(record.evidenceId), ...(overlay ? { savedActivity: overlay } : {}) } : {}),
      // Retain the already-admitted output tuple, as the original reader did.
      // Do not rehash every generic ref whenever another body is considered.
      // A later typed proof (including failure) always overrides that output.
      // There is no shared descriptor/path verdict cache for other references.
      references: record.content.references.map((ref, i) => {
        const proof = fresh.get(citedId(ref));
        return proof ? reference(owner, ref, { context, proof }) : retained?.[i] || reference(owner, ref, { context });
      }) };
    });
  };
  const reconcile = () => {
    for (let i = selected.length - 1; i >= 0; i--) {
      if (fresh.get(selected[i].evidenceId)?.error) { roles.delete(selected[i].evidenceId); selected.splice(i, 1); }
    }
    let records = render(selected);
    while (records.length && JSON.stringify(records).length > maxCharacters) {
      const removed = selected.pop(); budget.add(removed.evidenceId); roles.delete(removed.evidenceId);
      delete fresh.get(removed.evidenceId).record;
      records = render(selected);
    }
    return records;
  };
  const offer = (id, role) => {
    if (attempted.has(id) || roles.has(id)) return false;
    const proof = load(id, true);
    if (!proof?.record) return false;
    attempted.add(id);
    const record = proof.record;
    if (JSON.stringify([{ ...record, references: [] }]).length > maxCharacters) {
      budget.add(id); delete proof.record; return false;
    }
    checkEndpoints(record);
    ensureKnownIncoming(id);
    reconcile();
    roles.set(id, role);
    const records = render([...selected, record]);
    if (selected.length >= maxRecords || JSON.stringify(records).length > maxCharacters) {
      roles.delete(id); budget.add(id); delete proof.record; return false;
    }
    selected.push(records.at(-1)); budget.delete(id); return true;
  };
  let seeds = 0, relatedSlots = 0;
  for (const candidate of metadata) {
    if (seeds >= Math.ceil(maxRecords / 2) || selected.length >= maxRecords) break;
    if (attempted.has(candidate.evidenceId) || roles.has(candidate.evidenceId)) continue;
    const seed = load(candidate.evidenceId, true);
    if (!seed?.record) continue;
    const original = seed.record;
    if (JSON.stringify([{ ...original, references: [] }]).length > maxCharacters) {
      offer(candidate.evidenceId, "recent"); continue;
    }
    const citations = original.content.references.map((ref) => ({ id: citedId(ref), ref })).filter((item) => item.id);
    const root = original.content.workLink?.root;
    const queue = [...citations.slice(0, 1), ...(root ? [{ id: root.evidenceId, selector: root }] : []), ...citations.slice(1)];
    // Canonical prefetch precedes generic reference enrichment. Its byte proof
    // checks the same citation without an additional generic file read. The
    // bounded queue is body preparation, not admission or a recursive scan.
    for (const item of queue) {
      if (roles.has(item.id) || attempted.has(item.id) || !discovered.has(item.id) || fresh.get(item.id)?.record) continue;
      if (relatedReads >= maxRecords) { deferred.add(item.id); continue; }
      relatedReads++; load(item.id, true);
    }
    if (!offer(candidate.evidenceId, "recent")) continue;
    seeds++;
    for (const item of queue) {
      if (relatedSlots >= Math.floor(maxRecords / 2) || selected.length >= maxRecords) {
        if (!roles.has(item.id) && discovered.has(item.id)) deferred.add(item.id);
        continue;
      }
      if (roles.has(item.id) || attempted.has(item.id) || !discovered.has(item.id)) continue;
      const proof = fresh.get(item.id);
      if (!proof?.record || item.ref && proof.byteDigest !== item.ref.digest || item.selector && !sameEvidence(proof.metadata, item.selector)) {
        if (proof) delete proof.record;
        continue;
      }
      if (offer(item.id, item.ref ? "cited" : "root")) relatedSlots++;
    }
  }
  // Reconciliation can remove a body after a later proof failure. Continue
  // remaining candidates, never retry unchanged failures or replay effects.
  for (const candidate of metadata) {
    reconcile();
    if (selected.length >= maxRecords) break;
    offer(candidate.evidenceId, "recent");
  }
  const records = reconcile();
  const summary = showOrganization(records) ? organization.summary(new Set(records.map((record) => record.evidenceId))) : null;
  const failed = [...discovered].filter((id) => unavailableIds.has(id));
  const valid = inspected.size - failed.length;
  const uninspected = discovered.size - inspected.size;
  const included = new Set(records.map((record) => record.evidenceId));
  const omitted = [...budget].filter((id) => discovered.has(id) && !fresh.get(id)?.error && !included.has(id));
  return { status: uninspected || failed.length || omitted.length || valid > records.length || summary?.unavailableRelations || summary?.uninspectedRelations ? "work_context_partial"
      : records.length ? "work_context_available" : "work_context_not_recorded", records,
    unavailable: failed.slice(0, 32).map((id) => ({ evidenceId: id, reasonCode: fresh.get(id).error.code || "INVALID_SESSION_WORK_EVIDENCE" })),
    ...(summary ? { organization: { ...summary, relatedReadAttempts: relatedReads, relatedExpansionDeferred: deferred.size } } : {}),
    coverage: { originals: discovered.size, inspected: inspected.size, valid, unavailable: failed.length, included: records.length, maxRecords, maxCharacters,
      usedCharacters: JSON.stringify(records).length, characterBudgetScope: "JSON.stringify(records).length; separate bounded metadata envelope excluded",
      selection: (hinted ? "historical navigation hints order candidates; only inspected originals have current canonical proof" : "all discovered originals canonically inspected once")
        + "; recent-results-with-bounded-explicit-citations-and-declared-roots; fresh body/declared-endpoint rereads; partial body delivery and sequential observations, not live state or semantic sufficiency" },
    omissions: { uninspected, byBudget: omitted.length, evidenceIds: omitted.slice(0, 32), omittedIdCount: Math.max(0, omitted.length - 32), unavailableDetailCount: Math.max(0, failed.length - 32) },
    nextAfterEvidenceId: null,
    expansion: "Read exact evidenceIds with larger useful bounds or read the named original when useful. Partial body delivery does not require a full audit or repeating default entry. A digest/path is not recovered contents." };
  };
  try { return select(hints); }
  catch (error) {
    if (error !== hintMismatch) throw error;
    // Same D, one canonical fallback. Already observed current failures remain
    // sticky; a healthy original contradicting only its old hint is not corrupt.
    return select(new Map());
  }
}

export function readSessionWorkContext({ root = ".", evidenceIds = null, maxRecords = 8, maxCharacters = SESSION_WORK_DEFAULT_CHARACTERS,
  afterEvidenceId = null, expectedSessionId = null, expectedCheckpointId = undefined, storage,
  todoId = null, afterTodoId = null, scanTodos = false } = {}) {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > DEFAULT_SCAN
    || !Number.isSafeInteger(maxCharacters) || maxCharacters < 2 || maxCharacters > SESSION_WORK_MAX_CHARACTERS
    || evidenceIds !== null && (!Array.isArray(evidenceIds) || evidenceIds.length > DEFAULT_SCAN)
    || afterEvidenceId !== null && (!/^work-evidence-[a-f0-9]{24}$/.test(afterEvidenceId) || evidenceIds !== null)
    || [todoId, afterTodoId].some(value => value !== null && !/^todo-[a-z0-9][a-z0-9-]{0,79}$/.test(value))
    || typeof scanTodos !== "boolean") fail("Invalid work context read bounds.");
  const owner = identity(root, storage);
  const shell = { kind: "SessionWorkContextProjection", authorityPlane: "P4", projectId: owner.projectId, sessionId: owner.sessionId,
    sessionPurpose: owner.state.purpose || null, basis: owner.basis, latestCheckpointId: owner.state.latestCheckpoint || null,
    persisted: false, recoveryAuthority: false, instructionAuthority: false, promotionAuthority: false,
    executionReplayAllowed: false, ordinaryWorkBlocked: false,
    interpretation: `P3 ${formatForVerifiedOwner(owner.storage).value("HEAD")}-authored historical evidence, not current direction, approval, or proof of an external effect. Current Project constraints and selected Session P2 take precedence.` };
  if (expectedSessionId && owner.sessionId !== expectedSessionId
    || expectedCheckpointId !== undefined && (owner.state.latestCheckpoint || null) !== expectedCheckpointId) {
    return { ...shell, status: "work_context_basis_changed", records: [], omissions: { basisChanged: true } };
  }
  const context = createSessionWorkReadContext(owner.root, owner.storage);
  // Sparse originals or indexed hints, not every-turn full history/body reads.
  // Explicit exact-evidence reads keep their existing no-inventory guarantee.
  if (evidenceIds === null && afterEvidenceId === null) {
    const result = readDefaultWorkContext(owner, maxRecords, maxCharacters, context);
    const todoContext = readSessionWorkTodos(owner, { maxRecords, maxCharacters, todoId, afterTodoId, scanTodos, afterEvidenceId,
      context, inventory: context.todoInventory, hints: context.todoHints || new Map() });
    if (identity(owner.root, owner.storage).basis !== owner.basis) return { ...shell, status: "work_context_basis_changed", records: [], omissions: { basisChanged: true } };
    return { ...shell, ...result, ...(todoContext ? { todoContext } : {}), ...fitSelectedBodyGroups(workBodyTuples(result.records, owner),
      maxCharacters - JSON.stringify(result.records).length) };
  }
  const directoryPath = directory(owner.root, owner.storage);
  const names = evidenceIds !== null ? null : fs.existsSync(directoryPath) ? fs.readdirSync(directoryPath).filter((name) => /^work-evidence-[a-f0-9]{24}\.json$/.test(name)).sort() : [];
  const remainingNames = names === null ? [] : afterEvidenceId === null ? names : names.filter((name) => name > afterEvidenceId + ".json");
  const ids = evidenceIds === null ? remainingNames.slice(0, DEFAULT_SCAN).map((name) => name.slice(0, -5)) : [...new Set(evidenceIds)];
  const originals = [], unavailable = [], unavailableIds = new Set();
  let unavailableCount = 0;
  const markUnavailable = (id, error) => {
    if (unavailableIds.has(id)) return;
    unavailableIds.add(id);
    unavailableCount += 1;
    if (unavailable.length < DEFAULT_SCAN) {
      unavailable.push({ evidenceId: id, reasonCode: error.code || "INVALID_SESSION_WORK_EVIDENCE" });
    }
  };
  for (const id of ids) {
    try {
      const original = readOriginal(owner, id);
      originals.push(original);
    } catch (error) { markUnavailable(id, error); }
  }
  originals.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.evidenceId.localeCompare(b.evidenceId));
  const metadata = originals.map(workMetadata);
  const organized = metadata.some((m) => m.workLink || m.executionObservation);
  const organization = organized ? workOrganization(metadata, unavailableIds, false, maxRecords) : null;
  const records = [];
  let used = 2, omittedByBudget = 0, valid = originals.length;
  const omittedEvidenceIds = [];
  const omit = (id) => {
    omittedByBudget += 1;
    if (omittedEvidenceIds.length < 32) omittedEvidenceIds.push(id);
  };
  const decorate = (original, role) => {
    const overlay = organization?.overlay(original.evidenceId);
    return { ...original, ...(organization ? { selectionRole: role, ...(overlay ? { savedActivity: overlay } : {}) } : {}) };
  };
  for (const candidate of originals) {
    if (records.length >= maxRecords) {
      omit(candidate.evidenceId);
      continue;
    }
    const original = candidate;
    // Even an empty enrichment array cannot fit: do not read its references.
    // An oversized recent record must not hide an older, smaller fitting one.
    if (JSON.stringify([...records, { ...original, references: [] }]).length > maxCharacters) {
      omit(original.evidenceId);
      continue;
    }
    const references = original.content.references.map((ref) => reference(owner, ref, { context }));
    const selected = evidenceIds?.length === 1 && maxRecords === 1 ? projectExactSessionWorkRecord(original, references)
      : { ...decorate(original, "recent"), references };
    // Budget the actual enriched record array sent to consumers, not the smaller
    // on-disk originals. The separately disclosed metadata envelope is excluded.
    const nextSize = JSON.stringify([...records, selected]).length;
    if (nextSize > maxCharacters) {
      omit(original.evidenceId);
      continue;
    }
    used = nextSize;
    records.push(selected);
  }
  const todoContext = evidenceIds === null ? readSessionWorkTodos(owner, { maxRecords, maxCharacters, todoId, afterTodoId, scanTodos, afterEvidenceId,
    context, inventory: names.map(name => name.slice(0, -5)) }) : undefined;
  if (identity(owner.root, owner.storage).basis !== owner.basis) return { ...shell, status: "work_context_basis_changed", records: [], omissions: { basisChanged: true } };
  const organizationSummary = organization?.summary();
  return { ...shell, status: unavailableCount || evidenceIds === null && remainingNames.length > ids.length || omittedByBudget
      || organizationSummary?.unavailableRelations || organizationSummary?.uninspectedRelations ? "work_context_partial" : records.length ? "work_context_available" : "work_context_not_recorded",
    records, unavailable, ...(todoContext ? { todoContext } : {}), ...fitSelectedBodyGroups(workBodyTuples(records, owner), maxCharacters - used),
    ...(organization ? { organization: { ...organizationSummary, relatedReadAttempts: 0, relatedExpansionDeferred: 0 } } : {}),
    coverage: { originals: names?.length ?? null, inspected: ids.length, valid, unavailable: unavailableCount, included: records.length, maxRecords, maxCharacters, usedCharacters: used,
      characterBudgetScope: "JSON.stringify(records).length; separate bounded metadata envelope excluded",
      selection: evidenceIds !== null ? "newest-recorded-first-within-requested-exact-ids; Session inventory not enumerated; no global completeness or semantic sufficiency claim"
        : "newest-recorded-first-within-inspected-original-page; no semantic relevance or sufficient-context judgment" },
    omissions: { uninspected: evidenceIds === null ? Math.max(0, remainingNames.length - ids.length) : null, byBudget: omittedByBudget,
      evidenceIds: omittedEvidenceIds, omittedIdCount: omittedByBudget - omittedEvidenceIds.length,
      unavailableDetailCount: unavailableCount - unavailable.length },
    nextAfterEvidenceId: evidenceIds === null && remainingNames.length > ids.length ? ids.at(-1) : null,
    expansion: "Read exact evidenceIds with larger useful bounds or read the named original. A digest/path is not recovered contents. No evidence is deleted or silently considered irrelevant." };
}
