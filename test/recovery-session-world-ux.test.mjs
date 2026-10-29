import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/lode-core.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { createWholePlanSnapshot, createExecutionContract } from "../scripts/lib/execution-lineage.mjs";
import { startRun, finishRun, reviewRun, getPendingReviewContext } from "../scripts/lib/run-lineage.mjs";
import { createRecoveryCheckpoint, prepareCompaction, verifyCompaction, continueCompaction } from "../scripts/lib/compaction-recovery.mjs";
import { restoreSessionFromArtifacts } from "../scripts/lib/session-recovery.mjs";
import { createHeadSession, createSessionCallContext, withSessionCallContext, withSessionRoute } from "../scripts/lib/session-routing.mjs";
import { updateProjectDirection } from "../scripts/lib/project-direction.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { formatCliResult, formatProjectStatus, formatSessionRestore, formatConversationRecovery } from "../scripts/lib/cli-presentation.mjs";

// head_* request inputs below deliberately exercise compatibility dispatch;
// generated catalog and Hook assertions use the canonical Lode vocabulary.
const pluginRoot = path.resolve(import.meta.dirname, "..");
const direction = { purpose: "Preserve the task", currentPosition: "Before bounded work", nextExpectedResult: "Historical step, not a new execution authorization" };
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "head-recovery-v2-")));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  assert.equal(storage.directory, ".lode");
  assert.equal(fs.existsSync(path.resolve(root, ".lode/project.json")), true);
  assert.equal(fs.existsSync(path.resolve(root, ".head/project.json")), false);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, storage };
}
async function contract(root) {
  const capsule = (await compileContext({ root, task: "Inspect a synthetic local library", persist: true })).capsule;
  const plan = createWholePlanSnapshot({ root, objective: "Inspect a synthetic local library", plan: [{ id: "inspect", outcome: "Bounded evidence" }], invariants: ["No external effects"] }).artifact;
  return createExecutionContract({ root, wholePlanId: plan.wholePlanId, capsuleId: capsule.capsuleId, scope: "Local evidence", acceptanceCriteria: ["Exact result"] }).artifact;
}
function bytes(root) {
  const entries = [];
  const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.isFile()) entries.push([path.relative(root, file), crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]);
  } };
  walk(root);
  return entries.sort((a, b) => a[0].localeCompare(b[0]));
}
const call = (root, name, args = {}, options = {}) => dispatch({ jsonrpc: "2.0", id: "local-fixture", method: "tools/call", params: { name, arguments: { project_root: root, ...args } } }, options);

test("checkpoint/start/finish/review restore current facts without rewriting meaning or replaying historical actions", async (t) => {
  const { root, storage } = fixture(t), c = (await contract(root));
  const checkpoint = createRecoveryCheckpoint({ root, ...direction }).checkpoint;
  const ledger = path.join(root, storage.directory, "sessions", "ledger", `${checkpoint.checkpointId}.json`);
  const checkpointBytes = fs.readFileSync(ledger);
  const trace = [];
  trace.push("start");
  const started = await call(root, "head_run_start", { execution_contract_id: c.executionContractId, start_request_id: "logical-request-one" });
  assert.equal(started.result.structuredContent.status, "run_started");
  const active = restoreSessionFromArtifacts({ root });
  assert.equal(active.projection.currentExecution.activeRun.runId, started.result.structuredContent.run.runId);
  assert.equal(active.projection.checkpointMatchesCurrentExecution, false);
  assert.equal(active.projection.consumerInstruction.nextExpectedResult, undefined);
  assert.equal(active.projection.consumerInstruction.historicalCheckpointContext.nextExpectedResult, direction.nextExpectedResult);
  trace.push("finish");
  finishRun({ root, outcome: "Local evidence returned", evidence: [{ uri: "synthetic", digest: "evidence" }], verification: [{ check: "read", status: "passed" }] });
  trace.push("pending-review");
  const review = getPendingReviewContext({ root });
  trace.push("review");
  reviewRun({ root, reviewContextId: review.review.reviewContextId, disposition: "accept", rationale: "Bounded evidence inspected" });
  updateProjectDirection({ root, input: { goal: "Preserve the task", cancelledActions: ["deploy"], constraints: ["Local only"], decisions: [] } });
  const beforeEntry = bytes(root);
  trace.push("entry");
  const entry = (await call(root, "head_conversation_enter")).result.structuredContent;
  assert.equal(entry.ordinaryWorkBlocked, false);
  assert.equal(entry.restore.projection.currentExecution.sessionPointer.mode, "session");
  assert.equal(entry.restore.projection.lastReviewDecision.disposition, "accept");
  assert.deepEqual(entry.restore.projection.currentProjectDirection.input.cancelledActions, ["deploy"]);
  assert.deepEqual(bytes(root), beforeEntry);
  assert.deepEqual(fs.readFileSync(ledger), checkpointBytes);
  assert.deepEqual(trace, ["start", "finish", "pending-review", "review", "entry"]);
  const retry = await call(root, "head_run_start", { execution_contract_id: c.executionContractId, start_request_id: "logical-request-one" });
  assert.equal(retry.result.structuredContent.status, "run_start_already_committed");
  assert.equal(retry.result.structuredContent.executionReplayAllowed, false);
  assert.deepEqual(bytes(root), beforeEntry);
});

