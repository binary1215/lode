import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { createRecoveryCheckpoint } from "../scripts/lib/compaction-recovery.mjs";
import { continueSessionFromArtifacts } from "../scripts/lib/runtime-session-continuation.mjs";
import { buildRuntimeAdapterComposition } from "../scripts/lib/runtime-adapter.mjs";
import { VerifiedWorkspaceHostAdapter, WORKSPACE_HOST_COORDINATION_VERSION } from "../scripts/lib/workspace-host-coordination.mjs";
import { createWorkspaceHostExportDriver, publishWorkspaceHostExportSnapshot, workspaceHostExportProcessProofHash } from "../scripts/lib/workspace-host-export-driver.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";
const pluginRoot = path.resolve(import.meta.dirname, "..");
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "head-host-adapter-"));
  const root = path.join(base, "project"), exportRoot = path.join(base, "export");
  fs.mkdirSync(root); fs.mkdirSync(exportRoot);
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const inspected = inspectProject(root);
  const { sessionIdField } = formatForVerifiedOwner(inspected.storage);
  return { root, projectRoot: root, exportRoot, base, sessionIdField, boundary: { projectId: inspected.project.projectId, [sessionIdField]: inspected.state.sessionId, role: "head", projectRoot: root } };
}
const endpoint = fx => ({ workspaceId: "workspace", tabId: "head", endpointId: "head", terminalId: "terminal-head", cwd: fx.root, runtime: "codex" });
function driver(fx) {
  const state = { endpoints: [endpoint(fx)], deliveries: [], hostInstanceId: "host-instance" };
  const descriptor = { schemaVersion: 1, kind: "WorkspaceHostDriverDescriptor", protocol: { name: "head-agent-core-workspace-host-driver", version: WORKSPACE_HOST_COORDINATION_VERSION }, hostKind: "fixture-host", transport: "fixture-memory", providerNeutral: true, tuiScraping: false, providerSessionIdentityPersisted: false };
  return { state, describe: () => descriptor,
    snapshot: () => ({ schemaVersion: 1, kind: "WorkspaceHostSnapshot", protocol: { name: "head-agent-core-workspace-host-snapshot", version: WORKSPACE_HOST_COORDINATION_VERSION }, hostKind: descriptor.hostKind, transport: descriptor.transport, hostInstanceId: state.hostInstanceId, snapshotSequence: "snapshot", endpoints: state.endpoints }),
    send({ endpoint: selected, messageId, text }) {
      state.deliveries.push({ selected, messageId, text });
      if (state.afterSend) state.afterSend();
      if (state.throwAfterSend) throw new Error("unknown effect");
      return { status: "delivered", messageId, hostInstanceId: state.hostInstanceId, ...selected };
    } };
}
const caller = { workspaceId: "workspace", tabId: "head", endpointId: "head" };
const message = (fx, values = {}) => ({ projectId: fx.boundary.projectId, [fx.sessionIdField]: fx.boundary[fx.sessionIdField], toRole: "head", messageId: "task-1", content: "Source-linked task result", instructionAuthority: false, mutatesCanon: false, ...values });
function bytes(root) {
  return fs.readdirSync(root).sort().flatMap(name => { const file = path.join(root, name); return fs.statSync(file).isDirectory() ? bytes(file).map(([f,b]) => [name+"/"+f,b]) : [[name, fs.readFileSync(file).toString("base64")]]; });
}
test("optional endpoint attachment has Project/Session identity without role tokens or coordination writes", t => {
  const fx = fixture(t), before = bytes(fx.root), host = driver(fx), adapter = new VerifiedWorkspaceHostAdapter({ driver: host });
  const attachment = adapter.attach({ caller, boundary: fx.boundary });
  assert.equal(buildRuntimeAdapterComposition({ workspaceHostAdapter: adapter }).activationBoundary.workspaceHostMessagingEnabled, true);
  assert.equal(adapter.receive({ attachment, boundary: fx.boundary }).status, "attached");
  assert.equal(adapter.send({ attachment, boundary: fx.boundary, message: message(fx) }).status, "delivered");
  for (const key of ["bindingId", "authorityGeneration", "attachmentHash", "attachmentId"]) assert.equal(key in attachment, false);
  assert.equal(host.state.deliveries[0].text, "Source-linked task result");
  assert.equal(adapter.detach({ attachment, boundary: fx.boundary }).endpointWasLive, true);
  assert.equal(adapter.receive({ attachment, boundary: fx.boundary }).status, "unavailable");
  assert.equal(adapter.send({ attachment, boundary: fx.boundary, message: message(fx) }).status, "unavailable");
  assert.equal(host.state.deliveries.length, 1);
  assert.deepEqual(bytes(fx.root), before);
});
test("exact scope and current endpoint prevent stale or cross-project delivery", t => {
  const fx = fixture(t), host = driver(fx), adapter = new VerifiedWorkspaceHostAdapter({ driver: host });
  const attachment = adapter.attach({ caller, boundary: fx.boundary });
  assert.throws(() => adapter.receive({ attachment, boundary: { ...fx.boundary, [fx.sessionIdField]: "different-session" } }), { code: "STALE_WORKSPACE_HOST_ATTACHMENT" });
  assert.throws(() => adapter.send({ attachment, boundary: fx.boundary, message: message(fx, { projectId: "other-project" }) }), { code: "INVALID_WORKSPACE_HOST_MESSAGE" });
  host.state.endpoints[0] = { ...host.state.endpoints[0], terminalId: "replacement" };
  assert.equal(adapter.send({ attachment, boundary: fx.boundary, message: message(fx) }).status, "unavailable");
  assert.equal(host.state.deliveries.length, 0);
  host.state.endpoints = [{ ...endpoint(fx), cwd: fx.exportRoot }];
  assert.throws(() => adapter.attach({ caller, boundary: fx.boundary }), { code: "WORKSPACE_HOST_PROJECT_MISMATCH" });
});
test("post-send change or exception remains unknown; no automatic retry", t => {
  const fx = fixture(t), host = driver(fx), adapter = new VerifiedWorkspaceHostAdapter({ driver: host });
  const attachment = adapter.attach({ caller, boundary: fx.boundary });
  host.state.throwAfterSend = true;
  assert.equal(adapter.send({ attachment, boundary: fx.boundary, message: message(fx) }).status, "ambiguous");
  assert.equal(host.state.deliveries.length, 1);
  host.state.throwAfterSend = false; host.state.afterSend = () => { host.state.endpoints = []; };
  assert.equal(adapter.send({ attachment, boundary: fx.boundary, message: message(fx, { messageId: "task-2" }) }).status, "ambiguous");
  assert.equal(host.state.deliveries.length, 2);
});
test("P2 restore precedes optional endpoint continuation and fallback preserves originals and direction", t => {
  const fx = fixture(t), host = driver(fx), adapter = new VerifiedWorkspaceHostAdapter({ driver: host });
  const checkpoint = createRecoveryCheckpoint({ root: fx.root, purpose: "Resume source inspection", currentPosition: "One worker completed; another failed", nextExpectedResult: "Retry the failed part", approvedDecisions: ["Preserve completed result"] });
  const attachment = adapter.attach({ caller, boundary: fx.boundary });
  const before = bytes(fx.root);
  const fresh = continueSessionFromArtifacts({ root: fx.root, runtime: "codex", checkpointId: checkpoint.checkpoint.checkpointId });
  const attached = continueSessionFromArtifacts({ root: fx.root, runtime: "codex", hostAttachment: attachment, workspaceHostAdapter: adapter });
  assert.equal(attached.continuationOutcome.status, "attached");
  assert.equal(attached.restore.projection.sessionRestoreHash, fresh.restore.projection.sessionRestoreHash);
  assert.throws(() => continueSessionFromArtifacts({ root: fx.root, runtime: "opencode", hostAttachment: attachment, workspaceHostAdapter: adapter }), { code: "RUNTIME_CONTINUATION_ATTACHMENT_CONFLICT" });
  assert.throws(() => continueSessionFromArtifacts({ root: fx.root, runtime: "codex", hostAttachment: { ...attachment, [fx.sessionIdField]: "different-session" }, workspaceHostAdapter: adapter }), { code: "STALE_WORKSPACE_HOST_ATTACHMENT" });
  host.state.endpoints = [];
  const unavailable = continueSessionFromArtifacts({ root: fx.root, runtime: "codex", hostAttachment: attachment, workspaceHostAdapter: adapter });
  assert.equal(unavailable.continuationOutcome.disclosure, "provider-attachment-unavailable");
  assert.equal(unavailable.restore.projection.sessionRestoreHash, fresh.restore.projection.sessionRestoreHash);
  host.snapshot = () => { throw new Error("Host endpoint disconnected"); };
  const disconnected = continueSessionFromArtifacts({ root: fx.root, runtime: "codex", hostAttachment: attachment, workspaceHostAdapter: adapter });
  assert.equal(disconnected.continuationOutcome.disclosure, "provider-attachment-unavailable");
  assert.equal(disconnected.restore.projection.sessionRestoreHash, fresh.restore.projection.sessionRestoreHash);
  assert.deepEqual(bytes(fx.root), before);
});
function exported(fx) {
  const proof = crypto.randomBytes(32).toString("base64url");
  const endpoints = [{ ...endpoint(fx), processProofHash: workspaceHostExportProcessProofHash(proof) }];
  publishWorkspaceHostExportSnapshot({ ...fx, hostInstanceId: "host-instance", endpoints });
  return { proof, endpoints, host: createWorkspaceHostExportDriver({ ...fx, caller, processProof: proof }) };
}
test("export is snapshot-only, unchanged publication adds no write, and delivery cannot create an effect", t => {
  const fx = fixture(t), { host, endpoints } = exported(fx), before = bytes(fx.root), operationalBefore = bytes(fx.exportRoot);
  publishWorkspaceHostExportSnapshot({ ...fx, hostInstanceId: "host-instance", endpoints });
  assert.deepEqual(bytes(fx.exportRoot), operationalBefore);
  assert.equal(bytes(fx.exportRoot).length, 1);
  assert.throws(() => host.send({ endpoint: endpoint(fx), messageId: "task-1", text: "Result" }), { code: "WORKSPACE_HOST_EXPORT_DELIVERY_UNSUPPORTED" });
  const adapter = new VerifiedWorkspaceHostAdapter({ driver: host });
  assert.equal(adapter.send().status, "unsupported");
  const composition = buildRuntimeAdapterComposition({ workspaceHostAdapter: adapter });
  assert.equal(composition.activationBoundary.workspaceHostMessagingEnabled, false);
  assert.equal(composition.activationBoundary.phase, "host-attachment-active");
  assert.deepEqual(bytes(fx.exportRoot), operationalBefore);
  assert.deepEqual(bytes(fx.root), before);
});
test("export owner proof, overlap and replaced endpoint remain exact without delivery state", t => {
  const fx = fixture(t), { host, endpoints } = exported(fx);
  const wrong = createWorkspaceHostExportDriver({ ...fx, caller, processProof: crypto.randomBytes(32).toString("base64url") });
  assert.throws(() => wrong.snapshot(), { code: "WORKSPACE_HOST_PROCESS_PROOF_MISMATCH" });
  assert.throws(() => publishWorkspaceHostExportSnapshot({ exportRoot: fx.root, projectRoot: fx.root, hostInstanceId: "host", endpoints: [] }), { code: "WORKSPACE_HOST_EXPORT_PROJECT_OVERLAP" });
  const adapter = new VerifiedWorkspaceHostAdapter({ driver: host });
  const attachment = adapter.attach({ caller, boundary: fx.boundary });
  publishWorkspaceHostExportSnapshot({ ...fx, hostInstanceId: "host-instance", endpoints: [{ ...endpoints[0], terminalId: "replacement" }] });
  assert.equal(adapter.receive({ attachment, boundary: fx.boundary }).status, "unavailable");
  assert.equal(bytes(fx.exportRoot).length, 1);
});
test("target process ownership change invalidates an attachment even when endpoint names remain", t => {
  const fx = fixture(t), { host, endpoints } = exported(fx);
  const target = { ...endpoint(fx), tabId: "worker", endpointId: "worker", terminalId: "worker-terminal", processProofHash: workspaceHostExportProcessProofHash(crypto.randomBytes(32).toString("base64url")) };
  publishWorkspaceHostExportSnapshot({ ...fx, hostInstanceId: "host-instance", endpoints: [...endpoints, target] });
  const adapter = new VerifiedWorkspaceHostAdapter({ driver: host });
  const scope = { ...fx.boundary, role: "developer" };
  const attachment = adapter.attach({ caller: target, boundary: scope });
  publishWorkspaceHostExportSnapshot({ ...fx, hostInstanceId: "host-instance", endpoints: [...endpoints, { ...target, processProofHash: workspaceHostExportProcessProofHash(crypto.randomBytes(32).toString("base64url")) }] });
  assert.equal(adapter.receive({ attachment, boundary: scope }).status, "unavailable");
  assert.equal(adapter.send({ attachment, boundary: scope, message: message(fx, { toRole: "developer" }) }).status, "unsupported");
  assert.equal(bytes(fx.exportRoot).length, 1);
});
test("six-reference export composition supports P2-first MCP continuation without a role token", async t => {
  const fx = fixture(t), { proof } = exported(fx);
  const { workspaceHostExportComposition } = await import("../scripts/workspace-host-export-mcp.mjs");
  const { dispatch } = await import("../scripts/mcp-server.mjs");
  const composition = workspaceHostExportComposition({ environment: {
    HEAD_AGENT_HOST_PROJECT_ROOT: fx.root, HEAD_AGENT_WORKSPACE_HOST_EXPORT_ROOT: fx.exportRoot,
    HEAD_AGENT_HOST_WORKSPACE_ID: "workspace", HEAD_AGENT_HOST_TAB_ID: "head", HEAD_AGENT_HOST_ENDPOINT_ID: "head",
    HEAD_AGENT_HOST_PROCESS_PROOF: proof,
  } });
  createRecoveryCheckpoint({ root: fx.root, purpose: "Continue current direction", currentPosition: "Partial worker result preserved", nextExpectedResult: "Retry failed part only" });
  const before = bytes(fx.root);
  const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "head_session_continue", arguments: { project_root: fx.root, runtime: "codex" } } };
  const response = await dispatch(request, { coordinationWorkspaceHost: composition });
  assert.equal(response.result?.structuredContent?.status, "session_continued_with_live_attachment", JSON.stringify(response));
  publishWorkspaceHostExportSnapshot({ ...fx, hostInstanceId: "host-instance", endpoints: [] });
  const unavailable = await dispatch(request, { coordinationWorkspaceHost: composition });
  assert.equal(unavailable.result?.structuredContent?.status, "session_continued_with_fresh_logical_head", JSON.stringify(unavailable));
  assert.equal(unavailable.result.structuredContent.continuationOutcome.disclosure, "provider-attachment-unavailable");
  assert.deepEqual(bytes(fx.root), before);
});
test("endpoint child directory loss preserves direct P2 continuation and cannot send or write", t => {
  const fx = fixture(t), host = driver(fx), adapter = new VerifiedWorkspaceHostAdapter({ driver: host });
  const cwd = path.join(fx.root, "ephemeral-endpoint"); fs.mkdirSync(cwd);
  host.state.endpoints[0] = { ...endpoint(fx), cwd };
  createRecoveryCheckpoint({ root: fx.root, purpose: "Keep current direction", currentPosition: "Completed result preserved", nextExpectedResult: "Inspect remaining source" });
  const expected = continueSessionFromArtifacts({ root: fx.root, runtime: "codex" });
  const attachment = adapter.attach({ caller, boundary: fx.boundary });
  fs.rmdirSync(cwd);
  const before = bytes(fx.root), operationalBefore = bytes(fx.exportRoot);
  const continued = continueSessionFromArtifacts({ root: fx.root, runtime: "codex", hostAttachment: attachment, workspaceHostAdapter: adapter });
  assert.equal(continued.status, "session_continued_with_fresh_logical_head");
  assert.equal(continued.continuationOutcome.disclosure, "provider-attachment-unavailable");
  assert.equal(continued.restore.projection.sessionRestoreHash, expected.restore.projection.sessionRestoreHash);
  assert.deepEqual(continued.restore.projection.consumerInstruction, expected.restore.projection.consumerInstruction);
  assert.equal(adapter.send({ attachment, boundary: fx.boundary, message: message(fx) }).status, "unavailable");
  assert.equal(host.state.deliveries.length, 0);
  assert.deepEqual(bytes(fx.root), before); assert.deepEqual(bytes(fx.exportRoot), operationalBefore);
  for (const [key, value, code] of [["projectId", "different-project", "STALE_WORKSPACE_HOST_ATTACHMENT"], [fx.sessionIdField, "different-session", "STALE_WORKSPACE_HOST_ATTACHMENT"], ["cwd", path.join(fx.exportRoot, "missing"), "WORKSPACE_HOST_PROJECT_MISMATCH"]]) {
    assert.throws(() => adapter.receive({ attachment: { ...attachment, [key]: value }, boundary: fx.boundary }), { code });
  }
  assert.throws(() => continueSessionFromArtifacts({ root: fx.root, runtime: "opencode", hostAttachment: attachment, workspaceHostAdapter: adapter }), { code: "RUNTIME_CONTINUATION_ATTACHMENT_CONFLICT" });
});
test("public MCP child directory loss between attach and receive returns original P2 without effects", async t => {
  const fx = fixture(t), host = driver(fx), adapter = new VerifiedWorkspaceHostAdapter({ driver: host });
  const { dispatch } = await import("../scripts/mcp-server.mjs");
  const cwd = path.join(fx.root, "ephemeral-endpoint"); fs.mkdirSync(cwd);
  host.state.endpoints[0] = { ...endpoint(fx), cwd };
  createRecoveryCheckpoint({ root: fx.root, purpose: "Resume current user direction", currentPosition: "Completed contribution retained", nextExpectedResult: "Inspect remaining source" });
  const expected = continueSessionFromArtifacts({ root: fx.root, runtime: "codex" });
  const before = bytes(fx.root), operationalBefore = bytes(fx.exportRoot);
  const originalAttach = adapter.attach.bind(adapter);
  adapter.attach = args => { const attachment = originalAttach(args); fs.rmdirSync(cwd); return attachment; };
  const response = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "head_session_continue", arguments: { project_root: fx.root, runtime: "codex" } } }, { coordinationWorkspaceHost: { adapter, caller, projectRoot: fx.root } });
  const continued = response.result?.structuredContent;
  assert.equal(continued?.status, "session_continued_with_fresh_logical_head", JSON.stringify(response));
  assert.equal(continued.continuationOutcome.disclosure, "provider-attachment-unavailable");
  assert.equal(continued.restore.projection.sessionRestoreHash, expected.restore.projection.sessionRestoreHash);
  assert.deepEqual(continued.restore.projection.consumerInstruction, expected.restore.projection.consumerInstruction);
  assert.equal(continued.continuationOutcome.instructionAuthority, false); assert.equal(continued.continuationOutcome.mutatesCanon, false);
  assert.equal(host.state.deliveries.length, 0);
  assert.deepEqual(bytes(fx.root), before); assert.deepEqual(bytes(fx.exportRoot), operationalBefore);
});
test("endpoint query failure is unavailable but replacing its directory with a link remains rejected", t => {
  const fx = fixture(t), host = driver(fx), adapter = new VerifiedWorkspaceHostAdapter({ driver: host });
  const cwd = path.join(fx.root, "ephemeral-endpoint"); fs.mkdirSync(cwd);
  host.state.endpoints[0] = { ...endpoint(fx), cwd };
  const attachment = adapter.attach({ caller, boundary: fx.boundary });
  const before = bytes(fx.root), operationalBefore = bytes(fx.exportRoot), lstat = fs.lstatSync;
  try {
    for (const code of ["EACCES", "EIO"]) {
      fs.lstatSync = function(file, ...args) {
        if (path.resolve(String(file)) === cwd) throw Object.assign(new Error("Endpoint lookup unavailable"), { code });
        return lstat.call(this, file, ...args);
      };
      assert.equal(adapter.receive({ attachment, boundary: fx.boundary }).status, "unavailable");
      assert.equal(adapter.send({ attachment, boundary: fx.boundary, message: message(fx) }).status, "unavailable");
    }
  } finally { fs.lstatSync = lstat; }
  fs.rmdirSync(cwd); fs.symlinkSync(fx.exportRoot, cwd, "junction");
  try {
    assert.throws(() => adapter.receive({ attachment, boundary: fx.boundary }), { code: "INVALID_WORKSPACE_HOST_PATH" });
    assert.throws(() => adapter.send({ attachment, boundary: fx.boundary, message: message(fx) }), { code: "INVALID_WORKSPACE_HOST_PATH" });
  } finally { fs.unlinkSync(cwd); }
  assert.equal(host.state.deliveries.length, 0);
  assert.deepEqual(bytes(fx.root), before); assert.deepEqual(bytes(fx.exportRoot), operationalBefore);
});
test("directory loss after an actual send remains ambiguous and a subsequent call cannot resend", t => {
  const fx = fixture(t), host = driver(fx), adapter = new VerifiedWorkspaceHostAdapter({ driver: host });
  const cwd = path.join(fx.root, "ephemeral-endpoint"); fs.mkdirSync(cwd);
  host.state.endpoints[0] = { ...endpoint(fx), cwd };
  const attachment = adapter.attach({ caller, boundary: fx.boundary });
  const before = bytes(fx.root), operationalBefore = bytes(fx.exportRoot);
  host.state.afterSend = () => fs.rmdirSync(cwd);
  assert.equal(adapter.send({ attachment, boundary: fx.boundary, message: message(fx) }).status, "ambiguous");
  assert.equal(host.state.deliveries.length, 1);
  assert.equal(adapter.send({ attachment, boundary: fx.boundary, message: message(fx) }).status, "unavailable");
  assert.equal(host.state.deliveries.length, 1);
  assert.deepEqual(bytes(fx.root), before); assert.deepEqual(bytes(fx.exportRoot), operationalBefore);
});
test("public MCP rejects wrong project, current Session and runtime while Host snapshot loss falls back", async t => {
  const fx = fixture(t), host = driver(fx), adapter = new VerifiedWorkspaceHostAdapter({ driver: host });
  const { dispatch } = await import("../scripts/mcp-server.mjs");
  createRecoveryCheckpoint({ root: fx.root, purpose: "Current project direction", currentPosition: "Completed contribution preserved", nextExpectedResult: "Inspect remaining source" });
  const expected = continueSessionFromArtifacts({ root: fx.root, runtime: "codex" });
  const before = bytes(fx.root), operationalBefore = bytes(fx.exportRoot);
  const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "head_session_continue", arguments: { project_root: fx.root, runtime: "codex" } } };
  const call = () => dispatch(request, { coordinationWorkspaceHost: { adapter, caller, projectRoot: fx.root } });
  host.state.endpoints[0] = { ...endpoint(fx), cwd: fx.exportRoot };
  assert.match((await call()).error?.message || "", /outside the project/u);
  host.state.endpoints[0] = endpoint(fx);
  const originalAttach = adapter.attach.bind(adapter);
  for (const [key, value] of [["projectId", "different-project"], [fx.sessionIdField, "different-session"]]) {
    adapter.attach = args => ({ ...originalAttach(args), [key]: value });
    assert.match((await call()).error?.message || "", /another Project\/Session/u);
  }
  adapter.attach = () => { throw Object.assign(new Error("Wrong current Session attachment scope"), { code: "STALE_WORKSPACE_HOST_ATTACHMENT" }); };
  assert.match((await call()).error?.message || "", /Wrong current Session/u);
  adapter.attach = () => { throw Object.assign(new Error("Invalid requested attachment boundary"), { code: "INVALID_WORKSPACE_HOST_BOUNDARY" }); };
  assert.match((await call()).error?.message || "", /Invalid requested attachment boundary/u);
  adapter.attach = originalAttach;
  host.state.endpoints[0] = { ...endpoint(fx), runtime: "opencode" };
  assert.match((await call()).error?.message || "", /exact Lode runtime/u);
  host.snapshot = () => { throw new Error("Optional Host snapshot unavailable"); };
  const unavailable = (await call()).result?.structuredContent;
  assert.equal(unavailable?.status, "session_continued_with_fresh_logical_head");
  assert.equal(unavailable.continuationOutcome.disclosure, "provider-attachment-unavailable");
  assert.equal(unavailable.restore.projection.sessionRestoreHash, expected.restore.projection.sessionRestoreHash);
  assert.deepEqual(unavailable.restore.projection.consumerInstruction, expected.restore.projection.consumerInstruction);
  assert.equal(host.state.deliveries.length, 0);
  assert.deepEqual(bytes(fx.root), before); assert.deepEqual(bytes(fx.exportRoot), operationalBefore);
});
