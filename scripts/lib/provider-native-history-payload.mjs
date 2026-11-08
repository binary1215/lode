import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomicCreateArtifact } from "./artifact-storage.mjs";
import { copiedProjectFile, inspectCopiedProjectFile, readCopiedProjectExcerpt, copyOriginal, verifyCopiedProjectFile } from "./project-copy-evidence.mjs";
import { readSnapshotFile, SNAPSHOT_STORAGE_LIMITS } from "./snapshot-storage-codec.mjs";
import { inspectProviderHistoryOriginal } from "./provider-native-history-format.mjs";

const providers = new Set(["claude", "opencode"]);
const hash = (raw) => crypto.createHash("sha256").update(raw).digest("hex");
const bytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const inside = (root, file) => {
  const rel = path.relative(root, file);
  return !rel || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
};
const id = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u.test(value);
function authority(signal, check) {
  if (signal?.aborted) fail("NATIVE_HISTORY_CAPTURE_CANCELLED");
  if (typeof check !== "function") fail("NATIVE_HISTORY_AUTHORITY_CHECK_REQUIRED");
  const result = check();
  if (result && typeof result.then === "function") {
    Promise.resolve(result).catch(() => {});
    fail("NATIVE_HISTORY_SYNCHRONOUS_AUTHORITY_REQUIRED");
  }
}
function exact(root, relative, raw) {
  const file = copiedProjectFile(root, relative);
  if (fs.existsSync(file)) {
    const found = inspectCopiedProjectFile(root, relative);
    if (found.bytes !== raw.length || found.sha256 !== hash(raw)) fail("NATIVE_HISTORY_PAYLOAD_CONFLICT");
    return;
  }
  atomicCreateArtifact(file, raw);
}
function readRaw(root, entry, signal, assertCurrentAuthority) {
  if (entry.bytes > SNAPSHOT_STORAGE_LIMITS.decodedBytes) fail("NATIVE_HISTORY_FORMAT_READ_LIMIT");
  return readCopiedProjectExcerpt(root, entry, { maxBytes: Math.max(1, entry.bytes), signal, assertCurrentAuthority }).bytes;
}
function shapeEvidence(provider, raw, nativeId, selectedIds) {
  const result = inspectProviderHistoryOriginal(provider, raw, nativeId);
  return {
    nativeId,
    messageCount: result.messageCount,
    ...(result.partCount !== undefined ? { partCount: result.partCount } : {}),
    missingMessageParentCount: result.missingParents?.length ?? 0,
    ...(provider === "opencode"
      ? { nativeParentId: result.parentId, nativeParentIncludedInSelection: result.parentId ? selectedIds.has(result.parentId) : null }
      : {}),
    ...(provider === "claude"
      ? {
          selectedIdentityEvidence: result.selectedIdentityEvidence,
          selectedMessageCount: result.selectedMessageCount,
          foreignSessionMessageCount: result.foreignSessionMessageCount,
          foreignRowsOutsideSelectedAncestry: result.foreignRowsOutsideSelectedAncestry,
          messageRowsWithoutSessionId: result.messageRowsWithoutSessionId,
          officialNativeOwnershipVerified: false,
        }
      : {}),
    structuralEvidenceDigest: hash(bytes(result)),
    officialClientDecode: "not-performed",
  };
}

