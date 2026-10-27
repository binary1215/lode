import { relativeProjectArtifact } from "../scripts/lib/project-storage-format.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { dispatch, catalogTools } from "../scripts/mcp-server.mjs";
import { runCommand } from "../scripts/head.mjs";
import { formatCliResult, formatMcpToolContent, formatConversationRecovery } from "../scripts/lib/cli-presentation.mjs";
import { enterConversationRecovery } from "../scripts/lib/compaction-lifecycle.mjs";
import { inspectRecoveryCheckpointBasis, syncRecoveryCheckpoint } from "../scripts/lib/compaction-recovery.mjs";
import { updateProjectDirection } from "../scripts/lib/project-direction.mjs";
import { createSessionHostAdapter } from "../scripts/lib/session-host-adapter.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { createWholePlanSnapshot, createExecutionContract } from "../scripts/lib/execution-lineage.mjs";
import { startRun, finishRun } from "../scripts/lib/run-lineage.mjs";
import { sessionStartContext } from "../scripts/session-host-hook.mjs";
import { startupProjection } from "../scripts/lib/session-host-context-projection.mjs";
import { fitSelectedBodyGroups } from "../scripts/lib/session-work-body-organization.mjs";
import { createSessionCallContext, withSessionCallContext, withSessionRoute, sessionStatePath, createHeadSession } from "../scripts/lib/session-routing.mjs";
import { inspectProject } from "../scripts/lib/head-core.mjs";
import { readSessionWorkList } from "../scripts/lib/session-work-context.mjs";
import { fixture, exact, link, representative, snapshot, recordFor, accounting, pluginRoot } from "./helpers/session-work-linkage-fixture.mjs";

const directionView = value => value ? Object.fromEntries(["directionId", "directionHash", "input"].filter(key => value[key] !== undefined).map(key => [key, value[key]])) : null;

test("A-D: concise Work/Todo text preserves exact branches, old tasks, unknown fields and unchanged CLI/MCP JSON", async t => {
  const f = fixture(t, "PurposeFirstQjvm7812"), task = { todoId: "todo-readable", task: "ReadableTaskMarkerXgvm8821", origin: "user-directed", nextAction: "NextActionMarkerMhvn1422", priority: "Original priority, no score" };
  const base = f.save({ summary: "RecentChoiceMarkerKfvn5731", todos: [{ ...task, status: "pending" }] });
  f.save({ todos: [{ ...task, status: "partial", progress: "ProgressMarkerQjdn9713", prior: exact(base) }] });
  f.save({ todos: [{ ...task, status: "waiting", reason: "ReasonMarkerPnvm6822", prior: exact(base) }] });
  const before = snapshot(f.base), work = f.read(), encoded = JSON.stringify(work);
  const text = formatCliResult("session-work-read", work);
  assert.equal(JSON.stringify(work), encoded);
  assert.ok(text.indexOf("PurposeFirstQjvm7812") < text.indexOf("RecentChoiceMarkerKfvn5731"));
  const bodyOccurrences = work.records.flatMap(record => record.content.todos || []).filter(todo => todo.task === task.task).length;
  assert.equal(text.split(task.task).length - 1, bodyOccurrences, "Only the exact already-shown original may replace aggregate repetition");
  assert.match(text, /Exact task fields already displayed/u); assert.match(text, /conflict/u);
  for (const value of [task.priority, task.nextAction, "ProgressMarkerQjdn9713", "ReasonMarkerPnvm6822", base.evidence.evidenceDigest]) assert.ok(text.includes(value));
  assert.equal(text.includes("workContext.todoContext: {"), false);
  for (const routed of [false, true]) {
    const result = await call(f, "head_session_work_read", {}, routed);
    assert.deepEqual(result.structuredContent, work); assert.equal(result.content[0].text, text);
  }
  const unknown = structuredClone(work); unknown.todoContext.futureCoverage = { marker: "UnknownCoverageMarkerXqvr1933" };
  unknown.todoContext.items[0].futureTask = "UnknownTaskMarkerBvnq7831";
  const unknownBefore = JSON.stringify(unknown), unknownText = formatCliResult("session-work-read", unknown);
  assert.ok(unknownText.includes("UnknownCoverageMarkerXqvr1933")); assert.ok(unknownText.includes("UnknownTaskMarkerBvnq7831"));
  assert.equal(JSON.stringify(unknown), unknownBefore);
  const list = runCommand(["session-list", f.root]), listBefore = JSON.stringify(list), listText = formatCliResult("session-list", list);
  assert.equal(listText.split("PurposeFirstQjvm7812").length - 1, 1);
  assert.match(listText, /remaining tasks are uninspected/u); assert.match(listText, /existing list session_id/u);
  assert.equal(JSON.stringify(list), listBefore); assert.deepEqual(snapshot(f.base), before);
  // Keep older independent tasks visible without reprinting every history body.
  for (let i = 0; i < 9; i++) f.save({ summary: `Unrelated recent note ${i}` });
  fs.unlinkSync(base.file); // Fixture-only missing prior, never reader repair.
  const afterSetup = snapshot(f.base), older = f.read(), olderText = formatCliResult("session-work-read", older);
  for (const value of [task.task, task.priority, task.nextAction, "ReasonMarkerPnvm6822", "missingPriors", base.evidence.evidenceId]) assert.ok(olderText.includes(value));
  assert.ok(older.todoContext.items[0].missingPriors.length > 0);
  assert.deepEqual(snapshot(f.base), afterSetup);
});

test("S1-S6: CLI and direct/router MCP previews preserve bound/unselected/lost context and concurrent outer routes", async t => {
  const f = fixture(t, "Same title"), a = createHeadSession({ root: f.root, purpose: "Same title" });
  f.save({ summary: "B original conclusion", unknowns: ["Effect unknown"], pending: ["B remains"] });
  const before = snapshot(f.base);
  const request = (sessionId, router = null) => ({ id: 1, method: "tools/call", params: {
    name: router || "head_session_list", arguments: router
      ? { name: "head_session_list", arguments: { project_root: f.root, session_id: sessionId, max_sessions: 1 } }
      : { project_root: f.root, session_id: sessionId, max_sessions: 1 } } });
  for (const state of ["bound", "unselected", "lost"]) {
    const context = createSessionCallContext();
    if (state === "bound") context.select(f.root, a.sessionId);
    if (state === "lost") context.lose(f.root);
    const selection = context.read(f.root);
    await withSessionRoute(f.root, a.sessionId, async () => {
      const aPath = sessionStatePath(f.root, f.storage);
      const cli = runCommand(["session-list", f.root, "--session", f.session.sessionId, "--max-sessions", "1"], { sessionContext: context });
      assert.equal(cli.preview.workContext.sessionId, f.session.sessionId);
      assert.equal(cli.preview.conclusion.representativeResult, "not-designated");
      assert.match(formatCliResult("session-list", cli), /B original conclusion/u);
      assert.deepEqual(context.read(f.root), selection); assert.equal(sessionStatePath(f.root, f.storage), aPath);
      let resolutions = 0;
      for (const router of [null, "head_tools_read", "head_tools_call"]) {
        const options = { sessionContext: context, resolveSessionContext() { resolutions++; throw new Error("Preview must not resolve a binding"); } };
        const [b, other] = await Promise.all([dispatch(request(f.session.sessionId, router), options), dispatch(request(a.sessionId, router), options)]);
        assert.equal(b.result.structuredContent.preview.workContext.sessionId, f.session.sessionId);
        assert.equal(other.result.structuredContent.preview.workContext.sessionId, a.sessionId);
        assert.equal(b.result.structuredContent.sessions.length, 1);
        const bad = await dispatch(request("../invalid", router), options);
        assert.equal(bad.result.structuredContent.preview.status, "unavailable");
        assert.equal(bad.result.structuredContent.preview.reasonCode, "INVALID_HEAD_SESSION_ID");
        assert.deepEqual(context.read(f.root), selection); assert.equal(sessionStatePath(f.root, f.storage), aPath);
      }
      assert.equal(resolutions, 0);
      const open = fs.openSync;
      fs.openSync = function(file, ...args) {
        assert.equal(String(file).includes("work-evidence"), false, "List-only must not preload work bodies");
        return open.call(this, file, ...args);
      };
      let listOnly;
      try { listOnly = runCommand(["session-list", f.root], { sessionContext: context }); }
      finally { fs.openSync = open; }
      assert.equal(listOnly.preview, undefined);
      await assert.rejects(withSessionRoute(f.root, f.session.sessionId, async () => {
        await Promise.resolve(); throw new Error("Synthetic async preview failure");
      }), /Synthetic async preview failure/u);
      assert.equal(sessionStatePath(f.root, f.storage), aPath);
    });
    if (state === "bound") assert.equal(withSessionCallContext({ root: f.root, context }, () => inspectProject(f.root).state.sessionId), a.sessionId);
    assert.deepEqual(context.read(f.root), selection);
  }
  assert.deepEqual(snapshot(f.base), before);
});

