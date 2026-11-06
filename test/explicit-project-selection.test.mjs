import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { syntheticNativeDatabase, nativeProfile } from "./helpers/native-portability-fixture.mjs";
import { readCodexLiveProjectSource } from "../scripts/lib/codex-live-project-source.mjs";
import { verifyCodexProjectCatalog } from "../scripts/lib/codex-project-catalog.mjs";
import { codexSourcePathKey } from "../scripts/lib/codex-explicit-project-selection.mjs";
import { resolveCodexPhysicalLineage, CODEX_PAGINATED_CREATION_VERSIONS } from "../scripts/lib/codex-physical-lineage.mjs";
import { archiveCodexCapturedPhysicalSource, inspectCodexCapturedPhysicalSource, readCodexCapturedPhysicalEvents } from "../scripts/lib/codex-captured-physical-source.mjs";
import { encodeClaudeDerived } from "../scripts/lib/claude-derived-encoder.mjs";
import { exportCodexLiveProjectEvidence, exportPortableProjectEvidence, inspectPortableProjectEvidence } from "../scripts/lib/portable-project-evidence.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { dispatch, catalogTools } from "../scripts/mcp-server.mjs";
import { inspectCodexNativeDatabase, readSelectedCodexHistory } from "../scripts/lib/codex-native-portability.mjs";