// Immutable selected raw files, not a source profile/DB/config copy. Actual
// official-client qualification is a separate Host operation and cannot be
// supplied by a boolean in this payload.
export function captureProviderNativeHistory({
  provider,
  sourceDirectory,
  nativeIds,
  files,
  destination,
  reportedClientVersion,
  signal,
  onObject,
  assertCurrentAuthority = () => {},
} = {}) {
  authority(signal, assertCurrentAuthority);
  if (!providers.has(provider)) fail("NATIVE_HISTORY_PROVIDER_UNSUPPORTED");
  if (!Array.isArray(nativeIds) || !nativeIds.length || nativeIds.some((value) => !id(value)) || new Set(nativeIds).size !== nativeIds.length)
    fail("NATIVE_HISTORY_EXACT_SELECTION_REQUIRED");
  if (!Array.isArray(files) || !files.length || typeof reportedClientVersion !== "string" || !reportedClientVersion) fail("NATIVE_HISTORY_SELECTION_INVALID");
  const source = fs.realpathSync(path.resolve(sourceDirectory)),
    parent = fs.realpathSync(path.dirname(path.resolve(destination)));
  const target = copiedProjectFile(parent, path.basename(path.resolve(destination)));
  if (inside(source, target) || inside(target, source)) fail("NATIVE_HISTORY_SOURCE_TARGET_OVERLAP");
  const names = new Set(),
    selected = new Set(nativeIds),
    rows = [],
    coverage = [],
    rootCounts = new Map();
  const messageIds = new Set(),
    partIds = new Set();
  for (const file of files) {
    authority(signal, assertCurrentAuthority);
    if (!file || !selected.has(file.nativeId) || !["conversation", "companion"].includes(file.role) || names.has(file.path))
      fail("NATIVE_HISTORY_SELECTION_INVALID");
    names.add(file.path);
    const observed = inspectCopiedProjectFile(source, file.path, { signal, assertCurrentAuthority });
    const raw = readRaw(source, observed, signal, assertCurrentAuthority);
    if (file.role === "conversation") {
      const shape = inspectProviderHistoryOriginal(provider, raw, file.nativeId);
      for (const value of shape.messageIds) {
        if (provider === "opencode" && messageIds.has(value)) fail("NATIVE_OPENCODE_GLOBAL_MESSAGE_COLLISION");
        messageIds.add(value);
      }
      for (const value of shape.partIds || []) {
        if (partIds.has(value)) fail("NATIVE_OPENCODE_GLOBAL_PART_COLLISION");
        partIds.add(value);
      }
      rootCounts.set(file.nativeId, (rootCounts.get(file.nativeId) || 0) + 1);
      coverage.push(shapeEvidence(provider, raw, file.nativeId, selected));
    }
    rows.push({ ...observed, nativeId: file.nativeId, role: file.role });
  }
  if (nativeIds.some((value) => rootCounts.get(value) !== 1)) fail("NATIVE_HISTORY_SELECTED_CONVERSATION_MISSING");
  const payload = {
    schemaVersion: 1,
    kind: "ProviderNativeHistoryPayload",
    authorityPlane: "P3",
    provider,
    format: provider === "claude" ? "claude-code-jsonl" : "opencode-v1-export-json",
    reportedClientVersion,
    sourceDirectory: source,
    nativeIds: [...nativeIds],
    files: rows,
    coverage,
    rawOriginals: "exact-selected-files",
    sourceConfiguration: "not-automatically-collected",
    credentialRedaction: "not-performed",
    attachments: "only-explicit-companions-no-external-reference-following",
    officialClientQualification: "not-performed",
    grantsRecoveryAuthority: false,
    restoresExecutionPermission: false,
    nativePublicationReady: false,
  };
  const raw = bytes(payload),
    payloadDigest = hash(raw),
    payloadId = "native-history-" + payloadDigest.slice(0, 24);
  authority(signal, assertCurrentAuthority);
  if (!fs.existsSync(target)) fs.mkdirSync(target);
  if (!fs.existsSync(copiedProjectFile(target, "capture-intent.json")) && fs.readdirSync(target).length) fail("NATIVE_HISTORY_DESTINATION_NOT_EMPTY");
  exact(target, "capture-intent.json", bytes({ schemaVersion: 1, kind: "NativeHistoryCaptureIntent", payloadId, payloadDigest }));
  const objects = copiedProjectFile(target, "objects");
  if (!fs.existsSync(objects)) fs.mkdirSync(objects);
  for (const entry of rows) copyOriginal(source, target, entry, { signal, onObject, assertCurrentAuthority });
  for (const entry of rows) verifyCopiedProjectFile(source, entry, { signal, assertCurrentAuthority });
  authority(signal, assertCurrentAuthority);
  exact(target, "manifest.json", raw);
  return inspectProviderNativePayload({ directory: target, expectedPayloadId: payloadId, expectedProvider: provider, signal });
}

