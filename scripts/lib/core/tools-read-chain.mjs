// lode_tools_read_chain: a declarative list of read-only Lode tool calls and
// row steps, run inside the server. No expressions, no code, no writes: every
// inner call is an ordinary lode_tools_read call made by the caller's own
// dispatcher, and the chain only moves rows between those calls.
import { canonicalJson } from "./canonical-json.mjs";

export const READ_CHAIN_TOOL_NAME = "lode_tools_read_chain";

// Every bound in one place; the docs quote these values.
export const READ_CHAIN_LIMITS = Object.freeze({
  steps: 12,
  calls: 40,
  eachCalls: 20,
  pages: 10,
  defaultBytes: 16 * 1024,
  maxBytes: 64 * 1024,
  minBytes: 1024,
  memoryBytes: 16 * 1024 * 1024,
  inputBytes: 64 * 1024,
  conditionDepth: 2,
  inValues: 100,
  pickFields: 32,
  pathSegments: 4,
  messageChars: 500,
});

const STEP_KINDS = Object.freeze(["read", "where", "pick", "sort", "limit", "unique", "count"]);
const OPERATORS = Object.freeze(["eq", "ne", "in", "contains", "startsWith", "exists", "gte", "lte"]);
const STEP_ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/u;
const SEGMENT = /^[^.\s]{1,64}$/u;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isItemReference = (value) => isObject(value) && Object.keys(value).length === 1 && value.$item === true;
const hasItemKey = (value) =>
  Array.isArray(value) ? value.some(hasItemKey) : isObject(value) ? Object.hasOwn(value, "$item") || Object.values(value).some(hasItemKey) : false;

