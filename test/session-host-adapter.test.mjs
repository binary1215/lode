import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { createHeadSession, withSessionRoute } from "../scripts/lib/session-routing.mjs";
import { createSessionHostAdapter } from "../scripts/lib/session-host-adapter.mjs";
import { sessionStartContext } from "../scripts/session-host-hook.mjs";
import { createNativeObservationStore, NATIVE_OBSERVATION_LIMITS } from "../scripts/lib/native-session-observations.mjs";
import { recordSessionWorkEvidence, readSessionWorkList, readSessionWorkContext } from "../scripts/lib/session-work-context.mjs";
import { createNativeSessionHostBridge } from "../scripts/lib/session-native-host.mjs";
import { runCommand } from "../scripts/head.mjs";
import { formatCliResult } from "../scripts/lib/cli-presentation.mjs";
import { updateProjectDirection } from "../scripts/lib/project-direction.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { localContinuityCommand } from "./helpers/session-continuity-process.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "head-session-host-")));
  const root = path.join(base, "project"), operational = path.join(base, "host");
  fs.mkdirSync(root);
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: operational };
  const host = (nativeSessionId, agentId = null, runtime = "codex") => createSessionHostAdapter({ runtime, nativeSessionId, agentId, environment });
  return { root, operational, environment, host };
}
const call = (root, name, args, host) => dispatch({ jsonrpc: "2.0", id: "trusted-host-fixture", method: "tools/call",
  params: { name, arguments: { project_root: root, ...args } } }, { resolveSessionContext: host.resolveSessionContext });
function files(root) {
  const items = [];
  function walk(dir) { if (!fs.existsSync(dir)) return; for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) walk(file); else items.push([file, fs.readFileSync(file, "utf8")]);
  } }
  walk(root);
  return items;
}

const fileState = root => files(root).map(([file, text]) => [file, text, fs.statSync(file).mode, fs.statSync(file).mtimeMs]);
const selector = native_session_id => ({ runtime: "codex", native_session_id, environment_scope: "current" });