test("S1-S6: preview retains older conflicted Todo, source conditions, partial coverage and current cancellation", async t => {
  const f = fixture(t), task = { todoId: "todo-open", task: "Unfinished synthetic task", origin: "user-directed", nextAction: "Inspect remaining evidence" };
  const first = f.save({ summary: "Old task", todos: [{ ...task, status: "pending" }] });
  f.save({ summary: "Partial branch", todos: [{ ...task, status: "partial", prior: exact(first), progress: "One part" }] });
  f.save({ summary: "Waiting branch", todos: [{ ...task, status: "waiting", prior: exact(first), reason: "Needs evidence" }] });
  for (let i = 0; i < 9; i++) f.save({ summary: `Later unrelated PASS ${i}`, pending: [] });
  const direction = updateProjectDirection({ root: f.root, input: { goal: "Inspect only", cancelledActions: ["deploy"] } });
  let before = snapshot(f.base), preview = readSessionWorkList({ root: f.root, sessionId: f.session.sessionId }).preview;
  assert.equal(preview.workContext.records.some(record => record.evidenceId === first.evidence.evidenceId), false);
  assert.equal(preview.workContext.todoContext.items[0].status, "conflict");
  assert.equal(preview.conclusion.representativeResult, "not-designated");
  assert.deepEqual(preview.currentProjectDirection.input.cancelledActions, ["deploy"]);
  assert.deepEqual(snapshot(f.base), before);
  const indexFile = path.join(f.root, f.layout.directory, "graph-discovery/index.json"), index = JSON.parse(fs.readFileSync(indexFile));
  delete index.sessionTodoNavigation; fs.writeFileSync(indexFile, JSON.stringify(index));
  before = snapshot(f.base); preview = readSessionWorkList({ root: f.root, sessionId: f.session.sessionId }).preview;
  assert.notEqual(preview.workContext.todoContext.status, "complete");
  assert.equal(preview.workContext.todoContext.coverage.indexIsAuthority, false);
  assert.deepEqual(preview.currentProjectDirection.input.cancelledActions, ["deploy"]);
  const text = formatMcpToolContent("head_session_list", { sessions: [], preview });
  assert.match(text, /not-designated/u); assert.match(text, /deploy/u); assert.match(text, /coverage/u);
  assert.deepEqual(snapshot(f.base), before);
  const open = fs.openSync; let correctedDuringRead = false;
  fs.openSync = function(file, ...args) {
    if (!correctedDuringRead && String(file).includes("work-evidence") && String(file).endsWith(".json")) {
      correctedDuringRead = true;
      updateProjectDirection({ root: f.root, expectedDirectionId: direction.direction.directionId,
        input: { goal: "Inspect only", cancelledActions: ["deploy", "publish"] } });
    }
    return open.call(this, file, ...args);
  };
  let corrected;
  try { corrected = readSessionWorkList({ root: f.root, sessionId: f.session.sessionId }); }
  finally { fs.openSync = open; }
  assert.equal(correctedDuringRead, true);
  assert.deepEqual(corrected.preview.currentProjectDirection.input.cancelledActions, ["deploy", "publish"]);
});