// The listed input schema stays short; READ_CHAIN_REFERENCE is the full one.
export const READ_CHAIN_TOOL = Object.freeze({
  name: READ_CHAIN_TOOL_NAME,
  description:
    "Run several read-only Lode tool calls as one declarative step list inside the server and return only the rows asked for, with Lode-counted totals (total, returned, cut, notSeen). Steps: read (one call), each+read (one call per earlier row), where, pick, sort, limit, unique, count. Grants nothing and writes nothing. Full step reference: lode_tools_discover with name lode_tools_read_chain.",
  inputSchema: {
    type: "object",
    properties: {
      project_root: { type: "string", minLength: 1, description: "The Project; supplied to every inner call whose schema declares project_root." },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: READ_CHAIN_LIMITS.steps,
        description: "Steps in order; each has an id and one kind (read, where, pick, sort, limit, unique, count) and reads earlier steps only.",
        items: { type: "object" },
      },
      return: {
        type: "array",
        minItems: 1,
        description: "Which steps carry rows in the answer: { from: step id, limit?: n }.",
        items: { type: "object" },
      },
      on_error: { type: "string", enum: ["continue", "stop"], default: "continue", description: "A failed inner call is recorded; stop ends the chain there." },
      max_bytes: {
        type: "integer",
        minimum: READ_CHAIN_LIMITS.minBytes,
        maximum: READ_CHAIN_LIMITS.maxBytes,
        default: READ_CHAIN_LIMITS.defaultBytes,
        description: "Bound on the returned answer; rows past it are cut and counted.",
      },
    },
    required: ["project_root", "steps", "return"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
});

export const READ_CHAIN_REFERENCE = Object.freeze({
  steps: {
    read: '{ id, read: { name, arguments }, take?: "rows", pages?: 1..10 } — one call of a read-only tool (the same route as lode_tools_read). take names where the row list is in the result (a dotted path, default rows); a result without a list there becomes one row. pages follows the tool\'s own page.nextMcpArguments and appends the rows.',
    each: '{ id, each: { from, value, max?: 1..20 }, read: { name, arguments }, take?, pages? } — one call per row of an earlier step, in order; value names the field handed over; an argument { "$item": true } is that value. Each produced row carries item.',
    where:
      "{ id, from, where: condition } — keep rows matching. condition: { field, <op>: value } with op one of eq, ne, in, contains, startsWith, exists, gte, lte; or { all: [conditions] } / { any: [conditions] }, nested at most two levels.",
    pick: "{ id, from, pick: [fields] } — keep the named fields.",
    sort: "{ id, from, sort: { by, order?: asc|desc } } — stable; numbers by value, text by code points, missing values last.",
    limit: "{ id, from, limit: n } — the first n rows.",
    unique: "{ id, from, unique: { by } } — one row per value of the field, the first wins.",
    count: "{ id, from, count: { by } } — rows { value, count } per value of the field, in first-seen order.",
  },
  arguments:
    'A literal JSON value, or { "$item": true } as a whole argument value inside each+read. No interpolation, expressions, regular expressions or branching.',
  fields: "A field is a name or a dotted path (at most 4 parts) into a row.",
  rows: "Every step yields a list of plain-object rows; a list entry that is not an object becomes { value }.",
  bounds: {
    steps: READ_CHAIN_LIMITS.steps,
    innerCallsIncludingPages: READ_CHAIN_LIMITS.calls,
    callsOfOneEach: READ_CHAIN_LIMITS.eachCalls,
    pagesOfOneRead: READ_CHAIN_LIMITS.pages,
    returnedBytes: { default: READ_CHAIN_LIMITS.defaultBytes, max: READ_CHAIN_LIMITS.maxBytes },
    intermediateBytes: READ_CHAIN_LIMITS.memoryBytes,
    inputBytes: READ_CHAIN_LIMITS.inputBytes,
  },
  statuses: {
    completed: "Everything ran; check cut and notSeen to know whether everything was seen.",
    partial: "A bound was reached or an inner call failed or was refused; the answer holds what was reached and counts the rest.",
    stopped: "The product graph build changed between calls (no rows are returned), on_error stop met a failed call, or the request was cancelled.",
    refused: "The step list is invalid; no inner call ran.",
  },
  everythingSeen: "Only when status is completed, ran.failed and ran.refused are 0, every result's cut is 0 and every notSeen count is 0.",
  pinning:
    "A chain never returns rows from two product graph builds. This is detected after each call, not prevented: every answer of lode_product_graph_query carries buildSha256 (the build files and the baseline it read), and when a later one differs from the first the chain stops with CHAIN_BUILD_CHANGED and returns no rows. Pages carry expected_basis_sha256 as the tool returns them; a basis-changed page stops the chain the same way. Other tools are not pinned (basis[].pinned false).",
  authority: "A chain grants nothing and writes nothing; each inner call keeps every check of lode_tools_read.",
  example: {
    project_root: "<project>",
    steps: [
      { id: "todo", read: { name: "lode_product_graph_query", arguments: { question: "changes", list: "reviewAgain" } }, pages: 3 },
      { id: "nodes", from: "todo", where: { field: "kind", eq: "node" } },
      { id: "one", from: "nodes", unique: { by: "id" } },
      {
        id: "callers",
        each: { from: "one", value: "id", max: 20 },
        read: { name: "lode_product_graph_query", arguments: { question: "up", id: { $item: true } } },
      },
      { id: "busy", from: "callers", count: { by: "item" } },
      { id: "top", from: "busy", sort: { by: "count", order: "desc" } },
    ],
    return: [{ from: "top", limit: 10 }],
  },
});

// Names of the inner tools a chain asks for, for callers that classify a request
// before it runs (Session binding, hook correlation). Malformed input yields
// what can be read; the chain itself refuses it later.
export function readChainInnerCalls(args) {
  if (!isObject(args) || !Array.isArray(args.steps)) return [];
  return args.steps
    .filter((step) => isObject(step) && isObject(step.read) && typeof step.read.name === "string")
    .map((step) => ({ name: step.read.name, arguments: isObject(step.read.arguments) ? step.read.arguments : {} }));
}

function fieldPath(value) {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length > READ_CHAIN_LIMITS.pathSegments || !parts.every((part) => SEGMENT.test(part))) return null;
  return parts;
}

