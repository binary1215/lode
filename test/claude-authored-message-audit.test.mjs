import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readCodexCapturedPhysicalEvents } from "../scripts/lib/codex-captured-physical-source.mjs";
import { resolveCodexPhysicalLineage } from "../scripts/lib/codex-physical-lineage.mjs";
import { encodeClaudeDerived, derivedHash as hash } from "../scripts/lib/claude-derived-encoder.mjs";
import { readCapturedAuthoredText, compareAuthoredNativeText, auditClaudeAuthoredMessages } from "../scripts/lib/claude-authored-message-audit.mjs";

import { authoredFixture, id, sibling } from "./helpers/claude-authored-message-fixture.mjs";

const auditFrames = frames => {
  const raw = Buffer.from(frames.map(row => JSON.stringify(row)).join("\n") + "\n"), originals = [{ threadId: id, rolloutId: id, raw, sha256: hash(raw) }];
  const native = { payload: { threadIds: [id], selectedRolloutId: id }, originals, proof: resolveCodexPhysicalLineage({ originals, rolloutId: id }) };
  const read = readCodexCapturedPhysicalEvents({ native, threadId: id });
  return auditClaudeAuthoredMessages({ native, events: read.events, diagnostics: read.diagnostics, targetId: crypto.randomUUID(), cwd: "C:/synthetic", createdAt: "2026-11-06T00:00:00Z" });
};

test("interleaved authored text remains exact native user/assistant messages without merging distinct repeated utterances or clearing activity gates", () => {
  const { native, read } = authoredFixture(), before = hash(native.originals[0].raw), targetId = crypto.randomUUID();
  const args = { events: read.events, diagnostics: read.diagnostics, targetId, cwd: "C:/synthetic", createdAt: "2026-11-06T00:00:00Z" };
  const legacyBefore = encodeClaudeDerived(args), audit = auditClaudeAuthoredMessages({ ...args, native });
  const legacyAfter = encodeClaudeDerived(args);
  assert.ok(legacyBefore.raw.equals(legacyAfter.raw));
  assert.ok(legacyBefore.rows.length < audit.rows.length);
  assert.equal(audit.authoredCoverage.exactTextBodyRoleOrder, true);
  assert.equal(audit.authoredCoverage.completeAuthoredMessageCoverage, true);
  assert.equal(audit.authoredCoverage.sourceMessages, 5); assert.equal(audit.authoredCoverage.mappedNativeMessages, 5);
  assert.equal(audit.authoredCoverage.sourceTextParts, 8);
  assert.deepEqual(audit.rows.filter(row => row.message.content.every(block => block.type === "text")).map(row => row.type), ["user", "assistant", "user", "user", "assistant"]);
  assert.equal(audit.publicationReady, false); assert.equal(audit.nativePublicationAuthorized, false);
  assert.equal(audit.activityRepresentationSelected, false); assert.equal(audit.authoredCoverage.activityCoverageComplete, false);
  assert.ok(audit.diagnostics.some(row => row.code === "PHYSICAL_REPLAY_RECORD_UNQUALIFIED" && row.blocksPublication));
  assert.ok(audit.diagnostics.some(row => row.code === "DERIVED_INTERLEAVED_TOOL_EXCHANGE" && row.blocksPublication));
  assert.ok(audit.diagnostics.some(row => row.code === "DERIVED_AUTHORED_AUDIT_NOT_PUBLICATION_PROFILE" && row.blocksPublication));
  assert.equal(hash(native.originals[0].raw), before);
});

