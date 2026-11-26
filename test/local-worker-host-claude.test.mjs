import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/storage/project-storage-format.mjs";
import { readRuntimeInvocationRecord } from "../scripts/lib/runtime/runtime-invocation-record.mjs";
import { isManagedMutation } from "../scripts/lib/session/managed-maintenance-surface.mjs";
import { compileContext } from "../scripts/lib/session/context-compiler.mjs";
import { createWholePlanSnapshot, createExecutionContract } from "../scripts/lib/runtime/execution-lineage.mjs";
import { startRun } from "../scripts/lib/runtime/run-lineage.mjs";
import { inspectRuntimeExecutionLease } from "../scripts/lib/runtime/runtime-execution-lease.mjs";
import {
  buildClaudeFreshProposalPolicyPlan,
  verifyClaudeFreshProposalPolicyPlan,
  assertClaudeFreshProposalRecipeCurrent,
  claudeFreshProposalArguments,
  claudeFreshProposalEnvironment,
} from "../scripts/lib/runtime/runtime-claude-proposal-policy.mjs";
import { createClaudeProposalStreamReader } from "../scripts/lib/runtime/runtime-claude-proposal.mjs";
import { buildCodexProposalResultSchema } from "../scripts/lib/runtime/runtime-codex-proposal.mjs";
import { nativeFixtureSkip, supervisorFixtureRoot, windowsNativeSkip } from "./helpers/native-fixtures.mjs";