function fieldValue(row, parts) {
  let value = row;
  for (const part of parts) {
    if (!isObject(value) || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

const sameValue = (left, right) => left !== undefined && right !== undefined && canonicalJson(left) === canonicalJson(right);

// ---------- validation ----------

function validateCondition(condition, at, depth, problems) {
  if (!isObject(condition)) return problems.push({ at, message: "A condition is an object." });
  const keys = Object.keys(condition);
  if (keys.length === 1 && (keys[0] === "all" || keys[0] === "any")) {
    if (depth >= READ_CHAIN_LIMITS.conditionDepth) return problems.push({ at, message: `all/any nest at most ${READ_CHAIN_LIMITS.conditionDepth} levels.` });
    const list = condition[keys[0]];
    if (!Array.isArray(list) || !list.length) return problems.push({ at: `${at}.${keys[0]}`, message: "all/any take a non-empty list of conditions." });
    list.forEach((inner, index) => validateCondition(inner, `${at}.${keys[0]}[${index}]`, depth + 1, problems));
    return;
  }
  const ops = keys.filter((key) => key !== "field");
  if (!fieldPath(condition.field)) problems.push({ at: `${at}.field`, message: "field is a name or a dotted path of at most 4 parts." });
  if (ops.length !== 1 || !OPERATORS.includes(ops[0]))
    return problems.push({ at, message: `A condition has one field and exactly one of ${OPERATORS.join(", ")}.` });
  const [op] = ops;
  const value = condition[op];
  if (hasItemKey(value)) problems.push({ at: `${at}.${op}`, message: "$item is allowed only as a read argument." });
  if (op === "in" && (!Array.isArray(value) || value.length > READ_CHAIN_LIMITS.inValues))
    problems.push({ at: `${at}.in`, message: `in takes a list of at most ${READ_CHAIN_LIMITS.inValues} values.` });
  if (op === "startsWith" && typeof value !== "string") problems.push({ at: `${at}.startsWith`, message: "startsWith takes text." });
  if (op === "exists" && typeof value !== "boolean") problems.push({ at: `${at}.exists`, message: "exists takes true or false." });
  if ((op === "gte" || op === "lte") && typeof value !== "number" && typeof value !== "string")
    problems.push({ at: `${at}.${op}`, message: `${op} takes a number or text.` });
}

function validateSort(value, at, problems) {
  if (!isObject(value) || Object.keys(value).some((key) => !["by", "order"].includes(key)) || !fieldPath(value.by))
    return problems.push({ at, message: "sort is { by, order? } with by a field." });
  if (value.order !== undefined && !["asc", "desc"].includes(value.order)) problems.push({ at: `${at}.order`, message: "order is asc or desc." });
}

function validateBy(value, at, kind, problems) {
  if (!isObject(value) || Object.keys(value).length !== 1 || !fieldPath(value.by)) problems.push({ at, message: `${kind} is { by } with by a field.` });
}

// Checks the whole program before any call. resolveTarget(name, args) returns
// { ok: true, name, operation, declaresProjectRoot } for a read-only operation
// (name as given, operation the member it runs) or
// { ok: false, code, message }. Every problem is reported at once.
export function validateReadChain(input, { resolveTarget } = {}) {
  const problems = [];
  const add = (at, message, code = "CHAIN_INVALID") => problems.push({ code, at, message });
  if (!isObject(input)) return [{ code: "CHAIN_INVALID", at: "", message: "The chain input is an object." }];
  let size = 0;
  try {
    size = Buffer.byteLength(JSON.stringify(input), "utf8");
  } catch {
    return [{ code: "CHAIN_INVALID", at: "", message: "The chain input is not JSON." }];
  }
  if (size > READ_CHAIN_LIMITS.inputBytes) add("", `The chain input is ${size} bytes; at most ${READ_CHAIN_LIMITS.inputBytes}.`);
  for (const key of Object.keys(input))
    if (!["project_root", "steps", "return", "on_error", "max_bytes"].includes(key)) add(key, `Unknown chain field ${key}.`);
  if (typeof input.project_root !== "string" || !input.project_root) add("project_root", "project_root is required text.");
  if (input.on_error !== undefined && !["continue", "stop"].includes(input.on_error)) add("on_error", "on_error is continue or stop.");
  if (
    input.max_bytes !== undefined &&
    (!Number.isInteger(input.max_bytes) || input.max_bytes < READ_CHAIN_LIMITS.minBytes || input.max_bytes > READ_CHAIN_LIMITS.maxBytes)
  )
    add("max_bytes", `max_bytes is an integer from ${READ_CHAIN_LIMITS.minBytes} to ${READ_CHAIN_LIMITS.maxBytes}.`);
  const steps = input.steps;
  if (!Array.isArray(steps) || !steps.length) add("steps", "steps is a non-empty list.");
  else if (steps.length > READ_CHAIN_LIMITS.steps) add("steps", `A chain has at most ${READ_CHAIN_LIMITS.steps} steps; this one has ${steps.length}.`);
  const seen = new Set();
  for (const [index, step] of (Array.isArray(steps) ? steps : []).entries()) {
    const at = `steps[${index}]`;
    if (!isObject(step)) {
      add(at, "A step is an object.");
      continue;
    }
    if (typeof step.id !== "string" || !STEP_ID.test(step.id)) add(`${at}.id`, "id is a letter followed by up to 39 letters, digits, _ or -.");
    else if (seen.has(step.id)) add(`${at}.id`, `The id ${step.id} is used twice.`);
    const kinds = STEP_KINDS.filter((kind) => Object.hasOwn(step, kind));
    const allowed = new Set(["id", ...kinds]);
    if (kinds.length !== 1) add(at, `A step has exactly one of ${STEP_KINDS.join(", ")} (each goes with read).`);
    const kind = kinds[0];
    const earlier = (from, where) => {
      if (typeof from !== "string" || !seen.has(from)) add(where, `${JSON.stringify(from ?? null)} is not an earlier step.`);
    };
    if (kind === "read") {
      ["each", "take", "pages"].forEach((key) => allowed.add(key));
      const read = step.read;
      if (!isObject(read) || typeof read.name !== "string" || !read.name || Object.keys(read).some((key) => !["name", "arguments"].includes(key)))
        add(`${at}.read`, "read is { name, arguments }.");
      const args = isObject(read) ? (read.arguments ?? {}) : {};
      if (isObject(read) && read.arguments !== undefined && !isObject(read.arguments)) add(`${at}.read.arguments`, "arguments is an object.");
      const each = step.each;
      if (each !== undefined) {
        if (!isObject(each) || Object.keys(each).some((key) => !["from", "value", "max"].includes(key))) add(`${at}.each`, "each is { from, value, max? }.");
        else {
          earlier(each.from, `${at}.each.from`);
          if (!fieldPath(each.value)) add(`${at}.each.value`, "value is a field of the earlier rows.");
          if (each.max !== undefined && (!Number.isInteger(each.max) || each.max < 1 || each.max > READ_CHAIN_LIMITS.eachCalls))
            add(`${at}.each.max`, `max is 1 to ${READ_CHAIN_LIMITS.eachCalls}.`);
        }
      }
      if (isObject(args)) {
        for (const [key, value] of Object.entries(args)) {
          if (isItemReference(value)) {
            if (each === undefined) add(`${at}.read.arguments.${key}`, '{ "$item": true } is allowed only in a step with each.');
            if (key === "project_root") add(`${at}.read.arguments.project_root`, "project_root is supplied by the chain.");
          } else if (hasItemKey(value)) add(`${at}.read.arguments.${key}`, '$item is allowed only as a whole argument value { "$item": true }.');
        }
      }
      if (step.take !== undefined && !fieldPath(step.take)) add(`${at}.take`, "take is a name or a dotted path of at most 4 parts.");
      if (step.pages !== undefined && (!Number.isInteger(step.pages) || step.pages < 1 || step.pages > READ_CHAIN_LIMITS.pages))
        add(`${at}.pages`, `pages is 1 to ${READ_CHAIN_LIMITS.pages}.`);
      if (isObject(read) && typeof read.name === "string" && read.name && isObject(args)) {
        // A placeholder stands in for each handed-over value while the target is resolved.
        const probe = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, isItemReference(value) ? "" : value]));
        const target = resolveTarget ? resolveTarget(read.name, probe) : { ok: false, code: "CHAIN_TOOL_REFUSED", message: "No tool resolver." };
        if (!target.ok) add(`${at}.read.name`, target.message, target.code || "CHAIN_TOOL_REFUSED");
        else if (typeof args.project_root === "string" && typeof input.project_root === "string" && args.project_root !== input.project_root)
          add(`${at}.read.arguments.project_root`, "An inner call names another project_root than the chain's.", "CHAIN_PROJECT_ROOT_MISMATCH");
        else if (args.project_root !== undefined && !isItemReference(args.project_root) && typeof args.project_root !== "string")
          add(`${at}.read.arguments.project_root`, "project_root is text.");
      }
    } else if (kind) {
      allowed.add("from");
      earlier(step.from, `${at}.from`);
      const value = step[kind];
      if (kind === "where") validateCondition(value, `${at}.where`, 0, collector(add));
      if (
        kind === "pick" &&
        (!Array.isArray(value) || !value.length || value.length > READ_CHAIN_LIMITS.pickFields || !value.every((field) => fieldPath(field)))
      )
        add(`${at}.pick`, `pick is a list of 1 to ${READ_CHAIN_LIMITS.pickFields} fields.`);
      if (kind === "sort") validateSort(value, `${at}.sort`, collector(add));
      if (kind === "limit" && (!Number.isInteger(value) || value < 0)) add(`${at}.limit`, "limit is a whole number of rows (0 or more).");
      if (kind === "unique" || kind === "count") validateBy(value, `${at}.${kind}`, kind, collector(add));
    }
    for (const key of Object.keys(step)) if (!allowed.has(key)) add(`${at}.${key}`, `${key} does not belong in this step.`);
    if (typeof step.id === "string" && STEP_ID.test(step.id)) seen.add(step.id);
  }
  const returns = input.return;
  if (!Array.isArray(returns) || !returns.length) add("return", "return is a non-empty list of { from, limit? }.");
  else {
    const named = new Set();
    returns.forEach((entry, index) => {
      const at = `return[${index}]`;
      if (!isObject(entry) || Object.keys(entry).some((key) => !["from", "limit"].includes(key))) return add(at, "A return entry is { from, limit? }.");
      if (typeof entry.from !== "string" || !seen.has(entry.from)) add(`${at}.from`, `${JSON.stringify(entry.from ?? null)} is not a step.`);
      else if (named.has(entry.from)) add(`${at}.from`, `${entry.from} is returned twice.`);
      else named.add(entry.from);
      if (entry.limit !== undefined && (!Number.isInteger(entry.limit) || entry.limit < 0)) add(`${at}.limit`, "limit is a whole number of rows (0 or more).");
    });
  }
  return problems;
}

