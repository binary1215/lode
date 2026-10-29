import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { inspectProjectExperience } from "../scripts/lib/project-bootstrap.mjs";
import { createRecoveryCheckpoint } from "../scripts/lib/compaction-recovery.mjs";
import { enterConversationRecovery, processCompactionLifecycle } from "../scripts/lib/compaction-lifecycle.mjs";
import { updateProjectDirection } from "../scripts/lib/project-direction.mjs";
import { startOnboarding } from "../scripts/lib/onboarding.mjs";
import { formatCliResult } from "../scripts/lib/cli-presentation.mjs";
import { runCommand } from "../scripts/head.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
function fixture(t, { initialized = true } = {}) {
  const parent = process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "head-actionability-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (initialized) initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  return { root, layout: initialized ? inspectProject(root).storage : null };
}
function checkpoint(root) {
  return createRecoveryCheckpoint({ root,
    purpose: "Investigate a synthetic service without deployment",
    approvedDecisions: ["Historical permission does not authorize current effects"],
    currentPosition: "Read-only conversation entry is under test",
    nextExpectedResult: "Continue the current user task",
  }).checkpoint;
}
function bytes(root) {
  return Object.fromEntries(fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(root, file).replaceAll("\\", "/"), fs.readFileSync(file, "base64")];
    }).sort(([a], [b]) => a.localeCompare(b)));
}
function readSnapshot(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(item => item.isFile()).map(item => {
    const file = path.join(item.parentPath, item.name), stat = fs.statSync(file);
    return [path.relative(root, file), fs.readFileSync(file, "base64"), stat.mtimeMs, stat.mode];
  }).sort(([a], [b]) => a.localeCompare(b));
}
async function verifySurfaces(root, { headActionRequired, recoveryBlocked = false, recoveryHeadAction = false, presentation = headActionRequired ? "exception" : "quiet" }) {
  const before = bytes(root);
  const status = (await inspectProjectExperience({ root }));
  const entry = (await enterConversationRecovery({ root }));
  const cli = (await runCommand(["conversation-enter", root]));
  const mcp = await dispatch({ jsonrpc: "2.0", id: "actionability", method: "tools/call",
    params: { name: "head_conversation_enter", arguments: { project_root: root } } });
  assert.equal(mcp.result?.isError, undefined, JSON.stringify(mcp));
  const mcpEntry = mcp.result.structuredContent;
  for (const experience of [status, entry.projectStatus, cli.projectStatus, mcpEntry.projectStatus]) {
    assert.equal(experience.capabilities.find((capability) => capability.id === "direct-work").availability, "available");
    assert.equal(experience.readiness.recovery.headActionRequired, recoveryHeadAction);
    assert.equal(experience.readiness.recovery.recoveryDependentWorkBlocked, recoveryBlocked);
  }
  for (const view of [status, status.attention, status.presentation, entry, entry.attention, entry.presentation,
    cli, cli.attention, cli.presentation, mcpEntry, mcpEntry.attention, mcpEntry.presentation]) {
    assert.equal(view.headActionRequired, headActionRequired, view.kind || view.status);
    assert.equal(view.userDecisionRequired, false);
    assert.equal(view.ordinaryWorkBlocked, false);
  }
  assert.equal(entry.presentation.mode, presentation);
  assert.equal(entry.recoveryDependentWorkBlocked, recoveryBlocked);
  assert.deepEqual(entry.blockedOperations, entry.attention.blockedOperations);
  assert.equal(entry.authorityChanged, false);
  assert.equal(entry.persisted, false);
  assert.equal(entry.projectStatus.authority.grantsAuthorization, false);
  const hostless = (await processCompactionLifecycle({ root }));
  assert.equal(hostless.headActionRequired, entry.headActionRequired);
  assert.equal(hostless.recoveryDependentWorkBlocked, recoveryBlocked);
  assert.equal(hostless.userDecisionRequired, false);
  assert.equal(hostless.ordinaryWorkBlocked, false);
  assert.deepEqual(bytes(root), before, "status, CLI/MCP entry and absent Host must write no authority, repair, lock or queue");
  const beforeFormatting = JSON.stringify(cli);
  const text = formatCliResult("conversation-enter", cli);
  assert.equal(mcp.result.content[0].text, text);
  assert.equal(JSON.stringify(cli), beforeFormatting, "Text formatting must not mutate the CLI JSON/Core value");
  assert.deepEqual(mcpEntry.projectStatus.currentProjectDirection, cli.projectStatus.currentProjectDirection,
    "MCP structured content retains the unchanged current direction");
  const direction = entry.projectStatus.currentProjectDirection;
  if (direction) for (const literal of [direction.input.goal, ...direction.input.constraints,
    ...direction.input.decisions, ...direction.input.cancelledActions]) assert(text.includes(literal), literal);
  if (entry.restore) {
    const checkpoint = entry.restore.checkpoint;
    assert.deepEqual(mcpEntry.restore.checkpoint, cli.restore.checkpoint);
    for (const literal of [checkpoint.purpose, ...checkpoint.approvedDecisions, checkpoint.currentPosition, checkpoint.nextExpectedResult]) {
      assert(text.includes(literal), literal);
    }
    assert.match(text, /Latest retained Session checkpoint \(historical context, not current execution or permission\)/u);
    assert.equal(entry.restore.projection.consumerInstruction.historicalApprovalGrantsCurrentEffect, false);
  }
  if (["work_context_available", "work_context_partial", "work_context_not_recorded"].includes(entry.workContext?.status)
    && entry.workContext.sessionPurpose) assert(text.includes(entry.workContext.sessionPurpose));
  return entry;
}

