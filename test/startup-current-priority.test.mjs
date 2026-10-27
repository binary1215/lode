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
import { recordSessionWorkEvidence, readSessionWorkContext } from "../scripts/lib/session-work-context.mjs";
import { updateProjectDirection } from "../scripts/lib/project-direction.mjs";
import { inspectRecoveryCheckpointBasis, syncRecoveryCheckpoint } from "../scripts/lib/compaction-recovery.mjs";
import { sessionStartContext } from "../scripts/session-host-hook.mjs";
import { startupProjection as privateFormatter } from "../scripts/lib/session-host-context-projection.mjs";

const directionView = value => value ? Object.fromEntries(["directionId", "directionHash", "input"].filter(key => value[key] !== undefined).map(key => [key, value[key]])) : null;

const pluginRoot = path.resolve(import.meta.dirname, "..");
const unavailable = { status: "unavailable", reasonCode: "PROJECT_DIRECTION_UNAVAILABLE", dependentEffectsBlocked: true };
function snapshot(base) {
  const result = {};
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) walk(file);
      else { const stat = fs.statSync(file); result[path.relative(base, file)] = {
        hash: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), size: stat.size,
        mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs, mode: stat.mode };
      }
    }
  };
  walk(base); return result;
}
function fixture(t, purpose, { records = 40, checkpoint = false } = {}) {
  const temporaryRoot = process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const base = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, "startup-current-priority-")));
  const root = path.join(base, "project"), operational = path.join(base, "host");
  fs.mkdirSync(root);
  initializeProject({ root, pluginRoot, runtimes: ["codex", "claude"] });
  const storage = inspectProject(root).storage;
  const session = createHeadSession({ root, purpose });
  createHeadSession({ root, purpose: "OTHER SESSION: never substitute this direction" });
  const direction = updateProjectDirection({ root, input: { goal: "Investigate cache only", constraints: ["Common constraint: preserve original user files"],
    cancelledActions: ["Do not deploy"] } }).direction;
  withSessionRoute(root, session.sessionId, () => {
    if (checkpoint) syncRecoveryCheckpoint({ root, expectedRecoveryBasisId: inspectRecoveryCheckpointBasis({ root }).basis.basisId,
      purpose: "Selected checkpoint purpose: local rewrite cancelled; inspect only. " + "q".repeat(180),
      approvedDecisions: ["Local cancellation in explicit decisions: do not contact the network. " + "d".repeat(180)],
      currentPosition: "Current local position: prior upload cancelled. " + "c".repeat(180),
      nextExpectedResult: "Current local next result: explanation only; do not execute old plan. " + "n".repeat(180) });
    for (let i = 0; i < records; i += 1) recordSessionWorkEvidence({ root,
      input: { summary: i + ": Historical investigation note; no current effect permission. " + "h".repeat(2000) } });
  });
  const environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: operational };
  const callers = ["codex", "claude"].map((runtime) => {
    const nativeSessionId = "current-priority-" + runtime;
    const host = createSessionHostAdapter({ runtime, nativeSessionId, environment });
    assert.equal(host.select({ root, sessionId: session.sessionId, expectedRevision: 0 }).retained, true);
    return { runtime, host, read() {
      const text = sessionStartContext({ runtime, environment, event: { hook_event_name: "SessionStart", source: "startup", cwd: root, session_id: nativeSessionId } }).hookSpecificOutput.additionalContext;
      assert.ok(text.length <= (runtime === "codex" ? 32768 : 10000), `Final context ${text.length}`);
      const value = JSON.parse(text);
      assert.deepEqual(value.route, { session_id: session.sessionId });
      assert.equal(value.projectRoot, root);
      assert.equal(value.logicalSessionId, session.sessionId);
      for (const flag of ["ordinaryWorkBlocked", "userDecisionRequired", "persisted"]) assert.equal(value[flag], false);
      assert.match(value.scope, /Read-only, non-atomic.*history\/P3 grant no effects/);
      assert.match(value.hostCapability, /Verified.*never guess.*No extra bind\/save\/repeated Session ID/);
      const omittedWork = value.omittedEvidenceCount > 0 || value.workCoverage.status === "work_context_partial";
      if (value.expansion.startsWith("When needed,")) {
        assert.match(value.expansion, /^When needed, lode_conversation_enter with project_root:projectRoot and the exact route above reads originals/);
        assert.equal(value.expansion.includes("Omitted work:"), omittedWork);
        if (omittedWork) assert.match(value.expansion, /Omitted work: lode_session_work_read with the same root\/route\.$/);
      } else {
        const enter = value.requiredSourceExpansion ? "When needed: lode_conversation_enter(project_root:projectRoot, ...route)" : "";
        const work = omittedWork ? "Omitted work: lode_session_work_read(project_root:projectRoot, ...route)" : "";
        assert.equal(value.expansion, enter + (enter && work ? "; " : "") + work);
      }
      return { text, value };
    } };
  });
  t.after(() => { if (process.env.HEAD_AGENT_KEEP_TEST_TMP !== "1") fs.rmSync(base, { recursive: true, force: true }); });
  t.diagnostic(JSON.stringify({ evidenceScope: "synthetic-public-adapter-and-hook; actualHost/model-unverified", fixture: base, sessionId: session.sessionId }));
  return { base, root, storage, session, direction, callers };
}
function checkpointView(raw) {
  const c = raw.restore?.checkpoint;
  return c ? { checkpointId: c.checkpointId, ...(c.checkpointDigest ? { checkpointDigest: c.checkpointDigest } : {}), ...(c.openReviewIds ? { openReviewIds: c.openReviewIds } : {}), purpose: c.purpose, approvedDecisions: c.approvedDecisions,
    historicalPosition: c.currentPosition, historicalNextExpectedResult: c.nextExpectedResult,
    historicalApprovalGrantsCurrentEffect: false } : null;
}
function navigationCases(f) {
  const { root } = f;
  const file = path.join(root, relativeProjectArtifact(f.storage, "graph-discovery", "index.json")), raw = fs.readFileSync(file, "utf8"), legacy = JSON.parse(raw);
  assert.equal(legacy.sessionWorkNavigation?.version, 1); delete legacy.sessionWorkNavigation;
  return ["hinted", "legacy", "missing"].map(mode => ({ mode, prepare() {
    if (mode === "missing") fs.unlinkSync(file); else fs.writeFileSync(file, mode === "hinted" ? raw : JSON.stringify(legacy));
  } }));
}

