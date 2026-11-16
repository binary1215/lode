// Storage GC with and without a retention window, through the real dry run
// and the real apply: the preview names what the apply deletes, pins hold
// under the tightest window, and the output says which policy is in force.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/session/lode-core.mjs";
import { compileContext, readContextCapsule } from "../scripts/lib/session/context-compiler.mjs";
import { buildWorldModel, readWorldModel, readWorldModelSnapshot } from "../scripts/lib/world/world-model.mjs";
import { refreshWorldModel, inspectIncrementalRefresh } from "../scripts/lib/world/incremental-refresh.mjs";
import { applySnapshotGarbageCollection, inspectSnapshotGarbageCollection } from "../scripts/lib/world/snapshot-gc.mjs";
import { LocalJsonWorldModelStoreAdapter } from "../scripts/lib/world/world-model-store.mjs";
import { LocalJsonGraphProjectionAdapter } from "../scripts/lib/world/graph-projection-adapter.mjs";
import { createRecoveryCheckpoint, readRecoveryCheckpoint } from "../scripts/lib/session/compaction-recovery.mjs";
import { recordSessionWorkEvidence, readSessionWorkContext } from "../scripts/lib/session/session-work-context.mjs";
import { createWholePlanSnapshot, createExecutionContract, readLineageArtifact } from "../scripts/lib/runtime/execution-lineage.mjs";
import { startRun, finishRun, getPendingReviewContext, reviewRun } from "../scripts/lib/runtime/run-lineage.mjs";
import { recordChangeSet, readChangeSet } from "../scripts/lib/world/change-set.mjs";
import { formatCliResult } from "../scripts/lib/session/cli-presentation.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { readIncrementalRefreshReceipt } from "../scripts/lib/world/incremental-refresh.mjs";
import { inspectGraphLineage } from "../scripts/lib/world/graph-lineage.mjs";
import { adoptVerifiedProjectCopy } from "../scripts/lib/storage/project-copy-adoption.mjs";
import { buildSnapshotDeletionClosure, selectRetainedClosure } from "../scripts/lib/world/snapshot-deletion-closure.mjs";
import { readPostRefreshProjectionReceipt } from "../scripts/lib/world/incremental-refresh.mjs";
import { processRefreshTriggerBatch } from "../scripts/lib/world/refresh-trigger.mjs";
import { ConformanceTriggerRegistry } from "../scripts/lib/runtime/conformance-trigger-adapter.mjs";
import { createRecoveryCheckpoint as checkpointFor } from "../scripts/lib/session/compaction-recovery.mjs";
import {
  buildRetentionRelease,
  planRetentionReleases,
  readRetentionReleases,
  writeRetentionRelease,
  RETENTION_RELEASE_MAX_BYTES,
} from "../scripts/lib/world/snapshot-retention-releases.mjs";
import { sha256Hex } from "../scripts/lib/core/digest.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const WINDOW = Object.freeze({ keepCount: 1, keepDays: 0 });

function project(t, prefix = "lode-retention-gc-") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  const source = path.join(root, "example.py");
  fs.writeFileSync(source, "def add(a, b):\n    return a + b\n");
  let generation = 0;
  // Each call publishes a new World (a build first, then refreshes).
  const next = async () => {
    generation += 1;
    fs.writeFileSync(source, `def add(a, b):\n    return a + b + ${generation}\n`);
    const result = generation === 1 ? await buildWorldModel({ root }) : await refreshWorldModel({ root });
    assert.ok(["indexed", "refreshed"].includes(result.status), result.status);
    return (result.snapshot || result.worldModel).worldModelId;
  };
  return { root, storage, source, next, store: path.join(root, storage.directory) };
}

const worldFile = (f, id) =>
  ["", ".gz"].map((suffix) => path.join(f.store, "world-model/snapshots", id + ".json" + suffix)).find((file) => fs.existsSync(file)) || null;
const worldIds = (f) =>
  fs
    .readdirSync(path.join(f.store, "world-model/snapshots"))
    .map((name) => name.replace(/\.json(?:\.gz)?$/, ""))
    .sort();
const reclaimIds = (dry) =>
  dry.snapshots
    .filter((row) => row.disposition === "reclaim")
    .map((row) => row.id)
    .sort();
// Whole World and Graph snapshots the apply deleted (not the parts only they used).
const deletedIds = (applied) =>
  applied.deleted
    .map((row) => row.id)
    .filter(Boolean)
    .sort();
const namedWorlds = (file) => [...new Set(fs.readFileSync(file, "utf8").match(/world-model-[a-f0-9]{24}/g) || [])];

test("H1: under a window the dry run names exactly what the next apply deletes, twice in a row", async (t) => {
  const f = project(t);
  for (let i = 0; i < 5; i += 1) await f.next();
  for (const round of [1, 2]) {
    const dry = inspectSnapshotGarbageCollection({ root: f.root, retention: WINDOW });
    assert.equal(dry.applyAvailable, true, `round ${round}: ${JSON.stringify(dry.coverage.issues)}`);
    assert.equal(dry.retention.mode, "window");
    assert.ok(dry.reclaimableBytes > 0, `round ${round}`);
    const applied = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW });
    assert.equal(applied.status, "gc_applied", JSON.stringify({ code: applied.code, issues: applied.coverage?.issues }));
    assert.deepEqual(deletedIds(applied), reclaimIds(dry), `round ${round}: preview and apply agree`);
    assert.equal(
      applied.reclaimedBytes >= dry.reclaimableBytes,
      true,
      "the apply also deletes the parts those snapshots alone used; the snapshot-file bytes match",
    );
    assert.equal(
      applied.deleted.filter((row) => reclaimIds(dry).includes(row.id)).reduce((n, row) => n + row.bytes, 0),
      dry.reclaimableBytes,
    );
    // The dry run right after the apply has nothing left to release.
    const after = inspectSnapshotGarbageCollection({ root: f.root, retention: WINDOW });
    assert.equal(after.applyAvailable, true, JSON.stringify(after.coverage.issues));
    assert.equal(after.reclaimableBytes, 0);
    for (let i = 0; i < 3; i += 1) await f.next();
  }
  assert.equal((await inspectIncrementalRefresh({ root: f.root })).status, "current");
});

test("H4: without a window the dry run is the pre-retention preview and the apply deletes only a real orphan next to refresh history", async (t) => {
  const f = project(t);
  for (let i = 0; i < 3; i += 1) await f.next();
  // A published World and Graph that nothing names: a write whose pointer never followed.
  fs.writeFileSync(f.source, "def multiply(a, b):\n    return a * b\n");
  const built = await buildWorldModel({ root: f.root, persist: false });
  const world = new LocalJsonWorldModelStoreAdapter({ projectRoot: f.root, storage: f.storage, snapshotLayout: "whole" });
  const graph = new LocalJsonGraphProjectionAdapter({ projectRoot: f.root, storage: f.storage, snapshotLayout: "whole" });
  await world.writeSnapshot(built.snapshot.worldModelId, built.snapshot);
  await graph.writeSnapshot(built.snapshot.temporalProvenanceGraph.graphSnapshotId, built.snapshot.temporalProvenanceGraph);
  const orphanIds = [built.snapshot.worldModelId, built.snapshot.temporalProvenanceGraph.graphSnapshotId].sort();
  const history = worldIds(f).filter((id) => id !== built.snapshot.worldModelId);
  const dry = inspectSnapshotGarbageCollection({ root: f.root });
  assert.equal(dry.retention.mode, "off");
  assert.equal(dry.retention.source, "not-configured");
  assert.equal(dry.retention.keepCount, null);
  assert.equal(dry.retention.keepDays, null);
  assert(
    dry.snapshots.every((row) => row.disposition === "retain"),
    "the default preview names nothing as reclaimable",
  );
  assert.equal(dry.reclaimableBytes, 0);
  const unreferenced = dry.snapshots
    .filter((row) => !row.observedReference)
    .map((row) => row.id)
    .sort();
  assert.deepEqual(unreferenced, orphanIds, "the preview names exactly the orphan as unreferenced");
  assert(
    dry.snapshots.filter((row) => !orphanIds.includes(row.id)).every((row) => row.reasonCode === "RETAINED_REFERENCE_CLOSURE"),
    "no third classification",
  );
  const applied = await applySnapshotGarbageCollection({ root: f.root });
  assert.equal(applied.status, "gc_applied", JSON.stringify(applied.coverage?.issues));
  assert.deepEqual(deletedIds(applied), orphanIds);
  assert(applied.retention.released.every((row) => row.rule === "unreferenced"));
  assert.deepEqual(worldIds(f), history, "every World refresh history names stays");
});

