import { isDeepStrictEqual as equal } from "node:util";
import { parseCodexSourceJson } from "./codex-source-json.mjs";
import { resolveCodexPhysicalLineage } from "./codex-physical-lineage.mjs";
import { encodeClaudeDerived, derivedHash as hash, derivedFail as fail } from "./claude-derived-encoder.mjs";
import { exactWireLocalImageProjection, localImageProjectionIndexKey } from "./codex-hybrid-projections.mjs";

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
export const historicalImageReferenceText = reference => "[Historical canonical image reference; captured wire image is represented separately. No current file access or file-byte equivalence is claimed.]\n```json\n"
  + JSON.stringify(reference, null, 2) + "\n```";

// Independent original-frame inventory. This does not trust the semantic
// reader's event count as proof that every authored source message was read.
// Source instructions, activity records and provider summaries are not authored
// user/assistant messages and are never reclassified as one here.
export function readCapturedAuthoredText({ native, check = () => {}, representationProfile = "text-v1" }) {
  if (!["text-v1", "captured-local-images-v1"].includes(representationProfile)) fail("AUTHORED_REPRESENTATION_PROFILE_UNQUALIFIED");
  const richImages = representationProfile === "captured-local-images-v1";
  const proof = resolveCodexPhysicalLineage({ originals: native.originals, rolloutId: native.payload.selectedRolloutId, check });
  if (native.payload.threadIds?.length !== 1 || proof.segments.at(-1)?.threadId !== native.payload.threadIds[0])
    fail("AUTHORED_SOURCE_SELECTION_MISMATCH");
  const originals = new Map(native.originals.map(row => [row.rolloutId, row]));
  const messages = [], events = [], diagnostics = [], unrepresentedSourceFields = [];
  const wireImageBindings = [], userWireCandidates = new Map(); let sourceImageParts = 0;
  const turnKey = (owner, turn, indexKey) => JSON.stringify([owner, turn, indexKey]);
  for (const [frameIndex, frame] of proof.frames.entries()) {
    check();
    if (richImages && frame.document.type === "response_item" && frame.document.payload?.type === "message"
      && frame.document.payload.role === "user") {
      const turn = frame.document.payload.internal_chat_message_metadata_passthrough?.turn_id;
      const indexKey = localImageProjectionIndexKey(frame.document.payload.content);
      if (typeof turn === "string" && indexKey !== null) {
        const key = turnKey(frame.source.threadId, turn, indexKey);
        if (!userWireCandidates.has(key)) userWireCandidates.set(key, []);
        userWireCandidates.get(key).push(frame);
      }
    }
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
    let imageBinding = null;
    if (richImages && role === "user" && item.content.some(part => part?.type === "local_image")) {
      const previous = proof.frames[frameIndex - 1];
      if (previous && previous.source.rolloutId === frame.source.rolloutId && previous.source.threadId === frame.source.threadId
        && previous.source.ordinal + 1 === frame.source.ordinal && previous.source.endByteOffset === frame.source.startByteOffset
        && previous.document.type === "response_item") {
        const projection = exactWireLocalImageProjection(previous.document.payload, item, p.turn_id);
        if (projection) {
          const wireRaw = originals.get(previous.source.rolloutId).raw.subarray(previous.source.startByteOffset, previous.source.endByteOffset - 1);
          const wireSource = { nativeId: previous.source.threadId, physicalRolloutId: previous.source.rolloutId,
            rawOrdinal: previous.source.ordinal, rawFrameSha256: hash(wireRaw), startByteOffset: previous.source.startByteOffset,
            endByteOffset: previous.source.endByteOffset, originalObjectSha256: originals.get(previous.source.rolloutId).sha256 };
          imageBinding = { canonicalSource: source, wireSource, projection, turnId: p.turn_id,
            wireMessageId: previous.document.payload.id, unique: false, evidence: [] };
          Object.defineProperty(imageBinding, "previous", { value: previous });
          Object.defineProperty(imageBinding, "canonicalFrame", { value: frame });
          wireImageBindings.push(imageBinding);
        }
      }
    }
    for (const [index, part] of item.content.entries()) {
      const image = imageBinding?.projection.images.find(value => value.canonicalPartIndex === index);
      if (image) {
        sourceImageParts++;
        const readReference = () => frame.document.payload.item.content[index];
        const readUrl = () => imageBinding.previous.document.payload.content[image.wireImageIndex].image_url;
        const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]*={0,2})$/u.exec(readUrl());
        if (!match || !match[2] || Buffer.from(match[2], "base64").toString("base64") !== match[2])
          fail("AUTHORED_IMAGE_ENCODING_UNQUALIFIED");
        const evidence = { profile: imageBinding.projection.profile, canonicalSource: source, canonicalContentIndex: index,
          canonicalReferenceSha256: hash(JSON.stringify(part)), wireSource: imageBinding.wireSource,
          wireMessageId: imageBinding.wireMessageId, wireContentIndex: image.wireImageIndex,
          wireImageUrlSha256: hash(readUrl()), capturedImageSha256: hash(Buffer.from(match[2], "base64")), mediaType: match[1],
          capturedBytes: Buffer.from(match[2], "base64").length, wrapperOrdinal: image.wrapperOrdinal,
          exactWrapperPathAndOrder: true, uniqueSourceAssociation: false, currentFileByteEquivalenceClaimed: false };
        imageBinding.evidence.push(evidence);
        const referencePath = "item.content[" + index + "]";
        parts.push({ sourceContentIndex: index, sourceContentPath: referencePath,
          representation: "quoted-canonical-image-reference", get text() { return historicalImageReferenceText(readReference()); } });
        events.push({ kind: "user", get text() { return historicalImageReferenceText(readReference()); }, at: frame.source.ordinal,
          sub: index, sourceContentPath: referencePath, source, authoredRepresentation: "quoted-canonical-image-reference" });
        const imagePath = "wire.content[" + image.wireImageIndex + "].image_url";
        parts.push({ sourceContentIndex: index, sourceContentPath: imagePath, contentKind: "image", imageEvidence: evidence,
          representation: "captured-wire-image", get url() { return readUrl(); } });
        events.push({ kind: "user", contentKind: "image", get url() { return readUrl(); }, at: frame.source.ordinal, sub: index,
          sourceContentPath: imagePath, source, imageEvidence: evidence, authoredRepresentation: "captured-wire-image" });
        continue;
      }
      if (part?.type !== (role === "user" ? "text" : "Text") || typeof part.text !== "string") {
        diagnostics.push({ code: "AUTHORED_NON_TEXT_PART_OUTSIDE_AUDIT_SCOPE", source, sourceContentIndex: index, blocksPublication: true });
        continue;
      }
      const sourceContentPath = "item.content[" + index + "].text";
      const text = () => frame.document.payload.item.content[index].text;
      parts.push({ sourceContentIndex: index, sourceContentPath, get text() { return text(); } });
      for (const [field, value] of Object.entries(part))
        if (!["type", "text"].includes(field) && hasValue(value)) extra("item.content[" + index + "]." + field);
      events.push({ kind: role, get text() { return text(); }, at: frame.source.ordinal, sub: index, sourceContentPath, source });
    }
    // Render only source-authored strings in the same original assistant
    // message. No active questionnaire, new prompt, button, answer or approval.
    let partIndex = item.content.length;
    const sourceText = (sourceContentPath, readText, representation = "native-content") => {
      parts.push({ sourceContentIndex: partIndex, sourceContentPath, get text() { return readText(); }, representation });
      events.push({ kind: role, get text() { return readText(); }, at: frame.source.ordinal, sub: partIndex++, sourceContentPath, source, authoredRepresentation: representation });
    };
    if (questionsRepresented) for (const [questionIndex, question] of (item.questions ?? []).entries()) {
      sourceText("item.questions[" + questionIndex + "].title", () => frame.document.payload.item.questions[questionIndex].title);
      for (const [optionIndex, option] of (question.options ?? []).entries())
        sourceText("item.questions[" + questionIndex + "].options[" + optionIndex + "]", () => frame.document.payload.item.questions[questionIndex].options[optionIndex]);
    }
    if (citationRepresented && item.memory_citation != null)
      sourceText("item.memory_citation", () => historicalCitationText(frame.document.payload.item.memory_citation), "quoted-historical-memory-citation");
    messages.push({ source, role, parts, originalContentPartCount: item.content.length });
  }
  const wireKey = source => JSON.stringify([source.physicalRolloutId, source.rawOrdinal, source.rawFrameSha256]);
  const bindingCounts = new Map();
  for (const binding of wireImageBindings) bindingCounts.set(wireKey(binding.wireSource), (bindingCounts.get(wireKey(binding.wireSource)) ?? 0) + 1);
  if (richImages) for (const binding of wireImageBindings) {
    const canonical = binding.canonicalFrame.document.payload.item;
    const candidates = userWireCandidates.get(turnKey(binding.wireSource.nativeId, binding.turnId,
      localImageProjectionIndexKey(canonical.content, true))) ?? [];
    let exactMatches = 0;
    for (const candidate of candidates) {
      if (exactWireLocalImageProjection(candidate.document.payload, canonical, binding.turnId)) exactMatches++;
      if (exactMatches > 1) break;
    }
    binding.unique = exactMatches === 1
      && bindingCounts.get(wireKey(binding.wireSource)) === 1;
    for (const evidence of binding.evidence) evidence.uniqueSourceAssociation = binding.unique;
    if (!binding.unique) diagnostics.push({ code: "AUTHORED_IMAGE_WIRE_ASSOCIATION_AMBIGUOUS", source: binding.canonicalSource, blocksPublication: true });
  }
  return { messages, events, diagnostics, unrepresentedSourceFields, sourceMessageCount: messages.length,
    sourceBodyTextParts: events.filter(event => event.sourceContentPath.startsWith("item.content[")
      && event.authoredRepresentation !== "quoted-canonical-image-reference").length,
    sourceQuestionStrings: events.filter(event => event.sourceContentPath.startsWith("item.questions[")).length,
    sourceCitationRecords: events.filter(event => event.sourceContentPath === "item.memory_citation").length,
    sourceTextPartCount: events.filter(event => event.contentKind !== "image" && event.authoredRepresentation !== "quoted-canonical-image-reference").length,
    allContentPartsAreText: sourceImageParts === 0 && !diagnostics.some(row => row.code === "AUTHORED_NON_TEXT_PART_OUTSIDE_AUDIT_SCOPE"),
    ...(richImages ? { representationProfile, wireImageBindings, sourceImageParts,
      allContentPartsHaveSupportedRepresentation: !diagnostics.some(row => row.blocksPublication) } : {}),
    sourceInstructionsReplayed: false, activityCoverageComplete: false, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
}

