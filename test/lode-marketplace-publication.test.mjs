import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { artifactCompositionForIdentity } from "../scripts/lib/lode-artifact-composition.mjs";
import { buildCodexMarketplaceSnapshot, verifyCodexMarketplaceSnapshot } from "../scripts/lib/codex-marketplace.mjs";
import { buildClaudeMarketplaceSnapshot, verifyClaudeMarketplaceSnapshot } from "../scripts/lib/claude-marketplace.mjs";
import { installDistribution, rollbackDistribution, stageDistributionRelease } from "../scripts/lib/distribution-lifecycle.mjs";
import { portableMcpLaunch } from "../scripts/lib/portable-client-command.mjs";
import { initializeProject, convergeProjectInstallation } from "../scripts/lib/lode-core.mjs";

const source = path.resolve(import.meta.dirname, "..");
const read = relative => fs.readFileSync(path.join(source, relative), "utf8");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function inventory(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(root, file).replaceAll("\\", "/"), hash(fs.readFileSync(file))];
    }).sort(([a], [b]) => a.localeCompare(b));
}
function fixture(t) {
  const parent = fs.realpathSync(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, "lode-marketplace-publication-")));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert(path.basename(root).startsWith("lode-marketplace-publication-"));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 20 : 0, retryDelay: 100 });
  });
  return root;
}

async function withOwnedMcp(t, args, cwd, environment, operation) {
  t.diagnostic(JSON.stringify({ event: "planned", command: process.execPath, args, cwd, parent: process.pid, ports: [], windowsHide: true }));
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...environment }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  t.diagnostic(JSON.stringify({ event: "started", pid: child.pid, parent: process.pid, command: process.execPath, args, cwd, ports: [] }));
  let stderr = "", nextId = 0;
  const pending = new Map(), lines = readline.createInterface({ input: child.stdout });
  const rejectAll = error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); };
  child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-16384); });
  child.stdin.on("error", rejectAll); child.once("error", rejectAll);
  lines.on("line", line => {
    try { const response = JSON.parse(line), entry = pending.get(response.id); if (entry) { pending.delete(response.id); clearTimeout(entry.timer); entry.resolve(response); } }
    catch (error) { rejectAll(error); }
  });
  const closed = new Promise(resolve => child.once("close", (code, signal) => {
    rejectAll(new Error(`Owned MCP closed: ${code}; ${stderr}`));
    t.diagnostic(JSON.stringify({ event: "closed", pid: child.pid, parent: process.pid, code, signal, ports: [] })); resolve({ code, signal });
  }));
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error("Owned synthetic MCP call timed out.")); }, 10_000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try { return await operation(call); }
  finally {
    child.stdin.end();
    const graceful = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); }, 2000);
    const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 3000);
    try { await closed; } finally { clearTimeout(graceful); clearTimeout(force); lines.close(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }
  }
}

