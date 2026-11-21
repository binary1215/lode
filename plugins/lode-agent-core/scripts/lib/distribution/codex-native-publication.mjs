import { nativeSqlitePath, codexNativeHistoryDigest, verifyCodexNativeBeforeBackup } from "./codex-native-backup.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { assertCodexNativeOffline } from "./codex-native-offline.mjs";
import { inspectCodexNativePayload } from "./codex-native-payload.mjs";
import { inspectCodexNativeDatabase } from "./codex-native-portability.mjs";
import { planCodexNativeRowMerge, applyCodexNativeRowMerge } from "./codex-native-row-merge.mjs";
import { copiedProjectFile, verifyCopiedProjectFile, inspectCopiedProjectFile, copyOriginal } from "../storage/project-copy-evidence.mjs";
import { atomicCreateArtifact } from "../core/fs-atomic.mjs";
import { sha256Hex as hash } from "../core/digest.mjs";
import { failCode as fail } from "../core/errors.mjs";

const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const version = (db) => db.prepare("PRAGMA data_version").get().data_version;
const physical = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
const contained = (base, file) => {
  const relative = path.relative(base, file);
  return !relative || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
};
const cancelled = (signal) => {
  if (signal?.aborted) fail("NATIVE_CODEX_PUBLICATION_CANCELLED");
};
function exact(root, relative, bytes) {
  const file = copiedProjectFile(root, relative);
  if (fs.existsSync(file)) {
    if (!fs.readFileSync(file).equals(bytes)) fail("NATIVE_CODEX_PUBLICATION_INTENT_CONFLICT");
    return;
  }
  atomicCreateArtifact(file, bytes);
}
function regular(root, relative) {
  const file = copiedProjectFile(root, relative),
    stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n) fail("NATIVE_CODEX_DATABASE_UNSAFE");
  return { file, physical: physical(stat) };
}
function assertPayload(inspected) {
  verifyCopiedProjectFile(inspected.directory, {
    path: "manifest.json",
    bytes: fs.statSync(copiedProjectFile(inspected.directory, "manifest.json")).size,
    sha256: inspected.payloadDigest,
  });
}

