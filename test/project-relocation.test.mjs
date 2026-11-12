import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";
import { explorerFixture } from "./helpers/graph-explorer-fixture.mjs";
import { snapshot, pluginRoot } from "./helpers/session-work-linkage-fixture.mjs";
import { initializeOrResumeProject } from "../scripts/lib/session/project-bootstrap.mjs";
import { inspectProject } from "../scripts/lib/session/lode-core.mjs";
import { resolveProjectStorage, projectOwnsRecordedRoot, projectOwnsRecordedRecord } from "../scripts/lib/storage/project-storage-format.mjs";
import { adoptVerifiedProjectCopy } from "../scripts/lib/storage/project-copy-adoption.mjs";
import { resumeProjectLocation } from "../scripts/lib/storage/project-relocation.mjs";
import { inspectProjectCopyOrigin, verifyProjectLocation } from "../scripts/lib/storage/project-location-proof.mjs";
import { copiedProjectFile, inspectCopiedProjectFiles, verifyCopiedProjectFile } from "../scripts/lib/storage/project-copy-evidence.mjs";
import { inspectManagedByteRepairs, repairManagedProjectBytes } from "../scripts/lib/storage/project-record-byte-repair.mjs";
import { createSessionCallContext, withSessionRoute } from "../scripts/lib/session/session-routing.mjs";
import { readSessionWorkContext } from "../scripts/lib/session/session-work-context.mjs";
import { queryProjectGraph } from "../scripts/lib/world/project-graph.mjs";
import { inspectWorldDomainFreshness, readWorldModelSnapshot, queryWorldTemporalGraph } from "../scripts/lib/world/world-model.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { LocalJsonWorldModelStoreAdapter } from "../scripts/lib/world/world-model-store.mjs";
import { compileContext } from "../scripts/lib/session/context-compiler.mjs";
import { createRecoveryCheckpoint, readRecoveryCheckpoint } from "../scripts/lib/session/compaction-recovery.mjs";
import { restoreSessionFromArtifacts } from "../scripts/lib/session/session-recovery.mjs";
import { createSessionHostAdapter } from "../scripts/lib/session/session-host-adapter.mjs";
import { createNativeSessionHostBridge } from "../scripts/lib/session/session-native-host.mjs";

function copy(f, name = "relocated") {
  const root = path.join(f.base, name);
  fs.cpSync(f.root, root, { recursive: true });
  return fs.realpathSync(root);
}
const bytes = (root, relative) => fs.readFileSync(path.join(root, relative), "utf8");

