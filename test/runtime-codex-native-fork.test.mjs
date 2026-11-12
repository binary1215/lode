import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/session/lode-core.mjs";
import { buildRuntimeVersionEvidence } from "../scripts/lib/runtime/runtime-machine-execution.mjs";
import { buildRuntimeProjectBinding, buildRuntimeProtocolEvidence } from "../scripts/lib/runtime/runtime-protocol-evidence.mjs";
import { buildRuntimeInvocationAuthorization, prepareRuntimeInvocationExecution } from "../scripts/lib/runtime/runtime-invocation-lifecycle.mjs";
import { createBoundedWorkerDispatch } from "../scripts/lib/worker/bounded-worker-dispatch.mjs";
import { captureWorkerSourceBasis } from "../scripts/lib/worker/worker-source-basis.mjs";
import { prepareWorkerWorkspace, workerExecutionBoundary } from "../scripts/lib/worker/worker-workspace.mjs";
import { RUNTIME_OPERATIONAL_STATE_ENV, inspectRuntimeExecutionLease } from "../scripts/lib/runtime/runtime-execution-lease.mjs";
import { readRuntimeOutputSpool } from "../scripts/lib/runtime/runtime-output-spool.mjs";
import { readRuntimeInvocationRecord } from "../scripts/lib/runtime/runtime-invocation-record.mjs";
import {
  resolveVerifiedProcessSupervisor,
  spawnSupervisedProcess,
  verifyRuntimeProcessSupervisorHandle,
} from "../scripts/lib/runtime/runtime-process-supervisor.mjs";
import { executeCodexRuntimeInvocation } from "../scripts/lib/runtime/runtime-codex-exec.mjs";
import {
  buildCodexWorkerPolicyPlan,
  createCodexWorkerPolicyHost,
  bindCodexWorkerPolicyCapability,
} from "../scripts/lib/runtime/runtime-codex-worker-policy.mjs";
import {
  createCodexNativeForkHost,
  inspectCodexNativeForkHost,
  codexNativeForkPrefixDigest,
  verifyCodexNativeForkSource,
  extractCodexNativeForkResult,
  createCodexNativeForkOwnedTransport,
  CODEX_NATIVE_FORK_ACTUAL_UNAVAILABLE,
} from "../scripts/lib/runtime/runtime-codex-native-fork.mjs";

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const copy = (value) => structuredClone(value);
const pluginRoot = path.resolve(import.meta.dirname, "..");
console.log(
  JSON.stringify({
    event: "owned-codex-native-fork-tests",
    pid: process.pid,
    parentPid: process.ppid,
    command: process.execPath,
    args: process.argv.slice(1),
    cwd: process.cwd(),
    ports: [],
    actualProviderInvoked: false,
  }),
);
const result = {
  schemaVersion: 1,
  kind: "RuntimeStructuredResult",
  protocolVersion: "0.1.0",
  outcome: "Synthetic bounded contribution",
  evidence: ["Synthetic protocol only"],
  planDelta: "",
  impactRadius: [],
  verification: ["Contract checked"],
  unknowns: [],
};
const historical = (id) => ({
  id,
  status: "completed",
  items: [{ type: "agentMessage", id: `${id}-message`, text: "Synthetic public context" }],
  itemsView: "full",
});
const sourceThreadId = "synthetic-source-thread";
const childThreadId = "synthetic-child-thread";
const workerTurnId = "synthetic-worker-turn";
const sourceRead = { thread: { id: sourceThreadId, turns: [historical("cutoff"), historical("later")], historyMode: "legacy" } };
const source = {
  threadId: sourceThreadId,
  lastTurnId: "cutoff",
  prefixDigest: codexNativeForkPrefixDigest({ sourceRead, threadId: sourceThreadId, lastTurnId: "cutoff" }),
};

// Schema capability fixtures only: no provider, OS child, shell or model call.
function capabilitySpawn(_command, args) {
  const output =
    args.join(" ") === "--version"
      ? "codex 1.2.3\n"
      : args.join(" ") === "--help"
        ? "exec\nmcp-server\napp-server\n"
        : args.join(" ") === "exec --help"
          ? "Run Codex non-interactively\n--json\n--output-schema\n--color\n--sandbox\n--skip-git-repo-check\n--cd\n--ephemeral\nresume\n"
          : "stdio://\ngenerate-json-schema\n--listen\n";
  const child = new EventEmitter();
  Object.assign(child, { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null });
  child.kill = () => {
    throw new Error("Synthetic fixture cannot control processes");
  };
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(output));
    child.exitCode = 0;
    child.emit("close", 0, null);
  });
  return child;
}

