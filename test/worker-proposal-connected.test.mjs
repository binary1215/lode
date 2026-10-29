import { relativeProjectArtifact } from "../scripts/lib/project-storage-format.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { createWholePlanSnapshot, createExecutionContract } from "../scripts/lib/execution-lineage.mjs";
import { startRun, getPendingReviewContext, reviewRun } from "../scripts/lib/run-lineage.mjs";
import { integrateReviewedRunCheckpoint, restoreSessionFromArtifacts } from "../scripts/lib/session-recovery.mjs";
import { buildRuntimeVersionEvidence } from "../scripts/lib/runtime-machine-execution.mjs";
import { buildRuntimeProjectBinding, buildRuntimeProtocolEvidence } from "../scripts/lib/runtime-protocol-evidence.mjs";
import { buildRuntimeInvocationAuthorization } from "../scripts/lib/runtime-invocation-lifecycle.mjs";
import { captureWorkerSourceBasis } from "../scripts/lib/worker-source-basis.mjs";
import { captureWorkerWriteBasis } from "../scripts/lib/worker-patch-basis.mjs";
import { prepareWorkerWorkspace } from "../scripts/lib/worker-workspace.mjs";
import { workerPatchProposalExecutionBoundary } from "../scripts/lib/worker-patch-proposal.mjs";
import { buildCodexFreshProposalPolicyPlan } from "../scripts/lib/runtime-codex-proposal-policy.mjs";
import { resolveVerifiedProcessSupervisor } from "../scripts/lib/runtime-process-supervisor.mjs";
import { RUNTIME_OPERATIONAL_STATE_ENV, inspectRuntimeExecutionLease } from "../scripts/lib/runtime-execution-lease.mjs";
import { createBoundedWorkerJobHost, startBoundedWorkerJob, readBoundedWorkerJob, readBoundedWorkerPatch,
  cancelBoundedWorkerJob, reconcileBoundedWorkerJob } from "../scripts/lib/bounded-worker-job.mjs";
import { operateWorkerIntegration, inspectWorkerIntegration } from "../scripts/lib/worker-integration-workflow.mjs";
import { readWorkerPatchIntegration } from "../scripts/lib/worker-patch-integration.mjs";
import { applyWorkerPatchIntegration } from "../scripts/lib/worker-integration-application.mjs";
import { readWorkerIntegrationBasis } from "../scripts/lib/worker-integration-basis.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const supervisorRoot = process.env.HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT;
const nativeRoot = process.env.HEAD_AGENT_FILE_EFFECT_FIXTURE_ROOT;
const skip = process.platform !== "win32" || !supervisorRoot || !nativeRoot
  ? "Windows native owner and image-effect fixtures not supplied; no provider test" : false;
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
const onProcess = event => console.log(JSON.stringify({ event: "owned-proposal-connected-process", observedAt: new Date().toISOString(), ...event }));
console.log(JSON.stringify({ event: "owned-worker-proposal-connected-test", pid: process.pid, parentPid: process.ppid,
  command: process.execPath, args: process.argv.slice(1), cwd: process.cwd(), ports: [], actualProviderInvoked: false }));

// Only schema text is synthesized here. The jobs themselves execute the fixed
// model-free RPC subprocess through the real native owner/supervisor path.
function schemaSpawn(_command, args) {
  const key = args.join(" ");
  const output = key === "--version" ? "codex 1.2.3\n" : key === "--help" ? "exec\nmcp-server\napp-server\n"
    : key === "exec --help" ? "Run Codex non-interactively\n--json\n--output-schema\n--color\n--sandbox\n--skip-git-repo-check\n--cd\n--ephemeral\nresume\n"
      : "stdio://\ngenerate-json-schema\n--listen\n";
  const child = new EventEmitter();
  Object.assign(child, { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null });
  child.kill = () => { throw new Error("Schema fixture has no OS process"); };
  queueMicrotask(() => { child.stdout.emit("data", Buffer.from(output)); child.exitCode = 0; child.emit("close", 0, null); });
  return child;
}

