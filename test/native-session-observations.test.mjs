import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";
import { createHeadSession, withSessionRoute, sessionStatePath } from "../scripts/lib/session-routing.mjs";
import { updateProjectDirection } from "../scripts/lib/project-direction.mjs";
import { createSessionHostAdapter } from "../scripts/lib/session-host-adapter.mjs";
import { createNativeSessionHostBridge } from "../scripts/lib/session-native-host.mjs";
import { SESSION_HOST_REQUEST_HELPER } from "../scripts/lib/session-host-request.mjs";
import { recordSessionWorkEvidence } from "../scripts/lib/session-work-context.mjs";
import { enterConversationRecovery } from "../scripts/lib/compaction-lifecycle.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { sessionStartContext, runSessionHostHook } from "../scripts/session-host-hook.mjs";
import { createNativeObservationStore, normalizeNativeHook, observeNativeHook, projectNativeObservations } from "../scripts/lib/native-session-observations.mjs";
import { probeClaudeProcesses } from "../scripts/lib/native-session-process.mjs";
import { localContinuityCommand } from "./helpers/session-continuity-process.mjs";

const pluginRoot = path.resolve(import.meta.dirname, ".."), caller = { runtime: "codex", nativeSessionId: "native-main", agentId: null };
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "head-native-observation-")));
  const root = path.join(base, "project"), operational = path.join(base, "operational"); fs.mkdirSync(root);
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  const layout = formatForVerifiedOwner(storage);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: operational };
  return { base, root, storage, layout, operational, environment, store: createNativeObservationStore({ environment }) };
}
const event = (root, name, more = {}) => ({ hook_event_name: name, cwd: root, session_id: caller.nativeSessionId, ...more });
const observed = (root, id, name = "UserPromptSubmit") => normalizeNativeHook({ runtime: "codex", event: event(root, name, { turn_id: id }) }).observation;
const tree = root => fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).filter(p => fs.statSync(path.join(root, p)).isFile()).sort()
  .map(p => [p, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, p))).digest("hex")]) : [];
