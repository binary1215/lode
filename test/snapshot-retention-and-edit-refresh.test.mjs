import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/session/lode-core.mjs";
import { compileContext } from "../scripts/lib/session/context-compiler.mjs";
import { buildWorldModel, readWorldModel, readWorldModelSnapshot } from "../scripts/lib/world/world-model.mjs";
import { inspectIncrementalRefresh } from "../scripts/lib/world/incremental-refresh.mjs";
import { selectRetainedSnapshotIds, resolveSnapshotRetentionPolicy } from "../scripts/lib/world/snapshot-retention-policy.mjs";
import { refreshWorldModel } from "../scripts/lib/world/incremental-refresh.mjs";
import { applySnapshotGarbageCollection, inspectSnapshotGarbageCollection } from "../scripts/lib/world/snapshot-gc.mjs";
import { diffGraphLineage } from "../scripts/lib/world/graph-lineage.mjs";
import { sha256Hex } from "../scripts/lib/core/digest.mjs";

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

const worldFile = (f, id) =>
  ["", ".gz"].map((suffix) => path.join(f.root, f.storage.directory, "world-model/snapshots", id + ".json" + suffix)).find((file) => fs.existsSync(file)) ||
  null;

test("retention drops unpinned refresh history and keeps the current pointers, what they name and a decision diff", async (t) => {
  const f = project(t);
  const first = await buildWorldModel({ root: f.root });
  const capsule = await compileContext({ root: f.root, task: "Explain kept_value", budget: 32768, persist: true });
  assert.equal(capsule.status, "compiled");
  const otherBefore = fs.readFileSync(path.join(f.root, "other.py"));
  const generations = [];
  for (const text of ["one", "two", "three"]) {
    fs.writeFileSync(f.source, `def kept_value():\n    return 'café ${text}'\n`);
    const refreshed = await refreshWorldModel({ root: f.root });
    assert.equal(refreshed.status, "refreshed");
    generations.push(refreshed.worldModel.worldModelId);
  }
  const [old, previous, current] = generations;
  // No window configured: the dry run keeps everything, as before retention existed.
  const defaultDry = inspectSnapshotGarbageCollection({ root: f.root });
  assert.equal(defaultDry.retention.source, "not-configured");
  assert(defaultDry.snapshots.every((row) => row.disposition === "retain"));
  assert.equal(defaultDry.reclaimableBytes, 0);
  const beforeBytes = treeBytes(path.join(f.root, f.storage.directory));
  const dry = inspectSnapshotGarbageCollection({ root: f.root, retention: { keepCount: 1, keepDays: 0 } });
  assert.equal(dry.status, "gc_dry_run");
  assert.equal(dry.deletedCount, 0);
  const disposition = (id) => dry.snapshots.find((row) => row.id === id)?.disposition;
  assert.equal(disposition(old), "reclaim");
  for (const kept of [first.snapshot.worldModelId, previous, current]) assert.equal(disposition(kept), "retain", kept);
  assert.ok(dry.reclaimableBytes > 0);
  const namesBefore = snapshotNames(f.root, f.storage);
  const applied = await applySnapshotGarbageCollection({ root: f.root, retention: { keepCount: 1, keepDays: 0 } });
  assert.equal(applied.status, "gc_applied", JSON.stringify({ code: applied.code, issues: applied.coverage?.issues?.slice(0, 8) }));
  assert.ok(applied.reclaimedBytes > 0);
  assert.ok(treeBytes(path.join(f.root, f.storage.directory)) < beforeBytes);
  assert.ok(snapshotNames(f.root, f.storage).length < namesBefore.length);
  assert.equal(worldFile(f, old), null, "the old unpinned generation is gone");
  for (const kept of [first.snapshot.worldModelId, previous, current]) assert(worldFile(f, kept), kept);
  // Every command keeps working afterwards (D1).
  assert.equal((await readWorldModel({ root: f.root })).snapshot.worldModelId, current);
  assert.equal((await inspectIncrementalRefresh({ root: f.root })).status, "current");
  assert.equal((await buildWorldModel({ root: f.root })).status, "unchanged");
  assert.equal((await refreshWorldModel({ root: f.root })).status, "unchanged");
  fs.writeFileSync(f.source, "def kept_value():\n    return 'café four'\n");
  assert.equal((await refreshWorldModel({ root: f.root })).status, "refreshed");
  // The decision pin and its diff stay.
  const pinned = await readWorldModelSnapshot({ root: f.root, worldModelId: first.snapshot.worldModelId });
  assert.equal(pinned.snapshot.worldModelHash, first.snapshot.worldModelHash);
  const difference = await diffGraphLineage({ root: f.root, fromWorldModelId: first.snapshot.worldModelId, toWorldModelId: current });
  assert.ok(difference.changes);
  assert.equal(fs.readFileSync(path.join(f.root, "other.py")).equals(otherBefore), true);
});

