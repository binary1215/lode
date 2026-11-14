import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject } from "../scripts/lib/session/lode-core.mjs";
import { runSessionHostHook } from "../scripts/session-host-hook.mjs";
import plugin from "../scripts/opencode-plugin.mjs";
import {
  prepareHookInjection,
  prepareStopInjection,
  registerConversationPresence,
  registerHookPresence,
  sendProjectConversation,
} from "../scripts/lib/session/conversation-messaging.mjs";

// Queued conversation mail is picked up without waiting for the recipient's
// next user prompt: at Stop (Claude Code, Codex), with a later live send (B),
// after a resume (presence), and in OpenCode at watcher start and on idle.

const pluginRoot = path.resolve(import.meta.dirname, "..");
const caller = (runtime, nativeSessionId) => ({ runtime, nativeSessionId, agentId: null, subagent: false });

function isolated(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-pickup-")));
  const home = path.join(base, "home");
  const root = path.join(base, "project");
  fs.mkdirSync(home);
  fs.mkdirSync(root);
  const environment = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, "claude"),
    CODEX_HOME: path.join(home, "codex"),
    XDG_DATA_HOME: path.join(home, "xdg"),
    XDG_STATE_HOME: path.join(home, "state"),
    HEAD_AGENT_OPERATIONAL_STATE_ROOT: path.join(base, "operational"),
    LODE_AGENT_OPERATIONAL_STATE_ROOT: path.join(base, "operational"),
    LODE_CONVERSATION_DELIVERY_WAIT_MS: "0",
  };
  for (const directory of [
    environment.CLAUDE_CONFIG_DIR,
    environment.CODEX_HOME,
    environment.XDG_DATA_HOME,
    environment.XDG_STATE_HOME,
    environment.HEAD_AGENT_OPERATIONAL_STATE_ROOT,
  ])
    fs.mkdirSync(directory, { recursive: true });
  const keys = Object.keys(environment);
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
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

function register(root, environment, runtime, id, channel) {
  return registerConversationPresence({
    root,
    identity: { runtime, nativeSessionId: id, agentId: null, subagent: false, parentSessionId: null },
    channel,
    environment,
    now: Date.now,
  });
}

// Strictly increasing real time, so createdAt orders the queue without ties.
let last = 0;
const nextNow = () => (last = Math.max(Date.now(), last + 5));

async function queue(root, environment, to, body, from = caller("claude", "sender")) {
  const result = await sendProjectConversation({
    root,
    caller: from,
    environment,
    to,
    body,
    now: nextNow,
    waitMs: 0,
    deliver: async () => ({ outcome: "unavailable", evidence: "test-unavailable" }),
  });
  assert.equal(result.state, "queued");
  return result;
}

function mailbox(root) {
  const out = {};
  for (const kind of ["inbox", "inflight", "archive"]) {
    const directory = path.join(root, ".lode", "messaging", kind);
    out[kind] = [];
    if (!fs.existsSync(directory)) continue;
    for (const slot of fs.readdirSync(directory))
      for (const name of fs.readdirSync(path.join(directory, slot))) out[kind].push(JSON.parse(fs.readFileSync(path.join(directory, slot, name), "utf8")));
  }
  return out;
}
const archived = (root, id) => mailbox(root).archive.find((message) => message.id === id);
const queuedIds = (root) => mailbox(root).inbox.map((message) => message.id);
const elsewhereId = (root) => mailbox(root).inbox.find((message) => message.to.address === "codex:elsewhere")?.id;

function tree(directory, base = directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? [path.relative(base, full) + "/", ...tree(full, base)] : [path.relative(base, full)];
  });
}

const stop = (runtime, root, sessionId, extra = {}) => ({ hook_event_name: "Stop", cwd: root, session_id: sessionId, stop_hook_active: false, ...extra });

