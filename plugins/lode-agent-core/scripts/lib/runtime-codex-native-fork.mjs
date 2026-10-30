import crypto from "node:crypto";
import path from "node:path";
import { ChildProcess } from "node:child_process";
import {
  buildRuntimeInvocationLifecycleReceipt,
  normalizeRuntimeEvent,
  verifyRuntimeInvocationAuthorization,
  verifyRuntimeStructuredResult,
} from "./runtime-invocation-lifecycle.mjs";
import { verifyRuntimeExecutionLeaseOwnership } from "./runtime-execution-lease.mjs";
import { openRuntimeOutputSpool } from "./runtime-output-spool.mjs";
import { verifyCodexWorkerPolicyPlan } from "./runtime-codex-worker-policy.mjs";
import { verifyProcessSupervisorManifest, verifyRuntimeProcessSupervisorHandle } from "./runtime-process-supervisor.mjs";
import { inspectCurrentCodexNativeForkCompatibility } from "./runtime-codex-fork-compatibility.mjs";

// Optional P5 adapter. No process, connection, authorization or lease is created
// here. The fixed Codex runner owns the existing lease and result publication.
// Installed 0.153.4 schemas prove syntax, not instruction/tool/goal isolation.
export const CODEX_NATIVE_FORK_VERSION = "0.1.0";
export const CODEX_NATIVE_FORK_ACTUAL_UNAVAILABLE = "CODEX_NATIVE_FORK_INSTALLED_ENFORCEMENT_UNPROVEN";
const hosts = new WeakMap();
const ownedTransports = new WeakMap();
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
const copy = value => structuredClone(value);
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }); };
const requireText = value => typeof value === "string" && value.length > 0 && value.length <= 4096;

function prefix(read, threadId, lastTurnId) {
  const thread = read?.thread;
  if (thread?.id !== threadId || !Array.isArray(thread.turns) || thread.historyMode === "paginated") {
    fail("CODEX_NATIVE_FORK_SOURCE_MISMATCH");
  }
  const ids = thread.turns.map(turn => turn.id);
  if (new Set(ids).size !== ids.length || ids.some(id => !requireText(id))) fail("CODEX_NATIVE_FORK_INVALID_HISTORY");
  const index = ids.indexOf(lastTurnId);
  if (index < 0) fail("CODEX_NATIVE_FORK_STALE_CUTOFF");
  const turns = thread.turns.slice(0, index + 1);
  if (turns.at(-1).status !== "completed" || turns.at(-1).error != null) fail("CODEX_NATIVE_FORK_CUTOFF_NOT_COMPLETED");
  if (turns.some(turn => !["completed", "failed", "interrupted"].includes(turn.status))) fail("CODEX_NATIVE_FORK_UNFINISHED_PREFIX");
  if (turns.some(turn => !Array.isArray(turn.items) || turn.itemsView && turn.itemsView !== "full")) {
    fail("CODEX_NATIVE_FORK_INCOMPLETE_HISTORY");
  }
  return turns;
}

// Freeze this digest in the shared pre-authorized policy. Raw source/thread
// identity stays P5; the digest supplies neither recovery direction nor a claim
// that inherited content has no instruction authority.
export function codexNativeForkPrefixDigest({ sourceRead, threadId, lastTurnId }) {
  return hash(json(prefix(sourceRead, threadId, lastTurnId)));
}

export function verifyCodexNativeForkSource({ sourceRead, source }) {
  const turns = prefix(sourceRead, source.threadId, source.lastTurnId);
  if (hash(json(turns)) !== source.prefixDigest) fail("CODEX_NATIVE_FORK_STALE_CUTOFF");
  return copy(turns);
}

// This connection is established only by trusted Host composition. Its guard
// must bind the dedicated transport's native supervisor, executable and cwd to
// this invocation; a shared/source app-server process is never an owned child.
// commit receives a synchronous factory returning a spawnSupervisedProcess
// handle, not a JSON claim or a pre-existing source process. The adapter invokes
// that factory only while the guard/deadline is open inside the consumed lease;
// an expired callback cannot spawn a late transport.
export function createCodexNativeForkOwnedTransport({ withVerifiedOwnership, evidenceMode = "actual-provider" } = {}) {
  if (typeof withVerifiedOwnership !== "function" || !["actual-provider", "protocol-fixture"].includes(evidenceMode)) fail("CODEX_NATIVE_FORK_OWNERSHIP_UNAVAILABLE");
  const capability = Object.freeze(Object.create(null));
  ownedTransports.set(capability, { withVerifiedOwnership, evidenceMode });
  return capability;
}

