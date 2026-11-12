import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/session/lode-core.mjs";
import { resolveProjectStorage, assertProjectStorageUnchanged, formatForVerifiedOwner, familyFormatForOriginal, relativeProjectArtifact } from "../scripts/lib/storage/project-storage-format.mjs";
import { resolveRuntimeOperationalStateRoot } from "../scripts/lib/runtime/runtime-execution-lease.mjs";
import { workerSourcePathParts } from "../scripts/lib/worker/worker-source-basis.mjs";
import { readSessionWorkContext } from "../scripts/lib/session/session-work-context.mjs";
import { readGraphProject } from "../scripts/lib/world/discovery-index.mjs";
import { buildRepositoryScanInput, executeIncrementalRepositoryScan, inspectRepositoryScanFreshness, managedRootFilesForProject, scanRepositoryReference, validateRepositoryScanExecution } from "../scripts/lib/world/repository-scan.mjs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(import.meta.dirname, "..");
function temporary(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), "lode-storage-contract-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 20 : 0, retryDelay: 100 }));
  return root;
}
function marker(root, directory, document) {
  fs.mkdirSync(path.join(root, directory), { recursive: true });
  fs.writeFileSync(path.join(root, directory, "project.json"), typeof document === "string" ? document : JSON.stringify(document));
}

function storageSnapshot(root) {
  const entries = [];
  function walk(relative) {
    const file = path.join(root, relative), stat = fs.lstatSync(file);
    const type = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "file";
    entries.push({ path: file, relative, type, mode: stat.mode, mtimeMs: stat.mtimeMs,
      ...(type === "file" ? { bytes: fs.readFileSync(file).toString("base64") } : type === "link" ? { target: fs.readlinkSync(file) } : {}) });
    if (type === "directory") for (const name of fs.readdirSync(file).sort()) walk(path.join(relative, name));
  }
  walk(""); return entries;
}

// Setup and junction creation happen outside this boundary. Calls below must
// reject before any mkdir/effect, not create and remove data after validating it.
function withoutStorageWrites(root, action) {
  const before = storageSnapshot(root), originals = [], attempts = [];
  const inside = value => {
    const file = value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value;
    if (typeof file !== "string") return false;
    const relative = path.relative(root, path.resolve(file));
    return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const destinations = new Set(["rename", "copyFile", "cp", "link", "symlink"]);
  function guard(object, name, isOpen = false) {
    const original = object[name]; if (typeof original !== "function") return;
    originals.push([object, name, original]);
    object[name] = (...args) => {
      const flags = args[1] ?? "r";
      const writable = !isOpen || (typeof flags === "number" ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) : /[wa+]/.test(String(flags)));
      if (writable && (inside(args[0]) || destinations.has(name.replace(/Sync$/, "")) && inside(args[1]) || typeof args[0] === "number" || args[0] && typeof args[0].fd === "number")) {
        attempts.push({ method: name, source: String(args[0]), destination: destinations.has(name.replace(/Sync$/, "")) ? String(args[1]) : null });
        assert.fail(`Attempted ${name} before the storage boundary was validated`);
      }
      return original.apply(object, args);
    };
  }
  for (const name of ["writeFile", "appendFile", "mkdir", "rename", "unlink", "rm", "rmdir", "truncate", "chmod", "utimes", "copyFile", "cp", "link", "symlink", "lchown", "chown", "lutimes", "mkdtemp", "write", "writev", "ftruncate", "fchmod", "fchown", "futimes"]) {
    guard(fs, name); guard(fs, `${name}Sync`); guard(fs.promises, name);
  }
  for (const name of ["open", "openSync", "createWriteStream"]) guard(fs, name, name !== "createWriteStream");
  guard(fs.promises, "open", true); syncBuiltinESMExports();
  try { return action(); }
  finally {
    for (const [object, name, original] of originals.reverse()) object[name] = original;
    syncBuiltinESMExports(); assert.deepEqual(attempts, []); assert.deepEqual(storageSnapshot(root), before);
  }
}

function legacyOwner(root) {
  fs.mkdirSync(root, { recursive: true });
  marker(root, ".head", { schemaVersion: 1, projectRoot: root, projectId: "head-synthetic-original-owner" });
  return resolveProjectStorage(root);
}
function directoryAlias(t, alias, target) {
  try { fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP", "ENOSYS"].includes(error.code)) {
      t.skip(`Physical ${process.platform === "win32" ? "junction" : "directory symlink"} unavailable: ${error.code}: ${error.message}`); return false;
    }
    throw error;
  }
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
  return true;
}

