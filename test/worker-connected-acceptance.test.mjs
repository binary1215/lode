import { relativeProjectArtifact } from "../scripts/lib/project-storage-format.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { createWholePlanSnapshot, createExecutionContract } from "../scripts/lib/execution-lineage.mjs";
import { startRun } from "../scripts/lib/run-lineage.mjs";
import { buildRuntimeVersionEvidence } from "../scripts/lib/runtime-machine-execution.mjs";
import { buildRuntimeProtocolEvidence, buildRuntimeProjectBinding } from "../scripts/lib/runtime-protocol-evidence.mjs";
import { buildRuntimeInvocationAuthorization, prepareRuntimeInvocationExecution } from "../scripts/lib/runtime-invocation-lifecycle.mjs";
import { RUNTIME_OPERATIONAL_STATE_ENV, inspectRuntimeExecutionLease } from "../scripts/lib/runtime-execution-lease.mjs";
import { createBoundedWorkerDispatch } from "../scripts/lib/bounded-worker-dispatch.mjs";
import { createBoundedWorkerJobHost, startBoundedWorkerJob, readBoundedWorkerJob,
  reconcileBoundedWorkerJob, cancelBoundedWorkerJob } from "../scripts/lib/bounded-worker-job.mjs";
import { readRuntimeInvocationRecord } from "../scripts/lib/runtime-invocation-record.mjs";
import { resolveVerifiedProcessSupervisor } from "../scripts/lib/runtime-process-supervisor.mjs";
import { captureWorkerSourceBasis } from "../scripts/lib/worker-source-basis.mjs";
import { prepareWorkerWorkspace, verifyWorkerWorkspace, workerExecutionBoundary } from "../scripts/lib/worker-workspace.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const emit = value => console.log(JSON.stringify({ ...value, at: new Date().toISOString() }));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
emit({ event: "owned-connected-acceptance-test", pid: process.pid, parentPid: process.ppid,
  command: process.execPath, args: process.argv.slice(1), cwd: process.cwd(), ports: [], actualProviderInvoked: false });

// Capability schemas only. The execution tests below launch actual Node
// protocol processes through native supervision, never this dummy executable.
function capabilitySpawn(_command, args) {
  const output = args.join(" ") === "--version" ? "codex 1.2.3\n"
    : args.join(" ") === "--help" ? "exec\nmcp-server\napp-server\n"
      : args.join(" ") === "exec --help" ? "Run Codex non-interactively\n--json\n--output-schema\n--color\n--sandbox\n--skip-git-repo-check\n--cd\n--ephemeral\nresume\n"
        : "stdio://\ngenerate-json-schema\n--listen\n";
  const child = new EventEmitter();
  Object.assign(child, { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null });
  child.kill = () => { throw new Error("Schema fixture must not control processes"); };
  queueMicrotask(() => { child.stdout.emit("data", Buffer.from(output)); child.exitCode = 0; child.emit("close", 0, null); });
  return child;
}