test("followup: unrelated stored conversations are optional list selectors, not callers or work owners", async t => {
  const f = fixture(t), a = createHeadSession({ root: f.root, purpose: "Current caller" }), b = createHeadSession({ root: f.root, purpose: "Other recorded work" });
  f.host("native-current").select({ root: f.root, sessionId: a.sessionId, expectedRevision: 0 });
  f.host("native-other").select({ root: f.root, sessionId: b.sessionId, expectedRevision: 0 });
  f.host("native-other", null, "claude").select({ root: f.root, sessionId: a.sessionId, expectedRevision: 0 });
  f.host("native-other", "other-agent").select({ root: f.root, sessionId: a.sessionId, expectedRevision: 0 });
  withSessionRoute(f.root, b.sessionId, () => recordSessionWorkEvidence({ root: f.root, input: { summary: "Exact older result; no parent relation exists" } }));
  const before = fileState(f.root).concat(fileState(f.operational)), plain = readSessionWorkList({ root: f.root, maxSessions: 1 });
  assert.equal(plain instanceof Promise, false); assert.equal(plain.conversationDiscovery, undefined);
  const candidates = [selector("native-current"), selector("native-other"),
    { ...selector("native-other"), runtime: "claude" }, { ...selector("native-other"), agent_id: "other-agent" }, selector("native-absent")];
  const bridge = createNativeSessionHostBridge({ runtime: "codex", environment: f.environment });
  const result = await dispatch({ jsonrpc: "2.0", id: "candidate-read", method: "tools/call", params: {
    name: "head_session_list", _meta: { threadId: "native-current" }, arguments: {
      project_root: f.root, session_id: b.sessionId, conversation_candidates: candidates } } }, { nativeSessionBridge: bridge });
  assert.equal(result.error, undefined);
  const value = result.result.structuredContent, rows = value.conversationDiscovery.rows;
  assert.equal(value.preview.workContext.sessionId, b.sessionId);
  assert.equal(value.preview.workContext.records[0].content.summary, "Exact older result; no parent relation exists");
  assert.deepEqual(rows.map(row => row.status), ["stored-mapping", "stored-mapping", "stored-mapping", "stored-mapping", "absent"]);
  assert.deepEqual(rows.map(row => row.matchesRequestedSession), [false, true, false, false, null]);
  assert.equal(rows[4].binding.sessionId, null);
  for (const row of rows) for (const key of ["activity", "contactReadiness", "workParticipation", "ownerAssignment", "modelUse"]) assert.equal(row[key], "unknown");
  assert.equal(f.host("native-current").read({ root: f.root }).sessionId, a.sessionId);
  assert.equal(value.conversationDiscovery.routingAuthority, false);
  const routed = await dispatch({ jsonrpc: "2.0", id: "candidate-router", method: "tools/call", params: {
    name: "head_tools_read", _meta: { threadId: "native-current" }, arguments: { name: "lode_session_list", arguments: {
      project_root: f.root, session_id: b.sessionId, conversation_candidates: candidates } } } }, { nativeSessionBridge: bridge });
  assert.equal(routed.error, undefined); assert.deepEqual(routed.result.structuredContent.conversationDiscovery.rows, rows);
  const inputFile = path.join(path.dirname(f.root), "selectors.json"); fs.writeFileSync(inputFile, JSON.stringify(candidates));
  const old = process.env.HEAD_AGENT_OPERATIONAL_STATE_ROOT; process.env.HEAD_AGENT_OPERATIONAL_STATE_ROOT = f.operational;
  try {
    const cli = await runCommand(["session-list", f.root, "--session", b.sessionId, "--conversation-candidates", inputFile]);
    assert.deepEqual(cli.conversationDiscovery.rows, rows);
    assert.match(formatCliResult("session-list", cli), /no live activity, contact, work participation or owner assignment/);
    assert.ok(formatCliResult("session-list", cli).includes("native-other"));
  } finally { if (old === undefined) delete process.env.HEAD_AGENT_OPERATIONAL_STATE_ROOT; else process.env.HEAD_AGENT_OPERATIONAL_STATE_ROOT = old; }
  assert.deepEqual(readSessionWorkList({ root: f.root, maxSessions: 1 }), plain);
  assert.deepEqual(fileState(f.root).concat(fileState(f.operational)), before);
  t.diagnostic(JSON.stringify({ kind: "SyntheticConversationDiscovery", projectId: value.projectId,
    callerSession: a.sessionId, previewSession: b.sessionId, readAt: value.conversationDiscovery.readAt,
    work: value.preview.workContext.records.map(row => ({ evidenceId: row.evidenceId, evidenceDigest: row.evidenceDigest })),
    rows, cliAndRoutedMcpParity: true, canonicalAndOperationalBytesUnchanged: true,
    actualHostDiscoveryProven: false, automaticContact: false }));
});