test("normal fresh init chooses exact Lode ownership independently of public alias spelling", t => {
  const root = temporary(t);
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const owner = inspectProject(root), storage = owner.storage;
  assert.equal(owner.status, "ready");
  assert.equal(storage.dialect, "lode"); assert.equal(storage.directory, ".lode");
  assert.equal(storage.projectRoot, root); assert.equal(storage.projectId, owner.project.projectId);
  assert.match(storage.projectId, /^lode-[a-f0-9]{20}$/);
  assert.equal(storage.projectFile, path.join(root, ".lode/project.json"));
  assert.equal(fs.existsSync(path.join(root, ".lode/project.json")), true);
  assert.equal(fs.existsSync(path.join(root, ".head/project.json")), false);
  assert.equal(formatForVerifiedOwner(storage).directory, ".lode");
  assert.equal(relativeProjectArtifact(storage, "sessions", "current.json"), ".lode/sessions/current.json");
  const selected = resolveProjectStorage(root); assert.equal(assertProjectStorageUnchanged(selected), selected);
});

test("pure family selection keeps bare lode-like IDs legacy and does not discover files", () => {
  const originals = new Map();
  for (const name of ["readFileSync", "readdirSync", "lstatSync", "statSync", "existsSync", "realpathSync"]) {
    originals.set(name, fs[name]); fs[name] = () => assert.fail(`Pure format helper attempted ${name}`);
  }
  try {
    assert.equal(formatForVerifiedOwner().dialect, "head");
    assert.equal(formatForVerifiedOwner("lode-01234567890123456789").dialect, "head");
    assert.equal(formatForVerifiedOwner({ projectId: "lode-01234567890123456789" }).dialect, "head");
    assert.equal(relativeProjectArtifact({ projectId: "lode-01234567890123456789" }, "records", "original.json"), ".head/records/original.json");
    const legacy = { protocol: { name: "head-agent-core-release-observation", version: "0.1.0" }, unchanged: "Original HEAD text" };
    const canonical = { protocol: { name: "lode-agent-core-release-observation", version: "0.1.0" }, unchanged: "Original HEAD text" };
    const oldBytes = JSON.stringify(legacy), newBytes = JSON.stringify(canonical);
    assert.equal(familyFormatForOriginal("head-agent-core-release-observation", legacy).dialect, "head");
    assert.equal(familyFormatForOriginal("head-agent-core-release-observation", canonical).dialect, "lode");
    assert.equal(familyFormatForOriginal("head-agent-core-release-observation", { ...legacy, lodeSessionId: "hybrid" }), null);
    assert.equal(familyFormatForOriginal("head-agent-core-release-observation", { ...canonical, headSessionId: "hybrid" }), null);
    assert.equal(familyFormatForOriginal("head-agent-core-release-observation", { protocol: "unknown-release-family" }), null);
    assert.equal(familyFormatForOriginal("head-agent-core-release-observation", canonical, { dialect: "head", directory: ".head" }), null);
    assert.equal(JSON.stringify(legacy), oldBytes); assert.equal(JSON.stringify(canonical), newBytes);
  } finally { for (const [name, original] of originals) fs[name] = original; }
});

test("verified legacy root survives an unrelated unknown sibling without adopting or changing it", t => {
  const root = temporary(t), original = { schemaVersion: 1, projectRoot: root, projectId: "lode-accepted-legacy-id" };
  // Deliberate original-style owner fixture, not current init moved or rebranded.
  marker(root, ".head", original); marker(root, ".lode", "{unknown-sibling");
  const before = fs.readFileSync(path.join(root, ".lode/project.json"));
  const selected = resolveProjectStorage(root);
  assert.equal(selected.dialect, "head"); assert.equal(selected.directory, ".head");
  assert.equal(selected.projectId, original.projectId);
  assert.deepEqual(fs.readFileSync(path.join(root, ".lode/project.json")), before);
  const exact = fs.readFileSync(selected.projectFile); fs.appendFileSync(selected.projectFile, "\n");
  assert.throws(() => assertProjectStorageUnchanged(selected), { code: "PROJECT_IDENTITY_MISMATCH" });
  assert.deepEqual(fs.readFileSync(path.join(root, ".lode/project.json")), before);
  assert.notDeepEqual(fs.readFileSync(selected.projectFile), exact);
});

test("a brand-looking partial external document is not sufficient positive Lode ownership", t => {
  const root = temporary(t);
  marker(root, ".head", { schemaVersion: 1, projectRoot: root, projectId: "head-existing-original" });
  // No actual writer runtime/integration/role shape: prefix and generic schema
  // must not turn unrelated external data into a conflicting Project canon.
  marker(root, ".lode", { schemaVersion: 1, projectRoot: root, authority: { lode: "external-looking-text" } });
  const sibling = path.join(root, ".lode/project.json"), before = fs.readFileSync(sibling);
  const selected = resolveProjectStorage(root);
  assert.equal(selected.dialect, "head");
  assert.deepEqual(fs.readFileSync(sibling), before);
});

test("an unassessed denied sibling does not gate an independently verified legacy root", t => {
  const root = temporary(t);
  marker(root, ".head", { schemaVersion: 1, projectRoot: root, projectId: "head-original-denied-sibling" });
  marker(root, ".lode", "{unknown-sibling");
  const sibling = path.join(root, ".lode/project.json"), original = fs.readFileSync;
  const denied = Object.assign(new Error("Synthetic unassessed sibling denial."), { code: "EACCES" });
  fs.readFileSync = (file, ...args) => { if (file === sibling) throw denied; return original(file, ...args); };
  try { assert.equal(resolveProjectStorage(root).dialect, "head"); }
  finally { fs.readFileSync = original; }
  assert.equal(fs.readFileSync(sibling, "utf8"), "{unknown-sibling");
});

