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

// An action is either the operation's suffix after the group name (`prepare` in
// lode_bounded_worker selects lode_bounded_worker_prepare) or, for an operation
// named after another noun, an explicit { action, operation } pair whose action is
// the operation name without its lode_ prefix (`release_observe` in lode_delivery
// selects lode_release_observe).
const other = (operation) => ({ action: operation.replace(/^lode_/, ""), operation });

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
  {
    name: "lode_project_document",
    summary: "Prepare, publish or inspect the Project document projection.",
    actions: ["prepare", "publish", "status"],
  },
  {
    name: "lode_work_document",
    summary: "Configure, prepare, publish or inspect work document projections.",
    actions: ["configure", "prepare", "publish", "status"],
  },
  {
    name: "lode_onboarding",
    summary: "Guide, refresh, restore, review or inspect optional Lode onboarding candidates.",
    actions: ["guide", "semantic_refresh", "candidate_restore", "review", "status"],
  },
  {
    name: "lode_project_bundle",
    summary: "Export, read or import a portable Project bundle.",
    actions: ["export", "read", "import"],
  },
  {
    name: "lode_product",
    summary: "Record and review Product signals, hypotheses, initiatives, outcomes and policy candidates.",
    actions: [
      "signal_record",
      "hypothesis_record",
      "initiative_propose",
      "initiative_review",
      "outcome_observe",
      "operating_status",
      "policy_propose",
      "policy_review",
      "policy_status",
      "policy_candidate",
      "policy_review_decision",
    ],
  },
  {
    name: "lode_metric",
    summary: "Define, observe, compare, assess and trace Product metrics.",
    actions: ["define", "observe", "compare", "assess", "status", "trace"],
  },
  {
    name: "lode_delivery",
    summary: "Record or inspect delivery and release observations.",
    actions: ["observe", "status", other("lode_release_observe"), other("lode_release_status")],
  },
  {
    name: "lode_runtime",
    summary: "Inspect runtime adapters, invocation authorizations and results, and runtime state.",
    actions: ["adapters", "invocation_authorization", "invocation_result", "state"],
  },
  {
    name: "lode_feature_mapping",
    summary: "Propose, review or inspect feature mapping candidates.",
    actions: ["propose", "status", "review"],
  },
  {
    name: "lode_vcs",
    summary: "Inspect change sets, VCS evidence and Git history.",
    actions: [other("lode_change_set_status"), "evidence", other("lode_git_history")],
  },
  {
    name: "lode_conformance",
    summary: "Prepare, propose, queue, read and dispose conformance findings and their triggers.",
    actions: ["prepare", "propose", "queue", "read", "disposition", "resolution_propose", "trigger_status", "trigger_prepare"],
  },
  {
    name: "lode_source",
    summary: "Select source context or read source observations.",
    actions: ["context", "observation_read"],
  },
  {
    name: "lode_context",
    summary: "Prepare or preview a context selection, or read one context Capsule.",
    actions: ["prepare", "preview", "capsule"],
  },
  {
    name: "lode_session",
    summary: "Record or read Session work evidence, or continue a Session in a runtime.",
    actions: ["work_record", "work_read", "continue"],
  },
  {
    name: "lode_run",
    summary: "Start a Run, read its integration or integrate its checkpoint.",
    actions: ["integrate_checkpoint", "integration", "start"],
  },
  {
    name: "lode_world",
    summary: "Read or query the derived World model.",
    actions: ["model", "query"],
  },
  {
    name: "lode_projection",
    summary: "Inspect and maintain graph, GraphDB, Markdown and post-refresh projections and their refresh triggers.",
    actions: [
      other("lode_incremental_refresh_status"),
      other("lode_incremental_refresh_receipt"),
      other("lode_refresh_trigger_status"),
      other("lode_refresh_trigger_delivery"),
      other("lode_graph_projection_status"),
      other("lode_graphdb_projection_status"),
      other("lode_graphdb_database_status"),
      other("lode_graphdb_connection_preflight"),
      other("lode_graphdb_database_initialize"),
      other("lode_graphdb_projection_activate"),
      other("lode_markdown_projection_build"),
      other("lode_markdown_projection_status"),
      other("lode_post_refresh_projection_status"),
      other("lode_post_refresh_projection_receipt"),
    ],
  },
  {
    name: "lode_document_change",
    summary: "Read document change candidates, reviews and applications.",
    actions: ["candidates", "review_status", "review", "application"],
  },
  {
    name: "lode_graph_lineage",
    summary: "Inspect, trace or diff graph lineage.",
    actions: ["status", "trace", "diff"],
  },
  {
    name: "lode_compact",
    summary: "Prepare, verify, continue, inspect or abort one compaction epoch, or run one compaction lifecycle step.",
    actions: ["prepare", "verify", "continue", "status", "abort", other("lode_compaction_lifecycle_step")],
  },
  {
    name: "lode_observation",
    summary: "List sources, prepare, collect, ingest, derive, read and query observations.",
    actions: ["sources", "prepare", "collect_source", "ingest", "derive", "read", "query"],
  },
];

export const OPERATION_GROUPS = Object.freeze(
  GROUPS.map(({ name, summary, actions }) =>
    Object.freeze({
      name,
      summary,
      actions: Object.freeze(
        actions.map((entry) => Object.freeze(typeof entry === "string" ? { action: entry, operation: `${name}_${entry}` } : { ...entry })),
      ),
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