async function fixture(t, options = {}) {
  const parent = fs.realpathSync(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const container = fs.mkdtempSync(path.join(parent, "head-native-fork-"));
  const root = path.join(container, "project");
  const bin = path.join(container, "synthetic-capability");
  const operational = path.join(container, "operational");
  for (const directory of [root, bin, operational]) fs.mkdirSync(directory);
  const previousOperational = process.env[RUNTIME_OPERATIONAL_STATE_ENV];
  process.env[RUNTIME_OPERATIONAL_STATE_ENV] = operational;
  t.after(() => {
    if (previousOperational === undefined) delete process.env[RUNTIME_OPERATIONAL_STATE_ENV];
    else process.env[RUNTIME_OPERATIONAL_STATE_ENV] = previousOperational;
    assert.equal(path.dirname(container), parent);
    assert.match(path.basename(container), /^head-native-fork-/);
    fs.rmSync(container, { recursive: true, force: true });
  });
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  assert.equal(storage.directory, ".lode");
  assert.equal(fs.existsSync(path.resolve(root, ".lode/project.json")), true);
  assert.equal(fs.existsSync(path.resolve(root, ".head/project.json")), false);
  fs.writeFileSync(path.join(root, "selected.txt"), "Synthetic selected source\n");
  const executablePath = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(executablePath, "Synthetic non-executable provider fixture\n");
  if (process.platform !== "win32") fs.chmodSync(executablePath, 0o755);
  const environment = { ...process.env, PATH: bin };
  delete environment.Path;
  delete environment.path;
  const versionEvidence = await buildRuntimeVersionEvidence({ runtimes: ["codex"], environment, spawnImplementation: capabilitySpawn });
  const protocolEvidence = await buildRuntimeProtocolEvidence({ runtimes: ["codex"], environment, versionEvidence, spawnImplementation: capabilitySpawn });
  const inspected = inspectProject(root);
  const projectBinding = buildRuntimeProjectBinding({
    storage,
    projectId: inspected.project.projectId,
    headSessionId: inspected.state.sessionId,
    projectRoot: fs.realpathSync(root),
    projectStatus: "ready",
    versionEvidence,
    protocolEvidence,
  });
  const policy = buildCodexWorkerPolicyPlan({
    executablePath,
    executableDigest: hash(fs.readFileSync(executablePath)),
    model: "synthetic-provider/synthetic-model",
    wireModel: "synthetic-model",
    wireModelProvider: "synthetic-provider",
    mode: "native-fork",
    evidenceMode: "protocol-fixture",
    retainedContextDigest: source.prefixDigest,
  });
  const sourceBasis = captureWorkerSourceBasis({ root, paths: ["selected.txt"], maxBytes: 1024 * 1024 });
  const workspaceBinding = prepareWorkerWorkspace({ projectRoot: root, workspaceRoot: path.join(container, "selected"), sourceBasis, maxBytes: 1024 * 1024 });
  const authorization = buildRuntimeInvocationAuthorization({
    root,
    runtime: "codex",
    runtimeSelection: { model: policy.model },
    scope: { kind: "session", request: "Read selected synthetic source" },
    protocolEvidence,
    projectBinding,
    limits: { timeoutMs: 1000, terminationGraceMs: 1000, ...(options.limits || {}) },
    worker: {
      taskKey: "native-fork",
      role: "coder",
      outcome: "One synthetic bounded contribution",
      selectedContext: "Synthetic context only",
      sourcePaths: ["selected.txt"],
      executionBoundary: workerExecutionBoundary({ binding: workspaceBinding, policy, sourceBasis }),
    },
  }).authorization;
  createBoundedWorkerDispatch({ root, authorizationId: authorization.authorizationId, role: "coder" });
  const prepared = prepareRuntimeInvocationExecution({ root, authorization });
  const policyHost = createCodexWorkerPolicyHost({
    evidenceMode: "protocol-fixture",
    withVerifiedPolicy: async ({ commit }) => {
      await commit();
    },
  });
  const workerPolicyCapability = bindCodexWorkerPolicyCapability({
    host: policyHost,
    policy,
    authorization,
    workspaceBinding,
    root,
    target: { executablePath },
  });
  const state = {
    root,
    calls: [],
    journal: [],
    cleanups: [],
    proofs: [],
    sourceGoal: {
      threadId: sourceThreadId,
      objective: "Synthetic parent goal",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
      timeUsedSeconds: 0,
      tokensUsed: 0,
      tokenBudget: null,
    },
    childGoal: null,
    child: null,
    finalTurn: null,
  };
  const initialGoal = copy(state.sourceGoal);
  const rebind = {
    modelProvider: "synthetic-provider",
    permissions: "synthetic-selected-profile",
    baseInstructions: "Synthetic bounded worker",
    developerInstructions: "Use only the exact authorized input",
    expectedSandbox: { type: "readOnly", networkAccess: false },
    instructionSources: [],
  };
  const completeTurn = () => ({
    id: workerTurnId,
    status: "completed",
    itemsView: "full",
    items: [{ type: "agentMessage", id: "synthetic-result", text: JSON.stringify(result), phase: "final_answer" }],
  });
  const request = async (call) => {
    state.calls.push(copy({ method: call.method, params: call.params, requestId: call.requestId, timeoutMs: call.timeoutMs, deadlineAt: call.deadlineAt }));
    assert.ok(call.timeoutMs > 0 && call.timeoutMs <= authorization.limits.timeoutMs);
    if (options.request) {
      const override = await options.request(call, state);
      if (override !== undefined) return override;
    }
    if (call.method === "thread/read") {
      if (call.params.threadId === sourceThreadId) return copy(options.sourceRead || sourceRead);
      return { thread: { ...copy(state.child), turns: [historical("cutoff"), ...(state.finalTurn ? [copy(state.finalTurn)] : [])] } };
    }
    if (call.method === "thread/goal/get") return { goal: copy(call.params.threadId === sourceThreadId ? state.sourceGoal : state.childGoal) };
    if (call.method === "thread/goal/clear") {
      assert.equal(call.params.threadId, childThreadId);
      state.childGoal = null;
      return { cleared: true };
    }
    if (call.method === "thread/fork") {
      state.child = {
        id: childThreadId,
        forkedFromId: sourceThreadId,
        model: policy.wireModel,
        modelProvider: rebind.modelProvider,
        cwd: workspaceBinding.executionRoot,
        turns: [historical("cutoff")],
        status: { type: "idle" },
        ephemeral: true,
        cliVersion: "0.153.4",
        createdAt: 1,
        updatedAt: 1,
        preview: "Synthetic",
        projectId: null,
        sessionId: "synthetic-session",
        source: "appServer",
      };
      state.childGoal = { ...copy(state.sourceGoal), threadId: childThreadId };
      const response = {
        thread: copy(state.child),
        model: policy.wireModel,
        modelProvider: rebind.modelProvider,
        cwd: workspaceBinding.executionRoot,
        runtimeWorkspaceRoots: [workspaceBinding.executionRoot],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: copy(rebind.expectedSandbox),
        activePermissionProfile: { id: rebind.permissions, extends: null },
        instructionSources: [],
      };
      options.forkResponse?.(response, state);
      if (options.uncertainFork) throw Object.assign(new Error("Synthetic response lost after fork creation"), { code: "EPIPE" });
      return response;
    }
    if (call.method === "turn/start") {
      assert.equal(call.params.input[0].text, prepared.input.toString("utf8"));
      assert.deepEqual(call.params.environments, []);
      assert.equal(call.params.outputSchema.type, "object");
      assert.deepEqual(call.params.outputSchema.properties.planDelta.enum, [""]);
      assert.equal(call.params.outputSchema.properties.impactRadius.maxItems, 0);
      if (options.uncertainTurn) throw Object.assign(new Error("Synthetic start acknowledgement lost"), { code: "EPIPE" });
      return { turn: { id: workerTurnId, status: "inProgress", items: [] } };
    }
    throw new Error(`Unsupported fixture method ${call.method}`);
  };
  const hostOptions = {
    evidenceMode: options.evidenceMode || "protocol-fixture",
    source: options.hostSource || source,
    rebind,
    authorizationHash: authorization.authorizationHash,
    policyDigest: hash(JSON.stringify(policy)),
    inputDigest: authorization.executionInput.digest,
    request,
    nextNotification: async (limits) => {
      if (options.notification) return options.notification(limits, state);
      state.finalTurn = completeTurn();
      return { method: "turn/completed", params: { threadId: childThreadId, turn: copy(state.finalTurn) } };
    },
    withVerifiedFork: async (proof) => {
      state.proofs.push(proof.stage);
      if (options.proof) return options.proof(proof, state);
      await proof.commit();
    },
    cleanup: async (cleanup) => {
      state.cleanups.push(copy({ ...cleanup, signal: undefined, commit: undefined }));
      assert.equal(cleanup.sourceMutationAllowed, false);
      if (options.cleanup) return options.cleanup(cleanup, state);
      await cleanup.commit();
    },
    recordOperationalEvidence: (evidence) => {
      state.journal.push(evidence);
    },
    effectDeadlineAt: options.effectDeadlineAt ?? null,
  };
  options.hostOptions?.(hostOptions);
  const host = createCodexNativeForkHost(hostOptions);
  const execute = (extra) =>
    executeCodexRuntimeInvocation(
      {
        root,
        authorization,
        protocolEvidence,
        projectBinding,
        environment,
        evidenceMode: "protocol-fixture",
        supervisorSelection: { manifest: { manifestHash: hash("synthetic-unused-supervisor") } },
        spawnImplementation: () => {
          throw new Error("Native contract tests cannot launch a process");
        },
        ...extra,
      },
      { workerPolicyCapability, nativeForkHost: host },
    );
  return { storage, root, operational, authorization, policy, state, host, hostOptions, execute, initialGoal, prepared };
}

test("completed cutoff binds the exact prefix and excludes later history", () => {
  assert.deepEqual(verifyCodexNativeForkSource({ sourceRead, source }), [historical("cutoff")]);
  const changedLater = copy(sourceRead);
  changedLater.thread.turns[1].items[0].text = "new future context";
  assert.deepEqual(verifyCodexNativeForkSource({ sourceRead: changedLater, source }), [historical("cutoff")]);
  for (const status of ["inProgress", "failed", "interrupted"]) {
    const altered = copy(sourceRead);
    altered.thread.turns[0].status = status;
    assert.throws(() => verifyCodexNativeForkSource({ sourceRead: altered, source }), { code: "CODEX_NATIVE_FORK_CUTOFF_NOT_COMPLETED" });
  }
  const altered = copy(sourceRead);
  altered.thread.turns[0].items[0].text = "stale prefix";
  assert.throws(() => verifyCodexNativeForkSource({ sourceRead: altered, source }), { code: "CODEX_NATIVE_FORK_STALE_CUTOFF" });
  assert.throws(() => verifyCodexNativeForkSource({ sourceRead, source: { ...source, lastTurnId: "missing" } }), { code: "CODEX_NATIVE_FORK_STALE_CUTOFF" });
  for (const status of ["failed", "interrupted"]) {
    const priorFailure = copy(sourceRead);
    priorFailure.thread.turns.unshift({ id: "earlier", items: [], status });
    const bound = { ...source, prefixDigest: codexNativeForkPrefixDigest({ sourceRead: priorFailure, ...source }) };
    assert.equal(verifyCodexNativeForkSource({ sourceRead: priorFailure, source: bound })[0].status, status);
    priorFailure.thread.turns[0].status = "inProgress";
    assert.throws(() => verifyCodexNativeForkSource({ sourceRead: priorFailure, source: bound }), { code: "CODEX_NATIVE_FORK_UNFINISHED_PREFIX" });
  }
});

test("native fork uses the existing selected authorization, one lease, spool and result route", async (t) => {
  const f = await fixture(t);
  const sessionFile = path.join(f.root, f.storage.directory, "sessions/current.json");
  const before = fs.readFileSync(sessionFile);
  const completed = await f.execute();
  assert.equal(completed.receipt.status, "completed");
  assert.equal(completed.actualProviderInvoked, false);
  assert.equal(completed.receipt.processBoundary.exactChildStarted, false);
  assert.equal(completed.descendantTreeOwnershipValidated, false);
  assert.deepEqual(completed.draft.providerResult, result);
  assert.equal(completed.executionLease.release.consumptionId, completed.executionLease.consumption.consumptionId);
  assert.equal(completed.executionLease.release.lifecycleReceiptId, completed.receipt.receiptId);
  assert.equal(
    readRuntimeInvocationRecord({ root: f.root, storage: f.storage, authorizationId: f.authorization.authorizationId }).draft.draftId,
    completed.draft.draftId,
  );
  const spool = readRuntimeOutputSpool({ operationalRoot: f.operational, authorization: f.authorization });
  assert.equal(spool.status, "terminal-recorded");
  assert.equal(spool.recoveryAuthority, false);
  assert.equal(spool.terminal.ownerExitRequired, true);
  assert.deepEqual(f.state.proofs, ["before-fork", "before-turn", "after-turn"]);
  assert.deepEqual(f.state.sourceGoal, f.initialGoal);
  assert.deepEqual(fs.readFileSync(sessionFile), before);
  assert.equal(f.state.calls.filter((call) => call.method === "thread/fork").length, 1);
  const fork = f.state.calls.find((call) => call.method === "thread/fork").params;
  assert.equal(fork.lastTurnId, "cutoff");
  assert.equal(fork.deferGoalContinuation, true);
  assert.equal(fork.model, "synthetic-model");
  assert.equal(fork.modelProvider, "synthetic-provider");
  for (const forbidden of ["path", "beforeTurnId", "contextOnly", "toolPolicy", "disableSkills", "ignoreUserConfig"])
    assert.equal(Object.hasOwn(fork, forbidden), false);
  const semantic = JSON.stringify({ receipt: completed.receipt, draft: completed.draft });
  for (const id of [sourceThreadId, childThreadId, workerTurnId, "synthetic-session"]) assert.equal(semantic.includes(id), false);
  await assert.rejects(f.execute());
  assert.equal(f.state.calls.filter((call) => call.method === "thread/fork").length, 1, "no replay after lease consumption");
});

for (const [name, mutate, code] of [
  ["later-turn leak", (response) => response.thread.turns.push(historical("later")), "CODEX_NATIVE_FORK_HISTORY_LEAK"],
  [
    "wrong parent",
    (response) => {
      response.thread.forkedFromId = "another-source";
    },
    "CODEX_NATIVE_FORK_CHILD_MISMATCH",
  ],
  [
    "wrong model",
    (response) => {
      response.model = "other-model";
    },
    "CODEX_NATIVE_FORK_MODEL_MISMATCH",
  ],
  [
    "wrong root",
    (response) => {
      response.cwd = "/other-root";
    },
    "CODEX_NATIVE_FORK_ROOT_MISMATCH",
  ],
  [
    "wrong policy",
    (response) => {
      response.approvalPolicy = "on-request";
    },
    "CODEX_NATIVE_FORK_POLICY_MISMATCH",
  ],
  [
    "unexpected instructions",
    (response) => {
      response.instructionSources = ["private-instructions.md"];
    },
    "CODEX_NATIVE_FORK_POLICY_MISMATCH",
  ],
  [
    "automatic child turn",
    (response) => {
      response.thread.status = { type: "active", activeFlags: [] };
    },
    "CODEX_NATIVE_FORK_CHILD_NOT_IDLE",
  ],
])
  test(`native fork rejects ${name} and cleans the owned child without a turn`, async (t) => {
    const f = await fixture(t, { forkResponse: mutate });
    const observed = await f.execute();
    assert.equal(observed.receipt.status, "failed");
    assert.equal(observed.draft.providerResult, null);
    assert.equal(observed.receipt.inputDigestObserved, hash(""));
    assert.equal(observed.draft.verification[0].inputDigestMatched, false);
    assert.equal(f.state.cleanups.length, 1);
    assert.equal(f.state.cleanups[0].reason, code);
    assert.equal(
      f.state.calls.some((call) => call.method === "turn/start"),
      false,
    );
    assert.deepEqual(f.state.sourceGoal, f.initialGoal);
  });

test("inherited context is not admitted by a cutoff or prompt-only proof", async (t) => {
  const f = await fixture(t, { proof: async () => ({ contextOnly: true, effectivePolicy: true }) });
  assert.equal((await f.execute()).receipt.status, "failed");
  assert.equal(f.state.cleanups[0].reason, "CODEX_NATIVE_FORK_PROOF_REQUIRED");
  assert.equal(
    f.state.calls.some((call) => call.method === "thread/fork"),
    false,
  );
});

test("child goal clearing failure prevents explicit turn and leaves source untouched", async (t) => {
  const f = await fixture(t, {
    request: async (call) => {
      if (call.method === "thread/goal/clear") return { cleared: false };
    },
  });
  assert.equal((await f.execute()).receipt.status, "failed");
  assert.equal(f.state.cleanups[0].reason, "CODEX_NATIVE_FORK_GOAL_NOT_CLEARED");
  assert.equal(
    f.state.calls.some((call) => call.method === "turn/start"),
    false,
  );
  assert.deepEqual(f.state.sourceGoal, f.initialGoal);
});

for (const mutation of ["Fork", "Turn"])
  test(`uncertain ${mutation.toLowerCase()} is journaled exactly and never replayed`, async (t) => {
    const f = await fixture(t, { [`uncertain${mutation}`]: true });
    const before = fs.readFileSync(path.join(f.root, f.storage.directory, "sessions/current.json"));
    assert.equal((await f.execute()).receipt.status, "failed");
    const method = mutation === "Fork" ? "thread/fork" : "turn/start";
    assert.equal(f.state.calls.filter((call) => call.method === method).length, 1);
    const uncertain = f.state.journal.find((item) => item.event === "request-error" && item.method === method);
    assert.equal(uncertain.state, "uncertain");
    assert.ok(uncertain.requestId.includes(f.authorization.authorizationId));
    assert.equal(f.state.cleanups[0].requests.find((item) => item.requestId === uncertain.requestId).state, "uncertain");
    assert.deepEqual(fs.readFileSync(path.join(f.root, f.storage.directory, "sessions/current.json")), before);
    assert.deepEqual(f.state.sourceGoal, f.initialGoal);
    await assert.rejects(f.execute());
    assert.equal(f.state.calls.filter((call) => call.method === method).length, 1);
  });

for (const kind of ["thread", "turn", "failed-turn", "continuation"])
  test(`terminal ${kind} mismatch cannot supply the result`, async (t) => {
    const f = await fixture(t, {
      notification: async (_limits, state) => {
        const turn = {
          id: kind === "turn" || kind === "continuation" ? "unrelated-turn" : workerTurnId,
          status: kind === "failed-turn" ? "failed" : "completed",
          items: [{ type: "agentMessage", id: "wrong", text: JSON.stringify(result) }],
        };
        state.finalTurn = turn;
        return {
          method: kind === "continuation" ? "turn/started" : "turn/completed",
          params: { threadId: kind === "thread" ? sourceThreadId : childThreadId, turn },
        };
      },
    });
    const observed = await f.execute();
    assert.equal(observed.receipt.status, "failed");
    assert.equal(observed.draft.providerResult, null);
    assert.equal(f.state.cleanups.length, 1);
  });

test("cancellation bounds a pending request and retains uncertain delivery for cleanup", async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, {
    request: async (call) => {
      if (call.method === "thread/fork") {
        queueMicrotask(() => controller.abort());
        return new Promise(() => {});
      }
    },
  });
  const observed = await f.execute({ signal: controller.signal });
  assert.equal(observed.receipt.status, "cancelled");
  assert.equal(f.state.cleanups[0].requests.find((item) => item.method === "thread/fork").state, "uncertain");
});