async function fixture(t) {
  const parent = fs.realpathSync(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const container = fs.mkdtempSync(path.join(parent, "head-connected-acceptance-"));
  const [root, operational, bin, barrierDirectory] = ["project", "operational", "capability", "barrier"].map(name => {
    const directory = path.join(container, name); fs.mkdirSync(directory); return fs.realpathSync(directory);
  });
  const previousOperational = process.env[RUNTIME_OPERATIONAL_STATE_ENV];
  process.env[RUNTIME_OPERATIONAL_STATE_ENV] = operational;
  const cleanups = [];
  t.after(async () => {
    try { for (const cleanup of cleanups) await cleanup(); }
    finally {
      if (previousOperational === undefined) delete process.env[RUNTIME_OPERATIONAL_STATE_ENV];
      else process.env[RUNTIME_OPERATIONAL_STATE_ENV] = previousOperational;
    }
    assert.equal(path.dirname(container), parent);
    assert.match(path.basename(container), /^head-connected-acceptance-/);
    fs.rmSync(container, { recursive: true, force: true });
  });
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  const capsule = (await compileContext({ root, task: "Verify synthetic connected worker execution evidence", persist: true })).capsule;
  const plan = createWholePlanSnapshot({ root, objective: "Verify bounded worker process and Git evidence",
    plan: [{ id: "verify", outcome: "Verified local fixtures, no model invocation" }] }).artifact;
  const contract = createExecutionContract({ root, wholePlanId: plan.wholePlanId, capsuleId: capsule.capsuleId,
    scope: "Synthetic acceptance repository only", acceptanceCriteria: ["Exact worker and source evidence"],
    allowedActions: ["runtime.invoke", "project.read"] }).artifact;
  const run = startRun({ root, executionContractId: contract.executionContractId }).run;
  const executable = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(executable, "Schema fixture, never executed", { flag: "wx", mode: 0o755 });
  const environment = { ...process.env, PATH: bin }; delete environment.Path; delete environment.path;
  const versionEvidence = await buildRuntimeVersionEvidence({ runtimes: ["codex"], environment, spawnImplementation: capabilitySpawn });
  const protocolEvidence = await buildRuntimeProtocolEvidence({ runtimes: ["codex"], environment, versionEvidence, spawnImplementation: capabilitySpawn });
  const inspected = inspectProject(root);
  const projectBinding = buildRuntimeProjectBinding({ storage, projectId: inspected.project.projectId, headSessionId: inspected.state.sessionId,
    projectRoot: root, projectStatus: "ready", versionEvidence, protocolEvidence });
  const authorize = worker => buildRuntimeInvocationAuthorization({ root, runtime: "codex", protocolEvidence, projectBinding,
    runtimeSelection: { model: "fixture/same-model" }, limits: { timeoutMs: 20000 }, worker, persist: true }).authorization;
  const protectedFiles = [["project.json"], ["sessions", "current.json"], ["sessions", "runs", run.runId, "run.json"]].map(parts => relativeProjectArtifact(storage, ...parts));
  const protectedSnapshot = () => protectedFiles.map(file => fs.readFileSync(path.join(root, file)).toString("base64"));
  return { root, storage, container, operational, barrierDirectory, protocolEvidence, projectBinding, authorize, cleanups, protectedSnapshot };
}

async function git(root, args, expectedCode = 0) {
  const command = "git";
  const argv = ["-C", root, "-c", "core.autocrlf=false", "-c", "core.hooksPath=disabled-fixture-hooks", ...args];
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (/^GIT_/i.test(name)) delete environment[name];
  Object.assign(environment, { GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(path.dirname(root), "absent-fixture-global-config") });
  emit({ event: "owned-git-planned", command, args: argv, parentPid: process.pid, cwd: root, ports: [] });
  const child = spawn(command, argv, { cwd: root, windowsHide: true, shell: false,
    env: environment, stdio: ["ignore", "pipe", "pipe"] });
  emit({ event: "owned-git-started", pid: child.pid, parentPid: process.pid, command, args: argv, cwd: root, ports: [] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  emit({ event: "owned-git-closed", pid: child.pid, code, ports: [] });
  assert.equal(code, expectedCode, stderr);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  return stdout;
}

test("C02 same-model workers actually overlap with distinct authorization/owners and replay never respawns", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  const selection = resolveVerifiedProcessSupervisor({ pluginRoot: process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || process.env.HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || pluginRoot });
  const policy = { kind: "protocol-fixture", actualProviderInvoked: false, barrierDirectory: f.barrierDirectory,
    protocolEvidence: f.protocolEvidence, projectBinding: f.projectBinding, supervisorSelection: selection };
  const host = createBoundedWorkerJobHost({ runnerFile: path.join(import.meta.dirname, "helpers/connected-worker-runner.mjs"), policy });
  fs.writeFileSync(path.join(f.root, "selected.txt"), "Shared selected bytes; no real provider data");
  const workers = ["parallel-a", "parallel-b"].map(taskKey => {
    const worker = { taskKey, role: "coder", outcome: `Return independent ${taskKey} evidence`,
      selectedContext: "Synthetic concurrent protocol execution only", sourcePaths: ["selected.txt"] };
    const authorization = f.authorize(worker);
    assert.equal(f.authorize(worker).authorizationId, authorization.authorizationId);
    prepareRuntimeInvocationExecution({ root: f.root, authorization });
    createBoundedWorkerDispatch({ root: f.root, authorizationId: authorization.authorizationId, role: "coder" });
    return { authorization, input: { root: f.root, authorizationId: authorization.authorizationId, role: "coder" } };
  });
  const processEvents = [];
  const onProcess = event => { processEvents.push(event); emit({ event: "owned-connected-worker", ...event }); };
  const jobDirectory = worker => path.join(f.operational, "worker-jobs", worker.authorization.projectId, worker.authorization.authorizationId);
  const status = worker => readBoundedWorkerJob(worker.input, { onProcess });
  const untilExited = async worker => {
    const deadline = Date.now() + 25000;
    let state;
    do { state = status(worker); if (state.ownerExitObserved || state.status === "not-started") return state; await wait(100); } while (Date.now() < deadline);
    assert.fail(`Owned job did not exit: ${JSON.stringify(state)}`);
  };
  f.cleanups.push(async () => {
    for (const worker of workers) {
      const state = status(worker);
      if (!state.ownerExitObserved && state.status !== "not-started") cancelBoundedWorkerJob(worker.input, { onProcess });
    }
    for (const worker of workers) {
      const state = await untilExited(worker);
      emit({ event: "connected-cleanup-evidence", state, actualProviderInvoked: false });
      const stderr = path.join(jobDirectory(worker), "stderr.bin");
      if (state.status !== "completed" && fs.existsSync(stderr)) emit({ event: "connected-failed-owner-diagnostic",
        authorizationId: worker.authorization.authorizationId, stderr: fs.readFileSync(stderr, "utf8").slice(-16000) });
    }
  });
  const protectedBefore = f.protectedSnapshot();
  const starts = await Promise.all(workers.map(worker => startBoundedWorkerJob(worker.input, { host, supervisorSelection: selection, onProcess })));
  assert.notEqual(workers[0].authorization.authorizationId, workers[1].authorization.authorizationId);
  assert.deepEqual(workers[0].authorization.runtimeSelection, workers[1].authorization.runtimeSelection);
  const deadline = Date.now() + 15000;
  while (!workers.every(worker => fs.existsSync(path.join(f.barrierDirectory, `${worker.authorization.workerInput.taskKey}.started.json`))) && Date.now() < deadline) await wait(50);
  const started = workers.map(worker => read(path.join(f.barrierDirectory, `${worker.authorization.workerInput.taskKey}.started.json`)));
  assert.notEqual(started[0].pid, started[1].pid);
  for (const [index, item] of started.entries()) {
    assert.equal(item.authorizationId, workers[index].authorization.authorizationId);
    assert.equal(item.model, "fixture/same-model");
    assert.equal(item.actualProviderInvoked, false);
    assert.equal(process.kill(item.pid, 0), true);
    assert.equal(starts[index].authorizationId, item.authorizationId);
  }
  const launchBytes = workers.map(worker => fs.readFileSync(path.join(jobDirectory(worker), "launch.json")));
  const launchCount = processEvents.filter(event => event.type === "spawn").length;
  await Promise.all(workers.map(worker => startBoundedWorkerJob(worker.input, { host, supervisorSelection: selection, onProcess })));
  assert.equal(processEvents.filter(event => event.type === "spawn").length, launchCount);
  fs.writeFileSync(path.join(f.barrierDirectory, "release"), "Both actual processes observed alive", { flag: "wx" });
  const final = await Promise.all(workers.map(untilExited));
  const intervals = workers.map(worker => read(path.join(f.barrierDirectory, `${worker.authorization.workerInput.taskKey}.finished.json`)));
  assert.ok(Math.max(...intervals.map(item => item.startedUnixMs)) < Math.min(...intervals.map(item => item.finishedUnixMs)), JSON.stringify(intervals));
  const owners = workers.map(worker => read(path.join(jobDirectory(worker), "launch.json")));
  assert.notEqual(owners[0].ownerPid, owners[1].ownerPid);
  assert.notEqual(owners[0].ownerToken, owners[1].ownerToken);
  for (const [index, worker] of workers.entries()) {
    assert.equal(final[index].status, "completed", JSON.stringify(final[index]));
    assert.equal(final[index].result.actualProviderInvoked, false);
    assert.equal(reconcileBoundedWorkerJob(worker.input, { onProcess }).status, "completed");
    assert.equal((await startBoundedWorkerJob(worker.input, { host, supervisorSelection: selection, onProcess })).status, "completed");
    assert.deepEqual(fs.readFileSync(path.join(jobDirectory(worker), "launch.json")), launchBytes[index]);
    const record = readRuntimeInvocationRecord({ ...worker.input, storage: f.storage });
    assert.equal(record.authorization.authorizationId, worker.authorization.authorizationId);
    assert.equal(record.receipt.providerBoundary.actualProviderInvoked, false);
    assert.equal(record.receipt.processBoundary.descendantTreeOwnershipValidated, true);
    assert.equal(inspectRuntimeExecutionLease({ projectRoot: f.root, storage: f.storage, projectId: worker.authorization.projectId,
      authorizationId: worker.authorization.authorizationId }).status, "consumed-released");
    const control = fs.readFileSync(path.join(jobDirectory(worker), "control.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    const nested = fs.readFileSync(path.join(jobDirectory(worker), "stderr.bin"), "utf8").trim().split("\n")
      .map(line => { try { return JSON.parse(line).workerProcess; } catch { return null; } }).filter(Boolean);
    emit({ event: "connected-worker-process-evidence", authorizationId: worker.authorization.authorizationId,
      launch: owners[index], interval: intervals[index], control, nested, actualProviderInvoked: false });
    for (const pid of new Set([owners[index].ownerPid, intervals[index].pid, ...control.map(event => event.providerPid),
      ...nested.filter(event => event.type === "spawn").map(event => event.pid)].filter(Number.isSafeInteger))) {
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
  }
  assert.equal(processEvents.filter(event => event.type === "spawn").length, launchCount);
  assert.deepEqual(f.protectedSnapshot(), protectedBefore);
});

test("C04 real Git dirty and untracked selections preserve exact bytes and reject only current-source conflicts", async t => {
  const f = await fixture(t);
  fs.mkdirSync(path.join(f.root, "src")); fs.mkdirSync(path.join(f.root, "notes"));
  const tracked = "src/tracked.txt", untracked = "notes/untracked.txt";
  const committed = "committed baseline\n", dirty = "dirty selected bytes Ω\r\n", local = "selected untracked bytes\n";
  fs.writeFileSync(path.join(f.root, tracked), committed);
  await git(f.root, ["init", "--quiet"]);
  await git(f.root, ["add", "--", tracked]);
  await git(f.root, ["-c", "user.name=HEAD Synthetic Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Synthetic baseline"]);
  fs.writeFileSync(path.join(f.root, tracked), dirty); fs.writeFileSync(path.join(f.root, untracked), local);
  assert.equal(await git(f.root, ["show", `HEAD:${tracked}`]), committed);
  assert.equal(await git(f.root, ["ls-files", "--error-unmatch", "--", tracked]), `${tracked}\n`);
  await git(f.root, ["ls-files", "--error-unmatch", "--", untracked], 1);
  const porcelainArgs = ["status", "--porcelain=v1", "--untracked-files=all", "--", tracked, untracked];
  const porcelain = await git(f.root, porcelainArgs);
  assert.match(porcelain, / M src\/tracked\.txt/); assert.match(porcelain, /\?\? notes\/untracked\.txt/);
  const indexBefore = fs.readFileSync(path.join(f.root, ".git/index"));
  const headBefore = await git(f.root, ["rev-parse", "HEAD"]);
  const sourceBasis = captureWorkerSourceBasis({ root: f.root, paths: [tracked, untracked], maxBytes: 4096 });
  const workspaceBinding = prepareWorkerWorkspace({ projectRoot: f.root, workspaceRoot: path.join(f.container, "selected-workspace"), sourceBasis, maxBytes: 4096 });
  const policy = { kind: "protocol-fixture", actualProviderInvoked: false };
  const executionBoundary = workerExecutionBoundary({ binding: workspaceBinding, sourceBasis, policy });
  const authorization = f.authorize({ taskKey: "real-git-selection", role: "coder", outcome: "Inspect selected Git working bytes",
    selectedContext: "Retain dirty and untracked input without modifying Git", sourcePaths: [tracked, untracked], executionBoundary });
  createBoundedWorkerDispatch({ root: f.root, authorizationId: authorization.authorizationId, role: "coder" });
  prepareRuntimeInvocationExecution({ root: f.root, authorization });
  for (const [file, expected] of [[tracked, dirty], [untracked, local]]) {
    assert.equal(fs.readFileSync(path.join(workspaceBinding.executionRoot, file), "utf8"), expected);
    assert.equal(fs.readFileSync(path.join(f.root, file), "utf8"), expected);
    assert.equal(Buffer.from(authorization.workerInput.sourceBasis.find(item => item.path === file).contentBase64, "base64").toString(), expected);
  }
  assert.equal(fs.existsSync(path.join(workspaceBinding.executionRoot, ".git")), false);
  assert.equal(fs.existsSync(path.join(workspaceBinding.executionRoot, ".head")), false);
  assert.equal(fs.existsSync(path.join(workspaceBinding.executionRoot, ".lode")), false);
  assert.equal(await git(f.root, porcelainArgs), porcelain);
  fs.writeFileSync(path.join(f.root, "unrelated.txt"), "Unselected change must not block preparation");
  prepareRuntimeInvocationExecution({ root: f.root, authorization });
  const protectedBefore = f.protectedSnapshot();
  for (const [file, expected] of [[tracked, dirty], [untracked, local]]) {
    fs.writeFileSync(path.join(f.root, file), "later user edit");
    assert.throws(() => prepareRuntimeInvocationExecution({ root: f.root, authorization }), { code: "WORKER_SOURCE_BASIS_DRIFT" });
    verifyWorkerWorkspace({ binding: workspaceBinding, sourceBasis });
    assert.equal(fs.readFileSync(path.join(workspaceBinding.executionRoot, file), "utf8"), expected);
    assert.equal(fs.readFileSync(path.join(f.root, file), "utf8"), "later user edit");
    fs.writeFileSync(path.join(f.root, file), expected);
  }
  assert.deepEqual(f.protectedSnapshot(), protectedBefore);
  assert.deepEqual(fs.readFileSync(path.join(f.root, ".git/index")), indexBefore);
  assert.equal(await git(f.root, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(await git(f.root, porcelainArgs), porcelain);
  emit({ event: "real-git-selection-evidence", repository: f.root, head: headBefore.trim(), porcelain,
    sourceBasis, authorizationId: authorization.authorizationId, actualProviderInvoked: false, sourceConflictChecked: [tracked, untracked] });
});
