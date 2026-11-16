// The status view's reading of a Graph Explorer snapshot: the user's current
// direction, Sessions, saved work records, 남은 일 and 모르는 것. Pure: it
// reads only the snapshot's exported records. Stored fields read:
// ProjectDirection.directionEvidence (goal, constraints, decisions,
// cancelledActions) and freshness; LodeSessionStateReference.purpose;
// SessionWorkEvidence nodes' sessionId, recordedAt, evidenceDigest and
// workContent (summary, judgments, pending, unknowns, todos with todoId,
// status, task, nextAction, prior and resolves, references) and
// referenceEvidence. A 남은 일 item is shown finished only when a later record
// of the same Session has a completed todo with the same todoId whose prior or
// resolves names the item's record (directly, or through such later
// revisions). Nothing else ever marks an item finished.
export const explorerStatus = (() => {
  const OPEN_TODO = new Set(["pending", "partial", "waiting"]);
  const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  const recordId = (node) => node.sourceReference?.artifactId || node.nodeId;

  function model(snapshot) {
    const nodes = snapshot?.graph?.nodes || [];
    const project = snapshot?.project ? { available: true, projectId: snapshot.project.projectId, root: snapshot.project.root || null } : { available: false };
    const directions = nodes.filter((node) => node.kind === "ProjectDirection");
    const current = directions.find((node) => node.freshness === "current-direction-reference") || null;
    const direction = {
      current: current ? { ...current.directionEvidence, objective: current.objective || current.directionEvidence?.goal || "", path: current.origin?.path, digest: current.origin?.digest, partial: current.directionContentCoverage?.partial === true } : null,
      superseded: directions.filter((node) => node !== current).map((node) => ({ goal: node.directionEvidence?.goal || node.objective || "", path: node.origin?.path, freshness: node.freshness })),
    };
    const sessions = new Map();
    const session = (id) => {
      if (!sessions.has(id)) sessions.set(id, { sessionId: id, purpose: null, records: [], pending: 0, unknowns: 0, latest: null });
      return sessions.get(id);
    };
    for (const node of nodes) {
      if (node.kind === "LodeSessionStateReference" && node.sessionId) session(node.sessionId).purpose = node.purpose || null;
      else if (node.kind === "LodeSession" && node.sessionId) session(node.sessionId);
    }
    const records = new Map();
    for (const node of nodes) {
      if (node.kind !== "Evidence" || node.subtype !== "SessionWorkEvidence" || !node.sessionId) continue;
      const content = node.workContent || null;
      const record = {
        id: recordId(node),
        nodeId: node.nodeId,
        digest: node.evidenceDigest || null,
        originDigest: node.origin?.digest || null,
        path: node.origin?.path || null,
        sessionId: node.sessionId,
        recordedAt: node.recordedAt || null,
        bodyIncluded: Boolean(content),
        // The exported body is only part of the record (the copy's reading
        // budget): what is missing may hold more pending work or links.
        partial: node.workContentCoverage?.partial === true || node.contentPartial === true,
        summary: content?.summary || "",
        judgments: content?.judgments || [],
        observedWork: content?.observedWork || [],
        pending: [],
        unknowns: [],
        todos: content?.todos || [],
        references: (node.referenceEvidence || []).map((ref) => ({ path: ref.path, digest: ref.digest, kind: ref.kind, currentness: ref.currentness })),
        before: null,
        after: null,
      };
      if (!node.referenceEvidence?.length) for (const ref of content?.references || []) record.references.push({ path: ref.path, digest: ref.digest, kind: ref.kind, currentness: null });
      records.set(record.id, record);
      session(node.sessionId).records.push(record);
      // 남은 일: every pending text and every todo revision still open in its record.
      (content?.pending || []).forEach((text, index) => record.pending.push({ key: `${record.id}#pending/${index}`, text, kind: "pending", state: "open" }));
      for (const todo of record.todos)
        if (OPEN_TODO.has(todo.status))
          record.pending.push({ key: `${record.id}#todo/${todo.todoId}`, text: todo.task, kind: "todo", todoId: todo.todoId, status: todo.status, nextAction: todo.nextAction || "", state: "open" });
      (content?.unknowns || []).forEach((text, index) => record.unknowns.push({ key: `${record.id}#unknown/${index}`, text }));
    }
    // Later revisions of the same todo, in the same Session only.
    const successors = new Map();
    for (const record of records.values())
      for (const todo of record.todos)
        for (const selector of [todo.prior, ...(todo.resolves || [])].filter(Boolean)) {
          const target = records.get(selector.evidenceId);
          if (!target || target.sessionId !== record.sessionId || (selector.evidenceDigest && target.digest && selector.evidenceDigest !== target.digest)) continue;
          if (!target.todos.some((item) => item.todoId === todo.todoId)) continue;
          const key = `${target.id}#todo/${todo.todoId}`;
          if (!successors.has(key)) successors.set(key, []);
          successors.get(key).push({ record, todo });
        }
    // The first later revision that ends the item: completed (finished) or
    // cancelled, directly or through later open revisions.
    const endedBy = (key, seen = new Set()) => {
      if (seen.has(key)) return null;
      seen.add(key);
      for (const next of successors.get(key) || []) {
        if (next.todo.status === "completed") return { state: "finished", by: next.record.id };
        if (next.todo.status === "cancelled") return { state: "cancelled", by: next.record.id };
        const deeper = endedBy(`${next.record.id}#todo/${next.todo.todoId}`, seen);
        if (deeper) return deeper;
      }
      return null;
    };
    for (const record of records.values())
      for (const item of record.pending)
        if (item.kind === "todo") {
          const ended = endedBy(item.key);
          if (ended?.state === "finished") Object.assign(item, { state: "finished", finishedBy: ended.by });
          else if (ended?.state === "cancelled") Object.assign(item, { state: "cancelled", cancelledBy: ended.by });
        }
    // An open todo counts once per Session and todoId: its latest open
    // revision. Earlier open revisions are its history.
    const latestOpen = new Map();
    for (const record of records.values())
      for (const item of record.pending)
        if (item.kind === "todo" && item.state === "open") {
          const key = `${record.sessionId}\u0000${item.todoId}`;
          const current = latestOpen.get(key);
          if (!current || compare(current.record.recordedAt || "", record.recordedAt || "") < 0 || (current.record.recordedAt === record.recordedAt && compare(current.record.id, record.id) < 0))
            latestOpen.set(key, { record, item });
        }
    for (const record of records.values())
      for (const item of record.pending)
        if (item.kind === "todo" && item.state === "open") {
          const latest = latestOpen.get(`${record.sessionId}\u0000${item.todoId}`);
          if (latest.item !== item) Object.assign(item, { state: "earlier", laterRevision: latest.record.id });
        }
    for (const group of sessions.values()) {
      group.records.sort((a, b) => compare(b.recordedAt || "", a.recordedAt || "") || compare(b.id, a.id));
      const chronological = [...group.records].reverse();
      chronological.forEach((record, index) => {
        record.before = chronological[index - 1]?.id || null;
        record.after = chronological[index + 1]?.id || null;
      });
      group.latest = group.records[0] || null;
      group.pending = group.records.reduce((sum, record) => sum + record.pending.filter((item) => item.state === "open").length, 0);
      group.unknowns = group.records.reduce((sum, record) => sum + record.unknowns.length, 0);
      group.partial = group.records.filter((record) => record.partial).length;
    }
    // A Session with a record whose body is only partly in the copy is never
    // folded as having nothing left.
    const rank = (group) => (group.pending ? 0 : group.unknowns || group.partial ? 1 : 2);
    const ordered = [...sessions.values()].sort((a, b) => rank(a) - rank(b) || compare(b.latest?.recordedAt || "", a.latest?.recordedAt || "") || compare(a.sessionId, b.sessionId));
    const items = [];
    for (const group of ordered)
      for (const record of group.records) {
        for (const item of record.pending) items.push({ ...item, sessionId: group.sessionId, recordId: record.id, recordedAt: record.recordedAt, type: "pending" });
        for (const item of record.unknowns) items.push({ ...item, sessionId: group.sessionId, recordId: record.id, recordedAt: record.recordedAt, type: "unknown", state: "open" });
      }
    const files = new Set(nodes.filter((node) => node.kind === "File" && node.path).map((node) => node.path));
    return {
      project,
      direction,
      sessions: ordered,
      records,
      items,
      counts: {
        sessions: ordered.length,
        records: records.size,
        pending: items.filter((item) => item.type === "pending" && item.state === "open").length,
        unknowns: items.filter((item) => item.type === "unknown").length,
        files: files.size,
        partialRecords: [...records.values()].filter((record) => record.partial).length,
      },
    };
  }

  // Records newest first, across Sessions.
  const recent = (status) => [...status.records.values()].sort((a, b) => compare(b.recordedAt || "", a.recordedAt || "") || compare(b.id, a.id));

  // The judgments the agent wrote, each with its record.
  const judgments = (status) => recent(status).flatMap((record) => record.judgments.map((judgment) => ({ ...judgment, recordId: record.id, sessionId: record.sessionId, recordedAt: record.recordedAt })));

  // Files the records refer to, each with the records.
  function files(status) {
    const byPath = new Map();
    for (const record of recent(status))
      for (const ref of record.references) {
        if (!byPath.has(ref.path)) byPath.set(ref.path, []);
        byPath.get(ref.path).push({ recordId: record.id, sessionId: record.sessionId, recordedAt: record.recordedAt, currentness: ref.currentness });
      }
    return [...byPath.entries()].sort((a, b) => compare(a[0], b[0])).map(([path, uses]) => ({ path, uses }));
  }

  // Compared in NFC; a path typed with backslashes also matches forward slashes.
  const fold = (value) => String(value).normalize("NFC").toLocaleLowerCase();
  function search(status, text) {
    const first = fold(text || "");
    if (!first) return [];
    const wanted = [...new Set([first, first.replaceAll("\\", "/")])];
    const hit = (value) => typeof value === "string" && wanted.some((needle) => fold(value).includes(needle));
    const found = [];
    for (const record of recent(status)) {
      const texts = [
        record.summary,
        ...record.judgments.flatMap((item) => [item.assessment, item.reason, ...(item.alternatives || [])]),
        ...record.observedWork,
        ...record.pending.map((item) => item.text),
        ...record.unknowns.map((item) => item.text),
        ...record.references.map((ref) => ref.path),
      ];
      const match = texts.find(hit);
      if (match) found.push({ recordId: record.id, sessionId: record.sessionId, recordedAt: record.recordedAt, match });
    }
    return found;
  }

  return Object.freeze({ model, recent, judgments, files, search });
})();
