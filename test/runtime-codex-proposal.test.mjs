import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/lode-core.mjs";
import { buildRuntimeVersionEvidence } from "../scripts/lib/runtime-machine-execution.mjs";
import { buildRuntimeProjectBinding, buildRuntimeProtocolEvidence } from "../scripts/lib/runtime-protocol-evidence.mjs";
import { buildRuntimeInvocationAuthorization } from "../scripts/lib/runtime-invocation-lifecycle.mjs";
import { captureWorkerSourceBasis } from "../scripts/lib/worker-source-basis.mjs";
import { captureWorkerWriteBasis } from "../scripts/lib/worker-patch-basis.mjs";
import { prepareWorkerWorkspace } from "../scripts/lib/worker-workspace.mjs";
import { workerPatchProposalExecutionBoundary, buildWorkerPatchProposalCandidate } from "../scripts/lib/worker-patch-proposal.mjs";
import { buildCodexFreshProposalPolicyPlan } from "../scripts/lib/runtime-codex-proposal-policy.mjs";
import { buildCodexNativePrefixPolicyPlan } from "../scripts/lib/runtime-codex-prefix-policy.mjs";
import { createCodexFreshProposalFixtureCapability } from "../scripts/lib/runtime-codex-app-server-transport.mjs";
import { CODEX_FRESH_PROPOSAL_RESULT_SCHEMA, executeCodexFreshProposalInvocation, executeCodexNativePrefixProposalInvocation, extractCodexFreshProposalResult,
  assertCodexFreshProposalFeatureList, assertCodexFreshProposalResultBoundary, createCodexProposalExecutionControl } from "../scripts/lib/runtime-codex-proposal.mjs";
import { verifyCodexExecWireResultSchema } from "../scripts/lib/runtime-codex-exec.mjs";
import { resolveVerifiedProcessSupervisor } from "../scripts/lib/runtime-process-supervisor.mjs";
import { RUNTIME_OPERATIONAL_STATE_ENV, inspectRuntimeExecutionLease } from "../scripts/lib/runtime-execution-lease.mjs";
import { readRuntimeInvocationRecord } from "../scripts/lib/runtime-invocation-record.mjs";
import { readRuntimeOutputSpool } from "../scripts/lib/runtime-output-spool.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
console.log(JSON.stringify({ event: "owned-codex-fresh-proposal-tests", pid: process.pid, parentPid: process.ppid,
  command: process.execPath, args: process.argv.slice(1), cwd: process.cwd(), ports: [], actualProviderInvoked: false }));

function schemaSpawn(_command, args) {
  const command = args.join(" ");
  const output = command === "--version" ? "codex 0.153.4\n" : command === "--help" ? "exec\nmcp-server\napp-server\n"
    : command === "exec --help" ? "Run Codex non-interactively\n--json\n--output-schema\n--color\n--sandbox\n--skip-git-repo-check\n--cd\n--ephemeral\n--ignore-user-config\n--ignore-rules\nresume\n"
      : "stdio://\ngenerate-json-schema\n--listen\n";
  const child = new EventEmitter();
  Object.assign(child, { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null });
  child.kill = () => { throw new Error("No actual process in discovery fixture"); };
  queueMicrotask(() => { child.stdout.emit("data", Buffer.from(output)); child.exitCode = 0; child.emit("close", 0, null); });
  return child;
}

