import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { Worker } from "node:worker_threads";
import { derivedFixture, completionProjectionFixture, sourceThread, branchThread, png, damagedPng } from "./helpers/derived-history-fixture.mjs";
import { snapshot, pluginRoot } from "./helpers/session-work-linkage-fixture.mjs";
import { operateProjectNativeHistory } from "../scripts/lib/project-native-history.mjs";
import { inspectProjectNativeDerivation, derivePortableProjectNativeHistory, inspectPortableProjectNativeDerivation,
  prepareProjectNativeHistory, deriveProjectNativeHistory, projectNativeDerivationSummary } from "../scripts/lib/project-native-derivation.mjs";
import { publishClaudeDerived, openClaudeDerived, publishClaudeDerivedWithDestinationJournal, verifyClaudeDerived } from "../scripts/lib/claude-derived-publication.mjs";
import { readProjectNativeTransfer } from "../scripts/lib/project-native-transfer.mjs";
import { readProjectDirection } from "../scripts/lib/project-direction.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { dispatch, catalogTools } from "../scripts/mcp-server.mjs";
import { compareClaudeDerivedReader, CLAUDE_LOCAL_COMMAND_CAVEAT } from "../scripts/lib/claude-derived-reader-coverage.mjs";
import { inspectDerivedInlineImage } from "../scripts/lib/derived-inline-image.mjs";
import { inspectDerivedBaselineJpeg } from "../scripts/lib/derived-baseline-jpeg.mjs";
import { readCodexHybridPhysical, encodeCodexHybrid, CODEX_HYBRID_CONVERTER, CODEX_HYBRID_IMAGE_CONVERTER, CODEX_HYBRID_TEXT_CONVERTER } from "../scripts/lib/codex-claude-hybrid.mjs";
import { historyHash, releaseHistoryBytes } from "../scripts/lib/native-history-bytes.mjs";
import { resolveCodexPhysicalLineage } from "../scripts/lib/codex-physical-lineage.mjs";
import { encodeClaudeDerived } from "../scripts/lib/claude-derived-encoder.mjs";
import { DatabaseSync } from "node:sqlite";
import { prepareCodexNativeOffline } from "../scripts/lib/codex-native-offline.mjs";
import { captureSyntheticHistory } from "./helpers/derived-history-fixture.mjs";
import { inspectCodexNativePayload, codexNativePayloadSummary } from "../scripts/lib/codex-native-payload.mjs";
import { nativeProfile, syntheticNativeDatabase } from "./helpers/native-portability-fixture.mjs";
import { prepareProjectWorkspaceTransfer, applyProjectWorkspaceTransfer } from "../scripts/lib/project-workspace-transfer.mjs";
import { parseCodexSourceJson } from "../scripts/lib/codex-source-json.mjs";
import { deriveProjectConversationCollection, readProjectConversationCollection } from "../scripts/lib/project-conversation-collection.mjs";
import { withSessionRoute } from "../scripts/lib/session-routing.mjs";
import { readRecoveryCheckpoint } from "../scripts/lib/compaction-recovery.mjs";
import { archiveCodexCapturedPhysicalSource, inspectCodexCapturedPhysicalSource, encodeCodexObservedLivePhysicalSource, encodeCodexObservedLivePhysicalSources } from "../scripts/lib/codex-captured-physical-source.mjs";
import { readSelectedCodexStateEvidence } from "../scripts/lib/codex-native-state-evidence.mjs";
import { readCodexProjectCatalog } from "../scripts/lib/codex-project-catalog.mjs";
import { exportPortableProjectEvidence, inspectPortableProjectEvidence, readPortableProjectEvidence, materializePortableProjectSessionBundle, exportCodexLiveProjectEvidence } from "../scripts/lib/portable-project-evidence.mjs";
import { admitDestinationImportTarget, openDestinationImportTarget, reserveDestinationImportEffect, readDestinationImportEffect, executeDestinationImportEffect, consumeDestinationNativeWriteCapability } from "../scripts/lib/destination-import-journal.mjs";
import { nativeRoot } from "../scripts/lib/provider-native-history-host.mjs";
import { codexSourcePathKey } from "../scripts/lib/codex-explicit-project-selection.mjs";
import { openCodexLiveReadGuard, withLiveCodexReadSnapshots, codexLiveReadGuardProcessStatus, CODEX_LIVE_GUARD_SCRIPT_SHA256 } from "../scripts/lib/codex-live-read-guard.mjs";
import { readCodexLiveProjectSource } from "../scripts/lib/codex-live-project-source.mjs";
import { createLocalDestinationImportHost } from "../scripts/lib/local-destination-import-host.mjs";

// Qualified Hosts exercise production capture; other Hosts prove its rejection
// and consume verified retained-source inputs through production readers.
test("project catalog selection preserves all/subset membership through qualified capture or verified synthetic retained evidence", async t => {
  const f = await derivedFixture(t), sourceHome = path.join(f.f.base, "source-home");
  const state = new DatabaseSync(path.join(sourceHome, "state_5.sqlite"));
  const foreignId = "01900000-0000-7000-8000-000000000099";
  try {
    const insert = state.prepare("INSERT INTO projects(id,name,metadata,position,created_at_ms,updated_at_ms) VALUES(?,?,?,0,0,0)");
    insert.run("p-a", "Same title", '{"root":"X:/shared","private":"UNSELECTED_METADATA_SENTINEL"}');
    insert.run("p-b", "OTHER_PROJECT_NAME_SENTINEL", '{"root":"X:/shared"}');
    insert.run("p-empty", "Empty project", "{}");
    state.prepare("UPDATE threads SET project_id='p-a',cwd=?").run("X:/shared");
    state.prepare("UPDATE threads SET archived=1,cwd=? WHERE id=?").run("X:/worktree", branchThread);
    state.prepare("UPDATE threads SET first_user_message=?,preview=?,title=?,sandbox_policy=?,git_origin_url=? WHERE id=?")
      .run("UNSELECTED_FIRST_MESSAGE_SENTINEL", "UNSELECTED_PREVIEW_SENTINEL", "UNSELECTED_TITLE_SENTINEL", "UNSELECTED_POLICY_SENTINEL", "UNSELECTED_REMOTE_SENTINEL", branchThread);
    const columns = nativeProfile.databases.find(db => db.file === "state_5.sqlite").tables.find(table => table.name === "threads").columns;
    state.prepare("INSERT INTO threads SELECT " + columns.map(column => column.name === "id" || column.name === "project_id" ? "?" : '"' + column.name + '"').join(",") + " FROM threads WHERE id=?")
      .run(...columns.filter(column => column.name === "id" || column.name === "project_id").map(column => column.name === "id" ? foreignId : "p-b"), sourceThread);
  } finally { state.close(); }
  const offline = await prepareCodexNativeOffline({ home: sourceHome, executable: path.join(f.f.base, "codex.exe"),
    probe: async () => ({ status: "observed", rows: [] }), versionProbe: async () => ({ status: "verified", version: nativeProfile.engineVersion }) });
  const originals = snapshot(sourceHome);
  const all = await captureSyntheticHistory({ witness: offline.witness, sourceProjectId: "p-a", destination: path.join(f.f.base, "project-all") });
  assert.equal(all.threadCount, 2); assert.equal(all.projectSelection, "all-observed-native-project-threads");
  const inspected = inspectCodexNativePayload({ directory: all.directory });
  assert.deepEqual(inspected.payload.threadIds, [sourceThread, branchThread]);
  assert.equal(codexNativePayloadSummary(inspected).projectInventoryCoverage.hostInventory, "not-observed");
  assert.equal(inspected.payload.projectCatalog.membershipEvidence.rows.length, 2);
  const subset = await captureSyntheticHistory({ witness: offline.witness, sourceProjectId: "p-a", threadIds: [sourceThread], destination: path.join(f.f.base, "project-subset") });
  assert.equal(subset.projectSelection, "explicit-subset");
  const subsetManifestBytes = fs.readFileSync(path.join(subset.directory, "manifest.json"));
  for (const sentinel of ["UNSELECTED_FIRST_MESSAGE_SENTINEL", "UNSELECTED_PREVIEW_SENTINEL", "UNSELECTED_TITLE_SENTINEL", "UNSELECTED_POLICY_SENTINEL", "UNSELECTED_REMOTE_SENTINEL", "UNSELECTED_METADATA_SENTINEL", "OTHER_PROJECT_NAME_SENTINEL"])
    assert.ok(!subsetManifestBytes.includes(Buffer.from(sentinel)), sentinel + " leaked outside the selection");
  assert.equal(JSON.parse(fs.readFileSync(path.join(all.directory, "manifest.json"))).stateEvidence.rows
    .some(row => row.some(cell => cell?.value === "UNSELECTED_FIRST_MESSAGE_SENTINEL")), true);
  assert.equal(codexNativePayloadSummary(inspectCodexNativePayload({ directory: subset.directory })).projectCatalogThreadCount, 2);
  const emptyDestination = path.join(f.f.base, "empty-capture");
  await assert.rejects(captureSyntheticHistory({ witness: offline.witness, sourceProjectId: "p-empty", destination: emptyDestination }), { code: "NATIVE_CODEX_PROJECT_HAS_NO_THREADS" });
  assert.equal(fs.existsSync(emptyDestination), false);
  const tampered = path.join(f.f.base, "tampered-project-capture"); fs.cpSync(subset.directory, tampered, { recursive: true });
  const payloadFile = path.join(tampered, "manifest.json"), altered = JSON.parse(fs.readFileSync(payloadFile));
  const cwdIndex = altered.stateEvidence.columns.indexOf("cwd");
  altered.stateEvidence.rows[0][cwdIndex] = { type: "text", value: "X:/wrong", utf8: Buffer.from("X:/wrong").toString("base64") };
  const alteredBytes = Buffer.from(JSON.stringify(altered, null, 2) + "\n"), alteredDigest = crypto.createHash("sha256").update(alteredBytes).digest("hex");
  fs.writeFileSync(payloadFile, alteredBytes);
  fs.writeFileSync(path.join(tampered, "capture-intent.json"), JSON.stringify({ schemaVersion: 1, kind: "NativeHistoryCaptureIntent", payloadId: "native-history-" + alteredDigest.slice(0, 24), payloadDigest: alteredDigest }));
  assert.throws(() => inspectCodexNativePayload({ directory: tampered }), { code: "NATIVE_CODEX_PROJECT_MEMBERSHIP_MISMATCH" });
  const rejected = path.join(f.f.base, "foreign-capture");
  await assert.rejects(captureSyntheticHistory({ witness: offline.witness, sourceProjectId: "p-a", threadIds: [foreignId], destination: rejected }), { code: "NATIVE_CODEX_THREAD_OUTSIDE_PROJECT" });
  assert.equal(fs.existsSync(rejected), false);
  assert.deepEqual(snapshot(sourceHome), originals);
  const replays = path.join(f.f.base, "no-profile-effects");
  for (const args of [{ action: "derive", provider: "claude" }, { action: "read", provider: "codex" }, { action: "capture", provider: "opencode" }]) {
    await assert.rejects(operateProjectNativeHistory({ ...args, sourceProjectId: "p-a", bundleRoot: replays }), { code: "PROJECT_NATIVE_PROJECT_SELECTION_IS_CODEX_CAPTURE_ONLY" });
  }
  await assert.rejects(runCommand(["project-native-history", replays, "--action", "derive", "--provider", "claude", "--source-project", "p-a"], { pluginRoot }), { code: "PROJECT_NATIVE_PROJECT_SELECTION_IS_CODEX_CAPTURE_ONLY" });
  const mcp = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lode_project_native_history", arguments: {
    action: "derive", provider: "claude", bundle_root: replays, source_project_id: "p-a" } } });
  assert.equal(mcp.error?.message, "PROJECT_NATIVE_PROJECT_SELECTION_IS_CODEX_CAPTURE_ONLY");
  await assert.rejects(operateProjectNativeHistory({ action: "capture-project", provider: "codex", bundleRoot: replays }), { code: "PROJECT_NATIVE_EXACT_CODEX_PROJECT_REQUIRED" });
  await assert.rejects(operateProjectNativeHistory({ action: "capture-project", provider: "codex", sourceProjectId: "p-a", bundleRoot: replays, root: replays }), { code: "PROJECT_NATIVE_STANDALONE_CAPTURE_ARGUMENTS_INVALID" });
  await assert.rejects(operateProjectNativeHistory({ action: "capture-project", provider: "codex", sourceProjectId: "p-a", bundleRoot: replays,
    nativeHome: "relative-home", executable: "relative-engine" }), { code: "PROJECT_NATIVE_HOST_REQUIRED" });
  await assert.rejects(operateProjectNativeHistory({ action: "capture-project", provider: "codex", sourceProjectId: "p-a", bundleRoot: replays,
    nativeHome: sourceHome, executable: path.join(f.f.base, "codex.exe"), assertCurrentAuthority: async () => {} }), { code: "NATIVE_HISTORY_SYNCHRONOUS_AUTHORITY_REQUIRED" });
  const surface = catalogTools.find(tool => tool.name === "lode_project_native_history");
  assert.ok(surface.inputSchema.properties.action.enum.includes("capture-project"));
  assert.ok(surface.inputSchema.properties.source_project_id);
  assert.equal(fs.existsSync(replays), false);
});

const hash = raw => crypto.createHash("sha256").update(raw).digest("hex");
const create = (f, extra = {}) => operateProjectNativeHistory({ action: "derive", provider: "claude", bundleRoot: f.bundleRoot,
  root: f.f.root, threadIds: [sourceThread], ...extra });
const inspect = (f, value) => inspectProjectNativeDerivation({ bundleRoot: f.bundleRoot, derivationId: value.derivationId, expectedDerivationDigest: value.derivationDigest });
function home(f, name = "target-home") { const dir = path.join(f.f.base, name); fs.mkdirSync(dir); return dir; }
function host(artifact, overrides = {}) {
  return { provider: "claude", evidenceKind: "synthetic-test", executableDigest: "a".repeat(64), version: async () => "2.1.317",
    writers: async () => { throw Error("The separate new-file publisher must not change/relax/call the same-platform stopped-writer path."); },
    readDerivedClaude: async () => ({ sdkVersion: "0.3.234", sessionInfo: { sessionId: artifact.manifest.target.nativeId },
      messages: artifact.rows.map(row => ({ type: row.type, uuid: row.uuid, session_id: row.sessionId, message: structuredClone(row.message) })) }), ...overrides };
}
function targetFile(nativeHome, artifact) { return path.join(nativeHome, "projects", artifact.manifest.target.cwd.replace(/[^A-Za-z0-9]/gu, "-"), artifact.manifest.target.nativeId + ".jsonl"); }

