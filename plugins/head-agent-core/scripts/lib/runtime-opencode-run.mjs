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
import { fileURLToPath } from "node:url";
import { resolveReadOnlyRuntimeExecutableTarget } from "./runtime-machine-discovery.mjs";
import { verifyRuntimeProjectBinding, verifyRuntimeProtocolEvidence } from "./runtime-protocol-evidence.mjs";
import {
  buildRuntimeInvocationCallerFence,
  buildRuntimeResultPacketDraft,
  prepareRuntimeInvocationExecution,
  verifyRuntimeInvocationAuthorization,
  verifyRuntimeStructuredResult,
  RUNTIME_STRUCTURED_RESULT_VERSION,
} from "./runtime-invocation-lifecycle.mjs";
import { persistRuntimeInvocationRecord } from "./runtime-invocation-record.mjs";
import {
  verifyRuntimeExecutionLeaseOwnership,
  withRuntimeExecutionLease,
  recordRuntimeInvocationStartFailure,
} from "./runtime-execution-lease.mjs";
import { resolveVerifiedProcessSupervisor } from "./runtime-process-supervisor.mjs";
import { runSupervisedRuntimeOneShot } from "./runtime-supervised-one-shot.mjs";

export const OPENCODE_RUN_PROVIDER_VERSION = "0.2.0";
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const fail = (message, code = "OPENCODE_RUN_PROVIDER_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

const canonicalJson = (value) => JSON.stringify(canonicalValue(value));

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function permissionPolicy(workspaceMode) {
  const base = {
    "*": "deny",
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    external_directory: "deny",
    bash: "deny",
    task: "deny",
    skill: "deny",
    webfetch: "deny",
    websearch: "deny",
    codesearch: "deny",
  };
  if (workspaceMode === "workspace-write") {
    return { ...base, edit: "allow", write: "allow", patch: "allow", multiedit: "allow" };
  }
  return { ...base, edit: "deny", write: "deny", patch: "deny", multiedit: "deny" };
}

export function buildOpenCodeProviderEnvironment(environment, workspaceMode, model) {
  const separator = typeof model === "string" ? model.indexOf("/") : -1;
  const providerId = separator > 0 ? model.slice(0, separator) : "";
  const providerEnvironmentPrefix = providerId ? providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_") : "";
  const providerApiKeyName = providerEnvironmentPrefix ? `${providerEnvironmentPrefix}_API_KEY` : "";
  const providerBaseUrlName = providerEnvironmentPrefix ? `${providerEnvironmentPrefix}_BASE_URL` : "";
  const selectedProviderEnvironmentNames = new Set([providerApiKeyName, providerBaseUrlName].filter(Boolean));
  const fixedNames = new Set([
    "appdata", "comspec", "home", "homedrive", "homepath", "http_proxy", "https_proxy", "lang", "lc_all",
    "localappdata", "no_proxy", "path", "ssl_cert_dir", "ssl_cert_file", "systemroot", "temp", "tmp", "userprofile", "windir",
  ]);
  const result = {};
  for (const [key, value] of Object.entries(environment || {})) {
    const normalized = key.toLowerCase();
    if ((fixedNames.has(normalized) || selectedProviderEnvironmentNames.has(key))
      && typeof value === "string") result[key] = value;
  }
  const permission = permissionPolicy(workspaceMode);
  result.CI = "1";
  result.NO_COLOR = "1";
  result.TERM = "dumb";
  result.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  result.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1";
  result.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1";
  result.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1";
  result.OPENCODE_PURE = "1";
  result.OPENCODE_PERMISSION = canonicalJson(permission);
  result.OPENCODE_CONFIG_CONTENT = canonicalJson({
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    permission,
  });
  return result;
}

function operationalProviderDirectory(operationalStateRoot, authorization) {
  const directory = path.join(
    operationalStateRoot,
    "runtime-provider-invocations",
    authorization.projectId,
    authorization.authorizationId,
  );
  if (!isWithin(operationalStateRoot, directory) || directory === operationalStateRoot) {
    fail("OpenCode operational invocation directory escaped its host-local root.", "UNSAFE_OPENCODE_OPERATIONAL_STATE");
  }
  return directory;
}

function createOperationalControlState(operationalStateRoot, authorization) {
  const directory = operationalProviderDirectory(operationalStateRoot, authorization);
  fs.mkdirSync(directory, { recursive: true });
  for (const item of [
    path.join(operationalStateRoot, "runtime-provider-invocations"),
    path.join(operationalStateRoot, "runtime-provider-invocations", authorization.projectId),
    directory,
  ]) {
    const stat = fs.lstatSync(item);
    const resolved = fs.realpathSync(item);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isWithin(operationalStateRoot, resolved)) {
      fail("OpenCode operational invocation path is unsafe.", "UNSAFE_OPENCODE_OPERATIONAL_STATE");
    }
  }
  return { directory, controlFile: path.join(directory, "supervisor-control.jsonl") };
}

