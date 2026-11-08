import crypto from "node:crypto";
import { readSelectedCodexHistory, verifySelectedCodexHistory, codexNativePortabilityProfile } from "./codex-native-portability.mjs";
import { decodeSqliteCell } from "./native-sqlite-values.mjs";

const plans = new WeakMap(),
  profile = codexNativePortabilityProfile();
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const quote = (name) => '"' + name + '"'; // Only pinned profile identifiers reach SQL.
const cellKey = (cell) => {
  decodeSqliteCell(cell);
  if (cell.type === "null") return ["null"];
  if (cell.type === "integer") return [cell.type, cell.value];
  if (cell.type === "text") return [cell.type, cell.utf8];
  if (cell.type === "real") return [cell.type, cell.ieee754];
  return [cell.type, cell.base64];
};
const rowKey = (row) => JSON.stringify(row.map(cellKey));
function tableProfile(name) {
  return profile.databases.find((db) => db.file === "thread_history_1.sqlite").tables.find((table) => table.name === name);
}
function primaryKey(table, row) {
  const columns = tableProfile(table.name)
    .columns.filter((column) => column.pk)
    .sort((a, b) => a.pk - b.pk);
  return rowKey(columns.map((column) => row[table.columns.indexOf(column.name)]));
}
function fingerprint(history) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(history.tables.map((table) => ({ name: table.name, rows: table.rows.map(rowKey).sort() }))))
    .digest("hex");
}
function compare(source, target) {
  const missing = [];
  let equalRows = 0;
  for (const table of source.tables) {
    const expected = new Map(table.rows.map((row) => [primaryKey(table, row), row]));
    const observed = target.tables.find((item) => item.name === table.name);
    for (const row of observed.rows) {
      const key = primaryKey(table, row),
        original = expected.get(key);
      if (!original || rowKey(row) !== rowKey(original)) fail("NATIVE_CODEX_TARGET_HISTORY_DIVERGED");
      expected.delete(key);
      equalRows++;
    }
    for (const row of expected.values()) missing.push({ table: table.name, columns: [...table.columns], row: structuredClone(row) });
  }
  return { missing, equalRows };
}
// Pure planning over the caller's already-selected DB handle. No SQL from the
// payload is executed, no filesystem is opened and no transaction is committed.
export function planCodexNativeRowMerge(database, { history, ...basis }) {
  verifySelectedCodexHistory(history);
  const source = structuredClone(history),
    target = readSelectedCodexHistory(database, { ...basis, threadIds: source.threadIds });
  const comparison = compare(source, target),
    plan = Object.freeze(Object.create(null));
  plans.set(plan, {
    database,
    source,
    basis: structuredClone(basis),
    before: fingerprint(target),
    missing: comparison.missing,
  });
  return {
    plan,
    status: comparison.missing.length ? (comparison.equalRows ? "exact-partial" : "absent") : "equal",
    missingRows: comparison.missing.length,
    equalRows: comparison.equalRows,
    authorityPlane: "P4",
    nativeWriteAuthorized: false,
  };
}
// This is internal execution of a plan, not effect authorization. The Host
// orchestrator owns its current offline witness, journal, backup and transaction.
// It may commit only after exact raw/row/profile/writer reconciliation succeeds.
export function applyCodexNativeRowMerge(plan, database) {
  const saved = plans.get(plan);
  if (!saved || database !== saved.database) fail("NATIVE_CODEX_ROW_PLAN_REQUIRED");
  if (database.isTransaction !== true) fail("NATIVE_CODEX_HISTORY_TRANSACTION_REQUIRED");
  const current = readSelectedCodexHistory(database, {
    ...saved.basis,
    threadIds: saved.source.threadIds,
  });
  if (fingerprint(current) !== saved.before) fail("NATIVE_CODEX_TARGET_HISTORY_CHANGED");
  for (const entry of saved.missing) {
    const fixed = tableProfile(entry.table).columns.map((column) => column.name);
    if (JSON.stringify(fixed) !== JSON.stringify(entry.columns)) fail("NATIVE_CODEX_HISTORY_INVALID");
    database
      .prepare("INSERT INTO " + quote(entry.table) + " (" + fixed.map(quote).join(",") + ") VALUES (" + fixed.map(() => "?").join(",") + ")")
      .run(...entry.row.map(decodeSqliteCell));
  }
  const after = readSelectedCodexHistory(database, {
    ...saved.basis,
    threadIds: saved.source.threadIds,
  });
  if (compare(saved.source, after).missing.length) fail("NATIVE_CODEX_TARGET_HISTORY_INCOMPLETE");
  plans.delete(plan);
  return {
    status: "selected-history-rows-in-transaction",
    insertedRows: saved.missing.length,
    transactionCommitted: false,
    stateRowsWritten: 0,
    grantsRecoveryAuthority: false,
    restoresExecutionPermission: false,
  };
}
