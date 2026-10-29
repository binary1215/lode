import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { createRecoveryCheckpoint, inspectCompaction, prepareCompactionFromCurrentCheckpoint, settleCompactionContinuation } from "../scripts/lib/compaction-recovery.mjs";
import {
  enterConversationRecovery,
  InMemoryCompactionLifecycleHostAdapter,
  processCompactionLifecycle,
} from "../scripts/lib/compaction-lifecycle.mjs";
import { formatCliResult } from "../scripts/lib/cli-presentation.mjs";
import { dispatch, catalogTools as mcpTools } from "../scripts/mcp-server.mjs";
import { runCommand } from "../scripts/head.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");

function temporaryProject(prefix = "head-compaction-lifecycle-test-") {
  const parent = process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, prefix));
  initializeProject({ root, pluginRoot, runtimes: ["codex", "claude", "opencode"] });
  const layout = inspectProject(root).storage;
  return { root, layout };
}

function direction(overrides = {}) {
  return {
    purpose: "Preserve the current whole outcome across provider compaction",
    approvedDecisions: ["P2 artifacts remain recovery authority"],
    currentPosition: "Automatic lifecycle recovery is being verified",
    nextExpectedResult: "Continue the original task without a user recovery ritual",
    openReviewIds: [],
    ...overrides,
  };
}

function checkpoint(root, overrides = {}) {
  return createRecoveryCheckpoint({ root, ...direction(overrides) }).checkpoint;
}

function event(root, kind, overrides = {}) {
  const inspected = inspectProject(root);
  return {
    eventId: `compaction-event-${kind}-${Math.random().toString(16).slice(2)}`,
    kind,
    projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId,
    runtime: "codex",
    userTurnId: 10,
    epochId: null,
    outcome: null,
    ...overrides,
  };
}

async function enqueue(adapter, value) {
  (await adapter.enqueue(value));
  return adapter;
}

function projectFiles(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort();
}