test("one absolute deadline bounds provider loss and cleanup cannot fabricate completion", async (t) => {
  const f = await fixture(t, { notification: async () => new Promise(() => {}) });
  const start = Date.now();
  const observed = await f.execute();
  assert.equal(observed.receipt.status, "timed-out");
  assert.ok(Date.now() - start < 3000);
  assert.equal(f.state.cleanups.length, 1);
  assert.equal(observed.draft.providerResult, null);
});

test("unverified cleanup retains an incomplete spool and cannot publish a result", async (t) => {
  const f = await fixture(t, {
    cleanup: async () => {
      throw Object.assign(new Error("Synthetic cleanup unavailable"), { code: "EPIPE" });
    },
  });
  await assert.rejects(f.execute(), { code: "EPIPE" });
  const observed = readRuntimeOutputSpool({ operationalRoot: f.operational, authorization: f.authorization });
  assert.equal(observed.status, "incomplete");
  assert.equal(observed.terminal, null);
  assert.equal(observed.recoveryAuthority, false);
  assert.equal(f.state.journal.at(-1).event, "cleanup-unverified");
  const lease = inspectRuntimeExecutionLease({
    projectRoot: f.root,
    storage: f.storage,
    projectId: f.authorization.projectId,
    authorizationId: f.authorization.authorizationId,
  });
  assert.equal(lease.release.operationStatus, "threw");
  assert.equal(lease.release.lifecycleReceiptId, null);
});

