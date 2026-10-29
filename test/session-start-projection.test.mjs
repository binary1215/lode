import { relativeProjectArtifact } from "../scripts/lib/project-storage-format.mjs";
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
import { fitSelectedBodyGroups, workBodyTuples } from "../scripts/lib/session-work-body-organization.mjs";
import { publicToolName } from "../scripts/lib/lode-artifact-composition.mjs";
import { inspectRecoveryCheckpointBasis, syncRecoveryCheckpoint } from "../scripts/lib/compaction-recovery.mjs";
import { recordSessionWorkEvidence, readSessionWorkContext } from "../scripts/lib/session-work-context.mjs";
import { updateProjectDirection } from "../scripts/lib/project-direction.mjs";
import { startupProjection as projectStartup } from "../scripts/lib/session-host-context-projection.mjs";
import { coreEntryGuidance } from "../scripts/lib/lode-entry-guidance.mjs";

const directionView = value => value ? Object.fromEntries(["directionId", "directionHash", "input"].filter(key => value[key] !== undefined).map(key => [key, value[key]])) : null;

const pluginRoot = path.resolve(import.meta.dirname, "..");
const unavailable = { status: "unavailable", reasonCode: "PROJECT_DIRECTION_UNAVAILABLE", dependentEffectsBlocked: true };
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function fixture(t, runtime, purpose = "Selected current purpose; investigate only") {
  const tmp = process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(tmp, { recursive: true });
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmp, "startup-projection-")));
  const root = path.join(base, "project"), operational = path.join(base, "host");
  fs.mkdirSync(root);
  initializeProject({ root, pluginRoot, runtimes: [runtime] });
  const storage = inspectProject(root).storage;
  const session = createHeadSession({ root, purpose });
  const environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: operational };
  const nativeSessionId = "synthetic-startup-caller";
  const host = createSessionHostAdapter({ runtime, nativeSessionId, environment });
  assert.equal(host.select({ root, sessionId: session.sessionId, expectedRevision: 0 }).retained, true);
  const event = { hook_event_name: "SessionStart", source: "startup", cwd: root, session_id: nativeSessionId };
  const read = async () => {
    const text = (await sessionStartContext({ runtime, event, environment })).hookSpecificOutput.additionalContext;
    assert.ok(text.length <= (runtime === "codex" ? 32768 : 10000), `Final JSON length ${text.length}`);
    const value = JSON.parse(text);
    assert.equal(value.ordinaryWorkBlocked, false);
    assert.equal(value.userDecisionRequired, false);
    assert.equal(value.persisted, false);
    assert.equal(value.logicalSessionId, session.sessionId);
    assert.deepEqual(value.route, { session_id: session.sessionId });
    if (value.expansion.startsWith("Omitted work:")) assert.match(value.expansion, /lode_session_work_read.*project_root:projectRoot.*route/);
    else { assert.match(value.expansion, /lode_conversation_enter.*project_root:projectRoot.*exact route/); assert.match(value.expansion, /When needed/); }
    assert.match(value.scope, /Read-only, non-atomic.*(?:Recheck|Check) current authority (?:before an effect|for effects)/);
    t.diagnostic(JSON.stringify({ runtime, length: text.length, sessionId: value.logicalSessionId,
      records: value.records.length, omittedEvidenceCount: value.omittedEvidenceCount,
      purposeOmitted: value.sessionPurposeCoverage?.contentIncluded === false,
      directionOmitted: value.currentProjectDirection?.contentIncluded === false,
      coverageOmitted: value.workCoverage?.omitted === true }));
    return value;
  };
  t.after(() => { if (process.env.HEAD_AGENT_KEEP_TEST_TMP !== "1") fs.rmSync(base, { recursive: true, force: true }); });
  t.diagnostic(JSON.stringify({ fixture: base, runtime, evidenceScope: "synthetic-public-adapter-and-hook; actualHost-unverified" }));
  return { base, root, storage, operational, environment, event, host, session, read,
    selected: (fn) => withSessionRoute(root, session.sessionId, fn) };
}
function snapshot(directory) {
  const files = {};
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) walk(file);
      else { const stat = fs.statSync(file); files[path.relative(directory, file)] = {
        digest: sha(fs.readFileSync(file)), size: stat.size, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs, mode: stat.mode };
      }
    }
  }
  walk(directory);
  return files;
}
const checkpoint = (f, purpose = "Historical checkpoint purpose", fields = {}) => f.selected(() => syncRecoveryCheckpoint({
  root: f.root, expectedRecoveryBasisId: inspectRecoveryCheckpointBasis({ root: f.root }).basis.basisId,
  purpose, approvedDecisions: ["Historical local investigation approval"], currentPosition: "Prior investigation",
  nextExpectedResult: "Historical suggestion; no effect permission", ...fields,
}));
const evidence = (f, summary) => f.selected(() => recordSessionWorkEvidence({ root: f.root, input: { summary } }));
function navigationCases(f) {
  const { root } = f;
  const file = path.join(root, relativeProjectArtifact(f.storage, "graph-discovery", "index.json")), raw = fs.readFileSync(file, "utf8"), legacy = JSON.parse(raw);
  assert.equal(legacy.sessionWorkNavigation?.version, 1); delete legacy.sessionWorkNavigation;
  return ["hinted", "legacy", "missing"].map(mode => ({ mode, prepare() {
    if (mode === "missing") fs.unlinkSync(file); else fs.writeFileSync(file, mode === "hinted" ? raw : JSON.stringify(legacy));
  } }));
}

