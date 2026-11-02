import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { captureProviderNativeHistory, inspectProviderNativePayload } from "../scripts/lib/provider-native-history-payload.mjs";
import { inspectClaudeHistoryOriginal, inspectOpenCodeHistoryOriginal, deriveOpenCodeHistoryImport } from "../scripts/lib/provider-native-history-format.mjs";
import { fixture as coreFixture, snapshot } from "./helpers/session-work-linkage-fixture.mjs";
import { exportProjectBundle } from "../scripts/lib/project-portability.mjs";
import { attachProjectNativeTransfer, readProjectNativeTransfer, projectNativeTransferSummary } from "../scripts/lib/project-native-transfer.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { operateProjectNativeHistory } from "../scripts/lib/project-native-history.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { syntheticNativeCapture } from "./helpers/native-portability-fixture.mjs";

const uuid = "11111111-2222-4333-8444-555555555555";
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-provider-native-")));
  t.after(() => { assert.equal(path.dirname(base), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(base).startsWith("lode-provider-native-")); fs.rmSync(base, { recursive: true, force: true }); });
  const source = path.join(base, "source"); fs.mkdirSync(source);
  return { base, source, destination: path.join(base, "payload") };
}
const exportData = (session = "ses_source", msg = "msg_one", part = "prt_one") => ({
  info: { id: session, title: "Synthetic history", directory: "C:/old/project", projectID: "old-project", version: "1.19.5", slug: "synthetic", time: { created: 1, updated: 2 },
    permission: [{ permission: "*", pattern: "*", action: "allow" }], model: { id: "old-model", providerID: "old-provider" }, agent: "old-agent", revert: { messageID: msg }, metadata: { note: "raw historical session metadata" } },
  messages: [{ info: { id: msg, sessionID: session, role: "user", time: { created: 1 }, model: { providerID: "historical-provider", modelID: "historical-model" }, agent: "historical-agent" },
    parts: [{ id: part, sessionID: session, messageID: msg, type: "text", text: "synthetic original message" }] }],
});

test("Claude selected JSONL raw bytes and companions are immutable evidence, not actual SDK qualification", t => {
  const f = fixture(t), raw = Buffer.from(JSON.stringify({ type: "user", uuid: "message_one", parentUuid: null, sessionId: uuid, message: { role: "user", content: "synthetic text" } }) + "\n");
  fs.writeFileSync(path.join(f.source, uuid + ".jsonl"), raw); fs.writeFileSync(path.join(f.source, "companion.bin"), Buffer.from([0, 1, 2]));
  const capture = () => captureProviderNativeHistory({ provider: "claude", sourceDirectory: f.source, nativeIds: [uuid], reportedClientVersion: "2.1.223",
    files: [{ nativeId: uuid, role: "conversation", path: uuid + ".jsonl" }, { nativeId: uuid, role: "companion", path: "companion.bin" }], destination: f.destination });
  const result = capture(), again = capture();
  assert.equal(result.payloadId, again.payloadId); assert.equal(result.mechanicalOriginalsReady, true);
  assert.equal(result.nativeClientVisibility, "not-observed"); assert.equal(result.continuationReady, false);
  assert.equal(result.payload.sourceConfiguration, "not-automatically-collected");
  assert.equal(result.payload.credentialRedaction, "not-performed");
  assert.equal(Object.hasOwn(result.payload, "credentials"), false);
  assert.deepEqual(fs.readFileSync(path.join(f.destination, "objects", crypto.createHash("sha256").update(raw).digest("hex") + ".bin")), raw);
  assert.throws(() => inspectProviderNativePayload({ directory: f.destination, expectedProvider: "opencode" }), { code: "NATIVE_HISTORY_SAME_PLATFORM_REQUIRED" });
});

test("OpenCode derived import separates active settings while preserving every historical message and source byte", () => {
  const data = exportData(), raw = Buffer.from(JSON.stringify(data));
  const result = deriveOpenCodeHistoryImport(raw, { nativeId: data.info.id }), imported = JSON.parse(result.bytes);
  assert.deepEqual(imported.messages, data.messages); assert.deepEqual(imported.info.metadata, data.info.metadata);
  for (const key of ["permission", "model", "agent", "revert"]) assert.equal(Object.hasOwn(imported.info, key), false);
  assert.equal(result.sourceSha256, crypto.createHash("sha256").update(raw).digest("hex"));
  assert.notEqual(result.sourceSha256, result.importSha256);
  assert.equal(result.targetExecutionSettingsVerified, false); assert.equal(result.continuationReady, false);
  assert.match(result.runtimeCaveat, /historical/);
});

