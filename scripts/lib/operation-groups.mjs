// MCP surface groups (stage 3-F; user decision 1 of 2026-11-08).
//
// One grouped tool per resource noun carries an `action` enum. Each action is
// exactly one existing operation; a grouped call is rewritten to that operation
// (name + arguments without `action`) before any surface, router, read-only,
// Session, write-guard or argument check, so every later step sees the same call
// as before. The member operations stay registered under their old names, which
// remain callable as deprecated aliases (directly and through the routers) and
// are no longer listed by discovery or the managed tools/list.
//
// Input schemas keep decision 3: a grouped schema declares `action` plus the
// union of its members' fields, and each action's own required/optional rules are
// still checked by that operation after the rewrite (project_root by the MCP
// argument check, the rest by the operation's handler).
import { canonicalOperationName } from "../../compat/head/public-names.mjs";

// Old operation names stay callable for two minor versions after 0.3.
export const DEPRECATED_ALIAS_REMOVAL_VERSION = "0.5.0";

const GROUPS = [
  {
    name: "lode_bounded_worker",
    summary: "Prepare, start, dispatch, wait for and apply one bounded worker execution in the selected Lode Session.",
    actions: ["prepare", "start", "reconcile", "dispatch", "status", "wait", "apply_result"],
  },
  {
    name: "lode_bounded_worker_job",
    summary: "Reconcile or patch one bounded worker job record.",
    actions: ["reconcile", "patch"],
  },
  {
    name: "lode_bounded_worker_wave",
    summary: "Create, read, seal, wait for or abandon one P3 grouping of bounded worker dispatches.",
    actions: ["create", "read", "seal", "status", "results", "wait", "abandon"],
  },
];

export const OPERATION_GROUPS = Object.freeze(
  GROUPS.map(({ name, summary, actions }) =>
    Object.freeze({
      name,
      summary,
      actions: Object.freeze(actions.map((action) => Object.freeze({ action, operation: `${name}_${action}` }))),
    }),
  ),
);

const groupsByName = new Map(OPERATION_GROUPS.map((group) => [group.name, group]));
const memberOf = new Map(OPERATION_GROUPS.flatMap((group) => group.actions.map((entry) => [entry.operation, { group, action: entry.action }])));

// A grouped tool by its canonical or historical head_* name.
export function operationGroup(name) {
  return typeof name === "string" ? (groupsByName.get(canonicalOperationName(name)) ?? null) : null;
}

// The group and action that replace one (canonical) operation name, if any.
export function groupMembership(operationName) {
  return memberOf.get(operationName) ?? null;
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Rewrites one grouped call to its member operation. Returns null for a name that
// is not a group. Throws INVALID_TOOL_ARGUMENTS for a missing or unknown action.
export function resolveGroupedCall(name, args, presentedName = name) {
  const group = operationGroup(name);
  if (!group) return null;
  const actions = group.actions.map((entry) => entry.action);
  const action = isObject(args) ? args.action : undefined;
  const selected = group.actions.find((entry) => entry.action === action);
  if (!selected) {
    const got = !isObject(args) ? "no arguments object" : action === undefined ? "no action" : JSON.stringify(action);
    throw Object.assign(new Error(`Invalid arguments for ${presentedName}: arguments.action must be one of ${actions.join(", ")}; got ${got}.`), {
      code: "INVALID_TOOL_ARGUMENTS",
    });
  }
  const rest = { ...args };
  delete rest.action;
  return { name: selected.operation, arguments: rest, group: group.name, action: selected.action };
}

// The same rewrite for observers (Host bridges, hooks) that must classify a call
// without failing it: an invalid grouped call keeps its own name and arguments,
// and the dispatcher then refuses it.
export function effectiveToolCall(name, args) {
  try {
    const resolved = resolveGroupedCall(name, args);
    return resolved ? { name: resolved.name, arguments: resolved.arguments } : { name, arguments: args };
  } catch {
    return { name, arguments: args };
  }
}

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// One grouped tool definition from its member tool definitions. Field schemas
// that differ between actions are offered as anyOf; the action's own operation
// still decides which form it accepts.
export function groupedToolDefinition(group, memberTools) {
  const members = group.actions.map((entry) => {
    const tool = memberTools.get(entry.operation);
    if (!tool) throw new Error(`Grouped operation is not registered: ${entry.operation}`);
    return { ...entry, tool };
  });
  const variants = new Map();
  for (const { tool } of members) {
    for (const [field, schema] of Object.entries(tool.inputSchema?.properties ?? {})) {
      if (!variants.has(field)) variants.set(field, []);
      const known = variants.get(field);
      if (!known.some((existing) => sameJson(existing, schema))) known.push(schema);
    }
  }
  const properties = {
    action: { type: "string", enum: members.map((member) => member.action), description: "The operation to run; see the per-action fields below." },
  };
  for (const [field, schemas] of variants) properties[field] = schemas.length === 1 ? schemas[0] : { anyOf: schemas };
  const requiredBy = (member) => member.tool.inputSchema?.required ?? [];
  const common = requiredBy(members[0]).filter((field) => members.every((member) => requiredBy(member).includes(field)));
  const every = (hint) => members.every((member) => member.tool.annotations?.[hint] === true);
  const some = (hint) => members.some((member) => member.tool.annotations?.[hint] === true);
  const actionLines = members.map((member) => {
    const required = requiredBy(member).filter((field) => !common.includes(field));
    const route = member.tool.annotations?.readOnlyHint === true ? "read" : "call";
    return `${member.action} (${route}${required.length ? `; requires ${required.join(", ")}` : ""})`;
  });
  return {
    name: group.name,
    description: `${group.summary} Actions: ${actionLines.join("; ")}.${common.length ? ` Every action requires ${common.join(", ")}.` : ""}`,
    inputSchema: { type: "object", properties, required: ["action", ...common], additionalProperties: false },
    annotations: {
      readOnlyHint: every("readOnlyHint"),
      destructiveHint: some("destructiveHint"),
      idempotentHint: every("idempotentHint"),
      openWorldHint: some("openWorldHint"),
    },
  };
}

// The listed catalog: each group replaces its members, at its first member's
// position. Ungrouped operations keep their own definitions (the same objects).
export function groupedCatalog(operationTools) {
  const byName = new Map(operationTools.map((tool) => [tool.name, tool]));
  const emitted = new Set();
  const catalog = [];
  for (const tool of operationTools) {
    const membership = groupMembership(tool.name);
    if (!membership) {
      catalog.push(tool);
      continue;
    }
    if (emitted.has(membership.group.name)) continue;
    emitted.add(membership.group.name);
    catalog.push(groupedToolDefinition(membership.group, byName));
  }
  return catalog;
}
