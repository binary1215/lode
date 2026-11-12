import { relativeProjectArtifact } from "../scripts/lib/storage/project-storage-format.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { buildRuntimeVersionEvidence } from "../scripts/lib/runtime/runtime-machine-execution.mjs";
import { buildRuntimeProjectBinding, buildRuntimeProtocolEvidence } from "../scripts/lib/runtime/runtime-protocol-evidence.mjs";
import { buildRuntimeInvocationAuthorization } from "../scripts/lib/runtime/runtime-invocation-lifecycle.mjs";
import { captureWorkerSourceBasis } from "../scripts/lib/worker/worker-source-basis.mjs";
import { captureWorkerWriteBasis, buildWorkerPatchCandidate } from "../scripts/lib/worker/worker-patch-basis.mjs";
import { prepareWorkerWorkspace } from "../scripts/lib/worker/worker-workspace.mjs";
import { buildWorkerPatchProposalCandidate, workerPatchProposalExecutionBoundary } from "../scripts/lib/worker/worker-patch-proposal.mjs";
import { buildCodexFreshProposalPolicyPlan } from "../scripts/lib/runtime/runtime-codex-proposal-policy.mjs";
import { buildCodexNativePrefixPolicyPlan } from "../scripts/lib/runtime/runtime-codex-prefix-policy.mjs";
import { resolveVerifiedProcessSupervisor } from "../scripts/lib/runtime/runtime-process-supervisor.mjs";
import { RUNTIME_OPERATIONAL_STATE_ENV, inspectRuntimeExecutionLease } from "../scripts/lib/runtime/runtime-execution-lease.mjs";
import { readRuntimeInvocationRecord } from "../scripts/lib/runtime/runtime-invocation-record.mjs";
import {
  createBoundedWorkerJobHost,
  startBoundedWorkerJob,
  readBoundedWorkerJob,
  readBoundedWorkerPatch,
  cancelBoundedWorkerJob,
  reconcileBoundedWorkerJob,
} from "../scripts/lib/worker/bounded-worker-job.mjs";
import runCodexProposal from "../scripts/lib/runtime/runtime-codex-proposal-runner.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const onProcess = (event) => console.log(JSON.stringify(event));
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
console.log(
  JSON.stringify({
    event: "owned-worker-proposal-job-tests",
    pid: process.pid,
    parentPid: process.ppid,
    command: process.execPath,
    args: process.argv.slice(1),
    cwd: process.cwd(),
    ports: [],
    actualProviderInvoked: false,
  }),
);

// Schema strings, not provider probes or sandbox verification. PID 1 is fake.
function schemaSpawn(_command, args) {
  const key = args.join(" ");
  const output =
    key === "--version"
      ? "codex 1.2.3\n"
      : key === "--help"
        ? "exec\nmcp-server\napp-server\n"
        : key === "exec --help"
          ? "Run Codex non-interactively\n--json\n--output-schema\n--color\n--sandbox\n--skip-git-repo-check\n--cd\n--ephemeral\nresume\n"
          : "stdio://\ngenerate-json-schema\n--listen\n";
  const child = new EventEmitter();
  Object.assign(child, { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null });
  child.kill = () => {
    throw new Error("Schema fixture has no OS process");
  };
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(output));
    child.exitCode = 0;
    child.emit("close", 0, null);
  });
  return child;
}

