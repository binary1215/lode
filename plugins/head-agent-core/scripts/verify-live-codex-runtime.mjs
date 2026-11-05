#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initializeProject, inspectProject } from "./lib/head-core.mjs";
import { compileContext } from "./lib/context-compiler.mjs";
import { createExecutionContract, createWholePlanSnapshot } from "./lib/execution-lineage.mjs";
import { getPendingReviewContext, reviewRun, startRun } from "./lib/run-lineage.mjs";
import { buildRuntimeVersionEvidence } from "./lib/runtime-machine-execution.mjs";
import { buildRuntimeProjectBinding, buildRuntimeProtocolEvidence } from "./lib/runtime-protocol-evidence.mjs";
import { buildRuntimeInvocationAuthorization } from "./lib/runtime-invocation-lifecycle.mjs";
import { RUNTIME_OPERATIONAL_STATE_ENV } from "./lib/runtime-execution-lease.mjs";
import { executeRuntimeInvocation } from "./lib/runtime-one-shot-exec.mjs";
import { readRuntimeInvocationResult } from "./lib/runtime-run-result-application.mjs";
import { resolveVerifiedProcessSupervisor } from "./lib/runtime-process-supervisor.mjs";
import {
  applyBoundedWorkerDispatchResult,
  createBoundedWorkerDispatch,
  executeBoundedWorkerDispatch,
  waitForBoundedWorkerDispatch,
} from "./lib/bounded-worker-dispatch.mjs";
import { integrateReviewedRunCheckpoint } from "./lib/session-recovery.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nonce = `${process.pid}-${Date.now()}`;
const providerRuntime = String(process.env.HEAD_AGENT_LIVE_RUNTIME || "codex").trim().toLowerCase();
const providerName = providerRuntime === "opencode" ? "OpenCode" : providerRuntime === "claude" ? "Claude Code" : "Codex";
const runtimeModel = String(process.env.HEAD_AGENT_LIVE_RUNTIME_MODEL || "").trim() || null;
const projectRoot = path.join(pluginRoot, `.qa-live-${providerRuntime}-${nonce}`);
const operationalRoot = path.join(pluginRoot, `.qa-live-${providerRuntime}-operational-${nonce}`);
const liveOptIn = "HEAD_AGENT_LIVE_RUNTIME_E2E";
const legacyLiveOptIn = "HEAD_AGENT_LIVE_CODEX_E2E";
const liveModeEnv = "HEAD_AGENT_LIVE_RUNTIME_E2E_MODE";
const legacyLiveModeEnv = "HEAD_AGENT_LIVE_CODEX_E2E_MODE";
const LIVE_MODE_PLANS = Object.freeze({
  "run-only": Object.freeze({ mode: "run-only", includeSession: false }),
  "session-and-run": Object.freeze({ mode: "session-and-run", includeSession: true }),
});
let activeLivePlan = null;

function assert(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { code: "LIVE_CODEX_E2E_ASSERTION" });
}

