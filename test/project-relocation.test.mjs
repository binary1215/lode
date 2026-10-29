import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { explorerFixture } from "./helpers/graph-explorer-fixture.mjs";
import { snapshot, pluginRoot } from "./helpers/session-work-linkage-fixture.mjs";
import { initializeOrResumeProject } from "../scripts/lib/project-bootstrap.mjs";
import { inspectProject } from "../scripts/lib/lode-core.mjs";
import { resolveProjectStorage, projectOwnsRecordedRoot } from "../scripts/lib/project-storage-format.mjs";
import { resumeProjectLocation } from "../scripts/lib/project-relocation.mjs";
import { createSessionCallContext, withSessionRoute } from "../scripts/lib/session-routing.mjs";
import { readSessionWorkContext } from "../scripts/lib/session-work-context.mjs";
import { queryProjectGraph } from "../scripts/lib/project-graph.mjs";
import { inspectWorldDomainFreshness, readWorldModelSnapshot, queryWorldTemporalGraph } from "../scripts/lib/world-model.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { createRecoveryCheckpoint } from "../scripts/lib/compaction-recovery.mjs";
import { restoreSessionFromArtifacts } from "../scripts/lib/session-recovery.mjs";
import { createSessionHostAdapter } from "../scripts/lib/session-host-adapter.mjs";
import { createNativeSessionHostBridge } from "../scripts/lib/session-native-host.mjs";