async function fixture(t, nativePrefix = false) {
  const parent = fs.realpathSync(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const container = fs.mkdtempSync(path.join(parent, "head-worker-proposal-job-"));
  const root = path.join(container, "project"),
    bin = path.join(container, "schema-only");
  const operational = path.join(container, "operational"),
    codexHome = path.join(container, "codex-home");
  for (const directory of [root, bin, operational, codexHome]) fs.mkdirSync(directory);
  const prior = process.env[RUNTIME_OPERATIONAL_STATE_ENV];
  process.env[RUNTIME_OPERATIONAL_STATE_ENV] = operational;
  let started = false,
    input,
    directory;
  t.after(async () => {
    try {
      // Start publishes binding before any native launch. Without a binding a
      // rejected preparation created no owner; uncertain published launches
      // still require exact observed exit and retain their files otherwise.
      if (started && fs.existsSync(path.join(directory, "binding.json"))) {
        let state = readBoundedWorkerJob(input, { onProcess });
        if (!state.ownerExitObserved) cancelBoundedWorkerJob(input, { onProcess });
        const deadline = Date.now() + 15000;
        while (!state.ownerExitObserved && Date.now() < deadline) {
          await pause();
          state = readBoundedWorkerJob(input, { onProcess });
        }
        assert.equal(state.ownerExitObserved, true, "Confirm exact owned tree exit before removing fixture files");
        if (fs.existsSync(path.join(directory, "stderr.bin"))) console.log(fs.readFileSync(path.join(directory, "stderr.bin"), "utf8"));
        const claimFile = path.join(directory, "claim.json");
        const claim = fs.existsSync(claimFile) ? JSON.parse(fs.readFileSync(claimFile)) : null;
        console.log(
          JSON.stringify({
            event: "proposal-job-owner-exited",
            ...(claim ? { pid: claim.pid } : {}),
            parentPid: process.pid,
            cwd: root,
            ports: [],
            ownerExitObserved: true,
          }),
        );
      }
      assert.equal(path.dirname(container), parent);
      assert.match(path.basename(container), /^head-worker-proposal-job-/);
      fs.rmSync(container, { recursive: true, force: true });
    } finally {
      if (prior === undefined) delete process.env[RUNTIME_OPERATIONAL_STATE_ENV];
      else process.env[RUNTIME_OPERATIONAL_STATE_ENV] = prior;
    }
  });
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  fs.writeFileSync(path.join(root, "selected.txt"), "selected original bytes Ω\r\n");
  const marker = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(marker, "Schema-only marker; never executed\n");
  if (process.platform !== "win32") fs.chmodSync(marker, 0o755);
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
  const proposalBasis = captureWorkerWriteBasis({ root, paths: ["selected.txt"], maxBytes: 1024 * 1024 });
  const workspaceBinding = prepareWorkerWorkspace({ projectRoot: root, workspaceRoot: path.join(container, "selected"), sourceBasis, maxBytes: 1024 * 1024 });
  const recipe = buildCodexFreshProposalPolicyPlan({ executablePath: fs.realpathSync(process.execPath), codexHome, evidenceMode: "protocol-fixture" });
  const policy = nativePrefix ? buildCodexNativePrefixPolicyPlan({ freshPolicy: recipe, seedText: "Synthetic controlled source." }) : recipe;
  const boundary = workerPatchProposalExecutionBoundary({ binding: workspaceBinding, policy, sourceBasis, proposalBasis });
  const authorization = buildRuntimeInvocationAuthorization({
    root,
    runtime: "codex",
    runtimeSelection: { model: policy.model },
    workspaceMode: "read-only",
    scope: { kind: "session", request: "Propose a bounded synthetic edit without applying it" },
    protocolEvidence,
    projectBinding,
    limits: { timeoutMs: 30000 },
    worker: {
      taskKey: "proposal-worker",
      role: "coder",
      outcome: "A reviewable proposed edit",
      selectedContext: "Synthetic test: no real model, account, network or task effects",
      sourcePaths: ["selected.txt"],
      proposalPaths: ["selected.txt"],
      executionBoundary: boundary,
    },
  }).authorization;
  input = { root, authorizationId: authorization.authorizationId, role: "coder" };
  directory = path.join(operational, "worker-jobs", authorization.projectId, authorization.authorizationId);
  const lease = () =>
    inspectRuntimeExecutionLease({ projectRoot: root, projectId: authorization.projectId, authorizationId: authorization.authorizationId, storage });
  return {
    root,
    storage,
    container,
    codexHome,
    operational,
    policy,
    authorization,
    workspaceBinding,
    input,
    directory,
    lease,
    sessionFile: path.join(root, relativeProjectArtifact(storage, "sessions", "current.json")),
    async start() {
      const supervisorSelection = resolveVerifiedProcessSupervisor({
        pluginRoot: process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || process.env.HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || pluginRoot,
      });
      const host = createBoundedWorkerJobHost({ policy, workspaceBinding });
      started = true;
      let state = await startBoundedWorkerJob(input, { host, supervisorSelection, onProcess });
      const deadline = Date.now() + 45000;
      while (!state.ownerExitObserved && Date.now() < deadline) {
        await pause();
        state = readBoundedWorkerJob(input, { onProcess });
      }
      assert.equal(state.ownerExitObserved, true);
      return reconcileBoundedWorkerJob(input, { onProcess });
    },
  };
}

test(
  "native prefix public job composition reconnects its fixed owner and freezes a proposal without P2 integration",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await fixture(t, true),
      before = fs.readFileSync(f.sessionFile);
    const state = await f.start();
    assert.equal(state.status, "completed");
    assert.equal(state.result.actualProviderInvoked, false);
    const patch = readBoundedWorkerPatch(f.input, { onProcess });
    assert.equal(patch.origin, "provider-patch-proposal");
    assert.equal(patch.applied, false);
    assert.deepEqual(fs.readFileSync(f.sessionFile), before);
    const consumed = f.lease().consumption.consumptionId;
    await f.start();
    assert.equal(f.lease().consumption.consumptionId, consumed);
  },
);