test("followup: malformed, foreign, lost and unsupported selectors are isolated with bounded read-only coverage", async t => {
  const f = fixture(t), other = fixture(t), session = createHeadSession({ root: f.root, purpose: "One exact Session" });
  f.host("pending").prepareSelection({ root: f.root, sessionId: session.sessionId, expectedRevision: 0 });
  f.host("lost").select({ root: f.root, sessionId: session.sessionId, expectedRevision: 0 });
  f.host("lost").lose({ root: f.root, expectedRevision: 1 });
  f.host("corrupt").select({ root: f.root, sessionId: session.sessionId, expectedRevision: 0 });
  const badDigest = f.host("corrupt").read({ root: f.root }).callerDigest;
  const badFile = files(f.operational).find(([, text]) => JSON.parse(text).callerDigest === badDigest)[0];
  fs.writeFileSync(badFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(badFile)), bindingDigest: "0".repeat(64) }));
  const foreignSession = createHeadSession({ root: other.root, purpose: "One exact Session" });
  createSessionHostAdapter({ runtime: "codex", nativeSessionId: "foreign-only", environment: f.environment })
    .select({ root: other.root, sessionId: foreignSession.sessionId, expectedRevision: 0 });
  const before = fileState(f.root).concat(fileState(other.root), fileState(f.operational));
  const candidates = [selector("pending"), selector("lost"), selector("corrupt"), selector("foreign-only"),
    { ...selector("foreign-only"), environment_scope: "unsupported-other" },
    { ...selector("foreign-only"), host_id: "unverified-other-host" }, null, { ...selector("bad"), runtime: "unknown" },
    { ...selector("foreign-only"), environment: { HEAD_AGENT_OPERATIONAL_STATE_ROOT: "must-not-be-used" }, project_root: other.root, activity: "running", label: "owner" }];
  const result = await readSessionWorkList({ root: f.root, conversationCandidates: candidates, conversationEnvironment: f.environment });
  assert.deepEqual(result.conversationDiscovery.rows.map(row => row.status), ["pending", "lost", "unavailable", "absent", "unsupported-environment", "unsupported-environment", "invalid-selector", "invalid-selector", "absent"]);
  assert.equal(result.conversationDiscovery.rows[2].reasonCode, "SESSION_HOST_BINDING_INTEGRITY");
  assert.equal(result.conversationDiscovery.rows[8].ownerAssignment, "unknown");
  assert.equal(result.conversationDiscovery.rows[4].lookupPerformed, false);
  const many = await readSessionWorkList({ root: f.root, conversationCandidates: Array.from({ length: 64 }, (_, i) => selector(`absent-${i}`)), conversationEnvironment: f.environment });
  assert.equal(many.conversationDiscovery.coverage.inspected, 16); assert.equal(many.conversationDiscovery.coverage.notInspectedByCandidateBound, 48);
  for (const id of ["한".repeat(512), '\\"'.repeat(256)]) {
    const largeCandidates = Array.from({ length: 16 }, () => ({ ...selector(id), agent_id: id }));
    const large = await readSessionWorkList({ root: f.root, conversationCandidates: largeCandidates, conversationEnvironment: f.environment });
    assert(large.conversationDiscovery.coverage.omittedByResponseBudget > 0);
    const request = conversation_candidates => ({ id: "transport-bound", method: "tools/call", params: { name: "head_session_list",
      arguments: { project_root: f.root, ...(conversation_candidates ? { conversation_candidates } : {}) } } });
    const baseResponse = await dispatch(request(), { hostEnvironment: f.environment });
    const withDiscovery = await dispatch(request(largeCandidates), { hostEnvironment: f.environment });
    assert.equal(withDiscovery.error, undefined);
    assert.deepEqual(withDiscovery.result.structuredContent.conversationDiscovery.rows, large.conversationDiscovery.rows);
    const additionalBytes = Buffer.byteLength(JSON.stringify(withDiscovery)) - Buffer.byteLength(JSON.stringify(baseResponse));
    assert(additionalBytes <= large.conversationDiscovery.coverage.maxAdditionalBytes);
    t.diagnostic(JSON.stringify({ kind: "ConversationTransportBound", inputKind: id.startsWith("한") ? "unicode" : "json-escaped",
      additionalBytes, coverage: large.conversationDiscovery.coverage, returnedRows: large.conversationDiscovery.rows.length }));
  }
  assert.deepEqual(fileState(f.root).concat(fileState(other.root), fileState(f.operational)), before);
});

test("followup: a binding revision change during candidate lookup is not a stable mapping", async t => {
  const f = fixture(t), a = createHeadSession({ root: f.root, purpose: "Before" }), b = createHeadSession({ root: f.root, purpose: "After" });
  f.host("changed").select({ root: f.root, sessionId: a.sessionId, expectedRevision: 0 });
  const record = f.host("changed").read({ root: f.root }), { bindingDigest, ...payload } = record;
  const file = files(f.operational).find(([, text]) => JSON.parse(text).callerDigest === record.callerDigest)[0];
  const next = { ...payload, sessionId: b.sessionId, revision: payload.revision + 1, previousDigest: bindingDigest };
  const changed = { ...next, bindingDigest: crypto.createHash("sha256").update(JSON.stringify(next)).digest("hex") };
  const read = fs.readFileSync, before = fileState(f.root).concat(fileState(f.operational)); let reads = 0;
  fs.readFileSync = function (target, ...args) {
    if (typeof target === "string" && path.resolve(target) === file && ++reads === 2) return JSON.stringify(changed);
    return read.call(this, target, ...args);
  };
  try {
    const result = await readSessionWorkList({ root: f.root, conversationCandidates: [selector("changed")], conversationEnvironment: f.environment });
    assert.equal(result.conversationDiscovery.rows[0].status, "changed-during-read");
    assert.equal(result.conversationDiscovery.rows[0].binding, undefined);
  } finally { fs.readFileSync = read; }
  assert.deepEqual(fileState(f.root).concat(fileState(f.operational)), before);
  const projectFile = path.join(f.root, inspectProject(f.root).storage.directory, "project.json");
  const changedProject = JSON.stringify({ ...JSON.parse(fs.readFileSync(projectFile)), externalRevision: "changed during lookup" });
  let bindingRead = false;
  fs.readFileSync = function (target, ...args) {
    if (typeof target === "string" && path.resolve(target) === file) bindingRead = true;
    if (bindingRead && typeof target === "string" && path.resolve(target) === projectFile) return Buffer.from(changedProject);
    return read.call(this, target, ...args);
  };
  try {
    const result = await readSessionWorkList({ root: f.root, conversationCandidates: [selector("changed")], conversationEnvironment: f.environment });
    assert.equal(result.conversationDiscovery.status, "project-basis-changed");
    assert.deepEqual(result.conversationDiscovery.rows, []);
    assert.equal(result.conversationDiscovery.coverage.discardedByProjectBasisChange, 1);
  } finally { fs.readFileSync = read; }
  assert.deepEqual(fileState(f.root).concat(fileState(f.operational)), before);
});

