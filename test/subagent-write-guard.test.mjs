import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject } from "../scripts/lib/lode-core.mjs";
import { createNativeSessionHostBridge } from "../scripts/lib/session-native-host.mjs";
import { SESSION_HOST_REQUEST_HELPER, createSessionHostRequestRegistry } from "../scripts/lib/session-host-request.mjs";
import { observeNativeHook } from "../scripts/lib/native-session-observations.mjs";
import { SUBAGENT_STATE_WRITE_REJECTED, SUBAGENT_WRITE_GUARD_INVALID, diagnoseSubagentWriteGuard, subagentWriteGuardEnabled } from "../scripts/lib/subagent-write-guard.mjs";
import { dispatch, catalogTools } from "../scripts/mcp-server.mjs";
import { resolveOperation } from "../scripts/lib/lode-operation-contract.mjs";
import plugin from "../scripts/opencode-plugin.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");

function project(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-subagent-guard-")));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  initializeProject({ root, pluginRoot, runtimes: ["claude", "codex", "opencode"] });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const operational = path.join(base, "operational");
  const environment = enforced => ({
    HEAD_AGENT_OPERATIONAL_STATE_ROOT: operational,
    LODE_SUBAGENT_WRITE_GUARD: enforced ? "enforce" : "off",
  });
  const canon = () => fs.readdirSync(path.join(root, ".lode"), { recursive: true }).sort();
  return { base, root, operational, environment, canon };
}

const rejected = response => response?.error?.message?.includes(SUBAGENT_STATE_WRITE_REJECTED) === true;

test("supported-default: only exact Claude/OpenCode child provenance enables unset policy", () => {
  for (const value of [undefined, null, ""]) for (const runtime of ["claude", "opencode", "codex", "unknown"]) {
    for (const correlation of [undefined, "signal-only", "exact-native-tool-use", "awaited-native-before-hook"]) for (const subagent of [false, true]) {
      const caller = { runtime, correlation, subagent }, environment = { LODE_SUBAGENT_WRITE_GUARD: value };
      const expected = subagent && (runtime === "claude" && correlation === "exact-native-tool-use" || runtime === "opencode" && correlation === "awaited-native-before-hook");
      assert.equal(subagentWriteGuardEnabled(environment, { caller }), expected);
      assert.equal(subagentWriteGuardEnabled({ LODE_SUBAGENT_WRITE_GUARD: "off" }, { caller }), false);
      assert.equal(subagentWriteGuardEnabled({ LODE_SUBAGENT_WRITE_GUARD: "enforce" }, { caller }), true);
    }
  }
});

test("supported-default: actual Claude exact hooks protect every catalog write without Session or inventory reads", async t => {
  const { root, operational, canon } = project(t), before = canon();
  const environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: operational };
  const native = createNativeSessionHostBridge({ runtime: "claude", environment }); t.after(() => native.dispose());
  let sequence = 0, forbidden = 0;
  const read = fs.readFileSync;
  fs.readFileSync = (file, ...args) => { const name = String(file).replaceAll("\\", "/");
    if (name.includes("/.lode/sessions/") || name.includes("/.lode/graph-discovery/") || name.startsWith(operational.replaceAll("\\", "/"))) {
      forbidden++; throw new Error("Guard-only correlation must not read Session/P2/inventory/P5 files");
    } return read(file, ...args); };
  try {
    for (const tool of catalogTools.filter(tool => tool.annotations?.readOnlyHint !== true)) for (const name of [tool.name, resolveOperation(tool.name).legacyName]) for (const routed of [false, true]) {
      const wire = claudeWire(root, name, {}, `default-child-${sequence++}`, routed);
      assert.equal(rejected(await claudeCall(native, wire, "verified-child")), true, tool.name + "/" + routed);
      assert.equal(native.requestStatus().pending, 0); assert.equal(native.requestStatus().active, 0);
    }
  } finally { fs.readFileSync = read; }
  assert.equal(forbidden, 0); assert.deepEqual(canon(), before); assert.equal(fs.existsSync(operational), false);
});