test("a selected original permission error remains the exact error rather than another root", t => {
  const root = temporary(t); initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const selected = resolveProjectStorage(root), original = fs.readFileSync;
  marker(root, ".head", { schemaVersion: 1, projectRoot: root, projectId: "head-other-original" });
  const denied = Object.assign(new Error("Synthetic selected original denial."), { code: "EACCES" });
  fs.readFileSync = (file, ...args) => { if (file === selected.projectFile) throw denied; return original(file, ...args); };
  try { assert.throws(() => assertProjectStorageUnchanged(selected), error => error === denied); }
  finally { fs.readFileSync = original; }
  assert.equal(fs.existsSync(selected.projectFile), true);
});

test("occupied unknown Lode target blocks only init without adoption repair or alternate HEAD init", t => {
  const root = temporary(t); marker(root, ".lode", "{external-unknown");
  const before = fs.readFileSync(path.join(root, ".lode/project.json"));
  assert.throws(() => initializeProject({ root, pluginRoot, runtimes: ["codex"] }), { code: "MANAGED_COLLISION" });
  assert.deepEqual(fs.readFileSync(path.join(root, ".lode/project.json")), before);
  assert.equal(fs.existsSync(path.join(root, ".head")), false);
  // Independent ordinary source work remains possible after this local refusal.
  fs.writeFileSync(path.join(root, "ordinary.mjs"), "export const allowed = true;\n");
  assert.equal(fs.readFileSync(path.join(root, "ordinary.mjs"), "utf8"), "export const allowed = true;\n");
});

test("two owned roots conflict and selected original errors do not fall back", t => {
  const root = temporary(t); initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const selected = resolveProjectStorage(root);
  marker(root, ".head", { schemaVersion: 1, projectRoot: root, projectId: selected.projectId });
  assert.throws(() => resolveProjectStorage(root), { code: "PROJECT_STORAGE_CONFLICT" });
  fs.unlinkSync(selected.projectFile);
  assert.throws(() => assertProjectStorageUnchanged(selected), { code: "ENOENT" });
  assert.equal(fs.existsSync(path.join(root, ".head/project.json")), true);
});

for (const [name, corrupt] of [["invalid createdAt", project => { project.createdAt = "not-a-date"; }],
  ["empty runtimes", project => { project.runtimes = []; }]]) {
  test(`recognized actual Lode marker with ${name} cannot fall back to a valid legacy sibling`, t => {
    const root = temporary(t); initializeProject({ root, pluginRoot, runtimes: ["codex"] });
    const selected = resolveProjectStorage(root), original = JSON.parse(fs.readFileSync(selected.projectFile));
    marker(root, ".head", { schemaVersion: 1, projectRoot: root, projectId: "head-valid-existing-sibling" });
    const legacyBytes = fs.readFileSync(path.join(root, ".head/project.json"));
    corrupt(original); fs.writeFileSync(selected.projectFile, JSON.stringify(original));
    const corruptedBytes = fs.readFileSync(selected.projectFile);
    withoutStorageWrites(root, () => assert.throws(() => resolveProjectStorage(root), error => {
      assert.equal(error.constructor, Error); assert.equal(error.code, "INVALID_CANON");
      assert.equal(error.message, "Recognized Lode Project canon is malformed."); return true;
    }));
    assert.deepEqual(fs.readFileSync(path.join(root, ".head/project.json")), legacyBytes);
    assert.deepEqual(fs.readFileSync(selected.projectFile), corruptedBytes);
  });
}

test("trusted old new and combined operational aliases share one physical path without creation", t => {
  const base = temporary(t), root = path.join(base, "project"); fs.mkdirSync(root);
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  const physicalParent = path.join(base, "host-local"), physical = path.join(physicalParent, "state"), alias = path.join(base, "host-alias");
  fs.mkdirSync(physical, { recursive: true });
  if (!directoryAlias(t, alias, physicalParent)) return;
  const aliasState = path.join(alias, "state"), expected = fs.realpathSync(physical);
  withoutStorageWrites(base, () => {
    for (const environment of [{ HEAD_AGENT_OPERATIONAL_STATE_ROOT: physical }, { LODE_AGENT_OPERATIONAL_STATE_ROOT: aliasState },
      { HEAD_AGENT_OPERATIONAL_STATE_ROOT: physical, LODE_AGENT_OPERATIONAL_STATE_ROOT: aliasState }]) {
      assert.equal(resolveRuntimeOperationalStateRoot({ projectRoot: root, storage, environment, create: false }), expected);
    }
  });
  const oldAbsent = path.join(base, "absent-old-domain"), newAbsent = path.join(base, "absent-new-domain");
  withoutStorageWrites(base, () => assert.throws(() => resolveRuntimeOperationalStateRoot({ projectRoot: root, storage,
    environment: { HEAD_AGENT_OPERATIONAL_STATE_ROOT: oldAbsent, LODE_AGENT_OPERATIONAL_STATE_ROOT: newAbsent }, create: true }), error => {
    assert.equal(error.constructor, Error); assert.equal(error.code, "RUNTIME_OPERATIONAL_STATE_ROOT_CONFLICT");
    assert.equal(error.message, "Runtime operational state aliases refer to different host-local roots."); return true;
  }));
  assert.equal(fs.existsSync(oldAbsent), false); assert.equal(fs.existsSync(newAbsent), false);
});

