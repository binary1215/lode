import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { deriveOpenCodeHistoryImport } from "../scripts/lib/provider-native-history-format.mjs";
import { decodeOpenCodeAtomicHistory } from "../scripts/lib/opencode-atomic-history-validation.mjs";
import { inspectOpenCodeAtomicBatch, publishOpenCodeAtomicBatch, readOpenCodeAtomicHistory,
  listOpenCodeAtomicHistory, isQualifiedOpenCodeExecutable } from "../scripts/lib/opencode-atomic-history-store.mjs";
import { createOpenCodeAtomicHistoryHost } from "../scripts/lib/opencode-atomic-history-host.mjs";
import { resolveVerifiedProcessSupervisor, spawnSupervisedProcess } from "../scripts/lib/runtime-process-supervisor.mjs";
import { fixture as projectFixture, snapshot } from "./helpers/session-work-linkage-fixture.mjs";
import { exportProjectBundle } from "../scripts/lib/project-portability.mjs";
import { captureProviderNativeHistory } from "../scripts/lib/provider-native-history-payload.mjs";
import { attachProjectNativeTransfer } from "../scripts/lib/project-native-transfer.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";

const profile = JSON.parse(fs.readFileSync(new URL("../scripts/lib/opencode-atomic-history-profile.json", import.meta.url)));
const slash = value => path.resolve(value).replaceAll("\\", "/");
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-opencode-atomic-")));
  t.after(() => { assert.equal(path.dirname(base), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(base).startsWith("lode-opencode-atomic-")); fs.rmSync(base, { recursive: true, force: true }); });
  const root = path.join(base, "target 한글"), nativeHome = path.join(base, "native-target"), nativeProfile = path.join(nativeHome, "profile");
  const databaseFile = path.join(nativeProfile, "data", "opencode", "opencode.db"); fs.mkdirSync(root); fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  const db = new DatabaseSync(databaseFile); db.exec("PRAGMA journal_mode=WAL");
  for (const row of profile.database.schema.filter(row => row.type === "table")) db.exec(row.sql);
  for (const table of profile.database.tables) for (const index of [...table.indexes].sort((a, b) => b.seq - a.seq))
    if (index.origin === "c") db.exec(profile.database.schema.find(row => row.type === "index" && row.name === index.name).sql);
  for (const id of profile.database.migrationIds) db.prepare("INSERT INTO migration(id,time_completed) VALUES (?,1)").run(id);
  db.prepare("INSERT INTO project(id,worktree,time_created,time_updated,sandboxes,commands) VALUES (?,?,1,1,'[]','{}')").run("target_project", slash(root));
  db.close(); return { base, root, nativeHome, databaseFile };
}
function history(nativeId = "ses_selected", count = 1, parentID) {
  return { info: { id: nativeId, slug: "synthetic", title: "Synthetic only", version: "1.19.5", projectID: "source_project", directory: "C:/source-only",
    ...(parentID ? { parentID } : {}), agent: "source-only", permission: [{ permission: "*", pattern: "*", action: "allow" }],
    model: { id: "source-model", providerID: "source-provider" }, time: { created: 1, updated: 2, archived: -1 }, metadata: { note: "retained" } },
  messages: Array.from({ length: count }, (_, index) => {
    const mid = "msg_" + nativeId + "_" + String(count - index).padStart(4, "0");
    return { info: { id: mid, sessionID: nativeId, role: "user", time: { created: Math.floor(index / 3) + 10 },
      agent: "historical-agent", model: { providerID: "historical-provider", modelID: "historical-model" }, futureHistoricalField: { keep: true } },
    parts: [{ id: "prt_" + mid, sessionID: nativeId, messageID: mid, type: "text", text: "Synthetic " + index }] };
  }) };
}
function selected(document) {
  const raw = Buffer.from(JSON.stringify(document));
  return { nativeId: document.info.id, raw: deriveOpenCodeHistoryImport(raw, { nativeId: document.info.id }).bytes };
}
const options = (f, documents, extra = {}) => ({ databaseFile: f.databaseFile, root: f.root, documents, ...extra });
function rows(file, table) { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare('SELECT * FROM "' + table + '" ORDER BY 1').all(); } finally { db.close(); } }