// Real local API/serializer fixtures, not native Host/model compliance evidence.
async function call(f, name, args = {}, routed = false) {
  const arguments_ = { project_root: f.root, session_id: f.session.sessionId, ...args };
  const response = await dispatch({ jsonrpc: "2.0", id: "synthetic-linked-consumer", method: "tools/call", params: {
    name: routed ? "head_tools_call" : name, arguments: routed ? { name, arguments: arguments_ } : arguments_,
  } });
  assert.equal(response.error, undefined, JSON.stringify(response));
  assert.equal(response.result?.isError, undefined, JSON.stringify(response));
  return response.result;
}
function assertJsonMember(text, name, value) {
  if (value === undefined) return;
  const member = JSON.stringify({ [name]: value }, null, 2).slice(2, -2);
  assert.ok(text.includes(member), `Missing original ${name}: ${member}`);
}
function assertLiteralValues(text, value) {
  if (typeof value === "string") assert.ok(text.includes(value) || text.includes(JSON.stringify(value)), `Missing original literal: ${value}`);
  else if (Array.isArray(value)) for (const item of value) assertLiteralValues(text, item);
  else if (value && typeof value === "object") for (const item of Object.values(value)) assertLiteralValues(text, item);
}
// Decode only the explicit display block and check its exact member indexes.
function assertCommonRecords(text, records) {
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value), first = records[0];
  const eligible = records.length >= 2 && records.every(record => object(record)
    && ["projectId", "sessionId", "kind", "subtype", "content"].every(key => Object.hasOwn(record, key))
    && record.kind === "Evidence" && record.subtype === "SessionWorkEvidence" && object(record.content)
    && ["projectId", "sessionId"].every(key => typeof record[key] === "string" && record[key].length > 0 && record[key] === first[key]));
  const expected = eligible ? Object.fromEntries(["projectId", "sessionId", "kind", "subtype", "schemaVersion", "protocol", "authorityBoundary"]
    .filter(key => Object.hasOwn(first, key) && records.every(record => Object.hasOwn(record, key)
      && typeof record[key] === typeof first[key] && JSON.stringify(record[key]) === JSON.stringify(first[key])))
    .map(key => [key, first[key]])) : {};
  const blocks = [...text.matchAll(/^Common stored fields for (.+):\n/gmu)];
  assert.equal(blocks.length, Object.keys(expected).length ? 1 : 0);
  if (blocks.length) {
    const block = blocks[0], firstRecord = text.search(/^Record\[\d+\]:\n/mu);
    assert.equal(block[1], records.map((_, index) => `Record[${index}]`).join(", "));
    assert.ok(block.index < firstRecord);
    const encoded = text.slice(block.index + block[0].length).match(/^\{[\s\S]*?\n\}/u);
    assert.ok(encoded, "Common fields remain one exact JSON object before grouped bodies");
    assert.deepEqual(JSON.parse(encoded[0]), expected);
  }
  return expected;
}
function assertPresentedWork(text, expected) {
  assert.match(text, /Selected Session work evidence \(P3/u);
  const common = assertCommonRecords(text, expected.records);
  for (const name of ["status", "projectId", "sessionId"]) {
    if (expected[name] !== undefined) assert.ok(text.includes(`${name}: ${JSON.stringify(expected[name])}`), name);
  }
  for (const name of ["organization", "coverage", "omissions", "nextAfterEvidenceId"]) assertJsonMember(text, name, expected[name]);
  for (const [index, record] of expected.records.entries()) {
    const heading = `\nRecord[${index}]:\n`, start = text.indexOf(heading);
    assert.ok(start >= 0, `Missing Record[${index}]`);
    assert.equal(text.split(heading).length - 1, 1, `Record[${index}] body is displayed once`);
    const following = text.slice(start + heading.length).search(/^(?:Record\[\d+\]:|Session work group \(|Additional original fields at workContext:)/mu);
    const ends = following < 0 ? [] : [start + heading.length + following];
    const section = text.slice(start, ends.length ? Math.min(...ends) : undefined);
    for (const name of ["evidenceId", "projectId", "sessionId", "kind", "subtype", "selectionRole"]) {
      if (record[name] !== undefined) assert.equal(section.split("\n").includes(`${name}: ${JSON.stringify(record[name])}`),
        !Object.hasOwn(common, name), `Record[${index}] ${name} must be local or exact common`);
    }
    assertLiteralValues(section, record.content);
    for (const name of ["evidenceDigest", "references"]) assertJsonMember(section, name, record[name]);
    if (record.savedActivity) {
      const { states, ...residual } = record.savedActivity;
      assert.ok(section.includes(`savedActivity.states: ${JSON.stringify(states)}`));
      for (const [name, value] of Object.entries(residual)) assertJsonMember(section, name, value);
    }
  }
  assert.equal(text.includes(`\nRecord[${expected.records.length}]:\n`), false, "No invented record body");
}
function withoutSyncWrites(action) {
  const names = ["writeFileSync", "appendFileSync", "writeSync", "mkdirSync", "renameSync", "unlinkSync", "rmSync", "rmdirSync", "truncateSync", "ftruncateSync", "chmodSync", "fchmodSync", "utimesSync", "linkSync", "symlinkSync"];
  const originals = new Map(names.map(name => [name, fs[name]])), open = fs.openSync;
  const restore = () => { for (const [name, method] of originals) fs[name] = method; fs.openSync = open; };
  for (const name of names) fs[name] = () => { assert.fail(`Read-only consumer attempted ${name}`); };
  fs.openSync = (file, flags, ...args) => {
    const writable = typeof flags === "number" ? flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND) : /[wa+]/u.test(flags || "");
    assert.equal(Boolean(writable), false, "Read-only consumer attempted a writable open");
    return open(file, flags, ...args);
  };
  let result;
  try { result = action(); } catch (error) { restore(); throw error; }
  if (result && typeof result.then === "function") return result.finally(restore);
  restore(); return result;
}
function assertHookWorkScope(value, work) {
  assert.equal(value.workCoverage.status, work.status);
  if (work.status === "work_context_partial") assert.match(value.expansion, /lode_session_work_read/u);
  if (value.workCoverage.coverage) {
    assert.deepEqual(value.workCoverage.coverage, work.coverage);
    assert.deepEqual(value.workCoverage.omissions, work.omissions);
  } else {
    assert.equal(value.workCoverage.sourceOriginals, work.coverage.originals);
    assert.equal(value.workCoverage.sourceInspected, work.coverage.inspected);
    assert.equal(value.workCoverage.sourceIncluded, work.coverage.included);
  }
  if (value.workOrganization) assert.equal(value.workOrganization.scope, work.organization.scope);
  if (work.omissions.uninspected > 0) {
    assert.match(value.scope, /historical|hint/i); assert.match(value.scope, /inspected/i);
  }
}
function navigationCases(f) {
  const { root } = f;
  const file = path.join(root, relativeProjectArtifact(f.storage, "graph-discovery", "index.json")), raw = fs.readFileSync(file, "utf8"), legacy = JSON.parse(raw);
  assert.equal(legacy.sessionWorkNavigation?.version, 1); delete legacy.sessionWorkNavigation;
  return ["hinted", "legacy", "missing"].map(mode => ({ mode, prepare() {
    if (mode === "missing") fs.unlinkSync(file); else fs.writeFileSync(file, mode === "hinted" ? raw : JSON.stringify(legacy));
  } }));
}
function assertDefaultInspection(work, mode, originals, hintedInspected) {
  assert.equal(work.coverage.originals, originals);
  if (mode === "hinted") {
    if (hintedInspected !== undefined) assert.equal(work.coverage.inspected, hintedInspected);
    else assert.ok(work.coverage.inspected >= work.coverage.included && work.coverage.inspected < originals);
    assert.match(work.coverage.selection, /historical|hint/i); assert.match(work.coverage.selection, /inspected/i);
  } else {
    assert.equal(work.coverage.inspected, originals);
    assert.match(work.coverage.selection, /all discovered originals canonically inspected once/u);
  }
  assert.equal(work.coverage.unavailable, 0); assert.equal(work.coverage.valid, work.coverage.inspected);
  assert.equal(work.omissions.uninspected, originals - work.coverage.inspected);
}
function defaultAccounting(value) {
  assert.equal(value.coverage.originals, value.coverage.inspected + value.omissions.uninspected);
  assert.equal(value.coverage.valid, value.coverage.inspected - value.coverage.unavailable);
  assert.equal(value.coverage.included, value.records.length);
  assert.ok(value.coverage.included <= value.coverage.valid);
  assert.ok(value.omissions.byBudget <= value.coverage.valid - value.coverage.included);
  assert.ok(value.records.length <= value.coverage.maxRecords);
  assert.equal(value.coverage.usedCharacters, JSON.stringify(value.records).length);
  assert.ok(value.coverage.usedCharacters <= value.coverage.maxCharacters);
  assert.equal(new Set(value.records.map(record => record.evidenceId)).size, value.records.length);
}
function checkpoint(f) {
  return f.route(() => syncRecoveryCheckpoint({ root: f.root,
    expectedRecoveryBasisId: inspectRecoveryCheckpointBasis({ root: f.root }).basis.basisId,
    purpose: "CURRENT LOCAL PURPOSE: explain only", approvedDecisions: ["CURRENT LOCAL CONSTRAINT: no network"],
    currentPosition: "CURRENT LOCAL POSITION: execution outcome remains separate",
    nextExpectedResult: "CURRENT LOCAL NEXT: provide evidence, no deployment" }));
}
function hostFixture(f, runtime) {
  const environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: f.operational }, nativeSessionId = "synthetic-linked-" + runtime;
  const host = createSessionHostAdapter({ runtime, nativeSessionId, environment });
  assert.equal(host.select({ root: f.root, sessionId: f.session.sessionId, expectedRevision: 0 }).retained, true);
  return { host, read() {
    const output = sessionStartContext({ runtime, environment, event: { hook_event_name: "SessionStart", source: "resume", cwd: f.root, session_id: nativeSessionId } });
    const text = output.hookSpecificOutput.additionalContext;
    assert.ok(text.length <= (runtime === "codex" ? 32768 : 10000));
    return { text, value: JSON.parse(text) };
  } };
}

function assertSelectedBodyGroups(value, records = value.records, complete = true) {
  const organized = value.selectedBodyGroups;
  assert.ok(organized, "A small fitting selected body view should expose its navigation groups");
  assert.match(organized.scope, /returned bodies only/iu);
  assert.match(organized.scope, /navigation/iu);
  if (complete) assert.equal(organized.omittedGroups, 0);
  const indices = [];
  for (const group of organized.groups) {
    assert.equal(Object.hasOwn(group, "content"), false, "Group metadata references existing bodies without copying them");
    for (const index of group.recordIndices) {
      assert.ok(Number.isSafeInteger(index) && index >= 0 && index < records.length);
      indices.push(index);
      const record = records[index];
      assert.equal(group.projectId, record.projectId ?? value.projectId);
      assert.equal(group.sessionId, record.sessionId ?? value.sessionId);
      assert.deepEqual(group.root, record.content.workLink?.root || { evidenceId: record.evidenceId, evidenceDigest: record.evidenceDigest });
    }
    if (group.rootBodyIndex !== null) {
      const record = records[group.rootBodyIndex];
      assert.ok(record, "Root pointers must use actual admitted indices");
      assert.deepEqual(group.root, { evidenceId: record.evidenceId, evidenceDigest: record.evidenceDigest });
    }
    for (const association of group.topicAssociations) {
      assert.ok(group.recordIndices.includes(association.recordIndex));
      const source = records[association.recordIndex].content.workTopics;
      assert.equal(typeof source?.[association.index], "string", "Every association retains its authored topic source index");
      assert.equal(Object.hasOwn(association, "text"), false, "Topic metadata need not repeat the original label text");
    }
  }
  assert.equal(new Set(indices).size, indices.length, "No actual body is repeated in metadata groups");
  if (complete) assert.deepEqual([...indices].sort((a, b) => a - b), records.map((_, index) => index));
  return organized;
}

