import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, snapshot } from "./helpers/session-work-linkage-fixture.mjs";
import { exportProjectBundle } from "../scripts/lib/storage/project-portability.mjs";
import { captureProviderNativeHistory } from "../scripts/lib/session/provider-native-history-payload.mjs";
import { attachProjectNativeTransfer, readProjectNativeTransfer } from "../scripts/lib/session/project-native-transfer.mjs";
import { operateProjectNativeHistory } from "../scripts/lib/session/project-native-history.mjs";
import { claudeNativeProjectName } from "../scripts/lib/session/claude-native-history.mjs";
import { nativeEnvironment, createProviderNativeHost } from "../scripts/lib/session/provider-native-history-host.mjs";
import { fileURLToPath } from "node:url";
import { runCommand } from "../scripts/lode.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";

const id = "11111111-2222-4333-8444-555555555555";
const claudeRows = [ { type: "user", uuid: "message_selected", sessionId: id, parentUuid: null,
  message: { role: "user", content: "Synthetic selected history" } } ];
const rawClaude = Buffer.from(claudeRows.map(row => JSON.stringify(row)).join("\n") + "\n");
const data = (nativeId = "ses_selected", messageId = "msg_selected", partId = "prt_selected") => ({
  info: { id: nativeId, title: "Synthetic only", slug: "synthetic", version: "1.19.5", directory: "C:/old", projectID: "old",
    time: { created: 1, updated: 2, compacting: 3 }, workspaceID: "old-workspace", permission: [{ permission: "*", pattern: "*", action: "allow" }],
    agent: "old-agent", model: { providerID: "old-provider", modelID: "old-model" }, metadata: { note: "Historical metadata" } },
  messages: [{ info: { id: messageId, sessionID: nativeId, role: "user", time: { created: 1 }, agent: "historical-agent",
    model: { providerID: "historical-provider", modelID: "historical-model" } },
    parts: [{ id: partId, sessionID: nativeId, messageID: messageId, type: "text", text: "Synthetic original" }] }],
});
function setup(t, provider, { companion = false, multiple = false } = {}) {
  const f = fixture(t), source = path.join(f.base, "raw-source"), payload = path.join(f.base, "payload"), bundle = path.join(f.base, "bundle");
  fs.mkdirSync(source);
  const ids = provider === "claude" ? [id] : ["ses_selected", ...(multiple ? ["ses_second"] : [])], files = [];
  for (const [index, nativeId] of ids.entries()) {
    const relative = provider === "claude" ? "selected.jsonl" : nativeId + ".json";
    fs.writeFileSync(path.join(source, relative), provider === "claude" ? rawClaude : JSON.stringify(data(nativeId, "msg_" + index, "prt_" + index)));
    files.push({ path: relative, nativeId, role: "conversation" });
  }
  if (companion) {
    const relative = id + "/subagents/agent-one.jsonl";
    fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true }); fs.writeFileSync(path.join(source, relative), "Synthetic companion bytes\n");
    files.push({ path: relative, nativeId: id, role: "companion" });
  }
  captureProviderNativeHistory({ provider, sourceDirectory: source, destination: payload, nativeIds: ids, files,
    reportedClientVersion: provider === "claude" ? "2.1.223" : "1.19.5" });
  f.route(() => exportProjectBundle({ root: f.root, destination: bundle }));
  attachProjectNativeTransfer({ provider, bundleRoot: bundle, directory: payload });
  const home = path.join(f.base, "new-target"); fs.mkdirSync(home);
  const project = path.join(f.base, "new-project"); fs.mkdirSync(project);
  return { ...f, bundle, home, project, source, ids };
}
function claudeHost(overrides = {}) {
  return { provider: "claude", evidenceKind: "synthetic-test", async version() { return "2.1.223"; },
    async writers() { return { status: "observed", writers: [] }; },
    async readClaude() { return { sessions: [{ sessionId: id, listed: true, messages: claudeRows.map(row => ({ uuid: row.uuid, message: row.message })) }] }; }, ...overrides };
}
function openHost(overrides = {}) {
  const profiles = new Map(), calls = [];
  const host = { provider: "opencode", evidenceKind: "synthetic-test", profiles, calls, imports: 0,
    atomicProfileId: "opencode-synthetic-atomic-v1",
    clientVersion: "1.19.5",
    async version() { return "1.19.5"; },
    async run({ args, cwd, home }) {
      calls.push({ args, cwd, home });
      if (!profiles.has(home)) profiles.set(home, new Map());
      const profile = profiles.get(home);
      if (args[0] === "export") {
        if (!profile.has(args[1])) throw Object.assign(Error("Synthetic selected ID absent"), { code: "SYNTHETIC_ID_ABSENT" });
        return { stdout: Buffer.from(JSON.stringify(profile.get(args[1])) + "\n"), exitCode: 0 };
      }
      if (args.join(" ") === "session list --format json") return { stdout: Buffer.from(JSON.stringify([...profile.values()].filter(x => !x.info.parentID).map(x => x.info))), exitCode: 0 };
      assert.fail("A prompt/server/run command was attempted");
    } };
  const target = (raw, cwd) => {
    const value = JSON.parse(raw); value.info.directory = cwd; value.info.projectID = "target-project"; value.info.path = ""; return value;
  };
  host.observeAtomicBatch = async ({ documents, cwd, home }) => {
    const stored = profiles.get(home) ?? new Map(), present = documents.filter(row => stored.has(row.nativeId));
    if (!present.length) return { state: "absent" };
    if (present.length !== documents.length) return { state: "partial" };
    if (documents.some(row => JSON.stringify(stored.get(row.nativeId)) !== JSON.stringify(target(row.raw, cwd)))) return { state: "diverged" };
    return { state: "matches", evidenceDigest: "a".repeat(64), documents: documents.map(row => stored.get(row.nativeId)) };
  };
  host.publishAtomicBatch = async ({ documents, cwd, home }) => {
    host.imports++; const staged = new Map(profiles.get(home) ?? []);
    if (!fs.existsSync(home)) fs.mkdirSync(home);
    for (const row of documents) {
      const value = target(row.raw, cwd); staged.set(row.nativeId, value);
      if (overrides.afterImport) await overrides.afterImport({ host, value, home });
    }
    profiles.set(home, staged);
  };
  host.exportSelected = async ({ nativeId }) => {
    const values = [...profiles.values()].filter(profile => profile.has(nativeId));
    if (values.length !== 1) throw Object.assign(Error("Synthetic Host source route is ambiguous"), { code: "SYNTHETIC_SOURCE_ROUTE_UNRESOLVED" });
    return Buffer.from(JSON.stringify(values[0].get(nativeId)) + "\n");
  };
  return host;
}
const restore = (f, host, extra = {}) => operateProjectNativeHistory({ action: "restore", bundleRoot: f.bundle,
  nativeHome: f.home, root: f.project, nativeHistoryHost: host, ...extra });

