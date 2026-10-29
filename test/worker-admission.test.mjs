import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { createExecutionContract, createWholePlanSnapshot } from "../scripts/lib/execution-lineage.mjs";
import { finishRun, startRun } from "../scripts/lib/run-lineage.mjs";
import { buildRuntimeVersionEvidence } from "../scripts/lib/runtime-machine-execution.mjs";
import { buildRuntimeProjectBinding, buildRuntimeProtocolEvidence } from "../scripts/lib/runtime-protocol-evidence.mjs";
import {
  buildRuntimeInvocationAuthorization,
  buildRuntimeInvocationLifecycleReceipt,
  buildRuntimeResultPacketDraft,
} from "../scripts/lib/runtime-invocation-lifecycle.mjs";
import { persistRuntimeInvocationRecord } from "../scripts/lib/runtime-invocation-record.mjs";
import {
  RUNTIME_OPERATIONAL_STATE_ENV,
  createRuntimePreConsumeGateCapability,
  inspectRuntimeExecutionLease,
  withRuntimeExecutionLease,
} from "../scripts/lib/runtime-execution-lease.mjs";
import { createBoundedWorkerDispatch, executeBoundedWorkerDispatch, readBoundedWorkerDispatch, waitForBoundedWorkerDispatch, applyBoundedWorkerDispatchResult } from "../scripts/lib/bounded-worker-dispatch.mjs";
import { createBoundedWorkerWave, readBoundedWorkerWaveStatus } from "../scripts/lib/bounded-worker-wave.mjs";
import {
  enqueueWorkerAdmission,
  openWorkerAdmissionHost,
  provisionWorkerAdmissionDomain,
  readWorkerAdmissionProjection,
} from "../scripts/lib/worker-admission.mjs";

import { initialOnboardingDocuments } from "../scripts/lib/onboarding-contract.mjs";
import { emptyProductModelDocument, normalizeProductModelDocument } from "../scripts/lib/product-model.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";

// Synthetic legacy contract seed only; genuine old-producer interoperability is verified separately.
function seedLegacyProject(root) {
  root = fs.realpathSync(root);
  const createdAt = "2026-09-22T00:00:00.000Z";
  const project = { schemaVersion: 1, projectId: `head-${crypto.createHash("sha256").update(root).digest("hex").slice(0, 20)}`,
    projectRoot: root, createdAt, runtimes: ["claude", "codex", "opencode"], integrations: {},
    authority: { head: "ordinary investigation, strategy, integration, and completion judgment",
      user: "material product, policy, architecture, cost, workflow, and consequential external actions" } };
  const sessionState = { schemaVersion: 1, sessionId: `session-${crypto.randomUUID()}`, mode: "session",
    currentWholePlanId: null, activeRunId: null, activeExecutionContractId: null, lastResultPacketId: null,
    pendingReview: null, lastReviewDecisionId: null, requiredPlanAction: null, latestCheckpoint: null, updatedAt: createdAt };
  const product = emptyProductModelDocument();
  const onboarding = initialOnboardingDocuments({ project, sessionState,
    productModelId: normalizeProductModelDocument(product).productModelId, updatedAt: createdAt });
  const records = new Map([
    [".head/project.json", project], [".head/sessions/current.json", sessionState],
    [".head/context/knowledge.json", { schemaVersion: 1, evidence: [], claims: [], decisions: [], unknowns: [] }],
    [".head/context/product-model.json", product], [".head/onboarding/current.json", onboarding.state],
    [`.head/sessions/records/${onboarding.sessionRecord.sessionId}.json`, onboarding.sessionRecord],
    [`.head/onboarding/storage-selections/${onboarding.storageSelection.storageSelectionId}.json`, onboarding.storageSelection],
    [".head/roles/coder.md", "# Coder\n\nImplement only the bounded task authorized by HEAD; return evidence without changing direction or authority.\n"],
  ]);
  for (const [relative, value] of records) {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  }
  fs.mkdirSync(path.join(root, ".head/instructions"), { recursive: true });
  fs.writeFileSync(path.join(root, ".head/instructions/project.md"), "# Project-specific HEAD context\n\nRecord project identity, canonical sources, repository boundaries, and fixed constraints here.\n", { flag: "wx" });
  const immutable = [...records.keys()].filter(relative => relative === ".head/project.json"
    || relative === ".head/roles/coder.md"
    || relative.startsWith(".head/sessions/records/") || relative.startsWith(".head/onboarding/storage-selections/"));
  const manifest = { schemaVersion: 1, generatedAt: createdAt, pluginRoot,
    packageVersion: JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"))).version,
    managed: immutable.map(relative => ({ path: relative, sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex") })) };
  fs.mkdirSync(path.join(root, ".head/generated"), { recursive: true });
  fs.writeFileSync(path.join(root, ".head/generated/manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  const inspected = inspectProject(root); assert.equal(inspected.status, "ready");
  assert.equal(inspected.storage.directory, ".head");
  return { project };
}

const pluginRoot = path.resolve(import.meta.dirname, "..");
const contenderFile = path.join(import.meta.dirname, "fixtures", "worker-admission-contender.mjs");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonicalValue = (value) => Array.isArray(value) ? value.map(canonicalValue)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]))
    : value;
const canonicalJson = (value) => JSON.stringify(canonicalValue(value));
const canonicalHash = (value) => hash(canonicalJson(value));
console.log(JSON.stringify({ event: "owned-worker-admission-test", pid: process.pid, parentPid: process.ppid, command: process.execPath, args: process.argv.slice(1), cwd: process.cwd(), ports: [] }));

function recordSpawn(command, args, options) {
  const child = spawn(command, args, { ...options, windowsHide: true });
  child.once("spawn", () => console.log(JSON.stringify({ event: "owned-worker-admission-child-start", pid: child.pid, parentPid: process.pid, command: [command, ...args].join(" "), cwd: options.cwd, ports: [] })));
  child.once("exit", (code, signal) => console.log(JSON.stringify({ event: "owned-worker-admission-child-exit", pid: child.pid, parentPid: process.pid, code, signal: signal || "none", ports: [] })));
  return child;
}

function evidenceOutput(command, args) {
  const name = path.basename(command).toLowerCase();
  const runtime = name.includes("opencode") ? "opencode" : name.includes("claude") ? "claude" : "codex";
  const key = args.join(" ");
  if (key === "--version") return `${runtime} 1.2.3\n`;
  if (runtime === "claude" && key === "--help") return "-p, --print\n--output-format stream-json\n--json-schema\n--no-session-persistence\n-r, --resume\n-c, --continue\n--permission-mode\n--tools\n--allowedTools\n--disable-slash-commands\n--setting-sources\n--strict-mcp-config\n--mcp-config\n";
  if (runtime === "codex" && key === "--help") return "exec\nmcp-server\napp-server\n";
  if (runtime === "codex" && key === "exec --help") return "Run Codex non-interactively\n--json\n--output-schema\n--color\n--sandbox\n--skip-git-repo-check\n--cd\n--ephemeral\nresume\n";
  if (runtime === "codex" && key === "app-server --help") return "stdio://\ngenerate-json-schema\n--listen\n";
  if (runtime === "opencode" && key === "--help") return "opencode run\nopencode acp\nopencode serve\nopencode session\n";
  if (runtime === "opencode" && key === "run --help") return "Run OpenCode with a message\n--format choices: json\n--pure\n--dir\n--title\n--session\n--continue\n";
  if (runtime === "opencode" && key === "acp --help") return "Agent Client Protocol\n--cwd\n--port\n";
  return "unsupported fixture invocation\n";
}

function evidenceSpawn(command, args, options) {
  return recordSpawn(process.execPath, ["-e", "process.stdout.write(process.argv[1])", "--", evidenceOutput(command, args)], { ...options, cwd: pluginRoot });
}

async function waitForFile(file, timeoutMs = 10_000) {
  const started = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForCondition(predicate, timeoutMs = 10_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for worker admission condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function waitChild(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`Child exit ${code}: ${stderr}\n${stdout}`)));
  });
}

