import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fixture, snapshot } from "./helpers/session-work-linkage-fixture.mjs";
import { updateProjectDirection, readProjectDirection } from "../scripts/lib/project-direction.mjs";
import {
  createRecoveryCheckpoint,
  readRecoveryCheckpoint,
} from "../scripts/lib/compaction-recovery.mjs";
import { inspectProject, convergeProjectInstallation } from "../scripts/lib/lode-core.mjs";
import { pluginRoot } from "./helpers/session-work-linkage-fixture.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import {
  createSessionCallContext,
  createLodeSession,
  withSessionRoute,
} from "../scripts/lib/session-routing.mjs";
import { recordSessionWorkEvidence } from "../scripts/lib/session-work-context.mjs";
import crypto from "node:crypto";
import {
  exportProjectBundle,
  inspectProjectBundle,
  importProjectBundle,
  readImportedSourceOriginal,
} from "../scripts/lib/project-portability.mjs";

test("portable export preserves only selected originals while excluding unselected runtime owners/evidence", (t) => {
  const f = fixture(t),
    write = (relative, text) => {
      const file = path.join(f.root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
  f.save({
    summary: "Retain exact synthetic rationale",
    unknowns: ["External outcome unverified"],
  });
  write(
    ".lode/runtime/execution-leases/synthetic/consumption.json",
    "historical anti-replay evidence",
  );
  write(".lode/runtime/execution-leases/synthetic/release.json", "historical released state");
  write(
    ".lode/runtime/execution-leases/synthetic/owner.lock/token",
    "not an imported live capability",
  );
  const before = snapshot(f.root),
    destination = path.join(f.base, "portable-bundle");
  const exported = f.route(() => exportProjectBundle({ root: f.root, destination }));
  assert.equal(exported.status, "exported");
  const inspected = inspectProjectBundle({ bundleRoot: destination });
  assert.equal(inspected.status, "verified-selected-bundle");
  assert.equal(inspected.restoresExecutionPermission, false);
  assert.equal(inspected.manifest.selectedSessionId, f.session.sessionId);
  assert(!inspected.manifest.files.some((file) => file.path.endsWith("consumption.json")));
  assert(!inspected.manifest.files.some((file) => file.path.includes("owner.lock")));
  assert.equal(
    inspected.manifest.coverage.historicalExecution,
    "not-included-no-execution-permission-transferred",
  );
  assert.deepEqual(snapshot(f.root), before);
  const again = f.route(() => exportProjectBundle({ root: f.root, destination }));
  assert.equal(again.bundleId, exported.bundleId);
  const object = inspected.manifest.files[0];
  fs.appendFileSync(path.join(destination, "objects", object.sha256 + ".bin"), "tamper");
  assert.throws(() => inspectProjectBundle({ bundleRoot: destination }), {
    code: "PROJECT_COPY_SOURCE_CHANGED",
  });
  assert.deepEqual(snapshot(f.root), before);
});

test("cancelled export leaves identifiable incomplete data and exact retry converges without touching source", (t) => {
  const f = fixture(t),
    before = snapshot(f.root),
    destination = path.join(f.base, "interrupted-bundle"),
    controller = new AbortController();
  assert.throws(
    () =>
      exportProjectBundle({
        root: f.root,
        destination,
        signal: controller.signal,
        onObject() {
          controller.abort();
        },
      }),
    { code: "PROJECT_PORTABILITY_CANCELLED" },
  );
  assert(fs.existsSync(path.join(destination, "export-intent.json")));
  assert(!fs.existsSync(path.join(destination, "manifest.json")));
  assert.deepEqual(snapshot(f.root), before);
  const completed = exportProjectBundle({ root: f.root, destination });
  assert.equal(inspectProjectBundle({ bundleRoot: destination }).bundleId, completed.bundleId);
  const content = snapshot(destination);
  f.save({ summary: "Unselected later work does not change this selected bundle" });
  assert.equal(exportProjectBundle({ root: f.root, destination }).bundleId, completed.bundleId);
  recordSessionWorkEvidence({
    root: f.root,
    input: { summary: "Selected later work must not replace this frozen bundle" },
  });
  assert.throws(() => exportProjectBundle({ root: f.root, destination }), {
    code: "PROJECT_BUNDLE_CONFLICT",
  });
  assert.deepEqual(snapshot(destination), content);
  assert.throws(
    () =>
      exportProjectBundle({
        root: f.root,
        destination: path.join(f.root, ".lode/forbidden-export"),
      }),
    { code: "PROJECT_BUNDLE_DESTINATION_INSIDE_SOURCE" },
  );
  assert(!fs.existsSync(path.join(f.root, ".lode/forbidden-export")));
});

test("selected export never reads other Session bodies/cache or user MCP configuration", (t) => {
  const f = fixture(t);
  f.save({ summary: "SELECTED_CONTEXT_SENTINEL" });
  const other = createLodeSession({ root: f.root, purpose: "Unselected synthetic work" });
  withSessionRoute(f.root, other.sessionId, () =>
    recordSessionWorkEvidence({
      root: f.root,
      input: { summary: "OTHER_SESSION_PRIVATE_SENTINEL" },
    }),
  );
  const config = path.join(f.root, ".mcp.json"),
    value = JSON.parse(fs.readFileSync(config));
  value.mcpServers.syntheticUnrelated = {
    command: "example",
    env: { SYNTHETIC_ONLY: "MCP_NOT_EXPORTED_SENTINEL" },
  };
  fs.writeFileSync(config, JSON.stringify(value));
  const before = snapshot(f.root),
    read = fs.readFileSync;
  fs.readFileSync = function (file, ...args) {
    const normalized = String(file).replaceAll("\\", "/");
    if (
      normalized === config.replaceAll("\\", "/") ||
      normalized.includes("/by-id/" + other.sessionId + "/work-evidence/") ||
      normalized.includes("/graph-discovery/")
    )
      throw Error("Read outside selected export scope");
    return read.call(this, file, ...args);
  };
  let exported;
  try {
    exported = f.route(() =>
      exportProjectBundle({ root: f.root, destination: path.join(f.base, "scoped-bundle") }),
    );
  } finally {
    fs.readFileSync = read;
  }
  const result = inspectProjectBundle({ bundleRoot: exported.bundleRoot });
  const contents = fs
    .readdirSync(path.join(exported.bundleRoot, "objects"))
    .map((name) => fs.readFileSync(path.join(exported.bundleRoot, "objects", name), "utf8"))
    .join("\n");
  assert(contents.includes("SELECTED_CONTEXT_SENTINEL"));
  assert(!contents.includes("OTHER_SESSION_PRIVATE_SENTINEL"));
  assert(!contents.includes("MCP_NOT_EXPORTED_SENTINEL"));
  assert(
    !result.manifest.files.some(
      (entry) =>
        entry.path.includes(other.sessionId) ||
        entry.path === ".mcp.json" ||
        entry.path.includes("graph-discovery"),
    ),
  );
  assert.deepEqual(snapshot(f.root), before);
});

test("bundle inspect binds its manifest identity and rejects operational paths even with matching blobs", (t) => {
  const f = fixture(t),
    destination = path.join(f.base, "tampered-selection");
  f.route(() => exportProjectBundle({ root: f.root, destination }));
  const mf = path.join(destination, "manifest.json"),
    manifest = JSON.parse(fs.readFileSync(mf));
  manifest.selectedSessionId = "session-00000000-0000-0000-0000-000000000000";
  fs.writeFileSync(mf, JSON.stringify(manifest));
  assert.throws(() => inspectProjectBundle({ bundleRoot: destination }), {
    code: "PROJECT_BUNDLE_IDENTITY_MISMATCH",
  });
  manifest.selectedSessionId = f.session.sessionId;
  manifest.files.push({ ...manifest.files[0], path: ".lode/.operations/synthetic-owner.json" });
  const bytes = Buffer.from(JSON.stringify(manifest));
  fs.writeFileSync(mf, bytes);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(
    path.join(destination, "export-intent.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "ProjectBundleExportIntent",
      bundleId: "project-bundle-" + sha.slice(0, 24),
      manifestSha256: sha,
    }),
  );
  assert.throws(() => inspectProjectBundle({ bundleRoot: destination }), {
    code: "PROJECT_BUNDLE_SCOPE_MISMATCH",
  });
});

test("ENOSPC opening an export stage closes the already opened source descriptor", (t) => {
  const f = fixture(t),
    destination = path.join(f.base, "enospc"),
    open = fs.openSync,
    handles = [];
  fs.openSync = function (file, ...args) {
    if (String(file).endsWith(".part"))
      throw Object.assign(Error("synthetic disk full"), { code: "ENOSPC" });
    const fd = open.call(this, file, ...args);
    if (String(file).startsWith(f.root)) handles.push(fd);
    return fd;
  };
  try {
    assert.throws(() => exportProjectBundle({ root: f.root, destination }), { code: "ENOSPC" });
  } finally {
    fs.openSync = open;
  }
  assert(handles.length > 0);
  for (const fd of handles) assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
  assert(!fs.existsSync(path.join(destination, "manifest.json")));
});

test("selected import preserves exact P2/Canon and current user settings without transferring bindings or changing default", (t) => {
  const f = fixture(t);
  updateProjectDirection({
    root: f.root,
    input: {
      goal: "Continue selected synthetic work",
      constraints: ["Preserve target configuration"],
      cancelledActions: ["No deployment"],
    },
  });
  const checkpoint = f.route(() =>
    createRecoveryCheckpoint({
      root: f.root,
      purpose: "Preserve selected continuation",
      currentPosition: "Inspect current evidence",
      nextExpectedResult: "Return proof without effects",
      approvedDecisions: [],
    }),
  ).checkpoint;
  f.save({ summary: "Selected rationale for cross-folder continuation" });
  const bundle = f.route(() =>
    exportProjectBundle({ root: f.root, destination: path.join(f.base, "import-bundle") }),
  );
  const root = path.join(f.base, "destination");
  fs.mkdirSync(root);
  const userFiles = new Map(
    ["AGENTS.md", "CLAUDE.md", ".mcp.json", "opencode.json"].map((name) => [
      path.join(root, name),
      Buffer.from(
        name.endsWith("json")
          ? JSON.stringify({
              userOwned: true,
              model: "current-target-only",
              permissions: ["preserve"],
              mcpServers: { user: { command: "not-launched" } },
            })
          : "Current user's instructions\r\n",
      ),
    ]),
  );
  for (const [file, bytes] of userFiles) fs.writeFileSync(file, bytes);
  const read = fs.readFileSync;
  fs.readFileSync = function (file, ...args) {
    if (userFiles.has(String(file))) throw Error("Import must not read target root settings");
    return read.call(this, file, ...args);
  };
  let result;
  try {
    result = importProjectBundle({
      bundleRoot: bundle.bundleRoot,
      expectedBundleId: bundle.bundleId,
      root,
      pluginRoot,
    });
    withSessionRoute(root, f.session.sessionId, () =>
      assert.equal(convergeProjectInstallation({ root, pluginRoot }).status, "current"),
    );
  } finally {
    fs.readFileSync = read;
  }
  assert.equal(result.status, "imported");
  assert.equal(result.selectedSessionId, f.session.sessionId);
  assert.equal(result.defaultSessionChanged, false);
  assert.equal(result.nativeBindingTransferred, false);
  assert(!fs.existsSync(path.join(root, ".lode/sessions/current.json")));
  for (const [file, bytes] of userFiles) assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(
    fs.readFileSync(path.join(root, ".lode/context/knowledge.json")),
    fs.readFileSync(path.join(f.root, ".lode/context/knowledge.json")),
  );
  const restored = withSessionRoute(root, f.session.sessionId, () =>
    readRecoveryCheckpoint({ root, checkpointId: checkpoint.checkpointId }),
  );
  assert.equal(restored.checkpoint.checkpointDigest, checkpoint.checkpointDigest);
  const before = snapshot(root),
    again = importProjectBundle({ bundleRoot: bundle.bundleRoot, root, pluginRoot });
  assert.equal(again.status, "existing-project-originals-identical");
  assert.deepEqual(snapshot(root), before);
  updateProjectDirection({
    root,
    expectedDirectionId: readProjectDirection({ root }).directionId,
    input: {
      goal: "Newer destination direction",
      cancelledActions: ["Target deployment remains cancelled"],
    },
  });
  const newerDirection = fs.readFileSync(path.join(root, ".lode/project-direction/current.json"));
  const historical = importProjectBundle({ bundleRoot: bundle.bundleRoot, root, pluginRoot });
  assert.equal(historical.currentTargetCommon, "preserved-not-replaced");
  assert.deepEqual(
    fs.readFileSync(path.join(root, ".lode/project-direction/current.json")),
    newerDirection,
  );
  assert.deepEqual(readProjectDirection({ root }).input.cancelledActions, [
    "Target deployment remains cancelled",
  ]);
});

test("import cancel/response loss reuses exact before/after while divergent target bytes remain untouched", (t) => {
  const f = fixture(t),
    bundle = f.route(() =>
      exportProjectBundle({ root: f.root, destination: path.join(f.base, "retry-import-bundle") }),
    );
  for (const boundary of ["record", "project"]) {
    const root = path.join(f.base, "retry-" + boundary);
    fs.mkdirSync(root);
    assert.throws(
      () =>
        importProjectBundle({
          bundleRoot: bundle.bundleRoot,
          root,
          pluginRoot,
          onPublication(stage) {
            if (stage === boundary) throw Error("synthetic lost response");
          },
        }),
      /synthetic lost response/,
    );
    assert(fs.existsSync(path.join(root, ".lode/project-location/pending.json")));
    assert.equal(
      importProjectBundle({ bundleRoot: bundle.bundleRoot, root, pluginRoot }).status,
      "imported",
    );
    assert.equal(
      withSessionRoute(root, f.session.sessionId, () => inspectProject(root)).status,
      "ready",
    );
  }
  const root = path.join(f.base, "divergent-import");
  fs.mkdirSync(root);
  let edited;
  assert.throws(
    () =>
      importProjectBundle({
        bundleRoot: bundle.bundleRoot,
        root,
        pluginRoot,
        onPublication(stage) {
          if (stage === "project") {
            const file = path.join(
              root,
              ".lode/sessions/by-id",
              f.session.sessionId,
              "current.json",
            );
            fs.appendFileSync(file, " ");
            edited = fs.readFileSync(file);
          }
        },
      }),
    { code: "PROJECT_COPY_SOURCE_CHANGED" },
  );
  const before = snapshot(root);
  assert.throws(() => importProjectBundle({ bundleRoot: bundle.bundleRoot, root, pluginRoot }), {
    code: "PROJECT_COPY_SOURCE_CHANGED",
  });
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(
    fs.readFileSync(path.join(root, ".lode/sessions/by-id", f.session.sessionId, "current.json")),
    edited,
  );
});

test("public CLI and typed MCP use the same bundle identity and imported exact Session resume", async (t) => {
  const f = fixture(t);
  f.save({ summary: "Selected public continuation evidence" });
  const cliBundle = await runCommand([
    "project-export",
    f.root,
    "--session",
    f.session.sessionId,
    "--destination",
    path.join(f.base, "public-bundle"),
  ]);
  const read = await dispatch({
    jsonrpc: "2.0",
    id: "bundle-read",
    method: "tools/call",
    params: {
      name: "lode_project_bundle_read",
      arguments: { bundle_root: cliBundle.bundleRoot, expected_bundle_id: cliBundle.bundleId },
    },
  });
  assert(!read.error, JSON.stringify(read));
  assert.equal(read.result.structuredContent.bundleId, cliBundle.bundleId);
  assert(!Object.hasOwn(read.result.structuredContent, "manifest"));
  const root = path.join(f.base, "mcp-target");
  fs.mkdirSync(root);
  const imported = await dispatch({
    jsonrpc: "2.0",
    id: "bundle-import",
    method: "tools/call",
    params: {
      name: "lode_project_bundle_import",
      arguments: {
        target_root: root,
        bundle_root: cliBundle.bundleRoot,
        expected_bundle_id: cliBundle.bundleId,
      },
    },
  });
  assert(!imported.error, JSON.stringify(imported));
  assert.equal(imported.result.structuredContent.selectedSessionId, f.session.sessionId);
  const resumed = await runCommand(["resume", root, "--session", f.session.sessionId]);
  assert.equal(resumed.readiness.core.state, "ready");
  assert.equal(resumed.project.sessionId, f.session.sessionId);
  const context = createSessionCallContext();
  const typedResume = await dispatch(
    {
      jsonrpc: "2.0",
      id: "resume-imported",
      method: "tools/call",
      params: {
        name: "lode_project_initialize_or_resume",
        arguments: { project_root: root, session_id: f.session.sessionId },
      },
    },
    { sessionContext: context },
  );
  assert(!typedResume.error, JSON.stringify(typedResume));
  assert.equal(typedResume.result.structuredContent.project.sessionId, f.session.sessionId);
  assert.equal(context.read(root).sessionId, f.session.sessionId);
  const before = snapshot(root),
    unselected = await runCommand(["status", root]);
  assert.equal(unselected.reasonCode, "DEFAULT_SESSION_ABSENT");
  assert.deepEqual(snapshot(root), before);
  const otherBundle = path.join(f.base, "mcp-export");
  const exported = await dispatch({
    jsonrpc: "2.0",
    id: "bundle-export",
    method: "tools/call",
    params: {
      name: "lode_project_bundle_export",
      arguments: {
        project_root: root,
        destination: otherBundle,
        session_id: f.session.sessionId,
        provenance_scope: "project-proof-metadata",
      },
    },
  });
  assert(!exported.error, JSON.stringify(exported));
  assert.equal(exported.result.structuredContent.status, "exported");
  const cliInspect = await runCommand(["project-bundle-inspect", otherBundle]);
  assert.equal(cliInspect.bundleId, exported.result.structuredContent.bundleId);
});

test("public status/resume reports an interrupted import without initializing a replacement or replaying it", async (t) => {
  const f = fixture(t),
    bundle = f.route(() =>
      exportProjectBundle({ root: f.root, destination: path.join(f.base, "pending-bundle") }),
    );
  const root = path.join(f.base, "pending-target");
  fs.mkdirSync(root);
  assert.throws(
    () =>
      importProjectBundle({
        root,
        bundleRoot: bundle.bundleRoot,
        pluginRoot,
        onPublication() {
          throw Error("stop after one record");
        },
      }),
    /stop after one record/,
  );
  const before = snapshot(root),
    status = await runCommand(["status", root]),
    resume = await runCommand(["resume", root]);
  assert.equal(status.status, "project_import_pending");
  assert.equal(resume.status, "project_import_pending");
  assert.deepEqual(snapshot(root), before);
  assert(!fs.existsSync(path.join(root, ".lode/project.json")));
});

test("same Project adds only absent selected Session while retaining newer common Canon and default", async (t) => {
  const f = fixture(t);
  updateProjectDirection({ root: f.root, input: { goal: "Source task", cancelledActions: [] } });
  f.save({ summary: "Incoming selected result" });
  const bundle = f.route(() =>
    exportProjectBundle({ root: f.root, destination: path.join(f.base, "existing-bundle") }),
  );
  const root = path.join(f.base, "existing-target");
  fs.cpSync(f.root, root, { recursive: true });
  const selectedDirectory = path.join(root, ".lode/sessions/by-id", f.session.sessionId);
  assert(path.resolve(selectedDirectory).startsWith(path.resolve(root) + path.sep));
  fs.rmSync(selectedDirectory, { recursive: true });
  await runCommand(["resume", root]);
  updateProjectDirection({
    root,
    expectedDirectionId: readProjectDirection({ root }).directionId,
    input: { goal: "Current target scope", cancelledActions: ["deploy-synthetic"] },
  });
  const knowledge = path.join(root, ".lode/context/knowledge.json"),
    current = JSON.parse(fs.readFileSync(knowledge));
  current.unknowns.push({
    id: "target-only-unknown",
    statement: "Preserve latest target knowledge",
  });
  fs.writeFileSync(knowledge, JSON.stringify(current));
  const defaultBefore = fs.readFileSync(path.join(root, ".lode/sessions/current.json")),
    commonBefore = fs.readFileSync(path.join(root, ".lode/project-direction/current.json")),
    knowledgeBefore = fs.readFileSync(knowledge);
  const result = importProjectBundle({ bundleRoot: bundle.bundleRoot, root, pluginRoot });
  assert.equal(result.status, "selected-session-imported");
  assert.deepEqual(fs.readFileSync(path.join(root, ".lode/sessions/current.json")), defaultBefore);
  assert.deepEqual(
    fs.readFileSync(path.join(root, ".lode/project-direction/current.json")),
    commonBefore,
  );
  assert.deepEqual(fs.readFileSync(knowledge), knowledgeBefore);
  const entry = await runCommand(["conversation-enter", root, "--session", f.session.sessionId]);
  assert(JSON.stringify(entry).includes("deploy-synthetic"));
  assert(JSON.stringify(entry).includes("Incoming selected result"));
  const sourceKnowledge = inspectProjectBundle({
    bundleRoot: bundle.bundleRoot,
  }).manifest.files.find((item) => item.path === ".lode/context/knowledge.json");
  const old = readImportedSourceOriginal({
    root,
    sessionId: f.session.sessionId,
    bundleId: bundle.bundleId,
    sourcePath: sourceKnowledge.path,
    expectedDigest: sourceKnowledge.sha256,
  });
  assert.equal(old.currentTargetCanon, false);
  assert(!Buffer.from(old.contentBase64, "base64").toString().includes("target-only-unknown"));
  assert(
    JSON.parse(fs.readFileSync(knowledge)).unknowns.some(
      (item) => item.id === "target-only-unknown",
    ),
  );
  const repeat = importProjectBundle({ bundleRoot: bundle.bundleRoot, root, pluginRoot });
  assert.equal(repeat.status, "existing-project-originals-identical");
  const stateFile = path.join(selectedDirectory, "current.json");
  fs.appendFileSync(stateFile, " ");
  const before = snapshot(root);
  assert.throws(() => importProjectBundle({ bundleRoot: bundle.bundleRoot, root, pluginRoot }), {
    code: "PROJECT_COPY_SOURCE_CHANGED",
  });
  assert.deepEqual(snapshot(root), before);
});

test("an exact default-format original maps to named without rewriting it; later P2 writes use normal ownership", async (t) => {
  const f = fixture(t),
    sourceId = f.owner.state.sessionId;
  recordSessionWorkEvidence({
    root: f.root,
    input: { summary: "Default source work remains attributable" },
  });
  const checkpoint = createRecoveryCheckpoint({
    root: f.root,
    purpose: "Preserve default-source work",
    currentPosition: "Inspect actual source",
    nextExpectedResult: "Return original evidence",
    approvedDecisions: [],
  }).checkpoint;
  const sourceState = fs.readFileSync(path.join(f.root, ".lode/sessions/current.json"));
  assert.equal(JSON.parse(sourceState).projectId, undefined);
  const bundle = exportProjectBundle({
    root: f.root,
    destination: path.join(f.base, "default-format-bundle"),
  });
  const root = path.join(f.base, "default-format-target");
  fs.cpSync(f.root, root, { recursive: true });
  // Authored synthetic target baseline, not a plugin operation switching default.
  const namedB = path.join(root, ".lode/sessions/by-id", f.session.sessionId);
  fs.copyFileSync(
    path.join(namedB, "current.json"),
    path.join(root, ".lode/sessions/current.json"),
  );
  for (const directory of [namedB, path.join(root, ".lode/sessions/work-evidence")])
    if (fs.existsSync(directory)) {
      assert(path.resolve(directory).startsWith(path.resolve(root) + path.sep));
      fs.rmSync(directory, { recursive: true });
    }
  await runCommand(["resume", root]);
  const defaultBefore = fs.readFileSync(path.join(root, ".lode/sessions/current.json"));
  const result = importProjectBundle({ bundleRoot: bundle.bundleRoot, root, pluginRoot });
  assert.equal(result.status, "selected-session-imported");
  const namedA = path.join(root, ".lode/sessions/by-id", sourceId, "current.json");
  assert.deepEqual(fs.readFileSync(namedA), sourceState);
  assert.deepEqual(fs.readFileSync(path.join(root, ".lode/sessions/current.json")), defaultBefore);
  const entered = await runCommand(["conversation-enter", root, "--session", sourceId]);
  assert(JSON.stringify(entered).includes("Default source work remains attributable"));
  assert.equal(
    withSessionRoute(root, sourceId, () =>
      readRecoveryCheckpoint({ root, checkpointId: checkpoint.checkpointId }),
    ).checkpoint.checkpointDigest,
    checkpoint.checkpointDigest,
  );
  // Re-export before a P2 write adds normal named ownership metadata.
  const chainBundle = withSessionRoute(root, sourceId, () =>
    exportProjectBundle({ root, destination: path.join(f.base, "unchanged-owner-chain") }),
  );
  assert.equal(chainBundle.projectAdmissionReady, true);
  assert.equal(
    inspectProjectBundle({ bundleRoot: chainBundle.bundleRoot }).projectAdmissionReady,
    true,
  );
  const fresh = path.join(f.base, "unchanged-owner-fresh");
  fs.mkdirSync(fresh);
  assert.equal(
    importProjectBundle({ bundleRoot: chainBundle.bundleRoot, root: fresh, pluginRoot }).status,
    "imported",
  );
  assert.deepEqual(
    fs.readFileSync(path.join(fresh, ".lode/sessions/by-id", sourceId, "current.json")),
    sourceState,
  );
  assert(!fs.existsSync(path.join(fresh, ".lode/project-location/pending.json")));
  assert(
    JSON.stringify(await runCommand(["conversation-enter", fresh, "--session", sourceId])).includes(
      "Default source work remains attributable",
    ),
  );
  const existing = path.join(f.base, "unchanged-owner-existing");
  fs.cpSync(root, existing, { recursive: true });
  const remove = path.join(existing, ".lode/sessions/by-id", sourceId);
  assert(path.resolve(remove).startsWith(path.resolve(existing) + path.sep));
  fs.rmSync(remove, { recursive: true });
  await runCommand(["resume", existing]);
  const existingDefault = fs.readFileSync(path.join(existing, ".lode/sessions/current.json"));
  assert.equal(
    importProjectBundle({ bundleRoot: chainBundle.bundleRoot, root: existing, pluginRoot }).status,
    "selected-session-imported",
  );
  assert.deepEqual(
    fs.readFileSync(path.join(existing, ".lode/sessions/by-id", sourceId, "current.json")),
    sourceState,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(existing, ".lode/sessions/current.json")),
    existingDefault,
  );
  assert(
    JSON.stringify(
      await runCommand(["conversation-enter", existing, "--session", sourceId]),
    ).includes("Default source work remains attributable"),
  );
  withSessionRoute(root, sourceId, () =>
    createRecoveryCheckpoint({
      root,
      purpose: "Current legitimate P2 mutation",
      currentPosition: "Continue from copied originals",
      nextExpectedResult: "Keep target direction",
      approvedDecisions: [],
    }),
  );
  const current = JSON.parse(fs.readFileSync(namedA));
  assert.equal(current.projectId, f.owner.project.projectId);
  assert.equal(
    withSessionRoute(root, sourceId, () => inspectProject(root)).state.projectId,
    f.owner.project.projectId,
  );
  delete current.projectId;
  fs.writeFileSync(namedA, JSON.stringify(current));
  assert.throws(() => withSessionRoute(root, sourceId, () => inspectProject(root)), {
    code: "SESSION_IDENTITY_MISMATCH",
  });
  assert.deepEqual(fs.readFileSync(path.join(root, ".lode/sessions/current.json")), defaultBefore);
});