// Model-free coverage of the Claude fresh-proposal backend of managed workers.
// The provider is test/helpers/claude-proposal-protocol-fixture.mjs, run by the
// current Node executable under a protocol-fixture policy; no model is called.
const pluginRoot = path.resolve(import.meta.dirname, "..");
const nativeRoot = supervisorFixtureRoot();
const skip = windowsNativeSkip("the packaged Windows native worker host");
const prepareSkip = nativeFixtureSkip("Claude worker preparation");
const onProcess = () => {};
const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
const CLAUDE_HELP = [
  "Usage: claude [options] [command] [prompt]",
  "  -p, --print   Print response and exit",
  "  --output-format <format>  text, json, or stream-json",
  "  --json-schema <schema>",
  "  --no-session-persistence",
  "  -r, --resume [value]",
  "  -c, --continue",
  '  --permission-mode <mode>  (choices: "acceptEdits", "dontAsk", "plan")',
  "  --verbose",
  "  --tools <tools...>",
  "  --disable-slash-commands",
  "  --setting-sources <sources>",
  "  --strict-mcp-config",
  "  --mcp-config <configs...>",
  "  --system-prompt <prompt>",
  "  --model <model>",
  "",
].join("\n");
function codexOutput(key) {
  return key === "--version"
    ? "codex 1.2.3\n"
    : key === "--help"
      ? "exec\nmcp-server\napp-server\n"
      : key === "exec --help"
        ? "Run Codex non-interactively\n--json\n--output-schema\n--color\n--sandbox\n--skip-git-repo-check\n--cd\n--ephemeral\nresume\n"
        : "stdio://\ngenerate-json-schema\n--listen\n";
}
// Answers the read-only capability probes by executable name, never runs one.
function schemaSpawn(help) {
  return (command, args) => {
    const key = args.join(" ");
    const output = /codex/i.test(path.basename(command)) ? codexOutput(key) : key === "--version" ? "2.1.330 (Claude Code)\n" : help;
    const child = new EventEmitter();
    Object.assign(child, { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null });
    child.kill = () => {
      throw Error("No process in schema fixture");
    };
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(output));
      child.exitCode = 0;
      child.emit("close", 0, null);
    });
    return child;
  };
}
async function frontDoor(file, args, root, request = null) {
  if (path.basename(file) === "head.mjs" && isManagedMutation(args[0])) args = ["managed-maintenance", ...args];
  if (path.basename(file) === "mcp-server.mjs" && isManagedMutation(request?.params?.name)) file = path.join(path.dirname(file), "mcp-managed-maintenance.mjs");
  const child = spawn(process.execPath, [file, ...args], { cwd: root, env: process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const out = [],
    err = [];
  child.stdout.on("data", (data) => out.push(data));
  child.stderr.on("data", (data) => err.push(data));
  if (request) child.stdin.write(JSON.stringify(request) + "\n");
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 30000);
  const code = await new Promise((resolve) => child.once("close", resolve));
  clearTimeout(timer);
  assert.equal(code, 0, Buffer.concat(err).toString());
  return JSON.parse(Buffer.concat(out).toString());
}
const call = (name, args) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const value = (response) => {
  assert.equal(response.error, undefined, JSON.stringify(response));
  assert.equal(response.result?.isError, undefined, JSON.stringify(response));
  return response.result.structuredContent ?? JSON.parse(response.result.content[0].text);
};

async function fixture(t, { help = CLAUDE_HELP } = {}) {
  const parent = fs.realpathSync(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const container = fs.mkdtempSync(path.join(parent, "head-local-worker-claude-"));
  const root = path.join(container, "project"),
    installed = path.join(container, "package"),
    operational = path.join(container, "operational"),
    home = path.join(container, "claude-home"),
    codexHome = path.join(container, "codex-home"),
    bin = path.join(container, "schema");
  for (const directory of [root, installed, operational, home, codexHome, bin]) fs.mkdirSync(directory);
  for (const name of ["scripts", "compat", "package.json", ".codex-plugin"])
    fs.cpSync(path.join(pluginRoot, name), path.join(installed, name), { recursive: true });
  fs.cpSync(path.join(nativeRoot, "dist"), path.join(installed, "dist"), { recursive: true });
  fs.mkdirSync(path.join(installed, "test", "helpers"), { recursive: true });
  for (const name of ["claude-proposal-protocol-fixture.mjs", "codex-proposal-protocol-fixture.mjs"])
    fs.copyFileSync(path.join(pluginRoot, "test", "helpers", name), path.join(installed, "test", "helpers", name));
  const importLocal = (file) => import(pathToFileURL(path.join(installed, "scripts", file)).href);
  const host = await importLocal("lib/worker/local-worker-host.mjs"),
    jobs = await importLocal("lib/worker/bounded-worker-job.mjs");
  const cliModule = await importLocal("head.mjs");
  const cli = {
    runCommand: async (args, options) => await cliModule.runCommand(isManagedMutation(args[0]) ? ["managed-maintenance", ...args] : args, options),
  };
  const mcpModule = await importLocal("mcp-server.mjs");
  const mcp = async (name, args, options = {}) =>
    value(
      await mcpModule.dispatch(call(name, { project_root: root, ...args }), {
        ...options,
        surface: isManagedMutation(name) ? "managed-maintenance" : "ordinary",
      }),
    );
  const previous = process.env.HEAD_AGENT_OPERATIONAL_STATE_ROOT;
  process.env.HEAD_AGENT_OPERATIONAL_STATE_ROOT = operational;
  const prepared = [];
  t.after(async () => {
    for (const member of prepared) {
      const input = { root, authorizationId: member.authorizationId };
      try {
        let state = jobs.readBoundedWorkerJob(input, { onProcess });
        if (!state.ownerExitObserved && state.status !== "not-started") {
          jobs.cancelBoundedWorkerJob(input, { onProcess });
          const end = Date.now() + 20000;
          while (!state.ownerExitObserved && Date.now() < end) {
            await pause();
            state = jobs.readBoundedWorkerJob(input, { onProcess });
          }
        }
      } catch {}
    }
    if (previous === undefined) delete process.env.HEAD_AGENT_OPERATIONAL_STATE_ROOT;
    else process.env.HEAD_AGENT_OPERATIONAL_STATE_ROOT = previous;
    assert.match(path.basename(container), /^head-local-worker-claude-/);
    fs.rmSync(container, { recursive: true, force: true });
  });
  initializeProject({ root, pluginRoot, runtimes: ["claude", "codex"] });
  const storage = inspectProject(root).storage;
  const layout = formatForVerifiedOwner(storage);
  fs.writeFileSync(path.join(root, "selected.txt"), "selected original\n");
  fs.writeFileSync(path.join(bin, "claude.exe"), "Synthetic schema marker; never executed");
  fs.writeFileSync(path.join(bin, "codex.exe"), "Synthetic schema marker; never executed");
  const environment = { ...process.env, PATH: bin };
  delete environment.Path;
  delete environment.path;
  const backend = host.createLocalWorkerProtocolFixtureBackend({ codexHome, claudeHome: home, environment, spawnImplementation: schemaSpawn(help) });
  const settings = (value) => fs.writeFileSync(path.join(home, "claude-fixture.json"), JSON.stringify(value));
  const projectId = JSON.parse(fs.readFileSync(path.join(root, layout.directory, "project.json"))).projectId;
  async function settle(member, limit = 45000) {
    const input = { root, authorizationId: member.authorizationId };
    let state = jobs.readBoundedWorkerJob(input, { onProcess });
    const end = Date.now() + limit;
    while (!state.ownerExitObserved && Date.now() < end) {
      await pause();
      state = jobs.readBoundedWorkerJob(input, { onProcess });
    }
    assert.equal(state.ownerExitObserved, true, JSON.stringify(state));
    return jobs.reconcileBoundedWorkerJob(input, { onProcess });
  }
  const receipt = (member) => readRuntimeInvocationRecord({ root, authorizationId: member.authorizationId, storage }).receipt;
  return {
    root,
    storage,
    layout,
    installed,
    operational,
    home,
    host,
    jobs,
    cli,
    mcp,
    backend,
    prepared,
    settings,
    settle,
    receipt,
    projectId,
    importLocal,
    input: {
      task: "Propose selected data change",
      model: "claude-fixture-model",
      runtime: "claude",
      taskKey: "claude-member",
      sourcePaths: ["selected.txt"],
      proposalPaths: ["selected.txt"],
    },
  };
}

test("Claude preparation and start through the library, CLI and stdio MCP end in readable proposals", { skip }, async (t) => {
  const f = await fixture(t);
  const prepared = await f.host.prepareLocalBoundedWorker(f.input, { root: f.root, protocolFixtureBackend: f.backend });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.runtime, "claude");
  assert.equal(prepared.evidenceMode, "protocol-fixture");
  assert.equal(prepared.modelCallAttempted, false);
  assert.equal(prepared.accountInspected, false);
  f.prepared.push(prepared);
  for (const taskKey of ["claude-cli", "claude-mcp"])
    f.prepared.push(await f.host.prepareLocalBoundedWorker({ ...f.input, taskKey }, { root: f.root, protocolFixtureBackend: f.backend }));
  const started = await f.host.startLocalBoundedWorker({ root: f.root, taskKey: "claude-member" });
  assert.ok(["running", "settling", "unknown", "completed"].includes(started.status), JSON.stringify(started));
  const [cli, mcp] = await Promise.all([
    frontDoor(path.join(f.installed, "scripts/head.mjs"), ["worker-start", f.root, "--task-key", "claude-cli"], f.root),
    frontDoor(
      path.join(f.installed, "scripts/mcp-server.mjs"),
      [],
      f.root,
      call("lode_bounded_worker_start", { project_root: f.root, task_key: "claude-mcp" }),
    ),
  ]);
  assert.ok(cli.status);
  assert.ok(value(mcp).status);
  for (const member of f.prepared) {
    const state = await f.settle(member);
    assert.equal(state.status, "completed", JSON.stringify(state));
    assert.equal(state.result.actualProviderInvoked, false);
    assert.equal(state.workspacePatch.origin, "provider-patch-proposal");
    const patch = f.jobs.readBoundedWorkerPatch({ root: f.root, authorizationId: member.authorizationId });
    assert.equal(patch.applied, false);
    const receipt = f.receipt(member);
    assert.equal(receipt.runtime, "claude");
    assert.equal(receipt.providerBoundary.mode, "claude-protocol-fixture");
  }
  assert.equal(fs.readFileSync(path.join(f.root, "selected.txt"), "utf8"), "selected original\n");
});

function policyScratch(t) {
  const container = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "head-claude-policy-"));
  t.after(() => fs.rmSync(container, { recursive: true, force: true }));
  const home = path.join(container, "home"),
    executable = path.join(container, process.platform === "win32" ? "claude.exe" : "claude");
  fs.mkdirSync(home);
  fs.writeFileSync(executable, "synthetic Claude Code build A");
  return { container, home, executable, environment: { HOME: home, USERPROFILE: home, PATH: container, NODE_OPTIONS: "--inspect", ANTHROPIC_API_KEY: "x" } };
}