function assertGroupedBodyOwnership(text, records) {
  for (const [index, record] of records.entries()) {
    const offset = text.indexOf(`\nRecord[${index}]:\n`);
    assert.ok(offset >= 0);
    const ownerOffset = text.lastIndexOf("Session work group (", offset), rootOffset = text.lastIndexOf("Declared historical work root:", offset);
    assert.ok(ownerOffset >= 0 && rootOffset > ownerOffset, "Each actual body is below an owner and declared root heading");
    assert.ok(text.slice(ownerOffset, rootOffset).includes(record.sessionId));
    const root = record.content.workLink?.root || { evidenceId: record.evidenceId, evidenceDigest: record.evidenceDigest };
    const rootLine = text.slice(rootOffset, text.indexOf("\n", rootOffset));
    assert.ok(rootLine.includes(root.evidenceId)); assert.ok(rootLine.includes(root.evidenceDigest));
  }
}

function privateStartupFormatter(groupFitter = fitSelectedBodyGroups) {
  return (entry, root, runtime) => startupProjection(entry, root, runtime, groupFitter);
}

test("shared optional schema travels through direct record, CLI JSON and checkpoint work_evidence without extra saves", async t => {
  const f = fixture(t);
  const topics = ["ConnectedTopicMhjv4172", "Alternative topic", "ConnectedTopicMhjv4172"];
  const root = (await call(f, "head_session_work_record", { evidence: { summary: "Synthetic initial anchor", workTopics: topics } })).structuredContent;
  assert.deepEqual(root.evidence.content.workTopics, topics);
  const recordSchema = catalogTools.find(tool => tool.name === "lode_session_work_record").inputSchema.properties.evidence;
  const checkpointSchema = catalogTools.find(tool => tool.name === "lode_checkpoint_sync").inputSchema.properties.work_evidence;
  assert.deepEqual(recordSchema.properties.workTopics, checkpointSchema.properties.workTopics);
  assert.equal(recordSchema.properties.workTopics.type, "array");
  assert.equal(recordSchema.properties.workTopics.items.type, "string");
  assert.equal(recordSchema.required?.includes("workTopics") || false, false);
  const input = { summary: "CLI running note", workTopics: topics, workLink: link(root), executionObservation: { state: "running" } };
  const inputFile = path.join(f.base, "cli-evidence.json"); fs.writeFileSync(inputFile, JSON.stringify(input));
  const running = runCommand(["session-work-record", f.root, "--session", f.session.sessionId, "--input", inputFile]);
  assert.deepEqual(running.evidence.content.workLink, input.workLink);
  assert.deepEqual(running.evidence.content.workTopics, topics);
  const basis = f.route(() => inspectRecoveryCheckpointBasis({ root: f.root }).basis.basisId);
  const synced = (await call(f, "head_checkpoint_sync", {
    expected_recovery_basis_id: basis, purpose: "Explain synthetic work", approved_decisions: [],
    current_position: "Observed bounded completion", next_expected_result: "Explain remaining X",
    work_evidence: { pending: ["X"], workTopics: [topics[0]], workLink: link(root, running), executionObservation: { state: "ended", target: exact(running) } },
  }, true)).structuredContent;
  assert.equal(synced.outcome, "created"); assert.equal(synced.workEvidence.writes, 1);
  assert.equal(synced.checkpoint.workEvidence, undefined);
  const before = snapshot(f.base), read = f.read({ maxRecords: 8 });
  assert.equal(read.coverage.originals, 3); assert.deepEqual(recordFor(read, running).savedActivity.states, ["ended"]);
  assert.deepEqual(read.records.find(record => record.evidenceId === synced.workEvidence.evidenceId).content.workTopics, [topics[0]]);
  const grouped = assertSelectedBodyGroups(read);
  const runningIndex = read.records.findIndex(record => record.evidenceId === running.evidence.evidenceId);
  assert.equal(grouped.groups.flatMap(group => group.topicAssociations).filter(item => item.recordIndex === runningIndex).length, 2,
    "Duplicate authored topics do not duplicate navigation associations or full bodies");
  const retry = await call(f, "head_session_work_record", { evidence: input }, true);
  assert.equal(retry.structuredContent.writes, 0); assert.equal(retry.structuredContent.executionReplayAllowed, false);
  assert.deepEqual(snapshot(f.base), before); defaultAccounting(read);
});

