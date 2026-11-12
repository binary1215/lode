import { verifySelectedCodexStateEvidence } from "./codex-native-state-evidence.mjs";
import fs from "node:fs";
import path from "node:path";
import { copiedProjectFile, inspectCopiedProjectFile } from "../storage/project-copy-evidence.mjs";
import { readSnapshotFile, SNAPSHOT_STORAGE_LIMITS } from "../world/snapshot-storage-codec.mjs";
import { verifySelectedCodexHistory, codexNativePortabilityProfile } from "./codex-native-portability.mjs";
import { inspectCodexRolloutOriginal } from "./codex-native-rollout.mjs";
import { sha256Hex as hash } from "../core/digest.mjs";
import { failCode as fail } from "../core/errors.mjs";

const profile = codexNativePortabilityProfile();
function read(root, relative) {
  const file = copiedProjectFile(root, relative),
    stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) fail("NATIVE_CODEX_PAYLOAD_UNSAFE");
  return readSnapshotFile(file, { decodedBytes: SNAPSHOT_STORAGE_LIMITS.decodedBytes });
}

// Original-data inspection only. The diagnostic result and manifest grant no
// native operation, current settings, account, execution or P2 recovery rights.
export function inspectCodexNativePayload({ directory, expectedPayloadId = null, signal } = {}) {
  const root = fs.realpathSync(path.resolve(directory));
  if (signal?.aborted) fail("NATIVE_CODEX_CAPTURE_CANCELLED");
  const original = read(root, "manifest.json"),
    payload = original.document,
    digest = hash(original.bytes),
    payloadId = "native-history-" + digest.slice(0, 24);
  const intent = read(root, "capture-intent.json").document;
  if (
    intent?.schemaVersion !== 1 ||
    intent.kind !== "NativeHistoryCaptureIntent" ||
    intent.payloadId !== payloadId ||
    intent.payloadDigest !== digest ||
    (expectedPayloadId !== null && expectedPayloadId !== payloadId)
  )
    fail("NATIVE_CODEX_PAYLOAD_IDENTITY_MISMATCH");
  if (
    payload?.schemaVersion !== 1 ||
    payload.kind !== "CodexNativeHistoryPayload" ||
    payload.authorityPlane !== "P3" ||
    payload.profileId !== profile.profileId ||
    payload.engineVersion !== profile.engineVersion ||
    payload.platform !== profile.platform ||
    payload.architecture !== profile.architecture ||
    payload.grantsRecoveryAuthority !== false ||
    payload.restoresExecutionPermission !== false ||
    payload.nativePublicationReady !== false ||
    !Array.isArray(payload.threadIds) ||
    !payload.threadIds.length ||
    new Set(payload.threadIds).size !== payload.threadIds.length ||
    payload.threadIds.some((id) => typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) ||
    JSON.stringify(payload.threadIds) !== JSON.stringify(payload.history?.threadIds) ||
    !Array.isArray(payload.files) ||
    payload.files.length !== payload.threadIds.length ||
    !Array.isArray(payload.coverage) ||
    payload.coverage.length !== payload.threadIds.length
  )
    fail("NATIVE_CODEX_PAYLOAD_INVALID");
  verifySelectedCodexHistory(payload.history);
  const sourceState = verifySelectedCodexStateEvidence(payload.stateEvidence, payload.threadIds);
  const names = new Set(),
    ids = new Set(),
    coverage = [];
  for (const entry of payload.files) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1 ||
      !payload.threadIds.includes(entry.threadId) ||
      ids.has(entry.threadId) ||
      names.has(entry.path.toLowerCase()) ||
      !/^(?:sessions|archived_sessions)\/.+\.jsonl(?:\.zst)?$/.test(entry.path) ||
      (!path.basename(entry.path).endsWith("-" + entry.threadId + ".jsonl") && !path.basename(entry.path).endsWith("-" + entry.threadId + ".jsonl.zst"))
    )
      fail("NATIVE_CODEX_PAYLOAD_INVALID");
    copiedProjectFile(root, entry.path);
    names.add(entry.path.toLowerCase());
    ids.add(entry.threadId);
    const declared = payload.coverage.filter((item) => item.threadId === entry.threadId);
    if (declared.length !== 1) fail("NATIVE_CODEX_PAYLOAD_INVALID");
    const format = entry.path.endsWith(".zst")
      ? null
      : inspectCodexRolloutOriginal({
          root,
          relative: "objects/" + entry.sha256 + ".bin",
          threadId: entry.threadId,
          history: payload.history,
          signal,
        });
    const raw = format?.raw || inspectCopiedProjectFile(root, "objects/" + entry.sha256 + ".bin", { signal });
    if (raw.sha256 !== entry.sha256 || raw.bytes !== entry.bytes) fail("NATIVE_CODEX_PAYLOAD_RAW_CHANGED");
    const actualFormat = format?.formatAndAddressReady ? "verified" : "partial";
    const actualClosure = format?.unresolvedClosure || ["compressed-format-unverified"];
    if (declared[0].rawFormat !== actualFormat || JSON.stringify(declared[0].unresolvedClosure) !== JSON.stringify(actualClosure))
      fail("NATIVE_CODEX_PAYLOAD_INVALID");
    const historical = sourceState.find((row) => row.id === entry.threadId);
    const parentSelected = historical.attached_thread_parent_id == null || payload.threadIds.includes(historical.attached_thread_parent_id);
    if ((declared[0].parentClosure === "selected-or-none") !== parentSelected) fail("NATIVE_CODEX_PAYLOAD_INVALID");
    coverage.push({
      threadId: entry.threadId,
      rawFormat: format?.formatAndAddressReady ? "verified" : "partial",
      unresolvedClosure: format?.unresolvedClosure || ["compressed-format-unverified"],
      parentClosure: declared[0].parentClosure === "selected-or-none" ? "declared-selected-or-none" : "not-selected",
    });
  }
  const mechanicalOriginalsReady = coverage.every((item) => item.rawFormat === "verified" && item.parentClosure === "declared-selected-or-none");
  return {
    status: mechanicalOriginalsReady ? "verified-native-originals" : "verified-native-originals-partial",
    directory: root,
    payloadId,
    payloadDigest: digest,
    payload,
    coverage,
    mechanicalOriginalsReady,
    nativePublicationReady: false,
    nativeRegistration: "not-performed",
    sourceOrigin: "digest-identified-source-evidence",
    authorityPlane: "P4",
    ordinaryCoreBlocked: false,
    grantsRecoveryAuthority: false,
    restoresExecutionPermission: false,
  };
}

export function codexNativePayloadSummary(inspected) {
  return {
    status: inspected.status,
    payloadId: inspected.payloadId,
    payloadDigest: inspected.payloadDigest,
    threadCount: inspected.payload.threadIds.length,
    rawFileCount: inspected.payload.files.length,
    coverage: inspected.coverage,
    mechanicalOriginalsReady: inspected.mechanicalOriginalsReady,
    nativePublicationReady: false,
    nativeRegistration: "not-performed",
    ordinaryCoreBlocked: false,
    authorityPlane: "P4",
    grantsRecoveryAuthority: false,
    restoresExecutionPermission: false,
  };
}