test("active, pending-review and reviewed Run originals remain usable after selected import", async (t) => {
  for (const phase of ["active", "awaiting_review", "reviewed"]) {
    const f = fixture(t);
    const { compileContext } = await import("../scripts/lib/context-compiler.mjs");
    const { createWholePlanSnapshot, createExecutionContract } = await import(
      "../scripts/lib/execution-lineage.mjs"
    );
    const { startRun, finishRun, reviewRun, getPendingReviewContext, inspectRunStorageTransition } =
      await import("../scripts/lib/run-lineage.mjs");
    const capsule = (
      await f.route(() =>
        compileContext({ root: f.root, task: "Inspect selected Run history", persist: true }),
      )
    ).capsule;
    const run = f.route(() => {
      const plan = createWholePlanSnapshot({
        root: f.root,
        objective: "Inspect selected Run history",
        plan: [{ id: "inspect", outcome: "Return fixture evidence" }],
      }).artifact;
      const contract = createExecutionContract({
        root: f.root,
        wholePlanId: plan.wholePlanId,
        capsuleId: capsule.capsuleId,
        scope: "Inspect selected Run history",
        acceptanceCriteria: ["Return exact evidence"],
      }).artifact;
      const run = startRun({ root: f.root, executionContractId: contract.executionContractId }).run;
      if (phase !== "active")
        finishRun({
          root: f.root,
          outcome: "Inspected exact synthetic original",
          evidence: [{ uri: "synthetic-only", digest: "synthetic-only" }],
          verification: [{ check: "fixture", status: "passed" }],
        });
      if (phase === "reviewed")
        reviewRun({
          root: f.root,
          reviewContextId: getPendingReviewContext({ root: f.root }).review.reviewContextId,
          disposition: "accept",
          rationale: "Fixture evidence meets the declared contract",
          nextActions: ["Continue the current direction"],
        });
      return run;
    });
    const bundle = f.route(() =>
      exportProjectBundle({ root: f.root, destination: path.join(f.base, "run-bundle") }),
    );
    const root = path.join(f.base, "run-target");
    fs.mkdirSync(root);
    importProjectBundle({ root, bundleRoot: bundle.bundleRoot, pluginRoot });
    const before = snapshot(root);
    const transition = withSessionRoute(root, f.session.sessionId, () =>
      inspectRunStorageTransition({ root }),
    );
    assert.equal(transition.runId, run.runId);
    assert.equal(transition.status, "committed");
    if (phase === "awaiting_review")
      assert.equal(
        withSessionRoute(root, f.session.sessionId, () => getPendingReviewContext({ root }))
          .pendingReview.runId,
        run.runId,
      );
    await runCommand(["conversation-enter", root, "--session", f.session.sessionId]);
    assert.deepEqual(
      snapshot(root),
      before,
      "reading imported Run lineage never repairs or completes execution",
    );
    if (phase === "active") {
      const sourceFile = path.join(f.root, ".lode/sessions/runs", run.runId, "run.json");
      const original = fs.readFileSync(sourceFile),
        damaged = JSON.parse(original);
      damaged.startOperation.operationHash = "0".repeat(64);
      fs.writeFileSync(sourceFile, JSON.stringify(damaged));
      assert.throws(() => f.route(() => inspectRunStorageTransition({ root: f.root })), {
        code: "RUN_START_IDENTITY_CONFLICT",
      });
      const rejected = path.join(f.base, "damaged-run-export");
      assert.throws(
        () => f.route(() => exportProjectBundle({ root: f.root, destination: rejected })),
        { code: "RUN_START_IDENTITY_CONFLICT" },
      );
      assert(!fs.existsSync(rejected));
      fs.writeFileSync(sourceFile, original);
    }
  }
});