test("the Claude proposal policy binds the executable identity and refuses a change before start", (t) => {
  const s = policyScratch(t);
  const policy = buildClaudeFreshProposalPolicyPlan({ executablePath: s.executable, environment: s.environment, wireModel: "claude-fixture-model" });
  assert.equal(policy.kind, "ClaudeFreshProposalPolicyPlan");
  assert.equal(policy.trust, "observed-capability");
  assert.deepEqual(Object.keys(policy.providerProfile), ["HOME", "USERPROFILE"]);
  for (const field of ["enforcementVerified", "instructionAuthority", "promotionAuthority", "recoveryAuthority"]) assert.equal(policy[field], false);
  assert.deepEqual(verifyClaudeFreshProposalPolicyPlan(JSON.parse(JSON.stringify(policy))), policy);
  assert.deepEqual(assertClaudeFreshProposalRecipeCurrent(policy), policy);
  // A changed build (for example an update) needs a new preparation.
  fs.writeFileSync(s.executable, "synthetic Claude Code build B");
  assert.throws(() => assertClaudeFreshProposalRecipeCurrent(policy), { code: "CLAUDE_FRESH_PROPOSAL_POLICY_CONFLICT", reason: "executable-changed" });
  fs.rmSync(s.executable);
  assert.throws(() => assertClaudeFreshProposalRecipeCurrent(policy), { code: "CLAUDE_FRESH_PROPOSAL_POLICY_CONFLICT", reason: "executable-changed" });
  // A retained plan that was edited is not the fixed typed recipe.
  assert.throws(() => verifyClaudeFreshProposalPolicyPlan({ ...policy, fixedArguments: [...policy.fixedArguments, "--dangerously-skip-permissions"] }), {
    code: "CLAUDE_FRESH_PROPOSAL_POLICY_CONFLICT",
  });
  assert.throws(() => verifyClaudeFreshProposalPolicyPlan({ ...policy, providerProfile: { ...policy.providerProfile, NODE_OPTIONS: s.home } }), {
    code: "CLAUDE_FRESH_PROPOSAL_POLICY_CONFLICT",
  });
});

