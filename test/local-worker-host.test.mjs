import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { createWholePlanSnapshot, createExecutionContract } from "../scripts/lib/execution-lineage.mjs";
import { startRun } from "../scripts/lib/run-lineage.mjs";
import { isManagedMutation } from "../scripts/lib/managed-maintenance-surface.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const nativeRoot = process.env.HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT;
const skip = process.platform !== "win32" || !nativeRoot ? "Packaged Windows native test artifact not supplied" : false;
const onProcess = event => console.log(JSON.stringify({ ...event, at: new Date().toISOString() }));
onProcess({ type: "test", pid: process.pid, parentPid: process.ppid, command: process.execPath, args: process.argv.slice(1), cwd: process.cwd(), ports: [] });
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
function schemaSpawn(_command, args) {
  const key = args.join(" ");
  const output = key === "--version" ? "codex 1.2.3\n" : key === "--help" ? "exec\nmcp-server\napp-server\n"
    : key === "exec --help" ? "Run Codex non-interactively\n--json\n--output-schema\n--color\n--sandbox\n--skip-git-repo-check\n--cd\n--ephemeral\nresume\n"
      : "stdio://\ngenerate-json-schema\n--listen\n";
  const child = new EventEmitter();
  Object.assign(child, { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null });
  child.kill = () => { throw Error("No process in schema fixture"); };
  queueMicrotask(() => { child.stdout.emit("data", Buffer.from(output)); child.exitCode = 0; child.emit("close", 0, null); });
  return child;
}
async function frontDoor(file, args, root, request = null, environment = process.env, command = process.execPath) {
  // These retained managed-work scenarios explicitly target maintenance.
  // Ordinary discovery/rejection is exercised separately, without this wrapper.
  if (path.basename(file) === "head.mjs" && isManagedMutation(args[0])) args = ["managed-maintenance", ...args];
  if (path.basename(file) === "mcp-server.mjs" && isManagedMutation(request?.params?.name)) file = path.join(path.dirname(file), "mcp-managed-maintenance.mjs");
  onProcess({ type: "planned", parentPid: process.pid, command, args: [file, ...args], cwd: root, ports: [] });
  const child = spawn(command, [file, ...args], { cwd: root, env: environment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  onProcess({ type: "spawn", pid: child.pid, parentPid: process.pid, cwd: root, ports: [] });
  const out = [], err = []; let size = 0, failure;
  const timer = setTimeout(() => { failure = Error("Frontend timeout"); child.kill(); }, 30000);
  for (const [stream, chunks] of [[child.stdout, out], [child.stderr, err]]) {
    stream.on("data", data => { chunks.push(data); size += data.length; if (size > 4 * 1024 * 1024) { failure = Error("Frontend output bound"); child.kill(); } });
    stream.on("error", error => { failure = error; child.kill(); });
  }
  child.on("error", error => { failure = error; });
  child.stdin.on("error", error => { failure = error; });
  if (request) child.stdin.write(JSON.stringify(request) + "\n");
  child.stdin.end();
  const code = await new Promise(resolve => child.once("close", resolve)); clearTimeout(timer);
  onProcess({ type: "exit", pid: child.pid, parentPid: process.pid, exitCode: code, ports: [] });
  if (err.length) console.log(Buffer.concat(err).toString());
  if (failure) throw failure;
  assert.equal(code, 0, Buffer.concat(err).toString());
  return JSON.parse(Buffer.concat(out).toString());
}
async function fixture(t, { nativeFixtureRoot = nativeRoot } = {}) {
  const parent = fs.realpathSync(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const container = fs.mkdtempSync(path.join(parent, "head-local-worker-host-"));
  const root = path.join(container, "project"), installed = path.join(container, "package"), operational = path.join(container, "operational"), home = path.join(container, "home"), bin = path.join(container, "schema");
  for (const directory of [root, installed, operational, home, bin]) fs.mkdirSync(directory);
  // Disposable package, not an install or a mutation of the development/native
  // cache. Default entrypoints resolve their native manifest without injection.
  for (const name of ["scripts", "compat", "package.json", ".codex-plugin"]) fs.cpSync(path.join(pluginRoot, name), path.join(installed, name), { recursive: true });
  fs.cpSync(path.join(nativeFixtureRoot, "dist"), path.join(installed, "dist"), { recursive: true });
  fs.mkdirSync(path.join(installed, "test", "helpers"), { recursive: true });
  fs.copyFileSync(path.join(pluginRoot, "test", "helpers", "codex-proposal-protocol-fixture.mjs"), path.join(installed, "test", "helpers", "codex-proposal-protocol-fixture.mjs"));
  const importLocal = file => import(pathToFileURL(path.join(installed, "scripts", file)).href);
  const host = await importLocal("lib/local-worker-host.mjs"), jobs = await importLocal("lib/bounded-worker-job.mjs");
  const cliModule = await importLocal("head.mjs"), mcpModule = await importLocal("mcp-server.mjs");
  const cli = { ...cliModule, runCommand: async (args, options) => (await cliModule.runCommand(isManagedMutation(args[0]) ? ["managed-maintenance", ...args] : args, options)) };
  const mcp = { ...mcpModule, dispatch: (request, options) => mcpModule.dispatch(request, { ...options, surface: isManagedMutation(request.params?.name) ? "managed-maintenance" : "ordinary" }) };
  const previous = process.env.HEAD_AGENT_OPERATIONAL_STATE_ROOT;
  process.env.HEAD_AGENT_OPERATIONAL_STATE_ROOT = operational;
  const prepared = [];
  t.after(async () => {
    const errors = [];
    for (const member of prepared) {
      try {
        const projectId = JSON.parse(fs.readFileSync(path.join(root, layout.directory, "project.json"))).projectId;
        if (!fs.existsSync(path.join(operational, "worker-jobs", projectId, member.authorizationId, "binding.json"))) continue;
        const input = { root, authorizationId: member.authorizationId };
        let state = jobs.readBoundedWorkerJob(input, { onProcess });
        if (!state.ownerExitObserved && state.status !== "not-started") {
          jobs.cancelBoundedWorkerJob(input, { onProcess });
          const end = Date.now() + 20000;
          while (!state.ownerExitObserved && Date.now() < end) { await pause(); state = jobs.readBoundedWorkerJob(input, { onProcess }); }
          assert.equal(state.ownerExitObserved, true, "Exact owner cleanup before deleting fixture");
        }
      } catch (error) { if (error.code !== "ENOENT") errors.push(error); }
    }
    if (previous === undefined) delete process.env.HEAD_AGENT_OPERATIONAL_STATE_ROOT; else process.env.HEAD_AGENT_OPERATIONAL_STATE_ROOT = previous;
    if (errors.length) throw new AggregateError(errors, `Preserve cleanup evidence at ${container}`);
    assert.equal(path.dirname(container), parent); assert.match(path.basename(container), /^head-local-worker-host-/);
    fs.rmSync(container, { recursive: true, force: true });
  });
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  const layout = formatForVerifiedOwner(storage);
  fs.writeFileSync(path.join(root, "selected.txt"), "selected original\n");
  fs.writeFileSync(path.join(bin, "codex.exe"), "Synthetic schema marker; never executed");
  const environment = { ...process.env, PATH: bin }; delete environment.Path; delete environment.path;
  const backend = host.createLocalWorkerProtocolFixtureBackend({ codexHome: home, environment, spawnImplementation: schemaSpawn });
  return { root, storage, layout, installed, operational, home, host, jobs, cli, mcp, backend, prepared, importLocal,
    input: { task: "Propose selected data change", model: "gpt-5.6-sol", taskKey: "selected-member", sourcePaths: ["selected.txt"], proposalPaths: ["selected.txt"] } };
}
const call = (name, args) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const value = response => { assert.equal(response.error, undefined, JSON.stringify(response)); assert.equal(response.result?.isError, undefined, JSON.stringify(response)); return response.result.structuredContent ?? JSON.parse(response.result.content[0].text); };
test("selected-only global instructions report a scoped limitation without provider discovery or new authority", { skip }, async t => {
  const f = await fixture(t), marker = "Private synthetic global instruction sentinel.\n";
  fs.writeFileSync(path.join(f.home, "AGENTS.md"), marker, { flag: "wx" });
  const snapshot = directory => fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? snapshot(file) : [[path.relative(f.root, file), crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]];
  });
  const before = snapshot(f.root), events = [];
  const { formatCliResult, formatMcpToolContent } = await f.importLocal("lib/cli-presentation.mjs");
  for (const contextMode of ["fresh", "native-prefix"]) {
    const cli = await f.cli.runCommand(["worker-prepare", f.root, "--task", f.input.task, "--model", f.input.model,
      "--task-key", `scope-${contextMode}`, "--source", "selected.txt", "--propose", "selected.txt", "--context", "Synthetic selected text", "--context-mode", contextMode],
    { workerPreparationBackend: f.backend, onProcess: event => events.push(event) });
    const mcp = value(await f.mcp.dispatch(call("head_bounded_worker_prepare", { project_root: f.root, task: f.input.task,
      model: f.input.model, task_key: `scope-${contextMode}`, source_paths: ["selected.txt"], proposal_paths: ["selected.txt"],
      selected_context: "Synthetic selected text", context_mode: contextMode }), { workerPreparationBackend: f.backend, onProcess: event => events.push(event) }));
    assert.deepEqual(cli, mcp);
    assert.equal(cli.status, "unavailable_for_selected_scope");
    assert.equal(cli.reason, "unselected-global-instructions");
    assert.equal(cli.guidance.ordinaryWorkBlocked, false);
    assert.equal(cli.guidance.userActionRequired, false);
    assert.equal(cli.guidance.alternativeCapabilityVerified, false);
    assert.equal(cli.guidance.automaticRetry, false);
    assert.equal(cli.grantsPermission, false); assert.equal(cli.recoveryAuthority, false);
    assert.equal(cli.modelCallAttempted, false); assert.equal(cli.accountInspected, false);
    assert.equal(cli.workersStarted, 0); assert.equal(Object.hasOwn(cli, "authorizationId"), false);
    assert.equal(JSON.stringify(cli).includes(marker.trim()), false);
    const card = formatCliResult("worker-prepare", cli);
    assert.equal(card, formatMcpToolContent("head_bounded_worker_prepare", mcp));
    assert.match(card, /ordinary Host delegation/); assert.match(card, /existing authorized scope/);
    assert.match(card, /not HEAD or the entire provider backend/);
    assert.match(card, /otherwise obtain that specific authorization/);
  }
  assert.deepEqual(events, []); assert.deepEqual(snapshot(f.root), before);
  assert.equal(fs.readFileSync(path.join(f.home, "AGENTS.md"), "utf8"), marker);
  await assert.rejects(f.host.prepareLocalBoundedWorker({ ...f.input, contextMode: "unsupported" }, { root: f.root, protocolFixtureBackend: f.backend }),
    { code: "LOCAL_WORKER_PREPARATION_CONFLICT" });
  fs.writeFileSync(path.join(f.home, "AGENTS.md"), Buffer.alloc(128 * 1024 + 1, 65));
  await assert.rejects(f.host.prepareLocalBoundedWorker(f.input, { root: f.root, protocolFixtureBackend: f.backend }), error => {
    assert.equal(error.code, "CODEX_FRESH_PROPOSAL_POLICY_CONFLICT");
    assert.equal(error.reason, undefined, "Unknown policy/integrity errors must not become a normal availability projection");
    return true;
  });
  assert.deepEqual(snapshot(f.root), before);
});

function prepareInChild(f) {
  // Test-only bootstrap of the fixed schema fixture, not a wire Host override.
  const script = `(async()=>{
    const {pathToFileURL}=await import('node:url'); const path=await import('node:path');
    const {EventEmitter}=await import('node:events'); const schemaSpawn=${schemaSpawn.toString()};
    const [installed,home,root,inputText]=process.argv.slice(1); const input=JSON.parse(inputText);
    const host=await import(pathToFileURL(path.join(installed,'scripts/lib/local-worker-host.mjs')).href);
    const cli=await import(pathToFileURL(path.join(installed,'scripts/head.mjs')).href);
    const environment={...process.env,PATH:path.join(path.dirname(root),'schema')}; delete environment.Path; delete environment.path;
    const backend=host.createLocalWorkerProtocolFixtureBackend({codexHome:home,environment,spawnImplementation:schemaSpawn});
    const result=await cli.runCommand(['managed-maintenance','worker-prepare',root,'--task',input.task,'--model',input.model,'--task-key',input.taskKey,
      '--source',input.sourcePaths.join(','),'--propose',input.proposalPaths.join(',')],{workerPreparationBackend:backend});
    console.log(JSON.stringify(result));
  })().catch(error=>{console.error(error);process.exitCode=1;});`;
  return frontDoor("-e", [script, f.installed, f.home, f.root, JSON.stringify(f.input)], f.root);
}

test("public preparation composes a fixed Host, reuses exact input and rejects Host wire overrides", { skip }, async t => {
  const f = await fixture(t), before = fs.readFileSync(path.join(f.root, f.layout.directory, "sessions/current.json"));
  const first = await f.cli.runCommand(["worker-prepare", f.root, "--task", f.input.task, "--model", f.input.model,
    "--task-key", f.input.taskKey, "--source", "selected.txt", "--propose", "selected.txt"], { workerPreparationBackend: f.backend });
  f.prepared.push(first);
  const repeated = value(await f.mcp.dispatch(call("head_bounded_worker_prepare", { project_root: f.root, task: f.input.task,
    model: f.input.model, task_key: f.input.taskKey, source_paths: ["selected.txt"], proposal_paths: ["selected.txt"] })));
  assert.equal(repeated.status, "reused"); assert.equal(first.authorizationId, repeated.authorizationId);
  assert.equal(first.modelCallAttempted, false); assert.equal(first.workersStarted, 0);
  assert.deepEqual(fs.readFileSync(path.join(f.root, f.layout.directory, "sessions/current.json")), before);
  for (const extra of [{ runnerFile: "evil" }, { executable: "evil" }, { environment: {} }, { enforcement: true }]) {
    const rejected = await f.mcp.dispatch(call("head_bounded_worker_prepare", { project_root: f.root, task: f.input.task, model: f.input.model, ...extra }));
    assert.ok(rejected.error || rejected.result?.isError);
  }
  await assert.rejects(f.host.prepareLocalBoundedWorker({ ...f.input, task: "Divergent meaning" }, { root: f.root }));
});

test("public native-prefix preparation and start bind a controlled two-turn proposal without parent inheritance", { skip }, async t => {
  const f = await fixture(t);
  const context = "Synthetic parser contract: preserve empty fields.";
  const first = await f.cli.runCommand(["worker-prepare", f.root, "--task", f.input.task, "--model", f.input.model,
    "--task-key", f.input.taskKey, "--source", "selected.txt", "--propose", "selected.txt", "--context-mode", "native-prefix", "--context", context],
  { workerPreparationBackend: f.backend });
  f.prepared.push(first);
  assert.deepEqual(first.executionPlan, { maximumModelTurns: 2, durableSeedHistory: true, inheritsParentThread: false,
    automaticFileApplication: false, grantsPermission: false });
  assert.equal(first.contextMode, "native-prefix");
  assert.equal(first.modelCallAttempted, false);
  const repeated = value(await f.mcp.dispatch(call("head_bounded_worker_prepare", { project_root: f.root, task: f.input.task,
    model: f.input.model, task_key: f.input.taskKey, source_paths: ["selected.txt"], proposal_paths: ["selected.txt"],
    context_mode: "native-prefix", selected_context: context })));
  assert.equal(repeated.authorizationId, first.authorizationId);
  await assert.rejects(f.host.prepareLocalBoundedWorker(f.input, { root: f.root }), { code: "LOCAL_WORKER_PREPARATION_CONFLICT" });
  const started = value(await frontDoor(path.join(f.installed, "scripts/mcp-server.mjs"), [], f.root,
    call("head_bounded_worker_start", { project_root: f.root, task_key: first.taskKey })));
  assert.ok(started.status);
  const input = { root: f.root, authorizationId: first.authorizationId };
  let state = f.jobs.readBoundedWorkerJob(input, { onProcess }); const end = Date.now() + 45000;
  while (!state.ownerExitObserved && Date.now() < end) { await pause(); state = f.jobs.readBoundedWorkerJob(input, { onProcess }); }
  assert.equal(state.ownerExitObserved, true);
  state = f.jobs.reconcileBoundedWorkerJob(input, { onProcess });
  assert.equal(state.status, "completed", JSON.stringify(state));
  assert.equal(state.result.actualProviderInvoked, false);
  assert.equal(state.workspacePatch.origin, "provider-patch-proposal");
  assert.equal((await f.cli.runCommand(["worker-start", f.root, "--task-key", first.taskKey])).status, "completed");
  assert.equal(fs.readFileSync(path.join(f.root, "selected.txt"), "utf8"), "selected original\n");
});

test("reviewer source-change regression: same member safely reprepares and concurrent requests converge", { skip }, async t => {
  const f = await fixture(t), options = { root: f.root, protocolFixtureBackend: f.backend };
  const before = fs.readFileSync(path.join(f.root, f.layout.directory, "sessions/current.json"));
  const first = await f.host.prepareLocalBoundedWorker(f.input, options); f.prepared.push(first);
  const lifecycle = await f.importLocal("lib/runtime-invocation-lifecycle.mjs"), leases = await f.importLocal("lib/runtime-execution-lease.mjs");
  const prior = lifecycle.readRuntimeInvocationAuthorization({ root: f.root, authorizationId: first.authorizationId }).authorization;
  assert.equal(leases.inspectRuntimeExecutionLease({ projectRoot: f.root, projectId: prior.projectId, authorizationId: prior.authorizationId }).singleUseConsumed, false);
  fs.writeFileSync(path.join(f.root, "selected.txt"), "legitimate updated source\n");
  const [next, same] = await Promise.all([f.host.prepareLocalBoundedWorker(f.input, options), f.host.prepareLocalBoundedWorker(f.input, options)]);
  f.prepared.push(next);
  assert.notEqual(next.authorizationId, first.authorizationId); assert.equal(next.authorizationId, same.authorizationId);
  const current = lifecycle.reconcileWorkerMember({ root: f.root, taskKey: f.input.taskKey }).authorization;
  assert.equal(current.workerInput.previousAuthorizationId, prior.authorizationId);
  assert.equal(current.workerInput.sourceBasis[0].digest, crypto.createHash("sha256").update("legitimate updated source\n").digest("hex"));
  await assert.rejects(leases.withRuntimeExecutionLease({ projectRoot: f.root, authorization: prior, ownerFenceDigest: "a".repeat(64) }, async () => assert.fail("Old authority cannot execute")), { code: "WORKER_MEMBER_AUTHORIZATION_CONFLICT" });
  assert.deepEqual(fs.readFileSync(path.join(f.root, f.layout.directory, "sessions/current.json")), before);
  assert.equal(fs.existsSync(path.join(f.operational, "worker-jobs")), false);
  // Public lookup must select the new basis, not the first Host record.
  await frontDoor(path.join(f.installed, "scripts/head.mjs"), ["worker-start", f.root, "--task-key", f.input.taskKey], f.root);
  const input = { root: f.root, authorizationId: next.authorizationId }, end = Date.now() + 30000;
  let state = f.jobs.readBoundedWorkerJob(input, { onProcess });
  while (!state.ownerExitObserved && Date.now() < end) { await pause(); state = f.jobs.readBoundedWorkerJob(input, { onProcess }); }
  assert.equal(state.ownerExitObserved, true); assert.equal(f.jobs.reconcileBoundedWorkerJob(input, { onProcess }).status, "completed");
  assert.equal(fs.readFileSync(path.join(f.root, "selected.txt"), "utf8"), "legitimate updated source\n");
});

test("reviewer reselection regression: newly present target can join explicit read evidence for the same task", { skip }, async t => {
  const f = await fixture(t), options = { root: f.root, protocolFixtureBackend: f.backend };
  f.input = { ...f.input, proposalPaths: ["target.txt"] };
  const before = fs.readFileSync(path.join(f.root, f.layout.directory, "sessions/current.json"));
  const first = await f.host.prepareLocalBoundedWorker(f.input, options); f.prepared.push(first);
  const lifecycle = await f.importLocal("lib/runtime-invocation-lifecycle.mjs"), leases = await f.importLocal("lib/runtime-execution-lease.mjs");
  const prior = lifecycle.readRuntimeInvocationAuthorization({ root: f.root, authorizationId: first.authorizationId }).authorization;
  fs.writeFileSync(path.join(f.root, "target.txt"), "user-created current preimage\n");
  await assert.rejects(f.host.prepareLocalBoundedWorker(f.input, options), { code: "INVALID_WORKER_PATCH_PROPOSAL" });
  f.input = { ...f.input, sourcePaths: ["selected.txt", "target.txt"] };
  const [next, repeated] = await Promise.all([prepareInChild(f), prepareInChild(f)]); f.prepared.push(next);
  assert.notEqual(next.authorizationId, first.authorizationId); assert.equal(next.authorizationId, repeated.authorizationId);
  const current = lifecycle.reconcileWorkerMember({ root: f.root, taskKey: f.input.taskKey }).authorization;
  assert.equal(current.workerInput.previousAuthorizationId, first.authorizationId);
  assert.deepEqual(current.workerInput.sourceBasis.map(entry => entry.path), f.input.sourcePaths);
  assert.deepEqual(current.workerInput.proposalBasis.map(entry => entry.path), ["target.txt"]);
  await assert.rejects(leases.withRuntimeExecutionLease({ projectRoot: f.root, authorization: prior, ownerFenceDigest: "e".repeat(64) },
    async () => assert.fail("Superseded authorization cannot execute")), { code: "WORKER_MEMBER_AUTHORIZATION_CONFLICT" });
  for (const change of [{ task: "different task" }, { model: "gpt-5.5" }, { proposalPaths: ["selected.txt", "target.txt"] },
    { instructionScope: "host-global" }, { selectedContext: "different task instruction" }]) {
    await assert.rejects(f.host.prepareLocalBoundedWorker({ ...f.input, ...change }, options), { code: "LOCAL_WORKER_PREPARATION_CONFLICT" });
  }
  assert.equal(fs.readFileSync(path.join(f.root, "target.txt"), "utf8"), "user-created current preimage\n");
  assert.deepEqual(fs.readFileSync(path.join(f.root, f.layout.directory, "sessions/current.json")), before);
  // Exercise default public lookup of the reselected Host record, not a custom Host.
  await frontDoor(path.join(f.installed, "scripts/head.mjs"), ["worker-start", f.root, "--task-key", f.input.taskKey], f.root);
  const input = { root: f.root, authorizationId: next.authorizationId }, end = Date.now() + 30000;
  let state = f.jobs.readBoundedWorkerJob(input, { onProcess });
  while (!state.ownerExitObserved && Date.now() < end) { await pause(); state = f.jobs.readBoundedWorkerJob(input, { onProcess }); }
  assert.equal(state.ownerExitObserved, true); assert.equal(f.jobs.reconcileBoundedWorkerJob(input, { onProcess }).status, "completed");
  assert.equal(fs.readFileSync(path.join(f.root, "target.txt"), "utf8"), "user-created current preimage\n");
  assert.deepEqual(fs.readFileSync(path.join(f.root, f.layout.directory, "sessions/current.json")), before);
});

test("reviewer publication regression: exact interrupted pending link recovers without authority changes", { skip }, async t => {
  const f = await fixture(t), original = fs.unlinkSync;
  const before = fs.readFileSync(path.join(f.root, f.layout.directory, "sessions/current.json"));
  let pending;
  fs.unlinkSync = function(file, ...args) {
    if (!pending && path.basename(String(file)) === "preparation.json") { pending = file; throw Object.assign(new Error("Synthetic post-link interruption"), { code: "EIO" }); }
    return original.call(this, file, ...args);
  };
  try { await assert.rejects(f.host.prepareLocalBoundedWorker(f.input, { root: f.root, protocolFixtureBackend: f.backend }), { code: "EIO" }); }
  finally { fs.unlinkSync = original; }
  assert.ok(pending); assert.equal(fs.statSync(pending).nlink, 2);
  const [recovered, concurrent] = await Promise.all([prepareInChild(f), prepareInChild(f)]); f.prepared.push(recovered);
  assert.equal(concurrent.authorizationId, recovered.authorizationId);
  assert.equal(fs.existsSync(pending), false);
  const repeated = await f.host.prepareLocalBoundedWorker(f.input, { root: f.root });
  assert.equal(repeated.authorizationId, recovered.authorizationId);
  assert.deepEqual(fs.readFileSync(path.join(f.root, f.layout.directory, "sessions/current.json")), before);
  assert.equal(fs.existsSync(path.join(f.operational, "worker-jobs")), false);
});

test("read reselection recovers publication and revisiting an old selection links a new unconsumed successor", { skip }, async t => {
  const f = await fixture(t), options = { root: f.root, protocolFixtureBackend: f.backend };
  const before = fs.readFileSync(path.join(f.root, f.layout.directory, "sessions/current.json"));
  const first = await f.host.prepareLocalBoundedWorker(f.input, options); f.prepared.push(first);
  fs.writeFileSync(path.join(f.root, "extra.txt"), "explicit auxiliary evidence\n");
  f.input = { ...f.input, sourcePaths: ["extra.txt", "selected.txt"] };
  const original = fs.unlinkSync; let pending;
  fs.unlinkSync = function(file, ...args) {
    if (!pending && path.basename(String(file)) === "preparation.json") {
      pending = file; throw Object.assign(new Error("Synthetic reselection publication interruption"), { code: "EIO" });
    }
    return original.call(this, file, ...args);
  };
  try { await assert.rejects(f.host.prepareLocalBoundedWorker(f.input, options), { code: "EIO" }); }
  finally { fs.unlinkSync = original; }
  const [next, same] = await Promise.all([prepareInChild(f), prepareInChild(f)]); f.prepared.push(next);
  assert.equal(next.authorizationId, same.authorizationId); assert.equal(fs.existsSync(pending), false);
  f.input = { ...f.input, sourcePaths: ["selected.txt"] };
  const revisited = await f.host.prepareLocalBoundedWorker(f.input, options); f.prepared.push(revisited);
  assert.notEqual(revisited.authorizationId, first.authorizationId); assert.notEqual(revisited.authorizationId, next.authorizationId);
  const lifecycle = await f.importLocal("lib/runtime-invocation-lifecycle.mjs"), leases = await f.importLocal("lib/runtime-execution-lease.mjs");
  assert.equal(lifecycle.reconcileWorkerMember({ root: f.root, taskKey: f.input.taskKey }).authorization.workerInput.previousAuthorizationId, next.authorizationId);
  assert.equal((await f.host.prepareLocalBoundedWorker(f.input, options)).authorizationId, revisited.authorizationId);
  for (const member of [first, next]) {
    const authorization = lifecycle.readRuntimeInvocationAuthorization({ root: f.root, authorizationId: member.authorizationId }).authorization;
    await assert.rejects(leases.withRuntimeExecutionLease({ projectRoot: f.root, authorization, ownerFenceDigest: "f".repeat(64) },
      async () => assert.fail("Historical selection is not a reusable authority")), { code: "WORKER_MEMBER_AUTHORIZATION_CONFLICT" });
  }
  assert.deepEqual(fs.readFileSync(path.join(f.root, f.layout.directory, "sessions/current.json")), before);
  assert.equal(fs.existsSync(path.join(f.operational, "worker-jobs")), false);
});

test("two independent public preparation processes converge after a source revision", { skip }, async t => {
  const f = await fixture(t);
  const first = await f.host.prepareLocalBoundedWorker(f.input, { root: f.root, protocolFixtureBackend: f.backend }); f.prepared.push(first);
  fs.writeFileSync(path.join(f.root, "selected.txt"), "new process-shared basis\n");
  const [a, b] = await Promise.all([prepareInChild(f), prepareInChild(f)]); f.prepared.push(a);
  assert.equal(a.authorizationId, b.authorizationId); assert.notEqual(a.authorizationId, first.authorizationId);
  assert.equal(fs.existsSync(path.join(f.operational, "worker-jobs")), false);
});

test("public preparation recovers a proven dead unconsumed owner without changing task identity", { skip }, async t => {
  const f = await fixture(t), options = { root: f.root, protocolFixtureBackend: f.backend };
  const first = await f.host.prepareLocalBoundedWorker(f.input, options); f.prepared.push(first);
  const lifecycle = await f.importLocal("lib/runtime-invocation-lifecycle.mjs");
  const authorization = lifecycle.readRuntimeInvocationAuthorization({ root: f.root, authorizationId: first.authorizationId }).authorization;
  const moduleUrl = pathToFileURL(path.join(f.installed, "scripts/lib/runtime-execution-lease.mjs")).href;
  const script = `const {withRuntimeExecutionLease,createRuntimePreConsumeGateCapability}=await import(process.argv[1]);
    process.on('message',message=>{if(message==='exit')process.exit(0);});
    const preConsumeGate=createRuntimePreConsumeGateCapability(async()=>{process.send({claimed:true});await new Promise(()=>{});});
    await withRuntimeExecutionLease({projectRoot:process.argv[2],authorization:JSON.parse(process.argv[3]),ownerFenceDigest:'${"c".repeat(64)}'},async()=>{}, {preConsumeGate});`;
  const args = ["--input-type=module", "-e", script, moduleUrl, f.root, JSON.stringify(authorization)];
  onProcess({ type: "planned", command: process.execPath, args, parentPid: process.pid, cwd: f.root, ports: [] });
  const child = spawn(process.execPath, args, { cwd: f.root, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  onProcess({ type: "spawn", pid: child.pid, parentPid: process.pid, cwd: f.root, ports: [] });
  let stderr = ""; child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-2048); });
  const closed = new Promise(resolve => child.once("close", code => { onProcess({ type: "exit", pid: child.pid, exitCode: code, cwd: f.root, ports: [] }); resolve(); }));
  const stop = async () => {
    if (child.connected) child.send("exit");
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); }, 3000);
    try { await closed; } finally { clearTimeout(timer); }
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`No claim: ${stderr}`)), 5000);
      child.once("message", message => { clearTimeout(timer); message.claimed ? resolve() : reject(Error("Invalid claim")); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", () => { clearTimeout(timer); reject(Error(`Closed before claim: ${stderr}`)); });
    });
    fs.writeFileSync(path.join(f.root, "selected.txt"), "changed while actual owner held\n");
    await assert.rejects(f.host.prepareLocalBoundedWorker(f.input, options), { code: "WORKER_MEMBER_AUTHORIZATION_CONFLICT" });
    await stop(); assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    const next = await f.host.prepareLocalBoundedWorker(f.input, options); f.prepared.push(next);
    assert.equal(lifecycle.reconcileWorkerMember({ root: f.root, taskKey: f.input.taskKey }).authorization.workerInput.previousAuthorizationId, first.authorizationId);
    assert.notEqual(next.authorizationId, first.authorizationId);
  } finally { await stop(); }
  assert.equal(fs.existsSync(path.join(f.operational, "worker-jobs")), false);
});

