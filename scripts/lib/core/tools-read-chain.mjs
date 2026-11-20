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
  minBytes: 4096,
  memoryBytes: 16 * 1024 * 1024,
  inputBytes: 64 * 1024,
  conditionDepth: 2,
  inValues: 100,
  pickFields: 32,
  pathSegments: 4,
  nestingDepth: 32,
  messageChars: 500,
  itemChars: 120,
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
    "Run several read-only Lode tool calls as one declarative step list inside the server and return only the rows asked for, with Lode-counted totals and one everythingSeen verdict. Steps: read (one call), each+read (one call per earlier row), where, pick, sort, limit, unique, count. Only tools that declare their completeness can be inner calls (lode_product_graph_query, lode_project_graph). Grants nothing and writes nothing. Full step reference: lode_tools_discover with name lode_tools_read_chain.",
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
    read: "{ id, read: { name, arguments }, take?, pages?: 1..10 } — one call of a tool that may be an inner call (the same route as lode_tools_read). take names where the row list is in the result (a dotted path; default the tool's declared row list); a result without a list there becomes one row and is counted as not fully seen. pages follows the tool's own next-page arguments and appends the rows (only for a tool that declares them).",
    each: '{ id, each: { from, value, max?: 1..20 }, read: { name, arguments }, take?, pages? } — one call per row of an earlier step, in order; value names the field handed over; an argument { "$item": true } is that value; max counts the step\'s inner calls, pages included. Rows without the value get no call and are counted (notSeen.eachNoValue): filter them out first. Each produced row carries item.',
    where:
      "{ id, from, where: condition } — keep rows matching. condition: { field, <op>: value } with op one of eq, ne, in, contains, startsWith, exists, gte, lte; or { all: [conditions] } / { any: [conditions] }, nested at most two levels.",
    pick: "{ id, from, pick: [fields] } — keep the named fields; a dotted path keeps its nesting, so later steps address it by the same path.",
    sort: "{ id, from, sort: { by, order?: asc|desc } } — stable; numbers by value, text by UTF-16 code units, missing and null values last.",
    limit: "{ id, from, limit: n } — the first n rows.",
    unique: "{ id, from, unique: { by } } — one row per value of the field, the first wins.",
    count:
      "{ id, from, count: { by } } — rows { value, count } per value of the field, in first-seen order; rows without the field are one row { value: null, missing: true, count }.",
  },
  arguments:
    'A literal JSON value, or { "$item": true } as a whole argument value inside each+read. No interpolation, expressions, regular expressions or branching.',
  fields: "A field is a name or a dotted path (at most 4 parts) into a row.",
  rows: "Every step yields a list of plain-object rows; a list entry that is not an object becomes { value }.",
  bounds: {
    steps: READ_CHAIN_LIMITS.steps,
    innerCallsIncludingPages: READ_CHAIN_LIMITS.calls,
    callsOfOneEachIncludingPages: READ_CHAIN_LIMITS.eachCalls,
    pagesOfOneRead: READ_CHAIN_LIMITS.pages,
    returnedBytes: { default: READ_CHAIN_LIMITS.defaultBytes, min: READ_CHAIN_LIMITS.minBytes, max: READ_CHAIN_LIMITS.maxBytes },
    intermediateBytes: READ_CHAIN_LIMITS.memoryBytes,
    inputBytes: READ_CHAIN_LIMITS.inputBytes,
    inValues: READ_CHAIN_LIMITS.inValues,
    pickFields: READ_CHAIN_LIMITS.pickFields,
    pathParts: READ_CHAIN_LIMITS.pathSegments,
    conditionNesting: READ_CHAIN_LIMITS.conditionDepth,
    inputNesting: READ_CHAIN_LIMITS.nestingDepth,
  },
  statuses: {
    completed: "Everything ran without a failure or a bound.",
    partial:
      "A bound was reached, a tool said its answer was cut, or an inner call failed or was refused; the answer holds what was reached and counts the rest.",
    stopped: "The product graph build or baseline changed between calls (no rows are returned), on_error stop met a failed call, or the request was cancelled.",
    refused: "The step list is invalid; no inner call ran.",
  },
  everythingSeen:
    "Lode's verdict: true only when the status is completed, no inner call failed or was refused, every notSeen count is 0, no rows were cut and every returned step was reached. notSeenBecause names the reasons when it is false.",
  innerTools:
    "Only tools that declare their completeness (how they say no answer, more pages and cut) can be inner calls: lode_product_graph_query and lode_project_graph (not with inventory_page). Every other tool is refused with CHAIN_TOOL_NOT_CHAINABLE before any call. Neither keeps any per-caller state, so a chain changes nothing a later call may do or is given.",
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
      {
        id: "pointing",
        from: "callers",
        where: {
          all: [
            { field: "kind", eq: "node" },
            { field: "depth", gte: 1 },
          ],
        },
      },
      { id: "busy", from: "pointing", count: { by: "item" } },
      { id: "top", from: "busy", sort: { by: "count", order: "desc" } },
    ],
    return: [{ from: "top", limit: 10 }],
  },
});