test("the Claude proposal policy takes only a Claude executable, a Claude model and selected-only scope", (t) => {
  const s = policyScratch(t);
  const other = path.join(s.container, "codex.exe");
  fs.writeFileSync(other, "not Claude");
  assert.throws(() => buildClaudeFreshProposalPolicyPlan({ executablePath: other, environment: s.environment, wireModel: "claude-fixture-model" }), {
    code: "CLAUDE_FRESH_PROPOSAL_POLICY_CONFLICT",
  });
  for (const wireModel of ["gpt-5.6-sol", "sonnet", "claude-", "claude-x[1m]"])
    assert.throws(() => buildClaudeFreshProposalPolicyPlan({ executablePath: s.executable, environment: s.environment, wireModel }), {
      code: "CLAUDE_FRESH_PROPOSAL_POLICY_CONFLICT",
    });
  assert.throws(
    () =>
      buildClaudeFreshProposalPolicyPlan({
        executablePath: s.executable,
        environment: s.environment,
        wireModel: "claude-fixture-model",
        instructionScope: "host-global",
      }),
    { code: "CLAUDE_FRESH_PROPOSAL_POLICY_CONFLICT", reason: "unselected-global-instructions-unsupported" },
  );
  assert.throws(
    () => buildClaudeFreshProposalPolicyPlan({ executablePath: s.executable, environment: { PATH: s.container }, wireModel: "claude-fixture-model" }),
    { code: "CLAUDE_FRESH_PROPOSAL_POLICY_CONFLICT" },
  );
});

test("the Claude worker recipe and environment are fixed by Lode", (t) => {
  const s = policyScratch(t);
  const policy = buildClaudeFreshProposalPolicyPlan({ executablePath: s.executable, environment: s.environment, wireModel: "claude-fixture-model" });
  const schema = buildCodexProposalResultSchema("session");
  const args = claudeFreshProposalArguments({ policy, resultSchema: schema });
  const after = (flag) => args[args.indexOf(flag) + 1];
  for (const flag of ["--print", "--verbose", "--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config"])
    assert.ok(args.includes(flag), flag);
  assert.equal(after("--output-format"), "stream-json");
  assert.equal(after("--tools"), "");
  assert.equal(after("--setting-sources"), "");
  assert.equal(after("--mcp-config"), JSON.stringify({ mcpServers: {} }));
  assert.equal(after("--permission-mode"), "dontAsk");
  assert.equal(after("--model"), "claude-fixture-model");
  assert.deepEqual(JSON.parse(after("--json-schema")), schema);
  assert.match(after("--system-prompt"), /^You are a bounded patch-proposal worker\./);
  assert.ok(!args.includes("--dangerously-skip-permissions") && !args.includes("--allowedTools"));
  const environment = claudeFreshProposalEnvironment({
    policy,
    environment: {
      SystemRoot: "C:\\Windows",
      SYSTEMROOT: "C:\\Windows",
      TEMP: s.container,
      PATH: s.container,
      NODE_OPTIONS: "--inspect",
      ANTHROPIC_API_KEY: "x",
    },
  });
  assert.equal(environment.HOME, policy.providerProfile.HOME);
  assert.equal(environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(environment.CLAUDE_CODE_MAX_RETRIES, "4");
  assert.equal(environment.DISABLE_AUTOUPDATER, "1");
  const names = Object.keys(environment).map((name) => name.toUpperCase());
  for (const name of ["PATH", "NODE_OPTIONS", "ANTHROPIC_API_KEY"]) assert.ok(!names.includes(name), name);
  assert.equal(names.filter((name) => name === "SYSTEMROOT").length, 1);
});

test("the Claude stream reader rejects records outside the recipe and classifies refusals", () => {
  const reader = createClaudeProposalStreamReader({ authorization: { scope: { kind: "session" } }, forbidden: [] });
  assert.equal(reader.extract({ type: "system", subtype: "init", tools: ["StructuredOutput"], mcp_servers: [], skills: [], slash_commands: [] }), null);
  assert.throws(() => reader.extract({ type: "system", subtype: "init", tools: ["Bash", "StructuredOutput"], mcp_servers: [] }), {
    code: "CLAUDE_FRESH_PROPOSAL_RECIPE_NOT_IN_EFFECT",
  });
  assert.throws(() => reader.extract({ type: "system", subtype: "init", tools: ["StructuredOutput"], mcp_servers: [{ name: "x" }] }), {
    code: "CLAUDE_FRESH_PROPOSAL_RECIPE_NOT_IN_EFFECT",
  });
  assert.throws(() => reader.extract({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: {} }] } }), {
    code: "CLAUDE_FRESH_PROPOSAL_RECIPE_NOT_IN_EFFECT",
  });
  assert.equal(reader.extract({ type: "result", is_error: true, structured_output: {} }), null);
  assert.ok(reader.classify({ record: { type: "system", subtype: "api_retry", error_status: 429, error: "rate_limit" } }).includes("claude.rate-limit"));
  const final = reader.classify({ stderr: "", exitCode: 0, structuredResultObserved: false, eventTypes: [] });
  assert.ok(final.includes("claude.recipe-not-in-effect") && final.includes("claude.effect-tool-rejected"), final.join());
});