test("legacy default-owned Run keeps exact ownership through named import and its next legitimate mutation", async (t) => {
  const f = fixture(t),
    sourceId = f.owner.state.sessionId;
  const { compileContext } = await import("../scripts/lib/context-compiler.mjs");
  const { createWholePlanSnapshot, createExecutionContract } = await import(
    "../scripts/lib/execution-lineage.mjs"
  );
  const { startRun, finishRun, getPendingReviewContext, inspectRunStorageTransition } =
    await import("../scripts/lib/run-lineage.mjs");
  const capsule = (
    await compileContext({ root: f.root, task: "Preserve legacy default Run", persist: true })
  ).capsule;
  const plan = createWholePlanSnapshot({
    root: f.root,
    objective: "Preserve legacy default Run",
    plan: [{ id: "inspect", outcome: "Return fixture evidence" }],
  }).artifact;
  const contract = createExecutionContract({
    root: f.root,
    wholePlanId: plan.wholePlanId,
    capsuleId: capsule.capsuleId,
    scope: "Preserve legacy default Run",
    acceptanceCriteria: ["Exact historical owner remains"],
  }).artifact;
  const run = startRun({ root: f.root, executionContractId: contract.executionContractId }).run;
  const sourceRun = path.join(f.root, ".lode/sessions/runs", run.runId, "run.json"),
    legacy = JSON.parse(fs.readFileSync(sourceRun));
  // An explicitly authored supported legacy producer fixture, not an import rewrite.
  delete legacy.sessionId;
  delete legacy.startOperation;
  delete legacy.sessionTransition;
  fs.writeFileSync(sourceRun, JSON.stringify(legacy));
  const legacyBytes = fs.readFileSync(sourceRun);
  assert.equal(inspectRunStorageTransition({ root: f.root }).status, "stable");
  const bundle = exportProjectBundle({
    root: f.root,
    destination: path.join(f.base, "legacy-run-bundle"),
  });
  const root = path.join(f.base, "legacy-run-target");
  fs.cpSync(f.root, root, { recursive: true });
  const namedB = path.join(root, ".lode/sessions/by-id", f.session.sessionId);
  fs.copyFileSync(
    path.join(namedB, "current.json"),
    path.join(root, ".lode/sessions/current.json"),
  );
  assert(path.resolve(namedB).startsWith(path.resolve(root) + path.sep));
  fs.rmSync(namedB, { recursive: true });
  await runCommand(["resume", root]);
  const defaultBefore = fs.readFileSync(path.join(root, ".lode/sessions/current.json"));
  assert.equal(
    importProjectBundle({ root, bundleRoot: bundle.bundleRoot, pluginRoot }).status,
    "selected-session-imported",
  );
  assert.deepEqual(
    fs.readFileSync(path.join(root, ".lode/sessions/runs", run.runId, "run.json")),
    legacyBytes,
  );
  const before = snapshot(root);
  assert.equal(
    withSessionRoute(root, sourceId, () => inspectRunStorageTransition({ root })).status,
    "stable",
  );
  assert.deepEqual(snapshot(root), before);
  const chain = withSessionRoute(root, sourceId, () =>
    exportProjectBundle({ root, destination: path.join(f.base, "legacy-run-chain") }),
  );
  assert.equal(chain.projectAdmissionReady, true);
  const fresh = path.join(f.base, "legacy-run-fresh");
  fs.mkdirSync(fresh);
  importProjectBundle({ root: fresh, bundleRoot: chain.bundleRoot, pluginRoot });
  assert.equal(
    withSessionRoute(fresh, sourceId, () => inspectRunStorageTransition({ root: fresh })).status,
    "stable",
  );
  withSessionRoute(root, sourceId, () =>
    finishRun({
      root,
      outcome: "Legitimate fixture result",
      evidence: [{ uri: "synthetic-only", digest: "synthetic-only" }],
      verification: [{ check: "fixture", status: "passed" }],
    }),
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, ".lode/sessions/runs", run.runId, "run.json")))
      .sessionId,
    sourceId,
  );
  assert.equal(
    withSessionRoute(root, sourceId, () => getPendingReviewContext({ root })).pendingReview.runId,
    run.runId,
  );
  assert.deepEqual(fs.readFileSync(path.join(root, ".lode/sessions/current.json")), defaultBefore);
});
