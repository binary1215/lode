import crypto from "node:crypto";
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = value => value && typeof value === "object" && !Array.isArray(value);
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u.test(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const decode = raw => {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(raw); }
  catch { fail("NATIVE_HISTORY_INVALID_UTF8"); }
};

// Structural evidence only. These functions are not a substitute for the
// installed official decoder, native list/history observation or model resume.
export function decodeClaudeHistoryRecords(raw) {
  const records = [];
  let lineNumber = 0;
  for (const line of decode(raw).split(/\r?\n/u)) {
    lineNumber++;
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { fail("NATIVE_CLAUDE_JSONL_INCOMPLETE_OR_INVALID"); }
    if (!object(row) || typeof row.type !== "string") fail("NATIVE_CLAUDE_JSONL_RECORD_INVALID");
    records.push({ record: row, line: lineNumber });
  }
  return records;
}
export function inspectClaudeHistoryOriginal(raw, nativeId) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(nativeId || "")) fail("NATIVE_CLAUDE_SELECTION_INVALID");
  const rows = [], uuids = new Map(), types = new Set(), sessions = new Set();
  for (const { record: row, line: lineNumber } of decodeClaudeHistoryRecords(raw)) {
    types.add(row.type);
    if (typeof row.sessionId === "string") sessions.add(row.sessionId);
    if (["user", "assistant"].includes(row.type)) {
      if (!id(row.uuid) || !object(row.message) || !["user", "assistant"].includes(row.message.role)
        || row.message.role !== row.type || !(typeof row.message.content === "string" || Array.isArray(row.message.content))) fail("NATIVE_CLAUDE_MESSAGE_INVALID");
      if (row.parentUuid != null && !id(row.parentUuid)) fail("NATIVE_CLAUDE_PARENT_INVALID");
      if (uuids.has(row.uuid)) fail("NATIVE_CLAUDE_DUPLICATE_MESSAGE_ID");
      uuids.set(row.uuid, row);
      rows.push({ uuid: row.uuid, parentUuid: row.parentUuid ?? null, role: row.message.role, sessionId: typeof row.sessionId === "string" ? row.sessionId : null, line: lineNumber });
    }
  }
  if (!rows.length) fail("NATIVE_CLAUDE_NO_CONVERSATION_MESSAGES");
  const missingParents = [...new Set(rows.map(row => row.parentUuid).filter(parent => parent && !uuids.has(parent)))];
  for (const row of rows) {
    const seen = new Set([row.uuid]); let parent = row.parentUuid;
    while (parent && uuids.has(parent)) {
      if (seen.has(parent)) fail("NATIVE_CLAUDE_PARENT_CYCLE");
      seen.add(parent); parent = uuids.get(parent).parentUuid;
    }
  }
  // A filename or metadata-only session ID cannot identify the selected
  // conversation. Forks may retain ancestor messages from another session.
  const messageSessions = new Set(rows.map(row => row.sessionId).filter(Boolean));
  if (!messageSessions.size) fail("NATIVE_CLAUDE_MESSAGE_SESSION_IDENTITY_MISSING");
  const selectedRows = rows.filter(row => row.sessionId === nativeId);
  if (!selectedRows.length) fail("NATIVE_CLAUDE_SELECTED_SESSION_NOT_OBSERVED");
  const selectedAncestry = new Set();
  for (const row of selectedRows) {
    let current = row.uuid;
    while (current && uuids.has(current) && !selectedAncestry.has(current)) {
      selectedAncestry.add(current); current = uuids.get(current).parentUuid;
    }
  }
  const foreignRows = rows.filter(row => row.sessionId && row.sessionId !== nativeId);
  const foreignRowsOutsideSelectedAncestry = foreignRows.filter(row => !selectedAncestry.has(row.uuid)).length;
  return { provider: "claude", format: "claude-code-jsonl", nativeId, messageCount: rows.length,
    messageIds: rows.map(row => row.uuid), missingParents, observedSessionIds: [...sessions], recordTypes: [...types],
    selectedIdentityEvidence: "selected-id-observed-in-message-record", selectedMessageCount: selectedRows.length,
    foreignSessionMessageCount: foreignRows.length, foreignRowsOutsideSelectedAncestry,
    messageRowsWithoutSessionId: rows.filter(row => !row.sessionId).length,
    officialNativeOwnershipVerified: false,
    structuralDecode: "complete-jsonl-only", officialClientDecode: "not-performed", pickerVisibility: "not-observed", modelContinuation: "not-requested" };
}