test("actual fork stays unavailable even with dedicated ownership: installed API sequence conflicts", async (t) => {
  const f = await fixture(t, { evidenceMode: "actual-provider" });
  assert.deepEqual(inspectCodexNativeForkHost(f.host), {
    available: false,
    evidenceMode: "actual-provider",
    reason: CODEX_NATIVE_FORK_ACTUAL_UNAVAILABLE,
    actualProviderInvoked: false,
    sourcePrefixDigest: source.prefixDigest,
  });
  await assert.rejects(f.execute(), { code: "WORKER_JOB_POLICY_UNAVAILABLE" });
  assert.deepEqual(f.state.calls, []);
  assert.deepEqual(f.state.cleanups, []);
  const ownedTransport = createCodexNativeForkOwnedTransport({
    withVerifiedOwnership: async () => {
      throw new Error("No installed backend connected in this test");
    },
  });
  const connected = createCodexNativeForkHost({ ...f.hostOptions, ownedTransport });
  assert.equal(inspectCodexNativeForkHost(connected).available, false, "ownership cannot override installed API conflicts");
  assert.throws(() => createCodexNativeForkHost({ ...f.hostOptions, ownedTransport: { ...ownedTransport } }), { code: "INVALID_CODEX_NATIVE_FORK_HOST" });
});

