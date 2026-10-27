import { publicToolName } from "./lode-artifact-composition.mjs";
import { SESSION_WORK_MAX_CHARACTERS } from "./session-work-evidence-original.mjs";

// P4 only, over already verified/returned values. No reads, writes, new scan,
// source selection, language inference or current authority belongs here.
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const samePath = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const below = (path, parent) => path.length > parent.length && parent.every((part, i) => path[i] === part);
const empty = value => value === null || value === "" || Array.isArray(value) && !value.length || object(value) && !Object.keys(value).length;
const sourceKey = source => JSON.stringify([source.projectId, source.sessionId, source.evidenceId, source.evidenceDigest]);
const delivery = (records, excerpts) => ({ records, ...(excerpts.length ? { recordExcerpts: excerpts } : {}) });
export const workDeliveryCharacters = work => work?.recordExcerpts?.length
  ? JSON.stringify(delivery(work.records || [], work.recordExcerpts)).length : JSON.stringify(work?.records || []).length;
export function workOriginalCount(work) {
  const keys = new Set(); let unqualified = 0;
  for (const source of [...(work?.records || []).map(record => ({ ...work, ...record })),
    ...(work?.recordExcerpts || []).map(excerpt => excerpt.source)]) {
    if (source && ["projectId", "sessionId", "evidenceId", "evidenceDigest"].every(key => typeof source[key] === "string")) keys.add(sourceKey(source));
    else unqualified++;
  }
  return keys.size + unqualified;
}
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });

function sourceOf(record, owner) {
  if (!object(record.content) || typeof record.projectId !== "string" || typeof record.sessionId !== "string"
    || !/^work-evidence-[a-f0-9]{24}$/u.test(record.evidenceId || "") || !/^[a-f0-9]{64}$/u.test(record.evidenceDigest || "")
    || owner.projectId && owner.projectId !== record.projectId || owner.sessionId && owner.sessionId !== record.sessionId) return null;
  return { projectId: record.projectId, sessionId: record.sessionId, evidenceId: record.evidenceId, evidenceDigest: record.evidenceDigest };
}

function children(unit) {
  const { path, value } = unit.fragment;
  if (path.length !== 3 || !["judgments", "todos"].includes(path[1]) || !object(value) || unit.fragment.complete !== true) return [];
  const group = { path, fields: Object.keys(value), emptyValues: Object.fromEntries(Object.entries(value).filter(([, item]) => empty(item))),
    arrayLengths: Object.fromEntries(Object.entries(value).filter(([, item]) => Array.isArray(item)).map(([key, item]) => [key, item.length])) };
  return Object.entries(value).flatMap(([field, item], fieldIndex) => {
    if (empty(item)) return [];
    if (field === "alternatives" && Array.isArray(item)) return item.map((value, index) => ({ ...unit,
      order: [...unit.order, fieldIndex, index], fragment: { path: [...path, field, index], value, complete: true, group } }));
    return [{ ...unit, order: [...unit.order, fieldIndex], fragment: { path: [...path, field], value: item, complete: true, group } }];
  });
}

function fromRecord(record, owner, order) {
  const source = sourceOf(record, owner);
  if (!source) return null;
  const shape = Object.entries(record.content).map(([field, value]) => ({ field, kind: Array.isArray(value) ? "array" : "value",
    sourceItems: Array.isArray(value) ? value.length : 1 }));
  const emptyValues = Object.fromEntries(Object.entries(record.content).filter(([, value]) => empty(value)));
  const entry = { source, order, original: record, shape, emptyValues, sourceContentCharacters: JSON.stringify(record.content).length,
    checks: (record.references || []).map((check, referenceIndex) => ({ referenceIndex, check })),
    selectionRole: record.selectionRole, units: [] };
  let ordinal = 0;
  for (const [field, value] of Object.entries(record.content)) {
    if (empty(value)) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const [index, item] of values.entries()) {
      const unit = { entry, order: [ordinal++], fragment: { path: ["content", field, ...(Array.isArray(value) ? [index] : [])], value: item, complete: true } };
      entry.units.push(unit, ...children(unit));
    }
  }
  return entry;
}

