#!/usr/bin/env node
import readline from "node:readline";
import { resolveOperation } from "./lib/core/lode-operation-contract.mjs";
import { callRegistered, registeredOperation, registryCatalog, WORLD_MODEL_STATUS_MCP_MAX_BYTES } from "./lib/session/operation-registry.mjs";
import { assertProjectRootArgument } from "./lib/core/mcp-argument-validation.mjs";
import { legacyReasonCodeFields } from "./lib/core/errors.mjs";
import { ARTIFACT_COMPOSITION, publicToolName } from "./lib/lode-artifact-composition.mjs";
import { DISCOVERY_PREFIX_PAIRS, legacyOperationName } from "../compat/head/public-names.mjs";
import {
  DEPRECATED_ALIAS_REMOVAL_VERSION,
  effectiveToolCall,
  groupMembership,
  groupedCatalog,
  operationGroup,
  resolveGroupedCall,
} from "./lib/core/operation-groups.mjs";
const semanticToolName = (name) => resolveOperation(name)?.semanticName ?? name;
const presentedTools = new WeakMap();
const presentedTool = (tool) => {
  // Tool prose already says Lode. Only the name is presented per artifact
  // identity: canonical lode_* here, the historical head_* spelling in the
  // head-agent carrier package.
  if (!presentedTools.has(tool)) presentedTools.set(tool, { ...tool, name: publicToolName(tool.name) });
  return presentedTools.get(tool);
};
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isManagedMutation, requireOperationSurface, requireSurface } from "./lib/session/managed-maintenance-surface.mjs";
import { coreEntryGuidance } from "./lib/session/lode-entry-guidance.mjs";
import { formatMcpToolContent } from "./lib/session/cli-presentation.mjs";
import { sessionCallRequiresBinding } from "./lib/session/session-routing.mjs";
import { createNativeSessionHostBridge } from "./lib/session/session-native-host.mjs";
import { SESSION_HOST_REQUEST_HELPER } from "./lib/session/session-host-request.mjs";
import { assessSubagentStateWrite, subagentWriteGuardEnabled } from "./lib/session/subagent-write-guard.mjs";
import { withRecordedProjectRoot } from "./lib/storage/project-root-spelling.mjs";
import fs from "node:fs";

const protocolVersion = "2024-11-05";
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageVersion = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8")).version;
const allTools = [...registryCatalog()];

