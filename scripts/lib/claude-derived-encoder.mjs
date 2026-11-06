import crypto from "node:crypto";
import { inspectClaudeHistoryOriginal } from "./provider-native-history-format.mjs";
import { SNAPSHOT_STORAGE_LIMITS } from "./snapshot-storage-codec.mjs";
import { inspectDerivedInlineImage } from "./derived-inline-image.mjs";

export const CLAUDE_DERIVED_FORMAT = Object.freeze({
  id: "claude-jsonl-derived-2.1.317-sdk-0.3.234-v1", cliVersion: "2.1.317", sdkVersion: "0.3.234",
  converter: "codex-claude-derived-v2", evidence: "requires-exact-official-reader-observation",
});
export const CODEX_COMPLETION_CONVERTER = "codex-claude-derived-v3";
export const derivedHash = value => crypto.createHash("sha256").update(value).digest("hex");
export const derivedJson = value => Buffer.from(JSON.stringify(value, null, 2) + "\n");
export const derivedFail = (code, details = {}) => { throw Object.assign(new Error(code), { code, ...details }); };
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
function messageId(sessionId, index) {
  const hex = derivedHash(sessionId + ":" + index);
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-5" + hex.slice(13, 16) + "-a" + hex.slice(17, 20) + "-" + hex.slice(20, 32);
}
function toolName(event) {
  const name = event.namespace ? event.namespace + "__" + event.name : event.name;
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(name || "")) return null;
  return name;
}