test("without a window, apply keeps every snapshot it kept before retention existed", async (t) => {
  const f = project(t);
  await buildWorldModel({ root: f.root });
  for (const text of ["one", "two"]) {
    fs.writeFileSync(f.source, `def kept_value():\n    return '${text}'\n`);
    await refreshWorldModel({ root: f.root });
  }
  const names = snapshotNames(f.root, f.storage);
  const applied = await applySnapshotGarbageCollection({ root: f.root });
  assert.equal(applied.status, "gc_applied");
  assert.equal(applied.retention.source, "not-configured");
  assert.equal(applied.retention.preserveAllHistory, true);
  assert.deepEqual(snapshotNames(f.root, f.storage), names);
});

test("an invalid policy file keeps all history; a valid one applies its window", async (t) => {
  const f = project(t);
  const file = path.join(f.root, f.storage.directory, "refresh", "snapshot-retention.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, keepCount: 0, keepDays: 1 }));
  assert.equal(resolveSnapshotRetentionPolicy({ root: f.root, storage: f.storage }).source, "invalid-config-preserve");
  assert.equal(resolveSnapshotRetentionPolicy({ root: f.root, storage: f.storage }).preserveAllHistory, true);
  fs.writeFileSync(file, "{ not json");
  assert.equal(resolveSnapshotRetentionPolicy({ root: f.root, storage: f.storage }).preserveAllHistory, true);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, keepCount: 3, keepDays: 2 }));
  assert.deepEqual(resolveSnapshotRetentionPolicy({ root: f.root, storage: f.storage }), {
    keepCount: 3,
    keepDays: 2,
    source: "project-file",
    preserveAllHistory: false,
  });
  // Options for one run take precedence; an invalid option keeps everything.
  assert.equal(resolveSnapshotRetentionPolicy({ root: f.root, storage: f.storage, override: { keepCount: 1 } }).keepCount, 1);
  assert.equal(resolveSnapshotRetentionPolicy({ root: f.root, storage: f.storage, override: { keepCount: -1 } }).preserveAllHistory, true);
});

test("the window: newest by write time over every published World, age, rows without time, hash-named and current pins", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-11-16T00:00:00Z");
  const world = (n) => "world-model-" + String(n).padStart(24, "0");
  const row = (n, ageDays, extra = {}) => ({
    id: world(n),
    identityIds: [world(n)],
    references: [],
    ancestryIds: [],
    sha256: String(n).padStart(64, "a"),
    ...(ageDays === null ? {} : { mtimeMs: now - ageDays * day }),
    ...extra,
  });
  const snapshots = [row(1, 30), row(2, 20), row(3, 10), row(4, 5), row(5, 1), row(6, null), row(7, 40), row(8, 50)];
  const roots = [
    { relative: "world-model/current.json", references: [world(4), world(3)], ancestryIds: [world(3)] },
    { relative: "refresh/current.json", references: [world(4)], ancestryIds: [], namedRecordIds: ["receipt-x"] },
    { relative: "refresh/receipts/receipt-x.json", references: [world(8), world(4)], ancestryIds: [] },
    { relative: "refresh/receipts/receipt-older.json", references: [world(1)], ancestryIds: [] },
    { relative: "context/record.json", references: [], ancestryIds: [], digestReferences: [String(7).padStart(64, "a")] },
  ];
  const decide = (policy) => selectRetainedSnapshotIds({ snapshots, roots, policy: { ...policy, preserveAllHistory: false }, nowMs: now });
  const count = decide({ keepCount: 1, keepDays: 0 });
  // Newest by time is world 5, a sibling outside the current pointer's lineage (D3).
  assert(count.keepIds.has(world(5)));
  // Current pointer with its previous World, and what the refresh pointer names (D1).
  for (const n of [4, 3, 8]) assert(count.keepIds.has(world(n)), String(n));
  // No trustworthy time: kept (D4). Named by hash in a record: kept (D6).
  assert(count.keepIds.has(world(6)));
  assert(count.keepIds.has(world(7)));
  // An older receipt is history: it does not keep world 1; nor does age.
  assert(!count.keepIds.has(world(1)));
  assert(!count.keepIds.has(world(2)));
  const age = decide({ keepCount: 1, keepDays: 25 });
  assert(age.keepIds.has(world(2)), "written 20 days ago, inside 25 days");
  assert(!age.keepIds.has(world(1)), "written 30 days ago");
});