test("independent raw-frame comparison rejects missing, repeated, reordered, rewritten or relabelled native authored text", () => {
  const { native, read } = authoredFixture(), original = readCapturedAuthoredText({ native });
  const audit = auditClaudeAuthoredMessages({ native, events: read.events, diagnostics: read.diagnostics, targetId: crypto.randomUUID(), cwd: "C:/synthetic", createdAt: "2026-11-06T00:00:00Z" });
  const check = (rows, mappings) => compareAuthoredNativeText({ original, rows, mappings });
  for (const mutate of [
    value => value.mappings.splice(value.mappings.findIndex(row => row.sourceRole === "user"), 1),
    value => value.mappings.push(structuredClone(value.mappings.find(row => row.sourceRole === "user"))),
    value => value.mappings.reverse(),
    value => { value.rows[0].message.content[0].text += " changed"; },
    value => { value.rows[0].type = "assistant"; value.rows[0].message.role = "assistant"; },
    value => { value.mappings[0].sourceContentIndex = 99; },
    value => { value.mappings[0].sourceContentPath = "item.questions[0].title"; },
    value => { value.rows[0].message.content.push({ type: "text", text: "invented agent activity" }); },
  ]) {
    const value = structuredClone({ rows: audit.rows, mappings: audit.mappings }); mutate(value);
    assert.equal(check(value.rows, value.mappings).exactTextBodyRoleOrder, false);
  }
  const dropped = auditClaudeAuthoredMessages({ native, events: read.events.filter(event => event.source?.itemId !== "u-2"), diagnostics: read.diagnostics,
    targetId: crypto.randomUUID(), cwd: "C:/synthetic", createdAt: "2026-11-06T00:00:00Z" });
  assert.equal(dropped.authoredCoverage.exactTextBodyRoleOrder, false);
});

