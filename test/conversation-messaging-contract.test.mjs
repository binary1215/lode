import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { initializeProject } from "../scripts/lib/lode-core.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { resolveProjectStorage } from "../scripts/lib/project-storage-format.mjs";
import { conversationMailboxStorage, conversationHostDirectory } from "../scripts/lib/conversation-mailbox-storage.mjs";
import { absoluteSystemExecutable, processBirth } from "../scripts/lib/native-session-process.mjs";
import { ensureProjectStorageIgnore, ensureMessagingDirectoryIgnore } from "../scripts/lib/project-storage-ignore.mjs";
import { registerConversationPresence, registerHookPresence, listProjectConversations, sendProjectConversation, writeOpenCodeCallerTicket, prepareHookInjection } from "../scripts/lib/conversation-messaging.mjs";
import { deliverCodexTurn } from "../scripts/lib/conversation-messaging-codex.mjs";
import { resolveVerifiedProcessSupervisor } from "../scripts/lib/runtime-process-supervisor.mjs";
import { deliverClaudeInbox } from "../scripts/lib/conversation-messaging-claude.mjs";
import { deliverOpenCodePrompt } from "../scripts/lib/conversation-messaging-opencode.mjs";
import { inspectCopiedProjectFiles } from "../scripts/lib/project-copy-evidence.mjs";
import { withLocalMutation } from "../scripts/lib/project-mutation-lock.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const who = (runtime, nativeSessionId) => ({ runtime, nativeSessionId, agentId: null, subagent: false, parentSessionId: null });
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-message-contract-")));
  const root = path.join(base, "project"), home = path.join(base, "home");
  fs.mkdirSync(root); fs.mkdirSync(home);
  const environment = { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, "codex"), CLAUDE_CONFIG_DIR: path.join(home, "claude"), LODE_CONVERSATION_DIRECTORY: root };
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  t.after(() => { assert.equal(path.dirname(base), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(base).startsWith("lode-message-contract-")); fs.rmSync(base, { recursive: true, force: true }); });
  const mailbox = path.join(root, ".lode", "messaging");
  const register = (identity, channel = { kind: identity.runtime + "-next-prompt" }) => registerConversationPresence({ root, identity, channel, environment });
  const send = extra => sendProjectConversation({ root, environment, caller: who("claude", "sender"), to: "codex:receiver", body: "synthetic peer evidence", waitMs: 0, ...extra });
  return { base, root, home, environment, mailbox, registry: path.join(conversationHostDirectory(environment, root), "registry"), register, send };
}
function inventory(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? inventory(path.join(root, entry.name)).map(x => entry.name + "/" + x)
    : [entry.name + ":" + hash(fs.readFileSync(path.join(root, entry.name)))]).sort();
}

test("direct and typed read-only list never create mailbox, keys, registration or retention", async t => {
  const f = fixture(t), before = inventory(f.root), home = inventory(f.home);
  assert.equal(listProjectConversations({ root: f.root, environment: f.environment }).conversations.length, 0);
  const response = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lode_tools_read", arguments: { name: "lode_conversation_list", arguments: { project_root: f.root } } } }, { hostEnvironment: f.environment });
  assert.equal(response.error, undefined);
  assert.deepEqual(inventory(f.root), before); assert.deepEqual(inventory(f.home), home);
  assert.equal(fs.existsSync(f.mailbox), false);
});

test("generic sender heartbeat preserves each verified rich channel and registration generation", async t => {
  const f = fixture(t); f.register(who("codex", "receiver"));
  for (const [runtime, channel] of [["claude", { kind: "claude-immediate", socketPath: path.join(f.home, "claude.sock") }], ["codex", { kind: "codex-immediate", socketPath: path.join(f.home, "codex.sock") }], ["opencode", { kind: "opencode-async" }]]) {
    const id = who(runtime, "rich-" + runtime), before = f.register(id, channel);
    const filesBeforeList = inventory(f.mailbox);
    listProjectConversations({ root: f.root, caller: id, environment: f.environment });
    assert.deepEqual(inventory(f.mailbox), filesBeforeList);
    await f.send({ caller: id, deliver: async () => ({ outcome: "unavailable" }) });
    const stored = JSON.parse(fs.readFileSync(path.join(f.registry, "presence", hash(before.address) + ".json")));
    assert.deepEqual(stored.channel, channel); assert.equal(stored.registrationGeneration, before.registrationGeneration);
  }
});