async function fixture(t, { timeoutMs = 6000, taskKey = "fresh-proposal", nativePrefix = false } = {}) {
  const parent = fs.realpathSync(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, "head-fresh-proposal-"));
  const root = path.join(directory, "project"), bin = path.join(directory, "bin"), codexHome = path.join(directory, "codex-home"), operational = path.join(directory, "operational");
  for (const item of [root, bin, codexHome, operational]) fs.mkdirSync(item);
  const previous = process.env[RUNTIME_OPERATIONAL_STATE_ENV];
  process.env[RUNTIME_OPERATIONAL_STATE_ENV] = operational;
  t.after(() => {
    if (previous === undefined) delete process.env[RUNTIME_OPERATIONAL_STATE_ENV]; else process.env[RUNTIME_OPERATIONAL_STATE_ENV] = previous;
    assert.equal(path.dirname(directory), parent); assert.match(path.basename(directory), /^head-fresh-proposal-/u);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  assert.equal(storage.directory, ".lode");
  assert.equal(fs.existsSync(path.resolve(root, ".lode/project.json")), true);
  assert.equal(fs.existsSync(path.resolve(root, ".head/project.json")), false);
  fs.writeFileSync(path.join(root, "selected.txt"), "selected dirty bytes Ω\r\n");
  fs.writeFileSync(path.join(root, "unselected.txt"), "Never supplied to the proposal worker\n");
  const fakeExecutable = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(fakeExecutable, "synthetic discovery only; never executed");
  if (process.platform !== "win32") fs.chmodSync(fakeExecutable, 0o755);
  const discoveryEnvironment = { ...process.env, PATH: bin }; delete discoveryEnvironment.Path; delete discoveryEnvironment.path;
  const versionEvidence = await buildRuntimeVersionEvidence({ runtimes: ["codex"], environment: discoveryEnvironment, spawnImplementation: schemaSpawn });
  const protocolEvidence = await buildRuntimeProtocolEvidence({ runtimes: ["codex"], environment: discoveryEnvironment, versionEvidence, spawnImplementation: schemaSpawn });
  const inspected = inspectProject(root);
  const projectBinding = buildRuntimeProjectBinding({ storage, projectId: inspected.project.projectId, headSessionId: inspected.state.sessionId,
    projectRoot: root, projectStatus: "ready", versionEvidence, protocolEvidence });
  const sourceBasis = captureWorkerSourceBasis({ root, paths: ["selected.txt"], maxBytes: 1024 * 1024 });
  const proposalBasis = captureWorkerWriteBasis({ root, paths: ["selected.txt"], maxBytes: 1024 * 1024 });
  const workspaceBinding = prepareWorkerWorkspace({ projectRoot: root, workspaceRoot: path.join(directory, "selected"), sourceBasis, maxBytes: 1024 * 1024 });
  const recipe = buildCodexFreshProposalPolicyPlan({ executablePath: fs.realpathSync(process.execPath), codexHome, evidenceMode: "protocol-fixture" });
  const policy = nativePrefix ? buildCodexNativePrefixPolicyPlan({ freshPolicy: recipe, seedText: "Synthetic selected prefix only." }) : recipe;
  const executionBoundary = workerPatchProposalExecutionBoundary({ binding: workspaceBinding, policy, sourceBasis, proposalBasis });
  const authorization = buildRuntimeInvocationAuthorization({ root, runtime: "codex", runtimeSelection: { model: policy.model }, workspaceMode: "read-only",
    scope: { kind: "session", request: "Propose a bounded text edit; do not write files." }, protocolEvidence, projectBinding,
    worker: { taskKey, role: "coder", outcome: "Reviewable patch proposal only", selectedContext: "No actual model or filesystem effects", sourcePaths: ["selected.txt"],
      proposalPaths: ["selected.txt"], executionBoundary }, limits: { timeoutMs }, persist: true }).authorization;
  const processEvents = [];
  const onProcessEvent = event => { processEvents.push(event); console.log(JSON.stringify(event)); };
  const selection = () => resolveVerifiedProcessSupervisor({ pluginRoot: (process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || process.env.HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT) || pluginRoot });
  const options = () => ({ root, authorization, policy, workspaceBinding, executablePath: policy.executablePath,
    supervisorSelection: selection(), onProcessEvent, persist: true });
  const execute = (scenario = nativePrefix ? "prefix-normal" : "normal", overrides = {}) => (nativePrefix ? executeCodexNativePrefixProposalInvocation : executeCodexFreshProposalInvocation)({ ...options(), ...overrides },
    { protocolFixtureCapability: createCodexFreshProposalFixtureCapability({ scenario }) });
  const lease = () => inspectRuntimeExecutionLease({ projectRoot: root, storage, projectId: authorization.projectId, authorizationId: authorization.authorizationId });
  const p2 = [path.join(root, storage.directory, "project.json"), path.join(root, storage.directory, "sessions", "current.json")];
  const p2Bytes = p2.map(file => fs.readFileSync(file));
  const assertP2 = () => p2.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), p2Bytes[i]));
  return { storage, root, directory, codexHome, operational, policy, authorization, workspaceBinding, proposalBasis, execute, options,
    processEvents, lease, assertP2 };
}

