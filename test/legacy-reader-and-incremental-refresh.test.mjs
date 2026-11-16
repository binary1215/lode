import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/session/lode-core.mjs";
import { buildWorldModel, readWorldModel, readWorldModelSnapshot, refreshReaderIdentity } from "../scripts/lib/world/world-model.mjs";
import { createHeadSession, withSessionRoute } from "../scripts/lib/session/session-routing.mjs";
import { NoExternalRuntimeStateAdapter } from "../scripts/lib/runtime/runtime-state.mjs";
import { refreshWorldModel } from "../scripts/lib/world/incremental-refresh.mjs";
import {
  fileIdentity,
  refreshInputStamp,
  rememberFileStat,
  timestampSettled,
  writeRefreshInputGeneration,
} from "../scripts/lib/world/refresh-input-generation.mjs";
import { applySnapshotGarbageCollection, inspectSnapshotGarbageCollection } from "../scripts/lib/world/snapshot-gc.mjs";
import { graphProjectionCanonicalJson } from "../scripts/lib/world/graph-projection-adapter.mjs";
import { sha256Hex } from "../scripts/lib/core/digest.mjs";
import { formatProjectStatus } from "../scripts/lib/session/cli-presentation.mjs";
import { inspectProjectExperience } from "../scripts/lib/session/project-bootstrap.mjs";
import { LocalJsonWorldModelStoreAdapter } from "../scripts/lib/world/world-model-store.mjs";
import { LocalJsonGraphProjectionAdapter } from "../scripts/lib/world/graph-projection-adapter.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");

function treeBytes(directory) {
  if (!fs.existsSync(directory)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) total += treeBytes(file);
    else if (entry.isFile()) total += fs.statSync(file).size;
  }
  return total;
}

function snapshotBytes(root, storage) {
  return ["world-model/snapshots", "graph-projection/snapshots", "snapshot-bundles"].reduce(
    (sum, relative) => sum + treeBytes(path.join(root, storage.directory, relative)),
    0,
  );
}

function project(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-한글 café it's (v2)-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["codex", "claude", "opencode"] });
  const storage = inspectProject(root).storage;
  const sourceDir = path.join(root, "docs", "한글 문서");
  fs.mkdirSync(sourceDir, { recursive: true });
  const source = path.join(sourceDir, "it's (v2).py");
  fs.writeFileSync(source, "def kept_value():\n    return 'café'\n");
  fs.writeFileSync(path.join(root, "other.py"), "def other_value():\n    return 1\n");
  return { root, storage, source };
}

function beta80Pointer(file, idField) {
  const pointer = JSON.parse(fs.readFileSync(file, "utf8"));
  delete pointer.readerRequirements.minimumReader;
  delete pointer.readerRequirements.writer;
  if (pointer.kind === "GraphProjectionPointer") {
    delete pointer.pointerId;
    delete pointer.pointerHash;
    const pointerHash = sha256Hex(graphProjectionCanonicalJson(pointer));
    pointer.pointerId = `graph-projection-pointer-${pointerHash.slice(0, 24)}`;
    pointer.pointerHash = pointerHash;
  }
  assert.equal(Object.hasOwn(pointer.readerRequirements, "minimumReader"), false);
  assert.equal(pointer.readerRequirements.snapshotId, pointer[idField]);
  fs.writeFileSync(file, JSON.stringify(pointer));
  return pointer;
}