test("trusted caller contexts preserve A/B, sharing, explicit default and known loss without global selectors", async (t) => {
  const { root, storage } = fixture(t), original = inspectProject(root).state.sessionId;
  const a = createHeadSession({ root, purpose: "A" }), b = createHeadSession({ root, purpose: "B" });
  const first = createSessionCallContext(), second = createSessionCallContext();
  const selected = await Promise.all([
    call(root, "head_project_status", { session_id: a.sessionId }, { sessionContext: first }),
    call(root, "head_project_status", { session_id: b.sessionId }, { sessionContext: second }),
  ]);
  assert.equal(selected[0].result.structuredContent.project.sessionId, a.sessionId);
  assert.equal(selected[1].result.structuredContent.project.sessionId, b.sessionId);
  assert.equal((await call(root, "head_project_status", {}, { sessionContext: first })).result.structuredContent.project.sessionId, a.sessionId);
  second.select(root, a.sessionId);
  assert.equal((await call(root, "head_project_status", {}, { sessionContext: second })).result.structuredContent.project.sessionId, a.sessionId);
  assert.equal(inspectProject(root).state.sessionId, original);
  first.lose(root);
  const before = bytes(root);
  for (const name of ["head_project_status", "head_session_restore", "head_conversation_enter", "head_run_start",
    "head_compact_prepare", "head_compact_verify", "head_compact_continue", "head_compact_status", "head_compact_abort", "head_continuity_snapshot"]) {
    const unresolved = (await call(root, name, {}, { sessionContext: first })).result.structuredContent;
    assert.equal(unresolved.status, "session_selection_unresolved");
    assert.equal(unresolved.sessionId, null);
    assert.equal(unresolved.ordinaryWorkBlocked, false);
    assert.equal(unresolved.userDecisionRequired, false);
  }
  const independent = await call(root, "head_project_direction_read", {}, { sessionContext: first });
  assert.equal(independent.error, undefined);
  const brokenResolver = () => { throw Object.assign(new Error("Host binding unavailable"), { code: "HEAD_SESSION_CONTEXT_UNAVAILABLE" }); };
  assert.equal((await call(root, "head_project_status", {}, { resolveSessionContext: brokenResolver })).result.structuredContent.sessionId, null);
  const routed = await dispatch({ jsonrpc: "2.0", id: "wrapped-status", method: "tools/call", params: {
    name: "head_tools_read", arguments: { name: "head_compact_status", arguments: { project_root: root } },
  } }, { sessionContext: first });
  assert.equal(routed.result.structuredContent.status, "session_selection_unresolved");
  assert.equal((await call(root, "head_project_direction_read", {}, { resolveSessionContext: brokenResolver })).error, undefined);
  assert.deepEqual(bytes(root), before);
  const defaultAgain = await call(root, "head_project_status", { session_id: "" }, { sessionContext: first });
  assert.equal(defaultAgain.result.structuredContent.project.sessionId, original);
  assert.equal(first.read(root).status, "default");
  assert.throws(() => withSessionCallContext({ root, context: { read() { return { sessionId: a.sessionId }; } } }, () => {}), { code: "INVALID_HEAD_SESSION_CALL_CONTEXT" });
  assert.throws(() => first.select(root, b.sessionId, 0), { code: "HEAD_SESSION_BINDING_CONFLICT" });
});