test("H3: an unusable policy file is reported, not replaced by defaults; a BOM is read; the output says off, file or options", async (t) => {
  const f = project(t);
  for (let i = 0; i < 3; i += 1) await f.next();
  const policyFile = path.join(f.store, "refresh", "snapshot-retention.json");
  const names = worldIds(f);
  // Not JSON: retention off, the reason named, every World kept by the apply.
  fs.writeFileSync(policyFile, "{ keepCount: 1");
  const badDry = inspectSnapshotGarbageCollection({ root: f.root });
  assert.equal(badDry.retention.mode, "off");
  assert.equal(badDry.retention.source, "invalid-project-file");
  assert.equal(badDry.retention.problem, "not valid JSON");
  assert.equal(badDry.retention.keepCount, null);
  const badText = formatCliResult("storage-gc", badDry);
  assert.match(badText, /Retention is off: the policy file refresh\/snapshot-retention\.json .* cannot be used \(not valid JSON\)/);
  assert.doesNotMatch(badText, /last 8|8 worlds|14 days/);
  const badApply = await applySnapshotGarbageCollection({ root: f.root });
  assert.equal(badApply.status, "gc_applied");
  assert.equal(badApply.retention.source, "invalid-project-file");
  assert.deepEqual(worldIds(f), names);
  // A wrong type: off, with the field named.
  fs.writeFileSync(policyFile, JSON.stringify({ schemaVersion: 1, keepCount: "1", keepDays: 0 }));
  assert.match(inspectSnapshotGarbageCollection({ root: f.root }).retention.problem, /keepCount/);
  // Saved by Windows PowerShell 5.1: a byte order mark before the JSON.
  fs.writeFileSync(policyFile, "﻿" + JSON.stringify({ schemaVersion: 1, keepCount: 1, keepDays: 0 }));
  const bomDry = inspectSnapshotGarbageCollection({ root: f.root });
  assert.equal(bomDry.retention.mode, "window");
  assert.equal(bomDry.retention.source, "project-file");
  assert.ok(bomDry.reclaimableBytes > 0);
  const bomText = formatCliResult("storage-gc", bomDry);
  assert.match(bomText, /Retention window in force, from the policy file .*newest 1 Worlds .*last 0 days/);
  assert.match(bomText, /Would delete: \d+ outside the retention window/);
  // Options for one run say so.
  const optionText = formatCliResult("storage-gc", inspectSnapshotGarbageCollection({ root: f.root, retention: { keepCount: 2, keepDays: 0 } }));
  assert.match(optionText, /from this run's --keep-count\/--keep-days: the newest 2 Worlds/);
  // No file: off, and said so.
  fs.rmSync(policyFile);
  assert.match(
    formatCliResult("storage-gc", inspectSnapshotGarbageCollection({ root: f.root })),
    /Retention is off \(no policy file, no --keep-count\/--keep-days\)/,
  );
  // The apply text names the rule the deletions went under.
  fs.writeFileSync(policyFile, "﻿" + JSON.stringify({ schemaVersion: 1, keepCount: 1, keepDays: 0 }));
  const applied = await applySnapshotGarbageCollection({ root: f.root });
  assert.equal(applied.status, "gc_applied", JSON.stringify(applied.coverage?.issues));
  const appliedText = formatCliResult("storage-gc", applied);
  assert.match(appliedText, /World history outside the retention window was deleted/);
  assert.match(appliedText, /Deleted snapshots: \d+ outside the retention window/);
  assert.doesNotMatch(appliedText, /retained history and exact references were preserved/);
});

test("H9: --keep-count and --keep-days that are not whole numbers in range are usage errors", async (t) => {
  const f = project(t);
  await f.next();
  for (const args of [
    ["--keep-count", "abc"],
    ["--keep-count", "0"],
    ["--keep-days", "-1"],
    ["--keep-days", "1.5"],
    ["--keep-count", "10001"],
  ]) {
    await assert.rejects(runCommand(["storage-gc", f.root, ...args]), { code: "INVALID_STORAGE_GC_RETENTION_OPTION" }, args.join(" "));
    await assert.rejects(runCommand(["storage-gc", f.root, "--apply", ...args]), { code: "INVALID_STORAGE_GC_RETENTION_OPTION" }, args.join(" "));
  }
  const ok = await runCommand(["storage-gc", f.root, "--keep-count", "3", "--keep-days", "0"]);
  assert.equal((ok.value || ok).retention?.mode ?? (ok.value || ok).result?.retention?.mode, "window");
});

// Every pin holds under the tightest window: a record written when the first
// World was current keeps that World through three later generations.
test("pins through a real windowed apply: Capsule, ChangeSet, Session work evidence, knowledge decision by id and by hash, product graph Canon; a lineage contract and a checkpoint (which name no snapshot) still read", async (t) => {
  const f = project(t);
  const first = await f.next();
  const capsule = await compileContext({ root: f.root, task: "Explain add", budget: 32768, persist: true });
  assert.equal(capsule.status, "compiled");
  const plan = createWholePlanSnapshot({ root: f.root, objective: "Change add", plan: "Change then review" });
  const contract = createExecutionContract({
    root: f.root,
    wholePlanId: plan.artifact.wholePlanId,
    capsuleId: capsule.capsule.capsuleId,
    scope: "Change example.py",
    acceptanceCriteria: ["The first World stays readable"],
  });
  startRun({ root: f.root, executionContractId: contract.artifact.executionContractId });
  fs.appendFileSync(f.source, "\ndef subtract(a, b):\n    return a - b\n");
  const finished = finishRun({
    root: f.root,
    outcome: "Added subtract",
    evidence: [{ uri: "example.py", summary: "Added subtract" }],
    verification: [{ check: "Read the file", status: "passed" }],
  });
  const pending = getPendingReviewContext({ root: f.root });
  const review = reviewRun({ root: f.root, reviewContextId: pending.review.reviewContextId, disposition: "accept", rationale: "Reviewed" });
  const second = await f.next();
  const change = await recordChangeSet({
    root: f.root,
    resultPacketId: finished.resultPacket.resultPacketId,
    reviewDecisionId: review.reviewDecision.reviewDecisionId,
  });
  const checkpoint = createRecoveryCheckpoint({ root: f.root, purpose: "Keep history", currentPosition: "After the change", nextExpectedResult: "Continue" });
  // A Session work record that pins the first World's file by its exact bytes.
  const firstFile = worldFile(f, first);
  const firstRelative = path.relative(f.root, firstFile).replaceAll("\\", "/");
  recordSessionWorkEvidence({
    root: f.root,
    input: { summary: "Keep the first World bytes", references: [{ path: firstRelative, digest: sha256Hex(fs.readFileSync(firstFile)), kind: "source" }] },
  });
  // Records a person writes: a knowledge decision by id and one by hash, and a product graph Canon document.
  const firstSnapshot = (await readWorldModelSnapshot({ root: f.root, worldModelId: first })).snapshot;
  const knowledgeFile = path.join(f.store, "context/knowledge.json");
  const knowledge = JSON.parse(fs.readFileSync(knowledgeFile, "utf8"));
  knowledge.decisions.push({ decisionId: "decision-by-id", summary: "Compare against the first World", worldModelId: first });
  knowledge.decisions.push({ decisionId: "decision-by-hash", summary: "Compare against it by hash", worldModelHash: firstSnapshot.worldModelHash });
  fs.writeFileSync(knowledgeFile, JSON.stringify(knowledge, null, 2));
  const canonDirectory = path.join(f.store, "context/product-graph");
  fs.mkdirSync(canonDirectory, { recursive: true });
  fs.writeFileSync(path.join(canonDirectory, "정책.md"), `# 정책\n\nThe baseline is ${first}.\n`);
  for (let i = 0; i < 3; i += 1) await f.next();
  const current = (await readWorldModel({ root: f.root })).snapshot.worldModelId;
  const recordFiles = {
    capsule: path.join(f.store, "context/capsules", capsule.capsule.capsuleId + ".json"),
    changeSet: path.join(f.store, "change-sets/records", change.changeSet.changeSetId + ".json"),
    contract: path.join(f.store, "lineage/execution-contracts", contract.artifact.executionContractId + ".json"),
    checkpoint: checkpoint.file,
    knowledge: knowledgeFile,
    canon: path.join(canonDirectory, "정책.md"),
  };
  // These records name the first World themselves (by id; the knowledge file also by hash).
  for (const name of ["capsule", "changeSet", "knowledge", "canon"]) assert(namedWorlds(recordFiles[name]).includes(first), name);
  // A lineage contract and a checkpoint name no snapshot: they keep history through the Capsule
  // and Session records they name, not through a snapshot id of their own.
  assert.deepEqual(namedWorlds(recordFiles.contract), []);
  assert(fs.readFileSync(recordFiles.contract, "utf8").includes(capsule.capsule.capsuleId));
  assert.deepEqual(namedWorlds(recordFiles.checkpoint), []);
  const pinned = new Set(Object.values(recordFiles).flatMap((file) => namedWorlds(file)));
  const dry = inspectSnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  assert.equal(dry.applyAvailable, true, JSON.stringify(dry.coverage.issues));
  const applied = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  assert.equal(applied.status, "gc_applied", JSON.stringify({ code: applied.code, issues: applied.coverage?.issues }));
  assert.deepEqual(deletedIds(applied), reclaimIds(dry));
  assert.ok(applied.deletedCount > 0, "the window released something");
  for (const id of [...pinned, current, first, second]) assert(worldFile(f, id), id + " stays");
  // Each record still reads.
  assert.equal(readContextCapsule({ root: f.root, capsuleId: capsule.capsule.capsuleId }).capsule.capsuleId, capsule.capsule.capsuleId);
  assert.equal(readChangeSet({ root: f.root, changeSetId: change.changeSet.changeSetId }).changeSet.changeSetId, change.changeSet.changeSetId);
  assert.equal(
    readLineageArtifact({ root: f.root, artifactId: contract.artifact.executionContractId }).artifact.executionContractId,
    contract.artifact.executionContractId,
  );
  assert.equal(
    readRecoveryCheckpoint({ root: f.root, checkpointId: checkpoint.checkpoint.checkpointId }).checkpoint.checkpointId,
    checkpoint.checkpoint.checkpointId,
  );
  assert(readSessionWorkContext({ root: f.root }).records.length >= 1);
  assert.equal((await readWorldModelSnapshot({ root: f.root, worldModelId: first })).snapshot.worldModelHash, firstSnapshot.worldModelHash);
  // The Graph of the World a record names only by hash stays too (H8).
  const graphId = firstSnapshot.temporalProvenanceGraph.graphSnapshotId;
  assert(
    ["", ".gz"].some((suffix) => fs.existsSync(path.join(f.store, "graph-projection/snapshots", graphId + ".json" + suffix))),
    "the first World's Graph stays",
  );
});

test("H8: a hash-only record keeps its World and that World's Graph; a missing parent of the current World is an issue under a window", async (t) => {
  const f = project(t);
  const first = await f.next();
  const firstSnapshot = (await readWorldModelSnapshot({ root: f.root, worldModelId: first })).snapshot;
  const knowledgeFile = path.join(f.store, "context/knowledge.json");
  const knowledge = JSON.parse(fs.readFileSync(knowledgeFile, "utf8"));
  knowledge.decisions.push({ decisionId: "by-hash", summary: "Only the hash", worldModelHash: firstSnapshot.worldModelHash });
  fs.writeFileSync(knowledgeFile, JSON.stringify(knowledge));
  for (let i = 0; i < 3; i += 1) await f.next();
  const applied = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  assert.equal(applied.status, "gc_applied", JSON.stringify(applied.coverage?.issues));
  assert(worldFile(f, first));
  const graphId = firstSnapshot.temporalProvenanceGraph.graphSnapshotId;
  assert(["", ".gz"].some((suffix) => fs.existsSync(path.join(f.store, "graph-projection/snapshots", graphId + ".json" + suffix))));
  // The current World pointer names its previous World; that one is hard.
  const pointer = JSON.parse(fs.readFileSync(path.join(f.store, "world-model/current.json"), "utf8"));
  assert.ok(pointer.previousWorldModelId);
  fs.rmSync(worldFile(f, pointer.previousWorldModelId));
  const dry = inspectSnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  assert.equal(dry.applyAvailable, false);
  assert(
    dry.coverage.issues.some((item) => item.reasonCode === "RETAINED_SNAPSHOT_REFERENCE_UNAVAILABLE"),
    JSON.stringify(dry.coverage.issues),
  );
  const refused = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  assert.equal(refused.code, "SNAPSHOT_GC_REFERENCE_COVERAGE_INCOMPLETE");
  assert.equal(refused.deletedCount, 0);
});

test("H7: a restore that gives every file the same time reorders the window but never deletes a pin", async (t) => {
  const f = project(t);
  const first = await f.next();
  const capsule = await compileContext({ root: f.root, task: "Explain add", budget: 32768, persist: true });
  assert.equal(capsule.status, "compiled");
  for (let i = 0; i < 4; i += 1) await f.next();
  const current = (await readWorldModel({ root: f.root })).snapshot.worldModelId;
  const previous = JSON.parse(fs.readFileSync(path.join(f.store, "world-model/current.json"), "utf8")).previousWorldModelId;
  // With every time equal, the count keeps the World with the smallest id.
  const byCount = worldIds(f)[0];
  const expected = [...new Set([current, previous, first, byCount])].sort();
  // A restore that flattens every time.
  const when = new Date("2026-01-01T00:00:00Z");
  for (const directory of ["world-model/snapshots", "graph-projection/snapshots"])
    for (const name of fs.readdirSync(path.join(f.store, directory))) fs.utimesSync(path.join(f.store, directory, name), when, when);
  const dry = inspectSnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  const applied = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  assert.equal(applied.status, "gc_applied", JSON.stringify(applied.coverage?.issues));
  assert.deepEqual(deletedIds(applied), reclaimIds(dry));
  assert.deepEqual(worldIds(f), expected, "kept: the current World, its previous, the Capsule's World, and the count's pick by id");
  assert.equal(readContextCapsule({ root: f.root, capsuleId: capsule.capsule.capsuleId }).capsule.capsuleId, capsule.capsule.capsuleId);
  assert.equal((await inspectIncrementalRefresh({ root: f.root })).status, "current");
});

test("snapshots in the git object store under a window: they have no trustworthy time, so they stay; the dry run says it did not read them", async (t) => {
  const f = project(t, "lode-retention-git-");
  const world = new LocalJsonWorldModelStoreAdapter({ projectRoot: f.root, storage: f.storage, snapshotEncoding: "git" });
  const graph = new LocalJsonGraphProjectionAdapter({ projectRoot: f.root, storage: f.storage, snapshotEncoding: "git" });
  const gitWorlds = [];
  for (let i = 0; i < 3; i += 1) {
    fs.writeFileSync(f.source, `def add(a, b):\n    return a + b + ${100 + i}\n`);
    gitWorlds.push((await buildWorldModel({ root: f.root, storeAdapter: world, graphProjectionAdapter: graph })).snapshot.worldModelId);
  }
  // Then file-backed history on top.
  for (let i = 0; i < 3; i += 1) await f.next();
  const dry = inspectSnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  assert.equal(dry.retention.mode, "window");
  assert.deepEqual(
    dry.retention.unseenBackends?.some((item) => item.endsWith("snapshot-objects.git")),
    true,
  );
  assert.match(formatCliResult("storage-gc", dry), /were not read; the apply reads them and may keep more/);
  const applied = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  assert.equal(applied.status, "gc_applied", JSON.stringify({ code: applied.code, issues: applied.coverage?.issues }));
  assert.equal(applied.retiredRefCount, 0, "no git-stored snapshot is released");
  for (const id of gitWorlds) assert.equal((await readWorldModelSnapshot({ root: f.root, worldModelId: id })).snapshot.worldModelId, id);
  assert.deepEqual(deletedIds(applied), reclaimIds(dry), "the file-stored snapshots the apply deletes are exactly the ones the preview names");
  assert.ok(deletedIds(applied).length > 0);
  assert.ok((await readWorldModel({ root: f.root })).snapshot.worldModelId);
});

test("H8 unit: under a window the parent the World pointer names is hard, so a missing one is an issue; a kept World's own older parent is not", async () => {
  // Loaded here so the other tests in this file still run against a build without the shared selection.
  const { selectRetainedClosure } = await import("../scripts/lib/world/snapshot-deletion-closure.mjs");
  const { selectRetainedSnapshotIds } = await import("../scripts/lib/world/snapshot-retention-policy.mjs");
  const world = (n) => "world-model-" + String(n).padStart(24, "0");
  const now = Date.parse("2026-11-16T00:00:00Z");
  const row = (n, parent) => ({
    id: world(n),
    path: ".lode/world-model/snapshots/" + world(n) + ".json.gz",
    identityIds: [world(n)],
    references: [world(n), ...(parent ? [world(parent)] : [])],
    ancestryIds: parent ? [world(parent)] : [],
    mtimeMs: now - n * 1000,
  });
  // World 2 is current; its pointer names World 1 as previous, whose file is gone. World 3 is older history.
  const snapshots = [row(2, 1), row(3)];
  const roots = [{ path: ".lode/world-model/current.json", relative: "world-model/current.json", references: [world(2), world(1)], ancestryIds: [world(1)] }];
  const policy = { keepCount: 1, keepDays: 0, source: "options", preserveAllHistory: false };
  const decision = selectRetainedSnapshotIds({ snapshots, roots, policy, nowMs: now });
  const issues = [];
  selectRetainedClosure({ snapshots, roots, decision, issue: (path, reasonCode) => issues.push({ path, reasonCode }) });
  // The pointer, and the current World that names the same parent, both report it.
  assert(
    issues.some((item) => item.path === ".lode/world-model/current.json"),
    JSON.stringify(issues),
  );
  assert(issues.every((item) => item.reasonCode === "RETAINED_SNAPSHOT_REFERENCE_UNAVAILABLE"));
  // A kept World whose own parent is outside the window: not an issue, the parent leaves with its window.
  const kept = [row(5, 4)];
  const keptRoots = [{ path: ".lode/world-model/current.json", relative: "world-model/current.json", references: [world(5)], ancestryIds: [] }];
  const keptIssues = [];
  selectRetainedClosure({
    snapshots: kept,
    roots: keptRoots,
    decision: selectRetainedSnapshotIds({ snapshots: kept, roots: keptRoots, policy, nowMs: now }),
    issue: (path, reasonCode) => keptIssues.push({ path, reasonCode }),
  });
  assert.deepEqual(keptIssues, []);
});

// ---------- H2: retention release records ----------

const releaseDirectory = (f) => path.join(f.store, "refresh", "retention-releases");
const releaseFiles = (f) => (fs.existsSync(releaseDirectory(f)) ? fs.readdirSync(releaseDirectory(f)).sort() : []);
// Refresh receipts oldest first, by the World they produced.
const receiptsOldestFirst = (f) =>
  fs
    .readdirSync(path.join(f.store, "refresh/receipts"))
    .map((name) => ({ id: name.replace(/\.json$/, ""), time: fs.statSync(path.join(f.store, "refresh/receipts", name)).mtimeMs }))
    .sort((left, right) => left.time - right.time || (left.id < right.id ? -1 : 1))
    .map((item) => item.id);
const referenceIssues = (result) => (result.coverage?.issues || []).filter((item) => /REFERENCE_UNAVAILABLE|HASH_UNAVAILABLE/.test(item.reasonCode));

test("H2: after windowed applies, every later mode reads released history as released; twice in a row", async (t) => {
  const f = project(t);
  for (let i = 0; i < 5; i += 1) await f.next();
  const policyFile = path.join(f.store, "refresh", "snapshot-retention.json");
  for (const round of [1, 2]) {
    const before = releaseFiles(f).length;
    const windowed = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW });
    assert.equal(windowed.status, "gc_applied", `round ${round}: ${JSON.stringify(windowed.coverage?.issues)}`);
    assert.equal(releaseFiles(f).length, before + 1, "one release record per windowed apply that deletes");
    assert.equal(windowed.retentionRelease.count, deletedIds(windowed).length);
    const record = JSON.parse(fs.readFileSync(path.join(f.root, windowed.retentionRelease.path), "utf8"));
    assert.deepEqual(record.released.map((item) => item.id).sort(), deletedIds(windowed));
    assert.equal(record.policy.source, "options");
    // No window, with no policy, an invalid policy, and the policy file removed.
    for (const setup of ["none", "invalid", "removed"]) {
      if (setup === "invalid") fs.writeFileSync(policyFile, "{ not json");
      if (setup === "removed") fs.rmSync(policyFile, { force: true });
      const dry = inspectSnapshotGarbageCollection({ root: f.root });
      assert.equal(dry.applyAvailable, true, `round ${round} ${setup}: ${JSON.stringify(dry.coverage.issues)}`);
      assert.deepEqual(referenceIssues(dry), []);
      assert.ok(dry.retention.releasedReferences?.count > 0, "history names released snapshots and says so");
      assert.match(formatCliResult("storage-gc", dry), /released by retention, not missing/);
      const plain = await applySnapshotGarbageCollection({ root: f.root });
      assert.equal(plain.status, "gc_applied", `round ${round} ${setup}: ${JSON.stringify({ code: plain.code, issues: plain.coverage?.issues })}`);
      assert.equal(plain.deletedCount, 0);
      assert.ok(plain.retention.releasedReferences?.count > 0);
    }
    // The windowed dry run right after says nothing is missing either.
    assert.deepEqual(referenceIssues(inspectSnapshotGarbageCollection({ root: f.root, retention: WINDOW })), []);
    for (let i = 0; i < 3; i += 1) await f.next();
  }
  // The readers.
  const oldest = receiptsOldestFirst(f)[0];
  const read = await readIncrementalRefreshReceipt({ root: f.root, refreshReceiptId: oldest, allowReleased: true });
  assert.equal(read.status, "released-by-retention");
  assert.match(read.message, /was released by retention on \d{4}-\d{2}-\d{2}T/);
  assert.equal(read.receipt.refreshReceiptId, oldest);
  assert.match(formatCliResult("world-refresh-read", read), /released by retention on/);
  const releasedWorld = read.released[0].worldModelId;
  await assert.rejects(readWorldModelSnapshot({ root: f.root, worldModelId: releasedWorld }), { code: "WORLD_MODEL_SNAPSHOT_RELEASED" });
  const lineage = await inspectGraphLineage({ root: f.root });
  assert(lineage.releasedByRetention.entries.some((item) => item.worldModelId === releasedWorld));
  assert.equal(lineage.totalRetainedSnapshots, worldIds(f).length);
});

