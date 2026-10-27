import { relativeProjectArtifact } from "../scripts/lib/project-storage-format.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { createHeadSession, sessionStatePath, withSessionRoute } from "../scripts/lib/session-routing.mjs";
import { inspectRecoveryCheckpointBasis, syncRecoveryCheckpoint, readRecoveryCheckpoint } from "../scripts/lib/compaction-recovery.mjs";
import { enterConversationRecovery } from "../scripts/lib/compaction-lifecycle.mjs";
import { readProjectDirection, updateProjectDirection } from "../scripts/lib/project-direction.mjs";
import { readSessionWorkContext, recordSessionWorkEvidence } from "../scripts/lib/session-work-context.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { runCommand } from "../scripts/head.mjs";
import { createSessionCallContext } from "../scripts/lib/session-routing.mjs";
import { formatCliResult } from "../scripts/lib/cli-presentation.mjs";
import { startupProjection } from "../scripts/lib/session-host-context-projection.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
function project(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "head-work-context-")));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, storage };
}
function originals(root) {
  const files = {};
  function visit(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) visit(file);
      else files[path.relative(root, file)] = sha(fs.readFileSync(file));
    }
  }
  visit(root);
  return files;
}
const direction = (purpose = "Investigate the cache") => ({
  purpose, approvedDecisions: [], currentPosition: "No execution started", nextExpectedResult: "Explain the result",
});
const sync = (root, fields) => syncRecoveryCheckpoint({
  root, expectedRecoveryBasisId: inspectRecoveryCheckpointBasis({ root }).basis.basisId, ...fields,
});

test("existing Run-free P2 preserves Session-local purpose, constraints and latest cancellation without shared promotion", (t) => {
  const { root, storage } = project(t);
  const a = createHeadSession({ root, purpose: "Investigate cache only; do not deploy" });
  const b = createHeadSession({ root, purpose: "Independent documentation" });
  withSessionRoute(root, a.sessionId, () => {
    sync(root, { ...direction("Investigate cache only; do not deploy"), approvedDecisions: ["Current user scope: local files only; no network"] });
    const old = inspectProject(root).state.latestCheckpoint;
    const final = sync(root, { ...direction("Investigate cache only; do not deploy"),
      approvedDecisions: ["Current user scope: local files only; no network", "User cancelled cache rewrite for this Session"],
      currentPosition: "Rewrite cancelled; earlier rewrite proposal is historical", nextExpectedResult: "Read-only explanation; no rewrite" });
    assert.equal(final.outcome, "created");
    const entry = enterConversationRecovery({ root });
    assert.equal(entry.restore.checkpoint.purpose, "Investigate cache only; do not deploy");
    assert.ok(entry.restore.checkpoint.approvedDecisions.includes("User cancelled cache rewrite for this Session"));
    assert.equal(entry.restore.checkpoint.nextExpectedResult, "Read-only explanation; no rewrite");
    assert.equal(entry.restore.projection.consumerInstruction.historicalApprovalGrantsCurrentEffect, false);
    assert.equal(readRecoveryCheckpoint({ root, checkpointId: old }).checkpoint.nextExpectedResult, "Explain the result");
  });
  assert.equal(readProjectDirection({ root }), null);
  withSessionRoute(root, b.sessionId, () => {
    assert.equal(inspectProject(root).state.purpose, "Independent documentation");
    assert.equal(inspectProject(root).state.latestCheckpoint, null);
  });
});