test("CLI context and explicit routes agree; no checkpoint and unsupported binding remain nonblocking", async (t) => {
  const { root, storage } = fixture(t), a = createHeadSession({ root, purpose: "A" }), context = createSessionCallContext();
  const initial = (await runCommand(["conversation-enter", root]));
  assert.equal(initial.recoveryState, "no-current-checkpoint");
  assert.equal(initial.ordinaryWorkBlocked, false);
  (await runCommand(["status", root, "--session", a.sessionId], { sessionContext: context }));
  assert.equal((await runCommand(["status", root], { sessionContext: context })).project.sessionId, a.sessionId);
  context.lose(root);
  assert.equal((await runCommand(["status", root], { sessionContext: context })).sessionId, null);
  assert.equal((await runCommand(["project-direction-read", root], { sessionContext: context })), null);
  assert.equal(withSessionRoute(root, a.sessionId, () => inspectProject(root).state.sessionId), a.sessionId);
});

test("explicit MCP routing survives unavailable Host persistence without guessing or changing another caller", async (t) => {
  const { root, storage } = fixture(t), a = createHeadSession({ root, purpose: "Explicit route" }), b = createHeadSession({ root, purpose: "Other caller" });
  withSessionRoute(root, a.sessionId, () => createRecoveryCheckpoint({ root, ...direction }));
  const other = createSessionCallContext(); other.select(root, b.sessionId);
  const otherBefore = other.read(root), before = bytes(root);
  const unavailable = { resolveSessionContext: async () => { throw Object.assign(new Error("Synthetic Host persistence unavailable"), { code: "SYNTHETIC_BINDING_UNAVAILABLE" }); } };
  const reference = await call(root, "head_session_restore", { session_id: a.sessionId });
  for (const route of [null, "head_tools_read", "head_tools_call"]) {
    const request = { jsonrpc: "2.0", id: "explicit-route", method: "tools/call", params: route
      ? { name: route, arguments: { name: "head_session_restore", arguments: { project_root: root, session_id: a.sessionId } } }
      : { name: "head_session_restore", arguments: { project_root: root, session_id: a.sessionId } } };
    const restored = await dispatch(request, unavailable);
    assert.deepEqual(restored.result.structuredContent, reference.result.structuredContent);
    assert.equal(restored.result.structuredContent.projection.sessionId, a.sessionId);
    assert.deepEqual(restored.result.content, reference.result.content, "Host metadata must not replace the existing MCP presentation");
    assert.deepEqual(restored.result._meta.headSessionBinding, { status: "unavailable", reasonCode: "SYNTHETIC_BINDING_UNAVAILABLE", scope: "current-explicit-request-only", retainedForSubsequentCalls: false, persisted: false });
  }
  assert.equal((await call(root, "head_session_restore", {}, unavailable)).result.structuredContent.status, "session_selection_unresolved");
  const foreign = createHeadSession({ root: fixture(t).root, purpose: "Foreign owner" });
  for (const session_id of ["not-a-session", foreign.sessionId, null, undefined, 42]) {
    const rejected = await call(root, "head_session_restore", { session_id }, unavailable);
    assert(rejected.error, "resolver failure must not bypass explicit identity verification");
    assert.equal(rejected.result, undefined);
  }
  const explicitDefault = await call(root, "head_project_status", { session_id: "" }, unavailable);
  assert.equal(explicitDefault.result.structuredContent.project.sessionId, inspectProject(root).state.sessionId);
  const selectedFile = path.join(root, storage.directory, "sessions/by-id", a.sessionId, "current.json"), selectedBytes = fs.readFileSync(selectedFile);
  try {
    const state = JSON.parse(selectedBytes); state.projectId = "head-foreign";
    fs.writeFileSync(selectedFile, JSON.stringify(state));
    assert((await call(root, "head_session_restore", { session_id: a.sessionId }, unavailable)).error);
  } finally { fs.writeFileSync(selectedFile, selectedBytes); }
  assert.deepEqual(other.read(root), otherBefore);
  assert.deepEqual(bytes(root), before);
});