test("Claude selection requires a message ID witness, preserves fork ancestors and discloses unresolved mixed rows", t => {
  const f = fixture(t), other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const row = (id, sessionId, parentUuid = null) => ({ type: "user", uuid: id, parentUuid, ...(sessionId ? { sessionId } : {}), message: { role: "user", content: "Synthetic identity evidence" } });
  const encode = rows => Buffer.from(rows.map(value => JSON.stringify(value)).join("\n") + "\n");
  const wrong = encode([row("message_b", other)]);
  assert.throws(() => inspectClaudeHistoryOriginal(wrong, uuid), { code: "NATIVE_CLAUDE_SELECTED_SESSION_NOT_OBSERVED" });
  assert.throws(() => inspectClaudeHistoryOriginal(encode([row("unknown", null)]), uuid), { code: "NATIVE_CLAUDE_MESSAGE_SESSION_IDENTITY_MISSING" });
  assert.throws(() => inspectClaudeHistoryOriginal(encode([{ type: "summary", sessionId: uuid }, row("message_b", other)]), uuid), { code: "NATIVE_CLAUDE_SELECTED_SESSION_NOT_OBSERVED" });
  fs.writeFileSync(path.join(f.source, "wrong.jsonl"), wrong);
  const args = { provider: "claude", sourceDirectory: f.source, nativeIds: [uuid], reportedClientVersion: "2.1.223", destination: f.destination };
  assert.throws(() => captureProviderNativeHistory({ ...args, files: [{ path: "wrong.jsonl", nativeId: uuid, role: "conversation" }] }), { code: "NATIVE_CLAUDE_SELECTED_SESSION_NOT_OBSERVED" });
  assert.equal(fs.existsSync(f.destination), false);
  const fork = encode([row("ancestor_b", other), row("selected_a", uuid, "ancestor_b")]);
  fs.writeFileSync(path.join(f.source, "fork.jsonl"), fork);
  const preserved = captureProviderNativeHistory({ ...args, files: [{ path: "fork.jsonl", nativeId: uuid, role: "conversation" }] });
  const evidence = preserved.payload.coverage[0];
  assert.equal(evidence.selectedIdentityEvidence, "selected-id-observed-in-message-record");
  assert.equal(evidence.selectedMessageCount, 1); assert.equal(evidence.foreignSessionMessageCount, 1);
  assert.equal(evidence.foreignRowsOutsideSelectedAncestry, 0); assert.equal(evidence.officialNativeOwnershipVerified, false);
  assert.deepEqual(fs.readFileSync(path.join(f.destination, "objects", crypto.createHash("sha256").update(fork).digest("hex") + ".bin")), fork);
  const mixed = inspectClaudeHistoryOriginal(encode([row("selected_a", uuid), row("detached_b", other)]), uuid);
  assert.equal(mixed.foreignRowsOutsideSelectedAncestry, 1); assert.equal(mixed.officialNativeOwnershipVerified, false);
});

test("OpenCode coverage distinguishes an included session parent from missing message ancestry", t => {
  const f = fixture(t), child = exportData("ses_child", "msg_child", "prt_child"), parent = exportData("ses_parent", "msg_parent", "prt_parent");
  child.info.parentID = parent.info.id;
  fs.writeFileSync(path.join(f.source, "child.json"), JSON.stringify(child));
  fs.writeFileSync(path.join(f.source, "parent.json"), JSON.stringify(parent));
  const args = { provider: "opencode", sourceDirectory: f.source, reportedClientVersion: "1.19.5" };
  const rootFile = (name, data) => ({ path: name + ".json", nativeId: data.info.id, role: "conversation" });
  const both = captureProviderNativeHistory({ ...args, nativeIds: [child.info.id, parent.info.id],
    files: [rootFile("child", child), rootFile("parent", parent)], destination: f.destination });
  const childCoverage = both.payload.coverage.find(row => row.nativeId === child.info.id);
  assert.equal(childCoverage.nativeParentIncludedInSelection, true);
  assert.equal(childCoverage.missingMessageParentCount, 0);
  assert.equal(both.payload.coverage.find(row => row.nativeId === parent.info.id).nativeParentIncludedInSelection, null);
  const alone = captureProviderNativeHistory({ ...args, nativeIds: [child.info.id], files: [rootFile("child", child)],
    destination: path.join(f.base, "child-only") });
  assert.equal(alone.payload.coverage[0].nativeParentIncludedInSelection, false);
  assert.equal(alone.payload.coverage[0].nativeParentId, parent.info.id);
  assert.equal(alone.nativePublicationReady, false);
});