// Adapts the { at, message } pushes of the small validators to add().
function collector(add) {
  return { push: ({ at, message }) => add(at, message) };
}

// ---------- row steps ----------

function matches(row, condition) {
  if (Object.hasOwn(condition, "all")) return condition.all.every((inner) => matches(row, inner));
  if (Object.hasOwn(condition, "any")) return condition.any.some((inner) => matches(row, inner));
  const value = fieldValue(row, fieldPath(condition.field));
  const op = Object.keys(condition).find((key) => key !== "field");
  const wanted = condition[op];
  switch (op) {
    case "eq":
      return sameValue(value, wanted);
    case "ne":
      return !sameValue(value, wanted);
    case "in":
      return wanted.some((item) => sameValue(value, item));
    case "contains":
      if (typeof value === "string") return typeof wanted === "string" && value.includes(wanted);
      if (Array.isArray(value)) return value.some((item) => sameValue(item, wanted));
      return false;
    case "startsWith":
      return typeof value === "string" && value.startsWith(wanted);
    case "exists":
      return (value !== undefined && value !== null) === wanted;
    case "gte":
    case "lte":
      if (typeof value !== typeof wanted || (typeof value !== "number" && typeof value !== "string")) return false;
      return op === "gte" ? value >= wanted : value <= wanted;
    default:
      return false;
  }
}