function assertPartialWorkExpansion(f, raw, value, runtime, mode) {
  const work = raw.workContext;
  const inspected = mode === "hinted" ? 8 : 40;
  assert.equal(work.status, "work_context_partial");
  assert.equal(work.coverage.originals, 40);
  for (const key of ["inspected", "valid"]) assert.equal(work.coverage[key], inspected);
  assert.equal(work.coverage.included, 8); assert.equal(work.records.length, 8);
  assert.equal(work.coverage.unavailable, 0); assert.equal(work.nextAfterEvidenceId, null);
  assert.equal(work.omissions.uninspected, 40 - inspected); assert.equal(work.omissions.byBudget, 0);
  assert.deepEqual(work.omissions.evidenceIds, []); assert.equal(work.omissions.omittedIdCount, 0);
  if (mode === "hinted") {
    assert.match(work.coverage.selection, /historical|hint/i); assert.match(work.coverage.selection, /inspected/i);
    assert.match(value.scope, /historical|hint/i); assert.match(value.scope, /inspected/i);
  } else assert.match(work.coverage.selection, /all discovered originals canonically inspected once.*partial body delivery.*not live state or semantic sufficiency/);
  assert.equal(value.workCoverage.status, work.status);
  if (value.workCoverage.omitted) {
    assert.equal(value.workCoverage.sourceOriginals, 40); assert.equal(value.workCoverage.sourceInspected, inspected);
    assert.equal(value.workCoverage.sourceIncluded, 8);
  } else {
    assert.deepEqual(value.workCoverage.coverage, work.coverage);
    assert.deepEqual(value.workCoverage.omissions, work.omissions);
  }
  const included = new Set(value.records.map(record => record.evidenceId));
  const omitted = work.records.filter(record => !included.has(record.evidenceId));
  if (runtime === "claude") assert.ok(omitted.length > 0, "Exercise additional Hook omission, not source budget rejection");
  assert.equal(value.omittedEvidenceCount, omitted.length);
  assert.ok(value.omittedEvidenceIds.length <= omitted.length);
  for (const id of value.omittedEvidenceIds) assert.ok(omitted.some(record => record.evidenceId === id));
  for (const record of value.records) {
    const original = work.records.find(source => source.evidenceId === record.evidenceId);
    assert.ok(original); assert.equal(record.evidenceDigest, original.evidenceDigest);
    assert.deepEqual(record.content, original.content);
  }
  assert.equal(value.projectRoot, f.root); assert.deepEqual(value.route, { session_id: f.session.sessionId });
  if (value.expansion.startsWith("Omitted work:")) {
    assert.equal(value.expansion, "Omitted work: lode_session_work_read(project_root:projectRoot, ...route)");
  } else {
    assert.match(value.expansion, /^When needed, lode_conversation_enter with project_root:projectRoot and the exact route above reads originals/);
    assert.match(value.expansion, /Omitted work: lode_session_work_read with the same root\/route\.$/);
  }
  // Use the actual emitted root/route, not an evaluated prose instruction.
  const read = input => withSessionRoute(value.projectRoot, value.route.session_id,
    () => readSessionWorkContext({ root: value.projectRoot, ...input }));
  assert.deepEqual(read({}), work); // Restores source-selected eight, not the other 32.
  const target = omitted[0] || work.records[0];
  const exact = read({ evidenceIds: [target.evidenceId], maxRecords: 1 });
  assert.equal(exact.sessionId, value.route.session_id); assert.equal(exact.coverage.originals, null);
  assert.equal(exact.records.length, 1); assert.equal(exact.records[0].evidenceId, target.evidenceId);
  assert.equal(exact.records[0].evidenceDigest, target.evidenceDigest); assert.deepEqual(exact.records[0].content, target.content);
}

