import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { initializeProject } from "../scripts/lib/lode-core.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { runSessionHostHook } from "../scripts/session-host-hook.mjs";
import {
  formatAddress, hookConversationIdentity, identityFromCaller, listProjectConversations, prepareHookInjection,
  registerConversationPresence, registerOpenCodePresence, sendProjectConversation, writeOpenCodeCallerTicket,
  deliverQueuedOpenCode as pumpOpenCode,
} from "../scripts/lib/conversation-messaging.mjs";
import { claudeWireLines, deliverClaudeInbox, normalizeClaudeSocketPath, readClaudePeerToken, claudeSocketDigest } from "../scripts/lib/conversation-messaging-claude.mjs";
import { ancestorsFromPsTable, codexControlSocket, codexTransportPlan, collectAncestors, deliverCodexTurn, resolveCodexWindowsTarget, stopCodexProxy } from "../scripts/lib/conversation-messaging-codex.mjs";
import { deliverOpenCodePrompt } from "../scripts/lib/conversation-messaging-opencode.mjs";
import { processStartId } from "../scripts/lib/process-exists.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const fixedNow = () => Date.parse("2026-10-31T00:00:00.000Z");
const caller = (runtime, nativeSessionId, extra = {}) => ({ runtime, nativeSessionId, agentId: null, subagent: false, ...extra });
const identity = (runtime, nativeSessionId, extra = {}) => ({ runtime, nativeSessionId, agentId: null, subagent: false, parentSessionId: null, ...extra });

function isolated(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-messaging-")));
  const home = path.join(base, "home");
  const root = path.join(base, "project");
  fs.mkdirSync(home);
  fs.mkdirSync(root);
  const environment = {
    HOME: home, USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, "claude"),
    CODEX_HOME: path.join(home, "codex"),
    XDG_DATA_HOME: path.join(home, "xdg"),
    XDG_STATE_HOME: path.join(home, "state"),
    HEAD_AGENT_OPERATIONAL_STATE_ROOT: path.join(base, "operational"),
    LODE_AGENT_OPERATIONAL_STATE_ROOT: path.join(base, "operational"),
    LODE_CONVERSATION_DELIVERY_WAIT_MS: "0",
  };
  for (const directory of [environment.CLAUDE_CONFIG_DIR, environment.CODEX_HOME, environment.XDG_DATA_HOME, environment.XDG_STATE_HOME, environment.HEAD_AGENT_OPERATIONAL_STATE_ROOT]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const keys = Object.keys(environment);
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(environment)) process.env[key] = value;
  initializeProject({ root, pluginRoot, runtimes: ["claude", "codex", "opencode"] });
  t.after(() => {
    for (const key of keys) {
      if (previous.get(key) === undefined) delete process.env[key];
      else process.env[key] = previous.get(key);
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, home, root, environment };
}

function register(root, environment, who, channel, now = fixedNow) {
  return registerConversationPresence({ root, identity: identity(who.runtime, who.nativeSessionId, who), channel, environment, now });
}

test("three clients are listed with addresses and current reachability inside isolated homes", t => {
  const { root, environment, home } = isolated(t);
  const claude = caller("claude", "claude-live");
  const codex = caller("codex", "codex-live");
  const opencode = caller("opencode", "ses_live");
  const socket = path.join(home, "claude.sock");
  fs.writeFileSync(socket, "");
  register(root, environment, claude, { kind: "claude-immediate", socketPath: socket });
  register(root, environment, codex, { kind: "codex-next-prompt" });
  register(root, environment, opencode, { kind: "opencode-async" });
  const listed = listProjectConversations({ root, caller: claude, environment, now: fixedNow });
  assert.equal(listed.self.address, "claude:claude-live");
  assert.deepEqual(listed.conversations.map(row => [row.address, row.runtime, row.reachable, row.delivery]).sort(), [
    ["codex:codex-live", "codex", true, "next-prompt"],
    ["opencode:ses_live", "opencode", true, "async"],
  ]);
  assert.equal(listed.conversations.some(row => row.address === listed.self.address), false);
  const outside = path.join(home, "other-project");
  fs.mkdirSync(outside);
  initializeProject({ root: outside, pluginRoot, runtimes: ["claude"] });
  assert.equal(listProjectConversations({ root: outside, caller: claude, environment, now: fixedNow }).conversations.length, 0);
});

test("send reports delivered, sent, or queued and a reply returns to the sender once", async t => {
  const { root, environment } = isolated(t);
  const claude = caller("claude", "claude-a");
  const codex = caller("codex", "codex-b");
  register(root, environment, claude, { kind: "claude-next-prompt" }, Date.now);
  register(root, environment, codex, { kind: "codex-immediate", socketPath: path.join(environment.CODEX_HOME, "missing.sock") }, Date.now);
  const queued = await sendProjectConversation({
    root, caller: claude, environment, to: "codex:codex-b", body: "please review the migration", now: Date.now, waitMs: 0,
    deliver: async () => ({ outcome: "unavailable", evidence: "codex-immediate-unavailable" }),
  });
  assert.equal(queued.state, "queued");
  assert.equal(queued.evidence, "inbox");
  const first = await runSessionHostHook({ runtime: "codex", environment, observeOnly: true, event: {
    hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-b", prompt: "next",
  } });
  assert.match(first.hookSpecificOutput.additionalContext, /please review the migration/);
  assert.match(first.hookSpecificOutput.additionalContext, /claude:claude-a/);
  const second = await runSessionHostHook({ runtime: "codex", environment, observeOnly: true, event: {
    hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-b", prompt: "again",
  } });
  assert.equal(second.hookSpecificOutput, undefined);
  const child = await runSessionHostHook({ runtime: "codex", environment, observeOnly: true, event: {
    hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-b", agent_id: "child-agent", prompt: "child",
  } });
  assert.equal(child.hookSpecificOutput, undefined);
  const reply = await sendProjectConversation({
    root, caller: codex, environment, to: "claude:claude-a", body: "migration finished", replyTo: queued.id, now: Date.now, waitMs: 0,
    deliver: async () => ({ outcome: "unavailable", evidence: "claude-next-prompt" }),
  });
  assert.equal(reply.state, "queued");
  assert.equal(reply.replyTo, queued.id);
  await assert.rejects(() => sendProjectConversation({
    root, caller: claude, environment, to: "codex:codex-b", body: "not the recipient", replyTo: queued.id, now: Date.now, waitMs: 0,
  }), /CONVERSATION_REPLY_UNAVAILABLE/);
  const back = prepareHookInjection({ runtime: "claude", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "claude-a" }, environment });
  assert.match(back.text, /migration finished/);
  back.commit();
  assert.equal(prepareHookInjection({ runtime: "claude", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "claude-a" }, environment }), null);
});

test("immediate delivery is distinct from an unreachable target", async t => {
  const { root, environment, base } = isolated(t);
  const claude = caller("claude", "claude-send");
  const codex = caller("codex", "codex-recv");
  const socket = path.join(environment.CODEX_HOME, "app-server-control");
  fs.mkdirSync(socket, { recursive: true });
  const engine = path.join(socket, "app-server-control.sock");
  fs.writeFileSync(engine, "");
  register(root, environment, claude, { kind: "claude-next-prompt" });
  register(root, environment, codex, { kind: "codex-immediate", socketPath: engine });
  const spawned = [];
  const delivered = await sendProjectConversation({
    root, caller: claude, environment, to: "codex:codex-recv", body: "wake up", now: fixedNow, waitMs: 0, platform: "linux",
    deliver: async ({ presence }) => deliverCodexTurn({
      socketPath: presence.channel.socketPath, platform: "linux", threadId: presence.nativeSessionId, text: "wake up",
      spawnImpl(command, args) {
        spawned.push([command, args]);
        const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
        let buffer = "";
        stdin.on("data", chunk => {
          buffer += chunk.toString();
          if (buffer.includes('"method":"initialize"')) stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n");
          if (buffer.includes('"thread/resume"')) stdout.write(JSON.stringify({ id: 2, result: { thread: { id: "codex-recv" } } }) + "\n");
          if (buffer.includes('"turn/start"')) stdout.write(JSON.stringify({ id: 3, result: { turn: { id: "turn_test", status: "inProgress" } } }) + "\n");
        });
        return { stdin, stdout, stderr, kill() {} };
      },
    }),
  });
  assert.equal(delivered.state, "delivered");
  assert.equal(delivered.evidence, "codex-turn-start");
  assert.deepEqual(spawned[0][1].slice(0, 3), ["app-server", "proxy", "--sock"]);
  const missing = await sendProjectConversation({
    root, caller: claude, environment, to: "opencode:ses_missing", body: "nobody home", now: fixedNow, waitMs: 0,
  });
  assert.equal(missing.state, "unreachable");
  assert.equal(missing.persisted, false);
  const other = path.join(base, "elsewhere");
  fs.mkdirSync(other);
  initializeProject({ root: other, pluginRoot, runtimes: ["claude"] });
  assert.equal(fs.existsSync(path.join(other, ".lode", "messaging")), false);
});

