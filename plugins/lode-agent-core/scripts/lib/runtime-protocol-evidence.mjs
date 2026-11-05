import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
const sessionIdOf = record => {
  const format = familyFormatForOriginal({ sessionIdentity: true }, record);
  return format ? record?.[format.sessionIdField] : undefined;
};
const originalFormat = record => familyFormatForOriginal({ kind: record?.kind }, record);
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  RUNTIME_ADAPTER_PLATFORMS,
  RUNTIME_ADAPTER_RUNTIMES,
} from "./runtime-adapter.mjs";
import { resolveReadOnlyRuntimeExecutableTarget } from "./runtime-machine-discovery.mjs";
import { verifyRuntimeVersionEvidence } from "./runtime-machine-execution.mjs";

export const RUNTIME_PROTOCOL_EVIDENCE_VERSION = "0.2.0";
export const RUNTIME_PROJECT_BINDING_VERSION = "0.1.0";

const PROBE_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 500;
const CONTROL_METHODS = Object.freeze(["start", "resume", "stream", "interrupt", "close"]);

const fail = (message, code = "RUNTIME_PROTOCOL_EVIDENCE_ERROR") => {
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
    fail("Runtime protocol artifact digest verification failed.", code);
  }
}

function assertFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} is invalid.`, "INVALID_RUNTIME_PROTOCOL_EVIDENCE");
  }
  const expected = new Set(fields);
  if (Object.keys(value).some((field) => !expected.has(field)) || fields.some((field) => !(field in value))) {
    fail(`${label} fields are invalid.`, "INVALID_RUNTIME_PROTOCOL_EVIDENCE");
  }
}

function normalizeRuntime(value) {
  const runtime = String(value || "").trim().toLowerCase();
  if (!RUNTIME_ADAPTER_RUNTIMES.includes(runtime)) {
    fail(`Unsupported runtime protocol probe: ${runtime || "(empty)"}.`, "UNSUPPORTED_RUNTIME_PROTOCOL_PROBE");
  }
  return runtime;
}

function normalizePlatform(value) {
  const platform = String(value || "").trim().toLowerCase();
  if (!RUNTIME_ADAPTER_PLATFORMS.includes(platform)) {
    fail(`Unsupported runtime protocol platform: ${platform || "(empty)"}.`, "UNSUPPORTED_RUNTIME_PROTOCOL_PLATFORM");
  }
  return platform;
}

function normalizedRuntimes(values) {
  const input = values === undefined || values === null ? RUNTIME_ADAPTER_RUNTIMES : values;
  if (!Array.isArray(input) || !input.length) {
    fail("Runtime protocol evidence requires at least one runtime.", "RUNTIME_PROTOCOL_RUNTIME_REQUIRED");
  }
  return [...new Set(input.map(normalizeRuntime))].sort(compareText);
}

function disabledOperation(kind, operation) {
  fail(`${kind} operation ${operation} is not enabled by protocol capability evidence.`, "RUNTIME_ADAPTER_CONTROL_NOT_ENABLED");
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

const signal = (name, pattern) => Object.freeze({ name, pattern });

const RUNTIME_PROFILES = Object.freeze({
  claude: Object.freeze({
    probes: Object.freeze([
      Object.freeze({
        name: "root-help",
        arguments: Object.freeze(["--help"]),
        signals: Object.freeze([
          signal("execution:non-interactive", /-p, --print\b|--print, -p\b/i),
          signal("events:format-option", /--output-format\b/i),
          signal("events:stream-json", /stream-json/i),
          signal("output:schema", /--json-schema\b/i),
          signal("session:ephemeral", /--no-session-persistence\b/i),
          signal("session:resume", /(?:^|\s)-r, --resume|--resume\b/m),
          signal("session:continue", /(?:^|\s)-c, --continue|--continue\b/m),
          signal("execution:permission-mode", /--permission-mode\b/i),
          signal("execution:tools-option", /--tools\b/i),
          signal("execution:disable-skills", /--disable-slash-commands\b/i),
          signal("execution:setting-sources", /--setting-sources\b/i),
          signal("execution:strict-mcp", /--strict-mcp-config\b/i),
          signal("execution:mcp-config", /--mcp-config\b/i),
        ]),
      }),
    ]),
    capabilities: Object.freeze([
      Object.freeze({ name: "non-interactive-execution", requirements: Object.freeze(["execution:non-interactive", "events:format-option", "events:stream-json", "output:schema", "session:ephemeral"]) }),
      Object.freeze({ name: "structured-event-stream", requirements: Object.freeze(["events:format-option", "events:stream-json"]) }),
      Object.freeze({ name: "one-shot-invocation-surface", requirements: Object.freeze(["execution:non-interactive", "events:stream-json", "output:schema", "session:ephemeral", "execution:permission-mode", "execution:tools-option", "execution:disable-skills", "execution:setting-sources", "execution:strict-mcp", "execution:mcp-config"]) }),
      Object.freeze({ name: "provider-session-resume-surface", requirements: Object.freeze(["session:resume", "session:continue"]) }),
    ]),
    requiredForNegotiation: Object.freeze(["non-interactive-execution", "structured-event-stream"]),
  }),
  codex: Object.freeze({
    probes: Object.freeze([
      Object.freeze({
        name: "root-help",
        arguments: Object.freeze(["--help"]),
        signals: Object.freeze([
          signal("command:exec", /(?:^|\s)exec(?:\s|$)/m),
          signal("command:mcp-server", /(?:^|\s)mcp-server(?:\s|$)/m),
          signal("command:app-server", /(?:^|\s)app-server(?:\s|$)/m),
        ]),
      }),
      Object.freeze({
        name: "execution-help",
        arguments: Object.freeze(["exec", "--help"]),
        signals: Object.freeze([
          signal("execution:non-interactive", /run codex non-interactively/i),
          signal("events:json", /--json\b/i),
          signal("output:schema", /--output-schema\b/i),
          signal("output:color", /--color\b/i),
          signal("execution:sandbox-option", /--sandbox\b/i),
          signal("execution:skip-git-check", /--skip-git-repo-check\b/i),
          signal("binding:cwd-option", /--cd\b/i),
          signal("session:ephemeral", /--ephemeral\b/i),
          signal("session:resume", /(?:^|\s)resume(?:\s|$)/m),
        ]),
      }),
      Object.freeze({
        name: "machine-protocol-help",
        arguments: Object.freeze(["app-server", "--help"]),
        signals: Object.freeze([
          signal("transport:stdio", /stdio:\/\//i),
          signal("protocol:schema-generation", /generate-json-schema/i),
          signal("transport:listen-option", /--listen\b/i),
        ]),
      }),
    ]),
    capabilities: Object.freeze([
      Object.freeze({ name: "non-interactive-execution", requirements: Object.freeze(["execution:non-interactive", "events:json", "output:schema", "session:ephemeral"]) }),
      Object.freeze({ name: "structured-event-stream", requirements: Object.freeze(["events:json"]) }),
      Object.freeze({ name: "one-shot-invocation-surface", requirements: Object.freeze(["events:json", "output:schema", "output:color", "execution:sandbox-option", "execution:skip-git-check", "binding:cwd-option", "session:ephemeral"]) }),
      Object.freeze({ name: "provider-session-resume-surface", requirements: Object.freeze(["session:resume"]) }),
      Object.freeze({ name: "stdio-app-server-protocol", requirements: Object.freeze(["transport:stdio", "protocol:schema-generation", "transport:listen-option"]) }),
      Object.freeze({ name: "stdio-mcp-server-command", requirements: Object.freeze(["command:mcp-server"]) }),
    ]),
    requiredForNegotiation: Object.freeze(["non-interactive-execution", "structured-event-stream", "stdio-app-server-protocol"]),
  }),
  opencode: Object.freeze({
    probes: Object.freeze([
      Object.freeze({
        name: "root-help",
        arguments: Object.freeze(["--help"]),
        signals: Object.freeze([
          signal("command:run", /opencode run(?:\s|$)/m),
          signal("command:acp", /opencode acp(?:\s|$)/m),
          signal("command:serve", /opencode serve(?:\s|$)/m),
          signal("command:session", /opencode session(?:\s|$)/m),
        ]),
      }),
      Object.freeze({
        name: "execution-help",
        arguments: Object.freeze(["run", "--help"]),
        signals: Object.freeze([
          signal("execution:non-interactive", /run opencode with a message/i),
          signal("events:format-option", /--format\b/i),
          signal("events:json", /choices:[^\r\n]*[\"']?json[\"']?/i),
          signal("execution:pure", /--pure\b/i),
          signal("binding:dir-option", /--dir\b/i),
          signal("session:title-option", /--title\b/i),
          signal("session:resume", /--session\b/i),
          signal("session:continue", /--continue\b/i),
        ]),
      }),
      Object.freeze({
        name: "machine-protocol-help",
        arguments: Object.freeze(["acp", "--help"]),
        signals: Object.freeze([
          signal("protocol:agent-client", /agent client protocol/i),
          signal("binding:cwd-option", /--cwd\b/i),
          signal("transport:port-option", /--port\b/i),
        ]),
      }),
    ]),
    capabilities: Object.freeze([
      Object.freeze({ name: "non-interactive-execution", requirements: Object.freeze(["execution:non-interactive", "events:format-option", "events:json"]) }),
      Object.freeze({ name: "structured-event-stream", requirements: Object.freeze(["events:format-option", "events:json"]) }),
      Object.freeze({ name: "one-shot-invocation-surface", requirements: Object.freeze(["execution:non-interactive", "events:json", "execution:pure", "binding:dir-option", "session:title-option"]) }),
      Object.freeze({ name: "provider-session-resume-surface", requirements: Object.freeze(["session:resume", "session:continue"]) }),
      Object.freeze({ name: "agent-client-protocol-server", requirements: Object.freeze(["protocol:agent-client", "binding:cwd-option"]) }),
      Object.freeze({ name: "headless-server-command", requirements: Object.freeze(["command:serve"]) }),
    ]),
    requiredForNegotiation: Object.freeze(["non-interactive-execution", "structured-event-stream", "agent-client-protocol-server"]),
  }),
});

function publicProbeProfile(runtime, probe) {
  return {
    name: probe.name,
    argumentProfile: `${runtime}-${probe.name}-fixed-help-v1`,
    argumentDigest: digest(canonicalJson(probe.arguments)),
    knownSignals: probe.signals.map((item) => item.name).sort(compareText),
  };
}

function publicRuntimeProfile(runtime) {
  const profile = RUNTIME_PROFILES[runtime];
  return {
    runtime,
    probes: profile.probes.map((probe) => publicProbeProfile(runtime, probe)),
    capabilities: profile.capabilities.map((item) => ({ name: item.name, requirements: [...item.requirements] })),
    requiredForNegotiation: [...profile.requiredForNegotiation],
  };
}

function emptyProbeOutcome(runtime, probe, status) {
  const profile = publicProbeProfile(runtime, probe);
  return {
    ...profile,
    status,
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
    observedSignals: [],
    missingSignals: [...profile.knownSignals],
  };
}

function runExactHelpChild({ executablePath, arguments: args, cwd, environment, spawnImplementation = spawn }) {
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

    const finish = (exitCode, childSignal) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (forceHandle) clearTimeout(forceHandle);
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      const output = Buffer.concat([stdoutBuffer, Buffer.from([0]), stderrBuffer]);
      const status = spawnError ? "spawn-failed"
        : timedOut ? "timed-out"
          : outputLimited ? "output-limit"
            : exitCode !== 0 ? "nonzero-exit"
              : stdoutBytes + stderrBytes === 0 ? "empty-output" : "verified";
      resolve({
        outcome: {
          status,
          exitCode: Number.isInteger(exitCode) ? exitCode : null,
          signal: childSignal ? String(childSignal).slice(0, 32) : "none",
          timedOut,
          outputLimited,
          stdoutBytes,
          stderrBytes,
          outputDigest: digest(output),
          childStarted: Boolean(child?.pid),
          childExitObserved: Boolean(child?.pid),
          terminationRequested,
          exactChildOwnership: Boolean(child?.pid),
        },
        text: `${stdoutBuffer.toString("utf8")}\n${stderrBuffer.toString("utf8")}`.replaceAll("\0", ""),
      });
    };

    try {
      child = spawnImplementation(executablePath, args, {
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
    }, PROBE_TIMEOUT_MS);
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
  ], "Runtime protocol executable observation");
  if (document.runtime !== runtime
    || !["candidate-found", "not-found"].includes(document.availability)
    || !["native-executable", "command-shim", "extensionless-candidate", "none"].includes(document.launcherKind)
    || typeof document.directSpawnSafe !== "boolean" || typeof document.symbolicLink !== "boolean"
    || !Number.isSafeInteger(document.byteLength) || document.byteLength < 0
    || (document.availability === "candidate-found" && (!/^[a-f0-9]{64}$/.test(document.pathDigest)
      || !/^[a-f0-9]{64}$/.test(document.canonicalPathDigest) || document.byteLength < 1))
    || (document.availability === "not-found" && (document.pathDigest !== "" || document.canonicalPathDigest !== ""
      || document.byteLength !== 0 || document.launcherKind !== "none" || document.directSpawnSafe))) {
    fail("Runtime protocol executable observation is invalid.", "INVALID_RUNTIME_PROTOCOL_EXECUTABLE_OBSERVATION");
  }
}

function validateProbeOutcome(document, runtime, probe) {
  assertFields(document, [
    "name", "argumentProfile", "argumentDigest", "knownSignals", "status", "exitCode", "signal", "timedOut",
    "outputLimited", "stdoutBytes", "stderrBytes", "outputDigest", "childStarted", "childExitObserved",
    "terminationRequested", "exactChildOwnership", "observedSignals", "missingSignals",
  ], "Runtime protocol probe outcome");
  const expected = publicProbeProfile(runtime, probe);
  const statuses = ["not-found", "unsafe-launcher", "spawn-failed", "timed-out", "output-limit", "nonzero-exit", "empty-output", "verified"];
  const observed = [...new Set(document.observedSignals)].sort(compareText);
  const missing = [...new Set(document.missingSignals)].sort(compareText);
  if (document.name !== expected.name || document.argumentProfile !== expected.argumentProfile
    || document.argumentDigest !== expected.argumentDigest || canonicalJson(document.knownSignals) !== canonicalJson(expected.knownSignals)
    || !statuses.includes(document.status) || (document.exitCode !== null && !Number.isInteger(document.exitCode))
    || typeof document.signal !== "string" || document.signal.length > 32
    || typeof document.timedOut !== "boolean" || typeof document.outputLimited !== "boolean"
    || !Number.isSafeInteger(document.stdoutBytes) || document.stdoutBytes < 0
    || !Number.isSafeInteger(document.stderrBytes) || document.stderrBytes < 0
    || !/^[a-f0-9]{64}$/.test(document.outputDigest)
    || typeof document.childStarted !== "boolean" || typeof document.childExitObserved !== "boolean"
    || typeof document.terminationRequested !== "boolean" || typeof document.exactChildOwnership !== "boolean"
    || document.childStarted !== document.childExitObserved || document.childStarted !== document.exactChildOwnership
    || canonicalJson(observed) !== canonicalJson(document.observedSignals)
    || canonicalJson(missing) !== canonicalJson(document.missingSignals)
    || canonicalJson([...observed, ...missing].sort(compareText)) !== canonicalJson(expected.knownSignals)
    || observed.some((item) => missing.includes(item))
    || (document.status !== "verified" && observed.length > 0)) {
    fail("Runtime protocol probe outcome is invalid.", "INVALID_RUNTIME_PROTOCOL_PROBE_OUTCOME");
  }
}

function capabilitiesFromOutcomes(runtime, outcomes) {
  const observedSignals = new Set(outcomes.flatMap((item) => item.observedSignals));
  return RUNTIME_PROFILES[runtime].capabilities.map((capability) => ({
    capability: capability.name,
    support: capability.requirements.every((item) => observedSignals.has(item)) ? "observed" : "not-observed",
    requiredSignals: [...capability.requirements],
    controlEnabled: false,
  }));
}

function protocolNegotiationObserved(runtime, capabilities) {
  const support = new Map(capabilities.map((item) => [item.capability, item.support]));
  return RUNTIME_PROFILES[runtime].requiredForNegotiation.every((item) => support.get(item) === "observed");
}

export class BoundedProtocolWorkspaceHostAdapter {
  constructor({ spawnImplementation = spawn } = {}) { this.spawnImplementation = spawnImplementation; }
  describe() {
    return {
      adapterKind: "native-process-bounded-protocol-observation",
      workspaceHost: "native-process",
      exactChildOwnership: true,
      shellInterpretation: false,
      providerSessionCreated: false,
      runtimeControlEnabled: false,
    };
  }
  executeHelpProbe({ executablePath, arguments: args, cwd, environment }) {
    return runExactHelpChild({ executablePath, arguments: args, cwd, environment, spawnImplementation: this.spawnImplementation });
  }
  attach() { return disabledOperation("WorkspaceHostAdapter", "attach"); }
  send() { return disabledOperation("WorkspaceHostAdapter", "send"); }
  receive() { return disabledOperation("WorkspaceHostAdapter", "receive"); }
  detach() { return disabledOperation("WorkspaceHostAdapter", "detach"); }
}

export class BoundedProtocolPlatformAdapter {
  constructor({
    platform = process.platform,
    environment = process.env,
    fileSystem = fs,
    workspaceHostAdapter = new BoundedProtocolWorkspaceHostAdapter(),
  } = {}) {
    this.platform = normalizePlatform(platform);
    this.environment = environment;
    this.fileSystem = fileSystem;
    this.workspaceHostAdapter = workspaceHostAdapter;
  }
  describe() {
    return {
      adapterKind: `${this.platform}-bounded-protocol-observation`,
      platform: this.platform,
      machineInterface: "direct-child-process-fixed-help",
      shellInterpretation: false,
      runtimeControlEnabled: false,
    };
  }
  resolveTarget(runtime) {
    return resolveReadOnlyRuntimeExecutableTarget({
      runtime,
      platform: this.platform,
      environment: this.environment,
      fileSystem: this.fileSystem,
    });
  }
  invokeHelp({ executablePath, arguments: args, cwd }) {
    return this.workspaceHostAdapter.executeHelpProbe({ executablePath, arguments: args, cwd, environment: this.environment });
  }
  spawnOwned() { return disabledOperation("PlatformAdapter", "spawn-owned-control"); }
  inspectOwned() { return disabledOperation("PlatformAdapter", "inspect-owned-control"); }
  terminateOwned() { return disabledOperation("PlatformAdapter", "terminate-owned-control"); }
}

export class BoundedProtocolAgentRuntimeAdapter {
  constructor({ runtime, platformAdapter } = {}) {
    this.runtime = normalizeRuntime(runtime);
    if (!(platformAdapter instanceof BoundedProtocolPlatformAdapter)) {
      fail("BoundedProtocolAgentRuntimeAdapter requires a BoundedProtocolPlatformAdapter.", "INVALID_RUNTIME_PROTOCOL_ADAPTER");
    }
    this.platformAdapter = platformAdapter;
  }
  describe() {
    return {
      adapterKind: `${this.runtime}-bounded-protocol-observation`,
      runtime: this.runtime,
      interfaceMode: "fixed-help-capability-observation",
      providerSessionCreated: false,
      runtimeControlEnabled: false,
    };
  }
  async probeCapabilities({ versionObservation } = {}) {
    const target = this.platformAdapter.resolveTarget(this.runtime);
    if (canonicalJson(target.observation) !== canonicalJson(versionObservation?.executable)) {
      fail("Runtime executable changed between version and protocol observation.", "RUNTIME_PROTOCOL_EXECUTABLE_DRIFT");
    }
    const profile = RUNTIME_PROFILES[this.runtime];
    const neutralCwd = target.executablePath ? path.parse(target.executablePath).root : null;
    const outcomes = [];
    for (const probe of profile.probes) {
      if (target.observation.availability !== "candidate-found") {
        outcomes.push(emptyProbeOutcome(this.runtime, probe, "not-found"));
        continue;
      }
      if (!target.observation.directSpawnSafe) {
        outcomes.push(emptyProbeOutcome(this.runtime, probe, "unsafe-launcher"));
        continue;
      }
      const execution = await this.platformAdapter.invokeHelp({
        executablePath: target.executablePath,
        arguments: probe.arguments,
        cwd: neutralCwd,
      });
      const knownSignals = probe.signals.map((item) => item.name).sort(compareText);
      const observedSignals = execution.outcome.status === "verified"
        ? probe.signals.filter((item) => item.pattern.test(execution.text)).map((item) => item.name).sort(compareText)
        : [];
      const observedSet = new Set(observedSignals);
      outcomes.push({
        ...publicProbeProfile(this.runtime, probe),
        ...execution.outcome,
        observedSignals,
        missingSignals: knownSignals.filter((item) => !observedSet.has(item)),
      });
    }
    const capabilities = capabilitiesFromOutcomes(this.runtime, outcomes);
    const payload = {
      schemaVersion: 1,
      kind: "RuntimeProtocolCapabilityObservation",
      protocolVersion: RUNTIME_PROTOCOL_EVIDENCE_VERSION,
      runtime: this.runtime,
      platform: this.platformAdapter.platform,
      versionObservationId: versionObservation.observationId,
      executable: target.observation,
      profile: publicRuntimeProfile(this.runtime),
      probeOutcomes: outcomes,
      capabilities,
      protocolNegotiationObserved: protocolNegotiationObserved(this.runtime, capabilities),
      providerSessionCreated: false,
      projectContentPassed: false,
      shellInterpretation: false,
      tuiScraping: false,
      authority: "operational-observation-only",
      instructionAuthority: false,
      promotionAuthority: false,
      controlAuthority: false,
      mutatesCanon: false,
    };
    return verifyRuntimeProtocolCapabilityObservation(identify(
      payload,
      "runtime-protocol-observation",
      "observationId",
      "observationHash",
    ));
  }
  start() { return disabledOperation("AgentRuntimeAdapter", "start"); }
  resume() { return disabledOperation("AgentRuntimeAdapter", "resume"); }
  stream() { return disabledOperation("AgentRuntimeAdapter", "stream"); }
  interrupt() { return disabledOperation("AgentRuntimeAdapter", "interrupt"); }
  close() { return disabledOperation("AgentRuntimeAdapter", "close"); }
}

export function verifyRuntimeProtocolCapabilityObservation(document) {
  assertFields(document, [
    "schemaVersion", "kind", "protocolVersion", "runtime", "platform", "versionObservationId", "executable",
    "profile", "probeOutcomes", "capabilities", "protocolNegotiationObserved", "providerSessionCreated",
    "projectContentPassed", "shellInterpretation", "tuiScraping", "authority", "instructionAuthority",
    "promotionAuthority", "controlAuthority", "mutatesCanon", "observationId", "observationHash",
  ], "Runtime protocol capability observation");
  const runtime = normalizeRuntime(document.runtime);
  const platform = normalizePlatform(document.platform);
  validateExecutableObservation(document.executable, runtime);
  if (canonicalJson(document.profile) !== canonicalJson(publicRuntimeProfile(runtime))
    || !Array.isArray(document.probeOutcomes) || document.probeOutcomes.length !== RUNTIME_PROFILES[runtime].probes.length
    || !/^runtime-version-observation-[a-f0-9]{24}$/.test(document.versionObservationId || "")) {
    fail("Runtime protocol capability observation profile is invalid.", "INVALID_RUNTIME_PROTOCOL_OBSERVATION");
  }
  document.probeOutcomes.forEach((outcome, index) => validateProbeOutcome(outcome, runtime, RUNTIME_PROFILES[runtime].probes[index]));
  const expectedCapabilities = capabilitiesFromOutcomes(runtime, document.probeOutcomes);
  const expectedNegotiation = protocolNegotiationObserved(runtime, expectedCapabilities);
  if (document.schemaVersion !== 1 || document.kind !== "RuntimeProtocolCapabilityObservation"
    || document.protocolVersion !== RUNTIME_PROTOCOL_EVIDENCE_VERSION || document.platform !== platform
    || canonicalJson(document.capabilities) !== canonicalJson(expectedCapabilities)
    || document.protocolNegotiationObserved !== expectedNegotiation
    || document.providerSessionCreated !== false || document.projectContentPassed !== false
    || document.shellInterpretation !== false || document.tuiScraping !== false
    || document.authority !== "operational-observation-only"
    || document.instructionAuthority !== false || document.promotionAuthority !== false
    || document.controlAuthority !== false || document.mutatesCanon !== false) {
    fail("Runtime protocol capability observation is invalid.", "INVALID_RUNTIME_PROTOCOL_OBSERVATION");
  }
  verifyIdentity(document, {
    prefix: "runtime-protocol-observation",
    idKey: "observationId",
    hashKey: "observationHash",
    code: "RUNTIME_PROTOCOL_OBSERVATION_DIGEST_MISMATCH",
  });
  return document;
}

export async function buildRuntimeProtocolEvidence({
  versionEvidence,
  runtimes = null,
  platform = process.platform,
  environment = process.env,
  fileSystem = fs,
  spawnImplementation = spawn,
} = {}) {
  const verifiedVersion = verifyRuntimeVersionEvidence(versionEvidence);
  const selectedRuntimes = normalizedRuntimes(runtimes ?? verifiedVersion.selectedRuntimes);
  if (canonicalJson(selectedRuntimes) !== canonicalJson(verifiedVersion.selectedRuntimes)
    || normalizePlatform(platform) !== verifiedVersion.platform) {
    fail("Runtime protocol evidence does not match version evidence.", "RUNTIME_PROTOCOL_VERSION_EVIDENCE_MISMATCH");
  }
  const workspaceHostAdapter = new BoundedProtocolWorkspaceHostAdapter({ spawnImplementation });
  const platformAdapter = new BoundedProtocolPlatformAdapter({ platform, environment, fileSystem, workspaceHostAdapter });
  const observations = [];
  for (const runtime of selectedRuntimes) {
    const versionObservation = verifiedVersion.observations.find((item) => item.runtime === runtime);
    observations.push(await new BoundedProtocolAgentRuntimeAdapter({ runtime, platformAdapter }).probeCapabilities({ versionObservation }));
  }
  const negotiatedRuntimes = observations.filter((item) => item.protocolNegotiationObserved).map((item) => item.runtime);
  const partialRuntimes = observations.filter((item) => !item.protocolNegotiationObserved).map((item) => item.runtime);
  const allRequestedProtocolsObserved = negotiatedRuntimes.length === selectedRuntimes.length;
  const payload = {
    schemaVersion: 1,
    kind: "RuntimeProtocolCapabilityEvidence",
    protocolVersion: RUNTIME_PROTOCOL_EVIDENCE_VERSION,
    versionEvidenceId: verifiedVersion.evidenceId,
    selectedRuntimes,
    platform: verifiedVersion.platform,
    platformBoundary: platformAdapter.describe(),
    workspaceHostBoundary: workspaceHostAdapter.describe(),
    observations,
    summary: {
      negotiatedRuntimes,
      partialRuntimes,
      allRequestedProtocolsObserved,
      rawPathsExposed: false,
      rawOutputExposed: false,
      rawCommandsExposed: false,
    },
    activationBoundary: {
      phase: "bounded-non-session-protocol-capability-evidence",
      actualProviderProtocolObservationValidated: allRequestedProtocolsObserved,
      actualProviderSessionControlValidated: false,
      runtimeControlEnabled: false,
      capabilityDoesNotGrantAuthorization: true,
      executionContractRequiredForControl: true,
      providerSessionCreated: false,
      projectBindingRequiredForControl: true,
      tuiScrapingAllowed: false,
    },
    authority: "operational-observation-only",
    instructionAuthority: false,
    promotionAuthority: false,
    controlAuthority: false,
    mutatesCanon: false,
  };
  return verifyRuntimeProtocolEvidence(identify(payload, "runtime-protocol-evidence", "evidenceId", "evidenceHash"));
}

export function verifyRuntimeProtocolEvidence(document) {
  assertFields(document, [
    "schemaVersion", "kind", "protocolVersion", "versionEvidenceId", "selectedRuntimes", "platform",
    "platformBoundary", "workspaceHostBoundary", "observations", "summary", "activationBoundary", "authority",
    "instructionAuthority", "promotionAuthority", "controlAuthority", "mutatesCanon", "evidenceId", "evidenceHash",
  ], "Runtime protocol capability evidence");
  assertFields(document.summary, [
    "negotiatedRuntimes", "partialRuntimes", "allRequestedProtocolsObserved", "rawPathsExposed", "rawOutputExposed",
    "rawCommandsExposed",
  ], "Runtime protocol evidence summary");
  assertFields(document.activationBoundary, [
    "phase", "actualProviderProtocolObservationValidated", "actualProviderSessionControlValidated",
    "runtimeControlEnabled", "capabilityDoesNotGrantAuthorization", "executionContractRequiredForControl",
    "providerSessionCreated", "projectBindingRequiredForControl", "tuiScrapingAllowed",
  ], "Runtime protocol activation boundary");
  const runtimes = normalizedRuntimes(document.selectedRuntimes);
  const platform = normalizePlatform(document.platform);
  const observations = document.observations.map(verifyRuntimeProtocolCapabilityObservation);
  const negotiatedRuntimes = observations.filter((item) => item.protocolNegotiationObserved).map((item) => item.runtime);
  const partialRuntimes = observations.filter((item) => !item.protocolNegotiationObserved).map((item) => item.runtime);
  const allRequestedProtocolsObserved = negotiatedRuntimes.length === runtimes.length;
  const expectedSummary = {
    negotiatedRuntimes,
    partialRuntimes,
    allRequestedProtocolsObserved,
    rawPathsExposed: false,
    rawOutputExposed: false,
    rawCommandsExposed: false,
  };
  const expectedActivation = {
    phase: "bounded-non-session-protocol-capability-evidence",
    actualProviderProtocolObservationValidated: allRequestedProtocolsObserved,
    actualProviderSessionControlValidated: false,
    runtimeControlEnabled: false,
    capabilityDoesNotGrantAuthorization: true,
    executionContractRequiredForControl: true,
    providerSessionCreated: false,
    projectBindingRequiredForControl: true,
    tuiScrapingAllowed: false,
  };
  if (document.schemaVersion !== 1 || document.kind !== "RuntimeProtocolCapabilityEvidence"
    || document.protocolVersion !== RUNTIME_PROTOCOL_EVIDENCE_VERSION
    || !/^runtime-version-evidence-[a-f0-9]{24}$/.test(document.versionEvidenceId || "")
    || canonicalJson(document.observations.map((item) => item.runtime)) !== canonicalJson(runtimes)
    || document.platform !== platform
    || canonicalJson(document.platformBoundary) !== canonicalJson(new BoundedProtocolPlatformAdapter({ platform }).describe())
    || canonicalJson(document.workspaceHostBoundary) !== canonicalJson(new BoundedProtocolWorkspaceHostAdapter().describe())
    || canonicalJson(document.summary) !== canonicalJson(expectedSummary)
    || canonicalJson(document.activationBoundary) !== canonicalJson(expectedActivation)
    || document.authority !== "operational-observation-only"
    || document.instructionAuthority !== false || document.promotionAuthority !== false
    || document.controlAuthority !== false || document.mutatesCanon !== false) {
    fail("Runtime protocol capability evidence is invalid.", "INVALID_RUNTIME_PROTOCOL_EVIDENCE");
  }
  verifyIdentity(document, {
    prefix: "runtime-protocol-evidence",
    idKey: "evidenceId",
    hashKey: "evidenceHash",
    code: "RUNTIME_PROTOCOL_EVIDENCE_DIGEST_MISMATCH",
  });
  return document;
}

export function buildRuntimeProjectBinding({
  projectId,
  headSessionId,
  projectRoot,
  projectStatus,
  versionEvidence,
  protocolEvidence,
  storage,
} = {}) {
  const format = formatForVerifiedOwner(storage);
  const version = verifyRuntimeVersionEvidence(versionEvidence);
  const protocol = verifyRuntimeProtocolEvidence(protocolEvidence);
  if (protocol.versionEvidenceId !== version.evidenceId
    || canonicalJson(protocol.selectedRuntimes) !== canonicalJson(version.selectedRuntimes)) {
    fail("Runtime project binding evidence does not compose.", "RUNTIME_PROJECT_BINDING_EVIDENCE_MISMATCH");
  }
  const bindings = protocol.observations.map((observation) => {
    const versionObservation = version.observations.find((item) => item.runtime === observation.runtime);
    return {
      runtime: observation.runtime,
      versionObservationId: versionObservation.observationId,
      protocolObservationId: observation.observationId,
      capabilityStatus: observation.protocolNegotiationObserved ? "observed" : "partial",
      providerSessionCreated: false,
      runtimeControlEnabled: false,
    };
  });
  const bindingVerified = projectStatus === "ready" && protocol.summary.allRequestedProtocolsObserved;
  const payload = {
    schemaVersion: 1,
    kind: "RuntimeProjectBinding",
    protocolVersion: RUNTIME_PROJECT_BINDING_VERSION,
    projectId,
    [format.sessionIdField]: headSessionId,
    projectRootDigest: digest(fs.realpathSync(path.resolve(projectRoot))),
    projectStatus,
    selectedRuntimes: [...protocol.selectedRuntimes],
    versionEvidenceId: version.evidenceId,
    protocolEvidenceId: protocol.evidenceId,
    bindings,
    status: bindingVerified ? (format?.value("verified-head-project-session-capability-binding") || "verified-head-project-session-capability-binding") : (format?.value("partial-head-project-session-capability-binding") || "partial-head-project-session-capability-binding"),
    bindingBoundary: {
      [format?.value("headProjectIdentityCanonical") || "headProjectIdentityCanonical"]: true,
      [format?.value("headSessionIdentityCanonical") || "headSessionIdentityCanonical"]: true,
      providerSessionIdentityCanonical: false,
      providerSessionCreated: false,
      projectContentPassed: false,
      actualProviderSessionBindingValidated: false,
      runtimeControlEnabled: false,
      executionContractRequiredForControl: true,
      callerAndChildOwnershipRequiredForControl: true,
    },
    authority: (format?.value("canonical-head-reference-with-operational-capability-evidence") || "canonical-head-reference-with-operational-capability-evidence"),
    instructionAuthority: false,
    promotionAuthority: false,
    controlAuthority: false,
    mutatesCanon: false,
  };
  return verifyRuntimeProjectBinding(identify(payload, "runtime-project-binding", "bindingId", "bindingHash"));
}

export function verifyRuntimeProjectBinding(document) {
  const format = originalFormat(document);
  assertFields(document, [
    "schemaVersion", "kind", "protocolVersion", "projectId", (format?.sessionIdField || "headSessionId"), "projectRootDigest", "projectStatus",
    "selectedRuntimes", "versionEvidenceId", "protocolEvidenceId", "bindings", "status", "bindingBoundary", "authority",
    "instructionAuthority", "promotionAuthority", "controlAuthority", "mutatesCanon", "bindingId", "bindingHash",
  ], "Runtime project binding");
  assertFields(document.bindingBoundary, [
    (format?.value("headProjectIdentityCanonical") || "headProjectIdentityCanonical"), (format?.value("headSessionIdentityCanonical") || "headSessionIdentityCanonical"), "providerSessionIdentityCanonical",
    "providerSessionCreated", "projectContentPassed", "actualProviderSessionBindingValidated", "runtimeControlEnabled",
    "executionContractRequiredForControl", "callerAndChildOwnershipRequiredForControl",
  ], "Runtime project binding boundary");
  const runtimes = normalizedRuntimes(document.selectedRuntimes);
  if (!Array.isArray(document.bindings) || document.bindings.length !== runtimes.length) {
    fail("Runtime project binding runtime set is invalid.", "INVALID_RUNTIME_PROJECT_BINDING");
  }
  for (const [index, binding] of document.bindings.entries()) {
    assertFields(binding, [
      "runtime", "versionObservationId", "protocolObservationId", "capabilityStatus", "providerSessionCreated",
      "runtimeControlEnabled",
    ], `Runtime project binding[${index}]`);
    if (binding.runtime !== runtimes[index]
      || !/^runtime-version-observation-[a-f0-9]{24}$/.test(binding.versionObservationId || "")
      || !/^runtime-protocol-observation-[a-f0-9]{24}$/.test(binding.protocolObservationId || "")
      || !["observed", "partial"].includes(binding.capabilityStatus)
      || binding.providerSessionCreated !== false || binding.runtimeControlEnabled !== false) {
      fail("Runtime project binding entry is invalid.", "INVALID_RUNTIME_PROJECT_BINDING");
    }
  }
  const fullyObserved = document.projectStatus === "ready" && document.bindings.every((item) => item.capabilityStatus === "observed");
  const expectedBoundary = {
    [format?.value("headProjectIdentityCanonical") || "headProjectIdentityCanonical"]: true,
    [format?.value("headSessionIdentityCanonical") || "headSessionIdentityCanonical"]: true,
    providerSessionIdentityCanonical: false,
    providerSessionCreated: false,
    projectContentPassed: false,
    actualProviderSessionBindingValidated: false,
    runtimeControlEnabled: false,
    executionContractRequiredForControl: true,
    callerAndChildOwnershipRequiredForControl: true,
  };
  if (document.schemaVersion !== 1 || document.kind !== "RuntimeProjectBinding"
    || document.protocolVersion !== RUNTIME_PROJECT_BINDING_VERSION
    || (!format || !new RegExp(`^${format.projectPrefix}[a-f0-9]{20}$`).test(document.projectId || ""))
    || !/^session-[A-Fa-f0-9-]{36}$/.test(sessionIdOf(document) || "")
    || !/^[a-f0-9]{64}$/.test(document.projectRootDigest || "")
    || !["ready", "drifted"].includes(document.projectStatus)
    || !/^runtime-version-evidence-[a-f0-9]{24}$/.test(document.versionEvidenceId || "")
    || !/^runtime-protocol-evidence-[a-f0-9]{24}$/.test(document.protocolEvidenceId || "")
    || document.status !== (fullyObserved ? (format?.value("verified-head-project-session-capability-binding") || "verified-head-project-session-capability-binding") : (format?.value("partial-head-project-session-capability-binding") || "partial-head-project-session-capability-binding"))
    || canonicalJson(document.bindingBoundary) !== canonicalJson(expectedBoundary)
    || document.authority !== (format?.value("canonical-head-reference-with-operational-capability-evidence") || "canonical-head-reference-with-operational-capability-evidence")
    || document.instructionAuthority !== false || document.promotionAuthority !== false
    || document.controlAuthority !== false || document.mutatesCanon !== false) {
    fail("Runtime project binding is invalid.", "INVALID_RUNTIME_PROJECT_BINDING");
  }
  verifyIdentity(document, {
    prefix: "runtime-project-binding",
    idKey: "bindingId",
    hashKey: "bindingHash",
    code: "RUNTIME_PROJECT_BINDING_DIGEST_MISMATCH",
  });
  return document;
}

export const RUNTIME_PROTOCOL_CONTROL_METHODS = CONTROL_METHODS;
