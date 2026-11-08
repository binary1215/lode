import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/lode-core.mjs";
import { buildRuntimeVersionEvidence } from "../scripts/lib/runtime-machine-execution.mjs";
import { buildRuntimeProjectBinding, buildRuntimeProtocolEvidence } from "../scripts/lib/runtime-protocol-evidence.mjs";
import { buildRuntimeInvocationAuthorization, prepareRuntimeInvocationExecution } from "../scripts/lib/runtime-invocation-lifecycle.mjs";
import { captureWorkerSourceBasis } from "../scripts/lib/worker-source-basis.mjs";
import { captureWorkerWriteBasis } from "../scripts/lib/worker-patch-basis.mjs";
import { prepareWorkerWorkspace, workerExecutionBoundary } from "../scripts/lib/worker-workspace.mjs";
import {
  buildCodexWorkerPolicyPlan,
  bindCodexWorkerPolicyCapability,
  createCodexWorkerPolicyHost,
  withCodexWorkerPolicyCapability,
  inspectCodexWorkerPolicyCapability,
} from "../scripts/lib/runtime-codex-worker-policy.mjs";
import { executeCodexRuntimeInvocation } from "../scripts/lib/runtime-codex-exec.mjs";
import { resolveVerifiedProcessSupervisor } from "../scripts/lib/runtime-process-supervisor.mjs";
import { RUNTIME_OPERATIONAL_STATE_ENV, inspectRuntimeExecutionLease } from "../scripts/lib/runtime-execution-lease.mjs";
import { readRuntimeInvocationRecord } from "../scripts/lib/runtime-invocation-record.mjs";
import {
  createBoundedWorkerJobHost,
  startBoundedWorkerJob,
  readBoundedWorkerJob,
  cancelBoundedWorkerJob,
  reconcileBoundedWorkerJob,
} from "../scripts/lib/bounded-worker-job.mjs";
import { connectCodexWorkerHost } from "./helpers/codex-selected-fixture-host.mjs";
import runCodexWorker from "../scripts/lib/runtime-codex-worker-runner.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const hostModuleFile = path.join(import.meta.dirname, "helpers", "codex-selected-fixture-host.mjs");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
console.log(
  JSON.stringify({
    event: "owned-codex-selected-tests",
    pid: process.pid,
    parentPid: process.ppid,
    command: process.execPath,
    args: process.argv.slice(1),
    cwd: process.cwd(),
    ports: [],
    actualProviderInvoked: false,
  }),
);

function schemaSpawn(_command, args) {
  const command = args.join(" ");
  const output =
    command === "--version"
      ? "codex 1.2.3\n"
      : command === "--help"
        ? "exec\nmcp-server\napp-server\n"
        : command === "exec --help"
          ? "Run Codex non-interactively\n--json\n--output-schema\n--color\n--sandbox\n--skip-git-repo-check\n--cd\n--ephemeral\n--ignore-user-config\n--ignore-rules\nresume\n"
          : "stdio://\ngenerate-json-schema\n--listen\n";
  const child = new EventEmitter();
  Object.assign(child, { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null });
  child.kill = () => {
    throw new Error("No actual process exists in schema fixture");
  };
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(output));
    child.exitCode = 0;
    child.emit("close", 0, null);
  });
  return child;
}