function fromExcerpt(excerpt, owner, order) {
  const source = excerpt?.source;
  if (!source || !Array.isArray(excerpt.fields) || !Array.isArray(excerpt.coverage?.fields)
    || owner.projectId && owner.projectId !== source.projectId || owner.sessionId && owner.sessionId !== source.sessionId) return null;
  const entry = { source, order, shape: excerpt.coverage.fields.map(({ field, kind, sourceItems }) => ({ field, kind, sourceItems })),
    emptyValues: excerpt.emptyValues || {}, sourceContentCharacters: excerpt.coverage.sourceContentCharacters,
    checks: excerpt.referenceChecks || [], selectionRole: excerpt.selectionRole, units: [] };
  for (const [index, fragment] of excerpt.fields.entries()) {
    const unit = { entry, order: [index], fragment };
    entry.units.push(unit, ...children(unit));
  }
  return entry;
}

function excerptOf(entry, fields) {
  const coverage = entry.shape.map(shape => {
    let completeItems = 0, partialItems = 0;
    const count = shape.kind === "array" ? shape.sourceItems : 1;
    if (Object.hasOwn(entry.emptyValues, shape.field)) completeItems = count;
    else for (let index = 0; index < count; index++) {
      const path = ["content", shape.field, ...(shape.kind === "array" ? [index] : [])];
      const selected = fields.filter(field => samePath(field.path, path) || below(field.path, path));
      if (selected.some(field => samePath(field.path, path) && field.complete === true && !field.range)) completeItems++;
      else if (selected.length) partialItems++;
    }
    return { ...shape, completeItems, partialItems, omittedItems: Math.max(0, count - completeItems - partialItems),
      presence: Object.hasOwn(entry.emptyValues, shape.field) || fields.some(field => field.path[1] === shape.field) ? "included" : "omitted" };
  });
  const referenced = new Set(fields.filter(field => field.path[1] === "references" && Number.isInteger(field.path[2])).map(field => field.path[2]));
  const referenceChecks = entry.checks.filter(check => referenced.has(check.referenceIndex));
  return { kind: "SessionWorkOriginalExcerpt", authorityPlane: "P4", partial: true, source: entry.source,
    ...(entry.selectionRole ? { selectionRole: entry.selectionRole } : {}),
    ...(Object.keys(entry.emptyValues).length ? { emptyValues: entry.emptyValues } : {}), fields,
    ...(referenceChecks.length ? { referenceChecks } : {}),
    coverage: { sourceContentCharacters: entry.sourceContentCharacters, fields: coverage,
      referenceChecksShown: referenceChecks.length,
      conditionsMayBeOmitted: true, fullOriginalIncluded: false },
    expansion: { operation: publicToolName("head_session_work_read"), sameVerifiedProjectRoot: true,
      arguments: { session_id: entry.source.sessionId, evidence_ids: [entry.source.evidenceId], max_records: 1,
        max_characters: SESSION_WORK_MAX_CHARACTERS } } };
}

function canShorten(fragment) {
  if (typeof fragment.value !== "string") return false;
  const [, field, , subfield] = fragment.path;
  return ["summary", "observedWork", "pending", "unknowns", "suggestedFollowUp", "workTopics"].includes(field)
    || field === "judgments" && ["assessment", "reason", "alternatives"].includes(subfield)
    || field === "todos" && ["task", "nextAction", "reason", "progress", "priority"].includes(subfield);
}

const compareOrder = (left, right) => {
  for (let i = 0; i < Math.max(left.order.length, right.order.length); i++) {
    const difference = (left.order[i] ?? -1) - (right.order[i] ?? -1);
    if (difference) return difference;
  }
  return 0;
};

