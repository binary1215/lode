import { isDeepStrictEqual as equal } from "node:util";

// Read-only format qualifications, pinned to openai/codex
// f79b26ccbb3116b052544666a181012fb45dc49b. models.rs,
// models/item_metadata.rs, context-fragments/src/fragment.rs,
// core/src/tools/context.rs and memories/read/src/citations.rs.
// Attribution is recorded metadata, never inferred from natural-language text.
const contextualKinds = new Set(["agents_md.instructions", "environments.environment_context", "additional_content.codex_apps_open_page", "goal.internal_context"]);
const contextualProvenance = new Set(["agents_md", "harness", "skills", "developer_instructions"]);
const textParts = content => Array.isArray(content) && content.every(part => ["text", "Text", "input_text", "output_text"].includes(part?.type) && typeof part.text === "string")
  ? content.map(part => part.text) : null;
const ownFields = (object, fields) => object && typeof object === "object" && !Array.isArray(object) && Object.keys(object).every(field => fields.includes(field));

export function recordedContextualUserMessage(payload) {
  const meta = payload.internal_chat_message_metadata_passthrough;
  if (payload.type !== "message" || payload.role !== "user" || !Array.isArray(payload.content) || !payload.content.length || !meta) return false;
  const kinds = meta.content_item_kinds, attribution = meta.content_item_metadata;
  if (attribution !== undefined && attribution !== null) {
    if (!Array.isArray(attribution) || attribution.length !== payload.content.length) return false;
    return attribution.every(entry => ownFields(entry, ["provenance"]) && contextualProvenance.has(entry.provenance?.type)
      && (entry.provenance.type !== "harness" || entry.provenance.hook === false));
  }
  return Array.isArray(kinds) && kinds.length === payload.content.length && kinds.every(kind => contextualKinds.has(kind));
}

function block(text, open, close) {
  const start = text.indexOf(open); if (start < 0) return null;
  const end = text.indexOf(close, start + open.length); return end < 0 ? null : text.slice(start + open.length, end);
}
function citationProjection(text) {
  const open = "<oai-mem-citation>", close = "</oai-mem-citation>";
  let offset = 0, visible = ""; const citations = [];
  for (;;) {
    const start = text.indexOf(open, offset); if (start < 0) { visible += text.slice(offset); break; }
    visible += text.slice(offset, start); const end = text.indexOf(close, start + open.length);
    citations.push(text.slice(start + open.length, end < 0 ? text.length : end));
    if (end < 0) break; offset = end + close.length;
  }
  const entries = [], rolloutIds = [], seen = new Set();
  for (const citation of citations) {
    for (const line of (block(citation, "<citation_entries>", "</citation_entries>") ?? "").split(/\r?\n/u).map(value => value.trim()).filter(Boolean)) {
      const noteAt = line.lastIndexOf("|note=["), location = line.slice(0, noteAt), colon = location.lastIndexOf(":"), range = location.slice(colon + 1).split("-");
      if (noteAt < 0 || !line.endsWith("]") || colon < 0 || range.length !== 2 || range.some(value => !/^\s*\+?\d+\s*$/u.test(value) || Number(value) > 4294967295)) return null;
      entries.push({ path: location.slice(0, colon).trim(), lineStart: Number(range[0]), lineEnd: Number(range[1]), note: line.slice(noteAt + 7, -1).trim() });
    }
    const ids = block(citation, "<rollout_ids>", "</rollout_ids>") ?? block(citation, "<thread_ids>", "</thread_ids>") ?? "";
    for (const id of ids.split(/\r?\n/u).map(value => value.trim()).filter(Boolean)) if (!seen.has(id)) { seen.add(id); rolloutIds.push(id); }
  }
  return { visible, citation: entries.length || rolloutIds.length ? { entries, rolloutIds } : null, count: citations.length };
}

export function exactWireAuthoredProjection(payload, canonical) {
  const wire = textParts(payload.content), original = textParts(canonical.content);
  if (wire === null || original === null) return false;
  if (equal(wire, original)) return true;
  if (payload.role !== "assistant" || original.length !== 1) return false;
  const projection = citationProjection(wire.join(""));
  return projection !== null && projection.count > 0 && projection.visible === original[0] && equal(projection.citation, canonical.memory_citation ?? null);
}

export function canonicalUserBodyKey(item) {
  const text = textParts(item.content); return text === null ? null : JSON.stringify(text);
}

export function knownAgentRoutingRecord(payload) {
  return ownFields(payload, ["type", "id", "author", "recipient", "content", "internal_chat_message_metadata_passthrough"])
    && payload.type === "agent_message" && typeof payload.author === "string" && typeof payload.recipient === "string"
    && Array.isArray(payload.content) && payload.content.every(part => part?.type === "input_text" && typeof part.text === "string"
      || part?.type === "encrypted_content" && typeof part.encrypted_content === "string");
}

function mcpContentProjection(content) {
  if (!Array.isArray(content)) return null;
  const projected = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") {
      if (part._meta?.["codex/encryptedContent"] === true) return null;
      projected.push({ type: "input_text", text: part.text });
    } else if (["image", "audio"].includes(part?.type) && typeof part.data === "string") {
      const url = part.data.startsWith("data:") ? part.data : "data:" + (part.mimeType ?? part.mime_type ?? "application/octet-stream") + ";base64," + part.data;
      if (part.type === "audio") projected.push({ type: "input_audio", audio_url: url });
      else projected.push({ type: "input_image", image_url: url, detail: ["auto", "low", "high", "original"].includes(part._meta?.["codex/imageDetail"]) ? part._meta["codex/imageDetail"] : "high" });
    } else return null;
  }
  return projected;
}

export function exactMcpModelProjection(result, wire) {
  const content = mcpContentProjection(result?.content);
  const header = text => typeof text === "string" && /^Wall time: \d+\.\d{4} seconds\nOutput:$/u.test(text);
  if (result?.structuredContent != null) {
    if (typeof wire !== "string") return false;
    const newline = wire.indexOf("\nOutput:"); if (newline < 0 || !header(wire.slice(0, newline + 8))) return false;
    try { return equal(JSON.parse(wire.slice(newline + 9)), result.structuredContent); } catch { return false; }
  }
  return content !== null && Array.isArray(wire) && (equal(wire, content)
    || wire.length === content.length + 1 && equal(Object.keys(wire[0]).sort(), ["text", "type"]) && wire[0].type === "input_text" && header(wire[0].text) && equal(wire.slice(1), content));
}