function removeOperationalControlState(operationalStateRoot, authorization, state) {
  if (!state) return;
  const expected = operationalProviderDirectory(operationalStateRoot, authorization);
  const resolved = fs.realpathSync(state.directory);
  if (resolved !== expected || !isWithin(operationalStateRoot, resolved)) {
    fail("Refusing unsafe OpenCode operational cleanup.", "UNSAFE_OPENCODE_OPERATIONAL_STATE");
  }
  const entries = fs.readdirSync(resolved).sort(compareText);
  const expectedEntries = fs.existsSync(state.controlFile) ? ["supervisor-control.jsonl"] : [];
  if (canonicalJson(entries) !== canonicalJson(expectedEntries)) {
    fail("OpenCode operational invocation directory contains unexpected files.", "UNSAFE_OPENCODE_OPERATIONAL_STATE");
  }
  if (fs.existsSync(state.controlFile)) fs.unlinkSync(state.controlFile);
  fs.rmdirSync(resolved);
  for (const parent of [path.dirname(resolved), path.join(operationalStateRoot, "runtime-provider-invocations")]) {
    if (!fs.existsSync(parent) || fs.readdirSync(parent).length) break;
    const stat = fs.lstatSync(parent);
    const canonical = fs.realpathSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isWithin(operationalStateRoot, canonical) || canonical === operationalStateRoot) {
      fail("OpenCode operational parent cleanup is unsafe.", "UNSAFE_OPENCODE_OPERATIONAL_STATE");
    }
    fs.rmdirSync(canonical);
  }
}

function opencodeArguments({ projectRoot, model }) {
  return [
    "run", "--format", "json", "--pure", "--dir", projectRoot,
    ...(model ? ["--model", model] : []),
    "--title", "HEAD Agent invocation",
  ];
}

function parseStructuredText(value, scopeKind) {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  const candidate = fenced ? fenced[1] : trimmed;
  let document;
  try { document = JSON.parse(candidate); }
  catch { return null; }
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  try { return verifyRuntimeStructuredResult(document, { scopeKind }); }
  catch {}
  const normalized = {
    schemaVersion: 1,
    kind: "RuntimeStructuredResult",
    protocolVersion: RUNTIME_STRUCTURED_RESULT_VERSION,
    outcome: document.outcome,
    evidence: document.evidence,
    planDelta: scopeKind === "session" ? "" : document.planDelta,
    impactRadius: scopeKind === "session" ? [] : document.impactRadius,
    verification: document.verification,
    unknowns: document.unknowns,
  };
  try { return verifyRuntimeStructuredResult(normalized, { scopeKind }); }
  catch { return null; }
}

export function extractOpenCodeStructuredResult(record, { scopeKind = null } = {}) {
  if (record?.type !== "text" || record?.part?.type !== "text") return null;
  return parseStructuredText(record.part.text, scopeKind);
}

const OPENCODE_DIAGNOSTIC_RULES = Object.freeze([
  Object.freeze({ code: "opencode.authentication", pattern: /authentication|unauthorized|not logged in|api key|\b401\b|\b403\b/ }),
  Object.freeze({ code: "opencode.rate-limit", pattern: /rate limit|quota|\b429\b/ }),
  Object.freeze({ code: "opencode.transport", pattern: /network|connection|connect|dns|proxy|tls|certificate|stream disconnected|timed? out/ }),
  Object.freeze({ code: "opencode.model-unavailable", pattern: /model.{0,48}(not found|unsupported|unavailable)|unsupported.{0,24}model/ }),
  Object.freeze({ code: "opencode.context-limit", pattern: /context.{0,32}(length|window|limit)|too many tokens|maximum context/ }),
  Object.freeze({ code: "opencode.permission", pattern: /permission.{0,32}(denied|rejected|required)|access denied|permission denied/ }),
]);

