import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/lode-core.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import {
  createRecoveryCheckpoint,
  inspectRecoveryCheckpointBasis,
  prepareCompaction,
} from "../scripts/lib/compaction-recovery.mjs";
import { createExecutionContract, createWholePlanSnapshot } from "../scripts/lib/execution-lineage.mjs";
import { formatCheckpointDiagnosis, formatMcpToolContent } from "../scripts/lib/cli-presentation.mjs";
import { inspectRecoveryCheckpointDiagnosis } from "../scripts/lib/recovery-checkpoint-diagnosis.mjs";
import { finishRun, startRun } from "../scripts/lib/run-lineage.mjs";
import { dispatch, catalogTools as mcpTools } from "../scripts/mcp-server.mjs";
import { runCommand } from "../scripts/lode.mjs";

// head_* request inputs below deliberately exercise compatibility dispatch;
// generated catalog and Hook assertions use the canonical Lode vocabulary.
const pluginRoot = path.resolve(import.meta.dirname, "..");

function temporaryProject(prefix = "head-checkpoint-diagnosis-") {
  const parent = process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

function fixture(t) {
  const root = temporaryProject();
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir()));
    assert.match(path.basename(root), /^head-checkpoint-diagnosis-/u);
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
    purpose: "Preserve the exact verified recovery direction",
    approvedDecisions: ["P4 diagnosis cannot author P2 direction"],
    currentPosition: "The bounded recovery fixture is verified",
    nextExpectedResult: "Continue only from explicit P2 direction",
    openReviewIds: [],
    ...overrides,
  };
}