test("public adapter select/register -> new instance -> per-request resolver -> exact same Session", async (t) => {
  const { root, host, operational, environment } = fixture(t);
  const a = createHeadSession({ root, purpose: "Caller A" }), b = createHeadSession({ root, purpose: "Caller B" });
  const first = host("native-A"), second = host("native-B");
  assert.equal(first.read({ root }).status, "absent");
  assert.equal(first.select({ root, sessionId: a.sessionId, expectedRevision: 0 }).retained, true);
  assert.equal(second.select({ root, sessionId: b.sessionId, expectedRevision: 0 }).retained, true);
  withSessionRoute(root, a.sessionId, () => recordSessionWorkEvidence({ root, input: { unknowns: ["Caller A observation unresolved"] } }));
  const restartedA = host("native-A"), restartedB = host("native-B");
  const results = await Promise.all([
    call(root, "head_conversation_enter", {}, restartedA),
    call(root, "head_conversation_enter", {}, restartedB),
  ]);
  assert.equal(results[0].result.structuredContent.workContext.sessionId, a.sessionId);
  assert.equal(results[0].result.structuredContent.workContext.records[0].content.unknowns[0], "Caller A observation unresolved");
  assert.equal(results[1].result.structuredContent.workContext.sessionId, b.sessionId);
  assert.equal(results[1].result.structuredContent.workContext.records.length, 0);
  const before = files(root).concat(files(operational));
  for (const source of ["startup", "resume", "clear", "compact"]) {
    const output = (await sessionStartContext({ runtime: "codex", environment,
      event: { hook_event_name: "SessionStart", session_id: "native-A", cwd: root, source } }));
    const context = JSON.parse(output.hookSpecificOutput.additionalContext);
    assert.equal(context.logicalSessionId, a.sessionId);
    assert.equal(context.records[0].content.unknowns[0], "Caller A observation unresolved");
    assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
  }
  assert.deepEqual(files(root).concat(files(operational)), before);
  assert.equal(JSON.stringify(files(root)).includes("native-A"), false);
  assert.equal(JSON.stringify(files(operational)).includes("native-A"), false);
});

test("absent/fork caller never chooses default or sole candidate; explicit current request still succeeds", async (t) => {
  const { root, host, operational, environment } = fixture(t);
  const a = createHeadSession({ root, purpose: "Only extra Session" }), caller = host("never-registered");
  const before = files(root);
  assert.equal((await caller.enter({ root })).status, "session_selection_unresolved");
  assert.equal(fs.existsSync(operational), false);
  const output = (await sessionStartContext({ runtime: "codex", environment,
    event: { hook_event_name: "SessionStart", session_id: "new-fork", cwd: root, source: "fork" } }));
  assert.equal(JSON.parse(output.hookSpecificOutput.additionalContext).logicalSessionId, null);
  const explicit = await call(root, "head_conversation_enter", { session_id: a.sessionId }, caller);
  assert.equal(explicit.result.structuredContent.workContext.sessionId, a.sessionId);
  assert.equal(caller.read({ root }).status, "absent", "Request-local explicit args do not silently register durable selection.");
  assert.deepEqual(files(root), before);
  assert.equal(fs.existsSync(operational), false);
});