test("presence filename, native identity, channel and registration tamper never dispatch", async t => {
  const f = fixture(t), original = f.register(who("codex", "receiver"), { kind: "codex-immediate", socketPath: path.join(f.home, "registered.sock") });
  const file = path.join(f.registry, "presence", hash(original.address) + ".json");
  let calls = 0;
  for (const mutate of [x => x.nativeSessionId = "foreign-thread", x => x.runtime = "claude", x => x.channel.socketPath = path.join(f.home, "foreign.sock"), x => x.registrationGeneration = crypto.randomUUID()]) {
    const changed = structuredClone(original); mutate(changed); fs.writeFileSync(file, JSON.stringify(changed));
    assert.equal((await f.send({ deliver: async () => { calls++; return { outcome: "delivered" }; } })).state, "unreachable");
  }
  fs.writeFileSync(file, JSON.stringify(original));
  fs.renameSync(file, path.join(path.dirname(file), "0".repeat(64) + ".json"));
  assert.equal((await f.send({ deliver: async () => { calls++; return { outcome: "delivered" }; } })).state, "unreachable");
  assert.equal(calls, 0);
});

test("mailbox and intermediate-directory junctions cannot read or write an outside canary", async t => {
  const f = fixture(t), outside = path.join(f.base, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "canary"), "unchanged");
  fs.symlinkSync(outside, f.mailbox, process.platform === "win32" ? "junction" : "dir");
  try { await assert.rejects(() => f.send(), /CONVERSATION_PATH_ESCAPE/); } finally { fs.unlinkSync(f.mailbox); }
  f.register(who("codex", "receiver"));
  const presence = path.join(f.registry, "presence"); fs.renameSync(presence, path.join(f.registry, "retained-presence"));
  fs.symlinkSync(outside, presence, process.platform === "win32" ? "junction" : "dir");
  try { assert.throws(() => listProjectConversations({ root: f.root, environment: f.environment }), /CONVERSATION_PATH_ESCAPE/); } finally { fs.unlinkSync(presence); }
  assert.deepEqual(inventory(outside), ["canary:" + hash("unchanged")]);
});

test("namespace swap during transport await preserves unknown without publishing outside", async t => {
  const f = fixture(t); f.register(who("codex", "receiver"));
  const outside = path.join(f.base, "outside"), original = path.join(f.base, "retained-mailbox"); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "canary"), "unchanged");
  let result;
  try {
    result = await f.send({ deliver: async () => { fs.renameSync(f.mailbox, original); fs.symlinkSync(outside, f.mailbox, process.platform === "win32" ? "junction" : "dir"); await Promise.resolve(); return { outcome: "delivered", evidence: "synthetic-accepted" }; } });
    assert.equal(result.state, "unknown"); assert.equal(result.preservationError.code, "CONVERSATION_PATH_ESCAPE");
    assert.deepEqual(inventory(outside), ["canary:" + hash("unchanged")]);
  } finally { if (fs.lstatSync(f.mailbox, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(f.mailbox); if (fs.existsSync(original)) fs.renameSync(original, f.mailbox); }
  assert.equal(prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: f.root, session_id: "receiver" }, environment: f.environment }), null);
});