async function newlineRelocationFixture(t) {
  const base = fs.mkdtempSync(path.join(pluginRoot, ".qa-newline-resume-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "original");
  fs.mkdirSync(root);
  await initializeOrResumeProject({ root, pluginRoot, runtimes: ["codex"] });
  const moved = copy({ base, root });
  const manifest = JSON.parse(bytes(moved, ".lode/generated/manifest.json"));
  const observed = new Map();
  for (const entry of manifest.managed) {
    const file = path.join(moved, entry.path);
    const before = fs.readFileSync(file, "utf8");
    const converted = Buffer.from(before.replace(/\r?\n/g, "\r\n"));
    fs.writeFileSync(file, converted);
    observed.set(entry.path, converted);
  }
  return { base, root, moved, observed };
}

test("public resume restores exact recorded newline bytes before strict relocation, preserving originals", async (t) => {
  const f = await newlineRelocationFixture(t);
  const before = snapshot(f.moved);
  assert.throws(() => resumeProjectLocation({ root: f.moved, pluginRoot, inspectOnly: true }), { code: "PROJECT_NOT_READY" });
  assert.deepEqual(snapshot(f.moved), before);
  const result = await initializeOrResumeProject({ root: f.moved, pluginRoot, instructionIntegration: "preserve" });
  assert.equal(result.projectLocation.status, "relocated");
  assert.equal(result.projectLocation.byteRepair.status, "original-bytes-restored");
  assert.equal(result.projectLocation.nativeBindingTransferred, false);
  assert.equal(result.projectLocation.executionReplayAllowed, false);
  for (const repair of result.projectLocation.byteRepair.applied) {
    assert.deepEqual(fs.readFileSync(path.join(f.moved, repair.backup)), f.observed.get(repair.path));
  }
  assert.equal(inspectProject(f.moved).status, "ready");
});

test("newline relocation refuses edited, missing and invalid owner inputs without repair", async (t) => {
  for (const kind of ["edited", "missing", "runtime", "session", "lost-binding", "package"])
    await t.test(kind, async (t) => {
      const f = await newlineRelocationFixture(t);
      const options = { root: f.moved, pluginRoot };
      const role = path.join(f.moved, ".lode/roles/developer.md");
      if (kind === "edited") fs.appendFileSync(role, "user edit\r\n");
      if (kind === "missing") fs.unlinkSync(role);
      if (kind === "runtime") options.runtimes = ["claude"];
      if (kind === "session") options.projectSessionRoute = { sessionId: "session-00000000-0000-0000-0000-000000000000" };
      if (kind === "lost-binding") {
        const context = createSessionCallContext();
        context.lose(f.moved);
        options.projectSessionRoute = { context };
      }
      if (kind === "package") {
        options.pluginRoot = path.join(f.base, "invalid-plugin");
        fs.mkdirSync(path.join(options.pluginRoot, ".codex-plugin"), { recursive: true });
        fs.writeFileSync(path.join(options.pluginRoot, "package.json"), '{"version":"synthetic"}');
        fs.writeFileSync(path.join(options.pluginRoot, ".codex-plugin/plugin.json"), '{"version":""}');
      }
      const before = snapshot(f.moved);
      await assert.rejects(initializeOrResumeProject(options));
      assert.deepEqual(snapshot(f.moved), before);
    });
});

test("copy origin inspection separates an unproved origin from damaged declared history without granting ownership", async (t) => {
  for (const directory of [".head", ".lode"])
    await t.test(directory, () => {
      const root = fs.mkdtempSync(path.join(pluginRoot, ".qa-copy-origin-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const prefix = directory === ".lode" ? "lode" : "head";
      const original = { schemaVersion: 1, projectId: `${prefix}-${"1".repeat(20)}`, projectRoot: "C:/historical/source", retained: "same" };
      const observation = inspectProjectCopyOrigin(root, directory, original);
      assert.equal(observation.status, "initial-origin-unverified");
      assert.equal(observation.grantsOwnership, false);
      assert.throws(() => verifyProjectLocation(root, directory, original), { code: "PROJECT_LOCATION_IDENTITY_MISMATCH" });
      const originalBytes = Buffer.from(JSON.stringify(original));
      const digest = crypto.createHash("sha256").update(originalBytes).digest("hex");
      const history = path.join(root, directory, "project-location/history", `${digest}.json`);
      fs.mkdirSync(path.dirname(history), { recursive: true });
      fs.writeFileSync(history, originalBytes);
      const successor = { ...original, projectRoot: "D:/copied/source", location: { identityRoot: original.projectRoot, previousProjectDigest: digest } };
      assert.equal(inspectProjectCopyOrigin(root, directory, successor).status, "initial-origin-unverified");
      fs.writeFileSync(history, Buffer.from(JSON.stringify({ ...original, retained: "tampered" })));
      assert.throws(() => inspectProjectCopyOrigin(root, directory, successor), { code: "PROJECT_LOCATION_IDENTITY_MISMATCH" });
      fs.writeFileSync(history, originalBytes);
      assert.throws(() => inspectProjectCopyOrigin(root, directory, { ...successor, location: { ...successor.location, identityRoot: "C:/forged/origin" } }), {
        code: "PROJECT_LOCATION_IDENTITY_MISMATCH",
      });
      fs.unlinkSync(history);
      assert.throws(() => inspectProjectCopyOrigin(root, directory, successor), { code: "ENOENT" });
      const verified = { ...original, projectId: `${prefix}-${crypto.createHash("sha256").update(original.projectRoot).digest("hex").slice(0, 20)}` };
      assert.equal(inspectProjectCopyOrigin(root, directory, verified).status, "origin-verified");
      assert.equal(verifyProjectLocation(root, directory, verified).identityRoot, original.projectRoot);
    });
});

test("typed Core plus Product mode gives an actionable correction before initialization or relocation", async (t) => {
  const root = fs.mkdtempSync(path.join(pluginRoot, ".qa-core-mode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const invoke = (project_root) =>
    dispatch({
      jsonrpc: "2.0",
      id: "synthetic-core-mode",
      method: "tools/call",
      params: {
        name: "lode_project_initialize_or_resume",
        arguments: { project_root, profile: "core", mode: "existing" },
      },
    });
  const fresh = await invoke(root);
  assert.equal(fresh.error.code, -32000);
  assert.match(fresh.error.message, /omit Product onboarding fields \(mode\)/);
  assert.deepEqual(fs.readdirSync(root), []);
  const f = await explorerFixture(t),
    relocated = copy(f, "mode-refusal"),
    before = snapshot(relocated);
  const moved = await invoke(relocated);
  assert.equal(moved.error.code, -32000);
  assert.match(moved.error.message, /omit Product onboarding fields \(mode\)/);
  assert.deepEqual(snapshot(relocated), before);
});

test("copied byte inventory excludes active owners but retains consumption evidence and refuses aliases or changed originals", (t) => {
  const root = fs.mkdtempSync(path.join(pluginRoot, ".qa-copy-inventory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, value) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  write(".lode/project.json", '{"raw":true}\r\n');
  write(".lode/runtime/execution-leases/authorization/consumption.json", "consumed");
  write(".lode/runtime/execution-leases/authorization/release.json", "released");
  write(".lode/runtime/execution-leases/authorization/owner.lock/token", "source-owner");
  write(".lode/.operations/current/token", "source-lock");
  const inventory = inspectCopiedProjectFiles({ root, directory: ".lode" });
  assert.equal(inventory.grantsOwnership, false);
  assert.deepEqual(
    inventory.files.map((entry) => entry.path),
    [".lode/project.json", ".lode/runtime/execution-leases/authorization/consumption.json", ".lode/runtime/execution-leases/authorization/release.json"],
  );
  for (const entry of inventory.files) verifyCopiedProjectFile(root, entry);
  for (const relative of ["../escape", ".lode/project.json::$DATA", ".lode/../outside", ".lode\\project.json"]) {
    assert.throws(() => copiedProjectFile(root, relative), { code: "PROJECT_COPY_PATH_INVALID" });
  }
  const entry = inventory.files[0];
  assert.throws(() => verifyCopiedProjectFile(root, { ...entry, sha256: [entry.sha256] }), { code: "PROJECT_COPY_INVENTORY_INVALID" });
  fs.writeFileSync(path.join(root, entry.path), '{"raw":true}\n');
  assert.throws(() => verifyCopiedProjectFile(root, entry), { code: "PROJECT_COPY_SOURCE_CHANGED" });
  fs.linkSync(path.join(root, entry.path), path.join(root, ".lode/linked.json"));
  assert.throws(() => inspectCopiedProjectFiles({ root, directory: ".lode" }), { code: "PROJECT_COPY_UNSAFE_FILE" });
});

test("recorded-digest newline repair preserves observed bytes, BOM and later edits across an interrupted retry", (t) => {
  const root = fs.mkdtempSync(path.join(pluginRoot, ".qa-byte-repair-")),
    directory = ".lode";
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, directory, "generated"), { recursive: true });
  const firstPath = ".lode/generated/first.md",
    secondPath = ".lode/generated/second.md";
  const expected = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("original\nbytes\n")]);
  const observed = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("original\r\nbytes\r\n")]);
  const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
  for (const relative of [firstPath, secondPath]) fs.writeFileSync(path.join(root, relative), observed);
  const manifest = { schemaVersion: 1, managed: [firstPath, secondPath].map((path) => ({ path, sha256: sha(expected) })) };
  const before = fs.readFileSync(path.join(root, firstPath));
  const preview = inspectManagedByteRepairs({ root, directory, manifest });
  assert.equal(preview.repairs.length, 2);
  assert.deepEqual(fs.readFileSync(path.join(root, firstPath)), before);
  assert.throws(
    () =>
      repairManagedProjectBytes({
        root,
        directory,
        manifest,
        onPublication() {
          throw new Error("synthetic interruption");
        },
      }),
    /synthetic interruption/,
  );
  assert.deepEqual(fs.readFileSync(path.join(root, firstPath)), expected);
  assert.deepEqual(fs.readFileSync(path.join(root, `${directory}/project-location/byte-repairs/${sha(observed)}.bin`)), observed);
  fs.writeFileSync(path.join(root, secondPath), "later user edit\n");
  const replay = repairManagedProjectBytes({ root, directory, manifest });
  assert.equal(replay.applied.length, 0);
  assert.equal(replay.unresolved[0].reasonCode, "MANAGED_CONTENT_EDITED");
  assert.equal(fs.readFileSync(path.join(root, secondPath), "utf8"), "later user edit\n");
  assert.equal(replay.wholeProjectReady, false);
  assert.equal(replay.claimsGlobalAtomicity, false);
});

test("explicit public resume preserves Project/default/named Session and Work/World originals at the new folder", async (t) => {
  const f = await explorerFixture(t),
    original = inspectProject(f.root),
    root = copy(f);
  const history = snapshot(f.root),
    beforeNamed = bytes(root, `.lode/sessions/by-id/${f.session.sessionId}/current.json`);
  fs.writeFileSync(path.join(f.root, "src/relay.mjs"), "throw Error('OLD ROOT MUST NOT BE READ');\n");
  const response = await runCommand(["resume", root, "--session", f.session.sessionId]);
  assert.equal(response.projectLocation.status, "relocated");
  assert.equal(response.project.sessionId, f.session.sessionId);
  const current = inspectProject(root);
  assert.equal(current.project.projectId, original.project.projectId);
  assert.equal(current.state.sessionId, original.state.sessionId);
  assert.equal(current.project.projectRoot, root);
  assert.equal(bytes(root, `.lode/sessions/by-id/${f.session.sessionId}/current.json`), beforeNamed);
  for (const [relative, value] of Object.entries(history)) {
    if (
      !relative.includes("world-model/snapshots") &&
      !relative.includes("session-work") &&
      !relative.includes("sessions/records") &&
      !relative.endsWith("sessions/current.json")
    )
      continue;
    assert.equal(snapshot(root)[relative].digest, value.digest, relative);
  }
  const stored = await inspectWorldDomainFreshness({ root, domains: ["code"] });
  assert.equal(stored.freshness.domains.code.status, "current");
  assert.equal(stored.snapshot.projectRoot, f.root);
  assert.equal((await readWorldModelSnapshot({ root, worldModelId: stored.snapshot.worldModelId })).snapshot.projectRoot, f.root);
  const work = withSessionRoute(root, f.session.sessionId, () => readSessionWorkContext({ root }));
  assert(work.records.length > 0);
  const graph = await queryProjectGraph({ root, query: "relay", details: true });
  assert(graph.nodes.length > 0);
  assert.equal(graph.basis.projectId, original.project.projectId);
  const temporal = await queryWorldTemporalGraph({ root, query: "relay", maxNodes: 30, maxEdges: 50 });
  assert(temporal);
  const capsule = await compileContext({ root, task: "Inspect relay", persist: false });
  assert(capsule.capsule);
  const owner = resolveProjectStorage(root);
  assert(projectOwnsRecordedRoot(owner, f.root));
  assert(!projectOwnsRecordedRoot(owner, "C:\\unrelated"));
  assert.equal(response.projectLocation.executionReplayAllowed, false);
  assert.equal(response.projectLocation.nativeBindingTransferred, false);
});

test("typed MCP resume validates and selects the exact named Session after relocation without writing its state", async (t) => {
  const f = await explorerFixture(t),
    root = copy(f),
    stateFile = `.lode/sessions/by-id/${f.session.sessionId}/current.json`,
    before = bytes(root, stateFile);
  const context = createSessionCallContext();
  const result = await dispatch(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "lode_project_initialize_or_resume", arguments: { project_root: root, session_id: f.session.sessionId } },
    },
    { sessionContext: context },
  );
  assert(!result.error, JSON.stringify(result));
  assert(!result.result?.isError, JSON.stringify(result));
  assert.equal(context.read(root).sessionId, f.session.sessionId);
  assert.equal(bytes(root, stateFile), before);
  assert.equal(inspectProject(root).project.projectId, f.projectId);
});

