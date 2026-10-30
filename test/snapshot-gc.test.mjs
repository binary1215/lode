import { resolveVerifiedProcessSupervisor, spawnSupervisedProcess } from "../scripts/lib/runtime-process-supervisor.mjs";
import { createSourceObservation, sourceBundleKey, retainSourceFailure, readSourceObservationOriginal, readSourceFailure } from "../scripts/lib/source-observation.mjs";
import { SnapshotBackendReclamation } from "../scripts/lib/snapshot-backend-reclamation.mjs";
import { GitSnapshotStore, snapshotGitProcessStatus } from "../scripts/lib/git-snapshot-store.mjs";
import { prepareSourceContext } from "../scripts/lib/source-context-workflow.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import zlib from "node:zlib";
import { initializeProject, inspectProject } from "../scripts/lib/lode-core.mjs";
import { buildWorldModel, readWorldModel, readWorldModelSnapshot } from "../scripts/lib/world-model.mjs";
import { LocalJsonWorldModelStoreAdapter } from "../scripts/lib/world-model-store.mjs";
import { LocalJsonGraphProjectionAdapter } from "../scripts/lib/graph-projection-adapter.mjs";
import { compileContext, readContextCapsule } from "../scripts/lib/context-compiler.mjs";
import { diffGraphLineage } from "../scripts/lib/graph-lineage.mjs";
import { inspectSnapshotGarbageCollection, applySnapshotGarbageCollection } from "../scripts/lib/snapshot-gc.mjs";
import { withSnapshotReferences, withSnapshotReferencesAsync, beginSnapshotCollection, withSnapshotCollectionUnlink, finishSnapshotCollection } from "../scripts/lib/snapshot-reference-lifetime.mjs";
import { withRefreshWriterLease } from "../scripts/lib/refresh-writer-lease.mjs";
import { createRecoveryCheckpoint, readRecoveryCheckpoint } from "../scripts/lib/compaction-recovery.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { createLodeSession, withSessionRoute } from "../scripts/lib/session-routing.mjs";
import { recordSessionWorkEvidence, readSessionWorkContext } from "../scripts/lib/session-work-context.mjs";
import { createWholePlanSnapshot, createExecutionContract } from "../scripts/lib/execution-lineage.mjs";
import { startRun, finishRun, getPendingReviewContext, reviewRun, inspectRunStorageTransition } from "../scripts/lib/run-lineage.mjs";
import { recordChangeSet, readChangeSet } from "../scripts/lib/change-set.mjs";
import { buildSnapshotDeletionClosure, snapshotFileIdentity } from "../scripts/lib/snapshot-deletion-closure.mjs";
import { classifySnapshotFileSystem } from "../scripts/lib/snapshot-filesystem.mjs";
import { decodeSnapshotBytes } from "../scripts/lib/snapshot-storage-codec.mjs";
import { emptyProductModelDocument } from "../scripts/lib/product-model.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
// Exercise the real verified CI fixture at the internal capability-selection
// boundary. No copy, source/dist mutation or public Core option is needed.
if(process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT){
 const root=process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT;
 resolveVerifiedProcessSupervisor({pluginRoot:root});
 const previous=SnapshotBackendReclamation.prototype.selectSupervisor;
 const select=()=>resolveVerifiedProcessSupervisor({pluginRoot:root});
 test.after(()=>{if(SnapshotBackendReclamation.prototype.selectSupervisor===select)SnapshotBackendReclamation.prototype.selectSupervisor=previous;});
 SnapshotBackendReclamation.prototype.selectSupervisor=select;
}

