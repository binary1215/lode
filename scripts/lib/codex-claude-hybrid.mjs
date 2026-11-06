import { isDeepStrictEqual as equal } from "node:util";
import { resolveCodexPhysicalLineage } from "./codex-physical-lineage.mjs";
import { CODEX_PHYSICAL_CONVERTER, CODEX_PHYSICAL_TITLE_CONVERTER, readCodexCapturedPhysicalEvents } from "./codex-captured-physical-source.mjs";
import { readCapturedAuthoredText, compareAuthoredNativeText } from "./claude-authored-message-audit.mjs";
import { encodeClaudeDerived, derivedHash as hash, derivedFail as fail } from "./claude-derived-encoder.mjs";
import { parseCodexSourceJson } from "./codex-source-json.mjs";
import { recordedContextualUserMessage, exactWireAuthoredProjection, canonicalUserBodyKey, knownAgentRoutingRecord, exactMcpModelProjection } from "./codex-hybrid-projections.mjs";

export const CODEX_HYBRID_CONVERTER = "codex-claude-physical-hybrid-v2";
export const CODEX_HYBRID_PRIOR_CONVERTER = "codex-claude-physical-hybrid-v1";
export const CODEX_HYBRID_PROFILES = [CODEX_HYBRID_CONVERTER, CODEX_HYBRID_PRIOR_CONVERTER];
const privateItems = new Set(["Reasoning", "SystemMessage", "DeveloperMessage"]);
const activities = new Set(["CommandExecution", "FileChange", "McpToolCall", "FunctionCallOutput", "SubAgentActivity", "Extension", "ImageView", "CollabAgentToolCall", "ContextCompaction", "Plan", "WebSearch", "ImageGeneration"]);
const telemetryEvents = new Set(["token_count", "rate_limits", "token_usage"]);
const providerEvents = new Set(["thread_settings_applied", "thread_goal_updated"]);
const boundaryEvents = new Set(["task_started", "task_complete", "task_aborted", "turn_aborted"]);
const providerResponses = new Set(["additional_tools", "configuration_update"]);
const worldFields = new Set(["agents_md", "apps_instructions", "base_instructions", "cloud_skills", "tools", "collaboration_mode", "context_window_guidance", "environments", "environments_instructions", "git_attribution", "host_skills", "managed_developer_instructions", "model", "model_catalog", "multi_agent_mode", "multi_agent_usage_hint", "permissions", "persistent_mode", "plugins_instructions", "realtime", "skills", "top_level_tools"]);
const turnFields = new Set(["turn_id", "root_turn_id", "disabled_plugin_ids", "cwd", "workspace_roots", "current_date", "timezone", "approval_policy", "approvals_reviewer", "sandbox_policy", "permission_profile", "active_permission_profile", "file_system_sandbox_policy", "model", "comp_hash", "personality", "collaboration_mode", "multi_agent_version", "realtime_active", "cyber_access_program", "effort", "summary"]);
const wireCalls = new Set(["function_call", "custom_tool_call"]), wireResults = new Set(["function_call_output", "custom_tool_call_output"]);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const key = source => source.physicalRolloutId + ":" + source.rawOrdinal + ":" + source.rawFrameSha256;
const toolName = event => event.namespace ? event.namespace + "__" + event.name : event.name;
const instructionFields = new Set(["instructions", "base_instructions", "user_instructions", "developer_instructions", "system_message", "skills", "approval_policy", "sandbox_policy", "permissions", "tools", "mcp_servers"]);
const contentFields = new Set(["text", "content", "message", "messages", "user_message", "agent_message", "input"]);

function fieldInventory(value, path = "payload", result = []) {
  if (value && typeof value === "object") {
    for (const [field, child] of Object.entries(value)) {
      const sourcePath = path + "." + field;
      result.push({ path: sourcePath, type: Array.isArray(child) ? "array" : child === null ? "null" : typeof child,
        disposition: instructionFields.has(field) ? "source-instruction-or-configuration-original-only"
          : contentFields.has(field) ? "provider-envelope-content-original-only; not treated as a canonical authored message"
          : "provider-data-original-only; semantic authority not inferred" });
      fieldInventory(child, sourcePath, result);
    }
  }
  return result;
}