test("Claude Code Stop hands queued mail over as continuing feedback and commits only after the output was written", async (t) => {
  const { root, environment } = isolated(t);
  register(root, environment, "claude", "receiver", { kind: "claude-next-prompt" });
  const sent = await queue(root, environment, "claude:receiver", "the migration review is ready");
  let seen = null;
  const output = await runSessionHostHook({
    runtime: "claude",
    environment,
    observeOnly: true,
    event: stop("claude", root, "receiver", { last_assistant_message: "done" }),
    deliver: async (value) => {
      // Before the output is written the message is held, not yet handed over.
      seen = { inflight: mailbox(root).inflight.map((message) => message.id), archived: archived(root, sent.id) ?? null };
      assert.equal(value.hookSpecificOutput.hookEventName, "Stop");
    },
  });
  assert.deepEqual(seen, { inflight: [sent.id], archived: null });
  assert.deepEqual(Object.keys(output), ["hookSpecificOutput"]);
  assert.equal(output.decision, undefined);
  const text = output.hookSpecificOutput.additionalContext;
  assert.match(text, /the migration review is ready/);
  assert.match(text, /peer evidence/);
  assert.match(text, new RegExp(`^id: ${sent.id}$`, "m"));
  const handed = archived(root, sent.id);
  assert.equal(handed.handedToHost, true);
  assert.equal(handed.state, "sent");
  assert.equal(handed.evidence, "stop-hook");
  // The next Stop with nothing queued produces the ordinary output.
  assert.deepEqual(
    await runSessionHostHook({ runtime: "claude", environment, observeOnly: true, event: stop("claude", root, "receiver"), deliver: async () => {} }),
    {},
  );
  // A message handed at Stop is not injected again at the next prompt.
  assert.equal(
    prepareHookInjection({ runtime: "claude", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "receiver" }, environment }),
    null,
  );
});

test("Codex Stop continues through decision block with the mail as its reason and no other field", async (t) => {
  const { root, environment } = isolated(t);
  register(root, environment, "codex", "receiver", { kind: "codex-next-prompt" });
  const sent = await queue(root, environment, "codex:receiver", "codex please continue");
  const output = await runSessionHostHook({
    runtime: "codex",
    environment,
    observeOnly: true,
    event: stop("codex", root, "receiver", { turn_id: "turn-1" }),
    deliver: async () => {},
  });
  assert.deepEqual(Object.keys(output).sort(), ["decision", "reason"]);
  assert.equal(output.decision, "block");
  assert.match(output.reason, /codex please continue/);
  assert.equal(archived(root, sent.id).evidence, "stop-hook");
});

test("no Lode cap: five Stops in a row each hand over a fresh message and continue, and no new state appears under .lode", async (t) => {
  const { root, environment } = isolated(t);
  register(root, environment, "claude", "receiver", { kind: "claude-next-prompt" });
  await queue(root, environment, "claude:receiver", "warm-up");
  await runSessionHostHook({ runtime: "claude", environment, observeOnly: true, event: stop("claude", root, "receiver"), deliver: async () => {} });
  const before = tree(path.join(root, ".lode")).filter((entry) => !/^messaging[\\/](inbox|inflight|archive)[\\/]./.test(entry));
  for (let round = 1; round <= 6; round += 1) {
    const sent = await queue(root, environment, "claude:receiver", `round ${round}`);
    const output = await runSessionHostHook({
      runtime: "claude",
      environment,
      observeOnly: true,
      // The Host says it is already continuing because of a Stop hook.
      event: stop("claude", root, "receiver", { stop_hook_active: true }),
      deliver: async () => {},
    });
    assert.match(output.hookSpecificOutput.additionalContext, new RegExp(`round ${round}`), `round ${round}`);
    assert.equal(archived(root, sent.id).handedToHost, true);
  }
  const after = tree(path.join(root, ".lode")).filter((entry) => !/^messaging[\\/](inbox|inflight|archive)[\\/]./.test(entry));
  assert.deepEqual(after, before);
});

test("a failed Stop output write keeps the message as unknown, never queued or injected again", async (t) => {
  const { root, environment } = isolated(t);
  register(root, environment, "claude", "receiver", { kind: "claude-next-prompt" });
  const sent = await queue(root, environment, "claude:receiver", "write fails");
  await assert.rejects(
    runSessionHostHook({
      runtime: "claude",
      environment,
      observeOnly: true,
      event: stop("claude", root, "receiver"),
      deliver: async () => {
        throw Object.assign(new Error("EPIPE"), { code: "EPIPE" });
      },
    }),
    /EPIPE/,
  );
  const record = archived(root, sent.id);
  assert.equal(record.state, "unknown");
  assert.equal(record.evidence, "prompt-handoff-unconfirmed");
  assert.equal(record.replayAllowed, false);
  assert.deepEqual(queuedIds(root), []);
  assert.equal(
    prepareHookInjection({ runtime: "claude", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "receiver" }, environment }),
    null,
  );
  assert.deepEqual(
    await runSessionHostHook({ runtime: "claude", environment, observeOnly: true, event: stop("claude", root, "receiver"), deliver: async () => {} }),
    {},
  );
});

