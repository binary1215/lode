import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/lode-core.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { createExecutionContract, createWholePlanSnapshot } from "../scripts/lib/execution-lineage.mjs";
import { finishRun, getPendingReviewContext, reviewRun, startRun } from "../scripts/lib/run-lineage.mjs";
import {
  inspectRecoveryCheckpointBasis,
  prepareCompaction,
  syncRecoveryCheckpoint,
} from "../scripts/lib/compaction-recovery.mjs";
import { integrateReviewedRunCheckpoint, restoreSessionFromArtifacts } from "../scripts/lib/session-recovery.mjs";
import { dispatch, catalogTools as mcpTools } from "../scripts/mcp-server.mjs";
import { runCommand } from "../scripts/lode.mjs";

// head_* request inputs below deliberately exercise compatibility dispatch;
// generated catalog and Hook assertions use the canonical Lode vocabulary.
const pluginRoot = path.resolve(import.meta.dirname, "..");
const cliFile = path.join(pluginRoot, "scripts", "head.mjs");
console.log(JSON.stringify({ event: "owned-test-process", pid: process.pid, parentPid: process.ppid, command: process.execPath, args: process.argv.slice(1), cwd: process.cwd(), ports: [] }));

function temporaryProject(prefix = "head-checkpoint-sync-") {
  const parent = process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

function fixture(t) {
  const root = temporaryProject();
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir()));
    assert.match(path.basename(root), /^head-checkpoint-sync-/u);
    fs.rmSync(root, { recursive: true, force: true });
  });
  initializeProject({ root, pluginRoot, runtimes: ["claude", "codex", "opencode"] });
  const storage = inspectProject(root).storage;
  assert.equal(storage.directory, ".lode");
  assert.equal(fs.existsSync(path.resolve(root, ".lode/project.json")), true);
  assert.equal(fs.existsSync(path.resolve(root, ".head/project.json")), false);
  return { root, storage };
}

function direction(overrides = {}) {
  return {
    purpose: "Preserve the current verified project direction",
    approvedDecisions: ["Recovery direction remains HEAD-authored"],
    currentPosition: "The exact current boundary is verified",
    nextExpectedResult: "Continue the same bounded task from current P2 lineage",
    openReviewIds: [],
    ...overrides,
  };
}

function syncInput(root, overrides = {}) {
  const basis = inspectRecoveryCheckpointBasis({ root }).basis;
  return { root, expectedRecoveryBasisId: basis.basisId, ...direction(), ...overrides };
}

function ledgerFiles(root, storage) {
  const directory = path.join(root, storage.directory, "sessions", "ledger");
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
}

function fileSnapshot(root, storage) {
  const files = {};
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else files[path.relative(root, file)] = fs.readFileSync(file).toString("base64");
    }
  }
  walk(path.join(root, storage.directory));
  assert.ok(Object.hasOwn(files, path.join(storage.directory, "project.json")), "snapshot includes the selected Project original");
  return files;
}

async function startFixtureRun(root, label = "checkpoint sync") {
  const capsule = (await compileContext({ root, task: `Verify ${label}`, budget: 32_768, persist: true })).capsule;
  const plan = createWholePlanSnapshot({
    root,
    objective: `Complete ${label}`,
    plan: [{ id: "execute", outcome: label }],
    invariants: ["P3 evidence cannot author P2 direction"],
  }).artifact;
  const contract = createExecutionContract({
    root,
    wholePlanId: plan.wholePlanId,
    capsuleId: capsule.capsuleId,
    scope: `Produce ${label}`,
    acceptanceCriteria: ["The exact result is verified"],
  }).artifact;
  const run = startRun({ root, executionContractId: contract.executionContractId }).run;
  return { capsule, plan, contract, run };
}