test("OpenCode late invalid owner, duplicate global IDs and broken Claude chains reject before publishing", t => {
  const f = fixture(t), first = exportData(), second = exportData("ses_other");
  fs.writeFileSync(path.join(f.source, "first.json"), JSON.stringify(first)); fs.writeFileSync(path.join(f.source, "second.json"), JSON.stringify(second));
  assert.throws(() => captureProviderNativeHistory({ provider: "opencode", sourceDirectory: f.source, nativeIds: ["ses_source", "ses_other"], reportedClientVersion: "1.19.5",
    files: [{ path: "first.json", nativeId: "ses_source", role: "conversation" }, { path: "second.json", nativeId: "ses_other", role: "conversation" }], destination: f.destination }), { code: "NATIVE_OPENCODE_GLOBAL_MESSAGE_COLLISION" });
  assert.equal(fs.existsSync(f.destination), false);
  const invalid = exportData(); invalid.messages[0].parts[0].sessionID = "ses_other";
  assert.throws(() => inspectOpenCodeHistoryOriginal(Buffer.from(JSON.stringify(invalid)), "ses_source"), { code: "NATIVE_OPENCODE_PART_OWNER_INVALID" });
  const cycle = ["a", "b"].map((uuid, index) => JSON.stringify({ type: "user", uuid, parentUuid: index ? "a" : "b", message: { role: "user", content: "x" } })).join("\n");
  assert.throws(() => inspectClaudeHistoryOriginal(Buffer.from(cycle), uuid), { code: "NATIVE_CLAUDE_PARENT_CYCLE" });
});

test("cancellation and unsafe original paths cannot publish a native payload or touch outside data", t => {
  const f = fixture(t), controller = new AbortController(); controller.abort();
  const args = { provider: "opencode", sourceDirectory: f.source, nativeIds: ["ses_source"], reportedClientVersion: "1.19.5", destination: f.destination,
    files: [{ path: "../outside.json", nativeId: "ses_source", role: "conversation" }] };
  assert.throws(() => captureProviderNativeHistory({ ...args, signal: controller.signal }), { code: "NATIVE_HISTORY_CAPTURE_CANCELLED" });
  assert.throws(() => captureProviderNativeHistory(args), { code: "PROJECT_COPY_PATH_INVALID" });
  assert.equal(fs.existsSync(f.destination), false);
});

test("existing common bundle and typed reader inspect a same-platform raw companion without native startup", async t => {
  const f = coreFixture(t), source = path.join(f.base, "exports"), payload = path.join(f.base, "native-payload"), bundle = path.join(f.base, "bundle");
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, "session.json"), JSON.stringify(exportData()));
  captureProviderNativeHistory({ provider: "opencode", sourceDirectory: source, nativeIds: ["ses_source"], reportedClientVersion: "1.19.5",
    files: [{ nativeId: "ses_source", role: "conversation", path: "session.json" }], destination: payload });
  f.route(() => exportProjectBundle({ root: f.root, destination: bundle }));
  const before = snapshot(bundle), originals = snapshot(f.root);
  assert.throws(() => attachProjectNativeTransfer({ provider: "claude", bundleRoot: bundle, directory: payload }), { code: "NATIVE_HISTORY_SAME_PLATFORM_REQUIRED" });
  assert.deepEqual(snapshot(bundle), before);
  const attached = attachProjectNativeTransfer({ provider: "opencode", bundleRoot: bundle, directory: payload });
  assert.equal(attached.status, "verified-native-raw-transfer");
  const read = projectNativeTransferSummary(readProjectNativeTransfer({ bundleRoot: bundle }));
  assert.equal(read.native.provider, "opencode"); assert.equal(read.native.nativeClientVisibility, "not-observed");
  assert.equal(read.native.continuationReady, false);
  assert.equal(read.native.credentialRedaction, "not-performed");
  const response = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "head_project_bundle_read", arguments: { bundle_root: bundle, include_native_history: true } } });
  assert.equal(response.result.structuredContent.nativeHistory.native.provider, "opencode");
  assert.equal(response.result.structuredContent.handoff.status, "verified-generated-handoff");
  assert.deepEqual(snapshot(f.root), originals);
});