test("declared sharing/default/loss and compare-and-swap are caller scoped, not completion-order selection", async (t) => {
  const { root, host } = fixture(t);
  const a = createHeadSession({ root, purpose: "A" }), b = createHeadSession({ root, purpose: "B" });
  const first = host("first"), second = host("second");
  first.select({ root, sessionId: a.sessionId, expectedRevision: 0 });
  second.select({ root, sessionId: a.sessionId, expectedRevision: 0 });
  assert.equal((await second.enter({ root })).workContext.sessionId, a.sessionId);
  const conflicting = first.select({ root, sessionId: b.sessionId, expectedRevision: 0 });
  assert.equal(conflicting.reasonCode, "SESSION_HOST_BINDING_CONFLICT");
  assert.equal((await first.enter({ root })).status, "session_selection_unresolved");
  assert.equal((await second.enter({ root })).workContext.sessionId, a.sessionId);
  const bound = first.select({ root, sessionId: b.sessionId, expectedRevision: 1 });
  assert.equal(bound.retained, true);
  assert.equal(first.select({ root, sessionId: b.sessionId, expectedRevision: 1 }).binding.revision, 2);
  first.lose({ root, expectedRevision: 2 });
  const lost = (await call(root, "head_conversation_enter", {}, host("first"))).result.structuredContent;
  assert.equal(lost.status, "session_selection_unresolved");
  assert.equal(lost.project.projectId, inspectProject(root).project.projectId);
  assert.equal(lost.ordinaryWorkBlocked, false);
  assert.equal((await call(root, "head_project_direction_read", {}, host("first"))).result.content[0].text, "null");
  first.select({ root, sessionId: "", expectedRevision: 3 });
  assert.equal((await first.enter({ root })).workContext.sessionId, inspectProject(root).state.sessionId);
});

test("verified child caller cannot overwrite parent; ambiguous Codex tool Hook writes nothing", async (t) => {
  const { root, host, operational, environment } = fixture(t);
  const a = createHeadSession({ root, purpose: "Parent" }), b = createHeadSession({ root, purpose: "Child" });
  host("shared-native").select({ root, sessionId: a.sessionId, expectedRevision: 0 });
  host("shared-native", "verified-child").select({ root, sessionId: b.sessionId, expectedRevision: 0 });
  assert.equal((await host("shared-native").enter({ root })).workContext.sessionId, a.sessionId);
  assert.equal((await host("shared-native", "verified-child").enter({ root })).workContext.sessionId, b.sessionId);
  const before = files(root).concat(files(operational));
  assert.deepEqual((await sessionStartContext({ runtime: "codex", environment,
    event: { hook_event_name: "PostToolUse", session_id: "shared-native", cwd: root, tool_use_id: "child-call", tool_input: { session_id: b.sessionId } } })), {});
  assert.deepEqual(files(root).concat(files(operational)), before);
  const claudeRoot = host("claude-native", null, "claude"), claudeChild = host("claude-native", "claude-child", "claude");
  claudeRoot.select({ root, sessionId: a.sessionId, expectedRevision: 0 });
  claudeChild.select({ root, sessionId: b.sessionId, expectedRevision: 0 });
  const childOutput = (await sessionStartContext({ runtime: "claude", environment,
    event: { hook_event_name: "SessionStart", source: "resume", session_id: "claude-native", agent_id: "claude-child", cwd: root } }));
  assert.equal(JSON.parse(childOutput.hookSpecificOutput.additionalContext).logicalSessionId, b.sessionId);
  assert.equal((await claudeRoot.enter({ root })).workContext.sessionId, a.sessionId);
});