export function classifyOpenCodeProviderDiagnostics({ record = null, stderr = "", exitCode = null,
  structuredResultObserved = null, eventTypes = [] } = {}) {
  const codes = new Set();
  const type = record && typeof record === "object" && !Array.isArray(record)
    ? String(record.type || record.eventType || record.kind || "").trim().toLowerCase() : "";
  const sources = [];
  if (/error|fail/.test(type)) sources.push(canonicalJson(record).toLowerCase());
  if (typeof stderr === "string" && stderr.trim()) sources.push(stderr.slice(0, 512 * 1024).toLowerCase());
  for (const source of sources) {
    for (const rule of OPENCODE_DIAGNOSTIC_RULES) if (rule.pattern.test(source)) codes.add(rule.code);
  }
  if (type === "error" || eventTypes.includes("error")) codes.add("opencode.provider-error");
  if (Number.isInteger(exitCode) && exitCode !== 0) codes.add("opencode.nonzero-exit");
  if (structuredResultObserved === false && Number.isInteger(exitCode) && exitCode !== 0) codes.add("opencode.missing-structured-result");
  return [...codes].sort(compareText);
}

function verifyCurrentOpenCodeTarget({ authorization, protocolEvidence, projectBinding, targetResolver, platform, environment, fileSystem, requireInvocationSurface }) {
  const protocol = verifyRuntimeProtocolEvidence(protocolEvidence);
  const binding = verifyRuntimeProjectBinding(projectBinding);
  if (authorization.runtime !== "opencode") fail("OpenCode run requires an OpenCode authorization.", "OPENCODE_AUTHORIZATION_REQUIRED");
  if (protocol.evidenceId !== authorization.runtimeProtocolEvidenceId
    || binding.bindingId !== authorization.runtimeProjectBindingId
    || binding.protocolEvidenceId !== protocol.evidenceId
    || binding.projectId !== authorization.projectId
    || sessionIdOf(binding) !== sessionIdOf(authorization)) {
    fail("OpenCode capability and project binding changed after authorization.", "OPENCODE_RUN_CAPABILITY_BINDING_DRIFT");
  }
  const observation = protocol.observations.find((item) => item.runtime === "opencode");
  if (!observation || observation.observationId !== authorization.runtimeProtocolObservationId || !observation.protocolNegotiationObserved) {
    fail("Authorized OpenCode protocol observation is unavailable.", "OPENCODE_RUN_PROTOCOL_NOT_VERIFIED");
  }
  const invocationSurface = observation.capabilities.find((item) => item.capability === "one-shot-invocation-surface");
  if (requireInvocationSurface && invocationSurface?.support !== "observed") {
    fail("The authorized OpenCode executable does not prove every fixed one-shot invocation option.", "OPENCODE_RUN_INVOCATION_SURFACE_NOT_VERIFIED");
  }
  const target = targetResolver({ runtime: "opencode", platform, environment, fileSystem });
  if (!target?.executablePath || !path.isAbsolute(target.executablePath)
    || canonicalJson(target.observation) !== canonicalJson(observation.executable)
    || target.observation.availability !== "candidate-found" || !target.observation.directSpawnSafe || target.observation.symbolicLink) {
    fail("OpenCode executable identity changed or is not safe for direct spawn.", "OPENCODE_RUN_EXECUTABLE_DRIFT");
  }
  return { target, observation };
}

