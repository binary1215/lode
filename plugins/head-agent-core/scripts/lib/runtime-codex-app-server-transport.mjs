import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder, types } from "node:util";
import { createCodexNativeForkOwnedTransport } from "./runtime-codex-native-fork.mjs";
import { assertCodexInstalledForkRequest } from "./runtime-codex-fork-compatibility.mjs";
import { verifyCodexNativePrefixPolicyPlan, assertCodexNativePrefixPolicy, codexNativePrefixStartupArguments } from "./runtime-codex-prefix-policy.mjs";
import { createCodexNativePrefixSession } from "./runtime-codex-prefix-session.mjs";
import { spawnSupervisedProcess, verifyRuntimeProcessSupervisorHandle } from "./runtime-process-supervisor.mjs";
import { verifyRuntimeExecutionLeaseOwnership } from "./runtime-execution-lease.mjs";
import { buildCodexFreshProposalPolicyPlan, verifyCodexFreshProposalPolicyPlan, codexFreshProposalStartupArguments, codexFreshProposalThreadParams, codexFreshProposalTurnParams,
  assertCodexFreshProposalEffectiveConfig, assertCodexFreshProposalSkills, assertCodexFreshProposalPolicy, codexFreshProposalEnvironment,
  assertCodexFreshProposalInstructionSources } from "./runtime-codex-proposal-policy.mjs";

// Concrete P5 stdio only. This implements transport, not effective sandbox,
// inherited-instruction, tool or goal enforcement. The actual constructor has
// no public start method: only the native adapter's consumed, guarded lease can
// invoke its private synchronous spawn factory. Missing Host proof stays closed.
export const CODEX_APP_SERVER_TRANSPORT_VERSION = "0.1.0";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { code }); };
const error = code => Object.assign(new Error(code), { code });
const text = value => typeof value === "string" && value.length > 0 && value.length <= 4096;
const idKey = id => typeof id === "string" && text(id) ? `s:${id}` : Number.isSafeInteger(id) ? `n:${id}` : fail("CODEX_RPC_INVALID_ID");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const METHODS = new Set(["thread/read", "thread/fork", "thread/goal/get", "thread/goal/clear", "turn/start", "account/read", "model/list"]);
const MUTATIONS = new Set(["thread/fork", "thread/goal/clear", "turn/start"]);
const FIXTURE = fileURLToPath(new URL("../../test/helpers/codex-app-server-protocol-fixture.mjs", import.meta.url));
const PROPOSAL_FIXTURE = fileURLToPath(new URL("../../test/helpers/codex-proposal-protocol-fixture.mjs", import.meta.url));
const proposalTransports = new WeakMap();
const proposalFixtures = new WeakMap();
const proposalConsumptions = new Set();
const sameJson = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

// Match the repository's plain-JSON/data-descriptor boundary without invoking
// getters, toJSON, proxy traps or a second read of mutable caller data. Signal
// is a separate local cancellation reference, never part of the wire snapshot.
function requestSnapshot(call, maxBytes) {
  const invalid = () => fail("CODEX_RPC_INVALID_REQUEST_DATA");
  const descriptors = value => {
    if (!object(value) || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
    const result = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(result).some(key => typeof key !== "string" || !result[key].enumerable || !Object.hasOwn(result[key], "value"))) invalid();
    return result;
  };
  let bytes = 0;
  const active = new Set();
  const clone = (value, depth = 0) => {
    if (depth > 32) invalid();
    if (value === null || ["string", "boolean", "number"].includes(typeof value)) {
      if (typeof value === "number" && !Number.isFinite(value)) invalid();
      bytes += Buffer.byteLength(JSON.stringify(value)); if (bytes > maxBytes) fail("CODEX_RPC_FRAME_LIMIT");
      return value;
    }
    if (!value || typeof value !== "object" || types.isProxy(value) || active.has(value)) invalid();
    active.add(value);
    let entries;
    let output;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) invalid();
      const fields = Object.getOwnPropertyDescriptors(value);
      const length = fields.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || Reflect.ownKeys(fields).length !== length + 1) invalid();
      entries = [];
      for (let i = 0; i < length; i++) {
        const descriptor = fields[String(i)];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) invalid();
        entries.push([String(i), descriptor.value]);
      }
      output = [];
    } else {
      entries = Object.entries(descriptors(value)).map(([key, descriptor]) => [key, descriptor.value]);
      output = Object.create(null);
    }
    bytes += 2;
    for (const [key, value] of entries) {
      bytes += Buffer.byteLength(JSON.stringify(key)) + 2; if (bytes > maxBytes) fail("CODEX_RPC_FRAME_LIMIT");
      Object.defineProperty(output, key, { value: clone(value, depth + 1), enumerable: true });
    }
    active.delete(value);
    return Object.freeze(output);
  };
  const fields = descriptors(call);
  const allowed = new Set(["requestId", "method", "params", "signal", "deadlineAt", "timeoutMs", "maxResponseBytes"]);
  if (Object.keys(fields).some(key => !allowed.has(key)) || !["requestId", "method", "params"].every(key => fields[key])) invalid();
  const snapshot = Object.create(null);
  for (const [key, descriptor] of Object.entries(fields)) {
    if (key === "signal") snapshot.signal = descriptor.value;
    else if (descriptor.value !== undefined) snapshot[key] = clone(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function denial(method) {
  if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method)) return { result: { decision: "cancel" } };
  if (["applyPatchApproval", "execCommandApproval"].includes(method)) return { result: { decision: "abort" } };
  if (method === "item/permissions/requestApproval") return { result: { permissions: {}, scope: "turn" } };
  if (method === "item/tool/requestUserInput") return { result: { answers: {} } };
  if (method === "mcpServer/elicitation/request") return { result: { action: "cancel" } };
  if (method === "item/tool/call") return { result: { contentItems: [], success: false } };
  return { error: { code: -32601, message: "This bounded worker does not grant server actions." } };
}