test("interrupted binding commit stays pending after restart; repair repeats persistence, not tool effects", async (t) => {
  const { root, host } = fixture(t), a = createHeadSession({ root, purpose: "A" }), b = createHeadSession({ root, purpose: "B" });
  const caller = host("interrupted");
  caller.select({ root, sessionId: a.sessionId, expectedRevision: 0 });
  const rename = fs.renameSync;
  let publications = 0;
  fs.renameSync = (source, target) => {
    if (target.endsWith("binding.json") && ++publications === 2) throw Object.assign(new Error("Injected final commit failure"), { code: "EIO" });
    return rename(source, target);
  };
  let failed;
  try { failed = caller.select({ root, sessionId: b.sessionId, expectedRevision: 1 }); }
  finally { fs.renameSync = rename; }
  assert.equal(failed.retained, false);
  assert.equal(host("interrupted").read({ root }).status, "pending");
  assert.equal((await host("interrupted").enter({ root })).status, "session_selection_unresolved");
  const explicit = await call(root, "head_conversation_enter", { session_id: b.sessionId }, caller);
  assert.equal(explicit.result.structuredContent.workContext.sessionId, b.sessionId);
  assert.equal(host("interrupted").read({ root }).status, "pending", "Successful current request does not invent a completed registration.");
  const repaired = host("interrupted").select({ root, sessionId: b.sessionId, expectedRevision: 1 });
  assert.equal(repaired.retained, true);
  assert.equal(repaired.binding.revision, 2);
  assert.equal((await host("interrupted").enter({ root })).workContext.sessionId, b.sessionId);
});

test("tampered/foreign binding never reaches default; explicit validated request survives resolver failure", async (t) => {
  const { root, host, operational } = fixture(t), a = createHeadSession({ root, purpose: "A" });
  const caller = host("tampered");
  caller.select({ root, sessionId: a.sessionId, expectedRevision: 0 });
  const bindingFile = files(operational).find(([file]) => file.endsWith("binding.json"))[0];
  const record = JSON.parse(fs.readFileSync(bindingFile, "utf8"));
  fs.writeFileSync(bindingFile, JSON.stringify({ ...record, projectId: "head-" + "0".repeat(20) }));
  assert.equal((await caller.enter({ root })).status, "session_selection_unresolved");
  const explicit = await call(root, "head_conversation_enter", { session_id: a.sessionId }, caller);
  assert.equal(explicit.result.structuredContent.workContext.sessionId, a.sessionId);
  assert.equal(explicit.result._meta.headSessionBinding.persisted, false);
});

test("large startup direction/evidence is disclosed, bounded and never silently treated as empty", async (t) => {
  const { root, host, environment } = fixture(t);
  host("large").select({ root, sessionId: "", expectedRevision: 0 });
  updateProjectDirection({ root, input: { goal: "Preserve current scope", constraints: ["x".repeat(40000)], cancelledActions: ["deploy"] } });
  const saved = recordSessionWorkEvidence({ root, input: { unknowns: ["u".repeat(40000)] } });
  const output = (await sessionStartContext({ runtime: "codex", environment,
    event: { hook_event_name: "SessionStart", source: "compact", session_id: "large", cwd: root } }));
  assert.ok(output.hookSpecificOutput.additionalContext.length <= 32768);
  const context = JSON.parse(output.hookSpecificOutput.additionalContext);
  assert.equal(context.currentProjectDirection.contentIncluded, false);
  assert.match(context.requiredSourceExpansion, /no constraint or cancellation is assumed absent/i);
  assert.equal(context.omittedEvidenceIds.length, 0); // The reader, not this Hook, excluded the oversized original.
  assert.equal(readSessionWorkContext({ root }).omissions.byBudget, 1);
  assert.equal(context.omittedEvidenceCount, 1);
  const excerpt = context.recordExcerpts.find(item => item.source.evidenceId === saved.evidence.evidenceId);
  assert(excerpt); assert.equal(excerpt.source.evidenceDigest, saved.evidence.evidenceDigest);
  assert.equal(excerpt.partial, true); assert.equal(excerpt.coverage.conditionsMayBeOmitted, true);
  if (context.workCoverage.omissions) assert.equal(context.workCoverage.omissions.byBudget, 1);
  else {
    assert.equal(context.workCoverage.omitted, true);
    assert.equal(context.workCoverage.sourceOriginals, 1);
    assert.equal(context.workCoverage.sourceInspected, 1);
    assert.equal(context.workCoverage.sourceIncluded, 0);
    assert.equal(context.workCoverage.sourceExcerpted, 1);
  }
  assert.equal(context.persisted, false);
});