test("Host execution control rejects wire objects, cross authorization and expired deadlines before lease/spawn", async t => {
  const f = await fixture(t);
  const fixtureCapability = createCodexFreshProposalFixtureCapability();
  for (const control of [{}, createCodexProposalExecutionControl({ authorizationHash: "0".repeat(64), deadlineAt: Date.now() + 60000 })]) {
    await assert.rejects(executeCodexFreshProposalInvocation(f.options(), { protocolFixtureCapability: fixtureCapability, executionControl: control }), { code: "CODEX_PROPOSAL_CONTROL_INVALID" });
  }
  const expired = createCodexProposalExecutionControl({ authorizationHash: f.authorization.authorizationHash, deadlineAt: Date.now() - 1 });
  await assert.rejects(executeCodexFreshProposalInvocation(f.options(), { protocolFixtureCapability: fixtureCapability, executionControl: expired }), { code: "CODEX_FRESH_PROPOSAL_DEADLINE" });
  assert.equal(f.processEvents.length, 0); assert.equal(f.lease().status, "available"); f.assertP2();
});

test("Host pre-write failure prevents physical turn and still closes product-owned tree", async t => {
  const f = await fixture(t);
  let cleanup = null;
  const control = createCodexProposalExecutionControl({ authorizationHash: f.authorization.authorizationHash, deadlineAt: Date.now() + 60000,
    beforeTurn() { throw Object.assign(new Error("Host storage unavailable"), { code: "HOST_DEBIT_FAILED" }); },
    onCleanup(value) { cleanup = value; } });
  const result = await executeCodexFreshProposalInvocation(f.options(), { protocolFixtureCapability: createCodexFreshProposalFixtureCapability(), executionControl: control });
  assert.equal(result.receipt.status, "failed"); assert.equal(result.modelCallAttempted, false);
  assert.equal(cleanup.cleanup.supervision.treeCleanupVerified, true);
  assert.equal(cleanup.cleanup.supervision.ownershipEstablished, true);
  assert(result.operationalErrors.some(error => error.code === "HOST_DEBIT_FAILED")); f.assertP2();
});

test("Host diagnostic and settlement failures cannot corrupt owned cleanup attestation or manufacture successful receipt", async t => {
  const f = await fixture(t);
  let postSend = false, cleanup = null;
  const control = createCodexProposalExecutionControl({ authorizationHash: f.authorization.authorizationHash, deadlineAt: Date.now() + 60000,
    onEvent(event) {
      if (event.event === "request-returned" && event.method === "turn/start") postSend = true;
      if (postSend) throw Object.assign(new Error("diagnostic storage"), { code: "HOST_DIAGNOSTIC_FAILED" });
    },
    onCleanup(value) { cleanup = value; throw Object.assign(new Error("settlement storage"), { code: "HOST_SETTLEMENT_FAILED" }); } });
  const result = await executeCodexFreshProposalInvocation(f.options(), { protocolFixtureCapability: createCodexFreshProposalFixtureCapability(), executionControl: control });
  assert.equal(result.receipt.status, "failed"); assert.equal(result.modelCallAttempted, true);
  assert.equal(cleanup.cleanup.exactExitObserved, true);
  assert.equal(cleanup.cleanup.supervision.treeCleanupVerified, true);
  assert.equal(cleanup.cleanup.supervision.ownershipEstablished, true);
  assert.equal(cleanup.cleanup.supervision.controlInvalid, false);
  assert(result.operationalErrors.some(error => error.code === "HOST_DIAGNOSTIC_FAILED"));
  assert(result.operationalErrors.some(error => error.code === "HOST_SETTLEMENT_FAILED")); f.assertP2();
});