function makeTransport(options, fixture, readOnlyProbe = false, proposal = null, preparation = null) {
  const { executablePath, executableDigest, supervisorSelection, executionRoot, controlFile,
    providerEnvironment = {}, terminationGraceMs = 1000, recordOperationalEvidence = () => {},
    authorizationHash, policyDigest, inputDigest, sourceThreadId, limits = {} } = options;
  if (![executablePath, executionRoot, controlFile].every(value => typeof value === "string" && path.isAbsolute(value))
    || !/^[a-f0-9]{64}$/.test(executableDigest || "") || typeof recordOperationalEvidence !== "function"
    || !Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 100 || terminationGraceMs > 10000
    || !readOnlyProbe && (!proposal && !text(sourceThreadId) || ![authorizationHash, policyDigest, inputDigest].every(value => /^[a-f0-9]{64}$/.test(value || "")))) fail("CODEX_RPC_INVALID_CONFIGURATION");
  if (!fixture && !/^codex(?:\.exe)?$/i.test(path.basename(executablePath))) fail("CODEX_RPC_FIXED_EXECUTABLE_REQUIRED");
  const bounds = { maxFrameBytes: 1024 * 1024, maxOutputBytes: 8 * 1024 * 1024, maxStderrBytes: 1024 * 1024,
    maxNotifications: 1024, maxRequests: 128, ...limits };
  if (Object.keys(bounds).some(key => !["maxFrameBytes", "maxOutputBytes", "maxStderrBytes", "maxNotifications", "maxRequests"].includes(key))
    || Object.values(bounds).some(value => !Number.isSafeInteger(value) || value < 1 || value > 64 * 1024 * 1024)) fail("CODEX_RPC_INVALID_CONFIGURATION");
  const diagnosticId = readOnlyProbe ? `codex-readonly-${crypto.randomUUID()}` : null;
  const expectedBinding = readOnlyProbe ? { diagnosticId, executionRootDigest: hash(path.resolve(executionRoot)) }
    : { authorizationHash, policyDigest, inputDigest, executionRootDigest: hash(path.resolve(executionRoot)) };
  const pending = new Map();
  const used = new Set();
  const serverIds = new Set();
  const mutations = new Set();
  const children = new Set();
  const prefixSession = proposal?.prefixPolicy ? createCodexNativePrefixSession({ policy: proposal.prefixPolicy,
    executionRoot, inputDigest, resultSchema: proposal.resultSchema }) : null;
  const notifications = [];
  const waiters = new Set();
  const transcript = [];
  const deliveries = [];
  const mutationsForMode = proposal ? new Set(["thread/start", "turn/start", ...(prefixSession ? ["thread/fork"] : [])]) : MUTATIONS;
  const freshSlots = new Set();
  let freshConfigChecked = false;
  let freshSkillsChecked = false;
  let freshAccountChecked = false;
  let freshModelChecked = false;
  let freshThreadId = null;
  let freshTurnId = null;
  let freshTerminalSeen = false;
  let handle = null;
  let deadlineAt = null;
  let initialized = null;
  let initializationComplete = false;
  let failure = null;
  let closing = false;
  let closePromise = null;
  let observedClose = false;
  let closeCode = null;
  let processCloseAtMs = null;
  let exactClose;
  let lifetimeTimer;
  let launchSignal;
  let launchAbort;
  let buffered = Buffer.alloc(0);
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stderrHash = crypto.createHash("sha256");
  let forced = false;
  let verifiedCleanup = null;
  const record = event => {
    const value = { ...event, authority: "host-operational-evidence-only", recoveryAuthority: false,
      actualProviderInvoked: !fixture && (handle !== null || proposal?.preflightStarted === true), modelCallAttempted: !readOnlyProbe && deliveries.some(item => item.method === "turn/start" && item.delivery.writeAttempted),
      ...(readOnlyProbe ? { diagnosticId, readOnlyProbe: true } : { authorizationHash }) };
    transcript.push(value);
    const returned = recordOperationalEvidence(structuredClone(value));
    if (returned && typeof returned.then === "function") fail("CODEX_RPC_SYNCHRONOUS_JOURNAL_REQUIRED");
  };
  const stop = reason => {
    const guardCode = { PROCESS_SUPERVISOR_INPUT_DEADLINE: "CODEX_RPC_DEADLINE", PROCESS_SUPERVISOR_INPUT_CANCELLED: "CODEX_RPC_CANCELLED",
      PROCESS_SUPERVISOR_INPUT_CLOSED: "CODEX_RPC_TRANSPORT_CLOSED" }[reason?.code];
    if (guardCode) reason = Object.assign(error(guardCode), { cause: reason });
    if (!failure) failure = reason;
    for (const item of [...pending.values()]) item.reject(failure);
    for (const item of [...waiters]) item.reject(failure);
    if (handle && !closing) close().catch(() => {});
  };
  const ensureOpen = () => { if (failure) throw failure; if (!handle || closing || observedClose) fail("CODEX_RPC_TRANSPORT_CLOSED"); };
  const currentDeadline = supplied => Math.min(deadlineAt, supplied ?? deadlineAt);
  function write(value, { beforeWrite = null, signal = launchSignal, deadlineAt: requestedDeadline } = {}) {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    if (bytes.length > bounds.maxFrameBytes) fail("CODEX_RPC_FRAME_LIMIT");
    const expires = currentDeadline(requestedDeadline);
    const guard = () => {
      ensureOpen();
      if (signal?.aborted || launchSignal?.aborted) fail("CODEX_RPC_CANCELLED");
      if (!Number.isSafeInteger(expires) || expires <= Date.now()) fail("CODEX_RPC_DEADLINE");
      beforeWrite?.();
    };
    guard();
    // The exact factory-returned Promise owns writeAttempted; do not wrap it
    // with an async function or substitute caller-supplied delivery evidence.
    return handle.writeInput(bytes, { beforeWrite: guard, signal, deadlineAt: expires });
  }
  function checkProposalNotification(frame, accept = false) {
    if (!proposal) return;
    if (prefixSession) { if (accept) prefixSession.notification(frame); return; }
    const turnEvent = ["turn/started", "turn/completed"].includes(frame.method);
    const itemEvent = frame.method.startsWith("item/");
    const allowedItems = new Set(["userMessage", "agentMessage", "reasoning"]);
    if (/commandExecution|fileChange|mcpToolCall|dynamicToolCall|webSearch|imageGeneration|collabAgent/u.test(frame.method)
      || frame.params?.item && !allowedItems.has(frame.params.item.type)
      || frame.method === "turn/completed" && (!Array.isArray(frame.params?.turn?.items)
        || frame.params.turn.items.some(item => !allowedItems.has(item?.type)))) fail("CODEX_RPC_PROPOSAL_EFFECT_REJECTED");
    if ((turnEvent || itemEvent) && (!freshTurnId || frame.params?.threadId !== freshThreadId
      || (turnEvent ? frame.params?.turn?.id : frame.params?.turnId) !== freshTurnId)) fail("CODEX_RPC_PROPOSAL_EVENT_MISMATCH");
    if (accept && (turnEvent || itemEvent)) {
      if (freshTerminalSeen) fail("CODEX_RPC_PROPOSAL_AFTER_TERMINAL");
      if (frame.method === "turn/completed") freshTerminalSeen = true;
    }
  }
  function dispatch(frame) {
    if (!object(frame) || typeof frame.jsonrpc !== "undefined" && frame.jsonrpc !== "2.0") fail("CODEX_RPC_INVALID_FRAME");
    if (Object.hasOwn(frame, "method")) {
      if (!text(frame.method) || Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error")) fail("CODEX_RPC_INVALID_FRAME");
      if (Object.hasOwn(frame, "id")) {
        const key = idKey(frame.id);
        // IDs are directional in JSON-RPC. Keep separate namespaces: a server
        // request cannot resolve a same-numbered client response or vice versa.
        if (serverIds.has(key)) fail("CODEX_RPC_DUPLICATE_SERVER_REQUEST");
        if (serverIds.size >= bounds.maxRequests) fail("CODEX_RPC_REQUEST_LIMIT");
        serverIds.add(key);
        record({ event: "server-action-denied", id: frame.id, method: frame.method });
        write({ id: frame.id, ...denial(frame.method) }).catch(stop);
        if (proposal) stop(error("CODEX_RPC_PROPOSAL_EFFECT_REJECTED"));
        return;
      }
      if (notifications.length >= bounds.maxNotifications) fail("CODEX_RPC_NOTIFICATION_LIMIT");
      if (proposal && freshTurnId) checkProposalNotification(frame, true);
      const waiter = [...waiters].find(item => frame.params?.threadId === item.childThreadId);
      if (waiter) waiter.resolve(frame); else notifications.push(frame);
      return;
    }
    if (!Object.hasOwn(frame, "id") || Object.hasOwn(frame, "result") === Object.hasOwn(frame, "error")) fail("CODEX_RPC_INVALID_FRAME");
    const key = idKey(frame.id);
    const item = pending.get(key);
    if (!item) fail(used.has(key) ? "CODEX_RPC_DUPLICATE_RESPONSE" : "CODEX_RPC_UNCORRELATED_RESPONSE");
    if (Object.hasOwn(frame, "error")) {
      if (!object(frame.error) || !Number.isInteger(frame.error.code) || typeof frame.error.message !== "string") fail("CODEX_RPC_INVALID_FRAME");
      item.reject(error("CODEX_RPC_PROVIDER_ERROR"));
      if (mutationsForMode.has(item.method)) stop(error("CODEX_RPC_PROVIDER_ERROR"));
    } else {
      if (Buffer.byteLength(JSON.stringify(frame.result)) > item.maxResponseBytes) fail("CODEX_RPC_RESPONSE_LIMIT");
      if (item.method === "thread/fork" && frame.result?.thread?.forkedFromId === sourceThreadId && text(frame.result.thread.id)
        && frame.result.thread.id !== sourceThreadId) children.add(frame.result.thread.id);
      if (proposal) {
        if (item.method === "config/read") {
          assertCodexFreshProposalEffectiveConfig({ policy: proposal.policy, response: frame.result });
          if (prefixSession && frame.result?.config?.show_raw_agent_reasoning !== false) fail("CODEX_NATIVE_PREFIX_LEGACY_CONFIG_MISMATCH");
          freshConfigChecked = true;
        }
        if (item.method === "skills/list") {
          assertCodexFreshProposalSkills({ policy: proposal.policy, response: frame.result, executionRoot });
          freshSkillsChecked = true;
        }
        if (item.method === "account/read") {
          if (frame.result?.account?.type !== "chatgpt") fail("CODEX_RPC_PROPOSAL_ACCOUNT_MISMATCH");
          freshAccountChecked = true;
        }
        if (item.method === "model/list") {
          const matching = Array.isArray(frame.result?.data) ? frame.result.data.filter(model => model.model === proposal.policy.wireModel) : [];
          if (matching.length === 0 && text(frame.result?.nextCursor)) fail("CODEX_RPC_PROPOSAL_CATALOG_INCOMPLETE");
          if (matching.length !== 1 || matching[0].hidden !== false || !matching[0].inputModalities?.includes("text")
            || matching[0].availabilityNux != null) fail("CODEX_RPC_PROPOSAL_MODEL_UNAVAILABLE");
          freshModelChecked = true;
        }
        if (prefixSession && ["thread/start", "thread/read", "thread/fork", "turn/start"].includes(item.method)) {
          prefixSession.response(item.method, frame.result);
          const state = prefixSession.inspect();
          freshThreadId = state.childId || state.sourceId;
          freshTurnId = state.childId ? state.childTurnId : state.sourceTurnId;
          if (freshThreadId) children.add(freshThreadId);
          if (item.method === "turn/start") for (const notification of notifications) checkProposalNotification(notification, true);
        }
        if (!prefixSession && item.method === "thread/start") {
          const response = frame.result;
          const thread = response?.thread;
          if (!text(thread?.id) || thread.forkedFromId != null || thread.parentThreadId != null
            || thread.ephemeral !== true || thread.status?.type !== "idle" || !Array.isArray(thread.turns) || thread.turns.length !== 0
            || response.model !== proposal.policy.wireModel || response.modelProvider !== proposal.policy.wireModelProvider
            || thread.model != null && thread.model !== proposal.policy.wireModel || thread.modelProvider !== proposal.policy.wireModelProvider
            || response.cwd !== executionRoot || thread.cwd !== executionRoot || !sameJson(response.runtimeWorkspaceRoots, proposal.threadParams.runtimeWorkspaceRoots)
            || response.approvalPolicy !== "never" || response.approvalsReviewer !== "user"
            || response.sandbox?.type !== "readOnly" || response.sandbox.networkAccess !== false) fail("CODEX_RPC_PROPOSAL_THREAD_MISMATCH");
          assertCodexFreshProposalInstructionSources({ policy: proposal.policy, instructionSources: response.instructionSources });
          freshThreadId = thread.id;
          children.add(thread.id);
        }
        if (!prefixSession && item.method === "turn/start") {
          const turn = frame.result?.turn;
          if (!text(turn?.id) || !["inProgress", "completed"].includes(turn.status) || turn.error != null
            || !Array.isArray(turn.items)) fail("CODEX_RPC_PROPOSAL_TURN_MISMATCH");
          if (turn.items.some(item => !["userMessage", "agentMessage", "reasoning"].includes(item?.type))) fail("CODEX_RPC_PROPOSAL_EFFECT_REJECTED");
          freshTurnId = turn.id;
          for (const notification of notifications) checkProposalNotification(notification, true);
        }
      }
      item.resolve(frame.result);
    }
  }
  function stdout(chunk) {
    if (failure || closing && !proposal && !preparation) return;
    try {
      stdoutBytes += chunk.length;
      if (stdoutBytes > bounds.maxOutputBytes) fail("CODEX_RPC_OUTPUT_LIMIT");
      buffered = Buffer.concat([buffered, chunk]);
      let newline;
      while ((newline = buffered.indexOf(10)) !== -1) {
        if (newline > bounds.maxFrameBytes) fail("CODEX_RPC_FRAME_LIMIT");
        const bytes = buffered.subarray(0, newline); buffered = buffered.subarray(newline + 1);
        if (bytes.length === 0) fail("CODEX_RPC_INVALID_FRAME");
        const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        dispatch(JSON.parse(line));
      }
      if (buffered.length > bounds.maxFrameBytes) fail("CODEX_RPC_FRAME_LIMIT");
    } catch (cause) { stop(cause.code ? cause : error("CODEX_RPC_INVALID_FRAME")); }
  }
  function spawnOwned({ ownershipBinding, deadlineAt: requestedDeadline, signal }) {
    if (handle || closing || failure) fail("CODEX_RPC_TRANSPORT_REPLAYED");
    if (!object(ownershipBinding) || Object.entries(expectedBinding).some(([key, value]) => ownershipBinding[key] !== value)
      || !readOnlyProbe && !text(ownershipBinding.consumptionId) || !Number.isSafeInteger(requestedDeadline)
      || requestedDeadline - Date.now() < 100 || signal?.aborted) fail("CODEX_RPC_BINDING_MISMATCH");
    const real = fs.realpathSync(executablePath);
    if (path.resolve(real) !== path.resolve(executablePath) || hash(fs.readFileSync(real)) !== executableDigest) fail("CODEX_RPC_EXECUTABLE_DRIFT");
    deadlineAt = requestedDeadline;
    const args = fixture ? [proposal ? PROPOSAL_FIXTURE : FIXTURE, options.scenario || "normal"]
      : proposal ? proposal.args : preparation ? codexFreshProposalStartupArguments(preparation) : ["app-server", "--listen", "stdio://"];
    proposal?.beforeSpawn?.();
    record({ event: "process-planned", command: executablePath, args, cwd: executionRoot, parentPid: process.pid, ports: [] });
    proposal?.beforeSpawn?.();
    // Hashing and the synchronous Host journal are fallible/user-code seams.
    // No callback or elapsed work may resurrect an expired launch.
    if (signal?.aborted || requestedDeadline - Date.now() < 100 || closing) fail("CODEX_RPC_BINDING_MISMATCH");
    handle = spawnSupervisedProcess({ selection: supervisorSelection, executablePath, args, cwd: executionRoot,
      providerEnvironment, input: Buffer.alloc(0), controlFile, terminationGraceMs, ownershipBinding,
      interactive: { timeoutMs: Math.min(3_600_000, Math.max(100, requestedDeadline - Date.now())) },
      onControlEvent: event => record({ event: "supervisor-control", control: event }) });
    // Register close and stream sinks before any fallible post-spawn operation.
    exactClose = new Promise(resolve => handle.child.once("close", code => {
      processCloseAtMs = performance.now();
      observedClose = true; closeCode = code; clearTimeout(lifetimeTimer);
      if ((proposal || preparation) && buffered.length) stop(error("CODEX_RPC_PARTIAL_FRAME"));
      else if (!closing) stop(error(buffered.length ? "CODEX_RPC_PARTIAL_FRAME" : "CODEX_RPC_PROVIDER_LOST"));
      resolve();
    }));
    handle.child.stdout.on("data", stdout);
    handle.child.stderr.on("data", chunk => {
      stderrBytes += chunk.length;
      stderrHash.update(chunk);
      if (stderrBytes > bounds.maxStderrBytes) stop(error("CODEX_RPC_STDERR_LIMIT"));
      else if (proposal && options.onStderrChunk) {
        try {
          const returned = options.onStderrChunk(Buffer.from(chunk));
          if (returned && typeof returned.then === "function") fail("CODEX_RPC_SYNCHRONOUS_OBSERVER_REQUIRED");
        } catch (cause) { stop(cause); }
      }
    });
    handle.child.on("error", stop);
    handle.child.stdin.on("error", stop);
    launchSignal = signal;
    launchAbort = () => stop(error("CODEX_RPC_CANCELLED"));
    signal?.addEventListener("abort", launchAbort, { once: true });
    lifetimeTimer = setTimeout(() => stop(error("CODEX_RPC_DEADLINE")), Math.max(1, deadlineAt - Date.now()));
    try {
      verifyRuntimeProcessSupervisorHandle(handle, { ownershipBinding, executablePathDigest: hash(path.resolve(executablePath)),
        executionRootDigest: expectedBinding.executionRootDigest, supervisorManifestDigest: supervisorSelection.manifest.manifestHash });
      record({ event: "process-started", pid: handle.child.pid, parentPid: process.pid, command: supervisorSelection.binaryPath, cwd: executionRoot, ports: [] });
    } catch (cause) { stop(cause); throw cause; }
    return handle;
  }
  async function rawRequest({ requestId, method, params, signal, deadlineAt: requestedDeadline, maxResponseBytes = bounds.maxFrameBytes }) {
    ensureOpen();
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 64 * 1024 * 1024) fail("CODEX_RPC_RESPONSE_LIMIT");
    const key = idKey(requestId);
    if (used.has(key)) fail("CODEX_RPC_REQUEST_REPLAYED");
    if (used.size >= bounds.maxRequests) fail("CODEX_RPC_REQUEST_LIMIT");
    const expires = currentDeadline(requestedDeadline);
    if (!Number.isSafeInteger(expires) || expires <= Date.now() || signal?.aborted) fail(signal?.aborted ? "CODEX_RPC_CANCELLED" : "CODEX_RPC_DEADLINE");
    const mutation = mutationsForMode.has(method);
    const fingerprint = hash(JSON.stringify(canonical({ method, params })));
    if (mutation && mutations.has(fingerprint)) fail("CODEX_RPC_MUTATION_REPLAYED");
    used.add(key); if (mutation) mutations.add(fingerprint);
    let delivery;
    return new Promise((resolve, reject) => {
      let timer;
      const abort = () => stop(error("CODEX_RPC_CANCELLED"));
      const settle = (cause, result) => {
        if (!pending.delete(key)) return;
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        try { record({ event: cause ? "request-failed" : "request-returned", requestId, method,
          state: cause && mutation && delivery?.writeAttempted ? "uncertain" : cause ? "failed" : "returned",
          writeAttempted: delivery?.writeAttempted === true, code: cause?.code || null }); }
        catch (journalError) { cause = journalError; if (proposal) stop(cause); }
        cause ? reject(cause) : resolve(result);
      };
      const item = { method, maxResponseBytes, resolve: result => settle(null, result), reject: cause => settle(cause) };
      pending.set(key, item);
      timer = setTimeout(() => stop(error("CODEX_RPC_DEADLINE")), expires - Date.now());
      signal?.addEventListener("abort", abort, { once: true });
      try {
        // Historical event name denotes write-ahead intent, not physical send.
        // The journal is fallible/reentrant; both immediate and queued guards
        // must run after it. Neither same-ID nor new-ID mutation replay exists.
        record({ event: "request-sent", requestId, method, params, state: "prepared", writeAttempted: false });
        delivery = write({ id: requestId, method, params }, { signal, deadlineAt: expires, beforeWrite: () => {
          if (pending.get(key) !== item) fail("CODEX_RPC_TRANSPORT_CLOSED");
        } });
        deliveries.push({ requestId, method, delivery });
        delivery.catch(stop);
      } catch (cause) { stop(cause); }
    });
  }
  async function initialize(limits) {
    if (!initialized) initialized = (async () => {
      const response = await rawRequest({ ...limits, requestId: `head-initialize-${diagnosticId || authorizationHash}`, method: "initialize",
        params: { clientInfo: { name: "head-agent-bounded-worker", version: CODEX_APP_SERVER_TRANSPORT_VERSION }, capabilities: { experimentalApi: true, requestAttestation: false } } });
      if (!object(response) || ![response.codexHome, response.platformFamily, response.platformOs, response.userAgent].every(text)) fail("CODEX_RPC_INITIALIZE_MISMATCH");
      await write({ method: "initialized" }, limits);
      initializationComplete = true;
    })().catch(cause => { stop(cause); throw cause; });
    return initialized;
  }
  async function request(original) {
    const call = requestSnapshot(original, bounds.maxFrameBytes);
    const methods = preparation ? new Set(["config/read", "skills/list"])
      : proposal ? new Set(["config/read", "skills/list", "account/read", "model/list", "thread/start", "turn/start",
        ...(prefixSession ? ["thread/read", "thread/fork"] : [])]) : METHODS;
    if (!object(call) || !methods.has(call.method) || !object(call.params)) fail("CODEX_RPC_METHOD_UNSUPPORTED");
    const { method, params } = call;
    if (proposal) {
      const prefixMethod = prefixSession && ["thread/start", "thread/read", "thread/fork", "turn/start"].includes(method);
      if (!prefixMethod && freshSlots.has(method)) fail("CODEX_RPC_PROPOSAL_REQUEST_REPLAYED");
      if (method === "config/read" && !sameJson(params, { cwd: executionRoot, includeLayers: false })) fail("CODEX_RPC_PROPOSAL_PARAMS_MISMATCH");
      if (method === "skills/list" && (!freshConfigChecked || !sameJson(params, { cwds: [executionRoot], forceReload: true }))) fail("CODEX_RPC_PROPOSAL_PARAMS_MISMATCH");
      if (method === "account/read" && (!freshSkillsChecked || !sameJson(params, { refreshToken: false }))) fail("CODEX_RPC_PROPOSAL_PARAMS_MISMATCH");
      if (method === "model/list" && (!freshAccountChecked || !sameJson(params, { limit: 100, includeHidden: false }))) fail("CODEX_RPC_PROPOSAL_PARAMS_MISMATCH");
      if (prefixMethod) {
        if (!freshConfigChecked || !freshSkillsChecked || !freshAccountChecked || !freshModelChecked) fail("CODEX_RPC_PROPOSAL_PARAMS_MISMATCH");
        prefixSession.reserve(method, params);
      }
      if (!prefixMethod && method === "thread/start" && (!freshConfigChecked || !freshSkillsChecked || !freshAccountChecked || !freshModelChecked
        || !sameJson(params, proposal.threadParams))) fail("CODEX_RPC_PROPOSAL_PARAMS_MISMATCH");
      if (!prefixMethod && method === "turn/start" && (params.threadId !== freshThreadId || !freshThreadId
        || !Array.isArray(params.input) || params.input.length !== 1 || params.input[0]?.type !== "text"
        || typeof params.input[0].text !== "string" || hash(Buffer.from(params.input[0].text)) !== inputDigest
        || !object(params.outputSchema) || !sameJson(params, codexFreshProposalTurnParams({ policy: proposal.policy, threadId: freshThreadId,
          input: params.input[0].text, outputSchema: params.outputSchema })))) fail("CODEX_RPC_PROPOSAL_PARAMS_MISMATCH");
      // One slot per operation, reserved before the first await. Different IDs
      // or different inputs cannot create another thread or steer another turn.
      if (!prefixMethod) freshSlots.add(method);
    }
    if (preparation && (method === "config/read" ? !sameJson(params, { cwd: executionRoot, includeLayers: false })
      : !sameJson(params, { cwds: [executionRoot], forceReload: true }))) fail("CODEX_RPC_PROPOSAL_PARAMS_MISMATCH");
    if (readOnlyProbe && !preparation && !["account/read", "model/list"].includes(method)) fail("CODEX_RPC_READ_ONLY_PROBE");
    if (method === "account/read" && params.refreshToken !== false) fail("CODEX_RPC_ACCOUNT_REFRESH_FORBIDDEN");
    if (!prefixSession && method === "thread/fork" && (params.threadId !== sourceThreadId || Object.hasOwn(params, "path"))) fail("CODEX_RPC_SOURCE_TARGET_FORBIDDEN");
    if (!fixture && method === "thread/fork") assertCodexInstalledForkRequest(params);
    if (["turn/start", "thread/goal/clear"].includes(method) && !children.has(params.threadId)) fail("CODEX_RPC_SOURCE_TARGET_FORBIDDEN");
    if (["thread/read", "thread/goal/get"].includes(method) && params.threadId !== sourceThreadId && !children.has(params.threadId)) fail("CODEX_RPC_SOURCE_TARGET_FORBIDDEN");
    await initialize(call);
    return rawRequest(call);
  }
  async function nextNotification({ childThreadId, signal, deadlineAt: requestedDeadline } = {}) {
    ensureOpen();
    if (proposal && !freshTurnId) fail("CODEX_RPC_PROPOSAL_TURN_NOT_STARTED");
    if (!children.has(childThreadId)) fail("CODEX_RPC_SOURCE_TARGET_FORBIDDEN");
    const index = notifications.findIndex(item => item.params?.threadId === childThreadId);
    if (index !== -1) {
      const notification = notifications.splice(index, 1)[0];
      try { checkProposalNotification(notification); } catch (cause) { stop(cause); throw cause; }
      return notification;
    }
    const expires = currentDeadline(requestedDeadline);
    if (signal?.aborted || expires <= Date.now()) fail(signal?.aborted ? "CODEX_RPC_CANCELLED" : "CODEX_RPC_DEADLINE");
    return new Promise((resolve, reject) => {
      let timer;
      const abort = () => stop(error("CODEX_RPC_CANCELLED"));
      const settle = (cause, value) => {
        if (!waiters.delete(item)) return;
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        cause ? reject(cause) : resolve(value);
      };
      const item = { childThreadId, resolve: value => settle(null, value), reject: cause => settle(cause) };
      waiters.add(item);
      timer = setTimeout(() => stop(error("CODEX_RPC_DEADLINE")), expires - Date.now());
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      clearTimeout(lifetimeTimer); launchSignal?.removeEventListener("abort", launchAbort);
      if (proposal?.startupPromise && !handle) {
        proposal.startAbort.abort();
        await proposal.startupPromise.catch(() => {});
      }
      if (!handle) {
        if (proposal?.preflight?.cleanup) {
          verifiedCleanup = proposal.preflight.cleanup;
          if (verifiedCleanup.terminationRequested || verifiedCleanup.exitCode !== 0) fail("CODEX_RPC_UNCLEAN_EXIT");
          return verifiedCleanup;
        }
        return { started: false, actualProviderInvoked: false };
      }
      for (const item of [...pending.values()]) item.reject(failure || error("CODEX_RPC_TRANSPORT_CLOSED"));
      for (const item of [...waiters]) item.reject(failure || error("CODEX_RPC_TRANSPORT_CLOSED"));
      // EOF is the first graceful action; never send guessed fork/turn cleanup,
      // shut down a shared source app-server, or look up a process by name.
      // Fixed-size P5 diagnosis only. A request deadline and a process's EOF
      // response are different observations; neither implies graceful exit.
      const cleanupTiming = { startedAtMs: performance.now(), graceMs: terminationGraceMs,
        eofFlushedAtMs: null, eofRejected: false, softStopAtMs: null, hardStopAtMs: null };
      handle.endInput().then(() => { cleanupTiming.eofFlushedAtMs = performance.now(); }, () => { cleanupTiming.eofRejected = true; });
      let timer;
      // Fit EOF, soft stop and force-observation within the existing cleanup
      // budget; do not spend the entire native guard grace before first stop.
      const phaseMs = Math.max(1, Math.floor(terminationGraceMs / 3));
      await Promise.race([exactClose, new Promise(resolve => { timer = setTimeout(resolve, phaseMs); })]);
      clearTimeout(timer);
      if (!observedClose) {
        cleanupTiming.softStopAtMs = performance.now();
        forced = true; handle.terminate(false);
        await Promise.race([exactClose, new Promise(resolve => { timer = setTimeout(resolve, phaseMs); })]);
        clearTimeout(timer);
      }
      if (!observedClose) {
        cleanupTiming.hardStopAtMs = performance.now();
        handle.terminate(true);
        await Promise.race([exactClose, new Promise(resolve => { timer = setTimeout(resolve, terminationGraceMs - 2 * phaseMs); })]);
        clearTimeout(timer);
      }
      // Fresh proposal cannot return its consumed lease or erase its control
      // journal while the exact owned process may still be alive.
      if ((proposal || preparation) && !observedClose) await exactClose;
      const supervision = handle.finalize({ exactSupervisorExitObserved: observedClose, terminationRequested: forced });
      record({ event: "process-closed", pid: handle.child.pid, providerPid: supervision.providerPid, exitCode: closeCode,
        exactExitObserved: observedClose, forced, supervision, ports: [], cleanupTiming: { ...cleanupTiming, processCloseAtMs } });
      if (!observedClose || !supervision.treeCleanupVerified || !supervision.ownershipEstablished || !supervision.requestWritten) fail("CODEX_RPC_CLEANUP_UNCERTAIN");
      verifiedCleanup = Object.freeze({ started: true, actualProviderInvoked: !fixture, supervision });
      if (forced || closeCode !== 0) fail("CODEX_RPC_UNCLEAN_EXIT");
      return verifiedCleanup;
    })();
    closePromise.catch(() => {});
    return closePromise;
  }
  const api = { request, nextNotification, close,
    cleanup: async ({ reason, commit }) => {
      try { await close(); }
      catch (cause) {
        const cancelled = reason === (proposal ? "CODEX_FRESH_PROPOSAL_CANCELLED" : "CODEX_NATIVE_FORK_CANCELLED") && failure?.code === "CODEX_RPC_CANCELLED";
        const timedOut = reason === (proposal ? "CODEX_FRESH_PROPOSAL_DEADLINE" : "CODEX_NATIVE_FORK_DEADLINE") && ["CODEX_RPC_DEADLINE", "CODEX_RPC_CANCELLED"].includes(failure?.code);
        // Caller reason alone and a serialized cleanup flag prove nothing.
        // Only this connection's private verified native outcome can settle an
        // internally observed stop; strict close/success semantics stay intact.
        if (cause.code !== "CODEX_RPC_UNCLEAN_EXIT" || !verifiedCleanup || !cancelled && !timedOut) throw cause;
      }
      return commit();
    },
    inspect: () => ({ evidenceMode: fixture ? "protocol-fixture" : "actual-provider", started: handle !== null || proposal?.preflightStarted === true,
      initialized: initializationComplete, closed: observedClose, failureCode: failure?.code || null,
      actualProviderInvoked: !fixture && (handle !== null || proposal?.preflightStarted === true), modelCallAttempted: !readOnlyProbe && deliveries.some(item => item.method === "turn/start" && item.delivery.writeAttempted),
      readOnlyProbe, transcript: structuredClone(transcript), ...(prefixSession ? { prefix: prefixSession.inspect() } : {}), ...(proposal ? { freshThreadId, freshTurnId,
        stderr: { bytes: stderrBytes, digest: stderrHash.copy().digest("hex") },
        preflight: proposal.preflight ? structuredClone({ cleanup: proposal.preflight.cleanup, failureCode: proposal.preflight.failure?.code || null }) : null,
        cleanup: verifiedCleanup ? structuredClone(handle ? { ...verifiedCleanup, exitCode: closeCode, terminationRequested: forced, exactExitObserved: observedClose } : verifiedCleanup) : null } : {}) }) };
  if (proposal) {
    const ownedTransport = Object.freeze(Object.create(null));
    proposalTransports.set(ownedTransport, { spawnOwned, proposal, expectedBinding, executionRoot, fixture, options, record, stop,
      assertLaunchOpen: () => { if (failure) throw failure; if (closing || observedClose || handle) fail("CODEX_RPC_TRANSPORT_CLOSED"); } });
    return Object.freeze({ ...api, ...(prefixSession ? { prefixParams: prefixSession.params } : {}), ownedTransport });
  }
  if (readOnlyProbe) return Object.freeze({ ...api, ownedTransport: null,
    startReadOnly: ({ deadlineAt, signal } = {}) => {
      const owned = spawnOwned({ deadlineAt, signal, ownershipBinding: { ...expectedBinding } });
      // Observation never exposes raw RPC/stdin or a worker execution handle.
      return Object.freeze({ pid: owned.child.pid, parentPid: process.pid, started: true });
    } });
  if (fixture && options.nativeOwnership !== true) return Object.freeze({ ...api, startFixture: spawnOwned, ownedTransport: null });
  const ownedTransport = createCodexNativeForkOwnedTransport({ evidenceMode: fixture ? "protocol-fixture" : "actual-provider", withVerifiedOwnership: async ({ ownershipBinding, commit, ...binding }) => {
    if (binding.authorizationHash !== authorizationHash || binding.policyDigest !== policyDigest || binding.inputDigest !== inputDigest
      || binding.source?.threadId !== sourceThreadId || binding.supervisorManifestDigest !== supervisorSelection.manifest.manifestHash
      || path.resolve(binding.executionRoot) !== path.resolve(executionRoot)) fail("CODEX_RPC_BINDING_MISMATCH");
    return commit(spawnOwned);
  } });
  return Object.freeze({ ...api, ownedTransport });
}