export function compareAuthoredNativeText({ original, rows, mappings, verifiedNonAuthoredText = [] }) {
  if (!Array.isArray(original?.messages) || !Array.isArray(rows) || !Array.isArray(mappings)) fail("AUTHORED_COVERAGE_INPUT_INVALID");
  const expected = original.messages.flatMap(message => message.parts.map(part => ({ sourceContentIndex: part.sourceContentIndex,
    sourceContentPath: part.sourceContentPath, representation: part.representation, contentKind: part.contentKind,
    imageEvidence: part.imageEvidence, get text() { return part.text; }, get url() { return part.url; }, source: message.source, role: message.role })));
  const actual = mappings.filter(mapping => ["user", "assistant"].includes(mapping.sourceRole));
  const problems = [], messageTargets = new Map(), targetOwners = new Map();
  if (original.messages.some(message => message.parts.length === 0)) problems.push({ code: "AUTHORED_SOURCE_MESSAGE_WITHOUT_TEXT" });
  if (actual.length !== expected.length) problems.push({ code: "AUTHORED_TEXT_PART_COUNT_MISMATCH" });
  let priorMessage = -1, priorPart = -1;
  for (let index = 0; index < Math.max(expected.length, actual.length); index++) {
    const wanted = expected[index], mapping = actual[index];
    if (!wanted || !mapping) { problems.push({ code: "AUTHORED_MAPPING_MISSING_OR_EXTRA", index }); continue; }
    const row = rows[mapping.targetMessageIndex], block = row?.message?.content?.[mapping.targetContentIndex];
    const bodyMatches = wanted.contentKind === "image" ? block?.type === "image" && block.source?.type === "base64"
      && "data:" + block.source.media_type + ";base64," + block.source.data === wanted.url
      && equal(mapping.capturedImageEvidence, wanted.imageEvidence) && wanted.imageEvidence?.uniqueSourceAssociation === true
      : block?.type === "text" && block.text === wanted.text;
    if (!equal(mapping.source, wanted.source) || mapping.sourceContentIndex !== wanted.sourceContentIndex || mapping.sourceContentPath !== wanted.sourceContentPath
      || mapping.sourceRole !== wanted.role || mapping.targetRole !== wanted.role
      || mapping.representation !== (wanted.representation ?? "native-content")
      || row?.type !== wanted.role || row.message?.role !== wanted.role || row.uuid !== mapping.targetUuid
      || !bodyMatches)
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
      if ((block.type === "text" || original.representationProfile === "captured-local-images-v1" && block.type === "image")
        && !mappedBlocks.has(messageIndex + ":" + contentIndex))
        problems.push({ code: "AUTHORED_UNMAPPED_NATIVE_TEXT", messageIndex, contentIndex });
  }
  const supportedParts = original.allContentPartsAreText || original.representationProfile === "captured-local-images-v1"
    && original.allContentPartsHaveSupportedRepresentation && original.wireImageBindings.every(binding => binding.unique);
  const isSourceText = part => part.contentKind !== "image" && part.representation !== "quoted-canonical-image-reference";
  return { kind: "AuthoredNativeTextCoverage", authorityPlane: "P4", sourceMessages: original.sourceMessageCount,
    sourceTextParts: expected.filter(isSourceText).length,
    mappedTextParts: actual.filter(part => part.representation !== "captured-wire-image" && part.representation !== "quoted-canonical-image-reference").length,
    mappedNativeMessages: targetOwners.size,
    sourceBodyTextParts: original.sourceBodyTextParts, sourceQuestionStrings: original.sourceQuestionStrings, sourceCitationRecords: original.sourceCitationRecords,
    exactTextBodyRoleOrder: problems.length === 0 && expected.length > 0,
    completeAuthoredTextCoverage: problems.length === 0 && expected.length > 0 && supportedParts
      && targetOwners.size === original.sourceMessageCount,
    completeAuthoredMessageCoverage: problems.length === 0 && expected.length > 0 && supportedParts
      && targetOwners.size === original.sourceMessageCount && original.unrepresentedSourceFields.length === 0,
    unrepresentedSourceFieldCount: original.unrepresentedSourceFields.length,
    unrepresentedSourceFields: original.unrepresentedSourceFields,
    textCoverageScope: original.representationProfile === "captured-local-images-v1"
      ? "canonical text and supported metadata verbatim; canonical local-image references explicitly quoted, with exact uniquely associated captured wire image bytes in the same user message; no file lookup or current file-byte equivalence"
      : "canonical content.text and pinned question title/options strings verbatim in the same authored message; pinned memory citation fields preserved as explicitly quoted historical JSON without file access; other nonempty fields remain unrepresented",
    allSourceContentPartsAreText: original.allContentPartsAreText,
    ...(original.representationProfile === "captured-local-images-v1" ? { representationProfile: original.representationProfile,
      sourceImageParts: original.sourceImageParts, mappedImageParts: actual.filter(part => part.representation === "captured-wire-image").length,
      imageSourceAssociations: original.wireImageBindings.map(binding => ({ canonicalSource: binding.canonicalSource,
        wireSource: binding.wireSource, unique: binding.unique, evidence: binding.evidence })),
      imageByteTransportVerified: original.sourceImageParts > 0 && problems.length === 0 && supportedParts,
      providerImageProcessingVerified: false, currentFileByteEquivalenceClaimed: false } : {}),
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