test("native prefix proposal uses controlled source, one child turn, existing lease/spool/result and no P2 writes", async t => {
  const f = await fixture(t, { nativePrefix: true });
  const before = fs.readFileSync(path.join(f.root, "selected.txt"));
  const result = await f.execute();
  assert.equal(result.receipt.status, "completed");
  assert.equal(result.actualProviderInvoked, false);
  assert.equal(f.authorization.workerInput.executionBoundary.mode, "native-prefix-patch-proposal");
  assert.ok(result.draft.providerResult.evidence.includes("Session fixed output contract observed on wire"));
  assert.equal(buildWorkerPatchProposalCandidate({ authorization: f.authorization, structuredResult: result.draft.providerResult }).patches.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(f.root, "selected.txt")), before);
  const spool = readRuntimeOutputSpool({ operationalRoot: f.operational, authorization: f.authorization });
  assert.equal(spool.terminal.result.receipt.receiptId, result.receipt.receiptId);
  assert.equal(result.receipt.processBoundary.treeCleanupVerified, true);
  for (const forbidden of ["synthetic-fresh-proposal-thread", "synthetic-fresh-proposal-turn", "synthetic-prefix-child",
    "synthetic-prefix-child-turn", f.codexHome, f.workspaceBinding.executionRoot]) assert.equal(JSON.stringify(result).includes(forbidden), false);
  f.assertP2();
  await assert.rejects(f.execute());
});

for (const scenario of ["prefix-source-tools", "prefix-history-drift", "prefix-child-failed", "prefix-lost-fork",
  "prefix-missing-result", "prefix-summary-without-direct", "prefix-summary-drift", "prefix-seed-missing-result",
  "prefix-seed-summary-without-direct", "prefix-duplicate-completion", "prefix-trailing-effect",
  "prefix-wrong-event-thread", "prefix-wrong-event-turn", "prefix-source-summary-read", "prefix-raw-config-drift",
  "prefix-stored-reordered", "prefix-stored-duplicate", "prefix-stored-missing", "prefix-stored-extra", "prefix-stored-tool",
  "prefix-stored-input-drift", "prefix-stored-reasoning-drift", "prefix-stored-agent-field-drift"]) {
  test(`native prefix ${scenario} is failed evidence, never successful completion or replay`, async t => {
    const f = await fixture(t, { nativePrefix: true });
    const result = await f.execute(scenario);
    assert.equal(result.receipt.status, "failed");
    assert.equal(result.draft.providerResult, null);
    f.assertP2();
    await assert.rejects(f.execute());
  });
}

for (const scenario of ["not-loaded-result", "prefix-not-loaded-result", "prefix-seed-not-loaded-result"]) {
  test(`direct completed result remains usable with ${scenario} terminal projection`, async t => {
    const f = await fixture(t, { nativePrefix: scenario.startsWith("prefix-") });
    const result = await f.execute(scenario);
    assert.equal(result.receipt.status, "completed");
    assert.equal(result.actualProviderInvoked, false); f.assertP2();
  });
}

