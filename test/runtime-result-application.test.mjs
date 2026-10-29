import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { EventEmitter } from "node:events";
import { initializeProject, inspectProject } from "../scripts/lib/lode-core.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { createExecutionContract, createWholePlanSnapshot, readLineageArtifact } from "../scripts/lib/execution-lineage.mjs";
import { finishRun, getPendingReviewContext, reviewRun, startRun } from "../scripts/lib/run-lineage.mjs";
import { buildRuntimeVersionEvidence } from "../scripts/lib/runtime-machine-execution.mjs";
import { buildRuntimeProjectBinding, buildRuntimeProtocolEvidence } from "../scripts/lib/runtime-protocol-evidence.mjs";
import { buildRuntimeInvocationAuthorization, buildRuntimeInvocationLifecycleReceipt, buildRuntimeResultPacketDraft, normalizeRuntimeEvent, prepareRuntimeInvocationExecution, verifyRuntimeInvocationCurrentLineage, runRuntimeLifecycleConformance, reconcileWorkerMember } from "../scripts/lib/runtime-invocation-lifecycle.mjs";
import { RUNTIME_OPERATIONAL_STATE_ENV, withRuntimeExecutionLease, inspectRuntimeExecutionLease, createRuntimePreConsumeGateCapability } from "../scripts/lib/runtime-execution-lease.mjs";
import { persistRuntimeInvocationRecord, readRuntimeInvocationRecord } from "../scripts/lib/runtime-invocation-record.mjs";
import { applyRuntimeRunResult, readRuntimeInvocationResult } from "../scripts/lib/runtime-run-result-application.mjs";
import { withProjectMutationAsync } from "../scripts/lib/project-mutation-lock.mjs";
import { createBoundedWorkerDispatch } from "../scripts/lib/bounded-worker-dispatch.mjs";
import { createBoundedWorkerJobHost, startBoundedWorkerJob, readBoundedWorkerJob, cancelBoundedWorkerJob, reconcileBoundedWorkerJob } from "../scripts/lib/bounded-worker-job.mjs";
import { resolveVerifiedProcessSupervisor } from "../scripts/lib/runtime-process-supervisor.mjs";
import { captureWorkerSourceBasis } from "../scripts/lib/worker-source-basis.mjs";
import { prepareWorkerWorkspace, workerExecutionBoundary } from "../scripts/lib/worker-workspace.mjs";
import { captureWorkerWriteBasis } from "../scripts/lib/worker-patch-basis.mjs";
import { prepareWorkerPatchIntegration, readWorkerPatchIntegration, requireCurrentWorkerPatchIntegration } from "../scripts/lib/worker-patch-integration.mjs";
import { readWorkerIntegrationBasis } from "../scripts/lib/worker-integration-basis.mjs";
import { executeCodexRuntimeInvocation } from "../scripts/lib/runtime-codex-exec.mjs";
import { createBoundedWorkerWave, readBoundedWorkerWaveStatus, sealBoundedWorkerWave, waitForBoundedWorkerWave } from "../scripts/lib/bounded-worker-wave.mjs";
import { formatCliResult, formatMcpToolContent } from "../scripts/lib/cli-presentation.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { dispatch as dispatchMcp, catalogTools as mcpTools } from "../scripts/mcp-server.mjs";

// head_* request inputs below deliberately exercise compatibility dispatch;
// generated catalog and Hook assertions use the canonical Lode vocabulary.
const pluginRoot = path.resolve(import.meta.dirname, "..");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
console.log(JSON.stringify({ event: "owned-runtime-application-test", pid: process.pid, parentPid: process.ppid, command: process.execPath, args: process.argv.slice(1), cwd: process.cwd(), ports: [], liveProviderInvoked: false }));

function fixedCapabilitySpawn(_command, args) {
  const key = args.join(" ");
  const output = key === "--version" ? "codex 1.2.3\n"
    : key === "--help" ? "exec\nmcp-server\napp-server\n"
      : key === "exec --help" ? "Run Codex non-interactively\n--json\n--output-schema\n--color\n--sandbox\n--skip-git-repo-check\n--cd\n--ephemeral\nresume\n"
        : "stdio://\ngenerate-json-schema\n--listen\n";
  // Discovery is modeled data in this record/application fixture, not process
  // conformance. Keep actual child/stdio/termination coverage in runtime tests.
  const child = new EventEmitter();
  Object.assign(child, { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null });
  child.kill = () => { throw new Error("No actual process in discovery fixture"); };
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(output));
    child.exitCode = 0;
    child.emit("close", 0, null);
  });
  return child;
}

async function fixture(t, { withWave = false, withWrite = false } = {}) {
  const parent = process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const container = fs.mkdtempSync(path.join(parent, "head-runtime-application-"));
  // macOS temporary paths may be /var aliases of /private/var. Compare and
  // bind canonical roots exactly as production does, not caller path spelling.
  const [root, operational, bin] = ["project", "operational", "capability-fixture"].map((name) => {
    const directory = path.join(container, name);
    fs.mkdirSync(directory);
    return fs.realpathSync(directory);
  });
  const previousOperational = process.env[RUNTIME_OPERATIONAL_STATE_ENV];
  process.env[RUNTIME_OPERATIONAL_STATE_ENV] = operational;
  const beforeCleanup = [];
  t.after(async () => {
    for (const action of beforeCleanup) await action();
    if (previousOperational === undefined) delete process.env[RUNTIME_OPERATIONAL_STATE_ENV];
    else process.env[RUNTIME_OPERATIONAL_STATE_ENV] = previousOperational;
    assert.equal(path.dirname(container), path.resolve(parent));
    assert.match(path.basename(container), /^head-runtime-application-/);
    fs.rmSync(container, { recursive: true, force: true });
  });
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  assert.equal(storage.directory, ".lode");
  assert.equal(fs.existsSync(path.resolve(root, ".lode/project.json")), true);
  assert.equal(fs.existsSync(path.resolve(root, ".head/project.json")), false);
  const capsule = (await compileContext({ root, task: "Verify a synthetic completed record is applied to its own Run", persist: true })).capsule;
  const plan = createWholePlanSnapshot({ root, objective: "Verify exact application target", plan: [{ id: "apply", outcome: "Exact application evidence" }] }).artifact;
  const contract = createExecutionContract({ root, wholePlanId: plan.wholePlanId, capsuleId: capsule.capsuleId, scope: "Synthetic fixture A only", acceptanceCriteria: ["Preserve exact Run identity"], allowedActions: ["runtime.invoke", "project.read", ...(withWrite ? ["project.write"] : [])] }).artifact;
  const run = startRun({ root, executionContractId: contract.executionContractId }).run;
  const executable = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(executable, "Capability schema fixture, never executed as a provider\n");
  if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
  const environment = { ...process.env, PATH: bin };
  delete environment.Path;
  delete environment.path;
  const versionEvidence = await buildRuntimeVersionEvidence({ runtimes: ["codex"], environment, spawnImplementation: fixedCapabilitySpawn });
  const protocolEvidence = await buildRuntimeProtocolEvidence({ runtimes: ["codex"], environment, versionEvidence, spawnImplementation: fixedCapabilitySpawn });
  const inspected = inspectProject(root);
  const projectBinding = buildRuntimeProjectBinding({ storage, projectId: inspected.project.projectId, headSessionId: inspected.state.sessionId, projectRoot: root, projectStatus: "ready", versionEvidence, protocolEvidence });
  const authorization = buildRuntimeInvocationAuthorization({ root, runtime: "codex", protocolEvidence, projectBinding, scope: { kind: "run" }, persist: true }).authorization;
  assert.equal(authorization.projectRootDigest, hash(root));
  let wave = null;
  if (withWave) {
    const other = buildRuntimeInvocationAuthorization({ root, runtime: "codex", protocolEvidence, projectBinding,
      limits: { timeoutMs: authorization.limits.timeoutMs + 1 }, persist: true }).authorization;
    createBoundedWorkerDispatch({ root, authorizationId: authorization.authorizationId, role: "coder" });
    createBoundedWorkerDispatch({ root, authorizationId: other.authorizationId, role: "reviewer" });
    wave = createBoundedWorkerWave({ root, authorizationIds: [authorization.authorizationId, other.authorizationId] }).wave;
  }
  // Model a completed-provider RECORD with real builders, hashes, durable lease,
  // and record readers. The operational booleans below are synthetic fixture
  // data, not real provider/supervisor observations or live conformance evidence.
  const providerResult = { schemaVersion: 1, kind: "RuntimeStructuredResult", protocolVersion: "0.1.0", outcome: "SCHEMA FIXTURE ONLY: modeled completed A result", evidence: ["Synthetic record fixture, no provider invoked"], planDelta: "", impactRadius: [], verification: ["Validate stored schema and application target only"], unknowns: ["No live provider or supervisor execution was tested"] };
  const events = [normalizeRuntimeEvent({ authorization, sequence: 0, line: JSON.stringify({ type: "turn.completed", fixtureOnly: true }) })];
  const leased = await withRuntimeExecutionLease({ projectRoot: root, authorization, ownerFenceDigest: hash("synthetic fixture owner") }, async ({ consumption }) => ({ receipt: buildRuntimeInvocationLifecycleReceipt({
    authorization, events, consumption, status: "completed", exitCode: 0, signal: "", stdoutBytes: 0, stderrBytes: 0, stdoutDigest: hash(""), stderrDigest: hash(""), callerFenceDigest: hash("synthetic caller"), childFenceDigest: hash("synthetic child"), childStarted: true, childExitObserved: true, terminationRequested: false, projectFenceValidated: true, inputDigestObserved: authorization.executionInput.digest, noDescendantFixture: false, descendantTreeOwnershipValidated: true, providerMode: "actual-codex", providerSessionCreated: true, structuredResult: providerResult,
    supervision: { supervisionMode: "native-process-tree", supervisionStrategy: process.platform === "win32" ? "windows-job-object" : "posix-process-group", supervisorManifestDigest: hash("synthetic manifest"), ownershipEstablished: true, providerChildStarted: true, providerChildExitObserved: true, treeCleanupAttempted: true, treeCleanupVerified: true },
  }) }));
  const receipt = leased.result.receipt;
  const draft = buildRuntimeResultPacketDraft({ authorization, receipt, leaseRelease: leased.release, providerResult });
  persistRuntimeInvocationRecord({ projectRoot: root, authorization, events, receipt, draft });
  const record = readRuntimeInvocationRecord({ root, storage, authorizationId: authorization.authorizationId });
  assert.equal(record.status, "verified");
  assert.equal(record.draft.draftId, draft.draftId);
  return { storage, root, operational, run, plan, capsule, contract, authorization, record, wave, protocolEvidence, projectBinding, beforeCleanup };
}