test("source identity and unqualified non-text content are never repaired, textified or counted as complete authored content", () => {
  const f = authoredFixture(), changed = structuredClone(f.rows);
  changed[2].payload.thread_id = sibling;
  const native = rows => { const raw = Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n"); return { payload: { threadIds: [id], selectedRolloutId: id }, originals: [{ threadId: id, rolloutId: id, raw, sha256: hash(raw) }] }; };
  assert.throws(() => readCapturedAuthoredText({ native: native(changed) }), { code: "AUTHORED_SOURCE_IDENTITY_UNQUALIFIED" });
  changed[2].payload.thread_id = id; changed[2].payload.item.content.push({ type: "unknown-content", value: "SYNTHETIC original" });
  const read = readCapturedAuthoredText({ native: native(changed) });
  assert.equal(read.allContentPartsAreText, false); assert.ok(read.diagnostics.every(row => row.blocksPublication));
  const encoded = encodeClaudeDerived({ events: read.events, diagnostics: read.diagnostics, targetId: crypto.randomUUID(), cwd: "C:/synthetic", createdAt: "2026-11-06T00:00:00Z", authoredMessagePolicy: "audit-preserve-source-v1" });
  assert.equal(compareAuthoredNativeText({ original: read, rows: encoded.rows, mappings: encoded.mappings }).completeAuthoredMessageCoverage, false);
  assert.equal(read.events.some(event => event.text.includes("unknown-content")), false);
  assert.throws(() => encodeClaudeDerived({ events: [], targetId: crypto.randomUUID(), cwd: "C:/synthetic", createdAt: "2026-11-06T00:00:00Z", authoredMessagePolicy: "publish-anyway" }), { code: "DERIVED_AUTHORED_POLICY_INVALID" });
});

test("matching all text cannot conceal unrepresented structured questions, citations or additional content fields", () => {
  const f = authoredFixture(), frames = structuredClone(f.rows), item = frames[4].payload.item;
  item.questions = [{ id: "q1", question: "SYNTHETIC source question", options: [{ label: "SYNTHETIC option" }] }];
  item.memory_citation = { entries: ["SYNTHETIC original citation"] };
  item.content[0].unqualifiedAnnotation = { synthetic: true };
  const raw = Buffer.from(frames.map(row => JSON.stringify(row)).join("\n") + "\n"), before = hash(raw);
  const native = { payload: { threadIds: [id], selectedRolloutId: id }, originals: [{ threadId: id, rolloutId: id, raw, sha256: hash(raw) }] };
  const original = readCapturedAuthoredText({ native });
  const encoded = encodeClaudeDerived({ events: original.events, diagnostics: original.diagnostics, targetId: crypto.randomUUID(), cwd: "C:/synthetic",
    createdAt: "2026-11-06T00:00:00Z", authoredMessagePolicy: "audit-preserve-source-v1" });
  const result = compareAuthoredNativeText({ original, rows: encoded.rows, mappings: encoded.mappings });
  assert.equal(result.exactTextBodyRoleOrder, true); assert.equal(result.completeAuthoredTextCoverage, true);
  assert.equal(result.completeAuthoredMessageCoverage, false); assert.equal(result.unrepresentedSourceFieldCount, 3);
  assert.ok(original.diagnostics.every(row => row.blocksPublication)); assert.equal(encoded.publicationReady, false);
  assert.equal(encoded.raw.includes(Buffer.from("SYNTHETIC source question")), false);
  assert.equal(hash(raw), before);
});

test("qualified question and option strings stay inside the original assistant message with exact source paths and no active question or fabricated answer", () => {
  const { native, read } = authoredFixture({ structuredQuestions: true });
  const audit = auditClaudeAuthoredMessages({ native, events: read.events, diagnostics: read.diagnostics, targetId: crypto.randomUUID(), cwd: "C:/synthetic", createdAt: "2026-11-06T00:00:00Z" });
  assert.equal(audit.authoredCoverage.completeAuthoredMessageCoverage, true);
  assert.equal(audit.authoredCoverage.sourceMessages, 5); assert.equal(audit.authoredCoverage.mappedNativeMessages, 5);
  assert.equal(audit.authoredCoverage.sourceTextParts, 11);
  const mappings = audit.mappings.filter(mapping => mapping.source?.itemId === "a-1");
  assert.equal(new Set(mappings.map(mapping => mapping.targetUuid)).size, 1);
  assert.deepEqual(mappings.map(mapping => mapping.sourceContentPath), ["item.content[0].text", "item.content[1].text", "item.questions[0].title", "item.questions[0].options[0]", "item.questions[0].options[1]"]);
  assert.deepEqual(audit.rows[mappings[0].targetMessageIndex].message.content.map(block => block.text), ["실행 중 관측입니다.", "성공으로 해석하지 않습니다.", "SYNTHETIC 원래 질문을 확인할까요?", "기존 방향 유지", "배포 취소 유지"]);
  assert.equal(audit.rows.some(row => Object.hasOwn(row, "questions")), false);
  assert.equal(audit.publicationReady, false); assert.equal(audit.activityRepresentationSelected, false);
});

test("question-only, null or empty options, repeated original utterances and equal body/title strings retain their own source fields", () => {
  const rows = authoredFixture().rows;
  rows[4].payload.item.content = [];
  rows[4].payload.item.questions = [{ title: "SYNTHETIC null options", options: null }, { title: "SYNTHETIC empty options", options: [] }];
  const only = auditFrames(rows), mapped = only.mappings.filter(mapping => mapping.source?.itemId === "a-1");
  assert.equal(only.authoredCoverage.completeAuthoredMessageCoverage, true); assert.equal(only.authoredCoverage.sourceMessages, 5);
  assert.equal(new Set(mapped.map(mapping => mapping.targetUuid)).size, 1);
  assert.deepEqual(only.rows[mapped[0].targetMessageIndex].message.content.map(block => block.text), ["SYNTHETIC null options", "SYNTHETIC empty options"]);
  const first = rows[4].payload.item;
  first.content = [{ type: "Text", text: "SYNTHETIC repeated question" }];
  first.questions = [{ title: "SYNTHETIC repeated question", options: ["SYNTHETIC same option"] }];
  rows[8].payload.item.content = structuredClone(first.content); rows[8].payload.item.questions = structuredClone(first.questions);
  const repeated = auditFrames(rows), firstMappings = repeated.mappings.filter(mapping => mapping.source?.itemId === "a-1"), secondMappings = repeated.mappings.filter(mapping => mapping.source?.itemId === "a-2");
  assert.equal(repeated.authoredCoverage.completeAuthoredMessageCoverage, true);
  assert.notEqual(firstMappings[0].targetUuid, secondMappings[0].targetUuid);
  assert.deepEqual(repeated.rows[firstMappings[0].targetMessageIndex].message.content.map(block => block.text), ["SYNTHETIC repeated question", "SYNTHETIC repeated question", "SYNTHETIC same option"]);
  assert.deepEqual(firstMappings.map(mapping => mapping.sourceContentPath), ["item.content[0].text", "item.questions[0].title", "item.questions[0].options[0]"]);
});

test("unknown or non-string question data never becomes invented assistant text or complete authored coverage", () => {
  for (const questions of [[{ title: 7, options: [] }], [{ title: "SYNTHETIC title", options: [7] }], [{ title: "SYNTHETIC title", options: [], unqualified: "SYNTHETIC extra" }], { title: "SYNTHETIC wrong container" }]) {
    const rows = authoredFixture().rows; rows[4].payload.item.questions = questions;
    const audit = auditFrames(rows);
    assert.equal(audit.authoredCoverage.completeAuthoredMessageCoverage, false);
    assert.ok(audit.authoredCoverage.unrepresentedSourceFields.some(field => field.field === "item.questions"));
    assert.equal(audit.mappings.some(mapping => mapping.sourceContentPath?.startsWith("item.questions[")), false);
    assert.equal(audit.publicationReady, false);
  }
});

test("known historical citations preserve every field in the same assistant message without reading paths or granting current source authority", () => {
  const f = authoredFixture({ memoryCitation: true }), citation = f.rows[4].payload.item.memory_citation;
  citation.entries[0].lineStart = 0; citation.entries[0].lineEnd = 4294967295;
  citation.entries[0].path = "https://invalid.example/not-fetched?citation=historical";
  citation.entries.push({ path: "C:/synthetic-unavailable/never-read.md", lineStart: 10, lineEnd: 2, note: "SYNTHETIC recorded range, no present-day validation" });
  citation.rolloutIds.push(sibling);
  const audit = auditFrames(f.rows), mappings = audit.mappings.filter(mapping => mapping.source?.itemId === "a-1"), reference = mappings.find(mapping => mapping.sourceContentPath === "item.memory_citation");
  assert.equal(audit.authoredCoverage.completeAuthoredMessageCoverage, true); assert.equal(audit.authoredCoverage.sourceCitationRecords, 1);
  assert.equal(reference.representation, "quoted-historical-memory-citation"); assert.equal(new Set(mappings.map(mapping => mapping.targetUuid)).size, 1);
  const text = audit.rows[reference.targetMessageIndex].message.content[reference.targetContentIndex].text;
  assert.ok(text.startsWith("[Historical source citation; not verified against the current workspace]"));
  assert.deepEqual(JSON.parse(text.slice(text.indexOf("```json\n") + 8, -4)), citation);
  assert.equal(audit.authoredCoverage.grantsRecoveryAuthority, false); assert.equal(audit.authoredCoverage.restoresExecutionPermission, false);
  assert.equal(audit.publicationReady, false);
  for (const changed of [
    { ...citation, unqualified: "SYNTHETIC unsupported field" },
    { ...citation, entries: [{ ...citation.entries[0], lineStart: -1 }] },
    { ...citation, entries: [{ ...citation.entries[0], lineEnd: 4294967296 }] },
    { ...citation, entries: [{ ...citation.entries[0], path: 7 }] },
    { ...citation, entries: [{ ...citation.entries[0], note: 7 }] },
    { ...citation, rolloutIds: [7] },
  ]) {
    const rows = authoredFixture().rows; rows[4].payload.item.memory_citation = changed;
    const unsupported = auditFrames(rows);
    assert.equal(unsupported.authoredCoverage.completeAuthoredMessageCoverage, false);
    assert.ok(unsupported.authoredCoverage.unrepresentedSourceFields.some(field => field.field === "item.memory_citation"));
    assert.equal(unsupported.mappings.some(mapping => mapping.sourceContentPath === "item.memory_citation"), false);
  }
});

test("invalid empty known fields remain blocking while null and schema-valid empty values retain their distinct meaning", () => {
  for (const [field, value] of [["questions", {}], ["memory_citation", {}], ["memory_citation", []]]) {
    const rows = authoredFixture().rows; rows[4].payload.item[field] = value;
    const audit = auditFrames(rows);
    assert.equal(audit.authoredCoverage.exactTextBodyRoleOrder, true);
    assert.equal(audit.authoredCoverage.completeAuthoredMessageCoverage, false);
    assert.equal(audit.authoredCoverage.unrepresentedSourceFieldCount, 1);
    assert.ok(audit.diagnostics.some(row => row.code === "AUTHORED_SOURCE_FIELDS_NOT_NATIVE_REPRESENTED" && row.field === "item." + field && row.blocksPublication));
  }
  for (const [field, value] of [["questions", null], ["questions", []], ["memory_citation", null], ["memory_citation", { entries: [], rolloutIds: [] }]]) {
    const rows = authoredFixture().rows; rows[4].payload.item[field] = value;
    const audit = auditFrames(rows);
    assert.equal(audit.authoredCoverage.completeAuthoredMessageCoverage, true);
    assert.equal(audit.authoredCoverage.unrepresentedSourceFieldCount, 0);
    assert.equal(audit.publicationReady, false);
    assert.equal(audit.authoredCoverage.sourceCitationRecords, field === "memory_citation" && value !== null ? 1 : 0);
  }
});