test("fresh proposal schema is portable0.2 and exact feature preflight fails closed", async t => {
  const f = await fixture(t);
  assert.equal(verifyCodexExecWireResultSchema(CODEX_FRESH_PROPOSAL_RESULT_SCHEMA), CODEX_FRESH_PROPOSAL_RESULT_SCHEMA);
  assert.deepEqual(CODEX_FRESH_PROPOSAL_RESULT_SCHEMA.properties.protocolVersion.enum, ["0.2.0"]);
  const features = Object.keys(f.policy.startupConfig.features);
  const stdout = features.map(name => `${name.padEnd(50)}  under development  false`).join("\n");
  assert.equal(assertCodexFreshProposalFeatureList({ policy: f.policy, stdout }).fixedDisabledCount, features.length);
  for (const invalid of [stdout.replace("false", "true"), stdout.split("\n").slice(1).join("\n"), `${stdout}\n${features[0]} stable false`, "not a feature line"])
    assert.throws(() => assertCodexFreshProposalFeatureList({ policy: f.policy, stdout: invalid }), /CODEX_FRESH_PROPOSAL_FEATURE/u);
  assert.equal(f.lease().status, "available"); f.assertP2();
});

test("normal fresh fixture consumes/releases once and persists exact proposal without writing selected files", async t => {
  const f = await fixture(t), before = fs.readFileSync(path.join(f.root, "selected.txt"));
  const snapshotBefore = fs.readFileSync(path.join(f.workspaceBinding.executionRoot, "selected.txt"));
  const result = await f.execute();
  assert.equal(result.status, "provider_invocation_completed");
  assert.equal(result.actualProviderInvoked, false);
  assert.equal(result.modelCallAttempted, true); // Fixed Node protocol attempted a turn, never a real model.
  assert.equal(result.receipt.status, "completed");
  assert.equal(result.receipt.inputDigestObserved, f.authorization.executionInput.digest);
  assert.equal(result.receipt.processBoundary.treeCleanupVerified, true);
  assert.equal(result.executionLease.release.consumptionId, result.executionLease.consumption.consumptionId);
  assert.equal(result.draft.providerResult.protocolVersion, "0.2.0");
  assert.ok(result.draft.providerResult.evidence.includes("Session fixed output contract observed on wire"));
  const candidate = buildWorkerPatchProposalCandidate({ authorization: f.authorization, structuredResult: result.draft.providerResult });
  assert.equal(candidate.patches.length, 1);
  assert.equal(candidate.patches[0].after.path, "selected.txt");
  assert.deepEqual(fs.readFileSync(path.join(f.root, "selected.txt")), before);
  assert.deepEqual(fs.readFileSync(path.join(f.workspaceBinding.executionRoot, "selected.txt")), snapshotBefore);
  assert.equal(readRuntimeInvocationRecord({ root: f.root, storage: f.storage, authorizationId: f.authorization.authorizationId }).status, "verified");
  const spool = readRuntimeOutputSpool({ operationalRoot: f.operational, authorization: f.authorization });
  assert.equal(spool.terminal.result.receipt.receiptId, result.receipt.receiptId);
  const durable = JSON.stringify(result);
  for (const secret of ["synthetic-fresh-proposal-thread", "synthetic-fresh-proposal-turn", f.codexHome, f.workspaceBinding.executionRoot]) assert.equal(durable.includes(secret), false);
  assert.equal(fs.existsSync(path.join(f.operational, "runtime-fresh-proposals")), false);
  const spawned = f.processEvents.filter(event => event.type === "spawn").length;
  await assert.rejects(f.execute(), /consum|already|replay/i);
  assert.equal(f.processEvents.filter(event => event.type === "spawn").length, spawned);
  f.assertP2();
});

test("missing/forged fixture capability, oldpolicy and selected source drift never consume", async t => {
  const f = await fixture(t);
  for (const capability of [null, {}, JSON.parse(JSON.stringify(createCodexFreshProposalFixtureCapability()))]) {
    await assert.rejects(executeCodexFreshProposalInvocation(f.options(), { protocolFixtureCapability: capability }), { code: "CODEX_RPC_PROPOSAL_FIXTURE_CAPABILITY" });
  }
  await assert.rejects(f.execute("normal", { policy: { ...f.policy, kind: "CodexWorkerPolicyPlan", protocolVersion: "0.2.0" } }));
  fs.writeFileSync(path.join(f.root, "selected.txt"), "drift after authorization");
  await assert.rejects(f.execute());
  assert.equal(f.lease().status, "available");
  assert.equal(f.processEvents.length, 0); f.assertP2();
});