test("Claude public CLI restores exact originals/companions, reuses identical files, and typed register observes returned SDK records only", async t => {
  const f = setup(t, "claude", { companion: true }), host = claudeHost(), sourceBefore = snapshot(f.source), coreBefore = snapshot(f.root);
  const result = await runCommand(["project-native-history", f.bundle, "--action", "restore", "--native-home", f.home, "--runtime-root", f.project], { nativeHistoryHost: host });
  assert.equal(result.status, "native-raw-restoration-verified"); assert.equal(result.filesWritten, 2);
  const restored = path.join(f.home, "projects", claudeNativeProjectName(f.project), id + ".jsonl");
  assert.deepEqual(fs.readFileSync(restored), rawClaude);
  const before = snapshot(f.home), repeated = await restore(f, host);
  assert.equal(repeated.filesWritten, 0); assert.deepEqual(snapshot(f.home), before);
  const response = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "head_project_native_history", arguments: {
    action: "register", bundle_root: f.bundle, native_home: f.home, runtime_root: f.project } } }, { nativeHistoryHost: host });
  assert.equal(response.error, undefined);
  assert.equal(response.result.structuredContent.status, "native-history-reader-observed");
  assert.equal(response.result.structuredContent.clientEvidence, "synthetic-test");
  assert.equal(response.result.structuredContent.pickerVisibility, "not-observed");
  assert.equal(response.result.structuredContent.continuationReady, false);
  assert.deepEqual(snapshot(f.source), sourceBefore); assert.deepEqual(snapshot(f.root), coreBefore);
});