test("ticket consumption permission failure prevents send; concurrent consumers admit only one", async t => {
  const f = fixture(t); f.register(who("codex", "receiver"));
  const args = { project_root: f.root, to: "codex:receiver", body: "ticket evidence", reply_to: null };
  const ticket = writeOpenCodeCallerTicket({ root: f.root, session: { id: "ses_sender", directory: f.root }, args, environment: f.environment });
  const original = fs.linkSync; let calls = 0;
  fs.linkSync = function(a, b) { if (String(b).includes("tickets-consumed")) throw Object.assign(Error("injected claim EACCES"), { code: "EACCES" }); return original(a, b); };
  const input = { caller: null, to: args.to, body: args.body, hostTicket: ticket, deliver: async () => { calls++; return { outcome: "unavailable" }; } };
  try { await assert.rejects(() => f.send(input), { code: "EACCES" }); } finally { fs.linkSync = original; }
  assert.equal(calls, 0);
  const attempts = await Promise.allSettled([f.send(input), f.send(input)]);
  assert.equal(attempts.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(attempts.find(x => x.status === "rejected").reason.code, "CONVERSATION_TICKET_CONSUMED_OUTCOME_UNKNOWN");
  assert.equal(calls, 1);
});

test("lost turn/start receipt is unknown and never offered again to a prompt", async t => {
  const f = fixture(t); f.register(who("codex", "receiver")); let accepted = 0;
  const result = await f.send({ deliver: async () => deliverCodexTurn({ socketPath: "/synthetic.sock", platform: "linux", threadId: "receiver", text: "synthetic only", timeoutMs: 15, spawnImpl() {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    stdin.on("data", bytes => { for (const line of bytes.toString().trim().split("\n")) { const request = JSON.parse(line); if (request.id === 1 || request.id === 2) stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\n"); if (request.method === "turn/start") accepted++; } });
    return { stdin, stdout, stderr, kill() {} };
  } }) });
  assert.equal(accepted, 1); assert.equal(result.state, "unknown");
  assert.equal(prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: f.root, session_id: "receiver" }, environment: f.environment }), null);
});

test("descriptor reads are byte-bounded and reject aliased files before decoding", t => {
  const f = fixture(t); f.register(who("codex", "receiver"));
  const io = conversationMailboxStorage(resolveProjectStorage(f.root)), file = path.join(f.mailbox, "large.json");
  io.mkdirSync(f.mailbox);
  fs.writeFileSync(file, Buffer.alloc(65537)); assert.throws(() => io.readFileSync(file, "utf8"), /CONVERSATION_RECORD_TOO_LARGE/);
  const alias = path.join(f.mailbox, "alias.json"); fs.linkSync(file, alias);
  assert.throws(() => io.readFileSync(alias, "utf8"), /CONVERSATION_UNSAFE_FILE/);
});

test("normal heartbeat during an awaited send does not invalidate the same endpoint generation", async t => {
  const f = fixture(t), before = f.register(who("codex", "receiver"));
  const result = await f.send({ deliver: async ({ assertTarget }) => {
    await Promise.resolve(); const next = f.register(who("codex", "receiver"));
    assert.equal(next.registrationGeneration, before.registrationGeneration); assertTarget();
    return { outcome: "delivered", evidence: "synthetic-current-target" };
  } });
  assert.equal(result.state, "delivered");
});

test("caller cancellation before enqueue has no effect and cancellation after admission cannot replay", async t => {
  const f = fixture(t); f.register(who("codex", "receiver")); const before = inventory(f.mailbox);
  const early = new AbortController(); early.abort();
  await assert.rejects(() => f.send({ signal: early.signal }), /CONVERSATION_DELIVERY_CANCELLED/);
  assert.deepEqual(inventory(f.mailbox), before);
  const late = new AbortController();
  assert.equal((await f.send({ signal: late.signal, deliver: async () => { late.abort(); return { outcome: "unavailable" }; } })).state, "unknown");
  assert.equal(prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: f.root, session_id: "receiver" }, environment: f.environment }), null);
});

test("peer messaging changes no common direction, Session, Canon or checkpoint originals", async t => {
  const f = fixture(t), before = inventory(path.join(f.root, ".lode")).filter(file => !file.startsWith("messaging/"));
  f.register(who("codex", "receiver"));
  await f.send({ deliver: async () => ({ outcome: "unknown", evidence: "synthetic-lost-response" }) });
  listProjectConversations({ root: f.root, environment: f.environment });
  assert.deepEqual(inventory(path.join(f.root, ".lode")).filter(file => !file.startsWith("messaging/")), before);
});

