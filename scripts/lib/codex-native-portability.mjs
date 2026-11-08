import fs from "node:fs";
import { readTypedSqliteRows, decodeSqliteCell } from "./native-sqlite-values.mjs";
import { sha256Json as sha } from "./core/digest.mjs";
import { failCode as fail } from "./core/errors.mjs";

const profile = JSON.parse(fs.readFileSync(new URL("./codex-native-portability-profile.json", import.meta.url), "utf8"));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const quote = (name) => {
  if (typeof name !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) fail("NATIVE_SQLITE_IDENTIFIER_INVALID");
  return '"' + name + '"';
};

export function codexNativePortabilityProfile() {
  return structuredClone(profile);
}

// A supported schema is evidence, never a stopped-writer or effect capability.
// Unknown versions still permit common Project preservation/inspection.
export function inspectCodexNativeDatabase(database, { file, engineVersion, platform, architecture } = {}) {
  if (engineVersion !== profile.engineVersion || platform !== profile.platform || architecture !== profile.architecture)
    fail("NATIVE_CODEX_PROFILE_UNSUPPORTED");
  const expected = profile.databases.find((item) => item.file === file);
  if (!expected) fail("NATIVE_CODEX_DATABASE_UNSUPPORTED");
  const schema = database
    .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
    .all()
    .map((row) => ({ ...row }));
  const userVersion = database.prepare("PRAGMA user_version").get().user_version;
  const applicationId = database.prepare("PRAGMA application_id").get().application_id;
  if (!equal(schema, expected.schema) || sha(schema) !== expected.ddlSha256 || userVersion !== expected.userVersion || applicationId !== expected.applicationId)
    fail("NATIVE_CODEX_SCHEMA_UNSUPPORTED");
  for (const table of expected.tables) {
    const actual = database
      .prepare("PRAGMA table_xinfo(" + quote(table.name) + ")")
      .all()
      .map((row) => ({ ...row }));
    if (!equal(actual, table.columns)) fail("NATIVE_CODEX_SCHEMA_UNSUPPORTED");
  }
  const statement = database.prepare("SELECT version,description,success,hex(checksum) AS checksum FROM _sqlx_migrations ORDER BY version");
  statement.setReadBigInts(true);
  const migrations = statement.all().map((row) => ({
    version: String(row.version),
    description: row.description,
    success: String(row.success),
    checksum: row.checksum,
  }));
  if (!equal(migrations, expected.migrations)) fail("NATIVE_CODEX_MIGRATIONS_UNSUPPORTED");
  if (database.prepare("PRAGMA quick_check").get().quick_check !== "ok") fail("NATIVE_CODEX_DATABASE_CORRUPT");
  if (database.prepare("PRAGMA foreign_key_check").all().length) fail("NATIVE_CODEX_DATABASE_CORRUPT");
  return {
    profileId: profile.profileId,
    file,
    ddlSha256: expected.ddlSha256,
    nativeWriteAuthorized: false,
    quiescence: "not-observed",
    coherentRawCutoff: "not-verified",
  };
}

export function readSelectedCodexHistory(database, { threadIds, ...basis } = {}) {
  inspectCodexNativeDatabase(database, { ...basis, file: "thread_history_1.sqlite" });
  if (
    !Array.isArray(threadIds) ||
    !threadIds.length ||
    new Set(threadIds).size !== threadIds.length ||
    threadIds.some((id) => typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))
  )
    fail("NATIVE_CODEX_THREAD_SELECTION_INVALID");
  const tables = profile.historyTables.map((name) => {
    const columns = profile.databases
      .find((db) => db.file === "thread_history_1.sqlite")
      .tables.find((table) => table.name === name)
      .columns.map((column) => column.name);
    const rows = threadIds.flatMap((threadId) =>
      readTypedSqliteRows(database, name, columns, {
        where: 'WHERE "thread_id" = ?',
        parameters: [threadId],
      }),
    );
    return { name, columns, rows };
  });
  verifySelectedCodexHistory({ tables, threadIds });
  return {
    profileId: profile.profileId,
    threadIds: [...threadIds],
    tables,
    authorityPlane: "P3",
    grantsRecoveryAuthority: false,
    nativeWriteAuthorized: false,
    coherentRawCutoff: "not-verified",
    quiescence: "not-observed",
  };
}

// SQLite has no FK on this engine's history tables. A same turn ID in another
// thread does not close an item's original (thread_id, turn_id) reference.
export function verifySelectedCodexHistory({ tables, threadIds }) {
  if (!Array.isArray(tables) || !Array.isArray(threadIds) || tables.length !== profile.historyTables.length) fail("NATIVE_CODEX_HISTORY_INVALID");
  const selected = new Set(threadIds),
    byName = new Map();
  for (const table of tables) {
    if (!profile.historyTables.includes(table?.name) || byName.has(table.name)) fail("NATIVE_CODEX_HISTORY_INVALID");
    const expected = profile.databases
      .find((db) => db.file === "thread_history_1.sqlite")
      .tables.find((item) => item.name === table.name)
      .columns.map((item) => item.name);
    if (!equal(table.columns, expected) || !Array.isArray(table.rows)) fail("NATIVE_CODEX_HISTORY_INVALID");
    const rows = table.rows.map((row) => {
      if (!Array.isArray(row) || row.length !== expected.length) fail("NATIVE_CODEX_HISTORY_INVALID");
      const object = Object.fromEntries(expected.map((key, index) => [key, decodeSqliteCell(row[index])]));
      if (!selected.has(object.thread_id)) fail("NATIVE_CODEX_HISTORY_CROSS_THREAD");
      return object;
    });
    const keyNames = profile.databases
      .find((db) => db.file === "thread_history_1.sqlite")
      .tables.find((item) => item.name === table.name)
      .columns.filter((item) => item.pk)
      .sort((a, b) => a.pk - b.pk)
      .map((item) => item.name);
    const keys = new Set();
    for (const row of rows) {
      const key = JSON.stringify(keyNames.map((name) => row[name]));
      if (keys.has(key)) fail("NATIVE_CODEX_HISTORY_DUPLICATE");
      keys.add(key);
    }
    byName.set(table.name, rows);
  }
  const turns = new Set(byName.get("thread_turns").map((row) => JSON.stringify([row.thread_id, row.turn_id])));
  for (const item of byName.get("thread_items")) {
    if (!turns.has(JSON.stringify([item.thread_id, item.turn_id]))) fail("NATIVE_CODEX_HISTORY_TURN_UNRESOLVED");
  }
  for (const row of byName.get("thread_history_projection_state")) {
    if (
      typeof row.next_rollout_byte_offset !== "bigint" ||
      row.next_rollout_byte_offset < 0n ||
      typeof row.next_rollout_ordinal !== "bigint" ||
      row.next_rollout_ordinal < 0n
    )
      fail("NATIVE_CODEX_HISTORY_OFFSET_INVALID");
  }
  return { status: "selected-row-references-verified", grantsRecoveryAuthority: false };
}