function copy(f, name = "relocated") {
  const root = path.join(f.base, name); fs.cpSync(f.root, root, { recursive: true }); return fs.realpathSync(root);
}
const bytes = (root, relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("explicit public resume preserves Project/default/named Session and Work/World originals at the new folder", async t => {
  const f = await explorerFixture(t), original = inspectProject(f.root), root = copy(f);
  const history = snapshot(f.root), beforeNamed = bytes(root, `.lode/sessions/by-id/${f.session.sessionId}/current.json`);
  fs.writeFileSync(path.join(f.root, "src/relay.mjs"), "throw Error('OLD ROOT MUST NOT BE READ');\n");
  const response = await runCommand(["resume", root, "--session", f.session.sessionId]);
  assert.equal(response.projectLocation.status, "relocated");
  assert.equal(response.project.sessionId, f.session.sessionId);
  const current = inspectProject(root);
  assert.equal(current.project.projectId, original.project.projectId); assert.equal(current.state.sessionId, original.state.sessionId);
  assert.equal(current.project.projectRoot, root);
  assert.equal(bytes(root, `.lode/sessions/by-id/${f.session.sessionId}/current.json`), beforeNamed);
  for (const [relative, value] of Object.entries(history)) {
    if (!relative.includes("world-model/snapshots") && !relative.includes("session-work") && !relative.includes("sessions/records") && !relative.endsWith("sessions/current.json")) continue;
    assert.equal(snapshot(root)[relative].digest, value.digest, relative);
  }
  const stored = (await inspectWorldDomainFreshness({ root, domains: ["code"] }));
  assert.equal(stored.freshness.domains.code.status, "current"); assert.equal(stored.snapshot.projectRoot, f.root);
  assert.equal((await readWorldModelSnapshot({ root, worldModelId: stored.snapshot.worldModelId })).snapshot.projectRoot, f.root);
  const work = withSessionRoute(root, f.session.sessionId, () => readSessionWorkContext({ root }));
  assert(work.records.length > 0);
  const graph = await queryProjectGraph({ root, query: "relay", details: true });
  assert(graph.nodes.length > 0); assert.equal(graph.basis.projectId, original.project.projectId);
  const temporal = (await queryWorldTemporalGraph({ root, query: "relay", maxNodes: 30, maxEdges: 50 }));
  assert(temporal);
  const capsule = (await compileContext({ root, task: "Inspect relay", persist: false })); assert(capsule.capsule);
  const owner = resolveProjectStorage(root); assert(projectOwnsRecordedRoot(owner, f.root)); assert(!projectOwnsRecordedRoot(owner, "C:\\unrelated"));
  assert.equal(response.projectLocation.executionReplayAllowed, false);
  assert.equal(response.projectLocation.nativeBindingTransferred, false);
});

test("typed MCP resume validates and selects the exact named Session after relocation without writing its state", async t => {
  const f = await explorerFixture(t), root = copy(f), stateFile = `.lode/sessions/by-id/${f.session.sessionId}/current.json`, before = bytes(root, stateFile);
  const context = createSessionCallContext();
  const result = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lode_project_initialize_or_resume", arguments: { project_root: root, session_id: f.session.sessionId } } }, { sessionContext: context });
  assert(!result.error, JSON.stringify(result)); assert(!result.result?.isError, JSON.stringify(result));
  assert.equal(context.read(root).sessionId, f.session.sessionId);
  assert.equal(bytes(root, stateFile), before); assert.equal(inspectProject(root).project.projectId, f.projectId);
});

test("successive folder moves preserve the full location chain, user-owned config and original Session bytes", async t => {
  const f = await explorerFixture(t), first = copy(f, "first"), second = path.join(f.base, "second");
  await initializeOrResumeProject({ root: first, pluginRoot });
  // User-owned ordinary files are not rewritten by relocation or resume.
  fs.writeFileSync(path.join(first, "preferences.json"), '{"keep":"exact"}\n');
  fs.cpSync(first, second, { recursive: true });
  const session = bytes(second, ".lode/sessions/current.json");
  await initializeOrResumeProject({ root: second, pluginRoot });
  const storage = resolveProjectStorage(second);
  assert(projectOwnsRecordedRoot(storage, first)); assert(projectOwnsRecordedRoot(storage, f.root));
  assert.equal(inspectProject(second).project.projectId, f.projectId);
  assert.equal(bytes(second, ".lode/sessions/current.json"), session);
  assert.equal(bytes(second, "preferences.json"), '{"keep":"exact"}\n');
  assert.equal((await inspectWorldDomainFreshness({ root: second, domains: ["code"] })).freshness.domains.code.status, "stale");
  // A new real source file causes honest drift; it is not hidden by ownership aliasing.
});

test("relocation restores the same checkpoint direction without rewriting history or replaying execution", async t => {
  const f = await explorerFixture(t);
  const checkpoint = withSessionRoute(f.root, f.session.sessionId, () => createRecoveryCheckpoint({ root: f.root,
    purpose: "Keep the agreed synthetic task", currentPosition: "Inspect relay", nextExpectedResult: "Return local evidence only", approvedDecisions: ["No deployment"] })).checkpoint;
  const root = copy(f), stateFile = `.lode/sessions/by-id/${f.session.sessionId}/current.json`;
  const beforeState = bytes(root, stateFile), beforeFiles = snapshot(root);
  await initializeOrResumeProject({ root, pluginRoot, projectSessionRoute: { sessionId: f.session.sessionId } });
  const beforeRestore = snapshot(root);
  const restored = withSessionRoute(root, f.session.sessionId, () => restoreSessionFromArtifacts({ root }));
  assert.equal(restored.projection.checkpoint.checkpointId, checkpoint.checkpointId);
  assert.equal(restored.projection.consumerInstruction.historicalCheckpointContext.nextExpectedResult, "Return local evidence only");
  assert.equal(restored.projection.consumerInstruction.nextExpectedResult, undefined);
  assert.equal(restored.projection.consumerInstruction.historicalApprovalGrantsCurrentEffect, false);
  assert.equal(bytes(root, stateFile), beforeState); assert.deepEqual(snapshot(root), beforeRestore);
  for (const [relative, original] of Object.entries(beforeFiles)) if (relative.includes("/ledger/")) assert.equal(snapshot(root)[relative].digest, original.digest);
});

test("the same synthetic native caller cannot inherit the old folder's operational Session binding", async t => {
  const f = await explorerFixture(t), environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: f.operational };
  const host = createSessionHostAdapter({ runtime: "codex", nativeSessionId: "synthetic-local-caller", environment });
  assert.equal(host.select({ root: f.root, sessionId: f.session.sessionId, expectedRevision: 0 }).status, "host_selection_retained");
  const root = copy(f); await initializeOrResumeProject({ root, pluginRoot });
  const before = snapshot(f.base);
  assert.equal(host.read({ root }).status, "absent"); assert.equal(host.read({ root: f.root }).sessionId, f.session.sessionId);
  assert.deepEqual(snapshot(f.base), before);
});