test("Claude conflicting target, duplicate in another project, or active writer cannot publish or create a successful journal", async t => {
  for (const mode of ["conflict", "other-project", "writer"]) await t.test(mode, async t => {
    const f = setup(t, "claude"), folder = mode === "other-project" ? "other-project" : claudeNativeProjectName(f.project);
    if (mode !== "writer") {
      const file = path.join(f.home, "projects", folder, id + ".jsonl"); fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, mode === "conflict" ? "Different existing content" : rawClaude);
    }
    const before = snapshot(f.home), host = claudeHost({ async writers() { return { status: "observed", writers: [{ pid: 123, birth: "synthetic" }] }; } });
    if (mode === "conflict") assert.equal((await restore(f, host)).status, "native-history-target-conflict");
    else await assert.rejects(() => restore(f, host), { code: mode === "writer" ? "NATIVE_CLAUDE_WRITER_WINDOW_UNAVAILABLE" : "NATIVE_CLAUDE_OTHER_PROJECT_ID_CONFLICT" });
    assert.deepEqual(snapshot(f.home), before);
  });
});

test("Claude cancellation after first publication preserves partial effects and never replays the remaining write", async t => {
  const f = setup(t, "claude", { companion: true }), controller = new AbortController(); let calls = 0;
  const host = claudeHost({ async writers() { if (++calls === 3) controller.abort(); return { status: "observed", writers: [] }; } });
  const first = await restore(f, host, { signal: controller.signal });
  assert.equal(first.status, "native-registration-uncertain"); assert.equal(first.filesWritten, 1);
  assert.match(first.primaryFailure.code, /CANCELLED/);
  const before = snapshot(f.home), retry = await restore(f, claudeHost());
  assert.equal(retry.status, "native-registration-uncertain"); assert.equal(retry.filesWritten, 0);
  assert.deepEqual(snapshot(f.home), before);
});

test("Claude native capture uses explicit source path and bounded companion selection through typed MCP", async t => {
  const f = fixture(t), bundle = path.join(f.base, "capture-bundle"), home = path.join(f.base, "claude-source"), folder = claudeNativeProjectName(f.root);
  f.route(() => exportProjectBundle({ root: f.root, destination: bundle }));
  const root = path.join(home, "projects", folder); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, id + ".jsonl"), rawClaude);
  const before = snapshot(home);
  const response = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "head_project_native_history", arguments: {
    action: "capture", provider: "claude", bundle_root: bundle, native_home: home, runtime_root: f.root, thread_ids: [id] } } }, { nativeHistoryHost: claudeHost() });
  assert.equal(response.error, undefined); assert.equal(response.result.structuredContent.status, "verified-native-raw-transfer");
  assert.deepEqual(snapshot(home), before);
  assert.equal(readProjectNativeTransfer({ bundleRoot: bundle }).native.provider, "claude");
});

test("OpenCode atomic batch profile restores independently, preserves historical settings and does not repeat publication", async t => {
  const f = setup(t, "opencode", { multiple: true }), host = openHost(), before = snapshot(f.root);
  const result = await runCommand(["project-native-history", f.bundle, "--action", "restore", "--native-home", f.home, "--runtime-root", f.project], { nativeHistoryHost: host });
  assert.equal(result.status, "native-isolated-history-restoration-verified");
  assert.equal(result.historyReadbackVerified, true); assert.equal(result.defaultProfileChanged, false); assert.equal(host.imports, 1);
  const imported = host.profiles.get(path.join(f.home, "profile")).get("ses_selected");
  for (const key of ["permission", "model", "agent", "workspaceID"]) assert.equal(Object.hasOwn(imported.info, key), false);
  assert.equal(Object.hasOwn(imported.info.time, "compacting"), false);
  assert.equal(imported.messages[0].info.agent, "historical-agent"); assert.equal(imported.info.metadata.note, "Historical metadata");
  const retry = await restore(f, host); assert.equal(retry.importsAttempted, 0); assert.equal(host.imports, 1);
  const response = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "head_project_native_history", arguments: {
    action: "register", bundle_root: f.bundle, native_home: f.home, runtime_root: f.project } } }, { nativeHistoryHost: host });
  assert.equal(response.error, undefined); assert.equal(response.result.structuredContent.status, "native-history-reader-observed");
  assert.equal(response.result.structuredContent.continuationReady, false); assert.deepEqual(snapshot(f.root), before);
  const env = nativeEnvironment("opencode", path.join(f.home, "profile"));
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1"); assert.ok(env.XDG_DATA_HOME.startsWith(f.home));
  assert.equal(Object.hasOwn(env, "ANTHROPIC_API_KEY"), false);
  assert.ok(host.calls.every(call => ["export", "session"].includes(call.args[0])));
});