for (const runtime of ["codex", "claude"]) {
  test(`${runtime}: selected purpose survives no checkpoint with empty and saved work; reads write nothing`, async (t) => {
    const f = fixture(t, runtime), before = snapshot(f.base), raw = (await f.host.enter({ root: f.root }));
    const empty = (await f.read());
    assert.equal(raw.workContext.records.length, 0);
    assert.equal(empty.sessionPurpose, raw.workContext.sessionPurpose);
    assert.equal(empty.sessionRecovery, null);
    assert.deepEqual(snapshot(f.base), before);
    const retained = evidence(f, "Reason retained without changing current Session purpose");
    const savedBefore = snapshot(f.base), savedRaw = (await f.host.enter({ root: f.root })), saved = (await f.read());
    assert.equal(saved.sessionPurpose, savedRaw.workContext.sessionPurpose);
    assert.equal(saved.records[0].evidenceId, retained.evidence.evidenceId);
    assert.equal(saved.sessionRecovery, null);
    assert.deepEqual(snapshot(f.base), savedBefore);
  });

  test(`${runtime}: never-recorded, intact and lost direction remain distinct without repair`, async (t) => {
    const f = fixture(t, runtime);
    checkpoint(f);
    const absentBefore = snapshot(f.base), absent = (await f.read());
    assert.equal(absent.currentProjectDirection, null);
    assert.equal(Object.hasOwn(absent, "currentProjectDirectionAvailability"), false);
    assert.deepEqual(snapshot(f.base), absentBefore);
    const direction = updateProjectDirection({ root: f.root, input: { goal: "Inspect only", cancelledActions: ["deploy"] } }).direction;
    const intactBefore = snapshot(f.base), intact = (await f.read());
    assert.deepEqual(intact.currentProjectDirection, directionView(direction));
    assert.deepEqual(snapshot(f.base), intactBefore);
    fs.unlinkSync(path.join(f.root, relativeProjectArtifact(f.storage, "project-direction", "current.json")));
    const lostBefore = snapshot(f.base), raw = (await f.host.enter({ root: f.root })), lost = (await f.read());
    assert.deepEqual(raw.projectStatus.currentProjectDirectionAvailability, unavailable);
    assert.deepEqual(lost.currentProjectDirectionAvailability, unavailable);
    assert.equal(lost.currentProjectDirection, null);
    assert.notDeepEqual(lost, absent);
    assert.equal(lost.sessionPurpose, raw.workContext.sessionPurpose);
    assert.deepEqual(snapshot(f.base), lostBefore);
  });

  test(`${runtime}: current selected purpose and historical checkpoint/other Session stay separate`, async (t) => {
    const f = fixture(t, runtime), otherPurpose = "OTHER SESSION PURPOSE MUST NOT APPEAR";
    createHeadSession({ root: f.root, purpose: otherPurpose });
    checkpoint(f);
    const before = snapshot(f.base), raw = (await f.host.enter({ root: f.root })), value = (await f.read());
    assert.notEqual(raw.workContext.sessionPurpose, raw.restore.checkpoint.purpose);
    assert.equal(value.sessionPurpose, raw.workContext.sessionPurpose);
    assert.equal(value.sessionRecovery.purpose, raw.restore.checkpoint.purpose);
    assert.equal(value.sessionRecovery.historicalApprovalGrantsCurrentEffect, false);
    assert.equal(JSON.stringify(value).includes(otherPurpose), false);
    assert.deepEqual(snapshot(f.base), before);
  });

  test(`${runtime}: supported huge current purpose and common/history are honestly omitted`, async (t) => {
    const purpose = "Exact current selected purpose " + "목적\\\"".repeat(6000);
    const f = fixture(t, runtime, purpose);
    checkpoint(f, "Historical purpose " + "h".repeat(40000));
    const direction = updateProjectDirection({ root: f.root, input: { goal: "Large valid goal", constraints: ["c".repeat(40000)], cancelledActions: ["deploy"] } }).direction;
    let before = snapshot(f.base), value = (await f.read());
    assert.equal(value.sessionPurpose, null);
    assert.deepEqual(value.sessionPurposeCoverage, { contentIncluded: false, reason: "startup-output-bound", source: "workContext.sessionPurpose" });
    assert.deepEqual(value.currentProjectDirection, { directionId: direction.directionId, directionHash: direction.directionHash, contentIncluded: false });
    assert.equal(value.sessionRecovery.contentIncluded, false);
    assert.equal(value.sessionRecovery.historicalApprovalGrantsCurrentEffect, false);
    assert.equal(value.projectRoot, f.root);
    assert.match(value.expansion, /lode_conversation_enter.*workContext\.sessionPurpose/);
    assert.match(value.requiredSourceExpansion, /no constraint or cancellation is assumed absent/);
    assert.deepEqual(snapshot(f.base), before);
    fs.unlinkSync(path.join(f.root, relativeProjectArtifact(f.storage, "project-direction", "current.json")));
    before = snapshot(f.base); value = (await f.read());
    assert.equal(value.sessionPurposeCoverage.contentIncluded, false);
    assert.deepEqual(value.currentProjectDirectionAvailability, unavailable);
    assert.deepEqual(snapshot(f.base), before);
  });

  test(`${runtime}: final bound includes P3 coverage, omitted IDs and expansion; fitting purpose stays exact`, async (t) => {
    const f = fixture(t, runtime);
    for (let i = 0; i < 40; i += 1) evidence(f, `${i}: ` + "reviewable evidence ".repeat(100));
    updateProjectDirection({ root: f.root, input: { goal: "Preserve unavailable diagnosis under evidence budget" } });
    fs.unlinkSync(path.join(f.root, relativeProjectArtifact(f.storage, "project-direction", "current.json")));
    let selectedBodies;
    for (const variant of navigationCases(f)) {
    variant.prepare();
    const before = snapshot(f.base), raw = (await f.host.enter({ root: f.root })), value = (await f.read());
    assert.equal(raw.workContext.records.length, 8);
    assertPartialWorkExpansion(f, raw, value, runtime, variant.mode);
    const bodies = raw.workContext.records.map(({ evidenceId, evidenceDigest, content }) => ({ evidenceId, evidenceDigest, content }));
    if (selectedBodies) assert.deepEqual(bodies, selectedBodies); else selectedBodies = bodies;
    assert.equal(value.sessionPurpose, raw.workContext.sessionPurpose);
    assert.ok(value.records.length <= raw.workContext.records.length);
    assert.equal(value.omittedEvidenceCount, raw.workContext.records.length - value.records.length);
    const sourceIds = new Set(raw.workContext.records.map((r) => r.evidenceId));
    const includedIds = new Set(value.records.map((r) => r.evidenceId));
    for (const id of value.omittedEvidenceIds) assert.ok(sourceIds.has(id) && !includedIds.has(id));
    assert.ok(value.omittedEvidenceIds.length <= value.omittedEvidenceCount);
    for (const record of value.records) {
      const original = raw.workContext.records.find((r) => r.evidenceId === record.evidenceId);
      assert.equal(record.evidenceId, original.evidenceId); assert.equal(record.evidenceDigest, original.evidenceDigest); assert.deepEqual(record.content, original.content);
    }
    assert.deepEqual(value.currentProjectDirectionAvailability, unavailable);
    assert.equal(value.projectRoot, f.root);
    assert.deepEqual(snapshot(f.base), before);
    }
  });

  test(`${runtime}: compact optional coverage before omitting a current purpose that fits`, async (t) => {
    const purpose = "Fitting current purpose " + "p".repeat(4200), f = fixture(t, runtime, purpose);
    for (let i = 0; i < 40; i += 1) evidence(f, `${i}: ` + "bounded P3 history ".repeat(100));
    updateProjectDirection({ root: f.root, input: { goal: "Known direction loss with a fitting current purpose" } });
    fs.unlinkSync(path.join(f.root, relativeProjectArtifact(f.storage, "project-direction", "current.json")));
    for (const variant of navigationCases(f)) {
    variant.prepare();
    const before = snapshot(f.base), raw = (await f.host.enter({ root: f.root })), value = (await f.read());
    assertPartialWorkExpansion(f, raw, value, runtime, variant.mode);
    assert.equal(value.sessionPurpose, purpose);
    assert.equal(Object.hasOwn(value, "sessionPurposeCoverage"), false);
    assert.equal(value.projectRoot, f.root);
    assert.deepEqual(value.currentProjectDirectionAvailability, unavailable);
    assert.deepEqual(snapshot(f.base), before);
    }
  });

  test(`${runtime}: malformed/unbound events do not guess or register a Session`, async (t) => {
    const f = fixture(t, runtime), before = snapshot(f.base);
    for (const event of [{ ...f.event, hook_event_name: "PostToolUse" }, { ...f.event, source: "unsupported" }, { ...f.event, session_id: null }]) {
      assert.deepEqual((await sessionStartContext({ runtime, event, environment: f.environment })), {});
    }
    if (runtime === "codex") assert.deepEqual((await sessionStartContext({ runtime, event: { ...f.event, agent_id: "ambiguous" }, environment: f.environment })), {});
    const unbound = JSON.parse((await sessionStartContext({ runtime, event: { ...f.event, session_id: "unbound-synthetic-caller" }, environment: f.environment })).hookSpecificOutput.additionalContext);
    assert.equal(unbound.status, "session_selection_unresolved");
    assert.equal(unbound.logicalSessionId, null);
    assert.equal(unbound.route, null);
    assert.equal(unbound.sessionPurpose, null);
    assert.equal(unbound.ordinaryWorkBlocked, false);
    assert.deepEqual(snapshot(f.base), before);
  });
}