const ids = [1, 2, 3, 4].map(i => "01900000-0000-7000-8000-00000000800" + i);
const hash = raw => crypto.createHash("sha256").update(raw).digest("hex");
const encode = frames => Buffer.from(frames.map(row => JSON.stringify(row)).join("\n") + "\n");
const frames = (id, version = nativeProfile.engineVersion) => [
  { ordinal: 0, type: "session_meta", payload: { id, session_id: id, cli_version: version, history_mode: "paginated" } },
  { ordinal: 1, type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
  { ordinal: 2, type: "event_msg", payload: { type: "item_completed", thread_id: id, turn_id: "turn", item: { type: "UserMessage", id: "user", content: [{ type: "text", text: "SYNTHETIC explicit selection only; deployment cancelled" }] } } },
  { ordinal: 3, type: "event_msg", payload: { type: "item_completed", thread_id: id, turn_id: "turn", item: { type: "AgentMessage", id: "agent", content: [{ type: "Text", text: "SYNTHETIC cancellation retained" }] } } },
  { ordinal: 4, type: "event_msg", payload: { type: "task_complete", turn_id: "turn" } },
];
const directoryIdentity = root => { const stat = fs.lstatSync(root, { bigint: true }); return { path: fs.realpathSync(root), dev: String(stat.dev), ino: String(stat.ino) }; };
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lode-explicit-source-")), home = path.join(base, "home"), project = path.join(base, "project");
  fs.mkdirSync(home); fs.mkdirSync(project);
  const state = syntheticNativeDatabase({ after() {} }, "state_5.sqlite", path.join(home, "state_5.sqlite"));
  const history = syntheticNativeDatabase({ after() {} }, "thread_history_1.sqlite", path.join(home, "thread_history_1.sqlite"));
  t.after(() => { state.close(); history.close(); assert.equal(path.dirname(fs.realpathSync(base)), fs.realpathSync(os.tmpdir())); fs.rmSync(base, { recursive: true, force: true }); });
  for (const db of [state.db, history.db]) db.exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0");
  state.row("projects", { id: "native-project", name: "Synthetic native Project" });
  const files = ids.map(id => path.join(home, "sessions/2026/11/06/rollout-synthetic-" + id + ".jsonl"));
  fs.mkdirSync(path.dirname(files[0]), { recursive: true });
  for (const [index, id] of ids.entries()) {
    if (index !== 2) fs.writeFileSync(files[index], encode(frames(id)));
    state.row("threads", { id, project_id: index === 0 ? "native-project" : null,
      cwd: path.toNamespacedPath(project), rollout_path: path.toNamespacedPath(files[index]),
      cli_version: nativeProfile.engineVersion, history_mode: "paginated", title: "SYNTHETIC PRIVATE TITLE" });
    history.row("thread_history_projection_state", { thread_id: id, next_rollout_byte_offset: 0n, next_rollout_ordinal: 0n });
  }
  const document = { schemaVersion: 1, kind: "CodexExplicitProjectSelection", authorityPlane: "P3", sourcePlatform: "win32",
    projectReference: { namespace: "codex-app-project", id: "app-project", name: "Synthetic app Project" },
    sourceHome: directoryIdentity(home), projectRoot: directoryIdentity(project),
    members: ids.slice(0, 3).map((id, index) => { const stat = fs.lstatSync(files[index], { bigint: true, throwIfNoEntry: false });
      return { id, nativeProjectId: index === 0 ? "native-project" : null, cwd: path.toNamespacedPath(project), rolloutPath: path.toNamespacedPath(files[index]), fileIdentity: stat ? { dev: String(stat.dev), ino: String(stat.ino) } : null }; }),
    observedAt: "2026-11-06T00:00:00Z", selectionOrigin: "current-caller-exact-conversation-selection",
    nullFileIdentityMeaning: "observed-absent-requires-new-observation-if-present",
    claimsHostAuthentication: false, appMembershipVerifiedByCore: false, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
  const selectionFile = path.join(base, "selection.json");
  const save = (value = document) => { const raw = Buffer.from(JSON.stringify(value, null, 2) + "\n"); fs.writeFileSync(selectionFile, raw); return hash(raw); };
  const digest = save();
  return { base, home, project, state, history, files, document, selectionFile, save,
    scope: { home, sourceProjectId: "app-project", sourceProjectRoot: project, sourceSelectionFile: selectionFile,
      expectedSourceSelectionDigest: digest, allowSynchronizationFiles: true, assertCurrentAuthority: () => {} } };
}

test("Windows namespace spelling comparison keeps DOS/extended/UNC equivalence separate from access and rejects device namespaces", () => {
  assert.equal(codexSourcePathKey(String.raw`C:\Users\example\source`, "win32"), codexSourcePathKey(String.raw`\\?\C:\Users\example\source`, "win32"));
  assert.equal(codexSourcePathKey(String.raw`\\server\share\source`, "win32"), codexSourcePathKey(String.raw`\\?\UNC\server\share\source`, "win32"));
  assert.equal(codexSourcePathKey(String.raw`\\.\pipe\source`, "win32"), null);
  assert.equal(codexSourcePathKey(String.raw`\\?\GLOBALROOT\Device\HarddiskVolume1\source`, "win32"), null);
  assert.notEqual(codexSourcePathKey(String.raw`C:\allowed\..\outside\source`, "win32"), codexSourcePathKey(String.raw`C:\allowed\source`, "win32"));
});

test("selected live schema inspection avoids whole-database scans while default integrity and selected-row failures remain primary", t => {
  const f = fixture(t), queries = [];
  const database = { prepare(sql) { queries.push(sql); return f.history.db.prepare(sql); } };
  const basis = { file: "thread_history_1.sqlite", engineVersion: nativeProfile.engineVersion, platform: process.platform, architecture: process.arch };
  const schema = inspectCodexNativeDatabase(database, { ...basis, inspectionScope: "selected-live-read-schema" });
  assert.equal(schema.wholeDatabaseIntegrity, "not-observed");
  assert.ok(!queries.some(sql => /quick_check|foreign_key_check/u.test(sql)));
  const history = readSelectedCodexHistory(database, { ...basis, threadIds: [ids[0]], inspectionScope: "selected-live-read-schema" });
  assert.deepEqual(history.threadIds, [ids[0]]);
  assert.ok(!queries.some(sql => /quick_check|foreign_key_check/u.test(sql)));
  assert.equal(inspectCodexNativeDatabase(database, basis).wholeDatabaseIntegrity, "checked");
  assert.ok(queries.includes("PRAGMA quick_check")); assert.ok(queries.includes("PRAGMA foreign_key_check"));
  const failing = { prepare(sql) { if (sql === "PRAGMA quick_check") return { get: () => ({ quick_check: "synthetic corruption" }) }; return f.history.db.prepare(sql); } };
  assert.throws(() => inspectCodexNativeDatabase(failing, basis), { code: "NATIVE_CODEX_DATABASE_CORRUPT" });
  // A current selected row read failure must never be converted into partial history.
  const failingSelected = { prepare(sql) { if (sql.includes('WHERE "thread_id" = ?')) throw Object.assign(Error(), { code: "EACCES" }); return f.history.db.prepare(sql); } };
  assert.throws(() => readSelectedCodexHistory(failingSelected, { ...basis, threadIds: [ids[0]], inspectionScope: "selected-live-read-schema" }), { code: "EACCES" });
  const corruptSelected = { prepare(sql) { if (sql.includes('WHERE "thread_id" = ?')) throw Object.assign(Error(), { code: "SQLITE_CORRUPT" }); return f.history.db.prepare(sql); } };
  assert.throws(() => readSelectedCodexHistory(corruptSelected, { ...basis, threadIds: [ids[0]], inspectionScope: "selected-live-read-schema" }), { code: "SQLITE_CORRUPT" });
  f.history.row("thread_items", { thread_id: ids[0], turn_id: "missing-turn", item_id: "orphan", rollout_ordinal: 0n, updated_at_ordinal: 0n, item_type: "userMessage", item_json: "{}" });
  assert.throws(() => readSelectedCodexHistory(database, { ...basis, threadIds: [ids[0]], inspectionScope: "selected-live-read-schema" }), { code: "NATIVE_CODEX_HISTORY_TURN_UNRESOLVED" });
  assert.throws(() => inspectCodexNativeDatabase(database, { ...basis, inspectionScope: "ignore-corruption" }), { code: "NATIVE_CODEX_INSPECTION_SCOPE_INVALID" });
  f.history.db.exec('CREATE TABLE unknown_schema (value TEXT)');
  assert.throws(() => inspectCodexNativeDatabase(database, { ...basis, inspectionScope: "selected-live-read-schema" }), { code: "NATIVE_CODEX_SCHEMA_UNSUPPORTED" });
});

test("explicit app selection preserves native associations/null, excludes third cwd-only rows, and keeps native Project protection", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t), opened = fs.openSync; let unselectedBodyReads = 0;
  fs.openSync = function(file, ...rest) { if (file === f.files[3]) { unselectedBodyReads++; throw Error("Unselected body opened"); } return opened.call(this, file, ...rest); };
  let observed; try { observed = await readCodexLiveProjectSource(f.scope); } finally { fs.openSync = opened; }
  assert.equal(unselectedBodyReads, 0); assert.equal(observed.value.conversations.length, 3);
  assert.equal(observed.value.catalog.kind, "CodexExplicitConversationCatalog");
  const verified = verifyCodexProjectCatalog(observed.value.catalog);
  assert.deepEqual(verified.records.map(row => row.project_id), ["native-project", null, null]);
  assert.equal(verified.appMembershipVerifiedByCore, false); assert.equal(verified.selectionIsPermission, false);
  assert.equal(observed.value.conversations.filter(row => row.lineage?.status === "physical-lineage-ranges-verified").length, 2);
  assert.equal(observed.value.conversations.find(row => row.threadId === ids[2]).reasonCode, "CODEX_LIVE_SELECTED_FILE_NOT_FOUND");
  assert.equal(observed.value.conversations[0].selectedStateHeaderAgreement, true);
  const nativeScope = { home: f.home, sourceProjectId: "native-project", allowSynchronizationFiles: true, assertCurrentAuthority: () => {} };
  const native = await readCodexLiveProjectSource(nativeScope); assert.deepEqual(native.value.catalog.threadIds, [ids[0]]);
  await assert.rejects(readCodexLiveProjectSource({ ...nativeScope, sourceProjectId: "app-project" }), { code: "NATIVE_CODEX_PROJECT_NOT_FOUND" });
  await assert.rejects(readCodexLiveProjectSource({ ...nativeScope, threadIds: [ids[1]] }), { code: "CODEX_LIVE_PROJECT_MEMBERSHIP_MISMATCH" });
  const wrongNative = structuredClone(observed.value.catalog); wrongNative.kind = "CodexProjectCatalog";
  assert.throws(() => verifyCodexProjectCatalog(wrongNative), { code: "NATIVE_CODEX_PROJECT_CATALOG_INVALID" });
});