test("wave guidance separates seal readiness, wait cancellation, member failure and cleanup", async t => {
  const f = await fixture(t, { withWave: true });
  const input = { root: f.root, waveId: f.wave.waveId };
  const pointer = path.join(f.root, f.storage.directory, "sessions/current.json"), before = fs.readFileSync(pointer);
  const status = () => readBoundedWorkerWaveStatus(input).projection;
  assert.equal(status().guidance.aggregateAvailable, false);
  assert.equal(status().guidance.canSeal, false);
  await assert.rejects(waitForBoundedWorkerWave(input), { code: "BOUNDED_WORKER_WAVE_NOT_SEALED" });
  const otherId = f.wave.members.find(m => m.authorizationId !== f.authorization.authorizationId).authorizationId;
  const other = JSON.parse(fs.readFileSync(path.join(f.root, f.storage.directory, "runtime/execution-authorizations", `${otherId}.json`)));
  let release, ready;
  const started = new Promise(resolve => { ready = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const pending = withRuntimeExecutionLease({ projectRoot: f.root, authorization: other, ownerFenceDigest: hash("wave fixture") },
    async () => { ready(); await hold; throw Error("Synthetic terminal failure"); }).catch(error => error);
  f.beforeCleanup.push(async () => { release(); await pending; });
  await started;
  assert.equal(status().state, "open"); assert.equal(status().guidance.canSeal, true);
  sealBoundedWorkerWave(input);
  const active = status();
  assert.equal(active.state, "sealed");
  assert.deepEqual(active.guidance.unsettledMemberAuthorizationIds, [otherId]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(waitForBoundedWorkerWave({ ...input, signal: controller.signal }), { code: "BOUNDED_WORKER_WAVE_WAIT_ABORTED" });
  assert.equal(status().counts.waiting, 1, "Aborting wait must not cancel a member");
  release(); await pending;
  const failed = await waitForBoundedWorkerWave(input);
  assert.equal(failed.projection.state, "failed");
  assert.equal(failed.projection.guidance.groupStateProvesProcessCleanup, false);
  assert.equal(failed.waitOutcome.guidance.waitAbortCancelsMembers, false);
  assert.equal(failed.projection.counts.succeeded, 1, "Useful sibling evidence survives failure");
  assert.deepEqual(fs.readFileSync(pointer), before);
  assert.equal(formatCliResult("worker-wave-wait", failed), formatMcpToolContent("head_bounded_worker_wave_wait", failed));
});

test("public detached job survives its CLI frontend and reconciles one lease without relaunch", { skip: process.platform !== "win32" }, async (t) => {
  const f = await fixture(t, { withWrite: true });
  const moduleUrl = (file) => pathToFileURL(path.join(pluginRoot, "scripts", "lib", file)).href;
  const runnerFile = path.join(path.dirname(f.root), "synthetic-job-runner.mjs");
  const providerFixture = `
    process.stdin.resume();
    process.stdin.on('end', () => {
      const write = value => process.stdout.write(JSON.stringify(value) + '\\n');
      const result = { schemaVersion: 1, kind: 'RuntimeStructuredResult', protocolVersion: '0.1.0',
        outcome: 'Synthetic provider result retained after publication failure', evidence: ['Synthetic protocol only'],
        planDelta: '', impactRadius: [], verification: ['Fixture only'], unknowns: [] };
      write({type:'thread.started',thread_id:'synthetic-owner-thread'});
      write({type:'turn.started'});
      write({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}});
      write({type:'turn.completed'});
    });
  `;
  fs.writeFileSync(runnerFile, `
    import fs from 'node:fs';
    import path from 'node:path';
    const storage = ${JSON.stringify(f.storage)};
    import { executeBoundedWorkerDispatch } from ${JSON.stringify(moduleUrl("bounded-worker-dispatch.mjs"))};
    import { runRuntimeLifecycleConformance, buildRuntimeResultPacketDraft } from ${JSON.stringify(moduleUrl("runtime-invocation-lifecycle.mjs"))};
    import { persistRuntimeInvocationRecord } from ${JSON.stringify(moduleUrl("runtime-invocation-record.mjs"))};
    export default async function ({ root, executionRoot, authorization, signal, policy, onProcess }) {
      if (authorization.workerInput.executionBoundary) {
        if (executionRoot === root || fs.existsSync(path.join(executionRoot, '.head')) || fs.existsSync(path.join(executionRoot, '.lode'))) throw new Error('Canonical root leaked into child selection');
        for (const source of authorization.workerInput.sourceBasis) if (fs.readFileSync(path.join(executionRoot, source.path)).toString('base64') !== source.contentBase64) throw new Error('Wrong child bytes');
      }
      if (policy.writeFixture) {
        fs.writeFileSync(path.join(executionRoot, 'writable-source.txt'), policy.writeText || 'synthetic child edit');
        fs.writeFileSync(path.join(executionRoot, 'worker-new.txt'), 'synthetic child creation');
        if (policy.unownedFixture) fs.writeFileSync(path.join(executionRoot, 'read-only.txt'), 'unowned child edit');
      }
      await new Promise(resolve => setTimeout(resolve, 600));
      if (policy.mode === 'publication-failure') {
        const rename = fs.renameSync;
        fs.renameSync = (from, to) => {
          if (String(to) === path.join(root, storage.directory, 'runtime', 'invocations', authorization.authorizationId)) throw Object.assign(new Error('Synthetic result publication EIO'), {code:'EIO'});
          return rename(from, to);
        };
        try {
          await executeBoundedWorkerDispatch({ root, authorizationId: authorization.authorizationId, role: authorization.workerInput.role,
            execution: { signal, protocolEvidence: policy.protocolEvidence, projectBinding: policy.projectBinding,
              supervisorSelection: policy.supervisorSelection, evidenceMode: 'protocol-fixture', onProcessEvent: onProcess,
              targetResolver: () => ({executablePath:process.execPath,observation:policy.protocolEvidence.observations.find(item=>item.runtime==='codex').executable}),
              providerArguments: ['-e', ${JSON.stringify(providerFixture)}] } });
        } finally { fs.renameSync = rename; }
        return;
      }
      const execution = await runRuntimeLifecycleConformance({ root, authorization, signal, mode: policy.mode, onProcessEvent: onProcess });
      const draft = buildRuntimeResultPacketDraft({ authorization, receipt: execution.receipt, leaseRelease: execution.executionLease.release });
      persistRuntimeInvocationRecord({ projectRoot: root, authorization, events: execution.events, receipt: execution.receipt, draft });
    }
  `);
  const authorization = buildRuntimeInvocationAuthorization({ root: f.root, runtime: "codex", protocolEvidence: f.protocolEvidence, projectBinding: f.projectBinding,
    worker: { taskKey: "detached-success", role: "coder", outcome: "Synthetic detached owner", selectedContext: "Fixture only; no model call" }, limits: { timeoutMs: 8000 }, persist: true }).authorization;
  const selection = resolveVerifiedProcessSupervisor({ pluginRoot: (process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || process.env.HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT) || pluginRoot });
  const frontendFile = path.join(path.dirname(f.root), "synthetic-frontend.mjs");
  fs.writeFileSync(frontendFile, `
    import { createBoundedWorkerJobHost } from ${JSON.stringify(moduleUrl("bounded-worker-job.mjs"))};
    import { runCommand } from ${JSON.stringify(pathToFileURL(path.join(pluginRoot, "scripts", "head.mjs")).href)};
    const host = createBoundedWorkerJobHost(${JSON.stringify({ runnerFile, policy: { kind: "protocol-fixture", actualProviderInvoked: false, mode: "success" } })});
    const result = await runCommand(${JSON.stringify(["managed-maintenance", "worker-start", f.root, "--authorization", authorization.authorizationId, "--role", "coder"])}, { workerJobHost: host, workerJobSupervisor: ${JSON.stringify(selection)} });
    console.log(JSON.stringify(result));
  `);
  const jobs = [authorization];
  f.beforeCleanup.push(async () => {
    for (const job of jobs) {
      if (!fs.existsSync(f.root)) continue;
      try { cancelBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId }); } catch {}
      const deadline = Date.now() + 11000;
      while (Date.now() < deadline) {
        const state = readBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId });
        if (state.ownerExitObserved || state.status === "not-started") break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  });
  console.log(JSON.stringify({ event: "planned-frontend", command: process.execPath, args: [frontendFile], cwd: f.root, parentPid: process.pid, ports: [] }));
  const frontend = spawn(process.execPath, [frontendFile], { cwd: f.root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  console.log(JSON.stringify({ event: "started-frontend", pid: frontend.pid, parentPid: process.pid, ports: [] }));
  let output = "", diagnostic = "";
  frontend.stdout.on("data", bytes => { output += bytes; }); frontend.stderr.on("data", bytes => { diagnostic += bytes; });
  const exit = await new Promise((resolve, reject) => { frontend.on("error", reject); frontend.on("close", resolve); });
  console.log(JSON.stringify({ event: "closed-frontend", pid: frontend.pid, exitCode: exit, ports: [] }));
  assert.equal(exit, 0, diagnostic);
  const frontendResult = JSON.parse(output.trim());
  console.log(JSON.stringify({ event: "synthetic-frontend-result", result: frontendResult }));
  assert.equal(frontendResult.authorizationId, authorization.authorizationId);
  assert.equal(frontendResult.replayAllowed, false);
  // The first read may race owner acknowledgment or a fast completion. Require
  // terminal proof below; do not force an asynchronous start to appear running.
  assert.ok(["running", "unknown", "settling", "completed"].includes(frontendResult.status));
  assert.throws(() => process.kill(frontend.pid, 0), { code: "ESRCH" });
  const host = createBoundedWorkerJobHost({ runnerFile, policy: { kind: "protocol-fixture", actualProviderInvoked: false, mode: "success" } });
  const replay = await startBoundedWorkerJob({ root: f.root, authorizationId: authorization.authorizationId, role: "coder" }, { host, supervisorSelection: selection });
  assert.equal(replay.replayAllowed, false);
  let state;
  const deadline = Date.now() + 11000;
  do { state = readBoundedWorkerJob({ root: f.root, authorizationId: authorization.authorizationId }); if (state.ownerExitObserved) break; await new Promise(resolve => setTimeout(resolve, 25)); } while (Date.now() < deadline);
  assert.equal(state.status, "completed", JSON.stringify(state));
  assert.equal(state.result.actualProviderInvoked, false);
  const kill = process.kill;
  process.kill = () => true; // A reused numeric PID must not hide actual owner exit.
  try { assert.deepEqual(readBoundedWorkerJob({ root: f.root, authorizationId: authorization.authorizationId }), state); }
  finally { process.kill = kill; }
  assert.deepEqual((await runCommand(["managed-maintenance", "worker-job-reconcile", f.root, "--authorization", authorization.authorizationId])), state);
  assert.deepEqual(cancelBoundedWorkerJob({ root: f.root, authorizationId: authorization.authorizationId }), state);
  const record = readRuntimeInvocationRecord({ root: f.root, storage: f.storage, authorizationId: authorization.authorizationId });
  assert.equal(record.receipt.receiptId, state.result.receiptId);
  assert.equal(inspectRuntimeExecutionLease({ projectRoot: f.root, storage: f.storage, projectId: authorization.projectId, authorizationId: authorization.authorizationId }).status, "consumed-released");
  const mcp = await dispatchMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "head_bounded_worker_job_status", arguments: { project_root: f.root, authorization_id: authorization.authorizationId },
  } });
  assert.deepEqual(mcp.result.structuredContent, state);
  const directoryFor = (job) => path.join(f.operational, "worker-jobs", job.projectId, job.authorizationId);
  const bindingFile = path.join(directoryFor(authorization), "binding.json");
  const bindingBytes = fs.readFileSync(bindingFile);
  const changed = JSON.parse(bindingBytes);
  changed.policy.actualProviderInvoked = true;
  fs.writeFileSync(bindingFile, JSON.stringify(changed));
  assert.throws(() => readBoundedWorkerJob({ root: f.root, authorizationId: authorization.authorizationId }), { code: "WORKER_JOB_CONFLICT" });
  fs.writeFileSync(bindingFile, bindingBytes);
  const makeJob = (taskKey, sourcePaths = []) => {
    const job = buildRuntimeInvocationAuthorization({ root: f.root, runtime: "codex", protocolEvidence: f.protocolEvidence, projectBinding: f.projectBinding,
      worker: { taskKey, role: "coder", outcome: "Synthetic owner counterexample", selectedContext: "No actual provider", sourcePaths }, limits: { timeoutMs: 8000 }, persist: true }).authorization;
    jobs.push(job);
    return job;
  };
  const waitExit = async (job) => {
    const end = Date.now() + 11000;
    let value;
    do { value = readBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId }); if (value.ownerExitObserved) return value; await new Promise(resolve => setTimeout(resolve, 25)); } while (Date.now() < end);
    assert.fail(`Synthetic owner did not exit: ${JSON.stringify(value)}`);
  };
  await t.test("selected child root and policy bind before authorization without reinterpreting older inputs", async () => {
    fs.writeFileSync(path.join(f.root, "child-source.txt"), "selected worker bytes");
    const sourceBasis = captureWorkerSourceBasis({ root: f.root, paths: ["child-source.txt"], maxBytes: 4096 });
    const workspaceBinding = prepareWorkerWorkspace({ projectRoot: f.root, workspaceRoot: path.join(path.dirname(f.root), "selected-child"), sourceBasis, maxBytes: 4096 });
    const policy = { kind: "protocol-fixture", actualProviderInvoked: false, mode: "success" };
    const executionBoundary = workerExecutionBoundary({ binding: workspaceBinding, sourceBasis, policy });
    const options = { root: f.root, runtime: "codex", protocolEvidence: f.protocolEvidence, projectBinding: f.projectBinding,
      worker: { taskKey: "selected-child", role: "coder", outcome: "Read a prebound synthetic child snapshot", selectedContext: "No actual provider", sourcePaths: ["child-source.txt"], executionBoundary }, limits: { timeoutMs: 8000 } };
    const job = buildRuntimeInvocationAuthorization(options).authorization;
    jobs.push(job);
    assert.equal(job.protocolVersion, "0.5.0");
    assert.equal(authorization.protocolVersion, "0.4.0");
    assert.deepEqual(prepareRuntimeInvocationExecution({ root: f.root, authorization: job }).executionInput.boundedWorker.executionBoundary, executionBoundary);
    assert.throws(() => buildRuntimeInvocationAuthorization({ ...options, persist: false, worker: { ...options.worker, executionBoundary: { ...executionBoundary, ownedPaths: ["child-source.txt"] } } }), { code: "WORKER_WORKSPACE_CONFLICT" });
    await assert.rejects(() => executeCodexRuntimeInvocation({ root: f.root, authorization: job }), { code: "WORKER_JOB_POLICY_UNAVAILABLE" });
    const wrongHost = createBoundedWorkerJobHost({ runnerFile, policy: { ...policy, mode: "wait" }, workspaceBinding });
    await assert.rejects(() => startBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId, role: "coder" }, { host: wrongHost, supervisorSelection: selection }), { code: "WORKER_JOB_CONFLICT" });
    assert.equal(fs.existsSync(directoryFor(job)), false);
    assert.equal(inspectRuntimeExecutionLease({ projectRoot: f.root, storage: f.storage, projectId: job.projectId, authorizationId: job.authorizationId }).status, "available");
    const selectedHost = createBoundedWorkerJobHost({ runnerFile, policy, workspaceBinding });
    await startBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId, role: "coder" }, { host: selectedHost, supervisorSelection: selection });
    assert.equal((await waitExit(job)).status, "completed");
    // Child bytes cease to be current execution input, not historical authority.
    fs.writeFileSync(path.join(workspaceBinding.executionRoot, "child-source.txt"), "later child edit");
    assert.equal(readBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId }).status, "completed");
  });
  await t.test("owner freezes write patches before terminal and refuses unowned child output", async () => {
    fs.writeFileSync(path.join(f.root, "writable-source.txt"), "original canonical source");
    fs.writeFileSync(path.join(f.root, "read-only.txt"), "unowned canonical source");
    const sourcePaths = ["read-only.txt", "writable-source.txt"];
    const sourceBasis = captureWorkerSourceBasis({ root: f.root, paths: sourcePaths, maxBytes: 4096 });
    const writeBasis = captureWorkerWriteBasis({ root: f.root, paths: ["writable-source.txt", "worker-new.txt"], maxBytes: 4096 });
    for (const unownedFixture of [false, true]) {
      const workspaceBinding = prepareWorkerWorkspace({ projectRoot: f.root, workspaceRoot: path.join(path.dirname(f.root), `write-owner-${unownedFixture}`), sourceBasis, maxBytes: 4096 });
      const policy = { kind: "protocol-fixture", actualProviderInvoked: false, mode: "success", writeFixture: true, unownedFixture };
      const executionBoundary = workerExecutionBoundary({ binding: workspaceBinding, sourceBasis, policy, ownedPaths: writeBasis.map(entry => entry.path), writeBasis });
      const job = buildRuntimeInvocationAuthorization({ root: f.root, runtime: "codex", workspaceMode: "workspace-write", protocolEvidence: f.protocolEvidence, projectBinding: f.projectBinding,
        worker: { taskKey: `write-owner-${unownedFixture}`, role: "coder", outcome: "Synthetic isolated write observation", selectedContext: "No actual provider", sourcePaths, executionBoundary }, limits: { timeoutMs: 8000 } }).authorization;
      jobs.push(job);
      const selectedHost = createBoundedWorkerJobHost({ runnerFile, policy, workspaceBinding });
      const sessionFile = path.join(f.root, f.storage.directory, "sessions", "current.json");
      const sessionBefore = fs.readFileSync(sessionFile);
      await startBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId, role: "coder" }, { host: selectedHost, supervisorSelection: selection });
      const state = await waitExit(job);
      assert.equal(fs.existsSync(path.join(f.root, "worker-new.txt")), false);
      assert.equal(fs.readFileSync(path.join(f.root, "writable-source.txt"), "utf8"), "original canonical source");
      assert.equal(fs.readFileSync(path.join(f.root, "read-only.txt"), "utf8"), "unowned canonical source");
      assert.deepEqual(fs.readFileSync(sessionFile), sessionBefore);
      if (unownedFixture) {
        assert.equal(state.status, "incomplete");
        assert.equal(state.workspacePatchStatus, "missing");
        assert.equal(state.ownerExitCode, 1);
      } else {
        assert.equal(state.status, "completed", JSON.stringify(state));
        assert.match(state.workspacePatch.candidateId, /^worker-patch-/);
        const patchFile = path.join(directoryFor(job), "workspace-patch.json");
        const frozen = fs.readFileSync(patchFile);
        const patch = JSON.parse(frozen);
        assert.equal(patch.candidate.patches.length, 2);
        fs.writeFileSync(path.join(workspaceBinding.executionRoot, "worker-new.txt"), "later user edit in child");
        assert.deepEqual(readBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId }), state);
        patch.candidate.patches[0].after.contentBase64 = Buffer.from("tampered").toString("base64");
        fs.writeFileSync(patchFile, JSON.stringify(patch));
        assert.throws(() => readBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId }), { code: "WORKER_JOB_CONFLICT" });
        fs.writeFileSync(patchFile, frozen);
        const cliPatch = await runCommand(["worker-job-patch", f.root, "--authorization", job.authorizationId]);
        const mcpPatch = await dispatchMcp({ jsonrpc: "2.0", id: 32, method: "tools/call", params: {
          name: "head_bounded_worker_job_patch", arguments: { project_root: f.root, authorization_id: job.authorizationId },
        } });
        assert.deepEqual(mcpPatch.result.structuredContent, cliPatch);
        assert.equal(cliPatch.applied, false);
        assert.equal(cliPatch.actualProviderInvoked, false);
        assert.equal(cliPatch.candidate.candidateId, state.workspacePatch.candidateId);
        const prepared = prepareWorkerPatchIntegration({ root: f.root, storage: f.storage, authorizationIds: [job.authorizationId], maxBytes: 4096 });
        assert.equal(prepared.status, "prepared");
        assert.equal(prepared.intent.members[0].actualProviderInvoked, false);
        assert.equal(prepared.intent.authorityBoundary.planeId, "P3");
        assert.equal(prepared.applied, false);
        const integrationId = prepared.intent.integrationId;
        // A larger caller allowance is not a new effect or evidence identity.
        assert.equal(prepareWorkerPatchIntegration({ root: f.root, storage: f.storage, authorizationIds: [job.authorizationId], maxBytes: 8192 }).intent.integrationId, integrationId);
        assert.throws(() => prepareWorkerPatchIntegration({ root: f.root, storage: f.storage, authorizationIds: [job.authorizationId, job.authorizationId], maxBytes: 4096 }), { code: "WORKER_PATCH_INTEGRATION_CONFLICT" });
        const integrationFile = path.join(f.root, f.storage.directory, "runtime/worker-integrations", `${integrationId}.json`);
        // An unrelated corrupt P3 document cannot turn into a global gate.
        fs.writeFileSync(path.join(path.dirname(integrationFile), `worker-integration-${"0".repeat(24)}--${"0".repeat(24)}.json`), "{");
        assert.equal(prepareWorkerPatchIntegration({ root: f.root, storage: f.storage, authorizationIds: [job.authorizationId], maxBytes: 8192 }).intent.integrationId, integrationId);
        const integrationBytes = fs.readFileSync(integrationFile);
        const basis = readWorkerIntegrationBasis({ root: f.root, storage: f.storage, integrationId });
        assert.equal(basis.lineageVerified, true);
        assert.equal(basis.headReassessmentRequired, false);
        assert.equal(basis.semanticVerification, "not-assessed");
        assert.equal(basis.appliedByThisOperation, false);
        const launchSibling = async (taskKey, writeText) => {
          const siblingBinding = prepareWorkerWorkspace({ projectRoot: f.root, workspaceRoot: path.join(path.dirname(f.root), taskKey), sourceBasis, maxBytes: 4096 });
          const siblingPolicy = { ...policy, writeText };
          const siblingBoundary = workerExecutionBoundary({ binding: siblingBinding, sourceBasis, policy: siblingPolicy, ownedPaths: writeBasis.map(entry => entry.path), writeBasis });
          const sibling = buildRuntimeInvocationAuthorization({ root: f.root, runtime: "codex", workspaceMode: "workspace-write", protocolEvidence: f.protocolEvidence, projectBinding: f.projectBinding,
            worker: { taskKey, role: "coder", outcome: "Synthetic second selected contribution", selectedContext: "No actual provider", sourcePaths, executionBoundary: siblingBoundary }, limits: { timeoutMs: 8000 } }).authorization;
          jobs.push(sibling);
          await startBoundedWorkerJob({ root: f.root, authorizationId: sibling.authorizationId, role: "coder" }, {
            host: createBoundedWorkerJobHost({ runnerFile, policy: siblingPolicy, workspaceBinding: siblingBinding }), supervisorSelection: selection,
          });
          assert.equal((await waitExit(sibling)).status, "completed");
          return sibling;
        };
        const sibling = await launchSibling("write-combined-identical", "synthetic child edit");
        const combined = prepareWorkerPatchIntegration({ root: f.root, storage: f.storage, authorizationIds: [sibling.authorizationId, job.authorizationId], maxBytes: 4096 });
        assert.equal(combined.intent.members.length, 2);
        assert.equal(combined.intent.composition.patches.length, 2, "identical effects retain two member references, not duplicate writes");
        assert.deepEqual(combined.intent.composition.patches.map(item => item.memberIndices), [[0, 1], [0, 1]]);
        assert.equal(prepareWorkerPatchIntegration({ root: f.root, storage: f.storage, authorizationIds: [job.authorizationId, sibling.authorizationId], maxBytes: 8192 }).intent.integrationId, combined.intent.integrationId);
        const divergent = await launchSibling("write-combined-conflict", "different synthetic child edit");
        const beforeConflict = fs.readdirSync(path.dirname(integrationFile));
        const conflict = prepareWorkerPatchIntegration({ root: f.root, storage: f.storage, authorizationIds: [job.authorizationId, divergent.authorizationId], maxBytes: 4096 });
        assert.equal(conflict.status, "conflict");
        assert.equal(conflict.persisted, false);
        assert.deepEqual(fs.readdirSync(path.dirname(integrationFile)), beforeConflict);
        fs.writeFileSync(integrationFile, JSON.stringify({ ...prepared.intent, recoveryAuthority: true }));
        assert.throws(() => readWorkerPatchIntegration({ root: f.root, storage: f.storage, integrationId }), { code: "WORKER_PATCH_INTEGRATION_CONFLICT" });
        fs.writeFileSync(integrationFile, integrationBytes);
        // Frozen P3 history outlives Host temporary patch storage and current
        // sources; neither absence nor a new Session grants effect authority.
        fs.renameSync(patchFile, `${patchFile}.retired`);
        fs.writeFileSync(path.join(f.root, "read-only.txt"), "new external input, not an approved integration");
        try {
          assert.deepEqual(readWorkerPatchIntegration({ root: f.root, storage: f.storage, integrationId }).intent, prepared.intent);
          assert.equal(prepareWorkerPatchIntegration({ root: f.root, storage: f.storage, authorizationIds: [job.authorizationId], maxBytes: 8192 }).intent.integrationId, integrationId);
          const driftBasis = readWorkerIntegrationBasis({ root: f.root, storage: f.storage, integrationId });
          assert.equal(driftBasis.dependencies.find(item => item.path === "read-only.txt").status, "external-dependency-drift");
          assert.equal(driftBasis.headReassessmentRequired, true);
          assert.notEqual(driftBasis.observedBasisDigest, basis.observedBasisDigest);
          assert.equal(driftBasis.appliedByThisOperation, false);
          assert.equal(requireCurrentWorkerPatchIntegration({ root: f.root, storage: f.storage, integrationId }).integrationId, integrationId);
          const session = JSON.parse(sessionBefore);
          fs.writeFileSync(sessionFile, JSON.stringify({ ...session, sessionId: `session-${crypto.randomUUID()}` }));
          assert.deepEqual(readWorkerPatchIntegration({ root: f.root, storage: f.storage, integrationId }).intent, prepared.intent);
          assert.throws(() => requireCurrentWorkerPatchIntegration({ root: f.root, storage: f.storage, integrationId }), { code: "RUNTIME_INVOCATION_FENCE_MISMATCH" });
        } finally {
          fs.writeFileSync(sessionFile, sessionBefore);
          fs.writeFileSync(path.join(f.root, "read-only.txt"), "unowned canonical source");
          fs.renameSync(`${patchFile}.retired`, patchFile);
        }
        const roleFile = path.join(f.root, f.storage.directory, "roles/coder.md");
        const roleBefore = fs.readFileSync(roleFile);
        fs.appendFileSync(roleFile, "\nLocal managed projection drift\n");
        try {
          assert.deepEqual(readWorkerPatchIntegration({ root: f.root, storage: f.storage, integrationId }).intent, prepared.intent);
          assert.throws(() => requireCurrentWorkerPatchIntegration({ root: f.root, storage: f.storage, integrationId }), { code: "RUNTIME_INVOCATION_FENCE_MISMATCH" });
        } finally { fs.writeFileSync(roleFile, roleBefore); }
        assert.deepEqual(fs.readFileSync(sessionFile), sessionBefore);
      }
    }
  });
  await t.test("cancel is exact, repeatable, and not a claim of completion", async () => {
    fs.writeFileSync(path.join(f.root, "cancel-basis.txt"), "original synthetic basis");
    const job = makeJob("detached-cancel", ["cancel-basis.txt"]);
    const waitingHost = createBoundedWorkerJobHost({ runnerFile, policy: { kind: "protocol-fixture", actualProviderInvoked: false, mode: "wait" } });
    await startBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId, role: "coder" }, { host: waitingHost, supervisorSelection: selection });
    const startedBy = Date.now() + 3000;
    while (!inspectRuntimeExecutionLease({ projectRoot: f.root, storage: f.storage, projectId: job.projectId, authorizationId: job.authorizationId }).singleUseConsumed && Date.now() < startedBy) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(inspectRuntimeExecutionLease({ projectRoot: f.root, storage: f.storage, projectId: job.projectId, authorizationId: job.authorizationId }).singleUseConsumed, true);
    fs.writeFileSync(path.join(f.root, "cancel-basis.txt"), "new user edit, never restore to cancel");
    assert.equal(readBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId }).current, false);
    const first = cancelBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId });
    assert.notEqual(first.status, "completed");
    cancelBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId });
    const cancelled = await waitExit(job);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.result, null);
    assert.deepEqual(cancelBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId }), cancelled);
    assert.equal(fs.readFileSync(path.join(f.root, "cancel-basis.txt"), "utf8"), "new user edit, never restore to cancel");
    assert.deepEqual(readBoundedWorkerJob({ root: f.root, authorizationId: authorization.authorizationId }), state);
  });
  await t.test("lost native launch acknowledgment never starts a second owner", async () => {
    const job = makeJob("detached-lost-ack");
    const link = fs.linkSync;
    fs.linkSync = (source, destination) => {
      const result = link(source, destination);
      if (String(destination) === path.join(directoryFor(job), "binding.json")) {
        fs.writeFileSync(path.join(directoryFor(job), "launch.json.pending"), "Synthetic failed acknowledgment publication", { flag: "wx" });
      }
      return result;
    };
    try { await startBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId, role: "coder" }, { host, supervisorSelection: selection }); }
    finally { fs.linkSync = link; }
    const replay = await startBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId, role: "coder" }, { host, supervisorSelection: selection });
    assert.equal(replay.replayAllowed, false);
    const completed = await waitExit(job);
    assert.equal(completed.status, "completed", JSON.stringify(completed));
    assert.equal(fs.existsSync(path.join(directoryFor(job), "launch.json")), false);
    const claim = fs.readFileSync(path.join(directoryFor(job), "claim.json"), "utf8");
    await startBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId, role: "coder" }, { host, supervisorSelection: selection });
    assert.equal(fs.readFileSync(path.join(directoryFor(job), "claim.json"), "utf8"), claim);
  });
  await t.test("launcher pipe errors settle and cannot cause an automatic retry", async () => {
    const job = makeJob("detached-pipe-error");
    let calls = 0;
    const spawnImplementation = () => {
      calls += 1;
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => { setImmediate(() => child.emit("close", 1)); return true; };
      setImmediate(() => child.stdout.emit("error", Object.assign(new Error("Synthetic unconnected launcher pipe"), { code: "ENOTCONN" })));
      return child;
    };
    await assert.rejects(startBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId, role: "coder" }, { host, supervisorSelection: selection, spawnImplementation }), { code: "ENOTCONN" });
    const replay = await startBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId, role: "coder" }, { host, supervisorSelection: selection, spawnImplementation });
    assert.equal(replay.status, "unknown");
    assert.equal(calls, 1);
    // This injected child never exists; do not spend the real-owner cleanup wait.
    jobs.splice(jobs.indexOf(job), 1);
  });
  await t.test("cache replacement preserves historical result through a verified compatible inspector", async () => {
    const job = makeJob("detached-cache-retired");
    const privateRoot = path.join(path.dirname(f.root), "old-native-cache", "long-native-executable-segment-".repeat(5));
    const binaryDirectory = path.join(privateRoot, "dist", "windows-x64");
    fs.mkdirSync(binaryDirectory, { recursive: true });
    const manifestFile = path.join(binaryDirectory, "SUPERVISOR-MANIFEST.json");
    fs.copyFileSync(selection.binaryPath, path.join(binaryDirectory, path.basename(selection.binaryPath)));
    fs.copyFileSync(selection.manifestPath, manifestFile);
    const privateSelection = resolveVerifiedProcessSupervisor({ pluginRoot: privateRoot });
    assert.ok(privateSelection.binaryPath.length > 260, "exercise a real long Windows executable path");
    await startBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId, role: "coder" }, { host, supervisorSelection: privateSelection });
    const completed = await waitExit(job);
    assert.equal(completed.status, "completed");
    fs.renameSync(manifestFile, `${manifestFile}.retired`);
    try {
      const restored = readBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId }, { inspectorSelection: selection });
      assert.deepEqual(restored, completed);
    } finally { fs.renameSync(`${manifestFile}.retired`, manifestFile); }
  });
  await t.test("provider result is restored after outer exit1 publication failure without replay or P2 mutation", async () => {
    fs.writeFileSync(path.join(f.root, "restore-basis.txt"), "original selected bytes");
    const job = makeJob("detached-publication-recovery", ["restore-basis.txt"]);
    const failingHost = createBoundedWorkerJobHost({ runnerFile, policy: { kind: "protocol-fixture", actualProviderInvoked: false,
      mode: "publication-failure", protocolEvidence: f.protocolEvidence, projectBinding: f.projectBinding, supervisorSelection: selection } });
    await startBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId, role: "coder" }, { host: failingHost, supervisorSelection: selection });
    const incomplete = await waitExit(job);
    assert.equal(incomplete.ownerExitCode, 1, JSON.stringify(incomplete));
    assert.equal(incomplete.status, "incomplete");
    assert.throws(() => readRuntimeInvocationRecord({ root: f.root, storage: f.storage, authorizationId: job.authorizationId }), { code: "RUNTIME_INVOCATION_RESULT_NOT_FOUND" });
    const releaseFile = path.join(f.root, f.storage.directory, 'runtime/execution-leases', job.authorizationId, 'release.json');
    fs.renameSync(releaseFile, `${releaseFile}.withheld`);
    try {
      assert.equal(reconcileBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId }).status, "incomplete");
      assert.equal(fs.existsSync(releaseFile), false, "recovery must not infer a missing release");
      assert.throws(() => readRuntimeInvocationRecord({ root: f.root, storage: f.storage, authorizationId: job.authorizationId }), { code: "RUNTIME_INVOCATION_RESULT_NOT_FOUND" });
    } finally { fs.renameSync(`${releaseFile}.withheld`, releaseFile); }
    const pointer = fs.readFileSync(path.join(f.root, f.storage.directory, "sessions/current.json"));
    fs.writeFileSync(path.join(f.root, "restore-basis.txt"), "new user bytes, historical result only");
    const restored = reconcileBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId });
    assert.equal(restored.status, "completed", JSON.stringify(restored));
    assert.equal(restored.ownerExitCode, 1);
    assert.equal(restored.current, false);
    assert.equal(restored.result.actualProviderInvoked, false);
    assert.deepEqual(reconcileBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId }), restored);
    assert.deepEqual(fs.readFileSync(path.join(f.root, f.storage.directory, "sessions/current.json")), pointer);
    assert.equal(fs.readFileSync(path.join(f.root, "restore-basis.txt"), "utf8"), "new user bytes, historical result only");
    // A conflicting existing P3 record is not overwritten by recovery.
    const receiptFile = path.join(f.root, f.storage.directory, 'runtime/invocations', job.authorizationId, 'receipt.json');
    const bytes = fs.readFileSync(receiptFile);
    fs.writeFileSync(receiptFile, JSON.stringify({ ...JSON.parse(bytes), status: "failed" }));
    assert.throws(() => reconcileBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId }));
    assert.notDeepEqual(fs.readFileSync(receiptFile), bytes);
    fs.writeFileSync(receiptFile, bytes);
    const stdoutFile = path.join(f.operational, 'runtime-output', job.projectId, job.authorizationId, 'stdout.bin');
    const raw = fs.readFileSync(stdoutFile);
    fs.appendFileSync(stdoutFile, 'synthetic tamper');
    try { assert.throws(() => reconcileBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId }), { code: "INVALID_RUNTIME_OUTPUT_SPOOL" }); }
    finally { fs.writeFileSync(stdoutFile, raw); }
  });
  await t.test("Run transition does not block exact protective cancellation or mutate P2", async () => {
    const job = makeJob("detached-stale-run-cancel");
    const waitingHost = createBoundedWorkerJobHost({ runnerFile, policy: { kind: "protocol-fixture", actualProviderInvoked: false, mode: "wait" } });
    await startBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId, role: "coder" }, { host: waitingHost, supervisorSelection: selection });
    const startedBy = Date.now() + 3000;
    while (!inspectRuntimeExecutionLease({ projectRoot: f.root, storage: f.storage, projectId: job.projectId, authorizationId: job.authorizationId }).singleUseConsumed && Date.now() < startedBy) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(inspectRuntimeExecutionLease({ projectRoot: f.root, storage: f.storage, projectId: job.projectId, authorizationId: job.authorizationId }).singleUseConsumed, true);
    finishRun({ root: f.root, outcome: "Explicit synthetic transition", evidence: [{ uri: "fixture", digest: "synthetic-transition" }], verification: [{ check: "fixture-only", status: "passed" }] });
    const pointer = fs.readFileSync(path.join(f.root, f.storage.directory, "sessions/current.json"));
    assert.equal(readBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId }).current, false);
    cancelBoundedWorkerJob({ root: f.root, authorizationId: job.authorizationId });
    assert.equal((await waitExit(job)).status, "cancelled");
    assert.deepEqual(fs.readFileSync(path.join(f.root, f.storage.directory, "sessions/current.json")), pointer);
  });
});