test("OpenCode failed atomic publication stays uncertain and an absent batch is never replayed", async t => {
  const f = setup(t, "opencode", { multiple: true }), host = openHost({ afterImport({ host }) {
    if (host.imports === 1) throw Object.assign(Error("Synthetic post-effect failure"), { code: "SYNTHETIC_IMPORT_INTERRUPTED" });
  } });
  const result = await restore(f, host);
  assert.equal(result.status, "native-registration-uncertain"); assert.equal(result.primaryFailure.code, "SYNTHETIC_IMPORT_INTERRUPTED");
  assert.equal(result.historyReadbackVerified, false); assert.equal(host.imports, 1);
  assert.equal(host.profiles.get(path.join(f.home, "profile"))?.size ?? 0, 0);
  const retry = await restore(f, host);
  assert.equal(retry.status, "native-registration-uncertain"); assert.equal(retry.importsAttempted, 0); assert.equal(host.imports, 1);
});

test("OpenCode lost result receipt reconciles exact current export without replaying the completed import", async t => {
  const f = setup(t, "opencode"), host = openHost(), original = fs.linkSync; let injected = false;
  t.mock.method(fs, "linkSync", function(from, to, ...args) {
    if (!injected && String(to).endsWith(".result.json")) { injected = true; throw Object.assign(Error("Synthetic receipt failure"), { code: "SYNTHETIC_RECEIPT_FAILED" }); }
    return original.call(this, from, to, ...args);
  });
  const result = await restore(f, host);
  assert.equal(result.status, "native-history-operation-uncertain"); assert.equal(result.primaryFailure.code, "SYNTHETIC_RECEIPT_FAILED");
  assert.equal(host.imports, 1);
  const retry = await restore(f, host);
  assert.equal(retry.historyReadbackVerified, true); assert.equal(retry.importsAttempted, 0); assert.equal(host.imports, 1);
});

test("OpenCode never admits an existing ordinary profile or changes the target project of an admitted profile", async t => {
  const f = setup(t, "opencode"), host = openHost();
  let versionCalls = 0; host.version = async () => { versionCalls++; return "1.19.5"; };
  fs.writeFileSync(path.join(f.home, "ordinary-user-file"), "preserve");
  const before = snapshot(f.home);
  await assert.rejects(() => restore(f, host), { code: "NATIVE_OPENCODE_NEW_ISOLATED_PROFILE_REQUIRED" });
  assert.equal(host.imports, 0); assert.deepEqual(snapshot(f.home), before);
  assert.equal(versionCalls, 0);
  const clean = path.join(f.base, "clean-profile"); fs.mkdirSync(clean);
  await restore(f, host, { nativeHome: clean });
  const changed = path.join(f.base, "another-project"); fs.mkdirSync(changed);
  await assert.rejects(() => restore(f, host, { nativeHome: clean, root: changed }), { code: "NATIVE_OPENCODE_PROFILE_CONFLICT" });
  assert.equal(host.imports, 1);
  assert.equal(versionCalls, 1);
});