test("H2 condition 1: a default apply and every dry run write no release record", async (t) => {
  const f = project(t);
  for (let i = 0; i < 4; i += 1) await f.next();
  inspectSnapshotGarbageCollection({ root: f.root });
  inspectSnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  const plain = await applySnapshotGarbageCollection({ root: f.root });
  assert.equal(plain.status, "gc_applied");
  assert.equal(plain.retentionRelease, undefined);
  assert.deepEqual(releaseFiles(f), []);
});

test("H2 condition 3: the record is written first; a snapshot whose unlink then fails stays stored and readable, and a later run handles it", async (t) => {
  const f = project(t);
  for (let i = 0; i < 4; i += 1) await f.next();
  const dry = inspectSnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  const victims = reclaimIds(dry).filter((id) => id.startsWith("world-model-"));
  assert.ok(victims.length >= 1);
  assert.ok(victims.length >= 2, "two Worlds to release, so the failure comes part way");
  const victim = victims.at(-1);
  // The first unlink of that World fails, as an antivirus lock would make it fail.
  const originalUnlink = fs.unlinkSync;
  let refused = 0;
  fs.unlinkSync = function (target, ...args) {
    if (String(target).includes(victim) && refused === 0) {
      refused += 1;
      throw Object.assign(new Error("locked"), { code: "EBUSY" });
    }
    return originalUnlink.call(fs, target, ...args);
  };
  let first;
  try {
    first = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.equal(refused, 1);
  assert.equal(first.code, "EBUSY");
  assert.equal(first.status, "gc_partial", "one World went before the failure");
  assert.equal(worldFile(f, victims[0]), null);
  assert.equal(releaseFiles(f).length, 1, "the record was written before the failed unlink");
  const record = JSON.parse(fs.readFileSync(path.join(f.root, first.retentionRelease.path), "utf8"));
  assert(
    record.released.some((item) => item.id === victim),
    "the record lists it",
  );
  // Listed as released but present: it is read as present.
  assert(worldFile(f, victim));
  assert.equal((await readWorldModelSnapshot({ root: f.root, worldModelId: victim })).snapshot.worldModelId, victim);
  const plain = inspectSnapshotGarbageCollection({ root: f.root });
  assert.deepEqual(referenceIssues(plain), []);
  // The next windowed apply deletes it and lists it in a new record.
  const second = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  assert.equal(second.status, "gc_applied", JSON.stringify(second.coverage?.issues));
  assert(deletedIds(second).includes(victim));
  assert.equal(releaseFiles(f).length, 2);
  assert.equal(worldFile(f, victim), null);
});

test("H2 condition 4: an unusable release record excuses nothing and is named; without a record a missing World is an issue as before", async (t) => {
  const f = project(t);
  for (let i = 0; i < 4; i += 1) await f.next();
  const applied = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  assert.equal(applied.status, "gc_applied");
  const recordFile = path.join(f.root, applied.retentionRelease.path);
  const original = fs.readFileSync(recordFile, "utf8");
  const oldest = receiptsOldestFirst(f)[0];
  // Tampered: the digest no longer matches.
  fs.writeFileSync(recordFile, original.replace(/"releasedAt": "[^"]+"/, '"releasedAt": "2000-01-01T00:00:00.000Z"'));
  const dry = inspectSnapshotGarbageCollection({ root: f.root });
  assert.equal(dry.applyAvailable, false);
  assert(dry.coverage.issues.some((item) => item.reasonCode === "RETENTION_RELEASE_DIGEST_MISMATCH" && item.path.endsWith(path.basename(recordFile))));
  assert.ok(referenceIssues(dry).length > 0, "the references it would have covered are issues again");
  assert.match(
    formatCliResult("storage-gc", dry),
    /A retention release record cannot be used: .*retention-release-[a-f0-9]{24}\.json \(RETENTION_RELEASE_DIGEST_MISMATCH\)/,
  );
  const refused = await applySnapshotGarbageCollection({ root: f.root });
  assert.equal(refused.code, "SNAPSHOT_GC_REFERENCE_COVERAGE_INCOMPLETE");
  assert(refused.coverage.issues.some((item) => item.reasonCode === "RETENTION_RELEASE_DIGEST_MISMATCH"));
  assert.match(formatCliResult("storage-gc", refused), /A retention release record cannot be used/);
  await assert.rejects(readIncrementalRefreshReceipt({ root: f.root, refreshReceiptId: oldest, allowReleased: true }), {
    code: "WORLD_MODEL_SNAPSHOT_MISSING",
  });
  // Not JSON at all: the same.
  fs.writeFileSync(recordFile, "{");
  assert(inspectSnapshotGarbageCollection({ root: f.root }).coverage.issues.some((item) => item.reasonCode === "RETENTION_RELEASE_INVALID"));
  // Deleted: old history looks damaged again, nothing else changes.
  fs.rmSync(recordFile);
  const without = inspectSnapshotGarbageCollection({ root: f.root });
  assert.ok(referenceIssues(without).length > 0);
  assert(!without.coverage.issues.some((item) => /^RETENTION_RELEASE_/.test(item.reasonCode)));
  await assert.rejects(readIncrementalRefreshReceipt({ root: f.root, refreshReceiptId: oldest, allowReleased: true }), {
    code: "WORLD_MODEL_SNAPSHOT_MISSING",
  });
  // Restored byte for byte: released again.
  fs.writeFileSync(recordFile, original);
  assert.deepEqual(referenceIssues(inspectSnapshotGarbageCollection({ root: f.root })), []);
  assert.equal((await readIncrementalRefreshReceipt({ root: f.root, refreshReceiptId: oldest, allowReleased: true })).status, "released-by-retention");
});

// A copy whose origin Lode has not verified, as a moved folder is; then adopted.
function adoptedCopy(t, f) {
  const copy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-retention-copy-")));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  fs.cpSync(f.root, copy, { recursive: true });
  const projectFile = path.join(copy, f.storage.directory, "project.json");
  fs.writeFileSync(
    projectFile,
    JSON.stringify({ ...JSON.parse(fs.readFileSync(projectFile)), projectRoot: "C:/unverified-origin/synthetic-project" }, null, 2) + "\n",
  );
  const manifestFile = path.join(copy, f.storage.directory, "generated/manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  manifest.managed.find((entry) => entry.path === f.storage.directory + "/project.json").sha256 = sha256Hex(fs.readFileSync(projectFile));
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  assert.equal(adoptVerifiedProjectCopy({ root: copy, pluginRoot }).status, "verified-copy-adopted");
  return copy;
}

// Storage GC itself refuses on any adopted folder copy (its snapshots name the
// original root); that refusal is older than retention and the control shows it.
test("H2 condition 6: a Project copied as a folder and adopted carries its release records and its policy file, and its readers say released", async (t) => {
  // Control: storage GC on an adopted copy refuses for reasons that have nothing to do with retention.
  const control = project(t);
  for (let i = 0; i < 2; i += 1) await control.next();
  const controlCopy = adoptedCopy(t, control);
  const controlApply = await applySnapshotGarbageCollection({ root: controlCopy });
  const controlCodes = [...new Set((controlApply.coverage?.issues || []).map((item) => item.reasonCode))].sort();
  t.diagnostic("storage GC on an adopted copy without retention: " + controlApply.code + " " + controlCodes.join(","));
  const f = project(t);
  for (let i = 0; i < 4; i += 1) await f.next();
  const policyFile = path.join(f.store, "refresh/snapshot-retention.json");
  fs.writeFileSync(policyFile, JSON.stringify({ schemaVersion: 1, keepCount: 1, keepDays: 0 }));
  const applied = await applySnapshotGarbageCollection({ root: f.root });
  assert.equal(applied.status, "gc_applied");
  assert.equal(applied.retention.source, "project-file");
  const oldest = receiptsOldestFirst(f)[0];
  const copy = adoptedCopy(t, f);
  // The window travels with the copy (ordered by the copy's own file times).
  assert.equal(inspectSnapshotGarbageCollection({ root: copy }).retention.source, "project-file");
  // The records travel byte for byte.
  const directory = path.join(copy, f.storage.directory, "refresh/retention-releases");
  assert.deepEqual(fs.readdirSync(directory).sort(), releaseFiles(f));
  for (const name of releaseFiles(f)) assert(fs.readFileSync(path.join(directory, name)).equals(fs.readFileSync(path.join(releaseDirectory(f), name))));
  // The copy reads released history as released.
  const read = await readIncrementalRefreshReceipt({ root: copy, refreshReceiptId: oldest, allowReleased: true });
  assert.equal(read.status, "released-by-retention");
  // Storage GC on the copy refuses exactly as it does on a copy that never used retention: no retention release issue of its own.
  const plain = await applySnapshotGarbageCollection({ root: copy });
  assert.equal(plain.code, controlApply.code);
  assert(!(plain.coverage?.issues || []).some((item) => /^RETENTION_RELEASE_/.test(item.reasonCode)));
});

// ---------- review round 3 ----------

test("J1: a file of the user's own in the product graph folder and a mailbox file do not split the preview from the apply", async (t) => {
  const f = project(t);
  for (let i = 0; i < 5; i += 1) await f.next();
  const folder = path.join(f.store, "context/product-graph");
  fs.mkdirSync(path.join(folder, "my sketches"), { recursive: true });
  fs.writeFileSync(path.join(folder, "sketch.xyz"), Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]));
  fs.writeFileSync(path.join(folder, "notes.txt"), "my notes");
  fs.writeFileSync(path.join(folder, "my sketches", "a.bin"), Buffer.from([0xc3, 0x28]));
  fs.mkdirSync(path.join(f.store, "messaging", "inbox"), { recursive: true });
  fs.writeFileSync(path.join(f.store, "messaging", "inbox", "mail.eml"), Buffer.from([0xff, 0x00]));
  for (const retention of [WINDOW, null]) {
    const dry = inspectSnapshotGarbageCollection({ root: f.root, retention });
    assert.equal(dry.applyAvailable, true, JSON.stringify(dry.coverage.issues));
    assert(!dry.coverage.issues.some((item) => /product-graph|messaging/.test(item.path)), JSON.stringify(dry.coverage.issues));
  }
  const dry = inspectSnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  const applied = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  assert.equal(applied.status, "gc_applied", JSON.stringify(applied.coverage?.issues));
  assert.deepEqual(deletedIds(applied), reclaimIds(dry));
  assert(fs.existsSync(path.join(folder, "sketch.xyz")) && fs.existsSync(path.join(f.store, "messaging", "inbox", "mail.eml")));
});

test("J2: a Capsule compiled on a World with a parent keeps that parent under a window, so later runs without a window find nothing missing", async (t) => {
  const f = project(t);
  const parent = await f.next();
  const child = await f.next();
  const capsule = await compileContext({ root: f.root, task: "Explain add", budget: 32768, persist: true });
  assert.equal(capsule.status, "compiled");
  const capsuleFile = path.join(f.store, "context/capsules", capsule.capsule.capsuleId + ".json");
  const parentSource = (await readWorldModelSnapshot({ root: f.root, worldModelId: parent })).snapshot.temporalProvenanceGraph.sourceSnapshotId;
  const capsuleText = fs.readFileSync(capsuleFile, "utf8");
  assert(capsuleText.includes(child), "the Capsule names the World it was compiled on");
  assert(/"parentSourceSnapshotIds":\s*\[[^\]]*"/.test(capsuleText) && capsuleText.includes(parentSource), "and lists that World's parent");
  for (let i = 0; i < 4; i += 1) await f.next();
  const windowed = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  assert.equal(windowed.status, "gc_applied", JSON.stringify(windowed.coverage?.issues));
  assert.ok(windowed.deletedCount > 0);
  assert(worldFile(f, parent), "the parent the Capsule lists stays");
  assert(worldFile(f, child));
  const dry = inspectSnapshotGarbageCollection({ root: f.root });
  assert.equal(dry.applyAvailable, true, JSON.stringify(dry.coverage.issues));
  assert.deepEqual(referenceIssues(dry), []);
  const plain = await applySnapshotGarbageCollection({ root: f.root });
  assert.equal(plain.status, "gc_applied", JSON.stringify({ code: plain.code, issues: plain.coverage?.issues }));
});

test("J5: an apply's releases are split so no record nears the reader's bound; all of them read back", async (t) => {
  const f = project(t);
  await f.next();
  const projectId = inspectProject(f.root).project.projectId;
  const released = Array.from({ length: 4500 }, (_, n) => {
    const world = "world-model-" + n.toString(16).padStart(24, "0");
    return {
      id: world,
      hash: n.toString(16).padStart(64, "0"),
      identityIds: [world, "source-snapshot-" + n.toString(16).padStart(24, "0")],
      rule: "outside-retention-window",
    };
  });
  const documents = planRetentionReleases({
    projectId,
    policy: { source: "options", keepCount: 1, keepDays: 0 },
    collectionAttemptId: "snapshot-collection-test",
    releasedAt: "2026-11-17T00:00:00.000Z",
    released,
  });
  assert.equal(documents.length, 3);
  for (const document of documents) {
    assert.ok(Buffer.byteLength(JSON.stringify(document, null, 2)) < RETENTION_RELEASE_MAX_BYTES / 2);
    writeRetentionRelease({ root: f.root, storage: f.storage, document });
  }
  const read = readRetentionReleases({ root: f.root, storage: f.storage, projectId });
  assert.deepEqual(read.problems, []);
  assert.equal(read.records.length, 3);
  assert.equal(read.released.size, 9000);
});

test("J5: a record write that fails deletes nothing and leaves no record", async (t) => {
  const f = project(t);
  for (let i = 0; i < 4; i += 1) await f.next();
  const names = worldIds(f);
  const originalLink = fs.linkSync;
  fs.linkSync = function (from, to, ...args) {
    if (String(to).includes("retention-release-")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return originalLink.call(fs, from, to, ...args);
  };
  let applied;
  try {
    applied = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  } finally {
    fs.linkSync = originalLink;
  }
  assert.equal(applied.status, "gc_preserved");
  assert.equal(applied.code, "ENOSPC");
  assert.equal(applied.deletedCount, 0);
  assert.deepEqual(worldIds(f), names);
  assert.deepEqual(releaseFiles(f), []);
  assert.match(formatCliResult("storage-gc", applied), /Retention window in force/);
});

test("J6: a staging file an interrupted record create left, alone or hard-linked to its record, is named and ignored", async (t) => {
  const f = project(t);
  for (let i = 0; i < 4; i += 1) await f.next();
  const applied = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  const record = path.join(f.root, applied.retentionRelease.path);
  const name = path.basename(record);
  // The pair a crash between link and unlink leaves.
  const pair = path.join(path.dirname(record), "." + name + ".0f0e0d0c-0b0a-4908-8706-050403020100.tmp");
  fs.linkSync(record, pair);
  // A staging file whose record was never published.
  fs.writeFileSync(path.join(path.dirname(record), ".retention-release-" + "b".repeat(24) + ".json.1f0e0d0c-0b0a-4908-8706-050403020100.tmp"), "{");
  const dry = inspectSnapshotGarbageCollection({ root: f.root });
  assert.equal(dry.applyAvailable, true, JSON.stringify(dry.coverage.issues));
  assert.equal(dry.retention.releaseStaging.length, 2);
  assert.deepEqual(referenceIssues(dry), []);
  const plain = await applySnapshotGarbageCollection({ root: f.root });
  assert.equal(plain.status, "gc_applied", JSON.stringify({ code: plain.code, issues: plain.coverage?.issues }));
  assert.equal(
    (await readIncrementalRefreshReceipt({ root: f.root, refreshReceiptId: receiptsOldestFirst(f)[0], allowReleased: true })).status,
    "released-by-retention",
  );
});

test("J7/J8: a refused apply says which retention was in force; internal receipt readers never take a released World as present", async (t) => {
  const f = project(t);
  for (let i = 0; i < 4; i += 1) await f.next();
  const applied = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  const oldest = receiptsOldestFirst(f)[0];
  await assert.rejects(readIncrementalRefreshReceipt({ root: f.root, refreshReceiptId: oldest }), { code: "WORLD_MODEL_SNAPSHOT_RELEASED" });
  fs.writeFileSync(path.join(f.root, applied.retentionRelease.path), "{");
  const refused = await applySnapshotGarbageCollection({ root: f.root });
  assert.equal(refused.code, "SNAPSHOT_GC_REFERENCE_COVERAGE_INCOMPLETE");
  assert.equal(refused.retention.mode, "off");
  assert.match(formatCliResult("storage-gc", refused), /Retention is off/);
});

test("J11: a record from another Project is an issue that names it", async (t) => {
  const f = project(t);
  for (let i = 0; i < 2; i += 1) await f.next();
  const document = buildRetentionRelease({
    projectId: "lode-" + "0".repeat(20),
    policy: { source: "options", keepCount: 1, keepDays: 0 },
    collectionAttemptId: "snapshot-collection-other",
    released: [{ id: "world-model-" + "c".repeat(24), hash: "c".repeat(64), identityIds: ["world-model-" + "c".repeat(24)], rule: "outside-retention-window" }],
  });
  const written = writeRetentionRelease({ root: f.root, storage: f.storage, document });
  const dry = inspectSnapshotGarbageCollection({ root: f.root });
  assert(
    dry.coverage.issues.some((item) => item.reasonCode === "RETENTION_RELEASE_PROJECT_MISMATCH" && item.path === written),
    JSON.stringify(dry.coverage.issues),
  );
});

test("J11: two applies at once delete each snapshot once and record only what each deleted", async (t) => {
  const f = project(t);
  for (let i = 0; i < 5; i += 1) await f.next();
  const results = await Promise.all([
    applySnapshotGarbageCollection({ root: f.root, retention: WINDOW }),
    applySnapshotGarbageCollection({ root: f.root, retention: WINDOW }),
  ]);
  const statuses = results.map((item) => item.status).sort();
  t.diagnostic("statuses: " + statuses.join(", "));
  const deleted = results.flatMap((item) => deletedIds(item));
  assert.equal(new Set(deleted).size, deleted.length, "nothing deleted twice");
  assert.equal(
    releaseFiles(f).length,
    results.reduce((sum, item) => sum + (item.retentionRelease?.records.length || 0), 0),
  );
  const dry = inspectSnapshotGarbageCollection({ root: f.root });
  assert.deepEqual(referenceIssues(dry), []);
});

test("J11: keepDays through a real apply keeps a World written inside the days and releases older ones", async (t) => {
  const f = project(t);
  const ids = [];
  for (let i = 0; i < 5; i += 1) ids.push(await f.next());
  const [w1, w2, w3] = ids;
  const now = Date.now();
  const at = (id, ms) => {
    const file = worldFile(f, id);
    fs.utimesSync(file, new Date(ms), new Date(ms));
  };
  at(w1, now - 10 * 86400000);
  at(w2, now - 12 * 3600000);
  at(w3, now - 10 * 86400000);
  const applied = await applySnapshotGarbageCollection({ root: f.root, retention: { keepCount: 1, keepDays: 2 } });
  assert.equal(applied.status, "gc_applied", JSON.stringify(applied.coverage?.issues));
  assert(worldFile(f, w2), "written 12 hours ago, inside 2 days");
  assert.equal(worldFile(f, w1), null);
  assert.equal(worldFile(f, w3), null);
});

test("J11: after a windowed apply the next refresh takes the full path once and then the fast path again", async (t) => {
  const f = project(t);
  for (let i = 0; i < 4; i += 1) await f.next();
  assert.equal((await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW })).status, "gc_applied");
  const first = await refreshWorldModel({ root: f.root });
  assert.equal(first.status, "unchanged");
  assert.notEqual(first.diagnostics?.repositoryScan?.executionMode, "stat-cache-unchanged");
  const second = await refreshWorldModel({ root: f.root });
  assert.equal(second.status, "unchanged");
  assert.equal(second.diagnostics?.repositoryScan?.executionMode, "stat-cache-unchanged");
});

// ---------- review round 4 ----------

const recordsNaming = (result) => result.retention?.recordsNamingReleased;

test("K1: records written after a windowed apply that name a released snapshot are reported on every run and never block GC", async (t) => {
  const f = project(t);
  for (let i = 0; i < 4; i += 1) await f.next();
  const applied = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  assert.equal(applied.status, "gc_applied");
  const releasedWorld = deletedIds(applied).find((id) => id.startsWith("world-model-"));
  const record = JSON.parse(fs.readFileSync(path.join(f.root, applied.retentionRelease.path), "utf8"));
  const entry = record.released.find((item) => item.id === releasedWorld);
  // A knowledge decision by id, written after the release.
  const knowledgeFile = path.join(f.store, "context/knowledge.json");
  const knowledge = JSON.parse(fs.readFileSync(knowledgeFile, "utf8"));
  knowledge.decisions.push({ decisionId: "late-pin", summary: "Pins a World retention already released", worldModelId: releasedWorld });
  // And one by its hash (the released one's own hash: reported).
  knowledge.decisions.push({ decisionId: "late-hash", summary: "Names it by hash", worldModelHash: entry.hash });
  fs.writeFileSync(knowledgeFile, JSON.stringify(knowledge));
  // Session work and a checkpoint that quote the id out of storage-gc output.
  recordSessionWorkEvidence({ root: f.root, input: { summary: "storage-gc said " + releasedWorld + " was released" } });
  checkpointFor({ root: f.root, purpose: "Keep going", currentPosition: "Looked at " + releasedWorld, nextExpectedResult: "Continue" });
  for (const round of [1, 2])
    for (const retention of [null, WINDOW]) {
      const dry = inspectSnapshotGarbageCollection({ root: f.root, retention });
      assert.equal(dry.applyAvailable, true, `round ${round}: ${JSON.stringify(dry.coverage.issues)}`);
      assert.deepEqual(referenceIssues(dry), []);
      const named = recordsNaming(dry);
      assert.ok(named?.count >= 3, JSON.stringify(dry.retention));
      for (const item of named.entries) assert.equal(item.id, releasedWorld);
      assert(named.entries.some((item) => item.path.endsWith("context/knowledge.json")));
      assert(named.entries.every((item) => item.record === applied.retentionRelease.path && item.releasedAt === record.releasedAt));
      assert.match(formatCliResult("storage-gc", dry), /Records that name a snapshot retention released: \d+ reference/);
      const run = await applySnapshotGarbageCollection({ root: f.root, retention });
      assert.equal(run.status, "gc_applied", `round ${round}: ${JSON.stringify({ code: run.code, issues: run.coverage?.issues })}`);
      assert.ok(recordsNaming(run)?.count >= 3);
      assert.match(formatCliResult("storage-gc", run), /Records that name a snapshot retention released/);
    }
  // A hash that is not the released one's is still an issue.
  const wrong = { decisionId: "wrong-hash", summary: "Wrong hash", worldModelHash: releasedWorld.slice("world-model-".length) + "0".repeat(40) };
  assert.notEqual(wrong.worldModelHash, entry.hash);
  knowledge.decisions.push(wrong);
  fs.writeFileSync(knowledgeFile, JSON.stringify(knowledge));
  const refused = await applySnapshotGarbageCollection({ root: f.root });
  assert.equal(refused.code, "SNAPSHOT_GC_REFERENCE_COVERAGE_INCOMPLETE");
  assert(refused.coverage.issues.some((item) => item.reasonCode === "RETAINED_WORLD_HASH_UNAVAILABLE" && item.path.endsWith("context/knowledge.json")));
});

test("K1: a Capsule compiled after the apply that lists a released parent is reported and never blocks GC", async (t) => {
  const f = project(t);
  for (let i = 0; i < 4; i += 1) await f.next();
  const applied = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  assert.equal(applied.status, "gc_applied");
  const record = JSON.parse(fs.readFileSync(path.join(f.root, applied.retentionRelease.path), "utf8"));
  const releasedWorld = record.released.find((item) => item.id.startsWith("world-model-"));
  const releasedSource = releasedWorld.identityIds.find((id) => id.startsWith("source-snapshot-"));
  // The current World now lists that released source snapshot as an extra parent.
  fs.writeFileSync(f.source, "def add(a, b):\n    return a + b + 999\n");
  const refreshed = await refreshWorldModel({ root: f.root, additionalParentSourceSnapshotIds: [releasedSource] });
  assert.equal(refreshed.status, "refreshed");
  const capsule = await compileContext({ root: f.root, task: "Explain add", budget: 32768, persist: true });
  assert.equal(capsule.status, "compiled");
  const capsuleFile = path.join(f.store, "context/capsules", capsule.capsule.capsuleId + ".json");
  assert(fs.readFileSync(capsuleFile, "utf8").includes(releasedSource), "the Capsule lists the released parent");
  for (const retention of [null, WINDOW]) {
    const dry = inspectSnapshotGarbageCollection({ root: f.root, retention });
    assert.equal(dry.applyAvailable, true, JSON.stringify(dry.coverage.issues));
    assert(
      recordsNaming(dry)?.entries.some((item) => item.id === releasedSource && item.path.endsWith(capsule.capsule.capsuleId + ".json")),
      JSON.stringify(dry.retention),
    );
    const run = await applySnapshotGarbageCollection({ root: f.root, retention });
    assert.equal(run.status, "gc_applied", JSON.stringify({ code: run.code, issues: run.coverage?.issues }));
  }
  assert.equal(readContextCapsule({ root: f.root, capsuleId: capsule.capsule.capsuleId }).capsule.capsuleId, capsule.capsule.capsuleId);
});

test("K2 unit: one rule for a reference to a snapshot that is not stored", () => {
  const id = (n) => "world-model-" + String(n).padStart(24, "0");
  const hash = (n) => String(n).padStart(24, "0") + "a".repeat(40);
  const released = new Map(
    [1, 2, 3, 4, 5, 6].map((n) => [
      id(n),
      {
        releaseId: "retention-release-" + "a".repeat(24),
        releasedAt: "2026-11-17T00:00:00.000Z",
        snapshotId: id(n),
        hash: hash(n),
        path: ".lode/refresh/retention-releases/r.json",
      },
    ]),
  );
  const kept = {
    id: id(9),
    path: ".lode/world-model/snapshots/" + id(9) + ".json.gz",
    identityIds: [id(9)],
    references: [id(9), id(1), id(2)],
    ancestryIds: [id(1)],
  };
  const roots = [
    {
      path: ".lode/context/knowledge.json",
      relative: "context/knowledge.json",
      references: [id(9), id(3)],
      requiredWorldHashes: [hash(5), id(6).slice(12) + "b".repeat(40)],
    },
    {
      path: ".lode/refresh/receipts/incremental-refresh-receipt-old.json",
      relative: "refresh/receipts/incremental-refresh-receipt-old.json",
      references: [id(4), id(7)],
    },
  ];
  const issues = [];
  const { releasedReferences } = selectRetainedClosure({
    snapshots: [kept],
    roots,
    decision: { preserveAllHistory: true },
    issue: (path, reasonCode) => issues.push({ path, reasonCode }),
    released,
  });
  const by = (kind) =>
    releasedReferences
      .filter((item) => item.kind === kind)
      .map((item) => item.id)
      .sort();
  assert.deepEqual(by("released-history"), [id(1), id(4)], "a snapshot's own lineage and an older receipt");
  assert.deepEqual(by("released-in-record"), [id(3), id(5)], "a record by id, and by the released one's own hash");
  // World 2 in a stored snapshot's content, World 6 by a hash that is not its own, World 7 named by no record.
  assert.deepEqual(issues.map((item) => item.reasonCode + " " + item.path).sort(), [
    "RETAINED_SNAPSHOT_REFERENCE_UNAVAILABLE .lode/refresh/receipts/incremental-refresh-receipt-old.json",
    "RETAINED_SNAPSHOT_REFERENCE_UNAVAILABLE .lode/world-model/snapshots/" + id(9) + ".json.gz",
    "RETAINED_WORLD_HASH_UNAVAILABLE .lode/context/knowledge.json",
  ]);
});

test("K3: a link or a special file inside a mailbox or a folder of the user's own does not stop the preview, as it does not stop the apply", async (t) => {
  const f = project(t);
  for (let i = 0; i < 4; i += 1) await f.next();
  const mailbox = path.join(f.store, "messaging", "inbox");
  const mine = path.join(f.store, "context/product-graph", "my folder");
  fs.mkdirSync(mailbox, { recursive: true });
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mailbox, "a.eml"), "x");
  fs.writeFileSync(path.join(mine, "a.bin"), "x");
  // A hard link pair is a "special" file to storage GC (nlink 2).
  fs.linkSync(path.join(mailbox, "a.eml"), path.join(mailbox, "b.eml"));
  fs.linkSync(path.join(mine, "a.bin"), path.join(mine, "b.bin"));
  let linked = true;
  try {
    fs.symlinkSync(path.join(f.root, "example.py"), path.join(mailbox, "link.py"));
  } catch {
    linked = false;
  }
  t.diagnostic("symlink created: " + linked);
  for (const retention of [null, WINDOW]) {
    const dry = inspectSnapshotGarbageCollection({ root: f.root, retention });
    assert.equal(dry.applyAvailable, true, JSON.stringify(dry.coverage.issues));
    assert(!dry.coverage.issues.some((item) => /messaging|product-graph/.test(item.path)), JSON.stringify(dry.coverage.issues));
  }
  const dry = inspectSnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  const applied = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  assert.equal(applied.status, "gc_applied", JSON.stringify(applied.coverage?.issues));
  assert.deepEqual(deletedIds(applied), reclaimIds(dry));
});