function classification(document) {
  const p = document.payload;
  if (document.type === "session_meta" || document.type === "turn_context" || document.type === "world_state") return "provider-envelope-original-only";
  if (document.type === "token_usage_record") return "telemetry-original-only";
  if (document.type === "response_item" && p?.type === "reasoning") return "private-original-only";
  if (document.type === "response_item" && p?.type === "agent_message" && knownAgentRoutingRecord(p))
    return p.content.some(part => part.type === "encrypted_content") ? "private-original-only" : "historical-activity";
  if (document.type === "response_item" && p?.type === "message" && recordedContextualUserMessage(p)) return "provider-envelope-original-only";
  if (document.type === "response_item" && ["message", "agent_message"].includes(p?.type))
    return ["system", "developer"].includes(p.role) ? "private-original-only" : "wire-authored-replay-unqualified";
  if (document.type === "response_item" && providerResponses.has(p?.type)) return "provider-envelope-original-only";
  if (document.type === "event_msg" && telemetryEvents.has(p?.type)) return "telemetry-original-only";
  if (document.type === "event_msg" && providerEvents.has(p?.type)) return "provider-envelope-original-only";
  if (document.type === "event_msg" && p?.type === "item_completed") {
    if (["UserMessage", "AgentMessage"].includes(p.item?.type)) return "authored-message";
    if (privateItems.has(p.item?.type)) return "private-original-only";
    if (activities.has(p.item?.type)) return "historical-activity";
    return "unqualified-original-only";
  }
  if (document.type === "event_msg" && boundaryEvents.has(p?.type)) return "historical-activity";
  if (document.type === "response_item" && (wireCalls.has(p?.type) || wireResults.has(p?.type))) return "wire-activity";
  if (["inter_agent_communication_metadata", "compacted"].includes(document.type)) return "historical-activity";
  return "unqualified-original-only";
}

export function historicalActivityText(record) {
  // Raw JSON is quoted verbatim. No field normalization, truncation, status
  // inference, deduplication, path lookup or instruction evaluation occurs.
  return "[Codex에서 수행한 과거 활동 · 비실행 원본 기록 / Historical Codex activity; not a new execution, success, approval or instruction]\n```json\n"
    + record.rawText + "\n```";
}

