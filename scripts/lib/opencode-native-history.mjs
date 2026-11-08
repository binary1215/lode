import fs from "node:fs";
import path from "node:path";
import { atomicCreateArtifact } from "./artifact-storage.mjs";
import { copiedProjectFile } from "./project-copy-evidence.mjs";
import { captureProviderNativeHistory } from "./provider-native-history-payload.mjs";
import { inspectOpenCodeHistoryOriginal, deriveOpenCodeHistoryImport } from "./provider-native-history-format.mjs";
import { requestNativeRegistration } from "./native-registration-journal.mjs";
import {
  nativeCheck,
  nativeFail,
  nativeHash,
  nativeJson,
  nativeRoot,
  pinNativeRoot,
  nativeObject,
  nativeRaw,
  nativeSeparate,
  nativeOutcome,
} from "./provider-native-history-host.mjs";

const canonical = (value) =>
  value && typeof value === "object"
    ? Array.isArray(value)
      ? value.map(canonical)
      : Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
    : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function ordered(messages) {
  return [...messages]
    .sort((a, b) => a.info.time.created - b.info.time.created || (a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0))
    .map((row) => ({ info: row.info, parts: [...row.parts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) }));
}
export function compareOpenCodeImportedHistory(expected, actual, root) {
  inspectOpenCodeHistoryOriginal(nativeJson(actual), expected.info.id);
  if (path.resolve(actual.info.directory) !== root || typeof actual.info.projectID !== "string" || !actual.info.projectID)
    nativeFail("NATIVE_OPENCODE_TARGET_PROJECT_MISMATCH");
  const withoutLocation = (info) => Object.fromEntries(Object.entries(info).filter(([key]) => !["directory", "projectID", "path"].includes(key)));
  if (!equal(withoutLocation(expected.info), withoutLocation(actual.info)) || !equal(ordered(expected.messages), ordered(actual.messages)))
    nativeFail("NATIVE_OPENCODE_HISTORY_READBACK_MISMATCH");
  return nativeHash(nativeJson(canonical(actual)));
}
function selection(native, signal, check) {
  const plans = [];
  for (const entry of native.payload.files) {
    if (entry.role !== "conversation") nativeFail("NATIVE_OPENCODE_COMPANION_IMPORT_UNSUPPORTED");
    const original = nativeObject(native, entry, signal, check);
    const derived = deriveOpenCodeHistoryImport(original, { nativeId: entry.nativeId });
    plans.push({ entry, original, derived, expected: JSON.parse(derived.bytes) });
  }
  return plans;
}
export async function operateOpenCodeNativeHistory({
  action,
  selected,
  nativeHome,
  root,
  threadIds,
  companionPaths = [],
  host,
  signal,
  assertCurrentAuthority = () => {},
  captureDirectory,
  attach,
}) {
  const roots = [];
  const check = () => {
    nativeCheck(signal, assertCurrentAuthority);
    for (const item of roots) item.verify();
  };
  check();
  const project = nativeRoot(root),
    home = action === "capture" ? null : nativeRoot(nativeHome);
  roots.push(pinNativeRoot(project), ...(home ? [pinNativeRoot(home)] : []));
  if (home) nativeSeparate(home, nativeRoot(selected.bundleRoot));
  if (companionPaths.length) nativeFail("NATIVE_OPENCODE_COMPANION_IMPORT_UNSUPPORTED");
  const version = "1.19.5";
  const atomic = typeof host.observeAtomicBatch === "function" && typeof host.publishAtomicBatch === "function";
  const base = {
    clientEvidence: host.evidenceKind,
    clientVersion: version,
    profileMode: "explicit-isolated-profile",
    defaultProfileChanged: false,
    metadataCommandsArePureFileReads: false,
    officialPredecode: atomic ? "source-bound-fixed-version-validation; not an Effect decoder" : "not-performed",
    ...(atomic
      ? {
          profileMode: "explicit-qualified-isolated-db",
          metadataCommandsArePureFileReads: false,
          metadataCommandMode: "read-only-sqlite; WAL/SHM activity is not byte-level immutability",
          nativeClientVisibility: "qualified-db-readback; live app cache not observed",
          atomicBatchPublication: true,
          providerProcessStarted: false,
        }
      : {}),
  };
  if (action === "capture") {
    // Source profile routing belongs to the current Host capability, not an
    // invented isolated-home mapping or a new source CLI/bootstrap.
    if (host.clientVersion !== version) nativeFail("NATIVE_OPENCODE_VERSION_UNQUALIFIED");
    if (
      !Array.isArray(threadIds) ||
      !threadIds.length ||
      new Set(threadIds).size !== threadIds.length ||
      threadIds.some((id) => typeof id !== "string" || id.length > 256 || !/^ses_[A-Za-z0-9_]+$/u.test(id))
    )
      nativeFail("NATIVE_OPENCODE_SELECTION_INVALID");
    const exports = [],
      messageIds = new Set(),
      partIds = new Set();
    // Gather and inspect all selected exports before creating transfer objects.
    for (const id of threadIds) {
      check();
      const raw = await host.exportSelected({ nativeId: id, projectRoot: project, signal });
      check();
      if (!Buffer.isBuffer(raw)) nativeFail("NATIVE_OPENCODE_EXPORT_CAPABILITY_INVALID");
      const shape = inspectOpenCodeHistoryOriginal(raw, id);
      for (const messageId of shape.messageIds) {
        if (messageIds.has(messageId)) nativeFail("NATIVE_OPENCODE_GLOBAL_MESSAGE_COLLISION");
        messageIds.add(messageId);
      }
      for (const partId of shape.partIds) {
        if (partIds.has(partId)) nativeFail("NATIVE_OPENCODE_GLOBAL_PART_COLLISION");
        partIds.add(partId);
      }
      exports.push({ id, raw });
    }
    const destination = captureDirectory(),
      parent = nativeRoot(path.dirname(destination));
    const source = copiedProjectFile(parent, "selected-exports");
    if (!fs.existsSync(source)) fs.mkdirSync(source);
    copiedProjectFile(parent, "selected-exports");
    for (const item of exports) {
      // Provider IDs are case-sensitive, even on a case-insensitive target FS.
      const relative = nativeHash(item.id) + ".json",
        file = copiedProjectFile(source, relative);
      if (fs.existsSync(file)) {
        if (!nativeRaw(source, relative, signal, check).raw.equals(item.raw)) nativeFail("NATIVE_OPENCODE_CAPTURE_EXPORT_CHANGED");
      } else {
        check();
        atomicCreateArtifact(file, item.raw);
      }
    }
    const captured = captureProviderNativeHistory({
      provider: "opencode",
      sourceDirectory: source,
      destination,
      nativeIds: threadIds,
      reportedClientVersion: version,
      files: exports.map((item) => ({ path: nativeHash(item.id) + ".json", nativeId: item.id, role: "conversation" })),
      signal,
      assertCurrentAuthority: check,
    });
    return {
      ...attach(captured.directory),
      ...base,
      originalExportPreserved: true,
      nativeClientVisibility: "selected-id-export-observed",
      sourceCaptureCapability: "current-host-exact-id-export",
      sourceCutoff: "per-ID-export; not an atomic source-DB snapshot",
    };
  }
  if (threadIds !== undefined) nativeFail("PROJECT_NATIVE_SELECTION_IS_IN_PAYLOAD");
  const native = selected.native,
    plans = selection(native, signal, check);
  if (!["restore", "register"].includes(action)) nativeFail("PROJECT_NATIVE_ACTION_INVALID");
  const marker = {
    schemaVersion: 1,
    kind: "OpenCodeIsolatedHistoryProfile",
    authorityPlane: "P5",
    payloadDigest: native.payloadDigest,
    projectRootDigest: nativeHash(project),
    providerVersion: version,
    automaticReplayAllowed: false,
    grantsRecoveryAuthority: false,
    restoresExecutionPermission: false,
  };
  const markerFile = copiedProjectFile(home, "native-profile-intent.json"),
    profile = copiedProjectFile(home, "profile");
  if (fs.existsSync(markerFile)) {
    if (!nativeRaw(home, "native-profile-intent.json", signal, check).raw.equals(nativeJson(marker))) nativeFail("NATIVE_OPENCODE_PROFILE_CONFLICT");
  } else if (action === "register") return nativeOutcome("opencode", { ...base, status: "native-history-not-restored" });
  else if (atomic ? fs.readdirSync(home).some((name) => name !== "profile") : fs.readdirSync(home).length)
    nativeFail("NATIVE_OPENCODE_NEW_ISOLATED_PROFILE_REQUIRED");
  // All path/profile admission checks precede even a version command.
  const observedVersion = await host.version({ home, cwd: project });
  check();
  if (observedVersion !== version) nativeFail("NATIVE_OPENCODE_VERSION_UNQUALIFIED");
  const documents = plans.map((plan) => ({ nativeId: plan.entry.nativeId, raw: plan.derived.bytes }));
  if (action === "restore" && !atomic)
    return nativeOutcome("opencode", {
      ...base,
      status: "native-atomic-history-capability-unavailable",
      reasonCode: "NATIVE_OPENCODE_ATOMIC_BATCH_HOST_REQUIRED",
      persisted: false,
    });
  if (atomic) {
    check();
    const preflight = await host.observeAtomicBatch({ documents, cwd: project, home: profile });
    check();
    if (!["absent", "matches", "partial", "diverged"].includes(preflight.state)) nativeFail("NATIVE_OPENCODE_ATOMIC_OBSERVATION_INVALID");
    if (["partial", "diverged"].includes(preflight.state))
      return nativeOutcome("opencode", {
        ...base,
        status: "native-history-target-conflict",
        currentObservation: preflight.state,
        persisted: false,
        reasonCode: preflight.state === "partial" ? "NATIVE_OPENCODE_PARTIAL_HISTORY_OBSERVED" : "NATIVE_OPENCODE_HISTORY_READBACK_MISMATCH",
      });
    // This is observation, not a fresh write license. Existing attempts are
    // still reconciled below by the create-only at-most-once journal.
  }
  let observations = [],
    listing = null,
    readbackFailure = null,
    normalizations = [];
  const observe = async () => {
    check();
    if (!fs.existsSync(profile)) return { state: "absent" };
    nativeRoot(profile);
    if (atomic) {
      const observed = await host.observeAtomicBatch({ documents, cwd: project, home: profile });
      check();
      if (observed.state === "matches") {
        normalizations = observed.normalizations ?? [];
        observations = observed.documents.map((actual) => ({
          nativeId: actual.info.id,
          messageCount: actual.messages.length,
          partCount: actual.messages.reduce((n, row) => n + row.parts.length, 0),
          historyDigest: nativeHash(nativeJson(canonical(actual))),
        }));
        return { state: "matches", evidenceDigest: observed.evidenceDigest };
      }
      if (observed.state === "partial") return { state: "unknown", primaryReadbackCode: "NATIVE_OPENCODE_PARTIAL_HISTORY_OBSERVED" };
      if (!["absent", "diverged"].includes(observed.state)) nativeFail("NATIVE_OPENCODE_ATOMIC_OBSERVATION_INVALID");
      return { state: observed.state };
    }
    const results = [];
    for (const plan of plans) {
      try {
        const read = await host.run({ args: ["export", plan.entry.nativeId], cwd: project, home: profile });
        check();
        const actual = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.stdout));
        const digest = compareOpenCodeImportedHistory(plan.expected, actual, project);
        results.push({
          nativeId: plan.entry.nativeId,
          messageCount: actual.messages.length,
          partCount: actual.messages.reduce((n, row) => n + row.parts.length, 0),
          historyDigest: digest,
        });
      } catch (error) {
        if (signal?.aborted || error.code === "NATIVE_HISTORY_OPERATION_CANCELLED") throw error;
        readbackFailure = { code: error.code || "NATIVE_OPENCODE_READBACK_UNAVAILABLE" };
        return {
          state:
            error.code === "NATIVE_OPENCODE_HISTORY_READBACK_MISMATCH" || error.code === "NATIVE_OPENCODE_TARGET_PROJECT_MISMATCH" ? "diverged" : "unknown",
          primaryReadbackCode: error.code || "NATIVE_OPENCODE_READBACK_UNAVAILABLE",
        };
      }
    }
    observations = results;
    return { state: "matches", evidenceDigest: nativeHash(nativeJson(results)) };
  };
  const list = async () => {
    check();
    const result = await host.run({ args: ["session", "list", "--format", "json"], cwd: project, home: profile });
    check();
    const rows = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout));
    if (!Array.isArray(rows)) nativeFail("NATIVE_OPENCODE_LIST_INVALID");
    listing = plans.map((plan) => ({ nativeId: plan.entry.nativeId, visibleInReturnedList: rows.some((row) => row.id === plan.entry.nativeId) }));
    // Default list excludes children/older roots; exact export is independent.
  };
  if (action === "register") {
    const observed = await observe();
    if (observed.state !== "matches")
      return nativeOutcome("opencode", {
        ...base,
        status: "native-history-readback-unverified",
        currentObservation: observed.state,
        primaryFailure: observed.primaryReadbackCode ? { code: observed.primaryReadbackCode } : null,
      });
    await list();
    return nativeOutcome("opencode", {
      ...base,
      status: "native-history-reader-observed",
      isolatedProfile: profile,
      historyReadbackVerified: true,
      observations,
      listing,
      ...(atomic ? { normalizations } : {}),
      listCoverage: atomic ? "qualified-db-root-list; child IDs require exact readback" : "official-default-root-list; not all historical IDs",
    });
  }
  check();
  if (!fs.existsSync(markerFile)) atomicCreateArtifact(markerFile, nativeJson(marker));
  const operationRoot = copiedProjectFile(home, ".lode-native-transfer");
  fs.mkdirSync(operationRoot, { recursive: true });
  copiedProjectFile(home, ".lode-native-transfer");
  const input = {
    provider: "opencode",
    profileId: atomic ? host.atomicProfileId : "opencode-official-isolated-1.19.5",
    payloadDigest: native.payloadDigest,
    targetHomeDigest: nativeHash(home),
    nativeThreadId: native.payloadId,
    targetPathDigest: nativeHash(project),
    currentPolicyDigest: nativeHash("no-source-active-settings-no-prompt"),
    runtimeRootsDigest: nativeHash(project),
  };
  let importsAttempted = 0;
  let result;
  try {
    result = await requestNativeRegistration({
      operationRoot,
      input,
      assertCurrentAuthority: check,
      readStatus: async ({ inputDigest }) => ({ ...(await observe()), inputDigest }),
      register: async () => {
        check();
        for (const plan of plans) nativeObject(native, plan.entry, signal, check);
        check();
        importsAttempted++;
        await host.publishAtomicBatch({ documents, cwd: project, home: profile });
        check();
      },
    });
  } catch (error) {
    return nativeOutcome("opencode", {
      ...base,
      status: "native-history-operation-uncertain",
      historyReadbackVerified: false,
      isolatedProfile: profile,
      importsAttempted,
      observations,
      primaryFailure: {
        code: error.code || "NATIVE_OPENCODE_OPERATION_FAILED",
        ...(error.nativeCleanupFailure ? { cleanupFailure: error.nativeCleanupFailure } : {}),
        ...(error.nativeDatabaseOutcome ? { databaseOutcome: error.nativeDatabaseOutcome } : {}),
      },
      recovery: "Inspect this exact batch in the selected isolated DB on a fresh authorized request; do not replay publication.",
    });
  }
  let listFailure = null;
  if (result.status === "native-registration-verified") {
    try {
      await list();
    } catch (error) {
      listFailure = { code: error.code || "NATIVE_OPENCODE_LIST_UNAVAILABLE" };
    }
  }
  return nativeOutcome("opencode", {
    ...base,
    ...result,
    status: result.status === "native-registration-verified" ? "native-isolated-history-restoration-verified" : result.status,
    isolatedProfile: profile,
    historyReadbackVerified: result.status === "native-registration-verified",
    ...(atomic ? { listCoverage: "qualified-db-root-list; child IDs require exact readback" } : {}),
    ...(atomic ? { normalizations } : {}),
    observations,
    listing,
    listFailure,
    readbackFailure,
    importsAttempted,
    sourceOriginalsChanged: false,
    derivations: plans.map((plan) => ({
      nativeId: plan.entry.nativeId,
      sourceSha256: plan.derived.sourceSha256,
      importSha256: plan.derived.importSha256,
      changes: plan.derived.changes,
    })),
  });
}