test("OpenCode capture retains exact official export bytes and core recovery remains independent", async t => {
  const f = fixture(t), bundle = path.join(f.base, "capture-bundle"), home = path.join(f.base, "source-profile"), host = openHost();
  fs.mkdirSync(home); host.profiles.set(home, new Map([["ses_selected", data()]]));
  f.route(() => exportProjectBundle({ root: f.root, destination: bundle }));
  const original = Buffer.from(JSON.stringify(data()) + "\n"), before = snapshot(f.root);
  const result = await operateProjectNativeHistory({ action: "capture", provider: "opencode", bundleRoot: bundle,
    root: f.root, threadIds: ["ses_selected"], nativeHistoryHost: host });
  assert.equal(result.status, "verified-native-raw-transfer"); assert.equal(host.imports, 0);
  const read = readProjectNativeTransfer({ bundleRoot: bundle }), entry = read.native.payload.files[0];
  assert.deepEqual(fs.readFileSync(path.join(read.native.directory, "objects", entry.sha256 + ".bin")), original);
  assert.deepEqual(snapshot(f.root), before);
});

test("unqualified OpenCode default CLI is unavailable before any version command or source/target profile access", async t => {
  const f = setup(t, "opencode"), before = snapshot(f.home), events = [];
  for (const action of ["capture", "restore", "register"]) {
    const result = await operateProjectNativeHistory({ action, provider: "opencode", bundleRoot: f.bundle, executable: process.execPath,
      nativeHome: path.join(f.home, "not-a-profile"), root: f.project, ...(action === "capture" ? { threadIds: ["ses_selected"] } : {}), onProcess: e => events.push(e) });
    assert.equal(result.reasonCode, "NATIVE_OPENCODE_BOOTSTRAP_UNQUALIFIED");
    assert.equal(result.nativeHomeInspected, false); assert.equal(result.sdkLifecycleRequestedThisCall, false);
  }
  assert.deepEqual(events, []); assert.deepEqual(snapshot(f.home), before);
});

test("OpenCode source export uses only the current Host capability, without CLI or invented profile layout", async t => {
  const f = fixture(t), bundle = path.join(f.base, "host-capture");
  f.route(() => exportProjectBundle({ root: f.root, destination: bundle }));
  let exports = 0;
  const host = { provider: "opencode", evidenceKind: "host-metadata-capability", clientVersion: "1.19.5",
    async exportSelected({ nativeId, projectRoot }) { assert.equal(nativeId, "ses_selected"); assert.equal(projectRoot, f.root); exports++; return Buffer.from(JSON.stringify(data()) + "\n"); },
    async version() { assert.fail("Source capture must not start a version command"); },
    async run() { assert.fail("Source capture must not launch a new CLI"); } };
  const result = await operateProjectNativeHistory({ action: "capture", provider: "opencode", bundleRoot: bundle,
    root: f.root, threadIds: ["ses_selected"], nativeHistoryHost: host });
  assert.equal(exports, 1); assert.equal(result.sourceCaptureCapability, "current-host-exact-id-export");
  await assert.rejects(() => operateProjectNativeHistory({ action: "capture", provider: "opencode", bundleRoot: bundle,
    nativeHome: f.base, root: f.root, threadIds: ["ses_selected"], nativeHistoryHost: host }), { code: "NATIVE_OPENCODE_SOURCE_IS_HOST_ROUTED" });
});

test("Claude refuses companion escape, junctions and hardlinked targets without writing through them", async t => {
  const f = setup(t, "claude"), outside = path.join(f.base, "outside"); fs.mkdirSync(outside);
  const link = path.join(f.home, "projects"); fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  const before = snapshot(outside);
  await assert.rejects(() => restore(f, claudeHost()), { code: "PROJECT_COPY_UNSAFE_PATH" });
  assert.deepEqual(snapshot(outside), before);
  const clean = path.join(f.base, "hardlink-target"); fs.mkdirSync(clean);
  const target = path.join(clean, "projects", claudeNativeProjectName(f.project), id + ".jsonl");
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.linkSync(path.join(f.source, "selected.jsonl"), target);
  await assert.rejects(() => restore(f, claudeHost(), { nativeHome: clean }), { code: "PROJECT_COPY_UNSAFE_FILE" });
  const empty = path.join(f.base, "empty-source"), sourceProject = path.join(empty, "projects", claudeNativeProjectName(f.project));
  fs.mkdirSync(sourceProject, { recursive: true }); fs.writeFileSync(path.join(sourceProject, id + ".jsonl"), rawClaude);
  const sourceBefore = snapshot(empty);
  await assert.rejects(() => operateProjectNativeHistory({ action: "capture", provider: "claude", bundleRoot: f.bundle,
    nativeHome: empty, root: f.project, threadIds: [id], companionPaths: ["../outside"], nativeHistoryHost: claudeHost() }), { code: "NATIVE_CLAUDE_COMPANION_SCOPE_UNSUPPORTED" });
  assert.deepEqual(snapshot(empty), sourceBefore);
});