test("beta.80 reader declarations upgrade in place and keep snapshot bytes", async (t) => {
  const f = project(t);
  const built = await buildWorldModel({ root: f.root });
  const sourceBytes = fs.readFileSync(f.source);
  const worldPointer = path.join(f.root, f.storage.directory, "world-model/current.json");
  const graphPointer = path.join(f.root, f.storage.directory, "graph-projection/current.json");
  const worldSnapshot = fs.readFileSync(built.file);
  beta80Pointer(worldPointer, "worldModelId");
  beta80Pointer(graphPointer, "graphSnapshotId");
  const refreshed = await refreshWorldModel({ root: f.root });
  assert.equal(refreshed.status, "unchanged");
  const world = JSON.parse(fs.readFileSync(worldPointer, "utf8"));
  const graph = JSON.parse(fs.readFileSync(graphPointer, "utf8"));
  assert.equal(world.readerRequirements.minimumReader, "0.3.0-beta.75");
  assert.equal(world.readerRequirements.writer, JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8")).version);
  assert.equal(graph.readerRequirements.minimumReader, "0.3.0-beta.75");
  // The World pointer names the Graph pointer id it has now (G6).
  assert.equal(world.sourceAdapters.graphProjection.pointerId, graph.pointerId);
  assert.equal(world.worldModelId, built.snapshot.worldModelId);
  assert.equal(world.worldModelHash, built.snapshot.worldModelHash);
  assert.equal(graph.graphSnapshotId, built.snapshot.temporalProvenanceGraph.graphSnapshotId);
  assert.equal(graph.graphSnapshotHash, built.snapshot.temporalProvenanceGraph.graphSnapshotHash);
  assert.equal(fs.readFileSync(built.file).equals(worldSnapshot), true);
  assert.equal(fs.readFileSync(f.source).equals(sourceBytes), true);
  const loaded = await readWorldModel({ root: f.root });
  assert.equal(loaded.snapshot.worldModelId, built.snapshot.worldModelId);
  const gc = await applySnapshotGarbageCollection({ root: f.root });
  assert.notEqual(gc.code, "STORAGE_VERSION_MISMATCH");
  assert.equal((await readWorldModel({ root: f.root })).snapshot.worldModelHash, built.snapshot.worldModelHash);
});

test("a newer minimum reader is a downgrade mismatch with a recovery, not corruption", async (t) => {
  const f = project(t);
  await buildWorldModel({ root: f.root });
  const worldPointer = path.join(f.root, f.storage.directory, "world-model/current.json");
  const pointer = JSON.parse(fs.readFileSync(worldPointer, "utf8"));
  pointer.readerRequirements.minimumReader = "9.9.9";
  fs.writeFileSync(worldPointer, JSON.stringify(pointer));
  const status = await inspectProjectExperience({ root: f.root });
  const layer = status.readiness.storage.layers[0];
  assert.equal(layer.reasonCode, "STORAGE_VERSION_MISMATCH");
  assert.match(layer.message, /9\.9\.9/);
  assert.match(layer.message, /not corrupted storage/);
  assert.match(layer.message, /downgrade/);
  assert.match(layer.message, /world-index/);
  assert.doesNotMatch(layer.message, /a newer reader or newer/);
  assert.match(formatProjectStatus(status), /world-index/);
  assert.match(formatProjectStatus(status), /not corrupted storage/);
  const before = fs.readFileSync(worldPointer);
  const gc = await applySnapshotGarbageCollection({ root: f.root });
  assert.equal(gc.code, "STORAGE_VERSION_MISMATCH");
  assert.match(gc.message, /world-index/);
  assert.equal(gc.reclaimedBytes, 0);
  assert.equal(fs.readFileSync(worldPointer).equals(before), true);
});

test("noop refresh does not grow snapshots and unchanged relation ids survive a one-file edit", async (t) => {
  const f = project(t);
  const first = await buildWorldModel({ root: f.root });
  const unchangedEdge = first.snapshot.temporalProvenanceGraph.edges.find((edge) => {
    const from = first.snapshot.temporalProvenanceGraph.nodes.find((node) => node.nodeId === edge.from);
    const to = first.snapshot.temporalProvenanceGraph.nodes.find((node) => node.nodeId === edge.to);
    return from?.path === "other.py" && to?.path === "other.py";
  });
  assert.ok(unchangedEdge);
  fs.writeFileSync(f.source, "def kept_value():\n    return 'café changed'\n");
  const changed = await refreshWorldModel({ root: f.root });
  assert.equal(changed.status, "refreshed");
  const next = await readWorldModel({ root: f.root });
  assert.ok(next.snapshot.temporalProvenanceGraph.edges.some((edge) => edge.edgeId === unchangedEdge.edgeId));
  const keptSource = next.snapshot.files.find((file) => file.path.endsWith("it's (v2).py"));
  assert.equal(keptSource.digest, sha256Hex(fs.readFileSync(f.source)));
  const before = snapshotBytes(f.root, f.storage);
  const ids = fs.readdirSync(path.join(f.root, f.storage.directory, "world-model/snapshots")).sort();
  const noop = await refreshWorldModel({ root: f.root });
  assert.equal(noop.status, "unchanged");
  assert.equal(noop.diagnostics.repositoryScan.analyzedFileCount, 0);
  const again = await refreshWorldModel({ root: f.root });
  assert.equal(again.status, "unchanged");
  assert.equal(snapshotBytes(f.root, f.storage), before);
  assert.deepEqual(fs.readdirSync(path.join(f.root, f.storage.directory, "world-model/snapshots")).sort(), ids);
  assert.equal((await readWorldModel({ root: f.root })).snapshot.worldModelId, next.snapshot.worldModelId);
});

test("GC reclaims an unreachable chunked snapshot and keeps the reachable world", async (t) => {
  const f = project(t);
  const current = await buildWorldModel({ root: f.root });
  const source = fs.readFileSync(f.source);
  fs.writeFileSync(f.source, "def orphan_value():\n    return 'it's (v2)'\n");
  const orphan = await buildWorldModel({ root: f.root, persist: false });
  const world = new LocalJsonWorldModelStoreAdapter({ projectRoot: f.root, storage: f.storage, snapshotLayout: "chunked-code-v3" });
  const graph = new LocalJsonGraphProjectionAdapter({ projectRoot: f.root, storage: f.storage, snapshotLayout: "chunked-code-v3" });
  const written = await world.writeSnapshot(orphan.snapshot.worldModelId, orphan.snapshot);
  await graph.writeSnapshot(orphan.snapshot.temporalProvenanceGraph.graphSnapshotId, orphan.snapshot.temporalProvenanceGraph);
  fs.writeFileSync(f.source, source);
  const before = fs.statSync(written.location).size;
  const result = await applySnapshotGarbageCollection({ root: f.root });
  assert.equal(result.status, "gc_applied", JSON.stringify({ code: result.code, issues: result.coverage?.issues }));
  assert.equal(result.reclaimedBytes >= before, true);
  assert.equal(fs.existsSync(written.location), false);
  const loaded = await readWorldModel({ root: f.root });
  assert.equal(loaded.snapshot.worldModelId, current.snapshot.worldModelId);
  assert.equal(loaded.snapshot.worldModelHash, current.snapshot.worldModelHash);
  assert.equal(fs.readFileSync(f.source).equals(source), true);
});

test("a save between the scan read and publication is refreshed on the next refresh", async (t) => {
  const f = project(t);
  const target = path.join(f.root, "a.py");
  fs.writeFileSync(target, "def value():\n    return 1\n");
  await buildWorldModel({ root: f.root });
  fs.writeFileSync(target, "def value():\n    return 2\n");
  const original = fs.readFileSync;
  let writes = 0;
  fs.readFileSync = function (file, ...args) {
    const result = original.call(fs, file, ...args);
    if (writes < 4 && path.resolve(String(file)) === target) {
      writes += 1;
      fs.writeFileSync(target, `def value():\n    return ${10 + writes}\n`);
    }
    return result;
  };
  let first;
  try {
    first = await refreshWorldModel({ root: f.root });
  } finally {
    fs.readFileSync = original;
  }
  assert.equal(writes > 0, true);
  assert.equal(first.status, "refreshed");
  const stale = await readWorldModel({ root: f.root });
  const indexed = stale.snapshot.files.find((file) => file.path === "a.py");
  assert.notEqual(indexed.digest, sha256Hex(fs.readFileSync(target)));
  const second = await refreshWorldModel({ root: f.root });
  assert.equal(second.status, "refreshed");
  const current = await readWorldModel({ root: f.root });
  assert.equal(current.snapshot.files.find((file) => file.path === "a.py").digest, sha256Hex(fs.readFileSync(target)));
  const third = await refreshWorldModel({ root: f.root });
  assert.equal(third.status, "unchanged");
});

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Lode Test",
      GIT_AUTHOR_EMAIL: "lode@example.com",
      GIT_COMMITTER_NAME: "Lode Test",
      GIT_COMMITTER_EMAIL: "lode@example.com",
    },
  });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
}