test("Claude pending write and OpenCode missing receipt remain unknown at bounded deadlines", async () => {
  let closed = 0;
  const claude = await deliverClaudeInbox({ socketPath: process.platform === "win32" ? "C:\\synthetic.sock" : "/synthetic.sock", platform: "linux", message: { id: "msg-fixture", from: { nativeSessionId: "source" }, text: "synthetic only" }, timeoutMs: 5,
    connectImpl: async () => ({ write() {}, destroy() { closed++; } }) });
  assert.equal(claude.outcome, "unknown"); assert.equal(closed, 1);
  const opencode = await deliverOpenCodePrompt({ directory: "/synthetic", sessionId: "ses-fixture", text: "synthetic only", timeoutMs: 5, client: { session: { get() {}, prompt: () => new Promise(() => {}) } } });
  assert.equal(opencode.outcome, "unknown");
});

test("Claude target refusal before and after connect preserves its code with no payload fallback", async () => {
  for (const stage of ["before-connect", "after-connect"]) {
    let checks = 0, connections = 0, writes = 0, closed = 0;
    await assert.rejects(() => deliverClaudeInbox({ socketPath: process.platform === "win32" ? "C:\\synthetic.sock" : "/synthetic.sock", platform: "linux", message: { id: "synthetic", from: { nativeSessionId: "source" }, text: "fixture" },
      assertTarget() { if (++checks === (stage === "before-connect" ? 1 : 2)) throw Object.assign(Error("target refused"), { code: "CONVERSATION_TARGET_CHANGED" }); },
      connectImpl: async () => { connections++; return { write() { writes++; }, destroy() { closed++; } }; } }), { code: "CONVERSATION_TARGET_CHANGED", conversationTargetRefused: true });
    assert.equal(writes, 0); assert.equal(connections, stage === "before-connect" ? 0 : 1); assert.equal(closed, connections);
  }
});

test("Core does not queue a target refusal hidden behind a provider connection await", async t => {
  const f = fixture(t); f.register(who("codex", "receiver"));
  const result = await f.send({ deliver: async () => deliverClaudeInbox({ socketPath: process.platform === "win32" ? "C:\\synthetic.sock" : "/synthetic.sock", platform: "linux", message: { id: "fixture", from: { nativeSessionId: "source" }, text: "synthetic" }, assertTarget() { throw Object.assign(Error("refused"), { code: "CONVERSATION_TARGET_CHANGED" }); }, connectImpl() { throw Error("must not connect"); } }) });
  assert.equal(result.state, "refused"); assert.equal(result.reasonCode, "CONVERSATION_TARGET_CHANGED");
  assert.equal(prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: f.root, session_id: "receiver" }, environment: f.environment }), null);
});

test("Project copy evidence excludes mailbox bodies, tickets and live endpoint registrations", async t => {
  const f = fixture(t); f.register(who("codex", "receiver"));
  await f.send();
  const copied = inspectCopiedProjectFiles({ root: f.root, directory: ".lode" });
  assert.equal(copied.files.some(file => file.path.startsWith(".lode/messaging/")), false);
  assert.ok(copied.excludedPaths.includes(".lode/messaging"));
});

test("literal pre75 generated ignore upgrades while mailbox history stays excluded from canon", t => {
  const f = fixture(t), file = path.join(f.root, ".lode", ".gitignore");
  const legacy = "# BEGIN Lode generated disposable storage rules\n/graph-discovery/index.json\n/.operations/\n/.snapshot-gc/\n/refresh/writer.lock/\n/refresh/writer.lock.*.staging/\n# END Lode generated disposable storage rules\n";
  fs.writeFileSync(file, legacy);
  assert.equal(ensureProjectStorageIgnore({ root: f.root, storage: resolveProjectStorage(f.root) }).status, "updated");
  const current = fs.readFileSync(file, "utf8"); assert.match(current, /^\/messaging\/$/m); assert.match(current, /Retained history, not disposable cache/);
});