function finishInput(root) {
  return {
    root,
    outcome: "The bounded fixture result was produced",
    evidence: [{ uri: "test/recovery-checkpoint-sync.test.mjs", digest: "checkpoint-sync-fixture" }],
    planDelta: "No plan change",
    impactRadius: ["recovery checkpoint sync"],
    verification: [{ check: "fixture", status: "passed" }],
    unknowns: [],
  };
}

function acceptedReviewInput(root) {
  return {
    root,
    reviewContextId: getPendingReviewContext({ root }).review.reviewContextId,
    disposition: "accept",
    rationale: "The exact bounded result satisfies the fixture contract.",
    nextActions: ["Continue from an explicit recovery direction"],
  };
}

function reviewAccepted(root) {
  return reviewRun(acceptedReviewInput(root));
}

function injectRenameFailure(root, storage, boundary, operation) {
  const original = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, target) => {
    const resolved = path.resolve(target);
    const ledger = path.dirname(resolved) === path.join(root, storage.directory, "sessions", "ledger");
    const sessionPointer = resolved === path.join(root, storage.directory, "sessions", "current.json");
    const matches = boundary === "before-ledger" ? ledger : sessionPointer;
    if (!injected && matches) {
      injected = true;
      if (boundary === "after-pointer") original(source, target);
      throw Object.assign(new Error(`Fixture EIO at ${boundary}`), { code: "EIO" });
    }
    return original(source, target);
  };
  try { assert.throws(operation, { code: "EIO" }); }
  finally { fs.renameSync = original; }
  assert.equal(injected, true);
}

function writeCliInput(root, name, input) {
  const file = path.join(root, name);
  fs.writeFileSync(file, `${JSON.stringify(input, null, 2)}\n`);
  return file;
}

function runCliSync(root, inputFile) {
  return new Promise((resolve, reject) => {
    const args = [cliFile, "checkpoint-sync", root, "--input", inputFile, "--json"];
    const child = spawn(process.execPath, args, { cwd: pluginRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    console.log(JSON.stringify({ event: "owned-checkpoint-sync-child", pid: child.pid, parentPid: process.pid, command: process.execPath, args, cwd: pluginRoot, ports: [] }));
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      console.log(JSON.stringify({ event: "owned-checkpoint-sync-child-exit", pid: child.pid, parentPid: process.pid, code, signal, ports: [] }));
      try {
        assert.equal(code, 0, stderr || stdout);
        assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
        resolve(JSON.parse(stdout));
      } catch (error) { reject(error); }
    });
  });
}

test("one sync creates once and one hundred identical retries write no artifact or Session pointer", (t) => {
  const { root, storage } = fixture(t);
  const input = syncInput(root);
  const first = syncRecoveryCheckpoint(input);
  assert.equal(first.outcome, "created");
  assert.deepEqual(first.writes, { checkpointLedger: 1, sessionPointer: 1 });
  const checkpointFiles = ledgerFiles(root, storage);
  const settled = fileSnapshot(root, storage);
  for (let index = 0; index < 100; index += 1) {
    const retry = syncRecoveryCheckpoint(input);
    assert.equal(retry.outcome, "reused");
    assert.deepEqual(retry.writes, { checkpointLedger: 0, sessionPointer: 0 });
    assert.equal(retry.checkpoint.checkpointId, first.checkpoint.checkpointId);
  }
  assert.deepEqual(ledgerFiles(root, storage), checkpointFiles);
  assert.deepEqual(fileSnapshot(root, storage), settled);
  assert.equal(restoreSessionFromArtifacts({ root }).checkpoint.checkpointId, first.checkpoint.checkpointId);
});