// How deep the input nests, without recursion (a deep literal is refused, not a crash).
function nestingDepth(value, limit) {
  const stack = [[value, 1]];
  let deepest = 0;
  while (stack.length) {
    const [current, depth] = stack.pop();
    if (current === null || typeof current !== "object") continue;
    deepest = Math.max(deepest, depth);
    if (deepest > limit) return deepest;
    for (const child of Array.isArray(current) ? current : Object.values(current)) stack.push([child, depth + 1]);
  }
  return deepest;
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
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
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
  if (nestingDepth(input, READ_CHAIN_LIMITS.nestingDepth) > READ_CHAIN_LIMITS.nestingDepth)
    return [{ code: "CHAIN_INVALID", at: "", message: `The chain input nests deeper than ${READ_CHAIN_LIMITS.nestingDepth} levels.` }];
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
      const placeholder = isObject(args) ? Object.fromEntries(Object.entries(args).map(([key, value]) => [key, isItemReference(value) ? "" : value])) : {};
      const pagedTarget = isObject(read) && typeof read.name === "string" && resolveTarget ? resolveTarget(read.name, placeholder) : null;
      if (step.pages > 1 && pagedTarget?.ok && !pagedTarget.completeness?.pages) add(`${at}.pages`, `${read.name} has no next-page arguments to follow.`);
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
        const parts = fieldPath(field);
        const value = fieldValue(row, parts);
        if (value === undefined) continue;
        let place = picked;
        for (const part of parts.slice(0, -1)) place = isObject(place[part]) ? place[part] : (place[part] = {});
        place[parts.at(-1)] = value;
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
      if (!counts.has(key)) counts.set(key, value === undefined ? { value: null, missing: true, count: 0 } : { value, count: 0 });
      counts.get(key).count += 1;
    }
    return [...counts.values()];
  }
  return rows;
}

// ---------- running ----------

const short = (text, limit = READ_CHAIN_LIMITS.messageChars) => {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
};
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const asRow = (entry) => (isObject(entry) ? entry : { value: entry });
const digits = (number) => String(number).length;
// A handed-over item as an issue shows it: short text, or a short JSON form.
const shownItem = (item) => (typeof item === "string" ? short(item, READ_CHAIN_LIMITS.itemChars) : short(JSON.stringify(item), READ_CHAIN_LIMITS.itemChars));
const yieldToEvents = () => new Promise((resolve) => setImmediate(resolve));
const matchesSpec = (value, spec) => {
  const found = fieldValue(value, fieldPath(spec.field));
  if (Object.hasOwn(spec, "in")) return spec.in.includes(found);
  if (Object.hasOwn(spec, "eq")) return found === spec.eq;
  if (Object.hasOwn(spec, "gt")) return typeof found === "number" && found > spec.gt;
  if (Object.hasOwn(spec, "nonEmpty")) return Array.isArray(found) ? found.length > 0 : isObject(found) && Object.keys(found).length > 0;
  return false;
};

// The tool's own signals that rows or content are missing from an answer,
// as its completeness declaration lists them: the names of those that hold.
// A row signal holds when any row matches it (and not its "except").
export function saidIncomplete(value, signals = []) {
  const said = [];
  for (const signal of signals) {
    if (signal.handledBy) continue;
    const holds = signal.rows
      ? (fieldValue(value, fieldPath(signal.rows)) ?? []).some?.((row) => matchesSpec(row, signal) && !(signal.except && matchesText(row, signal.except)))
      : matchesSpec(value, signal);
    if (holds) said.push(signal.name);
  }
  return said;
}
const matchesText = (row, spec) => {
  const found = fieldValue(row, fieldPath(spec.field));
  return typeof found === "string" && found.includes(spec.contains);
};