function assertOptionalWorkExpansion(f, raw, value, runtime, mode) {
  assert.equal(value.projectRoot, f.root); assert.deepEqual(value.route, { session_id: f.session.sessionId });
  const work = raw.workContext;
  assert.equal(work.status, "work_context_partial");
  const inspected = mode === "hinted" ? 8 : 40;
  assert.equal(work.coverage.originals, 40);
  for (const key of ["inspected", "valid"]) assert.equal(work.coverage[key], inspected);
  assert.equal(work.coverage.unavailable, 0); assert.equal(work.omissions.uninspected, 40 - inspected);
  if (mode === "hinted") {
    assert.match(work.coverage.selection, /historical|hint/i); assert.match(work.coverage.selection, /inspected/i);
    assert.match(value.scope, /historical|hint/i); assert.match(value.scope, /inspected/i);
  } else assert.match(work.coverage.selection, /all discovered originals canonically inspected once.*partial body delivery.*not live state or semantic sufficiency/);
  assert.equal(work.coverage.included, 8); assert.equal(work.records.length, 8);
  assert.equal(work.omissions.byBudget, 0); assert.deepEqual(work.omissions.evidenceIds, []);
  assert.equal(value.workCoverage.status, work.status);
  if (value.workCoverage.omitted) {
    assert.equal(value.workCoverage.sourceOriginals, 40); assert.equal(value.workCoverage.sourceInspected, inspected);
    assert.equal(value.workCoverage.sourceIncluded, 8);
  } else {
    assert.deepEqual(value.workCoverage.coverage, work.coverage); assert.deepEqual(value.workCoverage.omissions, work.omissions);
  }
  const included = new Set(value.records.map(record => record.evidenceId));
  for (const record of value.records) {
    const original = work.records.find(source => source.evidenceId === record.evidenceId);
    assert.ok(original); assert.equal(record.evidenceDigest, original.evidenceDigest); assert.deepEqual(record.content, original.content);
  }
  const omitted = work.records.filter(record => !included.has(record.evidenceId));
  if (runtime === "claude") assert.ok(omitted.length > 0, "Exercise additional Hook omission, not source budget rejection");
  assert.equal(value.omittedEvidenceCount, omitted.length);
  for (const id of value.omittedEvidenceIds) assert.ok(omitted.some(record => record.evidenceId === id));
  assert.ok(value.omittedEvidenceIds.length <= omitted.length);
  const read = input => withSessionRoute(value.projectRoot, value.route.session_id,
    () => readSessionWorkContext({ root: value.projectRoot, ...input }));
  const expanded = read({}); assert.deepEqual(expanded, work);
  assert.equal(expanded.sessionPurpose, value.sessionPurpose);
  const target = omitted[0] || work.records[0], exact = read({ evidenceIds: [target.evidenceId], maxRecords: 1 });
  assert.equal(exact.sessionId, value.route.session_id); assert.equal(exact.coverage.originals, null);
  assert.equal(exact.records.length, 1); assert.equal(exact.records[0].evidenceId, target.evidenceId);
  assert.equal(exact.records[0].evidenceDigest, target.evidenceDigest); assert.deepEqual(exact.records[0].content, target.content);
}

