import fs from "node:fs";
import path from "node:path";
import { inspectProjectBundle } from "../storage/project-portability.mjs";
import { prepareCodexNativeOffline } from "../distribution/codex-native-offline.mjs";
import { captureCodexNativeHistory } from "../distribution/codex-native-capture.mjs";
import { publishCodexNativeHistory } from "../distribution/codex-native-publication.mjs";
import { registerCodexNativeHistory } from "../distribution/codex-native-registration.mjs";
import { resolveVerifiedProcessSupervisor } from "../runtime/runtime-process-supervisor.mjs";
import { copiedProjectFile, inspectCopiedProjectFile } from "../storage/project-copy-evidence.mjs";
import { createProviderNativeHost } from "./provider-native-history-host.mjs";
import {
  projectNativeCaptureDirectory,
  attachProjectNativeTransfer,
  readProjectNativeTransfer,
  projectNativeTransferSummary,
  assertProjectNativeTransferCurrent,
} from "./project-native-transfer.mjs";
import { failCode as fail } from "../core/errors.mjs";

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
    ...Object.fromEntries(keys.filter((key) => typeof process.env[key] === "string").map((key) => [key, process.env[key]])),
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
  companionPaths = [],
  nativeHistoryHost = null,
  root,
  pluginRoot,
  signal,
  onProcess,
  assertCurrentAuthority = () => {},
} = {}) {
  if (!["capture", "read", "restore", "register"].includes(action)) fail("PROJECT_NATIVE_ACTION_INVALID");
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
    Promise.resolve(currentAuthority).catch(() => {});
    fail("NATIVE_HISTORY_SYNCHRONOUS_AUTHORITY_REQUIRED");
  }
  const selected =
    action === "capture" ? inspectProjectBundle({ bundleRoot, expectedBundleId, signal }) : readProjectNativeTransfer({ bundleRoot, expectedBundleId, signal });
  const sourceProvider = action === "capture" ? provider : selected.sourceProvider;
  if (action === "capture" && !sourceProvider) fail("NATIVE_HISTORY_PROVIDER_REQUIRED");
  if (action !== "capture" && !selected.native) return projectNativeTransferSummary(selected);
  if (provider !== undefined && provider !== sourceProvider) fail("NATIVE_HISTORY_SAME_PLATFORM_REQUIRED");
  const providerUnavailable = () => ({
    status: "native-provider-operation-unavailable",
    reasonCode: "NATIVE_HISTORY_PROVIDER_CAPABILITY_UNAVAILABLE",
    provider: sourceProvider,
    action,
    nativeHomeInspected: false,
    processObservationRequested: false,
    sdkLifecycleRequestedThisCall: false,
    targetProviderVerification: "not-performed",
    ordinaryCoreBlocked: false,
    rawHistoryReadable: action !== "capture",
    commonBundleReadable: true,
    handoffIndependent: true,
    continuationReady: false,
    targetExecutionSettingsVerified: false,
    persisted: false,
    grantsRecoveryAuthority: false,
    restoresExecutionPermission: false,
  });
  if (sourceProvider !== "codex") {
    // Host callbacks are executable capabilities supplied only by the current
    // trusted Host, never by bundle JSON or tool arguments.
    if (sourceProvider === "opencode" && !nativeHistoryHost) {
      if (
        action === "capture" ||
        ![executable, nativeHome, root].every((value) => typeof value === "string" && path.isAbsolute(value)) ||
        !fs.existsSync(executable)
      )
        return {
          ...providerUnavailable(),
          reasonCode: "NATIVE_OPENCODE_BOOTSTRAP_UNQUALIFIED",
          missingCapability: action === "capture" ? "current-host-exact-id-export" : "qualified-fixed-version-atomic-db-profile",
        };
      const { createOpenCodeAtomicHistoryHost } = await import("./opencode-atomic-history-host.mjs");
      try {
        nativeHistoryHost = createOpenCodeAtomicHistoryHost({ executable, nativeHome, root, signal, assertCurrentAuthority });
      } catch (error) {
        if (error.code === "NATIVE_OPENCODE_VERSION_UNQUALIFIED")
          return {
            ...providerUnavailable(),
            reasonCode: "NATIVE_OPENCODE_BOOTSTRAP_UNQUALIFIED",
            missingCapability: "qualified-fixed-version-atomic-db-profile",
          };
        if (["NATIVE_OPENCODE_QUALIFIED_PROFILE_REQUIRED", "NATIVE_OPENCODE_QUALIFIED_DATABASE_REQUIRED"].includes(error.code))
          return {
            ...providerUnavailable(),
            reasonCode: error.code,
            nativeHomeInspected: true,
            missingCapability: "existing-qualified-isolated-db-and-current-project",
          };
        throw error;
      }
    }
    if (!nativeHistoryHost && (typeof executable !== "string" || !path.isAbsolute(executable) || !fs.existsSync(executable))) return providerUnavailable();
    const hostRoutedCapture = sourceProvider === "opencode" && action === "capture";
    if ((!hostRoutedCapture && (typeof nativeHome !== "string" || !path.isAbsolute(nativeHome))) || typeof root !== "string" || !path.isAbsolute(root))
      fail("PROJECT_NATIVE_HOST_REQUIRED");
    if (!Array.isArray(companionPaths)) fail("NATIVE_CLAUDE_COMPANION_SCOPE_UNSUPPORTED");
    const host = nativeHistoryHost ?? createProviderNativeHost({ provider: sourceProvider, executable, pluginRoot, signal, onProcess });
    if (
      host.provider !== sourceProvider ||
      (!hostRoutedCapture && typeof host.version !== "function") ||
      !["synthetic-test", "external-client-command-unqualified", "host-metadata-capability", "qualified-opencode-sqlite-adapter"].includes(host.evidenceKind)
    )
      fail("NATIVE_HISTORY_PROVIDER_HOST_INVALID");
    if (sourceProvider === "opencode" && (hostRoutedCapture ? typeof host.exportSelected !== "function" : typeof host.run !== "function"))
      return { ...providerUnavailable(), reasonCode: "NATIVE_OPENCODE_HOST_CAPABILITY_UNAVAILABLE" };
    if (hostRoutedCapture && (nativeHome !== undefined || executable !== undefined)) fail("NATIVE_OPENCODE_SOURCE_IS_HOST_ROUTED");
    const current = () => {
      if (signal?.aborted) fail("PROJECT_NATIVE_ACTION_CANCELLED");
      const result = assertCurrentAuthority();
      if (result && typeof result.then === "function") {
        Promise.resolve(result).catch(() => {});
        fail("NATIVE_HISTORY_SYNCHRONOUS_AUTHORITY_REQUIRED");
      }
      if (action === "capture") {
        if (inspectCopiedProjectFile(selected.bundleRoot, "manifest.json").sha256 !== selected.manifestSha256) fail("PROJECT_NATIVE_TRANSFER_IDENTITY_CHANGED");
      } else {
        assertProjectNativeTransferCurrent({ bundleRoot, commonManifestDigest: selected.commonManifestDigest, linkDigest: selected.linkDigest, signal });
        if (inspectCopiedProjectFile(selected.native.directory, "manifest.json").sha256 !== selected.native.payloadDigest)
          fail("NATIVE_HISTORY_PAYLOAD_IDENTITY_MISMATCH");
      }
    };
    const adapter = sourceProvider === "claude" ? await import("./claude-native-history.mjs") : await import("./opencode-native-history.mjs");
    return await (sourceProvider === "claude" ? adapter.operateClaudeNativeHistory : adapter.operateOpenCodeNativeHistory)({
      action,
      selected: { ...selected, bundleRoot: path.resolve(bundleRoot) },
      nativeHome,
      root,
      threadIds,
      companionPaths,
      host,
      signal,
      assertCurrentAuthority: current,
      captureDirectory: () =>
        projectNativeCaptureDirectory({ provider: sourceProvider, bundleRoot, expectedBundleId: selected.bundleId, assertCurrentAuthority: current }),
      attach: (directory) =>
        attachProjectNativeTransfer({
          provider: sourceProvider,
          bundleRoot,
          directory,
          expectedBundleId: selected.bundleId,
          signal,
          assertCurrentAuthority: current,
        }),
    });
  }
  // A server may carry another provider's optional capability. It is not an
  // argument to the independently selected Codex adapter and is never called.
  if (companionPaths.length) fail("PROJECT_NATIVE_CODEX_HAS_OTHER_PROVIDER_ARGUMENTS");
  if (typeof nativeHome !== "string" || !nativeHome.trim() || typeof executable !== "string" || !executable.trim()) fail("PROJECT_NATIVE_HOST_REQUIRED");
  if (
    action === "capture" &&
    (!Array.isArray(threadIds) ||
      !threadIds.length ||
      new Set(threadIds).size !== threadIds.length ||
      threadIds.some((id) => typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)))
  )
    fail("PROJECT_NATIVE_EXACT_SELECTION_REQUIRED");
  if (action !== "capture" && threadIds !== undefined) fail("PROJECT_NATIVE_SELECTION_IS_IN_PAYLOAD");
  if (action !== "register" && root !== undefined) fail("PROJECT_NATIVE_RUNTIME_ROOT_NOT_USED");
  if (action === "register" && (typeof root !== "string" || !root.trim())) fail("PROJECT_NATIVE_RUNTIME_ROOT_REQUIRED");
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
    return !relative || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
  };
  if (inside(transferRoot, hostHome) || inside(hostHome, transferRoot)) fail("PROJECT_NATIVE_SOURCE_TARGET_OVERLAP");
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