export function assertCodexFreshProposalFeatureList({ policy, stdout }) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout) > 512 * 1024) fail("CODEX_FRESH_PROPOSAL_FEATURE_LIST_INVALID");
  const observed = new Map();
  for (const line of stdout.split(/\r?\n/u).filter(line => line.trim())) {
    const match = /^([a-z0-9_]+)\s+(.+?)\s+(true|false)\s*$/u.exec(line);
    if (!match || observed.has(match[1])) fail("CODEX_FRESH_PROPOSAL_FEATURE_LIST_INVALID");
    observed.set(match[1], match[3] === "true");
  }
  for (const [feature, enabled] of Object.entries(policy.startupConfig.features)) {
    if (enabled !== false || observed.get(feature) !== false) fail("CODEX_FRESH_PROPOSAL_FEATURE_REMAINS_ENABLED");
  }
  return { featureCount: observed.size, fixedDisabledCount: Object.keys(policy.startupConfig.features).length };
}

// FeaturesList loads the source-pinned managed configuration without starting
// AppServer/PluginManager. It is still an exact owned process under this already
// consumed lease, never a second authorization or a model invocation.
async function featurePreflight({ policy, authorization, consumption, selection, executablePath, executionRoot,
  environment, controlFile, deadlineAt, signal, assertCurrent, record, onProcessEvent, onCleanup, onStarted, onStderrChunk, fixtureScenario = null,
  observation = null, invocationPolicyDigest = null, prefixPolicy = null }) {
  const args = fixtureScenario ? [PROPOSAL_FIXTURE, `features-${fixtureScenario}`]
    : ["features", "list", ...(prefixPolicy ? codexNativePrefixStartupArguments(prefixPolicy) : codexFreshProposalStartupArguments(policy)).slice(3)];
  const ownershipBinding = observation ? { diagnosticId: observation.id, executionRootDigest: hash(executionRoot), stage: "proposal-host-discovery" }
    : { authorizationHash: authorization.authorizationHash, consumptionId: consumption.consumptionId,
    policyDigest: invocationPolicyDigest || hash(JSON.stringify(policy)), inputDigest: authorization.executionInput.digest,
    executionRootDigest: authorization.workerInput.executionBoundary.executionRootDigest, stage: "proposal-feature-preflight" };
  const operationLimits = observation ? { terminationGraceMs: 1000, maxStdoutBytes: 512 * 1024, maxStderrBytes: 256 * 1024 } : authorization.limits;
  const chunks = [], stderr = [];
  let outputBytes = 0, errorBytes = 0, handle, failure = null, closed = false, exitCode = null, terminated = false;
  let timer, forceTimer, closeDeadline;
  const stop = reason => {
    failure ||= reason;
    if (!handle || closed || terminated) return;
    terminated = true; handle.terminate(false);
    forceTimer = setTimeout(() => { if (!closed) handle.terminate(true); }, Math.max(1, Math.floor(operationLimits.terminationGraceMs / 2)));
  };
  const abort = () => stop(Object.assign(new Error("Feature preflight cancelled"), { code: "CODEX_FRESH_PROPOSAL_CANCELLED" }));
  assertCurrent();
  onProcessEvent({ type: "planned", command: executablePath, args, cwd: executionRoot, parentPid: process.pid, ports: [] });
  assertCurrent();
  handle = spawnSupervisedProcess({ selection, executablePath, args, cwd: executionRoot, providerEnvironment: environment,
    input: Buffer.alloc(0), controlFile, terminationGraceMs: operationLimits.terminationGraceMs, ownershipBinding,
    onControlEvent: event => record({ event: "preflight-control", control: event }) });
  const exactClose = new Promise(resolve => handle.child.once("close", code => { closed = true; exitCode = code; resolve(); }));
  onStarted();
  handle.child.on("error", stop);
  handle.child.stdin.on("error", stop);
  handle.child.stdout.on("data", chunk => {
    outputBytes += chunk.length;
    if (outputBytes > Math.min(operationLimits.maxStdoutBytes, 512 * 1024)) stop(Object.assign(new Error("Feature output limit"), { code: "CODEX_FRESH_PROPOSAL_OUTPUT_LIMIT" }));
    else chunks.push(Buffer.from(chunk));
  });
  handle.child.stderr.on("data", chunk => {
    errorBytes += chunk.length;
    if (errorBytes > operationLimits.maxStderrBytes) stop(Object.assign(new Error("Feature stderr limit"), { code: "CODEX_FRESH_PROPOSAL_OUTPUT_LIMIT" }));
    else {
      stderr.push(Buffer.from(chunk));
      if (onStderrChunk) {
        try {
          const returned = onStderrChunk(Buffer.from(chunk));
          if (returned && typeof returned.then === "function") fail("CODEX_RPC_SYNCHRONOUS_OBSERVER_REQUIRED");
        } catch (cause) { stop(cause); }
      }
    }
  });
  try {
    verifyRuntimeProcessSupervisorHandle(handle, { ownershipBinding, executablePathDigest: policy.executableIdentity.pathDigest,
      executionRootDigest: ownershipBinding.executionRootDigest, supervisorManifestDigest: selection.manifest.manifestHash });
    onProcessEvent({ type: "spawn", pid: handle.child.pid, parentPid: process.pid, command: selection.binaryPath, cwd: executionRoot, ports: [] });
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => stop(Object.assign(new Error("Feature deadline"), { code: "CODEX_FRESH_PROPOSAL_DEADLINE" })), Math.max(1, deadlineAt - Date.now()));
    if (signal?.aborted) abort();
  } catch (error) { stop(error); }
  try {
    closeDeadline = setTimeout(() => {
      if (!closed) {
        failure ||= Object.assign(new Error("Feature preflight exceeded cleanup grace"), { code: "CODEX_FRESH_PROPOSAL_CLEANUP_UNCERTAIN" });
        terminated = true; handle.terminate(true);
      }
    }, Math.max(1, deadlineAt + operationLimits.terminationGraceMs - Date.now()));
    // Never release the consumed lease while a launched exact child is still
    // running. Native tree termination remains owned until its close event.
    await exactClose;
    const supervision = handle.finalize({ exactSupervisorExitObserved: closed, terminationRequested: terminated });
    if (!closed || !supervision.treeCleanupVerified || !supervision.ownershipEstablished || !supervision.requestWritten
      || !supervision.providerChildStarted) fail("CODEX_FRESH_PROPOSAL_CLEANUP_UNCERTAIN");
    const cleanup = { started: true, actualProviderInvoked: fixtureScenario === null, supervision, exitCode, terminationRequested: terminated, exactExitObserved: closed };
    onCleanup(cleanup);
    try { record({ event: "preflight-closed", pid: handle.child.pid, exitCode, supervision }); } catch (cause) { failure ||= cause; }
    try { onProcessEvent({ type: "exit", pid: handle.child.pid, parentPid: process.pid, exitCode, ports: [] }); }
    catch (error) { failure ||= error; }
    if (!failure && (exitCode !== 0 || terminated || !supervision.providerChildExitObserved)) failure = Object.assign(new Error("Feature preflight failed"), { code: "CODEX_FRESH_PROPOSAL_PREFLIGHT_FAILED" });
    if (!failure) {
      try { assertCodexFreshProposalFeatureList({ policy, stdout: Buffer.concat(chunks).toString("utf8") }); }
      catch (error) { failure = error; }
    }
    return { cleanup,
      failure, stdout: Buffer.concat(chunks), stderr: Buffer.concat(stderr) };
  } finally { clearTimeout(timer); clearTimeout(forceTimer); clearTimeout(closeDeadline); signal?.removeEventListener("abort", abort); }
}