test("a claimed inbox injects once and a failed handoff can be retried once", t => {
  const { root, environment } = isolated(t);
  const codex = caller("codex", "codex-once");
  register(root, environment, codex, { kind: "codex-next-prompt" });
  const queued = sendProjectConversation({
    root, caller: caller("claude", "claude-once"), environment, to: "codex:codex-once", body: "exactly once", now: fixedNow, waitMs: 0,
    deliver: async () => ({ outcome: "unavailable" }),
  });
  return queued.then(message => {
    assert.equal(message.state, "queued");
    const first = prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-once" }, environment });
    const raced = prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-once" }, environment });
    assert.match(first.text, /exactly once/);
    assert.equal(raced, null);
    first.release();
    const retry = prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-once" }, environment });
    assert.match(retry.text, /exactly once/);
    retry.commit();
    assert.equal(prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-once" }, environment }), null);
  });
});

test("a subagent cannot send or register as its parent", async t => {
  const { root, environment } = isolated(t);
  const parent = caller("claude", "claude-parent");
  register(root, environment, parent, { kind: "claude-next-prompt" });
  assert.equal(formatAddress({ runtime: "claude", nativeSessionId: "claude-parent", subagent: true, agentId: null, parentSessionId: null }), null);
  await assert.rejects(() => sendProjectConversation({
    root, caller: { runtime: "claude", nativeSessionId: "claude-parent", subagent: true }, environment,
    to: "claude:claude-parent", body: "pretend", now: fixedNow, waitMs: 0,
  }), /CONVERSATION_SUBAGENT_IDENTITY_REQUIRED/);
  const child = caller("codex", "codex-child", { subagent: true, rootSessionId: "codex-parent" });
  assert.equal(identityFromCaller(child).address, "codex:codex-child");
  register(root, environment, { runtime: "codex", nativeSessionId: "codex-parent" }, { kind: "codex-next-prompt" });
  const sent = await sendProjectConversation({
    root, caller: child, environment, to: "codex:codex-parent", body: "from the child thread", now: fixedNow, waitMs: 0,
    deliver: async () => ({ outcome: "sent", evidence: "test-channel" }),
  });
  assert.equal(sent.from, "codex:codex-child");
  assert.notEqual(sent.from, "codex:codex-parent");
  const claudeChild = caller("claude", "claude-parent", { subagent: true, agentId: "agent-7" });
  const asChild = await sendProjectConversation({
    root, caller: claudeChild, environment, to: "codex:codex-parent", body: "from the claude child", now: fixedNow, waitMs: 0,
    deliver: async () => ({ outcome: "sent", evidence: "test-channel" }),
  });
  assert.equal(asChild.from, "claude:claude-parent/agent-7");
  assert.equal(hookConversationIdentity("claude", { session_id: "claude-parent", agent_id: "agent-7" }).address, "claude:claude-parent/agent-7");
  assert.equal(hookConversationIdentity("codex", { session_id: "codex-parent", agent_id: "codex-child" }).address, "codex:codex-child");
  assert.equal(identityFromCaller(child).address, hookConversationIdentity("codex", { session_id: "codex-parent", agent_id: "codex-child" }).address);
});

test("Windows Claude auth is required and Windows Codex uses the app-server proxy", async t => {
  const { root, environment, home } = isolated(t);
  assert.equal(claudeWireLines({ platform: "win32", token: "", message: { id: "msg-" + "ab".repeat(12), from: { nativeSessionId: "s" }, text: "hi" } }).ok, false);
  const authed = claudeWireLines({ platform: "win32", token: "peer-token-1", message: { id: "msg-" + "cd".repeat(12), from: { nativeSessionId: "s" }, text: "hi" } });
  assert.equal(authed.ok, true);
  assert.equal(JSON.parse(authed.lines[0]).type, "auth");
  assert.equal(JSON.parse(authed.lines[0]).token, "peer-token-1");
  let connected = 0;
  const refused = await deliverClaudeInbox({ socketPath: "\\\\.\\pipe\\lode-test", platform: "win32", token: "", message: { id: "m", text: "hi" }, connectImpl() { connected += 1; } });
  assert.equal(refused.evidence, "CLAUDE_INBOX_AUTH_REQUIRED");
  assert.equal(connected, 0);
  const pipe = "\\\\.\\pipe\\lode-test";
  const digest = claudeSocketDigest(pipe);
  fs.mkdirSync(path.join(environment.CLAUDE_CONFIG_DIR, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(environment.CLAUDE_CONFIG_DIR, "sessions", `4242.${digest}.key`), JSON.stringify({ peerToken: "peer-token-1" }));
  assert.equal(readClaudePeerToken({ environment, socketPath: pipe }), "peer-token-1");
  const plan = codexTransportPlan({ platform: "win32", socketPath: path.join(environment.CODEX_HOME, "app-server-control", "app-server-control.sock"), ...winCodexLookup() });
  assert.equal(plan.mode, "proxy");
  assert.equal(plan.shell, false);
  assert.equal(plan.command, WIN_CODEX_EXE);
  assert.equal(path.win32.isAbsolute(plan.command), true);
  assert.equal(plan.args.includes("codex.cmd"), false);
  assert.deepEqual(plan.args.slice(-4, -1), ["app-server", "proxy", "--sock"]);
  assert.equal(plan.args.at(-1), path.join(environment.CODEX_HOME, "app-server-control", "app-server-control.sock"));
  const spaced = codexTransportPlan({ platform: "win32", socketPath: "C:\\Program Files\\codex.sock", ...winCodexLookup() });
  assert.equal(spaced.shell, false);
  assert.equal(spaced.args.at(-1), "C:\\Program Files\\codex.sock");
  assert.equal(codexTransportPlan({ platform: "win32", socketPath: "C:\\p\\%COMSPEC%\\x.sock", ...winCodexLookup() }).args.at(-1), "C:\\p\\%COMSPEC%\\x.sock");
  assert.equal(codexTransportPlan({ platform: "win32", socketPath: 'C:\\x" & calc & ".sock' }).evidence, "codex-proxy-socket-rejected");
  const tree = [];
  stopCodexProxy({ pid: 4242, kill() { tree.push("kill"); } }, {
    platform: "win32",
    spawnSyncImpl(file, args) { tree.push([file, args]); return { status: 0 }; },
  });
  assert.equal(String(tree[0][0]).endsWith(`${path.win32.sep}taskkill.exe`) || tree[0][0].endsWith("taskkill.exe"), true);
  assert.deepEqual(tree[0][1], ["/PID", "4242", "/T", "/F"]);
  const table = [{ ProcessId: 10, ParentProcessId: 4, CommandLine: "codex app-server --listen unix://" }, { ProcessId: 4, ParentProcessId: 1, CommandLine: "codex.exe" }];
  const lines = collectAncestors({ platform: "win32", environment, pid: 10, spawnSyncImpl() {
    return { status: 0, stdout: JSON.stringify(table) };
  } });
  assert.match(lines[0], /app-server --listen unix:\/\//);
  register(root, environment, caller("claude", "claude-win"), { kind: "claude-immediate", socketPath: pipe });
  const listed = listProjectConversations({ root, caller: caller("codex", "codex-win"), environment, now: fixedNow, platform: "win32" });
  assert.equal(listed.conversations.find(row => row.address === "claude:claude-win").evidence, "claude-inbox-pipe");
  const received = [];
  const sent = await deliverClaudeInbox({
    socketPath: pipe, platform: "win32", token: "peer-token-1",
    message: { id: "msg-" + "ef".repeat(12), from: { nativeSessionId: "codex-win" }, text: "from codex" },
    async connectImpl() {
      return { write(text, callback) { received.push(text); callback?.(); return true; }, destroy() {} };
    },
  });
  assert.equal(sent.outcome, "sent");
  assert.equal(sent.evidence, "claude-inbox-pipe-auth");
  assert.match(received[0], /^\{"type":"auth"/);
  assert.equal(fs.existsSync(path.join(home, ".claude")), false);
});

test("OpenCode prompt delivery is delivered once and a child ticket cannot name the parent", async t => {
  const { root, environment } = isolated(t);
  const calls = [];
  const client = { session: { async prompt(input) { calls.push(input); return { data: { id: "msg_accepted" } }; } } };
  const parent = { id: "ses_parent", directory: root };
  const child = { id: "ses_child", parentID: "ses_parent", directory: root };
  registerOpenCodePresence({ root, session: parent, client, environment, now: Date.now });
  const childPresence = registerOpenCodePresence({ root, session: child, client, environment, now: Date.now });
  assert.equal(childPresence?.address, "opencode:ses_child");
  const queued = await sendProjectConversation({
    root, caller: caller("claude", "claude-to-open"), environment, to: "opencode:ses_parent", body: "ping opencode", now: Date.now, waitMs: 0,
    deliver: async () => ({ outcome: "unavailable", evidence: "opencode-plugin-inbox" }),
  });
  assert.equal(queued.state, "queued");
  const first = await pumpOpenCode({ root, client, directory: root, environment, sessionId: "ses_parent" });
  assert.equal(first.length, 1);
  assert.equal(first[0].state, "delivered");
  assert.equal(first[0].evidence, "opencode-session-prompt");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path.id, "ses_parent");
  assert.match(calls[0].body.parts[0].text, /ping opencode/);
  assert.deepEqual(await pumpOpenCode({ root, client, directory: root, environment, sessionId: "ses_parent" }), []);
  const direct = await deliverOpenCodePrompt({ client, directory: root, sessionId: "ses_child", text: "direct" });
  assert.equal(direct.outcome, "delivered");
  const missing = await deliverOpenCodePrompt({ client: { session: {} }, directory: root, sessionId: "ses_child", text: "nope" });
  assert.equal(missing.outcome, "unavailable");
  const args = { project_root: root, to: "opencode:ses_parent", body: "from child", reply_to: null };
  const ticket = writeOpenCodeCallerTicket({ root, session: child, args, environment, now: Date.now });
  const forged = await sendProjectConversation({ root, environment, to: args.to, body: args.body, hostTicket: ticket, now: Date.now, waitMs: 0,
    deliver: async () => ({ outcome: "sent", evidence: "test-channel" }) });
  assert.equal(forged.from, "opencode:ses_child");
  assert.notEqual(forged.from, "opencode:ses_parent");
  const listed = await dispatch({ jsonrpc: "2.0", id: "list", method: "tools/call", params: { name: "lode_conversation_list", arguments: { project_root: root } } },
    { caller: caller("claude", "claude-to-open"), hostEnvironment: environment });
  assert.equal(listed.error, undefined);
  assert.equal(listed.result.structuredContent.conversations.some(row => row.address === "opencode:ses_child"), true);
});

function windowsHome(name, rest = "") {
  return ["C:", "Users", name, rest].filter(part => part !== "").join("\\");
}

const WIN_CODEX_EXE = "C:\\Program Files\\Codex\\codex.exe";
function winCodexLookup(extra = {}) {
  return {
    env: { PATH: "C:\\Program Files\\Codex", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    exists: file => file === WIN_CODEX_EXE,
    readFile: () => "",
    execPath: "C:\\Windows\\nodejs\\node.exe",
    ...extra,
  };
}

function runNode(script, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: pluginRoot, env: { ...process.env, ...environment },
    });
    let out = "", err = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, out, err }));
  });
}