test("successive folder moves preserve the full location chain, user-owned config and original Session bytes", async (t) => {
  const f = await explorerFixture(t),
    first = copy(f, "first"),
    second = path.join(f.base, "second");
  await initializeOrResumeProject({ root: first, pluginRoot });
  // User-owned ordinary files are not rewritten by relocation or resume.
  fs.writeFileSync(path.join(first, "preferences.json"), '{"keep":"exact"}\n');
  fs.cpSync(first, second, { recursive: true });
  const session = bytes(second, ".lode/sessions/current.json");
  await initializeOrResumeProject({ root: second, pluginRoot });
  const storage = resolveProjectStorage(second);
  assert(projectOwnsRecordedRoot(storage, first));
  assert(projectOwnsRecordedRoot(storage, f.root));
  assert.equal(inspectProject(second).project.projectId, f.projectId);
  assert.equal(bytes(second, ".lode/sessions/current.json"), session);
  assert.equal(bytes(second, "preferences.json"), '{"keep":"exact"}\n');
  assert.equal((await inspectWorldDomainFreshness({ root: second, domains: ["code"] })).freshness.domains.code.status, "stale");
  // A new real source file causes honest drift; it is not hidden by ownership aliasing.
});

test("relocation restores the same checkpoint direction without rewriting history or replaying execution", async (t) => {
  const f = await explorerFixture(t);
  const checkpoint = withSessionRoute(f.root, f.session.sessionId, () =>
    createRecoveryCheckpoint({
      root: f.root,
      purpose: "Keep the agreed synthetic task",
      currentPosition: "Inspect relay",
      nextExpectedResult: "Return local evidence only",
      approvedDecisions: ["No deployment"],
    }),
  ).checkpoint;
  const root = copy(f),
    stateFile = `.lode/sessions/by-id/${f.session.sessionId}/current.json`;
  const beforeState = bytes(root, stateFile),
    beforeFiles = snapshot(root);
  await initializeOrResumeProject({ root, pluginRoot, projectSessionRoute: { sessionId: f.session.sessionId } });
  const beforeRestore = snapshot(root);
  const restored = withSessionRoute(root, f.session.sessionId, () => restoreSessionFromArtifacts({ root }));
  assert.equal(restored.projection.checkpoint.checkpointId, checkpoint.checkpointId);
  assert.equal(restored.projection.consumerInstruction.historicalCheckpointContext.nextExpectedResult, "Return local evidence only");
  assert.equal(restored.projection.consumerInstruction.nextExpectedResult, undefined);
  assert.equal(restored.projection.consumerInstruction.historicalApprovalGrantsCurrentEffect, false);
  assert.equal(bytes(root, stateFile), beforeState);
  assert.deepEqual(snapshot(root), beforeRestore);
  for (const [relative, original] of Object.entries(beforeFiles))
    if (relative.includes("/ledger/")) assert.equal(snapshot(root)[relative].digest, original.digest);
});