test("tracked mailbox ignore survives missing git and an unreadable git index", t => {
  const f = fixture(t), git = absoluteSystemExecutable("git") || absoluteSystemExecutable("git.exe");
  assert.ok(git, "test requires existing git");
  const run = args => { const result = spawnSync(git, ["-C", f.root, ...args], { windowsHide: true, encoding: "utf8", shell: false }); assert.equal(result.status, 0, result.stderr); };
  run(["init", "--quiet"]); fs.mkdirSync(f.mailbox);
  const file = path.join(f.mailbox, ".gitignore"), before = "# Live conversation mailbox, not canon.\n*\n!.gitignore\n"; fs.writeFileSync(file, before);
  run(["add", "-f", ".lode/messaging/.gitignore"]);
  const oldPath = process.env.PATH; try { process.env.PATH = ""; assert.equal(ensureMessagingDirectoryIgnore({ root: f.root, directory: ".lode" }).reasonCode, "MESSAGING_IGNORE_TRACKING_UNKNOWN"); } finally { process.env.PATH = oldPath; }
  const index = path.join(f.root, ".git", "index"), backup = index + ".fixture-backup"; fs.renameSync(index, backup); fs.mkdirSync(index);
  try { assert.equal(ensureMessagingDirectoryIgnore({ root: f.root, directory: ".lode" }).reasonCode, "MESSAGING_IGNORE_TRACKING_UNKNOWN"); } finally { fs.rmdirSync(index); fs.renameSync(backup, index); }
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("peer PID birth observes reuse and recovers from a previously unavailable sample", () => {
  const row = start => "424242 (synthetic peer) " + [...Array(19).fill("0"), String(start)].join(" ");
  let start = 100, reads = 0;
  const options = { platform: "linux", readFile() { reads++; return row(start); } };
  assert.equal(processBirth(424242, options), "100"); start = 200;
  assert.equal(processBirth(424242, options), "200"); assert.equal(reads, 2);
  let available = false;
  const delayed = { platform: "linux", readFile() { if (!available) throw Object.assign(Error("temporarily missing"), { code: "ENOENT" }); return row(300); } };
  assert.equal(processBirth(424243, delayed), null); available = true;
  assert.equal(processBirth(424243, delayed), "300");
});

test("unverifiable lock owners are preserved and only ESRCH permits stale-owner cleanup", t => {
  const f = fixture(t), parent = path.join(f.base, "locks"); fs.mkdirSync(parent);
  const host = hash(os.hostname()).slice(0, 16), originalKill = process.kill;
  for (const [label, pid, observation, preserved] of [["unsafe-pid", "9007199254740993", null, true], ["protected-peer", "424244", "EPERM", true], ["unreadable-peer", "424245", "EACCES", true], ["known-absent", "424246", "ESRCH", false]]) {
    const directory = path.join(parent, label + ".lock"), file = path.join(directory, "owner-" + host + "-" + pid + "-" + "a".repeat(32) + ".json");
    fs.mkdirSync(directory); fs.writeFileSync(file, "synthetic owner original"); let called = 0;
    if (observation) process.kill = function(target, signal) { if (String(target) === pid && signal === 0) throw Object.assign(Error("synthetic observation"), { code: observation }); return originalKill(target, signal); };
    try {
      if (preserved) assert.throws(() => withLocalMutation({ directory, timeoutMs: 0 }, () => called++), { code: "PROJECT_MUTATION_BUSY" });
      else withLocalMutation({ directory, timeoutMs: 100 }, () => called++);
    } finally { process.kill = originalKill; }
    assert.equal(fs.existsSync(file), preserved); assert.equal(called, preserved ? 0 : 1);
    if (preserved) assert.equal(fs.readFileSync(file, "utf8"), "synthetic owner original");
  }
});

test("hardlinked and symlinked Host keys are rejected without creating a signed registration", t => {
  const f = fixture(t), keyDirectory = path.join(f.home, ".local", "state", "lode-agent-core", "conversation-tickets", hash(path.resolve(f.root)));
  fs.mkdirSync(keyDirectory, { recursive: true });
  const original = path.join(f.home, "retained-key"), key = path.join(keyDirectory, "key"); fs.writeFileSync(original, "ab".repeat(32) + "\n");
  fs.linkSync(original, key);
  assert.throws(() => f.register(who("codex", "receiver")), /CONVERSATION_TICKET_KEY_INVALID/);
  assert.equal(fs.readFileSync(original, "utf8"), "ab".repeat(32) + "\n"); assert.equal(fs.statSync(original).nlink, 2);
  fs.unlinkSync(key);
  if (process.platform !== "win32") {
    fs.symlinkSync(original, key);
    assert.throws(() => f.register(who("codex", "receiver")), /CONVERSATION_TICKET_KEY_INVALID/);
    fs.unlinkSync(key);
  }
  assert.equal(listProjectConversations({ root: f.root, environment: f.environment }).conversations.length, 0);
  const registered = f.register(who("codex", "receiver")); assert.match(registered.registrationMac, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(original, "utf8"), "ab".repeat(32) + "\n");
});

test("real native supervisor owns a synthetic Codex proxy and verifies cleanup without provider calls", async t => {
  const f = fixture(t), selectionRoot = process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || pluginRoot;
  const selection = resolveVerifiedProcessSupervisor({ pluginRoot: selectionRoot });
  const bin = path.join(f.base, "synthetic-bin"); fs.mkdirSync(bin);
  const script = path.join(bin, "fake.js");
  const trace = path.join(f.base, "synthetic-requests.log");
  fs.writeFileSync(script, `import readline from 'node:readline'; import fs from 'node:fs';
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{const r=JSON.parse(line);if(!r.id)return;fs.appendFileSync(${JSON.stringify(trace)},r.method+'\\n');if(r.method==='turn/start'&&r.params.input[0].text==='drop-receipt'){fs.appendFileSync(${JSON.stringify(trace)},'drop-receipt-accepted\\n');return;}const result=r.method==='turn/start'?{turn:{id:'synthetic-turn'}}:{};process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');});
input.on('close',()=>process.exit(0));
`);
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "codex.cmd"), '@echo off\n"%~dp0%\\fake.js"\n');
  else { const entry = path.join(bin, "codex"); fs.writeFileSync(entry, `#!${process.execPath}\nimport '${new URL("file://" + script).href}';\n`); fs.chmodSync(entry, 0o755); }
  const result = await deliverCodexTurn({ socketPath: path.join(f.base, "synthetic.sock"), root: f.root, threadId: "synthetic-receiver", text: "synthetic peer message only", supervisorSelection: selection, timeoutMs: 3000,
    env: { ...f.environment, PATH: bin, PATHEXT: ".CMD", SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: f.base, TMP: f.base } });
  assert.equal(result.outcome, "delivered", JSON.stringify(result));
  assert.equal(result.receipt, "synthetic-turn"); assert.equal(result.cleanup.verified, true);
  assert.equal(result.cleanup.supervision.ownershipEstablished, true); assert.equal(result.cleanup.supervision.treeCleanupVerified, true);
  const environment = { ...f.environment, PATH: bin, PATHEXT: ".CMD", SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: f.base, TMP: f.base };
  let guards = 0;
  await assert.rejects(() => deliverCodexTurn({ socketPath: path.join(f.base, "synthetic.sock"), root: f.root, threadId: "synthetic-receiver", text: "refused-payload", supervisorSelection: selection, env: environment,
    assertTarget() { if (++guards === 4) throw Object.assign(Error("refused before queued turn write"), { code: "CONVERSATION_TARGET_CHANGED" }); } }), { code: "CONVERSATION_TARGET_CHANGED", conversationTargetRefused: true });
  assert.equal(fs.readFileSync(trace, "utf8").split("\n").filter(line => line === "turn/start").length, 1);
  const controller = new AbortController();
  const monitor = setInterval(() => { if (fs.readFileSync(trace, "utf8").includes("drop-receipt-accepted")) controller.abort(); }, 5);
  const bound = setTimeout(() => controller.abort(), 5000);
  try {
    const lost = await deliverCodexTurn({ socketPath: path.join(f.base, "synthetic.sock"), root: f.root, threadId: "synthetic-receiver", text: "drop-receipt", supervisorSelection: selection, env: environment, signal: controller.signal });
    assert.ok(fs.readFileSync(trace, "utf8").includes("drop-receipt-accepted"));
    assert.equal(lost.outcome, "unknown"); assert.equal(lost.cleanup.verified, true);
  } finally { clearInterval(monitor); clearTimeout(bound); }
});