// Internal Host orchestration for an explicitly requested offline operation.
// The witness is current operational evidence, never effect authorization.
// This writes absent exact raw files and selected history rows only. It never
// replaces a state DB, restores a whole backup, registers/opens a native thread,
// changes target settings or executes historical prompts.
export async function publishCodexNativeHistory({
  witness,
  directory,
  expectedPayloadId = null,
  signal,
  onBoundary = null,
  onProcess,
  assertCurrentAuthority = () => {},
} = {}) {
  if (typeof assertCurrentAuthority !== "function") fail("NATIVE_CODEX_AUTHORITY_CHECK_REQUIRED");
  const checkAuthority = () => {
    const result = assertCurrentAuthority();
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch(() => {});
      fail("NATIVE_CODEX_SYNCHRONOUS_AUTHORITY_REQUIRED");
    }
  };
  const inspected = inspectCodexNativePayload({ directory, expectedPayloadId, signal });
  if (!inspected.mechanicalOriginalsReady)
    return {
      status: "native-originals-partial",
      nativeRegistration: "not-performed",
      ordinaryCoreBlocked: false,
      persisted: false,
    };
  const offline = await assertCodexNativeOffline(witness, { signal, onProcess }),
    home = offline.home,
    payload = inspected.payload;
  if (offline.engineVersion !== payload.engineVersion) fail("NATIVE_CODEX_PROFILE_UNSUPPORTED");
  if (contained(home, inspected.directory) || contained(inspected.directory, home)) fail("NATIVE_CODEX_SOURCE_TARGET_OVERLAP");
  cancelled(signal);
  checkAuthority();
  const basis = {
    engineVersion: offline.engineVersion,
    platform: process.platform,
    architecture: process.arch,
  };
  const opened = [];
  let committed = false;
  let primary = null,
    history = null;
  try {
    const open = (file, readOnly) => {
      const original = regular(home, file),
        db = new DatabaseSync(nativeSqlitePath(original.file), { readOnly });
      const record = { ...original, relative: file, db, transaction: false };
      opened.push(record);
      inspectCodexNativeDatabase(db, { ...basis, file });
      return record;
    };
    const state = open("state_5.sqlite", true),
      stateVersion = version(state.db);
    const selectedState = () =>
      payload.threadIds.map((threadId) => {
        const row = state.db.prepare("SELECT id,rollout_path FROM threads WHERE id=?").get(threadId);
        if (row) {
          const file = payload.files.find((entry) => entry.threadId === threadId);
          if (
            typeof row.rollout_path !== "string" ||
            nativeSqlitePath(path.resolve(row.rollout_path)) !== nativeSqlitePath(path.resolve(copiedProjectFile(home, file.path)))
          )
            fail("NATIVE_CODEX_TARGET_THREAD_BINDING_DIVERGED");
        }
        return row ? { id: row.id, rollout_path: row.rollout_path } : null;
      });
    const originalState = JSON.stringify(selectedState());
    history = open("thread_history_1.sqlite", false);
    history.db.exec("BEGIN IMMEDIATE");
    history.transaction = true;
    const preview = planCodexNativeRowMerge(history.db, { ...basis, history: payload.history });
    let rawAbsent = 0;
    for (const entry of payload.files) {
      const file = copiedProjectFile(home, entry.path);
      if (fs.existsSync(file)) verifyCopiedProjectFile(home, entry);
      else rawAbsent++;
    }
    const intent = {
      schemaVersion: 1,
      kind: "NativeHistoryPublicationIntent",
      authorityPlane: "P5",
      payloadId: inspected.payloadId,
      payloadDigest: inspected.payloadDigest,
      targetHomeDigest: hash(home),
      threadIds: payload.threadIds,
      rawFiles: payload.files,
      stateRowsWritten: 0,
      nativeRegistration: "not-requested",
      restoresExecutionPermission: false,
      grantsRecoveryAuthority: false,
    };
    const intentBytes = json(intent),
      operationId = "native-publication-" + hash(intentBytes).slice(0, 24);
    const operationRelative = ".lode-native-portability/" + operationId;
    const intentFile = copiedProjectFile(home, operationRelative + "/intent.json"),
      hadIntent = fs.existsSync(intentFile);
    if (hadIntent && !fs.readFileSync(intentFile).equals(intentBytes)) fail("NATIVE_CODEX_PUBLICATION_INTENT_CONFLICT");
    const assertBasis = () => {
      cancelled(signal);
      checkAuthority();
      assertPayload(inspected);
      if (
        physical(fs.lstatSync(copiedProjectFile(home, history.relative), { bigint: true }))
          .split(":")
          .slice(0, 2)
          .join(":") !== history.physical.split(":").slice(0, 2).join(":")
      )
        fail("NATIVE_CODEX_TARGET_HISTORY_FILE_CHANGED");
      if (
        physical(fs.lstatSync(copiedProjectFile(home, state.relative), { bigint: true })) !== state.physical ||
        version(state.db) !== stateVersion ||
        JSON.stringify(selectedState()) !== originalState
      )
        fail("NATIVE_CODEX_TARGET_STATE_CHANGED");
    };
    const reconcile = () => {
      assertBasis();
      for (const entry of payload.files) verifyCopiedProjectFile(home, entry);
      const actual = planCodexNativeRowMerge(history.db, {
        ...basis,
        history: payload.history,
      });
      if (actual.status !== "equal") fail("NATIVE_CODEX_TARGET_HISTORY_INCOMPLETE");
    };
    const result = {
      schemaVersion: 1,
      kind: "NativeHistoryPublicationResult",
      authorityPlane: "P5",
      operationId,
      payloadId: inspected.payloadId,
      payloadDigest: inspected.payloadDigest,
      targetHomeDigest: hash(home),
      rawAndSelectedHistory: "verified",
      stateRowsWritten: 0,
      nativeRegistration: "not-performed",
      grantsRecoveryAuthority: false,
      restoresExecutionPermission: false,
    };
    if (preview.status === "equal" && !rawAbsent) {
      history.db.exec("ROLLBACK");
      history.transaction = false;
      await assertCodexNativeOffline(witness, { signal, onProcess });
      reconcile();
      if (hadIntent) exact(home, operationRelative + "/result.json", json(result));
      return {
        ...result,
        status: "native-originals-already-present",
        persisted: hadIntent,
        ordinaryCoreBlocked: false,
      };
    }
    await assertCodexNativeOffline(witness, { signal, onProcess });
    assertBasis();
    fs.mkdirSync(copiedProjectFile(home, operationRelative), { recursive: true });
    copiedProjectFile(home, operationRelative);
    exact(home, operationRelative + "/intent.json", intentBytes);
    onBoundary?.("intent");
    cancelled(signal);
    checkAuthority();
    const beforeHistoryDigest = codexNativeHistoryDigest(history.db, basis, { signal });
    const validateBackup = (relative) => {
      const receipt = JSON.parse(fs.readFileSync(copiedProjectFile(home, relative)));
      if (
        receipt.kind !== "NativeHistoryBeforeBackup" ||
        receipt.operationId !== operationId ||
        typeof receipt.beforeHistoryDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(receipt.beforeHistoryDigest) ||
        typeof receipt.path !== "string" ||
        receipt.path !== operationRelative + "/backups/" + receipt.sha256 + ".sqlite"
      )
        fail("NATIVE_CODEX_BACKUP_INVALID");
      verifyCopiedProjectFile(home, receipt);
      verifyCodexNativeBeforeBackup(copiedProjectFile(home, receipt.path), basis, receipt.beforeHistoryDigest);
      return receipt;
    };
    let backupReceiptRelative = operationRelative + "/backup.json";
    if (fs.existsSync(copiedProjectFile(home, backupReceiptRelative))) {
      const receipt = validateBackup(backupReceiptRelative);
      if (receipt.beforeHistoryDigest !== beforeHistoryDigest) backupReceiptRelative = operationRelative + "/backups/before-" + beforeHistoryDigest + ".json";
    }
    if (fs.existsSync(copiedProjectFile(home, backupReceiptRelative))) {
      const receipt = validateBackup(backupReceiptRelative);
      if (receipt.beforeHistoryDigest !== beforeHistoryDigest) fail("NATIVE_CODEX_BACKUP_BEFORE_STATE_MISMATCH");
    } else {
      cancelled(signal);
      checkAuthority();
      const backupDirectory = operationRelative + "/backups";
      fs.mkdirSync(copiedProjectFile(home, backupDirectory), { recursive: true });
      const stageRelative = backupDirectory + "/." + crypto.randomUUID() + ".partial.sqlite",
        stage = copiedProjectFile(home, stageRelative);
      const reader = new DatabaseSync(nativeSqlitePath(history.file), { readOnly: true });
      let backupError = null;
      try {
        await backup(reader, nativeSqlitePath(stage), {
          rate: 100,
          progress() {
            cancelled(signal);
            checkAuthority();
          },
        });
      } catch (error) {
        backupError = error;
        throw error;
      } finally {
        try {
          reader.close();
        } catch (error) {
          if (backupError) backupError.nativeCleanupFailure = error.code || "NATIVE_CODEX_DATABASE_CLOSE_FAILED";
          else throw error;
        }
      }
      cancelled(signal);
      checkAuthority();
      await assertCodexNativeOffline(witness, { signal, onProcess });
      assertBasis();
      verifyCodexNativeBeforeBackup(stage, basis, beforeHistoryDigest);
      const observed = inspectCopiedProjectFile(home, stageRelative),
        stored = backupDirectory + "/" + observed.sha256 + ".sqlite",
        target = copiedProjectFile(home, stored);
      cancelled(signal);
      checkAuthority();
      try {
        fs.linkSync(stage, target);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        verifyCopiedProjectFile(home, { ...observed, path: stored });
      }
      fs.unlinkSync(stage);
      exact(
        home,
        backupReceiptRelative,
        json({
          schemaVersion: 1,
          kind: "NativeHistoryBeforeBackup",
          authorityPlane: "P5",
          operationId,
          path: stored,
          bytes: observed.bytes,
          sha256: observed.sha256,
          beforeHistoryDigest,
          scope: "target-history-database-local-backup-only; never transferred or automatically restored",
        }),
      );
    }
    onBoundary?.("backup");
    cancelled(signal);
    checkAuthority();
    const rawStage = operationRelative + "/raw-stage";
    fs.mkdirSync(copiedProjectFile(home, rawStage), { recursive: true });
    copiedProjectFile(home, rawStage);
    for (const entry of payload.files) {
      await assertCodexNativeOffline(witness, { signal, onProcess });
      assertBasis();
      const file = copiedProjectFile(home, entry.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      copiedProjectFile(home, entry.path);
      copyOriginal(inspected.directory, home, entry, {
        signal,
        sourceRelative: "objects/" + entry.sha256 + ".bin",
        targetRelative: entry.path,
        stagingDirectory: rawStage,
      });
      onBoundary?.("raw", entry.path);
    }
    await assertCodexNativeOffline(witness, { signal, onProcess });
    assertBasis();
    for (const entry of payload.files) verifyCopiedProjectFile(home, entry);
    applyCodexNativeRowMerge(preview.plan, history.db);
    onBoundary?.("before-history-commit");
    await assertCodexNativeOffline(witness, { signal, onProcess });
    reconcile();
    history.db.exec("COMMIT");
    history.transaction = false;
    committed = true;
    onBoundary?.("history-committed");
    await assertCodexNativeOffline(witness, { signal, onProcess });
    reconcile();
    exact(home, operationRelative + "/result.json", json(result));
    return {
      ...result,
      status: "native-originals-published",
      persisted: true,
      ordinaryCoreBlocked: false,
    };
  } catch (error) {
    if (committed)
      error.nativePublicationOutcome = {
        rawAndSelectedHistory: "committed; final response not established",
        nativeRegistration: "not-performed",
        automaticReplayAllowed: false,
      };
    primary = error;
    throw error;
  } finally {
    let cleanupFailure = null;
    for (const entry of opened.reverse()) {
      if (entry.transaction) {
        try {
          entry.db.exec("ROLLBACK");
        } catch (error) {
          cleanupFailure ??= error;
        }
      }
      try {
        entry.db.close();
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    if (cleanupFailure) {
      if (primary) primary.nativeCleanupFailure = cleanupFailure.code || "NATIVE_CODEX_DATABASE_CLOSE_FAILED";
      else throw cleanupFailure;
    }
  }
}