test("one Run-free evidence save -> same Session read-only entry; no Run, checkpoint, history or index needed", (t) => {
  const { root, storage } = project(t);
  const a = createHeadSession({ root, purpose: "Cache investigation" });
  const originalDefault = fs.readFileSync(sessionStatePath(root, storage));
  withSessionRoute(root, a.sessionId, () => {
    const retained = recordSessionWorkEvidence({ root, input: {
      judgments: [{ assessment: "Reuse the original cache", reason: "Rebuilding would discard observed provenance", alternatives: ["Rebuild from lexical matches"] }],
      observedWork: ["Inspected cache read path"], pending: ["Verify replacement behavior"], unknowns: ["Real Host behavior untested"],
    } });
    assert.equal(retained.writes, 1);
    assert.equal(retained.evidence.authorityBoundary.planeId, "P3");
    const before = originals(root);
    const entry = enterConversationRecovery({ root });
    assert.equal(entry.status, "conversation_ready");
    assert.equal(entry.workContext.records[0].evidenceId, retained.evidence.evidenceId);
    assert.equal(entry.workContext.sessionPurpose, "Cache investigation");
    assert.equal(entry.workContext.records[0].content.judgments[0].reason, "Rebuilding would discard observed provenance");
    assert.equal(entry.workContext.recoveryAuthority, false);
    assert.deepEqual(originals(root), before);
    assert.equal(inspectProject(root).state.latestCheckpoint, null);
    assert.equal(inspectProject(root).state.activeRunId, null);
  });
  assert.deepEqual(fs.readFileSync(sessionStatePath(root, storage)), originalDefault);
  assert.equal(enterConversationRecovery({ root }).workContext.records.length, 0);
});

test("one checkpoint sync optionally retains evidence; exact retry writes neither original nor P2 pointer", (t) => {
  const { root, storage } = project(t);
  const fields = { ...direction(), workEvidence: { summary: "Rejected global cache eviction", unknowns: ["Cause still uncertain"] } };
  const first = sync(root, fields);
  assert.equal(first.outcome, "created");
  assert.equal(first.workEvidence.writes, 1);
  assert.equal(first.checkpoint.workEvidence, undefined);
  assert.equal(first.checkpoint.nextExpectedResult, "Explain the result");
  const before = originals(root);
  const second = sync(root, fields);
  assert.equal(second.outcome, "reused");
  assert.equal(second.workEvidence.writes, 0);
  assert.deepEqual(originals(root), before);
  assert.equal(enterConversationRecovery({ root }).workContext.records.length, 1);
});

test("P3 retention stays P3 when checkpoint basis conflicts; common cancellation wins over old suggestions", (t) => {
  const { root, storage } = project(t);
  const basis = inspectRecoveryCheckpointBasis({ root }).basis.basisId;
  sync(root, direction("Current local investigation"));
  updateProjectDirection({ root, expectedDirectionId: null, input: { goal: "Investigate", cancelledActions: ["deploy"] } });
  const outcome = syncRecoveryCheckpoint({ root, expectedRecoveryBasisId: basis, ...direction("Stale proposal"),
    workEvidence: { suggestedFollowUp: ["Historical suggestion: deploy"], unknowns: ["Deployment outcome unknown; do not replay"] } });
  assert.equal(outcome.outcome, "conflict");
  assert.equal(outcome.workEvidence.writes, 1);
  const entry = enterConversationRecovery({ root });
  assert.equal(entry.restore.checkpoint.purpose, "Current local investigation");
  assert.deepEqual(entry.restore.projection.currentProjectDirection.input.cancelledActions, ["deploy"]);
  assert.equal(entry.workContext.executionReplayAllowed, false);
  assert.equal(entry.workContext.records[0].content.suggestedFollowUp[0], "Historical suggestion: deploy");
});

test("optional evidence storage failure does not block explicit P2; retry repairs only missing save", (t) => {
  const { root, storage } = project(t);
  const original = fs.linkSync;
  fs.linkSync = (source, target) => {
    if (target.includes("work-evidence")) throw Object.assign(new Error("Synthetic storage failure"), { code: "EACCES" });
    return original(source, target);
  };
  let outcome;
  try { outcome = sync(root, { ...direction(), workEvidence: { summary: "Useful selected evidence" } }); }
  finally { fs.linkSync = original; }
  assert.equal(outcome.outcome, "created");
  assert.equal(outcome.workEvidence.status, "work_evidence_retention_unconfirmed");
  const checkpointBytes = fs.readFileSync(path.join(root, relativeProjectArtifact(storage, "sessions", "ledger"), outcome.checkpoint.checkpointId + ".json"));
  const retry = sync(root, { ...direction(), workEvidence: { summary: "Useful selected evidence" } });
  assert.equal(retry.outcome, "reused");
  assert.equal(retry.workEvidence.writes, 1);
  assert.deepEqual(fs.readFileSync(path.join(root, relativeProjectArtifact(storage, "sessions", "ledger"), outcome.checkpoint.checkpointId + ".json")), checkpointBytes);
});