function checkpoint(root, overrides = {}) {
  return createRecoveryCheckpoint({ root, ...direction(overrides) }).checkpoint;
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

async function prepareRun(root, label = "checkpoint diagnosis") {
  const capsule = (await compileContext({ root, task: `Verify ${label}`, budget: 32_768, persist: true })).capsule;
  const plan = createWholePlanSnapshot({
    root,
    objective: `Complete ${label}`,
    plan: [{ id: "execute", outcome: label }],
    invariants: ["Diagnosis evidence cannot become recovery authority"],
  }).artifact;
  const contract = createExecutionContract({
    root,
    wholePlanId: plan.wholePlanId,
    capsuleId: capsule.capsuleId,
    scope: `Produce ${label}`,
    acceptanceCriteria: ["The exact bounded result is verified"],
  }).artifact;
  return { capsule, plan, contract };
}

async function startFixtureRun(root, label) {
  const prepared = (await prepareRun(root, label));
  return { ...prepared, run: startRun({ root, executionContractId: prepared.contract.executionContractId }).run };
}

function finishFixtureRun(root) {
  return finishRun({
    root,
    outcome: "The bounded diagnosis fixture completed",
    evidence: [{ uri: "test/recovery-checkpoint-diagnosis.test.mjs", digest: "diagnosis-fixture" }],
    planDelta: "No recovery direction change",
    impactRadius: ["checkpoint diagnosis"],
    verification: [{ check: "fixture", status: "passed" }],
    unknowns: [],
  });
}

function withDeniedMutators(operation) {
  const names = ["appendFileSync", "copyFileSync", "mkdirSync", "renameSync", "rmSync", "unlinkSync", "writeFileSync"];
  const originals = new Map(names.map((name) => [name, fs[name]]));
  const calls = [];
  for (const name of names) {
    fs[name] = (...args) => {
      calls.push({ name, target: String(args[0]) });
      throw Object.assign(new Error(`Unexpected mutation: ${name}`), { code: "UNEXPECTED_DIAGNOSIS_MUTATION" });
    };
  }
  try {
    return { value: operation(), calls };
  } finally {
    for (const [name, original] of originals) fs[name] = original;
  }
}

test("diagnosis distinguishes no pointer, missing ledger artifact, corruption, and optional P3 evidence loss", async (t) => {
  const { root: noPointerRoot, storage: noPointerStorage } = fixture(t);
  const noPointer = inspectRecoveryCheckpointDiagnosis({ root: noPointerRoot });
  assert.equal(noPointer.diagnosis.state, "no-current-checkpoint");
  assert.equal(noPointer.currentCheckpoint.pointer, "none");
  assert.equal(noPointer.artifactRecovery.status, "not-applicable");
  assert.equal(noPointer.checkpointUpdate.freshDirectionPublishable, true);

  const { root: missingRoot, storage: missingStorage } = fixture(t);
  const missingStateFile = path.join(missingRoot, missingStorage.directory, "sessions", "current.json");
  const missingState = JSON.parse(fs.readFileSync(missingStateFile, "utf8"));
  const missingId = "checkpoint-000000000000000000000000";
  fs.writeFileSync(missingStateFile, `${JSON.stringify({ ...missingState, latestCheckpoint: missingId }, null, 2)}\n`);
  const missing = inspectRecoveryCheckpointDiagnosis({ root: missingRoot });
  assert.equal(missing.diagnosis.state, "current-checkpoint-artifact-missing");
  assert.equal(missing.currentCheckpoint.checkpointId, missingId);
  assert.equal(missing.diagnosis.reasonCode, "RECOVERY_CHECKPOINT_NOT_FOUND");
  assert.equal(missing.recoveryDependentWorkBlocked, true);

  const { root: corruptRoot, storage: corruptStorage } = fixture(t);
  const corruptCheckpoint = checkpoint(corruptRoot);
  const corruptFile = path.join(corruptRoot, corruptStorage.directory, "sessions", "ledger", `${corruptCheckpoint.checkpointId}.json`);
  fs.writeFileSync(corruptFile, fs.readFileSync(corruptFile, "utf8").replace("exact verified recovery direction", "tampered recovery direction"));
  const corrupt = inspectRecoveryCheckpointDiagnosis({ root: corruptRoot });
  assert.equal(corrupt.diagnosis.state, "checkpoint-integrity-failure");
  assert.equal(corrupt.diagnosis.reasonCode, "COMPACTION_DIGEST_MISMATCH");
  assert.notEqual(corrupt.diagnosis.state, "no-current-checkpoint");

  const { root: optionalRoot, storage: optionalStorage } = fixture(t);
  (await startFixtureRun(optionalRoot, "optional result evidence loss"));
  const finished = finishFixtureRun(optionalRoot);
  checkpoint(optionalRoot, { currentPosition: "One result is awaiting Fresh HEAD review" });
  fs.unlinkSync(path.join(optionalRoot, optionalStorage.directory, "lineage", "result-packets", `${finished.resultPacket.resultPacketId}.json`));
  const optional = inspectRecoveryCheckpointDiagnosis({ root: optionalRoot });
  assert.equal(optional.diagnosis.state, "verified-checkpoint-with-missing-result-evidence");
  assert.equal(optional.artifactRecovery.status, "verified-with-missing-optional-evidence");
  assert.deepEqual(optional.artifactRecovery.optionalResultEvidence.missingResultPacketIds, [finished.resultPacket.resultPacketId]);
  assert.equal(optional.recoveryDependentWorkBlocked, false);
  assert.equal(optional.reviewDependentWorkBlocked, true);
  assert.equal(optional.userDecisionRequired, false);
});

test("same checkpoint bytes never become a mechanical semantic-freshness claim after Session lineage changes", async (t) => {
  const { root, storage } = fixture(t);
  const current = checkpoint(root);
  (await startFixtureRun(root, "new Session lineage after checkpoint"));
  const diagnosis = inspectRecoveryCheckpointDiagnosis({ root });
  assert.equal(diagnosis.currentCheckpoint.checkpointId, current.checkpointId);
  assert.equal(diagnosis.diagnosis.state, "verified-checkpoint");
  assert.equal(diagnosis.diagnosis.reasonCode, "CHECKPOINT_ARTIFACT_RECOVERY_VERIFIED");
  assert.equal(diagnosis.checkpointUpdate.status, "ready");
  assert.equal(diagnosis.checkpointUpdate.freshDirectionPublishable, true);
  assert.equal(diagnosis.semanticFreshness.mechanicallyDetermined, false);
  assert.equal(diagnosis.semanticFreshness.digestEqualityProvesCurrentIntent, false);
  assert.equal(diagnosis.semanticFreshness.automaticHeadAssessmentTriggered, false);
  assert.equal(diagnosis.ordinaryWorkBlocked, false);
});

test("structurally invalid lineage remains an integrity failure rather than reference drift", async (t) => {
  const { root, storage } = fixture(t);
  const prepared = (await prepareRun(root, "invalid lineage classification"));
  startRun({ root, executionContractId: prepared.contract.executionContractId });
  checkpoint(root);
  const planFile = path.join(root, storage.directory, "lineage", "whole-plans", `${prepared.plan.wholePlanId}.json`);
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  plan.protocol.name = "invalid-lineage-protocol";
  fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);

  const diagnosis = inspectRecoveryCheckpointDiagnosis({ root });
  assert.equal(diagnosis.diagnosis.state, "checkpoint-integrity-failure");
  assert.equal(diagnosis.diagnosis.reasonCode, "INVALID_LINEAGE_ARTIFACT");
  assert.equal(diagnosis.checkpointUpdate.status, "unavailable");
  assert.notEqual(diagnosis.diagnosis.state, "checkpoint-reference-drift");
});

