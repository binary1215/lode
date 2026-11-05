// Notification views are not interchangeable with persisted full history.
// Results come from exact direct item/completed events; terminal items only
// corroborate those events and never fill a missing result or claim coverage.
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const sameCodexItemEvidence = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
export function assertCodexProposalCompletion(turn, directItems) {
  const fail = () => { throw Object.assign(new Error("Terminal view does not corroborate direct item evidence"), { code: "CODEX_PROPOSAL_TERMINAL_EVIDENCE_MISMATCH" }); };
  // The pinned schema defaults an omitted itemsView to full, not summary.
  const view = turn?.itemsView === undefined ? "full" : turn.itemsView;
  if (turn?.status !== "completed" || turn.error != null || !Array.isArray(turn.items)
    || !["full", "summary", "notLoaded"].includes(view)) fail();
  if (view === "notLoaded" && turn.items.length !== 0
    || view === "summary" && (turn.items.length !== 1 || turn.items[0]?.type !== "agentMessage")
    || view === "full" && turn.items.length !== directItems.size) fail();
  const ids = new Set();
  for (const item of turn.items) {
    if (!item || typeof item.id !== "string" || ids.has(item.id) || !directItems.has(item.id)
      || !sameCodexItemEvidence(item, directItems.get(item.id))) fail();
    ids.add(item.id);
  }
  return view;
}