test("pre-abort is zero consumption and post-plan drift is rejected before spawning", async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.execute("normal", { signal: controller.signal }), { code: "CODEX_FRESH_PROPOSAL_CANCELLED" });
  assert.equal(f.lease().status, "available");
  const events = [];
  await assert.rejects(f.execute("normal", { onProcessEvent: event => {
    events.push(event);
    if (event.type === "planned") fs.writeFileSync(path.join(f.codexHome, "AGENTS.md"), "unselected late instructions");
  } }));
  assert.equal(events.filter(event => event.type === "spawn").length, 0);
  assert.notEqual(f.lease().status, "available"); // Consumption is not erased after a late pre-spawn rejection.
  f.assertP2();
});

for (const scenario of ["wrong-model", "wrong-root", "inherited-thread", "wrong-policy", "enabled-mcp", "enabled-skill", "wrong-event-turn", "approval",
  "encoded-sensitive-result", "trailing-effect", "duplicate-completion", "missing-result", "summary-without-direct", "summary-drift", "terminal-failed"]) {
  test(`fresh fixed transport rejects ${scenario} and settles failed evidence`, async t => {
    const f = await fixture(t), result = await f.execute(scenario);
    assert.equal(result.receipt.status, "failed");
    assert.equal(result.draft.providerResult, null);
    assert.equal(result.actualProviderInvoked, false);
    assert.equal(result.receipt.processBoundary.treeCleanupVerified, true);
    assert.equal(result.executionLease.release.lifecycleReceiptId, result.receipt.receiptId);
    assert.equal(fs.existsSync(path.join(f.operational, "runtime-fresh-proposals")), false);
    f.assertP2();
  });
}

for (const mode of ["cancel", "timeout"]) {
  test(`fresh ${mode} holds the consumed lease until owned-tree cleanup`, async t => {
    // The absolute deadline includes current-policy and executable verification.
    // Leave CI setup margin so timeout exercises the owned hanging turn.
    const f = await fixture(t, { timeoutMs: mode === "timeout" ? 12000 : 6000 });
    const leaseCheckpoints = [];
    const controller = new AbortController(); let timer;
    t.after(() => clearTimeout(timer));
    const result = await f.execute("hang-turn", { signal: controller.signal, onProcessEvent: event => {
      f.processEvents.push(event); console.log(JSON.stringify(event));
      if (event.phase === "provider" && ["spawn", "exit"].includes(event.type)) {
        const lease = f.lease();
        leaseCheckpoints.push({ phase: event.type, status: lease.status, release: lease.release });
      }
      if (mode === "cancel" && event.type === "spawn") timer = setTimeout(() => controller.abort(), 300);
    } });
    assert.equal(result.receipt.status, mode === "cancel" ? "cancelled" : "timed-out");
    if (mode === "timeout") assert.equal(result.modelCallAttempted, true);
    assert.deepEqual(leaseCheckpoints, [
      { phase: "spawn", status: "consumed-active", release: null },
      { phase: "exit", status: "consumed-active", release: null },
    ]);
    assert.equal(result.receipt.processBoundary.exactChildExitObserved, true);
    assert.equal(result.receipt.processBoundary.treeCleanupVerified, true);
    assert.equal(result.draft.providerResult, null);
    assert.equal(result.executionLease.release.lifecycleReceiptId, result.receipt.receiptId);
    f.assertP2();
  });
}