test("host-d: owned stable MCP address follows upgrade/rollback and refuses invalid selected state", async t => {
  const root = fixture(t), installRoot = path.join(root, "selected install"), binDirectory = path.join(root, "selected bin"), projectRoot = path.join(root, "project");
  fs.mkdirSync(projectRoot);
  const first = installDistribution({ sourceRoot: source, installRoot, binDirectory });
  const selected = path.join(installRoot, "releases", first.releaseId);
  const launch = portableMcpLaunch({ client: "claude", pluginRoot: selected, projectRoot, projection: "installed-project" });
  assert.equal(launch.pathForm, "owned-install-launcher"); assert.equal(launch.cwd, fs.realpathSync(projectRoot));
  assert.equal(JSON.parse(fs.readFileSync(path.join(installRoot, "installation.json"))).binDirectory, binDirectory);
  const version = () => withOwnedMcp(t, launch.args, projectRoot, {}, async call => {
    const response = await call("initialize", { clientInfo: { name: "claude-code", version: "synthetic" } });
    assert.equal(response.result.serverInfo.name, "lode"); return response.result.serverInfo.version;
  });
  assert.equal(await version(), first.version);
  const nextSource = path.join(root, "next source"); stageDistributionRelease({ sourceRoot: source, destinationRoot: nextSource });
  for (const file of ["package.json", ".codex-plugin/plugin.json"]) {
    const target = path.join(nextSource, file), value = JSON.parse(fs.readFileSync(target)); value.version += "+host-d-fixture"; fs.writeFileSync(target, JSON.stringify(value));
  }
  const second = installDistribution({ sourceRoot: nextSource, installRoot, binDirectory });
  assert.notEqual(second.releaseId, first.releaseId); assert.equal(await version(), second.version);
  rollbackDistribution({ installRoot, binDirectory }); assert.equal(await version(), first.version);
  assert.deepEqual(portableMcpLaunch({ client: "claude", pluginRoot: selected, projectRoot, projection: "installed-project" }), launch);
  const markerFile = path.join(installRoot, "installation.json"), markerBytes = fs.readFileSync(markerFile), legacy = JSON.parse(markerBytes);
  delete legacy.binDirectory; fs.writeFileSync(markerFile, JSON.stringify(legacy));
  assert.equal(portableMcpLaunch({ client: "claude", pluginRoot: selected, projectRoot, projection: "installed-project" }).pathForm, "installed-project");
  fs.writeFileSync(markerFile, markerBytes);
  const launcherBytes = fs.readFileSync(launch.args[0]); fs.appendFileSync(launch.args[0], "\n// altered launcher\n");
  assert.throws(() => portableMcpLaunch({ client: "claude", pluginRoot: selected, projectRoot, projection: "installed-project" }), { code: "HEAD_DISTRIBUTION_COMMAND_OWNERSHIP_INVALID" });
  fs.writeFileSync(launch.args[0], launcherBytes);
  const entry = path.join(selected, "scripts", "mcp-server.mjs"), entryBytes = fs.readFileSync(entry), executed = path.join(root, "unverified-entry-executed");
  fs.appendFileSync(entry, `\nimport hostDFixtureFs from 'node:fs';hostDFixtureFs.writeFileSync(${JSON.stringify(executed)},'must never execute');\n`);
  await assert.rejects(version(), /HEAD_DISTRIBUTION_FILE_DRIFT/); assert.equal(fs.existsSync(executed), false);
  fs.writeFileSync(entry, entryBytes);
  t.diagnostic("Owned source-only installation + real local stdio processes. No provider/installed Host/plugin update.");
});