export function createCodexAppServerTransport(options = {}) { return makeTransport(options, false); }

// Ordinary local observation, not a worker ExecutionAuthorization or substitute
// for effective-policy proof. This entry cannot create/read/mutate threads,
// fork, clear a goal, start a turn, refresh credentials, or mint a worker Host.
export function createCodexAppServerReadOnlyProbe(options = {}) { return makeTransport(options, false, true); }

// Built-in Host discovery, not a worker launch or a caller assertion of policy.
// Only fixed features/config/skill observation is possible: no account refresh,
// account/model read, thread, turn, provider input or execution lease is exposed.
export async function inspectCodexFreshProposalHostInventory({ policy, executionRoot, controlFile, supervisorSelection,
  signal, onProcess = () => {}, verifyInventory = false } = {}) {
  const fixed = verifyCodexFreshProposalPolicyPlan(policy);
  if (fixed.evidenceMode !== "actual-provider") fail("CODEX_RPC_HOST_DISCOVERY_ACTUAL_ONLY");
  const assertCurrent = () => {
    if (signal?.aborted) fail("CODEX_RPC_CANCELLED");
    const current = buildCodexFreshProposalPolicyPlan({ ...fixed, approvedGlobalInstructionDigests:
      Object.fromEntries(fixed.globalInstructionState.filter(item => item.selected).map(item => [item.name, item.digest])) });
    if (!sameJson(current, fixed)) fail("CODEX_RPC_HOST_DISCOVERY_DRIFT");
  };
  const deadlineAt = Date.now() + 15000;
  const environment = codexFreshProposalEnvironment({ policy: fixed });
  const preflight = await featurePreflight({ policy: fixed, observation: { id: `host-discovery-${crypto.randomUUID()}` },
    selection: supervisorSelection, executablePath: fixed.executablePath, executionRoot, environment,
    controlFile: `${controlFile}.features`, deadlineAt, signal, assertCurrent,
    record: event => { if (event.control) onProcess({ type: "native-control", phase: "host-discovery-features", control: event.control, ports: [] }); },
    onProcessEvent: event => onProcess({ ...event, phase: "host-discovery-features" }), onCleanup: () => {}, onStarted: () => {} });
  if (preflight.failure) throw preflight.failure;
  assertCurrent();
  const transport = makeTransport({ executablePath: fixed.executablePath, executableDigest: fixed.executableIdentity.contentDigest,
    supervisorSelection, executionRoot, controlFile, providerEnvironment: environment,
    recordOperationalEvidence: event => {
      if (event.event === "supervisor-control") onProcess({ type: "native-control", phase: "host-discovery", control: event.control, ports: [] });
      const type = { "process-planned": "planned", "process-started": "spawn", "process-closed": "exit" }[event.event];
      if (type) onProcess({ type, phase: "host-discovery", pid: event.pid, parentPid: event.parentPid,
        providerPid: event.providerPid, command: event.command, args: event.args, cwd: executionRoot, exitCode: event.exitCode, ports: [] });
    } }, false, true, null, fixed);
  try {
    transport.startReadOnly({ deadlineAt, signal });
    const config = await transport.request({ requestId: "host-config", method: "config/read", params: { cwd: executionRoot, includeLayers: false }, deadlineAt, signal });
    const skills = await transport.request({ requestId: "host-skills", method: "skills/list", params: { cwds: [executionRoot], forceReload: true }, deadlineAt, signal });
    if (!object(config?.config?.mcp_servers) || !Array.isArray(skills?.data) || skills.data.length !== 1
      || skills.data[0].cwd !== executionRoot || !Array.isArray(skills.data[0].errors) || skills.data[0].errors.length
      || !Array.isArray(skills.data[0].skills)) fail("CODEX_RPC_HOST_DISCOVERY_INCOMPLETE");
    if (verifyInventory) {
      assertCodexFreshProposalEffectiveConfig({ policy: fixed, response: config });
      assertCodexFreshProposalSkills({ policy: fixed, response: skills, executionRoot });
    }
    assertCurrent();
    return { mcpServerNames: Object.keys(config.config.mcp_servers), disabledSkillPaths: [...new Set(skills.data[0].skills.map(skill => skill.path))],
      modelCallAttempted: false, accountInspected: false, recoveryAuthority: false };
  } finally {
    const cleanup = await transport.close();
    const state = transport.inspect();
    if (state.started && !cleanup?.supervision?.treeCleanupVerified) fail("CODEX_RPC_HOST_DISCOVERY_CLEANUP_UNCERTAIN");
    if (state.failureCode) throw error(state.failureCode);
  }
}

