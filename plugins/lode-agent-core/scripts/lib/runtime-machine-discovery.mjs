import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  RUNTIME_ADAPTER_PLATFORMS,
  RUNTIME_ADAPTER_RUNTIMES,
} from "./runtime-adapter.mjs";

export const RUNTIME_MACHINE_DISCOVERY_VERSION = "0.1.0";

const AGENT_CONTROL_METHODS = ["start", "resume", "stream", "interrupt", "close"];
const PLATFORM_CONTROL_METHODS = ["spawnOwned", "inspectOwned", "terminateOwned"];
const HOST_CONTROL_METHODS = ["attach", "send", "receive", "detach"];

const fail = (message, code = "RUNTIME_MACHINE_DISCOVERY_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

const canonicalJson = (value) => JSON.stringify(canonicalValue(value));
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function identify(payload, prefix, idKey, hashKey) {
  const hash = digest(canonicalJson(payload));
  return { ...payload, [idKey]: `${prefix}-${hash.slice(0, 24)}`, [hashKey]: hash };
}

function verifyIdentity(document, { prefix, idKey, hashKey, code }) {
  const payload = { ...document };
  delete payload[idKey];
  delete payload[hashKey];
  const hash = digest(canonicalJson(payload));
  if (document[hashKey] !== hash || document[idKey] !== `${prefix}-${hash.slice(0, 24)}`) {
    fail("Runtime machine discovery artifact digest verification failed.", code);
  }
}

function assertFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} is invalid.`, "INVALID_RUNTIME_MACHINE_DISCOVERY");
  }
  const expected = new Set(fields);
  if (Object.keys(value).some((field) => !expected.has(field)) || fields.some((field) => !(field in value))) {
    fail(`${label} fields are invalid.`, "INVALID_RUNTIME_MACHINE_DISCOVERY");
  }
}

function normalizeRuntime(value) {
  const runtime = String(value || "").trim().toLowerCase();
  if (!RUNTIME_ADAPTER_RUNTIMES.includes(runtime)) {
    fail(`Unsupported runtime machine interface: ${runtime || "(empty)"}.`, "UNSUPPORTED_RUNTIME_MACHINE_INTERFACE");
  }
  return runtime;
}

function normalizePlatform(value) {
  const platform = String(value || "").trim().toLowerCase();
  if (!RUNTIME_ADAPTER_PLATFORMS.includes(platform)) {
    fail(`Unsupported runtime machine platform: ${platform || "(empty)"}.`, "UNSUPPORTED_RUNTIME_MACHINE_PLATFORM");
  }
  return platform;
}

function normalizedRuntimes(values) {
  const input = values === undefined || values === null ? RUNTIME_ADAPTER_RUNTIMES : values;
  if (!Array.isArray(input) || !input.length) {
    fail("Runtime machine discovery requires at least one runtime.", "RUNTIME_MACHINE_RUNTIME_REQUIRED");
  }
  return [...new Set(input.map(normalizeRuntime))].sort(compareText);
}

function disabledOperation(kind, operation) {
  fail(
    `${kind} operation ${operation} is disabled during read-only machine discovery.`,
    "RUNTIME_ADAPTER_CONTROL_NOT_ENABLED",
  );
}

function pathValue(environment) {
  return environment?.PATH ?? environment?.Path ?? environment?.path ?? "";
}

function pathEntries(environment, platform) {
  const delimiter = platform === "win32" ? ";" : ":";
  return String(pathValue(environment)).split(delimiter).map((entry) => {
    const trimmed = entry.trim();
    return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  }).filter((entry) => entry && path.isAbsolute(entry));
}

function executableNames(runtime, platform) {
  if (platform !== "win32") return [runtime];
  return [`${runtime}.exe`, `${runtime}.cmd`, `${runtime}.bat`, runtime];
}

function pathIdentity(value, platform) {
  const resolved = path.resolve(value).replaceAll("\\", "/");
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function launcherKind(file, platform) {
  if (platform !== "win32") return "native-executable";
  const extension = path.extname(file).toLowerCase();
  if (extension === ".exe") return "native-executable";
  if (extension === ".cmd" || extension === ".bat") return "command-shim";
  return "extensionless-candidate";
}

function unavailableCandidate(runtime) {
  return {
    runtime,
    availability: "not-found",
    launcherKind: "none",
    directSpawnSafe: false,
    pathDigest: "",
    canonicalPathDigest: "",
    byteLength: 0,
    symbolicLink: false,
  };
}

function resolveExecutableCandidate({ runtime, platform, environment, fileSystem }) {
  runtime = normalizeRuntime(runtime);
  platform = normalizePlatform(platform);
  for (const directory of pathEntries(environment, platform)) {
    for (const name of executableNames(runtime, platform)) {
      const candidate = path.join(directory, name);
      try {
        const linkStat = fileSystem.lstatSync(candidate);
        const symbolicLink = linkStat.isSymbolicLink();
        const canonical = fileSystem.realpathSync(candidate);
        const stat = fileSystem.statSync(canonical);
        if (!stat.isFile()) continue;
        if (platform !== "win32" && (stat.mode & 0o111) === 0) continue;
        const kind = launcherKind(candidate, platform);
        return {
          executablePath: canonical,
          observation: {
            runtime,
            availability: "candidate-found",
            launcherKind: kind,
            directSpawnSafe: kind === "native-executable" && !symbolicLink,
            pathDigest: digest(pathIdentity(candidate, platform)),
            canonicalPathDigest: digest(pathIdentity(canonical, platform)),
            byteLength: stat.size,
            symbolicLink,
          },
        };
      } catch {}
    }
  }
  return { executablePath: null, observation: unavailableCandidate(runtime) };
}

function resolveExecutableObservation(options) {
  return resolveExecutableCandidate(options).observation;
}

export function resolveReadOnlyRuntimeExecutableTarget({
  runtime,
  platform = process.platform,
  environment = process.env,
  fileSystem = fs,
} = {}) {
  return resolveExecutableCandidate({ runtime, platform, environment, fileSystem });
}

function platformDescriptor(platform) {
  return {
    contractVersion: RUNTIME_MACHINE_DISCOVERY_VERSION,
    adapterKind: `${platform}-read-only-machine-discovery`,
    platform,
    machineInterface: "path-executable-inspection",
    supportedOperations: ["probe", "resolve-executable"],
    disabledOperations: ["spawn-owned", "inspect-owned", "terminate-owned"],
    rawPathsExposed: false,
    actualPlatformExecutionValidated: false,
    controlOperationsEnabled: false,
    instructionAuthority: false,
    promotionAuthority: false,
    controlAuthority: false,
    mutatesCanon: false,
  };
}

function agentDescriptor(runtime, storage) {
  return {
    contractVersion: RUNTIME_MACHINE_DISCOVERY_VERSION,
    adapterKind: `${runtime}-read-only-machine-discovery`,
    runtime,
    machineInterface: "cli-path-inspection",
    supportedOperations: ["probe"],
    disabledOperations: ["start", "resume", "stream", "interrupt", "close"],
    tuiScraping: false,
    providerSessionIdentity: "external-reference-only",
    [formatForVerifiedOwner(storage).value("headSessionIdentity")]: "canonical-project-session",
    executionContractRequiredForControl: true,
    controlOperationsEnabled: false,
    instructionAuthority: false,
    promotionAuthority: false,
    controlAuthority: false,
    mutatesCanon: false,
  };
}

function hostDescriptor() {
  return {
    contractVersion: RUNTIME_MACHINE_DISCOVERY_VERSION,
    adapterKind: "native-process-read-only-machine-discovery",
    workspaceHost: "native-process",
    machineInterface: "node-process-api",
    supportedOperations: ["probe"],
    disabledOperations: ["attach", "send", "receive", "detach"],
    processOwnershipValidated: false,
    callerFencingValidated: false,
    controlOperationsEnabled: false,
    instructionAuthority: false,
    promotionAuthority: false,
    controlAuthority: false,
    mutatesCanon: false,
  };
}

export class ReadOnlyPlatformAdapter {
  constructor({ platform = process.platform, environment = process.env, fileSystem = fs } = {}) {
    this.platform = normalizePlatform(platform);
    this.environment = environment;
    this.fileSystem = fileSystem;
  }
  describe() { return platformDescriptor(this.platform); }
  probe() {
    const payload = {
      schemaVersion: 1,
      kind: "PlatformMachineProbe",
      protocolVersion: RUNTIME_MACHINE_DISCOVERY_VERSION,
      descriptor: this.describe(),
      pathEntryCount: pathEntries(this.environment, this.platform).length,
      status: "read-only-machine-discovery",
      authorityEffect: "none",
    };
    return verifyPlatformMachineProbe(identify(payload, "platform-machine-probe", "probeId", "probeHash"));
  }
  resolveExecutable(runtime) {
    return resolveExecutableObservation({
      runtime,
      platform: this.platform,
      environment: this.environment,
      fileSystem: this.fileSystem,
    });
  }
  spawnOwned() { return disabledOperation("PlatformAdapter", "spawn-owned"); }
  inspectOwned() { return disabledOperation("PlatformAdapter", "inspect-owned"); }
  terminateOwned() { return disabledOperation("PlatformAdapter", "terminate-owned"); }
}

export class ReadOnlyAgentRuntimeAdapter {
  constructor({ runtime, platformAdapter, storage } = {}) {
    this.storage = storage;
    this.runtime = normalizeRuntime(runtime);
    if (!(platformAdapter instanceof ReadOnlyPlatformAdapter)) {
      fail("ReadOnlyAgentRuntimeAdapter requires a ReadOnlyPlatformAdapter.", "INVALID_RUNTIME_MACHINE_ADAPTER");
    }
    this.platformAdapter = platformAdapter;
  }
  describe() { return agentDescriptor(this.runtime, this.storage); }
  probe() {
    const executable = this.platformAdapter.resolveExecutable(this.runtime);
    const payload = {
      schemaVersion: 1,
      kind: "AgentRuntimeMachineProbe",
      protocolVersion: RUNTIME_MACHINE_DISCOVERY_VERSION,
      descriptor: this.describe(),
      platform: this.platformAdapter.platform,
      executable,
      status: executable.availability === "candidate-found" ? "candidate-found" : "not-found",
      runtimeControlEnabled: false,
      authorityEffect: "none",
    };
    return verifyAgentRuntimeMachineProbe(identify(payload, "agent-runtime-machine-probe", "probeId", "probeHash"));
  }
  start() { return disabledOperation("AgentRuntimeAdapter", "start"); }
  resume() { return disabledOperation("AgentRuntimeAdapter", "resume"); }
  stream() { return disabledOperation("AgentRuntimeAdapter", "stream"); }
  interrupt() { return disabledOperation("AgentRuntimeAdapter", "interrupt"); }
  close() { return disabledOperation("AgentRuntimeAdapter", "close"); }
}

export class ReadOnlyWorkspaceHostAdapter {
  describe() { return hostDescriptor(); }
  probe() {
    const payload = {
      schemaVersion: 1,
      kind: "WorkspaceHostMachineProbe",
      protocolVersion: RUNTIME_MACHINE_DISCOVERY_VERSION,
      descriptor: this.describe(),
      status: "read-only-machine-discovery",
      authorityEffect: "none",
    };
    return verifyWorkspaceHostMachineProbe(identify(payload, "workspace-host-machine-probe", "probeId", "probeHash"));
  }
  attach() { return disabledOperation("WorkspaceHostAdapter", "attach"); }
  send() { return disabledOperation("WorkspaceHostAdapter", "send"); }
  receive() { return disabledOperation("WorkspaceHostAdapter", "receive"); }
  detach() { return disabledOperation("WorkspaceHostAdapter", "detach"); }
}

function validateExecutableObservation(document) {
  assertFields(document, [
    "runtime", "availability", "launcherKind", "directSpawnSafe", "pathDigest", "canonicalPathDigest",
    "byteLength", "symbolicLink",
  ], "Runtime executable observation");
  normalizeRuntime(document.runtime);
  const available = document.availability === "candidate-found";
  if ((!available && document.availability !== "not-found")
    || !["native-executable", "command-shim", "extensionless-candidate", "none"].includes(document.launcherKind)
    || typeof document.directSpawnSafe !== "boolean" || typeof document.symbolicLink !== "boolean"
    || !Number.isSafeInteger(document.byteLength) || document.byteLength < 0
    || (available && (!/^[a-f0-9]{64}$/.test(document.pathDigest) || !/^[a-f0-9]{64}$/.test(document.canonicalPathDigest)
      || document.byteLength < 1 || document.launcherKind === "none"))
    || (!available && (document.pathDigest !== "" || document.canonicalPathDigest !== "" || document.byteLength !== 0
      || document.launcherKind !== "none" || document.directSpawnSafe || document.symbolicLink))) {
    fail("Runtime executable observation is invalid.", "INVALID_RUNTIME_EXECUTABLE_OBSERVATION");
  }
  return document;
}

export function verifyPlatformMachineProbe(document) {
  assertFields(document, ["schemaVersion", "kind", "protocolVersion", "descriptor", "pathEntryCount", "status", "authorityEffect", "probeId", "probeHash"], "Platform machine probe");
  if (canonicalJson(document.descriptor) !== canonicalJson(platformDescriptor(normalizePlatform(document.descriptor?.platform)))
    || document.schemaVersion !== 1 || document.kind !== "PlatformMachineProbe"
    || document.protocolVersion !== RUNTIME_MACHINE_DISCOVERY_VERSION
    || !Number.isSafeInteger(document.pathEntryCount) || document.pathEntryCount < 0
    || document.status !== "read-only-machine-discovery" || document.authorityEffect !== "none") {
    fail("Platform machine probe is invalid.", "INVALID_PLATFORM_MACHINE_PROBE");
  }
  verifyIdentity(document, { prefix: "platform-machine-probe", idKey: "probeId", hashKey: "probeHash", code: "PLATFORM_MACHINE_PROBE_DIGEST_MISMATCH" });
  return document;
}

export function verifyAgentRuntimeMachineProbe(document) {
  assertFields(document, ["schemaVersion", "kind", "protocolVersion", "descriptor", "platform", "executable", "status", "runtimeControlEnabled", "authorityEffect", "probeId", "probeHash"], "Agent runtime machine probe");
  const runtime = normalizeRuntime(document.descriptor?.runtime);
  const format = Object.hasOwn(document.descriptor || {}, "lodeSessionIdentity")
    ? formatForVerifiedOwner({ dialect: "lode", directory: ".lode" }) : formatForVerifiedOwner();
  validateExecutableObservation(document.executable);
  if (canonicalJson(document.descriptor) !== canonicalJson(agentDescriptor(runtime, format))
    || document.executable.runtime !== runtime || !RUNTIME_ADAPTER_PLATFORMS.includes(document.platform)
    || document.schemaVersion !== 1 || document.kind !== "AgentRuntimeMachineProbe"
    || document.protocolVersion !== RUNTIME_MACHINE_DISCOVERY_VERSION
    || document.status !== document.executable.availability
    || document.runtimeControlEnabled !== false || document.authorityEffect !== "none") {
    fail("Agent runtime machine probe is invalid.", "INVALID_AGENT_RUNTIME_MACHINE_PROBE");
  }
  verifyIdentity(document, { prefix: "agent-runtime-machine-probe", idKey: "probeId", hashKey: "probeHash", code: "AGENT_RUNTIME_MACHINE_PROBE_DIGEST_MISMATCH" });
  return document;
}

export function verifyWorkspaceHostMachineProbe(document) {
  assertFields(document, ["schemaVersion", "kind", "protocolVersion", "descriptor", "status", "authorityEffect", "probeId", "probeHash"], "Workspace host machine probe");
  if (canonicalJson(document.descriptor) !== canonicalJson(hostDescriptor())
    || document.schemaVersion !== 1 || document.kind !== "WorkspaceHostMachineProbe"
    || document.protocolVersion !== RUNTIME_MACHINE_DISCOVERY_VERSION
    || document.status !== "read-only-machine-discovery" || document.authorityEffect !== "none") {
    fail("Workspace host machine probe is invalid.", "INVALID_WORKSPACE_HOST_MACHINE_PROBE");
  }
  verifyIdentity(document, { prefix: "workspace-host-machine-probe", idKey: "probeId", hashKey: "probeHash", code: "WORKSPACE_HOST_MACHINE_PROBE_DIGEST_MISMATCH" });
  return document;
}

export function buildRuntimeMachineComposition({
  runtimes = RUNTIME_ADAPTER_RUNTIMES,
  platform = process.platform,
  environment = process.env,
  fileSystem = fs, storage,
} = {}) {
  const selectedRuntimes = normalizedRuntimes(runtimes);
  const platformAdapter = new ReadOnlyPlatformAdapter({ platform, environment, fileSystem });
  const workspaceHostAdapter = new ReadOnlyWorkspaceHostAdapter();
  const agentRuntimeProbes = selectedRuntimes.map((runtime) => new ReadOnlyAgentRuntimeAdapter({ runtime, platformAdapter, storage }).probe());
  const payload = {
    schemaVersion: 1,
    kind: "RuntimeMachineComposition",
    protocolVersion: RUNTIME_MACHINE_DISCOVERY_VERSION,
    selectedRuntimes,
    platformProbe: platformAdapter.probe(),
    workspaceHostProbe: workspaceHostAdapter.probe(),
    agentRuntimeProbes,
    discoverySummary: {
      discoveredRuntimes: agentRuntimeProbes.filter((probe) => probe.status === "candidate-found").map((probe) => probe.descriptor.runtime),
      unavailableRuntimes: agentRuntimeProbes.filter((probe) => probe.status === "not-found").map((probe) => probe.descriptor.runtime),
      rawPathsExposed: false,
    },
    activationBoundary: {
      phase: "read-only-machine-discovery",
      machineInterfaceDiscoveryValidated: true,
      actualPlatformExecutionValidated: false,
      actualRuntimeControlValidated: false,
      runtimeControlEnabled: false,
      capabilityDoesNotGrantAuthorization: true,
      executionContractRequiredForControl: true,
      providerSessionReferencesOperationalOnly: true,
      tuiScrapingAllowed: false,
    },
    authority: "operational-observation-only",
    instructionAuthority: false,
    promotionAuthority: false,
    controlAuthority: false,
    mutatesCanon: false,
  };
  return verifyRuntimeMachineComposition(identify(payload, "runtime-machine-composition", "compositionId", "compositionHash"));
}

export function verifyRuntimeMachineComposition(document) {
  assertFields(document, [
    "schemaVersion", "kind", "protocolVersion", "selectedRuntimes", "platformProbe", "workspaceHostProbe",
    "agentRuntimeProbes", "discoverySummary", "activationBoundary", "authority", "instructionAuthority",
    "promotionAuthority", "controlAuthority", "mutatesCanon", "compositionId", "compositionHash",
  ], "Runtime machine composition");
  assertFields(document.discoverySummary, ["discoveredRuntimes", "unavailableRuntimes", "rawPathsExposed"], "Runtime discovery summary");
  assertFields(document.activationBoundary, [
    "phase", "machineInterfaceDiscoveryValidated", "actualPlatformExecutionValidated", "actualRuntimeControlValidated",
    "runtimeControlEnabled", "capabilityDoesNotGrantAuthorization", "executionContractRequiredForControl",
    "providerSessionReferencesOperationalOnly", "tuiScrapingAllowed",
  ], "Runtime machine activation boundary");
  const runtimes = normalizedRuntimes(document.selectedRuntimes);
  verifyPlatformMachineProbe(document.platformProbe);
  verifyWorkspaceHostMachineProbe(document.workspaceHostProbe);
  const probes = document.agentRuntimeProbes.map(verifyAgentRuntimeMachineProbe);
  const discovered = probes.filter((probe) => probe.status === "candidate-found").map((probe) => probe.descriptor.runtime);
  const unavailable = probes.filter((probe) => probe.status === "not-found").map((probe) => probe.descriptor.runtime);
  if (canonicalJson(document.selectedRuntimes) !== canonicalJson(runtimes)
    || canonicalJson(probes.map((probe) => probe.descriptor.runtime)) !== canonicalJson(runtimes)
    || canonicalJson(document.discoverySummary) !== canonicalJson({ discoveredRuntimes: discovered, unavailableRuntimes: unavailable, rawPathsExposed: false })
    || document.schemaVersion !== 1 || document.kind !== "RuntimeMachineComposition"
    || document.protocolVersion !== RUNTIME_MACHINE_DISCOVERY_VERSION
    || canonicalJson(document.activationBoundary) !== canonicalJson({
      phase: "read-only-machine-discovery",
      machineInterfaceDiscoveryValidated: true,
      actualPlatformExecutionValidated: false,
      actualRuntimeControlValidated: false,
      runtimeControlEnabled: false,
      capabilityDoesNotGrantAuthorization: true,
      executionContractRequiredForControl: true,
      providerSessionReferencesOperationalOnly: true,
      tuiScrapingAllowed: false,
    })
    || document.authority !== "operational-observation-only"
    || document.instructionAuthority !== false || document.promotionAuthority !== false
    || document.controlAuthority !== false || document.mutatesCanon !== false) {
    fail("Runtime machine composition is invalid.", "INVALID_RUNTIME_MACHINE_COMPOSITION");
  }
  verifyIdentity(document, { prefix: "runtime-machine-composition", idKey: "compositionId", hashKey: "compositionHash", code: "RUNTIME_MACHINE_COMPOSITION_DIGEST_MISMATCH" });
  return document;
}

export function inspectRuntimeMachineInterfaces(options = {}) {
  return {
    status: "read-only-machine-discovery",
    composition: buildRuntimeMachineComposition(options),
    runtimeControlEnabled: false,
    nextGate: "actual-platform-execution-project-binding-process-ownership-and-lifecycle-conformance",
    authorityEffect: "none",
  };
}

export const RUNTIME_MACHINE_CONTROL_METHODS = Object.freeze({
  agent: [...AGENT_CONTROL_METHODS],
  platform: [...PLATFORM_CONTROL_METHODS],
  workspaceHost: [...HOST_CONTROL_METHODS],
});