test("durable continuation consumption with interrupted epoch commit closes only P5 and restores P2 without replay", async (t) => {
  const { root, layout } = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const canonical = checkpoint(root);
  const host = (await enqueue(new InMemoryCompactionLifecycleHostAdapter(), event(root, "before-compaction")));
  const prepared = (await processCompactionLifecycle({ root, hostAdapter: host }));
  const epochId = prepared.epoch.epochId;
  (await enqueue(host, event(root, "after-compaction", { epochId, outcome: "succeeded" })));
  const nonTransportBytes = () => Object.fromEntries(projectFiles(root)
    .filter((file) => !file.startsWith(`${layout.directory}/sessions/compaction/`))
    .map((file) => [file, fs.readFileSync(path.join(root, file), "base64")]));
  const authorityBefore = nonTransportBytes();
  const rename = fs.renameSync;
  let faultInjected = false;
  fs.renameSync = (source, target) => {
    if (String(target).endsWith(`${epochId}.json`) && JSON.parse(fs.readFileSync(source, "utf8")).state === "continued") {
      faultInjected = true;
      throw Object.assign(new Error("injected continued epoch commit failure"), { code: "EIO" });
    }
    return rename(source, target);
  };
  try { (await assert.rejects(async () => (await processCompactionLifecycle({ root, hostAdapter: host })), { code: "EIO" })); }
  finally { fs.renameSync = rename; }
  assert.equal(faultInjected, true);
  const epochFile = path.join(root, layout.directory, "sessions/compaction/epochs", `${epochId}.json`);
  const interruptedBytes = fs.readFileSync(epochFile);
  const status = inspectCompaction({ root });
  assert.equal(status.epoch.state, "verified");
  assert.equal(status.continuationOutcome, "uncertain");
  assert.equal((await enterConversationRecovery({ root })).restore.checkpoint.checkpointId, canonical.checkpointId);
  assert.deepEqual(fs.readFileSync(epochFile), interruptedBytes, "read-only status must not settle transport");
  assert.deepEqual(nonTransportBytes(), authorityBefore);
  host.loadContinuation = () => { assert.fail("a consumed continuation must never be loaded again"); };
  for (const kind of ["conversation-entry", "provider-replaced"]) {
    const replacementHost = (await enqueue(new InMemoryCompactionLifecycleHostAdapter(), event(root, kind, { userTurnId: 11 })));
    const entry = (await processCompactionLifecycle({ root, hostAdapter: replacementHost }));
    assert.equal(entry.status, "conversation_direction_restored");
    assert.equal(entry.conversationEntry.restore.checkpoint.checkpointId, canonical.checkpointId);
    assert.equal(entry.ordinaryWorkBlocked, false);
    assert.equal(entry.userDecisionRequired, false);
    assert.equal(replacementHost.inspectHostState().pendingEventCount, 0);
    assert.deepEqual(nonTransportBytes(), authorityBefore);
  }
  const acknowledge = host.acknowledge.bind(host);
  host.acknowledge = () => { throw new Error("lost ack"); };
  const resumed = (await processCompactionLifecycle({ root, hostAdapter: host }));
  assert.equal(resumed.status, "conversation_direction_restored_after_uncertain_continuation");
  assert.equal(resumed.providerContinuationOutcome, "uncertain");
  assert.equal(resumed.continuationConsumed, true);
  assert.equal(resumed.retryAllowed, false);
  assert.equal(resumed.freshLogicalHeadRequired, true);
  assert.equal(resumed.ordinaryWorkBlocked, false);
  assert.equal(resumed.userDecisionRequired, false);
  assert.equal(resumed.authorityChanged, false);
  assert.equal(resumed.conversationEntry.restore.checkpoint.checkpointId, canonical.checkpointId);
  assert.equal(Object.hasOwn(resumed, "continuation"), false);
  const settledBytes = fs.readFileSync(epochFile);
  host.acknowledge = acknowledge;
  assert.equal((await processCompactionLifecycle({ root, hostAdapter: host })).status, resumed.status);
  assert.equal(host.inspectHostState().pendingEventCount, 0);
  assert.deepEqual(fs.readFileSync(epochFile), settledBytes, "ack retry must be byte-idempotent");
  assert.deepEqual(nonTransportBytes(), authorityBefore);
  const next = prepareCompactionFromCurrentCheckpoint({ root, runtime: "codex", userTurnIdAtPrepare: 11 });
  assert.equal(next.checkpoint.checkpointId, canonical.checkpointId);
  assert.notEqual(next.epoch.epochId, epochId);
  assert.deepEqual(nonTransportBytes(), authorityBefore);
  assert.equal(fs.readdirSync(path.join(root, layout.directory, "sessions/compaction/consumptions")).length, 1);
  assert.throws(() => settleCompactionContinuation({ root, epochId }), { code: "COMPACTION_CHECKPOINT_STALE" });
});

test("P5 interrupted-consumption settlement rejects invented or mismatched evidence without modifying P2", (t) => {
  const { root, layout } = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  checkpoint(root);
  const prepared = prepareCompactionFromCurrentCheckpoint({ root, runtime: "codex", userTurnIdAtPrepare: 10 });
  const epochId = prepared.epoch.epochId;
  const session = fs.readFileSync(path.join(root, layout.directory, "sessions/current.json"));
  assert.throws(() => settleCompactionContinuation({ root, epochId }), { code: "INVALID_COMPACTION_CONSUMPTION" });
  const consumptionDir = path.join(root, layout.directory, "sessions/compaction/consumptions");
  fs.mkdirSync(consumptionDir, { recursive: true });
  fs.writeFileSync(path.join(consumptionDir, `${epochId}.json`), JSON.stringify({
    schemaVersion: prepared.epoch.schemaVersion, kind: "CompactionContinuationConsumption",
    epochId, checkpointId: prepared.checkpoint.checkpointId, checkpointDigest: "0".repeat(64),
    consumedAt: new Date().toISOString(), providerSessionIdentityPersisted: false,
  }));
  assert.throws(() => settleCompactionContinuation({ root, epochId }), { code: "INVALID_COMPACTION_CONSUMPTION" });
  assert.equal(inspectCompaction({ root }).continuationConsumption, "invalid");
  assert.equal(inspectCompaction({ root }).epoch.state, "prepared");
  assert.deepEqual(fs.readFileSync(path.join(root, layout.directory, "sessions/current.json")), session);
});