async function fixture(t) {
  const parent = fs.realpathSync(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const container = fs.mkdtempSync(path.join(parent, "head-worker-proposal-connected-"));
  const root = path.join(container, "project"), bin = path.join(container, "schema-only"), operational = path.join(container, "operational");
  for (const directory of [root, bin, operational]) fs.mkdirSync(directory);
  const previousOperational = process.env[RUNTIME_OPERATIONAL_STATE_ENV];
  process.env[RUNTIME_OPERATIONAL_STATE_ENV] = operational;
  const members = [];
  const cleanupChecks = [];
  t.after(async () => {
    try {
      const cleanupErrors = [];
      for (const member of members) {
        if (!member.started || !fs.existsSync(path.join(member.directory, "binding.json"))) continue;
        try {
          let state = readBoundedWorkerJob(member.input, { onProcess });
          if (!state.ownerExitObserved) cancelBoundedWorkerJob(member.input, { onProcess });
          const deadline = Date.now() + 45000;
          while (!state.ownerExitObserved && Date.now() < deadline) { await pause(); state = readBoundedWorkerJob(member.input, { onProcess }); }
          assert.equal(state.ownerExitObserved, true, "Do not remove evidence until exact owner tree exit is verified");
          if (fs.existsSync(path.join(member.directory, "stderr.bin"))) console.log(fs.readFileSync(path.join(member.directory, "stderr.bin"), "utf8"));
          const claimFile = path.join(member.directory, "claim.json");
          if (fs.existsSync(claimFile)) {
            const claim = JSON.parse(fs.readFileSync(claimFile));
            console.log(JSON.stringify({ event: "proposal-connected-owner-exited", pid: claim.pid,
              taskKey: member.authorization.workerInput.taskKey, cwd: root, ports: [], ownerExitObserved: true }));
            assert.throws(() => process.kill(claim.pid, 0), { code: "ESRCH" });
          }
        } catch (error) { cleanupErrors.push(error); }
      }
      // Failure in one owner must not skip another owner. Native effect checks
      // also settle before deleting any fixture evidence.
      for (const check of cleanupChecks) { try { check(); } catch (error) { cleanupErrors.push(error); } }
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Connected fixture cleanup incomplete; evidence retained at " + container);
      assert.equal(path.dirname(container), parent);
      assert.match(path.basename(container), /^head-worker-proposal-connected-/);
      fs.rmSync(container, { recursive: true, force: true });
    } finally {
      if (previousOperational === undefined) delete process.env[RUNTIME_OPERATIONAL_STATE_ENV];
      else process.env[RUNTIME_OPERATIONAL_STATE_ENV] = previousOperational;
    }
  });
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  fs.writeFileSync(path.join(root, "left.txt"), "left original\n");
  fs.writeFileSync(path.join(root, "right.txt"), "right original\n");
  const consumerFile = path.join(root, "consumer.mjs");
  fs.writeFileSync(consumerFile, [
    'import fs from "node:fs";',
    'export function render() {',
    '  return ["left.txt", "right.txt"].map(name => fs.readFileSync(new URL(name, import.meta.url), "utf8").trim().toUpperCase()).join(" | ");',
    '}',
    '',
  ].join("\n"));
  const capsule = (await compileContext({ root, task: "Combine two read-only worker proposals into one verified consumer outcome", persist: true })).capsule;
  const plan = createWholePlanSnapshot({ root, objective: "Verify connected proposal integration without a model",
    plan: [{ id: "combine", outcome: "Both independently proposed data changes reach the unchanged consumer" }] }).artifact;
  const contract = createExecutionContract({ root, wholePlanId: plan.wholePlanId, capsuleId: capsule.capsuleId,
    scope: "Synthetic fixture proposals; HEAD applies only exact left/right data images",
    acceptanceCriteria: ["Both changed values are consumed together and reviewed explicitly"],
    allowedActions: ["runtime.invoke", "project.read", "project.write"] }).artifact;
  const run = startRun({ root, executionContractId: contract.executionContractId }).run;
  const marker = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(marker, "Schema marker; never executed as a provider\n", { mode: 0o755 });
  const environment = { ...process.env, PATH: bin }; delete environment.Path; delete environment.path;
  const versionEvidence = await buildRuntimeVersionEvidence({ runtimes: ["codex"], environment, spawnImplementation: schemaSpawn });
  const protocolEvidence = await buildRuntimeProtocolEvidence({ runtimes: ["codex"], environment, versionEvidence, spawnImplementation: schemaSpawn });
  const inspected = inspectProject(root);
  const projectBinding = buildRuntimeProjectBinding({ storage, projectId: inspected.project.projectId, headSessionId: inspected.state.sessionId,
    projectRoot: root, projectStatus: "ready", versionEvidence, protocolEvidence });
  for (const name of ["left", "right"]) {
    const selectedPath = name + ".txt", sourcePaths = ["consumer.mjs", selectedPath].sort();
    const sourceBasis = captureWorkerSourceBasis({ root, paths: sourcePaths, maxBytes: 1024 * 1024 });
    const proposalBasis = captureWorkerWriteBasis({ root, paths: [selectedPath], maxBytes: 1024 * 1024 });
    const workspaceBinding = prepareWorkerWorkspace({ projectRoot: root, workspaceRoot: path.join(container, name + "-selected"), sourceBasis, maxBytes: 1024 * 1024 });
    const codexHome = path.join(container, name + "-codex-home"); fs.mkdirSync(codexHome);
    const policy = buildCodexFreshProposalPolicyPlan({ executablePath: fs.realpathSync(process.execPath), codexHome, evidenceMode: "protocol-fixture" });
    const boundary = workerPatchProposalExecutionBoundary({ binding: workspaceBinding, policy, sourceBasis, proposalBasis });
    const authorization = buildRuntimeInvocationAuthorization({ root, runtime: "codex", runtimeSelection: { model: policy.model },
      workspaceMode: "read-only", scope: { kind: "run" }, protocolEvidence, projectBinding, limits: { timeoutMs: 30000 },
      worker: { taskKey: "proposal-" + name, role: "coder", outcome: "Propose the " + name + " data contribution without applying it",
        selectedContext: "Fixed synthetic RPC fixture only: no model/account/network/task tools",
        sourcePaths, proposalPaths: [selectedPath], executionBoundary: boundary } }).authorization;
    members.push({ authorization, policy, workspaceBinding, selectedPath, sourceBasis, started: false,
      input: { root, authorizationId: authorization.authorizationId, role: "coder" },
      directory: path.join(operational, "worker-jobs", authorization.projectId, authorization.authorizationId) });
  }
  const selection = resolveVerifiedProcessSupervisor({ pluginRoot: supervisorRoot });
  return { root, storage, container, members, run, consumerFile, cleanupChecks,
    sessionFile: path.join(root, relativeProjectArtifact(storage, "sessions", "current.json")),
    runFile: path.join(root, relativeProjectArtifact(storage, "sessions", "runs"), run.runId, "run.json"),
    async startAll() {
      // Launch independent owners together; this test does not equate launch
      // overlap with measured model execution concurrency.
      const launches = await Promise.allSettled((await Promise.all(members.map(async member => {
        const host = createBoundedWorkerJobHost({ policy: member.policy, workspaceBinding: member.workspaceBinding });
        member.started = true;
        await startBoundedWorkerJob(member.input, { host, supervisorSelection: selection, onProcess });
      }))));
      const failures = launches.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, "One or more connected worker launches failed");
      for (const member of members) {
        let state = readBoundedWorkerJob(member.input, { onProcess });
        const deadline = Date.now() + 45000;
        while (!state.ownerExitObserved && Date.now() < deadline) { await pause(); state = readBoundedWorkerJob(member.input, { onProcess }); }
        assert.equal(state.ownerExitObserved, true);
        member.state = reconcileBoundedWorkerJob(member.input, { onProcess });
        assert.equal(member.state.status, "completed", JSON.stringify(member.state));
      }
    },
  };
}