test("public Hook: current common cancellation and 4200-character selected purpose precede P3/metadata in both runtimes", (t) => {
  const f = fixture(t, "Current selected purpose: " + "p".repeat(4200));
  for (const variant of navigationCases(f)) {
  variant.prepare();
  const before = snapshot(f.base);
  for (const caller of f.callers) {
    const raw = caller.host.enter({ root: f.root }), { text, value } = caller.read();
    assert.equal(raw.workContext.omissions.byBudget, 0);
    assert.equal(raw.workContext.omissions.uninspected, variant.mode === "hinted" ? 32 : 0);
    assert.equal(raw.workContext.coverage.valid, variant.mode === "hinted" ? 8 : 40);
    assert.equal(raw.workContext.status, "work_context_partial");
    assert.equal(value.sessionPurpose, raw.workContext.sessionPurpose);
    assert.deepEqual(value.currentProjectDirection, directionView(f.direction));
    assert.equal(Object.hasOwn(value, "requiredSourceExpansion"), false);
    assert.equal(Object.hasOwn(value, "sessionPurposeCoverage"), false);
    assert.equal(value.omittedEvidenceCount, raw.workContext.records.length - value.records.length);
    assert.equal(value.sessionRecovery, null);
    assertOptionalWorkExpansion(f, raw, value, caller.runtime, variant.mode);
    t.diagnostic(JSON.stringify({ runtime: caller.runtime, length: text.length, currentPurposeExact: true, currentCommonExact: true,
      omittedEvidenceCount: value.omittedEvidenceCount, omittedIdSample: value.omittedEvidenceIds.length }));
  }
  assert.deepEqual(snapshot(f.base), before);
  }
});

test("public Hook: all four latest selected checkpoint direction fields survive alongside current common and Session purpose", (t) => {
  const f = fixture(t, "Current Session local scope: no external effects. " + "p".repeat(2300), { checkpoint: true });
  const variants = navigationCases(f);
  for (const variant of variants) {
  variant.prepare();
  let before = snapshot(f.base);
  for (const caller of f.callers) {
    const raw = caller.host.enter({ root: f.root }), { value, text } = caller.read();
    assert.deepEqual(value.currentProjectDirection, directionView(f.direction));
    assert.equal(value.sessionPurpose, raw.workContext.sessionPurpose);
    assert.deepEqual(value.sessionRecovery, checkpointView(raw));
    assert.equal(Object.hasOwn(value, "requiredSourceExpansion"), false);
    assertOptionalWorkExpansion(f, raw, value, caller.runtime, variant.mode);
    t.diagnostic(JSON.stringify({ runtime: caller.runtime, length: text.length, latestSelectedP2FieldsExact: true }));
  }
  assert.deepEqual(snapshot(f.base), before);
  }
  fs.unlinkSync(path.join(f.root, relativeProjectArtifact(f.storage, "project-direction", "current.json")));
  for (const variant of variants) {
  variant.prepare();const before = snapshot(f.base);
  for (const caller of f.callers) {
    const raw = caller.host.enter({ root: f.root }), { value } = caller.read();
    assert.equal(value.currentProjectDirection, null);
    assert.deepEqual(value.currentProjectDirectionAvailability, unavailable);
    assert.equal(value.sessionPurpose, raw.workContext.sessionPurpose);
    assert.deepEqual(value.sessionRecovery, checkpointView(raw));
    assertOptionalWorkExpansion(f, raw, value, caller.runtime, variant.mode);
  }
  assert.deepEqual(snapshot(f.base), before);
  }
});

