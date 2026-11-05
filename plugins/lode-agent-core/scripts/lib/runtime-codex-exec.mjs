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
  createRuntimePreConsumeGateCapability,
} from "./runtime-execution-lease.mjs";
import {
  resolveVerifiedProcessSupervisor,
} from "./runtime-process-supervisor.mjs";
import { runSupervisedRuntimeOneShot } from "./runtime-supervised-one-shot.mjs";
import { inspectCodexWorkerPolicyCapability, verifyCodexWorkerPolicyCapability, withCodexWorkerPolicyCapability } from "./runtime-codex-worker-policy.mjs";
import { inspectCodexNativeForkHost, verifyCodexNativeForkHostBinding, runCodexNativeFork } from "./runtime-codex-native-fork.mjs";

export const CODEX_EXEC_PROVIDER_VERSION = "0.2.0";
export const CODEX_EXEC_WIRE_SCHEMA_VERSION = "0.1.0";
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const fail = (message, code = "CODEX_EXEC_PROVIDER_ERROR") => {
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
const prettyJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

export const CODEX_EXEC_RESULT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "kind", "protocolVersion", "outcome", "evidence", "planDelta", "impactRadius", "verification", "unknowns"],
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    kind: { type: "string", enum: ["RuntimeStructuredResult"] },
    protocolVersion: { type: "string", enum: [RUNTIME_STRUCTURED_RESULT_VERSION] },
    outcome: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    planDelta: { type: "string" },
    impactRadius: { type: "array", items: { type: "string" } },
    verification: { type: "array", items: { type: "string" } },
    unknowns: { type: "array", items: { type: "string" } },
  },
});

// Scope comes from the verified authorization, never from model output. Keep
// Run deltas intact; Session's empty values are mandatory, not sample output.
export function buildCodexExecWireResultSchema(scopeKind, schema = CODEX_EXEC_RESULT_SCHEMA) {
  if (!["session", "run"].includes(scopeKind)) fail("Exact execution scope is required.", "INVALID_CODEX_EXEC_WIRE_SCHEMA");
  verifyCodexExecWireResultSchema(schema);
  const result = structuredClone(schema);
  if (scopeKind === "session") {
    result.properties.planDelta = { type: "string", enum: [""], description: "Session fixed value: empty string. Report local changes in outcome and evidence." };
    result.properties.impactRadius = { type: "array", items: { type: "string" }, maxItems: 0,
      description: "Session fixed value: empty array. Report local effects in outcome and evidence, not this Run-only field." };
  }
  return verifyCodexExecWireResultSchema(result);
}

const NON_PORTABLE_WIRE_SCHEMA_KEYWORDS = new Set([
  "$schema", "allOf", "dependentRequired", "dependentSchemas", "else", "format", "if", "maxItems",
  "maxLength", "maximum", "minItems", "minLength", "minimum", "multipleOf", "not", "pattern",
  "patternProperties", "then",
]);

export function verifyCodexExecWireResultSchema(schema = CODEX_EXEC_RESULT_SCHEMA) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)
    || schema.type !== "object" || schema.additionalProperties !== false
    || !schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)
    || !Array.isArray(schema.required)
    || canonicalJson([...schema.required].sort(compareText)) !== canonicalJson(Object.keys(schema.properties).sort(compareText))) {
    fail("Codex exec wire schema does not satisfy the fixed Structured Outputs object boundary.", "INVALID_CODEX_EXEC_WIRE_SCHEMA");
  }
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (NON_PORTABLE_WIRE_SCHEMA_KEYWORDS.has(key)) {
        // Stock Structured Outputs supports array maxItems. Only the exact
        // empty-array Session contract is needed here; retain other portability
        // fences. Core still independently validates the unmodified response.
        if (key === "maxItems" && value.type === "array" && item === 0) continue;
        fail(`Codex exec wire schema uses the non-portable ${key} keyword.`, "INVALID_CODEX_EXEC_WIRE_SCHEMA");
      }
      visit(item);
    }
  };
  visit(schema);
  return schema;
}