test("single and default operational roots cannot mkdir through an existing junction ancestor into either Project family", t => {
  const base = temporary(t), canonicalRoot = path.join(base, "canonical-project"), headRoot = path.join(base, "legacy-project");
  fs.mkdirSync(canonicalRoot); initializeProject({ root: canonicalRoot, pluginRoot, runtimes: ["codex"] });
  const owners = [inspectProject(canonicalRoot).storage, legacyOwner(headRoot)];
  for (const owner of owners) {
    const alias = path.join(base, `into-${owner.dialect}`);
    if (!directoryAlias(t, alias, owner.projectRoot)) return;
    const absent = path.join(alias, "must-not-be-created");
    const cases = [
      { name: "old override", environment: { HEAD_AGENT_OPERATIONAL_STATE_ROOT: absent } },
      { name: "new override", environment: { LODE_AGENT_OPERATIONAL_STATE_ROOT: absent } },
      { name: "Windows default", environment: { LOCALAPPDATA: alias }, platform: "win32" },
      { name: "POSIX state default", environment: { XDG_STATE_HOME: alias }, platform: "linux" },
      { name: "POSIX home default", environment: {}, platform: "linux", homeDirectory: alias },
    ];
    for (const scenario of cases) {
      const { name, ...options } = scenario;
      withoutStorageWrites(base, () => assert.throws(() => resolveRuntimeOperationalStateRoot({ projectRoot: owner.projectRoot,
        storage: owner, create: true, ...options }), error => {
        assert.equal(error.constructor, Error); assert.equal(error.code, "UNSAFE_RUNTIME_OPERATIONAL_STATE_ROOT", `${owner.dialect}: ${name}`);
        assert.equal(error.message, "Runtime operational state root must be a dedicated host-local directory outside the project tree."); return true;
      }));
    }
    assert.equal(fs.existsSync(path.join(owner.projectRoot, "must-not-be-created")), false);
    assert.equal(fs.existsSync(path.join(owner.projectRoot, `${owner.dialect === "lode" ? "lode" : "head"}-agent-core`)), false);
    assert.equal(fs.existsSync(path.join(owner.projectRoot, ".local")), false);
  }
});

test("worker source parts reject only the exact owned Lode root before effects while preserving foreign and nested source", t => {
  const base = temporary(t), root = path.join(base, "canonical"); fs.mkdirSync(root);
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage, old = legacyOwner(path.join(base, "legacy"));
  withoutStorageWrites(base, () => {
    assert.throws(() => workerSourcePathParts(".lode/project.json", storage), error => {
      assert.equal(error.constructor, Error); assert.equal(error.code, "INVALID_WORKER_SOURCE_BASIS");
      assert.equal(error.message, "Worker source path escapes the selected source boundary."); return true;
    });
    assert.deepEqual(workerSourcePathParts(".lode/source.mjs", old), [".lode", "source.mjs"]);
    assert.deepEqual(workerSourcePathParts(".lode/source.mjs"), [".lode", "source.mjs"]);
    assert.deepEqual(workerSourcePathParts("src/.lode/source.mjs", storage), ["src", ".lode", "source.mjs"]);
    // Original .head/.git exclusions and error envelopes remain unchanged.
    for (const owner of [undefined, old, storage]) for (const value of [".head/project.json", "src/.head/source.mjs", ".git/config"]) {
      assert.throws(() => workerSourcePathParts(value, owner), { code: "INVALID_WORKER_SOURCE_BASIS", message: "Worker source path escapes the selected source boundary." });
    }
    if (process.platform === "win32") {
      assert.throws(() => workerSourcePathParts(".LODE/project.json", storage), { code: "INVALID_WORKER_SOURCE_BASIS", message: "Worker source path escapes the selected source boundary." });
    }
  });
  if (process.platform === "win32") t.diagnostic("Windows case-insensitive owned-root protection exercised; POSIX distinct-case coverage is a separate platform-scoped case.");
});

test("POSIX distinct-case .LODE source is not silently treated as the owned .lode directory", {
  skip: process.platform === "win32" ? "POSIX case-sensitive path semantics are not applicable on Windows; Windows owned-root case folding is checked separately." : false,
}, t => {
  const root = temporary(t); initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  withoutStorageWrites(root, () => assert.deepEqual(workerSourcePathParts(".LODE/source.mjs", storage), [".LODE", "source.mjs"]));
  t.diagnostic("POSIX exact-root semantics preserve the differently cased source name; no filesystem case-sensitivity assumption is used to grant managed authority.");
});

