import { readSnapshotFile } from "../world/snapshot-storage-codec.mjs";
import path from "node:path";
import { atomicCreateArtifact } from "../core/fs-atomic.mjs";
import { inspectCopiedProjectFile, verifyCopiedProjectFile } from "../storage/project-copy-evidence.mjs";
import fs from "node:fs";
import crypto from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { copiedProjectFile } from "../storage/project-copy-evidence.mjs";
import { nativeSqlitePath } from "./codex-native-backup.mjs";
import { inspectCodexNativeDatabase } from "./codex-native-portability.mjs";
import { iterateSqliteStorageRows } from "../core/native-sqlite-values.mjs";
import { SNAPSHOT_STORAGE_LIMITS } from "../world/snapshot-storage-codec.mjs";
import { sha256Hex as hash } from "../core/digest.mjs";
import { failCode as fail } from "../core/errors.mjs";

export const CODEX_NATIVE_TARGET_CHOICE_COLUMNS = Object.freeze([
  "id",
  "rollout_path",
  "model",
  "model_provider",
  "reasoning_effort",
  "sandbox_policy",
  "approval_mode",
  "cwd",
  "name",
  "title",
  "archived",
  "archived_at",
  "is_pinned",
  "thread_section_id",
  "section_position",
  "project_id",
  "attached_thread_parent_id",
]);
const snapshots = new WeakMap();
const keyForId = (id) =>
  hash(
    JSON.stringify({
      type: "raw-text-bytes",
      hex: Buffer.from(id, "utf8").toString("hex").toUpperCase(),
    }),
  );
const physical = (stat) => {
  if (!stat.isFile() || stat.nlink !== 1n) fail("NATIVE_CODEX_DATABASE_UNSAFE");
  return String(stat.dev) + ":" + String(stat.ino);
};
function guard({ signal, deadlineAt, assertCurrentAuthority }) {
  if (signal?.aborted) fail("NATIVE_CODEX_REGISTRATION_CANCELLED");
  if (!Number.isSafeInteger(deadlineAt) || Date.now() >= deadlineAt) fail("NATIVE_CODEX_REGISTRATION_DEADLINE");
  if (typeof assertCurrentAuthority !== "function") fail("NATIVE_CODEX_AUTHORITY_CHECK_REQUIRED");
  const result = assertCurrentAuthority();
  if (result && typeof result.then === "function") {
    Promise.resolve(result).catch(() => {});
    fail("NATIVE_CODEX_SYNCHRONOUS_AUTHORITY_REQUIRED");
  }
}
function observe(home, basis, excludedKeys, options, expectedPhysical = null, relative = "state_5.sqlite") {
  guard(options);
  const file = copiedProjectFile(home, relative),
    identity = physical(fs.lstatSync(file, { bigint: true }));
  if (expectedPhysical !== null && expectedPhysical !== identity) fail("NATIVE_CODEX_TARGET_STATE_FILE_CHANGED");
  const db = new DatabaseSync(nativeSqlitePath(file), { readOnly: true });
  let primary = null;
  try {
    inspectCodexNativeDatabase(db, { ...basis, file: "state_5.sqlite" });
    guard(options);
    db.exec("BEGIN");
    // No account selectors, preview, first-user-message or transcript fields.
    // Check lengths before materializing TEXT; then keep only opaque hashes.
    const lengths = CODEX_NATIVE_TARGET_CHOICE_COLUMNS.map((column) => 'coalesce(length(CAST("' + column + '" AS BLOB)),0)').join("+");
    const length = db.prepare("SELECT coalesce(sum(" + lengths + "),0) AS bytes FROM threads");
    length.setReadBigInts(true);
    if (length.get().bytes > BigInt(SNAPSHOT_STORAGE_LIMITS.decodedBytes)) fail("NATIVE_CODEX_TARGET_CHOICE_OBSERVATION_LIMIT");
    guard(options);
    const rows = new Map();
    let encodedBytes = 0;
    for (const row of iterateSqliteStorageRows(db, "threads", CODEX_NATIVE_TARGET_CHOICE_COLUMNS)) {
      guard(options);
      const key = hash(JSON.stringify(row[0]));
      if (excludedKeys.has(key)) continue;
      const encoded = JSON.stringify(row);
      encodedBytes += Buffer.byteLength(encoded);
      if (encodedBytes > SNAPSHOT_STORAGE_LIMITS.decodedBytes) fail("NATIVE_CODEX_TARGET_CHOICE_OBSERVATION_LIMIT");
      if (rows.has(key)) fail("NATIVE_CODEX_TARGET_CHOICES_INVALID");
      rows.set(key, hash(encoded));
    }
    guard(options);
    if (physical(fs.lstatSync(file, { bigint: true })) !== identity) fail("NATIVE_CODEX_TARGET_STATE_FILE_CHANGED");
    return { rows, identity };
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    let cleanup = null;
    try {
      if (db.isTransaction) db.exec("ROLLBACK");
    } catch (error) {
      cleanup = error;
    }
    try {
      db.close();
    } catch (error) {
      cleanup ??= error;
    }
    if (cleanup) {
      if (primary) primary.nativeCleanupFailure = cleanup.code || "NATIVE_CODEX_DATABASE_CLOSE_FAILED";
      else throw cleanup;
    }
  }
}