test("K4: the windowed preview says what it did not check", async (t) => {
  const f = project(t);
  for (let i = 0; i < 3; i += 1) await f.next();
  const dry = inspectSnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  assert.deepEqual(dry.retention.checksNotMade, ["filesystem qualification", "an active storage GC elsewhere"]);
  assert.match(
    formatCliResult("storage-gc", dry),
    /Not checked by this preview \(the apply checks them\): filesystem qualification, an active storage GC elsewhere\./,
  );
  assert.equal(inspectSnapshotGarbageCollection({ root: f.root }).retention.checksNotMade, undefined);
});

test("K5: the apply result names staging leftovers too", async (t) => {
  const f = project(t);
  for (let i = 0; i < 4; i += 1) await f.next();
  const applied = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  const record = path.join(f.root, applied.retentionRelease.path);
  fs.linkSync(record, path.join(path.dirname(record), "." + path.basename(record) + ".0f0e0d0c-0b0a-4908-8706-050403020100.tmp"));
  const plain = await applySnapshotGarbageCollection({ root: f.root });
  assert.equal(plain.status, "gc_applied");
  assert.equal(plain.retention.releaseStaging.length, 1);
  assert.match(formatCliResult("storage-gc", plain), /Staging file\(s\) an interrupted release record create left: 1/);
});