for (const relativeTarget of ["roles/coder.md", "generated/manifest.json"]) {
  for (const existingEmptyStorage of [false, true]) {
    test(`partial init before ${relativeTarget} publication restores ${existingEmptyStorage ? "preexisting empty" : "new"} storage and foreign source`, t => {
      const root = temporary(t), storageRoot = path.join(root, ".lode");
      // This sibling is ordinary foreign source, not an original Project owner.
      fs.mkdirSync(path.join(root, ".head", "source"), { recursive: true });
      fs.writeFileSync(path.join(root, ".head", "source", "foreign.mjs"), "export const foreignSource = 'untouched';\n");
      fs.writeFileSync(path.join(root, "AGENTS.md"), "# Existing project instructions\n\nKeep this user-owned file unchanged.\n");
      fs.writeFileSync(path.join(root, "ordinary.mjs"), "export const ordinarySource = true;\n");
      if (existingEmptyStorage) fs.mkdirSync(storageRoot);
      assert.equal(fs.existsSync(path.join(root, ".head", "project.json")), false);
      assert.equal(resolveProjectStorage(root), null);
      const before = storageSnapshot(root), target = path.join(storageRoot, ...relativeTarget.split("/"));
      const sentinel = { code: "SYNTHETIC_INIT_PREPUBLICATION_FAILURE", message: `Stop before ${relativeTarget} atomic publication.` };
      const originalRename = fs.renameSync, attempts = [];
      let caught;
      fs.renameSync = (source, destination, ...args) => {
        if (destination === target) {
          attempts.push({ source, destination });
          assert.equal(path.isAbsolute(source), true);
          assert.equal(path.isAbsolute(destination), true);
          assert.equal(path.dirname(source), path.dirname(target));
          const basename = path.basename(target);
          assert.equal(path.basename(source).startsWith(`.${basename}.`), true);
          const suffix = path.basename(source).slice(basename.length + 2);
          assert.match(suffix, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/);
          assert.equal(fs.lstatSync(source).isFile(), true);
          assert.equal(fs.lstatSync(source).isSymbolicLink(), false);
          assert.equal(fs.existsSync(target), false);
          throw sentinel; // Before the original publication: no effect is replayed.
        }
        return originalRename(source, destination, ...args);
      };
      syncBuiltinESMExports();
      try { initializeProject({ root, pluginRoot, runtimes: ["codex"] }); }
      catch (error) { caught = error; }
      finally { fs.renameSync = originalRename; syncBuiltinESMExports(); }

      assert.equal(caught, sentinel);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].destination, target);
      assert.equal(fs.existsSync(attempts[0].source), false);
      const after = storageSnapshot(root);
      // mkdir/unlink changes parent-directory mtimes, not their ownership or
      // contents. Keep those raw times visible; require every path/type/mode
      // and file byte/mtime to match, with no temporary or partial artifacts.
      const durableSnapshot = entries => entries.map(entry => {
        if (entry.type !== "directory") return entry;
        const { mtimeMs, ...durable } = entry; return durable;
      });
      assert.deepEqual(durableSnapshot(after), durableSnapshot(before));
      assert.equal(fs.existsSync(storageRoot), existingEmptyStorage);
      if (existingEmptyStorage) assert.deepEqual(fs.readdirSync(storageRoot), []);
      assert.equal(resolveProjectStorage(root), null);
      t.diagnostic(JSON.stringify({ event: "synthetic-init-prepublication-rollback", relativeTarget, existingEmptyStorage,
        attempts, rawDirectoryTimesBefore: before.filter(entry => entry.type === "directory").map(({ path, mtimeMs }) => ({ path, mtimeMs })),
        rawDirectoryTimesAfter: after.filter(entry => entry.type === "directory").map(({ path, mtimeMs }) => ({ path, mtimeMs })) }));
    });
  }
}

