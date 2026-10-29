import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeProject, inspectProject } from "../../scripts/lib/head-core.mjs";
import { formatForVerifiedOwner } from "../../scripts/lib/project-storage-format.mjs";
import { compileContext } from "../../scripts/lib/context-compiler.mjs";
import { createExecutionContract, createWholePlanSnapshot } from "../../scripts/lib/execution-lineage.mjs";
import { startRun } from "../../scripts/lib/run-lineage.mjs";
import { artifactAuthorityBoundary } from "../../scripts/lib/authority-plane-contract.mjs";
import { buildRuntimeVersionEvidence } from "../../scripts/lib/runtime-machine-execution.mjs";
import { buildRuntimeProjectBinding, buildRuntimeProtocolEvidence } from "../../scripts/lib/runtime-protocol-evidence.mjs";
import { buildRuntimeInvocationAuthorization, buildRuntimeInvocationLifecycleReceipt, buildRuntimeResultPacketDraft, normalizeRuntimeEvent } from "../../scripts/lib/runtime-invocation-lifecycle.mjs";
import { withRuntimeExecutionLease, RUNTIME_OPERATIONAL_STATE_ENV } from "../../scripts/lib/runtime-execution-lease.mjs";
import { readRuntimeInvocationRecord } from "../../scripts/lib/runtime-invocation-record.mjs";
import { createFixturePublicationDiagnostics } from "./invocation-publication-diagnostics.mjs";
import { createBoundedWorkerDispatch } from "../../scripts/lib/bounded-worker-dispatch.mjs";
import { captureWorkerSourceBasis } from "../../scripts/lib/worker-source-basis.mjs";
import { captureWorkerWriteBasis, buildWorkerPatchCandidate } from "../../scripts/lib/worker-patch-basis.mjs";
import { composeWorkerPatchCandidates } from "../../scripts/lib/worker-patch-composition.mjs";
import { prepareWorkerWorkspace, workerExecutionBoundary } from "../../scripts/lib/worker-workspace.mjs";
import { workerMemberKey } from "../../scripts/lib/worker-member-registry.mjs";
import { verifyWorkerPatchIntegrationIntent, readWorkerPatchIntegration } from "../../scripts/lib/worker-patch-integration.mjs";
import { readWorkerIntegrationBasis } from "../../scripts/lib/worker-integration-basis.mjs";
import { integrationDigest as hash, integrationJson as json, workerIntegrationDirectory, publishIntegrationJson } from "../../scripts/lib/worker-integration-store.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "../..");
const defaults = [{ path: "a.txt", after: null }, { path: "b.txt", after: null }];
const flags = { instructionAuthority: false, promotionAuthority: false, recoveryAuthority: false, reviewDecisionCreated: false, mutatesCanon: false };
const operationalOwners = [];

// Schema-only capability responses; no child or model is launched. Synthetic
// PID 1 is never observed, terminated, or claimed as an owned OS process.
function syntheticCapabilitySpawn(_command, args) {
  const output = args.join(" ") === "--version" ? "codex 1.2.3\n"
    : args.join(" ") === "--help" ? "exec\nmcp-server\napp-server\n"
      : args.join(" ") === "exec --help" ? "Run Codex non-interactively\n--json\n--output-schema\n--color\n--sandbox\n--skip-git-repo-check\n--cd\n--ephemeral\nresume\n"
        : "stdio://\ngenerate-json-schema\n--listen\n";
  const child = new EventEmitter();
  Object.assign(child, { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null });
  child.kill = () => { throw new Error("Schema fixture must never control a process"); };
  queueMicrotask(() => { child.stdout.emit("data", Buffer.from(output)); child.exitCode = 0; child.emit("close", 0, null); });
  return child;
}