const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function tree(root) {
  const result = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else result.push([path.relative(root, file), sha(fs.readFileSync(file))]);
    }
  }
  walk(root); return result;
}
async function fixture(t, syntheticRoot = null) {
  if(syntheticRoot)fs.mkdirSync(syntheticRoot,{recursive:true});
  const root = fs.realpathSync(syntheticRoot||fs.mkdtempSync(path.join(os.tmpdir(), "lode-gc-synthetic-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  fs.writeFileSync(path.join(root, "example.py"), "def add(a,b):\n    return a+b\n");
  fs.writeFileSync(path.join(root, storage.directory, "context/product-model.json"), JSON.stringify({ schemaVersion: 1,
    featureGroups: [{ key: "editing", name: "Editing", description: "Edit a document." }], capabilities: [], features: [], requirements: [], constraints: [], decisions: [] }));
  const built = await buildWorldModel({ root });
  return { root, storage, built, world: new LocalJsonWorldModelStoreAdapter({ projectRoot: root, storage }), graph: new LocalJsonGraphProjectionAdapter({ projectRoot: root, storage }) };
}
async function orphan(f, encoding = "gzip") {
  const source = path.join(f.root, "example.py"), before = fs.readFileSync(source);
  fs.writeFileSync(source, "def multiply(a,b):\n    return a*b\n");
  const built = await buildWorldModel({ root: f.root, persist: false });
  // This fixture specifically exercises whole JSON/gzip retirement. Rooted
  // default v2 parts and the separate mixed-domain tests remain active.
  const world = new LocalJsonWorldModelStoreAdapter({ projectRoot: f.root, storage: f.storage, snapshotEncoding: encoding, snapshotLayout: "whole" });
  const graph = new LocalJsonGraphProjectionAdapter({ projectRoot: f.root, storage: f.storage, snapshotEncoding: encoding, snapshotLayout: "whole" });
  const w = await world.writeSnapshot(built.snapshot.worldModelId, built.snapshot);
  const g = await graph.writeSnapshot(built.snapshot.temporalProvenanceGraph.graphSnapshotId, built.snapshot.temporalProvenanceGraph);
  fs.writeFileSync(source, before);
  return { built, files: [w.location, g.location] };
}

test("zero-write inspection and readers; explicit apply unlinks only verified orphan JSON/gzip", async t => {
  for (const encoding of ["json", "gzip"]) await t.test(encoding, async t => {
    const f = await fixture(t), extra = await orphan(f, encoding), before = tree(f.root);
    const dry = inspectSnapshotGarbageCollection({ root: f.root });
    assert.equal(dry.deletedCount, 0); assert.deepEqual(tree(f.root), before);
    await readWorldModel({ root: f.root }); assert.deepEqual(tree(f.root), before);
    const result = await applySnapshotGarbageCollection({ root: f.root });
    assert.equal(result.status, "gc_applied", JSON.stringify(result)); assert.equal(result.deletedCount, 2);
    assert(extra.files.every(file => !fs.existsSync(file)));
    assert.equal((await readWorldModel({ root: f.root })).snapshot.worldModelId, f.built.snapshot.worldModelId);
    assert.equal(result.recoveryAuthority, false); assert.equal(result.executionAuthority, false);
    assert.deepEqual(fs.readdirSync(path.join(f.root, f.storage.directory, ".snapshot-gc", "participants")), []);
  });
});

test("persisted Capsule and historical lineage remain readable after orphan cleanup", async t => {
  const f = await fixture(t);
  const capsule = await compileContext({ root: f.root, task: "inspect add", persist: true, budget: 32768 });
  const capsuleId = capsule.capsule?.capsuleId || capsule.capsuleId;
  fs.writeFileSync(path.join(f.root, "example.py"), "def subtract(a,b):\n    return a-b\n");
  const next = await buildWorldModel({ root: f.root });
  const checkpoint = createRecoveryCheckpoint({ root: f.root, purpose: "Synthetic recovery retention",
    currentPosition: "Inspect retained snapshots", nextExpectedResult: "Continue the same synthetic task" });
  await orphan(f);
  const result = await applySnapshotGarbageCollection({ root: f.root });
  assert.equal(result.status, "gc_applied", JSON.stringify(result));
  assert.equal(readContextCapsule({ root: f.root, capsuleId }).capsule.capsuleId, capsuleId);
  assert.equal(readRecoveryCheckpoint({ root: f.root, checkpointId: checkpoint.checkpoint.checkpointId }).checkpoint.checkpointDigest, checkpoint.checkpoint.checkpointDigest);
  assert.equal((await readWorldModelSnapshot({ root: f.root, worldModelId: f.built.snapshot.worldModelId })).snapshot.worldModelHash, f.built.snapshot.worldModelHash);
  const diff = await diffGraphLineage({ root: f.root, fromWorldModelId: f.built.snapshot.worldModelId, toWorldModelId: next.snapshot.worldModelId });
  assert(diff); assert.equal((await readWorldModel({ root: f.root })).snapshot.worldModelId, next.snapshot.worldModelId);
});

test("awaited and unawaited nested child lifetime makes GC yield until actual completion", async t => {
  const f = await fixture(t); await orphan(f);
  const gate = deferred(); let child;
  await withSnapshotReferencesAsync({ root: f.root }, async () => {
    child = withSnapshotReferencesAsync({ root: f.root }, async () => { await gate.promise; });
  });
  const blocked = await applySnapshotGarbageCollection({ root: f.root });
  assert.equal(blocked.status, "gc_yielded"); assert.equal(blocked.deletedCount, 0);
  gate.resolve(); await child;
  assert.equal((await applySnapshotGarbageCollection({ root: f.root })).deletedCount, 2);
});

test("start-and-finish ABA permanently invalidates an exact collection attempt", async t => {
  const f = await fixture(t); const attempt = beginSnapshotCollection({ root: f.root });
  assert.equal(attempt.status, "active");
  withSnapshotReferences({ root: f.root }, () => {});
  assert.throws(() => withSnapshotCollectionUnlink(attempt, () => assert.fail("must not reach unlink")), { code: "SNAPSHOT_COLLECTION_INVALIDATED" });
  assert.notEqual(beginSnapshotCollection({ root: f.root }).status, "active");
  finishSnapshotCollection(attempt);
});

test("real apply scan invalidates when an ordinary operation both starts and finishes", async t => {
  const f = await fixture(t); const extra = await orphan(f);
  const original = fs.openSync; let once = false;
  t.mock.method(fs, "openSync", function(file, ...args) {
    if (!once && typeof file === "string" && file === extra.files[0]) {
      once = true; withSnapshotReferences({ root: f.root }, () => {});
    }
    return original.call(this, file, ...args);
  });
  const result = await applySnapshotGarbageCollection({ root: f.root });
  assert(once); assert.equal(result.code, "SNAPSHOT_COLLECTION_INVALIDATED");
  assert.equal(result.deletedCount, 0); assert(extra.files.every(file => fs.existsSync(file)));
});

test("expired detached context cannot publish cached references after parent completion and GC", async t => {
  const f = await fixture(t); await orphan(f); const gate = deferred(); let detached, published = false;
  await withSnapshotReferencesAsync({ root: f.root }, async () => {
    detached = gate.promise.then(() => withSnapshotReferences({ root: f.root }, () => { published = true; }));
  });
  assert.equal((await applySnapshotGarbageCollection({ root: f.root })).deletedCount, 2);
  gate.resolve(); await assert.rejects(detached, { code: "SNAPSHOT_REFERENCE_LIFETIME_EXPIRED" });
  assert.equal(published, false);
});

test("registration failure never executes an unguarded publication even before a later GC", async t => {
  const f = await fixture(t); await orphan(f); let published = false;
  const original = fs.writeFileSync;
  const mocked = t.mock.method(fs, "writeFileSync", function(file, ...args) {
    if (String(file).includes(path.join(".snapshot-gc", "participants"))) throw Object.assign(new Error("synthetic permission failure"), { code: "EACCES" });
    return original.call(this, file, ...args);
  });
  assert.throws(() => withSnapshotReferences({ root: f.root }, () => { published = true; }), { code: "EACCES" });
  assert.equal(published, false); mocked.mock.restore();
  assert.equal((await applySnapshotGarbageCollection({ root: f.root })).deletedCount, 2);
});

test("borrowed refresh lease participates and direct pointer stays sync with missing-target rejection", async t => {
  const f = await fixture(t); await orphan(f);
  await withRefreshWriterLease({ projectRoot: f.root, projectId: f.storage.projectId, storage: f.storage }, async lease => {
    await withRefreshWriterLease({ projectRoot: f.root, projectId: f.storage.projectId, storage: f.storage, lease }, async () => {
      assert.equal((await applySnapshotGarbageCollection({ root: f.root })).status, "gc_yielded");
    });
  });
  const entry = f.world.readPointer(); const written = f.world.writePointer(entry.document);
  assert.equal(typeof written?.then, "undefined");
  assert.throws(() => f.world.writePointer({ ...entry.document, worldModelId: "world-model-" + "f".repeat(24) }), { code: "SNAPSHOT_POINTER_TARGET_MISSING" });
  assert.deepEqual(f.world.readPointer().document, entry.document);
});

test("unknown schema, retained mixed backend and unsafe storage preserve while ordinary reads work", async t => {
  for (const mode of ["unknown", "git", "hardlink"]) await t.test(mode, async t => {
    const f = await fixture(t); const extra = await orphan(f); const base = path.join(f.root, f.storage.directory);
    if (mode === "unknown") fs.writeFileSync(path.join(base, "future.json"), JSON.stringify({ schemaVersion: 999, kind: "FutureRoot" }));
    if (mode === "git") fs.mkdirSync(path.join(base, "snapshot-objects.git"));
    if (mode === "hardlink") fs.linkSync(extra.files[0], path.join(base, "unknown-link.json.gz"));
    const result = await applySnapshotGarbageCollection({ root: f.root });
    assert.equal(result.deletedCount, 0); assert.equal(result.applyAvailable, false);
    assert(extra.files.every(file => fs.existsSync(file)));
    assert.equal((await readWorldModel({ root: f.root })).snapshot.worldModelId, f.built.snapshot.worldModelId);
  });
});

test("partial I/O failure and cancellation retain exact completed deletion counts", async t => {
  for (const mode of ["io", "cancel"]) await t.test(mode, async t => {
    const f = await fixture(t); const extra = await orphan(f); const controller = new AbortController();
    const original = fs.unlinkSync; let deleted = 0;
    t.mock.method(fs, "unlinkSync", function(file) {
      if (extra.files.includes(String(file))) {
        if (mode === "io" && deleted === 1) throw Object.assign(new Error("synthetic I/O"), { code: "EIO" });
        const result = original.call(this, file); deleted += 1;
        if (mode === "cancel") controller.abort(); return result;
      }
      return original.call(this, file);
    });
    const result = await applySnapshotGarbageCollection({ root: f.root, signal: controller.signal });
    assert.equal(result.status, "gc_partial"); assert.equal(result.deletedCount, 1); assert.equal(result.deleted.length, 1);
    assert.equal(result.code, mode === "io" ? "EIO" : "SNAPSHOT_GC_CANCELLED");
    assert.equal(extra.files.filter(file => fs.existsSync(file)).length, 1);
    assert.equal(result.reclaimedBytes, result.deleted[0].bytes);
  });
});

test("CLI runCommand awaits explicit apply; no new MCP operation is required", async t => {
  const f = await fixture(t); await orphan(f);
  const result = await runCommand(["storage-gc", f.root, "--apply"]);
  assert.equal(result.status, "gc_applied", JSON.stringify(result)); assert.equal(result.deletedCount, 2);
  const before = tree(f.root), diagnostic = await runCommand(["storage-gc", f.root, "--diagnostics"]);
  assert.equal(diagnostic.status, "gc_dry_run"); assert.deepEqual(tree(f.root), before);
});

test("candidate replacement after typed scan is preserved by final exact file identity", async t => {
  const f = await fixture(t); const extra = await orphan(f); let replaced = false;
  const target = extra.files[1], bytes = fs.readFileSync(target);
  const fixedTime = new Date("2026-01-02T03:04:05.000Z");
  fs.utimesSync(target, fixedTime, fixedTime);
  const originalIdentity = snapshotFileIdentity(fs.lstatSync(target, { bigint: true }));
  const lstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", function(file, ...args) {
    if (!replaced && String(file) === target && new Error().stack.includes("withSnapshotCollectionUnlink")) {
      replaced = true; fs.unlinkSync(target); fs.writeFileSync(target, bytes); fs.utimesSync(target, fixedTime, fixedTime);
    }
    return lstat.call(this, file, ...args);
  });
  const result = await applySnapshotGarbageCollection({ root: f.root });
  assert(replaced);
  const replacementIdentity = snapshotFileIdentity(lstat(target, { bigint: true }));
  assert.equal(replacementIdentity.size, originalIdentity.size); assert.equal(replacementIdentity.mtime, originalIdentity.mtime);
  assert.notDeepEqual(replacementIdentity, originalIdentity);
  t.diagnostic(JSON.stringify({ case: "same-bytes-and-mtime-replacement", originalIdentity, replacementIdentity }));
  assert.equal(result.code, "SNAPSHOT_GC_CANDIDATE_DRIFT", JSON.stringify(result));
  assert.equal(result.deletedCount, 0); assert(extra.files.every(file => fs.existsSync(file)));
});

test("unknown/crashed owner is not age-reclaimed and ordinary publishers can invalidate it", async t => {
  const f = await fixture(t); const attempt = beginSnapshotCollection({ root: f.root });
  assert.equal(attempt.status, "active");
  const before = fs.readFileSync(attempt.file);
  assert.equal((await applySnapshotGarbageCollection({ root: f.root })).status, "gc_yielded");
  withSnapshotReferences({ root: f.root }, () => {});
  assert(fs.readFileSync(attempt.file).equals(before));
  finishSnapshotCollection(attempt);
});

test("direct asynchronous snapshot create/reuse holds lifetime through its actual read completion", async t => {
  for (const type of ["world", "graph"]) await t.test(type, async t => {
    const f = await fixture(t); const extra = await orphan(f), gate = deferred(), entered = deferred();
    const adapter = f[type], document = type === "world" ? extra.built.snapshot : extra.built.snapshot.temporalProvenanceGraph;
    const id = document.worldModelId || document.graphSnapshotId;
    const read = adapter.readSnapshot.bind(adapter);
    t.mock.method(adapter, "readSnapshot", async target => { entered.resolve(); await gate.promise; return read(target); });
    const writing = adapter.writeSnapshot(id, document);
    await entered.promise;
    assert.equal((await applySnapshotGarbageCollection({ root: f.root })).status, "gc_yielded");
    gate.resolve(); assert.equal((await writing).created, false);
    assert.equal((await applySnapshotGarbageCollection({ root: f.root })).deletedCount, 2);
  });
});

test("a second process blocks only collection; a crashed participant is preserved without PID guesses", async t => {
  const f = await fixture(t); await orphan(f);
  const moduleUrl = new URL("../scripts/lib/snapshot-reference-lifetime.mjs", import.meta.url).href;
  const source = `import readline from 'node:readline';import {withSnapshotReferencesAsync} from ${JSON.stringify(moduleUrl)};
    const input=readline.createInterface({input:process.stdin});
    await withSnapshotReferencesAsync({root:process.argv[1]},async()=>{
      console.log(JSON.stringify({phase:'held',pid:process.pid,parent:process.ppid,cwd:process.cwd(),started:new Date(performance.timeOrigin).toISOString(),ports:[]}));
      for await (const line of input){if(line==='crash')process.exit(23);if(line==='release')break;}
      input.close();
    });`;
  for (const mode of ["release", "crash"]) {
    const args = ["--input-type=module", "-e", source, f.root];
    t.diagnostic(JSON.stringify({ event: "planned-snapshot-participant", executable: process.execPath, args, cwd: f.root, parent: process.pid, ports: [], windowsHide: true }));
    const child = spawn(process.execPath, args, { cwd: f.root, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "", stdout = ""; const ready = deferred(), closed = deferred();
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout.includes('"phase":"held"')) ready.resolve(); });
    child.once("error", error => { stderr += error.message; ready.resolve(); closed.resolve({ code: null, error }); });
    child.once("close", (code, signal) => { ready.resolve(); closed.resolve({ code, signal }); });
    const timeout = setTimeout(() => { child.kill(); }, 15000);
    try {
      await ready.promise; assert(stdout.includes('"phase":"held"'), stderr);
      t.diagnostic(stdout.trim());
      const held = await applySnapshotGarbageCollection({ root: f.root });
      assert.equal(held.status, "gc_yielded");
      let ordinary = false; withSnapshotReferences({ root: f.root }, () => { ordinary = true; }); assert(ordinary);
      child.stdin.end(mode + "\n");
      const exit = await closed.promise; assert.equal(exit.code, mode === "release" ? 0 : 23, stderr);
      t.diagnostic(JSON.stringify({ event: "closed-snapshot-participant", pid: child.pid, ...exit, ports: [] }));
      if (mode === "crash") assert.equal((await applySnapshotGarbageCollection({ root: f.root })).status, "gc_yielded");
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.stdin.end("release\n"); await closed.promise; }
      clearTimeout(timeout);
    }
  }
});

