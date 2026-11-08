import { nativeSqlitePath } from "./codex-native-backup.mjs";
import { readSelectedCodexStateEvidence, verifySelectedCodexStateEvidence } from "./codex-native-state-evidence.mjs";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertCodexNativeOffline } from "./codex-native-offline.mjs";
import { inspectCodexNativeDatabase, readSelectedCodexHistory, codexNativePortabilityProfile } from "./codex-native-portability.mjs";
import { inspectCodexRolloutOriginal } from "./codex-native-rollout.mjs";
import { copiedProjectFile, inspectCopiedProjectFile, verifyCopiedProjectFile, copyOriginal } from "./project-copy-evidence.mjs";
import { atomicCreateArtifact } from "./core/fs-atomic.mjs";
import { sha256Hex as hash } from "./core/digest.mjs";
import { failCode as fail } from "./core/errors.mjs";

const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const profile = codexNativePortabilityProfile();
const cancelled = (signal) => {
  if (signal?.aborted) fail("NATIVE_CODEX_CAPTURE_CANCELLED");
};
const version = (db) => db.prepare("PRAGMA data_version").get().data_version;
const physical = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
function exact(file, bytes) {
  if (fs.existsSync(file)) {
    if (!fs.readFileSync(file).equals(bytes)) fail("NATIVE_CODEX_CAPTURE_CONFLICT");
    return;
  }
  atomicCreateArtifact(file, bytes);
}
function destinationRoot(destination, home) {
  if (typeof destination !== "string" || !destination.trim()) fail("NATIVE_CODEX_CAPTURE_DESTINATION_REQUIRED");
  const absolute = path.resolve(destination),
    parent = fs.realpathSync(path.dirname(absolute));
  const target = copiedProjectFile(parent, path.basename(absolute));
  const relative = path.relative(home, target);
  if (!relative || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))) fail("NATIVE_CODEX_CAPTURE_INSIDE_HOME");
  return target;
}