test("host-d: actual packaged plugin request omits only its own new MCP file with exact per-request provenance", async t => {
  const root = fixture(t), outputRoot = path.join(root, "claude package"), operational = path.join(root, "operational");
  const built = buildClaudeMarketplaceSnapshot({ sourceRoot: source, outputRoot });
  const pluginRoot = path.join(outputRoot, "plugins", built.pluginName), pluginEntry = path.join(pluginRoot, "scripts", "mcp-plugin-server.mjs");
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks", "claude.json")));
  const template = hooks.hooks.PreToolUse.flatMap(group => group.hooks).find(hook => hook.type === "mcp_tool" && hook.server.startsWith("plugin:"));
  assert.equal(template.input.native_project_root, "${cwd}");
  const environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: operational, LODE_PLUGIN_LOADED: "untrusted-env-does-not-prove-loading" };
  let sequence = 0;
  const initialize = async (call, projectRoot, { prepare = true, directNamespace = false, hookRoot = projectRoot,
    mismatchKey = false, mismatchArguments = false, router = false, sessionId = undefined, extra = {} } = {}) => {
    const tool = router ? "lode_tools_call" : "lode_project_initialize_or_resume", key = `fixture-tool-${++sequence}`;
    const input = { project_root: projectRoot, profile: "core", runtimes: ["claude"], ...(sessionId ? { session_id: sessionId } : {}), ...extra };
    const args = router ? { name: "lode_project_initialize_or_resume", arguments: input } : input;
    const outer = `mcp__${directNamespace ? "lode" : `plugin_${built.pluginName}_lode`}__${tool}`;
    if (prepare) {
      const fields = { "${session_id}": `fixture-native-${sequence}`, "${agent_id}": null, "${tool_use_id}": mismatchKey ? key + "-other" : key,
        "${tool_name}": outer, "${tool_input}": JSON.stringify(mismatchArguments ? { ...args, project_root: hookRoot } : args), "${cwd}": hookRoot };
      const prepared = await call("tools/call", { name: template.tool,
        arguments: Object.fromEntries(Object.entries(template.input).map(([name, value]) => [name, Object.hasOwn(fields, value) ? fields[value] : value])) });
      assert.equal(prepared.result?.isError, undefined, JSON.stringify(prepared));
    }
    const response = await call("tools/call", { name: tool, arguments: args, _meta: { "claudecode/toolUseId": key } });
    assert.equal(response.result?.isError, undefined, JSON.stringify(response)); assert.equal(response.error, undefined, JSON.stringify(response));
    return response.result.structuredContent;
  };
  const positive = path.join(root, "positive"), userInstructions = "User-authored Claude instructions remain owned by the user.\n";
  fs.mkdirSync(positive); fs.writeFileSync(path.join(positive, "CLAUDE.md"), userInstructions);
  await withOwnedMcp(t, [pluginEntry], pluginRoot, environment, async call => {
    await call("initialize", { clientInfo: { name: "claude-code", version: "synthetic" } });
    const value = await initialize(call, positive, { router: true });
    assert.equal(value.projectAction, "initialized"); assert.equal(value.project.projectRoot, fs.realpathSync(positive));
    assert.equal(fs.existsSync(path.join(positive, ".mcp.json")), false);
    assert.equal(fs.readFileSync(path.join(positive, "CLAUDE.md"), "utf8"), userInstructions);
    const manifest = JSON.parse(fs.readFileSync(path.join(positive, ".lode", "generated", "manifest.json")));
    assert(!manifest.managed.some(file => file.path === ".mcp.json"));
    const pointer = fs.readFileSync(path.join(positive, ".lode", "sessions", "current.json"));
    // The same live plugin process supplies no permanent loaded/caller proof.
    const later = await initialize(call, positive, { prepare: false, sessionId: value.project.sessionId, extra: { plugin_loaded: true } });
    assert.equal(later.projectAction, "resumed"); assert.equal(fs.existsSync(path.join(positive, ".mcp.json")), true);
    assert.deepEqual(fs.readFileSync(path.join(positive, ".lode", "sessions", "current.json")), pointer);
    assert.equal(fs.readFileSync(path.join(positive, "CLAUDE.md"), "utf8"), userInstructions);
    const managedMcp = fs.readFileSync(path.join(positive, ".mcp.json"));
    await initialize(call, positive, { sessionId: value.project.sessionId });
    assert.deepEqual(fs.readFileSync(path.join(positive, ".mcp.json")), managedMcp, "A valid plugin request cannot remove an existing managed MCP file");
    const bare = path.join(root, "fresh bare project"); fs.mkdirSync(bare);
    const bareValue = await initialize(call, bare);
    assert.equal(bareValue.projectAction, "initialized"); assert.equal(fs.existsSync(path.join(bare, ".mcp.json")), false);
    assert.equal(fs.existsSync(path.join(bare, "CLAUDE.md")), true);

    const other = path.join(root, "other Hook cwd"); fs.mkdirSync(other);
    for (const variant of ["no-hook", "project-server", "wrong-cwd", "wrong-tool-use", "wrong-arguments", "tampered-config",
      "extra-file", "extra-directory", "extra-link", "missing-readme", "user-file"]) {
      const projectRoot = path.join(root, variant); fs.mkdirSync(projectRoot);
      const userMcp = '{"mcpServers":{"user":{"command":"fixture-user-owned"}}}\n';
      if (variant === "user-file") fs.writeFileSync(path.join(projectRoot, ".mcp.json"), userMcp);
      const config = path.join(pluginRoot, ".mcp.json"), configBytes = fs.readFileSync(config);
      if (variant === "tampered-config") { const changed = JSON.parse(configBytes); changed.mcpServers.lode.args = ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs"]; fs.writeFileSync(config, JSON.stringify(changed)); }
      const unexpected = path.join(pluginRoot, "unexpected-fixture-entry"), readme = path.join(pluginRoot, "README.md"), readmeBytes = fs.readFileSync(readme);
      if (variant === "extra-file") fs.writeFileSync(unexpected, "Not in the verified source payload\n");
      if (variant === "extra-directory") fs.mkdirSync(unexpected);
      if (variant === "extra-link") fs.symlinkSync(other, unexpected, process.platform === "win32" ? "junction" : "dir");
      if (variant === "missing-readme") fs.unlinkSync(readme);
      let result;
      try { result = await initialize(call, projectRoot, { prepare: variant !== "no-hook", directNamespace: variant === "project-server",
        hookRoot: ["wrong-cwd", "wrong-arguments"].includes(variant) ? other : projectRoot,
        mismatchKey: variant === "wrong-tool-use", mismatchArguments: variant === "wrong-arguments" }); }
      finally {
        fs.writeFileSync(config, configBytes);
        if (variant === "extra-directory") fs.rmdirSync(unexpected);
        else if (["extra-file", "extra-link"].includes(variant)) fs.unlinkSync(unexpected);
        if (variant === "missing-readme") fs.writeFileSync(readme, readmeBytes);
      }
      assert.equal(result.projectAction, "initialized", variant);
      assert.equal(fs.existsSync(path.join(projectRoot, ".mcp.json")), true, variant);
      if (variant === "user-file") assert.equal(fs.readFileSync(path.join(projectRoot, ".mcp.json"), "utf8"), userMcp);
      t.diagnostic(JSON.stringify({ variant, projectMcp: "present-or-preserved", ordinarySetup: "completed" }));
    }
    assert.equal(fs.existsSync(path.join(other, ".lode")), false, "A foreign Hook cwd cannot redirect setup");
  });
  const standalone = path.join(root, "standalone same package"); fs.mkdirSync(standalone);
  await withOwnedMcp(t, [path.join(pluginRoot, "scripts", "mcp-server.mjs")], pluginRoot, environment, async call => {
    await call("initialize", { clientInfo: { name: "claude-code", version: "synthetic" } });
    const value = await initialize(call, standalone);
    assert.equal(value.projectAction, "initialized"); assert.equal(fs.existsSync(path.join(standalone, ".mcp.json")), true);
  });
  assert.deepEqual(verifyClaudeMarketplaceSnapshot({ root: outputRoot }), built);
  t.diagnostic("Packaged config/entry -> actual local stdio initialize -> exact Hook registry -> native tool -> bootstrap. No installed Host or model.");
});