test("SubagentStop and a Stop from a subagent or teammate leave the parent's mail queued", async (t) => {
  const { root, environment } = isolated(t);
  register(root, environment, "claude", "parent", { kind: "claude-next-prompt" });
  register(root, environment, "codex", "parent-codex", { kind: "codex-next-prompt" });
  const claude = await queue(root, environment, "claude:parent", "for the parent");
  const codex = await queue(root, environment, "codex:parent-codex", "for the codex parent");
  for (const [runtime, event] of [
    ["claude", { ...stop("claude", root, "parent"), hook_event_name: "SubagentStop", agent_id: "child", agent_type: "Explore" }],
    ["claude", { ...stop("claude", root, "parent"), agent_id: "teammate" }],
    ["codex", { ...stop("codex", root, "parent-codex"), hook_event_name: "SubagentStop", agent_id: "child-thread" }],
    ["codex", { ...stop("codex", root, "parent-codex"), agent_id: "child-thread" }],
  ]) {
    const output = await runSessionHostHook({ runtime, environment, observeOnly: true, event, deliver: async () => {} });
    assert.equal(output.decision, undefined);
    assert.equal(output.hookSpecificOutput, undefined);
  }
  assert.deepEqual(queuedIds(root).sort(), [claude.id, codex.id].sort());
});

test("an empty inbox Stop opens no Project and writes nothing; the real hook exits well inside its timeout", async (t) => {
  const { root, environment } = isolated(t);
  const before = tree(root);
  const original = fs.realpathSync;
  let resolved = 0;
  t.mock.method(fs, "realpathSync", function (...args) {
    resolved += 1;
    return original.apply(this, args);
  });
  assert.equal(prepareStopInjection({ runtime: "claude", event: stop("claude", root, "nobody"), environment }), null);
  assert.equal(resolved, 0, "no Project storage was resolved");
  t.mock.restoreAll();
  // A messaging directory with other addresses' mail but none for this one.
  register(root, environment, "claude", "other", { kind: "claude-next-prompt" });
  await queue(root, environment, "claude:other", "not for you");
  const withMail = tree(root);
  assert.equal(prepareStopInjection({ runtime: "claude", event: stop("claude", root, "nobody"), environment }), null);
  assert.deepEqual(tree(root), withMail);
  assert.ok(before.length < withMail.length);
  const hook = path.join(pluginRoot, "scripts/session-host-hook.mjs");
  for (const runtime of ["claude", "codex"]) {
    const started = Date.now();
    const run = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [hook, "--runtime", runtime, "--observe-only"], {
        cwd: root,
        env: { ...process.env, ...environment },
        windowsHide: true,
      });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, out }));
      child.stdin.end(JSON.stringify(stop(runtime, root, "nobody")));
    });
    assert.equal(run.code, 0);
    assert.equal(run.out.trim(), "{}");
    assert.ok(Date.now() - started < 3000, `${runtime} Stop finished in ${Date.now() - started} ms`);
  }
  assert.deepEqual(tree(root), withMail);
});

test("the real Claude Stop hook process prints the mail as continuing feedback", async (t) => {
  const { root, environment } = isolated(t);
  register(root, environment, "claude", "receiver", { kind: "claude-next-prompt" });
  const sent = await queue(root, environment, "claude:receiver", "through the real hook");
  const hook = path.join(pluginRoot, "scripts/session-host-hook.mjs");
  const run = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook, "--runtime", "claude", "--observe-only"], {
      cwd: root,
      env: { ...process.env, ...environment },
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(stop("claude", root, "receiver")));
  });
  assert.equal(run.code, 0);
  const output = JSON.parse(run.out);
  assert.equal(output.hookSpecificOutput.hookEventName, "Stop");
  assert.match(output.hookSpecificOutput.additionalContext, /through the real hook/);
  assert.equal(archived(root, sent.id).handedToHost, true);
});

test("queued mail is handed over oldest first at a prompt and at Stop", async (t) => {
  const { root, environment } = isolated(t);
  register(root, environment, "codex", "receiver", { kind: "codex-next-prompt" });
  const bodies = ["first-body", "second-body", "third-body", "fourth-body", "fifth-body"];
  for (const body of bodies) await queue(root, environment, "codex:receiver", body);
  const prompt = prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "receiver" }, environment });
  const positions = bodies.map((body) => prompt.text.indexOf(body));
  assert.ok(positions.every((value) => value >= 0));
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
  );
  prompt.commit();
  for (const body of ["sixth-body", "seventh-body", "eighth-body"]) await queue(root, environment, "codex:receiver", body);
  const output = await runSessionHostHook({
    runtime: "codex",
    environment,
    observeOnly: true,
    event: stop("codex", root, "receiver"),
    deliver: async () => {},
  });
  const order = ["sixth-body", "seventh-body", "eighth-body"].map((body) => output.reason.indexOf(body));
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
});

