#!/usr/bin/env node
import readline from "node:readline";
import { resolveOperation } from "./lib/lode-operation-contract.mjs";
import { callRegistered, registeredOperation, registryCatalog, WORLD_MODEL_STATUS_MCP_MAX_BYTES } from "./lib/operation-registry.mjs";
import { assertProjectRootArgument } from "./lib/mcp-argument-validation.mjs";
import { ARTIFACT_COMPOSITION, publicToolName } from "./lib/lode-artifact-composition.mjs";
import { DISCOVERY_PREFIX_PAIRS } from "../compat/head/public-names.mjs";
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
import { isManagedMutation, requireOperationSurface, requireSurface } from "./lib/managed-maintenance-surface.mjs";
import { coreEntryGuidance } from "./lib/lode-entry-guidance.mjs";
import { formatMcpToolContent } from "./lib/cli-presentation.mjs";
import { sessionCallRequiresBinding } from "./lib/session-routing.mjs";
import { createNativeSessionHostBridge } from "./lib/session-native-host.mjs";
import { SESSION_HOST_REQUEST_HELPER } from "./lib/session-host-request.mjs";
import { assessSubagentStateWrite, subagentWriteGuardEnabled } from "./lib/subagent-write-guard.mjs";
import fs from "node:fs";

const protocolVersion = "2024-11-05";
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageVersion = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8")).version;
const allTools = [...registryCatalog()];

// Stateless discovery, not a registration store or permission/activation system.
allTools.push({
  name: SESSION_HOST_REQUEST_HELPER,
  description:
    "Internal native Host Hook ingress for one transient request correlation. No logical Session selection, original write, permission or recovery authority. Ordinary model calls cannot mint native claims; users never fill this input.",
  inputSchema: {
    type: "object",
    properties: {
      native_session_id: { type: "string", minLength: 1, maxLength: 512 },
      native_agent_id: { type: ["string", "null"], maxLength: 512 },
      native_project_root: { type: "string", description: "Optional trusted Hook cwd; model input is not proof of plugin loading or Project scope." },
      tool_use_id: { type: "string", minLength: 1, maxLength: 512 },
      outer_tool_name: { type: "string", minLength: 1, maxLength: 512 },
      original_arguments: { type: "string", minLength: 2 },
    },
    required: ["native_session_id", "tool_use_id", "outer_tool_name", "original_arguments"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});
const defaultToolNames = new Set([
  SESSION_HOST_REQUEST_HELPER,
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
      "Call a discovered Lode operation using its exact inputSchema within existing user scope. Original authority, current-basis, ownership, replay and maintenance checks still apply. Discovery grants no authorization. Prefer head_tools_read for read-only operations.",
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
export const catalogTools = allTools.map(presentedTool);
export function toolsForSurface(surface = "ordinary") {
  requireSurface(surface);
  return [...allTools.filter((tool) => (surface === "managed-maintenance" ? true : defaultToolNames.has(tool.name))), ...discoveryTools].map(presentedTool);
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
  const available = allTools.map(presentedTool);
  if (name != null) name = publicToolName(name);
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
  if (name == null && prefix == null) {
    const counts = new Map();
    for (const tool of available) {
      const key = `${ARTIFACT_COMPOSITION.toolPrefix}${tool.name.split("_")[1]}_`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return { ...scope, prefixes: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([prefix, count]) => ({ prefix, count })), nextOffset: null };
  }
  const matches = available.filter((tool) => {
    if (name != null) return tool.name === name;
    const descriptor = resolveOperation(tool.name);
    return tool.name.startsWith(prefix) || descriptor?.legacyName.startsWith(prefix) || descriptor?.canonicalName.startsWith(prefix);
  });
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
    })),
  };
}

function requestedToolName(request) {
  return ["lode_tools_read", "lode_tools_call"].includes(semanticToolName(request.params?.name))
    ? semanticToolName(request.params?.arguments?.name)
    : semanticToolName(request.params?.name);
}

// Use the shared policy after router unwrap. OpenCode applies it to the exact
// Host before-hook; MCP uses its own caller and optional Codex observations.
// Disabled mode does not read observations.
async function subagentStateWriteRejection(name, args, caller, environment) {
  const selected = allTools.find((tool) => semanticToolName(tool.name) === name);
  if (!selected || selected.annotations?.readOnlyHint === true) return null;
  if (!subagentWriteGuardEnabled(environment, { caller })) return null;
  // A cold catalog or disabled guard must not load optional Codex observations.
  let current = caller && typeof caller === "object" ? { ...caller } : null;
  if (current?.runtime === "codex" && current.subagent !== true && typeof args?.project_root === "string" && typeof current.nativeSessionId === "string") {
    const { recordedSubagentCaller } = await import("./lib/subagent-caller-signal.mjs");
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
  error: { code: -32000, message, ...(typeof reasonCode === "string" && reasonCode ? { data: { reasonCode } } : {}) },
});
export { WORLD_MODEL_STATUS_MCP_MAX_BYTES };

async function unresolvedSessionResponse(id, name, root, reasonCode) {
  try {
    const routing = await import("./lib/session-routing.mjs");
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
    return options.nativeSessionBridge.dispatch(request, async (original, routing) => await dispatchSessionRequest(original, { ...options, ...routing }));
  }
  return await dispatchSessionRequest(request, options);
}

async function dispatchSessionRequest(request, options = {}) {
  const outer = request.params?.arguments;
  const routed = ["lode_tools_read", "lode_tools_call"].includes(semanticToolName(request.params?.name));
  const args = routed ? outer?.arguments : outer;
  const hasSelection = args && Object.hasOwn(args, "session_id");
  const requestedName = semanticToolName(routed ? outer?.name : request.params?.name);
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
      const { inspectProjectLocationExperience } = await import("./lib/project-bootstrap.mjs");
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
                  bindingFailure = error.code || "HEAD_SESSION_CONTEXT_UNAVAILABLE";
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
        bindingFailure = error.code || "HEAD_SESSION_CONTEXT_UNAVAILABLE";
      } else {
        return await unresolvedSessionResponse(request.id ?? null, requestedName, args.project_root, error.code || "HEAD_SESSION_CONTEXT_UNAVAILABLE");
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
      const { withSessionCallContext } = await import("./lib/session-routing.mjs");
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
            scope: "current-explicit-request-only",
            retainedForSubsequentCalls: false,
            persisted: false,
          },
        };
      return response;
    } catch (error) {
      if (error.code === "HEAD_SESSION_SELECTION_LOST") {
        return await unresolvedSessionResponse(request.id ?? null, requestedName, args.project_root, error.code);
      }
      return failure(request.id ?? null, error.message, error?.code);
    }
  }
  return await dispatchRouted(request, options);
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
        throw new Error("An exact HEAD tool name and arguments object are required; routing cannot be nested.");
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
    // The registry entry's schema; the one unregistered catalog tool (the host
    // request helper) is still checked against its catalog schema.
    const declaredSchema = (registeredOperation(name)?.tool ?? allTools.find((tool) => semanticToolName(tool.name) === name))?.inputSchema;
    if (declaredSchema) assertProjectRootArgument(publicToolName(name), declaredSchema, args);
    const registered = registeredOperation(name);
    if (!registered) throw new Error(`Unknown tool: ${publicToolName(name)}`);
    const value = await callRegistered(registered, "mcp", args, {
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
