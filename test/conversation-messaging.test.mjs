import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import { claudeWireLines, deliverClaudeInbox, readClaudePeerToken, claudeSocketDigest } from "../scripts/lib/conversation-messaging-claude.mjs";
import { ancestorsFromPsTable, codexControlSocket, codexTransportPlan, collectAncestors, deliverCodexTurn, stopCodexProxy } from "../scripts/lib/conversation-messaging-codex.mjs";
import { deliverOpenCodePrompt } from "../scripts/lib/conversation-messaging-opencode.mjs";

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
  register(root, environment, claude, { kind: "claude-inbox", socketPath: socket });
  register(root, environment, codex, { kind: "codex-prompt" });
  register(root, environment, opencode, { kind: "opencode-prompt" });
  const listed = listProjectConversations({ root, caller: claude, environment, now: fixedNow });
  assert.equal(listed.self.address, "claude:claude-live");
  assert.deepEqual(listed.conversations.map(row => [row.address, row.runtime, row.reachable, row.delivery]).sort(), [
    ["codex:codex-live", "codex", true, "next-prompt"],
    ["opencode:ses_live", "opencode", true, "immediate"],
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
  register(root, environment, claude, { kind: "claude-prompt" }, Date.now);
  register(root, environment, codex, { kind: "codex-engine", engineSocket: path.join(environment.CODEX_HOME, "missing.sock") }, Date.now);
  const queued = await sendProjectConversation({
    root, caller: claude, environment, to: "codex:codex-b", body: "please review the migration", now: Date.now, waitMs: 0,
    deliver: async () => ({ outcome: "unavailable", evidence: "codex-engine-unavailable" }),
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
    deliver: async () => ({ outcome: "unavailable", evidence: "claude-prompt" }),
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
  register(root, environment, claude, { kind: "claude-prompt" });
  register(root, environment, codex, { kind: "codex-engine", engineSocket: engine });
  const spawned = [];
  const delivered = await sendProjectConversation({
    root, caller: claude, environment, to: "codex:codex-recv", body: "wake up", now: fixedNow, waitMs: 0, platform: "linux",
    deliver: async ({ presence }) => deliverCodexTurn({
      socketPath: presence.channel.engineSocket, platform: "linux", threadId: presence.nativeSessionId, text: "wake up",
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
  register(root, environment, codex, { kind: "codex-prompt" });
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
  register(root, environment, parent, { kind: "claude-prompt" });
  assert.equal(formatAddress({ runtime: "claude", nativeSessionId: "claude-parent", subagent: true, agentId: null, parentSessionId: null }), null);
  await assert.rejects(() => sendProjectConversation({
    root, caller: { runtime: "claude", nativeSessionId: "claude-parent", subagent: true }, environment,
    to: "claude:claude-parent", body: "pretend", now: fixedNow, waitMs: 0,
  }), /CONVERSATION_SUBAGENT_IDENTITY_REQUIRED/);
  const child = caller("codex", "codex-child", { subagent: true, rootSessionId: "codex-parent" });
  assert.equal(identityFromCaller(child).address, "codex:codex-child");
  register(root, environment, { runtime: "codex", nativeSessionId: "codex-parent" }, { kind: "codex-prompt" });
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
  const plan = codexTransportPlan({ platform: "win32", socketPath: path.join(environment.CODEX_HOME, "app-server-control", "app-server-control.sock") });
  assert.equal(plan.mode, "proxy");
  assert.equal(plan.command, "cmd.exe");
  assert.equal(plan.shell, false);
  assert.equal(plan.windowsVerbatimArguments, true);
  assert.match(plan.args.at(-1), /""codex\.cmd" "app-server" "proxy" "--sock" "/);
  assert.equal(plan.args.at(-1).includes('\\"'), false);
  assert.equal(plan.args.includes("codex.cmd"), false);
  const spaced = codexTransportPlan({ platform: "win32", socketPath: "C:\\Program Files\\codex.sock" });
  assert.match(spaced.args.at(-1), /"--sock" "C:\\Program Files\\codex\.sock""$/);
  assert.equal(spaced.args.at(-1).includes('\\"'), false);
  assert.equal(codexTransportPlan({ platform: "win32", socketPath: "C:\\p\\%COMSPEC%\\x.sock" }).mode, "none");
  assert.equal(codexTransportPlan({ platform: "win32", socketPath: 'C:\\x" & calc & ".sock' }).evidence, "codex-proxy-socket-rejected");
  const tree = [];
  stopCodexProxy({ pid: 4242, kill() { tree.push("kill"); } }, {
    platform: "win32",
    spawnSyncImpl(file, args) { tree.push([file, args]); return { status: 0 }; },
  });
  assert.deepEqual(tree[0], ["taskkill.exe", ["/PID", "4242", "/T", "/F"]]);
  const table = [{ ProcessId: 10, ParentProcessId: 4, CommandLine: "codex app-server --listen unix://" }, { ProcessId: 4, ParentProcessId: 1, CommandLine: "codex.exe" }];
  const lines = collectAncestors({ platform: "win32", environment, pid: 10, spawnSyncImpl() {
    return { status: 0, stdout: JSON.stringify(table) };
  } });
  assert.match(lines[0], /app-server --listen unix:\/\//);
  register(root, environment, caller("claude", "claude-win"), { kind: "claude-inbox", socketPath: pipe });
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
  assert.match(fs.readFileSync(nested, "utf8"), /^\*\r?\n!\.gitignore\r?\n/m);
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
  register(root, environment, caller("codex", "codex-once"), { kind: "codex-prompt" }, Date.now);
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
  register(root, environment, caller("codex", "codex-dead"), { kind: "codex-prompt" }, Date.now);
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
  const reclaimed = prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "codex-dead" }, environment });
  assert.match(reclaimed.text, /pid reused/);
  reclaimed.commit();
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
  register(root, environment, caller("codex", "codex-stale"), { kind: "codex-prompt" });
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
  register(root, environment, caller("codex", "codex-future"), { kind: "codex-prompt" }, () => fixedNow() + 365 * 24 * 60 * 60 * 1000);
  assert.equal(listProjectConversations({ root, caller: caller("claude", "claude-future"), environment, now: () => fixedNow() + 300 * 24 * 60 * 60 * 1000 })
    .conversations.some(row => row.address === "codex:codex-future"), false);
  register(root, environment, caller("codex", "codex-skew"), { kind: "codex-prompt" }, () => fixedNow() + 30_000);
  assert.equal(listProjectConversations({ root, caller: caller("claude", "claude-skew"), environment, now: fixedNow })
    .conversations.some(row => row.address === "codex:codex-skew"), true);
  register(root, environment, caller("codex", "codex-cap"), { kind: "codex-prompt" }, Date.now);
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
    socketPath: path.join(home, "sock"), platform: "win32", threadId: "thr", text: "hi",
    spawnImpl() { throw Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" }); },
  });
  assert.equal(rejected.outcome, "unavailable");
  assert.equal(rejected.evidence, "codex-proxy-spawn-rejected");
  let spawned = 0;
  const blocked = await deliverCodexTurn({
    socketPath: "C:\\p\\%COMSPEC%\\x.sock", platform: "win32", threadId: "thr", text: "hi",
    spawnImpl() { spawned += 1; throw new Error("must not spawn"); },
  });
  assert.equal(blocked.evidence, "codex-proxy-socket-rejected");
  assert.equal(spawned, 0);
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
  register(root, environment, caller("codex", "codex-full"), { kind: "codex-prompt" }, Date.now);
  register(root, environment, caller("claude", "claude-other"), { kind: "claude-prompt" }, Date.now);
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
  register(root, environment, caller("claude", "claude-ticket"), { kind: "claude-prompt" }, Date.now);
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
});