test("supported-default: Claude off avoids new Project-only correlation and exact siblings stay distinct", async t => {
  const { root, operational } = project(t), environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: operational };
  const off = createNativeSessionHostBridge({ runtime: "claude", environment: { ...environment, LODE_SUBAGENT_WRITE_GUARD: "off" } }); t.after(() => off.dispose());
  const offWire = claudeWire(root, "lode_session_create", { purpose: "explicit off" }, "off-project");
  await dispatch(claudeHook(offWire, "native", "child"), { nativeSessionBridge: off }); assert.equal(off.requestStatus().pending, 0);
  const offResult = await dispatch(offWire, { nativeSessionBridge: off }); assert.equal(rejected(offResult), false); assert(offResult.result.structuredContent.sessionId);
  assert.equal(off.requestStatus().spent, 0);
  const native = createNativeSessionHostBridge({ runtime: "claude", environment }); t.after(() => native.dispose());
  const shared = { purpose: "same arguments" }, wires = ["first-child", "parent", "second-child"].map(id => claudeWire(root, "lode_session_create", shared, id));
  for (const [index, wire] of wires.entries()) await dispatch(claudeHook(wire, "native", index === 1 ? "" : "child-" + index), { nativeSessionBridge: native });
  const results = await Promise.all(wires.map(wire => dispatch(wire, { nativeSessionBridge: native })));
  assert.equal(rejected(results[0]), true); assert.equal(rejected(results[2]), true); assert.equal(rejected(results[1]), false); assert(results[1].result.structuredContent.sessionId);
  assert.equal(native.requestStatus().pending, 0);
  const bad = claudeHook(claudeWire(root, "lode_session_create", shared, "foreign-server"), "native", "child");
  bad.params.arguments.outer_tool_name = "mcp__other__lode_session_create";
  assert.equal((await dispatch(bad, { nativeSessionBridge: native })).result.isError, true);
});

test("supported-default: actual OpenCode before-hook requires exact call scope and never looks up reads or source tools", async t => {
  const { root, operational } = project(t), environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: operational }; let lookups = 0;
  const client = { session: { async get({ path: { id } }) { lookups++; return { data: { id, projectID: "host-project", directory: root,
    ...(id === "ses_parent" ? {} : { parentID: "ses_parent" }) } }; } } };
  const hooks = await plugin.server({ client, project: { id: "host-project" }, directory: root }, { environment }); t.after(() => hooks.dispose());
  await hooks.config({ mcp: { lode: { type: "local", command: ["node", path.join(pluginRoot, "scripts/mcp-server.mjs")] } } });
  for (const tool of ["Edit", "Write", "Bash", "other_lode_session_create", "lode_lode_project_status"]) await hooks["tool.execute.before"]({ tool, sessionID: "ses_child", callID: "read-or-source" }, { args: { project_root: root } });
  await hooks["tool.execute.before"]({ tool: "lode_lode_session_create", sessionID: "ses_child" }, { args: { project_root: root } });
  assert.equal(lookups, 0);
  await assert.rejects(hooks["tool.execute.before"]({ tool: "lode_lode_session_create", sessionID: "ses_child", callID: "exact-child" }, { args: { project_root: root } }), { code: SUBAGENT_STATE_WRITE_REJECTED });
  await hooks["tool.execute.before"]({ tool: "lode_lode_session_create", sessionID: "ses_parent", callID: "exact-parent" }, { args: { project_root: root } });
  assert.equal(lookups, 2);
  const off = await plugin.server({ client, project: { id: "host-project" }, directory: root }, { environment: { ...environment, LODE_SUBAGENT_WRITE_GUARD: "off" } }); t.after(() => off.dispose());
  await off.config({ mcp: { lode: { type: "local", command: ["node", path.join(pluginRoot, "scripts/mcp-server.mjs")] } } });
  await off["tool.execute.before"]({ tool: "lode_lode_session_create", sessionID: "ses_child", callID: "off-child" }, { args: { project_root: root } });
  assert.equal(lookups, 2); assert.equal(fs.existsSync(operational), false);
});

