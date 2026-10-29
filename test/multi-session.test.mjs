import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";
import { createHeadSession, listHeadSessions, withSessionRoute, sessionStatePath, sessionDataPath } from "../scripts/lib/session-routing.mjs";
import { readProjectDirection, updateProjectDirection, assertProjectActionsCurrent, assertAuthorizationProjectDirection } from "../scripts/lib/project-direction.mjs";
import { createRecoveryCheckpoint, prepareCompaction, inspectCompaction, verifyCompaction, continueCompaction, inspectRecoveryCheckpointBasis, syncRecoveryCheckpoint } from "../scripts/lib/compaction-recovery.mjs";
import { restoreSessionFromArtifacts } from "../scripts/lib/session-recovery.mjs";
import { inspectProjectExperience, initializeOrResumeProject } from "../scripts/lib/project-bootstrap.mjs";
import { inspectOptionalOnboarding, startOnboarding, reviewOnboarding } from "../scripts/lib/onboarding.mjs";
import { onboardingCanonicalJson, onboardingDigest } from "../scripts/lib/onboarding-contract.mjs";
import { captureHistoricalBoundaryApplicationBasis, createVerifiedHistoricalInventoryCapability, applyHistoricalArtifactBoundary } from "../scripts/lib/historical-artifact-boundary.mjs";
import { readHistoricalBoundaryApplication, verifyHistoricalArtifactBoundary } from "../scripts/lib/historical-artifact-boundary-store.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { createWholePlanSnapshot, createExecutionContract } from "../scripts/lib/execution-lineage.mjs";
import { startRun, finishRun } from "../scripts/lib/run-lineage.mjs";
import { buildRuntimeVersionEvidence } from "../scripts/lib/runtime-machine-execution.mjs";
import { buildRuntimeProjectBinding, buildRuntimeProtocolEvidence } from "../scripts/lib/runtime-protocol-evidence.mjs";
import { buildRuntimeInvocationAuthorization, prepareRuntimeInvocationExecution, verifyRuntimeInvocationAuthorization } from "../scripts/lib/runtime-invocation-lifecycle.mjs";
import { withRuntimeExecutionLease, inspectRuntimeExecutionLease, RUNTIME_OPERATIONAL_STATE_ENV } from "../scripts/lib/runtime-execution-lease.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
function project(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "head-multi-session-")));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  const layout = formatForVerifiedOwner(storage);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, storage, layout };
}
const direction = (suffix) => ({ purpose: `Session purpose ${suffix}`, currentPosition: `Position ${suffix}`, nextExpectedResult: `Result ${suffix}` });
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("S1-S6: bounded Session discovery isolates item failures and traverses invalid slots without repair", t => {
  const { root, storage, layout } = project(t);
  const a = createHeadSession({ root, purpose: "Same title" }), b = createHeadSession({ root, purpose: "Same title" });
  const defaultFile = sessionStatePath(root, storage), originalDefault = fs.readFileSync(defaultFile);
  const bFile = path.join(root, layout.directory, "sessions/by-id", b.sessionId, "current.json"), originalB = fs.readFileSync(bFile);
  for (const name of ["default", "zz-unexpected-entry"]) fs.mkdirSync(path.join(root, layout.directory, "sessions/by-id", name));
  const allBytes = () => [defaultFile, bFile].map(file => fs.readFileSync(file));
  for (const defaultFailure of ["malformed", "missing", "foreign"]) {
    if (defaultFailure === "missing") fs.unlinkSync(defaultFile);
    else fs.writeFileSync(defaultFile, defaultFailure === "malformed" ? "{" : JSON.stringify({ ...JSON.parse(originalDefault), projectId: "foreign" }));
    fs.writeFileSync(bFile, "{");
    const beforeB = fs.readFileSync(bFile), pages = [], rows = [], unavailable = [];
    let afterSessionId = null;
    do {
      const page = listHeadSessions({ root, maxSessions: 1, afterSessionId }); pages.push(page);
      rows.push(...page.sessions); unavailable.push(...page.unavailable);
      assert.equal(page.defaultSessionId, null); assert.equal(page.status, "partial");
      assert.equal(page.coverage.inspectedEntries, 1); assert.equal(page.persisted, false);
      if (page.nextAfterSessionId) assert.notEqual(page.nextAfterSessionId, afterSessionId);
      afterSessionId = page.nextAfterSessionId;
      assert.ok(pages.length <= 5);
    } while (afterSessionId);
    assert.deepEqual(rows.map(row => row.sessionId), [a.sessionId]);
    assert.deepEqual(new Set(unavailable.map(row => row.traversalKey)), new Set(["default", b.sessionId, "entry:default", "entry:zz-unexpected-entry"]));
    assert.equal(unavailable.find(row => row.entry === "zz-unexpected-entry").sessionId, null);
    assert.deepEqual(fs.readFileSync(bFile), beforeB);
    if (defaultFailure === "missing") assert.equal(fs.existsSync(defaultFile), false);
    fs.writeFileSync(defaultFile, originalDefault);
  }
  fs.writeFileSync(bFile, originalB);
  for (const state of [
    { ...b.state, projectId: "foreign" },
    { ...b.state, sessionId: a.sessionId },
    { ...b.state, sessionId: JSON.parse(originalDefault).sessionId },
  ]) {
    fs.writeFileSync(bFile, JSON.stringify(state));
    const failed = listHeadSessions({ root });
    assert.ok(failed.sessions.some(row => row.sessionId === a.sessionId));
    assert.equal(failed.unavailable.find(row => row.entry === b.sessionId).reasonCode, "HEAD_SESSION_IDENTITY_MISMATCH");
  }
  fs.unlinkSync(bFile);
  assert.equal(listHeadSessions({ root }).unavailable.find(row => row.entry === b.sessionId).reasonCode, "ENOENT");
  fs.writeFileSync(bFile, originalB);
  // Legacy default records did not require an explicit projectId.
  const legacyDefault = JSON.parse(originalDefault); delete legacyDefault.projectId;
  fs.writeFileSync(defaultFile, JSON.stringify(legacyDefault));
  assert.equal(listHeadSessions({ root }).defaultSessionId, legacyDefault.sessionId);
  fs.writeFileSync(defaultFile, originalDefault);
  const duplicateDirectory = path.join(root, layout.directory, "sessions/by-id", legacyDefault.sessionId);
  fs.mkdirSync(duplicateDirectory);
  const duplicateFile = path.join(duplicateDirectory, "current.json");
  fs.writeFileSync(duplicateFile, JSON.stringify({ ...legacyDefault, projectId: a.state.projectId }));
  const duplicatePage = listHeadSessions({ root });
  assert.equal(duplicatePage.defaultSessionId, null);
  assert.equal(duplicatePage.sessions.some(row => row.sessionId === legacyDefault.sessionId), false);
  assert.equal(duplicatePage.unavailable.filter(row => row.reasonCode === "HEAD_SESSION_IDENTITY_MISMATCH").length, 2);
  assert.ok(duplicatePage.sessions.some(row => row.sessionId === a.sessionId));
  assert.throws(() => withSessionRoute(root, legacyDefault.sessionId, () => {}), { code: "HEAD_SESSION_IDENTITY_MISMATCH" });
  fs.unlinkSync(duplicateFile); fs.rmdirSync(duplicateDirectory);
  const before = allBytes(), directory = path.dirname(bFile), saved = fs.readdirSync, exists = fs.existsSync;
  fs.existsSync = function(file) { return path.resolve(file) === path.dirname(directory) ? false : exists.call(this, file); };
  fs.readdirSync = function(file, ...args) {
    if (path.resolve(file) === path.dirname(directory)) throw Object.assign(new Error("Synthetic denial"), { code: "EACCES" });
    return saved.call(this, file, ...args);
  };
  try {
    const partial = listHeadSessions({ root });
    assert.equal(partial.sessions.length, 1); assert.equal(partial.coverage.directory.reasonCode, "EACCES");
    assert.equal(partial.status, "partial");
  } finally { fs.readdirSync = saved; fs.existsSync = exists; }
  assert.deepEqual(allBytes(), before);
  const projectFile = path.join(root, layout.directory, "project.json"), projectBytes = fs.readFileSync(projectFile);
  fs.writeFileSync(projectFile, JSON.stringify({ ...JSON.parse(projectBytes), projectRoot: root + "-foreign" }));
  assert.throws(() => listHeadSessions({ root }), { code: "PROJECT_IDENTITY_MISMATCH" });
  fs.writeFileSync(projectFile, projectBytes);
  assert.throws(() => listHeadSessions({ root, afterSessionId: "removed-entry" }), { code: "HEAD_SESSION_LIST_CURSOR_CHANGED" });
  assert.throws(() => listHeadSessions({ root, maxSessions: 65 }), { code: "INVALID_HEAD_SESSION_INPUT" });
});