test("host-d: unmanifested plugin-entry code cannot upgrade an older standalone package into plugin provenance", async t => {
  const root = fixture(t), priorSource = path.join(root, "prior source"), outputRoot = path.join(root, "prior package");
  stageDistributionRelease({ sourceRoot: source, destinationRoot: priorSource });
  const newFiles = ["scripts/mcp-plugin-server.mjs", "scripts/lib/plugin-mcp-composition.mjs"];
  for (const file of newFiles) fs.unlinkSync(path.join(priorSource, file));
  const sourceMcp = path.join(priorSource, ".mcp.json"), old = JSON.parse(fs.readFileSync(sourceMcp));
  old.mcpServers.lode.args = ["scripts/mcp-server.mjs"]; fs.writeFileSync(sourceMcp, JSON.stringify(old));
  const built = buildClaudeMarketplaceSnapshot({ sourceRoot: priorSource, outputRoot });
  const pluginRoot = path.join(outputRoot, "plugins", built.pluginName), mcp = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".mcp.json")));
  assert.deepEqual(mcp.mcpServers.lode.args, ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs"]);
  // A forged runtime can place extra files beside an otherwise valid old
  // manifest. These files are deliberately absent from its verified payload.
  for (const file of newFiles) fs.copyFileSync(path.join(source, file), path.join(pluginRoot, file));
  assert.throws(() => verifyClaudeMarketplaceSnapshot({ root: outputRoot }));
  const projectRoot = path.join(root, "project"); fs.mkdirSync(projectRoot);
  await withOwnedMcp(t, [path.join(pluginRoot, newFiles[0])], pluginRoot,
    { HEAD_AGENT_OPERATIONAL_STATE_ROOT: path.join(root, "operational") }, async call => {
      await call("initialize", { clientInfo: { name: "claude-code", version: "synthetic" } });
      const args = { project_root: projectRoot, profile: "core", runtimes: ["claude"] };
      const prepared = await call("tools/call", { name: "lode_session_host_request_prepare", arguments: {
        native_session_id: "fixture-native", native_agent_id: null, tool_use_id: "fixture-unmanifested-entry",
        outer_tool_name: `mcp__plugin_${built.pluginName}_lode__lode_project_initialize_or_resume`, native_project_root: projectRoot,
        original_arguments: JSON.stringify(args),
      } });
      assert.equal(prepared.result?.isError, undefined);
      const response = await call("tools/call", { name: "lode_project_initialize_or_resume", arguments: args,
        _meta: { "claudecode/toolUseId": "fixture-unmanifested-entry" } });
      assert.equal(response.result?.structuredContent?.projectAction, "initialized", JSON.stringify(response));
      assert.equal(fs.existsSync(path.join(projectRoot, ".mcp.json")), true, "Unknown provenance keeps standalone provisioning");
    });
});