test("authored topics connect old reason and checkpoint result to selected reader, grouped CLI/MCP, entry and both synthetic startup helpers", async t => {
  const f = fixture(t, "CURRENT SELECTED PURPOSE: explain retained work only"), topic = "ConnectedTopicVqmb9064";
  const root = f.save({ workTopics: [topic], summary: "Old root body marker Dtfr3111", judgments: [{ assessment: "Use the narrow branch",
    reason: "OLD REASON marker Xjcv4222: broad replacement loses provenance", alternatives: ["Rejected rewrite marker Hqns5333"] }] });
  const running = (await call(f, "head_session_work_record", { evidence: { summary: "Earlier observed running marker Bzkl6444", workTopics: [topic, "Second authored association"],
    workLink: link(root), executionObservation: { state: "running" } } })).structuredContent;
  const direction = updateProjectDirection({ root: f.root, input: { goal: "CURRENT COMMON GOAL: explain only", constraints: ["No external effects"], cancelledActions: ["deployment"] } }).direction;
  const basis = f.route(() => inspectRecoveryCheckpointBasis({ root: f.root }).basis.basisId);
  const synced = (await call(f, "head_checkpoint_sync", { expected_recovery_basis_id: basis,
    purpose: "CURRENT P2 PURPOSE: inspect only", approved_decisions: ["Current constraint: no deployment"],
    current_position: "Retained results need separate native verification", next_expected_result: "Explain remaining work; no deployment",
    work_evidence: { summary: "Recent result body marker Lmwd7555", workTopics: [topic],
      observedWork: ["ACTUAL RESULT marker Kfng8666: bounded local bytes were retained"], pending: ["PENDING marker Cjxr9777: another check remains"],
      unknowns: ["UNKNOWN marker Ptvs1888: native outcome remains unknown"], workLink: link(root, running), executionObservation: { state: "ended", target: exact(running) } },
  }, true)).structuredContent;
  assert.equal(synced.workEvidence.writes, 1);
  const callers = ["codex", "claude"].map(runtime => ({ runtime, ...hostFixture(f, runtime) })), before = snapshot(f.base);
  await withoutSyncWrites(async () => {
    const expected = f.read(), grouped = assertSelectedBodyGroups(expected);
    assert.equal(expected.records.length, 3); assert.equal(grouped.groups.length, 1);
    assert.deepEqual(grouped.groups[0].root, exact(root));
    assert.deepEqual(recordFor(expected, running).savedActivity.states, ["ended"]);
    for (const record of expected.records) {
      assert.ok(record.content.workTopics.includes(topic));
      const { workTopics, ...searchableBody } = record.content;
      assert.equal(JSON.stringify(searchableBody).includes(topic), false, "The connected label witness must be absent from every ordinary body");
    }
    const cli = runCommand(["session-work-read", f.root, "--session", f.session.sessionId]);
    assert.deepEqual(cli, expected);
    const outputs = [formatCliResult("session-work-read", cli)];
    for (const routed of [false, true]) {
      const read = await call(f, "head_session_work_read", {}, routed);
      assert.deepEqual(read.structuredContent, expected); outputs.push(read.content[0].text);
      const entry = await call(f, "head_conversation_enter", {}, routed);
      assert.deepEqual(entry.structuredContent.workContext, expected);
      assert.deepEqual(entry.structuredContent.restore?.projection?.currentProjectDirection
        ?? entry.structuredContent.projectStatus?.currentProjectDirection ?? entry.structuredContent.currentProjectDirection, direction);
      assert.equal(entry.structuredContent.ordinaryWorkBlocked, false); outputs.push(entry.content[0].text);
    }
    const entry = f.route(() => enterConversationRecovery({ root: f.root }));
    assert.deepEqual(entry.workContext, expected); outputs.push(formatCliResult("conversation-enter", entry));
    for (const text of outputs) {
      assertPresentedWork(text, expected); assertGroupedBodyOwnership(text, expected.records);
      for (const marker of ["Old root body marker Dtfr3111", "OLD REASON marker Xjcv4222", "ACTUAL RESULT marker Kfng8666", "PENDING marker Cjxr9777", "UNKNOWN marker Ptvs1888"])
        assert.equal(text.split(marker).length - 1, 1, "One coherent output carries each retained body once");
    }
    for (const caller of callers) {
      const { value, text } = caller.read();
      assert.ok(text.length <= (caller.runtime === "codex" ? 32768 : 10000));
      assert.equal(value.records.length, expected.records.length, "Small fitting bodies survive optional grouping metadata");
      assertSelectedBodyGroups({ ...value, projectId: expected.projectId, sessionId: expected.sessionId });
      assert.equal(value.sessionPurpose, expected.sessionPurpose); assert.deepEqual(value.currentProjectDirection, directionView(direction));
      assert.equal(value.sessionRecovery.checkpointId, synced.checkpoint.checkpointId);
      assert.deepEqual(value.currentProjectDirection.input.cancelledActions, ["deployment"]);
      assert.equal(value.sessionRecovery.historicalApprovalGrantsCurrentEffect, false);
      assert.equal(value.ordinaryWorkBlocked, false); assert.equal(value.userDecisionRequired, false);
      assert.match(value.savedObservationScope, /no current live state, success or authority/u);
      for (const record of value.records) {
        const original = expected.records.find(item => item.evidenceId === record.evidenceId);
        assert.deepEqual(record.content, original.content); assert.deepEqual(record.savedActivity, original.savedActivity);
      }
      for (const marker of ["OLD REASON marker Xjcv4222", "ACTUAL RESULT marker Kfng8666", "PENDING marker Cjxr9777", "UNKNOWN marker Ptvs1888"])
        assert.equal(text.split(marker).length - 1, 1);
    }
  });
  assert.deepEqual(snapshot(f.base), before);
  t.diagnostic("Local public APIs and packaged startup serializer only; no native lifecycle, Host attachment or model compliance verified");
});

test("exact reader can omit all optional grouping metadata without evicting its already-fitting original", t => {
  const f = fixture(t), saved = f.save({ workTopics: ["BudgetTopicFpmx2579"], summary: "Fitting original remains available",
    judgments: [{ assessment: "Keep it", reason: "Original reason remains intact", alternatives: ["Rejected expansion"] }], pending: ["X remains"], unknowns: ["Outcome unknown"] });
  const before = snapshot(f.base);
  const full = withoutSyncWrites(() => f.read({ evidenceIds: [saved.evidence.evidenceId], maxRecords: 1 }));
  assertSelectedBodyGroups(full);
  const budget = JSON.stringify(full.records).length;
  const tight = withoutSyncWrites(() => f.read({ evidenceIds: [saved.evidence.evidenceId], maxRecords: 1, maxCharacters: budget }));
  assert.deepEqual(tight.records, full.records); assert.equal(tight.selectedBodyGroups, undefined);
  assert.equal(tight.omissions.byBudget, 0); assert.equal(tight.coverage.usedCharacters, budget);
  const text = formatCliResult("session-work-read", tight);
  assertPresentedWork(text, tight); assertGroupedBodyOwnership(text, tight.records);
  assert.deepEqual(snapshot(f.base), before);
});

for (const runtime of ["codex", "claude"]) test(`${runtime} private startup grouping metadata yields to intact protected context and an admitted body`, () => {
  const formatter = privateStartupFormatter(), withoutGroups = privateStartupFormatter(() => ({})), limit = runtime === "codex" ? 32768 : 10000;
  const record = { evidenceId: "work-evidence-" + "a".repeat(24), evidenceDigest: "b".repeat(64), content: {
    summary: "", workTopics: ["Optional topic association"], pending: ["Unfinished work"], unknowns: ["Outcome remains unknown"] } };
  const entry = { status: "conversation_ready", currentProjectDirection: { directionId: "direction-" + "c".repeat(24),
    input: { goal: "Protected current goal", constraints: ["No external effects"], cancelledActions: ["deployment"] } },
    restore: { checkpoint: { checkpointId: "checkpoint-" + "d".repeat(24), purpose: "Protected current P2", approvedDecisions: ["No deployment"],
      currentPosition: "Retained checkpoint position", nextExpectedResult: "Explain only" } },
    workContext: { status: "work_context_restored", projectId: "project-fixture", sessionId: "session-fixture", sessionPurpose: "Protected selected purpose",
      records: [record], coverage: { originals: 1, inspected: 1, valid: 1, included: 1 }, omissions: { byBudget: 0, uninspected: 0, evidenceIds: [] } } };
  let fitting;
  for (let length = 0; length <= limit; length += 73) {
    record.content.summary = "s".repeat(length);
    const control = JSON.parse(withoutGroups(entry, pluginRoot, runtime));
    if (control.records.length) fitting = { summary: record.content.summary, control };
    else if (fitting) break;
  }
  assert.ok(fitting); record.content.summary = fitting.summary;
  const text = formatter(entry, pluginRoot, runtime), value = JSON.parse(text);
  assert.ok(text.length <= limit); assert.deepEqual(value.records, fitting.control.records);
  assert.deepEqual(value.currentProjectDirection, fitting.control.currentProjectDirection);
  assert.deepEqual(value.sessionRecovery, fitting.control.sessionRecovery); assert.equal(value.sessionPurpose, fitting.control.sessionPurpose);
  assert.equal(value.selectedBodyGroups, undefined, "Metadata must be omitted when the fitting body leaves no room for its wrapper");
  assert.equal(value.omittedEvidenceCount, 0); assert.equal(value.ordinaryWorkBlocked, false);
});