function liveCodex(t, root, environment, id = "receiver") {
  const socket = path.join(environment.CODEX_HOME, "app-server-control.sock");
  fs.writeFileSync(socket, "");
  return register(root, environment, "codex", id, { kind: "codex-immediate", socketPath: socket });
}

test("B: a send through a live channel hands the older queued message first, then its own", async (t) => {
  const { root, environment } = isolated(t);
  liveCodex(t, root, environment);
  const older = await queue(root, environment, "codex:receiver", "older message");
  const order = [];
  const second = await sendProjectConversation({
    root,
    caller: caller("claude", "sender"),
    environment,
    to: "codex:receiver",
    body: "newer message",
    now: nextNow,
    waitMs: 0,
    deliver: async ({ message }) => {
      order.push(message.body);
      return { outcome: "delivered", evidence: "test-live" };
    },
  });
  assert.deepEqual(order, ["older message", "newer message"]);
  assert.equal(second.state, "delivered");
  assert.deepEqual(second.earlier, { handed: 1, unknown: 0, queued: 0 });
  assert.equal(archived(root, older.id).state, "delivered");
  assert.deepEqual(queuedIds(root), []);
});

test("B: an older message with an unknown outcome is kept unknown and not sent again; the new message is still attempted", async (t) => {
  const { root, environment } = isolated(t);
  liveCodex(t, root, environment);
  const older = await queue(root, environment, "codex:receiver", "older lost");
  const calls = [];
  const deliver = async ({ message }) => {
    calls.push(message.body);
    return message.body === "older lost" ? { outcome: "unknown", evidence: "test-lost-answer" } : { outcome: "delivered", evidence: "test-live" };
  };
  const second = await sendProjectConversation({
    root,
    caller: caller("claude", "sender"),
    environment,
    to: "codex:receiver",
    body: "new one",
    now: nextNow,
    waitMs: 0,
    deliver,
  });
  assert.deepEqual(calls, ["older lost", "new one"]);
  assert.equal(second.state, "delivered");
  assert.deepEqual(second.earlier, { handed: 0, unknown: 1, queued: 0 });
  assert.equal(archived(root, older.id).state, "unknown");
  assert.equal(archived(root, older.id).replayAllowed, false);
  const third = await sendProjectConversation({
    root,
    caller: caller("claude", "sender"),
    environment,
    to: "codex:receiver",
    body: "third",
    now: nextNow,
    waitMs: 0,
    deliver,
  });
  assert.deepEqual(calls, ["older lost", "new one", "third"]);
  assert.equal(third.earlier, undefined);
});

test("B: the first unavailable answer ends the pass and everything stays queued in order; the pass is bounded", async (t) => {
  const { root, environment } = isolated(t);
  liveCodex(t, root, environment);
  for (let index = 0; index < 12; index += 1) await queue(root, environment, "codex:receiver", `queued ${String(index).padStart(2, "0")}`);
  const unavailable = await sendProjectConversation({
    root,
    caller: caller("claude", "sender"),
    environment,
    to: "codex:receiver",
    body: "still nobody",
    now: nextNow,
    waitMs: 0,
    deliver: async () => ({ outcome: "unavailable", evidence: "test-unavailable" }),
  });
  assert.equal(unavailable.state, "queued");
  assert.deepEqual(unavailable.earlier, { handed: 0, unknown: 0, queued: 12 });
  assert.equal(queuedIds(root).length, 13);
  const order = [];
  const live = await sendProjectConversation({
    root,
    caller: caller("claude", "sender"),
    environment,
    to: "codex:receiver",
    body: "live now",
    now: nextNow,
    waitMs: 0,
    deliver: async ({ message }) => {
      order.push(message.body);
      return { outcome: "delivered", evidence: "test-live" };
    },
  });
  assert.deepEqual(live.earlier, { handed: 10, unknown: 0, queued: 3 });
  assert.deepEqual(order, [...Array.from({ length: 10 }, (_, index) => `queued ${String(index).padStart(2, "0")}`), "live now"]);
  assert.equal(queuedIds(root).length, 3);
});