test("same-model workers bind distinct selected inputs and converge on one exact member authorization", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, "selected.txt"), "local untracked bytes Ω\n");
  const worker = { taskKey: "parser", role: "coder", outcome: "Inspect parser behavior", selectedContext: "Prior HEAD decision: preserve Unicode Ω.\nNo deployment.", sourcePaths: ["selected.txt"] };
  const options = { root: f.root, runtime: "codex", protocolEvidence: f.protocolEvidence, projectBinding: f.projectBinding, worker };
  const first = buildRuntimeInvocationAuthorization(options).authorization;
  const second = buildRuntimeInvocationAuthorization({ ...options, worker: { ...worker, taskKey: "printer", outcome: "Inspect printer behavior" } }).authorization;
  assert.notEqual(first.authorizationId, second.authorizationId);
  assert.equal(first.runtime, second.runtime);
  assert.deepEqual(first.runtimeSelection, second.runtimeSelection);
  assert.equal(buildRuntimeInvocationAuthorization(options).authorization.authorizationId, first.authorizationId);
  assert.throws(() => createBoundedWorkerDispatch({ root: f.root, authorizationId: first.authorizationId, role: "reviewer" }),
    { code: "BOUNDED_WORKER_DISPATCH_OWNERSHIP_CONFLICT" });
  createBoundedWorkerDispatch({ root: f.root, authorizationId: first.authorizationId, role: "coder" });
  for (const authorization of [first, second]) {
    const prepared = prepareRuntimeInvocationExecution({ root: f.root, authorization });
    assert.equal(prepared.executionInput.boundedWorker.selectedContext, worker.selectedContext);
    assert.equal(prepared.executionInput.boundedWorker.role, worker.role);
    assert.equal(hash(prepared.input), authorization.executionInput.digest);
    assert.equal(prepared.executionInput.boundedWorker.effectivePermissionEvidence, false);
    assert.equal(Buffer.from(prepared.executionInput.boundedWorker.sourceBasis[0].contentBase64, "base64").toString(), "local untracked bytes Ω\n");
  }
  fs.writeFileSync(path.join(f.root, "unrelated.txt"), "An unrelated edit is not a global gate");
  prepareRuntimeInvocationExecution({ root: f.root, authorization: first });
  fs.writeFileSync(path.join(f.root, "selected.txt"), "intervening edit");
  assert.throws(() => prepareRuntimeInvocationExecution({ root: f.root, authorization: first }), { code: "WORKER_SOURCE_BASIS_DRIFT" });
  fs.writeFileSync(path.join(f.root, "selected.txt"), "local untracked bytes Ω\n");
  const events = [];
  const result = await runRuntimeLifecycleConformance({ root: f.root, authorization: first, onProcessEvent: (event) => {
    events.push(event); console.log(JSON.stringify({ event: "owned-worker-input-fixture", ...event }));
  } });
  assert.equal(result.receipt.status, "completed");
  assert.equal(result.receipt.inputDigestObserved, first.executionInput.digest);
  assert.equal(events.filter((event) => event.type === "spawn").length, 1);
  for (const changed of [{ limits: { timeoutMs: 60001 } }, { runtimeSelection: { model: "fixture/another-model" } },
    { worker: { ...worker, selectedContext: "Different context" } }]) {
    assert.throws(() => buildRuntimeInvocationAuthorization({ ...options, ...changed }), { code: "WORKER_MEMBER_AUTHORIZATION_CONFLICT" });
  }
  await assert.rejects(() => runRuntimeLifecycleConformance({ root: f.root, authorization: first }),
    (error) => /CONSUMED/.test(error.code));
});

