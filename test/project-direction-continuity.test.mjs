import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { formatForVerifiedOwner } from "../scripts/lib/storage/project-storage-format.mjs";

// Optional source override runs these same synthetic cases against the frozen
// pre-patch source; it never executes a real provider or changes that source.
const pluginRoot = process.env.HEAD_DIRECTION_TEST_SOURCE || path.resolve(import.meta.dirname, "..");
// The layer directory comes from scripts/lib-layers.json; a source tree from
// before the layer move keeps its modules directly in scripts/lib.
const layers = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../scripts/lib-layers.json"), "utf8"));
const load = (name) => {
  const layered = path.join(pluginRoot, "scripts/lib", layers.pinned.includes(name) ? name : path.join(layers.modules[name], name));
  return import(pathToFileURL(fs.existsSync(layered) ? layered : path.join(pluginRoot, "scripts/lib", name)));
};
const { initializeProject, inspectProject } = await load("head-core.mjs");
const { readProjectDirection, readProjectDirectionRevision, updateProjectDirection,
  assertProjectActionsCurrent, assertAuthorizationProjectDirection } = await load("project-direction.mjs");
const { buildRuntimeVersionEvidence } = await load("runtime-machine-execution.mjs");
const { buildRuntimeProtocolEvidence, buildRuntimeProjectBinding } = await load("runtime-protocol-evidence.mjs");
const { buildRuntimeInvocationAuthorization, prepareRuntimeInvocationExecution } = await load("runtime-invocation-lifecycle.mjs");

function project(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "head-direction-continuity-")));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  const layout = formatForVerifiedOwner(storage);
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert(path.basename(root).startsWith("head-direction-continuity-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, storage, layout };
}
const pointer = (root, layout) => path.join(root, layout.directory, "project-direction/current.json");
const store = (root, layout) => path.dirname(pointer(root, layout));
const revisions = (root, layout) => path.join(store(root, layout), "revisions");
function snapshot(root) {
  const result = {};
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else result[path.relative(root, file)] = { sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), mtimeMs: fs.statSync(file).mtimeMs };
    }
  }
  walk(root);
  return result;
}
function readOnly(root, operation) {
  const before = snapshot(root);
  try { return operation(); }
  finally { assert.deepEqual(snapshot(root), before); }
}
const unavailable = { code: "PROJECT_DIRECTION_UNAVAILABLE" };

for (const shape of ["absent", "empty-store", "empty-revisions", "unrelated-files"]) {
  test(`unused direction ${shape} preserves null and ordinary first publication`, (t) => {
    const { root, layout } = project(t);
    if (shape !== "absent") fs.mkdirSync(shape === "empty-store" ? store(root, layout) : revisions(root, layout), { recursive: true });
    if (shape === "unrelated-files") {
      fs.writeFileSync(path.join(store(root, layout), "notes.txt"), "Not a direction original");
      fs.writeFileSync(path.join(revisions(root, layout), "notes.json"), "{}");
      fs.writeFileSync(path.join(store(root, layout), ".current.json.not-a-uuid.tmp"), "{}");
    }
    readOnly(root, () => {
      assert.equal(readProjectDirection({ root }), null);
      assert.equal(assertProjectActionsCurrent({ root, actions: ["deploy"] }), null);
      assert.equal(assertAuthorizationProjectDirection(root, {}), null);
    });
    const published = updateProjectDirection({ root, input: { goal: "Synthetic local work" } });
    assert.equal(published.status, "updated");
    assert.equal(readProjectDirection({ root }).directionId, published.direction.directionId);
    assert.equal(updateProjectDirection({ root, input: { goal: "Synthetic local work" } }).status, "reused");
  });
}