test("Claude preparation refuses a mismatched runtime and model, a missing recipe option and unsupported scopes", { skip: prepareSkip }, async (t) => {
  const f = await fixture(t);
  const options = { root: f.root, protocolFixtureBackend: f.backend };
  await assert.rejects(f.host.prepareLocalBoundedWorker({ ...f.input, model: "gpt-5.6-sol" }, options), (error) => {
    assert.equal(error.code, "LOCAL_WORKER_RUNTIME_MODEL_MISMATCH");
    assert.match(error.message, /gpt-5\.6-sol/u);
    assert.match(error.message, /claude/u);
    return true;
  });
  await assert.rejects(f.host.prepareLocalBoundedWorker({ ...f.input, runtime: "codex" }, options), (error) => {
    assert.equal(error.code, "LOCAL_WORKER_RUNTIME_MODEL_MISMATCH");
    assert.match(error.message, /claude-fixture-model/u);
    assert.match(error.message, /codex/u);
    return true;
  });
  await assert.rejects(f.host.prepareLocalBoundedWorker({ ...f.input, runtime: "opencode" }, options), { code: "LOCAL_WORKER_BACKEND_UNAVAILABLE" });
  await assert.rejects(f.host.prepareLocalBoundedWorker({ ...f.input, instructionScope: "host-global" }, options), {
    code: "LOCAL_WORKER_BACKEND_UNAVAILABLE",
  });
  await assert.rejects(f.host.prepareLocalBoundedWorker({ ...f.input, contextMode: "native-prefix", selectedContext: "seed" }, options), {
    code: "LOCAL_WORKER_BACKEND_UNAVAILABLE",
  });
  // A known calling Host decides the runtime when none is named.
  const { runtime, ...unnamed } = f.input;
  assert.equal(runtime, "claude");
  await assert.rejects(f.host.prepareLocalBoundedWorker({ ...unnamed, model: "gpt-5.6-sol" }, { ...options, hostRuntime: "claude" }), {
    code: "LOCAL_WORKER_RUNTIME_MODEL_MISMATCH",
  });
  const hosted = await f.host.prepareLocalBoundedWorker({ ...unnamed, taskKey: "hosted-member" }, { ...options, hostRuntime: "claude" });
  assert.equal(hosted.runtime, "claude");
  // Observed capability: a help surface without a recipe option is refused,
  // whether the option is a shared observation signal or only part of the recipe.
  for (const [shown, hidden] of [
    ["--strict-mcp-config", "--strict-config"],
    ["--system-prompt <prompt>", "--system-prompt-snapshot <on|off>"],
    ["  --verbose", "  --quiet"],
  ]) {
    const g = await fixture(t, { help: CLAUDE_HELP.replace(shown, hidden) });
    await assert.rejects(g.host.prepareLocalBoundedWorker(g.input, { root: g.root, protocolFixtureBackend: g.backend }), {
      code: "LOCAL_WORKER_BACKEND_UNAVAILABLE",
    });
    const directory = path.join(g.operational, "worker-preparations", g.projectId);
    assert.equal(fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith(".json")).length : 0, 0);
  }
});

