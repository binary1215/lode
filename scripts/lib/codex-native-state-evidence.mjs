import { codexNativePortabilityProfile } from "./codex-native-portability.mjs";
import { readTypedSqliteRows, decodeSqliteCell } from "./native-sqlite-values.mjs";
const profile = codexNativePortabilityProfile();
const omittedFields = ["creator_user_id", "creator_account_id"];
const columns = profile.databases
  .find((db) => db.file === "state_5.sqlite")
  .tables.find((table) => table.name === "threads")
  .columns.map((column) => column.name)
  .filter((column) => !omittedFields.includes(column));
const fail = () => {
  throw Object.assign(new Error("Selected native state evidence is invalid."), {
    code: "NATIVE_CODEX_STATE_EVIDENCE_INVALID",
  });
};

// Historical typed projection only. Explicit column selection never reads the
// two account selector values. No row is inserted into the destination state DB
// and no old source policy is a default for destination runtime policy.
export function readSelectedCodexStateEvidence(database, threadIds) {
  const rows = threadIds.flatMap((id) =>
    readTypedSqliteRows(database, "threads", columns, {
      where: 'WHERE "id" = ?',
      parameters: [id],
    }),
  );
  return selectedEvidence(rows, threadIds);
}

function selectedEvidence(rows, threadIds) {
  const evidence = {
    schemaVersion: 1,
    kind: "SelectedCodexStateEvidence",
    authorityPlane: "P3",
    columns: [...columns],
    rows,
    omittedFields: [...omittedFields],
    scope:
      "typed projection of selected source state fields; not full original-row byte equivalence",
    targetPolicyAuthority: false,
    grantsRecoveryAuthority: false,
  };
  verifySelectedCodexStateEvidence(evidence, threadIds);
  return evidence;
}
export function verifySelectedCodexStateEvidence(evidence, threadIds) {
  if (!Array.isArray(threadIds) || new Set(threadIds).size !== threadIds.length) fail();
  const requested = new Set(threadIds);
  if (
    evidence?.schemaVersion !== 1 ||
    evidence.kind !== "SelectedCodexStateEvidence" ||
    evidence.authorityPlane !== "P3" ||
    JSON.stringify(evidence.columns) !== JSON.stringify(columns) ||
    JSON.stringify(evidence.omittedFields) !== JSON.stringify(omittedFields) ||
    evidence.targetPolicyAuthority !== false ||
    evidence.grantsRecoveryAuthority !== false ||
    !Array.isArray(evidence.rows) ||
    evidence.rows.length !== threadIds.length
  )
    fail();
  const seen = new Set(),
    records = evidence.rows.map((row) => {
      if (!Array.isArray(row) || row.length !== columns.length) fail();
      const record = Object.fromEntries(
        columns.map((column, index) => [column, decodeSqliteCell(row[index])]),
      );
      if (typeof record.id !== "string" || !requested.has(record.id) || seen.has(record.id))
        fail();
      seen.add(record.id);
      return record;
    });
  return records;
}
