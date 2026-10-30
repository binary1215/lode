import { SESSION_WORK_DEFAULT_CHARACTERS as DEFAULT, SESSION_WORK_MAX_CHARACTERS as MAXIMUM } from "./session-work-evidence-original.mjs";

export const isWorkNode = node => node.kind === "Evidence" && node.subtype === "SessionWorkEvidence";
export function workTextEntries(content) {
  const entries = [], add = (text, field, index = null, subfield = null, alternativeIndex = undefined, context = {}) => {
    if (typeof text === "string") entries.push({ text, field, index, subfield, ...(alternativeIndex === undefined ? {} : { alternativeIndex }), ...context });
  };
  add(content.summary, "summary");
  for (const [index, item] of content.judgments.entries()) {
    add(item.assessment, "judgments", index, "assessment"); add(item.reason, "judgments", index, "reason");
    item.alternatives.forEach((text, alternativeIndex) => add(text, "judgments", index, "alternatives", alternativeIndex));
  }
  for (const field of ["observedWork", "pending", "unknowns", "suggestedFollowUp"]) content[field].forEach((text, index) => add(text, field, index));
  (content.workTopics || []).forEach((text, index) => add(text, "workTopics", index));
  for (const [index, todo] of (content.todos || []).entries()) {
    const context = { todoId: todo.todoId, status: todo.status, origin: todo.origin,
      ...Object.fromEntries(["prior", "resolves", "relatedEvidence"].filter(key => Object.hasOwn(todo, key)).map(key => [key, todo[key]])) };
    for (const field of ["task", "status", "origin", "nextAction", "reason", "progress", "priority"]) add(todo[field], "todos", index, field, undefined, context);
  }
  return entries;
}
const characters = content => workTextEntries(content).reduce((n, entry) => n + entry.text.length, 0);
const cost = content => JSON.stringify({ workContent: content, workContentExcerpts: [] }).length;
function coverage(content, included, partial, extra = {}, projected = content, excerpts = []) {
  const total = characters(content);
  const fieldItems = {};
  for (const field of ["summary", "judgments", "observedWork", "pending", "unknowns", "suggestedFollowUp", ...(content.workTopics === undefined ? [] : ["workTopics"]), ...(content.todos === undefined ? [] : ["todos"])]) {
    const originalItems = field === "summary" ? Number(typeof content.summary === "string") : content[field].length;
    const completeItems = field === "summary" ? Number(typeof projected.summary === "string") : (projected[field] || []).length;
    const partialItems = new Set(excerpts.filter(entry => entry.field === field).map(entry => entry.index)).size;
    fieldItems[field] = { originalItems, completeItems, partialItems, omittedItems: originalItems - completeItems - partialItems };
  }
  return { partial, scope: "selected-original-semantic-text; references-and-event-selectors-not-counted",
    totalCharacters: total, includedCharacters: included, omittedCharacters: total - included,
    fieldItems, rangeSource: "workContentExcerpts", ...extra };
}
function partialBody(node, capacity, terms) {
  const original = node.workContent;
  if (cost(original) <= capacity) return { ...node, workContentCoverage: coverage(original, characters(original), false), contentPartial: false };
  const content = { ...(original.summary === null ? { summary: null } : {}), judgments: [], observedWork: [], pending: [], unknowns: [], suggestedFollowUp: [], references: [],
    ...(original.todos ? { todos: [] } : {}),
    ...(original.occurrenceKey === null ? { occurrenceKey: null } : {}),
    ...(original.workLink ? { workLink: original.workLink } : {}), ...(original.executionObservation ? { executionObservation: original.executionObservation } : {}) };
  const excerpts = [], entries = workTextEntries(original);
  const matchAt = text => {
    for (const term of terms) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), found = new RegExp(escaped, "iu").exec(text);
      if (found) return found.index;
    }
    return -1;
  };
  const matchedJudgment = entries.find(entry => entry.field === "judgments" && matchAt(entry.text) >= 0)?.index;
  const chosenJudgment = matchedJudgment ?? (original.judgments.length ? 0 : null);
  const chosenTodo = entries.find(entry => entry.field === "todos" && matchAt(entry.text) >= 0)?.index ?? (original.todos?.length ? 0 : null);
  const primary = entries.filter(entry => entry.field === "judgments" && entry.index === chosenJudgment
    || entry.field === "todos" && entry.index === chosenTodo
    || ["pending", "unknowns"].includes(entry.field) && entry.index === 0);
  const ordered = [...primary, ...entries.filter(entry => !primary.includes(entry))];
  let included = 0, spent = cost(content), firstPassRemaining = primary.length;
  const completeJudgments = new Map();
  for (const entry of ordered) {
    const remaining = capacity - spent;
    if (remaining <= 0) break;
    const divisor = primary.includes(entry) ? Math.max(1, firstPassRemaining--) : 1;
    // Space belongs to this response, not a fixed cap on each reason/sentence.
    const allowance = Math.floor(remaining / divisor);
    const limit = Math.min(capacity, spent + allowance);
    const length = Math.min(entry.text.length, Math.max(0, allowance - JSON.stringify({ ...entry, text: "", start: 0, end: 0, totalCharacters: entry.text.length }).length));
    if (!length && entry.text.length) continue;
    const hit = matchAt(entry.text);
    const candidate = size => {
      let start = Math.max(0, Math.min(entry.text.length - size, hit < 0 ? 0 : hit - Math.floor(size / 2)));
      if (start && /[\uDC00-\uDFFF]/u.test(entry.text[start])) start--;
      let end = Math.min(entry.text.length, start + size);
      if (end < entry.text.length && /[\uDC00-\uDFFF]/u.test(entry.text[end])) end--;
      if (size && end === start) return null;
      const all = start === 0 && end === entry.text.length;
      const nextContent = { ...content }, nextExcerpts = [...excerpts];
      // Topics in a partial projection retain their exact original index/range,
      // even when an individual label fits whole; no compacted-array aliasing.
      if (all && !["judgments", "workTopics", "todos"].includes(entry.field)) {
        if (entry.field === "summary") nextContent.summary = entry.text;
        else nextContent[entry.field] = [...content[entry.field], entry.text];
      } else nextExcerpts.push({ ...entry, text: entry.text.slice(start, end), start, end, totalCharacters: entry.text.length });
      return { content: nextContent, excerpts: nextExcerpts, start, end, all,
        cost: JSON.stringify({ workContent: nextContent, workContentExcerpts: nextExcerpts }).length };
    };
    let fitted = candidate(length);
    if (!fitted || fitted.cost > limit) {
      // Raw characters undercount escaped JSON. Fit an exact original range
      // before committing it rather than dropping the whole useful field.
      fitted = null;
      let low = 1, high = length - 1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2), attempt = candidate(middle);
        if (attempt && attempt.cost <= limit) { fitted = attempt; low = middle + 1; }
        else high = middle - 1;
      }
    }
    if (!fitted) continue;
    const { start, end, all } = fitted;
    Object.assign(content, fitted.content); excerpts.splice(0, excerpts.length, ...fitted.excerpts);
    spent = fitted.cost; included += end - start;
    if (entry.field === "judgments" && all) {
      if (!completeJudgments.has(entry.index)) completeJudgments.set(entry.index, []);
      completeJudgments.get(entry.index).push(entry);
    }
  }
  // Complete tuples can use the familiar original shape. Partial tuples keep
  // their exact source indices/subfields in excerpts, including the assessment.
  for (const [index, fields] of completeJudgments) {
    const judgment = original.judgments[index];
    if (fields.length !== judgment.alternatives.length + 2) continue;
    const group = excerpts.filter(entry => entry.field === "judgments" && entry.index === index);
    const keep = excerpts.filter(entry => !group.includes(entry));
    const next = { ...content, judgments: [...content.judgments, judgment] };
    if (JSON.stringify({ workContent: next, workContentExcerpts: keep }).length <= capacity) {
      content.judgments.push(judgment); excerpts.splice(0, excerpts.length, ...keep);
    }
  }
  return { ...node, workContent: content, workContentExcerpts: excerpts,
    workContentCoverage: coverage(original, included, true, { omittedReferenceCount: original.references.length,
      occurrenceKeyOmitted: original.occurrenceKey !== null,
      ...(original.todos ? { includedTodoIndices: [...new Set(excerpts.filter(entry => entry.field === "todos").map(entry => entry.index))],
        todoProvenance: "Original record/index/ID and declared selectors only; prior/reference validity and current task state are not inferred." } : {}),
      includedJudgmentIndices: [...completeJudgments].filter(([index, fields]) => fields.length === original.judgments[index].alternatives.length + 2).map(([index]) => index) }, content, excerpts),
    contentPartial: true };
}

