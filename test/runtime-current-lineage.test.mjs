import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/lode-core.mjs";
import { initializeOrResumeProject } from "../scripts/lib/project-bootstrap.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { createExecutionContract, createWholePlanSnapshot } from "../scripts/lib/execution-lineage.mjs";
import { finishRun, getPendingReviewContext, reviewRun, startRun } from "../scripts/lib/run-lineage.mjs";
import { buildRuntimeVersionEvidence } from "../scripts/lib/runtime-machine-execution.mjs";
import { buildRuntimeProjectBinding, buildRuntimeProtocolEvidence } from "../scripts/lib/runtime-protocol-evidence.mjs";
import { buildRuntimeInvocationAuthorization, prepareRuntimeInvocationExecution, verifyRuntimeInvocationCurrentLineage, readRuntimeInvocationAuthorization } from "../scripts/lib/runtime-invocation-lifecycle.mjs";
import { readProjectDirection, updateProjectDirection } from "../scripts/lib/project-direction.mjs";
import { createHeadSession, withSessionRoute } from "../scripts/lib/session-routing.mjs";
import { createBoundedWorkerDispatch, readBoundedWorkerDispatch } from "../scripts/lib/bounded-worker-dispatch.mjs";
import { withPreparedRuntimeInputView } from "../scripts/lib/runtime-prepared-input-view.mjs";
import { workerIntegrationFixture } from "./helpers/worker-integration-fixture.mjs";
import { runCommand } from "../scripts/head.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { formatCliResult } from "../scripts/lib/cli-presentation.mjs";
import { localContinuityCommand } from "./helpers/session-continuity-process.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
console.log(JSON.stringify({ event: "owned-current-lineage-test", pid: process.pid, parentPid: process.ppid,
  command: process.execPath, args: process.argv.slice(1), cwd: process.cwd(), ports: [], actualProviderInvoked: false }));

// Schema-only protocol inputs: no executable, provider or child process is run.
// The synthetic child token is never used for process discovery/termination.
function syntheticCapabilitySpawn(_command, args) {
  const output = args.join(" ") === "--version" ? "codex 1.2.3\n"
    : args.join(" ") === "--help" ? "exec\nmcp-server\napp-server\n"
      : args.join(" ") === "exec --help" ? "Run Codex non-interactively\n--json\n--output-schema\n--color\n--sandbox\n--skip-git-repo-check\n--cd\n--ephemeral\nresume\n"
        : "stdio://\ngenerate-json-schema\n--listen\n";
  const child = new EventEmitter();
  child.pid = 1; // Modeled existence only, not an actual owned PID.
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => { throw new Error("The schema fixture must never control a process"); };
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(output));
    child.exitCode = 0;
    child.emit("close", 0, null);
  });
  return child;
}

