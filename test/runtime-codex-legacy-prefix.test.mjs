import assert from "node:assert/strict";
import test from "node:test";
import { assertCodexControlledLegacyPrefix as verify } from "../scripts/lib/runtime-codex-legacy-prefix.mjs";

const seedInput = "controlled seed";
const user = { id: "uuid-user", type: "userMessage", content: [{ type: "text", text: seedInput }] };
const answer = { id: "uuid-answer", type: "agentMessage", text: "seed acknowledged", phase: "final_answer" };
const stored = (items) => items.map((item, index) => ({ ...structuredClone(item), id: `item-${index + 1}` }));
const check = (liveItems, storedItems = stored(liveItems)) => verify({ liveItems, storedItems, seedInput });
const rejects = (live, history) => assert.throws(() => check(live, history), { code: "CODEX_NATIVE_PREFIX_SOURCE_HISTORY_MISMATCH" });

test("legacy numbering, empty filtering, reasoning coalescing and raw omission follow the pinned projection", () => {
  const live = [
    user,
    { id: "empty", type: "reasoning", summary: [], content: [] },
    { id: "r1", type: "reasoning", summary: ["first", ""], content: ["private raw"] },
    { id: "empty-agent", type: "agentMessage", text: "" },
    { id: "r2", type: "reasoning", summary: [" ", "second"], content: ["raw2"] },
    answer,
  ];
  const history = stored([user, { type: "reasoning", summary: ["first", " ", "second"], content: [] }, answer]);
  check(live, history);
  for (const change of [(h) => h[1].summary.reverse(), (h) => h[1].content.push("private raw"), (h) => h[1].summary.splice(1, 1)]) {
    const changed = structuredClone(history);
    change(changed);
    rejects(live, changed);
  }
});

test("legacy segmentation preserves ordered text and all agent metadata, not unavailable chunk boundaries", () => {
  const agent = { ...answer, memoryCitation: { entries: [] }, delivery: { kind: "test" }, questions: [] };
  const live = [user, agent];
  const history = stored([user, { ...agent, text: "seed " }, { ...agent, text: "acknowledged" }]);
  check(live, history);
  for (const field of ["phase", "memoryCitation", "delivery", "questions"]) {
    const changed = structuredClone(history);
    changed[2][field] = null;
    rejects(live, changed);
  }
  for (const texts of [["acknowledged", "seed "], ["seed ", "seed "], ["seed ", "acknowledged!"], ["seed "]]) {
    rejects(live, stored([user, ...texts.map((text) => ({ ...agent, text }))]));
  }
  rejects([user, { ...answer, text: "seed " }, { ...answer, id: "second", text: "acknowledged" }], stored([user, answer]));
  check(
    [user, answer],
    stored([
      { ...user, clientId: null, content: [{ type: "text", text: seedInput, text_elements: [] }] },
      { ...answer, memoryCitation: null, delivery: null, questions: null },
    ]),
  );
});

test("seed input, count, order, stored IDs and exact field set cannot be weakened", () => {
  const live = [user, answer];
  check(live);
  for (const change of [
    (h) => (h[0].content[0].text += "!"),
    (h) => h.reverse(),
    (h) => h.pop(),
    (h) => h.push({ ...h[1], id: "item-3" }),
    (h) => (h[1].id = "uuid-answer"),
    (h) => (h[1].id = "item-3"),
    (h) => (h[1].id = "item-1"),
    (h) => (h[1].extra = true),
    (h) => (h[1].type = "commandExecution"),
    (h) => (h[0].clientId = "other"),
    (h) => (h[0].content[0].text_elements = [{ start: 0 }]),
  ]) {
    const history = stored(live);
    change(history);
    rejects(live, history);
  }
  for (const changed of [
    [answer],
    [answer, user],
    [user, { ...user, id: "other-user" }, answer],
    [user, answer, answer],
    [null],
    [user, { id: "tool", type: "commandExecution" }, answer],
  ])
    rejects(changed, stored(live));
});
