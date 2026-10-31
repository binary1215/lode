import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";
import { runCommand, usage } from "../scripts/head.mjs";
import { dispatch, tools, catalogTools, toolsForSurface } from "../scripts/mcp-server.mjs";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { buildRuntimeVersionEvidence } from "../scripts/lib/runtime-machine-execution.mjs";
import { buildRuntimeProtocolEvidence, buildRuntimeProjectBinding } from "../scripts/lib/runtime-protocol-evidence.mjs";
import { buildRuntimeInvocationAuthorization } from "../scripts/lib/runtime-invocation-lifecycle.mjs";
import { createBoundedWorkerDispatch } from "../scripts/lib/bounded-worker-dispatch.mjs";
import { createBoundedWorkerWave } from "../scripts/lib/bounded-worker-wave.mjs";
import { workerIntegrationFixture } from "./helpers/worker-integration-fixture.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const code = "MANAGED_OPERATION_NOT_ON_DEFAULT_SURFACE";
const mutations = [
  ["worker-prepare", "lode_bounded_worker_prepare"], ["worker-start", "lode_bounded_worker_start"],
  ["worker-dispatch", "lode_bounded_worker_dispatch"], ["worker-execute", null],
  ["worker-apply", "lode_bounded_worker_apply_result"], ["worker-reconcile", "lode_bounded_worker_reconcile"],
  ["worker-job-reconcile", "lode_bounded_worker_job_reconcile"], ["worker-integrate", "lode_worker_integration"],
  ["worker-wave-create", "lode_bounded_worker_wave_create"], ["worker-wave-seal", "lode_bounded_worker_wave_seal"],
  ["worker-wave-abandon", "lode_bounded_worker_wave_abandon"],
];
const request = (name, args) => ({ id: 1, method: "tools/call", params: { name, arguments: args } });
const processEvent = event => console.log(JSON.stringify({ ...event, at: new Date().toISOString(), ports: [] }));
processEvent({ event: "test", pid: process.pid, parentPid: process.ppid, command: process.execPath, args: process.argv.slice(1), cwd: process.cwd() });
function fixture(t) {
  const parent = fs.realpathSync(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "head-maintenance-surface-"));
  t.after(() => {
    assert.equal(path.dirname(root), parent); assert.match(path.basename(root), /^head-maintenance-surface-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  fs.writeFileSync(path.join(root, "a.txt"), "synthetic original\n");
  return root;
}
function snapshot(root) {
  return fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? snapshot(file) : [[file, fs.readFileSync(file).toString("base64")]];
  });
}

test("small default discovery keeps all optional contracts discoverable and managed mutations separate", async () => {
  const ordinary = (await dispatch({ id: 1, method: "tools/list" })).result.tools;
  const retained = (await dispatch({ id: 2, method: "tools/list" }, { surface: "managed-maintenance" })).result.tools;
  assert.deepEqual(ordinary, tools); assert.deepEqual(retained, toolsForSurface("managed-maintenance"));
  assert.equal(ordinary.length, 22);
  for (const name of ["lode_session_create", "lode_project_direction_update"]) {
    assert.strictEqual(tools.find(tool => tool.name === name), catalogTools.find(tool => tool.name === name));
    assert.deepEqual(ordinary.find(tool => tool.name === name), retained.find(tool => tool.name === name));
  }
  assert(ordinary.some(tool => tool.name === "lode_session_host_request_prepare"));
  assert(catalogTools.some(tool => tool.name === "lode_onboarding_candidate_restore"));
  const routers = new Set(["lode_tools_discover", "lode_tools_read", "lode_tools_call"]);
  assert.deepEqual(retained.filter(tool => !routers.has(tool.name)).map(tool => tool.name).sort(), catalogTools.map(tool => tool.name).sort());
  for (const [, name] of mutations) if (name) {
    const discovered = (await dispatch(request("lode_tools_discover", { name }))).result.structuredContent.tools[0];
    assert.equal(discovered.executionMode, "managed");
    assert.equal(discovered.invokeWith, "lode_tools_call");
  }
  for (const name of ["lode_bounded_worker_status", "lode_bounded_worker_wait", "lode_bounded_worker_job_status", "lode_bounded_worker_job_patch", "lode_bounded_worker_cancel", "lode_worker_integration_status", "lode_bounded_worker_wave_read", "lode_bounded_worker_wave_status", "lode_bounded_worker_wave_results", "lode_bounded_worker_wave_wait", "lode_context_preview", "lode_world_model", "lode_conversation_enter"]) {
    assert(catalogTools.some(tool => tool.name === name), name);
    const found = await dispatch(request("lode_tools_discover", { name }));
    assert.equal(found.result.structuredContent.tools[0].name, name);
  }
});