function request(root, name = "head_project_status", args = {}, id = caller.nativeSessionId, router = null) {
  return { id: 1, method: "tools/call", params: { name: router || name, _meta: { threadId: id },
    arguments: router ? { name, arguments: { project_root: root, ...args } } : { project_root: root, ...args } } };
}
const invoke = (native, req) => dispatch(req, { nativeSessionBridge: native });
function select(adapter, root, sessionId) {
  const prior = adapter.read({ root });
  return adapter.select({ root, sessionId, expectedRevision: prior.revision, expectedBindingDigest: prior.bindingDigest || null });
}
function header(base, id, fields = {}) {
  const file = path.join(base, `${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ timestamp: "2026-10-18T00:00:00Z", type: "session_meta", payload: { id,
    session_id: id, cwd: path.join(base, "project"), cli_version: "0.0.0", source: "cli", ...fields } }) + "\n");
  return file;
}

const clearInstance = () => ({ platform: "win32", environment: "a".repeat(64), pid: 12345, ppid: 1, birth: "windows-filetime-123456789" });
const clearEvent = (f, id, ending = false) => ({ hook_event_name: ending ? "SessionEnd" : "SessionStart", cwd: f.root,
  session_id: id, ...(ending ? { reason: "clear" } : { source: "clear" }) });
const clearAdapter = (f, id) => createSessionHostAdapter({ runtime: "claude", nativeSessionId: id, environment: f.environment });
const hintFile = f => path.join(f.operational, "native-clear-handoffs", fs.readdirSync(path.join(f.operational, "native-clear-handoffs"))[0], "hints.json");
const clearOptions = (f, id, ending = false) => ({ runtime: "claude", event: clearEvent(f, id, ending), environment: f.environment, processObserver: async () => clearInstance() });

test("host-c: actual Hook writer carries a verified old clear to the same Session and consumes it once", async t => {
  const f = fixture(t), chosen = createHeadSession({ root: f.root, purpose: "Selected clear task, independent of default" });
  select(clearAdapter(f, "old-native"), f.root, chosen.sessionId);
  withSessionRoute(f.root, chosen.sessionId, () => recordSessionWorkEvidence({ root: f.root, input: { summary: "Retained exact reason across clear" } }));
  updateProjectDirection({ root: f.root, input: { goal: "Continue local investigation", cancelledActions: ["deploy"] } });
  const before = tree(f.root), observer = async () => clearInstance();
  assert.deepEqual(await runSessionHostHook({ runtime: "claude", event: clearEvent(f, "old-native", true), environment: f.environment, processObserver: observer }), {});
  const end = f.store.read({ root: f.root, caller: { runtime: "claude", nativeSessionId: "old-native", agentId: null } });
  assert(end.rows.some(row => row.observation.event === "SessionEnd" && row.observation.reason === "clear" && row.observation.instance));
  const hintsBefore = tree(path.join(f.operational, "native-clear-handoffs"));
  await runSessionHostHook({ runtime: "claude", event: clearEvent(f, "old-native", true), environment: f.environment, processObserver: observer });
  assert.deepEqual(tree(path.join(f.operational, "native-clear-handoffs")), hintsBefore, "Duplicate end does not extend/reopen a hint");
  const output = await runSessionHostHook({ runtime: "claude", event: clearEvent(f, "new-native"), environment: f.environment, processObserver: observer });
  const context = JSON.parse(output.hookSpecificOutput.additionalContext);
  assert.equal(context.logicalSessionId, chosen.sessionId); assert.equal(context.currentProjectDirection.input.cancelledActions[0], "deploy");
  assert(context.records.some(row => row.content.summary === "Retained exact reason across clear"));
  const bound = clearAdapter(f, "new-native").read({ root: f.root }); assert.equal(bound.status, "bound");
  await runSessionHostHook({ runtime: "claude", event: clearEvent(f, "new-native"), environment: f.environment, processObserver: observer });
  assert.deepEqual(clearAdapter(f, "new-native").read({ root: f.root }), bound);
  await runSessionHostHook({ runtime: "claude", event: clearEvent(f, "third-native"), environment: f.environment, processObserver: observer });
  assert.equal(clearAdapter(f, "third-native").read({ root: f.root }).status, "absent"); assert.deepEqual(tree(f.root), before);
});

test("host-c: changed instance, missing pair, changed mapping and existing receiver never infer a selection", async t => {
  for (const variant of ["birth", "environment", "pid", "missing-end", "old-selection", "receiver-bound", "receiver-pending", "receiver-lost"]) {
    const f = fixture(t), chosen = createHeadSession({ root: f.root, purpose: "Old explicit choice" }), other = createHeadSession({ root: f.root, purpose: "Different explicit choice" });
    select(clearAdapter(f, "old-native"), f.root, chosen.sessionId);
    if (variant !== "missing-end") await runSessionHostHook({ runtime: "claude", event: clearEvent(f, "old-native", true), environment: f.environment, processObserver: async () => clearInstance() });
    if (variant === "old-selection") select(clearAdapter(f, "old-native"), f.root, other.sessionId);
    const next = clearAdapter(f, "new-native");
    if (["receiver-bound", "receiver-lost"].includes(variant)) select(next, f.root, other.sessionId);
    if (variant === "receiver-lost") next.lose({ root: f.root, expectedRevision: next.read({ root: f.root }).revision });
    if (variant === "receiver-pending") next.prepareSelection({ root: f.root, sessionId: other.sessionId, expectedRevision: 0, expectedBindingDigest: null });
    const prior = next.read({ root: f.root }), before = tree(f.root), instance = clearInstance();
    if (variant === "birth") instance.birth = "windows-filetime-999";
    if (variant === "environment") instance.environment = "b".repeat(64);
    if (variant === "pid") instance.pid++;
    await runSessionHostHook({ runtime: "claude", event: clearEvent(f, "new-native"), environment: f.environment, processObserver: async () => instance });
    assert.deepEqual(next.read({ root: f.root }), prior, variant); assert.deepEqual(tree(f.root), before, variant);
  }
});

test("host-c: separate Hook processes use an actual owned process witness and synthetic CLI registry", async t => {
  const f = fixture(t), chosen = createHeadSession({ root: f.root, purpose: "Exact cross-process clear continuity" });
  select(clearAdapter(f, "old-process-native"), f.root, chosen.sessionId);
  const config = path.join(f.base, "synthetic-claude"), sessions = path.join(config, "sessions"); fs.mkdirSync(sessions, { recursive: true });
  const environment = { ...f.environment, CLAUDE_CONFIG_DIR: config };
  const registry = path.join(sessions, `${process.pid}.json`), script = path.join(f.base, "hook-driver.mjs");
  fs.writeFileSync(script, `import fs from "node:fs";\nimport {runSessionHostHook} from ${JSON.stringify(pathToFileURL(path.join(pluginRoot, "scripts/session-host-hook.mjs")).href)};\nimport {observeClaudeProcess} from ${JSON.stringify(pathToFileURL(path.join(pluginRoot, "scripts/lib/native-session-process.mjs")).href)};\nconst input=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));\nconst started=Date.now();const output=await runSessionHostHook({...input,processObserver:options=>observeClaudeProcess({...options,onProcess:event=>process.stderr.write(JSON.stringify({...event,elapsedMs:Date.now()-started})+"\\n")})});\nprocess.stdout.write(JSON.stringify(output));\n`);
  const before = tree(f.root), outputs = [];
  for (const ending of [true, false]) {
    const id = ending ? "old-process-native" : "new-process-native", input = path.join(f.base, ending ? "end.json" : "start.json");
    fs.writeFileSync(registry, JSON.stringify({ sessionId: id, pid: process.pid }));
    fs.writeFileSync(input, JSON.stringify({ runtime: "claude", event: clearEvent(f, id, ending), environment }));
    const output = await localContinuityCommand([script, input], { cwd: pluginRoot }); assert.equal(output.code, 0, output.stderr); t.diagnostic(JSON.stringify({phase:ending?"end":"start",probeEvents:output.stderr.split(/\r?\n/).filter(Boolean).map(line=>{try{const e=JSON.parse(line);return {event:e.event,pid:e.pid,exitCode:e.exitCode,signal:e.signal,elapsedMs:e.elapsedMs,rows:e.rows};}catch{return {unparsed:true};}})})); outputs.push(JSON.parse(output.stdout));
  }
  assert.deepEqual(outputs[0], {}); assert.equal(JSON.parse(outputs[1].hookSpecificOutput.additionalContext).logicalSessionId, chosen.sessionId);
  assert.equal(createSessionHostAdapter({ runtime: "claude", nativeSessionId: "new-process-native", environment }).read({ root: f.root }).sessionId, chosen.sessionId);
  assert.deepEqual(tree(f.root), before);
  t.diagnostic("Actual owned Node hosting instance + synthetic CLI registry + two new Hook driver processes. Not actual Claude/Host/model delivery.");
});

test("host-c: expiry never renews on replay; ambiguous clears and agent/root changes stay unlinked", async t => {
  for (const variant of ["expired", "ambiguous", "same-caller", "agent", "other-root", "reordered"]) {
    const f = fixture(t), chosen = createHeadSession({ root: f.root, purpose: "Exact clear source" });
    select(clearAdapter(f, "old-native"), f.root, chosen.sessionId);
    if (variant === "reordered") await runSessionHostHook(clearOptions(f, "new-native"));
    await runSessionHostHook(clearOptions(f, "old-native", true));
    const original = fs.readFileSync(hintFile(f), "utf8"), options = clearOptions(f, variant === "same-caller" ? "old-native" : "new-native");
    if (variant === "ambiguous") {
      select(clearAdapter(f, "competing-native"), f.root, chosen.sessionId);
      await runSessionHostHook(clearOptions(f, "competing-native", true));
      assert.equal(JSON.parse(fs.readFileSync(hintFile(f))).rows[0].state, "ambiguous");
    }
    if (variant === "agent") options.event.agent_id = "different-agent";
    if (variant === "other-root") options.event.cwd = fixture(t).root;
    const before = tree(f.root), now = Date.now;
    try {
      if (variant === "expired") {
        const future = now() + 600_001; Date.now = () => future;
        await runSessionHostHook(clearOptions(f, "old-native", true));
        assert.equal(fs.readFileSync(hintFile(f), "utf8"), original, "An expired end replay cannot refresh TTL");
      }
      await runSessionHostHook(options);
    } finally { Date.now = now; }
    assert.equal(clearAdapter(f, "new-native").read({ root: f.root }).status, "absent", variant);
    assert.deepEqual(tree(f.root), before, variant);
  }
});

test("host-c: tampered/missing sources and oversized hint cache never replace explicit selection", async t => {
  for (const variant of ["hint-digest", "hint-size", "cache-size", "old-missing", "old-digest", "clear-row", "clear-snapshot"]) {
    const f = fixture(t), chosen = createHeadSession({ root: f.root, purpose: "Source integrity" });
    select(clearAdapter(f, "old-native"), f.root, chosen.sessionId);
    await runSessionHostHook(clearOptions(f, "old-native", true));
    const file = hintFile(f), cache = JSON.parse(fs.readFileSync(file));
    const rewriteCache = () => { const { cacheDigest, ...body } = cache; fs.writeFileSync(file, JSON.stringify({ ...body, cacheDigest: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex") })); };
    if (variant === "hint-digest") { cache.rows[0].oldNativeId = "invented-native"; rewriteCache(); }
    if (variant === "hint-size") {
      const { hintDigest, ...body } = cache.rows[0]; body.oldNativeId = "x".repeat(9000);
      cache.rows[0] = { ...body, hintDigest: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex") }; rewriteCache();
    }
    if (variant === "cache-size") fs.writeFileSync(file, " ".repeat(128 * 1024 + 1));
    const bindings = path.join(f.operational, "session-bindings"), binding = fs.readdirSync(bindings, { recursive: true }).find(x => x.endsWith("binding.json"));
    if (variant === "old-missing") fs.unlinkSync(path.join(bindings, binding));
    if (variant === "old-digest") { const b = JSON.parse(fs.readFileSync(path.join(bindings, binding))); b.sessionId = "session-00000000-0000-0000-0000-000000000000"; fs.writeFileSync(path.join(bindings, binding), JSON.stringify(b)); }
    if (variant.startsWith("clear-")) {
      const snapshots = path.join(f.operational, "native-observations"), snapshotFile = path.join(snapshots, fs.readdirSync(snapshots)[0], "snapshot.json");
      const snapshot = JSON.parse(fs.readFileSync(snapshotFile)); snapshot.rows[0].observation.reason = "other";
      if (variant === "clear-row") { const { snapshotDigest, ...body } = snapshot; snapshot.snapshotDigest = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex"); }
      fs.writeFileSync(snapshotFile, JSON.stringify(snapshot));
    }
    const before = tree(f.root);
    await runSessionHostHook(clearOptions(f, "new-native"));
    assert.equal(clearAdapter(f, "new-native").read({ root: f.root }).status, "absent", variant);
    assert.deepEqual(tree(f.root), before, variant);
  }
});

test("host-c: a first missing/failed clear-start witness cannot acquire ordering from a later replay", async t => {
  const f = fixture(t), chosen = createHeadSession({ root: f.root, purpose: "First received clear witness" }), before = tree(f.root);
  const variants = ["ordered-control", "null-before-end", "throw-before-end", "null-after-end", "other-known-instance", "unknown-overwritten", "unknown-evicted"];
  for (const [index, variant] of variants.entries()) {
    const oldId = `old-${variant}`, newId = `new-${variant}`, instance = { ...clearInstance(), pid: 12345 + index };
    select(clearAdapter(f, oldId), f.root, chosen.sessionId);
    const run = (id, ending = false, processObserver = async () => instance, source = "clear") => runSessionHostHook({
      runtime: "claude", event: { ...clearEvent(f, id, ending), ...(!ending ? { source } : {}) }, environment: f.environment, processObserver });
    if (!["ordered-control", "null-after-end"].includes(variant)) {
      await run(newId, false, async () => {
        if (variant === "throw-before-end") throw new Error("Synthetic unavailable witness");
        return variant === "other-known-instance" ? { ...instance, pid: 45678 + index } : null;
      });
      assert.equal(clearAdapter(f, newId).read({ root: f.root }).status, "absent");
      if (variant === "unknown-overwritten") await run(newId, false, async () => null, "resume");
      if (variant === "unknown-evicted") for (let sequence = 0; sequence < 65; sequence++) await f.store.observe({
        root: f.root, caller: { runtime: "claude", nativeSessionId: newId, agentId: null }, observation: observed(f.root, `noise-${sequence}`) });
    }
    await run(oldId, true);
    if (variant === "null-after-end") await run(newId, false, async () => null);
    await new Promise(resolve => setTimeout(resolve, 8));
    await run(newId);
    const expected = ["ordered-control", "other-known-instance"].includes(variant) ? "bound" : "absent";
    const binding = clearAdapter(f, newId).read({ root: f.root });
    assert.equal(binding.status, expected, variant);
    if (expected === "bound") assert.equal(binding.sessionId, chosen.sessionId, variant);
    else assert.equal(select(clearAdapter(f, newId), f.root, chosen.sessionId).retained, true, "Explicit selection remains available");
    assert.deepEqual(tree(f.root), before, variant);
  }
});

test("host-c: bounded hints preserve 64 live instances and refuse overflow without a lookup scan", async t => {
  const f = fixture(t), chosen = createHeadSession({ root: f.root, purpose: "Bounded instance lookup" });
  select(clearAdapter(f, "old-native"), f.root, chosen.sessionId);
  for (let index = 0; index < 65; index++) await runSessionHostHook({ ...clearOptions(f, "old-native", true), processObserver: async () => ({ ...clearInstance(), pid: 12345 + index }) });
  const cache = JSON.parse(fs.readFileSync(hintFile(f)));
  assert.equal(cache.rows.length, 64); assert(fs.statSync(hintFile(f)).size <= 128 * 1024);
  const before = tree(f.root), original = fs.readdirSync;
  fs.readdirSync = (directory, ...args) => { if (String(directory).includes("session-bindings")) throw new Error("No global binding inventory"); return original(directory, ...args); };
  try { await runSessionHostHook({ ...clearOptions(f, "new-native"), processObserver: async () => ({ ...clearInstance(), pid: 12346 }) }); }
  finally { fs.readdirSync = original; }
  assert.equal(clearAdapter(f, "new-native").read({ root: f.root }).sessionId, chosen.sessionId);
  assert.deepEqual(tree(f.root), before);
});

test("host-c: expired deadlines and failed hint/binding publication leave only optional loss, never replay", async t => {
  for (const variant of ["expired", "probe-late", "hint-write", "binding-partial"]) {
    const f = fixture(t), chosen = createHeadSession({ root: f.root, purpose: "Optional write failures" });
    select(clearAdapter(f, "old-native"), f.root, chosen.sessionId);
    const before = tree(f.root), rename = fs.renameSync;
    if (variant === "hint-write") fs.renameSync = (source, target) => { if (path.basename(String(target)) === "hints.json") throw Object.assign(new Error("Synthetic hint denial"), { code: "EACCES" }); return rename(source, target); };
    try {
      const options = clearOptions(f, "old-native", true);
      if (variant === "expired") { options.deadlineAt = Date.now() - 1; options.processObserver = async () => { assert.fail("Expired command must not query"); }; }
      if (variant === "probe-late") { options.deadlineAt = Date.now() + 1; options.processObserver = async () => { await new Promise(resolve => setTimeout(resolve, 15)); return clearInstance(); }; }
      await runSessionHostHook(options);
    } finally { fs.renameSync = rename; }
    if (variant === "binding-partial") fs.renameSync = (source, target) => {
      if (path.basename(String(target)) === "binding.json" && JSON.parse(fs.readFileSync(source)).status === "bound") throw Object.assign(new Error("Synthetic commit denial"), { code: "EACCES" });
      return rename(source, target);
    };
    try { await runSessionHostHook(clearOptions(f, "new-native")); }
    finally { fs.renameSync = rename; }
    const selected = clearAdapter(f, "new-native").read({ root: f.root });
    assert.equal(selected.status, variant === "binding-partial" ? "pending" : "absent", variant);
    await runSessionHostHook(clearOptions(f, "new-native"));
    assert.deepEqual(clearAdapter(f, "new-native").read({ root: f.root }), selected, "No automatic retry of a consumed handoff");
    assert.deepEqual(tree(f.root), before, variant);
  }
});

test("host-c: actual command stdin/stdout preserves clear selection with the existing End/Start deadlines", async t => {
  const f = fixture(t), chosen = createHeadSession({ root: f.root, purpose: "Actual command clear continuity" });
  select(clearAdapter(f, "old-command-native"), f.root, chosen.sessionId);
  const config = path.join(f.base, "synthetic-claude"), sessions = path.join(config, "sessions"); fs.mkdirSync(sessions, { recursive: true });
  const environment = { ...process.env, ...f.environment, CLAUDE_CONFIG_DIR: config };
  const registry = path.join(sessions, `${process.pid}.json`), before = tree(f.root), outputs = [];
  const hook = path.join(pluginRoot, "scripts/session-host-hook.mjs");
  for (const ending of [true, false]) {
    const id = ending ? "old-command-native" : "new-command-native";
    fs.writeFileSync(registry, JSON.stringify({ sessionId: id, pid: process.pid }));
    const started = Date.now();
    const output = await localContinuityCommand([hook, "--runtime", "claude", ...(ending ? ["--observe-only"] : [])],
      { cwd: pluginRoot, environment, input: JSON.stringify(clearEvent(f, id, ending)) });
    const durationMs = Date.now() - started;
    t.diagnostic(JSON.stringify({ phase: ending ? "end-command" : "start-command", durationMs, limitMs: ending ? 1000 : 10_000 }));
    assert.equal(output.code, 0, output.stderr); assert.equal(output.stderr, "");
    // Includes harness logging, spawn, priority adjustment and close checks.
    // Keep this comparable diagnostic separate from the product's deadline.
    outputs.push(JSON.parse(output.stdout));
  }
  assert.deepEqual(outputs[0], {});
  assert.equal(JSON.parse(outputs[1].hookSpecificOutput.additionalContext).logicalSessionId, chosen.sessionId);
  assert.equal(createSessionHostAdapter({ runtime: "claude", nativeSessionId: "new-command-native", environment }).read({ root: f.root }).sessionId, chosen.sessionId);
  assert.deepEqual(tree(f.root), before);
  t.diagnostic("Actual packaged command entry + synthetic registry and owned Node host only; no actual Claude/model reception claim.");
});

test("host-c: occupied hint or existing Project CAS locks cannot inherit the ordinary ten-second wait", async t => {
  for (const scope of ["hint", "binding"]) {
    const f = fixture(t), chosen = createHeadSession({ root: f.root, purpose: "Bounded clear lock contention" });
    select(clearAdapter(f, "old-native"), f.root, chosen.sessionId);
    await runSessionHostHook(clearOptions(f, "old-native", true));
    const before = tree(f.root), lock = scope === "hint" ? path.join(path.dirname(hintFile(f)), "writer.lock")
      : path.join(f.root, f.layout.directory, ".operations", "host-session-binding.lock");
    fs.mkdirSync(lock);
    const owner = path.join(lock, `owner-${"f".repeat(16)}-12345-${"e".repeat(32)}.json`);
    fs.writeFileSync(owner, "synthetic foreign lock; do not steal");
    let elapsedMs;
    try {
      const started = Date.now();
      await runSessionHostHook({ ...clearOptions(f, "new-native"), deadlineAt: started + 80 });
      elapsedMs = Date.now() - started;
      assert.equal(fs.readFileSync(owner, "utf8"), "synthetic foreign lock; do not steal");
      assert.equal(clearAdapter(f, "new-native").read({ root: f.root }).status, "absent");
      assert(elapsedMs < 500, "Optional clear must not use the existing ten-second ordinary CAS wait");
    } finally { fs.unlinkSync(owner); fs.rmdirSync(lock); }
    assert.deepEqual(tree(f.root), before);
    assert.equal(select(clearAdapter(f, "explicit-native"), f.root, chosen.sessionId).retained, true);
    t.diagnostic(JSON.stringify({ scope, elapsedMs, ordinaryExplicitSelection: "available-after-contention" }));
  }
});

test("ABC: excerpt-only related history and Session preview keep source ownership without inheriting parent P2", async t => {
  const f = fixture(t), native = createNativeSessionHostBridge({ runtime: "codex", environment: f.environment });
  const parentId = createHeadSession({ root: f.root, purpose: "PARENT P2 MUST STAY IN PARENT" }).sessionId;
  const childId = createHeadSession({ root: f.root, purpose: "Current child task" }).sessionId;
  withSessionRoute(f.root, parentId, () => recordSessionWorkEvidence({ root: f.root, input: {
    summary: "S".repeat(14000), observedWork: ["O".repeat(19000)],
    judgments: [{ assessment: "Keep the exact parent source", reason: "RelatedPartialReasonMarker", alternatives: ["Do not inherit direction"] }],
    pending: ["RelatedPartialPendingMarker"], unknowns: ["Later reference read only"] } }));
  select(createSessionHostAdapter({ ...caller, nativeSessionId: "abc-parent", environment: f.environment }), f.root, parentId);
  await invoke(native, request(f.root, "head_project_initialize_or_resume", { session_id: childId }, "abc-child"));
  await observeNativeHook({ runtime: "codex", event: event(f.root, "SessionStart", { session_id: "abc-child", source: "fork",
    transcript_path: header(f.base, "abc-child", { forked_from_id: "abc-parent" }) }), environment: f.environment });
  updateProjectDirection({ root: f.root, input: { goal: "Current local work", cancelledActions: ["deploy"] } });
  const before = tree(f.root).concat(tree(f.operational));
  const response = await invoke(native, request(f.root, "head_conversation_enter", {}, "abc-child"));
  const related = response.result.structuredContent.relatedNativeWorkContext.sources[0];
  assert.equal(related.workContext.sessionId, parentId); assert.deepEqual(related.workContext.records, []);
  assert(related.workContext.recordExcerpts.length); assert.equal(related.recordRead.scope, "later-reference-read");
  assert.equal(related.workContext.recordExcerpts[0].source.sessionId, parentId);
  for (const marker of ["RelatedPartialReasonMarker", "RelatedPartialPendingMarker", "Partial original excerpts"]) assert(response.result.content[0].text.includes(marker), marker);
  assert.equal(JSON.stringify(related).includes("PARENT P2 MUST STAY IN PARENT"), false);
  assert.equal(response.result.structuredContent.workContext.sessionId, childId);
  const preview = await invoke(native, request(f.root, "head_session_list", { session_id: parentId }, "abc-child", "head_tools_read"));
  assert(preview.result.structuredContent.preview.workContext.recordExcerpts.length);
  assert.equal(preview.result.structuredContent.preview.workContext.sessionId, parentId);
  assert.deepEqual(tree(f.root).concat(tree(f.operational)), before);
});

test("actual Hook identity: exact Codex leaf, shared-root membership, no fake missing Claude prompt key", () => {
  const sub = normalizeNativeHook({ runtime: "codex", event: event("synthetic", "SubagentStart", { agent_id: "child-B", turn_id: "turn-B" }) });
  assert.deepEqual(sub.caller, { runtime: "codex", nativeSessionId: "child-B", agentId: null });
  assert.equal(sub.membership.caller.nativeSessionId, caller.nativeSessionId);
  assert.equal(sub.membership.observation.member.nativeSessionId, "child-B");
  assert.equal(Object.hasOwn(sub.observation, "edge"), false);
  const claude = normalizeNativeHook({ runtime: "claude", event: event("synthetic", "Stop", { agent_id: "worker", last_assistant_message: "SECRET" }) });
  assert.equal(claude.observation.requestId, null); assert.equal(claude.caller.agentId, "worker");
  assert.equal(JSON.stringify(claude).includes("SECRET"), false);
  assert.equal(normalizeNativeHook({ runtime: "codex", event: event("synthetic", "SessionStart", { agent_id: "unsupported" }) }), null);
});

test("packaged event -> P5 -> actual native direct/router status and successful entry; no canonical/binding/read writes", async t => {
  const f = fixture(t), before = tree(f.root), native = createNativeSessionHostBridge({ runtime: "codex", environment: f.environment });
  await runSessionHostHook({ runtime: "codex", event: event(f.root, "UserPromptSubmit", { turn_id: "P1", prompt: "secret text" }), environment: f.environment, observeOnly: true });
  await runSessionHostHook({ runtime: "codex", event: event(f.root, "UserPromptSubmit", { turn_id: "P2" }), environment: f.environment, observeOnly: true });
  await runSessionHostHook({ runtime: "codex", event: event(f.root, "Stop", { turn_id: "P1", last_assistant_message: "SECRET" }), environment: f.environment, observeOnly: true });
  const persisted = tree(f.operational);
  for (const name of ["head_project_status", "head_conversation_enter"]) for (const router of [null, "head_tools_read", "head_tools_call"]) {
    const baseline = await dispatch(request(f.root, name));
    const res = await invoke(native, request(f.root, name, {}, caller.nativeSessionId, router));
    assert.deepEqual(res.result.content.slice(0, baseline.result.content.length), baseline.result.content);
    const { nativeContext, ...canonical } = res.result.structuredContent;
    assert.deepEqual(canonical, baseline.result.structuredContent);
    assert.deepEqual(JSON.parse(res.result.content.at(-1).text.split("\n").slice(1).join("\n")), nativeContext);
    assert.equal(nativeContext.observations.find(x => x.requestId === "P2").phase, "prompt-observed");
    assert.equal(nativeContext.observations.find(x => x.requestId === "P1").phase, "response-end-observed");
    assert.ok(Buffer.byteLength(JSON.stringify(res.result)) - Buffer.byteLength(JSON.stringify(baseline.result)) <= 16384);
  }
  assert.deepEqual(tree(f.root), before); assert.deepEqual(tree(f.operational), persisted);
  assert.equal(fs.existsSync(path.join(f.operational, "session-bindings")), false);
  assert.equal(JSON.stringify(persisted).includes("SECRET"), false);
});

test("optional native entry appendix cannot replace primary recovery failure, selection conflict or no-replay", async t => {
  const f = fixture(t), native = createNativeSessionHostBridge({ runtime: "codex", environment: f.environment });
  await f.store.observe({ root: f.root, caller, observation: observed(f.root, "seed") });
  const before = tree(f.root).concat(tree(f.operational));
  for (const status of ["session_selection_unresolved", "recovery_attention_required", "conversation_recovery_unavailable"]) {
    const response = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Keep primary cancellation/unknown" }],
      structuredContent: { status, reasonCode: "SYNTHETIC_CONFLICT", executionReplayAllowed: false, cancelledActions: ["deploy"] } } };
    const actual = await native.dispatch(request(f.root, "head_conversation_enter"), () => response);
    assert.strictEqual(actual, response);
    assert.equal(actual.result.structuredContent.executionReplayAllowed, false);
    assert.deepEqual(actual.result.structuredContent.cancelledActions, ["deploy"]);
  }
  const primary = { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "primary error" }],
    structuredContent: { status: "conversation_ready" } } };
  assert.strictEqual(await native.dispatch(request(f.root, "head_conversation_enter"), () => primary), primary);
  assert.deepEqual(tree(f.root).concat(tree(f.operational)), before);
});

test("entry with no caller observations stays byte-identical; other callers cannot fill the gap", async t => {
  const f = fixture(t), native = createNativeSessionHostBridge({ runtime: "codex", environment: f.environment });
  const baseline = await dispatch(request(f.root, "head_conversation_enter"));
  await f.store.observe({ root: f.root, caller: { ...caller, nativeSessionId: "other-caller" }, observation: observed(f.root, "unrelated") });
  const before = tree(f.root).concat(tree(f.operational));
  for (const router of [null, "head_tools_read", "head_tools_call"])
    assert.deepEqual(await invoke(native, request(f.root, "head_conversation_enter", {}, caller.nativeSessionId, router)), baseline);
  assert.deepEqual(tree(f.root).concat(tree(f.operational)), before);
});

test("continuation, caller end, missing key and bounded eviction never become task completion", async t => {
  const f = fixture(t);
  for (const [name, fields] of [["UserPromptSubmit", { turn_id: "P1" }], ["Stop", { turn_id: "P1" }],
    ["SessionEnd", { reason: "other", turn_id: "P1" }], ["UserPromptSubmit", { turn_id: "P1" }]])
    await observeNativeHook({ runtime: "codex", event: event(f.root, name, fields), environment: f.environment });
  let state = f.store.read({ root: f.root, caller });
  assert.equal(state.rows.find(x => x.observation.requestId === "P1").observation.phase, "prompt-observed");
  assert.equal(state.rows.find(x => x.observation.event === "SessionEnd").observation.requestId, null);
  for (let n = 0; n < 70; n++) await f.store.observe({ root: f.root, caller, observation: observed(f.root, "turn-" + n) });
  state = f.store.read({ root: f.root, caller });
  assert.equal(state.rows.length, 64); assert.ok(state.omitted > 0); assert.ok(Buffer.byteLength(JSON.stringify(state)) < 128 * 1024);
  const prior = tree(f.operational);
  await f.store.observe({ root: f.root, caller, observation: observed(f.root, "turn-69") });
  assert.deepEqual(tree(f.operational), prior);
});

test("missing/unsafe/corrupt/locked optional storage preserves ordinary Core and original primary errors", async t => {
  const f = fixture(t), native = createNativeSessionHostBridge({ runtime: "codex", environment: f.environment });
  await invoke(native, request(f.root)); assert.equal(fs.existsSync(f.operational), false);
  await f.store.observe({ root: f.root, caller, observation: observed(f.root, "seed") });
  const dir = path.join(f.operational, "native-observations", fs.readdirSync(path.join(f.operational, "native-observations"))[0]);
  const bytes = fs.readFileSync(path.join(dir, "snapshot.json"));
  fs.writeFileSync(path.join(dir, "writer.lock"), "unowned-crashed-lock");
  const started = Date.now();
  await assert.rejects(f.store.observe({ root: f.root, caller, observation: observed(f.root, "busy") }));
  assert.ok(Date.now() - started < 1000); assert.deepEqual(fs.readFileSync(path.join(dir, "snapshot.json")), bytes);
  assert.equal(fs.readFileSync(path.join(dir, "writer.lock"), "utf8"), "unowned-crashed-lock");
  fs.writeFileSync(path.join(dir, "snapshot.json"), "{broken");
  const before = tree(f.operational), res = await invoke(native, request(f.root));
  assert.equal(res.result.isError, undefined); assert.deepEqual(tree(f.operational), before);
  const baselineEntry = await dispatch(request(f.root, "head_conversation_enter"));
  assert.deepEqual(await invoke(native, request(f.root, "head_conversation_enter")), baselineEntry);
  const error = await native.dispatch(request(f.root), () => { throw Object.assign(new Error("Primary"), { code: "PRIMARY_PERMISSION" }); }).catch(e => e);
  assert.equal(error.code, "PRIMARY_PERMISSION");
});

test("explicit logical A / caller B remain separate and missing Host ID is never invented", async t => {
  const f = fixture(t), native = createNativeSessionHostBridge({ runtime: "codex", environment: f.environment });
  const a = createHeadSession({ root: f.root, purpose: "Logical A" }).sessionId;
  await f.store.observe({ root: f.root, caller: { ...caller, nativeSessionId: "native-B" }, observation: observed(f.root, "native-B-observed") });
  for (const name of ["head_project_status", "head_conversation_enter"]) {
    const response = await invoke(native, request(f.root, name, { session_id: a }, "native-B"));
    assert.equal(response.result.structuredContent.nativeContext.caller.nativeSessionId, "native-B");
    assert.deepEqual(response.result.structuredContent.nativeContext.hostTarget, { threadId: "native-B" });
    assert.equal(response.result.structuredContent.nativeContext.scope, "native-caller-not-logical-session-execution");
    assert.equal(JSON.stringify(response.result.structuredContent.nativeContext).includes(a), false);
  }
});

test("own fork/header -> observed parent S1 -> actual useful P3 entry text; later S2 cannot replace it", async t => {
  const f = fixture(t), native = createNativeSessionHostBridge({ runtime: "codex", environment: f.environment });
  const s1 = createHeadSession({ root: f.root, purpose: "PARENT P2 MUST NOT INHERIT" }).sessionId;
  const s2 = createHeadSession({ root: f.root, purpose: "Unrelated newer parent" }).sessionId;
  const child = createHeadSession({ root: f.root, purpose: "CURRENT CHILD" }).sessionId;
  withSessionRoute(f.root, s1, () => recordSessionWorkEvidence({ root: f.root, input: {
    judgments: [{ assessment: "Keep exact provenance", reason: "A later binding is not the old fork source", alternatives: ["Guess current parent"] }],
    unknowns: ["Deployment effect remains unknown"], observedWork: ["Verified historical result"],
  } }));
  const parent = createSessionHostAdapter({ ...caller, nativeSessionId: "parent", environment: f.environment });
  select(parent, f.root, s1);
  await invoke(native, request(f.root, "head_project_initialize_or_resume", { session_id: child }, "child"));
  const file = header(f.base, "child", { forked_from_id: "parent", parent_thread_id: "parent" });
  const fork = event(f.root, "SessionStart", { session_id: "child", source: "fork", transcript_path: file });
  await observeNativeHook({ runtime: "codex", event: fork, environment: f.environment });
  select(parent, f.root, s2);
  await observeNativeHook({ runtime: "codex", event: fork, environment: f.environment });
  const later = withSessionRoute(f.root, s1, () => recordSessionWorkEvidence({ root: f.root, input: {
    summary: "POST-FORK later reference; never proven historical input" } }));
  updateProjectDirection({ root: f.root, input: { goal: "Inspect only", cancelledActions: ["deploy"] } });
  const before = tree(f.root).concat(tree(f.operational));
  const res = await invoke(native, request(f.root, "head_conversation_enter", {}, "child"));
  const related = res.result.structuredContent.relatedNativeWorkContext;
  assert.equal(related.sources.length, 1); assert.equal(related.sources[0].workContext.sessionId, s1);
  assert.ok(related.sources[0].workContext.records.some(record => record.evidenceId === later.evidence.evidenceId));
  assert.equal(related.sources[0].selectionBasis.sessionId, s1);
  assert.equal(related.sources[0].recordRead.scope, "later-reference-read");
  assert.equal(related.sources[0].recordRead.historicalInput, "unknown");
  for (const field of ["preparedInput", "delivery", "modelUse"]) assert.equal(related.sources[0].recordRead[field], "not-established");
  assert.match(res.result.content[0].text, /records read later/u);
  assert.deepEqual(res.result.structuredContent.projectStatus.currentProjectDirection.input.cancelledActions, ["deploy"]);
  assert.ok(res.result.content[0].text.includes("A later binding is not the old fork source"));
  assert.ok(res.result.content[0].text.includes("Deployment effect remains unknown"));
  assert.equal(JSON.stringify(related).includes("PARENT P2 MUST NOT INHERIT"), false);
  assert.equal(res.result.structuredContent.workContext.sessionId, child);
  assert.deepEqual(tree(f.root).concat(tree(f.operational)), before);
});

test("S1-S6: native direct/router preview leaves persisted binding and outer route unchanged", async t => {
  const f = fixture(t), native = createNativeSessionHostBridge({ runtime: "codex", environment: f.environment });
  const a = createHeadSession({ root: f.root, purpose: "Same title" }), b = createHeadSession({ root: f.root, purpose: "Same title" });
  const adapter = createSessionHostAdapter({ ...caller, environment: f.environment }); select(adapter, f.root, a.sessionId);
  const selected = adapter.read({ root: f.root }), before = tree(f.root).concat(tree(f.operational));
  await withSessionRoute(f.root, a.sessionId, async () => {
    const file = sessionStatePath(f.root, f.storage);
    for (const router of [null, "head_tools_read", "head_tools_call"]) {
      const response = await invoke(native, request(f.root, "head_session_list", { session_id: b.sessionId }, caller.nativeSessionId, router));
      assert.equal(response.result.structuredContent.preview.sessionId, b.sessionId);
      assert.equal(response.result.structuredContent.preview.workContext.sessionId, b.sessionId);
      assert.deepEqual(adapter.read({ root: f.root }), selected);
      assert.equal(sessionStatePath(f.root, f.storage), file);
    }
  });
  assert.deepEqual(tree(f.root).concat(tree(f.operational)), before);
});

test("edge-only stays unmapped after later binding; wrong/inherited header cannot invent ancestry", async t => {
  const f = fixture(t), native = createNativeSessionHostBridge({ runtime: "codex", environment: f.environment });
  const file = header(f.base, "child", { forked_from_id: "missing-parent" });
  const fork = event(f.root, "SessionStart", { session_id: "child", source: "fork", transcript_path: file });
  await observeNativeHook({ runtime: "codex", event: fork, environment: f.environment });
  for (let n = 0; n < 70; n++) await f.store.observe({ root: f.root, caller: { ...caller, nativeSessionId: "child" }, observation: observed(f.root, `eviction-${n}`) });
  assert.equal(f.store.read({ root: f.root, caller: { ...caller, nativeSessionId: "child" } }).rows.some(x => x.observation.kind === "edge"), true,
    "A retained first mapping must survive event-slot pressure, including a null mapping.");
  select(createSessionHostAdapter({ ...caller, nativeSessionId: "missing-parent", environment: f.environment }), f.root, inspectProject(f.root).state.sessionId);
  await observeNativeHook({ runtime: "codex", event: fork, environment: f.environment });
  const state = f.store.read({ root: f.root, caller: { ...caller, nativeSessionId: "child" } });
  assert.equal(state.rows.find(x => x.observation.kind === "edge").observation.edge.mapping, null);
  assert.equal((await invoke(native, request(f.root, "head_conversation_enter", {}, "child"))).result.structuredContent.relatedNativeWorkContext, undefined);
  await observeNativeHook({ runtime: "codex", event: { ...fork, session_id: "different-child" }, environment: f.environment });
  const wrong = f.store.read({ root: f.root, caller: { ...caller, nativeSessionId: "different-child" } });
  assert.equal(wrong.rows.some(x => x.observation.kind === "edge"), false);
});

test("child source own header uses leaf/direct parent, never shared root or parent's transcript", async t => {
  const f = fixture(t), own = header(f.base, "leaf", { parent_thread_id: "immediate-parent" });
  await observeNativeHook({ runtime: "codex", event: event(f.root, "SubagentStop", { session_id: "shared-root", agent_id: "leaf",
    turn_id: "turn", agent_transcript_path: own, transcript_path: "never-read-parent" }), environment: f.environment });
  const child = f.store.read({ root: f.root, caller: { ...caller, nativeSessionId: "leaf" } });
  assert.equal(child.rows.find(x => x.observation.edge)?.observation.edge.sourceNativeId, "immediate-parent");
  const root = f.store.read({ root: f.root, caller: { ...caller, nativeSessionId: "shared-root" } });
  assert.equal(root.rows.some(x => x.observation.kind === "edge"), false);
  assert.equal(root.rows[0].observation.member.nativeSessionId, "leaf");
});

test("Claude private Hook correlation uses explicit logical routing without changing binding or Canon", async t => {
  const f = fixture(t), config = path.join(f.base, "claude-config"); fs.mkdirSync(path.join(config, "sessions"), { recursive: true });
  f.environment.CLAUDE_CONFIG_DIR = config;
  fs.writeFileSync(path.join(config, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "claude-caller" }));
  const before = tree(f.root);
  await runSessionHostHook({ runtime: "claude", event: event(f.root, "UserPromptSubmit", { session_id: "claude-caller", prompt_id: "actual-prompt", prompt: "SECRET" }), environment: f.environment, observeOnly: true });
  const operational = tree(f.operational), native = createNativeSessionHostBridge({ runtime: "claude", environment: f.environment });
  // Native Hook identity is not a logical Session selection. Keep the absent
  // binding refusal, then prove that an exact explicit route still reads this
  // caller's observations without inventing a binding or selecting a default.
  const logicalSessionId = inspectProject(f.root).state.sessionId;
  const cases = [
    ["head_project_status", {}, false],
    ["head_conversation_enter", {}, false],
    ["head_project_status", { session_id: logicalSessionId }, true],
    ["head_conversation_enter", { session_id: logicalSessionId }, true],
  ];
  for (const [index, [name, args, routed]] of cases.entries()) {
    const toolId = `exact-tool-${name}-${index}`, wire = request(f.root, name, args); wire.params._meta = { "claudecode/toolUseId": toolId };
    const prepared = await invoke(native, { id: 2, method: "tools/call", params: { name: SESSION_HOST_REQUEST_HELPER,
      arguments: { native_session_id: "claude-caller", native_agent_id: "", tool_use_id: toolId,
        outer_tool_name: `mcp__lode__${name}`, original_arguments: JSON.stringify(wire.params.arguments) } } });
    assert.equal(prepared.result.isError, undefined);
    const res = await invoke(native, wire);
    if (!routed) {
      assert.equal(res.result.structuredContent.status, "session_selection_unresolved");
      assert.equal(res.result.structuredContent.nativeContext, undefined);
      continue;
    }
    const obs = res.result.structuredContent.nativeContext;
    assert(obs, `Expected caller observations for case ${index} ${name}; primary status=${res.result.structuredContent.status}`);
    assert.equal(obs.caller.nativeSessionId, "claude-caller");
    assert.equal(obs.observations[0].requestId, "actual-prompt");
    if (["win32", "linux"].includes(process.platform)) assert.equal(obs.observations[0].processObservation?.state, "live-at-check");
  }
  assert.deepEqual(tree(f.root), before); assert.deepEqual(tree(f.operational), operational);
});

test("fanout partial failure retains child publication; no cross-snapshot transaction or ordinary-work failure", async t => {
  const f = fixture(t);
  await f.store.observe({ root: f.root, caller, observation: observed(f.root, "root-seed") });
  const dir = path.join(f.operational, "native-observations", fs.readdirSync(path.join(f.operational, "native-observations"))[0]);
  fs.writeFileSync(path.join(dir, "snapshot.json"), "broken-root");
  const result = await observeNativeHook({ runtime: "codex", event: event(f.root, "SubagentStart", { agent_id: "partial-child", turn_id: "start" }), environment: f.environment });
  assert.equal(result.retained, true);
  assert.ok(f.store.read({ root: f.root, caller: { ...caller, nativeSessionId: "partial-child" } }).rows.length);
  assert.equal(fs.readFileSync(path.join(dir, "snapshot.json"), "utf8"), "broken-root");
});

test("corrupt child snapshot does not suppress independent reported-root membership", async t => {
  const f = fixture(t), child = { ...caller, nativeSessionId: "corrupt-child" };
  await f.store.observe({ root: f.root, caller: child, observation: observed(f.root, "child-seed") });
  const dir = path.join(f.operational, "native-observations", fs.readdirSync(path.join(f.operational, "native-observations"))[0]);
  fs.writeFileSync(path.join(dir, "snapshot.json"), "broken-child");
  const result = await observeNativeHook({ runtime: "codex", event: event(f.root, "SubagentStart", { agent_id: "corrupt-child", turn_id: "start" }), environment: f.environment });
  assert.equal(result.retained, false);
  assert.equal(f.store.read({ root: f.root, caller }).rows[0].observation.member.nativeSessionId, "corrupt-child");
  assert.equal(fs.readFileSync(path.join(dir, "snapshot.json"), "utf8"), "broken-child");
});

test("process projection joins full platform/environment/PID/birth tuple, never another environment's matching PID/birth", async t => {
  const f = fixture(t), claude = { runtime: "claude", nativeSessionId: "same-native", agentId: null };
  const ownEnvironment = "a".repeat(64), foreignEnvironment = "b".repeat(64);
  for (const environment of [ownEnvironment, foreignEnvironment]) {
    await f.store.observe({ root: f.root, caller: claude, observation: { ...observed(f.root, "same-request"),
      instance: { pid: 12345, ppid: 1, birth: "100", platform: "linux", environment } } });
  }
  const projection = await projectNativeObservations({ root: f.root, caller: claude, environment: f.environment,
    processProbe: options => probeClaudeProcesses({ ...options, platform: "linux", probe: async () => ({ environment: ownEnvironment, rows: [{ pid: 12345, state: "gone" }] }) }) });
  assert.deepEqual(projection.observations.map(x => x.processObservation.state), ["ended-at-check", "unknown"]);
  assert.deepEqual(projection.observations.map(x => x.processObservation.environment), [ownEnvironment, foreignEnvironment]);
});

test("writer never removes a replaced lock owned by another writer", async t => {
  const f = fixture(t);
  await f.store.observe({ root: f.root, caller, observation: observed(f.root, "seed") });
  const dir = path.join(f.operational, "native-observations", fs.readdirSync(path.join(f.operational, "native-observations"))[0]), lock = path.join(dir, "writer.lock");
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(dir, "snapshot.json")) { fs.unlinkSync(lock); fs.writeFileSync(lock, "other-owner"); }
    return rename(from, to);
  };
  try { await f.store.observe({ root: f.root, caller, observation: observed(f.root, "next") }); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(lock, "utf8"), "other-owner");
});

test("large transcript accepts bounded first own header; oversized/unsupported first line stays edge-less", async t => {
  const f = fixture(t), good = header(f.base, "large-child", { parent_thread_id: "direct" });
  fs.appendFileSync(good, "PRIVATE BODY MUST NOT BE READ".repeat(5000));
  await observeNativeHook({ runtime: "codex", event: event(f.root, "SessionStart", { session_id: "large-child", source: "fork", transcript_path: good }), environment: f.environment });
  assert.ok(f.store.read({ root: f.root, caller: { ...caller, nativeSessionId: "large-child" } }).rows.some(x => x.observation.kind === "edge"));
  const bad = header(f.base, "bad-child", { cli_version: {}, parent_thread_id: "direct" });
  await observeNativeHook({ runtime: "codex", event: event(f.root, "SessionStart", { session_id: "bad-child", source: "fork", transcript_path: bad }), environment: f.environment });
  assert.equal(f.store.read({ root: f.root, caller: { ...caller, nativeSessionId: "bad-child" } }).rows.some(x => x.observation.kind === "edge"), false);
  fs.writeFileSync(bad, "x".repeat(65536));
  await observeNativeHook({ runtime: "codex", event: event(f.root, "SessionStart", { session_id: "bad-child", source: "fork", transcript_path: bad }), environment: f.environment });
  assert.equal(f.store.read({ root: f.root, caller: { ...caller, nativeSessionId: "bad-child" } }).rows.some(x => x.observation.kind === "edge"), false);
});

test("ordinary startup serializer remains byte-identical; observer failure/uninitialized Project stays optional", async t => {
  const f = fixture(t), start = event(f.root, "SessionStart", { source: "startup", transcript_path: "never-read" });
  const original = sessionStartContext({ runtime: "codex", event: start, environment: f.environment });
  assert.deepEqual(await runSessionHostHook({ runtime: "codex", event: start, environment: f.environment }), original);
  const fresh = path.join(f.base, "untouched"); fs.mkdirSync(fresh);
  assert.deepEqual(await runSessionHostHook({ runtime: "codex", event: event(fresh, "SessionStart", { source: "startup" }), environment: f.environment }), {});
  assert.equal(fs.existsSync(path.join(fresh, ".head")), false);
  assert.equal(fs.existsSync(path.join(fresh, ".lode")), false);
});

test("entry still performs final child basis check after optional source callback", t => {
  const f = fixture(t), current = path.join(f.root, f.layout.directory, "sessions", "current.json");
  const res = enterConversationRecovery({ root: f.root, readRelatedNativeContext: () => {
    const state = JSON.parse(fs.readFileSync(current, "utf8")); state.purpose = "LATER CANCELLATION";
    fs.writeFileSync(current, JSON.stringify(state)); return { sources: [{ wrong: "old result" }] };
  } });
  assert.equal(res.reasonCode, "CONVERSATION_ENTRY_BASIS_CHANGED");
  assert.equal(res.relatedNativeWorkContext, undefined); assert.equal(res.ordinaryWorkBlocked, false);
});

// Logs ownership before spawning; returns only after exact owned child closes.
function ownedNode(t, args, input, environment = {}) {
  t.diagnostic(JSON.stringify({ event: "planned", command: process.execPath, arguments: args, cwd: pluginRoot, parent: process.pid, ports: [], windowsHide: true }));
  const child = spawn(process.execPath, args, { cwd: pluginRoot, windowsHide: true, env: { ...process.env, ...environment }, stdio: ["pipe", "pipe", "pipe"] });
  t.diagnostic(JSON.stringify({ event: "started", pid: child.pid, parent: process.pid, command: process.execPath, arguments: args, cwd: pluginRoot, ports: [] }));
  let stdout = "", stderr = "";
  child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
  const timer = setTimeout(() => child.kill("SIGTERM"), 10000);
  const done = new Promise((resolve, reject) => {
    child.on("error", reject); child.on("close", (code, signal) => {
      clearTimeout(timer); t.diagnostic(JSON.stringify({ event: "closed", pid: child.pid, code, signal, ports: [] }));
      code === 0 ? resolve(stdout) : reject(new Error(stderr || "owned test child failed"));
    });
  });
  child.stdin.end(input); return { child, done };
}

test("actual packaged observer command consumes UTF8 stdin neutrally; oversized input writes nothing", async t => {
  const f = fixture(t), config = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks/codex.json"), "utf8"));
  assert.ok(config.hooks.UserPromptSubmit[0].hooks[0].command.endsWith("--runtime codex --observe-only"));
  // The child receives only a synthetic root plus operational override, not a
  // real user's project, transcript or Claude registry.
  const args = [path.join(pluginRoot, "scripts/session-host-hook.mjs"), "--runtime", "codex", "--observe-only"];
  const input = JSON.stringify(event(f.root, "UserPromptSubmit", { turn_id: "turn-한글😀", prompt: "SECRET" }));
  const first = ownedNode(t, args, input, f.environment);
  assert.equal((await first.done).trim(), "{}");
  assert.equal(f.store.read({ root: f.root, caller }).rows[0].observation.requestId, "turn-한글😀");
  const before = tree(f.operational);
  const huge = ownedNode(t, args, JSON.stringify(event(f.root, "UserPromptSubmit", { prompt: "x".repeat(70 * 1024) })), f.environment);
  assert.equal((await huge.done).trim(), "{}"); assert.deepEqual(tree(f.operational), before);
});

test("two actual overlapping processes merge under one lock without lost updates; owned children exit", async t => {
  const f = fixture(t);
  await f.store.observe({ root: f.root, caller, observation: observed(f.root, "seed") });
  const dir = path.join(f.operational, "native-observations", fs.readdirSync(path.join(f.operational, "native-observations"))[0]);
  fs.writeFileSync(path.join(dir, "writer.lock"), "fixture-owner");
  const module = pathToFileURL(path.join(pluginRoot, "scripts/lib/native-session-observations.mjs")).href, gate = path.join(f.base, "gate");
  const children = [];
  try {
    for (const id of ["concurrent-A", "concurrent-B"]) {
      const ready = path.join(f.base, id), data = { root: f.root, caller, observation: observed(f.root, id) };
      const script = `import fs from 'node:fs';import {createNativeObservationStore} from ${JSON.stringify(module)};fs.writeFileSync(${JSON.stringify(ready)},'ready');while(!fs.existsSync(${JSON.stringify(gate)}))await new Promise(r=>setTimeout(r,5));await createNativeObservationStore({environment:${JSON.stringify(f.environment)}}).observe(${JSON.stringify(data)});`;
      children.push(ownedNode(t, ["--input-type=module", "-e", script], ""));
    }
    const until = Date.now() + 5000;
    while (!["concurrent-A", "concurrent-B"].every(id => fs.existsSync(path.join(f.base, id)))) {
      assert.ok(Date.now() < until); await new Promise(r => setTimeout(r, 10));
    }
    fs.writeFileSync(gate, "go"); await new Promise(r => setTimeout(r, 40)); fs.unlinkSync(path.join(dir, "writer.lock"));
    await Promise.all(children.map(c => c.done));
    const state = f.store.read({ root: f.root, caller });
    assert.deepEqual(new Set(state.rows.map(x => x.observation.requestId)), new Set(["seed", "concurrent-A", "concurrent-B"]));
    assert.equal(fs.existsSync(path.join(dir, "writer.lock")), false);
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.allSettled(children.map(c => c.done));
  }
});