test("K6/J8: every internal reader of an old receipt refuses a released World", async (t) => {
  const f = project(t);
  for (let i = 0; i < 4; i += 1) await f.next();
  const applied = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  assert.equal(applied.status, "gc_applied");
  const oldest = receiptsOldestFirst(f)[0];
  // Post-refresh projection receipt reader.
  const postDirectory = path.join(f.store, "document-projection/post-refresh/receipts");
  const post = fs
    .readdirSync(postDirectory)
    .map((name) => JSON.parse(fs.readFileSync(path.join(postDirectory, name), "utf8")))
    .find((item) => item.refresh.refreshReceiptId === oldest);
  assert.ok(post, "a post-refresh receipt names the oldest refresh receipt");
  await assert.rejects(readPostRefreshProjectionReceipt({ root: f.root, postRefreshProjectionReceiptId: post.postRefreshProjectionReceiptId }), {
    code: "WORLD_MODEL_SNAPSHOT_RELEASED",
  });
  // The Conformance trigger adapter.
  const registry = new ConformanceTriggerRegistry();
  const source = registry.register({ root: f.root, sourceKey: "refresh", triggerKinds: ["refresh-receipt"], mode: "opportunistic" });
  await assert.rejects(registry.enqueue({ root: f.root, sourceId: source.sourceId, trigger: { kind: "refresh-receipt", artifactId: oldest } }), {
    code: "WORLD_MODEL_SNAPSHOT_RELEASED",
  });
  // The receipt reader without allowReleased (inspectIncrementalRefresh and the
  // refresh-trigger delivery reader call it this way).
  await assert.rejects(readIncrementalRefreshReceipt({ root: f.root, refreshReceiptId: oldest }), { code: "WORLD_MODEL_SNAPSHOT_RELEASED" });
});

