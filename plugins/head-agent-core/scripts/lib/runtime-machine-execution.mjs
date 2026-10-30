import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  RUNTIME_ADAPTER_PLATFORMS,
  RUNTIME_ADAPTER_RUNTIMES,
} from "./runtime-adapter.mjs";
import { resolveReadOnlyRuntimeExecutableTarget } from "./runtime-machine-discovery.mjs";

export const RUNTIME_VERSION_EVIDENCE_VERSION = "0.1.0";

const VERSION_ARGUMENTS = Object.freeze(["--version"]);
const VERSION_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT_BYTES = 16 * 1024;
const TERMINATION_GRACE_MS = 500;
const CONTROL_METHODS = Object.freeze(["start", "resume", "stream", "interrupt", "close"]);

const fail = (message, code = "RUNTIME_MACHINE_EXECUTION_ERROR") => {
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
const EMPTY_OUTPUT_DIGEST = digest(Buffer.alloc(0));

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
    fail("Runtime version evidence digest verification failed.", code);
  }
}

function assertFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} is invalid.`, "INVALID_RUNTIME_VERSION_EVIDENCE");
  }
  const expected = new Set(fields);
  if (Object.keys(value).some((field) => !expected.has(field)) || fields.some((field) => !(field in value))) {
    fail(`${label} fields are invalid.`, "INVALID_RUNTIME_VERSION_EVIDENCE");
  }
}

function normalizeRuntime(value) {
  const runtime = String(value || "").trim().toLowerCase();
  if (!RUNTIME_ADAPTER_RUNTIMES.includes(runtime)) {
    fail(`Unsupported runtime version probe: ${runtime || "(empty)"}.`, "UNSUPPORTED_RUNTIME_VERSION_PROBE");
  }
  return runtime;
}

function normalizePlatform(value) {
  const platform = String(value || "").trim().toLowerCase();
  if (!RUNTIME_ADAPTER_PLATFORMS.includes(platform)) {
    fail(`Unsupported runtime version platform: ${platform || "(empty)"}.`, "UNSUPPORTED_RUNTIME_VERSION_PLATFORM");
  }
  return platform;
}

function normalizedRuntimes(values) {
  const input = values === undefined || values === null ? RUNTIME_ADAPTER_RUNTIMES : values;
  if (!Array.isArray(input) || !input.length) {
    fail("Runtime version evidence requires at least one runtime.", "RUNTIME_VERSION_RUNTIME_REQUIRED");
  }
  return [...new Set(input.map(normalizeRuntime))].sort(compareText);
}

function disabledOperation(kind, operation) {
  fail(`${kind} operation ${operation} is not enabled by a version observation.`, "RUNTIME_ADAPTER_CONTROL_NOT_ENABLED");
}

function minimalEnvironment(environment) {
  const allowed = new Set(["systemroot", "windir", "temp", "tmp", "lang", "lc_all"]);
  const result = {};
  for (const [key, value] of Object.entries(environment || {})) {
    if (allowed.has(key.toLowerCase()) && typeof value === "string") result[key] = value;
  }
  result.CI = "1";
  result.NO_COLOR = "1";
  result.TERM = "dumb";
  return result;
}

function invocationContract() {
  return {
    operation: "runtime.version.v1",
    argumentProfile: "fixed-version-flag",
    argumentDigest: digest(canonicalJson(VERSION_ARGUMENTS)),
    shellInterpretation: false,
    stdinEnabled: false,
    tuiScraping: false,
    providerSessionCreated: false,
    projectContentPassed: false,
    projectMutationAllowed: false,
    workingDirectoryPolicy: "filesystem-root-no-project-binding",
    environmentPolicy: "minimal-os-allowlist",
    outputPolicy: "digest-and-normalized-version-only",
    timeoutMs: VERSION_TIMEOUT_MS,
    stdoutLimitBytes: OUTPUT_LIMIT_BYTES,
    stderrLimitBytes: OUTPUT_LIMIT_BYTES,
  };
}

function platformBoundaryDescriptor(platform) {
  return {
    adapterKind: `${platform}-bounded-version-observation`,
    platform,
    machineInterface: "direct-child-process",
    operation: "runtime.version.v1",
    shellInterpretation: false,
    runtimeControlEnabled: false,
  };
}

function workspaceHostBoundaryDescriptor() {
  return {
    adapterKind: "native-process-bounded-version-observation",
    workspaceHost: "native-process",
    operation: "runtime.version.v1",
    exactChildOwnership: true,
    shellInterpretation: false,
    providerSessionCreated: false,
    runtimeControlEnabled: false,
  };
}

function emptyOutcome(status) {
  return {
    status,
    version: "",
    exitCode: null,
    signal: "none",
    timedOut: false,
    outputLimited: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    outputDigest: EMPTY_OUTPUT_DIGEST,
    childStarted: false,
    childExitObserved: false,
    terminationRequested: false,
    exactChildOwnership: false,
  };
}

function extractVersion(stdout, stderr) {
  const text = `${stdout}\n${stderr}`.replaceAll("\0", "").trim();
  const match = text.match(/(?:^|\s|[=:(])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=$|\s|[),;])/);
  return match ? match[1] : "";
}

function runExactChild({ executablePath, cwd, environment, spawnImplementation = spawn }) {
  return new Promise((resolve) => {
    let child;
    let timeoutHandle;
    let forceHandle;
    let spawnError = false;
    let timedOut = false;
    let outputLimited = false;
    let terminationRequested = false;
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];

    const requestTermination = () => {
      if (!child?.pid || child.exitCode !== null || child.signalCode !== null || terminationRequested) return;
      terminationRequested = true;
      try { child.kill("SIGTERM"); } catch {}
      forceHandle = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGKILL"); } catch {}
        }
      }, TERMINATION_GRACE_MS);
      forceHandle.unref?.();
    };

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (forceHandle) clearTimeout(forceHandle);
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      const version = !spawnError && !timedOut && !outputLimited && exitCode === 0
        ? extractVersion(stdoutBuffer.toString("utf8"), stderrBuffer.toString("utf8"))
        : "";
      const status = spawnError ? "spawn-failed"
        : timedOut ? "timed-out"
          : outputLimited ? "output-limit"
            : exitCode !== 0 ? "nonzero-exit"
              : version ? "verified" : "unparseable-version";
      resolve({
        status,
        version,
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: signal ? String(signal).slice(0, 32) : "none",
        timedOut,
        outputLimited,
        stdoutBytes,
        stderrBytes,
        outputDigest: digest(Buffer.concat([stdoutBuffer, Buffer.from([0]), stderrBuffer])),
        childStarted: Boolean(child?.pid),
        childExitObserved: Boolean(child?.pid),
        terminationRequested,
        exactChildOwnership: Boolean(child?.pid),
      });
    };

    try {
      child = spawnImplementation(executablePath, VERSION_ARGUMENTS, {
        cwd,
        env: minimalEnvironment(environment),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      spawnError = true;
      finish(null, null);
      return;
    }

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, VERSION_TIMEOUT_MS);
    timeoutHandle.unref?.();

    child.stdout?.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > OUTPUT_LIMIT_BYTES) {
        outputLimited = true;
        requestTermination();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > OUTPUT_LIMIT_BYTES) {
        outputLimited = true;
        requestTermination();
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", () => {
      spawnError = true;
      if (!child.pid) finish(null, null);
    });
    child.once("close", finish);
  });
}

function validateExecutableObservation(document, runtime) {
  assertFields(document, [
    "runtime", "availability", "launcherKind", "directSpawnSafe", "pathDigest", "canonicalPathDigest",
    "byteLength", "symbolicLink",
  ], "Runtime executable observation");
  if (document.runtime !== runtime
    || !["candidate-found", "not-found"].includes(document.availability)
    || !["native-executable", "command-shim", "extensionless-candidate", "none"].includes(document.launcherKind)
    || typeof document.directSpawnSafe !== "boolean" || typeof document.symbolicLink !== "boolean"
    || !Number.isSafeInteger(document.byteLength) || document.byteLength < 0
    || (document.availability === "candidate-found" && (!/^[a-f0-9]{64}$/.test(document.pathDigest)
      || !/^[a-f0-9]{64}$/.test(document.canonicalPathDigest) || document.byteLength < 1))
    || (document.availability === "not-found" && (document.pathDigest !== "" || document.canonicalPathDigest !== ""
      || document.byteLength !== 0 || document.launcherKind !== "none" || document.directSpawnSafe))) {
    fail("Runtime executable observation is invalid.", "INVALID_RUNTIME_VERSION_EXECUTABLE_OBSERVATION");
  }
}

function validateOutcome(outcome) {
  assertFields(outcome, [
    "status", "version", "exitCode", "signal", "timedOut", "outputLimited", "stdoutBytes", "stderrBytes",
    "outputDigest", "childStarted", "childExitObserved", "terminationRequested", "exactChildOwnership",
  ], "Runtime version outcome");
  const statuses = ["not-found", "unsafe-launcher", "spawn-failed", "timed-out", "output-limit", "nonzero-exit", "unparseable-version", "verified"];
  if (!statuses.includes(outcome.status)
    || typeof outcome.version !== "string" || outcome.version.length > 128
    || (outcome.exitCode !== null && !Number.isInteger(outcome.exitCode))
    || typeof outcome.signal !== "string" || outcome.signal.length > 32
    || typeof outcome.timedOut !== "boolean" || typeof outcome.outputLimited !== "boolean"
    || !Number.isSafeInteger(outcome.stdoutBytes) || outcome.stdoutBytes < 0
    || !Number.isSafeInteger(outcome.stderrBytes) || outcome.stderrBytes < 0
    || !/^[a-f0-9]{64}$/.test(outcome.outputDigest)
    || typeof outcome.childStarted !== "boolean" || typeof outcome.childExitObserved !== "boolean"
    || typeof outcome.terminationRequested !== "boolean" || typeof outcome.exactChildOwnership !== "boolean"
    || (outcome.status === "verified" && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(outcome.version))
    || (outcome.status !== "verified" && outcome.version !== "")
    || (outcome.childStarted !== outcome.childExitObserved)
    || (outcome.childStarted !== outcome.exactChildOwnership)) {
    fail("Runtime version outcome is invalid.", "INVALID_RUNTIME_VERSION_OUTCOME");
  }
}

export function verifyRuntimeVersionObservation(document) {
  assertFields(document, [
    "schemaVersion", "kind", "protocolVersion", "runtime", "platform", "executable", "invocation",
    "outcome", "authority", "instructionAuthority", "promotionAuthority", "controlAuthority", "mutatesCanon",
    "observationId", "observationHash",
  ], "Runtime version observation");
  const runtime = normalizeRuntime(document.runtime);
  const platform = normalizePlatform(document.platform);
  validateExecutableObservation(document.executable, runtime);
  assertFields(document.invocation, Object.keys(invocationContract()), "Runtime version invocation contract");
  validateOutcome(document.outcome);
  const available = document.executable.availability === "candidate-found";
  const expectedUninvoked = !available ? "not-found" : document.executable.directSpawnSafe ? null : "unsafe-launcher";
  if (document.schemaVersion !== 1 || document.kind !== "RuntimeVersionObservation"
    || document.protocolVersion !== RUNTIME_VERSION_EVIDENCE_VERSION
    || canonicalJson(document.invocation) !== canonicalJson(invocationContract())
    || (expectedUninvoked && document.outcome.status !== expectedUninvoked)
    || (expectedUninvoked && canonicalJson(document.outcome) !== canonicalJson(emptyOutcome(expectedUninvoked)))
    || (!expectedUninvoked && ["not-found", "unsafe-launcher"].includes(document.outcome.status))
    || document.authority !== "operational-observation-only"
    || document.instructionAuthority !== false || document.promotionAuthority !== false
    || document.controlAuthority !== false || document.mutatesCanon !== false
    || !RUNTIME_ADAPTER_PLATFORMS.includes(platform)) {
    fail("Runtime version observation is invalid.", "INVALID_RUNTIME_VERSION_OBSERVATION");
  }
  verifyIdentity(document, {
    prefix: "runtime-version-observation",
    idKey: "observationId",
    hashKey: "observationHash",
    code: "RUNTIME_VERSION_OBSERVATION_DIGEST_MISMATCH",
  });
  return document;
}

export class BoundedVersionWorkspaceHostAdapter {
  constructor({ spawnImplementation = spawn } = {}) { this.spawnImplementation = spawnImplementation; }
  describe() { return workspaceHostBoundaryDescriptor(); }
  executeVersionProbe({ executablePath, cwd, environment }) {
    return runExactChild({ executablePath, cwd, environment, spawnImplementation: this.spawnImplementation });
  }
  attach() { return disabledOperation("WorkspaceHostAdapter", "attach"); }
  send() { return disabledOperation("WorkspaceHostAdapter", "send"); }
  receive() { return disabledOperation("WorkspaceHostAdapter", "receive"); }
  detach() { return disabledOperation("WorkspaceHostAdapter", "detach"); }
}

export class BoundedVersionPlatformAdapter {
  constructor({
    platform = process.platform,
    environment = process.env,
    fileSystem = fs,
    workspaceHostAdapter = new BoundedVersionWorkspaceHostAdapter(),
  } = {}) {
    this.platform = normalizePlatform(platform);
    this.environment = environment;
    this.fileSystem = fileSystem;
    this.workspaceHostAdapter = workspaceHostAdapter;
  }
  describe() { return platformBoundaryDescriptor(this.platform); }
  resolveTarget(runtime) {
    return resolveReadOnlyRuntimeExecutableTarget({
      runtime,
      platform: this.platform,
      environment: this.environment,
      fileSystem: this.fileSystem,
    });
  }
  invokeVersion({ executablePath, cwd }) {
    return this.workspaceHostAdapter.executeVersionProbe({
      executablePath,
      cwd,
      environment: this.environment,
    });
  }
  spawnOwned() { return disabledOperation("PlatformAdapter", "spawn-owned-control"); }
  inspectOwned() { return disabledOperation("PlatformAdapter", "inspect-owned-control"); }
  terminateOwned() { return disabledOperation("PlatformAdapter", "terminate-owned-control"); }
}

export class BoundedVersionAgentRuntimeAdapter {
  constructor({ runtime, platformAdapter } = {}) {
    this.runtime = normalizeRuntime(runtime);
    if (!(platformAdapter instanceof BoundedVersionPlatformAdapter)) {
      fail("BoundedVersionAgentRuntimeAdapter requires a BoundedVersionPlatformAdapter.", "INVALID_RUNTIME_VERSION_ADAPTER");
    }
    this.platformAdapter = platformAdapter;
  }
  describe() {
    return {
      adapterKind: `${this.runtime}-bounded-version-observation`,
      runtime: this.runtime,
      operation: "runtime.version.v1",
      providerSessionCreated: false,
      runtimeControlEnabled: false,
    };
  }
  async probeVersion() {
    const target = this.platformAdapter.resolveTarget(this.runtime);
    const neutralCwd = target.executablePath ? path.parse(target.executablePath).root : null;
    let outcome = target.observation.availability !== "candidate-found"
      ? emptyOutcome("not-found")
      : !target.observation.directSpawnSafe
        ? emptyOutcome("unsafe-launcher")
        : await this.platformAdapter.invokeVersion({ executablePath: target.executablePath, cwd: neutralCwd });
    const payload = {
      schemaVersion: 1,
      kind: "RuntimeVersionObservation",
      protocolVersion: RUNTIME_VERSION_EVIDENCE_VERSION,
      runtime: this.runtime,
      platform: this.platformAdapter.platform,
      executable: target.observation,
      invocation: invocationContract(),
      outcome,
      authority: "operational-observation-only",
      instructionAuthority: false,
      promotionAuthority: false,
      controlAuthority: false,
      mutatesCanon: false,
    };
    return verifyRuntimeVersionObservation(identify(payload, "runtime-version-observation", "observationId", "observationHash"));
  }
  start() { return disabledOperation("AgentRuntimeAdapter", "start"); }
  resume() { return disabledOperation("AgentRuntimeAdapter", "resume"); }
  stream() { return disabledOperation("AgentRuntimeAdapter", "stream"); }
  interrupt() { return disabledOperation("AgentRuntimeAdapter", "interrupt"); }
  close() { return disabledOperation("AgentRuntimeAdapter", "close"); }
}

export async function buildRuntimeVersionEvidence({
  runtimes = RUNTIME_ADAPTER_RUNTIMES,
  platform = process.platform,
  environment = process.env,
  fileSystem = fs,
  spawnImplementation = spawn,
} = {}) {
  const selectedRuntimes = normalizedRuntimes(runtimes);
  const workspaceHostAdapter = new BoundedVersionWorkspaceHostAdapter({ spawnImplementation });
  const platformAdapter = new BoundedVersionPlatformAdapter({ platform, environment, fileSystem, workspaceHostAdapter });
  const observations = [];
  for (const runtime of selectedRuntimes) {
    observations.push(await new BoundedVersionAgentRuntimeAdapter({ runtime, platformAdapter }).probeVersion());
  }
  const verifiedRuntimes = observations.filter((item) => item.outcome.status === "verified").map((item) => item.runtime);
  const unavailableRuntimes = observations.filter((item) => ["not-found", "unsafe-launcher"].includes(item.outcome.status)).map((item) => item.runtime);
  const failedRuntimes = observations.filter((item) => !["verified", "not-found", "unsafe-launcher"].includes(item.outcome.status)).map((item) => item.runtime);
  const allRequestedVersionsVerified = verifiedRuntimes.length === selectedRuntimes.length;
  const payload = {
    schemaVersion: 1,
    kind: "RuntimeVersionEvidence",
    protocolVersion: RUNTIME_VERSION_EVIDENCE_VERSION,
    selectedRuntimes,
    platform: platformAdapter.platform,
    platformBoundary: platformAdapter.describe(),
    workspaceHostBoundary: workspaceHostAdapter.describe(),
    observations,
    summary: {
      verifiedRuntimes,
      unavailableRuntimes,
      failedRuntimes,
      allRequestedVersionsVerified,
      rawPathsExposed: false,
      rawOutputExposed: false,
    },
    activationBoundary: {
      phase: "bounded-non-session-version-evidence",
      machineInterfaceDiscoveryValidated: true,
      actualPlatformExecutionValidated: allRequestedVersionsVerified,
      actualRuntimeControlValidated: false,
      runtimeControlEnabled: false,
      capabilityDoesNotGrantAuthorization: true,
      executionContractRequiredForControl: true,
      providerSessionCreated: false,
      providerSessionReferencesOperationalOnly: true,
      tuiScrapingAllowed: false,
    },
    authority: "operational-observation-only",
    instructionAuthority: false,
    promotionAuthority: false,
    controlAuthority: false,
    mutatesCanon: false,
  };
  return verifyRuntimeVersionEvidence(identify(payload, "runtime-version-evidence", "evidenceId", "evidenceHash"));
}

export function verifyRuntimeVersionEvidence(document) {
  assertFields(document, [
    "schemaVersion", "kind", "protocolVersion", "selectedRuntimes", "platform", "platformBoundary",
    "workspaceHostBoundary", "observations", "summary", "activationBoundary", "authority", "instructionAuthority",
    "promotionAuthority", "controlAuthority", "mutatesCanon", "evidenceId", "evidenceHash",
  ], "Runtime version evidence");
  assertFields(document.summary, [
    "verifiedRuntimes", "unavailableRuntimes", "failedRuntimes", "allRequestedVersionsVerified",
    "rawPathsExposed", "rawOutputExposed",
  ], "Runtime version evidence summary");
  assertFields(document.activationBoundary, [
    "phase", "machineInterfaceDiscoveryValidated", "actualPlatformExecutionValidated", "actualRuntimeControlValidated",
    "runtimeControlEnabled", "capabilityDoesNotGrantAuthorization", "executionContractRequiredForControl",
    "providerSessionCreated", "providerSessionReferencesOperationalOnly", "tuiScrapingAllowed",
  ], "Runtime version activation boundary");
  const runtimes = normalizedRuntimes(document.selectedRuntimes);
  const platform = normalizePlatform(document.platform);
  assertFields(document.platformBoundary, Object.keys(platformBoundaryDescriptor(platform)), "Runtime version platform boundary");
  assertFields(document.workspaceHostBoundary, Object.keys(workspaceHostBoundaryDescriptor()), "Runtime version workspace-host boundary");
  const observations = document.observations.map(verifyRuntimeVersionObservation);
  const verifiedRuntimes = observations.filter((item) => item.outcome.status === "verified").map((item) => item.runtime);
  const unavailableRuntimes = observations.filter((item) => ["not-found", "unsafe-launcher"].includes(item.outcome.status)).map((item) => item.runtime);
  const failedRuntimes = observations.filter((item) => !["verified", "not-found", "unsafe-launcher"].includes(item.outcome.status)).map((item) => item.runtime);
  const allRequestedVersionsVerified = verifiedRuntimes.length === runtimes.length;
  const expectedSummary = {
    verifiedRuntimes,
    unavailableRuntimes,
    failedRuntimes,
    allRequestedVersionsVerified,
    rawPathsExposed: false,
    rawOutputExposed: false,
  };
  const expectedActivation = {
    phase: "bounded-non-session-version-evidence",
    machineInterfaceDiscoveryValidated: true,
    actualPlatformExecutionValidated: allRequestedVersionsVerified,
    actualRuntimeControlValidated: false,
    runtimeControlEnabled: false,
    capabilityDoesNotGrantAuthorization: true,
    executionContractRequiredForControl: true,
    providerSessionCreated: false,
    providerSessionReferencesOperationalOnly: true,
    tuiScrapingAllowed: false,
  };
  if (document.schemaVersion !== 1 || document.kind !== "RuntimeVersionEvidence"
    || document.protocolVersion !== RUNTIME_VERSION_EVIDENCE_VERSION
    || canonicalJson(document.selectedRuntimes) !== canonicalJson(runtimes)
    || canonicalJson(observations.map((item) => item.runtime)) !== canonicalJson(runtimes)
    || document.platform !== platform
    || canonicalJson(document.platformBoundary) !== canonicalJson(platformBoundaryDescriptor(platform))
    || canonicalJson(document.workspaceHostBoundary) !== canonicalJson(workspaceHostBoundaryDescriptor())
    || canonicalJson(document.summary) !== canonicalJson(expectedSummary)
    || canonicalJson(document.activationBoundary) !== canonicalJson(expectedActivation)
    || document.authority !== "operational-observation-only"
    || document.instructionAuthority !== false || document.promotionAuthority !== false
    || document.controlAuthority !== false || document.mutatesCanon !== false) {
    fail("Runtime version evidence is invalid.", "INVALID_RUNTIME_VERSION_EVIDENCE");
  }
  verifyIdentity(document, {
    prefix: "runtime-version-evidence",
    idKey: "evidenceId",
    hashKey: "evidenceHash",
    code: "RUNTIME_VERSION_EVIDENCE_DIGEST_MISMATCH",
  });
  return document;
}

export const RUNTIME_VERSION_CONTROL_METHODS = CONTROL_METHODS;
