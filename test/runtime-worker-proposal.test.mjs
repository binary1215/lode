import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/session/lode-core.mjs";
import { buildRuntimeVersionEvidence } from "../scripts/lib/runtime/runtime-machine-execution.mjs";
import { buildRuntimeProtocolEvidence, buildRuntimeProjectBinding } from "../scripts/lib/runtime/runtime-protocol-evidence.mjs";
import {
  buildRuntimeInvocationAuthorization,
  verifyRuntimeInvocationAuthorization,
  prepareRuntimeInvocationExecution,
  verifyRuntimeStructuredResult,
  buildRuntimeInvocationLifecycleReceipt,
  buildRuntimeResultPacketDraft,
  verifyRuntimeResultPacketDraft,
  normalizeRuntimeEvent,
} from "../scripts/lib/runtime/runtime-invocation-lifecycle.mjs";
import { captureWorkerSourceBasis } from "../scripts/lib/worker/worker-source-basis.mjs";
import { captureWorkerWriteBasis, buildWorkerPatchCandidate } from "../scripts/lib/worker/worker-patch-basis.mjs";
import { prepareWorkerWorkspace, workerExecutionBoundary } from "../scripts/lib/worker/worker-workspace.mjs";
import { workerPatchProposalExecutionBoundary, buildWorkerPatchProposalCandidate } from "../scripts/lib/worker/worker-patch-proposal.mjs";
import { withRuntimeExecutionLease, RUNTIME_OPERATIONAL_STATE_ENV } from "../scripts/lib/runtime/runtime-execution-lease.mjs";
import { persistRuntimeInvocationRecord, readRuntimeInvocationRecord } from "../scripts/lib/runtime/runtime-invocation-record.mjs";