/** Host-only construction; never accept this configuration from MCP/tool JSON.
 * withVerifiedFork must validate inherited-content treatment and effective
 * model/permissions/instructions/tools plus child-only goal suppression while
 * holding its enforcement guard, then await commit exactly once. Returning a
 * boolean or a purported proof object does not admit execution.
 * cleanup uses the exact journaled request identities, including an uncertain
 * fork with no known child ID. It must settle/quiesce its owned child and await
 * commit; it must never mutate the source or guess a child from recent history.
 */
export function createCodexNativeForkHost({ evidenceMode = "protocol-fixture", source, rebind,
  authorizationHash, policyDigest, inputDigest, request, nextNotification, withVerifiedFork,
  cleanup, recordOperationalEvidence, effectDeadlineAt = null, ownedTransport = null } = {}) {
  if (!["protocol-fixture", "actual-provider"].includes(evidenceMode)
    || !source || !requireText(source.threadId) || !requireText(source.lastTurnId)
    || !/^[a-f0-9]{64}$/.test(source.prefixDigest || "")
    || [authorizationHash, policyDigest, inputDigest].some(value => !/^[a-f0-9]{64}$/.test(value || ""))
    || !rebind || !requireText(rebind.modelProvider) || !requireText(rebind.permissions)
    || typeof rebind.baseInstructions !== "string" || typeof rebind.developerInstructions !== "string"
    || !rebind.expectedSandbox || !Array.isArray(rebind.instructionSources)
    || Object.keys(rebind).some(key => !["modelProvider", "permissions", "baseInstructions", "developerInstructions", "expectedSandbox", "instructionSources"].includes(key))
    || rebind.instructionSources.some(value => typeof value !== "string")
    || [request, nextNotification, withVerifiedFork, cleanup, recordOperationalEvidence].some(value => typeof value !== "function")
    || effectDeadlineAt !== null && !Number.isSafeInteger(effectDeadlineAt)
    || ownedTransport !== null && ownedTransports.get(ownedTransport)?.evidenceMode !== evidenceMode) fail("INVALID_CODEX_NATIVE_FORK_HOST");
  const host = Object.freeze({ kind: "CodexNativeForkHost" });
  hosts.set(host, { evidenceMode, source: copy(source), rebind: copy(rebind), authorizationHash, policyDigest,
    inputDigest, request, nextNotification, withVerifiedFork, cleanup, recordOperationalEvidence, effectDeadlineAt, ownedTransport, used: false });
  return host;
}

export function inspectCodexNativeForkHost(host) {
  const entry = hosts.get(host);
  if (!entry) fail("CODEX_NATIVE_FORK_HOST_UNAVAILABLE");
  // Native ownership proves cleanup, not installed API compatibility. The
  // current ephemeral + goal/readback sequence is rejected by the audited
  // provider; even an actual owned callback cannot make it executable.
  const available = entry.evidenceMode === "protocol-fixture";
  return { available, evidenceMode: entry.evidenceMode,
    reason: !available ? CODEX_NATIVE_FORK_ACTUAL_UNAVAILABLE : null,
    actualProviderInvoked: false, sourcePrefixDigest: entry.source.prefixDigest };
}