test("Claude detects source and target change after planning and preserves the primary uncertainty", async t => {
  for (const mode of ["source", "target"]) await t.test(mode, async t => {
    const f = setup(t, "claude"); let calls = 0;
    const host = claudeHost({ async writers() {
      if (++calls === 2) {
        if (mode === "target") {
          const file = path.join(f.home, "projects", claudeNativeProjectName(f.project), id + ".jsonl");
          fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "Concurrent target content");
        } else {
          const read = readProjectNativeTransfer({ bundleRoot: f.bundle }), entry = read.native.payload.files[0];
          fs.writeFileSync(path.join(read.native.directory, "objects", entry.sha256 + ".bin"), "Concurrent source change");
        }
      }
      return { status: "observed", writers: [] };
    } });
    const result = await restore(f, host);
    assert.equal(result.filesWritten, 0); assert.equal(result.status, "native-registration-uncertain");
    assert.equal(result.primaryFailure.code, mode === "target" ? "NATIVE_CLAUDE_TARGET_CHANGED" : "NATIVE_HISTORY_PAYLOAD_IDENTITY_MISMATCH");
  });
});

test("Host callbacks cannot be supplied through public CLI or MCP data arguments", async t => {
  const f = setup(t, "claude"), before = snapshot(f.home);
  await assert.rejects(() => runCommand(["project-native-history", f.bundle, "--action", "restore", "--native-history-host", "synthetic-test"]));
  const result = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "head_project_native_history",
    arguments: { action: "restore", bundle_root: f.bundle, nativeHistoryHost: { evidenceKind: "synthetic-test" } } } });
  assert.ok(result.error); assert.match(result.error.message, /Unsupported native history arguments/);
  assert.deepEqual(snapshot(f.home), before);
});

test("finite hidden driver supervises a synthetic Node tree and cancellation; it does not qualify either official client", async t => {
  const pluginRoot = process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT;
  if (!pluginRoot) return t.skip("An existing verified supervisor fixture is required; no download/build is performed.");
  const f = fixture(t), events = [], home = path.join(f.base, "finite-home"); fs.mkdirSync(home);
  const script = path.join(f.base, "import");
  fs.writeFileSync(script, 'const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true});c.unref();process.stdout.write("synthetic-driver-ok");');
  const host = createProviderNativeHost({ provider: "opencode", executable: process.execPath, pluginRoot, onProcess: e => events.push(e) });
  const completed = await host.run({ args: ["import", "synthetic-input"], cwd: f.base, home });
  assert.equal(completed.stdout.toString(), "synthetic-driver-ok"); assert.equal(completed.supervision.treeCleanupVerified, true);
  assert.equal(host.evidenceKind, "external-client-command-unqualified");
  const controller = new AbortController(), cancelledEvents = [];
  fs.writeFileSync(script, "setInterval(()=>{},1000)");
  const cancelled = createProviderNativeHost({ provider: "opencode", executable: process.execPath, pluginRoot, signal: controller.signal,
    onProcess(e) { cancelledEvents.push(e); if (e.control?.type === "provider.started") setTimeout(() => controller.abort(), 100); } });
  await assert.rejects(() => cancelled.run({ args: ["import", "synthetic-input"], cwd: f.base, home }), { code: "NATIVE_HISTORY_OPERATION_CANCELLED" });
  assert.ok(cancelledEvents.some(e => e.event === "closed" && e.supervision.treeCleanupVerified));
  assert.ok(events.some(e => e.event === "planned" && e.windowsHide));
});