// Explicit model-free subprocess diagnostics. No custom executable/arguments,
// no actual owned capability, and therefore no route to actual native admission.
export function createCodexAppServerProtocolFixtureTransport(options = {}) {
  if (options.executablePath !== undefined || options.executableDigest !== undefined) fail("CODEX_RPC_FIXTURE_TARGET_FIXED");
  return makeTransport({ ...options, executablePath: process.execPath, executableDigest: hash(fs.readFileSync(process.execPath)) }, true, options.readOnlyProbe === true);
}

function freshProposalTransport(options, fixtureScenario = null, nativePrefix = false) {
  const allowed = new Set(["executablePath", "executableDigest", "supervisorSelection", "executionRoot", "controlFile", "providerEnvironment",
    "terminationGraceMs", "recordOperationalEvidence", "authorizationHash", "policyDigest", "inputDigest", "policy", "limits", "root", "authorization", "workspaceBinding", "preflightControlFile", "onStderrChunk",
    ...(nativePrefix ? ["resultSchema"] : [])]);
  if (!object(options) || Object.keys(options).some(key => !allowed.has(key))) fail("CODEX_RPC_PROPOSAL_CONFIGURATION");
  if (options.onStderrChunk !== undefined && typeof options.onStderrChunk !== "function") fail("CODEX_RPC_PROPOSAL_CONFIGURATION");
  const prefixPolicy = nativePrefix ? verifyCodexNativePrefixPolicyPlan(options.policy) : null;
  const policy = prefixPolicy?.recipe || verifyCodexFreshProposalPolicyPlan(options.policy);
  const fixture = fixtureScenario !== null;
  const executablePath = fixture ? fs.realpathSync(process.execPath) : options.executablePath;
  const executableDigest = fixture ? hash(fs.readFileSync(executablePath)) : options.executableDigest;
  if (policy.evidenceMode !== (fixture ? "protocol-fixture" : "actual-provider") || options.policyDigest !== hash(JSON.stringify(prefixPolicy || policy))
    || policy.executableIdentity.pathDigest !== hash(path.resolve(executablePath)) || policy.executableIdentity.contentDigest !== executableDigest
    || path.resolve(options.executionRoot) !== fs.realpathSync(options.executionRoot)
    || options.providerEnvironment?.CODEX_HOME !== policy.codexHome) fail("CODEX_RPC_PROPOSAL_BINDING_MISMATCH");
  if (fixture && (options.executablePath !== undefined && options.executablePath !== executablePath
    || options.executableDigest !== undefined && options.executableDigest !== executableDigest)) fail("CODEX_RPC_FIXTURE_TARGET_FIXED");
  const args = Object.freeze(prefixPolicy ? codexNativePrefixStartupArguments(prefixPolicy) : codexFreshProposalStartupArguments(policy));
  const binding = { root: options.root, authorization: structuredClone(options.authorization), workspaceBinding: structuredClone(options.workspaceBinding),
    policy: prefixPolicy || policy, executablePath, codexHome: policy.codexHome };
  const prepared = (nativePrefix ? assertCodexNativePrefixPolicy : assertCodexFreshProposalPolicy)(binding);
  if (prepared.inputDigest !== options.inputDigest || prepared.executionRoot !== options.executionRoot
    || binding.authorization.authorizationHash !== options.authorizationHash) fail("CODEX_RPC_PROPOSAL_BINDING_MISMATCH");
  const threadParams = requestSnapshot({ requestId: "fixed-thread-params", method: "thread/start",
    params: codexFreshProposalThreadParams({ policy, executionRoot: options.executionRoot }) }, 1024 * 1024).params;
  return makeTransport({ ...options, executablePath, executableDigest,
    // The source-pinned marker closes persisted remote-control activation for
    // this owned child only. No inherited process environment is modified.
    providerEnvironment: codexFreshProposalEnvironment({ policy, environment: options.providerEnvironment }),
    ...(fixture ? { scenario: fixtureScenario.startsWith("preflight-") ? "normal" : fixtureScenario } : {}) }, fixture, false,
  { policy, prefixPolicy, resultSchema: nativePrefix ? structuredClone(options.resultSchema) : null,
    args, threadParams, binding, beforeSpawn: null, fixturePreflight: fixtureScenario?.startsWith("preflight-") ? fixtureScenario.slice(10) : null });
}