test("SDK projection omission never becomes raw completeness or a blanket isMeta/user/tool exemption", () => {
  const nativeId = crypto.randomUUID();
  const row = (type, content, extra = {}) => ({ type, uuid: crypto.randomUUID(), sessionId: nativeId, message: { role: type, content }, ...extra });
  const prefix = [row("user", "Original task"), row("assistant", [{ type: "tool_use", id: "c1", name: "read", input: {} }]),
    row("user", [{ type: "tool_result", tool_use_id: "c1", content: "Actual observation" }]), row("assistant", "Original result")];
  const notice = row("user", CLAUDE_LOCAL_COMMAND_CAVEAT, { isMeta: true, isSidechain: false, version: "2.1.317", entrypoint: "claude-desktop",
    userType: "external", parentUuid: prefix.at(-1).uuid, promptId: crypto.randomUUID(), timestamp: "2026-11-05T14:21:20.387Z" });
  const question = row("user", "A real subsequent question"), answer = row("assistant", "A real subsequent answer");
  const nativeMessages = [...prefix, notice, question, answer];
  const sdk = rows => rows.map(row => ({ type: row.type, uuid: row.uuid, session_id: nativeId, message: structuredClone(row.message) }));
  const read = (rows = nativeMessages, visible = rows.filter(r => r.uuid !== notice.uuid)) => compareClaudeDerivedReader({ nativeMessages: rows,
    returned: sdk(visible), nativeId, prefixCount: prefix.length, exactSessionObserved: true });
  const before = JSON.stringify(nativeMessages), result = read();
  assert.equal(result.rawCoverageComplete, false); assert.equal(result.readerProjectionCoverageComplete, true);
  assert.equal(result.derivedPrefixCoverageComplete, true); assert.equal(result.mismatches.length, 0);
  assert.equal(result.missing.length, 1); assert.equal(result.declaredReaderOmissions[0].uuid, notice.uuid);
  assert.equal(result.unexplainedMissing.length, 0); assert.equal(JSON.stringify(nativeMessages), before);
  for (const omitted of [prefix[0], prefix[2], question, answer]) {
    const missing = read(nativeMessages, nativeMessages.filter(r => r.uuid !== notice.uuid && r.uuid !== omitted.uuid));
    assert.equal(missing.readerProjectionCoverageComplete, false);
    assert.ok(missing.unexplainedMissing.some(row => row.uuid === omitted.uuid));
  }
  for (const patch of [{ isMeta: false }, { entrypoint: "other" }, { version: "2.1.999" }, { origin: { kind: "human" } },
    { message: { role: "user", content: "<local-command-caveat>A different real user statement</local-command-caveat>" } },
    { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c2", content: CLAUDE_LOCAL_COMMAND_CAVEAT }] } }]) {
    const rows = nativeMessages.map(r => r.uuid === notice.uuid ? { ...r, ...patch } : r), changed = read(rows);
    assert.equal(changed.readerProjectionCoverageComplete, false); assert.equal(changed.declaredReaderOmissions.length, 0);
  }
  assert.equal(read(nativeMessages, nativeMessages.filter(r => r.uuid !== notice.uuid).reverse()).readerProjectionCoverageComplete, false);
  const full = read(nativeMessages, nativeMessages); assert.equal(full.rawCoverageComplete, true);
});

test("PNG validation catches the old fixture CRC failure and never claims provider image processing", () => {
  const valid = inspectDerivedInlineImage("image/png", Buffer.from(png, "base64"));
  assert.equal(valid.valid, true); assert.equal(valid.width, 1); assert.equal(valid.height, 1); assert.equal(valid.decodedBytes, 3);
  assert.equal(valid.providerImageProcessingVerified, false);
  assert.equal(inspectDerivedInlineImage("image/png", Buffer.from(damagedPng, "base64")).code, "DERIVED_PNG_CRC_INVALID");
  // Correct CRCs from independent Python zlib; exercise deeper validation.
  for (const [expected, encoded] of Object.entries({
  "DERIVED_PNG_FILTER_INVALID": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGP9/x8AAw8CBL7b7V8AAAAASUVORK5CYII=",
  "DERIVED_PNG_SCANLINE_SIZE_INVALID": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAACklEQVR4nGP4DwABAQEAsTj2FAAAAABJRU5ErkJggg==",
  "DERIVED_PNG_DEFLATE_INVALID": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAABklEQVRicm9rZW5jnxQXAAAAAElFTkSuQmCC",
  "DERIVED_PNG_DECODE_STORAGE_LIMIT": "iVBORw0KGgoAAAANSUhEUn////9/////CAQAAAC+wMPtAAAAC0lEQVR4nGP4/x8AAwAB//wl3FEAAAAASUVORK5CYII=",
  "DERIVED_PNG_DEFLATE_TRAILING_DATA": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAE0lEQVR4nGP4/x8AAwAB/3RyYWlsaW5nUFHxtAAAAABJRU5ErkJggg==",
  "DERIVED_PNG_CRITICAL_CHUNK_UNQUALIFIED": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAAEFCQ0TbFyClAAAAC0lEQVR4nGP4/x8AAwAB//wl3FEAAAAASUVORK5CYII=",
  "DERIVED_PNG_CHUNK_TYPE_INVALID": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAAMFCQ0Q2TpaeAAAAC0lEQVR4nGP4/x8AAwAB//wl3FEAAAAASUVORK5CYII="
}))
    assert.equal(inspectDerivedInlineImage("image/png", Buffer.from(encoded, "base64")).code, expected);
  assert.equal(inspectDerivedInlineImage("image/png", Buffer.from("not an image")).code, "DERIVED_PNG_SIGNATURE_INVALID");
  for (const mediaType of ["image/jpeg", "image/gif", "image/webp"]) {
    const check = inspectDerivedInlineImage(mediaType, Buffer.from(png, "base64"));
    assert.equal(check.code, "DERIVED_IMAGE_CODEC_VALIDATION_UNQUALIFIED"); assert.equal(check.originalBytesPreserved, true);
    const events = [{ kind: "user", text: "Do not drop image evidence", source: {} },
      { kind: "image", url: "data:" + mediaType + ";base64," + png, source: {} }, { kind: "assistant", text: "Historical answer", source: {} }];
    const before = JSON.stringify(events), encoded = encodeClaudeDerived({ events, targetId: crypto.randomUUID(), cwd: "C:/synthetic", createdAt: "2026-11-05T00:00:00Z" });
    assert.equal(encoded.publicationReady, false); assert.equal(JSON.stringify(events), before);
    assert.ok(encoded.mappings.some(row => row.representation === "captured-image-original-only-unqualified"));
  }
});

test("invalid captured image stays intact at source and blocks only derivative publication", async t => {
  const f = await derivedFixture(t, { imageUrl: "data:image/png;base64," + damagedPng }), before = snapshot(f.f.root);
  const result = await create(f), artifact = inspect(f, result), nativeHome = home(f);
  assert.equal(result.publicationReady, false); assert.ok(result.diagnostics.some(row => row.code === "DERIVED_PNG_CRC_INVALID"));
  assert.ok(artifact.mapping.some(row => row.representation === "captured-image-original-only-unqualified"));
  assert.equal(artifact.rows.flatMap(row => row.message.content).some(row => row.type === "image"), false);
  for (const original of f.originals) assert.ok(fs.readFileSync(path.join(f.nativePayload, "objects", hash(original.raw) + ".bin")).equals(original.raw));
  const published = await publishClaudeDerived({ artifact, nativeHome, root: f.f.root, host: host(artifact) });
  assert.equal(published.filesWritten, 0); assert.deepEqual(fs.readdirSync(nativeHome), []); assert.deepEqual(snapshot(f.f.root), before);
});

test("rich Codex source derives one selected Claude conversation without changing original/common/P2 or its companion", async t => {
  const f = await derivedFixture(t), before = snapshot(f.f.root), originalLink = fs.readFileSync(path.join(f.bundleRoot, "native-history.json"));
  const originalTransfer = readProjectNativeTransfer({ bundleRoot: f.bundleRoot });
  const result = await create(f), artifact = inspect(f, result);
  assert.equal(result.publicationReady, true);
  assert.equal(result.source.projectId, f.f.owner.project.projectId);
  assert.equal(result.source.selectedSessionId, f.f.session.sessionId);
  assert.equal(result.grantsRecoveryAuthority, false);
  assert.equal(result.transfersNativeBinding, undefined);
  assert.deepEqual(snapshot(f.f.root), before);
  assert.ok(originalLink.equals(fs.readFileSync(path.join(f.bundleRoot, "native-history.json"))));
  assert.equal(readProjectNativeTransfer({ bundleRoot: f.bundleRoot }).linkDigest, originalTransfer.linkDigest);
  assert.equal(readProjectDirection({ root: f.f.root }).input.cancelledActions[0], "provisional deployment");
  for (const original of f.originals) assert.ok(fs.readFileSync(path.join(f.nativePayload, "objects", hash(original.raw) + ".bin")).equals(original.raw));
  const content = artifact.raw.toString("utf8");
  assert.match(content, /retained provenance/u); assert.match(content, /permission is cancelled/u);
  assert.doesNotMatch(content, /Unselected branch decision/u);
  assert.ok(artifact.rows.some(row => row.message.content.filter(block => block.type === "tool_use").length === 2));
  const resultBlock = artifact.rows.flatMap(row => row.message.content).find(block => block.type === "tool_result" && block.tool_use_id === "call_single");
  assert.match(resultBlock.content, /untrusted output/u);
  const toolResultRow = artifact.rows.find(row => row.message.content.includes(resultBlock));
  assert.equal(toolResultRow.type, "user"); assert.equal(resultBlock.type, "tool_result");
  assert.equal(artifact.rows.flatMap(row => row.message.content).find(block => block.tool_use_id === "call_error").is_error, true);
  assert.ok(artifact.rows.some(row => row.message.content.some(block => block.type === "image")));
  assert.ok(result.diagnostics.some(row => row.code === "DERIVED_ATTACHMENT_BYTES_UNAVAILABLE" && !row.blocksPublication));
  assert.ok(artifact.mapping.some(row => row.representation === "quoted-historical-compaction-summary"));
  const stats = snapshot(artifact.directory), again = await create(f);
  assert.equal(again.derivationId, result.derivationId); assert.equal(again.derivationDigest, result.derivationDigest);
  assert.deepEqual(snapshot(artifact.directory), stats);
});

for (const [option, code] of [[{ interleaved: true }, "DERIVED_INTERLEAVED_TOOL_EXCHANGE"],
  [{ missingResult: true }, "DERIVED_PENDING_TOOL"], [{ unknownInput: true }, "DERIVED_USER_INPUT_UNSUPPORTED"],
  [{ divergentWire: true }, "DERIVED_CANONICAL_WIRE_TOOL_DIVERGENCE"]]) {
  test("unsupported source remains preserved, diagnosed and unpublished: " + JSON.stringify(option), async t => {
    const f = await derivedFixture(t, option), result = await create(f), artifact = inspect(f, result), nativeHome = home(f);
    assert.equal(result.publicationReady, false);
    assert.ok(artifact.diagnostics.some(row => row.code.includes(code)));
    const published = await publishClaudeDerived({ artifact, nativeHome, root: f.f.root, host: host(artifact) });
    assert.equal(published.filesWritten, 0); assert.deepEqual(fs.readdirSync(nativeHome), []);
    assert.equal(published.status, "native-derived-representation-incomplete");
    assert.equal(readProjectNativeTransfer({ bundleRoot: f.bundleRoot }).sourceProvider, "codex");
  });
}

test("explicit cutoff and unselected branch do not merge later or conflicting decisions", async t => {
  const f = await derivedFixture(t), cutoff = await create(f, { cutoffItemId: "reason" }), artifact = inspect(f, cutoff);
  assert.equal(cutoff.publicationReady, true);
  assert.equal(artifact.rows.length, 2);
  assert.doesNotMatch(artifact.raw.toString(), /Latest condition/u);
  assert.equal(readProjectDirection({ root: f.f.root }).input.constraints[0], "Read only; deployment is cancelled");
  const child = await create(f, { threadIds: [branchThread] });
  assert.equal(child.publicationReady, false);
  assert.ok(child.diagnostics.some(row => /BRANCH|CLOSURE/u.test(row.code)));
  await assert.rejects(create(f, { cutoffItemId: "missing" }), { code: "DERIVED_CUTOFF_ITEM_NOT_FOUND" });
});

test("partial tool result and error are both preserved, and failed status remains an error without an error field", async t => {
  const f = await derivedFixture(t, { partialError: true, failedWithoutError: true, wireWithoutErrorFlag: true }), value = await create(f), artifact = inspect(f, value);
  assert.equal(value.publicationReady, true);
  const blocks = artifact.rows.flatMap(row => row.message.content);
  const partial = blocks.find(row => row.type === "tool_result" && row.tool_use_id === "call_error");
  assert.equal(partial.is_error, true);
  assert.deepEqual(JSON.parse(partial.content), { result: { recoveredCount: 3 },
    error: { code: "NOT_CAPTURED", message: "Sensor map bytes were not provided; no contents can be inferred." } });
  assert.ok(artifact.mapping.some(row => row.representation === "canonical-result-and-error-json-envelope"));
  const failed = blocks.find(row => row.type === "tool_result" && row.tool_use_id === "call_failed_without_error");
  assert.equal(failed.is_error, true); assert.equal(JSON.parse(failed.content).partial, "failed operation still produced this evidence");
});

test("concurrent creation preserves strict alias checks and later exact read converges without a timestamp conflict", async t => {
  const f = await derivedFixture(t), workers = [];
  const module = new URL("../scripts/lib/project-native-history.mjs", import.meta.url).href;
  const input = { action: "derive", provider: "claude", bundleRoot: f.bundleRoot, root: f.f.root, threadIds: [sourceThread] };
  try {
    const returned = await Promise.allSettled([0, 1].map(() => new Promise((resolve, reject) => {
      let value;
      const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); import(workerData.module)
        .then(async m=>parentPort.postMessage(await m.operateProjectNativeHistory(workerData.input))).catch(e=>{throw e;});`,
      { eval: true, workerData: { module, input } });
      workers.push(worker); worker.once("message", result => { value = result; }); worker.once("error", reject);
      worker.once("exit", code => { if (code) reject(Error("derivation worker exited " + code)); else resolve(value); });
    })));
    // Atomic no-clobber link briefly has a second staging link. Do not weaken
    // the shared strict reader or terminate a still-publishing peer on failure.
    // A concurrent reader may report the exact unsafe/changed observation;
    // after both writers end, a new read must see one intact winning artifact.
    const completed = returned.filter(row => row.status === "fulfilled").map(row => row.value);
    assert.ok(completed.length >= 1);
    for (const row of returned.filter(row => row.status === "rejected"))
      assert.ok(["PROJECT_COPY_UNSAFE_FILE", "PROJECT_COPY_SOURCE_CHANGED"].includes(row.reason.code), row.reason.stack);
    const later = await create(f);
    for (const row of completed) assert.equal(row.derivationDigest, later.derivationDigest);
    assert.equal(inspect(f, later).manifest.publicationReady, true);
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
});

test("wrong root, hardlinked targets and source mutation across Host await remain scoped failures", async t => {
  const f = await derivedFixture(t), value = await create(f), artifact = inspect(f, value), nativeHome = home(f);
  const other = path.join(f.f.base, "different-project"); fs.mkdirSync(other);
  await assert.rejects(publishClaudeDerived({ artifact, nativeHome, root: other, host: host(artifact) }), { code: "DERIVED_TARGET_PROJECT_ROOT_CHANGED" });
  const projectDir = path.dirname(targetFile(nativeHome, artifact)); fs.mkdirSync(projectDir, { recursive: true });
  const preserved = path.join(f.f.base, "untouched.txt"); fs.writeFileSync(preserved, "Preserve this synthetic file");
  fs.linkSync(preserved, targetFile(nativeHome, artifact));
  await assert.rejects(publishClaudeDerived({ artifact, nativeHome, root: f.f.root, host: host(artifact) }), { code: "DERIVED_TARGET_UNSAFE" });
  assert.equal(fs.readFileSync(preserved, "utf8"), "Preserve this synthetic file");
  fs.unlinkSync(targetFile(nativeHome, artifact));
  const mappingFile = path.join(artifact.directory, "mapping.json");
  await assert.rejects(publishClaudeDerived({ artifact, nativeHome, root: f.f.root, host: host(artifact, { version: async () => {
    fs.appendFileSync(mappingFile, " "); return "2.1.317";
  } }) }), { code: "DERIVED_ARTIFACT_TAMPER" });
  assert.equal(fs.existsSync(targetFile(nativeHome, artifact)), false);
});

test("nonterminal source does not block derivation or publication but cannot trigger official open", async t => {
  const f = await derivedFixture(t, { sourceTurnStatus: "inProgress" }), value = await create(f), artifact = inspect(f, value), nativeHome = home(f);
  assert.equal(value.publicationReady, true); assert.equal(value.openSafety.structurallySettled, false);
  await publishClaudeDerived({ artifact, nativeHome, root: f.f.root, host: host(artifact) });
  let opens = 0;
  const result = await openClaudeDerived({ artifact: inspect(f, value), nativeHome, root: f.f.root,
    host: host(artifact, { openDerivedDesktop: async () => { opens++; } }) });
  assert.equal(result.status, "native-derived-open-pending-or-unsupported-source"); assert.equal(opens, 0);
});

test("append verification includes new messages and publication journal tamper cannot hide behind an exact target", async t => {
  const f = await derivedFixture(t), value = await create(f), artifact = inspect(f, value), nativeHome = home(f);
  const published = await publishClaudeDerived({ artifact, nativeHome, root: f.f.root, host: host(artifact) });
  const file = targetFile(nativeHome, artifact), appended = { ...artifact.rows.at(-1), uuid: crypto.randomUUID(), parentUuid: artifact.rows.at(-1).uuid,
    message: { ...artifact.rows.at(-1).message, content: [{ type: "text", text: "Synthetic persisted continuation" }] } };
  fs.appendFileSync(file, JSON.stringify(appended) + "\n");
  const args = { action: "verify-derived", bundleRoot: f.bundleRoot, root: f.f.root, nativeHome,
    derivationId: value.derivationId, expectedDerivationDigest: value.derivationDigest };
  const staleReader = await operateProjectNativeHistory({ ...args, nativeHistoryHost: host(artifact) });
  assert.equal(staleReader.rawCoverageComplete, false); assert.equal(staleReader.missingMessages.at(-1).uuid, appended.uuid);
  const full = await host(artifact).readDerivedClaude();
  full.messages.push({ type: appended.type, uuid: appended.uuid, session_id: appended.sessionId, message: appended.message });
  const current = await operateProjectNativeHistory({ ...args, nativeHistoryHost: host(artifact, { readDerivedClaude: async () => full }) });
  assert.equal(current.rawCoverageComplete, true); assert.equal(current.appendedReturnedMessages, 1);
  const wrongInfo = await operateProjectNativeHistory({ ...args, nativeHistoryHost: host(artifact, {
    readDerivedClaude: async () => ({ ...full, sessionInfo: { sessionId: "unrelated" } }) }) });
  assert.equal(wrongInfo.rawCoverageComplete, false);
  fs.appendFileSync(path.join(path.dirname(published.publicationReceipt), "publication-attempt.json"), " ");
  const before = fs.readFileSync(file);
  await assert.rejects(publishClaudeDerived({ artifact: inspect(f, value), nativeHome, root: f.f.root, host: host(artifact) }),
    { code: "DERIVED_PUBLICATION_ATTEMPT_MISMATCH" });
  assert.ok(fs.readFileSync(file).equals(before));
});

test("new-file publish is create-only while existing Desktop writers need not stop; retry and append are not replayed", async t => {
  const f = await derivedFixture(t), result = await create(f), artifact = inspect(f, result), nativeHome = home(f);
  const first = await publishClaudeDerived({ artifact, nativeHome, root: f.f.root, host: host(artifact) });
  assert.equal(first.filesWritten, 1); assert.equal(first.status, "native-derived-transcript-published");
  assert.deepEqual(fs.readdirSync(nativeHome), ["projects"]);
  const file = targetFile(nativeHome, artifact), before = fs.statSync(file).mtimeMs;
  const again = await publishClaudeDerived({ artifact: inspect(f, result), nativeHome, root: f.f.root, host: host(artifact) });
  assert.equal(again.filesWritten, 0); assert.equal(fs.statSync(file).mtimeMs, before);
  const appended = { ...artifact.rows.at(-1), uuid: crypto.randomUUID(), parentUuid: artifact.rows.at(-1).uuid,
    message: { ...artifact.rows.at(-1).message, content: [{ type: "text", text: "New native continuation, not part of the original." }] } };
  fs.appendFileSync(file, JSON.stringify(appended) + "\n"); const after = fs.readFileSync(file);
  const continued = await publishClaudeDerived({ artifact: inspect(f, result), nativeHome, root: f.f.root, host: host(artifact) });
  assert.equal(continued.filesWritten, 0); assert.equal(continued.status, "native-derived-target-continued");
  assert.ok(fs.readFileSync(file).equals(after));
  fs.writeFileSync(file, "Changed by external writer\n");
  const conflict = await publishClaudeDerived({ artifact: inspect(f, result), nativeHome, root: f.f.root, host: host(artifact) });
  assert.equal(conflict.status, "native-derived-target-conflict"); assert.equal(fs.readFileSync(file, "utf8"), "Changed by external writer\n");
});

test("lost result and absent-after-attempt never trigger a second publication; changed executable cannot reset attempt identity", async t => {
  const f = await derivedFixture(t), result = await create(f), artifact = inspect(f, result), nativeHome = home(f);
  let attempts = 0;
  const first = await publishClaudeDerived({ artifact, nativeHome, root: f.f.root, host: host(artifact), publishFile() { attempts++; throw Object.assign(new Error("Lost publication"), { code: "LOST_RESULT" }); } });
  assert.equal(first.status, "native-derived-publication-uncertain");
  const again = await publishClaudeDerived({ artifact: inspect(f, result), nativeHome, root: f.f.root, host: host(artifact), publishFile() { attempts++; } });
  assert.equal(again.status, "native-derived-publication-uncertain"); assert.equal(attempts, 1);
  await assert.rejects(publishClaudeDerived({ artifact: inspect(f, result), nativeHome, root: f.f.root,
    host: host(artifact, { executableDigest: "b".repeat(64) }) }), { code: "DERIVED_PUBLICATION_ATTEMPT_MISMATCH" });
});

test("different-profile duplicate beyond the 64th folder is detected without reading unrelated bodies", async t => {
  const f = await derivedFixture(t), result = await create(f), artifact = inspect(f, result), nativeHome = home(f);
  for (let i = 0; i < 70; i++) fs.mkdirSync(path.join(nativeHome, "projects", "source-" + String(i).padStart(3, "0")), { recursive: true });
  fs.writeFileSync(path.join(nativeHome, "projects", "source-069", artifact.manifest.target.nativeId + ".jsonl"), "Unrelated existing body must not be read or overwritten");
  await assert.rejects(publishClaudeDerived({ artifact, nativeHome, root: f.f.root, host: host(artifact) }), { code: "DERIVED_OTHER_PROJECT_ID_CONFLICT" });
  assert.equal(fs.existsSync(targetFile(nativeHome, artifact)), false);
});

test("tamper, cancellation and wrong expected digest stop before any native Host observation", async t => {
  const f = await derivedFixture(t), result = await create(f), artifact = inspect(f, result), nativeHome = home(f);
  let probes = 0;
  await assert.rejects(operateProjectNativeHistory({ action: "publish-derived", bundleRoot: f.bundleRoot,
    derivationId: result.derivationId, expectedDerivationDigest: "0".repeat(64), nativeHome, root: f.f.root,
    nativeHistoryHost: host(artifact, { version: async () => { probes++; return "2.1.317"; } }) }), { code: "DERIVED_MANIFEST_DIGEST_MISMATCH" });
  assert.equal(probes, 0);
  fs.appendFileSync(path.join(artifact.directory, "conversation.jsonl"), "tamper");
  assert.throws(() => inspect(f, result), { code: "DERIVED_ARTIFACT_TAMPER" });
  assert.deepEqual(fs.readdirSync(nativeHome), []);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(create(f, { signal: controller.signal }), { code: "NATIVE_HISTORY_OPERATION_CANCELLED" });
});

test("even coherently rehashed provenance/authority metadata must match the entire reproduced manifest and intent", async t => {
  const f = await derivedFixture(t), result = await create(f), artifact = inspect(f, result), nativeHome = home(f);
  const manifestFile = path.join(artifact.directory, "manifest.json"), intentFile = path.join(artifact.directory, "intent.json");
  const originalManifest = fs.readFileSync(manifestFile), originalIntent = fs.readFileSync(intentFile), before = snapshot(f.f.root);
  let probes = 0;
  const noHost = host(artifact, { version: async () => { probes++; return "2.1.317"; } });
  for (const change of [m => { m.synthesizedMetadata = []; }, m => { m.historicalToolsExecuted = true; },
    m => { m.originalCompanionUnchanged = false; }, m => { m.extraAuthorityClaim = "approved"; },
    m => { m.targetExecutionSettingsVerified = true; }]) {
    const changed = JSON.parse(originalManifest); change(changed);
    const raw = Buffer.from(JSON.stringify(changed, null, 2) + "\n"); fs.writeFileSync(manifestFile, raw);
    await assert.rejects(operateProjectNativeHistory({ action: "publish-derived", bundleRoot: f.bundleRoot, derivationId: result.derivationId,
      expectedDerivationDigest: hash(raw), nativeHome, root: f.f.root, nativeHistoryHost: noHost }), { code: "DERIVED_REPRODUCTION_MISMATCH" });
    fs.writeFileSync(manifestFile, originalManifest);
  }
  const intent = JSON.parse(originalIntent); intent.grantsRecoveryAuthority = true;
  const changedIntent = Buffer.from(JSON.stringify(intent, null, 2) + "\n"); fs.writeFileSync(intentFile, changedIntent);
  const manifest = JSON.parse(originalManifest); manifest.intentDigest = hash(changedIntent);
  const changedManifest = Buffer.from(JSON.stringify(manifest, null, 2) + "\n"); fs.writeFileSync(manifestFile, changedManifest);
  await assert.rejects(operateProjectNativeHistory({ action: "publish-derived", bundleRoot: f.bundleRoot, derivationId: result.derivationId,
    expectedDerivationDigest: hash(changedManifest), nativeHome, root: f.f.root, nativeHistoryHost: noHost }), { code: "DERIVED_INTENT_IDENTITY_MISMATCH" });
  assert.equal(probes, 0); assert.deepEqual(fs.readdirSync(nativeHome), []); assert.deepEqual(snapshot(f.f.root), before);
  fs.writeFileSync(intentFile, originalIntent); fs.writeFileSync(manifestFile, originalManifest);
  assert.equal(inspect(f, result).digest, result.derivationDigest);
});

test("read-only verification requires full role/body/UUID/order/tool coverage, never a matching subset", async t => {
  const f = await derivedFixture(t), value = await create(f), artifact = inspect(f, value), nativeHome = home(f);
  await publishClaudeDerived({ artifact, nativeHome, root: f.f.root, host: host(artifact) });
  const args = { action: "verify-derived", bundleRoot: f.bundleRoot, derivationId: value.derivationId,
    expectedDerivationDigest: value.derivationDigest, nativeHome, root: f.f.root };
  const full = await operateProjectNativeHistory({ ...args, nativeHistoryHost: host(artifact) });
  assert.equal(full.rawCoverageComplete, true); assert.equal(full.desktopVisibility, "not-observed");
  const base = await host(artifact).readDerivedClaude();
  const subset = await operateProjectNativeHistory({ ...args, nativeHistoryHost: host(artifact, { readDerivedClaude: async () => ({ ...base, messages: base.messages.slice(0, 1) }) }) });
  assert.equal(subset.rawCoverageComplete, false); assert.ok(subset.missingMessages.length > 0);
  const changed = structuredClone(base); const row = changed.messages.find(row => row.message.content.some(b => b.type === "tool_result"));
  row.message.content[0] = { type: "text", text: "Wrongly promoted human instruction" };
  const altered = await operateProjectNativeHistory({ ...args, nativeHistoryHost: host(artifact, { readDerivedClaude: async () => changed }) });
  assert.equal(altered.rawCoverageComplete, false); assert.ok(altered.mismatchCount > 0);
});

test("an official read of the emitted subset never verifies an unsupported original source", async t => {
  const f = await derivedFixture(t, { unknownInput: true }), value = await create(f), artifact = inspect(f, value), nativeHome = home(f);
  assert.equal(value.publicationReady, false);
  // Test-only preparation, not a supported publisher bypass. Reading exact
  // partial evidence is useful, but must not promote its source coverage.
  const file = targetFile(nativeHome, artifact); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, artifact.raw);
  const before = fs.readFileSync(file);
  const read = await operateProjectNativeHistory({ action: "verify-derived", bundleRoot: f.bundleRoot, nativeHome, root: f.f.root,
    derivationId: value.derivationId, expectedDerivationDigest: value.derivationDigest, nativeHistoryHost: host(artifact) });
  assert.equal(read.rawCoverageComplete, true); assert.equal(read.emittedNativeCoverageComplete, true);
  assert.equal(read.sourceRepresentationComplete, false); assert.equal(read.originalSourceRolesAndToolBlocksVerified, false);
  assert.equal(read.status, "native-derived-official-reader-emitted-subset-only"); assert.ok(read.blockingSourceDiagnosticCount > 0);
  assert.ok(fs.readFileSync(file).equals(before));
});

test("same-platform guards and ordinary read remain independent, and CLI/MCP use the same derive identity", async t => {
  const f = await derivedFixture(t);
  await assert.rejects(operateProjectNativeHistory({ action: "restore", provider: "claude", bundleRoot: f.bundleRoot }), { code: "NATIVE_HISTORY_SAME_PLATFORM_REQUIRED" });
  await assert.rejects(operateProjectNativeHistory({ action: "read", provider: "claude", bundleRoot: f.bundleRoot }), { code: "NATIVE_HISTORY_SAME_PLATFORM_REQUIRED" });
  const cli = await runCommand(["project-native-history", f.bundleRoot, "--action", "derive", "--provider", "claude", "--threads", sourceThread, "--runtime-root", f.f.root], { pluginRoot });
  const mcp = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lode_project_native_history", arguments: {
    action: "derive", provider: "claude", bundle_root: f.bundleRoot, thread_ids: [sourceThread], runtime_root: f.f.root } } });
  assert.equal(mcp.error, undefined);
  assert.equal(mcp.result.isError, undefined);
  const parsed = mcp.result.structuredContent || JSON.parse(mcp.result.content.find(row => row.type === "text").text);
  assert.equal(parsed.derivationId, cli.derivationId); assert.equal(parsed.derivationDigest, cli.derivationDigest);
});

test("official open is a separate at-most-once Host request, never publication, GUI proof or an automatic model send", async t => {
  const f = await derivedFixture(t), value = await create(f), artifact = inspect(f, value), nativeHome = home(f);
  const before = await openClaudeDerived({ artifact, nativeHome, root: f.f.root, host: host(artifact) });
  assert.equal(before.status, "native-derived-open-target-not-ready");
  assert.deepEqual(fs.readdirSync(nativeHome), []);
  await publishClaudeDerived({ artifact, nativeHome, root: f.f.root, host: host(artifact) });
  const limited = await openClaudeDerived({ artifact: inspect(f, value), nativeHome, root: f.f.root, host: host(artifact) });
  assert.equal(limited.reasonCode, "DERIVED_DESKTOP_HANDOFF_LIFETIME_UNQUALIFIED");
  assert.equal(limited.launcherInvoked, false);
  let requests = 0;
  const qualifiedTestHost = host(artifact, { openDerivedDesktop: async args => {
    requests++;
    assert.deepEqual(args.args, ["--desktop", "--resume", artifact.manifest.target.nativeId]);
    assert.equal(args.shell, false); assert.equal(Object.hasOwn(args, "prompt"), false);
    return { status: "synthetic-no-launch", exitCode: 0 };
  } });
  const opened = await openClaudeDerived({ artifact: inspect(f, value), nativeHome, root: f.f.root, host: qualifiedTestHost });
  assert.equal(opened.status, "native-derived-desktop-handoff-returned");
  assert.equal(opened.desktopVisibility, "not-observed"); assert.equal(opened.modelAutoSendRequested, false);
  assert.equal(opened.launcherInvoked, null, "a trusted callback return is still not observed OS launch");
  const repeat = await openClaudeDerived({ artifact: inspect(f, value), nativeHome, root: f.f.root, host: qualifiedTestHost });
  assert.equal(repeat.status, "native-derived-open-already-attempted"); assert.equal(requests, 1);
});

test("unknown open is not repeated and appended pending work cannot trigger a resume", async t => {
  const f = await derivedFixture(t), value = await create(f), artifact = inspect(f, value), nativeHome = home(f);
  await publishClaudeDerived({ artifact, nativeHome, root: f.f.root, host: host(artifact) });
  let requests = 0;
  const lostHost = host(artifact, { openDerivedDesktop: async () => { requests++; throw Object.assign(new Error("Lost open"), { code: "OPEN_OUTCOME_UNKNOWN" }); } });
  const lost = await openClaudeDerived({ artifact: inspect(f, value), nativeHome, root: f.f.root, host: lostHost });
  assert.equal(lost.status, "native-derived-desktop-handoff-uncertain");
  const repeated = await openClaudeDerived({ artifact: inspect(f, value), nativeHome, root: f.f.root, host: lostHost });
  assert.equal(repeated.status, "native-derived-open-already-attempted"); assert.equal(requests, 1);
  const question = { type: "user", sessionId: artifact.manifest.target.nativeId, uuid: crypto.randomUUID(), parentUuid: artifact.rows.at(-1).uuid,
    message: { role: "user", content: "Pending new question; must not be auto-sent by open." } };
  fs.appendFileSync(targetFile(nativeHome, artifact), JSON.stringify(question) + "\n");
  const pending = await openClaudeDerived({ artifact: inspect(f, value), nativeHome, root: f.f.root, host: lostHost });
  assert.equal(pending.status, "native-derived-open-pending-native-work"); assert.equal(requests, 1);
});

test("streaming or unknown assistant termination prevents open; a later explicit terminal segment remains usable", async t => {
  const f = await derivedFixture(t), value = await create(f), artifact = inspect(f, value), nativeHome = home(f);
  await publishClaudeDerived({ artifact, nativeHome, root: f.f.root, host: host(artifact) });
  const file = targetFile(nativeHome, artifact); let parent = artifact.rows.at(-1).uuid, opens = 0;
  const h = host(artifact, { openDerivedDesktop: async () => { opens++; return { exitCode: 0, status: "synthetic-no-launch" }; } });
  for (const stopReason of [null, undefined, "unknown-new-stop", "pause_turn"]) {
    const row = { ...artifact.rows.at(-1), uuid: crypto.randomUUID(), parentUuid: parent,
      message: { ...artifact.rows.at(-1).message, stop_reason: stopReason } }; parent = row.uuid;
    fs.appendFileSync(file, JSON.stringify(row) + "\n"); const before = fs.readFileSync(file);
    const result = await openClaudeDerived({ artifact: inspect(f, value), nativeHome, root: f.f.root, host: h });
    assert.equal(result.status, "native-derived-open-pending-native-work"); assert.equal(opens, 0);
    assert.ok(fs.readFileSync(file).equals(before));
  }
  const final = { ...artifact.rows.at(-1), uuid: crypto.randomUUID(), parentUuid: parent };
  fs.appendFileSync(file, JSON.stringify(final) + "\n");
  const result = await openClaudeDerived({ artifact: inspect(f, value), nativeHome, root: f.f.root, host: h });
  assert.equal(result.status, "native-derived-desktop-handoff-returned"); assert.equal(opens, 1);
});


test("standalone native source evidence derives without creating or inventing a Lode Project or logical Session", async t => {
  const f = await derivedFixture(t), target = path.join(f.f.base, "native-only-workspace"); fs.mkdirSync(target);
  const manifestBefore = fs.readFileSync(path.join(f.nativePayload, "manifest.json"));
  const rawBefore = new Map(fs.readdirSync(path.join(f.nativePayload, "objects")).map(name => [name, fs.readFileSync(path.join(f.nativePayload, "objects", name))]));
  const args = { action: "derive", provider: "claude", bundleRoot: f.nativePayload, threadIds: [sourceThread], root: target };
  const created = await operateProjectNativeHistory(args);
  const artifact = inspectProjectNativeDerivation({ bundleRoot: f.nativePayload, derivationId: created.derivationId, expectedDerivationDigest: created.derivationDigest });
  assert.equal(artifact.manifest.source.kind, "native-capture");
  assert.equal(artifact.manifest.source.nativeProjectId, null);
  for (const key of ["projectId", "selectedSessionId", "bundleId", "commonManifestDigest"]) assert.equal(Object.hasOwn(artifact.manifest.source, key), false);
  assert.equal(artifact.manifest.grantsRecoveryAuthority, false);
  assert.equal(artifact.manifest.restoresExecutionPermission, false);
  assert.ok(fs.readFileSync(path.join(f.nativePayload, "manifest.json")).equals(manifestBefore));
  for (const [name, bytes] of rawBefore) assert.ok(fs.readFileSync(path.join(f.nativePayload, "objects", name)).equals(bytes));
  assert.deepEqual(fs.readdirSync(target), []);
  const repeated = await operateProjectNativeHistory(args); assert.equal(repeated.derivationId, created.derivationId); assert.equal(repeated.derivationDigest, created.derivationDigest);
  await assert.rejects(operateProjectNativeHistory({ ...args, expectedBundleId: "project-bundle-" + "a".repeat(24) }), { code: "DERIVED_NATIVE_CAPTURE_IS_NOT_COMMON_BUNDLE" });
});


test("workspace transfer preserves conflicting files and excludes private state without reading it; reuse performs no copy", async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lode-workspace-copy-"));
  t.after(() => { if (path.dirname(fs.realpathSync(base)) !== fs.realpathSync(os.tmpdir())) throw Error("Unexpected cleanup root"); fs.rmSync(base, { recursive: true, force: true }); });
  const source = path.join(base, "workspace-source"), target = path.join(base, "workspace-target");
  fs.mkdirSync(path.join(source, "src"), { recursive: true }); fs.mkdirSync(path.join(source, "docs")); fs.mkdirSync(path.join(source, ".git")); fs.mkdirSync(path.join(source, ".lode"));
  fs.writeFileSync(path.join(source, "src", "main.mjs"), "export const sum = (a,b) => a+b;\n");
  fs.writeFileSync(path.join(source, "docs", "guide.md"), "# Synthetic program\n");
  for (const file of [".env", ".git/config", ".lode/session.json"]) fs.writeFileSync(path.join(source, file), "PRIVATE_SCOPE_SENTINEL");
  fs.mkdirSync(path.join(target, "docs"), { recursive: true }); fs.writeFileSync(path.join(target, "docs", "guide.md"), "Preserve the destination edit");
  const paths = ["src/main.mjs", "docs/guide.md", ".env", ".git/config", ".lode/session.json"];
  const open = fs.openSync; let privateReads = 0;
  fs.openSync = function(file, ...args) { if (typeof file === "string" && [".env", ".git/config", ".lode/session.json"].some(name => file.replaceAll("\\", "/").endsWith("/"+name))) { privateReads++; throw Error("Private content was read"); } return open.call(this,file,...args); };
  let prepared, result;
  try {
    prepared = prepareProjectWorkspaceTransfer({ sourceRoot: source, targetRoot: target, paths });
    result = applyProjectWorkspaceTransfer({ plan: prepared.plan, expectedPlanDigest: prepared.planDigest, sourceRoot: source, targetRoot: target });
  } finally { fs.openSync = open; }
  assert.equal(privateReads, 0); assert.equal(prepared.excludedFileCount, 3); assert.deepEqual(prepared.conflicts, ["docs/guide.md"]);
  assert.equal(result.status, "workspace-transfer-partial"); assert.equal(result.overwrittenFiles, 0);
  assert.equal(fs.readFileSync(path.join(target, "docs", "guide.md"), "utf8"), "Preserve the destination edit");
  assert.ok(fs.readFileSync(path.join(target, "src", "main.mjs")).equals(fs.readFileSync(path.join(source, "src", "main.mjs"))));
  assert.equal(fs.existsSync(path.join(target, ".env")), false); assert.equal(fs.existsSync(path.join(target, ".lode")), false);
  const sourceBefore = snapshot(source);
  const reuse = prepareProjectWorkspaceTransfer({ sourceRoot: source, targetRoot: source, paths: ["src/main.mjs"], mode: "reuse" });
  assert.equal(applyProjectWorkspaceTransfer({ plan: reuse.plan, expectedPlanDigest: reuse.planDigest, sourceRoot: source, targetRoot: source }).results[0].status, "reused-exact");
  assert.deepEqual(snapshot(source), sourceBefore); assert.equal(result.runnableProjectVerified, false);
});

test("workspace source drift, root mismatch, asynchronous authority and cancellation fail before target creation", async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lode-workspace-drift-"));
  t.after(() => { if (path.dirname(fs.realpathSync(base)) !== fs.realpathSync(os.tmpdir())) throw Error("Unexpected cleanup root"); fs.rmSync(base, { recursive: true, force: true }); });
  const source = path.join(base, "drift-source"), target = path.join(base, "drift-target"); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "code.mjs"), "original");
  const prepared = prepareProjectWorkspaceTransfer({ sourceRoot: source, targetRoot: target, paths: ["code.mjs"] });
  fs.writeFileSync(path.join(source, "code.mjs"), "changed after preparation");
  assert.throws(() => applyProjectWorkspaceTransfer({ plan: prepared.plan, expectedPlanDigest: prepared.planDigest, sourceRoot: source, targetRoot: target }), { code: "PROJECT_COPY_SOURCE_CHANGED" });
  assert.equal(fs.existsSync(target), false);
  assert.throws(() => applyProjectWorkspaceTransfer({ plan: prepared.plan, expectedPlanDigest: prepared.planDigest, sourceRoot: source, targetRoot: target + "-different" }), { code: "WORKSPACE_TRANSFER_CURRENT_ROOT_MISMATCH" });
  assert.throws(() => prepareProjectWorkspaceTransfer({ sourceRoot: source, targetRoot: target, paths: ["code.mjs"], assertCurrentAuthority: async () => {} }), { code: "WORKSPACE_TRANSFER_SYNCHRONOUS_AUTHORITY_REQUIRED" });
  assert.throws(() => prepareProjectWorkspaceTransfer({ sourceRoot: source, targetRoot: target, paths: ["code.mjs"], signal: AbortSignal.abort() }), { code: "WORKSPACE_TRANSFER_CANCELLED" });
  assert.throws(() => prepareProjectWorkspaceTransfer({ sourceRoot: source, targetRoot: target, paths: ["../outside"] }), { code: "PROJECT_COPY_PATH_INVALID" });
  assert.equal(fs.existsSync(target), false);
});


test("workspace nested private paths are excluded without reads; templates remain selected and copy roots cannot overlap", t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lode-workspace-bounds-"));
  t.after(() => { if (path.dirname(fs.realpathSync(base)) !== fs.realpathSync(os.tmpdir())) throw Error("Unexpected cleanup root"); fs.rmSync(base, { recursive: true, force: true }); });
  const source = path.join(base,"source"), target = path.join(base,"target");
  for (const directory of ["apps/example", "nested/.claude", "nested/.lode"]) fs.mkdirSync(path.join(source,directory), { recursive: true });
  const privatePaths = ["apps/example/.env", "apps/example/credentials.json", "nested/.claude/settings.json", "nested/.lode/session.json"];
  for (const file of privatePaths) fs.writeFileSync(path.join(source,file), "PRIVATE_NESTED_SENTINEL");
  fs.writeFileSync(path.join(source,"apps/example/.env.example"), "EXAMPLE_SETTING=synthetic");
  const open = fs.openSync, lstat = fs.lstatSync; let privateReads=0, privateStats=0;
  fs.lstatSync = function(file,...args) { if (typeof file === "string" && [...privatePaths,"nested/.claude","nested/.lode"].some(name => file.replaceAll("\\","/").endsWith("/"+name))) { privateStats++; throw Error("Excluded private path was inspected"); } return lstat.call(this,file,...args); };
  fs.openSync = function(file,...args) { if (typeof file === "string" && privatePaths.some(name => file.replaceAll("\\","/").endsWith("/"+name))) { privateReads++; throw Error("Nested private content was read"); } return open.call(this,file,...args); };
  let prepared,result;
  try { prepared=prepareProjectWorkspaceTransfer({sourceRoot:source,targetRoot:target,paths:[...privatePaths,"apps/example/.env.example"]});
    result=applyProjectWorkspaceTransfer({plan:prepared.plan,expectedPlanDigest:prepared.planDigest,sourceRoot:source,targetRoot:target});
  } finally { fs.openSync=open; fs.lstatSync=lstat; }
  assert.equal(privateReads,0); assert.equal(privateStats,0); assert.equal(prepared.excludedFileCount,4); assert.equal(result.status,"workspace-transfer-with-exclusions");
  assert.equal(fs.readFileSync(path.join(target,"apps/example/.env.example"),"utf8"),"EXAMPLE_SETTING=synthetic");
  for (const file of privatePaths) assert.equal(fs.existsSync(path.join(target,file)),false);
  for (const destination of [path.join(source,"nested-target"),base]) assert.throws(() => prepareProjectWorkspaceTransfer({sourceRoot:source,targetRoot:destination,paths:["apps/example/.env.example"]}), {code:"WORKSPACE_TRANSFER_ROOT_OVERLAP"});
  if(process.platform==="win32") assert.throws(() => prepareProjectWorkspaceTransfer({sourceRoot:source,targetRoot:source.toUpperCase(),paths:[]}), {code:"WORKSPACE_TRANSFER_USE_REUSE_FOR_SAME_ROOT"});
  assert.equal(fs.existsSync(path.join(source,"nested-target")),false);
});

test("workspace cleans only the observed temporary inode, preserves a denied copy and never retries denied stage unlink", t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(),"lode-workspace-stage-"));
  t.after(() => { if (path.dirname(fs.realpathSync(base)) !== fs.realpathSync(os.tmpdir())) throw Error("Unexpected cleanup root"); fs.rmSync(base,{recursive:true,force:true}); });
  const source=path.join(base,"source");fs.mkdirSync(source);fs.writeFileSync(path.join(source,"a.mjs"),"Synthetic source");
  const target=path.join(base,"target"), prepared=prepareProjectWorkspaceTransfer({sourceRoot:source,targetRoot:target,paths:["a.mjs"]});
  const open=fs.openSync;let revoked=false, failure;
  fs.openSync=function(file,flags,...args){const fd=open.call(this,file,flags,...args);if(flags==="wx"&&String(file).endsWith(".part"))revoked=true;return fd;};
  try { applyProjectWorkspaceTransfer({plan:prepared.plan,expectedPlanDigest:prepared.planDigest,sourceRoot:source,targetRoot:target,
    assertCurrentAuthority:()=>{if(revoked)throw Object.assign(new Error("Synthetic copy cancellation"),{code:"SYNTHETIC_COPY_REVOKED"});}}); }
  catch(error){failure=error;}finally{fs.openSync=open;}
  assert.equal(failure.code,"SYNTHETIC_COPY_REVOKED"); assert.equal(failure.workspaceTransferResult.results[0].status,"copy-outcome-unverified");
  assert.ok(failure.workspaceTransferResult.temporaryCleanup.some(row=>row.status==="owned-stage-removed"));
  assert.deepEqual(fs.readdirSync(target),[]);assert.equal(fs.readFileSync(path.join(source,"a.mjs"),"utf8"),"Synthetic source");
  const deniedTarget=path.join(base,"denied-target"), next=prepareProjectWorkspaceTransfer({sourceRoot:source,targetRoot:deniedTarget,paths:["a.mjs"]});
  const unlink=fs.unlinkSync;let deniedCalls=0, denied;
  fs.unlinkSync=function(file,...args){if(String(file).endsWith(".part")){deniedCalls++;throw Object.assign(new Error("Synthetic unlink refusal"),{code:"EPERM"});}return unlink.call(this,file,...args);};
  try {applyProjectWorkspaceTransfer({plan:next.plan,expectedPlanDigest:next.planDigest,sourceRoot:source,targetRoot:deniedTarget});}
  catch(error){denied=error;}finally{fs.unlinkSync=unlink;}
  assert.equal(denied.code,"EPERM");assert.equal(deniedCalls,1);assert.ok(denied.workspaceTransferResult.temporaryCleanup.some(row=>row.status==="permission-denied-not-retried"));
  assert.ok(fs.readdirSync(deniedTarget).some(name=>name.endsWith(".part")));
});


test("pinned completion observation ordinals do not replace exact wire start/result order and known error survives absent wire flag", async t => {
  for (const knownError of [false,true]) {
    const f=await completionProjectionFixture(t,{knownError});
    const before=snapshot(f.home);
    const created=await operateProjectNativeHistory({action:"derive",provider:"claude",bundleRoot:f.captured.directory,root:f.root,threadIds:[f.threadId]});
    const artifact=inspectProjectNativeDerivation({bundleRoot:f.captured.directory,derivationId:created.derivationId,expectedDerivationDigest:created.derivationDigest});
    assert.equal(artifact.manifest.input.converter,"codex-claude-derived-v3");assert.equal(artifact.manifest.publicationReady,true,JSON.stringify(artifact.diagnostics));
    const toolGroup=artifact.rows.find(row=>row.message.content.filter(block=>block.type==="tool_use").length===2);assert.ok(toolGroup);
    assert.deepEqual(toolGroup.message.content.map(block=>block.id),["source-call-left","source-call-right"]);
    const results=artifact.rows.flatMap(row=>row.message.content).filter(block=>block.type==="tool_result");
    assert.equal(results.find(block=>block.tool_use_id==="source-call-right").is_error,knownError);
    const mapping=JSON.parse(fs.readFileSync(path.join(artifact.directory,"mapping.json")));
    const left=mapping.mappings.find(row=>row.callId==="source-call-left"&&row.sourceRole==="tool-call");
    assert.ok(Number(left.source.ordinal)>f.wireStarts[0]); // DB is a later completion observation
    const repeated=await operateProjectNativeHistory({action:"derive",provider:"claude",bundleRoot:f.captured.directory,root:f.root,threadIds:[f.threadId]});
    assert.equal(repeated.derivationId,created.derivationId);assert.equal(repeated.derivationDigest,created.derivationDigest);
    assert.deepEqual(snapshot(f.home),before);assert.deepEqual(fs.readdirSync(f.root),[]);
  }
});

test("wire-only unrecorded outcome remains an absent native error flag and explicit P3 unknown without inferring from text", async t => {
  const f=await completionProjectionFixture(t,{unknownWire:true});
  const created=await operateProjectNativeHistory({action:"derive",provider:"claude",bundleRoot:f.captured.directory,root:f.root,threadIds:[f.threadId]});
  const artifact=inspectProjectNativeDerivation({bundleRoot:f.captured.directory,derivationId:created.derivationId,expectedDerivationDigest:created.derivationDigest});
  assert.equal(artifact.manifest.publicationReady,true,JSON.stringify(artifact.diagnostics));
  const result=artifact.rows.flatMap(row=>row.message.content).find(block=>block.tool_use_id==="source-unknown");
  assert.ok(result);assert.equal(Object.hasOwn(result,"is_error"),false);assert.equal(result.content,"Exact output; operational outcome was not recorded.");
  assert.ok(artifact.mapping.some(row=>row.source?.errorFlagEvidence==="not-recorded"));
  assert.ok(artifact.diagnostics.some(row=>row.code==="DERIVED_WIRE_TOOL_OUTCOME_UNRECORDED"&&row.blocksPublication===false));
});

test("duplicate or divergent wire associations never become a unique canonical mapping", async t => {
  for(const extra of [{duplicateWire:true},{divergentWire:true},{foreignTurnWire:true}]){
    const f=await completionProjectionFixture(t,extra);const before=snapshot(f.home);
    const created=await operateProjectNativeHistory({action:"derive",provider:"claude",bundleRoot:f.captured.directory,root:f.root,threadIds:[f.threadId]});
    assert.equal(created.publicationReady,false);assert.ok(created.diagnostics.some(row=>row.code==="DERIVED_CANONICAL_WIRE_TOOL_DIVERGENCE"));
    assert.deepEqual(snapshot(f.home),before);
  }
});

test("source JSON preserves ordinary decimals/exponents and refuses silent numeric rounding while retaining quoted numbers", () => {
  for(const raw of ["0","1.0","0.100","1e3","1.20e-4","1E+003"]){assert.equal(typeof parseCodexSourceJson(raw),"number");}
  assert.equal(parseCodexSourceJson('{"value":"9007199254740993"}').value,"9007199254740993");
  for(const raw of ["9007199254740993","0.123456789012345678901","1e999","-0"]){assert.throws(()=>parseCodexSourceJson('{"value":'+raw+'}'),{code:"CODEX_SOURCE_NUMERIC_PRECISION_UNQUALIFIED"});}
});

test("project collection reuses exact row IDs across roster changes, isolates unsupported forks, and preserves continued targets", async t => {
  const f = await derivedFixture(t), sourceHome = path.join(f.f.base,"source-home");
  const state = new DatabaseSync(path.join(sourceHome,"state_5.sqlite"));
  try {
    state.prepare("INSERT INTO projects(id,name,metadata,position,created_at_ms,updated_at_ms) VALUES('collection-p','Synthetic collection','{}',0,0,0)").run();
    state.prepare("UPDATE threads SET project_id='collection-p',cwd=?").run(f.f.root);
  } finally { state.close(); }
  const offline = await prepareCodexNativeOffline({home:sourceHome,executable:path.join(f.f.base,"codex.exe"),probe:async()=>({status:"observed",rows:[]}),versionProbe:async()=>({status:"verified",version:nativeProfile.engineVersion})});
  const capture = destination => captureSyntheticHistory({witness:offline.witness,sourceProjectId:"collection-p",threadIds:[sourceThread,branchThread],destination:path.join(f.f.base,destination)});
  const captured = await capture("collection-source-first"), archive = path.join(f.f.base,"collection-archive"), target = path.join(f.f.base,"collection-workspace");
  fs.mkdirSync(archive);fs.mkdirSync(target);
  const workspaceMappings = [{sourceRoot:f.f.root,targetRoot:target}], sourceBefore=snapshot(sourceHome), p2Before=snapshot(f.f.root);
  const first = await operateProjectNativeHistory({action:"derive-project",provider:"claude",bundleRoot:captured.directory,collectionRoot:archive,workspaceMappings});
  assert.equal(first.rows.length,2);assert.equal(first.rows.find(row=>row.threadId===sourceThread).status,"ready");
  assert.equal(first.rows.find(row=>row.threadId===branchThread).status,"representation-incomplete");
  assert.equal(first.optionalLodeDataIncluded,false);assert.equal(first.workspaceFilesCopied,false);assert.equal(first.grantsRecoveryAuthority,false);
  assert.deepEqual(snapshot(sourceHome),sourceBefore);assert.deepEqual(snapshot(f.f.root),p2Before);assert.deepEqual(fs.readdirSync(target),[]);
  const extra = "01900000-0000-7000-8000-000000000777", changed = new DatabaseSync(path.join(sourceHome,"state_5.sqlite"));
  try {
    const columns=nativeProfile.databases.find(db=>db.file==="state_5.sqlite").tables.find(table=>table.name==="threads").columns;
    changed.prepare("INSERT INTO threads SELECT "+columns.map(column=>column.name==="id"?"?":'"'+column.name+'"').join(",")+" FROM threads WHERE id=?").run(extra,sourceThread);
  } finally {changed.close();}
  const later=await capture("collection-source-later");
  const second=deriveProjectConversationCollection({bundleRoot:later.directory,collectionRoot:archive,workspaceMappings});
  assert.notEqual(second.collectionId,first.collectionId);assert.deepEqual(second.uncapturedConversationIds,[extra]);
  for(const row of first.rows) {const next=second.rows.find(value=>value.threadId===row.threadId);assert.deepEqual(next.source,row.source);assert.deepEqual(next.derivation,row.derivation);}
  const ready=first.rows.find(row=>row.status==="ready"), rowBundle=path.join(archive,ready.source.relative);
  const artifact=inspectProjectNativeDerivation({bundleRoot:rowBundle,derivationId:ready.derivation.id,expectedDerivationDigest:ready.derivation.digest});
  const nativeHome=path.join(f.f.base,"collection-native-home");fs.mkdirSync(nativeHome);
  const args={action:"publish-project",provider:"claude",bundleRoot:archive,collectionId:first.collectionId,expectedCollectionDigest:first.collectionDigest,workspaceMappings,nativeHome,nativeHistoryHost:host(artifact)};
  const published=await operateProjectNativeHistory(args);
  assert.equal(published.results.find(row=>row.threadId===sourceThread).status,"native-derived-transcript-published");
  assert.equal(published.results.find(row=>row.threadId===branchThread).nativeEffectAttempted,false);
  assert.equal(Object.hasOwn(published,"nativeProfilePublished"),false);assert.equal(published.nativePublication.status,"partial-observed");
  assert.equal(published.nativePublication.prefixObservedRows,1);assert.equal(published.nativePublication.totalRows,2);assert.equal(published.nativePublication.skippedRows,1);
  assert.equal(published.officialReader.status,"not-requested");assert.equal(published.desktopVisibility,"not-observed");
  const destination=targetFile(nativeHome,artifact), followup={...artifact.rows.at(-1),uuid:crypto.randomUUID(),parentUuid:artifact.rows.at(-1).uuid};
  followup.message={role:"assistant",content:[{type:"text",text:"Synthetic continued target; preserve this observation."}],stop_reason:"end_turn"};
  fs.appendFileSync(destination,JSON.stringify(followup)+"\n");const continued=fs.readFileSync(destination);
  const repeated=await operateProjectNativeHistory({...args,collectionId:second.collectionId,expectedCollectionDigest:second.collectionDigest});
  assert.equal(repeated.results.find(row=>row.threadId===sourceThread).status,"native-derived-target-continued");assert.ok(fs.readFileSync(destination).equals(continued));
  assert.equal(repeated.nativePublication.prefixObservedRows,1);assert.equal(repeated.nativePublication.status,"partial-observed");
  const deniedHome=path.join(f.f.base,"denied-collection-profile");fs.mkdirSync(deniedHome);
  const deniedFile=targetFile(deniedHome,artifact);let denied;
  try {await operateProjectNativeHistory({...args,nativeHome:deniedHome,assertCurrentAuthority:()=>{if(fs.existsSync(deniedFile))throw Object.assign(new Error("Synthetic denial after target publication"),{code:"EPERM"});}});}catch(error){denied=error;}
  assert.equal(denied?.code,"EPERM");assert.equal(fs.existsSync(deniedFile),true);
  assert.equal(denied.partialResults.length,1);assert.equal(denied.partialResults[0].status,"native-derived-publication-uncertain");
  assert.equal(denied.collectionOperationResult.primaryFailure.code,"EPERM");assert.deepEqual(denied.collectionOperationResult.unvisitedThreadIds,[branchThread]);
  assert.equal(denied.collectionOperationResult.additionalObservationAfterFailure,false);assert.equal(denied.collectionOperationResult.automaticReplayAllowed,false);
  const mcpHome=path.join(f.f.base,"mcp-denied-collection-profile");fs.mkdirSync(mcpHome);
  const mcpFile=targetFile(mcpHome,artifact), originalLstat=fs.lstatSync;
  const archivePathKeys=new Set([archive,nativeRoot(archive)].map(value=>codexSourcePathKey(value)));
  let mcpDeniedOnce=false,mcpChecksAfterDenial=0;
  fs.lstatSync=function(file,...params){if(typeof file==="string"&&archivePathKeys.has(codexSourcePathKey(file))&&fs.existsSync(mcpFile)){if(!mcpDeniedOnce){mcpDeniedOnce=true;throw Object.assign(new Error("Synthetic one-shot denied archive check after publication"),{code:"EPERM"});}mcpChecksAfterDenial++;}return originalLstat.call(this,file,...params);};
  let mcpDenied;
  try {mcpDenied=await dispatch({jsonrpc:"2.0",id:11,method:"tools/call",params:{name:"lode_project_native_history",arguments:{action:"publish-project",provider:"claude",bundle_root:archive,collection_id:first.collectionId,expected_collection_digest:first.collectionDigest,workspace_mappings:workspaceMappings,native_home:mcpHome}}},{nativeHistoryHost:host(artifact)});} finally {fs.lstatSync=originalLstat;}
  assert.equal(fs.existsSync(mcpFile),true);assert.equal(mcpDenied.error.data.code,"EPERM");
  assert.equal(mcpDenied.error.data.partialNativeOperation.results[0].status,"native-derived-publication-uncertain");
  assert.equal(mcpChecksAfterDenial,0);
  const readonly=await runCommand(["project-native-history",archive,"--action","read-project","--collection",first.collectionId,"--expected-collection",first.collectionDigest]);
  assert.equal(readonly.collectionId,first.collectionId);
  const surface=catalogTools.find(tool=>tool.name==="lode_project_native_history");assert.ok(surface.inputSchema.properties.workspace_mappings);assert.ok(surface.inputSchema.properties.action.enum.includes("derive-project"));
  await assert.rejects(operateProjectNativeHistory({...args,workspaceMappings:[]}),{code:"COLLECTION_CURRENT_WORKSPACE_MAPPING_MISMATCH"});
  await assert.rejects(operateProjectNativeHistory({...args,expectedCollectionDigest:"a".repeat(64)}),{code:"COLLECTION_DIGEST_MISMATCH"});
  fs.appendFileSync(path.join(rowBundle,"objects",artifact.selected.native.payload.files[0].sha256+".bin"),"tamper");
  assert.throws(()=>readProjectConversationCollection({collectionRoot:archive,collectionId:first.collectionId,expectedCollectionDigest:first.collectionDigest}));
  assert.ok(fs.readFileSync(destination).equals(continued));assert.deepEqual(snapshot(f.f.root),p2Before);
});

test("project collection leaves only unmapped conversations pending, permits shared conversation targets, and never swallows permission denial", async t => {
  const f=await completionProjectionFixture(t), archive=path.join(f.base,"collection-archive");fs.mkdirSync(archive);
  const missing=deriveProjectConversationCollection({bundleRoot:f.captured.directory,collectionRoot:archive});
  assert.equal(missing.rows[0].status,"workspace-mapping-needed");assert.equal(missing.rows[0].derivation,null);assert.equal(missing.rows[0].targetRoot,null);
  const grouped=deriveProjectConversationCollection({bundleRoot:f.captured.directory,collectionRoot:archive,workspaceMappings:[{sourceRoot:f.root,targetRoot:f.root},{sourceRoot:path.join(f.base,"different-source"),targetRoot:f.root}]});
  assert.equal(grouped.rows[0].status,"ready");assert.deepEqual(fs.readdirSync(f.root),[]);
  const before=snapshot(archive);
  assert.throws(()=>deriveProjectConversationCollection({bundleRoot:f.captured.directory,collectionRoot:archive,workspaceMappings:[{sourceRoot:f.root,targetRoot:f.root}],assertCurrentAuthority:()=>{throw Object.assign(new Error("Synthetic current permission denied"),{code:"EPERM"});}}),{code:"EPERM"});
  assert.deepEqual(snapshot(archive),before);
  assert.throws(()=>deriveProjectConversationCollection({bundleRoot:f.captured.directory,collectionRoot:archive,signal:AbortSignal.abort()}),{code:"NATIVE_HISTORY_OPERATION_CANCELLED"});
  const ready=deriveProjectConversationCollection({bundleRoot:f.captured.directory,collectionRoot:archive,workspaceMappings:[{sourceRoot:f.root,targetRoot:f.root}]});
  const row=ready.rows[0], artifact=inspectProjectNativeDerivation({bundleRoot:path.join(archive,row.source.relative),derivationId:row.derivation.id,expectedDerivationDigest:row.derivation.digest});
  const nativeHome=path.join(f.base,"collection-profile");fs.mkdirSync(nativeHome);
  const args={bundleRoot:archive,collectionId:ready.collectionId,expectedCollectionDigest:ready.collectionDigest,workspaceMappings:[{sourceRoot:f.root,targetRoot:f.root}],nativeHome,nativeHistoryHost:host(artifact)};
  const published=await operateProjectNativeHistory({...args,action:"publish-project"});assert.equal(published.nativePublication.status,"all-observed");assert.equal(published.nativePublication.prefixObservedRows,1);
  const verified=await operateProjectNativeHistory({...args,action:"verify-project"});assert.equal(verified.nativePublication.status,"all-observed");assert.equal(verified.officialReader.status,"all-observed");assert.equal(verified.officialReader.completeRows,1);
  assert.equal(verified.modelContextUse,"not-tested");assert.equal(verified.taskCompletionJudged,false);
});

test("project entry connects optional code/docs copying without overwrite or private reads and reuses its exact original plan", async t => {
  const f=await completionProjectionFixture(t), target=path.join(f.base,"copied-workspace");
  fs.mkdirSync(path.join(f.root,"src"));fs.mkdirSync(path.join(f.root,"docs"));
  fs.writeFileSync(path.join(f.root,"src/app.mjs"),"export const synthetic = 1;\n");fs.writeFileSync(path.join(f.root,"docs/use.md"),"# Synthetic usage\n");fs.writeFileSync(path.join(f.root,".env"),"PRIVATE_MUST_NOT_COPY=synthetic");
  const scope={sourceRoot:f.root,targetRoot:target,mode:"copy",paths:["src/app.mjs","docs/use.md",".env"]};
  const args={provider:"claude",bundleRoot:f.captured.directory,workspaceTransfers:[scope]};
  const prepared=await operateProjectNativeHistory({...args,action:"prepare-workspaces"});
  assert.equal(prepared.results[0].excludedFileCount,1);assert.equal(fs.existsSync(target),false);
  const transfer={...scope,plan:prepared.results[0].plan,expectedPlanDigest:prepared.results[0].planDigest};
  const copied=await operateProjectNativeHistory({...args,action:"copy-workspaces",workspaceTransfers:[transfer]});
  assert.equal(copied.nativeProfilesWritten,false);assert.equal(copied.runnableProjectVerified,false);assert.equal(fs.existsSync(path.join(target,".env")),false);
  assert.equal(fs.readFileSync(path.join(target,"src/app.mjs"),"utf8"),"export const synthetic = 1;\n");
  fs.writeFileSync(path.join(target,"docs/use.md"),"Preserve this target edit");
  const repeated=await operateProjectNativeHistory({...args,action:"copy-workspaces",workspaceTransfers:[transfer]});
  assert.equal(repeated.results[0].status,"workspace-transfer-partial");assert.equal(fs.readFileSync(path.join(target,"docs/use.md"),"utf8"),"Preserve this target edit");
  assert.equal(fs.existsSync(path.join(target,".lode")),false);
  const archive=path.join(f.base,"copied-collection");fs.mkdirSync(archive);
  const collection=await operateProjectNativeHistory({action:"derive-project",bundleRoot:f.captured.directory,collectionRoot:archive,workspaceMappings:[{sourceRoot:f.root,targetRoot:target}]});
  assert.equal(collection.rows[0].status,"ready");assert.equal(collection.rows[0].targetRoot,nativeRoot(target));
  await assert.rejects(operateProjectNativeHistory({...args,action:"copy-workspaces",workspaceTransfers:[{...transfer,expectedPlanDigest:"a".repeat(64)}]}),{code:"WORKSPACE_TRANSFER_PLAN_INVALID"});
  await assert.rejects(operateProjectNativeHistory({...args,action:"copy-workspaces",workspaceTransfers:[transfer],assertCurrentAuthority:()=>false}),{code:"NATIVE_HISTORY_AUTHORITY_DENIED"});
});

test("project entry archives selected existing Lode Session originals without merging owners, importing P2, or claiming all Sessions", async t => {
  const f=await derivedFixture(t), sourceHome=path.join(f.f.base,"source-home"), state=new DatabaseSync(path.join(sourceHome,"state_5.sqlite"));
  try {state.prepare("INSERT INTO projects(id,name,metadata,position,created_at_ms,updated_at_ms) VALUES('lode-companion-p','Synthetic native project','{}',0,0,0)").run();state.prepare("UPDATE threads SET project_id='lode-companion-p',cwd=?").run(f.f.root);} finally{state.close();}
  const offline=await prepareCodexNativeOffline({home:sourceHome,executable:path.join(f.f.base,"codex.exe"),probe:async()=>({status:"observed",rows:[]}),versionProbe:async()=>({status:"verified",version:nativeProfile.engineVersion})});
  const captured=await captureSyntheticHistory({witness:offline.witness,sourceProjectId:"lode-companion-p",threadIds:[sourceThread],destination:path.join(f.f.base,"lode-companion-capture")});
  const archive=path.join(f.f.base,"lode-companion-collection"), target=path.join(f.f.base,"lode-companion-target");fs.mkdirSync(archive);fs.mkdirSync(target);
  const collection=await operateProjectNativeHistory({action:"derive-project",bundleRoot:captured.directory,collectionRoot:archive,workspaceMappings:[{sourceRoot:f.f.root,targetRoot:target}]});
  const originals=snapshot(f.f.root), bundleBefore=snapshot(f.bundleRoot);
  const args={action:"attach-project-lode",bundleRoot:archive,collectionId:collection.collectionId,expectedCollectionDigest:collection.collectionDigest,
    lodeBundles:[{bundleRoot:f.bundleRoot,expectedBundleId:f.bundle.bundleId,expectedManifestDigest:f.bundle.manifestSha256,threadIds:[sourceThread]}]};
  const attached=await operateProjectNativeHistory(args);
  assert.equal(attached.evidence.imported,false);assert.equal(attached.evidence.allLogicalSessionsIncluded,false);assert.equal(attached.evidence.logicalOwnersMerged,false);
  assert.equal(attached.evidence.grantsRecoveryAuthority,false);assert.equal(attached.evidence.bundles[0].selectedSessionId,JSON.parse(fs.readFileSync(path.join(f.bundleRoot,"manifest.json"))).selectedSessionId);
  const repeated=await operateProjectNativeHistory(args);assert.equal(repeated.attachmentDigest,attached.attachmentDigest);
  assert.deepEqual(snapshot(f.f.root),originals);assert.deepEqual(snapshot(f.bundleRoot),bundleBefore);
  assert.equal(readProjectConversationCollection({collectionRoot:archive,collectionId:collection.collectionId}).optionalLodeDataIncluded,false); // immutable base, companion is separate evidence
  const next=attached.nextActions[0];assert.equal(next.recoveryStatus,"archived-not-imported-or-recovered");assert.equal(next.import.executed,false);assert.equal(next.import.arguments.target_root,nativeRoot(target));
  const imported=await runCommand(["project-import",target,"--bundle",next.import.arguments.bundle_root,"--expected-bundle",next.import.arguments.expected_bundle_id]);
  assert.equal(imported.status,"imported");assert.equal(imported.restoresExecutionPermission,false);assert.equal(imported.nativeBindingTransferred,false);
  assert.equal(imported.nextRead.sessionId,attached.evidence.bundles[0].selectedSessionId);
  const entered=await runCommand(["conversation-enter",target,"--session",imported.selectedSessionId]);
  assert.ok(JSON.stringify(entered).includes("Missing sensor map remains unresolved"));assert.ok(JSON.stringify(entered).includes("deployment"));
  const recovered=withSessionRoute(target,imported.selectedSessionId,()=>readRecoveryCheckpoint({root:target,checkpointId:f.checkpoint.checkpointId}));
  assert.equal(recovered.checkpoint.checkpointDigest,f.checkpoint.checkpointDigest);
  assert.deepEqual(snapshot(f.f.root),originals);assert.deepEqual(snapshot(f.bundleRoot),bundleBefore);
  await assert.rejects(operateProjectNativeHistory({...args,lodeBundles:[{...args.lodeBundles[0],threadIds:[branchThread]}]}),{code:"COLLECTION_LODE_SCOPE_INVALID"});
  await assert.rejects(operateProjectNativeHistory({...args,lodeBundles:[{...args.lodeBundles[0],expectedManifestDigest:"a".repeat(64)}]}),{code:"COLLECTION_LODE_BUNDLE_CHANGED"});
});

test("one-shot native permission denial and cancellation preserve the first error with zero later checks or reads in publish and verify", async t => {
  const f=await completionProjectionFixture(t), archive=path.join(f.base,"one-shot-archive");fs.mkdirSync(archive);
  const workspaceMappings=[{sourceRoot:f.root,targetRoot:f.root}];
  const collection=deriveProjectConversationCollection({bundleRoot:f.captured.directory,collectionRoot:archive,workspaceMappings});
  const row=collection.rows[0],artifact=inspectProjectNativeDerivation({bundleRoot:path.join(archive,row.source.relative),derivationId:row.derivation.id,expectedDerivationDigest:row.derivation.digest});
  for(const action of ["publish-project","verify-project"])for(const code of ["EPERM","EACCES","cancel"]){
    const nativeHome=path.join(f.base,"once-"+action+"-"+code);fs.mkdirSync(nativeHome);
    const baseArgs={bundleRoot:archive,collectionId:collection.collectionId,expectedCollectionDigest:collection.collectionDigest,workspaceMappings,nativeHome,nativeHistoryHost:host(artifact)};
    if(action==="verify-project")await operateProjectNativeHistory({...baseArgs,action:"publish-project"});
    const file=targetFile(nativeHome,artifact),controller=new AbortController();
    let denied=false,checksAfterDenial=0,readsAfterDenial=0,readerReturned=false,primary,firstError;
    const originalOpen=fs.openSync,originalLstat=fs.lstatSync;
    const covered=p=>typeof p==="string"&&[archive,nativeHome].some(root=>{const rel=path.relative(root,p);return rel===""||rel!==".."&&!rel.startsWith(".."+path.sep)&&!path.isAbsolute(rel);});
    fs.openSync=function(p,...args){if(denied&&covered(p))readsAfterDenial++;return originalOpen.call(this,p,...args);};
    fs.lstatSync=function(p,...args){if(denied&&covered(p))readsAfterDenial++;return originalLstat.call(this,p,...args);};
    const h=host(artifact), wrapped={...h,readDerivedClaude:async args=>{const value=await h.readDerivedClaude(args);readerReturned=true;return value;}};
    try {await operateProjectNativeHistory({...baseArgs,action,nativeHistoryHost:wrapped,signal:controller.signal,assertCurrentAuthority:()=>{
      if(denied){checksAfterDenial++;return;}
      if(action==="verify-project"?readerReturned:fs.existsSync(file)){
        denied=true;if(code==="cancel"){controller.abort();return;}firstError=Object.assign(new Error("Synthetic one-shot denial"),{code});throw firstError;
      }
    }});}catch(error){primary=error;}finally{fs.openSync=originalOpen;fs.lstatSync=originalLstat;}
    assert.equal(denied,true);
    if(code==="cancel")assert.ok(["PROJECT_COPY_CANCELLED","NATIVE_HISTORY_OPERATION_CANCELLED"].includes(primary?.code));
    else {assert.equal(primary,firstError);assert.equal(primary.code,code);}
    assert.equal(checksAfterDenial,0,action+" "+code);assert.equal(readsAfterDenial,0,action+" "+code);assert.equal(fs.existsSync(file),true);
    assert.equal(primary.collectionOperationResult.additionalObservationAfterFailure,false);assert.equal(primary.partialResults.length,1);
    assert.equal(primary.collectionOperationResult.primaryFailure.code,primary.code);
    assert.equal(primary.partialResults[0].status,action==="publish-project"?"native-derived-publication-uncertain":"native-derived-verification-unconfirmed");
    assert.deepEqual(primary.collectionOperationResult.unvisitedThreadIds,[]);assert.equal(primary.collectionOperationResult.automaticReplayAllowed,false);
  }
});

test("captured fork prefixes reach public derive as raw semantic evidence without parent future, siblings, fake DB rows or P2", async t => {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),"lode-physical-semantic-"));
  t.after(()=>{if(path.dirname(fs.realpathSync(base))!==fs.realpathSync(os.tmpdir()))throw Error("Unexpected cleanup root");fs.rmSync(base,{recursive:true,force:true});});
  const parentId="01900000-0000-7000-8000-000000000951",childId="01900000-0000-7000-8000-000000000952";
  const parentPhysical="01900000-0000-7000-8000-000000000961",childPhysical="01900000-0000-7000-8000-000000000962";
  const parent=[{ordinal:0,type:"session_meta",payload:{id:parentId,session_id:parentId,cli_version:nativeProfile.engineVersion,history_mode:"paginated"}},
    {ordinal:1,type:"event_msg",payload:{type:"task_started",turn_id:"parent-turn"}},
    {ordinal:2,type:"event_msg",payload:{type:"item_completed",thread_id:parentId,turn_id:"parent-turn",item:{type:"UserMessage",id:"parent-user",content:[{type:"text",text:"Inherited marker ECHO-514; earlier deployment was provisional."}]}}},
    {ordinal:3,type:"event_msg",payload:{type:"item_completed",thread_id:parentId,turn_id:"parent-turn",item:{type:"AgentMessage",id:"parent-agent",content:[{type:"Text",text:"Retain the rejected rebuild reason and unresolved inventory check."}]}}},
    {ordinal:4,type:"event_msg",payload:{type:"task_complete",turn_id:"parent-turn"}}];
  const encode=frames=>Buffer.from(frames.map(frame=>JSON.stringify(frame)).join("\n")+"\n"), parentPrefix=encode(parent);
  const make=(extra={})=>{
    const frames=[],frame=(type,payload)=>{const ordinal=5+frames.length;frames.push({ordinal,type,payload});};
    frame("session_meta",{id:childId,session_id:parentId,cli_version:nativeProfile.engineVersion,history_mode:"paginated",forked_from_id:parentId,forked_from_ordinal_exclusive:5,
      history_base:{thread_id:parentPhysical,end_ordinal_exclusive:5,end_byte_offset:parentPrefix.length}});
    if(!extra.withoutStart)frame("event_msg",{type:"task_started",turn_id:"child-turn"});
    if(extra.overlappingStart)frame("event_msg",{type:"task_started",turn_id:"overlapping-turn"});
    const complete=item=>frame("event_msg",{type:"item_completed",thread_id:childId,turn_id:extra.foreignTurn?"other-turn":"child-turn",item});
    complete({type:"UserMessage",id:"child-user",content:[{type:"text",text:"Latest child condition: read only; deployment cancelled. Preserve ECHO-514."}]});
    if(extra.foreignUser)frames.at(-1).payload.turn_id="ghost-turn";
    const output={content:[{type:"text",text:"Synthetic tool observation"}]};
    frame("response_item",{type:"function_call",call_id:"fork-call",name:"read_snapshot",namespace:"observations",arguments:'{"key":"synthetic"}'});
    frame("response_item",{type:"function_call_output",call_id:"fork-call",output:JSON.stringify(output)});
    if(extra.foreignTurn){frame("event_msg",{type:"task_complete",turn_id:"child-turn"});frame("event_msg",{type:"task_started",turn_id:"other-turn"});}
    complete({type:"McpToolCall",id:"fork-call",server:"observations",tool:"read_snapshot",arguments:{key:"synthetic"},status:"completed",result:output,error:null});
    if(extra.rollback)frame("event_msg",{type:"thread_rolled_back",num_turns:1});
    complete({type:"AgentMessage",id:"child-agent",content:[{type:"Text",text:"Child condition retained. Pending inventory check; no deployment."}]});
    if(extra.foreignAssistant)frames.at(-1).payload.turn_id="ghost-turn";
    if(!extra.inProgress)frame("event_msg",{type:"task_complete",turn_id:extra.mismatchedEnd?"ghost-turn":extra.foreignTurn?"other-turn":"child-turn"});
    return encode(frames);
  };
  const target=path.join(base,"workspace");fs.mkdirSync(target);
  for(const [name,extra]of [["valid",{}],["foreign",{foreignTurn:true}],["rollback",{rollback:true}],
    ["foreign-user",{foreignUser:true}],["foreign-assistant",{foreignAssistant:true}],["without-start",{withoutStart:true}],
    ["overlapping-start",{overlappingStart:true}],["mismatched-end",{mismatchedEnd:true}],["in-progress",{inProgress:true}]]){
    const archive=path.join(base,name);fs.mkdirSync(archive);
    const parentRaw=Buffer.concat([parentPrefix,Buffer.from("{INVALID_UNSELECTED_PARENT_FUTURE}\n")]),childRaw=make(extra);
    const originals=[{rolloutId:parentPhysical,threadId:parentId,raw:parentRaw,sha256:hash(parentRaw)},{rolloutId:childPhysical,threadId:childId,raw:childRaw,sha256:hash(childRaw)},
      {rolloutId:"01900000-0000-7000-8000-000000000999",threadId:parentId,raw:Buffer.from("INVALID_UNSELECTED_SIBLING"),sha256:"0".repeat(64)}];
    const archived=archiveCodexCapturedPhysicalSource({directory:archive,threadId:childId,rolloutId:childPhysical,originals});
    assert.equal(archived.physicalSegmentCount,2);assert.equal(fs.readdirSync(path.join(archive,"objects")).length,2);
    const source=inspectCodexCapturedPhysicalSource({directory:archive});assert.equal(source.payload.canonicalDatabaseRowsClaimed,false);
    assert.equal(source.payload.files.find(file=>file.rolloutId===parentPhysical).bytes,parentPrefix.length);
    const created=await operateProjectNativeHistory({action:"derive",provider:"claude",bundleRoot:archive,root:target,threadIds:[childId]});
    const artifact=inspectProjectNativeDerivation({bundleRoot:archive,derivationId:created.derivationId,expectedDerivationDigest:created.derivationDigest});
    assert.equal(artifact.manifest.input.converter,"codex-claude-physical-v3");assert.equal(artifact.manifest.source.kind,"captured-physical");
    const titleRecord=JSON.parse(artifact.raw.toString("utf8").trimEnd().split("\n").at(-1));assert.equal(titleRecord.type,"custom-title");assert.equal(titleRecord.customTitle,artifact.manifest.displayMetadata.title);assert.ok(titleRecord.customTitle.includes(childId));assert.equal(artifact.manifest.displayMetadata.recordedForkedFromId,parentId);assert.ok(artifact.rows.every(row=>row.type!=="custom-title"));
    assert.equal(artifact.manifest.publicationReady,["valid","in-progress"].includes(name),name+": "+JSON.stringify(artifact.diagnostics));
    if(name==="in-progress"){assert.equal(artifact.manifest.openSafety.structurallySettled,false);assert.equal(artifact.manifest.openSafety.sourceLifecycle.terminalAtCapture,false);}
    if(["foreign-user","foreign-assistant","without-start","overlapping-start"].includes(name))assert.ok(artifact.diagnostics.some(row=>row.code==="PHYSICAL_ITEM_TURN_UNQUALIFIED"));
    if(name==="mismatched-end")assert.ok(artifact.diagnostics.some(row=>row.code==="PHYSICAL_TASK_BOUNDARY_UNQUALIFIED"));
    assert.equal(artifact.raw.includes(Buffer.from("INVALID_UNSELECTED")),false);
    if(name==="valid"){
      const userText=artifact.rows.filter(row=>row.type==="user").flatMap(row=>row.message.content).filter(part=>part.type==="text").map(part=>part.text).join("\n");
      assert.equal(userText.split("Inherited marker ECHO-514").length-1,1);assert.ok(userText.includes("deployment cancelled"));
      assert.ok(artifact.mapping.some(row=>row.source?.physicalRolloutId===parentPhysical));assert.ok(artifact.mapping.some(row=>row.source?.physicalRolloutId===childPhysical));
      assert.ok(artifact.mapping.every(row=>row.source?.table!=="thread_items"));
      const repeat=await operateProjectNativeHistory({action:"derive",bundleRoot:archive,root:target,threadIds:[childId]});assert.equal(repeat.derivationDigest,created.derivationDigest);
      const changedFuture=Buffer.concat([parentPrefix,Buffer.from("{DIFFERENT_EXCLUDED_PARENT_FUTURE}\n")]);
      const repeatedArchive=archiveCodexCapturedPhysicalSource({directory:archive,threadId:childId,rolloutId:childPhysical,
        originals:[{...originals[0],raw:changedFuture,sha256:hash(changedFuture)},...originals.slice(1)]});
      assert.equal(repeatedArchive.payloadDigest,archived.payloadDigest);
      const capturedFiles=path.join(base,"captured-jsonl");fs.mkdirSync(capturedFiles);
      const names=[parentPhysical,childPhysical,"01900000-0000-7000-8000-000000000999"].map(id=>"rollout-synthetic-"+id+".jsonl");
      [parentRaw,childRaw,Buffer.from("PRIVATE_UNSELECTED_SIBLING")].forEach((raw,index)=>fs.writeFileSync(path.join(capturedFiles,names[index]),raw));
      const descriptors=[{path:names[0],rolloutId:parentPhysical,threadId:parentId,endByteOffset:parentPrefix.length,sha256:hash(parentPrefix)},
        {path:names[1],rolloutId:childPhysical,threadId:childId,endByteOffset:childRaw.length,sha256:hash(childRaw)},
        {path:names[2],rolloutId:"01900000-0000-7000-8000-000000000999",threadId:parentId,endByteOffset:10,sha256:"0".repeat(64)}];
      const capturedCanonical=nativeRoot(capturedFiles),capturedPathKeys=index=>new Set([path.join(capturedFiles,names[index]),path.join(capturedCanonical,names[index])].map(value=>codexSourcePathKey(value))),capturedParentKeys=capturedPathKeys(0),capturedSiblingKeys=capturedPathKeys(2);
      const open=fs.openSync,read=fs.readSync,close=fs.closeSync,fdPaths=new Map();let siblingReads=0,parentBytes=0,parentOverread=0;
      fs.openSync=function(file,...args){if(capturedSiblingKeys.has(codexSourcePathKey(String(file)))){siblingReads++;throw Error("Unselected sibling opened");}const fd=open.call(this,file,...args);fdPaths.set(fd,codexSourcePathKey(String(file)));return fd;};
      fs.readSync=function(fd,buffer,offset,length,position){if(capturedParentKeys.has(fdPaths.get(fd))){if(position+length>parentPrefix.length)parentOverread++;const count=read.call(this,fd,buffer,offset,length,position);parentBytes+=count;return count;}return read.call(this,fd,buffer,offset,length,position);};
      fs.closeSync=function(fd){fdPaths.delete(fd);return close.call(this,fd);};
      let capturedCli,capturedMcp;
      try{
        capturedCli=await runCommand(["project-native-history",path.join(base,"physical-cli"),"--action","capture-physical","--provider","codex","--threads",childId,
          "--physical-source-root",capturedFiles,"--physical-rollout",childPhysical,"--physical-files",JSON.stringify(descriptors)]);
        capturedMcp=await dispatch({jsonrpc:"2.0",id:52,method:"tools/call",params:{name:"lode_project_native_history",arguments:{action:"capture-physical",provider:"codex",bundle_root:path.join(base,"physical-mcp"),thread_ids:[childId],physical_source_root:capturedFiles,physical_rollout_id:childPhysical,physical_files:descriptors}}});
      }finally{fs.openSync=open;fs.readSync=read;fs.closeSync=close;}
      assert.equal(capturedCli.payloadDigest,archived.payloadDigest);assert.equal(capturedMcp.result.structuredContent.payloadDigest,archived.payloadDigest);
      assert.equal(siblingReads,0);assert.equal(parentOverread,0);assert.equal(parentBytes,2*parentPrefix.length);
      const cliDerived=await runCommand(["project-native-history",capturedCli.directory,"--action","derive","--provider","claude","--threads",childId,"--runtime-root",target]);
      assert.equal(cliDerived.target.nativeId,created.target.nativeId);
      const state=syntheticNativeDatabase(t,"state_5.sqlite",path.join(base,"captured-state.sqlite"));
      const originalWorkspace=path.join(base,"original-workspace");fs.mkdirSync(originalWorkspace);
      let stateEvidence,parentStateEvidence,catalog;
      try{
        state.row("projects",{id:"physical-project",name:"Synthetic captured Project",metadata:"{}"});
        for(const [id,index]of [[parentId,0],[childId,1]])state.row("threads",{id,title:"Shared historical title",project_id:"physical-project",cwd:id===parentId?originalWorkspace:target,source:"cli",archived:0n,
          attached_thread_parent_id:id===childId?parentId:null,rollout_path:path.join(capturedFiles,names[index]),cli_version:nativeProfile.engineVersion,history_mode:"paginated"});
        stateEvidence=readSelectedCodexStateEvidence(state.db,[childId]);parentStateEvidence=readSelectedCodexStateEvidence(state.db,[parentId]);catalog=readCodexProjectCatalog(state.db,"physical-project");
      }finally{state.close();}
      const evidenceFile=path.join(base,"selected-state.json"),catalogFile=path.join(base,"captured-catalog.json");
      fs.writeFileSync(evidenceFile,JSON.stringify(stateEvidence,null,2)+"\n");fs.writeFileSync(catalogFile,JSON.stringify(catalog,null,2)+"\n");
      const stateDigest=hash(fs.readFileSync(evidenceFile)),catalogDigest=hash(fs.readFileSync(catalogFile));
      const workspaceArgs={catalogFile,expectedCatalogDigest:catalogDigest,workspaceTransfers:[{sourceRoot:originalWorkspace,targetRoot:path.join(base,"copied-catalog-workspace"),mode:"copy",paths:["guide.md"]}]};
      fs.writeFileSync(path.join(originalWorkspace,"guide.md"),"Synthetic captured Project guide\n");
      const prepared=await operateProjectNativeHistory({...workspaceArgs,action:"prepare-workspaces"});
      assert.equal(fs.existsSync(workspaceArgs.workspaceTransfers[0].targetRoot),false);
      const copied=await operateProjectNativeHistory({...workspaceArgs,action:"copy-workspaces",workspaceTransfers:[{...workspaceArgs.workspaceTransfers[0],plan:prepared.results[0].plan,expectedPlanDigest:prepared.results[0].planDigest}]});
      assert.equal(copied.results[0].status,"workspace-selected-files-verified");assert.equal(fs.readFileSync(path.join(workspaceArgs.workspaceTransfers[0].targetRoot,"guide.md"),"utf8"),"Synthetic captured Project guide\n");
      const bound=await operateProjectNativeHistory({action:"capture-physical",provider:"codex",bundleRoot:path.join(base,"bound-physical"),threadIds:[childId],
        physicalSourceRoot:capturedFiles,physicalRolloutId:childPhysical,physicalFiles:descriptors,selectedStateEvidenceFile:evidenceFile,expectedSelectedStateDigest:stateDigest});
      assert.equal(bound.selectionBindingStatus,"captured-state-path-verified");
      const boundSource=inspectCodexCapturedPhysicalSource({directory:bound.directory});
      assert.equal(boundSource.selectionBinding.stableNativeThreadId,childId);assert.equal(boundSource.selectionBinding.physicalRolloutId,childPhysical);assert.equal(boundSource.selectionBinding.rootSessionId,parentId);
      const projectRoot=path.join(base,"captured-project-collection");fs.mkdirSync(projectRoot);
      const workspaceMappings=[{sourceRoot:target,targetRoot:target}],assemblyArgs={action:"assemble-project",provider:"claude",bundleRoot:projectRoot,catalogFile,expectedCatalogDigest:catalogDigest,workspaceMappings};
      const assembled=await operateProjectNativeHistory({...assemblyArgs,physicalSources:[{threadId:childId,directory:bound.directory,expectedPayloadDigest:bound.payloadDigest}]});
      assert.equal(assembled.rows.find(row=>row.threadId===childId).status,"retained-derivation-reference-needed");assert.equal(assembled.rows.find(row=>row.threadId===parentId).status,"source-not-supplied");
      assert.equal(assembled.physicalBodiesIncluded,false);assert.deepEqual(fs.readdirSync(projectRoot),["collections"]);
      assert.equal(assembled.sourceAssociationScope,"captured-catalog-and-separate-physical-capture; not-one-snapshot-or-current-native-inventory");
      const proposed=await operateProjectNativeHistory({...assemblyArgs,physicalSources:[{threadId:childId,directory:capturedCli.directory,expectedPayloadDigest:capturedCli.payloadDigest}]});
      assert.equal(proposed.rows.find(row=>row.threadId===childId).status,"association-proposed");
      let nativeCalls=0;
      const blocked=await operateProjectNativeHistory({action:"publish-project",bundleRoot:projectRoot,collectionId:proposed.collectionId,expectedCollectionDigest:proposed.collectionDigest,workspaceMappings,
        nativeHistoryHost:{provider:"claude",version:async()=>{nativeCalls++;throw Error("Proposed associations must not touch native profiles");}}});
      assert.equal(nativeCalls,0);assert.equal(blocked.nativePublication.prefixObservedRows,0);
      const staleEvidence=structuredClone(stateEvidence),pathIndex=staleEvidence.columns.indexOf("rollout_path"),missingPath=path.join(capturedFiles,"missing-"+childPhysical+".jsonl");
      staleEvidence.rows[0][pathIndex]={type:"text",value:missingPath,utf8:Buffer.from(missingPath).toString("base64")};
      const staleFile=path.join(base,"stale-selected-state.json");fs.writeFileSync(staleFile,JSON.stringify(staleEvidence,null,2)+"\n");
      const staleCaptureArgs={action:"capture-physical",provider:"codex",bundleRoot:path.join(base,"stale-bound-physical"),threadIds:[childId],physicalSourceRoot:capturedFiles,physicalRolloutId:childPhysical,physicalFiles:descriptors,selectedStateEvidenceFile:staleFile,expectedSelectedStateDigest:hash(fs.readFileSync(staleFile))};
      const staleCapture=await operateProjectNativeHistory(staleCaptureArgs);assert.equal(staleCapture.selectionBindingStatus,"association-proposed");
      const staleAssembly=await operateProjectNativeHistory({...assemblyArgs,physicalSources:[{threadId:childId,directory:staleCapture.directory,expectedPayloadDigest:staleCapture.payloadDigest}]});
      assert.equal(staleAssembly.rows.find(row=>row.threadId===childId).status,"association-proposed");
      await assert.rejects(operateProjectNativeHistory({...staleCaptureArgs,bundleRoot:path.join(base,"stale-digest-rejected"),expectedSelectedStateDigest:"f".repeat(64)}),{code:"PHYSICAL_STATE_EVIDENCE_CHANGED"});
      const missingPathKeys=new Set([missingPath,path.join(capturedCanonical,path.basename(missingPath))].map(value=>codexSourcePathKey(value)));
      const originalLstat=fs.lstatSync,denial=Object.assign(new Error("Synthetic state-path permission denied"),{code:"EPERM"});let missingDeniedHits=0;
      fs.lstatSync=function(file,...args){if(missingPathKeys.has(codexSourcePathKey(String(file)))){missingDeniedHits++;throw denial;}return originalLstat.call(this,file,...args);};
      try{await assert.rejects(operateProjectNativeHistory({...staleCaptureArgs,bundleRoot:path.join(base,"stale-permission-rejected")}),error=>error===denial);}finally{fs.lstatSync=originalLstat;}assert.equal(missingDeniedHits,1);
      const parentEvidenceFile=path.join(base,"parent-selected-state.json");fs.writeFileSync(parentEvidenceFile,JSON.stringify(parentStateEvidence,null,2)+"\n");
      const parentBound=await operateProjectNativeHistory({action:"capture-physical",provider:"codex",bundleRoot:path.join(base,"parent-bound-physical"),threadIds:[parentId],physicalSourceRoot:capturedFiles,physicalRolloutId:parentPhysical,physicalFiles:[descriptors[0]],selectedStateEvidenceFile:parentEvidenceFile,expectedSelectedStateDigest:hash(fs.readFileSync(parentEvidenceFile))});
      const grouped=await operateProjectNativeHistory({...assemblyArgs,workspaceMappings:[...workspaceMappings,{sourceRoot:originalWorkspace,targetRoot:target}],physicalSources:[{threadId:parentId,directory:parentBound.directory,expectedPayloadDigest:parentBound.payloadDigest},{threadId:childId,directory:bound.directory,expectedPayloadDigest:bound.payloadDigest}]});
      assert.equal(grouped.rows.filter(row=>row.status==="retained-derivation-reference-needed").length,2);assert.equal(new Set(grouped.rows.map(row=>row.targetRoot)).size,1);assert.equal(new Set(grouped.rows.map(row=>row.retainedDerivation.nativeId)).size,2);
      const groupedTitles=grouped.rows.map(row=>inspectProjectNativeDerivation({bundleRoot:row.retainedDerivation.directoryHint,derivationId:row.retainedDerivation.id}).manifest.displayMetadata.title);assert.equal(new Set(groupedTitles).size,2);assert.ok(groupedTitles.every(title=>title.startsWith("Codex conversation · ")));
      await assert.rejects(operateProjectNativeHistory({action:"prepare-workspaces",catalogFile,expectedCatalogDigest:catalogDigest,workspaceTransfers:[{sourceRoot:originalWorkspace,targetRoot:workspaceArgs.workspaceTransfers[0].targetRoot,mode:"copy",paths:["guide.md"]},{sourceRoot:target,targetRoot:workspaceArgs.workspaceTransfers[0].targetRoot,mode:"copy",paths:[]}]}),{code:"COLLECTION_WORKTREES_CANNOT_BE_FLATTENED"});
      const readyRow=assembled.rows.find(row=>row.threadId===childId),retainedSource={threadId:childId,directory:bound.directory,expectedDerivationDigest:readyRow.retainedDerivation.digest},assembledArtifact=inspectProjectNativeDerivation({bundleRoot:bound.directory,derivationId:readyRow.retainedDerivation.id});
      const profile=path.join(base,"assembled-profile");fs.mkdirSync(profile);
      const publishArgs={action:"publish-project",bundleRoot:projectRoot,collectionId:assembled.collectionId,expectedCollectionDigest:assembled.collectionDigest,workspaceMappings,nativeHome:profile,nativeHistoryHost:host(assembledArtifact)};
      const unscoped=await operateProjectNativeHistory(publishArgs);assert.equal(unscoped.nativePublication.skippedRows,2);assert.equal(fs.readdirSync(profile).length,0);
      const published=await operateProjectNativeHistory({...publishArgs,retainedDerivationSources:[retainedSource]});
      assert.equal(published.nativePublication.prefixObservedRows,1);assert.equal(published.nativePublication.skippedRows,1);
      const continued=Buffer.concat([fs.readFileSync(targetFile(profile,assembledArtifact)),Buffer.from('{"type":"synthetic-target-continuation"}\n')]);fs.writeFileSync(targetFile(profile,assembledArtifact),continued);
      const reused=await operateProjectNativeHistory({...publishArgs,retainedDerivationSources:[retainedSource]});assert.equal(reused.results.find(row=>row.threadId===childId).status,"native-derived-target-continued");assert.ok(fs.readFileSync(targetFile(profile,assembledArtifact)).equals(continued));
      const missing=await operateProjectNativeHistory({...publishArgs,retainedDerivationSources:[{...retainedSource,directory:path.join(base,"source-not-present")} ]});assert.equal(missing.results.find(row=>row.threadId===childId).status,"retained-source-unavailable");
      const clone=path.join(base,"unqualified-store-clone");fs.cpSync(bound.directory,clone,{recursive:true});
      await assert.rejects(operateProjectNativeHistory({...publishArgs,retainedDerivationSources:[{...retainedSource,directory:clone}]}),{code:"COLLECTION_RETAINED_PUBLICATION_STORE_CHANGED"});
      const unknownProfile=path.join(base,"unknown-assembled-profile");fs.mkdirSync(unknownProfile);let attempts=0;
      const unknown=await publishClaudeDerived({artifact:assembledArtifact,nativeHome:unknownProfile,root:target,host:host(assembledArtifact),publishFile:()=>{attempts++;throw Object.assign(new Error("Synthetic lost publication before observation"),{code:"SYNTHETIC_UNKNOWN"});}});
      assert.equal(unknown.status,"native-derived-publication-uncertain");assert.equal(attempts,1);
      const unknownBatch=await operateProjectNativeHistory({...publishArgs,nativeHome:unknownProfile,retainedDerivationSources:[retainedSource]});assert.equal(unknownBatch.results.find(row=>row.threadId===childId).status,"native-derived-publication-uncertain");assert.equal(fs.existsSync(targetFile(unknownProfile,assembledArtifact)),false);assert.equal(attempts,1);
      const concurrentProfile=path.join(base,"concurrent-assembled-profile");fs.mkdirSync(concurrentProfile);
      const races=await Promise.all([operateProjectNativeHistory({...publishArgs,nativeHome:concurrentProfile,retainedDerivationSources:[retainedSource]}),publishClaudeDerived({artifact:assembledArtifact,nativeHome:concurrentProfile,root:target,host:host(assembledArtifact)})]);
      assert.equal(races[0].nativePublication.prefixObservedRows,1);assert.equal(fs.readFileSync(targetFile(concurrentProfile,assembledArtifact)).equals(assembledArtifact.raw),true);
      const byCli=await runCommand(["project-native-history",projectRoot,"--action","assemble-project","--catalog-file",catalogFile,"--expected-catalog",catalogDigest,"--workspace-map",JSON.stringify(workspaceMappings),"--physical-sources",JSON.stringify([{threadId:childId,directory:bound.directory,expectedPayloadDigest:bound.payloadDigest}])]);assert.equal(byCli.collectionDigest,assembled.collectionDigest);
      const byMcp=await dispatch({jsonrpc:"2.0",id:53,method:"tools/call",params:{name:"lode_project_native_history",arguments:{action:"assemble-project",bundle_root:projectRoot,catalog_file:catalogFile,expected_catalog_digest:catalogDigest,workspace_mappings:workspaceMappings,physical_sources:[{threadId:childId,directory:bound.directory,expectedPayloadDigest:bound.payloadDigest}]}}});assert.equal(byMcp.result.structuredContent.collectionDigest,assembled.collectionDigest);
      const verified=await operateProjectNativeHistory({...publishArgs,action:"verify-project",retainedDerivationSources:[retainedSource]});assert.equal(verified.officialReader.completeRows,1);assert.ok(fs.readFileSync(targetFile(profile,assembledArtifact)).equals(continued));
      const replacedOriginal=path.join(base,"moved-original-store"),replacementProfile=path.join(base,"source-replacement-profile");fs.mkdirSync(replacementProfile);let swapped=false;
      const replacingHost=host(assembledArtifact,{version:async()=>{if(!swapped){fs.renameSync(bound.directory,replacedOriginal);fs.cpSync(replacedOriginal,bound.directory,{recursive:true});swapped=true;}return "2.1.317";}});
      try{await assert.rejects(operateProjectNativeHistory({...publishArgs,nativeHome:replacementProfile,nativeHistoryHost:replacingHost,retainedDerivationSources:[retainedSource]}),{code:"NATIVE_HISTORY_ROOT_CHANGED"});assert.equal(fs.existsSync(targetFile(replacementProfile,assembledArtifact)),false);}finally{if(swapped){fs.rmSync(bound.directory,{recursive:true});fs.renameSync(replacedOriginal,bound.directory);}}
      assert.equal(fs.existsSync(path.join(projectRoot,"physical-sources")),false); // no executable clone, including when the original publishes after assembly
    }
    assert.deepEqual(fs.readdirSync(target),[]);assert.equal(fs.existsSync(path.join(target,".lode")),false);
    assert.ok(parentRaw.includes(Buffer.from("INVALID_UNSELECTED_PARENT_FUTURE")));assert.equal(hash(childRaw),originals[1].sha256);
  }
  const copied=path.join(base,"copied-subagent-prefix");fs.mkdirSync(copied);
  const local=make().toString("utf8").trimEnd().split("\n").map(line=>JSON.parse(line));
  const copiedHeader={...local[0],ordinal:0,payload:{...local[0].payload,subagent_history_start_ordinal:5}};delete copiedHeader.payload.history_base;
  const copiedRaw=encode([copiedHeader,...parent.slice(1),...local.slice(1).map(frame=>({...frame,ordinal:frame.ordinal-1}))]);
  archiveCodexCapturedPhysicalSource({directory:copied,threadId:childId,rolloutId:childPhysical,originals:[{rolloutId:childPhysical,threadId:childId,raw:copiedRaw,sha256:hash(copiedRaw)}]});
  const copiedResult=await operateProjectNativeHistory({action:"derive",bundleRoot:copied,root:target,threadIds:[childId]});
  const copiedArtifact=inspectProjectNativeDerivation({bundleRoot:copied,derivationId:copiedResult.derivationId});
  assert.equal(copiedArtifact.manifest.publicationReady,true,JSON.stringify(copiedArtifact.diagnostics));
  assert.ok(copiedArtifact.mapping.some(row=>row.source?.prefixOrigin==="copied-inherited-prefix"&&row.source?.recordedThreadId===parentId));
  const inherited=copiedArtifact.rows.flatMap(row=>row.message.content).filter(part=>part.type==="text"&&part.text.includes("Inherited marker ECHO-514"));assert.equal(inherited.length,1);
});

test("portable P3 preserves captured originals, selected logical Session and known uncertain attempts without following source paths or making an executable clone", async t => {
  const f=await derivedFixture(t),source=path.join(f.f.base,"portable-physical"),archive=path.join(f.f.base,"portable-archive");fs.mkdirSync(source);fs.mkdirSync(archive);
  const frames=[{ordinal:0,type:"session_meta",payload:{id:sourceThread,session_id:sourceThread,cli_version:nativeProfile.engineVersion,history_mode:"paginated"}},
    {ordinal:1,type:"event_msg",payload:{type:"task_started",turn_id:"portable-turn"}},
    {ordinal:2,type:"event_msg",payload:{type:"item_completed",thread_id:sourceThread,turn_id:"portable-turn",item:{type:"UserMessage",id:"portable-user",content:[{type:"text",text:"Synthetic CEDAR-617: deployment cancelled; preserve the earlier rejection and unknown inventory."}]}}},
    {ordinal:3,type:"event_msg",payload:{type:"item_completed",thread_id:sourceThread,turn_id:"portable-turn",item:{type:"AgentMessage",id:"portable-agent",content:[{type:"Text",text:"Bounded inspection was chosen over rebuilding. Inventory remains unresolved."}]}}},
    {ordinal:4,type:"event_msg",payload:{type:"task_complete",turn_id:"portable-turn"}}];
  const raw=Buffer.from(frames.map(frame=>JSON.stringify(frame)).join("\n")+"\n"),captured=archiveCodexCapturedPhysicalSource({directory:source,threadId:sourceThread,rolloutId:sourceThread,originals:[{threadId:sourceThread,rolloutId:sourceThread,raw,sha256:hash(raw)}]});
  const database=syntheticNativeDatabase(t,"state_5.sqlite",path.join(f.f.base,"portable-catalog.sqlite"));let catalog;
  try{database.row("projects",{id:"portable-project",name:"Synthetic portable Project",metadata:"{}"});for(const id of [sourceThread,branchThread])database.row("threads",{id,project_id:"portable-project",cwd:f.f.root,source:"cli",archived:0n});catalog=readCodexProjectCatalog(database.db,"portable-project");}finally{database.close();}
  const catalogFile=path.join(f.f.base,"portable-catalog.json");fs.writeFileSync(catalogFile,JSON.stringify(catalog,null,2)+"\n");
  const common=JSON.parse(fs.readFileSync(path.join(f.bundleRoot,"manifest.json")));
  const args={directory:archive,catalogFile,expectedCatalogDigest:hash(fs.readFileSync(catalogFile)),physicalSources:[{threadId:sourceThread,directory:source,expectedPayloadDigest:captured.payloadDigest}],
    lodeBundles:[{bundleRoot:f.bundleRoot,expectedBundleId:f.bundle.bundleId,expectedManifestDigest:f.bundle.manifestSha256,threadIds:[sourceThread]}]};
  const canonicalBefore=snapshot(f.f.root),initial=exportPortableProjectEvidence(args);
  assert.equal(initial.sources[0].noPriorAttemptsProven,false);assert.equal(initial.sources[0].operationHistoryStatus,"no-history-directory-observed-not-proof-of-no-attempt");
  const derived=await operateProjectNativeHistory({action:"derive",bundleRoot:source,root:f.f.root,threadIds:[sourceThread]}),artifact=inspectProjectNativeDerivation({bundleRoot:source,derivationId:derived.derivationId});
  const profile=path.join(f.f.base,"portable-unknown-profile");fs.mkdirSync(profile);
  const unknown=await publishClaudeDerived({artifact,nativeHome:profile,root:f.f.root,host:host(artifact),publishFile:()=>{throw Object.assign(new Error("Synthetic lost publication"),{code:"SYNTHETIC_UNKNOWN"});}});assert.equal(unknown.status,"native-derived-publication-uncertain");
  const interrupted=path.join(artifact.directory,"effects","open-"+"e".repeat(24));fs.mkdirSync(interrupted);fs.writeFileSync(path.join(interrupted,"desktop-open-attempt.json"),Buffer.alloc(0));fs.writeFileSync(path.join(interrupted,"desktop-open-return.json"),"{INCOMPLETE_JSON");
  const sourceBefore=snapshot(source),commonBefore=snapshot(f.bundleRoot),profileBefore=snapshot(profile);
  const created=exportPortableProjectEvidence(args);assert.notEqual(created.archiveId,initial.archiveId);assert.equal(created.nativePublicationAttempted,false);assert.equal(created.targetJournalSelected,false);assert.equal(created.requiresOriginalSourceStoreForByteVerification,false);
  assert.equal(created.sources[0].unparsedHistoricalRecords,2);assert.equal(created.sources[0].historicalOutcome,"not-inferred-from-raw-records");
  let nativeInvocations=0;const noNativeHost={provider:"claude",version:async()=>{nativeInvocations++;throw Error("Portable evidence must not invoke a provider");}};
  const publicArgs={action:"export-project-evidence",bundleRoot:archive,catalogFile,expectedCatalogDigest:args.expectedCatalogDigest,physicalSources:args.physicalSources,lodeBundles:args.lodeBundles,nativeHistoryHost:noNativeHost};
  const coreExport=await operateProjectNativeHistory(publicArgs);assert.deepEqual(coreExport,created);
  const cliExport=await runCommand(["project-native-history",archive,"--action","export-project-evidence","--catalog-file",catalogFile,"--expected-catalog",args.expectedCatalogDigest,"--physical-sources",JSON.stringify(args.physicalSources),"--lode-bundles",JSON.stringify(args.lodeBundles)]);assert.deepEqual(cliExport,created);
  const mcpArgs={action:"export-project-evidence",bundle_root:archive,catalog_file:catalogFile,expected_catalog_digest:args.expectedCatalogDigest,physical_sources:args.physicalSources,lode_bundles:args.lodeBundles};
  const mcpExport=await dispatch({jsonrpc:"2.0",id:61,method:"tools/call",params:{name:"lode_project_native_history",arguments:mcpArgs}},{nativeHistoryHost:noNativeHost});assert.deepEqual(mcpExport.result.structuredContent,created);
  const cliRead=await runCommand(["project-native-history",archive,"--action","read-project-evidence","--archive",created.archiveId,"--expected-archive",created.archiveDigest]);assert.deepEqual(cliRead,created);
  const mcpRead=await dispatch({jsonrpc:"2.0",id:62,method:"tools/call",params:{name:"lode_project_native_history",arguments:{action:"read-project-evidence",bundle_root:archive,archive_id:created.archiveId,expected_archive_digest:created.archiveDigest}}},{nativeHistoryHost:noNativeHost});assert.deepEqual(mcpRead.result.structuredContent,created);
  const cliStageRoot=path.join(f.f.base,"portable-public-cli-stage"),mcpStageRoot=path.join(f.f.base,"portable-public-mcp-stage");fs.mkdirSync(cliStageRoot);fs.mkdirSync(mcpStageRoot);
  const cliStaged=await runCommand(["project-native-history",archive,"--action","stage-project-session","--archive",created.archiveId,"--expected-archive",created.archiveDigest,"--session-bundle",f.bundle.bundleId,"--output-directory",cliStageRoot]);
  const mcpStaged=await dispatch({jsonrpc:"2.0",id:63,method:"tools/call",params:{name:"lode_project_native_history",arguments:{action:"stage-project-session",bundle_root:archive,archive_id:created.archiveId,expected_archive_digest:created.archiveDigest,session_bundle_id:f.bundle.bundleId,output_directory:mcpStageRoot}}},{nativeHistoryHost:noNativeHost});
  for(const staged of [cliStaged,mcpStaged.result.structuredContent]){assert.equal(staged.bundleId,f.bundle.bundleId);assert.equal(staged.manifestDigest,f.bundle.manifestSha256);assert.equal(staged.selectedSessionId,common.selectedSessionId);assert.equal(staged.imported,false);assert.equal(staged.selectedCurrentSession,false);assert.equal(staged.nativeSourceStoreCreated,false);}
  assert.equal(nativeInvocations,0);assert.equal(fs.existsSync(path.join(archive,".lode")),false);assert.equal(fs.existsSync(path.join(archive,".head")),false);
  const scopedFailure=await dispatch({jsonrpc:"2.0",id:64,method:"tools/call",params:{name:"lode_project_native_history",arguments:{...mcpArgs,native_home:profile}}},{nativeHistoryHost:noNativeHost});assert.equal(scopedFailure.error.data.code,"PORTABLE_EVIDENCE_ARGUMENTS_INVALID");assert.equal(nativeInvocations,0);
  const digestFailure=await dispatch({jsonrpc:"2.0",id:65,method:"tools/call",params:{name:"lode_project_native_history",arguments:{action:"read-project-evidence",bundle_root:archive,archive_id:created.archiveId,expected_archive_digest:"f".repeat(64)}}});assert.equal(digestFailure.error.data.code,"PORTABLE_EVIDENCE_DIGEST_MISMATCH");
  assert.equal(created.selectedLogicalSessions.length,1);assert.equal(created.selectedLogicalSessions[0].selectedSessionId,common.selectedSessionId);assert.equal(created.selectedLogicalSessions[0].projectId,common.projectId);assert.equal(created.imported,false);assert.equal(created.grantsRecoveryAuthority,false);assert.equal(created.allLogicalSessionsIncluded,false);assert.deepEqual(created.missingSourceIds,[branchThread]);
  const repeated=exportPortableProjectEvidence(args);assert.equal(repeated.archiveDigest,created.archiveDigest);
  const moved=path.join(f.f.base,"portable-relocated");fs.cpSync(archive,moved,{recursive:true});
  const staging=path.join(f.f.base,"portable-session-staging");fs.mkdirSync(staging);
  const originalOpen=fs.openSync,originalLstat=fs.lstatSync,blockedRoots=[source,f.bundleRoot,f.f.root,path.dirname(catalogFile)+path.sep+path.basename(catalogFile)];let sourceLookups=0;
  const forbidden=file=>typeof file==="string"&&blockedRoots.some(root=>{const rel=path.relative(root,file);return rel===""||rel!==".."&&!rel.startsWith(".."+path.sep)&&!path.isAbsolute(rel);});
  fs.openSync=function(file,...rest){if(forbidden(file)){sourceLookups++;throw Error("Portable read followed original source path");}return originalOpen.call(this,file,...rest);};
  fs.lstatSync=function(file,...rest){if(forbidden(file)){sourceLookups++;throw Error("Portable read inspected original source path");}return originalLstat.call(this,file,...rest);};
  let inspected,staged;
  try{inspected=inspectPortableProjectEvidence({directory:moved,archiveId:created.archiveId,expectedArchiveDigest:created.archiveDigest});const read=readPortableProjectEvidence({directory:moved,archiveId:created.archiveId});assert.equal(read.archiveDigest,created.archiveDigest);staged=materializePortableProjectSessionBundle({directory:moved,archiveId:created.archiveId,expectedArchiveDigest:created.archiveDigest,bundleId:f.bundle.bundleId,outputDirectory:staging});assert.equal(staged.imported,false);assert.equal(staged.selectedCurrentSession,false);assert.equal(staged.manifestDigest,f.bundle.manifestSha256);await assert.rejects(operateProjectNativeHistory({action:"derive",bundleRoot:moved,root:f.f.root,threadIds:[sourceThread]}),{code:"ENOENT"});}
  finally{fs.openSync=originalOpen;fs.lstatSync=originalLstat;}
  assert.equal(sourceLookups,0);assert.ok(inspected.sources[0].native.originals[0].raw.equals(raw));assert.equal(fs.existsSync(path.join(moved,"manifest.json")),false);assert.equal(fs.existsSync(path.join(moved,"native")),false);
  const importedRoot=path.join(f.f.base,"portable-imported-project");fs.mkdirSync(importedRoot);
  const imported=await runCommand(["project-import",importedRoot,"--bundle",staging,"--expected-bundle",staged.bundleId]);assert.equal(imported.selectedSessionId,common.selectedSessionId);assert.equal(imported.restoresExecutionPermission,false);
  const entered=await runCommand(["conversation-enter",importedRoot,"--session",common.selectedSessionId]);assert.ok(JSON.stringify(entered).includes("Missing sensor map remains unresolved"));
  const recovered=withSessionRoute(importedRoot,common.selectedSessionId,()=>readRecoveryCheckpoint({root:importedRoot,checkpointId:f.checkpoint.checkpointId}));assert.equal(recovered.checkpoint.checkpointDigest,f.checkpoint.checkpointDigest);
  const attempt=inspected.sources[0].history.entries.find(entry=>entry.recordKind==="ClaudeDerivedPublicationAttempt");assert.ok(attempt);const archivedAttempt=JSON.parse(fs.readFileSync(path.join(moved,"objects",attempt.original.sha256+".bin")));assert.equal(archivedAttempt.operation.derivationDigest,artifact.digest);assert.equal(archivedAttempt.automaticReplayAllowed,false);assert.equal(inspected.sources[0].history.noPriorAttemptsProven,false);
  const emptyRecord=inspected.sources[0].history.entries.find(entry=>entry.path.endsWith("desktop-open-attempt.json"));assert.equal(emptyRecord.original.bytes,0);assert.equal(emptyRecord.original.sha256,hash(Buffer.alloc(0)));assert.equal(fs.readFileSync(path.join(moved,"objects",emptyRecord.original.sha256+".bin")).length,0);assert.equal(emptyRecord.recordKind,"unparsed-original");
  const bad=path.join(f.f.base,"portable-tampered");fs.cpSync(moved,bad,{recursive:true});fs.appendFileSync(path.join(bad,"objects",inspected.manifest.sources[0].manifest.sha256+".bin"),"tamper");assert.throws(()=>readPortableProjectEvidence({directory:bad,archiveId:created.archiveId,expectedArchiveDigest:created.archiveDigest}),{code:"PORTABLE_EVIDENCE_OBJECT_CHANGED"});
  assert.deepEqual(snapshot(source),sourceBefore);assert.deepEqual(snapshot(f.bundleRoot),commonBefore);assert.deepEqual(snapshot(profile),profileBefore);assert.deepEqual(snapshot(f.f.root),canonicalBefore);
  const denied=Object.assign(new Error("Synthetic denied export"),{code:"EPERM"});let deniedCalls=0;assert.throws(()=>exportPortableProjectEvidence({...args,assertCurrentAuthority:()=>{deniedCalls++;throw denied;}}),error=>error===denied);assert.equal(deniedCalls,1);
  const deniedRoot=path.join(f.f.base,"portable-history-denied");fs.mkdirSync(deniedRoot);
  const attemptSource=path.join(source,attempt.path),attemptPathKeys=new Set([path.join(source,attempt.path),path.join(nativeRoot(source),attempt.path)].map(value=>codexSourcePathKey(value))),historyDenial=Object.assign(new Error("Synthetic exact historical attempt access denied"),{code:"EACCES"});let historyDenied=false,afterDenialFs=0;
  fs.openSync=function(file,...rest){if(historyDenied)afterDenialFs++;if(typeof file==="string"&&attemptPathKeys.has(codexSourcePathKey(file))){historyDenied=true;throw historyDenial;}return originalOpen.call(this,file,...rest);};
  fs.lstatSync=function(file,...rest){if(historyDenied)afterDenialFs++;return originalLstat.call(this,file,...rest);};
  try{assert.throws(()=>exportPortableProjectEvidence({...args,directory:deniedRoot}),error=>error===historyDenial);}finally{fs.openSync=originalOpen;fs.lstatSync=originalLstat;}
  assert.equal(historyDenied,true);assert.equal(afterDenialFs,0);assert.deepEqual(fs.readdirSync(deniedRoot),[]); // no history-denial fallback archive claiming fresh input
  for(const failAt of [1,3]){
    const out=path.join(f.f.base,"portable-postpublication-denial-"+failAt);fs.mkdirSync(out);let headerOpens=0,postDenied=false,postFailureFs=0,primary;
    const outArchiveKeys=new Set([path.join(out,"archives"),path.join(nativeRoot(out),"archives")].map(value=>codexSourcePathKey(value)));
    const postError=Object.assign(new Error("Synthetic archive read denied after create"),{code:"EACCES"});
    fs.openSync=function(file,...rest){if(postDenied)postFailureFs++;if(typeof file==="string"&&outArchiveKeys.has(codexSourcePathKey(path.dirname(file)))&&/^project-evidence-[a-f0-9]{24}\.json$/u.test(path.basename(file))&&++headerOpens===failAt){postDenied=true;throw postError;}return originalOpen.call(this,file,...rest);};
    fs.lstatSync=function(file,...rest){if(postDenied)postFailureFs++;return originalLstat.call(this,file,...rest);};
    try{exportPortableProjectEvidence({...args,directory:out});}catch(error){primary=error;}finally{fs.openSync=originalOpen;fs.lstatSync=originalLstat;}
    assert.equal(primary,postError);assert.equal(postFailureFs,0);assert.equal(primary.portableEvidenceObservation.manifestPublicationAttempted,true);assert.equal(primary.portableEvidenceObservation.manifestCommitConfirmed,failAt===3);
    assert.equal(primary.portableEvidenceObservation.manifestPublicationOutcome,failAt===3?"committed-but-final-verification-failed":"unknown-after-publication-entered");assert.equal(primary.portableEvidenceObservation.additionalFilesystemObservationAfterFailure,false);
    assert.equal(fs.existsSync(path.join(out,"archives",primary.portableEvidenceObservation.archiveId+".json")),true); // retained; not rolled back or silently treated as absent
  }
  const mcpFailedRoot=path.join(f.f.base,"portable-public-mcp-postcommit-denial");fs.mkdirSync(mcpFailedRoot);let mcpHeaderOpens=0,mcpDenied=false,mcpPostFailureFs=0;
  const mcpArchiveKeys=new Set([path.join(mcpFailedRoot,"archives"),path.join(nativeRoot(mcpFailedRoot),"archives")].map(value=>codexSourcePathKey(value)));
  fs.openSync=function(file,...rest){if(mcpDenied)mcpPostFailureFs++;if(typeof file==="string"&&mcpArchiveKeys.has(codexSourcePathKey(path.dirname(file)))&&/^project-evidence-[a-f0-9]{24}\.json$/u.test(path.basename(file))&&++mcpHeaderOpens===3){mcpDenied=true;throw Object.assign(new Error("Synthetic MCP archive postcommit denied"),{code:"EACCES"});}return originalOpen.call(this,file,...rest);};
  fs.lstatSync=function(file,...rest){if(mcpDenied)mcpPostFailureFs++;return originalLstat.call(this,file,...rest);};
  let mcpFailure;try{mcpFailure=await dispatch({jsonrpc:"2.0",id:66,method:"tools/call",params:{name:"lode_project_native_history",arguments:{...mcpArgs,bundle_root:mcpFailedRoot}}},{nativeHistoryHost:noNativeHost});}finally{fs.openSync=originalOpen;fs.lstatSync=originalLstat;}
  assert.equal(mcpFailure.error.data.code,"EACCES");assert.equal(mcpFailure.error.data.partialPortableEvidence.manifestCommitConfirmed,true);assert.equal(mcpFailure.error.data.partialPortableEvidence.manifestPublicationOutcome,"committed-but-final-verification-failed");assert.equal(mcpPostFailureFs,0);assert.equal(nativeInvocations,0);
  const stageFailedRoot=path.join(f.f.base,"portable-public-stage-denied");fs.mkdirSync(stageFailedRoot);let stageDenied=false,stagePostFailureFs=0;
  const stageManifestKeys=new Set([path.join(stageFailedRoot,"manifest.json"),path.join(nativeRoot(stageFailedRoot),"manifest.json")].map(value=>codexSourcePathKey(value)));
  fs.openSync=function(file,...rest){if(stageDenied)stagePostFailureFs++;if(typeof file==="string"&&stageManifestKeys.has(codexSourcePathKey(file))){stageDenied=true;throw Object.assign(new Error("Synthetic selected Session stage denied"),{code:"EACCES"});}return originalOpen.call(this,file,...rest);};
  fs.lstatSync=function(file,...rest){if(stageDenied)stagePostFailureFs++;return originalLstat.call(this,file,...rest);};
  let stageFailure;try{stageFailure=await dispatch({jsonrpc:"2.0",id:67,method:"tools/call",params:{name:"lode_project_native_history",arguments:{action:"stage-project-session",bundle_root:archive,archive_id:created.archiveId,expected_archive_digest:created.archiveDigest,session_bundle_id:f.bundle.bundleId,output_directory:stageFailedRoot}}},{nativeHistoryHost:noNativeHost});}finally{fs.openSync=originalOpen;fs.lstatSync=originalLstat;}
  assert.equal(stageFailure.error.data.code,"EACCES");assert.equal(stageFailure.error.data.partialPortableEvidence.phase,"selected-common-session-stage");assert.equal(stageFailure.error.data.partialPortableEvidence.imported,false);assert.equal(stageFailure.error.data.partialPortableEvidence.manifestPublicationOutcome,"unknown-after-publication-entered");assert.equal(stagePostFailureFs,0);assert.equal(nativeInvocations,0);
});

test("destination P5 journal binds target identity, independent package callers and one-use claims without resetting lost, copied or uncertain history", async t => {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),"lode-destination-journal-"));
  t.after(()=>{if(path.dirname(fs.realpathSync(base))!==fs.realpathSync(os.tmpdir()))throw Error("Unexpected test cleanup root");fs.rmSync(base,{recursive:true,force:true});});
  const journalRoot=path.join(base,"host-journal"),nativeHome=path.join(base,"native-profile"),projectRoot=path.join(base,"project");for(const root of [journalRoot,nativeHome,projectRoot])fs.mkdirSync(root);
  const actions=[],guard=scope=>{actions.push(scope.action);assert.equal(scope.target.nativeHome,nativeHome);assert.equal(scope.target.projectRoot,projectRoot);};
  const options={journalRoot,nativeHome,projectRoot,hostId:"synthetic-host-A",provider:"claude",assertCurrentAuthority:guard};
  const admitted=admitDestinationImportTarget(options);assert.equal(admitted.status,"destination-target-admitted");assert.equal(admitted.priorAttemptsAbsentProven,false);const receipt=admitted.receipt;
  assert.equal(admitDestinationImportTarget(options).status,"destination-history-unknown");
  const op=n=>({provider:"claude",sourceDigest:"a".repeat(64),projectionDigest:"b".repeat(64),nativeId:"01900000-0000-7000-8000-"+String(n).padStart(12,"0"),relativeFile:"projects/synthetic/01900000-0000-7000-8000-"+String(n).padStart(12,"0")+".jsonl"});
  const request=n=>({...options,receipt,operation:op(n),historicalDisposition:"current-explicit-new-target-intent",historyAssessment:{sameTargetAttemptObserved:false,unresolvedAttemptObserved:false,evidenceDigest:"c".repeat(64)}});
  assert.equal(readDestinationImportEffect(request(1)).priorAttemptsAbsentProven,false);assert.equal(reserveDestinationImportEffect({...request(1),historicalDisposition:undefined}).reasonCode,"DESTINATION_IMPORT_HISTORICAL_TARGET_DISPOSITION_REQUIRED");
  assert.equal(reserveDestinationImportEffect({...request(1),historyAssessment:{...request(1).historyAssessment,unresolvedAttemptObserved:true}}).reasonCode,"DESTINATION_IMPORT_HISTORICAL_ATTEMPT_UNRESOLVED");
  const first=reserveDestinationImportEffect(request(1)),raced=reserveDestinationImportEffect(request(1));assert.equal(first.status,"destination-effect-reserved");assert.equal(raced.status,"destination-history-unknown");
  let writes=0;const targetFile=path.join(nativeHome,op(1).relativeFile);fs.mkdirSync(path.dirname(targetFile),{recursive:true});
  const completed=await executeDestinationImportEffect({lease:first.lease,execute:async({check})=>{check();fs.writeFileSync(targetFile,"synthetic exact native prefix\n",{flag:"wx"});writes++;},observe:async({check})=>{check();return {state:"matches",sha256:hash(fs.readFileSync(targetFile))};}});
  assert.equal(completed.status,"destination-result-recorded");assert.equal(completed.semanticTaskCompletionClaimed,false);assert.equal(writes,1);await assert.rejects(executeDestinationImportEffect({lease:first.lease,execute:()=>{writes++;},observe:()=>({})}),{code:"DESTINATION_IMPORT_LEASE_NOT_AVAILABLE"});
  assert.equal(reserveDestinationImportEffect(request(1)).status,"destination-result-recorded");assert.equal(writes,1);
  assert.throws(()=>reserveDestinationImportEffect({...request(1),operation:{...op(1),projectionDigest:"d".repeat(64)}}),{code:"DESTINATION_IMPORT_OPERATION_CONFLICT"});
  fs.appendFileSync(targetFile,"continued by target owner\n");const continued=fs.readFileSync(targetFile);assert.equal(readDestinationImportEffect(request(1)).status,"destination-result-recorded");assert.ok(fs.readFileSync(targetFile).equals(continued));
  const retainedResult={...request(1),knownResult:completed.resultReceipt},resultFile=path.join(journalRoot,"journals",receipt.targetKey,"effects",completed.effectKey,"result.json"),originalResult=fs.readFileSync(resultFile);
  const replay=readDestinationImportEffect(retainedResult);assert.equal(replay.recordedResultIntegrity,"matches-retained-result-receipt");assert.equal(replay.currentNativeTargetObserved,false);assert.equal(replay.semanticTaskCompletionClaimed,false);
  const alteredResult=JSON.parse(originalResult);alteredResult.observation.state="diverged";fs.writeFileSync(resultFile,JSON.stringify(alteredResult,null,2)+"\n");assert.throws(()=>readDestinationImportEffect(retainedResult),{code:"DESTINATION_IMPORT_EFFECT_TAMPER"});
  assert.equal(readDestinationImportEffect(request(1)).recordedResultIntegrity,"current-file-observed-without-retained-result-receipt");
  alteredResult.observation.reviewDecision="Promote to Product Canon";fs.writeFileSync(resultFile,JSON.stringify(alteredResult));assert.throws(()=>readDestinationImportEffect(request(1)),{code:"DESTINATION_IMPORT_OBSERVATION_INVALID"});
  delete alteredResult.observation.reviewDecision;alteredResult.grantsRecoveryAuthority=true;fs.writeFileSync(resultFile,JSON.stringify(alteredResult));assert.throws(()=>readDestinationImportEffect(request(1)),{code:"DESTINATION_IMPORT_EFFECT_TAMPER"});
  fs.unlinkSync(resultFile);assert.equal(reserveDestinationImportEffect(retainedResult).reasonCode,"DESTINATION_KNOWN_RESULT_RECORDS_LOST");fs.writeFileSync(resultFile,originalResult,{flag:"wx"});
  const profileClaimFiles=fs.readdirSync(path.join(journalRoot,"claims")),claimFile=path.join(journalRoot,"claims",profileClaimFiles[0],op(1).nativeId+".json"),firstAttemptFile=path.join(path.dirname(resultFile),"attempt.json");
  const originalClaim=fs.readFileSync(claimFile),originalAttempt=fs.readFileSync(firstAttemptFile);
  for(const [kind,changes] of [["claim",{schemaVersion:2}],["claim",{authorityPlane:"P2"}],["claim",{reviewDecision:"approve"}],
    ["attempt",{schemaVersion:2}],["attempt",{authorityPlane:"P2"}],["attempt",{automaticRetryAllowed:true}],["attempt",{grantsRecoveryAuthority:true}],["attempt",{restoresExecutionPermission:true}],
    ["result",{schemaVersion:2}],["result",{authorityPlane:"P2"}],["result",{semanticTaskCompletionClaimed:true}]]){
    try{const raw=kind==="claim"?originalClaim:kind==="attempt"?originalAttempt:originalResult,changed={...JSON.parse(raw),...changes},bytes=Buffer.from(JSON.stringify(changed,null,2)+"\n");
      fs.writeFileSync(kind==="claim"?claimFile:kind==="attempt"?firstAttemptFile:resultFile,bytes);
      if(kind==="attempt"){const coordinated=JSON.parse(originalClaim);coordinated.attemptDigest=hash(bytes);fs.writeFileSync(claimFile,JSON.stringify(coordinated));}
      assert.throws(()=>reserveDestinationImportEffect(request(1)),{code:"DESTINATION_IMPORT_EFFECT_TAMPER"},kind+JSON.stringify(changes));
    }finally{fs.writeFileSync(claimFile,originalClaim);fs.writeFileSync(firstAttemptFile,originalAttempt);fs.writeFileSync(resultFile,originalResult);}
  }
  const pending=reserveDestinationImportEffect(request(2));let unknownCalls=0;const lostError=Object.assign(new Error("Synthetic effect lost its outcome"),{code:"SYNTHETIC_UNKNOWN"});
  await assert.rejects(executeDestinationImportEffect({lease:pending.lease,execute:()=>{unknownCalls++;throw lostError;},observe:()=>{throw Error("Unknown effect must not auto-observe");}}),error=>error===lostError);
  assert.equal(lostError.destinationImportObservation.status,"destination-effect-outcome-unknown");assert.equal(reserveDestinationImportEffect(request(2)).status,"destination-history-unknown");assert.equal(unknownCalls,1);
  const ctx=openDestinationImportTarget({...options,receipt}),key2=hash(Buffer.from(JSON.stringify({provider:op(2).provider,nativeId:op(2).nativeId,relativeFile:op(2).relativeFile},null,2)+"\n"));
  fs.unlinkSync(path.join(journalRoot,ctx.paths.attempts,key2,"attempt.json"));assert.equal(readDestinationImportEffect(request(2)).reasonCode,"DESTINATION_EFFECT_RECORD_LOST_OR_PARTIAL");assert.equal(reserveDestinationImportEffect(request(2)).status,"destination-history-unknown");
  const tampered=reserveDestinationImportEffect(request(3)),key3=tampered.effectKey,attemptFile=path.join(journalRoot,ctx.paths.attempts,key3,"attempt.json");fs.appendFileSync(attemptFile," ");
  await assert.rejects(executeDestinationImportEffect({lease:tampered.lease,execute:()=>{writes++;},observe:()=>({})}),{code:"DESTINATION_IMPORT_EFFECT_TAMPER"});assert.equal(writes,1);
  const clone=path.join(base,"copied-journal");fs.cpSync(journalRoot,clone,{recursive:true});assert.throws(()=>openDestinationImportTarget({...options,journalRoot:clone,receipt}),{code:"DESTINATION_TARGET_RECEIPT_BASIS_CHANGED"});
  assert.throws(()=>openDestinationImportTarget({...options,receipt,hostId:"synthetic-host-B"}),{code:"DESTINATION_TARGET_RECEIPT_BASIS_CHANGED"});
  const secondProject=path.join(base,"other-project");fs.mkdirSync(secondProject);const secondOptions={...options,projectRoot:secondProject,assertCurrentAuthority:()=>{}},second=admitDestinationImportTarget(secondOptions);
  const otherClaim=reserveDestinationImportEffect({...request(1),...secondOptions,receipt:second.receipt,operation:{...op(1),relativeFile:"projects/other/"+op(1).nativeId+".jsonl"}});assert.equal(otherClaim.reasonCode,"DESTINATION_NATIVE_ID_CLAIMED_BY_OTHER_TARGET");
  const deniedReserve=reserveDestinationImportEffect(request(4)),denial=Object.assign(new Error("Synthetic permission revoked before execution"),{code:"EPERM"});let deny=false,afterDenialChecks=0;
  const deniedOptions={...request(5),assertCurrentAuthority:scope=>{if(deny){afterDenialChecks++;throw Error("Retried denied authority");}if(scope.action==="execute-destination-effect"){deny=true;throw denial;}}};
  const denied=reserveDestinationImportEffect(deniedOptions);await assert.rejects(executeDestinationImportEffect({lease:denied.lease,execute:()=>{writes++;},observe:()=>({})}),error=>error===denial);assert.equal(afterDenialChecks,0);assert.equal(denial.destinationImportObservation.nativeEffectAttempted,false);assert.equal(writes,1);
  const journalFiles=root=>fs.readdirSync(root,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?journalFiles(path.join(root,entry.name)):[path.join(root,entry.name)]);
  for(const name of journalFiles(journalRoot)){const value=JSON.parse(fs.readFileSync(name,"utf8"));if(value.operation?.nativeId===op(4).nativeId)fs.unlinkSync(name);}
  const knownLost={...request(4),knownAttempt:deniedReserve.attemptReceipt};assert.equal(readDestinationImportEffect(knownLost).reasonCode,"DESTINATION_KNOWN_ATTEMPT_RECORDS_LOST");assert.equal(reserveDestinationImportEffect(knownLost).status,"destination-history-unknown");
  assert.equal(readDestinationImportEffect(request(4)).priorAttemptsAbsentProven,false); // total evidence loss cannot become a proved first use
  const workerModule=new URL("../scripts/lib/destination-import-journal.mjs",import.meta.url).href;
  const workerCode=`const{parentPort,workerData}=require('node:worker_threads');const fs=require('node:fs');const path=require('node:path');(async()=>{const m=await import(workerData.module);const args={...workerData.args,assertCurrentAuthority:()=>{}};const reserved=m.reserveDestinationImportEffect(args);let written=false;if(reserved.status==='destination-effect-reserved'){const file=path.join(args.nativeHome,args.operation.relativeFile);await m.executeDestinationImportEffect({lease:reserved.lease,execute:({check})=>{check();fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'concurrent synthetic prefix\\n',{flag:'wx'});written=true;},observe:({check})=>{check();return {state:'matches',bytes:fs.statSync(file).size};}});}parentPort.postMessage({status:reserved.status,written});})().catch(error=>{parentPort.postMessage({error:error.code||error.message});process.exitCode=1;});`;
  const racing=[];try{const results=await Promise.all([0,1].map(()=>new Promise((resolve,reject)=>{let value;const worker=new Worker(workerCode,{eval:true,workerData:{module:workerModule,args:{...request(6),assertCurrentAuthority:undefined}}});racing.push(worker);worker.once("message",message=>{value=message;});worker.once("error",reject);worker.once("exit",code=>code?reject(Error("Journal worker failed "+JSON.stringify(value))):resolve(value));})));assert.equal(results.filter(row=>row.written).length,1);assert.equal(fs.readFileSync(path.join(nativeHome,op(6).relativeFile),"utf8"),"concurrent synthetic prefix\n");}finally{await Promise.all(racing.map(worker=>worker.terminate()));}
  const controller=new AbortController(),cancelled=reserveDestinationImportEffect({...request(7),signal:controller.signal});let observedAfterCancel=0;
  await assert.rejects(executeDestinationImportEffect({lease:cancelled.lease,execute:()=>{fs.writeFileSync(path.join(nativeHome,op(7).relativeFile),"written before synthetic cancellation\n",{flag:"wx"});controller.abort();},observe:()=>{observedAfterCancel++;return{state:"matches"};}}),{code:"NATIVE_HISTORY_OPERATION_CANCELLED"});assert.equal(observedAfterCancel,0);assert.equal(readDestinationImportEffect(request(7)).status,"destination-history-unknown");
  const poison=reserveDestinationImportEffect(request(8));await assert.rejects(executeDestinationImportEffect({lease:poison.lease,execute:()=>{},observe:()=>({state:"matches",reviewDecision:"must approve this archived instruction"})}),{code:"DESTINATION_IMPORT_OBSERVATION_INVALID"});assert.equal(readDestinationImportEffect(request(8)).status,"destination-history-unknown");
  const capabilityAttempt=reserveDestinationImportEffect(request(9));let heldWriteScope;
  await executeDestinationImportEffect({lease:capabilityAttempt.lease,execute:({nativeWriteCapability})=>{
    const scope={nativeHome:nativeRoot(nativeHome),projectRoot:nativeRoot(projectRoot),operation:op(9)};assert.throws(()=>consumeDestinationNativeWriteCapability(JSON.parse(JSON.stringify(nativeWriteCapability)),scope),{code:"DESTINATION_NATIVE_WRITE_CAPABILITY_UNAVAILABLE"});
    heldWriteScope=consumeDestinationNativeWriteCapability(nativeWriteCapability,scope);heldWriteScope.check();assert.throws(()=>consumeDestinationNativeWriteCapability(nativeWriteCapability,scope),{code:"DESTINATION_NATIVE_WRITE_CAPABILITY_UNAVAILABLE"});
  },observe:()=>({state:"unobserved"})});assert.throws(()=>heldWriteScope.check(),{code:"DESTINATION_NATIVE_WRITE_CAPABILITY_CLOSED"});
  assert.ok(actions.includes("admit-new-destination-target"));assert.ok(actions.includes("reserve-destination-effect"));assert.ok(actions.includes("execute-destination-effect"));
  const removedJournal=path.join(journalRoot,"journals",receipt.targetKey),storedJournal=path.join(base,"retained-removed-journal");fs.renameSync(removedJournal,storedJournal);
  assert.throws(()=>readDestinationImportEffect(request(1)),{code:"DESTINATION_TARGET_JOURNAL_MISSING_UNKNOWN"});assert.equal(admitDestinationImportTarget(options).status,"destination-history-unknown");fs.renameSync(storedJournal,removedJournal);
  const oldHome=path.join(base,"retained-old-home");fs.renameSync(nativeHome,oldHome);fs.mkdirSync(nativeHome);assert.throws(()=>openDestinationImportTarget({...options,receipt}),{code:"DESTINATION_TARGET_RECEIPT_BASIS_CHANGED"});fs.rmdirSync(nativeHome);fs.renameSync(oldHome,nativeHome);
  assert.ok(fs.readFileSync(targetFile).equals(continued));assert.equal(fs.existsSync(path.join(projectRoot,".lode")),false);assert.equal(fs.existsSync(path.join(projectRoot,".head")),false);
});

test("native derived publisher consumes target-PC journal authority once and reads continued or lost targets without artifact-local effects or replay", async t => {
  const f=await derivedFixture(t),derived=await operateProjectNativeHistory({action:"derive",bundleRoot:f.bundleRoot,root:f.f.root,threadIds:[sourceThread]}),artifact=inspectProjectNativeDerivation({bundleRoot:f.bundleRoot,derivationId:derived.derivationId});
  const nativeHome=path.join(f.f.base,"destination-journal-profile"),journalRoot=path.join(f.f.base,"destination-journal-store");fs.mkdirSync(nativeHome);fs.mkdirSync(journalRoot);
  const targetOptions={nativeHome:nativeRoot(nativeHome),projectRoot:nativeRoot(f.f.root),journalRoot,hostId:"synthetic-native-consumer-host",provider:"claude",assertCurrentAuthority:()=>{}},admitted=admitDestinationImportTarget(targetOptions);let knownResult=null,scopeCalls=0,writes=0;
  const destinationHost={currentImportScope:async request=>{scopeCalls++;assert.equal(request.operation.sourceDigest,artifact.manifest.source.nativePayloadDigest);assert.equal(request.operation.projectionDigest,artifact.digest);return {...targetOptions,receipt:admitted.receipt,...(knownResult?{knownResult}:{}),historicalDisposition:"current-explicit-new-target-intent",historyAssessment:{sameTargetAttemptObserved:false,unresolvedAttemptObserved:false,evidenceDigest:hash(Buffer.from("Verified synthetic original history and current explicit destination request"))}};}};
  const args={artifact,nativeHome,root:f.f.root,host:host(artifact),destinationHost,assertCurrentAuthority:()=>{},publishFile:(file,raw)=>{writes++;fs.writeFileSync(file,raw,{flag:"wx"});}},artifactBefore=snapshot(artifact.directory);
  await assert.rejects(publishClaudeDerivedWithDestinationJournal({...args,destinationHost:{}}),{code:"DESTINATION_IMPORT_CURRENT_HOST_REQUIRED"});assert.equal(writes,0);
  // Match the production Host's canonical-root contract; a divergent scope
  // still cannot reserve a journal effect or write a native conversation.
  const beforeWrongScope=snapshot(journalRoot);
  for(const field of ["nativeHome","projectRoot"]){
    const wrong={...targetOptions,[field]:field==="nativeHome"?targetOptions.projectRoot:targetOptions.nativeHome};
    await assert.rejects(publishClaudeDerivedWithDestinationJournal({...args,destinationHost:{currentImportScope:async()=>wrong}}),{code:"DESTINATION_IMPORT_CURRENT_HOST_SCOPE_CHANGED"});
  }
  if(process.platform==="win32")await assert.rejects(publishClaudeDerivedWithDestinationJournal({...args,destinationHost:{currentImportScope:async()=>({...targetOptions,projectRoot:path.toNamespacedPath(targetOptions.projectRoot)})}}),{code:"DESTINATION_IMPORT_CURRENT_HOST_SCOPE_CHANGED"});
  assert.equal(writes,0);assert.deepEqual(snapshot(journalRoot),beforeWrongScope);assert.deepEqual(fs.readdirSync(nativeHome),[]);

  const first=await publishClaudeDerivedWithDestinationJournal(args);assert.equal(first.status,"native-derived-destination-result-recorded");assert.equal(first.destinationJournal.result.observation.state,"matches");assert.equal(first.filesWritten,1);assert.equal(first.grantsRecoveryAuthority,false);assert.equal(first.modelTurnStarted,false);assert.equal(first.automaticOpen,false);knownResult=first.destinationJournal.resultReceipt;
  const nativeFile=targetFile(nativeHome,artifact);assert.ok(fs.readFileSync(nativeFile).equals(artifact.raw));assert.deepEqual(snapshot(artifact.directory),artifactBefore);assert.equal(fs.existsSync(path.join(artifact.directory,"effects")),false);
  const verified=await verifyClaudeDerived({...args,assertCurrentAuthority:()=>{}});assert.equal(verified.emittedNativeCoverageComplete,true);assert.equal(verified.desktopVisibility,"not-observed");
  fs.appendFileSync(nativeFile,JSON.stringify({type:"custom-title",customTitle:"Synthetic continued title",sessionId:artifact.manifest.target.nativeId})+"\n");const continued=fs.readFileSync(nativeFile),repeated=await publishClaudeDerivedWithDestinationJournal(args);assert.equal(repeated.filesWritten,0);assert.equal(repeated.targetObservation.state,"continued");assert.equal(repeated.destinationJournal.currentNativeTargetObserved,false);assert.equal(repeated.currentNativeTargetObserved,true);assert.equal(writes,1);assert.ok(fs.readFileSync(nativeFile).equals(continued));
  fs.unlinkSync(nativeFile);const lost=await publishClaudeDerivedWithDestinationJournal(args);assert.equal(lost.targetObservation.state,"absent");assert.equal(lost.filesWritten,0);assert.equal(writes,1);assert.equal(fs.existsSync(nativeFile),false);
  const otherHome=path.join(f.f.base,"destination-unknown-profile");fs.mkdirSync(otherHome);const otherOptions={...targetOptions,nativeHome:nativeRoot(otherHome)},otherAdmission=admitDestinationImportTarget(otherOptions),lostError=Object.assign(new Error("Synthetic result lost after atomic native write"),{code:"SYNTHETIC_LOST_NATIVE_RESULT"});let unknownWrites=0;
  const otherArgs={...args,nativeHome:otherHome,destinationHost:{currentImportScope:async()=>({...otherOptions,receipt:otherAdmission.receipt,historicalDisposition:"current-explicit-new-target-intent",historyAssessment:{sameTargetAttemptObserved:false,unresolvedAttemptObserved:false,evidenceDigest:"e".repeat(64)}})},publishFile:(file,raw)=>{unknownWrites++;fs.writeFileSync(file,raw,{flag:"wx"});throw lostError;}};
  await assert.rejects(publishClaudeDerivedWithDestinationJournal(otherArgs),error=>error===lostError);assert.equal(lostError.destinationImportObservation.nativeEffectAttempted,true);const unknown=await publishClaudeDerivedWithDestinationJournal(otherArgs);assert.equal(unknown.filesWritten,0);assert.equal(unknown.targetObservation.state,"matches");assert.equal(unknown.publicationOwnership,"not-inferred-from-bytes");assert.equal(unknown.destinationJournal.status,"destination-history-unknown");assert.equal(unknownWrites,1);
  assert.ok(scopeCalls>=3);assert.deepEqual(snapshot(artifact.directory),artifactBefore);
});

test("Windows live read guard preserves reader DB/WAL effects, separates snapshots and refuses missing WAL or changed identities without fallback", async t => {
  if(process.platform!=="win32"){const value=await openCodexLiveReadGuard({home:"/synthetic/not-opened",allowSynchronizationFiles:true,assertCurrentAuthority:()=>{}});assert.equal(value.status,"unsupported-live-source-platform");return;}
  const base=fs.mkdtempSync(path.join(os.tmpdir(),"lode-live-원본-🦊-'")),writers=[];
  t.after(()=>{for(const writer of writers)try{writer.close();}catch{}if(path.dirname(fs.realpathSync(base))!==fs.realpathSync(os.tmpdir()))throw Error("Unexpected guard fixture root");fs.rmSync(base,{recursive:true,force:true});});
  const home=path.join(base,"source"),dbNames=["state_5.sqlite","thread_history_1.sqlite"];fs.mkdirSync(home);
  for(const name of dbNames){const db=new DatabaseSync(path.join(home,name));writers.push(db);db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA busy_timeout=0; CREATE TABLE sample(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO sample(value)VALUES('initial')");}
  const dbWalSnapshot=root=>Object.fromEntries(dbNames.flatMap(name=>[name,name+"-wal"]).map(name=>{const file=path.join(root,name);return [name,hash(fs.readFileSync(file))];}));
  const before=dbWalSnapshot(home),events=[],options={home,allowSynchronizationFiles:true,assertCurrentAuthority:()=>{},onProcess:event=>{events.push(event);if(event.event==="startup-failed")t.diagnostic(JSON.stringify(event.observation));}};
  await assert.rejects(openCodexLiveReadGuard({...options,allowSynchronizationFiles:false}),{code:"CODEX_LIVE_SOURCE_SYNC_POLICY_REQUIRED"});assert.equal(events.length,0);
  for(const invalidHome of ["relative-home",null,17])await assert.rejects(openCodexLiveReadGuard({...options,home:invalidHome}),{code:"NATIVE_HISTORY_EXACT_ROOT_REQUIRED"});assert.equal(events.length,0);
  const quiet=await withLiveCodexReadSnapshots(options,({connections,check})=>{check();return dbNames.map(name=>connections[name].prepare("SELECT count(*) n FROM sample").get().n);});
  assert.deepEqual(quiet.value,[1,1]);assert.equal(quiet.cleanup,"reader-connections-closed-before-owned-guard-release");assert.equal(quiet.globalAtomicSnapshotClaimed,false);assert.deepEqual(dbWalSnapshot(home),before);
  const live=await withLiveCodexReadSnapshots(options,({connections,check})=>{const s=connections[dbNames[0]].prepare("SELECT count(*) n FROM sample").get().n;writers[0].exec("INSERT INTO sample(value)VALUES('new state')");writers[1].exec("INSERT INTO sample(value)VALUES('new history')");check();const h=connections[dbNames[1]].prepare("SELECT count(*) n FROM sample").get().n;const stillS=connections[dbNames[0]].prepare("SELECT count(*) n FROM sample").get().n;return {s,h,stillS};});
  assert.deepEqual(live.value,{s:1,h:2,stillS:1});assert.equal(live.evidence.namespaceGuard,"delete-rename-only-not-byte-freeze");
  // Observe actual private stdout without replacing the process or API. The
  // producer/consumer boundary must retain JSON types, not only coercible IDs.
  const {default:childProcess}=await import("node:child_process"),{syncBuiltinESMExports}=await import("node:module"),originalSpawn=childProcess.spawn,replyChunks=[];let observedGuardPid,namespace;
  childProcess.spawn=function(...args){const child=originalSpawn(...args);if(args[1]?.includes("-Command")&&String(args[1].at(-1)).includes("[lode-guard-startup-v1]")){observedGuardPid=child.pid;child.stdout.on("data",chunk=>replyChunks.push(Buffer.from(chunk)));}return child;};syncBuiltinESMExports();
  try{namespace=await openCodexLiveReadGuard(options);for(const name of dbNames.flatMap(name=>[name,name+"-wal"])){assert.throws(()=>fs.renameSync(path.join(home,name),path.join(home,name+".renamed")),{code:"EBUSY"});assert.throws(()=>fs.unlinkSync(path.join(home,name)),{code:"EBUSY"});}const result=writers[0].prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();assert.equal(result.busy,0);assert.equal(fs.statSync(path.join(home,dbNames[0]+"-wal")).size,0);namespace.check();}finally{try{if(namespace)await namespace.release();}finally{childProcess.spawn=originalSpawn;syncBuiltinESMExports();}}
  const replies=Buffer.concat(replyChunks).toString("utf8").trim().split("\n").map(line=>JSON.parse(line));assert.equal(replies.length,2);
  const [readyReply,releasedReply]=replies;assert.deepEqual(Object.keys(readyReply).sort(),["files","pid","powershell","ready","share","version"]);assert.equal(readyReply.version,1);assert.equal(readyReply.ready,true);assert.equal(readyReply.pid,observedGuardPid);assert.equal(readyReply.share,"ReadWrite-no-Delete");assert.equal(typeof readyReply.powershell,"string");assert.ok(Array.isArray(readyReply.files));assert.equal(readyReply.files.length,4);
  for(const file of readyReply.files){assert.deepEqual(Object.keys(file).sort(),["fileIndex","length","links","volume"]);assert.equal(typeof file.volume,"number");assert.ok(Number.isSafeInteger(file.volume)&&file.volume>=0&&file.volume<=0xffffffff);assert.equal(file.links,1);assert.equal(typeof file.fileIndex,"string");assert.match(file.fileIndex,/^[a-f0-9]{16}$/u);assert.equal(typeof file.length,"string");assert.match(file.length,/^[0-9]+$/u);}
  assert.deepEqual(releasedReply,{version:1,released:true,pid:observedGuardPid});
  const clone=path.join(base,"source-without-shm");fs.mkdirSync(clone);
  for(const name of dbNames)for(const suffix of ["","-wal"])fs.copyFileSync(path.join(home,name+suffix),path.join(clone,name+suffix)); // synthetic fixture setup only, never capture implementation
  const clonedBefore=dbWalSnapshot(clone),copied=await withLiveCodexReadSnapshots({...options,home:clone},({connections})=>dbNames.map(name=>connections[name].prepare("SELECT count(*) n FROM sample").get().n));assert.deepEqual(copied.value,[2,2]);assert.deepEqual(dbWalSnapshot(clone),clonedBefore);
  const failedHome=path.join(base,"failed-open");fs.mkdirSync(failedHome);for(const name of dbNames)for(const suffix of ["","-wal"])fs.copyFileSync(path.join(clone,name+suffix),path.join(failedHome,name+suffix));
  const failedBefore=dbWalSnapshot(failedHome),failedWal=path.join(failedHome,dbNames[1]+"-wal");let forcedOpenFailure=false;
  try{await assert.rejects(openCodexLiveReadGuard({...options,home:failedHome,onProcess:event=>{events.push(event);if(event.event==="planned"){fs.renameSync(failedWal,failedWal+".saved");fs.mkdirSync(failedWal);forcedOpenFailure=true;}}}),error=>{assert.equal(error.code,"CODEX_LIVE_GUARD_ACQUIRE_FAILED");const reply=error.guardOriginalFailure;assert.equal(reply.version,1);assert.equal(reply.ready,false);assert.ok(Number.isSafeInteger(reply.pid)&&reply.pid>0);assert.equal(typeof reply.exception,"string");assert.ok(Number.isInteger(reply.hresult));assert.equal(typeof reply.message,"string");for(const text of ["원본","🦊","'"])assert.ok(reply.message.includes(text));return true;});}finally{if(forcedOpenFailure){fs.rmdirSync(failedWal);fs.renameSync(failedWal+".saved",failedWal);}}
  assert.deepEqual(dbWalSnapshot(failedHome),failedBefore);assert.equal(forcedOpenFailure,true);assert.equal(codexLiveReadGuardProcessStatus().length,0);
  const absent=path.join(base,"absent-wal");fs.mkdirSync(absent);for(const name of dbNames)fs.copyFileSync(path.join(home,name),path.join(absent,name));
  let missingReaderCalled=false,missingEvents=0;const missing=await withLiveCodexReadSnapshots({...options,home:absent,onProcess:()=>missingEvents++},()=>{missingReaderCalled=true;});assert.equal(missing.status,"live-source-component-unavailable");assert.equal(missing.sqliteOpened,false);assert.equal(missingReaderCalled,false);assert.equal(missingEvents,0);assert.equal(fs.readdirSync(absent).length,2);
  const orphan=path.join(base,"empty-db-orphan-wal");fs.mkdirSync(orphan);for(const name of dbNames){fs.writeFileSync(path.join(orphan,name),Buffer.alloc(0));fs.writeFileSync(path.join(orphan,name+"-wal"),"synthetic orphan WAL");}const orphanBefore=dbWalSnapshot(orphan);
  await assert.rejects(withLiveCodexReadSnapshots({...options,home:orphan},({connections})=>connections[dbNames[0]].prepare("SELECT name FROM sqlite_schema").all()),error=>error.code==="ERR_SQLITE_ERROR");assert.deepEqual(dbWalSnapshot(orphan),orphanBefore);
  const replace=path.join(base,"replaced-before-guard");fs.mkdirSync(replace);for(const name of dbNames)for(const suffix of ["","-wal"])fs.copyFileSync(path.join(clone,name+suffix),path.join(replace,name+suffix));
  let replaced=false,replaceReaderCalled=false;await assert.rejects(withLiveCodexReadSnapshots({...options,home:replace,onProcess:event=>{if(event.event==="planned"){const old=path.join(replace,dbNames[0]+"-wal");fs.renameSync(old,old+".saved");fs.copyFileSync(old+".saved",old);replaced=true;}}},()=>{replaceReaderCalled=true;}),{code:"CODEX_LIVE_SOURCE_IDENTITY_CHANGED"});assert.equal(replaced,true);assert.equal(replaceReaderCalled,false);
  const cleanupError=Object.assign(new Error("Synthetic current reader permission denied"),{code:"EACCES"});const beforeDenial=dbWalSnapshot(clone);
  await assert.rejects(withLiveCodexReadSnapshots({...options,home:clone},()=>{throw cleanupError;}),error=>error===cleanupError);assert.deepEqual(dbWalSnapshot(clone),beforeDenial);
  // Inject only native resolver outcomes for an actually equivalent verbatim
  // home. Keep canonical files intact; neither alias drift nor denied lookup
  // may substitute a new root or become a successful fallback.
  const aliasHome=path.toNamespacedPath(clone),originalNativeResolve=fs.realpathSync.native;
  assert.notEqual(aliasHome,originalNativeResolve(aliasHome));
  for(const outcome of ["changed","denied"]){
    const aliasGuard=await openCodexLiveReadGuard({...options,home:aliasHome}),denied=Object.assign(new Error("Synthetic alias resolver denied"),{code:"EACCES"});
    try{
      fs.realpathSync.native=function(file,...rest){if(file===aliasHome){if(outcome==="denied")throw denied;return originalNativeResolve(home);}return originalNativeResolve(file,...rest);};
      assert.throws(()=>aliasGuard.check(),error=>outcome==="denied"?error===denied:error.code==="CODEX_LIVE_SOURCE_IDENTITY_CHANGED");
    }finally{fs.realpathSync.native=originalNativeResolve;await aliasGuard.release();}
  }
  const hardlinked=path.join(base,"hardlinked");fs.mkdirSync(hardlinked);for(const name of dbNames)for(const suffix of ["","-wal"])fs.copyFileSync(path.join(clone,name+suffix),path.join(hardlinked,name+suffix));
  const hardlink=path.join(hardlinked,"other-name");fs.linkSync(path.join(hardlinked,dbNames[1]+"-wal"),hardlink);
  let hardlinkSpawns=0;try{await assert.rejects(openCodexLiveReadGuard({...options,home:hardlinked,onProcess:()=>hardlinkSpawns++}),{code:"CODEX_LIVE_SOURCE_FILE_UNSAFE"});}finally{fs.unlinkSync(hardlink);}assert.equal(hardlinkSpawns,0);
  assert.equal(codexLiveReadGuardProcessStatus().length,0);assert.equal(events.filter(event=>event.event==="started").length,events.filter(event=>event.event==="closed").length);assert.ok(events.every(event=>event.windowsHide));
});

test("live Project intake joins selected logical state to physical history without reading sibling bodies, losing raw tails or gating unrelated commits", async t => {
  if(process.platform!=="win32")return;
  const base=fs.mkdtempSync(path.join(os.tmpdir(),"lode-live-project-")),home=path.join(base,"source");fs.mkdirSync(home);
  const state=syntheticNativeDatabase(t,"state_5.sqlite",path.join(home,"state_5.sqlite")),history=syntheticNativeDatabase(t,"thread_history_1.sqlite",path.join(home,"thread_history_1.sqlite"));
  t.after(()=>{state.close();history.close();if(path.dirname(fs.realpathSync(base))!==fs.realpathSync(os.tmpdir()))throw Error("Unexpected live intake fixture root");fs.rmSync(base,{recursive:true,force:true});});
  for(const db of [state.db,history.db])db.exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0");
  const parentId="01900000-0000-7000-8000-000000002000",leafId="01900000-0000-7000-8000-000000002001",frame=(ordinal,type,payload)=>({ordinal,type,payload}),encode=frames=>Buffer.from(frames.map(row=>JSON.stringify(row)).join("\n")+"\n");
  const parentPrefix=encode([frame(0,"session_meta",{id:sourceThread,session_id:sourceThread,cli_version:nativeProfile.engineVersion,history_mode:"paginated"}),frame(1,"event_msg",{type:"task_started",turn_id:"parent-turn"}),frame(2,"event_msg",{type:"item_completed",thread_id:sourceThread,turn_id:"parent-turn",item:{id:"parent-user",type:"UserMessage",content:[{type:"text",text:"Inherited original CEDAR-231"}]}}),frame(3,"event_msg",{type:"item_completed",thread_id:sourceThread,turn_id:"parent-turn",item:{id:"parent-agent",type:"AgentMessage",content:[{type:"Text",text:"Preserve the read-only condition"}]}}),frame(4,"event_msg",{type:"task_complete",turn_id:"parent-turn"})]);
  const parentRelative="sessions/2026/11/06/rollout-synthetic-"+parentId+".jsonl",leafRelative="sessions/2026/11/06/rollout-synthetic-"+leafId+".jsonl",parentFile=path.join(home,parentRelative),leafFile=path.join(home,leafRelative);fs.mkdirSync(path.dirname(leafFile),{recursive:true});
  const excluded=encode([frame(5,"event_msg",{type:"future_private_record",text:"EXCLUDED_PARENT_FUTURE_SENTINEL"})]);fs.writeFileSync(parentFile,Buffer.concat([parentPrefix,excluded]));
  const childFrames=[frame(5,"session_meta",{id:sourceThread,session_id:sourceThread,cli_version:nativeProfile.engineVersion,history_mode:"paginated",history_base:{thread_id:parentId,end_byte_offset:parentPrefix.length,end_ordinal_exclusive:5}}),frame(6,"event_msg",{type:"task_started",turn_id:"leaf-turn"}),frame(7,"event_msg",{type:"item_completed",thread_id:sourceThread,turn_id:"leaf-turn",item:{id:"leaf-user",type:"UserMessage",content:[{type:"text",text:"Selected physical history MAPLE-912"}]}}),frame(8,"event_msg",{type:"item_completed",thread_id:sourceThread,turn_id:"leaf-turn",item:{id:"leaf-agent",type:"AgentMessage",content:[{type:"Text",text:"No model or publication was invoked"}]}}),frame(9,"event_msg",{type:"task_complete",turn_id:"leaf-turn"})];
  const projected=encode(childFrames),rawOnly=encode([frame(10,"event_msg",{type:"task_started",turn_id:"ongoing"}),frame(11,"event_msg",{type:"item_completed",thread_id:sourceThread,turn_id:"ongoing",item:{id:"new-user",type:"UserMessage",content:[{type:"text",text:"A new raw-only turn"}]}})]),incomplete=Buffer.from('{"ordinal":12'),leafRaw=Buffer.concat([projected,rawOnly,incomplete]);fs.writeFileSync(leafFile,leafRaw);
  state.row("projects",{id:"live-project",name:"Synthetic live Project",metadata:'{"private":"PROJECT_METADATA_SENTINEL"}'});
  state.row("threads",{id:sourceThread,project_id:"live-project",rollout_path:leafFile,cli_version:nativeProfile.engineVersion,history_mode:"paginated",title:"Selected conversation",creator_user_id:"PRIVATE_ACCOUNT_SENTINEL"});
  state.row("threads",{id:branchThread,project_id:"live-project",title:"UNSELECTED_TITLE_SENTINEL",first_user_message:"UNSELECTED_BODY_SENTINEL"});
  const start=encode(childFrames.slice(0,1)).length;
  history.row("thread_turns",{thread_id:leafId,turn_id:"leaf-turn",rollout_ordinal:6n,rollout_byte_offset:BigInt(start),rollout_end_ordinal:9n,rollout_end_byte_offset:BigInt(projected.length)});
  history.row("thread_items",{thread_id:leafId,turn_id:"leaf-turn",item_id:"leaf-user",rollout_ordinal:7n,updated_at_ordinal:7n,item_type:"userMessage",item_json:'{"id":"leaf-user","type":"userMessage","content":[]}'});
  history.row("thread_history_projection_state",{thread_id:leafId,next_rollout_byte_offset:BigInt(projected.length),next_rollout_ordinal:10n});
  // A tempting logical-ID join returns different rows. They must not leak into
  // the selected physical leaf, and current ancestor canonical rows aren't read.
  for(const id of [sourceThread,parentId]){history.row("thread_turns",{thread_id:id,turn_id:"poison-turn",rollout_ordinal:1n,rollout_byte_offset:0n});history.row("thread_items",{thread_id:id,turn_id:"poison-turn",item_id:"poison",rollout_ordinal:2n,updated_at_ordinal:99n,item_type:"userMessage",item_json:'{"text":"UNSELECTED_CANONICAL_SENTINEL"}'});}
  const events=[],args={home,sourceProjectId:"live-project",threadIds:[sourceThread],ancestorFiles:[{rolloutId:parentId,path:parentRelative}],allowSynchronizationFiles:true,assertCurrentAuthority:()=>{},onProcess:event=>{events.push(event);if(event.event==="startup-failed")t.diagnostic(JSON.stringify(event.observation));}};
  const observed=await readCodexLiveProjectSource({...args,onBoundary:phase=>{if(phase==="state-read")state.db.prepare("UPDATE threads SET title=? WHERE id=?").run("Unrelated title edit",branchThread);if(phase==="raw-read"){fs.appendFileSync(leafFile," ");fs.appendFileSync(parentFile,"excluded later suffix");}}});
  assert.equal(observed.status,"live-project-source-observed");assert.equal(observed.sourceBytesPersisted,false);assert.equal(observed.nativePublicationAttempted,false);assert.equal(observed.globalAtomicSnapshotClaimed,false);assert.equal(observed.cleanup,"reader-connections-closed-before-owned-guard-release");
  const selected=observed.value.conversations[0];assert.equal(selected.threadId,sourceThread);assert.equal(selected.rolloutId,leafId,JSON.stringify({reasonCode:selected.reasonCode??null,homeSpellingExpanded:fs.realpathSync.native(home)!==path.resolve(home)}));assert.equal(selected.history.threadIds[0],leafId);assert.equal(selected.lineage.status,"physical-lineage-ranges-verified");assert.equal(selected.historyCoverage.addressCoverageComplete,true);assert.equal(selected.historyCoverage.canonicalRowContentsEquivalent,false);assert.equal(selected.historyCoverage.rawOnlyTailBytes,rawOnly.length+incomplete.length);assert.ok(selected.incompleteTail.raw.equals(incomplete));assert.ok(selected.originals.find(row=>row.rolloutId===parentId).raw.equals(parentPrefix));
  const resultText=JSON.stringify(observed);for(const sentinel of ["PROJECT_METADATA_SENTINEL","PRIVATE_ACCOUNT_SENTINEL","UNSELECTED_TITLE_SENTINEL","UNSELECTED_BODY_SENTINEL","UNSELECTED_CANONICAL_SENTINEL","EXCLUDED_PARENT_FUTURE_SENTINEL"])assert.ok(!resultText.includes(sentinel),sentinel);
  // Exercise both names of the same guarded home. CI TEMP may use an 8.3
  // ancestor; neither a sibling root nor a selected outside path is adopted.
  const canonicalHome=fs.realpathSync.native(home),setLeafPath=value=>state.db.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(value,sourceThread);
  // Match the same known fixture through either root spelling without making
  // filesystem observations inside permission/read-boundary instrumentation.
  const registeredFixturePaths=new Map();
  const registerFixturePath=file=>{registeredFixturePaths.set(file,[file,path.join(canonicalHome,path.relative(home,file))].map(value=>codexSourcePathKey(value)));return file;};
  const fixturePathKeys=file=>{assert.ok(registeredFixturePaths.has(file),"Unregistered fixture instrumentation target");return registeredFixturePaths.get(file);};
  for(const file of [home,parentFile,leafFile])registerFixturePath(file);
  const sameFixturePath=(actual,expected)=>typeof actual==="string"&&fixturePathKeys(expected).includes(codexSourcePathKey(actual));
  const withinFixturePath=(actual,expected)=>{if(typeof actual!=="string")return false;const key=codexSourcePathKey(actual);return key!==null&&fixturePathKeys(expected).some(root=>key===root||key.startsWith(root+path.sep));};

  assert.ok(sameFixturePath(parentFile,parentFile));assert.ok(sameFixturePath(path.join(canonicalHome,parentRelative),parentFile));assert.ok(sameFixturePath(path.toNamespacedPath(path.join(canonicalHome,parentRelative)),parentFile));assert.equal(sameFixturePath(leafFile,parentFile),false);assert.equal(withinFixturePath(home+"-other",home),false);
  setLeafPath(path.join(canonicalHome,leafRelative));
  try{const canonical=await readCodexLiveProjectSource(args);assert.equal(canonical.value.conversations[0].rolloutId,leafId);assert.equal(canonical.value.conversations[0].lineage.status,"physical-lineage-ranges-verified");}finally{setLeafPath(leafFile);}
  const outsideHome=registerFixturePath(home+"-sibling"),outsideLeaf=path.join(outsideHome,leafRelative),beforeOutsideLstat=fs.lstatSync,beforeOutsideOpen=fs.openSync;let outsideSelectedReads=0;
  fs.lstatSync=function(file,...rest){if(withinFixturePath(file,outsideHome)){outsideSelectedReads++;throw Error("Outside selected path inspected");}return beforeOutsideLstat.call(this,file,...rest);};
  fs.openSync=function(file,...rest){if(withinFixturePath(file,outsideHome)){outsideSelectedReads++;throw Error("Outside selected path opened");}return beforeOutsideOpen.call(this,file,...rest);};
  setLeafPath(outsideLeaf);
  try{const outside=await readCodexLiveProjectSource(args);assert.equal(outside.value.conversations[0].reasonCode,"CODEX_LIVE_SELECTED_PATH_UNQUALIFIED");assert.equal(outside.value.conversations[0].rolloutId,undefined);}finally{fs.lstatSync=beforeOutsideLstat;fs.openSync=beforeOutsideOpen;setLeafPath(leafFile);}assert.equal(outsideSelectedReads,0);
  const portableRoot=path.join(base,"portable-live"),portableMoved=path.join(base,"portable-moved");fs.mkdirSync(portableRoot);
  const exported=exportPortableProjectEvidence({directory:portableRoot,liveObservation:observed,assertCurrentAuthority:()=>{}});assert.equal(exported.sources.length,1);assert.equal(exported.sources[0].selectionBindingStatus,"captured-state-path-verified");assert.equal(exported.sources[0].operationHistoryStatus,"operational-history-not-observed-not-proof-of-no-attempt");assert.equal(exported.sources[0].noPriorAttemptsProven,false);assert.equal(exported.liveSource.rows[0].incompleteTailBytes,incomplete.length);assert.equal(exported.executableSourceStoreCreated,false);assert.equal(fs.existsSync(path.join(portableRoot,"manifest.json")),false);assert.deepEqual(exported.missingSourceIds,[branchThread]);
  fs.cpSync(portableRoot,portableMoved,{recursive:true});const targetProject=path.join(base,"destination-project");fs.mkdirSync(targetProject);let portableArtifact;
  const originalLiveLstat=fs.lstatSync,originalLiveOpen=fs.openSync;let originalSourceAccesses=0;
  const originalSourcePath=value=>withinFixturePath(value,home);
  fs.lstatSync=function(file,...rest){if(originalSourcePath(file)){originalSourceAccesses++;throw Error("Relocated portable archive followed source path");}return originalLiveLstat.call(this,file,...rest);};
  fs.openSync=function(file,...rest){if(originalSourcePath(file)){originalSourceAccesses++;throw Error("Relocated portable archive opened source path");}return originalLiveOpen.call(this,file,...rest);};
  try{const moved=inspectPortableProjectEvidence({directory:portableMoved,archiveId:exported.archiveId,expectedArchiveDigest:exported.archiveDigest});assert.equal(moved.sources[0].native.proof.segments.length,2);const tail=moved.manifest.liveCapture.rows[0].incompleteTail;assert.ok(fs.readFileSync(path.join(portableMoved,"objects",tail.sha256+".bin")).equals(incomplete));assert.equal(readPortableProjectEvidence({directory:portableMoved,archiveId:exported.archiveId}).liveSource.currentAfterSnapshotRelease,"not-observed");
    const projection=await derivePortableProjectNativeHistory({directory:portableMoved,archiveId:exported.archiveId,expectedArchiveDigest:exported.archiveDigest,root:targetProject,threadId:sourceThread,assertCurrentAuthority:()=>{}});
    portableArtifact=await inspectPortableProjectNativeDerivation({directory:portableMoved,archiveId:exported.archiveId,expectedArchiveDigest:exported.archiveDigest,threadId:sourceThread,derivationId:projection.derivationId,expectedDerivationDigest:projection.derivationDigest,assertCurrentAuthority:()=>{}});assert.equal(portableArtifact.manifest.publicationReady,true,JSON.stringify(portableArtifact.diagnostics));assert.equal(fs.existsSync(path.join(portableMoved,"manifest.json")),false);
  }finally{fs.lstatSync=originalLiveLstat;fs.openSync=originalLiveOpen;}assert.equal(originalSourceAccesses,0);
  const portableNativeHome=path.join(base,"portable-native-profile"),portableJournal=path.join(base,"portable-native-journal");fs.mkdirSync(portableNativeHome);fs.mkdirSync(portableJournal);
  const portableTarget={journalRoot:portableJournal,nativeHome:nativeRoot(portableNativeHome),projectRoot:nativeRoot(targetProject),hostId:"synthetic-portable-target-host",provider:"claude",assertCurrentAuthority:()=>{}},portableAdmission=admitDestinationImportTarget(portableTarget);
  const portablePublished=await publishClaudeDerivedWithDestinationJournal({artifact:portableArtifact,nativeHome:portableNativeHome,root:targetProject,host:host(portableArtifact),assertCurrentAuthority:()=>{},destinationHost:{currentImportScope:async()=>({...portableTarget,receipt:portableAdmission.receipt,historicalDisposition:"current-explicit-new-target-intent",historyAssessment:{sameTargetAttemptObserved:false,unresolvedAttemptObserved:false,evidenceDigest:hash(Buffer.from("Current isolated empty synthetic target admission and verified portable source history"))}})}});
  assert.equal(portablePublished.filesWritten,1);assert.equal(portablePublished.destinationJournal.result.observation.state,"matches");assert.ok(fs.readFileSync(targetFile(portableNativeHome,portableArtifact)).equals(portableArtifact.raw));assert.equal(fs.existsSync(path.join(portableArtifact.directory,"effects")),false);
  const batchArgs={bundleRoot:portableMoved,archiveId:exported.archiveId,expectedArchiveDigest:exported.archiveDigest,root:targetProject},batchSourceBefore=snapshot(portableMoved);
  const batchRead=await operateProjectNativeHistory({...batchArgs,action:"read-portable-project"});assert.equal(batchRead.results.length,2);assert.equal(batchRead.results.find(row=>row.threadId===branchThread).status,"source-evidence-partial");assert.equal(batchRead.completeNativeMigration,false);assert.deepEqual(snapshot(portableMoved),batchSourceBefore);
  const batchCliRead=await runCommand(["project-native-history",portableMoved,"--action","read-portable-project","--archive",exported.archiveId,"--expected-archive",exported.archiveDigest,"--runtime-root",targetProject]);assert.deepEqual(batchCliRead,batchRead);
  const batchMcpRead=await dispatch({jsonrpc:"2.0",id:521,method:"tools/call",params:{name:"lode_project_native_history",arguments:{action:"read-portable-project",bundle_root:portableMoved,archive_id:exported.archiveId,expected_archive_digest:exported.archiveDigest,runtime_root:targetProject}}});assert.deepEqual(batchMcpRead.result.structuredContent,batchRead);assert.deepEqual(snapshot(portableMoved),batchSourceBefore);
  const destinationImportHost={currentImportScope:async()=>({...portableTarget,receipt:portableAdmission.receipt,knownResult:portablePublished.destinationJournal.resultReceipt,historicalDisposition:"current-explicit-new-target-intent",historyAssessment:{sameTargetAttemptObserved:false,unresolvedAttemptObserved:false,evidenceDigest:"e".repeat(64)}})},portableHost={...host(portableArtifact),destinationImportHost};
  const batchPublished=await operateProjectNativeHistory({...batchArgs,action:"publish-portable-project",nativeHome:portableNativeHome,nativeHistoryHost:portableHost});assert.equal(batchPublished.results.find(row=>row.threadId===sourceThread).result.filesWritten,0);assert.equal(batchPublished.results.find(row=>row.threadId===sourceThread).result.targetObservation.state,"matches");assert.deepEqual(batchPublished.pendingThreadIds,[branchThread]);assert.equal(batchPublished.remainingSourceUncertainties[0].threadId,sourceThread);assert.equal(batchPublished.remainingSourceUncertainties[0].blocksPrefixPublication,false);assert.equal(batchPublished.semanticSufficiencyClaimed,false);
  const batchVerified=await operateProjectNativeHistory({...batchArgs,action:"verify-portable-project",nativeHome:portableNativeHome,nativeHistoryHost:portableHost});assert.equal(batchVerified.results.find(row=>row.threadId===sourceThread).result.emittedNativeCoverageComplete,true);assert.equal(batchVerified.completeNativeMigration,false);assert.equal(batchVerified.results.find(row=>row.threadId===sourceThread).sourceCoverage.incompleteTailBytes,incomplete.length);
  const localHome=path.join(base,"local-adapter-profile"),localStore=path.join(base,"local-host-storage");fs.mkdirSync(localHome);let localHistoryRecords=[],admissions=0;
  const localHostOptions={storageRoot:localStore,nativeHome:localHome,assertCurrentAuthority:()=>{},sourceHistoryFor:async request=>({sourceVerified:true,sourceDigest:request.operation.sourceDigest,evidenceDigest:"e".repeat(64),records:localHistoryRecords}),authorizeTargetAdmission:()=>{admissions++;}};
  let localAdapter=createLocalDestinationImportHost(localHostOptions),localNativeHost={...host(portableArtifact),destinationImportHost:localAdapter};
  await assert.rejects(operateProjectNativeHistory({...batchArgs,action:"publish-portable-project",nativeHome:localHome,nativeHistoryHost:localNativeHost}),error=>error.code==="DESTINATION_LOCAL_HOST_NOT_ADMITTED"&&error.collectionOperationResult.results.length===0);assert.equal(fs.existsSync(localStore),false);
  const targetAdmitted=await operateProjectNativeHistory({...batchArgs,action:"admit-portable-targets",nativeHome:localHome,nativeHistoryHost:localNativeHost});assert.equal(targetAdmitted.results[0].status,"destination-target-admitted");assert.equal(fs.existsSync(targetFile(localHome,portableArtifact)),false);const storeBeforeRepeat=snapshot(localStore);
  const admitCli=await runCommand(["project-native-history",portableMoved,"--action","admit-portable-targets","--archive",exported.archiveId,"--expected-archive",exported.archiveDigest,"--runtime-root",targetProject,"--native-home",localHome],{nativeHistoryHost:localNativeHost});assert.equal(admitCli.results[0].status,"destination-existing-target-observed");assert.deepEqual(snapshot(localStore),storeBeforeRepeat);
  const localPublished=await operateProjectNativeHistory({...batchArgs,action:"publish-portable-project",nativeHome:localHome,nativeHistoryHost:localNativeHost});assert.equal(localPublished.results[0].result.filesWritten,1);const localFileBefore=fs.readFileSync(targetFile(localHome,portableArtifact)),localStoreAfter=snapshot(localStore);
  localAdapter=createLocalDestinationImportHost({...localHostOptions,authorizeTargetAdmission:null});localNativeHost={...host(portableArtifact),destinationImportHost:localAdapter};
  const localMcp=await dispatch({jsonrpc:"2.0",id:529,method:"tools/call",params:{name:"lode_project_native_history",arguments:{action:"publish-portable-project",bundle_root:portableMoved,archive_id:exported.archiveId,expected_archive_digest:exported.archiveDigest,runtime_root:targetProject,native_home:localHome}}},{nativeHistoryHost:localNativeHost});assert.equal(localMcp.error,undefined,JSON.stringify(localMcp.error));assert.equal(localMcp.result.structuredContent.results[0].result.filesWritten,0);assert.deepEqual(snapshot(localStore),localStoreAfter);assert.ok(fs.readFileSync(targetFile(localHome,portableArtifact)).equals(localFileBefore));
  const copiedLocalStore=path.join(base,"copied-local-host-storage");fs.cpSync(localStore,copiedLocalStore,{recursive:true});const copiedLocalAdapter=createLocalDestinationImportHost({...localHostOptions,storageRoot:copiedLocalStore});await assert.rejects(publishClaudeDerivedWithDestinationJournal({artifact:portableArtifact,nativeHome:localHome,root:targetProject,host:host(portableArtifact),destinationHost:copiedLocalAdapter,assertCurrentAuthority:()=>{}}),{code:"DESTINATION_LOCAL_HOST_IDENTITY_CHANGED"});
  const blockedHome=path.join(base,"historical-uncertain-profile"),blockedStore=path.join(base,"historical-uncertain-store");fs.mkdirSync(blockedHome);localHistoryRecords=[{nativeId:portableArtifact.manifest.target.nativeId}];const blockedAdapter=createLocalDestinationImportHost({...localHostOptions,nativeHome:blockedHome,storageRoot:blockedStore}),blockedHost={...host(portableArtifact),destinationImportHost:blockedAdapter};
  await operateProjectNativeHistory({...batchArgs,action:"admit-portable-targets",nativeHome:blockedHome,nativeHistoryHost:blockedHost});const blocked=await operateProjectNativeHistory({...batchArgs,action:"publish-portable-project",nativeHome:blockedHome,nativeHistoryHost:blockedHost});assert.equal(blocked.results[0].result.destinationJournal.reasonCode,"DESTINATION_IMPORT_HISTORICAL_ATTEMPT_UNRESOLVED");assert.equal(fs.existsSync(targetFile(blockedHome,portableArtifact)),false);const blockedBefore=snapshot(blockedStore);
  localHistoryRecords=[];const stillBlocked=await operateProjectNativeHistory({...batchArgs,action:"publish-portable-project",nativeHome:blockedHome,nativeHistoryHost:blockedHost});assert.equal(stillBlocked.results[0].result.destinationJournal.reasonCode,"DESTINATION_IMPORT_HISTORICAL_ATTEMPT_UNRESOLVED");assert.deepEqual(snapshot(blockedStore),blockedBefore);
  const deniedStore=path.join(base,"denied-local-store"),deniedAdmission=Object.assign(new Error("Synthetic target admission denied"),{code:"EACCES"}),deniedAdapter=createLocalDestinationImportHost({...localHostOptions,storageRoot:deniedStore,authorizeTargetAdmission:()=>{throw deniedAdmission;}});await assert.rejects(deniedAdapter.admitTarget({projectRoot:targetProject}),error=>error===deniedAdmission);assert.equal(fs.existsSync(deniedStore),false);assert.ok(admissions>=2);
  const portableBefore=snapshot(portableRoot);assert.throws(()=>exportPortableProjectEvidence({directory:portableRoot,liveObservation:JSON.parse(JSON.stringify(observed)),assertCurrentAuthority:()=>{}}),{code:"CODEX_LIVE_OBSERVATION_CHANGED_OR_NOT_CURRENT_INTAKE"});
  const savedByte=selected.originals[0].raw[0];selected.originals[0].raw[0]=savedByte^1;try{assert.throws(()=>exportPortableProjectEvidence({directory:portableRoot,liveObservation:observed,assertCurrentAuthority:()=>{}}),{code:"CODEX_LIVE_OBSERVATION_CHANGED_OR_NOT_CURRENT_INTAKE"});}finally{selected.originals[0].raw[0]=savedByte;}assert.deepEqual(snapshot(portableRoot),portableBefore);
  const automatic=await readCodexLiveProjectSource({...args,ancestorFiles:[]});assert.equal(automatic.value.conversations[0].lineage.status,"physical-lineage-ranges-verified");assert.equal(automatic.value.conversations[0].lineage.ancestorDiscovery[0].source,"current-project-direct-directory-names");assert.ok(automatic.value.conversations[0].originals.find(row=>row.rolloutId===parentId).raw.equals(parentPrefix));
  const duplicateParent=registerFixturePath(path.join(path.dirname(parentFile),"rollout-duplicate-"+parentId+".jsonl"));fs.writeFileSync(duplicateParent,"UNSELECTED_AMBIGUOUS_BODY");const beforeAmbiguousOpen=fs.openSync;let ambiguousBodyOpens=0;
  fs.openSync=function(file,...rest){if([parentFile,duplicateParent].some(expected=>sameFixturePath(file,expected))){ambiguousBodyOpens++;throw Error("Ambiguous ancestor body opened");}return beforeAmbiguousOpen.call(this,file,...rest);};
  let ambiguous;try{ambiguous=await readCodexLiveProjectSource({...args,ancestorFiles:[]});}finally{fs.openSync=beforeAmbiguousOpen;fs.unlinkSync(duplicateParent);}assert.equal(ambiguousBodyOpens,0);assert.equal(ambiguous.value.conversations[0].lineage.status,"ancestor-physical-location-ambiguous");assert.equal(ambiguous.value.sourceCoverage.unresolvedLineageConversations,1);assert.equal(ambiguous.value.conversations[0].originals.length,1);
  const outsideFolder=registerFixturePath(path.join(home,"sessions/2020/01/01")),outsideFile=registerFixturePath(path.join(outsideFolder,"rollout-other-project-"+parentId+".jsonl"));fs.mkdirSync(outsideFolder,{recursive:true});fs.writeFileSync(outsideFile,"UNSELECTED_OTHER_PROJECT_BODY");state.row("projects",{id:"different-project",name:"Unselected synthetic Project"});state.row("threads",{id:"01900000-0000-7000-8000-000000002099",project_id:"different-project",rollout_path:outsideFile,title:"UNSELECTED_OTHER_PROJECT_TITLE"});
  const beforeScopedOpen=fs.openSync,beforeScopedDir=fs.opendirSync;let outsideAccesses=0;fs.openSync=function(file,...rest){if(sameFixturePath(file,outsideFile)){outsideAccesses++;throw Error("Foreign Project file opened");}return beforeScopedOpen.call(this,file,...rest);};fs.opendirSync=function(file,...rest){if(sameFixturePath(file,outsideFolder)){outsideAccesses++;throw Error("Foreign Project directory scanned");}return beforeScopedDir.call(this,file,...rest);};
  try{const scoped=await readCodexLiveProjectSource({...args,ancestorFiles:[]});assert.equal(scoped.value.conversations[0].lineage.status,"physical-lineage-ranges-verified");}finally{fs.openSync=beforeScopedOpen;fs.opendirSync=beforeScopedDir;}assert.equal(outsideAccesses,0);
  const oldBranchLocation=state.db.prepare("SELECT rollout_path FROM threads WHERE id=?").get(branchThread).rollout_path;
  state.db.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(parentFile,branchThread);try{await assert.rejects(readCodexLiveProjectSource({...args,ancestorFiles:[]}),{code:"CODEX_LIVE_ANCESTOR_STATE_HEADER_MISMATCH"});}finally{state.db.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(oldBranchLocation,branchThread);}
  const linkedAncestorDirectory=path.join(path.dirname(parentFile),"linked-ancestor");fs.symlinkSync(outsideFolder,linkedAncestorDirectory,process.platform==="win32"?"junction":"dir");
  state.db.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(path.join(linkedAncestorDirectory,path.basename(outsideFile)),branchThread);try{await assert.rejects(readCodexLiveProjectSource({...args,ancestorFiles:[]}),{code:"PROJECT_COPY_UNSAFE_PATH"});}finally{state.db.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(oldBranchLocation,branchThread);fs.unlinkSync(linkedAncestorDirectory);}
  const parentBeforeScopeCheck=fs.readFileSync(parentFile),firstParentEnd=parentBeforeScopeCheck.indexOf(10)+1,foreignHeader=JSON.parse(parentBeforeScopeCheck.subarray(0,firstParentEnd));foreignHeader.payload.id="01900000-0000-7000-8000-000000002099";const foreignHeaderRaw=encode([foreignHeader]);fs.writeFileSync(parentFile,Buffer.concat([foreignHeaderRaw,parentBeforeScopeCheck.subarray(firstParentEnd)]));
  const scopeOpen=fs.openSync,scopeRead=fs.readSync,scopeClose=fs.closeSync,parentFds=new Set();let furthestParentRead=0;
  fs.openSync=function(file,...rest){const fd=scopeOpen.call(this,file,...rest);if(sameFixturePath(file,parentFile))parentFds.add(fd);return fd;};fs.readSync=function(fd,buffer,offset,length,position){if(parentFds.has(fd))furthestParentRead=Math.max(furthestParentRead,position+length);return scopeRead.call(this,fd,buffer,offset,length,position);};fs.closeSync=function(fd){parentFds.delete(fd);return scopeClose.call(this,fd);};
  try{const foreign=await readCodexLiveProjectSource({...args,ancestorFiles:[]});assert.equal(foreign.value.conversations[0].lineage.status,"ancestor-header-outside-current-project");assert.equal(foreign.value.conversations[0].originals.length,1);assert.ok(furthestParentRead>0);assert.ok(furthestParentRead<=foreignHeaderRaw.length);}finally{fs.openSync=scopeOpen;fs.readSync=scopeRead;fs.closeSync=scopeClose;fs.writeFileSync(parentFile,parentBeforeScopeCheck);}
  const ancestorDenied=Object.assign(new Error("Synthetic discovered ancestor denied"),{code:"EACCES",path:parentFile,syscall:"open"}),ancestorOpen=fs.openSync,ancestorLstat=fs.lstatSync,ancestorDir=fs.opendirSync;let ancestorRefused=false,afterAncestorRefusal=0;
  fs.openSync=function(file,...rest){if(ancestorRefused){afterAncestorRefusal++;throw Error("Open after ancestor refusal");}if(sameFixturePath(file,parentFile)){ancestorRefused=true;throw ancestorDenied;}return ancestorOpen.call(this,file,...rest);};fs.lstatSync=function(...values){if(ancestorRefused){afterAncestorRefusal++;throw Error("Stat after ancestor refusal");}return ancestorLstat.apply(this,values);};fs.opendirSync=function(...values){if(ancestorRefused){afterAncestorRefusal++;throw Error("Discovery after ancestor refusal");}return ancestorDir.apply(this,values);};
  try{await assert.rejects(readCodexLiveProjectSource({...args,ancestorFiles:[]}),error=>error===ancestorDenied);}finally{fs.openSync=ancestorOpen;fs.lstatSync=ancestorLstat;fs.opendirSync=ancestorDir;}assert.equal(ancestorRefused,true);assert.equal(afterAncestorRefusal,0);
  fs.renameSync(parentFile,parentFile+".not-in-discovery");try{const missing=await readCodexLiveProjectSource({...args,ancestorFiles:[]});assert.equal(missing.value.conversations[0].lineage.status,"ancestor-not-in-current-project-location-scope");assert.equal(missing.value.conversations[0].nativePublicationReady,false);}finally{fs.renameSync(parentFile+".not-in-discovery",parentFile);}
  const missingSibling=path.join(home,"sessions/2026/11/06/rollout-missing-"+branchThread+".jsonl");state.db.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(missingSibling,branchThread);
  const whole=await readCodexLiveProjectSource({...args,threadIds:undefined});assert.equal(whole.value.sourceCoverage.selectedConversations,2);assert.equal(whole.value.sourceCoverage.rawRetainedConversations,1);assert.equal(whole.value.sourceCoverage.unavailableConversations,1);assert.equal(whole.value.conversations.find(row=>row.threadId===branchThread).reasonCode,"CODEX_LIVE_SELECTED_FILE_NOT_FOUND");assert.equal(whole.value.conversations.find(row=>row.threadId===branchThread).primarySourceFailure.code,"ENOENT");assert.ok(whole.value.conversations.find(row=>row.threadId===sourceThread).originals.length>0);assert.equal(whole.value.sourceCoverage.completeNativeInventoryClaimed,false);
  const secondFile=path.join(home,"sessions/2026/11/06/rollout-batch-"+branchThread+".jsonl");
  fs.writeFileSync(secondFile,encode([frame(0,"session_meta",{id:branchThread,session_id:branchThread,cli_version:nativeProfile.engineVersion,history_mode:"paginated",history_base:null})]));
  state.db.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(secondFile,branchThread);
  try {
    const both=await readCodexLiveProjectSource({...args,threadIds:undefined}),batch=encodeCodexObservedLivePhysicalSources({observation:both});
    assert.equal(batch.encoded.size,2);
    for(const row of both.value.conversations)assert.equal(batch.encoded.get(row.threadId).payloadDigest,encodeCodexObservedLivePhysicalSource({observation:both,threadId:row.threadId}).payloadDigest);
    let returned=null,checks=0;
    try{assert.throws(()=>{returned=encodeCodexObservedLivePhysicalSources({observation:both,check(){if(++checks===2)both.value.sourceCoverage.semanticHistoryEquivalent=true;}});},{code:"CODEX_LIVE_OBSERVATION_CHANGED_OR_NOT_CURRENT_INTAKE"});assert.equal(returned,null);}finally{both.value.sourceCoverage.semanticHistoryEquivalent=false;}
    let cutoffChecks=0;const denied=Object.assign(new Error("batch denied"),{code:"EACCES"});
    assert.throws(()=>{returned=encodeCodexObservedLivePhysicalSources({observation:both,check(){if(++cutoffChecks>=4)throw denied;}});},error=>error===denied);assert.equal(returned,null);
    const changed=both.value.conversations[0].originals[0].raw,first=changed[changed.length-2];
    try{changed[changed.length-2]^=1;assert.throws(()=>encodeCodexObservedLivePhysicalSources({observation:both}),{code:"CODEX_LIVE_OBSERVATION_CHANGED_OR_NOT_CURRENT_INTAKE"});}finally{changed[changed.length-2]=first;}
  } finally {state.db.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(missingSibling,branchThread);}
  const onlyMissing=await readCodexLiveProjectSource({...args,threadIds:[branchThread]});assert.equal(onlyMissing.value.sourceCoverage.rawRetainedConversations,0);assert.equal(onlyMissing.value.sourceCoverage.unavailableConversations,1);
  state.db.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run("X:/synthetic-outside/not-authorized.jsonl",branchThread);
  const unsupported=await readCodexLiveProjectSource({...args,threadIds:undefined});assert.equal(unsupported.value.sourceCoverage.rawRetainedConversations,1);assert.equal(unsupported.value.conversations.find(row=>row.threadId===branchThread).reasonCode,"CODEX_LIVE_SELECTED_PATH_UNQUALIFIED");
  const combinedRoot=path.join(base,"combined-live-portable");fs.mkdirSync(combinedRoot);const combined=await exportCodexLiveProjectEvidence({...args,directory:combinedRoot,threadIds:undefined});assert.equal(combined.liveSource.sourceCoverage.selectedConversations,2);assert.equal(combined.liveSource.sourceCoverage.unavailableConversations,1);assert.equal(combined.sources.length,1);assert.equal(combined.nativePublicationAttempted,false);assert.equal(combined.targetJournalSelected,false);assert.equal(combined.liveSource.rows.find(row=>row.threadId===branchThread).representation,"partial-live-evidence-only");
  const compressedRelative=parentRelative+".zst",compressedPath=path.join(home,compressedRelative);
  const compressedOriginal=zlib.zstdCompressSync(Buffer.concat([parentPrefix,Buffer.from("unselected parent future")]),{params:{[zlib.constants.ZSTD_c_checksumFlag]:1}});
  fs.writeFileSync(compressedPath,compressedOriginal);
  const compressedRoot=path.join(base,"compressed-live-portable");fs.mkdirSync(compressedRoot);
  const compressedArchive=await exportCodexLiveProjectEvidence({...args,directory:compressedRoot,ancestorFiles:[{rolloutId:parentId,path:compressedRelative}]});
  const compressedRead=inspectPortableProjectEvidence({directory:compressedRoot,archiveId:compressedArchive.archiveId,expectedArchiveDigest:compressedArchive.archiveDigest,assertCurrentAuthority:()=>{}});
  const compressedRow=compressedRead.manifest.liveCapture.rows.find(row=>row.threadId===sourceThread).originals.find(row=>row.rolloutId===parentId);
  assert.equal(compressedRow.sourceEncoding,"zstd-decoded-selected-prefix");
  assert.equal(compressedRow.compressionEvidence.fullContainerChecksumVerified,false);
  assert.equal(compressedRow.compressionEvidence.compressedOriginalStored,false);
  assert.equal(compressedRow.original.sha256,hash(parentPrefix));
  assert.equal(compressedRead.sources[0].native.payload.files.find(row=>row.rolloutId===parentId).sourceEncoding,"zstd-decoded-selected-prefix");
  assert.deepEqual(fs.readFileSync(compressedPath),compressedOriginal);assert.equal(compressedRead.sources[0].native.proof.status,"physical-lineage-ranges-verified");
  const publicRoots=["core","cli","mcp"].map(name=>path.join(base,"public-live-"+name));for(const directory of publicRoots)fs.mkdirSync(directory);let publicNativeCalls=0;
  const noSourceClient={provider:"codex",version:()=>{publicNativeCalls++;throw Error("Live SQLite capture must not launch the source client");}};
  const publicCore=await operateProjectNativeHistory({action:"capture-live-project",provider:"codex",bundleRoot:publicRoots[0],nativeHome:home,sourceProjectId:"live-project",sourceSyncFiles:true,ancestorFiles:args.ancestorFiles,nativeHistoryHost:noSourceClient});
  const publicCli=await runCommand(["project-native-history",publicRoots[1],"--action","capture-live-project","--provider","codex","--native-home",home,"--source-project","live-project","--source-sync-files","--ancestor-files",JSON.stringify(args.ancestorFiles)]);
  const publicMcp=await dispatch({jsonrpc:"2.0",id:441,method:"tools/call",params:{name:"lode_project_native_history",arguments:{action:"capture-live-project",provider:"codex",bundle_root:publicRoots[2],native_home:home,source_project_id:"live-project",source_sync_files:true,ancestor_files:args.ancestorFiles}}},{nativeHistoryHost:noSourceClient});assert.equal(publicMcp.error,undefined,JSON.stringify(publicMcp.error));
  for(const result of [publicCore,publicCli,publicMcp.result.structuredContent]){assert.equal(result.liveSource.sourceCoverage.selectedConversations,2);assert.equal(result.liveSource.sourceCoverage.unavailableConversations,1);assert.equal(result.sources[0].payloadDigest,combined.sources[0].payloadDigest);assert.equal(result.nativePublicationAttempted,false);assert.equal(result.imported,false);}assert.equal(publicNativeCalls,0);
  for(const directory of publicRoots){assert.equal(fs.existsSync(path.join(directory,".lode")),false);assert.equal(fs.existsSync(path.join(directory,".head")),false);}
  await assert.rejects(operateProjectNativeHistory({action:"capture-live-project",provider:"codex",bundleRoot:publicRoots[0],nativeHome:home,sourceProjectId:"live-project",sourceSyncFiles:false}),{code:"CODEX_LIVE_SOURCE_SYNC_POLICY_REQUIRED"});
  await assert.rejects(operateProjectNativeHistory({action:"read-project-evidence",bundleRoot:publicRoots[0],archiveId:publicCore.archiveId,sourceSyncFiles:true}),{code:"LIVE_PROJECT_CAPTURE_ARGUMENTS_ON_OTHER_ACTION"});
  fs.renameSync(parentFile,parentFile+".retained");try{const missingAncestor=await readCodexLiveProjectSource(args);assert.equal(missingAncestor.value.conversations[0].lineage.status,"explicit-ancestor-file-not-found");assert.equal(missingAncestor.value.conversations[0].originals.length,1);}finally{fs.renameSync(parentFile+".retained",parentFile);}
  const sourceDenied=Object.assign(new Error("Synthetic selected source permission denial"),{code:"EACCES",path:leafFile,syscall:"lstat"}),realLstat=fs.lstatSync,realOpen=fs.openSync,realRead=fs.readSync;let denied=false,afterDeniedFs=0;
  fs.lstatSync=function(file,...rest){if(denied){afterDeniedFs++;throw Error("Filesystem observation after denied source");}if(sameFixturePath(file,leafFile)){denied=true;throw sourceDenied;}return realLstat.call(this,file,...rest);};
  fs.openSync=function(...values){if(denied)afterDeniedFs++;return realOpen.apply(this,values);};fs.readSync=function(...values){if(denied)afterDeniedFs++;return realRead.apply(this,values);};
  try{await assert.rejects(readCodexLiveProjectSource(args),error=>error===sourceDenied);}finally{fs.lstatSync=realLstat;fs.openSync=realOpen;fs.readSync=realRead;}assert.equal(denied,true);assert.equal(afterDeniedFs,0);
  assert.equal(fs.existsSync(path.join(base,".lode")),false);assert.equal(fs.existsSync(path.join(base,".head")),false);
  const before=fs.readFileSync(leafFile);await assert.rejects(readCodexLiveProjectSource({...args,onBoundary:phase=>{if(phase==="raw-read"){const changed=Buffer.from(fs.readFileSync(leafFile)),at=changed.indexOf("MAPLE-912");changed[at]=78;fs.writeFileSync(leafFile,changed);}}}),{code:"CODEX_LIVE_ROLLOUT_PREFIX_CHANGED"});fs.writeFileSync(leafFile,before);
  history.db.prepare("UPDATE thread_history_projection_state SET next_rollout_byte_offset=next_rollout_byte_offset-1 WHERE thread_id=?").run(leafId);await assert.rejects(readCodexLiveProjectSource(args),{code:"CODEX_LIVE_HISTORY_WATERMARK_BOUNDARY_INVALID"});
  assert.equal(codexLiveReadGuardProcessStatus().length,0);assert.equal(events.filter(row=>row.event==="started").length,events.filter(row=>row.event==="closed").length);
});

test("portable optional workspaces restore streamed binary/code/docs with the source PC absent, explicit reuse, exclusions and per-root conflicts", async t => {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),"lode-workspace-archive-"));t.after(()=>{if(path.dirname(fs.realpathSync(base))!==fs.realpathSync(os.tmpdir()))throw Error("Unexpected workspace fixture cleanup root");fs.rmSync(base,{recursive:true,force:true});});
  const codeA=path.join(base,"source-code-A"),codeB=path.join(base,"source-code-B"),archive=path.join(base,"archive");for(const root of [codeA,codeB,archive])fs.mkdirSync(root);
  const canonicalBase=nativeRoot(base),canonicalCodeA=nativeRoot(codeA),canonicalArchive=nativeRoot(archive);
  const workspacePathForms=file=>[file,path.join(canonicalBase,path.relative(base,file))];
  const workspaceInside=(file,root)=>{if(typeof file!=="string")return false;const key=codexSourcePathKey(file);return key!==null&&workspacePathForms(root).map(value=>codexSourcePathKey(value)).some(expected=>key===expected||key.startsWith(expected+path.sep));};
  const originalsA={"src/app.mjs":Buffer.from("export const synthetic = 'WILLOW-719';\n"),"docs/guide.md":Buffer.from("# 합성 프로젝트\n선택한 코드와 문서를 보존합니다.\n"),"assets/bytes.bin":Buffer.alloc(8*1024*1024,93),"empty.txt":Buffer.alloc(0),".env.example":Buffer.from("EXAMPLE_ONLY=1\n"),".env":Buffer.from("SYNTHETIC_PRIVATE_NOT_A_REAL_SECRET"),".git/config":Buffer.from("Synthetic excluded Git metadata"),".codex/config.toml":Buffer.from("Synthetic private client configuration"),".ssh/id_synthetic":Buffer.from("Synthetic excluded private identity")};
  originalsA["docs/한국어 안내.md"]=Buffer.from("한글 파일명과 공백을 그대로 보존합니다.\n");originalsA[Array.from({length:12},(_,i)=>"long-segment-"+i).join("/")+"/selected-file.txt"]=Buffer.from("Synthetic long path\n");originalsA["CLAUDE.md"]=Buffer.from("Archived source guidance only; never automatically activate this old direction.\n");originalsA[".mcp.json"]=Buffer.from('{"synthetic":"private connection settings; do not read or transfer"}');
  originalsA["src/AGENTS.md"]=Buffer.from("Nested historical agent guidance remains passive evidence.\n");
  originalsA["certs/service.key"]=Buffer.from("Synthetic named private-key container, not a real credential");originalsA["certs/store.p12"]=Buffer.from([1,2,0,255]);originalsA["certs/private.pem"]=Buffer.from("-----BEGIN PRIVATE KEY-----\nSYNTHETIC_NOT_A_REAL_KEY\n-----END PRIVATE KEY-----\n");originalsA["certs/public.pem"]=Buffer.from("-----BEGIN CERTIFICATE-----\nSYNTHETIC_PUBLIC_CERTIFICATE_EXAMPLE\n-----END CERTIFICATE-----\n");
  originalsA["assets/bytes.bin"][0]=0;originalsA["assets/bytes.bin"][1]=255;originalsA["assets/bytes.bin"][2]=128;
  for(const [name,raw]of Object.entries(originalsA)){fs.mkdirSync(path.dirname(path.join(codeA,name)),{recursive:true});fs.writeFileSync(path.join(codeA,name),raw);}fs.mkdirSync(path.join(codeB,"src"));fs.writeFileSync(path.join(codeB,"src/other.mjs"),originalsA["src/app.mjs"]);
  const database=syntheticNativeDatabase(t,"state_5.sqlite");let catalog;try{database.row("projects",{id:"workspace-project",name:"Synthetic optional files"});database.row("threads",{id:sourceThread,project_id:"workspace-project",cwd:codeA});database.row("threads",{id:branchThread,project_id:"workspace-project",cwd:codeB});catalog=readCodexProjectCatalog(database.db,"workspace-project");}finally{database.close();}
  const catalogFile=path.join(base,"catalog.json"),catalogBytes=Buffer.from(JSON.stringify(catalog,null,2)+"\n");fs.writeFileSync(catalogFile,catalogBytes);
  const inputs={directory:archive,catalogFile,expectedCatalogDigest:hash(catalogBytes),workspaceSources:[{sourceRoot:codeA,paths:Object.keys(originalsA)},{sourceRoot:codeB,paths:["src/other.mjs"]}],assertCurrentAuthority:()=>{}};
  const privateFiles=new Set([".env",".git/config",".codex/config.toml",".ssh/id_synthetic",".mcp.json","certs/service.key","certs/store.p12"].flatMap(name=>[path.join(codeA,name),path.join(canonicalCodeA,name)])),open=fs.openSync,readAll=fs.readFileSync,read=fs.readSync,concat=Buffer.concat;let privateOpens=0,wholeBinaryReads=0,maxReadBuffer=0;
  const binaryHash=hash(originalsA["assets/bytes.bin"]),binaryNames=new Set([path.join(codeA,"assets/bytes.bin"),path.join(canonicalCodeA,"assets/bytes.bin"),path.join(archive,"objects",binaryHash+".bin"),path.join(canonicalArchive,"objects",binaryHash+".bin")]);
  for(const file of [path.join(codeA,"assets/bytes.bin"),path.join(canonicalCodeA,"assets/bytes.bin"),path.join(archive,"objects",binaryHash+".bin"),path.join(canonicalArchive,"objects",binaryHash+".bin")])assert.ok(binaryNames.has(file));assert.equal(binaryNames.has(path.join(canonicalCodeA,"src/app.mjs")),false);assert.ok(privateFiles.has(path.join(canonicalCodeA,".env")));assert.equal(privateFiles.has(path.join(canonicalCodeA,".env.example")),false);
  fs.openSync=function(file,...rest){if(privateFiles.has(file)){privateOpens++;throw Error("Private source opened");}return open.call(this,file,...rest);};
  fs.readFileSync=function(file,...rest){if(binaryNames.has(file)){wholeBinaryReads++;throw Error("Whole binary read instead of bounded streaming");}return readAll.call(this,file,...rest);};
  fs.readSync=function(fd,buffer,...rest){if(buffer?.length)maxReadBuffer=Math.max(maxReadBuffer,buffer.length);return read.call(this,fd,buffer,...rest);};
  Buffer.concat=function(chunks,length){if((length??chunks.reduce((n,row)=>n+row.length,0))>=originalsA["assets/bytes.bin"].length){wholeBinaryReads++;throw Error("Whole binary materialized in memory");}return concat.call(this,chunks,length);};
  let captured;try{captured=exportPortableProjectEvidence(inputs);inspectPortableProjectEvidence({directory:archive,archiveId:captured.archiveId,expectedArchiveDigest:captured.archiveDigest});}finally{fs.openSync=open;fs.readFileSync=readAll;fs.readSync=read;Buffer.concat=concat;}
  assert.equal(privateOpens,0);assert.equal(wholeBinaryReads,0);assert.ok(maxReadBuffer<=65536);assert.equal(captured.workspaceEvidence.length,2);assert.equal(captured.workspaceEvidence.find(row=>row.sourceRoot===nativeRoot(codeA)).excludedPaths.length,8);assert.equal(captured.workspaceEvidence.find(row=>row.sourceRoot===nativeRoot(codeA)).capturedFiles,8);assert.equal(captured.workspaceEvidence.find(row=>row.sourceRoot===nativeRoot(codeA)).evidenceOnlyPaths.length,2);assert.equal(captured.workspaceEvidence.find(row=>row.sourceRoot===nativeRoot(codeA)).evidenceOnlyPaths[0].path,"CLAUDE.md");assert.equal(captured.nativePublicationAttempted,false);assert.equal(fs.existsSync(path.join(archive,"objects",hash(originalsA["certs/private.pem"])+".bin")),false);
  for(const [name,raw]of Object.entries(originalsA))assert.ok(fs.readFileSync(path.join(codeA,name)).equals(raw));
  const sourceAKey=captured.workspaceEvidence[0].sourceRoot,sourceBKey=captured.workspaceEvidence[1].sourceRoot;
  const incomplete=exportPortableProjectEvidence({...inputs,workspaceSources:[{sourceRoot:codeA,paths:["src/app.mjs","missing-current-file.md"]}]});assert.equal(incomplete.workspaceEvidence[0].unavailablePaths.length,1);
  fs.mkdirSync(path.join(codeA,"moved-archive"));fs.writeFileSync(path.join(codeA,"moved-archive/injected.mjs"),"Synthetic overlap fixture\n");const overlapArchive=exportPortableProjectEvidence({...inputs,workspaceSources:[{sourceRoot:codeA,paths:["moved-archive/injected.mjs"]}]});
  const hardlink=path.join(codeA,"src/linked.mjs");fs.linkSync(path.join(codeA,"src/app.mjs"),hardlink);try{assert.throws(()=>exportPortableProjectEvidence({...inputs,workspaceSources:[{sourceRoot:codeA,paths:["src/linked.mjs"]}]}),{code:"PROJECT_COPY_UNSAFE_FILE"});}finally{fs.unlinkSync(hardlink);}
  const moved=path.join(base,"moved-archive");fs.cpSync(archive,moved,{recursive:true});
  for(const root of [codeA,codeB]){const movedSource=root+"-retained";assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(base));assert.equal(path.dirname(path.resolve(movedSource)),fs.realpathSync(base));fs.renameSync(root,movedSource);}
  const targetA=path.join(base,"destination-A/nested/project"),targetB=path.join(base,"destination-B"),scope={action:"restore-portable-workspaces",bundleRoot:moved,archiveId:captured.archiveId,expectedArchiveDigest:captured.archiveDigest,workspaceTargets:[{sourceRoot:sourceAKey,targetRoot:targetA},{sourceRoot:sourceBKey,targetRoot:targetB}]};
  const originalLstat=fs.lstatSync,originalOpen=fs.openSync;let oldSourceReads=0;
  const isOld=file=>[codeA,codeB].some(root=>workspaceInside(file,root));
  fs.lstatSync=function(file,...rest){if(isOld(file)){oldSourceReads++;throw Error("Original workspace path followed");}return originalLstat.call(this,file,...rest);};fs.openSync=function(file,...rest){if(isOld(file)){oldSourceReads++;throw Error("Original workspace file opened");}return originalOpen.call(this,file,...rest);};
  let restored;try{restored=await operateProjectNativeHistory(scope);}finally{fs.lstatSync=originalLstat;fs.openSync=originalOpen;}
  assert.equal(oldSourceReads,0);assert.equal(restored.pendingSourceRoots.length,0);assert.equal(restored.results.reduce((count,row)=>count+row.filesWritten,0),9);assert.equal(restored.nextConversationMappings.length,2);assert.equal(restored.initializedProjectOrSession,false);assert.equal(restored.results[0].sourceExecutableMetadataApplied,false);assert.equal(restored.results[0].evidenceOnlyPaths[0].path,"CLAUDE.md");
  for(const [name,raw]of Object.entries(originalsA)){const excluded=privateFiles.has(path.join(codeA,name))||["CLAUDE.md","src/AGENTS.md","certs/private.pem"].includes(name);if(excluded)assert.equal(fs.existsSync(path.join(targetA,name)),false);else assert.ok(fs.readFileSync(path.join(targetA,name)).equals(raw),name);}assert.ok(fs.readFileSync(path.join(targetB,"src/other.mjs")).equals(originalsA["src/app.mjs"]));
  const repeated=await operateProjectNativeHistory(scope);assert.equal(repeated.results.reduce((count,row)=>count+row.filesWritten,0),0);
  const conflict=path.join(base,"conflict-target"),independent=path.join(base,"independent-target");fs.mkdirSync(path.join(conflict,"src"),{recursive:true});fs.writeFileSync(path.join(conflict,"src/app.mjs"),"Keep the current user's edit\n");
  const conflicts=await operateProjectNativeHistory({...scope,workspaceTargets:[{sourceRoot:sourceAKey,targetRoot:conflict},{sourceRoot:sourceBKey,targetRoot:independent}]});assert.equal(conflicts.results[0].status,"workspace-file-conflicts");assert.equal(conflicts.results[0].filesWritten,0);assert.equal(conflicts.results[1].filesWritten,1);assert.equal(fs.readFileSync(path.join(conflict,"src/app.mjs"),"utf8"),"Keep the current user's edit\n");assert.equal(fs.existsSync(path.join(conflict,"docs/guide.md")),false);
  const reused=await operateProjectNativeHistory({...scope,workspaceTargets:[{sourceRoot:sourceAKey,targetRoot:conflict,mode:"reuse"}]});assert.equal(reused.results[0].status,"existing-workspace-reused");assert.equal(reused.results[0].sourceVersionEquivalenceClaimed,false);assert.equal(reused.results[0].filesWritten,0);
  const junction=path.join(base,"target-junction");let madeJunction=false;try{fs.symlinkSync(targetB,junction,process.platform==="win32"?"junction":"dir");madeJunction=true;}catch(error){if(!["EACCES","EPERM","ENOSYS"].includes(error.code))throw error;t.diagnostic("Native alias fixture unavailable: "+error.code);}
  if(madeJunction)await assert.rejects(operateProjectNativeHistory({...scope,workspaceTargets:[{sourceRoot:sourceAKey,targetRoot:junction}]}),{code:"NATIVE_HISTORY_UNSAFE_ROOT"});
  const flatten=path.join(base,"not-created-merge");await assert.rejects(operateProjectNativeHistory({...scope,workspaceTargets:[{sourceRoot:sourceAKey,targetRoot:flatten},{sourceRoot:sourceBKey,targetRoot:flatten}]}),{code:"PORTABLE_WORKSPACE_DISTINCT_ROOT_MERGE"});assert.equal(fs.existsSync(flatten),false);
  const archiveSnapshot=snapshot(moved);for(const targetRoot of [moved,path.join(moved,"uncreated-code-target")])await assert.rejects(operateProjectNativeHistory({...scope,workspaceTargets:[{sourceRoot:sourceBKey,targetRoot}]}),{code:"PORTABLE_WORKSPACE_ARCHIVE_TARGET_OVERLAP"});assert.deepEqual(snapshot(moved),archiveSnapshot);assert.equal(fs.existsSync(path.join(moved,"uncreated-code-target")),false);
  await assert.rejects(operateProjectNativeHistory({...scope,archiveId:overlapArchive.archiveId,expectedArchiveDigest:overlapArchive.archiveDigest,workspaceTargets:[{sourceRoot:sourceAKey,targetRoot:base}]}),{code:"PORTABLE_WORKSPACE_ARCHIVE_TARGET_OVERLAP"});assert.deepEqual(snapshot(moved),archiveSnapshot);
  const safeParent=await operateProjectNativeHistory({...scope,workspaceTargets:[{sourceRoot:sourceAKey,targetRoot:base}]});assert.equal(safeParent.results[0].status,"selected-workspace-files-restored");assert.deepEqual(snapshot(moved),archiveSnapshot);
  const archiveReuse=await operateProjectNativeHistory({...scope,workspaceTargets:[{sourceRoot:sourceBKey,targetRoot:moved,mode:"reuse"}]});assert.equal(archiveReuse.results[0].filesWritten,0);assert.equal(archiveReuse.results[0].status,"existing-workspace-reused");assert.deepEqual(snapshot(moved),archiveSnapshot);
  const cliTarget=path.join(base,"cli-code"),mcpTarget=path.join(base,"mcp-code");const cli=await runCommand(["project-native-history",moved,"--action","restore-portable-workspaces","--archive",captured.archiveId,"--expected-archive",captured.archiveDigest,"--workspace-targets",JSON.stringify([{sourceRoot:sourceBKey,targetRoot:cliTarget}])]);assert.equal(cli.results[0].filesWritten,1);
  const mcp=await dispatch({jsonrpc:"2.0",id:608,method:"tools/call",params:{name:"lode_project_native_history",arguments:{action:"restore-portable-workspaces",bundle_root:moved,archive_id:captured.archiveId,expected_archive_digest:captured.archiveDigest,workspace_targets:[{sourceRoot:sourceBKey,targetRoot:mcpTarget}]}}});assert.equal(mcp.error,undefined,JSON.stringify(mcp.error));assert.equal(mcp.result.structuredContent.results[0].filesWritten,1);
  const missingTarget=path.join(base,"partial-code"),partial=await operateProjectNativeHistory({...scope,archiveId:incomplete.archiveId,expectedArchiveDigest:incomplete.archiveDigest,workspaceTargets:[{sourceRoot:sourceAKey,targetRoot:missingTarget}]});assert.equal(partial.results[0].status,"selected-workspace-files-restored-with-missing-source");assert.equal(partial.results[0].filesWritten,1);assert.equal(partial.results[0].unavailablePaths[0].path,"missing-current-file.md");assert.equal(partial.nextConversationMappings.length,1);
  const deniedTarget=path.join(base,"denied-copy-target"),guideHash=hash(originalsA["docs/guide.md"]),denial=Object.assign(new Error("Synthetic selected target file write denied"),{code:"EACCES"}),normalOpen=fs.openSync,normalLstat=fs.lstatSync,normalRead=fs.readSync;let refused=false,afterRefusal=0;
  fs.openSync=function(file,...rest){if(refused){afterRefusal++;throw Error("Extra filesystem open after denial");}if(workspaceInside(file,deniedTarget)&&file.endsWith(".part")&&file.includes(guideHash)){refused=true;throw denial;}return normalOpen.call(this,file,...rest);};
  fs.lstatSync=function(...values){if(refused){afterRefusal++;throw Error("Extra filesystem metadata after denial");}return normalLstat.apply(this,values);};fs.readSync=function(...values){if(refused){afterRefusal++;throw Error("Extra filesystem read after denial");}return normalRead.apply(this,values);};
  try{await assert.rejects(operateProjectNativeHistory({...scope,workspaceTargets:[{sourceRoot:sourceAKey,targetRoot:deniedTarget}]}),error=>error===denial);}finally{fs.openSync=normalOpen;fs.lstatSync=normalLstat;fs.readSync=normalRead;}
  assert.equal(afterRefusal,0);assert.ok(denial.portableWorkspaceObservation.active.completedPaths.length>=1);assert.equal(denial.portableWorkspaceObservation.active.currentPath,"docs/guide.md");assert.equal(denial.portableWorkspaceObservation.active.currentEffect,"create-only-copy-entered");assert.ok(denial.portableWorkspaceObservation.active.unvisitedPaths.length>0);assert.equal(fs.existsSync(path.join(deniedTarget,"docs/guide.md")),false);
  const deniedMcpTarget=path.join(base,"denied-mcp-target");fs.openSync=function(file,...rest){if(workspaceInside(file,deniedMcpTarget)&&file.endsWith(".part"))throw Object.assign(new Error("Synthetic MCP write denial"),{code:"EACCES"});return normalOpen.call(this,file,...rest);};let deniedMcp;
  try{deniedMcp=await dispatch({jsonrpc:"2.0",id:609,method:"tools/call",params:{name:"lode_project_native_history",arguments:{action:"restore-portable-workspaces",bundle_root:moved,archive_id:captured.archiveId,expected_archive_digest:captured.archiveDigest,workspace_targets:[{sourceRoot:sourceBKey,targetRoot:deniedMcpTarget}]}}});}finally{fs.openSync=normalOpen;}assert.equal(deniedMcp.error.data.code,"EACCES");assert.equal(deniedMcp.error.data.partialWorkspaceRestore.kind,"PortableWorkspaceRestorePartialOutcome");
  // Passive instruction bytes are not copied or activated. Their integrity is
  // explicitly unobserved here, while a full evidence read must still reject.
  const passiveArchive=path.join(base,"passive-corrupt-archive"),passiveTarget=path.join(base,"passive-corrupt-code-target");fs.cpSync(moved,passiveArchive,{recursive:true});
  const passiveObject=path.join(passiveArchive,"objects",hash(originalsA["CLAUDE.md"])+".bin"),passiveFd=fs.openSync(passiveObject,"r+");try{fs.writeSync(passiveFd,Buffer.from([0]),0,1,0);}finally{fs.closeSync(passiveFd);}
  const passiveRestored=await operateProjectNativeHistory({...scope,bundleRoot:passiveArchive,workspaceTargets:[{sourceRoot:sourceAKey,targetRoot:passiveTarget}]});
  assert.equal(passiveRestored.results[0].filesWritten,8);assert.ok(fs.readFileSync(path.join(passiveTarget,"assets/bytes.bin")).equals(originalsA["assets/bytes.bin"]));assert.equal(fs.existsSync(path.join(passiveTarget,"CLAUDE.md")),false);
  assert.equal(passiveRestored.workspaceObjectCoverage.objectSelection,"restore-captured-only");assert.ok(passiveRestored.workspaceObjectCoverage.partiallyVerifiedSourceRoots.includes(sourceAKey));assert.ok(!passiveRestored.workspaceObjectCoverage.verifiedSourceRoots.includes(sourceAKey));
  assert.equal(passiveRestored.workspaceObjectCoverage.unverifiedObjectCount,2);assert.equal(passiveRestored.workspaceObjectCoverage.unverifiedObjectIntegrity,"not-observed-by-this-operation");assert.equal(passiveRestored.workspaceObjectCoverage.resolvesPriorFailures,false);
  await assert.rejects(operateProjectNativeHistory({action:"read-project-evidence",bundleRoot:passiveArchive,archiveId:captured.archiveId,expectedArchiveDigest:captured.archiveDigest}),{code:"PORTABLE_EVIDENCE_OBJECT_CHANGED"});
  const object=path.join(moved,"objects",binaryHash+".bin"),fd=fs.openSync(object,"r+");try{fs.writeSync(fd,Buffer.from([1]),0,1,0);}finally{fs.closeSync(fd);}const corruptTarget=path.join(base,"corrupt-not-created");await assert.rejects(operateProjectNativeHistory({...scope,workspaceTargets:[{sourceRoot:sourceAKey,targetRoot:corruptTarget}]}),{code:"PORTABLE_EVIDENCE_OBJECT_CHANGED"});assert.equal(fs.existsSync(corruptTarget),false);
  await assert.rejects(operateProjectNativeHistory({action:"read-project-evidence",bundleRoot:moved,archiveId:captured.archiveId,expectedArchiveDigest:captured.archiveDigest}),{code:"PORTABLE_EVIDENCE_OBJECT_CHANGED"});
  const unrelatedTarget=path.join(base,"unrelated-code-B-after-A-corruption"),unrelated=await operateProjectNativeHistory({...scope,workspaceTargets:[{sourceRoot:sourceBKey,targetRoot:unrelatedTarget}]});assert.equal(unrelated.results[0].filesWritten,1);assert.ok(unrelated.workspaceObjectCoverage.unverifiedSourceRoots.includes(sourceAKey));
  const reuseAfterCorruption=await operateProjectNativeHistory({...scope,workspaceTargets:[{sourceRoot:sourceAKey,targetRoot:targetA,mode:"reuse"}]});assert.equal(reuseAfterCorruption.results[0].status,"existing-workspace-reused");assert.equal(reuseAfterCorruption.results[0].filesWritten,0);
  const nativeAfterCodeCorruption=await operateProjectNativeHistory({action:"read-portable-project",bundleRoot:moved,archiveId:captured.archiveId,expectedArchiveDigest:captured.archiveDigest});assert.equal(nativeAfterCodeCorruption.results.length,2);assert.ok(nativeAfterCodeCorruption.workspaceObjectCoverage.unverifiedSourceRoots.includes(sourceAKey));
  for(const root of [targetA,targetB,cliTarget,mcpTarget]){assert.equal(fs.existsSync(path.join(root,".lode")),false);assert.equal(fs.existsSync(path.join(root,".head")),false);}
});

test("authored pinned source fixture verifies evidence without claiming native capture or weakening Host qualification", async t => {
  const f = await derivedFixture(t, { sourceEvidenceOnly: true });
  const inspected = inspectCodexNativePayload({ directory: f.nativePayload });
  assert.equal(inspected.payload.platform, nativeProfile.platform);
  assert.equal(inspected.payload.architecture, nativeProfile.architecture);
  // The branch intentionally has unresolved source representation; keep that unknown.
  assert.equal(inspected.mechanicalOriginalsReady, false);
  for (const original of f.originals) {
    const entry = inspected.payload.files.find(row => row.threadId === original.threadId);
    assert.ok(fs.readFileSync(path.join(f.nativePayload, "objects", entry.sha256 + ".bin")).equals(original.raw));
  }
  assert.match(inspected.payload.sourceCutoff, /synthetic fixture; no stopped-writer/u);
  assert.equal(inspected.nativePublicationReady, false);
  assert.equal(inspected.grantsRecoveryAuthority, false);
  const target = path.join(f.f.base, "pinned-evidence-target");fs.mkdirSync(target);
  const derived = await operateProjectNativeHistory({ action: "derive", provider: "claude", bundleRoot: f.nativePayload, root: target, threadIds: [sourceThread] });
  const artifact = inspectProjectNativeDerivation({ bundleRoot: f.nativePayload, derivationId: derived.derivationId });
  assert.ok(artifact.rows.length > 0);
  assert.equal(artifact.manifest.grantsRecoveryAuthority, false);
});

test("Windows live guard startup diagnostics preserve cancellation and omit source contents", async t => {
  if(process.platform!=="win32")return;
  const parent=fs.realpathSync(os.tmpdir()),home=fs.mkdtempSync(path.join(parent,"lode-guard-diagnostic-"));
  t.after(()=>{assert.equal(path.dirname(fs.realpathSync(home)),parent);fs.rmSync(home,{recursive:true,force:true});});
  const names=["state_5.sqlite","state_5.sqlite-wal","thread_history_1.sqlite","thread_history_1.sqlite-wal"];
  for(const name of names)fs.writeFileSync(path.join(home,name),"SYNTHETIC_PRIVATE_GUARD_SOURCE");
  const before=snapshot(home),controller=new AbortController(),events=[];
  const operation=openCodexLiveReadGuard({home,allowSynchronizationFiles:true,assertCurrentAuthority:()=>{},
    signal:controller.signal,onProcess:event=>events.push(event)});
  controller.abort();
  await assert.rejects(operation,error=>{
    assert.equal(error.code,"CODEX_LIVE_SOURCE_CANCELLED");
    const observation=error.guardStartupObservation;
    assert.deepEqual(Object.keys(observation).sort(),["elapsedMs","phase","scriptSha256"]);
    assert.ok(observation.phase===null||["script-started","priority-ready","type-bootstrap","type-ready","json-ready","request-read","request-decoded","handles-open","ready-encoded"].includes(observation.phase));
    assert.ok(Number.isFinite(observation.elapsedMs)&&observation.elapsedMs>=0);
    assert.equal(observation.scriptSha256,CODEX_LIVE_GUARD_SCRIPT_SHA256);
    assert.equal(JSON.stringify(observation).includes(home),false);
    assert.equal(JSON.stringify(observation).includes("SYNTHETIC_PRIVATE_GUARD_SOURCE"),false);
    return true;
  });
  assert.equal(events.filter(event=>event.event==="startup-failed").length,1);
  assert.equal(codexLiveReadGuardProcessStatus().length,0);assert.deepEqual(snapshot(home),before);
});


function tinyBaselineJpeg({ color = false, width = color ? 16 : 8, height = color ? 16 : 8 } = {}) {
  const segment = (marker, payload) => Buffer.concat([Buffer.from([255, marker, (payload.length + 2) >>> 8, (payload.length + 2) & 255]), payload]);
  const components = color ? [1, 0x22, 0, 2, 0x11, 0, 3, 0x11, 0] : [1, 0x11, 0];
  const table = selector => Buffer.from([selector, 1, ...Array(15).fill(0), 0]);
  return Buffer.concat([Buffer.from([255, 216]), segment(219, Buffer.from([0, ...Array(64).fill(1)])),
    segment(192, Buffer.from([8, height >>> 8, height & 255, width >>> 8, width & 255, color ? 3 : 1, ...components])),
    segment(196, Buffer.concat([table(0), table(16)])),
    segment(218, Buffer.from(color ? [3, 1, 0, 2, 0, 3, 0, 0, 63, 0] : [1, 1, 0, 0, 63, 0])),
    Buffer.from(color ? [0, 15] : [63]), Buffer.from([255, 217])]);
}
function richImageNative({ version = "0.163.0-alpha.10.2", settings = { thread_id: sourceThread }, images = ["data:image/png;base64," + png], modify = () => {} } = {}) {
  const turn = "synthetic-image-turn", text = "Synthetic captured image message";
  const canonical = { id: "canonical-user", type: "UserMessage", content: [{ type: "text", text, text_elements: [] },
    ...images.map((_, index) => ({ type: "local_image", path: "C:/synthetic/captured-" + index + ".image" }))] };
  const content = [{ type: "input_text", text }], kinds = ["user.text"];
  for (const [index, image] of images.entries()) {
    content.push({ type: "input_text", text: '<image name=[Image #' + (index + 1) + '] path="' + canonical.content[index + 1].path + '">' },
      { type: "input_image", image_url: image, detail: "high" }, { type: "input_text", text: "</image>" });
    kinds.push("user.text", "user.image", "user.text");
  }
  const frames = [{ type: "session_meta", payload: { id: sourceThread, session_id: sourceThread, cli_version: version, history_mode: "paginated", history_base: null } },
    { type: "event_msg", payload: { type: "task_started", turn_id: turn } },
    { type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model: "synthetic-model" }, ...settings } },
    { type: "response_item", payload: { type: "message", id: "wire-user-different-recorded-id", role: "user", content,
      internal_chat_message_metadata_passthrough: { turn_id: turn, create_time: 0, content_item_kinds: kinds } } },
    { type: "event_msg", payload: { type: "item_completed", thread_id: sourceThread, turn_id: turn, item: canonical } },
    { type: "event_msg", payload: { type: "item_completed", thread_id: sourceThread, turn_id: turn,
      item: { type: "AgentMessage", id: "canonical-answer", phase: "final_answer", content: [{ type: "Text", text: "Synthetic historical answer" }] } } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: turn } }];
  modify(frames);
  const raw = Buffer.from(frames.map((frame, ordinal) => JSON.stringify({ ordinal, ...frame }) + "\n").join(""));
  const originals = [{ rolloutId: sourceThread, threadId: sourceThread, raw, sha256: historyHash(raw) }];
  return { payload: { threadIds: [sourceThread], selectedRolloutId: sourceThread }, originals,
    proof: resolveCodexPhysicalLineage({ originals, rolloutId: sourceThread }) };
}
function encodeRichImageNative(native, converter = CODEX_HYBRID_IMAGE_CONVERTER) {
  return encodeCodexHybrid({ read: readCodexHybridPhysical({ native, threadId: sourceThread, converter }),
    targetId: "01900000-0000-7000-8000-000000000073", cwd: "C:/synthetic", createdAt: "2026-11-07T00:00:00.000Z" });
}

test("baseline JPEG qualification reads coefficients, bounds geometry, and preserves prior codec profiles", () => {
  for (const color of [false, true]) {
    const bytes = tinyBaselineJpeg({ color }), before = Buffer.from(bytes), valid = inspectDerivedBaselineJpeg(bytes);
    assert.equal(valid.valid, true); assert.equal(valid.coefficientBlocks, color ? 6 : 1);
    assert.equal(valid.rasterDecoded, false); assert.equal(valid.providerImageProcessingVerified, false);
    assert.equal(inspectDerivedInlineImage("image/jpeg", bytes).code, "DERIVED_IMAGE_CODEC_VALIDATION_UNQUALIFIED");
    assert.equal(inspectDerivedInlineImage("image/jpeg", bytes, "png-and-baseline-jpeg-v1").valid, true);
    for (const invalid of [bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from([0])]),
      Buffer.concat([Buffer.from([0, 0]), bytes.subarray(2)])]) assert.equal(inspectDerivedBaselineJpeg(invalid).valid, false);
    const earlyMarker = Buffer.from(bytes); earlyMarker[earlyMarker.length - 3] = 255;
    assert.equal(inspectDerivedBaselineJpeg(earlyMarker).valid, false);
    const badTable = Buffer.from(bytes), dht = badTable.indexOf(Buffer.from([255, 196])); badTable[dht + 5] = 255;
    assert.equal(inspectDerivedBaselineJpeg(badTable).valid, false);
    const progressive = Buffer.from(bytes), sof = progressive.indexOf(Buffer.from([255, 192])); progressive[sof + 1] = 194;
    assert.equal(inspectDerivedBaselineJpeg(progressive).code, "DERIVED_JPEG_MARKER_UNQUALIFIED");
    const geometry = Buffer.from(bytes); geometry[sof + 5] = 255; geometry[sof + 6] = 255; geometry[sof + 7] = 255; geometry[sof + 8] = 255;
    assert.equal(inspectDerivedBaselineJpeg(geometry).code, "DERIVED_JPEG_DECODE_STORAGE_LIMIT");
    assert.deepEqual(bytes, before);
  }
  assert.equal(inspectDerivedInlineImage("image/jpeg", Buffer.from(png, "base64"), "png-and-baseline-jpeg-v1").code, "DERIVED_JPEG_SIGNATURE_INVALID");
});

test("hybrid v3 accepts only exactly recorded legacy settings omissions without author inference", () => {
  for (const version of ["0.148.0-alpha.15", "0.149.0-alpha.4.3"]) {
    const native = richImageNative({ version, settings: {}, images: [] });
    const encoded = encodeRichImageNative(native);
    try { assert.equal(encoded.publicationReady, true);
      assert.ok(encoded.diagnostics.some(row => row.code === "HYBRID_LEGACY_SETTINGS_THREAD_ID_NOT_RECORDED" && row.threadIdentityInferred === false));
    } finally { releaseHistoryBytes(encoded.raw); }
    for (const converter of ["codex-claude-physical-hybrid-v1", CODEX_HYBRID_TEXT_CONVERTER])
      assert.throws(() => encodeRichImageNative(native, converter), { code: "PHYSICAL_ITEM_NATIVE_IDENTITY_MISMATCH" });
    for (const id of [null, "malformed", branchThread]) assert.throws(() => encodeRichImageNative(richImageNative({ version,
      settings: { thread_id: id }, images: [] })), { code: "PHYSICAL_ITEM_NATIVE_IDENTITY_MISMATCH" });
  }
  assert.throws(() => encodeRichImageNative(richImageNative({ settings: {}, images: [] })), { code: "PHYSICAL_ITEM_NATIVE_IDENTITY_MISMATCH" });
  const unknown = encodeRichImageNative(richImageNative({ version: "0.148.0-alpha.15", settings: { thread_settings: { unknown_policy: "not authority" } }, images: [] }));
  try { assert.equal(unknown.publicationReady, false); assert.ok(unknown.diagnostics.some(row => row.code === "HYBRID_PROVIDER_SETTINGS_FIELDS_UNQUALIFIED")); }
  finally { releaseHistoryBytes(unknown.raw); }
  assert.throws(() => encodeRichImageNative(richImageNative({ images: [], modify: frames => { frames[4].payload.thread_id = branchThread; } })), { code: "AUTHORED_SOURCE_IDENTITY_UNQUALIFIED" });
});

test("hybrid v3 proves canonical image references against exact unique wire bytes without file access", () => {
  const jpeg = "data:image/jpeg;base64," + tinyBaselineJpeg().toString("base64"), urls = ["data:image/png;base64," + png, jpeg];
  const native = richImageNative({ images: urls }), before = historyHash(native.originals[0].raw), encoded = encodeRichImageNative(native);
  try {
    assert.equal(encoded.publicationReady, true, JSON.stringify(encoded.diagnostics.filter(row => row.blocksPublication)));
    const user = encoded.rows.find(row => row.type === "user"); assert.equal(user.type, "user");
    assert.deepEqual(user.message.content.map(part => part.type), ["text", "text", "image", "text", "image"]);
    assert.deepEqual(user.message.content.filter(part => part.type === "image").map(part => "data:" + part.source.media_type + ";base64," + part.source.data), urls);
    assert.equal(encoded.hybridCoverage.authored.completeAuthoredMessageCoverage, true);
    assert.equal(encoded.hybridCoverage.authored.allSourceContentPartsAreText, false);
    assert.equal(encoded.hybridCoverage.authored.sourceImageParts, 2);
    assert.equal(encoded.hybridCoverage.authored.imageByteTransportVerified, true);
    assert.ok(encoded.hybridCoverage.authored.imageSourceAssociations.every(link => link.unique));
    assert.equal(historyHash(native.originals[0].raw), before);
  } finally { releaseHistoryBytes(encoded.raw); }
  const old = encodeRichImageNative(native, CODEX_HYBRID_TEXT_CONVERTER);
  try { assert.equal(old.publicationReady, false); } finally { releaseHistoryBytes(old.raw); }
  const failures = [frames => { frames[3].payload.content[1].text += "mismatch"; },
    frames => { frames[3].payload.content[3].text = "wrong closing wrapper"; },
    frames => { frames[3].payload.content[2].detail = "low"; },
    frames => { frames[3].payload.internal_chat_message_metadata_passthrough.content_item_kinds[2] = "harness"; },
    frames => { frames[3].payload.internal_chat_message_metadata_passthrough.turn_id = "different-turn"; },
    frames => { frames[4].payload.item.content[0].text_elements = [{ unsupported: true }]; },
    frames => { frames[3].payload.content[2].image_url = "data:image/png;base64," + tinyBaselineJpeg().toString("base64"); },
    frames => { frames.splice(3, 0, structuredClone(frames[3])); }];
  for (const modify of failures) {
    const source = richImageNative({ modify }), digest = historyHash(source.originals[0].raw), bad = encodeRichImageNative(source);
    try { assert.equal(bad.publicationReady, false); assert.equal(historyHash(source.originals[0].raw), digest); }
    finally { releaseHistoryBytes(bad.raw); }
  }
  const distinct = encodeRichImageNative(richImageNative({ modify: frames => {
    const wire = structuredClone(frames[3]), user = structuredClone(frames[4]);
    wire.payload.id += "-distinct"; user.payload.item.id += "-distinct";
    wire.payload.content[0].text = user.payload.item.content[0].text = "Distinct same-turn authored message";
    frames.splice(5, 0, wire, user);
  } }));
  try { assert.equal(distinct.publicationReady, true); assert.equal(distinct.hybridCoverage.authored.sourceImageParts, 2); }
  finally { releaseHistoryBytes(distinct.raw); }
});


test("same-process preparation returns the final inspected artifact while public derive stays bounded", async t => {
  const f = await derivedFixture(t), args = { bundleRoot: f.bundleRoot, root: f.f.root, threadIds: [sourceThread] };
  const artifact = prepareProjectNativeHistory(args), result = deriveProjectNativeHistory(args);
  assert.deepEqual(projectNativeDerivationSummary(artifact), result);
  assert.ok(!("raw" in result) && !("rows" in result) && !("check" in result) && !("recheck" in result));
  artifact.check(); artifact.recheck();
  const file = path.join(artifact.directory, "conversation.jsonl"); fs.appendFileSync(file, " ");
  assert.throws(() => artifact.recheck(), { code: "DERIVED_ARTIFACT_TAMPER" });
});

test("prepared artifact never waives current source, target, authority or cancellation checks", async t => {
  for (const mode of ["source", "target", "authority", "cancel"]) {
    const f = await derivedFixture(t); let allowed = true; const abort = new AbortController();
    const artifact = prepareProjectNativeHistory({ bundleRoot: f.bundleRoot, root: f.f.root, threadIds: [sourceThread],
      signal: abort.signal, assertCurrentAuthority: () => allowed });
    const nativeHome = home(f);
    if (mode === "source") {
      const entry = artifact.selected.native.payload.files[0]; fs.writeFileSync(path.join(artifact.selected.native.directory, "objects", entry.sha256 + ".bin"), "changed source");
      assert.throws(() => artifact.recheck());
    } else if (mode === "target") {
      fs.renameSync(f.f.root, f.f.root + ".prior"); fs.mkdirSync(f.f.root);
      await assert.rejects(publishClaudeDerived({ artifact, nativeHome, root: f.f.root, host: host(artifact) }), { code: "DERIVED_TARGET_PROJECT_ROOT_CHANGED" });
    } else if (mode === "authority") {
      allowed = false; assert.throws(() => artifact.check(), { code: "NATIVE_HISTORY_AUTHORITY_DENIED" });
    } else {
      abort.abort(); assert.throws(() => artifact.check(), { code: "NATIVE_HISTORY_OPERATION_CANCELLED" });
    }
    assert.deepEqual(fs.readdirSync(nativeHome), []);
  }
});

function legacyHybridNative({ version = "0.149.0-alpha.4.3", modify = () => {} } = {}) {
  const frames = [
    { type: "session_meta", payload: { id: sourceThread, session_id: sourceThread, cli_version: version, history_mode: "paginated", history_base: null } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "legacy-turn" } },
    { type: "event_msg", payload: { type: "item_completed", thread_id: sourceThread, turn_id: "legacy-turn",
      item: { type: "UserMessage", id: "canonical-user", content: [{ type: "text", text: "Synthetic original user input" }] } } },
    { type: "event_msg", payload: { type: "item_completed", thread_id: sourceThread, turn_id: "legacy-turn",
      item: { type: "AgentMessage", id: "canonical-assistant", phase: "final_answer", content: [{ type: "Text", text: "Synthetic canonical response" }] } } },
    { type: "response_item", payload: { type: "message", id: "distinct-wire-assistant", role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text: "Synthetic canonical response" }], internal_chat_message_metadata_passthrough: { turn_id: "legacy-turn" } } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "legacy-turn" } },
  ];
  modify(frames);
  const raw = Buffer.from(frames.map((frame, ordinal) => JSON.stringify({ ordinal, ...frame }) + "\n").join(""));
  const originals = [{ rolloutId: sourceThread, threadId: sourceThread, raw, sha256: historyHash(raw) }];
  return { payload: { threadIds: [sourceThread], selectedRolloutId: sourceThread }, originals,
    proof: resolveCodexPhysicalLineage({ originals, rolloutId: sourceThread }) };
}
function encodeLegacyHybridNative(native, converter = CODEX_HYBRID_CONVERTER) {
  const read = readCodexHybridPhysical({ native, threadId: sourceThread, converter });
  return { read, encoded: encodeCodexHybrid({ read, targetId: "01900000-0000-7000-8000-000000000073",
    cwd: "C:/synthetic", createdAt: "2026-11-07T00:00:00.000Z" }) };
}

test("hybrid v4 binds only adjacent unique legacy assistant projections without changing original IDs or v3", () => {
  for (const version of ["0.148.0-alpha.15", "0.149.0-alpha.4.3"]) {
    const native = legacyHybridNative({ version }), digest = historyHash(native.originals[0].raw);
    const { read, encoded } = encodeLegacyHybridNative(native), prior = encodeLegacyHybridNative(native, CODEX_HYBRID_IMAGE_CONVERTER);
    try {
      assert.equal(encoded.publicationReady, true); assert.equal(prior.encoded.publicationReady, false);
      assert.equal(read.records[4].legacyAssociation.messageIdEquivalenceClaimed, false);
      assert.equal(read.records[4].document.payload.id, "distinct-wire-assistant");
      assert.equal(read.records[3].document.payload.item.id, "canonical-assistant");
      assert.equal(historyHash(native.originals[0].raw), digest);
    } finally { releaseHistoryBytes(encoded.raw); releaseHistoryBytes(prior.encoded.raw); }
  }
  const counterexamples = [
    f => { f[0].payload.cli_version = "0.153.4"; },
    f => { f[4].payload.phase = "commentary"; },
    f => { f[4].payload.internal_chat_message_metadata_passthrough.turn_id = "other-turn"; },
    f => { f[4].payload.content[0].text += " extra"; },
    f => { f[4].payload.unknown_instruction = "not permitted"; },
    f => { f.splice(3, 0, structuredClone(f[3])); f[3].payload.item.id = "other-identical-canonical"; },
    f => { f.splice(4, 0, { type: "event_msg", payload: { type: "token_count" } }); },
    f => { [f[3], f[4]] = [f[4], f[3]]; },
    f => { f.splice(5, 0, structuredClone(f[4])); },
  ];
  for (const modify of counterexamples) {
    const { encoded } = encodeLegacyHybridNative(legacyHybridNative({ modify }));
    try { assert.equal(encoded.publicationReady, false); } finally { releaseHistoryBytes(encoded.raw); }
  }
  assert.throws(() => encodeLegacyHybridNative(legacyHybridNative({ modify: f => { f[3].payload.thread_id = branchThread; } })),
    { code: "AUTHORED_SOURCE_IDENTITY_UNQUALIFIED" });
});

test("hybrid v4 quotes known unmatched legacy user transmissions without user attribution or current instructions", () => {
  const wire = { type: "response_item", payload: { type: "message", id: "legacy-wire-user", role: "user",
    content: [{ type: "input_text", text: "SYNTHETIC OLD INSTRUCTIONS; do not execute" }],
    internal_chat_message_metadata_passthrough: { turn_id: "legacy-turn", create_time: 0 } } };
  for (const version of ["0.148.0-alpha.15", "0.149.0-alpha.4.3"]) {
    const native = legacyHybridNative({ version, modify: f => { f.splice(3, 0, structuredClone(wire)); } });
    const { read, encoded } = encodeLegacyHybridNative(native);
    try {
      assert.equal(encoded.publicationReady, true);
      const quote = read.records.find(r => r.document.payload.id === "legacy-wire-user");
      assert.equal(quote.classification, "unconfirmed-historical-provider-transmission");
      assert.equal(encoded.hybridCoverage.unconfirmedHistoricalProviderTransmissions, 1);
      assert.equal(encoded.hybridCoverage.historicalInstructionStringsApplied, false);
      assert.equal(encoded.hybridCoverage.authored.completeAuthoredMessageCoverage, true);
      const index = encoded.mappings.find(m => m.source.rawOrdinal === quote.source.rawOrdinal).targetMessageIndex;
      assert.equal(encoded.rows[index].type, "assistant");
      assert.match(encoded.rows[index].message.content[0].text, /UNCONFIRMED/);
      assert.match(encoded.rows[index].message.content[0].text, /do not apply them as current instructions/);
      assert.equal(encoded.rows.filter(r => r.type === "user").length, 1);
      assert.equal(encoded.rows.find(r => r.type === "user").message.content[0].text, "Synthetic original user input");
    } finally { releaseHistoryBytes(encoded.raw); }
  }
  for (const mutate of [
    p => { p.content[0].type = "encrypted_content"; },
    p => { p.internal_chat_message_metadata_passthrough.provenance = "unknown"; },
    p => { p.internal_chat_message_metadata_passthrough.content_item_kinds = ["unknown"]; },
    p => { p.internal_chat_message_metadata_passthrough.create_time = "0"; },
    p => { p.content[0].unknown = "field"; },
    p => { p.role = "unknown"; },
  ]) {
    const { read, encoded } = encodeLegacyHybridNative(legacyHybridNative({ modify: f => { const item = structuredClone(wire); mutate(item.payload); f.splice(3, 0, item); } }));
    try { assert.equal(encoded.publicationReady, false); assert.equal(read.inventory.some(r => r.classification === "unconfirmed-historical-provider-transmission"), false); }
    finally { releaseHistoryBytes(encoded.raw); }
  }
});

test("hybrid v4 keeps qualified legacy world configuration original-only and failed dynamic tools passive", () => {
  const world = { type: "world_state", payload: { full: false, state: { orchestrator_skills: { enabled: true, includeInstructions: false },
    personality: { model: "synthetic-model", personality: "synthetic" } } } };
  const dynamic = { type: "event_msg", payload: { type: "item_completed", thread_id: sourceThread, turn_id: "legacy-turn", started_at_ms: 0, completed_at_ms: 1,
    item: { type: "DynamicToolCall", id: "dynamic-id", namespace: "synthetic", tool: "synthetic_failure", arguments: { query: "synthetic" },
      status: "failed", success: false, duration: { secs: 0, nanos: 1 }, content_items: [{ type: "inputText", text: "Synthetic historical failure" }] } } };
  for (const version of ["0.148.0-alpha.15", "0.149.0-alpha.4.3", "0.153.4"]) {
    for (const state of [world.payload.state, { orchestrator_skills: null, personality: null }, { personality: { model: "synthetic" } }]) {
      const { read, encoded } = encodeLegacyHybridNative(legacyHybridNative({ version, modify: f => { f.splice(4, 1, { ...world, payload: { full: false, state } }); } }));
      try { assert.equal(encoded.publicationReady, true); assert.equal(read.inventory[4].representation, "provider-envelope-original-only");
        assert.equal(encoded.rows.some(r => JSON.stringify(r).includes("orchestrator_skills")), false); }
      finally { releaseHistoryBytes(encoded.raw); }
    }
  }
  for (const version of ["0.148.0-alpha.15", "0.163.0-alpha.10.2"]) {
    const { encoded } = encodeLegacyHybridNative(legacyHybridNative({ version, modify: f => { f.splice(4, 1, structuredClone(dynamic)); } }));
    try { assert.equal(encoded.publicationReady, true); assert.equal(encoded.hybridCoverage.nativeToolRecords, 0);
      assert.ok(encoded.rows.some(r => r.type === "assistant" && r.message.content.some(b => b.type === "text" && b.text.includes('"status":"failed"'))));
      assert.ok(encoded.rows.every(r => r.message.content.every(b => !["tool_use", "tool_result"].includes(b.type)))); }
    finally { releaseHistoryBytes(encoded.raw); }
  }
  for (const bad of [
    { ...world, payload: { full: false, state: { personality: { model: "s", extra: true } } } },
    { ...world, payload: { full: false, state: { orchestrator_skills: { enabled: true } } } },
    { ...dynamic, payload: { ...dynamic.payload, item: { ...dynamic.payload.item, unknown: true } } },
    { ...dynamic, payload: { ...dynamic.payload, item: { ...dynamic.payload.item, content_items: [{ type: "encrypted_content", text: "never imported" }] } } },
  ]) {
    const { encoded } = encodeLegacyHybridNative(legacyHybridNative({ version: "0.148.0-alpha.15", modify: f => { f.splice(4, 1, bad); } }));
    try { assert.equal(encoded.publicationReady, false); } finally { releaseHistoryBytes(encoded.raw); }
  }
});

test("hybrid v4 quotes the recorded unmatched legacy assistant transmission without importing adjacent reasoning", () => {
  const modify = f => {
    f[4].payload.content[0].text = "SYNTHETIC unmatched historical transmission";
    f[4].payload.internal_chat_message_metadata_passthrough.content_item_kinds = ["unknown"];
    f.splice(4, 0, { type: "response_item", payload: { type: "reasoning", encrypted_content: "PRIVATE_REASONING_NOT_IMPORTED" } });
  };
  const { read, encoded } = encodeLegacyHybridNative(legacyHybridNative({ version: "0.148.0-alpha.15", modify }));
  try {
    assert.equal(encoded.publicationReady, true);
    const entry = read.inventory.find(r => r.classification === "unconfirmed-historical-provider-transmission");
    assert.equal(entry.recordedProviderRole, "assistant"); assert.equal(entry.reconstructedAssistantMessage, false);
    assert.equal(entry.relationshipToCanonicalAuthoredMessage, "unconfirmed");
    assert.equal(encoded.hybridCoverage.unconfirmedHistoricalProviderTransmissions, 1);
    assert.ok(encoded.rows.some(r => r.message.content.some(b => b.text?.includes("UNCONFIRMED"))));
    assert.ok(!encoded.raw.includes(Buffer.from("PRIVATE_REASONING_NOT_IMPORTED")));
    assert.equal(read.inventory.find(r => r.itemType === "reasoning").classification, "private-original-only");
  } finally { releaseHistoryBytes(encoded.raw); }
  for (const mutate of [
    f => { f[0].payload.cli_version = "0.149.0-alpha.4.3"; },
    f => { f[5].payload.phase = "commentary"; },
    f => { f[5].payload.internal_chat_message_metadata_passthrough.content_item_kinds = ["private"]; },
    f => { f[5].payload.internal_chat_message_metadata_passthrough.provenance = "unknown"; },
    f => { f[5].payload.content[0].type = "encrypted_content"; },
    f => { f.splice(4, 1, { type: "event_msg", payload: { type: "token_count" } }); },
  ]) {
    const result = encodeLegacyHybridNative(legacyHybridNative({ version: "0.148.0-alpha.15", modify: f => { modify(f); mutate(f); } }));
    try { assert.equal(result.encoded.publicationReady, false);
      assert.equal(result.read.inventory.some(r => r.classification === "unconfirmed-historical-provider-transmission"), false); }
    finally { releaseHistoryBytes(result.encoded.raw); }
  }
});
