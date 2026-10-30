import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  buildRuntimeInvocationCallerFence, buildRuntimeInvocationLifecycleReceipt, buildRuntimeResultPacketDraft,
  normalizeRuntimeEvent, prepareRuntimeInvocationExecution, verifyRuntimeInvocationAuthorization, verifyRuntimeStructuredResult,
} from "./runtime-invocation-lifecycle.mjs";
import { createRuntimePreConsumeGateCapability, recordRuntimeInvocationStartFailure,
  verifyRuntimeExecutionLeaseOwnership, withRuntimeExecutionLease } from "./runtime-execution-lease.mjs";
import { persistRuntimeInvocationRecord } from "./runtime-invocation-record.mjs";
import { openRuntimeOutputSpool } from "./runtime-output-spool.mjs";
import { resolveVerifiedProcessSupervisor, verifyProcessSupervisorManifest } from "./runtime-process-supervisor.mjs";
import { CODEX_EXEC_RESULT_SCHEMA, verifyCodexExecWireResultSchema, buildCodexExecWireResultSchema } from "./runtime-codex-exec.mjs";
import { assertCodexFreshProposalPolicy, assertCodexFreshProposalEffectiveConfig, assertCodexFreshProposalSkills,
  codexFreshProposalThreadParams, codexFreshProposalTurnParams, verifyCodexFreshProposalPolicyPlan } from "./runtime-codex-proposal-policy.mjs";
import { codexFreshProposalEnvironment } from "./runtime-codex-proposal-policy.mjs";
import { assertCodexNativePrefixPolicy, verifyCodexNativePrefixPolicyPlan } from "./runtime-codex-prefix-policy.mjs";
import { assertCodexProposalCompletion, sameCodexItemEvidence } from "./runtime-codex-turn-evidence.mjs";
import { createCodexFreshProposalTransport, createCodexFreshProposalProtocolFixtureTransport,
  createCodexNativePrefixProposalTransport, createCodexNativePrefixProposalFixtureTransport,
  inspectCodexFreshProposalFixtureCapability, startCodexFreshProposalTransport } from "./runtime-codex-app-server-transport.mjs";
export { assertCodexFreshProposalFeatureList } from "./runtime-codex-app-server-transport.mjs";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { code }); };
const json = value => JSON.stringify(value);
const freeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const text = value => typeof value === "string" && value.length > 0 && value.length <= 4096;
const pluginRoot = path.resolve(import.meta.dirname, "..", "..");
const executionControls = new WeakMap();

// Optional trusted Host narrowing/observation only, never a wire permission or
// a replacement executor. No process handle or backend selector is exposed.
export function createCodexProposalExecutionControl({ authorizationHash, deadlineAt,
  beforeTurn = () => {}, onEvent = () => {}, onTerminal = () => {}, onCleanup = () => {} } = {}) {
  if (!/^[a-f0-9]{64}$/.test(authorizationHash || "") || !Number.isSafeInteger(deadlineAt)
    || [beforeTurn, onEvent, onTerminal, onCleanup].some(fn => typeof fn !== "function")) fail("CODEX_PROPOSAL_CONTROL_INVALID");
  const capability = Object.freeze(Object.create(null));
  executionControls.set(capability, { authorizationHash, deadlineAt, beforeTurn, onEvent, onTerminal, onCleanup });
  return capability;
}

function synchronousControl(control, operation, value) {
  if (!control) return;
  const returned = control[operation](structuredClone(value));
  if (returned && typeof returned.then === "function") {
    Promise.resolve(returned).catch(() => {});
    fail("CODEX_PROPOSAL_SYNCHRONOUS_CONTROL_REQUIRED");
  }
}

// Portable Structured Outputs grammar only. Semantic size, canonical path,
// exact basis and authorization checks remain in the shared Core verifier.
export const CODEX_FRESH_PROPOSAL_RESULT_SCHEMA = freeze(verifyCodexExecWireResultSchema({
  ...CODEX_EXEC_RESULT_SCHEMA,
  required: [...CODEX_EXEC_RESULT_SCHEMA.required, "patchProposal"],
  properties: { ...CODEX_EXEC_RESULT_SCHEMA.properties, protocolVersion: { type: "string", enum: ["0.2.0"] },
    patchProposal: { type: "object", additionalProperties: false, required: ["proposalBasisDigest", "changes"], properties: {
      proposalBasisDigest: { type: "string" }, changes: { type: "array", items: {
        type: "object", additionalProperties: false, required: ["path", "after"], properties: {
          path: { type: "string" }, after: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false,
            required: ["contentBase64", "mode"], properties: { contentBase64: { type: "string" }, mode: { type: "integer" } } }] },
        },
      } },
    } },
  },
}));

