import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/session/lode-core.mjs";
import { buildWorldModel, readWorldModel } from "../scripts/lib/world/world-model.mjs";
import { refreshWorldModel } from "../scripts/lib/world/incremental-refresh.mjs";
import { applySnapshotGarbageCollection } from "../scripts/lib/world/snapshot-gc.mjs";
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
