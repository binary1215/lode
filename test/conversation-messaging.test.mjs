import assert from "node:assert/strict";
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
import { codexTransportPlan, collectAncestors, deliverCodexTurn } from "../scripts/lib/conversation-messaging-codex.mjs";
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

function register(root, environment, who, channel) {
  return registerConversationPresence({ root, identity: identity(who.runtime, who.nativeSessionId, who), channel, environment, now: fixedNow });
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
  register(root, environment, claude, { kind: "claude-prompt" });
  register(root, environment, codex, { kind: "codex-engine", engineSocket: path.join(environment.CODEX_HOME, "missing.sock") });
  const queued = await sendProjectConversation({
    root, caller: claude, environment, to: "codex:codex-b", body: "please review the migration", now: fixedNow, waitMs: 0,
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
    root, caller: codex, environment, to: "claude:claude-a", body: "migration finished", replyTo: queued.id, now: fixedNow, waitMs: 0,
    deliver: async () => ({ outcome: "unavailable", evidence: "claude-prompt" }),
  });
  assert.equal(reply.state, "queued");
  assert.equal(reply.replyTo, queued.id);
  await assert.rejects(() => sendProjectConversation({
    root, caller: claude, environment, to: "codex:codex-b", body: "not the recipient", replyTo: queued.id, now: fixedNow, waitMs: 0,
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
          if (buffer.includes('"method":"initialize"') && !stdout.writableEnded) stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n");
          if (buffer.includes('"turn/start"')) stdout.write(JSON.stringify({ id: 2, result: { turn: { id: "turn_test", status: "inProgress" } } }) + "\n");
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
  assert.equal(plan.command, "codex.cmd");
  assert.deepEqual(plan.args.slice(0, 3), ["app-server", "proxy", "--sock"]);
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
  registerOpenCodePresence({ root, session: child, client, environment, now: Date.now });
  const queued = await sendProjectConversation({
    root, caller: caller("claude", "claude-to-open"), environment, to: "opencode:ses_parent", body: "ping opencode", now: fixedNow, waitMs: 0,
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
  const forged = await sendProjectConversation({ root, environment, to: args.to, body: args.body, hostTicket: ticket, now: fixedNow, waitMs: 0,
    deliver: async () => ({ outcome: "sent", evidence: "test-channel" }) });
  assert.equal(forged.from, "opencode:ses_child");
  assert.notEqual(forged.from, "opencode:ses_parent");
  const listed = await dispatch({ jsonrpc: "2.0", id: "list", method: "tools/call", params: { name: "lode_conversation_list", arguments: { project_root: root } } },
    { caller: caller("claude", "claude-to-open"), hostEnvironment: environment });
  assert.equal(listed.error, undefined);
  assert.equal(listed.result.structuredContent.conversations.some(row => row.address === "opencode:ses_child"), true);
});