test("real hidden Node command consumes official-style startup stdin and exits; no live Hook activation", async (t) => {
  const { root, host, environment, operational } = fixture(t);
  const a = createHeadSession({ root, purpose: "Command caller" });
  host("command-native").select({ root, sessionId: a.sessionId, expectedRevision: 0 });
  withSessionRoute(root, a.sessionId, () => recordSessionWorkEvidence({ root, input: { summary: "Command reads original evidence" } }));
  const exactFiles = () => files(root).concat(files(operational)).map(([file, content]) => {
    const stat = fs.statSync(file);
    return [file, content, stat.mtimeMs, stat.mode];
  });
  const before = exactFiles();
  const event = { hook_event_name: "SessionStart", source: "compact", session_id: "command-native", cwd: root,
    prompt: "synthetic-private-prompt", last_assistant_message: "synthetic-private-response",
    token: "synthetic-private-token", command: "synthetic-private-command" };
  const result = await localContinuityCommand([path.join(pluginRoot, "scripts/session-host-hook.mjs"), "--runtime", "codex"],
    { cwd: root, environment: { ...process.env, ...environment }, input: JSON.stringify(event) });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(JSON.parse(output.hookSpecificOutput.additionalContext).logicalSessionId, a.sessionId);
  const capability = JSON.parse(output.hookSpecificOutput.additionalContext).hostCapability;
  assert.match(capability, /verified Host\/explicit route/i);
  assert.match(capability, /no extra bind\/save\/repeated Session ID/i);
  assert.equal(output.continue, undefined);
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
  const sha = value => crypto.createHash("sha256").update(value).digest("hex");
  const owner = { projectId: inspectProject(root).project.projectId, rootDigest: sha(fs.realpathSync(root)),
    callerDigest: sha(JSON.stringify(["codex", "command-native", null])) };
  const snapshotFile = path.join(operational, "native-observations", sha(JSON.stringify(owner)), "snapshot.json");
  assert.deepEqual(exactFiles().filter(([file]) => file !== snapshotFile), before,
    "Only the exact caller's optional P5 snapshot may be added; canonical and binding bytes/mtime/mode stay unchanged.");
  assert.equal(exactFiles().length, before.length + 1, "No lock or additional operational artifact remains.");
  const raw = fs.readFileSync(snapshotFile, "utf8");
  assert.ok(Buffer.byteLength(raw) <= NATIVE_OBSERVATION_LIMITS.bytes);
  assert.doesNotMatch(raw, /synthetic-private-/u);
  const after = exactFiles();
  // The store reader verifies schema, owner, digest, slot/replay bounds and row keys.
  const state = createNativeObservationStore({ environment }).read({ root,
    caller: { runtime: "codex", nativeSessionId: "command-native", agentId: null } });
  assert.deepEqual(state.owner, owner);
  assert.equal(state.kind, "NativeObservationSnapshot"); assert.equal(state.version, 1);
  assert.equal(state.sequence, 1); assert.equal(state.omitted, 0); assert.deepEqual(state.replay, []);
  assert.equal(state.rows.length, 1);
  assert.deepEqual(state.rows[0].observation, { kind: "event", event: "SessionStart", phase: "start-observed",
    requestId: null, source: "compact", reason: null });
  assert.deepEqual((await sessionStartContext({ runtime: "codex", environment, event })), output);
  assert.deepEqual(exactFiles(), after, "Observation read and pure startup projection write nothing.");
});

test("concurrent real local writers converge identical evidence and retain different Session work", async (t) => {
  const { root } = fixture(t), a = createHeadSession({ root, purpose: "A" }), b = createHeadSession({ root, purpose: "B" });
  const driver = path.join(pluginRoot, "test/helpers/session-work-driver.mjs");
  const results = await Promise.all([
    ...Array.from({ length: 3 }, () => localContinuityCommand([driver, root, a.sessionId, "Identical selected observation"], { cwd: root })),
    localContinuityCommand([driver, root, b.sessionId, "Different selected observation"], { cwd: root }),
  ]);
  results.forEach((result) => assert.equal(result.code, 0, result.stderr));
  const parsed = results.map((result) => JSON.parse(result.stdout));
  assert.equal(new Set(parsed.slice(0, 3).map((item) => item.evidenceId)).size, 1);
  assert.equal(parsed.slice(0, 3).reduce((sum, item) => sum + item.writes, 0), 1);
  assert.notEqual(parsed[3].evidenceId, parsed[0].evidenceId);
  assert.equal(withSessionRoute(root, a.sessionId, () => inspectProject(root).state.latestCheckpoint), null);
  assert.equal(withSessionRoute(root, b.sessionId, () => inspectProject(root).state.latestCheckpoint), null);
});