test("publication succeeded but acknowledgement failed: exact retry reuses bytes, not completed work", (t) => {
  const { root, storage } = project(t);
  const original = fs.linkSync;
  fs.linkSync = (source, target) => {
    const result = original(source, target);
    if (target.includes("work-evidence")) throw Object.assign(new Error("Synthetic post-publication failure"), { code: "EIO" });
    return result;
  };
  try { assert.throws(() => recordSessionWorkEvidence({ root, input: { summary: "Already inspected source" } }), { code: "EIO" }); }
  finally { fs.linkSync = original; }
  const before = originals(root);
  const retry = recordSessionWorkEvidence({ root, input: { summary: "Already inspected source" } });
  assert.equal(retry.writes, 0);
  assert.deepEqual(originals(root), before);
});

test("retries reuse identical input; distinct occurrences and changed judgments remain separate evidence", (t) => {
  const { root, storage } = project(t);
  const first = recordSessionWorkEvidence({ root, input: { summary: "Cache observed" } });
  assert.equal(recordSessionWorkEvidence({ root, input: { summary: "Cache observed" } }).evidence.evidenceId, first.evidence.evidenceId);
  const second = recordSessionWorkEvidence({ root, input: { summary: "Cache observed", occurrenceKey: "after-source-change" } });
  const third = recordSessionWorkEvidence({ root, input: { summary: "Cache judgment revised" } });
  assert.notEqual(second.evidence.evidenceId, first.evidence.evidenceId);
  assert.notEqual(third.evidence.evidenceId, first.evidence.evidenceId);
  assert.equal(readSessionWorkContext({ root }).records.length, 3);
});

test("exact source refs disclose changed/missing bytes; retries do not require redoing original effects", (t) => {
  const { root, storage } = project(t), file = path.join(root, "cache.mjs");
  fs.writeFileSync(file, "export const cache = 1;");
  const input = { summary: "Observed original cache", references: [{ path: "cache.mjs", digest: sha(fs.readFileSync(file)), kind: "source" }] };
  recordSessionWorkEvidence({ root, input });
  assert.equal(readSessionWorkContext({ root }).records[0].references[0].status, "matching-current-bytes");
  fs.writeFileSync(file, "export const cache = 2;");
  assert.equal(recordSessionWorkEvidence({ root, input }).writes, 0);
  assert.equal(readSessionWorkContext({ root }).records[0].references[0].reasonCode, "SESSION_WORK_REFERENCE_CHANGED");
  fs.unlinkSync(file);
  assert.equal(readSessionWorkContext({ root }).records[0].references[0].contentReconstructed, false);
});

test("one damaged original does not block valid evidence, P2 restore or independent work", (t) => {
  const { root, storage } = project(t);
  sync(root, direction());
  const bad = recordSessionWorkEvidence({ root, input: { summary: "Bad record" } });
  recordSessionWorkEvidence({ root, input: { unknowns: ["Preserve this uncertainty"] } });
  fs.writeFileSync(bad.file, JSON.stringify({ ...bad.evidence, content: { summary: "Tampered" } }));
  const before = originals(root), entry = enterConversationRecovery({ root });
  assert.equal(entry.status, "conversation_direction_restored");
  assert.equal(entry.workContext.status, "work_context_partial");
  assert.equal(entry.workContext.records.length, 1);
  assert.equal(entry.workContext.unavailable.length, 1);
  assert.equal(entry.ordinaryWorkBlocked, false);
  assert.deepEqual(originals(root), before);
});