export async function workerIntegrationFixture(t, options = {}) {
  const parent = fs.realpathSync(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const container = fs.mkdtempSync(path.join(parent, "head-worker-integration-"));
  const root = path.join(container, "project");
  const bin = path.join(container, "schema-capability");
  const operational = path.join(container, "operational");
  for (const directory of [root, bin, operational]) fs.mkdirSync(directory);
  const oldOperational = process.env[RUNTIME_OPERATIONAL_STATE_ENV];
  const owner = { operational, previous: oldOperational };
  operationalOwners.push(owner);
  process.env[RUNTIME_OPERATIONAL_STATE_ENV] = operational;
  t.after(() => {
    // Multiple fixtures may share one test's FIFO cleanup. Relink a later
    // fixture's restoration target so it cannot restore an already removed root.
    for (const other of operationalOwners) if (other.previous === operational) other.previous = owner.previous;
    operationalOwners.splice(operationalOwners.indexOf(owner), 1);
    if (process.env[RUNTIME_OPERATIONAL_STATE_ENV] === operational) {
      if (owner.previous === undefined) delete process.env[RUNTIME_OPERATIONAL_STATE_ENV];
      else process.env[RUNTIME_OPERATIONAL_STATE_ENV] = owner.previous;
    }
    assert.equal(path.dirname(container), parent);
    assert.match(path.basename(container), /^head-worker-integration-/);
    fs.rmSync(container, { recursive: true, force: true });
  });
  const publicationDiagnostics = createFixturePublicationDiagnostics(container, { sink: options.publicationDiagnosticSink });
  t.after(() => publicationDiagnostics.close());
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  const layout = formatForVerifiedOwner(storage);
  const capsule = (await compileContext({ root, task: "Verify a bounded synthetic whole worker integration", persist: true })).capsule;
  const plan = createWholePlanSnapshot({ root, objective: "Integrate exact worker evidence once", plan: [{ id: "integrate", outcome: "One reviewed whole result" }] }).artifact;
  const contract = createExecutionContract({ root, wholePlanId: plan.wholePlanId, capsuleId: capsule.capsuleId,
    scope: "Schema-only integration fixture", acceptanceCriteria: ["Preserve all worker provenance and exact Run"],
    allowedActions: ["runtime.invoke", "project.read", "project.write"] }).artifact;
  const run = startRun({ root, executionContractId: contract.executionContractId }).run;
  const executable = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(executable, "Schema fixture only; never executed\n");
  if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
  const environment = { ...process.env, PATH: bin }; delete environment.Path; delete environment.path;
  const versionEvidence = await buildRuntimeVersionEvidence({ runtimes: ["codex"], environment, spawnImplementation: syntheticCapabilitySpawn });
  const protocolEvidence = await buildRuntimeProtocolEvidence({ runtimes: ["codex"], environment, versionEvidence, spawnImplementation: syntheticCapabilitySpawn });
  let generation = 0;
  function ensureSource(relative, content, mode) {
    if (content === null) return;
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, content);
      if (mode !== undefined) fs.chmodSync(file, mode);
    }
  }
  async function addIntegration({ workers = defaults, readDependencies = [] } = {}) {
    const serial = generation++;
    const selected = workers.map((worker, index) => ({ path: `source-${index}.txt`, after: null, ...worker }));
    const readPaths = readDependencies.map(entry => typeof entry === "string" ? entry : entry.path);
    for (const entry of readDependencies) ensureSource(typeof entry === "string" ? entry : entry.path,
      typeof entry === "string" ? "shared dependency\n" : entry.before ?? "shared dependency\n");
    for (const worker of selected) ensureSource(worker.path, worker.before === undefined ? `original ${worker.path}\n` : worker.before, worker.beforeMode);
    const inspected = inspectProject(root);
    const projectBinding = buildRuntimeProjectBinding({ projectId: inspected.project.projectId, headSessionId: inspected.state.sessionId,
      projectRoot: fs.realpathSync(root), projectStatus: "ready", versionEvidence, protocolEvidence, storage });
    const records = [];
    for (const [index, worker] of selected.entries()) {
      const maxBytes = 1024 * 1024;
      const sourcePaths = [...new Set([...(fs.existsSync(path.join(root, worker.path)) ? [worker.path] : []), ...readPaths])].sort();
      const sourceBasis = captureWorkerSourceBasis({ root, paths: sourcePaths, maxBytes });
      const writeBasis = captureWorkerWriteBasis({ root, paths: [worker.path], maxBytes });
      const binding = prepareWorkerWorkspace({ projectRoot: root, workspaceRoot: path.join(container, `worker-${serial}-${index}`), sourceBasis, maxBytes });
      const boundary = workerExecutionBoundary({ binding, policy: { fixtureOnly: true }, sourceBasis, ownedPaths: [worker.path], writeBasis });
      const authorization = buildRuntimeInvocationAuthorization({ root, runtime: "codex", workspaceMode: "workspace-write", scope: { kind: "run" },
        protocolEvidence, projectBinding, limits: { maxInputBytes: maxBytes },
        worker: { taskKey: `integration-${serial}-${index}`, role: "coder", outcome: "Schema fixture contribution", selectedContext: "No provider executed",
          sourcePaths, executionBoundary: boundary } }).authorization;
      const { dispatch } = createBoundedWorkerDispatch({ root, authorizationId: authorization.authorizationId, role: "coder" });
      const events = [normalizeRuntimeEvent({ authorization, sequence: 0, line: JSON.stringify({ type: "turn.completed", fixtureOnly: true }) })];
      const leased = await withRuntimeExecutionLease({ projectRoot: root, authorization, ownerFenceDigest: hash(`schema-fixture-${serial}-${index}`) }, async ({ consumption }) => ({
        receipt: buildRuntimeInvocationLifecycleReceipt({ authorization, consumption, events, status: "completed", exitCode: 0, signal: "",
          stdoutBytes: 0, stderrBytes: 0, stdoutDigest: hash(""), stderrDigest: hash(""), callerFenceDigest: hash("fixture caller"),
          childFenceDigest: hash("fixture child"), childStarted: true, childExitObserved: true, terminationRequested: false,
          projectFenceValidated: true, inputDigestObserved: authorization.executionInput.digest, noDescendantFixture: true,
          descendantTreeOwnershipValidated: true, providerMode: "conformance-fixture" }) }));
      const receipt = leased.result.receipt;
      const draft = buildRuntimeResultPacketDraft({ authorization, receipt, leaseRelease: leased.release });
      publicationDiagnostics.publish({ projectRoot: root, storage, authorization, events, receipt, draft }, { generation: serial, workerIndex: index });
      const candidate = buildWorkerPatchCandidate({ basis: writeBasis, maxBytes,
        changes: worker.remove ? [{ path: worker.path, after: null }] : worker.after === null ? []
          : [{ path: worker.path, after: { mode: worker.afterMode ?? (writeBasis[0].kind === "file" ? writeBasis[0].mode : 0o600),
            contentBase64: Buffer.from(worker.after).toString("base64") } }] });
      const member = { authorizationId: authorization.authorizationId, authorizationHash: authorization.authorizationHash,
        inputDigest: authorization.executionInput.digest, memberKey: workerMemberKey(authorization), dispatchId: dispatch.dispatchId,
        dispatchHash: dispatch.dispatchHash, lifecycleReceiptId: receipt.receiptId, draftId: draft.draftId,
        executionLeaseConsumptionId: draft.executionLeaseConsumptionId, executionLeaseReleaseId: draft.executionLeaseReleaseId,
        actualProviderInvoked: false, candidate };
      records.push({ ...readRuntimeInvocationRecord({ root, authorizationId: authorization.authorizationId, storage }), member, candidate, binding });
    }
    records.sort((a, b) => a.authorizationId < b.authorizationId ? -1 : a.authorizationId > b.authorizationId ? 1 : 0);
    const first = records[0].authorization;
    const lineage = { projectId: first.projectId, projectRootDigest: first.projectRootDigest, [layout.sessionIdField]: first[layout.sessionIdField],
      runId: first.scope.runId, wholePlanId: first.scope.wholePlanId, executionContractId: first.scope.executionContractId, contextCapsuleId: first.scope.contextCapsuleId };
    const members = records.map(record => record.member);
    const composition = composeWorkerPatchCandidates({ candidates: members.map(member => member.candidate), maxBytes: Number.MAX_SAFE_INTEGER });
    const payload = { kind: "WorkerPatchIntegrationIntent", protocolVersion: "0.1.0", authorityBoundary: artifactAuthorityBoundary("WorkerPatchIntegrationIntent"), lineage, members, composition, ...flags };
    const integrationHash = hash(json(payload));
    const integrationId = `worker-integration-${hash(json(members.map(member => member.authorizationId))).slice(0, 24)}--${integrationHash.slice(0, 24)}`;
    const intent = verifyWorkerPatchIntegrationIntent({ ...payload, integrationId, integrationHash });
    publishIntegrationJson(path.join(workerIntegrationDirectory(root, true, storage), `${integrationId}.json`), intent);
    assert.deepEqual(readWorkerPatchIntegration({ root, integrationId, storage }).intent, intent);
    return { intent, integrationId, members, records, readBasis: () => readWorkerIntegrationBasis({ root, integrationId, storage }) };
  }
  const integration = await addIntegration(options);
  return { root: fs.realpathSync(root), storage, layout, container, operational, run, plan, contract, capsule, ...integration, addIntegration,
    sessionFile: path.join(root, layout.directory, "sessions/current.json"), runFile: path.join(root, layout.directory, "sessions/runs", run.runId, "run.json") };
}