test("through the real MCP dispatch the calling Host chooses the runtime only when none is named", { skip: prepareSkip }, async (t) => {
  const f = await fixture(t);
  // A pass-through bridge describing the Host as it names itself.
  const bridge = (runtime) => ({ describe: () => ({ runtime }), dispatch: (request, handler) => handler(request, {}) });
  const prepare = (args, runtime) =>
    f.mcp(
      "lode_bounded_worker_prepare",
      { task: f.input.task, source_paths: ["selected.txt"], proposal_paths: ["selected.txt"], ...args },
      { workerPreparationBackend: f.backend, nativeSessionBridge: bridge(runtime) },
    );
  assert.equal((await prepare({ model: f.input.model, task_key: "from-claude-host" }, "claude")).runtime, "claude");
  assert.equal((await prepare({ model: "gpt-5.6-sol", task_key: "from-codex-host" }, "codex")).runtime, "codex");
  // A named runtime wins over the Host; a model of the other runtime is refused by name.
  assert.equal((await prepare({ model: "gpt-5.6-sol", runtime: "codex", task_key: "named-codex" }, "claude")).runtime, "codex");
  await assert.rejects(
    prepare({ model: "gpt-5.6-sol", task_key: "claude-host-codex-model" }, "claude"),
    /LOCAL_WORKER_RUNTIME_MODEL_MISMATCH|is a Codex model/u,
  );
  // A tool input cannot name the Host.
  await assert.rejects(prepare({ model: f.input.model, task_key: "forged-host", host_runtime: "codex" }, "claude"), /host_runtime/u);
});

test("each proposal policy kind accepts only its own runner and environment", { skip: prepareSkip }, async (t) => {
  const f = await fixture(t);
  const options = { root: f.root, protocolFixtureBackend: f.backend };
  await f.host.prepareLocalBoundedWorker(f.input, options);
  await f.host.prepareLocalBoundedWorker({ ...f.input, runtime: "codex", model: "gpt-5.6-sol", taskKey: "codex-member" }, options);
  const directory = path.join(f.operational, "worker-preparations", f.projectId);
  const records = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")));
  const claude = records.find((record) => record.request.runtime === "claude"),
    codex = records.find((record) => record.request.runtime === "codex");
  const runners = path.join(f.installed, "scripts", "lib", "runtime");
  const claudeRunner = path.join(runners, "runtime-claude-proposal-runner.mjs"),
    codexRunner = path.join(runners, "runtime-codex-proposal-runner.mjs");
  const host = (record, extra) => f.jobs.createBoundedWorkerJobHost({ policy: record.policy, workspaceBinding: record.workspaceBinding, ...extra });
  assert.ok(host(claude, {}));
  assert.ok(host(claude, { runnerFile: claudeRunner }));
  assert.ok(host(codex, { runnerFile: codexRunner }));
  assert.throws(() => host(claude, { runnerFile: codexRunner }), { code: "WORKER_JOB_POLICY_UNAVAILABLE" });
  assert.throws(() => host(codex, { runnerFile: claudeRunner }), { code: "WORKER_JOB_POLICY_UNAVAILABLE" });
  assert.throws(() => host(claude, { environment: { NODE_OPTIONS: "--require=x" } }), { code: "WORKER_JOB_POLICY_UNAVAILABLE" });
  assert.throws(() => host(claude, { environment: { HOME: f.root } }), { code: "WORKER_JOB_POLICY_UNAVAILABLE" });
  assert.throws(() => host(claude, { environment: { CODEX_HOME: claude.policy.providerProfile.HOME } }), { code: "WORKER_JOB_POLICY_UNAVAILABLE" });
  assert.ok(host(claude, { environment: { HOME: claude.policy.providerProfile.HOME } }));
  // An edited Claude plan is not accepted as a proposal binding.
  assert.throws(() => host({ ...claude, policy: { ...claude.policy, runtime: "codex" } }, {}), { code: "CLAUDE_FRESH_PROPOSAL_POLICY_CONFLICT" });
});

test("two Claude workers started one after the other run at the same moment and keep their own receipts", { skip }, async (t) => {
  const f = await fixture(t);
  const overlapDirectory = path.join(f.home, "overlap");
  fs.mkdirSync(overlapDirectory);
  f.settings({ stayMs: 2500, overlapDirectory });
  for (const taskKey of ["claude-left", "claude-right"])
    f.prepared.push(await f.host.prepareLocalBoundedWorker({ ...f.input, taskKey }, { root: f.root, protocolFixtureBackend: f.backend }));
  for (const member of f.prepared) await f.host.startLocalBoundedWorker({ root: f.root, taskKey: member.taskKey });
  const states = [];
  for (const member of f.prepared) states.push(await f.settle(member));
  for (const state of states) assert.equal(state.status, "completed", JSON.stringify(state));
  const spans = fs.readdirSync(overlapDirectory).map((name) => JSON.parse(fs.readFileSync(path.join(overlapDirectory, name), "utf8")));
  assert.equal(spans.length, 2);
  const [a, b] = spans;
  assert.notEqual(a.pid, b.pid);
  // Measured, not assumed: each provider was still running when the other started.
  assert.ok(a.started < b.ended && b.started < a.ended, JSON.stringify(spans));
  const receipts = f.prepared.map((member) => f.receipt(member));
  assert.notEqual(receipts[0].receiptId, receipts[1].receiptId);
  assert.deepEqual(
    receipts.map((receipt) => receipt.status),
    ["completed", "completed"],
  );
});