test("the same direction text cannot hide changed Run, plan, contract, or Capsule references", async (t) => {
  const { root, storage } = fixture(t);
  const stale = syncInput(root);
  const lineage = (await startFixtureRun(root, "changed lineage references"));
  const before = fileSnapshot(root, storage);
  const rejected = syncRecoveryCheckpoint(stale);
  assert.equal(rejected.outcome, "conflict");
  assert.equal(rejected.reasonCode, "RECOVERY_CHECKPOINT_SYNC_STALE_BASIS");
  assert.deepEqual(fileSnapshot(root, storage), before);
  const accepted = syncRecoveryCheckpoint(syncInput(root));
  assert.equal(accepted.outcome, "created");
  assert.equal(accepted.checkpoint.runPointer.runId, lineage.run.runId);
  assert.equal(accepted.checkpoint.runPointer.wholePlanId, lineage.plan.wholePlanId);
  assert.equal(accepted.checkpoint.runPointer.executionContractId, lineage.contract.executionContractId);
  assert.equal(accepted.checkpoint.runPointer.contextCapsuleDigest, lineage.capsule.capsuleHash);
});

test("concurrent identical syncs converge and concurrent divergent direction cannot overwrite the winner", async (t) => {
  for (const divergent of [false, true]) {
    const { root, storage } = fixture(t);
    const basis = inspectRecoveryCheckpointBasis({ root }).basis;
    const common = { expectedRecoveryBasisId: basis.basisId, ...direction() };
    const firstFile = writeCliInput(root, `.sync-${divergent}-a.json`, common);
    const secondFile = writeCliInput(root, `.sync-${divergent}-b.json`, divergent
      ? { ...common, nextExpectedResult: "A different concurrent direction must not overwrite the winner" }
      : common);
    const [first, second] = await Promise.all([runCliSync(root, firstFile), runCliSync(root, secondFile)]);
    const outcomes = [first.outcome, second.outcome].sort();
    assert.deepEqual(outcomes, divergent ? ["conflict", "created"] : ["created", "reused"]);
    assert.equal(ledgerFiles(root, storage).length, 1);
    const restored = restoreSessionFromArtifacts({ root });
    const winner = [first, second].find((result) => result.outcome === "created");
    assert.equal(restored.checkpoint.checkpointId, winner.checkpoint.checkpointId);
  }
});

test("incomplete Run publication defers sync while stable pending review remains eligible", async (t) => {
  const { root, storage } = fixture(t);
  (await startFixtureRun(root, "interrupted Run transition"));
  const finish = finishInput(root);
  injectRenameFailure(root, storage, "before-pointer", () => finishRun(finish));
  const deferredBasis = inspectRecoveryCheckpointBasis({ root });
  assert.equal(deferredBasis.syncAvailability, "deferred-run-transition");
  const before = fileSnapshot(root, storage);
  const deferred = syncRecoveryCheckpoint({
    root,
    expectedRecoveryBasisId: deferredBasis.basis.basisId,
    ...direction(),
  });
  assert.equal(deferred.outcome, "deferred");
  assert.equal(deferred.reasonCode, "RUN_TRANSITION_INCOMPLETE");
  assert.deepEqual(fileSnapshot(root, storage), before);

  finishRun(finish);
  const stableBasis = inspectRecoveryCheckpointBasis({ root });
  assert.equal(stableBasis.syncAvailability, "ready");
  assert.equal(stableBasis.basis.references.pendingReview.runId, inspectProject(root).state.pendingReview.runId);
  assert.equal(syncRecoveryCheckpoint({ root, expectedRecoveryBasisId: stableBasis.basis.basisId, ...direction() }).outcome, "created");
});

test("open compaction preserves its checkpoint and defers only a changed general sync", (t) => {
  const { root, storage } = fixture(t);
  const preparedDirection = direction();
  const prepared = prepareCompaction({ root, runtime: "manual", userTurnIdAtPrepare: 3, ...preparedDirection });
  const basis = inspectRecoveryCheckpointBasis({ root });
  assert.equal(basis.syncAvailability, "deferred-compaction");
  const exact = syncRecoveryCheckpoint({ root, expectedRecoveryBasisId: basis.basis.basisId, ...preparedDirection });
  assert.equal(exact.outcome, "reused");
  assert.equal(exact.checkpoint.checkpointId, prepared.checkpoint.checkpointId);
  const before = fileSnapshot(root, storage);
  const changed = syncRecoveryCheckpoint({
    root,
    expectedRecoveryBasisId: basis.basis.basisId,
    ...preparedDirection,
    nextExpectedResult: "A general sync must wait instead of replacing an open epoch",
  });
  assert.equal(changed.outcome, "deferred");
  assert.equal(changed.reasonCode, "COMPACTION_EPOCH_OPEN");
  assert.deepEqual(fileSnapshot(root, storage), before);
});