test("publication recovery never removes an unknown hardlink", { skip }, async t => {
  const f = await fixture(t);
  const prepared = await f.host.prepareLocalBoundedWorker(f.input, { root: f.root, protocolFixtureBackend: f.backend }); f.prepared.push(prepared);
  const projectId = JSON.parse(fs.readFileSync(path.join(f.root, f.layout.directory, "project.json"))).projectId;
  const directory = path.join(f.operational, "worker-preparations", projectId);
  const file = path.join(directory, fs.readdirSync(directory).find(name => name.endsWith(".json")));
  const unknown = path.join(f.home, "unknown-link.json"); fs.linkSync(file, unknown);
  await assert.rejects(f.host.prepareLocalBoundedWorker(f.input, { root: f.root }));
  assert.equal(fs.statSync(file).nlink, 2); assert.equal(fs.existsSync(unknown), true);
});

test("public reprepare uses existing verified never-started evidence for a changed basis", { skip }, async t => {
  const f = await fixture(t), options = { root: f.root, protocolFixtureBackend: f.backend };
  const first = await f.host.prepareLocalBoundedWorker(f.input, options); f.prepared.push(first);
  const lifecycle = await f.importLocal("lib/runtime-invocation-lifecycle.mjs");
  const prior = lifecycle.readRuntimeInvocationAuthorization({ root: f.root, authorizationId: first.authorizationId }).authorization;
  await assert.rejects(lifecycle.runRuntimeLifecycleConformance({ root: f.root, authorization: prior,
    spawnImplementation: () => { throw Object.assign(Error("Synthetic no-child spawn failure"), { code: "EAGAIN" }); } }), { code: "RUNTIME_CONFORMANCE_SPAWN_FAILED" });
  fs.writeFileSync(path.join(f.root, "selected.txt"), "updated after verified pre-start failure\n");
  const next = await f.host.prepareLocalBoundedWorker(f.input, options); f.prepared.push(next);
  assert.notEqual(next.authorizationId, first.authorizationId);
  assert.equal(lifecycle.reconcileWorkerMember({ root: f.root, taskKey: f.input.taskKey }).authorization.workerInput.previousAuthorizationId, first.authorizationId);
  assert.equal((await f.host.prepareLocalBoundedWorker(f.input, options)).authorizationId, next.authorizationId);
  assert.equal(fs.existsSync(path.join(f.operational, "worker-jobs")), false);
});