for (const mismatch of ["authorizationHash", "inputDigest", "policyDigest", "modelProvider", "prefix", "cutoff"]) {
  test(`native Host ${mismatch} drift is rejected before consuming the lease`, async (t) => {
    const f = await fixture(t, {
      hostOptions: (options) => {
        if (mismatch === "modelProvider") options.rebind = { ...options.rebind, modelProvider: "another-provider" };
        else if (mismatch === "prefix" || mismatch === "cutoff")
          options.source = { ...options.source, ...(mismatch === "cutoff" ? { lastTurnId: "later" } : {}), prefixDigest: hash("another-selected-prefix") };
        else options[mismatch] = hash("other-binding");
      },
    });
    await assert.rejects(f.execute());
    assert.equal(
      inspectRuntimeExecutionLease({
        projectRoot: f.root,
        storage: f.storage,
        projectId: f.authorization.projectId,
        authorizationId: f.authorization.authorizationId,
      }).consumption,
      null,
    );
    assert.deepEqual(f.state.calls, []);
    assert.deepEqual(f.state.cleanups, []);
  });
}

test("native policy cannot omit its pre-authorized retained-context digest", () => {
  assert.throws(
    () =>
      buildCodexWorkerPolicyPlan({
        executablePath: process.execPath,
        executableDigest: hash("fixture"),
        model: "synthetic/model",
        wireModel: "model",
        wireModelProvider: "synthetic",
        mode: "native-fork",
        evidenceMode: "protocol-fixture",
        retainedContextDigest: null,
      }),
    { code: "INVALID_CODEX_WORKER_POLICY" },
  );
});