test("the same synthetic native caller cannot inherit the old folder's operational Session binding", async (t) => {
  const f = await explorerFixture(t),
    environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: f.operational };
  const host = createSessionHostAdapter({ runtime: "codex", nativeSessionId: "synthetic-local-caller", environment });
  assert.equal(host.select({ root: f.root, sessionId: f.session.sessionId, expectedRevision: 0 }).status, "host_selection_retained");
  const root = copy(f);
  await initializeOrResumeProject({ root, pluginRoot });
  const before = snapshot(f.base);
  assert.equal(host.read({ root }).status, "absent");
  assert.equal(host.read({ root: f.root }).sessionId, f.session.sessionId);
  assert.deepEqual(snapshot(f.base), before);
});

test("native MCP resume reaches a relocated or interrupted Project before optional Host binding lookup", async (t) => {
  const f = await explorerFixture(t),
    environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: f.operational };
  for (const stage of [null, "project", "manifest"]) {
    const root = copy(f, `native-${stage ?? "fresh"}`);
    if (stage)
      assert.throws(() =>
        resumeProjectLocation({
          root,
          pluginRoot,
          onPublication(boundary) {
            if (boundary === stage) throw Error("interruption");
          },
        }),
      );
    const bridge = createNativeSessionHostBridge({ runtime: "codex", environment });
    const result = await dispatch(
      {
        jsonrpc: "2.0",
        id: "synthetic-local-resume",
        method: "tools/call",
        params: {
          _meta: { threadId: "synthetic-native-resume" },
          name: "lode_project_initialize_or_resume",
          arguments: { project_root: root },
        },
      },
      { nativeSessionBridge: bridge },
    );
    assert(!result.error, JSON.stringify(result));
    assert(!result.result?.isError, JSON.stringify(result));
    assert.equal(result.result.structuredContent.project.projectId, f.projectId);
    assert.equal(result.result.structuredContent.project.sessionId, f.owner.state.sessionId);
    assert.equal(inspectProject(root).status, "ready");
  }
});