for (const reselect of [false, true]) for (const phase of ["claimed", "consumed"]) test(`public ${reselect ? "read reselection" : "reprepare"} cannot bypass ${phase} live ownership or unknown consumed outcome`, { skip }, async t => {
  const f = await fixture(t), options = { root: f.root, protocolFixtureBackend: f.backend };
  const first = await f.host.prepareLocalBoundedWorker(f.input, options); f.prepared.push(first);
  const lifecycle = await f.importLocal("lib/runtime-invocation-lifecycle.mjs"), leases = await f.importLocal("lib/runtime-execution-lease.mjs");
  const authorization = lifecycle.readRuntimeInvocationAuthorization({ root: f.root, authorizationId: first.authorizationId }).authorization;
  let ready, release;
  const reached = new Promise(resolve => { ready = resolve; }), held = new Promise(resolve => { release = resolve; });
  const hold = async () => { ready(); await held; throw new Error("Synthetic unknown outcome"); };
  const pending = leases.withRuntimeExecutionLease({ projectRoot: f.root, authorization, ownerFenceDigest: "b".repeat(64) },
    phase === "consumed" ? hold : async () => {}, phase === "claimed" ? { preConsumeGate: leases.createRuntimePreConsumeGateCapability(hold) } : {});
  const settled = pending.catch(error => error);
  try {
    await reached;
    fs.writeFileSync(path.join(f.root, "selected.txt"), "changed while owned\n");
    if (reselect) {
      fs.writeFileSync(path.join(f.root, "extra.txt"), "explicit new read evidence\n");
      f.input = { ...f.input, sourcePaths: ["extra.txt", "selected.txt"] };
    }
    await assert.rejects(f.host.prepareLocalBoundedWorker(f.input, options), { code: "WORKER_MEMBER_AUTHORIZATION_CONFLICT" });
    assert.equal(lifecycle.reconcileWorkerMember({ root: f.root, taskKey: f.input.taskKey }).authorization.authorizationId, first.authorizationId);
  } finally { release(); await settled; }
  if (phase === "consumed") await assert.rejects(f.host.prepareLocalBoundedWorker(f.input, options), { code: "WORKER_MEMBER_AUTHORIZATION_CONFLICT" });
  else {
    const next = await f.host.prepareLocalBoundedWorker(f.input, options); f.prepared.push(next);
    assert.notEqual(next.authorizationId, first.authorizationId);
  }
  assert.equal(fs.existsSync(path.join(f.operational, "worker-jobs")), false);
});