test("explicit selector does not supply permission or new roots; bytes, current native metadata and file identities stay exact", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t);
  await assert.rejects(readCodexLiveProjectSource({ ...f.scope, expectedSourceSelectionDigest: "f".repeat(64) }), { code: "CODEX_EXPLICIT_SELECTION_DIGEST_CHANGED" });
  const forged = structuredClone(f.document); forged.claimsHostAuthentication = true;
  await assert.rejects(readCodexLiveProjectSource({ ...f.scope, expectedSourceSelectionDigest: f.save(forged) }), { code: "CODEX_EXPLICIT_SELECTION_INVALID" });
  const outside = structuredClone(f.document); outside.sourceHome.path = path.join(f.base, "not-approved");
  await assert.rejects(readCodexLiveProjectSource({ ...f.scope, expectedSourceSelectionDigest: f.save(outside) }), { code: "CODEX_EXPLICIT_SELECTION_SCOPE_MISMATCH" });
  f.save();
  const outsideCwd = structuredClone(f.document); outsideCwd.members[1].cwd = path.join(f.base, "not-the-authorized-workspace");
  await assert.rejects(readCodexLiveProjectSource({ ...f.scope, expectedSourceSelectionDigest: f.save(outsideCwd) }), { code: "CODEX_EXPLICIT_SELECTION_WORKSPACE_SCOPE_MISMATCH" });
  f.save();
  const denial = Object.assign(new Error("SYNTHETIC current scope denied"), { code: "EACCES" });
  await assert.rejects(readCodexLiveProjectSource({ ...f.scope, assertCurrentAuthority: request => { if (request?.action === "read-explicit-codex-project-selection") throw denial; } }), error => error === denial);
  f.state.db.prepare("UPDATE threads SET project_id=NULL WHERE id=?").run(ids[0]);
  await assert.rejects(readCodexLiveProjectSource(f.scope), { code: "CODEX_EXPLICIT_SELECTION_NATIVE_METADATA_CHANGED" });
  f.state.db.prepare("UPDATE threads SET project_id=? WHERE id=?").run("native-project", ids[0]);
  await assert.rejects(readCodexLiveProjectSource({ ...f.scope, onBoundary: phase => { if (phase === "state-read") fs.appendFileSync(f.selectionFile, " "); } }), { code: "CODEX_EXPLICIT_SELECTION_DIGEST_CHANGED" });
  f.save();
  fs.writeFileSync(f.files[2], encode(frames(ids[2])));
  const createdAfterAbsence = await readCodexLiveProjectSource(f.scope);
  assert.equal(createdAfterAbsence.value.conversations.find(row => row.threadId === ids[2]).reasonCode, "CODEX_EXPLICIT_SELECTION_ABSENCE_CHANGED");
  assert.equal(createdAfterAbsence.value.conversations.find(row => row.threadId === ids[2]).originals.length, 0);
  assert.equal(createdAfterAbsence.value.conversations.find(row => row.threadId === ids[0]).lineage.status, "physical-lineage-ranges-verified");
  fs.unlinkSync(f.files[2]);
  const originalStat = fs.lstatSync; let appearedBetweenStatAndRead = false;
  fs.lstatSync = function(file, ...rest) {
    const result = originalStat.call(this, file, ...rest);
    const caller = new Error().stack.split("\n")[2] ?? "";
    if (file === f.files[2] && result === undefined && caller.includes("codex-live-project-source.mjs")) {
      fs.writeFileSync(f.files[2], encode(frames(ids[2]))); appearedBetweenStatAndRead = true;
    }
    return result;
  };
  let raced; try { raced = await readCodexLiveProjectSource(f.scope); } finally { fs.lstatSync = originalStat; }
  assert.equal(appearedBetweenStatAndRead, true);
  assert.equal(raced.value.conversations.find(row => row.threadId === ids[2]).originals.length, 0);
  assert.equal(raced.value.conversations.find(row => row.threadId === ids[2]).status, "selected-source-unavailable");
  fs.unlinkSync(f.files[2]);
  fs.renameSync(f.files[0], f.files[0] + ".retained"); fs.writeFileSync(f.files[0], encode(frames(ids[0])));
  await assert.rejects(readCodexLiveProjectSource(f.scope), { code: "CODEX_LIVE_ROLLOUT_IDENTITY_CHANGED" });
});