test("conversation entry restores current P2 direction automatically and otherwise creates no gate", async (t) => {
  const { root, layout } = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = fs.readFileSync(path.join(root, layout.directory, "sessions", "current.json"));
  const filesBefore = projectFiles(root);
  const empty = (await enterConversationRecovery({ root }));
  assert.equal(empty.status, "conversation_ready");
  assert.equal(empty.userDecisionRequired, false);
  assert.equal(empty.projectStatus.kind, "HeadProjectExperienceProjection");
  assert.equal(empty.attention.status, "clear");
  assert.equal(empty.ordinaryWorkBlocked, false);
  assert.deepEqual(fs.readFileSync(path.join(root, layout.directory, "sessions", "current.json")), before);
  assert.deepEqual(projectFiles(root), filesBefore);

  const canonical = checkpoint(root);
  const stateAfterCheckpoint = fs.readFileSync(path.join(root, layout.directory, "sessions", "current.json"));
  const restored = (await enterConversationRecovery({ root }));
  assert.equal(restored.status, "conversation_direction_restored");
  assert.equal(restored.restore.checkpoint.checkpointId, canonical.checkpointId);
  assert.equal(restored.restore.projection.consumerInstruction.historicalCheckpointContext.nextExpectedResult, canonical.nextExpectedResult);
  assert.equal(restored.restore.projection.providerBoundary.providerTranscriptUsed, false);
  assert.equal(restored.userDecisionRequired, false);
  assert.equal(Buffer.byteLength(JSON.stringify(restored), "utf8") < 64 * 1024, true);
  assert.deepEqual(fs.readFileSync(path.join(root, layout.directory, "sessions", "current.json")), stateAfterCheckpoint);
});

test("tampered recovery stops only checkpoint-dependent work and never guesses direction", async (t) => {
  const { root, layout } = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const canonical = checkpoint(root);
  const file = path.join(root, layout.directory, "sessions", "ledger", `${canonical.checkpointId}.json`);
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  value.nextExpectedResult = "provider summary supplied direction";
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  const restored = (await enterConversationRecovery({ root }));
  assert.equal(restored.status, "recovery_attention_required");
  assert.equal(restored.recoveryDependentWorkBlocked, true);
  assert.equal(restored.ordinaryWorkBlocked, false);
  assert.equal(restored.userDecisionRequired, false);
  assert.equal(restored.attention.headActionRequired, true);
  assert.equal(Object.hasOwn(restored, "restore"), false);
});

test("lifecycle restores newer P2 direction when its transport token becomes stale", async (t) => {
  const { root, layout } = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const host = new InMemoryCompactionLifecycleHostAdapter();
  (await enqueue(host, event(root, "before-compaction")));
  (await processCompactionLifecycle({ root, hostAdapter: host, direction: direction() }));
  const prepared = inspectCompaction({ root });
  (await enqueue(host, event(root, "after-compaction", { epochId: prepared.epoch.epochId, outcome: "succeeded" })));
  const load = host.loadContinuation.bind(host);
  let newer;
  host.loadContinuation = (binding) => {
    newer = checkpoint(root, { nextExpectedResult: "Current task B after checkpoint update" });
    return load(binding);
  };
  const acknowledge = host.acknowledge.bind(host);
  host.acknowledge = () => { throw new Error("lost acknowledgement"); };
  const result = (await processCompactionLifecycle({ root, hostAdapter: host }));
  assert.equal(result.status, "conversation_direction_restored_without_transport_continuation");
  assert.equal(result.reasonCode, "COMPACTION_CHECKPOINT_STALE");
  assert.equal(result.continuationConsumed, false);
  assert.equal(result.userDecisionRequired, false);
  assert.equal(result.ordinaryWorkBlocked, false);
  assert.equal(result.recoveryDependentWorkBlocked, false);
  assert.equal(result.conversationEntry.restore.checkpoint.checkpointId, newer.checkpointId);
  assert.equal(result.conversationEntry.restore.projection.consumerInstruction.historicalCheckpointContext.nextExpectedResult, newer.nextExpectedResult);
  assert.equal(inspectCompaction({ root }).epoch.state, "aborted");
  host.acknowledge = acknowledge;
  const replay = (await processCompactionLifecycle({ root, hostAdapter: host }));
  assert.equal(replay.status, "conversation_direction_restored_without_transport_continuation");
  assert.equal(replay.continuationConsumed, false);
  assert.equal(replay.conversationEntry.restore.checkpoint.checkpointId, newer.checkpointId);
  assert.equal(host.inspectHostState().pendingEventCount, 0);
  (await enqueue(host, event(root, "after-compaction", { epochId: prepared.epoch.epochId, outcome: "failed" })));
  (await assert.rejects(async () => (await processCompactionLifecycle({ root, hostAdapter: host })), { code: "COMPACTION_LIFECYCLE_DIVERGENT_OUTCOME" }));
});