test("default shipped CLI and stdio MCP start prepared workers without injected job Hosts", { skip }, async t => {
  const f = await fixture(t);
  for (const taskKey of ["cli-member", "mcp-member"]) f.prepared.push(await f.host.prepareLocalBoundedWorker({ ...f.input, taskKey }, { root: f.root, protocolFixtureBackend: f.backend }));
  const [cli, mcp] = await Promise.all([
    frontDoor(path.join(f.installed, "scripts/head.mjs"), ["worker-start", f.root, "--task-key", "cli-member"], f.root),
    frontDoor(path.join(f.installed, "scripts/mcp-server.mjs"), [], f.root,
      call("head_bounded_worker_start", { project_root: f.root, task_key: "mcp-member" })),
  ]);
  assert.ok(cli.status); assert.ok(value(mcp).status);
  for (const member of f.prepared) {
    const input = { root: f.root, authorizationId: member.authorizationId };
    let state = f.jobs.readBoundedWorkerJob(input, { onProcess }); const end = Date.now() + 45000;
    while (!state.ownerExitObserved && Date.now() < end) { await pause(); state = f.jobs.readBoundedWorkerJob(input, { onProcess }); }
    assert.equal(state.ownerExitObserved, true);
    state = f.jobs.reconcileBoundedWorkerJob(input, { onProcess });
    assert.equal(state.status, "completed"); assert.equal(state.result.actualProviderInvoked, false);
    assert.equal(state.workspacePatch.origin, "provider-patch-proposal");
    // An already launched job does not need the prepare-only cache to be read.
    const projectId = JSON.parse(fs.readFileSync(path.join(f.root, f.layout.directory, "project.json"))).projectId;
    const prepDirectory = path.join(f.operational, "worker-preparations", projectId);
    for (const entry of fs.readdirSync(prepDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const file = path.join(prepDirectory, entry.name);
      if (JSON.parse(fs.readFileSync(file)).request.taskKey === member.taskKey) fs.unlinkSync(file);
    }
    const repeated = await f.cli.runCommand(["worker-start", f.root, "--task-key", member.taskKey]);
    assert.equal(repeated.status, "completed");
  }
  assert.equal(fs.readFileSync(path.join(f.root, "selected.txt"), "utf8"), "selected original\n");
});

test("public preparation uses an existing Run without creating or widening its contract", { skip }, async t => {
  const f = await fixture(t);
  const capsule = (await compileContext({ root: f.root, task: f.input.task, persist: true })).capsule;
  const plan = createWholePlanSnapshot({ root: f.root, objective: f.input.task, plan: [{ id: "proposal", outcome: "Evidence only" }] }).artifact;
  const contract = createExecutionContract({ root: f.root, wholePlanId: plan.wholePlanId, capsuleId: capsule.capsuleId,
    scope: "Synthetic proposal", acceptanceCriteria: ["No worker writes"], allowedActions: ["runtime.invoke", "project.read"] }).artifact;
  const run = startRun({ root: f.root, executionContractId: contract.executionContractId }).run;
  const sessionBefore = fs.readFileSync(path.join(f.root, f.layout.directory, "sessions/current.json"));
  const prepared = await f.host.prepareLocalBoundedWorker(f.input, { root: f.root, protocolFixtureBackend: f.backend }); f.prepared.push(prepared);
  const authorization = JSON.parse(fs.readFileSync(path.join(f.root, f.layout.directory, "runtime/execution-authorizations", prepared.authorizationId + ".json")));
  assert.equal(authorization.scope.runId, run.runId); assert.equal(authorization.scope.executionContractId, contract.executionContractId);
  assert.equal(authorization.workspaceMode, "read-only"); assert.deepEqual(authorization.workerInput.executionBoundary.ownedPaths, []);
  assert.deepEqual(fs.readFileSync(path.join(f.root, f.layout.directory, "sessions/current.json")), sessionBefore);
});

async function twoRunMembers(t, secondKey = "second-member", fixtureOptions = {}, firstKey = "first-member") {
  const f = await fixture(t, fixtureOptions);
  fs.writeFileSync(path.join(f.root, "other.txt"), "other original\n");
  const capsule = (await compileContext({ root: f.root, task: f.input.task, persist: true })).capsule;
  const plan = createWholePlanSnapshot({ root: f.root, objective: f.input.task,
    plan: [{ id: "proposals", outcome: "HEAD inspects two independent proposals" }] }).artifact;
  const contract = createExecutionContract({ root: f.root, wholePlanId: plan.wholePlanId, capsuleId: capsule.capsuleId,
    scope: "Synthetic two-file integration", acceptanceCriteria: ["HEAD applies exact proposals; workers never write"],
    allowedActions: ["runtime.invoke", "project.read", "project.write"] }).artifact;
  const run = startRun({ root: f.root, executionContractId: contract.executionContractId }).run;
  for (const [taskKey, file] of [[firstKey, "selected.txt"], [secondKey, "other.txt"]]) {
    f.prepared.push(value(await f.mcp.dispatch(call("head_bounded_worker_prepare", {
      project_root: f.root, task: f.input.task, model: f.input.model, task_key: taskKey,
      source_paths: [file], proposal_paths: [file],
    }), { workerPreparationBackend: f.backend })));
  }
  f.pointers = () => [fs.readFileSync(path.join(f.root, f.layout.directory, "sessions/current.json")),
    fs.readFileSync(path.join(f.root, f.layout.directory, "sessions/runs", run.runId, "run.json"))];
  f.publicMcp = async (name, args = {}) => value(await frontDoor(path.join(f.installed, "scripts/mcp-server.mjs"), [], f.root,
    call(name, { project_root: f.root, ...args })));
  f.publicCli = args => frontDoor(path.join(f.installed, "scripts/head.mjs"), [args[0], f.root, ...args.slice(1), "--json"], f.root);
  f.closed = async member => {
    const input = { root: f.root, authorizationId: member.authorizationId }, end = Date.now() + 30000;
    let state = f.jobs.readBoundedWorkerJob(input, { onProcess });
    while (!state.ownerExitObserved && Date.now() < end) { await pause(); state = f.jobs.readBoundedWorkerJob(input, { onProcess }); }
    assert.equal(state.ownerExitObserved, true, "Exact native owner exits before reconciliation");
    return f.jobs.reconcileBoundedWorkerJob(input, { onProcess });
  };
  return f;
}

test("public fresh proposal turns really overlap with distinct identities and replay cannot exceed the two-worker limit", { skip }, async t => {
  const f = await twoRunMembers(t, "fixture-overlap-right", {}, "fixture-overlap-left"), before = f.pointers();
  const projectId = JSON.parse(fs.readFileSync(path.join(f.root, f.layout.directory, "project.json"))).projectId;
  const spools = f.prepared.map(member => path.join(f.operational, "runtime-output", projectId, member.authorizationId, "stderr.bin"));
  const events = file => {
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, "utf8");
    return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(JSON.parse).filter(event => event.fixtureEvent?.startsWith("overlap-turn-"));
  };
  const releaseFile = path.join(f.home, "fixture-overlap.release");
  try {
    await Promise.all([
      f.publicCli(["worker-start", "--task-key", f.prepared[0].taskKey]),
      f.publicMcp("head_bounded_worker_start", { task_key: f.prepared[1].taskKey }),
    ]);
    const deadline = Date.now() + 15000;
    while (spools.some(file => !events(file).length) && Date.now() < deadline) await pause();
    const starts = spools.map(file => events(file));
    for (const list of starts) { assert.equal(list.length, 1); assert.equal(list[0].fixtureEvent, "overlap-turn-start"); }
    assert.notEqual(starts[0][0].pid, starts[1][0].pid);
    for (const list of starts) assert.doesNotThrow(() => process.kill(list[0].pid, 0));
    assert.notEqual(f.prepared[0].authorizationId, f.prepared[1].authorizationId);
    const consumed = f.prepared.map(member => fs.readFileSync(path.join(f.root, f.layout.directory, "runtime/execution-leases", member.authorizationId, "consumption.json")));
    assert.notDeepEqual(consumed[0], consumed[1]);
    // Repeated public calls while both provider turns are executing must not
    // start a third provider. Two is this test's approved launch budget, not an
    // invented global scheduler/admission limit in the product.
    for (const member of f.prepared) await Promise.all([
      f.publicCli(["worker-start", "--task-key", member.taskKey]),
      f.publicMcp("head_bounded_worker_start", { task_key: member.taskKey }),
    ]);
    for (const file of spools) assert.equal(events(file).length, 1);
    fs.writeFileSync(releaseFile, "both real turns observed\n", { flag: "wx" });
    for (const member of f.prepared) assert.equal((await f.closed(member)).status, "completed");
    const intervals = spools.map((file, index) => {
      const observed = events(file); assert.equal(observed.length, 2);
      assert.equal(observed[0].fixtureEvent, "overlap-turn-start"); assert.equal(observed[1].fixtureEvent, "overlap-turn-end");
      assert.equal(observed[0].pid, observed[1].pid); assert.equal(observed[0].taskKey, f.prepared[index].taskKey);
      const start = BigInt(observed[0].monotonicNs), end = BigInt(observed[1].monotonicNs); assert.ok(end > start);
      return { authorizationId: f.prepared[index].authorizationId, providerPid: observed[0].pid, taskKey: observed[0].taskKey,
        qualifiedTurn: [observed[0].pid, observed[0].threadId, observed[0].turnId], start, end };
    });
    const latestStart = intervals.reduce((max, x) => x.start > max ? x.start : max, 0n);
    const earliestEnd = intervals.reduce((min, x) => x.end < min ? x.end : min, intervals[0].end);
    assert.ok(earliestEnd > latestStart, "Actual provider turn intervals, not just owner lifetimes, overlap");
    let active = 0, peak = 0;
    const timeline = intervals.flatMap(x => [{ at: x.start, change: 1 }, { at: x.end, change: -1 }])
      .sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.change - b.change);
    for (const event of timeline) { active += event.change; peak = Math.max(peak, active); assert.ok(active >= 0 && active <= 2); }
    assert.equal(peak, 2); assert.equal(active, 0);
    const frozen = spools.map(file => fs.readFileSync(file));
    for (const member of f.prepared) assert.equal((await f.publicMcp("head_bounded_worker_start", { task_key: member.taskKey })).status, "completed");
    assert.deepEqual(spools.map(file => fs.readFileSync(file)), frozen);
    assert.deepEqual(f.prepared.map(member => fs.readFileSync(path.join(f.root, f.layout.directory, "runtime/execution-leases", member.authorizationId, "consumption.json"))), consumed);
    assert.deepEqual(f.pointers(), before);
    console.log(JSON.stringify({ event: "public-fresh-provider-turn-overlap", actualProviderInvoked: false, launchLimit: 2, peak,
      intervals: intervals.map(x => ({ ...x, start: x.start.toString(), end: x.end.toString() })), overlapNs: (earliestEnd - latestStart).toString() }));
  } finally {
    if (!fs.existsSync(releaseFile)) fs.writeFileSync(releaseFile, "test cleanup\n", { flag: "wx" });
  }
});