test("K6/J8: a store with refresh-trigger deliveries is refused by storage GC before any release, so a delivery never reads a released World", async (t) => {
  const f = project(t);
  for (let i = 0; i < 2; i += 1) await f.next();
  for (let i = 0; i < 2; i += 1) {
    fs.appendFileSync(f.source, "\n# trigger " + i + "\n");
    const delivered = await processRefreshTriggerBatch({
      root: f.root,
      sourceKind: "ci",
      events: [{ kind: "project-signal", operation: "build", path: null, evidenceId: "ci-build-000" + i }],
    });
    assert.equal(delivered.status, "refreshed");
  }
  const applied = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  t.diagnostic(JSON.stringify({ status: applied.status, code: applied.code, issues: applied.coverage?.issues?.slice(0, 3) }));
  assert.equal(applied.code, "SNAPSHOT_GC_REFERENCE_COVERAGE_INCOMPLETE");
  assert(applied.coverage.issues.some((item) => item.reasonCode === "UNSUPPORTED_GC_STORAGE_DIRECTORY" && /refresh\/triggers/.test(item.path)));
  assert.equal(applied.deletedCount, 0);
  assert.deepEqual(releaseFiles(f), []);
});

test("K6/J5: an apply writes several records when it releases more than one record holds; a failed later write names the ones already written and deletes nothing", async (t) => {
  const f = project(t);
  for (let i = 0; i < 5; i += 1) await f.next();
  const names = worldIds(f);
  // The second record's create fails.
  const originalLink = fs.linkSync;
  let creates = 0;
  fs.linkSync = function (from, to, ...args) {
    if (String(to).includes("retention-release-") && ++creates === 2) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return originalLink.call(fs, from, to, ...args);
  };
  let failed;
  try {
    failed = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW, maxReleaseEntries: 2 });
  } finally {
    fs.linkSync = originalLink;
  }
  assert.equal(failed.code, "ENOSPC");
  assert.equal(failed.deletedCount, 0);
  assert.deepEqual(worldIds(f), names);
  assert.equal(failed.retentionRelease.writtenBeforeFailure, true);
  assert.equal(failed.retentionRelease.records.length, 1);
  assert.deepEqual(releaseFiles(f), [path.basename(failed.retentionRelease.records[0].path)]);
  // Nothing it lists is missing: everything is still stored.
  assert.deepEqual(referenceIssues(inspectSnapshotGarbageCollection({ root: f.root })), []);
  // A real apply with small records.
  const applied = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW, maxReleaseEntries: 2 });
  assert.equal(applied.status, "gc_applied", JSON.stringify(applied.coverage?.issues));
  assert.ok(applied.retentionRelease.records.length >= 2);
  assert.equal(
    applied.retentionRelease.count,
    applied.retentionRelease.records.reduce((sum, item) => sum + item.count, 0),
  );
  assert.ok(applied.retentionRelease.records.every((item) => item.count <= 2));
  assert.deepEqual(referenceIssues(inspectSnapshotGarbageCollection({ root: f.root })), []);
});