test("host-d: failed marker publication preserves selection; explicit bin/root convergence preserves user files and P2", t => {
  const root = fixture(t), installRoot = path.join(root, "owned install"), firstBin = path.join(root, "first bin"), secondBin = path.join(root, "second bin");
  const first = installDistribution({ sourceRoot: source, installRoot, binDirectory: firstBin });
  const selected = path.join(installRoot, "releases", first.releaseId), projectRoot = path.join(root, "project"); fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot, "CLAUDE.md"), "User-owned instructions\n");
  initializeProject({ root: projectRoot, pluginRoot: selected, runtimes: ["claude"] });
  const pointerFile = path.join(installRoot, "current.json"), markerFile = path.join(installRoot, "installation.json");
  const pointer = fs.readFileSync(pointerFile), marker = fs.readFileSync(markerFile), oldCommands = inventory(firstBin);
  const session = path.join(projectRoot, ".lode", "sessions", "current.json"), sessionBytes = fs.readFileSync(session);
  const nextSource = path.join(root, "updated source"); stageDistributionRelease({ sourceRoot: source, destinationRoot: nextSource });
  fs.appendFileSync(path.join(nextSource, "README.md"), "\nSynthetic install selection fixture.\n");
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (path.resolve(to) === markerFile && String(from).endsWith(".tmp")) throw Object.assign(new Error("Synthetic marker publication failure"), { code: "EACCES" });
    return rename(from, to);
  };
  try { assert.throws(() => installDistribution({ sourceRoot: nextSource, installRoot, binDirectory: secondBin }), /Synthetic marker publication failure/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(pointerFile), pointer); assert.deepEqual(fs.readFileSync(markerFile), marker);
  assert.deepEqual(inventory(firstBin), oldCommands); assert(!fs.readdirSync(installRoot).some(name => /\.(tmp|previous)$/.test(name)));
  const foreignBin = path.join(root, "foreign bin"); fs.mkdirSync(foreignBin);
  const foreign = path.join(foreignBin, "lode-agent-launcher.mjs"), foreignBytes = "// user-owned command\n"; fs.writeFileSync(foreign, foreignBytes);
  assert.throws(() => installDistribution({ sourceRoot: nextSource, installRoot, binDirectory: foreignBin }), { code: "HEAD_DISTRIBUTION_COMMAND_CONFLICT" });
  assert.equal(fs.readFileSync(foreign, "utf8"), foreignBytes); assert.deepEqual(fs.readFileSync(markerFile), marker);
  const upgraded = installDistribution({ sourceRoot: nextSource, installRoot, binDirectory: secondBin });
  assert.notEqual(upgraded.releaseId, first.releaseId); assert.deepEqual(inventory(firstBin), oldCommands);
  assert.equal(JSON.parse(fs.readFileSync(markerFile)).binDirectory, secondBin);
  convergeProjectInstallation({ root: projectRoot, pluginRoot: path.join(installRoot, "releases", upgraded.releaseId) });
  const changed = JSON.parse(fs.readFileSync(path.join(projectRoot, ".mcp.json")));
  assert.equal(changed.mcpServers.lode.args[0], path.join(secondBin, "lode-agent-launcher.mjs"));
  assert.deepEqual(fs.readFileSync(session), sessionBytes); assert.equal(fs.readFileSync(path.join(projectRoot, "CLAUDE.md"), "utf8"), "User-owned instructions\n");
  const moved = path.join(root, "moved install");
  for (const target of [installRoot, moved]) assert(path.resolve(target).startsWith(path.resolve(root) + path.sep), "Recursive move must stay inside the owned fixture");
  fs.renameSync(installRoot, moved);
  assert.throws(() => portableMcpLaunch({ client: "claude", pluginRoot: path.join(moved, "releases", upgraded.releaseId), projectRoot, projection: "installed-project" }));
  const explicitBin = path.join(root, "explicit replacement bin");
  const replaced = installDistribution({ sourceRoot: nextSource, installRoot: moved, binDirectory: explicitBin });
  convergeProjectInstallation({ root: projectRoot, pluginRoot: path.join(moved, "releases", replaced.releaseId) });
  assert.equal(JSON.parse(fs.readFileSync(path.join(projectRoot, ".mcp.json"))).mcpServers.lode.args[0], path.join(explicitBin, "lode-agent-launcher.mjs"));
  assert.deepEqual(fs.readFileSync(session), sessionBytes); assert.equal(fs.readFileSync(path.join(projectRoot, "CLAUDE.md"), "utf8"), "User-owned instructions\n");
});