for (const count of [1, 2]) {
  test(`missing direction pointer with ${count} retained original(s) never guesses or rewrites current`, (t) => {
    const { root, layout } = project(t);
    const first = updateProjectDirection({ root, input: { goal: "Explain only", cancelledActions: ["deploy"] } }).direction;
    const last = count === 1 ? first : updateProjectDirection({ root, expectedDirectionId: first.directionId,
      input: { goal: "Explain only", cancelledActions: ["deploy", "publish"] } }).direction;
    fs.unlinkSync(pointer(root, layout));
    readOnly(root, () => {
      assert.throws(() => readProjectDirection({ root }), unavailable);
      assert.throws(() => assertProjectActionsCurrent({ root, actions: ["deploy"] }), unavailable);
      assert.throws(() => assertAuthorizationProjectDirection(root, {}), unavailable);
      assert.throws(() => assertAuthorizationProjectDirection(root, { currentProjectDirectionId: last.directionId }), unavailable);
      assert.deepEqual(readProjectDirectionRevision({ root, directionId: first.directionId }), first);
      assert.throws(() => updateProjectDirection({ root, input: first.input }), unavailable);
    });
    assert.equal(fs.existsSync(pointer(root, layout)), false);
  });
}

for (const trace of ["pointer-stage", "revision-stage", "damaged-original-name"]) {
  test(`missing direction pointer discloses ${trace} without selecting or deleting it`, (t) => {
    const { root, layout } = project(t);
    fs.mkdirSync(revisions(root, layout), { recursive: true });
    const nonce = "00000000-0000-4000-8000-000000000000";
    const file = trace === "pointer-stage" ? path.join(store(root, layout), `.current.json.${nonce}.tmp`)
      : trace === "revision-stage" ? path.join(revisions(root, layout), `.direction-${"a".repeat(24)}.json.${nonce}.tmp`)
        : path.join(revisions(root, layout), "direction-damaged.json");
    fs.writeFileSync(file, "{");
    readOnly(root, () => assert.throws(() => readProjectDirection({ root }), unavailable));
    assert.equal(fs.existsSync(pointer(root, layout)), false);
  });
}

test("interrupted first pointer publication retains its exact orphan original and cannot authorize empty basis", (t) => {
  const { root, layout } = project(t);
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === pointer(root, layout)) throw Object.assign(new Error("Synthetic interrupted pointer publication"), { code: "SYNTHETIC_POINTER_WRITE" });
    return rename(source, destination);
  };
  try { assert.throws(() => updateProjectDirection({ root, input: { goal: "Local only", cancelledActions: ["deploy"] } }), { code: "SYNTHETIC_POINTER_WRITE" }); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readdirSync(revisions(root, layout)).length, 1);
  assert.equal(fs.existsSync(pointer(root, layout)), false);
  readOnly(root, () => {
    assert.throws(() => readProjectDirection({ root }), unavailable);
    assert.throws(() => assertAuthorizationProjectDirection(root, {}), unavailable);
  });
});

test("normal cancellation and direction drift remain strict without altering retained unknown effects", (t) => {
  const { root, layout } = project(t);
  const sessionFile = path.join(root, layout.directory, "sessions/current.json");
  const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  fs.writeFileSync(sessionFile, JSON.stringify({ ...session, externalEffect: { status: "unknown", replayAllowed: false } }));
  const first = updateProjectDirection({ root, input: { goal: "Build" } }).direction;
  const current = updateProjectDirection({ root, expectedDirectionId: first.directionId,
    input: { goal: "Build", cancelledActions: ["deploy"] } }).direction;
  readOnly(root, () => {
    assert.throws(() => assertProjectActionsCurrent({ root, actions: ["deploy"] }), { code: "PROJECT_ACTION_CANCELLED" });
    assert.throws(() => assertAuthorizationProjectDirection(root, { currentProjectDirectionId: first.directionId }), { code: "RUNTIME_PROJECT_DIRECTION_DRIFT" });
    assert.equal(assertAuthorizationProjectDirection(root, { currentProjectDirectionId: current.directionId }).directionId, current.directionId);
    assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile, "utf8")).externalEffect, { status: "unknown", replayAllowed: false });
  });
});

test("corrupt pointers and original digests retain their existing integrity errors", (t) => {
  const { root, layout } = project(t);
  const record = updateProjectDirection({ root, input: { goal: "Synthetic work" } }).direction;
  const bytes = fs.readFileSync(pointer(root, layout));
  for (const content of ["{", JSON.stringify({ directionId: "not-a-direction" })]) {
    fs.writeFileSync(pointer(root, layout), content);
    readOnly(root, () => assert.throws(() => readProjectDirection({ root }), { code: "INVALID_PROJECT_DIRECTION" }));
  }
  fs.writeFileSync(pointer(root, layout), bytes);
  const original = path.join(revisions(root, layout), `${record.directionId}.json`);
  fs.writeFileSync(original, JSON.stringify({ ...record, projectId: "foreign-project" }));
  readOnly(root, () => assert.throws(() => readProjectDirection({ root }), { code: "PROJECT_DIRECTION_INTEGRITY_FAILURE" }));
});