test("two owned Project markers conflict before selected legacy Session validation and preserve original errors after selection", t => {
  const validSessionId = "session-11111111-1111-4111-8111-111111111111";
  const malformedSession = "{malformed-session";
  let malformedError;
  try { JSON.parse(malformedSession); } catch (error) { malformedError = error; }
  for (const state of ["valid", "malformed JSON", "invalid Session identity", "EACCES"]) {
    const root = temporary(t); initializeProject({ root, pluginRoot, runtimes: ["codex"] });
    marker(root, ".head", { schemaVersion: 1, projectRoot: root, projectId: "head-synthetic-conflict-owner" });
    const sessionFile = path.join(root, ".head", "sessions", "current.json");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, state === "malformed JSON" ? malformedSession
      : JSON.stringify({ schemaVersion: 1, sessionId: state === "invalid Session identity" ? "not-a-session" : validSessionId }));
    const denied = Object.assign(new Error("Synthetic selected legacy Session denial."), { code: "EACCES" });
    const originalRead = fs.readFileSync;
    let sessionReads = 0, callbackCalls = 0;
    const watchSession = () => {
      fs.readFileSync = (file, ...args) => {
        if (file === sessionFile) { sessionReads += 1; if (state === "EACCES") throw denied; }
        return originalRead(file, ...args);
      };
      syncBuiltinESMExports();
    };
    withoutStorageWrites(root, () => {
      watchSession();
      try {
        const conflict = error => {
          assert.equal(error.constructor, Error); assert.equal(error.code, "PROJECT_STORAGE_CONFLICT");
          assert.equal(error.message, "Two owned Project storage roots conflict."); return true;
        };
        assert.throws(() => resolveProjectStorage(root, { readLegacyProject() { callbackCalls += 1; assert.fail("Owned-marker conflict reached legacy validation"); } }), conflict);
        assert.throws(() => readSessionWorkContext({ root, evidenceIds: [] }), conflict);
        assert.equal(sessionReads, 0); assert.equal(callbackCalls, 0);
      } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); }
    });

    // A now-unrecognized sibling cannot replace the selected legacy reader's
    // original Session parse/identity/permission result with a fallback.
    marker(root, ".lode", { unrelatedExternalDocument: true });
    withoutStorageWrites(root, () => {
      watchSession();
      try {
        assert.equal(resolveProjectStorage(root).dialect, "head");
        if (state === "valid") {
          const result = readSessionWorkContext({ root, evidenceIds: [] });
          assert.equal(result.projectId, "head-synthetic-conflict-owner"); assert.equal(result.sessionId, validSessionId);
          assert.deepEqual(result.records, []);
        } else {
          assert.throws(() => readSessionWorkContext({ root, evidenceIds: [] }), error => {
            if (state === "EACCES") assert.equal(error, denied);
            else if (state === "malformed JSON") {
              assert.equal(error.constructor, SyntaxError); assert.equal(error.code, malformedError.code);
              assert.equal(error.message, malformedError.message);
            } else {
              assert.equal(error.constructor, Error); assert.equal(error.code, "SESSION_IDENTITY_MISMATCH");
              assert.equal(error.message, "Work evidence Project/Session identity differs.");
            }
            return true;
          });
        }
        assert.ok(sessionReads > 0);
      } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); }
    });
  }
});

test("unknown malformed or denied unrecognized legacy markers do not gate a verified Lode reader or touch legacy Session", t => {
  for (const state of ["unknown", "malformed JSON", "EACCES"]) {
    const root = temporary(t); initializeProject({ root, pluginRoot, runtimes: ["codex"] });
    const canonical = inspectProject(root);
    marker(root, ".head", state === "malformed JSON" ? "{unrecognized-legacy" : { unrelatedExternalDocument: true });
    const markerFile = path.join(root, ".head", "project.json"), sessionFile = path.join(root, ".head", "sessions", "current.json");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true }); fs.writeFileSync(sessionFile, "{must-not-be-read");
    const denied = Object.assign(new Error("Synthetic unrecognized legacy marker denial."), { code: "EACCES" });
    const originalRead = fs.readFileSync;
    let sessionReads = 0;
    withoutStorageWrites(root, () => {
      fs.readFileSync = (file, ...args) => {
        if (file === sessionFile) { sessionReads += 1; assert.fail("Unrecognized legacy sibling reached Session validation"); }
        if (file === markerFile && state === "EACCES") throw denied;
        return originalRead(file, ...args);
      };
      syncBuiltinESMExports();
      try {
        assert.equal(resolveProjectStorage(root).dialect, "lode");
        const result = readSessionWorkContext({ root, evidenceIds: [] });
        assert.equal(result.projectId, canonical.project.projectId); assert.equal(result.sessionId, canonical.state.sessionId);
        assert.deepEqual(result.records, []); assert.equal(sessionReads, 0);
      } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); }
    });
  }
});

test("an unselected foreign legacy directory junction cannot gate the owned Lode graph or Session reader", t => {
  const base = temporary(t), root = path.join(base, "canonical"), foreign = path.join(base, "foreign");
  fs.mkdirSync(root); initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const canonical = inspectProject(root);
  fs.mkdirSync(path.join(foreign, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(foreign, "project.json"), JSON.stringify({ schemaVersion: 1,
    projectRoot: foreign, projectId: "head-22222222222222222222" }));
  fs.writeFileSync(path.join(foreign, "sessions", "current.json"), "{foreign-session-must-not-be-read");
  fs.writeFileSync(path.join(foreign, "source.mjs"), "export const unselectedForeignSource = true;\n");
  if (!directoryAlias(t, path.join(root, ".head"), foreign)) return;
  const foreignBefore = storageSnapshot(foreign), originalRead = fs.readFileSync;
  let legacySessionReads = 0;
  withoutStorageWrites(base, () => {
    fs.readFileSync = (file, ...args) => {
      if (file === path.join(root, ".head", "sessions", "current.json") || file === path.join(foreign, "sessions", "current.json")) {
        legacySessionReads += 1; assert.fail("Unselected foreign junction reached Session validation");
      }
      return originalRead(file, ...args);
    };
    syncBuiltinESMExports();
    try {
      const graphOwner = readGraphProject(root);
      assert.equal(graphOwner.projectRoot, root); assert.deepEqual(graphOwner.storage, canonical.storage);
      assert.equal(graphOwner.project.projectId, canonical.project.projectId);
      const context = readSessionWorkContext({ root, evidenceIds: [] });
      assert.equal(context.projectId, canonical.project.projectId); assert.equal(context.sessionId, canonical.state.sessionId);
      assert.deepEqual(context.records, []); assert.equal(legacySessionReads, 0);
    } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); }
  });
  assert.deepEqual(storageSnapshot(foreign), foreignBefore);
});