test("lost caller binding never gates CLI information or Project evidence but still guards selected Session facts", async (t) => {
  const { root, storage } = fixture(t), selected = createHeadSession({ root, purpose: "Lost caller" }), context = createSessionCallContext();
  fs.writeFileSync(path.join(root, "independent.mjs"), "export const observed = true;\n");
  context.select(root, selected.sessionId); context.lose(root);
  const before = bytes(root), binding = context.read(root);
  for (const name of ["version", "--version", "help", "--help", "-h", "help-all", "observation-sources", "observation-query", "session-list", "project-direction-read"]) {
    assert.deepEqual(await runCommand([name, root], { sessionContext: context }), await runCommand([name, root]));
  }
  assert.deepEqual((await runCommand(["version"], { sessionContext: context })), (await runCommand(["version"])), "global information requires no initialized Project");
  const source = await runCommand(["source-context", root, "--task", "Inspect local source", "--source", "independent.mjs", "--kind", "source"], { sessionContext: context });
  assert.equal(source.status, "observed");
  assert.equal(source.context.capsule.sessionId, undefined, "Project-only evidence must not claim the default is the selected Session");
  for (const name of ["status", "doctor", "session-restore", "session-continue", "run-start", "run-finish", "run-review", "compact-status", "checkpoint-basis", "world-status", "product-operating-status"]) {
    const unresolved = await runCommand([name, root], { sessionContext: context });
    assert.equal(unresolved.status, "session_selection_unresolved", name);
    assert.equal(unresolved.sessionId, null);
    assert.equal(unresolved.userDecisionRequired, false);
  }
  assert.equal((await call(root, "head_observation_sources", {}, { sessionContext: context })).result.structuredContent.status, "available");
  assert.equal((await call(root, "head_product_operating_status", {}, { sessionContext: context })).result.structuredContent.status, "session_selection_unresolved");
  assert.deepEqual(context.read(root), binding);
  assert.deepEqual(bytes(root), before);
});

test("general meaning recovery cannot relax exact one-shot targets or consumed tokens", (t) => {
  const { root: badRoot, storage: badStorage } = fixture(t);
  const invalid = prepareCompaction({ root: badRoot, runtime: "codex", userTurnIdAtPrepare: 7, ...direction });
  assert.throws(() => verifyCompaction({ root: badRoot, epochId: invalid.epoch.epochId, checkpointDigest: "0".repeat(64), currentUserTurnId: 7, providerCompacted: true }));
  const { root, storage } = fixture(t);
  const prepared = prepareCompaction({ root, runtime: "codex", userTurnIdAtPrepare: 7, ...direction });
  const epochId = prepared.epoch.epochId, checkpointDigest = prepared.checkpoint.checkpointDigest;
  verifyCompaction({ root, epochId, checkpointDigest, currentUserTurnId: 7, providerCompacted: true });
  const token = prepared.continuationToken;
  assert.ok(token);
  continueCompaction({ root, epochId, continuationToken: token, currentUserTurnId: 7 });
  assert.throws(() => continueCompaction({ root, epochId, continuationToken: token, currentUserTurnId: 7 }));
  assert.equal(restoreSessionFromArtifacts({ root }).projection.consumerInstruction.nextExpectedResult, undefined);
});

test("operational lock cleanup failure after commit never changes the original retry target", async (t) => {
  const { root, storage } = fixture(t), c = (await contract(root)), unlink = fs.unlinkSync;
  let result;
  fs.unlinkSync = function(file, ...args) {
    if (String(file).includes("session-recovery.lock") && path.basename(String(file)).startsWith("owner-")) throw Object.assign(new Error("Synthetic release failure"), { code: "EIO" });
    return unlink.call(this, file, ...args);
  };
  try { result = startRun({ root, executionContractId: c.executionContractId, startRequestId: "cleanup-boundary" }); }
  finally { fs.unlinkSync = unlink; }
  assert.equal(result.canonicalCommit, "committed");
  assert.equal(result.operationalCleanup.status, "incomplete");
  assert.equal(result.executionReplayAllowed, false);
  assert.equal(inspectProject(root).state.activeRunId, result.run.runId);
});