test("missing Host lifecycle hooks stay optional while artifact entry recovery remains available", async (t) => {
  const { root, layout } = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  checkpoint(root);
  const result = (await processCompactionLifecycle({ root }));
  assert.equal(result.status, "host_lifecycle_unavailable");
  assert.equal(result.conversationEntry.status, "conversation_direction_restored");
  assert.equal(result.ordinaryWorkBlocked, false);
  assert.equal(result.userDecisionRequired, false);
});

test("before-compaction reuses an exact current checkpoint and keeps the raw token Host-local", async (t) => {
  const { root, layout } = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const canonical = checkpoint(root);
  const stateBefore = fs.readFileSync(path.join(root, layout.directory, "sessions", "current.json"));
  const adapter = (await enqueue(new InMemoryCompactionLifecycleHostAdapter(), event(root, "before-compaction")));
  const prepared = (await processCompactionLifecycle({ root, hostAdapter: adapter }));
  assert.equal(prepared.status, "compaction_lifecycle_prepared");
  assert.equal(prepared.checkpointReused, true);
  assert.equal(prepared.checkpoint.checkpointId, canonical.checkpointId);
  assert.equal(prepared.continuationTokenDisclosed, false);
  assert.equal(Object.hasOwn(prepared, "continuationToken"), false);
  assert.equal(adapter.inspectHostState().retainedContinuationCount, 1);
  assert.match(formatCliResult("compaction-lifecycle-step", prepared), /User action: none/u);
  assert.doesNotMatch(formatCliResult("compaction-lifecycle-step", prepared), /could not verify/u);
  assert.deepEqual(fs.readFileSync(path.join(root, layout.directory, "sessions", "current.json")), stateBefore);
  const persisted = fs.readFileSync(path.join(root, layout.directory, "sessions", "compaction", "epochs", `${prepared.epoch.epochId}.json`), "utf8");
  const persistedEpoch = JSON.parse(persisted);
  assert.equal(persistedEpoch.providerSessionIdentityPersisted, false);
  assert.equal(Object.hasOwn(persistedEpoch, "providerSessionId"), false);
  assert.equal(Object.hasOwn(persistedEpoch, "continuationToken"), false);
});

test("HEAD authors missing recovery direction internally instead of asking the user for lifecycle JSON", async (t) => {
  const { root, layout } = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapter = (await enqueue(new InMemoryCompactionLifecycleHostAdapter(), event(root, "before-compaction")));
  const needsHead = (await processCompactionLifecycle({ root, hostAdapter: adapter }));
  assert.equal(needsHead.status, "head_direction_required");
  assert.equal(needsHead.headActionRequired, true);
  assert.equal(needsHead.userDecisionRequired, false);
  assert.equal(needsHead.ordinaryWorkBlocked, false);
  const prepared = (await processCompactionLifecycle({ root, hostAdapter: adapter, direction: direction() }));
  assert.equal(prepared.status, "compaction_lifecycle_prepared");
  assert.equal(prepared.checkpointReused, false);
});

test("successful after-compaction restores P2 first, consumes once, and duplicate delivery converges", async (t) => {
  const { root, layout } = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  checkpoint(root);
  const adapter = (await enqueue(new InMemoryCompactionLifecycleHostAdapter(), event(root, "before-compaction")));
  const prepared = (await processCompactionLifecycle({ root, hostAdapter: adapter }));
  const after = event(root, "after-compaction", { epochId: prepared.epoch.epochId, outcome: "succeeded" });
  (await adapter.enqueue(after));
  const continued = (await processCompactionLifecycle({ root, hostAdapter: adapter }));
  assert.equal(continued.status, "compaction_lifecycle_continued");
  assert.equal(continued.conversationEntry.status, "conversation_direction_restored");
  assert.equal(continued.continuationConsumed, true);
  assert.equal(inspectCompaction({ root }).epoch.state, "continued");

  (await adapter.enqueue({ ...after, eventId: `${after.eventId}-duplicate` }));
  const duplicate = (await processCompactionLifecycle({ root, hostAdapter: adapter }));
  assert.equal(duplicate.status, "compaction_lifecycle_already_continued");
  assert.equal(duplicate.continuationConsumed, true);

  (await adapter.enqueue({ ...after, eventId: `${after.eventId}-divergent`, outcome: "failed" }));
  (await assert.rejects(async () => (await processCompactionLifecycle({ root, hostAdapter: adapter })), { code: "COMPACTION_LIFECYCLE_DIVERGENT_OUTCOME" }));
});