test("host-a: supported SessionStart sources receive shared guidance once without changing originals", async t => {
  for (const runtime of ["codex", "claude"]) {
    const f = fixture(t, runtime);
    updateProjectDirection({ root: f.root, input: { goal: "Current 실제 목적 😀", cancelledActions: ["Never deploy"] } });
    evidence(f, "Short retained reason: investigate locally; false, 0 and null are not permission.");
    const before = snapshot(f.base);
    for (const source of ["startup", "resume", "clear", "compact"]) {
      const text = (await sessionStartContext({ runtime, event: { ...f.event, source }, environment: f.environment })).hookSpecificOutput.additionalContext;
      const value = JSON.parse(text); assert.equal(value.coreGuidance, coreEntryGuidance());
      assert.equal(text.split(coreEntryGuidance()).length, 2); assert.equal(value.currentProjectDirection.input.cancelledActions[0], "Never deploy");
      assert(value.records.some(row => row.content.summary.includes("Short retained reason"))); assert.equal(value.sessionRecovery, null);
      assert(text.length <= (runtime === "claude" ? 10000 : 32768));
    }
    assert.deepEqual(snapshot(f.base), before);
  }
});

test("host-a: failed owner recovery still supplies generic guidance without inventing Session or candidates", async t => {
  const f = fixture(t, "claude"), project = path.join(f.root, f.storage.directory, "project.json");
  fs.writeFileSync(project, "{"); const before = snapshot(f.base);
  const text = (await sessionStartContext({ runtime: "claude", event: f.event, environment: f.environment })).hookSpecificOutput.additionalContext;
  const value = JSON.parse(text); assert.equal(value.coreGuidance, coreEntryGuidance()); assert.equal(value.status, "host_context_unavailable");
  assert.equal(value.logicalSessionId, undefined); assert.equal(value.conversationCandidates, undefined); assert.equal(value.sessionSelection, "not-inferred");
  assert.equal(value.ordinaryWorkBlocked, false); assert.deepEqual(snapshot(f.base), before);
});