async function fixture(t, { scopeKind = "run", worker = false } = {}) {
  const parent = path.resolve(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  fs.mkdirSync(parent, { recursive: true });
  const container = fs.mkdtempSync(path.join(parent, "head-current-lineage-"));
  t.after(() => {
    assert.equal(path.dirname(container), parent);
    assert.match(path.basename(container), /^head-current-lineage-/);
    fs.rmSync(container, { recursive: true, force: true });
  });
  const root = path.join(container, "project");
  const bin = path.join(container, "synthetic-capability");
  fs.mkdirSync(root);
  fs.mkdirSync(bin);
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  assert.equal(storage.directory, ".lode");
  assert.equal(fs.existsSync(path.resolve(root, ".lode/project.json")), true);
  assert.equal(fs.existsSync(path.resolve(root, ".head/project.json")), false);
  fs.writeFileSync(path.join(root, "selected.txt"), "selected initial bytes\n");
  const capsule = compileContext({ root, task: "Verify exact synthetic current execution lineage", persist: true }).capsule;
  const plan = createWholePlanSnapshot({ root, objective: "Keep exact execution lineage", plan: [{ id: "check", outcome: "Verify current binding" }] }).artifact;
  const contractOptions = { root, wholePlanId: plan.wholePlanId, capsuleId: capsule.capsuleId,
    scope: "Synthetic current-lineage fixture", acceptanceCriteria: ["No stale execution"], allowedActions: ["runtime.invoke", "project.read"] };
  const contract = createExecutionContract(contractOptions).artifact;
  const run = scopeKind === "run" ? startRun({ root, executionContractId: contract.executionContractId }).run : null;
  const executable = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(executable, "Synthetic schema fixture; never executed\n");
  if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
  const environment = { ...process.env, PATH: bin };
  delete environment.Path;
  delete environment.path;
  const versionEvidence = await buildRuntimeVersionEvidence({ runtimes: ["codex"], environment, spawnImplementation: syntheticCapabilitySpawn });
  const protocolEvidence = await buildRuntimeProtocolEvidence({ runtimes: ["codex"], environment, versionEvidence, spawnImplementation: syntheticCapabilitySpawn });
  const inspected = inspectProject(root);
  const projectBinding = buildRuntimeProjectBinding({ storage, projectId: inspected.project.projectId,
    headSessionId: inspected.state.sessionId, projectRoot: root, projectStatus: "ready", versionEvidence, protocolEvidence });
  const sessionRequest = "Read only the selected synthetic source";
  const options = { root, runtime: "codex", protocolEvidence, projectBinding,
    scope: scopeKind === "run" ? { kind: "run" } : { kind: "session", request: sessionRequest },
    ...(worker ? { worker: { taskKey: "current-lineage", role: "coder", outcome: "Return bounded synthetic evidence",
      selectedContext: "No model or provider invoked", sourcePaths: ["selected.txt"] } } : {}) };
  const authorization = buildRuntimeInvocationAuthorization(options).authorization;
  const input = { root, authorization, ...(scopeKind === "session" ? { sessionRequest } : {}) };
  const sessionFile = path.join(root, storage.directory, "sessions/current.json");
  const runFile = run ? path.join(root, storage.directory, "sessions/runs", run.runId, "run.json") : null;
  return { storage, root, plan, capsule, contract, contractOptions, run, options, authorization, input, sessionFile, runFile };
}

function snapshot(root) {
  const files = {};
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else files[path.relative(root, file)] = fs.readFileSync(file).toString("base64");
    }
  };
  walk(root);
  return files;
}

