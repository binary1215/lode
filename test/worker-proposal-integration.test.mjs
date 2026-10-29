import { relativeProjectArtifact, formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { createExecutionContract, createWholePlanSnapshot } from "../scripts/lib/execution-lineage.mjs";
import { startRun } from "../scripts/lib/run-lineage.mjs";
import { artifactAuthorityBoundary } from "../scripts/lib/authority-plane-contract.mjs";
import { buildRuntimeVersionEvidence } from "../scripts/lib/runtime-machine-execution.mjs";
import { buildRuntimeProjectBinding, buildRuntimeProtocolEvidence } from "../scripts/lib/runtime-protocol-evidence.mjs";
import { buildRuntimeInvocationAuthorization, buildRuntimeInvocationLifecycleReceipt, buildRuntimeResultPacketDraft,
  normalizeRuntimeEvent } from "../scripts/lib/runtime-invocation-lifecycle.mjs";
import { withRuntimeExecutionLease, RUNTIME_OPERATIONAL_STATE_ENV } from "../scripts/lib/runtime-execution-lease.mjs";
import { persistRuntimeInvocationRecord } from "../scripts/lib/runtime-invocation-record.mjs";
import { applyRuntimeRunResult } from "../scripts/lib/runtime-run-result-application.mjs";
import { createBoundedWorkerDispatch } from "../scripts/lib/bounded-worker-dispatch.mjs";
import { captureWorkerSourceBasis } from "../scripts/lib/worker-source-basis.mjs";
import { captureWorkerWriteBasis, buildWorkerPatchCandidate } from "../scripts/lib/worker-patch-basis.mjs";
import { workerPatchProposalExecutionBoundary, buildWorkerPatchProposalCandidate } from "../scripts/lib/worker-patch-proposal.mjs";
import { prepareWorkerWorkspace } from "../scripts/lib/worker-workspace.mjs";
import { workerMemberKey } from "../scripts/lib/worker-member-registry.mjs";
import { composeWorkerPatchCandidates } from "../scripts/lib/worker-patch-composition.mjs";
import { verifyWorkerPatchIntegrationIntent, readWorkerPatchIntegration, prepareWorkerPatchIntegration } from "../scripts/lib/worker-patch-integration.mjs";
import { applyWorkerPatchIntegration, readWorkerPatchApplication } from "../scripts/lib/worker-integration-application.mjs";
import { prepareWorkerIntegrationResult, publishWorkerIntegrationResult } from "../scripts/lib/worker-integration-result.mjs";
import { integrationDigest as hash, integrationJson as json, workerIntegrationDirectory, publishIntegrationJson } from "../scripts/lib/worker-integration-store.mjs";

console.log(JSON.stringify({ event: "owned-worker-proposal-integration-test", pid: process.pid, parentPid: process.ppid,
  command: process.execPath, args: process.argv.slice(1), cwd: process.cwd(), ports: [], actualProviderInvoked: false }));

const flags = { instructionAuthority: false, promotionAuthority: false, recoveryAuthority: false, reviewDecisionCreated: false, mutatesCanon: false };
const pluginRoot = path.resolve(import.meta.dirname, "..");
const maxBytes = 1024 * 1024;

// Capability schema fixture only: no OS child, provider or inference call.
function capabilitySpawn(_command, args) {
  const output = args.join(" ") === "--version" ? "codex 1.2.3\n"
    : args.join(" ") === "--help" ? "exec\nmcp-server\napp-server\n"
      : args.join(" ") === "exec --help" ? "Run Codex non-interactively\n--json\n--output-schema\n--color\n--sandbox\n--skip-git-repo-check\n--cd\n--ephemeral\nresume\n"
        : "stdio://\ngenerate-json-schema\n--listen\n";
  const child = new EventEmitter();
  Object.assign(child, { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null });
  child.kill = () => { throw new Error("Schema fixture cannot control a process"); };
  queueMicrotask(() => { child.stdout.emit("data", Buffer.from(output)); child.exitCode = 0; child.emit("close", 0, null); });
  return child;
}

function identifyIntent(payload) {
  const integrationHash = hash(json(payload));
  const membership = hash(json(payload.members.map(member => member.authorizationId).sort())).slice(0, 24);
  return verifyWorkerPatchIntegrationIntent({ ...payload, integrationId: `worker-integration-${membership}--${integrationHash.slice(0, 24)}`, integrationHash });
}

async function fixture(t, { allowWrite = true, forbidWrite = false, noOp = false } = {}) {
  const parent = fs.realpathSync(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const container = fs.mkdtempSync(path.join(parent, "head-worker-proposal-integration-"));
  const root = path.join(container, "project"), bin = path.join(container, "schema-bin"), operational = path.join(container, "operational");
  for (const directory of [root, bin, operational]) fs.mkdirSync(directory);
  const priorOperational = process.env[RUNTIME_OPERATIONAL_STATE_ENV];
  process.env[RUNTIME_OPERATIONAL_STATE_ENV] = operational;
  t.after(() => {
    if (priorOperational === undefined) delete process.env[RUNTIME_OPERATIONAL_STATE_ENV];
    else process.env[RUNTIME_OPERATIONAL_STATE_ENV] = priorOperational;
    assert.equal(path.dirname(container), parent);
    assert.match(path.basename(container), /^head-worker-proposal-integration-/);
    fs.rmSync(container, { recursive: true, force: true });
  });
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  fs.writeFileSync(path.join(root, "sum.mjs"), "export const sum = (a, b) => a - b;\n");
  const capsule = (await compileContext({ root, task: "Propose a bounded synthetic arithmetic fix", persist: true })).capsule;
  const plan = createWholePlanSnapshot({ root, objective: "Integrate a proposal as HEAD", plan: [{ id: "fix", outcome: "Correct arithmetic" }] }).artifact;
  const contract = createExecutionContract({ root, wholePlanId: plan.wholePlanId, capsuleId: capsule.capsuleId,
    scope: "Synthetic proposal integration", acceptanceCriteria: ["One verified whole result"],
    allowedActions: ["runtime.invoke", "project.read", ...(allowWrite ? ["project.write"] : [])],
    forbiddenActions: forbidWrite ? ["project.write"] : [] }).artifact;
  startRun({ root, executionContractId: contract.executionContractId });
  const executable = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(executable, "Schema fixture; never executed\n", { mode: 0o755 });
  const environment = { ...process.env, PATH: bin }; delete environment.Path; delete environment.path;
  const versionEvidence = await buildRuntimeVersionEvidence({ runtimes: ["codex"], environment, spawnImplementation: capabilitySpawn });
  const protocolEvidence = await buildRuntimeProtocolEvidence({ runtimes: ["codex"], environment, versionEvidence, spawnImplementation: capabilitySpawn });
  const inspected = inspectProject(root);
  const projectBinding = buildRuntimeProjectBinding({ storage, projectId: inspected.project.projectId, headSessionId: inspected.state.sessionId,
    projectRoot: fs.realpathSync(root), projectStatus: "ready", versionEvidence, protocolEvidence });
  const sourceBasis = captureWorkerSourceBasis({ root, paths: ["sum.mjs"], maxBytes });
  const proposalBasis = captureWorkerWriteBasis({ root, paths: ["sum.mjs"], maxBytes });
  const binding = prepareWorkerWorkspace({ projectRoot: root, workspaceRoot: path.join(container, "selected"), sourceBasis, maxBytes });
  const boundary = workerPatchProposalExecutionBoundary({ binding, policy: { fixtureOnly: true }, sourceBasis, proposalBasis });
  const authorization = buildRuntimeInvocationAuthorization({ root, runtime: "codex", workspaceMode: "read-only", scope: { kind: "run" },
    protocolEvidence, projectBinding, limits: { maxInputBytes: maxBytes }, worker: { taskKey: "proposal", role: "coder", outcome: "Propose arithmetic fix",
      selectedContext: "Synthetic selected input only", sourcePaths: ["sum.mjs"], proposalPaths: ["sum.mjs"], executionBoundary: boundary } }).authorization;
  const { dispatch } = createBoundedWorkerDispatch({ root, authorizationId: authorization.authorizationId, role: "coder" });
  const structuredResult = { schemaVersion: 1, kind: "RuntimeStructuredResult", protocolVersion: "0.2.0",
    outcome: "Proposed arithmetic correction; no file was applied", evidence: ["Selected source contains subtraction"], planDelta: "Proposal returned",
    impactRadius: ["sum.mjs"], verification: ["Proposal schema only; no provider executed"], unknowns: ["HEAD must apply and verify behavior"],
    patchProposal: { proposalBasisDigest: boundary.proposalBasisDigest,
      changes: noOp ? [] : [{ path: "sum.mjs", after: { contentBase64: Buffer.from("export const sum = (a, b) => a + b;\n").toString("base64"), mode: proposalBasis[0].mode } }] } };
  const events = [normalizeRuntimeEvent({ authorization, sequence: 0, line: JSON.stringify({ type: "turn.completed", fixtureOnly: true }) })];
  const leased = await withRuntimeExecutionLease({ projectRoot: root, authorization, ownerFenceDigest: hash("proposal-schema-owner") }, async ({ consumption }) => ({
    receipt: buildRuntimeInvocationLifecycleReceipt({ authorization, consumption, events, status: "completed", exitCode: 0, signal: "",
      stdoutBytes: 0, stderrBytes: 0, stdoutDigest: hash(""), stderrDigest: hash(""), callerFenceDigest: hash("proposal caller"), childFenceDigest: hash("proposal child"),
      childStarted: true, childExitObserved: true, terminationRequested: false, projectFenceValidated: true, inputDigestObserved: authorization.executionInput.digest,
      noDescendantFixture: true, descendantTreeOwnershipValidated: true, providerMode: "conformance-fixture", structuredResult }) }));
  const receipt = leased.result.receipt;
  const draft = buildRuntimeResultPacketDraft({ authorization, receipt, leaseRelease: leased.release, providerResult: structuredResult });
  persistRuntimeInvocationRecord({ projectRoot: root, storage, authorization, events, receipt, draft });
  const candidate = buildWorkerPatchProposalCandidate({ authorization, structuredResult });
  const member = { authorizationId: authorization.authorizationId, authorizationHash: authorization.authorizationHash,
    inputDigest: authorization.executionInput.digest, memberKey: workerMemberKey(authorization), dispatchId: dispatch.dispatchId, dispatchHash: dispatch.dispatchHash,
    lifecycleReceiptId: receipt.receiptId, draftId: draft.draftId, executionLeaseConsumptionId: draft.executionLeaseConsumptionId,
    executionLeaseReleaseId: draft.executionLeaseReleaseId, actualProviderInvoked: false, candidate };
  const lineage = { projectId: authorization.projectId, projectRootDigest: authorization.projectRootDigest,
    [formatForVerifiedOwner(storage).sessionIdField]: authorization[formatForVerifiedOwner(storage).sessionIdField],
    runId: authorization.scope.runId, wholePlanId: authorization.scope.wholePlanId, executionContractId: authorization.scope.executionContractId,
    contextCapsuleId: authorization.scope.contextCapsuleId };
  const intent = identifyIntent({ kind: "WorkerPatchIntegrationIntent", protocolVersion: "0.1.0", authorityBoundary: artifactAuthorityBoundary("WorkerPatchIntegrationIntent"),
    lineage, members: [member], composition: composeWorkerPatchCandidates({ candidates: [candidate], maxBytes }), ...flags });
  const directory = workerIntegrationDirectory(root, true, storage);
  publishIntegrationJson(path.join(directory, `${intent.integrationId}.json`), intent);
  return { root, storage, container, directory, authorization, candidate, intent, input: { root, integrationId: intent.integrationId, storage },
    sessionFile: path.join(root, relativeProjectArtifact(storage, "sessions", "current.json")), source: path.join(root, "sum.mjs"), contract };
}

function syntheticEffects({ beforePreflight } = {}) {
  const calls = [];
  return { calls, host: { fileEffect: async (request, options) => {
    calls.push(request.operation);
    const effect = request.payload.effect;
    if (request.operation === "image-preflight") {
      await beforePreflight?.();
      return { status: "ok", result: { status: "supported", rootIdentity: "synthetic-root", ancestorIdentities: ["synthetic-root"] } };
    }
    assert.equal(request.operation, "image-apply");
    const file = path.join(effect.root, effect.path);
    assert.equal(fs.readFileSync(file).toString("base64"), effect.before.content);
    fs.writeFileSync(file, Buffer.from(effect.after.content, "base64"));
    options.onProcess({ type: "exit", cleanupVerified: true });
    return { status: "ok", result: { status: "effect-observed", intentId: "synthetic-proposal-effect" } };
  } } };
}

test("read-only proposal uses exact result bytes and preparation creates no file effect or recovery", async t => {
  const f = await fixture(t, { allowWrite: false });
  const session = fs.readFileSync(f.sessionFile), source = fs.readFileSync(f.source);
  assert.equal(f.authorization.protocolVersion, "0.7.0");
  assert.equal(f.authorization.workspaceMode, "read-only");
  assert.equal(f.authorization.workerInput.writeBasis, undefined);
  assert.equal(f.authorization.requiredAllowedActions.includes("project.write"), false);
  assert.deepEqual(readWorkerPatchIntegration(f.input).intent, f.intent);
  const prepared = prepareWorkerPatchIntegration({ root: f.root, authorizationIds: [f.authorization.authorizationId], maxBytes, storage: f.storage });
  assert.equal(prepared.status, "existing");
  assert.deepEqual(fs.readFileSync(f.source), source);
  assert.deepEqual(fs.readFileSync(f.sessionFile), session);
  assert.equal(readWorkerPatchApplication(f.input).claim, null);
});

for (const [allowWrite, forbidWrite] of [[false, false], [false, true], [true, true]]) test(`proposal cannot grant HEAD write authority (allowed=${allowWrite}, forbidden=${forbidWrite})`, async t => {
  const f = await fixture(t, { allowWrite, forbidWrite });
  const original = fs.readFileSync(f.source), session = fs.readFileSync(f.sessionFile);
  const effects = syntheticEffects();
  await assert.rejects(applyWorkerPatchIntegration(f.input, effects.host), /ExecutionContract must allow project.write/);
  assert.deepEqual(effects.calls, []);
  assert.equal(readWorkerPatchApplication(f.input).claim, null);
  assert.deepEqual(fs.readFileSync(f.source), original);
  assert.deepEqual(fs.readFileSync(f.sessionFile), session);
});

test("HEAD-authorized proposal effect uses existing whole-result and Fresh HEAD route", async t => {
  const f = await fixture(t);
  const session = fs.readFileSync(f.sessionFile);
  const effects = syntheticEffects();
  const applied = await applyWorkerPatchIntegration(f.input, effects.host);
  assert.equal(applied.status, "applied");
  assert.deepEqual(effects.calls, ["image-preflight", "image-apply"]);
  assert.deepEqual(fs.readFileSync(f.sessionFile), session);
  const module = await import(`data:text/javascript,${encodeURIComponent(fs.readFileSync(f.source, "utf8"))}`);
  assert.equal(module.sum(5, 2), 7);
  const prepared = await prepareWorkerIntegrationResult({ ...f.input, basisDigest: applied.currentBasis.basisDigest,
    outcome: "HEAD applied the synthetic proposal and verified combined behavior", evidence: [{ kind: "SyntheticEffect", claimId: applied.claim.recordId }],
    verification: [{ kind: "ArithmeticAssertion", input: [5, 2], expected: 7, observed: 7 }], planDelta: "Arithmetic fixed", impactRadius: ["sum.mjs"],
    unknowns: ["No real provider or native effect executed in this schema fixture"] });
  assert.deepEqual(fs.readFileSync(f.sessionFile), session);
  const published = await publishWorkerIntegrationResult({ ...f.input, verificationId: prepared.verification.verificationId });
  assert.equal(published.application.status, "whole-result-published-awaiting-review");
  assert.equal(published.reviewDecisionCreated, false);
  assert.equal(published.recoveryAuthority, false);
  const state = inspectProject(f.root).state;
  assert.ok(state.pendingReview);
  assert.equal(state.pendingReview.resultPacketId, published.resultPacket.resultPacketId);
});

test("a rehashed different candidate cannot replace the receipt-bound proposal", async t => {
  const f = await fixture(t);
  const candidate = buildWorkerPatchCandidate({ basis: f.candidate.basis, maxBytes,
    changes: [{ path: "sum.mjs", after: { contentBase64: Buffer.from("different candidate\n").toString("base64"), mode: f.candidate.basis[0].mode } }] });
  const { integrationId: _id, integrationHash: _hash, ...payload } = f.intent;
  const changed = identifyIntent({ ...payload, members: [{ ...payload.members[0], candidate }],
    composition: composeWorkerPatchCandidates({ candidates: [candidate], maxBytes }) });
  publishIntegrationJson(path.join(f.directory, `${changed.integrationId}.json`), changed);
  assert.throws(() => readWorkerPatchIntegration({ root: f.root, integrationId: changed.integrationId, storage: f.storage }), /completed exact write-bound worker or read-only patch proposal/);
});

test("a rehashed draft and candidate cannot replace a different receipt-bound result", async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, relativeProjectArtifact(f.storage, "runtime", "invocations"), f.authorization.authorizationId);
  const receiptBytes = fs.readFileSync(path.join(directory, "receipt.json"));
  const draft = JSON.parse(fs.readFileSync(path.join(directory, "draft.json"), "utf8"));
  draft.providerResult.patchProposal.changes[0].after.contentBase64 = Buffer.from("replaced proposal\n").toString("base64");
  draft.evidence[0].structuredResultDigest = hash(json(draft.providerResult));
  const { draftId: _draftId, draftHash: _draftHash, ...draftPayload } = draft;
  const draftHash = hash(json(draftPayload));
  const replacement = { ...draftPayload, draftId: `runtime-result-draft-${draftHash.slice(0, 24)}`, draftHash };
  fs.writeFileSync(path.join(directory, "draft.json"), JSON.stringify(replacement));
  const candidate = buildWorkerPatchProposalCandidate({ authorization: f.authorization, structuredResult: replacement.providerResult });
  const { integrationId: _id, integrationHash: _hash, ...payload } = f.intent;
  const changed = identifyIntent({ ...payload, members: [{ ...payload.members[0], draftId: replacement.draftId, candidate }],
    composition: composeWorkerPatchCandidates({ candidates: [candidate], maxBytes }) });
  publishIntegrationJson(path.join(f.directory, `${changed.integrationId}.json`), changed);
  assert.throws(() => readWorkerPatchIntegration({ root: f.root, integrationId: changed.integrationId, storage: f.storage }), { code: "RUNTIME_INVOCATION_RECORD_CONFLICT" });
  assert.deepEqual(fs.readFileSync(path.join(directory, "receipt.json")), receiptBytes);
});