// Pure production serializer coverage only: no adapter, valid filesystem path,
// installed Host or model receipt is claimed. Use the actual module, not an
// extraction from the old pre-refactor Hook body.
const sessionId = "session-AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const entry = () => ({ status: "synthetic-formatter-only", workContext: { sessionId, sessionPurpose: "Exact selected purpose", records: [] } });

test("private formatter: explicit nested diagnosis keeps its own null; null metadata is not diagnosis", () => {
  const raw = entry();
  raw.restore = { projection: { currentProjectDirection: { directionId: "other-view" }, currentProjectDirectionAvailability: null } };
  raw.projectStatus = { currentProjectDirection: null, currentProjectDirectionAvailability: unavailable };
  raw.currentProjectDirection = { directionId: "root-other-view" };
  let value = JSON.parse(projectStartup(raw, pluginRoot));
  assert.equal(value.currentProjectDirection, null);
  assert.deepEqual(value.currentProjectDirectionAvailability, unavailable);
  raw.restore.projection.currentProjectDirectionAvailability = unavailable;
  raw.restore.projection.currentProjectDirection = null;
  raw.projectStatus.currentProjectDirection = { directionId: "status-other-view" };
  value = JSON.parse(projectStartup(raw, pluginRoot));
  assert.equal(value.currentProjectDirection, null);
  assert.deepEqual(value.currentProjectDirectionAvailability, unavailable);
  for (const metadata of [null, undefined]) {
    raw.restore.projection.currentProjectDirectionAvailability = metadata;
    delete raw.projectStatus.currentProjectDirectionAvailability;
    value = JSON.parse(projectStartup(raw, pluginRoot));
    assert.equal(value.currentProjectDirection, null);
    assert.equal(Object.hasOwn(value, "currentProjectDirectionAvailability"), false);
  }
});