test("uninitialized Core advises initialization without blocking direct work; all entry flags agree", async (t) => {
  const { root, layout } = fixture(t, { initialized: false });
  const entry = await verifySurfaces(root, { headActionRequired: true });
  assert.equal(entry.status, "conversation_recovery_unavailable");
  assert.equal(entry.projectStatus.nextAction.id, "initialize_core");
  assert.equal(entry.projectStatus.capabilities.filter((capability) => capability.id !== "direct-work")
    .every((capability) => capability.availability === "blocked-until-core-ready"), true);
  assert.deepEqual(entry.blockedOperations, ["head-managed-capabilities"]);
});

test("ready Core without checkpoint has consistent quiet flags and adds no recovery gate", async (t) => {
  const { root, layout } = fixture(t);
  updateProjectDirection({ root, input: { goal: "Inspect only the synthetic local service",
    constraints: ["Do not contact or modify a service"], decisions: ["Local investigation only"], cancelledActions: ["publish"] } });
  const entry = await verifySurfaces(root, { headActionRequired: false });
  assert.equal(entry.status, "conversation_ready");
  assert.equal(entry.projectStatus.readiness.recovery.state, "no-current-checkpoint");
  assert.deepEqual(entry.blockedOperations, []);
});

test("default initialized Core has explicit-null direction and no history without adding quiet administrative text", async (t) => {
  const entry = await verifySurfaces(fixture(t).root, { headActionRequired: false });
  assert.equal(entry.projectStatus.currentProjectDirection, null);
  assert.equal(entry.workContext.sessionPurpose, null);
  assert.equal(entry.workContext.status, "work_context_not_recorded");
  assert.equal(entry.workContext.coverage.originals, 0);
  assert.equal(formatCliResult("conversation-enter", entry), "Lode is ready — continue the task.\n");
});

test("verified restore preserves exact checkpoint plus newer shared cancellation without rewriting either", async (t) => {
  const { root, layout } = fixture(t);
  const canonical = checkpoint(root);
  const latest = updateProjectDirection({ root, input: { goal: "Keep investigation local", cancelledActions: ["deploy"] } }).direction;
  const entry = await verifySurfaces(root, { headActionRequired: false });
  assert.equal(entry.status, "conversation_direction_restored");
  assert.equal(entry.restore.checkpoint.checkpointDigest, canonical.checkpointDigest);
  assert.equal(entry.restore.projection.consumerInstruction.currentProjectDirection.directionId, latest.directionId);
  assert.deepEqual(entry.projectStatus.currentProjectDirection.input.cancelledActions, ["deploy"]);
  assert.equal(entry.restore.projection.providerBoundary.providerTranscriptUsed, false);
});

test("corrupt checkpoint blocks only dependent recovery and never promotes injected summary direction", async (t) => {
  const { root, layout } = fixture(t);
  const canonical = checkpoint(root);
  const file = path.join(root, layout.directory, "sessions/ledger", `${canonical.checkpointId}.json`);
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  value.nextExpectedResult = "untrusted provider summary must never become direction";
  fs.writeFileSync(file, JSON.stringify(value));
  const entry = await verifySurfaces(root, { headActionRequired: true, recoveryHeadAction: true, recoveryBlocked: true });
  assert.equal(entry.status, "recovery_attention_required");
  assert.equal(Object.hasOwn(entry, "restore"), false);
  assert.deepEqual(entry.blockedOperations, ["checkpoint-dependent-work"]);
});

