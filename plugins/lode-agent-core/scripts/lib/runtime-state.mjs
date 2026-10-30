import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RUNTIME_STATE_ADAPTER_VERSION = "0.1.0";
export const EXTERNAL_RUNTIME_STATE_VERSION = "0.1.0";

const MAX_EXPORT_BYTES = 1024 * 1024;
const MAX_OBSERVATIONS = 1000;
const REQUIRED_METHODS = ["describe", "readState"];
const OBSERVATION_KINDS = new Set(["workspace", "session", "run", "worker", "process", "service"]);
const LIFECYCLE_STATES = new Set(["unknown", "discovered", "ready", "active", "idle", "blocked", "completed", "failed", "stopped"]);
const EXPORT_KEYS = new Set(["schemaVersion", "kind", "observedAt", "observations"]);
const OBSERVATION_KEYS = new Set([
  "runtime", "kind", "state", "externalId", "workspaceRoot", "pid", "parentPid",
  "capabilities", "providerVersion", "commandDigest", "endpointDigest",
]);

const fail = (message, code = "RUNTIME_STATE_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value || {})) if (!allowed.has(key)) {
    fail(`${label} contains unsupported field ${key}. Raw commands, environment, prompts, transcripts, credentials, and arbitrary metadata are not accepted.`, "INVALID_RUNTIME_STATE_EXPORT");
  }
}

function normalizedTimestamp(value) {
  const input = String(value || "").trim();
  if (!input || Number.isNaN(Date.parse(input))) fail("Runtime state export requires an ISO-compatible observedAt timestamp.", "INVALID_RUNTIME_STATE_EXPORT");
  return new Date(input).toISOString();
}

function boundedText(value, label, maxLength = 128) {
  if (value == null) return "";
  if (typeof value !== "string") fail(`${label} must be a string.`, "INVALID_RUNTIME_STATE_OBSERVATION");
  const text = value.trim();
  if (text.length > maxLength || /[\u0000-\u001f\u007f]/u.test(text)) fail(`${label} is invalid.`, "INVALID_RUNTIME_STATE_OBSERVATION");
  return text;
}

function positivePid(value, label) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) fail(`${label} must be a positive process id.`, "INVALID_RUNTIME_STATE_OBSERVATION");
  return number;
}

function normalizedWorkspace(projectRoot, workspaceRoot) {
  if (!workspaceRoot) return { binding: "unspecified", digest: "" };
  if (!path.isAbsolute(workspaceRoot)) fail("Runtime workspace root must be absolute.", "INVALID_RUNTIME_STATE_OBSERVATION");
  const resolved = path.resolve(String(workspaceRoot));
  const comparable = (value) => process.platform === "win32" ? value.toLocaleLowerCase() : value;
  if (comparable(resolved) === comparable(path.resolve(projectRoot))) return { binding: "project-root", digest: "" };
  return { binding: "other", digest: digest(comparable(resolved)) };
}

