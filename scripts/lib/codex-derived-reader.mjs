import { decodeSqliteCell } from "./native-sqlite-values.mjs";
import { isDeepStrictEqual } from "node:util";
import { nativeObject } from "./provider-native-history-host.mjs";
import { derivedFail, derivedHash, CLAUDE_DERIVED_FORMAT, CODEX_COMPLETION_CONVERTER } from "./claude-derived-encoder.mjs";
import { parseCodexSourceJson } from "./codex-source-json.mjs";

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
function tableRows(payload, name, threadId) {
  const table = payload.history.tables.find(t => t.name === name);
  if (!table) derivedFail("DERIVED_CODEX_TABLE_MISSING");
  return table.rows.map(row => Object.fromEntries(table.columns.map((key, i) => [key, decodeSqliteCell(row[i])]))).filter(row => row.thread_id === threadId);
}
function ordinal(value) {
  if (typeof value !== "bigint" || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) derivedFail("DERIVED_CODEX_ORDINAL_INVALID");
  return Number(value);
}
function parse(value, code) {
  try { return parseCodexSourceJson(value); }
  catch (error) { if (error.code === "CODEX_SOURCE_NUMERIC_PRECISION_UNQUALIFIED") throw error; derivedFail(code); }
}
function comparableOutput(wire, canonical) {
  if (isDeepStrictEqual(wire, canonical)) return true;
  if (typeof wire !== "string" || typeof canonical === "string") return false;
  try { return isDeepStrictEqual(parseCodexSourceJson(wire), canonical); }
  catch (error) { if (error.code === "CODEX_SOURCE_NUMERIC_PRECISION_UNQUALIFIED") throw error; return false; }
}