test("normal SessionWork/Todo, selected Session, reviewed Run and ChangeSet retain exact originals while orphan cleanup works", async t => {
  const f = await fixture(t);
  const input = { summary: "Same synthetic task", todos: [{ todoId: "todo-retained", task: "Read retained history",
    status: "pending", origin: "head-proposed", nextAction: "Inspect the exact original" }] };
  const a = recordSessionWorkEvidence({ root: f.root, input });
  const selected = createLodeSession({ root: f.root, purpose: "Separate synthetic review" });
  const b = withSessionRoute(f.root, selected.sessionId, () => recordSessionWorkEvidence({ root: f.root, input }));
  assert.notEqual(a.evidence.evidenceId, b.evidence.evidenceId);
  const capsule = await compileContext({ root: f.root, task: "Change add", budget: 32768, persist: true });
  const plan = createWholePlanSnapshot({ root: f.root, objective: "Synthetic source update", plan: "Change then explicitly review" });
  const contract = createExecutionContract({ root: f.root, wholePlanId: plan.artifact.wholePlanId, capsuleId: capsule.capsule.capsuleId,
    scope: "Change example.py", acceptanceCriteria: ["Retain exact source lineage"] });
  const run = startRun({ root: f.root, executionContractId: contract.artifact.executionContractId });
  fs.appendFileSync(path.join(f.root, "example.py"), "\ndef subtract(a,b):\n    return a-b\n");
  const finished = finishRun({ root: f.root, outcome: "Synthetic source changed", evidence: [{ uri: "example.py", summary: "Added subtraction" }],
    verification: [{ check: "Synthetic source observation", status: "passed" }] });
  const pending = getPendingReviewContext({ root: f.root });
  const review = reviewRun({ root: f.root, reviewContextId: pending.review.reviewContextId, disposition: "accept", rationale: "Explicit synthetic review" });
  await buildWorldModel({ root: f.root });
  const change = await recordChangeSet({ root: f.root, resultPacketId: finished.resultPacket.resultPacketId, reviewDecisionId: review.reviewDecision.reviewDecisionId });
  const extra = await orphan(f), excluded = new Set(extra.files.map(file => path.relative(f.root, file)));
  const originals = tree(f.root).filter(([file]) => !excluded.has(file));
  const result = await withSessionRoute(f.root, selected.sessionId, async () => {
    const before = inspectProject(f.root).state.sessionId;
    const result = await applySnapshotGarbageCollection({ root: f.root });
    assert.equal(inspectProject(f.root).state.sessionId, before);
    assert.equal(readSessionWorkContext({ root: f.root }).records[0].evidenceId, b.evidence.evidenceId);
    return result;
  });
  assert.equal(result.status, "gc_applied", JSON.stringify(result)); assert.equal(result.deletedCount, 2);
  assert.deepEqual(tree(f.root), originals);
  assert.equal(readSessionWorkContext({ root: f.root }).records[0].evidenceId, a.evidence.evidenceId);
  assert.equal(readChangeSet({ root: f.root, changeSetId: change.changeSet.changeSetId }).changeSet.changeSetId, change.changeSet.changeSetId);
  assert.equal(inspectRunStorageTransition({ root: f.root }).status, "committed");
  assert(run);
});

test("another Session owner substituted into work evidence preserves candidates without merging or selecting it", async t => {
  const f = await fixture(t); const extra = await orphan(f);
  const selected = createLodeSession({ root: f.root, purpose: "Separate owner" });
  const work = withSessionRoute(f.root, selected.sessionId, () => recordSessionWorkEvidence({ root: f.root, input: { summary: "Exact owner" } }));
  const record = JSON.parse(fs.readFileSync(work.file, "utf8"));
  record.sessionId = inspectProject(f.root).state.sessionId;
  fs.writeFileSync(work.file, JSON.stringify(record));
  const before = tree(f.root), defaultId = inspectProject(f.root).state.sessionId;
  const result = await applySnapshotGarbageCollection({ root: f.root });
  assert.equal(result.deletedCount, 0); assert.equal(result.applyAvailable, false);
  assert(result.coverage.issues.some(row => row.reasonCode === "SESSION_WORK_EVIDENCE_INTEGRITY"));
  assert.equal(inspectProject(f.root).state.sessionId, defaultId);
  assert.deepEqual(tree(f.root), before); assert(extra.files.every(file => fs.existsSync(file)));
});

test("lifetime cleanup failure preserves a primary error and discloses an already completed operation", async t => {
  const f = await fixture(t); const unlink = fs.unlinkSync;
  t.mock.method(fs, "unlinkSync", function(file) {
    if (String(file).includes(path.join(".snapshot-gc", "participants"))) throw Object.assign(new Error("synthetic cleanup failure"), { code: "EIO" });
    return unlink.call(this, file);
  });
  const primary = Object.assign(new Error("original mutation failed"), { code: "SYNTHETIC_PRIMARY_ERROR" });
  assert.throws(() => withSnapshotReferences({ root: f.root }, () => { throw primary; }), error => error === primary && error.snapshotReferenceCleanup.code === "EIO");
  await assert.rejects(withSnapshotReferencesAsync({ root: f.root }, async () => { throw primary; }), error => error === primary);
  let effects = 0;
  assert.throws(() => withSnapshotReferences({ root: f.root }, () => { effects += 1; }), error => error.code === "EIO" && error.operationCompleted === true);
  assert.equal(effects, 1);
});

test("non-persisted lineage previews remain zero-write even when publisher registration is unavailable", async t => {
  const f = await fixture(t);
  const capsule = await compileContext({ root: f.root, task: "Inspect add", persist: true, budget: 32768 });
  const plan = createWholePlanSnapshot({ root: f.root, objective: "Stored synthetic plan", plan: "Inspect source" });
  const before = tree(f.root), write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", function(file, ...args) {
    if (String(file).includes(path.join(".snapshot-gc", "participants"))) throw Object.assign(new Error("synthetic registration denial"), { code: "EACCES" });
    return write.call(this, file, ...args);
  });
  assert(createWholePlanSnapshot({ root: f.root, objective: "Preview only", plan: "Inspect", persist: false }).artifact);
  assert(createExecutionContract({ root: f.root, wholePlanId: plan.artifact.wholePlanId, capsuleId: capsule.capsule.capsuleId,
    scope: "Preview", acceptanceCriteria: ["No writes"], persist: false }).artifact);
  assert.deepEqual(tree(f.root), before);
});

