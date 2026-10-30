// P4 presentation over already returned bodies only. No reads, selection,
// persistence, inferred activity, transitive ancestry or semantic classification.
const SCOPE = "Returned bodies only; declared historical roots and authored topics are navigation, not task identity, current activity or authority. Unreturned roots/topics are not globally absent.";
const selector = value => typeof value?.evidenceId === "string" && typeof value?.evidenceDigest === "string"
  ? { evidenceId: value.evidenceId, evidenceDigest: value.evidenceDigest } : null;
const key = (owner, root) => JSON.stringify([owner.projectId, owner.sessionId, root]);
const ownOr = (value, field, fallback) => value !== null && typeof value === "object" && Object.hasOwn(value, field) ? value[field] : fallback;

export function workBodyTuples(records, { projectId = null, sessionId = null, bodyKey = "content" } = {}) {
  return records.map((record, index) => ({ index, projectId: ownOr(record, "projectId", projectId),
    sessionId: ownOr(record, "sessionId", sessionId), evidenceId: ownOr(record, "evidenceId", record?.nodeId),
    evidenceDigest: record?.evidenceDigest, content: record?.[bodyKey],
    contentPartial: record?.contentPartial, workContentExcerpts: record?.workContentExcerpts,
    relationCoverage: record?.relationCoverage }));
}

export function organizeSelectedWorkBodies(tuples) {
  const groups = new Map(), originals = new Map();
  for (const tuple of tuples) {
    const own = selector(tuple);
    if (own && tuple.projectId && tuple.sessionId) originals.set(key(tuple, own), tuple.index);
  }
  for (const tuple of tuples) {
    const own = selector(tuple), declared = selector(tuple.content?.workLink?.root), root = declared || own;
    // Malformed presentation input remains individually visible, never merged
    // through missing owner/digest fields. The original verifier owns integrity.
    const exactOwner = typeof tuple.projectId === "string" && tuple.projectId.length > 0
      && typeof tuple.sessionId === "string" && tuple.sessionId.length > 0;
    const groupKey = root && exactOwner ? key(tuple, root) : JSON.stringify(["unscoped", tuple.index]);
    if (!groups.has(groupKey)) groups.set(groupKey, {
      projectId: tuple.projectId ?? null, sessionId: tuple.sessionId ?? null, root,
      rootBodyIndex: root && exactOwner ? originals.get(key(tuple, root)) ?? null : null,
      rootKind: declared ? "declared" : "standalone",
      recordIndices: [], topicAssociations: [],
    });
    const group = groups.get(groupKey);
    if (declared) group.rootKind = "declared";
    group.recordIndices.push(tuple.index);
    const seen = new Set();
    for (const [index, label] of (Array.isArray(tuple.content?.workTopics) ? tuple.content.workTopics : []).entries()) {
      if (typeof label !== "string" || seen.has(label)) continue;
      seen.add(label); group.topicAssociations.push({ recordIndex: tuple.index, index });
    }
    for (const [excerptIndex, entry] of (Array.isArray(tuple.workContentExcerpts) ? tuple.workContentExcerpts : []).entries()) {
      if (entry?.field !== "workTopics") continue;
      const whole = entry.start === 0 && entry.end === entry.totalCharacters;
      if (whole && seen.has(entry.text)) continue;
      if (whole) seen.add(entry.text);
      group.topicAssociations.push({ recordIndex: tuple.index, index: entry.index, excerptIndex,
        start: entry.start, end: entry.end, totalCharacters: entry.totalCharacters });
    }
  }
  return { scope: SCOPE, groups: [...groups.values()] };
}

// Count the actual inserted property, comma, wrapper, escaping and omission
// notice. Bodies have already won admission. No body is removed to fit groups.
export function fitSelectedBodyGroups(tuples, spareCharacters) {
  if (!tuples.length || spareCharacters <= 0) return {};
  const { scope, groups } = organizeSelectedWorkBodies(tuples);
  let count = -1, size = 0;
  for (let included = 0; included <= groups.length; included++) {
    if (included) size += JSON.stringify(groups[included - 1]).length + Number(included > 1);
    const wrapper = JSON.stringify({ selectedBodyGroups: { scope, groups: [], omittedGroups: groups.length - included } }).length - 1;
    if (wrapper + size > spareCharacters) break;
    count = included;
  }
  return count < 0 ? {} : { selectedBodyGroups: { scope, groups: groups.slice(0, count), omittedGroups: groups.length - count } };
}