test("host-d: verified plugin child rejection precedes Project/P5 reads and cannot gain installation authority", async t => {
  const root = fixture(t), outputRoot = path.join(root, "package"), operational = path.join(root, "operational");
  const built = buildClaudeMarketplaceSnapshot({ sourceRoot: source, outputRoot }), pluginRoot = path.join(outputRoot, "plugins", built.pluginName);
  const projectRoot = path.join(root, "protected project"); fs.mkdirSync(projectRoot);
  const absentRoot = path.join(root, "absent Project"), controlRoot = path.join(root, "parent control"); fs.mkdirSync(absentRoot); fs.mkdirSync(controlRoot);
  initializeProject({ root: projectRoot, pluginRoot, runtimes: ["claude"] });
  const before = inventory(projectRoot), log = path.join(root, "read-audit.jsonl"), preload = path.join(root, "read-audit.mjs");
  fs.writeFileSync(log, "");
  fs.writeFileSync(preload, [
    "import fs from 'node:fs';import path from 'node:path';",
    `const roots=${JSON.stringify([projectRoot, absentRoot, operational])},log=${JSON.stringify(log)};`,
    "const read=fs.readFileSync,open=fs.openSync;const mark=file=>{if(typeof file==='string'&&roots.some(root=>path.resolve(file).startsWith(root+path.sep)))fs.appendFileSync(log,JSON.stringify({file})+String.fromCharCode(10));};",
    "fs.readFileSync=function(file,...args){mark(file);return read.call(this,file,...args)};fs.openSync=function(file,...args){mark(file);return open.call(this,file,...args)};",
  ].join("\n"));
  await withOwnedMcp(t, ["--import", pathToFileURL(preload).href, path.join(pluginRoot, "scripts", "mcp-plugin-server.mjs")], pluginRoot,
    { HEAD_AGENT_OPERATIONAL_STATE_ROOT: operational, LODE_SUBAGENT_WRITE_GUARD: "" }, async call => {
      await call("initialize", { clientInfo: { name: "claude-code", version: "synthetic" } });
      const invoke = async (target, agentId, router, key) => {
        const tool = router ? "lode_tools_call" : "lode_project_initialize_or_resume";
        const input = { project_root: target, profile: "core", runtimes: ["claude"] };
        const args = router ? { name: "lode_project_initialize_or_resume", arguments: input } : input;
        const prepared = await call("tools/call", { name: "lode_session_host_request_prepare", arguments: {
          native_session_id: "fixture-parent", native_agent_id: agentId, tool_use_id: key,
          outer_tool_name: `mcp__plugin_${built.pluginName}_lode__${tool}`, native_project_root: target, original_arguments: JSON.stringify(args),
        } });
        assert.equal(prepared.result?.isError, undefined);
        return call("tools/call", { name: tool, arguments: args, _meta: { "claudecode/toolUseId": key } });
      };
      const parent = await invoke(controlRoot, null, false, "fixture-parent-control");
      assert.equal(parent.result?.structuredContent?.projectAction, "initialized");
      assert.equal(fs.existsSync(path.join(controlRoot, ".mcp.json")), false, "The instrumented process must exercise valid plugin provenance in its positive control");
      for (const [index, [target, router]] of [[projectRoot, false], [projectRoot, true], [absentRoot, false], [absentRoot, true]].entries()) {
        fs.writeFileSync(log, "");
        const response = await invoke(target, "fixture-child", router, `fixture-protected-child-${index}`);
        assert(JSON.stringify(response).includes("SUBAGENT_STATE_WRITE_REJECTED"));
        assert.equal(fs.readFileSync(log, "utf8"), "", "Installation optimization must not read protected originals or P5 before the shared rejection");
      }
    });
  assert.deepEqual(inventory(projectRoot), before);
  assert.equal(fs.existsSync(path.join(absentRoot, ".lode")), false);
});