test("organized originals and overlays reach CLI, direct/router MCP and entry with zero writes", async t => {
  const f = fixture(t), saved = representative(f);
  let selectedBodies;
  for (const variant of navigationCases(f)) {
  variant.prepare(); const before = snapshot(f.base), expected = withoutSyncWrites(() => f.read());
  assertDefaultInspection(expected, variant.mode, 14);
  if (variant.mode === "hinted") defaultAccounting(expected); else accounting(expected);
  const bodies = expected.records.map(({ evidenceId, evidenceDigest, content, selectionRole }) => ({ evidenceId, evidenceDigest, content, selectionRole }));
  if (selectedBodies) assert.deepEqual(bodies, selectedBodies); else selectedBodies = bodies;
  const cli = withoutSyncWrites(() => runCommand(["session-work-read", f.root, "--session", f.session.sessionId]));
  assert.deepEqual(cli, expected);
  const presentation = formatCliResult("session-work-read", cli);
  assertPresentedWork(presentation, expected);
  assert.ok(presentation.includes("EXACT REASON: A loses retained provenance"));
  assert.ok(presentation.includes("X remains"));
  assert.ok(presentation.includes("External effect remains unverified"));
  for (const routed of [false, true]) {
    const read = await withoutSyncWrites(() => call(f, "head_session_work_read", {}, routed));
    assert.deepEqual(read.structuredContent, expected);
    assert.equal(read.content[0].text, formatMcpToolContent("head_session_work_read", expected));
    assertPresentedWork(read.content[0].text, expected);
    const entry = await withoutSyncWrites(() => call(f, "head_conversation_enter", {}, routed));
    assert.deepEqual(entry.structuredContent.workContext, expected);
    assert.ok(JSON.stringify(entry.content).includes("EXACT REASON: A loses retained provenance"));
    assert.equal(entry.structuredContent.ordinaryWorkBlocked, false);
  }
  assert.deepEqual(withoutSyncWrites(() => f.route(() => enterConversationRecovery({ root: f.root }))).workContext, expected);
  assert.deepEqual(snapshot(f.base), before);
  assert.deepEqual(recordFor(expected, saved.running).savedActivity.states, ["ended"]);
  }
});

test("empty exact IDs and an exhausted lexical page retain their scope in CLI and direct/router MCP text", async t => {
  const f = fixture(t); f.save({ summary: "Other Session history remains recorded", pending: ["X remains"] });
  const cases = [
    { label: "exact-empty", options: { evidenceIds: [] }, args: { evidence_ids: [] }, originals: null, uninspected: null,
      selection: "newest-recorded-first-within-requested-exact-ids; Session inventory not enumerated; no global completeness or semantic sufficiency claim" },
    { label: "page-end", options: { afterEvidenceId: "work-evidence-" + "f".repeat(24) }, args: { after_evidence_id: "work-evidence-" + "f".repeat(24) }, originals: 1, uninspected: 0,
      selection: "newest-recorded-first-within-inspected-original-page; no semantic relevance or sufficient-context judgment" },
  ];
  for (const item of cases) {
    item.input = path.join(f.base, item.label + ".json"); fs.writeFileSync(item.input, JSON.stringify(item.options));
  }
  const before = snapshot(f.base);
  await withoutSyncWrites(async () => {
    for (const item of cases) {
      const expected = f.read(item.options);
      assert.deepEqual(expected.records, []); assert.equal(expected.status, "work_context_not_recorded");
      assert.equal(expected.coverage.originals, item.originals); assert.equal(expected.coverage.inspected, 0);
      assert.equal(expected.coverage.selection, item.selection);
      assert.equal(expected.omissions.uninspected, item.uninspected); assert.equal(expected.nextAfterEvidenceId, null);
      accounting(expected); // Existing scoped exact/page accounting is unchanged.
      const cli = runCommand(["session-work-read", f.root, "--session", f.session.sessionId, "--input", item.input]);
      assert.deepEqual(cli, expected);
      const cliText = formatCliResult("session-work-read", cli);
      assertPresentedWork(cliText, expected);
      assert.doesNotMatch(cliText, /No selected Session work evidence is recorded/u);
      for (const routed of [false, true]) {
        const read = await call(f, "head_session_work_read", item.args, routed);
        assert.deepEqual(read.structuredContent, expected);
        assertPresentedWork(read.content[0].text, expected);
        assert.doesNotMatch(read.content[0].text, /No selected Session work evidence is recorded/u);
      }
    }
  });
  assert.deepEqual(snapshot(f.base), before);
});