// Separate surface: fresh proposal execution never widens native-fork or the
// read-only probe. The opaque connection has no raw start/handle/argv escape.
export function createCodexFreshProposalTransport(options = {}) {
  return freshProposalTransport(options);
}

// Separate fixed constructor; callers cannot supply source IDs, provenance
// claims, custom launch arguments or a replacement implementation.
export function createCodexNativePrefixProposalTransport(options = {}) {
  return freshProposalTransport(options, null, true);
}

export function createCodexFreshProposalFixtureCapability({ scenario = "normal" } = {}) {
  if (!["normal", "wrong-model", "wrong-root", "inherited-thread", "wrong-policy", "lost-start", "lost-turn", "approval",
    "wrong-event-thread", "wrong-event-turn", "early-notification", "hang-turn", "enabled-mcp", "enabled-skill", "environment-check",
    "preflight-normal", "preflight-hang", "preflight-enabled", "trailing-effect", "duplicate-completion", "encoded-sensitive-result",
    "trailing-partial", "start-effect-item", "catalog-incomplete", "model-unavailable",
    "prefix-normal", "prefix-source-tools", "prefix-history-drift", "prefix-child-failed", "prefix-lost-fork",
    "missing-result", "summary-without-direct", "summary-drift", "not-loaded-result", "terminal-failed",
    "prefix-missing-result", "prefix-summary-without-direct", "prefix-summary-drift", "prefix-not-loaded-result",
    "prefix-seed-missing-result", "prefix-seed-summary-without-direct", "prefix-seed-not-loaded-result",
    "prefix-duplicate-completion", "prefix-trailing-effect", "prefix-wrong-event-thread", "prefix-wrong-event-turn",
    "prefix-source-summary-read", "prefix-raw-config-drift", "prefix-stored-reordered", "prefix-stored-duplicate", "prefix-stored-missing",
    "prefix-stored-extra", "prefix-stored-tool", "prefix-stored-input-drift", "prefix-stored-reasoning-drift", "prefix-stored-agent-field-drift"].includes(scenario)) fail("CODEX_RPC_PROPOSAL_FIXTURE_SCENARIO");
  const capability = Object.freeze(Object.create(null));
  proposalFixtures.set(capability, scenario);
  return capability;
}

