import { isDeepStrictEqual as equal } from "node:util";
import { parseCodexSourceJson } from "./codex-source-json.mjs";
import { resolveCodexPhysicalLineage } from "./codex-physical-lineage.mjs";
import { encodeClaudeDerived, derivedHash as hash, derivedFail as fail } from "./claude-derived-encoder.mjs";

const messageKey = source => JSON.stringify([source.recordedThreadId, source.itemId, source.turnId,
  source.physicalRolloutId, source.rawOrdinal, source.rawFrameSha256]);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const hasValue = value => value !== null && value !== undefined
  && !(Array.isArray(value) && value.length === 0)
  && !(typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
const messageMetadata = new Set(["type", "id", "client_id", "content", "phase", "delivery"]);
// Pinned protocol/items.rs AsyncUserInputQuestion. Unknown fields/variants are
// retained as unrepresented source data, never flattened heuristically.
const knownQuestions = value => value === null || value === undefined || Array.isArray(value) && value.every(question =>
  question && typeof question === "object" && !Array.isArray(question)
  && Object.keys(question).every(key => ["title", "options"].includes(key))
  && typeof question.title === "string"
  && (question.options === null || question.options === undefined
    || Array.isArray(question.options) && question.options.every(option => typeof option === "string")));
const exactFields = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && equal(Object.keys(value).sort(), fields.slice().sort());
const u32 = value => Number.isInteger(value) && value >= 0 && value <= 4294967295;
const knownCitation = value => value === null || value === undefined || exactFields(value, ["entries", "rolloutIds"])
  && Array.isArray(value.entries) && value.entries.every(entry => exactFields(entry, ["path", "lineStart", "lineEnd", "note"])
    && typeof entry.path === "string" && u32(entry.lineStart) && u32(entry.lineEnd) && typeof entry.note === "string")
  && Array.isArray(value.rolloutIds) && value.rolloutIds.every(id => typeof id === "string");
export const historicalCitationText = citation => "[Historical source citation; not verified against the current workspace]\n```json\n"
  + JSON.stringify(citation, null, 2) + "\n```";

// Independent original-frame inventory. This does not trust the semantic
// reader's event count as proof that every authored source message was read.
// Source instructions, activity records and provider summaries are not authored
// user/assistant messages and are never reclassified as one here.
export function readCapturedAuthoredText({ native, check = () => {} }) {
  const proof = resolveCodexPhysicalLineage({ originals: native.originals, rolloutId: native.payload.selectedRolloutId, check });
  if (native.payload.threadIds?.length !== 1 || proof.segments.at(-1)?.threadId !== native.payload.threadIds[0])
    fail("AUTHORED_SOURCE_SELECTION_MISMATCH");
  const originals = new Map(native.originals.map(row => [row.rolloutId, row]));
  const messages = [], events = [], diagnostics = [], unrepresentedSourceFields = [];
  for (const frame of proof.frames) {
    check();
    // Only authored fields are decoded by this auditor. Lossless activity
    // originals are not numeric/semantic inputs to an authored-text proof.
    if (frame.document.type !== "event_msg" || frame.document.payload?.type !== "item_completed"
      || !["UserMessage", "AgentMessage"].includes(frame.document.payload.item?.type)) continue;
    const raw = originals.get(frame.source.rolloutId).raw.subarray(frame.source.startByteOffset, frame.source.endByteOffset - 1);
    const document = parseCodexSourceJson(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    const p = document.payload, item = document.type === "event_msg" && p?.type === "item_completed" ? p.item : null;
    if (!item || !["UserMessage", "AgentMessage"].includes(item.type)) continue;
    if (typeof item.id !== "string" || !item.id || !uuid(p.thread_id) || typeof p.turn_id !== "string" || !p.turn_id
      || p.thread_id !== frame.source.threadId && frame.source.origin !== "copied-inherited-prefix")
      fail("AUTHORED_SOURCE_IDENTITY_UNQUALIFIED");
    const role = item.type === "UserMessage" ? "user" : "assistant";
    const source = { nativeId: frame.source.threadId, physicalRolloutId: frame.source.rolloutId, rawOrdinal: frame.source.ordinal,
      rawFrameSha256: hash(raw), prefixOrigin: frame.source.origin, recordOrigin: "captured-raw-not-canonical-DB-row",
      itemId: item.id, recordedThreadId: p.thread_id, turnId: p.turn_id };
    if (!Array.isArray(item.content)) fail("AUTHORED_SOURCE_CONTENT_UNQUALIFIED");
    const extra = field => {
      const entry = { source, field };
      unrepresentedSourceFields.push(entry);
      diagnostics.push({ code: "AUTHORED_SOURCE_FIELDS_NOT_NATIVE_REPRESENTED", ...entry, blocksPublication: true });
    };
    const questionsRepresented = role === "assistant" && knownQuestions(item.questions);
    const citationRepresented = role === "assistant" && knownCitation(item.memory_citation);
    for (const [field, value] of Object.entries(item)) {
      const representedKnown = field === "questions" && questionsRepresented || field === "memory_citation" && citationRepresented;
      const invalidKnown = ["questions", "memory_citation"].includes(field) && value !== null && value !== undefined && !representedKnown;
      if (invalidKnown || !messageMetadata.has(field) && !representedKnown && hasValue(value)) extra("item." + field);
    }
    const parts = [];
    for (const [index, part] of item.content.entries()) {
      if (part?.type !== (role === "user" ? "text" : "Text") || typeof part.text !== "string") {
        diagnostics.push({ code: "AUTHORED_NON_TEXT_PART_OUTSIDE_AUDIT_SCOPE", source, sourceContentIndex: index, blocksPublication: true });
        continue;
      }
      const sourceContentPath = "item.content[" + index + "].text";
      parts.push({ sourceContentIndex: index, sourceContentPath, text: part.text });
      for (const [field, value] of Object.entries(part))
        if (!["type", "text"].includes(field) && hasValue(value)) extra("item.content[" + index + "]." + field);
      events.push({ kind: role, text: part.text, at: frame.document.ordinal, sub: index, sourceContentPath, source });
    }
    // Render only source-authored strings in the same original assistant
    // message. No active questionnaire, new prompt, button, answer or approval.
    let partIndex = item.content.length;
    const sourceText = (sourceContentPath, text, representation = "native-content") => {
      parts.push({ sourceContentIndex: partIndex, sourceContentPath, text, representation });
      events.push({ kind: role, text, at: frame.document.ordinal, sub: partIndex++, sourceContentPath, source, authoredRepresentation: representation });
    };
    if (questionsRepresented) for (const [questionIndex, question] of (item.questions ?? []).entries()) {
      sourceText("item.questions[" + questionIndex + "].title", question.title);
      for (const [optionIndex, option] of (question.options ?? []).entries())
        sourceText("item.questions[" + questionIndex + "].options[" + optionIndex + "]", option);
    }
    if (citationRepresented && item.memory_citation != null)
      sourceText("item.memory_citation", historicalCitationText(item.memory_citation), "quoted-historical-memory-citation");
    messages.push({ source, role, parts, originalContentPartCount: item.content.length });
  }
  return { messages, events, diagnostics, unrepresentedSourceFields, sourceMessageCount: messages.length,
    sourceBodyTextParts: events.filter(event => event.sourceContentPath.startsWith("item.content[")).length,
    sourceQuestionStrings: events.filter(event => event.sourceContentPath.startsWith("item.questions[")).length,
    sourceCitationRecords: events.filter(event => event.sourceContentPath === "item.memory_citation").length,
    sourceTextPartCount: events.length, allContentPartsAreText: !diagnostics.some(row => row.code === "AUTHORED_NON_TEXT_PART_OUTSIDE_AUDIT_SCOPE"),
    sourceInstructionsReplayed: false, activityCoverageComplete: false, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
}

export function compareAuthoredNativeText({ original, rows, mappings, verifiedNonAuthoredText = [] }) {
  if (!Array.isArray(original?.messages) || !Array.isArray(rows) || !Array.isArray(mappings)) fail("AUTHORED_COVERAGE_INPUT_INVALID");
  const expected = original.messages.flatMap(message => message.parts.map(part => ({ ...part, source: message.source, role: message.role })));
  const actual = mappings.filter(mapping => ["user", "assistant"].includes(mapping.sourceRole));
  const problems = [], messageTargets = new Map(), targetOwners = new Map();
  if (original.messages.some(message => message.parts.length === 0)) problems.push({ code: "AUTHORED_SOURCE_MESSAGE_WITHOUT_TEXT" });
  if (actual.length !== expected.length) problems.push({ code: "AUTHORED_TEXT_PART_COUNT_MISMATCH" });
  let priorMessage = -1, priorPart = -1;
  for (let index = 0; index < Math.max(expected.length, actual.length); index++) {
    const wanted = expected[index], mapping = actual[index];
    if (!wanted || !mapping) { problems.push({ code: "AUTHORED_MAPPING_MISSING_OR_EXTRA", index }); continue; }
    const row = rows[mapping.targetMessageIndex], block = row?.message?.content?.[mapping.targetContentIndex];
    if (!equal(mapping.source, wanted.source) || mapping.sourceContentIndex !== wanted.sourceContentIndex || mapping.sourceContentPath !== wanted.sourceContentPath
      || mapping.sourceRole !== wanted.role || mapping.targetRole !== wanted.role
      || mapping.representation !== (wanted.representation ?? "native-content")
      || row?.type !== wanted.role || row.message?.role !== wanted.role || row.uuid !== mapping.targetUuid
      || block?.type !== "text" || block.text !== wanted.text)
      problems.push({ code: "AUTHORED_BODY_ROLE_SOURCE_MISMATCH", index });
    if (!Number.isSafeInteger(mapping.targetMessageIndex) || !Number.isSafeInteger(mapping.targetContentIndex)
      || mapping.targetMessageIndex < priorMessage || mapping.targetMessageIndex === priorMessage && mapping.targetContentIndex <= priorPart)
      problems.push({ code: "AUTHORED_ORDER_MISMATCH", index });
    priorMessage = mapping.targetMessageIndex; priorPart = mapping.targetContentIndex;
    const key = messageKey(wanted.source), target = mapping.targetMessageIndex;
    if (messageTargets.has(key) && messageTargets.get(key) !== target) problems.push({ code: "AUTHORED_SOURCE_MESSAGE_SPLIT", index });
    if (targetOwners.has(target) && targetOwners.get(target) !== key) problems.push({ code: "AUTHORED_DISTINCT_MESSAGES_MERGED", index });
    messageTargets.set(key, target); targetOwners.set(target, key);
  }
  const mappedBlocks = new Set(actual.map(mapping => mapping.targetMessageIndex + ":" + mapping.targetContentIndex));
  for (const verified of verifiedNonAuthoredText) {
    const block = rows[verified.targetMessageIndex]?.message?.content?.[verified.targetContentIndex];
    if (block?.type !== "text" || block.text !== verified.text) problems.push({ code: "AUTHORED_ACTIVITY_ALLOWANCE_MISMATCH" });
    else mappedBlocks.add(verified.targetMessageIndex + ":" + verified.targetContentIndex);
  }
  for (const [messageIndex, row] of rows.entries()) {
    if (!Array.isArray(row.message?.content)) { problems.push({ code: "AUTHORED_NATIVE_CONTENT_UNQUALIFIED", messageIndex }); continue; }
    for (const [contentIndex, block] of row.message.content.entries())
      if (block.type === "text" && !mappedBlocks.has(messageIndex + ":" + contentIndex))
        problems.push({ code: "AUTHORED_UNMAPPED_NATIVE_TEXT", messageIndex, contentIndex });
  }
  return { kind: "AuthoredNativeTextCoverage", authorityPlane: "P4", sourceMessages: original.sourceMessageCount,
    sourceTextParts: expected.length, mappedTextParts: actual.length, mappedNativeMessages: targetOwners.size,
    sourceBodyTextParts: original.sourceBodyTextParts, sourceQuestionStrings: original.sourceQuestionStrings, sourceCitationRecords: original.sourceCitationRecords,
    exactTextBodyRoleOrder: problems.length === 0 && expected.length > 0,
    completeAuthoredTextCoverage: problems.length === 0 && expected.length > 0 && original.allContentPartsAreText
      && targetOwners.size === original.sourceMessageCount,
    completeAuthoredMessageCoverage: problems.length === 0 && expected.length > 0 && original.allContentPartsAreText
      && targetOwners.size === original.sourceMessageCount && original.unrepresentedSourceFields.length === 0,
    unrepresentedSourceFieldCount: original.unrepresentedSourceFields.length,
    unrepresentedSourceFields: original.unrepresentedSourceFields,
    textCoverageScope: "canonical content.text and pinned question title/options strings verbatim in the same authored message; pinned memory citation fields preserved as explicitly quoted historical JSON without file access; other nonempty fields remain unrepresented",
    allSourceContentPartsAreText: original.allContentPartsAreText,
    activityCoverageComplete: false, semanticSufficiencyClaimed: false,
    problems, nativePublicationAuthorized: false, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
}

// Audit only: a complete human-text check cannot authorize publication of
// unsupported activity or substitute for official SDK/Desktop observations.
export function auditClaudeAuthoredMessages({ native, events, diagnostics, targetId, cwd, createdAt, check }) {
  const original = readCapturedAuthoredText({ native, check });
  const extraEvents = original.events.filter(event => event.sourceContentPath.startsWith("item.questions[") || event.sourceContentPath === "item.memory_citation");
  const combined = [...events, ...extraEvents].sort((a, b) => a.at - b.at || (a.sub ?? 0) - (b.sub ?? 0));
  const encoded = encodeClaudeDerived({ events: combined, diagnostics: [...diagnostics, ...original.diagnostics], targetId, cwd, createdAt,
    authoredMessagePolicy: "audit-preserve-source-v1" });
  const coverage = compareAuthoredNativeText({ original, rows: encoded.rows, mappings: encoded.mappings });
  return { ...encoded, authoredCoverage: coverage, nativePublicationAuthorized: false, nativePublicationAttempted: false,
    auditOnly: true, activityRepresentationSelected: false };
}