async function fixture(t, scopeKind = "run", { legacy = false } = {}) {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), "head-worker-admission-"));
  const make = (name) => {
    const directory = path.join(container, name);
    fs.mkdirSync(directory);
    return fs.realpathSync(directory);
  };
  const root = make("project");
  const runtimeOperationalRoot = make("runtime-operational");
  const admissionOperationalRoot = make("admission-operational");
  const hostExpectationRoot = make("host-expectations");
  const bin = make("runtime-bin");
  const previousOperational = process.env[RUNTIME_OPERATIONAL_STATE_ENV];
  process.env[RUNTIME_OPERATIONAL_STATE_ENV] = runtimeOperationalRoot;
  const ownedChildren = new Set();
  t.after(() => {
    for (const child of ownedChildren) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
    if (previousOperational === undefined) delete process.env[RUNTIME_OPERATIONAL_STATE_ENV];
    else process.env[RUNTIME_OPERATIONAL_STATE_ENV] = previousOperational;
    fs.rmSync(container, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, "example.mjs"), "export const answer = 42;\n");
  const initialized = legacy ? seedLegacyProject(root) : initializeProject({ root, pluginRoot, runtimes: ["claude", "codex", "opencode"] });
  const storage = inspectProject(root).storage, directory = formatForVerifiedOwner(storage).directory;
  if (scopeKind === "run") {
  const capsule = (await compileContext({ root, task: "Verify provider-neutral bounded worker admission", budget: 32_768, persist: true })).capsule;
  const plan = createWholePlanSnapshot({ root, objective: "Verify worker admission", plan: ["reserve", "consume", "release"], persist: true }).artifact;
  const contract = createExecutionContract({
    root,
    wholePlanId: plan.wholePlanId,
    capsuleId: capsule.capsuleId,
    scope: "Read-only admission verification",
    acceptanceCriteria: ["No authorization is widened", "Capacity follows durable lease evidence"],
    allowedActions: ["runtime.invoke", "project.read"],
    forbiddenActions: ["project.write", "canon.mutate"],
    persist: true,
  }).artifact;
  startRun({ root, executionContractId: contract.executionContractId });
  }
  for (const runtime of ["claude", "codex", "opencode"]) {
    const executable = path.join(bin, process.platform === "win32" ? `${runtime}.exe` : runtime);
    fs.writeFileSync(executable, `${runtime} fixture\n`);
    if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
  }
  const environment = { ...process.env, PATH: bin };
  delete environment.Path;
  delete environment.path;
  const versionEvidence = await buildRuntimeVersionEvidence({ runtimes: ["claude", "codex", "opencode"], environment, spawnImplementation: evidenceSpawn });
  const protocolEvidence = await buildRuntimeProtocolEvidence({ runtimes: ["claude", "codex", "opencode"], versionEvidence, environment, spawnImplementation: evidenceSpawn });
  const inspected = inspectProject(root);
  const projectBinding = buildRuntimeProjectBinding({
    projectId: initialized.project.projectId,
    storage,
    headSessionId: inspected.state.sessionId,
    projectRoot: root,
    projectStatus: "ready",
    versionEvidence,
    protocolEvidence,
  });
  let maxEvents = 4_000;
  const authorization = (runtime = "codex", model = null) => buildRuntimeInvocationAuthorization({
    root,
    runtime,
    runtimeSelection: model ? { model } : {},
    scope: scopeKind === "run" ? { kind: "run" } : { kind: "session", request: "Return one bounded source inspection result.", contextCapsuleId: null },
    workspaceMode: "read-only",
    protocolEvidence,
    projectBinding,
    limits: { timeoutMs: 5_000, maxEvents: maxEvents-- },
    persist: true,
  }).authorization;
  const dispatch = (auth, role = "coder") => createBoundedWorkerDispatch({ root, authorizationId: auth.authorizationId, role }).dispatch;
  const provision = (suffix, policy = { globalLimit: 1, perKeyLimit: 1, default: "hold-for-host-confirmation", maxQueued: 16, maxWaitMs: 5_000 }) => {
    const domainId = `worker-admission-domain-${hash(`${container}/${suffix}`).slice(0, 24)}`;
    return provisionWorkerAdmissionDomain({ operationalStateRoot: admissionOperationalRoot, hostExpectationRoot, newAdmissionDomainId: domainId, policy });
  };
  const open = (created, preStartValidate = async () => ({ status: "current" })) => openWorkerAdmissionHost({
    operationalStateRoot: admissionOperationalRoot,
    hostExpectationRoot,
    admissionDomainId: created.admissionDomainId,
    expectedDomainInstanceId: created.domainInstanceId,
    expectedMetadataHash: created.metadataHash,
    preStartValidate,
  });
  const spawnOwned = (args) => {
    const child = recordSpawn(process.execPath, args, { cwd: pluginRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    ownedChildren.add(child);
    child.once("close", () => ownedChildren.delete(child));
    return child;
  };
  return { container, root, storage, directory, runtimeOperationalRoot, admissionOperationalRoot, hostExpectationRoot, protocolEvidence, projectBinding, authorization, dispatch, provision, open, spawnOwned };
}

test("Session worker keeps one-shot evidence independent from Run authority and rejects widened requests before dispatch", async (t) => {
  const f = await fixture(t, "session");
  const auth = f.authorization();
  const protectedFiles = [`${f.directory}/project.json`, `${f.directory}/sessions/current.json`, `${f.directory}/context/product-model.json`];
  const before = protectedFiles.map(file => fs.readFileSync(path.join(f.root, file)));
  for (const sessionRequest of ['', 'Do additional unapproved work.']) {
    await assert.rejects(() => executeBoundedWorkerDispatch({ root: f.root, authorizationId: auth.authorizationId, role: 'coder', execution: { sessionRequest } }), { code: 'RUNTIME_INVOCATION_INPUT_DRIFT' });
    assert.equal(fs.existsSync(path.join(f.root, f.directory, 'runtime/worker-dispatches', `${auth.authorizationId}.json`)), false);
    assert.equal(inspectRuntimeExecutionLease({ projectRoot: f.root, projectId: auth.projectId, authorizationId: auth.authorizationId, storage: f.storage }).singleUseConsumed, false);
  }
  const dispatch = f.dispatch(auth);
  for (const field of ['runId', 'wholePlanId', 'executionContractId', 'contextCapsuleId']) assert.equal(dispatch[field], null);
  assert.equal(readBoundedWorkerDispatch({ root: f.root, authorizationId: auth.authorizationId }).dispatch.dispatchId, dispatch.dispatchId);
  assert.equal((await waitForBoundedWorkerDispatch({ root: f.root, authorizationId: auth.authorizationId })).status, 'bounded_worker_pending');
  assert.throws(() => applyBoundedWorkerDispatchResult({ root: f.root, authorizationId: auth.authorizationId }), { code: 'BOUNDED_WORKER_APPLY_RUN_REQUIRED' });
  assert.throws(() => f.dispatch(auth, 'head'), { code: 'INVALID_BOUNDED_WORKER_ROLE' });
  assert.throws(() => f.dispatch(auth, 'reviewer'), { code: 'BOUNDED_WORKER_DISPATCH_OWNERSHIP_CONFLICT' });
  const host = f.open(f.provision('session'));
  const reservation = await enqueueWorkerAdmission({ host, root: f.root, authorizationId: auth.authorizationId, dispatchId: dispatch.dispatchId });
  assert.equal(readWorkerAdmissionProjection({ host, root: f.root, authorizationId: auth.authorizationId }).state, 'capacity-reserved');
  const ownerFenceDigest = hash('session-test-owner');
  const leased = await withRuntimeExecutionLease({ projectRoot: f.root, authorization: auth, ownerFenceDigest }, async ({ consumption }) => ({
    receipt: buildRuntimeInvocationLifecycleReceipt({ authorization: auth, events: [], consumption, status: 'completed', exitCode: 0, signal: '', stdoutBytes: 0, stderrBytes: 0, stdoutDigest: hash(''), stderrDigest: hash(''), callerFenceDigest: ownerFenceDigest, childFenceDigest: hash('session-test-child'), childStarted: false, childExitObserved: false, terminationRequested: false, projectFenceValidated: true, inputDigestObserved: auth.executionInput.digest, noDescendantFixture: true, descendantTreeOwnershipValidated: false, providerMode: 'codex-protocol-fixture' }),
  }), { preConsumeGate: reservation.preConsumeGate });
  assert.equal(inspectRuntimeExecutionLease({ projectRoot: f.root, projectId: auth.projectId, authorizationId: auth.authorizationId, storage: f.storage }).singleUseConsumed, true);
  await assert.rejects(() => reservation.finalize({ outcomeCode: 'completed' }), { code: 'WORKER_ADMISSION_RELEASE_EVIDENCE_MISSING' });
  const draft = buildRuntimeResultPacketDraft({ authorization: auth, receipt: leased.result.receipt, leaseRelease: leased.release });
  persistRuntimeInvocationRecord({ projectRoot: f.root, authorization: auth, events: [], receipt: leased.result.receipt, draft });
  await reservation.finalize({ outcomeCode: 'completed' });
  const waited = await waitForBoundedWorkerDispatch({ root: f.root, authorizationId: auth.authorizationId });
  assert.equal(waited.status, 'bounded_worker_completed');
  assert.equal(waited.waitOutcome.reviewAuthority, false);
  const other = f.authorization();
  f.dispatch(other, 'reviewer');
  assert.throws(() => createBoundedWorkerWave({ root: f.root, authorizationIds: [auth.authorizationId, other.authorizationId] }));
  protectedFiles.forEach((file, index) => assert.deepEqual(fs.readFileSync(path.join(f.root, file)), before[index]));
});

test("legacy immutable Run dispatch replays without rewriting its protocol or ownership", async (t) => {
  const f = await fixture(t, "run", { legacy: true });
  const auth = f.authorization();
  const dispatch = f.dispatch(auth);
  const { dispatchId, dispatchHash, ...legacy } = dispatch;
  legacy.protocol.version = '0.1.0';
  const legacyHash = canonicalHash(legacy);
  const file = path.join(f.root, f.directory, 'runtime/worker-dispatches', `${auth.authorizationId}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...legacy, dispatchId: `bounded-worker-dispatch-${legacyHash.slice(0, 24)}`, dispatchHash: legacyHash }));
  const bytes = fs.readFileSync(file);
  assert.equal(f.dispatch(auth).protocol.version, '0.1.0');
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal((await waitForBoundedWorkerDispatch({ root: f.root, authorizationId: auth.authorizationId })).status, 'bounded_worker_pending');
});

test("worker admission provisions exact Host identity and refuses partial or repeated domains", async (t) => {
  const f = await fixture(t);
  const created = f.provision("identity");
  const host = f.open(created);
  assert.throws(() => f.provision("identity"), { code: "WORKER_ADMISSION_DOMAIN_ALREADY_EXISTS" });
  assert.throws(() => openWorkerAdmissionHost({
    operationalStateRoot: f.admissionOperationalRoot,
    hostExpectationRoot: f.hostExpectationRoot,
    admissionDomainId: created.admissionDomainId,
    expectedDomainInstanceId: created.domainInstanceId,
    expectedMetadataHash: "0".repeat(64),
  }), { code: "WORKER_ADMISSION_DOMAIN_IDENTITY_CONFLICT" });
  const commit = path.join(f.hostExpectationRoot, "worker-admission", "domains", created.admissionDomainId, "provision-commit.json");
  fs.unlinkSync(commit);
  assert.throws(() => openWorkerAdmissionHost({
    operationalStateRoot: f.admissionOperationalRoot,
    hostExpectationRoot: f.hostExpectationRoot,
    admissionDomainId: created.admissionDomainId,
    expectedDomainInstanceId: created.domainInstanceId,
    expectedMetadataHash: created.metadataHash,
  }), { code: "WORKER_ADMISSION_DOMAIN_UNAVAILABLE" });
  assert.ok(host);
});

test("worker admission cancellation and branded callback preserve zero or exactly-once consumption", async (t) => {
  const f = await fixture(t);
  const sessionFile = path.join(f.root, f.directory, "sessions", "current.json");
  const canonFile = path.join(f.root, f.directory, "context", "product-model.json");
  const reviewDirectory = path.join(f.root, f.directory, "lineage", "review-decisions");
  const authorityBefore = {
    session: fs.readFileSync(sessionFile),
    canon: fs.readFileSync(canonFile),
    reviewCount: fs.existsSync(reviewDirectory) ? fs.readdirSync(reviewDirectory).length : 0,
  };
  const created = f.provision("cancel");
  const host = f.open(created);
  const auth = f.authorization("codex");
  const dispatch = f.dispatch(auth);
  const controller = new AbortController();
  const reservation = await enqueueWorkerAdmission({ host, root: f.root, authorizationId: auth.authorizationId, dispatchId: dispatch.dispatchId, signal: controller.signal });
  controller.abort();
  await assert.rejects(() => withRuntimeExecutionLease({ projectRoot: f.root, authorization: auth, ownerFenceDigest: hash("cancel-owner") }, async () => ({}), { preConsumeGate: reservation.preConsumeGate }), { code: "WORKER_ADMISSION_CANCELLED" });
  const cancelledLease = inspectRuntimeExecutionLease({ projectRoot: f.root, projectId: auth.projectId, authorizationId: auth.authorizationId, storage: f.storage });
  assert.equal(cancelledLease.status, "available");
  assert.equal(cancelledLease.singleUseConsumed, false);
  assert.equal((await reservation.finalize({ outcomeCode: "execution-threw" })).status, "existing-terminal");

  const auth2 = f.authorization("codex");
  f.dispatch(auth2, "developer");
  let escapedCommit;
  const gate = createRuntimePreConsumeGateCapability(({ commitConsumption }) => {
    escapedCommit = commitConsumption;
    commitConsumption();
  });
  await withRuntimeExecutionLease({ projectRoot: f.root, authorization: auth2, ownerFenceDigest: hash("one-shot-owner") }, async () => ({}), { preConsumeGate: gate });
  assert.throws(() => escapedCommit(), { code: "RUNTIME_CONSUMPTION_CALLBACK_REPLAYED" });
  await assert.rejects(() => withRuntimeExecutionLease({ projectRoot: f.root, authorization: f.authorization("codex"), ownerFenceDigest: hash("forged-owner") }, async () => ({}), { preConsumeGate: {} }), { code: "INVALID_RUNTIME_PRE_CONSUME_GATE" });

  const auth3 = f.authorization("codex");
  const dispatch3 = f.dispatch(auth3, "reviewer");
  const reservation3 = await enqueueWorkerAdmission({ host, root: f.root, authorizationId: auth3.authorizationId, dispatchId: dispatch3.dispatchId });
  const reservedProjection = readWorkerAdmissionProjection({ host, root: f.root, authorizationId: auth3.authorizationId });
  assert.equal(reservedProjection.state, "capacity-reserved");
  assert.equal(reservedProjection.authorizationConsumed, false);
  assert.deepEqual(reservedProjection.executionEvidence, {
    availability: "available",
    leaseStatus: "available",
    authorizationConsumed: false,
    supervisorStartObserved: "unknown",
    providerStartObserved: "unknown",
    terminalEvidence: "none",
    diagnosticCode: null,
  });
  const ownerFenceDigest = hash("finalize-owner");
  const leased3 = await withRuntimeExecutionLease({ projectRoot: f.root, authorization: auth3, ownerFenceDigest }, async ({ consumption }) => ({
    receipt: buildRuntimeInvocationLifecycleReceipt({
      authorization: auth3,
      events: [],
      consumption,
      status: "completed",
      exitCode: 0,
      signal: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutDigest: hash(""),
      stderrDigest: hash(""),
      callerFenceDigest: ownerFenceDigest,
      childFenceDigest: hash("finalize-child"),
      childStarted: false,
      childExitObserved: false,
      terminationRequested: false,
      projectFenceValidated: true,
      inputDigestObserved: auth3.executionInput.digest,
      noDescendantFixture: true,
      descendantTreeOwnershipValidated: false,
      providerMode: "codex-protocol-fixture",
    }),
  }), { preConsumeGate: reservation3.preConsumeGate });
  const draft3 = buildRuntimeResultPacketDraft({ authorization: auth3, receipt: leased3.result.receipt, leaseRelease: leased3.release });
  persistRuntimeInvocationRecord({ projectRoot: f.root, authorization: auth3, events: [], receipt: leased3.result.receipt, draft: draft3 });
  assert.equal((await reservation3.finalize({ outcomeCode: "completed" })).status, "released");
  assert.equal((await reservation3.finalize({ outcomeCode: "completed" })).status, "existing");
  await assert.rejects(() => reservation3.finalize({ outcomeCode: "failed" }), { code: "WORKER_ADMISSION_FINALIZE_CONFLICT" });
  assert.deepEqual(fs.readFileSync(sessionFile), authorityBefore.session);
  assert.deepEqual(fs.readFileSync(canonFile), authorityBefore.canon);
  assert.equal(fs.existsSync(reviewDirectory) ? fs.readdirSync(reviewDirectory).length : 0, authorityBefore.reviewCount);
  const persistedAdmission = `${fs.readFileSync(path.join(f.admissionOperationalRoot, "worker-admission", "domains", created.admissionDomainId, "metadata.json"), "utf8")}\n${fs.readdirSync(path.join(f.admissionOperationalRoot, "worker-admission", "domains", created.admissionDomainId, "events")).map((name) => fs.readFileSync(path.join(f.admissionOperationalRoot, "worker-admission", "domains", created.admissionDomainId, "events", name), "utf8")).join("\n")}`;
  assert.equal(/providerSession|threadId|pane|socket|Herdr|\"pid\"/i.test(persistedAdmission), false);
});

test("independent processes serialize one capacity key and release only after lease cleanup", async (t) => {
  const f = await fixture(t);
  const created = f.provision("contention");
  const authA = f.authorization("codex", "openai/gpt-test");
  const authB = f.authorization("codex", "openai/gpt-test");
  const dispatchA = f.dispatch(authA, "coder");
  const dispatchB = f.dispatch(authB, "developer");
  const marker = (name) => path.join(f.container, name);
  const configs = [
    { authorizationId: authA.authorizationId, dispatchId: dispatchA.dispatchId, reservedMarker: marker("a.reserved"), startedMarker: marker("a.started"), releaseMarker: marker("a.release") },
    { authorizationId: authB.authorizationId, dispatchId: dispatchB.dispatchId, reservedMarker: marker("b.reserved"), startedMarker: marker("b.started"), releaseMarker: marker("b.release") },
  ].map((value, index) => {
    const file = marker(`contender-${index}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...value, root: f.root, admissionOperationalRoot: f.admissionOperationalRoot, hostExpectationRoot: f.hostExpectationRoot, admissionDomainId: created.admissionDomainId, domainInstanceId: created.domainInstanceId, metadataHash: created.metadataHash }));
    return { ...value, file };
  });
  const first = f.spawnOwned([contenderFile, configs[0].file]);
  const firstDone = waitChild(first);
  await waitForFile(configs[0].startedMarker);
  const second = f.spawnOwned([contenderFile, configs[1].file]);
  const secondDone = waitChild(second);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fs.existsSync(configs[1].reservedMarker), false);
  assert.equal(fs.existsSync(configs[1].startedMarker), false);
  fs.writeFileSync(configs[0].releaseMarker, "release\n", { flag: "wx" });
  await firstDone;
  await waitForFile(configs[1].startedMarker);
  fs.writeFileSync(configs[1].releaseMarker, "release\n", { flag: "wx" });
  await secondDone;
  assert.throws(() => process.kill(first.pid, 0), { code: "ESRCH" });
  assert.throws(() => process.kill(second.pid, 0), { code: "ESRCH" });
});