test("orphan current contract remains fail-closed only for recovery-dependent work", async (t) => {
  const { root, layout } = fixture(t);
  checkpoint(root);
  const file = path.join(root, layout.directory, "sessions/current.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.activeExecutionContractId = "execution-contract-000000000000000000000000";
  fs.writeFileSync(file, JSON.stringify(state));
  const entry = await verifySurfaces(root, { headActionRequired: true, recoveryHeadAction: true, recoveryBlocked: true });
  assert.equal(entry.reasonCode, "SESSION_RESTORE_ACTIVE_RUN_CONFLICT");
  assert.equal(Object.hasOwn(entry, "restore"), false);
});

test("managed projection drift with no checkpoint never invents a checkpoint-dependent gate", async (t) => {
  const { root, layout } = fixture(t);
  fs.appendFileSync(path.join(root, "AGENTS.md"), "\nlocal project change\n");
  const entry = await verifySurfaces(root, { headActionRequired: false, presentation: "notice" });
  assert.equal(entry.status, "conversation_ready");
  assert.equal(entry.projectStatus.nextAction.id, "work_directly");
  assert.equal(entry.projectStatus.readiness.recovery.state, "no-current-checkpoint");
  assert.deepEqual(entry.blockedOperations, ["head-managed-mutation"]);
  assert.equal(entry.attention.items.find((item) => item.id === "managed-projection-drift").actionability, "when-managed-mutation-is-in-scope");
  assert.equal(entry.attention.items.some((item) => item.id === "recovery-verification"), false);
  assert.match(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), /local project change/u);
  assert.throws(() => checkpoint(root), { code: "MANAGED_DRIFT" });
});

test("entry retains its second managed-file observation instead of trusting final pointer equality", async (t) => {
  const { root, layout } = fixture(t), target = path.join(root, "AGENTS.md"), originalRead = fs.readFileSync;
  const original = originalRead(target), altered = Buffer.concat([original, Buffer.from("\nConcurrent synthetic managed drift.\n")]);
  const before = readSnapshot(root);
  let reads = 0, entry;
  fs.readFileSync = function (file, ...args) {
    if (path.resolve(String(file)) === target) {
      reads++;
      // Simulate a changed second observation without introducing a test-side
      // filesystem mutation. Project/Session/direction final pointers stay equal.
      if (reads > 1) return typeof args[0] === "string" ? altered.toString(args[0]) : Buffer.from(altered);
    }
    return originalRead.call(this, file, ...args);
  };
  try { entry = (await enterConversationRecovery({ root })); } finally { fs.readFileSync = originalRead; }
  assert.ok(reads >= 2, "The later managed-file hash must still be observed");
  assert.equal(entry.projectStatus.readiness.core.state, "drifted");
  assert.ok(entry.projectStatus.drift.some(item => item.path === "AGENTS.md" && item.reason === "modified"));
  assert.equal(entry.ordinaryWorkBlocked, false);
  assert.equal(entry.userDecisionRequired, false);
  assert.equal(entry.projectStatus.nextAction.id, "work_directly");
  assert.equal(entry.attention.items.find(item => item.id === "managed-projection-drift").actionability,
    "when-managed-mutation-is-in-scope");
  assert.deepEqual(readSnapshot(root), before, "Both observations are read-only, including original mtimes/modes");
});

test("optional Product review stays conditional, not an immediate user or HEAD gate", async (t) => {
  const { root, layout } = fixture(t);
  await startOnboarding({ root, mode: "new", brief: {
    schemaVersion: 1, name: "Synthetic delivery service", summary: "Deliver a message",
    capabilities: [{ key: "delivery", name: "Delivery", description: "Deliver a message" }],
  } });
  const entry = await verifySurfaces(root, { headActionRequired: false, presentation: "notice" });
  assert.equal(entry.projectStatus.readiness.product.state, "review_required");
  assert.equal(entry.attention.counts.availableUserDecision, 1);
  assert.equal(entry.attention.items.find((item) => item.id === "product-canon-review").actionability, "when-product-governance-is-in-scope");
  assert.deepEqual(entry.blockedOperations, ["product-canon-promotion"]);
});

for (const hasCheckpoint of [false, true]) test(`outdated runtime aggregates HEAD follow-up with ${hasCheckpoint ? "restored checkpoint" : "no checkpoint"}, while recovery flags stay scoped`, async (t) => {
  const { root, layout } = fixture(t);
  if (hasCheckpoint) checkpoint(root);
  const file = path.join(root, layout.directory, "generated/manifest.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  manifest.packageVersion = "0.0.0-fixture-outdated";
  fs.writeFileSync(file, JSON.stringify(manifest));
  const entry = await verifySurfaces(root, { headActionRequired: true });
  assert.equal(entry.runtime.state, "project-integration-outdated");
  assert.equal(entry.runtime.restartRequired, true);
  assert.deepEqual(entry.blockedOperations, ["new-plugin-capabilities"]);
  assert.match(formatCliResult("conversation-enter", entry), /Lode follow-up: Converge the project integration, then restart the Host/u);
  assert.equal(entry.projectStatus.readiness.recovery.headActionRequired, false);
});