test("filesystem qualification rejects mapped network/unknown types without probing ordinary work", () => {
  assert.equal(classifySnapshotFileSystem({ platform: "win32", driveType: 3 }), "qualified-local");
  for (const driveType of [null, 0, 1, 2, 4, 5, 6]) assert.equal(classifySnapshotFileSystem({ platform: "win32", driveType }), "unsupported-or-unknown");
  assert.equal(classifySnapshotFileSystem({ platform: "linux", type: 0xef53 }), "qualified-local");
  assert.equal(classifySnapshotFileSystem({ platform: "linux", type: 0x6969 }), "unsupported-or-unknown");
  assert.equal(classifySnapshotFileSystem({ platform: "unknown" }), "unsupported-or-unknown");
});

test("GC retains reference summaries rather than decoded bodies; small metadata budget preserves all files", async t => {
  const f = await fixture(t); const extra = await orphan(f);
  for (let index = 0; index < 4; index += 1) await compileContext({ root: f.root, task: "Inspect add " + index, budget: 32768, persist: true });
  const before = tree(f.root);
  const complete = await buildSnapshotDeletionClosure({ root: f.root });
  assert.equal(complete.certified, true, JSON.stringify(complete.issues));
  assert(complete.decodedBytes > complete.summaryBytes);
  assert(complete.snapshots.every(row => !Object.hasOwn(row, "document")));
  const bounded = await buildSnapshotDeletionClosure({ root: f.root, maxSummaryBytes: 128 });
  assert.equal(bounded.certified, false); assert.equal(bounded.candidates.length, 0);
  assert(bounded.summaryBytes <= 128); assert(bounded.issues.some(row => row.reasonCode === "GC_REFERENCE_SUMMARY_LIMIT"));
  assert.deepEqual(tree(f.root), before); assert(extra.files.every(file => fs.existsSync(file)));
});

test("a queued same-process operation cancels a multi-file scan before deletion", async t => {
  const f = await fixture(t); const extra = await orphan(f); const open = fs.openSync; let queued = false, ordinary;
  t.mock.method(fs, "openSync", function(file, ...args) {
    if (!queued && String(file) === extra.files[0]) {
      queued = true;
      ordinary = new Promise(resolve => setImmediate(() => { withSnapshotReferences({ root: f.root }, () => {}); resolve(); }));
    }
    return open.call(this, file, ...args);
  });
  const result = await applySnapshotGarbageCollection({ root: f.root });
  await ordinary; assert(queued); assert.equal(result.code, "SNAPSHOT_COLLECTION_INVALIDATED");
  assert.equal(result.deletedCount, 0); assert(extra.files.every(file => fs.existsSync(file)));
});

test("unsupported placeholder retains ordinary bypass; eligible mixed publishers require their lifetime", async t => {
  for (const relative of ["snapshot-objects.git", "snapshot-bundles", "observations/source-bundles"]) await t.test(relative, async t => {
    const f = await fixture(t), base = path.join(f.root, f.storage.directory);
    // Marker-only fixture, not proof of a valid Git database or bundle.
    withSnapshotReferences({ root: f.root }, () => fs.mkdirSync(path.join(base, relative), { recursive: true }));
    const write = fs.writeFileSync;
    t.mock.method(fs, "writeFileSync", function(file, ...args) {
      if (String(file).includes(path.join(".snapshot-gc", "participants"))) throw Object.assign(new Error("synthetic registration denial"), { code: "EACCES" });
      return write.call(this, file, ...args);
    });
    if(relative!=="snapshot-objects.git"){assert.throws(()=>recordSessionWorkEvidence({root:f.root,input:{summary:"Eligible mixed publisher"}}),{code:"EACCES"});return;}
    assert.equal(recordSessionWorkEvidence({ root: f.root, input: { summary: "Ordinary unsupported-backend work" } }).status, "session_work_evidence_recorded");
    const result = await applySnapshotGarbageCollection({ root: f.root });
    assert.equal(result.deletedCount, 0); assert.equal(result.code, "UNVERIFIED_GC_GIT_BACKEND");
  });
});

test("backend exclusion requires cancellation of an earlier attempt and never bypasses an expired context", async t => {
  const f = await fixture(t), marker = path.join(f.root, f.storage.directory, "snapshot-objects.git");
  const attempt = beginSnapshotCollection({ root: f.root });
  fs.mkdirSync(marker); // Deliberately uncooperative transition must not authorize fallback.
  assert.throws(() => recordSessionWorkEvidence({ root: f.root, input: { summary: "Must not publish yet" } }), { code: "SNAPSHOT_REFERENCE_COORDINATION_UNAVAILABLE" });
  finishSnapshotCollection(attempt);
  assert.equal(recordSessionWorkEvidence({ root: f.root, input: { summary: "Future collector excluded" } }).status, "session_work_evidence_recorded");
  const gate = deferred(); let detached, published = false;
  // A fresh supported fixture exercises token expiry before the marker bypass.
  const other = await fixture(t);
  await withSnapshotReferencesAsync({ root: other.root }, async () => {
    fs.mkdirSync(path.join(other.root, other.storage.directory, "snapshot-objects.git"));
    detached = gate.promise.then(() => withSnapshotReferences({ root: other.root }, () => { published = true; }));
  });
  gate.resolve(); await assert.rejects(detached, { code: "SNAPSHOT_REFERENCE_LIFETIME_EXPIRED" }); assert.equal(published, false);
});

test("guarded backend creation keeps its exact cancellation and foreign/tampered attempts cannot bypass", async t => {
  const f = await fixture(t), marker = path.join(f.root, f.storage.directory, "snapshot-objects.git");
  const attempt = beginSnapshotCollection({ root: f.root });
  withSnapshotReferences({ root: f.root }, () => fs.mkdirSync(marker));
  assert.equal(recordSessionWorkEvidence({ root: f.root, input: { summary: "Cancelled attempt cannot delete" } }).status, "session_work_evidence_recorded");
  const original = fs.readFileSync(attempt.file), forged = JSON.parse(original);
  forged.host = "different-host"; fs.writeFileSync(attempt.file, JSON.stringify(forged));
  assert.throws(() => withSnapshotReferences({ root: f.root }, () => assert.fail("foreign attempt bypass")), { code: "SNAPSHOT_REFERENCE_COORDINATION_UNAVAILABLE" });
  fs.writeFileSync(attempt.file, original); finishSnapshotCollection(attempt);
});

test("a statically unsupported platform retains ordinary work without publisher registration", async t => {
  const f = await fixture(t), descriptor = Object.getOwnPropertyDescriptor(process, "platform"), write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", function(file, ...args) {
    if (String(file).includes(path.join(".snapshot-gc", "participants"))) throw Object.assign(new Error("synthetic registration denial"), { code: "EACCES" });
    return write.call(this, file, ...args);
  });
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" });
    assert.equal(recordSessionWorkEvidence({ root: f.root, input: { summary: "Unsupported-platform ordinary work" } }).status, "session_work_evidence_recorded");
    assert.equal((await applySnapshotGarbageCollection({ root: f.root })).code, "UNSUPPORTED_GC_PLATFORM");
  } finally { Object.defineProperty(process, "platform", descriptor); }
});

test("decoded-byte accounting measures UTF8 bytes and applies the bound before JSON parsing", () => {
  const text = JSON.stringify({ text: "한글".repeat(16) }), bytes = zlib.gzipSync(text); let measured = 0;
  assert.deepEqual(decodeSnapshotBytes(bytes, { compressed: true, onDecodedBytes: length => { measured = length; } }), JSON.parse(text));
  assert.equal(measured, Buffer.byteLength(text));
  measured = 0;
  assert.throws(() => decodeSnapshotBytes(bytes, { compressed: true, decodedBytes: 8, onDecodedBytes: length => { measured = length; } }), { code: "SNAPSHOT_STORAGE_LIMIT" });
  assert.equal(measured, 0);
});

test("cancelled Windows filesystem probe closes its owned child and preserves every original", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t); await orphan(f); const before = tree(f.root), controller = new AbortController(), events = [];
  const result = await applySnapshotGarbageCollection({ root: f.root, signal: controller.signal, onProcess: event => {
    events.push(event); if (event.event === "started") controller.abort();
  } });
  assert.equal(result.code, "SNAPSHOT_GC_CANCELLED"); assert.equal(result.deletedCount, 0);
  const started = events.find(event => event.event === "started"), closed = events.find(event => event.event === "closed");
  assert(started?.pid); assert.equal(closed?.pid, started.pid);
  assert.throws(() => process.kill(started.pid, 0), error => error.code === "ESRCH");
  assert.deepEqual(tree(f.root), before);
});