test("all provider adapters honor final admission cancellation before spawn and wave reads stay optional", async (t) => {
  const f = await fixture(t);
  const created = f.provision("adapters", { globalLimit: 3, perKeyLimit: 1, default: "hold-for-host-confirmation", maxQueued: 16, maxWaitMs: 5_000 });
  const host = f.open(created, async ({ phase }) => ({ status: phase === "pre-consume" ? "cancelled" : "current" }));
  let spawnCalls = 0;
  const authorizations = [];
  for (const [runtime, role] of [["codex", "coder"], ["claude", "developer"], ["opencode", "reviewer"]]) {
    const auth = f.authorization(runtime);
    authorizations.push(auth);
    f.dispatch(auth, role);
    const observation = f.protocolEvidence.observations.find((item) => item.runtime === runtime).executable;
    await assert.rejects(() => executeBoundedWorkerDispatch({
      root: f.root,
      authorizationId: auth.authorizationId,
      role,
      admissionHost: host,
      execution: {
        protocolEvidence: f.protocolEvidence,
        projectBinding: f.projectBinding,
        evidenceMode: "protocol-fixture",
        providerArguments: ["--never-spawn"],
        targetResolver: () => ({ executablePath: process.execPath, observation }),
        // Cancellation must win before the provider operation can inspect or use
        // this deliberately non-runnable supervisor placeholder.
        supervisorSelection: Object.freeze({ testOnlyNoSpawn: true }),
        spawnImplementation: () => { spawnCalls += 1; throw new Error("must not spawn"); },
      },
    }), { code: "WORKER_ADMISSION_CANCELLED" });
    const lease = inspectRuntimeExecutionLease({ projectRoot: f.root, projectId: auth.projectId, authorizationId: auth.authorizationId, storage: f.storage });
    assert.equal(lease.singleUseConsumed, false);
  }
  assert.equal(spawnCalls, 0);
  const wave = createBoundedWorkerWave({ root: f.root, authorizationIds: authorizations.map((item) => item.authorizationId) }).wave;
  const ordinary = readBoundedWorkerWaveStatus({ root: f.root, waveId: wave.waveId }).projection;
  assert.equal(Object.hasOwn(ordinary, "admission"), false);
  const detailed = readBoundedWorkerWaveStatus({ root: f.root, waveId: wave.waveId, admissionHost: host }).projection;
  assert.equal(detailed.admission.availability, "available");
  assert.equal(detailed.admission.members.every((item) => item.state === "cancelled"), true);
  assert.equal(detailed.admission.members.every((item) => item.recoveryAuthority === false && item.mutatesCanon === false), true);

  const targetAbortDomain = f.provision("target-abort");
  const targetAbortHost = f.open(targetAbortDomain);
  const targetAbortAuthorization = f.authorization("codex");
  f.dispatch(targetAbortAuthorization, "coder");
  await assert.rejects(() => executeBoundedWorkerDispatch({
    root: f.root,
    authorizationId: targetAbortAuthorization.authorizationId,
    role: "coder",
    admissionHost: targetAbortHost,
    execution: {
      protocolEvidence: f.protocolEvidence,
      projectBinding: f.projectBinding,
      evidenceMode: "protocol-fixture",
      providerArguments: ["--never-spawn"],
      targetResolver: () => { const error = new Error("Host target resolution aborted"); error.code = "HOST_TARGET_RESOLUTION_ABORTED"; throw error; },
      spawnImplementation: () => { spawnCalls += 1; throw new Error("must not spawn"); },
    },
  }), { code: "HOST_TARGET_RESOLUTION_ABORTED" });
  const targetAbortLease = inspectRuntimeExecutionLease({ projectRoot: f.root, projectId: targetAbortAuthorization.projectId, authorizationId: targetAbortAuthorization.authorizationId, storage: f.storage });
  assert.equal(targetAbortLease.singleUseConsumed, false);
  assert.equal(readWorkerAdmissionProjection({ host: targetAbortHost, root: f.root, authorizationId: targetAbortAuthorization.authorizationId }).state, "released");
  assert.equal(spawnCalls, 0);

  const signalAbortDomain = f.provision("target-signal-abort");
  const signalAbortHost = f.open(signalAbortDomain);
  const signalAbortAuthorization = f.authorization("codex");
  f.dispatch(signalAbortAuthorization, "coder");
  const signalController = new AbortController();
  const codexObservation = f.protocolEvidence.observations.find((item) => item.runtime === "codex").executable;
  await assert.rejects(() => executeBoundedWorkerDispatch({
    root: f.root,
    authorizationId: signalAbortAuthorization.authorizationId,
    role: "coder",
    admissionHost: signalAbortHost,
    execution: {
      signal: signalController.signal,
      protocolEvidence: f.protocolEvidence,
      projectBinding: f.projectBinding,
      evidenceMode: "protocol-fixture",
      providerArguments: ["--never-spawn"],
      targetResolver: () => {
        signalController.abort();
        return { executablePath: process.execPath, observation: codexObservation };
      },
      supervisorSelection: Object.freeze({ testOnlyNoSpawn: true }),
      spawnImplementation: () => { spawnCalls += 1; throw new Error("must not spawn"); },
    },
  }), { code: "WORKER_ADMISSION_CANCELLED" });
  const signalAbortLease = inspectRuntimeExecutionLease({
    projectRoot: f.root,
    storage: f.storage,
    projectId: signalAbortAuthorization.projectId,
    authorizationId: signalAbortAuthorization.authorizationId,
  });
  assert.equal(signalAbortLease.singleUseConsumed, false);
  assert.equal(readWorkerAdmissionProjection({ host: signalAbortHost, root: f.root, authorizationId: signalAbortAuthorization.authorizationId }).state, "cancelled");
  assert.equal(spawnCalls, 0);
});