test("a demonstrably default-owned historical active Run is not another Session's start gate", async (t) => {
  const { root, storage } = fixture(t), c = (await contract(root));
  const original = startRun({ root, executionContractId: c.executionContractId });
  const file = path.join(root, storage.directory, "sessions/runs", original.run.runId, "run.json");
  const legacy = JSON.parse(fs.readFileSync(file));
  delete legacy.sessionId; delete legacy.startOperation; delete legacy.sessionTransition;
  fs.writeFileSync(file, JSON.stringify(legacy));
  const defaultBytes = fs.readFileSync(path.join(root, storage.directory, "sessions/current.json"));
  const second = createHeadSession({ root, purpose: "Independent bounded work" });
  const started = (await withSessionRoute(root, second.sessionId, async () => startRun({ root, executionContractId: (await contract(root)).executionContractId, startRequestId: "independent-session" })));
  assert.equal(started.run.sessionId, second.sessionId);
  assert.deepEqual(fs.readFileSync(path.join(root, storage.directory, "sessions/current.json")), defaultBytes);
});

test("partial availability: mixed reads expose only Project facts without fallback reads or writes", async (t) => {
  const { root, storage } = fixture(t), selected = createHeadSession({ root, purpose: "Not a fallback" });
  const common = updateProjectDirection({ root, input: { goal: "Inspect synthetic code", constraints: ["Keep local"], cancelledActions: ["deploy"] } }).direction;
  const context = createSessionCallContext(); context.select(root, selected.sessionId); context.lose(root);
  // Even a damaged default cannot be consulted to fill an unselected response.
  fs.writeFileSync(path.join(root, storage.directory, "sessions/current.json"), "{damaged-default");
  const before = bytes(root), binding = context.read(root), reads = [], writes = [];
  const original = Object.fromEntries(["readFileSync", "readdirSync", "writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "unlinkSync"].map(key => [key, fs[key]]));
  const values = [];
  try {
    for (const key of ["readFileSync", "readdirSync"]) fs[key] = function(file, ...args) {
      const relative = path.relative(root, String(file)).replaceAll("\\", "/"); reads.push(relative);
      if (relative.startsWith(`${storage.directory}/`)) assert(relative === `${storage.directory}/project.json` || relative.startsWith(`${storage.directory}/project-direction/`), `unexpected partial read: ${relative}`);
      return original[key].call(this, file, ...args);
    };
    for (const key of ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "unlinkSync"]) fs[key] = function(...args) { writes.push(key); throw new Error(`partial read attempted ${key}`); };
    for (const options of [{ sessionContext: context }, { resolveSessionContext() { throw Object.assign(new Error("Host unavailable"), { code: "HOST_UNAVAILABLE" }); } }]) {
      for (const name of ["head_project_status", "head_conversation_enter"]) for (const route of [null, "head_tools_read", "head_tools_call"]) {
        const response = await dispatch({ jsonrpc: "2.0", id: "partial", method: "tools/call", params: route
          ? { name: route, arguments: { name, arguments: { project_root: root } } }
          : { name, arguments: { project_root: root } } }, options);
        assert.equal(response.error, undefined);
        const value = response.result.structuredContent; values.push(value);
        assert.equal(value.status, "session_selection_unresolved");
        assert.equal(value.project.projectRoot, root); assert.equal(value.project.projectId, common.projectId);
        assert.deepEqual(value.currentProjectDirection, common);
        assert.equal(value.availability.project, "identity_verified");
        for (const field of ["session", "run", "recovery"]) assert.equal(value.availability[field], "unavailable");
        assert.equal(value.availability.managedProjectionDrift, "not_assessed");
        assert.equal(value.sessionId, null); assert.equal(value.state, undefined); assert.equal(value.restore, undefined);
        assert.equal(value.ordinaryWorkBlocked, false); assert.equal(value.userDecisionRequired, false);
        assert.equal(value.executionReplayAllowed, false); assert.equal(value.persisted, false);
        assert.equal(value.nextAction.id, "continue_independent_work"); assert.equal(value.presentation.mode, "exception");
        assert.equal(value.headActionScope, "selected-session-dependent-work-only");
        assert.deepEqual(value.affectedOperations, ["selected-session-read", "selected-session-mutation"]);
        assert.equal(response.result.content[0].text, JSON.stringify(value), "unresolved MCP retains its JSON text transport");
      }
    }
    for (const command of ["status", "doctor", "conversation-enter"]) {
      const value = (await runCommand([command, root], { sessionContext: context }));
      assert.deepEqual(value.project, values[0].project); assert.deepEqual(value.currentProjectDirection, common);
    }
  } finally { Object.assign(fs, original); }
  assert.deepEqual(writes, []); assert(reads.length > 0);
  console.log(JSON.stringify({ partialReads: [...new Set(reads)], writes, damagedDefaultNotRead: true }));
  assert.deepEqual(bytes(root), before); assert.deepEqual(context.read(root), binding);
  assert.equal((await call(root, "head_observation_sources", {}, { sessionContext: context })).result.structuredContent.status, "available");
  assert.equal((await call(root, "head_run_start", {}, { sessionContext: context })).result.structuredContent.status, "session_selection_unresolved");
  assert.deepEqual(bytes(root), before);
});

test("partial availability: unresolved CLI consumers never invent recovery, checkpoint or diagnostics", async (t) => {
  const { root, storage } = fixture(t), context = createSessionCallContext(); context.lose(root);
  for (const command of ["status", "doctor", "conversation-enter", "session-restore", "init", "resume"]) {
    const value = (await runCommand([command, root], { sessionContext: context }));
    assert.equal(value.status, "session_selection_unresolved");
    const text = formatCliResult(command, value);
    assert.match(text, /independent work.*(?:available|continue)/iu);
    assert.match(text, /selected Session/iu);
    assert.doesNotMatch(text, /recovered the current direction|unverified checkpoint|No recovery checkpoint|drift: 0|restart: not required|HEAD is ready/iu);
    if (command === "doctor") { assert.match(text, /drift: not assessed/iu); assert.match(text, /restart: not assessed/iu); }
    assert.equal(JSON.parse(JSON.stringify(value)).status, value.status);
    console.log(JSON.stringify({ command, status: value.status, text }));
  }
  const unresolved = (await runCommand(["status", root], { sessionContext: context }));
  for (const formatter of [formatProjectStatus, formatSessionRestore, formatConversationRecovery]) {
    assert.doesNotMatch(formatter(unresolved), /recovered the current direction|unverified checkpoint|No recovery checkpoint/iu);
  }
});

test("partial availability: missing direction is distinct from corrupt direction or Project identity", async (t) => {
  const { root, storage } = fixture(t), context = createSessionCallContext(); context.lose(root);
  const missing = (await call(root, "head_project_status", {}, { sessionContext: context })).result.structuredContent;
  assert.equal(missing.currentProjectDirection, null); assert.equal(missing.availability.currentProjectDirection, "not_recorded");
  const common = updateProjectDirection({ root, input: { goal: "Current cancellation", cancelledActions: ["deploy"] } }).direction;
  const directionFile = path.join(root, storage.directory, "project-direction/current.json"), directionBytes = fs.readFileSync(directionFile);
  fs.writeFileSync(directionFile, "{");
  try {
    for (const options of [{ sessionContext: context }, { resolveSessionContext() { throw new Error("offline"); } }]) {
      assert((await call(root, "head_conversation_enter", {}, options)).error, "corruption must not become absent direction");
    }
    (await assert.rejects(async () => (await runCommand(["status", root], { sessionContext: context })), { code: "INVALID_PROJECT_DIRECTION" }));
  } finally { fs.writeFileSync(directionFile, directionBytes); }
  assert.equal((await call(root, "head_project_status", {}, { sessionContext: context })).result.structuredContent.currentProjectDirection.directionId, common.directionId);
  const { root: otherRoot, storage: otherStorage } = fixture(t), otherDirection = updateProjectDirection({ root: otherRoot, input: { goal: "Foreign direction" } }).direction;
  const revisionFile = path.join(root, storage.directory, "project-direction/revisions", `${common.directionId}.json`), revisionBytes = fs.readFileSync(revisionFile);
  fs.writeFileSync(revisionFile, JSON.stringify(otherDirection));
  try { assert((await call(root, "head_project_status", {}, { sessionContext: context })).error); }
  finally { fs.writeFileSync(revisionFile, revisionBytes); }
  const projectFile = path.join(root, storage.directory, "project.json"), projectBytes = fs.readFileSync(projectFile), project = JSON.parse(projectBytes);
  try {
    for (const change of [{ projectRoot: "wrong-root" }, { schemaVersion: 99 }, { projectId: null }]) {
      fs.writeFileSync(projectFile, JSON.stringify({ ...project, ...change }));
      assert((await call(root, "head_project_status", {}, { sessionContext: context })).error);
    }
  } finally { fs.writeFileSync(projectFile, projectBytes); }
  const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "head-partial-uninitialized-")));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const emptyContext = createSessionCallContext(); emptyContext.lose(empty);
  (await assert.rejects(async () => (await runCommand(["status", empty], { sessionContext: emptyContext })), { code: "NOT_INITIALIZED" }));
});