export function inspectProviderNativePayload({ directory, expectedPayloadId = null, expectedProvider = null, signal } = {}) {
  if (signal?.aborted) fail("NATIVE_HISTORY_CAPTURE_CANCELLED");
  const root = fs.realpathSync(path.resolve(directory));
  const read = (relative) => {
    const file = copiedProjectFile(root, relative),
      stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) fail("NATIVE_HISTORY_PAYLOAD_UNSAFE");
    return readSnapshotFile(file, { decodedBytes: SNAPSHOT_STORAGE_LIMITS.decodedBytes });
  };
  const original = read("manifest.json"),
    payload = original.document,
    digest = hash(original.bytes),
    payloadId = "native-history-" + digest.slice(0, 24);
  const intent = read("capture-intent.json").document;
  if (
    intent?.schemaVersion !== 1 ||
    intent.kind !== "NativeHistoryCaptureIntent" ||
    intent.payloadId !== payloadId ||
    intent.payloadDigest !== digest ||
    (expectedPayloadId !== null && expectedPayloadId !== payloadId)
  )
    fail("NATIVE_HISTORY_PAYLOAD_IDENTITY_MISMATCH");
  if (
    !payload ||
    payload.schemaVersion !== 1 ||
    payload.kind !== "ProviderNativeHistoryPayload" ||
    payload.authorityPlane !== "P3" ||
    !providers.has(payload.provider) ||
    payload.format !== (payload.provider === "claude" ? "claude-code-jsonl" : "opencode-v1-export-json") ||
    !Array.isArray(payload.nativeIds) ||
    !payload.nativeIds.length ||
    payload.nativeIds.some((value) => !id(value)) ||
    new Set(payload.nativeIds).size !== payload.nativeIds.length ||
    !Array.isArray(payload.files) ||
    !Array.isArray(payload.coverage) ||
    payload.officialClientQualification !== "not-performed" ||
    payload.sourceConfiguration !== "not-automatically-collected" ||
    payload.credentialRedaction !== "not-performed" ||
    payload.grantsRecoveryAuthority !== false ||
    payload.restoresExecutionPermission !== false ||
    payload.nativePublicationReady !== false
  )
    fail("NATIVE_HISTORY_PAYLOAD_INVALID");
  if (expectedProvider !== null && expectedProvider !== payload.provider) fail("NATIVE_HISTORY_SAME_PLATFORM_REQUIRED");
  const selected = new Set(payload.nativeIds),
    seen = new Set(),
    roots = new Set(),
    coverage = [];
  const messages = new Set(),
    parts = new Set();
  for (const entry of payload.files) {
    if (
      !entry ||
      !selected.has(entry.nativeId) ||
      seen.has(entry.path) ||
      !["conversation", "companion"].includes(entry.role) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256 || "")
    )
      fail("NATIVE_HISTORY_PAYLOAD_INVALID");
    // Validate the original relative name too, without consulting its old host.
    copiedProjectFile(root, entry.path);
    seen.add(entry.path);
    const object = { path: "objects/" + entry.sha256 + ".bin", bytes: entry.bytes, sha256: entry.sha256 };
    const raw = readRaw(root, object, signal);
    if (entry.role === "conversation") {
      if (roots.has(entry.nativeId)) fail("NATIVE_HISTORY_PAYLOAD_INVALID");
      roots.add(entry.nativeId);
      const shape = inspectProviderHistoryOriginal(payload.provider, raw, entry.nativeId);
      for (const id of shape.messageIds) {
        if (payload.provider === "opencode" && messages.has(id)) fail("NATIVE_OPENCODE_GLOBAL_MESSAGE_COLLISION");
        messages.add(id);
      }
      for (const id of shape.partIds || []) {
        if (parts.has(id)) fail("NATIVE_OPENCODE_GLOBAL_PART_COLLISION");
        parts.add(id);
      }
      coverage.push(shapeEvidence(payload.provider, raw, entry.nativeId, selected));
    }
  }
  if (roots.size !== selected.size || JSON.stringify(coverage) !== JSON.stringify(payload.coverage)) fail("NATIVE_HISTORY_PAYLOAD_COVERAGE_MISMATCH");
  return {
    status: "verified-native-raw-originals",
    directory: root,
    provider: payload.provider,
    payload,
    payloadId,
    payloadDigest: digest,
    mechanicalOriginalsReady: true,
    nativePublicationReady: false,
    nativeClientVisibility: "not-observed",
    targetExecutionSettingsVerified: false,
    continuationReady: false,
    grantsRecoveryAuthority: false,
    restoresExecutionPermission: false,
  };
}

export function providerNativePayloadSummary(result) {
  return {
    status: result.status,
    provider: result.provider,
    payloadId: result.payloadId,
    payloadDigest: result.payloadDigest,
    nativeIds: result.payload.nativeIds,
    rawFileCount: result.payload.files.length,
    coverage: result.payload.coverage,
    mechanicalOriginalsReady: result.mechanicalOriginalsReady,
    nativePublicationReady: false,
    nativeClientVisibility: "not-observed",
    targetExecutionSettingsVerified: false,
    continuationReady: false,
    authorityPlane: "P4",
    ordinaryCoreBlocked: false,
    sourceConfiguration: "not-automatically-collected",
    credentialRedaction: "not-performed",
    grantsRecoveryAuthority: false,
    restoresExecutionPermission: false,
  };
}