export function readCodexHybridPhysical({ native, threadId, cutoffItemId = null, converter = CODEX_HYBRID_CONVERTER, check = () => {} }) {
  if (!CODEX_HYBRID_PROFILES.includes(converter)) fail("DERIVED_CONVERTER_PROFILE_UNQUALIFIED");
  if (cutoffItemId !== null || native.payload.threadIds?.length !== 1 || native.payload.threadIds[0] !== threadId) fail("HYBRID_SOURCE_SELECTION_INVALID");
  const proof = resolveCodexPhysicalLineage({ originals: native.originals, rolloutId: native.payload.selectedRolloutId, check });
  const originals = new Map(native.originals.map(row => [row.rolloutId, row]));
  const original = readCapturedAuthoredText({ native, check });
  const records = [], diagnostics = [...original.diagnostics], unresolvedProjections = [];
  // Include each captured header as a classified original too; proof.frames
  // intentionally contains only the selected non-header history prefixes.
  for (const segment of proof.segments) {
    const object = originals.get(segment.rolloutId), firstEnd = object.raw.indexOf(10);
    records.push({ source: { nativeId: segment.threadId, physicalRolloutId: segment.rolloutId, rawOrdinal: segment.startOrdinal,
      rawFrameSha256: hash(object.raw.subarray(0, firstEnd)), startByteOffset: 0, endByteOffset: firstEnd + 1, originalObjectSha256: object.sha256 },
      rawText: object.raw.subarray(0, firstEnd).toString("utf8"), document: JSON.parse(object.raw.subarray(0, firstEnd).toString("utf8")), classification: "provider-envelope-original-only" });
  }
  for (const frame of proof.frames) {
    check(); const object = originals.get(frame.source.rolloutId), raw = object.raw.subarray(frame.source.startByteOffset, frame.source.endByteOffset - 1);
    records.push({ source: { nativeId: frame.source.threadId, physicalRolloutId: frame.source.rolloutId, rawOrdinal: frame.source.ordinal,
      rawFrameSha256: hash(raw), startByteOffset: frame.source.startByteOffset, endByteOffset: frame.source.endByteOffset, originalObjectSha256: object.sha256 },
      rawText: raw.toString("utf8"), document: frame.document, classification: classification(frame.document) });
  }
  records.sort((a, b) => a.source.rawOrdinal - b.source.rawOrdinal);
  const unique = new Set();
  const canonicalAuthored = new Map(), inheritedFrames = new Set(proof.frames.filter(frame => frame.source.origin === "copied-inherited-prefix").map(frame => frame.source.rolloutId + ":" + frame.source.ordinal));
  const callsById = new Map(), resultsById = new Map(), usersByTurnBody = new Map();
  const indexRecord = (index, id, record) => { if (!index.has(id)) index.set(id, []); index.get(id).push(record); };
  const replayTargets = new Set(), previousUserReplay = new Map();
  for (const record of records) {
    const p = record.document.payload;
    if (record.classification === "authored-message") indexRecord(canonicalAuthored, JSON.stringify([p.item.id, p.item.type === "UserMessage" ? "user" : "assistant"]), record);
    if (record.classification === "authored-message" && p.item.type === "UserMessage" && canonicalUserBodyKey(p.item) !== null)
      indexRecord(usersByTurnBody, JSON.stringify([record.source.nativeId, p.turn_id, canonicalUserBodyKey(p.item)]), record);
    if (record.classification === "wire-activity") {
      if (wireCalls.has(p?.type)) indexRecord(callsById, p.call_id, record);
      if (wireResults.has(p?.type)) indexRecord(resultsById, p.call_id, record);
    }
  }
  for (const record of records) {
    if (unique.has(key(record.source))) fail("HYBRID_DUPLICATE_SOURCE_RECORD"); unique.add(key(record.source));
    const p = record.document.payload;
    if (record.document.type === "event_msg" && p?.type === "item_completed"
      && (!uuid(p.thread_id) || p.thread_id !== record.source.nativeId && !inheritedFrames.has(record.source.physicalRolloutId + ":" + record.source.rawOrdinal)))
      fail("PHYSICAL_ITEM_NATIVE_IDENTITY_MISMATCH");
    if (record.document.type === "response_item" && p?.type === "message" && !["system", "developer"].includes(p.role)) {
      const metadata = p.internal_chat_message_metadata_passthrough;
      const fields = ["type", "encrypted_content", "status", "id", "role", "content", "phase", "internal_chat_message_metadata_passthrough"];
      const metaFields = ["turn_id", "create_time", "content_item_kinds", "content_item_metadata", "cell_id", "executed_tool_calls", "tool_calls_complete"];
      if (Object.keys(p).some(field => !fields.includes(field)) || metadata && Object.keys(metadata).some(field => !metaFields.includes(field))
        || !Array.isArray(p.content) || p.content.some(part => !part || Object.keys(part).some(field => !["type", "text", "annotations", "logprobs", "image_url", "file_id", "detail", "audio_url"].includes(field))))
        diagnostics.push({ code: "HYBRID_WIRE_MESSAGE_FIELDS_UNQUALIFIED", source: record.source, blocksPublication: true });
    }
    if (record.classification === "wire-authored-replay-unqualified") {
      const role = p.role ?? (p.type === "agent_message" ? "assistant" : null);
      let matching = canonicalAuthored.get(JSON.stringify([p.id, role])) ?? [];
      const metadataTurn = p.internal_chat_message_metadata_passthrough?.turn_id;
      if (role === "user" && typeof metadataTurn === "string" && metadataTurn && canonicalUserBodyKey(p) !== null)
        matching = usersByTurnBody.get(JSON.stringify([record.source.nativeId, metadataTurn, canonicalUserBodyKey(p)])) ?? [];
      const target = matching.length === 1 ? matching[0] : null;
      const priorUser = previousUserReplay.get(record.source.nativeId) ?? -1;
      if (typeof p.id === "string" && target && exactWireAuthoredProjection(p, target.document.payload.item)
        && !replayTargets.has(key(target.source)) && (role !== "user" || target.source.rawOrdinal > priorUser)) {
        record.classification = "corroborated-provider-replay-original-only";
        record.corroborationSource = target.source;
        replayTargets.add(key(target.source));
        if (role === "user") previousUserReplay.set(record.source.nativeId, target.source.rawOrdinal);
      } else diagnostics.push({ code: "HYBRID_WIRE_AUTHORED_REPLAY_UNCORROBORATED", source: record.source, blocksPublication: true });
    }
    if (record.document.type === "world_state") {
      const invalid = !p || typeof p.full !== "boolean" || !p.state || typeof p.state !== "object" || Array.isArray(p.state)
        || Object.keys(p).some(field => !["full", "state"].includes(field)) || Object.keys(p.state).some(field => !worldFields.has(field));
      if (invalid) diagnostics.push({ code: "HYBRID_PROVIDER_STATE_FIELDS_UNQUALIFIED", source: record.source, blocksPublication: true });
    }
    if (record.document.type === "turn_context" && Object.keys(p ?? {}).some(field => !turnFields.has(field)))
      diagnostics.push({ code: "HYBRID_PROVIDER_CONTEXT_FIELDS_UNQUALIFIED", source: record.source, blocksPublication: true });
    if (record.document.type === "event_msg" && p?.type === "thread_settings_applied") {
      if (!uuid(p.thread_id) || p.thread_id !== record.source.nativeId && !inheritedFrames.has(record.source.physicalRolloutId + ":" + record.source.rawOrdinal)) fail("PHYSICAL_ITEM_NATIVE_IDENTITY_MISMATCH");
      const settingsFields = ["model", "model_provider_id", "service_tier", "approval_policy", "approvals_reviewer", "permission_profile", "active_permission_profile", "cwd", "runtime_workspace_roots", "reasoning_effort", "reasoning_summary", "personality", "collaboration_mode", "disabled_plugin_ids"];
      if (Object.keys(p).some(field => !["type", "thread_id", "thread_settings"].includes(field)) || !p.thread_settings || Array.isArray(p.thread_settings)
        || typeof p.thread_settings !== "object" || Object.keys(p.thread_settings).some(field => !settingsFields.includes(field)))
        diagnostics.push({ code: "HYBRID_PROVIDER_SETTINGS_FIELDS_UNQUALIFIED", source: record.source, blocksPublication: true });
    }
    if (record.document.type === "response_item" && providerResponses.has(p?.type)) {
      const allowed = p.type === "configuration_update" ? ["type", "reasoning"] : ["type", "id", "role", "tools"];
      if (Object.keys(p).some(field => !allowed.includes(field)) || p.type === "additional_tools" && (p.role !== "developer" || !Array.isArray(p.tools)))
        diagnostics.push({ code: "HYBRID_PROVIDER_RESPONSE_FIELDS_UNQUALIFIED", source: record.source, blocksPublication: true });
    }
    if (record.classification === "unqualified-original-only") diagnostics.push({ code: "HYBRID_RECORD_CLASS_UNQUALIFIED", source: record.source, blocksPublication: true });
  }
  let strict;
  try { strict = readCodexCapturedPhysicalEvents({ native, threadId, check, converter: converter === CODEX_HYBRID_PRIOR_CONVERTER ? CODEX_PHYSICAL_TITLE_CONVERTER : CODEX_PHYSICAL_CONVERTER }); }
  catch (error) {
    if (error.code !== "CODEX_SOURCE_NUMERIC_PRECISION_UNQUALIFIED") throw error;
    strict = { events: [], diagnostics: [], sourceLifecycle: { terminalAtCapture: false, lastTurnStatus: "unknown" } };
    diagnostics.push({ code: "HYBRID_NATIVE_NUMERIC_REPRESENTATION_UNQUALIFIED_RAW_PRESERVED", blocksPublication: false });
  }
  const strictEvents = new Map(), canonicalById = new Map(), turns = new Map();
  let activeTurn = null;
  for (const record of records) {
    const p = record.document.payload;
    if (record.document.type === "event_msg" && p?.type === "task_started") activeTurn = activeTurn === null && typeof p.turn_id === "string" && p.turn_id ? { id: p.turn_id, nativeId: record.source.nativeId } : null;
    turns.set(key(record.source), activeTurn);
    if (record.document.type === "event_msg" && ["task_complete", "task_aborted", "turn_aborted"].includes(p?.type)) activeTurn = null;
    if (record.document.type === "event_msg" && p?.type === "item_completed" && p.item?.type === "McpToolCall") {
      if (!canonicalById.has(p.item.id)) canonicalById.set(p.item.id, []); canonicalById.get(p.item.id).push(record);
    }
  }
  const canonicalEvidence = new Map();
  for (const record of records.filter(record => record.classification === "wire-activity" && wireCalls.has(record.document.payload?.type))) {
    const p = record.document.payload, results = resultsById.get(p.call_id) ?? [];
    let input; try { input = p.type === "function_call" ? typeof p.arguments === "string" ? parseCodexSourceJson(p.arguments) : p.arguments : { input: p.input }; }
    catch (error) { if (error.code !== "CODEX_SOURCE_NUMERIC_PRECISION_UNQUALIFIED" && !(error instanceof SyntaxError)) throw error; continue; }
    const call = { kind: "tool-call", callId: p.call_id, name: p.name, namespace: p.namespace ?? null, input, source: record.source };
    strictEvents.set(key(record.source), [call]);
    if (results.length !== 1 || typeof p.call_id !== "string" || !p.call_id) continue;
    if (callsById.get(p.call_id)?.length !== 1) continue;
    const result = results[0], r = result.document.payload;
    if (!Object.hasOwn(r, "output")) continue;
    if (r.type !== (p.type === "function_call" ? "function_call_output" : "custom_tool_call_output")) continue;
    let isError = typeof r.is_error === "boolean" ? r.is_error : null;
    const canonical = canonicalById.get(p.call_id) ?? [];
    if (canonical.length > 1) continue;
    if (canonical.length === 1) {
      if (canonical[0].source.nativeId !== record.source.nativeId) continue;
      const item = canonical[0].document.payload.item;
      if (item.result && Object.hasOwn(item.result, "isError") && typeof item.result.isError !== "boolean") continue;
      const namespaceExact = item.tool === p.name && (item.server === (p.namespace ?? null) || p.namespace === "mcp__" + item.server)
        || p.namespace == null && p.name === "mcp__" + item.server + "__" + item.tool;
      let wire = r.output; try { if (typeof wire === "string") wire = parseCodexSourceJson(wire); } catch (error) { if (error.code === "CODEX_SOURCE_NUMERIC_PRECISION_UNQUALIFIED") continue; }
      const expected = item.result != null && item.error != null ? { result: item.result, error: item.error } : item.error ?? item.result;
      const fullResultExact = equal(wire, expected);
      const contentProjectionExact = item.error == null && item.result && Array.isArray(item.result.content) && equal(wire, item.result.content);
      const modelProjectionExact = item.error == null && exactMcpModelProjection(item.result, wire);
      const inputExact = equal(item.arguments, input), knownError = item.status === "failed" || item.error != null || item.result?.isError === true;
      if (!namespaceExact || !inputExact || isError !== null && isError !== knownError)
        fail("PHYSICAL_CANONICAL_WIRE_DIVERGENCE", { hybridConflictSources: [record.source, result.source, canonical[0].source] });
      if (!fullResultExact && !contentProjectionExact && !modelProjectionExact) {
        // The pinned emitter independently truncates/normalizes event and
        // model-facing results. An output difference is not proof of corrupt
        // originals. Keep both exact records visible, but qualify no native
        // tool pair, equivalence, truncation cause or execution success.
        const difference = { callSource: record.source, wireResultSource: result.source, canonicalSource: canonical[0].source,
          representation: "distinct-recorded-projections; equivalence-unconfirmed", originalRecordsPreserved: true,
          nativePairQualified: false, truncationCauseClaimed: false, successInferred: false };
        unresolvedProjections.push(difference);
        diagnostics.push({ code: "HYBRID_DISTINCT_TOOL_PROJECTIONS_PRESERVED", ...difference, blocksPublication: false });
        continue;
      }
      const itemTurn = canonical[0].document.payload.turn_id, callTurn = turns.get(key(record.source));
      if (!["completed", "failed"].includes(item.status) || canonical[0].source.rawOrdinal < record.source.rawOrdinal
        || !callTurn || itemTurn !== callTurn.id) continue;
      isError = knownError;
      canonicalEvidence.set(key(record.source), { canonicalSource: canonical[0].source,
        namespaceProjection: p.namespace === "mcp__" + item.server ? "explicit-mcp-namespace-prefix" : "recorded-name-or-qualified-mcp-name",
        inputExact, resultProjection: fullResultExact ? "full-recorded-result" : contentProjectionExact ? "exact-recorded-content-array" : "pinned-codex-model-output-projection", canonicalOriginalAllFieldsPreserved: true });
    }
    const callTurn = turns.get(key(record.source)), resultTurn = turns.get(key(result.source));
    if (Object.hasOwn(r, "is_error") && typeof r.is_error !== "boolean") continue;
    if (!callTurn || !resultTurn || callTurn.id !== resultTurn.id || callTurn.nativeId !== resultTurn.nativeId
      || callTurn.nativeId !== record.source.nativeId || resultTurn.nativeId !== result.source.nativeId) continue;
    strictEvents.set(key(result.source), [{ kind: "tool-result", callId: p.call_id, output: r.output, isError, source: result.source }]);
  }
  const callCounts = new Map(), resultCounts = new Map(), nameOwners = new Map();
  for (const record of records) {
    const p = record.document.payload;
    if (record.document.type === "response_item" && wireCalls.has(p?.type)) callCounts.set(p.call_id, (callCounts.get(p.call_id) ?? 0) + 1);
    if (record.document.type === "response_item" && wireResults.has(p?.type)) resultCounts.set(p.call_id, (resultCounts.get(p.call_id) ?? 0) + 1);
  }
  const visible = records.filter(record => ["authored-message", "historical-activity", "wire-activity"].includes(record.classification));
  const nativeEvents = new Map(), bridgedCanonical = new Set(), canonicalCall = new Map();
  for (const [callKey, evidence] of canonicalEvidence) canonicalCall.set(key(evidence.canonicalSource), callKey);
  // Exact adjacent call/result groups may include their independently
  // qualified canonical completion records before the first result. Those
  // records stay at their original position as text in the same tool-use
  // assistant message. No authored or unrelated activity record is moved.
  for (let index = 0; index < visible.length; index++) {
    if (!wireCalls.has(visible[index].document.payload?.type) || visible[index].classification !== "wire-activity") continue;
    let end = index, calls = [], results = [], bridges = [];
    while (end < visible.length && visible[end].classification === "wire-activity" && wireCalls.has(visible[end].document.payload?.type)) calls.push(visible[end++]);
    const callKeys = new Set(calls.map(record => key(record.source)));
    while (end < visible.length && visible[end].classification === "historical-activity" && callKeys.has(canonicalCall.get(key(visible[end].source)))) bridges.push(visible[end++]);
    while (end < visible.length && visible[end].classification === "wire-activity" && wireResults.has(visible[end].document.payload?.type)) results.push(visible[end++]);
    const expected = new Set(calls.map(record => record.document.payload.call_id));
    let valid = expected.size === calls.length && calls.length > 0 && results.length === calls.length;
    const sequence = [];
    for (const record of [...calls, ...results]) {
      const id = record.document.payload.call_id, candidates = strictEvents.get(key(record.source)) ?? [];
      if (callCounts.get(id) !== 1 || resultCounts.get(id) !== 1 || candidates.length !== 1) { valid = false; break; }
      const event = candidates[0];
      if (event.kind === "tool-result" && (!expected.delete(id) || typeof event.isError !== "boolean")) valid = false;
      if (event.kind === "tool-call") {
        const name = toolName(event), owner = JSON.stringify([event.namespace ?? null, event.name]);
        if (!/^[A-Za-z0-9_-]{1,128}$/u.test(name ?? "") || nameOwners.has(name) && nameOwners.get(name) !== owner) valid = false;
        if (!event.input || typeof event.input !== "object" || Array.isArray(event.input)) valid = false;
        nameOwners.set(name, owner);
      }
      sequence.push([record, event]);
    }
    valid &&= expected.size === 0;
    if (valid) {
      for (const [record, event] of sequence) nativeEvents.set(key(record.source), event);
      for (const record of bridges) bridgedCanonical.add(key(record.source));
    }
    index = Math.max(index, end - 1);
  }
  const events = [], inventory = [], historical = [];
  const authoredByFrame = new Map();
  for (const event of original.events) { const id = key(event.source); if (!authoredByFrame.has(id)) authoredByFrame.set(id, []); authoredByFrame.get(id).push(event); }
  for (const record of records) {
    const id = key(record.source), nativeEvent = nativeEvents.get(id);
    let representation = record.classification;
    if (record.classification === "authored-message") events.push(...(authoredByFrame.get(id) ?? []));
    else if (nativeEvent) { events.push(nativeEvent); representation = "native-exact-tool"; }
    else if (["historical-activity", "wire-activity"].includes(record.classification)) {
      const event = { kind: "historical-activity", text: historicalActivityText(record), source: record.source, at: record.source.rawOrdinal, sub: 0,
        ...(bridgedCanonical.has(id) ? { joinVerifiedToolCallGroup: true, callId: record.document.payload.item.id } : {}) };
      events.push(event); historical.push(event); representation = "quoted-historical-codex-activity";
    }
    const providerFields = record.classification === "provider-envelope-original-only" ? fieldInventory(record.document.payload) : undefined;
    if (providerFields) diagnostics.push({ code: "HYBRID_PROVIDER_ENVELOPE_CLASSIFIED_ORIGINAL_ONLY", source: record.source,
      fieldInventory: providerFields, bodyImportedAsInstruction: false, blocksPublication: false });
    inventory.push({ source: record.source, recordType: record.document.type, itemType: record.document.payload?.item?.type ?? record.document.payload?.type ?? null,
      classification: record.classification, representation, originalAllFieldsPreserved: true, nativeInstructionAuthority: false,
      ...(record.corroborationSource ? { corroborationSource: record.corroborationSource } : {}),
      ...(canonicalEvidence.has(id) ? { canonicalWireEvidence: canonicalEvidence.get(id) } : {}) });
  }
  return { converter, events, diagnostics, inventory, original, historical, records, unresolvedProjections, nativeEvents: [...nativeEvents.values()],
    sourceSelection: { threadId, physicalRolloutId: native.payload.selectedRolloutId, selectedPhysicalPrefixesVerified: true,
      canonicalDatabaseRowsClaimed: false, modelContextEquivalent: false }, sourceLifecycle: strict.sourceLifecycle,
    displayMetadata: strict.displayMetadata, originalRuntimeInstructionsImported: false };
}