export function presentSessionWorkContent(nodes, { details = false, query = "" } = {}) {
  const work = nodes.filter(isWorkNode);
  if (!work.length) return nodes;
  const full = node => ({ ...node, workContentCoverage: coverage(node.workContent, characters(node.workContent), false), contentPartial: false });
  if (work.length === 1) return nodes.map(node => isWorkNode(node) ? full(node) : node);
  const sizes = new Map(work.map(node => [node, cost(node.workContent)]));
  const small = work.filter(node => (node.originalExpansion?.arguments?.max_characters ?? MAXIMUM + 1) <= DEFAULT);
  const smallTotal = small.reduce((n, node) => n + sizes.get(node), 0);
  const total = work.reduce((n, node) => n + sizes.get(node), 0);
  const budget = details ? Math.min(total, MAXIMUM) : Math.min(MAXIMUM, Math.max(DEFAULT, smallTotal + Math.min(DEFAULT, total - smallTotal)));
  if (total <= budget) return nodes.map(node => isWorkNode(node) ? full(node) : node);
  const retainSmall = smallTotal <= budget - Math.min(DEFAULT, total - smallTotal);
  const complete = new Set(retainSmall ? small : []), partial = work.filter(node => !complete.has(node));
  let remaining = budget - (retainSmall ? smallTotal : 0), pending = partial.length;
  const terms = query.match(/[\p{L}\p{N}_$]+/gu) || [];
  const byNode = new Map();
  for (const node of partial) {
    const share = Math.floor(remaining / pending--), projected = partialBody(node, share, terms);
    remaining -= JSON.stringify({ workContent: projected.workContent, workContentExcerpts: projected.workContentExcerpts }).length;
    byNode.set(node, projected);
  }
  return nodes.map(node => !isWorkNode(node) ? node : complete.has(node) ? full(node) : byNode.get(node));
}