// Ephemeral Host evidence, never serialized or exported. Only preexisting
// protected choices are pinned: SDK recency/cache changes and new discovery
// rows are not silently treated as damage to a user's existing choices.
export function observeCodexNativeTargetChoices({ home, basis, selectedThreadIds, ...options }) {
  const excludedKeys = new Set(selectedThreadIds.map(keyForId));
  const captured = observe(home, basis, new Set(), options);
  const witness = Object.freeze(Object.create(null));
  snapshots.set(witness, { home, basis: { ...basis }, excludedKeys, ...captured });
  return witness;
}
export function verifyCodexNativeTargetChoices(witness, options) {
  const original = snapshots.get(witness);
  if (!original) fail("NATIVE_CODEX_TARGET_CHOICES_WITNESS_REQUIRED");
  const current = observe(original.home, original.basis, original.excludedKeys, options, original.identity);
  for (const [key, digest] of original.rows)
    if (!original.excludedKeys.has(key) && current.rows.get(key) !== digest) fail("NATIVE_CODEX_TARGET_CHOICES_CHANGED");
  return {
    status: "preexisting-target-choices-preserved",
    protectedRows: [...original.rows.keys()].filter((key) => !original.excludedKeys.has(key)).length,
    additionalRowsObserved: current.rows.size - [...original.rows.keys()].filter((key) => !original.excludedKeys.has(key)).length,
    newRowOrigin: "not-inferred",
    scope: "pinned user-choice columns only; not full state-row equivalence",
    authorityPlane: "P4",
    persisted: false,
  };
}

function generation(home, options) {
  guard(options);
  const names = ["state_5.sqlite", "state_5.sqlite-wal"].filter((name) => fs.existsSync(copiedProjectFile(home, name)));
  const files = names.map((name) =>
    inspectCopiedProjectFile(home, name, {
      signal: options.signal,
      assertCurrentAuthority: () => guard(options),
    }),
  );
  return { files, digest: hash(JSON.stringify(files)) };
}
const rowsDigest = (rows) => hash(JSON.stringify([...rows].sort(([left], [right]) => left.localeCompare(right))));
function matchingRows(expected, current) {
  if (rowsDigest(expected) !== rowsDigest(current)) fail("NATIVE_CODEX_TARGET_BEFORE_BACKUP_MISMATCH");
}

