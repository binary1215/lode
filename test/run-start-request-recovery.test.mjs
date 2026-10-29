import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { initializeProject, inspectProject } from "../scripts/lib/lode-core.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { createWholePlanSnapshot, createExecutionContract } from "../scripts/lib/execution-lineage.mjs";
import { startRun, finishRun, reviewRun, getPendingReviewContext, inspectRunStorageTransition, reconcileRunStorageTransition, sessionStateHash } from "../scripts/lib/run-lineage.mjs";
import { createHeadSession, withSessionRoute } from "../scripts/lib/session-routing.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
console.log(JSON.stringify({ event: "owned-test-process", pid: process.pid, parentPid: process.ppid, command: process.execPath, args: process.argv.slice(1), cwd: process.cwd(), ports: [] }));
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "head-start-request-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  assert.equal(storage.directory, ".lode");
  assert.equal(fs.existsSync(path.resolve(root, ".lode/project.json")), true);
  assert.equal(fs.existsSync(path.resolve(root, ".head/project.json")), false);
  const capsule = (await compileContext({ root, task: "Observe a local fixture", persist: true })).capsule;
  const plan = createWholePlanSnapshot({ root, objective: "Observe a local fixture", plan: [{ id: "observe", outcome: "Recorded fact" }] }).artifact;
  const contract = createExecutionContract({ root, wholePlanId: plan.wholePlanId, capsuleId: capsule.capsuleId, scope: "Observe a local fixture", acceptanceCriteria: ["Fact recorded"] }).artifact;
  return { root, storage, contract, input: { root, executionContractId: contract.executionContractId, startRequestId: "same-request" } };
}
const stateFile = (root, storage) => path.join(root, storage.directory, "sessions/current.json");
const runFile = (root, storage, id) => path.join(root, storage.directory, "sessions/runs", id, "run.json");
const runs = (root, storage) => fs.existsSync(path.join(root, storage.directory, "sessions/runs")) ? fs.readdirSync(path.join(root, storage.directory, "sessions/runs")).filter(id => fs.existsSync(runFile(root, storage, id))) : [];
function snapshot(root) {
  const result = {};
  function visit(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) visit(f); else result[path.relative(root, f)] = fs.readFileSync(f).toString("base64"); } }
  visit(root); return result;
}
function interruptSession(operation) {
  const rename = fs.renameSync;
  fs.renameSync = (a, b) => { if (b.endsWith(`${path.sep}sessions${path.sep}current.json`)) throw Object.assign(new Error("Fixture interrupted Session storage"), { code: "EIO" }); return rename(a, b); };
  try { assert.throws(operation, { code: "EIO" }); } finally { fs.renameSync = rename; }
}
const finishInput = (root) => ({ root, outcome: "Observed", evidence: [{ uri: "fixture-only", digest: "fact" }], verification: [{ check: "local", status: "passed" }] });
const reviewInput = (root) => ({ root, reviewContextId: getPendingReviewContext({ root }).review.reviewContextId, disposition: "accept", rationale: "Exact local evidence accepted" });

test("same key retry is an acknowledgment, not new execution; distinct key creates distinct Run", async (t) => {
  const { root, storage, input } = (await fixture(t));
  const started = startRun(input);
  const before = snapshot(root);
  const replay = startRun(input);
  assert.equal(replay.status, "run_start_already_committed");
  assert.equal(replay.executionReplayAllowed, false);
  assert.equal(replay.run.runId, started.run.runId);
  assert.deepEqual(snapshot(root), before);
  finishRun(finishInput(root)); reviewRun(reviewInput(root));
  const newer = startRun({ ...input, startRequestId: "new-logical-request" });
  const after = snapshot(root);
  const historical = startRun(input);
  assert.equal(historical.historical, true);
  assert.equal(historical.state.activeRunId, newer.run.runId);
  assert.equal(historical.executionReplayAllowed, false);
  assert.deepEqual(snapshot(root), after);
  assert.equal(runs(root, storage).length, 2);
});