export function buildCodexProposalResultSchema(scopeKind) {
  return freeze(buildCodexExecWireResultSchema(scopeKind, CODEX_FRESH_PROPOSAL_RESULT_SCHEMA));
}

function operationalFiles(operationalRoot, authorization) {
  const parents = [path.join(operationalRoot, "runtime-fresh-proposals")];
  parents.push(path.join(parents[0], authorization.projectId));
  const directory = path.join(parents[1], authorization.authorizationId);
  for (const file of [...parents, directory]) {
    try { fs.mkdirSync(file, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(file);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(file) !== file) fail("CODEX_FRESH_PROPOSAL_UNSAFE_OPERATIONAL_PATH");
  }
  const journalFile = path.join(directory, "transport.jsonl");
  const controlFile = path.join(directory, "supervisor-control.jsonl");
  const preflightControlFile = path.join(directory, "preflight-control.jsonl");
  const journal = fs.openSync(journalFile, "wx", 0o600);
  let closed = false;
  return { controlFile, preflightControlFile,
    record(event) {
      // Keep provider/config response contents and credentials out of the
      // journal. Exact operational process IDs stay P5, never in the P3 draft.
      const item = { event: String(event.event || "transport-event"), digest: hash(json(event)),
        ...(Number.isSafeInteger(event.pid) ? { pid: event.pid } : {}),
        ...(Number.isSafeInteger(event.parentPid) ? { parentPid: event.parentPid } : {}) };
      fs.writeSync(journal, `${json(item)}\n`); fs.fsyncSync(journal);
    },
    cleanup() {
      if (!closed) { fs.closeSync(journal); closed = true; }
      if (fs.realpathSync(directory) !== directory) fail("CODEX_FRESH_PROPOSAL_UNSAFE_OPERATIONAL_PATH");
      const expected = ["transport.jsonl", ...(fs.existsSync(controlFile) ? ["supervisor-control.jsonl"] : []),
        ...(fs.existsSync(preflightControlFile) ? ["preflight-control.jsonl"] : [])].sort();
      if (json(fs.readdirSync(directory).sort()) !== json(expected)) fail("CODEX_FRESH_PROPOSAL_UNEXPECTED_OPERATIONAL_FILE");
      for (const file of [journalFile, controlFile, preflightControlFile]) {
        if (!fs.existsSync(file)) continue;
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(file) !== file) fail("CODEX_FRESH_PROPOSAL_UNSAFE_OPERATIONAL_PATH");
        fs.unlinkSync(file);
      }
      fs.rmdirSync(directory);
      for (const parent of [...parents].reverse()) {
        if (fs.readdirSync(parent).length) break;
        if (fs.realpathSync(parent) !== parent || fs.lstatSync(parent).isSymbolicLink()) fail("CODEX_FRESH_PROPOSAL_UNSAFE_OPERATIONAL_PATH");
        fs.rmdirSync(parent);
      }
    },
  };
}

function verifyFreshThread(response, params) {
  if (!text(response?.thread?.id) || response.thread.forkedFromId != null
    || !Array.isArray(response.thread.turns) || response.thread.turns.length !== 0
    || response.model !== params.model || response.modelProvider !== params.modelProvider
    || response.cwd !== params.cwd || response.approvalPolicy !== "never"
    || response.thread.status?.type !== "idle") fail("CODEX_FRESH_PROPOSAL_THREAD_MISMATCH");
  return response.thread.id;
}

function collectItem(items, item) {
  if (!item || !text(item.id) || !["userMessage", "agentMessage", "reasoning"].includes(item.type)) fail("CODEX_FRESH_PROPOSAL_EFFECT_ITEM_REJECTED");
  const previous = items.get(item.id);
  if (previous && !sameCodexItemEvidence(previous, item)) fail("CODEX_FRESH_PROPOSAL_ITEM_MISMATCH");
  items.set(item.id, item);
}