test("public partial launch stays open and can be abandoned without success or P2 promotion", { skip }, async t => {
  const f = await twoRunMembers(t), before = f.pointers();
  for (const member of f.prepared) await f.cli.runCommand(["worker-dispatch", f.root, "--authorization", member.authorizationId, "--role", "coder"]);
  const created = await f.publicMcp("head_bounded_worker_wave_create", { authorization_ids: f.prepared.map(m => m.authorizationId) });
  const wave_id = created.wave.waveId;
  await f.publicCli(["worker-start", "--task-key", "first-member"]);
  fs.writeFileSync(path.join(f.root, "other.txt"), "source changed before second launch\n");
  await assert.rejects((f.cli.runCommand(["worker-start", f.root, "--task-key", "second-member"])));
  assert.equal((await f.closed(f.prepared[0])).status, "completed");
  const status = await f.publicMcp("head_bounded_worker_wave_status", { wave_id });
  assert.equal(status.projection.state, "open");
  assert.equal(status.projection.counts.requested, 2); assert.equal(status.projection.counts.started, 1);
  assert.equal(status.projection.counts.returned, 1); assert.equal(status.projection.sealId, null);
  assert.equal(status.projection.guidance.aggregateAvailable, false);
  assert.equal(status.projection.guidance.ordinaryWorkBlocked, false);
  assert.equal(status.projection.guidance.abandonCancelsMembers, false);
  for (const name of ["head_bounded_worker_wave_seal", "head_bounded_worker_wave_wait", "head_bounded_worker_wave_results"]) {
    const rejected = await f.mcp.dispatch(call(name, { project_root: f.root, wave_id }));
    assert.ok(rejected.error || rejected.result?.isError, `${name} cannot promote partial launch`);
  }
  const abandonment = { wave_id, reason_code: "partial-launch", reason_summary: "Second source changed before launch; no completion claimed." };
  assert.equal((await f.publicMcp("head_bounded_worker_wave_abandon", abandonment)).status, "abandoned");
  assert.equal((await f.publicMcp("head_bounded_worker_wave_abandon", abandonment)).status, "existing");
  assert.equal((await f.publicMcp("head_bounded_worker_wave_status", { wave_id })).projection.state, "abandoned");
  const leases = await f.importLocal("lib/runtime-execution-lease.mjs");
  const authorization = JSON.parse(fs.readFileSync(path.join(f.root, f.layout.directory, "runtime/execution-authorizations", f.prepared[1].authorizationId + ".json")));
  assert.equal(leases.inspectRuntimeExecutionLease({ projectRoot: f.root, projectId: authorization.projectId,
    authorizationId: authorization.authorizationId }).singleUseConsumed, false);
  assert.deepEqual(f.pointers(), before);
});

test("fresh public frontends restore HEAD direction and rediscover completed and pending workers without relaunch", { skip }, async t => {
  const f = await twoRunMembers(t, "fixture-hold-until-cancel");
  const direction = "HEAD inspects both proposals; worker status never supplies recovery direction";
  await f.publicCli(["checkpoint", "--summary", "Synthetic HEAD-owned recovery point", "--next", direction]);
  const before = f.pointers();
  await Promise.all(f.prepared.map(member => f.publicCli(["worker-start", "--task-key", member.taskKey])));
  assert.equal((await f.closed(f.prepared[0])).status, "completed");
  const held = f.prepared[1], authorization_id = held.authorizationId;
  const pending = await f.publicMcp("head_bounded_worker_job_status", { authorization_id });
  assert.equal(pending.ownerExitObserved, false);
  const leases = await f.importLocal("lib/runtime-execution-lease.mjs");
  const authorization = JSON.parse(fs.readFileSync(path.join(f.root, f.layout.directory, "runtime/execution-authorizations", authorization_id + ".json")));
  const lease = () => leases.inspectRuntimeExecutionLease({ projectRoot: f.root, projectId: authorization.projectId, authorizationId: authorization_id });
  assert.equal(lease().singleUseConsumed, true);
  for (const restored of [await f.publicCli(["session-restore"]), await f.publicMcp("head_session_restore")]) {
    assert.equal(restored.projection.consumerInstruction.historicalCheckpointContext.nextExpectedResult, direction);
  }
  assert.equal((await f.publicMcp("head_bounded_worker_job_status", { authorization_id: f.prepared[0].authorizationId })).status, "completed");
  const rediscovered = await f.publicMcp("head_bounded_worker_reconcile", { task_key: held.taskKey });
  assert.equal(rediscovered.authorization.authorizationId, authorization_id);
  await f.publicCli(["worker-cancel", "--authorization", authorization_id]);
  const closed = await f.closed(held); assert.notEqual(closed.status, "completed");
  const replay = await f.publicCli(["worker-start", "--task-key", held.taskKey]);
  assert.equal(replay.status, closed.status); assert.equal(replay.ownerExitObserved, true);
  assert.equal(lease().singleUseConsumed, true); assert.deepEqual(f.pointers(), before);
});