test("same key divergent exact input is rejected without writes", async (t) => {
  const { root, storage, input, contract } = (await fixture(t));
  startRun(input);
  const other = createExecutionContract({ root, wholePlanId: contract.wholePlanId, capsuleId: contract.capsuleId, scope: "Different scope", acceptanceCriteria: ["Different criterion"] }).artifact;
  const before = snapshot(root);
  assert.throws(() => startRun({ ...input, executionContractId: other.executionContractId }), { code: "RUN_START_REQUEST_CONFLICT" });
  assert.deepEqual(snapshot(root), before);
});

test("exact key repairs Run-only start without touching checkpoint metadata or creating more Runs", async (t) => {
  const { root, storage, input } = (await fixture(t));
  interruptSession(() => startRun(input));
  assert.equal(inspectProject(root).state.activeRunId, null);
  assert.equal(runs(root, storage).length, 1);
  const state = JSON.parse(fs.readFileSync(stateFile(root, storage)));
  fs.writeFileSync(stateFile(root, storage), JSON.stringify({ ...state, latestCheckpoint: "later-unrelated-checkpoint-metadata" }));
  const result = startRun(input);
  assert.equal(result.storageRecovery, "session-storage-only");
  assert.equal(result.executionReplayAllowed, false);
  assert.equal(result.unknownEffect, true);
  assert.equal(result.state.latestCheckpoint, "later-unrelated-checkpoint-metadata");
  assert.equal(runs(root, storage).length, 1);
});

for (const boundary of ["run", "session"]) for (const after of [false, true]) {
  test(`start exact retry converges ${after ? "after" : "before"} ${boundary} publication`, async (t) => {
    const { root, storage, input } = (await fixture(t));
    const link = fs.linkSync, rename = fs.renameSync;
    let injected = false;
    const intercept = (publish, a, b) => {
      const matches = boundary === "run" ? path.basename(b) === "run.json" : b === stateFile(root, storage);
      if (!injected && matches) { injected = true; if (after) publish(a, b); throw Object.assign(new Error("Fixture exact boundary"), { code: "EIO" }); }
      return publish(a, b);
    };
    fs.linkSync = (a, b) => intercept(link, a, b);
    fs.renameSync = (a, b) => intercept(rename, a, b);
    try {
      if (boundary === "session" && after) assert.equal(startRun(input).canonicalCommit, "committed");
      else assert.throws(() => startRun(input), { code: "EIO" });
    } finally { fs.linkSync = link; fs.renameSync = rename; }
    assert.equal(injected, true);
    const retried = startRun(input);
    assert.ok(["run_started", "run_start_already_committed"].includes(retried.status));
    assert.equal(runs(root, storage).length, 1);
    assert.equal(inspectProject(root).state.activeRunId, retried.run.runId);
  });
}

