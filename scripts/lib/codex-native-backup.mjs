import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { iterateSqliteStorageRows } from "./native-sqlite-values.mjs";
import { inspectCodexNativeDatabase, codexNativePortabilityProfile } from "./codex-native-portability.mjs";
const profile = codexNativePortabilityProfile().databases.find((db) => db.file === "thread_history_1.sqlite");
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
export const nativeSqlitePath = (file) => (process.platform === "win32" ? path.toNamespacedPath(file) : file);

// A streamed logical digest of the complete before-history DB. No row values
// are logged, copied to Core or accumulated in memory. Only pinned table and
// column identifiers are used; SQL/DDL from a payload is never executed.
export function codexNativeHistoryDigest(database, basis, { signal } = {}) {
  inspectCodexNativeDatabase(database, { ...basis, file: "thread_history_1.sqlite" });
  const digest = crypto.createHash("sha256").update("native-before-history-raw-cell-v1\n");
  for (const table of profile.tables) {
    const columns = table.columns.map((column) => column.name),
      orderBy = table.columns
        .filter((column) => column.pk)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name);
    digest.update(JSON.stringify([table.name, columns]) + "\n");
    for (const row of iterateSqliteStorageRows(database, table.name, columns, { orderBy })) {
      if (signal?.aborted) fail("NATIVE_CODEX_PUBLICATION_CANCELLED");
      digest.update(JSON.stringify(row) + "\n");
    }
  }
  return digest.digest("hex");
}
export function verifyCodexNativeBeforeBackup(file, basis, expectedBeforeDigest) {
  const db = new DatabaseSync(nativeSqlitePath(file), { readOnly: true });
  let primary = null;
  try {
    const digest = codexNativeHistoryDigest(db, basis);
    if (digest !== expectedBeforeDigest) fail("NATIVE_CODEX_BACKUP_BEFORE_STATE_MISMATCH");
    return digest;
  } catch (error) {
    primary = error;
    error.nativeStage = "backup-validation";
    throw error;
  } finally {
    try {
      db.close();
    } catch (error) {
      if (primary) primary.nativeCleanupFailure = error.code || "NATIVE_CODEX_DATABASE_CLOSE_FAILED";
      else throw error;
    }
  }
}