test("Windows owned management case alias keeps full incremental and freshness coverage aligned", {
  skip: process.platform !== "win32" ? "Windows case-alias identity; distinct filesystem case is tested separately." : false,
}, async t => {
  const root = temporary(t); initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  fs.mkdirSync(path.join(root, "src", ".LODE"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "main.mjs"), "export const ordinarySource = true;\n");
  fs.writeFileSync(path.join(root, "src", ".LODE", "nested.mjs"), "export const nestedSource = true;\n");
  const intermediate = path.join(root, "renaming-owned-storage");
  fs.renameSync(path.join(root, ".lode"), intermediate);
  fs.renameSync(intermediate, path.join(root, ".LODE"));
  let logical;
  try { logical = fs.lstatSync(path.join(root, ".lode"), { bigint: true }); }
  catch (error) {
    if (error.code === "ENOENT") { t.skip("Actual Windows fixture directory is case-sensitive; distinct-case preservation has its own case."); return; }
    throw error;
  }
  const physical = fs.lstatSync(path.join(root, ".LODE"), { bigint: true });
  assert.notEqual(logical.ino, 0n); assert.notEqual(logical.dev, 0n);
  assert.equal(physical.ino, logical.ino); assert.equal(physical.dev, logical.dev);
  assert.equal(fs.readdirSync(root).includes(".LODE"), true);
  const inspected = inspectProject(root), storage = inspected.storage;
  assert.equal(inspected.status, "ready");
  const managedRootFiles = managedRootFilesForProject(inspected.project, storage);
  const options = { projectRoot: root, storage, managedRootFiles };
  const input = buildRepositoryScanInput(options), baseline = scanRepositoryReference(input);
  assert.equal(baseline.files.some(file => file.path.startsWith(".LODE/")), false);
  assert.equal(baseline.files.some(file => file.path === "src/.LODE/nested.mjs"), true);
  const legacy = scanRepositoryReference(buildRepositoryScanInput({ projectRoot: root, managedRootFiles: [".lode"] }));
  assert.equal(legacy.files.some(file => file.path.startsWith(".LODE/")), true);
  const withoutToken = scanRepositoryReference(buildRepositoryScanInput({ ...options, managedRootFiles: managedRootFiles.filter(file => file !== ".lode") }));
  assert.equal(withoutToken.files.some(file => file.path.startsWith(".LODE/")), true);
  fs.writeFileSync(path.join(root, ".LODE", "synthetic-metadata.json"), '{"metadataOnly":true}\n');
  const freshness = inspectRepositoryScanFreshness({ ...options, storedFiles: baseline.files });
  assert.equal(freshness.status, "unchanged"); assert.deepEqual(freshness.changes, { added: [], changed: [], removed: [] });
  const { files, skipped, ...repositoryScan } = baseline;
  const incremental = await executeIncrementalRepositoryScan({ ...options, previousSnapshot: { files, skipped, repositoryScan } });
  validateRepositoryScanExecution(incremental, options);
  assert.deepEqual(incremental.request.input, input);
  assert.deepEqual(incremental.result, baseline);
  assert.equal(incremental.diagnostics.reusedFileCount, baseline.summary.fileCount);
  assert.equal(incremental.diagnostics.analyzedFileCount, 0);
  fs.writeFileSync(path.join(root, "src", "main.mjs"), "export const ordinarySource = false;\n");
  assert.deepEqual(inspectRepositoryScanFreshness({ ...options, storedFiles: baseline.files }).changes,
    { added: [], changed: ["src/main.mjs"], removed: [] });
  assert.notEqual(scanRepositoryReference(input).scanHash, baseline.scanHash);
});

test("a distinct physical root case variant remains source on POSIX or case-sensitive Windows", t => {
  const root = temporary(t); initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  try { fs.mkdirSync(path.join(root, ".LODE")); }
  catch (error) {
    if (error.code === "EEXIST") { t.skip("This filesystem cannot represent distinct .lode and .LODE directories."); return; }
    throw error;
  }
  fs.writeFileSync(path.join(root, ".LODE", "foreign.mjs"), "export const differentPhysicalDirectory = true;\n");
  const inspected = inspectProject(root), options = { projectRoot: root, storage: inspected.storage,
    managedRootFiles: managedRootFilesForProject(inspected.project, inspected.storage) };
  const scan = scanRepositoryReference(buildRepositoryScanInput(options));
  assert.equal(scan.files.some(file => file.path === ".LODE/foreign.mjs"), true);
  assert.equal(scan.files.some(file => file.path.startsWith(".lode/")), false);
  fs.writeFileSync(path.join(root, ".LODE", "foreign.mjs"), "export const differentPhysicalDirectory = false;\n");
  assert.deepEqual(inspectRepositoryScanFreshness({ ...options, storedFiles: scan.files }).changes,
    { added: [], changed: [".LODE/foreign.mjs"], removed: [] });
});