function verifyChild(response, source, expectedTurns, binding) {
  const child = response?.thread;
  if (!requireText(child?.id) || child.id === source.threadId || child.forkedFromId !== source.threadId) {
    fail("CODEX_NATIVE_FORK_CHILD_MISMATCH");
  }
  if (json(child.turns) !== json(expectedTurns)) fail("CODEX_NATIVE_FORK_HISTORY_LEAK");
  if (child.status?.type !== "idle" || child.ephemeral !== true) fail("CODEX_NATIVE_FORK_CHILD_NOT_IDLE");
  if (response.model !== binding.model || child.model !== binding.model
    || response.modelProvider !== binding.modelProvider || child.modelProvider !== binding.modelProvider) fail("CODEX_NATIVE_FORK_MODEL_MISMATCH");
  if (response.cwd !== binding.executionRoot || child.cwd !== binding.executionRoot
    || json(response.runtimeWorkspaceRoots) !== json([binding.executionRoot])) fail("CODEX_NATIVE_FORK_ROOT_MISMATCH");
  if (response.approvalPolicy !== "never" || response.approvalsReviewer !== "user"
    || response.activePermissionProfile?.id !== binding.permissions
    || json(response.sandbox) !== json(binding.expectedSandbox)
    || json(response.instructionSources) !== json(binding.instructionSources)) fail("CODEX_NATIVE_FORK_POLICY_MISMATCH");
}

export function extractCodexNativeForkResult({ notification, threadId, turnId, scopeKind }) {
  if (notification?.method !== "turn/completed" || notification.params?.threadId !== threadId
    || notification.params?.turn?.id !== turnId) fail("CODEX_NATIVE_FORK_TURN_MISMATCH");
  const turn = notification.params.turn;
  if (turn.status !== "completed" || turn.error != null) fail("CODEX_NATIVE_FORK_TURN_FAILED");
  if (!Array.isArray(turn.items) || turn.itemsView && turn.itemsView !== "full") fail("CODEX_NATIVE_FORK_INCOMPLETE_RESULT");
  const messages = turn.items.filter(item => item.type === "agentMessage" && item.phase !== "commentary");
  if (messages.length !== 1) fail("CODEX_NATIVE_FORK_AMBIGUOUS_RESULT");
  let result;
  try { result = JSON.parse(messages[0].text); } catch { fail("CODEX_NATIVE_FORK_INVALID_RESULT"); }
  return verifyRuntimeStructuredResult(result, { scopeKind });
}