function providerEnvironment(environment = process.env) {
  const allowed = new Set([
    "appdata", "codex_api_key", "codex_home", "comspec", "home", "homedrive", "homepath",
    "http_proxy", "https_proxy", "lang", "lc_all", "localappdata", "no_proxy", "openai_api_key",
    "path", "ssl_cert_dir", "ssl_cert_file", "systemroot", "temp", "tmp", "userprofile", "windir",
  ]);
  const result = {};
  for (const [key, value] of Object.entries(environment || {})) {
    if (allowed.has(key.toLowerCase()) && typeof value === "string") result[key] = value;
  }
  result.CI = "1";
  result.NO_COLOR = "1";
  result.TERM = "dumb";
  return result;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function operationalProviderDirectory(operationalStateRoot, authorization) {
  const directory = path.join(
    operationalStateRoot,
    "runtime-provider-invocations",
    authorization.projectId,
    authorization.authorizationId,
  );
  if (!isWithin(operationalStateRoot, directory) || directory === operationalStateRoot) {
    fail("Codex operational invocation directory escaped its host-local root.", "UNSAFE_CODEX_OPERATIONAL_STATE");
  }
  return directory;
}

function createOperationalSchemaFile(operationalStateRoot, authorization) {
  const directory = operationalProviderDirectory(operationalStateRoot, authorization);
  fs.mkdirSync(directory, { recursive: true });
  const fixed = [
    path.join(operationalStateRoot, "runtime-provider-invocations"),
    path.join(operationalStateRoot, "runtime-provider-invocations", authorization.projectId),
    directory,
  ];
  for (const item of fixed) {
    const stat = fs.lstatSync(item);
    const resolved = fs.realpathSync(item);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isWithin(operationalStateRoot, resolved)) {
      fail("Codex operational invocation path is unsafe.", "UNSAFE_CODEX_OPERATIONAL_STATE");
    }
  }
  const file = path.join(directory, "result.schema.json");
  const controlFile = path.join(directory, "supervisor-control.jsonl");
  fs.writeFileSync(file, prettyJson(buildCodexExecWireResultSchema(authorization.scope.kind)), { encoding: "utf8", flag: "wx" });
  return { directory, file, controlFile };
}

function removeOperationalSchemaFile(operationalStateRoot, authorization, state) {
  if (!state) return;
  const expected = operationalProviderDirectory(operationalStateRoot, authorization);
  const resolved = fs.realpathSync(state.directory);
  if (resolved !== expected || !isWithin(operationalStateRoot, resolved)) {
    fail("Refusing unsafe Codex operational cleanup.", "UNSAFE_CODEX_OPERATIONAL_STATE");
  }
  const entries = fs.readdirSync(resolved).sort(compareText);
  const expectedEntries = fs.existsSync(state.controlFile)
    ? ["result.schema.json", "supervisor-control.jsonl"] : ["result.schema.json"];
  if (canonicalJson(entries) !== canonicalJson(expectedEntries)) {
    fail("Codex operational invocation directory contains unexpected files.", "UNSAFE_CODEX_OPERATIONAL_STATE");
  }
  if (fs.existsSync(state.controlFile)) fs.unlinkSync(state.controlFile);
  fs.unlinkSync(state.file);
  fs.rmdirSync(resolved);
  for (const parent of [
    path.dirname(resolved),
    path.join(operationalStateRoot, "runtime-provider-invocations"),
  ]) {
    if (!fs.existsSync(parent) || fs.readdirSync(parent).length) break;
    const stat = fs.lstatSync(parent);
    const canonical = fs.realpathSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isWithin(operationalStateRoot, canonical) || canonical === operationalStateRoot) {
      fail("Codex operational parent cleanup is unsafe.", "UNSAFE_CODEX_OPERATIONAL_STATE");
    }
    fs.rmdirSync(canonical);
  }
}

function codexArguments({ projectRoot, schemaFile, workspaceMode, model, workerPolicy = null }) {
  return [
    "exec",
    "--json",
    "--ephemeral",
    ...(workerPolicy ? ["--ignore-user-config", "--ignore-rules"] : []),
    ...(model ? ["--model", model] : []),
    "--color", "never",
    "--sandbox", workspaceMode,
    "--skip-git-repo-check",
    "--cd", projectRoot,
    "--output-schema", schemaFile,
    "-",
  ];
}

function collectAgentMessageStrings(record) {
  if (record?.type !== "item.completed" || record?.item?.type !== "agent_message") return [];
  const found = [];
  const visit = (value, depth = 0) => {
    if (depth > 5 || value === null || value === undefined) return;
    if (typeof value === "string") {
      if (value.trim()) found.push(value.trim());
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 128)) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (["text", "output_text", "content", "message"].includes(key.toLowerCase())) visit(item, depth + 1);
    }
  };
  visit(record.item);
  return [...new Set(found)];
}