test("accepted Run integration is reused exactly but never copied into changed general direction", async (t) => {
  const { root, storage } = fixture(t);
  const lineage = (await startFixtureRun(root, "accepted integration reuse"));
  const finished = finishRun(finishInput(root));
  const reviewed = reviewAccepted(root);
  const integrationDirection = direction({
    purpose: "Integrate the exact accepted Run",
    approvedDecisions: ["Fresh HEAD accepted the exact ResultPacket"],
    currentPosition: "The accepted result is integrated",
    nextExpectedResult: "Continue with the next explicit bounded unit",
  });
  const integrated = integrateReviewedRunCheckpoint({
    root,
    runId: lineage.run.runId,
    reviewDecisionId: reviewed.reviewDecision.reviewDecisionId,
    ...integrationDirection,
  });
  assert.equal(integrated.checkpoint.reviewedRunIntegration.resultPacketId, finished.resultPacket.resultPacketId);
  const basis = inspectRecoveryCheckpointBasis({ root }).basis;
  const exact = syncRecoveryCheckpoint({ root, expectedRecoveryBasisId: basis.basisId, ...integrationDirection });
  assert.equal(exact.outcome, "reused");
  assert.equal(exact.checkpoint.checkpointId, integrated.checkpoint.checkpointId);
  assert.ok(exact.checkpoint.reviewedRunIntegration);

  const changed = syncRecoveryCheckpoint({
    root,
    expectedRecoveryBasisId: basis.basisId,
    ...integrationDirection,
    nextExpectedResult: "A later HEAD-authored direction without copied integration authority",
  });
  assert.equal(changed.outcome, "created");
  assert.equal(changed.checkpoint.reviewedRunIntegration, null);
  const beforeForbidden = fileSnapshot(root, storage);
  assert.throws(() => syncRecoveryCheckpoint({
    root,
    expectedRecoveryBasisId: changed.resultingBasis.basisId,
    ...integrationDirection,
    reviewedRunIntegration: integrated.checkpoint.reviewedRunIntegration,
  }), { code: "INVALID_RECOVERY_CHECKPOINT_SYNC_INPUT" });
  assert.deepEqual(fileSnapshot(root, storage), beforeForbidden);
});

test("actual write failures at all three publication boundaries retry without duplicate ledger entries", (t) => {
  for (const boundary of ["before-ledger", "before-pointer", "after-pointer"]) {
    const { root, storage } = fixture(t);
    const input = syncInput(root, { currentPosition: `Testing ${boundary}` });
    injectRenameFailure(root, storage, boundary, () => syncRecoveryCheckpoint(input));
    assert.equal(ledgerFiles(root, storage).length, boundary === "before-ledger" ? 0 : 1);
    const pointerBeforeRetry = fs.readFileSync(path.join(root, storage.directory, "sessions", "current.json"), "utf8");
    const retried = syncRecoveryCheckpoint(input);
    assert.equal(retried.outcome, boundary === "after-pointer" ? "reused" : "created");
    assert.equal(ledgerFiles(root, storage).length, 1);
    if (boundary === "after-pointer") {
      assert.equal(fs.readFileSync(path.join(root, storage.directory, "sessions", "current.json"), "utf8"), pointerBeforeRetry);
    }
    assert.equal(restoreSessionFromArtifacts({ root }).checkpoint.checkpointId, retried.checkpoint.checkpointId);
  }
});