export function inspectOpenCodeHistoryOriginal(raw, nativeId) {
  let source;
  try { source = JSON.parse(decode(raw)); } catch (error) { if (error.code) throw error; fail("NATIVE_OPENCODE_EXPORT_INVALID_JSON"); }
  if (!object(source) || !object(source.info) || !id(source.info.id) || source.info.id !== nativeId || !Array.isArray(source.messages)) fail("NATIVE_OPENCODE_EXPORT_IDENTITY_INVALID");
  if (source.info.parentID !== undefined && !id(source.info.parentID)) fail("NATIVE_OPENCODE_PARENT_INVALID");
  const messageIds = new Set(), partIds = new Set(), order = [];
  for (const message of source.messages) {
    const info = message?.info;
    if (!object(info) || !id(info.id) || info.sessionID !== nativeId || !["user", "assistant"].includes(info.role)
      || !object(info.time) || !Number.isSafeInteger(info.time.created) || info.time.created < 0 || !Array.isArray(message.parts)) fail("NATIVE_OPENCODE_MESSAGE_INVALID");
    if (messageIds.has(info.id)) fail("NATIVE_OPENCODE_DUPLICATE_MESSAGE_ID");
    messageIds.add(info.id); order.push({ id: info.id, created: info.time.created });
    for (const part of message.parts) {
      if (!object(part) || !id(part.id) || part.sessionID !== nativeId || part.messageID !== info.id || typeof part.type !== "string" || !part.type) fail("NATIVE_OPENCODE_PART_OWNER_INVALID");
      if (partIds.has(part.id)) fail("NATIVE_OPENCODE_DUPLICATE_PART_ID");
      partIds.add(part.id);
    }
  }
  order.sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { provider: "opencode", format: "opencode-v1-export-json", nativeId, parentId: source.info.parentID ?? null,
    messageCount: messageIds.size, partCount: partIds.size, messageIds: [...messageIds], partIds: [...partIds],
    officialOrderKeys: order, activeSourceFields: ["permission", "model", "agent", "revert"].filter(key => own(source.info, key)),
    structuralDecode: "full-json-and-global-owner-shape-only", officialClientDecode: "not-performed", modelContinuation: "not-requested" };
}

// Preserve every historical message/part unchanged. Only active Session.Info
// choices differ in this separately identified target import artifact.
export function deriveOpenCodeHistoryImport(raw, { nativeId, targetActive = {} } = {}) {
  inspectOpenCodeHistoryOriginal(raw, nativeId);
  if (!object(targetActive) || Object.keys(targetActive).some(key => !["permission", "model", "agent"].includes(key))) fail("NATIVE_OPENCODE_TARGET_ACTIVE_POLICY_INVALID");
  const source = JSON.parse(decode(raw)), info = { ...source.info }, changes = [];
  for (const key of ["permission", "model", "agent", "revert", "workspaceID"]) {
    if (own(info, key)) { delete info[key]; changes.push({ field: "info." + key, operation: "omit-source-active-value" }); }
    if (own(targetActive, key)) { info[key] = structuredClone(targetActive[key]); changes.push({ field: "info." + key, operation: "use-explicit-current-target-value" }); }
  }
  if (object(info.time) && own(info.time, "compacting")) {
    info.time = { ...info.time }; delete info.time.compacting;
    changes.push({ field: "info.time.compacting", operation: "omit-source-active-value" });
  }
  const document = { ...source, info };
  const derived = Buffer.from(JSON.stringify(document, null, 2) + "\n");
  return { bytes: derived, sourceSha256: crypto.createHash("sha256").update(raw).digest("hex"), importSha256: crypto.createHash("sha256").update(derived).digest("hex"), changes,
    historicalMessagesChanged: false, sourceOriginalPreserved: true, targetLocation: "official-import-context-not-source-or-staging-id",
    grantsRecoveryAuthority: false, restoresExecutionPermission: false, officialClientDecode: "not-performed", targetExecutionSettingsVerified: false, continuationReady: false,
    runtimeCaveat: "Official v1 may fall back to historical user model/agent or pending work. Reading/importing history does not enter its prompt loop or verify current target runtime choices." };
}

export function inspectProviderHistoryOriginal(provider, raw, nativeId) {
  if (provider === "claude") return inspectClaudeHistoryOriginal(raw, nativeId);
  if (provider === "opencode") return inspectOpenCodeHistoryOriginal(raw, nativeId);
  fail("NATIVE_HISTORY_PROVIDER_UNSUPPORTED");
}