// Consume the selected verified capture only, never a live source DB or path
// found inside a message. Provider envelopes are not added as human messages.
export function readCodexDerivedEvents({ native, threadId, cutoffItemId = null, signal, check = () => {} }) {
  if (!native?.payload?.threadIds?.includes(threadId)) derivedFail("DERIVED_EXACT_SOURCE_THREAD_REQUIRED");
  const entries = native.payload.files.filter(row => row.threadId === threadId);
  if (entries.length !== 1) derivedFail("DERIVED_EXACT_SOURCE_THREAD_REQUIRED");
  const entry = entries[0], diagnostics = [], events = [], inventory = [], representedCalls = new Map();
  const addProblem = (source, code, blocksPublication = true, detail = null) => diagnostics.push({ source, code, blocksPublication, ...(detail ? { detail } : {}) });
  const ref = (item, row, table = "thread_items", part = null) => ({ table, nativeId: threadId,
    itemId: row.item_id, turnId: row.turn_id || null, ordinal: String(row.rollout_ordinal),
    updatedOrdinal: row.updated_at_ordinal === undefined ? null : String(row.updated_at_ordinal),
    itemSha256: derivedHash(Buffer.from(row.item_json)), itemType: item.type, ...(part !== null ? { part } : {}) });
  const rows = tableRows(native.payload, "thread_items", threadId);
  const turns = tableRows(native.payload, "thread_turns", threadId);
  const turnBounds = new Map(turns.map(row => [row.turn_id, row]));
  const cut = cutoffItemId === null ? null : rows.find(row => row.item_id === cutoffItemId);
  if (cutoffItemId !== null && !cut) derivedFail("DERIVED_CUTOFF_ITEM_NOT_FOUND");
  const projection = tableRows(native.payload, "thread_history_projection_state", threadId);
  if (projection.length !== 1) derivedFail("DERIVED_CODEX_CUTOFF_INVALID");
  const lastOrdinal = ordinal(projection[0].next_rollout_ordinal) - 1;
  const cutoffOrdinal = cut ? ordinal(cut.updated_at_ordinal) : lastOrdinal;
  if (cutoffOrdinal > lastOrdinal) derivedFail("DERIVED_CODEX_CUTOFF_INVALID");
  const add = (event, at, sub = 0) => { const added = { ...event, at, sub }; events.push(added); return added; };
  const raw = nativeObject(native, entry, signal, check);
  let frames = [], frameOriginals = [], needsV3 = false;
  const frameTextByOrdinal = new Map(), frameByOrdinal = new Map();
  if (entry.path.endsWith(".zst")) addProblem({ nativeId: threadId }, "DERIVED_COMPRESSED_SOURCE_UNQUALIFIED");
  else {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    if (!text.endsWith("\n")) derivedFail("DERIVED_CODEX_INCOMPLETE_SOURCE");
    frameOriginals = text.slice(0, -1).split("\n");
    frames = frameOriginals.map(line => parse(line, "DERIVED_CODEX_FRAME_INVALID"));
    frames.forEach((frame, index) => { frameTextByOrdinal.set(frame.ordinal, frameOriginals[index]); frameByOrdinal.set(frame.ordinal, frame); });
    needsV3 = frames.some((frame, index) => JSON.stringify(frame) !== frameOriginals[index]);
  }
  const covered = native.coverage.find(row => row.threadId === threadId);
  if (!covered || covered.rawFormat !== "verified" || covered.parentClosure !== "declared-selected-or-none" || covered.unresolvedClosure?.length)
    addProblem({ nativeId: threadId }, "DERIVED_SOURCE_CLOSURE_UNRESOLVED", true, covered || null);
  // Existing capture closure verification is reused. A selected ancestor does
  // not establish where a fork cut it; never merge its other turns by recency.
  for (const frame of frames) if (frame.ordinal <= cutoffOrdinal && frame.type === "session_meta"
    && ["forked_from_id", "forked_from", "history_base", "history_base_path"].some(key => frame.payload?.[key] != null))
    addProblem({ nativeId: threadId, rawOrdinal: frame.ordinal }, "DERIVED_BRANCH_CUTOFF_UNRESOLVED");
  for (const row of rows) {
    check();
    const at = ordinal(row.rollout_ordinal), end = ordinal(row.updated_at_ordinal);
    const item = parse(row.item_json, "DERIVED_CODEX_ITEM_INVALID");
    if (!object(item) || item.id !== row.item_id || item.type !== row.item_type || end < at)
      derivedFail("DERIVED_CODEX_CANONICAL_IDENTITY_MISMATCH");
    const source = ref(item, row);
    if (at > cutoffOrdinal) { inventory.push({ source, disposition: "after-selected-cutoff" }); continue; }
    if (end > cutoffOrdinal) { addProblem(source, "DERIVED_ITEM_UPDATED_AFTER_CUTOFF"); inventory.push({ source, disposition: "pending-at-cutoff-not-expanded" }); continue; }
    inventory.push({ source, disposition: "selected" });
    if (item.type === "userMessage") {
      if (!Array.isArray(item.content)) { addProblem(source, "DERIVED_USER_CONTENT_INVALID"); continue; }
      for (const [index, part] of item.content.entries()) {
        const location = ref(item, row, "thread_items", index);
        if (["text", "inputText"].includes(part?.type) && typeof part.text === "string")
          add({ kind: "user", text: part.text, source: location }, at, index);
        else if (part?.type === "image" && typeof part.url === "string" && part.url.startsWith("data:"))
          add({ kind: "image", url: part.url, source: location }, at, index);
        else if (["image", "localImage", "file", "attachment"].includes(part?.type))
          add({ kind: "attachment-unavailable", reference: structuredClone(part), source: location }, at, index);
        else addProblem(location, "DERIVED_USER_INPUT_UNSUPPORTED");
      }
    } else if (["agentMessage", "plan"].includes(item.type)) {
      if (typeof item.text !== "string" || item.type === "agentMessage" && item.phase !== undefined
        && !["commentary", "partial_answer", "final_answer", "final"].includes(item.phase)) { addProblem(source, "DERIVED_ASSISTANT_CONTENT_UNSUPPORTED"); continue; }
      add({ kind: "assistant", text: item.text, source }, at);
    } else if (["mcpToolCall", "dynamicToolCall"].includes(item.type)) {
      if (!["completed", "failed"].includes(item.status)) { addProblem(source, "DERIVED_PENDING_TOOL_NOT_TRANSFERRED"); continue; }
      const callId = item.id, name = item.tool, namespace = item.type === "mcpToolCall" ? item.server : null;
      const input = typeof item.arguments === "string" ? parse(item.arguments, "DERIVED_TOOL_ARGUMENTS_INVALID") : item.arguments;
      const hasResult = item.type === "mcpToolCall" ? own(item, "result") && item.result !== null : own(item, "contentItems") && item.contentItems !== null;
      const hasError = own(item, "error") && item.error !== null;
      if (!hasResult && !hasError) { addProblem(source, "DERIVED_COMPLETED_TOOL_RESULT_MISSING"); continue; }
      const result = item.type === "mcpToolCall" ? item.result : item.contentItems;
      const output = hasResult && hasError ? { result, error: item.error } : hasError ? item.error : result;
      const isError = item.status === "failed" || hasError || item.success === false;
      const outputRepresentation = hasResult && hasError ? "canonical-result-and-error-json-envelope" : null;
      const call = { kind: "tool-call", callId, name, namespace, input, source };
      const callEvent = add(call, at, 0);
      const completion = add({ kind: "tool-result", callId, output, isError, outputRepresentation, source: { ...source, edge: "completion" } }, end, 1);
      if (representedCalls.has(callId)) {
        representedCalls.get(callId).ambiguous = true;
        addProblem(source, "DERIVED_CANONICAL_TOOL_ID_AMBIGUOUS");
      } else representedCalls.set(callId, { call: callEvent, completion, output, isError, at, end,
        turn: turnBounds.get(row.turn_id), wireKinds: new Set() });
    } else if (item.type === "contextCompaction") {
      const frame = frameByOrdinal.get(at);
      const summary = typeof item.summary === "string" ? item.summary
        : frame?.type === "compacted" && typeof frame.payload?.message === "string" ? frame.payload.message : undefined;
      add({ kind: "compaction", summary, source }, at);
    } else if (["reasoning", "system", "developer"].includes(item.type)) {
      add({ kind: "archive", reason: "private-reasoning-or-source-instruction-not-replayed", source }, at);
    } else addProblem(source, item.type === "functionCallOutput" ? "DERIVED_STANDALONE_TOOL_OUTPUT_HAS_NO_CALL" : "DERIVED_CANONICAL_ITEM_UNSUPPORTED");
  }
  // Preserve genuine wire-level tool identities where a canonical tool view
  // does not already represent them. Never import provider user wrappers.
  for (const frame of frames) {
    if (frame.ordinal > cutoffOrdinal) continue;
    const p = frame.payload, source = { nativeId: threadId, rawOrdinal: frame.ordinal, rawFrameSha256: derivedHash(frameTextByOrdinal.get(frame.ordinal)), itemType: p?.type || frame.type };
    if (frame.type === "response_item" && ["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(p?.type)) {
      if (representedCalls.has(p.call_id)) {
        const represented = representedCalls.get(p.call_id);
        const withinTurn = represented.turn && frame.ordinal >= ordinal(represented.turn.rollout_ordinal)
          && frame.ordinal <= (represented.turn.rollout_end_ordinal === null ? cutoffOrdinal : ordinal(represented.turn.rollout_end_ordinal));
        const same = withinTurn && !represented.ambiguous && !represented.wireKinds.has(p.type) && (p.type === "function_call"
          ? frame.ordinal <= represented.at && p.name === represented.call.name && (p.namespace || null) === represented.call.namespace
            && isDeepStrictEqual(typeof p.arguments === "string" ? parse(p.arguments, "DERIVED_TOOL_ARGUMENTS_INVALID") : p.arguments, represented.call.input)
          : p.type === "function_call_output" && frame.ordinal <= represented.end
            && (!own(p, "is_error") || typeof p.is_error === "boolean" && p.is_error === represented.isError)
            && comparableOutput(p.output, represented.output));
        represented.wireKinds.add(p.type);
        if (!same) addProblem(source, "DERIVED_CANONICAL_WIRE_TOOL_DIVERGENCE");
        if (same && p.type === "function_call") represented.wireStart = frame.ordinal;
        if (same && p.type === "function_call_output") represented.wireEnd = frame.ordinal;
        if (frame.ordinal !== (p.type === "function_call" ? represented.at : represented.end)) needsV3 = true;
        inventory.push({ source, disposition: same ? "verified-provider-view-of-selected-canonical-tool" : "divergent-provider-tool-original-preserved", callId: p.call_id });
        continue;
      }
      if (p.type === "function_call") {
        needsV3 = true;
        const input = typeof p.arguments === "string" ? parse(p.arguments, "DERIVED_TOOL_ARGUMENTS_INVALID") : p.arguments;
        add({ kind: "tool-call", callId: p.call_id, name: p.name, namespace: p.namespace || null, input, source }, frame.ordinal);
      } else if (p.type === "function_call_output") {
        needsV3 = true;
        const recorded = own(p, "is_error") && typeof p.is_error === "boolean";
        if (own(p, "is_error") && !recorded) addProblem(source, "DERIVED_WIRE_TOOL_ERROR_FLAG_INVALID");
        if (!own(p, "is_error")) addProblem(source, "DERIVED_WIRE_TOOL_OUTCOME_UNRECORDED", false);
        add({ kind: "tool-result", callId: p.call_id, output: p.output, isError: recorded ? p.is_error : null,
          source: { ...source, errorFlagEvidence: recorded ? "wire-explicit" : "not-recorded" } }, frame.ordinal);
      } else addProblem(source, "DERIVED_CUSTOM_TOOL_WIRE_FORMAT_UNSUPPORTED");
    } else if (frame.type === "response_item") inventory.push({ source, disposition: "provider-envelope-not-reimported-as-human" });
    else if (frame.type === "compacted" && !events.some(e => e.at === frame.ordinal && e.kind === "compaction")) {
      if (typeof p?.message === "string") add({ kind: "compaction", summary: p.message, source }, frame.ordinal);
      else addProblem(source, "DERIVED_COMPACTION_BODY_UNSUPPORTED");
    }
  }
  for (const represented of representedCalls.values()) {
    if (represented.ambiguous || represented.wireStart === undefined) continue;
    if (represented.wireEnd !== undefined && represented.wireEnd < represented.wireStart) {
      addProblem(represented.call.source, "DERIVED_WIRE_TOOL_ORDER_INVALID"); continue;
    }
    represented.call.at = represented.wireStart;
    if (represented.wireEnd !== undefined) represented.completion.at = represented.wireEnd;
  }
  for (const row of tableRows(native.payload, "thread_realtime_items", threadId))
    if (ordinal(row.rollout_ordinal) <= cutoffOrdinal) addProblem({ table: "thread_realtime_items", itemId: row.item_id }, "DERIVED_REALTIME_ITEM_UNSUPPORTED");
  events.sort((a, b) => a.at - b.at || a.sub - b.sub);
  for (let i = 1; i < events.length; i++) if (events[i].at === events[i - 1].at && events[i].sub === events[i - 1].sub
    && events[i].source.itemId !== events[i - 1].source.itemId) addProblem(events[i].source, "DERIVED_SOURCE_ORDER_AMBIGUOUS");
  const sourceTurns = turns.filter(row => ordinal(row.rollout_ordinal) <= cutoffOrdinal);
  const sourceLifecycle = { observedTurnStatuses: sourceTurns.map(row => ({ turnId: row.turn_id, status: row.status })),
    terminalAtCapture: sourceTurns.length > 0 && sourceTurns.every(row => ["completed", "interrupted", "failed"].includes(row.status)),
    meaning: "captured source turn status, not current target execution or recovered direction" };
  return { events: events.map(({ at, sub, ...event }) => ({ ...event, sourceOrder: { ordinal: at, part: sub } })), diagnostics, inventory, sourceLifecycle,
    converter: needsV3 ? CODEX_COMPLETION_CONVERTER : CLAUDE_DERIVED_FORMAT.converter,
    sourceSelection: { threadId, cutoffItemId, cutoffOrdinal, rawCapturedCutoffOrdinal: lastOrdinal, rawFileSha256: entry.sha256 },
    originalUnchanged: true, readsOutsideCapture: false, semanticSufficiencyClaimed: false };
}