test("a deferred optional Host failure exposes the applied location but never guesses a Session or claims resume completion", async (t) => {
  const f = await explorerFixture(t),
    root = copy(f),
    beforeNamed = bytes(root, `.lode/sessions/by-id/${f.session.sessionId}/current.json`);
  const result = await dispatch(
    { id: "synthetic-host-failure", method: "tools/call", params: { name: "lode_project_initialize_or_resume", arguments: { project_root: root } } },
    {
      resolveSessionContext() {
        throw Object.assign(Error("Synthetic caller unavailable"), { code: "NATIVE_SESSION_CALLER_UNAVAILABLE" });
      },
    },
  );
  assert(!result.error, JSON.stringify(result));
  const value = result.result.structuredContent;
  assert.equal(value.status, "session_selection_unresolved");
  assert.equal(value.sessionId, null);
  assert.equal(value.projectAction, undefined);
  assert.equal(value.projectLocation.status, "relocated");
  assert.match(value.presentation.summary, /location recovery was applied/);
  assert.equal(value.reasonCode, "NATIVE_SESSION_CALLER_UNAVAILABLE");
  assert.equal(value.executionReplayAllowed, false);
  assert.equal(bytes(root, `.lode/sessions/by-id/${f.session.sessionId}/current.json`), beforeNamed);
  assert.equal(inspectProject(root).project.projectId, f.projectId);
});

test("explicit named MCP success retains identical unavailable-Host diagnostics at normal and relocated roots", async (t) => {
  const f = await explorerFixture(t),
    moved = copy(f),
    results = [];
  for (const root of [f.root, moved]) {
    const response = await dispatch(
      {
        id: "synthetic-explicit-host-failure",
        method: "tools/call",
        params: { name: "lode_project_initialize_or_resume", arguments: { project_root: root, session_id: f.session.sessionId } },
      },
      {
        resolveSessionContext() {
          throw Object.assign(Error("Synthetic missing caller"), { code: "NATIVE_SESSION_CALLER_UNAVAILABLE" });
        },
      },
    );
    assert(!response.error, JSON.stringify(response));
    assert(!response.result.isError);
    assert.equal(response.result.structuredContent.project.sessionId, f.session.sessionId);
    results.push(response.result._meta.headSessionBinding);
  }
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[1], {
    status: "unavailable",
    reasonCode: "NATIVE_SESSION_CALLER_UNAVAILABLE",
    scope: "current-explicit-request-only",
    retainedForSubsequentCalls: false,
    persisted: false,
  });
});

test("invalid profile/runtime/package/Session or lost binding refuses before location publication", async (t) => {
  const f = await explorerFixture(t);
  for (const [name, options] of [
    ["profile", { profile: "invalid" }],
    ["runtime", { runtimes: ["unknown"] }],
    ["package", { pluginRoot: path.join(f.base, "missing-plugin") }],
    ["session", { projectSessionRoute: { sessionId: "session-00000000-0000-0000-0000-000000000000" } }],
  ]) {
    const root = copy(f, name),
      before = snapshot(root);
    await assert.rejects(initializeOrResumeProject({ root, pluginRoot, ...options }));
    assert.deepEqual(snapshot(root), before, name);
  }
  const root = copy(f, "lost"),
    context = createSessionCallContext();
  context.lose(root);
  const before = snapshot(root);
  await assert.rejects(initializeOrResumeProject({ root, pluginRoot, projectSessionRoute: { context } }), { code: "SESSION_SELECTION_LOST" });
  assert.deepEqual(snapshot(root), before);
});

test("interrupted two-file publication fails closed for readers and exact retry rolls forward; divergent retry cannot overwrite", async (t) => {
  const f = await explorerFixture(t),
    root = copy(f);
  assert.throws(
    () =>
      resumeProjectLocation({
        root,
        pluginRoot,
        onPublication(stage) {
          if (stage === "project") throw Error("synthetic crash");
        },
      }),
    /synthetic crash/,
  );
  assert.throws(() => inspectProject(root), { code: "PROJECT_RELOCATION_PENDING" });
  const resumed = await initializeOrResumeProject({ root, pluginRoot });
  assert.equal(resumed.projectLocation.status, "relocated");
  assert.equal(inspectProject(root).status, "ready");
  assert.equal(fs.existsSync(path.join(root, ".lode/project-location/pending.json")), false);
  const again = await initializeOrResumeProject({ root, pluginRoot });
  assert(!again.projectLocation);
  const divergent = copy(f, "divergent");
  assert.throws(() =>
    resumeProjectLocation({
      root: divergent,
      pluginRoot,
      onPublication() {
        throw Error("synthetic crash");
      },
    }),
  );
  fs.appendFileSync(path.join(divergent, ".lode/generated/manifest.json"), " ");
  const before = snapshot(divergent);
  await assert.rejects(initializeOrResumeProject({ root: divergent, pluginRoot }), { code: "PROJECT_RELOCATION_CONFLICT" });
  assert.deepEqual(snapshot(divergent), before);
});