test("missing required lineage is a hard recovery failure, not optional ResultPacket loss", async (t) => {
  const { root, storage } = fixture(t);
  const prepared = (await prepareRun(root, "required lineage loss"));
  startRun({ root, executionContractId: prepared.contract.executionContractId });
  checkpoint(root);
  fs.unlinkSync(path.join(root, storage.directory, "lineage", "whole-plans", `${prepared.plan.wholePlanId}.json`));

  const diagnosis = inspectRecoveryCheckpointDiagnosis({ root });
  assert.equal(diagnosis.diagnosis.state, "required-recovery-artifact-missing");
  assert.equal(diagnosis.diagnosis.reasonCode, "LINEAGE_ARTIFACT_NOT_FOUND");
  assert.equal(diagnosis.artifactRecovery.status, "failed");
  assert.equal(diagnosis.recoveryDependentWorkBlocked, true);
  assert.equal(diagnosis.reviewDependentWorkBlocked, false);
  assert.notEqual(diagnosis.diagnosis.state, "verified-checkpoint-with-missing-result-evidence");
});

test("missing selected Run canon and malformed present Run canon remain different failure classes", async (t) => {
  const { root: missingRoot, storage: missingStorage } = fixture(t);
  const missing = (await startFixtureRun(missingRoot, "missing selected Run canon"));
  checkpoint(missingRoot);
  const missingRunFile = path.join(missingRoot, missingStorage.directory, "sessions", "runs", missing.run.runId, "run.json");
  fs.unlinkSync(missingRunFile);
  const missingDiagnosis = inspectRecoveryCheckpointDiagnosis({ root: missingRoot });
  assert.equal(missingDiagnosis.diagnosis.state, "required-recovery-artifact-missing");
  assert.equal(missingDiagnosis.diagnosis.reasonCode, "INVALID_RUN_CANON");

  const { root: malformedRoot, storage: malformedStorage } = fixture(t);
  const malformed = (await startFixtureRun(malformedRoot, "malformed selected Run canon"));
  checkpoint(malformedRoot);
  const malformedRunFile = path.join(malformedRoot, malformedStorage.directory, "sessions", "runs", malformed.run.runId, "run.json");
  const malformedRun = JSON.parse(fs.readFileSync(malformedRunFile, "utf8"));
  malformedRun.wholePlanId = null;
  fs.writeFileSync(malformedRunFile, `${JSON.stringify(malformedRun, null, 2)}\n`);
  const malformedDiagnosis = inspectRecoveryCheckpointDiagnosis({ root: malformedRoot });
  assert.equal(malformedDiagnosis.diagnosis.state, "checkpoint-integrity-failure");
  assert.equal(malformedDiagnosis.diagnosis.reasonCode, "INVALID_RUN_CANON");
});

test("verified open compaction reports a mechanical sync defer without blocking ordinary work", (t) => {
  const { root, storage } = fixture(t);
  const prepared = prepareCompaction({
    root,
    runtime: "manual",
    userTurnIdAtPrepare: 3,
    ...direction(),
  });
  const before = fileSnapshot(root, storage);
  const diagnosis = inspectRecoveryCheckpointDiagnosis({ root });
  assert.equal(diagnosis.diagnosis.state, "verified-checkpoint");
  assert.equal(diagnosis.currentCheckpoint.checkpointId, prepared.checkpoint.checkpointId);
  assert.equal(diagnosis.checkpointUpdate.status, "deferred-compaction");
  assert.equal(diagnosis.checkpointUpdate.freshDirectionPublishable, false);
  assert.equal(diagnosis.checkpointUpdate.exactCurrentReuseMayConverge, true);
  assert.equal(diagnosis.ordinaryWorkBlocked, false);
  assert.deepEqual(fileSnapshot(root, storage), before);
});

