import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { sessionStartContext } from "../scripts/session-host-hook.mjs";
import { startupProjection as format, COMPACT_SCOPE as compactScope } from "../scripts/lib/session-host-context-projection.mjs";
import { createSessionHostAdapter } from "../scripts/lib/session-host-adapter.mjs";
import { enterConversationRecovery } from "../scripts/lib/compaction-lifecycle.mjs";
import { updateProjectDirection } from "../scripts/lib/project-direction.mjs";
import { inspectRecoveryCheckpointBasis, syncRecoveryCheckpoint } from "../scripts/lib/compaction-recovery.mjs";
import { fixture, link, exact, citation, snapshot, pluginRoot } from "./helpers/session-work-linkage-fixture.mjs";

// Serializer and injected local Host seam only, not installed/native/model tests.
const digest = "a".repeat(64), sessionId = "session-AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const empty = () => ({ status: "conversation_ready", workContext: { status: "work_context_available", sessionId,
  sessionPurpose: "Current purpose", records: [], omissions: { byBudget: 0, uninspected: 0 } } });


const prosePurpose = "선택 Session 목적: 캐시 키의 차이를 설명하고 외부 효과는 실행하지 않는다.";
function proseOriginals(f, reason) {
  updateProjectDirection({ root: f.root, input: { goal: "현재 공통 지시: 로컬 캐시만 조사한다.",
    constraints: ["검증은 합성 입력으로만 수행한다."], cancelledActions: ["Do not deploy; 배포는 취소되었다."] } });
  const cp = f.route(() => syncRecoveryCheckpoint({ root: f.root,
    expectedRecoveryBasisId: inspectRecoveryCheckpointBasis({ root: f.root }).basis.basisId,
    purpose: "선택 P2 목적: 키 구분과 근거를 전달한다.", approvedDecisions: ["외부 요청을 만들지 않는다."],
    currentPosition: "현재 위치: 로컬 비교를 마쳤고 근거를 정리한다.", nextExpectedResult: "다음 결과: 남은 X의 확인 조건을 설명한다." })).checkpoint;
  const judgment = f.save({ judgments: [{ assessment: "A 대신 B를 선택한 과거 판단", reason, alternatives: ["A: 모든 언어를 같은 키로 재사용한다."] }] });
  f.save({ summary: "최근 결과: 선택 범위의 로컬 키 비교를 완료했다. 외부효과의 성공은 주장하지 않는다.",
    pending: ["남은 X: 프랑스어 입력의 무효화 경계를 검증해야 한다."], unknowns: ["실제 서비스 입력과 실제 Host 결과는 관측하지 않았다."],
    workLink: link(judgment), references: [citation(f, judgment)] });
  return cp;
}