test("parent goal may progress concurrently without invalidating the completed-cutoff child", async (t) => {
  let reads = 0;
  const f = await fixture(t, {
    request: async (call, state) => {
      if (call.method === "thread/goal/get" && call.params.threadId === sourceThreadId && ++reads > 1) {
        state.sourceGoal = { ...state.sourceGoal, objective: "Parent independently advanced", updatedAt: 2 };
      }
    },
  });
  const completed = await f.execute();
  assert.equal(completed.receipt.status, "completed");
  assert.ok(completed.receipt.providerBoundary.diagnosticCodes.includes("codex.source-goal-concurrent-change"));
  assert.ok(f.state.journal.some((entry) => entry.event === "source-goal-concurrent-change-observed" && entry.sourceMutationIssued === false));
  assert.equal(
    f.state.calls.some((call) => call.params.threadId === sourceThreadId && !["thread/read", "thread/goal/get", "thread/fork"].includes(call.method)),
    false,
  );
});

test("verifier rejection aborts pending fork delivery before cleanup; late callback cannot replay", async (t) => {
  let pendingCommit;
  let releaseFork;
  const f = await fixture(t, {
    proof: async (proof) => {
      if (proof.stage !== "before-fork") return proof.commit();
      pendingCommit = proof.commit();
      pendingCommit.catch(() => {});
      await new Promise((resolve) => queueMicrotask(resolve));
      throw new Error("Synthetic verifier rejected after send");
    },
    request: async (call) => {
      if (call.method === "thread/fork")
        return new Promise((resolve) => {
          releaseFork = resolve;
        });
    },
  });
  const observed = await f.execute();
  assert.equal(observed.receipt.status, "failed");
  assert.equal(f.state.calls.filter((call) => call.method === "thread/fork").length, 1);
  assert.equal(f.state.cleanups[0].requests.find((call) => call.method === "thread/fork").state, "uncertain");
  const before = f.state.journal.length;
  releaseFork({ thread: { id: "late-child", forkedFromId: sourceThreadId } });
  await pendingCommit.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.state.journal.length, before, "late provider response cannot replace settled uncertain evidence");
});

test("expired proof callback cannot start a late fork", async (t) => {
  let late;
  const f = await fixture(t, {
    proof: async (proof) => {
      late = proof.commit;
      return new Promise(() => {});
    },
  });
  const observed = await f.execute();
  assert.equal(observed.receipt.status, "timed-out");
  await assert.rejects(late(), { code: "CODEX_NATIVE_FORK_PROOF_REPLAYED" });
  assert.equal(
    f.state.calls.some((call) => call.method === "thread/fork"),
    false,
  );
});