test("only observed numeric zero originals keeps default no-history entry quiet", async t => {
  const f = fixture(t), before = snapshot(f.base);
  await withoutSyncWrites(async () => {
    const empty = f.read();
    assert.equal(empty.coverage.originals, 0); assert.equal(empty.coverage.inspected, 0);
    assert.equal(empty.omissions.uninspected, 0); assert.deepEqual(empty.records, []);
    const quiet = "No selected Session work evidence is recorded. Ordinary work continues.\n";
    assert.equal(formatCliResult("session-work-read", empty), quiet);
    for (const routed of [false, true]) {
      const read = await call(f, "head_session_work_read", {}, routed);
      assert.deepEqual(read.structuredContent, empty); assert.equal(read.content[0].text, quiet);
    }
    const entry = f.route(() => enterConversationRecovery({ root: f.root }));
    assert.doesNotMatch(formatCliResult("conversation-enter", entry), /Selected Session work evidence \(P3/u);
    assert.equal(entry.ordinaryWorkBlocked, false); assert.equal(entry.userDecisionRequired, false);
    // Serializer-only unknown/malformed counts must not become observed numeric
    // zero. This does not broaden the reader's public count schema.
    for (const originals of [null, undefined, "0"]) {
      const scoped = { ...empty, coverage: { ...empty.coverage, originals } };
      assertPresentedWork(formatCliResult("session-work-read", scoped), scoped);
      assertPresentedWork(formatMcpToolContent("head_session_work_read", scoped), scoped);
    }
  });
  assert.deepEqual(snapshot(f.base), before);
});

test("hinted and canonical-fallback counts disclose actual inspection without inventing budget omissions", async t => {
  const f = fixture(t), target = f.save({ summary: "Older exact target", executionObservation: { state: "running" } });
  for (let i = 0; i < 12; i += 1) f.save({ summary: `Unrelated discovery-only original ${i}` });
  const latest = f.save({ summary: "Latest bounded result", executionObservation: { state: "ended", target: exact(target) },
    pending: ["X remains; no repeated effect"], unknowns: ["External outcome is unknown"] });
  const options = { maxRecords: 1 }, input = path.join(f.base, "one-body.json"); fs.writeFileSync(input, JSON.stringify(options));
  for (const variant of navigationCases(f)) {
  variant.prepare();
  const before = snapshot(f.base);
  await withoutSyncWrites(async () => {
    const expected = f.read(options);
    assert.deepEqual(expected.records.map(record => record.evidenceId), [latest.evidence.evidenceId]);
    assertDefaultInspection(expected, variant.mode, 14, 2);
    if (variant.mode === "hinted") defaultAccounting(expected); else accounting(expected);
    assert.equal(expected.coverage.inspected, expected.coverage.valid + expected.coverage.unavailable);
    assert.equal(expected.status, "work_context_partial"); assert.equal(expected.ordinaryWorkBlocked, false);
    assert.ok(expected.coverage.valid > expected.coverage.included); assert.equal(expected.omissions.byBudget, 0);
    assert.deepEqual(expected.omissions.evidenceIds, []); assert.equal(expected.omissions.omittedIdCount, 0);
    assert.equal(expected.nextAfterEvidenceId, null); assert.equal(expected.organization.scope, "inspected-originals-only");
    const record = recordFor(expected, latest);
    assert.deepEqual(record.content.pending, ["X remains; no repeated effect"]);
    assert.deepEqual(record.content.unknowns, ["External outcome is unknown"]);
    assert.ok(record.savedActivity.relations.some(relation => relation.role === "target" && relation.status === "verified"));
    // Neither current inspected proof nor historical hints imply a live-state
    // or returned-at-integrity guarantee for the unselected archive.
    const cli = runCommand(["session-work-read", f.root, "--session", f.session.sessionId, "--input", input]);
    assert.deepEqual(cli, expected); assertPresentedWork(formatCliResult("session-work-read", cli), expected);
    for (const routed of [false, true]) {
      const read = await call(f, "head_session_work_read", { max_records: 1 }, routed);
      assert.deepEqual(read.structuredContent, expected);
      assertPresentedWork(read.content[0].text, expected);
    }
  });
  assert.deepEqual(snapshot(f.base), before);
  }
});

for (const runtime of ["codex", "claude"]) test(`${runtime} public synthetic Hook carries saved activity with its body and current P2/common priority`, t => {
  const f = fixture(t, "CURRENT SELECTED PURPOSE: investigate locally"), saved = representative(f);
  const direction = updateProjectDirection({ root: f.root, input: { goal: "CURRENT COMMON GOAL: explain only", constraints: ["No external effects"], cancelledActions: ["deployment"] } }).direction;
  const synced = checkpoint(f), caller = hostFixture(f, runtime);
  for (const variant of navigationCases(f)) {
  variant.prepare(); const before = snapshot(f.base);
  const entry = withoutSyncWrites(() => caller.host.enter({ root: f.root })), { value, text } = withoutSyncWrites(() => caller.read());
  assertHookWorkScope(value, entry.workContext);
  assertDefaultInspection(entry.workContext, variant.mode, 14);
  if (variant.mode !== "hinted") assert.ok(entry.workContext.coverage.valid > entry.workContext.coverage.included);
  assert.equal(entry.workContext.status, "work_context_partial");
  assert.deepEqual(value.currentProjectDirection, directionView(direction)); assert.equal(value.sessionPurpose, entry.workContext.sessionPurpose);
  assert.equal(value.sessionRecovery.checkpointId, synced.checkpoint.checkpointId);
  assert.deepEqual(value.sessionRecovery.approvedDecisions, synced.checkpoint.approvedDecisions);
  assert.equal(value.sessionRecovery.historicalNextExpectedResult, synced.checkpoint.nextExpectedResult);
  assert.equal(value.sessionRecovery.historicalApprovalGrantsCurrentEffect, false);
  assert.deepEqual(value.route, { session_id: f.session.sessionId });
  assert.equal(value.savedObservationScope, "Saved historical observations coexist; no current live state, success or authority is inferred.");
  assert.ok(text.includes("X remains")); assert.ok(text.includes("EXACT REASON: A loses retained provenance"));
  assert.ok(text.includes("External effect remains unverified"));
  assert.ok(value.records.some(record => record.evidenceId === saved.ended.evidence.evidenceId));
  for (const record of value.records) {
    const original = entry.workContext.records.find(item => item.evidenceId === record.evidenceId);
    assert.ok(original); assert.deepEqual(record.content, original.content);
    if (original.savedActivity) assert.deepEqual(record.savedActivity, original.savedActivity);
    assert.equal(record.selectionRole, original.selectionRole);
  }
  for (const flag of ["persisted", "userDecisionRequired", "ordinaryWorkBlocked"]) assert.equal(value[flag], false);
  assert.deepEqual(snapshot(f.base), before);
  t.diagnostic(JSON.stringify({ scope: "synthetic-public-adapter-and-hook-only", runtime, length: text.length, modelAndNativeHostVerified: false }));
  }
});

for (const runtime of ["codex", "claude"]) test(`${runtime} optional organized bodies cannot evict a fitting long current purpose or leave an overlayless note`, t => {
  const f = fixture(t, "CURRENT LONG PURPOSE " + "p".repeat(4100)); representative(f);
  const direction = updateProjectDirection({ root: f.root, input: { goal: "Current common direction", cancelledActions: ["deployment"] } }).direction;
  const caller = hostFixture(f, runtime), before = snapshot(f.base), entry = caller.host.enter({ root: f.root });
  const { value } = caller.read();
  assert.equal(value.sessionPurpose, entry.workContext.sessionPurpose); assert.deepEqual(value.currentProjectDirection, directionView(direction));
  for (const record of value.records) {
    const original = entry.workContext.records.find(item => item.evidenceId === record.evidenceId);
    if (original.savedActivity) assert.deepEqual(record.savedActivity, original.savedActivity);
  }
  if (value.records.some(record => record.selectionRole)) assert.equal(value.savedObservationScope,
    "Saved historical observations coexist; no current live state, success or authority is inferred.");
  assert.equal(value.omittedEvidenceCount, entry.workContext.records.length - value.records.length);
  assert.deepEqual(snapshot(f.base), before);
});

test("P3 ended never clears canonical pending review, and CLI/Hook expose the separate verified axis", t => {
  const f = fixture(t), root = f.save({ summary: "Original bounded work", executionObservation: { state: "running" } });
  checkpoint(f);
  f.route(() => {
    const capsule = compileContext({ root: f.root, task: "Synthetic local bounded implementation", persist: true }).capsule;
    const plan = createWholePlanSnapshot({ root: f.root, objective: "Synthetic bounded result", plan: [{ id: "inspect", outcome: "Local evidence" }], invariants: ["No external effects"] }).artifact;
    const contract = createExecutionContract({ root: f.root, wholePlanId: plan.wholePlanId, capsuleId: capsule.capsuleId,
      scope: "Synthetic local evidence", acceptanceCriteria: ["Local evidence returned"] }).artifact;
    startRun({ root: f.root, executionContractId: contract.executionContractId, startRequestId: "synthetic-linked-run" });
    finishRun({ root: f.root, outcome: "Local synthetic result", evidence: [{ uri: "synthetic", digest: "evidence" }], verification: [{ check: "local", status: "passed" }] });
  });
  f.save({ executionObservation: { state: "ended", target: exact(root) }, pending: ["X remains and review is separate"], workLink: link(root) });
  const callers = ["codex", "claude"].map(runtime => hostFixture(f, runtime)), before = snapshot(f.base);
  const entry = f.route(() => enterConversationRecovery({ root: f.root }));
  const current = entry.restore.projection.currentExecution;
  assert.equal(current.status, "verified"); assert.ok(current.sessionPointer.pendingReview);
  assert.deepEqual(recordFor(entry.workContext, root).savedActivity.states, ["ended"]);
  const cli = formatCliResult("conversation-enter", entry);
  assert.ok(cli.includes(current.sessionPointer.pendingReview.runId));
  for (const caller of callers) {
    const { value } = caller.read();
    assert.equal(value.currentExecution.status, current.status);
    assert.ok(JSON.stringify(value.currentExecution).includes(current.sessionPointer.pendingReview.runId));
    assert.ok(JSON.stringify(value.records).includes("X remains and review is separate"));
    assert.equal(value.userDecisionRequired, false); assert.equal(value.ordinaryWorkBlocked, false);
  }
  assert.deepEqual(snapshot(f.base), before);
});

for (const uninspected of [0, 32]) test(`private startup serializer retains record-overlay tuples at exact 9999 and 10000 (${uninspected} uninspected) and omits them whole beyond capacity`, t => {
  // Serializer-only capacity evidence complements the public Hook fixtures.
  const formatter = privateStartupFormatter();
  const id = "work-evidence-" + "a".repeat(24), digest = "b".repeat(64);
  const activity = { states: ["ended"], qualifierCount: 1, qualifiers: [{ evidenceId: "work-evidence-" + "c".repeat(24), evidenceDigest: digest, state: "ended" }],
    omittedQualifierCount: 0, unavailableQualifierCount: 0, coverage: "verified-scan", relations: [] };
  const entry = { status: "conversation_ready", currentProjectDirection: null, workContext: { status: "work_context_partial",
    sessionId: "session-AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", sessionPurpose: "Protected local purpose", organization: {
      interpretation: "Saved historical observations coexist; neither their state, time nor predecessor establishes current live state, success or authority.",
      liveState: "not-observed", scope: "inspected-originals-only", roots: 1, branchingPredecessors: 0,
      unavailableRelations: 0, uninspectedRelations: 0, relatedReadAttempts: 0, relatedExpansionDeferred: 0,
    },
    records: [{ evidenceId: id, evidenceDigest: digest, selectionRole: "recent", content: { summary: "" }, references: [], savedActivity: activity }],
    coverage: { originals: 40, inspected: 40 - uninspected, valid: 40 - uninspected, included: 1 }, omissions: { byBudget: 0, uninspected, evidenceIds: [] }, nextAfterEvidenceId: null,
  } };
  const boundaries = new Map();
  // Output overhead can change when optional coverage is omitted. Search the
  // finite 10000-character input domain; no model or filesystem mutation occurs.
  for (let length = 0; length <= 10000; length += 1) {
    entry.workContext.records[0].content.summary = "s".repeat(length);
    const text = formatter(entry, pluginRoot), value = JSON.parse(text);
    assert.ok(text.length <= 10000);
    if (value.records.length) {
      assert.deepEqual(value.records[0].savedActivity, activity);
      assert.equal(value.savedObservationScope, "Saved historical observations coexist; no current live state, success or authority is inferred.");
      if (value.workOrganization) assert.equal(value.workOrganization.scope, entry.workContext.organization.scope);
      if (text.length === 9999 || text.length === 10000) boundaries.set(text.length, { length, outputLength: text.length });
    } else if (boundaries.size) break;
  }
  for (const outputLength of [9999, 10000]) {
    const boundary = boundaries.get(outputLength);
    assert.ok(boundary, `An included tuple must reach the exact ${outputLength} serialized boundary`);
    entry.workContext.records[0].content.summary = "s".repeat(boundary.length);
    const text = formatter(entry, pluginRoot), value = JSON.parse(text);
    assert.equal(text.length, outputLength); assert.equal(value.records.length, 1);
    assertHookWorkScope(value, entry.workContext);
    assert.deepEqual(value.records[0].content, entry.workContext.records[0].content);
    assert.deepEqual(value.records[0].savedActivity, activity);
  }
  entry.workContext.records[0].content.summary = "s".repeat(boundaries.get(10000).length + 1);
  const justBeyond = JSON.parse(formatter(entry, pluginRoot));
  assert.deepEqual(justBeyond.records, []); assert.equal(justBeyond.omittedEvidenceCount, 1);
  assert.equal(justBeyond.savedObservationScope, undefined);
  assert.equal(justBeyond.sessionPurpose, "Protected local purpose");
  entry.workContext.records[0].content.summary = "s".repeat(14000);
  const overflow = JSON.parse(formatter(entry, pluginRoot));
  assert.deepEqual(overflow.records, []); assert.equal(overflow.omittedEvidenceCount, 1);
  assert.equal(overflow.savedObservationScope, undefined);
  assert.equal(overflow.sessionPurpose, "Protected local purpose");
  t.diagnostic(JSON.stringify({ scope: "private-serializer-only", boundaries: [...boundaries.values()] }));
});

test("serializer-only incomplete/conflict execution status survives CLI quiet/common-unavailable/normal and private Hook without P2 writes", t => {
  const f = fixture(t), before = snapshot(f.base);
  const formatter = privateStartupFormatter();
  const activeRunId = "run-1767225600000-abcdef";
  for (const status of ["incomplete", "conflict"]) {
    const entry = { status: "conversation_direction_restored", currentProjectDirection: null,
      restore: { checkpoint: { checkpointId: "checkpoint-" + "a".repeat(24), purpose: "Retained local direction", approvedDecisions: [],
        currentPosition: "Incomplete execution remains a separate observation", nextExpectedResult: "Explain only" },
      projection: { currentExecution: { status, sessionPointer: { activeRunId, pendingReview: null, lastReviewDecisionId: null, requiredPlanAction: null },
        activeRun: null, pendingReview: null, storageTransition: { status } } } },
      workContext: { status: "work_context_not_recorded", sessionId: f.session.sessionId, sessionPurpose: "Current selected purpose", records: [] } };
    for (const branch of ["quiet", "common-unavailable", "normal"]) {
      const input = structuredClone(entry);
      if (branch === "quiet") input.presentation = { mode: "quiet" };
      if (branch === "common-unavailable") input.projectStatus = { currentProjectDirection: null,
        currentProjectDirectionAvailability: { status: "unavailable", reasonCode: "PROJECT_DIRECTION_UNAVAILABLE", dependentEffectsBlocked: true } };
      const original = structuredClone(input), text = formatConversationRecovery(input);
      const heading = `Canonical execution observation (${status}):\n`, offset = text.indexOf(heading);
      assert.ok(offset >= 0, `${branch}/${status}: ${text}`);
      const axis = JSON.parse(text.slice(offset + heading.length).split("\n")[0]);
      assert.equal(axis.status, status); assert.equal(axis.sessionPointer.activeRunId, activeRunId);
      assert.equal(axis.activeRun, undefined); // A pointer is not a verified Run body.
      const hook = JSON.parse(formatter(input, f.root));
      assert.equal(hook.currentExecution.status, status);
      assert.equal(hook.currentExecution.sessionPointer.activeRunId, activeRunId);
      assert.equal(hook.currentExecution.activeRun, undefined);
      assert.equal(hook.persisted, false); assert.equal(hook.ordinaryWorkBlocked, false);
      assert.deepEqual(input, original);
    }
  }
  assert.deepEqual(snapshot(f.base), before);
  t.diagnostic("serializer-only injected source-shaped incomplete/conflict; not an actual Run transition or Host execution");
});

test("private Hook execution-detail omission keeps an expansion notice without evicting fitting protected fields", t => {
  const formatter = privateStartupFormatter();
  const entry = { status: "conversation_direction_restored", currentProjectDirection: { directionId: "direction-" + "a".repeat(24),
    input: { goal: "Current goal", constraints: ["Local only"], cancelledActions: ["deployment"] } },
    restore: { checkpoint: { checkpointId: "checkpoint-" + "b".repeat(24), purpose: "Retained P2 purpose", approvedDecisions: ["No network"],
      currentPosition: "Retained P2 position", nextExpectedResult: "Retained P2 next result" }, projection: {} },
    workContext: { sessionId: "session-AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", sessionPurpose: "", records: [] } };
  let protectedView;
  for (let length = 0; length <= 10000; length += 1) {
    entry.workContext.sessionPurpose = "p".repeat(length);
    const text = formatter(entry, pluginRoot), value = JSON.parse(text);
    if (value.sessionPurpose === entry.workContext.sessionPurpose && text.length >= 9970) { protectedView = value; break; }
  }
  assert.ok(protectedView, "A near-capacity intact protected context must be available");
  const activeRunId = "run-1767225600000-abcdef";
  entry.restore.projection.currentExecution = { status: "conflict", activeRun: null, sessionPointer: { activeRunId,
    pendingReview: { runId: activeRunId, wholePlanId: "whole-plan-" + "c".repeat(24), resultPacketId: "result-packet-" + "d".repeat(24) },
    lastReviewDecisionId: "review-decision-" + "e".repeat(24), requiredPlanAction: { kind: "replan", disposition: "revise",
      wholePlanId: "whole-plan-" + "c".repeat(24), reviewDecisionId: "review-decision-" + "e".repeat(24) } } };
  const original = structuredClone(entry), text = formatter(entry, pluginRoot), value = JSON.parse(text);
  assert.ok(text.length <= 10000);
  assert.equal(value.sessionPurpose, protectedView.sessionPurpose);
  assert.deepEqual(value.currentProjectDirection, protectedView.currentProjectDirection);
  assert.deepEqual(value.sessionRecovery, protectedView.sessionRecovery);
  assert.equal(value.requiredSourceExpansion, undefined);
  assert.ok(!value.currentExecution?.sessionPointer, "Execution details must yield before fitting protected content");
  if (value.currentExecution) { assert.equal(value.currentExecution.status, "conflict"); assert.equal(value.currentExecution.contentIncluded, false); }
  assert.ok(value.scope.includes("Execution details omitted; expand entry"));
  assert.equal(value.persisted, false); assert.deepEqual(entry, original);
  t.diagnostic("private serializer capacity only; no P2 transition or actual execution fault was injected");
});
