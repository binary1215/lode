import fs from "node:fs";
import path from "node:path";
import { resolveOperation } from "../core/lode-operation-contract.mjs";
const semanticToolName = (name) => resolveOperation(name)?.semanticName ?? name;
const helperName = (name) => semanticToolName(name) === "lode_session_host_request_prepare";
const routerName = (name) => ["lode_tools_read", "lode_tools_call"].includes(semanticToolName(name));
const hasProjectMarker = (root) => [".head", ".lode"].some((directory) => fs.existsSync(path.join(root, directory, "project.json")));
import { projectHasSingleSession, sessionCallRequiresBinding } from "./session-routing.mjs";
import { resolveProjectStorage } from "../storage/project-storage-format.mjs";
// A marker recorded for another root (a moved Project) is not a Project here.
// Selection errors other than that keep the existing route and its answer.
const markerOwnedElsewhere = (root) => {
  try {
    return !resolveProjectStorage(root);
  } catch (error) {
    if (error.code === "PROJECT_ROOT_SPELLING_RETRY") throw error;
    return false;
  }
};
import { createSessionHostRequestRegistry, parseClaudeNativeToolName } from "./session-host-request.mjs";
import { subagentWriteGuardEnabled } from "./subagent-write-guard.mjs";
import { effectiveToolCall } from "../core/operation-groups.mjs";
import { createRecoveryBasisMemory } from "./recovery-basis-memory.mjs";
import { recordedRootSpelling, withRecordedProjectRoot, withRequestSpellingRetry } from "../storage/project-root-spelling.mjs";

// Held recovery basis views the bridge itself issued to a verified caller. The
// dispatcher honours only these, so no embedder option can supply one.
const issuedRecoveryBasisViews = new WeakSet();
export const isBridgeIssuedRecoveryBasis = (view) => issuedRecoveryBasisViews.has(view);

const validCaller = (id) => typeof id === "string" && id.length > 0 && id.length <= 512 && !/[\u0000-\u001f]/u.test(id);
const missingCaller = () => {
  throw Object.assign(new Error("Native caller metadata is unavailable; never substitute another caller."), { code: "NATIVE_SESSION_CALLER_UNAVAILABLE" });
};

// Thin Host transport composition. Nothing in tool arguments can supply a native
// caller, and this module authors neither P2 direction nor effect authorization.
// The Host's `${cwd}` from the hook template, in the recorded spelling when it
// differs from the recorded Project root only in drive-letter case.
const nativeProjectRoot = (value) => (typeof value === "string" && path.isAbsolute(value) && !value.includes("${") ? recordedRootSpelling(value) : null);