test("consumption followed by admission marker failure stays consumed and makes only that domain unavailable", async (t) => {
  const f = await fixture(t);
  const created = f.provision("marker-failure");
  const markerDirectory = path.join(f.hostExpectationRoot, "worker-admission", "domains", created.admissionDomainId, "event-commits");
  const host = f.open(created);
  const auth = f.authorization("codex");
  const dispatch = f.dispatch(auth);
  const reservation = await enqueueWorkerAdmission({ host, root: f.root, authorizationId: auth.authorizationId, dispatchId: dispatch.dispatchId });
  const originalLinkSync = fs.linkSync;
  let sabotaged = false;
  fs.linkSync = (source, destination) => {
    originalLinkSync(source, destination);
    if (!sabotaged && path.basename(destination) === "consumption.json" && destination.includes(auth.authorizationId)) {
      sabotaged = true;
      fs.rmSync(markerDirectory, { recursive: true, force: true });
      fs.writeFileSync(markerDirectory, "force marker commit failure after consumption\n");
    }
  };
  try {
    await assert.rejects(() => withRuntimeExecutionLease({ projectRoot: f.root, authorization: auth, ownerFenceDigest: hash("uncertain-owner") }, async () => { throw new Error("provider must not run"); }, { preConsumeGate: reservation.preConsumeGate }), { code: "WORKER_ADMISSION_START_COMMIT_UNCERTAIN" });
  } finally {
    fs.linkSync = originalLinkSync;
  }
  assert.equal(sabotaged, true);
  const lease = inspectRuntimeExecutionLease({ projectRoot: f.root, projectId: auth.projectId, authorizationId: auth.authorizationId, storage: f.storage });
  assert.equal(lease.status, "consumed-released");
  assert.equal(lease.release.operationStatus, "threw");
  const projection = readWorkerAdmissionProjection({ host, root: f.root, authorizationId: auth.authorizationId });
  assert.equal(projection.availability, "unavailable");
  assert.equal(projection.state, "unknown-blocking");
  assert.equal(inspectProject(f.root).status, "ready");
});

test("reserved restart requires definitive lease evidence and validator-window cancellation consumes nothing", async (t) => {
  const f = await fixture(t);
  const restartDomain = f.provision("reserved-restart");
  const restartHost = f.open(restartDomain, async () => ({ status: "current", resume: true }));
  const restartAuth = f.authorization("codex");
  const restartDispatch = f.dispatch(restartAuth);
  const firstReservation = await enqueueWorkerAdmission({ host: restartHost, root: f.root, authorizationId: restartAuth.authorizationId, dispatchId: restartDispatch.dispatchId });
  const resumedReservation = await enqueueWorkerAdmission({
    host: restartHost,
    root: f.root,
    authorizationId: restartAuth.authorizationId,
    dispatchId: restartDispatch.dispatchId,
  });
  const restartProjection = readWorkerAdmissionProjection({ host: restartHost, root: f.root, authorizationId: restartAuth.authorizationId });
  assert.equal(firstReservation.generation, 1);
  assert.equal(resumedReservation.generation, 2);
  assert.equal(restartProjection.state, "capacity-reserved");
  assert.equal(restartProjection.authorizationConsumed, false);
  await resumedReservation.finalize({ outcomeCode: "safe-resume-release" });

  const claimedDomain = f.provision("claimed-reserved-restart");
  const claimedHost = f.open(claimedDomain, async () => ({ status: "current", resume: true }));
  const claimedAuth = f.authorization("codex");
  const claimedDispatch = f.dispatch(claimedAuth);
  await enqueueWorkerAdmission({ host: claimedHost, root: f.root, authorizationId: claimedAuth.authorizationId, dispatchId: claimedDispatch.dispatchId });
  let enteredClaim;
  let releaseClaim;
  const claimEntered = new Promise((resolve) => { enteredClaim = resolve; });
  const claimRelease = new Promise((resolve) => { releaseClaim = resolve; });
  const heldGate = createRuntimePreConsumeGateCapability(async () => {
    enteredClaim();
    await claimRelease;
  });
  const heldLease = withRuntimeExecutionLease({
    projectRoot: f.root,
    authorization: claimedAuth,
    ownerFenceDigest: hash("claimed-restart-owner"),
  }, async () => ({}), { preConsumeGate: heldGate });
  await claimEntered;
  await assert.rejects(() => enqueueWorkerAdmission({
    host: claimedHost,
    root: f.root,
    authorizationId: claimedAuth.authorizationId,
    dispatchId: claimedDispatch.dispatchId,
  }), { code: "WORKER_ADMISSION_UNKNOWN_BLOCKING" });
  releaseClaim();
  await assert.rejects(() => heldLease, { code: "RUNTIME_PRE_CONSUME_GATE_DID_NOT_COMMIT" });
  const claimedProjection = readWorkerAdmissionProjection({ host: claimedHost, root: f.root, authorizationId: claimedAuth.authorizationId });
  assert.equal(claimedProjection.state, "unknown-blocking");
  assert.equal(claimedProjection.authorizationConsumed, false);

  const controller = new AbortController();
  let enteredValidation;
  let releaseValidation;
  const validationEntered = new Promise((resolve) => { enteredValidation = resolve; });
  const validationRelease = new Promise((resolve) => { releaseValidation = resolve; });
  const cancelDomain = f.provision("validator-window-cancel");
  const cancelHost = f.open(cancelDomain, async ({ phase }) => {
    if (phase === "pre-consume") {
      enteredValidation();
      await validationRelease;
    }
    return { status: "current" };
  });
  const cancelAuth = f.authorization("codex");
  const cancelDispatch = f.dispatch(cancelAuth);
  const cancelReservation = await enqueueWorkerAdmission({
    host: cancelHost,
    root: f.root,
    authorizationId: cancelAuth.authorizationId,
    dispatchId: cancelDispatch.dispatchId,
    signal: controller.signal,
  });
  let operationCalls = 0;
  const execution = withRuntimeExecutionLease({
    projectRoot: f.root,
    authorization: cancelAuth,
    ownerFenceDigest: hash("validator-window-owner"),
  }, async () => { operationCalls += 1; }, { preConsumeGate: cancelReservation.preConsumeGate });
  await validationEntered;
  controller.abort();
  releaseValidation();
  await assert.rejects(() => execution, { code: "WORKER_ADMISSION_CANCELLED" });
  assert.equal(operationCalls, 0);
  const cancelLease = inspectRuntimeExecutionLease({ projectRoot: f.root, projectId: cancelAuth.projectId, authorizationId: cancelAuth.authorizationId, storage: f.storage });
  assert.equal(cancelLease.status, "available");
  assert.equal(cancelLease.singleUseConsumed, false);
  assert.equal(readWorkerAdmissionProjection({ host: cancelHost, root: f.root, authorizationId: cancelAuth.authorizationId }).state, "cancelled");
});