export function encodeCodexHybrid({ read, targetId, cwd, createdAt }) {
  for (const record of read.records) if (hash(Buffer.from(record.rawText)) !== record.source.rawFrameSha256) fail("HYBRID_SOURCE_RECORD_CHANGED");
  const encoded = encodeClaudeDerived({ events: read.events, diagnostics: read.diagnostics, targetId, cwd, createdAt,
    displayMetadata: read.displayMetadata ?? null, authoredMessagePolicy: "hybrid-preserve-source-v1" });
  const allowances = [], activityProblems = [], mappingsBySource = new Map();
  for (const mapping of encoded.mappings) {
    const id = mapping.sourceRole + ":" + key(mapping.source);
    if (!mappingsBySource.has(id)) mappingsBySource.set(id, []);
    mappingsBySource.get(id).push(mapping);
  }
  for (const event of read.historical) {
    const matches = (mappingsBySource.get("historical-activity:" + key(event.source)) ?? []).filter(mapping => equal(mapping.source, event.source));
    if (matches.length !== 1) { activityProblems.push({ code: "HYBRID_ACTIVITY_MAPPING_COUNT", source: event.source }); continue; }
    const mapping = matches[0], block = encoded.rows[mapping.targetMessageIndex]?.message?.content[mapping.targetContentIndex];
    if (block?.type !== "text" || block.text !== event.text || mapping.representation !== "quoted-historical-codex-activity")
      activityProblems.push({ code: "HYBRID_ACTIVITY_BODY_MISMATCH", source: event.source });
    else allowances.push({ targetMessageIndex: mapping.targetMessageIndex, targetContentIndex: mapping.targetContentIndex, text: event.text });
  }
  const nativeSlots = new Set();
  for (const event of read.nativeEvents) {
    const matches = mappingsBySource.get(event.kind + ":" + key(event.source)) ?? [];
    if (matches.length !== 1) { activityProblems.push({ code: "HYBRID_NATIVE_TOOL_MAPPING_COUNT", source: event.source }); continue; }
    const mapping = matches[0], row = encoded.rows[mapping.targetMessageIndex], block = row?.message?.content?.[mapping.targetContentIndex];
    const expected = event.kind === "tool-call" ? { type: "tool_use", id: event.callId, name: toolName(event), input: event.input }
      : { type: "tool_result", tool_use_id: event.callId, content: typeof event.output === "string" ? event.output : JSON.stringify(event.output), is_error: event.isError };
    if (!equal(block, expected) || row?.type !== (event.kind === "tool-call" ? "assistant" : "user")) activityProblems.push({ code: "HYBRID_NATIVE_TOOL_BODY_MISMATCH", source: event.source });
    nativeSlots.add(mapping.targetMessageIndex + ":" + mapping.targetContentIndex);
  }
  for (const [index, row] of encoded.rows.entries()) for (const [part, block] of row.message.content.entries())
    if (["tool_use", "tool_result"].includes(block.type) && !nativeSlots.has(index + ":" + part)) activityProblems.push({ code: "HYBRID_UNMAPPED_NATIVE_TOOL_BLOCK", index, part });
  const authored = compareAuthoredNativeText({ original: read.original, rows: encoded.rows, mappings: encoded.mappings, verifiedNonAuthoredText: allowances });
  const ledgerKeys = new Set(read.inventory.map(entry => key(entry.source)));
  const coverage = { kind: "HybridCapturedRecordCoverage", authorityPlane: "P4", sourceRecords: read.records.length, ledgerRecords: read.inventory.length,
    exactRecordLedger: read.records.length === read.inventory.length && ledgerKeys.size === read.records.length
      && read.records.every(record => ledgerKeys.has(key(record.source))),
    historicalActivities: read.historical.length, historicalActivitiesMatched: allowances.length, nativeToolRecords: read.nativeEvents.length, activityProblems,
    unresolvedProjectionCount: read.unresolvedProjections.length, unresolvedProjections: read.unresolvedProjections,
    allToolSemanticEquivalenceClaimed: false,
    authored, originalAllFieldsPreserved: true, providerInstructionsReplayed: false, activityRepresentation: "explicit-current-user-hybrid-choice",
    semanticSufficiencyClaimed: false, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
  const complete = coverage.exactRecordLedger && activityProblems.length === 0 && authored.completeAuthoredMessageCoverage
    && !encoded.diagnostics.some(diagnostic => diagnostic.blocksPublication);
  if (!complete) encoded.diagnostics.push({ code: "HYBRID_RECORD_COVERAGE_INCOMPLETE", blocksPublication: true });
  encoded.publicationReady &&= complete;
  const lastAuthored = read.original.messages.at(-1);
  encoded.openSafety.sourceLifecycle = read.sourceLifecycle;
  encoded.openSafety.lastSourceAuthoredRole = lastAuthored?.role ?? null;
  encoded.openSafety.trailingUserMessage ||= lastAuthored?.role === "user";
  encoded.openSafety.structurallySettled &&= read.sourceLifecycle?.terminalAtCapture === true && lastAuthored?.role === "assistant";
  return { ...encoded, hybridCoverage: coverage, activityCoverageComplete: complete };
}