test("Claude/OpenCode public operational calls never enter the Codex home/probe/publication/registration path", async t => {
  for (const provider of ["claude", "opencode"]) await t.test(provider, async t => {
    const f = coreFixture(t), source = path.join(f.base, "exports"), payload = path.join(f.base, "payload"), bundle = path.join(f.base, "bundle");
    fs.mkdirSync(source);
    const nativeId = provider === "claude" ? uuid : "ses_source", filename = provider === "claude" ? "thread.jsonl" : "session.json";
    const claudeRows = [
      { uuid: "ancestor", sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", parentUuid: null },
      { uuid: "msg_selected", sessionId: uuid, parentUuid: "ancestor" },
      { uuid: "foreign_sibling", sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", parentUuid: null },
      { uuid: "missing_session", parentUuid: null },
    ].map(value => ({ type: "user", ...value, message: { role: "user", content: "synthetic only" } }));
    const raw = provider === "claude" ? claudeRows.map(row => JSON.stringify(row)).join("\n") + "\n" : JSON.stringify(exportData());
    fs.writeFileSync(path.join(source, filename), raw);
    captureProviderNativeHistory({ provider, sourceDirectory: source, nativeIds: [nativeId], reportedClientVersion: provider === "claude" ? "2.1.223" : "1.19.5",
      files: [{ nativeId, role: "conversation", path: filename }], destination: payload });
    f.route(() => exportProjectBundle({ root: f.root, destination: bundle }));
    attachProjectNativeTransfer({ provider, bundleRoot: bundle, directory: payload });
    const typedRead = await dispatch({ jsonrpc: "2.0", id: "read", method: "tools/call", params: { name: "head_project_native_history", arguments: { action: "read", bundle_root: bundle } } });
    assert.equal(typedRead.error, undefined);
    if (provider === "claude") {
      const coverage = typedRead.result.structuredContent.native.coverage[0];
      assert.equal(coverage.selectedMessageCount, 1);
      assert.equal(coverage.foreignSessionMessageCount, 2);
      assert.equal(coverage.foreignRowsOutsideSelectedAncestry, 1);
      assert.equal(coverage.messageRowsWithoutSessionId, 1);
      assert.equal(coverage.officialNativeOwnershipVerified, false);
      assert.equal(typedRead.result.structuredContent.native.nativePublicationReady, false);
    }
    const target = path.join(f.base, "must-not-observe-native-home"), executable = path.join(target, "must-not-start.exe"), before = snapshot(f.base);
    let touched = 0, processes = 0;
    const methods = ["realpathSync", "lstatSync", "readdirSync", "mkdirSync", "openSync"];
    for (const name of methods) {
      const original = fs[name];
      t.mock.method(fs, name, function(file, ...args) {
        if (String(file).startsWith(target)) { touched++; throw Object.assign(Error("Refused native target access in guard fixture"), { code: "FIXTURE_NATIVE_TARGET_TOUCHED" }); }
        return original.call(this, file, ...args);
      });
    }
    for (const action of ["restore", "register"]) {
      const result = await operateProjectNativeHistory({ action, bundleRoot: bundle, nativeHome: target, executable, onProcess() { processes++; } });
      assert.equal(result.reasonCode, provider === "opencode" ? "NATIVE_OPENCODE_BOOTSTRAP_UNQUALIFIED" : "NATIVE_HISTORY_PROVIDER_CAPABILITY_UNAVAILABLE");
      assert.equal(result.provider, provider); assert.equal(result.nativeHomeInspected, false);
      const cli = await runCommand(["project-native-history", bundle, "--action", action, "--native-home", target, "--executable", executable]);
      assert.equal(cli.sdkLifecycleRequestedThisCall, false);
      const response = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "head_project_native_history", arguments: {
        action, bundle_root: bundle, provider, native_home: target, executable } } });
      assert.equal(response.result.structuredContent.reasonCode, provider === "opencode" ? "NATIVE_OPENCODE_BOOTSTRAP_UNQUALIFIED" : "NATIVE_HISTORY_PROVIDER_CAPABILITY_UNAVAILABLE");
    }
    await assert.rejects(() => operateProjectNativeHistory({ action: "restore", bundleRoot: bundle, provider: "codex", nativeHome: target, executable }), { code: "NATIVE_HISTORY_SAME_PLATFORM_REQUIRED" });
    await assert.rejects(() => operateProjectNativeHistory({ action: "capture", bundleRoot: bundle, nativeHome: target, executable, threadIds: [uuid] }), { code: "NATIVE_HISTORY_PROVIDER_REQUIRED" });
    const capture = await operateProjectNativeHistory({ action: "capture", bundleRoot: bundle, provider, nativeHome: target, executable, threadIds: [nativeId] });
    assert.equal(capture.sdkLifecycleRequestedThisCall, false);
    assert.equal(touched, 0); assert.equal(processes, 0); assert.deepEqual(snapshot(f.base), before);
  });
});