test("atomic batch preserves full selected histories, official ordering/defaults, child linkage and unrelated rows", async t => {
  const f = fixture(t), parent = history("ses_parent", 62), child = history("ses_child", 1, parent.info.id);
  const row = parent.messages[0], base = { sessionID: parent.info.id, messageID: row.info.id }, part = (type, fields = {}) => ({ ...base, id: "prt_variant_" + type.replaceAll("-", "_") + "_" + row.parts.length, type, ...fields });
  const examples = [part("reasoning", { text: "reasoning", time: { start: 0, end: 1 } }), part("snapshot", { snapshot: "synthetic" }),
    part("patch", { hash: "synthetic", files: ["file.txt"] }), part("file", { mime: "text/plain", url: "file:///synthetic", source: { type: "file", path: "synthetic", text: { value: "x", start: 0, end: 1 } } }),
    part("agent", { name: "historical" }), part("compaction", { auto: true }), part("subtask", { prompt: "Historical only", description: "Historical", agent: "historical" }),
    part("retry", { attempt: 1, error: { name: "APIError", data: { message: "synthetic", isRetryable: true } }, time: { created: 1 } }),
    part("step-start"), part("step-finish", { reason: "stop", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })];
  row.parts.push(...examples);
  for (const [index, state] of [{ status: "pending", input: {}, raw: "{}" }, { status: "running", input: {}, time: { start: 0 } },
    { status: "completed", input: {}, output: "synthetic", title: "done", metadata: {}, time: { start: 0, end: 1 } },
    { status: "error", input: {}, error: "synthetic", time: { start: 0, end: 1 } }].entries())
    row.parts.push({ ...base, id: "prt_tool_" + index, type: "tool", callID: "call_" + index, tool: "historical", state });
  const seed = new DatabaseSync(f.databaseFile);
  seed.prepare("INSERT INTO account(id,email,url,access_token,refresh_token,time_created,time_updated) VALUES ('synthetic_account','synthetic@example.invalid','https://example.invalid','synthetic-not-a-credential','synthetic-not-a-credential',1,1)").run(); seed.close();
  const docs = [selected(child), selected(parent)], before = docs.map(row => Buffer.from(row.raw)), projectBefore = rows(f.databaseFile, "project"), accountBefore = rows(f.databaseFile, "account");
  const result = await publishOpenCodeAtomicBatch(options(f, docs));
  assert.equal(result.batchCommitted, true); assert.equal(result.sessions, 2); assert.equal(result.messages, 63);
  const observed = inspectOpenCodeAtomicBatch(options(f, docs)); assert.equal(observed.state, "matches");
  assert.deepEqual(rows(f.databaseFile, "project"), projectBefore);
  assert.deepEqual(rows(f.databaseFile, "account"), accountBefore);
  for (const [i, doc] of docs.entries()) assert.deepEqual(doc.raw, before[i]);
  const actual = readOpenCodeAtomicHistory({ ...f, nativeId: parent.info.id });
  assert.equal(actual.info.cost, 0); assert.equal(actual.info.tokens.input, 0); assert.equal(actual.info.time.archived, -1);
  assert.equal(actual.info.permission, undefined); assert.equal(actual.info.agent, undefined);
  assert.equal(actual.messages.length, 62); assert.equal(actual.messages[0].info.futureHistoricalField.keep, true);
  const expected = [...parent.messages].sort((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id));
  assert.deepEqual(actual.messages.map(row => row.info.id), expected.map(row => row.info.id));
  assert.deepEqual(listOpenCodeAtomicHistory(f).map(row => row.id), [parent.info.id]);
  await assert.rejects(() => publishOpenCodeAtomicBatch(options(f, docs)), { code: "NATIVE_OPENCODE_BATCH_NOT_WRITE_ELIGIBLE" });
});