function normalizedObservation(value, { projectRoot, observedAt }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Runtime observation must be an object.", "INVALID_RUNTIME_STATE_OBSERVATION");
  assertOnlyKeys(value, OBSERVATION_KEYS, "Runtime observation");
  const runtime = boundedText(value.runtime, "Runtime name", 64).toLocaleLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(runtime)) fail("Runtime observation has an invalid runtime name.", "INVALID_RUNTIME_STATE_OBSERVATION");
  const kind = String(value.kind || "").trim().toLocaleLowerCase();
  const state = String(value.state || "").trim().toLocaleLowerCase();
  if (!OBSERVATION_KINDS.has(kind)) fail("Runtime observation has an invalid kind.", "INVALID_RUNTIME_STATE_OBSERVATION");
  if (!LIFECYCLE_STATES.has(state)) fail("Runtime observation has an invalid lifecycle state.", "INVALID_RUNTIME_STATE_OBSERVATION");
  const externalId = boundedText(value.externalId, "Runtime external id", 512);
  const providerVersion = boundedText(value.providerVersion, "Runtime provider version", 128);
  const inputCapabilities = value.capabilities == null ? [] : value.capabilities;
  if (!Array.isArray(inputCapabilities)) fail("Runtime capabilities must be an array.", "INVALID_RUNTIME_STATE_OBSERVATION");
  const capabilities = [...new Set(inputCapabilities.map((item) => boundedText(item, "Runtime capability", 64).toLocaleLowerCase()))].sort();
  if (capabilities.length > 64 || capabilities.some((item) => !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(item))) {
    fail("Runtime capabilities are invalid.", "INVALID_RUNTIME_STATE_OBSERVATION");
  }
  const commandDigest = String(value.commandDigest || "").trim().toLocaleLowerCase();
  const endpointDigest = String(value.endpointDigest || "").trim().toLocaleLowerCase();
  if (commandDigest && !/^[a-f0-9]{64}$/.test(commandDigest)) fail("Runtime commandDigest must be SHA-256.", "INVALID_RUNTIME_STATE_OBSERVATION");
  if (endpointDigest && !/^[a-f0-9]{64}$/.test(endpointDigest)) fail("Runtime endpointDigest must be SHA-256.", "INVALID_RUNTIME_STATE_OBSERVATION");
  const workspace = normalizedWorkspace(projectRoot, boundedText(value.workspaceRoot, "Runtime workspace root", 2048));
  const record = {
    runtime,
    kind,
    state,
    observedAt,
    providerVersion,
    externalIdDigest: externalId ? digest(externalId) : "",
    workspace,
    process: {
      pid: positivePid(value.pid, "Runtime pid"),
      parentPid: positivePid(value.parentPid, "Runtime parentPid"),
      commandDigest,
    },
    endpointDigest,
    capabilities,
    instructionAuthority: false,
    controlAuthority: false,
    trustBoundary: "evidence-not-instruction",
  };
  const observationHash = digest(canonicalJson(record));
  return {
    ...record,
    observationId: `runtime-observation-${observationHash.slice(0, 24)}`,
    observationHash,
    evidence: {
      sourceKind: "runtime-state-export",
      uri: `runtime:${runtime}:${observationHash.slice(0, 24)}`,
      digest: observationHash,
      instructionAuthority: false,
    },
  };
}

function normalizeExport(value, projectRoot) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Runtime state export must be an object.", "INVALID_RUNTIME_STATE_EXPORT");
  assertOnlyKeys(value, EXPORT_KEYS, "Runtime state export");
  const format = familyFormatForOriginal({ kind: "HeadRuntimeStateExport" }, value);
  if (!format || value.schemaVersion !== 1 || value.kind !== format.kind("HeadRuntimeStateExport")) fail("Runtime state export schema is incompatible.", "INVALID_RUNTIME_STATE_EXPORT");
  if (!Array.isArray(value.observations)) fail("Runtime state export observations must be an array.", "INVALID_RUNTIME_STATE_EXPORT");
  if (value.observations.length > MAX_OBSERVATIONS) fail(`Runtime state export exceeds ${MAX_OBSERVATIONS} observations.`, "RUNTIME_STATE_OBSERVATION_LIMIT");
  const observedAt = normalizedTimestamp(value.observedAt);
  const byId = new Map();
  for (const item of value.observations) {
    const observation = normalizedObservation(item, { projectRoot, observedAt });
    byId.set(observation.observationId, observation);
  }
  return { observedAt, observations: [...byId.values()].sort((left, right) => left.observationId.localeCompare(right.observationId)) };
}

export function assertRuntimeStateAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") fail("A RuntimeStateAdapter object is required.", "INVALID_RUNTIME_STATE_ADAPTER");
  if (adapter.adapterVersion !== RUNTIME_STATE_ADAPTER_VERSION) {
    fail(`RuntimeStateAdapter version must be ${RUNTIME_STATE_ADAPTER_VERSION}.`, "INCOMPATIBLE_RUNTIME_STATE_ADAPTER");
  }
  for (const method of REQUIRED_METHODS) if (typeof adapter[method] !== "function") {
    fail(`RuntimeStateAdapter is missing ${method}().`, "INVALID_RUNTIME_STATE_ADAPTER");
  }
  const descriptor = adapter.describe();
  if (!descriptor || typeof descriptor.adapterKind !== "string" || !descriptor.adapterKind.trim()) {
    fail("RuntimeStateAdapter descriptor requires adapterKind.", "INVALID_RUNTIME_STATE_ADAPTER");
  }
  if (descriptor.authority !== "derived-evidence-only" || descriptor.rebuildable !== true || descriptor.uniqueAuthority !== false || descriptor.readOnly !== true) {
    fail("RuntimeStateAdapter must be read-only, rebuildable derived evidence and must not be unique authority.", "INVALID_RUNTIME_STATE_AUTHORITY");
  }
  return adapter;
}