test("uncertain, failed, and newer-turn outcomes never replay or silently continue", async (t) => {
  const roots = [temporaryProject().root, temporaryProject().root, temporaryProject().root];
  t.after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
  for (const root of roots) checkpoint(root);

  const uncertainHost = (await enqueue(new InMemoryCompactionLifecycleHostAdapter(), event(roots[0], "before-compaction")));
  const uncertainPrepared = (await processCompactionLifecycle({ root: roots[0], hostAdapter: uncertainHost }));
  (await uncertainHost.enqueue(event(roots[0], "after-compaction", { epochId: uncertainPrepared.epoch.epochId, outcome: "uncertain" })));
  const uncertain = (await processCompactionLifecycle({ root: roots[0], hostAdapter: uncertainHost }));
  assert.equal(uncertain.status, "provider_compaction_outcome_uncertain");
  assert.equal(uncertain.retryAllowed, false);
  assert.equal(uncertain.continuationConsumed, false);
  assert.equal(inspectCompaction({ root: roots[0] }).epoch.state, "prepared");

  const failedHost = (await enqueue(new InMemoryCompactionLifecycleHostAdapter(), event(roots[1], "before-compaction")));
  const failedPrepared = (await processCompactionLifecycle({ root: roots[1], hostAdapter: failedHost }));
  (await failedHost.enqueue(event(roots[1], "after-compaction", { epochId: failedPrepared.epoch.epochId, outcome: "failed" })));
  const failed = (await processCompactionLifecycle({ root: roots[1], hostAdapter: failedHost }));
  assert.equal(failed.status, "provider_compaction_failed");
  assert.equal(inspectCompaction({ root: roots[1] }).epoch.state, "aborted");

  const newerHost = (await enqueue(new InMemoryCompactionLifecycleHostAdapter(), event(roots[2], "before-compaction")));
  const newerPrepared = (await processCompactionLifecycle({ root: roots[2], hostAdapter: newerHost }));
  (await newerHost.enqueue(event(roots[2], "after-compaction", { epochId: newerPrepared.epoch.epochId, outcome: "succeeded", userTurnId: 11 })));
  const newer = (await processCompactionLifecycle({ root: roots[2], hostAdapter: newerHost }));
  assert.equal(newer.status, "compaction_lifecycle_superseded");
  assert.equal(newer.continuationConsumed, false);
  assert.equal(inspectCompaction({ root: roots[2] }).epoch.state, "superseded");
});

test("Host token retention and loss fail safely while verified P2 remains usable", async (t) => {
  const roots = [temporaryProject().root, temporaryProject().root];
  t.after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
  for (const root of roots) checkpoint(root);

  class UncertainRetentionHost extends InMemoryCompactionLifecycleHostAdapter {
    retainContinuation() { return { status: "uncertain" }; }
  }
  const retentionHost = (await enqueue(new UncertainRetentionHost(), event(roots[0], "before-compaction")));
  const retention = (await processCompactionLifecycle({ root: roots[0], hostAdapter: retentionHost }));
  assert.equal(retention.status, "recovery_attention_required");
  assert.equal(retention.reasonCode, "COMPACTION_HOST_RETENTION_UNCERTAIN");
  assert.equal(retention.userDecisionRequired, false);
  assert.equal(inspectCompaction({ root: roots[0] }).epoch.state, "aborted");
  assert.equal((await enterConversationRecovery({ root: roots[0] })).status, "conversation_direction_restored");

  class MissingTokenHost extends InMemoryCompactionLifecycleHostAdapter {
    loadContinuation() { return { status: "unavailable" }; }
  }
  const missingHost = (await enqueue(new MissingTokenHost(), event(roots[1], "before-compaction")));
  const prepared = (await processCompactionLifecycle({ root: roots[1], hostAdapter: missingHost }));
  (await missingHost.enqueue(event(roots[1], "after-compaction", { epochId: prepared.epoch.epochId, outcome: "succeeded" })));
  const missing = (await processCompactionLifecycle({ root: roots[1], hostAdapter: missingHost }));
  assert.equal(missing.status, "conversation_direction_restored_without_transport_continuation");
  assert.equal(missing.conversationEntry.status, "conversation_direction_restored");
  assert.equal(missing.freshLogicalHeadRequired, true);
  assert.equal(missing.userDecisionRequired, false);
  assert.equal(inspectCompaction({ root: roots[1] }).epoch.state, "aborted");
});