test("an orphaned request cannot revert a different direction published before its retry", (t) => {
  const { root, storage } = fixture(t);
  const original = syncInput(root, { nextExpectedResult: "Direction A must not return after another publish" });
  injectRenameFailure(root, storage, "before-pointer", () => syncRecoveryCheckpoint(original));
  assert.equal(ledgerFiles(root, storage).length, 1, "A ledger entry exists but was never selected by the Session pointer");

  const currentBasis = inspectRecoveryCheckpointBasis({ root }).basis;
  assert.equal(currentBasis.basisId, original.expectedRecoveryBasisId);
  const replacement = syncRecoveryCheckpoint({
    root,
    expectedRecoveryBasisId: currentBasis.basisId,
    ...direction({ nextExpectedResult: "Direction B is the current published direction" }),
  });
  assert.equal(replacement.outcome, "created");
  const pointerAfterReplacement = fs.readFileSync(path.join(root, storage.directory, "sessions", "current.json"), "utf8");
  const retry = syncRecoveryCheckpoint(original);
  assert.equal(retry.outcome, "conflict");
  assert.equal(retry.reasonCode, "RECOVERY_CHECKPOINT_SYNC_STALE_BASIS");
  assert.equal(fs.readFileSync(path.join(root, storage.directory, "sessions", "current.json"), "utf8"), pointerAfterReplacement);
  assert.equal(restoreSessionFromArtifacts({ root }).checkpoint.checkpointId, replacement.checkpoint.checkpointId);
  assert.equal(ledgerFiles(root, storage).length, 2, "the original orphan and the selected replacement remain distinct; retry adds nothing");
});

test("an interrupted review Session publish defers sync and the exact review retry recovers", async (t) => {
  const { root, storage } = fixture(t);
  (await startFixtureRun(root, "interrupted review transition"));
  finishRun(finishInput(root));
  const review = acceptedReviewInput(root);
  injectRenameFailure(root, storage, "before-pointer", () => reviewRun(review));
  const basis = inspectRecoveryCheckpointBasis({ root });
  assert.equal(basis.syncAvailability, "deferred-run-transition");
  assert.equal(basis.basis.runTransition.transition.kind, "review");
  const before = fileSnapshot(root, storage);
  const deferred = syncRecoveryCheckpoint({ root, expectedRecoveryBasisId: basis.basis.basisId, ...direction() });
  assert.equal(deferred.outcome, "deferred");
  assert.deepEqual(fileSnapshot(root, storage), before);
  const recovered = reviewRun(review);
  assert.equal(recovered.status, "run_reviewed");
  assert.equal(inspectRecoveryCheckpointBasis({ root }).syncAvailability, "ready");
});

test("missing pending ResultPacket remains non-authoritative evidence loss and preserves exact reuse", async (t) => {
  const { root, storage } = fixture(t);
  (await startFixtureRun(root, "missing pending ResultPacket evidence"));
  const finished = finishRun(finishInput(root));
  const input = syncInput(root);
  const created = syncRecoveryCheckpoint(input);
  const resultFile = path.join(root, storage.directory, "lineage", "result-packets", `${finished.resultPacket.resultPacketId}.json`);
  fs.unlinkSync(resultFile);
  const basis = inspectRecoveryCheckpointBasis({ root });
  assert.equal(basis.syncAvailability, "ready");
  assert.equal(basis.basis.runTransition.transition.artifactStatus, "missing-evidence");
  const before = fileSnapshot(root, storage);
  const reused = syncRecoveryCheckpoint({ root, expectedRecoveryBasisId: basis.basis.basisId, ...direction() });
  assert.equal(reused.outcome, "reused");
  assert.equal(reused.checkpoint.checkpointId, created.checkpoint.checkpointId);
  assert.deepEqual(fileSnapshot(root, storage), before);
  assert.equal(restoreSessionFromArtifacts({ root }).projection.pendingReview.resultEvidence.status, "missing-evidence");
});