test("dedicated SDK reader uses only list/message APIs against a synthetic module, never query", async t => {
  const pluginRoot = process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT;
  if (!pluginRoot) return t.skip("An existing verified supervisor fixture is required; no SDK is downloaded.");
  const f = fixture(t), home = path.join(f.base, "reader-home"); fs.mkdirSync(home);
  const module = path.join(f.base, "synthetic-sdk.mjs"), reader = fileURLToPath(new URL("../scripts/read-claude-native-history.mjs", import.meta.url));
  fs.writeFileSync(module, 'export async function query(){throw Error("Query must never run")};export async function listSessions(){return [{sessionId:' + JSON.stringify(id) + '}]};export async function getSessionMessages(){return ' + JSON.stringify(claudeRows.map(x => ({ uuid: x.uuid, message: x.message }))) + '}');
  fs.writeFileSync(path.join(f.base, "import"), 'const {spawnSync}=require("node:child_process");const r=spawnSync(process.execPath,' + JSON.stringify([reader, module, f.root, JSON.stringify([id])]) + ',{windowsHide:true,encoding:"utf8"});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exitCode=r.status;');
  const host = createProviderNativeHost({ provider: "opencode", executable: process.execPath, pluginRoot });
  const result = await host.run({ args: ["import", "synthetic-input"], cwd: f.base, home });
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.sessions[0].listed, true); assert.equal(observed.sessions[0].messages[0].uuid, "message_selected");
  assert.equal(result.supervision.treeCleanupVerified, true);
});

test("Claude rejects aliased companion target paths before any publication, including identical source bytes", async t => {
  const cases = [
    { name: "divergent-bytes", sameBytes: false, tails: ["subagents/agent-one.jsonl", "subagents/agent-one.jsonl"] },
    { name: "identical-bytes-distinct-provenance", sameBytes: true, tails: ["subagents/agent-one.jsonl", "subagents/agent-one.jsonl"] },
    { name: "file-directory-prefix", sameBytes: false, tails: ["subagents", "subagents/agent-one.jsonl"] },
    { name: "prefix-with-lexical-interloper", sameBytes: false, tails: ["subagents", "subagents-other", "subagents/agent-one.jsonl"] },
    ...(process.platform === "win32" ? [{ name: "windows-case-alias", sameBytes: false, tails: ["subagents/agent-one.jsonl", "SUBAGENTS/AGENT-ONE.JSONL"] }] : []),
  ];
  for (const { name, sameBytes, tails } of cases) await t.test(name, async t => {
    const f = fixture(t), source = path.join(f.base, "alias-source"), payload = path.join(f.base, "alias-payload"), bundle = path.join(f.base, "alias-bundle");
    fs.mkdirSync(source); fs.writeFileSync(path.join(source, "root.jsonl"), rawClaude);
    const paths = tails.map((tail, index) => (index ? "old-project-" + index + "/" : "") + id + "/" + tail);
    const files = [{ path: "root.jsonl", nativeId: id, role: "conversation" }];
    for (const [index, relative] of paths.entries()) {
      fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
      fs.writeFileSync(path.join(source, relative), sameBytes ? "same synthetic companion" : "synthetic companion " + index);
      files.push({ path: relative, nativeId: id, role: "companion" });
    }
    captureProviderNativeHistory({ provider: "claude", sourceDirectory: source, destination: payload, nativeIds: [id], files, reportedClientVersion: "2.1.223" });
    f.route(() => exportProjectBundle({ root: f.root, destination: bundle })); attachProjectNativeTransfer({ provider: "claude", bundleRoot: bundle, directory: payload });
    const home = path.join(f.base, "alias-target"); fs.mkdirSync(home); const before = snapshot(home);
    await assert.rejects(() => operateProjectNativeHistory({ action: "restore", bundleRoot: bundle, nativeHome: home, root: f.root, nativeHistoryHost: claudeHost() }), { code: "NATIVE_CLAUDE_TARGET_PATH_COLLISION" });
    assert.deepEqual(snapshot(home), before);
  });
});

