import { inspectProviderNativePayload, providerNativePayloadSummary } from "./provider-native-history-payload.mjs";
import fs from "node:fs";
import path from "node:path";
import { inspectProjectBundle } from "../storage/project-portability.mjs";
import { inspectCodexNativePayload, codexNativePayloadSummary } from "../distribution/codex-native-payload.mjs";
import { copiedProjectFile, inspectCopiedProjectFile, copyOriginal } from "../storage/project-copy-evidence.mjs";
import { atomicCreateArtifact } from "../core/fs-atomic.mjs";
import { readSnapshotFile } from "../world/snapshot-storage-codec.mjs";
import { sha256Hex as hash } from "../core/digest.mjs";
import { failCode as fail } from "../core/errors.mjs";

const providers = new Set(["codex", "claude", "opencode"]);
const relativeFor = (provider) => (providers.has(provider) ? "native/" + provider + "/history" : null);
const inspectNative = (provider, options) =>
  provider === "codex" ? inspectCodexNativePayload(options) : inspectProviderNativePayload({ ...options, expectedProvider: provider });
const linkPath = "native-history.json";
const bytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const cancelled = (signal) => {
  if (signal?.aborted) fail("PROJECT_NATIVE_TRANSFER_CANCELLED");
};

function linkFor(common, native, provider = "codex") {
  return {
    schemaVersion: 1,
    kind: "NativeHistoryTransferLink",
    authorityPlane: "P3",
    bundleId: common.bundleId,
    commonManifestDigest: common.manifestSha256,
    projectId: common.manifest.projectId,
    selectedSessionId: common.manifest.selectedSessionId,
    provider,
    path: relativeFor(provider),
    payloadId: native.payloadId,
    payloadDigest: native.payloadDigest,
    selection: "explicit-native-history-selection",
    logicalSessionOwnership: "not-established-by-this-link",
    transfersNativeBinding: false,
    grantsRecoveryAuthority: false,
    restoresExecutionPermission: false,
  };
}
function readLink(root) {
  const file = copiedProjectFile(root, linkPath),
    stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) fail("PROJECT_NATIVE_TRANSFER_LINK_INVALID");
  return readSnapshotFile(file, { decodedBytes: 65536 });
}

// A companion is explicit transfer evidence, not a native owner/binding or a
// dependency of common Core recovery. One link per explicit immutable bundle;
// reads never create it, start an SDK or repair a partial publication.
export function readProjectNativeTransfer({ bundleRoot, expectedBundleId = null, signal } = {}) {
  const common = inspectProjectBundle({ bundleRoot, expectedBundleId, signal });
  const root = common.bundleRoot;
  cancelled(signal);
  if (!fs.existsSync(copiedProjectFile(root, linkPath)))
    return {
      status: [...providers].some((provider) => fs.existsSync(copiedProjectFile(root, "native/" + provider)))
        ? "native-transfer-incomplete-without-link"
        : "native-history-not-attached",
      bundleId: common.bundleId,
      commonManifestDigest: common.manifestSha256,
      commonProjectAdmissionReady: common.projectAdmissionReady,
      native: null,
      ordinaryCoreBlocked: false,
      authorityPlane: "P4",
      persisted: false,
      grantsRecoveryAuthority: false,
      restoresExecutionPermission: false,
      transfersNativeBinding: false,
    };
  const original = readLink(root),
    link = original.document;
  if (!link || !providers.has(link.provider) || link.path !== relativeFor(link.provider)) fail("PROJECT_NATIVE_TRANSFER_LINK_INVALID");
  const native = inspectNative(link.provider, {
    directory: copiedProjectFile(root, relativeFor(link.provider)),
    expectedPayloadId: link.payloadId,
    signal,
  });
  if (!original.bytes.equals(bytes(linkFor(common, native, link.provider)))) fail("PROJECT_NATIVE_TRANSFER_LINK_MISMATCH");
  return {
    status: native.provider
      ? "verified-native-raw-transfer"
      : native.mechanicalOriginalsReady
        ? "verified-native-transfer"
        : "verified-native-transfer-partial",
    bundleId: common.bundleId,
    commonManifestDigest: common.manifestSha256,
    projectId: common.manifest.projectId,
    selectedSessionId: common.manifest.selectedSessionId,
    commonProjectAdmissionReady: common.projectAdmissionReady,
    sourceProvider: link.provider,
    linkDigest: hash(original.bytes),
    native,
    ordinaryCoreBlocked: false,
    authorityPlane: "P4",
    persisted: false,
    logicalSessionOwnership: "not-established-by-this-link",
    grantsRecoveryAuthority: false,
    restoresExecutionPermission: false,
    transfersNativeBinding: false,
  };
}

export function projectNativeTransferSummary(result) {
  const { native, ...summary } = result;
  return { ...summary, native: native ? (native.provider ? providerNativePayloadSummary(native) : codexNativePayloadSummary(native)) : null };
}

