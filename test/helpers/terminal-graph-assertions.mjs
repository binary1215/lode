import assert from "node:assert/strict";
import { formatTerminalGraph, terminalBlock, inertTerminalText } from "../../scripts/lib/terminal-graph.mjs";

// The CLI intentionally has a relationship-first display, unlike MCP text.
// Check its visible originals/qualifiers and exact diagnostic payload separately.
export function assertTerminalGraphPresentation(text, value) {
  const before = JSON.stringify(value), sessions = new Map(), sections = [];
  for (const node of value.nodes) {
    const id = node?.sessionId || node?.ownerSessionId;
    if (id && !sessions.has(id)) sessions.set(id, `S${sessions.size + 1}`);
  }
  const block = (section, label, body) => {
    if (body != null) assert(section.includes(terminalBlock(label, body).trimEnd()), `Missing visible ${label}: ${body}`);
  };
  const list = (section, label, items) => { for (const item of items || []) block(section, label, typeof item === "string" ? item : JSON.stringify(item)); };
  for (const [index, node] of value.nodes.entries()) {
    const heading = `\n[${index + 1}] `, start = text.indexOf(heading);
    assert(start >= 0, `Missing original-index record [${index + 1}]`);
    assert.equal(text.split(heading).length - 1, 1, "Each selected record appears once");
    const next = text.indexOf(`\n[${index + 2}] `, start + heading.length);
    const section = text.slice(start, next < 0 ? undefined : next); sections.push(section);
    const sessionId = node.sessionId || node.ownerSessionId;
    if (sessionId) assert(section.includes(`Logical Session ${sessions.get(sessionId)}`), "Exact owners have distinct stable display aliases");
    for (const key of ["reviewState", "freshness", "status", "state", "disposition", "applicationStatus", "sourceCurrentness"])
      if (typeof node[key] === "string" && node[key]) assert(section.includes(inertTerminalText(node[key])), `Missing ${key}`);
    if (node.contentPartial || node.workContentCoverage?.partial) assert(section.includes("partial text"));
    if (node.workContent) {
      const content = node.workContent;
      block(section, "Recorded work", content.summary);
      for (const [label, key] of [["Authored topic (navigation only)", "workTopics"], ["Observed work", "observedWork"], ["Pending", "pending"], ["Unknown", "unknowns"],
        ["Suggested follow-up (historical; not permission)", "suggestedFollowUp"]]) list(section, label, content[key]);
      for (const judgment of content.judgments || []) {
        block(section, "Recorded judgment", judgment.assessment); block(section, "Recorded reason (not proven cause)", judgment.reason); list(section, "Alternative", judgment.alternatives);
      }
      for (const [index, todo] of (content.todos || []).entries()) {
        block(section, `Recorded Todo ${index}`, `${todo.todoId} [${todo.status}; ${todo.origin}] — historical declaration`);
        block(section, "Task", todo.task);
        for (const key of ["nextAction", "reason", "progress", "priority", "prior", "resolves", "relatedEvidence"]) if (Object.hasOwn(todo, key)) {
          block(section, key, typeof todo[key] === "string" ? todo[key] : JSON.stringify(todo[key]));
        }
      }
    }
    for (const excerpt of node.workContentExcerpts || []) {
      const location = `${excerpt.field}${excerpt.index == null ? "" : `[${excerpt.index}]`}${excerpt.subfield ? `.${excerpt.subfield}` : ""}${excerpt.alternativeIndex == null ? "" : `[${excerpt.alternativeIndex}]`}`
        + (excerpt.field === "todos" ? ` · ${excerpt.todoId} [${excerpt.status}; ${excerpt.origin}]` : "");
      block(section, `Partial original ${location}: characters ${excerpt.start}-${excerpt.end} of ${excerpt.totalCharacters}`, excerpt.text);
    }
    for (const reference of node.referenceEvidence || []) {
      block(section, "Historical reference (not reconstructed content)", [reference.path, reference.kind, reference.status, reference.currentness, reference.reasonCode,
        reference.historicalContentAvailable === false ? "historical content unavailable" : null,
        reference.contentReconstructed === false ? "content not reconstructed" : null].filter(Boolean).join("; "));
    }
  }
  if (value.sourceFallback?.needed) {
    assert(text.includes("Source follow-up needed for this selection; not a new approval gate."));
    block(text, "Source follow-up", value.sourceFallback.action); list(text, "Source gap", value.sourceFallback.reasonCodes);
  }
  const diagnostic = formatTerminalGraph(value, { diagnostics: true });
  assert(diagnostic.includes(terminalBlock("Exact result diagnostics (display only)", JSON.stringify(value, null, 2)).trimEnd()), "All unknown fields, owners, IDs, original ranges and conditions remain exact in diagnostics");
  assert.equal(JSON.stringify(value), before, "Neither presentation may mutate source evidence");
  return { sections, sessions };
}