test("CLI and typed MCP share Core semantics while entry and missing Host hooks remain read-only", async (t) => {
  const { root, storage } = fixture(t);
  const initial = fileSnapshot(root, storage);
  const cliBasis = (await runCommand(["checkpoint-basis", root]));
  const mcpBasis = await dispatch({ jsonrpc: "2.0", id: 801, method: "tools/call", params: { name: "head_checkpoint_basis", arguments: { project_root: root } } });
  assert.equal(mcpBasis.result.structuredContent.basis.basisId, cliBasis.basis.basisId);
  assert.deepEqual(fileSnapshot(root, storage), initial);
  assert.equal((await runCommand(["help"])).commands.some((command) => command.includes("checkpoint-sync")), false);
  assert.equal((await runCommand(["help-all"])).commands.some((command) => command.includes("checkpoint-sync")), true);
  assert.equal(mcpTools.find((tool) => tool.name === "lode_checkpoint_basis").annotations.readOnlyHint, true);
  assert.equal(mcpTools.find((tool) => tool.name === "lode_checkpoint_sync").annotations.idempotentHint, true);

  const requested = direction();
  const synced = await dispatch({
    jsonrpc: "2.0",
    id: 802,
    method: "tools/call",
    params: {
      name: "head_checkpoint_sync",
      arguments: {
        project_root: root,
        expected_recovery_basis_id: cliBasis.basis.basisId,
        purpose: requested.purpose,
        approved_decisions: requested.approvedDecisions,
        current_position: requested.currentPosition,
        next_expected_result: requested.nextExpectedResult,
        open_review_ids: requested.openReviewIds,
      },
    },
  });
  assert.equal(synced.result.structuredContent.outcome, "created");
  const checkpointed = fileSnapshot(root, storage);
  const entry = await dispatch({ jsonrpc: "2.0", id: 803, method: "tools/call", params: { name: "head_conversation_enter", arguments: { project_root: root } } });
  assert.equal(entry.result.structuredContent.persisted, false);
  assert.deepEqual(fileSnapshot(root, storage), checkpointed);

  const { root: emptyRoot, storage: emptyStorage } = fixture(t);
  const emptyBefore = fileSnapshot(emptyRoot, emptyStorage);
  const emptyEntry = await dispatch({ jsonrpc: "2.0", id: 804, method: "tools/call", params: { name: "head_conversation_enter", arguments: { project_root: emptyRoot } } });
  assert.equal(emptyEntry.result.structuredContent.recoveryState, "no-current-checkpoint");
  assert.equal(inspectProject(emptyRoot).state.latestCheckpoint, null);
  assert.deepEqual(fileSnapshot(emptyRoot, emptyStorage), emptyBefore, "short Observe entry creates no first checkpoint");
  const contract = await dispatch({ jsonrpc: "2.0", id: 805, method: "tools/call", params: { name: "head_core_contract", arguments: {} } });
  assert.deepEqual(contract.result.structuredContent.runtime.compactionLifecycle.packagedProviderEventAdapters, {
    claude: "not-bound", codex: "not-bound", opencode: "not-bound",
  });
});

test("checkpoint tamper remains a hard failure and creates no compensating direction", (t) => {
  const { root, storage } = fixture(t);
  const input = syncInput(root);
  const created = syncRecoveryCheckpoint(input);
  const file = path.join(root, storage.directory, "sessions", "ledger", `${created.checkpoint.checkpointId}.json`);
  const bytes = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, bytes.replace("current verified project direction", "tampered project direction"));
  const before = fileSnapshot(root, storage);
  assert.throws(() => inspectRecoveryCheckpointBasis({ root }), { code: "COMPACTION_DIGEST_MISMATCH" });
  assert.throws(() => syncRecoveryCheckpoint(input), { code: "COMPACTION_DIGEST_MISMATCH" });
  assert.deepEqual(fileSnapshot(root, storage), before);
});