export async function executeOpenCodeRuntimeInvocation({
  root = ".",
  authorization,
  sessionRequest = "",
  protocolEvidence,
  projectBinding,
  signal = null,
  platform = process.platform,
  environment = process.env,
  fileSystem = fs,
  spawnImplementation = spawn,
  targetResolver = resolveReadOnlyRuntimeExecutableTarget,
  supervisorSelection = null,
  providerArguments = null,
  onProcessEvent = () => {},
  evidenceMode = "actual-provider",
  persist = true,
} = {}, { preConsumeGate = null } = {}) {
  const verified = verifyRuntimeInvocationAuthorization(authorization);
  if (verified.workerInput?.executionBoundary) fail("Selected-workspace execution requires a verified policy adapter; this attached adapter cannot fall back to the canonical root.", "WORKER_JOB_POLICY_UNAVAILABLE");
  if (!new Set(["actual-provider", "protocol-fixture"]).has(evidenceMode)) fail("OpenCode execution evidence mode is invalid.", "INVALID_OPENCODE_RUN_EVIDENCE_MODE");
  const prepared = prepareRuntimeInvocationExecution({ root, authorization: verified, sessionRequest });
  const { target } = verifyCurrentOpenCodeTarget({
    authorization: verified,
    protocolEvidence,
    projectBinding,
    targetResolver,
    platform,
    environment,
    fileSystem,
    requireInvocationSurface: evidenceMode === "actual-provider",
  });
  if (evidenceMode === "actual-provider" && providerArguments !== null) {
    fail("Actual OpenCode execution arguments cannot be replaced.", "OPENCODE_RUN_ARGUMENT_OVERRIDE_REJECTED");
  }
  const selectedProviderEnvironment = buildOpenCodeProviderEnvironment(
    environment,
    verified.workspaceMode,
    verified.runtimeSelection?.model || null,
  );
  const selectedSupervisor = supervisorSelection || resolveVerifiedProcessSupervisor({ pluginRoot });
  const callerFenceDigest = buildRuntimeInvocationCallerFence(prepared.projectRoot, verified.authorizationId);
  const providerMode = evidenceMode === "actual-provider" ? "actual-opencode" : "opencode-protocol-fixture";
  const leased = await withRuntimeExecutionLease({
    projectRoot: prepared.projectRoot,
    authorization: verified,
    ownerFenceDigest: callerFenceDigest,
  }, async ({ lease, consumption, operationalStateRoot }) => {
    verifyRuntimeExecutionLeaseOwnership({
      projectRoot: prepared.projectRoot,
      operationalStateRoot,
      authorization: verified,
      lease,
      consumption,
    });
    let controlState;
    try {
      controlState = createOperationalControlState(operationalStateRoot, verified);
      return await runSupervisedRuntimeOneShot({
        runtime: "opencode",
        operationalStateRoot,
        onNeverStarted: (errorCode) => recordRuntimeInvocationStartFailure({ projectRoot: prepared.projectRoot, authorization: verified, lease, consumption, errorCode }),
        executablePath: target.executablePath,
        args: providerArguments === null ? opencodeArguments({
          projectRoot: prepared.projectRoot,
          model: verified.runtimeSelection?.model || null,
        }) : providerArguments,
        projectRoot: prepared.projectRoot,
        providerEnvironment: selectedProviderEnvironment,
        authorization: verified,
        input: prepared.input,
        consumption,
        callerFenceDigest,
        signal,
        spawnImplementation,
        onProcessEvent,
        providerMode,
        sensitiveRoots: [prepared.projectRoot, operationalStateRoot],
        supervisorSelection: selectedSupervisor,
        supervisorControlFile: controlState.controlFile,
        commandLabel: "opencode run",
        spawnFailureCode: "OPENCODE_RUN_SPAWN_FAILED",
        classifyProviderDiagnostics: classifyOpenCodeProviderDiagnostics,
        extractStructuredResult: extractOpenCodeStructuredResult,
        completionEventTypes: ["step_finish"],
      });
    } finally {
      removeOperationalControlState(operationalStateRoot, verified, controlState);
    }
  }, { preConsumeGate });
  const draft = buildRuntimeResultPacketDraft({
    authorization: verified,
    receipt: leased.result.receipt,
    leaseRelease: leased.release,
    providerResult: leased.result.providerResult,
  });
  const record = persist
    ? persistRuntimeInvocationRecord({ projectRoot: prepared.projectRoot, authorization: verified, events: leased.result.events, receipt: leased.result.receipt, draft })
    : { recorded: false, eventCount: leased.result.events.length, receiptId: leased.result.receipt.receiptId, draftId: draft.draftId };
  return {
    status: leased.result.receipt.status === "completed" ? "provider_invocation_completed" : "provider_invocation_finished_with_evidence",
    authorizationId: verified.authorizationId,
    scopeKind: verified.scope.kind,
    runtime: "opencode",
    providerMode,
    actualProviderInvoked: leased.result.receipt.providerBoundary.actualProviderInvoked,
    descendantTreeOwnershipValidated: leased.result.receipt.processBoundary.descendantTreeOwnershipValidated,
    receipt: leased.result.receipt,
    draft,
    executionLease: { consumption: leased.consumption, release: leased.release },
    record,
  };
}