test("explicit ancestor discovery cannot use a same-cwd unselected parent's body", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t), parentRaw = fs.readFileSync(f.files[3]), child = frames(ids[1]);
  for (const frame of child) frame.ordinal += 5;
  child[0].payload.session_id = ids[3]; child[0].payload.history_base = { thread_id: ids[3], end_ordinal_exclusive: 5, end_byte_offset: parentRaw.length };
  fs.writeFileSync(f.files[1], encode(child)); const opened = fs.openSync, read = fs.readSync, close = fs.closeSync, parentFds = new Set(); let lastRead = 0;
  const headerEnd = parentRaw.indexOf(10) + 1;
  fs.openSync = function(file, ...rest) { const fd = opened.call(this, file, ...rest); if (file === f.files[3]) parentFds.add(fd); return fd; };
  fs.readSync = function(fd, buffer, offset, length, position) { if (parentFds.has(fd)) lastRead = Math.max(lastRead, position + length); return read.call(this, fd, buffer, offset, length, position); };
  fs.closeSync = function(fd) { parentFds.delete(fd); return close.call(this, fd); };
  let result; try { result = await readCodexLiveProjectSource(f.scope); } finally { fs.openSync = opened; fs.readSync = read; fs.closeSync = close; }
  assert.equal(result.value.conversations.find(row => row.threadId === ids[1]).lineage.status, "ancestor-header-outside-current-project");
  assert.ok(lastRead <= headerEnd); assert.equal(result.value.conversations.find(row => row.threadId === ids[0]).lineage.status, "physical-lineage-ranges-verified");
  const newlyPresentParent = encode(frames(ids[2])); fs.writeFileSync(f.files[2], newlyPresentParent);
  child[0].payload.session_id = ids[2]; child[0].payload.history_base = { thread_id: ids[2], end_ordinal_exclusive: 5, end_byte_offset: newlyPresentParent.length };
  fs.writeFileSync(f.files[1], encode(child)); let newlyPresentBodyOpens = 0;
  fs.openSync = function(file, ...rest) { if (file === f.files[2]) { newlyPresentBodyOpens++; throw Error("Observed-absent parent adopted through child"); } return opened.call(this, file, ...rest); };
  let absentBasis; try { absentBasis = await readCodexLiveProjectSource(f.scope); } finally { fs.openSync = opened; }
  assert.equal(newlyPresentBodyOpens, 0);
  assert.equal(absentBasis.value.conversations.find(row => row.threadId === ids[1]).lineage.status, "CODEX_EXPLICIT_SELECTION_ABSENCE_CHANGED");
  assert.equal(absentBasis.value.conversations.find(row => row.threadId === ids[2]).reasonCode, "CODEX_EXPLICIT_SELECTION_ABSENCE_CHANGED");
  assert.equal(absentBasis.value.conversations.find(row => row.threadId === ids[0]).lineage.status, "physical-lineage-ranges-verified");
});

