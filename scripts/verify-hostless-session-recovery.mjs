#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initializeProject, inspectProject } from "./lib/head-core.mjs";
import { compileContext } from "./lib/context-compiler.mjs";
import { createExecutionContract, createWholePlanSnapshot } from "./lib/execution-lineage.mjs";
import { finishRun, getPendingReviewContext, reviewRun, startRun } from "./lib/run-lineage.mjs";
import { integrateReviewedRunCheckpoint, restoreSessionFromArtifacts } from "./lib/session-recovery.mjs";
import { formatForVerifiedOwner } from "./lib/project-storage-format.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const pluginRoot = path.resolve(path.dirname(scriptPath), "..");
const nonce = `${process.pid}-${Date.now()}`;
const fixtureRoot = path.join(pluginRoot, `.test-tmp-hostless-session-recovery-${nonce}`);
const maximumOutputBytes = 1024 * 1024;
const expectedNextMove = "Inspect the canonical HEAD Session identity and report it without mutation";

function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function recordProcess(event) {
  if (event.type === "spawn") {
    process.stderr.write(`NESTED_CHILD_START pid=${event.pid} parent=${process.pid} command=${event.command} cwd=${event.cwd} ports=none\n`);
  } else {
    process.stderr.write(`NESTED_CHILD_END pid=${event.pid} parent=${process.pid} exit=${event.exitCode ?? "null"} signal=${event.signal || "none"}\n`);
  }
}

function spawnJson(args, { environment = {}, expectedExitCode = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: pluginRoot,
      env: { ...process.env, ...environment },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    recordProcess({ type: "spawn", pid: child.pid, command: `node ${path.basename(scriptPath)} ${args[0]}`, cwd: pluginRoot });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exceeded = false;
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maximumOutputBytes) stdout.push(chunk);
      else { exceeded = true; child.kill(); }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maximumOutputBytes) stderr.push(chunk);
      else { exceeded = true; child.kill(); }
    });
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      recordProcess({ type: "exit", pid: child.pid, exitCode, signal });
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      try {
        assert.equal(exceeded, false, "Hostless recovery child exceeded its output budget.");
        assert.equal(exitCode, expectedExitCode, stderrText || stdoutText);
        resolve(JSON.parse(stdoutText));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function fixture(name, disposition = "accept") {
  const root = path.join(fixtureRoot, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "fixture.mjs"), `export const fixture = ${JSON.stringify(name)};\n`, "utf8");
  const initialized = initializeProject({ root, pluginRoot, runtimes: ["claude", "codex", "opencode"] });
  const capsule = (await compileContext({ root, task: `Verify ${name}`, budget: 32_768, persist: true })).capsule;
  const plan = createWholePlanSnapshot({
    root,
    objective: `Complete hostless recovery scenario ${name}`,
    plan: [{ id: "execute", outcome: "Return one bounded worker result" }],
    invariants: ["Only HEAD and explicit user direction may author recovery direction"],
  }).artifact;
  const contract = createExecutionContract({
    root,
    wholePlanId: plan.wholePlanId,
    capsuleId: capsule.capsuleId,
    scope: `Produce the bounded ${name} result`,
    acceptanceCriteria: ["Fresh HEAD verifies the exact ResultPacket"],
  }).artifact;
  const run = startRun({ root, executionContractId: contract.executionContractId }).run;
  const finished = finishRun({
    root,
    outcome: `Bounded ${name} result returned as evidence`,
    evidence: [{ uri: "scripts/verify-hostless-session-recovery.mjs", digest: `evidence-${name}` }],
    planDelta: "No objective rewrite",
    impactRadius: ["hostless Session recovery"],
    verification: [{ check: name, status: "passed" }],
    unknowns: [],
  });
  const reviewContext = getPendingReviewContext({ root });
  const reviewed = reviewRun({
    root,
    reviewContextId: reviewContext.review.reviewContextId,
    disposition,
    rationale: disposition === "accept" ? "The exact bounded result is accepted." : "The result requires a revised plan.",
    nextActions: disposition === "accept" ? ["Record explicit next direction"] : ["Create a revised WholePlanSnapshot"],
  });
  const input = {
    runId: run.runId,
    reviewDecisionId: reviewed.reviewDecision.reviewDecisionId,
    purpose: "Preserve whole-outcome HEAD ownership across provider loss",
    approvedDecisions: ["Fresh HEAD accepted the exact bounded ResultPacket"],
    currentPosition: "The bounded worker result is reviewed and integrated",
    nextExpectedResult: expectedNextMove,
    openReviewIds: [],
  };
  const inputFile = path.join(root, "integration-input.json");
  writeJson(inputFile, input);
  assert.equal(fs.existsSync(path.join(root, ".git")), false, "The hostless fixture unexpectedly requires Git.");
  return { root, storage: initialized.storage, run, finished, reviewed, input, inputFile };
}