test("presence follows a resume: the recorded channel is the resumed process's", async (t) => {
  const { root, environment } = isolated(t);
  const event = { hook_event_name: "SessionStart", source: "startup", session_id: "receiver", cwd: root };
  for (const name of ["old.sock", "new.sock"]) fs.writeFileSync(path.join(environment.HOME, name), "");
  const first = registerHookPresence({
    runtime: "claude",
    event,
    environment: { ...environment, CLAUDE_CODE_MESSAGING_SOCKET: path.join(environment.HOME, "old.sock") },
  });
  assert.equal(first.channel.socketPath, path.join(environment.HOME, "old.sock"));
  const resumed = registerHookPresence({
    runtime: "claude",
    event: { ...event, source: "resume" },
    environment: { ...environment, CLAUDE_CODE_MESSAGING_SOCKET: path.join(environment.HOME, "new.sock") },
  });
  assert.equal(resumed.channel.socketPath, path.join(environment.HOME, "new.sock"));
  for (const source of ["clear", "compact", "fork"]) assert.equal(registerHookPresence({ runtime: "claude", event: { ...event, source }, environment }), null);
});

async function openCodeHost(t, root, environment, prompts, sessions = ["ses_one"]) {
  const projectID = "host-project";
  const client = {
    session: {
      async get(input) {
        const id = input?.path?.id;
        return sessions.includes(id) ? { data: { id, projectID, directory: root } } : { data: null };
      },
      async prompt(input) {
        prompts.push({ id: input.path.id, text: input.body.parts[0].text });
        return { data: { id: "msg_" + prompts.length } };
      },
    },
  };
  const hooks = await plugin.server({ client, project: { id: projectID }, directory: root }, { environment });
  t.after(() => hooks.dispose?.());
  return hooks;
}

const settle = async (check, rounds = 25) => {
  for (let index = 0; index < rounds && !check(); index += 1) await new Promise((resolve) => setTimeout(resolve, 20));
};

// File events are switched off so only the watcher-start scan and the idle
// event can deliver; a real inbox event would otherwise race these checks.
const quietWatch = (t) => t.mock.method(fs, "watch", () => ({ unref() {}, close() {} }));

test("OpenCode: mail queued before the watcher exists is delivered by the scan when the watcher starts", async (t) => {
  const { root, environment } = isolated(t);
  quietWatch(t);
  register(root, environment, "opencode", "ses_one", { kind: "opencode-async" });
  const early = await queue(root, environment, "opencode:ses_one", "queued before the watcher");
  const prompts = [];
  const hooks = await openCodeHost(t, root, environment, prompts);
  // The first event for a session in this Project creates the watcher.
  await hooks.event({ event: { id: "evt-busy", type: "session.status", properties: { sessionID: "ses_one", status: { type: "busy" } } } });
  await settle(() => prompts.length >= 1);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].id, "ses_one");
  assert.match(prompts[0].text, /queued before the watcher/);
  assert.equal(archived(root, early.id).handedToHost, true);
});

test("OpenCode: a session's queued mail is delivered on its idle event, and only that session's", async (t) => {
  const { root, environment } = isolated(t);
  quietWatch(t);
  register(root, environment, "opencode", "ses_one", { kind: "opencode-async" });
  register(root, environment, "opencode", "ses_two", { kind: "opencode-async" });
  // The mailbox exists before the Host starts (mail for someone else).
  register(root, environment, "codex", "elsewhere", { kind: "codex-next-prompt" });
  await queue(root, environment, "codex:elsewhere", "not for OpenCode");
  const prompts = [];
  const hooks = await openCodeHost(t, root, environment, prompts, ["ses_one", "ses_two"]);
  await hooks.event({ event: { id: "evt-busy", type: "session.status", properties: { sessionID: "ses_one", status: { type: "busy" } } } });
  await settle(() => false);
  assert.equal(prompts.length, 0, "nothing was queued when the watcher started");
  const one = await queue(root, environment, "opencode:ses_one", "for one");
  const two = await queue(root, environment, "opencode:ses_two", "for two");
  await hooks.event({ event: { id: "evt-busy-2", type: "session.status", properties: { sessionID: "ses_one", status: { type: "busy" } } } });
  await settle(() => false);
  assert.equal(prompts.length, 0, "a busy status delivers nothing");
  await hooks.event({ event: { id: "evt-idle-one", type: "session.idle", properties: { sessionID: "ses_one" } } });
  await settle(() => prompts.length >= 1);
  assert.deepEqual(
    prompts.map((prompt) => prompt.id),
    ["ses_one"],
  );
  assert.match(prompts[0].text, /for one/);
  assert.equal(archived(root, one.id).handedToHost, true);
  assert.deepEqual(
    queuedIds(root).filter((id) => id !== elsewhereId(root)),
    [two.id],
  );
});