test("explicit live capture is the same bounded Core selection through CLI/MCP and retains unavailable/unsupported originals", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t), root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1")), ".."), archives = ["direct", "cli", "mcp"].map(name => path.join(f.base, name));
  for (const archive of archives) fs.mkdirSync(archive);
  const direct = await exportCodexLiveProjectEvidence({ ...f.scope, directory: archives[0] });
  const cli = await runCommand(["project-native-history", archives[1], "--action", "capture-live-project", "--provider", "codex", "--native-home", f.home,
    "--source-project", "app-project", "--source-sync-files", "--source-selection-file", f.selectionFile,
    "--expected-source-selection", f.scope.expectedSourceSelectionDigest, "--source-project-root", f.project], { pluginRoot: root });
  const mcp = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lode_project_native_history", arguments: {
    action: "capture-live-project", provider: "codex", bundle_root: archives[2], native_home: f.home, source_project_id: "app-project", source_sync_files: true,
    source_selection_file: f.selectionFile, expected_source_selection_digest: f.scope.expectedSourceSelectionDigest, source_project_root: f.project } } });
  assert.equal(mcp.error, undefined, JSON.stringify(mcp.error));
  for (const result of [direct, cli, mcp.result.structuredContent]) {
    assert.deepEqual(result.missingSourceIds, [ids[2]]); assert.equal(result.sourceProjectNamespace, "caller-project-reference-not-native-membership");
    assert.equal(result.appMembershipVerifiedByCore, false); assert.equal(result.selectionIsPermission, false);
    assert.deepEqual(result.sources.map(row => row.payloadDigest), direct.sources.map(row => row.payloadDigest));
    assert.equal(result.liveSource.rows.find(row => row.threadId === ids[2]).reasonCode, "CODEX_LIVE_SELECTED_FILE_NOT_FOUND");
  }
  const inspected = inspectPortableProjectEvidence({ directory: archives[0], archiveId: direct.archiveId, expectedArchiveDigest: direct.archiveDigest });
  assert.equal(inspected.manifest.catalog.selectionEvidence.sha256, f.scope.expectedSourceSelectionDigest);
  assert.deepEqual(verifyCodexProjectCatalog(inspected.manifest.catalog).records.map(row => row.project_id), ["native-project", null, null]);
  const catalogFile = path.join(f.base, "captured-explicit-catalog.json"), catalogRaw = Buffer.from(JSON.stringify(inspected.manifest.catalog, null, 2) + "\n"); fs.writeFileSync(catalogFile, catalogRaw);
  fs.writeFileSync(path.join(f.project, "README.md"), "SYNTHETIC independent workspace snapshot");
  const codeOnlyRoot = path.join(f.base, "code-only-archive"); fs.mkdirSync(codeOnlyRoot);
  const codeOnly = exportPortableProjectEvidence({ directory: codeOnlyRoot, catalogFile, expectedCatalogDigest: hash(catalogRaw), workspaceSources: [{ sourceRoot: f.project, paths: ["README.md"] }] });
  assert.equal(codeOnly.workspaceEvidence[0].capturedFiles, 1); assert.equal(codeOnly.sourceProjectNamespace, "caller-project-reference-not-native-membership");
  assert.equal(codeOnly.sources.length, 0); assert.deepEqual(codeOnly.missingSourceIds, ids.slice(0, 3));
  assert.ok(catalogTools.find(tool => tool.name === "lode_project_native_history").inputSchema.properties.source_selection_file);
  const unknown = frames(ids[1], "9.999.0"); fs.writeFileSync(f.files[1], encode(unknown));
  const unsupportedRoot = path.join(f.base, "unsupported"); fs.mkdirSync(unsupportedRoot);
  const unsupported = await exportCodexLiveProjectEvidence({ ...f.scope, directory: unsupportedRoot });
  assert.deepEqual(unsupported.missingSourceIds, [ids[1], ids[2]]);
  assert.equal(unsupported.liveSource.rows.find(row => row.threadId === ids[1]).lineage.status, "CODEX_LINEAGE_SOURCE_PROFILE_UNQUALIFIED");
  assert.equal(unsupported.liveSource.rows.find(row => row.threadId === ids[1]).representation, "partial-live-evidence-only");
  assert.equal(inspectPortableProjectEvidence({ directory: unsupportedRoot, archiveId: unsupported.archiveId, expectedArchiveDigest: unsupported.archiveDigest }).manifest.liveCapture.rows.find(row => row.threadId === ids[1]).originals.length, 1);
  unknown[0].payload.session_id = "invalid-root-session"; fs.writeFileSync(f.files[1], encode(unknown));
  await assert.rejects(readCodexLiveProjectSource(f.scope), { code: "CODEX_LIVE_ROLLOUT_HEADER_INVALID" });
});