test("a Session change between B0, restore, and B1 returns retry-needed instead of a synthesized normal state", async (t) => {
  const { root, storage } = fixture(t);
  const prepared = (await prepareRun(root, "sequential diagnosis drift"));
  const current = checkpoint(root);
  const checkpointFile = path.join(root, storage.directory, "sessions", "ledger", `${current.checkpointId}.json`);
  const originalRead = fs.readFileSync;
  let checkpointReads = 0;
  let injected = false;
  fs.readFileSync = (...args) => {
    const value = originalRead(...args);
    if (!injected && path.resolve(String(args[0])) === checkpointFile) {
      checkpointReads += 1;
      if (checkpointReads === 2) {
        injected = true;
        startRun({ root, executionContractId: prepared.contract.executionContractId });
      }
    }
    return value;
  };
  let diagnosis;
  try {
    diagnosis = inspectRecoveryCheckpointDiagnosis({ root });
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(injected, true);
  assert.equal(diagnosis.diagnosis.state, "observation-changed-retry");
  assert.equal(diagnosis.observationConsistency.retryRequired, true);
  assert.equal(diagnosis.observationConsistency.atomicFilesystemSnapshot, false);
  assert.equal(diagnosis.observationConsistency.abaChangesDetectable, false);
  assert.equal(diagnosis.checkpointUpdate.status, "recheck-required");
});

test("diagnosis performs no mutator call, does not change basis identity, and never creates a lock or cache", (t) => {
  for (const mode of ["no-pointer", "verified", "missing-ledger"]) {
    const { root, storage } = fixture(t);
    if (mode === "verified") checkpoint(root);
    if (mode === "missing-ledger") {
      const file = path.join(root, storage.directory, "sessions", "current.json");
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, `${JSON.stringify({ ...state, latestCheckpoint: "checkpoint-111111111111111111111111" }, null, 2)}\n`);
    }
    const before = fileSnapshot(root, storage);
    const operationsDirectory = path.join(root, storage.directory, ".operations");
    const operationsBefore = fs.existsSync(operationsDirectory) ? fs.readdirSync(operationsDirectory).sort() : null;
    const basisBefore = mode === "missing-ledger" ? null : inspectRecoveryCheckpointBasis({ root });
    const guarded = withDeniedMutators(() => inspectRecoveryCheckpointDiagnosis({ root }));
    assert.deepEqual(guarded.calls, []);
    assert.deepEqual(fileSnapshot(root, storage), before);
    assert.deepEqual(guarded.value.writes, { checkpointLedger: 0, sessionPointer: 0, mutationLease: 0, diagnosisCache: 0 });
    if (basisBefore) assert.equal(inspectRecoveryCheckpointBasis({ root }).basis.basisId, basisBefore.basis.basisId);
    const operationsAfter = fs.existsSync(operationsDirectory) ? fs.readdirSync(operationsDirectory).sort() : null;
    assert.deepEqual(operationsAfter, operationsBefore);
  }
});

test("CLI, typed MCP, project readiness, and human presentation share the bounded diagnosis contract", async (t) => {
  const { root, storage } = fixture(t);
  checkpoint(root);
  const direct = inspectRecoveryCheckpointDiagnosis({ root });
  const cli = (await runCommand(["checkpoint-diagnose", root]));
  assert.deepEqual(cli, direct);

  const tool = mcpTools.find((candidate) => candidate.name === "lode_checkpoint_diagnose");
  assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(tool.inputSchema.required, ["project_root"]);
  const mcp = await dispatch({
    jsonrpc: "2.0",
    id: "checkpoint-diagnosis",
    method: "tools/call",
    params: { name: "head_checkpoint_diagnose", arguments: { project_root: root } },
  });
  assert.deepEqual(mcp.result.structuredContent, direct);
  assert.equal(mcp.result.content[0].text, formatMcpToolContent("head_checkpoint_diagnose", direct));
  assert.equal((await runCommand(["help"])).commands.some((command) => command.includes("checkpoint-diagnose")), true);
  assert.equal((await runCommand(["help-all"])).commands.some((command) => command.includes("checkpoint-diagnose")), true);

  const output = formatCheckpointDiagnosis(direct);
  assert.match(output, /artifact recovery verified/u);
  assert.match(output, /Semantic freshness: not mechanically determined/u);
  assert.match(output, /User action: none/u);
  assert.match(output, /wrote no checkpoint, lock, cache, approval, or authority/u);
  assert.doesNotMatch(output, /semantically current|current intent is verified/u);
});