// What a tool says about its own coverage outside its rows, as declared.
function statedCoverage(value, stated = {}) {
  const out = {};
  for (const [name, field] of Object.entries(stated)) {
    let found = fieldValue(value, fieldPath(field));
    if (Array.isArray(found))
      found = found.slice(0, 8).map((entry) => (isObject(entry) ? { layer: entry.layer ?? null, reasonCode: entry.reasonCode ?? null } : entry));
    if (found !== undefined) out[name] = found;
  }
  return out;
}

// Reads one inner response against the tool's declared completeness: an
// answer, a refusal, a failure, or a changed build basis. A non-answer is
// never a row.
function innerOutcome(response, completeness) {
  if (!response) return { failure: { kind: "failed", code: "CHAIN_INNER_NO_RESPONSE", message: "The inner call returned nothing." } };
  if (response.error)
    return { failure: { kind: "failed", code: response.error.data?.reasonCode || "CHAIN_INNER_CALL_FAILED", message: short(response.error.message) } };
  const result = response.result || {};
  const text = result.content?.find?.((entry) => entry?.type === "text")?.text;
  if (result.isError) return { failure: { kind: "failed", code: "CHAIN_INNER_CALL_FAILED", message: short(text) } };
  const value = result.structuredContent;
  if (!isObject(value)) return { failure: { kind: "failed", code: "CHAIN_INNER_NOT_AN_ANSWER", message: "The inner call returned no structured answer." } };
  if (matchesSpec(value, completeness.answered)) return { value };
  const code = completeness.code.map((field) => fieldValue(value, fieldPath(field))).find((found) => typeof found === "string") || "CHAIN_INNER_NOT_AN_ANSWER";
  const message = short(
    completeness.message.map((field) => fieldValue(value, fieldPath(field))).find((found) => typeof found === "string") ?? `${value.status ?? "no status"}`,
  );
  if (completeness.basisChanged && matchesSpec(value, completeness.basisChanged))
    return { basisChanged: true, failure: { kind: "failed", code, message }, value };
  if (completeness.refused && matchesSpec(value, completeness.refused)) return { failure: { kind: "refused", code, message }, value };
  return { failure: { kind: "failed", code, message }, value };
}

function rowsOf(value, take, defaultTake) {
  const list = fieldValue(value, fieldPath(take ?? defaultTake));
  return Array.isArray(list) ? { rows: list.map(asRow), listed: true } : { rows: [asRow(value)], listed: false };
}

const EMPTY_NOT_SEEN = () => ({
  pagesLeft: 0,
  itemsLeft: 0,
  eachSkipped: 0,
  eachNoValue: 0,
  callsSkipped: 0,
  rowsDropped: 0,
  answersSaidIncomplete: 0,
  takeNotAList: 0,
});