test("qualified historical creation versions preserve raw metadata without weakening ordinal/root/hash/cutoff or semantic event checks", t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lode-historical-creation-")); t.after(() => { assert.equal(path.dirname(fs.realpathSync(base)), fs.realpathSync(os.tmpdir())); fs.rmSync(base, { recursive: true, force: true }); });
  for (const [index, version] of CODEX_PAGINATED_CREATION_VERSIONS.entries()) {
    const raw = encode(frames(ids[0], version)), original = { threadId: ids[0], rolloutId: ids[0], raw, sha256: hash(raw) };
    const proof = resolveCodexPhysicalLineage({ originals: [original], rolloutId: ids[0] }); assert.equal(proof.segments[0].creationCliVersion, version);
    const directory = path.join(base, "version-" + index); fs.mkdirSync(directory); archiveCodexCapturedPhysicalSource({ directory, threadId: ids[0], rolloutId: ids[0], originals: [original] });
    const native = inspectCodexCapturedPhysicalSource({ directory }), read = readCodexCapturedPhysicalEvents({ native, threadId: ids[0] });
    assert.equal(read.events.length, 2); assert.equal(read.diagnostics.filter(row => row.blocksPublication).length, 0);
    assert.ok(native.originals[0].raw.equals(raw));
    const bad = { ...original, sha256: "f".repeat(64) }; assert.throws(() => resolveCodexPhysicalLineage({ originals: [bad], rolloutId: ids[0] }), { code: "CODEX_LINEAGE_ORIGINAL_DIGEST_MISMATCH" });
    for (const changed of [{ id: ids[1] }, { session_id: "invalid-root-session" }]) {
      const altered = frames(ids[0], version); Object.assign(altered[0].payload, changed); const alteredRaw = encode(altered);
      assert.throws(() => resolveCodexPhysicalLineage({ originals: [{ ...original, raw: alteredRaw, sha256: hash(alteredRaw) }], rolloutId: ids[0] }), { code: "CODEX_LINEAGE_HEADER_MISMATCH" });
    }
    const brokenFrames = frames(ids[0], version); brokenFrames[2].ordinal = 3; const brokenRaw = encode(brokenFrames);
    assert.throws(() => resolveCodexPhysicalLineage({ originals: [{ ...original, raw: brokenRaw, sha256: hash(brokenRaw) }], rolloutId: ids[0] }), { code: "CODEX_LINEAGE_ORDINAL_MISMATCH" });
  }
  const unknownRaw = encode(frames(ids[0], "9.999.0")); assert.throws(() => resolveCodexPhysicalLineage({ originals: [{ threadId: ids[0], rolloutId: ids[0], raw: unknownRaw, sha256: hash(unknownRaw) }], rolloutId: ids[0] }), { code: "CODEX_LINEAGE_SOURCE_PROFILE_UNQUALIFIED" });
  const parentRaw = encode(frames(ids[0], CODEX_PAGINATED_CREATION_VERSIONS[0])), parent = { threadId: ids[0], rolloutId: ids[0], raw: parentRaw, sha256: hash(parentRaw) };
  const childFrames = frames(ids[1], CODEX_PAGINATED_CREATION_VERSIONS[1]); for (const frame of childFrames) frame.ordinal += 5;
  childFrames[0].payload.history_base = { thread_id: ids[0], end_ordinal_exclusive: 5, end_byte_offset: parentRaw.length };
  const childRaw = encode(childFrames), child = { threadId: ids[1], rolloutId: ids[1], raw: childRaw, sha256: hash(childRaw) };
  assert.throws(() => resolveCodexPhysicalLineage({ originals: [parent, child], rolloutId: ids[1] }), { code: "CODEX_LINEAGE_ROOT_SESSION_MISMATCH" });
  childFrames[0].payload.session_id = ids[0]; childFrames[0].payload.history_base.end_byte_offset--;
  const cutoffRaw = encode(childFrames); assert.throws(() => resolveCodexPhysicalLineage({ originals: [parent, { ...child, raw: cutoffRaw, sha256: hash(cutoffRaw) }], rolloutId: ids[1] }), { code: "CODEX_LINEAGE_CUTOFF_MISMATCH" });
  const unsupportedFrames = frames(ids[0], CODEX_PAGINATED_CREATION_VERSIONS[0]); unsupportedFrames[3] = { ordinal: 3, type: "event_msg", payload: { type: "unknown-semantic-record" } };
  const unsupportedRaw = encode(unsupportedFrames), directory = path.join(base, "unsupported-event"); fs.mkdirSync(directory); archiveCodexCapturedPhysicalSource({ directory, threadId: ids[0], rolloutId: ids[0], originals: [{ ...parent, raw: unsupportedRaw, sha256: hash(unsupportedRaw) }] });
  const native = inspectCodexCapturedPhysicalSource({ directory }), read = readCodexCapturedPhysicalEvents({ native, threadId: ids[0] });
  assert.ok(read.diagnostics.some(row => row.blocksPublication));
  assert.equal(encodeClaudeDerived({ events: read.events, diagnostics: read.diagnostics, targetId: ids[1], cwd: base, createdAt: "2026-11-06T00:00:00Z" }).publicationReady, false);
});