for (const [runtime, limit] of [["codex", 32768], ["claude", 10000]]) {
  test(`${runtime}: exact complete-output limit-1/limit/+1 preserves whole protected content`, () => {
    const input = empty();
    input.currentProjectDirection = { directionId: "direction-exact", directionHash: digest,
      input: { goal: "Explain only", constraints: ["Do not send data"], cancelledActions: ["deploy", "network"] } };
    let low = 0, high = limit * 2;
    while (low < high) {
      const n = Math.ceil((low + high) / 2); input.workContext.sessionPurpose = "p".repeat(n);
      const value = JSON.parse(format(input, pluginRoot, runtime));
      if (value.sessionPurpose === input.workContext.sessionPurpose) low = n; else high = n - 1;
    }
    for (const delta of [-1, 0, 1]) {
      input.workContext.sessionPurpose = "p".repeat(low + delta);
      const before = structuredClone(input), text = format(input, pluginRoot, runtime), value = JSON.parse(text);
      assert.ok(text.length <= limit); assert.deepEqual(input, before);
      assert.equal(value.currentProjectDirection.directionHash, digest);
      assert.deepEqual(value.currentProjectDirection.input.cancelledActions, ["deploy", "network"]);
      if (delta <= 0) { assert.equal(value.sessionPurpose, input.workContext.sessionPurpose); assert.equal(text.length, limit + delta); }
      else { assert.equal(value.sessionPurpose, null); assert.equal(value.sessionPurposeCoverage.contentIncluded, false);
        assert.match(value.requiredSourceExpansion, /no constraint or cancellation is assumed absent/); }
      assert.deepEqual(value.route, { session_id: sessionId });
    }
  });
  test(`${runtime}: CJK/non-BMP/escaping and extreme valid direction keep separate byte/character measures`, () => {
    const input = empty(); input.workContext.sessionPurpose = "한국어 日本語 😀 \\\"\n".repeat(300);
    const text = format(input, pluginRoot, runtime), value = JSON.parse(text);
    assert.equal(value.sessionPurpose, input.workContext.sessionPurpose);
    assert.ok(Buffer.byteLength(text) > text.length); assert.ok(text.length <= limit);
    const outer = JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } });
    assert.equal(JSON.parse(outer).hookSpecificOutput.additionalContext, text);
    assert.ok(Buffer.byteLength(outer) > Buffer.byteLength(text));
    input.workContext.sessionPurpose = "Huge valid P2 body " + "한😀\\\"".repeat(50000);
    const extreme = JSON.parse(format(input, pluginRoot, runtime));
    assert.equal(extreme.sessionPurpose, null); assert.equal(extreme.sessionPurposeCoverage.contentIncluded, false);
    assert.equal(extreme.ordinaryWorkBlocked, false); assert.equal(extreme.persisted, false);
  });
  test(`${runtime}: compact reference checks retain exact pairing, foreign/null owner and nonconstant diagnostics`, () => {
    const input = empty(), refs = [
      { path: "source.txt", digest, kind: "source" },
      { path: ".head/other.json", digest, kind: "artifact" },
      { path: "missing.txt", digest, kind: "source" },
    ];
    input.workContext.records = [{ evidenceId: "work-evidence-" + "b".repeat(24), evidenceDigest: digest,
      content: { summary: "Exact body", references: refs }, references: [
        { ...refs[0], status: "matching-current-bytes", originalOwner: null, semanticFreshness: "not-inferred", instructionAuthority: false, recoveryAuthority: false },
        { ...refs[1], status: "intact-retained-original", originalOwner: { projectId: "same-project", sessionId: "different-session" }, excerpt: "retained excerpt", omittedCharacters: 42 },
        { ...refs[2], status: "unavailable", reasonCode: "SESSION_WORK_REFERENCE_CHANGED", contentReconstructed: false },
        { path: "unpaired.txt", digest, kind: "source", status: "unavailable", contentReconstructed: false },
      ] }];
    const before = structuredClone(input), value = JSON.parse(format(input, pluginRoot, runtime)), record = value.records[0];
    assert.deepEqual(record.content, input.workContext.records[0].content); assert.equal(record.evidenceDigest, digest);
    assert.deepEqual(record.referenceChecks[0], { referenceIndex: 0, status: "matching-current-bytes", originalOwner: null });
    assert.deepEqual(record.referenceChecks[1], { referenceIndex: 1, status: "intact-retained-original", originalOwner: { projectId: "same-project", sessionId: "different-session" }, excerpt: "retained excerpt", omittedCharacters: 42 });
    assert.deepEqual(record.referenceChecks[2], { referenceIndex: 2, status: "unavailable", reasonCode: "SESSION_WORK_REFERENCE_CHANGED", contentReconstructed: false });
    assert.deepEqual(record.referenceChecks[3], input.workContext.records[0].references[3]);
    assert.match(value.scope, /Original IDs\/digests select verified sources, not this projection/);
    assert.deepEqual(input, before);
  });
  test(`${runtime}: zero-record unavailable and changed-basis work are not reported as no history`, () => {
    for (const status of ["work_context_unavailable", "work_context_basis_changed"]) {
      const input = empty(); input.workContext.status = status; input.workContext.reasonCode = "SYNTHETIC_UNAVAILABLE";
      const text = format(input, pluginRoot, runtime), value = JSON.parse(text);
      assert.equal(value.workCoverage.status, status); assert.equal(value.workCoverage.reasonCode, "SYNTHETIC_UNAVAILABLE");
      assert.match(value.expansion, /lode_session_work_read/); assert.equal(value.ordinaryWorkBlocked, false);
      assert.ok(text.length <= limit);
    }
  });
  test(`${runtime}: canonical conflict/incomplete, large P2 and last-resort root paths stay bounded`, () => {
    for (const status of ["conflict", "incomplete"]) for (const size of [1, limit - 1200, limit, limit * 2]) {
      const input = empty(); input.workContext.sessionPurpose = "p".repeat(size);
      input.currentProjectDirection = { directionId: "exact-direction", directionHash: digest,
        input: { goal: "Current goal", constraints: ["c".repeat(size)], cancelledActions: ["Deployment cancelled"] } };
      input.restore = { checkpoint: { checkpointId: "exact-checkpoint", checkpointDigest: digest, purpose: "q".repeat(size),
        approvedDecisions: ["No network"], currentPosition: "Prior result", nextExpectedResult: "Explain only", openReviewIds: ["review-exact"] },
        projection: { currentExecution: { status, sessionPointer: { activeRunId: "run-exact", pendingReview: { runId: "run-exact", wholePlanId: "plan-exact", resultPacketId: "result-exact" } } } } };
      for (const root of [pluginRoot, path.parse(pluginRoot).root + "r".repeat(limit * 2)]) {
        const before = structuredClone(input), text = format(input, root, runtime), value = JSON.parse(text);
        assert.ok(text.length <= limit); assert.equal(value.currentExecution.status, status);
        assert.equal(value.ordinaryWorkBlocked, false); assert.equal(value.persisted, false);
        if (value.currentProjectDirection.contentIncluded === false) assert.equal(value.currentProjectDirection.directionHash, digest);
        else assert.deepEqual(value.currentProjectDirection.input, input.currentProjectDirection.input);
        if (value.sessionRecovery.contentIncluded === false) assert.equal(value.sessionRecovery.checkpointDigest, digest);
        else assert.deepEqual(value.sessionRecovery.openReviewIds, ["review-exact"]);
        assert.deepEqual(input, before);
      }
    }
  });
  test(`${runtime}: public invalid caller diagnostic is finite, read-only and nonblocking`, t => {
    const f = fixture(t), before = snapshot(f.base);
    const output = sessionStartContext({ runtime, event: { hook_event_name: "SessionStart", source: "compact", cwd: f.root, session_id: "x".repeat(513) } });
    const text = output.hookSpecificOutput.additionalContext;
    assert.ok(text.length <= limit);
    const diagnostic = JSON.parse(text);
    assert.equal(diagnostic.status, "host_context_unavailable");
    assert.equal(diagnostic.reasonCode, "INVALID_SESSION_HOST_INPUT");
    assert.equal(diagnostic.sessionSelection, "not-inferred");
    assert.equal(diagnostic.ordinaryWorkBlocked, false); assert.equal(diagnostic.persisted, false);
    assert.equal(typeof diagnostic.coreGuidance, "string");
    assert(diagnostic.coreGuidance.length > 0); assert.deepEqual(snapshot(f.base), before);
  });
  test(`${runtime}: public writer->entry->Hook retains fitting >7000 reason with no extra reads or writes`, t => {
    const f = fixture(t), root = f.save({ summary: "Initial purpose anchor" });
    const reason = "EXACT REASON START " + "이유를 보존한다 Keep provenance 日本語 😀 ".repeat(100) + " EXACT REASON END";
    const judgment = f.save({ judgments: [{ assessment: "Use B", reason, alternatives: ["A loses provenance"] }] });
    const running = f.save({ summary: "Saved running", workLink: link(root), executionObservation: { state: "running" } });
    const recent = f.save({ summary: "Saved result", pending: ["X remains"], unknowns: ["Effect outcome unknown"],
      workLink: link(root, running), executionObservation: { state: "ended", target: exact(running) }, references: [citation(f, judgment)] });
    updateProjectDirection({ root: f.root, input: { goal: "Explain only", cancelledActions: ["deploy", "network"] } });
    const environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: f.operational }, nativeSessionId = "synthetic-delivery-" + runtime;
    const host = createSessionHostAdapter({ runtime, nativeSessionId, environment });
    host.select({ root: f.root, sessionId: f.session.sessionId, expectedRevision: 0 });
    const before = snapshot(f.base), entry = host.enter({ root: f.root });
    const text = sessionStartContext({ runtime, environment, event: { hook_event_name: "SessionStart", source: "compact", cwd: f.root, session_id: nativeSessionId } }).hookSpecificOutput.additionalContext;
    const value = JSON.parse(text); assert.ok(text.length > 7000 && text.length <= limit);
    for (const saved of [root, judgment, recent]) {
      const actual = value.records.find(r => r.evidenceId === saved.evidence.evidenceId), original = entry.workContext.records.find(r => r.evidenceId === saved.evidence.evidenceId);
      assert.ok(actual); assert.deepEqual(actual.content, original.content);
      if (original.savedActivity) assert.deepEqual(actual.savedActivity, original.savedActivity);
    }
    assert.ok(text.includes("X remains")); assert.equal(value.omittedEvidenceCount, 0);
    assert.deepEqual(snapshot(f.base), before); assert.equal(value.ordinaryWorkBlocked, false);
  });
  test(`${runtime}: compact guidance admits a near-limit cited original before optional prose`, t => {
    // Test-only sizing: use actual writer metadata and the actual root width,
    // not a fixed reason length that can miss the defect on shorter CI paths.
    const seed = fixture(t, prosePurpose);
    proseOriginals(seed, "Short synthetic reason");
    const seedEntry = seed.route(() => enterConversationRecovery({ root: seed.root }));
    const f = fixture(t, prosePurpose);
    const compact = JSON.parse(format(seedEntry, f.root, "claude"));
    compact.scope = compactScope;
    compact.hostCapability = "Verified route only; never guess. No extra bind/save/repeated Session ID.";
    compact.expansion = "";
    delete compact.workOrganization;
    compact.workCoverage = { status: seedEntry.workContext.status, omitted: true,
      sourceOriginals: 2, sourceInspected: 2, sourceIncluded: 2 };
    const target = compact.records.find(r => r.content.judgments.length);
    const reasonLength = 10000 - JSON.stringify(compact).length + target.content.judgments[0].reason.length;
    const prefix = "Exact synthetic cited reason: 한국어·日本語 evidence. ";
    assert.ok(reasonLength > prefix.length);
    const reason = prefix + "r".repeat(reasonLength - prefix.length);
    const cp = proseOriginals(f, reason);
    const environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: f.operational }, nativeSessionId = "synthetic-prose-admission-" + runtime;
    const host = createSessionHostAdapter({ runtime, nativeSessionId, environment });
    host.select({ root: f.root, sessionId: f.session.sessionId, expectedRevision: 0 });
    const before = snapshot(f.base), entry = host.enter({ root: f.root });
    const text = sessionStartContext({ runtime, environment, event: { hook_event_name: "SessionStart", source: "resume", cwd: f.root, session_id: nativeSessionId } }).hookSpecificOutput.additionalContext;
    const value = JSON.parse(text); assert.ok(text.length <= limit);
    assert.equal(value.records.length, 2); assert.equal(value.omittedEvidenceCount, 0);
    for (const record of value.records) assert.deepEqual(record.content, entry.workContext.records.find(r => r.evidenceId === record.evidenceId).content);
    assert.equal(value.sessionRecovery.checkpointDigest, cp.checkpointDigest);
    assert.equal(value.sessionRecovery.historicalNextExpectedResult, cp.nextExpectedResult);
    assert.equal(value.sessionPurpose, entry.workContext.sessionPurpose);
    assert.deepEqual(snapshot(f.base), before);
  });
}