test("refresh generation keeps the scan stat and does not pair a later stat with that digest", async (t) => {
  const f = project(t);
  const built = await buildWorldModel({ root: f.root });
  const generationFile = path.join(f.root, f.storage.directory, "refresh/input-generation.json");
  const before = JSON.parse(fs.readFileSync(generationFile, "utf8"));
  const target = path.join(f.root, "other.py");
  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.appendFileSync(target, "\n");
  const { loadFileStatCache, refreshInputStamp, writeRefreshInputGeneration } = await import("../scripts/lib/world/refresh-input-generation.mjs");
  const verified = loadFileStatCache(f.root, f.storage);
  // A generation is written only with the stamp taken before the reads it vouches for.
  const stamp = refreshInputStamp(f.root, f.storage);
  const written = writeRefreshInputGeneration({ root: f.root, storage: f.storage, snapshot: built.snapshot, verifiedFiles: verified, stamp });
  assert.equal(written.files["other.py"].mtimeNs, before.files["other.py"].mtimeNs);
  assert.equal(written.files["other.py"].digest, before.files["other.py"].digest);
  assert.notEqual(fs.statSync(target, { bigint: true }).mtimeNs.toString(), written.files["other.py"].mtimeNs);
  const reread = writeRefreshInputGeneration({ root: f.root, storage: f.storage, snapshot: built.snapshot, stamp });
  assert.equal(reread.files["other.py"], undefined);
  const refreshed = await refreshWorldModel({ root: f.root });
  assert.equal(refreshed.status, "refreshed");
  assert.notEqual(refreshed.diagnostics?.repositoryScan?.executionMode, "stat-cache-unchanged");
  const loaded = await readWorldModel({ root: f.root });
  assert.equal(loaded.snapshot.files.find((file) => file.path === "other.py").digest, sha256Hex(fs.readFileSync(target)));
});

test("D5: a dry run that knows apply would refuse names nothing as reclaimable", async (t) => {
  const f = project(t);
  const first = await buildWorldModel({ root: f.root });
  const capsule = await compileContext({ root: f.root, task: "Explain kept_value", budget: 32768, persist: true });
  assert.equal(capsule.status, "compiled");
  for (const text of ["one", "two", "three"]) {
    fs.writeFileSync(f.source, `def kept_value():\n    return '${text}'\n`);
    await refreshWorldModel({ root: f.root });
  }
  const window = { keepCount: 1, keepDays: 0 };
  assert.ok(inspectSnapshotGarbageCollection({ root: f.root, retention: window }).reclaimableBytes > 0);
  // The World the Capsule pins is gone: apply must refuse, so nothing is reclaimable.
  fs.rmSync(worldFile(f, first.snapshot.worldModelId));
  const dry = inspectSnapshotGarbageCollection({ root: f.root, retention: window });
  assert.equal(dry.applyAvailable, false);
  assert.equal(dry.reclaimableBytes, 0);
  assert(dry.snapshots.every((row) => row.disposition === "retain"));
});
