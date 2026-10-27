import fs from "node:fs";
import path from "node:path";
import { resolveOperation } from "./lode-operation-contract.mjs";
const semanticToolName = name => resolveOperation(name)?.semanticName ?? name;
const helperName = name => semanticToolName(name) === "head_session_host_request_prepare";
const routerName = name => ["head_tools_read", "head_tools_call"].includes(semanticToolName(name));
const hasProjectMarker = root => [".head", ".lode"].some(directory => fs.existsSync(path.join(root, directory, "project.json")));
import { sessionCallRequiresBinding } from "./session-routing.mjs";
import { createSessionHostRequestRegistry, parseClaudeNativeToolName } from "./session-host-request.mjs";
import { subagentWriteGuardEnabled } from "./subagent-write-guard.mjs";

const validCaller = (id) => typeof id === "string" && id.length > 0 && id.length <= 512 && !/[\u0000-\u001f]/u.test(id);
const missingCaller = () => { throw Object.assign(new Error("Native caller metadata is unavailable; never substitute another caller."), { code: "NATIVE_SESSION_CALLER_UNAVAILABLE" }); };

// Thin Host transport composition. Nothing in tool arguments can supply a native
// caller, and this module authors neither P2 direction nor effect authorization.
export function createNativeSessionHostBridge({ environment = process.env, runtime = null, requestRegistry = createSessionHostRequestRegistry(), pluginLaunch = null, servingModuleUrl = null } = {}) {
  let transportRuntime = runtime, observedNativeMetadata = false, observedClaudeHook = false;
  const adapters = new Map();
  // Caller bit for a router call whose inner tool does not use the Session
  // registry. The registry shape stays unchanged. Entries are not P5 state.
  const subagentToolUses = [];
  function noteSubagentToolUse(id) {
    const now = Date.now();
    while (subagentToolUses.length && (subagentToolUses[0].at <= now - 600_000 || subagentToolUses.length >= 1024)) subagentToolUses.shift();
    if (!subagentToolUses.some(entry => entry.id === id)) subagentToolUses.push({ id, at: now });
  }
  function takeSubagentToolUse(id) {
    const index = subagentToolUses.findIndex(entry => entry.id === id && entry.at > Date.now() - 600_000);
    if (index < 0) return false;
    subagentToolUses.splice(index, 1);
    return true;
  }
  function visibleCaller(caller) {
    if (!caller) return null;
    if (caller.status === "signal-only") return { runtime: "claude", nativeSessionId: null, agentId: null, subagent: true };
    if (caller.status !== "known") return null;
    return { runtime: caller.runtime, nativeSessionId: caller.nativeSessionId, agentId: caller.agentId ?? null, subagent: caller.subagent === true,
      ...(caller.correlation ? { correlation: caller.correlation, outerToolName: caller.outerToolName } : {}) };
  }
  function callerFor(request) {
    if (transportRuntime === "claude") {
      const meta = request.params?._meta;
      const hasId = meta && typeof meta === "object" && Object.hasOwn(meta, "claudecode/toolUseId");
      if (hasId) observedNativeMetadata = true;
      if (!hasId && !observedClaudeHook && !observedNativeMetadata && runtime !== "claude") return { status: "legacy" };
      if (!hasId || !validCaller(meta["claudecode/toolUseId"])) return { status: "unavailable" };
      try {
        const claim = requestRegistry.claim({ key: meta["claudecode/toolUseId"], name: request.params.name, arguments: request.params.arguments });
        // agentId stays inside the stored registry caller. subagent is derived.
        return { status: "known", ...claim.caller, subagent: Boolean(claim.caller.agentId),
          correlation: "exact-native-tool-use", release: claim.release };
      } catch {
        if (takeSubagentToolUse(meta["claudecode/toolUseId"])) return { status: "signal-only", runtime: "claude", subagent: true };
        return { status: "unavailable" };
      }
    }
    if (transportRuntime !== "codex") return { status: "legacy" };
    const meta = request.params?._meta;
    if (meta && typeof meta === "object" && Object.hasOwn(meta, "threadId")) {
      if (!validCaller(meta.threadId)) return { status: "unavailable" };
      observedNativeMetadata = true;
      // Do not put a Codex agent id on the Session adapter key. Tool hooks
      // still expose the parent session, so only the write-guard bit changes.
      const hinted = [meta.agentId, meta.agent_id].find(validCaller) || null;
      return { status: "known", runtime: "codex", nativeSessionId: meta.threadId, subagent: Boolean(hinted) || meta.subagent === true };
    }
    // This remembers only the transport capability, NEVER the last caller.
    return { status: observedNativeMetadata ? "unavailable" : "legacy" };
  }
  async function adapterFor(caller) {
    const key = JSON.stringify([caller.runtime, caller.nativeSessionId, caller.agentId || null]);
    const { createSessionHostAdapter } = await import("./session-host-adapter.mjs");
    if (!adapters.has(key)) adapters.set(key, createSessionHostAdapter({ ...caller, environment }));
    return adapters.get(key);
  }
  const reply = (request, error = null) => ({ jsonrpc: "2.0", id: request.id ?? null, result: {
    content: [{ type: "text", text: error ? "Native Host request correlation unavailable (" + (error.code || "INVALID_HOST_REQUEST") + ")." : "{}" }],
    ...(error ? { isError: true } : {}),
  } });
  async function prepareHookRequest(request) {
    try {
      // Verified stock CLI provenance seam, not arbitrary-client authentication.
      // Ordinary model calls have this outer meta even when args contain a fake.
      if (transportRuntime !== "claude" || request.params?._meta && Object.hasOwn(request.params._meta, "claudecode/toolUseId")) throw Object.assign(new Error(), { code: "NATIVE_HOOK_INGRESS_REQUIRED" });
      observedClaudeHook = true;
      const value = request.params.arguments;
      const fields = ["native_session_id", "native_agent_id", "tool_use_id", "outer_tool_name", "original_arguments", "native_project_root"];
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))
        || ![value.native_session_id, value.tool_use_id, value.outer_tool_name].every(id => validCaller(id) && !id.includes("${"))
        || value.native_agent_id != null && value.native_agent_id !== "" && (!validCaller(value.native_agent_id) || value.native_agent_id.includes("${"))
        || typeof value.original_arguments !== "string") throw Object.assign(new Error(), { code: "INVALID_NATIVE_HOOK_INPUT" });
      const match = parseClaudeNativeToolName(value.outer_tool_name);
      if (!match) throw Object.assign(new Error(), { code: "INVALID_NATIVE_HOOK_TARGET" });
      const original = JSON.parse(value.original_arguments);
      if (!original || typeof original !== "object" || Array.isArray(original)) throw Object.assign(new Error(), { code: "INVALID_NATIVE_HOOK_ARGUMENTS" });
      const routed = routerName(match.name);
      const name = semanticToolName(routed ? original.name : match.name);
      if (helperName(name)) throw Object.assign(new Error(), { code: "NATIVE_HOOK_RECURSION" });
      const dependent = sessionCallRequiresBinding(name);
      let guardOnlyCorrelation = false;
      if (!dependent && value.native_agent_id && subagentWriteGuardEnabled(environment,
        { caller: { runtime: "claude", subagent: true, correlation: "exact-native-tool-use" } })) {
        // Catalog metadata only. A Project-only guarded write gets transient
        // exact correlation without Session/P2/inventory lookup or persistence.
        const { catalogTools } = await import("../mcp-server.mjs");
        const selected = catalogTools.find(tool => semanticToolName(tool.name) === name);
        guardOnlyCorrelation = Boolean(selected && selected.annotations?.readOnlyHint !== true);
      }
      // Independent reads/off-mode preserve the existing no-binding path.
      if (!dependent && !guardOnlyCorrelation) {
        // Remember only that this tool use came from a child. No registry,
        // Session, or P5 read, matching the independent-router no-op.
        if (value.native_agent_id) noteSubagentToolUse(value.tool_use_id);
        return reply(request);
      }
      requestRegistry.prepare({ key: value.tool_use_id, name: match.name, arguments: original,
        caller: { runtime: "claude", nativeSessionId: value.native_session_id, agentId: value.native_agent_id || null,
          outerToolName: value.outer_tool_name,
          nativeProjectRoot: typeof value.native_project_root === "string" && path.isAbsolute(value.native_project_root)
            && !value.native_project_root.includes("${") ? value.native_project_root : null } });
      return reply(request);
    } catch (error) { return reply(request, error); }
  }
  async function dispatchProjectRequest(request, handler, caller) {
      const outer = request.params?.arguments;
      const routed = routerName(request.params?.name);
      const args = routed ? outer?.arguments : outer;
      const name = semanticToolName(routed ? outer?.name : request.params?.name);
      const route = extra => ({ caller: visibleCaller(caller), hostEnvironment: environment,
        pluginLaunch, servingModuleUrl, installationCaller: caller, ...extra });
      if (helperName(name)) return reply(request, Object.assign(new Error(), { code: "NATIVE_HOOK_DIRECT_INGRESS_REQUIRED" }));
      if (typeof args?.project_root !== "string" || !args.project_root) return handler(request, route());
      if (name === "head_session_list") return handler(request, route());
      if (caller.status === "legacy") return handler(request, route());
      if (!sessionCallRequiresBinding(name) && !Object.hasOwn(args, "session_id")) return handler(request, route());
      if (caller.status !== "known") {
        // Creating a new Project has no existing Session to guess or lose.
        // Keep that original Core setup usable, but never claim native linkage.
        if (name === "head_project_initialize_or_resume" && !Object.hasOwn(args, "session_id")
          && !hasProjectMarker(args.project_root)) {
          const response = await handler(request, route());
          if (response?.result) response.result._meta = { ...response.result._meta,
            headSessionBinding: { status: "unavailable", reasonCode: "NATIVE_SESSION_CALLER_UNAVAILABLE",
              retained: false, persisted: false, recoveryAuthority: false, executionReplayAllowed: false } };
          return response;
        }
        return handler(request, route({ resolveSessionContext: missingCaller }));
      }
      let adapter;
      try { adapter = await adapterFor(caller); }
      catch (error) { return handler(request, route({ resolveSessionContext: () => { throw error; } })); }
      const initialized = hasProjectMarker(args.project_root);
      const selecting = name === "head_project_initialize_or_resume" && semanticToolName(request.params?.name) !== "head_tools_read"
        && (args.profile === undefined || ["core", "product"].includes(args.profile));
      let prepared = null, preparationFailure = null, selectionBasis = null, requestContext = null;
      const resolveSessionContext = (original) => {
        if (prepared) return prepared.context;
        if (!initialized) return null;
        if (requestContext) return requestContext;
        // A Claude /clear may replace its native ID without an authenticated
        // old→new continuity edge. An absent binding must not silently switch
        // a selected logical Session to the Project default. Explicit init/
        // resume can still select the default, and exact request routes work
        // independently. Never infer continuity from recency or other callers.
        requestContext = adapter.resolveSessionContext(original, { allowAbsentDefault: caller.runtime !== "claude" || selecting,
          onBindingRead: binding => { selectionBasis = { expectedRevision: binding.revision,
            expectedBindingDigest: binding.bindingDigest || null }; } });
        return requestContext;
      };
      const onValidatedSessionSelection = selecting ? ({ root, sessionId }) => {
        try { prepared = adapter.prepareSelection({ root, sessionId, ...selectionBasis }); }
        catch (error) { preparationFailure = error.code || "HOST_BINDING_STORAGE_ERROR"; }
      } : null;
      let response;
      const readRelatedNativeContext = name === "head_conversation_enter" ? ({ childSessionId }) => {
        // Internal trusted caller only; not a model-native-ID argument. Entry
        // invokes this synchronously before its final child basis recheck.
        return nativeRelatedReader?.({ root: args.project_root, caller, childSessionId, environment });
      } : null;
      let nativeRelatedReader = null;
      if (readRelatedNativeContext) {
        try { nativeRelatedReader = (await import("./native-session-observations.mjs")).readRelatedNativeWorkContext; }
        catch { /* Optional context cannot replace primary Core errors. */ }
      }
      try { response = await handler(request, route({ resolveSessionContext, onValidatedSessionSelection, readRelatedNativeContext })); }
      catch (error) {
        if (prepared) adapter.settleSelection({ ticket: prepared.ticket, outcome: "uncertain" });
        throw error;
      }
      if (!selecting) {
        // Only enrich a successful entry. Caller observations cannot soften a
        // primary recovery/selection failure or stand in for logical work state.
        const successfulEntry = name === "head_conversation_enter"
          && ["conversation_ready", "conversation_direction_restored"].includes(response?.result?.structuredContent?.status);
        if ((name === "head_project_status" || successfulEntry) && response?.result && !response.error && !response.result.isError) {
          try {
            const { projectNativeObservations, appendNativeStatus } = await import("./native-session-observations.mjs");
            const projection = await projectNativeObservations({ root: args.project_root, caller, environment });
            if (successfulEntry && !projection?.observations?.length) return response;
            return { ...response, result: appendNativeStatus(response.result, projection) };
          } catch { /* Preserve exactly the successful primary response. */ }
        }
        return response;
      }
      const value = response?.result?.structuredContent;
      const confirmed = !response?.result?.isError && !response?.error
        && ["initialized", "resumed"].includes(value?.projectAction) && validCaller(value?.project?.projectId)
        && typeof value?.project?.sessionId === "string";
      if (confirmed && !initialized) {
        try { prepared = adapter.prepareSelection({ root: args.project_root, sessionId: value.project.sessionId,
          expectedRevision: 0, expectedBindingDigest: null }); }
        catch (error) { preparationFailure = error.code || "HOST_BINDING_STORAGE_ERROR"; }
      }
      let settlement;
      if (prepared) settlement = adapter.settleSelection({ ticket: prepared.ticket,
        outcome: confirmed && prepared.sessionId === value.project.sessionId ? "succeeded" : "uncertain" });
      else if (preparationFailure) settlement = { status: "host_selection_not_retained", reasonCode: preparationFailure,
        retained: false, persisted: false, executionReplayAllowed: false };
      if (settlement && response?.result) response.result._meta = { ...response.result._meta,
        headSessionBinding: { ...settlement, binding: undefined, scope: "host-linkage-only", recoveryAuthority: false } };
      return response;
  }
  return Object.freeze({
    describe: () => ({ authorityPlane: "P5", runtime: transportRuntime, sharedCurrentSelector: false,
      recoveryAuthority: false, instructionAuthority: false }),
    async dispatch(request, handler) {
      if (request.method === "initialize") {
        if (runtime === null) transportRuntime = request.params?.clientInfo?.name === "codex-mcp-client" ? "codex"
          : request.params?.clientInfo?.name === "claude-code" ? "claude" : null;
        return handler(request, {});
      }
      if (request.method !== "tools/call") return handler(request, {});
      if (helperName(request.params?.name)) return prepareHookRequest(request);
      const routed = routerName(request.params?.name);
      const targetName = routed ? request.params?.arguments?.name : request.params?.name;
      if (helperName(targetName)) return reply(request, Object.assign(new Error(), { code: "NATIVE_HOOK_DIRECT_INGRESS_REQUIRED" }));
      const caller = callerFor(request);
      try {
        // Non-binding tools keep their previous result. The visible caller is
        // only a write-guard signal and does not select a Session.
        if (!sessionCallRequiresBinding(targetName)) return handler(request, { caller: visibleCaller(caller), hostEnvironment: environment });
        return await dispatchProjectRequest(request, handler, caller);
      } finally { caller.release?.(); }
    },
    requestStatus: () => requestRegistry.describe(),
    dispose() { requestRegistry.dispose(); adapters.clear(); subagentToolUses.length = 0; },
  });
}