test("Codex numeric zero is paired with a finite local complete-output cap and the unchanged handler", () => {
  const doc = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks/codex.json")));
  assert.deepEqual(Object.keys(doc.hooks), ["SessionStart", "UserPromptSubmit", "PreCompact", "Stop", "SubagentStart", "SubagentStop", "SessionEnd"]);
  assert.equal(doc.hooks.SessionStart.length, 1);
  const group = doc.hooks.SessionStart[0], handler = group.hooks[0];
  assert.equal(group.matcher, "startup|resume|clear|compact|fork"); assert.equal(group.hooks.length, 1);
  assert.equal(handler.command, 'node "${PLUGIN_ROOT}/scripts/session-host-hook.mjs" --runtime codex');
  assert.equal(handler.timeout, 10); assert.equal(handler.additionalContextLimit, 0);
  for (const event of ["UserPromptSubmit", "PreCompact", "Stop", "SubagentStart", "SubagentStop", "SessionEnd"]) {
    assert.equal(doc.hooks[event][0].hooks[0].command, 'node "${PLUGIN_ROOT}/scripts/session-host-hook.mjs" --runtime codex --observe-only');
    assert.equal(Object.hasOwn(doc.hooks[event][0].hooks[0], "additionalContextLimit"), false);
  }
  const claude = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks/claude.json")));
  assert.equal(Object.hasOwn(claude.hooks.SessionStart[0].hooks[0], "additionalContextLimit"), false);
  assert.deepEqual(sessionStartContext({ runtime: "opencode", event: {} }), {});
});