test("CI publishes canonical and compatibility identities to separate exact branches", () => {
  const workflow = read(".github/workflows/go-worker-build-release.yml");
  for (const [job, next, provider] of [["marketplace", "claude_marketplace", "codex"], ["claude_marketplace", null, "claude"]]) {
    const start = workflow.indexOf(`  ${job}:\n`);
    assert(start >= 0);
    const body = workflow.slice(start, next ? workflow.indexOf(`  ${next}:\n`, start) : undefined);
    const rows = [...body.matchAll(/- identity: (\w+)\n +marketplace_name: ([\w-]+)\n +branch: ([\w-]+)/g)]
      .map(([, identity, name, branch]) => ({ identity, name, branch }));
    assert.deepEqual(rows, [
      { identity: "lode", name: "lode-agent-plugin", branch: `lode-${provider}-marketplace` },
      { identity: "head", name: "head-agent-plugin", branch: `${provider}-marketplace` },
    ]);
    assert(body.includes("fail-fast: false"), "One carrier's failure must not cancel its independent sibling");
    for (const expected of [
      "MARKETPLACE_BRANCH: ${{ matrix.branch }}", "MARKETPLACE_NAME: ${{ matrix.marketplace_name }}",
      '--marketplace-name "${MARKETPLACE_NAME}"', '--expected-marketplace-name "${MARKETPLACE_NAME}"',
      '--source-commit "${GITHUB_SHA}"', "--require-native", "--native-root",
      '--force-with-lease="refs/heads/${MARKETPLACE_BRANCH}:${EXPECTED_SHA}"',
      'if [[ "${MARKETPLACE_NAME}" != "head-agent-plugin" ]]; then exit 1; fi',
    ]) assert(body.includes(expected), `${job} missing ${expected}`);
    assert.match(body, /MARKETPLACE_NAME.*head-agent-plugin.*GITHUB_REPOSITORY.*binary1215\/lode.*expected_sha/);
    assert(body.indexOf('if [[ "${MARKETPLACE_NAME}" != "head-agent-plugin" ]]') < body.indexOf("node legacy/marketplace-ownership/verify.mjs"));
    assert.match(body, /needs\.javascript\.result == 'success'.*needs\.host_smoke\.result == 'success'/);
  }
});