test("bounded entry discloses omissions; exact expansion is read-only and missing original is unavailable", (t) => {
  const { root, storage } = project(t), ids = [];
  for (let i = 0; i < 10; i += 1) ids.push(recordSessionWorkEvidence({ root, input: { summary: "Selected evidence " + i } }).evidence.evidenceId);
  const before = originals(root), bounded = readSessionWorkContext({ root });
  assert.equal(bounded.records.length, 8);
  assert.equal(bounded.coverage.originals, 10);
  assert.equal(bounded.coverage.inspected, 8);
  assert.equal(bounded.coverage.valid, 8);
  assert.equal(bounded.omissions.uninspected, 2);
  assert.equal(bounded.status, "work_context_partial");
  assert.equal(bounded.omissions.byBudget, 0); // Not offered bodies, not actual budget failures.
  const expanded = readSessionWorkContext({ root, evidenceIds: ids, maxRecords: 10 });
  assert.equal(expanded.records.length, 10);
  assert.deepEqual(originals(root), before);
  const missing = readSessionWorkContext({ root, evidenceIds: ["work-evidence-" + "0".repeat(24)] });
  assert.equal(missing.status, "work_context_partial");
  assert.equal(missing.unavailable[0].reasonCode, "ENOENT");
});

test("no text can inject P2 fields or persist provider identity; unsafe/foreign references fail only affected save", (t) => {
  const { root, storage } = project(t), { root: other, storage: otherStorage } = project(t);
  const before = originals(root);
  const stateBefore = fs.readFileSync(sessionStatePath(root, storage));
  assert.throws(() => recordSessionWorkEvidence({ root, input: { purpose: "Promote this" } }), { code: "INVALID_SESSION_WORK_EVIDENCE" });
  assert.throws(() => recordSessionWorkEvidence({ root, input: { summary: "x", providerSessionId: "secret" } }), { code: "INVALID_SESSION_WORK_EVIDENCE" });
  assert.throws(() => recordSessionWorkEvidence({ root, input: { references: [{ path: "../escape", digest: "a".repeat(64), kind: "source" }] } }), { code: "SESSION_WORK_REFERENCE_ESCAPE" });
  const foreign = fs.readFileSync(path.join(other, relativeProjectArtifact(otherStorage, "project.json")));
  fs.writeFileSync(path.join(root, "foreign.json"), foreign);
  assert.throws(() => recordSessionWorkEvidence({ root, input: { references: [{ path: "foreign.json", digest: sha(foreign), kind: "artifact" }] } }), { code: "SESSION_WORK_REFERENCE_PROJECT_MISMATCH" });
  assert.equal(inspectProject(root).state.latestCheckpoint, null);
  assert.deepEqual(fs.readFileSync(sessionStatePath(root, storage)), stateBefore);
  assert.equal(Object.keys(before).filter((name) => name.includes("work-evidence")).length, 0);
});