// Runs a chain. call(name, args) performs one lode_tools_read call and returns
// its JSON-RPC response; resolveTarget is the validation resolver above and
// gives each target its declared completeness.
export async function runReadChain(input, { resolveTarget, call, signal } = {}) {
  const problems = validateReadChain(input, { resolveTarget });
  if (problems.length) {
    const refused = {
      status: "refused",
      everythingSeen: false,
      notSeenBecause: [],
      ran: { steps: 0, calls: 0, failed: 0, refused: 0 },
      basis: [],
      header: [],
      results: {},
      notSeen: EMPTY_NOT_SEEN(),
      issues: problems.map((problem) => ({ ...problem, message: short(problem.message), at: short(problem.at, READ_CHAIN_LIMITS.itemChars) })),
      persisted: false,
      grantsAuthorization: false,
    };
    // The caller's max_bytes when it is itself valid, the default otherwise.
    const valid = Number.isInteger(input?.max_bytes) && input.max_bytes >= READ_CHAIN_LIMITS.minBytes && input.max_bytes <= READ_CHAIN_LIMITS.maxBytes;
    return fitAnswer(refused, [], valid ? input.max_bytes : READ_CHAIN_LIMITS.defaultBytes);
  }
  const stopOnError = input.on_error === "stop";
  const maxBytes = input.max_bytes ?? READ_CHAIN_LIMITS.defaultBytes;
  const ran = { steps: 0, calls: 0, failed: 0, refused: 0 };
  const notSeen = EMPTY_NOT_SEEN();
  const issues = [];
  const basis = new Map();
  const headers = [];
  const produced = new Map();
  let memory = 0;
  let memoryFull = false;
  let stop = null;
  let pinnedBuild = null;
  const toolSaid = new Set();

  const addIssue = (issue) => {
    const same = issues.find((seen) => seen.code === issue.code && seen.step === issue.step && seen.kind === issue.kind);
    if (same) same.count = (same.count ?? 1) + (issue.count ?? 1);
    else issues.push(issue);
  };
  const keep = (rows, list) => {
    for (const row of rows) {
      const size = bytesOf(row);
      if (memoryFull || memory + size > READ_CHAIN_LIMITS.memoryBytes) {
        if (!memoryFull)
          addIssue({ code: "CHAIN_MEMORY_LIMIT", message: `Intermediate rows reached ${READ_CHAIN_LIMITS.memoryBytes} bytes; later rows were dropped.` });
        memoryFull = true;
        notSeen.rowsDropped += 1;
        continue;
      }
      memory += size;
      list.push(row);
    }
  };
  const supplied = (target, args) => (target.declaresProjectRoot && args.project_root === undefined ? { project_root: input.project_root, ...args } : args);
  const fail = (step, outcome, extra) => {
    ran[outcome.failure.kind] += 1;
    addIssue({ code: outcome.failure.code, kind: outcome.failure.kind, step: step.id, ...extra, message: outcome.failure.message });
    if (stopOnError) stop = { code: "CHAIN_STOPPED_ON_ERROR", message: `Stopped at step ${step.id}: on_error is stop.` };
  };
  const leftOver = (remaining) => {
    notSeen.pagesLeft += 1;
    if (Number.isInteger(remaining)) notSeen.itemsLeft += remaining;
  };

  // One read with its pages, within budget.left calls of its step. Appends to
  // rows. Returns "skipped" when no call could be made.
  const readOnce = async (step, target, args, extra, budget, rows) => {
    let current = supplied(target, args);
    const completeness = target.completeness;
    let remainingBefore = null;
    for (let page = 1; ; page += 1) {
      // Lets a cancellation notice be read before the next inner call.
      await yieldToEvents();
      if (signal?.aborted) {
        stop = { code: "CHAIN_CANCELLED", message: "The request was cancelled; no further inner call was made." };
        return "stopped";
      }
      if (ran.calls >= READ_CHAIN_LIMITS.calls || memoryFull || budget.left <= 0) {
        if (page === 1) return "skipped";
        leftOver(remainingBefore);
        return "done";
      }
      ran.calls += 1;
      budget.left -= 1;
      const outcome = innerOutcome(await call(target.name, current), completeness);
      const value = outcome.value;
      if (!basis.has(target.operation))
        basis.set(target.operation, {
          tool: target.operation,
          pinned: Boolean(completeness.identity),
          ...(completeness.identity && isObject(value) ? { builtAt: value.builtAt ?? null, freshness: value.freshness?.text ?? null } : {}),
        });
      // One build: an answer read from another build than the first one stops
      // the chain, and so does a later page whose basis changed.
      // A basis change on a first page is that call's own failure (its own
      // expected_basis_sha256 argument), not a change between calls.
      const identity = completeness.identity && isObject(value) ? fieldValue(value, fieldPath(completeness.identity)) : undefined;
      if (typeof identity === "string") {
        pinnedBuild ??= identity;
        if (identity !== pinnedBuild) outcome.buildChanged = true;
      }
      if (outcome.basisChanged && page > 1) outcome.buildChanged = true;
      if (outcome.buildChanged) {
        stop = {
          code: "CHAIN_BUILD_CHANGED",
          message: "The product graph build or its baseline changed between inner calls; no rows of either are returned.",
          build: true,
        };
        return "stopped";
      }
      if (outcome.failure) {
        fail(step, outcome, extra);
        if (page > 1) leftOver(remainingBefore);
        return stop ? "stopped" : "done";
      }
      if (Array.isArray(value.header)) headers.push({ step: step.id, header: value.header });
      // What the tool says about its coverage reaches the model once per tool.
      if (completeness.stated) {
        const entry = basis.get(target.operation);
        const stated = statedCoverage(value, completeness.stated);
        entry.stated ??= [];
        if (entry.stated.length < 4 && !entry.stated.some((seen) => sameValue(seen, stated))) entry.stated.push(stated);
      }
      // Whatever the answer says is missing from itself makes the chain say so.
      const said = saidIncomplete(value, completeness.signals);
      if (said.length) {
        notSeen.answersSaidIncomplete += 1;
        for (const name of said) toolSaid.add(`TOOL_SAID:${target.operation}:${name}`);
        addIssue({ code: "CHAIN_TOOL_SAID_INCOMPLETE", step: step.id, message: `${target.operation} said: ${said.join(", ")}.` });
      }
      const taken = rowsOf(value, step.take, completeness.rows);
      if (!taken.listed) {
        notSeen.takeNotAList += 1;
        addIssue({
          code: "CHAIN_TAKE_NOT_A_LIST",
          step: step.id,
          message: `The result has no list at ${step.take ?? completeness.rows}; the whole result is one row.`,
        });
      }
      keep(extra.item === undefined ? taken.rows : taken.rows.map((row) => ({ ...row, item: extra.item })), rows);
      const next = completeness.pages ? fieldValue(value, fieldPath(completeness.pages.next)) : undefined;
      if (!isObject(next)) return "done";
      remainingBefore = fieldValue(value, fieldPath(completeness.pages.remaining));
      if (page >= (step.pages ?? 1) || memoryFull) {
        leftOver(remainingBefore);
        return "done";
      }
      // The next page as the tool gave it; a grouped name keeps its action.
      current = supplied(target, target.name !== target.operation ? { ...next, action: args.action } : next);
    }
  };

  for (const step of input.steps) {
    if (stop) break;
    ran.steps += 1;
    const rows = [];
    if (Object.hasOwn(step, "read")) {
      const args = step.read.arguments ?? {};
      if (!step.each) {
        const got = await readOnce(step, resolveTarget(step.read.name, args), args, {}, { left: READ_CHAIN_LIMITS.calls }, rows);
        if (got === "skipped") notSeen.callsSkipped += 1;
      } else {
        const parts = fieldPath(step.each.value);
        const budget = { left: step.each.max ?? READ_CHAIN_LIMITS.eachCalls };
        const source = produced.get(step.each.from);
        let noValue = 0;
        for (const [index, row] of source.entries()) {
          if (stop) break;
          const item = fieldValue(row, parts);
          if (item === undefined || item === null) {
            noValue += 1;
            continue;
          }
          // Items past the step's own max are eachSkipped; items it would still
          // allow but the chain's call bound blocks are callsSkipped.
          if (budget.left <= 0 || ran.calls >= READ_CHAIN_LIMITS.calls) {
            const rest = source.slice(index).filter((entry) => ![undefined, null].includes(fieldValue(entry, parts))).length;
            const blocked = ran.calls >= READ_CHAIN_LIMITS.calls ? Math.min(rest, budget.left) : 0;
            notSeen.callsSkipped += blocked;
            notSeen.eachSkipped += rest - blocked;
            break;
          }
          const resolved = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, isItemReference(value) ? item : value]));
          const target = resolveTarget(step.read.name, resolved);
          if (!target.ok) {
            fail(step, { failure: { kind: "refused", code: target.code || "CHAIN_TOOL_REFUSED", message: short(target.message) } }, { item });
            continue;
          }
          const got = await readOnce(step, target, resolved, { item }, budget, rows);
          if (got === "skipped") notSeen.callsSkipped += 1;
        }
        if (noValue) {
          notSeen.eachNoValue += noValue;
          addIssue({
            code: "CHAIN_EACH_NO_VALUE",
            step: step.id,
            count: noValue,
            message: `Rows of ${step.each.from} without ${step.each.value} get no call; filter them out first.`,
          });
        }
      }
      produced.set(step.id, rows);
      continue;
    }
    const kind = STEP_KINDS.find((name) => Object.hasOwn(step, name));
    keep(transform(kind, step[kind], produced.get(step.from)), rows);
    produced.set(step.id, rows);
  }

  const buildChanged = Boolean(stop?.build);
  if (stop) addIssue({ code: stop.code, message: stop.message });
  // Issues name the step and the item they came from (shortened); after a
  // build change they carry codes and counts only, no content of either build.
  for (const issue of issues) {
    if (issue.item !== undefined && !buildChanged) issue.item = shownItem(issue.item);
    else delete issue.item;
    if (buildChanged && issue.code !== "CHAIN_BUILD_CHANGED") delete issue.message;
  }
  // After a build change nothing of either build remains: not even the first
  // build's time and freshness.
  if (buildChanged) for (const [tool, entry] of basis) basis.set(tool, { tool, pinned: entry.pinned });
  const distinct = [];
  if (!buildChanged) for (const entry of headers) if (!distinct.some((seen) => sameValue(seen.header, entry.header))) distinct.push(entry);
  const output = {
    status: stop ? "stopped" : ran.failed || ran.refused || memoryFull || Object.values(notSeen).some((count) => count > 0) ? "partial" : "completed",
    everythingSeen: false,
    notSeenBecause: [],
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
  const pending = [];
  for (const entry of input.return) {
    const all = buildChanged ? [] : (produced.get(entry.from) ?? []);
    const limited = entry.limit === undefined ? all : all.slice(0, entry.limit);
    const result = { total: all.length, returned: 0, cut: all.length, ...(produced.has(entry.from) || buildChanged ? {} : { reached: false }), rows: [] };
    output.results[entry.from] = result;
    pending.push({ result, rows: limited });
  }
  return fitAnswer(output, pending, maxBytes, buildChanged ? [] : [...toolSaid]);
}

