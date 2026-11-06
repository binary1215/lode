import fs from "node:fs";
import path from "node:path";
import { inspectProjectBundle } from "./project-portability.mjs";
import { prepareCodexNativeOffline } from "./codex-native-offline.mjs";
import { captureCodexNativeHistory } from "./codex-native-capture.mjs";
import { publishCodexNativeHistory } from "./codex-native-publication.mjs";
import { registerCodexNativeHistory } from "./codex-native-registration.mjs";
import { resolveVerifiedProcessSupervisor } from "./runtime-process-supervisor.mjs";
import { copiedProjectFile, inspectCopiedProjectFile } from "./project-copy-evidence.mjs";
import { createProviderNativeHost } from "./provider-native-history-host.mjs";
import {
  projectNativeCaptureDirectory,
  attachProjectNativeTransfer,
  readProjectNativeTransfer,
  projectNativeTransferSummary,
  assertProjectNativeTransferCurrent,
} from "./project-native-transfer.mjs";

const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const unavailable = (offline) => ({
  status: "native-offline-window-unavailable",
  reason: offline.status,
  ordinaryCoreBlocked: false,
  sdkLifecycleRequestedThisCall: false,
  appsStopped: false,
  mcpRestarted: false,
  persisted: false,
  grantsRecoveryAuthority: false,
  restoresExecutionPermission: false,
});
function registrationEnvironment(home) {
  // Current destination process only. Source config/account/credential
  // environment is never copied into a registration process.
  const keys = [
    "SystemRoot",
    "WINDIR",
    "PATH",
    "Path",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ];
  return {
    ...Object.fromEntries(
      keys
        .filter((key) => typeof process.env[key] === "string")
        .map((key) => [key, process.env[key]]),
    ),
    CODEX_HOME: home,
  };
}