test("Claude SDK comparison accepts valid whitespace-only JSONL lines and reordered object keys without rewriting the raw history", async t => {
  const f = fixture(t), source = path.join(f.base, "spaced-source"), payload = path.join(f.base, "spaced-payload"), bundle = path.join(f.base, "spaced-bundle");
  fs.mkdirSync(source);
  const raw = Buffer.from(" \t\r\n" + JSON.stringify(claudeRows[0]) + "\r\n   \r\n");
  fs.writeFileSync(path.join(source, "spaced.jsonl"), raw);
  captureProviderNativeHistory({ provider: "claude", sourceDirectory: source, destination: payload, nativeIds: [id],
    files: [{ path: "spaced.jsonl", nativeId: id, role: "conversation" }], reportedClientVersion: "2.1.223" });
  f.route(() => exportProjectBundle({ root: f.root, destination: bundle })); attachProjectNativeTransfer({ provider: "claude", bundleRoot: bundle, directory: payload });
  const home = path.join(f.base, "spaced-target"); fs.mkdirSync(home);
  const host = claudeHost({ async readClaude() { return { sessions: [{ sessionId: id, listed: true,
    messages: [{ uuid: claudeRows[0].uuid, message: { content: claudeRows[0].message.content, role: "user" } }] }] }; } });
  const args = { bundleRoot: bundle, nativeHome: home, root: f.root, nativeHistoryHost: host };
  await operateProjectNativeHistory({ ...args, action: "restore" });
  const before = snapshot(home), read = await operateProjectNativeHistory({ ...args, action: "register" });
  assert.equal(read.status, "native-history-reader-observed"); assert.equal(read.observations[0].returnedMessagesVerified, 1);
  assert.deepEqual(snapshot(home), before);
  assert.deepEqual(fs.readFileSync(path.join(home, "projects", claudeNativeProjectName(f.root), id + ".jsonl")), raw);
});

test("OpenCode source capture rejects global IDs across exports before transfer writes", async t => {
  for (const kind of ["message", "part"]) await t.test(kind, async t => {
    const f = fixture(t), bundle = path.join(f.base, "collision-bundle");
    f.route(() => exportProjectBundle({ root: f.root, destination: bundle }));
    const before = snapshot(bundle), first = data("ses_first", "msg_first", "prt_first");
    const second = data("ses_second", kind === "message" ? "msg_first" : "msg_second", kind === "part" ? "prt_first" : "prt_second");
    const values = new Map([["ses_first", first], ["ses_second", second]]);
    const host = { provider: "opencode", evidenceKind: "synthetic-test", clientVersion: "1.19.5",
      async exportSelected({ nativeId }) { return Buffer.from(JSON.stringify(values.get(nativeId))); } };
    await assert.rejects(() => operateProjectNativeHistory({ action: "capture", provider: "opencode", bundleRoot: bundle, root: f.root,
      threadIds: ["ses_first", "ses_second"], nativeHistoryHost: host }), { code: kind === "message" ? "NATIVE_OPENCODE_GLOBAL_MESSAGE_COLLISION" : "NATIVE_OPENCODE_GLOBAL_PART_COLLISION" });
    assert.deepEqual(snapshot(bundle), before);
  });
});

test("OpenCode source and derived files preserve distinct case-sensitive IDs on a case-insensitive filesystem", async t => {
  const f = fixture(t), bundle = path.join(f.base, "case-bundle"), host = openHost(), home = path.join(f.base, "case-target"); fs.mkdirSync(home);
  f.route(() => exportProjectBundle({ root: f.root, destination: bundle }));
  host.profiles.set("synthetic-current-source", new Map([
    ["ses_case", data("ses_case", "msg_lower", "prt_lower")],
    ["ses_CASE", data("ses_CASE", "msg_upper", "prt_upper")],
  ]));
  await operateProjectNativeHistory({ action: "capture", provider: "opencode", bundleRoot: bundle, root: f.root,
    threadIds: ["ses_case", "ses_CASE"], nativeHistoryHost: host });
  const native = readProjectNativeTransfer({ bundleRoot: bundle }).native;
  assert.equal(new Set(native.payload.files.map(entry => entry.path.toLowerCase())).size, 2);
  assert.deepEqual(native.payload.nativeIds, ["ses_case", "ses_CASE"]);
  const result = await operateProjectNativeHistory({ action: "restore", bundleRoot: bundle, nativeHome: home, root: f.root, nativeHistoryHost: host });
  assert.equal(result.status, "native-isolated-history-restoration-verified"); assert.equal(host.imports, 1);
  assert.equal(fs.existsSync(path.join(home, "profile", "inputs")), false);
  assert.deepEqual([...host.profiles.get(path.join(home, "profile")).keys()], ["ses_case", "ses_CASE"]);
});
