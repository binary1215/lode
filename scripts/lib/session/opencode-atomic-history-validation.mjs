import { inspectOpenCodeHistoryOriginal } from "./provider-native-history-format.mjs";

// Source-bound validation, not an Effect decoder or an execution-ready claim.
// OpenCode 1.19.5, 810c0eba: packages/schema/src/v1/session.ts and
// packages/opencode/src/session/session.ts. Unknown fields remain historical
// JSON; unknown union variants never reach a database write.
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const invalid = (field) => {
  throw Object.assign(new Error("NATIVE_OPENCODE_HISTORY_SCHEMA_INVALID"), {
    code: "NATIVE_OPENCODE_HISTORY_SCHEMA_INVALID",
    field,
  });
};
const string = (value) => typeof value === "string";
const boolean = (value) => typeof value === "boolean";
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const integer = (value) => finite(value) && Number.isInteger(value) && value >= 0;
const timestamp = (value) => finite(value) && value >= 0;
const any = () => true;
const prefix = (start) => (value) => string(value) && value.startsWith(start);
const enumeration = (values) => (value) => values.includes(value);
function array(check) {
  return (value, at) => Array.isArray(value) && value.every((item, index) => check(item, at + "." + index));
}
function record(check = any) {
  return (value, at) => object(value) && Object.entries(value).every(([key, item]) => check(item, at + "." + key));
}
function shape(required, optional = {}) {
  return (value, at = "history") => {
    if (!object(value)) invalid(at);
    for (const [key, check] of Object.entries(required)) if (!own(value, key) || !check(value[key], at + "." + key)) invalid(at + "." + key);
    for (const [key, check] of Object.entries(optional)) if (own(value, key) && !check(value[key], at + "." + key)) invalid(at + "." + key);
    return true;
  };
}
function union(key, variants) {
  return (value, at) => object(value) && own(variants, value[key]) && variants[value[key]](value, at);
}
const sid = prefix("ses"),
  mid = prefix("msg"),
  pid = prefix("prt");