async function runFixture(t) {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, "other.txt"), "other original\n");
  const capsule = (await compileContext({ root: f.root, task: f.input.task, persist: true })).capsule;
  const plan = createWholePlanSnapshot({ root: f.root, objective: f.input.task, plan: [{ id: "proposals", outcome: "Lode inspects two proposals" }] }).artifact;
  const contract = createExecutionContract({
    root: f.root,
    wholePlanId: plan.wholePlanId,
    capsuleId: capsule.capsuleId,
    scope: "Synthetic mixed-runtime integration",
    acceptanceCriteria: ["HEAD applies exact proposals; workers never write"],
    allowedActions: ["runtime.invoke", "project.read", "project.write"],
  }).artifact;
  startRun({ root: f.root, executionContractId: contract.executionContractId });
  return f;
}

test("a wave mixes a Codex and a Claude worker and both proposals integrate", { skip }, async (t) => {
  const f = await runFixture(t);
  const options = { workerPreparationBackend: f.backend };
  f.prepared.push(
    await f.mcp(
      "lode_bounded_worker_prepare",
      {
        task: f.input.task,
        model: "gpt-5.6-sol",
        runtime: "codex",
        task_key: "codex-member",
        source_paths: ["selected.txt"],
        proposal_paths: ["selected.txt"],
      },
      options,
    ),
    await f.mcp(
      "lode_bounded_worker_prepare",
      { task: f.input.task, model: f.input.model, runtime: "claude", task_key: "claude-member", source_paths: ["other.txt"], proposal_paths: ["other.txt"] },
      options,
    ),
  );
  for (const member of f.prepared) await f.mcp("lode_bounded_worker_start", { task_key: member.taskKey });
  const wave = (await f.mcp("lode_bounded_worker_wave_create", { authorization_ids: f.prepared.map((member) => member.authorizationId) })).wave;
  assert.deepEqual(wave.members.map((member) => member.runtime).sort(), ["claude", "codex"]);
  for (const member of f.prepared) assert.equal((await f.settle(member)).status, "completed");
  await f.mcp("lode_bounded_worker_wave_seal", { wave_id: wave.waveId });
  const waited = await f.mcp("lode_bounded_worker_wave_wait", { wave_id: wave.waveId, wait_timeout_ms: 30000 });
  assert.equal(waited.status, "bounded_worker_wave_completed", JSON.stringify(waited));
  const prepared = await f.mcp("lode_worker_integration", {
    action: "prepare",
    authorization_ids: f.prepared.map((member) => member.authorizationId),
    max_bytes: 4 * 1024 * 1024,
  });
  const applied = await f.mcp("lode_worker_integration", { action: "apply", integration_id: prepared.integration.integrationId });
  assert.equal(applied.allEffectsCompleted, true, JSON.stringify(applied).slice(0, 2000));
  assert.equal(fs.readFileSync(path.join(f.root, "selected.txt"), "utf8"), "synthetic proposed bytes\n");
  assert.equal(fs.readFileSync(path.join(f.root, "other.txt"), "utf8"), "synthetic Claude proposed bytes\n");
});

async function failedRun(t, scenario, { timeoutMs } = {}) {
  const f = await fixture(t);
  f.settings({ scenario });
  const member = await f.host.prepareLocalBoundedWorker(
    { ...f.input, taskKey: `claude-${scenario}`, ...(timeoutMs ? { timeoutMs } : {}) },
    { root: f.root, protocolFixtureBackend: f.backend },
  );
  f.prepared.push(member);
  await f.host.startLocalBoundedWorker({ root: f.root, taskKey: member.taskKey });
  return { f, member };
}
function assertSettledWithoutPatch(f, member, state, status) {
  assert.notEqual(state.status, "completed", JSON.stringify(state));
  assert.equal(state.workspacePatch, undefined);
  assert.throws(() => f.jobs.readBoundedWorkerPatch({ root: f.root, authorizationId: member.authorizationId }), { code: "WORKER_PATCH_NOT_AVAILABLE" });
  const receipt = f.receipt(member);
  assert.equal(receipt.status, status, JSON.stringify(receipt).slice(0, 1500));
  // The consumed lease carries its recorded outcome.
  const lease = inspectRuntimeExecutionLease({ projectRoot: f.root, projectId: f.projectId, authorizationId: member.authorizationId, storage: f.storage });
  assert.equal(lease.status, "consumed-released");
  assert.equal(lease.release.lifecycleReceiptId, receipt.receiptId);
  return receipt;
}