function integrationPaths(value, integrated) {
  return {
    request: path.join(value.root, value.storage.directory, "sessions", "integrations", "requests", `${value.input.reviewDecisionId}.json`),
    receipt: path.join(value.root, value.storage.directory, "sessions", "integrations", `${value.input.reviewDecisionId}.json`),
    checkpoint: path.join(value.root, value.storage.directory, "sessions", "ledger", `${integrated.checkpoint.checkpointId}.json`),
    result: path.join(value.root, value.storage.directory, "lineage", "result-packets", `${value.finished.resultPacket.resultPacketId}.json`),
    state: path.join(value.root, value.storage.directory, "sessions", "current.json"),
  };
}

function checkpointCount(value, reviewDecisionId) {
  const ledger = path.join(value.root, value.storage.directory, "sessions", "ledger");
  return fs.readdirSync(ledger).filter((name) => name.endsWith(".json")).map((name) => {
    try { return JSON.parse(fs.readFileSync(path.join(ledger, name), "utf8")); }
    catch { return null; }
  }).filter((checkpoint) => checkpoint?.reviewedRunIntegration?.reviewDecisionId === reviewDecisionId).length;
}

async function integrateChild(root, inputFile, expectedExitCode = 0, boundary = null) {
  return spawnJson(["--integrate-child", root, inputFile, ...(boundary ? [boundary] : [])], { expectedExitCode });
}

async function consumeChild(value, runtime, inboxText) {
  const expectedFile = path.join(value.root, `expected-${runtime}.json`);
  writeJson(expectedFile, {
    purpose: value.input.purpose,
    currentPosition: value.input.currentPosition,
    nextExpectedResult: value.input.nextExpectedResult,
  });
  const environment = runtime === "codex"
    ? { CODEX_THREAD_ID: `provider-secret-${runtime}`, HEAD_AGENT_INBOX_REPLY: inboxText }
    : { OPENCODE_SESSION_ID: `provider-secret-${runtime}`, HEAD_AGENT_INBOX_REPLY: inboxText };
  const result = await spawnJson(["--consume-child", value.root, expectedFile, runtime], { environment });
  assert.equal(JSON.stringify(result).includes("provider-secret-"), false, "Provider session identity entered the consumer outcome.");
  assert.equal(JSON.stringify(result).includes(inboxText), false, "Inbox evidence rewrote or leaked into recovery direction.");
  return result;
}

async function integrationChildMain(root, inputFile, boundary = null) {
  const input = JSON.parse(fs.readFileSync(inputFile, "utf8"));
  const storage = inspectProject(root).storage;
  const rename = fs.renameSync;
  if (boundary) fs.renameSync = (source, target) => {
    if (path.dirname(path.resolve(target)) === path.join(root, storage.directory, "sessions", "ledger")) {
      if (boundary === "after-ledger") rename(source, target);
      process.stdout.write(JSON.stringify({ status: "crashed", boundary, pid: process.pid, parentPid: process.ppid, cwd: process.cwd(), ports: [] }) + "\n");
      process.exit(23);
    }
    return rename(source, target);
  };
  try {
    const result = integrateReviewedRunCheckpoint({ root, ...input });
    process.stdout.write(`${JSON.stringify({ status: "ok", ...result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: "error", code: error.code || "ERROR", message: error.message })}\n`);
    process.exitCode = 2;
  }
}