test("S1-S6: metadata size and unsafe paths remain bounded unavailable evidence", t => {
  const { root, storage, layout } = project(t), a = createHeadSession({ root });
  const file = path.join(root, layout.directory, "sessions/by-id", a.sessionId, "current.json"), bytes = fs.readFileSync(file);
  fs.writeFileSync(file, JSON.stringify({ ...a.state, purpose: "x".repeat(70000) }));
  const large = listHeadSessions({ root });
  assert.equal(large.unavailable.find(row => row.sessionId === a.sessionId).reasonCode, "SESSION_LIST_ITEM_TOO_LARGE");
  fs.writeFileSync(file, bytes);
  const defaultFile = sessionStatePath(root, storage), defaultBytes = fs.readFileSync(defaultFile);
  fs.writeFileSync(defaultFile, JSON.stringify({ ...JSON.parse(defaultBytes), purpose: "d".repeat(9000) }));
  fs.writeFileSync(file, JSON.stringify({ ...a.state, purpose: "n".repeat(9000) }));
  const page = listHeadSessions({ root });
  assert.equal(page.coverage.inspectedEntries, 2);
  assert.equal(page.coverage.returnedEntries, 1);
  assert.equal(page.coverage.readButNotReturnedEntries, 1);
  assert.equal(page.coverage.remainingEntries, 1);
  assert.equal(page.nextAfterSessionId, "default");
  const rest = listHeadSessions({ root, afterSessionId: page.nextAfterSessionId });
  assert.equal(rest.sessions[0].sessionId, a.sessionId);
  assert.equal(rest.coverage.readButNotReturnedEntries, 0);
  assert.equal(rest.nextAfterSessionId, null);
  fs.writeFileSync(defaultFile, defaultBytes); fs.writeFileSync(file, bytes);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "head-list-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const linkedId = "session-00000000-0000-0000-0000-000000000000", linked = path.join(root, layout.directory, "sessions/by-id", linkedId);
  fs.symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
  try {
    assert.equal(listHeadSessions({ root }).unavailable.find(row => row.sessionId === linkedId).reasonCode, "SESSION_PATH_ESCAPE");
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally { fs.unlinkSync(linked); }
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test("independent async routes preserve original identity, unknown execution and approval bytes", async (t) => {
  const { root, storage, layout } = project(t);
  const originalFile = sessionStatePath(root, storage);
  const existing = read(originalFile);
  existing.unknownExternalOutcome = { action: "deploy", replayAllowed: false };
  existing.lastReviewDecisionId = "review-retained";
  fs.writeFileSync(originalFile, JSON.stringify(existing));
  const before = fs.readFileSync(originalFile);
  const a = createHeadSession({ root, purpose: "A" });
  const b = createHeadSession({ root, purpose: "B" });
  const gate = Promise.withResolvers();
  const first = (withSessionRoute(root, a.sessionId, async () => {
    await gate.promise;
    createRecoveryCheckpoint({ root, ...direction("A") });
    assert.equal(inspectProject(root).state.sessionId, a.sessionId);
    return restoreSessionFromArtifacts({ root }).projection;
  }));
  const second = (withSessionRoute(root, b.sessionId, async () => {
    createRecoveryCheckpoint({ root, ...direction("B") });
    gate.resolve();
    await Promise.resolve();
    assert.equal(inspectProject(root).state.sessionId, b.sessionId);
    return restoreSessionFromArtifacts({ root }).projection;
  }));
  const results = await Promise.all([first, second]);
  assert.equal(results[0].consumerInstruction.purpose, "Session purpose A");
  assert.equal(results[1].consumerInstruction.purpose, "Session purpose B");
  assert.deepEqual(fs.readFileSync(originalFile), before);
  assert.equal(inspectProject(root).state.sessionId, existing.sessionId);
  assert.equal(listHeadSessions({ root }).sessions.length, 3);
});

test("common current cancellation survives every Session restore without rewriting checkpoints", async (t) => {
  const { root, storage, layout } = project(t);
  const a = createHeadSession({ root, purpose: "Deployment investigation" });
  const b = createHeadSession({ root, purpose: "Independent docs" });
  withSessionRoute(root, a.sessionId, () => createRecoveryCheckpoint({ root, ...direction("deployment") }));
  const initial = updateProjectDirection({ root, expectedDirectionId: null, input: { goal: "Build", decisions: ["Previously deploy"] } }).direction;
  const final = updateProjectDirection({ root, expectedDirectionId: initial.directionId, input: { goal: "Build", cancelledActions: ["deploy"] } }).direction;
  assert.throws(() => updateProjectDirection({ root, expectedDirectionId: initial.directionId, input: { goal: "Deploy" } }), { code: "PROJECT_DIRECTION_CONFLICT" });
  const restored = withSessionRoute(root, a.sessionId, () => restoreSessionFromArtifacts({ root }));
  assert.equal(restored.checkpoint.purpose, "Session purpose deployment");
  assert.equal(restored.projection.consumerInstruction.currentProjectDirection.directionId, final.directionId);
  assert.throws(() => assertProjectActionsCurrent({ root, actions: ["deploy"] }), { code: "PROJECT_ACTION_CANCELLED" });
  assert.doesNotThrow(() => assertProjectActionsCurrent({ root, actions: ["source.read"] }));
  assert.equal((await withSessionRoute(root, b.sessionId, async () => (await inspectProjectExperience({ root })))).currentProjectDirection.directionId, final.directionId);
  assert.equal(withSessionRoute(root, b.sessionId, () => inspectProject(root).state.purpose), "Independent docs");
});

test("per-session compaction pointers and token consumption never collide", (t) => {
  const { root, storage, layout } = project(t);
  const a = createHeadSession({ root }); const b = createHeadSession({ root });
  const prepare = (id) => withSessionRoute(root, id, () => prepareCompaction({ root, runtime: "codex", userTurnIdAtPrepare: 7, ...direction(id) }));
  const aa = prepare(a.sessionId); const bb = prepare(b.sessionId);
  assert.notEqual(aa.epoch.epochId, bb.epoch.epochId);
  assert.equal(withSessionRoute(root, a.sessionId, () => inspectCompaction({ root })).epoch.epochId, aa.epoch.epochId);
  assert.equal(withSessionRoute(root, b.sessionId, () => inspectCompaction({ root })).epoch.epochId, bb.epoch.epochId);
  assert.equal(inspectCompaction({ root }).status, "idle");
  withSessionRoute(root, a.sessionId, () => {
    verifyCompaction({ root, epochId: aa.epoch.epochId, checkpointDigest: aa.checkpoint.checkpointDigest, currentUserTurnId: 7, providerCompacted: true });
    continueCompaction({ root, epochId: aa.epoch.epochId, continuationToken: aa.continuationToken, currentUserTurnId: 7 });
    assert.throws(() => continueCompaction({ root, epochId: aa.epoch.epochId, continuationToken: aa.continuationToken, currentUserTurnId: 7 }));
  });
  assert.equal(withSessionRoute(root, b.sessionId, () => inspectCompaction({ root })).epoch.state, "prepared");
});

test("routing rejects escape, foreign identity and divergent create without default mutation", (t) => {
  const { root, storage, layout } = project(t); const { root: foreign } = project(t);
  const a = createHeadSession({ root, purpose: "A" });
  assert.throws(() => withSessionRoute(root, "../../outside", () => {}), { code: "INVALID_HEAD_SESSION_ID" });
  assert.throws(() => createHeadSession({ root, sessionId: a.sessionId, purpose: "B" }), { code: "HEAD_SESSION_CREATE_CONFLICT" });
  withSessionRoute(root, a.sessionId, () => assert.throws(() => sessionDataPath(root, "../../../../../escape"), { code: "SESSION_PATH_ESCAPE" }));
  withSessionRoute(root, a.sessionId, () => assert.notEqual(inspectProject(foreign).state.sessionId, a.sessionId));
  const file = withSessionRoute(root, a.sessionId, () => sessionStatePath(root, storage));
  fs.writeFileSync(file, JSON.stringify({ ...a.state, projectId: inspectProject(foreign).project.projectId }));
  assert.throws(() => withSessionRoute(root, a.sessionId, () => {}), { code: "HEAD_SESSION_IDENTITY_MISMATCH" });
});

test("default project onboarding remains readable within a new logical Session", async (t) => {
  const { root, storage, layout } = project(t); const before = (await inspectOptionalOnboarding({ root }));
  const a = createHeadSession({ root });
  const after = (await withSessionRoute(root, a.sessionId, async () => (await inspectOptionalOnboarding({ root }))));
  assert.equal(after.state.sessionId, before.state.sessionId);
  assert.equal(after.state.pointerHash, before.state.pointerHash);
});

test("new common direction invalidates stale checkpoint publication basis", (t) => {
  const { root, storage, layout } = project(t); const basis = inspectRecoveryCheckpointBasis({ root }).basis;
  updateProjectDirection({ root, input: { goal: "Changed by user" } });
  const result = syncRecoveryCheckpoint({ root, expectedRecoveryBasisId: basis.basisId, ...direction("old") });
  assert.equal(result.status, "recovery_checkpoint_sync_conflict");
  assert.equal(inspectProject(root).state.latestCheckpoint, null);
});

test("active Runs stay Session-owned and another route cannot finish a copied pointer", async (t) => {
  const { root, storage, layout } = project(t); const a = createHeadSession({ root }); const b = createHeadSession({ root });
  const started = (await withSessionRoute(root, a.sessionId, async () => {
    const capsule = (await compileContext({ root, task: "Synthetic source work", budget: 32768, persist: true })).capsule;
    const plan = createWholePlanSnapshot({ root, objective: "Synthetic work", plan: [{ id: "work", outcome: "Done" }] }).artifact;
    const contract = createExecutionContract({ root, wholePlanId: plan.wholePlanId, capsuleId: capsule.capsuleId, scope: "Synthetic work", acceptanceCriteria: ["Done"] }).artifact;
    return startRun({ root, executionContractId: contract.executionContractId });
  }));
  const aState = withSessionRoute(root, a.sessionId, () => inspectProject(root).state);
  withSessionRoute(root, b.sessionId, () => fs.writeFileSync(sessionStatePath(root, storage), JSON.stringify({ ...aState, sessionId: b.sessionId })));
  assert.throws(() => withSessionRoute(root, b.sessionId, () => finishRun({ root, outcome: "Copied", evidence: ["x"], verification: ["x"] })), { code: "RUN_SESSION_MISMATCH" });
  assert.equal(withSessionRoute(root, a.sessionId, () => inspectProject(root).state.activeRunId), started.run.runId);
  assert.equal(inspectProject(root).state.activeRunId, null);
});

test("lost direction response converges without another revision or approval", (t) => {
  const { root, storage, layout } = project(t); const input = { goal: "Current user direction" };
  const first = updateProjectDirection({ root, expectedDirectionId: null, input });
  const retry = updateProjectDirection({ root, expectedDirectionId: null, input });
  assert.equal(retry.status, "reused");
  assert.equal(retry.direction.directionId, first.direction.directionId);
  assert.equal(fs.readdirSync(path.join(root, layout.directory, "project-direction/revisions")).length, 1);
  assert.throws(() => updateProjectDirection({ root, expectedDirectionId: null, input: { goal: "Different user direction" } }), { code: "PROJECT_DIRECTION_CONFLICT" });
});

test("direction constraint changes invalidate old effects while unknown outcomes remain unchanged", async (t) => {
  const { root, storage, layout } = project(t); const file = sessionStatePath(root, storage);
  const original = { ...read(file), externalEffect: { status: "unknown", replayAllowed: false } };
  fs.writeFileSync(file, JSON.stringify(original));
  const before = fs.readFileSync(file);
  const first = updateProjectDirection({ root, input: { goal: "Build" } }).direction;
  assert.doesNotThrow(() => assertAuthorizationProjectDirection(root, { currentProjectDirectionId: first.directionId }));
  updateProjectDirection({ root, expectedDirectionId: first.directionId, input: { goal: "Build", constraints: ["Keep public schema unchanged"] } });
  assert.throws(() => assertAuthorizationProjectDirection(root, { currentProjectDirectionId: first.directionId }), { code: "RUNTIME_PROJECT_DIRECTION_DRIFT" });
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal((await inspectProjectExperience({ root })).readiness.core.state, "ready");
});

test("selected route remains bound to its original path despite default identity tamper", (t) => {
  const { root, storage, layout } = project(t); const defaultFile = sessionStatePath(root, storage);
  const original = fs.readFileSync(defaultFile);
  const a = createHeadSession({ root });
  withSessionRoute(root, a.sessionId, () => {
    const selectedFile = sessionStatePath(root, storage);
    fs.writeFileSync(defaultFile, JSON.stringify({ ...read(defaultFile), sessionId: a.sessionId }));
    assert.equal(sessionStatePath(root, storage), selectedFile);
    assert.notEqual(sessionStatePath(root, storage), defaultFile);
    fs.writeFileSync(selectedFile, JSON.stringify({ ...a.state, sessionId: "session-00000000-0000-0000-0000-000000000000" }));
    assert.throws(() => sessionStatePath(root, storage), { code: "HEAD_SESSION_IDENTITY_MISMATCH" });
  });
  fs.writeFileSync(defaultFile, original);
});

// Protocol strings are fixtures; this fake child never launches or controls an OS process.
function capabilityFixture(_command, args) {
  const key = args.join(" ");
  const output = key === "--version" ? "codex 1.2.3\n" : key === "--help" ? "exec\nmcp-server\napp-server\n"
    : key === "exec --help" ? "Run Codex non-interactively\n--json\n--output-schema\n--color\n--sandbox\n--skip-git-repo-check\n--cd\n--ephemeral\nresume\n" : "stdio://\ngenerate-json-schema\n--listen\n";
  const child = new EventEmitter();
  Object.assign(child, { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null });
  child.kill = () => { throw new Error("No actual child exists"); };
  queueMicrotask(() => { child.stdout.emit("data", Buffer.from(output)); child.exitCode = 0; child.emit("close", 0, null); });
  return child;
}

test("authorization and actual prepared input bind routed Session and current common constraints", async (t) => {
  const { root, storage, layout } = project(t); const a = createHeadSession({ root }); const b = createHeadSession({ root });
  const bin = path.join(root, "fixture-bin"); fs.mkdirSync(bin);
  const marker = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(marker, "Fixture marker; never executed");
  if (process.platform !== "win32") fs.chmodSync(marker, 0o755);
  const environment = { ...process.env, PATH: bin }; delete environment.Path; delete environment.path;
  const versionEvidence = await buildRuntimeVersionEvidence({ runtimes: ["codex"], environment, spawnImplementation: capabilityFixture });
  const protocolEvidence = await buildRuntimeProtocolEvidence({ runtimes: ["codex"], environment, versionEvidence, spawnImplementation: capabilityFixture });
  const first = updateProjectDirection({ root, input: { goal: "Investigate", constraints: ["No deployment"] } }).direction;
  await withSessionRoute(root, a.sessionId, async () => {
    const inspected = inspectProject(root);
    const projectBinding = buildRuntimeProjectBinding({ projectId: inspected.project.projectId, headSessionId: a.sessionId,
      projectRoot: root, projectStatus: "ready", versionEvidence, protocolEvidence, storage });
    const options = { root, runtime: "codex", scope: { kind: "session", request: "Read source" }, protocolEvidence, projectBinding };
    const auth = buildRuntimeInvocationAuthorization(options).authorization;
    assert.equal(auth.currentProjectDirectionId, first.directionId);
    assert.equal(prepareRuntimeInvocationExecution({ root, authorization: auth, sessionRequest: "Read source" }).executionInput.currentProjectDirection.directionId, first.directionId);
    assert.throws(() => withSessionRoute(root, b.sessionId, () => prepareRuntimeInvocationExecution({ root, authorization: auth, sessionRequest: "Read source" })), { code: "RUNTIME_INVOCATION_FENCE_MISMATCH" });
    updateProjectDirection({ root, expectedDirectionId: first.directionId, input: { goal: "Investigate", constraints: ["No network"] } });
    assert.throws(() => prepareRuntimeInvocationExecution({ root, authorization: auth, sessionRequest: "Read source" }), { code: "RUNTIME_PROJECT_DIRECTION_DRIFT" });
    const renewed = buildRuntimeInvocationAuthorization(options).authorization;
    assert.notEqual(renewed.authorizationId, auth.authorizationId);
    assert.deepEqual(prepareRuntimeInvocationExecution({ root, authorization: renewed, sessionRequest: "Read source" }).executionInput.currentProjectDirection.input.constraints, ["No network"]);
  });
  assert.equal(inspectProject(root).state.activeRunId, null);
});

test("explicit resume initializes only a missing index and preserves existing inventory on unchanged replay", async (t) => {
  const { root, storage, layout } = project(t); const index = path.join(root, layout.directory, "graph-discovery/index.json");
  const existing = fs.readFileSync(index);
  const state = read(sessionStatePath(root, storage));
  fs.writeFileSync(sessionStatePath(root, storage), JSON.stringify({ ...state, currentPosition: "An existing caller-authored update" }));
  const sessionBytes = fs.readFileSync(sessionStatePath(root, storage));
  await initializeOrResumeProject({ root, pluginRoot, profile: "core" });
  assert.deepEqual(fs.readFileSync(index), existing);
  assert.deepEqual(fs.readFileSync(sessionStatePath(root, storage)), sessionBytes);
  fs.unlinkSync(index);
  await initializeOrResumeProject({ root, pluginRoot, profile: "core" });
  assert.equal(fs.existsSync(index), true);
  const rebuilt = fs.readFileSync(index);
  await initializeOrResumeProject({ root, pluginRoot, profile: "core" });
  assert.deepEqual(fs.readFileSync(index), rebuilt);
  assert.deepEqual(fs.readFileSync(sessionStatePath(root, storage)), sessionBytes);
});

test("absent common direction preserves consumed prior-shape authorization and unknown outcomes without a sibling gate", async (t) => {
  const { root, storage, layout } = project(t);
  const operationalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "head-multi-session-operational-"));
  const previousEnvironment = process.env[RUNTIME_OPERATIONAL_STATE_ENV];
  process.env[RUNTIME_OPERATIONAL_STATE_ENV] = operationalRoot;
  t.after(() => {
    if (previousEnvironment === undefined) delete process.env[RUNTIME_OPERATIONAL_STATE_ENV];
    else process.env[RUNTIME_OPERATIONAL_STATE_ENV] = previousEnvironment;
    fs.rmSync(operationalRoot, { recursive: true, force: true });
  });
  const sibling = createHeadSession({ root });
  const bin = path.join(root, "fixture-bin"); fs.mkdirSync(bin);
  const marker = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(marker, "Synthetic marker; never executed");
  if (process.platform !== "win32") fs.chmodSync(marker, 0o755);
  const environment = { ...process.env, PATH: bin }; delete environment.Path; delete environment.path;
  const versionEvidence = await buildRuntimeVersionEvidence({ runtimes: ["codex"], environment, spawnImplementation: capabilityFixture });
  const protocolEvidence = await buildRuntimeProtocolEvidence({ runtimes: ["codex"], environment, versionEvidence, spawnImplementation: capabilityFixture });
  const optionsForCurrentSession = () => {
    const inspected = inspectProject(root);
    return { root, runtime: "codex", scope: { kind: "session", request: "Synthetic one-time action" }, protocolEvidence,
      projectBinding: buildRuntimeProjectBinding({ projectId: inspected.project.projectId, headSessionId: inspected.state.sessionId,
        projectRoot: root, projectStatus: "ready", versionEvidence, protocolEvidence, storage }) };
  };
  const options = optionsForCurrentSession();
  // Reconstruct a baseline authorization with no direction field, regardless of
  // the builder's shape. A thrown dispatch is unknown, never a new grant.
  const payload = { ...buildRuntimeInvocationAuthorization({ ...options, persist: false }).authorization };
  delete payload.currentProjectDirectionId; delete payload.authorizationId; delete payload.authorizationHash;
  const hash = crypto.createHash("sha256").update(onboardingCanonicalJson(payload)).digest("hex");
  const prior = verifyRuntimeInvocationAuthorization({ ...payload, authorizationId: `execution-authorization-${hash.slice(0, 24)}`, authorizationHash: hash });
  const authorizationFile = path.join(root, layout.directory, "runtime/execution-authorizations", `${prior.authorizationId}.json`);
  fs.mkdirSync(path.dirname(authorizationFile), { recursive: true }); fs.writeFileSync(authorizationFile, JSON.stringify(prior));
  const original = fs.readFileSync(authorizationFile);
  let calls = 0;
  await assert.rejects(withRuntimeExecutionLease({ projectRoot: root, authorization: prior, ownerFenceDigest: "a".repeat(64) }, async () => {
    calls += 1; throw new Error("Synthetic unknown after dispatch");
  }), /Synthetic unknown after dispatch/);
  const leaseInput = { projectRoot: root, projectId: prior.projectId, authorizationId: prior.authorizationId, storage };
  const consumed = inspectRuntimeExecutionLease(leaseInput);
  assert.equal(consumed.replayAllowed, false);
  assert.equal(consumed.release.operationStatus, "threw");
  const renewed = buildRuntimeInvocationAuthorization(options).authorization;
  assert.equal(Object.hasOwn(renewed, "currentProjectDirectionId"), false);
  assert.equal(renewed.authorizationId, prior.authorizationId);
  await assert.rejects(withRuntimeExecutionLease({ projectRoot: root, authorization: renewed, ownerFenceDigest: "b".repeat(64) }, async () => {
    calls += 1;
  }), { code: "RUNTIME_INVOCATION_AUTHORIZATION_ALREADY_CONSUMED" });
  assert.equal(calls, 1);
  assert.deepEqual(inspectRuntimeExecutionLease(leaseInput), consumed);
  assert.deepEqual(fs.readFileSync(authorizationFile), original);
  await withSessionRoute(root, sibling.sessionId, async () => {
    const independent = buildRuntimeInvocationAuthorization(optionsForCurrentSession()).authorization;
    assert.notEqual(independent.authorizationId, prior.authorizationId);
    await withRuntimeExecutionLease({ projectRoot: root, authorization: independent, ownerFenceDigest: "c".repeat(64) }, async () => { calls += 1; });
  });
  assert.equal(calls, 2);
});

test("historical migration separates common onboarding identity from selected recovery and active effects without writes", async (t) => {
  const { root, storage, layout } = project(t);
  const started = await startOnboarding({ root, mode: "new", brief: { schemaVersion: 1, name: "Synthetic service",
    summary: "Deliver a reviewed message.", capabilities: [{ key: "delivery", name: "Delivery", description: "Deliver a message." }] } });
  await reviewOnboarding({ root, candidateSetId: started.candidateSet.candidateSetId, disposition: "accept-all", rationale: "Synthetic acceptance." });
  const defaultFile = sessionStatePath(root, storage);
  const defaultSessionId = inspectProject(root).state.sessionId;
  const beginRun = async () => {
    const capsule = (await compileContext({ root, task: "Synthetic source work", budget: 32768, persist: true })).capsule;
    const plan = createWholePlanSnapshot({ root, objective: "Synthetic work", plan: [{ id: "work", outcome: "Done" }] }).artifact;
    const contract = createExecutionContract({ root, wholePlanId: plan.wholePlanId, capsuleId: capsule.capsuleId,
      scope: "Synthetic work", acceptanceCriteria: ["Done"] }).artifact;
    return startRun({ root, executionContractId: contract.executionContractId });
  };
  const defaultRun = (await beginRun());
  fs.writeFileSync(defaultFile, JSON.stringify({ ...read(defaultFile), unknownExternalOutcome: { replayAllowed: false, action: "deploy" } }));
  const selected = createHeadSession({ root });
  await withSessionRoute(root, selected.sessionId, async () => {
    const run = (await beginRun());
    const checkpointResult = createRecoveryCheckpoint({ root, ...direction("historical selected") });
    const checkpoint = checkpointResult.checkpoint;
    const selectedFile = sessionStatePath(root, storage);
    fs.writeFileSync(selectedFile, JSON.stringify({ ...read(selectedFile), unknownExternalOutcome: { replayAllowed: false, action: "publish" } }));
    const onboardingFile = path.join(root, layout.directory, "onboarding/current.json");
    const unchangedFiles = [defaultFile, selectedFile, onboardingFile, checkpointResult.file];
    const before = unchangedFiles.map(file => fs.readFileSync(file));
    const basis = captureHistoricalBoundaryApplicationBasis({ root });
    assert.equal(basis.sessionId, selected.sessionId);
    assert.equal(basis.onboardingState.sessionId, defaultSessionId);
    assert.equal(basis.appliedAtBasis.session.path, path.relative(root, selectedFile).replaceAll("\\", "/"));
    assert.equal(basis.appliedAtBasis.onboardingSession.id, defaultSessionId);
    assert(basis.appliedAtBasis.referencedP2.files.some(file => file.id === checkpoint.checkpointId));
    assert(basis.appliedAtBasis.referencedP2.files.some(file => file.id === run.run.runId));
    unchangedFiles.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
    assert.equal(read(defaultFile).activeRunId, defaultRun.run.runId);
    const selectedBytes = fs.readFileSync(selectedFile);
    fs.writeFileSync(selectedFile, JSON.stringify({ ...read(selectedFile), activeRunId: defaultRun.run.runId }));
    assert.throws(() => captureHistoricalBoundaryApplicationBasis({ root }), { code: "RUN_SESSION_MISMATCH" });
    fs.writeFileSync(selectedFile, selectedBytes);
    const onboardingBytes = fs.readFileSync(onboardingFile);
    const foreignPointer = { ...read(onboardingFile), sessionId: selected.sessionId };
    delete foreignPointer.pointerHash;
    fs.writeFileSync(onboardingFile, JSON.stringify({ ...foreignPointer, pointerHash: onboardingDigest(onboardingCanonicalJson(foreignPointer)) }));
    assert.throws(() => captureHistoricalBoundaryApplicationBasis({ root }), { code: "ONBOARDING_STATE_IDENTITY_MISMATCH" });
    fs.writeFileSync(onboardingFile, onboardingBytes);
    const defaultBytes = fs.readFileSync(defaultFile);
    fs.writeFileSync(defaultFile, JSON.stringify({ ...read(defaultFile), projectId: "head-" + "a".repeat(20) }));
    assert.throws(() => captureHistoricalBoundaryApplicationBasis({ root }), { code: "HEAD_SESSION_IDENTITY_MISMATCH" });
    fs.writeFileSync(defaultFile, defaultBytes);
    assert.equal(inspectProject(root).state.sessionId, selected.sessionId);
    unchangedFiles.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
    const current = basis.onboardingState;
    const entries = [
      ["historical-candidate-set", "candidate-sets", current.candidateSetId],
      ["historical-review", "review-decisions", current.latestReviewDecisionId],
      ["historical-product-revision", "product-model-revisions", current.productModelId],
    ].map(([role, directory, artifactId]) => {
      const relative = `${layout.directory}/onboarding/${directory}/${artifactId}.json`;
      const bytes = fs.readFileSync(path.join(root, relative)); const document = JSON.parse(bytes);
      return { path: relative, role, artifactId, protocolFamily: document.protocol?.name || document.kind,
        protocolVersion: document.protocol?.version || "0.3.0", byteLength: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        interpretationMode: role === "historical-product-revision" ? "current-typed-with-historical-provenance" : "opaque-historical" };
    }).sort((a, b) => a.path.localeCompare(b.path, "en"));
    const capability = createVerifiedHistoricalInventoryCapability({ root, projectId: basis.projectId, entries, storage,
      validation: { status: "complete-ready-verified", instructionAuthority: false, promotionAuthority: false,
        supportedCandidateVersions: ["0.3.0"], historicalReadyCandidateSetId: current.candidateSetId,
        historicalReadyReviewDecisionId: current.latestReviewDecisionId, historicalResultingProductModelId: current.productModelId } });
    // Another original-Session change after preflight cannot be hidden by the
    // selected route. Restore bytes, then exercise the full create/read/retry path.
    fs.writeFileSync(defaultFile, JSON.stringify({ ...read(defaultFile), unknownExternalOutcome: { replayAllowed: false, action: "changed" } }));
    assert.throws(() => applyHistoricalArtifactBoundary({ root, verifiedInventory: capability, hostMode: "explicit-one-shot" }), { code: "HISTORICAL_BOUNDARY_PREFLIGHT_BASIS_DRIFT" });
    fs.writeFileSync(defaultFile, before[0]);
    const applied = applyHistoricalArtifactBoundary({ root, verifiedInventory: capability, hostMode: "explicit-one-shot" });
    assert.equal(applied.status, "applied"); assert.equal(applied.writes, 3);
    assert.deepEqual(applied.boundary.appliedAtBasis.onboardingSession, basis.appliedAtBasis.onboardingSession);
    const stored = readHistoricalBoundaryApplication({ root, projectId: basis.projectId, requireCommitted: true, storage });
    assert.deepEqual(verifyHistoricalArtifactBoundary(stored.boundary, { projectRoot: root, projectId: basis.projectId, storage }), applied.boundary);
    assert.equal(stored.boundary.instructionAuthority, false); assert.equal(stored.boundary.promotionAuthority, false);
    const replay = applyHistoricalArtifactBoundary({ root, verifiedInventory: capability, hostMode: "explicit-one-shot" });
    assert.equal(replay.status, "already-applied"); assert.equal(replay.writes, 0);
    unchangedFiles.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
    const boundaryFile = path.join(stored.directory, "boundary.json"); const boundaryBytes = fs.readFileSync(boundaryFile);
    fs.writeFileSync(boundaryFile, JSON.stringify({ ...stored.boundary, appliedAtBasis: { ...stored.boundary.appliedAtBasis,
      onboardingSession: { ...stored.boundary.appliedAtBasis.onboardingSession, id: selected.sessionId } } }));
    assert.throws(() => readHistoricalBoundaryApplication({ root, projectId: basis.projectId, requireCommitted: true, storage }), { code: "HISTORICAL_BOUNDARY_DIGEST_MISMATCH" });
    fs.writeFileSync(boundaryFile, boundaryBytes);
  });
});