const model = shape({ providerID: string, modelID: string }, { variant: string });
const cache = shape({ read: finite, write: finite });
const sessionTokens = shape({ input: finite, output: finite, reasoning: finite, cache });
const tokens = shape({ input: finite, output: finite, reasoning: finite, cache }, { total: finite });
const diff = shape({ additions: finite, deletions: finite }, { file: string, patch: string, status: enumeration(["added", "deleted", "modified"]) });
const permission = shape({ permission: string, pattern: string, action: enumeration(["allow", "deny", "ask"]) });
const summary = shape({ additions: finite, deletions: finite, files: finite }, { diffs: array(diff) });
const sessionInfo = shape(
  {
    id: sid,
    slug: string,
    projectID: string,
    directory: string,
    title: string,
    version: string,
    time: shape({ created: integer, updated: integer }, { compacting: integer, archived: finite }),
  },
  {
    path: string,
    parentID: sid,
    workspaceID: prefix("wrk"),
    summary,
    cost: finite,
    tokens: sessionTokens,
    share: shape({ url: string }),
    metadata: record(),
    permission: array(permission),
    agent: string,
    model: shape({ id: string, providerID: string }, { variant: string }),
    revert: shape({ messageID: mid }, { partID: pid, snapshot: string, diff: string }),
  },
);
const namedError = (name, fields, optional = {}) => shape({ name: enumeration([name]), data: shape(fields, optional) });
const apiError = namedError(
  "APIError",
  { message: string, isRetryable: boolean },
  {
    statusCode: integer,
    responseHeaders: record(string),
    responseBody: string,
    metadata: record(string),
  },
);
const error = union("name", {
  ProviderAuthError: namedError("ProviderAuthError", { providerID: string, message: string }),
  UnknownError: namedError("UnknownError", { message: string }, { ref: string }),
  MessageOutputLengthError: namedError("MessageOutputLengthError", {}),
  MessageAbortedError: namedError("MessageAbortedError", { message: string }),
  StructuredOutputError: namedError("StructuredOutputError", { message: string, retries: integer }),
  ContextOverflowError: namedError("ContextOverflowError", { message: string }, { responseBody: string }),
  ContentFilterError: namedError("ContentFilterError", { message: string }),
  APIError: apiError,
});
const format = union("type", {
  text: shape({ type: enumeration(["text"]) }),
  json_schema: shape({ type: enumeration(["json_schema"]), schema: record() }, { retryCount: integer }),
});
const user = shape(
  { id: mid, sessionID: sid, role: enumeration(["user"]), time: shape({ created: timestamp }), agent: string, model },
  {
    format,
    summary: shape({ diffs: array(diff) }, { title: string, body: string }),
    system: string,
    tools: record(boolean),
  },
);
const assistant = shape(
  {
    id: mid,
    sessionID: sid,
    role: enumeration(["assistant"]),
    time: shape({ created: integer }, { completed: integer }),
    parentID: mid,
    modelID: string,
    providerID: string,
    mode: string,
    agent: string,
    path: shape({ cwd: string, root: string }),
    cost: finite,
    tokens,
  },
  {
    error,
    summary: boolean,
    structured: any,
    variant: string,
    finish: string,
  },
);
const message = union("role", { user, assistant });
const range = shape({ start: shape({ line: integer, character: integer }), end: shape({ line: integer, character: integer }) });
const sourceText = shape({ value: string, start: finite, end: finite });
const fileSource = union("type", {
  file: shape({ type: enumeration(["file"]), text: sourceText, path: string }),
  symbol: shape({ type: enumeration(["symbol"]), text: sourceText, path: string, range, name: string, kind: integer }),
  resource: shape({ type: enumeration(["resource"]), text: sourceText, clientName: string, uri: string }),
});
const base = { id: pid, sessionID: sid, messageID: mid };
const filePart = shape({ ...base, type: enumeration(["file"]), mime: string, url: string }, { filename: string, source: fileSource });
const toolState = union("status", {
  pending: shape({ status: enumeration(["pending"]), input: record(), raw: string }),
  running: shape({ status: enumeration(["running"]), input: record(), time: shape({ start: integer }) }, { title: string, metadata: record() }),
  completed: shape(
    {
      status: enumeration(["completed"]),
      input: record(),
      output: string,
      title: string,
      metadata: record(),
      time: shape({ start: integer, end: integer }, { compacted: integer }),
    },
    { attachments: array(filePart) },
  ),
  error: shape({ status: enumeration(["error"]), input: record(), error: string, time: shape({ start: integer, end: integer }) }, { metadata: record() }),
});
const parts = union("type", {
  text: shape(
    { ...base, type: enumeration(["text"]), text: string },
    { synthetic: boolean, ignored: boolean, time: shape({ start: integer }, { end: integer }), metadata: record() },
  ),
  reasoning: shape({ ...base, type: enumeration(["reasoning"]), text: string, time: shape({ start: integer }, { end: integer }) }, { metadata: record() }),
  file: filePart,
  snapshot: shape({ ...base, type: enumeration(["snapshot"]), snapshot: string }),
  patch: shape({ ...base, type: enumeration(["patch"]), hash: string, files: array(string) }),
  agent: shape({ ...base, type: enumeration(["agent"]), name: string }, { source: shape({ value: string, start: integer, end: integer }) }),
  compaction: shape({ ...base, type: enumeration(["compaction"]), auto: boolean }, { overflow: boolean, tail_start_id: mid }),
  subtask: shape({ ...base, type: enumeration(["subtask"]), prompt: string, description: string, agent: string }, { model, command: string }),
  retry: shape({ ...base, type: enumeration(["retry"]), attempt: integer, error: apiError, time: shape({ created: integer }) }),
  "step-start": shape({ ...base, type: enumeration(["step-start"]) }, { snapshot: string }),
  "step-finish": shape({ ...base, type: enumeration(["step-finish"]), reason: string, cost: finite, tokens }, { snapshot: string }),
  tool: shape({ ...base, type: enumeration(["tool"]), callID: string, tool: string, state: toolState }, { metadata: record() }),
});

export function decodeOpenCodeAtomicHistory(raw, nativeId) {
  inspectOpenCodeHistoryOriginal(raw, nativeId);
  const document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  const sessionFields = new Set([
    "id",
    "slug",
    "projectID",
    "directory",
    "title",
    "version",
    "time",
    "path",
    "parentID",
    "workspaceID",
    "summary",
    "cost",
    "tokens",
    "share",
    "metadata",
    "permission",
    "agent",
    "model",
    "revert",
  ]);
  if (Object.keys(document).some((key) => !["info", "messages"].includes(key)) || Object.keys(document.info).some((key) => !sessionFields.has(key)))
    invalid("info.unsupported-field");
  sessionInfo(document.info, "info");
  // These containers map to separate SQL columns. Unlike message/part data and
  // Session metadata/diffs, unknown fields here cannot survive the mapping.
  for (const [value, keys, at] of [
    [document.info.time, ["created", "updated", "compacting", "archived"], "info.time"],
    [document.info.summary, ["additions", "deletions", "files", "diffs"], "info.summary"],
    [document.info.tokens, ["input", "output", "reasoning", "cache"], "info.tokens"],
    [document.info.tokens?.cache, ["read", "write"], "info.tokens.cache"],
    [document.info.share, ["url"], "info.share"],
  ])
    if (value && Object.keys(value).some((key) => !keys.includes(key))) invalid(at + ".unsupported-field");
  for (const [index, row] of document.messages.entries()) {
    if (!message(row.info, "messages." + index + ".info")) invalid("messages." + index + ".info");
    for (const [partIndex, part] of row.parts.entries()) {
      const at = "messages." + index + ".parts." + partIndex;
      if (!parts(part, at)) invalid(at);
      for (const attachment of part.type === "tool" ? (part.state.attachments ?? []) : [])
        if (attachment.sessionID !== nativeId || attachment.messageID !== row.info.id) invalid(at + ".state.attachments.owner");
    }
  }
  return document;
}
