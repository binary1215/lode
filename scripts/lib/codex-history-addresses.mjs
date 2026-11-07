import { isDeepStrictEqual as equal } from "node:util";
import { readTypedSqliteRows, decodeSqliteCell } from "./native-sqlite-values.mjs";
import { codexNativePortabilityProfile } from "./codex-native-portability.mjs";

const profile = codexNativePortabilityProfile();
const specs = Object.freeze({
  thread_history_projection_state: ["thread_id", "next_rollout_byte_offset", "next_rollout_ordinal"],
  thread_turns: ["thread_id", "turn_id", "rollout_ordinal", "rollout_byte_offset", "rollout_end_ordinal", "rollout_end_byte_offset"],
  thread_items: ["thread_id", "turn_id", "item_id", "rollout_ordinal", "updated_at_ordinal"],
  thread_realtime_items: ["thread_id", "item_id", "rollout_ordinal"],
});
const fail = () => { throw Object.assign(new Error("CODEX_HISTORY_ADDRESS_EVIDENCE_INVALID"), { code: "CODEX_HISTORY_ADDRESS_EVIDENCE_INVALID" }); };
const id = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);

// The caller verifies the installed SQLite schema/read snapshot first. Live
// physical-history transfer needs addresses, not a second copy of every item
// payload. Exact raw prefixes remain the original bodies. This is explicitly
// NOT canonical item-row capture or canonical/rollout content equivalence.
export function readCodexHistoryAddresses(database, threadIds) {
  const tables = Object.entries(specs).map(([name, columns]) => ({ name, columns: [...columns], rows: threadIds.flatMap(threadId =>
    readTypedSqliteRows(database, name, columns, { where: 'WHERE "thread_id" = ?', parameters: [threadId] })) }));
  const evidence = { kind: "CodexSelectedHistoryAddressEvidence", schemaVersion: 1, profileId: profile.profileId, threadIds: [...threadIds], tables,
    authorityPlane: "P3", grantsRecoveryAuthority: false, nativeWriteAuthorized: false, canonicalRowBodiesCaptured: false,
    canonicalRowContentsEquivalent: false, originalBodySource: "selected-physical-rollout-prefixes" };
  verifyCodexHistoryAddresses(evidence); return evidence;
}
export function verifyCodexHistoryAddresses(evidence) {
  const { tables, threadIds } = evidence ?? {};
  if (evidence?.kind !== "CodexSelectedHistoryAddressEvidence" || evidence.schemaVersion !== 1 || evidence.profileId !== profile.profileId
    || evidence.authorityPlane !== "P3" || evidence.grantsRecoveryAuthority !== false || evidence.nativeWriteAuthorized !== false
    || evidence.canonicalRowBodiesCaptured !== false || evidence.canonicalRowContentsEquivalent !== false
    || evidence.originalBodySource !== "selected-physical-rollout-prefixes" || !Array.isArray(threadIds) || !threadIds.length
    || threadIds.some(value => !id(value)) || new Set(threadIds).size !== threadIds.length
    || !Array.isArray(tables) || tables.length !== Object.keys(specs).length || new Set(tables.map(t => t.name)).size !== tables.length) fail();
  const decoded = new Map();
  for (const table of tables) {
    if (!equal(table.columns, specs[table.name]) || !Array.isArray(table.rows)) fail();
    const seen = new Set(), values = [];
    for (const row of table.rows) {
      if (!Array.isArray(row) || row.length !== table.columns.length) fail();
      const value = Object.fromEntries(table.columns.map((c, i) => [c, decodeSqliteCell(row[i])]));
      if (!threadIds.includes(value.thread_id)) fail();
      for (const c of table.columns.filter(c => /(?:ordinal|offset)$/u.test(c)))
        if (!(value[c] === null && (c.startsWith("rollout_end_") || c === "rollout_byte_offset") || typeof value[c] === "bigint" && value[c] >= 0n)) fail();
      const key = JSON.stringify([value.thread_id, value.item_id ?? value.turn_id ?? null]);
      if (seen.has(key)) fail(); seen.add(key); values.push(value);
    }
    decoded.set(table.name, values);
  }
  const turns = new Set(decoded.get("thread_turns").map(v => JSON.stringify([v.thread_id, v.turn_id])));
  for (const row of decoded.get("thread_items")) if (!turns.has(JSON.stringify([row.thread_id, row.turn_id]))) fail();
  return decoded;
}