// The owner may be stopped by its native job (cancel, deadline) before the run
// records a receipt; the job's own terminal is then the recorded outcome. A
// receipt, when there is one, says the same.
function assertStoppedWithoutPatch(f, member, state, status) {
  assert.equal(state.ownerExitObserved, true);
  assert.equal(state.workspacePatch, undefined);
  assert.throws(() => f.jobs.readBoundedWorkerPatch({ root: f.root, authorizationId: member.authorizationId }), { code: "WORKER_PATCH_NOT_AVAILABLE" });
  const lease = inspectRuntimeExecutionLease({ projectRoot: f.root, projectId: f.projectId, authorizationId: member.authorizationId, storage: f.storage });
  assert.equal(lease.singleUseConsumed, true);
  let receipt = null;
  try {
    receipt = f.receipt(member);
  } catch (error) {
    if (error.code !== "RUNTIME_INVOCATION_RESULT_NOT_FOUND") throw error;
  }
  if (receipt) assert.equal(receipt.status, status);
  // A repeated start is a historical read, never a relaunch.
  return f.host.startLocalBoundedWorker({ root: f.root, taskKey: member.taskKey }).then((replay) => {
    assert.equal(replay.status, state.status);
    const after = inspectRuntimeExecutionLease({ projectRoot: f.root, projectId: f.projectId, authorizationId: member.authorizationId, storage: f.storage });
    assert.equal(after.singleUseConsumed, true);
  });
}

for (const [scenario, code] of [
  ["outside-basis", "claude.proposal-result-rejected"],
  ["sensitive-result", null],
  ["missing-result", "claude.missing-structured-result"],
  ["extra-tool", "claude.recipe-not-in-effect"],
  ["tool-call", "claude.effect-tool-rejected"],
  ["rate-limit", "claude.rate-limit"],
]) {
  test(`a Claude worker whose provider run ends as ${scenario} settles as failed without a patch`, { skip }, async (t) => {
    const { f, member } = await failedRun(t, scenario);
    const state = await f.settle(member);
    const receipt = assertSettledWithoutPatch(f, member, state, ["extra-tool", "tool-call"].includes(scenario) ? "invalid-event" : "failed");
    if (code) assert.ok(receipt.providerBoundary.diagnosticCodes.includes(code), receipt.providerBoundary.diagnosticCodes.join());
  });
}

test("a Claude worker whose provider retried a refusal and then answered stays a success", { skip }, async (t) => {
  const { f, member } = await failedRun(t, "retry-then-success");
  const state = await f.settle(member);
  assert.equal(state.status, "completed", JSON.stringify(state));
  assert.ok(f.jobs.readBoundedWorkerPatch({ root: f.root, authorizationId: member.authorizationId }).candidate);
  const receipt = f.receipt(member);
  assert.equal(receipt.status, "completed");
  // The retries stay visible as a diagnostic without turning the run into a failure.
  assert.ok(receipt.providerBoundary.diagnosticCodes.includes("claude.rate-limit"), receipt.providerBoundary.diagnosticCodes.join());
});

test("a cancelled Claude worker settles with its owned process stopped and its lease recorded", { skip }, async (t) => {
  const { f, member } = await failedRun(t, "hang");
  const input = { root: f.root, authorizationId: member.authorizationId };
  const end = Date.now() + 20000;
  while (!fs.existsSync(path.join(f.operational, "runtime-output", f.projectId, member.authorizationId)) && Date.now() < end) await pause();
  await pause(500);
  f.jobs.cancelBoundedWorkerJob(input, { onProcess });
  const state = await f.settle(member);
  assert.equal(state.status, "cancelled", JSON.stringify(state));
  await assertStoppedWithoutPatch(f, member, state, "cancelled");
});

test("a Claude worker past its time limit settles as timed out", { skip }, async (t) => {
  const { f, member } = await failedRun(t, "hang", { timeoutMs: 8000 });
  const state = await f.settle(member);
  assert.ok(["timed-out", "failed"].includes(state.status), JSON.stringify(state));
  await assertStoppedWithoutPatch(f, member, state, "timed-out");
});