test("raw MCP and CLI mutations cannot bypass discovery or write any project state", async t => {
  const root = fixture(t), before = snapshot(root), events = [];
  for (const [command, name] of mutations) {
    (await assert.rejects(async () => (await runCommand([command, root], { onProcess: e => events.push(e) })), { code }));
    if (!name) continue;
    const result = await dispatch(request(name, { project_root: root, surface: "managed-maintenance", maintenance: true }), { onProcess: e => events.push(e) });
    assert.match(result.error.message, /not available on the ordinary command surface/);
    assert.doesNotMatch(result.error.message, /unlock|approve|retry|call head_/i);
    const explicit = await dispatch(request(name, { project_root: root }), { surface: "managed-maintenance", onProcess: e => events.push(e) });
    assert(explicit.error, name); assert.doesNotMatch(explicit.error.message, /not available on the ordinary/);
  }
  for (const action of ["prepare", "apply", "reconcile", "settle-incomplete", "prepare-result", "publish-result"]) {
    const response = await dispatch(request("lode_worker_integration", { project_root: root, action }));
    assert.match(response.error.message, /not available on the ordinary/);
  }
  assert.deepEqual(snapshot(root), before); assert.deepEqual(events, []);
});

function schemaSpawn(_command, args) {
  const key = args.join(" ");
  const text = key === "--version" ? "codex 1.2.3\n" : key === "--help" ? "exec\nmcp-server\napp-server\n"
    : key === "exec --help" ? "Run Codex non-interactively\n--json\n--output-schema\n--color\n--sandbox\n--skip-git-repo-check\n--cd\n--ephemeral\nresume\n"
      : "stdio://\ngenerate-json-schema\n--listen\n";
  const child = new EventEmitter();
  Object.assign(child, { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null });
  child.kill = () => { throw Error("Schema-only fixture has no process"); };
  queueMicrotask(() => { child.stdout.emit("data", Buffer.from(text)); child.exitCode = 0; child.emit("close", 0, null); });
  return child;
}
async function authorization(root, worker = undefined) {
  const bin = path.join(root, "schema"); fs.mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(executable, "never executed\n"); if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
  const environment = { ...process.env, PATH: bin }; delete environment.Path; delete environment.path;
  const versionEvidence = await buildRuntimeVersionEvidence({ runtimes: ["codex"], environment, spawnImplementation: schemaSpawn });
  const protocolEvidence = await buildRuntimeProtocolEvidence({ runtimes: ["codex"], environment, versionEvidence, spawnImplementation: schemaSpawn });
  const inspected = inspectProject(root);
  const projectBinding = buildRuntimeProjectBinding({ storage: inspected.storage, projectId: inspected.project.projectId, headSessionId: inspected.state.sessionId,
    projectRoot: fs.realpathSync(root), projectStatus: "ready", versionEvidence, protocolEvidence });
  return buildRuntimeInvocationAuthorization({ root, runtime: "codex", scope: { kind: "session", request: "Inspect synthetic a.txt" },
    workspaceMode: "read-only", protocolEvidence, projectBinding, worker, persist: true }).authorization;
}

test("shared runtime remains available, but exact worker inputs and legacy dispatches cannot alias managed execution", async t => {
  const root = fixture(t);
  const input = path.join(root, "input.json"); fs.writeFileSync(input, JSON.stringify({ worker: {} }));
  (await assert.rejects(async () => (await runCommand(["runtime-invocation-authorize", root, "--input", input])), { code }));
  const ordinary = await authorization(root);
  const before = snapshot(root);
  // Non-worker Run application reaches the original Session-vs-Run verifier.
  (await assert.rejects(async () => (await runCommand(["runtime-invocation-apply-run-result", root, "--authorization", ordinary.authorizationId])), error => error.code !== code));
  assert.deepEqual(snapshot(root), before);
  createBoundedWorkerDispatch({ root, authorizationId: ordinary.authorizationId, role: "reviewer" });
  const legacyBefore = snapshot(root);
  for (const command of ["runtime-invocation-execute", "runtime-invocation-apply-run-result"]) {
    (await assert.rejects(async () => (await runCommand([command, root, "--authorization", ordinary.authorizationId])), { code }));
  }
  assert.deepEqual(snapshot(root), legacyBefore);
  const root2 = fixture(t);
  const worker = await authorization(root2, { taskKey: "review-a", role: "reviewer", outcome: "Inspect a.txt", selectedContext: "Synthetic input", sourcePaths: ["a.txt"] });
  const workerBefore = snapshot(root2);
  (await assert.rejects(async () => (await runCommand(["runtime-invocation-execute", root2, "--authorization", worker.authorizationId])), { code }));
  assert.deepEqual(snapshot(root2), workerBefore);
  // Default historical read does not acquire a lease or repair anything.
  assert.equal((await runCommand(["worker-read", root, "--authorization", ordinary.authorizationId])).status, "verified");
  assert.deepEqual(snapshot(root), legacyBefore);
});