test("followup: exact historical prepared bytes survive later direction, source and Session changes without granting execution", async t => {
  const f = await fixture(t, { worker: true });
  const first = updateProjectDirection({ root: f.root, input: { goal: "Capture this direction", constraints: [], decisions: ["Keep exact selected input"], cancelledActions: [] } }).direction;
  const authorization = buildRuntimeInvocationAuthorization({ ...f.options, worker: { ...f.options.worker,
    taskKey: "historical-direction", selectedContext: "한글".repeat(2000) } }).authorization;
  const prepared = prepareRuntimeInvocationExecution({ root: f.root, authorization }).input;
  createBoundedWorkerDispatch({ root: f.root, authorizationId: authorization.authorizationId, role: "coder" });
  const latest = updateProjectDirection({ root: f.root, expectedDirectionId: first.directionId, input: {
    goal: "Later correction", constraints: [], decisions: [], cancelledActions: ["project.read"] } }).direction;
  fs.writeFileSync(path.join(f.root, "selected.txt"), "Source changed after preparation\n");
  const before = snapshot(f.root), primary = readRuntimeInvocationAuthorization({ root: f.root, authorizationId: authorization.authorizationId });
  assert.equal(primary.preparedInput, undefined);
  assert.equal(readBoundedWorkerDispatch({ root: f.root, authorizationId: authorization.authorizationId }).preparedInput, undefined);
  const cli = await runCommand(["runtime-invocation-read", f.root, "--authorization", authorization.authorizationId]);
  assert.equal(cli.preparedInput.status, "verified-prepared-input");
  assert.equal(cli.preparedInput.inputProof.digest, crypto.createHash("sha256").update(prepared).digest("hex"));
  assert.equal(cli.preparedInput.inputProof.bytes, prepared.length);
  assert.equal(Buffer.byteLength(cli.preparedInput.excerpt.text), cli.preparedInput.excerpt.endByte);
  assert.equal(cli.preparedInput.excerpt.text, prepared.subarray(0, cli.preparedInput.excerpt.endByte).toString("utf8"));
  assert(cli.preparedInput.excerpt.omittedBytes > 0);
  assert.equal(cli.preparedInput.originals.find(row => row.kind === "ProjectDirection").id, first.directionId);
  assert.equal(cli.preparedInput.modelUse, "unknown"); assert.equal(cli.preparedInput.delivery.status, "not-recorded");
  for (const name of ["head_runtime_invocation_authorization", "head_bounded_worker_status"]) {
    const result = await dispatch({ id: name, method: "tools/call", params: { name, arguments: { project_root: f.root, authorization_id: authorization.authorizationId } } });
    assert.equal(result.error, undefined);
    assert.equal(result.result.structuredContent.preparedInput.status, "verified-prepared-input");
    assert.equal(result.result.structuredContent.authorization.authorizationId, authorization.authorizationId);
    assert.match(result.result.content[0].text, /Current cancellation and execution guards still apply/);
  }
  assert.match(formatCliResult("runtime-invocation-read", cli), /model use are separate/);
  assert.throws(() => prepareRuntimeInvocationExecution({ root: f.root, authorization }), { code: "RUNTIME_PROJECT_DIRECTION_DRIFT" });
  assert.equal(readProjectDirection({ root: f.root }).directionId, latest.directionId);
  assert.deepEqual(snapshot(f.root), before);
  const sibling = createHeadSession({ root: f.root, purpose: "Independent current Session" });
  const siblingBefore = snapshot(f.root);
  const historical = withSessionRoute(f.root, sibling.sessionId, () => withPreparedRuntimeInputView({ root: f.root,
    value: readRuntimeInvocationAuthorization({ root: f.root, authorizationId: authorization.authorizationId }) }));
  assert.equal(historical.preparedInput.status, "verified-prepared-input");
  assert.equal(historical.authorization.authorizationId, authorization.authorizationId);
  assert.deepEqual(snapshot(f.root), siblingBefore);
  t.diagnostic(JSON.stringify({ kind: "SyntheticHistoricalPreparedInput", authorizationId: authorization.authorizationId,
    scope: authorization.scope, proof: cli.preparedInput.inputProof, originals: cli.preparedInput.originals,
    capturedDirectionId: first.directionId, currentDirectionId: latest.directionId,
    currentExecutionRejection: "RUNTIME_PROJECT_DIRECTION_DRIFT", delivery: cli.preparedInput.delivery,
    modelUse: cli.preparedInput.modelUse, canonicalBytesUnchanged: true, actualProviderInvoked: false }));
});

