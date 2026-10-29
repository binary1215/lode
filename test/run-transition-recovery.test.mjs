import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { initializeProject, inspectProject } from "../scripts/lib/lode-core.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { createWholePlanSnapshot, createNextWholePlanSnapshot, createExecutionContract } from "../scripts/lib/execution-lineage.mjs";
import { finishRun, getPendingReviewContext, reviewRun, startRun } from "../scripts/lib/run-lineage.mjs";
import { createRecoveryCheckpoint } from "../scripts/lib/compaction-recovery.mjs";
import { restoreSessionFromArtifacts } from "../scripts/lib/session-recovery.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const moduleUrl = pathToFileURL(path.join(pluginRoot, "scripts/lib/run-lineage.mjs")).href;
console.log(JSON.stringify({ event: "owned-test-process", pid: process.pid, parentPid: process.ppid, command: process.execPath, args: process.argv.slice(1), cwd: process.cwd(), ports: [] }));

async function fixture(t) {
  const parent = process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "head-run-transition-"));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(parent));
    assert.match(path.basename(root), /^head-run-transition-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  assert.equal(storage.directory, ".lode");
  assert.equal(fs.existsSync(path.resolve(root, ".lode/project.json")), true);
  assert.equal(fs.existsSync(path.resolve(root, ".head/project.json")), false);
  const capsule = (await compileContext({ root, task: "Observe one local fixture fact", persist: true })).capsule;
  const plan = createWholePlanSnapshot({ root, objective: "Observe one local fixture fact", plan: [{ id: "observe", outcome: "Recorded fact" }] }).artifact;
  const contract = createExecutionContract({ root, wholePlanId: plan.wholePlanId, capsuleId: capsule.capsuleId, scope: "Observe one local fixture fact", acceptanceCriteria: ["Evidence is recorded"] }).artifact;
  const { run } = startRun({ root, executionContractId: contract.executionContractId });
  const finishInput = { root, outcome: "Observed fixture fact", evidence: [{ uri: "fixture-only", digest: "fixture-evidence" }], verification: [{ check: "local fact", status: "passed" }] };
  return { root, storage, run, contract, finishInput };
}

function reviewInput(root) {
  return { root, reviewContextId: getPendingReviewContext({ root }).review.reviewContextId, disposition: "accept", rationale: "The exact fixture evidence meets the contract.", nextActions: ["Continue the accepted direction"] };
}

function snapshot(root) {
  const files = {};
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else files[path.relative(root, file)] = fs.readFileSync(file).toString("base64");
    }
  }
  walk(root);
  return files;
}

function failAt(kind, boundary, after, operation) {
  const rename = fs.renameSync, link = fs.linkSync;
  let injected = false;
  fs.renameSync = (source, target) => {
    const name = path.basename(target);
    let matches = boundary === "session" && name === "current.json";
    if (boundary === "artifact") matches = path.basename(path.dirname(target)) === (kind === "finish" ? "result-packets" : "review-decisions");
    if (boundary === "run" && name === "run.json") {
      const run = JSON.parse(fs.readFileSync(source, "utf8"));
      matches = run.sessionTransition?.kind === kind && run.status === (kind === "finish" ? "awaiting_review" : "reviewed");
    }
    if (!injected && matches) {
      injected = true;
      if (after) rename(source, target);
      throw Object.assign(new Error(`Fixture EIO ${after ? "after" : "before"} ${kind} ${boundary}`), { code: "EIO" });
    }
    return rename(source, target);
  };
  fs.linkSync = (source, target) => {
    const matches = boundary === "artifact" && path.basename(path.dirname(target)) === (kind === "finish" ? "result-packets" : "review-decisions");
    if (!injected && matches) {
      injected = true;
      if (after) link(source, target);
      throw Object.assign(new Error(`Fixture EIO at ${kind} artifact`), { code: "EIO" });
    }
    return link(source, target);
  };
  try {
    if (boundary === "session" && after) assert.equal(operation().canonicalCommit, "committed", "an exact saved target is acknowledged even when post-publication cleanup fails");
    else assert.throws(operation, { code: "EIO" });
  }
  finally { fs.renameSync = rename; fs.linkSync = link; }
  assert.equal(injected, true);
}