async function fixture(t, { mode = "success", timeoutMs = 8000, evidenceMode = "protocol-fixture" } = {}) {
  const parent = fs.realpathSync(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const container = fs.mkdtempSync(path.join(parent, "head-codex-selected-"));
  const root = path.join(container, "project");
  const bin = path.join(container, "bin");
  const operational = path.join(container, "operational");
  for (const directory of [root, bin, operational]) fs.mkdirSync(directory);
  const previous = process.env[RUNTIME_OPERATIONAL_STATE_ENV];
  process.env[RUNTIME_OPERATIONAL_STATE_ENV] = operational;
  t.after(() => {
    if (previous === undefined) delete process.env[RUNTIME_OPERATIONAL_STATE_ENV];
    else process.env[RUNTIME_OPERATIONAL_STATE_ENV] = previous;
    assert.equal(path.dirname(container), parent);
    assert.match(path.basename(container), /^head-codex-selected-/);
    fs.rmSync(container, { recursive: true, force: true });
  });
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  assert.equal(storage.directory, ".lode");
  assert.equal(fs.existsSync(path.resolve(root, ".lode/project.json")), true);
  assert.equal(fs.existsSync(path.resolve(root, ".head/project.json")), false);
  fs.writeFileSync(path.join(root, "selected.txt"), "selected dirty bytes Ω\r\n");
  const executable = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(executable, "Synthetic executable identity only; never executed\n");
  if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
  const environment = { ...process.env, PATH: bin };
  delete environment.Path;
  delete environment.path;
  const versionEvidence = await buildRuntimeVersionEvidence({ runtimes: ["codex"], environment, spawnImplementation: schemaSpawn });
  const protocolEvidence = await buildRuntimeProtocolEvidence({ runtimes: ["codex"], environment, versionEvidence, spawnImplementation: schemaSpawn });
  const inspected = inspectProject(root);
  const projectBinding = buildRuntimeProjectBinding({
    storage,
    projectId: inspected.project.projectId,
    headSessionId: inspected.state.sessionId,
    projectRoot: root,
    projectStatus: "ready",
    versionEvidence,
    protocolEvidence,
  });
  const sourceBasis = captureWorkerSourceBasis({ root, paths: ["selected.txt"], maxBytes: 1024 * 1024 });
  const workspaceBinding = prepareWorkerWorkspace({ projectRoot: root, workspaceRoot: path.join(container, "selected"), sourceBasis, maxBytes: 1024 * 1024 });
  const policy = buildCodexWorkerPolicyPlan({
    executablePath: executable,
    executableDigest: hash(fs.readFileSync(executable)),
    model: "openai/gpt-5.6-sol",
    wireModel: "gpt-5.6-sol",
    wireModelProvider: "openai",
    workspaceMode: mode === "write" ? "workspace-write" : "read-only",
    evidenceMode,
  });
  const writeBasis = mode === "write" ? captureWorkerWriteBasis({ root, paths: ["selected.txt"], maxBytes: 1024 * 1024 }) : null;
  const boundary = workerExecutionBoundary({
    binding: workspaceBinding,
    policy,
    sourceBasis,
    ownedPaths: mode === "write" ? ["selected.txt"] : [],
    writeBasis,
  });
  const authorize = ({ taskKey = "selected-worker", model = "openai/gpt-5.6-sol" } = {}) =>
    buildRuntimeInvocationAuthorization({
      root,
      runtime: "codex",
      runtimeSelection: { model },
      workspaceMode: policy.workspaceMode,
      scope: { kind: "session", request: "Return bounded synthetic result Ω\r\n" },
      protocolEvidence,
      projectBinding,
      worker: {
        taskKey,
        role: "coder",
        outcome: "Synthetic selected result",
        selectedContext: "No actual provider or sandbox proof",
        sourcePaths: ["selected.txt"],
        executionBoundary: boundary,
      },
      limits: { timeoutMs },
      persist: true,
    }).authorization;
  const authorization = authorize();
  const target = { executablePath: executable, observation: protocolEvidence.observations[0].executable };
  const host = createCodexWorkerPolicyHost({ evidenceMode, withVerifiedPolicy: (request) => request.commit() });
  const bind = (extra = {}) => bindCodexWorkerPolicyCapability({ host, policy, authorization, workspaceBinding, root, target, ...extra });
  const capability = bind();
  const lease = () =>
    inspectRuntimeExecutionLease({ projectRoot: root, storage, projectId: authorization.projectId, authorizationId: authorization.authorizationId });
  return {
    storage,
    container,
    root,
    executable,
    operational,
    policy,
    workspaceBinding,
    authorization,
    protocolEvidence,
    projectBinding,
    target,
    bind,
    capability,
    lease,
    authorize,
    mode,
    sessionFile: path.join(root, storage.directory, "sessions", "current.json"),
  };
}

test("typed plan is intent; missing, plain JSON and returned boolean proof never consume or spawn", async (t) => {
  const f = await fixture(t);
  let spawned = 0;
  const execute = (capability) =>
    executeCodexRuntimeInvocation(
      {
        root: f.root,
        authorization: f.authorization,
        protocolEvidence: f.protocolEvidence,
        projectBinding: f.projectBinding,
        evidenceMode: "protocol-fixture",
        targetResolver: () => f.target,
        supervisorSelection: {},
        spawnImplementation: () => {
          spawned++;
          throw new Error("Unexpected spawn");
        },
      },
      { workerPolicyCapability: capability },
    );
  for (const invalid of [null, {}, f.policy, JSON.parse(JSON.stringify(f.capability))]) {
    await assert.rejects(execute(invalid), { code: "WORKER_JOB_POLICY_UNAVAILABLE" });
  }
  const host = createCodexWorkerPolicyHost({ evidenceMode: "protocol-fixture", withVerifiedPolicy: () => ({ verified: true }) });
  await assert.rejects(execute(f.bind({ host })), { code: "WORKER_JOB_POLICY_UNAVAILABLE" });
  assert.equal(f.lease().status, "available");
  assert.equal(spawned, 0);
  assert.equal(f.policy.enforcementVerified, false);
  assert.equal(Object.hasOwn(f.policy, "actualProviderInvoked"), false);
  const actualPlan = buildCodexWorkerPolicyPlan({
    executablePath: f.executable,
    executableDigest: hash(fs.readFileSync(f.executable)),
    model: "openai/gpt-5.6-sol",
    wireModel: "gpt-5.6-sol",
    wireModelProvider: "openai",
  });
  assert.equal(Object.hasOwn(actualPlan, "actualProviderInvoked"), false);
  assert.equal(actualPlan.enforcementVerified, false);
  assert.throws(
    () =>
      buildCodexWorkerPolicyPlan({
        executablePath: f.executable,
        executableDigest: hash(fs.readFileSync(f.executable)),
        model: "openai/gpt-5.6-sol",
        wireModel: "different-model",
        wireModelProvider: "openai",
      }),
    { code: "INVALID_CODEX_WORKER_POLICY" },
  );
  assert.ok(Object.isFrozen(f.policy.invocationConstraints));
});

test("policy capability rejects cross authorization, model, root, plan and evidence mode", async (t) => {
  const f = await fixture(t);
  const other = f.authorize({ taskKey: "other-worker" });
  const wrongModel = f.authorize({ taskKey: "model-worker", model: "fixture/another-model" });
  let committed = 0;
  const use = (extra) =>
    withCodexWorkerPolicyCapability({ capability: f.capability, authorization: f.authorization, root: f.root, target: f.target, ...extra }, () => {
      committed++;
    });
  await assert.rejects(use({ authorization: other }), { code: "CODEX_WORKER_POLICY_BINDING_DRIFT" });
  assert.throws(() => f.bind({ authorization: wrongModel }), { code: "CODEX_WORKER_POLICY_BINDING_DRIFT" });
  await assert.rejects(use({ root: f.workspaceBinding.executionRoot }), { code: "CODEX_WORKER_POLICY_BINDING_DRIFT" });
  assert.throws(() => f.bind({ policy: { ...f.policy, enforcementVerified: true } }), { code: "INVALID_CODEX_WORKER_POLICY" });
  const actual = createCodexWorkerPolicyHost({ evidenceMode: "actual-provider", withVerifiedPolicy: (request) => request.commit() });
  assert.throws(() => f.bind({ host: actual }), { code: "CODEX_WORKER_POLICY_EVIDENCE_MISMATCH" });
  assert.equal(committed, 0);
  assert.equal(f.lease().status, "available");
});

for (const drift of ["selected-bytes", "selected-extra", "selected-root", "source-bytes", "executable", "lineage"]) {
  test(`callback-time ${drift} drift fails before consumption`, async (t) => {
    const f = await fixture(t);
    const host = createCodexWorkerPolicyHost({
      evidenceMode: "protocol-fixture",
      withVerifiedPolicy: async (request) => {
        await Promise.resolve();
        if (drift === "selected-bytes") fs.writeFileSync(path.join(f.workspaceBinding.executionRoot, "selected.txt"), "changed");
        if (drift === "selected-extra") fs.writeFileSync(path.join(f.workspaceBinding.executionRoot, "extra.txt"), "unexpected");
        if (drift === "selected-root") {
          fs.renameSync(f.workspaceBinding.executionRoot, path.join(f.container, "retained-selected-root"));
          fs.mkdirSync(f.workspaceBinding.executionRoot);
          fs.writeFileSync(path.join(f.workspaceBinding.executionRoot, "selected.txt"), "selected dirty bytes Ω\r\n");
        }
        if (drift === "source-bytes") fs.writeFileSync(path.join(f.root, "selected.txt"), "changed");
        if (drift === "executable") fs.appendFileSync(f.executable, "changed");
        if (drift === "lineage") {
          const state = JSON.parse(fs.readFileSync(f.sessionFile));
          state.sessionId = "different-session";
          fs.writeFileSync(f.sessionFile, JSON.stringify(state));
        }
        return request.commit();
      },
    });
    const capability = f.bind({ host });
    let spawned = 0;
    await assert.rejects(
      executeCodexRuntimeInvocation(
        {
          root: f.root,
          authorization: f.authorization,
          protocolEvidence: f.protocolEvidence,
          projectBinding: f.projectBinding,
          evidenceMode: "protocol-fixture",
          targetResolver: () => f.target,
          supervisorSelection: {},
          spawnImplementation: () => {
            spawned++;
          },
        },
        { workerPolicyCapability: capability },
      ),
    );
    assert.equal(spawned, 0);
    assert.equal(f.lease().status, "available");
  });
}

test("selected adapter rejects argument override and synthetic proof upgrade", async (t) => {
  const f = await fixture(t);
  for (const extra of [{ providerArguments: ["arbitrary"] }, { evidenceMode: "actual-provider" }]) {
    await assert.rejects(
      executeCodexRuntimeInvocation(
        {
          root: f.root,
          authorization: f.authorization,
          protocolEvidence: f.protocolEvidence,
          projectBinding: f.projectBinding,
          targetResolver: () => f.target,
          evidenceMode: "protocol-fixture",
          ...extra,
        },
        { workerPolicyCapability: f.capability },
      ),
      { code: extra.providerArguments ? "CODEX_EXEC_ARGUMENT_OVERRIDE_REJECTED" : "CODEX_WORKER_POLICY_EVIDENCE_MISMATCH" },
    );
  }
  assert.equal(f.lease().status, "available");
});

test("expired Host callback and changed reconnect code cannot create a detached claim", async (t) => {
  const f = await fixture(t);
  let late;
  const noCommit = createCodexWorkerPolicyHost({
    evidenceMode: "protocol-fixture",
    withVerifiedPolicy: ({ commit }) => {
      late = commit;
    },
  });
  await assert.rejects(
    withCodexWorkerPolicyCapability({ capability: f.bind({ host: noCommit }), authorization: f.authorization, root: f.root, target: f.target }, () => {}),
    { code: "WORKER_JOB_POLICY_UNAVAILABLE" },
  );
  assert.throws(() => late(), { code: "CODEX_WORKER_POLICY_CALLBACK_REPLAYED" });
  const moduleFile = path.join(f.container, "trusted-host.mjs");
  fs.writeFileSync(moduleFile, "export const fixture = true;\n");
  const mutating = createCodexWorkerPolicyHost({
    evidenceMode: "protocol-fixture",
    withVerifiedPolicy: async (request) => {
      await Promise.resolve();
      fs.appendFileSync(moduleFile, "// Changed after admission\n");
      return request.commit();
    },
  });
  const host = createBoundedWorkerJobHost({
    policy: f.policy,
    workspaceBinding: f.workspaceBinding,
    codexPolicyCapability: f.bind({ host: mutating }),
    hostModuleFile: moduleFile,
  });
  await assert.rejects(
    startBoundedWorkerJob(
      { root: f.root, authorizationId: f.authorization.authorizationId, role: "coder" },
      {
        host,
        spawnImplementation: () => {
          throw new Error("Must not spawn");
        },
      },
    ),
    { code: "WORKER_JOB_CODE_DRIFT" },
  );
  assert.equal(f.lease().status, "available");
  assert.equal(fs.existsSync(path.join(f.operational, "worker-jobs")), false);
});

for (const reason of ["cancel", "timeout"]) {
  test(`hung pre-consume Host verifier is bounded by ${reason} and rejects late commit`, async (t) => {
    const f = await fixture(t, { timeoutMs: 1000 });
    const controller = new AbortController();
    let request;
    let unblock;
    const host = createCodexWorkerPolicyHost({
      evidenceMode: "protocol-fixture",
      withVerifiedPolicy: (value) => {
        request = value;
        if (reason === "cancel") queueMicrotask(() => controller.abort());
        return new Promise((resolve) => {
          unblock = resolve;
        });
      },
    });
    let spawned = 0;
    await assert.rejects(
      executeCodexRuntimeInvocation(
        {
          root: f.root,
          authorization: f.authorization,
          protocolEvidence: f.protocolEvidence,
          projectBinding: f.projectBinding,
          evidenceMode: "protocol-fixture",
          targetResolver: () => f.target,
          supervisorSelection: {},
          signal: controller.signal,
          spawnImplementation: () => {
            spawned++;
          },
        },
        { workerPolicyCapability: f.bind({ host }) },
      ),
      { code: reason === "cancel" ? "CODEX_WORKER_POLICY_CANCELLED" : "CODEX_WORKER_POLICY_TIMEOUT" },
    );
    assert.equal(request.signal.aborted, true);
    assert.ok(Number.isSafeInteger(request.deadlineUnixMs));
    assert.throws(() => request.commit(), { code: "CODEX_WORKER_POLICY_CALLBACK_REPLAYED" });
    unblock();
    await Promise.resolve();
    assert.equal(f.lease().status, "available");
    assert.equal(spawned, 0);
  });
}

async function transport(f) {
  const supervisorSelection = resolveVerifiedProcessSupervisor({
    pluginRoot: process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || process.env.HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || pluginRoot,
  });
  fs.writeFileSync(
    path.join(f.container, "fixture-connection.json"),
    JSON.stringify({
      executable: f.executable,
      storage: f.storage,
      protocolEvidence: f.protocolEvidence,
      projectBinding: f.projectBinding,
      supervisorSelection,
      mode: f.mode,
    }),
  );
  return {
    supervisorSelection,
    ...(await connectCodexWorkerHost({ root: f.root, executionRoot: f.workspaceBinding.executionRoot, authorization: f.authorization, policy: f.policy })),
  };
}

for (const failure of ["missingExecution", "resolverError", "invalidHost", "closeError"]) {
  test(`fixed runner closes its reconnected Host on ${failure} before any lease use`, async (t) => {
    const f = await fixture(t);
    fs.writeFileSync(
      path.join(f.container, "fixture-connection.json"),
      JSON.stringify({
        executable: f.executable,
        storage: f.storage,
        protocolEvidence: f.protocolEvidence,
        projectBinding: f.projectBinding,
        [failure]: true,
        ...(failure === "closeError" ? { resolverError: true } : {}),
      }),
      { flag: "wx" },
    );
    const expected =
      failure === "closeError"
        ? "CODEX_WORKER_HOST_CLEANUP_FAILED"
        : failure === "resolverError"
          ? "SYNTHETIC_RESOLVER_FAILURE"
          : "WORKER_JOB_POLICY_UNAVAILABLE";
    await assert.rejects(
      runCodexWorker({
        root: f.root,
        executionRoot: f.workspaceBinding.executionRoot,
        authorization: f.authorization,
        policy: f.policy,
        workspaceBinding: f.workspaceBinding,
        hostModuleFile,
      }),
      (error) => {
        assert.equal(error.code, expected);
        if (failure === "closeError")
          assert.deepEqual(
            error.errors.map((item) => item.code),
            ["SYNTHETIC_RESOLVER_FAILURE", "SYNTHETIC_CLOSE_FAILURE"],
          );
        return true;
      },
    );
    assert.equal(f.lease().status, "available");
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.container, "fixture-connection-closed.json"))).actualProviderInvoked, false);
    assert.equal(fs.existsSync(path.join(f.container, "assembled-request.json")), false);
  });
}