export function extractCodexStructuredResult(record, { scopeKind = null } = {}) {
  for (const candidate of collectAgentMessageStrings(record)) {
    try {
      return verifyRuntimeStructuredResult(JSON.parse(candidate), { scopeKind });
    } catch {}
  }
  return null;
}

const CODEX_DIAGNOSTIC_RULES = Object.freeze([
  Object.freeze({ code: "codex.structured-output-rejected", pattern: /json schema|output schema|response format|response_format|structured output|invalid schema/ }),
  Object.freeze({ code: "codex.authentication", pattern: /authentication|unauthorized|not logged in|api key|\b401\b|\b403\b/ }),
  Object.freeze({ code: "codex.rate-limit", pattern: /rate limit|quota|\b429\b/ }),
  Object.freeze({ code: "codex.transport", pattern: /network|connection|connect|dns|proxy|tls|certificate|stream disconnected|timed? out/ }),
  Object.freeze({ code: "codex.model-unavailable", pattern: /model.{0,48}(not found|unsupported|unavailable)|unsupported.{0,24}model/ }),
  Object.freeze({ code: "codex.context-limit", pattern: /context.{0,32}(length|window|limit)|too many tokens|maximum context/ }),
  Object.freeze({ code: "codex.sandbox-or-permission", pattern: /access denied|permission denied|sandbox violation/ }),
]);

const CODEX_INVALID_EVENT_DIAGNOSTIC_CODES = new Set([
  "codex.event-byte-limit",
  "codex.event-count-limit",
  "codex.invalid-event-unclassified",
  "codex.invalid-json-event",
  "codex.sensitive-root-exposure",
]);

export function classifyCodexProviderDiagnostics({ record = null, stderr = "", exitCode = null,
  structuredResultObserved = null, eventTypes = [] } = {}) {
  const codes = new Set();
  const type = record && typeof record === "object" && !Array.isArray(record)
    ? String(record.type || record.eventType || record.kind || "").trim().toLowerCase() : "";
  const errorRecord = /error|fail/.test(type);
  const sources = [];
  if (errorRecord) sources.push(canonicalJson(record).toLowerCase());
  if (typeof stderr === "string" && stderr.trim()) sources.push(stderr.slice(0, 512 * 1024).toLowerCase());
  for (const source of sources) {
    for (const rule of CODEX_DIAGNOSTIC_RULES) if (rule.pattern.test(source)) codes.add(rule.code);
  }
  if (type === "turn.failed" || eventTypes.includes("turn.failed")) codes.add("codex.turn-failed");
  if (errorRecord && ![...codes].some((code) => code !== "codex.turn-failed")) codes.add("codex.provider-error-unclassified");
  if (Number.isInteger(exitCode) && exitCode !== 0) codes.add("codex.nonzero-exit");
  if (structuredResultObserved === false && Number.isInteger(exitCode) && exitCode !== 0) codes.add("codex.missing-structured-result");
  return [...codes].sort(compareText);
}

function verifyCurrentCodexTarget({ authorization, protocolEvidence, projectBinding, targetResolver, platform, environment, fileSystem, requireInvocationSurface }) {
  const protocol = verifyRuntimeProtocolEvidence(protocolEvidence);
  const binding = verifyRuntimeProjectBinding(projectBinding);
  if (authorization.runtime !== "codex") fail("Codex exec requires a Codex authorization.", "CODEX_AUTHORIZATION_REQUIRED");
  if (protocol.evidenceId !== authorization.runtimeProtocolEvidenceId
    || binding.bindingId !== authorization.runtimeProjectBindingId
    || binding.protocolEvidenceId !== protocol.evidenceId
    || binding.projectId !== authorization.projectId
    || sessionIdOf(binding) !== sessionIdOf(authorization)) {
    fail("Codex capability and project binding changed after authorization.", "CODEX_EXEC_CAPABILITY_BINDING_DRIFT");
  }
  const observation = protocol.observations.find((item) => item.runtime === "codex");
  if (!observation || observation.observationId !== authorization.runtimeProtocolObservationId
    || !observation.protocolNegotiationObserved) {
    fail("Authorized Codex protocol observation is unavailable.", "CODEX_EXEC_PROTOCOL_NOT_VERIFIED");
  }
  const invocationSurface = observation.capabilities.find((item) => item.capability === "one-shot-invocation-surface");
  if (requireInvocationSurface && invocationSurface?.support !== "observed") {
    fail("The authorized Codex executable does not prove every fixed one-shot invocation option.", "CODEX_EXEC_INVOCATION_SURFACE_NOT_VERIFIED");
  }
  const target = targetResolver({ runtime: "codex", platform, environment, fileSystem });
  if (!target?.executablePath || !path.isAbsolute(target.executablePath)
    || canonicalJson(target.observation) !== canonicalJson(observation.executable)
    || target.observation.availability !== "candidate-found" || !target.observation.directSpawnSafe
    || target.observation.symbolicLink) {
    fail("Codex executable identity changed or is not safe for direct spawn.", "CODEX_EXEC_EXECUTABLE_DRIFT");
  }
  return { target, observation };
}