test("both publication-stage interruptions recover through an exact existing named Session; invalid retries remain write-free", async (t) => {
  const f = await explorerFixture(t);
  for (const stage of ["project", "manifest"]) {
    const root = copy(f, `interrupted-${stage}`);
    assert.throws(
      () =>
        resumeProjectLocation({
          root,
          pluginRoot,
          onPublication(boundary) {
            if (boundary === stage) throw Error("synthetic interruption");
          },
        }),
      /synthetic interruption/,
    );
    const before = snapshot(root);
    await assert.rejects(initializeOrResumeProject({ root, pluginRoot, projectSessionRoute: { sessionId: "session-00000000-0000-0000-0000-000000000000" } }), {
      code: "SESSION_NOT_FOUND",
    });
    assert.deepEqual(snapshot(root), before);
    const context = createSessionCallContext();
    context.lose(root);
    await assert.rejects(initializeOrResumeProject({ root, pluginRoot, projectSessionRoute: { context } }), { code: "SESSION_SELECTION_LOST" });
    assert.deepEqual(snapshot(root), before);
    const resumed = await runCommand(["resume", root, "--session", f.session.sessionId]);
    assert.equal(resumed.projectLocation.status, "relocated");
    assert.equal(resumed.project.sessionId, f.session.sessionId);
    assert.equal(inspectProject(root).project.projectId, f.projectId);
    assert.equal(fs.existsSync(path.join(root, ".lode/project-location/pending.json")), false);
  }
});

test("history tamper, local owner conflicts and managed drift cannot acquire a new location or reuse a cached graph", async (t) => {
  const f = await explorerFixture(t),
    root = copy(f);
  await initializeOrResumeProject({ root, pluginRoot });
  await queryProjectGraph({ root, details: true });
  const project = inspectProject(root).project;
  fs.appendFileSync(path.join(root, `.lode/project-location/history/${project.location.previousProjectDigest}.json`), " ");
  assert.throws(() => inspectProject(root), { code: "PROJECT_LOCATION_IDENTITY_MISMATCH" });
  const unavailable = await queryProjectGraph({ root });
  assert.equal(unavailable.status, "source-fallback");
  assert.equal(unavailable.nodes.length, 0);
  const conflict = copy(f, "conflict");
  fs.mkdirSync(path.join(conflict, ".head"));
  fs.copyFileSync(path.join(conflict, ".lode/project.json"), path.join(conflict, ".head/project.json"));
  await assert.rejects(initializeOrResumeProject({ root: conflict, pluginRoot }), { code: "PROJECT_STORAGE_CONFLICT" });
  const drift = copy(f, "drift");
  fs.appendFileSync(path.join(drift, "AGENTS.md"), "\nuser change\n");
  const before = snapshot(drift);
  await assert.rejects(initializeOrResumeProject({ root: drift, pluginRoot }), { code: "PROJECT_NOT_READY" });
  assert.deepEqual(snapshot(drift), before);
});

function makeOriginUnverified(root) {
  const file = path.join(root, ".lode/project.json");
  const original = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({ ...original, projectRoot: "C:/unverified-origin/synthetic-project" }, null, 2) + "\n");
  const manifestFile = path.join(root, ".lode/generated/manifest.json"),
    manifest = JSON.parse(fs.readFileSync(manifestFile));
  manifest.managed.find((entry) => entry.path === ".lode/project.json").sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
}

test("explicit copied Project adoption preserves exact originals and reads v3 World without an old-root alias", async (t) => {
  const f = await explorerFixture(t),
    root = copy(f, "unproved-cli");
  makeOriginUnverified(root);
  const before = snapshot(root),
    session = bytes(root, ".lode/sessions/current.json");
  const status = await runCommand(["status", root]);
  assert.equal(status.projectLocation.origin, "initial-origin-unverified");
  assert.deepEqual(snapshot(root), before);
  await assert.rejects(runCommand(["resume", root]), { code: "PROJECT_COPY_CHOICE_REQUIRED" });
  assert.deepEqual(snapshot(root), before);
  const result = await runCommand(["resume", root, "--copied-project", "verified-copy", "--session", f.session.sessionId]);
  assert.equal(result.projectLocation.status, "verified-copy-adopted");
  assert.equal(result.projectLocation.origin, "initial-origin-unverified");
  assert.equal(bytes(root, ".lode/sessions/current.json"), session);
  const storage = resolveProjectStorage(root);
  assert.equal(projectOwnsRecordedRoot(storage, f.root), false);
  const worldModelId = JSON.parse(bytes(root, ".lode/world-model/current.json")).worldModelId;
  const originalWorld = await readWorldModelSnapshot({ root, worldModelId });
  assert.equal(originalWorld.snapshot.projectRoot, f.root);
  const graph = await queryProjectGraph({ root, query: "relay", details: true });
  assert(graph.nodes.length > 0);
  const admitted = Object.entries(before).find(([p]) => p.replaceAll("\\", "/").includes("/project-direction/revisions/") && p.endsWith(".json"));
  assert(admitted);
  assert.equal(projectOwnsRecordedRecord(storage, f.root, { path: admitted[0].replaceAll("\\", "/"), digest: admitted[1].digest }), true);
  assert.equal(projectOwnsRecordedRecord(storage, f.root, { path: ".lode/unadmitted.json", digest: admitted[1].digest }), false);
  const next = copy({ ...f, root }, "adopted-second-move");
  await initializeOrResumeProject({ root: next, pluginRoot });
  assert.equal((await readWorldModelSnapshot({ root: next, worldModelId })).snapshot.projectRoot, f.root);
  assert.equal(projectOwnsRecordedRoot(resolveProjectStorage(next), f.root), false);
});