test("proposal Host admits only its fixed runner and explicitly bound read-only intent", async (t) => {
  const f = await fixture(t);
  assert.equal(f.authorization.protocolVersion, "0.7.0");
  assert.equal(f.authorization.workspaceMode, "read-only");
  assert.equal(Object.hasOwn(f.authorization.workerInput, "writeBasis"), false);
  for (const extra of [
    { runnerFile: path.join(pluginRoot, "scripts/lib/runtime/runtime-codex-worker-runner.mjs") },
    { hostModuleFile: path.join(pluginRoot, "scripts/lib/runtime/runtime-codex-worker-runner.mjs") },
    { codexPolicyCapability: {} },
    { environment: { CODEX_HOME: f.container } },
    { environment: { NODE_OPTIONS: "--import ./unbound-loader.mjs" } },
    { environment: { NODE_PATH: f.container } },
    { workspaceBinding: { ...f.workspaceBinding, executionRoot: f.root } },
    { policy: { ...f.policy, enforcementVerified: true } },
  ])
    assert.throws(() => createBoundedWorkerJobHost({ policy: f.policy, workspaceBinding: f.workspaceBinding, ...extra }));
  const oldFixture = createBoundedWorkerJobHost({
    policy: { kind: "protocol-fixture", actualProviderInvoked: false },
    workspaceBinding: f.workspaceBinding,
    runnerFile: path.join(pluginRoot, "scripts/lib/runtime/runtime-codex-worker-runner.mjs"),
  });
  await assert.rejects(
    startBoundedWorkerJob(f.input, {
      host: oldFixture,
      spawnImplementation: () => {
        throw new Error("Must not spawn");
      },
    }),
  );
  await assert.rejects(
    runCodexProposal({ root: f.root, executionRoot: f.root, authorization: f.authorization, policy: f.policy, workspaceBinding: f.workspaceBinding }),
  );
  assert.equal(f.lease().status, "available");
  assert.equal(fs.existsSync(f.directory), false);
});