test("unconsumed member reprepare preserves task identity and fences superseded consumption", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, "source.txt"), "before");
  const options = { root: f.root, runtime: "codex", protocolEvidence: f.protocolEvidence, projectBinding: f.projectBinding,
    worker: { taskKey: "same-task", role: "coder", outcome: "Inspect selected source", selectedContext: "", sourcePaths: ["source.txt"] } };
  const previous = buildRuntimeInvocationAuthorization(options).authorization;
  fs.writeFileSync(path.join(f.root, "source.txt"), "user edit retained");
  const current = buildRuntimeInvocationAuthorization(options).authorization;
  assert.equal(current.workerInput.taskKey, previous.workerInput.taskKey);
  assert.equal(current.workerInput.previousAuthorizationId, previous.authorizationId);
  assert.equal(buildRuntimeInvocationAuthorization(options).authorization.authorizationId, current.authorizationId);
  assert.throws(() => prepareRuntimeInvocationExecution({ root: f.root, authorization: previous }), { code: "WORKER_MEMBER_AUTHORIZATION_CONFLICT" });
  await assert.rejects(() => withRuntimeExecutionLease({ projectRoot: f.root, authorization: previous, ownerFenceDigest: hash("stale owner") },
    async () => { assert.fail("superseded member must not enter its operation"); }), { code: "WORKER_MEMBER_AUTHORIZATION_CONFLICT" });
  assert.equal(prepareRuntimeInvocationExecution({ root: f.root, authorization: current }).executionInput.boundedWorker.sourceBasis[0].digest, hash("user edit retained"));
});