test("native MCP resume reaches a relocated or interrupted Project before optional Host binding lookup", async t => {
  const f = await explorerFixture(t), environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: f.operational };
  for (const stage of [null, "project", "manifest"]) {
    const root = copy(f, `native-${stage ?? "fresh"}`);
    if (stage) assert.throws(() => resumeProjectLocation({ root, pluginRoot, onPublication(boundary) { if (boundary === stage) throw Error("interruption"); } }));
    const bridge = createNativeSessionHostBridge({ runtime: "codex", environment });
    const result = await dispatch({ jsonrpc: "2.0", id: "synthetic-local-resume", method: "tools/call", params: {
      _meta: { threadId: "synthetic-native-resume" }, name: "lode_project_initialize_or_resume", arguments: { project_root: root } } }, { nativeSessionBridge: bridge });
    assert(!result.error, JSON.stringify(result)); assert(!result.result?.isError, JSON.stringify(result));
    assert.equal(result.result.structuredContent.project.projectId, f.projectId);
    assert.equal(result.result.structuredContent.project.sessionId, f.owner.state.sessionId);
    assert.equal(inspectProject(root).status, "ready");
  }
});

test("a deferred optional Host failure exposes the applied location but never guesses a Session or claims resume completion", async t => {
  const f = await explorerFixture(t), root = copy(f), beforeNamed = bytes(root, `.lode/sessions/by-id/${f.session.sessionId}/current.json`);
  const result = await dispatch({ id: "synthetic-host-failure", method: "tools/call", params: { name: "lode_project_initialize_or_resume", arguments: { project_root: root } } }, {
    resolveSessionContext() { throw Object.assign(Error("Synthetic caller unavailable"), { code: "NATIVE_SESSION_CALLER_UNAVAILABLE" }); } });
  assert(!result.error, JSON.stringify(result));
  const value = result.result.structuredContent;
  assert.equal(value.status, "session_selection_unresolved"); assert.equal(value.sessionId, null); assert.equal(value.projectAction, undefined);
  assert.equal(value.projectLocation.status, "relocated"); assert.match(value.presentation.summary, /location recovery was applied/);
  assert.equal(value.reasonCode, "NATIVE_SESSION_CALLER_UNAVAILABLE"); assert.equal(value.executionReplayAllowed, false);
  assert.equal(bytes(root, `.lode/sessions/by-id/${f.session.sessionId}/current.json`), beforeNamed);
  assert.equal(inspectProject(root).project.projectId, f.projectId);
});

test("explicit named MCP success retains identical unavailable-Host diagnostics at normal and relocated roots", async t => {
  const f = await explorerFixture(t), moved = copy(f), results = [];
  for (const root of [f.root, moved]) {
    const response = await dispatch({ id: "synthetic-explicit-host-failure", method: "tools/call", params: { name: "lode_project_initialize_or_resume",
      arguments: { project_root: root, session_id: f.session.sessionId } } }, {
      resolveSessionContext() { throw Object.assign(Error("Synthetic missing caller"), { code: "NATIVE_SESSION_CALLER_UNAVAILABLE" }); } });
    assert(!response.error, JSON.stringify(response)); assert(!response.result.isError);
    assert.equal(response.result.structuredContent.project.sessionId, f.session.sessionId);
    results.push(response.result._meta.headSessionBinding);
  }
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[1], { status: "unavailable", reasonCode: "NATIVE_SESSION_CALLER_UNAVAILABLE",
    scope: "current-explicit-request-only", retainedForSubsequentCalls: false, persisted: false });
});

test("invalid profile/runtime/package/Session or lost binding refuses before location publication", async t => {
  const f = await explorerFixture(t);
  for (const [name, options] of [
    ["profile", { profile: "invalid" }], ["runtime", { runtimes: ["unknown"] }],
    ["package", { pluginRoot: path.join(f.base, "missing-plugin") }],
    ["session", { projectSessionRoute: { sessionId: "session-00000000-0000-0000-0000-000000000000" } }],
  ]) {
    const root = copy(f, name), before = snapshot(root);
    await assert.rejects(((initializeOrResumeProject({ root, pluginRoot, ...options }))));
    assert.deepEqual(snapshot(root), before, name);
  }
  const root = copy(f, "lost"), context = createSessionCallContext(); context.lose(root);
  const before = snapshot(root);
  await assert.rejects(((initializeOrResumeProject({ root, pluginRoot, projectSessionRoute: { context } }))), { code: "HEAD_SESSION_SELECTION_LOST" });
  assert.deepEqual(snapshot(root), before);
});