test("child re-read must return the exact known child before a turn", async (t) => {
  const f = await fixture(t, {
    request: async (call, state) => {
      if (call.method === "thread/read" && call.params.threadId === childThreadId) return { thread: { ...copy(state.child), id: "other-child" } };
    },
  });
  assert.equal((await f.execute()).receipt.status, "failed");
  assert.equal(f.state.cleanups[0].reason, "CODEX_NATIVE_FORK_CHILD_MISMATCH");
  assert.equal(
    f.state.calls.some((call) => call.method === "turn/start"),
    false,
  );
});

test("literal Windows root in a result is rejected before semantic publication", async (t) => {
  const f = await fixture(t, {
    notification: async (_limits, state) => {
      state.finalTurn = {
        id: workerTurnId,
        status: "completed",
        items: [{ type: "agentMessage", id: "result", text: JSON.stringify({ ...result, outcome: state.root.replaceAll("/", "\\") }) }],
      };
      return { method: "turn/completed", params: { threadId: childThreadId, turn: copy(state.finalTurn) } };
    },
  });
  const observed = await f.execute();
  assert.equal(observed.receipt.status, "failed");
  assert.equal(observed.draft.providerResult, null);
  assert.equal(f.state.cleanups[0].reason, "CODEX_NATIVE_FORK_SENSITIVE_RESULT");
});

test("final hydration cannot silently replace the completed result items", async (t) => {
  const f = await fixture(t, {
    request: async (call, state) => {
      if (call.method === "thread/read" && call.params.threadId === childThreadId && state.finalTurn) {
        return { thread: { ...state.child, turns: [historical("cutoff"), { ...state.finalTurn, items: [] }] } };
      }
    },
  });
  assert.equal((await f.execute()).receipt.status, "failed");
  assert.equal(f.state.cleanups[0].reason, "CODEX_NATIVE_FORK_UNEXPECTED_CONTINUATION");
});

test("supervisor handle provenance rejects JSON, copies, synthetic spawn and other invocation/source ownership", async (t) => {
  const f = await fixture(t);
  const selection = resolveVerifiedProcessSupervisor({
    pluginRoot: process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || process.env.HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || pluginRoot,
  });
  const ownershipBinding = {
    authorizationHash: f.authorization.authorizationHash,
    consumptionId: "synthetic-consumption",
    policyDigest: hash(JSON.stringify(f.policy)),
    inputDigest: f.authorization.executionInput.digest,
    executionRootDigest: hash(f.root),
  };
  const expected = {
    ownershipBinding,
    executablePathDigest: hash(path.resolve(process.execPath)),
    executionRootDigest: hash(f.root),
    supervisorManifestDigest: selection.manifest.manifestHash,
    notBefore: 0,
    requireActualSpawn: false,
  };
  const fakeChild = new EventEmitter();
  Object.assign(fakeChild, { pid: 1, exitCode: null, signalCode: null });
  let unexpectedSpawns = 0;
  assert.throws(
    () =>
      spawnSupervisedProcess({
        selection: { ...selection, binaryPath: process.execPath },
        executablePath: process.execPath,
        args: [],
        cwd: f.root,
        input: Buffer.alloc(0),
        providerEnvironment: {},
        controlFile: path.join(f.operational, "wrong-binary.jsonl"),
        terminationGraceMs: 100,
        ownershipBinding,
        spawnImplementation: () => {
          unexpectedSpawns++;
          return fakeChild;
        },
      }),
    { code: "RUNTIME_SUPERVISOR_HANDLE_OWNERSHIP_MISMATCH" },
  );
  assert.equal(unexpectedSpawns, 0);
  const handle = spawnSupervisedProcess({
    selection,
    executablePath: process.execPath,
    args: [],
    cwd: f.root,
    input: Buffer.alloc(0),
    providerEnvironment: {},
    controlFile: path.join(f.operational, "synthetic-control.jsonl"),
    terminationGraceMs: 100,
    ownershipBinding,
    spawnImplementation: () => fakeChild,
  });
  try {
    assert.equal(verifyRuntimeProcessSupervisorHandle(handle, expected).actualSpawn, false);
    for (const forged of [{}, { ...handle }, { child: fakeChild, terminate: () => {}, finalize: () => ({ treeCleanupVerified: true }) }]) {
      assert.throws(() => verifyRuntimeProcessSupervisorHandle(forged, expected), { code: "RUNTIME_SUPERVISOR_HANDLE_OWNERSHIP_MISMATCH" });
    }
    for (const mismatch of [
      { requireActualSpawn: true },
      { ownershipBinding: { ...ownershipBinding, consumptionId: "another-invocation" } },
      { executionRootDigest: hash("source-root") },
      { executablePathDigest: hash("shared-source-app-server") },
      { notBefore: Date.now() + 1000 },
    ]) {
      assert.throws(() => verifyRuntimeProcessSupervisorHandle(handle, { ...expected, ...mismatch }), { code: "RUNTIME_SUPERVISOR_HANDLE_OWNERSHIP_MISMATCH" });
    }
  } finally {
    fakeChild.exitCode = 0;
    fakeChild.emit("close", 0);
  }
});