test("Host startup discovers peers without changing Project; recovery and empty lookup do not publish", t => {
  const f = fixture(t), projectBefore = inventory(f.root);
  const event = { hook_event_name: "SessionStart", source: "startup", session_id: "receiver", cwd: f.root };
  const registered = registerHookPresence({ runtime: "codex", event, environment: f.environment });
  assert.equal(registered.address, "codex:receiver");
  assert.deepEqual(inventory(f.root), projectBefore);
  assert.equal(fs.existsSync(f.mailbox), false);
  const hostBefore = inventory(f.home);
  const listed = listProjectConversations({ root: f.root, environment: f.environment });
  assert.equal(listed.conversations[0].address, "codex:receiver");
  for (const source of ["resume", "clear", "compact", "fork"]) {
    assert.equal(registerHookPresence({ runtime: "codex", event: { ...event, source, session_id: source }, environment: f.environment }), null);
  }
  assert.equal(registerHookPresence({ runtime: "codex", event, environment: f.environment, initialize: false }), null);
  assert.equal(prepareHookInjection({ runtime: "codex", event: { ...event, hook_event_name: "UserPromptSubmit" }, environment: f.environment }), null);
  assert.deepEqual(inventory(f.root), projectBefore);
  assert.deepEqual(inventory(f.home), hostBefore);
});