// Selected raw/typed rows only. No whole state DB, source settings, credentials,
// unselected threads or live bindings are copied. Read transactions consume WAL
// through SQLite; source WAL/SHM are never copied, checkpointed or made immutable.
export async function captureCodexNativeHistory({
  witness,
  threadIds,
  destination,
  signal,
  onBoundary = null,
  onProcess,
  assertCurrentAuthority = () => {},
} = {}) {
  const checkAuthority = () => {
    cancelled(signal);
    if (typeof assertCurrentAuthority !== "function") fail("NATIVE_CODEX_AUTHORITY_CHECK_REQUIRED");
    const result = assertCurrentAuthority();
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch(() => {});
      fail("NATIVE_CODEX_SYNCHRONOUS_AUTHORITY_REQUIRED");
    }
  };

  if (
    !Array.isArray(threadIds) ||
    !threadIds.length ||
    new Set(threadIds).size !== threadIds.length ||
    threadIds.some((id) => typeof id !== "string" || !idPattern.test(id))
  )
    fail("NATIVE_CODEX_THREAD_SELECTION_INVALID");
  checkAuthority();
  const offline = await assertCodexNativeOffline(witness, { signal, onProcess });
  checkAuthority();
  const root = destinationRoot(destination, offline.home),
    databases = [];
  let primary = null;
  try {
    const open = (file) => {
      checkAuthority();
      const location = copiedProjectFile(offline.home, file),
        stat = fs.lstatSync(location, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n) fail("NATIVE_CODEX_DATABASE_UNSAFE");
      const db = new DatabaseSync(nativeSqlitePath(location), { readOnly: true });
      const selected = { db, file, before: null, transaction: false, physical: physical(stat) };
      databases.push(selected);
      selected.before = version(db);
      db.exec("BEGIN");
      selected.transaction = true;
      inspectCodexNativeDatabase(db, {
        file,
        engineVersion: offline.engineVersion,
        platform: process.platform,
        architecture: process.arch,
      });
      return selected;
    };
    const state = open("state_5.sqlite");
    const stateEvidence = readSelectedCodexStateEvidence(state.db, threadIds);
    const stateRecords = verifySelectedCodexStateEvidence(stateEvidence, threadIds);
    const selected = threadIds.map((threadId) => {
      checkAuthority();
      const row = stateRecords.find((row) => row.id === threadId);
      if (!row || row.id !== threadId || typeof row.rollout_path !== "string") fail("NATIVE_CODEX_SELECTED_STATE_UNAVAILABLE");
      const relative = path.relative(nativeSqlitePath(offline.home), nativeSqlitePath(row.rollout_path)).replaceAll("\\", "/");
      if (
        !/^(?:sessions|archived_sessions)\/.+\.jsonl(?:\.zst)?$/.test(relative) ||
        (!path.basename(relative).endsWith("-" + threadId + ".jsonl") && !path.basename(relative).endsWith("-" + threadId + ".jsonl.zst"))
      )
        fail("NATIVE_CODEX_SELECTED_ROLLOUT_UNSAFE");
      copiedProjectFile(offline.home, relative);
      return {
        threadId,
        relative,
        archived: row.archived === 1n,
        sourceEngineVersion: row.cli_version,
        historyMode: row.history_mode,
        parentThreadId: row.attached_thread_parent_id,
      };
    });
    onBoundary?.("state-read");
    checkAuthority();
    const historyDb = open("thread_history_1.sqlite");
    const history = readSelectedCodexHistory(historyDb.db, {
      engineVersion: offline.engineVersion,
      platform: process.platform,
      architecture: process.arch,
      threadIds,
    });
    const raw = selected.map((selection) => {
      checkAuthority();
      if (selection.relative.endsWith(".zst"))
        return {
          selection,
          raw: inspectCopiedProjectFile(offline.home, selection.relative, {
            signal,
            assertCurrentAuthority: checkAuthority,
          }),
          coverage: {
            status: "preserved-unsupported-compression",
            formatAndAddressReady: false,
            nativePublicationReady: false,
          },
        };
      const verified = inspectCodexRolloutOriginal({
        root: offline.home,
        relative: selection.relative,
        threadId: selection.threadId,
        history,
        signal,
        assertCurrentAuthority: checkAuthority,
      });
      return { selection, raw: verified.raw, coverage: verified };
    });
    onBoundary?.("captured");
    const payload = {
      schemaVersion: 1,
      kind: "CodexNativeHistoryPayload",
      authorityPlane: "P3",
      profileId: profile.profileId,
      engineVersion: offline.engineVersion,
      platform: process.platform,
      architecture: process.arch,
      threadIds: [...threadIds],
      history,
      files: raw.map((item) => ({ ...item.raw, threadId: item.selection.threadId })),
      coverage: raw.map((item) => ({
        threadId: item.selection.threadId,
        rawFormat: item.coverage.formatAndAddressReady ? "verified" : "partial",
        unresolvedClosure: item.coverage.unresolvedClosure || ["compressed-format-unverified"],
        parentClosure: item.selection.parentThreadId == null || threadIds.includes(item.selection.parentThreadId) ? "selected-or-none" : "not-selected",
        archived: item.selection.archived,
      })),
      sourceState: "historical selected typed projection only; never inserted into target state",
      stateEvidence,
      sourceHomeDigest: hash(offline.home),
      sourceCutoff: raw.every((item) => item.coverage.formatAndAddressReady)
        ? "stopped-at-check; independent SQLite read snapshots and stable raw addresses"
        : "stopped-at-check; independent SQLite read snapshots and stable raw digest/length; frame/closure verification partial",
      officialEffectiveHistory: "not-queried-by-capture",
      nativeRegistration: "not-performed",
      nativePublicationReady: false,
      grantsRecoveryAuthority: false,
      restoresExecutionPermission: false,
    };
    const encoded = json(payload),
      payloadDigest = hash(encoded),
      payloadId = "native-history-" + payloadDigest.slice(0, 24);
    checkAuthority();
    if (!fs.existsSync(root)) fs.mkdirSync(root);
    if (!fs.lstatSync(root).isDirectory()) fail("NATIVE_CODEX_CAPTURE_DESTINATION_INVALID");
    const intent = copiedProjectFile(root, "capture-intent.json");
    if (!fs.existsSync(intent) && fs.readdirSync(root).length) fail("NATIVE_CODEX_CAPTURE_DESTINATION_NOT_EMPTY");
    checkAuthority();
    exact(intent, json({ schemaVersion: 1, kind: "NativeHistoryCaptureIntent", payloadId, payloadDigest }));
    checkAuthority();
    const objects = copiedProjectFile(root, "objects");
    if (!fs.existsSync(objects)) fs.mkdirSync(objects);
    for (const item of raw) {
      await assertCodexNativeOffline(witness, { signal, onProcess });
      checkAuthority();
      copyOriginal(offline.home, root, item.raw, {
        signal,
        assertCurrentAuthority: checkAuthority,
        targetRelative: "objects/" + item.raw.sha256 + ".bin",
      });
      onBoundary?.("raw-copied", item.raw.path);
    }
    for (const item of raw)
      verifyCopiedProjectFile(offline.home, item.raw, {
        signal,
        assertCurrentAuthority: checkAuthority,
      });
    for (const selected of databases) {
      selected.db.exec("COMMIT");
      selected.transaction = false;
    }
    for (const selected of databases) if (version(selected.db) !== selected.before) fail("NATIVE_CODEX_CAPTURE_GENERATION_CHANGED");
    await assertCodexNativeOffline(witness, { signal, onProcess });
    checkAuthority();
    // No await or caller hook follows this final original-data reconciliation.
    for (const item of raw)
      verifyCopiedProjectFile(offline.home, item.raw, {
        signal,
        assertCurrentAuthority: checkAuthority,
      });
    for (const selected of databases) {
      const location = copiedProjectFile(offline.home, selected.file);
      if (physical(fs.lstatSync(location, { bigint: true })) !== selected.physical) fail("NATIVE_CODEX_CAPTURE_PHYSICAL_BASIS_CHANGED");
      if (version(selected.db) !== selected.before) fail("NATIVE_CODEX_CAPTURE_GENERATION_CHANGED");
    }
    checkAuthority();
    exact(copiedProjectFile(root, "manifest.json"), encoded);
    return {
      status: payload.coverage.every((item) => item.rawFormat === "verified" && item.parentClosure === "selected-or-none")
        ? "captured-native-originals"
        : "captured-partial-native-originals",
      payloadId,
      payloadDigest,
      directory: root,
      threadCount: threadIds.length,
      rawFileCount: raw.length,
      authorityPlane: "P3",
      nativePublicationReady: false,
      nativeRegistration: "not-performed",
      ordinaryCoreBlocked: false,
    };
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    let cleanupFailure = null;
    for (const selected of databases.reverse()) {
      if (selected.transaction) {
        try {
          selected.db.exec("ROLLBACK");
        } catch {
          /* Preserve the primary capture error. */
        }
      }
      try {
        selected.db.close();
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