test("private formatter: optional omission IDs cannot evict fitting current content or exceed the final budget", (t) => {
  const raw = entry();
  raw.workContext.status = "work_context_available";
  raw.workContext.coverage = { originals: 2, inspected: 2, included: 2, maxRecords: 8, maxCharacters: 32768, usedCharacters: 2,
    characterBudgetScope: "JSON.stringify(records).length; separate bounded metadata envelope excluded" };
  raw.workContext.omissions = { uninspected: 0, byBudget: 0, evidenceIds: [], omittedIdCount: 0 };
  const withoutOptionalGuidance = value => { const result = JSON.parse(projectStartup(value, pluginRoot)); delete result.coreGuidance; delete result.coreGuidanceDelivery; return JSON.stringify(result).length; };
  const baseline = withoutOptionalGuidance(raw);
  const id = (n) => "work-evidence-" + String(n).padStart(24, "0");
  raw.workContext.records = [{ evidenceId: id(1), content: { summary: "" }, references: [] }];
  const overhead = withoutOptionalGuidance(raw) - baseline;
  raw.workContext.records[0].content.summary = "x".repeat(10000 - baseline - overhead);
  const fittedText = projectStartup(raw, pluginRoot), fittedValue = JSON.parse(fittedText);
  assert(fittedText.length <= 10000);
  assert.deepEqual(fittedValue.records[0].content, raw.workContext.records[0].content,
    "Optional guidance/omission metadata cannot displace an original that fits");
  raw.workContext.records.push({ evidenceId: id(2), content: { summary: "Omitted record" }, references: [] });
  const text = projectStartup(raw, pluginRoot), value = JSON.parse(text);
  assert.ok(text.length <= 10000);
  assert.equal(value.omittedEvidenceCount, 2 - value.records.length);
  const included = new Set(value.records.map((record) => record.evidenceId));
  for (const omitted of value.omittedEvidenceIds) assert.ok(!included.has(omitted) && [id(1), id(2)].includes(omitted));
  assert.equal(value.sessionPurpose, raw.workContext.sessionPurpose);
  t.diagnostic(JSON.stringify({ evidenceScope: "private-serializer-only", length: text.length, branch: "optional-omission-IDs-after-current-content" }));
});