export async function executeCodexRuntimeInvocation({
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
} = {}, { preConsumeGate = null, workerPolicyCapability = null, nativeForkHost = null } = {}) {
  const verified = verifyRuntimeInvocationAuthorization(authorization);
  const selected = verified.workerInput?.executionBoundary
    ? inspectCodexWorkerPolicyCapability(workerPolicyCapability) : null;
  if (!selected && workerPolicyCapability !== null) fail("An unbound authorization cannot acquire a selected workspace.", "CODEX_WORKER_POLICY_BINDING_DRIFT");
  if (selected && preConsumeGate !== null) fail("Selected Codex execution owns its exact policy-to-lease callback.", "CODEX_WORKER_POLICY_GATE_CONFLICT");
  if (!new Set(["actual-provider", "protocol-fixture"]).has(evidenceMode)) fail("Codex execution evidence mode is invalid.", "INVALID_CODEX_EXEC_EVIDENCE_MODE");
  if (selected && selected.policy.evidenceMode !== evidenceMode) fail("Synthetic policy cannot authorize an actual Codex invocation.", "CODEX_WORKER_POLICY_EVIDENCE_MISMATCH");
  if (selected?.policy.mode === "native-fork") {
    const native = inspectCodexNativeForkHost(nativeForkHost);
    if (!native.available || native.evidenceMode !== evidenceMode) fail("Native Codex fork is unavailable for the required policy evidence.", "WORKER_JOB_POLICY_UNAVAILABLE");
    if (native.sourcePrefixDigest !== selected.policy.retainedContextDigest) fail("Native Codex fork inherited context differs from its pre-authorized policy.", "CODEX_WORKER_POLICY_BINDING_DRIFT");
  }
  else if (nativeForkHost !== null) fail("Native fork requires its exact pre-authorized policy.", "CODEX_WORKER_POLICY_BINDING_DRIFT");
  const prepared = prepareRuntimeInvocationExecution({ root, authorization: verified, sessionRequest });
  const { target } = verifyCurrentCodexTarget({
    authorization: verified,
    protocolEvidence,
    projectBinding,
    targetResolver,
    platform,
    environment,
    fileSystem,
    requireInvocationSurface: evidenceMode === "actual-provider",
  });
  if ((evidenceMode === "actual-provider" || selected) && providerArguments !== null) {
    fail("Actual Codex execution arguments cannot be replaced.", "CODEX_EXEC_ARGUMENT_OVERRIDE_REJECTED");
  }
  const selectedSupervisor = supervisorSelection || resolveVerifiedProcessSupervisor({ pluginRoot });
  const selectedArguments = providerArguments === null ? null : providerArguments;
  const callerFenceDigest = buildRuntimeInvocationCallerFence(prepared.projectRoot, verified.authorizationId);
  const providerMode = evidenceMode === "actual-provider" ? "actual-codex" : "codex-protocol-fixture";
  const executionRoot = selected?.workspaceBinding.executionRoot || prepared.projectRoot;
  const verifyNativeBinding = () => {
    if (selected?.policy.mode === "native-fork") verifyCodexNativeForkHostBinding({ host: nativeForkHost,
      authorization: verified, input: prepared.input, projectRoot: prepared.projectRoot, executionRoot, policy: selected.policy });
  };
  verifyNativeBinding();
  const revalidateTarget = () => {
    verifyNativeBinding();
    if (selected?.policy.mode === "native-fork"
      && inspectCodexNativeForkHost(nativeForkHost).sourcePrefixDigest !== selected.policy.retainedContextDigest) fail("Native Codex fork inherited context changed before consumption.", "CODEX_WORKER_POLICY_BINDING_DRIFT");
    return verifyCurrentCodexTarget({ authorization: verified, protocolEvidence, projectBinding,
      targetResolver, platform, environment, fileSystem, requireInvocationSurface: evidenceMode === "actual-provider" });
  };
  let policyScopeSignal = signal;
  let policyDeadlineUnixMs = null;
  const policyGate = selected ? createRuntimePreConsumeGateCapability(({ commitConsumption }) => {
    revalidateTarget();
    verifyCodexWorkerPolicyCapability({ capability: workerPolicyCapability, authorization: verified, root: prepared.projectRoot, target });
    if (policyScopeSignal?.aborted) fail("Codex policy was cancelled immediately before consumption.", "CODEX_WORKER_POLICY_CANCELLED");
    if (policyDeadlineUnixMs !== null && Date.now() >= policyDeadlineUnixMs) fail("Codex policy deadline expired immediately before consumption.", "CODEX_WORKER_POLICY_TIMEOUT");
    commitConsumption();
  }) : preConsumeGate;
  const executeLeased = ({ signal: executionSignal = signal, deadlineUnixMs = null } = {}) => {
    policyScopeSignal = executionSignal;
    policyDeadlineUnixMs = deadlineUnixMs;
    return withRuntimeExecutionLease({
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
    let schemaState;
    try {
      if (selected?.policy.mode === "native-fork") return await runCodexNativeFork({ host: nativeForkHost,
        authorization: verified, input: prepared.input, projectRoot: prepared.projectRoot, executionRoot,
        policy: selected.policy, consumption, lease, operationalStateRoot, callerFenceDigest,
        resultSchema: buildCodexExecWireResultSchema(verified.scope.kind),
        signal: executionSignal, onProcessEvent, providerMode, supervisorSelection: selectedSupervisor,
        sensitiveRoots: [prepared.projectRoot, executionRoot, operationalStateRoot] });
      schemaState = createOperationalSchemaFile(operationalStateRoot, verified);
      return await runSupervisedRuntimeOneShot({
        runtime: "codex",
        operationalStateRoot,
        onNeverStarted: (errorCode) => recordRuntimeInvocationStartFailure({ projectRoot: prepared.projectRoot, authorization: verified, lease, consumption, errorCode }),
        executablePath: target.executablePath,
        args: providerArguments === null
          ? codexArguments({
            projectRoot: executionRoot,
            schemaFile: schemaState.file,
            workspaceMode: verified.workspaceMode,
            model: selected?.policy.wireModel || verified.runtimeSelection?.model || null,
            workerPolicy: selected?.policy || null,
          })
          : selectedArguments,
        projectRoot: prepared.projectRoot,
        executionRoot,
        providerEnvironment: providerEnvironment(environment),
        authorization: verified,
        input: prepared.input,
        consumption,
        callerFenceDigest,
        signal: executionSignal,
        spawnImplementation,
        onProcessEvent,
        providerMode,
        sensitiveRoots: [prepared.projectRoot, executionRoot, operationalStateRoot],
        supervisorSelection: selectedSupervisor,
        supervisorControlFile: schemaState.controlFile,
        commandLabel: "codex exec",
        spawnFailureCode: "CODEX_EXEC_SPAWN_FAILED",
        classifyProviderDiagnostics: classifyCodexProviderDiagnostics,
        extractStructuredResult: extractCodexStructuredResult,
        completionEventTypes: ["turn.completed"],
      });
    } finally {
      removeOperationalSchemaFile(operationalStateRoot, verified, schemaState);
    }
  }, { preConsumeGate: policyGate });
  };
  // The Host guard encloses consumption, provider execution and tree cleanup.
  // Releasing it after a preflight-only callback would remove enforcement before
  // the provider starts. The inner gate rechecks identity at actual consumption.
  const leased = selected ? await withCodexWorkerPolicyCapability({ capability: workerPolicyCapability,
    authorization: verified, root: prepared.projectRoot, target, revalidate: revalidateTarget, signal }, executeLeased)
    : await executeLeased();
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
    runtime: "codex",
    providerMode,
    actualProviderInvoked: leased.result.receipt.providerBoundary.actualProviderInvoked,
    descendantTreeOwnershipValidated: leased.result.receipt.processBoundary.descendantTreeOwnershipValidated,
    receipt: leased.result.receipt,
    draft,
    executionLease: { consumption: leased.consumption, release: leased.release },
    record,
  };
}