function safeExecutionFailureSummary(execution) {
  const receipt = execution?.receipt;
  return {
    status: receipt?.status || "missing",
    exitCode: receipt?.exitCode ?? null,
    eventTypes: receipt?.eventTypes || [],
    unknownEventTypes: receipt?.unknownEventTypes || [],
    providerDiagnosticCodes: receipt?.providerBoundary?.diagnosticCodes || [],
    stdoutBytes: receipt?.stdoutBytes ?? 0,
    stderrBytes: receipt?.stderrBytes ?? 0,
    actualProviderInvoked: receipt?.providerBoundary?.actualProviderInvoked === true,
    structuredResultObserved: receipt?.providerBoundary?.structuredResultObserved === true,
    descendantTreeOwnershipValidated: receipt?.processBoundary?.descendantTreeOwnershipValidated === true,
  };
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function resolveLivePlan(environment = process.env) {
  const mode = String(environment[liveModeEnv] || environment[legacyLiveModeEnv] || "run-only").trim().toLowerCase();
  const plan = LIVE_MODE_PLANS[mode];
  if (!plan) {
    throw Object.assign(new Error(`${liveModeEnv} must be run-only or session-and-run when provided.`), {
      code: "LIVE_CODEX_E2E_MODE_INVALID",
    });
  }
  return plan;
}

function recordProcess(event) {
  if (event.type === "spawn") {
    process.stderr.write(`NESTED_CHILD_START pid=${event.pid} parent=${event.parentPid} command=${event.command} cwd=${event.cwd} ports=${event.ports || "none"}\n`);
  } else {
    process.stderr.write(`NESTED_CHILD_END pid=${event.pid} parent=${event.parentPid} exit=${event.exitCode ?? "null"} signal=${event.signal || "none"}\n`);
  }
}

function recordingSpawn(command, args, options) {
  const child = spawn(command, args, options);
  child.once("spawn", () => recordProcess({
    type: "spawn",
    pid: child.pid,
    parentPid: process.pid,
    command: `${path.basename(command)} ${args.join(" ")}`.trim(),
    cwd: options.cwd,
    ports: "none",
  }));
  child.once("exit", (exitCode, signal) => recordProcess({
    type: "exit",
    pid: child.pid,
    parentPid: process.pid,
    exitCode,
    signal: signal || "none",
  }));
  return child;
}

async function buildActualRuntimeEvidence(root) {
  const inspected = inspectProject(root);
  const versionEvidence = await buildRuntimeVersionEvidence({
    runtimes: [providerRuntime],
    spawnImplementation: recordingSpawn,
  });
  assert(versionEvidence.summary.allRequestedVersionsVerified, `Installed ${providerName} version evidence was not verified.`);
  const protocolEvidence = await buildRuntimeProtocolEvidence({
    runtimes: [providerRuntime],
    versionEvidence,
    spawnImplementation: recordingSpawn,
  });
  assert(protocolEvidence.summary.allRequestedProtocolsObserved, `Installed ${providerName} protocol evidence was not verified.`);
  const projectBinding = buildRuntimeProjectBinding({
    projectId: inspected.project.projectId,
    headSessionId: inspected.state.sessionId,
    projectRoot: inspected.project.projectRoot,
    projectStatus: inspected.status,
    versionEvidence,
    protocolEvidence,
  });
  return { protocolEvidence, projectBinding };
}

async function main() {
  assert(new Set(["claude", "codex", "opencode"]).has(providerRuntime), "HEAD_AGENT_LIVE_RUNTIME must be claude, codex, or opencode.");
  assert(providerRuntime !== "opencode" || runtimeModel !== null,
    "HEAD_AGENT_LIVE_RUNTIME_MODEL=provider/model is required for live OpenCode so execution cannot drift to a user-global default.");
  activeLivePlan = resolveLivePlan();
  if (process.env[liveOptIn] !== "1" && process.env[legacyLiveOptIn] !== "1") {
    throw Object.assign(new Error(`${liveOptIn}=1 is required because ${activeLivePlan.mode} performs real ${providerName} model calls.`), { code: "LIVE_RUNTIME_E2E_OPT_IN_REQUIRED" });
  }
  for (const [root, prefix] of [[projectRoot, `.qa-live-${providerRuntime}-`], [operationalRoot, `.qa-live-${providerRuntime}-operational-`]]) {
    assert(root.startsWith(`${pluginRoot}${path.sep}`) && path.basename(root).startsWith(prefix), `Live ${providerName} fixture root escaped the plugin workspace.`);
    assert(!fs.existsSync(root), `Live ${providerName} fixture root already exists.`);
  }
  const supervisorFixtureRoot = path.resolve(process.env.HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || pluginRoot);
  const supervisorSelection = resolveVerifiedProcessSupervisor({ pluginRoot: supervisorFixtureRoot });
  const previousOperationalRoot = process.env[RUNTIME_OPERATIONAL_STATE_ENV];
  process.env[RUNTIME_OPERATIONAL_STATE_ENV] = operationalRoot;
  fs.mkdirSync(projectRoot, { recursive: false });
  fs.mkdirSync(operationalRoot, { recursive: false });
  try {
    const fixtureFile = path.join(projectRoot, "fixture.txt");
    fs.writeFileSync(fixtureFile, "HEAD live Session marker: SESSION-READ-ONLY-OK\n", "utf8");
    const fixtureDigest = digest(fs.readFileSync(fixtureFile));
    const initialized = initializeProject({ root: projectRoot, pluginRoot, runtimes: [providerRuntime] });
    assert(initialized.status === "ready", `Live ${providerName} fixture project did not initialize.`);

    let sessionSummary = null;
    if (activeLivePlan.includeSession) {
      const sessionEvidence = await buildActualRuntimeEvidence(projectRoot);
      const sessionRequest = [
        "Read fixture.txt and report the marker as bounded evidence.",
        "Do not change any file, do not perform network or external writes, and use only relative paths in the result.",
        "Because this is a Session result, return an empty planDelta and an empty impactRadius.",
      ].join(" ");
      const sessionAuthorization = buildRuntimeInvocationAuthorization({
        root: projectRoot,
        runtime: providerRuntime,
        runtimeSelection: { model: runtimeModel },
        scope: { kind: "session", request: sessionRequest, contextCapsuleId: null },
        workspaceMode: "read-only",
        protocolEvidence: sessionEvidence.protocolEvidence,
        projectBinding: sessionEvidence.projectBinding,
        limits: {
          timeoutMs: 600_000,
          maxStdoutBytes: 8 * 1024 * 1024,
          maxStderrBytes: 512 * 1024,
          maxEvents: 4_096,
          maxEventBytes: 2 * 1024 * 1024,
        },
        persist: true,
      }).authorization;
      const sessionExecution = await executeRuntimeInvocation({
        root: projectRoot,
        authorization: sessionAuthorization,
        sessionRequest,
        protocolEvidence: sessionEvidence.protocolEvidence,
        projectBinding: sessionEvidence.projectBinding,
        supervisorSelection,
        onProcessEvent: recordProcess,
        persist: true,
      });
      assert(sessionExecution.receipt.status === "completed" && sessionExecution.actualProviderInvoked === true,
        `Live ${providerName} Session did not complete as an actual provider invocation: ${JSON.stringify(safeExecutionFailureSummary(sessionExecution))}`);
      assert(sessionExecution.descendantTreeOwnershipValidated === true, `Live ${providerName} Session did not prove descendant-tree ownership.`);
      assert(sessionExecution.draft.scopeKind === "session" && sessionExecution.draft.freshHeadReviewRequired === false, `Live ${providerName} Session acquired Run review semantics.`);
      assert(sessionExecution.draft.providerResult?.planDelta === "" && sessionExecution.draft.providerResult?.impactRadius.length === 0, `Live ${providerName} Session returned a Run-shaped result.`);
      assert(digest(fs.readFileSync(fixtureFile)) === fixtureDigest, `Live ${providerName} Session changed the read-only fixture.`);
      const afterSession = inspectProject(projectRoot);
      assert(afterSession.state.mode === "session" && !afterSession.state.activeRunId && !afterSession.state.pendingReview, "Live Codex Session manufactured Run or Review state.");
      sessionSummary = {
        authorizationId: sessionAuthorization.authorizationId,
        lifecycleReceiptId: sessionExecution.receipt.receiptId,
        draftId: sessionExecution.draft.draftId,
        actualProviderInvoked: true,
        descendantTreeOwnershipValidated: true,
        freshHeadReviewRequired: false,
        projectMutationObserved: false,
      };
    }

    const capsule = (await compileContext({
      root: projectRoot,
      task: "Create run-output.txt with the exact required marker and verify it without external effects.",
      budget: 32_768,
      persist: true,
    })).capsule;
    const plan = createWholePlanSnapshot({
      root: projectRoot,
      objective: "Prove one consequential live Codex Run through canonical Execution Lineage.",
      plan: [
        "Create run-output.txt containing exactly HEAD live Run verified followed by one newline.",
        "Read the file back and report verification through the structured runtime result.",
        "Return a non-empty planDelta and include run-output.txt in impactRadius using only a relative path.",
      ],
      invariants: ["Do not change Product Canon", "Do not perform network or external writes", "Do not use absolute paths in the result"],
      persist: true,
    }).artifact;
    const contract = createExecutionContract({
      root: projectRoot,
      wholePlanId: plan.wholePlanId,
      capsuleId: capsule.capsuleId,
      scope: "Create and verify only run-output.txt in the isolated fixture project.",
      acceptanceCriteria: ["run-output.txt has the exact required content", "Structured result reports evidence and verification", "Fresh HEAD receives a canonical ResultPacket"],
      constraints: ["No Product Canon mutation", "No external write", "No absolute path in the provider result"],
      allowedActions: ["runtime.invoke", "project.write", "project.read"],
      forbiddenActions: ["canon.mutate", "external.write", "deploy", "publish", "irreversible.delete"],
      persist: true,
    }).artifact;
    const run = startRun({ root: projectRoot, executionContractId: contract.executionContractId }).run;
    const runEvidence = await buildActualRuntimeEvidence(projectRoot);
    const runAuthorization = buildRuntimeInvocationAuthorization({
      root: projectRoot,
      runtime: providerRuntime,
      runtimeSelection: { model: runtimeModel },
      scope: { kind: "run" },
      workspaceMode: "workspace-write",
      protocolEvidence: runEvidence.protocolEvidence,
      projectBinding: runEvidence.projectBinding,
      limits: {
        timeoutMs: 600_000,
        maxInputBytes: 4 * 1024 * 1024,
        maxStdoutBytes: 8 * 1024 * 1024,
        maxStderrBytes: 512 * 1024,
        maxEvents: 8_192,
        maxEventBytes: 2 * 1024 * 1024,
      },
      persist: true,
    }).authorization;
    const dispatched = createBoundedWorkerDispatch({
      root: projectRoot,
      authorizationId: runAuthorization.authorizationId,
      role: "coder",
    });
    const beforeExecution = await waitForBoundedWorkerDispatch({
      root: projectRoot,
      authorizationId: runAuthorization.authorizationId,
    });
    assert(beforeExecution.waitOutcome.status === "pending", "Bounded worker wait did not expose the pre-execution pending state.");
    const boundedExecution = await executeBoundedWorkerDispatch({
      root: projectRoot,
      authorizationId: runAuthorization.authorizationId,
      role: "coder",
      execution: {
        protocolEvidence: runEvidence.protocolEvidence,
        projectBinding: runEvidence.projectBinding,
        supervisorSelection,
        onProcessEvent: recordProcess,
      },
    });
    const runExecution = boundedExecution.result;
    assert(runExecution.receipt.status === "completed" && runExecution.actualProviderInvoked === true,
      `Live ${providerName} Run did not complete as an actual provider invocation: ${JSON.stringify(safeExecutionFailureSummary(runExecution))}`);
    assert(runExecution.descendantTreeOwnershipValidated === true, `Live ${providerName} Run did not prove descendant-tree ownership.`);
    assert(runExecution.draft.scopeKind === "run" && runExecution.draft.freshHeadReviewRequired === true, `Live ${providerName} Run did not retain Run review semantics.`);
    assert(fs.readFileSync(path.join(projectRoot, "run-output.txt"), "utf8") === "HEAD live Run verified\n", `Live ${providerName} Run did not create the exact accepted output.`);
    assert(digest(fs.readFileSync(fixtureFile)) === fixtureDigest, `Live ${providerName} Run changed the protected fixture marker.`);

    const afterExecution = await waitForBoundedWorkerDispatch({
      root: projectRoot,
      authorizationId: runAuthorization.authorizationId,
    });
    assert(afterExecution.waitOutcome.status === "completed", "Bounded worker wait did not expose the completed ResultPacket draft.");
    let duplicateWorkerConsumptionRejected = false;
    try {
      await executeBoundedWorkerDispatch({
        root: projectRoot,
        authorizationId: runAuthorization.authorizationId,
        role: "coder",
        execution: {
          protocolEvidence: runEvidence.protocolEvidence,
          projectBinding: runEvidence.projectBinding,
          supervisorSelection,
          onProcessEvent: recordProcess,
        },
      });
    } catch (error) {
      duplicateWorkerConsumptionRejected = error?.code === "RUNTIME_INVOCATION_AUTHORIZATION_ALREADY_CONSUMED";
    }
    assert(duplicateWorkerConsumptionRejected, "A second bounded worker consumed the same Run authorization.");

    const boundedApplication = applyBoundedWorkerDispatchResult({
      root: projectRoot,
      authorizationId: runAuthorization.authorizationId,
    });
    const applied = boundedApplication.applied;
    assert(applied.status === "runtime_run_result_applied", "Live Codex Run draft was not applied to canonical Execution Lineage.");
    assert(applied.freshHeadReview?.resultPacket?.resultPacketId === applied.resultPacket.resultPacketId, "Fresh HEAD did not receive the canonical ResultPacket.");
    const pending = getPendingReviewContext({ root: projectRoot });
    assert(pending.review.reviewContextId === applied.application.reviewContextId && pending.pendingReview.runId === run.runId, "Fresh HEAD review identity does not match the live Run.");
    const reviewed = reviewRun({
      root: projectRoot,
      reviewContextId: pending.review.reviewContextId,
      disposition: "accept",
      rationale: `The isolated live ${providerName} E2E produced the exact file, verified native lifecycle evidence, and preserved Product Canon.`,
      nextActions: ["Retain this provider behind the same provider-neutral lifecycle and authority contract."],
    });
    const integrated = integrateReviewedRunCheckpoint({
      root: projectRoot,
      runId: run.runId,
      reviewDecisionId: reviewed.reviewDecision.reviewDecisionId,
      purpose: `Preserve the accepted live ${providerName} bounded-worker result as the next provider-neutral HEAD direction.`,
      approvedDecisions: ["Accept the exact isolated live bounded-worker output and preserve its provider-neutral lineage."],
      currentPosition: `The actual ${providerName} bounded worker completed, a Fresh HEAD accepted its ResultPacket, and canonical recovery is ready.`,
      nextExpectedResult: "Resume from this checkpoint without replaying the consumed worker authorization.",
      openReviewIds: [],
    });
    const recorded = readRuntimeInvocationResult({ root: projectRoot, authorizationId: runAuthorization.authorizationId });
    const completed = inspectProject(projectRoot);
    assert(recorded.application?.applicationId === applied.application.applicationId, "Runtime Run result application was not durably recoverable.");
    assert(completed.state.mode === "session" && completed.state.lastReviewDecisionId === reviewed.reviewDecision.reviewDecisionId, "Live Run did not return to the reviewed HEAD Session state.");

    process.stdout.write(`${JSON.stringify({
      status: activeLivePlan.includeSession ? `live_${providerRuntime}_session_and_run_verified` : `live_${providerRuntime}_run_verified`,
      runtime: providerRuntime,
      mode: activeLivePlan.mode,
      runtimeModelSelected: runtimeModel !== null,
      runtimeModelDigest: runtimeModel === null ? "" : digest(runtimeModel),
      projectId: initialized.project.projectId,
      headSessionId: completed.state.sessionId,
      session: sessionSummary,
      run: {
        runId: run.runId,
        authorizationId: runAuthorization.authorizationId,
        lifecycleReceiptId: runExecution.receipt.receiptId,
        draftId: runExecution.draft.draftId,
        resultPacketId: applied.resultPacket.resultPacketId,
        applicationId: applied.application.applicationId,
        freshHeadReviewId: applied.application.reviewContextId,
        reviewDecisionId: reviewed.reviewDecision.reviewDecisionId,
        dispatchId: dispatched.dispatch.dispatchId,
        pendingWaitOutcomeId: beforeExecution.waitOutcome.waitOutcomeId,
        completedWaitOutcomeId: afterExecution.waitOutcome.waitOutcomeId,
        duplicateWorkerConsumptionRejected,
        integrationCheckpointId: integrated.checkpoint.checkpointId,
        reviewedRunIntegration: integrated.checkpoint.reviewedRunIntegration,
        actualProviderInvoked: true,
        descendantTreeOwnershipValidated: true,
        exactWorkspaceMutationVerified: true,
      },
      rawTranscriptPersisted: false,
      providerSessionIdentityCanonical: false,
      productCanonMutated: false,
    }, null, 2)}\n`);
  } finally {
    if (previousOperationalRoot === undefined) delete process.env[RUNTIME_OPERATIONAL_STATE_ENV];
    else process.env[RUNTIME_OPERATIONAL_STATE_ENV] = previousOperationalRoot;
    for (const [root, prefix] of [[projectRoot, `.qa-live-${providerRuntime}-`], [operationalRoot, `.qa-live-${providerRuntime}-operational-`]]) {
      if (!root.startsWith(`${pluginRoot}${path.sep}`) || !path.basename(root).startsWith(prefix)) {
        throw new Error(`Refusing to remove an unverified live ${providerName} fixture directory.`);
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    status: "failed",
    mode: activeLivePlan?.mode || "unresolved",
    code: error.code || "LIVE_CODEX_E2E_ERROR",
    error: error.message,
  })}\n`);
  process.exitCode = 1;
});