async function wire(args, root, input = "") {
  processEvent({ event: "planned", command: process.execPath, args, cwd: root, parentPid: process.pid });
  const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  processEvent({ event: "spawn", pid: child.pid, parentPid: process.pid, command: process.execPath, args, cwd: root });
  const stdout = [], stderr = []; let error;
  const timer = setTimeout(() => { error = Error("Wire fixture timeout"); child.kill(); }, 15000);
  child.stdout.on("data", b => stdout.push(b)); child.stderr.on("data", b => stderr.push(b));
  child.on("error", e => { error = e; }); child.stdin.on("error", e => { error = e; });
  child.stdin.end(input);
  const exitCode = await new Promise(resolve => child.once("close", resolve)); clearTimeout(timer);
  processEvent({ event: "closed", pid: child.pid, exitCode });
  if (error) throw error;
  if (child.pid) assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  return { exitCode, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
}

test("actual stdio entries and plain/JSON help agree without provider discovery", async t => {
  const root = fixture(t), before = snapshot(root), head = path.join(pluginRoot, "scripts/head.mjs");
  for (const prefix of [[], ["managed-maintenance"]]) {
    const surface = prefix.length ? "managed-maintenance" : "ordinary";
    const plain = await wire([head, ...prefix, "help-all"], root);
    const json = await wire([head, ...prefix, "help-all", "--json"], root);
    assert.equal(plain.exitCode, 0, plain.stderr); assert.equal(json.exitCode, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), usage({ all: true, surface }));
    assert.equal(plain.stdout.includes("worker-prepare"), !!prefix.length);
    const server = path.join(pluginRoot, "scripts", prefix.length ? "mcp-managed-maintenance.mjs" : "mcp-server.mjs");
    const listed = await wire([server], root, JSON.stringify({ id: 1, method: "tools/list" }) + "\n");
    assert.equal(listed.exitCode, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout).result.tools, toolsForSurface(surface));
  }
  const blocked = await wire([head, "worker-start", root, "--json"], root);
  assert.equal(blocked.exitCode, 1); assert.equal(JSON.parse(blocked.stdout).code, code);
  assert.deepEqual(snapshot(root), before);
});

test("default diagnostics preserve exact history without recommending launches; explicit maintenance retains sealing", async t => {
  const f = await workerIntegrationFixture(t);
  const created = createBoundedWorkerWave({ root: f.root, authorizationIds: f.members.map(member => member.authorizationId) });
  const waveId = created.wave.waveId;
  const before = snapshot(f.root);
  for (let i = 0; i < 2; i++) {
    const cli = (await runCommand(["worker-wave-status", f.root, "--wave", waveId]));
    const mcp = await dispatch(request("lode_bounded_worker_wave_status", { project_root: f.root, wave_id: waveId }));
    assert.deepEqual(mcp.result.structuredContent, cli);
    assert.equal(cli.projection.guidance.canSeal, true, "Mechanical evidence is retained, not authority to mutate");
    assert.match(cli.projection.guidance.nextStep, /status never seals or selects a maintenance mutation/);
    const status = (await runCommand(["worker-integration-status", f.root, "--integration", f.integrationId]));
    assert.match(status.application.guidance.nextStep, /does not select application/);
    assert.equal(status.application.guidance.ordinaryWorkBlocked, false);
  }
  assert.deepEqual(snapshot(f.root), before);
  const seal = (await runCommand(["managed-maintenance", "worker-wave-seal", f.root, "--wave", waveId]));
  assert.equal(seal.status, "sealed");
  const sealed = snapshot(f.root);
  const replay = await dispatch(request("lode_bounded_worker_wave_seal", { project_root: f.root, wave_id: waveId }), { surface: "managed-maintenance" });
  assert.equal(replay.error, undefined);
  assert.deepEqual(snapshot(f.root), sealed, "Maintenance replay retains create-only behavior");
});