function nativeHost(fixture) {
  const spawned = new Set(), exited = new Set();
  fixture.cleanupChecks.push(() => {
    assert.deepEqual([...spawned].sort(), [...exited].sort());
    for (const pid of spawned) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
  return { nativeOptions: { pluginRoot: nativeRoot }, onProcess: event => {
    onProcess(event);
    if (event.type === "spawn") spawned.add(event.pid);
    if (event.type === "exit" && event.cleanupVerified) exited.add(event.pid);
  } };
}

test("two native-owned model-free proposals reach exact HEAD effects, combined behavior, explicit review and P2 restore", { skip }, async t => {
  const f = await fixture(t);
  const p2 = () => [fs.readFileSync(f.sessionFile), fs.readFileSync(f.runFile)];
  const initialP2 = p2();
  const consumerBytes = fs.readFileSync(f.consumerFile);
  const consumer = await import(pathToFileURL(f.consumerFile).href);
  assert.equal(consumer.render(), "LEFT ORIGINAL | RIGHT ORIGINAL");
  assert.notEqual(f.members[0].authorization.authorizationId, f.members[1].authorization.authorizationId);
  assert.equal(f.members[0].authorization.runtimeSelection.model, f.members[1].authorization.runtimeSelection.model);
  assert.notEqual(f.members[0].authorization.executionInput.digest, f.members[1].authorization.executionInput.digest);
  await f.startAll();
  const consumed = [];
  for (const member of f.members) {
    assert.equal(member.state.result.actualProviderInvoked, false);
    assert.equal(member.authorization.requiredAllowedActions.includes("project.write"), false);
    const patch = readBoundedWorkerPatch(member.input, { onProcess });
    assert.equal(patch.origin, "provider-patch-proposal");
    assert.equal(patch.source.kind, "settled-runtime-result");
    assert.equal(patch.candidate.patches.length, 1);
    assert.equal(patch.candidate.patches[0].after.path, member.selectedPath);
    assert.equal(patch.applied, false);
    for (const source of member.sourceBasis) {
      const expected = Buffer.from(source.contentBase64, "base64");
      assert.deepEqual(fs.readFileSync(path.join(f.root, source.path)), expected);
      assert.deepEqual(fs.readFileSync(path.join(member.workspaceBinding.executionRoot, source.path)), expected);
    }
    const lease = inspectRuntimeExecutionLease({ projectRoot: f.root, projectId: member.authorization.projectId,
      authorizationId: member.authorization.authorizationId });
    assert.equal(lease.status, "consumed-released");
    consumed.push(lease);
  }
  assert.notEqual(consumed[0].consumption.consumptionId, consumed[1].consumption.consumptionId);
  assert.deepEqual(p2(), initialP2);
  assert.equal(consumer.render(), "LEFT ORIGINAL | RIGHT ORIGINAL");

  const authorizationIds = f.members.map(member => member.authorization.authorizationId);
  // This public preparation performs real owner/result capture. No fabricated
  // integration intent or synthetic success receipt is written by this test.
  const prepared = await operateWorkerIntegration({ action: "prepare", authorizationIds, maxBytes: 4 * 1024 * 1024 }, { root: f.root, onProcess });
  assert.equal(prepared.status, "prepared");
  const integrationId = prepared.integration.integrationId;
  const input = { root: f.root, integrationId };
  const intent = readWorkerPatchIntegration(input).intent;
  assert.deepEqual(intent.members.map(member => member.authorizationId), [...authorizationIds].sort());
  assert.equal(intent.composition.patches.length, 2);
  assert.ok(intent.members.every(member => member.actualProviderInvoked === false));
  assert.deepEqual(p2(), initialP2);
  const native = nativeHost(f);
  const applied = await applyWorkerPatchIntegration(input, native);
  assert.equal(applied.status, "applied");
  assert.equal(applied.effectResults.length, 2);
  assert.ok(applied.effectResults.every(effect => effect.receipt.terminalProof.provenance === "verified-native-child"
    && effect.receipt.terminalProof.ownedChildClosed === true));
  assert.deepEqual(p2(), initialP2);
  assert.deepEqual(fs.readFileSync(f.consumerFile), consumerBytes);
  assert.equal(consumer.render(), "SYNTHETIC PROPOSED BYTES | SYNTHETIC PROPOSED BYTES");
  for (const member of f.members) for (const source of member.sourceBasis) {
    assert.deepEqual(fs.readFileSync(path.join(member.workspaceBinding.executionRoot, source.path)), Buffer.from(source.contentBase64, "base64"));
  }
  const replay = await applyWorkerPatchIntegration(input, native);
  assert.deepEqual(replay.effectResults, applied.effectResults);
  const basis = readWorkerIntegrationBasis(input);
  const verified = await operateWorkerIntegration({ action: "prepare-result", integrationId, basisDigest: basis.basisDigest,
    outcome: "HEAD applied both model-free worker proposals and verified the unchanged consumer uses both contributions",
    evidence: [{ kind: "ConnectedNativeProposalEvidence", authorizationIds, effectClaimId: applied.claim.recordId, actualProviderInvoked: false }],
    verification: [{ check: "unchanged consumer joins both proposed values", expected: "SYNTHETIC PROPOSED BYTES | SYNTHETIC PROPOSED BYTES",
      observed: consumer.render(), status: "passed" }], planDelta: "Two independent proposed data changes integrated as one outcome",
    impactRadius: ["left.txt", "right.txt"], unknowns: ["Fixed model-free provider protocol fixture; no actual model, account or provider sandbox behavior tested"] }, { root: f.root });
  assert.deepEqual(p2(), initialP2);
  const published = await operateWorkerIntegration({ action: "publish-result", integrationId, verificationId: verified.verification.verificationId }, { root: f.root });
  assert.equal(published.status, "published");
  assert.equal(published.application.freshHeadReviewRequired, true);
  assert.ok(published.resultPacket.evidence[0].memberProvenance.every(member => member.actualProviderInvoked === false));
  assert.equal(inspectProject(f.root).state.lastReviewDecisionId, null);
  assert.equal(inspectProject(f.root).state.latestCheckpoint, null);
  assert.equal(fs.existsSync(path.join(f.root, relativeProjectArtifact(f.storage, "lineage", "review-decisions"))), false);
  const reviewed = reviewRun({ root: f.root, reviewContextId: getPendingReviewContext({ root: f.root }).review.reviewContextId,
    disposition: "accept", rationale: "Explicit synthetic user review accepts this exact connected fixture result only",
    nextActions: ["Integrate the separately stated HEAD recovery direction"] });
  assert.equal(inspectProject(f.root).state.latestCheckpoint, null);
  const recoveryInput = { root: f.root, runId: f.run.runId, reviewDecisionId: reviewed.reviewDecision.reviewDecisionId,
    purpose: "Retain explicitly reviewed synthetic integration direction", approvedDecisions: ["Exact synthetic whole result accepted explicitly"],
    currentPosition: "Both native-applied proposal contributions were verified together",
    nextExpectedResult: "Await a new explicit task; do not infer direction from worker output", openReviewIds: [] };
  const integrated = integrateReviewedRunCheckpoint(recoveryInput);
  assert.equal(integrated.status, "run_result_integrated_checkpointed");
  assert.equal(integrated.checkpoint.authorityBoundary.planeId, "P2");
  assert.equal(integrated.checkpoint.reviewedRunIntegration.resultPacketId, published.resultPacket.resultPacketId);
  const restored = restoreSessionFromArtifacts({ root: f.root });
  assert.equal(restored.projection.consumerInstruction.historicalCheckpointContext.nextExpectedResult, recoveryInput.nextExpectedResult);
  assert.equal(restored.projection.reviewedRunIntegration.reviewDecisionId, reviewed.reviewDecision.reviewDecisionId);
  assert.equal(restored.projection.recoveryAuthority, false);
  assert.equal(inspectWorkerIntegration({ integrationId }, { root: f.root }).result.resultPacket.resultPacketId, published.resultPacket.resultPacketId);
  for (const [index, member] of f.members.entries()) {
    assert.deepEqual(inspectRuntimeExecutionLease({ projectRoot: f.root, projectId: member.authorization.projectId,
      authorizationId: member.authorization.authorizationId }), consumed[index]);
  }
  console.log(JSON.stringify({ event: "connected-proposal-complete", members: authorizationIds.length,
    actualProviderInvoked: false, nativeEffects: applied.effectResults.length, combinedBehavior: consumer.render(),
    explicitReview: true, explicitP2Integration: true, checkpointRestored: true, modelCalls: 0 }));
});