// Recheck the exact already-verified selection headers at effect boundaries.
// This does not reload P2, infer native ownership or turn transfer data into
// authorization. Native payload/raw verification remains in its own adapter.
export function assertProjectNativeTransferCurrent({ bundleRoot, commonManifestDigest, linkDigest, signal }) {
  cancelled(signal);
  const root = fs.realpathSync(path.resolve(bundleRoot));
  if (
    inspectCopiedProjectFile(root, "manifest.json", { signal }).sha256 !== commonManifestDigest ||
    inspectCopiedProjectFile(root, linkPath, { signal }).sha256 !== linkDigest
  )
    fail("PROJECT_NATIVE_TRANSFER_IDENTITY_CHANGED");
}

export function attachProjectNativeTransfer({
  provider = "codex",
  bundleRoot,
  directory,
  expectedBundleId = null,
  signal,
  onObject,
  assertCurrentAuthority = () => {},
} = {}) {
  const check = () => {
    cancelled(signal);
    if (typeof assertCurrentAuthority !== "function") fail("NATIVE_CODEX_AUTHORITY_CHECK_REQUIRED");
    const result = assertCurrentAuthority();
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch(() => {});
      fail("NATIVE_CODEX_SYNCHRONOUS_AUTHORITY_REQUIRED");
    }
  };
  check();

  if (!providers.has(provider)) fail("NATIVE_HISTORY_PROVIDER_UNSUPPORTED");
  const common = inspectProjectBundle({ bundleRoot, expectedBundleId, signal }),
    native = inspectNative(provider, { directory, signal }),
    relative = relativeFor(provider),
    root = common.bundleRoot;
  cancelled(signal);
  const encoded = bytes(linkFor(common, native, provider)),
    existing = copiedProjectFile(root, linkPath);
  if (fs.existsSync(existing)) {
    if (!readLink(root).bytes.equals(encoded)) fail("PROJECT_NATIVE_TRANSFER_LINK_CONFLICT");
    return projectNativeTransferSummary(readProjectNativeTransfer({ bundleRoot: root, expectedBundleId: common.bundleId, signal }));
  }
  check();
  const target = copiedProjectFile(root, relative);
  fs.mkdirSync(target, { recursive: true });
  copiedProjectFile(root, relative);
  const copy = (name) => {
    check();
    const observed = inspectCopiedProjectFile(native.directory, name, {
      signal,
      assertCurrentAuthority: check,
    });
    check();
    const destination = copiedProjectFile(root, relative + "/" + name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    copiedProjectFile(root, relative + "/" + name);
    copyOriginal(native.directory, root, observed, {
      signal,
      onObject,
      assertCurrentAuthority: check,
      targetRelative: relative + "/" + name,
    });
  };
  // The capture intent and immutable raw objects precede its manifest; the link
  // is last. A stopped copy remains identifiable without claiming completion.
  copy("capture-intent.json");
  for (const sha256 of new Set(native.payload.files.map((file) => file.sha256))) copy("objects/" + sha256 + ".bin");
  copy("manifest.json");
  check();
  const copied = inspectNative(provider, {
    directory: target,
    expectedPayloadId: native.payloadId,
    signal,
  });
  const current = inspectNative(provider, {
    directory: native.directory,
    expectedPayloadId: native.payloadId,
    signal,
  });
  const currentCommon = inspectProjectBundle({
    bundleRoot: root,
    expectedBundleId: common.bundleId,
    signal,
  });
  if (current.payloadDigest !== native.payloadDigest || copied.payloadDigest !== native.payloadDigest || currentCommon.manifestSha256 !== common.manifestSha256)
    fail("PROJECT_NATIVE_TRANSFER_SOURCE_CHANGED");
  check();
  try {
    atomicCreateArtifact(existing, encoded);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!readLink(root).bytes.equals(encoded)) fail("PROJECT_NATIVE_TRANSFER_LINK_CONFLICT");
  }
  return {
    ...projectNativeTransferSummary(readProjectNativeTransfer({ bundleRoot: root, expectedBundleId: common.bundleId, signal })),
    persisted: true,
  };
}

export function projectNativeCaptureDirectory({ provider = "codex", bundleRoot, expectedBundleId = null, assertCurrentAuthority = () => {} } = {}) {
  const check = () => {
    if (typeof assertCurrentAuthority !== "function") fail("NATIVE_CODEX_AUTHORITY_CHECK_REQUIRED");
    const result = assertCurrentAuthority();
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch(() => {});
      fail("NATIVE_CODEX_SYNCHRONOUS_AUTHORITY_REQUIRED");
    }
  };
  check();
  const common = inspectProjectBundle({ bundleRoot, expectedBundleId });
  if (!providers.has(provider)) fail("NATIVE_HISTORY_PROVIDER_UNSUPPORTED");
  const parent = copiedProjectFile(common.bundleRoot, "native/" + provider);
  check();
  fs.mkdirSync(parent, { recursive: true });
  copiedProjectFile(common.bundleRoot, "native/" + provider);
  return path.join(parent, "history");
}
