import fs from "node:fs";
import { safeSessionPath } from "./session-paths.mjs";
import { readSessionWorkNavigationHints } from "./discovery-index.mjs";
import { DEFAULT_SCAN, readSessionWorkEvidenceOriginalFile, sha, sameEvidence, encoded, sessionTodoDeclarations } from "./session-work-evidence-original.mjs";

// A separate selection over the same immutable P3 originals, independent of
// recent-work ranking. The existing replaceable index supplies hints only.
// No writer, repair, P2 direction, live task inference or effect authorization.
export function readSessionWorkTodos(owner, { maxRecords = 8, maxCharacters = 32768, todoId = null,
  afterTodoId = null, scanTodos = false, afterEvidenceId = null, context = null, inventory, hints } = {}) {
  const shell = { kind: "SessionTodoProjection", authorityPlane: "P4", projectId: owner.projectId, sessionId: owner.sessionId,
    persisted: false, recoveryAuthority: false, instructionAuthority: false, executionReplayAllowed: false, ordinaryWorkBlocked: false,
    scope: "Explicit HEAD-recorded P3 task revisions, not live activity, user approval or P2 direction. Current constraints/cancellations take precedence. Indexed absence is not completeness." };
  try {
    const directory = safeSessionPath(owner.root, owner.workDirectory);
    const ids = inventory || (fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => /^work-evidence-[a-f0-9]{24}\.json$/.test(entry.name)).map(entry => entry.name.slice(0, -5)).sort() : []);
    if (!hints) { const observed = {}; readSessionWorkNavigationHints(owner, new Set(ids), observed); hints = observed.todoHints || new Map(); }
    const indexedCount = hints.size;
    // Reuse this request's successful canonical observations, including an
    // unindexed publication. Failed/undiscovered originals cannot join here.
    hints = new Map(hints);
    const hintMismatches = [];
    for (const [id, row] of context?.todoObservedRows || []) {
      const hint = hints.get(id);
      if (hint && (hint.rawDigest !== row.rawDigest || hint.evidenceDigest !== row.evidenceDigest
        || encoded(hint.todoRevisions) !== encoded(row.todoRevisions))) hintMismatches.push(id);
      if (row.todoRevisions.length) hints.set(id, row); else hints.delete(id);
    }
    const revisionKey = (id, evidenceId) => id + ":" + evidenceId;
    const hinted = new Map(), superseded = new Set();
    for (const [id, row] of hints) for (const todo of row.todoRevisions || []) hinted.set(revisionKey(todo.todoId, id), { todo, evidenceId: id, evidenceDigest: row.evidenceDigest });
    for (const { todo } of hinted.values()) for (const prior of [todo.prior, ...(Array.isArray(todo.resolves) ? todo.resolves : [])].filter(Boolean)) {
      const parent = hinted.get(revisionKey(todo.todoId, prior.evidenceId));
      if (parent && sameEvidence(parent, prior)) superseded.add(revisionKey(todo.todoId, prior.evidenceId));
    }
    const heads = new Set([...hinted.keys()].filter(key => !superseded.has(key)));
    const candidates = scanTodos ? ids.filter(id => !afterEvidenceId || id > afterEvidenceId)
      : ids.filter(id => (hints.get(id)?.todoRevisions || []).some(todo => (!todoId || todo.todoId === todoId) && heads.has(revisionKey(todo.todoId, id))));
    const inspected = candidates.slice(0, DEFAULT_SCAN), records = [], unavailable = [];
    for (const id of inspected) {
      try {
        const { record, bytes } = readSessionWorkEvidenceOriginalFile(owner, id);
        const row = hints.get(id), declarations = sessionTodoDeclarations(record.content);
        if (!scanTodos && (sha(bytes) !== row?.rawDigest || row.evidenceDigest !== record.evidenceDigest
          || encoded(row.todoRevisions) !== encoded(declarations))) throw Object.assign(new Error("Todo index hint changed"), { code: "SESSION_TODO_INDEX_DRIFT" });
        records.push(record);
      } catch (error) { unavailable.push({ evidenceId: id, reasonCode: error.code || "SESSION_TODO_UNAVAILABLE" }); }
    }
    const groups = new Map();
    for (const record of records) for (const todo of record.content.todos || []) {
      if (todoId && todo.todoId !== todoId || !scanTodos && !heads.has(revisionKey(todo.todoId, record.evidenceId))) continue;
      if (!groups.has(todo.todoId)) groups.set(todo.todoId, []);
      groups.get(todo.todoId).push({ ...todo, revision: { evidenceId: record.evidenceId, evidenceDigest: record.evidenceDigest },
        references: record.content.references, referenceFreshness: "not-inferred" });
    }
    const all = [];
    for (const [id, revisions] of groups) {
      const parents = new Set(), missingPriors = [];
      for (const revision of revisions) for (const prior of [revision.prior, ...(revision.resolves || [])].filter(Boolean)) {
        const parent = revisions.find(value => sameEvidence(value.revision, prior));
        if (parent) parents.add(parent.revision.evidenceId);
        else if (scanTodos || !sameEvidence(hinted.get(revisionKey(id, prior.evidenceId)), prior)) missingPriors.push(prior);
      }
      const leaves = revisions.filter(value => !parents.has(value.revision.evidenceId));
      const conflict = leaves.length !== 1;
      const current = conflict ? { todoId: id, status: "conflict", revisions: leaves.length ? leaves : revisions } : leaves[0];
      all.push({ ...current, resolution: conflict ? "unresolved-branches" : scanTodos ? "exact-within-inspected-revisions" : "verified-original-selected-by-indexed-declarations", missingPriors,
        authorityChanged: false, historicalObservationIsCompletion: false });
    }
    all.sort((a, b) => a.todoId.localeCompare(b.todoId));
    const open = all.filter(item => todoId || !["completed", "cancelled"].includes(item.status));
    const remaining = open.filter(item => !afterTodoId || item.todoId > afterTodoId), items = [], omitted = [];
    for (const item of remaining) {
      if (items.length >= maxRecords || JSON.stringify([...items, item]).length > maxCharacters) omitted.push(item.todoId);
      else items.push(item);
    }
    const uninspectedOriginals = ids.length - records.length, unindexed = ids.filter(id => !hints.has(id));
    const complete = uninspectedOriginals === 0 && unavailable.length === 0;
    return { ...shell, status: unavailable.length ? "partial-unavailable" : complete ? "inspected-page" : hints.size ? "partial-indexed-knowledge" : "unknown",
      items, knownOpenCount: !complete && !all.length ? null : open.length,
      knownItemCount: !complete && !all.length ? null : all.length, currentness: "within-inspected-originals-only",
      coverage: { status: complete ? "all-current-originals-inspected" : "unknown-outside-inspected-originals", originalCount: ids.length,
        indexedTaskRevisionRecords: indexedCount, observedTaskMetadataRecords: context?.todoObservedRows?.size || 0,
        indexCoverage: indexedCount ? "available-hints-not-completeness" : "unknown",
        indexHintMismatchCount: hintMismatches.length, indexHintMismatches: hintMismatches.slice(0, 32),
        inspectedOriginals: inspected.length, verifiedOriginals: records.length, uninspectedOriginals, unindexedOriginals: unindexed.length,
        indexIsAuthority: false, recentWorkLimitApplied: false, unavailable: unavailable.slice(0, 32),
        unavailableOmitted: Math.max(0, unavailable.length - 32), omittedItems: omitted.length, omittedItemIds: omitted.slice(0, 32),
        uninspectedCandidateRevisions: Math.max(0, candidates.length - inspected.length) },
      nextAfterTodoId: items.length && omitted.length ? items.at(-1).todoId : null,
      nextScanAfterEvidenceId: candidates.length > inspected.length ? inspected.at(-1) : null,
      expansion: "Use session-work-read todo_id for an exact item, after_todo_id for more open items, or scan_todos with after_evidence_id for bounded original pages when index coverage is unknown. Pages do not establish unseen successors are absent." };
  } catch (error) {
    return { ...shell, status: "unknown", items: [], knownOpenCount: null, knownItemCount: null,
      coverage: { status: "unknown", reasonCode: error.code || "SESSION_TODO_UNAVAILABLE" },
      expansion: "Read exact work evidence or a bounded original page; unavailable Todo coverage never means completed or empty." };
  }
}