test("public Hook: normal complete context adds no omission-specific query instruction", (t) => {
  const f = fixture(t, "Inspect this source and finish the requested explanation", { records: 0 });
  const before = snapshot(f.base);
  for (const caller of f.callers) {
    const { value } = caller.read();
    assert.equal(value.omittedEvidenceCount, 0);
    assert.equal(Object.hasOwn(value, "requiredSourceExpansion"), false);
    assert.equal(value.expansion.includes("lode_session_work_read"), false);
    assert.equal(value.expansion.includes("omitted"), false);
    assert.equal(value.expansion.includes("reread"), false);
    assert.equal(value.expansion.includes("required"), false);
  }
  assert.deepEqual(snapshot(f.base), before);
});

// Exercise exact capacity boundaries using the unchanged private formatter,
// independently of filesystem/Host behavior. This is serializer-only evidence.
const clone = (value) => JSON.parse(JSON.stringify(value));
const id = "session-AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
function serializerEntry(purposeLength, checkpointLength = 0) {
  return { status: "serializer-only", currentProjectDirection: { directionId: "direction-" + "a".repeat(24),
    input: { goal: "Current goal", constraints: ["Keep user files"], cancelledActions: ["deploy"] } },
  restore: checkpointLength ? { checkpoint: { checkpointId: "checkpoint-" + "b".repeat(24), purpose: "local cancellation " + "c".repeat(checkpointLength),
    approvedDecisions: ["No network"], currentPosition: "Upload cancelled", nextExpectedResult: "Explain only" } } : undefined,
  workContext: { sessionId: id, sessionPurpose: "p".repeat(purposeLength), records: [], coverage: { originals: 40, inspected: 40, included: 0 },
    omissions: { byBudget: 40, evidenceIds: Array.from({ length: 32 }, (_, i) => "work-evidence-" + String(i).padStart(24, "0")) }, nextAfterEvidenceId: null } };
}
test("private formatter: varying root/purpose/checkpoint lengths preserves every fitting protected block before optional detail", (t) => {
  let fitted = 0, oversized = 0;
  for (const root of [pluginRoot, path.join(pluginRoot, "different-supported-root-length")]) {
    for (const checkpointLength of [0, 280]) {
      for (const purposeLength of [0, 5000, 7200, 7700, 8000, 8300, 8600, 8900, 9200, 9800, 12000]) {
        const raw = serializerEntry(purposeLength, checkpointLength), value = JSON.parse(privateFormatter(raw, root));
        const text = JSON.stringify(value);
        assert.ok(text.length <= 10000);
        assert.deepEqual(value.route, { session_id: id });
        const witness = clone(value);
        witness.currentProjectDirection = raw.currentProjectDirection;
        witness.sessionPurpose = raw.workContext.sessionPurpose;
        witness.sessionRecovery = checkpointView(raw);
        delete witness.sessionPurposeCoverage;
        delete witness.requiredSourceExpansion;
        witness.records = []; witness.omittedEvidenceIds = []; witness.omittedEvidenceCount = 0;
        witness.workCoverage = { omitted: true, sourceOriginals: raw.workContext.coverage.originals, sourceInspected: raw.workContext.coverage.inspected, sourceIncluded: raw.workContext.coverage.included };
        witness.scope = "Read-only, non-atomic. Current common/selected P2 apply; history/P3 grant no effects. IDs/digests select originals; reference freshness not inferred. Check current authority for effects.";
        witness.hostCapability = "Verified route only; never guess. No extra bind/save/repeated Session ID.";
        witness.expansion = "Omitted work: lode_session_work_read(project_root:projectRoot, ...route)";
        if (JSON.stringify(witness).length <= 10000) {
          fitted += 1;
          assert.equal(value.sessionPurpose, raw.workContext.sessionPurpose);
          assert.deepEqual(value.currentProjectDirection, raw.currentProjectDirection);
          assert.deepEqual(value.sessionRecovery, checkpointView(raw));
          assert.equal(Object.hasOwn(value, "requiredSourceExpansion"), false);
        } else oversized += 1;
      }
    }
  }
  assert.ok(fitted > 10 && oversized > 1);
  t.diagnostic(JSON.stringify({ evidenceScope: "private-serializer-only", variants: fitted + oversized, fitted, oversized }));
});