test("Codex public routing retains verified legacy-link reads and reaches its own overlap guard for each effect", async t => {
  if (process.platform !== "win32" || process.arch !== "x64") return t.skip("Measured native filesystem profile is Windows x64.");
  const { f, destination, executable, payload } = await syntheticNativeCapture(t);
  const bundle = path.join(f.base, "codex-public-routing");
  f.route(() => exportProjectBundle({ root: f.root, destination: bundle }));
  attachProjectNativeTransfer({ bundleRoot: bundle, directory: destination });
  const nativeHome = path.join(bundle, "overlap-home"); fs.mkdirSync(nativeHome);
  const before = snapshot(f.base);
  const unrelatedHost = { provider: "claude", evidenceKind: "synthetic-test", async version() { assert.fail("An unrelated Host must not be used by Codex"); } };
  const read = await operateProjectNativeHistory({ action: "read", bundleRoot: bundle });
  assert.equal(read.status, "verified-native-transfer");
  assert.equal(read.native.payloadId, readProjectNativeTransfer({ bundleRoot: bundle }).native.payloadId);
  for (const action of ["capture", "restore", "register"]) {
    const args = { action, bundleRoot: bundle, nativeHome, executable,
      ...(action === "capture" ? { provider: "codex", threadIds: payload.threadIds } : {}),
      ...(action === "register" ? { root: f.root } : {}) };
    await assert.rejects(() => operateProjectNativeHistory({ ...args, nativeHistoryHost: unrelatedHost }), { code: "PROJECT_NATIVE_SOURCE_TARGET_OVERLAP" });
    const cli = ["project-native-history", bundle, "--action", action, "--native-home", nativeHome, "--executable", executable,
      ...(action === "capture" ? ["--provider", "codex", "--threads", payload.threadIds.join(",")] : []),
      ...(action === "register" ? ["--runtime-root", f.root] : [])];
    await assert.rejects(() => runCommand(cli, { nativeHistoryHost: unrelatedHost }), { code: "PROJECT_NATIVE_SOURCE_TARGET_OVERLAP" });
    const response = await dispatch({ jsonrpc: "2.0", id: action, method: "tools/call", params: { name: "head_project_native_history", arguments: {
      action, bundle_root: bundle, native_home: nativeHome, executable,
      ...(action === "capture" ? { provider: "codex", thread_ids: payload.threadIds } : {}),
      ...(action === "register" ? { runtime_root: f.root } : {}) } } }, { nativeHistoryHost: unrelatedHost });
    assert.ok(response.error);
    assert.match(response.error.message, /PROJECT_NATIVE_SOURCE_TARGET_OVERLAP/);
  }
  assert.deepEqual(snapshot(f.base), before);
});