test("interrupted two-file publication fails closed for readers and exact retry rolls forward; divergent retry cannot overwrite", async t => {
  const f = await explorerFixture(t), root = copy(f);
  assert.throws(() => resumeProjectLocation({ root, pluginRoot, onPublication(stage) { if (stage === "project") throw Error("synthetic crash"); } }), /synthetic crash/);
  assert.throws(() => inspectProject(root), { code: "PROJECT_RELOCATION_PENDING" });
  const resumed = await initializeOrResumeProject({ root, pluginRoot });
  assert.equal(resumed.projectLocation.status, "relocated"); assert.equal(inspectProject(root).status, "ready");
  assert.equal(fs.existsSync(path.join(root, ".lode/project-location/pending.json")), false);
  const again = await initializeOrResumeProject({ root, pluginRoot }); assert(!again.projectLocation);
  const divergent = copy(f, "divergent");
  assert.throws(() => resumeProjectLocation({ root: divergent, pluginRoot, onPublication() { throw Error("synthetic crash"); } }));
  fs.appendFileSync(path.join(divergent, ".lode/generated/manifest.json"), " ");
  const before = snapshot(divergent);
  await assert.rejects(((initializeOrResumeProject({ root: divergent, pluginRoot }))), { code: "PROJECT_RELOCATION_CONFLICT" });
  assert.deepEqual(snapshot(divergent), before);
});

test("both publication-stage interruptions recover through an exact existing named Session; invalid retries remain write-free", async t => {
  const f = await explorerFixture(t);
  for (const stage of ["project", "manifest"]) {
    const root = copy(f, `interrupted-${stage}`);
    assert.throws(() => resumeProjectLocation({ root, pluginRoot, onPublication(boundary) { if (boundary === stage) throw Error("synthetic interruption"); } }), /synthetic interruption/);
    const before = snapshot(root);
    await assert.rejects(((initializeOrResumeProject({ root, pluginRoot,
      projectSessionRoute: { sessionId: "session-00000000-0000-0000-0000-000000000000" } }))), { code: "HEAD_SESSION_NOT_FOUND" });
    assert.deepEqual(snapshot(root), before);
    const context = createSessionCallContext(); context.lose(root);
    await assert.rejects(((initializeOrResumeProject({ root, pluginRoot, projectSessionRoute: { context } }))), { code: "HEAD_SESSION_SELECTION_LOST" });
    assert.deepEqual(snapshot(root), before);
    const resumed = await runCommand(["resume", root, "--session", f.session.sessionId]);
    assert.equal(resumed.projectLocation.status, "relocated"); assert.equal(resumed.project.sessionId, f.session.sessionId);
    assert.equal(inspectProject(root).project.projectId, f.projectId);
    assert.equal(fs.existsSync(path.join(root, ".lode/project-location/pending.json")), false);
  }
});

test("history tamper, local owner conflicts and managed drift cannot acquire a new location or reuse a cached graph", async t => {
  const f = await explorerFixture(t), root = copy(f);
  await initializeOrResumeProject({ root, pluginRoot });
  await queryProjectGraph({ root, details: true });
  const project = inspectProject(root).project;
  fs.appendFileSync(path.join(root, `.lode/project-location/history/${project.location.previousProjectDigest}.json`), " ");
  assert.throws(() => inspectProject(root), { code: "PROJECT_LOCATION_IDENTITY_MISMATCH" });
  const unavailable = await queryProjectGraph({ root }); assert.equal(unavailable.status, "source-fallback"); assert.equal(unavailable.nodes.length, 0);
  const conflict = copy(f, "conflict"); fs.mkdirSync(path.join(conflict, ".head")); fs.copyFileSync(path.join(conflict, ".lode/project.json"), path.join(conflict, ".head/project.json"));
  await assert.rejects(((initializeOrResumeProject({ root: conflict, pluginRoot }))), { code: "PROJECT_STORAGE_CONFLICT" });
  const drift = copy(f, "drift"); fs.appendFileSync(path.join(drift, "AGENTS.md"), "\nuser change\n");
  const before = snapshot(drift);
  await assert.rejects(((initializeOrResumeProject({ root: drift, pluginRoot }))), { code: "PROJECT_NOT_READY" }); assert.deepEqual(snapshot(drift), before);
});