test("private formatter: even optional compact coverage/prose yield to all protected originals at the exact boundary", (t) => {
  const raw = serializerEntry(0, 280), witness = JSON.parse(privateFormatter(raw, pluginRoot));
  delete witness.coreGuidance; delete witness.coreGuidanceDelivery;
  witness.workCoverage = { omitted: true, sourceOriginals: raw.workContext.coverage.originals, sourceInspected: raw.workContext.coverage.inspected, sourceIncluded: raw.workContext.coverage.included };
  witness.scope = "Read-only, non-atomic. Current common/selected P2 apply; history/P3 grant no effects. IDs/digests select originals; reference freshness not inferred. Check current authority for effects.";
  witness.hostCapability = "Verified route only; never guess. No extra bind/save/repeated Session ID.";
  witness.expansion = "Omitted work: lode_session_work_read(project_root:projectRoot, ...route)";
  const capacity = 10000 - JSON.stringify(witness).length;
  for (const delta of [-1, 0, 1]) {
    const candidate = serializerEntry(capacity + delta, 280), text = privateFormatter(candidate, pluginRoot), value = JSON.parse(text);
    assert.ok(text.length <= 10000);
    assert.deepEqual(value.currentProjectDirection, candidate.currentProjectDirection);
    assert.deepEqual(value.sessionRecovery, checkpointView(candidate));
    if (delta <= 0) {
      assert.equal(value.sessionPurpose, candidate.workContext.sessionPurpose);
      assert.equal(Object.hasOwn(value, "requiredSourceExpansion"), false);
      assert.deepEqual(value.workCoverage, witness.workCoverage);
      if (delta === 0) assert.equal(text.length, 10000);
    } else assert.equal(value.sessionPurposeCoverage.contentIncluded, false);
    t.diagnostic(JSON.stringify({ evidenceScope: "private-serializer-only", delta, purposeCharacters: capacity + delta, length: text.length }));
  }
});

test("private formatter: equal-size protected blocks use the documented serialization tie order", () => {
  const raw = serializerEntry(0, 6000), recoverySize = JSON.stringify(checkpointView(raw)).length;
  raw.workContext.sessionPurpose = "p".repeat(recoverySize - 2);
  assert.equal(JSON.stringify(raw.workContext.sessionPurpose).length, recoverySize);
  const value = JSON.parse(privateFormatter(raw, pluginRoot));
  assert.equal(value.sessionRecovery.contentIncluded, false);
  assert.equal(value.sessionRecovery.historicalApprovalGrantsCurrentEffect, false);
  assert.equal(value.sessionPurpose, raw.workContext.sessionPurpose);
  assert.deepEqual(value.currentProjectDirection, raw.currentProjectDirection);
});

test("private formatter: actual protected overflow omits the largest whole block and keeps diagnosis/other exact blocks", () => {
  const raw = serializerEntry(14000, 180);
  raw.currentProjectDirection = null;
  raw.currentProjectDirectionAvailability = unavailable;
  const text = privateFormatter(raw, pluginRoot), value = JSON.parse(text);
  assert.ok(text.length <= 10000);
  assert.equal(value.sessionPurpose, null);
  assert.deepEqual(value.sessionPurposeCoverage, { contentIncluded: false, reason: "startup-output-bound", source: "workContext.sessionPurpose" });
  assert.deepEqual(value.sessionRecovery, checkpointView(raw));
  assert.deepEqual(value.currentProjectDirectionAvailability, unavailable);
  assert.match(value.requiredSourceExpansion, /no constraint or cancellation is assumed absent/);
  assert.match(value.expansion, /lode_conversation_enter.*project_root:projectRoot.*exact route.*workContext\.sessionPurpose/);
  assert.equal(value.ordinaryWorkBlocked, false);
});