test("an empty commit in a linked worktree refreshes", async (t) => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-한글 café it's (v2)-repo-")));
  const worktree = path.join(parent, "side it's (v2)");
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  git(parent, ["init"]);
  fs.writeFileSync(path.join(parent, "README.md"), "root\n");
  git(parent, ["add", "README.md"]);
  git(parent, ["commit", "-m", "init"]);
  git(parent, ["worktree", "add", "-b", "side", worktree]);
  initializeProject({ root: worktree, pluginRoot, runtimes: ["codex", "claude", "opencode"] });
  fs.writeFileSync(path.join(worktree, "a.py"), "def value():\n    return 1\n");
  await buildWorldModel({ root: worktree });
  const settled = await refreshWorldModel({ root: worktree });
  assert.equal(settled.status, "unchanged");
  git(worktree, ["commit", "--allow-empty", "-m", "empty"]);
  const committed = await refreshWorldModel({ root: worktree });
  assert.equal(committed.status, "refreshed");
});

test("a store written by beta.80 commit 6d9f6be stays readable and keeps its snapshot bytes", async (t) => {
  const pack = fs.mkdtempSync(path.join(os.tmpdir(), "beta80-src-"));
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "beta80-proj-")));
  t.after(() => {
    fs.rmSync(pack, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
  const archive = path.join(pack, "beta80.tar");
  const tree = path.join(pack, "tree");
  fs.mkdirSync(tree);
  // Pull-request checkouts are shallow. GitHub will not serve this historical
  // commit as a remote ref, but it is an ancestor of this branch, so deepening
  // the existing history is enough. Fetching main covers a detached merge checkout.
  const commitPresent = () => spawnSync("git", ["cat-file", "-e", "6d9f6be^{commit}"], { cwd: pluginRoot, encoding: "utf8" }).status === 0;
  if (!commitPresent()) {
    const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    spawnSync("git", ["fetch", "--deepen=500", "origin"], { cwd: pluginRoot, encoding: "utf8", env: gitEnv });
    if (!commitPresent()) {
      const main = spawnSync("git", ["fetch", "--depth=500", "origin", "main"], { cwd: pluginRoot, encoding: "utf8", env: gitEnv });
      assert.equal(main.status, 0, main.stderr || main.stdout);
      assert.equal(commitPresent(), true, "beta.80 commit 6d9f6be is not in the deepened history");
    }
  }
  const archived = spawnSync("git", ["archive", "--format=tar", "-o", archive, "6d9f6be"], { cwd: pluginRoot, encoding: "utf8" });
  assert.equal(archived.status, 0, archived.stderr);
  // Relative names from inside the folder: GNU tar reads a drive letter ("C:") as a remote host.
  const extracted = spawnSync("tar", ["-xf", path.basename(archive), "-C", path.basename(tree)], { cwd: pack, encoding: "utf8" });
  assert.equal(extracted.status, 0, extracted.stderr);
  fs.writeFileSync(path.join(projectRoot, "module.py"), "def compute_value():\n    return 'beta80'\n");
  const init = spawnSync(process.execPath, ["scripts/lode.mjs", "init", projectRoot, "--runtime", "codex", "--runtime", "claude", "--runtime", "opencode"], {
    cwd: tree,
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const indexed = spawnSync(process.execPath, ["scripts/lode.mjs", "world-index", projectRoot], { cwd: tree, encoding: "utf8" });
  assert.equal(indexed.status, 0, indexed.stderr || indexed.stdout);
  const source = fs.readFileSync(path.join(projectRoot, "module.py"));
  const pointerFile = path.join(projectRoot, ".lode", "world-model", "current.json");
  const graphFile = path.join(projectRoot, ".lode", "graph-projection", "current.json");
  const pointer = JSON.parse(fs.readFileSync(pointerFile, "utf8"));
  const graphPointer = JSON.parse(fs.readFileSync(graphFile, "utf8"));
  const snapshotFile = path.join(projectRoot, ".lode", "world-model", "snapshots", `${pointer.worldModelId}.json.gz`);
  const snapshotBytes = fs.readFileSync(snapshotFile);
  const snapshotNames = (relative) => fs.readdirSync(path.join(projectRoot, ".lode", relative)).sort();
  const worldSnapshots = snapshotNames("world-model/snapshots");
  const graphSnapshots = snapshotNames("graph-projection/snapshots");
  assert.equal(pointer.readerRequirements.layout, "chunked-code-v3");
  assert.equal(Object.hasOwn(pointer.readerRequirements, "minimumReader"), false);
  assert.equal(Object.hasOwn(pointer.readerRequirements, "writer"), false);
  const loaded = await readWorldModel({ root: projectRoot });
  assert.equal(loaded.snapshot.worldModelId, pointer.worldModelId);
  assert.equal(loaded.snapshot.files.find((file) => file.path === "module.py").digest, sha256Hex(source));
  const dryRun = inspectSnapshotGarbageCollection({ root: projectRoot });
  assert.equal(
    dryRun.coverage.issues.some((issue) => issue.reasonCode === "RETAINED_SNAPSHOT_REFERENCE_UNAVAILABLE"),
    false,
  );
  assert.equal(dryRun.applyAvailable, true);
  assert.match(dryRun.nextAction, /storage-gc --apply/);
  const refreshed = await refreshWorldModel({ root: projectRoot });
  assert.equal(refreshed.status, "unchanged");
  assert.equal(fs.readFileSync(snapshotFile).equals(snapshotBytes), true);
  assert.equal(fs.readFileSync(path.join(projectRoot, "module.py")).equals(source), true);
  const upgraded = JSON.parse(fs.readFileSync(pointerFile, "utf8"));
  const upgradedGraph = JSON.parse(fs.readFileSync(graphFile, "utf8"));
  assert.equal(upgraded.worldModelId, pointer.worldModelId);
  assert.equal(upgraded.worldModelHash, pointer.worldModelHash);
  assert.equal(upgradedGraph.graphSnapshotId, graphPointer.graphSnapshotId);
  assert.equal(upgradedGraph.graphSnapshotHash, graphPointer.graphSnapshotHash);
  assert.equal(upgraded.readerRequirements.minimumReader, "0.3.0-beta.75");
  // The graph pointer id covers its reader requirements; the world pointer must name the id it has now.
  // Where the store's World pointer names a Graph pointer, it names the current one; where it names none, it still names none.
  assert.equal(
    upgraded.sourceAdapters?.graphProjection?.pointerId ?? null,
    pointer.sourceAdapters?.graphProjection?.pointerId ? upgradedGraph.pointerId : null,
  );
  assert.deepEqual(snapshotNames("world-model/snapshots"), worldSnapshots);
  assert.deepEqual(snapshotNames("graph-projection/snapshots"), graphSnapshots);
  const original = await readWorldModelSnapshot({ root: projectRoot, worldModelId: pointer.worldModelId });
  assert.equal(original.snapshot.worldModelId, pointer.worldModelId);
  assert.equal(original.snapshot.worldModelHash, pointer.worldModelHash);
  assert.equal(original.snapshot.files.find((file) => file.path === "module.py").digest, sha256Hex(source));
  const applied = await applySnapshotGarbageCollection({ root: projectRoot });
  assert.equal(applied.status, "gc_applied");
  assert.equal(applied.applyPerformed, false);
  assert.match(applied.nextAction, /Typed closure certified/);
  assert.equal(JSON.parse(fs.readFileSync(pointerFile, "utf8")).worldModelId, pointer.worldModelId);
});

test("a persisted world that differs from the refresh preview is not left published", async (t) => {
  const f = project(t);
  fs.writeFileSync(path.join(f.root, "a.py"), "def value():\n    return 1\n");
  const built = await buildWorldModel({ root: f.root });
  fs.writeFileSync(path.join(f.root, "a.py"), "def value():\n    return 2\n");
  const canon = path.join(f.root, f.storage.directory, "context", "product-model.json");
  const originalCanon = fs.readFileSync(canon, "utf8");
  const originalRead = fs.readFileSync;
  let canonReads = 0;
  fs.readFileSync = function (file, ...args) {
    const result = originalRead.call(fs, file, ...args);
    if (path.resolve(String(file)) === canon) {
      canonReads += 1;
      // Reads 1–4 are the two non-persisted previews. The persisting build starts at read 5.
      if (canonReads === 4) {
        const model = JSON.parse(originalCanon);
        model.featureGroups = [{ key: "editing", name: "Editing", description: "Edit the document.", parentFeatureGroupKeys: [] }];
        fs.writeFileSync(canon, `${JSON.stringify(model, null, 2)}\n`);
      }
    }
    return result;
  };
  try {
    // Refused by the persisting build before any pointer moves.
    await assert.rejects(refreshWorldModel({ root: f.root }), { code: "REFRESH_PREVIEW_DRIFT" });
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(canonReads >= 2, true);
  const current = await readWorldModel({ root: f.root });
  assert.equal(current.snapshot.worldModelId, built.snapshot.worldModelId);
  assert.equal(current.snapshot.worldModelHash, built.snapshot.worldModelHash);
  const graph = JSON.parse(fs.readFileSync(path.join(f.root, f.storage.directory, "graph-projection", "current.json"), "utf8"));
  assert.equal(graph.graphSnapshotId, built.snapshot.temporalProvenanceGraph.graphSnapshotId);
  assert.equal(graph.graphSnapshotHash, built.snapshot.temporalProvenanceGraph.graphSnapshotHash);
});

test("gc dry-run and apply agree when snapshot backends are present", async (t) => {
  const f = project(t);
  fs.writeFileSync(path.join(f.root, "a.py"), "def value():\n    return 1\n");
  const built = await buildWorldModel({ root: f.root });
  const dryRun = inspectSnapshotGarbageCollection({ root: f.root });
  assert.equal(
    dryRun.coverage.issues.some((issue) => issue.reasonCode === "RETAINED_SNAPSHOT_REFERENCE_UNAVAILABLE"),
    false,
  );
  assert.equal(dryRun.applyAvailable, true);
  assert.match(dryRun.nextAction, /storage-gc --apply/);
  const applied = await applySnapshotGarbageCollection({ root: f.root });
  assert.equal(applied.status, "gc_applied");
  assert.equal(applied.applyAvailable, true);
  assert.match(applied.nextAction, /Typed closure certified/);
  const current = await readWorldModel({ root: f.root });
  assert.equal(current.snapshot.worldModelId, built.snapshot.worldModelId);
  assert.equal(current.snapshot.worldModelHash, built.snapshot.worldModelHash);
});

const mode = (result) => result.diagnostics.repositoryScan.executionMode;

test("the fast path answers a second unchanged refresh, and a record saved while a refresh builds is not stamped as known", async (t) => {
  const f = project(t);
  await buildWorldModel({ root: f.root });
  // Directly after a build, the next refresh is answered from the fast path.
  const afterBuild = await refreshWorldModel({ root: f.root });
  assert.equal(afterBuild.status, "unchanged");
  assert.equal(mode(afterBuild), "stat-cache-unchanged");
  const fast = await refreshWorldModel({ root: f.root });
  assert.equal(fast.status, "unchanged");
  assert.equal(mode(fast), "stat-cache-unchanged");
  // Directly after a refresh that published a new World, too.
  fs.writeFileSync(f.source, "def kept_value():\n    return 'first edit'\n");
  assert.equal((await refreshWorldModel({ root: f.root })).status, "refreshed");
  const afterRefreshed = await refreshWorldModel({ root: f.root });
  assert.equal(afterRefreshed.status, "unchanged");
  assert.equal(mode(afterRefreshed), "stat-cache-unchanged");

  // An edit, and while that refresh is building, something else writes into the project store.
  fs.writeFileSync(f.source, "def kept_value():\n    return 'edited'\n");
  const arrived = path.join(f.root, f.storage.directory, "context", "arrived-while-building.json");
  const originalRead = fs.readFileSync;
  let written = false;
  fs.readFileSync = function (file, ...args) {
    const result = originalRead.call(fs, file, ...args);
    if (!written && path.resolve(String(file)) === f.source) {
      written = true;
      fs.mkdirSync(path.dirname(arrived), { recursive: true });
      fs.writeFileSync(arrived, "{}\n");
    }
    return result;
  };
  let refreshed;
  try {
    refreshed = await refreshWorldModel({ root: f.root });
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(written, true);
  assert.equal(refreshed.status, "refreshed");

  // The stamp was taken before the build read anything, so the file that arrived is news to it.
  const afterArrival = await refreshWorldModel({ root: f.root });
  assert.notEqual(mode(afterArrival), "stat-cache-unchanged");
  assert.equal(afterArrival.status, "unchanged", "the arrived file is not a World input; only the stamp made this refresh full");
  // That full refresh found nothing changed and renewed the generation.
  const settled = await refreshWorldModel({ root: f.root });
  assert.equal(settled.status, "unchanged");
  assert.equal(mode(settled), "stat-cache-unchanged");
});

test("a generation written by another reader version is not answered from the fast path", async (t) => {
  const f = project(t);
  await buildWorldModel({ root: f.root });
  await refreshWorldModel({ root: f.root });
  assert.equal(mode(await refreshWorldModel({ root: f.root })), "stat-cache-unchanged");
  const generationFile = path.join(f.root, f.storage.directory, "refresh", "input-generation.json");
  const generation = JSON.parse(fs.readFileSync(generationFile, "utf8"));
  assert.equal(typeof generation.reader, "string");
  fs.writeFileSync(generationFile, JSON.stringify({ ...generation, reader: "0".repeat(64) }));
  const other = await refreshWorldModel({ root: f.root });
  assert.equal(other.status, "unchanged");
  assert.notEqual(mode(other), "stat-cache-unchanged");
  const without = { ...generation };
  delete without.reader;
  fs.writeFileSync(generationFile, JSON.stringify(without));
  assert.notEqual(mode(await refreshWorldModel({ root: f.root })), "stat-cache-unchanged");
});

test("a commit made after the stamp was taken is not unchanged", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-stamp (v2)-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ["init"]);
  fs.writeFileSync(path.join(root, "a.py"), "def value():\n    return 1\n");
  git(root, ["add", "a.py"]);
  git(root, ["commit", "-m", "init"]);
  initializeProject({ root, pluginRoot, runtimes: ["codex", "claude", "opencode"] });
  const built = await buildWorldModel({ root });
  const storage = inspectProject(root).storage;
  // What a build holds: the stamp from before it read anything. The commit lands while it builds.
  const takenBeforeTheBuild = refreshInputStamp(root, storage);
  git(root, ["commit", "--allow-empty", "-m", "made while the build was running"]);
  assert.notEqual(takenBeforeTheBuild, refreshInputStamp(root, storage));
  assert.equal(writeRefreshInputGeneration({ root, storage, snapshot: built.snapshot }), null);
  // Control: the same generation with a stamp taken after the commit is answered from the fast path.
  writeRefreshInputGeneration({ root, storage, snapshot: built.snapshot, stamp: refreshInputStamp(root, storage), reader: refreshReaderIdentity() });
  const generationFile = path.join(root, storage.directory, "refresh", "input-generation.json");
  const control = JSON.parse(fs.readFileSync(generationFile, "utf8"));
  writeRefreshInputGeneration({ root, storage, snapshot: built.snapshot, stamp: takenBeforeTheBuild, reader: refreshReaderIdentity() });
  const real = JSON.parse(fs.readFileSync(generationFile, "utf8"));
  assert.deepEqual({ ...real, stamp: null, snapshotStore: null }, { ...control, stamp: null, snapshotStore: null }, "only the stamp differs");
  assert.notEqual(real.stamp, control.stamp);
  const next = await refreshWorldModel({ root });
  assert.notEqual(mode(next), "stat-cache-unchanged");
  assert.equal(next.status, "refreshed");
});

test("storage GC reads a pointer written before minimumReader without rewriting it, and a leftover watcher probe is not in its way", async (t) => {
  const f = project(t);
  const built = await buildWorldModel({ root: f.root });
  const worldPointer = path.join(f.root, f.storage.directory, "world-model/current.json");
  const graphPointer = path.join(f.root, f.storage.directory, "graph-projection/current.json");
  beta80Pointer(worldPointer, "worldModelId");
  beta80Pointer(graphPointer, "graphSnapshotId");
  const before = [fs.readFileSync(worldPointer), fs.readFileSync(graphPointer)];
  const probe = path.join(f.root, f.storage.directory, "refresh", ".watch-arm-4242-left");
  fs.mkdirSync(path.dirname(probe), { recursive: true });
  fs.writeFileSync(probe, "arm\n");
  const applied = await applySnapshotGarbageCollection({ root: f.root });
  assert.notEqual(applied.code, "STORAGE_VERSION_MISMATCH");
  // It reached the inventory, not an early return.
  assert.equal(applied.code, undefined, JSON.stringify({ code: applied.code, status: applied.status }));
  assert.equal(typeof applied.coverage?.referenceValidity, "string");
  assert.equal(JSON.stringify(applied).includes("UNSUPPORTED_GC_REFERENCE_ROOT"), false);
  assert.equal(fs.readFileSync(worldPointer).equals(before[0]), true);
  assert.equal(fs.readFileSync(graphPointer).equals(before[1]), true);
  assert.equal((await readWorldModel({ root: f.root })).snapshot.worldModelHash, built.snapshot.worldModelHash);
});

test("a whole-second modification time is not trusted inside its own tick", (t) => {
  const now = 1_800_000_000;
  const at = (seconds, extraNs = 0n) => ({ mtimeNs: String(BigInt(seconds) * 1_000_000_000n + extraNs) });
  assert.equal(timestampSettled(at(now), now * 1000), false);
  assert.equal(timestampSettled(at(now - 1), now * 1000), false);
  assert.equal(timestampSettled(at(now - 2), now * 1000), true);
  assert.equal(timestampSettled(at(now, 5n), now * 1000), true);
  assert.equal(timestampSettled({ mtimeNs: "not a number" }, now * 1000), false);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lode-tick-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "a.txt");
  fs.writeFileSync(file, "one\n");
  const digest = sha256Hex(fs.readFileSync(file));
  const seconds = Math.floor(Date.now() / 1000);
  fs.utimesSync(file, seconds, seconds);
  let before = fileIdentity(file);
  if (BigInt(before.mtimeNs) % 1_000_000_000n !== 0n) {
    t.diagnostic("this filesystem did not keep the whole-second time; the file half of the test is skipped");
    return;
  }
  const cache = new Map([["a.txt", { digest }]]);
  assert.equal(rememberFileStat(cache, "a.txt", file, digest, 4, before), null);
  assert.equal(cache.has("a.txt"), false);
  fs.utimesSync(file, seconds - 10, seconds - 10);
  before = fileIdentity(file);
  assert.equal(rememberFileStat(cache, "a.txt", file, digest, 4, before)?.digest, digest);
});

// ---------- PR 81 review: F1, F2, F4, F6 ----------

// An unchanged project after a build and one full unchanged refresh: the next
// refresh is answered from the fast path.
async function fastReady(t) {
  const f = project(t);
  await buildWorldModel({ root: f.root });
  await refreshWorldModel({ root: f.root });
  assert.equal(mode(await refreshWorldModel({ root: f.root })), "stat-cache-unchanged");
  return f;
}

test("F6: a caller that brings its own history, runtime state or scan result is never answered from the fast path", async (t) => {
  const f = await fastReady(t);
  for (const name of ["gitHistoryAdapter", "runtimeStateAdapter", "repositoryScanExecution"]) {
    let consulted = 0;
    // Any use of the caller's source counts; the full path is the only one that uses it.
    const source = new Proxy(
      {},
      {
        get() {
          consulted += 1;
          throw Object.assign(new Error("caller source read"), { code: "CALLER_SOURCE_READ" });
        },
      },
    );
    let answer = null;
    try {
      answer = await refreshWorldModel({ root: f.root, [name]: source });
    } catch {
      answer = null;
    }
    assert(answer === null || mode(answer) !== "stat-cache-unchanged", name);
    // A refresh takes no scan result from its caller; the fast path still declines one.
    if (name !== "repositoryScanExecution") assert(consulted > 0, `${name} was read, so the full path ran`);
  }
  assert.equal(mode(await refreshWorldModel({ root: f.root })), "stat-cache-unchanged", "and without it the fast path still answers");
});

test("F6: a commit that lands while a real refresh builds is seen by the next refresh", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-build-commit-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ["init"]);
  fs.writeFileSync(path.join(root, "a.py"), "def value():\n    return 1\n");
  git(root, ["add", "a.py"]);
  git(root, ["commit", "-m", "init"]);
  initializeProject({ root, pluginRoot, runtimes: ["codex", "claude", "opencode"] });
  await buildWorldModel({ root });
  fs.writeFileSync(path.join(root, "a.py"), "def value():\n    return 2\n");
  const source = path.join(root, "a.py");
  const originalRead = fs.readFileSync;
  let committed = false;
  fs.readFileSync = function (file, ...args) {
    const result = originalRead.call(fs, file, ...args);
    if (!committed && path.resolve(String(file)) === source) {
      committed = true;
      git(root, ["commit", "--allow-empty", "-m", "made while the refresh was building"]);
    }
    return result;
  };
  let refreshed;
  try {
    refreshed = await refreshWorldModel({ root });
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(committed, true);
  assert.equal(refreshed.status, "refreshed");
  const next = await refreshWorldModel({ root });
  assert.notEqual(mode(next), "stat-cache-unchanged", "the stamp was taken before the commit");
  // The full path compares the git head the World holds with the head now.
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  assert.equal((await readWorldModel({ root })).snapshot.git?.commit, head);
});

test("F2: a new link, unsupported file or over-size file is not answered with the old skipped counters", async (t) => {
  const f = await fastReady(t);
  const cases = [
    ["unsupported", () => fs.writeFileSync(path.join(f.root, "image.bin"), Buffer.from([0, 1, 2, 3]))],
    ["over-size", () => fs.writeFileSync(path.join(f.root, "huge.py"), "#".repeat(512 * 1024 + 1))],
  ];
  try {
    fs.symlinkSync(path.join(f.root, "other.py"), path.join(f.root, "link.py"));
    fs.rmSync(path.join(f.root, "link.py"));
    cases.push(["link", () => fs.symlinkSync(path.join(f.root, "other.py"), path.join(f.root, "link.py"))]);
  } catch {
    t.diagnostic("links cannot be created here; the link case is not run");
  }
  for (const [name, make] of cases) {
    make();
    const after = await refreshWorldModel({ root: f.root });
    assert.notEqual(mode(after), "stat-cache-unchanged", name);
    assert.equal(after.status, "refreshed", `${name}: the skipped counters are part of the World`);
    assert.equal(mode(await refreshWorldModel({ root: f.root })), "stat-cache-unchanged", `${name}: settled again`);
  }
});

test("F1: a current snapshot that is gone is reported as missing, not answered unchanged", async (t) => {
  const f = await fastReady(t);
  const current = await readWorldModel({ root: f.root });
  assert(current.file, "a whole-file snapshot in this store");
  fs.rmSync(current.file);
  await assert.rejects(refreshWorldModel({ root: f.root }), { code: "WORLD_MODEL_SNAPSHOT_MISSING" });
});

test("F4: a dry run reports a retained World that is neither a file nor a git ref, even with a typed backend present", async (t) => {
  const f = project(t);
  const first = await buildWorldModel({ root: f.root });
  fs.writeFileSync(f.source, "def kept_value():\n    return 'second'\n");
  await refreshWorldModel({ root: f.root });
  const backends = ["snapshot-bundles", "snapshot-objects.git"].filter((name) => fs.existsSync(path.join(f.root, f.storage.directory, name)));
  if (!backends.length) fs.mkdirSync(path.join(f.root, f.storage.directory, "snapshot-bundles"));
  const location = (await readWorldModelSnapshot({ root: f.root, worldModelId: first.snapshot.worldModelId })).file;
  assert(location, "the earlier World is a whole file here");
  const healthy = inspectSnapshotGarbageCollection({ root: f.root });
  assert(!healthy.coverage.issues.some((issue) => issue.reasonCode === "RETAINED_SNAPSHOT_REFERENCE_UNAVAILABLE"));
  fs.rmSync(location);
  const dryRun = inspectSnapshotGarbageCollection({ root: f.root });
  assert(
    dryRun.coverage.issues.some((issue) => issue.reasonCode === "RETAINED_SNAPSHOT_REFERENCE_UNAVAILABLE" && issue.path === first.snapshot.worldModelId),
    JSON.stringify(dryRun.coverage.issues),
  );
  assert.equal(dryRun.applyAvailable, false);
});

// ---------- PR 81 second review: G1, G2, G6, G7 ----------

test("G1: a direct build holds the Session state as it was when the stamp was taken, not from before it", async (t) => {
  const f = project(t);
  const stateFile = path.join(f.root, f.storage.directory, "sessions", "current.json");
  const before = fs.readFileSync(stateFile);
  const other = createHeadSession({ root: f.root, purpose: "The Session selected while the build starts" });
  // The same state with the other Session selected.
  const after = Buffer.from(JSON.stringify({ ...JSON.parse(before), sessionId: other.sessionId }));
  assert.notEqual(other.sessionId, JSON.parse(before).sessionId);
  fs.writeFileSync(stateFile, before);
  // The selection changes after the build first read the project and before it
  // walks the store for its stamp.
  const store = path.resolve(f.root, f.storage.directory);
  const originalDir = fs.readdirSync;
  let switched = false;
  fs.readdirSync = function (directory, ...args) {
    if (!switched && path.resolve(String(directory)) === store) {
      switched = true;
      fs.writeFileSync(stateFile, after);
    }
    return originalDir.call(fs, directory, ...args);
  };
  let built;
  try {
    built = await buildWorldModel({ root: f.root });
  } finally {
    fs.readdirSync = originalDir;
  }
  assert.equal(switched, true);
  // The stamp saw the new selection, so the World must hold it too.
  assert.equal(built.snapshot.runtimeState.sessionId, JSON.parse(after).sessionId);
});

test("G2: a build given a source the stamp cannot see writes no generation; the next full unchanged refresh renews it", async (t) => {
  const f = project(t);
  const generationFile = path.join(f.root, f.storage.directory, "refresh", "input-generation.json");
  // A caller-supplied runtime-state source (what world-index --runtime-state passes).
  await buildWorldModel({ root: f.root, runtimeStateAdapter: new NoExternalRuntimeStateAdapter() });
  assert.equal(fs.existsSync(generationFile), false, "no generation after a build with a caller adapter");
  assert.notEqual(mode(await refreshWorldModel({ root: f.root })), "stat-cache-unchanged");
  await buildWorldModel({ root: f.root });
  assert.equal(fs.existsSync(generationFile), true, "a plain build writes one");
});

test("G7: a refresh routed to another Session is not answered from the generation of the first", async (t) => {
  const f = project(t);
  await buildWorldModel({ root: f.root });
  assert.equal(mode(await refreshWorldModel({ root: f.root })), "stat-cache-unchanged");
  const other = createHeadSession({ root: f.root, purpose: "Another Session" });
  // Creating a Session writes into the store; settle the default route first.
  await refreshWorldModel({ root: f.root });
  assert.equal(mode(await refreshWorldModel({ root: f.root })), "stat-cache-unchanged");
  const routed = await withSessionRoute(f.root, other.sessionId, () => refreshWorldModel({ root: f.root }));
  assert.notEqual(mode(routed), "stat-cache-unchanged");
});

test("G6: a World pointer whose Graph link names an older Graph pointer id is repaired by the next refresh", async (t) => {
  const f = project(t);
  await buildWorldModel({ root: f.root });
  const worldFile = path.join(f.root, f.storage.directory, "world-model/current.json");
  const graphFile = path.join(f.root, f.storage.directory, "graph-projection/current.json");
  const graph = JSON.parse(fs.readFileSync(graphFile, "utf8"));
  const world = JSON.parse(fs.readFileSync(worldFile, "utf8"));
  assert.equal(world.sourceAdapters.graphProjection.pointerId, graph.pointerId);
  // A Graph pointer upgraded in an earlier run; the World pointer still names its old id.
  const stale = {
    ...world,
    sourceAdapters: {
      ...world.sourceAdapters,
      graphProjection: { ...world.sourceAdapters.graphProjection, pointerId: "graph-projection-pointer-" + "0".repeat(24) },
    },
  };
  fs.writeFileSync(worldFile, JSON.stringify(stale));
  const refreshed = await refreshWorldModel({ root: f.root });
  assert.notEqual(mode(refreshed), "stat-cache-unchanged", "the fast path leaves a stale link to the full path");
  const repaired = JSON.parse(fs.readFileSync(worldFile, "utf8"));
  assert.equal(repaired.sourceAdapters.graphProjection.pointerId, graph.pointerId);
  assert.equal(repaired.worldModelId, world.worldModelId);
  assert.equal(repaired.worldModelHash, world.worldModelHash);
});