test("Host registry namespace replacement during transport cannot authorize or publish success", async t => {
  const f = fixture(t); f.register(who("codex", "receiver"));
  const retained = f.registry + "-original", outside = path.join(f.base, "registry-outside");
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "canary"), "unchanged");
  let result;
  try {
    result = await f.send({ deliver: async ({ assertTarget }) => {
      fs.renameSync(f.registry, retained);
      fs.symlinkSync(outside, f.registry, process.platform === "win32" ? "junction" : "dir");
      await Promise.resolve();
      assertTarget();
      return { outcome: "delivered", evidence: "must-not-occur" };
    } });
    assert.equal(result.state, "refused"); assert.equal(result.reasonCode, "CONVERSATION_PATH_ESCAPE");
    assert.deepEqual(inventory(outside), ["canary:" + hash("unchanged")]);
  } finally {
    if (fs.lstatSync(f.registry, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(f.registry);
    if (fs.existsSync(retained)) fs.renameSync(retained, f.registry);
  }
  assert.equal(prepareHookInjection({ runtime: "codex", event: { hook_event_name: "UserPromptSubmit", cwd: f.root, session_id: "receiver" }, environment: f.environment }), null);
});

test("old Project presence remains diagnostic and private registry survives module replacement", async t => {
  const f = fixture(t);
  const legacy = path.join(f.mailbox, "presence"); fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, hash("codex:old") + ".json"), JSON.stringify({ address: "codex:old" }));
  const projectBefore = inventory(f.root), homeBefore = inventory(f.home);
  const old = listProjectConversations({ root: f.root, environment: f.environment });
  assert.equal(old.registrationNotice.unverified, 1); assert.deepEqual(old.conversations, []);
  assert.deepEqual(inventory(f.root), projectBefore); assert.deepEqual(inventory(f.home), homeBefore);
  f.register(who("codex", "receiver"));
  const replacement = await import("../scripts/lib/conversation-messaging.mjs?registry-replacement");
  assert.equal(replacement.listProjectConversations({ root: f.root, environment: f.environment }).conversations[0].address, "codex:receiver");
  const marker = path.join(f.root, ".lode", "project.json"), raw = fs.readFileSync(marker), original = JSON.parse(raw);
  try {
    fs.writeFileSync(marker, JSON.stringify({ ...original, projectId: original.projectId + "-changed" }));
    assert.throws(() => replacement.listProjectConversations({ root: f.root, environment: f.environment }), { code: "PROJECT_IDENTITY_MISMATCH" });
  } finally { fs.writeFileSync(marker, raw); }
});