test("typed MCP can adopt the exact copied named Session without selecting a replacement or promoting Canon", async (t) => {
  const f = await explorerFixture(t),
    root = copy(f, "unproved-mcp");
  makeOriginUnverified(root);
  const before = bytes(root, ".lode/context/product-model.json");
  const response = await dispatch({
    jsonrpc: "2.0",
    id: "copy-resume",
    method: "tools/call",
    params: {
      name: "lode_project_initialize_or_resume",
      arguments: { project_root: root, session_id: f.session.sessionId, copied_project: "verified-copy" },
    },
  });
  assert(!response.error, JSON.stringify(response));
  assert.equal(response.result.structuredContent.projectLocation.status, "verified-copy-adopted");
  assert.equal(response.result.structuredContent.project.sessionId, f.session.sessionId);
  assert.equal(bytes(root, ".lode/context/product-model.json"), before);
});

test("copy publication preserves concurrent raw edits and refuses final Project divergence without clearing pending", async (t) => {
  const f = await explorerFixture(t);
  for (const target of ["project", "manifest-raw"]) {
    const root = copy(f, "concurrent-" + target);
    makeOriginUnverified(root);
    const mf = path.join(root, ".lode/generated/manifest.json");
    if (target === "manifest-raw") {
      const value = JSON.parse(fs.readFileSync(mf));
      value.synthetic = "\uFFFD";
      fs.writeFileSync(mf, JSON.stringify(value));
    }
    let edited;
    assert.throws(
      () =>
        adoptVerifiedProjectCopy({
          root,
          pluginRoot,
          onPublication(stage) {
            if (stage !== "copy-project") return;
            const file = target === "project" ? path.join(root, ".lode/project.json") : mf;
            const old = fs.readFileSync(file);
            if (target === "project") edited = Buffer.concat([old, Buffer.from(" ")]);
            else {
              const at = old.indexOf(Buffer.from("\uFFFD"));
              assert(at >= 0);
              edited = Buffer.concat([old.subarray(0, at), Buffer.from([255]), old.subarray(at + 3)]);
            }
            fs.writeFileSync(file, edited);
          },
        }),
      (error) => ["PROJECT_COPY_SOURCE_CHANGED", "PROJECT_COPY_PUBLICATION_CONFLICT"].includes(error.code),
    );
    assert.deepEqual(fs.readFileSync(target === "project" ? path.join(root, ".lode/project.json") : mf), edited);
    assert(fs.existsSync(path.join(root, ".lode/project-location/pending.json")));
  }
});

test("an interrupted copy can resume after optional index drift but never after changed common direction", async (t) => {
  const f = await explorerFixture(t);
  for (const change of ["graph-discovery/index.json", "project-direction/current.json"]) {
    const root = copy(f, "retry-" + change.split("/")[0]);
    makeOriginUnverified(root);
    assert.throws(
      () =>
        adoptVerifiedProjectCopy({
          root,
          pluginRoot,
          onPublication(stage) {
            if (stage === "copy-project") throw Error("interrupted");
          },
        }),
      /interrupted/,
    );
    fs.appendFileSync(path.join(root, ".lode", change), " ");
    if (change.startsWith("project-direction")) assert.throws(() => adoptVerifiedProjectCopy({ root, pluginRoot }), { code: "PROJECT_COPY_SOURCE_CHANGED" });
    else assert.equal(adoptVerifiedProjectCopy({ root, pluginRoot }).status, "verified-copy-adopted");
  }
});

test("managed aliases and binary data are preserved before repair/adoption effects", async (t) => {
  const f = await explorerFixture(t),
    root = copy(f, "aliased");
  makeOriginUnverified(root);
  const mf = path.join(root, ".lode/generated/manifest.json"),
    manifest = JSON.parse(fs.readFileSync(mf));
  manifest.managed.push({ ...manifest.managed.find((entry) => entry.path === ".lode/project.json"), path: ".lode/PROJECT.JSON" });
  fs.writeFileSync(mf, JSON.stringify(manifest));
  const before = snapshot(root);
  assert.throws(() => adoptVerifiedProjectCopy({ root, pluginRoot }), { code: "PROJECT_COPY_PATH_ALIAS" });
  assert.throws(() => repairManagedProjectBytes({ root, directory: ".lode", manifest }), { code: "PROJECT_COPY_PATH_ALIAS" });
  assert.deepEqual(snapshot(root), before);
  const bin = Buffer.from([0, 255, 13, 10]),
    expected = Buffer.from([0, 255, 10]),
    file = path.join(root, ".lode/assets/example.bin");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bin);
  const binaryManifest = {
    schemaVersion: 1,
    managed: [{ path: ".lode/assets/example.bin", sha256: crypto.createHash("sha256").update(expected).digest("hex") }],
  };
  assert.equal(repairManagedProjectBytes({ root, directory: ".lode", manifest: binaryManifest }).applied.length, 0);
  assert.deepEqual(fs.readFileSync(file), bin);
});

