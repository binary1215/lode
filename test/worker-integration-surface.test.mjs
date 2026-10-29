import { relativeProjectArtifact } from "../scripts/lib/project-storage-format.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { runCommand, usage } from "../scripts/head.mjs";
import { dispatch, toolsForSurface } from "../scripts/mcp-server.mjs";
const tools = toolsForSurface("managed-maintenance");
import { inspectProject } from "../scripts/lib/head-core.mjs";
import { workerIntegrationFixture } from "./helpers/worker-integration-fixture.mjs";
import { formatCliResult, formatMcpToolContent } from "../scripts/lib/cli-presentation.mjs";

console.log(JSON.stringify({ event: "owned-worker-integration-surface-test", pid: process.pid, parentPid: process.ppid,
  command: process.execPath, args: process.argv.slice(1), cwd: process.cwd(), ports: [], actualProviderInvoked: false }));

const fieldNames = { integrationId: "integration_id", authorizationIds: "authorization_ids", maxBytes: "max_bytes",
  basisDigest: "basis_digest", verificationId: "verification_id", planDelta: "plan_delta", impactRadius: "impact_radius", retryKnownNoWrite: "retry_known_no_write" };
const mcpArgs = (root, request) => ({ project_root: root,
  ...Object.fromEntries(Object.entries(request).map(([key, value]) => [fieldNames[key] || key, value])) });
const call = (name, args) => dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { surface: name === "head_worker_integration" ? "managed-maintenance" : "ordinary" });
async function tool(root, request, readOnly = false) {
  const response = await call(readOnly ? "head_worker_integration_status" : "head_worker_integration", mcpArgs(root, request));
  assert.equal(response.error, undefined, response.error?.message);
  return response.result.structuredContent;
}
let inputIndex = 0;
async function cli(f, request) {
  const file = path.join(f.container, `head-request-${inputIndex++}.json`);
  fs.writeFileSync(file, JSON.stringify(request), { flag: "wx" });
  return (await runCommand(["managed-maintenance", "worker-integrate", f.root, "--input", file]));
}
const cliStatus = async f => (await runCommand(["worker-integration-status", f.root, "--integration", f.integrationId]));
function snapshot(root) {
  const found = {};
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else found[path.relative(root, file)] = fs.readFileSync(file).toString("base64");
    }
  }
  walk(root);
  return found;
}
const report = f => ({ action: "prepare-result", integrationId: f.integrationId, basisDigest: f.readBasis().basisDigest,
  outcome: "HEAD assessed the whole synthetic result", evidence: [{ source: "synthetic surface fixture", actualProviderInvoked: false }],
  verification: [{ check: "exact paired public surfaces", status: "passed" }], unknowns: ["No real provider or native file effect in this fixture"] });

test("two integration tools describe exact actions and separate file effects from authority", () => {
  const integration = tools.find(value => value.name === "lode_worker_integration");
  const status = tools.find(value => value.name === "lode_worker_integration_status");
  assert.ok(integration && status);
  assert.deepEqual(integration.inputSchema.properties.action.enum, ["prepare", "apply", "reconcile", "settle-incomplete", "prepare-result", "publish-result"]);
  assert.equal(integration.annotations.readOnlyHint, false);
  assert.equal(integration.annotations.destructiveHint, true, "applying an authorized deletion is still a filesystem effect");
  const applySchema = integration.inputSchema.oneOf.find(item => item.properties.action.const === "apply");
  assert.equal(applySchema.additionalProperties, false);
  assert.equal(Object.hasOwn(applySchema.properties, "authorization_ids"), false);
  assert.equal(Object.hasOwn(applySchema.properties, "retry_known_no_write"), true);
  assert.equal(status.annotations.readOnlyHint, true);
  assert.equal(status.annotations.destructiveHint, false);
  for (const schema of [integration.inputSchema, status.inputSchema]) {
    assert.equal(schema.additionalProperties, false);
    for (const privateField of ["host", "native_options", "file_effect", "on_process", "executable", "transport", "inspection", "confirm_user"]) {
      assert.equal(Object.hasOwn(schema.properties, privateField), false);
    }
  }
  assert.match(integration.description, /Lode supplies/);
  assert.match(integration.description, /never creates ReviewDecision, Product Canon or checkpoint/);
  assert.ok(usage({ all: true, surface: "managed-maintenance" }).commands.some(line => line.startsWith("lode-agent managed-maintenance worker-integrate ")));
  assert.equal(usage({ all: true }).commands.some(line => line.startsWith("lode-agent worker-integrate ")), false);
  assert.ok(usage({ all: true }).commands.some(line => line.startsWith("lode-agent worker-integration-status ")));
});