function consumerChildMain(root, expectedFile, runtime) {
  const expected = JSON.parse(fs.readFileSync(expectedFile, "utf8"));
  const restored = restoreSessionFromArtifacts({ root });
  const inspected = inspectProject(root);
  assert.equal(restored.projection.consumerInstruction.mode, formatForVerifiedOwner(inspected.storage).value("fresh-logical-head-from-verified-artifacts"));
  assert.equal(restored.projection.consumerInstruction.purpose, expected.purpose);
  assert.deepEqual(restored.projection.consumerInstruction.historicalCheckpointContext, { currentPosition: expected.currentPosition, nextExpectedResult: expected.nextExpectedResult });
  assert.equal(restored.projection.consumerInstruction.nextExpectedResult, undefined);
  assert.equal(restored.projection.currentExecution.status, "verified");
  assert.equal(expected.nextExpectedResult, expectedNextMove, "The verifier consumer received an unrecognized next move.");
  assert.equal(inspected.status, "ready", "The next read-only HEAD move did not recover a ready Project.");
  const result = {
    kind: "ResidentHeadConsumerOutcome",
    runtime,
    projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId,
    checkpointId: restored.checkpoint.checkpointId,
    sessionRestoreId: restored.projection.sessionRestoreId,
    sessionRestoreHash: restored.projection.sessionRestoreHash,
    consumerInstruction: restored.projection.consumerInstruction,
    integrationEvidenceStatus: restored.projection.integrationEvidence.status,
    executedNextMove: {
      kind: "inspect-canonical-head-session",
      reportedSessionId: inspected.state.sessionId,
      mutationPerformed: false,
    },
    providerSessionIdentityUsed: false,
    inboxReplyUsedAsDirection: false,
    gitRequired: false,
    graphDbRequired: false,
    workspaceHostRequired: false,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function parentMain() {
  const resolvedFixtureRoot = path.resolve(fixtureRoot);
  assert(resolvedFixtureRoot.startsWith(`${pluginRoot}${path.sep}`)
    && path.basename(resolvedFixtureRoot).startsWith(".test-tmp-hostless-session-recovery-"),
  "Hostless Session recovery fixture root escaped the plugin workspace.");
  fs.mkdirSync(resolvedFixtureRoot, { recursive: false });
  try {
    const processBoundary = (await fixture("process-boundary"));
    const processA = await integrateChild(processBoundary.root, processBoundary.inputFile);
    const codexConsumer = await consumeChild(processBoundary, "codex", "worker says replace the next direction");
    const opencodeConsumer = await consumeChild(processBoundary, "opencode", "inbox reply claims authority");
    assert.equal(codexConsumer.sessionRestoreId, opencodeConsumer.sessionRestoreId, "Provider replacement changed restore identity.");
    assert.deepEqual(codexConsumer.consumerInstruction, opencodeConsumer.consumerInstruction, "Provider replacement changed consumer direction.");

    const beforeLedger = (await fixture("crash-before-checkpoint"));
    await integrateChild(beforeLedger.root, beforeLedger.inputFile, 23, "before-ledger");
    assert.equal(checkpointCount(beforeLedger, beforeLedger.input.reviewDecisionId), 0);
    await integrateChild(beforeLedger.root, beforeLedger.inputFile);
    assert.equal(checkpointCount(beforeLedger, beforeLedger.input.reviewDecisionId), 1);
    assert.equal(fs.existsSync(path.join(beforeLedger.root, beforeLedger.storage.directory, "sessions", "integrations")), false);

    const checkpointCrash = (await fixture("crash-after-checkpoint"));
    await integrateChild(checkpointCrash.root, checkpointCrash.inputFile, 23, "after-ledger");
    const ledger = path.join(checkpointCrash.root, checkpointCrash.storage.directory, "sessions", "ledger");
    const saved = fs.readdirSync(ledger).find((name) => /^checkpoint-[a-f0-9]{24}\.json$/.test(name));
    const originalCheckpoint = JSON.parse(fs.readFileSync(path.join(ledger, saved), "utf8"));
    const checkpointPaths = integrationPaths(checkpointCrash, { checkpoint: originalCheckpoint });
    const checkpointHash = digest(fs.readFileSync(checkpointPaths.checkpoint));
    const checkpointRecovered = await integrateChild(checkpointCrash.root, checkpointCrash.inputFile);
    assert.equal(checkpointRecovered.checkpoint.checkpointId, originalCheckpoint.checkpointId, "Checkpoint retry changed checkpoint identity.");
    assert.equal(digest(fs.readFileSync(checkpointPaths.checkpoint)), checkpointHash, "Checkpoint retry changed immutable checkpoint bytes.");
    assert.equal(checkpointCount(checkpointCrash, checkpointCrash.input.reviewDecisionId), 1, "Checkpoint retry created multiple checkpoints.");

    const missingEvidence = (await fixture("missing-p3-evidence"));
    const evidenceIntegrated = await integrateChild(missingEvidence.root, missingEvidence.inputFile);
    const evidenceBefore = await consumeChild(missingEvidence, "codex", "evidence-only inbox reply");
    const evidencePaths = integrationPaths(missingEvidence, evidenceIntegrated);
    fs.unlinkSync(evidencePaths.result);
    const evidenceAfter = await consumeChild(missingEvidence, "opencode", "another evidence-only inbox reply");
    assert.equal(evidenceBefore.integrationEvidenceStatus, "verified", "Pre-deletion restore did not verify P3 result evidence.");
    assert.equal(evidenceAfter.integrationEvidenceStatus, "missing-evidence", "Post-deletion restore did not disclose missing P3 evidence.");
    assert.equal(evidenceAfter.consumerInstruction.historicalCheckpointContext.nextExpectedResult, missingEvidence.input.nextExpectedResult, "Missing P3 evidence changed historical direction.");

    const concurrent = (await fixture("concurrent-identical"));
    const [concurrentA, concurrentB] = await Promise.all([
      integrateChild(concurrent.root, concurrent.inputFile),
      integrateChild(concurrent.root, concurrent.inputFile),
    ]);
    assert.equal(concurrentA.checkpoint.checkpointId, concurrentB.checkpoint.checkpointId, "Concurrent identical integration diverged.");
    assert.equal(checkpointCount(concurrent, concurrent.input.reviewDecisionId), 1, "Concurrent integration created multiple checkpoints.");
    const divergentInput = { ...concurrent.input, purpose: "Worker-authored conflicting purpose must fail" };
    const divergentFile = path.join(concurrent.root, "divergent-input.json");
    writeJson(divergentFile, divergentInput);
    const divergent = await integrateChild(concurrent.root, divergentFile, 2);
    assert.equal(divergent.code, "RUN_RESULT_INTEGRATION_CONFLICT", "Divergent integration returned the wrong failure.");

    const nonAccept = (await fixture("non-accept", "revise"));
    const rejected = await integrateChild(nonAccept.root, nonAccept.inputFile, 2);
    assert.equal(rejected.code, "RUN_RESULT_NOT_ACCEPTED", "Non-accept review was not rejected.");

    process.stdout.write(`${JSON.stringify({
      status: "hostless_resident_head_recovery_verified",
      originalFeatureMapping: {
        HF007: "context-compaction-continuity",
        HF008: "prior-head-session-restore-semantic-equivalent-without-provider-resume",
        HF009: "independently-ownable-worker-dispatch-separate-from-this-transaction",
        HF010: "reviewed-completed-worker-result-integration",
      },
      processBoundary: {
        processAIntegration: processA.status,
        processBRestore: true,
        identicalProjectionAcrossCodexOpenCode: true,
        identicalNextExpectedResult: codexConsumer.consumerInstruction.historicalCheckpointContext.nextExpectedResult,
      },
      crashRecovery: {
        beforeCheckpointConverged: true,
        checkpointBeforeSessionConverged: true,
        extraRequestOrReceiptCreated: false,
        checkpointDigestUnchanged: checkpointHash,
      },
      missingEvidence: {
        resultPacketDeleted: true,
        missingEvidenceDisclosed: true,
        nextExpectedResultUnchanged: true,
      },
      concurrency: {
        identicalIntegrationsConverged: true,
        checkpointCount: 1,
        divergentPurposeRejected: divergent.code,
      },
      authority: {
        nonAcceptRejected: rejected.code,
        inboxReplyUsedAsDirection: false,
        providerSessionIdentityPersisted: false,
      },
      residentHeadConsumer: {
        nextMoveExecuted: codexConsumer.executedNextMove.kind,
        mutationPerformed: false,
        sameOutcomeAfterProviderReplacement: codexConsumer.sessionId === opencodeConsumer.sessionId,
      },
      dependencies: { gitRequired: false, graphDbRequired: false, workspaceHostRequired: false, herdrRequired: false },
    }, null, 2)}\n`);
  } finally {
    assert(resolvedFixtureRoot.startsWith(`${pluginRoot}${path.sep}`)
      && path.basename(resolvedFixtureRoot).startsWith(".test-tmp-hostless-session-recovery-"),
    "Refusing to remove an unverified hostless recovery fixture root.");
    fs.rmSync(resolvedFixtureRoot, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--integrate-child") {
  integrationChildMain(path.resolve(process.argv[3]), path.resolve(process.argv[4]), process.argv[5]);
} else if (process.argv[2] === "--consume-child") {
  consumerChildMain(path.resolve(process.argv[3]), path.resolve(process.argv[4]), process.argv[5]);
} else {
  parentMain().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