test("optional fresh Host registration never inherits the ordinary ten-second lock wait", t => {
  const f = fixture(t); f.register(who("claude", "receiver"));
  const event = { hook_event_name: "UserPromptSubmit", session_id: "receiver", cwd: f.root };
  for (const lock of [path.join(f.registry, ".registration-locks", hash("claude:receiver") + ".lock"), path.join(path.dirname(f.registry), "key-access.lock")]) {
    fs.mkdirSync(lock);
    const owner = path.join(lock, "owner-" + hash(os.hostname()).slice(0, 16) + "-" + process.pid + "-" + "a".repeat(32) + ".json");
    fs.writeFileSync(owner, "{}");
    const before = inventory(f.root), hostBefore = inventory(f.home), started = Date.now();
    try {
      assert.equal(registerHookPresence({ runtime: "claude", event, environment: f.environment }), null);
      assert.ok(Date.now() - started < 1500, "optional registration must not inherit the ten-second wait");
      assert.deepEqual(inventory(f.root), before);
      assert.deepEqual(inventory(f.home), hostBefore);
    } finally { fs.unlinkSync(owner); fs.rmdirSync(lock); }
  }
});

test("a linked Host-private ancestor is refused without reading or changing outside data", t => {
  const f = fixture(t); f.register(who("codex", "receiver"));
  const parent = path.dirname(f.registry), retained = parent + "-retained", outside = path.join(f.base, "private-ancestor-outside");
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "canary"), "unchanged");
  fs.renameSync(parent, retained); fs.symlinkSync(outside, parent, process.platform === "win32" ? "junction" : "dir");
  try {
    assert.throws(() => listProjectConversations({ root: f.root, environment: f.environment }), { code: "CONVERSATION_PATH_ESCAPE" });
    assert.deepEqual(inventory(outside), ["canary:" + hash("unchanged")]);
  } finally { fs.unlinkSync(parent); fs.renameSync(retained, parent); }
});

test("provider await never owns the recipient transition lock and an uncertain attempt stays exact", async t => {
  const f = fixture(t); f.register(who("codex", "receiver"));
  const lock = path.join(f.mailbox, ".delivery-locks", hash("codex:receiver") + ".lock");
  let before, after;
  const result = await f.send({ deliver: async ({ message }) => {
    assert.equal(fs.existsSync(lock), false);
    const file = path.join(f.mailbox, "inflight", hash("codex:receiver"), message.id + ".json");
    before = fs.readFileSync(file);
    assert.equal(prepareHookInjection({ runtime: "codex", environment: f.environment, event: {
      hook_event_name: "UserPromptSubmit", cwd: f.root, session_id: "receiver" } }), null);
    after = fs.readFileSync(file);
    assert.deepEqual(after, before, "an admitted live attempt cannot be rewritten by another prompt");
    await Promise.resolve(); assert.equal(fs.existsSync(lock), false);
    return { outcome: "unknown", evidence: "synthetic receipt loss" };
  } });
  assert.equal(result.state, "unknown");
  assert.equal(prepareHookInjection({ runtime: "codex", environment: f.environment,
    event: { hook_event_name: "UserPromptSubmit", cwd: f.root, session_id: "receiver" } }), null);
});