test("fixed proposal owner freezes settled provider output, never a workspace diff or new execution", { skip: process.platform !== "win32" }, async (t) => {
  const f = await fixture(t);
  const beforeP2 = fs.readFileSync(f.sessionFile),
    beforeSource = fs.readFileSync(path.join(f.root, "selected.txt"));
  const previousOptions = process.env.NODE_OPTIONS,
    previousNodePath = process.env.NODE_PATH;
  let state;
  try {
    process.env.NODE_OPTIONS = "--import ./must-not-load-unbound-module.mjs";
    process.env.NODE_PATH = f.container;
    state = await f.start();
  } finally {
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousOptions;
    if (previousNodePath === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = previousNodePath;
  }
  assert.equal(state.status, "completed");
  assert.equal(state.result.actualProviderInvoked, false);
  assert.equal(state.workspacePatch.origin, "provider-patch-proposal");
  const record = readRuntimeInvocationRecord({ ...f.input, storage: f.storage });
  const expected = buildWorkerPatchProposalCandidate({ authorization: f.authorization, structuredResult: record.draft.providerResult });
  const patch = readBoundedWorkerPatch(f.input, { onProcess });
  assert.deepEqual(patch.candidate, expected);
  assert.equal(expected.patches.length, 1);
  assert.equal(patch.origin, "provider-patch-proposal");
  assert.equal(patch.source.draftHash, record.draft.draftHash);
  assert.equal(patch.applied, false);
  assert.equal(patch.recoveryAuthority, false);
  assert.deepEqual(fs.readFileSync(f.sessionFile), beforeP2);
  assert.deepEqual(fs.readFileSync(path.join(f.root, "selected.txt")), beforeSource);
  assert.deepEqual(fs.readFileSync(path.join(f.workspaceBinding.executionRoot, "selected.txt")), beforeSource);
  const claim = fs.readFileSync(path.join(f.directory, "claim.json"));
  const request = JSON.parse(fs.readFileSync(path.join(f.directory, "request.json")));
  assert.equal(
    Object.keys(request.request.environment).some((key) => key.toLowerCase().startsWith("node_")),
    false,
  );
  assert.equal(request.request.environment.CODEX_HOME, f.codexHome);
  const ownerOutput = fs.readFileSync(path.join(f.directory, "stdout.bin"));
  const consumed = f.lease();
  const patchFile = path.join(f.directory, "workspace-patch.json"),
    originalPatch = fs.readFileSync(patchFile);

  // Reconstruct a missing freeze after exact owner cleanup, without rewriting
  // the owner's stdout or claiming that it originally published this file.
  fs.renameSync(patchFile, path.join(f.container, "retained-original-patch.json"));
  assert.equal(readBoundedWorkerJob(f.input, { onProcess }).workspacePatchStatus, "missing");
  assert.equal(reconcileBoundedWorkerJob(f.input, { onProcess }).status, "completed");
  assert.deepEqual(fs.readFileSync(patchFile), originalPatch);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, "stdout.bin")), ownerOutput);

  // Invocation publication loss is recovered from the exact settled spool.
  const recordDirectory = path.join(f.root, relativeProjectArtifact(f.storage, "runtime", "invocations"), f.authorization.authorizationId);
  fs.renameSync(recordDirectory, path.join(f.container, "retained-original-record"));
  fs.renameSync(patchFile, path.join(f.container, "retained-second-patch.json"));
  assert.equal(readBoundedWorkerJob(f.input, { onProcess }).status, "incomplete");
  // A transient publisher denial is NOT permission to run the worker again.
  // Keep the exact completed spool/lease, expose the error, then let an explicit
  // reconciliation recover the same P3 bytes after the external denial ends.
  const rename = fs.renameSync;
  const denied = Object.assign(new Error("synthetic publication denied"), { code: "EPERM", syscall: "rename" });
  let deniedAttempts = 0;
  const publisher = t.mock.method(fs, "renameSync", function (source, target) {
    if (target === recordDirectory) {
      deniedAttempts++;
      throw denied;
    }
    return Reflect.apply(rename, this, arguments);
  });
  try {
    assert.throws(
      () => reconcileBoundedWorkerJob(f.input, { onProcess }),
      (error) => error === denied,
    );
    assert.equal(deniedAttempts, 1, "publication is not automatically retried");
    assert.equal(fs.existsSync(recordDirectory), false);
    assert.equal(fs.existsSync(patchFile), false);
    assert.deepEqual(fs.readFileSync(path.join(f.directory, "stdout.bin")), ownerOutput);
    assert.deepEqual(fs.readFileSync(path.join(f.directory, "claim.json")), claim);
    assert.deepEqual(f.lease(), consumed);
    assert.deepEqual(fs.readFileSync(f.sessionFile), beforeP2);
  } finally {
    publisher.mock.restore();
  }
  assert.equal(reconcileBoundedWorkerJob(f.input, { onProcess }).status, "completed");
  assert.deepEqual(readRuntimeInvocationRecord({ ...f.input, storage: f.storage }).draft, record.draft);
  assert.deepEqual(fs.readFileSync(patchFile), originalPatch);

  // Later physical edits and Host drift are history, not inputs to a second
  // execution or a new interpretation of the provider's settled proposal.
  fs.writeFileSync(path.join(f.workspaceBinding.executionRoot, "selected.txt"), "later unrelated workspace edit");
  fs.writeFileSync(path.join(f.root, "selected.txt"), "later user edit");
  fs.writeFileSync(path.join(f.codexHome, "AGENTS.md"), "Later Host instructions not part of this result");
  assert.deepEqual(readBoundedWorkerPatch(f.input, { onProcess }).candidate, expected);
  assert.equal(readBoundedWorkerJob(f.input, { onProcess }).current, false);
  assert.equal((await startBoundedWorkerJob(f.input)).status, "completed");
  assert.deepEqual(fs.readFileSync(path.join(f.directory, "claim.json")), claim);
  assert.deepEqual(f.lease(), consumed);
  assert.deepEqual(fs.readFileSync(f.sessionFile), beforeP2);

  const divergent = JSON.parse(originalPatch);
  divergent.candidate = buildWorkerPatchCandidate({
    basis: f.authorization.workerInput.proposalBasis,
    changes: [{ path: "selected.txt", after: null }],
    maxBytes: f.authorization.limits.maxInputBytes,
  });
  fs.writeFileSync(patchFile, JSON.stringify(divergent));
  try {
    assert.throws(() => readBoundedWorkerPatch(f.input, { onProcess }), { code: "WORKER_JOB_CONFLICT" });
  } finally {
    fs.writeFileSync(patchFile, originalPatch);
  }
});