test("supported-default: signal-only, spent, divergent and expired claims never become exact provenance", async t => {
  const { root, operational } = project(t), environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: operational }; let time = 0;
  const registry = createSessionHostRequestRegistry({ now: () => time, ttlMs: 10 });
  const native = createNativeSessionHostBridge({ runtime: "claude", environment, requestRegistry: registry }); t.after(() => native.dispose());
  const capture = wire => native.dispatch(wire, async (_request, options) => options.caller);
  const wire = claudeWire(root, "lode_session_create", { purpose: "capture only; never execute" }, "exact-once");
  await dispatch(claudeHook(wire, "native", "child"), { nativeSessionBridge: native });
  const exact = await capture(wire); assert.equal(exact.correlation, "exact-native-tool-use"); assert.equal(subagentWriteGuardEnabled(environment, { caller: exact }), true);
  assert.equal(await capture(wire), null); assert.equal(registry.describe().spent, 1);
  const divergent = claudeWire(root, "lode_session_create", { purpose: "unchanged" }, "divergent");
  await dispatch(claudeHook(divergent, "native", "child"), { nativeSessionBridge: native }); divergent.params.arguments.purpose = "different";
  assert.equal(await capture(divergent), null);
  const expired = claudeWire(root, "lode_session_create", { purpose: "expires" }, "expired");
  await dispatch(claudeHook(expired, "native", "child"), { nativeSessionBridge: native }); time = 11;
  assert.equal(await capture(expired), null);
  const read = claudeWire(root, "lode_project_graph", {}, "signal-only");
  await dispatch(claudeHook(read, "native", "child"), { nativeSessionBridge: native });
  const signal = await capture(read); assert.equal(signal.subagent, true); assert.equal(signal.correlation, undefined);
  assert.equal(subagentWriteGuardEnabled(environment, { caller: signal }), false);
  assert.equal(fs.existsSync(operational), false);
});

test("supported-default: Codex unset and unsupported OpenCode scope remain ordinary work, not protection success", async t => {
  const { root, operational } = project(t), environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: operational };
  const codex = createNativeSessionHostBridge({ runtime: "codex", environment }); t.after(() => codex.dispose());
  const result = await dispatch({ jsonrpc: "2.0", id: "codex-unset", method: "tools/call", params: {
    _meta: { threadId: "codex-parent", subagent: true }, name: "lode_session_create", arguments: { project_root: root, purpose: "Codex default remains off" } } }, { nativeSessionBridge: codex });
  assert.equal(rejected(result), false); assert(result.result.structuredContent.sessionId);
  for (const variant of ["project", "directory", "error", "timeout"]) {
    const hooks = await plugin.server({ client: { session: { get() {
      if (variant === "timeout") return new Promise(() => {});
      if (variant === "error") throw new Error("Synthetic lookup failure");
      return Promise.resolve({ data: { id: "ses_child", projectID: variant === "project" ? "other" : "host-project",
        directory: variant === "directory" ? path.dirname(root) : root, parentID: "ses_parent" } });
    } } }, project: { id: "host-project" }, directory: root }, { environment });
    try {
      await hooks.config({ mcp: { lode: { type: "local", command: ["node", path.join(pluginRoot, "scripts/mcp-server.mjs")] } } });
      await hooks["tool.execute.before"]({ tool: "lode_lode_session_create", sessionID: "ses_child", callID: "unknown-" + variant }, { args: { project_root: root } });
    } finally { hooks.dispose(); }
  }
});

test("guard configuration typos warn without enabling unproven callers or blocking ordinary work", () => {
  const messages = [], warn = message => messages.push(message);
  for (const value of [undefined, null, "", "off", "enforce"]) {
    const environment = { LODE_SUBAGENT_WRITE_GUARD: value };
    assert.deepEqual(diagnoseSubagentWriteGuard(environment), { enabled: value === "enforce", valid: true });
    assert.equal(subagentWriteGuardEnabled(environment, { warn }), value === "enforce");
  }
  assert.deepEqual(messages, []);
  for (const value of ["ENFORCE", "enforce ", "true", "synthetic-secret-do-not-echo"]) {
    const environment = { LODE_SUBAGENT_WRITE_GUARD: value }, count = messages.length;
    assert.equal(diagnoseSubagentWriteGuard(environment).code, SUBAGENT_WRITE_GUARD_INVALID);
    assert.equal(subagentWriteGuardEnabled(environment, { warn }), false);
    assert.equal(subagentWriteGuardEnabled(environment, { warn }), false);
    assert.equal(messages.length, count + 1, "Repeated calls do not flood stderr.");
    assert.match(messages.at(-1), /protection is OFF/);
    assert.equal(messages.at(-1).includes(value), false, "Untrusted environment content is not printed.");
  }
  assert.equal(subagentWriteGuardEnabled({}, { warn }), false);
  assert.equal(subagentWriteGuardEnabled({ LODE_SUBAGENT_WRITE_GUARD: "ENFORCE" }, { warn() { throw new Error("stderr unavailable"); } }), false);
  subagentWriteGuardEnabled({}, { warn });
});