export function fitSessionWorkDelivery(work, { maxCharacters, fits = payload => workDeliveryCharacters(payload) <= maxCharacters,
  presentRecord = record => record } = {}) {
  const records = work.records || [], previous = work.recordExcerpts || [];
  const full = records.map(presentRecord);
  if (!previous.length && fits(delivery(full, []))) return { payload: delivery(full, []), includedIds: new Set(records.map(record => record.evidenceId)) };
  const entries = [], seen = new Set(), opaque = [];
  for (const [index, record] of records.entries()) {
    const entry = fromRecord(record, work, index);
    if (!entry) { opaque.push({ original: record, order: index }); continue; }
    entries.push(entry); seen.add(sourceKey(entry.source));
  }
  for (const excerpt of previous) {
    const entry = fromExcerpt(excerpt, work, entries.length);
    if (!entry || seen.has(sourceKey(entry.source))) continue;
    entries.push(entry); seen.add(sourceKey(entry.source));
  }
  const selected = new Map(entries.map(entry => [entry, []])), promoted = new Set(), opaqueIncluded = new Set();
  const render = () => delivery([...entries.filter(entry => promoted.has(entry)), ...opaque.filter(entry => opaqueIncluded.has(entry))]
    .sort((a, b) => a.order - b.order).map(entry => presentRecord(entry.original)),
    entries.filter(entry => !promoted.has(entry) && selected.get(entry).length)
      .map(entry => excerptOf(entry, [...selected.get(entry)].sort(compareOrder).map(unit => unit.fragment))));
  const offer = unit => {
    if (promoted.has(unit.entry)) return false;
    const current = selected.get(unit.entry);
    if (current.some(item => below(unit.fragment.path, item.fragment.path) && item.fragment.complete === true && !item.fragment.range)) return false;
    const next = current.filter(item => !samePath(item.fragment.path, unit.fragment.path)
      && !(unit.fragment.complete === true && !unit.fragment.range && below(item.fragment.path, unit.fragment.path)));
    next.push(unit); selected.set(unit.entry, next);
    if (fits(render())) return true;
    selected.set(unit.entry, current); return false;
  };
  // Structural packing, not semantic importance: try every complete small unit
  // before spending spare capacity on a long prefix. Display order stays original.
  const units = entries.flatMap(entry => entry.units).sort((a, b) => JSON.stringify(a.fragment).length - JSON.stringify(b.fragment).length
    || a.entry.order - b.entry.order || compareOrder(a, b));
  for (const unit of units) offer(unit);
  for (const unit of units.filter(unit => canShorten(unit.fragment))) {
    const current = selected.get(unit.entry);
    if (promoted.has(unit.entry) || current.some(item => samePath(item.fragment.path, unit.fragment.path)
      || below(unit.fragment.path, item.fragment.path) && item.fragment.complete === true && !item.fragment.range)) continue;
    const text = unit.fragment.value, boundaries = [0];
    for (const { index, segment } of segmenter.segment(text)) boundaries.push(index + segment.length);
    let low = 0, high = boundaries.length - 1, best = null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2), end = boundaries[middle];
      if (!end) { low = middle + 1; continue; }
      const start = unit.fragment.range?.start || 0;
      const candidate = { ...unit, fragment: { ...unit.fragment, value: text.slice(0, end), complete: false,
        range: { unit: "utf16-code-units", start, end: start + end,
          total: unit.fragment.range?.total ?? text.length } } };
      if (offer(candidate)) { best = candidate; selected.set(unit.entry, current); low = middle + 1; }
      else high = middle - 1;
    }
    if (best) offer(best);
  }
  // A fitting whole original is cheaper and stronger than its derived pieces.
  // Restore it only without evicting any other admitted evidence.
  for (const entry of entries.filter(entry => entry.original).sort((a, b) => JSON.stringify(a.original).length - JSON.stringify(b.original).length || a.order - b.order)) {
    promoted.add(entry);
    if (!fits(render())) promoted.delete(entry);
  }
  // Unsupported presentation shapes are never reinterpreted as verified
  // excerpts. Preserve a fitting whole returned value, as the old renderer did.
  for (const entry of opaque.sort((a, b) => JSON.stringify(a.original).length - JSON.stringify(b.original).length || a.order - b.order)) {
    opaqueIncluded.add(entry);
    if (!fits(render())) opaqueIncluded.delete(entry);
  }
  const payload = render();
  return { payload, includedIds: new Set([...payload.records.map(record => record.evidenceId), ...(payload.recordExcerpts || []).map(excerpt => excerpt.source.evidenceId)]) };
}