test("K6/J9: the windowed preview refuses a store whose pointers need a newer reader, as the apply does", async (t) => {
  const f = project(t);
  for (let i = 0; i < 4; i += 1) await f.next();
  const pointerFile = path.join(f.store, "world-model/current.json");
  const pointer = JSON.parse(fs.readFileSync(pointerFile, "utf8"));
  pointer.readerRequirements.minimumReader = "9.9.9";
  fs.writeFileSync(pointerFile, JSON.stringify(pointer));
  const dry = inspectSnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  assert.equal(dry.applyAvailable, false);
  assert.equal(dry.reclaimableBytes, 0);
  assert(
    dry.coverage.issues.some((item) => item.reasonCode === "STORAGE_VERSION_MISMATCH"),
    JSON.stringify(dry.coverage.issues),
  );
  const applied = await applySnapshotGarbageCollection({ root: f.root, retention: WINDOW });
  assert.equal(applied.code, "STORAGE_VERSION_MISMATCH");
  assert.equal(applied.deletedCount, 0);
});

test("K6/J10: without a window or a release record no root or snapshot summary carries window bookkeeping; with a window they do", async (t) => {
  const f = project(t);
  for (let i = 0; i < 2; i += 1) await f.next();
  const plain = await buildSnapshotDeletionClosure({ root: f.root });
  assert.ok(
    plain.roots.some((row) => row.relative === "refresh/current.json"),
    "the roots are visible",
  );
  for (const row of [...plain.snapshots, ...plain.roots, ...plain.entries]) {
    assert.equal("ancestryIds" in row, false, row.path);
    assert.equal("namedRecordIds" in row, false, row.path);
    assert.equal("mtimeMs" in row, false, row.path);
  }
  const windowed = await buildSnapshotDeletionClosure({ root: f.root, retention: WINDOW });
  assert.ok(windowed.roots.find((row) => row.relative === "refresh/current.json").namedRecordIds.length > 0);
  assert.ok(windowed.snapshots.every((row) => Array.isArray(row.ancestryIds) && Number.isFinite(row.mtimeMs)));
});