test("public consumed owner crash stays unknown without relaunch and preserves a completed sibling", {
  skip: skip || !process.env.HEAD_AGENT_TEST_OWNER_CRASH_FIXTURE ? "Explicit Windows exact-owner crash fixture not supplied" : false,
}, async t => {
  const f = await twoRunMembers(t, "fixture-hold-until-cancel"), before = f.pointers();
  await Promise.all(f.prepared.map(member => f.publicCli(["worker-start", "--task-key", member.taskKey])));
  assert.equal((await f.closed(f.prepared[0])).status, "completed");
  const held = f.prepared[1], authorization_id = held.authorizationId;
  const authorization = JSON.parse(fs.readFileSync(path.join(f.root, f.layout.directory, "runtime/execution-authorizations", authorization_id + ".json")));
  const directory = path.join(f.operational, "worker-jobs", authorization.projectId, authorization_id);
  const requestFile = path.join(directory, "request.json"), claimFile = path.join(directory, "claim.json");
  const claimBytes = fs.readFileSync(claimFile), claim = JSON.parse(claimBytes);
  const spoolFile = path.join(f.operational, "runtime-output", authorization.projectId, authorization_id, "stderr.bin");
  const deadline = Date.now() + 15000;
  let markers = [];
  while (!markers.length && Date.now() < deadline) {
    try { markers = fs.readFileSync(spoolFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(event => event.fixtureEvent === "held-turn-started"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!markers.length) await pause();
  }
  assert.equal(markers.length, 1, "Observed one real synthetic provider turn before crash");
  const leases = await f.importLocal("lib/runtime-execution-lease.mjs");
  const lease = () => leases.inspectRuntimeExecutionLease({ projectRoot: f.root, projectId: authorization.projectId, authorizationId: authorization_id });
  assert.equal(lease().singleUseConsumed, true); assert.equal(fs.existsSync(path.join(directory, "terminal.json")), false);
  const consumption = fs.readFileSync(path.join(f.root, f.layout.directory, "runtime/execution-leases", authorization_id, "consumption.json"));
  const helper = process.env.HEAD_AGENT_TEST_OWNER_CRASH_FIXTURE;
  // A mismatched generation must not reach termination, even for this owned PID.
  const refused = await frontDoor("crash", [requestFile, "windows-filetime-0000000000000000"], f.root, null, process.env, helper);
  assert.equal(refused.status, "generation-mismatch"); assert.equal(refused.terminationAttempted, false);
  // Deterministically model a retained old PID generation without modifying
  // the live job or trying to force OS PID reuse. Both probes must preserve it.
  const staleDirectory = path.join(f.home, "stale-generation-observation"); fs.mkdirSync(staleDirectory);
  const staleRequest = path.join(staleDirectory, "request.json");
  fs.copyFileSync(requestFile, staleRequest);
  const staleToken = "windows-filetime-0000000000000000";
  fs.writeFileSync(path.join(staleDirectory, "claim.json"), JSON.stringify({ ...claim, ownerToken: staleToken }));
  const reused = await frontDoor("crash", [staleRequest, staleToken], f.root, null, process.env, helper);
  assert.equal(reused.status, "reused"); assert.equal(reused.terminationAttempted, false);
  const supervisor = path.join(f.installed, "dist/windows-x64/head-agent-supervisor.exe");
  const inspectedReuse = await frontDoor("--job-state", [staleRequest], f.root, null, process.env, supervisor);
  assert.equal(inspectedReuse.ownerState, "reused");
  assert.equal((await frontDoor("inspect", [requestFile, claim.ownerToken], f.root, null, process.env, helper)).status, "present");
  const innerControl = path.join(f.operational, "runtime-fresh-proposals", authorization.projectId, authorization_id, "supervisor-control.jsonl");
  const outerEvents = fs.readFileSync(path.join(directory, "control.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const childPid = outerEvents.find(event => event.type === "provider.started").providerPid;
  const innerEvents = fs.readFileSync(innerControl, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(innerEvents.find(event => event.type === "provider.started").providerPid, markers[0].pid);
  assert.notEqual(markers[0].parentPid, childPid, "Nested native supervisor owns the provider fixture");
  const ownedPids = [claim.pid, childPid, markers[0].parentPid, markers[0].pid];
  onProcess({ type: "planned-crash", pid: claim.pid, ownerToken: claim.ownerToken, ownedPids,
    command: path.join(f.installed, "dist/windows-x64/head-agent-supervisor.exe"), cwd: f.root, ports: [],
    reason: "Deliberate post-consumption, pre-terminal fault; not ordinary cleanup" });
  const crashed = await frontDoor("crash", [requestFile, claim.ownerToken], f.root, null, process.env, helper);
  assert.equal(crashed.status, "crash-injected"); assert.equal(crashed.terminationAttempted, true);
  const end = Date.now() + 15000;
  const live = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
  while (ownedPids.some(live) && Date.now() < end) await pause();
  for (const pid of ownedPids) assert.equal(live(pid), false, `Exact owned PID ${pid} exited after kernel cleanup`);
  onProcess({ type: "crash-tree-exited", ownedPids, ownerToken: claim.ownerToken, cwd: f.root, ports: [], cleanupVerified: true });
  const stderrBefore = fs.readFileSync(spoolFile);
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const name of ["head_bounded_worker_job_status", "head_bounded_worker_job_reconcile", "head_bounded_worker_start"]) {
      const state = await f.publicMcp(name, name === "head_bounded_worker_start" ? { task_key: held.taskKey } : { authorization_id });
      assert.equal(state.status, "unknown"); assert.equal(state.result, null); assert.equal(state.replayAllowed, false);
      assert.equal(state.ownerExitObserved, true);
    }
    assert.equal((await f.publicCli(["worker-start", "--task-key", held.taskKey])).status, "unknown");
  }
  assert.equal(fs.existsSync(path.join(directory, "terminal.json")), false);
  assert.deepEqual(fs.readFileSync(claimFile), claimBytes); assert.deepEqual(fs.readFileSync(spoolFile), stderrBefore);
  assert.deepEqual(fs.readFileSync(path.join(f.root, f.layout.directory, "runtime/execution-leases", authorization_id, "consumption.json")), consumption);
  assert.equal(lease().singleUseConsumed, true);
  assert.equal((await f.publicMcp("head_bounded_worker_job_status", { authorization_id: f.prepared[0].authorizationId })).status, "completed");
  assert.ok((await f.publicMcp("head_bounded_worker_job_patch", { authorization_id: f.prepared[0].authorizationId })).candidate);
  assert.deepEqual(f.pointers(), before);
});

test("public native owner crash after terminal publication preserves exact completion without premature success or relaunch", {
  skip: skip || !process.env.HEAD_AGENT_TEST_OWNER_CRASH_FIXTURE || !process.env.HEAD_AGENT_TEST_TERMINAL_HOLD_FIXTURE_ROOT
    ? "Explicit test-only terminal-hold native build and exact-owner crash helper not supplied" : false,
}, async t => {
  const f = await twoRunMembers(t, "second-member", { nativeFixtureRoot: process.env.HEAD_AGENT_TEST_TERMINAL_HOLD_FIXTURE_ROOT });
  const before = f.pointers(), projectId = JSON.parse(fs.readFileSync(path.join(f.root, f.layout.directory, "project.json"))).projectId;
  const directories = f.prepared.map(member => path.join(f.operational, "worker-jobs", projectId, member.authorizationId));
  const release = directory => {
    if (!fs.existsSync(directory)) return;
    try { fs.writeFileSync(path.join(directory, "terminal-release.test"), "test cleanup\n", { flag: "wx" }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  };
  try {
    await Promise.all(f.prepared.map(member => f.publicCli(["worker-start", "--task-key", member.taskKey])));
    const deadline = Date.now() + 15000;
    while (directories.some(directory => !fs.existsSync(path.join(directory, "terminal-held.test.json"))) && Date.now() < deadline) await pause();
    for (const directory of directories) assert.equal(fs.existsSync(path.join(directory, "terminal-held.test.json")), true);
    release(directories[0]);
    assert.equal((await f.closed(f.prepared[0])).status, "completed");
    const held = f.prepared[1], directory = directories[1], authorization_id = held.authorizationId;
    const requestFile = path.join(directory, "request.json"), claim = JSON.parse(fs.readFileSync(path.join(directory, "claim.json")));
    const marker = JSON.parse(fs.readFileSync(path.join(directory, "terminal-held.test.json")));
    assert.equal(marker.pid, claim.pid); assert.equal(marker.phase, "after-runjob-before-owner-exit");
    const terminal = JSON.parse(fs.readFileSync(path.join(directory, "terminal.json")));
    assert.equal(terminal.reason, "exited"); assert.equal(terminal.completeOutput, true); assert.equal(terminal.exitCode, 0);
    const frozenFiles = ["request.json", "launch-intent.json", "launch.json", "claim.json", "terminal.json", "control.jsonl", "stdout.bin", "stderr.bin", "workspace-patch.json"]
      .map(name => path.join(directory, name));
    frozenFiles.push(path.join(f.root, f.layout.directory, "runtime/execution-leases", authorization_id, "consumption.json"));
    const frozen = frozenFiles.map(file => fs.readFileSync(file));
    const helper = process.env.HEAD_AGENT_TEST_OWNER_CRASH_FIXTURE;
    assert.equal((await frontDoor("inspect", [requestFile, claim.ownerToken], f.root, null, process.env, helper)).status, "present");
    for (const name of ["head_bounded_worker_job_status", "head_bounded_worker_job_reconcile", "head_bounded_worker_start"]) {
      const state = await f.publicMcp(name, name === "head_bounded_worker_start" ? { task_key: held.taskKey } : { authorization_id });
      assert.equal(state.status, "settling"); assert.equal(state.ownerExitObserved, false); assert.equal(state.replayAllowed, false);
      assert.equal(state.result, null, "Saved terminal alone cannot masquerade as quiescent completion");
    }
    const unavailable = await f.mcp.dispatch(call("head_bounded_worker_job_patch", { project_root: f.root, authorization_id }));
    assert.ok(unavailable.error || unavailable.result?.isError);
    onProcess({ type: "planned-crash", pid: claim.pid, parentPid: marker.parentPid, ownerToken: claim.ownerToken,
      command: path.join(f.installed, "dist/windows-x64/head-agent-supervisor.exe"), args: ["--job", requestFile], cwd: f.root, ports: [],
      boundary: "durable-terminal-before-native-owner-exit", testOnlyNativeBuild: true });
    const crashed = await frontDoor("crash", [requestFile, claim.ownerToken], f.root, null, process.env, helper);
    assert.equal(crashed.status, "crash-injected"); assert.equal(crashed.terminationAttempted, true);
    assert.throws(() => process.kill(claim.pid, 0), { code: "ESRCH" });
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const name of ["head_bounded_worker_job_status", "head_bounded_worker_job_reconcile", "head_bounded_worker_start"]) {
        const state = await f.publicMcp(name, name === "head_bounded_worker_start" ? { task_key: held.taskKey } : { authorization_id });
        assert.equal(state.status, "completed"); assert.equal(state.ownerExitObserved, true); assert.equal(state.replayAllowed, false);
      }
      assert.equal((await f.publicCli(["worker-start", "--task-key", held.taskKey])).status, "completed");
      assert.ok((await f.publicMcp("head_bounded_worker_job_patch", { authorization_id })).candidate);
    }
    assert.deepEqual(frozenFiles.map(file => fs.readFileSync(file)), frozen);
    assert.equal((await f.publicMcp("head_bounded_worker_job_status", { authorization_id: f.prepared[0].authorizationId })).status, "completed");
    assert.deepEqual(f.pointers(), before);
    onProcess({ type: "terminal-owner-crash-exited", pid: claim.pid, ownerToken: claim.ownerToken, cwd: f.root, ports: [], cleanupVerified: true });
  } finally {
    // Test-only hold release precedes the general fixture cleanup hook. Never
    // erase the terminal or mutate Core authority to unblock a test failure.
    for (const directory of directories) release(directory);
    for (const member of f.prepared) {
      const directory = directories[f.prepared.indexOf(member)];
      if (fs.existsSync(path.join(directory, "claim.json"))) await f.closed(member);
    }
  }
});

async function keepFrontendOpen(t, f, request) {
  const file = path.join(f.installed, "scripts", isManagedMutation(request.params?.name) ? "mcp-managed-maintenance.mjs" : "mcp-server.mjs");
  onProcess({ type: "planned", command: process.execPath, args: [file], parentPid: process.pid, cwd: f.root, ports: [] });
  const child = spawn(process.execPath, [file], { cwd: f.root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  onProcess({ type: "spawn", pid: child.pid, parentPid: process.pid, cwd: f.root, ports: [] });
  let out = "", err = "", complete, rejectResponse;
  const response = new Promise((resolve, reject) => { complete = resolve; rejectResponse = reject; });
  const timer = setTimeout(() => { rejectResponse(Error("Held frontend response timeout")); child.stdin.end(); }, 30000);
  child.on("error", rejectResponse); child.stdin.on("error", rejectResponse);
  child.stdout.on("data", bytes => {
    out += bytes;
    if (out.length > 4 * 1024 * 1024) { rejectResponse(Error("Held frontend output bound")); child.stdin.end(); return; }
    if (out.includes("\n")) { clearTimeout(timer); try { complete(JSON.parse(out.slice(0, out.indexOf("\n")))); } catch (error) { rejectResponse(error); } }
  });
  child.stderr.on("data", bytes => { err = (err + bytes).slice(-65536); });
  const closed = new Promise(resolve => child.once("close", (code, signal) => {
    clearTimeout(timer); rejectResponse(Error("Held frontend closed before response"));
    onProcess({ type: "exit", pid: child.pid, exitCode: code, signal, cwd: f.root, ports: [] });
    if (err) console.log(err); resolve();
  }));
  const closeFrontend = async () => {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    const fallback = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); }, 3000);
    try { await closed; } finally { clearTimeout(fallback); }
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  };
  t.after(closeFrontend);
  child.stdin.write(JSON.stringify(request) + "\n");
  try { return { child, closed, response: value(await response) }; }
  catch (error) { await closeFrontend(); throw error; }
}

test("public frontend loss after native terminal commit preserves exact result and never relaunches either sibling", { skip }, async t => {
  const f = await twoRunMembers(t), before = f.pointers();
  const frontend = await keepFrontendOpen(t, f, call("head_bounded_worker_start", { project_root: f.root, task_key: "first-member" }));
  assert.ok(frontend.response.status);
  await f.publicCli(["worker-start", "--task-key", "second-member"]);
  for (const member of f.prepared) assert.equal((await f.closed(member)).status, "completed");
  const projectId = JSON.parse(fs.readFileSync(path.join(f.root, f.layout.directory, "project.json"))).projectId;
  const files = f.prepared.flatMap(member => [
    ...["claim.json", "terminal.json", "stdout.bin", "workspace-patch.json"].map(name => path.join(f.operational, "worker-jobs", projectId, member.authorizationId, name)),
    path.join(f.root, f.layout.directory, "runtime/execution-leases", member.authorizationId, "consumption.json"),
  ]);
  const frozen = files.map(file => fs.readFileSync(file));
  assert.equal(frontend.child.exitCode, null);
  onProcess({ type: "planned-crash", pid: frontend.child.pid, parentPid: process.pid, cwd: f.root, ports: [],
    reason: "Exact child frontend fault after both native owner terminal commits" });
  assert.equal(frontend.child.kill("SIGKILL"), true); await frontend.closed;
  assert.throws(() => process.kill(frontend.child.pid, 0), { code: "ESRCH" });
  for (const member of f.prepared) {
    const authorization_id = member.authorizationId;
    for (const name of ["head_bounded_worker_job_status", "head_bounded_worker_job_reconcile", "head_bounded_worker_start"]) {
      const state = await f.publicMcp(name, name === "head_bounded_worker_start" ? { task_key: member.taskKey } : { authorization_id });
      assert.equal(state.status, "completed"); assert.equal(state.ownerExitObserved, true); assert.equal(state.replayAllowed, false);
    }
    assert.ok((await f.publicMcp("head_bounded_worker_job_patch", { authorization_id })).candidate);
  }
  assert.deepEqual(files.map(file => fs.readFileSync(file)), frozen); assert.deepEqual(f.pointers(), before);
});

test("a rejected held frontend closes immediately without leaving a process or new job", { skip }, async t => {
  const f = await fixture(t);
  await assert.rejects(keepFrontendOpen(t, f, call("head_nonexistent_fixture_operation", { project_root: f.root })));
  assert.equal(fs.existsSync(path.join(f.operational, "worker-jobs")), false);
});

test("public integration reconciles interrupted receipt publication and preserves later user edits on retry", { skip }, async t => {
  const f = await twoRunMembers(t), before = f.pointers();
  await Promise.all(f.prepared.map(member => f.publicCli(["worker-start", "--task-key", member.taskKey])));
  for (const member of f.prepared) assert.equal((await f.closed(member)).status, "completed");
  const prepared = await f.publicMcp("head_worker_integration", { action: "prepare",
    authorization_ids: f.prepared.map(member => member.authorizationId), max_bytes: 4 * 1024 * 1024 });
  const integration_id = prepared.integration.integrationId;
  const originalLink = fs.linkSync; let interrupted = false;
  fs.linkSync = function(source, target, ...args) {
    if (!interrupted && String(target).startsWith(path.join(f.root, f.layout.directory, "runtime/worker-integrations"))
      && /\.effect-0(?:\.[^.]+)*\.receipt\.json$/.test(String(target))) {
      interrupted = true; throw Object.assign(new Error("Synthetic public post-effect receipt interruption"), { code: "EIO" });
    }
    return originalLink.call(this, source, target, ...args);
  };
  try {
    const failed = await f.mcp.dispatch(call("head_worker_integration", { project_root: f.root, action: "apply", integration_id }), { onProcess });
    assert.ok(failed.error || failed.result?.isError);
  } finally { fs.linkSync = originalLink; }
  assert.equal(interrupted, true);
  const paths = prepared.integration.composition.patches.map(patch => patch.before.path);
  assert.equal(paths.length, 2);
  assert.equal(fs.readFileSync(path.join(f.root, paths[0]), "utf8"), "synthetic proposed bytes\n");
  assert.notEqual(fs.readFileSync(path.join(f.root, paths[1]), "utf8"), "synthetic proposed bytes\n");
  fs.writeFileSync(path.join(f.root, paths[0]), "synthetic later user edit\n");
  const recovered = await f.publicMcp("head_worker_integration", { action: "reconcile", integration_id });
  assert.equal(recovered.effectResults[0].status, "applied"); assert.equal(recovered.allEffectsCompleted, false);
  const status = await f.publicMcp("head_worker_integration_status", { integration_id });
  assert.equal(status.application.currentBasis.headReassessmentRequired, true);
  assert.equal(status.reviewDecisionCreated, false); assert.equal(status.recoveryAuthority, false);
  const request = { action: "apply", integration_id, basis_digest: status.application.currentBasis.basisDigest };
  const applied = await f.publicMcp("head_worker_integration", request);
  assert.equal(applied.allEffectsCompleted, true);
  assert.equal(fs.readFileSync(path.join(f.root, paths[0]), "utf8"), "synthetic later user edit\n");
  assert.equal(fs.readFileSync(path.join(f.root, paths[1]), "utf8"), "synthetic proposed bytes\n");
  const replay = await f.publicMcp("head_worker_integration", request);
  assert.deepEqual(replay.effectResults, applied.effectResults); assert.deepEqual(f.pointers(), before);
});

async function crashIntegration(f, request, boundary) {
  const inputFile = path.join(f.home, `${boundary}-input.json`), readyFile = path.join(f.home, `${boundary}-ready.json`);
  fs.writeFileSync(inputFile, JSON.stringify(request), { flag: "wx" });
  const args = [path.join(pluginRoot, "test/helpers/integration-crash-driver.mjs"), f.installed, f.root, inputFile, boundary, readyFile];
  onProcess({ type: "planned", parentPid: process.pid, command: process.execPath, args, cwd: f.root, ports: [] });
  const child = spawn(process.execPath, args, { cwd: f.root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  onProcess({ type: "spawn", pid: child.pid, parentPid: process.pid, cwd: f.root, ports: [] });
  let output = "", failure, closed = false;
  child.on("error", error => { failure = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => {
    output += bytes;
    if (output.length > 4 * 1024 * 1024) { output = output.slice(-65536); failure = Error("Crash driver output bound"); child.kill(); }
  });
  const completion = new Promise(resolve => child.once("close", (code, signal) => {
    closed = true; onProcess({ type: "exit", pid: child.pid, exitCode: code, signal, cwd: f.root, ports: [] }); resolve();
  }));
  try {
    const deadline = Date.now() + 30000;
    let ready;
    while (!ready && !closed && !failure && Date.now() < deadline) {
      try { ready = JSON.parse(fs.readFileSync(readyFile, "utf8")); }
      catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
      if (!ready) await pause();
    }
    if (failure) throw failure;
    assert.ok(ready, `Actual CLI did not reach ${boundary}: ${output}`);
    assert.equal(ready.pid, child.pid); assert.equal(ready.boundary, boundary);
    assert.equal(ready.cwd, f.root); assert.deepEqual(ready.ports, []);
    onProcess({ type: "planned-crash", ...ready, reason: "Exact owned integration frontend process fault, not an exception" });
    assert.equal(child.kill("SIGKILL"), true); await completion;
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    const events = output.trim().split("\n").filter(Boolean).flatMap(line => {
      try { const value = JSON.parse(line); return value.integrationDriverProcess ? [value.integrationDriverProcess] : []; }
      catch { return []; }
    });
    const nativePids = [...new Set(events.filter(event => event.type === "spawn" && event.pid > 0).map(event => event.pid))];
    for (const pid of nativePids) {
      assert.ok(events.some(event => event.type === "exit" && event.pid === pid && event.cleanupVerified === true), "Native exit has exact cleanup evidence");
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `Native effect PID ${pid} already quiescent at boundary`);
    }
    onProcess({ type: "crash-tree-exited", pid: child.pid, nativePids, boundary, cwd: f.root, ports: [], cleanupVerified: true });
    return ready;
  } finally {
    if (!closed) child.kill("SIGTERM");
    const fallback = setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 3000);
    try { await completion; } finally { clearTimeout(fallback); if (output) console.log(output); }
  }
}

async function completedIntegration(t) {
  const f = await twoRunMembers(t);
  await Promise.all(f.prepared.map(member => f.publicCli(["worker-start", "--task-key", member.taskKey])));
  for (const member of f.prepared) assert.equal((await f.closed(member)).status, "completed");
  const prepared = await f.publicMcp("head_worker_integration", { action: "prepare",
    authorization_ids: f.prepared.map(member => member.authorizationId), max_bytes: 4 * 1024 * 1024 });
  return { f, integrationId: prepared.integration.integrationId, paths: prepared.integration.composition.patches.map(patch => patch.before.path) };
}

test("public integration actual process crash after durable attempt stays unknown and never repeats an unproved effect", { skip }, async t => {
  const { f, integrationId, paths } = await completedIntegration(t), before = f.pointers();
  const originals = paths.map(relative => fs.readFileSync(path.join(f.root, relative)));
  await crashIntegration(f, { action: "apply", integrationId }, "started");
  assert.deepEqual(paths.map(relative => fs.readFileSync(path.join(f.root, relative))), originals);
  fs.writeFileSync(path.join(f.root, paths[0]), "synthetic later user edit\n");
  for (let attempt = 0; attempt < 2; attempt++) {
    const recovered = await f.publicMcp("head_worker_integration", { action: "reconcile", integration_id: integrationId });
    assert.equal(recovered.allEffectsCompleted, false); assert.equal(recovered.effectResults[0].status, "unknown");
    const status = await f.publicMcp("head_worker_integration_status", { integration_id: integrationId });
    assert.equal(status.reviewDecisionCreated, false); assert.equal(status.recoveryAuthority, false);
    const applied = await f.publicMcp("head_worker_integration", { action: "apply", integration_id: integrationId,
      basis_digest: status.application.currentBasis.basisDigest, retry_known_no_write: attempt === 1 });
    assert.equal(applied.allEffectsCompleted, false); assert.equal(applied.effectResults[0].status, "unknown");
    assert.equal(fs.readFileSync(path.join(f.root, paths[0]), "utf8"), "synthetic later user edit\n");
    assert.deepEqual(fs.readFileSync(path.join(f.root, paths[1])), originals[1]);
  }
  const entries = fs.readdirSync(path.join(f.root, f.layout.directory, "runtime/worker-integrations"));
  assert.equal(entries.filter(name => name.endsWith(".started.json")).length, 1, "No second native effect or retry attempt");
  const status = await f.publicMcp("head_worker_integration_status", { integration_id: integrationId });
  const rejected = await f.mcp.dispatch(call("head_worker_integration", { project_root: f.root, action: "prepare-result", integration_id: integrationId,
    basis_digest: status.application.currentBasis.basisDigest, outcome: "Cannot finish an unproved effect",
    evidence: [{ check: "synthetic unknown" }], verification: [{ status: "unknown" }] }));
  assert.ok(rejected.error || rejected.result?.isError, "Unknown effect cannot be packaged as a completed whole result");
  assert.equal(fs.existsSync(path.join(f.root, f.layout.directory, "lineage/result-packets")), false);
  for (const member of f.prepared) assert.ok((await f.publicMcp("head_bounded_worker_job_patch", { authorization_id: member.authorizationId })).candidate);
  assert.deepEqual(f.pointers(), before);
});

test("public integration actual process crashes recover partial native effect and one frozen whole result without overwriting user edits", { skip }, async t => {
  const { f, integrationId, paths } = await completedIntegration(t), before = f.pointers();
  await crashIntegration(f, { action: "apply", integrationId }, "post-effect");
  assert.equal(fs.readFileSync(path.join(f.root, paths[0]), "utf8"), "synthetic proposed bytes\n");
  assert.notEqual(fs.readFileSync(path.join(f.root, paths[1]), "utf8"), "synthetic proposed bytes\n");
  fs.writeFileSync(path.join(f.root, paths[0]), "synthetic later user edit\n");
  const recovered = await f.publicMcp("head_worker_integration", { action: "reconcile", integration_id: integrationId });
  assert.equal(recovered.effectResults[0].status, "applied"); assert.equal(recovered.allEffectsCompleted, false);
  const status = await f.publicMcp("head_worker_integration_status", { integration_id: integrationId });
  assert.equal(status.application.currentBasis.headReassessmentRequired, true);
  const apply = { action: "apply", integration_id: integrationId, basis_digest: status.application.currentBasis.basisDigest };
  const applied = await f.publicMcp("head_worker_integration", apply);
  assert.equal(applied.allEffectsCompleted, true);
  assert.deepEqual((await f.publicMcp("head_worker_integration", apply)).effectResults, applied.effectResults);
  assert.equal(fs.readFileSync(path.join(f.root, paths[0]), "utf8"), "synthetic later user edit\n");
  assert.equal(fs.readFileSync(path.join(f.root, paths[1]), "utf8"), "synthetic proposed bytes\n");
  assert.deepEqual(f.pointers(), before, "Operational crash/reconciliation cannot write P2 direction");
  const current = await f.publicMcp("head_worker_integration_status", { integration_id: integrationId });
  const verification = await f.publicMcp("head_worker_integration", { action: "prepare-result", integration_id: integrationId,
    basis_digest: current.application.currentBasis.basisDigest, outcome: "HEAD checked synthetic combined result and retained later user edit",
    evidence: [{ check: "both native effects observed; later first-file edit retained", actualProviderInvoked: false }],
    verification: [{ check: "combined synthetic files", status: "passed" }], unknowns: ["No real model or account exercised"] });
  const verificationId = verification.verification.verificationId, packetId = verification.verification.wholeResultPacket.resultPacketId;
  assert.deepEqual(f.pointers(), before);
  await crashIntegration(f, { action: "publish-result", integrationId, verificationId }, "result-publication");
  // Explicit HEAD publication may finish the Run into awaiting-review. Recovery
  // must preserve that frozen transition, not redo effects or create approval.
  const frozen = f.pointers(), state = JSON.parse(frozen[0]);
  assert.equal(state.pendingReview.resultPacketId, packetId); assert.equal(state.lastReviewDecisionId, null);
  fs.writeFileSync(path.join(f.root, paths[1]), "synthetic edit after result freeze\n");
  const request = { action: "publish-result", integration_id: integrationId, verification_id: verificationId };
  const published = await f.publicMcp("head_worker_integration", request);
  assert.equal(published.resultPacket.resultPacketId, packetId);
  const replay = await f.publicMcp("head_worker_integration", request);
  assert.equal(replay.status, "already-published"); assert.equal(replay.resultPacket.resultPacketId, packetId);
  assert.equal(fs.readdirSync(path.join(f.root, f.layout.directory, "lineage/result-packets")).length, 1);
  assert.equal(fs.existsSync(path.join(f.root, f.layout.directory, "lineage/review-decisions")), false);
  assert.equal(fs.readdirSync(path.join(f.root, f.layout.directory, "runtime/worker-integrations")).filter(name => name.endsWith(".started.json")).length, 2,
    "One durable native attempt per member; result recovery never repeats effects");
  assert.equal(fs.readFileSync(path.join(f.root, paths[0]), "utf8"), "synthetic later user edit\n");
  assert.equal(fs.readFileSync(path.join(f.root, paths[1]), "utf8"), "synthetic edit after result freeze\n");
  assert.deepEqual(f.pointers(), frozen);
});

test("selected-only scope never silently inherits a nonempty Host instruction file", { skip }, async t => {
  const f = await fixture(t);
  const instructions = "Synthetic Host instruction; not private data\n", events = [];
  fs.writeFileSync(path.join(f.home, "AGENTS.md"), instructions);
  const pointers = [`${f.layout.directory}/project.json`, `${f.layout.directory}/sessions/current.json`].map(file => fs.readFileSync(path.join(f.root, file)));
  const unavailable = await f.host.prepareLocalBoundedWorker(f.input, { root: f.root, protocolFixtureBackend: f.backend, onProcess: event => events.push(event) });
  assert.equal(unavailable.status, "unavailable_for_selected_scope");
  assert.equal(unavailable.code, "CODEX_FRESH_PROPOSAL_POLICY_CONFLICT");
  assert.equal(unavailable.reason, "unselected-global-instructions");
  assert.equal(unavailable.instructionScope, "selected-only");
  assert.equal(Object.hasOwn(unavailable, "authorizationId"), false);
  assert.equal(Object.hasOwn(unavailable, "dispatchId"), false);
  assert.equal(unavailable.grantsPermission, false); assert.equal(unavailable.recoveryAuthority, false);
  assert.equal(unavailable.modelCallAttempted, false); assert.equal(unavailable.accountInspected, false); assert.equal(unavailable.workersStarted, 0);
  assert.equal(JSON.stringify(unavailable).includes(instructions.trim()), false);
  assert.deepEqual(events, []);
  for (const name of ["execution-authorizations", "worker-dispatches"]) {
    const directory = path.join(f.root, f.layout.directory, "runtime", name);
    assert.deepEqual(fs.existsSync(directory) ? fs.readdirSync(directory) : [], []);
  }
  assert.equal(fs.existsSync(path.join(f.operational, "worker-jobs")), false);
  // Explicit synthetic host-global input remains a separate preparation branch;
  // the selected-only result neither selects it nor grants real user approval.
  const prepared = await f.host.prepareLocalBoundedWorker({ ...f.input, instructionScope: "host-global" }, { root: f.root, protocolFixtureBackend: f.backend });
  f.prepared.push(prepared); assert.equal(prepared.instructionScope, "host-global"); assert.equal(prepared.modelCallAttempted, false);
  assert.equal(prepared.status, "prepared"); assert.match(prepared.authorizationId, /^execution-authorization-/);
  assert.equal(prepared.accountInspected, false); assert.equal(prepared.workersStarted, 0);
  const dispatches = path.join(f.root, f.layout.directory, "runtime/worker-dispatches");
  assert.deepEqual(fs.existsSync(dispatches) ? fs.readdirSync(dispatches) : [], []);
  assert.equal(fs.readFileSync(path.join(f.home, "AGENTS.md"), "utf8"), instructions);
  assert.deepEqual([`${f.layout.directory}/project.json`, `${f.layout.directory}/sessions/current.json`].map(file => fs.readFileSync(path.join(f.root, file))), pointers);
});

test("default shipped CLI prepares fresh and native-prefix against stock Codex without a thread, account or model call", {
  skip: skip || process.env.HEAD_AGENT_TEST_CODEX_HOST_DISCOVERY !== "1" ? "Explicit local stock discovery test not selected" : false,
}, async t => {
  const f = await fixture(t);
  const codex = process.env.HEAD_AGENT_TEST_CODEX_BIN;
  assert.ok(codex && path.isAbsolute(codex), "Explicit test-only installed executable directory");
  const environment = { ...process.env, CODEX_HOME: f.home, PATH: codex + path.delimiter + process.env.PATH };
  delete environment.Path; delete environment.path;
  for (const mode of ["fresh", "native-prefix"]) {
    const result = await frontDoor(path.join(f.installed, "scripts/head.mjs"), ["worker-prepare", f.root,
      "--task", f.input.task, "--task-key", `stock-${mode}`, "--model", f.input.model, "--source", "selected.txt", "--propose", "selected.txt",
      "--context-mode", mode, "--context", "Synthetic local discovery only; no seed is executed."], f.root, null, environment);
    f.prepared.push(result);
    assert.equal(result.status, "prepared"); assert.equal(result.evidenceMode, "actual-provider");
    assert.equal(result.contextMode, mode);
    assert.equal(result.executionPlan.maximumModelTurns, mode === "fresh" ? 1 : 2);
    assert.equal(result.modelCallAttempted, false); assert.equal(result.accountInspected, false); assert.equal(result.workersStarted, 0);
  }
  assert.equal(fs.existsSync(path.join(f.operational, "worker-jobs")), false);
});