export function extractCodexFreshProposalResult({ items, authorization }) {
  const candidates = items.filter(item => item.type === "agentMessage" && item.phase !== "commentary");
  if (candidates.length !== 1 || typeof candidates[0].text !== "string") fail("CODEX_FRESH_PROPOSAL_AMBIGUOUS_RESULT");
  let result;
  try { result = JSON.parse(candidates[0].text); } catch { fail("CODEX_FRESH_PROPOSAL_INVALID_RESULT"); }
  if (result?.protocolVersion !== "0.2.0") fail("CODEX_FRESH_PROPOSAL_RESULT_VERSION");
  return verifyRuntimeStructuredResult(result, { scopeKind: authorization.scope.kind, authorization });
}

export function assertCodexFreshProposalResultBoundary(result, forbidden) {
  const strings = value => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
  // Core has already checked canonical Base64 and bounded these after images.
  // Encoded file contents must not smuggle P5 identities into durable patches.
  const decoded = (result.patchProposal?.changes || []).flatMap(change => {
    if (change.after === null) return [];
    const bytes = Buffer.from(change.after.contentBase64, "base64");
    // After images are bytes, not necessarily UTF-8. Inspect the same exact
    // forbidden identities in both UTF-16 byte orders without restricting
    // proposal file formats or introducing a general secret-pattern detector.
    const even = bytes.subarray(0, bytes.length - bytes.length % 2);
    return [bytes.toString("utf8"), even.toString("utf16le"), Buffer.from(even).swap16().toString("utf16le")];
  });
  const values = [...strings(result), ...decoded].map(value => value.replaceAll("\\", "/").toLowerCase()).join("\n");
  if (forbidden.filter(Boolean).some(value => values.includes(String(value).replaceAll("\\", "/").toLowerCase()))) fail("CODEX_FRESH_PROPOSAL_SENSITIVE_RESULT");
}

function failureStatus(error) {
  if (["CODEX_RPC_CANCELLED", "CODEX_FRESH_PROPOSAL_CANCELLED"].includes(error?.code)) return "cancelled";
  if (["CODEX_RPC_DEADLINE", "CODEX_FRESH_PROPOSAL_DEADLINE"].includes(error?.code)) return "timed-out";
  if (/LIMIT/u.test(error?.code || "")) return "output-limited";
  return "failed";
}