test("SessionWork raw-byte reference preserves its exact original, including Windows path case aliases", async t => {
  const f = await fixture(t); const extra = await orphan(f), original = fs.readFileSync(extra.files[0]);
  const relative = path.relative(f.root, extra.files[0]).replaceAll("\\", "/");
  recordSessionWorkEvidence({ root: f.root, input: { summary: "Keep the exact referenced source bytes", references: [{
    path: process.platform === "win32" ? relative.toUpperCase() : relative, digest: sha(original), kind: "source",
  }] } });
  const result = await applySnapshotGarbageCollection({ root: f.root });
  assert.equal(result.status, "gc_applied", JSON.stringify(result)); assert.equal(result.deletedCount, 0);
  assert(fs.readFileSync(extra.files[0]).equals(original));
});

test("existing Product schema 2 uses its original verifier rather than an unsupported-schema gate", async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, f.storage.directory, "context/product-model.json"), JSON.stringify(emptyProductModelDocument({ schemaVersion: 2 })));
  await orphan(f);
  const result = await applySnapshotGarbageCollection({ root: f.root });
  assert.equal(result.status, "gc_applied", JSON.stringify(result)); assert.equal(result.deletedCount, 2);
});


test("mixed GC reclaims actual loose and packed Git objects and shared domain orphans, preserving rooted history and source", async t => {
  const f=await fixture(t), events=[];
  const gitOptions={onProcess:event=>events.push(event)};
  const world=new LocalJsonWorldModelStoreAdapter({projectRoot:f.root,storage:f.storage,snapshotEncoding:"git",snapshotLayout:"domain-bundles-v1",gitOptions});
  const graph=new LocalJsonGraphProjectionAdapter({projectRoot:f.root,storage:f.storage,snapshotEncoding:"git",snapshotLayout:"domain-bundles-v1",gitOptions});
  fs.writeFileSync(path.join(f.root,"example.py"),"def kept(value):\n    return value + 1\n");
  const kept=await buildWorldModel({root:f.root,storeAdapter:world,graphProjectionAdapter:graph});
  const source=await prepareSourceContext({root:f.root,task:"Retain exact synthetic source",needs:[{kind:"source",path:"example.py"}],retain:true});
  assert(source.results?.some(row=>row.retained),JSON.stringify(source));
  const protectedRows=tree(f.root).filter(([file])=>!file.includes("snapshot-objects.git")&&!file.includes("snapshot-bundles"));
  const code=fs.readFileSync(path.join(f.root,"example.py"));
  fs.writeFileSync(path.join(f.root,"example.py"),"def orphan_only(value):\n    return value * 789\n");
  const extra=await buildWorldModel({root:f.root,persist:false});
  await world.writeSnapshot(extra.snapshot.worldModelId,extra.snapshot);
  await graph.writeSnapshot(extra.snapshot.temporalProvenanceGraph.graphSnapshotId,extra.snapshot.temporalProvenanceGraph);
  fs.writeFileSync(path.join(f.root,"example.py"),code);
  const store=new GitSnapshotStore({projectRoot:f.root,storage:f.storage,gitCommand:"git",onProcess:event=>events.push(event)});
  await store.invoke(["-c","pack.writeReverseIndex=false","pack-objects","--all","--threads=1",path.join(store.directory,"objects/pack/pack")],store.context(),{maxBytes:128});
  const result=await applySnapshotGarbageCollection({root:f.root,onProcess:event=>events.push(event)});
  assert(result.deleted.some(row=>row.path.endsWith(".pack")),JSON.stringify(result));
  assert.equal(result.status,"gc_applied",JSON.stringify(result));assert.equal(result.retiredRefCount,2);assert(result.deletedDomainBundles>0);assert(result.deletedObjectFiles>0);assert(result.publishedPackBytes>0);
  assert.equal(await store.read(extra.snapshot.worldModelId),null);
  assert.equal((await readWorldModel({root:f.root})).snapshot.worldModelHash,kept.snapshot.worldModelHash);
  assert.equal((await readWorldModelSnapshot({root:f.root,worldModelId:f.built.snapshot.worldModelId})).snapshot.worldModelHash,f.built.snapshot.worldModelHash);
  for(const [relative,digest]of protectedRows)assert.equal(sha(fs.readFileSync(path.join(f.root,relative))),digest,relative);
  const before=tree(f.root);await readWorldModel({root:f.root});await world.readSnapshot(kept.snapshot.worldModelId);assert.deepEqual(tree(f.root),before);
  assert.equal(typeof world.writePointer(world.readPointer().document)?.then,"undefined");
  // A new unreachable loose blob makes a second collection reuse the exact
  // already installed pack; that surviving pair must never retire itself.
  const unbound=await store.invoke(["hash-object","-w","--stdin"],store.context(),{input:"synthetic unreferenced blob\n",maxBytes:128});assert(unbound.length);
  const packBefore=fs.readdirSync(path.join(store.directory,"objects/pack")).sort();
  const second=await applySnapshotGarbageCollection({root:f.root,onProcess:event=>events.push(event)});
  assert.equal(second.status,"gc_applied",JSON.stringify(second));assert.equal(second.publishedPackBytes,0);assert(second.deletedObjectFiles>0);
  assert.deepEqual(fs.readdirSync(path.join(store.directory,"objects/pack")).sort(),packBefore);
  assert.equal((await readWorldModel({root:f.root})).snapshot.worldModelHash,kept.snapshot.worldModelHash);
  assert.deepEqual(snapshotGitProcessStatus(),[]);assert.equal(events.filter(e=>e.event==="started").length,events.filter(e=>e.event==="closed").length);
  t.diagnostic(JSON.stringify({first:result,second,gitChildCount:events.filter(e=>e.event==="started").length}));
});


async function objectFixture(t, packed = false, syntheticRoot = null) {
 const cleanup=[];const f=await fixture({after:fn=>cleanup.push(fn)},syntheticRoot),store=new GitSnapshotStore({projectRoot:f.root,storage:f.storage});
 const entry=await store.write(f.built.snapshot.worldModelId,f.built.snapshot);
 const extra=(await store.invoke(["hash-object","-w","--stdin"],store.context(),{input:"synthetic loose orphan",maxBytes:128})).toString("ascii").trim();
 if(packed){const all=await store.invoke(["cat-file","--batch-all-objects","--batch-check=%(objectname)"],store.context(),{maxBytes:16384});await store.invoke(["-c","pack.writeReverseIndex=false","pack-objects","--threads=1",path.join(store.directory,"objects/pack/pack")],store.context(),{input:all,maxBytes:128});}
 const mixed=new SnapshotBackendReclamation({root:f.root,storage:f.storage});const refs=[];for await(const row of mixed.inventoryGit())refs.push(row);
 const attempt=beginSnapshotCollection({root:f.root});assert.equal(attempt.status,"active");t.after(()=>{try{finishSnapshotCollection(attempt);}finally{for(const fn of cleanup)fn();}});
 const result={deleted:[],deletedCount:0,reclaimedBytes:0,deletedObjectFiles:0,deletedDomainBundles:0,writtenPackBytes:0,publishedPackBytes:0,deferred:[]};
 return {...f,store,entry,extra,mixed,refs,attempt,result};
}

test("isolated staged pack cannot borrow a missing retained object from the old DB",async t=>{
 const f=await objectFixture(t),keep=new Set(f.refs[0].objectIds),original=f.mixed.packStream.bind(f.mixed);
 t.mock.method(f.mixed,"packStream",(oids,...args)=>original([f.extra,...oids.slice(1)],...args));
 const before=tree(f.root).filter(([file])=>file.includes("/objects/")||file.includes("\\objects\\"));
 await assert.rejects(f.mixed.reclaimObjects({attempt:f.attempt,result:f.result,keepObjects:keep,pinnedPaths:new Set()}),{code:"GC_STAGED_PACK_COVERAGE"});
 assert.equal(f.result.deletedCount,0);assert.equal((await f.store.read(f.built.snapshot.worldModelId)).snapshotStorage.rawSha256,f.entry.snapshotStorage.rawSha256);
 assert.deepEqual(tree(f.root).filter(([file])=>file.includes("/objects/")||file.includes("\\objects\\")),before);
});

test("bounded native pack stream stops before disk cap and verifies tree cleanup",async t=>{
 const f=await objectFixture(t),events=[];f.mixed.onProcess=e=>events.push(e);
 const file=path.join(f.root,"bounded-stage.pack");
 await assert.rejects(f.mixed.packStream([...f.mixed.objects.keys()],file,1),{code:"GC_STAGING_BYTE_LIMIT"});
 assert.equal(fs.statSync(file).size,0);const closed=events.find(e=>e.event==="closed");assert.equal(closed.supervision.treeCleanupVerified,true);
});