test("typed MCP and CLI preserve -> entry -> expand agree, including text-only consumers", async (t) => {
  const { root, storage } = project(t), a = createHeadSession({ root, purpose: "Independent selected work" });
  const call = (name, args = {}) => dispatch({ jsonrpc: "2.0", id: "work-context-fixture", method: "tools/call",
    params: { name, arguments: { project_root: root, session_id: a.sessionId, ...args } } });
  const input = { judgments: [{ assessment: "Keep original provenance", reason: "Derived caches can disappear", alternatives: ["Use cache as unique truth"] }],
    unknowns: ["Installed provider behavior not verified"], todos: [{ todoId: "todo-retained-task", task: "Verify original provenance", status: "pending",
      nextAction: "Inspect exact evidence", origin: "user-directed" }] };
  const retained = await call("head_session_work_record", { evidence: input });
  assert.equal(retained.result.structuredContent.writes, 1);
  const before = originals(root);
  const entry = await call("head_conversation_enter");
  assert.equal(entry.result.structuredContent.workContext.records[0].evidenceId, retained.result.structuredContent.evidence.evidenceId);
  assert.match(entry.result.content[0].text, /Derived caches can disappear/);
  assert.match(entry.result.content[0].text, /not current direction or permission/);
  assert.match(entry.result.content[0].text, /todo-retained-task \[pending\]/);
  assert.equal(entry.result.structuredContent.workContext.todoContext.items[0].todoId, "todo-retained-task");
  const cliEntry = runCommand(["conversation-enter", root, "--session", a.sessionId]);
  assert.deepEqual(cliEntry.workContext, entry.result.structuredContent.workContext);
  assert.match(formatCliResult("conversation-enter", cliEntry), /Installed provider behavior not verified/);
  const read = await call("head_session_work_read", { evidence_ids: [retained.result.structuredContent.evidence.evidenceId] });
  assert.equal(read.result.structuredContent.records.length, 1);
  assert.deepEqual(runCommand(["session-work-read", root, "--session", a.sessionId]).records, read.result.structuredContent.records);
  const todoRead = await dispatch({ jsonrpc: "2.0", id: "todo-router", method: "tools/call", params: {
    name: "head_tools_read", arguments: { name: "head_session_work_read", arguments: { project_root: root, session_id: a.sessionId, todo_id: "todo-retained-task" } } } });
  assert.equal(todoRead.result.structuredContent.todoContext.items[0].task, "Verify original provenance");
  assert.deepEqual(originals(root), before);
});