// A distinct fresh proposal mode, not a reinterpretation of selected-exec or
// native-fork authorizations. The second argument accepts only the transport's
// opaque fixed-Node fixture capability and optional trusted Host control;
// public JSON cannot replace the backend or manufacture either capability.
async function executeProposalInvocation({ root = ".", authorization, policy, workspaceBinding,
  executablePath, supervisorSelection = null, environment = null, signal = null, onProcessEvent = () => {}, persist = true } = {},
{ protocolFixtureCapability = null, executionControl = null } = {}, nativePrefix = false) {
  const verified = verifyRuntimeInvocationAuthorization(authorization);
  const control = executionControl === null ? null : executionControls.get(executionControl);
  if (executionControl !== null && (!control || control.authorizationHash !== verified.authorizationHash)) fail("CODEX_PROPOSAL_CONTROL_INVALID");
  const fixed = (nativePrefix ? verifyCodexNativePrefixPolicyPlan : verifyCodexFreshProposalPolicyPlan)(policy);
  const recipe = nativePrefix ? fixed.recipe : fixed;
  const target = executablePath || fixed.executablePath;
  const actual = fixed.evidenceMode === "actual-provider";
  if (actual && protocolFixtureCapability !== null) fail("CODEX_FRESH_PROPOSAL_FIXTURE_MISMATCH");
  if (!actual) inspectCodexFreshProposalFixtureCapability(protocolFixtureCapability);
  const deadlineAt = Math.min(Date.now() + verified.limits.timeoutMs, control?.deadlineAt ?? Infinity);
  const checkActive = () => {
    if (signal?.aborted) fail("CODEX_FRESH_PROPOSAL_CANCELLED");
    if (Date.now() >= deadlineAt) fail("CODEX_FRESH_PROPOSAL_DEADLINE");
  };
  const env = codexFreshProposalEnvironment({ policy: recipe, environment: environment ?? process.env });
  const assertCurrent = () => {
    checkActive();
    const checked = (nativePrefix ? assertCodexNativePrefixPolicy : assertCodexFreshProposalPolicy)({ root, authorization: verified, policy: fixed, workspaceBinding,
      executablePath: target, codexHome: fixed.codexHome });
    checkActive(); return checked;
  };
  const checked = assertCurrent();
  const prepared = prepareRuntimeInvocationExecution({ root, authorization: verified });
  const resultSchema = buildCodexProposalResultSchema(verified.scope.kind);
  const inputBytes = Buffer.from(prepared.input), inputText = inputBytes.toString("utf8");
  if (!Buffer.from(checked.input).equals(inputBytes) || !Buffer.from(inputText).equals(inputBytes)
    || inputBytes.length !== verified.executionInput.bytes || hash(inputBytes) !== verified.executionInput.digest
    || checked.inputDigest !== verified.executionInput.digest) fail("CODEX_FRESH_PROPOSAL_INPUT_DRIFT");
  const executionRoot = checked.executionRoot;
  const selection = supervisorSelection || resolveVerifiedProcessSupervisor({ pluginRoot });
  verifyProcessSupervisorManifest(selection.manifest);
  const callerFenceDigest = buildRuntimeInvocationCallerFence(prepared.projectRoot, verified.authorizationId);
  const policyDigest = hash(json(fixed));
  const providerMode = actual ? "actual-codex" : "codex-protocol-fixture";
  const preConsumeGate = createRuntimePreConsumeGateCapability(({ commitConsumption }) => { assertCurrent(); commitConsumption(); });
  const leased = await withRuntimeExecutionLease({ projectRoot: prepared.projectRoot, authorization: verified,
    ownerFenceDigest: callerFenceDigest }, async ({ lease, consumption, operationalStateRoot }) => {
    verifyRuntimeExecutionLeaseOwnership({ projectRoot: prepared.projectRoot, authorization: verified, operationalStateRoot, lease, consumption });
    const expires = Math.min(deadlineAt, Date.parse(consumption.holdDeadlineAt) - verified.limits.terminationGraceMs);
    let files, spool, transport, startAttempted = false, childThreadId = null, turnId = null, providerResult = null, failure = null;
    let inputDigestObserved = hash("");
    const operationalErrors = [];
    const retain = (phase, error) => {
      failure ||= error;
      operationalErrors.push({ phase, code: error?.code || "CODEX_PROPOSAL_OBSERVER_ERROR" });
    };
    const observe = (operation, value, critical = false) => {
      try { synchronousControl(control, operation, value); }
      catch (error) { retain(operation, error); if (critical) throw error; }
    };
    const events = [], output = [], stderr = [], items = new Map();
    let outputBytes = 0, stderrBytes = 0, requestSequence = 0;
    const append = notification => {
      const line = json(notification), bytes = Buffer.from(`${line}\n`);
      if (bytes.length > verified.limits.maxEventBytes || outputBytes + bytes.length > verified.limits.maxStdoutBytes) fail("CODEX_FRESH_PROPOSAL_OUTPUT_LIMIT");
      if (!spool.append("stdout", bytes)) fail("CODEX_FRESH_PROPOSAL_OUTPUT_LIMIT");
      output.push(bytes); outputBytes += bytes.length;
      events.push(normalizeRuntimeEvent({ authorization: verified, sequence: events.length,
        line: json({ type: notification.method.replaceAll("/", "."), ...notification }) }));
    };
    const rejectServerAction = () => {
      if (transport.inspect().transcript.some(event => event.event === "server-action-denied")) fail("CODEX_FRESH_PROPOSAL_EFFECT_REQUEST_REJECTED");
    };
    const request = async (method, params) => {
      if (failure) throw failure;
      const response = await transport.request({ requestId: `${verified.authorizationId}:${requestSequence++}`, method, params,
        deadlineAt: expires, signal, maxResponseBytes: verified.limits.maxStdoutBytes });
      if (failure) throw failure;
      rejectServerAction(); return response;
    };
    try {
      files = operationalFiles(operationalStateRoot, verified);
      spool = openRuntimeOutputSpool({ operationalRoot: operationalStateRoot, authorization: verified, callerFenceDigest,
        supervisorManifestDigest: selection.manifest.manifestHash, providerMode });
      const config = { root: prepared.projectRoot, authorization: verified, workspaceBinding, policy: fixed,
        executablePath: target, executableDigest: fixed.executableIdentity.contentDigest, supervisorSelection: selection, executionRoot,
        controlFile: files.controlFile, preflightControlFile: files.preflightControlFile,
        providerEnvironment: env, terminationGraceMs: verified.limits.terminationGraceMs,
        authorizationHash: verified.authorizationHash, policyDigest, inputDigest: verified.executionInput.digest,
        limits: { maxFrameBytes: verified.limits.maxEventBytes, maxOutputBytes: verified.limits.maxStdoutBytes,
          maxStderrBytes: verified.limits.maxStderrBytes, maxNotifications: verified.limits.maxEvents, maxRequests: 16 },
        ...(nativePrefix ? { resultSchema } : {}),
        onStderrChunk: chunk => {
          if (!Buffer.isBuffer(chunk)) fail("CODEX_FRESH_PROPOSAL_INVALID_STDERR");
          const retained = Buffer.from(chunk.subarray(0, verified.limits.maxStderrBytes - stderrBytes));
          stderr.push(retained); stderrBytes += retained.length;
          if (!spool.append("stderr", chunk)) fail("CODEX_FRESH_PROPOSAL_OUTPUT_LIMIT");
        },
        recordOperationalEvidence: event => {
          const critical = ["request-sent", "process-planned", "preflight-planned"].includes(event.event);
          // Diagnostic storage must not throw into the supervisor control/exit
          // parser. Preserve the error and stop at the execution boundary.
          try { files.record(event); }
          catch (error) { retain("journal", error); if (critical) throw error; }
          observe("onEvent", event, critical);
          if (event.event === "request-sent" && event.method === "turn/start") {
            if (failure) throw failure;
            const phase = nativePrefix ? transport.inspect().prefix.childId ? "child" : "seed" : "fresh";
            observe("beforeTurn", { phase, requestId: event.requestId, params: event.params,
              authorizationHash: verified.authorizationHash, inputDigest: verified.executionInput.digest,
              policyDigest, deadlineAt: expires }, true);
          }
          const processEventType = { "process-planned": "planned", "process-started": "spawn", "process-closed": "exit",
            "preflight-planned": "planned", "preflight-spawn": "spawn", "preflight-exit": "exit" }[event.event];
          if (processEventType) {
            try {
              const returned = onProcessEvent({ type: processEventType, phase: event.event.startsWith("preflight-") ? "preflight" : "provider",
                pid: event.pid, parentPid: event.parentPid ?? process.pid, command: event.command, args: event.args,
                cwd: event.cwd ?? executionRoot, exitCode: event.exitCode, ports: [] });
              if (returned && typeof returned.then === "function") {
                Promise.resolve(returned).catch(() => {});
                fail("CODEX_FRESH_PROPOSAL_SYNCHRONOUS_OBSERVER_REQUIRED");
              }
            } catch (error) { retain("process-observer", error); if (critical) throw error; }
          }
        } };
      transport = nativePrefix
        ? actual ? createCodexNativePrefixProposalTransport(config) : createCodexNativePrefixProposalFixtureTransport(config, { capability: protocolFixtureCapability })
        : actual ? createCodexFreshProposalTransport(config) : createCodexFreshProposalProtocolFixtureTransport(config, { capability: protocolFixtureCapability });
      assertCurrent();
      startAttempted = true;
      await startCodexFreshProposalTransport({ ownedTransport: transport.ownedTransport, projectRoot: prepared.projectRoot,
        operationalStateRoot, authorization: verified, lease, consumption, executionRoot, policyDigest,
        inputDigest: verified.executionInput.digest, deadlineAt: expires, signal });
      const effective = await request("config/read", { includeLayers: false, cwd: executionRoot });
      assertCodexFreshProposalEffectiveConfig({ policy: recipe, response: effective });
      const skills = await request("skills/list", { cwds: [executionRoot], forceReload: true });
      assertCodexFreshProposalSkills({ policy: recipe, response: skills, executionRoot });
      const account = await request("account/read", { refreshToken: false });
      if (account?.account?.type !== "chatgpt") fail("CODEX_FRESH_PROPOSAL_CHATGPT_ACCOUNT_REQUIRED");
      const catalog = await request("model/list", { limit: 100, includeHidden: false });
      const models = Array.isArray(catalog?.data) ? catalog.data.filter(model => model?.model === fixed.wireModel) : [];
      if (models.length === 0 && text(catalog?.nextCursor)) fail("CODEX_FRESH_PROPOSAL_MODEL_CATALOG_INCOMPLETE");
      if (models.length !== 1 || models[0].hidden !== false || !models[0].inputModalities?.includes("text")
        || models[0].availabilityNux != null) fail("CODEX_FRESH_PROPOSAL_MODEL_UNAVAILABLE");
      if (nativePrefix) {
        await request("thread/start", transport.prefixParams("thread/start"));
        await request("turn/start", transport.prefixParams("turn/start"));
        const sourceId = transport.inspect().prefix.sourceId;
        let seedDone = false;
        while (!seedDone) {
          const notification = await transport.nextNotification({ childThreadId: sourceId, deadlineAt: expires, signal });
          if (failure) throw failure;
          rejectServerAction(); append(notification);
          seedDone = notification.method === "turn/completed";
        }
        observe("onTerminal", { phase: "seed", outcome: "completed" }, true);
        await request("thread/read", transport.prefixParams("thread/read"));
        await request("thread/fork", transport.prefixParams("thread/fork"));
        childThreadId = transport.inspect().prefix.childId;
      } else {
        const threadParams = codexFreshProposalThreadParams({ policy: fixed, executionRoot });
        childThreadId = verifyFreshThread(await request("thread/start", threadParams), threadParams);
      }
      append({ method: "thread/started", params: { threadId: childThreadId } });
      const started = await request("turn/start", nativePrefix ? transport.prefixParams("turn/start", inputText)
        : codexFreshProposalTurnParams({ policy: fixed, threadId: childThreadId, input: inputText, outputSchema: resultSchema }));
      if (!text(started?.turn?.id) || !["inProgress", "completed"].includes(started.turn.status)) fail("CODEX_FRESH_PROPOSAL_TURN_MISMATCH");
      turnId = started.turn.id; inputDigestObserved = verified.executionInput.digest;
      let complete = false;
      while (!complete) {
        const notification = await transport.nextNotification({ childThreadId, deadlineAt: expires, signal });
        if (failure) throw failure;
        rejectServerAction();
        if (notification?.params?.threadId !== childThreadId) fail("CODEX_FRESH_PROPOSAL_THREAD_MISMATCH");
        if (["turn/started", "turn/completed"].includes(notification.method)) {
          if (notification.params.turn?.id !== turnId) fail("CODEX_FRESH_PROPOSAL_TURN_MISMATCH");
        } else if (notification.params.turnId && notification.params.turnId !== turnId) fail("CODEX_FRESH_PROPOSAL_TURN_MISMATCH");
        if (/commandExecution|fileChange|mcpToolCall|dynamicToolCall|webSearch|imageGeneration|collabAgent/u.test(notification.method || "")) fail("CODEX_FRESH_PROPOSAL_EFFECT_ITEM_REJECTED");
        if (notification.method === "item/started" && !["userMessage", "agentMessage", "reasoning"].includes(notification.params.item?.type)) fail("CODEX_FRESH_PROPOSAL_EFFECT_ITEM_REJECTED");
        if (notification.method === "item/completed") collectItem(items, notification.params.item);
        append(notification);
        if (notification.method === "turn/completed") {
          const turn = notification.params.turn;
          assertCodexProposalCompletion(turn, items);
          providerResult = extractCodexFreshProposalResult({ items: [...items.values()], authorization: verified });
          assertCodexFreshProposalResultBoundary(providerResult, [prepared.projectRoot, executionRoot, operationalStateRoot, fixed.codexHome, childThreadId, turnId,
            transport.inspect().prefix?.sourceId, transport.inspect().prefix?.sourceTurnId]);
          observe("onTerminal", { phase: nativePrefix ? "child" : "fresh", outcome: "completed" }, true);
          complete = true;
        }
      }
    } catch (error) {
      retain("execution", error); providerResult = null;
    }
    try {
      try { if (transport) {
        const reason = failureStatus(failure) === "cancelled" ? "CODEX_FRESH_PROPOSAL_CANCELLED"
          : failureStatus(failure) === "timed-out" ? "CODEX_FRESH_PROPOSAL_DEADLINE" : failure?.code || "completed";
        await transport.cleanup({ reason, commit: async () => {} });
      } } catch (error) { retain("cleanup", error); providerResult = null; }
      const observed = transport?.inspect();
      if (!failure && observed?.failureCode) {
        failure = Object.assign(new Error("Fresh transport failed after its last result"), { code: observed.failureCode });
        providerResult = null;
      }
      const cleanup = observed?.cleanup?.started ? observed.cleanup : observed?.preflight?.cleanup;
      // Owned close precedes any optional ledger persistence. The callback
      // cannot assert ownership: it only receives the product's observation.
      observe("onCleanup", { started: cleanup?.started === true, cleanup: cleanup || null,
        modelCallAttempted: observed?.modelCallAttempted === true, failureCode: failure?.code || null });
      if (failure) providerResult = null;
      if (!cleanup?.started) {
        if (!startAttempted) recordRuntimeInvocationStartFailure({ projectRoot: prepared.projectRoot, authorization: verified, lease, consumption,
          errorCode: failure?.code || "CODEX_FRESH_PROPOSAL_NEVER_STARTED" });
        throw failure || Object.assign(new Error("Fresh proposal process never started"), { code: "CODEX_FRESH_PROPOSAL_NEVER_STARTED" });
      }
      if (!cleanup.exactExitObserved || !cleanup.supervision?.treeCleanupVerified || !cleanup.supervision.ownershipEstablished
        || !cleanup.supervision.providerChildStarted || cleanup.actualProviderInvoked !== actual) fail("CODEX_FRESH_PROPOSAL_CLEANUP_UNCERTAIN");
      if (!failure && (cleanup.exitCode !== 0 || cleanup.terminationRequested || !cleanup.supervision.providerChildExitObserved)) fail("CODEX_FRESH_PROPOSAL_UNCLEAN_EXIT");
      const status = failure ? failureStatus(failure) : "completed";
      const receipt = buildRuntimeInvocationLifecycleReceipt({ authorization: verified, events: [...events].sort((a, b) => a.eventId.localeCompare(b.eventId)),
        status, exitCode: cleanup.exitCode, signal: "", stdoutBytes: outputBytes, stderrBytes,
        stdoutDigest: hash(Buffer.concat(output)), stderrDigest: hash(Buffer.concat(stderr)), callerFenceDigest,
        childFenceDigest: hash(`${verified.authorizationId}\n${consumption.consumptionId}\n${selection.manifest.manifestHash}`),
        childStarted: true, childExitObserved: true, terminationRequested: cleanup.terminationRequested || ["cancelled", "timed-out", "output-limited"].includes(status),
        projectFenceValidated: true, inputDigestObserved, noDescendantFixture: false, descendantTreeOwnershipValidated: true,
        consumption, providerMode, providerSessionCreated: actual && (childThreadId !== null || Boolean(observed?.prefix?.sourceId)), supervision: cleanup.supervision,
        providerDiagnosticCodes: failure ? [nativePrefix ? "codex.native-prefix-proposal-contract-failed" : "codex.fresh-proposal-contract-failed"] : [], structuredResult: providerResult });
      const result = { receipt, events, providerResult, modelCallAttempted: observed?.modelCallAttempted === true };
      spool.complete(result); return { ...result, operationalErrors };
    } finally {
      spool?.close(); files?.cleanup();
    }
  }, { preConsumeGate });
  const draft = buildRuntimeResultPacketDraft({ authorization: verified, receipt: leased.result.receipt,
    leaseRelease: leased.release, providerResult: leased.result.providerResult });
  const record = persist ? persistRuntimeInvocationRecord({ projectRoot: prepared.projectRoot, authorization: verified,
    events: leased.result.events, receipt: leased.result.receipt, draft })
    : { recorded: false, eventCount: leased.result.events.length, receiptId: leased.result.receipt.receiptId, draftId: draft.draftId };
  return { status: leased.result.receipt.status === "completed" ? "provider_invocation_completed" : "provider_invocation_finished_with_evidence",
    authorizationId: verified.authorizationId, scopeKind: verified.scope.kind, runtime: "codex", providerMode,
    actualProviderInvoked: leased.result.receipt.providerBoundary.actualProviderInvoked, modelCallAttempted: leased.result.modelCallAttempted,
    descendantTreeOwnershipValidated: leased.result.receipt.processBoundary.descendantTreeOwnershipValidated,
    operationalErrors: leased.result.operationalErrors,
    receipt: leased.result.receipt, draft, executionLease: { consumption: leased.consumption, release: leased.release }, record };
}

export async function executeCodexFreshProposalInvocation(options, capabilities) {
  return executeProposalInvocation(options, capabilities, false);
}

export async function executeCodexNativePrefixProposalInvocation(options, capabilities) {
  return executeProposalInvocation(options, capabilities, true);
}