test("English and Korean defaults use Lode installation, while legacy updates stay documented", () => {
  for (const file of ["README.md", "README.ko.md"]) {
    const text = read(file);
    for (const command of [
      "codex plugin marketplace add binary1215/lode --ref lode-codex-marketplace",
      "codex plugin add lode-agent-core@lode-agent-plugin",
      "claude plugin marketplace add binary1215/lode@lode-claude-marketplace",
      "claude plugin install lode-agent-core@lode-agent-plugin",
      "codex plugin marketplace upgrade head-agent-plugin",
      "claude plugin update head-agent-core@head-agent-plugin",
    ]) assert(text.includes(command), `${file}: ${command}`);
    assert(text.indexOf("lode-agent-core@lode-agent-plugin") < text.indexOf("head-agent-core@head-agent-plugin"));
  }
  for (const prefix of ["docs/", "docs/ko/"]) {
    for (const provider of ["codex", "claude"]) {
      const text = read(`${prefix}${provider}-marketplace.md`);
      assert(text.includes(`lode-${provider}-marketplace`));
      assert(text.includes("lode-agent-core@lode-agent-plugin"));
      assert(text.includes("head-agent-core@head-agent-plugin"));
      assert(text.indexOf("lode-agent-core@lode-agent-plugin") < text.indexOf("head-agent-core@head-agent-plugin"));
    }
  }
});

for (const [provider, build, verify, catalogPath] of [
  ["codex", buildCodexMarketplaceSnapshot, verifyCodexMarketplaceSnapshot, ".agents/plugins/marketplace.json"],
  ["claude", buildClaudeMarketplaceSnapshot, verifyClaudeMarketplaceSnapshot, ".claude-plugin/marketplace.json"],
]) {
  test(`${provider} snapshots keep separate install IDs, manifests, Skills and one tool vocabulary`, async t => {
    const root = fixture(t), oldRoot = path.join(root, "existing-head-address");
    const options = { sourceRoot: source, repository: "binary1215/lode", commit: "a".repeat(40) };
    const old = build({ ...options, outputRoot: oldRoot, name: "head-agent-plugin" });
    const original = inventory(oldRoot);
    for (const identity of ["lode", "head"]) {
      const composition = artifactCompositionForIdentity(identity);
      const outputRoot = identity === "head" ? oldRoot : path.join(root, "new-lode-address");
      const built = identity === "head" ? old : build({ ...options, outputRoot, name: composition.marketplaceName });
      assert.deepEqual(verify({ root: outputRoot, expectedRepository: options.repository, expectedMarketplaceName: composition.marketplaceName }), built);
      const catalog = JSON.parse(fs.readFileSync(path.join(outputRoot, catalogPath), "utf8"));
      assert.equal(catalog.name, composition.marketplaceName);
      assert.equal(catalog.plugins.length, 1);
      assert.equal(catalog.plugins[0].name, composition.pluginName);
      assert.deepEqual(fs.readdirSync(path.join(outputRoot, "plugins")), [composition.pluginName]);
      const pluginRoot = path.join(outputRoot, "plugins", composition.pluginName);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8")).engines,
        JSON.parse(read("package.json")).engines, "Declared Node support must survive all four package projections");
      assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")).mcpServers), ["lode"]);
      assert.deepEqual(fs.readdirSync(path.join(pluginRoot, "skills")).sort(), Object.values(composition.skills).sort());
      const staged = await import(pathToFileURL(path.join(pluginRoot, "scripts/mcp-server.mjs")).href);
      assert(staged.tools.every(tool => tool.name.startsWith(composition.toolPrefix)));
      assert.equal(new Set(staged.tools.map(tool => tool.name)).size, staged.tools.length);
      assert.equal((await staged.dispatch({ id: 1, method: "initialize", params: {} })).result.serverInfo.name, "lode");
      assert.throws(() => verify({ root: outputRoot, expectedMarketplaceName: identity === "head" ? "lode-agent-plugin" : "head-agent-plugin" }));
      assert.throws(() => verify({ root: outputRoot, requireNativeBundle: true }), "Source-only snapshots cannot pass a native publication check");
      const marker = JSON.parse(fs.readFileSync(path.join(outputRoot, `.${identity}-agent-${provider === "claude" ? "claude-" : ""}marketplace-generated.json`), "utf8"));
      assert.equal(marker.sourceCommit, options.commit);
      assert.equal(marker.pluginName, composition.pluginName);
      assert.equal(marker.marketplaceName, composition.marketplaceName);
    }
    assert.deepEqual(inventory(oldRoot), original, "Canonical generation/verification cannot mutate a sibling HEAD snapshot");
  });
}