test("frozen member publication recovers without re-reading deleted source", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, "selected.txt"), "original");
  const options = { root: f.root, runtime: "codex", protocolEvidence: f.protocolEvidence, projectBinding: f.projectBinding,
    worker: { taskKey: "publish", role: "coder", outcome: "Inspect", selectedContext: "", sourcePaths: ["selected.txt"] } };
  const link = fs.linkSync;
  let fault = false;
  fs.linkSync = (source, target) => {
    if (!fault && path.basename(path.dirname(target)) === "execution-authorizations") {
      fault = true; throw Object.assign(new Error("publication fixture"), { code: "EIO" });
    }
    return link(source, target);
  };
  try { assert.throws(() => buildRuntimeInvocationAuthorization(options), { code: "EIO" }); }
  finally { fs.linkSync = link; }
  fs.unlinkSync(path.join(f.root, "selected.txt"));
  const recovered = await runCommand(["managed-maintenance", "worker-reconcile", f.root, "--task-key", "publish"]);
  assert.equal(recovered.status, "reconciled");
  assert.equal(recovered.authorization.workerInput.sourceBasis[0].digest, hash("original"));
  const mcp = await dispatchMcp({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "head_bounded_worker_reconcile", arguments: { project_root: f.root, task_key: "publish" } } }, { surface: "managed-maintenance" });
  assert.equal(mcp.result.structuredContent.status, "existing");
  assert.deepEqual(mcp.result.structuredContent.authorization, recovered.authorization);
  const maintenanceTools = (await dispatchMcp({ id: 2, method: "tools/list" }, { surface: "managed-maintenance" })).result.tools;
  assert.equal(maintenanceTools.find((tool) => tool.name === "lode_bounded_worker_reconcile").annotations.readOnlyHint, false);
  assert.equal(fs.existsSync(path.join(f.root, "selected.txt")), false);
  assert.throws(() => reconcileWorkerMember({ root: f.root, taskKey: "missing" }), { code: "WORKER_MEMBER_NOT_FOUND" });
});