test("two hidden concurrent exact-key callers converge on one Run without a duplicate launch authorization", async (t) => {
  const { root, storage, input } = (await fixture(t));
  const module = pathToFileURL(path.join(pluginRoot, "scripts/lib/run-lineage.mjs")).href;
  const child = () => new Promise((resolve, reject) => {
    const code = `import {startRun} from ${JSON.stringify(module)}; console.log(JSON.stringify({event:'owned-start-child',pid:process.pid,parentPid:process.ppid,command:process.execPath,cwd:process.cwd(),at:new Date().toISOString(),ports:[]})); console.log(JSON.stringify(startRun(${JSON.stringify(input)})));`;
    console.log(JSON.stringify({ event: "owned-start-launch-plan", parentPid: process.pid, command: process.execPath, args: ["--input-type=module", "-e", "exact-key-start-fixture"], cwd: pluginRoot, ports: [] }));
    const processChild = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: pluginRoot, windowsHide: true, timeout: 60_000 });
    console.log(JSON.stringify({ event: "owned-start-launched", pid: processChild.pid, parentPid: process.pid, at: new Date().toISOString(), command: process.execPath, cwd: pluginRoot, ports: [] }));
    let output = "", errors = "";
    processChild.stdout.on("data", data => output += data); processChild.stderr.on("data", data => errors += data);
    processChild.on("error", reject);
    processChild.on("close", code => {
      console.log(JSON.stringify({ event: "owned-start-closed", pid: processChild.pid, parentPid: process.pid, code, ports: [] }));
      try { assert.equal(code, 0, errors); assert.throws(() => process.kill(processChild.pid, 0), { code: "ESRCH" }); resolve(JSON.parse(output.trim().split(/\r?\n/).at(-1))); } catch (error) { reject(error); }
    });
  });
  const results = await Promise.all([child(), child()]);
  assert.deepEqual(new Set(results.map(result => result.status)), new Set(["run_started", "run_start_already_committed"]));
  assert.equal(new Set(results.map(result => result.run.runId)).size, 1);
  assert.equal(runs(root, storage).length, 1);
  assert.equal(results.every(result => result.executionReplayAllowed === false), true);
});

test("lost key never guesses a replacement", async (t) => {
  const { root, storage, input } = (await fixture(t));
  interruptSession(() => startRun({ ...input, startRequestId: undefined }));
  const before = snapshot(root);
  assert.throws(() => startRun(input), { code: "RUN_START_UNRESOLVED" });
  assert.deepEqual(snapshot(root), before);
});

test("multiple exact-key candidates are unresolved instead of latest-wins", async (t) => {
  const { root, storage, input } = (await fixture(t));
  interruptSession(() => startRun(input));
  const prior = JSON.parse(fs.readFileSync(runFile(root, storage, runs(root, storage)[0])));
  const other = structuredClone(prior), newId = "run-1-000001";
  other.runId = newId;
  other.startOperation.runId = newId;
  other.startOperation.patch.activeRunId = newId;
  other.startOperation.transition.runId = newId;
  other.startOperation.transition.artifactId = newId;
  other.startOperation.transition.patch.activeRunId = newId;
  const { operationHash, ...payload } = other.startOperation;
  other.startOperation.operationHash = sessionStateHash(payload);
  other.sessionTransition = other.startOperation.transition;
  fs.mkdirSync(path.dirname(runFile(root, storage, newId)), { recursive: true });
  fs.writeFileSync(runFile(root, storage, newId), JSON.stringify(other));
  const before = snapshot(root);
  assert.throws(() => startRun(input), { code: "RUN_START_UNRESOLVED" });
  assert.deepEqual(snapshot(root), before);
});

test("deleted result after committed finish is an evidence gap, not an unsaved transition", async (t) => {
  const { root, storage, input } = (await fixture(t));
  startRun(input);
  const result = finishRun(finishInput(root));
  fs.unlinkSync(path.join(root, storage.directory, "lineage/result-packets", `${result.resultPacket.resultPacketId}.json`));
  const before = snapshot(root);
  const status = inspectRunStorageTransition({ root });
  assert.equal(status.status, "committed");
  assert.equal(status.transition.artifactStatus, "missing-evidence");
  assert.deepEqual(snapshot(root), before);
  assert.throws(() => getPendingReviewContext({ root }), { code: "LINEAGE_ARTIFACT_NOT_FOUND" });
});

test("unrelated proven Session owner corruption is not a global start gate", async (t) => {
  const { root, storage, input } = (await fixture(t));
  const other = createHeadSession({ root, purpose: "Independent owner" }).sessionId;
  const foreign = withSessionRoute(root, other, () => startRun(input));
  const file = runFile(root, storage, foreign.run.runId), record = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({ ...record, executionContractId: "broken-unrelated-lineage" }));
  assert.equal(startRun(input).status, "run_started");
});