export function createNativeSessionHostBridge({
  environment = process.env,
  runtime = null,
  requestRegistry = createSessionHostRequestRegistry(),
  pluginLaunch = null,
  servingModuleUrl = null,
  recoveryBasisMemory = createRecoveryBasisMemory(),
} = {}) {
  let transportRuntime = runtime,
    observedNativeMetadata = false,
    observedClaudeHook = false;
  const adapters = new Map();
  // Caller bit for a router call whose inner tool does not use the Session
  // registry. The registry shape stays unchanged. Entries are not P5 state.
  const subagentToolUses = [];
  function noteSubagentToolUse(id) {
    const now = Date.now();
    while (subagentToolUses.length && (subagentToolUses[0].at <= now - 600_000 || subagentToolUses.length >= 1024)) subagentToolUses.shift();
    if (!subagentToolUses.some((entry) => entry.id === id)) subagentToolUses.push({ id, at: now });
  }
  function takeSubagentToolUse(id) {
    const index = subagentToolUses.findIndex((entry) => entry.id === id && entry.at > Date.now() - 600_000);
    if (index < 0) return false;
    subagentToolUses.splice(index, 1);
    return true;
  }
  function visibleCaller(caller) {
    if (!caller) return null;
    if (caller.status === "signal-only") return { runtime: "claude", nativeSessionId: null, agentId: null, subagent: true };
    if (caller.status !== "known") return null;
    return {
      runtime: caller.runtime,
      nativeSessionId: caller.nativeSessionId,
      agentId: caller.agentId ?? null,
      subagent: caller.subagent === true,
      ...(caller.messagingAgentId ? { messagingAgentId: caller.messagingAgentId } : {}),
      ...(caller.rootSessionId ? { rootSessionId: caller.rootSessionId } : {}),
      ...(caller.correlation ? { correlation: caller.correlation, outerToolName: caller.outerToolName } : {}),
    };
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
        return { status: "known", ...claim.caller, subagent: Boolean(claim.caller.agentId), correlation: "exact-native-tool-use", release: claim.release };
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
      const rootSessionId = validCaller(meta.sessionId) && meta.sessionId !== meta.threadId ? meta.sessionId : null;
      const subagent = Boolean(hinted) || meta.subagent === true || Boolean(rootSessionId);
      // agentId stays off the Session adapter key. messagingAgentId is only a
      // conversation address, so a child cannot register or send as its parent.
      // correlation is the write-guard bit for this detected child, not a Session key.
      return {
        status: "known",
        runtime: "codex",
        nativeSessionId: meta.threadId,
        subagent,
        ...(subagent ? { correlation: "codex-subconversation" } : {}),
        ...(hinted ? { messagingAgentId: hinted } : {}),
        ...(rootSessionId ? { rootSessionId } : {}),
      };
    }
    // This remembers only the transport capability, NEVER the last caller.
    return { status: observedNativeMetadata ? "unavailable" : "legacy" };
  }
  function issueRecoveryBasisView(key) {
    const view = recoveryBasisMemory.forCaller(key);
    issuedRecoveryBasisViews.add(view);
    return view;
  }
  const callerKey = (caller) => JSON.stringify([caller.runtime, caller.nativeSessionId, caller.agentId || null]);
  async function adapterFor(caller) {
    const key = callerKey(caller);
    const { createSessionHostAdapter } = await import("./session-host-adapter.mjs");
    if (!adapters.has(key)) adapters.set(key, createSessionHostAdapter({ ...caller, environment }));
    return adapters.get(key);
  }
  const reply = (request, error = null) => ({
    jsonrpc: "2.0",
    id: request.id ?? null,
    result: {
      content: [{ type: "text", text: error ? "Native Host request correlation unavailable (" + (error.code || "INVALID_HOST_REQUEST") + ")." : "{}" }],
      ...(error ? { isError: true } : {}),
    },
  });
  async function prepareHookRequest(request) {
    try {
      // Verified stock CLI provenance seam, not arbitrary-client authentication.
      // Ordinary model calls have this outer meta even when args contain a fake.
      if (transportRuntime !== "claude" || (request.params?._meta && Object.hasOwn(request.params._meta, "claudecode/toolUseId")))
        throw Object.assign(new Error(), { code: "NATIVE_HOOK_INGRESS_REQUIRED" });
      observedClaudeHook = true;
      const value = request.params.arguments;
      const fields = ["native_session_id", "native_agent_id", "tool_use_id", "outer_tool_name", "original_arguments", "native_project_root"];
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !fields.includes(key)) ||
        ![value.native_session_id, value.tool_use_id, value.outer_tool_name].every((id) => validCaller(id) && !id.includes("${")) ||
        (value.native_agent_id != null && value.native_agent_id !== "" && (!validCaller(value.native_agent_id) || value.native_agent_id.includes("${"))) ||
        typeof value.original_arguments !== "string"
      )
        throw Object.assign(new Error(), { code: "INVALID_NATIVE_HOOK_INPUT" });
      const match = parseClaudeNativeToolName(value.outer_tool_name);
      if (!match) throw Object.assign(new Error(), { code: "INVALID_NATIVE_HOOK_TARGET" });
      const original = JSON.parse(value.original_arguments);
      if (!original || typeof original !== "object" || Array.isArray(original)) throw Object.assign(new Error(), { code: "INVALID_NATIVE_HOOK_ARGUMENTS" });
      const routed = routerName(match.name);
      // A grouped tool is classified as the member operation its action selects.
      const name = semanticToolName(routed ? effectiveToolCall(original.name, original.arguments).name : effectiveToolCall(match.name, original).name);
      if (helperName(name)) throw Object.assign(new Error(), { code: "NATIVE_HOOK_RECURSION" });
      if (name === "lode_conversation_list" || name === "lode_conversation_send") {
        requestRegistry.prepare({
          key: value.tool_use_id,
          name: match.name,
          arguments: original,
          caller: {
            runtime: "claude",
            nativeSessionId: value.native_session_id,
            agentId: value.native_agent_id || null,
            outerToolName: value.outer_tool_name,
            nativeProjectRoot: nativeProjectRoot(value.native_project_root),
          },
        });
        return reply(request);
      }
      if (name === "lode_project_direction_update") {
        // 4-D (c), best-effort: correlate this caller so the update can use and
        // re-arm what is held for it. A failure leaves the call exactly as
        // before: unverified, or refused for a guarded child as before.
        try {
          requestRegistry.prepare({
            key: value.tool_use_id,
            name: match.name,
            arguments: original,
            caller: {
              runtime: "claude",
              nativeSessionId: value.native_session_id,
              agentId: value.native_agent_id || null,
              outerToolName: value.outer_tool_name,
              nativeProjectRoot: nativeProjectRoot(value.native_project_root),
            },
          });
        } catch (error) {
          const guarded =
            value.native_agent_id &&
            subagentWriteGuardEnabled(environment, { caller: { runtime: "claude", subagent: true, correlation: "exact-native-tool-use" } });
          if (guarded) throw error;
          if (value.native_agent_id) noteSubagentToolUse(value.tool_use_id);
        }
        return reply(request);
      }
      const dependent = sessionCallRequiresBinding(name);
      let guardOnlyCorrelation = false;
      if (
        !dependent &&
        value.native_agent_id &&
        subagentWriteGuardEnabled(environment, { caller: { runtime: "claude", subagent: true, correlation: "exact-native-tool-use" } })
      ) {
        // Catalog metadata only. A Project-only guarded write gets transient
        // exact correlation without Session/P2/inventory lookup or persistence.
        const { operationCatalogTools } = await import("../../mcp-server.mjs");
        const selected = operationCatalogTools.find((tool) => semanticToolName(tool.name) === name);
        guardOnlyCorrelation = Boolean(selected && selected.annotations?.readOnlyHint !== true);
      }
      // Independent reads/off-mode preserve the existing no-binding path.
      if (!dependent && !guardOnlyCorrelation) {
        // Remember only that this tool use came from a child. No registry,
        // Session, or P5 read, matching the independent-router no-op.
        if (value.native_agent_id) noteSubagentToolUse(value.tool_use_id);
        return reply(request);
      }
      requestRegistry.prepare({
        key: value.tool_use_id,
        name: match.name,
        arguments: original,
        caller: {
          runtime: "claude",
          nativeSessionId: value.native_session_id,
          agentId: value.native_agent_id || null,
          outerToolName: value.outer_tool_name,
          nativeProjectRoot: nativeProjectRoot(value.native_project_root),
        },
      });
      return reply(request);
    } catch (error) {
      return reply(request, error);
    }
  }
  async function dispatchProjectRequest(request, handler, caller) {
    const outer = request.params?.arguments;
    const routed = routerName(request.params?.name);
    const effective = effectiveToolCall(routed ? outer?.name : request.params?.name, routed ? outer?.arguments : outer);
    const args = effective.arguments;
    const name = semanticToolName(effective.name);
    const route = (extra) => ({
      caller: visibleCaller(caller),
      hostEnvironment: environment,
      pluginLaunch,
      servingModuleUrl,
      installationCaller: caller,
      ...extra,
    });
    if (helperName(name)) return reply(request, Object.assign(new Error(), { code: "NATIVE_HOOK_DIRECT_INGRESS_REQUIRED" }));
    if (typeof args?.project_root !== "string" || !args.project_root) return handler(request, route());
    if (name === "lode_session_list") return handler(request, route());
    if (caller.status === "legacy") return handler(request, route());
    if (!sessionCallRequiresBinding(name) && !Object.hasOwn(args, "session_id")) return handler(request, route());
    if (caller.status !== "known") {
      // Creating a new Project has no existing Session to guess or lose.
      // Keep that original Core setup usable, but never claim native linkage.
      if (name === "lode_project_initialize_or_resume" && !Object.hasOwn(args, "session_id") && !hasProjectMarker(args.project_root)) {
        const response = await handler(request, route());
        if (response?.result)
          response.result._meta = {
            ...response.result._meta,
            headSessionBinding: {
              status: "unavailable",
              reasonCode: "NATIVE_SESSION_CALLER_UNAVAILABLE",
              retained: false,
              persisted: false,
              recoveryAuthority: false,
              executionReplayAllowed: false,
            },
          };
        return response;
      }
      // A Claude Code call the PreToolUse hook did not prepare, in a Project
      // whose only Session is its default: this request uses that Session, as
      // an unverified MCP caller does. Nothing is bound or claimed.
      if (
        transportRuntime === "claude" &&
        !Object.hasOwn(args, "session_id") &&
        hasProjectMarker(args.project_root) &&
        projectHasSingleSession(args.project_root)
      ) {
        const response = await handler(request, route());
        if (response?.result)
          response.result._meta = {
            ...response.result._meta,
            headSessionBinding: {
              status: "unavailable",
              reasonCode: "NATIVE_SESSION_CALLER_UNAVAILABLE",
              sessionSelection: "single-project-session",
              retained: false,
              persisted: false,
              recoveryAuthority: false,
              executionReplayAllowed: false,
            },
          };
        return response;
      }
      // A moved Project has no Session here to claim: status and entry read it
      // without one, as an unverified caller does, and name the explicit resume.
      if (name !== "lode_project_initialize_or_resume" && hasProjectMarker(args.project_root) && markerOwnedElsewhere(args.project_root))
        return handler(request, route());
      return handler(request, route({ resolveSessionContext: missingCaller }));
    }
    let adapter;
    try {
      adapter = await adapterFor(caller);
    } catch (error) {
      return handler(
        request,
        route({
          resolveSessionContext: () => {
            throw error;
          },
        }),
      );
    }
    const initialized = hasProjectMarker(args.project_root);
    const selecting =
      name === "lode_project_initialize_or_resume" &&
      semanticToolName(request.params?.name) !== "lode_tools_read" &&
      (args.profile === undefined || ["core", "product"].includes(args.profile));
    // Status and entry for a moved Project read it without a Session, as an
    // unverified caller does, so they can name the explicit resume. Resume
    // itself keeps its own selection path.
    const relocated = initialized && !selecting && markerOwnedElsewhere(args.project_root);
    let prepared = null,
      preparationFailure = null,
      selectionBasis = null,
      requestContext = null;
    const resolveSessionContext = (original) => {
      if (prepared) return prepared.context;
      if (!initialized || relocated) return null;
      if (requestContext) return requestContext;
      // A Claude /clear may replace its native ID without an authenticated
      // old→new continuity edge. An absent binding must not silently switch
      // a selected logical Session to the Project default. Explicit init/
      // resume can still select the default, and exact request routes work
      // independently. Never infer continuity from recency or other callers.
      requestContext = adapter.resolveSessionContext(original, {
        // ...unless the Project has only that one Session: there is no other
        // Session to switch away from, so the request uses it (no binding).
        allowAbsentDefault: caller.runtime !== "claude" || selecting || (() => projectHasSingleSession(args.project_root)),
        onBindingRead: (binding) => {
          selectionBasis = { expectedRevision: binding.revision, expectedBindingDigest: binding.bindingDigest || null };
        },
      });
      return requestContext;
    };
    const onValidatedSessionSelection = selecting
      ? ({ root, sessionId }) => {
          try {
            prepared = adapter.prepareSelection({ root, sessionId, ...selectionBasis });
          } catch (error) {
            preparationFailure = error.code || "HOST_BINDING_STORAGE_ERROR";
          }
        }
      : null;
    let response;
    const readRelatedNativeContext =
      name === "lode_conversation_enter"
        ? ({ childSessionId }) => {
            // Internal trusted caller only; not a model-native-ID argument. Entry
            // invokes this synchronously before its final child basis recheck.
            return nativeRelatedReader?.({ root: args.project_root, caller, childSessionId, environment });
          }
        : null;
    let nativeRelatedReader = null;
    if (readRelatedNativeContext) {
      try {
        nativeRelatedReader = (await import("./native-session-observations.mjs")).readRelatedNativeWorkContext;
      } catch {
        /* Optional context cannot replace primary Core errors. */
      }
    }
    // Only a verified caller gets held recovery basis ids (4-D); everyone else
    // keeps the explicit argument contract unchanged. The view is valid for this
    // one request and revoked after it, so it cannot be reused elsewhere.
    const basisView = issueRecoveryBasisView(callerKey(caller));
    try {
      response = await handler(
        request,
        route({
          resolveSessionContext,
          onValidatedSessionSelection,
          readRelatedNativeContext,
          recoveryBasisMemory: basisView,
        }),
      );
    } catch (error) {
      if (prepared) adapter.settleSelection({ ticket: prepared.ticket, outcome: "uncertain" });
      throw error;
    } finally {
      issuedRecoveryBasisViews.delete(basisView);
    }
    if (!selecting) {
      // Only enrich a successful entry. Caller observations cannot soften a
      // primary recovery/selection failure or stand in for logical work state.
      const successfulEntry =
        name === "lode_conversation_enter" && ["conversation_ready", "conversation_direction_restored"].includes(response?.result?.structuredContent?.status);
      if ((name === "lode_project_status" || successfulEntry) && response?.result && !response.error && !response.result.isError) {
        try {
          const { projectNativeObservations, appendNativeStatus } = await import("./native-session-observations.mjs");
          const projection = await projectNativeObservations({ root: args.project_root, caller, environment });
          if (successfulEntry && !projection?.observations?.length) return response;
          return { ...response, result: appendNativeStatus(response.result, projection) };
        } catch {
          /* Preserve exactly the successful primary response. */
        }
      }
      return response;
    }
    const value = response?.result?.structuredContent;
    const confirmed =
      !response?.result?.isError &&
      !response?.error &&
      ["initialized", "resumed"].includes(value?.projectAction) &&
      validCaller(value?.project?.projectId) &&
      typeof value?.project?.sessionId === "string";
    if (confirmed && !initialized) {
      try {
        prepared = adapter.prepareSelection({ root: args.project_root, sessionId: value.project.sessionId, expectedRevision: 0, expectedBindingDigest: null });
      } catch (error) {
        preparationFailure = error.code || "HOST_BINDING_STORAGE_ERROR";
      }
    }
    let settlement;
    if (prepared)
      settlement = adapter.settleSelection({
        ticket: prepared.ticket,
        outcome: confirmed && prepared.sessionId === value.project.sessionId ? "succeeded" : "uncertain",
      });
    else if (preparationFailure)
      settlement = { status: "host_selection_not_retained", reasonCode: preparationFailure, retained: false, persisted: false, executionReplayAllowed: false };
    if (settlement && response?.result)
      response.result._meta = {
        ...response.result._meta,
        headSessionBinding: { ...settlement, binding: undefined, scope: "host-linkage-only", recoveryAuthority: false },
      };
    return response;
  }
  return Object.freeze({
    describe: () => ({ authorityPlane: "P5", runtime: transportRuntime, sharedCurrentSelector: false, recoveryAuthority: false, instructionAuthority: false }),
    async dispatch(request, handler) {
      if (request.method === "initialize") {
        if (runtime === null)
          transportRuntime =
            request.params?.clientInfo?.name === "codex-mcp-client" ? "codex" : request.params?.clientInfo?.name === "claude-code" ? "claude" : null;
        return handler(request, {});
      }
      if (request.method !== "tools/call") return handler(request, {});
      if (helperName(request.params?.name)) return await prepareHookRequest(request);
      const routed = routerName(request.params?.name);
      const outer = request.params?.arguments;
      const targetName = effectiveToolCall(routed ? outer?.name : request.params?.name, routed ? outer?.arguments : outer).name;
      if (helperName(targetName)) return reply(request, Object.assign(new Error(), { code: "NATIVE_HOOK_DIRECT_INGRESS_REQUIRED" }));
      const caller = callerFor(request);
      // After the caller is matched against its exact hook preparation, a root
      // that differs from the recorded one only in drive-letter case uses the
      // recorded spelling, so Host keys and Session routing see one Project.
      request = withRecordedProjectRoot(request);
      const routeKnownRequest = async (request) => {
        // Non-binding tools keep their previous result. The visible caller is
        // only a write-guard signal and does not select a Session.
        if (semanticToolName(targetName) === "lode_project_direction_update" && caller.status === "known") {
          // 4-D (c): a verified caller's direction update may use the direction
          // id held for it and re-arms its held recovery bases. Session routing
          // is unchanged; the view is valid for this request only.
          const basisView = issueRecoveryBasisView(callerKey(caller));
          try {
            return await handler(request, { caller: visibleCaller(caller), hostEnvironment: environment, recoveryBasisMemory: basisView });
          } finally {
            issuedRecoveryBasisViews.delete(basisView);
          }
        }
        if (!sessionCallRequiresBinding(targetName)) return handler(request, { caller: visibleCaller(caller), hostEnvironment: environment });
        return await dispatchProjectRequest(request, handler, caller);
      };
      try {
        // A directory-name case miss is retried once with the recorded spelling
        // for this already matched caller (the hook preparation is not reused).
        return await withRequestSpellingRetry(request, routeKnownRequest);
      } finally {
        caller.release?.();
      }
    },
    requestStatus: () => requestRegistry.describe(),
    recoveryBasisStatus: () => recoveryBasisMemory.describe(),
    dispose() {
      requestRegistry.dispose();
      recoveryBasisMemory.clear();
      adapters.clear();
      subagentToolUses.length = 0;
    },
  });
}