export function inspectCodexFreshProposalFixtureCapability(capability) {
  if (!proposalFixtures.has(capability)) fail("CODEX_RPC_PROPOSAL_FIXTURE_CAPABILITY");
  return Object.freeze({ evidenceMode: "protocol-fixture", actualProviderInvoked: false });
}

export function createCodexFreshProposalProtocolFixtureTransport(options = {}, { capability } = {}) {
  inspectCodexFreshProposalFixtureCapability(capability);
  return freshProposalTransport(options, proposalFixtures.get(capability));
}

export function createCodexNativePrefixProposalFixtureTransport(options = {}, { capability } = {}) {
  inspectCodexFreshProposalFixtureCapability(capability);
  const scenario = proposalFixtures.get(capability);
  if (!scenario.startsWith("prefix-")) fail("CODEX_RPC_PROPOSAL_FIXTURE_SCENARIO");
  return freshProposalTransport(options, scenario, true);
}

export async function startCodexFreshProposalTransport({ ownedTransport, projectRoot, operationalStateRoot, authorization, lease, consumption,
  executionRoot, policyDigest, inputDigest, deadlineAt, signal } = {}) {
  const entry = proposalTransports.get(ownedTransport);
  if (!entry || !consumption || authorization?.runtime !== "codex" || authorization.authorizationHash !== entry.expectedBinding.authorizationHash
    || authorization.executionInput?.digest !== inputDigest || inputDigest !== entry.expectedBinding.inputDigest
    || policyDigest !== entry.expectedBinding.policyDigest || authorization.workerInput?.executionBoundary?.policyDigest !== policyDigest
    || authorization.workerInput?.executionBoundary?.executionRootDigest !== entry.expectedBinding.executionRootDigest
    || authorization.runtimeSelection?.model !== entry.proposal.policy.model || authorization.workspaceMode !== "read-only"
    || executionRoot !== entry.executionRoot || !Number.isSafeInteger(deadlineAt)
    || deadlineAt > Math.min(Date.parse(consumption.consumedAt) + authorization.limits.timeoutMs,
      Date.parse(consumption.holdDeadlineAt) - authorization.limits.terminationGraceMs)) fail("CODEX_RPC_PROPOSAL_BINDING_MISMATCH");
  const verifyOwner = () => {
    entry.assertLaunchOpen();
    (entry.proposal.prefixPolicy ? assertCodexNativePrefixPolicy : assertCodexFreshProposalPolicy)(entry.proposal.binding);
    verifyRuntimeExecutionLeaseOwnership({ projectRoot, operationalStateRoot, authorization, lease, consumption });
    if (signal?.aborted || entry.proposal.startAbort?.signal.aborted) fail("CODEX_RPC_CANCELLED");
    if (Date.now() >= deadlineAt) fail("CODEX_RPC_DEADLINE");
  };
  verifyOwner();
  const invocationKey = `${authorization.authorizationHash}:${consumption.consumptionId}`;
  if (proposalConsumptions.has(invocationKey)) fail("CODEX_RPC_PROPOSAL_CONSUMPTION_REPLAYED");
  proposalConsumptions.add(invocationKey);
  entry.proposal.beforeSpawn = verifyOwner;
  entry.proposal.startAbort = new AbortController();
  const launchSignal = AbortSignal.any([entry.proposal.startAbort.signal, ...(signal ? [signal] : [])]);
  // Store the promise before the first callback can reenter close. Closing a
  // preflight aborts and awaits this exact owned process, never a caller proof.
  entry.proposal.startupPromise = Promise.resolve().then(async () => {
    if (!entry.fixture || entry.proposal.fixturePreflight) {
      const opts = entry.options;
      entry.proposal.preflight = await featurePreflight({ policy: entry.proposal.policy, authorization, consumption,
        invocationPolicyDigest: entry.expectedBinding.policyDigest,
        prefixPolicy: entry.proposal.prefixPolicy,
        selection: opts.supervisorSelection, executablePath: opts.executablePath, executionRoot,
        environment: opts.providerEnvironment, controlFile: opts.preflightControlFile || `${opts.controlFile}.preflight`, deadlineAt, signal: launchSignal,
        assertCurrent: verifyOwner, record: entry.record, fixtureScenario: entry.proposal.fixturePreflight,
        onStarted: () => { entry.proposal.preflightStarted = true; },
        onCleanup: cleanup => { entry.proposal.preflight = { cleanup, failure: null }; }, onStderrChunk: opts.onStderrChunk,
        onProcessEvent: event => entry.record({ ...event, event: `preflight-${event.type}`, type: undefined }) });
      if (entry.proposal.preflight.failure) throw entry.proposal.preflight.failure;
    }
    verifyOwner();
    const handle = entry.spawnOwned({ ownershipBinding: { ...entry.expectedBinding, consumptionId: consumption.consumptionId }, deadlineAt, signal: launchSignal });
    return Object.freeze({ pid: handle.child.pid, parentPid: process.pid, started: true });
  }).catch(cause => {
    const code = { CODEX_FRESH_PROPOSAL_CANCELLED: "CODEX_RPC_CANCELLED", CODEX_FRESH_PROPOSAL_DEADLINE: "CODEX_RPC_DEADLINE" }[cause.code];
    const mapped = code ? Object.assign(error(code), { cause }) : cause;
    entry.stop(mapped); throw mapped;
  });
  return entry.proposal.startupPromise;
}