test("verified pre-start failure permits one convergent follow-up attempt but unknown execution does not", async (t) => {
  const f = await fixture(t);
  const options = { root: f.root, runtime: "codex", protocolEvidence: f.protocolEvidence, projectBinding: f.projectBinding,
    worker: { taskKey: "retry", role: "coder", outcome: "Inspect", selectedContext: "" } };
  const previous = buildRuntimeInvocationAuthorization(options).authorization;
  await assert.rejects(() => runRuntimeLifecycleConformance({ root: f.root, authorization: previous,
    spawnImplementation: () => { throw Object.assign(new Error("pre-start fixture"), { code: "EAGAIN" }); } }), { code: "RUNTIME_CONFORMANCE_SPAWN_FAILED" });
  const current = buildRuntimeInvocationAuthorization({ ...options, retry: true }).authorization;
  assert.equal(current.workerInput.previousAuthorizationId, previous.authorizationId);
  assert.equal(buildRuntimeInvocationAuthorization({ ...options, retry: true }).authorization.authorizationId, current.authorizationId);
  await assert.rejects(() => withRuntimeExecutionLease({ projectRoot: f.root, authorization: current, ownerFenceDigest: hash("unknown fixture") },
    async () => { throw new Error("Outcome not known"); }));
  assert.throws(() => buildRuntimeInvocationAuthorization({ ...options, retry: true }), { code: "WORKER_MEMBER_AUTHORIZATION_CONFLICT" });
});

