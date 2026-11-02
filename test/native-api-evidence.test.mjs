import assert from "node:assert/strict";
import test from "node:test";
import {
  verifyCodexNativeApiHistory,
  readCodexNativeApiHistory,
} from "../scripts/lib/codex-native-api-evidence.mjs";

function fixture() {
  const item = {
    type: "agentMessage",
    id: "answer",
    text: "Preserve this original explanation.",
    phase: "final_answer",
  };
  const turn = {
    id: "turn",
    rootTurnId: null,
    status: "completed",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1000,
  };
  const expected = {
    threadId: "selected",
    turns: [turn],
    items: [{ turnId: "turn", item, startedAtMs: 1000, completedAtMs: 2000 }],
  };
  const actualItem = { ...item, memoryCitation: null, startedAtMs: 1000, completedAtMs: 2000 };
  const actual = {
    turns: [{ ...turn, itemsView: "full", items: [actualItem] }],
    items: [{ turnId: "turn", item: actualItem, startedAtMs: 1000, completedAtMs: 2000 }],
  };
  return { expected, actual };
}

test("SDK presentation additions preserve every original field, identity and time", () => {
  const { expected, actual } = fixture();
  const result = verifyCodexNativeApiHistory(expected, actual);
  assert.equal(result.originalFields, "preserved");
  assert.equal(result.grantsRecoveryAuthority, false);
  for (const mutate of [
    (view) => {
      view.items[0].item.text = "Replacement";
    },
    (view) => {
      delete view.items[0].item.phase;
    },
    (view) => {
      view.items[0].turnId = "foreign";
    },
    (view) => {
      view.turns[0].items[0].startedAtMs = 0;
    },
    (view) => {
      view.turns[0].items = [];
    },
    (view) => {
      view.items.push(structuredClone(view.items[0]));
    },
    (view) => {
      view.turns[0].status = "failed";
    },
  ]) {
    const changed = structuredClone(actual);
    mutate(changed);
    assert.throws(() => verifyCodexNativeApiHistory(expected, changed), {
      code: "NATIVE_CODEX_API_HISTORY_MISMATCH",
    });
  }
});

test("SDK pagination cannot hide missing evidence or create an unbounded repeated cursor", async () => {
  const { expected, actual } = fixture();
  let calls = 0;
  const rpc = {
    async request(method, params) {
      calls++;
      assert.equal(params.threadId, "selected");
      return {
        data: method === "thread/turns/list" ? actual.turns : actual.items,
        nextCursor: null,
      };
    },
  };
  assert.equal((await readCodexNativeApiHistory(rpc, expected)).itemCount, 1);
  assert.equal(calls, 2);
  for (const page of [
    { data: [], nextCursor: null },
    { data: [], nextCursor: "repeat" },
    { data: actual.turns, nextCursor: "repeat" },
  ]) {
    let count = 0;
    await assert.rejects(
      readCodexNativeApiHistory(
        {
          async request() {
            assert(++count <= 2);
            return page;
          },
        },
        expected,
      ),
      { code: "NATIVE_CODEX_API_HISTORY_MISMATCH" },
    );
  }
});