test("explicit Todo revisions outlive recent work and preserve conflicting branches without P2 changes", t => {
  const { root, storage } = project(t), session = createHeadSession({ root, purpose: "Inspect locally; no deployment" });
  withSessionRoute(root, session.sessionId, () => {
    const state = fs.readFileSync(sessionStatePath(root, storage));
    const save = todos => recordSessionWorkEvidence({ root, input: { todos } });
    const exact = saved => ({ evidenceId: saved.evidence.evidenceId, evidenceDigest: saved.evidence.evidenceDigest });
    const item = { todoId: "todo-old-open", task: "Finish bounded validation", status: "pending", nextAction: "Run focused validation", origin: "user-directed" };
    const first = save([item]), firstBytes = fs.readFileSync(first.file);
    for (let index = 0; index < 10; index++) recordSessionWorkEvidence({ root, input: { summary: "Unrelated later note " + index } });
    const entry = enterConversationRecovery({ root });
    assert.equal(entry.workContext.todoContext.items[0].todoId, item.todoId);
    assert.equal(entry.workContext.todoContext.coverage.recentWorkLimitApplied, false);
    assert.match(startupProjection(entry, root, "claude"), /todo-old-open/);
    const partial = save([{ ...item, status: "partial", progress: "Observed the first case", prior: exact(first) }]);
    const waiting = save([{ ...item, status: "waiting", reason: "Waiting for independent evidence", prior: exact(partial) }]);
    assert.equal(readSessionWorkContext({ root }).todoContext.items[0].status, "waiting");
    const completed = { ...item, status: "completed", progress: "Focused validation evidence retained", prior: exact(waiting) };
    const done = save([completed]);
    assert.equal(save([completed]).evidence.evidenceId, done.evidence.evidenceId);
    assert.equal(save([item]).evidence.evidenceId, first.evidence.evidenceId, "Retry cannot reopen an old revision");
    assert.equal(readSessionWorkContext({ root }).todoContext.items.length, 0);
    const cancelled = save([{ ...item, status: "cancelled", reason: "User changed scope", prior: exact(waiting) }]);
    const conflict = readSessionWorkContext({ root }).todoContext.items[0];
    assert.equal(conflict.status, "conflict");
    assert.deepEqual(conflict.revisions.map(value => value.status).sort(), ["cancelled", "completed"]);
    assert.throws(() => save([{ ...item, todoId: "todo-different", prior: exact(cancelled) }]), { code: "SESSION_TODO_PRIOR_MISMATCH" });
    assert.deepEqual(fs.readFileSync(first.file), firstBytes);
    assert.deepEqual(fs.readFileSync(sessionStatePath(root, storage)), state);
    assert.equal(readProjectDirection({ root }), null);
    const indexPath = path.join(root, storage.directory, "graph-discovery/index.json"), indexBytes = fs.readFileSync(indexPath);
    fs.unlinkSync(indexPath);
    const unknown = readSessionWorkContext({ root });
    assert.equal(unknown.todoContext.coverage.indexCoverage, "unknown");
    assert.equal(unknown.todoContext.items[0].status, "conflict", "Reuse already verified originals without treating index loss as empty");
    assert.equal(unknown.ordinaryWorkBlocked, false);
    const scanned = readSessionWorkContext({ root, scanTodos: true, todoId: item.todoId });
    assert.equal(scanned.todoContext.items[0].status, "conflict");
    fs.writeFileSync(indexPath, indexBytes);
    save([{ ...item, status: "pending", reason: "Current scope keeps local verification open", prior: exact(done), resolves: [exact(cancelled)] }]);
    const resolved = readSessionWorkContext({ root }).todoContext;
    assert.equal(resolved.items[0].status, "pending");
    assert.equal(resolved.coverage.inspectedOriginals, 1, "Read the indexed head, not the entire Todo revision history");
    const pageSave = save(Array.from({ length: 12 }, (_, index) => ({ ...item, todoId: "todo-page-" + String(index).padStart(2, "0") })));
    const page = readSessionWorkContext({ root, maxRecords: 2 }).todoContext;
    assert.equal(page.items.length, 2); assert.equal(page.knownOpenCount, 13); assert(page.nextAfterTodoId);
    const next = readSessionWorkContext({ root, maxRecords: 2, afterTodoId: page.nextAfterTodoId }).todoContext;
    assert(next.items.every(value => value.todoId > page.nextAfterTodoId));
    assert.equal(readSessionWorkContext({ root, todoId: "todo-page-11" }).todoContext.items[0].todoId, "todo-page-11");
    const tiny = readSessionWorkContext({ root, maxCharacters: 2 }).todoContext;
    assert.equal(tiny.items.length, 0); assert.equal(tiny.coverage.omittedItems, 13); assert(tiny.coverage.omittedItemIds.length);
    const healthy = fs.readFileSync(indexPath), forged = JSON.parse(healthy);
    const row = forged.sessionTodoNavigation.rows.find(value => value.todoRevisions.some(todo => todo.todoId === "todo-page-11"));
    row.todoRevisions[0].status = "cancelled"; fs.writeFileSync(indexPath, JSON.stringify(forged));
    const forgedBytes = fs.readFileSync(indexPath);
    const drift = readSessionWorkContext({ root, todoId: "todo-page-11" }).todoContext;
    assert.equal(drift.items[0].status, "pending", "A fresh original overrides the untrusted index hint");
    assert.equal(drift.coverage.indexHintMismatchCount, 1);
    assert.deepEqual(fs.readFileSync(indexPath), forgedBytes, "Reading does not repair the index");
    fs.writeFileSync(indexPath, healthy);
    const rename = fs.renameSync; let deferred;
    fs.renameSync = (from, to, ...args) => {
      if (path.resolve(to) === indexPath) throw Object.assign(new Error("Synthetic deferred index"), { code: "EACCES" });
      return rename(from, to, ...args);
    };
    try { deferred = save([{ ...item, todoId: "todo-page-11", status: "waiting", reason: "Await local evidence", prior: exact(pageSave) }]); }
    finally { fs.renameSync = rename; }
    assert.equal(deferred.graphIndex.status, "deferred");
    const recovered = readSessionWorkContext({ root, todoId: "todo-page-11" }).todoContext;
    assert.equal(recovered.items[0].status, "waiting", "An unindexed canonical revision joins this same read");
    assert.equal(recovered.items[0].revision.evidenceId, deferred.evidence.evidenceId);
  });
});