test("conversation-entry and provider replacement restore artifacts and supersede stale transport only", async (t) => {
  const { root, layout } = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  checkpoint(root);
  const adapter = (await enqueue(new InMemoryCompactionLifecycleHostAdapter(), event(root, "before-compaction")));
  const prepared = (await processCompactionLifecycle({ root, hostAdapter: adapter }));
  (await adapter.enqueue(event(root, "provider-replaced", { userTurnId: 11 })));
  const replacement = (await processCompactionLifecycle({ root, hostAdapter: adapter }));
  assert.equal(replacement.status, "conversation_direction_restored");
  assert.equal(replacement.pendingContinuationSuperseded, true);
  assert.equal(replacement.conversationEntry.restore.checkpoint.checkpointId, prepared.checkpoint.checkpointId);
  assert.equal(inspectCompaction({ root }).epoch.state, "superseded");
});

test("cross-project events and authority-amplifying Host descriptors fail closed", async (t) => {
  const { root, layout } = temporaryProject();
  const { root: other } = temporaryProject();
  t.after(() => [root, other].forEach((item) => fs.rmSync(item, { recursive: true, force: true })));
  const cross = (await enqueue(new InMemoryCompactionLifecycleHostAdapter(), event(other, "conversation-entry")));
  (await assert.rejects(async () => (await processCompactionLifecycle({ root, hostAdapter: cross })), { code: "COMPACTION_LIFECYCLE_PROJECT_MISMATCH" }));

  const base = new InMemoryCompactionLifecycleHostAdapter();
  const bad = {
    describe: () => ({ ...base.describe(), recoveryAuthority: true }),
    nextEvent: (...args) => base.nextEvent(...args),
    retainContinuation: (...args) => base.retainContinuation(...args),
    loadContinuation: (...args) => base.loadContinuation(...args),
    acknowledge: (...args) => base.acknowledge(...args),
  };
  (await assert.rejects(async () => (await processCompactionLifecycle({ root, hostAdapter: bad })), { code: "COMPACTION_LIFECYCLE_AUTHORITY_VIOLATION" }));
});

test("MCP and CLI expose the same Core behavior without making recovery a user ritual", async (t) => {
  const { root, layout } = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  checkpoint(root);
  assert.equal(mcpTools.some((tool) => tool.name === "lode_conversation_enter"), true);
  assert.equal(mcpTools.some((tool) => tool.name === "lode_compaction_lifecycle_step"), true);
  assert.equal((await runCommand(["help"])).commands.some((command) => command.includes("conversation-enter")), false);
  assert.equal((await runCommand(["help-all"])).commands.some((command) => command.includes("conversation-enter")), true);
  assert.equal((await runCommand(["conversation-enter", root])).status, "conversation_direction_restored");
  assert.equal((await runCommand(["compaction-lifecycle-step", root])).status, "host_lifecycle_unavailable");

  const mcp = await dispatch({
    jsonrpc: "2.0",
    id: 901,
    method: "tools/call",
    params: { name: "head_conversation_enter", arguments: { project_root: root } },
  });
  assert.equal(mcp.result.structuredContent.status, "conversation_direction_restored");
  assert.match(mcp.result.content[0].text, /continue the task/u);
  assert.doesNotMatch(mcp.result.content[0].text, /checkpoint-[a-f0-9]{24}/u);
  const cli = formatCliResult("conversation-enter", (await runCommand(["conversation-enter", root])));
  assert.match(cli, /continue the task/u);
  assert.doesNotMatch(cli, /checkpoint-[a-f0-9]{24}/u);
});