test("direct Run result application cannot promote an unapplied proposal", async t => {
  const f = await fixture(t);
  const session = fs.readFileSync(f.sessionFile), source = fs.readFileSync(f.source);
  assert.throws(() => applyRuntimeRunResult({ root: f.root, authorizationId: f.authorization.authorizationId, storage: f.storage }), { code: "RUNTIME_PATCH_PROPOSAL_INTEGRATION_REQUIRED" });
  assert.deepEqual(fs.readFileSync(f.sessionFile), session);
  assert.deepEqual(fs.readFileSync(f.source), source);
});

test("an empty read-only proposal adds no project.write gate or physical effects", async t => {
  const f = await fixture(t, { allowWrite: false, forbidWrite: true, noOp: true });
  const session = fs.readFileSync(f.sessionFile), source = fs.readFileSync(f.source);
  const effects = syntheticEffects();
  const result = await applyWorkerPatchIntegration(f.input, effects.host);
  assert.equal(result.status, "applied");
  assert.deepEqual(result.claim.effects, []);
  assert.deepEqual(result.effectResults, []);
  assert.deepEqual(effects.calls, []);
  assert.deepEqual(fs.readFileSync(f.source), source);
  assert.deepEqual(fs.readFileSync(f.sessionFile), session);
});

test("proposal source drift asks HEAD to reassess without applying or blocking historical reading", async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.source, "later user change\n");
  const effects = syntheticEffects();
  const result = await applyWorkerPatchIntegration(f.input, effects.host);
  assert.equal(result.action, "head-reassess-current-basis");
  assert.deepEqual(effects.calls, []);
  assert.equal(fs.readFileSync(f.source, "utf8"), "later user change\n");
  assert.deepEqual(readWorkerPatchIntegration(f.input).intent, f.intent);
});

test("Session drift during proposal capability probing publishes no effect claim", async t => {
  const f = await fixture(t);
  const original = fs.readFileSync(f.sessionFile);
  t.after(() => { if (fs.existsSync(path.dirname(f.sessionFile))) fs.writeFileSync(f.sessionFile, original); });
  const effects = syntheticEffects({ beforePreflight: () => {
    const value = JSON.parse(original); value.sessionId = "head-session-different";
    fs.writeFileSync(f.sessionFile, JSON.stringify(value));
  } });
  await assert.rejects(applyWorkerPatchIntegration(f.input, effects.host));
  assert.deepEqual(effects.calls, ["image-preflight"]);
  assert.equal(fs.existsSync(path.join(f.directory, `${f.intent.integrationId}.effect-claim.json`)), false);
});
