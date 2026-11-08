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
import { buildRuntimeInvocationAuthorization } from "../scripts/lib/runtime-invocation-lifecycle.mjs";
import { createBoundedWorkerDispatch } from "../scripts/lib/bounded-worker-dispatch.mjs";
import { captureWorkerSourceBasis } from "../scripts/lib/worker-source-basis.mjs";
import { prepareWorkerWorkspace, workerExecutionBoundary } from "../scripts/lib/worker-workspace.mjs";
import { buildCodexWorkerPolicyPlan } from "../scripts/lib/runtime-codex-worker-policy.mjs";
import { codexNativeForkPrefixDigest, createCodexNativeForkOwnedTransport, createCodexNativeForkHost } from "../scripts/lib/runtime-codex-native-fork.mjs";
import { buildCodexNativeForkHostConnection, connectCodexWorkerHost, createCodexNativeForkJobHost } from "../scripts/lib/runtime-codex-worker-host.mjs";
import { resolveVerifiedProcessSupervisor } from "../scripts/lib/runtime-process-supervisor.mjs";
import { inspectRuntimeExecutionLease } from "../scripts/lib/runtime-execution-lease.mjs";
import { readRuntimeInvocationRecord } from "../scripts/lib/runtime-invocation-record.mjs";
import { startBoundedWorkerJob, readBoundedWorkerJob, cancelBoundedWorkerJob, reconcileBoundedWorkerJob } from "../scripts/lib/bounded-worker-job.mjs";
import runWorker from "../scripts/lib/runtime-codex-worker-runner.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const moduleFile = path.join(pluginRoot, "scripts/lib/runtime-codex-worker-host.mjs");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const nativeRoot = process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || process.env.HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT;
const log = (event) => console.log(JSON.stringify({ ...event, observedAt: new Date().toISOString(), actualProviderInvoked: false }));
log({
  event: "native-host-composition-tests",
  pid: process.pid,
  parentPid: process.ppid,
  command: process.execPath,
  args: process.argv.slice(1),
  cwd: process.cwd(),
  ports: [],
});
function schemaSpawn(_command, args) {
  const text =
    args.join(" ") === "--version"
      ? "codex 1.2.3\n"
      : args.join(" ") === "--help"
        ? "exec\nmcp-server\napp-server\n"
        : args.join(" ") === "exec --help"
          ? "Run Codex non-interactively\n--json\n--output-schema\n--color\n--sandbox\n--skip-git-repo-check\n--cd\n--ephemeral\nresume\n"
          : "stdio://\ngenerate-json-schema\n--listen\n";
  const child = new EventEmitter();
  Object.assign(child, { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null });
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(text));
    child.exitCode = 0;
    child.emit("close", 0, null);
  });
  return child;
}
async function fixture(t, { scenario = "native-composition", evidenceMode = "protocol-fixture" } = {}) {
  const parent = fs.realpathSync(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const dir = fs.mkdtempSync(path.join(parent, "head-product-native-host-"));
  const root = path.join(dir, "project"),
    operational = path.join(dir, "operational"),
    bin = path.join(dir, "bin");
  for (const p of [root, operational, bin]) fs.mkdirSync(p);
  const previous = process.env.HEAD_AGENT_OPERATIONAL_STATE_ROOT;
  process.env.HEAD_AGENT_OPERATIONAL_STATE_ROOT = operational;
  let detached = false;
  let authorization = null;
  t.after(async () => {
    if (detached) {
      let state = readBoundedWorkerJob({ root, authorizationId: authorization.authorizationId });
      if (!state.ownerExitObserved && state.status !== "not-started")
        await cancelBoundedWorkerJob({ root, authorizationId: authorization.authorizationId }, { onProcess: log });
      const cutoff = Date.now() + 20000;
      while (!state.ownerExitObserved && state.status !== "not-started" && Date.now() < cutoff) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        state = readBoundedWorkerJob({ root, authorizationId: authorization.authorizationId });
      }
      assert.ok(state.ownerExitObserved || state.status === "not-started", "exact detached owner must exit before fixture removal");
    }
    const file = authorization && path.join(operational, "worker-jobs", authorization.projectId, authorization.authorizationId, "native-host-transcript.jsonl");
    if (file && fs.existsSync(file)) {
      const records = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
      for (const event of records.filter((item) => item.event === "process-closed")) {
        assert.equal(event.supervision.treeCleanupVerified, true);
        for (const pid of [event.pid, event.providerPid].filter(Boolean)) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      }
      assert.equal(records.filter((item) => item.event === "process-started").length, records.filter((item) => item.event === "process-closed").length);
    }
    if (previous === undefined) delete process.env.HEAD_AGENT_OPERATIONAL_STATE_ROOT;
    else process.env.HEAD_AGENT_OPERATIONAL_STATE_ROOT = previous;
    assert.equal(path.dirname(dir), parent);
    assert.match(path.basename(dir), /^head-product-native-host-/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  assert.equal(storage.directory, ".lode");
  assert.equal(fs.existsSync(path.resolve(root, ".lode/project.json")), true);
  assert.equal(fs.existsSync(path.resolve(root, ".head/project.json")), false);
  fs.writeFileSync(path.join(root, "selected.txt"), "Synthetic source\n");
  const executable = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(executable, "Synthetic schema-only identity; never executed\n");
  if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
  const environment = { ...process.env, PATH: bin };
  delete environment.Path;
  delete environment.path;
  const versionEvidence = await buildRuntimeVersionEvidence({ runtimes: ["codex"], environment, spawnImplementation: schemaSpawn });
  const protocolEvidence = await buildRuntimeProtocolEvidence({ runtimes: ["codex"], environment, versionEvidence, spawnImplementation: schemaSpawn });
  const project = inspectProject(root);
  const projectBinding = buildRuntimeProjectBinding({
    storage,
    projectId: project.project.projectId,
    headSessionId: project.state.sessionId,
    projectRoot: root,
    projectStatus: "ready",
    versionEvidence,
    protocolEvidence,
  });
  const sourceRead = {
    thread: {
      id: "source",
      turns: [{ id: "cutoff", status: "completed", itemsView: "full", items: [{ type: "agentMessage", id: "past", text: "Synthetic public context" }] }],
    },
  };
  const source = {
    threadId: "source",
    lastTurnId: "cutoff",
    prefixDigest: codexNativeForkPrefixDigest({ sourceRead, threadId: "source", lastTurnId: "cutoff" }),
  };
  const policy = buildCodexWorkerPolicyPlan({
    executablePath: fs.realpathSync(process.execPath),
    executableDigest: hash(fs.readFileSync(process.execPath)),
    mode: "native-fork",
    evidenceMode,
    model: "synthetic/synthetic-model",
    wireModel: "synthetic-model",
    wireModelProvider: "synthetic",
    retainedContextDigest: source.prefixDigest,
  });
  const sourceBasis = captureWorkerSourceBasis({ root, paths: ["selected.txt"], maxBytes: 1024 * 1024 });
  const workspaceBinding = prepareWorkerWorkspace({ projectRoot: root, workspaceRoot: path.join(dir, "selected"), sourceBasis, maxBytes: 1024 * 1024 });
  authorization = buildRuntimeInvocationAuthorization({
    root,
    runtime: "codex",
    runtimeSelection: { model: policy.model },
    scope: { kind: "session", request: "Read synthetic selected source" },
    protocolEvidence,
    projectBinding,
    limits: { timeoutMs: 12000, terminationGraceMs: 1000 },
    worker: {
      taskKey: "native-host",
      role: "coder",
      outcome: "Bounded synthetic result",
      selectedContext: "Synthetic context only",
      sourcePaths: ["selected.txt"],
      executionBoundary: workerExecutionBoundary({ binding: workspaceBinding, policy, sourceBasis }),
    },
  }).authorization;
  createBoundedWorkerDispatch({ root, authorizationId: authorization.authorizationId, role: "coder" });
  const selection = resolveVerifiedProcessSupervisor({ pluginRoot: nativeRoot });
  const rebind = {
    modelProvider: "synthetic",
    permissions: "synthetic-selected-profile",
    baseInstructions: "Synthetic worker",
    developerInstructions: "Exact synthetic input",
    expectedSandbox: { type: "readOnly", networkAccess: false },
    instructionSources: [],
  };
  const hostConnection = buildCodexNativeForkHostConnection({
    authorization,
    policy,
    workspaceBinding,
    protocolEvidence,
    projectBinding,
    supervisorSelection: selection,
    source,
    rebind,
    scenario,
  });
  const options = {
    root,
    executionRoot: workspaceBinding.executionRoot,
    authorization,
    policy,
    workspaceBinding,
    hostModuleFile: moduleFile,
    hostConnection,
    onProcess: log,
  };
  const lease = () =>
    inspectRuntimeExecutionLease({ projectRoot: root, storage, projectId: authorization.projectId, authorizationId: authorization.authorizationId });
  const journal = () =>
    fs
      .readFileSync(path.join(operational, "worker-jobs", authorization.projectId, authorization.authorizationId, "native-host-transcript.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
  return {
    storage,
    options,
    root,
    operational,
    authorization,
    selection,
    lease,
    journal,
    detached: () => {
      detached = true;
    },
    sessionFile: path.join(root, storage.directory, "sessions/current.json"),
  };
}

test("product runner composes owned native transport, exact lease and result without P2 or provider authority", { skip: !nativeRoot }, async (t) => {
  const f = await fixture(t);
  const before = fs.readFileSync(f.sessionFile);
  const result = await runWorker(f.options);
  assert.equal(result.receipt.status, "completed");
  assert.equal(result.actualProviderInvoked, false);
  assert.equal(result.receipt.processBoundary.exactChildStarted, true);
  assert.equal(f.lease().status, "consumed-released");
  const events = f.journal();
  assert.equal(
    events.filter((e) => e.event === "request-sent" && e.method === "thread/fork").length,
    2,
    "native and transport journals each observe one same mutation",
  );
  assert.equal(events.filter((e) => e.event === "process-started").length, 1);
  assert.deepEqual(fs.readFileSync(f.sessionFile), before);
  const frozen = JSON.stringify(events);
  await assert.rejects(runWorker(f.options));
  assert.equal(JSON.stringify(f.journal()), frozen);
  assert.equal(JSON.stringify({ receipt: result.receipt, draft: result.draft }).includes("synthetic-selected-profile"), false);
});

test(
  "product native composition reconnects in detached owner without serializing a policy capability",
  { skip: !nativeRoot || process.platform !== "win32" },
  async (t) => {
    const f = await fixture(t);
    const before = fs.readFileSync(f.sessionFile);
    const host = await createCodexNativeForkJobHost(f.options);
    assert.deepEqual(Object.keys(host), []);
    f.detached();
    await startBoundedWorkerJob(
      { root: f.root, authorizationId: f.authorization.authorizationId, role: "coder" },
      { host, supervisorSelection: f.selection, onProcess: log },
    );
    let state;
    const deadline = Date.now() + 20000;
    do {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = readBoundedWorkerJob({ root: f.root, authorizationId: f.authorization.authorizationId });
    } while (!state.ownerExitObserved && Date.now() < deadline);
    assert.equal(state.ownerExitObserved, true);
    const settled = reconcileBoundedWorkerJob({ root: f.root, authorizationId: f.authorization.authorizationId });
    assert.equal(settled.status, "completed");
    assert.equal(
      readRuntimeInvocationRecord({ root: f.root, storage: f.storage, authorizationId: f.authorization.authorizationId }).receipt.status,
      "completed",
    );
    const bytes = JSON.stringify(f.journal());
    await startBoundedWorkerJob(
      { root: f.root, authorizationId: f.authorization.authorizationId, role: "coder" },
      { host, supervisorSelection: f.selection, onProcess: log },
    );
    assert.equal(JSON.stringify(f.journal()), bytes);
    assert.deepEqual(fs.readFileSync(f.sessionFile), before);
  },
);

test("installed native policy stays unsupported before consumption, artifact or process creation", { skip: !nativeRoot }, async (t) => {
  const f = await fixture(t, { evidenceMode: "actual-provider" });
  await assert.rejects(createCodexNativeForkJobHost(f.options), (error) => {
    assert.equal(error.code, "CODEX_NATIVE_FORK_INSTALLED_ENFORCEMENT_UNPROVEN");
    assert.equal(error.compatibility.capabilityIssued, false);
    assert.deepEqual(
      error.compatibility.knownApiConflicts.map((row) => row.code),
      ["fork-request-rejected", "ephemeral-history-unavailable", "goals-disabled-api-unavailable", "ephemeral-goals-unavailable"],
    );
    return true;
  });
  assert.equal(f.lease().status, "available");
  assert.equal(fs.existsSync(path.join(f.operational, "worker-jobs")), false);
});

test("fixture ownership cannot be upgraded to actual provider evidence", { skip: !nativeRoot }, async (t) => {
  const f = await fixture(t);
  const c = f.options.hostConnection;
  const noOperation = async () => {
    throw new Error("must not execute");
  };
  const ownedTransport = createCodexNativeForkOwnedTransport({ evidenceMode: "protocol-fixture", withVerifiedOwnership: noOperation });
  assert.throws(
    () =>
      createCodexNativeForkHost({
        evidenceMode: "actual-provider",
        source: c.source,
        rebind: c.rebind,
        authorizationHash: c.authorizationHash,
        policyDigest: c.policyDigest,
        inputDigest: c.inputDigest,
        ownedTransport,
        request: noOperation,
        nextNotification: noOperation,
        withVerifiedFork: noOperation,
        cleanup: noOperation,
        recordOperationalEvidence: noOperation,
      }),
    { code: "INVALID_CODEX_NATIVE_FORK_HOST" },
  );
  assert.equal(f.lease().status, "available");
});

test("inert reconnect and repeated close create no journal, lease or process", { skip: !nativeRoot }, async (t) => {
  const f = await fixture(t);
  const connection = await connectCodexWorkerHost(f.options);
  assert.equal(connection.inspect().started, false);
  const first = connection.close();
  assert.equal(connection.close(), first);
  await first;
  assert.equal(connection.inspect().started, false);
  assert.equal(f.lease().status, "available");
  assert.equal(fs.existsSync(path.join(f.operational, "worker-jobs")), false);
});

for (const field of ["authorizationHash", "source", "policyDigest"])
  test(`reconnect ${field} tamper fails before consumption`, { skip: !nativeRoot }, async (t) => {
    const f = await fixture(t);
    const options = structuredClone({ ...f.options, onProcess: undefined });
    options.hostConnection[field] = field === "source" ? { ...options.hostConnection.source, threadId: "other" } : "0".repeat(64);
    await assert.rejects(connectCodexWorkerHost(options), { code: "CODEX_WORKER_HOST_CONNECTION_MISMATCH" });
    assert.equal(f.lease().status, "available");
  });

for (const scenario of ["native-composition-stale", "native-composition-policy-drift", "native-composition-lost-fork"])
  test(`product composition ${scenario} cannot start a worker turn or replay`, { skip: !nativeRoot }, async (t) => {
    const f = await fixture(t, { scenario });
    const before = fs.readFileSync(f.sessionFile);
    const result = await runWorker(f.options);
    assert.equal(result.receipt.status, "failed");
    assert.equal(result.draft.providerResult, null);
    assert.equal(
      f.journal().some((e) => e.method === "turn/start"),
      false,
    );
    const frozen = JSON.stringify(f.journal());
    await assert.rejects(runWorker(f.options));
    assert.equal(JSON.stringify(f.journal()), frozen);
    assert.deepEqual(fs.readFileSync(f.sessionFile), before);
  });
