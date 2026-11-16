import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/session/lode-core.mjs";
import { buildWorldModel, readWorldModel, readWorldModelSnapshot } from "../scripts/lib/world/world-model.mjs";
import { refreshWorldModel } from "../scripts/lib/world/incremental-refresh.mjs";
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
  const extracted = spawnSync("tar", ["-xf", archive, "-C", tree], { encoding: "utf8" });
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
      // Read 1 checks the canon hash. Reads 2–3 are the one non-persisted child preview.
      // The persisting build starts at read 4, so this write stays out of the preview pair.
      if (canonReads === 3) {
        const model = JSON.parse(originalCanon);
        model.featureGroups = [{ key: "editing", name: "Editing", description: "Edit the document.", parentFeatureGroupKeys: [] }];
        fs.writeFileSync(canon, `${JSON.stringify(model, null, 2)}\n`);
      }
    }
    return result;
  };
  try {
    await assert.rejects(refreshWorldModel({ root: f.root }), { code: "REFRESH_PERSISTENCE_MISMATCH" });
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