test("ordinary integration status machine guidance inspects retained work without selecting application", async t => {
  const f = await workerIntegrationFixture(t), before = snapshot(f.root);
  for (let attempt = 0; attempt < 2; attempt++) {
    const cli = (await cliStatus(f));
    const mcp = await tool(f.root, { integrationId: f.integrationId }, true);
    assert.deepEqual(mcp, cli);
    for (const status of [cli, mcp]) {
      const guide = status.application.guidance;
      assert.equal(guide.action, "inspect-retained-integration");
      assert.match(guide.nextStep, /does not select application/);
      assert.equal(guide.automaticApplicationBlocked, false, "Keep mechanical eligibility rather than add a gate");
      assert.equal(guide.ordinaryWorkBlocked, false);
      assert.equal(guide.userActionRequired, false);
      assert.equal(guide.grantsPermission, false);
      assert.equal(guide.recoveryAuthority, false);
      assert.equal(guide.persisted, false);
    }
  }
  assert.deepEqual(snapshot(f.root), before, "Status advice creates no history, effect or P2 artifact");
});

test("CLI and MCP reuse exact prepared membership and status without artifacts or P2 writes", async t => {
  const f = await workerIntegrationFixture(t);
  const before = snapshot(f.root);
  const request = { action: "prepare", authorizationIds: f.members.map(member => member.authorizationId), maxBytes: 0 };
  const command = await cli(f, request);
  assert.equal(command.status, "existing");
  assert.deepEqual(await tool(f.root, request), command);
  const commandStatus = (await cliStatus(f));
  assert.deepEqual(await tool(f.root, { integrationId: f.integrationId }, true), commandStatus);
  assert.equal(commandStatus.application.status, "not-started");
  assert.equal(commandStatus.result.status, "not-published");
  assert.equal(commandStatus.outstandingEffects.hasConflicts, false);
  assert.equal(commandStatus.authorityEffect, "none");
  assert.deepEqual(snapshot(f.root), before);
});

test("status retains lineage and drift but omits duplicate raw patches without reserving dependencies", async t => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "value.txt", after: "candidate value\n" }], readDependencies: ["config.txt"] });
  fs.writeFileSync(path.join(f.root, "config.txt"), "changed dependency\n");
  const before = snapshot(f.root);
  const status = (await cliStatus(f));
  assert.deepEqual(await tool(f.root, { integrationId: f.integrationId }, true), status);
  assert.equal(status.application.currentBasis.headReassessmentRequired, true);
  assert.equal(status.integration.members.length, 1);
  assert.equal(status.integration.lineage.runId, f.run.runId);
  assert.equal(status.outstandingEffects.hasConflicts, false);
  assert.equal(JSON.stringify(status).includes("contentBase64"), false);
  assert.equal(JSON.stringify(status).includes("candidate value"), false);
  assert.equal(Object.hasOwn(status.application, "intent"), false);
  assert.equal(Object.hasOwn(status.result, "intent"), false);
  assert.deepEqual(snapshot(f.root), before);
});

test("unobservable read dependency guides HEAD without creating claims or blocking ordinary work", async t => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }], readDependencies: ["config.txt"] });
  fs.unlinkSync(path.join(f.root, "config.txt")); fs.mkdirSync(path.join(f.root, "config.txt"));
  const before = snapshot(f.root);
  const status = (await cliStatus(f));
  assert.deepEqual(await tool(f.root, { integrationId: f.integrationId }, true), status);
  const guide = status.application.guidance;
  assert.equal(guide.automaticApplicationBlocked, true);
  assert.equal(guide.ordinaryWorkBlocked, false);
  assert.equal(guide.userActionRequired, false);
  assert.equal(guide.unavailable.length, 1);
  assert.equal(guide.unavailable[0].path, "config.txt");
  assert.equal(guide.unavailable[0].role, "read-dependency");
  const result = await tool(f.root, { action: "apply", integrationId: f.integrationId, basisDigest: status.application.currentBasis.basisDigest });
  assert.equal(result.action, "inspect-unverifiable-basis");
  assert.equal(result.guidance.action, result.action);
  assert.equal(result.claim, null); assert.deepEqual(result.effectResults, []);
  assert.deepEqual(snapshot(f.root), before, "No native effect, claim, P2, Canon or status artifact");
  const card = formatCliResult("worker-integration-status", status);
  assert.equal(formatMcpToolContent("head_worker_integration_status", status), card);
  assert.ok(card.includes("config.txt")); assert.ok(card.includes(guide.nextStep));
});