test("source-bound decoder rejects malformed and unknown variants before any row is written", async t => {
  const cases = [d => delete d.messages[0].parts[0].text, d => d.messages[0].parts[0].type = "unsupported",
    d => delete d.messages[0].info.agent, d => delete d.messages[0].info.model.providerID,
    d => d.messages[0].parts[0].messageID = "msg_foreign", d => d.info.slug = null,
    d => d.messages[0].parts[0] = { ...d.messages[0].parts[0], type: "tool", callID: "x", tool: "x", state: { status: "completed", input: {}, output: "missing title/time" } },
    d => d.messages[0].parts[0] = { ...d.messages[0].parts[0], type: "file", mime: "x", url: "x", source: { type: "symbol", path: "x", text: { value: "x", start: 0, end: 1 }, name: "x", kind: 1 } }];
  for (const [index, change] of cases.entries()) await t.test(String(index), async t => {
    const f = fixture(t), doc = history(); change(doc); const raw = Buffer.from(JSON.stringify(doc));
    assert.throws(() => decodeOpenCodeAtomicHistory(raw, doc.info.id));
    await assert.rejects(() => publishOpenCodeAtomicBatch(options(f, [{ nativeId: doc.info.id, raw }])));
    assert.deepEqual(rows(f.databaseFile, "session"), []); assert.deepEqual(rows(f.databaseFile, "message"), []); assert.deepEqual(rows(f.databaseFile, "part"), []);
  });
});