test("explicit user fork permits a new root only at the exact captured parent and cutoff, without parent future or sibling leakage", t => {
  const parentFrames = frames(ids[0]), parentPrefix = encode(parentFrames);
  parentFrames.push({ ordinal: 5, type: "event_msg", payload: { type: "task_started", turn_id: "PARENT_FUTURE" } });
  const original = (threadId, rolloutId, rows) => { const raw = encode(rows); return { threadId, rolloutId, raw, sha256: hash(raw) }; };
  const parent = original(ids[0], ids[0], parentFrames);
  const branch = frames(ids[1]); for (const row of branch) row.ordinal += 5;
  Object.assign(branch[0].payload, { forked_from_id: ids[0], forked_from_ordinal_exclusive: 5,
    history_base: { thread_id: ids[0], end_ordinal_exclusive: 5, end_byte_offset: parentPrefix.length } });
  const child = original(ids[1], ids[1], branch), sibling = original(ids[2], ids[2], frames(ids[2]));
  const before = [parent, child, sibling].map(row => hash(row.raw));
  const proof = resolveCodexPhysicalLineage({ originals: [parent, child, sibling], rolloutId: ids[1] });
  assert.equal(proof.rootSessionId, ids[1]); assert.deepEqual(proof.segments.map(row => row.rootSessionId), [ids[0], ids[1]]);
  assert.equal(proof.frames.some(row => row.document.payload.turn_id === "PARENT_FUTURE"), false);
  assert.equal(proof.frames.some(row => row.source.threadId === ids[2]), false);
  assert.deepEqual([parent, child, sibling].map(row => hash(row.raw)), before);
  for (const change of [{ forked_from_id: null }, { forked_from_id: ids[2] }, { forked_from_ordinal_exclusive: 4 }, { session_id: ids[2] }]) {
    const bad = structuredClone(branch); Object.assign(bad[0].payload, change);
    assert.throws(() => resolveCodexPhysicalLineage({ originals: [parent, original(ids[1], ids[1], bad)], rolloutId: ids[1] }), { code: "CODEX_LINEAGE_ROOT_SESSION_MISMATCH" });
  }
  const cutoff = structuredClone(branch); cutoff[0].payload.history_base.end_byte_offset--;
  assert.throws(() => resolveCodexPhysicalLineage({ originals: [parent, original(ids[1], ids[1], cutoff)], rolloutId: ids[1] }), { code: "CODEX_LINEAGE_CUTOFF_MISMATCH" });
  const continuation = frames(ids[1]); for (const row of continuation) row.ordinal += 10;
  continuation[0].payload.history_base = { thread_id: ids[1], end_ordinal_exclusive: 10, end_byte_offset: child.raw.length };
  const latest = original(ids[1], ids[3], continuation);
  assert.deepEqual(resolveCodexPhysicalLineage({ originals: [parent, child, latest], rolloutId: ids[3] }).segments.map(row => row.rootSessionId), [ids[0], ids[1], ids[1]]);
  const badContinuation = structuredClone(continuation); badContinuation[0].payload.session_id = ids[2];
  Object.assign(badContinuation[0].payload, { forked_from_id: ids[1], forked_from_ordinal_exclusive: 10 });
  assert.throws(() => resolveCodexPhysicalLineage({ originals: [parent, child, original(ids[1], ids[3], badContinuation)], rolloutId: ids[3] }), { code: "CODEX_LINEAGE_ROOT_SESSION_MISMATCH" });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lode-explicit-fork-root-"));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(base)), fs.realpathSync(os.tmpdir())); fs.rmSync(base, { recursive: true, force: true }); });
  archiveCodexCapturedPhysicalSource({ directory: base, threadId: ids[1], rolloutId: ids[1], originals: [parent, child] });
  const native = inspectCodexCapturedPhysicalSource({ directory: base }), read = readCodexCapturedPhysicalEvents({ native, threadId: ids[1] });
  assert.ok(native.originals.find(row => row.threadId === ids[0]).raw.equals(parentPrefix));
  assert.ok(native.originals.find(row => row.threadId === ids[1]).raw.equals(child.raw));
  assert.deepEqual([parent, child, sibling].map(row => hash(row.raw)), before);
  assert.ok(read.events.every(row => row.source));
  assert.equal(read.events.some(row => JSON.stringify(row).includes("PARENT_FUTURE")), false);
});