// Consistent target-local SQLite backup before a metadata lifecycle. Its full
// local bytes can contain existing account-related data; no account column is
// queried or exported. Reuse verifies schema, integrity, the saved raw hash and
// exact protected fields, not universal full-row semantic equivalence.
export async function backupCodexNativeTargetChoices(witness, { operationRoot, operationId, ...options }) {
  const original = snapshots.get(witness);
  if (!original) fail("NATIVE_CODEX_TARGET_CHOICES_WITNESS_REQUIRED");
  if (
    !/^native-registration-[a-f0-9]{24}$/.test(operationId) ||
    fs.realpathSync(operationRoot) !== copiedProjectFile(original.home, ".lode-native-portability")
  )
    fail("NATIVE_CODEX_TARGET_BACKUP_SCOPE_INVALID");
  guard(options);
  verifyCodexNativeTargetChoices(witness, options);
  const before = generation(original.home, options),
    current = observe(original.home, original.basis, new Set(), options, original.identity);
  const choiceDigest = rowsDigest(current.rows),
    base = ".lode-native-portability/before-state/" + operationId + "/" + before.digest;
  const relative = base + "/state_5.sqlite",
    receiptRelative = base + "/backup.json",
    target = copiedProjectFile(original.home, relative),
    receiptFile = copiedProjectFile(original.home, receiptRelative);
  const verifyBackup = () => {
    const stat = fs.lstatSync(receiptFile);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) fail("NATIVE_CODEX_TARGET_BACKUP_INVALID");
    const value = readSnapshotFile(receiptFile, { decodedBytes: 65536 }).document;
    if (
      value.schemaVersion !== 1 ||
      value.authorityPlane !== "P5" ||
      value.transferred !== false ||
      value.grantsRecoveryAuthority !== false ||
      value.restoresExecutionPermission !== false ||
      value.scope !==
        "target-local consistent SQLite before-backup; protected fields verified; no account values queried/exported; never automatically restored" ||
      Object.keys(value).length !== 13 ||
      value.kind !== "NativeTargetChoiceBeforeBackup" ||
      value.operationId !== operationId ||
      value.beforeGenerationDigest !== before.digest ||
      value.beforeChoiceDigest !== choiceDigest ||
      value.path !== relative
    )
      fail("NATIVE_CODEX_TARGET_BACKUP_INVALID");
    verifyCopiedProjectFile(original.home, value, {
      signal: options.signal,
      assertCurrentAuthority: () => guard(options),
    });
    const stored = observe(original.home, original.basis, new Set(), options, null, relative);
    matchingRows(current.rows, stored.rows);
    return value;
  };
  if (fs.existsSync(receiptFile)) {
    const value = verifyBackup();
    if (generation(original.home, options).digest !== before.digest) fail("NATIVE_CODEX_TARGET_BEFORE_GENERATION_CHANGED");
    return { ...value, status: "verified-local-before-backup", reused: true };
  }
  guard(options);
  fs.mkdirSync(copiedProjectFile(original.home, base), { recursive: true });
  copiedProjectFile(original.home, base);
  const temporary = base + "/." + crypto.randomUUID() + ".partial.sqlite",
    stage = copiedProjectFile(original.home, temporary);
  const db = new DatabaseSync(nativeSqlitePath(copiedProjectFile(original.home, "state_5.sqlite")), { readOnly: true });
  let primary = null;
  try {
    guard(options);
    await backup(db, nativeSqlitePath(stage), {
      rate: 100,
      progress() {
        options.onBoundary?.("backup-step");
        guard(options);
      },
    });
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      db.close();
    } catch (error) {
      if (primary) primary.nativeCleanupFailure = error.code || "NATIVE_CODEX_DATABASE_CLOSE_FAILED";
      else throw error;
    }
  }
  guard(options);
  if (generation(original.home, options).digest !== before.digest) fail("NATIVE_CODEX_TARGET_BEFORE_GENERATION_CHANGED");
  matchingRows(current.rows, observe(original.home, original.basis, new Set(), options, null, temporary).rows);
  const observed = inspectCopiedProjectFile(original.home, temporary, {
    signal: options.signal,
    assertCurrentAuthority: () => guard(options),
  });
  guard(options);
  try {
    fs.linkSync(stage, target);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    verifyCopiedProjectFile(original.home, { ...observed, path: relative }, { signal: options.signal, assertCurrentAuthority: () => guard(options) });
  }
  fs.unlinkSync(stage);
  const value = {
    schemaVersion: 1,
    kind: "NativeTargetChoiceBeforeBackup",
    authorityPlane: "P5",
    operationId,
    path: relative,
    bytes: observed.bytes,
    sha256: observed.sha256,
    beforeGenerationDigest: before.digest,
    beforeChoiceDigest: choiceDigest,
    scope: "target-local consistent SQLite before-backup; protected fields verified; no account values queried/exported; never automatically restored",
    transferred: false,
    grantsRecoveryAuthority: false,
    restoresExecutionPermission: false,
  };
  guard(options);
  const encoded = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  try {
    atomicCreateArtifact(receiptFile, encoded);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const verified = verifyBackup();
  if (generation(original.home, options).digest !== before.digest) fail("NATIVE_CODEX_TARGET_BEFORE_GENERATION_CHANGED");
  return { ...verified, status: "verified-local-before-backup", reused: false };
}