test("every effectful catalog operation rejects a child before its handler, direct and routed", async t => {
  const { root, canon, environment } = project(t), before = canon();
  const effectful = catalogTools.filter(tool => tool.annotations?.readOnlyHint !== true);
  assert.ok(effectful.length >= 54, "Do not silently shrink existing write coverage.");
  for (const tool of effectful) for (const routed of [false, true]) {
    const response = await dispatch({ jsonrpc: "2.0", id: tool.name, method: "tools/call", params: {
      name: routed ? "lode_tools_call" : tool.name,
      arguments: routed ? { name: tool.name, arguments: { project_root: root } } : { project_root: root },
    } }, { surface: "managed-maintenance", caller: { subagent: true }, hostEnvironment: environment(true) });
    assert.equal(rejected(response), true, `${tool.name}, routed=${routed}: ${JSON.stringify(response)}`);
  }
  assert.deepEqual(canon(), before, "No operation handler reached canonical writes.");
});

function claudeWire(root, name, args, id, routed = false) {
  const request = {
    jsonrpc: "2.0", id, method: "tools/call",
    params: {
      _meta: { "claudecode/toolUseId": id },
      name: routed ? "head_tools_call" : name,
      arguments: routed ? { name, arguments: { project_root: root, ...args } } : { project_root: root, ...args },
    },
  };
  return request;
}

function claudeHook(wire, nativeSessionId, agentId) {
  return {
    id: "hook", method: "tools/call",
    params: {
      name: SESSION_HOST_REQUEST_HELPER,
      arguments: {
        native_session_id: nativeSessionId,
        native_agent_id: agentId,
        tool_use_id: wire.params._meta["claudecode/toolUseId"],
        outer_tool_name: "mcp__lode__" + wire.params.name,
        original_arguments: JSON.stringify(wire.params.arguments),
      },
    },
  };
}

async function claudeCall(bridge, wire, agentId) {
  const prepared = await dispatch(claudeHook(wire, "native-claude-root", agentId), { nativeSessionBridge: bridge });
  assert.equal(prepared.result?.isError, undefined);
  return dispatch(wire, { nativeSessionBridge: bridge });
}

test("Claude explicit enforce/off separate child writes from parent and read access", async t => {
  const { root, environment, canon } = project(t);
  const enforced = createNativeSessionHostBridge({ runtime: "claude", environment: environment(true) });
  const child = claudeWire(root, "head_session_create", { purpose: "child canon" }, "claude-child", true);
  const before = canon();
  const blocked = await claudeCall(enforced, child, "agent-child");
  assert.equal(rejected(blocked), true);
  assert.deepEqual(canon(), before, "A rejected subagent write does not change canon.");
  const status = await claudeCall(enforced, claudeWire(root, "head_project_status", {}, "claude-read"), "agent-child");
  assert.equal(rejected(status), false);
  assert.equal(status.result?.structuredContent?.project?.projectId != null || status.result?.structuredContent?.status != null || status.result?.content != null, true);
  const parent = await claudeCall(enforced, claudeWire(root, "head_session_create", { purpose: "parent canon" }, "claude-parent", true), "");
  assert.equal(rejected(parent), false);
  assert.equal(typeof parent.result?.structuredContent?.sessionId, "string");
  const checkpoint = await claudeCall(enforced, claudeWire(root, "head_checkpoint_sync", { purpose: "child checkpoint" }, "claude-checkpoint"), "agent-checkpoint");
  assert.equal(rejected(checkpoint), true);
  const open = createNativeSessionHostBridge({ runtime: "claude", environment: environment(false) });
  const allowed = await claudeCall(open, claudeWire(root, "head_session_create", { purpose: "guard off" }, "claude-off", true), "agent-off");
  assert.equal(rejected(allowed), false);
  assert.equal(typeof allowed.result?.structuredContent?.sessionId, "string");
  enforced.dispose();
  open.dispose();
});