test("a completed byte-repair intent preserves a later mixed-ending edit on retry", (t) => {
  const root = fs.mkdtempSync(path.join(pluginRoot, ".qa-repair-retry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relative = ".lode/generated/fixture.md",
    file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "a\r\nb\r\n");
  const manifest = { schemaVersion: 1, managed: [{ path: relative, sha256: crypto.createHash("sha256").update("a\nb\n").digest("hex") }] };
  assert.throws(
    () =>
      repairManagedProjectBytes({
        root,
        directory: ".lode",
        manifest,
        onPublication() {
          throw Error("response lost");
        },
      }),
    /response lost/,
  );
  fs.writeFileSync(file, "a\r\nb\n");
  const before = fs.readFileSync(file);
  const retry = repairManagedProjectBytes({ root, directory: ".lode", manifest });
  assert.equal(retry.applied.length, 0);
  assert.equal(retry.unresolved[0].reasonCode, "PROJECT_REPAIR_RETRY_CONFLICT");
  assert.deepEqual(fs.readFileSync(file), before);
});

test("copied Canon and current-direction closure fail before first adoption write while normal Core keeps optional independence", async (t) => {
  const f = await explorerFixture(t);
  for (const damage of ["direction", "knowledge"]) {
    const root = copy(f, "preflight-" + damage);
    makeOriginUnverified(root);
    if (damage === "direction")
      fs.writeFileSync(path.join(root, ".lode/project-direction/current.json"), JSON.stringify({ directionId: "direction-" + "1".repeat(24) }));
    else {
      const file = path.join(root, ".lode/context/knowledge.json"),
        doc = JSON.parse(fs.readFileSync(file));
      doc.schemaVersion = 999;
      fs.writeFileSync(file, JSON.stringify(doc));
    }
    const before = snapshot(root);
    await assert.rejects(runCommand(["resume", root, "--copied-project", "verified-copy"]), (error) =>
      ["INVALID_PROJECT_DIRECTION", "INVALID_KNOWLEDGE_SCHEMA"].includes(error.code),
    );
    assert.deepEqual(snapshot(root), before);
  }
  const root = copy(f, "choice-before-repair");
  makeOriginUnverified(root);
  const role = path.join(root, ".lode/roles/developer.md"),
    raw = fs.readFileSync(role, "utf8");
  fs.writeFileSync(role, raw.replaceAll("\n", "\r\n"));
  const before = snapshot(root);
  await assert.rejects(runCommand(["resume", root]), { code: "PROJECT_COPY_CHOICE_REQUIRED" });
  assert.deepEqual(snapshot(root), before);
  const local = copy(f, "normal-with-foreign");
  await runCommand(["resume", local]);
  fs.mkdirSync(path.join(local, ".head"));
  fs.writeFileSync(path.join(local, ".head/project.json"), '{"unrelated":true}');
  const healthy = await runCommand(["resume", local]);
  assert.equal(healthy.status, "core_ready");
});

test("copied history cannot borrow a custom adapter or a cached entry after physical closure loss", async (t) => {
  const f = await explorerFixture(t),
    root = copy(f, "adapter-copy");
  makeOriginUnverified(root);
  await runCommand(["resume", root, "--copied-project", "verified-copy"]);
  const worldModelId = JSON.parse(bytes(root, ".lode/world-model/current.json")).worldModelId;
  const storage = resolveProjectStorage(root),
    adapter = new LocalJsonWorldModelStoreAdapter({ projectRoot: root, storage });
  const entry = await adapter.readSnapshot(worldModelId);
  const custom = new LocalJsonWorldModelStoreAdapter({ projectRoot: root, storage });
  custom.readSnapshot = async () => ({ location: null, document: structuredClone(entry.document) });
  await assert.rejects(readWorldModelSnapshot({ root, worldModelId, storeAdapter: custom }), { code: "WORLD_MODEL_IDENTITY_MISMATCH" });
  const descriptor = entry.snapshotStorage.dependencies.find((ref) => ref.domain === "world-code-chunks");
  assert(descriptor);
  fs.unlinkSync(path.join(root, descriptor.address));
  custom.readSnapshot = async () => entry;
  await assert.rejects(readWorldModelSnapshot({ root, worldModelId, storeAdapter: custom }), { code: "ENOENT" });
  const core = await runCommand(["resume", root]);
  assert.equal(core.readiness.core.state, "ready");
});

test("copy preflight and actual recovery lookup reject a valid checkpoint stored at another requested address", async (t) => {
  const f = await explorerFixture(t);
  const checkpoint = withSessionRoute(f.root, f.session.sessionId, () =>
    createRecoveryCheckpoint({
      root: f.root,
      purpose: "Synthetic checkpoint identity",
      currentPosition: "Inspect exact address",
      nextExpectedResult: "Keep original direction",
      approvedDecisions: [],
    }),
  ).checkpoint;
  const root = copy(f, "swapped-checkpoint"),
    fakeId = "checkpoint-" + "f".repeat(24);
  makeOriginUnverified(root);
  fs.copyFileSync(path.join(root, ".lode/sessions/ledger", checkpoint.checkpointId + ".json"), path.join(root, ".lode/sessions/ledger", fakeId + ".json"));
  const stateFile = path.join(root, ".lode/sessions/by-id", f.session.sessionId, "current.json"),
    state = JSON.parse(fs.readFileSync(stateFile));
  state.latestCheckpoint = fakeId;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.copyFileSync(path.join(f.root, ".lode/sessions/ledger", checkpoint.checkpointId + ".json"), path.join(f.root, ".lode/sessions/ledger", fakeId + ".json"));
  assert.throws(() => withSessionRoute(f.root, f.session.sessionId, () => readRecoveryCheckpoint({ root: f.root, checkpointId: fakeId })), {
    code: "INVALID_RECOVERY_CHECKPOINT",
  });
  const before = snapshot(root);
  await assert.rejects(runCommand(["resume", root, "--session", f.session.sessionId, "--copied-project", "verified-copy"]), {
    code: "INVALID_RECOVERY_CHECKPOINT",
  });
  assert.deepEqual(snapshot(root), before);
});