test("proven dead unconsumed owner does not trap same-member source reprepare", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, "selected.txt"), "before owner crash");
  const options = { root: f.root, runtime: "codex", protocolEvidence: f.protocolEvidence, projectBinding: f.projectBinding,
    worker: { taskKey: "dead-owner", role: "coder", outcome: "Inspect", selectedContext: "", sourcePaths: ["selected.txt"] } };
  const previous = buildRuntimeInvocationAuthorization(options).authorization;
  const moduleUrl = pathToFileURL(path.join(pluginRoot, "scripts/lib/runtime-execution-lease.mjs")).href;
  const script = `const {withRuntimeExecutionLease,createRuntimePreConsumeGateCapability}=await import(process.argv[1]);
    const gate=createRuntimePreConsumeGateCapability(async()=>{process.send({claimed:true});await new Promise(()=>setInterval(()=>{},1000));});
    await withRuntimeExecutionLease({projectRoot:process.argv[2],authorization:JSON.parse(process.argv[3]),ownerFenceDigest:'${hash("crash fixture owner")}'},async()=>{}, {preConsumeGate:gate});`;
  const args = ["--input-type=module", "-e", script, moduleUrl, f.root, JSON.stringify(previous)];
  console.log(JSON.stringify({ event: "owned-crash-fixture-plan", command: process.execPath, args, parentPid: process.pid, cwd: pluginRoot, ports: [] }));
  const child = spawn(process.execPath, args, { cwd: pluginRoot, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  console.log(JSON.stringify({ event: "owned-crash-fixture-start", pid: child.pid, parentPid: process.pid, cwd: pluginRoot, ports: [] }));
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2048); });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => {
    console.log(JSON.stringify({ event: "owned-crash-fixture-exit", pid: child.pid, parentPid: process.pid, code, signal, ports: [] }));
    resolve();
  }));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Owner fixture did not claim: ${stderr}`)), 5000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("message", (message) => { clearTimeout(timer); message.claimed ? resolve() : reject(new Error("Unexpected owner message")); });
      child.once("close", () => { clearTimeout(timer); reject(new Error(`Owner exited before claim: ${stderr}`)); });
    });
    fs.writeFileSync(path.join(f.root, "selected.txt"), "changed while claimed");
    assert.throws(() => buildRuntimeInvocationAuthorization(options), { code: "WORKER_MEMBER_AUTHORIZATION_CONFLICT" });
    child.kill("SIGTERM");
    await closed;
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    assert.equal(inspectRuntimeExecutionLease({ projectRoot: f.root, storage: f.storage, projectId: previous.projectId, authorizationId: previous.authorizationId }).singleUseConsumed, false);
    const current = buildRuntimeInvocationAuthorization(options).authorization;
    assert.equal(current.workerInput.previousAuthorizationId, previous.authorizationId);
    assert.equal(current.workerInput.sourceBasis[0].digest, hash("changed while claimed"));
    await assert.rejects(() => withRuntimeExecutionLease({ projectRoot: f.root, authorization: previous, ownerFenceDigest: hash("old owner") }, async () => {}), { code: "WORKER_MEMBER_AUTHORIZATION_CONFLICT" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
  }
});

test("claimed owner uncertainty is not treated as proven absence", async (t) => {
  const f = await fixture(t);
  const options = { root: f.root, runtime: "codex", protocolEvidence: f.protocolEvidence, projectBinding: f.projectBinding,
    worker: { taskKey: "unknown-owner", role: "coder", outcome: "Inspect", selectedContext: "" } };
  const authorization = buildRuntimeInvocationAuthorization(options).authorization;
  const gate = createRuntimePreConsumeGateCapability(async () => {
    const kill = process.kill;
    process.kill = () => { throw Object.assign(new Error("Synthetic unknown owner"), { code: "EPERM" }); };
    try {
      assert.throws(() => buildRuntimeInvocationAuthorization({ ...options, worker: { ...options.worker, selectedContext: "changed" } }), { code: "WORKER_MEMBER_AUTHORIZATION_CONFLICT" });
    } finally { process.kill = kill; }
    throw Object.assign(new Error("Fixture ends before consumption"), { code: "FIXTURE_STOP" });
  });
  await assert.rejects(() => withRuntimeExecutionLease({ projectRoot: f.root, authorization, ownerFenceDigest: hash("unknown fixture") }, async () => {}, { preConsumeGate: gate }), { code: "FIXTURE_STOP" });
});

test("write-bound worker freezes absent targets and source mode; safe reprepare cannot bypass unknown consumption", async (t) => {
  const f = await fixture(t, { withWrite: true });
  const file = path.join(f.root, "editable.txt");
  fs.writeFileSync(file, "original dirty bytes");
  if (process.platform !== "win32") fs.chmodSync(file, 0o755);
  const mode = fs.statSync(file).mode & 0o777;
  let sequence = 0;
  const prepare = () => {
    const sourcePaths = ["editable.txt", ...(fs.existsSync(path.join(f.root, "new.txt")) ? ["new.txt"] : [])];
    const sourceBasis = captureWorkerSourceBasis({ root: f.root, paths: sourcePaths, maxBytes: 4096 });
    const writeBasis = captureWorkerWriteBasis({ root: f.root, paths: ["editable.txt", "new.txt"], maxBytes: 4096 });
    const binding = prepareWorkerWorkspace({ projectRoot: f.root, workspaceRoot: path.join(path.dirname(f.root), `write-child-${sequence++}`), sourceBasis, maxBytes: 4096 });
    const policy = { kind: "protocol-fixture", actualProviderInvoked: false };
    return { root: f.root, runtime: "codex", protocolEvidence: f.protocolEvidence, projectBinding: f.projectBinding, workspaceMode: "workspace-write",
      worker: { taskKey: "write-basis", role: "coder", outcome: "Bounded synthetic edit", selectedContext: "No provider invoked", sourcePaths,
        executionBoundary: workerExecutionBoundary({ binding, policy, sourceBasis, ownedPaths: ["editable.txt", "new.txt"], writeBasis }) } };
  };
  const initialOptions = prepare();
  const initial = buildRuntimeInvocationAuthorization(initialOptions).authorization;
  assert.equal(initial.protocolVersion, "0.6.0");
  assert.deepEqual(initial.workerInput.writeBasis[1], { path: "new.txt", kind: "absent" });
  assert.equal(initial.workerInput.writeBasis[0].mode, mode);
  assert.equal(prepareRuntimeInvocationExecution({ root: f.root, authorization: initial }).executionInput.boundedWorker.writeBasis[0].mode, mode);
  fs.writeFileSync(path.join(f.root, "new.txt"), "user created target before consumption");
  assert.throws(() => prepareRuntimeInvocationExecution({ root: f.root, authorization: initial }), { code: "WORKER_PATCH_CONFLICT" });
  const beforeLineageRead = snapshot(f.root);
  const lineageOnly = verifyRuntimeInvocationCurrentLineage({ root: f.root, authorization: initial });
  assert.equal(lineageOnly.sourceBasisVerified, false);
  assert.equal(lineageOnly.executionPrepared, false);
  assert.deepEqual(snapshot(f.root), beforeLineageRead);
  assert.throws(() => prepareRuntimeInvocationExecution({ root: f.root, authorization: initial, verifyCurrentSources: false }), { code: "WORKER_PATCH_CONFLICT" });
  const sessionFile = path.join(f.root, f.storage.directory, "sessions/current.json");
  const sessionBytes = fs.readFileSync(sessionFile);
  fs.writeFileSync(sessionFile, JSON.stringify({ ...JSON.parse(sessionBytes), sessionId: `session-${crypto.randomUUID()}` }));
  assert.throws(() => verifyRuntimeInvocationCurrentLineage({ root: f.root, authorization: initial }), { code: "RUNTIME_INVOCATION_FENCE_MISMATCH" });
  fs.writeFileSync(sessionFile, sessionBytes);
  const nextOptions = prepare();
  const next = buildRuntimeInvocationAuthorization({ ...nextOptions, retry: true }).authorization;
  assert.equal(next.workerInput.previousAuthorizationId, initial.authorizationId);
  assert.throws(() => verifyRuntimeInvocationCurrentLineage({ root: f.root, authorization: initial }), { code: "WORKER_MEMBER_AUTHORIZATION_CONFLICT" });
  assert.equal(next.workerInput.writeBasis[1].kind, "file");
  assert.equal(buildRuntimeInvocationAuthorization({ ...nextOptions, retry: true }).authorization.authorizationId, next.authorizationId);
  fs.chmodSync(file, 0o444);
  assert.throws(() => prepareRuntimeInvocationExecution({ root: f.root, authorization: next }), { code: "WORKER_PATCH_CONFLICT" });
  fs.chmodSync(file, mode);
  await assert.rejects(() => withRuntimeExecutionLease({ projectRoot: f.root, authorization: next, ownerFenceDigest: hash("synthetic unknown write worker") },
    async () => { throw new Error("Synthetic unknown execution outcome"); }));
  assert.throws(() => buildRuntimeInvocationAuthorization({ ...prepare(), retry: true }), { code: "WORKER_MEMBER_AUTHORIZATION_CONFLICT" });
  assert.equal(fs.readFileSync(path.join(f.root, "new.txt"), "utf8"), "user created target before consumption");
  // Historical authorization remains immutable/readable after target drift.
  assert.equal(reconcileWorkerMember({ root: f.root, taskKey: "write-basis" }).authorization.authorizationId, next.authorizationId);
});

test("selected source input rejects protected paths, traversal and hardlinks before publication", async (t) => {
  const f = await fixture(t);
  const options = { root: f.root, runtime: "codex", protocolEvidence: f.protocolEvidence, projectBinding: f.projectBinding };
  fs.writeFileSync(path.join(f.root, "shared.txt"), "hardlink fixture");
  fs.linkSync(path.join(f.root, "shared.txt"), path.join(f.root, "alias.txt"));
  const before = snapshot(f.root);
  for (const sourcePath of [".head/project.json", ".lode/project.json", "../outside", "C:/outside", "a/../../outside", "alias.txt", "file:stream"]) {
    assert.throws(() => buildRuntimeInvocationAuthorization({ ...options, worker: { taskKey: "unsafe", role: "coder",
      outcome: "Inspect source", selectedContext: "", sourcePaths: [sourcePath] } }), { code: "INVALID_WORKER_SOURCE_BASIS" });
  }
  assert.deepEqual(snapshot(f.root), before);
});

test("selected Session request survives caller context loss and refuses changed replay", async (t) => {
  const f = await fixture(t);
  applyRuntimeRunResult({ root: f.root, storage: f.storage, authorizationId: f.authorization.authorizationId });
  accept(f.root);
  const authorization = buildRuntimeInvocationAuthorization({ root: f.root, runtime: "codex", protocolEvidence: f.protocolEvidence,
    projectBinding: f.projectBinding, scope: { kind: "session", request: "Review one bounded result" },
    worker: { taskKey: "review", role: "reviewer", outcome: "Return concerns", selectedContext: "Keep public behavior unchanged." } }).authorization;
  const input = prepareRuntimeInvocationExecution({ root: f.root, authorization });
  assert.equal(input.executionInput.sessionTask.request, "Review one bounded result");
  assert.equal(input.executionInput.wholePlan, undefined);
  assert.throws(() => prepareRuntimeInvocationExecution({ root: f.root, authorization, sessionRequest: "Different" }),
    { code: "RUNTIME_INVOCATION_INPUT_DRIFT" });
});

test("wave history remains readable after finish and later Run without granting a new seal", async (t) => {
  const f = await fixture(t, { withWave: true });
  const input = { root: f.root, waveId: f.wave.waveId };
  applyRuntimeRunResult({ root: f.root, storage: f.storage, authorizationId: f.authorization.authorizationId });
  const finished = snapshot(f.root);
  assert.equal(readBoundedWorkerWaveStatus(input).projection.counts.succeeded, 1);
  assert.throws(() => sealBoundedWorkerWave(input), { code: "BOUNDED_WORKER_WAVE_RUN_CONFLICT" });
  assert.deepEqual(snapshot(f.root), finished);
  accept(f.root);
  startB(f);
  const later = snapshot(f.root);
  assert.equal(readBoundedWorkerWaveStatus(input).projection.counts.succeeded, 1);
  assert.throws(() => sealBoundedWorkerWave(input), { code: "BOUNDED_WORKER_WAVE_LINEAGE_DRIFT" });
  assert.deepEqual(snapshot(f.root), later);
});

function snapshot(root) {
  const result = {};
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else result[path.relative(root, file)] = fs.readFileSync(file).toString("base64");
    }
  };
  walk(root);
  return result;
}

function accept(root) {
  return reviewRun({ root, reviewContextId: getPendingReviewContext({ root }).review.reviewContextId, disposition: "accept", rationale: "Only the bounded synthetic fixture result is accepted." });
}

function startB(f) {
  const contract = createExecutionContract({ root: f.root, wholePlanId: f.plan.wholePlanId, capsuleId: f.capsule.capsuleId, scope: "Different synthetic fixture B", acceptanceCriteria: ["Only B evidence may complete B"] }).artifact;
  return startRun({ root: f.root, executionContractId: contract.executionContractId }).run;
}

function missingApplicationOnce(operation) {
  const link = fs.linkSync;
  let injected = false;
  fs.linkSync = (source, target) => {
    if (!injected && path.basename(target) === "application.json") {
      injected = true;
      throw Object.assign(new Error("Isolated application receipt EIO"), { code: "EIO" });
    }
    return link(source, target);
  };
  try { assert.throws(operation, { code: "EIO" }); }
  finally { fs.linkSync = link; }
  assert.equal(injected, true);
}

test("runtime result receipt EIO then reviewed A and different Run B never mutates B", async (t) => {
  const f = await fixture(t);
  const input = { root: f.root, storage: f.storage, authorizationId: f.authorization.authorizationId };
  missingApplicationOnce(() => applyRuntimeRunResult(input));
  assert.equal(inspectProject(f.root).state.pendingReview.runId, f.run.runId);
  accept(f.root);
  const b = startB(f);
  const before = snapshot(f.root);
  let failure;
  try { applyRuntimeRunResult(input); } catch (error) { failure = error; }
  console.log(JSON.stringify({ event: "application-target-regression", errorCode: failure?.code, authorizedRunId: f.run.runId, expectedActiveRunId: b.runId, actualActiveRunId: inspectProject(f.root).state.activeRunId, projectBytesUnchanged: JSON.stringify(snapshot(f.root)) === JSON.stringify(before), evidenceScope: "stored schema fixture, no live provider" }));
  assert.equal(failure?.code, "RUNTIME_RUN_RESULT_APPLICATION_CONFLICT");
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(inspectProject(f.root).state.activeRunId, b.runId);
});

test("public managed CLI applies the exact Lode Run result and retries without execution replay", async (t) => {
  const f = await fixture(t);
  const command = ["managed", "runtime-invocation-apply-run-result", f.root, "--authorization", f.authorization.authorizationId];
  assert.equal(fs.existsSync(path.join(f.root, ".head")), false);
  const applied = await runCommand(command);
  assert.equal(applied.status, "runtime_run_result_applied");
  assert.equal(applied.authorizationId, f.authorization.authorizationId);
  assert.equal(applied.application.runId, f.run.runId);
  assert.equal(applied.application.executionContractId, f.contract.executionContractId);
  assert.equal(applied.application.lifecycleReceiptId, f.record.receipt.receiptId);
  assert.equal(applied.application.draftId, f.record.draft.draftId);
  assert.equal(applied.application.resultPacketId, applied.resultPacket.resultPacketId);
  assert.equal(applied.resultPacket.executionContractId, f.contract.executionContractId);
  assert.equal(applied.freshHeadReview.runId, f.run.runId);
  assert.equal(applied.executionReplayAllowed, false);
  const completedRun = JSON.parse(fs.readFileSync(path.join(f.root, f.storage.directory, "sessions", "runs", f.run.runId, "run.json"), "utf8"));
  assert.equal(completedRun.resultPacketId, applied.resultPacket.resultPacketId);
  assert.equal(inspectProject(f.root).state.pendingReview.resultPacketId, applied.resultPacket.resultPacketId);
  assert.equal(fs.existsSync(path.join(f.root, ".head")), false);
  const finished = snapshot(f.root);
  const retry = await runCommand(command);
  assert.equal(retry.status, "runtime_run_result_already_applied");
  assert.deepEqual(retry.application, applied.application);
  assert.deepEqual(retry.resultPacket, applied.resultPacket);
  assert.equal(retry.freshHeadReview, null);
  assert.equal(retry.executionReplayAllowed, false);
  assert.deepEqual(snapshot(f.root), finished);
  assert.equal(fs.existsSync(path.join(f.root, ".head")), false);
});

test("normal application and complete-receipt replay stay exact and read-only across a later Run", async (t) => {
  const f = await fixture(t);
  const input = { root: f.root, storage: f.storage, authorizationId: f.authorization.authorizationId };
  const canon = fs.readFileSync(path.join(f.root, f.storage.directory, "context/product-model.json"), "utf8");
  const owners = new Set();
  const stages = new Set();
  const observeLock = (stage) => {
    const entries = fs.readdirSync(path.join(f.root, f.storage.directory, ".operations/session-recovery.lock"));
    assert.equal(entries.length, 1);
    assert.match(entries[0], new RegExp(`^owner-[a-f0-9]+-${process.pid}-[a-f0-9]+\\.json$`));
    owners.add(entries[0]);
    stages.add(stage);
  };
  const read = fs.readFileSync;
  const rename = fs.renameSync;
  const link = fs.linkSync;
  fs.readFileSync = (file, ...args) => {
    if (file === path.join(f.record.directory, "receipt.json")) observeLock("record-read");
    if (file === path.join(f.root, f.storage.directory, "sessions/runs", f.run.runId, "run.json")) observeLock("run-read");
    return read(file, ...args);
  };
  fs.renameSync = (source, target) => {
    if (target === path.join(f.root, f.storage.directory, "sessions/current.json")) observeLock("session-write");
    return rename(source, target);
  };
  fs.linkSync = (source, target) => {
    if (path.basename(target) === "application.json") observeLock("application-write");
    return link(source, target);
  };
  let applied;
  try { applied = applyRuntimeRunResult(input); }
  finally { fs.readFileSync = read; fs.renameSync = rename; fs.linkSync = link; }
  assert.equal(owners.size, 1, "one lease must cover validation and both mutations");
  assert.deepEqual([...stages].sort(), ["application-write", "record-read", "run-read", "session-write"]);
  assert.equal(applied.status, "runtime_run_result_applied");
  assert.equal(applied.application.runId, f.run.runId);
  assert.equal(applied.resultPacket.executionContractId, f.contract.executionContractId);
  assert.equal(applied.freshHeadReview.runId, f.run.runId);
  assert.equal(inspectProject(f.root).state.latestCheckpoint, null);
  assert.equal(fs.existsSync(path.join(f.root, f.storage.directory, "lineage/review-decisions")), false);
  assert.equal(fs.readFileSync(path.join(f.root, f.storage.directory, "context/product-model.json"), "utf8"), canon);
  const finished = snapshot(f.root);
  assert.equal(readRuntimeInvocationResult(input).application.applicationId, applied.application.applicationId);
  assert.equal(applyRuntimeRunResult(input).status, "runtime_run_result_already_applied");
  assert.deepEqual(snapshot(f.root), finished);
  accept(f.root);
  const b = startB(f);
  const next = snapshot(f.root);
  const replay = applyRuntimeRunResult(input);
  assert.equal(replay.application.applicationId, applied.application.applicationId);
  assert.equal(replay.freshHeadReview, null);
  assert.deepEqual(snapshot(f.root), next);
  assert.equal(inspectProject(f.root).state.activeRunId, b.runId);
});

test("missing application receipt recovers only the exact pending result and is retryable after partial Run completion", async (t) => {
  const f = await fixture(t);
  const input = { root: f.root, storage: f.storage, authorizationId: f.authorization.authorizationId };
  const rename = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, target) => {
    if (!injected && target === path.join(f.root, f.storage.directory, "sessions/current.json")) {
      injected = true;
      throw Object.assign(new Error("Exact Session pointer fixture EIO"), { code: "EIO" });
    }
    return rename(source, target);
  };
  try { assert.throws(() => applyRuntimeRunResult(input), { code: "EIO" }); }
  finally { fs.renameSync = rename; }
  assert.equal(injected, true);
  assert.equal(inspectProject(f.root).state.activeRunId, f.run.runId);
  missingApplicationOnce(() => applyRuntimeRunResult(input));
  const pending = inspectProject(f.root).state.pendingReview;
  const resultBytes = fs.readFileSync(path.join(f.root, f.storage.directory, "lineage/result-packets", `${pending.resultPacketId}.json`), "utf8");
  const applied = applyRuntimeRunResult(input);
  assert.equal(applied.application.runId, f.run.runId);
  assert.equal(applied.resultPacket.resultPacketId, pending.resultPacketId);
  assert.equal(fs.readFileSync(path.join(f.root, f.storage.directory, "lineage/result-packets", `${pending.resultPacketId}.json`), "utf8"), resultBytes);
});

test("Run identity remains fenced when B reuses A's ExecutionContract", async (t) => {
  const f = await fixture(t);
  const input = { root: f.root, storage: f.storage, authorizationId: f.authorization.authorizationId };
  missingApplicationOnce(() => applyRuntimeRunResult(input));
  accept(f.root);
  const b = startRun({ root: f.root, executionContractId: f.contract.executionContractId }).run;
  const before = snapshot(f.root);
  assert.throws(() => applyRuntimeRunResult(input), { code: "RUNTIME_RUN_RESULT_APPLICATION_CONFLICT" });
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(inspectProject(f.root).state.activeRunId, b.runId);
});

test("delayed A result cannot complete B even when A was finished through another explicit result", async (t) => {
  const f = await fixture(t);
  finishRun({ root: f.root, outcome: "Separate explicit A fixture result", evidence: [{ uri: "fixture", digest: "different-evidence" }], verification: [{ check: "separate fixture", status: "passed" }] });
  accept(f.root);
  startB(f);
  const before = snapshot(f.root);
  assert.throws(() => applyRuntimeRunResult({ root: f.root, storage: f.storage, authorizationId: f.authorization.authorizationId }), { code: "RUNTIME_RUN_RESULT_APPLICATION_CONFLICT" });
  assert.deepEqual(snapshot(f.root), before);
});

test("Session drift and canonical digest tamper reject before application writes", async (t) => {
  const f = await fixture(t);
  const input = { root: f.root, storage: f.storage, authorizationId: f.authorization.authorizationId };
  const sessionFile = path.join(f.root, f.storage.directory, "sessions/current.json");
  const sessionBytes = fs.readFileSync(sessionFile, "utf8");
  fs.writeFileSync(sessionFile, JSON.stringify({ ...JSON.parse(sessionBytes), sessionId: `session-${crypto.randomUUID()}` }));
  const drifted = snapshot(f.root);
  assert.throws(() => applyRuntimeRunResult(input), { code: "RUNTIME_RUN_RESULT_APPLICATION_CONFLICT" });
  assert.deepEqual(snapshot(f.root), drifted);
  fs.writeFileSync(sessionFile, sessionBytes);
  const contractFile = readLineageArtifact({ root: f.root, artifactId: f.contract.executionContractId }).file;
  const contractBytes = fs.readFileSync(contractFile, "utf8");
  fs.writeFileSync(contractFile, JSON.stringify({ ...JSON.parse(contractBytes), scope: "Tampered contract" }));
  const tampered = snapshot(f.root);
  assert.throws(() => applyRuntimeRunResult(input), { code: "LINEAGE_DIGEST_MISMATCH" });
  assert.deepEqual(snapshot(f.root), tampered);
  fs.writeFileSync(contractFile, contractBytes);
  assert.equal(applyRuntimeRunResult(input).status, "runtime_run_result_applied");
});

test("application competes within the same Session mutation scope and rechecks drift after it releases", async (t) => {
  const f = await fixture(t);
  const input = { root: f.root, storage: f.storage, authorizationId: f.authorization.authorizationId };
  let acquired;
  let release;
  const ready = new Promise((resolve) => { acquired = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const competitor = withProjectMutationAsync({ root: f.root, scope: "session-recovery" }, async () => {
    acquired();
    await barrier;
    finishRun({ root: f.root, outcome: "Competing explicit A result", evidence: [{ uri: "fixture", digest: "competing-evidence" }], verification: [{ check: "fixture", status: "passed" }] });
    accept(f.root);
    startB(f);
  });
  await ready;
  try {
    const whileLocked = snapshot(f.root);
    assert.throws(() => applyRuntimeRunResult(input), { code: "PROJECT_MUTATION_BUSY" });
    assert.deepEqual(snapshot(f.root), whileLocked);
  } finally { release(); await competitor; }
  const afterDrift = snapshot(f.root);
  assert.throws(() => applyRuntimeRunResult(input), { code: "RUNTIME_RUN_RESULT_APPLICATION_CONFLICT" });
  assert.deepEqual(snapshot(f.root), afterDrift);
});