test("both public paths reject request-injected Host hooks and irrelevant action fields before mutation", async t => {
  const f = await workerIntegrationFixture(t);
  const before = snapshot(f.root);
  for (const extra of [{ fileEffect: "execute-me" }, { root: "other-project" }, { authorizationIds: [] }, { verificationId: `worker-integration-verification-${"1".repeat(24)}` }]) {
    const request = { action: "apply", integrationId: f.integrationId, ...extra };
    let commandError;
    try { await cli(f, request); } catch (error) { commandError = error; }
    assert.ok(commandError);
    const response = await call("head_worker_integration", mcpArgs(f.root, request));
    assert.equal(response.error.message, commandError.message);
  }
  const read = await call("head_worker_integration_status", { project_root: f.root, integration_id: f.integrationId, action: "apply" });
  assert.match(read.error.message, /Unsupported worker integration fields: action/);
  assert.deepEqual(snapshot(f.root), before);
});

test("invalid, missing and premature result inputs have the same CLI/MCP failure", async t => {
  const f = await workerIntegrationFixture(t);
  const before = snapshot(f.root);
  for (const request of [{ action: "apply", integrationId: "invalid" }, { action: "publish-result", integrationId: f.integrationId },
    { action: "apply", integrationId: f.integrationId, retryKnownNoWrite: "true" }, report(f)]) {
    let commandError;
    try { await cli(f, request); } catch (error) { commandError = error; }
    assert.ok(commandError);
    const response = await call("head_worker_integration", mcpArgs(f.root, request));
    assert.equal(response.error.message, commandError.message);
  }
  assert.deepEqual(snapshot(f.root), before);
});

test("typed and CLI no-effect integration publishes one whole result and still requires Fresh HEAD review", async t => {
  const f = await workerIntegrationFixture(t);
  const beforeSession = fs.readFileSync(f.sessionFile, "utf8");
  const apply = { action: "apply", integrationId: f.integrationId };
  assert.equal((await tool(f.root, apply)).status, "applied");
  assert.equal((await cli(f, apply)).status, "applied");
  assert.equal((await tool(f.root, { action: "reconcile", integrationId: f.integrationId })).status, "applied");
  const prepared = await cli(f, report(f));
  assert.equal(prepared.status, "prepared");
  assert.equal((await tool(f.root, report(f))).verification.verificationId, prepared.verification.verificationId);
  assert.equal(fs.readFileSync(f.sessionFile, "utf8"), beforeSession);
  const publish = { action: "publish-result", integrationId: f.integrationId, verificationId: prepared.verification.verificationId };
  const result = await tool(f.root, publish);
  assert.equal(result.status, "published");
  assert.equal((await cli(f, publish)).status, "already-published");
  const state = inspectProject(f.root).state;
  assert.equal(state.pendingReview.resultPacketId, result.resultPacket.resultPacketId);
  assert.equal(state.lastReviewDecisionId, null);
  assert.equal(fs.readdirSync(path.join(f.root, relativeProjectArtifact(f.storage, "lineage", "result-packets"))).length, 1);
  assert.equal(result.resultPacket.evidence[0].memberProvenance.length, 2);
  const beforeRead = snapshot(f.root);
  assert.deepEqual((await cliStatus(f)), await tool(f.root, { integrationId: f.integrationId }, true));
  assert.equal((await cliStatus(f)).result.status, "published");
  assert.equal((await cliStatus(f)).result.resultPacket.read.tool, "lode_lineage_artifact");
  assert.equal((await cliStatus(f)).result.resultPacket.resultPacketId, result.resultPacket.resultPacketId);
  assert.equal(Object.hasOwn((await cliStatus(f)).result.verification, "headReport"), false);
  assert.equal(Object.hasOwn((await cliStatus(f)).result.verification, "wholeResultPacket"), false);
  assert.equal((await cliStatus(f)).result.verification.evidenceCount, 1);
  assert.equal((await cliStatus(f)).result.verification.verificationCount, 1);
  assert.deepEqual(snapshot(f.root), beforeRead);
});