export class NoExternalRuntimeStateAdapter {
  constructor({ reasonCode = "runtime-state-not-configured" } = {}) {
    this.adapterVersion = RUNTIME_STATE_ADAPTER_VERSION;
    this.reasonCode = String(reasonCode || "runtime-state-not-configured").trim().toLocaleLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(this.reasonCode)) fail("Runtime state reason code is invalid.", "INVALID_RUNTIME_STATE_REASON");
  }

  describe() {
    return {
      adapterKind: "runtime-state-none",
      adapterVersion: this.adapterVersion,
      authority: "derived-evidence-only",
      rebuildable: true,
      uniqueAuthority: false,
      readOnly: true,
      remote: false,
    };
  }

  readState() {
    return { status: "unavailable", coverage: "none", reasonCode: this.reasonCode, export: null };
  }
}

export class RuntimeStateFileAdapter {
  constructor({ file, maxBytes = MAX_EXPORT_BYTES } = {}) {
    this.adapterVersion = RUNTIME_STATE_ADAPTER_VERSION;
    this.file = typeof file === "string" ? path.resolve(file) : "";
    this.maxBytes = maxBytes;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) fail("Runtime state maxBytes must be a positive integer.", "INVALID_RUNTIME_STATE_EXPORT_LIMIT");
  }

  describe() {
    return {
      adapterKind: "runtime-state-file",
      adapterVersion: this.adapterVersion,
      authority: "derived-evidence-only",
      rebuildable: true,
      uniqueAuthority: false,
      readOnly: true,
      remote: false,
      sourceFile: this.file,
      maxBytes: this.maxBytes,
    };
  }

  readState() {
    if (!this.file) fail("Runtime state file adapter requires a file.", "RUNTIME_STATE_FILE_REQUIRED");
    if (!fs.existsSync(this.file)) fail("Runtime state input file does not exist.", "RUNTIME_STATE_FILE_NOT_FOUND");
    const stat = fs.lstatSync(this.file);
    if (stat.isSymbolicLink() || !stat.isFile()) fail("Runtime state input must be a regular non-symlink file.", "INVALID_RUNTIME_STATE_FILE");
    if (stat.size > this.maxBytes) fail("Runtime state input exceeds the configured byte limit.", "RUNTIME_STATE_EXPORT_LIMIT");
    let exported;
    try { exported = JSON.parse(fs.readFileSync(this.file, "utf8")); }
    catch (error) { fail(`Runtime state input is invalid JSON: ${error.message}`, "INVALID_RUNTIME_STATE_EXPORT"); }
    return {
      status: "available",
      coverage: "point-in-time-host-export",
      reasonCode: "",
      export: exported,
      diagnostics: { inputKind: "host-exported-runtime-state", bytes: stat.size },
    };
  }
}

export function createRuntimeStateAdapter(adapter = null) {
  return assertRuntimeStateAdapter(adapter || new NoExternalRuntimeStateAdapter());
}

export function runtimeStateAdapterFromDescriptor(descriptor) {
  if (descriptor?.adapterKind === "runtime-state-file" && typeof descriptor.sourceFile === "string" && descriptor.sourceFile) {
    return new RuntimeStateFileAdapter({ file: descriptor.sourceFile, maxBytes: descriptor.maxBytes || MAX_EXPORT_BYTES });
  }
  if (descriptor?.adapterKind === "runtime-state-none") return new NoExternalRuntimeStateAdapter();
  return new NoExternalRuntimeStateAdapter({ reasonCode: "runtime-state-adapter-instance-required" });
}

