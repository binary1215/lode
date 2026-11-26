import { decodeSqliteCell } from "../core/native-sqlite-values.mjs";
import { verifySelectedCodexHistory } from "./codex-native-portability.mjs";
import { sha256Json as digest } from "../core/digest.mjs";

const fail = () => {
  throw Object.assign(new Error("Native SDK view does not preserve the selected source history."), {
    code: "NATIVE_CODEX_API_HISTORY_MISMATCH",
  });
};

// The versioned SDK adds null/default presentation fields. Every original JSON
// field must remain equal; an added presentation field is not a source rewrite.
function containsOriginal(actual, original) {
  if (original === null || typeof original !== "object") return Object.is(actual, original);
  if (Array.isArray(original))
    return Array.isArray(actual) && actual.length === original.length && original.every((value, index) => containsOriginal(actual[index], value));
  return (
    actual !== null &&
    typeof actual === "object" &&
    !Array.isArray(actual) &&
    Object.keys(original).every((key) => Object.hasOwn(actual, key) && containsOriginal(actual[key], original[key]))
  );
}
function safeNumber(value) {
  if (value === null) return null;
  if (typeof value !== "bigint" || value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) fail();
  return Number(value);
}

export function codexNativeApiExpectation(history, threadId) {
  verifySelectedCodexHistory(history);
  if (!history.threadIds.includes(threadId)) fail();
  const rows = (name) => {
    const table = history.tables.find((entry) => entry.name === name);
    return table.rows
      .map((row) => Object.fromEntries(table.columns.map((key, index) => [key, decodeSqliteCell(row[index])])))
      .filter((row) => row.thread_id === threadId);
  };
  // Realtime attachment views need their own measured SDK profile. Original
  // bytes remain exportable; this does not stop common Core work or raw capture.
  if (rows("thread_realtime_items").length)
    throw Object.assign(new Error("Realtime SDK attachment view is not measured by this profile."), { code: "NATIVE_CODEX_API_VIEW_UNSUPPORTED" });
  const items = rows("thread_items").map((row) => {
    let item;
    try {
      item = JSON.parse(row.item_json);
    } catch {
      fail();
    }
    if (!item || item.id !== row.item_id || item.type !== row.item_type) fail();
    return {
      turnId: row.turn_id,
      item,
      startedAtMs: safeNumber(row.started_at_ms),
      completedAtMs: safeNumber(row.completed_at_ms),
    };
  });
  const turns = rows("thread_turns").map((row) => {
    let error = null;
    try {
      error = row.error_json === null ? null : JSON.parse(row.error_json);
    } catch {
      fail();
    }
    return {
      id: row.turn_id,
      rootTurnId: row.root_turn_id,
      status: row.status,
      error,
      startedAt: safeNumber(row.started_at),
      completedAt: safeNumber(row.completed_at),
      durationMs: safeNumber(row.duration_ms),
    };
  });
  return { threadId, turns, items };
}

export function verifyCodexNativeApiHistory(expectation, { turns, items }) {
  if (!Array.isArray(turns) || !Array.isArray(items) || turns.length !== expectation.turns.length || items.length !== expectation.items.length) fail();
  const indexed = (values, key) => {
    const map = new Map();
    for (const value of values) {
      const id = key(value);
      if (typeof id !== "string" || map.has(id)) fail();
      map.set(id, value);
    }
    return map;
  };
  const byTurn = indexed(turns, (value) => value?.id),
    byItem = indexed(items, (value) => value?.item?.id);
  for (const expected of expectation.turns) {
    const actual = byTurn.get(expected.id);
    if (!containsOriginal(actual, expected) || actual.itemsView !== "full" || !Array.isArray(actual.items)) fail();
    const originals = expectation.items.filter((item) => item.turnId === expected.id);
    if (actual.items.length !== originals.length) fail();
    const nested = indexed(actual.items, (value) => value?.id);
    for (const item of originals) {
      const projected = nested.get(item.item.id);
      if (!containsOriginal(projected, item.item) || projected.startedAtMs !== item.startedAtMs || projected.completedAtMs !== item.completedAtMs) fail();
    }
  }
  for (const expected of expectation.items) {
    const actual = byItem.get(expected.item.id);
    if (!containsOriginal(actual, expected)) fail();
  }
  return {
    threadId: expectation.threadId,
    turnCount: turns.length,
    itemCount: items.length,
    originalFields: "preserved",
    evidenceDigest: digest({ threadId: expectation.threadId, turns, items }),
    authorityPlane: "P4",
    grantsRecoveryAuthority: false,
  };
}

export async function readCodexNativeApiHistory(rpc, expectation) {
  const collect = async (method, count, extra = {}) => {
    let cursor = null;
    const seen = new Set(),
      values = [];
    do {
      const page = await rpc.request(method, {
        threadId: expectation.threadId,
        limit: 100,
        ...extra,
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(page?.data) || page.data.length > 100 || (page.nextCursor != null && typeof page.nextCursor !== "string")) fail();
      values.push(...page.data);
      if (values.length > count || (page.nextCursor && (!page.data.length || seen.has(page.nextCursor)))) fail();
      cursor = page.nextCursor;
      if (cursor) seen.add(cursor);
    } while (cursor);
    return values;
  };
  const turns = await collect("thread/turns/list", expectation.turns.length, { itemsView: "full" });
  const items = await collect("thread/items/list", expectation.items.length);
  return verifyCodexNativeApiHistory(expectation, { turns, items });
}