test("recognized direction symlink trace retains path confinement instead of becoming empty or guessed", (t) => {
  const { root, layout } = project(t);
  fs.mkdirSync(revisions(root, layout), { recursive: true });
  const trace = path.join(revisions(root, layout), `direction-${"a".repeat(24)}.json`);
  fs.writeFileSync(trace, "{}");
  // A synchronous filesystem seam avoids requiring Windows symlink privileges.
  const lstat = fs.lstatSync;
  fs.lstatSync = (file, ...args) => file === trace ? { isSymbolicLink: () => true } : lstat(file, ...args);
  try { assert.throws(() => readProjectDirection({ root }), { code: "SESSION_PATH_ESCAPE" }); }
  finally { fs.lstatSync = lstat; }
  assert.equal(fs.readFileSync(trace, "utf8"), "{}");
});

// Protocol responses are synthetic in-memory events, not OS/provider calls.
function capabilityFixture(_command, args) {
  const key = args.join(" ");
  const output = key === "--version" ? "codex 1.2.3\n" : key === "--help" ? "exec\nmcp-server\napp-server\n"
    : key === "exec --help" ? "Run Codex non-interactively\n--json\n--output-schema\n--color\n--sandbox\n--skip-git-repo-check\n--cd\n--ephemeral\nresume\n" : "stdio://\ngenerate-json-schema\n--listen\n";
  const child = new EventEmitter();
  Object.assign(child, { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null });
  child.kill = () => { throw new Error("No actual child exists"); };
  queueMicrotask(() => { child.stdout.emit("data", Buffer.from(output)); child.exitCode = 0; child.emit("close", 0, null); });
  return child;
}

test("real authorization builder and prepared execution fail closed for new and preexisting null/non-null bases", async (t) => {
  const { root, layout } = project(t);
  const bin = path.join(root, "fixture-bin"); fs.mkdirSync(bin);
  const marker = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(marker, "Synthetic marker; never executed");
  if (process.platform !== "win32") fs.chmodSync(marker, 0o755);
  const environment = { ...process.env, PATH: bin }; delete environment.Path; delete environment.path;
  const versionEvidence = await buildRuntimeVersionEvidence({ runtimes: ["codex"], environment, spawnImplementation: capabilityFixture });
  const protocolEvidence = await buildRuntimeProtocolEvidence({ runtimes: ["codex"], environment, versionEvidence, spawnImplementation: capabilityFixture });
  const inspected = inspectProject(root);
  const projectBinding = buildRuntimeProjectBinding({ projectId: inspected.project.projectId, headSessionId: inspected.state.sessionId,
    projectRoot: root, projectStatus: "ready", versionEvidence, protocolEvidence, storage: inspected.storage });
  const options = { root, runtime: "codex", scope: { kind: "session", request: "Read synthetic source" }, protocolEvidence, projectBinding, persist: false };
  const nullBasis = buildRuntimeInvocationAuthorization(options).authorization;
  assert.equal(Object.hasOwn(nullBasis, "currentProjectDirectionId"), false);
  const current = updateProjectDirection({ root, input: { goal: "Local only", cancelledActions: ["deploy"] } }).direction;
  const nonNullBasis = buildRuntimeInvocationAuthorization(options).authorization;
  assert.equal(nonNullBasis.currentProjectDirectionId, current.directionId);
  fs.unlinkSync(pointer(root, layout));
  readOnly(root, () => {
    assert.throws(() => buildRuntimeInvocationAuthorization(options), unavailable);
    assert.throws(() => prepareRuntimeInvocationExecution({ root, authorization: nullBasis, sessionRequest: options.scope.request }), unavailable);
    assert.throws(() => prepareRuntimeInvocationExecution({ root, authorization: nonNullBasis, sessionRequest: options.scope.request }), unavailable);
  });
  assert.equal(fs.existsSync(path.join(root, layout.directory, "runtime/execution-authorizations")), false);
});