function freshRetry(kind, input) {
  const code = `import { ${kind === "finish" ? "finishRun" : "reviewRun"} as retry } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify({event:"owned-retry-process",pid:process.pid,parentPid:process.ppid,command:process.execPath,cwd:process.cwd(),ports:[]}));
    console.log(JSON.stringify(retry(${JSON.stringify(input)})));`;
  console.log(JSON.stringify({ event: "owned-retry-launch", parentPid: process.pid, command: process.execPath, args: ["--input-type=module", "-e", "exact fixture transition retry"], cwd: pluginRoot, ports: [] }));
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: pluginRoot, encoding: "utf8", windowsHide: true, timeout: 60_000 });
  console.log(JSON.stringify({ event: "owned-retry-exit", pid: child.pid, parentPid: process.pid, status: child.status, signal: child.signal, ports: [] }));
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  return JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1));
}

for (const kind of ["finish", "review"]) {
  test(`${kind} converges before and after every durable boundary in a fresh process`, async (t) => {
    for (const boundary of ["run", "artifact", "session"]) {
      for (const after of [false, true]) {
        const { root, storage, run, contract, finishInput } = (await fixture(t));
        if (kind === "review") finishRun(finishInput);
        const input = kind === "finish" ? finishInput : reviewInput(root);
        const operation = kind === "finish" ? finishRun : reviewRun;
        const canonBefore = fs.readFileSync(path.join(root, storage.directory, "context/product-model.json"), "utf8");
        failAt(kind, boundary, after, () => operation(input));
        const beforeRead = snapshot(root);
        inspectProject(root);
        try { getPendingReviewContext({ root }); } catch {}
        assert.deepEqual(snapshot(root), beforeRead, "inspection must never repair P2");
        const result = freshRetry(kind, input);
        assert.equal(result.status, kind === "finish" ? "run_awaiting_review" : "run_reviewed");
        assert.equal(result.run.runId, run.runId);
        const committed = snapshot(root);
        const { projectionUpdate: ignoredProjection, ...replayed } = operation(input);
        const { projectionUpdate: firstProjection, ...first } = result;
        assert.deepEqual(replayed, first, "completed retry must converge to exact canonical facts without derived publication");
        assert.deepEqual(snapshot(root), committed, "completed retry creates no artifacts or writes");
        assert.equal(fs.readFileSync(path.join(root, storage.directory, "context/product-model.json"), "utf8"), canonBefore);
        if (kind === "finish") {
          const pending = getPendingReviewContext({ root });
          assert.equal(pending.review.resultPacket.resultPacketId, result.resultPacket.resultPacketId);
          reviewRun(reviewInput(root));
        }
        createRecoveryCheckpoint({ root, purpose: "Explicit HEAD fixture direction", approvedDecisions: [], currentPosition: "Exact transition recovered", nextExpectedResult: "Start the next bounded fixture Run", openReviewIds: [] });
        assert.equal(restoreSessionFromArtifacts({ root }).status, "session_restored_from_artifacts");
        assert.equal(startRun({ root, executionContractId: contract.executionContractId }).status, "run_started");
      }
    }
  });
}