test("followup: historical originals distinguish missing, integrity and unretained input without softening primary errors", async t => {
  const f = await fixture(t, { worker: true });
  const file = path.join(f.root, f.storage.directory, "context/capsules", `${f.capsule.capsuleId}.json`), bytes = fs.readFileSync(file);
  const read = () => withPreparedRuntimeInputView({ root: f.root, value: readRuntimeInvocationAuthorization({ root: f.root, authorizationId: f.authorization.authorizationId }) });
  fs.unlinkSync(file);
  let before = snapshot(f.root), value = read();
  assert.equal(value.preparedInput.status, "missing-original");
  assert.equal(value.preparedInput.originals.find(row => row.kind === "ContextCapsule").reasonCode, "ENOENT");
  assert.deepEqual(snapshot(f.root), before);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(bytes), task: "Tampered fixture" }));
  before = snapshot(f.root); value = read();
  assert.equal(value.preparedInput.status, "integrity-unavailable");
  assert.equal(value.preparedInput.originals.find(row => row.kind === "ContextCapsule").reasonCode, "CAPSULE_DIGEST_MISMATCH");
  assert.deepEqual(snapshot(f.root), before);
  fs.writeFileSync(file, bytes);
  before = snapshot(f.root);
  const optionalFailure = await localContinuityCommand([path.join(pluginRoot, "test/helpers/mcp-loading-probe.mjs"), "prepared-view", f.root, f.authorization.authorizationId], { cwd: pluginRoot });
  assert.equal(optionalFailure.code, 0, optionalFailure.stderr);
  assert.equal(JSON.parse(optionalFailure.stdout.trim()).optionalViewFailureScoped, true);
  assert.deepEqual(snapshot(f.root), before);
  t.diagnostic(optionalFailure.stdout.trim());
  const foreign = await fixture(t, { worker: true });
  const selectedAuthorization = readRuntimeInvocationAuthorization({ root: f.root, authorizationId: f.authorization.authorizationId });
  const transplanted = path.join(foreign.root, foreign.storage.directory, "runtime/execution-authorizations", `${f.authorization.authorizationId}.json`);
  fs.copyFileSync(selectedAuthorization.file, transplanted);
  const foreignBefore = snapshot(foreign.root);
  assert.throws(() => runCommand(["runtime-invocation-read", foreign.root, "--authorization", f.authorization.authorizationId]),
    { code: "RUNTIME_INVOCATION_PROJECT_MISMATCH" });
  const foreignRead = await dispatch({ id: "foreign-owner", method: "tools/call", params: {
    name: "head_runtime_invocation_authorization", arguments: { project_root: foreign.root, authorization_id: f.authorization.authorizationId } } });
  assert.match(foreignRead.error.message, /another project/);
  assert.equal(foreignRead.result, undefined); assert.deepEqual(snapshot(foreign.root), foreignBefore);
  const idle = await fixture(t, { scopeKind: "session" }), idleBefore = snapshot(idle.root);
  const old = await runCommand(["runtime-invocation-read", idle.root, "--authorization", idle.authorization.authorizationId]);
  assert.equal(old.preparedInput.status, "selected-refs-only");
  assert.equal(old.preparedInput.reasonCode, "PREPARED_INPUT_REQUEST_NOT_RETAINED"); assert.equal(old.preparedInput.excerpt, undefined);
  assert.deepEqual(snapshot(idle.root), idleBefore);
  const authFile = readRuntimeInvocationAuthorization({ root: f.root, authorizationId: f.authorization.authorizationId }).file;
  fs.writeFileSync(authFile, JSON.stringify({ ...f.authorization, authorizationHash: "0".repeat(64) }));
  before = snapshot(f.root);
  assert.throws(() => runCommand(["runtime-invocation-read", f.root, "--authorization", f.authorization.authorizationId]), { code: "RUNTIME_INVOCATION_AUTHORIZATION_DIGEST_MISMATCH" });
  assert.deepEqual(snapshot(f.root), before);
});

test("followup: runtime receipt observations stay separate from prepared input and never prove model use", async t => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "one.txt", after: null }] }), record = f.records[0];
  const read = () => withPreparedRuntimeInputView({ root: f.root, value: readRuntimeInvocationAuthorization({ root: f.root, authorizationId: record.authorizationId }) });
  let before = snapshot(f.container), value = read();
  assert.equal(value.preparedInput.status, "verified-prepared-input");
  assert.equal(value.preparedInput.delivery.status, "synthetic-runtime-observation");
  assert.equal(value.preparedInput.delivery.receiptId, record.receipt.receiptId);
  assert.equal(value.preparedInput.delivery.matchesAuthorizedDigest, true);
  assert.equal(value.preparedInput.modelUse, "unknown"); assert.equal(value.preparedInput.delivery.modelUse, "unknown");
  assert.deepEqual(snapshot(f.container), before);
  const receiptFile = path.join(record.directory, "receipt.json");
  fs.writeFileSync(receiptFile, JSON.stringify({ ...record.receipt, inputDigestObserved: "0".repeat(64) }));
  before = snapshot(f.container); value = read();
  assert.equal(value.preparedInput.status, "verified-prepared-input");
  assert.equal(value.preparedInput.delivery.status, "unavailable");
  assert.deepEqual(snapshot(f.container), before);
});