test("cross-session global IDs, parent ownership and cycles fail without partial publication", async t => {
  for (const mode of ["message-id", "part-id", "message-parent", "parent-cycle"]) await t.test(mode, async t => {
    const f = fixture(t), a = history("ses_a"), b = history("ses_b");
    if (mode === "message-id") { b.messages[0].info.id = a.messages[0].info.id; b.messages[0].parts[0].messageID = a.messages[0].info.id; }
    if (mode === "part-id") b.messages[0].parts[0].id = a.messages[0].parts[0].id;
    if (mode === "parent-cycle") { a.info.parentID = b.info.id; b.info.parentID = a.info.id; }
    if (mode === "message-parent") b.messages[0].info = { ...b.messages[0].info, role: "assistant", parentID: a.messages[0].info.id,
      modelID: "historical", providerID: "historical", mode: "historical", path: { cwd: "old", root: "old" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
    await assert.rejects(() => publishOpenCodeAtomicBatch(options(f, [selected(a), selected(b)])));
    assert.deepEqual(rows(f.databaseFile, "session"), []);
  });
});

test("schema, migration, target project and physical database drift are checked before and inside the transaction", async t => {
  for (const mode of ["schema", "migration", "project", "raced-schema", "raced-project", "db-replaced"]) await t.test(mode, async t => {
    const f = fixture(t), docs = [selected(history())];
    const mutate = () => { const db = new DatabaseSync(f.databaseFile); try {
      if (mode.includes("schema")) db.exec("CREATE TRIGGER unknown_trigger AFTER INSERT ON session BEGIN SELECT 1; END");
      else if (mode === "migration") db.prepare("INSERT INTO migration(id,time_completed) VALUES ('unknown_migration',1)").run();
      else db.prepare("UPDATE project SET worktree='C:/unselected'").run();
    } finally { db.close(); } };
    if (["schema", "migration", "project"].includes(mode)) mutate();
    await assert.rejects(() => publishOpenCodeAtomicBatch(options(f, docs, { onPhase: async ({ phase }) => {
      if (phase !== "before-begin") return;
      if (mode.startsWith("raced-")) mutate();
      if (mode === "db-replaced") { fs.renameSync(f.databaseFile, f.databaseFile + ".original"); fs.copyFileSync(f.databaseFile + ".original", f.databaseFile); }
    } })));
    assert.deepEqual(rows(f.databaseFile, "session"), []);
  });
});

test("readers coexist, a competing writer fails promptly, and row failure/cancellation rolls the whole batch back", async t => {
  for (const mode of ["reader", "writer", "row-failure", "cancel"]) await t.test(mode, async t => {
    const f = fixture(t), docs = [selected(history("ses_one", 3)), selected(history("ses_two", 3))];
    let other;
    if (mode === "reader" || mode === "writer") { other = new DatabaseSync(f.databaseFile); other.exec(mode === "reader" ? "BEGIN" : "BEGIN IMMEDIATE"); other.prepare("SELECT count(*) FROM session").get(); }
    const controller = new AbortController(); let inserted = 0;
    try {
      const action = () => publishOpenCodeAtomicBatch(options(f, docs, { signal: controller.signal, onPhase: async ({ phase }) => {
        if (phase === "row-inserted" && ++inserted === 3) {
          if (mode === "row-failure") throw Object.assign(Error("synthetic row failure"), { code: "SYNTHETIC_ROW_FAILURE" });
          if (mode === "cancel") controller.abort();
        }
      } }));
      if (mode === "reader") { await action(); assert.equal(other.prepare("SELECT count(*) AS count FROM session").get().count, 0); }
      else await assert.rejects(action, { code: mode === "writer" ? "NATIVE_OPENCODE_WRITER_BUSY" : mode === "cancel" ? "NATIVE_HISTORY_OPERATION_CANCELLED" : "SYNTHETIC_ROW_FAILURE" });
    } finally { if (other) { other.exec("ROLLBACK"); other.close(); } }
    assert.equal(rows(f.databaseFile, "session").length, mode === "reader" ? 2 : 0);
    assert.equal(inspectOpenCodeAtomicBatch(options(f, docs)).state, mode === "reader" ? "matches" : "absent");
  });
});

test("commit followed by receipt failure requires exact readback and cannot authorize a second insertion", async t => {
  const f = fixture(t), docs = [selected(history())];
  await assert.rejects(() => publishOpenCodeAtomicBatch(options(f, docs, { onPhase: async ({ phase }) => {
    if (phase === "after-commit") throw Object.assign(Error("synthetic receipt failure"), { code: "SYNTHETIC_RECEIPT_FAILURE" });
  } })), error => error.code === "SYNTHETIC_RECEIPT_FAILURE" && error.nativeDatabaseOutcome === "commit-outcome-requires-exact-readback");
  assert.equal(inspectOpenCodeAtomicBatch(options(f, docs)).state, "matches");
  await assert.rejects(() => publishOpenCodeAtomicBatch(options(f, docs)), { code: "NATIVE_OPENCODE_BATCH_NOT_WRITE_ELIGIBLE" });
  assert.equal(rows(f.databaseFile, "session").length, 1);
});

test("foreign existing global IDs and an exact partial batch stay observable but never become write eligibility", async t => {
  for (const mode of ["session", "message", "part", "partial"]) await t.test(mode, async t => {
    const f = fixture(t), first = history("ses_first"), second = history("ses_second");
    await publishOpenCodeAtomicBatch(options(f, [selected(first)]));
    if (mode === "session") second.info.id = first.info.id;
    if (mode === "session") for (const row of second.messages) { row.info.sessionID = second.info.id; for (const part of row.parts) part.sessionID = second.info.id; }
    if (mode === "message") { second.messages[0].info.id = first.messages[0].info.id; second.messages[0].parts[0].messageID = first.messages[0].info.id; }
    if (mode === "part") second.messages[0].parts[0].id = first.messages[0].parts[0].id;
    const docs = mode === "partial" ? [selected(first), selected(second)] : [selected(second)];
    assert.equal(inspectOpenCodeAtomicBatch(options(f, docs)).state, mode === "partial" ? "partial" : "diverged");
    const before = [rows(f.databaseFile, "session"), rows(f.databaseFile, "message"), rows(f.databaseFile, "part")];
    await assert.rejects(() => publishOpenCodeAtomicBatch(options(f, docs)), { code: "NATIVE_OPENCODE_BATCH_NOT_WRITE_ELIGIBLE" });
    assert.deepEqual([rows(f.databaseFile, "session"), rows(f.databaseFile, "message"), rows(f.databaseFile, "part")], before);
  });
});

test("source buffers cannot change the already admitted batch across async boundaries", async t => {
  const f = fixture(t), docs = [selected(history())], original = Buffer.from(docs[0].raw);
  await publishOpenCodeAtomicBatch(options(f, docs, { onPhase: async ({ phase }) => {
    if (phase === "before-begin") { docs[0].raw.fill(32); docs[0].nativeId = "ses_changed"; }
  } }));
  assert.equal(inspectOpenCodeAtomicBatch(options(f, [{ nativeId: "ses_selected", raw: original }])).state, "matches");
});

test("independent-review regressions: existing ancestry, physical ordering, nested loss and sqliteX schema objects", async t => {
  for (const mode of ["foreign-parent", "existing-cycle", "raced-foreign-parent", "sql-order", "time", "summary", "tokens", "cache", "share", "hidden-trigger", "hidden-table", "hidden-view"]) await t.test(mode, async t => {
    const f = fixture(t), document = history("ses_new", 2);
    if (["foreign-parent", "existing-cycle", "raced-foreign-parent"].includes(mode)) {
      const existing = history("ses_existing", 1, mode === "existing-cycle" ? document.info.id : undefined);
      await publishOpenCodeAtomicBatch(options(f, [selected(existing)])); document.info.parentID = existing.info.id;
      const moveParent = () => { const db = new DatabaseSync(f.databaseFile); try {
        db.prepare("INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('foreign_project','C:/foreign',1,1,'[]')").run();
        db.prepare("UPDATE session SET project_id='foreign_project' WHERE id=?").run(existing.info.id);
      } finally { db.close(); } };
      if (mode === "foreign-parent") moveParent();
      await assert.rejects(() => publishOpenCodeAtomicBatch(options(f, [selected(document)], { onPhase: async ({ phase }) => {
        if (mode === "raced-foreign-parent" && phase === "before-begin") moveParent();
      } })), { code: mode === "existing-cycle" ? "NATIVE_OPENCODE_PARENT_CYCLE" : "NATIVE_OPENCODE_SESSION_PARENT_OWNER_MISMATCH" });
      assert.equal(rows(f.databaseFile, "session").length, 1); return;
    }
    if (mode === "sql-order") {
      const docs = [selected(document)]; await publishOpenCodeAtomicBatch(options(f, docs));
      const db = new DatabaseSync(f.databaseFile); db.prepare("UPDATE message SET time_created=100 WHERE id=?").run(document.messages[0].info.id); db.close();
      assert.equal(inspectOpenCodeAtomicBatch(options(f, docs)).state, "diverged");
      assert.throws(() => readOpenCodeAtomicHistory({ ...f, nativeId: document.info.id }), { code: "NATIVE_OPENCODE_MESSAGE_ORDER_MISMATCH" }); return;
    }
    if (mode.startsWith("hidden-")) {
      const db = new DatabaseSync(f.databaseFile);
      if (mode === "hidden-trigger") db.exec("CREATE TRIGGER sqliteX_hidden AFTER INSERT ON session BEGIN UPDATE project SET name='changed-by-trigger'; END");
      if (mode === "hidden-table") db.exec("CREATE TABLE sqliteX_hidden(id TEXT)");
      if (mode === "hidden-view") db.exec("CREATE VIEW sqliteX_hidden AS SELECT id FROM project");
      db.close(); const before = rows(f.databaseFile, "project");
      await assert.rejects(() => publishOpenCodeAtomicBatch(options(f, [selected(document)])), { code: "NATIVE_OPENCODE_SCHEMA_UNQUALIFIED" });
      assert.deepEqual(rows(f.databaseFile, "project"), before); assert.equal(rows(f.databaseFile, "session").length, 0); return;
    }
    if (mode === "time") document.info.time.sourceClock = "synthetic-clock";
    if (mode === "summary") document.info.summary = { additions: 0, deletions: 0, files: 0, unknown: "preserve" };
    if (mode === "tokens" || mode === "cache") {
      document.info.tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
      (mode === "tokens" ? document.info.tokens : document.info.tokens.cache).unknown = "preserve";
    }
    if (mode === "share") document.info.share = { url: "synthetic", unknown: "preserve" };
    await assert.rejects(() => publishOpenCodeAtomicBatch(options(f, [selected(document)])), { code: "NATIVE_OPENCODE_HISTORY_SCHEMA_INVALID" });
    assert.equal(rows(f.databaseFile, "session").length, 0);
  });
});

test("qualified offline CLI/MCP routes restore once, reconcile a lost receipt and keep register read-only", {
  skip: !process.env.LODE_OPENCODE_1_19_5_BINARY,
}, async t => {
  const f = fixture(t), core = projectFixture(t), source = path.join(core.base, "atomic-source"), payload = path.join(core.base, "atomic-payload"), bundle = path.join(core.base, "atomic-bundle");
  fs.mkdirSync(source); const raw = Buffer.from(JSON.stringify(history())); fs.writeFileSync(path.join(source, "selected.json"), raw);
  captureProviderNativeHistory({ provider: "opencode", sourceDirectory: source, destination: payload,
    nativeIds: ["ses_selected"], files: [{ path: "selected.json", nativeId: "ses_selected", role: "conversation" }], reportedClientVersion: "1.19.5" });
  core.route(() => exportProjectBundle({ root: core.root, destination: bundle })); attachProjectNativeTransfer({ provider: "opencode", bundleRoot: bundle, directory: payload });
  const before = snapshot(core.root), executable = process.env.LODE_OPENCODE_1_19_5_BINARY;
  const args = ["project-native-history", bundle, "--action", "restore", "--native-home", f.nativeHome, "--runtime-root", f.root, "--executable", executable];
  const link = fs.linkSync; let failed = false;
  const mock = t.mock.method(fs, "linkSync", function(from, to, ...rest) {
    if (!failed && String(to).endsWith(".result.json")) { failed = true; throw Object.assign(Error("synthetic receipt failure"), { code: "SYNTHETIC_RECEIPT_FAILED" }); }
    return link.call(this, from, to, ...rest);
  });
  const first = await runCommand(args); mock.mock.restore();
  assert.equal(first.status, "native-history-operation-uncertain"); assert.equal(first.primaryFailure.code, "SYNTHETIC_RECEIPT_FAILED");
  const stored = rows(f.databaseFile, "message"), retried = await runCommand(args);
  assert.equal(retried.historyReadbackVerified, true); assert.equal(retried.importsAttempted, 0);
  assert.equal(retried.clientEvidence, "qualified-opencode-sqlite-adapter"); assert.equal(retried.providerProcessStarted, false);
  assert.equal(retried.continuationReady, false); assert.deepEqual(rows(f.databaseFile, "message"), stored);
  const journal = path.join(f.nativeHome, ".lode-native-transfer"), journalBefore = snapshot(journal), markerBefore = fs.readFileSync(path.join(f.nativeHome, "native-profile-intent.json"));
  const registered = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "head_project_native_history", arguments: {
    action: "register", bundle_root: bundle, native_home: f.nativeHome, runtime_root: f.root, executable } } });
  assert.equal(registered.error, undefined); assert.equal(registered.result.structuredContent.historyReadbackVerified, true);
  assert.match(registered.result.structuredContent.listCoverage, /qualified-db-root-list/);
  assert.deepEqual(snapshot(journal), journalBefore); assert.deepEqual(fs.readFileSync(path.join(f.nativeHome, "native-profile-intent.json")), markerBefore);
  assert.deepEqual(snapshot(core.root), before); assert.deepEqual(fs.readFileSync(path.join(source, "selected.json")), raw);
});