test("review convergence preserves every non-accept disposition and its existing next-work boundary", async (t) => {
  for (const disposition of ["revise", "expand", "rollback", "escalate"]) {
    const { root, storage, contract, finishInput } = (await fixture(t));
    finishRun(finishInput);
    const input = { ...reviewInput(root), disposition };
    failAt("review", "session", false, () => reviewRun(input));
    const reviewed = reviewRun(input);
    assert.equal(reviewed.reviewDecision.disposition, disposition);
    assert.equal(reviewed.state.requiredPlanAction.disposition, disposition);
    assert.throws(() => startRun({ root, executionContractId: contract.executionContractId }), { code: ["revise", "expand"].includes(disposition) ? "NEXT_WHOLE_PLAN_REQUIRED" : "USER_DIRECTION_REQUIRED" });
    if (["revise", "expand"].includes(disposition)) {
      const next = createNextWholePlanSnapshot({ root, reviewDecisionId: reviewed.reviewDecision.reviewDecisionId, plan: [{ id: "revise", outcome: "Follow the exact reviewed next plan" }] }).artifact;
      const nextContract = createExecutionContract({ root, wholePlanId: next.wholePlanId, capsuleId: contract.capsuleId, scope: "Follow the explicit revised plan", acceptanceCriteria: ["Revised outcome recorded"] }).artifact;
      assert.equal(startRun({ root, executionContractId: nextContract.executionContractId }).status, "run_started");
    }
  }
});

test("already-partial legacy Run records converge only through their exact stored result and decision", async (t) => {
  for (const kind of ["finish", "review"]) {
    const { root, storage, run, finishInput } = (await fixture(t));
    if (kind === "review") finishRun(finishInput);
    const input = kind === "finish" ? finishInput : reviewInput(root);
    const operation = kind === "finish" ? finishRun : reviewRun;
    failAt(kind, "session", false, () => operation(input));
    const file = path.join(root, storage.directory, "sessions/runs", run.runId, "run.json");
    const legacy = JSON.parse(fs.readFileSync(file, "utf8"));
    delete legacy.sessionTransition;
    fs.writeFileSync(file, JSON.stringify(legacy));
    const original = snapshot(root);
    assert.throws(() => operation({ ...input, ...(kind === "finish" ? { outcome: "Invented result" } : { rationale: "Invented judgment" }) }), { code: "RUN_TRANSITION_CONFLICT" });
    assert.deepEqual(snapshot(root), original);
    const result = operation(input);
    assert.equal(result.run.runId, run.runId);
    assert.equal(result.run.resultPacketId, legacy.resultPacketId);
    if (kind === "review") assert.equal(result.run.reviewDecisionId, legacy.reviewDecisionId);
  }
});

for (const kind of ["finish", "review"]) {
  test(`${kind} incomplete transition cannot overwrite fields changed by intervening HEAD work`, async (t) => {
    const { root, storage, finishInput } = (await fixture(t));
    if (kind === "review") finishRun(finishInput);
    const input = kind === "finish" ? finishInput : reviewInput(root);
    const operation = kind === "finish" ? finishRun : reviewRun;
    failAt(kind, "artifact", true, () => operation(input));
    const sessionFile = path.join(root, storage.directory, "sessions/current.json");
    fs.writeFileSync(sessionFile, JSON.stringify({ ...inspectProject(root).state, mode: "paused-by-current-head" }));
    const unchanged = snapshot(root);
    assert.throws(() => operation(input), { code: "RUN_TRANSITION_SESSION_DRIFT" });
    assert.deepEqual(snapshot(root), unchanged);
  });

  test(`${kind} completed replay preserves later checkpoint metadata but rejects changed operation pointers`, async (t) => {
    const { root, storage, finishInput } = (await fixture(t));
    if (kind === "review") finishRun(finishInput);
    const input = kind === "finish" ? finishInput : reviewInput(root);
    const operation = kind === "finish" ? finishRun : reviewRun;
    const original = operation(input);
    createRecoveryCheckpoint({ root, purpose: "Explicit later checkpoint", approvedDecisions: [], currentPosition: "Already completed operation", nextExpectedResult: "Continue the actual current direction", openReviewIds: [] });
    const session = inspectProject(root).state;
    assert.notEqual(session.latestCheckpoint, original.state.latestCheckpoint);
    const withCheckpoint = snapshot(root);
    const replay = operation(input);
    assert.deepEqual(replay.run, original.run);
    assert.deepEqual(replay.state, session, "acknowledge using current Session, not historical state");
    assert.deepEqual(snapshot(root), withCheckpoint);
    assert.equal(restoreSessionFromArtifacts({ root }).status, "session_restored_from_artifacts");
    const sessionFile = path.join(root, storage.directory, "sessions/current.json");
    fs.writeFileSync(sessionFile, JSON.stringify({ ...session, mode: "paused-by-current-head" }));
    const changedDirection = snapshot(root);
    assert.throws(() => operation(input), { code: "RUN_TRANSITION_SESSION_DRIFT" });
    assert.deepEqual(snapshot(root), changedDirection);
  });
}

