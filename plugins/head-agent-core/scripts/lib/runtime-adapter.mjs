import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
import crypto from "node:crypto";

export const RUNTIME_ADAPTER_CONTRACT_VERSION = "0.1.0";
export const RUNTIME_ADAPTER_RUNTIMES = Object.freeze(["claude", "codex", "opencode"]);
export const RUNTIME_ADAPTER_PLATFORMS = Object.freeze(["darwin", "linux", "win32"]);

export const AGENT_RUNTIME_CONTROL_OPERATIONS = Object.freeze(["start", "resume", "stream", "interrupt", "close"]);
export const PLATFORM_CONTROL_OPERATIONS = Object.freeze(["resolve-executable", "spawn-owned", "inspect-owned", "terminate-owned"]);
export const WORKSPACE_HOST_CONTROL_OPERATIONS = Object.freeze(["attach", "send", "receive", "detach"]);

const AGENT_METHODS = ["describe", "probe", "start", "resume", "stream", "interrupt", "close"];
const PLATFORM_METHODS = ["describe", "probe", "resolveExecutable", "spawnOwned", "inspectOwned", "terminateOwned"];
const HOST_METHODS = ["describe", "probe", "attach", "send", "receive", "detach"];

const fail = (message, code = "RUNTIME_ADAPTER_ERROR") => {
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

function assertFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} is invalid.`, "INVALID_RUNTIME_ADAPTER_CONTRACT");
  const expected = new Set(fields);
  if (Object.keys(value).some((field) => !expected.has(field)) || fields.some((field) => !(field in value))) {
    fail(`${label} fields are invalid.`, "INVALID_RUNTIME_ADAPTER_CONTRACT");
  }
}

function exactArray(value, expected) {
  return Array.isArray(value) && canonicalJson(value) === canonicalJson(expected);
}

function synchronous(value, label) {
  if (value && typeof value.then === "function") fail(`${label} must be synchronous in the contract-only phase.`, "ASYNC_RUNTIME_ADAPTER_PROBE_UNSUPPORTED");
  return value;
}

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
    fail("Runtime adapter artifact digest verification failed.", code);
  }
}

function disabledOperation(kind, operation) {
  fail(`${kind} operation ${operation} is disabled until a machine-interface adapter passes ownership and lifecycle conformance.`, "RUNTIME_ADAPTER_CONTROL_NOT_ENABLED");
}

function normalizeRuntime(value) {
  const runtime = String(value || "").trim().toLowerCase();
  if (!RUNTIME_ADAPTER_RUNTIMES.includes(runtime)) fail(`Unsupported AgentRuntimeAdapter runtime: ${runtime || "(empty)"}.`, "UNSUPPORTED_AGENT_RUNTIME_ADAPTER");
  return runtime;
}

function normalizePlatform(value) {
  const platform = String(value || "").trim().toLowerCase();
  if (!RUNTIME_ADAPTER_PLATFORMS.includes(platform)) fail(`Unsupported PlatformAdapter platform: ${platform || "(empty)"}.`, "UNSUPPORTED_PLATFORM_ADAPTER");
  return platform;
}

function agentDescriptor(runtime, storage) {
  const format = formatForVerifiedOwner(storage);
  return {
    contractVersion: RUNTIME_ADAPTER_CONTRACT_VERSION,
    adapterKind: `${runtime}-projection-only`,
    runtime,
    interfaceMode: "projection-only",
    machineInterface: "not-configured",
    supportedOperations: ["probe"],
    disabledOperations: [...AGENT_RUNTIME_CONTROL_OPERATIONS],
    tuiScraping: false,
    providerSessionIdentity: "external-reference-only",
    [format.value("headSessionIdentity")]: "canonical-project-session",
    capabilityAuthority: "none",
    executionContractRequired: true,
    controlOperationsEnabled: false,
    instructionAuthority: false,
    promotionAuthority: false,
    controlAuthority: false,
    mutatesCanon: false,
  };
}

function platformDescriptor(platform) {
  const pathModel = platform === "win32" ? "windows-native" : "posix-native";
  return {
    contractVersion: RUNTIME_ADAPTER_CONTRACT_VERSION,
    adapterKind: `${platform}-contract-only`,
    platform,
    pathModel,
    supportedOperations: ["probe"],
    disabledOperations: [...PLATFORM_CONTROL_OPERATIONS],
    processTreeOwnership: "not-activated",
    atomicFileOperations: "not-activated",
    permissionModel: "not-activated",
    ipcModel: "not-activated",
    serviceLifecycle: "not-activated",
    capabilityAuthority: "none",
    controlOperationsEnabled: false,
    instructionAuthority: false,
    promotionAuthority: false,
    controlAuthority: false,
    mutatesCanon: false,
  };
}

function hostDescriptor() {
  return {
    contractVersion: RUNTIME_ADAPTER_CONTRACT_VERSION,
    adapterKind: "native-process-contract-only",
    workspaceHost: "native-process",
    transport: "not-configured",
    supportedOperations: ["probe"],
    disabledOperations: [...WORKSPACE_HOST_CONTROL_OPERATIONS],
    processOwnership: "not-activated",
    callerFencing: "not-activated",
    capabilityAuthority: "none",
    controlOperationsEnabled: false,
    instructionAuthority: false,
    promotionAuthority: false,
    controlAuthority: false,
    mutatesCanon: false,
  };
}

export function verifiedWorkspaceHostDescriptor({ deliverySupported = true } = {}) {
  return {
    contractVersion: RUNTIME_ADAPTER_CONTRACT_VERSION,
    adapterKind: "verified-host-endpoint",
    workspaceHost: "injected-exact-endpoint",
    transport: "driver-owned",
    supportedOperations: WORKSPACE_HOST_CONTROL_OPERATIONS.filter(operation => deliverySupported || operation !== "send"),
    disabledOperations: deliverySupported ? [] : ["send"],
    processOwnership: "external-host-owned",
    callerFencing: "fresh-snapshot-exact-endpoint",
    capabilityAuthority: "host-operational-delivery-only",
    controlOperationsEnabled: true,
    instructionAuthority: false,
    promotionAuthority: false,
    controlAuthority: false,
    mutatesCanon: false,
  };
}

function probeFromDescriptor(kind, descriptor, storage) {
  const activeWorkspaceHost = kind === "WorkspaceHostProbe" && descriptor.adapterKind === "verified-host-endpoint";
  const payload = {
    schemaVersion: 1,
    kind,
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-runtime-adapter-probe"), version: RUNTIME_ADAPTER_CONTRACT_VERSION },
    descriptor,
    status: activeWorkspaceHost ? "active" : "contract-only",
    availability: activeWorkspaceHost ? "configured" : "not-activated",
    authorityEffect: activeWorkspaceHost ? "host-operational-delivery-only" : "none",
  };
  const prefix = kind === "AgentRuntimeProbe" ? "agent-runtime-probe"
    : kind === "PlatformProbe" ? "platform-probe" : "workspace-host-probe";
  return identify(payload, prefix, "probeId", "probeHash");
}

function validateAgentDescriptor(descriptor, selectedFormat) {
  const format = selectedFormat || (Object.hasOwn(descriptor || {}, "lodeSessionIdentity")
    ? formatForVerifiedOwner({ dialect: "lode", directory: ".lode" }) : formatForVerifiedOwner());
  assertFields(descriptor, [
    "contractVersion", "adapterKind", "runtime", "interfaceMode", "machineInterface", "supportedOperations",
    "disabledOperations", "tuiScraping", "providerSessionIdentity", format.value("headSessionIdentity"), "capabilityAuthority",
    "executionContractRequired", "controlOperationsEnabled", "instructionAuthority", "promotionAuthority",
    "controlAuthority", "mutatesCanon",
  ], "AgentRuntimeAdapter descriptor");
  const expected = agentDescriptor(normalizeRuntime(descriptor.runtime), format);
  if (canonicalJson(descriptor) !== canonicalJson(expected)) {
    fail("AgentRuntimeAdapter descriptor violates the projection-only authority boundary.", "INVALID_AGENT_RUNTIME_ADAPTER");
  }
  return descriptor;
}

function validatePlatformDescriptor(descriptor) {
  assertFields(descriptor, [
    "contractVersion", "adapterKind", "platform", "pathModel", "supportedOperations", "disabledOperations",
    "processTreeOwnership", "atomicFileOperations", "permissionModel", "ipcModel", "serviceLifecycle",
    "capabilityAuthority", "controlOperationsEnabled", "instructionAuthority", "promotionAuthority",
    "controlAuthority", "mutatesCanon",
  ], "PlatformAdapter descriptor");
  const expected = platformDescriptor(normalizePlatform(descriptor.platform));
  if (canonicalJson(descriptor) !== canonicalJson(expected)) {
    fail("PlatformAdapter descriptor violates the contract-only authority boundary.", "INVALID_PLATFORM_ADAPTER");
  }
  return descriptor;
}

function validateHostDescriptor(descriptor) {
  assertFields(descriptor, [
    "contractVersion", "adapterKind", "workspaceHost", "transport", "supportedOperations", "disabledOperations",
    "processOwnership", "callerFencing", "capabilityAuthority", "controlOperationsEnabled", "instructionAuthority",
    "promotionAuthority", "controlAuthority", "mutatesCanon",
  ], "WorkspaceHostAdapter descriptor");
  const expected = descriptor.adapterKind === "verified-host-endpoint" ? verifiedWorkspaceHostDescriptor({ deliverySupported: descriptor.supportedOperations?.includes("send") }) : hostDescriptor();
  if (canonicalJson(descriptor) !== canonicalJson(expected)) {
    fail("WorkspaceHostAdapter descriptor violates the contract-only authority boundary.", "INVALID_WORKSPACE_HOST_ADAPTER");
  }
  return descriptor;
}

function validateProbe(document, { kind, descriptorValidator, prefix }) {
  assertFields(document, ["schemaVersion", "kind", "protocol", "descriptor", "status", "availability", "authorityEffect", "probeId", "probeHash"], kind);
  assertFields(document.protocol, ["name", "version"], `${kind} protocol`);
  const format = familyFormatForOriginal("head-agent-core-runtime-adapter-probe", document);
  descriptorValidator(document.descriptor, format);
  const activeWorkspaceHost = kind === "WorkspaceHostProbe" && document.descriptor.adapterKind === "verified-host-endpoint";
  if (document.schemaVersion !== 1 || document.kind !== kind
    || !format || document.protocol.name !== format.protocol("head-agent-core-runtime-adapter-probe")
    || document.protocol.version !== RUNTIME_ADAPTER_CONTRACT_VERSION
    || document.status !== (activeWorkspaceHost ? "active" : "contract-only")
    || document.availability !== (activeWorkspaceHost ? "configured" : "not-activated")
    || document.authorityEffect !== (activeWorkspaceHost ? "host-operational-delivery-only" : "none")
    || !new RegExp(`^${prefix}-[a-f0-9]{24}$`).test(document.probeId || "")
    || !/^[a-f0-9]{64}$/.test(document.probeHash || "")) {
    fail(`${kind} is invalid.`, "INVALID_RUNTIME_ADAPTER_PROBE");
  }
  verifyIdentity(document, { prefix, idKey: "probeId", hashKey: "probeHash", code: "RUNTIME_ADAPTER_PROBE_DIGEST_MISMATCH" });
  return document;
}

export function validateAgentRuntimeProbe(document) {
  return validateProbe(document, { kind: "AgentRuntimeProbe", descriptorValidator: validateAgentDescriptor, prefix: "agent-runtime-probe" });
}

export function validatePlatformProbe(document) {
  return validateProbe(document, { kind: "PlatformProbe", descriptorValidator: validatePlatformDescriptor, prefix: "platform-probe" });
}

export function validateWorkspaceHostProbe(document) {
  return validateProbe(document, { kind: "WorkspaceHostProbe", descriptorValidator: validateHostDescriptor, prefix: "workspace-host-probe" });
}

export function buildWorkspaceHostProbe(descriptor = hostDescriptor(), storage) {
  validateHostDescriptor(descriptor);
  return validateWorkspaceHostProbe(probeFromDescriptor("WorkspaceHostProbe", descriptor, storage));
}

export function validateAgentRuntimeAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") fail("AgentRuntimeAdapter object is required.", "INVALID_AGENT_RUNTIME_ADAPTER");
  for (const method of AGENT_METHODS) if (typeof adapter[method] !== "function") fail(`AgentRuntimeAdapter is missing ${method}().`, "INVALID_AGENT_RUNTIME_ADAPTER");
  const descriptor = validateAgentDescriptor(synchronous(adapter.describe(), "AgentRuntimeAdapter describe()"));
  const probe = validateAgentRuntimeProbe(synchronous(adapter.probe(), "AgentRuntimeAdapter probe()"));
  if (canonicalJson(probe.descriptor) !== canonicalJson(descriptor)) {
    fail("AgentRuntimeAdapter probe does not describe the validated adapter.", "INVALID_AGENT_RUNTIME_ADAPTER");
  }
  return adapter;
}

export function validatePlatformAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") fail("PlatformAdapter object is required.", "INVALID_PLATFORM_ADAPTER");
  for (const method of PLATFORM_METHODS) if (typeof adapter[method] !== "function") fail(`PlatformAdapter is missing ${method}().`, "INVALID_PLATFORM_ADAPTER");
  const descriptor = validatePlatformDescriptor(synchronous(adapter.describe(), "PlatformAdapter describe()"));
  const probe = validatePlatformProbe(synchronous(adapter.probe(), "PlatformAdapter probe()"));
  if (canonicalJson(probe.descriptor) !== canonicalJson(descriptor)) {
    fail("PlatformAdapter probe does not describe the validated adapter.", "INVALID_PLATFORM_ADAPTER");
  }
  return adapter;
}

export function validateWorkspaceHostAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") fail("WorkspaceHostAdapter object is required.", "INVALID_WORKSPACE_HOST_ADAPTER");
  for (const method of HOST_METHODS) if (typeof adapter[method] !== "function") fail(`WorkspaceHostAdapter is missing ${method}().`, "INVALID_WORKSPACE_HOST_ADAPTER");
  const descriptor = validateHostDescriptor(synchronous(adapter.describe(), "WorkspaceHostAdapter describe()"));
  const probe = validateWorkspaceHostProbe(synchronous(adapter.probe(), "WorkspaceHostAdapter probe()"));
  if (canonicalJson(probe.descriptor) !== canonicalJson(descriptor)) {
    fail("WorkspaceHostAdapter probe does not describe the validated adapter.", "INVALID_WORKSPACE_HOST_ADAPTER");
  }
  return adapter;
}

export class ProjectionOnlyAgentRuntimeAdapter {
  constructor({ runtime, storage } = {}) { this.runtime = normalizeRuntime(runtime); this.storage = storage; }
  describe() { return agentDescriptor(this.runtime, this.storage); }
  probe() { return validateAgentRuntimeProbe(probeFromDescriptor("AgentRuntimeProbe", this.describe(), this.storage)); }
  start() { return disabledOperation("AgentRuntimeAdapter", "start"); }
  resume() { return disabledOperation("AgentRuntimeAdapter", "resume"); }
  stream() { return disabledOperation("AgentRuntimeAdapter", "stream"); }
  interrupt() { return disabledOperation("AgentRuntimeAdapter", "interrupt"); }
  close() { return disabledOperation("AgentRuntimeAdapter", "close"); }
}

export class ContractOnlyPlatformAdapter {
  constructor({ platform = process.platform, storage } = {}) { this.platform = normalizePlatform(platform); this.storage = storage; }
  describe() { return platformDescriptor(this.platform); }
  probe() { return validatePlatformProbe(probeFromDescriptor("PlatformProbe", this.describe(), this.storage)); }
  resolveExecutable() { return disabledOperation("PlatformAdapter", "resolve-executable"); }
  spawnOwned() { return disabledOperation("PlatformAdapter", "spawn-owned"); }
  inspectOwned() { return disabledOperation("PlatformAdapter", "inspect-owned"); }
  terminateOwned() { return disabledOperation("PlatformAdapter", "terminate-owned"); }
}

export class ContractOnlyWorkspaceHostAdapter {
  constructor({ storage } = {}) { this.storage = storage; }
  describe() { return hostDescriptor(); }
  probe() { return validateWorkspaceHostProbe(probeFromDescriptor("WorkspaceHostProbe", this.describe(), this.storage)); }
  attach() { return disabledOperation("WorkspaceHostAdapter", "attach"); }
  send() { return disabledOperation("WorkspaceHostAdapter", "send"); }
  receive() { return disabledOperation("WorkspaceHostAdapter", "receive"); }
  detach() { return disabledOperation("WorkspaceHostAdapter", "detach"); }
}

function activationBoundaryFor(workspaceHostProbe, storage) {
  const workspaceHostMessagingEnabled = workspaceHostProbe.descriptor.adapterKind === "verified-host-endpoint" && workspaceHostProbe.descriptor.supportedOperations.includes("send");
  return {
    phase: workspaceHostMessagingEnabled ? "host-messaging-active" : workspaceHostProbe.descriptor.adapterKind === "verified-host-endpoint" ? "host-attachment-active" : "contract-only",
    machineInterfacesVerified: false,
    runtimeControlEnabled: false,
    workspaceHostMessagingEnabled,
    capabilityDoesNotGrantAuthorization: true,
    executionContractRequired: true,
    [formatForVerifiedOwner(storage).value("headSessionIdentityIndependent")]: true,
    providerSessionReferencesOperationalOnly: true,
    tuiScrapingAllowed: false,
  };
}

function normalizedRuntimes(values) {
  const input = values === undefined || values === null ? RUNTIME_ADAPTER_RUNTIMES : values;
  if (!Array.isArray(input) || !input.length) {
    fail("Runtime adapter composition requires at least one runtime.", "RUNTIME_ADAPTER_RUNTIME_REQUIRED");
  }
  const runtimes = [...new Set(input.map(normalizeRuntime))].sort(compareText);
  return runtimes;
}

export function buildRuntimeAdapterComposition({
  runtimes = RUNTIME_ADAPTER_RUNTIMES,
  platform = process.platform,
  runtimeAdapters = null,
  platformAdapter = null,
  workspaceHostAdapter = null, storage,
} = {}) {
  const format = formatForVerifiedOwner(storage);
  const selectedRuntimes = normalizedRuntimes(runtimes);
  const selectedPlatform = platformAdapter || new ContractOnlyPlatformAdapter({ platform, storage });
  const selectedHost = workspaceHostAdapter || new ContractOnlyWorkspaceHostAdapter({ storage });
  const selectedRuntimeAdapters = runtimeAdapters || selectedRuntimes.map((runtime) => new ProjectionOnlyAgentRuntimeAdapter({ runtime, storage }));
  if (!Array.isArray(selectedRuntimeAdapters) || selectedRuntimeAdapters.length !== selectedRuntimes.length) {
    fail("Runtime adapter composition must provide exactly one adapter per selected runtime.", "INVALID_RUNTIME_ADAPTER_COMPOSITION");
  }
  validatePlatformAdapter(selectedPlatform);
  validateWorkspaceHostAdapter(selectedHost);
  const agentProbes = selectedRuntimeAdapters.map((adapter) => {
    validateAgentRuntimeAdapter(adapter);
    return adapter.probe();
  }).sort((left, right) => compareText(left.descriptor.runtime, right.descriptor.runtime));
  if (canonicalJson(agentProbes.map((probe) => probe.descriptor.runtime)) !== canonicalJson(selectedRuntimes)) {
    fail("Runtime adapter composition does not match the selected runtime set.", "INVALID_RUNTIME_ADAPTER_COMPOSITION");
  }
  const workspaceHostProbe = selectedHost.probe();
  const payload = {
    schemaVersion: 1,
    kind: "RuntimeAdapterComposition",
    protocol: { name: format.protocol("head-agent-core-runtime-adapter-composition"), version: RUNTIME_ADAPTER_CONTRACT_VERSION },
    selectedRuntimes,
    platformProbe: selectedPlatform.probe(),
    workspaceHostProbe,
    agentRuntimeProbes: agentProbes,
    activationBoundary: activationBoundaryFor(workspaceHostProbe, storage),
    authority: "operational-capability-contract-only",
    instructionAuthority: false,
    promotionAuthority: false,
    controlAuthority: false,
    mutatesCanon: false,
  };
  return verifyRuntimeAdapterComposition(identify(payload, "runtime-adapter-composition", "compositionId", "compositionHash"));
}

export function verifyRuntimeAdapterComposition(document) {
  const format = familyFormatForOriginal("head-agent-core-runtime-adapter-composition", document);
  assertFields(document, [
    "schemaVersion", "kind", "protocol", "selectedRuntimes", "platformProbe", "workspaceHostProbe",
    "agentRuntimeProbes", "activationBoundary", "authority", "instructionAuthority", "promotionAuthority",
    "controlAuthority", "mutatesCanon", "compositionId", "compositionHash",
  ], "Runtime adapter composition");
  assertFields(document.protocol, ["name", "version"], "Runtime adapter composition protocol");
  assertFields(document.activationBoundary, [
    "phase", "machineInterfacesVerified", "runtimeControlEnabled", "workspaceHostMessagingEnabled", "capabilityDoesNotGrantAuthorization",
    "executionContractRequired", (format?.value("headSessionIdentityIndependent") || "headSessionIdentityIndependent"), "providerSessionReferencesOperationalOnly",
    "tuiScrapingAllowed",
  ], "Runtime adapter activation boundary");
  const runtimes = normalizedRuntimes(document.selectedRuntimes);
  if (!exactArray(document.selectedRuntimes, runtimes) || !Array.isArray(document.agentRuntimeProbes)) {
    fail("Runtime adapter composition runtime set is invalid.", "INVALID_RUNTIME_ADAPTER_COMPOSITION");
  }
  validatePlatformProbe(document.platformProbe);
  validateWorkspaceHostProbe(document.workspaceHostProbe);
  const probes = document.agentRuntimeProbes.map(validateAgentRuntimeProbe);
  if (canonicalJson(probes.map((probe) => probe.descriptor.runtime)) !== canonicalJson(runtimes)
    || [document.platformProbe, document.workspaceHostProbe, ...probes].some(probe => !format || probe.protocol.name !== format.protocol("head-agent-core-runtime-adapter-probe"))
    || document.schemaVersion !== 1 || document.kind !== "RuntimeAdapterComposition"
    || !format || document.protocol.name !== format.protocol("head-agent-core-runtime-adapter-composition")
    || document.protocol.version !== RUNTIME_ADAPTER_CONTRACT_VERSION
    || canonicalJson(document.activationBoundary) !== canonicalJson(activationBoundaryFor(document.workspaceHostProbe, format))
    || document.authority !== "operational-capability-contract-only"
    || document.instructionAuthority !== false || document.promotionAuthority !== false
    || document.controlAuthority !== false || document.mutatesCanon !== false
    || !/^runtime-adapter-composition-[a-f0-9]{24}$/.test(document.compositionId || "")
    || !/^[a-f0-9]{64}$/.test(document.compositionHash || "")) {
    fail("Runtime adapter composition violates the contract-only boundary.", "INVALID_RUNTIME_ADAPTER_COMPOSITION");
  }
  verifyIdentity(document, {
    prefix: "runtime-adapter-composition",
    idKey: "compositionId",
    hashKey: "compositionHash",
    code: "RUNTIME_ADAPTER_COMPOSITION_DIGEST_MISMATCH",
  });
  return document;
}

export function buildRuntimeAdapterContractMatrix() {
  const compositions = RUNTIME_ADAPTER_PLATFORMS.map((platform) => buildRuntimeAdapterComposition({
    platform,
    runtimes: RUNTIME_ADAPTER_RUNTIMES,
  })).map((composition) => ({
    platform: composition.platformProbe.descriptor.platform,
    compositionId: composition.compositionId,
    compositionHash: composition.compositionHash,
    runtimes: composition.selectedRuntimes,
  }));
  const payload = {
    schemaVersion: 1,
    kind: "RuntimeAdapterContractMatrix",
    protocolVersion: RUNTIME_ADAPTER_CONTRACT_VERSION,
    platforms: [...RUNTIME_ADAPTER_PLATFORMS],
    runtimes: [...RUNTIME_ADAPTER_RUNTIMES],
    compositions,
    scope: "contract-shape-and-authority-boundary-only",
    actualPlatformExecutionValidated: false,
    actualRuntimeControlValidated: false,
    authorityEffect: "none",
  };
  return verifyRuntimeAdapterContractMatrix(identify(payload, "runtime-adapter-matrix", "matrixId", "matrixHash"));
}

export function verifyRuntimeAdapterContractMatrix(document) {
  assertFields(document, [
    "schemaVersion", "kind", "protocolVersion", "platforms", "runtimes", "compositions", "scope",
    "actualPlatformExecutionValidated", "actualRuntimeControlValidated", "authorityEffect", "matrixId", "matrixHash",
  ], "Runtime adapter contract matrix");
  if (!exactArray(document.platforms, RUNTIME_ADAPTER_PLATFORMS)
    || !exactArray(document.runtimes, RUNTIME_ADAPTER_RUNTIMES)
    || !Array.isArray(document.compositions) || document.compositions.length !== RUNTIME_ADAPTER_PLATFORMS.length) {
    fail("Runtime adapter contract matrix dimensions are invalid.", "INVALID_RUNTIME_ADAPTER_CONTRACT_MATRIX");
  }
  const expectedEntries = RUNTIME_ADAPTER_PLATFORMS.map((platform) => {
    const composition = buildRuntimeAdapterComposition({ platform, runtimes: RUNTIME_ADAPTER_RUNTIMES });
    return {
      platform,
      compositionId: composition.compositionId,
      compositionHash: composition.compositionHash,
      runtimes: composition.selectedRuntimes,
    };
  });
  if (document.schemaVersion !== 1 || document.kind !== "RuntimeAdapterContractMatrix"
    || document.protocolVersion !== RUNTIME_ADAPTER_CONTRACT_VERSION
    || canonicalJson(document.compositions) !== canonicalJson(expectedEntries)
    || document.scope !== "contract-shape-and-authority-boundary-only"
    || document.actualPlatformExecutionValidated !== false || document.actualRuntimeControlValidated !== false
    || document.authorityEffect !== "none"
    || !/^runtime-adapter-matrix-[a-f0-9]{24}$/.test(document.matrixId || "")
    || !/^[a-f0-9]{64}$/.test(document.matrixHash || "")) {
    fail("Runtime adapter contract matrix is invalid.", "INVALID_RUNTIME_ADAPTER_CONTRACT_MATRIX");
  }
  verifyIdentity(document, {
    prefix: "runtime-adapter-matrix",
    idKey: "matrixId",
    hashKey: "matrixHash",
    code: "RUNTIME_ADAPTER_CONTRACT_MATRIX_DIGEST_MISMATCH",
  });
  return document;
}

export function inspectRuntimeAdapterContracts({ runtimes, platform = process.platform, storage } = {}) {
  return {
    status: "contract-only",
    composition: buildRuntimeAdapterComposition({ runtimes, platform, storage }),
    contractMatrix: buildRuntimeAdapterContractMatrix(),
    runtimeControlEnabled: false,
    nextGate: "machine-interface-probe-process-ownership-and-lifecycle-conformance",
    authorityEffect: "none",
  };
}