test("ordinary work after new pair publication cancels all old object retirement",async t=>{
 const f=await objectFixture(t), original=fs.renameSync;let entered=false;
 t.mock.method(fs,"renameSync",function(from,to){const value=original.call(this,from,to);if(String(to).endsWith(".idx")&&String(to).includes("snapshot-objects.git")){queueMicrotask(()=>{withSnapshotReferences({root:f.root},()=>{});entered=true;});}return value;});
 await assert.rejects(f.mixed.reclaimObjects({attempt:f.attempt,result:f.result,keepObjects:new Set(f.refs[0].objectIds),pinnedPaths:new Set()}),{code:"SNAPSHOT_COLLECTION_INVALIDATED"});
 assert(entered);assert.equal(f.result.deletedCount,0);assert(f.result.publishedPackBytes>0);
 assert.equal((await f.store.read(f.built.snapshot.worldModelId)).snapshotStorage.rawSha256,f.entry.snapshotStorage.rawSha256);
});


test("standalone successful and failed source originals remain roots without collected records",async t=>{
 const f=await fixture(t),bytes=fs.readFileSync(path.join(f.root,"example.py"));
 const bundle=createSourceObservation({version:1,projectId:f.storage.projectId,kind:"source",query:[{path:"example.py",symbol:""}],sources:[{path:"example.py",digest:sha(bytes),base64:bytes.toString("base64")}],profile:{reader:"exact-utf8-source-1",implementation:{name:"synthetic"}},observedAt:new Date().toISOString(),response:null,envelopeHash:null},f.storage);
 const key=sourceBundleKey(bundle.evidence),dir=path.join(f.root,f.storage.directory,"observations/source-bundles");fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,key+".json"),JSON.stringify(bundle));
 const failure=retainSourceFailure(f.root,{projectId:f.storage.projectId,query:[],sources:[],profile:{name:"synthetic"},status:"unavailable",code:"SYNTHETIC_ONLY"},f.storage);
 const before=new Map(fs.readdirSync(dir).map(name=>[name,sha(fs.readFileSync(path.join(dir,name)))]));await orphan(f);
 const result=await applySnapshotGarbageCollection({root:f.root});assert.equal(result.status,"gc_applied",JSON.stringify(result));assert.equal(result.deletedSourceBundles,0);assert.equal(result.deletedCount,2);
 for(const [name,digest]of before)assert.equal(sha(fs.readFileSync(path.join(dir,name))),digest);
 assert.equal(readSourceObservationOriginal(f.root,f.storage.projectId,key,{storage:f.storage,requireCurrent:false}).bundle.observation.observationId,bundle.observation.observationId);
 assert.equal(readSourceFailure(f.root,f.storage.projectId,failure,f.storage).failure.projectId,f.storage.projectId);
 const dry=inspectSnapshotGarbageCollection({root:f.root});assert.equal(typeof dry.then,"undefined");
});

test("loose ref CAS preserves packed shadows, external locks and changed file identity",async t=>{
 for(const mode of ["packed","lock","identity"])await t.test(mode,async t=>{
  const f=await objectFixture(t),row=f.refs[0],before=fs.readFileSync(row.refFile.file);
  if(mode==="packed")fs.writeFileSync(path.join(f.store.directory,"packed-refs"),"# pack-refs with: peeled fully-peeled sorted\n"+row.oid+" "+row.ref+"\n");
  const external=path.join(f.store.directory,"packed-refs.lock");if(mode==="lock")fs.writeFileSync(external,"external owner");
  if(mode==="identity")fs.writeFileSync(row.refFile.file,before);
  assert.throws(()=>f.mixed.retireRef(row,f.attempt),{code:mode==="packed"?"UNSUPPORTED_GC_PACKED_REFS":mode==="lock"?"EEXIST":"SNAPSHOT_GC_CANDIDATE_DRIFT"});
  assert.deepEqual(fs.readFileSync(row.refFile.file),before);assert(!fs.existsSync(row.refFile.file+".lock"));
  if(mode==="lock")assert.equal(fs.readFileSync(external,"utf8"),"external owner");
 });
});


test("rooted read reacquires the same chosen OID across a real pack replacement",async t=>{
 const f=await objectFixture(t,true),invoke=f.store.invoke.bind(f.store);let replaced=false;
 t.mock.method(f.store,"invoke",async function(args,...rest){
   if(!replaced&&args[0]==="cat-file"&&args[1]==="--batch"&&rest[1]?.input===f.entry.snapshotStorage.treeObjectId+"\n"){
   replaced=true;await f.mixed.reclaimObjects({attempt:f.attempt,result:f.result,keepObjects:new Set(f.refs[0].objectIds),pinnedPaths:new Set()});
   throw Object.assign(new Error("Synthetic delayed old-pack open"),{code:"SNAPSHOT_GIT_COMMAND_FAILED",gitStderr:"fatal: could not get object info",gitAction:"cat-file"});
  }
  return invoke(args,...rest);
 });
 const read=await f.store.read(f.built.snapshot.worldModelId);assert(replaced);assert.equal(read.snapshotStorage.treeObjectId,f.entry.snapshotStorage.treeObjectId);assert.equal(read.snapshotStorage.rawSha256,f.entry.snapshotStorage.rawSha256);assert(f.result.deleted.some(row=>row.path.endsWith(".pack")));
});

test("Windows open pack handle produces honest partial retirement while rooted bytes stay readable",{skip:process.platform!=="win32"},async t=>{
 const f=await objectFixture(t,true),oldPack=[...f.mixed.files.values()].find(row=>row.file.endsWith(".pack"));
 const executablePath=path.join(process.env.SystemRoot,"System32/WindowsPowerShell/v1.0/powershell.exe");
 const script="$f=[IO.File]::Open('"+oldPack.file.replaceAll("'","''")+"',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);try{[Console]::WriteLine('held');[Console]::ReadLine()|Out-Null}finally{$f.Dispose()}";
 const args=["-NoProfile","-NonInteractive","-Command",script],events=[];
 const plan={command:executablePath,args,cwd:f.root,ports:[],startedAt:new Date().toISOString(),parentPid:process.pid};t.diagnostic(JSON.stringify({planned:plan}));
 const handle=spawnSupervisedProcess({selection:f.mixed.selectSupervisor(),executablePath,args,cwd:f.root,providerEnvironment:{SystemRoot:process.env.SystemRoot},input:Buffer.alloc(0),controlFile:path.join(f.root,"lock-control.jsonl"),terminationGraceMs:250,interactive:{timeoutMs:30000},onControlEvent:event=>events.push(event)});
 const closed=new Promise(resolve=>handle.child.once("close",(code,signal)=>resolve({code,signal})));let timer,received="",terminationRequested=false;
 try{
  await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error("Synthetic locker readiness timeout")),10000);handle.child.stdout.on("data",chunk=>{received+=chunk.toString();if(received.includes("held"))resolve();});handle.child.once("error",reject);});clearTimeout(timer);
  await assert.rejects(f.mixed.reclaimObjects({attempt:f.attempt,result:f.result,keepObjects:new Set(f.refs[0].objectIds),pinnedPaths:new Set()}),error=>["EPERM","EACCES","EBUSY"].includes(error.code));
  assert(fs.existsSync(oldPack.file));assert(f.result.publishedPackBytes>0);assert.equal((await f.store.read(f.built.snapshot.worldModelId)).snapshotStorage.rawSha256,f.entry.snapshotStorage.rawSha256);
  await handle.endInput();
 }finally{
  clearTimeout(timer);if(!handle.child.stdin.writableEnded){terminationRequested=true;handle.terminate(false);}
  const exit=await closed,proof=handle.finalize({exactSupervisorExitObserved:true,terminationRequested});t.diagnostic(JSON.stringify({nativeLockExit:exit,proof,events}));assert.equal(proof.treeCleanupVerified,true);
 }
});


test("missing native capability and oversized supervisor input defer only physical packing",async t=>{
 for(const mode of ["missing","input"])await t.test(mode,async t=>{
  const f=await objectFixture(t),keep=new Set(f.refs[0].objectIds),events=[];f.mixed.onProcess=e=>events.push(e);
  if(mode==="missing"){
   const stat=fs.lstatSync,manifest=f.mixed.selectSupervisor().manifestPath;
   t.mock.method(fs,"lstatSync",function(file,...args){if(String(file)===manifest)return undefined;return stat.call(this,file,...args);});
  }else{
   keep.clear();for(let i=0;i<64528;i++){const oid=i.toString(16).padStart(64,"0");keep.add(oid);f.mixed.objects.set(oid,{oid,type:"blob",size:0,rawSha256:sha(Buffer.alloc(0))});}
  }
  await f.mixed.reclaimObjects({attempt:f.attempt,result:f.result,keepObjects:keep,pinnedPaths:new Set()});
  assert.equal(f.result.deletedCount,0);assert.equal(f.result.publishedPackBytes,0);assert.equal(events.filter(e=>e.event==="started").length,0);
  assert.equal(f.result.deferred[0].code,mode==="missing"?"PROCESS_SUPERVISOR_NOT_AVAILABLE":"GC_SUPERVISOR_INPUT_LIMIT");
  assert.equal(typeof f.world.writePointer(f.world.readPointer().document)?.then,"undefined");
  assert.equal((await readWorldModel({root:f.root})).snapshot.worldModelHash,f.built.snapshot.worldModelHash);
 });
});