test("private formatter: oversized metadata/root explicitly omit content and retain exact route/diagnosis", (t) => {
  const raw = entry();
  raw.projectStatus = { currentProjectDirection: null, currentProjectDirectionAvailability: unavailable };
  raw.workContext.coverage = { serializerOnlyOversizedMetadata: "c".repeat(20000) };
  let text = projectStartup(raw, pluginRoot), value = JSON.parse(text);
  assert.ok(text.length <= 10000);
  assert.equal(value.workCoverage.omitted, true);
  assert.equal(value.sessionPurpose, raw.workContext.sessionPurpose);
  assert.equal(value.projectRoot, pluginRoot);
  assert.deepEqual(value.currentProjectDirectionAvailability, unavailable);
  raw.workContext.coverage = {};
  text = projectStartup(raw, path.parse(pluginRoot).root + "r".repeat(20000)); value = JSON.parse(text);
  assert.ok(text.length <= 10000);
  assert.equal(Object.hasOwn(value, "projectRoot"), false);
  assert.equal(value.projectRootOmitted, true);
  assert.equal(value.projectRootSource, "SessionStart.cwd");
  assert.deepEqual(value.route, { session_id: sessionId });
  assert.deepEqual(value.currentProjectDirectionAvailability, unavailable);
  assert.match(value.expansion, /project_root:the original SessionStart.cwd and the exact route/);
  t.diagnostic(JSON.stringify({ evidenceScope: "private-serializer-only; unsupported-filesystem-path-not-executed", length: text.length, branch: "coverage-and-last-resort-root-omission" }));
});


test("P3 optional discovery never evicts fitting current direction; overflow expands common P2 rather than Session inventory", () => {
  const root = path.resolve(os.tmpdir(), "synthetic-project-p3");
  const discovery = { status: "not_queried", call: { name: publicToolName("head_session_list"),
    arguments: { project_root: root } }, automatic: false, selectsSession: false };
  const entry = count => ({ status: "session_selection_unresolved", currentProjectDirection: {
    directionId: "direction-current-exact", directionHash: "current-direction-digest",
    input: { goal: "Independent authorized work", constraints: ["Current local scope only"], decisions: [],
      cancelledActions: ["User cancelled deployment. " + "x".repeat(count)] } },
    currentProjectDirectionAvailability: { status: "available" } });
  for (const [runtime, limit] of [["claude", 10000], ["codex", 32768], ["opencode", 32768]]) {
    const render = (count, hint) => JSON.parse(projectStartup({ ...entry(count), ...(hint ? { sessionDiscovery: discovery } : {}) }, root, runtime));
    let low = 0, high = limit * 2;
    while (low + 1 < high) {
      const mid = Math.floor((low + high) / 2);
      if (render(mid, false).currentProjectDirection?.contentIncluded === false) high = mid;
      else low = mid;
    }
    for (const count of [0, low, high, limit * 2]) {
      const without = render(count, false), withHint = render(count, true);
      assert.deepEqual(withHint.currentProjectDirection, without.currentProjectDirection,
        runtime + ": optional lookup must not displace a fitting current cancellation");
      assert(JSON.stringify(withHint).length <= limit);
      assert.equal(withHint.route, null); assert.equal(withHint.logicalSessionId, null);
      if (withHint.currentProjectDirection?.contentIncluded === false) {
        assert.match(withHint.requiredSourceExpansion, /no constraint or cancellation is assumed absent/u);
        assert.match(withHint.expansion, new RegExp(publicToolName("head_project_direction_read"), "u"));
        assert.doesNotMatch(withHint.expansion, /session_list/u);
      } else assert.deepEqual(withHint.currentProjectDirection.input, entry(count).currentProjectDirection.input);
      if (withHint.sessionDiscovery) assert.deepEqual(withHint.sessionDiscovery, discovery);
    }
  }
});