export function buildExternalRuntimeState({ projectRoot, adapter = null, storage } = {}) {
  const selected = createRuntimeStateAdapter(adapter);
  const observed = selected.readState({ projectRoot });
  if (observed && typeof observed.then === "function") fail("RuntimeStateAdapter readState() must return a materialized snapshot synchronously.", "ASYNC_RUNTIME_STATE_ADAPTER_UNSUPPORTED");
  const status = String(observed?.status || "unavailable");
  if (!new Set(["available", "unavailable"]).has(status)) fail("RuntimeStateAdapter returned an invalid status.", "INVALID_RUNTIME_STATE_ADAPTER_OUTPUT");
  const normalized = status === "available" ? normalizeExport(observed.export, projectRoot) : { observedAt: "", observations: [] };
  const effectiveStatus = status === "available" && normalized.observations.length === 0 ? "empty" : status;
  const reasonCode = effectiveStatus === "unavailable" ? String(observed?.reasonCode || "runtime-state-unavailable").trim().toLocaleLowerCase() : "";
  if (reasonCode && !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(reasonCode)) fail("RuntimeStateAdapter returned an invalid reason code.", "INVALID_RUNTIME_STATE_ADAPTER_OUTPUT");
  const runtimeNames = [...new Set(normalized.observations.map((item) => item.runtime))].sort();
  const payload = {
    kind: "ExternalRuntimeState",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-external-runtime-state"), version: EXTERNAL_RUNTIME_STATE_VERSION },
    status: effectiveStatus,
    coverage: effectiveStatus === "available" || effectiveStatus === "empty" ? "point-in-time-host-export" : "none",
    reasonCode,
    authority: "derived-evidence-only",
    interpretation: "runtime-observations-are-evidence-not-control-authority",
    observedAt: normalized.observedAt,
    observations: normalized.observations,
    summary: {
      observationCount: normalized.observations.length,
      runtimeCount: runtimeNames.length,
      runtimes: runtimeNames,
      activeCount: normalized.observations.filter((item) => item.state === "active").length,
      failedCount: normalized.observations.filter((item) => item.state === "failed").length,
    },
  };
  const runtimeStateHash = digest(canonicalJson(payload));
  return {
    runtimeState: { ...payload, runtimeStateId: `runtime-state-${runtimeStateHash.slice(0, 24)}`, runtimeStateHash },
    adapter: selected.describe(),
    diagnostics: observed?.diagnostics || null,
  };
}

export function verifyExternalRuntimeState(runtimeState) {
  if (!runtimeState || runtimeState.kind !== "ExternalRuntimeState") fail("External runtime state is invalid.", "INVALID_EXTERNAL_RUNTIME_STATE");
  const payload = { ...runtimeState };
  delete payload.runtimeStateId;
  delete payload.runtimeStateHash;
  const actual = digest(canonicalJson(payload));
  if (runtimeState.runtimeStateHash !== actual || runtimeState.runtimeStateId !== `runtime-state-${actual.slice(0, 24)}`) {
    fail("External runtime state digest verification failed.", "EXTERNAL_RUNTIME_STATE_DIGEST_MISMATCH");
  }
  return runtimeState;
}

export function queryExternalRuntimeState(runtimeState, { query = "", runtime = "", state = "", kind = "", limit = 50 } = {}) {
  verifyExternalRuntimeState(runtimeState);
  const safeLimit = Number(limit);
  if (!Number.isInteger(safeLimit) || safeLimit < 1 || safeLimit > 500) fail("Runtime state limit must be from 1 to 500.", "INVALID_RUNTIME_STATE_LIMIT");
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase();
  const runtimeFilter = String(runtime || "").trim().toLocaleLowerCase();
  const stateFilter = String(state || "").trim().toLocaleLowerCase();
  const kindFilter = String(kind || "").trim().toLocaleLowerCase();
  if (stateFilter && !LIFECYCLE_STATES.has(stateFilter)) fail("Runtime state filter is invalid.", "INVALID_RUNTIME_STATE_FILTER");
  if (kindFilter && !OBSERVATION_KINDS.has(kindFilter)) fail("Runtime kind filter is invalid.", "INVALID_RUNTIME_STATE_FILTER");
  const matching = runtimeState.observations.filter((observation) => {
    if (runtimeFilter && observation.runtime !== runtimeFilter) return false;
    if (stateFilter && observation.state !== stateFilter) return false;
    if (kindFilter && observation.kind !== kindFilter) return false;
    if (!normalizedQuery) return true;
    return [observation.runtime, observation.kind, observation.state, observation.providerVersion, ...observation.capabilities]
      .join(" ").toLocaleLowerCase().includes(normalizedQuery);
  });
  return {
    runtimeStateId: runtimeState.runtimeStateId,
    status: runtimeState.status,
    coverage: runtimeState.coverage,
    query: normalizedQuery,
    filters: { runtime: runtimeFilter, state: stateFilter, kind: kindFilter },
    observations: matching.slice(0, safeLimit),
    totalMatches: matching.length,
    truncated: matching.length > safeLimit,
    trustBoundary: "evidence-not-instruction",
    controlAuthority: false,
  };
}