function assertRejectedUnchanged(f, code, input = f.input) {
  const before = snapshot(f.root);
  for (const operation of [verifyRuntimeInvocationCurrentLineage, prepareRuntimeInvocationExecution]) {
    assert.throws(() => operation(input), { code });
    assert.deepEqual(snapshot(f.root), before);
  }
}

test("folder relocation preserves logical direction but cannot alias an old runtime authorization root", async t => {
  const f = await fixture(t, { scopeKind: "session" });
  const root = path.join(path.dirname(f.root), "relocated"); fs.cpSync(f.root, root, { recursive: true });
  await initializeOrResumeProject({ root, pluginRoot });
  const before = snapshot(root);
  for (const operation of [verifyRuntimeInvocationCurrentLineage, prepareRuntimeInvocationExecution]) {
    assert.throws(() => operation({ ...f.input, root }), { code: "RUNTIME_INVOCATION_PROJECT_DRIFT" });
    assert.deepEqual(snapshot(root), before);
  }
});

function withJsonChange(file, mutate, check) {
  const bytes = fs.readFileSync(file);
  fs.writeFileSync(file, JSON.stringify(mutate(JSON.parse(bytes))));
  try { check(); }
  finally { fs.writeFileSync(file, bytes); }
}

test("normal active lineage remains usable and both preparation reads create no artifacts", async (t) => {
  const f = await fixture(t);
  for (const nullTransition of [false, true]) {
    if (nullTransition) fs.writeFileSync(f.runFile, JSON.stringify({ ...f.run, sessionTransition: null }));
    const before = snapshot(f.root);
    const result = verifyRuntimeInvocationCurrentLineage(f.input);
    assert.equal(result.sourceBasisVerified, false);
    assert.equal(result.executionPrepared, false);
    assert.deepEqual(prepareRuntimeInvocationExecution(f.input).input, result.input);
    const contract = JSON.parse(result.input.toString("utf8")).returnContract;
    assert.equal(contract.kind, "ResultPacketDraft");
    assert.equal(contract.fixedFields, undefined);
    assert.equal(contract.wireResultShape.planDelta, "string describing the completed plan delta");
    assert.deepEqual(contract.wireResultShape.impactRadius, ["relative paths or bounded impact descriptions"]);
    assert.deepEqual(snapshot(f.root), before);
  }
});

test("current WholePlan, mode and pending-review drift reject only the affected execution", async (t) => {
  const f = await fixture(t);
  for (const patch of [{ currentWholePlanId: `whole-plan-${"a".repeat(24)}` }, { mode: "review" },
    { pendingReview: { runId: f.run.runId, wholePlanId: f.plan.wholePlanId, resultPacketId: `result-packet-${"b".repeat(24)}` } }]) {
    withJsonChange(f.sessionFile, (state) => ({ ...state, ...patch }), () => assertRejectedUnchanged(f, "RUNTIME_INVOCATION_FENCE_MISMATCH"));
  }
  assert.equal(prepareRuntimeInvocationExecution(f.input).authorization.authorizationId, f.authorization.authorizationId);
});