test("Codex subagent meta and SubagentStart observations reject state writes when enforced", async t => {
  const { root, environment, canon } = project(t);
  const bridge = createNativeSessionHostBridge({ runtime: "codex", environment: environment(true) });
  const call = (threadId, extra = {}, purpose = "codex child") => dispatch({
    jsonrpc: "2.0", id: purpose, method: "tools/call",
    params: {
      _meta: { threadId, ...extra },
      name: "head_session_create",
      arguments: { project_root: root, purpose },
    },
  }, { nativeSessionBridge: bridge });
  const before = canon();
  assert.equal(rejected(await call("parent-thread", { agent_id: "child-agent" }, "meta agent")), true);
  assert.equal(rejected(await call("parent-thread", { subagent: true }, "meta flag")), true);
  assert.deepEqual(canon(), before);
  const parent = await call("parent-thread", {}, "parent write");
  assert.equal(rejected(parent), false);
  assert.equal(typeof parent.result?.structuredContent?.sessionId, "string");
  const read = await dispatch({
    jsonrpc: "2.0", id: "codex-read", method: "tools/call",
    params: { _meta: { threadId: "parent-thread", subagent: true }, name: "head_project_status", arguments: { project_root: root } },
  }, { nativeSessionBridge: bridge });
  assert.equal(rejected(read), false);
  assert.equal(read.error, undefined);
  await observeNativeHook({
    runtime: "codex", environment: environment(true),
    event: { hook_event_name: "SubagentStart", session_id: "parent-thread", agent_id: "observed-child", cwd: root, turn_id: "turn-child" },
  });
  assert.equal(rejected(await call("observed-child", {}, "observed child")), true);
  const quiet = createNativeSessionHostBridge({ runtime: "codex", environment: environment(false) });
  const off = await dispatch({
    jsonrpc: "2.0", id: "codex-off", method: "tools/call",
    params: { _meta: { threadId: "parent-thread", subagent: true }, name: "head_session_create", arguments: { project_root: root, purpose: "guard off" } },
  }, { nativeSessionBridge: quiet });
  assert.equal(rejected(off), false);
  assert.equal(typeof off.result?.structuredContent?.sessionId, "string");
  bridge.dispose();
  quiet.dispose();
});

test("OpenCode rejects the exact child call before MCP execution while reads and parents remain available", async t => {
  const { root, operational, environment, canon } = project(t);
  const child = "ses_child";
  const client = { session: {
    async get() { return { data: { id: child, projectID: "host-project", directory: root, parentID: "ses_parent" } }; },
    async status() { return { data: {} }; },
  } };
  const enforcedHooks = await plugin.server({ client, project: { id: "host-project" }, directory: root }, { environment: environment(true) });
  t.after(() => enforcedHooks.dispose());
  await enforcedHooks.config({ mcp: { my_head: { type: "local", command: ["node", path.join(pluginRoot, "scripts/mcp-server.mjs")] } } });
  const bridge = createNativeSessionHostBridge({ environment: environment(true) });
  t.after(() => bridge.dispose());
  const before = canon();
  await assert.rejects(enforcedHooks["tool.execute.before"]({
    tool: "my_head_lode_session_create", sessionID: child, callID: "call-child",
  }, { args: { project_root: root, purpose: "child session" } }), { code: SUBAGENT_STATE_WRITE_REJECTED });
  assert.deepEqual(canon(), before);
  await assert.rejects(enforcedHooks["tool.execute.before"]({
    tool: "my_head_head_tools_call", sessionID: child, callID: "call-router",
  }, { args: { name: "head_checkpoint_sync", arguments: { project_root: root, purpose: "routed child" } } }), { code: SUBAGENT_STATE_WRITE_REJECTED });
  await enforcedHooks["tool.execute.before"]({
    tool: "my_head_head_project_status", sessionID: child, callID: "call-read",
  }, { args: { project_root: root } });
  const read = await dispatch({
    jsonrpc: "2.0", id: "opencode-read", method: "tools/call",
    params: { name: "head_project_status", arguments: { project_root: root } },
  }, { nativeSessionBridge: bridge });
  assert.equal(rejected(read), false);
  assert.equal(read.error, undefined);
  const parentClient = { session: {
    async get() { return { data: { id: "ses_parent", projectID: "host-project", directory: root } }; },
    async status() { return { data: {} }; },
  } };
  const parentHooks = await plugin.server({ client: parentClient, project: { id: "host-project" }, directory: root }, { environment: environment(true) });
  t.after(() => parentHooks.dispose());
  await parentHooks.config({ mcp: { my_head: { type: "local", command: ["node", path.join(pluginRoot, "scripts/mcp-server.mjs")] } } });
  await parentHooks["tool.execute.before"]({
    tool: "my_head_lode_session_create", sessionID: "ses_parent", callID: "call-parent",
  }, { args: { project_root: root, purpose: "parent session" } });
  const parent = await dispatch({
    jsonrpc: "2.0", id: "opencode-parent", method: "tools/call",
    params: { name: "lode_session_create", arguments: { project_root: root, purpose: "parent session" } },
  }, { nativeSessionBridge: bridge });
  assert.equal(rejected(parent), false);
  assert.equal(typeof parent.result?.structuredContent?.sessionId, "string");
  const offHooks = await plugin.server({ client, project: { id: "host-project" }, directory: root }, { environment: environment(false) });
  t.after(() => offHooks.dispose());
  await offHooks.config({ mcp: { my_head: { type: "local", command: ["node", path.join(pluginRoot, "scripts/mcp-server.mjs")] } } });
  const signals = path.join(operational, "subagent-caller-signals");
  const beforeOff = fs.existsSync(signals) ? fs.readdirSync(signals).sort() : [];
  await offHooks["tool.execute.before"]({
    tool: "my_head_lode_session_create", sessionID: child, callID: "call-off",
  }, { args: { project_root: root, purpose: "guard off" } });
  const afterOff = fs.existsSync(signals) ? fs.readdirSync(signals).sort() : [];
  assert.deepEqual(afterOff, beforeOff, "Neither enabled nor disabled guard publishes a cross-call ticket.");
  const quiet = createNativeSessionHostBridge({ environment: environment(false) });
  t.after(() => quiet.dispose());
  const allowed = await dispatch({
    jsonrpc: "2.0", id: "opencode-off", method: "tools/call",
    params: { name: "lode_session_create", arguments: { project_root: root, purpose: "guard off" } },
  }, { nativeSessionBridge: quiet });
  assert.equal(rejected(allowed), false);
  assert.equal(typeof allowed.result?.structuredContent?.sessionId, "string");
});