test("an arbitrary version string or executable cannot qualify an atomic Host", t => {
  const f = fixture(t), executable = path.join(f.base, "opencode.exe"); fs.writeFileSync(executable, "synthetic-not-an-executable");
  assert.equal(isQualifiedOpenCodeExecutable({ platform: process.platform, arch: process.arch, bytes: 1, sha256: "a".repeat(64) }), false);
  assert.throws(() => createOpenCodeAtomicHistoryHost({ executable, nativeHome: f.base, root: f.root }), { code: "NATIVE_OPENCODE_VERSION_UNQUALIFIED" });
  assert.deepEqual(rows(f.databaseFile, "session"), []);
});

test("termination of an owned synthetic child rolls back before commit and preserves a committed batch after commit", { skip: !process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT }, async t => {
  for (const boundary of ["before-commit", "after-commit"]) await t.test(boundary, async t => {
    const f = fixture(t), docs = [selected(history())], input = path.join(f.base, "input.json"), ready = path.join(f.base, "ready");
    fs.writeFileSync(input, JSON.stringify({ ...options(f, docs.map(row => ({ ...row, raw: row.raw.toString("base64") }))), ready, boundary }));
    const module = new URL("../scripts/lib/opencode-atomic-history-store.mjs", import.meta.url).href;
    const script = `import fs from 'node:fs';import{publishOpenCodeAtomicBatch}from ${JSON.stringify(module)};const x=JSON.parse(fs.readFileSync(process.argv[1]));x.documents=x.documents.map(r=>({...r,raw:Buffer.from(r.raw,'base64')}));await publishOpenCodeAtomicBatch({...x,onPhase:async({phase})=>{if(phase===x.boundary){fs.writeFileSync(x.ready,'ready',{flag:'wx'});await new Promise(()=>setInterval(()=>{},1000));}}});`;
    const selection = resolveVerifiedProcessSupervisor({ pluginRoot: process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT });
    const handle = spawnSupervisedProcess({ selection, executablePath: process.execPath, args: ["--input-type=module", "-e", script, input], cwd: f.root,
      providerEnvironment: Object.fromEntries(["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"].filter(key => process.env[key]).map(key => [key, process.env[key]])),
      input: Buffer.alloc(0), controlFile: path.join(f.base, "control.jsonl"), terminationGraceMs: 500 });
    console.error(JSON.stringify({ event: "CHILD_START", pid: handle.child.pid, parent: process.pid, command: "owned-synthetic-sqlite-boundary", cwd: f.root, ports: [] }));
    handle.child.stdout.resume(); handle.child.stderr.resume(); handle.child.stdin.on("error", () => {});
    let closed = false; const completion = new Promise(resolve => handle.child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); }));
    try {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(ready) && !closed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(fs.existsSync(ready), true, "The owned child must reach the exact transaction boundary.");
      handle.terminate(false); const ended = await completion;
      const receipt = handle.finalize({ exactSupervisorExitObserved: true, terminationRequested: true });
      console.error(JSON.stringify({ event: "CHILD_END", pid: handle.child.pid, ...ended, receipt, ports: [] }));
      assert.equal(receipt.treeCleanupVerified, true);
      assert.equal(inspectOpenCodeAtomicBatch(options(f, docs)).state, boundary === "before-commit" ? "absent" : "matches");
    } finally { if (!closed) { handle.terminate(true); await completion; } }
  });
});