for (const kind of ["finish", "review"]) {
  test(`${kind} rejects divergent retries, Session drift and tampered evidence without writes`, async (t) => {
    const { root, storage, run, finishInput } = (await fixture(t));
    if (kind === "review") finishRun(finishInput);
    const input = kind === "finish" ? finishInput : reviewInput(root);
    const operation = kind === "finish" ? finishRun : reviewRun;
    failAt(kind, "artifact", true, () => operation(input));
    const prepared = snapshot(root);
    assert.throws(() => operation({ ...input, ...(kind === "finish" ? { outcome: "Different result" } : { disposition: "reject", rationale: "Different decision" }) }), kind === "finish" ? { code: "RUN_TRANSITION_CONFLICT" } : { code: "INVALID_REVIEW_DISPOSITION" });
    if (kind === "review") {
      assert.throws(() => operation({ ...input, disposition: "revise" }), { code: "RUN_TRANSITION_CONFLICT" });
      assert.throws(() => finishRun(finishInput), { code: "RUN_TRANSITION_CONFLICT" });
    }
    assert.deepEqual(snapshot(root), prepared);
    const sessionFile = path.join(root, storage.directory, "sessions/current.json");
    const sessionBytes = fs.readFileSync(sessionFile, "utf8");
    fs.writeFileSync(sessionFile, JSON.stringify({ ...JSON.parse(sessionBytes), mode: "intervening HEAD work" }));
    const drifted = snapshot(root);
    assert.throws(() => operation(input), { code: "RUN_TRANSITION_SESSION_DRIFT" });
    assert.deepEqual(snapshot(root), drifted);
    fs.writeFileSync(sessionFile, sessionBytes);
    const storedRun = JSON.parse(fs.readFileSync(path.join(root, storage.directory, "sessions/runs", run.runId, "run.json"), "utf8"));
    const directory = kind === "finish" ? "result-packets" : "review-decisions";
    const artifactFile = path.join(root, storage.directory, "lineage", directory, `${storedRun.sessionTransition.artifactId}.json`);
    const bytes = fs.readFileSync(artifactFile, "utf8");
    fs.writeFileSync(artifactFile, bytes.replace('"artifactHash": "', '"artifactHash": "tampered'));
    const tampered = snapshot(root);
    assert.throws(() => operation(input), { code: "LINEAGE_DIGEST_MISMATCH" });
    assert.deepEqual(snapshot(root), tampered);
    fs.writeFileSync(artifactFile, bytes);
    const idField = kind === "finish" ? "resultPacketId" : "reviewDecisionId";
    fs.writeFileSync(artifactFile, JSON.stringify({ ...JSON.parse(bytes), [idField]: `${kind === "finish" ? "result-packet" : "review-decision"}-${"0".repeat(24)}` }));
    const idTampered = snapshot(root);
    assert.throws(() => operation(input), { code: "LINEAGE_DIGEST_MISMATCH" });
    assert.deepEqual(snapshot(root), idTampered);
    fs.writeFileSync(artifactFile, bytes);
    assert.equal(operation(input).status, kind === "finish" ? "run_awaiting_review" : "run_reviewed");
  });
}