test('review regression: identical OpenCode parent and child calls cannot exchange guard identity', async t => {
  const { root, operational, environment } = project(t);
  const hooks = await plugin.server({ client: { session: {
    async get({path:{id}}) { return {data:{id,projectID:'host-project',directory:root,...(id==='ses_parent'?{}:{parentID:'ses_parent'})}}; },
  } }, project:{id:'host-project'},directory:root },{environment:environment(true)});
  t.after(()=>hooks.dispose());
  await hooks.config({mcp:{lode:{type:'local',command:['node',path.join(pluginRoot,'scripts/mcp-server.mjs')]}}});
  const bridge=createNativeSessionHostBridge({environment:environment(true)});t.after(()=>bridge.dispose());
  const args={project_root:root,purpose:'same request'};
  const invoke=async(sessionID,callID)=>{
    await hooks['tool.execute.before']({tool:'lode_lode_session_create',sessionID,callID},{args:{...args}});
    return dispatch({jsonrpc:'2.0',id:callID,method:'tools/call',params:{name:'lode_session_create',arguments:args}},{nativeSessionBridge:bridge});
  };
  const results=await Promise.allSettled([invoke('ses_child1','child1'),invoke('ses_parent','parent'),invoke('ses_child2','child2')]);
  for(const index of [0,2]){assert.equal(results[index].status,'rejected');assert.equal(results[index].reason.code,SUBAGENT_STATE_WRITE_REJECTED);}
  assert.equal(results[1].status,'fulfilled');assert.equal(results[1].value.error,undefined);
  assert.equal(typeof results[1].value.result?.structuredContent?.sessionId,'string');
  for(const name of ['head_tools_call','head_tools_read'])await hooks['tool.execute.before']({
    tool:`lode_${name}`,sessionID:'ses_child1',callID:`read-${name}`,
  },{args:{name:'lode_project_status',arguments:{project_root:root}}});
  await assert.rejects(hooks['tool.execute.before']({
    tool:'lode_lode_session_create',sessionID:'ses_child2',callID:'output-is-actual',
    args:{name:'lode_project_status',arguments:{project_root:root}},
  },{args:{...args}}),{code:SUBAGENT_STATE_WRITE_REJECTED});
  assert.equal(fs.existsSync(path.join(operational,'subagent-caller-signals')),false);
});
