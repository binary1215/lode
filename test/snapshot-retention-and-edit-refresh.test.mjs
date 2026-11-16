import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/session/lode-core.mjs";
import { compileContext } from "../scripts/lib/session/context-compiler.mjs";
import {
  buildWorldModel,
  deriveIncrementalRevisionParents,
  predictIncrementalRevisionParents,
  readWorldModel,
  readWorldModelSnapshot,
} from "../scripts/lib/world/world-model.mjs";
import { refreshWorldModel } from "../scripts/lib/world/incremental-refresh.mjs";
import { applySnapshotGarbageCollection, inspectSnapshotGarbageCollection } from "../scripts/lib/world/snapshot-gc.mjs";
import { diffGraphLineage } from "../scripts/lib/world/graph-lineage.mjs";
import { readProductModelCanon } from "../scripts/lib/world/product-model.mjs";
import { sha256Hex } from "../scripts/lib/core/digest.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

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

function snapshotNames(root, storage) {
  const names = [];
  for (const relative of ["world-model/snapshots", "graph-projection/snapshots"]) {
    const directory = path.join(root, storage.directory, relative);
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) names.push(relative + "/" + name);
  }
  return names.sort();
}

function project(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-한글 café it's (v2)-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["codex", "claude", "opencode"] });
  const storage = inspectProject(root).storage;
  const sourceDir = path.join(root, "docs", "한글 문서");
  fs.mkdirSync(path.join(sourceDir, "café (v2)"), { recursive: true });
  const source = path.join(sourceDir, "it's (v2).py");
  fs.writeFileSync(source, "def kept_value():\n    return 'café'\n");
  fs.writeFileSync(path.join(sourceDir, "café (v2)", "naïve file.py"), "def naive_value():\n    return 1\n");
  fs.writeFileSync(path.join(root, "other.py"), "def other_value():\n    return 1\n");
  return { root, storage, source };
}

test("retention drops unpinned refresh history and keeps a decision diff", async (t) => {
  const f = project(t);
  const first = await buildWorldModel({ root: f.root });
  const capsule = await compileContext({ root: f.root, task: "Explain kept_value", budget: 32768, persist: true });
  assert.equal(capsule.status, "compiled");
  const otherBefore = fs.readFileSync(path.join(f.root, "other.py"));
  fs.writeFileSync(f.source, "def kept_value():\n    return 'café revised'\n");
  const middle = await refreshWorldModel({ root: f.root });
  assert.equal(middle.status, "refreshed");
  fs.writeFileSync(f.source, "def kept_value():\n    return 'café current'\n");
  const current = await refreshWorldModel({ root: f.root });
  assert.equal(current.status, "refreshed");
  const beforeBytes = treeBytes(path.join(f.root, f.storage.directory));
  const dry = inspectSnapshotGarbageCollection({ root: f.root, retention: { keepCount: 1, keepDays: 0 } });
  assert.equal(dry.status, "gc_dry_run");
  assert.equal(dry.deletedCount, 0);
  assert.ok(dry.reclaimableBytes > 0);
  assert.ok(dry.snapshots.some((row) => row.id === middle.worldModel.worldModelId && row.disposition === "reclaim"));
  assert.ok(dry.snapshots.some((row) => row.id === first.snapshot.worldModelId && row.disposition === "retain"));
  assert.deepEqual(snapshotNames(f.root, f.storage), snapshotNames(f.root, f.storage));
  const namesBefore = snapshotNames(f.root, f.storage);
  const applied = await applySnapshotGarbageCollection({ root: f.root, retention: { keepCount: 1, keepDays: 0 } });
  assert.equal(applied.status, "gc_applied", JSON.stringify({ code: applied.code, issues: applied.coverage?.issues?.slice(0, 8) }));
  assert.ok(applied.reclaimedBytes > 0);
  assert.ok(treeBytes(path.join(f.root, f.storage.directory)) < beforeBytes);
  assert.equal(
    fs.existsSync(path.join(f.root, f.storage.directory, "world-model/snapshots", middle.worldModel.worldModelId + ".json.gz")) ||
      fs.existsSync(path.join(f.root, f.storage.directory, "world-model/snapshots", middle.worldModel.worldModelId + ".json")),
    false,
  );
  const loaded = await readWorldModel({ root: f.root });
  assert.equal(loaded.snapshot.worldModelId, current.worldModel.worldModelId);
  const pinned = await readWorldModelSnapshot({ root: f.root, worldModelId: first.snapshot.worldModelId });
  assert.equal(pinned.snapshot.worldModelHash, first.snapshot.worldModelHash);
  const difference = await diffGraphLineage({ root: f.root, fromWorldModelId: first.snapshot.worldModelId, toWorldModelId: current.worldModel.worldModelId });
  assert.ok(difference.changes);
  const fileDigest = (snapshot) => snapshot.files.find((file) => file.path === "other.py").digest;
  assert.equal(fileDigest(pinned.snapshot), fileDigest(loaded.snapshot));
  assert.equal(fs.readFileSync(path.join(f.root, "other.py")).equals(otherBefore), true);
  assert.ok(snapshotNames(f.root, f.storage).length < namesBefore.length);
});