test("real native supervisor identity proof uses a model-free owned Node child", async (t) => {
  const f = await fixture(t);
  const selection = resolveVerifiedProcessSupervisor({
    pluginRoot: process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || process.env.HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || pluginRoot,
  });
  const ownershipBinding = {
    authorizationHash: f.authorization.authorizationHash,
    consumptionId: "synthetic-native-identity",
    policyDigest: hash(JSON.stringify(f.policy)),
    inputDigest: f.authorization.executionInput.digest,
    executionRootDigest: hash(f.root),
  };
  const startedAt = Date.now();
  const args = ["--eval", "process.stdout.write(JSON.stringify({pid:process.pid,parentPid:process.ppid,cwd:process.cwd(),ports:[]}));"];
  t.diagnostic(
    JSON.stringify({ event: "planned", command: process.execPath, args, cwd: f.root, parentPid: process.pid, ports: [], actualProviderInvoked: false }),
  );
  const handle = spawnSupervisedProcess({
    selection,
    executablePath: process.execPath,
    args,
    cwd: f.root,
    input: Buffer.alloc(0),
    providerEnvironment: process.env,
    controlFile: path.join(f.operational, "owned-native-control.jsonl"),
    terminationGraceMs: 100,
    ownershipBinding,
  });
  t.diagnostic(JSON.stringify({ event: "started", pid: handle.child.pid, parentPid: process.pid, command: selection.binaryPath, cwd: f.root, ports: [] }));
  let stdout = "";
  handle.child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  handle.child.stderr.resume();
  let timer;
  let forceTimer;
  let closed = false;
  try {
    const exitCode = await new Promise((resolve, reject) => {
      handle.child.once("error", reject);
      handle.child.once("close", (code) => {
        closed = true;
        resolve(code);
      });
      timer = setTimeout(() => {
        handle.terminate(false);
        forceTimer = setTimeout(() => handle.terminate(true), 300);
      }, 4000);
    });
    assert.equal(exitCode, 0);
    const identity = verifyRuntimeProcessSupervisorHandle(handle, {
      ownershipBinding,
      executablePathDigest: hash(path.resolve(process.execPath)),
      executionRootDigest: hash(f.root),
      supervisorManifestDigest: selection.manifest.manifestHash,
      notBefore: startedAt,
    });
    assert.equal(identity.actualSpawn, true);
    const supervision = handle.finalize({ exactSupervisorExitObserved: true, terminationRequested: false });
    assert.equal(supervision.treeCleanupVerified, true);
    assert.equal(supervision.ownershipEstablished, true);
    assert.equal(supervision.providerChildExitObserved, true);
    const provider = JSON.parse(stdout);
    assert.equal(provider.cwd, f.root);
    for (const pid of [handle.child.pid, provider.pid]) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    t.diagnostic(JSON.stringify({ event: "closed", pid: handle.child.pid, providerPid: provider.pid, exitCode, ports: [], cleanupVerified: true }));
  } finally {
    clearTimeout(timer);
    clearTimeout(forceTimer);
    if (!closed) {
      handle.terminate(true);
      await new Promise((resolve) => handle.child.once("close", resolve));
    }
  }
});

test("result extraction never accepts another thread/turn or incomplete items", () => {
  const notification = {
    method: "turn/completed",
    params: {
      threadId: childThreadId,
      turn: { id: workerTurnId, status: "completed", items: [{ type: "agentMessage", id: "result", text: JSON.stringify(result) }] },
    },
  };
  assert.deepEqual(extractCodexNativeForkResult({ notification, threadId: childThreadId, turnId: workerTurnId, scopeKind: "session" }), result);
  notification.params.turn.itemsView = "summary";
  assert.throws(() => extractCodexNativeForkResult({ notification, threadId: childThreadId, turnId: workerTurnId, scopeKind: "session" }), {
    code: "CODEX_NATIVE_FORK_INCOMPLETE_RESULT",
  });
});

for (const [code, status] of [
  ["CODEX_RPC_CANCELLED", "cancelled"],
  ["CODEX_RPC_DEADLINE", "timed-out"],
]) {
  test(`concrete transport ${code} preserves native receipt status and existing result route`, async (t) => {
    const f = await fixture(t, {
      request: async () => {
        throw Object.assign(new Error("Synthetic transport stop"), { code });
      },
    });
    const observed = await f.execute();
    assert.equal(observed.receipt.status, status);
    assert.equal(observed.draft.providerResult, null);
    assert.equal(f.state.cleanups.length, 1);
    assert.equal(f.state.cleanups[0].reason, status === "cancelled" ? "CODEX_NATIVE_FORK_CANCELLED" : "CODEX_NATIVE_FORK_DEADLINE");
    assert.equal(
      inspectRuntimeExecutionLease({
        projectRoot: f.root,
        storage: f.storage,
        projectId: f.authorization.projectId,
        authorizationId: f.authorization.authorizationId,
      }).status,
      "consumed-released",
    );
  });
}

test("late cancellation after native terminal settlement does not rewrite success", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const observed = await f.execute({ signal: controller.signal });
  const before = JSON.stringify(observed.receipt);
  controller.abort();
  assert.equal(observed.receipt.status, "completed");
  assert.equal(JSON.stringify(observed.receipt), before);
  assert.equal(
    inspectRuntimeExecutionLease({
      projectRoot: f.root,
      storage: f.storage,
      projectId: f.authorization.projectId,
      authorizationId: f.authorization.authorizationId,
    }).release.operationStatus,
    "completed",
  );
});