test("proposal freeze recovery requires exact settled result and complete native owner terminal", { skip: process.platform !== "win32" }, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.start()).status, "completed");
  const patchFile = path.join(f.directory, "workspace-patch.json");
  const original = fs.readFileSync(patchFile);
  fs.renameSync(patchFile, path.join(f.container, "retained-patch.json"));
  const terminalFile = path.join(f.directory, "terminal.json"),
    terminalBytes = fs.readFileSync(terminalFile);
  const terminal = JSON.parse(terminalBytes);
  fs.writeFileSync(terminalFile, JSON.stringify({ ...terminal, completeOutput: false }));
  try {
    assert.notEqual(reconcileBoundedWorkerJob(f.input, { onProcess }).status, "completed");
    assert.equal(fs.existsSync(patchFile), false);
  } finally {
    fs.writeFileSync(terminalFile, terminalBytes);
  }
  const releaseFile = path.join(f.root, relativeProjectArtifact(f.storage, "runtime", "execution-leases"), f.authorization.authorizationId, "release.json");
  assert.ok(fs.existsSync(releaseFile));
  const retainedRelease = path.join(f.container, "retained-release.json");
  fs.renameSync(releaseFile, retainedRelease);
  try {
    assert.notEqual(reconcileBoundedWorkerJob(f.input, { onProcess }).status, "completed");
    assert.equal(fs.existsSync(patchFile), false);
  } finally {
    fs.renameSync(retainedRelease, releaseFile);
  }
  fs.writeFileSync(`${patchFile}.pending`, JSON.stringify({ origin: "workspace-diff" }), { flag: "wx" });
  assert.throws(() => reconcileBoundedWorkerJob(f.input, { onProcess }), { code: "WORKER_JOB_CONFLICT" });
  assert.equal(fs.existsSync(patchFile), false);
  fs.renameSync(`${patchFile}.pending`, path.join(f.container, "retained-divergent-pending.json"));
  // A complete pending publication converges without deleting original evidence.
  fs.writeFileSync(`${patchFile}.pending`, original, { flag: "wx" });
  assert.equal(reconcileBoundedWorkerJob(f.input, { onProcess }).status, "completed");
  assert.equal(hash(fs.readFileSync(patchFile)), hash(original));
  assert.equal(readBoundedWorkerPatch(f.input, { onProcess }).origin, "provider-patch-proposal");
});