test("list and send open the mailbox, then a real hook process joins it", async t => {
  const { root, environment } = isolated(t);
  const before = fs.existsSync(path.join(root, ".lode", "messaging"));
  assert.equal(before, false);
  const listed = listProjectConversations({ root, caller: caller("claude", "claude-boot"), environment, now: Date.now });
  assert.equal(listed.self.address, "claude:claude-boot");
  assert.equal(fs.existsSync(path.join(root, ".lode", "messaging", "presence")), true);
  const ignoreFile = path.join(root, ".lode", ".gitignore");
  const originalIgnore = fs.readFileSync(ignoreFile, "utf8");
  const stripped = originalIgnore.replaceAll("/messaging/\n", "");
  fs.writeFileSync(ignoreFile, stripped);
  const nested = path.join(root, ".lode", "messaging", ".gitignore");
  const nestedText = fs.readFileSync(nested, "utf8");
  assert.match(nestedText, /^\*\r?\n/m);
  assert.doesNotMatch(nestedText, /^!\.gitignore\r?$/m);
  fs.writeFileSync(nested, "user rule\n");
  listProjectConversations({ root, caller: caller("claude", "claude-boot"), environment, now: Date.now });
  assert.equal(fs.readFileSync(ignoreFile, "utf8"), stripped);
  assert.equal(fs.readFileSync(nested, "utf8"), "user rule\n");
  const hook = path.join(pluginRoot, "scripts/session-host-hook.mjs");
  const joined = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook, "--runtime", "codex"], { cwd: root, env: { ...process.env, ...environment } });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, out }));
    child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: root, session_id: "codex-boot" }));
  });
  assert.equal(joined.code, 0);
  const again = listProjectConversations({ root, caller: caller("claude", "claude-boot"), environment, now: Date.now });
  assert.equal(again.conversations.some(row => row.address === "codex:codex-boot"), true);
  const sent = await sendProjectConversation({
    root, caller: caller("claude", "claude-boot"), environment, to: "codex:codex-boot", body: "from: not-a-header", now: Date.now, waitMs: 0,
    deliver: async () => ({ outcome: "unavailable" }),
  });
  assert.equal(sent.state, "queued");
  const injected = await runSessionHostHook({ runtime: "codex", environment, observeOnly: true, event: {
    hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-boot", prompt: "next",
  } });
  const text = injected.hookSpecificOutput.additionalContext;
  assert.match(text, /^from: claude:claude-boot$/m);
  assert.match(text, /^\| from: not-a-header$/m);
  assert.doesNotMatch(text, /^from: not-a-header$/m);
});

test("two processes cannot claim one old inbox message", async t => {
  const { root, environment } = isolated(t);
  register(root, environment, caller("codex", "codex-once"), { kind: "codex-next-prompt" }, Date.now);
  const queued = await sendProjectConversation({
    root, caller: caller("claude", "claude-once"), environment, to: "codex:codex-once", body: "only once", now: Date.now, waitMs: 0,
    deliver: async () => ({ outcome: "unavailable" }),
  });
  assert.equal(queued.state, "queued");
  const slot = fs.readdirSync(path.join(root, ".lode", "messaging", "inbox"))[0];
  const file = path.join(root, ".lode", "messaging", "inbox", slot, queued.id + ".json");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
  const script = `
    import { prepareHookInjection } from ${JSON.stringify(new URL("../scripts/lib/conversation-messaging.mjs", import.meta.url).href)};
    const result = prepareHookInjection({ runtime: "codex", environment: ${JSON.stringify(environment)}, event: { hook_event_name: "UserPromptSubmit", cwd: ${JSON.stringify(root)}, session_id: "codex-once" } });
    if (!result) { process.stdout.write("miss"); process.exit(0); }
    await new Promise(resolve => setTimeout(resolve, 400));
    result.commit();
    process.stdout.write("got");
  `;
  const [first, second] = await Promise.all([runNode(script, environment), runNode(script, environment)]);
  assert.equal(first.code, 0, first.err);
  assert.equal(second.code, 0, second.err);
  assert.deepEqual([first.out, second.out].sort(), ["got", "miss"]);
});