test("new work calls preserve known-loss boundaries without blocking independent Project facts", async (t) => {
  const { root, storage } = project(t), context = createSessionCallContext();
  context.lose(root);
  const before = originals(root);
  for (const name of ["head_session_work_record", "head_session_work_read"]) {
    const result = await dispatch({ jsonrpc: "2.0", id: "lost-work", method: "tools/call",
      params: { name, arguments: { project_root: root, ...(name.endsWith("record") ? { evidence: { summary: "Do not write default" } } : {}) } } },
    { sessionContext: context });
    assert.equal(result.result.structuredContent.status, "session_selection_unresolved");
    assert.equal(result.result.structuredContent.ordinaryWorkBlocked, false);
  }
  const independent = runCommand(["project-direction-read", root], { sessionContext: context });
  assert.equal(independent, null);
  assert.deepEqual(originals(root), before);
});

test("existing uppercase logical Session identities remain exact through record and entry", (t) => {
  const { root, storage } = project(t);
  const id = "session-AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
  createHeadSession({ root, sessionId: id, purpose: "Case-preserving identity" });
  withSessionRoute(root, id, () => {
    recordSessionWorkEvidence({ root, input: { unknowns: ["Host not verified"] } });
    const entry = enterConversationRecovery({ root });
    assert.equal(entry.workContext.sessionId, id);
    assert.equal(entry.workContext.records[0].sessionId, id);
  });
});

test("output budget accounts for enriched references; omissions retain exact expansion identities", (t) => {
  const { root, storage } = project(t), references = [];
  for (let i = 0; i < 30; i += 1) {
    const name = "reference-" + i + ".mjs", body = "export const item = " + i + ";";
    fs.writeFileSync(path.join(root, name), body);
    references.push({ path: name, digest: sha(body), kind: "source" });
  }
  const saved = recordSessionWorkEvidence({ root, input: { summary: "Bounded reference evidence", references } });
  const small = readSessionWorkContext({ root, maxCharacters: 4460 });
  assert.ok(JSON.stringify(small.records).length <= 4460);
  assert.equal(small.coverage.usedCharacters, JSON.stringify(small.records).length);
  assert.deepEqual(small.omissions.evidenceIds, [saved.evidence.evidenceId]);
  const expanded = readSessionWorkContext({ root, evidenceIds: small.omissions.evidenceIds, maxCharacters: 32768 });
  assert.equal(expanded.records.length, 1);
  assert.equal(expanded.coverage.usedCharacters, JSON.stringify(expanded.records).length);
  assert.equal(expanded.records[0].content.references.length, 30);
});

test("a new common cancellation during evidence composition cannot accompany a stale successful entry", (t) => {
  const { root, storage } = project(t);
  sync(root, direction());
  const saved = recordSessionWorkEvidence({ root, input: { pending: ["Historical deploy proposal"] } });
  const read = fs.readFileSync;
  let changed = false;
  fs.readFileSync = (file, ...args) => {
    const bytes = read(file, ...args);
    if (file === saved.file && !changed) {
      changed = true;
      updateProjectDirection({ root, expectedDirectionId: null, input: { goal: "Investigate only", cancelledActions: ["deploy"] } });
    }
    return bytes;
  };
  let entry;
  try { entry = enterConversationRecovery({ root }); } finally { fs.readFileSync = read; }
  assert.equal(changed, true);
  assert.equal(entry.reasonCode, "CONVERSATION_ENTRY_BASIS_CHANGED");
  assert.equal(entry.ordinaryWorkBlocked, false);
  assert.equal(entry.restore, undefined);
  assert.equal(entry.workContext.records.length, 0);
  assert.deepEqual(entry.currentProjectDirection.input.cancelledActions, ["deploy"]);
  const before = originals(root), retry = enterConversationRecovery({ root });
  assert.equal(retry.status, "conversation_direction_restored");
  assert.deepEqual(retry.restore.projection.currentProjectDirection.input.cancelledActions, ["deploy"]);
  assert.deepEqual(originals(root), before);
});