console.log(
  JSON.stringify({
    event: "owned-runtime-worker-proposal-test",
    pid: process.pid,
    parentPid: process.ppid,
    command: process.execPath,
    args: process.argv.slice(1),
    cwd: process.cwd(),
    ports: [],
    actualProviderInvoked: false,
  }),
);
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const json = (value) => JSON.stringify(canonical(value));
const maxBytes = 1024 * 1024;
const image = (content, mode = 0o600) => ({ contentBase64: Buffer.from(content).toString("base64"), mode });
const copy = (value) => structuredClone(value);
function reidentify(document, prefix, idKey, hashKey) {
  const payload = { ...document };
  delete payload[idKey];
  delete payload[hashKey];
  const digest = hash(json(payload));
  return { ...payload, [idKey]: `${prefix}-${digest.slice(0, 24)}`, [hashKey]: digest };
}
// Schema-only capability answers: no OS child, provider, model or native effect.
function capabilitySpawn(_command, args) {
  const output =
    args.join(" ") === "--version"
      ? "codex 1.2.3\n"
      : args.join(" ") === "--help"
        ? "exec\nmcp-server\napp-server\n"
        : args.join(" ") === "exec --help"
          ? "Run Codex non-interactively\n--json\n--output-schema\n--color\n--sandbox\n--skip-git-repo-check\n--cd\n--ephemeral\nresume\n"
          : "stdio://\ngenerate-json-schema\n--listen\n";
  const child = new EventEmitter();
  Object.assign(child, { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null });
  child.kill = () => {
    throw new Error("Schema fixture has no process to control");
  };
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(output));
    child.exitCode = 0;
    child.emit("close", 0, null);
  });
  return child;
}
async function fixture(t) {
  const parent = fs.realpathSync(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const container = fs.mkdtempSync(path.join(parent, "head-runtime-proposal-"));
  const root = path.join(container, "project"),
    bin = path.join(container, "bin"),
    operational = path.join(container, "operational");
  for (const directory of [root, bin, operational]) fs.mkdirSync(directory);
  const prior = process.env[RUNTIME_OPERATIONAL_STATE_ENV];
  process.env[RUNTIME_OPERATIONAL_STATE_ENV] = operational;
  t.after(() => {
    if (prior === undefined) delete process.env[RUNTIME_OPERATIONAL_STATE_ENV];
    else process.env[RUNTIME_OPERATIONAL_STATE_ENV] = prior;
    assert.equal(path.dirname(container), parent);
    assert.match(path.basename(container), /^head-runtime-proposal-/);
    fs.rmSync(container, { recursive: true, force: true });
  });
  initializeProject({ root, pluginRoot: path.resolve(import.meta.dirname, ".."), runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  assert.equal(storage.directory, ".lode");
  assert.equal(fs.existsSync(path.resolve(root, ".lode/project.json")), true);
  assert.equal(fs.existsSync(path.resolve(root, ".head/project.json")), false);
  for (const name of ["edit.txt", "delete.txt", "mode.txt"]) fs.writeFileSync(path.join(root, name), `original ${name}\n`);
  const executable = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(executable, "Synthetic capability fixture; never executed\n", { mode: 0o755 });
  const environment = { ...process.env, PATH: bin };
  delete environment.Path;
  delete environment.path;
  const versionEvidence = await buildRuntimeVersionEvidence({ runtimes: ["codex"], environment, spawnImplementation: capabilitySpawn });
  const protocolEvidence = await buildRuntimeProtocolEvidence({ runtimes: ["codex"], environment, versionEvidence, spawnImplementation: capabilitySpawn });
  const inspected = inspectProject(root);
  const projectBinding = buildRuntimeProjectBinding({
    storage,
    projectId: inspected.project.projectId,
    headSessionId: inspected.state.sessionId,
    projectRoot: fs.realpathSync(root),
    projectStatus: "ready",
    versionEvidence,
    protocolEvidence,
  });
  const sourcePaths = ["delete.txt", "edit.txt", "mode.txt"],
    proposalPaths = [...sourcePaths, "new.txt"];
  const sourceBasis = captureWorkerSourceBasis({ root, paths: sourcePaths, maxBytes });
  const proposalBasis = captureWorkerWriteBasis({ root, paths: proposalPaths, maxBytes });
  const binding = prepareWorkerWorkspace({ projectRoot: root, workspaceRoot: path.join(container, "selected"), sourceBasis, maxBytes });
  const boundary = workerPatchProposalExecutionBoundary({ binding, policy: { fixtureOnly: true, mode: "read-only" }, sourceBasis, proposalBasis });
  const request = "Propose selected changes without applying them";
  const options = {
    root,
    runtime: "codex",
    scope: { kind: "session", request },
    workspaceMode: "read-only",
    protocolEvidence,
    projectBinding,
    limits: { maxInputBytes: maxBytes },
    worker: {
      taskKey: "proposal",
      role: "coder",
      outcome: "Return an exact bounded patch proposal",
      selectedContext: "Schema fixture only",
      sourcePaths,
      proposalPaths,
      executionBoundary: boundary,
    },
  };
  const authorization = buildRuntimeInvocationAuthorization(options).authorization;
  const mode = proposalBasis.find((entry) => entry.path === "mode.txt");
  const result = {
    schemaVersion: 1,
    kind: "RuntimeStructuredResult",
    protocolVersion: "0.2.0",
    outcome: "Proposal only",
    evidence: ["Selected preimages"],
    planDelta: "",
    impactRadius: [],
    verification: ["Synthetic schema validation only"],
    unknowns: [],
    patchProposal: {
      proposalBasisDigest: boundary.proposalBasisDigest,
      changes: [
        { path: "edit.txt", after: image("proposed edit\n") },
        { path: "delete.txt", after: null },
        { path: "new.txt", after: image("proposed new\n") },
        { path: "mode.txt", after: { contentBase64: mode.contentBase64, mode: mode.mode ^ 0o100 } },
      ],
    },
  };
  return {
    storage,
    root,
    container,
    binding,
    sourceBasis,
    proposalBasis,
    boundary,
    options,
    authorization,
    result,
    input: { root, authorization, sessionRequest: request },
    session: path.join(root, storage.directory, "sessions/current.json"),
  };
}
async function record(f, { status = "completed", result = f.result, beforeReceipt } = {}) {
  const authorization = f.authorization;
  const events = [normalizeRuntimeEvent({ authorization, sequence: 0, line: JSON.stringify({ type: "turn.completed", fixtureOnly: true }) })];
  const leased = await withRuntimeExecutionLease(
    { projectRoot: f.root, authorization, ownerFenceDigest: hash("synthetic proposal owner") },
    async ({ consumption }) => {
      const args = {
        authorization,
        consumption,
        events,
        status,
        exitCode: status === "completed" ? 0 : 1,
        signal: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutDigest: hash(""),
        stderrDigest: hash(""),
        callerFenceDigest: hash("caller"),
        childFenceDigest: hash("child"),
        childStarted: true,
        childExitObserved: true,
        terminationRequested: false,
        projectFenceValidated: true,
        inputDigestObserved: authorization.executionInput.digest,
        noDescendantFixture: true,
        descendantTreeOwnershipValidated: true,
        providerMode: "conformance-fixture",
        structuredResult: result,
      };
      beforeReceipt?.(args);
      return { receipt: buildRuntimeInvocationLifecycleReceipt(args) };
    },
  );
  const receipt = leased.result.receipt;
  const draft = buildRuntimeResultPacketDraft({ authorization, receipt, leaseRelease: leased.release, providerResult: result });
  return { authorization, events, receipt, draft, leaseRelease: leased.release };
}

test("proposal authorization is read-only, exact preimages are evidence, and Core computes all four patch kinds", async (t) => {
  const f = await fixture(t),
    session = fs.readFileSync(f.session);
  const before = f.sourceBasis.map((entry) => fs.readFileSync(path.join(f.root, entry.path)));
  assert.equal(f.authorization.protocolVersion, "0.7.0");
  assert.equal(f.authorization.workspaceMode, "read-only");
  assert.deepEqual(f.authorization.requiredAllowedActions, ["runtime.invoke", "project.read"]);
  assert.deepEqual(f.authorization.workerInput.executionBoundary.ownedPaths, []);
  assert.equal(f.authorization.workerInput.writeBasis, undefined);
  const prepared = prepareRuntimeInvocationExecution(f.input);
  assert.deepEqual(prepared.executionInput.boundedWorker.proposalBasis, f.proposalBasis);
  assert.equal(hash(prepared.input), f.authorization.executionInput.digest);
  assert.equal(prepared.executionInput.returnContract.wireResultShape.protocolVersion, "0.2.0");
  assert.equal(prepared.executionInput.returnContract.wireResultShape.patchProposal.proposalBasisDigest, f.boundary.proposalBasisDigest);
  assert.ok(prepared.executionInput.returnContract.requiredSections.includes("patchProposal"));
  assert.equal(prepared.executionInput.returnContract.applyFiles, false);
  assert.deepEqual(prepared.executionInput.returnContract.fixedFields, { planDelta: "", impactRadius: [] });
  assert.match(prepared.executionInput.returnContract.scopeInstruction, /not a Run result/);
  const candidate = buildWorkerPatchProposalCandidate({ authorization: f.authorization, structuredResult: f.result });
  assert.deepEqual(candidate, buildWorkerPatchCandidate({ basis: f.proposalBasis, changes: f.result.patchProposal.changes, maxBytes }));
  assert.equal(candidate.patches.length, 4);
  assert.equal(candidate.instructionAuthority, false);
  assert.equal(candidate.recoveryAuthority, false);
  const r = await record(f);
  persistRuntimeInvocationRecord({ projectRoot: f.root, ...r });
  const loaded = readRuntimeInvocationRecord({ root: f.root, storage: f.storage, authorizationId: f.authorization.authorizationId });
  assert.deepEqual(loaded.draft.providerResult, f.result);
  assert.equal(loaded.receipt.providerBoundary.actualProviderInvoked, false);
  assert.deepEqual(fs.readFileSync(f.session), session);
  assert.deepEqual(
    f.sourceBasis.map((entry) => fs.readFileSync(path.join(f.root, entry.path))),
    before,
  );
  assert.equal(fs.existsSync(path.join(f.root, "new.txt")), false);
});

test("old authorization/result contracts stay distinct from proposal contracts", async (t) => {
  const f = await fixture(t);
  const { proposalPaths: _paths, executionBoundary: _boundary, ...worker } = f.options.worker;
  const old = buildRuntimeInvocationAuthorization({ ...f.options, persist: false, worker: { ...worker, taskKey: "old" } }).authorization;
  const oldResult = { ...f.result, protocolVersion: "0.1.0" };
  delete oldResult.patchProposal;
  assert.equal(verifyRuntimeStructuredResult(oldResult, { authorization: old }).protocolVersion, "0.1.0");
  assert.throws(() => verifyRuntimeStructuredResult(f.result, { authorization: old }), /version or scope/);
  assert.throws(() => verifyRuntimeStructuredResult(oldResult, { authorization: f.authorization }), /version or scope/);
  assert.throws(() => buildWorkerPatchProposalCandidate({ authorization: old, structuredResult: f.result }), /Only an exact/);
  const writeBoundary = workerExecutionBoundary({
    binding: f.binding,
    policy: { fixtureOnly: true },
    sourceBasis: f.sourceBasis,
    ownedPaths: f.proposalBasis.map((entry) => entry.path),
    writeBasis: f.proposalBasis,
  });
  const oldWrite = buildRuntimeInvocationAuthorization({
    ...f.options,
    persist: false,
    workspaceMode: "workspace-write",
    worker: { ...worker, taskKey: "old-write", executionBoundary: writeBoundary },
  }).authorization;
  assert.equal(oldWrite.protocolVersion, "0.6.0");
  assert.equal(verifyRuntimeInvocationAuthorization(oldWrite), oldWrite);
  assert.throws(() => verifyRuntimeStructuredResult(f.result, { authorization: oldWrite }), /version or scope/);
});

test("proposal authorization rejects expanded writes, mixed bases and tampered bindings before execution", async (t) => {
  const f = await fixture(t);
  assert.throws(() => buildRuntimeInvocationAuthorization({ ...f.options, persist: false, workspaceMode: "workspace-write" }), /read-only boundary/);
  const mutations = [
    (a) => {
      a.workerInput.executionBoundary.ownedPaths = ["edit.txt"];
    },
    (a) => {
      a.workerInput.writeBasis = a.workerInput.proposalBasis;
    },
    (a) => {
      a.workerInput.executionBoundary.writeBasisDigest = a.workerInput.executionBoundary.proposalBasisDigest;
    },
    (a) => {
      delete a.workerInput.proposalBasis;
    },
    (a) => {
      a.workerInput.executionBoundary.proposalBasisDigest = "f".repeat(64);
    },
    (a) => {
      a.protocolVersion = "0.6.0";
    },
    (a) => {
      a.workerInput.executionBoundary.mode = "selected-snapshot";
    },
    (a) => {
      a.workerInput.executionBoundary.policyDigest = "g".repeat(64);
    },
  ];
  for (const mutate of mutations) {
    const auth = copy(f.authorization);
    mutate(auth);
    assert.throws(() => verifyRuntimeInvocationAuthorization(reidentify(auth, "execution-authorization", "authorizationId", "authorizationHash")));
  }
});

test("typed proposal rejects wrong basis, unselected paths, malformed images, duplicates and provider hashes", async (t) => {
  const f = await fixture(t);
  const changes = [
    (r) => {
      r.patchProposal.proposalBasisDigest = "0".repeat(64);
    },
    (r) => {
      r.patchProposal.changes[0].path = "unselected.txt";
    },
    (r) => {
      r.patchProposal.changes[0].path = "../outside.txt";
    },
    (r) => {
      r.patchProposal.changes[0].path = ".head/sessions/current.json";
    },
    (r) => {
      r.patchProposal.changes[0].path = ".lode/sessions/current.json";
    },
    (r) => {
      r.patchProposal.changes.push(copy(r.patchProposal.changes[0]));
    },
    (r) => {
      r.patchProposal.changes[0].after.contentBase64 = "not base64!";
    },
    (r) => {
      r.patchProposal.changes[0].after.mode = 0o1000;
    },
    (r) => {
      r.patchProposal.changes[0].after.digest = "0".repeat(64);
    },
    (r) => {
      r.patchProposal.candidateHash = "0".repeat(64);
    },
    (r) => {
      delete r.patchProposal;
    },
    (r) => {
      r.planDelta = "Session cannot write a plan delta";
    },
    (r) => {
      r.impactRadius = ["selected.txt only"];
    },
    (r) => {
      r.patchProposal.changes = [{ path: "edit.txt", after: image("x".repeat(128 * 1024)) }];
    },
  ];
  for (const mutate of changes) {
    const result = copy(f.result);
    mutate(result);
    assert.throws(() => verifyRuntimeStructuredResult(result, { authorization: f.authorization }));
  }
  const noop = copy(f.result);
  noop.patchProposal.changes = [];
  assert.deepEqual(buildWorkerPatchProposalCandidate({ authorization: f.authorization, structuredResult: noop }).patches, []);
});

test("proposal preparation rechecks absence without gaining write authority", async (t) => {
  const f = await fixture(t),
    session = fs.readFileSync(f.session);
  fs.writeFileSync(path.join(f.root, "new.txt"), "User created after authorization");
  assert.throws(() => prepareRuntimeInvocationExecution(f.input), /preimage changed/);
  assert.equal(fs.readFileSync(path.join(f.root, "new.txt"), "utf8"), "User created after authorization");
  assert.deepEqual(fs.readFileSync(f.session), session);
});

test("completed receipt cannot omit proposal while failed null evidence remains durable", async (t) => {
  const f = await fixture(t);
  const r = await record(f, {
    status: "failed",
    result: null,
    beforeReceipt: (args) => {
      assert.throws(() => buildRuntimeInvocationLifecycleReceipt({ ...args, status: "completed", exitCode: 0 }), /requires its typed patch proposal/);
      const old = { ...f.result, protocolVersion: "0.1.0" };
      delete old.patchProposal;
      assert.throws(() => buildRuntimeInvocationLifecycleReceipt({ ...args, structuredResult: old }), /version or scope/);
    },
  });
  assert.equal(r.draft.providerResult, null);
  assert.equal(r.draft.verification[0].status, "failed");
  persistRuntimeInvocationRecord({ projectRoot: f.root, ...r });
  assert.equal(readRuntimeInvocationRecord({ root: f.root, storage: f.storage, authorizationId: f.authorization.authorizationId }).draft.providerResult, null);
});

test("receipt-result observed, digest and byte linkage is checked again at publication", async (t) => {
  const f = await fixture(t),
    r = await record(f);
  const wrongConsumption = copy(r.draft);
  wrongConsumption.executionLeaseConsumptionId = `runtime-execution-consumption-${"a".repeat(24)}`;
  wrongConsumption.evidence[0].executionLeaseConsumptionId = wrongConsumption.executionLeaseConsumptionId;
  const wrongConsumptionDraft = reidentify(wrongConsumption, "runtime-result-draft", "draftId", "draftHash");
  assert.equal(verifyRuntimeResultPacketDraft(wrongConsumptionDraft, { authorization: f.authorization }), wrongConsumptionDraft);
  assert.throws(() => persistRuntimeInvocationRecord({ projectRoot: f.root, ...r, draft: wrongConsumptionDraft }), /lineage is inconsistent/);
  for (const field of ["structuredResultDigest", "structuredResultBytes", "structuredResultObserved"]) {
    const receipt = copy(r.receipt);
    if (field === "structuredResultDigest") receipt.providerBoundary[field] = "a".repeat(64);
    if (field === "structuredResultBytes") receipt.providerBoundary[field]++;
    if (field === "structuredResultObserved")
      Object.assign(receipt.providerBoundary, { structuredResultObserved: false, structuredResultDigest: "", structuredResultBytes: 0 });
    const altered = reidentify(receipt, "runtime-lifecycle-receipt", "receiptId", "receiptHash");
    const draft = copy(r.draft);
    draft.lifecycleReceiptId = altered.receiptId;
    draft.evidence[0].lifecycleReceiptId = altered.receiptId;
    const alteredDraft = reidentify(draft, "runtime-result-draft", "draftId", "draftHash");
    assert.throws(() => persistRuntimeInvocationRecord({ projectRoot: f.root, ...r, receipt: altered, draft: alteredDraft }));
  }
  persistRuntimeInvocationRecord({ projectRoot: f.root, ...r });
  const directory = path.join(f.root, f.storage.directory, "runtime/invocations", f.authorization.authorizationId);
  const draftFile = fs.readdirSync(directory).find((name) => name.includes("draft"));
  assert.ok(draftFile);
  const changed = copy(r.draft);
  changed.providerResult.patchProposal.changes[0].after = image("rehashed different proposal");
  changed.evidence[0].structuredResultDigest = hash(json(changed.providerResult));
  const alteredDraft = reidentify(changed, "runtime-result-draft", "draftId", "draftHash");
  assert.equal(verifyRuntimeResultPacketDraft(alteredDraft, { authorization: f.authorization }), alteredDraft);
  fs.writeFileSync(path.join(directory, draftFile), JSON.stringify(alteredDraft));
  assert.throws(
    () => readRuntimeInvocationRecord({ root: f.root, storage: f.storage, authorizationId: f.authorization.authorizationId }),
    /lineage is inconsistent/,
  );
});