test("active Session pointers cannot conceal missing, terminal or mismatched Run canon", async (t) => {
  const f = await fixture(t);
  for (const [patch, code] of [
    [{ runId: "run-1-abcdef" }, "RUNTIME_INVOCATION_RUN_NOT_ACTIVE"],
    [{ status: "awaiting_review" }, "RUNTIME_INVOCATION_RUN_NOT_ACTIVE"],
    [{ wholePlanId: `whole-plan-${"a".repeat(24)}` }, "RUNTIME_INVOCATION_LINEAGE_CONFLICT"],
    [{ executionContractId: `execution-contract-${"a".repeat(24)}` }, "RUNTIME_INVOCATION_LINEAGE_CONFLICT"],
    [{ capsuleId: `capsule-${"a".repeat(24)}` }, "RUNTIME_INVOCATION_LINEAGE_CONFLICT"],
  ]) {
    withJsonChange(f.runFile, (run) => ({ ...run, ...patch }), () => assertRejectedUnchanged(f, code));
  }
  const bytes = fs.readFileSync(f.runFile);
  fs.unlinkSync(f.runFile);
  try { assertRejectedUnchanged(f, "RUNTIME_INVOCATION_RUN_MISSING"); }
  finally { fs.writeFileSync(f.runFile, bytes); }
});

test("individually digest-valid plan and Capsule cannot be mixed with another contract", async (t) => {
  const f = await fixture(t);
  const otherPlan = createWholePlanSnapshot({ root: f.root, objective: "Independent synthetic plan", plan: [{ id: "other", outcome: "Separate lineage" }] }).artifact;
  const otherCapsule = compileContext({ root: f.root, task: "Independent synthetic Capsule", persist: true }).capsule;
  for (const contractOptions of [{ ...f.contractOptions, wholePlanId: otherPlan.wholePlanId },
    { ...f.contractOptions, capsuleId: otherCapsule.capsuleId }]) {
    const contract = createExecutionContract(contractOptions).artifact;
    // A digest is not authorization to combine unrelated valid artifacts.
    const { authorizationHash: _hash, authorizationId: _id, ...payload } = f.authorization;
    payload.scope = { ...payload.scope, executionContractId: contract.executionContractId };
    const authorizationHash = crypto.createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
    const authorization = { ...payload, authorizationHash, authorizationId: `execution-authorization-${authorizationHash.slice(0, 24)}` };
    withJsonChange(f.sessionFile, (state) => ({ ...state, activeExecutionContractId: contract.executionContractId }), () => {
      withJsonChange(f.runFile, (run) => ({ ...run, executionContractId: contract.executionContractId }), () => {
        assertRejectedUnchanged(f, "RUNTIME_INVOCATION_LINEAGE_CONFLICT", { root: f.root, authorization });
      });
    });
  }
});