for (const scenario of ["preflight-normal", "preflight-enabled", "preflight-hang"]) {
  test(`fresh ${scenario} preserves exact preflight cleanup and observed stderr`, async t => {
    // The absolute deadline includes executable/policy verification before
    // preflight spawn. Match the existing CI setup margin used above so the
    // hanging case reaches its owned preflight before testing timeout cleanup.
    const f = await fixture(t, { timeoutMs: 12000 });
    const result = await f.execute(scenario);
    assert.equal(result.receipt.status, scenario === "preflight-normal" ? "completed" : scenario === "preflight-hang" ? "timed-out" : "failed");
    assert.equal(result.actualProviderInvoked, false);
    assert.equal(result.modelCallAttempted, scenario === "preflight-normal");
    assert.equal(result.receipt.processBoundary.exactChildExitObserved, true);
    assert.equal(result.receipt.processBoundary.treeCleanupVerified, true);
    assert.equal(result.executionLease.release.lifecycleReceiptId, result.receipt.receiptId);
    assert.equal(f.processEvents.filter(event => event.type === "spawn").length, scenario === "preflight-normal" ? 2 : 1);
    if (scenario !== "preflight-hang") assert.ok(result.receipt.stderrBytes > 0);
    if (scenario !== "preflight-normal") assert.equal(result.draft.providerResult, null);
    assert.equal(fs.existsSync(path.join(f.operational, "runtime-fresh-proposals")), false);
    f.assertP2();
  });
}

test("typed result rejects stale/crossauth proposal basis, ambiguous output and legacy result", async t => {
  const f = await fixture(t);
  const result = { schemaVersion: 1, kind: "RuntimeStructuredResult", protocolVersion: "0.2.0", outcome: "Proposal only",
    evidence: [], planDelta: "", impactRadius: [], verification: [], unknowns: [], patchProposal: {
      proposalBasisDigest: f.authorization.workerInput.executionBoundary.proposalBasisDigest,
      changes: [{ path: "selected.txt", after: { contentBase64: Buffer.from("proposal").toString("base64"), mode: f.proposalBasis[0].mode } }],
    } };
  const item = value => ({ id: "result", type: "agentMessage", phase: "final_answer", text: JSON.stringify(value) });
  assert.deepEqual(extractCodexFreshProposalResult({ authorization: f.authorization, items: [item(result)] }), result);
  for (const changed of [
    { ...result, protocolVersion: "0.1.0" },
    { ...result, patchProposal: { ...result.patchProposal, proposalBasisDigest: hash("different authorization basis") } },
    { ...result, patchProposal: { ...result.patchProposal, changes: [{ path: "unselected.txt", after: result.patchProposal.changes[0].after }] } },
  ]) assert.throws(() => extractCodexFreshProposalResult({ authorization: f.authorization, items: [item(changed)] }));
  assert.throws(() => extractCodexFreshProposalResult({ authorization: f.authorization, items: [item(result), item(result)] }), { code: "CODEX_FRESH_PROPOSAL_AMBIGUOUS_RESULT" });
  for (const forbidden of [f.root, f.workspaceBinding.executionRoot, f.codexHome, "synthetic-fresh-proposal-thread", "synthetic-fresh-proposal-turn"]) {
    for (const bytes of [Buffer.from(forbidden), Buffer.from(forbidden, "utf16le"), Buffer.from(forbidden, "utf16le").swap16()]) {
      const encoded = { ...result, patchProposal: { ...result.patchProposal, changes: [{ path: "selected.txt", after: {
        ...result.patchProposal.changes[0].after, contentBase64: bytes.toString("base64"),
      } }] } };
      const verified = extractCodexFreshProposalResult({ authorization: f.authorization, items: [item(encoded)] });
      assert.throws(() => assertCodexFreshProposalResultBoundary(verified, [forbidden]), { code: "CODEX_FRESH_PROPOSAL_SENSITIVE_RESULT" });
    }
  }
  assert.equal(f.lease().status, "available"); f.assertP2();
});