// Lode's own verdict: everything was seen only when none of these holds.
function seenVerdict(output, toolReasons) {
  const reasons = [];
  if (output.status !== "completed") reasons.push(`STATUS_${output.status.toUpperCase()}`);
  if (output.ran.failed) reasons.push("INNER_CALL_FAILED");
  if (output.ran.refused) reasons.push("INNER_CALL_REFUSED");
  for (const [key, count] of Object.entries(output.notSeen)) if (count > 0) reasons.push(`NOT_SEEN_${key}`);
  if (Object.values(output.results).some((result) => result.cut > 0)) reasons.push("ROWS_CUT");
  if (Object.values(output.results).some((result) => result.reached === false)) reasons.push("STEP_NOT_REACHED");
  reasons.push(...toolReasons);
  return reasons;
}

// The answer as sent is at most maxBytes. When even the answer without rows
// does not fit, it is made smaller step by step (issue messages and items,
// then headers, then issues to counts by code, then basis to tool names);
// then rows are added in return order while they fit.
function fitAnswer(output, pending, maxBytes, toolReasons = []) {
  const reduce = [
    () => {
      for (const issue of output.issues) {
        delete issue.message;
        delete issue.item;
        delete issue.at;
      }
    },
    () => {
      if (output.header.length) output.headerOmitted = output.header.length;
      output.header = [];
      if (output.headers) {
        output.headersOmitted = output.headers.length;
        delete output.headers;
      }
    },
    () => {
      const counts = {};
      for (const issue of output.issues) counts[issue.code] = (counts[issue.code] ?? 0) + (issue.count ?? 1);
      output.issues = Object.entries(counts).map(([code, count]) => ({ code, count }));
    },
    () => {
      output.basis = output.basis.map((entry) => ({ tool: entry.tool, pinned: entry.pinned }));
    },
    () => {
      // Tool reasons as counts, when even their names do not fit.
      if (toolReasons.length > 1) toolReasons.splice(0, toolReasons.length, `TOOL_SAID_INCOMPLETE:${toolReasons.length}`);
    },
  ];
  const verdict = () => {
    const reasons = seenVerdict(output, toolReasons);
    output.everythingSeen = reasons.length === 0;
    output.notSeenBecause = reasons;
  };
  // Room for what a cut adds: the bytes issue, a status change and two reasons.
  // (Each reduction step keeps everythingSeen and its reasons.)
  const RESERVE = bytesOf({ code: "CHAIN_BYTES_LIMIT" }) + 1 + bytesOf(["STATUS_PARTIAL", "ROWS_CUT"]);
  verdict();
  for (const step of reduce) {
    if (bytesOf(output) + RESERVE <= maxBytes) break;
    step();
  }
  let size = bytesOf(output);
  let full = false;
  for (const { result, rows } of pending) {
    for (const row of rows) {
      const added =
        bytesOf(row) + (result.rows.length ? 1 : 0) + (digits(result.returned + 1) - digits(result.returned)) + (digits(result.cut - 1) - digits(result.cut));
      if (full || size + added + RESERVE > maxBytes) {
        full = true;
        break;
      }
      result.rows.push(row);
      result.returned += 1;
      result.cut -= 1;
      size += added;
    }
  }
  if (full) {
    if (output.status === "completed") output.status = "partial";
    output.issues.push({ code: "CHAIN_BYTES_LIMIT" });
  }
  verdict();
  // A last guard: the answer is never more than maxBytes.
  for (const { result } of [...pending].reverse()) {
    while (bytesOf(output) > maxBytes && result.rows.length) {
      result.rows.pop();
      result.returned -= 1;
      result.cut += 1;
      verdict();
    }
  }
  return output;
}