test("partial availability: healthy default/bound/explicit output and no-checkpoint meaning stay unchanged", async (t) => {
  const { root, storage } = fixture(t), context = createSessionCallContext();
  for (const name of ["head_project_status", "head_conversation_enter"]) {
    const ordinary = await call(root, name);
    assert.deepEqual((await call(root, name, {}, { sessionContext: context })).result, ordinary.result);
    assert.deepEqual((await call(root, name, { session_id: "" })).result, ordinary.result);
  }
  const selected = createHeadSession({ root, purpose: "Verified selection" });
  const reference = await call(root, "head_conversation_enter", { session_id: selected.sessionId });
  const unavailable = { resolveSessionContext() { throw new Error("optional persistence unavailable"); } };
  const explicit = await call(root, "head_conversation_enter", { session_id: selected.sessionId }, unavailable);
  assert.deepEqual(explicit.result.structuredContent, reference.result.structuredContent);
  assert.deepEqual(explicit.result.content, reference.result.content);
  assert.equal(explicit.result._meta.headSessionBinding.retainedForSubsequentCalls, false);
  assert.equal(reference.result.structuredContent.recoveryState, "no-current-checkpoint");
});

test("partial availability: a changed Project identity cannot mix another valid direction into its facts", async (t) => {
  const { root, storage } = fixture(t), { root: foreignRoot } = fixture(t), context = createSessionCallContext(); context.lose(root);
  const foreign = updateProjectDirection({ root: foreignRoot, input: { goal: "Other Project direction" } }).direction;
  const directory = path.join(root, storage.directory, "project-direction"); fs.mkdirSync(path.join(directory, "revisions"), { recursive: true });
  fs.writeFileSync(path.join(directory, "current.json"), JSON.stringify({ directionId: foreign.directionId }));
  fs.writeFileSync(path.join(directory, "revisions", `${foreign.directionId}.json`), JSON.stringify(foreign));
  const projectFile = path.join(root, storage.directory, "project.json"), project = JSON.parse(fs.readFileSync(projectFile));
  const originalRead = fs.readFileSync; let projectReads = 0;
  fs.readFileSync = function(file, ...args) {
    if (path.resolve(String(file)) === projectFile && ++projectReads > 1) return JSON.stringify({ ...project, projectId: foreign.projectId });
    return originalRead.call(this, file, ...args);
  };
  try {
    for (const name of ["head_project_status", "head_conversation_enter"]) for (const options of [
      { sessionContext: context }, { resolveSessionContext() { throw new Error("Host unavailable"); } },
    ]) {
      projectReads = 0;
      assert((await call(root, name, {}, options)).error, "Project/direction owner mismatch must fail the affected read");
    }
  }
  finally { fs.readFileSync = originalRead; }
});