test("predicted revision parents match the candidate-graph derivation", async (t) => {
  const f = project(t);
  const built = await buildWorldModel({ root: f.root });
  fs.writeFileSync(f.source, "def kept_value():\n    return 'café edited'\n");
  const preview = await buildWorldModel({
    root: f.root,
    persist: false,
    parentSourceSnapshotIds: built.snapshot.temporalProvenanceGraph.parentSourceSnapshotIds,
    revisionParentIds: built.snapshot.temporalProvenanceGraph.revisionParentIds,
    filterRevisionParentsToCurrentEntities: true,
  });
  const derived = deriveIncrementalRevisionParents({
    previousGraph: built.snapshot.temporalProvenanceGraph,
    candidateGraph: preview.snapshot.temporalProvenanceGraph,
  });
  const predicted = predictIncrementalRevisionParents({
    previousGraph: built.snapshot.temporalProvenanceGraph,
    files: preview.snapshot.files,
    productModel: readProductModelCanon({ projectRoot: f.root, storage: f.storage }).model,
  });
  assert.deepEqual(predicted, derived);
});

test("an unchanged file part is reused and a linked worktree commit is not an unchanged refresh", async (t) => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-git-")));
  const side = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-한글 café it's (v2)-")));
  t.after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(side, { recursive: true, force: true });
  });
  git(["init"], repo);
  git(["config", "user.email", "retention@example.com"], repo);
  git(["config", "user.name", "Retention Test"], repo);
  fs.writeFileSync(path.join(repo, "kept.py"), "def kept():\n    return 1\n");
  fs.writeFileSync(path.join(repo, "other.py"), "def other():\n    return 2\n");
  git(["add", "kept.py", "other.py"], repo);
  git(["commit", "-m", "init"], repo);
  git(["worktree", "add", "-b", "side", side], repo);
  initializeProject({ root: side, pluginRoot, runtimes: ["codex", "claude", "opencode"] });
  const storage = inspectProject(side).storage;
  const built = await buildWorldModel({ root: side });
  const bundles = path.join(side, storage.directory, "snapshot-bundles");
  const beforeParts = new Set(fs.readdirSync(bundles));
  fs.appendFileSync(path.join(side, "kept.py"), "\n");
  const beforeStore = treeBytes(path.join(side, storage.directory));
  const refreshed = await refreshWorldModel({ root: side });
  assert.equal(refreshed.status, "refreshed");
  const afterParts = fs.readdirSync(bundles);
  assert.ok(afterParts.some((name) => beforeParts.has(name)));
  const freshBundleBytes = afterParts.filter((name) => !beforeParts.has(name)).reduce((sum, name) => sum + fs.statSync(path.join(bundles, name)).size, 0);
  assert.ok(freshBundleBytes < beforeStore);
  let quiet = await refreshWorldModel({ root: side });
  assert.equal(quiet.status, "unchanged");
  git(["commit", "--allow-empty", "-m", "empty"], side);
  quiet = await refreshWorldModel({ root: side });
  assert.equal(quiet.status, "refreshed");
  assert.notEqual(quiet.diagnostics?.repositoryScan?.executionMode, "stat-cache-unchanged");
  assert.equal(
    (await readWorldModel({ root: side })).snapshot.files.find((file) => file.path === "other.py").digest,
    built.snapshot.files.find((file) => file.path === "other.py").digest,
  );
});