test("Windows owned case-alias identity permission errors retain their exact cause", {
  skip: process.platform !== "win32" ? "Only Windows case variants require an additional physical identity lookup." : false,
}, t => {
  const root = temporary(t); initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const intermediate = path.join(root, "renaming-owned-storage");
  fs.renameSync(path.join(root, ".lode"), intermediate); fs.renameSync(intermediate, path.join(root, ".LODE"));
  if (!fs.existsSync(path.join(root, ".lode"))) { t.skip("This Windows fixture directory is case-sensitive."); return; }
  const inspected = inspectProject(root), options = { projectRoot: root, storage: inspected.storage,
    managedRootFiles: managedRootFilesForProject(inspected.project, inspected.storage) };
  const input = buildRepositoryScanInput(options), original = fs.lstatSync;
  const denied = Object.assign(new Error("Synthetic selected management directory identity denial."), { code: "EACCES" });
  fs.lstatSync = (file, ...args) => {
    if (file === path.join(root, ".lode")) throw denied;
    return original(file, ...args);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => scanRepositoryReference(input), error => error === denied);
    assert.throws(() => inspectRepositoryScanFreshness({ ...options, storedFiles: [] }), error => error === denied);
  } finally { fs.lstatSync = original; syncBuiltinESMExports(); }
});

test("recognized actual Lode namespace with missing or malformed canon fields cannot fall back to a valid legacy sibling", t => {
  const corruptions = [
    ["missing createdAt", project => { delete project.createdAt; }],
    ["missing runtimes", project => { delete project.runtimes; }],
    ["missing integrations", project => { delete project.integrations; }],
    ["null integrations", project => { project.integrations = null; }],
    ["array integrations", project => { project.integrations = []; }],
  ];
  for (const [name, corrupt] of corruptions) {
    const root = temporary(t); initializeProject({ root, pluginRoot, runtimes: ["codex"] });
    const projectFile = path.join(root, ".lode", "project.json"), validBytes = fs.readFileSync(projectFile);
    const project = JSON.parse(validBytes);
    marker(root, ".head", { schemaVersion: 1, projectRoot: root, projectId: "head-33333333333333333333" });
    fs.mkdirSync(path.join(root, ".head", "sessions"), { recursive: true });
    fs.writeFileSync(path.join(root, ".head", "sessions", "current.json"), JSON.stringify({ schemaVersion: 1,
      sessionId: "session-33333333-3333-4333-8333-333333333333" }));
    corrupt(project); fs.writeFileSync(projectFile, JSON.stringify(project));
    withoutStorageWrites(root, () => {
      const invalid = error => {
        assert.equal(error.constructor, Error, name); assert.equal(error.code, "INVALID_CANON", name);
        assert.equal(error.message, "Recognized Lode Project canon is malformed.", name); return true;
      };
      assert.throws(() => resolveProjectStorage(root), invalid);
      assert.throws(() => readSessionWorkContext({ root, evidenceIds: [] }), invalid);
    });
    fs.writeFileSync(projectFile, validBytes);
    withoutStorageWrites(root, () => {
      const conflict = error => {
        assert.equal(error.constructor, Error, name); assert.equal(error.code, "PROJECT_STORAGE_CONFLICT", name);
        assert.equal(error.message, "Two owned Project storage roots conflict.", name); return true;
      };
      assert.throws(() => resolveProjectStorage(root), conflict);
      assert.throws(() => readSessionWorkContext({ root, evidenceIds: [] }), conflict);
    });
  }
});

test("a bare Lode-like Project identity without the namespace authority fingerprint remains a foreign document", t => {
  const root = temporary(t); initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const projectFile = path.join(root, ".lode", "project.json"), actual = JSON.parse(fs.readFileSync(projectFile));
  fs.writeFileSync(projectFile, JSON.stringify({ schemaVersion: 1, projectRoot: root, projectId: actual.projectId }));
  marker(root, ".head", { schemaVersion: 1, projectRoot: root, projectId: "head-44444444444444444444" });
  fs.mkdirSync(path.join(root, ".head", "sessions"), { recursive: true });
  const sessionId = "session-44444444-4444-4444-8444-444444444444";
  fs.writeFileSync(path.join(root, ".head", "sessions", "current.json"), JSON.stringify({ schemaVersion: 1, sessionId }));
  withoutStorageWrites(root, () => {
    assert.equal(resolveProjectStorage(root).dialect, "head");
    const context = readSessionWorkContext({ root, evidenceIds: [] });
    assert.equal(context.projectId, "head-44444444444444444444"); assert.equal(context.sessionId, sessionId);
    assert.deepEqual(context.records, []);
  });
});