test("an unattached active Run with unknown owner is not silently discarded", async (t) => {
  const { root, storage, input } = (await fixture(t));
  const other = createHeadSession({ root, purpose: "Owner loss fixture" }).sessionId;
  withSessionRoute(root, other, () => startRun(input));
  fs.unlinkSync(path.join(root, storage.directory, "sessions/by-id", other, "current.json"));
  const before = snapshot(root);
  assert.throws(() => startRun(input), { code: "RUN_START_UNRESOLVED" });
  assert.deepEqual(snapshot(root), before);
});

test("Run start preimage drift and metadata tamper never overwrite current Session", async (t) => {
  const { root, storage, input } = (await fixture(t));
  interruptSession(() => startRun(input));
  const state = inspectProject(root).state;
  fs.writeFileSync(stateFile(root, storage), JSON.stringify({ ...state, mode: "explicit-current-head-change" }));
  const before = snapshot(root);
  assert.throws(() => startRun(input), { code: "RUN_TRANSITION_SESSION_DRIFT" });
  assert.deepEqual(snapshot(root), before);
  const file = runFile(root, storage, runs(root, storage)[0]), record = JSON.parse(fs.readFileSync(file));
  record.startOperation.inputHash = "tampered";
  fs.writeFileSync(file, JSON.stringify(record));
  assert.throws(() => startRun(input), { code: "RUN_START_IDENTITY_CONFLICT" });
});

for (const kind of ["finish", "review"]) {
  test(`${kind} verified artifact permits storage-only repair; read is immutable`, async (t) => {
    const { root, storage, input } = (await fixture(t));
    startRun(input);
    if (kind === "review") finishRun(finishInput(root));
    const operation = kind === "finish" ? finishRun : reviewRun;
    const fields = kind === "finish" ? finishInput(root) : reviewInput(root);
    interruptSession(() => operation(fields));
    const before = snapshot(root);
    assert.equal(inspectRunStorageTransition({ root }).status, "incomplete");
    assert.deepEqual(snapshot(root), before);
    const repaired = reconcileRunStorageTransition({ root });
    assert.equal(repaired.repaired, "session-storage-only");
    assert.equal(repaired.executionReplayAllowed, false);
    assert.equal(inspectRunStorageTransition({ root }).status, "committed");
  });

  test(`${kind} missing immutable evidence remains incomplete and cannot fabricate judgment/result`, async (t) => {
    const { root, storage, input } = (await fixture(t));
    const started = startRun(input);
    if (kind === "review") finishRun(finishInput(root));
    const operation = kind === "finish" ? finishRun : reviewRun;
    const fields = kind === "finish" ? finishInput(root) : reviewInput(root);
    interruptSession(() => operation(fields));
    const run = JSON.parse(fs.readFileSync(runFile(root, storage, started.run.runId)));
    fs.unlinkSync(path.join(root, storage.directory, "lineage", kind === "finish" ? "result-packets" : "review-decisions", `${run.sessionTransition.artifactId}.json`));
    const before = snapshot(root);
    assert.equal(reconcileRunStorageTransition({ root }).transition.artifactStatus, "missing-evidence");
    assert.deepEqual(snapshot(root), before);
    assert.equal(operation(fields).canonicalCommit, "committed", "only the exact original mutation input may recreate its hash-bound artifact");
  });
}

test("derived index failure leaves required storage committed without replay instruction", async (t) => {
  const { root, storage, input } = (await fixture(t));
  const rename = fs.renameSync;
  fs.renameSync = (a, b) => { if (b.includes(`${path.sep}graph-discovery${path.sep}`)) throw Object.assign(new Error("Fixture derived index failure"), { code: "EIO" }); return rename(a, b); };
  try {
    const result = startRun(input);
    assert.equal(result.canonicalCommit, "committed");
    assert.equal(result.executionReplayAllowed, false);
    assert.equal(result.projectionUpdate.status, "unavailable");
    assert.equal(inspectProject(root).state.activeRunId, result.run.runId);
  } finally { fs.renameSync = rename; }
});