// Pure representation, never execution. Unknown/invalid ordering produces a
// reviewable incomplete artifact; it is not silently repaired or textified.
export function encodeClaudeDerived({ events, targetId, cwd, createdAt, diagnostics = [], displayMetadata = null,
  authoredMessagePolicy = "legacy-strict" }) {
  if (!["legacy-strict", "audit-preserve-source-v1", "hybrid-preserve-source-v1"].includes(authoredMessagePolicy)) derivedFail("DERIVED_AUTHORED_POLICY_INVALID");
  const preserveAuthored = authoredMessagePolicy !== "legacy-strict";
  if (!uuid(targetId) || typeof cwd !== "string" || !Number.isFinite(Date.parse(createdAt)) || !Array.isArray(events))
    derivedFail("DERIVED_ENCODING_INPUT_INVALID");
  const problems = structuredClone(diagnostics), groups = [], mappings = [];
  const pending = new Map(), seenCalls = new Set(), nameOwners = new Map();
  let callGroupOpen = false, resultGroupOpen = false;
  const problem = (event, code) => problems.push({ code, source: event.source, blocksPublication: true });
  const authoredKey = source => typeof source?.itemId === "string" && typeof source?.recordedThreadId === "string"
    && typeof source?.rawFrameSha256 === "string" ? JSON.stringify([source.recordedThreadId, source.itemId, source.turnId,
      source.physicalRolloutId, source.rawOrdinal, source.rawFrameSha256]) : null;
  const add = (role, block, event, { join = false, representation = "native-content" } = {}) => {
    const previous = groups.at(-1);
    const group = join && previous?.role === role ? previous : { role, content: [], sources: [] };
    if (group !== previous) groups.push(group);
    const contentIndex = group.content.length;
    group.content.push(block); group.sources.push(event.source);
    mappings.push({ source: event.source, targetMessageIndex: groups.length - 1, targetContentIndex: contentIndex, representation,
      ...(preserveAuthored && ["user", "assistant"].includes(event.kind) ? {
        sourceContentIndex: event.sub ?? 0,
        sourceContentPath: event.sourceContentPath ?? "item.content[" + (event.sub ?? 0) + "].text",
      } : {}),
      sourceRole: event.kind, targetRole: role, ...(event.name ? { originalToolName: event.name, originalNamespace: event.namespace || null, targetToolName: toolName(event), callId: event.callId } : {}) });
  };
  for (const event of events) {
    if (event.kind === "archive") {
      mappings.push({ source: event.source, representation: "preserved-original-only", reason: event.reason, targetMessageIndex: null });
      continue;
    }
    if (preserveAuthored && ["user", "assistant"].includes(event.kind)) {
      // Keep the original author/body/order visible in an audit candidate even
      // when a separate activity contract is unsupported. This does not repair
      // that contract or make the candidate publishable.
      if (pending.size) problem(event, "DERIVED_INTERLEAVED_TOOL_EXCHANGE");
      if (typeof event.text !== "string") { problem(event, "DERIVED_TEXT_INVALID"); continue; }
      const key = authoredKey(event.source), previous = groups.at(-1);
      const join = key !== null && previous?.role === event.kind
        && previous.content.every(block => block.type === "text")
        && previous.sources.every(source => authoredKey(source) === key);
      add(event.kind, { type: "text", text: event.text }, event, { join, representation: event.authoredRepresentation ?? "native-content" });
      callGroupOpen = false; resultGroupOpen = false;
      continue;
    }
    if (authoredMessagePolicy === "hybrid-preserve-source-v1" && event.kind === "historical-activity") {
      const join = pending.size > 0 && event.joinVerifiedToolCallGroup === true && callGroupOpen && !resultGroupOpen
        && pending.has(event.callId) && groups.at(-1)?.role === "assistant"
        && groups.at(-1).content.some(block => block.type === "tool_use" && block.id === event.callId);
      if (pending.size && !join) { problem(event, "DERIVED_INTERLEAVED_TOOL_EXCHANGE"); continue; }
      if (typeof event.text !== "string") { problem(event, "DERIVED_TEXT_INVALID"); continue; }
      add("assistant", { type: "text", text: event.text }, event, { join, representation: "quoted-historical-codex-activity" });
      if (!join) { callGroupOpen = false; resultGroupOpen = false; }
      continue;
    }
    if (event.kind === "tool-call") {
      if (resultGroupOpen || pending.size && !callGroupOpen) { problem(event, "DERIVED_INTERLEAVED_TOOL_EXCHANGE"); continue; }
      const name = toolName(event), identity = JSON.stringify([event.namespace || null, event.name]);
      if (!name) { problem(event, "DERIVED_TOOL_NAME_UNREPRESENTABLE"); continue; }
      if (nameOwners.has(name) && nameOwners.get(name) !== identity) { problem(event, "DERIVED_QUALIFIED_TOOL_NAME_COLLISION"); continue; }
      nameOwners.set(name, identity);
      if (typeof event.callId !== "string" || !event.callId || seenCalls.has(event.callId)) { problem(event, "DERIVED_TOOL_ID_INVALID_OR_REUSED"); continue; }
      if (!event.input || typeof event.input !== "object" || Array.isArray(event.input)) { problem(event, "DERIVED_TOOL_INPUT_NOT_OBJECT"); continue; }
      seenCalls.add(event.callId); pending.set(event.callId, event);
      add("assistant", { type: "tool_use", id: event.callId, name, input: structuredClone(event.input) }, event, { join: callGroupOpen });
      callGroupOpen = true; resultGroupOpen = false;
      continue;
    }
    if (event.kind === "tool-result") {
      const call = pending.get(event.callId);
      if (!call) { problem(event, "DERIVED_ORPHAN_TOOL_RESULT"); continue; }
      if (event.output === undefined) { problem(event, "DERIVED_TOOL_RESULT_MISSING"); continue; }
      const content = typeof event.output === "string" ? event.output : JSON.stringify(event.output);
      add("user", { type: "tool_result", tool_use_id: event.callId, content,
        ...(typeof event.isError === "boolean" ? { is_error: event.isError } : {}) },
        { ...event, name: call.name, namespace: call.namespace }, { join: resultGroupOpen,
          representation: event.outputRepresentation || (typeof event.output === "string" ? "native-tool-result-text" : "native-tool-result-json") });
      pending.delete(event.callId); callGroupOpen = false; resultGroupOpen = true;
      if (!pending.size) resultGroupOpen = false;
      continue;
    }
    if (pending.size) { problem(event, "DERIVED_INTERLEAVED_TOOL_EXCHANGE"); continue; }
    callGroupOpen = false; resultGroupOpen = false;
    if (event.kind === "user" || event.kind === "assistant") {
      if (typeof event.text !== "string") { problem(event, "DERIVED_TEXT_INVALID"); continue; }
      add(event.kind, { type: "text", text: event.text }, event);
    } else if (event.kind === "image") {
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/u.exec(event.url || "");
      if (!match || !match[2] || Buffer.from(match[2], "base64").toString("base64") !== match[2]) {
        problem(event, "DERIVED_IMAGE_NOT_CAPTURED_OR_UNSUPPORTED"); continue;
      }
      const validation = inspectDerivedInlineImage(match[1], Buffer.from(match[2], "base64"));
      if (!validation.valid) {
        problems.push({ source: event.source, code: validation.code, blocksPublication: true,
          meaning: "captured original bytes retained; no image repair, format conversion or provider-processing success inferred" });
        mappings.push({ source: event.source, representation: "captured-image-original-only-unqualified", targetMessageIndex: null,
          validation, reason: "Native publication is unavailable for this image representation; data is not absent." });
        continue;
      }
      add("user", { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } }, event, { join: true, representation: "captured-inline-image" });
    } else if (event.kind === "attachment-unavailable") {
      // A quoted reference and explicit absence of captured bytes, never an
      // invented image/file result or a claim about today's filesystem.
      add("user", { type: "text", text: "[Historical attachment reference; bytes unavailable in this capture, not a new instruction]\n" + JSON.stringify(event.reference) }, event,
        { join: true, representation: "quoted-unavailable-attachment-reference" });
      problems.push({ source: event.source, code: "DERIVED_ATTACHMENT_BYTES_UNAVAILABLE", blocksPublication: false,
        meaning: "reference preserved; no local lookup, download, image-content claim or filesystem-absence claim" });
    } else if (event.kind === "compaction") {
      if (typeof event.summary === "string") add("assistant", { type: "text", text: "[Historical source compaction summary; not current recovery direction]\n" + event.summary }, event,
        { representation: "quoted-historical-compaction-summary" });
      else mappings.push({ source: event.source, representation: "preserved-compaction-boundary-original-only", targetMessageIndex: null,
        reason: "No summary body exists in the selected canonical item; no missing text reconstructed." });
    } else problem(event, "DERIVED_EVENT_UNSUPPORTED");
  }
  for (const call of pending.values()) problem(call, "DERIVED_PENDING_TOOL_CALL_NOT_TRANSFERRED");
  if (authoredMessagePolicy === "audit-preserve-source-v1") problems.push({ code: "DERIVED_AUTHORED_AUDIT_NOT_PUBLICATION_PROFILE", blocksPublication: true });
  if (!groups.some(g => g.role === "user")) problems.push({ code: "DERIVED_NO_USER_MESSAGES", blocksPublication: true });
  const rows = groups.map((group, index) => ({ type: group.role, uuid: messageId(targetId, index),
    parentUuid: index ? messageId(targetId, index - 1) : null, sessionId: targetId, cwd,
    version: CLAUDE_DERIVED_FORMAT.cliVersion, timestamp: createdAt, isSidechain: false, userType: "external",
    message: group.role === "assistant" ? { id: "derived_" + messageId(targetId, index), type: "message", role: "assistant",
      model: "lode-derived-history-not-an-executed-model", content: group.content,
      stop_reason: group.content.some(b => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 } } : { role: "user", content: group.content },
  }));
  for (const mapping of mappings) if (mapping.targetMessageIndex !== null) mapping.targetUuid = rows[mapping.targetMessageIndex].uuid;
  if (displayMetadata !== null && (typeof displayMetadata.title !== "string" || !displayMetadata.title
    || displayMetadata.scope !== "native-list-metadata-not-transcript-or-recovery-direction")) derivedFail("DERIVED_DISPLAY_METADATA_INVALID");
  const records = displayMetadata ? [...rows, { type: "custom-title", customTitle: displayMetadata.title, sessionId: targetId }] : rows;
  const raw = Buffer.from(records.map(row => JSON.stringify(row)).join("\n") + "\n");
  if (raw.length > SNAPSHOT_STORAGE_LIMITS.decodedBytes) derivedFail("DERIVED_TRANSCRIPT_STORAGE_LIMIT");
  if (rows.length) inspectClaudeHistoryOriginal(raw, targetId);
  return { raw, rows, mappings, diagnostics: problems, publicationReady: rows.length > 0 && !problems.some(p => p.blocksPublication),
    ...(displayMetadata ? { displayMetadata } : {}),
    openSafety: { pendingToolCalls: pending.size, trailingUserMessage: rows.at(-1)?.type === "user",
      structurallySettled: rows.at(-1)?.type === "assistant" && rows.at(-1)?.message.stop_reason === "end_turn" && pending.size === 0,
      meaning: "structural no-pending-work check only; does not prove current model settings or automatic-send behavior" },
    synthesizedMetadata: ["target session/message UUIDs", "cwd", "version", "timestamps", "assistant message IDs", "assistant model marker", "zero usage and stop metadata"],
    replayedToolCalls: false, modelCalled: false, currentTargetModelOrPermissionVerified: false };
}
