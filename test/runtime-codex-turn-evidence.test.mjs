import assert from "node:assert/strict";
import test from "node:test";
import { assertCodexProposalCompletion } from "../scripts/lib/runtime-codex-turn-evidence.mjs";

test("summary/notLoaded corroborate direct evidence without pretending to contain full history", () => {
  const reasoning = { id: "reasoning", type: "reasoning", summary: [], content: [] };
  const answer = { id: "answer", type: "agentMessage", text: "selected result", phase: "final_answer" };
  const direct = new Map([
    [reasoning.id, reasoning],
    [answer.id, answer],
  ]);
  const turn = { id: "turn", status: "completed", error: null, itemsView: "summary", items: [answer] };
  assert.equal(assertCodexProposalCompletion(turn, direct), "summary");
  assert.equal(direct.size, 2);
  assert.equal(turn.items.length, 1);
  assert.equal(assertCodexProposalCompletion({ ...turn, itemsView: "notLoaded", items: [] }, direct), "notLoaded");
  assert.equal(assertCodexProposalCompletion({ ...turn, itemsView: "full", items: [reasoning, answer] }, direct), "full");
  const missing = new Map([[reasoning.id, reasoning]]);
  for (const [changed, evidence] of [
    [turn, missing],
    [{ ...turn, items: [{ ...answer, text: "changed" }] }, direct],
    [{ ...turn, items: [{ ...answer, id: "different" }] }, direct],
    [{ ...turn, itemsView: "notLoaded" }, direct],
    [{ ...turn, itemsView: "full" }, direct],
    [{ ...turn, items: [answer, answer] }, direct],
    [{ ...turn, itemsView: "unknown" }, direct],
    [{ ...turn, status: "failed" }, direct],
    [{ ...turn, error: { message: "failed" } }, direct],
  ])
    assert.throws(() => assertCodexProposalCompletion(changed, evidence), { code: "CODEX_PROPOSAL_TERMINAL_EVIDENCE_MISMATCH" });
  assert.equal(missing.has(answer.id), false, "terminal summary never adds an unobserved result");
});