test("journal head detects paired tail loss and impossible committed transitions", async (t) => {
  const f = await fixture(t);
  const lostDomain = f.provision("paired-tail-loss");
  const lostHost = f.open(lostDomain);
  const lostAuth = f.authorization("codex");
  const lostDispatch = f.dispatch(lostAuth);
  await enqueueWorkerAdmission({ host: lostHost, root: f.root, authorizationId: lostAuth.authorizationId, dispatchId: lostDispatch.dispatchId });
  const lostEventRoot = path.join(f.admissionOperationalRoot, "worker-admission", "domains", lostDomain.admissionDomainId, "events");
  const lostMarkerRoot = path.join(f.hostExpectationRoot, "worker-admission", "domains", lostDomain.admissionDomainId, "event-commits");
  fs.unlinkSync(path.join(lostEventRoot, "0000000002.json"));
  fs.unlinkSync(path.join(lostMarkerRoot, "0000000002.json"));
  const lostProjection = readWorkerAdmissionProjection({ host: lostHost, root: f.root, authorizationId: lostAuth.authorizationId });
  assert.equal(lostProjection.availability, "unavailable");
  assert.equal(lostProjection.state, "unknown-blocking");
  assert.equal(lostProjection.diagnosticCode, "WORKER_ADMISSION_JOURNAL_UNAVAILABLE");
  assert.equal(inspectProject(f.root).status, "ready");

  const forgedDomain = f.provision("impossible-transition");
  const forgedHost = f.open(forgedDomain);
  const forgedAuth = f.authorization("codex");
  const forgedDispatch = f.dispatch(forgedAuth);
  await enqueueWorkerAdmission({ host: forgedHost, root: f.root, authorizationId: forgedAuth.authorizationId, dispatchId: forgedDispatch.dispatchId });
  const forgedBase = path.join(f.admissionOperationalRoot, "worker-admission", "domains", forgedDomain.admissionDomainId);
  const forgedExpectation = path.join(f.hostExpectationRoot, "worker-admission", "domains", forgedDomain.admissionDomainId);
  const eventFile = path.join(forgedBase, "events", "0000000002.json");
  const markerFile = path.join(forgedExpectation, "event-commits", "0000000002.json");
  const headFile = path.join(forgedExpectation, "journal-head.json");
  const event = JSON.parse(fs.readFileSync(eventFile, "utf8"));
  event.eventType = "released";
  event.details = { outcomeCode: "forged-release" };
  delete event.eventHash;
  event.eventHash = canonicalHash(event);
  fs.writeFileSync(eventFile, `${JSON.stringify(event, null, 2)}\n`);
  const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
  marker.eventHash = event.eventHash;
  delete marker.markerHash;
  marker.markerHash = canonicalHash(marker);
  fs.writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`);
  const head = JSON.parse(fs.readFileSync(headFile, "utf8"));
  head.eventHash = event.eventHash;
  delete head.headHash;
  head.headHash = canonicalHash(head);
  fs.writeFileSync(headFile, `${JSON.stringify(head, null, 2)}\n`);
  const forgedProjection = readWorkerAdmissionProjection({ host: forgedHost, root: f.root, authorizationId: forgedAuth.authorizationId });
  assert.equal(forgedProjection.availability, "unavailable");
  assert.equal(forgedProjection.diagnosticCode, "WORKER_ADMISSION_EVENT_TRANSITION_CONFLICT");
});

test("same-key FIFO and independent domains preserve bounded Host capacity", async (t) => {
  const f = await fixture(t);
  const fifoDomain = f.provision("fifo", { globalLimit: 1, perKeyLimit: 1, default: "hold-for-host-confirmation", maxQueued: 4, maxWaitMs: 5_000 });
  const fifoHost = f.open(fifoDomain);
  const authA = f.authorization("codex", "openai/gpt-fifo");
  const authB = f.authorization("codex", "openai/gpt-fifo");
  const authC = f.authorization("codex", "openai/gpt-fifo");
  const dispatchA = f.dispatch(authA, "coder");
  const dispatchB = f.dispatch(authB, "developer");
  const dispatchC = f.dispatch(authC, "reviewer");
  const reservationA = await enqueueWorkerAdmission({ host: fifoHost, root: f.root, authorizationId: authA.authorizationId, dispatchId: dispatchA.dispatchId });
  const pendingB = enqueueWorkerAdmission({ host: fifoHost, root: f.root, authorizationId: authB.authorizationId, dispatchId: dispatchB.dispatchId });
  await waitForCondition(() => readWorkerAdmissionProjection({ host: fifoHost, root: f.root, authorizationId: authB.authorizationId }).state === "queued");
  let cResolved = false;
  const pendingC = enqueueWorkerAdmission({ host: fifoHost, root: f.root, authorizationId: authC.authorizationId, dispatchId: dispatchC.dispatchId }).then((value) => { cResolved = true; return value; });
  await waitForCondition(() => readWorkerAdmissionProjection({ host: fifoHost, root: f.root, authorizationId: authC.authorizationId }).state === "queued");
  await reservationA.finalize({ outcomeCode: "test-release" });
  const reservationB = await pendingB;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(cResolved, false);
  await reservationB.finalize({ outcomeCode: "test-release" });
  const reservationC = await pendingC;
  assert.equal(reservationC.capacityKey, reservationB.capacityKey);
  await reservationC.finalize({ outcomeCode: "test-release" });

  const domainOne = f.provision("domain-one");
  const domainTwo = f.provision("domain-two");
  const hostOne = f.open(domainOne);
  const hostTwo = f.open(domainTwo);
  const authOne = f.authorization("codex", "openai/gpt-shared");
  const authTwo = f.authorization("codex", "openai/gpt-shared");
  const independentOne = await enqueueWorkerAdmission({ host: hostOne, root: f.root, authorizationId: authOne.authorizationId, dispatchId: f.dispatch(authOne).dispatchId });
  const independentTwo = await enqueueWorkerAdmission({ host: hostTwo, root: f.root, authorizationId: authTwo.authorizationId, dispatchId: f.dispatch(authTwo, "developer").dispatchId });
  assert.notEqual(independentOne.admissionDomainId, independentTwo.admissionDomainId);
  assert.equal(readWorkerAdmissionProjection({ host: hostOne, root: f.root, authorizationId: authOne.authorizationId }).state, "capacity-reserved");
  assert.equal(readWorkerAdmissionProjection({ host: hostTwo, root: f.root, authorizationId: authTwo.authorizationId }).state, "capacity-reserved");
  await independentOne.finalize({ outcomeCode: "test-release" });
  await independentTwo.finalize({ outcomeCode: "test-release" });
});

test("detached validation, queue capacity, expiry, and capacity-key routing stay bounded", async (t) => {
  const f = await fixture(t);
  const detachedDomain = f.provision("detached-cancel");
  const detachedHost = f.open(detachedDomain, async ({ phase }) => ({ status: phase === "queued" ? "superseded" : "current" }));
  const detachedAuth = f.authorization("codex");
  const detachedDispatch = f.dispatch(detachedAuth);
  await assert.rejects(() => enqueueWorkerAdmission({
    host: detachedHost,
    root: f.root,
    authorizationId: detachedAuth.authorizationId,
    dispatchId: detachedDispatch.dispatchId,
    mode: "detached",
  }), { code: "WORKER_ADMISSION_CANCELLED" });
  assert.equal(inspectRuntimeExecutionLease({ projectRoot: f.root, projectId: detachedAuth.projectId, authorizationId: detachedAuth.authorizationId, storage: f.storage }).singleUseConsumed, false);
  assert.equal(readWorkerAdmissionProjection({ host: detachedHost, root: f.root, authorizationId: detachedAuth.authorizationId }).state, "cancelled");

  const boundedDomain = f.provision("queue-bounds", { globalLimit: 1, perKeyLimit: 1, default: "hold-for-host-confirmation", maxQueued: 1, maxWaitMs: 1_000 });
  const boundedHost = f.open(boundedDomain);
  const holderAuth = f.authorization("codex", "openai/gpt-bounded");
  const holderDispatch = f.dispatch(holderAuth);
  const holder = await enqueueWorkerAdmission({
    host: boundedHost,
    root: f.root,
    authorizationId: holderAuth.authorizationId,
    dispatchId: holderDispatch.dispatchId,
    capacityKey: "forged/route",
    runtime: "opencode",
    model: "attacker/model",
  });
  assert.equal(holder.capacityKey, "runtime/codex/model/openai/gpt-bounded");
  const waitingAuth = f.authorization("codex", "openai/gpt-bounded");
  const waitingDispatch = f.dispatch(waitingAuth, "developer");
  const waiting = enqueueWorkerAdmission({ host: boundedHost, root: f.root, authorizationId: waitingAuth.authorizationId, dispatchId: waitingDispatch.dispatchId });
  await waitForCondition(() => readWorkerAdmissionProjection({ host: boundedHost, root: f.root, authorizationId: waitingAuth.authorizationId }).state === "queued");
  const overflowAuth = f.authorization("codex", "openai/gpt-bounded");
  const overflowDispatch = f.dispatch(overflowAuth, "reviewer");
  await assert.rejects(() => enqueueWorkerAdmission({ host: boundedHost, root: f.root, authorizationId: overflowAuth.authorizationId, dispatchId: overflowDispatch.dispatchId }), { code: "WORKER_ADMISSION_QUEUE_CAPACITY_EXCEEDED" });
  await assert.rejects(() => waiting, { code: "WORKER_ADMISSION_EXPIRED" });
  assert.equal(readWorkerAdmissionProjection({ host: boundedHost, root: f.root, authorizationId: waitingAuth.authorizationId }).state, "expired");
  assert.equal(inspectRuntimeExecutionLease({ projectRoot: f.root, projectId: waitingAuth.projectId, authorizationId: waitingAuth.authorizationId, storage: f.storage }).singleUseConsumed, false);
  await holder.finalize({ outcomeCode: "test-release" });

  const eligibleDomain = f.provision("oldest-eligible", { globalLimit: 2, perKeyLimit: 1, default: "hold-for-host-confirmation", maxQueued: 4, maxWaitMs: 5_000 });
  const eligibleHost = f.open(eligibleDomain);
  const keyOneA = f.authorization("codex", "openai/key-one");
  const keyOneB = f.authorization("codex", "openai/key-one");
  const keyTwo = f.authorization("codex", "openai/key-two");
  const keyOneReservation = await enqueueWorkerAdmission({ host: eligibleHost, root: f.root, authorizationId: keyOneA.authorizationId, dispatchId: f.dispatch(keyOneA).dispatchId });
  const keyOnePending = enqueueWorkerAdmission({ host: eligibleHost, root: f.root, authorizationId: keyOneB.authorizationId, dispatchId: f.dispatch(keyOneB, "developer").dispatchId });
  await waitForCondition(() => readWorkerAdmissionProjection({ host: eligibleHost, root: f.root, authorizationId: keyOneB.authorizationId }).state === "queued");
  const keyTwoReservation = await enqueueWorkerAdmission({ host: eligibleHost, root: f.root, authorizationId: keyTwo.authorizationId, dispatchId: f.dispatch(keyTwo, "reviewer").dispatchId });
  assert.equal(keyTwoReservation.capacityKey, "runtime/codex/model/openai/key-two");
  await keyOneReservation.finalize({ outcomeCode: "test-release" });
  const keyOneSecondReservation = await keyOnePending;
  await keyOneSecondReservation.finalize({ outcomeCode: "test-release" });
  await keyTwoReservation.finalize({ outcomeCode: "test-release" });
});

test("queued restart requires explicit Host resume and preserves the original deadline", async (t) => {
  const f = await fixture(t);
  const created = f.provision("queued-resume", { globalLimit: 1, perKeyLimit: 1, default: "hold-for-host-confirmation", maxQueued: 4, maxWaitMs: 5_000 });
  const host = f.open(created, async ({ phase }) => ({ status: "current", resume: phase === "resume" }));
  const holderAuth = f.authorization("codex", "openai/resume-key");
  const waitingAuth = f.authorization("codex", "openai/resume-key");
  const holder = await enqueueWorkerAdmission({ host, root: f.root, authorizationId: holderAuth.authorizationId, dispatchId: f.dispatch(holderAuth).dispatchId });
  const waitingDispatch = f.dispatch(waitingAuth, "developer");
  const original = enqueueWorkerAdmission({ host, root: f.root, authorizationId: waitingAuth.authorizationId, dispatchId: waitingDispatch.dispatchId }).then(
    () => ({ code: "unexpected-success" }),
    (error) => ({ code: error.code }),
  );
  await waitForCondition(() => readWorkerAdmissionProjection({ host, root: f.root, authorizationId: waitingAuth.authorizationId }).state === "queued");
  const resumed = enqueueWorkerAdmission({ host, root: f.root, authorizationId: waitingAuth.authorizationId, dispatchId: waitingDispatch.dispatchId });
  assert.deepEqual(await original, { code: "WORKER_ADMISSION_STALE_REQUEST" });
  const eventRoot = path.join(f.admissionOperationalRoot, "worker-admission", "domains", created.admissionDomainId, "events");
  const queueEvents = fs.readdirSync(eventRoot).sort().map((name) => JSON.parse(fs.readFileSync(path.join(eventRoot, name), "utf8")))
    .filter((event) => event.authorizationId === waitingAuth.authorizationId && new Set(["queued", "resumed"]).has(event.eventType));
  assert.equal(queueEvents.length, 2);
  assert.equal(queueEvents[1].generation, queueEvents[0].generation + 1);
  assert.equal(queueEvents[1].details.deadlineAt, queueEvents[0].details.deadlineAt);
  await holder.finalize({ outcomeCode: "test-release" });
  const reservation = await resumed;
  assert.equal(reservation.generation, 2);
  await reservation.finalize({ outcomeCode: "test-release" });
});

test("final pre-consume guard rejects a Run closed during Host validation", async (t) => {
  const f = await fixture(t);
  const created = f.provision("lineage-window");
  let enteredValidation;
  let releaseValidation;
  const validationEntered = new Promise((resolve) => { enteredValidation = resolve; });
  const validationRelease = new Promise((resolve) => { releaseValidation = resolve; });
  const host = f.open(created, async ({ phase }) => {
    if (phase === "pre-consume") {
      enteredValidation();
      await validationRelease;
    }
    return { status: "current" };
  });
  const authorization = f.authorization("codex");
  const dispatch = f.dispatch(authorization);
  const reservation = await enqueueWorkerAdmission({
    host,
    root: f.root,
    authorizationId: authorization.authorizationId,
    dispatchId: dispatch.dispatchId,
  });
  let operationCalls = 0;
  const execution = withRuntimeExecutionLease({
    projectRoot: f.root,
    authorization,
    ownerFenceDigest: hash("lineage-window-owner"),
  }, async () => { operationCalls += 1; }, { preConsumeGate: reservation.preConsumeGate });
  await validationEntered;
  finishRun({
    root: f.root,
    outcome: "Close the test Run during pending Host validation",
    evidence: [{ uri: "fixture", digest: hash("lineage-window-evidence") }],
    verification: [{ check: "fixture transition", status: "passed" }],
  });
  releaseValidation();
  await assert.rejects(() => execution, { code: "WORKER_ADMISSION_LINEAGE_CONFLICT" });
  const lease = inspectRuntimeExecutionLease({
    projectRoot: f.root,
    storage: f.storage,
    projectId: authorization.projectId,
    authorizationId: authorization.authorizationId,
  });
  assert.equal(lease.singleUseConsumed, false);
  assert.equal(operationCalls, 0);
  assert.equal((await reservation.finalize({ outcomeCode: "test-cleanup" })).status, "existing-terminal");
});

test("an old queued caller cannot cancel a resumed generation", async (t) => {
  const f = await fixture(t);
  const created = f.provision("generation-fence", {
    globalLimit: 1,
    perKeyLimit: 1,
    default: "hold-for-host-confirmation",
    maxQueued: 4,
    maxWaitMs: 5_000,
  });
  const oldController = new AbortController();
  const newController = new AbortController();
  const host = f.open(created, async ({ phase }) => {
    if (phase === "resume") oldController.abort();
    return { status: "current", resume: phase === "resume" };
  });
  const holderAuthorization = f.authorization("codex", "fixture/holder");
  const holder = await enqueueWorkerAdmission({
    host,
    root: f.root,
    authorizationId: holderAuthorization.authorizationId,
    dispatchId: f.dispatch(holderAuthorization).dispatchId,
  });
  const authorization = f.authorization("codex", "fixture/queued");
  const dispatch = f.dispatch(authorization, "developer");
  const args = { host, root: f.root, authorizationId: authorization.authorizationId, dispatchId: dispatch.dispatchId };
  const oldCall = enqueueWorkerAdmission({ ...args, signal: oldController.signal });
  await waitForCondition(() => readWorkerAdmissionProjection(args).state === "queued");
  const resumedCall = enqueueWorkerAdmission({ ...args, signal: newController.signal });
  await assert.rejects(() => oldCall, { code: "WORKER_ADMISSION_CANCELLED" });
  await waitForCondition(() => readWorkerAdmissionProjection(args).generation === 2);
  const beforeNewAbort = readWorkerAdmissionProjection(args);
  assert.equal(beforeNewAbort.state, "queued");
  assert.equal(beforeNewAbort.generation, 2);
  newController.abort();
  await assert.rejects(() => resumedCall, { code: "WORKER_ADMISSION_CANCELLED" });
  await holder.finalize({ outcomeCode: "test-release" });
});

test("a throwing detached validator releases its exact queue generation", async (t) => {
  const f = await fixture(t);
  const created = f.provision("validator-throw", {
    globalLimit: 2,
    perKeyLimit: 1,
    default: "hold-for-host-confirmation",
    maxQueued: 4,
    maxWaitMs: 5_000,
  });
  const failedAuthorization = f.authorization("codex", "fixture/key-a");
  const host = f.open(created, async ({ phase, authorizationId }) => {
    if (phase === "queued" && authorizationId === failedAuthorization.authorizationId) {
      const error = new Error("Fixture Host validation failed");
      error.code = "FIXTURE_HOST_VALIDATOR_THROW";
      throw error;
    }
    return { status: "current" };
  });
  const failedDispatch = f.dispatch(failedAuthorization);
  await assert.rejects(() => enqueueWorkerAdmission({
    host,
    root: f.root,
    authorizationId: failedAuthorization.authorizationId,
    dispatchId: failedDispatch.dispatchId,
    mode: "detached",
  }), { code: "FIXTURE_HOST_VALIDATOR_THROW" });
  assert.equal(readWorkerAdmissionProjection({
    host,
    root: f.root,
    authorizationId: failedAuthorization.authorizationId,
  }).state, "cancelled");
  const nextAuthorization = f.authorization("codex", "fixture/key-b");
  const next = await enqueueWorkerAdmission({
    host,
    root: f.root,
    authorizationId: nextAuthorization.authorizationId,
    dispatchId: f.dispatch(nextAuthorization, "developer").dispatchId,
  });
  assert.equal(next.generation, 1);
  await next.finalize({ outcomeCode: "test-release" });
});

test("intermediate links cannot redirect Host admission state into the project", async (t) => {
  const f = await fixture(t);
  const projectTarget = path.join(f.root, f.directory, "host-state-fixture");
  fs.mkdirSync(projectTarget);
  const redirectedBase = path.join(f.admissionOperationalRoot, "worker-admission");
  fs.symlinkSync(projectTarget, redirectedBase, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => f.provision("junction-provision"), { code: "WORKER_ADMISSION_PATH_ESCAPE" });
  assert.equal(fs.readdirSync(projectTarget).length, 0);
  fs.unlinkSync(redirectedBase);

  const created = f.provision("junction-after-open");
  const host = f.open(created);
  const savedBase = path.join(f.container, "saved-worker-admission");
  fs.renameSync(redirectedBase, savedBase);
  fs.symlinkSync(projectTarget, redirectedBase, process.platform === "win32" ? "junction" : "dir");
  const authorization = f.authorization("codex");
  f.dispatch(authorization);
  const projection = readWorkerAdmissionProjection({ host, root: f.root, authorizationId: authorization.authorizationId });
  assert.equal(projection.availability, "unavailable");
  assert.equal(projection.state, "unknown-blocking");
  assert.equal(fs.readdirSync(projectTarget).length, 0);
  fs.unlinkSync(redirectedBase);
  fs.renameSync(savedBase, redirectedBase);
});

test("consumed release without descendant cleanup proof retains capacity", async (t) => {
  const f = await fixture(t);
  const created = f.provision("unproven-cleanup");
  const host = f.open(created);
  const authorization = f.authorization("codex");
  const dispatch = f.dispatch(authorization);
  const reservation = await enqueueWorkerAdmission({
    host,
    root: f.root,
    authorizationId: authorization.authorizationId,
    dispatchId: dispatch.dispatchId,
  });
  const ownerFenceDigest = hash("unproven-cleanup-owner");
  const leased = await withRuntimeExecutionLease({ projectRoot: f.root, authorization, ownerFenceDigest }, async ({ consumption }) => ({
    receipt: buildRuntimeInvocationLifecycleReceipt({
      authorization,
      events: [],
      consumption,
      status: "failed",
      exitCode: 1,
      signal: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutDigest: hash(""),
      stderrDigest: hash(""),
      callerFenceDigest: ownerFenceDigest,
      childFenceDigest: hash("unproven-cleanup-child"),
      childStarted: true,
      childExitObserved: true,
      terminationRequested: false,
      projectFenceValidated: true,
      inputDigestObserved: hash(""),
      noDescendantFixture: false,
      descendantTreeOwnershipValidated: false,
      providerMode: "codex-protocol-fixture",
      supervision: {
        supervisionMode: "native-process-tree",
        supervisionStrategy: process.platform === "win32" ? "windows-job-object" : "posix-process-group",
        supervisorManifestDigest: hash("test-only-supervisor-manifest"),
        ownershipEstablished: true,
        providerChildStarted: true,
        providerChildExitObserved: false,
        treeCleanupAttempted: false,
        treeCleanupVerified: false,
      },
    }),
  }), { preConsumeGate: reservation.preConsumeGate });
  const draft = buildRuntimeResultPacketDraft({ authorization, receipt: leased.result.receipt, leaseRelease: leased.release });
  persistRuntimeInvocationRecord({ projectRoot: f.root, authorization, events: [], receipt: leased.result.receipt, draft });
  await assert.rejects(() => reservation.finalize({ outcomeCode: "failed" }), { code: "WORKER_ADMISSION_RELEASE_EVIDENCE_MISSING" });
  const controller = new AbortController();
  const nextAuthorization = f.authorization("codex");
  let nextReserved = false;
  const next = enqueueWorkerAdmission({
    host,
    root: f.root,
    authorizationId: nextAuthorization.authorizationId,
    dispatchId: f.dispatch(nextAuthorization, "developer").dispatchId,
    signal: controller.signal,
  }).then((held) => {
    nextReserved = true;
    return held;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(nextReserved, false);
  controller.abort();
  await assert.rejects(() => next, { code: "WORKER_ADMISSION_CANCELLED" });
  assert.equal(readWorkerAdmissionProjection({ host, root: f.root, authorizationId: authorization.authorizationId }).state, "capacity-reserved");
});

test("storage redirected during final Host validation is rejected before consumption", async (t) => {
  const f = await fixture(t);
  const created = f.provision("validation-path-swap");
  let enteredValidation;
  let releaseValidation;
  const validationEntered = new Promise((resolve) => { enteredValidation = resolve; });
  const validationRelease = new Promise((resolve) => { releaseValidation = resolve; });
  const host = f.open(created, async ({ phase }) => {
    if (phase === "pre-consume") {
      enteredValidation();
      await validationRelease;
    }
    return { status: "current" };
  });
  const authorization = f.authorization("codex");
  const reservation = await enqueueWorkerAdmission({
    host,
    root: f.root,
    authorizationId: authorization.authorizationId,
    dispatchId: f.dispatch(authorization).dispatchId,
  });
  let operationCalls = 0;
  const execution = withRuntimeExecutionLease({
    projectRoot: f.root,
    authorization,
    ownerFenceDigest: hash("validation-path-swap-owner"),
  }, async () => { operationCalls += 1; }, { preConsumeGate: reservation.preConsumeGate });
  await validationEntered;
  const eventRoot = path.join(f.admissionOperationalRoot, "worker-admission", "domains", created.admissionDomainId, "events");
  const redirected = path.join(f.root, f.directory, "redirected-admission-events");
  fs.renameSync(eventRoot, redirected);
  fs.symlinkSync(redirected, eventRoot, process.platform === "win32" ? "junction" : "dir");
  releaseValidation();
  await assert.rejects(() => execution, { code: "WORKER_ADMISSION_PATH_ESCAPE" });
  const wroteRedirectedStart = fs.existsSync(path.join(redirected, "0000000003.json"));
  const unavailable = readWorkerAdmissionProjection({ host, root: f.root, authorizationId: authorization.authorizationId });
  fs.unlinkSync(eventRoot);
  fs.renameSync(redirected, eventRoot);
  fs.rmSync(path.join(path.dirname(eventRoot), "domain.lock"), { recursive: true });
  assert.equal(wroteRedirectedStart, false);
  assert.equal(unavailable.availability, "unavailable");
  assert.equal(unavailable.state, "unknown-blocking");
  assert.equal(operationCalls, 0);
  assert.equal(inspectRuntimeExecutionLease({
    projectRoot: f.root,
    storage: f.storage,
    projectId: authorization.projectId,
    authorizationId: authorization.authorizationId,
  }).singleUseConsumed, false);
  await reservation.finalize({ outcomeCode: "test-release" });
});

test("unsafe domain replacement cannot redirect lock cleanup into the project", async (t) => {
  const f = await fixture(t);
  const created = f.provision("validation-domain-swap");
  let enteredValidation;
  let releaseValidation;
  const validationEntered = new Promise((resolve) => { enteredValidation = resolve; });
  const validationRelease = new Promise((resolve) => { releaseValidation = resolve; });
  const host = f.open(created, async ({ phase }) => {
    if (phase === "pre-consume") {
      enteredValidation();
      await validationRelease;
    }
    return { status: "current" };
  });
  const authorization = f.authorization("codex");
  const reservation = await enqueueWorkerAdmission({
    host,
    root: f.root,
    authorizationId: authorization.authorizationId,
    dispatchId: f.dispatch(authorization).dispatchId,
  });
  let operationCalls = 0;
  const execution = withRuntimeExecutionLease({
    projectRoot: f.root,
    authorization,
    ownerFenceDigest: hash("validation-domain-swap-owner"),
  }, async () => { operationCalls += 1; }, { preConsumeGate: reservation.preConsumeGate });
  await validationEntered;
  const domainRoot = path.join(f.admissionOperationalRoot, "worker-admission", "domains", created.admissionDomainId);
  const redirected = path.join(f.root, f.directory, "redirected-admission-domain");
  fs.renameSync(domainRoot, redirected);
  fs.symlinkSync(redirected, domainRoot, process.platform === "win32" ? "junction" : "dir");
  releaseValidation();
  await assert.rejects(() => execution, { code: "WORKER_ADMISSION_PATH_ESCAPE" });
  assert.equal(operationCalls, 0);
  assert.equal(fs.existsSync(path.join(redirected, "events", "0000000003.json")), false);
  assert.equal(fs.existsSync(path.join(redirected, "domain.lock")), true, "unsafe cleanup must not follow the junction");
  const unavailable = readWorkerAdmissionProjection({ host, root: f.root, authorizationId: authorization.authorizationId });
  assert.equal(unavailable.availability, "unavailable");
  assert.equal(inspectRuntimeExecutionLease({
    projectRoot: f.root,
    storage: f.storage,
    projectId: authorization.projectId,
    authorizationId: authorization.authorizationId,
  }).singleUseConsumed, false);
  fs.unlinkSync(domainRoot);
  fs.rmSync(path.join(redirected, "domain.lock"), { recursive: true });
  fs.renameSync(redirected, domainRoot);
  await reservation.finalize({ outcomeCode: "test-release" });
});

test("a displaced lock owner cannot delete a later live lock at the same safe path", async (t) => {
  const f = await fixture(t);
  const created = f.provision("displaced-lock-owner");
  let enterA;
  let resumeA;
  let enterB;
  let resumeB;
  let cancelB = false;
  const enteredA = new Promise((resolve) => { enterA = resolve; });
  const releasedA = new Promise((resolve) => { resumeA = resolve; });
  const enteredB = new Promise((resolve) => { enterB = resolve; });
  const releasedB = new Promise((resolve) => { resumeB = resolve; });
  const hostA = f.open(created, async ({ phase }) => {
    if (phase === "pre-consume") {
      enterA();
      await releasedA;
    }
    return { status: "current" };
  });
  const hostB = f.open(created, async ({ phase }) => {
    if (phase === "queued") {
      enterB();
      await releasedB;
      if (cancelB) return { status: "cancelled" };
    }
    return { status: "current" };
  });
  const authorizationA = f.authorization("codex");
  const authorizationB = f.authorization("codex");
  const reservationA = await enqueueWorkerAdmission({
    host: hostA,
    root: f.root,
    authorizationId: authorizationA.authorizationId,
    dispatchId: f.dispatch(authorizationA).dispatchId,
  });
  let operationCalls = 0;
  const executionA = withRuntimeExecutionLease({
    projectRoot: f.root,
    authorization: authorizationA,
    ownerFenceDigest: hash("displaced-lock-owner-fence"),
  }, async () => { operationCalls += 1; }, { preConsumeGate: reservationA.preConsumeGate });
  await enteredA;
  const lockPath = path.join(f.admissionOperationalRoot, "worker-admission", "domains", created.admissionDomainId, "domain.lock");
  const displaced = path.join(f.container, "displaced-original-domain.lock");
  const firstLockId = String(fs.statSync(lockPath, { bigint: true }).ino);
  fs.renameSync(lockPath, displaced);
  const authorizationBDispatch = f.dispatch(authorizationB, "developer");
  const pendingB = enqueueWorkerAdmission({
    host: hostB,
    root: f.root,
    authorizationId: authorizationB.authorizationId,
    dispatchId: authorizationBDispatch.dispatchId,
    mode: "detached",
  });
  await enteredB;
  const secondLockId = String(fs.statSync(lockPath, { bigint: true }).ino);
  resumeA();
  await assert.rejects(() => executionA, { code: "WORKER_ADMISSION_LOCK_OWNERSHIP_LOST" });
  assert.notEqual(firstLockId, secondLockId);
  assert.equal(fs.existsSync(lockPath), true, "stale cleanup must preserve the later caller's live lock");
  assert.equal(fs.existsSync(displaced), true, "the displaced original remains explicit Host recovery state");
  assert.equal(operationCalls, 0);
  assert.equal(inspectRuntimeExecutionLease({
    projectRoot: f.root,
    storage: f.storage,
    projectId: authorizationA.projectId,
    authorizationId: authorizationA.authorizationId,
  }).singleUseConsumed, false);
  cancelB = true;
  resumeB();
  await assert.rejects(() => pendingB, { code: "WORKER_ADMISSION_CANCELLED" });
  assert.equal(fs.existsSync(lockPath), false, "the current owner removes its own lock on cancellation");
  fs.rmSync(displaced, { recursive: true });
  await reservationA.finalize({ outcomeCode: "test-release" });
  assert.equal(fs.existsSync(lockPath), false, "normal finalize removes its own lock");
});

test("an authorization consumed before first admission creates no request or capacity leak", async (t) => {
  const f = await fixture(t);
  const authorization = f.authorization("codex");
  const dispatch = f.dispatch(authorization);
  await withRuntimeExecutionLease({
    projectRoot: f.root,
    authorization,
    ownerFenceDigest: hash("consumed-before-admission-owner"),
  }, async () => ({}));
  const created = f.provision("consumed-before-admission", {
    globalLimit: 1,
    perKeyLimit: 1,
    default: "hold-for-host-confirmation",
    maxQueued: 4,
    maxWaitMs: 1_000,
  });
  const host = f.open(created);
  await assert.rejects(() => enqueueWorkerAdmission({
    host,
    root: f.root,
    authorizationId: authorization.authorizationId,
    dispatchId: dispatch.dispatchId,
  }), { code: "WORKER_ADMISSION_AUTHORIZATION_ALREADY_CONSUMED" });
  assert.equal(readWorkerAdmissionProjection({
    host,
    root: f.root,
    authorizationId: authorization.authorizationId,
  }).state, "not-requested");
  const eventRoot = path.join(f.admissionOperationalRoot, "worker-admission", "domains", created.admissionDomainId, "events");
  assert.equal(fs.readdirSync(eventRoot).length, 0);
  const nextAuthorization = f.authorization("codex");
  const next = await enqueueWorkerAdmission({
    host,
    root: f.root,
    authorizationId: nextAuthorization.authorizationId,
    dispatchId: f.dispatch(nextAuthorization, "developer").dispatchId,
  });
  await next.finalize({ outcomeCode: "test-release" });
});

test("external consumption during queued resume creates no new generation or reservation", async (t) => {
  const f = await fixture(t);
  const created = f.provision("consumed-during-resume", {
    globalLimit: 1,
    perKeyLimit: 1,
    default: "hold-for-host-confirmation",
    maxQueued: 4,
    maxWaitMs: 5_000,
  });
  let enteredResume;
  let releaseResume;
  const resumeEntered = new Promise((resolve) => { enteredResume = resolve; });
  const resumeRelease = new Promise((resolve) => { releaseResume = resolve; });
  const host = f.open(created, async ({ phase }) => {
    if (phase === "resume") {
      enteredResume();
      await resumeRelease;
      return { status: "current", resume: true };
    }
    return { status: "current" };
  });
  const holderAuthorization = f.authorization("codex", "fixture/resume-capacity");
  const holder = await enqueueWorkerAdmission({
    host,
    root: f.root,
    authorizationId: holderAuthorization.authorizationId,
    dispatchId: f.dispatch(holderAuthorization).dispatchId,
  });
  const authorization = f.authorization("codex", "fixture/resume-capacity");
  const dispatch = f.dispatch(authorization, "developer");
  const args = { host, root: f.root, authorizationId: authorization.authorizationId, dispatchId: dispatch.dispatchId };
  const original = enqueueWorkerAdmission(args);
  await waitForCondition(() => readWorkerAdmissionProjection(args).state === "queued");
  const resumed = enqueueWorkerAdmission(args);
  await resumeEntered;
  await withRuntimeExecutionLease({
    projectRoot: f.root,
    authorization,
    ownerFenceDigest: hash("consumed-during-resume-owner"),
  }, async () => ({}));
  releaseResume();
  await assert.rejects(() => resumed, { code: "WORKER_ADMISSION_AUTHORIZATION_ALREADY_CONSUMED" });
  await assert.rejects(() => original, { code: "WORKER_ADMISSION_STALE_REQUEST" });
  const eventRoot = path.join(f.admissionOperationalRoot, "worker-admission", "domains", created.admissionDomainId, "events");
  const requestEvents = fs.readdirSync(eventRoot).sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(eventRoot, name), "utf8")))
    .filter((event) => event.authorizationId === authorization.authorizationId);
  assert.deepEqual(requestEvents.map((event) => event.eventType), ["queued", "cancelled"]);
  assert.equal(readWorkerAdmissionProjection(args).state, "cancelled");
  await holder.finalize({ outcomeCode: "test-release" });
  const nextAuthorization = f.authorization("codex", "fixture/resume-capacity");
  const next = await enqueueWorkerAdmission({
    host,
    root: f.root,
    authorizationId: nextAuthorization.authorizationId,
    dispatchId: f.dispatch(nextAuthorization, "reviewer").dispatchId,
  });
  await next.finalize({ outcomeCode: "test-release" });
});

test("queued Host validation cannot reserve after the original deadline", async (t) => {
  const f = await fixture(t);
  const created = f.provision("deadline-after-queued-validation", {
    globalLimit: 1,
    perKeyLimit: 1,
    default: "hold-for-host-confirmation",
    maxQueued: 4,
    maxWaitMs: 1_000,
  });
  const host = f.open(created, async ({ phase }) => {
    if (phase === "queued") await new Promise((resolve) => setTimeout(resolve, 1_100));
    return { status: "current" };
  });
  const authorization = f.authorization("codex", "fixture/deadline-key");
  const args = {
    host,
    root: f.root,
    authorizationId: authorization.authorizationId,
    dispatchId: f.dispatch(authorization).dispatchId,
    mode: "detached",
  };
  await assert.rejects(() => enqueueWorkerAdmission(args), { code: "WORKER_ADMISSION_EXPIRED" });
  assert.equal(readWorkerAdmissionProjection(args).state, "expired");
  assert.equal(inspectRuntimeExecutionLease({
    projectRoot: f.root,
    storage: f.storage,
    projectId: authorization.projectId,
    authorizationId: authorization.authorizationId,
  }).singleUseConsumed, false);
  const nextAuthorization = f.authorization("codex", "fixture/deadline-key");
  const next = await enqueueWorkerAdmission({
    host: f.open(created),
    root: f.root,
    authorizationId: nextAuthorization.authorizationId,
    dispatchId: f.dispatch(nextAuthorization, "developer").dispatchId,
  });
  await next.finalize({ outcomeCode: "test-release" });
});

test("resume validation preserves and enforces the original queue deadline", async (t) => {
  const f = await fixture(t);
  const created = f.provision("deadline-after-resume-validation", {
    globalLimit: 1,
    perKeyLimit: 1,
    default: "hold-for-host-confirmation",
    maxQueued: 4,
    maxWaitMs: 1_000,
  });
  const host = f.open(created, async ({ phase }) => {
    if (phase === "resume") await new Promise((resolve) => setTimeout(resolve, 1_100));
    return { status: "current", resume: phase === "resume" };
  });
  const holderAuthorization = f.authorization("codex", "fixture/resume-deadline-key");
  const holder = await enqueueWorkerAdmission({
    host,
    root: f.root,
    authorizationId: holderAuthorization.authorizationId,
    dispatchId: f.dispatch(holderAuthorization).dispatchId,
  });
  const authorization = f.authorization("codex", "fixture/resume-deadline-key");
  const dispatch = f.dispatch(authorization, "developer");
  const args = { host, root: f.root, authorizationId: authorization.authorizationId, dispatchId: dispatch.dispatchId };
  const original = enqueueWorkerAdmission(args);
  await waitForCondition(() => readWorkerAdmissionProjection(args).state === "queued");
  const resumed = enqueueWorkerAdmission(args);
  await assert.rejects(() => resumed, { code: "WORKER_ADMISSION_EXPIRED" });
  await assert.rejects(() => original, { code: "WORKER_ADMISSION_EXPIRED" });
  const eventRoot = path.join(f.admissionOperationalRoot, "worker-admission", "domains", created.admissionDomainId, "events");
  const requestEvents = fs.readdirSync(eventRoot).sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(eventRoot, name), "utf8")))
    .filter((event) => event.authorizationId === authorization.authorizationId);
  assert.deepEqual(requestEvents.map((event) => event.eventType), ["queued", "expired"]);
  assert.equal(readWorkerAdmissionProjection(args).state, "expired");
  await holder.finalize({ outcomeCode: "test-release" });
});

test("a reserved restart cannot open a new generation after its original deadline", async (t) => {
  const f = await fixture(t);
  const created = f.provision("reserved-restart-deadline", {
    globalLimit: 1,
    perKeyLimit: 1,
    default: "hold-for-host-confirmation",
    maxQueued: 4,
    maxWaitMs: 1_000,
  });
  const host = f.open(created, async ({ phase }) => ({ status: "current", resume: phase === "resume" }));
  const authorization = f.authorization("codex", "fixture/reserved-restart-deadline");
  const dispatch = f.dispatch(authorization);
  const args = { host, root: f.root, authorizationId: authorization.authorizationId, dispatchId: dispatch.dispatchId };
  await enqueueWorkerAdmission(args);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await assert.rejects(() => enqueueWorkerAdmission(args), { code: "WORKER_ADMISSION_EXPIRED" });
  const eventRoot = path.join(f.admissionOperationalRoot, "worker-admission", "domains", created.admissionDomainId, "events");
  const requestEvents = fs.readdirSync(eventRoot).sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(eventRoot, name), "utf8")))
    .filter((event) => event.authorizationId === authorization.authorizationId);
  assert.deepEqual(requestEvents.map((event) => event.eventType), ["queued", "reserved", "expired"]);
  assert.deepEqual(requestEvents.map((event) => event.generation), [1, 1, 1]);
  assert.equal(readWorkerAdmissionProjection(args).state, "expired");
  const nextAuthorization = f.authorization("codex", "fixture/reserved-restart-deadline");
  const next = await enqueueWorkerAdmission({
    host,
    root: f.root,
    authorizationId: nextAuthorization.authorizationId,
    dispatchId: f.dispatch(nextAuthorization, "developer").dispatchId,
  });
  await next.finalize({ outcomeCode: "test-release" });
});