test("refresh generation keeps the scan stat and does not pair a later stat with that digest", async (t) => {
  const f = project(t);
  const built = await buildWorldModel({ root: f.root });
  const generationFile = path.join(f.root, f.storage.directory, "refresh/input-generation.json");
  const before = JSON.parse(fs.readFileSync(generationFile, "utf8"));
  const target = path.join(f.root, "other.py");
  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.appendFileSync(target, "\n");
  const { loadFileStatCache, writeRefreshInputGeneration } = await import("../scripts/lib/world/refresh-input-generation.mjs");
  const verified = loadFileStatCache(f.root, f.storage);
  const written = writeRefreshInputGeneration({ root: f.root, storage: f.storage, snapshot: built.snapshot, verifiedFiles: verified });
  assert.equal(written.files["other.py"].mtimeNs, before.files["other.py"].mtimeNs);
  assert.equal(written.files["other.py"].digest, before.files["other.py"].digest);
  assert.notEqual(fs.statSync(target, { bigint: true }).mtimeNs.toString(), written.files["other.py"].mtimeNs);
  const reread = writeRefreshInputGeneration({ root: f.root, storage: f.storage, snapshot: built.snapshot });
  assert.equal(reread.files["other.py"], undefined);
  const refreshed = await refreshWorldModel({ root: f.root });
  assert.equal(refreshed.status, "refreshed");
  assert.notEqual(refreshed.diagnostics?.repositoryScan?.executionMode, "stat-cache-unchanged");
  const loaded = await readWorldModel({ root: f.root });
  assert.equal(loaded.snapshot.files.find((file) => file.path === "other.py").digest, sha256Hex(fs.readFileSync(target)));
});

test("a store written by beta.80 refresh keeps the same snapshot when sources are unchanged", async (t) => {
  const archive = fs.mkdtempSync(path.join(os.tmpdir(), "lode-beta80-src-"));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-한글 café it's (v2)-")));
  t.after(() => {
    fs.rmSync(archive, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const tarFile = path.join(archive, "beta80.tar");
  const archived = spawnSync("git", ["archive", "--format=tar", "-o", tarFile, "6d9f6be"], {
    cwd: pluginRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(archived.status, 0, archived.stderr);
  const extracted = spawnSync("tar", ["-xf", tarFile, "-C", archive], { encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(extracted.status, 0, extracted.stderr);
  const betaCore = await import(pathToFileURL(path.join(archive, "scripts/lib/lode-core.mjs")).href);
  const betaWorld = await import(pathToFileURL(path.join(archive, "scripts/lib/world-model.mjs")).href);
  betaCore.initializeProject({ root, pluginRoot: archive, runtimes: ["codex", "claude", "opencode"] });
  const sourceDir = path.join(root, "docs", "한글 문서");
  fs.mkdirSync(sourceDir, { recursive: true });
  const source = path.join(sourceDir, "it's (v2).py");
  fs.writeFileSync(source, "def kept_value():\n    return 'café'\n");
  const built = await betaWorld.buildWorldModel({ root });
  const storage = inspectProject(root).storage;
  const before = snapshotNames(root, storage);
  const beforeBytes = before.map((name) => fs.readFileSync(path.join(root, storage.directory, name)));
  const refreshed = await refreshWorldModel({ root });
  assert.equal(refreshed.status, "unchanged");
  assert.deepEqual(snapshotNames(root, storage), before);
  snapshotNames(root, storage).forEach((name, index) => {
    assert.equal(fs.readFileSync(path.join(root, storage.directory, name)).equals(beforeBytes[index]), true);
  });
  const pointer = JSON.parse(fs.readFileSync(path.join(root, storage.directory, "world-model/current.json"), "utf8"));
  assert.equal(pointer.worldModelId, built.snapshot.worldModelId);
  assert.equal(pointer.readerRequirements.minimumReader, "0.3.0-beta.75");
  assert.equal(fs.readFileSync(source, "utf8").includes("café"), true);
});