test("failure between pack and index publication preserves old objects and reports the actual new bytes",async t=>{
 const f=await objectFixture(t,true),rename=fs.renameSync,old=[...f.mixed.files.values()].filter(row=>row.path.includes("/objects/"));
 t.mock.method(fs,"renameSync",function(from,to){if(String(to).endsWith(".idx")&&String(to).includes("snapshot-objects.git"))throw Object.assign(new Error("Synthetic publication I/O failure"),{code:"EIO"});return rename.call(this,from,to);});
 await assert.rejects(f.mixed.reclaimObjects({attempt:f.attempt,result:f.result,keepObjects:new Set(f.refs[0].objectIds),pinnedPaths:new Set()}),{code:"EIO"});
 assert.equal(f.result.deletedCount,0);assert(f.result.publishedPackBytes>0);assert.equal(f.result.publishedFiles.length,1);assert(f.result.publishedFiles[0].path.endsWith(".pack"));
 for(const row of old)assert.equal(sha(fs.readFileSync(row.file)),row.sha256);
 assert.equal((await f.store.read(f.built.snapshot.worldModelId)).snapshotStorage.rawSha256,f.entry.snapshotStorage.rawSha256);
});


test("pack basis tolerates only known list-to-stat retirement and preserves chosen bytes",async t=>{
 for(const mode of ["retired","permission","unknown"])await t.test(mode,async t=>{
  const f=await objectFixture(t,true),resolve=f.store.resolve.bind(f.store),lstat=fs.lstatSync,readdir=fs.readdirSync;
  const packDir=path.join(f.store.directory,"objects/pack"),oldIdx=[...f.mixed.files.values()].find(row=>row.file.endsWith(".idx"));let armed=false,injected=false;
  if(mode==="unknown")fs.writeFileSync(path.join(packDir,"foreign.tmp"),"unknown");
  t.mock.method(f.store,"resolve",async(...args)=>{const value=await resolve(...args);armed=true;return value;});
  t.mock.method(fs,"readdirSync",function(directory,...args){const names=readdir.call(this,directory,...args);if(armed&&!injected&&path.resolve(String(directory))===packDir){injected=true;if(mode!=="permission")fs.unlinkSync(mode==="unknown"?path.join(packDir,"foreign.tmp"):oldIdx.file);}return names;});
  if(mode==="permission")t.mock.method(fs,"lstatSync",function(file,...args){if(armed&&String(file)===oldIdx.file)throw Object.assign(new Error("Synthetic sampler permission failure"),{code:"EACCES"});return lstat.call(this,file,...args);});
  if(mode==="retired"){const result=await f.store.read(f.built.snapshot.worldModelId);assert.equal(result.snapshotStorage.treeObjectId,f.entry.snapshotStorage.treeObjectId);assert.equal(result.snapshotStorage.rawSha256,f.entry.snapshotStorage.rawSha256);}
  else await assert.rejects(f.store.read(f.built.snapshot.worldModelId),{code:mode==="permission"?"EACCES":"ENOENT"});
  assert(injected);
 });
});

test("sync Git pointer rejects foreign private owner before changing the original pointer",async t=>{
 const f=await objectFixture(t),pointer=f.world.readPointer().document,before=fs.readFileSync(f.world.pointerLocation());
 fs.unlinkSync(f.world.snapshotLocation(f.built.snapshot.worldModelId));
 const ownerFile=path.join(f.store.directory,"lode-owner.json"),owner=JSON.parse(fs.readFileSync(ownerFile));owner.projectId="synthetic-foreign-project";fs.writeFileSync(ownerFile,JSON.stringify(owner));
 assert.throws(()=>f.world.writePointer(pointer),{code:"SNAPSHOT_GIT_OWNER_MISMATCH"});assert.deepEqual(fs.readFileSync(f.world.pointerLocation()),before);
});

test("next explicit collection inventories pack-only publication without replaying old effects",async t=>{
 const f=await objectFixture(t,true),rename=fs.renameSync,events=[];
 t.mock.method(fs,"renameSync",function(from,to){if(String(to).endsWith(".idx")&&String(to).includes("snapshot-objects.git"))throw Object.assign(new Error("Synthetic publication I/O failure"),{code:"EIO"});return rename.call(this,from,to);});
 await assert.rejects(f.mixed.reclaimObjects({attempt:f.attempt,result:f.result,keepObjects:new Set(f.refs[0].objectIds),pinnedPaths:new Set()}),{code:"EIO"});t.mock.restoreAll();
 const residue=path.join(f.root,f.result.publishedFiles[0].path),before=tree(f.root);assert(!fs.existsSync(residue.slice(0,-5)+".idx"));
 const pure=await buildSnapshotDeletionClosure({root:f.root});assert(!pure.certified);assert(pure.issues.some(row=>row.reasonCode==="UNVERIFIED_GC_PACK_RESIDUE"));assert.deepEqual(tree(f.root),before);
 finishSnapshotCollection(f.attempt);f.attempt.status="finished";
 // Remove duplicate JSON representation; the canonical pointer now exercises
 // the real private Git original throughout the new explicit apply.
 fs.unlinkSync(f.world.snapshotLocation(f.built.snapshot.worldModelId));
 const result=await applySnapshotGarbageCollection({root:f.root,onProcess:event=>events.push(event)});
 assert.equal(result.status,"gc_applied",JSON.stringify(result));assert(result.deletedObjectFiles>0);assert.equal(result.retiredRefCount,0);assert(fs.existsSync(residue));assert(fs.existsSync(residue.slice(0,-5)+".idx"));assert.equal(result.publishedFiles.length,1);assert(result.publishedFiles[0].path.endsWith(".idx"));
 assert.equal((await f.store.read(f.built.snapshot.worldModelId)).snapshotStorage.rawSha256,f.entry.snapshotStorage.rawSha256);assert(events.some(e=>e.event==="closed"&&e.supervision?.treeCleanupVerified));
 assert.deepEqual(fs.readdirSync(path.join(f.root,f.storage.directory,".snapshot-gc/staging")),[]);
});

test("unindexed-only retained lineage makes the whole remaining closure incomplete",async t=>{
 const f=await objectFixture(t,true),idx=[...f.mixed.files.values()].find(row=>row.file.endsWith(".idx"));fs.unlinkSync(idx.file);
 for(const row of f.mixed.files.values())if(/\/objects\/[a-f0-9]{2}\/[a-f0-9]{62}$/.test(row.path))fs.unlinkSync(row.file);
 finishSnapshotCollection(f.attempt);f.attempt.status="finished";const before=tree(f.root);
 const result=await applySnapshotGarbageCollection({root:f.root});assert.equal(result.deletedCount,0);assert.equal(result.status,"gc_preserved",JSON.stringify(result));assert.equal(result.coverage.referenceValidity,"incomplete-preserved");
 assert.deepEqual(tree(f.root),before);assert(!fs.existsSync(idx.file));
});

test("multiple unindexed representations use sequential bounded scratch and preserve corrupt residues",async t=>{
 for(const mode of ["multiple","corrupt"])await t.test(mode,async t=>{
  const f=await objectFixture(t),hashes=[];
  for(let index=0;index<2;index++){const oid=(await f.store.invoke(["hash-object","-w","--stdin"],f.store.context(),{input:"synthetic residue "+index,maxBytes:128})).toString("ascii").trim();const hash=(await f.store.invoke(["-c","pack.writeReverseIndex=false","pack-objects","--threads=1",path.join(f.store.directory,"objects/pack/pack")],f.store.context(),{input:oid+"\n",maxBytes:128})).toString("ascii").trim();hashes.push(hash);fs.unlinkSync(path.join(f.store.directory,"objects/pack/pack-"+hash+".idx"));}
  if(mode==="corrupt"){const file=path.join(f.store.directory,"objects/pack/pack-"+hashes[0]+".pack"),bytes=fs.readFileSync(file);bytes[12]^=1;fs.unlinkSync(file);fs.writeFileSync(file,bytes);}
  finishSnapshotCollection(f.attempt);f.attempt.status="finished";
  fs.unlinkSync(f.world.snapshotLocation(f.built.snapshot.worldModelId));const before=tree(f.root);let maxLive=0;
  const result=await applySnapshotGarbageCollection({root:f.root,onProcess:event=>{const dir=path.join(f.root,f.storage.directory,".snapshot-gc/staging");if(fs.existsSync(dir)){const count=fs.readdirSync(dir).length;maxLive=Math.max(maxLive,count);assert(count<=1);} }});
  if(mode==="corrupt"){assert.equal(result.deletedCount,0);assert.equal(result.coverage.referenceValidity,"incomplete-preserved");assert.deepEqual(tree(f.root),before);}
  else {assert.equal(result.status,"gc_applied",JSON.stringify(result));assert(result.deletedObjectFiles>0);assert.equal(maxLive,1);assert.equal((await f.store.read(f.built.snapshot.worldModelId)).snapshotStorage.rawSha256,f.entry.snapshotStorage.rawSha256);}
 });
});