async function bounded(operation, deadlineAt, signal) {
  const cancellationCode = () => signal?.reason?.code === "CODEX_WORKER_POLICY_TIMEOUT" ? "CODEX_NATIVE_FORK_DEADLINE" : "CODEX_NATIVE_FORK_CANCELLED";
  if (signal?.aborted) fail(cancellationCode());
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) fail("CODEX_NATIVE_FORK_DEADLINE");
  const controller = new AbortController();
  let timer;
  let abort;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (controller.signal.aborted || deadlineAt <= Date.now()) fail(signal?.aborted ? cancellationCode() : "CODEX_NATIVE_FORK_DEADLINE");
        return operation({ signal: controller.signal, deadlineAt, timeoutMs: Math.max(1, deadlineAt - Date.now()) });
      }),
      new Promise((_, reject) => {
        const end = code => { controller.abort(); reject(Object.assign(new Error(code), { code })); };
        timer = setTimeout(() => end("CODEX_NATIVE_FORK_DEADLINE"), remaining);
        abort = () => end(cancellationCode());
        signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

async function guarded(verifier, binding, operation, deadlineAt, signal) {
  let open = true;
  let calls = 0;
  let result;
  let pending;
  try {
    await bounded(limits => verifier({ ...copy(binding), ...limits, commit: async (...args) => {
      if (!open || calls++) fail("CODEX_NATIVE_FORK_PROOF_REPLAYED");
      if (limits.signal.aborted) fail("CODEX_NATIVE_FORK_DEADLINE");
      pending = Promise.resolve(operation(...args)).then(value => { result = value; return value; });
      return pending;
    } }), deadlineAt, signal);
    if (pending) await bounded(() => pending, deadlineAt, signal);
  } finally { open = false; }
  if (calls !== 1) fail("CODEX_NATIVE_FORK_PROOF_REQUIRED");
  return result;
}

function exactHostBinding({ host, authorization, input, projectRoot, executionRoot, policy }) {
  const availability = inspectCodexNativeForkHost(host);
  if (!availability.available) throw Object.assign(new Error(availability.reason), {
    code: availability.reason, compatibility: inspectCurrentCodexNativeForkCompatibility() });
  const entry = hosts.get(host);
  const verified = verifyRuntimeInvocationAuthorization(authorization);
  const checkedPolicy = verifyCodexWorkerPolicyPlan(policy);
  const boundary = verified.workerInput?.executionBoundary;
  const inputBytes = Buffer.from(input);
  const actual = entry.evidenceMode === "actual-provider";
  if (verified.runtime !== "codex" || checkedPolicy.mode !== "native-fork"
    || checkedPolicy.evidenceMode !== entry.evidenceMode || checkedPolicy.model !== verified.runtimeSelection?.model
    || entry.rebind.modelProvider !== checkedPolicy.wireModelProvider
    || checkedPolicy.retainedContextDigest !== entry.source.prefixDigest
    || checkedPolicy.workspaceMode !== verified.workspaceMode
    || verified.authorizationHash !== entry.authorizationHash || hash(JSON.stringify(policy)) !== entry.policyDigest
    || boundary?.policyDigest !== entry.policyDigest || hash(path.resolve(executionRoot)) !== boundary.executionRootDigest
    || path.resolve(executionRoot) === path.resolve(projectRoot)
    || hash(inputBytes) !== verified.executionInput.digest || inputBytes.length !== verified.executionInput.bytes
    || hash(inputBytes) !== entry.inputDigest || !requireText(verified.runtimeSelection?.model)) fail("CODEX_NATIVE_FORK_BINDING_MISMATCH");
  return { entry, verified, checkedPolicy, boundary, inputBytes, actual };
}

export function verifyCodexNativeForkHostBinding(options) {
  const { entry } = exactHostBinding(options);
  return { evidenceMode: entry.evidenceMode, sourcePrefixDigest: entry.source.prefixDigest, inputDigest: entry.inputDigest };
}

export async function runCodexNativeFork({ host, authorization, input, projectRoot, executionRoot, policy,
  consumption, lease, operationalStateRoot, callerFenceDigest, signal = null,
  providerMode = "codex-protocol-fixture", sensitiveRoots = [], resultSchema, supervisorSelection,
  onProcessEvent = () => {} } = {}) {
  const { entry, verified, checkedPolicy, boundary, inputBytes, actual } = exactHostBinding({ host, authorization, input, projectRoot, executionRoot, policy });
  // A model-free protocol process can have real native ownership. Keep that
  // observation separate from actual provider/model evidence.
  const owned = ownedTransports.has(entry.ownedTransport);
  if (providerMode !== (actual ? "actual-codex" : "codex-protocol-fixture") || !resultSchema || resultSchema.type !== "object") fail("CODEX_NATIVE_FORK_BINDING_MISMATCH");
  verifyRuntimeExecutionLeaseOwnership({ projectRoot, operationalStateRoot, authorization: verified, lease, consumption });
  if (entry.used) fail("CODEX_NATIVE_FORK_REPLAY_REJECTED");
  entry.used = true;
  const deadlineAt = Math.min(Date.parse(consumption.consumedAt) + verified.limits.timeoutMs,
    entry.effectDeadlineAt ?? Infinity, Date.parse(consumption.holdDeadlineAt) - verified.limits.terminationGraceMs);
  const cleanupDeadlineAt = deadlineAt + verified.limits.terminationGraceMs;
  const forceDeadlineAt = Math.min(Date.parse(consumption.holdDeadlineAt), cleanupDeadlineAt + verified.limits.terminationGraceMs);
  const binding = { authorizationHash: entry.authorizationHash, policyDigest: entry.policyDigest, inputDigest: entry.inputDigest,
    source: entry.source, executionRoot: path.resolve(executionRoot), model: checkedPolicy.wireModel, ...entry.rebind };
  const requests = [];
  const events = [];
  const output = [];
  let outputBytes = 0;
  let childThreadId = null;
  let turnId = null;
  let providerResult = null;
  let inputDigestObserved = hash("");
  let completedTurn = null;
  let failure = null;
  let sourceGoal;
  let sourceGoalChanged = false;
  let supervised = null;
  let exactExit = false;
  let childExitCode = null;
  let transportTerminated = false;
  let supervision = null;
  let transportClose;
  let processObservationError = null;
  let processIdentity = null;
  const ownershipBinding = { authorizationHash: entry.authorizationHash, consumptionId: consumption.consumptionId,
    policyDigest: entry.policyDigest, inputDigest: entry.inputDigest, executionRootDigest: boundary.executionRootDigest };
  if (owned) verifyProcessSupervisorManifest(supervisorSelection?.manifest);
  const spool = openRuntimeOutputSpool({ operationalRoot: operationalStateRoot, authorization: verified,
    callerFenceDigest, supervisorManifestDigest: owned ? supervisorSelection.manifest.manifestHash : "", providerMode });
  const invocationController = new AbortController();
  const abortInvocation = () => invocationController.abort(signal?.reason);
  signal?.addEventListener("abort", abortInvocation, { once: true });
  if (signal?.aborted) abortInvocation();
  const invocationSignal = invocationController.signal;
  const pendingRequests = new Set();
  const record = evidence => {
    const result = entry.recordOperationalEvidence(copy({ ...evidence, authorizationHash: entry.authorizationHash,
      authority: "host-operational-evidence-only", recoveryAuthority: false }));
    if (result && typeof result.then === "function") fail("CODEX_NATIVE_FORK_SYNCHRONOUS_JOURNAL_REQUIRED");
  };
  async function rpc(method, params, mutation = false) {
    const requestId = `${verified.authorizationId}:${consumption.consumptionId}:${requests.length}`;
    const item = { requestId, method, params: copy(params), mutation, state: "prepared" };
    requests.push(item);
    record({ event: "request-prepared", ...item });
    try {
      const pending = bounded(async limits => {
        item.state = "sent";
        record({ event: "request-sent", ...item });
        return entry.request({ requestId, method, params: copy(params), ...limits, maxResponseBytes: verified.limits.maxStdoutBytes });
      }, deadlineAt, invocationSignal);
      pendingRequests.add(pending);
      let result;
      try { result = await pending; } finally { pendingRequests.delete(pending); }
      item.state = "returned";
      record({ event: "request-returned", requestId, method, result });
      return result;
    } catch (error) {
      item.state = mutation && item.state === "sent" ? "uncertain" : "failed";
      record({ event: "request-error", ...item, code: error.code || "CODEX_NATIVE_FORK_TRANSPORT" });
      throw error;
    }
  }
  function append(notification) {
    const line = JSON.stringify(notification);
    const bytes = Buffer.from(`${line}\n`);
    if (outputBytes + bytes.length > verified.limits.maxStdoutBytes || bytes.length > verified.limits.maxEventBytes) fail("CODEX_NATIVE_FORK_OUTPUT_LIMIT");
    if (!spool.append("stdout", bytes)) fail("CODEX_NATIVE_FORK_OUTPUT_LIMIT");
    output.push(bytes);
    outputBytes += bytes.length;
    // Provider wire fields are unchanged; type is an adapter-owned normalized
    // envelope label. No source/child ID is stored in P3 semantic fields.
    events.push(normalizeRuntimeEvent({ authorization: verified, sequence: events.length,
      line: JSON.stringify({ type: notification.method.replaceAll("/", "."), ...notification }) }));
  }
  async function settleOwnedTransport() {
    if (!supervised) fail("CODEX_NATIVE_FORK_OWNERSHIP_UNAVAILABLE");
    // Cleanup needs exact task ownership, including a newly owned wrong-target
    // child rejected before any RPC. Target admission was checked separately.
    const ownership = verifyRuntimeProcessSupervisorHandle(supervised, { ownershipBinding });
    transportTerminated ||= ownership.terminationRequested;
    if (!exactExit) {
      supervised.terminate(false); transportTerminated = true;
      try { await bounded(() => transportClose, cleanupDeadlineAt, null); }
      catch {
        supervised.terminate(true);
        await bounded(() => transportClose, forceDeadlineAt, null);
      }
    }
    supervision = supervised.finalize({ exactSupervisorExitObserved: exactExit, terminationRequested: transportTerminated });
    if (supervision.supervisorManifestDigest !== supervisorSelection.manifest.manifestHash
      || supervision.supervisionMode !== "native-process-tree" || !supervision.ownershipEstablished
      || !supervision.providerChildStarted || !supervision.treeCleanupVerified || !exactExit
      || supervision.controlInvalid || !supervision.requestWritten) fail("CODEX_NATIVE_FORK_CLEANUP_UNCERTAIN");
  }
  try {
    if (owned) await guarded(ownedTransports.get(entry.ownedTransport).withVerifiedOwnership, { ...binding, stage: "owned-transport",
      ownershipBinding, supervisorManifestDigest: supervisorSelection.manifest.manifestHash }, async spawnOwned => {
      if (typeof spawnOwned !== "function" || invocationSignal.aborted || Date.now() >= deadlineAt) fail("CODEX_NATIVE_FORK_OWNERSHIP_UNAVAILABLE");
      verifyRuntimeExecutionLeaseOwnership({ projectRoot, operationalStateRoot, authorization: verified, lease, consumption });
      const factoryStart = Date.now();
      const handle = spawnOwned({ ownershipBinding: copy(ownershipBinding), deadlineAt, signal: invocationSignal });
      // Establish exact task ownership first so a newly spawned wrong-target
      // handle can still be cleaned. Another task's or old source handle is
      // rejected here without acquiring any right to stop it.
      processIdentity = verifyRuntimeProcessSupervisorHandle(handle, { ownershipBinding, notBefore: factoryStart });
      if (!(handle?.child instanceof ChildProcess) || !Number.isSafeInteger(handle.child.pid) || handle.child.pid < 1
        || handle.child.exitCode !== null || handle.child.signalCode !== null
        || typeof handle.terminate !== "function" || typeof handle.finalize !== "function") fail("CODEX_NATIVE_FORK_OWNERSHIP_UNAVAILABLE");
      supervised = handle;
      transportClose = new Promise(resolve => handle.child.once("close", code => {
        exactExit = true; childExitCode = code;
        try { onProcessEvent({ type: "exit", pid: handle.child.pid, parentPid: process.pid, exitCode: code }); }
        catch (error) { processObservationError = error; }
        finally { resolve(); }
      }));
      verifyRuntimeProcessSupervisorHandle(handle, { ownershipBinding,
        executablePathDigest: checkedPolicy.executableIdentity.pathDigest, executionRootDigest: boundary.executionRootDigest,
        supervisorManifestDigest: supervisorSelection.manifest.manifestHash, notBefore: factoryStart });
      onProcessEvent({ type: "spawn", pid: handle.child.pid, parentPid: process.pid, command: "owned Codex app-server transport", cwd: binding.executionRoot, ports: [] });
    }, deadlineAt, invocationSignal);
    const sourceRead = await rpc("thread/read", { threadId: entry.source.threadId, includeTurns: true });
    const expectedTurns = verifyCodexNativeForkSource({ sourceRead, source: entry.source });
    const beforeGoal = await rpc("thread/goal/get", { threadId: entry.source.threadId });
    if (!Object.hasOwn(beforeGoal || {}, "goal")) fail("CODEX_NATIVE_FORK_GOAL_UNOBSERVABLE");
    sourceGoal = beforeGoal.goal;
    const response = await guarded(entry.withVerifiedFork, { ...binding, stage: "before-fork", sourceRead, sourceGoal },
      () => {
        if (checkedPolicy.retainedContextDigest !== entry.source.prefixDigest) fail("CODEX_NATIVE_FORK_BINDING_MISMATCH");
        verifyCodexNativeForkSource({ sourceRead, source: entry.source });
        // Abstract Host-contract simulation only. Actual admission above is
        // closed: installed Codex rejects this combination and the later
        // ephemeral goal/history reads. Do not treat fixture success as API E2E.
        return rpc("thread/fork", { threadId: entry.source.threadId, lastTurnId: entry.source.lastTurnId,
        ephemeral: true, excludeTurns: false, deferGoalContinuation: true, model: binding.model,
        modelProvider: binding.modelProvider, cwd: binding.executionRoot, runtimeWorkspaceRoots: [binding.executionRoot],
        approvalPolicy: "never", approvalsReviewer: "user", permissions: binding.permissions,
        baseInstructions: binding.baseInstructions, developerInstructions: binding.developerInstructions }, true);
      }, deadlineAt, invocationSignal);
    // Only proven fork provenance can identify a child for protective cleanup.
    if (requireText(response?.thread?.id) && response.thread.id !== entry.source.threadId
      && response.thread.forkedFromId === entry.source.threadId) childThreadId = response.thread.id;
    verifyChild(response, entry.source, expectedTurns, binding);
    const cleared = await rpc("thread/goal/clear", { threadId: childThreadId }, true);
    if (typeof cleared?.cleared !== "boolean") fail("CODEX_NATIVE_FORK_GOAL_CLEAR_FAILED");
    const goal = await rpc("thread/goal/get", { threadId: childThreadId });
    if (goal?.goal !== null) fail("CODEX_NATIVE_FORK_GOAL_NOT_CLEARED");
    const childRead = await rpc("thread/read", { threadId: childThreadId, includeTurns: true });
    if (childRead?.thread?.id !== childThreadId) fail("CODEX_NATIVE_FORK_CHILD_MISMATCH");
    verifyChild({ ...response, thread: childRead?.thread }, entry.source, expectedTurns, binding);
    const start = await guarded(entry.withVerifiedFork, { ...binding, stage: "before-turn", childThreadId, childRead, goal },
      () => rpc("turn/start", { threadId: childThreadId, input: [{ type: "text", text: inputBytes.toString("utf8"), text_elements: [] }],
        model: binding.model, cwd: binding.executionRoot, runtimeWorkspaceRoots: [binding.executionRoot],
        approvalPolicy: "never", approvalsReviewer: "user", permissions: binding.permissions, environments: [], outputSchema: resultSchema }, true), deadlineAt, invocationSignal);
    if (!requireText(start?.turn?.id) || expectedTurns.some(turn => turn.id === start.turn.id)
      || !["inProgress", "completed"].includes(start.turn.status)) fail("CODEX_NATIVE_FORK_TURN_MISMATCH");
    turnId = start.turn.id;
    inputDigestObserved = hash(inputBytes);
    while (!providerResult) {
      const notification = await bounded(limits => entry.nextNotification({ childThreadId, ...limits }), deadlineAt, invocationSignal);
      if (notification?.params?.threadId !== childThreadId) fail("CODEX_NATIVE_FORK_TURN_MISMATCH");
      if (notification.method === "turn/started" || notification.method === "turn/completed") {
        if (notification.params.turn?.id !== turnId) fail("CODEX_NATIVE_FORK_UNEXPECTED_CONTINUATION");
      } else if (notification.params.turnId && notification.params.turnId !== turnId) fail("CODEX_NATIVE_FORK_TURN_MISMATCH");
      append(notification);
      if (notification.method === "turn/completed") {
        providerResult = extractCodexNativeForkResult({ notification, threadId: childThreadId, turnId, scopeKind: verified.scope.kind });
        completedTurn = copy(notification.params.turn);
      }
    }
    const strings = value => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
    const resultText = strings(providerResult).map(value => value.replaceAll("\\", "/").toLowerCase()).join("\n");
    const forbidden = [entry.source.threadId, childThreadId, turnId, ...sensitiveRoots].filter(Boolean);
    if (forbidden.some(value => resultText.includes(String(value).replaceAll("\\", "/").toLowerCase()))) fail("CODEX_NATIVE_FORK_SENSITIVE_RESULT");
    const finalRead = await rpc("thread/read", { threadId: childThreadId, includeTurns: true });
    const finalGoal = await rpc("thread/goal/get", { threadId: childThreadId });
    if (finalRead?.thread?.id !== childThreadId || finalRead.thread.status?.type !== "idle"
      || finalGoal?.goal !== null || finalRead.thread.turns?.length !== expectedTurns.length + 1
      || json(finalRead.thread.turns.slice(0, -1)) !== json(expectedTurns)
      || finalRead.thread.turns.at(-1)?.id !== turnId || finalRead.thread.turns.at(-1)?.status !== "completed"
      || json(finalRead.thread.turns.at(-1)?.items) !== json(completedTurn.items)
      || finalRead.thread.turns.at(-1)?.itemsView && finalRead.thread.turns.at(-1).itemsView !== "full") fail("CODEX_NATIVE_FORK_UNEXPECTED_CONTINUATION");
    verifyChild({ ...response, thread: { ...finalRead.thread, turns: expectedTurns } }, entry.source, expectedTurns, binding);
    const finalSourceGoal = await rpc("thread/goal/get", { threadId: entry.source.threadId });
    sourceGoalChanged = json(finalSourceGoal?.goal) !== json(sourceGoal);
    if (sourceGoalChanged) record({ event: "source-goal-concurrent-change-observed", beforeDigest: hash(json(sourceGoal)),
      afterDigest: hash(json(finalSourceGoal?.goal) ?? "unobservable"), sourceMutationIssued: false });
    await guarded(entry.withVerifiedFork, { ...binding, stage: "after-turn", childThreadId, turnId, finalRead, finalGoal }, async () => {}, deadlineAt, invocationSignal);
  } catch (error) {
    if (error.code === "CODEX_RPC_CANCELLED") error = Object.assign(new Error("Codex transport cancelled"), { code: "CODEX_NATIVE_FORK_CANCELLED" });
    if (error.code === "CODEX_RPC_DEADLINE") error = Object.assign(new Error("Codex transport timed out"), { code: "CODEX_NATIVE_FORK_DEADLINE" });
    failure = error; providerResult = null; abortInvocation();
    await Promise.allSettled([...pendingRequests]);
  }
  try {
    // Cleanup runs even after cancelled/uncertain RPCs and receives request IDs,
    // never authority to retry a fork or turn. Its own bounded grace is reserved.
    await guarded(entry.cleanup, { ...binding, childThreadId, turnId, requests,
      reason: failure?.code || "completed", sourceMutationAllowed: false }, async () => {}, forceDeadlineAt, null);
    if (owned) await settleOwnedTransport();
    if (!failure && owned && (transportTerminated || childExitCode !== 0 || !supervision.providerChildExitObserved || processObservationError)) {
      failure = Object.assign(new Error("Owned native transport did not complete cleanly"), { code: "CODEX_NATIVE_FORK_TRANSPORT_FAILED" });
      providerResult = null;
    }
    record({ event: "cleanup-verified", childThreadId, turnId, requests });
    const status = !failure ? "completed" : failure.code === "CODEX_NATIVE_FORK_CANCELLED" ? "cancelled"
      : failure.code === "CODEX_NATIVE_FORK_DEADLINE" ? "timed-out"
        : failure.code === "CODEX_NATIVE_FORK_OUTPUT_LIMIT" || failure.code === "RUNTIME_EVENT_LIMIT" ? "output-limited" : "failed";
    const receipt = buildRuntimeInvocationLifecycleReceipt({ authorization: verified,
      events: [...events].sort((a, b) => a.eventId.localeCompare(b.eventId)), status, exitCode: owned ? childExitCode : failure ? null : 0,
      signal: "", stdoutBytes: outputBytes, stderrBytes: 0, stdoutDigest: hash(Buffer.concat(output)), stderrDigest: hash(""),
      callerFenceDigest, childFenceDigest: hash(`${verified.authorizationId}\n${owned ? json(processIdentity) : "native-fork-protocol-fixture"}`),
      childStarted: owned, childExitObserved: owned && exactExit, terminationRequested: transportTerminated || ["cancelled", "timed-out", "output-limited"].includes(status),
      projectFenceValidated: true, inputDigestObserved, noDescendantFixture: !owned,
      descendantTreeOwnershipValidated: owned && supervision.ownershipEstablished && supervision.treeCleanupVerified,
      supervision, consumption, providerMode, providerSessionCreated: actual && childThreadId !== null,
      providerDiagnosticCodes: [...(failure ? ["codex.native-fork-contract-failed"] : []),
        ...(sourceGoalChanged ? ["codex.source-goal-concurrent-change"] : [])], structuredResult: providerResult });
    const result = { receipt, events, providerResult };
    spool.complete(result);
    return result;
  } catch (cleanupError) {
    if (supervised) {
      try { await settleOwnedTransport(); }
      catch (exitError) {
        record({ event: "owned-transport-exit-unverified", processIdentity, code: exitError.code || "CODEX_NATIVE_FORK_CLEANUP_UNCERTAIN" });
      }
    }
    record({ event: "cleanup-unverified", childThreadId, turnId, code: cleanupError.code || "CODEX_NATIVE_FORK_CLEANUP_UNCERTAIN" });
    throw cleanupError;
  } finally { signal?.removeEventListener("abort", abortInvocation); spool.close(); }
}