test("real frozen finish prevents new execution but the exact finish retry still converges", async (t) => {
  const f = await fixture(t);
  const finishInput = { root: f.root, outcome: "Synthetic whole result", evidence: [{ fixture: "no provider" }],
    verification: [{ check: "synthetic result boundary", status: "passed" }], unknowns: ["Actual provider effects were not exercised"] };
  const sessionBeforeFinish = fs.readFileSync(f.sessionFile);
  const rename = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, target) => {
    const result = rename(source, target);
    if (!injected && target === f.runFile && JSON.parse(fs.readFileSync(target)).sessionTransition?.kind === "finish") {
      injected = true;
      throw Object.assign(new Error("Synthetic failure after frozen final Run publication"), { code: "EIO" });
    }
    return result;
  };
  try { assert.throws(() => finishRun(finishInput), { code: "EIO" }); }
  finally { fs.renameSync = rename; }
  assert.equal(injected, true);
  const frozen = JSON.parse(fs.readFileSync(f.runFile));
  assert.equal(frozen.status, "awaiting_review");
  assert.equal(frozen.sessionTransition.kind, "finish");
  assert.equal(frozen.sessionTransition.artifactId, frozen.resultPacketId);
  assert.equal(fs.existsSync(path.join(f.root, f.storage.directory, "lineage/result-packets", `${frozen.resultPacketId}.json`)), false,
    "the frozen final Run was published before the result artifact");
  assert.deepEqual(fs.readFileSync(f.sessionFile), sessionBeforeFinish);
  assert.equal(inspectProject(f.root).state.activeRunId, f.run.runId);
  // The Session still has its pre-finish pointers, but final Run canon wins:
  // affected invocation fails closed rather than treating those pointers as permission.
  assertRejectedUnchanged(f, "RUNTIME_INVOCATION_RUN_NOT_ACTIVE");
  const before = snapshot(f.root);
  assert.throws(() => buildRuntimeInvocationAuthorization(f.options), { code: "RUNTIME_INVOCATION_RUN_NOT_ACTIVE" });
  assert.throws(() => finishRun({ ...finishInput, outcome: "Divergent result cannot replace the frozen finish" }), { code: "RUN_TRANSITION_CONFLICT" });
  assert.deepEqual(snapshot(f.root), before);
  const finished = finishRun(finishInput);
  assert.equal(finished.run.runId, f.run.runId);
  assert.equal(finished.resultPacket.resultPacketId, frozen.resultPacketId);
  assert.deepEqual(finished.resultPacket.unknowns, finishInput.unknowns);
  assert.equal(inspectProject(f.root).state.pendingReview.resultPacketId, frozen.resultPacketId);
  assert.equal(inspectProject(f.root).state.lastReviewDecisionId, null);
  assertRejectedUnchanged(f, "RUNTIME_INVOCATION_FENCE_MISMATCH");
  const unchanged = snapshot(f.root);
  assert.equal(finishRun(finishInput).resultPacket.resultPacketId, finished.resultPacket.resultPacketId);
  assert.deepEqual(snapshot(f.root), unchanged);
  reviewRun({ root: f.root, reviewContextId: getPendingReviewContext({ root: f.root }).review.reviewContextId,
    disposition: "accept", rationale: "Explicit synthetic fixture review only" });
  const nextRun = startRun({ root: f.root, executionContractId: f.contract.executionContractId }).run;
  assert.notEqual(nextRun.runId, f.run.runId);
  const nextAuthorization = buildRuntimeInvocationAuthorization(f.options).authorization;
  assert.equal(prepareRuntimeInvocationExecution({ root: f.root, authorization: nextAuthorization }).authorization.scope.runId, nextRun.runId);
});

test("lineage-only inspection preserves retained input but cannot suppress source execution checks", async (t) => {
  const f = await fixture(t, { worker: true });
  fs.writeFileSync(path.join(f.root, "selected.txt"), "changed by a source owner\n");
  const before = snapshot(f.root);
  const inspected = verifyRuntimeInvocationCurrentLineage(f.input);
  assert.equal(inspected.sourceBasisVerified, false);
  assert.equal(inspected.executionPrepared, false);
  assert.equal(Buffer.from(inspected.authorization.workerInput.sourceBasis[0].contentBase64, "base64").toString(), "selected initial bytes\n");
  assert.throws(() => prepareRuntimeInvocationExecution({ ...inspected, root: f.root, verifyCurrentSources: false }), { code: "WORKER_SOURCE_BASIS_DRIFT" });
  assert.deepEqual(snapshot(f.root), before);
});

test("idle Session authorization remains usable without Run lineage or a Capsule", async (t) => {
  const f = await fixture(t, { scopeKind: "session", worker: true });
  const before = snapshot(f.root);
  const inspected = verifyRuntimeInvocationCurrentLineage(f.input);
  const prepared = prepareRuntimeInvocationExecution(f.input);
  assert.equal(prepared.authorization.scope.kind, "session");
  assert.equal(prepared.authorization.scope.contextCapsuleId, null);
  assert.deepEqual(prepared.executionInput.returnContract.fixedFields, { planDelta: "", impactRadius: [] });
  assert.match(prepared.executionInput.returnContract.scopeInstruction, /fixed values, not examples/);
  assert.deepEqual(prepared.input, inspected.input);
  assert.deepEqual(snapshot(f.root), before);
  assert.throws(() => prepareRuntimeInvocationExecution({ ...f.input, sessionRequest: "A different request" }), { code: "RUNTIME_INVOCATION_INPUT_DRIFT" });
});