for (const mode of ["success", "cancel", "timeout"]) {
  test(`fixed runner awaits invocation settlement before Host close: ${mode}`, async (t) => {
    const f = await fixture(t, { mode: mode === "success" ? "success" : "wait", timeoutMs: mode === "timeout" ? 1000 : 8000 });
    await transport(f);
    const controller = new AbortController();
    const owned = [];
    const result = await runCodexWorker({
      root: f.root,
      executionRoot: f.workspaceBinding.executionRoot,
      authorization: f.authorization,
      policy: f.policy,
      workspaceBinding: f.workspaceBinding,
      hostModuleFile,
      signal: controller.signal,
      onProcess: (event) => {
        console.log(JSON.stringify(event));
        if (event.type === "spawn") {
          owned.push(event.pid);
          if (mode === "cancel" && event.command === "codex exec") controller.abort();
        }
      },
    });
    assert.equal(result.receipt.status, mode === "success" ? "completed" : mode === "cancel" ? "cancelled" : "timed-out");
    assert.equal(f.lease().status, "consumed-released");
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.container, "fixture-connection-closed.json"))).leaseFilesPresent, true);
    for (const pid of owned) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
}

for (const failure of ["throws-after-start", "stalls-after-settlement"]) {
  test(`Host ${failure} cannot return with consumed provider work still running`, async (t) => {
    const f = await fixture(t, { mode: failure === "throws-after-start" ? "wait" : "success", timeoutMs: 1000 });
    const connection = await transport(f);
    let started;
    const providerStarted = new Promise((resolve) => {
      started = resolve;
    });
    let releaseVerifier;
    const host = createCodexWorkerPolicyHost({
      evidenceMode: "protocol-fixture",
      withVerifiedPolicy: async (request) => {
        const operation = request.commit();
        if (failure === "throws-after-start") {
          await providerStarted;
          throw Object.assign(new Error("Synthetic verifier failure after provider started"), { code: "SYNTHETIC_HOST_FAILURE" });
        }
        await operation;
        await new Promise((resolve) => {
          releaseVerifier = resolve;
        });
      },
    });
    const owned = [];
    await assert.rejects(
      executeCodexRuntimeInvocation(
        {
          ...connection.execution,
          root: f.root,
          authorization: f.authorization,
          evidenceMode: "protocol-fixture",
          onProcessEvent: (event) => {
            console.log(JSON.stringify(event));
            if (event.type === "spawn") {
              owned.push(event.pid);
              if (event.command === "codex exec") started();
            }
          },
        },
        { workerPolicyCapability: f.bind({ host }) },
      ),
      { code: failure === "throws-after-start" ? "SYNTHETIC_HOST_FAILURE" : "CODEX_WORKER_POLICY_TIMEOUT" },
    );
    releaseVerifier?.();
    await Promise.resolve();
    assert.equal(f.lease().status, "consumed-released");
    assert.ok(owned.length >= 2);
    for (const pid of owned) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
}

for (const reason of ["cancel", "timeout"]) {
  test(`selected ${reason} returns the existing settled receipt after exact cleanup`, async (t) => {
    const f = await fixture(t, { mode: "wait", timeoutMs: reason === "timeout" ? 1000 : 8000 });
    const connection = await transport(f);
    const controller = new AbortController();
    const owned = [];
    const result = await executeCodexRuntimeInvocation(
      {
        ...connection.execution,
        root: f.root,
        authorization: f.authorization,
        signal: controller.signal,
        evidenceMode: "protocol-fixture",
        onProcessEvent: (event) => {
          console.log(JSON.stringify(event));
          if (event.type === "spawn") {
            owned.push(event.pid);
            if (reason === "cancel" && event.command === "codex exec") controller.abort();
          }
        },
      },
      { workerPolicyCapability: f.bind({ host: connection.policyHost }) },
    );
    assert.equal(result.receipt.status, reason === "timeout" ? "timed-out" : "cancelled");
    assert.equal(f.lease().status, "consumed-released");
    assert.equal(result.executionLease.release.releaseId, f.lease().release.releaseId);
    for (const pid of owned) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
}

for (const mode of ["success", "expose-root"]) {
  test(`assembled selected argv/stdin and canonical receipt roots: ${mode}`, async (t) => {
    const f = await fixture(t, { mode });
    const connection = await transport(f);
    const beforeP2 = fs.readFileSync(f.sessionFile);
    const owned = [];
    let policyActive = false;
    const guardedHost = createCodexWorkerPolicyHost({
      evidenceMode: "protocol-fixture",
      withVerifiedPolicy: async (request) => {
        policyActive = true;
        try {
          return await request.commit();
        } finally {
          policyActive = false;
        }
      },
    });
    const originalSpawn = connection.execution.spawnImplementation;
    const outcome = await executeCodexRuntimeInvocation(
      {
        ...connection.execution,
        root: f.root,
        authorization: f.authorization,
        spawnImplementation: (...args) => {
          assert.equal(policyActive, true);
          return originalSpawn(...args);
        },
        evidenceMode: "protocol-fixture",
        onProcessEvent: (event) => {
          assert.equal(policyActive, true);
          console.log(JSON.stringify(event));
          if (event.type === "spawn") owned.push(event.pid);
        },
      },
      { workerPolicyCapability: f.bind({ host: guardedHost }) },
    );
    assert.equal(policyActive, false);
    const request = JSON.parse(fs.readFileSync(path.join(f.container, "assembled-request.json")));
    assert.equal(request.workingDirectory, f.workspaceBinding.executionRoot);
    assert.equal(f.authorization.runtimeSelection.model, "openai/gpt-5.6-sol");
    assert.equal(request.arguments[request.arguments.indexOf("--model") + 1], "gpt-5.6-sol");
    assert.deepEqual(Buffer.from(request.inputBase64, "base64"), prepareRuntimeInvocationExecution({ root: f.root, authorization: f.authorization }).input);
    assert.equal(outcome.receipt.status, mode === "success" ? "completed" : "invalid-event");
    assert.equal(outcome.actualProviderInvoked, false);
    assert.equal(f.lease().status, "consumed-released");
    assert.equal(outcome.executionLease.consumption.consumptionId, f.lease().consumption.consumptionId);
    assert.equal(outcome.executionLease.release.releaseId, f.lease().release.releaseId);
    assert.equal(
      readRuntimeInvocationRecord({ root: f.root, storage: f.storage, authorizationId: f.authorization.authorizationId }).receipt.receiptId,
      outcome.receipt.receiptId,
    );
    assert.deepEqual(fs.readFileSync(f.sessionFile), beforeP2);
    assert.equal(fs.existsSync(path.join(f.workspaceBinding.executionRoot, ".head")), false);
    assert.equal(fs.existsSync(path.join(f.workspaceBinding.executionRoot, ".lode")), false);
    assert.equal(fs.existsSync(path.join(f.operational, "runtime-provider-invocations")), false);
    for (const pid of owned) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
}

for (const mode of ["success", "write", "cancel", "timeout"]) {
  test(`fixed detached Host reconnect settles exact selected job: ${mode}`, { skip: process.platform !== "win32" }, async (t) => {
    const f = await fixture(t, { mode: mode === "cancel" || mode === "timeout" ? "wait" : mode, timeoutMs: mode === "timeout" ? 1500 : 8000 });
    const connection = await transport(f);
    const capability = f.bind({ host: connection.policyHost });
    const host = createBoundedWorkerJobHost({ policy: f.policy, workspaceBinding: f.workspaceBinding, codexPolicyCapability: capability, hostModuleFile });
    const beforeP2 = fs.readFileSync(f.sessionFile);
    const input = { root: f.root, authorizationId: f.authorization.authorizationId, role: "coder" };
    const onProcess = (event) => console.log(JSON.stringify(event));
    let state = await startBoundedWorkerJob(input, { host, supervisorSelection: connection.supervisorSelection, onProcess });
    if (mode === "cancel") {
      const startedDeadline = Date.now() + 5000;
      while (!fs.existsSync(path.join(f.container, "assembled-request.json")) && Date.now() < startedDeadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(fs.existsSync(path.join(f.container, "assembled-request.json")), true);
      cancelBoundedWorkerJob(input, { onProcess });
    }
    const deadline = Date.now() + 15000;
    while (!state.ownerExitObserved && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = readBoundedWorkerJob(input, { onProcess });
    }
    assert.equal(state.ownerExitObserved, true);
    state = reconcileBoundedWorkerJob(input, { onProcess });
    assert.equal(state.status, mode === "cancel" ? "cancelled" : mode === "timeout" ? "timed-out" : "completed");
    if (mode === "success" || mode === "write") {
      const closedConnection = JSON.parse(fs.readFileSync(path.join(f.container, "fixture-connection-closed.json")));
      assert.equal(closedConnection.leaseFilesPresent, true);
      assert.equal(closedConnection.actualProviderInvoked, false);
    }
    // An outer owner may terminate the runner on cancellation/deadline. That
    // path relies on verified native tree cleanup, not a JS finally marker.
    assert.deepEqual(fs.readFileSync(f.sessionFile), beforeP2);
    assert.equal(fs.readFileSync(path.join(f.root, "selected.txt"), "utf8"), "selected dirty bytes Ω\r\n");
    if (mode === "success" || mode === "write") {
      assert.equal(f.lease().status, "consumed-released");
      assert.equal(state.result.actualProviderInvoked, false);
      if (mode === "write") assert.ok(state.workspacePatch);
      if (mode === "success") {
        const recordDirectory = path.join(f.root, f.storage.directory, "runtime", "invocations", f.authorization.authorizationId);
        fs.renameSync(recordDirectory, path.join(f.container, "retained-result-before-reconcile"));
        assert.equal(readBoundedWorkerJob(input, { onProcess }).status, "incomplete");
        const recovered = reconcileBoundedWorkerJob(input, { onProcess });
        assert.equal(recovered.status, "completed");
        assert.deepEqual(recovered.result, state.result);
      }
    }
    const again = await startBoundedWorkerJob(input);
    assert.equal(again.status, state.status);
  });
}