const typeRank = (value) =>
  value === undefined || value === null ? 9 : typeof value === "number" ? 0 : typeof value === "string" ? 1 : typeof value === "boolean" ? 2 : 3;
function compareValues(left, right) {
  const rank = typeRank(left) - typeRank(right);
  if (rank) return rank;
  if (typeof left === "number") return left - right;
  if (typeof left === "string") return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === "boolean") return Number(left) - Number(right);
  if (left === undefined || left === null) return 0;
  const a = canonicalJson(left),
    b = canonicalJson(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

const valueKey = (value) => (value === undefined ? "\u0000undefined" : canonicalJson(value));

function transform(kind, spec, rows) {
  if (kind === "where") return rows.filter((row) => matches(row, spec));
  if (kind === "pick")
    return rows.map((row) => {
      const picked = {};
      for (const field of spec) {
        const value = fieldValue(row, fieldPath(field));
        if (value !== undefined) picked[field] = value;
      }
      return picked;
    });
  if (kind === "sort") {
    const parts = fieldPath(spec.by);
    const sign = spec.order === "desc" ? -1 : 1;
    return rows
      .map((row, index) => ({ row, index, value: fieldValue(row, parts) }))
      .sort((a, b) => {
        const missing = (a.value === undefined || a.value === null) - (b.value === undefined || b.value === null);
        if (missing) return missing;
        return sign * compareValues(a.value, b.value) || a.index - b.index;
      })
      .map((entry) => entry.row);
  }
  if (kind === "limit") return rows.slice(0, spec);
  if (kind === "unique") {
    const parts = fieldPath(spec.by);
    const kept = new Set();
    return rows.filter((row) => {
      const key = valueKey(fieldValue(row, parts));
      if (kept.has(key)) return false;
      kept.add(key);
      return true;
    });
  }
  if (kind === "count") {
    const parts = fieldPath(spec.by);
    const counts = new Map();
    for (const row of rows) {
      const value = fieldValue(row, parts);
      const key = valueKey(value);
      if (!counts.has(key)) counts.set(key, { value: value === undefined ? null : value, count: 0 });
      counts.get(key).count += 1;
    }
    return [...counts.values()];
  }
  return rows;
}

// ---------- running ----------

const PRODUCT_GRAPH_QUERY = "lode_product_graph_query";
const ANSWER_FAILURES = new Set(["not-built", "unreadable", "failed"]);
const short = (text) => {
  const value = String(text ?? "");
  return value.length > READ_CHAIN_LIMITS.messageChars ? `${value.slice(0, READ_CHAIN_LIMITS.messageChars)}…` : value;
};
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const asRow = (entry) => (isObject(entry) ? entry : { value: entry });

// Reads one inner response: { value } for an answer, { failure } otherwise.
function innerOutcome(response) {
  if (!response) return { failure: { kind: "failed", code: "CHAIN_INNER_NO_RESPONSE", message: "The inner call returned nothing." } };
  if (response.error)
    return { failure: { kind: "failed", code: response.error.data?.reasonCode || "CHAIN_INNER_CALL_FAILED", message: short(response.error.message) } };
  const result = response.result || {};
  const text = result.content?.find?.((entry) => entry?.type === "text")?.text;
  if (result.isError) return { failure: { kind: "failed", code: "CHAIN_INNER_CALL_FAILED", message: short(text) } };
  const value = result.structuredContent !== undefined ? result.structuredContent : { text: text ?? null };
  if (isObject(value) && typeof value.code === "string") {
    if (value.status === "refused") return { failure: { kind: "refused", code: value.code, message: short(value.message ?? value.text) }, value };
    if (value.status === "basis-changed") return { buildChanged: true, value };
    if (ANSWER_FAILURES.has(value.status)) return { failure: { kind: "failed", code: value.code, message: short(value.message ?? value.text) }, value };
  }
  return { value };
}

function rowsOf(value, take) {
  const parts = fieldPath(take ?? "rows");
  const list = fieldValue(value, parts);
  return Array.isArray(list) ? { rows: list.map(asRow), listed: true } : { rows: [asRow(value)], listed: false };
}

// Runs a chain. call(name, args) performs one lode_tools_read call and returns
// its JSON-RPC response; resolveTarget is the validation resolver above.
export async function runReadChain(input, { resolveTarget, call, signal } = {}) {
  const problems = validateReadChain(input, { resolveTarget });
  if (problems.length)
    return {
      status: "refused",
      ran: { steps: 0, calls: 0, failed: 0, refused: 0 },
      basis: [],
      header: [],
      results: {},
      notSeen: { pagesLeft: 0, itemsLeft: 0, eachSkipped: 0, callsSkipped: 0, rowsDropped: 0 },
      issues: problems,
      persisted: false,
      grantsAuthorization: false,
    };
  const stopOnError = input.on_error === "stop";
  const maxBytes = input.max_bytes ?? READ_CHAIN_LIMITS.defaultBytes;
  const ran = { steps: 0, calls: 0, failed: 0, refused: 0 };
  const notSeen = { pagesLeft: 0, itemsLeft: 0, eachSkipped: 0, callsSkipped: 0, rowsDropped: 0 };
  const issues = [];
  const basis = new Map();
  const headers = [];
  const produced = new Map();
  let memory = 0;
  let memoryFull = false;
  let stop = null;
  let pinnedBuild = null;

  const keep = (rows, list) => {
    for (const row of rows) {
      const size = bytesOf(row);
      if (memoryFull || memory + size > READ_CHAIN_LIMITS.memoryBytes) {
        if (!memoryFull)
          issues.push({ code: "CHAIN_MEMORY_LIMIT", message: `Intermediate rows reached ${READ_CHAIN_LIMITS.memoryBytes} bytes; later rows were dropped.` });
        memoryFull = true;
        notSeen.rowsDropped += 1;
        continue;
      }
      memory += size;
      list.push(row);
    }
  };

  const supplied = (target, args) => (target.declaresProjectRoot && args.project_root === undefined ? { project_root: input.project_root, ...args } : args);

  // One read (with its pages). Returns the rows, or null when the chain stops.
  const readOnce = async (step, target, args, extra) => {
    const rows = [];
    let current = supplied(target, args);
    for (let page = 1; ; page += 1) {
      if (signal?.aborted) {
        stop = { code: "CHAIN_CANCELLED", message: "The request was cancelled; no further inner call was made." };
        return null;
      }
      // Past the call bound, or with intermediate rows full, no further call is made.
      if (ran.calls >= READ_CHAIN_LIMITS.calls || memoryFull) {
        notSeen.callsSkipped += 1;
        return rows;
      }
      ran.calls += 1;
      const outcome = innerOutcome(await call(target.name, current));
      const value = outcome.value;
      if (target.operation === PRODUCT_GRAPH_QUERY && isObject(value)) {
        if (!basis.has(target.operation))
          basis.set(target.operation, { tool: target.operation, builtAt: value.builtAt ?? null, freshness: value.freshness?.text ?? null, pinned: true });
        if (typeof value.buildSha256 === "string") {
          pinnedBuild ??= value.buildSha256;
          if (value.buildSha256 !== pinnedBuild) outcome.buildChanged = true;
        }
      } else if (!basis.has(target.operation)) basis.set(target.operation, { tool: target.operation, pinned: false });
      if (outcome.buildChanged) {
        stop = {
          code: "CHAIN_BUILD_CHANGED",
          message: "The product graph build changed between inner calls; nothing from the two builds is mixed and no rows are returned.",
          build: true,
        };
        return null;
      }
      if (outcome.failure) {
        ran[outcome.failure.kind] += 1;
        issues.push({ code: outcome.failure.code, kind: outcome.failure.kind, step: step.id, ...extra, message: outcome.failure.message });
        if (stopOnError) {
          stop = { code: "CHAIN_STOPPED_ON_ERROR", message: `Stopped at step ${step.id}: on_error is stop.` };
          return null;
        }
        return rows;
      }
      if (isObject(value) && Array.isArray(value.header)) headers.push({ step: step.id, header: value.header });
      const taken = rowsOf(value, step.take);
      if (!taken.listed && step.take !== undefined && !issues.some((issue) => issue.code === "CHAIN_TAKE_NOT_A_LIST" && issue.step === step.id))
        issues.push({ code: "CHAIN_TAKE_NOT_A_LIST", step: step.id, message: `The result has no list at ${step.take}; the whole result is one row.` });
      keep(extra.item === undefined ? taken.rows : taken.rows.map((row) => ({ ...row, item: extra.item })), rows);
      const next = isObject(value) && isObject(value.page) && isObject(value.page.nextMcpArguments) ? value.page.nextMcpArguments : null;
      if (!next) return rows;
      if (page >= (step.pages ?? 1) || memoryFull) {
        notSeen.pagesLeft += 1;
        if (Number.isInteger(value.page.remaining)) notSeen.itemsLeft += value.page.remaining;
        return rows;
      }
      current = supplied(target, next);
    }
  };

  for (const step of input.steps) {
    if (stop) break;
    ran.steps += 1;
    if (Object.hasOwn(step, "read")) {
      const args = step.read.arguments ?? {};
      const rows = [];
      if (!step.each) {
        const target = resolveTarget(step.read.name, args);
        const got = await readOnce(step, target, args, {});
        if (got === null) break;
        rows.push(...got);
      } else {
        const parts = fieldPath(step.each.value);
        const cap = step.each.max ?? READ_CHAIN_LIMITS.eachCalls;
        const source = produced.get(step.each.from);
        let attempted = 0;
        let missing = 0;
        for (const [index, row] of source.entries()) {
          const item = fieldValue(row, parts);
          if (item === undefined || item === null) {
            missing += 1;
            continue;
          }
          attempted += 1;
          if (attempted > cap) {
            notSeen.eachSkipped += source.slice(index).filter((rest) => ![undefined, null].includes(fieldValue(rest, parts))).length;
            break;
          }
          const resolved = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, isItemReference(value) ? item : value]));
          const target = resolveTarget(step.read.name, resolved);
          if (!target.ok) {
            ran.refused += 1;
            issues.push({ code: target.code || "CHAIN_TOOL_REFUSED", kind: "refused", step: step.id, item, message: short(target.message) });
            if (stopOnError) {
              stop = { code: "CHAIN_STOPPED_ON_ERROR", message: `Stopped at step ${step.id}: on_error is stop.` };
              break;
            }
            continue;
          }
          const got = await readOnce(step, target, resolved, { item });
          if (got === null) break;
          rows.push(...got);
        }
        if (missing)
          issues.push({
            code: "CHAIN_EACH_NO_VALUE",
            step: step.id,
            count: missing,
            message: `${missing} rows of ${step.each.from} had no ${step.each.value}; no call was made for them.`,
          });
        if (stop) break;
      }
      produced.set(step.id, rows);
      continue;
    }
    const kind = STEP_KINDS.find((name) => Object.hasOwn(step, name));
    const rows = [];
    keep(transform(kind, step[kind], produced.get(step.from)), rows);
    produced.set(step.id, rows);
  }

  const buildChanged = Boolean(stop?.build);
  if (stop) issues.push({ code: stop.code, message: stop.message });
  const status = stop ? "stopped" : ran.failed || ran.refused || memoryFull || Object.values(notSeen).some((count) => count > 0) ? "partial" : "completed";
  const distinct = [];
  for (const entry of headers) if (!distinct.some((seen) => sameValue(seen.header, entry.header))) distinct.push(entry);
  const output = {
    status,
    ran,
    basis: [...basis.values()],
    header: distinct.length === 1 ? distinct[0].header : [],
    ...(distinct.length > 1 ? { headers: distinct } : {}),
    results: {},
    notSeen,
    issues,
    persisted: false,
    grantsAuthorization: false,
  };
  // Rows are added in return order while the answer stays within max_bytes.
  const pending = [];
  for (const entry of input.return) {
    const all = buildChanged ? [] : (produced.get(entry.from) ?? []);
    const limited = entry.limit === undefined ? all : all.slice(0, entry.limit);
    const result = { total: all.length, returned: 0, cut: all.length, ...(produced.has(entry.from) || buildChanged ? {} : { reached: false }), rows: [] };
    output.results[entry.from] = result;
    pending.push({ result, rows: limited });
  }
  // Filled once; when the bound is met, filled again with the status and the
  // issue that say so, so the answer as sent stays within max_bytes.
  const fill = () => {
    let size = bytesOf(output);
    for (const { result, rows } of pending) {
      for (const row of rows) {
        const added = bytesOf(row) + (result.rows.length ? 1 : 0);
        if (size + added > maxBytes) return true;
        result.rows.push(row);
        result.returned += 1;
        result.cut -= 1;
        size += added;
      }
    }
    return false;
  };
  if (fill()) {
    for (const { result } of pending) {
      result.rows = [];
      result.cut += result.returned;
      result.returned = 0;
    }
    if (output.status === "completed") output.status = "partial";
    output.issues.push({ code: "CHAIN_BYTES_LIMIT", message: `The answer reached max_bytes ${maxBytes}; later rows were cut (see cut).` });
    fill();
  }
  return output;
}