// One public Host operation, distinct explicit effects. read never starts a
// provider; restore never implicitly registers/opens it. The caller carries
// the user's actual requested scope, not authority inferred from the bundle.
export async function operateProjectNativeHistory({
  action,
  provider,
  bundleRoot,
  expectedBundleId = null,
  nativeHome,
  executable,
  threadIds,
  sourceProjectId,
  companionPaths = [],
  derivationId = null,
  expectedDerivationDigest = null,
  cutoffItemId = null,
  collectionRoot,
  collectionId,
  expectedCollectionDigest,
  workspaceMappings,
  workspaceTransfers,
  lodeBundles,
  physicalSourceRoot,
  physicalRolloutId,
  physicalFiles,
  selectedStateEvidenceFile,
  expectedSelectedStateDigest,
  catalogFile,
  expectedCatalogDigest,
  physicalSources,
  retainedDerivationSources,
  archiveId,
  expectedArchiveDigest,
  sessionBundleId,
  outputDirectory,
  sourceSyncFiles,
  ancestorFiles,
  sourceSelectionFile,
  expectedSourceSelectionDigest,
  sourceProjectRoot,
  workspaceSources,
  workspaceTargets,
  nativeHistoryHost = null,
  root,
  pluginRoot,
  signal,
  onProcess,
  assertCurrentAuthority = () => {},
} = {}) {
  if (workspaceSources !== undefined && !["capture-live-project", "export-project-evidence"].includes(action)) fail("PORTABLE_WORKSPACE_SOURCE_ARGUMENTS_ON_OTHER_ACTION");
  if (workspaceTargets !== undefined && action !== "restore-portable-workspaces") fail("PORTABLE_WORKSPACE_TARGET_ARGUMENTS_ON_OTHER_ACTION");
  if (action === "capture-live-project") {
    if (provider !== "codex" || expectedBundleId !== null || executable !== undefined || root !== undefined
      || derivationId !== null || expectedDerivationDigest !== null || cutoffItemId !== null || companionPaths.length
      || [collectionRoot,collectionId,expectedCollectionDigest,workspaceMappings,workspaceTransfers,physicalSourceRoot,physicalRolloutId,physicalFiles,
        selectedStateEvidenceFile,expectedSelectedStateDigest,catalogFile,expectedCatalogDigest,physicalSources,retainedDerivationSources,archiveId,expectedArchiveDigest,sessionBundleId,outputDirectory].some(value=>value!==undefined))
      fail("LIVE_PROJECT_CAPTURE_ARGUMENTS_INVALID");
    return (await import("./portable-project-evidence.mjs")).exportCodexLiveProjectEvidence({ directory: bundleRoot, home: nativeHome, sourceProjectId, threadIds,
      ancestorFiles, sourceSelectionFile, expectedSourceSelectionDigest, sourceProjectRoot, lodeBundles, workspaceSources,
      allowSynchronizationFiles: sourceSyncFiles, signal, onProcess, assertCurrentAuthority });
  }
  if ([sourceSyncFiles,ancestorFiles,sourceSelectionFile,expectedSourceSelectionDigest,sourceProjectRoot].some(value=>value!==undefined)) fail("LIVE_PROJECT_CAPTURE_ARGUMENTS_ON_OTHER_ACTION");
  if (action === "restore-portable-workspaces") {
    if (provider !== undefined || expectedBundleId !== null || nativeHome !== undefined || executable !== undefined || sourceProjectId !== undefined || threadIds !== undefined
      || root !== undefined || derivationId !== null || expectedDerivationDigest !== null || cutoffItemId !== null || companionPaths.length
      || [collectionRoot,collectionId,expectedCollectionDigest,workspaceMappings,workspaceTransfers,lodeBundles,physicalSourceRoot,physicalRolloutId,physicalFiles,
        selectedStateEvidenceFile,expectedSelectedStateDigest,catalogFile,expectedCatalogDigest,physicalSources,retainedDerivationSources,sessionBundleId,outputDirectory].some(value=>value!==undefined)) fail("PORTABLE_WORKSPACE_RESTORE_ARGUMENTS_INVALID");
    return (await import("./portable-workspace-evidence.mjs")).restorePortableWorkspaces({ directory: bundleRoot, archiveId, expectedArchiveDigest, workspaceTargets, signal, assertCurrentAuthority });
  }
  if (workspaceTargets !== undefined) fail("PORTABLE_WORKSPACE_TARGET_ARGUMENTS_ON_OTHER_ACTION");
  if (["read-portable-project", "derive-portable-project", "admit-portable-targets", "publish-portable-project", "verify-portable-project"].includes(action)) {
    if (provider !== undefined && provider !== "claude" || expectedBundleId !== null || sourceProjectId !== undefined || derivationId !== null
      || expectedDerivationDigest !== null || cutoffItemId !== null || companionPaths.length
      || [collectionRoot,collectionId,expectedCollectionDigest,workspaceTransfers,lodeBundles,physicalSourceRoot,physicalRolloutId,physicalFiles,
        selectedStateEvidenceFile,expectedSelectedStateDigest,catalogFile,expectedCatalogDigest,physicalSources,retainedDerivationSources,sessionBundleId,outputDirectory].some(value=>value!==undefined))
      fail("PORTABLE_PROJECT_NATIVE_ARGUMENTS_INVALID");
    let host = nativeHistoryHost;
    if (["read-portable-project","derive-portable-project"].includes(action)) {
      if (nativeHome !== undefined || executable !== undefined) fail("PORTABLE_PROJECT_NATIVE_READ_ARGUMENTS_INVALID");
      host = null;
    } else if (action !== "admit-portable-targets" && !host && executable !== undefined) host = createProviderNativeHost({ provider: "claude", executable, pluginRoot, signal, onProcess });
    return (await import("./portable-project-native.mjs")).operatePortableProjectNative({ action, directory: bundleRoot, archiveId, expectedArchiveDigest,
      threadIds, root, workspaceMappings, nativeHome, host, destinationHost: host?.destinationImportHost, signal, assertCurrentAuthority });
  }
  if (["export-project-evidence", "read-project-evidence", "stage-project-session"].includes(action)) {
    // Portable evidence is independent of target provider, native lifecycle and
    // target-journal policy. A supplied capability is never an implied effect.
    if (provider !== undefined || expectedBundleId !== null || nativeHome !== undefined || executable !== undefined || sourceProjectId !== undefined
      || threadIds !== undefined || root !== undefined || derivationId !== null || expectedDerivationDigest !== null || cutoffItemId !== null || companionPaths.length
      || [collectionRoot,collectionId,expectedCollectionDigest,workspaceMappings,workspaceTransfers,physicalSourceRoot,physicalRolloutId,physicalFiles,selectedStateEvidenceFile,expectedSelectedStateDigest,retainedDerivationSources].some(value=>value!==undefined))
      fail("PORTABLE_EVIDENCE_ARGUMENTS_INVALID");
    const portable = await import("./portable-project-evidence.mjs");
    if (action === "export-project-evidence") {
      if ([archiveId,expectedArchiveDigest,sessionBundleId,outputDirectory].some(value=>value!==undefined)) fail("PORTABLE_EVIDENCE_ARGUMENTS_INVALID");
      return portable.exportPortableProjectEvidence({ directory: bundleRoot, catalogFile, expectedCatalogDigest, physicalSources, lodeBundles, workspaceSources, signal, assertCurrentAuthority });
    }
    if ([catalogFile,expectedCatalogDigest,physicalSources,lodeBundles].some(value=>value!==undefined)) fail("PORTABLE_EVIDENCE_ARGUMENTS_INVALID");
    if (action === "read-project-evidence") {
      if ([sessionBundleId,outputDirectory].some(value=>value!==undefined)) fail("PORTABLE_EVIDENCE_ARGUMENTS_INVALID");
      return portable.readPortableProjectEvidence({ directory: bundleRoot, archiveId, expectedArchiveDigest, signal, assertCurrentAuthority });
    }
    return portable.materializePortableProjectSessionBundle({ directory: bundleRoot, archiveId, expectedArchiveDigest, bundleId: sessionBundleId, outputDirectory, signal, assertCurrentAuthority });
  }
  if ([archiveId,expectedArchiveDigest,sessionBundleId,outputDirectory].some(value=>value!==undefined)) fail("PORTABLE_EVIDENCE_ARGUMENTS_ON_OTHER_ACTION");
  if (action === "assemble-project") {
    if (provider !== undefined && provider !== "claude") fail("DERIVED_TARGET_PROVIDER_MUST_BE_CLAUDE");
    if (expectedBundleId !== null || nativeHome !== undefined || executable !== undefined || sourceProjectId !== undefined || threadIds !== undefined
      || root !== undefined || derivationId !== null || expectedDerivationDigest !== null || cutoffItemId !== null || companionPaths.length
      || [collectionRoot,collectionId,expectedCollectionDigest,workspaceTransfers,lodeBundles,physicalSourceRoot,physicalRolloutId,physicalFiles,selectedStateEvidenceFile,expectedSelectedStateDigest,retainedDerivationSources].some(value=>value!==undefined))
      fail("CAPTURED_PROJECT_ASSEMBLY_ARGUMENTS_INVALID");
    const created = (await import("./captured-project-collection.mjs")).assembleCapturedProjectCollection({ catalogFile, expectedCatalogDigest,
      collectionRoot: bundleRoot, physicalSources, workspaceMappings, signal, assertCurrentAuthority });
    return (await import("./project-conversation-collection.mjs")).readProjectConversationCollection({ ...created, expectedCollectionDigest: created.collectionDigest, signal, assertCurrentAuthority });
  }
  if (physicalSources !== undefined || !["prepare-workspaces","copy-workspaces"].includes(action)
    && [catalogFile, expectedCatalogDigest].some(value=>value!==undefined)) fail("CAPTURED_PROJECT_ARGUMENTS_ON_OTHER_ACTION");
  if (retainedDerivationSources !== undefined && !["publish-project","verify-project"].includes(action)) fail("COLLECTION_RETAINED_SOURCE_ARGUMENTS_ON_OTHER_ACTION");
  if (action === "capture-physical") {
    if (provider !== "codex" || !Array.isArray(threadIds) || threadIds.length !== 1
      || expectedBundleId !== null || sourceProjectId !== undefined || root !== undefined || nativeHome !== undefined || executable !== undefined
      || derivationId !== null || expectedDerivationDigest !== null || cutoffItemId !== null || companionPaths.length
      || [collectionRoot, collectionId, expectedCollectionDigest, workspaceMappings, workspaceTransfers, lodeBundles].some(value => value !== undefined))
      fail("PHYSICAL_SOURCE_CAPTURE_ARGUMENTS_INVALID");
    return (await import("./codex-captured-physical-source.mjs")).captureCodexPhysicalSourceFiles({ sourceRoot: physicalSourceRoot,
      directory: bundleRoot, threadId: threadIds[0], rolloutId: physicalRolloutId, files: physicalFiles,
      selectedStateEvidenceFile, expectedSelectedStateDigest, signal, assertCurrentAuthority });
  }
  if ([physicalSourceRoot, physicalRolloutId, physicalFiles, selectedStateEvidenceFile, expectedSelectedStateDigest].some(value => value !== undefined)) fail("PHYSICAL_SOURCE_ARGUMENTS_ON_OTHER_ACTION");
  if (["prepare-workspaces", "copy-workspaces", "attach-project-lode"].includes(action)) {
    if (provider !== undefined && provider !== "claude") fail("DERIVED_TARGET_PROVIDER_MUST_BE_CLAUDE");
    if (expectedBundleId !== null || sourceProjectId !== undefined || threadIds !== undefined || root !== undefined
      || derivationId !== null || expectedDerivationDigest !== null || cutoffItemId !== null || companionPaths.length
      || nativeHome !== undefined || executable !== undefined || collectionRoot !== undefined || workspaceMappings !== undefined)
      fail("COLLECTION_COMPANION_ARGUMENTS_INVALID");
    const companions = await import("./project-collection-companions.mjs");
    if (action === "attach-project-lode") {
      if (workspaceTransfers !== undefined) fail("COLLECTION_COMPANION_ARGUMENTS_INVALID");
      return companions.attachProjectCollectionLode({ collectionRoot: bundleRoot, collectionId, expectedCollectionDigest,
        lodeBundles, signal, assertCurrentAuthority });
    }
    if (collectionId !== undefined || expectedCollectionDigest !== undefined || lodeBundles !== undefined) fail("COLLECTION_COMPANION_ARGUMENTS_INVALID");
    return companions.transferProjectCollectionWorkspaces({ action, bundleRoot, workspaceTransfers, catalogFile, expectedCatalogDigest, signal, assertCurrentAuthority });
  }
  if (workspaceTransfers !== undefined || lodeBundles !== undefined) fail("COLLECTION_COMPANION_ARGUMENTS_ON_OTHER_ACTION");
  if (["derive-project", "read-project", "publish-project", "verify-project"].includes(action)) {
    if (provider !== undefined && provider !== "claude") fail("DERIVED_TARGET_PROVIDER_MUST_BE_CLAUDE");
    if (expectedBundleId !== null || sourceProjectId !== undefined || threadIds !== undefined || root !== undefined
      || derivationId !== null || expectedDerivationDigest !== null || cutoffItemId !== null || companionPaths.length)
      fail("COLLECTION_ARGUMENTS_INVALID");
    const core = await import("./project-conversation-collection.mjs");
    if (action === "derive-project") {
      if (nativeHome !== undefined || executable !== undefined || collectionId !== undefined || expectedCollectionDigest !== undefined)
        fail("COLLECTION_PREPARATION_HAS_EFFECT_ARGUMENTS");
      return core.deriveProjectConversationCollection({ bundleRoot, collectionRoot, workspaceMappings, signal, assertCurrentAuthority });
    }
    if (collectionRoot !== undefined) fail("COLLECTION_READ_USES_BUNDLE_ROOT");
    if (action === "read-project") {
      if (nativeHome !== undefined || executable !== undefined || workspaceMappings !== undefined) fail("COLLECTION_READ_HAS_EFFECT_ARGUMENTS");
      return core.readProjectConversationCollection({ collectionRoot: bundleRoot, collectionId, expectedCollectionDigest, signal, assertCurrentAuthority });
    }
    if (!nativeHistoryHost && (typeof executable !== "string" || !path.isAbsolute(executable))) fail("DERIVED_EXACT_TARGET_HOST_REQUIRED");
    const host = nativeHistoryHost ?? createProviderNativeHost({ provider: "claude", executable, pluginRoot, signal, onProcess });
    return core.operateProjectConversationCollection({ action, collectionRoot: bundleRoot, collectionId, expectedCollectionDigest,
      workspaceMappings, retainedDerivationSources, nativeHome, host, signal, assertCurrentAuthority });
  }
  if ([collectionRoot, collectionId, expectedCollectionDigest, workspaceMappings].some(value => value !== undefined)) fail("COLLECTION_ARGUMENTS_ON_OTHER_ACTION");
  if (sourceProjectId !== undefined && (!["capture", "capture-project"].includes(action) || provider !== "codex"))
    fail("PROJECT_NATIVE_PROJECT_SELECTION_IS_CODEX_CAPTURE_ONLY");
  if (sourceProjectId !== undefined && (typeof sourceProjectId !== "string" || !sourceProjectId.trim() || sourceProjectId.trim() !== sourceProjectId))
    fail("NATIVE_CODEX_PROJECT_ID_REQUIRED");
  // A Codex app Project is not a canonical Lode Project. Standalone capture
  // preserves native originals without initialization, fake Session IDs or a
  // common-bundle prerequisite. Workspace/file copying is a separate scope.
  if (action === "capture-project") {
    if (provider !== "codex" || sourceProjectId === undefined) fail("PROJECT_NATIVE_EXACT_CODEX_PROJECT_REQUIRED");
    if (expectedBundleId !== null || root !== undefined || derivationId !== null || expectedDerivationDigest !== null
      || cutoffItemId !== null || !Array.isArray(companionPaths) || companionPaths.length)
      fail("PROJECT_NATIVE_STANDALONE_CAPTURE_ARGUMENTS_INVALID");
    if (![nativeHome, executable, bundleRoot].every(value => typeof value === "string" && path.isAbsolute(value)))
      fail("PROJECT_NATIVE_HOST_REQUIRED");
    if (threadIds !== undefined && (!Array.isArray(threadIds) || !threadIds.length || new Set(threadIds).size !== threadIds.length
      || threadIds.some(id => typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))))
      fail("PROJECT_NATIVE_EXACT_SELECTION_REQUIRED");
    if (typeof assertCurrentAuthority !== "function") fail("NATIVE_HISTORY_AUTHORITY_CHECK_REQUIRED");
    const current = () => {
      if (signal?.aborted) fail("PROJECT_NATIVE_ACTION_CANCELLED");
      const value = assertCurrentAuthority();
      if (value && typeof value.then === "function") {
        Promise.resolve(value).catch(() => {}); fail("NATIVE_HISTORY_SYNCHRONOUS_AUTHORITY_REQUIRED");
      }
    };
    current();
    const offline = await prepareCodexNativeOffline({ home: nativeHome, executable, signal, onProcess });
    current();
    if (!offline.witness) return unavailable(offline);
    return captureCodexNativeHistory({ witness: offline.witness, sourceProjectId, threadIds,
      destination: bundleRoot, signal, onProcess, assertCurrentAuthority: current });
  }
  if (["derive", "publish-derived", "verify-derived", "open-derived"].includes(action)) {
    if (provider !== undefined && provider !== "claude") fail("DERIVED_TARGET_PROVIDER_MUST_BE_CLAUDE");
    if (!Array.isArray(companionPaths) || companionPaths.length) fail("DERIVED_COMPANIONS_NOT_READ_FROM_LIVE_PATHS");
    const derived = await import("./project-native-derivation.mjs");
    if (action === "derive") {
      if (nativeHome !== undefined || executable !== undefined || derivationId !== null || expectedDerivationDigest !== null)
        fail("DERIVED_CREATE_HAS_PROFILE_EFFECT_ARGUMENTS");
      return derived.deriveProjectNativeHistory({ bundleRoot, expectedBundleId, root, threadIds, cutoffItemId, signal, assertCurrentAuthority });
    }
    if (threadIds !== undefined || cutoffItemId !== null) fail("DERIVED_SELECTION_IS_IN_ARTIFACT");
    if (expectedDerivationDigest !== null && !/^[a-f0-9]{64}$/u.test(expectedDerivationDigest)) fail("DERIVED_EXPECTED_DIGEST_INVALID");
    const artifact = derived.inspectProjectNativeDerivation({ bundleRoot, expectedBundleId, derivationId, expectedDerivationDigest, signal, assertCurrentAuthority });
    if (action === "verify-derived" && nativeHome === undefined && executable === undefined && root === undefined)
      return derived.projectNativeDerivationSummary(artifact);
    if (expectedDerivationDigest === null) fail("DERIVED_EXPECTED_DIGEST_REQUIRED_FOR_NATIVE_EFFECT");
    if (typeof nativeHome !== "string" || !path.isAbsolute(nativeHome) || typeof root !== "string" || !path.isAbsolute(root)
      || !nativeHistoryHost && (typeof executable !== "string" || !path.isAbsolute(executable))) fail("DERIVED_EXACT_TARGET_HOST_REQUIRED");
    const host = nativeHistoryHost ?? createProviderNativeHost({ provider: "claude", executable, pluginRoot, signal, onProcess });
    if (host.provider !== "claude" || !["synthetic-test", "external-client-command-unqualified", "host-metadata-capability"].includes(host.evidenceKind))
      fail("NATIVE_HISTORY_PROVIDER_HOST_INVALID");
    const publication = await import("./claude-derived-publication.mjs");
    const method = action === "publish-derived" ? publication.publishClaudeDerived : action === "open-derived" ? publication.openClaudeDerived : publication.verifyClaudeDerived;
    return method({ artifact, nativeHome, root, host, signal, assertCurrentAuthority });
  }
  if (derivationId !== null || expectedDerivationDigest !== null || cutoffItemId !== null) fail("PROJECT_NATIVE_DERIVATION_ARGUMENTS_ON_SAME_PLATFORM_ACTION");
  if (!["capture", "read", "restore", "register"].includes(action))
    fail("PROJECT_NATIVE_ACTION_INVALID");
  if (!Array.isArray(companionPaths)) fail("NATIVE_CLAUDE_COMPANION_SCOPE_UNSUPPORTED");
  if (provider !== undefined && !["codex", "claude", "opencode"].includes(provider)) fail("NATIVE_HISTORY_PROVIDER_UNSUPPORTED");
  if (action === "read") {
    if ([nativeHome, executable, threadIds, root].some((value) => value !== undefined) || companionPaths.length)
      fail("PROJECT_NATIVE_READ_HAS_EFFECT_ARGUMENTS");
    const selected = readProjectNativeTransfer({ bundleRoot, expectedBundleId, signal });
    if (provider !== undefined && selected.native && provider !== selected.sourceProvider) fail("NATIVE_HISTORY_SAME_PLATFORM_REQUIRED");
    return projectNativeTransferSummary(selected);
  }
  // Link identity is data, not a guess from UUID shape or an arbitrary executable.
  // Dispatch before any native-home lookup, OS observation, control file or SDK.
  if (signal?.aborted) fail("PROJECT_NATIVE_ACTION_CANCELLED");
  if (typeof assertCurrentAuthority !== "function") fail("NATIVE_HISTORY_AUTHORITY_CHECK_REQUIRED");
  const currentAuthority = assertCurrentAuthority();
  if (currentAuthority && typeof currentAuthority.then === "function") {
    Promise.resolve(currentAuthority).catch(() => {}); fail("NATIVE_HISTORY_SYNCHRONOUS_AUTHORITY_REQUIRED");
  }
  const selected = action === "capture" ? inspectProjectBundle({ bundleRoot, expectedBundleId, signal })
    : readProjectNativeTransfer({ bundleRoot, expectedBundleId, signal });
  const sourceProvider = action === "capture" ? provider : selected.sourceProvider;
  if (action === "capture" && !sourceProvider) fail("NATIVE_HISTORY_PROVIDER_REQUIRED");
  if (action !== "capture" && !selected.native) return projectNativeTransferSummary(selected);
  if (provider !== undefined && provider !== sourceProvider) fail("NATIVE_HISTORY_SAME_PLATFORM_REQUIRED");
  const providerUnavailable = () => ({
    status: "native-provider-operation-unavailable", reasonCode: "NATIVE_HISTORY_PROVIDER_CAPABILITY_UNAVAILABLE",
    provider: sourceProvider, action, nativeHomeInspected: false, processObservationRequested: false,
    sdkLifecycleRequestedThisCall: false, targetProviderVerification: "not-performed", ordinaryCoreBlocked: false,
    rawHistoryReadable: action !== "capture", commonBundleReadable: true, handoffIndependent: true, continuationReady: false, targetExecutionSettingsVerified: false,
    persisted: false, grantsRecoveryAuthority: false, restoresExecutionPermission: false
  });
  if (sourceProvider !== "codex") {
    // Host callbacks are executable capabilities supplied only by the current
    // trusted Host, never by bundle JSON or tool arguments.
    if (sourceProvider === "opencode" && !nativeHistoryHost) {
      if (action === "capture" || ![executable, nativeHome, root].every(value => typeof value === "string" && path.isAbsolute(value))
        || !fs.existsSync(executable)) return { ...providerUnavailable(), reasonCode: "NATIVE_OPENCODE_BOOTSTRAP_UNQUALIFIED",
        missingCapability: action === "capture" ? "current-host-exact-id-export" : "qualified-fixed-version-atomic-db-profile" };
      const { createOpenCodeAtomicHistoryHost } = await import("./opencode-atomic-history-host.mjs");
      try { nativeHistoryHost = createOpenCodeAtomicHistoryHost({ executable, nativeHome, root, signal, assertCurrentAuthority }); }
      catch (error) {
        if (error.code === "NATIVE_OPENCODE_VERSION_UNQUALIFIED") return { ...providerUnavailable(),
          reasonCode: "NATIVE_OPENCODE_BOOTSTRAP_UNQUALIFIED", missingCapability: "qualified-fixed-version-atomic-db-profile" };
        if (["NATIVE_OPENCODE_QUALIFIED_PROFILE_REQUIRED", "NATIVE_OPENCODE_QUALIFIED_DATABASE_REQUIRED"].includes(error.code))
          return { ...providerUnavailable(), reasonCode: error.code, nativeHomeInspected: true, missingCapability: "existing-qualified-isolated-db-and-current-project" };
        throw error;
      }
    }
    if (!nativeHistoryHost && (typeof executable !== "string" || !path.isAbsolute(executable) || !fs.existsSync(executable)))
      return providerUnavailable();
    const hostRoutedCapture = sourceProvider === "opencode" && action === "capture";
    if ((!hostRoutedCapture && (typeof nativeHome !== "string" || !path.isAbsolute(nativeHome))) || typeof root !== "string" || !path.isAbsolute(root))
      fail("PROJECT_NATIVE_HOST_REQUIRED");
    if (!Array.isArray(companionPaths)) fail("NATIVE_CLAUDE_COMPANION_SCOPE_UNSUPPORTED");
    const host = nativeHistoryHost ?? createProviderNativeHost({ provider: sourceProvider, executable, pluginRoot, signal, onProcess });
    if (host.provider !== sourceProvider
      || (!hostRoutedCapture && typeof host.version !== "function")
      || !["synthetic-test", "external-client-command-unqualified", "host-metadata-capability", "qualified-opencode-sqlite-adapter"].includes(host.evidenceKind))
      fail("NATIVE_HISTORY_PROVIDER_HOST_INVALID");
    if (sourceProvider === "opencode" && (hostRoutedCapture ? typeof host.exportSelected !== "function" : typeof host.run !== "function"))
      return { ...providerUnavailable(), reasonCode: "NATIVE_OPENCODE_HOST_CAPABILITY_UNAVAILABLE" };
    if (hostRoutedCapture && (nativeHome !== undefined || executable !== undefined)) fail("NATIVE_OPENCODE_SOURCE_IS_HOST_ROUTED");
    const current = () => {
      if (signal?.aborted) fail("PROJECT_NATIVE_ACTION_CANCELLED");
      const result = assertCurrentAuthority();
      if (result && typeof result.then === "function") { Promise.resolve(result).catch(() => {}); fail("NATIVE_HISTORY_SYNCHRONOUS_AUTHORITY_REQUIRED"); }
      if (action === "capture") {
        if (inspectCopiedProjectFile(selected.bundleRoot, "manifest.json").sha256 !== selected.manifestSha256) fail("PROJECT_NATIVE_TRANSFER_IDENTITY_CHANGED");
      } else {
        assertProjectNativeTransferCurrent({ bundleRoot, commonManifestDigest: selected.commonManifestDigest, linkDigest: selected.linkDigest, signal });
        if (inspectCopiedProjectFile(selected.native.directory, "manifest.json").sha256 !== selected.native.payloadDigest) fail("NATIVE_HISTORY_PAYLOAD_IDENTITY_MISMATCH");
      }
    };
    const adapter = sourceProvider === "claude" ? await import("./claude-native-history.mjs") : await import("./opencode-native-history.mjs");
    return await (sourceProvider === "claude" ? adapter.operateClaudeNativeHistory : adapter.operateOpenCodeNativeHistory)({
      action, selected: { ...selected, bundleRoot: path.resolve(bundleRoot) }, nativeHome, root, threadIds, companionPaths,
      host, signal, assertCurrentAuthority: current,
      captureDirectory: () => projectNativeCaptureDirectory({ provider: sourceProvider, bundleRoot, expectedBundleId: selected.bundleId, assertCurrentAuthority: current }),
      attach: directory => attachProjectNativeTransfer({ provider: sourceProvider, bundleRoot, directory, expectedBundleId: selected.bundleId, signal, assertCurrentAuthority: current }),
    });
  }
  // A server may carry another provider's optional capability. It is not an
  // argument to the independently selected Codex adapter and is never called.
  if (companionPaths.length) fail("PROJECT_NATIVE_CODEX_HAS_OTHER_PROVIDER_ARGUMENTS");
  if (
    typeof nativeHome !== "string" ||
    !nativeHome.trim() ||
    typeof executable !== "string" ||
    !executable.trim()
  )
    fail("PROJECT_NATIVE_HOST_REQUIRED");
  if (
    action === "capture" &&
    !(threadIds === undefined && sourceProjectId !== undefined) && (!Array.isArray(threadIds) ||
      !threadIds.length ||
      new Set(threadIds).size !== threadIds.length ||
      threadIds.some(
        (id) =>
          typeof id !== "string" ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id),
      ))
  )
    fail("PROJECT_NATIVE_EXACT_SELECTION_REQUIRED");
  if (action !== "capture" && threadIds !== undefined)
    fail("PROJECT_NATIVE_SELECTION_IS_IN_PAYLOAD");
  if (action !== "register" && root !== undefined) fail("PROJECT_NATIVE_RUNTIME_ROOT_NOT_USED");
  if (action === "register" && (typeof root !== "string" || !root.trim()))
    fail("PROJECT_NATIVE_RUNTIME_ROOT_REQUIRED");
  const authority = () => {
    if (signal?.aborted) fail("PROJECT_NATIVE_ACTION_CANCELLED");
    if (typeof assertCurrentAuthority !== "function") fail("NATIVE_CODEX_AUTHORITY_CHECK_REQUIRED");
    const result = assertCurrentAuthority();
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch(() => {});
      fail("NATIVE_CODEX_SYNCHRONOUS_AUTHORITY_REQUIRED");
    }
  };
  authority();
  // Validate data/selection before process observation or destination creation.

  if (action !== "capture" && !selected.native) return projectNativeTransferSummary(selected);
  const transferRoot = fs.realpathSync(path.resolve(bundleRoot)),
    hostHome = fs.realpathSync(path.resolve(nativeHome));
  const inside = (base, file) => {
    const relative = path.relative(base, file);
    return (
      !relative ||
      (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
    );
  };
  if (inside(transferRoot, hostHome) || inside(hostHome, transferRoot))
    fail("PROJECT_NATIVE_SOURCE_TARGET_OVERLAP");
  const selectedTransferCurrent = () => {
    authority();
    if (action !== "capture")
      assertProjectNativeTransferCurrent({
        bundleRoot,
        commonManifestDigest: selected.commonManifestDigest,
        linkDigest: selected.linkDigest,
        signal,
      });
  };
  selectedTransferCurrent();
  const offline = await prepareCodexNativeOffline({
    home: nativeHome,
    executable,
    signal,
    onProcess,
  });
  selectedTransferCurrent();
  if (!offline.witness) return unavailable(offline);
  if (action === "capture") {
    const destination = projectNativeCaptureDirectory({
      bundleRoot: selected.bundleRoot,
      expectedBundleId: selected.bundleId,
      assertCurrentAuthority: authority,
    });
    const captured = await captureCodexNativeHistory({
      witness: offline.witness,
      threadIds,
      sourceProjectId,
      destination,
      signal,
      onProcess,
      assertCurrentAuthority: authority,
    });
    return attachProjectNativeTransfer({
      bundleRoot: selected.bundleRoot,
      expectedBundleId: selected.bundleId,
      directory: captured.directory,
      signal,
      assertCurrentAuthority: authority,
    });
  }
  if (action === "restore")
    return publishCodexNativeHistory({
      witness: offline.witness,
      directory: selected.native.directory,
      expectedPayloadId: selected.native.payloadId,
      signal,
      onProcess,
      assertCurrentAuthority: selectedTransferCurrent,
    });
  const home = fs.realpathSync(path.resolve(nativeHome)),
    controlDirectory = copiedProjectFile(home, ".lode-native-portability/registration-control");
  authority();
  fs.mkdirSync(controlDirectory, { recursive: true });
  copiedProjectFile(home, ".lode-native-portability/registration-control");
  return registerCodexNativeHistory({
    witness: offline.witness,
    directory: selected.native.directory,
    expectedPayloadId: selected.native.payloadId,
    cwd: root,
    environment: registrationEnvironment(home),
    supervisorSelection: resolveVerifiedProcessSupervisor({ pluginRoot }),
    controlFile: path.join(controlDirectory, selected.native.payloadId + ".jsonl"),
    signal,
    onProcess,
    assertCurrentAuthority: selectedTransferCurrent,
  });
}
