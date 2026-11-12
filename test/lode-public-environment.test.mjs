import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { pythonExecutable } from "../scripts/lib/world/python-source-collector.mjs";
import { ENVIRONMENT_NAME_PAIRS } from "../compat/head/public-names.mjs";
import { initializeProject, inspectProject } from "../scripts/lib/session/lode-core.mjs";
import { buildRuntimeVersionEvidence } from "../scripts/lib/runtime/runtime-machine-execution.mjs";
import { buildRuntimeProjectBinding, buildRuntimeProtocolEvidence } from "../scripts/lib/runtime/runtime-protocol-evidence.mjs";
import { buildRuntimeInvocationAuthorization } from "../scripts/lib/runtime/runtime-invocation-lifecycle.mjs";
import { createBoundedWorkerDispatch } from "../scripts/lib/worker/bounded-worker-dispatch.mjs";
import { createBoundedWorkerJobHost, startBoundedWorkerJob, readBoundedWorkerJob } from "../scripts/lib/worker/bounded-worker-job.mjs";
import { RUNTIME_OPERATIONAL_STATE_ENV, RUNTIME_OPERATIONAL_STATE_CANONICAL_ENV } from "../scripts/lib/runtime/runtime-execution-lease.mjs";
import { captureWorkerSourceBasis } from "../scripts/lib/worker/worker-source-basis.mjs";
import { captureWorkerWriteBasis } from "../scripts/lib/worker/worker-patch-basis.mjs";
import { prepareWorkerWorkspace } from "../scripts/lib/worker/worker-workspace.mjs";
import { workerPatchProposalExecutionBoundary } from "../scripts/lib/worker/worker-patch-proposal.mjs";
import { buildCodexFreshProposalPolicyPlan } from "../scripts/lib/runtime/runtime-codex-proposal-policy.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const encode = value => Buffer.from(JSON.stringify(value));
function environment(t, values) {
  const prior = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => { for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function temporary(t) {
  const parent = fs.realpathSync(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "lode-env-test-"));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.match(path.basename(root), /^lode-env-test-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("Python canonical setting and legacy alias select the same real file without execution", t => {
  const root = temporary(t), first = path.join(root, "python-marker"), second = path.join(root, "other-marker");
  fs.writeFileSync(first, "Never executed"); fs.writeFileSync(second, "Never executed either");
  fs.mkdirSync(path.join(root, "unused"));
  environment(t, { LODE_PYTHON: first, HEAD_PYTHON: undefined });
  assert.equal(pythonExecutable(), fs.realpathSync(first));
  process.env.HEAD_PYTHON = path.join(root, "unused", "..", "python-marker");
  assert.equal(pythonExecutable(), fs.realpathSync(first));
  delete process.env.LODE_PYTHON;
  assert.equal(pythonExecutable(), fs.realpathSync(first));
  process.env.LODE_PYTHON = second;
  assert.throws(pythonExecutable, { code: "PYTHON_CONFIGURATION_CONFLICT" });
  process.env.LODE_PYTHON = first; process.env.HEAD_PYTHON = "relative-python";
  assert.throws(pythonExecutable, { code: "PYTHON_NOT_CONFIGURED" });
  process.env.LODE_PYTHON = path.join(root, "missing"); process.env.HEAD_PYTHON = first;
  assert.throws(pythonExecutable, { code: "PYTHON_NOT_CONFIGURED" });
  assert.deepEqual(ENVIRONMENT_NAME_PAIRS.find(pair => pair.canonical === "LODE_PYTHON"),
    { canonical: "LODE_PYTHON", legacy: "HEAD_PYTHON", class: "trusted-path-domain" });
});

test("Python PATH fallback remains available only with no configured executable", t => {
  const root = temporary(t), name = process.platform === "win32" ? "python.exe" : "python3";
  const marker = path.join(root, name); fs.writeFileSync(marker, "PATH lookup marker, never executed");
  environment(t, { LODE_PYTHON: "", HEAD_PYTHON: "", PATH: root });
  assert.equal(pythonExecutable(), fs.realpathSync(marker));
  process.env.LODE_PYTHON = "relative-python";
  assert.throws(pythonExecutable, { code: "PYTHON_NOT_CONFIGURED" });
  delete process.env.LODE_PYTHON; delete process.env.HEAD_PYTHON; process.env.PATH = "relative-only";
  assert.throws(pythonExecutable, { code: "PYTHON_NOT_CONFIGURED" });
});

// Schema-only observations: these EventEmitters never create a process/provider.
function schemaSpawn(_command, args) {
  const key = args.join(" ");
  const output = key === "--version" ? "codex 1.2.3\n" : key === "--help" ? "exec\nmcp-server\napp-server\n"
    : key === "exec --help" ? "Run Codex non-interactively\n--json\n--output-schema\n--color\n--sandbox\n--skip-git-repo-check\n--cd\n--ephemeral\nresume\n"
      : "stdio://\ngenerate-json-schema\n--listen\n";
  const child = new EventEmitter();
  Object.assign(child, { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null });
  child.kill = () => { throw new Error("Schema fixture has no OS process"); };
  queueMicrotask(() => { child.stdout.emit("data", Buffer.from(output)); child.exitCode = 0; child.emit("close", 0, null); });
  return child;
}
async function jobFixture(t, proposal = false, { retained = true } = {}) {
  const container = temporary(t);
  const [root, operational, bin, codexHome] = ["project", "operational", "schema-only", "codex-home"].map(name => {
    const directory = path.join(container, name); fs.mkdirSync(directory); return fs.realpathSync(directory);
  });
  environment(t, { [RUNTIME_OPERATIONAL_STATE_ENV]: operational, [RUNTIME_OPERATIONAL_STATE_CANONICAL_ENV]: undefined });
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  fs.writeFileSync(path.join(root, "selected.txt"), "Synthetic selected source\n");
  const executable = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(executable, "Schema marker, never executed");
  if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
  const env = { ...process.env, PATH: bin }; delete env.Path; delete env.path;
  const versionEvidence = await buildRuntimeVersionEvidence({ runtimes: ["codex"], environment: env, spawnImplementation: schemaSpawn });
  const protocolEvidence = await buildRuntimeProtocolEvidence({ runtimes: ["codex"], environment: env, versionEvidence, spawnImplementation: schemaSpawn });
  const inspected = inspectProject(root);
  const projectBinding = buildRuntimeProjectBinding({ storage: inspected.storage, projectId: inspected.project.projectId,
    headSessionId: inspected.state.sessionId, projectRoot: root, projectStatus: "ready", versionEvidence, protocolEvidence });
  let policy = { kind: "protocol-fixture", actualProviderInvoked: false }, workspaceBinding = null, boundary;
  if (proposal) {
    const sourceBasis = captureWorkerSourceBasis({ root, paths: ["selected.txt"], maxBytes: 1024 * 1024 });
    const proposalBasis = captureWorkerWriteBasis({ root, paths: ["selected.txt"], maxBytes: 1024 * 1024 });
    workspaceBinding = prepareWorkerWorkspace({ projectRoot: root, workspaceRoot: path.join(container, "selected"), sourceBasis, maxBytes: 1024 * 1024 });
    policy = buildCodexFreshProposalPolicyPlan({ executablePath: fs.realpathSync(process.execPath), codexHome, evidenceMode: "protocol-fixture" });
    boundary = workerPatchProposalExecutionBoundary({ binding: workspaceBinding, policy, sourceBasis, proposalBasis });
  }
  const authorization = buildRuntimeInvocationAuthorization({ root, runtime: "codex", protocolEvidence, projectBinding,
    ...(proposal ? { runtimeSelection: { model: policy.model }, workspaceMode: "read-only" } : {}),
    scope: { kind: "session", request: "Inspect synthetic evidence only" },
    worker: { taskKey: "env-fixture", role: "coder", outcome: "Verify alias binding", selectedContext: "Synthetic environment test, no provider",
      sourcePaths: ["selected.txt"], ...(proposal ? { proposalPaths: ["selected.txt"], executionBoundary: boundary } : {}) } }).authorization;
  if (retained) createBoundedWorkerDispatch({ root, authorizationId: authorization.authorizationId, role: "coder" });
  const directory = path.join(operational, "worker-jobs", authorization.projectId, authorization.authorizationId);
  if (retained) fs.mkdirSync(directory, { recursive: true });
  const dispatchFile = path.join(root, inspected.storage.directory, "runtime", "worker-dispatches", `${authorization.authorizationId}.json`);
  const input = { root, authorizationId: authorization.authorizationId, role: "coder" };
  const baseBinding = { projectRoot: root, authorizationId: authorization.authorizationId, authorizationHash: authorization.authorizationHash,
    inputDigest: authorization.executionInput.digest, taskKey: authorization.workerInput.taskKey, role: "coder", operationalRoot: operational,
    policy, policyDigest: hash(encode(policy)), deadlineUnixMs: Date.now() + 30000, ...(workspaceBinding ? { workspaceBinding } : {}),
    supervisorManifestPath: path.join(container, "not-a-supervisor-manifest.json") };
  function retain(env) {
    const request = { deadlineUnixMs: baseBinding.deadlineUnixMs, request: { workingDirectory: root, environment: env } };
    const binding = { ...baseBinding, requestDigest: hash(encode(request)) };
    fs.writeFileSync(path.join(directory, "request.json"), encode(request));
    fs.writeFileSync(path.join(directory, "binding.json"), encode({ ...binding, bindingDigest: hash(encode(binding)) }));
    return [fs.readFileSync(path.join(directory, "request.json")), fs.readFileSync(path.join(directory, "binding.json"))];
  }
  return { root, container, operational, directory, dispatchFile, authorization, policy, workspaceBinding, input, retain };
}

for (const proposal of [false, true]) test(`recorded ${proposal ? "proposal" : "ordinary"} requests retain legacy/canonical bytes and reject conflicting aliases`, async t => {
  const f = await jobFixture(t, proposal), extra = proposal ? { CODEX_HOME: f.policy.codexHome } : {};
  for (const env of [
    { [RUNTIME_OPERATIONAL_STATE_ENV]: f.operational },
    { [RUNTIME_OPERATIONAL_STATE_CANONICAL_ENV]: f.operational },
    { [RUNTIME_OPERATIONAL_STATE_ENV]: f.operational, [RUNTIME_OPERATIONAL_STATE_CANONICAL_ENV]: f.operational },
  ]) {
    const before = f.retain({ ...extra, ...env });
    assert.equal(readBoundedWorkerJob(f.input, { inspectorSelection: { manifestPath: path.join(f.container, "absent.json") } }).status, "unknown", "No native owner/provider was started");
    assert.deepEqual([fs.readFileSync(path.join(f.directory, "request.json")), fs.readFileSync(path.join(f.directory, "binding.json"))], before);
  }
  for (const env of [{},
    { [RUNTIME_OPERATIONAL_STATE_ENV]: f.operational, [RUNTIME_OPERATIONAL_STATE_CANONICAL_ENV]: path.join(f.container, "different") },
    { [RUNTIME_OPERATIONAL_STATE_ENV]: f.operational, lode_agent_operational_state_root: path.join(f.container, "different") },
    { [RUNTIME_OPERATIONAL_STATE_CANONICAL_ENV]: f.operational, [RUNTIME_OPERATIONAL_STATE_ENV]: "" },
    { [RUNTIME_OPERATIONAL_STATE_CANONICAL_ENV]: f.operational, LODE_AGENT_UNRELATED: "untrusted" },
  ]) {
    if (!proposal && Object.hasOwn(env, "LODE_AGENT_UNRELATED")) continue;
    f.retain({ ...extra, ...env });
    assert.throws(() => readBoundedWorkerJob(f.input), { code: "WORKER_JOB_CONFLICT" });
  }
  const matchingCaseAlias = { ...extra, [RUNTIME_OPERATIONAL_STATE_ENV]: f.operational, head_agent_operational_state_root: f.operational };
  const before = f.retain(matchingCaseAlias);
  if (proposal) assert.throws(() => readBoundedWorkerJob(f.input), { code: "WORKER_JOB_CONFLICT" });
  else {
    assert.equal(readBoundedWorkerJob(f.input, { inspectorSelection: { manifestPath: path.join(f.container, "absent.json") } }).status, "unknown");
    assert.deepEqual([fs.readFileSync(path.join(f.directory, "request.json")), fs.readFileSync(path.join(f.directory, "binding.json"))], before);
  }
});

test("new worker requests emit canonical operational root and preserve no-replay after launcher loss", { skip: process.platform !== "win32" }, async t => {
  const f = await jobFixture(t);
  const host = createBoundedWorkerJobHost({ runnerFile: path.join(pluginRoot, "scripts/lib/runtime/runtime-codex-worker-runner.mjs"),
    policy: f.policy, environment: { head_agent_operational_state_root: f.operational, Lode_Agent_Operational_State_Root: f.operational } });
  const selection = { manifest: { manifestHash: hash("synthetic manifest") }, manifestPath: path.join(f.container, "absent.json"), binaryPath: process.execPath };
  let attempts = 0;
  await assert.rejects(startBoundedWorkerJob(f.input, { host, supervisorSelection: selection,
    spawnImplementation: () => { attempts += 1; throw Object.assign(new Error("Injected before spawn, no process exists"), { code: "SYNTHETIC_NO_SPAWN" }); } }), { code: "SYNTHETIC_NO_SPAWN" });
  const request = JSON.parse(fs.readFileSync(path.join(f.directory, "request.json")));
  assert.equal(request.request.environment[RUNTIME_OPERATIONAL_STATE_CANONICAL_ENV], f.operational);
  assert.equal(Object.hasOwn(request.request.environment, RUNTIME_OPERATIONAL_STATE_ENV), false);
  assert.deepEqual(Object.keys(request.request.environment).filter(key => key.toLowerCase().includes("operational_state_root")), [RUNTIME_OPERATIONAL_STATE_CANONICAL_ENV]);
  const bytes = fs.readFileSync(path.join(f.directory, "request.json"));
  assert.equal((await startBoundedWorkerJob(f.input)).status, "unknown");
  assert.equal(attempts, 1); assert.deepEqual(fs.readFileSync(path.join(f.directory, "request.json")), bytes);
});

test("new worker launch refuses a conflicting Host alias before dispatch or job artifacts", { skip: process.platform !== "win32" }, async t => {
  const f = await jobFixture(t, false, { retained: false });
  const operationalBefore = fs.readdirSync(f.operational, { recursive: true });
  assert.equal(fs.existsSync(f.dispatchFile), false);
  assert.equal(fs.existsSync(f.directory), false);
  const host = createBoundedWorkerJobHost({ runnerFile: path.join(pluginRoot, "scripts/lib/runtime/runtime-codex-worker-runner.mjs"),
    policy: f.policy, environment: { lode_agent_operational_state_root: path.join(f.container, "other-root") } });
  await assert.rejects(startBoundedWorkerJob(f.input, { host, supervisorSelection: { manifest: {}, manifestPath: "unused" },
    spawnImplementation: () => { assert.fail("Conflicting alias must not spawn"); } }), { code: "WORKER_JOB_CONFLICT" });
  assert.equal(fs.existsSync(path.join(f.directory, "intent.json")), false);
  assert.equal(fs.existsSync(path.join(f.directory, "binding.json")), false);
  assert.equal(fs.existsSync(f.dispatchFile), false);
  assert.equal(fs.existsSync(f.directory), false);
  assert.deepEqual(fs.readdirSync(f.operational, { recursive: true }), operationalBefore);
});

test("empty or whitespace Host operational aliases retain the resolver's unset semantics", { skip: process.platform !== "win32" }, async t => {
  for (const name of [RUNTIME_OPERATIONAL_STATE_CANONICAL_ENV, RUNTIME_OPERATIONAL_STATE_ENV]) {
    for (const value of ["", " \t\r\n "]) await t.test(`${name}: ${value ? "whitespace" : "empty"}`, async child => {
      const f = await jobFixture(child, false, { retained: false });
      const host = createBoundedWorkerJobHost({ runnerFile: path.join(pluginRoot, "scripts/lib/runtime/runtime-codex-worker-runner.mjs"),
        policy: f.policy, environment: { [name]: value } });
      const selection = { manifest: { manifestHash: hash("synthetic manifest") }, manifestPath: path.join(f.container, "absent.json"), binaryPath: process.execPath };
      let attempts = 0;
      await assert.rejects(startBoundedWorkerJob(f.input, { host, supervisorSelection: selection,
        spawnImplementation: () => { attempts += 1; throw Object.assign(new Error("Injected before spawn, no process exists"), { code: "SYNTHETIC_NO_SPAWN" }); } }), { code: "SYNTHETIC_NO_SPAWN" });
      const request = JSON.parse(fs.readFileSync(path.join(f.directory, "request.json")));
      assert.equal(attempts, 1, "Blank aliases do not introduce a preparation gate");
      assert.equal(request.request.environment[RUNTIME_OPERATIONAL_STATE_CANONICAL_ENV], f.operational);
      assert.equal(Object.hasOwn(request.request.environment, RUNTIME_OPERATIONAL_STATE_ENV), false);
    });
  }
});