test("unindexed inventory preserves foreign metadata and preflights space or cancellation",async t=>{
 for(const mode of ["foreign","schema","reserve","cancel"])await t.test(mode,async t=>{
  const f=await objectFixture(t,true),packDir=path.join(f.store.directory,"objects/pack");let pack=[...f.mixed.files.values()].find(row=>row.file.endsWith(".pack")).file;
  if(mode==="foreign"||mode==="schema"){
   const entries=(await f.store.invoke(["ls-tree",f.refs[0].oid],f.store.context(),{maxBytes:4096})).toString("ascii").trim().split("\n").map(line=>/^100644 blob ([a-f0-9]{64})\t(metadata.json|snapshot.json)$/.exec(line));
   const metadata=JSON.parse(await f.store.object(entries.find(entry=>entry[2]==="metadata.json")[1],"blob",4096,f.store.context()));let body=entries.find(entry=>entry[2]==="snapshot.json")[1];
   if(mode==="foreign")metadata.projectId="synthetic-foreign-project";
   else {const document={...f.built.snapshot,schemaVersion:999},bytes=Buffer.from(JSON.stringify(document)+"\n");body=(await f.store.invoke(["hash-object","-w","--stdin"],f.store.context(),{input:bytes,maxBytes:128})).toString("ascii").trim();metadata.objectId=body;metadata.byteLength=bytes.length;metadata.rawSha256=sha(bytes);}
   const meta=(await f.store.invoke(["hash-object","-w","--stdin"],f.store.context(),{input:JSON.stringify(metadata)+"\n",maxBytes:128})).toString("ascii").trim();
   const treeOid=(await f.store.invoke(["mktree"],f.store.context(),{input:"100644 blob "+meta+"\tmetadata.json\n100644 blob "+body+"\tsnapshot.json\n",maxBytes:128})).toString("ascii").trim();
   const hash=(await f.store.invoke(["-c","pack.writeReverseIndex=false","pack-objects","--threads=1",path.join(packDir,"pack")],f.store.context(),{input:[treeOid,meta,body].join("\n")+"\n",maxBytes:128})).toString("ascii").trim();pack=path.join(packDir,"pack-"+hash+".pack");
  }
  fs.unlinkSync(pack.slice(0,-5)+".idx");
  if(mode==="reserve"){const bytes=fs.readFileSync(pack);bytes.writeUInt32BE(0xffffffff,8);fs.unlinkSync(pack);fs.writeFileSync(pack,bytes);}
  finishSnapshotCollection(f.attempt);f.attempt.status="finished";const before=tree(f.root),controller=new AbortController();let interrupted=false;
  if(mode==="cancel"){const write=fs.writeSync;t.mock.method(fs,"writeSync",function(fd,...args){const result=write.call(this,fd,...args);if(!interrupted&&new Error().stack.includes("inventoryUnindexedPack")){interrupted=true;controller.abort();}return result;});}
  const result=await applySnapshotGarbageCollection({root:f.root,signal:controller.signal});assert.equal(result.deletedCount,0);assert.equal(result.coverage.referenceValidity,"incomplete-preserved");assert.deepEqual(tree(f.root),before);
  if(mode!=="schema")assert(result.coverage.issues.some(row=>row.reasonCode==={foreign:"SNAPSHOT_GIT_METADATA_MISMATCH",reserve:"GC_STAGING_BYTE_LIMIT",cancel:"SNAPSHOT_GC_CANCELLED"}[mode]),JSON.stringify(result));
  if(mode==="cancel"){assert(interrupted);assert.equal(result.code,"SNAPSHOT_GC_CANCELLED");}
 });
});


test("unindexed recovery stays within the existing producer path depth on Windows",{skip:process.platform!=="win32"},async t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),"lode-gc-path-")),target=path.join(base,"p".repeat(Math.max(1,130-base.length-1)));
 const f=await objectFixture(t,true,target);t.after(()=>fs.rmSync(base,{recursive:true,force:true}));assert(f.root.length>=130);
 const rename=fs.renameSync;
 t.mock.method(fs,"renameSync",function(from,to){if(String(to).endsWith(".idx")&&String(to).includes("snapshot-objects.git"))throw Object.assign(new Error("Synthetic publication failure"),{code:"EIO"});return rename.call(this,from,to);});
 await assert.rejects(f.mixed.reclaimObjects({attempt:f.attempt,result:f.result,keepObjects:new Set(f.refs[0].objectIds),pinnedPaths:new Set()}),{code:"EIO"});t.mock.restoreAll();finishSnapshotCollection(f.attempt);f.attempt.status="finished";
 fs.unlinkSync(f.world.snapshotLocation(f.built.snapshot.worldModelId));
 const result=await applySnapshotGarbageCollection({root:f.root});assert.equal(result.status,"gc_applied",JSON.stringify(result));assert(result.deletedObjectFiles>0);assert.equal((await f.store.read(f.built.snapshot.worldModelId)).snapshotStorage.rawSha256,f.entry.snapshotStorage.rawSha256);
});

test("scratch creation collision preserves the foreign slot in inventory and production",async t=>{
 for(const mode of ["inventory","producer"])await t.test(mode,async t=>{
  const f=await objectFixture(t,true),staging=path.join(f.attempt.ns.directory,"staging"),slot=path.join(staging,f.attempt.nonce);fs.mkdirSync(slot,{recursive:true});const file=path.join(slot,"foreign.txt");fs.writeFileSync(file,"foreign scratch must remain");const before=tree(slot);
  if(mode==="inventory"){const pack=[...f.mixed.files.values()].find(row=>row.file.endsWith(".pack"));fs.unlinkSync(pack.file.slice(0,-5)+".idx");f.mixed.collectionAttempt=f.attempt;await assert.rejects(f.mixed.inventoryUnindexedPack(pack),{code:"EEXIST"});}
  else await assert.rejects(f.mixed.reclaimObjects({attempt:f.attempt,result:f.result,keepObjects:new Set(f.refs[0].objectIds),pinnedPaths:new Set()}),{code:"EEXIST"});
  assert.deepEqual(tree(slot),before);assert.equal(f.result.deletedCount,0);assert.equal(f.result.publishedPackBytes,0);
 });
});


test("both ref locks bind the exact verified attempt host and runtime process origin",async t=>{
 const f=await objectFixture(t),claim=JSON.parse(fs.readFileSync(f.attempt.file)),write=fs.writeFileSync,payloads=[];
 assert.equal(claim.processBirthBasis,"node-runtime-time-origin");assert.equal(typeof claim.processBirth,"number");assert.equal(claim.pid,process.pid);
 t.mock.method(fs,"writeFileSync",function(file,data,...args){if(typeof file==="number"){const value=JSON.parse(String(data));if(value.nonce===f.attempt.nonce)payloads.push(value);}return write.call(this,file,data,...args);});
 const row=f.mixed.retireRef(f.refs[0],f.attempt);assert.equal(payloads.length,2);
 for(const value of payloads){for(const key of ["schemaVersion","projectId","nonce","host","pid","processBirth","processBirthBasis"])assert.equal(value[key],claim[key]);assert.equal(typeof value.createdAt,"string");}
 assert(!fs.existsSync(row.file));assert(!fs.existsSync(row.file+".lock"));assert(!fs.existsSync(path.join(f.store.directory,"packed-refs.lock")));
});

test("missing or foreign process origin never grants a ref effect or owner cleanup",async t=>{
 for(const mode of ["missing","different-birth","basis","host","pid","nonce"])await t.test(mode,async t=>{
  const f=await objectFixture(t),original=fs.readFileSync(f.attempt.file),claim=JSON.parse(original),ref=f.refs[0],before=fs.readFileSync(ref.refFile.file);
  if(mode==="missing")delete claim.processBirth;
  if(mode==="different-birth")claim.processBirth-=1000;
  if(mode==="basis")claim.processBirthBasis="unverified-os-birth";
  if(mode==="host")claim.host="foreign-host";
  if(mode==="pid")claim.pid=process.pid+1;
  if(mode==="nonce")claim.nonce="f".repeat(32);
  fs.writeFileSync(f.attempt.file,JSON.stringify(claim));const foreign=fs.readFileSync(f.attempt.file);
  try{assert.throws(()=>f.mixed.retireRef(ref,f.attempt));assert.throws(()=>finishSnapshotCollection(f.attempt));assert.deepEqual(fs.readFileSync(f.attempt.file),foreign);assert.deepEqual(fs.readFileSync(ref.refFile.file),before);assert(!fs.existsSync(ref.refFile.file+".lock"));assert(!fs.existsSync(path.join(f.store.directory,"packed-refs.lock")));}
  finally{fs.writeFileSync(f.attempt.file,original);}
 });
});