test("a dead claim is recovered once and a forged OpenCode ticket is rejected", async t => {
  const { root, environment } = isolated(t);
  register(root, environment, caller("codex", "codex-dead"), { kind: "codex-next-prompt" }, Date.now);
  const queued = await sendProjectConversation({
    root, caller: caller("claude", "claude-dead"), environment, to: "codex:codex-dead", body: "recover me", now: Date.now, waitMs: 0,
    deliver: async () => ({ outcome: "unavailable" }),
  });
  const holder = prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-dead" }, environment });
  assert.match(holder.text, /recover me/);
  const slot = fs.readdirSync(path.join(root, ".lode", "messaging", "inflight"))[0];
  const inflight = path.join(root, ".lode", "messaging", "inflight", slot, queued.id + ".json");
  const stored = JSON.parse(fs.readFileSync(inflight, "utf8"));
  stored.claim.pid = 1 << 30;
  stored.claim.at = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(inflight, JSON.stringify(stored));
  const again = prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-dead" }, environment });
  assert.match(again.text, /recover me/);
  again.commit();
  assert.equal(prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-dead" }, environment }), null);
  const reused = await sendProjectConversation({
    root, caller: caller("claude", "claude-dead"), environment, to: "codex:codex-dead", body: "pid reused", now: Date.now, waitMs: 0,
    deliver: async () => ({ outcome: "unavailable" }),
  });
  const held = prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-dead" }, environment });
  assert.match(held.text, /pid reused/);
  const reusedFile = path.join(root, ".lode", "messaging", "inflight", slot, reused.id + ".json");
  const reusedClaim = JSON.parse(fs.readFileSync(reusedFile, "utf8"));
  reusedClaim.claim.pid = process.pid;
  reusedClaim.claim.at = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(reusedFile, JSON.stringify(reusedClaim));
  assert.equal(prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-dead" }, environment }), null);
  held.commit();
  const forgedId = "ab".repeat(16);
  fs.mkdirSync(path.join(root, ".lode", "messaging", "tickets"), { recursive: true });
  fs.writeFileSync(path.join(root, ".lode", "messaging", "tickets", forgedId + ".json"), JSON.stringify({
    schemaVersion: 1, digest: "0".repeat(64), projectRoot: root, caller: caller("opencode", "ses_parent"), expiresAt: Date.now() + 10_000, mac: "0".repeat(64),
  }));
  await assert.rejects(() => sendProjectConversation({
    root, environment, to: "codex:codex-dead", body: "forged", hostTicket: forgedId, now: Date.now, waitMs: 0,
  }), /CONVERSATION_CALLER_UNAVAILABLE/);
});

test("stale conversations are unreachable, the mailbox is bounded, and Codex degrades honestly", async t => {
  const { root, environment, home } = isolated(t);
  register(root, environment, caller("codex", "codex-stale"), { kind: "codex-next-prompt" });
  const idle = await sendProjectConversation({
    root, caller: caller("claude", "claude-stale"), environment, to: "codex:codex-stale", body: "still queued", now: () => fixedNow() + 11 * 60 * 1000, waitMs: 0,
    deliver: async () => ({ outcome: "unavailable" }),
  });
  assert.equal(idle.state, "queued");
  const idleRow = listProjectConversations({ root, caller: caller("claude", "claude-stale"), environment, now: () => fixedNow() + 11 * 60 * 1000 })
    .conversations.find(row => row.address === "codex:codex-stale");
  assert.equal(idleRow?.delivery, "next-prompt");
  const stale = await sendProjectConversation({
    root, caller: caller("claude", "claude-stale"), environment, to: "codex:codex-stale", body: "too old", now: () => fixedNow() + 25 * 60 * 60 * 1000, waitMs: 0,
  });
  assert.equal(stale.state, "unreachable");
  assert.equal(stale.persisted, false);
  assert.equal(listProjectConversations({ root, caller: caller("claude", "claude-stale"), environment, now: () => fixedNow() + 25 * 60 * 60 * 1000 })
    .conversations.some(row => row.address === "codex:codex-stale"), false);
  register(root, environment, caller("codex", "codex-future"), { kind: "codex-next-prompt" }, () => fixedNow() + 365 * 24 * 60 * 60 * 1000);
  assert.equal(listProjectConversations({ root, caller: caller("claude", "claude-future"), environment, now: () => fixedNow() + 300 * 24 * 60 * 60 * 1000 })
    .conversations.some(row => row.address === "codex:codex-future"), false);
  register(root, environment, caller("codex", "codex-skew"), { kind: "codex-next-prompt" }, () => fixedNow() + 30_000);
  assert.equal(listProjectConversations({ root, caller: caller("claude", "claude-skew"), environment, now: fixedNow })
    .conversations.some(row => row.address === "codex:codex-skew"), true);
  register(root, environment, caller("codex", "codex-cap"), { kind: "codex-next-prompt" }, Date.now);
  let filled = false;
  for (let index = 0; index < 220 && !filled; index += 1) {
    try {
      await sendProjectConversation({
        root, caller: caller("claude", "claude-cap"), environment, to: "codex:codex-cap", body: "x", now: Date.now, waitMs: 0,
        deliver: async () => ({ outcome: "unavailable" }),
      });
    } catch (error) {
      assert.equal(error.code, "CONVERSATION_MAILBOX_FULL");
      filled = true;
    }
  }
  assert.equal(filled, true);
  assert.equal(codexControlSocket({ HOME: home }).endsWith(`${path.sep}.codex${path.sep}app-server-control${path.sep}app-server-control.sock`), true);
  const ps = "  4  1 launchd\n  9  4 codex app-server --listen unix:///tmp/codex.sock\n  10  9 codex\n";
  assert.match(ancestorsFromPsTable(ps, 10)[1], /unix:\/\/\/tmp\/codex\.sock/);
  const rejected = await deliverCodexTurn({
    socketPath: path.join(home, "sock"), platform: "win32", threadId: "thr", text: "hi", ...winCodexLookup(),
    spawnImpl() { throw Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" }); },
  });
  assert.equal(rejected.outcome, "unavailable");
  assert.equal(rejected.evidence, "codex-proxy-spawn-rejected");
  let spawned = null;
  const literal = await deliverCodexTurn({
    socketPath: "C:\\p\\%COMSPEC%\\x.sock", platform: "win32", threadId: "thr", text: "hi", ...winCodexLookup(),
    spawnImpl(command, args, options) {
      spawned = { command, args, options };
      throw Object.assign(new Error("stop after argv check"), { code: "EINVAL" });
    },
  });
  assert.equal(literal.evidence, "codex-proxy-spawn-rejected");
  assert.equal(spawned.options.shell, false);
  assert.equal(String(spawned.command).toLowerCase().includes("cmd.exe"), false);
  assert.equal(spawned.args.at(-1), "C:\\p\\%COMSPEC%\\x.sock");
  const v2 = [];
  const v2Result = await deliverOpenCodePrompt({
    client: { session: { hook() {}, async prompt(input) { v2.push(input); return { id: "msg_v2" }; } } },
    directory: root, sessionId: "ses_v2", text: "queued delivery",
  });
  assert.equal(v2Result.evidence, "opencode-v2-session-prompt");
  assert.equal(v2[0].delivery, "queue");
  assert.equal(v2[0].sessionID, "ses_v2");
});

test("one full target does not block another and a dead queue expires", async t => {
  const { root, environment } = isolated(t);
  register(root, environment, caller("codex", "codex-full"), { kind: "codex-next-prompt" }, Date.now);
  register(root, environment, caller("claude", "claude-other"), { kind: "claude-next-prompt" }, Date.now);
  let filled = false;
  for (let index = 0; index < 220 && !filled; index += 1) {
    try {
      await sendProjectConversation({
        root, caller: caller("opencode", "ses-filler"), environment, to: "codex:codex-full", body: "q", now: Date.now, waitMs: 0,
        deliver: async () => ({ outcome: "unavailable" }),
      });
    } catch (error) {
      assert.equal(error.code, "CONVERSATION_MAILBOX_FULL");
      filled = true;
    }
  }
  assert.equal(filled, true);
  const other = await sendProjectConversation({
    root, caller: caller("opencode", "ses-filler"), environment, to: "claude:claude-other", body: "still open", now: Date.now, waitMs: 0,
    deliver: async () => ({ outcome: "unavailable" }),
  });
  assert.equal(other.state, "queued");
  assert.equal(other.to, "claude:claude-other");
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const inboxRoot = path.join(root, ".lode", "messaging", "inbox");
  for (const slotName of fs.readdirSync(inboxRoot)) {
    for (const name of fs.readdirSync(path.join(inboxRoot, slotName))) {
      const file = path.join(inboxRoot, slotName, name);
      const message = JSON.parse(fs.readFileSync(file, "utf8"));
      if (message.to?.address !== "codex:codex-full") continue;
      fs.utimesSync(file, old, old);
    }
  }
  const after = await sendProjectConversation({
    root, caller: caller("opencode", "ses-filler"), environment, to: "claude:claude-other", body: "after expiry", now: Date.now, waitMs: 0,
    deliver: async () => ({ outcome: "unavailable" }),
  });
  assert.equal(after.state, "queued");
  const remaining = [];
  for (const slotName of fs.readdirSync(inboxRoot)) {
    const slotDir = path.join(inboxRoot, slotName);
    for (const name of fs.readdirSync(slotDir)) {
      if (!name.endsWith(".json")) continue;
      const message = JSON.parse(fs.readFileSync(path.join(slotDir, name), "utf8"));
      if (message.to?.address === "codex:codex-full") remaining.push(message.id);
    }
  }
  assert.deepEqual(remaining, []);
});

test("OpenCode ticket key is repaired and shared when operational roots differ", async t => {
  const { root, environment, home } = isolated(t);
  const digest = crypto.createHash("sha256").update(path.resolve(root)).digest("hex");
  const dir = path.join(home, ".local", "state", "lode-agent-core", "conversation-tickets", digest);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  fs.writeFileSync(path.join(dir, "key"), "not-a-key\n", { mode: 0o644 });
  register(root, environment, caller("claude", "claude-ticket"), { kind: "claude-next-prompt" }, Date.now);
  const child = { id: "ses_ticket_child", parentID: "ses_ticket_parent", directory: root };
  const args = { project_root: root, to: "claude:claude-ticket", body: "from ticket", reply_to: null };
  const ticket = writeOpenCodeCallerTicket({ root, session: child, args, environment, now: Date.now });
  assert.equal(typeof ticket, "string");
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const key = fs.readFileSync(path.join(dir, "key"), "utf8").trim();
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(fs.statSync(path.join(dir, "key")).mode & 0o777, 0o600);
  const mismatched = { ...environment, LODE_AGENT_OPERATIONAL_STATE_ROOT: path.join(home, "other-operational") };
  const sent = await sendProjectConversation({
    root, environment: mismatched, to: args.to, body: args.body, hostTicket: ticket, now: Date.now, waitMs: 0,
    deliver: async () => ({ outcome: "sent", evidence: "test-channel" }),
  });
  assert.equal(sent.from, "opencode:ses_ticket_child");
  const listArgs = { project_root: root, to: null, body: null, reply_to: null };
  const listTicket = writeOpenCodeCallerTicket({ root, session: child, args: listArgs, environment, now: Date.now });
  const otherHome = { ...environment, HOME: path.join(home, "elsewhere"), USERPROFILE: path.join(home, "elsewhere") };
  const missingSelf = listProjectConversations({ root, environment: otherHome, hostTicket: listTicket, now: Date.now });
  assert.equal(missingSelf.self, null);
});

test("a live owner keeps an old claim and a mismatched token cannot archive it", async t => {
  const { root, environment } = isolated(t);
  register(root, environment, caller("codex", "codex-owner"), { kind: "codex-next-prompt" }, Date.now);
  const queued = await sendProjectConversation({
    root, caller: caller("claude", "claude-owner"), environment, to: "codex:codex-owner", body: "still mine", now: Date.now, waitMs: 0,
    deliver: async () => ({ outcome: "unavailable" }),
  });
  const owner = prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-owner" }, environment });
  assert.match(owner.text, /still mine/);
  const slot = fs.readdirSync(path.join(root, ".lode", "messaging", "inflight"))[0];
  const inflight = path.join(root, ".lode", "messaging", "inflight", slot, queued.id + ".json");
  const stored = JSON.parse(fs.readFileSync(inflight, "utf8"));
  stored.claim.at = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  fs.writeFileSync(inflight, JSON.stringify(stored));
  assert.equal(prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-owner" }, environment }), null);
  stored.claim.token = "deadbeef";
  fs.writeFileSync(inflight, JSON.stringify(stored));
  owner.commit();
  assert.equal(fs.existsSync(inflight), true);
  assert.equal(JSON.parse(fs.readFileSync(inflight, "utf8")).claim.token, "deadbeef");
  assert.equal(fs.existsSync(path.join(root, ".lode", "messaging", "archive", slot, queued.id + ".json")), false);
});

test("a blocked OpenCode prompt does not deliver the same message twice", async t => {
  const { root, environment } = isolated(t);
  register(root, environment, caller("opencode", "ses_hold"), { kind: "opencode-async" }, Date.now);
  await sendProjectConversation({
    root, caller: caller("claude", "claude-hold"), environment, to: "opencode:ses_hold", body: "once only", now: Date.now, waitMs: 0,
    deliver: async () => ({ outcome: "unavailable" }),
  });
  let calls = 0;
  let opened;
  const openedGate = new Promise(resolve => { opened = resolve; });
  const client = { session: { get() {}, async prompt() {
    calls += 1;
    if (calls === 1) {
      const inflightRoot = path.join(root, ".lode", "messaging", "inflight");
      for (const slotName of fs.readdirSync(inflightRoot)) {
        for (const name of fs.readdirSync(path.join(inflightRoot, slotName))) {
          const file = path.join(inflightRoot, slotName, name);
          const message = JSON.parse(fs.readFileSync(file, "utf8"));
          message.claim.at = new Date(Date.now() - 11 * 60 * 1000).toISOString();
          fs.writeFileSync(file, JSON.stringify(message));
        }
      }
      opened();
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    return { data: { id: "msg_once" } };
  } } };
  const first = pumpOpenCode({ root, client, directory: root, environment, sessionId: "ses_hold" });
  await openedGate;
  const second = await pumpOpenCode({ root, client, directory: root, environment, sessionId: "ses_hold" });
  const finished = await first;
  assert.equal(calls, 1);
  assert.equal(second.length, 0);
  assert.equal(finished.length, 1);
});

test("a clock three minutes behind does not delete another conversation", async t => {
  const { root, environment } = isolated(t);
  register(root, environment, caller("codex", "codex-peer"), { kind: "codex-next-prompt" }, Date.now);
  register(root, environment, caller("claude", "claude-peer"), { kind: "claude-next-prompt" }, Date.now);
  const queued = await sendProjectConversation({
    root, caller: caller("claude", "claude-peer"), environment, to: "codex:codex-peer", body: "keep me", now: Date.now, waitMs: 0,
    deliver: async () => ({ outcome: "unavailable" }),
  });
  const ahead = new Date(Date.now() + 3 * 60 * 1000);
  const inboxRoot = path.join(root, ".lode", "messaging", "inbox");
  for (const slotName of fs.readdirSync(inboxRoot)) {
    for (const name of fs.readdirSync(path.join(inboxRoot, slotName))) {
      if (name.endsWith(".json")) fs.utimesSync(path.join(inboxRoot, slotName, name), ahead, ahead);
    }
  }
  const presenceDir = path.join(root, ".lode", "messaging", "presence");
  for (const name of fs.readdirSync(presenceDir)) {
    const file = path.join(presenceDir, name);
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    record.updatedAt = ahead.toISOString();
    fs.writeFileSync(file, JSON.stringify(record));
  }
  const listed = listProjectConversations({ root, caller: caller("opencode", "ses-skew"), environment, now: Date.now });
  assert.equal(listed.conversations.some(row => row.address === "codex:codex-peer"), true);
  assert.equal(listed.conversations.some(row => row.address === "claude:claude-peer"), true);
  const kept = fs.readdirSync(inboxRoot).some(slotName => fs.readdirSync(path.join(inboxRoot, slotName)).includes(queued.id + ".json"));
  assert.equal(kept, true);
});

test("an expired queued message leaves the sender a notice", async t => {
  const { root, environment } = isolated(t);
  register(root, environment, caller("codex", "codex-expire"), { kind: "codex-next-prompt" }, Date.now);
  const queued = await sendProjectConversation({
    root, caller: caller("claude", "claude-expire"), environment, to: "codex:codex-expire", body: "please keep", now: Date.now, waitMs: 0,
    deliver: async () => ({ outcome: "unavailable" }),
  });
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const inboxRoot = path.join(root, ".lode", "messaging", "inbox");
  for (const slotName of fs.readdirSync(inboxRoot)) {
    for (const name of fs.readdirSync(path.join(inboxRoot, slotName))) {
      const file = path.join(inboxRoot, slotName, name);
      if (!name.endsWith(".json")) continue;
      const message = JSON.parse(fs.readFileSync(file, "utf8"));
      if (message.id !== queued.id) continue;
      message.createdAt = old.toISOString();
      fs.writeFileSync(file, JSON.stringify(message));
      fs.utimesSync(file, old, old);
    }
  }
  listProjectConversations({ root, caller: caller("claude", "claude-expire"), environment, now: Date.now });
  const notice = prepareHookInjection({ runtime: "claude", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "claude-expire" }, environment });
  assert.match(notice.text, /notice: expired/);
  assert.match(notice.text, new RegExp(queued.id));
  assert.match(notice.text, /codex:codex-expire/);
  notice.commit();
  assert.equal(prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-expire" }, environment }), null);
});

test("Windows Codex delivers Unicode socket paths without cmd.exe", async t => {
  const korean = windowsHome("홍길동", "프로젝트\\app-server-control.sock");
  const samples = [
    korean,
    windowsHome("José", "codex.sock"),
    windowsHome("O'Brien", "codex.sock"),
    windowsHome("a (2)", "codex.sock"),
    "C:\\PROGRA~1\\codex.sock",
    "\\\\?\\" + windowsHome("홍길동", "codex.sock"),
  ];
  for (const socketPath of samples) {
    const plan = codexTransportPlan({ platform: "win32", socketPath, ...winCodexLookup() });
    assert.equal(plan.mode, "proxy", socketPath);
    assert.equal(plan.shell, false, socketPath);
    assert.equal(String(plan.command).toLowerCase().includes("cmd.exe"), false, socketPath);
    assert.equal(plan.args.at(-1), socketPath);
    assert.deepEqual(plan.args.slice(-4), ["app-server", "proxy", "--sock", socketPath]);
  }
  const spawned = [];
  const delivered = await deliverCodexTurn({
    socketPath: korean, platform: "win32", threadId: "thr-ko", text: "hi", ...winCodexLookup(),
    spawnImpl(command, args, options) {
      spawned.push({ command, args, options });
      const stdin = new PassThrough(), stdout = new PassThrough();
      stdin.on("data", chunk => {
        const text = chunk.toString();
        if (text.includes('"method":"initialize"')) stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n");
        if (text.includes('"thread/resume"')) stdout.write(JSON.stringify({ id: 2, result: { thread: { id: "thr-ko" } } }) + "\n");
        if (text.includes('"turn/start"')) stdout.write(JSON.stringify({ id: 3, result: { turn: { id: "turn_ko" } } }) + "\n");
      });
      return { stdin, stdout, stderr: new PassThrough(), kill() {} };
    },
  });
  assert.equal(delivered.outcome, "delivered");
  assert.equal(spawned[0].options.shell, false);
  assert.equal(spawned[0].args.at(-1), korean);
  const dir = "C:\\Tools";
  const cmd = path.win32.join(dir, "codex.cmd");
  const script = path.win32.join(dir, "node_modules", "codex", "bin", "codex.js");
  const nodeExe = path.win32.join(dir, "node.exe");
  const files = new Map([[cmd, '"%dp0%\\node_modules\\codex\\bin\\codex.js"\r\n'], [script, ""], [nodeExe, ""]]);
  const resolved = resolveCodexWindowsTarget({
    env: { PATH: dir },
    exists: file => files.has(file),
    readFile: file => files.get(file),
  });
  assert.equal(resolved.command, nodeExe);
  assert.deepEqual(resolved.args, [script]);
  const shimmed = codexTransportPlan({
    platform: "win32", socketPath: korean, env: { PATH: dir },
    exists: file => files.has(file), readFile: file => files.get(file),
  });
  assert.equal(shimmed.command, nodeExe);
  assert.equal(shimmed.args.at(-1), korean);
  assert.equal(shimmed.shell, false);
  const koreanDir = windowsHome("홍길동", "프로젝트");
  const extended = "\\\\?\\" + windowsHome("홍길동", "inbox.sock");
  assert.equal(normalizeClaudeSocketPath(korean), korean);
  assert.equal(normalizeClaudeSocketPath(extended), extended);
  assert.equal(normalizeClaudeSocketPath("\\\\.\\pipe\\" + "홍길동"), "\\\\.\\pipe\\홍길동");
  const calls = [];
  const prompted = await deliverOpenCodePrompt({
    client: { session: { async prompt(input) { calls.push(input); return { data: { id: "msg_ko" } }; } } },
    directory: koreanDir, sessionId: "ses_ko", text: "hi",
  });
  assert.equal(prompted.outcome, "delivered");
  assert.equal(calls[0].query.directory, koreanDir);
});

test("an existing project does not gain an untracked messaging gitignore", t => {
  const { root } = isolated(t);
  const parent = path.join(root, ".lode", ".gitignore");
  const original = fs.readFileSync(parent, "utf8").replaceAll("/messaging/\n", "");
  fs.writeFileSync(parent, original);
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(git(["init"]).status, 0);
  assert.equal(git(["add", ".lode/.gitignore"]).status, 0);
  listProjectConversations({ root, caller: caller("claude", "claude-ignore"), environment: { HOME: root, USERPROFILE: root }, now: Date.now });
  const nested = path.join(root, ".lode", "messaging", ".gitignore");
  assert.equal(fs.readFileSync(parent, "utf8"), original);
  assert.doesNotMatch(fs.readFileSync(nested, "utf8"), /!\.gitignore/);
  assert.doesNotMatch(git(["status", "--porcelain"]).stdout, /messaging/);
  fs.writeFileSync(nested, "# Live conversation mailbox, not canon.\n*\n!.gitignore\n");
  listProjectConversations({ root, caller: caller("claude", "claude-ignore"), environment: { HOME: root, USERPROFILE: root }, now: Date.now });
  assert.equal(fs.readFileSync(nested, "utf8"), "# Live conversation mailbox, not canon.\n*\n");
  assert.equal(fs.readFileSync(parent, "utf8"), original);
  assert.doesNotMatch(git(["status", "--porcelain"]).stdout, /messaging/);
});

test("expiry notices collapse to one per sender and do not block a real message", async t => {
  const { root, environment } = isolated(t);
  register(root, environment, caller("codex", "codex-gone"), { kind: "codex-next-prompt" }, Date.now);
  register(root, environment, caller("claude", "claude-amp"), { kind: "claude-next-prompt" }, Date.now);
  const queued = await sendProjectConversation({
    root, caller: caller("claude", "claude-amp"), environment, to: "codex:codex-gone", body: "one of many", now: Date.now, waitMs: 0,
    deliver: async () => ({ outcome: "unavailable" }),
  });
  const inboxRoot = path.join(root, ".lode", "messaging", "inbox");
  const slotName = fs.readdirSync(inboxRoot).find(name => fs.readdirSync(path.join(inboxRoot, name)).includes(queued.id + ".json"));
  const original = JSON.parse(fs.readFileSync(path.join(inboxRoot, slotName, queued.id + ".json"), "utf8"));
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const ids = [queued.id];
  for (let index = 1; index < 150; index += 1) {
    const id = "msg-" + crypto.randomBytes(12).toString("hex");
    ids.push(id);
    fs.writeFileSync(path.join(inboxRoot, slotName, id + ".json"), JSON.stringify({ ...original, id }));
  }
  for (const id of ids) fs.utimesSync(path.join(inboxRoot, slotName, id + ".json"), old, old);
  const stored = JSON.parse(fs.readFileSync(path.join(inboxRoot, slotName, queued.id + ".json"), "utf8"));
  stored.createdAt = old.toISOString();
  fs.writeFileSync(path.join(inboxRoot, slotName, queued.id + ".json"), JSON.stringify(stored));
  for (const id of ids.slice(1)) {
    const message = JSON.parse(fs.readFileSync(path.join(inboxRoot, slotName, id + ".json"), "utf8"));
    message.createdAt = old.toISOString();
    fs.writeFileSync(path.join(inboxRoot, slotName, id + ".json"), JSON.stringify(message));
    fs.utimesSync(path.join(inboxRoot, slotName, id + ".json"), old, old);
  }
  listProjectConversations({ root, caller: caller("opencode", "ses-other"), environment, now: Date.now });
  const senderSlot = fs.readdirSync(inboxRoot).flatMap(name => fs.readdirSync(path.join(inboxRoot, name)).filter(file => file.endsWith(".json")).map(file => path.join(inboxRoot, name, file)));
  const notices = senderSlot.map(file => JSON.parse(fs.readFileSync(file, "utf8"))).filter(message => message.notice === "expired");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].expiredCount, 150);
  assert.equal(notices[0].to.address, "claude:claude-amp");
  const noticeDir = path.dirname(senderSlot.find(file => JSON.parse(fs.readFileSync(file, "utf8")).notice === "expired"));
  for (let index = 0; index < 199; index += 1) {
    const id = "msg-" + crypto.randomBytes(12).toString("hex");
    fs.writeFileSync(path.join(noticeDir, id + ".json"), JSON.stringify({ ...notices[0], id, expiredId: id, expiredIds: [id], expiredCount: 1 }));
  }
  const delivered = await sendProjectConversation({
    root, caller: caller("opencode", "ses-other"), environment, to: "claude:claude-amp", body: "real message", now: Date.now, waitMs: 0,
    deliver: async () => ({ outcome: "unavailable" }),
  });
  assert.equal(delivered.state, "queued");
  assert.notEqual(delivered.evidence, "claim-not-owned");
});

test("a presence twenty-three hours ahead is not reachable and is not deleted", async t => {
  const { root, environment } = isolated(t);
  register(root, environment, caller("codex", "codex-ahead"), { kind: "codex-next-prompt" }, () => Date.now() + 23 * 60 * 60 * 1000);
  const presenceDir = path.join(root, ".lode", "messaging", "presence");
  const before = fs.readdirSync(presenceDir).length;
  const listed = listProjectConversations({ root, caller: caller("claude", "claude-now"), environment, now: Date.now });
  assert.equal(listed.conversations.some(row => row.address === "codex:codex-ahead"), false);
  const sent = await sendProjectConversation({
    root, caller: caller("claude", "claude-now"), environment, to: "codex:codex-ahead", body: "too early", now: Date.now, waitMs: 0,
  });
  assert.equal(sent.state, "unreachable");
  assert.equal(fs.readdirSync(presenceDir).some(name => {
    const record = JSON.parse(fs.readFileSync(path.join(presenceDir, name), "utf8"));
    return record.address === "codex:codex-ahead";
  }), true);
  assert.ok(fs.readdirSync(presenceDir).length >= before);
});

test("messages stamped far in the future on both clocks expire", async t => {
  const { root, environment } = isolated(t);
  register(root, environment, caller("codex", "codex-future-msg"), { kind: "codex-next-prompt" }, Date.now);
  const queued = await sendProjectConversation({
    root, caller: caller("claude", "claude-future-msg"), environment, to: "codex:codex-future-msg", body: "never ages", now: Date.now, waitMs: 0,
    deliver: async () => ({ outcome: "unavailable" }),
  });
  const ahead = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const inboxRoot = path.join(root, ".lode", "messaging", "inbox");
  for (const slotName of fs.readdirSync(inboxRoot)) {
    const file = path.join(inboxRoot, slotName, queued.id + ".json");
    if (!fs.existsSync(file)) continue;
    const message = JSON.parse(fs.readFileSync(file, "utf8"));
    message.createdAt = ahead.toISOString();
    fs.writeFileSync(file, JSON.stringify(message));
    fs.utimesSync(file, ahead, ahead);
  }
  listProjectConversations({ root, caller: caller("claude", "claude-future-msg"), environment, now: Date.now });
  const kept = fs.readdirSync(inboxRoot).some(slotName => fs.existsSync(path.join(inboxRoot, slotName, queued.id + ".json")));
  assert.equal(kept, false);
});

test("a mismatched Linux start id is reclaimed and an unverified live pid expires after a day", async t => {
  const { root, environment } = isolated(t);
  register(root, environment, caller("codex", "codex-start"), { kind: "codex-next-prompt" }, Date.now);
  const queued = await sendProjectConversation({
    root, caller: caller("claude", "claude-start"), environment, to: "codex:codex-start", body: "start mismatch", now: Date.now, waitMs: 0,
    deliver: async () => ({ outcome: "unavailable" }),
  });
  const first = prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-start" }, environment });
  assert.match(first.text, /start mismatch/);
  const slot = fs.readdirSync(path.join(root, ".lode", "messaging", "inflight"))[0];
  const inflight = path.join(root, ".lode", "messaging", "inflight", slot, queued.id + ".json");
  const mismatched = JSON.parse(fs.readFileSync(inflight, "utf8"));
  mismatched.claim.start = "1";
  mismatched.claim.at = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(inflight, JSON.stringify(mismatched));
  const reclaimed = prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-start" }, environment });
  assert.match(reclaimed.text, /start mismatch/);
  reclaimed.release();
  const held = prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-start" }, environment });
  assert.match(held.text, /start mismatch/);
  const unverifiedFile = path.join(root, ".lode", "messaging", "inflight", slot, queued.id + ".json");
  const unverified = JSON.parse(fs.readFileSync(unverifiedFile, "utf8"));
  delete unverified.claim.start;
  unverified.claim.pid = process.pid;
  unverified.claim.at = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(unverifiedFile, JSON.stringify(unverified));
  const again = prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-start" }, environment });
  assert.equal(again, null);
  assert.equal(fs.existsSync(unverifiedFile), false);
  const notice = prepareHookInjection({ runtime: "claude", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "claude-start" }, environment });
  assert.match(notice.text, /notice: expired/);
  assert.match(notice.text, new RegExp(queued.id));
  notice.commit();
});

test("Windows Codex spawn uses an absolute PATH entry and ignores a planted node.exe", async t => {
  const planted = "C:\\repo\\node.exe";
  const looked = [];
  const exists = file => {
    looked.push(file);
    return file === planted;
  };
  assert.equal(resolveCodexWindowsTarget({ env: { PATH: "C:\\repo" }, exists, readFile: () => "", execPath: "C:\\Windows\\nodejs\\node.exe" }), null);
  const early = "C:\\first";
  const late = "C:\\second";
  const cmd = path.win32.join(early, "codex.cmd");
  const script = path.win32.join(early, "..", "pnpm", "codex.js");
  const normalizedScript = path.win32.normalize(script);
  const laterExe = path.win32.join(late, "codex.exe");
  const execPath = "C:\\Windows\\nodejs\\node.exe";
  const shim = "\"%~dp0\\..\\pnpm\\codex.js\" %*\r\n";
  const files = new Map([[cmd, shim], [normalizedScript, ""], [laterExe, ""], [planted, ""]]);
  const resolved = resolveCodexWindowsTarget({
    env: { PATH: `${early};${late}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    exists: file => files.has(file) && file !== planted,
    readFile: file => files.get(file) || "",
    execPath,
  });
  assert.equal(resolved.command, execPath);
  assert.equal(path.win32.isAbsolute(resolved.command), true);
  assert.notEqual(resolved.command, laterExe);
  assert.notEqual(resolved.command, "node.exe");
  assert.equal(resolved.args[0], normalizedScript);
  const quotedDir = "C:\\Program Files\\Codex";
  const quotedExe = path.win32.join(quotedDir, "codex.exe");
  const quoted = resolveCodexWindowsTarget({
    env: { PATH: `"${quotedDir}"`, PATHEXT: ".EXE" },
    exists: file => file === quotedExe,
    readFile: () => "",
    execPath,
  });
  assert.equal(quoted.command, quotedExe);
  let spawned = 0;
  const blocked = await deliverCodexTurn({
    socketPath: "C:\\safe.sock", platform: "win32", threadId: "thr", text: "hi",
    env: { PATH: "" }, exists: () => false, execPath,
    spawnImpl() { spawned += 1; throw new Error("must not spawn"); },
  });
  assert.equal(blocked.evidence, "codex-proxy-unresolved");
  assert.equal(spawned, 0);
  assert.equal(looked.some(file => path.win32.basename(file).toLowerCase() === "node.exe"), false);
  assert.equal(looked.every(file => path.win32.isAbsolute(file)), true);
});

test("a tracked messaging gitignore is not rewritten", t => {
  const { root } = isolated(t);
  const parent = path.join(root, ".lode", ".gitignore");
  const stripped = fs.readFileSync(parent, "utf8").replaceAll("/messaging/\n", "");
  fs.writeFileSync(parent, stripped);
  const nested = path.join(root, ".lode", "messaging");
  fs.mkdirSync(nested, { recursive: true });
  const ignore = path.join(nested, ".gitignore");
  const previous = "# Live conversation mailbox, not canon.\n*\n!.gitignore\n";
  fs.writeFileSync(ignore, previous);
  const git = args => spawnSync("git", ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  assert.equal(git(["init"]).status, 0);
  assert.equal(git(["add", "-f", "--", ".lode/messaging/.gitignore"]).status, 0);
  assert.equal(git(["commit", "-m", "track the old mailbox ignore"]).status, 0);
  listProjectConversations({ root, caller: caller("claude", "claude-tracked"), environment: { HOME: root, USERPROFILE: root }, now: Date.now });
  assert.equal(fs.readFileSync(ignore, "utf8"), previous);
  assert.doesNotMatch(git(["status", "--porcelain"]).stdout, /messaging\/\.gitignore/);
});

test("darwin process birth uses UTC and is cached", () => {
  const calls = [];
  const first = processStartId(424242, {
    platform: "darwin",
    spawnSyncImpl(file, args, options) {
      calls.push({ file, args, env: options.env });
      return { status: 0, stdout: "Thu Jan  1 00:00:00 2026\n" };
    },
  });
  const second = processStartId(424242, { platform: "darwin", spawnSyncImpl() { throw new Error("cache miss"); } });
  assert.equal(first, String(Date.parse("Thu Jan  1 00:00:00 2026")));
  assert.equal(second, first);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "ps");
  assert.deepEqual(calls[0].args, ["-o", "lstart=", "-p", "424242"]);
  assert.equal(calls[0].env.LC_ALL, "C");
  assert.equal(calls[0].env.TZ, "UTC");
});

test("a claim stamp uses the injected clock", async t => {
  const { root, environment } = isolated(t);
  const at = Date.parse("2026-01-01T00:00:00.000Z");
  register(root, environment, caller("codex", "codex-clock"), { kind: "codex-next-prompt" }, () => at);
  await sendProjectConversation({
    root, caller: caller("claude", "claude-clock"), environment, to: "codex:codex-clock", body: "stamped", now: () => at, waitMs: 0,
    deliver: async () => ({ outcome: "unavailable" }),
  });
  const claimed = prepareHookInjection({
    runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-clock" }, environment, now: () => at,
  });
  assert.match(claimed.text, /stamped/);
  const slot = fs.readdirSync(path.join(root, ".lode", "messaging", "inflight"))[0];
  const messageId = claimed.text.match(/id: (msg-[a-f0-9]{24})/u)[1];
  const stored = JSON.parse(fs.readFileSync(path.join(root, ".lode", "messaging", "inflight", slot, messageId + ".json"), "utf8"));
  assert.equal(stored.claim.at, "2026-01-01T00:00:00.000Z");
  claimed.release();
});

test("an inflight handoff and an owned orphan follow the claim disposition", async t => {
  const { root, environment } = isolated(t);
  register(root, environment, caller("codex", "codex-state"), { kind: "codex-next-prompt" }, Date.now);
  const queued = await sendProjectConversation({
    root, caller: caller("claude", "claude-state"), environment, to: "codex:codex-state", body: "state machine", now: Date.now, waitMs: 0,
    deliver: async () => ({ outcome: "unavailable" }),
  });
  const held = prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-state" }, environment });
  assert.match(held.text, /state machine/);
  const slot = fs.readdirSync(path.join(root, ".lode", "messaging", "inflight"))[0];
  const inflight = path.join(root, ".lode", "messaging", "inflight", slot, queued.id + ".json");
  const stored = JSON.parse(fs.readFileSync(inflight, "utf8"));
  stored.handedToHost = true;
  stored.state = "sent";
  fs.writeFileSync(inflight, JSON.stringify(stored));
  assert.equal(prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-state" }, environment }), null);
  assert.equal(fs.existsSync(path.join(root, ".lode", "messaging", "archive", slot, queued.id + ".json")), true);
  const owned = path.join(root, ".lode", "messaging", "inflight", slot, queued.id + ".json.owned");
  const orphan = { ...stored, handedToHost: false, claim: { ...stored.claim, pid: 1 << 30, at: new Date(Date.now() - 60_000).toISOString() } };
  fs.mkdirSync(path.dirname(owned), { recursive: true });
  fs.writeFileSync(owned, JSON.stringify(orphan));
  const recovered = prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-state" }, environment });
  assert.match(recovered.text, /state machine/);
  recovered.commit();
  assert.equal(fs.existsSync(owned), false);
});

test("four processes can rewrite one presence without ENOENT or a lost file", async t => {
  const { root, environment } = isolated(t);
  const script = `
    import { registerConversationPresence } from ${JSON.stringify(new URL("../scripts/lib/conversation-messaging.mjs", import.meta.url).href)};
    for (let index = 0; index < 400; index += 1) {
      registerConversationPresence({
        root: ${JSON.stringify(root)},
        identity: { runtime: "claude", nativeSessionId: "claude-race", agentId: null, subagent: false, parentSessionId: null },
        channel: { kind: "claude-next-prompt" },
        environment: ${JSON.stringify(environment)},
      });
    }
    process.stdout.write("ok");
  `;
  const results = await Promise.all([0, 1, 2, 3].map(() => runNode(script, environment)));
  for (const result of results) {
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out, "ok");
    assert.equal(result.err.includes("ENOENT"), false);
  }
  const presence = fs.readdirSync(path.join(root, ".lode", "messaging", "presence")).filter(name => name.endsWith(".json"));
  assert.equal(presence.length, 1);
  const record = JSON.parse(fs.readFileSync(path.join(root, ".lode", "messaging", "presence", presence[0]), "utf8"));
  assert.equal(record.address, "claude:claude-race");
});