// The native Host Hook helper (SESSION_HOST_REQUEST_HELPER) is deliberately not a
// catalog tool: it is not listed, discoverable or routable. Only the native
// session bridge accepts it, before any catalog lookup; every other path refuses
// it with NATIVE_HOOK_DIRECT_INGRESS_REQUIRED (see dispatchSessionRequest).
// Listed surface: grouped tools replace their member operations (see
// scripts/lib/core/operation-groups.mjs). allTools keeps every operation for dispatch.
const surfaceTools = groupedCatalog(allTools);
const operationsByName = new Map(allTools.map((tool) => [tool.name, tool]));
const defaultToolNames = new Set([
  "lode_core_contract",
  "lode_project_initialize_or_resume",
  "lode_conversation_enter",
  "lode_conversation_list",
  "lode_conversation_send",
  "lode_project_graph",
  // The unresolved-Session entry names lode_session_list as its discovery call, so
  // it must be directly callable from the default surface, not only via routing.
  "lode_session_create",
  "lode_session_list",
  "lode_project_direction_update",
  "lode_project_status",
  "lode_checkpoint_diagnose",
  "lode_checkpoint_basis",
  "lode_checkpoint_sync",
  "lode_session_restore",
  "lode_pending_review",
  "lode_runtime_invocation_lease_status",
  "lode_bounded_worker_job_status",
  "lode_bounded_worker_cancel",
  "lode_worker_integration_status",
]);
const routedInputSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "Exact tool name from discovery or a known Lode contract." },
    arguments: { type: "object", description: "Arguments following that tool's returned inputSchema; Lode supplies them, not a user form." },
  },
  required: ["name", "arguments"],
  additionalProperties: false,
};
const discoveryTools = [
  {
    name: "lode_tools_discover",
    description:
      "Read optional Lode capability prefixes, or exact schemas by name/prefix. No Project, registration, activation or approval needed. Use only when the task needs Product, Graph, Observation, Context or retained-work diagnostics; page with nextOffset.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "One exact tool name; mutually exclusive with prefix." },
        prefix: { type: "string", description: "A returned tool prefix." },
        offset: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 8 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "lode_tools_read",
    description:
      "Call a discovered read-only Lode tool using its exact inputSchema. Returns the original result and errors. No discovery prerequisite, Project activation or authority change; independent work remains available if an optional capability fails.",
    inputSchema: routedInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "lode_tools_call",
    description:
      "Call a discovered Lode operation using its exact inputSchema within existing user scope. Original authority, current-basis, ownership, replay and maintenance checks still apply. Discovery grants no authorization. Prefer lode_tools_read for read-only operations.",
    inputSchema: {
      ...routedInputSchema,
      properties: {
        ...routedInputSchema.properties,
        execution_mode: {
          type: "string",
          enum: ["ordinary", "managed"],
          default: "ordinary",
          description: "Lode selects managed only for needed durable ownership/recovery/effect guarantees. It grants no new authorization.",
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];
// Complete ordinary schemas for programmatic consumers; tools/list stays small.
// catalogTools is the listed (grouped) catalog; operationCatalogTools keeps every
// operation, including the deprecated names a group replaced.
export const catalogTools = surfaceTools.map(presentedTool);
export const operationCatalogTools = allTools.map(presentedTool);
export function toolsForSurface(surface = "ordinary") {
  requireSurface(surface);
  return [...surfaceTools.filter((tool) => (surface === "managed-maintenance" ? true : defaultToolNames.has(tool.name))), ...discoveryTools].map(presentedTool);
}
export const tools = toolsForSurface();

export function discoverTools({ name, prefix, offset = 0, limit = 8 } = {}, surface = "ordinary") {
  requireSurface(surface);
  if (
    (name != null && typeof name !== "string") ||
    (prefix != null && typeof prefix !== "string") ||
    (name != null && prefix != null) ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 20
  )
    throw new Error("Invalid tool discovery selector or page.");
  const available = surfaceTools.map(presentedTool);
  if (name != null) {
    // A deprecated operation name finds the grouped tool that replaced it.
    const membership = groupMembership(resolveOperation(name)?.semanticName);
    name = publicToolName(membership ? membership.group.name : name);
  }
  if (prefix != null) {
    const known = DISCOVERY_PREFIX_PAIRS.find((pair) => pair.legacy === prefix || pair.canonical === prefix);
    if (known) prefix = ARTIFACT_COMPOSITION.identity === "lode" ? known.canonical : known.legacy;
  }
  const scope = {
    surface,
    persisted: false,
    grantsAuthorization: false,
    managedEntry: `${publicToolName("lode_tools_call")} with execution_mode: managed; original authorization, scope, lease and result checks apply`,
    maintenanceEntry: "scripts/mcp-managed-maintenance.mjs (same managed execution contract; retained reader supported)",
  };
  const matchesPrefix = (tool, selected) => {
    const group = operationGroup(tool.name);
    if (group) {
      // A group matches its own prefix and every prefix its deprecated names matched.
      const spellings = [group.name, ...group.actions.map((entry) => entry.operation)].flatMap((canonical) => [canonical, legacyOperationName(canonical)]);
      return spellings.some((spelling) => `${spelling}_`.startsWith(selected));
    }
    const descriptor = resolveOperation(tool.name);
    return tool.name.startsWith(selected) || descriptor?.legacyName.startsWith(selected) || descriptor?.canonicalName.startsWith(selected);
  };
  if (name == null && prefix == null) {
    // One prefix per leading noun of a listed name. A grouped tool can also match
    // another listed prefix through a deprecated name (lode_projection under
    // lode_graph_), so each count is what that prefix returns.
    const keys = new Set(available.map((tool) => `${ARTIFACT_COMPOSITION.toolPrefix}${tool.name.split("_")[1]}_`));
    return {
      ...scope,
      prefixes: [...keys]
        .sort((a, b) => a.localeCompare(b))
        .map((key) => ({ prefix: key, count: available.filter((tool) => matchesPrefix(tool, key)).length })),
      nextOffset: null,
    };
  }
  const matches = available.filter((tool) => (name != null ? tool.name === name : matchesPrefix(tool, prefix)));
  if (name != null && !matches.length) throw new Error(`Unknown or unavailable tool on ${surface}: ${name}`);
  return {
    ...scope,
    total: matches.length,
    offset,
    nextOffset: offset + limit < matches.length ? offset + limit : null,
    tools: matches.slice(offset, offset + limit).map((tool) => ({
      ...tool,
      invokeWith: publicToolName(tool.annotations?.readOnlyHint === true ? "lode_tools_read" : "lode_tools_call"),
      ...(isManagedMutation(tool.name) ? { executionMode: "managed" } : {}),
      ...groupDiscovery(tool.name),
    })),
  };
}

// Per-action routes of a grouped tool, and the deprecated names it replaced.
function groupDiscovery(name) {
  const group = operationGroup(name);
  if (!group) return {};
  return {
    actions: group.actions.map(({ action, operation }) => {
      const tool = operationsByName.get(operation);
      return {
        action,
        description: tool.description,
        required: tool.inputSchema?.required ?? [],
        invokeWith: publicToolName(tool.annotations?.readOnlyHint === true ? "lode_tools_read" : "lode_tools_call"),
        ...(isManagedMutation(operation) ? { executionMode: "managed" } : {}),
      };
    }),
    deprecatedAliases: group.actions.map(({ action, operation }) => ({ name: publicToolName(operation), action, removedIn: DEPRECATED_ALIAS_REMOVAL_VERSION })),
  };
}

function requestedToolName(request) {
  const routed = ["lode_tools_read", "lode_tools_call"].includes(semanticToolName(request.params?.name));
  const outer = request.params?.arguments;
  return semanticToolName(routed ? effectiveToolCall(outer?.name, outer?.arguments).name : effectiveToolCall(request.params?.name, outer).name);
}

// Rewrites a grouped call (directly or through a router) to its member operation,
// before any other check reads the name or arguments.
function ungroupedRequest(request) {
  if (request.method !== "tools/call") return request;
  const routed = ["lode_tools_read", "lode_tools_call"].includes(semanticToolName(request.params?.name));
  const outer = request.params?.arguments;
  const name = routed ? outer?.name : request.params?.name;
  const resolved = resolveGroupedCall(name, routed ? outer?.arguments : outer, publicToolName(name));
  if (!resolved) return request;
  const params = routed
    ? { ...request.params, arguments: { ...outer, name: resolved.name, arguments: resolved.arguments } }
    : { ...request.params, name: resolved.name, arguments: resolved.arguments };
  return { ...request, params };
}

// Use the shared policy after router unwrap. OpenCode applies it to the exact
// Host before-hook; MCP uses its own caller and optional Codex observations.
// Disabled mode does not read observations.
async function subagentStateWriteRejection(name, args, caller, environment) {
  const selected =
    allTools.find((tool) => semanticToolName(tool.name) === name) ??
    surfaceTools.find((tool) => operationGroup(tool.name) && operationGroup(tool.name) === operationGroup(name));
  if (!selected || selected.annotations?.readOnlyHint === true) return null;
  if (!subagentWriteGuardEnabled(environment, { caller })) return null;
  // A cold catalog or disabled guard must not load optional Codex observations.
  let current = caller && typeof caller === "object" ? { ...caller } : null;
  if (current?.runtime === "codex" && current.subagent !== true && typeof args?.project_root === "string" && typeof current.nativeSessionId === "string") {
    const { recordedSubagentCaller } = await import("./lib/session/subagent-caller-signal.mjs");
    if (recordedSubagentCaller({ root: args.project_root, runtime: "codex", nativeSessionId: current.nativeSessionId, environment }))
      current = { ...current, subagent: true };
  }
  const decision = assessSubagentStateWrite({ caller: current, readOnly: false });
  return decision.allowed ? null : decision.message;
}

const success = (id, result) => ({ jsonrpc: "2.0", id, result });
// Library errors carry a stable reason code (error.code). Keep it on the wire in
// error.data.reasonCode so agents can branch on the documented code, not the text.
const failure = (id, message, reasonCode) => ({
  jsonrpc: "2.0",
  id,
  error: {
    code: -32000,
    message,
    // legacyReasonCode: the historical HEAD_* spelling, for one version (see LEGACY_REASON_CODES).
    ...(typeof reasonCode === "string" && reasonCode ? { data: { reasonCode, ...legacyReasonCodeFields(reasonCode) } } : {}),
  },
});
export { WORLD_MODEL_STATUS_MCP_MAX_BYTES };

async function unresolvedSessionResponse(id, name, root, reasonCode) {
  try {
    const routing = await import("./lib/session/session-routing.mjs");
    const value = routing.sessionSelectionUnresolved(root, {
      includeProjectFacts: ["lode_project_status", "lode_conversation_enter"].includes(name),
      reasonCode,
    });
    // Keep the existing exceptional JSON-text + structuredContent contract.
    // Normal dispatch still uses each tool's own human/JSON presentation.
    return success(id, { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
  } catch (error) {
    return failure(id, error.message, error?.code);
  }
}

export async function dispatch(request, options = {}) {
  if (options.nativeSessionBridge && !options.sessionContext && !options.resolveSessionContext) {
    // Only the bridge grants a held recovery basis, and only to a verified caller.
    const { recoveryBasisMemory: _embedderMemory, ...base } = options;
    return options.nativeSessionBridge.dispatch(request, async (original, routing) => await dispatchSessionRequest(original, { ...base, ...routing }));
  }
  return await dispatchSessionRequest(request, options);
}

async function dispatchSessionRequest(request, options = {}) {
  // A root that differs from the recorded one only in drive-letter case is the
  // same Project (Windows only; a read of project.json, never a write).
  request = withRecordedProjectRoot(request);
  try {
    request = ungroupedRequest(request);
  } catch (error) {
    // An invalid grouped call names no single operation. A guarded child still
    // gets the write-guard refusal first when the group has an effectful action.
    const routedGroup = ["lode_tools_read", "lode_tools_call"].includes(semanticToolName(request.params?.name));
    const outerGroup = request.params?.arguments;
    const rejection = await subagentStateWriteRejection(
      routedGroup ? outerGroup?.name : request.params?.name,
      routedGroup ? outerGroup?.arguments : outerGroup,
      options.caller,
      options.hostEnvironment ?? process.env,
    );
    return failure(request.id ?? null, rejection ?? error.message, rejection ? undefined : error?.code);
  }
  const outer = request.params?.arguments;
  const routed = ["lode_tools_read", "lode_tools_call"].includes(semanticToolName(request.params?.name));
  const args = routed ? outer?.arguments : outer;
  const hasSelection = args && Object.hasOwn(args, "session_id");
  const requestedName = semanticToolName(routed ? outer?.name : request.params?.name);
  // Reached only without the native session bridge, which answers the helper
  // itself. It is not a catalog tool, but a direct or routed call is refused
  // before any Session or catalog step, never reported as an unknown tool.
  if (request.method === "tools/call" && requestedName === semanticToolName(SESSION_HOST_REQUEST_HELPER))
    return failure(request.id ?? null, `${SESSION_HOST_REQUEST_HELPER} accepts only native Host Hook ingress.`, "NATIVE_HOOK_DIRECT_INGRESS_REQUIRED");
  // A verified child write has the same optional policy regardless of whether
  // its caller has selected a logical Session. Reject it before an unrelated
  // absent-binding diagnostic can hide the existing write-guard explanation.
  // Unknown/parent callers and disabled guards retain their normal routing.
  if (request.method === "tools/call") {
    const rejection = await subagentStateWriteRejection(requestedName, args, options.caller, options.hostEnvironment ?? process.env);
    if (rejection) return failure(request.id ?? null, rejection);
    // The Session/location steps below read project_root before dispatch, so a
    // wrong type is refused here; the required/empty checks follow the surface,
    // router and read-only checks inside the routed dispatcher.
    if (args && typeof args === "object" && !Array.isArray(args) && args.project_root !== undefined && typeof args.project_root !== "string") {
      return failure(
        request.id ?? null,
        `Invalid arguments for ${publicToolName(requestedName)}: arguments.project_root must be string, got ${args.project_root === null ? "null" : typeof args.project_root}.`,
        "INVALID_TOOL_ARGUMENTS",
      );
    }
  }
  // Only views/effects that actually consume the selected Session need its
  // binding. Project-scoped Product/Observation/source work is independent.
  const dependent = sessionCallRequiresBinding(requestedName);
  let sessionContext = options.sessionContext;
  let bindingFailure = null;
  if (request.method === "tools/call" && args?.project_root && requestedName === "lode_project_status") {
    try {
      const { inspectProjectLocationExperience } = await import("./lib/session/project-bootstrap.mjs");
      const projectLocationProjection = inspectProjectLocationExperience({ root: args.project_root, sessionId: hasSelection ? args.session_id : undefined });
      if (projectLocationProjection) return await dispatchRouted(request, { ...options, projectLocationProjection });
    } catch (error) {
      return failure(request.id ?? null, error.message, error?.code);
    }
  }
  // Explicit resume validates/adopts the local Project location before an
  // optional native Host adapter can read its binding at that current root.
  // Other tools retain the original selected-Session call boundary unchanged.
  if (
    request.method === "tools/call" &&
    args?.project_root &&
    requestedName === "lode_project_initialize_or_resume" &&
    (hasSelection || sessionContext || options.resolveSessionContext)
  ) {
    try {
      if (hasSelection && typeof args.session_id !== "string")
        throw new Error("An explicit logical Session route must be text; omit it for an unspecified route.");
      const cleanArgs = { ...args };
      delete cleanArgs.session_id;
      const clean = { ...request, params: { ...request.params, arguments: routed ? { ...outer, arguments: cleanArgs } : cleanArgs } };
      const response = await dispatchRouted(clean, {
        ...options,
        projectSessionRoute: {
          sessionId: hasSelection ? args.session_id : undefined,
          context: sessionContext,
          resolveContext: options.resolveSessionContext
            ? async () => {
                try {
                  return await options.resolveSessionContext(request);
                } catch (error) {
                  bindingFailure = error.code || "SESSION_CONTEXT_UNAVAILABLE";
                  throw error;
                }
              }
            : null,
        },
      });
      if (bindingFailure && hasSelection && response?.result)
        response.result._meta = {
          ...response.result._meta,
          headSessionBinding: {
            status: "unavailable",
            reasonCode: bindingFailure,
            ...legacyReasonCodeFields(bindingFailure),
            scope: "current-explicit-request-only",
            retainedForSubsequentCalls: false,
            persisted: false,
          },
        };
      return response;
    } catch (error) {
      return failure(request.id ?? null, error.message, error?.code);
    }
  }
  // Discovery's existing session_id is an exact preview target, never a request
  // to update native persistence, a shared caller context, or the outer route.
  if (request.method === "tools/call" && requestedName === "lode_session_list") return await dispatchRouted(request, options);
  if (args?.project_root && (hasSelection || dependent) && !sessionContext && options.resolveSessionContext) {
    try {
      sessionContext = await options.resolveSessionContext(request);
    } catch (error) {
      if (hasSelection) {
        // Exact explicit routing is independent of optional Host persistence.
        // Existing route validation below still rejects invalid/foreign IDs.
        bindingFailure = error.code || "SESSION_CONTEXT_UNAVAILABLE";
      } else {
        return await unresolvedSessionResponse(request.id ?? null, requestedName, args.project_root, error.code || "SESSION_CONTEXT_UNAVAILABLE");
      }
    }
  }
  if (request.method === "tools/call" && args?.project_root && (hasSelection || sessionContext)) {
    try {
      const name = routed ? outer.name : request.params.name;
      const selected = allTools.find((tool) => semanticToolName(tool.name) === semanticToolName(name));
      if (!selected?.inputSchema?.properties?.session_id) throw new Error("This operation has no project Session route.");
      if (hasSelection && typeof args.session_id !== "string")
        throw new Error("An explicit logical Session route must be text; omit it for an unspecified route.");
      const cleanArgs = { ...args };
      delete cleanArgs.session_id;
      const clean = { ...request, params: { ...request.params, arguments: routed ? { ...outer, arguments: cleanArgs } : cleanArgs } };
      if (!hasSelection && !dependent) return await dispatchRouted(clean, options);
      const { withSessionCallContext } = await import("./lib/session/session-routing.mjs");
      const response = await withSessionCallContext(
        { root: args.project_root, sessionId: hasSelection ? args.session_id : undefined, context: sessionContext },
        async () => await dispatchRouted(clean, options),
      );
      if (bindingFailure && response?.result)
        response.result._meta = {
          ...response.result._meta,
          headSessionBinding: {
            status: "unavailable",
            reasonCode: bindingFailure,
            ...legacyReasonCodeFields(bindingFailure),
            scope: "current-explicit-request-only",
            retainedForSubsequentCalls: false,
            persisted: false,
          },
        };
      return response;
    } catch (error) {
      if (error.code === "SESSION_SELECTION_LOST") {
        return await unresolvedSessionResponse(request.id ?? null, requestedName, args.project_root, error.code);
      }
      return failure(request.id ?? null, error.message, error?.code);
    }
  }
  return await dispatchRouted(request, options);
}

// 4-D (user decision 4-2 (a)). A verified caller may omit
// expected_recovery_basis_id on lode_checkpoint_sync: the server uses the basis it
// last handed this caller for this Project and logical Session, exactly as if it
// were passed. Explicit ids are untouched; unverified callers never get a memory,
// so the operation keeps today's "required" refusal.
async function heldRecoveryBasisCall(name, args, memory) {
  if (name !== "lode_checkpoint_sync" || !args || typeof args !== "object" || args.expected_recovery_basis_id !== undefined) return null;
  const { routedSessionId } = await import("./lib/session/session-routing.mjs");
  // An uninitialized or unreadable Project has no routed Session: leave the
  // call unchanged so the operation gives its own refusal, as on main.
  let sessionId;
  try {
    sessionId = routedSessionId(args.project_root);
  } catch {
    return null;
  }
  if (!sessionId) return null;
  const held = memory.held(args.project_root, sessionId);
  if (!held)
    throw Object.assign(
      new Error(
        `No recovery basis is held for this caller and Session. Call ${publicToolName("lode_checkpoint_basis")}, derive the direction from that basis, then sync.`,
      ),
      { code: "RECOVERY_BASIS_NOT_HELD" },
    );
  return { args: { ...args, expected_recovery_basis_id: held }, sessionId };
}

// Sources of a held basis: lode_checkpoint_basis and a created sync (its resulting
// basis). A conflict or deferral drops it: the caller must read a fresh basis and
// derive again, so repeating the same call cannot win by retry. A diagnosis never
// arms it, and "reused" keeps what is held.
async function rememberRecoveryBasis(name, args, value, memory, heldBasis, entryBasis) {
  if (!value || typeof value !== "object") return;
  rememberDirection(name, args, value, memory);
  if (name === "lode_project_direction_update") {
    if (value.status === "updated") await reArmHeldBases(args.project_root, value.direction, memory);
    return;
  }
  if (name === "lode_conversation_enter" || name === "lode_project_initialize_or_resume") {
    await rememberEntryBasis(name, args, value, memory, entryBasis);
    return;
  }
  if (name === "lode_checkpoint_basis" && value.basis) {
    memory.hold(args.project_root, value.basis.sessionId, value.basis.basisId);
    return;
  }
  if (name !== "lode_checkpoint_sync") return;
  if (value.outcome === "created" && value.resultingBasis) memory.hold(args.project_root, value.resultingBasis.sessionId, value.resultingBasis.basisId);
  else if (value.outcome === "conflict" || value.outcome === "deferred") {
    const sessionId = heldBasis?.sessionId ?? value.basis?.sessionId;
    if (sessionId) memory.drop(args.project_root, sessionId);
  }
}

// 4-D (c), D1: a verified caller may omit expected_direction_id on
// lode_project_direction_update when a direction id is held for it and this
// Project; it is used exactly as if passed. With nothing held the omitted id
// keeps its existing meaning (no current direction). Explicit values, including
// null, are untouched.
function heldDirectionCall(name, args, memory) {
  if (name !== "lode_project_direction_update" || !args || typeof args !== "object" || args.expected_direction_id !== undefined) return args;
  if (typeof args.project_root !== "string") return args;
  const held = memory.heldDirection(args.project_root);
  return held ? { ...args, expected_direction_id: held } : args;
}

// The results that hand a verified caller the current Project direction id:
// only those that also show the direction itself (goal, constraints,
// decisions, cancelled actions). A basis or a created sync carries the id
// alone, so holding it there would let the caller replace a direction, and a
// later shared cancellation, that it was never shown.
function rememberDirection(name, args, value, memory) {
  const directionId =
    name === "lode_project_direction_update"
      ? ["updated", "reused"].includes(value.status) && value.direction?.directionId
      : name === "lode_conversation_enter"
        ? value.projectStatus?.currentProjectDirection?.directionId
        : name === "lode_project_status" || name === "lode_project_initialize_or_resume"
          ? value.currentProjectDirection?.directionId
          : null;
  if (typeof directionId === "string") memory.holdDirection(args.project_root, directionId);
}

// 4-D (c), user rule 2026-11-11: the caller's own direction update must not
// make its next id-less save conflict. For each basis this caller holds on this
// Project, read that Session's basis once (read-only, without changing routing
// or the default Session) and re-arm it only when the update is the one change:
// the new basis carries the returned direction id, and the same payload with
// the previous direction id hashes to the held basis id. Nothing new is held, and
// a failed read leaves that entry as it was.
// Pure re-arm decision, exported for tests: the new basis id, or null.
export function reArmedBasisId(held, basis, direction, basisIdWithDirection) {
  if (!held || !basis || !direction || basis.currentProjectDirectionId !== direction.directionId) return null;
  return basisIdWithDirection(basis, direction.previousDirectionId ?? null) === held ? basis.basisId : null;
}

async function reArmHeldBases(root, direction, memory) {
  try {
    const sessions = memory.heldSessions(root);
    if (!sessions.length) return;
    const { inspectRecoveryCheckpointBasis, recoveryBasisIdWithDirection } = await import("./lib/session/compaction-recovery.mjs");
    const { withSessionRoute } = await import("./lib/session/session-routing.mjs");
    for (const sessionId of sessions) {
      try {
        const basis = withSessionRoute(root, sessionId, () => inspectRecoveryCheckpointBasis({ root }).basis);
        const next = basis.sessionId === sessionId ? reArmedBasisId(memory.held(root, sessionId), basis, direction, recoveryBasisIdWithDirection) : null;
        if (next) memory.hold(root, sessionId, next);
      } catch {
        /* That entry stays as it was; the update result is unchanged. */
      }
    }
  } catch {
    /* Re-arming never fails the update. */
  }
}

// 4-D (b2): a verified caller's successful entry also hands it a basis (held, not
// returned). Conversation entry is read-only, so the basis is read before the
// entry reads that build the returned context; a change after that point shows
// up as a conflict on save instead of being missed.
async function entryRecoveryBasisBefore(name, args) {
  if (name !== "lode_conversation_enter" || typeof args?.project_root !== "string") return null;
  try {
    const { inspectRecoveryCheckpointBasis } = await import("./lib/session/compaction-recovery.mjs");
    return inspectRecoveryCheckpointBasis({ root: args.project_root }).basis;
  } catch {
    return null;
  }
}

// Pure hold decisions for a verified entry (4-D b2), exported for tests. Each
// returns the Session to hold the basis for, or null to hold nothing.
// Conversation entry: a ready entry whose Project status Session is the
// basis Session (the Project status Session is set even when optional work
// evidence is unreadable).
export function entryHoldSession(value, basis) {
  if (!value || !basis || !["conversation_ready", "conversation_direction_restored"].includes(value.status)) return null;
  const sessionId = value.projectStatus?.project?.sessionId ?? value.workContext?.sessionId ?? null;
  return sessionId === basis.sessionId ? sessionId : null;
}

// Initialize-or-resume: the basis was read right before the final read that
// built this result (scripts/lib/session/entry-basis-capture.mjs); hold only when it is
// exactly the returned Session record and Project direction.
export function initHoldSession(value, basis, sessionHash) {
  const sessionId = value?.project?.sessionId;
  if (!basis || !["initialized", "resumed"].includes(value?.projectAction) || typeof sessionId !== "string" || !value.state) return null;
  const matches =
    basis.sessionId === sessionId &&
    basis.sessionRecordHash === sessionHash(value.state) &&
    (basis.currentProjectDirectionId ?? null) === (value.currentProjectDirection?.directionId ?? null);
  return matches ? sessionId : null;
}

async function rememberEntryBasis(name, args, value, memory, entryBasis) {
  let sessionId = null;
  if (name === "lode_conversation_enter") sessionId = entryHoldSession(value, entryBasis);
  else {
    try {
      const { sessionStateHash } = await import("./lib/runtime/run-lineage.mjs");
      sessionId = initHoldSession(value, entryBasis, sessionStateHash);
    } catch {
      sessionId = null;
    }
  }
  if (sessionId) memory.hold(args.project_root, sessionId, entryBasis.basisId);
}

async function dispatchRouted(
  request,
  {
    surface = "ordinary",
    graphDbTransport = null,
    coordinationWorkspaceHost = null,
    observationRegistry = null,
    conformanceTriggerRegistry = null,
    compactionLifecycleHost = null,
    workerJobHost = null,
    workerJobSupervisor = null,
    workerPreparationBackend = null,
    nativeHistoryHost = null,
    signal,
    onProcess,
    onExportScope = null,
    onValidatedSessionSelection = null,
    readRelatedNativeContext = null,
    projectSessionRoute = null,
    projectLocationProjection = null,
    caller = null,
    hostEnvironment = process.env,
    pluginLaunch = null,
    servingModuleUrl = null,
    installationCaller = null,
    recoveryBasisMemory = null,
  } = {},
) {
  requireSurface(surface);
  const id = request.id ?? null;
  if (request.method === "initialize") {
    return success(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: ARTIFACT_COMPOSITION.serverName, version: packageVersion },
      instructions: coreEntryGuidance(),
    });
  }
  if (request.method === "notifications/initialized") return null;
  if (request.method === "tools/list") return success(id, { tools: toolsForSurface(surface) });
  if (request.method !== "tools/call") return failure(id, "Method not found");
  try {
    let name = semanticToolName(request.params?.name);
    let args = request.params?.arguments || {};
    if (name === "lode_tools_discover") {
      const value = discoverTools(args, surface);
      return success(id, { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
    }
    if (name === "lode_tools_read" || name === "lode_tools_call") {
      const selected = allTools.find((tool) => semanticToolName(tool.name) === semanticToolName(args.name));
      const descriptor = resolveOperation(args.name);
      if (
        !selected ||
        descriptor?.kind !== "operation" ||
        !args.arguments ||
        typeof args.arguments !== "object" ||
        Array.isArray(args.arguments) ||
        Object.keys(args).some((key) => !["name", "arguments", ...(name === "lode_tools_call" ? ["execution_mode"] : [])].includes(key))
      )
        throw new Error("An exact Lode tool name and arguments object are required; routing cannot be nested.");
      if (args.execution_mode != null && !["ordinary", "managed"].includes(args.execution_mode)) throw new Error("Unknown execution mode.");
      if (name === "lode_tools_call" && args.execution_mode === "managed") surface = "managed-maintenance";
      if (name === "lode_tools_read" && selected.annotations?.readOnlyHint !== true)
        throw new Error("The selected tool is not read-only; use its declared effectful route within existing authority.");
      name = semanticToolName(selected.name);
      args = args.arguments;
    }
    requireOperationSurface(publicToolName(name), surface);
    // A declared, required project_root is the contract: refuse its absence or a
    // wrong type after the surface, router and read-only checks and before any
    // handler reads it (otherwise a missing root meant the server's cwd). Other
    // argument rules stay with the operation's own, CLI-identical refusal.
    // Every catalog tool comes from the registry (allTools = registryCatalog()), so
    // the registry entry's schema is the declared one.
    const registered = registeredOperation(name);
    const declaredSchema = registered?.tool?.inputSchema;
    if (declaredSchema) assertProjectRootArgument(publicToolName(name), declaredSchema, args);
    if (!registered) throw new Error(`Unknown tool: ${publicToolName(name)}`);
    // Only a view the native bridge issued to a verified caller counts (4-D).
    const basisMemory =
      recoveryBasisMemory && (await import("./lib/session/session-native-host.mjs")).isBridgeIssuedRecoveryBasis(recoveryBasisMemory) ? recoveryBasisMemory : null;
    const heldBasis = basisMemory ? await heldRecoveryBasisCall(name, args, basisMemory) : null;
    let entryBasis = basisMemory ? await entryRecoveryBasisBefore(name, args) : null;
    if (heldBasis) args = heldBasis.args;
    if (basisMemory) args = heldDirectionCall(name, args, basisMemory);
    const capturesInitBasis = basisMemory && name === "lode_project_initialize_or_resume";
    const invoke = () =>
      callRegistered(registered, "mcp", args, {
        packageVersion,
        graphDbTransport,
        coordinationWorkspaceHost,
        observationRegistry,
        conformanceTriggerRegistry,
        compactionLifecycleHost,
        workerJobHost,
        workerJobSupervisor,
        workerPreparationBackend,
        nativeHistoryHost,
        signal,
        onProcess,
        onExportScope,
        onValidatedSessionSelection,
        readRelatedNativeContext,
        projectSessionRoute,
        projectLocationProjection,
        caller,
        hostEnvironment,
        pluginLaunch,
        servingModuleUrl,
        installationCaller,
      });
    let value;
    if (capturesInitBasis) {
      const { withEntryBasisCapture } = await import("./lib/session/entry-basis-capture.mjs");
      ({ value, basis: entryBasis } = await withEntryBasisCapture(invoke));
    } else {
      try {
        value = await invoke();
      } catch (error) {
        // A direction conflict drops the held direction id; the caller reads
        // the current direction again. Held recovery bases stay as they were.
        if (basisMemory && name === "lode_project_direction_update" && error?.code === "PROJECT_DIRECTION_CONFLICT")
          basisMemory.dropDirection(args.project_root);
        throw error;
      }
    }
    if (basisMemory) await rememberRecoveryBasis(name, args, value, basisMemory, heldBasis, entryBasis);
    // MCP structuredContent is an optional object, never null/array/scalar.
    // Keep absent originals as their original text value, not fabricated state.
    const response = success(id, {
      content: [{ type: "text", text: formatMcpToolContent(name, value) }],
      ...(value !== null && typeof value === "object" && !Array.isArray(value) ? { structuredContent: value } : {}),
    });
    const maxResponseBytes = registered?.mcp.maxResponseBytes;
    if (maxResponseBytes != null && Buffer.byteLength(JSON.stringify(response), "utf8") > maxResponseBytes) {
      throw new Error(`${publicToolName(name)} response exceeds ${maxResponseBytes} bytes.`);
    }
    return response;
  } catch (error) {
    return failure(id, error.message, error?.code);
  }
}

export function serveMcp({
  surface = "ordinary",
  coordinationWorkspaceHost = null,
  observationRegistry = null,
  conformanceTriggerRegistry = null,
  compactionLifecycleHost = null,
  workerJobHost = null,
  workerJobSupervisor = null,
  sessionContext = null,
  resolveSessionContext = null,
  nativeSessionBridge,
  pluginLaunch = null,
  onExportScope = null,
  nativeHistoryHost = null,
} = {}) {
  requireSurface(surface);
  if (nativeSessionBridge === undefined) nativeSessionBridge = createNativeSessionHostBridge({ pluginLaunch, servingModuleUrl: import.meta.url });
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const sourceRequests = new Map();
  const abortSources = () => {
    for (const controller of sourceRequests.values()) controller.abort();
  };
  let closing = false;
  const shutdown = () => {
    abortSources();
    input.close();
  };
  const cleanupSignals = () => {
    if (closing && !sourceRequests.size) {
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  input.once("close", () => {
    closing = true;
    abortSources();
    nativeSessionBridge?.dispose?.();
    cleanupSignals();
  });
  input.on("line", async (line) => {
    if (!line.trim()) return;
    let response;
    let sourceRequestId,
      ownsSourceRequest = false;
    try {
      const request = JSON.parse(line);
      if (request.method === "notifications/cancelled") {
        sourceRequests.get(request.params?.requestId)?.abort();
        return;
      }
      let controller;
      if (request.method === "tools/call" && requestedToolName(request) === "lode_source_context") {
        sourceRequestId = request.id;
        if (sourceRequests.has(sourceRequestId)) throw new Error("Duplicate active source request id.");
        controller = new AbortController();
        sourceRequests.set(sourceRequestId, controller);
        ownsSourceRequest = true;
      }
      response = await dispatch(request, {
        surface,
        coordinationWorkspaceHost,
        observationRegistry,
        conformanceTriggerRegistry,
        compactionLifecycleHost,
        workerJobHost,
        workerJobSupervisor,
        sessionContext,
        resolveSessionContext,
        nativeSessionBridge,
        nativeHistoryHost,
        signal: controller?.signal,
        onExportScope: onExportScope ?? ((notice) => fs.writeSync(process.stderr.fd, `${JSON.stringify({ projectExportScope: notice })}\n`)),
        onProcess: (event) => process.stderr.write(`${JSON.stringify({ sourceProcess: event })}\n`),
      });
    } catch (error) {
      response = failure(null, `Parse error: ${error.message}`);
    } finally {
      if (ownsSourceRequest) sourceRequests.delete(sourceRequestId);
      cleanupSignals();
    }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
  return input;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) serveMcp();
